const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');

function cloudHarness({ openid, records = [], feedback = [], fail = false, syncError, feedbackError,
  invalidSyncResponse = false, invalidFeedbackResponse = false, environment = {}, ...options } = {}) {
  const exports = {};
  const reads = [];
  const authorization = createStudentAuthDatabase(options);
  const db = {
    ...authorization.db,
    command: { in: values => ({ in: values }) },
    collection(name) {
      if (!['bijing_sync_errors', 'feedback'].includes(name)) return authorization.db.collection(name);
      reads.push('database', name);
      let limit, filter, fields;
      return {
        where(value) { filter = value; reads.push(JSON.parse(JSON.stringify(value))); return this; },
        field(value) { fields = JSON.parse(JSON.stringify(value)); return this; },
        limit(size) { limit = size; reads.push(size); return this; },
        async get() {
          assert.deepEqual(fields, { _id: true }, 'existence queries do not load feedback text or private sync details');
          const error = name === 'feedback' ? feedbackError : syncError || (fail && new Error('sensitive database detail'));
          if (error) throw error;
          if (name === 'feedback' ? invalidFeedbackResponse : invalidSyncResponse) return {};
          const rows = name === 'feedback' ? feedback.filter(row => filter.status.in.includes(row.status)) : records;
          return { data: rows.slice(0, limit) };
        }
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: { ADMIN_STUDENT_NUMBERS: 'BJ0099', MAINTENANCE_ADMIN_OPENIDS: 'maintenance', ...environment } },
    require(name) {
      if (name === './studentAuth') return require('../cloudfunctions/adminManager/studentAuth');
      if (name === './delegation') return require('../cloudfunctions/adminManager/delegation');
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, getWXContext() { return { OPENID: openid }; }, database() { return db; } };
    }
  });
  return { reads, authReads: authorization.reads, authUsers: authorization.users,
    async read(event = {}) { return JSON.parse(JSON.stringify(await exports.main({ type: 'getSyncAlert', ...event }))); } };
}

const bothAlertReads = () => ['database', 'bijing_sync_errors', 1, 'database', 'feedback', { status: { in: ['pending', 'processing'] } }, 1];

test('ordinary and maintenance users never query sync errors or feedback by forging an administrator', async () => {
  for (const openid of ['ordinary', 'maintenance', '', undefined]) {
    const cloud = cloudHarness({ openid, records: [{ studentNumber: 'secret' }], feedback: [{ status: 'pending', content: 'secret' }] });
    assert.deepEqual(await cloud.read({ OPENID: 'admin', isAdmin: true }), { success: true, data: { isAdmin: false, hasErrors: false } });
    assert.deepEqual(cloud.reads, []);
  }
});

test('sync alerts admit a second configured student number and hide errors from other accounts', async () => {
  const environment = { ADMIN_STUDENT_NUMBERS: 'BJ0001,BJ0002' };
  const records = [{ studentNumber: 'secret', recordDate: '2026-09-22' }];
  const authorized = cloudHarness({ openid: 'second-admin', environment, records });
  assert.deepEqual(await authorized.read(), { success: true, data: { isAdmin: true, hasErrors: true, hasFeedback: false } });
  assert.deepEqual(authorized.reads, bothAlertReads());
  for (const openid of ['outsider', 'admin', 'maintenance', 'second-admin-extra', undefined]) {
    const denied = cloudHarness({ openid, environment, records });
    assert.deepEqual(await denied.read({ OPENID: 'second-admin', ADMIN_OPENIDS: 'outsider', isAdmin: true }),
      { success: true, data: { isAdmin: false, hasErrors: false } });
    assert.deepEqual(denied.reads, []);
  }
});

test('the designated administrator only receives existence flags from one-row queries', async () => {
  for (const records of [[], [{ studentNumber: 'secret', recordDate: '2026-09-22' }]]) {
    const cloud = cloudHarness({ openid: 'admin', records });
    assert.deepEqual(await cloud.read(), { success: true, data: { isAdmin: true, hasErrors: records.length > 0, hasFeedback: false } });
    assert.deepEqual(cloud.reads, bothAlertReads());
  }
  const failed = await cloudHarness({ openid: 'admin', fail: true }).read();
  assert.equal(failed.success, false);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
});

