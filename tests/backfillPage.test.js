const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil.js');

const NOW = Date.parse('2026-10-05T04:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const input = value => ({ detail: { value } });
const event = dataset => ({ currentTarget: { dataset } });
const success = data => ({ success: true, data });
const row = (extra = {}) => ({ _id: 'request-1', startDate: '2026-09-20', endDate: '2026-10-04', reason: '闭关静坐',
  status: 'pending', reply: '', createdAt: '2026-10-05T01:00:00Z', updatedAt: '2026-10-05T01:00:00Z',
  expiresAt: '2026-10-11T18:00:00Z', expired: false, canRecord: false, nickname: '静心', studentNumber: 'BJ001', ...extra });
const approved = (extra = {}) => row({ status: 'approved', canRecord: true, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ api, isAdmin = false, owner = 'oz-user', network = 'wifi', deferRender = false, storageError = false, navigationError = false, syncRetry } = {}) {
  let definition;
  const calls = { cloud: [], toast: [], navigate: [], refreshAlerts: [], renders: [], updates: [], tabs: [], storage: [], serviceRetry: [] };
  const syncTasks = new Map(), syncListeners = new Set(), businessDateListeners = new Set();
  function publishTask(task, taskOwner = owner) {
    syncTasks.set(`${taskOwner}:${task.date}`, task);
    for (const listener of syncListeners) listener({ account: taskOwner, date: task.date });
  }
  const storage = new Map();
  const clock = { now: NOW };
  const timers = new Map(); let timerId = 0;
  function fireTimer(id) {
    const timer = timers.get(id);
    if (!timer) throw new Error(`Timer ${id} is not scheduled`);
    timers.delete(id); timer.callback();
  }
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/backfill/backfill.js'), 'utf8'), {
    Page(value) { definition = value; }, Date: FakeDate, console,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, at: clock.now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    getApp: () => ({ refreshSyncAlert(options) { calls.refreshAlerts.push(plain(options)); } }),
    wx: {
      getStorageSync: key => key === 'userOpenId' ? owner : storage.get(key),
      setStorageSync(key, value) { if (storageError) throw new Error('存储失败'); storage.set(key, plain(value)); calls.storage.push({ key, value: plain(value) }); },
      removeStorageSync(key) { storage.delete(key); },
      switchTab(options) { calls.tabs.push(plain(options)); if (navigationError) options.fail({ errMsg: '打开失败' }); },
      getNetworkType(options) { if (typeof network === 'function') network(options); else options.success({ networkType: network }); },
      showToast(options) { calls.toast.push(plain(options)); },
      navigateTo(options) { calls.navigate.push(plain(options)); }, stopPullDownRefresh() {}, pageScrollTo() {}
    },
    require(name) {
      if (name.includes('bijingRecordSync')) return {
        subscribe(listener) { syncListeners.add(listener); return () => syncListeners.delete(listener); },
        getDayState(date, taskOwner = owner) { return syncTasks.get(`${taskOwner}:${date}`) || null; },
        async retryDate(date) {
          calls.serviceRetry.push(date);
          const task = syncRetry ? await syncRetry(date) : { ...syncTasks.get(`${owner}:${date}`), date, status: 'synced', message: '当天记录已同步到必经', canRetry: false };
          publishTask(task);
          return task;
        }
      };
      if (name.includes('dateUtil')) return { ...dateUtil,
        getBusinessDate: value => dateUtil.getBusinessDate(value === undefined ? clock.now : value),
        watchBusinessDate(listener) { businessDateListeners.add(listener); return () => businessDateListeners.delete(listener); }
      };
      if (name.includes('checkin')) return { isUserLoggedIn: () => !!owner };
      if (name.includes('cloudApi')) return { async callCloudFunction(name, data) {
        calls.cloud.push({ name, data: plain(data) });
        let result = api && await api(name, data, calls.cloud.filter(call => call.data.type === data.type).length);
        if (result === undefined) result = success(data.type === 'getAccess' ? { isAdmin }
          : ['getMyBackfillRequests', 'adminListBackfillRequests'].includes(data.type) ? { requests: [], nextCursor: '' }
            : data.type === 'markBackfillRead' ? { markedCount: data.requests.length }
              : data.type === 'getUserRecords' ? []
                : data.type === 'syncBackfillDate' ? { date: data.recordDate, success: true, duration: 30 }
                    : data.type === 'adminReviewBackfillRequest' ? { request: row({ status: data.status, reply: data.reply }) }
                      : { request: row() });
        return { result };
      } };
      throw new Error(`Unexpected require ${name}`);
    }
  });
  const page = { ...definition, data: plain(definition.data), setData(values, callback) {
    calls.updates.push(plain(values)); Object.assign(this.data, values);
    if (callback) { if (deferRender) calls.renders.push(callback); else callback(); }
  } };
  page.onLoad({});
  return { page, calls, clock, storage, timers, fireTimer, publishTask, syncListeners, businessDateListeners,
    setAccount(value) { owner = value; }, render() { calls.renders.splice(0).forEach(fn => fn()); } };
}
const requests = (calls, type) => calls.cloud.filter(call => call.data.type === type);
function draft(page, extra = {}) {
  page.onStartChange(input(extra.startDate || '2026-09-05'));
  page.onEndChange(input(extra.endDate || '2026-10-04'));
  page.onReasonInput(input(extra.reason === undefined ? '  闭关未携带手机  ' : extra.reason));
}
async function dayRecords(options = {}) {
  const result = harness({ ...options, api: async (name, data, count) => {
    const answer = options.api && await options.api(name, data, count);
    return answer === undefined && data.type === 'getMyBackfillRequests' ? success({ requests: [approved(options.row)], nextCursor: '' }) : answer;
  } });
  await result.page.onShow();
  await result.page.openDayRecords(event({ id: 'request-1' }));
  return result;
}

