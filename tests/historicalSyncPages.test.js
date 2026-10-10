const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = Date.parse('2026-10-05T12:00:00+08:00');
const OLD = '2026-10-04';
const TODAY = '2026-10-05';
const plain = value => JSON.parse(JSON.stringify(value));
const tap = date => ({ currentTarget: { dataset: { date } } });
const success = data => ({ result: { success: true, data } });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const syncedTask = (date = OLD) => ({ date, recordId: 'cloud-old', status: 'synced', message: '当天记录已同步到必经', canRetry: false, revision: 1, completedRevision: 1 });
const failedTask = (date = OLD) => ({ ...syncedTask(date), status: 'failed', message: '记录已保存，必经同步未完成：连接失败', canRetry: true, completedRevision: 0 });
const deletedTask = (date = OLD) => ({ ...failedTask(date), deletionId: `deleted-${date}`, message: '记录已删除，必经同步未完成，请重试' });

function harness(kind, { account = 'oz-user', member = false, retry, dayRecords, resume } = {}) {
  let definition;
  const tasks = new Map(), listeners = new Set();
  const calls = { updates: [], reads: 0, stateReads: [], retry: [], resume: [], cloud: [], toast: [], navigation: [], deleted: [] };
  const records = dayRecords || [
    { _id: 'cloud-old', date: OLD, timestamp: Date.parse(`${OLD}T08:00:00+08:00`), duration: 30, emotion: [], experience: [], backfillRequestId: 'grant-1' },
    { localId: 'local-old', date: OLD, timestamp: Date.parse(`${OLD}T10:00:00+08:00`), duration: 20, emotion: [], experience: [], syncVersion: 1, syncStatus: 'failed', syncError: '普通上传失败' },
    { _id: 'cloud-today', date: TODAY, timestamp: Date.parse(`${TODAY}T08:00:00+08:00`), duration: 10, emotion: [], experience: [] }
  ];
  const grant = { _id: 'grant-1', status: 'approved', canRecord: true, startDate: '2026-10-03', endDate: OLD,
    reason: '闭关', expiresAt: '2026-10-11T18:00:00Z', recordedDates: [OLD], updatedAt: '2026-10-05T01:00:00Z' };
  function publish(task, owner = account) {
    tasks.set(`${owner}:${task.date}`, plain(task));
    for (const listener of listeners) listener({ account: owner, date: task.date });
  }
  const service = {
    resumePending() { calls.resume.push(account); return resume && resume(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getTasks(owner = account) {
      calls.stateReads.push({ owner });
      return [...tasks.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, task]) => plain(task));
    },
    getDayState(date, owner = account) { calls.stateReads.push({ date, owner }); return tasks.get(`${owner}:${date}`) || null; },
    async retryDate(date) {
      const owner = account;
      calls.retry.push({ date, owner });
      const deletion = tasks.get(`${owner}:${date}`)?.deletionId;
      publish({ ...failedTask(date), ...(deletion ? { deletionId: deletion } : {}), status: 'syncing',
        message: deletion ? '记录已删除，正在同步必经' : '记录已保存，正在同步必经', canRetry: false }, owner);
      const result = retry ? await retry(date) : { ...syncedTask(date), ...(deletion ? { deletionId: deletion, message: '删除后的当天总量已同步到必经' } : {}) };
      publish(result, owner);
      return result;
    }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const wx = {
    getStorageSync: key => key === 'userOpenId' ? account : undefined,
    showToast: options => calls.toast.push(options), navigateTo: options => calls.navigation.push(options),
    showActionSheet: options => options.success({ tapIndex: 0 }), showModal: options => options.success({ confirm: true }),
    getNetworkType: options => options.success({ networkType: 'wifi' }),
    stopPullDownRefresh() {}, pageScrollTo() {}
  };
  const modules = {
    'bijingRecordSync.js': service,
    'checkin.js': {
      isUserLoggedIn: () => account.startsWith('oz'),
      getPendingSyncSummary: () => ({ pending: 1 }),
      getUserCheckinData() {
        calls.reads++;
        const dailyRecords = {};
        for (const record of records) {
          if (!dailyRecords[record.date]) dailyRecords[record.date] = { records: [] };
          dailyRecords[record.date].records.push(record);
        }
        return { dailyRecords };
      },
      getExperienceRecordsFromLocal: () => [], refreshFromCloud: async () => false,
      async deleteCheckin(date, identity) {
        calls.deleted.push({ date, identity: plain(identity) });
        const index = records.findIndex(record => record.date === date && record._id === identity.recordId);
        if (index >= 0) records.splice(index, 1);
        publish(deletedTask(date));
        return { success: true };
      }
    },
    'dailyWisdom.js': { DEFAULT_QUOTE: '', watchDailyWisdom: () => () => {} },
    'contentSec.js': {},
    'homeBackfill.js': { data: {}, methods: { initHomeBackfill() {}, stopHomeBackfill() {}, refreshBackfillSelection() {}, refreshBackfillSyncState() {} } },
    'memberHistory.js': { initialData: () => ({ isMemberHistory: member }), async load(page, done) { done(); }, query: () => '' },
    'cloudApi.js': { async callCloudFunction(name, data) {
      calls.cloud.push({ name, data: plain(data) });
      if (data.type === 'getMyBackfillRequests') return success({ requests: [grant] });
      if (data.type === 'getAccess') return success({ isAdmin: false });
      if (data.type === 'getUserRecords') return success(records.filter(record => record.date === data.date && record._id));
      if (data.type === 'syncBackfillDate') return success({ date: data.recordDate, success: true });
      throw new Error(`Unexpected cloud operation: ${data.type}`);
    } }
  };
  function load(name) {
    const filename = path.basename(name);
    if (modules[filename]) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js'].includes(filename));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', filename), 'utf8'),
      { module, require: load, Date: Clock, wx, setTimeout() {}, clearTimeout() {} });
    if (filename === 'dateUtil.js') module.exports.watchBusinessDate = () => () => {};
    return modules[filename] = module.exports;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${kind}/${kind}.js`), 'utf8'), {
    Page(value) { definition = value; }, require: load, wx, Date: Clock,
    getApp: () => ({}), console: { log() {}, error() {}, warn() {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}
  });
  const page = { ...definition, data: plain(definition.data), setData(values, callback) {
    calls.updates.push(plain(values)); Object.assign(this.data, values); if (callback) callback();
  } };
  if (kind === 'index') {
    page.checkUserInfoStatus = () => {};
    page.generateCalendar = () => {};
    page.refreshCheckinsFromCloud = async () => false;
  } else page.onLoad({});
  if (member) page._memberRecords = [{ _id: 'member-record', id: 'member-record', dayDate: OLD, date: OLD, duration: 40, emotion: [], experienceTexts: [] }];
  return { page, calls, tasks, listeners, publish, setAccount(value) { account = value; },
    shown: () => kind === 'index' ? page.data.checkinRecords : page.data.monthDays.flatMap(day => day.records) };
}

for (const kind of ['index', 'checkinHistory']) {
  test(`${kind}: historical cloud records show independent bijing states, while today and local uploads stay separate`, async () => {
    const { page, calls, publish, shown } = harness(kind);
    publish(failedTask()); publish(failedTask(TODAY)); await page.onShow();
    const cloud = shown().find(record => record._id === 'cloud-old');
    assert.match(cloud.bijingSyncText, /必经同步未完成/); assert.equal(cloud.bijingCanRetry, true);
    assert.equal(cloud.syncStatus, undefined);
    const local = shown().find(record => record.localId === 'local-old');
    assert.equal(local.bijingSyncText, ''); assert.equal(local.syncStatus, 'failed'); assert.equal(local.syncError, '普通上传失败');
    assert.equal(shown().find(record => record._id === 'cloud-today').bijingSyncText, '');
    publish(syncedTask());
    assert.match(shown().find(record => record._id === 'cloud-old').bijingSyncText, /已同步到必经/);
    assert.equal(shown().find(record => record._id === 'cloud-old').bijingCanRetry, false);
    assert.equal(calls.toast.length, 0);
  });

  test(`${kind}: retry synchronizes the saved date without creating a meditation record or navigating`, async () => {
    const { page, calls, publish, shown } = harness(kind);
    publish(failedTask()); await page.onShow(); await page.retryBijingSync(tap(OLD));
    assert.deepEqual(calls.retry, [{ date: OLD, owner: 'oz-user' }]);
    assert.equal(calls.cloud.length, 0); assert.equal(calls.navigation.length, 0); assert.equal(calls.toast.length, 0);
    assert.equal(shown().length, 3);
    await page.retryBijingSync(tap(TODAY)); assert.equal(calls.retry.length, 1);
    const markup = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${kind}/${kind}.wxml`), 'utf8');
    assert.match(markup, /catchtap="retryBijingSync"/);
  });

  test(`${kind}: subscriptions and in-flight retries cannot refresh hidden pages or another account`, async () => {
    const pending = deferred(); const { page, calls, listeners, publish, setAccount } = harness(kind, { retry: () => pending.promise });
    publish(failedTask()); await page.onShow();
    const beforeOther = calls.updates.length; publish(failedTask(), 'oz-other'); assert.equal(calls.updates.length, beforeOther);
    const retrying = page.retryBijingSync(tap(OLD)); const callback = [...listeners][0];
    page.onHide(); assert.equal(listeners.size, 0); const hidden = calls.updates.length;
    callback({ account: 'oz-user', date: OLD }); assert.equal(calls.updates.length, hidden);
    setAccount('oz-other'); await page.onShow(); const current = calls.updates.length;
    pending.resolve(syncedTask()); await retrying; await flush(); assert.equal(calls.updates.length, current);
    page.onUnload(); assert.equal(listeners.size, 0);
  });

  test(`${kind}: visitors never see or retry account synchronization states`, async () => {
    const { page, calls, listeners, publish, shown } = harness(kind, { account: '' });
    publish(failedTask(), 'oz-user'); await page.onShow(); await page.retryBijingSync(tap(OLD));
    assert.equal(listeners.size, 0); assert.equal(calls.stateReads.length, 0); assert.equal(calls.retry.length, 0);
    assert.ok(shown().every(record => !record.bijingSyncText));
  });

  test(`${kind}: a deleted empty day retains synchronization status and can retry the total without a record`, async () => {
    for (const status of ['failed', 'unbound']) {
      const { page, calls, publish, shown } = harness(kind, { dayRecords: [] });
      const currentTask = () => kind === 'index'
        ? page.data.bijingDeletionTasks.find(task => task.date === OLD)
        : page.data.monthDays.find(day => day.date === OLD);
      publish({ ...deletedTask(), status }); await page.onShow();
      const task = currentTask();
      assert.ok(task, 'the deletion state is visible with no surviving record');
      assert.match(task.message || task.bijingSyncText, /已删除/);
      assert.equal(task.canRetry ?? task.bijingCanRetry, true);
      assert.equal(shown().length, 0);
      await page.retryBijingSync(tap(OLD));
      assert.deepEqual(calls.retry, [{ date: OLD, owner: 'oz-user' }]);
      assert.equal(currentTask().status || currentTask().bijingSyncStatus, 'synced');
      assert.equal(currentTask().canRetry ?? currentTask().bijingCanRetry, false);
      assert.equal(calls.cloud.length, 0); assert.equal(calls.deleted.length, 0);
      assert.equal(calls.navigation.length, 0); assert.equal(calls.toast.length, 0);
    }
  });

  test(`${kind}: deletion banners update independently and never repeat on remaining records`, async () => {
    const { page, publish, shown } = harness(kind);
    publish(deletedTask()); await page.onShow();
    assert.ok(shown().filter(record => record.dayDate === OLD).every(record => !record.bijingSyncText));
    publish({ ...deletedTask(), status: 'syncing', canRetry: false, message: '记录已删除，正在同步必经' });
    const task = kind === 'index' ? page.data.bijingDeletionTasks[0] : page.data.monthDays.find(day => day.date === OLD);
    assert.equal(task.status || task.bijingSyncStatus, 'syncing');
    assert.equal(task.canRetry ?? task.bijingCanRetry, false);
    assert.equal(shown().length, 3);
  });

  test(`${kind}: deleted-day retries respect hidden pages and account changes`, async () => {
    const pending = deferred();
    const { page, calls, listeners, publish, setAccount } = harness(kind, { dayRecords: [], retry: () => pending.promise });
    const banners = () => kind === 'index' ? page.data.bijingDeletionTasks : page.data.monthDays;
    publish(deletedTask()); await page.onShow();
    const retrying = page.retryBijingSync(tap(OLD)); const callback = [...listeners][0];
    page.onHide(); const hidden = calls.updates.length;
    callback({ account: 'oz-user', date: OLD }); await page.retryBijingSync(tap(OLD));
    assert.equal(calls.updates.length, hidden); assert.equal(calls.retry.length, 1);
    setAccount('oz-other'); await page.onShow();
    assert.deepEqual(plain(banners()), []);
    const switched = calls.updates.length;
    pending.resolve({ ...deletedTask(), status: 'synced', canRetry: false }); await retrying;
    assert.equal(calls.updates.length, switched); assert.deepEqual(plain(banners()), []);
    setAccount(''); await page.onShow(); assert.deepEqual(plain(banners()), []);
    await page.retryBijingSync(tap(OLD)); assert.equal(calls.retry.length, 1);
  });
}