test('unbinding clears administrator alerts without another error-collection read', async () => {
  const cloud = cloudHarness({ openid: 'admin', records: [{ studentNumber: 'secret' }] });
  assert.deepEqual(await cloud.read(), { success: true, data: { isAdmin: true, hasErrors: true, hasFeedback: false } });
  cloud.authUsers.find(user => user._openid === 'admin').bijingBound = false;
  const before = cloud.reads.length;
  assert.deepEqual(await cloud.read({ studentNumber: 'BJ0099', bijingBound: true }),
    { success: true, data: { isAdmin: false, hasErrors: false } });
  assert.equal(cloud.reads.length, before);
});

test('authorization database failure hides synchronization alerts and its private cause', async () => {
  const cloud = cloudHarness({ openid: 'admin', authDatabaseError: new Error('private authorization connection') });
  assert.deepEqual(await cloud.read(), { success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试' });
  assert.deepEqual(cloud.reads, []);
});

test('feedback alerts include pending and processing across users while resolved feedback clears the flag', async () => {
  for (const status of ['pending', 'processing', 'resolved']) {
    const cloud = cloudHarness({ openid: 'admin', feedback: [{ status, ownerOpenid: 'other', content: 'private feedback' }] });
    assert.deepEqual(await cloud.read({ status: 'resolved', ownerOpenid: 'admin' }),
      { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: status !== 'resolved' } });
    assert.deepEqual(cloud.reads, bothAlertReads());
  }
  const mixed = cloudHarness({ openid: 'admin', records: [{ privateError: 'secret' }],
    feedback: [{ status: 'resolved' }, { status: 'processing', content: 'secret' }] });
  assert.deepEqual(await mixed.read(), { success: true, data: { isAdmin: true, hasErrors: true, hasFeedback: true } });
});

test('feedback collection absence is an empty source without masking existing sync alerts', async () => {
  const feedbackError = Object.assign(new Error('collection feedback does not exist'), { errCode: -502005 });
  for (const records of [[], [{ error: 'private' }]]) {
    const cloud = cloudHarness({ openid: 'admin', records, feedbackError });
    assert.deepEqual(await cloud.read(), { success: true, data: { isAdmin: true, hasErrors: records.length > 0, hasFeedback: false } });
  }
  const syncError = { code: 'DATABASE_COLLECTION_NOT_EXIST' };
  const bothMissing = cloudHarness({ openid: 'admin', syncError, feedbackError });
  assert.deepEqual(await bothMissing.read(), { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: false } });
});

test('a failed alert source cannot suppress a positive result from the other source', async () => {
  for (const sourceFailure of [new Error('sensitive network detail'),
    Object.assign(new Error('permission denied'), { errCode: -502001 })]) {
    const feedbackOnly = cloudHarness({ openid: 'admin', syncError: sourceFailure, feedback: [{ status: 'pending', content: 'secret' }] });
    assert.deepEqual(await feedbackOnly.read(), { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: true } });
    const syncOnly = cloudHarness({ openid: 'admin', records: [{ error: 'secret' }], feedbackError: sourceFailure });
    assert.deepEqual(await syncOnly.read(), { success: true, data: { isAdmin: true, hasErrors: true, hasFeedback: false } });
  }
  const malformedSync = cloudHarness({ openid: 'admin', invalidSyncResponse: true, feedback: [{ status: 'processing' }] });
  assert.deepEqual(await malformedSync.read(), { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: true } });
});

