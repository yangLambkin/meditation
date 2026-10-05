// 小程序记录入账与必经同步分别确认。本模块只同步已获云端确认的历史日期，
// 不修改静坐记录，也不依赖某个页面的生命周期。
const STORAGE_PREFIX = 'bijing_record_sync_';
const REQUEST_TIMEOUT_MS = 45000;
const accounts = new Map();
const inFlight = new Map();
const listeners = new Set();
const STATUSES = new Set(['pending', 'syncing', 'synced', 'failed', 'unbound', 'deferred']);

function currentAccount() {
  try {
    const value = wx.getStorageSync('userOpenId');
    return typeof value === 'string' ? value : '';
  } catch (_) { return ''; }
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function validRecordId(id) {
  return typeof id === 'string' && id.length <= 200 && Boolean(id.trim()) && id === id.trim();
}

function copy(task) {
  return task ? { ...task, recordIds: [...task.recordIds] } : null;
}

function messageFor(status) {
  return {
    pending: '记录已保存，等待同步必经',
    syncing: '记录已保存，正在同步必经',
    synced: '当天记录已同步到必经',
    failed: '记录已保存，必经同步未完成，请重试',
    unbound: '记录已保存，绑定必经账号后可重试同步',
    deferred: '记录已保存，该日结束后可同步必经'
  }[status];
}

function setStatus(task, status, message) {
  task.status = status;
  task.message = message || messageFor(status);
  task.canRetry = ['pending', 'failed', 'unbound', 'deferred'].includes(status);
}

function tasksFor(account) {
  if (accounts.has(account)) return accounts.get(account);
  const tasks = Object.create(null);
  let stored;
  try { stored = wx.getStorageSync(STORAGE_PREFIX + account); } catch (_) {}
  if (stored && stored.version === 1 && stored.tasks && typeof stored.tasks === 'object' && !Array.isArray(stored.tasks)) {
    Object.keys(stored.tasks).forEach(date => {
      const task = stored.tasks[date];
      if (!validDate(date) || !task || task.date !== date || !validRecordId(task.recordId) ||
          (!STATUSES.has(task.status) && task.status !== 'queued')) return;
      const recordIds = [...new Set([...(Array.isArray(task.recordIds) ? task.recordIds : []), task.recordId].filter(validRecordId))];
      const revision = Number.isSafeInteger(task.revision) && task.revision >= recordIds.length ? task.revision : recordIds.length;
      const completedRevision = Number.isSafeInteger(task.completedRevision) && task.completedRevision >= 0
        ? Math.min(task.completedRevision, revision) : 0;
      const restored = { date, recordId: task.recordId, revision, completedRevision, recordIds };
      // 进程内任务由 inFlight 维护；磁盘上的 syncing 表示上次运行被中断。
      const status = task.status === 'syncing' || task.status === 'queued' ? 'pending' : task.status;
      setStatus(restored, status, status === task.status && typeof task.message === 'string' ? task.message : '');
      tasks[date] = restored;
    });
  }
  accounts.set(account, tasks);
  return tasks;
}

function persist(account) {
  try {
    wx.setStorageSync(STORAGE_PREFIX + account, { version: 1, tasks: tasksFor(account) });
  } catch (_) {
    // 静坐已在云端入账；磁盘写入失败只能影响重启恢复，不能撤销入账或阻止本次同步。
  }
}

function notify(account, date) {
  if (account !== currentAccount()) return;
  listeners.forEach(listener => {
    try { listener({ account, date }); } catch (_) {}
  });
}

function save(account, date) {
  persist(account);
  notify(account, date);
}

function getTasks(account = currentAccount()) {
  if (typeof account !== 'string' || !account) return [];
  return Object.values(tasksFor(account)).sort((a, b) => b.date.localeCompare(a.date)).map(copy);
}

function getDayState(date, account = currentAccount()) {
  if (!validDate(date) || typeof account !== 'string' || !account) return null;
  return copy(tasksFor(account)[date]);
}

function failure(error) {
  const detail = typeof error === 'string' ? error : error && (error.message || error.errMsg || error.error);
  return { status: 'failed', message: detail ? `记录已保存，必经同步未完成：${detail}` : messageFor('failed') };
}

function requestSync(account, date, recordId) {
  return new Promise(resolve => {
    let settled = false, timer;
    const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish(failure('同步超时，请重试同步，无需重新录入')), REQUEST_TIMEOUT_MS);
    try {
      if (currentAccount() !== account) {
        finish({ status: 'pending' });
        return;
      }
      wx.cloud.callFunction({
        name: 'bijingSync',
        data: { type: 'syncRecordedDate', recordId, expectedOpenid: account },
        success(response) {
          try {
            if (Date.now() >= deadlineAt) {
              finish(failure('同步超时，请重试同步，无需重新录入'));
              return;
            }
            const result = response && response.result, data = result && result.data;
            if (!result || result.success !== true || !data || typeof data !== 'object' ||
                (data.date !== undefined && data.date !== date)) {
              finish(failure(result && result.error || '未收到有效同步确认，请重试'));
            } else if (data.skipped === true && data.reason === '未绑定') {
              finish({ status: 'unbound' });
            } else if (data.skipped === true && data.deferred === true) {
              finish({ status: 'deferred', message: data.reason ? `记录已保存，${data.reason}` : '' });
            } else if (data.success === true && data.date === date && typeof data.duration === 'number' &&
                Number.isFinite(data.duration) && data.duration >= 0) {
              finish({ status: 'synced' });
            } else finish(failure('未收到有效同步确认，请重试'));
          } catch (error) { finish(failure(error)); }
        },
        fail(error) { finish(failure(error)); }
      });
    } catch (error) { finish(failure(error)); }
  });
}