test('page is registered and visitors are directed to login without private requests', async () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/backfill/backfill'));
  const { page, calls } = harness({ owner: '' });
  await page.onShow(); await page.submitRequest();
  assert.equal(calls.cloud.length, 0);
  assert.match(calls.navigate[0].url, /pages%2Fbackfill%2Fbackfill/);
});

test('request allows exactly 30 inclusive past days and sends a trimmed reason', async () => {
  const { page, calls } = harness(); await page.onShow(); draft(page);
  assert.equal(page.data.minStartDate, '2026-09-05'); assert.equal(page.data.minEndDate, '2026-09-05');
  assert.equal(page.data.maxEndDate, '2026-10-04');
  assert.equal(page.data.rangeDays, 30);
  await page.submitRequest();
  const request = requests(calls, 'submitBackfillRequest')[0].data;
  assert.equal(request.startDate, '2026-09-05'); assert.equal(request.endDate, '2026-10-04');
  assert.equal(request.reason, '闭关未携带手机');
  assert.equal(page.data.reason, ''); assert.equal(calls.toast.length, 1);
  assert.equal(page.data.rangeDays, 0);
  assert.deepEqual(calls.refreshAlerts, [{ force: true }]);
});

test('range guidance follows both date pickers and handles month and year boundaries', async () => {
  const { page, clock } = harness(); await page.onShow();
  assert.equal(page.data.rangeDays, 0);
  page.onStartChange(input('2026-09-30'));
  assert.equal(page.data.rangeDays, 0);
  page.onEndChange(input('2026-10-04'));
  assert.equal(page.data.rangeDays, 5);
  page.onStartChange(input('2026-10-02'));
  assert.equal(page.data.rangeDays, 3);
  page.onEndChange(input('2026-10-03'));
  assert.equal(page.data.rangeDays, 2);
  clock.now = Date.parse('2027-01-03T04:00:00Z');
  page.onStartChange(input('2026-12-28')); page.onEndChange(input('2027-01-02'));
  assert.equal(page.data.rangeDays, 6);
  page.onEndChange(input('2026-12-31'));
  assert.equal(page.data.rangeDays, 4);
  clock.now = Date.parse('2028-03-02T04:00:00Z');
  page.onStartChange(input('2028-02-28')); page.onEndChange(input('2028-03-01'));
  assert.equal(page.data.rangeDays, 3);
});

test('missing, malformed, reversed and overlong ranges clear any previous guidance', async () => {
  const { page } = harness(); await page.onShow();
  for (const [startDate, endDate] of [
    ['', '2026-10-04'], ['2026-09-05', ''], ['2026-02-30', '2026-03-01'],
    ['2026-09-05', 'invalid'], ['2026-10-04', '2026-10-03'], ['2026-09-04', '2026-10-04'],
    ['2026-09-04', '2026-09-04'], ['2026-10-05', '2026-10-05'], ['2026-10-06', '2026-10-06']
  ]) {
    draft(page);
    page.onStartChange(input(startDate)); page.onEndChange(input(endDate));
    assert.equal(page.data.rangeDays, 0, `${startDate} – ${endDate}`);
  }
});

test('returning restores draft guidance and switching accounts clears it with the dates', async () => {
  const { page, setAccount } = harness(); await page.onShow(); draft(page);
  page.onHide(); page.data.rangeDays = 0;
  await page.onShow();
  assert.equal(page.data.rangeDays, 30);
  page.onHide(); setAccount('oz-other'); await page.onShow();
  assert.equal(page.data.startDate, ''); assert.equal(page.data.endDate, '');
  assert.equal(page.data.rangeDays, 0);
});

test('invalid ranges, dates outside the last 30 past business days and missing reasons never reach the server', async () => {
  for (const invalid of [
    { startDate: '2026-09-04' }, { startDate: '2026-10-04', endDate: '2026-10-03' },
    { startDate: '2026-10-05', endDate: '2026-10-05' }, { startDate: '2026-10-06', endDate: '2026-10-06' },
    { startDate: '2026-09-04', endDate: '2026-09-04' }, { reason: ' ' }, { reason: '字'.repeat(501) }
  ]) {
    const { page, calls } = harness(); await page.onShow(); draft(page, invalid); await page.submitRequest();
    assert.ok(page.data.submitError, JSON.stringify(invalid)); assert.equal(requests(calls, 'submitBackfillRequest').length, 0);
  }
});

test('dates older than seven days remain eligible within the last 30 past business days', async () => {
  const { page, calls } = harness(); await page.onShow();
  draft(page, { startDate: '2026-09-05', endDate: '2026-09-05' }); await page.submitRequest();
  const sent = requests(calls, 'submitBackfillRequest');
  assert.equal(sent.length, 1); assert.equal(sent[0].data.endDate, '2026-09-05');
});