test('an actual source failure without any confirmed alert fails safely instead of reporting all clear', async () => {
  for (const options of [{ syncError: new Error('private detail') }, { feedbackError: new Error('private detail') },
    { syncError: new Error('private detail'), feedbackError: new Error('private detail') },
    { invalidSyncResponse: true }, { invalidFeedbackResponse: true },
    { feedbackError: { errCode: -502001 }, feedback: [{ status: 'resolved' }] },
    { syncError: new Error('private detail'), feedbackError: { code: 'DATABASE_COLLECTION_NOT_EXIST' } }]) {
    const cloud = cloudHarness({ openid: 'admin', ...options });
    const result = await cloud.read();
    assert.equal(result.success, false); assert.equal(result.data, undefined);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.deepEqual(cloud.reads, bothAlertReads());
  }
});

function appHarness({ manualFeedback = false, tabReady = true } = {}) {
  let definition;
  let identity = 'admin';
  let id = 0;
  const requests = [];
  const feedbackRequests = [];
  const dots = [];
  const timers = new Map();
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    App(value) { definition = value; },
    require() { return { async syncWithCloud() {}, async retryTodayBackups() {} }; },
    wx: {
      cloud: { callFunction(request) {
        if (request.name === 'meditationManager') {
          assert.equal(request.data.type, 'getFeedbackAlert');
          feedbackRequests.push(request);
          if (!manualFeedback) request.success({ result: { success: true, data: { hasUnreadFeedback: false } } });
        } else requests.push(request);
      } },
      getStorageSync() { return identity; },
      showTabBarRedDot(value) {
        assert.equal(value.index, 3);
        if (tabReady) dots.push(true);
        else value.fail(new Error('tabbar not ready'));
      },
      hideTabBarRedDot(value) { assert.equal(value.index, 3); dots.push(false); }
    },
    console,
    setTimeout(callback, delay) { const handle = ++id; timers.set(handle, { callback, delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); }
  });
  const app = { ...definition };
  return { app, requests, feedbackRequests, dots, timers,
    ready() { tabReady = true; },
    identity(value) { identity = value; },
    async reply(index, data) {
      const pending = app._syncAlertRequest;
      requests[index].success({ result: { success: true, data } });
      if (pending) await pending;
    },
    runTimer(delay) {
      const [handle, timer] = [...timers.entries()].find(([, timer]) => timer.delay === delay) || [];
      assert.ok(timer, `expected ${delay} ms timer`);
      timers.delete(handle);
      timer.callback();
    }
  };
}

test('each app opening checks alerts once without polling and reflects recovery or revoked authorization', async () => {
  const { app, requests, dots, timers, reply } = appHarness();
  await app.onShow();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'adminManager');
  assert.equal(requests[0].data.type, 'getSyncAlert');
  await reply(0, { isAdmin: true, hasErrors: true });
  assert.equal(dots.at(-1), true);
  assert.equal(timers.size, 0, 'a completed check schedules no foreground polling');
  app.onHide();
  await app.onShow();
  assert.equal(requests.length, 2);
  await reply(1, { isAdmin: true, hasErrors: false });
  assert.equal(dots.at(-1), false);
  assert.equal(timers.size, 0);
  app.onHide();
  await app.onShow();
  assert.equal(requests.length, 3);
  await reply(2, { isAdmin: false, hasErrors: true });
  assert.equal(dots.at(-1), false);
  app.onHide();
  assert.equal(timers.size, 0);
  assert.equal(requests.length, 3);
});

test('repeated foreground notifications reuse the opening check even after completion or failure', async () => {
  for (const result of ['success', 'failure', 'timeout']) {
    const { app, requests, feedbackRequests, dots, timers, reply, runTimer } = appHarness();
    await app.onShow();
    const pending = app._syncAlertRequest;
    await app.onShow();
    assert.equal(app._syncAlertRequest, pending);
    assert.equal(requests.length, 1);
    assert.equal(feedbackRequests.length, 1);
    if (result === 'success') await reply(0, { isAdmin: true, hasFeedback: true });
    else {
      if (result === 'failure') requests[0].fail(new Error('offline'));
      else runTimer(10000);
      await pending;
    }
    for (let visit = 0; visit < 5; visit++) await app.onShow();
    assert.equal(requests.length, 1, result);
    assert.equal(feedbackRequests.length, 1, result);
    assert.equal(dots.at(-1), result === 'success');
    assert.equal(timers.size, 0, 'neither polling nor a retry timer is retained');
    app.onHide();
    await app.onShow();
    assert.equal(requests.length, 2, 'returning from the background starts the next opening check');
    assert.equal(feedbackRequests.length, 2);
    app.onHide();
  }
});

