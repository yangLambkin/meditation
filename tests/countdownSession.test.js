const test = require('node:test');
const assert = require('node:assert/strict');
const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');

const INITIAL_TIME = Date.parse('2026-10-23T08:00:00+08:00');

function harness({ initialStorage = {}, initialTime = INITIAL_TIME, recordCheckin, failWrite, failSchedule, apiOverrides = {} } = {}) {
  let currentTime = initialTime;
  let timerId = 0;
  const timers = new Map();
  const storage = new Map(Object.entries(structuredClone(initialStorage)));
  const writes = [];
  const records = [];
  const events = [];
  const api = {
    getStorageSync(key) { return structuredClone(storage.get(key)); },
    setStorageSync(key, value) {
      if (failWrite && failWrite(key, value)) throw new Error('storage unavailable');
      writes.push({ key, value: structuredClone(value) });
      storage.set(key, structuredClone(value));
    }
  };
  Object.assign(api, apiOverrides);
  const controller = createCountdownSessionController({
    api,
    now: () => currentTime,
    recordCheckin(...args) {
      records.push(args);
      return recordCheckin ? recordCheckin(...args) : { success: true };
    },
    setInterval(callback, delay) {
      if (failSchedule && failSchedule(delay)) throw new Error('timer install failed');
      const id = ++timerId;
      timers.set(id, { callback, delay, due: currentTime + delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); }
  });
  const detach = controller.attach((snapshot, event) => events.push({ snapshot, event }));
  return {
    controller, storage, writes, records, events, timers, detach,
    start: (totalTime = 420, sessionId = 'session-one') => controller.start({ sessionId, totalTime, startTimestamp: currentTime }),
    now: () => currentTime,
    jump(milliseconds) { currentTime += milliseconds; },
    advance(milliseconds) {
      const target = currentTime + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [, timer] = next;
        currentTime = timer.due;
        timer.due += timer.delay;
        timer.callback();
      }
      currentTime = target;
    },
    dropTicker() {
      const [id, timer] = [...timers].find(([, item]) => item.delay === 1000);
      timers.delete(id);
      return timer.callback;
    },
    data: () => Object.fromEntries(storage),
    snapshot: () => controller.getSnapshot()
  };
}

function checkpoint(extra = {}) {
  return {
    isCountdown: true, sessionId: 'old-session', totalTime: 420,
    startTimestamp: INITIAL_TIME - 125000, saveTime: INITIAL_TIME,
    elapsedTime: 125, isRunning: true, isPaused: false,
    pauseTimestamp: 0, totalPausedTime: 0, ...extra
  };
}

test('foreground countdown survives page detach and reattach with the same identity and deadline', () => {
  const h = harness();
  assert.equal(h.start(), true);
  h.advance(65000);
  h.detach();
  h.advance(60000);
  const attached = [];
  h.controller.attach((snapshot, event) => attached.push({ snapshot, event }));
  assert.equal(attached[0].event.type, 'restore');
  assert.equal(attached[0].snapshot.sessionId, 'session-one');
  assert.equal(attached[0].snapshot.elapsedTime, 125);
  assert.equal(attached[0].snapshot.remainingTime, 295);
  assert.equal(h.records.length, 0);
  h.advance(295000);
  assert.equal(h.snapshot().status, 'completed');
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
  assert.equal(h.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 420000);
  assert.equal(h.records.length, 0, 'normal completion waits for the existing confirmation flow');
});

