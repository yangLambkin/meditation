const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({ cloud = true } = {}) {
  let app;
  const calls = { modules: [], factories: [], events: [], records: [] };
  const recordResult = { success: true };
  const api = cloud ? { cloud: { init() {} } } : {};
  api.getStorageSync = () => undefined;
  const controller = {
    appHide() {
      calls.events.push({ type: 'timer-hide', foreground: runtime._timerForeground });
    },
    appShow() {
      calls.events.push({ type: 'timer-show', foreground: runtime._timerForeground });
    },
    attach() { throw new Error('App must not restore a page checkpoint'); }
  };
  const filename = path.join(__dirname, '../miniprogram/app.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    App(value) { app = value; },
    wx: api,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      calls.modules.push(name);
      if (name === './modules/timer/index') return { createTimerModule: () => runtime };
      if (name === './utils/practiceMirror.js') return { resume: async () => ({ pending: 0 }) };
      if (name === './utils/checkin.js') return {
        recordCheckin(...args) { calls.records.push(args); return recordResult; }
      };
      throw new Error(`Unexpected host dependency: ${name}`);
    }
  }, { filename });
  const host = app;
  const runtimeModule = { exports: {} };
  const runtimePath = path.join(__dirname, '../miniprogram/modules/timer/runtime.js');
  vm.runInNewContext(fs.readFileSync(runtimePath, 'utf8'), {
    module: runtimeModule, console: { log() {}, warn() {}, error() {} },
    require(name) {
      calls.modules.push(name);
      if (name === './interruption') return require('../miniprogram/modules/timer/interruption');
      assert.equal(name, './countdownSession');
      return { createCountdownSessionController(options) {
        calls.factories.push(options);
        return controller;
      } };
    }
  }, { filename: runtimePath });
  const runtime = runtimeModule.exports.createRuntime({ api, host,
    recordCheckin(...args) { calls.records.push(args); return recordResult; } });
  for (const method of ['setupRecordRefresh', 'setupCacheStatus', 'testCloudEnvironment', 'setAudioOptions']) {
    app[method] = () => {};
  }
  app.startSyncAlertRefresh = () => calls.events.push({ type: 'alerts-show' });
  app.refreshRecordBackups = async () => {};
  app.resumeRecordBackups = async () => {};
  app.clearSyncAlert = () => calls.events.push({ type: 'alerts-hide' });
  return { app, runtime, api, controller, calls, recordResult };
}

test('app lifecycle does not load or construct the countdown controller until requested', async () => {
  const { app, runtime, calls } = createApp();
  app.onLaunch();
  await app.onShow();
  app.onHide({ reason: 0 });
  assert.equal(calls.modules[0], './utils/checkin.js');
  assert.equal(calls.modules.includes('./countdownSession'), false);
  assert.equal(calls.factories.length, 0);
});

test('the app retains one controller and forwards recording through the existing check-in manager', () => {
  const { app, runtime, api, controller, calls, recordResult } = createApp();
  app.onLaunch();
  assert.equal(runtime.getCountdownSession(), controller);
  assert.equal(runtime.getCountdownSession(), controller);
  assert.equal(calls.factories.length, 1);
  assert.equal(calls.factories[0].api, api);
  const args = [2, [], [], 123456, 'timer_one'];
  assert.equal(calls.factories[0].recordCheckin(...args), recordResult);
  assert.deepEqual(calls.records, [args]);
  assert.deepEqual(calls.events, []);
});

test('launch and show track the foreground even when cloud capability is unavailable', () => {
  const { app, runtime, calls } = createApp({ cloud: false });
  app.onLaunch();
  assert.equal(runtime._timerForeground, true);
  runtime.getCountdownSession();
  app.onHide({ reason: 0 });
  app.onShow();
  assert.equal(runtime._timerForeground, true);
  assert.deepEqual(calls.events, [
    { type: 'timer-hide', foreground: false },
    { type: 'alerts-hide' },
    { type: 'timer-show', foreground: true }
  ]);
});

test('hiding without a timer page notifies the retained controller before reminder cleanup', () => {
  const { app, runtime, calls } = createApp();
  app.onLaunch();
  runtime.getCountdownSession();
  app._syncAlertVisible = true;
  app.onHide({ reason: 0 });
  assert.equal(runtime._timerForeground, false);
  assert.equal(app._syncAlertVisible, false);
  assert.deepEqual(calls.events, [
    { type: 'timer-hide', foreground: false },
    { type: 'alerts-hide' }
  ]);
});

test('a controller first requested in the background is marked hidden without restoring a checkpoint', async () => {
  const { app, runtime, calls } = createApp();
  app.onLaunch();
  app.onHide({ reason: 0 });
  calls.events.length = 0;
  runtime.getCountdownSession();
  runtime.getCountdownSession();
  assert.equal(calls.factories.length, 1);
  assert.deepEqual(calls.events, [{ type: 'timer-hide', foreground: false }]);
  assert.deepEqual(calls.records, []);
  await app.onShow();
  assert.deepEqual(calls.events.slice(1), [
    { type: 'timer-show', foreground: true },
    { type: 'alerts-show' }
  ]);
});

test('repeated hide and show keep the same controller and notify it before reminder work', async () => {
  const { app, runtime, controller, calls } = createApp();
  app.onLaunch();
  runtime.getCountdownSession();
  app.onHide({ reason: 0 });
  app.onHide({ reason: 0 });
  await app.onShow();
  await app.onShow();
  assert.equal(runtime.getCountdownSession(), controller);
  assert.equal(calls.factories.length, 1);
  assert.deepEqual(calls.events.map(event => event.type), [
    'timer-hide', 'alerts-hide', 'timer-hide', 'alerts-hide',
    'timer-show', 'alerts-show', 'timer-show', 'alerts-show'
  ]);
});

test('reminder cleanup failures cannot prevent countdown exit processing', () => {
  const { app, runtime, calls } = createApp();
  app.onLaunch();
  runtime.getCountdownSession();
  app.clearSyncAlert = () => { throw new Error('alert cleanup failed'); };
  assert.throws(() => app.onHide({ reason: 0 }), /alert cleanup failed/);
  assert.equal(runtime._timerForeground, false);
  assert.deepEqual(calls.events, [{ type: 'timer-hide', foreground: false }]);
});

test('reminder refresh failures cannot prevent countdown foreground processing', () => {
  const { app, runtime, calls } = createApp();
  app.onLaunch();
  runtime.getCountdownSession();
  app.startSyncAlertRefresh = () => { throw new Error('alert refresh failed'); };
  assert.throws(() => app.onShow(), /alert refresh failed/);
  assert.equal(runtime._timerForeground, true);
  assert.deepEqual(calls.events, [{ type: 'timer-show', foreground: true }]);
});