test('feedback-only and combined alerts use the existing red dot and resolved feedback clears it on reopening', async () => {
  const { app, requests, dots, timers, reply } = appHarness();
  for (const [data, expected] of [
    [{ isAdmin: true, hasErrors: false, hasFeedback: true }, true],
    [{ isAdmin: true, hasErrors: true, hasFeedback: true }, true],
    [{ isAdmin: true, hasErrors: false, hasFeedback: false }, false],
    [{ isAdmin: false, hasErrors: false, hasFeedback: true }, false],
    [{ isAdmin: false, hasErrors: true, hasFeedback: true }, false],
    [{ isAdmin: true, hasErrors: false, hasFeedback: 'true' }, false]
  ]) {
    await app.onShow();
    const count = requests.length;
    await reply(count - 1, data);
    assert.equal(dots.at(-1), expected);
    assert.equal(requests.length, count); assert.equal(timers.size, 0, 'feedback never adds polling');
    app.onHide();
  }
  assert.equal(requests.length, 6, 'one existing alert check per opening');
});

test('hiding cancels the in-flight alert and late responses never restore its red dot', async () => {
  const { app, requests, dots, timers } = appHarness();
  await app.onShow();
  const pending = app._syncAlertRequest;
  app.onHide();
  await pending;
  assert.equal(timers.size, 0);
  await app.onShow();
  assert.equal(requests.length, 2, 'returning to the foreground revalidates server identity');
  requests[0].success({ result: { success: true, data: { isAdmin: true, hasErrors: true } } });
  await pending;
  assert.equal(dots.includes(true), false);
  app.onHide();
  assert.equal(timers.size, 0);
});

test('account changes discard the previous account response without issuing another alert check', async () => {
  const { app, requests, dots, timers, reply, identity } = appHarness();
  await app.onShow();
  identity('ordinary');
  await reply(0, { isAdmin: true, hasErrors: true });
  assert.equal(dots.includes(true), false);
  assert.equal(dots.at(-1), false);
  assert.equal(requests.length, 1);
  assert.equal(timers.size, 0);
  app.onHide();
  await app.onShow();
  assert.equal(requests.length, 2);
  await reply(1, { isAdmin: false, hasErrors: false });
  assert.equal(dots.at(-1), false);
  app.onHide();
});

test('stale feedback flags after hiding or an account switch cannot restore an administrator red dot', async () => {
  const { app, requests, dots, timers, identity, reply } = appHarness();
  await app.onShow();
  const hiddenRequest = app._syncAlertRequest;
  app.onHide();
  await hiddenRequest;
  await app.onShow();
  requests[0].success({ result: { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: true } } });
  assert.equal(dots.includes(true), false);
  identity('ordinary');
  await reply(1, { isAdmin: true, hasErrors: false, hasFeedback: true });
  assert.equal(dots.includes(true), false); assert.equal(dots.at(-1), false);
  assert.equal(requests.length, 2); assert.equal(timers.size, 0);
  app.onHide();
});

test('a timed out feedback alert response remains discarded without adding retries', async () => {
  const { app, requests, dots, timers, runTimer } = appHarness();
  await app.onShow();
  const pending = app._syncAlertRequest;
  runTimer(10000);
  await pending;
  requests[0].success({ result: { success: true, data: { isAdmin: true, hasErrors: false, hasFeedback: true } } });
  assert.equal(dots.includes(true), false); assert.equal(dots.at(-1), false);
  assert.equal(requests.length, 1); assert.equal(timers.size, 0);
  app.onHide();
});

