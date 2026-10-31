const api = require('./practiceApi.js');
const auth = require('./practiceAuth.js');
const config = require('./practiceConfig.js');
const STORAGE_KEY = 'practice_outbox_v1';
const listeners = new Set();
let running = null;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function id() { return `practice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}_${Math.random().toString(36).slice(2, 8)}`; }
function read() {
  const stored = wx.getStorageSync(STORAGE_KEY);
  if (!stored) return { version: 1, sequence: 0, tasks: [] };
  if (stored.version !== 1 || !Array.isArray(stored.tasks)) throw failure('QUEUE_STORAGE_INVALID', '待上传记录无法读取，请保留本机数据并联系支持');
  return copy(stored);
}
function notify(event) { listeners.forEach(listener => { try { listener(event); } catch (_) {} }); }
function write(store) {
  try { wx.setStorageSync(STORAGE_KEY, store); }
  catch (_) { throw failure('STORAGE_FAILED', '功课待上传内容未能保存到本机，请释放存储空间后重试'); }
  notify();
}
function mutate(id, change) {
  const store = read(), task = store.tasks.find(item => item.id === id);
  if (!task) return null;
  change(task, store);
  write(store);
  return copy(task);
}
function ownerForTask(owner) {
  if (!owner || !owner.openid || !owner.studentNumber || owner.bindingVersion === undefined) throw failure('AUTH_REQUIRED', '请先绑定本人必经账号');
  return copy(owner);
}
function getPending({ allOwners = false } = {}) {
  const owner = auth.getOwner();
  return read().tasks.filter(task => allOwners || api.sameOwner(owner, task.owner)).map(task => ({ ...task,
    status: task.status === 'sending' ? 'pending' : task.status }));
}
function append(task) {
  const store = read();
  const existing = store.tasks.find(item => item.requestId === task.requestId && api.sameOwner(item.owner, task.owner));
  if (existing) {
    if (existing.type !== task.type || existing.operation !== task.operation || existing.recordId !== task.recordId || existing.kind !== task.kind ||
        JSON.stringify(existing.payload) !== JSON.stringify(task.payload)) throw failure('REQUEST_ID_REUSED', '该请求标识已用于其他内容，请保留原记录后重试');
    return copy(existing);
  }
  task.sequence = ++store.sequence;
  store.tasks.push(task);
  write(store);
  return copy(task);
}
function enqueuePractice({ type, operation, recordId, payload, requestId }) {
  if (!['walking', 'instant', 'learning', 'kindness', 'clapping'].includes(type)) throw failure('INVALID_TYPE', '功课类型无效');
  if (!['create', 'update', 'delete'].includes(operation)) throw failure('INVALID_OPERATION', '功课操作无效');
  const owner = ownerForTask(auth.getOwner()), request = requestId || id();
  const taskId = id();
  if (operation === 'delete' && recordId) {
    // 未确认的删除继续使用原操作身份；再次点击不能排入第二个 DELETE，
    // 否则首个成功后，后一个会把同一记录的 404 留成永久失败任务。
    const deletion = read().tasks.find(task => task.kind === 'practice' && task.type === type &&
      task.operation === 'delete' && task.recordId === recordId && api.sameOwner(task.owner, owner));
    if (deletion) {
      if (JSON.stringify(deletion.payload) !== JSON.stringify(payload || {})) throw failure('DELETE_ALREADY_PENDING', '该记录已有删除请求等待确认，请保留原请求后重试');
      return copy(deletion);
    }
  }
  let dependency;
  if (operation !== 'create') {
    if (!recordId) throw failure('RECORD_ID_REQUIRED', '尚未取得云端记录标识');
    if (String(recordId).startsWith('local:')) {
      dependency = read().tasks.find(task => task.id === String(recordId).slice(6) && task.operation === 'create' && api.sameOwner(task.owner, owner));
      if (!dependency) throw failure('RECORD_NOT_FOUND', '待上传原记录不存在');
      if (operation === 'delete' && !dependency.attempts) { cancel(dependency.id); return { id: taskId, status: 'cancelled', type, operation }; }
    }
  }
  const task = append({ id: taskId, requestId: request, kind: 'practice', owner, type, operation,
    ...(recordId ? { recordId } : {}), payload: copy(payload || {}),
    ...(dependency ? { dependsOn: dependency.id } : {}), entityKey: dependency ? dependency.entityKey : `${type}:${recordId || request}`,
    status: 'pending', attempts: 0, createdAt: Date.now() });
  return task;
}
function enqueueSourceIntent({ operation, identity, snapshot, owner = auth.getOwner(), requestId = id() }) {
  return append({ id: id(), requestId, kind: 'mirror', type: 'sitting', owner: ownerForTask(owner),
    operation, sourceId: identity.recordId || '', identity: copy(identity), snapshot: copy(snapshot || {}),
    payload: {}, entityKey: `sitting:${identity.recordId || identity.localId || identity.timestamp}`,
    status: 'waiting_source', attempts: 0, createdAt: Date.now() });
}
function confirmSource(taskId, sourceId, payload) {
  return mutate(taskId, (task, store) => {
    if (task.kind !== 'mirror' || task.status === 'sending') return;
    task.sourceId = sourceId;
    task.entityKey = `sitting:${sourceId}`;
    task.payload = copy({ ...payload, operationId: task.requestId });
    task.status = 'pending';
    delete task.lastError;
    if (task.operation === 'delete') {
      // 删除确认可越过旧快照：目标端永久删除占位阻止迟到 PUT 复活。
      store.tasks = store.tasks.filter(other => other.id === task.id || other.kind !== 'mirror' ||
        !api.sameOwner(other.owner, task.owner) || other.status === 'sending' ||
        !(other.sourceId === sourceId || task.identity.localId && other.identity.localId === task.identity.localId));
    } else {
      // 已确认的新来源版本覆盖旧 PUT，包括旧冲突待办；删除意图和仍等待原
      // 云操作确认的意图必须保留，不能推断它们已经完成。
      store.tasks = store.tasks.filter(other => other.id === task.id || other.kind !== 'mirror' ||
        other.operation === 'delete' || other.status === 'sending' || other.status === 'waiting_source' ||
        !api.sameOwner(other.owner, task.owner) || other.sourceId !== sourceId ||
        !(Number(other.payload.sourceVersion) < Number(task.payload.sourceVersion)));
    }
  });
}
function markSourceError(taskId, code, message) { return mutate(taskId, task => { task.lastError = { code, message }; }); }
function annotateSource(taskId, values) {
  return mutate(taskId, task => { if (task.kind === 'mirror') Object.assign(task, copy(values)); });
}
function discardSource(taskId) {
  const store = read();
  store.tasks = store.tasks.filter(task => task.id !== taskId);
  write(store);
}
function discardLocalSourceDeletion(taskId, owner) {
  const store = read(), task = store.tasks.find(item => item.id === taskId);
  if (!task || !api.sameOwner(owner, auth.getOwner()) || !api.sameOwner(task.owner, owner) ||
      task.kind !== 'mirror' || task.operation !== 'delete' || task.status !== 'waiting_source' || task.attempts) return false;
  const identity = task.identity || {}, snapshot = task.snapshot || {}, localId = identity.localId;
  // 只信任原上传流程持久化的未发送证据。失败次数或最后一次错误不能排除
  // 更早的超时写入，重开后恢复成 pending 的旧记录也可能仍在云端执行。
  if (!localId || snapshot.localId !== localId || snapshot.syncVersion !== 1 ||
      snapshot.syncSourceAttempted !== false || !['pending', 'failed'].includes(snapshot.syncStatus) ||
      snapshot.syncOpenid && snapshot.syncOpenid !== owner.openid ||
      task.sourceId || identity.recordId || snapshot._id || task.cloudConfirmed ||
      ['createdAt', 'created_at', 'updatedAt', 'updated_at'].some(key => snapshot[key] !== undefined && snapshot[key] !== null) ||
      Object.keys(task.payload || {}).length) return false;
  const related = store.tasks.some(other => {
    if (other.id === task.id || other.kind !== 'mirror' || !api.sameOwner(other.owner, owner)) return false;
    const otherIdentity = other.identity || {}, otherSnapshot = other.snapshot || {};
    const sameRecord = otherIdentity.localId === localId || otherSnapshot.localId === localId || otherSnapshot.idempotencyKey === localId ||
      identity.timestamp && (String(otherIdentity.timestamp) === String(identity.timestamp) ||
        String(otherSnapshot.timestamp) === String(identity.timestamp));
    return sameRecord && (other.operation !== 'delete' || other.sourceId || otherIdentity.recordId ||
      otherSnapshot._id || other.cloudConfirmed || otherSnapshot.syncSourceAttempted !== false ||
      Object.keys(other.payload || {}).length || other.status !== 'waiting_source' || other.attempts);
  });
  if (related) return false;
  store.tasks = store.tasks.filter(item => item.id !== task.id);
  write(store);
  return true;
}
function cancel(taskId) {
  const store = read(), task = store.tasks.find(item => item.id === taskId);
  if (!task || !api.sameOwner(task.owner, auth.getOwner())) throw failure('RECORD_NOT_FOUND', '待上传记录不存在');
  if (task.kind !== 'practice' || task.operation !== 'create' || task.attempts) throw failure('CANNOT_CANCEL', '该记录可能已保存到云端，请确认上传后再删除');
  store.tasks = store.tasks.filter(item => item.id !== taskId && item.dependsOn !== taskId);
  write(store);
}
function enabled(task) { return task.kind === 'mirror' ? config.sittingMirrorEnabled === true : config.practicesEnabled === true; }
function paused(error) {
  return ['AUTH_REQUIRED', 'AUTH_UNAVAILABLE', 'API_UNAVAILABLE', 'BINDING_INVALID', 'ACCOUNT_CHANGED', 'IDENTITY_MISMATCH', 'FEATURE_DISABLED'].includes(error && error.code) ||
    error && [401, 403].includes(error.status);
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function confirmedId(result) { return result && (result.id || result.recordId || result.record && (result.record.id || result.record.recordId)); }
async function send(task) {
  if (task.kind === 'mirror') {
    // 迟延/离线的 PUT 在实际发送前重新读来源。来源已有新版本时以新请求身份
    // 建立最新快照；来源唯一键使替代旧 PUT 安全，普通 create 不走此规则。
    const replacement = await require('./practiceMirror.js').prepareForSend(task);
    if (replacement) return { sourceSuperseded: true, nextTaskId: replacement.id };
    return api.mirror(task.sourceId, task.operation, task.payload, task.requestId, task.owner);
  }
  if (task.operation === 'create') return api.create(task.type, task.payload, task.requestId, task.owner);
  if (task.operation === 'update') return api.update(task.type, task.recordId, task.payload, task.requestId, task.owner);
  return api.remove(task.type, task.recordId, task.requestId, task.owner);
}
async function run({ manual = false, taskIds, onlyUnattempted = false } = {}) {
  const owner = auth.getOwner();
  if (!owner) return { success: false, pending: 0, sent: 0, code: 'AUTH_REQUIRED' };
  let sent = 0;
  const confirmedTasks = new Set();
  try {
    // 单轮快照：过程中新增的操作由下一次触发发送，避免忙循环。
    const requested = Array.isArray(taskIds) ? new Set(taskIds) : null;
    const ids = getPending().filter(task => (!requested || requested.has(task.id)) &&
      (!onlyUnattempted || task.attempts === 0)).sort((a, b) => a.sequence - b.sequence).map(task => task.id);
    const blocked = new Set();
    const replacements = new Map();
    for (const taskId of ids) {
      if (!api.sameOwner(auth.getOwner(), owner)) break;
      let task = read().tasks.find(item => item.id === taskId);
      if (!task || !api.sameOwner(task.owner, owner)) continue;
      // 等待原云操作的旁路意图尚不能发送，也不能永久挡住同来源后来已
      // 确认的完整快照。实际 PUT 仍会发送前复核来源版本；旧意图继续保留。
      if (task.kind === 'mirror' && task.status === 'waiting_source') continue;
      if (!enabled(task) || task.status === 'waiting_source' || task.dependsOn || blocked.has(task.entityKey) ||
          (task.nextRetryAt && task.nextRetryAt > Date.now()) || task.status === 'blocked' && !manual) {
        blocked.add(task.entityKey); continue;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!api.sameOwner(auth.getOwner(), owner) || !enabled(task)) break;
        if (attempt) await delay(attempt === 1 ? 1000 : 3000);
        if (!api.sameOwner(auth.getOwner(), owner) || !enabled(task)) break;
        // 必须先落盘发送状态；落盘失败不产生无法追踪的网络写入。
        task = mutate(taskId, current => { current.status = 'sending'; current.attempts++; });
        if (!task) break;
        try {
          const result = await send(task);
          const recordId = task.kind === 'practice' && task.operation === 'create' ? confirmedId(result) : task.recordId;
          if (task.kind === 'practice' && task.operation === 'create' && !recordId) {
            throw Object.assign(failure('INVALID_RESPONSE', '服务端尚未返回记录标识，请重试确认'), { retryable: true });
          }
          if (!result || !result.sourceSuperseded) {
            confirmedTasks.add(taskId);
            sent = confirmedTasks.size;
          }
          // 读取最新队列，只删除已完成的稳定操作，不吞掉请求期间新加的更新/删除。
          const store = read();
          store.tasks.forEach(later => {
            if (later.dependsOn === taskId) { later.recordId = recordId; later.entityKey = `${later.type}:${recordId}`; delete later.dependsOn; }
          });
          store.tasks = store.tasks.filter(item => item.id !== taskId);
          write(store);
          if (result && result.sourceSuperseded) {
            const count = (replacements.get(task.entityKey) || 0) + 1;
            replacements.set(task.entityKey, count);
            if (count <= 3 && result.nextTaskId && !ids.includes(result.nextTaskId)) ids.push(result.nextTaskId);
          }
          break;
        } catch (reason) {
          const retryable = reason.retryable === true;
          mutate(taskId, current => {
            current.status = paused(reason) ? 'paused' : retryable ? 'pending' : 'blocked';
            current.lastError = { code: reason.code || 'REQUEST_FAILED', message: reason.message || '功课上传失败' };
            if (reason.retryAfterMs) current.nextRetryAt = Date.now() + reason.retryAfterMs;
          });
          if (!retryable || reason.retryAfterMs || attempt === 2) { blocked.add(task.entityKey); break; }
        }
      }
    }
    const pending = getPending().length;
    return { success: pending === 0, pending, sent };
  } finally {
    // 一轮只通知一次已确认的写入；后续任务或本机落盘失败也不吞掉成功回执。
    if (sent) notify({ type: 'flush', owner, sent });
  }
}
function flush(options) {
  if (running) return options && Array.isArray(options.taskIds)
    ? running.then(() => flush(options)) : running;
  running = Promise.resolve().then(() => run(options)).finally(() => { running = null; });
  return running;
}
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
module.exports = { enqueuePractice, enqueueSourceIntent, confirmSource, markSourceError, discardSource, discardLocalSourceDeletion,
  annotateSource, getPending, flush, cancel, subscribe, newRequestId: id };