test('app hide ends at actual minutes even after every page has detached and immediate return never revives it', () => {
  for (const seconds of [65, 125]) {
    const h = harness();
    h.start();
    h.advance(seconds * 1000);
    const queuedTick = h.dropTicker();
    h.detach();
    h.controller.appHide();
    assert.equal(h.snapshot().status, 'exited');
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], Math.floor(seconds / 60));
    assert.equal(h.records[0][4], 'session-one');
    assert.equal(h.storage.get('timerState').status, 'exited');
    assert.equal(h.storage.get('timerPendingCompletion'), null);
    h.controller.appShow();
    queuedTick();
    h.controller.attach(() => {});
    h.controller.appHide();
    h.advance(600000);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.records.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('terminal state is durable before record saving or an exit listener can fail or re-enter', () => {
  let h;
  h = harness({ recordCheckin() {
    assert.equal(h.storage.get('timerState').status, 'exited');
    assert.equal(h.snapshot().isRunning, false);
    h.controller.appShow();
    h.controller.tick();
    h.controller.appHide();
    return { success: true };
  } });
  h.controller.attach((snapshot, event) => {
    if (event.type === 'exit') {
      assert.equal(h.storage.get('timerState').status, 'exited');
      throw new Error('unloaded page cannot render');
    }
  });
  h.start();
  h.advance(125000);
  h.controller.appHide();
  assert.equal(h.records.length, 1);
  assert.equal(h.snapshot().status, 'exited');
  assert.ok(h.storage.get('timerDiagnostics').some(item => item.type === 'listener_error'));
});

test('watchdog rebuilds a lost foreground ticker without changing session or creating a record', () => {
  const h = harness();
  h.start();
  h.advance(65000);
  h.dropTicker();
  h.advance(5000);
  assert.equal(h.snapshot().sessionId, 'session-one');
  assert.equal(h.snapshot().elapsedTime, 70);
  assert.equal(h.snapshot().remainingTime, 350);
  assert.equal(h.snapshot().startTimestamp, INITIAL_TIME);
  assert.equal(h.records.length, 0);
  assert.ok(h.events.some(item => item.event.type === 'recover'));
  assert.equal([...h.timers.values()].filter(item => item.delay === 1000).length, 1);
  h.advance(350000);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
});

test('a broken renderer cannot stop core timing or other listeners', () => {
  const h = harness();
  h.controller.attach(() => { throw new Error('render failed'); });
  h.start();
  h.advance(125000);
  assert.equal(h.snapshot().isRunning, true);
  assert.equal(h.snapshot().elapsedTime, 125);
  assert.equal(h.records.length, 0);
  h.advance(295000);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
});

test('pause excludes elapsed wall time and queued running callbacks cannot resume it', () => {
  const h = harness();
  h.start();
  h.advance(125000);
  const queuedTick = h.dropTicker();
  const queuedWatchdog = [...h.timers.values()].find(item => item.delay === 5000).callback;
  h.controller.pause();
  h.advance(60000);
  queuedTick();
  queuedWatchdog();
  assert.equal(h.snapshot().isPaused, true);
  assert.equal(h.snapshot().elapsedTime, 125);
  assert.equal(h.timers.size, 0);
  h.controller.resume();
  h.advance(295000);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
  assert.equal(h.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 480000);
});

test('app hide while paused records only the running portion and never automatically resumes', () => {
  const h = harness();
  h.start();
  h.advance(125000);
  h.controller.pause();
  h.advance(3600000);
  h.controller.appHide();
  h.controller.appShow();
  h.controller.resume();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 2);
  assert.equal(h.snapshot().isPaused, false);
  assert.equal(h.snapshot().isRunning, false);
});

test('manual finish preserves the short draft and repeated finish, hide, and late callbacks cannot resubmit it', () => {
  const h = harness();
  h.start();
  h.advance(125000);
  const queued = [...h.timers.values()].map(item => item.callback);
  const completion = h.controller.finish('manual');
  assert.equal(completion.duration, 2);
  assert.equal(h.events.at(-1).event.reason, 'manual');
  assert.equal(h.controller.finish('manual'), null);
  h.controller.appHide();
  h.controller.appShow();
  queued.forEach(callback => callback());
  assert.equal(h.records.length, 0);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.start(420, 'new-session'), false);
  assert.equal(h.controller.markCompletionSaved('wrong-session'), false);
  assert.equal(h.controller.markCompletionSaved('session-one'), true);
  assert.equal(h.start(420, 'new-session'), true);
});