test('application dates roll over at Beijing 02:00, including an already open draft', async () => {
  const { page, calls, clock } = harness();
  clock.now = Date.parse('2026-10-05T01:59:59.999+08:00'); await page.onShow();
  assert.equal(page.data.minStartDate, '2026-09-04'); assert.equal(page.data.minEndDate, '2026-09-04');
  assert.equal(page.data.maxEndDate, '2026-10-03');
  draft(page, { startDate: '2026-10-04', endDate: '2026-10-04' }); await page.submitRequest();
  assert.equal(requests(calls, 'submitBackfillRequest').length, 0); assert.equal(page.data.rangeDays, 0);
  draft(page, { startDate: '2026-09-04', endDate: '2026-10-03' });
  assert.equal(page.data.rangeDays, 30);
  clock.now = Date.parse('2026-10-05T02:00:00+08:00'); await page.submitRequest();
  assert.equal(requests(calls, 'submitBackfillRequest').length, 0); assert.equal(page.data.rangeDays, 0);
  assert.match(page.data.submitError, /2026-09-05 至 2026-10-04/);
  page.onHide(); await page.onShow();
  assert.equal(page.data.minStartDate, '2026-09-05'); assert.equal(page.data.minEndDate, '2026-09-05');
  assert.equal(page.data.maxEndDate, '2026-10-04'); assert.equal(page.data.rangeDays, 0);
  draft(page); assert.equal(page.data.rangeDays, 30); await page.submitRequest();
  assert.equal(requests(calls, 'submitBackfillRequest').length, 1);
});

test('visible date pickers refresh at 02:00 and business-day subscriptions follow page lifetime', async () => {
  const { page, calls, clock, businessDateListeners } = harness();
  clock.now = Date.parse('2026-10-05T01:59:59.999+08:00'); await page.onShow();
  draft(page, { startDate: '2026-09-04', endDate: '2026-10-03' });
  const oldListener = [...businessDateListeners][0];
  await page.onShow(); assert.equal(businessDateListeners.size, 1);
  clock.now = Date.parse('2026-10-05T02:00:00+08:00');
  const updates = calls.updates.length;
  oldListener('2026-10-05', '2026-10-04'); assert.equal(calls.updates.length, updates);
  const listener = [...businessDateListeners][0]; listener('2026-10-05', '2026-10-04');
  assert.equal(page.data.minStartDate, '2026-09-05'); assert.equal(page.data.minEndDate, '2026-09-05');
  assert.equal(page.data.maxEndDate, '2026-10-04'); assert.equal(page.data.rangeDays, 0);
  assert.equal(page.data.startDate, '2026-09-04'); assert.equal(page.data.endDate, '2026-10-03');
  page.onHide(); assert.equal(businessDateListeners.size, 0);
  const hiddenUpdates = calls.updates.length;
  listener('2026-10-06', '2026-10-05'); assert.equal(calls.updates.length, hiddenUpdates);
  await page.onShow(); assert.equal(businessDateListeners.size, 1);
  page.onUnload(); assert.equal(businessDateListeners.size, 0);
});

test('new pending requests without a deadline stay active and can be reviewed', async () => {
  const pending = row({ ruleVersion: 2, expiresAt: null });
  const { page, calls, clock } = harness({ isAdmin: true, api: (name, data) =>
    ['getMyBackfillRequests', 'adminListBackfillRequests'].includes(data.type) ? success({ requests: [pending] }) : undefined });
  clock.now = Date.parse('2026-12-05T04:00:00Z'); await page.onShow();
  assert.equal(page.data.requests[0].expired, false); assert.equal(page.data.requests[0].statusText, '待审批');
  assert.equal(page.data.requests[0].expiresText, ''); assert.equal(page.data.activeRequest, true);
  draft(page, { startDate: '2026-12-01', endDate: '2026-12-04' }); await page.submitRequest();
  assert.match(page.data.submitError, /已有待审批或有效申请/);
  assert.equal(requests(calls, 'submitBackfillRequest').length, 0);
  await page.switchTab(event({ tab: 'review' })); page.selectReview(event({ id: 'request-1' }));
  assert.equal(page.data.reviewRequest._id, 'request-1'); assert.equal(page.data.reviewRequest.expired, false);
  await page.reviewRequest(event({ status: 'approved' }));
  assert.equal(requests(calls, 'adminReviewBackfillRequest').length, 1);
});

test('empty deadlines cannot become epoch expiration dates for pending or rejected requests', async () => {
  for (const expiresAt of [null, undefined, '', { $date: null }]) {
    const { page } = harness({ api: (name, data) => data.type === 'getMyBackfillRequests' ? success({ requests: [
      row({ ruleVersion: 2, expiresAt }), row({ _id: 'rejected', status: 'rejected', ruleVersion: 2, expiresAt })
    ] }) : undefined });
    await page.onShow();
    assert.deepEqual(page.data.requests.map(item => item.expired), [false, false]);
    assert.deepEqual(page.data.requests.map(item => item.statusText), ['待审批', '未通过']);
    assert.deepEqual(page.data.requests.map(item => item.expiresText), ['', '']);
  }
});