test('monthly deletion keeps an empty day available for retry while record and day totals become zero', async () => {
  const { page, calls } = harness('checkinHistory', { dayRecords: [
    { _id: 'cloud-old', date: OLD, timestamp: Date.parse(`${OLD}T08:00:00+08:00`), duration: 30, emotion: [], experience: [] }
  ] });
  await page.onShow();
  const record = page.data.monthDays[0].records[0];
  await page.deleteCheckinRecord({ currentTarget: { dataset: { id: record.id } } });
  assert.equal(calls.deleted.length, 1); assert.equal(page.data.monthCount, 0);
  assert.equal(page.data.monthDuration, 0); assert.equal(page.data.monthDayCount, 0);
  assert.equal(page.data.monthDays.length, 1); assert.equal(page.data.monthDays[0].date, OLD);
  assert.equal(page.data.monthDays[0].records.length, 0); assert.equal(page.data.monthDays[0].bijingCanRetry, true);
  page.previousMonth(); assert.equal(page.data.monthDays.length, 0);
  await page.retryBijingSync(tap(OLD)); assert.equal(calls.retry.length, 0);
  page.nextMonth(); await page.retryBijingSync(tap(OLD)); assert.equal(calls.retry.length, 1);
});

test('member monthly histories never query or display the viewing account’s synchronization state', async () => {
  const { page, calls, listeners, publish, shown } = harness('checkinHistory', { member: true });
  publish(failedTask()); await page.onShow(); await page.retryBijingSync(tap(OLD));
  assert.equal(listeners.size, 0); assert.equal(calls.stateReads.length, 0); assert.equal(calls.retry.length, 0);
  assert.equal(shown()[0]._id, 'member-record'); assert.equal(shown()[0].bijingSyncText, undefined);
});