test('reset, mode change, and duration change are terminal cancellations with no record or resurrection', () => {
  for (const reason of ['reset', 'mode_change', 'duration_change']) {
    const h = harness();
    h.start();
    h.advance(125000);
    const queued = [...h.timers.values()].map(item => item.callback);
    h.controller.cancel(reason);
    h.controller.appHide();
    h.controller.appShow();
    queued.forEach(callback => callback());
    assert.equal(h.snapshot().status, 'cancelled');
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.records.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.start(420, 'session-one'), false, 'a terminal identity cannot be reused');
    assert.equal(h.start(420, 'session-two'), true);
  }
});

test('normal completion and app exit racing at the deadline produce at most one completion', () => {
  for (const exitFirst of [true, false]) {
    const h = harness();
    h.start(60);
    h.jump(60000);
    if (exitFirst) { h.controller.appHide(); h.controller.tick(); }
    else { h.controller.tick(); h.controller.appHide(); }
    assert.equal(h.records.length, exitFirst ? 1 : 0);
    assert.equal(h.events.filter(item => ['complete', 'exit'].includes(item.event.type)).length, 1);
    const completion = h.events.find(item => ['complete', 'exit'].includes(item.event.type)).event.completion;
    assert.equal(completion.duration, 1);
    assert.equal(completion.endedAt, INITIAL_TIME + 60000);
  }
});

test('silent save failure keeps the completion draft while the session remains irreversibly exited', () => {
  const h = harness({ recordCheckin: () => ({ success: false }) });
  h.start();
  h.advance(125000);
  h.controller.appHide();
  assert.equal(h.snapshot().status, 'exited');
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, 'session-one');
  h.controller.appShow();
  h.controller.tick();
  assert.equal(h.start(420, 'another'), false);
  const reopened = harness({ initialStorage: h.data(), initialTime: INITIAL_TIME + 86400000 });
  assert.equal(reopened.records.length, 0, 'cold restore presents the existing draft instead of saving again');
  assert.equal(reopened.snapshot().pendingCompletion.duration, 2);
  assert.equal(reopened.snapshot().isRunning, false);
});

test('cold startup uses only the final checkpoint for both legacy and current running or paused sessions', () => {
  for (const paused of [false, true]) {
    for (const current of [false, true]) {
      const state = checkpoint({ isRunning: !paused, isPaused: paused,
        pauseTimestamp: paused ? INITIAL_TIME : 0,
        ...(current ? { schemaVersion: 2, runtimeId: 'previous-runtime', status: paused ? 'paused' : 'running' } : {}) });
      const h = harness({ initialStorage: { timerState: state }, initialTime: INITIAL_TIME + 86400000 });
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 2);
      assert.equal(h.records[0][3], INITIAL_TIME);
      assert.equal(h.records[0][4], 'old-session');
      assert.equal(h.snapshot().elapsedTime, 125);
      assert.equal(h.snapshot().status, 'exited');
      h.controller.restore();
      h.controller.attach(() => {});
      assert.equal(h.records.length, 1);
      assert.equal(h.timers.size, 0);
    }
  }
});

test('pending completion takes precedence over a stale active checkpoint and also supports count-up drafts', () => {
  const pending = { sessionId: 'countup-pending', duration: 2, endedAt: INITIAL_TIME, text: '已有感受' };
  const h = harness({ initialStorage: { timerState: checkpoint(), timerPendingCompletion: pending } });
  assert.equal(h.records.length, 0);
  assert.equal(h.snapshot().pendingCompletion.text, '已有感受');
  assert.equal(h.snapshot().isRunning, false);
  assert.equal(h.storage.get('timerState'), null);
  assert.equal(h.start(), false);
  assert.equal(h.controller.markCompletionSaved('countup-pending'), true);
  assert.equal(h.start(), true);
});

test('terminal checkpoints never restore running or duplicate a record; embedded draft survives an interrupted storage sequence', () => {
  const pending = { sessionId: 'old-session', duration: 2, endedAt: INITIAL_TIME, text: '' };
  for (const status of ['completed', 'exited', 'cancelled']) {
    const h = harness({ initialStorage: { timerState: checkpoint({
      schemaVersion: 2, runtimeId: 'previous-runtime', status, isRunning: false, isPaused: false,
      pendingCompletion: status === 'cancelled' ? null : pending
    }) } });
    assert.equal(h.snapshot().status, status);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.records.length, 0);
    assert.equal(h.snapshot().pendingCompletion?.duration || 0, status === 'cancelled' ? 0 : 2);
    assert.equal(h.timers.size, 0);
  }
});