test('approved applications use the cloud deadline at the precise 72-hour boundary', async () => {
  const approvedAt = Date.parse('2026-10-05T12:34:56+08:00');
  const expiresAt = approvedAt + 72 * 3600000;
  const { page, calls, clock } = harness({ api: (name, data) => data.type === 'getMyBackfillRequests'
    ? success({ requests: [approved({ ruleVersion: 2, reviewedAt: new Date(approvedAt).toISOString(), expiresAt: { $date: expiresAt } })] }) : undefined });
  clock.now = expiresAt - 1; await page.onShow();
  assert.equal(page.data.requests[0].expired, false); assert.equal(page.data.requests[0].canRecord, true);
  assert.equal(page.data.requests[0].expiresText, '2026-10-08 12:34'); assert.equal(page.data.activeRequest, true);
  clock.now = expiresAt;
  page.goHomeRecord(event({ id: 'request-1' })); assert.equal(calls.tabs.length, 0);
  await page.loadRequests();
  assert.equal(page.data.requests[0].expired, true); assert.equal(page.data.requests[0].canRecord, false);
  assert.equal(page.data.requests[0].statusText, '已过期'); assert.equal(page.data.activeRequest, false);
});

test('approval expiration automatically removes recording access and unlocks the preserved draft without cloud calls', async () => {
  const expiresAt = NOW + 1000;
  const { page, calls, clock, timers, fireTimer } = await dayRecords({ row: { ruleVersion: 2, expiresAt } });
  draft(page, { reason: '准备申请另一段日期' });
  assert.equal(page.data.activeRequest, true); assert.equal(page.data.selectedRequest.canRecord, true);
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0]; assert.equal(timer.at, expiresAt);
  const cloudCalls = calls.cloud.length;
  clock.now = expiresAt; fireTimer(id);
  assert.equal(calls.cloud.length, cloudCalls); assert.equal(timers.size, 0);
  assert.equal(page.data.requests[0].expired, true); assert.equal(page.data.requests[0].canRecord, false);
  assert.equal(page.data.selectedRequest.expired, true); assert.equal(page.data.selectedRequest.canRecord, false);
  assert.equal(page.data.activeRequest, false);
  assert.equal(page.data.startDate, '2026-09-05'); assert.equal(page.data.endDate, '2026-10-04');
  assert.equal(page.data.rangeDays, 30); assert.equal(page.data.reason, '准备申请另一段日期');
});

test('expiration refreshes administrator selections and schedules only the next loaded deadline', async () => {
  const firstDeadline = NOW + 1000, lastDeadline = NOW + 3000;
  const legacyPending = row({ _id: 'legacy', expiresAt: firstDeadline });
  const { page, calls, clock, timers, fireTimer } = harness({ isAdmin: true, api: (name, data) =>
    data.type === 'getMyBackfillRequests' ? success({ requests: [approved({ expiresAt: lastDeadline })] })
      : data.type === 'adminListBackfillRequests' ? success({ requests: [legacyPending] }) : undefined });
  await page.onShow(); await page.switchTab(event({ tab: 'review' })); page.selectReview(event({ id: 'legacy' }));
  page.onReplyInput(input('保留审批备注'));
  assert.equal(timers.size, 1);
  const [firstId, firstTimer] = [...timers][0]; assert.equal(firstTimer.at, firstDeadline);
  const cloudCalls = calls.cloud.length;
  clock.now = firstDeadline; fireTimer(firstId);
  assert.equal(page.data.adminRequests[0].expired, true); assert.equal(page.data.reviewRequest.expired, true);
  assert.equal(page.data.reviewReply, '保留审批备注'); assert.equal(page.data.activeRequest, true);
  assert.equal(timers.size, 1);
  const [lastId, lastTimer] = [...timers][0]; assert.equal(lastTimer.at, lastDeadline);
  clock.now = lastDeadline; fireTimer(lastId);
  assert.equal(page.data.requests[0].expired, true); assert.equal(page.data.activeRequest, false);
  assert.equal(timers.size, 0); assert.equal(calls.cloud.length, cloudCalls);
});

test('an expired recording entry refreshes locally and explains the expiry if its timer has not fired', async () => {
  const expiresAt = NOW + 1000;
  const { page, calls, clock, timers, storage } = await dayRecords({ row: { expiresAt } });
  draft(page, { reason: '保留草稿' });
  const cloudCalls = calls.cloud.length;
  clock.now = expiresAt; page.goHomeRecord(event({ id: 'request-1' }));
  assert.equal(page.data.activeRequest, false); assert.equal(page.data.requests[0].canRecord, false);
  assert.equal(page.data.selectedRequest.canRecord, false); assert.equal(page.data.reason, '保留草稿');
  assert.match(calls.toast[0].title, /补录期限已结束/); assert.equal(calls.tabs.length, 0);
  assert.equal(storage.has('homeBackfillIntent'), false); assert.equal(timers.size, 0);
  assert.equal(calls.cloud.length, cloudCalls);
});

test('expiration callbacks cannot write after hiding, unloading, account changes or replacement', async () => {
  for (const change of ['hide', 'unload', 'account', 'newAccountPage', 'replace']) {
    const { page, calls, clock, timers, setAccount } = harness({ api: (name, data) => data.type === 'getMyBackfillRequests'
      ? success({ requests: [approved({ expiresAt: NOW + 1000 })] }) : undefined });
    await page.onShow();
    const callback = [...timers.values()][0].callback;
    if (change === 'hide') page.onHide();
    if (change === 'unload') page.onUnload();
    if (change === 'account') setAccount('oz-other');
    if (change === 'newAccountPage') { setAccount('oz-other'); await page.onShow(); }
    if (change === 'replace') await page.loadRequests();
    if (change === 'hide' || change === 'unload') assert.equal(timers.size, 0, change);
    if (change === 'newAccountPage' || change === 'replace') assert.equal(timers.size, 1, change);
    const updates = calls.updates.length;
    clock.now = NOW + 1000; callback();
    assert.equal(calls.updates.length, updates, change);
  }
});