test('home entry resumes the active account’s pending work after login or switching back without blocking rendering', async () => {
  const pending = deferred();
  const { page, calls, publish, setAccount } = harness('index', { account: '', resume: () => pending.promise });
  await page.onShow(); assert.equal(calls.resume.length, 0);
  page.onHide(); setAccount('oz-user'); publish(failedTask());
  let rendered = false;
  const opening = page.onShow().then(() => { rendered = true; });
  await flush(); assert.equal(rendered, true, 'an unresolved background sync cannot delay home entry');
  assert.deepEqual(calls.resume, ['oz-user']);
  assert.equal(calls.retry.length, 0, 'failed tasks are never explicitly retried on entry');
  page.onHide(); setAccount('oz-other'); await page.onShow();
  page.onHide(); setAccount('oz-user'); await page.onShow();
  assert.deepEqual(calls.resume, ['oz-user', 'oz-other', 'oz-user']);
  assert.equal(calls.retry.length, 0);
  pending.resolve(); await opening;
});

test('approved-date correction uses its grant even when a shared task is synced or refers to a deleted record', async () => {
  for (const task of [syncedTask(), { ...failedTask(), recordId: 'deleted-record' }]) {
    const { page, calls, publish } = harness('backfill', { dayRecords: [] });
    publish(task); await page.onShow(); await page.openDayRecords({ currentTarget: { dataset: { id: 'grant-1' } } });
    await page.onRecordDateChange({ detail: { value: OLD } }); assert.equal(page.data.canSyncDay, true);
    await page.syncApprovedDay();
    assert.equal(calls.retry.length, 0);
    assert.deepEqual(calls.cloud.filter(call => call.data.type === 'syncBackfillDate').map(call => call.data),
      [{ type: 'syncBackfillDate', requestId: 'grant-1', recordDate: OLD, expectedOpenid: 'oz-user' }]);
    assert.match(page.data.syncMessage, /已同步到必经/); assert.equal(page.data.bijingTaskText, '');
    publish(task); assert.equal(page.data.bijingTaskText, '', 'an unchanged stale task cannot contradict the confirmed correction');
    publish({ ...failedTask(), revision: 2, status: 'syncing', message: '记录已保存，正在同步必经', canRetry: false });
    assert.equal(page.data.syncMessage, ''); assert.match(page.data.bijingTaskText, /正在同步/);
    await page.syncApprovedDay(); assert.equal(calls.cloud.filter(call => call.data.type === 'syncBackfillDate').length, 1);
  }
});