test('invalid countdown checkpoints are rejected and unrelated count-up state is untouched', () => {
  for (const mutation of [
    { schemaVersion: 99 }, { totalTime: -1 }, { totalTime: 999999 }, { startTimestamp: NaN },
    { elapsedTime: 500 }, { sessionId: '' }, { isRunning: true, isPaused: true },
    { schemaVersion: 2, status: 'exited', isRunning: true }
  ]) {
    const h = harness({ initialStorage: { timerState: checkpoint(mutation) } });
    assert.equal(h.records.length, 0);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.storage.get('timerState'), null);
  }
  const state = checkpoint({ isCountdown: false });
  const h = harness({ initialStorage: { timerState: state } });
  assert.deepEqual(h.storage.get('timerState'), state);
  assert.equal(h.records.length, 0);
});

test('a sub-minute countdown completes without a draft and exit below one minute never records', () => {
  const h = harness();
  h.start(2);
  h.advance(2000);
  assert.equal(h.snapshot().elapsedTime, 2);
  assert.equal(h.events.at(-1).event.type, 'complete');
  assert.equal(h.events.at(-1).event.completion, null);
  assert.equal(h.records.length, 0);
  assert.equal(h.start(420, 'second'), true);
  h.advance(59000);
  h.controller.appHide();
  assert.equal(h.records.length, 0);
  assert.equal(h.snapshot().pendingCompletion, null);
  assert.match(h.snapshot().completionNotice, /不足1分钟/);
});

test('a first tick install failure is recovered by the independent watchdog', () => {
  let failed = false;
  const h = harness({ failSchedule(delay) {
    if (delay !== 1000 || failed) return false;
    failed = true;
    return true;
  } });
  assert.equal(h.start(), true);
  h.advance(5000);
  assert.equal(h.snapshot().elapsedTime, 5);
  assert.equal([...h.timers.values()].filter(item => item.delay === 1000).length, 1);
  assert.ok(h.events.some(item => item.event.type === 'recover'));
});

test('recovery can be disabled without changing actual exit or normal completion behavior', () => {
  const h = harness();
  h.start();
  h.controller.setRecoveryEnabled(false);
  assert.equal([...h.timers.values()].filter(item => item.delay === 5000).length, 0);
  h.advance(65000);
  h.controller.appHide();
  assert.equal(h.records[0][0], 1);
  h.controller.appShow();
  h.controller.setRecoveryEnabled(true);
  assert.equal(h.snapshot().isRunning, false);
  assert.equal(h.timers.size, 0);
});

test('diagnostics are bounded and normal ticks do not write diagnostic events', () => {
  const h = harness();
  h.start();
  const before = h.storage.get('timerDiagnostics').length;
  h.advance(125000);
  assert.equal(h.storage.get('timerDiagnostics').length, before);
  for (let i = 0; i < 250; i++) h.controller.diagnose('test_fault', { index: i });
  assert.equal(h.storage.get('timerDiagnostics').length, 200);
  assert.equal(h.storage.get('timerDiagnostics')[0].index, 50);
  assert.equal(h.storage.get('timerDiagnostics').at(-1).index, 249);
});

test('snapshot mutation cannot alter the controller and disposal invalidates queued timer callbacks', () => {
  const h = harness();
  h.start();
  h.advance(65000);
  const snapshot = h.snapshot();
  snapshot.isRunning = false;
  snapshot.totalTime = 1;
  assert.equal(h.snapshot().isRunning, true);
  assert.equal(h.snapshot().totalTime, 420);
  const queued = [...h.timers.values()].map(item => item.callback);
  h.controller.dispose();
  h.jump(600000);
  queued.forEach(callback => callback());
  assert.equal(h.records.length, 0);
  assert.equal(h.storage.get('timerState').status, 'running', 'dispose leaves a recoverable checkpoint without inventing an exit');
  assert.equal(h.timers.size, 0);
});