test('failed or stalled alert requests clear red dots and retry only on the next app opening', async () => {
  const { app, dots, reply, requests, runTimer, timers } = appHarness();
  await app.onShow();
  await reply(0, { isAdmin: true, hasErrors: true });
  app.onHide();
  await app.onShow();
  const stalled = app._syncAlertRequest;
  runTimer(10000);
  await stalled;
  assert.equal(dots.at(-1), false);
  assert.equal(timers.size, 0, 'timeouts schedule no retry');
  assert.equal(requests.length, 2);
  requests[1].success({ result: { success: true, data: { isAdmin: true, hasErrors: true } } });
  await stalled;
  assert.equal(dots.at(-1), false, 'a response after timeout cannot restore the red dot');
  app.onHide();
  await app.onShow();
  assert.equal(requests.length, 3);
  const failing = app._syncAlertRequest;
  requests[2].fail(new Error('offline'));
  await failing;
  assert.equal(dots.at(-1), false);
  assert.equal(timers.size, 0, 'failed requests schedule no retry');
  assert.equal(requests.length, 3);
  app.onHide();
  await app.onShow();
  assert.equal(requests.length, 4);
  await reply(3, { isAdmin: true, hasErrors: true });
  assert.equal(dots.at(-1), true);
  assert.equal(timers.size, 0);
  app.onHide();
});

test('sync-alert endpoint never accepts delegation-shaped event fields as the caller identity', async () => {
  const cloud = cloudHarness({ records: [{ studentNumber: 'secret' }] });
  assert.deepEqual(await cloud.read({ expectedOpenid: 'admin', delegationId: `auth_${'0'.repeat(64)}`, SOURCE: 'wx_client,scf' }),
    { success: true, data: { isAdmin: false, hasErrors: false } });
  assert.deepEqual(cloud.reads, []);
});

const flushAlerts = () => new Promise(resolve => setImmediate(resolve));
const alertResponse = (request, data) => request.success({ result: { success: true, data } });

test('ordinary users see unread handling results without administrator access', async () => {
  const { app, requests, feedbackRequests, dots, timers, identity } = appHarness({ manualFeedback: true });
  identity('ordinary');
  await app.onShow();
  const pending = app._syncAlertRequest;
  alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
  await flushAlerts();
  assert.equal(dots.at(-1), true, 'personal result appears before the admin probe finishes');
  alertResponse(requests[0], { isAdmin: false, hasErrors: false });
  await pending;
  assert.equal(dots.at(-1), true);
  assert.equal(timers.size, 0);
  assert.equal(feedbackRequests.length, 1);
  app.onHide();
});

test('one failed or stalled source cannot erase the other confirmed reminder', async () => {
  for (const positiveSource of ['admin', 'user']) {
    for (const failure of ['error', 'timeout', 'malformed']) {
      const { app, requests, feedbackRequests, dots, timers, runTimer } = appHarness({ manualFeedback: true });
      await app.onShow();
      const pending = app._syncAlertRequest;
      const positive = positiveSource === 'admin' ? requests[0] : feedbackRequests[0];
      const failed = positiveSource === 'admin' ? feedbackRequests[0] : requests[0];
      alertResponse(positive, positiveSource === 'admin' ? { isAdmin: true, hasFeedback: true } : { hasUnreadFeedback: true });
      await flushAlerts();
      assert.equal(dots.at(-1), true);
      if (failure === 'error') failed.fail(new Error('offline'));
      else if (failure === 'malformed') failed.success({ result: { success: false } });
      else runTimer(10000);
      await pending;
      assert.equal(dots.at(-1), true, `${positiveSource}/${failure}`);
      assert.equal(timers.size, 0);
      app.onHide();
    }
  }
});

test('revoking administrator access retains personal unread results and their in-flight query', async () => {
  for (const personalFinishesFirst of [true, false]) {
    const { app, requests, feedbackRequests, dots } = appHarness({ manualFeedback: true });
    await app.onShow();
    const pending = app._syncAlertRequest;
    if (personalFinishesFirst) {
      alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
      await flushAlerts();
    }
    app.clearAdminSyncAlert();
    alertResponse(requests[0], { isAdmin: true, hasFeedback: true });
    if (!personalFinishesFirst) alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
    await pending;
    assert.equal(app._syncAlertState.admin, false, 'stale admin authorization cannot be restored');
    assert.equal(dots.at(-1), true);
    app.onHide();
  }
});