test('newly submitted pending requests keep the form locked during unrelated expiration refreshes', async () => {
  const reload = deferred();
  const pending = row({ ruleVersion: 2, expiresAt: null });
  const { page, calls } = harness({ api: (name, data, count) => data.type === 'submitBackfillRequest'
    ? success({ request: pending }) : data.type === 'getMyBackfillRequests' && count === 2 ? reload.promise : undefined });
  await page.onShow(); draft(page);
  const submitting = page.submitRequest(); await flush();
  assert.equal(page.data.requests[0]._id, pending._id); assert.equal(page.data.activeRequest, true);
  page.refreshExpirations(); assert.equal(page.data.activeRequest, true);
  reload.resolve(success({ requests: [pending] })); await submitting;
  assert.equal(page.data.activeRequest, true); assert.equal(calls.toast.length, 1);
});

test('offline requests preserve drafts and never announce success', async () => {
  const { page, calls } = harness({ network: 'none' }); await page.onShow(); draft(page); await page.submitRequest();
  assert.equal(requests(calls, 'submitBackfillRequest').length, 0);
  assert.match(page.data.submitError, /联网/); assert.equal(page.data.reason.trim(), '闭关未携带手机'); assert.equal(calls.toast.length, 0);
});

test('uncertain submission retries reuse their identity and double taps stay locked', async () => {
  const pending = deferred();
  const { page, calls } = harness({ api: (name, data, count) => data.type === 'submitBackfillRequest'
    ? count === 1 ? pending.promise : success({ request: row() }) : undefined });
  await page.onShow(); draft(page);
  const saving = page.submitRequest(); await flush(); await page.submitRequest();
  page.onReasonInput(input('修改失败'));
  assert.equal(requests(calls, 'submitBackfillRequest').length, 1);
  pending.reject(new Error('连接中断')); await saving;
  assert.equal(calls.toast.length, 0); assert.equal(page.data.reason.trim(), '闭关未携带手机');
  await page.submitRequest();
  const sent = requests(calls, 'submitBackfillRequest'); assert.equal(sent[0].data.requestId, sent[1].data.requestId);
  assert.equal(calls.toast.length, 1);
});

test('unmounted or different-account completions cannot mutate data or disclose the previous result', async () => {
  for (const change of ['unload', 'account']) {
    const pending = deferred(); const { page, calls, setAccount } = harness({ api: (name, data) => data.type === 'submitBackfillRequest' ? pending.promise : undefined });
    await page.onShow(); draft(page); const saving = page.submitRequest(); await flush();
    page.onUnload(); if (change === 'account') { setAccount('oz-other'); await page.onShow(); draft(page, { reason: '新用户原因' }); }
    const count = calls.updates.length;
    pending.resolve(success({ request: row() })); await saving;
    assert.equal(calls.updates.length, count); assert.equal(calls.toast.length, 0);
    if (change === 'account') { assert.equal(page.data.reason, '新用户原因'); assert.equal(calls.refreshAlerts.length, 0); }
  }
});

test('read acknowledgements only follow the visible rendered version and remain in place if acknowledgement fails', async () => {
  const { page, calls, render } = harness({ deferRender: true, api: (name, data) => data.type === 'getMyBackfillRequests'
    ? success({ requests: [row({ unreadForUser: true, status: 'rejected', reply: '请调整日期' })] }) : undefined });
  await page.onShow(); assert.equal(requests(calls, 'markBackfillRead').length, 0);
  render(); await flush();
  assert.deepEqual(requests(calls, 'markBackfillRead')[0].data.requests, [{ requestId: 'request-1', expectedUpdatedAt: row().updatedAt }]);
  assert.equal(calls.refreshAlerts.length, 1);
  await page.loadRequests(); page.onHide(); render(); await flush();
  assert.equal(requests(calls, 'markBackfillRead').length, 1);
});

test('late list responses and unseen pagination versions cannot replace or acknowledge newer data', async () => {
  const pending = deferred();
  const { page, calls } = harness({ api: (name, data, count) => data.type === 'getMyBackfillRequests'
    ? count === 1 ? success({ requests: [row()], nextCursor: 'next' }) : count === 2 ? pending.promise
      : success({ requests: [row({ _id: 'fresh' })] }) : undefined });
  await page.onShow(); const more = page.loadMoreRequests(); await page.loadRequests();
  pending.resolve(success({ requests: [row({ _id: 'stale', unreadForUser: true })], nextCursor: 'old' })); await more;
  assert.deepEqual(page.data.requests.map(item => item._id), ['fresh']); assert.equal(page.data.nextCursor, '');
  assert.equal(requests(calls, 'markBackfillRead').length, 0);
});

