const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({ cloud = true, audioEvents = false } = {}) {
  let app;
  const calls = { modules: [], factories: [], events: [], records: [], hides: [], audioBegin: [], audioEnd: [] };
  const recordResult = { success: true };
  const api = cloud ? { cloud: { init() {} } } : {};
  if (audioEvents) {
    api.onAudioInterruptionBegin = callback => calls.audioBegin.push(callback);
    api.onAudioInterruptionEnd = callback => calls.audioEnd.push(callback);
  }
  const controller = {
    appHide(options) {
      calls.hides.push(options);
      calls.events.push({ type: 'timer-hide', foreground: app._timerForeground });
    },
    appShow() {
      calls.events.push({ type: 'timer-show', foreground: app._timerForeground });
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
      if (name === './utils/practiceMirror.js') return { resume: async () => ({ pending: 0 }) };
      if (name === './utils/checkin.js') return {
        recordCheckin(...args) { calls.records.push(args); return recordResult; }
      };
      assert.equal(name, './utils/countdownSession');
      return {
        createCountdownSessionController(options) {
          calls.factories.push(options);
          return controller;
        }
      };
    }
  }, { filename });
  for (const method of ['setupRecordRefresh', 'setupCacheStatus', 'testCloudEnvironment', 'setAudioOptions']) {
    app[method] = () => {};
  }
  app.startSyncAlertRefresh = () => calls.events.push({ type: 'alerts-show' });
  app.refreshRecordBackups = async () => {};
  app.resumeRecordBackups = async () => {};
  app.clearSyncAlert = () => calls.events.push({ type: 'alerts-hide' });
  return { app, api, controller, calls, recordResult };
}

test('app lifecycle does not load or construct the countdown controller until requested', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  await app.onShow();
  app.onHide();
  assert.equal(calls.modules[0], './utils/checkin.js');
  assert.equal(calls.modules.includes('./utils/countdownSession'), false);
  assert.equal(calls.factories.length, 0);
});

test('the app retains one controller and forwards recording through the existing check-in manager', () => {
  const { app, api, controller, calls, recordResult } = createApp();
  app.onLaunch();
  assert.equal(app.getCountdownSession(), controller);
  assert.equal(app.getCountdownSession(), controller);
  assert.equal(calls.factories.length, 1);
  assert.equal(calls.factories[0].api, api);
  const args = [2, [], [], 123456, 'timer_one'];
  assert.equal(calls.factories[0].recordCheckin(...args), recordResult);
  assert.deepEqual(calls.records, [args]);
  assert.deepEqual(calls.events, []);
});

test('launch and show track the foreground even when cloud capability is unavailable', () => {
  const { app, calls } = createApp({ cloud: false });
  app.onLaunch();
  assert.equal(app._timerForeground, true);
  app.getCountdownSession();
  app.onHide();
  app.onShow();
  assert.equal(app._timerForeground, true);
  assert.deepEqual(calls.events, [
    { type: 'timer-hide', foreground: false },
    { type: 'alerts-hide' },
    { type: 'timer-show', foreground: true }
  ]);
});

test('hiding without a timer page notifies the retained controller before reminder cleanup', () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  app._syncAlertVisible = true;
  app.onHide();
  assert.equal(app._timerForeground, false);
  assert.equal(app._syncAlertVisible, false);
  assert.deepEqual(calls.events, [
    { type: 'timer-hide', foreground: false },
    { type: 'alerts-hide' }
  ]);
});

test('a controller first requested in the background is marked hidden without restoring a checkpoint', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.onHide();
  calls.events.length = 0;
  app.getCountdownSession();
  app.getCountdownSession();
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
  const { app, controller, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  app.onHide();
  app.onHide();
  await app.onShow();
  await app.onShow();
  assert.equal(app.getCountdownSession(), controller);
  assert.equal(calls.factories.length, 1);
  assert.deepEqual(calls.events.map(event => event.type), [
    'timer-hide', 'alerts-hide', 'timer-hide', 'alerts-hide',
    'timer-show', 'alerts-show', 'timer-show', 'alerts-show'
  ]);
});

test('reminder cleanup failures cannot prevent countdown exit processing', () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  app.clearSyncAlert = () => { throw new Error('alert cleanup failed'); };
  assert.throws(() => app.onHide(), /alert cleanup failed/);
  assert.equal(app._timerForeground, false);
  assert.deepEqual(calls.events, [{ type: 'timer-hide', foreground: false }]);
});

test('reminder refresh failures cannot prevent countdown foreground processing', () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  app.startSyncAlertRefresh = () => { throw new Error('alert refresh failed'); };
  assert.throws(() => app.onShow(), /alert refresh failed/);
  assert.equal(app._timerForeground, true);
  assert.deepEqual(calls.events, [{ type: 'timer-show', foreground: true }]);
});

test('app hide forwards every background reason and all additional options without interpreting them', () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  for (const reason of [0, 1, 2, 3]) {
    const options = { reason, extra: 'forward unchanged' };
    app.onHide(options);
    assert.equal(calls.hides.at(-1), options);
    assert.equal(app._timerHideOptions, options);
  }
  app.onHide();
  assert.equal(calls.hides.at(-1).reason, undefined);
  assert.notEqual(calls.hides.at(-1), calls.hides.at(-2));
});

test('a controller first created while interrupted receives the original background options', () => {
  const { app, calls } = createApp();
  app.onLaunch();
  const options = { reason: 3, extra: 'call interruption' };
  app.onHide(options);
  app.getCountdownSession();
  app.getCountdownSession();
  assert.deepEqual(calls.hides, [options]);
  app.onShow();
  assert.equal(app._timerHideOptions, null);
});

test('audio interruptions are tracked once without loading or ending a countdown, including without cloud', () => {
  for (const cloud of [true, false]) {
    const { app, calls } = createApp({ cloud, audioEvents: true });
    app.onLaunch();
    app.setupTimerAudioInterruption();
    assert.equal(calls.audioBegin.length, 1);
    assert.equal(calls.audioEnd.length, 1);
    assert.equal(app._timerAudioInterrupted, false);
    calls.audioBegin[0]();
    assert.equal(app._timerAudioInterrupted, true);
    assert.equal(calls.factories.length, 0);
    app.getCountdownSession();
    calls.audioEnd[0]();
    assert.equal(app._timerAudioInterrupted, false);
    assert.deepEqual(calls.events, []);
    assert.equal(calls.hides.length, 0);
  }
});

test('older runtimes without audio interruption events can still initialize timing', () => {
  const { app, controller } = createApp({ cloud: false });
  app.onLaunch();
  assert.equal(app._timerAudioInterrupted, false);
  assert.equal(app.getCountdownSession(), controller);
});