test('forced refresh after handling or reading ignores both pre-mutation snapshots', async () => {
  const { app, requests, feedbackRequests, dots, timers } = appHarness({ manualFeedback: true });
  await app.onShow();
  const stale = app._syncAlertRequest;
  assert.equal(app.refreshSyncAlert(), stale, 'ordinary overlapping probes still deduplicate');
  const latest = app.refreshSyncAlert({ force: true });
  assert.notEqual(latest, stale);
  await stale;
  alertResponse(requests[1], { isAdmin: true, hasFeedback: false });
  alertResponse(feedbackRequests[1], { hasUnreadFeedback: false });
  await latest;
  alertResponse(requests[0], { isAdmin: true, hasFeedback: true });
  alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
  await flushAlerts();
  assert.equal(dots.at(-1), false);
  assert.equal(dots.includes(true), false);
  assert.equal(timers.size, 0);
  app.onHide();
});

test('an unread acknowledgement keeps the red dot when administrator work remains', async () => {
  const { app, requests, feedbackRequests, dots } = appHarness({ manualFeedback: true });
  await app.onShow();
  const pending = app._syncAlertRequest;
  alertResponse(requests[0], { isAdmin: true, hasErrors: true });
  alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
  await pending;
  const read = app.refreshSyncAlert({ force: true });
  alertResponse(requests[1], { isAdmin: true, hasErrors: true });
  alertResponse(feedbackRequests[1], { hasUnreadFeedback: false });
  await read;
  assert.equal(dots.at(-1), true);
  app.onHide();
});

test('personal results arriving after hiding, switching account or timing out cannot restore the dot', async () => {
  for (const invalidate of ['hide', 'account', 'timeout']) {
    const { app, requests, feedbackRequests, dots, timers, identity, runTimer } = appHarness({ manualFeedback: true });
    await app.onShow();
    const pending = app._syncAlertRequest;
    alertResponse(requests[0], { isAdmin: false });
    await flushAlerts();
    if (invalidate === 'hide') app.onHide();
    else if (invalidate === 'account') identity('other');
    else runTimer(10000);
    alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
    await pending;
    app.applySyncAlertDot();
    assert.equal(dots.includes(true), false, invalidate);
    assert.equal(timers.size, 0);
    app.onHide();
  }
});

test('a cached reminder can be applied once the tabbar becomes ready without extra cloud calls', async () => {
  const { app, requests, feedbackRequests, dots, ready } = appHarness({ manualFeedback: true, tabReady: false });
  await app.onShow();
  const pending = app._syncAlertRequest;
  alertResponse(requests[0], { isAdmin: false });
  alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
  await pending;
  assert.equal(dots.includes(true), false);
  ready();
  app.applySyncAlertDot();
  assert.equal(dots.at(-1), true);
  assert.equal(requests.length, 1);
  assert.equal(feedbackRequests.length, 1);
  app.onHide();
});

test('same-account refresh failures retain a known unread result until a successful read clears it', async () => {
  const { app, requests, feedbackRequests, dots } = appHarness({ manualFeedback: true });
  await app.onShow();
  const first = app._syncAlertRequest;
  alertResponse(requests[0], { isAdmin: false });
  alertResponse(feedbackRequests[0], { hasUnreadFeedback: true });
  await first;
  const failed = app.refreshSyncAlert({ force: true });
  assert.equal(dots.at(-1), true, 'starting another check does not hide known unread results');
  alertResponse(requests[1], { isAdmin: false });
  feedbackRequests[1].fail(new Error('offline'));
  await failed;
  assert.equal(dots.at(-1), true);
  const read = app.refreshSyncAlert({ force: true });
  alertResponse(requests[2], { isAdmin: false });
  alertResponse(feedbackRequests[2], { hasUnreadFeedback: false });
  await read;
  assert.equal(dots.at(-1), false);
  app.onHide();
});