test('administrator approves on this page with the displayed revision and must explain a rejection', async () => {
  const { page, calls } = harness({ isAdmin: true, api: (name, data) => data.type === 'adminListBackfillRequests'
    ? success({ requests: [row()], nextCursor: '' }) : undefined });
  await page.onShow(); await page.switchTab(event({ tab: 'review' }));
  page.selectReview(event({ id: 'request-1' })); await page.reviewRequest(event({ status: 'rejected' }));
  assert.match(page.data.reviewError, /拒绝/); assert.equal(requests(calls, 'adminReviewBackfillRequest').length, 0);
  page.onReplyInput(input('  请按真实记录填写  ')); await page.reviewRequest(event({ status: 'approved' }));
  const sent = requests(calls, 'adminReviewBackfillRequest')[0].data;
  assert.equal(sent.expectedUpdatedAt, row().updatedAt); assert.equal(sent.reply, '请按真实记录填写');
  assert.equal(page.data.reviewRequest, null); assert.match(calls.toast[0].title, /已批准/);
  assert.deepEqual(calls.refreshAlerts, [{ force: true }]);
});

test('non-admins cannot fetch or review other people’s applications', async () => {
  const { page, calls } = harness(); await page.onShow();
  await page.switchTab(event({ tab: 'review' }));
  page.data.reviewRequest = row(); await page.reviewRequest(event({ status: 'approved' }));
  assert.equal(page.data.tab, 'mine'); assert.equal(requests(calls, 'adminListBackfillRequests').length, 0);
  assert.equal(requests(calls, 'adminReviewBackfillRequest').length, 0);
});

test('concurrent administrator edits report the conflict without claiming approval', async () => {
  const { page, calls } = harness({ isAdmin: true, api: (name, data) => data.type === 'adminListBackfillRequests'
    ? success({ requests: [row()] }) : data.type === 'adminReviewBackfillRequest'
      ? { success: false, code: 'CONFLICT', error: '申请已由另一位管理员处理，请刷新' } : undefined });
  await page.onShow(); await page.switchTab(event({ tab: 'review' })); page.selectReview(event({ id: 'request-1' }));
  await page.reviewRequest(event({ status: 'approved' }));
  assert.match(page.data.reviewError, /另一位管理员/); assert.equal(calls.toast.length, 0); assert.equal(calls.refreshAlerts.length, 0);
});

test('approved applications open the shared home recorder with an account-bound intent', async () => {
  const { page, calls, storage } = await dayRecords();
  page.goHomeRecord(event({ id: 'request-1' }));
  assert.deepEqual(storage.get('homeBackfillIntent'), { account: 'oz-user', requestId: 'request-1', date: '2026-09-20' });
  assert.deepEqual(calls.tabs, [{ url: '/pages/index/index' }]);
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(page.saveRecord, undefined);
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/backfill/backfill.wxml'), 'utf8');
  assert.match(template, /bindtap="goHomeRecord">去首页补录/);
  assert.doesNotMatch(template, /bindtap="saveRecord"|bindinput="onDurationInput"|bindchange="onTimeChange"/);
});

test('unapproved, expired and different-account applications cannot create a home intent', async () => {
  for (const state of ['pending', 'rejected', 'expired', 'elapsed', 'account', 'hidden']) {
    const { page, calls, clock, storage, setAccount } = await dayRecords({ row: state === 'pending' || state === 'rejected'
      ? { status: state, canRecord: false } : state === 'expired' ? { expired: true } : {} });
    if (state === 'elapsed') clock.now = Date.parse('2026-10-12T00:00:00Z');
    if (state === 'account') setAccount('oz-other');
    if (state === 'hidden') page.onHide();
    page.goHomeRecord(event({ id: 'request-1' }));
    assert.equal(storage.has('homeBackfillIntent'), false, state);
    assert.equal(calls.tabs.length, 0, state);
  }
});

test('storage or navigation failures leave no stale home intent and allow retry', async () => {
  for (const failure of ['storageError', 'navigationError']) {
    const { page, calls, storage } = await dayRecords({ [failure]: true });
    page.goHomeRecord(event({ id: 'request-1' }));
    assert.equal(storage.has('homeBackfillIntent'), false, failure);
    assert.match(calls.toast[0].title, /请重试/);
    assert.equal(calls.tabs.length, failure === 'storageError' ? 0 : 1);
  }
});

test('sync failures can be retried without creating another meditation record', async () => {
  const { page, calls } = await dayRecords({ api: (name, data, count) => data.type === 'getUserRecords'
    ? success([{ _id: 'record-1', duration: 30, backfillRequestId: 'request-1' }]) : data.type === 'syncBackfillDate' && count === 1
      ? { success: false, error: '必经暂时不可用' } : undefined });
  await page.syncDay(); assert.match(page.data.syncError, /已保存在小程序/);
  await page.syncDay(); assert.equal(page.data.syncError, ''); assert.match(page.data.syncMessage, /已同步/);
  assert.equal(requests(calls, 'recordMeditation').length, 0); assert.equal(requests(calls, 'syncBackfillDate').length, 2);
});

test('expired approved requests retain daily records and synchronize existing sessions', async () => {
  const { page, calls } = await dayRecords({ row: { expired: true, canRecord: false }, api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'previous', duration: 30, timestamp: Date.parse('2026-09-20T08:00:00+08:00'), backfillRequestId: 'request-1' }])
    : data.type === 'syncBackfillDate' ? success({ date: data.recordDate, skipped: true, reason: '未绑定' }) : undefined });
  assert.equal(page.data.selectedRequest.canRecord, false); assert.equal(page.data.canSyncDay, true);
  assert.equal(page.data.dayTotal, 30); assert.equal(page.data.dayRecords[0].timeText, '2026-09-20 08:00');
  assert.equal(page.data.dayRecords[0].isBackfill, true);
  await page.syncDay();
  assert.equal(requests(calls, 'recordMeditation').length, 0); assert.match(page.data.syncMessage, /绑定必经账号/);
});