test('early deadline and unclassified finish requests cannot terminate or save an active countdown', () => {
  const h = harness();
  h.start();
  h.advance(125000);
  for (const reason of [undefined, 'deadline', 'timeout', 'unknown', 'app_hide']) {
    assert.equal(h.controller.finish(reason), null);
    assert.equal(h.snapshot().isRunning, true);
    assert.equal(h.snapshot().pendingCompletion, null);
  }
  assert.equal(h.records.length, 0);
  assert.equal(h.snapshot().remainingTime, 295);
  h.advance(295000);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
});

test('pause at the target completes instead of leaving an already finished session paused', () => {
  const h = harness();
  h.start(60);
  h.jump(60000);
  const result = h.controller.pause();
  assert.equal(result.status, 'completed');
  assert.equal(result.isPaused, false);
  assert.equal(result.pendingCompletion.duration, 1);
  assert.equal(result.pendingCompletion.endedAt, INITIAL_TIME + 60000);
});

test('completion text survives same-runtime page rebuild and cold restore and is removed after saving', () => {
  const h = harness();
  h.start(60);
  h.advance(60000);
  assert.equal(h.controller.updateCompletionText('wrong-session', '不要覆盖'), false);
  assert.equal(h.controller.updateCompletionText('session-one', '呼吸慢下来了'), true);
  let attached;
  h.detach();
  h.controller.attach(snapshot => { attached = snapshot; });
  assert.equal(attached.pendingCompletion.text, '呼吸慢下来了');
  assert.equal(h.storage.get('timerState').pendingCompletion.text, '呼吸慢下来了');
  const reopened = harness({ initialStorage: h.data() });
  assert.equal(reopened.snapshot().pendingCompletion.text, '呼吸慢下来了');
  assert.equal(reopened.records.length, 0);
  h.controller.markCompletionSaved('session-one');
  assert.equal(h.storage.get('timerState').pendingCompletion, null);
  assert.equal(h.storage.get('timerPendingCompletion'), null);
});

test('countdown draft maintenance does not overwrite a newer count-up checkpoint', () => {
  const h = harness();
  h.start(60);
  h.advance(60000);
  const countup = checkpoint({ isCountdown: false, sessionId: 'countup' });
  h.storage.set('timerState', countup);
  h.controller.updateCompletionText('session-one', '感受');
  assert.deepEqual(h.storage.get('timerState'), countup);
  const reopened = harness({ initialStorage: h.data() });
  assert.deepEqual(reopened.storage.get('timerState'), countup);
  reopened.controller.markCompletionSaved('session-one');
  assert.deepEqual(reopened.storage.get('timerState'), countup);
  h.controller.markCompletionSaved('session-one');
  assert.deepEqual(h.storage.get('timerState'), countup);
});

test('recovery setting persists across runtimes and optional device diagnostics are safely captured', () => {
  const h = harness({ apiOverrides: {
    getDeviceInfo: () => ({ brand: 'example', model: 'phone', system: 'OS 1', platform: 'ios' }),
    getAppBaseInfo: () => ({ version: '8.0.1', SDKVersion: '3.1.1' }),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'test-app', version: '2.11', envVersion: 'trial' } })
  } });
  const diagnostic = h.storage.get('timerDiagnostics').find(item => item.type === 'controller_init');
  assert.equal(diagnostic.model, 'phone');
  assert.equal(diagnostic.wechatVersion, '8.0.1');
  assert.equal(diagnostic.SDKVersion, '3.1.1');
  assert.equal(diagnostic.appVersion, '2.11');
  assert.equal(diagnostic.envVersion, 'trial');
  h.controller.setRecoveryEnabled(false);
  const reopened = harness({ initialStorage: h.data(), apiOverrides: {
    getDeviceInfo() { throw new Error('unsupported'); }
  } });
  assert.equal(reopened.snapshot().recoveryEnabled, false);
  reopened.start();
  assert.equal([...reopened.timers.values()].filter(item => item.delay === 5000).length, 0);
});