function runTask(account, date) {
  const key = `${account}:${date}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const task = tasksFor(account)[date];
  if (!task || currentAccount() !== account || task.status !== 'pending') return Promise.resolve(copy(task));
  // 先登记 Promise，再执行网络请求；同步回调和订阅者重入也复用同一任务。
  const running = Promise.resolve().then(async () => {
    while (currentAccount() === account && task.status === 'pending') {
      const revision = task.revision, recordId = task.recordId;
      setStatus(task, 'syncing');
      save(account, date);
      const result = await requestSync(account, date, recordId);
      if (result.status === 'synced') task.completedRevision = Math.max(task.completedRevision, revision);
      // 同日新增需要再读最新总量，不能把新记录吞进旧请求的成功状态。
      if (task.revision > revision) setStatus(task, 'pending');
      else setStatus(task, result.status, result.message);
      save(account, date);
      // pending 可因中途切账号产生；不能为旧账号继续启动请求。
      if (result.status === 'pending') break;
    }
    return copy(task);
  }).catch(error => {
    setStatus(task, 'failed', failure(error).message);
    save(account, date);
    return copy(task);
  }).finally(() => {
    if (inFlight.get(key) === running) inFlight.delete(key);
  });
  inFlight.set(key, running);
  return running;
}

function acceptSavedRecord(saved, { account } = {}) {
  try {
    if (!saved || saved.autoSyncBijing !== true || !validRecordId(saved.recordId) || !validDate(saved.date) ||
        typeof account !== 'string' || !account) return Promise.resolve(null);
    // 保存回包可能在切账号后到达。仍把同步意图持久化到请求原账号，
    // runTask 与 notify 只允许当前账号执行/展示；切回后由 resumePending 继续。
    const tasks = tasksFor(account), existing = tasks[saved.date];
    if (existing && existing.recordIds.includes(saved.recordId)) {
      // 重复入账确认不是重试授权，失败与未绑定状态等待显式重试。
      return inFlight.get(`${account}:${saved.date}`) || Promise.resolve(copy(existing));
    }
    const task = existing || { date: saved.date, revision: 0, completedRevision: 0, recordIds: [] };
    task.recordId = saved.recordId;
    task.recordIds.push(saved.recordId);
    task.revision++;
    if (task.status !== 'syncing') setStatus(task, 'pending');
    tasks[saved.date] = task;
    save(account, saved.date);
    return continueTask(account, saved.date);
  } catch (_) { return Promise.resolve(null); }
}

async function continueTask(account, date) {
  let task = await runTask(account, date);
  // 新确认可能恰好落在上一轮结束、inFlight 清理之间；清理后再检查，
  // 避免接收了新版本却没有工作者继续运行。
  while (currentAccount() === account && task && tasksFor(account)[date].status === 'pending') {
    task = await runTask(account, date);
  }
  return getDayState(date, account);
}

function retryDate(date) {
  try {
    const account = currentAccount(), task = account && validDate(date) && tasksFor(account)[date];
    if (!task) return Promise.resolve(null);
    const running = inFlight.get(`${account}:${date}`);
    if (running) return running;
    if (task.status === 'synced') return Promise.resolve(copy(task));
    setStatus(task, 'pending');
    save(account, date);
    return continueTask(account, date);
  } catch (_) { return Promise.resolve(null); }
}

async function resumePending() {
  const account = currentAccount();
  if (!account) return [];
  try {
    // 一次前台恢复按日期逐项处理，失败只留下重试入口，不轮询或无限重试。
    const dates = getTasks(account).filter(task => task.status === 'pending').map(task => task.date);
    for (const date of dates) {
      if (currentAccount() !== account) break;
      await continueTask(account, date);
    }
    return getTasks(account);
  } catch (_) { return getTasks(account); }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { acceptSavedRecord, subscribe, getTasks, getDayState, retryDate, resumePending };