test('date inspection rejects out-of-range dates and ignores stale daily responses', async () => {
  const pending = deferred();
  const { page, calls } = await dayRecords({ api: (name, data, count) => data.type === 'getUserRecords'
    ? count === 2 ? pending.promise : success([{ _id: data.date, duration: count }]) : undefined });
  await page.onRecordDateChange(input('2026-09-19'));
  assert.equal(requests(calls, 'getUserRecords').length, 1);
  const earlier = page.onRecordDateChange(input('2026-09-21'));
  await page.onRecordDateChange(input('2026-09-22'));
  pending.resolve(success([{ _id: 'stale', duration: 999 }])); await earlier;
  assert.equal(page.data.recordDate, '2026-09-22'); assert.equal(page.data.dayTotal, 3);
  assert.equal(page.data.dayRecords[0]._id, '2026-09-22');
});

test('returning while submission is still pending observes its result once without leaving the form locked', async () => {
  const pending = deferred();
  const { page, calls } = harness({ api: (name, data) => data.type === 'submitBackfillRequest' ? pending.promise : undefined });
  await page.onShow(); draft(page); const saving = page.submitRequest(); await flush();
  page.onHide(); await page.onShow(); assert.equal(page.data.submitting, true);
  pending.resolve(success({ request: row() })); await saving; await flush();
  assert.equal(page.data.submitting, false); assert.equal(page.data.reason, ''); assert.equal(calls.toast.length, 1);
  assert.equal(page.data.rangeDays, 0);
});

test('leaving during a submission network check prevents its old mutation', async () => {
  let callback;
  const { page, calls } = harness({ network: options => { callback = options; } });
  await page.onShow(); draft(page);
  const saving = page.submitRequest(); await flush(); page.onHide(); await page.onShow();
  callback.success({ networkType: 'wifi' }); await saving; await flush();
  assert.equal(requests(calls, 'submitBackfillRequest').length, 0); assert.equal(calls.toast.length, 0);
  assert.equal(page.data.submitting, false);
});

test('pending approvals are adopted on return but cannot update a different account', async () => {
  for (const change of ['return', 'account']) {
    const pending = deferred();
    const { page, calls, setAccount } = harness({ isAdmin: true, api: (name, data) => data.type === 'adminListBackfillRequests'
      ? success({ requests: [row()] }) : data.type === 'adminReviewBackfillRequest' ? pending.promise : undefined });
    await page.onShow(); await page.switchTab(event({ tab: 'review' })); page.selectReview(event({ id: 'request-1' }));
    const reviewing = page.reviewRequest(event({ status: 'approved' })); await flush();
    page.onHide(); if (change === 'account') setAccount('oz-other'); await page.onShow();
    const updates = calls.updates.length;
    pending.resolve(success({ request: approved() })); await reviewing; await flush();
    assert.equal(page.data.reviewing, false);
    if (change === 'return') assert.equal(calls.toast.length, 1);
    else { assert.equal(calls.updates.length, updates); assert.equal(calls.toast.length, 0); assert.equal(calls.refreshAlerts.length, 0); }
  }
});

test('recordedDates permits a historical synchronization after every recorded session for that date was deleted', async () => {
  const { page, calls } = await dayRecords({ row: { expired: true, canRecord: false, recordedDates: ['2026-09-20'] } });
  assert.equal(page.data.dayRecords.length, 0); assert.equal(page.data.canSyncDay, true);
  await page.syncDay();
  const sent = requests(calls, 'syncBackfillDate')[0].data;
  assert.equal(sent.recordDate, '2026-09-20'); assert.equal(sent.expectedOpenid, 'oz-user');
  assert.equal(requests(calls, 'recordMeditation').length, 0);
});

test('pending but expired requests cannot be approved or rejected', async () => {
  const expired = row({ expired: true, expiresAt: '2026-10-05T01:00:00Z' });
  const { page, calls } = harness({ isAdmin: true, api: (name, data) => data.type === 'adminListBackfillRequests'
    ? success({ requests: [expired] }) : undefined });
  await page.onShow(); await page.switchTab(event({ tab: 'review' })); page.selectReview(event({ id: expired._id }));
  assert.equal(page.data.reviewRequest, null);
  page.data.reviewRequest = expired; page.onReplyInput(input('已过期'));
  await page.reviewRequest(event({ status: 'rejected' })); await page.reviewRequest(event({ status: 'approved' }));
  assert.match(page.data.reviewError, /不能继续审批/); assert.equal(requests(calls, 'adminReviewBackfillRequest').length, 0);
});

test('opening the administrator tab never acknowledges hidden personal approval results', async () => {
  const pending = deferred();
  const { page, calls } = harness({ isAdmin: true, api: (name, data) => data.type === 'getAccess' ? pending.promise
    : data.type === 'getMyBackfillRequests' ? success({ requests: [approved({ unreadForUser: true })] }) : undefined });
  page.onLoad({ tab: 'review' }); const opening = page.onShow(); await flush();
  assert.equal(requests(calls, 'markBackfillRead').length, 0);
  pending.resolve(success({ isAdmin: true })); await opening;
  assert.equal(page.data.tab, 'review'); assert.equal(requests(calls, 'markBackfillRead').length, 0);
  await page.switchTab(event({ tab: 'mine' })); await flush();
  assert.equal(requests(calls, 'markBackfillRead').length, 1);
});