test('repeated native ticker failures retry at most three times and retain a watchdog deadline fallback', () => {
  let attempts = 0;
  const h = harness({ failSchedule(delay) {
    if (delay === 1000) { attempts += 1; return true; }
    return false;
  } });
  h.start(60);
  h.advance(55000);
  assert.equal(attempts, 4, 'one initial install and three repairs');
  assert.equal(h.snapshot().elapsedTime, 55);
  assert.equal(h.storage.get('timerDiagnostics').filter(item => item.type === 'recovery_exhausted').length, 1);
  h.advance(5000);
  assert.equal(h.snapshot().status, 'completed');
  assert.equal(h.snapshot().pendingCompletion.duration, 1);
  assert.equal(attempts, 4);
});

test('successful native ticks reset the consecutive repair limit', () => {
  const h = harness();
  h.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    h.dropTicker();
    h.advance(10000);
    h.advance(1000);
  }
  assert.equal(h.snapshot().isRunning, true);
  assert.equal([...h.timers.values()].filter(item => item.delay === 1000).length, 1);
  assert.equal(h.storage.get('timerDiagnostics').filter(item => item.type === 'recovery_exhausted').length, 0);
});

test('an interrupted separate-key draft write is recovered from the terminal checkpoint', () => {
  const h = harness({ failWrite: (key, value) => key === 'timerPendingCompletion' && !!value });
  h.start(60);
  h.advance(60000);
  assert.equal(h.storage.has('timerPendingCompletion'), false);
  assert.equal(h.storage.get('timerState').pendingCompletion.duration, 1);
  const reopened = harness({ initialStorage: h.data() });
  assert.equal(reopened.snapshot().isRunning, false);
  assert.equal(reopened.snapshot().pendingCompletion.duration, 1);
  assert.equal(reopened.storage.get('timerPendingCompletion').sessionId, 'session-one');
  assert.equal(reopened.records.length, 0);
});

test('natural completion with no page delivers one deferred complete on same-runtime foreground attach', () => {
  const h = harness();
  h.start(60);
  h.advance(55000);
  h.detach();
  h.advance(10000);
  assert.equal(h.snapshot().pendingCompletion.duration, 1);
  const nextEvents = [];
  const detach = h.controller.attach((snapshot, event) => nextEvents.push({ snapshot, event }));
  assert.equal(nextEvents.length, 1);
  assert.equal(nextEvents[0].event.type, 'complete');
  assert.equal(nextEvents[0].event.reason, 'timeout');
  assert.equal(nextEvents[0].event.completion.endedAt, INITIAL_TIME + 60000);
  detach();
  h.controller.attach((snapshot, event) => nextEvents.push({ snapshot, event }));
  assert.equal(nextEvents.at(-1).event.type, 'restore');
  assert.equal(nextEvents.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.records.length, 0);
});

test('a nested attach cannot claim an already claimed deferred completion', () => {
  const h = harness();
  h.start(60);
  h.detach();
  h.advance(60000);
  const events = [];
  h.controller.attach((snapshot, event) => {
    events.push(event.type);
    if (event.type === 'complete') h.controller.attach((_, nested) => events.push(nested.type));
  });
  assert.deepEqual(events, ['complete', 'restore']);
});

test('app hide discards a deferred completion cue even when immediately returning to the same runtime', () => {
  const h = harness();
  h.start(60);
  h.detach();
  h.advance(60000);
  h.controller.appHide();
  h.controller.appShow();
  const events = [];
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  assert.equal(h.snapshot().pendingCompletion.duration, 1);
  assert.equal(h.records.length, 0, 'a normal completion remains a confirmation draft');
});

test('saved or cold-restored completions never replay a deferred cue', () => {
  const h = harness();
  h.start(60);
  h.detach();
  h.advance(60000);
  const reopened = harness({ initialStorage: h.data() });
  assert.deepEqual(reopened.events.map(item => item.event.type), ['restore']);
  h.controller.markCompletionSaved('session-one');
  const events = [];
  const detach = h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  detach();
  assert.equal(h.start(420, 'new-session'), true);
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore', 'restore']);
});

test('manual finish without a page is a draft but never a deferred natural completion cue', () => {
  const h = harness();
  h.start();
  h.detach();
  h.advance(125000);
  h.controller.finish('manual');
  const events = [];
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
});
