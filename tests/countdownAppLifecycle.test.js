const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({ cloud = true, audioEvents = false, recordCheckin: recordBehavior,
  initialStorage = {}, initialTime, failRead = () => false, failWrite = () => false } = {}) {
  let app;
  const calls = { modules: [], factories: [], events: [], records: [], hides: [], audioBegin: [], audioEnd: [], exitAudio: [] };
  const recordResult = { success: true };
  const storage = new Map(Object.entries(structuredClone(initialStorage)));
  const api = cloud ? { cloud: { init() {} } } : {};
  api.getStorageSync = key => {
    if (failRead(key)) throw new Error('storage read failed');
    return storage.get(key);
  };
  api.setStorageSync = (key, value) => {
    if (failWrite(key, value)) throw new Error('storage write failed');
    storage.set(key, value);
  };
  class ClockDate extends Date {
    static now() { return initialTime === undefined ? Date.now() : initialTime; }
  }
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
    Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      calls.modules.push(name);
      if (name === './utils/practiceMirror.js') return { resume: async () => ({ pending: 0 }) };
      if (name === './utils/checkin.js') return {
        recordCheckin(...args) { calls.records.push(args); return recordBehavior ? recordBehavior(...args) : recordResult; },
        getUserCheckinDataByUserId(userId) { return api.getStorageSync(`meditation_checkin_${userId}`); }
      };
      if (name === './utils/timerEndReminder') return require('../miniprogram/utils/timerEndReminder');
      if (name === './utils/timerInterruption') return require('../miniprogram/utils/timerInterruption');
      if (name === './utils/timerExitAudio') return {
        createTimerExitAudio(options) {
          assert.equal(options.api, api);
          return {
            play() { calls.exitAudio.push({ type: 'play', available: options.canPlay() }); },
            pause() { calls.exitAudio.push({ type: 'pause' }); },
            stop() { calls.exitAudio.push({ type: 'stop' }); },
            resume() { calls.exitAudio.push({ type: 'resume', available: options.canPlay() }); }
          };
        }
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
  return { app, api, controller, calls, recordResult, storage };
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

const COLD_EXIT_START = Date.parse('2026-11-06T08:00:00+08:00');

function persistedTimer({ isCountdown = true, paused = false, totalPausedTime = 0, ...overrides } = {}) {
  return {
    sessionId: 'reclaimed-session', isCountdown, isRunning: !paused, isPaused: paused,
    totalTime: 420, elapsedTime: 65, startTimestamp: COLD_EXIT_START,
    pauseTimestamp: paused ? COLD_EXIT_START + totalPausedTime + 65000 : 0,
    totalPausedTime, saveTime: COLD_EXIT_START + totalPausedTime + 65000,
    ...(isCountdown ? { schemaVersion: 2, runtimeId: 'reclaimed-runtime', status: paused ? 'paused' : 'running' } : {}),
    ...overrides
  };
}

test('explicit cold homepage exits remain lazy when no persisted timer exists', async () => {
  for (const reason of [0, 1]) {
    const h = createApp({ cloud: false });
    h.app.onLaunch(); await h.app.onShow(); h.app.onHide({ reason });
    assert.equal(h.calls.factories.length, 0);
    assert.equal(h.calls.modules.includes('./utils/countdownSession'), false);
    assert.equal(h.calls.records.length, 0);
    assert.equal(h.storage.get('timerState'), undefined);
  }
});

test('a cold homepage explicit exit silently settles either reclaimed timer once without opening its page', async () => {
  for (const isCountdown of [true, false]) {
    for (const paused of [false, true]) {
      for (const reason of [0, 1]) {
        const state = persistedTimer({ isCountdown, paused });
        const h = createApp({ cloud: false, initialStorage: { timerState: state }, initialTime: COLD_EXIT_START + 185000 });
        h.app.onLaunch(); await h.app.onShow();
        h.app.onHide({ reason: 3 }); await h.app.onShow();
        assert.deepEqual(h.storage.get('timerState'), state, 'opening only the homepage or passive hiding keeps the original clock');
        assert.equal(h.calls.factories.length, 0);
        h.app.onHide({ reason }); h.app.onHide({ reason });
        assert.equal(h.calls.factories.length, 0, 'the exit settles the stored session without constructing the countdown controller');
        assert.equal(h.calls.records.length, 1);
        assert.equal(h.calls.records[0][0], paused ? 1 : 3);
        assert.equal(h.calls.records[0][3], COLD_EXIT_START + 185000);
        assert.equal(h.calls.records[0][4], state.sessionId);
        const terminal = h.storage.get('timerState');
        assert.equal(terminal.status, 'exited');
        assert.equal(terminal.isRunning, false);
        assert.equal(terminal.isPaused, false);
        assert.equal(terminal.elapsedTime, paused ? 65 : 185);
        assert.equal(terminal.pendingCompletion, null);
        assert.equal(h.storage.get('timerPendingCompletion'), null);
        assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
        assert.equal(h.calls.exitAudio.length, 0);
        const reopened = createApp({ cloud: false, initialStorage: Object.fromEntries(h.storage), initialTime: COLD_EXIT_START + 7200000 });
        reopened.app.onLaunch(); reopened.app.onHide({ reason });
        assert.equal(reopened.calls.records.length, 0);
        assert.deepEqual(structuredClone(reopened.storage.get('timerState')), structuredClone(terminal));
        if (isCountdown) {
          const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');
          const controller = createCountdownSessionController({ api: reopened.api,
            recordCheckin: () => assert.fail('a terminal checkpoint cannot be saved again'),
            now: () => COLD_EXIT_START + 7200000, setInterval: () => 1, clearInterval() {} });
          controller.restore();
          assert.equal(controller.getSnapshot().isRunning, false);
          assert.equal(controller.getSnapshot().pendingCompletion, null);
          assert.equal(controller.getSnapshot().status, 'exited');
          controller.dispose();
        }
      }
    }
  }
});

test('cold homepage exits cap reclaimed timers at their original deadline including prior manual pauses', () => {
  for (const isCountdown of [true, false]) {
    const limit = isCountdown ? 420 : 86400;
    const state = persistedTimer({ isCountdown, totalPausedTime: 30000 });
    const h = createApp({ cloud: false, initialStorage: { timerState: state },
      initialTime: COLD_EXIT_START + 30000 + (limit + 600) * 1000 });
    h.app.onLaunch(); h.app.onHide({ reason: 0 });
    assert.equal(h.calls.records.length, 1);
    assert.equal(h.calls.records[0][0], limit / 60);
    assert.equal(h.calls.records[0][3], COLD_EXIT_START + 30000 + limit * 1000);
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
  }
});

test('cold homepage exits preserve confirmed progress through clock rollback and discard only sub-minute sits', () => {
  for (const isCountdown of [true, false]) {
    for (const seconds of [0, 59, 65]) {
      const state = persistedTimer({ isCountdown, elapsedTime: seconds,
        saveTime: COLD_EXIT_START + seconds * 1000 });
      const h = createApp({ cloud: false, initialStorage: { timerState: state },
        initialTime: state.saveTime - 3600000 });
      h.app.onLaunch(); h.app.onHide({ reason: 0 });
      assert.equal(h.calls.records.length, seconds >= 60 ? 1 : 0);
      assert.equal(h.storage.get('timerState').elapsedTime, seconds);
      assert.equal(h.storage.get('timerState').startTimestamp, COLD_EXIT_START - 3600000);
      assert.equal(h.storage.get('timerState').status, 'exited');
      assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
      if (seconds >= 60) {
        assert.equal(h.calls.records[0][0], 1);
        assert.equal(h.calls.records[0][3], state.saveTime - 3600000);
      }
    }
  }
});

test('cold homepage exit preserves pending drafts, embedded drafts and terminal or invalid checkpoints', () => {
  const completion = { sessionId: 'existing-completion', duration: 2, endedAt: COLD_EXIT_START, text: '保留草稿' };
  const cases = [
    { timerState: persistedTimer(), timerPendingCompletion: completion },
    { timerState: persistedTimer({ pendingCompletion: completion }) },
    { timerState: persistedTimer({ status: 'completed', isRunning: false }) },
    { timerState: persistedTimer({ status: 'cancelled' }) },
    { timerState: persistedTimer({ isCountdown: false, totalPausedTime: NaN }) },
    { timerState: persistedTimer({ elapsedTime: 999 }) },
    { timerState: persistedTimer({ saveTime: COLD_EXIT_START - 1 }) },
    { timerState: persistedTimer({ paused: true, pauseTimestamp: COLD_EXIT_START + 90000 }) },
    { timerState: persistedTimer({ runtimeId: '' }) },
    { timerState: persistedTimer({ schemaVersion: 999 }) }
  ];
  for (const initialStorage of cases) {
    const h = createApp({ cloud: false, initialStorage, initialTime: COLD_EXIT_START + 185000 });
    h.app.onLaunch(); h.app.onHide({ reason: 0 });
    assert.equal(h.calls.records.length, 0);
    assert.deepEqual(h.storage.get('timerState'), initialStorage.timerState);
    assert.deepEqual(h.storage.get('timerPendingCompletion'), initialStorage.timerPendingCompletion);
  }
});

test('unreadable cold exit state stays untouched and a later explicit exit can retry the read', () => {
  for (const failedKey of ['timerState', 'timerPendingCompletion']) {
    for (const isCountdown of [true, false]) {
      const state = persistedTimer({ isCountdown });
      let failed = true;
      const h = createApp({ cloud: false, initialStorage: { timerState: state }, initialTime: COLD_EXIT_START + 185000,
        failRead: key => failed && key === failedKey });
      h.app.onLaunch(); h.app.onHide({ reason: 0 });
      assert.equal(h.calls.records.length, 0);
      assert.deepEqual(h.storage.get('timerState'), state);
      assert.equal(h.storage.get('timerPendingCompletion'), undefined);
      failed = false; h.app.onHide({ reason: 1 });
      assert.equal(h.calls.records.length, 1);
      assert.equal(h.calls.records[0][0], 3);
      assert.equal(h.calls.records[0][4], state.sessionId);
    }
  }
});

test('a failed cold homepage exit save retains its exact draft without automatic resubmission on restart', () => {
  for (const isCountdown of [true, false]) {
    for (const failedDraftWrite of [false, true]) {
      const state = persistedTimer({ isCountdown });
      const h = createApp({ cloud: false, initialStorage: { timerState: state }, initialTime: COLD_EXIT_START + 185000,
        recordCheckin: () => ({ success: false }),
        failWrite: (key, value) => failedDraftWrite && key === 'timerPendingCompletion' && !!value });
      h.app.onLaunch(); h.app.onHide({ reason: 0 }); h.app.onHide({ reason: 1 });
      assert.equal(h.calls.records.length, 1);
      const terminal = h.storage.get('timerState');
      assert.equal(terminal.status, 'exited');
      assert.equal(terminal.pendingCompletion.sessionId, state.sessionId);
      assert.equal(terminal.pendingCompletion.duration, 3);
      assert.equal(terminal.pendingCompletion.endedAt, COLD_EXIT_START + 185000);
      assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
      const reopened = createApp({ cloud: false, initialStorage: Object.fromEntries(h.storage), initialTime: COLD_EXIT_START + 7200000 });
      reopened.app.onLaunch(); reopened.app.onHide({ reason: 0 });
      assert.equal(reopened.calls.records.length, 0);
      assert.deepEqual(structuredClone(reopened.storage.get('timerState')), structuredClone(terminal));
    }
  }
});

test('a failed cold exit remains terminal in memory while all recovery writes are unavailable', () => {
  for (const isCountdown of [true, false]) {
    let failWrites = true;
    const state = persistedTimer({ isCountdown });
    const h = createApp({ cloud: false, initialStorage: { timerState: state }, initialTime: COLD_EXIT_START + 185000,
      recordCheckin: () => ({ success: false }),
      failWrite: key => failWrites && ['timerState', 'timerPendingCompletion'].includes(key) });
    h.app.onLaunch(); h.app.onHide({ reason: 0 }); h.app.onShow();
    assert.equal(h.calls.records.length, 1);
    assert.deepEqual(h.storage.get('timerState'), state, 'failed writes leave the previous disk checkpoint intact');
    const exit = h.app.getDetachedCountupExit(state.sessionId);
    assert.equal(exit.saved, false);
    assert.equal(exit.completion.duration, 3);
    assert.equal(exit.completion.endedAt, COLD_EXIT_START + 185000);
    if (isCountdown) {
      const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');
      h.app.getCountdownSession();
      assert.equal(h.calls.factories[0].api, h.api, 'controller and page retain shared reminder memory');
      const controller = createCountdownSessionController({ ...h.calls.factories[0],
        now: () => COLD_EXIT_START + 185000, setInterval: () => 1, clearInterval() {} });
      controller.restore();
      assert.equal(controller.getSnapshot().status, 'exited');
      assert.equal(controller.getSnapshot().isRunning, false);
      assert.equal(controller.getSnapshot().pendingCompletion.duration, 3);
      assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
      controller.dispose();
    }
    failWrites = false; h.app.onShow();
    assert.equal(h.storage.get('timerState').status, 'exited');
    assert.equal(h.storage.get('timerPendingCompletion').duration, 3);
    assert.equal(h.calls.records.length, 1, 'terminal repair never automatically resubmits the record');
    h.storage.set('timerPendingCompletion', { ...h.storage.get('timerPendingCompletion'), text: '恢复后填写的感受' });
    assert.equal(h.app.getDetachedCountupExit(state.sessionId).completion.text, '恢复后填写的感受');
    h.app._timerSavedCompletionIds = new Set([state.sessionId]);
    h.app.onShow(); h.app.onShow();
    assert.equal(h.app.getDetachedCountupExit(state.sessionId).saved, true);
    assert.equal(h.storage.get('timerPendingCompletion'), null);
    assert.equal(h.storage.get('timerState').pendingCompletion, null);
    assert.equal(h.calls.records.length, 1, 'page-confirmed records cannot regain a pending draft');
  }
});

test('a cold exit memory repair cannot overwrite a newer or unreadable session', () => {
  for (const replaced of [false, true]) {
    let failWrites = true;
    let failReads = false;
    const h = createApp({ cloud: false, initialStorage: { timerState: persistedTimer() }, initialTime: COLD_EXIT_START + 185000,
      recordCheckin: () => ({ success: false }),
      failWrite: key => failWrites && ['timerState', 'timerPendingCompletion'].includes(key),
      failRead: key => failReads && key === 'timerState' });
    h.app.onLaunch(); h.app.onHide({ reason: 0 });
    const replacement = persistedTimer({ sessionId: 'newer-session' });
    if (replaced) h.storage.set('timerState', replacement);
    else failReads = true;
    failWrites = false;
    const before = structuredClone(Object.fromEntries(h.storage));
    h.app.onShow();
    assert.deepEqual(structuredClone(Object.fromEntries(h.storage)), before);
    assert.equal(h.calls.records.length, 1);
  }
});

test('a reentrant cold exit save cannot duplicate the record or replace a newer session and draft', () => {
  const replacement = persistedTimer({ isCountdown: false, sessionId: 'replacement-session' });
  const draft = { sessionId: 'replacement-draft', duration: 1, endedAt: COLD_EXIT_START, text: 'new' };
  let h;
  h = createApp({ cloud: false, initialStorage: { timerState: persistedTimer() }, initialTime: COLD_EXIT_START + 185000,
    recordCheckin() {
      h.app.onHide({ reason: 1 });
      h.storage.set('timerState', replacement);
      h.storage.set('timerPendingCompletion', draft);
      return { success: true };
    } });
  h.app.onLaunch(); h.app.onHide({ reason: 0 });
  assert.equal(h.calls.records.length, 1);
  assert.equal(h.storage.get('timerState'), replacement);
  assert.equal(h.storage.get('timerPendingCompletion'), draft);
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

test('a broken tab bar cannot delay countdown recovery or complete the same deadline twice', async () => {
  const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');
  const { getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  for (const cloud of [false, true]) {
    for (const returnSeconds of [59, 61]) {
      const { app, api, calls } = createApp({ cloud });
      let now = 100000;
      let nextTimer = 0;
      const timers = new Map();
      const completions = [];
      app.onLaunch();
      const controller = createCountdownSessionController({ api,
        recordCheckin(...args) { calls.records.push(args); return { success: true }; },
        now: () => now,
        setInterval(callback, delay) {
          const id = ++nextTimer;
          timers.set(id, { callback, delay });
          return id;
        },
        clearInterval: id => timers.delete(id)
      });
      app._countdownSession = controller;
      controller.attach((_state, event) => {
        if (event.type === 'complete') completions.push(event.completion);
      });
      controller.start({ sessionId: 'tab-bar-recovery', totalTime: 60 });
      now += 10000;
      app.onHide({ reason: 3 });
      assert.equal(timers.size, 0);
      now = 100000 + returnSeconds * 1000;
      let refreshes = 0;
      const foregroundAtRefresh = [];
      app.registerTabBar({ refresh() {
        refreshes += 1;
        foregroundAtRefresh.push(controller.getSnapshot().foreground);
        throw new Error('native tab bar render failed');
      } });

      let showing;
      assert.doesNotThrow(() => { showing = app.onShow(); });
      assert.equal(controller.getSnapshot().foreground, true);
      assert.equal(controller.getSnapshot().elapsedTime, Math.min(returnSeconds, 60));
      await showing;
      if (returnSeconds < 60) {
        assert.equal(controller.getSnapshot().status, 'running');
        assert.equal(completions.length, 0);
        const ticker = [...timers.values()].find(timer => timer.delay === 1000);
        assert.ok(ticker, 'the foreground ticker is restored even when tab bar rendering fails');
        now = 160000;
        ticker.callback();
      }
      assert.equal(controller.getSnapshot().status, 'completed');
      assert.equal(completions.length, 1);
      assert.equal(completions[0].duration, 1);
      assert.equal(completions[0].endedAt, 160000, 'late UI recovery cannot extend the sitting');
      assert.equal(getEndReminder(api).sessionId, 'tab-bar-recovery');
      assert.equal(timers.size, 0);

      await app.onShow();
      await app.onShow();
      assert.equal(refreshes, 3);
      assert.deepEqual(foregroundAtRefresh, [true, true, true],
        'the countdown resumes synchronously before any tab bar work');
      assert.equal(completions.length, 1);
      assert.equal(calls.records.length, 0, 'foreground recovery preserves the completion draft for confirmation');
      assert.equal(api.getStorageSync('timerPendingCompletion').sessionId, 'tab-bar-recovery');
      assert.equal(calls.events.filter(event => event.type === 'alerts-show').length, cloud ? 3 : 0,
        'a failed tab bar does not interrupt later foreground work');
    }
  }
});

test('app forwards complete background options and dismisses bells only on explicit exits', () => {
  const { queueEndReminder, getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  const { app, api, calls } = createApp();
  app.onLaunch();
  app.getCountdownSession();
  app.getTimerExitAudio();
  for (const reason of [0, 1, 2, 3]) {
    const options = { reason, extra: 'forward unchanged' };
    queueEndReminder(api, `bell-${reason}`);
    app.onHide(options);
    assert.equal(calls.hides.at(-1), options);
    assert.equal(app._timerHideOptions, options);
    assert.equal(calls.exitAudio.at(-1).type, 'stop');
    assert.equal(getEndReminder(api) === null, reason <= 1);
  }
  app.onHide();
  assert.equal(calls.hides.at(-1).reason, undefined);
  assert.notEqual(calls.hides.at(-1), calls.hides.at(-2));
  app.onShow();
  assert.equal(calls.exitAudio.filter(event => event.type === 'play' || event.type === 'resume').length, 0);
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

test('foreground reconciliation leaves a newly completed countdown bell to the timer page', () => {
  const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');
  const { createTimerExitAudio } = require('../miniprogram/utils/timerExitAudio');
  const { queueEndReminder, getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  const { app, api } = createApp({ cloud: false });
  const storage = new Map([['timerReminderSettings', { end: 'vibrate' }]]);
  const reminders = [];
  let now = 100000;
  let nextTimer = 0;
  const timers = new Map();
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id); now = timer.due; timer.callback();
    }
    now = target;
  }
  api.getStorageSync = key => storage.get(key);
  api.setStorageSync = (key, value) => storage.set(key, value);
  api.vibrateLong = callbacks => { reminders.push(callbacks); callbacks.success?.({}); };
  app.onLaunch();
  app._timerExitAudio = createTimerExitAudio({ api,
    canPlay: () => app._timerForeground !== false && !app._timerAudioInterrupted,
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id) });
  queueEndReminder(api, 'previous-sit');
  app.playTimerExitReminder();
  reminders[0].success?.({});
  advance(2999);
  assert.equal(getEndReminder(api).sessionId, 'previous-sit');
  advance(1);
  assert.equal(getEndReminder(api), null);
  const previousPulses = reminders.length;
  assert.ok(previousPulses > 1);

  app._countdownSession = createCountdownSessionController({ api,
    recordCheckin: () => ({ success: true }), now: () => now,
    setInterval: () => 1, clearInterval() {} });
  assert.equal(app._countdownSession.start({ sessionId: 'next-sit', totalTime: 60 }), true);
  now += 59000;
  app.onHide({ reason: 3 });
  now += 2000;
  app.onShow();

  assert.equal(app._countdownSession.getSnapshot().status, 'completed');
  assert.equal(reminders.length, previousPulses, 'the app cannot claim a bell outside the timer page');
  assert.equal(app._timerExitAudio.owns('next-sit'), false);
  app.onShow();
  assert.equal(reminders.length, previousPulses, 'repeated foreground events cannot play a pending bell');
  assert.equal(getEndReminder(api).sessionId, 'next-sit');
});

test('an idle exit player leaves page-owned and active-session reminders alone on foreground', () => {
  const { createTimerExitAudio } = require('../miniprogram/utils/timerExitAudio');
  const { queueEndReminder, getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  for (const owner of ['page', 'running', 'paused']) {
    const { app, api } = createApp({ cloud: false });
    const storage = new Map([['timerReminderSettings', { end: 'vibrate' }]]);
    const reminders = [];
    api.getStorageSync = key => storage.get(key);
    api.setStorageSync = (key, value) => storage.set(key, value);
    api.vibrateLong = callbacks => reminders.push(callbacks);
    app.onLaunch();
    app._timerExitAudio = createTimerExitAudio({ api });
    queueEndReminder(api, 'owned-sit');
    if (owner === 'page') app._timerPage = {};
    else storage.set('timerState', { isRunning: owner === 'running', isPaused: owner === 'paused' });

    app.onShow();

    assert.equal(reminders.length, 0, `${owner} retains reminder ownership`);
    assert.equal(getEndReminder(api).sessionId, 'owned-sit');
    assert.equal(app._timerExitAudio.owns('owned-sit'), false);
  }
});


test('explicit app hide releases a legacy claimed player and dismisses its closing reminder', () => {
  const { createTimerExitAudio } = require('../miniprogram/utils/timerExitAudio');
  const { queueEndReminder, getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  for (const reason of [0, 1]) {
    const { app, api } = createApp({ cloud: false, audioEvents: true });
    const reminders = [];
    api.setStorageSync('timerReminderSettings', { end: 'vibrate' });
    api.vibrateLong = callbacks => reminders.push(callbacks);
    app.onLaunch();
    app._timerExitAudio = createTimerExitAudio({ api });
    queueEndReminder(api, 'finished-sit');
    app.playTimerExitReminder();
    assert.equal(app._timerExitAudio.owns('finished-sit'), true);

    app.onHide({ reason });
    app.onShow();
    assert.equal(getEndReminder(api), null);
    assert.equal(app._timerExitAudio.owns('finished-sit'), false);
    assert.equal(reminders.length, 1);
    reminders[0].success();
    assert.equal(getEndReminder(api), null, 'a stale player callback cannot revive a dismissed reminder');
  }
});

test('audio interruption end never resumes an app-owned exit bell', () => {
  const { app, calls } = createApp({ cloud: false, audioEvents: true });
  app.onLaunch(); app.getTimerExitAudio();
  calls.audioBegin[0](); calls.audioEnd[0]();
  assert.deepEqual(calls.exitAudio, [{ type: 'pause' }]);
});

test('passive app hides leave detached count-up checkpoints unchanged without saving', () => {
  for (const options of [{ reason: 2 }, { reason: 3 }, {}, undefined, null]) {
    for (const paused of [false, true]) {
      const { app, api, calls } = createApp({ cloud: false });
      app.onLaunch();
      app._timerRuntimeId = 'test-runtime';
      app._detachedCountupSessionId = 'detached-sit';
      const state = {
        sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
        interrupted: true, isRunning: !paused, isPaused: paused,
        startTimestamp: Date.now() - 125000, pauseTimestamp: paused ? Date.now() : 0,
        totalPausedTime: 0, elapsedTime: 125
      };
      api.setStorageSync('timerState', state);
      app.onHide(options); app.onHide(options); app.onShow(); app.onShow();
      assert.equal(calls.records.length, 0);
      assert.equal(api.getStorageSync('timerState'), state);
      assert.equal(api.getStorageSync('timerPendingCompletion'), undefined);
      assert.equal(api.getStorageSync('timerPendingEndReminder'), undefined);
      assert.equal(api.getStorageSync('timerCompletionNotice'), undefined);
      assert.equal(calls.exitAudio.length, 0);
      assert.equal(app._detachedCountupSessionId, 'detached-sit');
    }
  }
});

test('explicit app exits settle detached running and paused count-ups once without queueing a bell', () => {
  for (const reason of [0, 1]) {
    for (const paused of [false, true]) {
      for (const seconds of [0, 59, 60, 125, 90000]) {
        const { app, api, calls } = createApp({ cloud: false });
        const at = Date.now();
        app.onLaunch();
        app._timerRuntimeId = 'test-runtime';
        app._detachedCountupSessionId = 'detached-sit';
        api.setStorageSync('timerState', {
          sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
          interrupted: true, isRunning: !paused, isPaused: paused,
          startTimestamp: at - seconds * 1000 - (paused ? 300000 : 0),
          pauseTimestamp: paused ? at - 300000 : 0, totalPausedTime: 0, elapsedTime: seconds
        });
        app.onHide({ reason }); app.onHide({ reason }); app.onShow();
        assert.equal(calls.records.length, seconds >= 60 ? 1 : 0);
        if (seconds >= 60) {
          assert.equal(calls.records[0][0], Math.floor(Math.min(seconds, 86400) / 60));
          assert.equal(calls.records[0][4], 'detached-sit');
        }
        assert.equal(api.getStorageSync('timerState'), null);
        assert.equal(api.getStorageSync('timerPendingCompletion') == null, true);
        assert.equal(api.getStorageSync('timerPendingEndReminder') == null, true);
        assert.equal(app._detachedCountupSessionId, null);
        assert.match(api.getStorageSync('timerCompletionNotice'), seconds < 60 ? /不足1分钟未记录/ : /分钟已存本机/);
        assert.equal(calls.exitAudio.length, 0);
      }
    }
  }
});

test('a failed detached count-up exit save preserves its draft and never automatically resubmits', () => {
  const { app, api, calls, recordResult } = createApp({ cloud: false });
  app.onLaunch();
  app._timerRuntimeId = 'test-runtime';
  app._detachedCountupSessionId = 'detached-sit';
  recordResult.success = false;
  api.setStorageSync('timerState', {
    sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
    interrupted: true, isRunning: true, isPaused: false,
    startTimestamp: Date.now() - 125000, pauseTimestamp: 0, totalPausedTime: 0, elapsedTime: 125
  });
  app.onHide({ reason: 0 });
  const completion = api.getStorageSync('timerPendingCompletion');
  assert.equal(completion.sessionId, 'detached-sit');
  assert.equal(completion.duration, 2);
  assert.equal(api.getStorageSync('timerState'), null);
  app.onHide({ reason: 1 }); app.onShow();
  assert.equal(calls.records.length, 1);
  assert.deepEqual({ ...api.getStorageSync('timerPendingCompletion') }, { ...completion });
  assert.equal(api.getStorageSync('timerPendingEndReminder') == null, true);
  assert.match(api.getStorageSync('timerCompletionNotice'), /请确认保存记录/);
});

test('detached count-up ownership cannot settle a different runtime or replacement session', () => {
  for (const state of [
    { sessionId: 'other-sit', runtimeId: 'test-runtime' },
    { sessionId: 'detached-sit', runtimeId: 'other-runtime' }
  ]) {
    const { app, api, calls } = createApp({ cloud: false });
    app.onLaunch();
    app._timerRuntimeId = 'test-runtime';
    app._detachedCountupSessionId = 'detached-sit';
    const checkpoint = { ...state, isCountdown: false, interrupted: true,
      isRunning: true, isPaused: false, startTimestamp: Date.now() - 125000, totalPausedTime: 0 };
    api.setStorageSync('timerState', checkpoint);
    app.onHide({ reason: 0 });
    assert.equal(calls.records.length, 0);
    assert.equal(api.getStorageSync('timerState'), checkpoint);
    assert.equal(app._detachedCountupSessionId, null);
  }
});

test('cold launch preserves unplayed bells, completed records and recovery drafts without playing or settling', () => {
  const { queueEndReminder, getEndReminder } = require('../miniprogram/utils/timerEndReminder');
  for (const cloud of [false, true]) {
    const { app, api, calls } = createApp({ cloud });
    const completion = { sessionId: 'legacy-sit', duration: 7, endedAt: 123456, text: '已完成的感受' };
    const state = { sessionId: 'legacy-sit', status: 'completed', pendingCompletion: completion };
    const record = [{ sessionId: 'legacy-sit', duration: 7 }];
    queueEndReminder(api, 'legacy-sit');
    api.setStorageSync('timerPendingCompletion', completion);
    api.setStorageSync('timerState', state);
    api.setStorageSync('checkinRecords', record);
    app.onLaunch();

    assert.equal(getEndReminder(api).sessionId, 'legacy-sit');
    assert.deepEqual({ ...api.getStorageSync('timerPendingCompletion') }, { ...completion });
    assert.equal(api.getStorageSync('timerState'), state);
    assert.equal(api.getStorageSync('checkinRecords'), record);
    assert.equal(calls.exitAudio.length, 0);
    assert.equal(calls.factories.length, 0, 'launch does not restore or settle a session');
  }
});

test('unreadable legacy bell storage cannot block app initialization', () => {
  const { app, api, controller } = createApp({ cloud: false });
  api.getStorageSync = () => { throw new Error('storage unavailable'); };
  assert.doesNotThrow(() => app.onLaunch());
  assert.equal(app._timerForeground, true);
  assert.equal(app.getCountdownSession(), controller);
});

test('detached count-up exit storage failures cannot prevent local recording or revive its memory state', () => {
  for (const failure of ['draft', 'state', 'cleanup', 'notice', 'all']) {
    for (const saveSucceeds of [false, true]) {
      const { app, api, calls, recordResult } = createApp({ cloud: false });
      app.onLaunch();
      app._timerRuntimeId = 'test-runtime';
      app._detachedCountupSessionId = 'detached-sit';
      recordResult.success = saveSucceeds;
      const state = {
        sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
        interrupted: true, isRunning: true, isPaused: false,
        startTimestamp: Date.now() - 125000, pauseTimestamp: 0, totalPausedTime: 0, elapsedTime: 125
      };
      api.setStorageSync('timerState', state);
      const write = api.setStorageSync;
      api.setStorageSync = (key, value) => {
        if (failure === 'all'
          || failure === 'draft' && key === 'timerPendingCompletion' && value
          || failure === 'state' && key === 'timerState'
          || failure === 'cleanup' && key === 'timerPendingCompletion' && value === null
          || failure === 'notice' && key === 'timerCompletionNotice') throw new Error('disk busy');
        return write(key, value);
      };
      assert.doesNotThrow(() => app.onHide({ reason: 0 }));
      assert.equal(calls.records.length, 1, `${failure}/${saveSucceeds}`);
      assert.equal(calls.records[0][0], 2);
      assert.equal(app._detachedCountupSessionId, null);
      const terminal = app.getDetachedCountupExit();
      assert.equal(terminal.sessionId, 'detached-sit');
      assert.equal(terminal.completion.duration, 2);
      assert.equal(terminal.saved, saveSucceeds);
      assert.match(terminal.notice, saveSucceeds ? /已存本机/ : /请确认保存记录/);
      assert.equal(app.getDetachedCountupExit('replacement-sit'), null);
      terminal.completion.duration = 999;
      assert.equal(app.getDetachedCountupExit('detached-sit').completion.duration, 2, 'consumers receive a defensive draft copy');
      if (saveSucceeds) assert.equal(app._timerSavedCompletionIds.has('detached-sit'), true);
      app._detachedCountupSessionId = 'detached-sit';
      assert.doesNotThrow(() => app.onHide({ reason: 1 }));
      assert.equal(calls.records.length, 1, 'even a stale ownership handoff cannot resubmit an exit');
      api.setStorageSync = write;
      app.onShow();
      assert.equal(api.getStorageSync('timerState'), null);
      assert.equal(api.getStorageSync('timerPendingCompletion') == null, saveSucceeds);
      if (!saveSucceeds) assert.equal(api.getStorageSync('timerPendingCompletion').duration, 2);
      assert.equal(calls.records.length, 1, 'foreground retry only repairs storage');
    }
  }
});

test('detached exit cleanup retries preserve a replacement checkpoint and another completion draft', () => {
  const { app, api, calls, recordResult } = createApp({ cloud: false });
  app.onLaunch();
  app._timerRuntimeId = 'test-runtime';
  app._detachedCountupSessionId = 'detached-sit';
  recordResult.success = false;
  api.setStorageSync('timerState', {
    sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
    interrupted: true, isRunning: true, isPaused: false,
    startTimestamp: Date.now() - 125000, totalPausedTime: 0
  });
  app.onHide({ reason: 0 });
  const replacement = { sessionId: 'replacement-sit', isRunning: true };
  const otherDraft = { sessionId: 'other-draft', duration: 7, endedAt: Date.now(), text: '另一份草稿' };
  api.setStorageSync('timerState', replacement);
  api.setStorageSync('timerPendingCompletion', otherDraft);
  app.onShow();
  assert.equal(api.getStorageSync('timerState'), replacement);
  assert.equal(api.getStorageSync('timerPendingCompletion'), otherDraft);
  assert.equal(calls.records.length, 1);
  app._timerSavedCompletionIds = new Set(['detached-sit']);
  app.onShow();
  assert.equal(app.getDetachedCountupExit().saved, true);
  assert.equal(api.getStorageSync('timerPendingCompletion'), otherDraft);
  assert.equal(calls.records.length, 1);
});

test('a matching handed-off count-up checkpoint survives unreadable or stale disk storage', () => {
  for (const unreadable of [false, true]) {
    const { app, api, calls } = createApp({ cloud: false });
    const at = Date.now();
    app.onLaunch();
    app._timerRuntimeId = 'test-runtime';
    app._detachedCountupSessionId = 'detached-sit';
    const handed = {
      sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
      interrupted: true, isRunning: false, isPaused: true,
      startTimestamp: at - 425000, pauseTimestamp: at - 300000, totalPausedTime: 0, elapsedTime: 125
    };
    app._detachedCountupState = handed;
    api.setStorageSync('timerState', { ...handed, isRunning: true, isPaused: false, pauseTimestamp: 0 });
    if (unreadable) api.getStorageSync = () => { throw new Error('unreadable'); };
    assert.doesNotThrow(() => app.onHide({ reason: 0 }));
    assert.equal(calls.records.length, 1);
    assert.equal(calls.records[0][0], 2, 'the latest paused snapshot takes precedence over stale running storage');
    assert.equal(app.getDetachedCountupExit().saved, true);
    assert.equal(app._detachedCountupState, null);
    assert.equal(app._detachedCountupSessionId, null);
    assert.doesNotThrow(() => app.onShow());
    assert.equal(calls.records.length, 1);
  }
});

test('an unreadable detached checkpoint without a verified handoff does not fabricate a duration', () => {
  const { app, api, calls } = createApp({ cloud: false });
  app.onLaunch();
  app._timerRuntimeId = 'test-runtime';
  app._detachedCountupSessionId = 'detached-sit';
  app._detachedCountupState = { sessionId: 'someone-else', runtimeId: 'test-runtime' };
  api.getStorageSync = () => { throw new Error('unreadable'); };
  assert.doesNotThrow(() => app.onHide({ reason: 0 }));
  assert.equal(calls.records.length, 0);
  assert.equal(app.getDetachedCountupExit(), null);
  assert.equal(app._detachedCountupSessionId, 'detached-sit', 'retain ownership until a checkpoint can be verified');
});

test('a detached exit never overwrites a newer disk checkpoint or another pending completion', () => {
  const { app, api, calls } = createApp({ cloud: false });
  app.onLaunch();
  app._timerRuntimeId = 'test-runtime';
  app._detachedCountupSessionId = 'detached-sit';
  app._detachedCountupState = {
    sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
    interrupted: true, isRunning: true, isPaused: false,
    startTimestamp: Date.now() - 125000, pauseTimestamp: 0, totalPausedTime: 0
  };
  const replacement = { sessionId: 'replacement-sit', isRunning: true };
  const otherDraft = { sessionId: 'other-draft', duration: 7, endedAt: Date.now(), text: '' };
  api.setStorageSync('timerState', replacement);
  api.setStorageSync('timerPendingCompletion', otherDraft);
  app.onHide({ reason: 0 }); app.onShow();
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0][4], 'detached-sit');
  assert.equal(api.getStorageSync('timerState'), replacement);
  assert.equal(api.getStorageSync('timerPendingCompletion'), otherDraft);
  assert.equal(app.getDetachedCountupExit('detached-sit').saved, true);
});

test('a reentrant record callback cannot make detached cleanup clear a replacement completion', () => {
  let api;
  const replacement = { sessionId: 'replacement-sit', isRunning: true };
  const otherDraft = { sessionId: 'other-draft', duration: 7, endedAt: Date.now(), text: '' };
  const h = createApp({ cloud: false, recordCheckin() {
    api.setStorageSync('timerState', replacement);
    api.setStorageSync('timerPendingCompletion', otherDraft);
    h.app._detachedCountupSessionId = 'detached-sit';
    h.app.finishDetachedCountup({ reason: 1 });
    return { success: true };
  } });
  api = h.api;
  h.app.onLaunch();
  h.app._timerRuntimeId = 'test-runtime';
  h.app._detachedCountupSessionId = 'detached-sit';
  api.setStorageSync('timerState', {
    sessionId: 'detached-sit', runtimeId: 'test-runtime', isCountdown: false,
    interrupted: true, isRunning: true, isPaused: false,
    startTimestamp: Date.now() - 125000, pauseTimestamp: 0, totalPausedTime: 0
  });
  h.app.onHide({ reason: 0 }); h.app.onShow();
  assert.equal(h.calls.records.length, 1);
  assert.equal(api.getStorageSync('timerState'), replacement);
  assert.equal(api.getStorageSync('timerPendingCompletion'), otherDraft);
  assert.equal(h.app.getDetachedCountupExit().saved, true);
});

test('a detached count-up exit preserves confirmed progress after device clock rollback', () => {
  for (const paused of [false, true]) {
    const state = persistedTimer({ isCountdown: false, paused, elapsedTime: 125,
      runtimeId: 'test-runtime', interrupted: true,
      pauseTimestamp: paused ? COLD_EXIT_START + 125000 : 0,
      saveTime: COLD_EXIT_START + 125000 });
    const h = createApp({ cloud: false, initialStorage: { timerState: state },
      initialTime: state.saveTime - 3600000 });
    h.app.onLaunch();
    h.app._timerRuntimeId = state.runtimeId;
    h.app._detachedCountupSessionId = state.sessionId;
    h.app.onHide({ reason: 0 });
    assert.equal(h.calls.records.length, 1);
    assert.equal(h.calls.records[0][0], 2, 'clock rollback cannot discard confirmed sitting minutes');
    assert.equal(h.calls.records[0][3], state.saveTime - 3600000);
    assert.equal(h.calls.records[0][4], state.sessionId);
  }
});

test('a detached exit retains a terminal backup when draft storage and recording fail', () => {
  let draftUnavailable = true;
  const state = persistedTimer({ isCountdown: false, runtimeId: 'test-runtime', interrupted: true });
  const h = createApp({ cloud: false, initialStorage: { timerState: state },
    initialTime: COLD_EXIT_START + 185000, recordCheckin: () => ({ success: false }),
    failWrite: (key, value) => draftUnavailable && key === 'timerPendingCompletion' && !!value });
  h.app.onLaunch();
  h.app._timerRuntimeId = state.runtimeId;
  h.app._detachedCountupSessionId = state.sessionId;
  h.app.onHide({ reason: 0 });
  h.app.onShow();
  const terminal = h.storage.get('timerState');
  assert.equal(terminal.status, 'exited');
  assert.equal(terminal.isRunning, false);
  assert.equal(terminal.isPaused, false);
  assert.equal(terminal.pendingCompletion.sessionId, state.sessionId);
  assert.equal(terminal.pendingCompletion.duration, 3);
  assert.equal(terminal.pendingCompletion.endedAt, COLD_EXIT_START + 185000);
  const cold = createApp({ cloud: false, initialStorage: Object.fromEntries(h.storage),
    initialTime: COLD_EXIT_START + 7200000 });
  cold.app.onLaunch(); cold.app.onHide({ reason: 0 });
  assert.equal(cold.calls.records.length, 0, 'an exited sit cannot keep accumulating in a new process');
  assert.deepEqual(structuredClone(cold.storage.get('timerState')), structuredClone(terminal));
  draftUnavailable = false;
  h.app.onShow();
  assert.equal(h.storage.get('timerPendingCompletion').duration, 3);
  assert.equal(h.storage.get('timerState'), null, 'the backup can be removed after the independent draft is durable');
  assert.equal(h.calls.records.length, 1);
});

test('detached completion repairs retain reflection text edited after the exit', () => {
  const state = persistedTimer({ isCountdown: false, runtimeId: 'test-runtime', interrupted: true });
  const h = createApp({ cloud: false, initialStorage: { timerState: state },
    initialTime: COLD_EXIT_START + 185000, recordCheckin: () => ({ success: false }) });
  h.app.onLaunch();
  h.app._timerRuntimeId = state.runtimeId;
  h.app._detachedCountupSessionId = state.sessionId;
  h.app.onHide({ reason: 0 });
  h.storage.set('timerPendingCompletion', { ...h.storage.get('timerPendingCompletion'), text: '中断后补写的静坐感受' });
  h.app.onShow(); h.app.onShow();
  assert.equal(h.storage.get('timerPendingCompletion').text, '中断后补写的静坐感受');
  assert.equal(h.app.getDetachedCountupExit().completion.text, '中断后补写的静坐感受');
});

test('a transient first draft read failure cannot roll back an edited detached reflection', () => {
  const state = persistedTimer({ isCountdown: false, runtimeId: 'test-runtime', interrupted: true });
  const h = createApp({ cloud: false, initialStorage: { timerState: state },
    initialTime: COLD_EXIT_START + 185000, recordCheckin: () => ({ success: false }) });
  h.app.onLaunch();
  h.app._timerRuntimeId = state.runtimeId;
  h.app._detachedCountupSessionId = state.sessionId;
  h.app.onHide({ reason: 0 });
  h.storage.set('timerPendingCompletion', { ...h.storage.get('timerPendingCompletion'), text: '新填写的感受' });
  const read = h.api.getStorageSync;
  let failNext = true;
  h.api.getStorageSync = key => {
    if (key === 'timerPendingCompletion' && failNext) {
      failNext = false;
      throw new Error('transient read failure');
    }
    return read(key);
  };
  h.app.onShow();
  assert.equal(h.storage.get('timerPendingCompletion').text, '新填写的感受');
});

test('detached successful saves retain a terminal acknowledgment until stale draft cleanup succeeds', () => {
  let cleanupUnavailable = true;
  const state = persistedTimer({ isCountdown: false, runtimeId: 'test-runtime', interrupted: true });
  const h = createApp({ cloud: false, initialStorage: { timerState: state },
    initialTime: COLD_EXIT_START + 185000,
    failWrite: (key, value) => cleanupUnavailable && key === 'timerPendingCompletion' && value === null });
  h.app.onLaunch();
  h.app._timerRuntimeId = state.runtimeId;
  h.app._detachedCountupSessionId = state.sessionId;
  h.app.onHide({ reason: 0 });
  assert.equal(h.calls.records.length, 1);
  assert.equal(h.storage.get('timerState').status, 'exited');
  assert.equal(h.storage.get('timerState').pendingCompletion, null);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, state.sessionId);
  cleanupUnavailable = false;
  h.app.onShow();
  assert.equal(h.storage.get('timerPendingCompletion'), null);
  assert.equal(h.storage.get('timerState'), null);
  assert.equal(h.calls.records.length, 1);
});

test('timer completion acknowledgment reads the local ledger without mutating records or identity', () => {
  for (const wrapped of [false, true]) {
    for (const field of ['localId', 'idempotencyKey']) {
      const data = { dailyRecords: { '2026-11-06': { records: [null, { [field]: 'recorded-sit', duration: 3 }] } } };
      const h = createApp({ cloud: false, initialStorage: { localUserId: 'local-owner' } });
      h.storage.set('meditation_checkin_local-owner', wrapped ? { checkinRecords: data } : data);
      const before = structuredClone(Object.fromEntries(h.storage));
      assert.equal(h.app.hasRecordedTimerCompletion('recorded-sit'), true);
      assert.equal(h.app.hasRecordedTimerCompletion('unrecorded-sit'), false);
      h.app.getCountdownSession();
      assert.equal(h.calls.factories[0].isCompletionRecorded('recorded-sit'), true);
      assert.deepEqual(Object.fromEntries(h.storage), before);
      assert.equal(h.calls.records.length, 0);
    }
  }
});

test('missing or unreadable ledgers cannot acknowledge an unverified timer completion', () => {
  for (const initialStorage of [{}, { localUserId: 'local-owner' },
    { localUserId: 'local-owner', 'meditation_checkin_local-owner': { dailyRecords: { broken: null } } }]) {
    const h = createApp({ cloud: false, initialStorage });
    assert.equal(h.app.hasRecordedTimerCompletion('recorded-sit'), false);
    assert.deepEqual(Object.fromEntries(h.storage), initialStorage, 'read-only recovery never creates a local identity');
  }
  for (const key of ['localUserId', 'meditation_checkin_local-owner']) {
    const h = createApp({ cloud: false, initialStorage: { localUserId: 'local-owner' }, failRead: value => value === key });
    assert.equal(h.app.hasRecordedTimerCompletion('recorded-sit'), false);
  }
});

test('a recorded local sit supersedes stale in-memory exit drafts after a post-save error', () => {
  for (const detached of [false, true]) {
    const state = persistedTimer({ isCountdown: false, runtimeId: 'test-runtime', interrupted: true });
    let h;
    h = createApp({ cloud: false, initialStorage: { timerState: state, localUserId: 'local-owner' },
      initialTime: COLD_EXIT_START + 185000, recordCheckin(duration, emotion, experience, timestamp, id) {
        h.storage.set('meditation_checkin_local-owner', { dailyRecords: {
          '2026-11-06': { records: [{ localId: id, duration, timestamp }] }
        } });
        throw new Error('post-save side effect failed');
      } });
    h.app.onLaunch();
    if (detached) {
      h.app._timerRuntimeId = state.runtimeId;
      h.app._detachedCountupSessionId = state.sessionId;
    }
    h.app.onHide({ reason: 0 }); h.app.onShow();
    assert.equal(h.app.getDetachedCountupExit().saved, true);
    assert.equal(h.storage.get('timerPendingCompletion'), null);
    assert.equal(h.calls.records.length, 1);
  }
});