test('shared synchronization state follows the selected day and clears when records close', async () => {
  const { page, publishTask, syncListeners } = await dayRecords({ api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'record-1', duration: 30 }]) : undefined });
  publishTask({ date: '2026-09-20', recordId: 'record-1', status: 'failed', message: '稍后重试', canRetry: true });
  assert.equal(page.data.bijingTaskText, '稍后重试'); assert.equal(page.data.bijingCanRetry, true);
  publishTask({ date: '2026-09-20', status: 'synced', message: '其他账号', canRetry: false }, 'oz-other');
  assert.equal(page.data.bijingTaskText, '稍后重试');
  await page.onRecordDateChange(input('2026-09-21'));
  assert.equal(page.data.bijingTaskText, ''); assert.equal(page.data.bijingCanRetry, false);
  publishTask({ date: '2026-09-21', status: 'syncing', message: '正在同步', canRetry: false });
  assert.equal(page.data.bijingSyncing, true);
  page.closeDayRecords(); assert.equal(page.data.bijingTaskText, ''); assert.equal(page.data.bijingSyncing, false);
  page.onHide(); assert.equal(syncListeners.size, 0);
});

test('existing shared sync tasks retry through the service without sending a second direct sync', async () => {
  const { page, calls, publishTask } = await dayRecords({ api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'record-1', duration: 30 }]) : undefined });
  publishTask({ date: '2026-09-20', recordId: 'record-1', status: 'failed', message: '稍后重试', canRetry: true });
  await page.syncDay();
  assert.deepEqual(calls.serviceRetry, ['2026-09-20']); assert.equal(requests(calls, 'syncBackfillDate').length, 0);
  assert.equal(page.data.bijingTaskStatus, 'synced'); assert.equal(page.data.bijingCanRetry, false);
  await page.syncDay(); assert.equal(calls.serviceRetry.length, 1);
});


test('deleting the last record can synchronize zero despite an old completed or failed shared task', async () => {
  for (const status of ['synced', 'failed']) {
    const { page, calls, publishTask } = await dayRecords({ row: { expired: true, canRecord: false, recordedDates: ['2026-09-20'] },
      api: (name, data) => data.type === 'syncBackfillDate' ? success({ success: true, duration: 0 }) : undefined });
    publishTask({ date: '2026-09-20', recordId: 'deleted-record', status, message: '上次同步状态', canRetry: status === 'failed' });
    assert.equal(page.data.dayRecords.length, 0); assert.equal(page.data.canSyncDay, true);
    assert.equal(page.data.bijingCanRetry, false); assert.match(page.data.bijingTaskText, /记录已变更/);
    await page.syncDay();
    assert.equal(calls.serviceRetry.length, 0, status);
    assert.equal(requests(calls, 'syncBackfillDate').length, 1, status);
    assert.match(page.data.syncMessage, /已同步/); assert.equal(page.data.bijingTaskText, '');
  }
});

test('completed shared tasks keep an approved-date path for corrected day totals', async () => {
  let duration = 45;
  const { page, calls, publishTask } = await dayRecords({ api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'record-1', duration, backfillRequestId: 'request-1' }]) : undefined });
  publishTask({ date: '2026-09-20', recordId: 'record-1', status: 'synced', message: '当天记录已同步', canRetry: false });
  await page.syncDay(); assert.equal(requests(calls, 'syncBackfillDate').length, 1);
  assert.equal(calls.serviceRetry.length, 0); assert.match(page.data.syncMessage, /已同步/);
  duration = 15; await page.loadDayRecords();
  assert.equal(page.data.dayTotal, 15); assert.equal(page.data.syncMessage, '');
  await page.syncApprovedDay(); assert.equal(requests(calls, 'syncBackfillDate').length, 2);
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/backfill/backfill.wxml'), 'utf8');
  assert.match(template, /wx:if="\{\{canSyncDay\}\}"[^>]*bindtap="syncApprovedDay"/);
});

test('approved-day synchronization waits for daily data and never races a busy shared task', async () => {
  for (const status of ['pending', 'syncing']) {
    const { page, calls, publishTask } = await dayRecords({ row: { recordedDates: ['2026-09-20'] } });
    publishTask({ date: '2026-09-20', recordId: 'deleted-record', status, canRetry: true });
    await page.syncDay(); await page.syncApprovedDay();
    assert.equal(calls.serviceRetry.length, 0); assert.equal(requests(calls, 'syncBackfillDate').length, 0);
    assert.equal(page.data.bijingSyncing, true);
  }
  let network;
  const { page, calls, publishTask } = await dayRecords({ row: { recordedDates: ['2026-09-20'] }, network: options => { network = options; } });
  const syncing = page.syncApprovedDay(); await flush();
  publishTask({ date: '2026-09-20', recordId: 'new-record', status: 'syncing', canRetry: false });
  network.success({ networkType: 'wifi' }); await syncing;
  assert.equal(requests(calls, 'syncBackfillDate').length, 0); assert.equal(page.data.bijingSyncing, true);
  publishTask({ date: '2026-09-20', recordId: 'new-record', status: 'synced', canRetry: false });
  page.data.dayLoaded = false; await page.syncApprovedDay();
  assert.equal(requests(calls, 'syncBackfillDate').length, 0);
});
