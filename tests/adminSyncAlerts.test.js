const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function cloudHarness({ openid, records = [], fail = false } = {}) {
  const exports = {};
  const reads = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: { ADMIN_OPENID: 'admin', MAINTENANCE_ADMIN_OPENIDS: 'maintenance' } },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      return { init() {}, getWXContext() { return { OPENID: openid }; }, database() {
        reads.push('database');
        return { collection(name) { reads.push(name); return { limit(size) {
          reads.push(size); return { async get() { if (fail) throw new Error('sensitive database detail'); return { data: records }; } };
        } }; } };
      } };
    }
  });
  return { reads, async read(event = {}) { return JSON.parse(JSON.stringify(await exports.main({ type: 'getSyncAlert', ...event }))); } };
}

test('ordinary and maintenance users never query sync errors or acquire alerts by forging an administrator', async () => {
  for (const openid of ['ordinary', 'maintenance', '', undefined]) {
    const cloud = cloudHarness({ openid, records: [{ studentNumber: 'secret' }] });
    assert.deepEqual(await cloud.read({ OPENID: 'admin', isAdmin: true }), { success: true, data: { isAdmin: false, hasErrors: false } });
    assert.deepEqual(cloud.reads, []);
  }
});

test('the designated administrator only receives an existence flag from a one-row query', async () => {
  for (const records of [[], [{ studentNumber: 'secret', recordDate: '2026-09-22' }]]) {
    const cloud = cloudHarness({ openid: 'admin', records });
    assert.deepEqual(await cloud.read(), { success: true, data: { isAdmin: true, hasErrors: records.length > 0 } });
    assert.deepEqual(cloud.reads, ['database', 'bijing_sync_errors', 1]);
  }
  const failed = await cloudHarness({ openid: 'admin', fail: true }).read();
  assert.equal(failed.success, false);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
});

function appHarness() {
  let definition;
  let identity = 'admin';
  let id = 0;
  const requests = [];
  const dots = [];
  const timers = new Map();
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    App(value) { definition = value; },
    require() { return { async syncWithCloud() {}, async retryTodayBackups() {} }; },
    wx: {
      cloud: { callFunction(request) { requests.push(request); } },
      getStorageSync() { return identity; },
      showTabBarRedDot(value) { assert.equal(value.index, 3); dots.push(true); },
      hideTabBarRedDot(value) { assert.equal(value.index, 3); dots.push(false); }
    },
    console,
    setTimeout(callback, delay) { const handle = ++id; timers.set(handle, { callback, delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); }
  });
  const app = { ...definition };
  return { app, requests, dots, timers,
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
