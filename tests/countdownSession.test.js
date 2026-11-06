const test = require('node:test');
const assert = require('node:assert/strict');
const { createCountdownSessionController } = require('../miniprogram/utils/countdownSession');

const INITIAL_TIME = Date.parse('2026-10-23T08:00:00+08:00');

function harness({ initialStorage = {}, initialTime = INITIAL_TIME, recordCheckin, isCompletionRecorded, failRead, failWrite, failSchedule, apiOverrides = {} } = {}) {
  let currentTime = initialTime;
  let timerId = 0;
  const timers = new Map();
  const storage = new Map(Object.entries(structuredClone(initialStorage)));
  const writes = [];
  const records = [];
  const events = [];
  const api = {
    getStorageSync(key) {
      if (failRead && failRead(key)) throw new Error('storage read unavailable');
      return structuredClone(storage.get(key));
    },
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
    isCompletionRecorded,
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

test('closing the app without a page ends and automatically records the actual countdown duration once', () => {
  for (const reason of [0, 1]) {
    const h = harness();
    h.start();
    h.advance(65000);
    const queuedTick = h.dropTicker();
    h.detach();
    h.controller.appHide({ reason });
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.snapshot().remainingTime, 355);
    assert.equal(h.storage.get('timerState').status, 'completed');
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
    assert.deepEqual(h.records, [[1, [], [], INITIAL_TIME + 65000, 'session-one']]);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.match(h.snapshot().completionNotice, /1分钟已存本机/);
    assert.equal(h.timers.size, 0);
    h.advance(45000);
    h.controller.appShow();
    queuedTick();
    h.controller.attach(() => {});
    h.controller.appHide({ reason });
    h.advance(310000);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.snapshot().elapsedTime, 65);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.records.length, 1);
    assert.equal(h.timers.size, 0);
    const reopened = harness({ initialStorage: h.data(), initialTime: h.now() });
    assert.equal(reopened.snapshot().isRunning, false);
    assert.equal(reopened.snapshot().pendingCompletion, null);
    assert.equal(reopened.records.length, 0);
  }
});

test('page and app exit finishes save running and paused countdowns before publishing their terminal event', () => {
  for (const reason of ['page_unload', 'app_hide']) {
    for (const paused of [false, true]) {
      const h = harness();
      h.start(); h.advance(125000);
      if (paused) { h.controller.pause(); h.advance(3600000); }
      const endedAt = h.now();
      const queued = [...h.timers.values()].map(timer => timer.callback);
      const completion = h.controller.finish(reason);
      assert.deepEqual(completion, { sessionId: 'session-one', duration: 2, endedAt, text: '' });
      assert.deepEqual(h.records, [[2, [], [], endedAt, 'session-one']]);
      const { snapshot, event } = h.events.at(-1);
      assert.equal(event.type, 'complete');
      assert.equal(event.reason, reason);
      assert.equal(event.automatic, true);
      assert.equal(event.autoSaved, true);
      assert.equal(snapshot.pendingCompletion, null);
      assert.equal(snapshot.isRunning, false);
      assert.equal(snapshot.isPaused, false);
      assert.equal(snapshot.elapsedTime, 125);
      assert.equal(h.storage.get('timerPendingCompletion'), null);
      assert.equal(h.storage.get('timerState').pendingCompletion, null);
      assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
      assert.equal(h.timers.size, 0);
      assert.equal(h.controller.finish(reason), null);
      h.controller.appHide({ reason: 0 }); h.controller.appShow();
      h.advance(3600000); queued.forEach(callback => callback());
      assert.equal(h.records.length, 1);
      assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
    }
  }
});

test('exit intent and its retry draft are durable before reentrant record writes or broken page listeners', () => {
  let h;
  h = harness({ recordCheckin() {
    assert.equal(h.storage.get('timerState').status, 'completed');
    assert.equal(h.storage.get('timerState').pendingCompletion.sessionId, 'session-one');
    assert.equal(h.storage.get('timerPendingCompletion').sessionId, 'session-one');
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
    assert.equal(h.controller.finish('page_unload'), null);
    assert.equal(h.controller.appHide({ reason: 0 }), null);
    assert.equal(h.start(420, 'reentrant-session'), false, 'an in-progress save cannot be replaced');
    return { success: true };
  } });
  h.controller.attach((snapshot, event) => {
    if (event.type !== 'complete') return;
    assert.equal(event.autoSaved, true);
    assert.equal(snapshot.pendingCompletion, null);
    assert.equal(h.records.length, 1);
    assert.equal(h.controller.finish('app_hide'), null);
    throw new Error('page already unloading');
  });
  h.start(); h.advance(125000); h.controller.finish('page_unload');
  assert.equal(h.records.length, 1);
  assert.equal(h.snapshot().pendingCompletion, null);
  assert.equal(h.storage.get('timerState').pendingCompletion, null);
  assert.ok(h.storage.get('timerDiagnostics').some(item => item.type === 'listener_error'));
});

test('failed exit saves preserve a recoverable draft without reviving or automatically resubmitting the countdown', () => {
  for (const throws of [false, true]) {
    for (const failDraftWrite of [false, true]) {
      const h = harness({
        failWrite: (key, value) => failDraftWrite && key === 'timerPendingCompletion' && !!value,
        recordCheckin() {
          if (throws) throw new Error('disk busy');
          return { success: false };
        }
      });
      h.start(); h.advance(125000);
      h.controller.finish('page_unload');
      const completion = { sessionId: 'session-one', duration: 2, endedAt: h.now(), text: '' };
      assert.deepEqual(h.snapshot().pendingCompletion, completion);
      assert.deepEqual(h.storage.get('timerState').pendingCompletion, completion);
      assert.equal(h.events.at(-1).event.automatic, true);
      assert.equal(h.events.at(-1).event.autoSaved, false);
      assert.match(h.snapshot().completionNotice, /请确认保存记录/);
      h.controller.finish('page_unload'); h.controller.appHide({ reason: 0 });
      h.controller.appShow(); h.advance(3600000);
      assert.equal(h.records.length, 1, 'failed exit writes wait for the existing confirmation retry');
      assert.equal(h.snapshot().isRunning, false);
      const reopened = harness({ initialStorage: h.data(), initialTime: h.now() });
      assert.deepEqual(reopened.snapshot().pendingCompletion, completion);
      assert.equal(reopened.records.length, 0);
      assert.equal(reopened.start(420, 'another-session'), false);
      assert.equal(reopened.controller.markCompletionSaved(completion.sessionId), true);
      assert.equal(reopened.snapshot().pendingCompletion, null);
      assert.equal(reopened.storage.get('timerPendingEndReminder') == null, true);
      assert.equal(reopened.start(420, 'another-session'), true);
    }
  }
});

test('page and app exit races cap their automatic record at the configured countdown deadline', () => {
  for (const first of ['page_unload', 'app_hide']) {
    const h = harness();
    h.start(86400); h.jump(86401000);
    h.controller.finish(first);
    h.controller.finish(first === 'page_unload' ? 'app_hide' : 'page_unload');
    h.controller.appHide({ reason: 0 }); h.controller.tick();
    assert.deepEqual(h.records, [[1440, [], [], INITIAL_TIME + 86400000, 'session-one']]);
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.snapshot().elapsedTime, 86400);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  }
});

test('system background reasons retain one countdown and include interruption time on return', () => {
  for (const options of [{ reason: 2 }, { reason: 3 }, undefined, null, {}]) {
    const h = harness();
    h.start();
    h.advance(65000);
    const oldCallbacks = [...h.timers.values()].map(item => item.callback);
    h.controller.appHide(options);
    assert.equal(h.snapshot().status, 'running');
    assert.equal(h.snapshot().interrupted, true);
    assert.equal(h.storage.get('timerState').elapsedTime, 65);
    assert.equal(h.storage.get('timerState').saveTime, INITIAL_TIME + 65000);
    assert.equal(h.records.length, 0);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.timers.size, 0, 'no background ticker is required');
    h.advance(45000);
    oldCallbacks.forEach(callback => callback());
    assert.equal(h.events.filter(item => item.event.type === 'complete').length, 0);
    h.controller.appShow();
    const eventsAfterShow = h.events.length;
    oldCallbacks.forEach(callback => callback());
    assert.equal(h.events.length, eventsAfterShow, 'pre-interruption callbacks stay invalid after return');
    assert.equal(h.snapshot().sessionId, 'session-one');
    assert.equal(h.snapshot().elapsedTime, 110);
    assert.equal(h.snapshot().remainingTime, 310);
    assert.equal(h.snapshot().interrupted, false);
    assert.equal(h.records.length, 0);
    assert.equal([...h.timers.values()].filter(item => item.delay === 1000).length, 1);
    h.advance(1000);
    assert.equal(h.events.at(-1).snapshot.elapsedTime, 111);
  }
});

test('repeated interruption callbacks preserve the original recovery boundary and never save a record', () => {
  const h = harness();
  h.start(); h.advance(65500);
  h.controller.appHide({ reason: 3 });
  const firstCheckpoint = structuredClone(h.storage.get('timerState'));
  h.jump(45000);
  h.controller.appHide({ reason: 2 });
  h.controller.appHide();
  h.controller.tick();
  assert.deepEqual(h.storage.get('timerState'), firstCheckpoint);
  assert.equal(h.records.length, 0);
  assert.equal(h.timers.size, 0);
  h.controller.appShow();
  h.controller.appShow();
  assert.equal(h.snapshot().elapsedTime, 110);
  assert.equal([...h.timers.values()].filter(item => item.delay === 1000).length, 1);
});

test('an interrupted paused countdown stays paused and excludes the call when manually resumed', () => {
  const h = harness();
  h.start(); h.advance(65000); h.controller.pause();
  const pauseTimestamp = h.snapshot().pauseTimestamp;
  h.controller.appHide({ reason: 3 });
  h.advance(90000);
  h.controller.appShow();
  assert.equal(h.snapshot().status, 'paused');
  assert.equal(h.snapshot().elapsedTime, 65);
  assert.equal(h.snapshot().pauseTimestamp, pauseTimestamp);
  assert.equal(h.timers.size, 0);
  assert.equal(h.records.length, 0);
  h.controller.resume(); h.advance(1000);
  assert.equal(h.snapshot().elapsedTime, 66);
  assert.equal(h.snapshot().totalPausedTime, 90000);
});

test('a countdown reaching its deadline during an interruption completes once at its original end', () => {
  const h = harness();
  h.start(120); h.advance(65000);
  h.controller.appHide({ reason: 3 });
  h.advance(90000);
  assert.equal(h.snapshot().status, 'running', 'background wall time waits for foreground reconciliation');
  assert.equal(h.records.length, 0);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 0);
  h.controller.appShow();
  h.controller.appShow(); h.controller.tick();
  assert.equal(h.snapshot().status, 'completed');
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
  assert.equal(h.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 120000);
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.records.length, 0, 'completion retains the normal confirmation flow');
  assert.equal(h.timers.size, 0);
});

test('a completed interrupted countdown with no page preserves its draft and durable end reminder', () => {
  const h = harness();
  h.start(120); h.advance(65000); h.detach();
  h.controller.appHide({ reason: 3 });
  h.advance(90000); h.controller.appShow();
  const events = [];
  const detach = h.controller.attach((snapshot, event) => events.push({ snapshot, event }));
  assert.equal(events[0].event.type, 'restore');
  assert.equal(events[0].snapshot.pendingCompletion.endedAt, INITIAL_TIME + 120000);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  detach();
  h.controller.attach((snapshot, event) => events.push({ snapshot, event }));
  assert.equal(events.at(-1).event.type, 'restore');
  assert.equal(events.filter(item => item.event.type === 'complete').length, 0);
});

test('cold startup after an interruption completes an expired running sit and retains a manual pause', () => {
  for (const paused of [false, true]) {
    const h = harness();
    h.start(); h.advance(65000);
    if (paused) h.controller.pause();
    h.controller.appHide({ reason: 3 });
    h.advance(3600000);
    h.controller.appHide({ reason: 3 });
    const reopened = harness({ initialStorage: h.data(), initialTime: h.now() });
    assert.equal(reopened.snapshot().status, paused ? 'paused' : 'completed');
    assert.equal(reopened.snapshot().elapsedTime, paused ? 65 : 420);
    assert.equal(reopened.snapshot().remainingTime, paused ? 355 : 0);
    assert.equal(reopened.snapshot().sessionId, 'session-one');
    assert.equal(reopened.snapshot().completionNotice, '');
    assert.equal(reopened.records.length, 0);
    if (!paused) {
      assert.equal(reopened.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 420000);
      assert.equal(reopened.storage.get('timerPendingEndReminder').sessionId, 'session-one');
      reopened.controller.appShow(); reopened.controller.tick(); reopened.controller.restore();
      assert.equal(reopened.records.length, 0);
      assert.equal(reopened.snapshot().pendingCompletion.duration, 7);
      continue;
    }
    assert.equal(reopened.storage.get('timerPendingEndReminder'), undefined);
    reopened.controller.appShow(); reopened.controller.tick();
    reopened.advance(3600000);
    assert.equal(reopened.snapshot().elapsedTime, 65);
    assert.equal(reopened.timers.size, 0);
    reopened.controller.resume(); reopened.advance(354999);
    assert.equal(reopened.snapshot().isRunning, true);
    reopened.advance(1);
    assert.equal(reopened.snapshot().pendingCompletion.duration, 7);
    assert.equal(reopened.records.length, 0);
  }
});

test('an explicit close after a system interruption ends and records the countdown at the exit boundary', () => {
  for (const reason of [0, 1]) {
    const h = harness();
    h.start(); h.advance(65000);
    h.controller.appHide({ reason: 3 });
    h.advance(30000);
    h.controller.appHide({ reason });
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.snapshot().elapsedTime, 95);
    assert.equal(h.storage.get('timerState').elapsedTime, 95);
    assert.deepEqual(h.records, [[1, [], [], INITIAL_TIME + 95000, 'session-one']]);
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
    h.controller.appShow(); h.advance(325000);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.records.length, 1);
    assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  }
});

test('terminal state and its reminder are durable before a completion listener can fail or re-enter', () => {
  const h = harness();
  h.controller.attach((snapshot, event) => {
    if (event.type === 'complete') {
      assert.equal(h.storage.get('timerState').status, 'completed');
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
      assert.equal(h.controller.finish('manual'), null);
      h.controller.appHide({ reason: 0 });
      throw new Error('unloaded page cannot render');
    }
  });
  h.start();
  h.advance(125000);
  h.controller.finish('manual');
  assert.equal(h.records.length, 0);
  assert.equal(h.snapshot().status, 'completed');
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
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

test('closing a paused countdown excludes paused wall time and saves the actual duration', () => {
  const h = harness();
  h.start();
  h.advance(125000);
  h.controller.pause();
  h.advance(3600000);
  h.controller.appHide({ reason: 0 });
  h.controller.appShow();
  assert.equal(h.snapshot().isPaused, false);
  assert.equal(h.snapshot().elapsedTime, 125);
  assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
  h.controller.resume();
  assert.deepEqual(h.records, [[2, [], [], INITIAL_TIME + 3725000, 'session-one']]);
  assert.equal(h.snapshot().isPaused, false);
  assert.equal(h.snapshot().isRunning, false);
  h.advance(295000);
  assert.equal(h.snapshot().pendingCompletion, null);
  assert.equal(h.records.length, 1);
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
  h.controller.appHide({ reason: 0 });
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
    h.controller.appHide({ reason: 0 });
    h.controller.appShow();
    queued.forEach(callback => callback());
    assert.equal(h.snapshot().status, 'cancelled');
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
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
    if (exitFirst) { h.controller.appHide({ reason: 0 }); h.controller.tick(); }
    else { h.controller.tick(); h.controller.appHide({ reason: 0 }); }
    h.controller.appShow();
    assert.equal(h.records.length, exitFirst ? 1 : 0, 'only an active session exits automatically; existing completion drafts retain confirmation');
    assert.equal(h.events.filter(item => ['complete', 'exit'].includes(item.event.type)).length, 1);
    const completion = h.events.find(item => ['complete', 'exit'].includes(item.event.type)).event.completion;
    assert.equal(completion.duration, 1);
    assert.equal(completion.endedAt, INITIAL_TIME + 60000);
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
  }
});

test('reminder storage failure cannot discard the completed draft or stop terminal callbacks', () => {
  const h = harness({ failWrite: key => key === 'timerPendingEndReminder' });
  h.start();
  h.advance(125000);
  h.controller.finish('manual');
  assert.equal(h.snapshot().status, 'completed');
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, 'session-one');
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  h.controller.appShow();
  h.controller.tick();
  assert.equal(h.start(420, 'another'), false);
  const reopened = harness({ initialStorage: h.data(), initialTime: INITIAL_TIME + 86400000 });
  assert.equal(reopened.records.length, 0, 'cold restore presents the existing draft instead of saving again');
  assert.equal(reopened.snapshot().pendingCompletion.duration, 2);
  assert.equal(reopened.snapshot().isRunning, false);
});

test('legacy and current running checkpoints count time across runtimes while manual pauses remain paused', () => {
  for (const paused of [false, true]) {
    for (const current of [false, true]) {
      const state = checkpoint({ isRunning: !paused, isPaused: paused,
        pauseTimestamp: paused ? INITIAL_TIME : 0,
        ...(current ? { schemaVersion: 2, runtimeId: 'previous-runtime', status: paused ? 'paused' : 'running' } : {}) });
      const h = harness({ initialStorage: { timerState: state }, initialTime: INITIAL_TIME + 60000 });
      assert.equal(h.records.length, 0);
      assert.equal(h.snapshot().elapsedTime, paused ? 125 : 185);
      assert.equal(h.snapshot().status, paused ? 'paused' : 'running');
      assert.equal(h.snapshot().remainingTime, paused ? 295 : 235);
      assert.equal(h.snapshot().sessionId, 'old-session');
      assert.equal(h.storage.get('timerState').status, paused ? 'paused' : 'running');
      h.controller.restore();
      h.controller.attach(() => {});
      assert.equal(h.records.length, 0);
      assert.equal(h.timers.size, paused ? 0 : 2);
      h.controller.resume(); h.advance((paused ? 295000 : 235000) - 1);
      assert.equal(h.snapshot().isRunning, true);
      h.advance(1);
      assert.equal(h.snapshot().pendingCompletion.duration, 7);
      assert.equal(h.records.length, 0);
    }
  }
});

test('cold recovery derives running time from the original clock even if the saved tick was stale', () => {
  const h = harness({ initialStorage: { timerState: checkpoint({ elapsedTime: 120 }) },
    initialTime: INITIAL_TIME + 60000 });
  assert.equal(h.snapshot().elapsedTime, 185);
  assert.equal(h.snapshot().remainingTime, 235);
  assert.equal(h.snapshot().isRunning, true);
  h.advance(234999);
  assert.equal(h.snapshot().isRunning, true);
  h.advance(1);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
});

test('process reclamation without a hide callback keeps the original deadline and session after multiple restarts', () => {
  const original = harness();
  original.start(); original.advance(67321);
  const saved = original.data();
  assert.equal(saved.timerState.elapsedTime, 65, 'the last durable tick can predate process reclamation');
  original.controller.dispose();
  const reopened = harness({ initialStorage: saved, initialTime: INITIAL_TIME + 125000 });
  assert.equal(reopened.snapshot().status, 'running');
  assert.equal(reopened.snapshot().elapsedTime, 125);
  assert.equal(reopened.snapshot().startTimestamp, INITIAL_TIME);
  assert.equal(reopened.snapshot().sessionId, 'session-one');
  reopened.advance(23000); reopened.controller.dispose();
  const finalRuntime = harness({ initialStorage: reopened.data(), initialTime: INITIAL_TIME + 300000 });
  assert.equal(finalRuntime.snapshot().elapsedTime, 300);
  finalRuntime.advance(120000);
  assert.equal(finalRuntime.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 420000);
  assert.equal(finalRuntime.snapshot().pendingCompletion.duration, 7);
  assert.equal(finalRuntime.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(finalRuntime.records.length, 0);
});

test('cold continuation preserves accumulated manual pauses instead of moving the countdown deadline', () => {
  const h = harness();
  h.start(); h.advance(65000); h.controller.pause();
  h.advance(30000); h.controller.resume(); h.advance(20000);
  const reopened = harness({ initialStorage: h.data(), initialTime: INITIAL_TIME + 180000 });
  assert.equal(reopened.snapshot().status, 'running');
  assert.equal(reopened.snapshot().totalPausedTime, 30000);
  assert.equal(reopened.snapshot().elapsedTime, 150);
  reopened.advance(270000);
  assert.equal(reopened.snapshot().pendingCompletion.endedAt, INITIAL_TIME + 450000);
  assert.equal(reopened.snapshot().pendingCompletion.duration, 7);
});

test('a cold clock rollback preserves confirmed progress for running and manually paused sessions', () => {
  for (const paused of [false, true]) {
    const state = checkpoint({ isRunning: !paused, isPaused: paused,
      pauseTimestamp: paused ? INITIAL_TIME - 30000 : 0,
      elapsedTime: paused ? 95 : 125 });
    const h = harness({ initialStorage: { timerState: state }, initialTime: INITIAL_TIME - 3600000 });
    assert.equal(h.snapshot().status, paused ? 'paused' : 'running');
    assert.equal(h.snapshot().elapsedTime, paused ? 95 : 125);
    assert.equal(h.snapshot().startTimestamp, state.startTimestamp - 3600000);
    const reopened = harness({ initialStorage: h.data(), initialTime: h.now() + 10000 });
    assert.equal(reopened.snapshot().elapsedTime, paused ? 95 : 135);
    assert.equal(reopened.storage.get('timerDiagnostics').some(item => item.type === 'invalid_checkpoint'), false);
    reopened.controller.resume();
    reopened.advance((paused ? 325 : 285) * 1000);
    assert.equal(reopened.snapshot().pendingCompletion.duration, 7);
  }
});

test('an expired cold checkpoint queues one completion that remains stable across later restarts', () => {
  const h = harness({ initialStorage: { timerState: checkpoint() }, initialTime: INITIAL_TIME + 86400000 });
  const completion = h.snapshot().pendingCompletion;
  assert.deepEqual(completion, { sessionId: 'old-session', duration: 7,
    endedAt: INITIAL_TIME + 295000, text: '' });
  const reopened = harness({ initialStorage: h.data(), initialTime: h.now() + 86400000 });
  assert.deepEqual(reopened.snapshot().pendingCompletion, completion);
  assert.equal(reopened.records.length, 0);
  assert.equal(reopened.writes.filter(item => item.key === 'timerPendingEndReminder').length, 0);
  assert.equal(reopened.controller.markCompletionSaved('old-session'), true);
  const saved = harness({ initialStorage: reopened.data(), initialTime: reopened.now() + 86400000 });
  assert.equal(saved.snapshot().pendingCompletion, null);
  assert.equal(saved.snapshot().isRunning, false);
  assert.equal(saved.records.length, 0);
});

test('a checkpoint already confirmed at its deadline completes and queues its bell on cold startup', () => {
  for (const totalTime of [2, 120]) {
    const state = checkpoint({ elapsedTime: totalTime, totalTime,
      startTimestamp: INITIAL_TIME - totalTime * 1000,
      schemaVersion: 2, runtimeId: 'previous-runtime', status: 'running' });
    const h = harness({ initialStorage: { timerState: state }, initialTime: INITIAL_TIME + 3600000 });
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.snapshot().remainingTime, 0);
    assert.equal(h.snapshot().pendingCompletion?.duration || 0, Math.floor(totalTime / 60));
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'old-session');
    assert.equal(h.records.length, 0);
    const cueWrite = h.writes.findIndex(item => item.key === 'timerPendingEndReminder');
    const terminalWrite = h.writes.findIndex(item => item.key === 'timerState' && item.value.status === 'completed');
    assert.ok(cueWrite >= 0 && cueWrite < terminalWrite, 'persist the bell before the terminal checkpoint');
  }
});

test('a clock rollback while paused cannot make resumed or cold-restored checkpoints invalid', () => {
  const h = harness();
  h.start(); h.advance(125000); h.controller.pause(); h.jump(-3600000);
  h.controller.resume();
  assert.equal(h.snapshot().elapsedTime, 125);
  const reopened = harness({ initialStorage: h.data(), initialTime: h.now() });
  assert.equal(reopened.snapshot().status, 'running');
  assert.equal(reopened.snapshot().elapsedTime, 125);
  const secondRecovery = harness({ initialStorage: reopened.data(), initialTime: reopened.now() - 3600000 });
  assert.equal(secondRecovery.snapshot().status, 'running');
  assert.equal(secondRecovery.snapshot().elapsedTime, 125);
  secondRecovery.controller.resume(); secondRecovery.advance(295000);
  assert.equal(secondRecovery.snapshot().pendingCompletion.duration, 7);
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

test('sub-minute natural completion can ring while explicit app exits end silently without recording', () => {
  const natural = harness();
  natural.start(2); natural.advance(2000);
  assert.equal(natural.events.at(-1).event.completion, null);
  assert.equal(natural.records.length, 0);
  assert.equal(natural.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  for (const reason of [0, 1]) {
    const h = harness();
    h.start(); h.advance(59000); h.controller.appHide({ reason });
    assert.equal(h.records.length, 0);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
    h.controller.appShow(); h.controller.finish('manual');
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
  }
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

test('disabling recovery does not turn a system interruption into an early completion', () => {
  const h = harness();
  h.start();
  h.controller.setRecoveryEnabled(false);
  assert.equal([...h.timers.values()].filter(item => item.delay === 5000).length, 0);
  h.advance(65000);
  h.controller.appHide({ reason: 3 });
  assert.equal(h.records.length, 0);
  h.controller.appShow();
  h.controller.setRecoveryEnabled(true);
  assert.equal(h.snapshot().isRunning, true);
  h.advance(355000);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
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
  for (const reason of [undefined, 'deadline', 'timeout', 'unknown']) {
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

test('natural completion without a page persists its reminder independently of later attaches', () => {
  const h = harness();
  h.start(60);
  h.advance(55000);
  h.detach();
  h.advance(10000);
  assert.equal(h.snapshot().pendingCompletion.duration, 1);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  const reminderWrites = h.writes.filter(item => item.key === 'timerPendingEndReminder').length;
  const nextEvents = [];
  const detach = h.controller.attach((snapshot, event) => nextEvents.push({ snapshot, event }));
  assert.equal(nextEvents.length, 1);
  assert.equal(nextEvents[0].event.type, 'restore');
  assert.equal(nextEvents[0].event.completion.endedAt, INITIAL_TIME + 60000);
  detach();
  h.controller.attach((snapshot, event) => nextEvents.push({ snapshot, event }));
  assert.equal(nextEvents.at(-1).event.type, 'restore');
  assert.equal(nextEvents.filter(item => item.event.type === 'complete').length, 0);
  assert.equal(h.writes.filter(item => item.key === 'timerPendingEndReminder').length, reminderWrites);
  assert.equal(h.records.length, 0);
});

test('nested attaches cannot queue duplicate reminders for an already completed countdown', () => {
  const h = harness();
  h.start(60);
  h.detach();
  h.advance(60000);
  const events = [];
  const reminderWrites = h.writes.filter(item => item.key === 'timerPendingEndReminder').length;
  h.controller.attach((snapshot, event) => {
    events.push(event.type);
    h.controller.attach((_, nested) => events.push(nested.type));
  });
  assert.deepEqual(events, ['restore', 'restore']);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  assert.equal(h.writes.filter(item => item.key === 'timerPendingEndReminder').length, reminderWrites);
});

test('explicit app hides dismiss an unplayed bell but preserve its completed confirmation draft', () => {
  const h = harness();
  h.start(60); h.detach(); h.advance(60000);
  h.controller.appHide({ reason: 0 }); h.controller.appHide({ reason: 1 }); h.controller.appShow();
  const events = [];
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  assert.equal(h.snapshot().pendingCompletion.duration, 1);
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
  assert.equal(h.records.length, 0, 'a normal completion remains a confirmation draft');
});

test('saving or cold-restoring a completion preserves its unplayed bell without queuing another', () => {
  const h = harness();
  h.start(60);
  h.detach();
  h.advance(60000);
  const reopened = harness({ initialStorage: h.data() });
  assert.deepEqual(reopened.events.map(item => item.event.type), ['restore']);
  assert.equal(reopened.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  assert.equal(reopened.writes.filter(item => item.key === 'timerPendingEndReminder').length, 0);
  h.controller.markCompletionSaved('session-one');
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
  const events = [];
  const detach = h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  detach();
  assert.equal(h.start(420, 'new-session'), true);
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore', 'restore']);
});

test('manual finish without a page still preserves the draft and a durable end bell', () => {
  const h = harness();
  h.start();
  h.detach();
  h.advance(125000);
  h.controller.finish('manual');
  const events = [];
  h.controller.attach((snapshot, event) => events.push(event.type));
  assert.deepEqual(events, ['restore']);
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
});


test('passive app hide reasons retain an unplayed completion bell until the timer page can resume it', () => {
  for (const options of [{ reason: 2 }, { reason: 3 }, {}, undefined, null]) {
    const h = harness();
    h.start(60); h.advance(60000);
    h.controller.appHide(options); h.controller.appShow();
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
    assert.equal(h.snapshot().pendingCompletion.duration, 1);
    assert.equal(h.records.length, 0);
  }
});

test('automatic exit requests save actual whole minutes without queueing a closing bell', () => {
  for (const seconds of [0, 59, 60, 119]) {
    for (const reason of ['page_unload', 'app_hide']) {
      const h = harness();
      h.start(); h.advance(seconds * 1000); h.controller.finish(reason);
      assert.equal(h.records.length, seconds >= 60 ? 1 : 0);
      if (seconds >= 60) assert.equal(h.records[0][0], Math.floor(seconds / 60));
      assert.equal(h.snapshot().isRunning, false);
      assert.equal(h.snapshot().pendingCompletion, null);
      assert.equal(h.storage.get('timerPendingEndReminder'), undefined);
      assert.match(h.snapshot().completionNotice, seconds < 60 ? /不足1分钟未记录/ : /1分钟已存本机/);
      h.advance((420 - seconds) * 1000); h.controller.appShow();
      assert.equal(h.records.length, seconds >= 60 ? 1 : 0);
    }
  }
});

test('a running clock rollback produces a valid checkpoint and cold recovery preserves its manual-pause state', () => {
  for (const rollback of [5000, 3600000]) {
    for (const paused of [false, true]) {
      for (const options of [{ reason: 3 }, undefined]) {
        const h = harness();
        h.start(); h.advance(65000);
        if (paused) h.controller.pause();
        h.jump(-rollback); h.controller.appHide(options);
        const saved = h.storage.get('timerState');
        assert.equal(saved.sessionId, 'session-one');
        assert.equal(saved.elapsedTime, 65);
        assert.equal(saved.status, paused ? 'paused' : 'running');
        assert.equal(saved.saveTime >= saved.startTimestamp, true);
        const confirmedAt = saved.isPaused ? saved.pauseTimestamp : saved.saveTime;
        assert.equal(Math.floor((confirmedAt - saved.startTimestamp - saved.totalPausedTime) / 1000), 65);
        const cold = harness({ initialStorage: h.data(), initialTime: h.now() + 45000 });
        assert.equal(cold.snapshot().status, paused ? 'paused' : 'running');
        assert.equal(cold.snapshot().sessionId, 'session-one');
        assert.equal(cold.snapshot().elapsedTime, paused ? 65 : 110);
        assert.equal(cold.snapshot().remainingTime, paused ? 355 : 310);
        assert.equal(cold.snapshot().pendingCompletion, null);
        assert.equal(cold.records.length, 0);
        assert.equal(cold.storage.get('timerPendingEndReminder'), undefined);
        assert.equal(cold.storage.get('timerDiagnostics').some(item => item.type === 'invalid_checkpoint'), false);
        cold.controller.resume(); cold.advance((paused ? 355000 : 310000) - 1);
        assert.equal(cold.snapshot().status, 'running');
        cold.advance(1);
        assert.equal(cold.snapshot().pendingCompletion.duration, 7);
        assert.equal(cold.storage.get('timerPendingEndReminder').sessionId, 'session-one');
        assert.equal(cold.records.length, 0);
        assert.equal(cold.events.filter(item => item.event.type === 'complete').length, 1);
      }
    }
  }
});

test('a clock rollback before a call keeps all subsequent ringing time in the same running countdown', () => {
  for (const rollback of [5000, 3600000]) {
    const h = harness();
    h.start(); h.advance(65000);
    const originalStart = h.snapshot().startTimestamp;
    h.jump(-rollback); h.controller.appHide({ reason: 3 });
    assert.equal(h.snapshot().startTimestamp, originalStart - rollback);
    assert.equal(h.snapshot().elapsedTime, 65);
    h.advance(45000); h.controller.appShow();
    assert.equal(h.snapshot().status, 'running');
    assert.equal(h.snapshot().sessionId, 'session-one');
    assert.equal(h.snapshot().elapsedTime, 110);
    assert.equal(h.snapshot().remainingTime, 310);
    assert.equal(h.records.length, 0);
    assert.equal(h.snapshot().pendingCompletion, null);
    h.advance(309999);
    assert.equal(h.snapshot().status, 'running');
    h.advance(1);
    assert.equal(h.snapshot().pendingCompletion.duration, 7);
    assert.equal(h.snapshot().pendingCompletion.endedAt, originalStart - rollback + 420000);
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
    assert.equal(h.records.length, 0);
  }
});

test('a paused clock rollback retains the manual pause through a passive call and resumes once', () => {
  const h = harness();
  h.start(); h.advance(65000); h.controller.pause();
  h.jump(-3600000); h.controller.appHide({ reason: 3 });
  h.advance(45000); h.controller.appShow();
  assert.equal(h.snapshot().isPaused, true);
  assert.equal(h.snapshot().elapsedTime, 65);
  const shiftedStart = h.snapshot().startTimestamp;
  h.controller.resume(); h.advance(355000);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
  assert.equal(h.snapshot().pendingCompletion.endedAt, shiftedStart + 45000 + 420000);
  assert.equal(h.records.length, 0);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'session-one');
});

test('observing the same rolled-back timestamp repeatedly cannot shift a countdown more than once', () => {
  const h = harness();
  h.start(); h.advance(65000);
  const originalStart = h.snapshot().startTimestamp;
  h.jump(-5000);
  const first = h.snapshot();
  h.snapshot(); h.controller.tick(); h.controller.appHide({ reason: 3 }); h.snapshot();
  assert.equal(first.startTimestamp, originalStart - 5000);
  assert.equal(h.snapshot().startTimestamp, first.startTimestamp);
  assert.equal(h.snapshot().elapsedTime, 65);
  assert.equal(h.storage.get('timerDiagnostics').filter(item => item.type === 'clock_rollback').length, 1);
  h.controller.appShow(); h.advance(355000);
  assert.equal(h.snapshot().pendingCompletion.duration, 7);
  assert.equal(h.records.length, 0);
});

test('failed critical recovery reads stay retryable through restore, attach, appShow and start', () => {
  for (const failedKey of ['timerState', 'timerPendingCompletion']) {
    for (const retry of ['restore', 'attach', 'appShow', 'start']) {
      let unavailable = true;
      const saved = checkpoint();
      const h = harness({ initialStorage: { timerState: saved },
        failRead: key => unavailable && key === failedKey });
      assert.equal(h.snapshot().restorePending, true);
      assert.equal(h.snapshot().status, 'idle');
      assert.deepEqual(h.storage.get('timerState'), saved);
      assert.equal(h.records.length, 0);
      assert.equal(h.timers.size, 0);
      unavailable = false;
      if (retry === 'attach') h.controller.attach(() => {});
      else if (retry === 'start') assert.equal(h.start(60, 'replacement'), false);
      else h.controller[retry]();
      assert.equal(h.snapshot().restorePending, false, `${failedKey}/${retry}`);
      assert.equal(h.snapshot().status, 'running');
      assert.equal(h.snapshot().sessionId, 'old-session');
      assert.equal(h.snapshot().elapsedTime, 125);
      assert.equal(h.snapshot().remainingTime, 295);
      assert.equal(h.snapshot().pendingCompletion, null);
      assert.equal(h.records.length, 0);
      if (retry === 'appShow') {
        assert.equal(h.events.at(-1).event.type, 'restore');
        assert.equal(h.events.at(-1).snapshot.sessionId, 'old-session');
      }
      h.controller.resume(); h.advance(295000);
      assert.equal(h.snapshot().pendingCompletion.duration, 7);
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, 'old-session');
      assert.equal(h.records.length, 0);
    }
  }
});

test('persistently unreadable recovery keys cannot start over or overwrite an active checkpoint or completion', () => {
  for (const failedKey of ['timerState', 'timerPendingCompletion']) {
    for (const withPending of [false, true]) {
      const saved = checkpoint();
      const pending = { sessionId: 'pending-sit', duration: 2, endedAt: INITIAL_TIME, text: '保留原来的感受' };
      const reminder = { sessionId: 'pending-sit' };
      const initialStorage = { timerState: saved, timerPendingEndReminder: reminder,
        ...(withPending ? { timerPendingCompletion: pending } : {}) };
      const h = harness({ initialStorage, failRead: key => key === failedKey });
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal(h.start(60, `replacement-${attempt}`), false);
        h.controller.restore(); h.controller.attach(() => {}); h.controller.appShow();
        h.controller.tick(); h.advance(60000);
      }
      assert.equal(h.snapshot().restorePending, true);
      assert.equal(h.snapshot().isRunning, false);
      assert.equal(h.snapshot().isPaused, false);
      assert.equal(h.records.length, 0);
      assert.equal(h.timers.size, 0);
      assert.deepEqual(h.storage.get('timerState'), saved);
      assert.deepEqual(h.storage.get('timerPendingCompletion'), withPending ? pending : undefined);
      assert.deepEqual(h.storage.get('timerPendingEndReminder'), reminder);
      assert.equal(h.writes.some(item => ['timerState', 'timerPendingCompletion', 'timerPendingEndReminder'].includes(item.key)), false);
    }
  }
});

test('an original completion keeps precedence over a stale active checkpoint after recovery reads succeed', () => {
  for (const failedKey of ['timerState', 'timerPendingCompletion']) {
    let unavailable = true;
    const saved = checkpoint();
    const pending = { sessionId: 'pending-sit', duration: 2, endedAt: INITIAL_TIME, text: '先保存这份完成草稿' };
    const reminder = { sessionId: 'pending-sit' };
    const h = harness({ initialStorage: { timerState: saved, timerPendingCompletion: pending,
      timerPendingEndReminder: reminder }, failRead: key => unavailable && key === failedKey });
    assert.equal(h.start(60, 'replacement'), false);
    assert.deepEqual(h.storage.get('timerState'), saved);
    assert.deepEqual(h.storage.get('timerPendingCompletion'), pending);
    unavailable = false;
    h.controller.appShow();
    assert.equal(h.snapshot().restorePending, false);
    assert.equal(h.snapshot().isRunning, false);
    assert.equal(h.snapshot().isPaused, false);
    assert.deepEqual(h.snapshot().pendingCompletion, pending);
    assert.equal(h.storage.get('timerState'), null);
    assert.deepEqual(h.storage.get('timerPendingEndReminder'), reminder);
    assert.equal(h.start(60, 'replacement'), false);
    assert.equal(h.records.length, 0);
    assert.equal(h.controller.markCompletionSaved('pending-sit'), true);
    assert.equal(h.start(60, 'replacement'), true);
    assert.equal(h.snapshot().sessionId, 'replacement');
    assert.equal(h.records.length, 0);
  }
});

test('a new start refuses unreadable completion storage even after initial empty-state recovery succeeded', () => {
  let unavailable = false;
  const h = harness({ failRead: key => unavailable && key === 'timerPendingCompletion' });
  assert.equal(h.snapshot().restorePending, false);
  const pending = { sessionId: 'another-completion', duration: 2, endedAt: INITIAL_TIME, text: '不要覆盖' };
  h.storage.set('timerPendingCompletion', pending);
  unavailable = true;
  assert.equal(h.start(60, 'replacement'), false);
  assert.equal(h.snapshot().status, 'idle');
  assert.deepEqual(h.storage.get('timerPendingCompletion'), pending);
  assert.equal(h.storage.get('timerState'), undefined);
  assert.equal(h.records.length, 0);
  unavailable = false;
  assert.equal(h.start(60, 'replacement'), false);
  assert.deepEqual(h.snapshot().pendingCompletion, pending);
  assert.equal(h.records.length, 0);
});

test('a saved completion cannot be reclaimed from a stale draft after cleanup fails', () => {
  for (const failedOperation of ['read', 'write']) {
    let failing = false;
    const h = harness({
      failRead: key => failing && failedOperation === 'read' && key === 'timerPendingCompletion',
      failWrite: (key, value) => failing && failedOperation === 'write'
        && key === 'timerPendingCompletion' && value === null
    });
    h.start(60); h.advance(60000);
    failing = true;
    assert.equal(h.controller.markCompletionSaved('session-one'), true);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.storage.get('timerState').pendingCompletion, null);
    assert.equal(h.storage.get('timerPendingCompletion').sessionId, 'session-one');
    failing = false;
    assert.equal(h.start(60, 'next-session'), true, failedOperation);
    assert.equal(h.snapshot().sessionId, 'next-session');
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.storage.get('timerPendingCompletion'), null);
  }
});

test('a durable saved terminal checkpoint supersedes its stale completion draft on cold recovery', () => {
  let failCleanup = false;
  const h = harness({ failWrite: (key, value) => failCleanup
    && key === 'timerPendingCompletion' && value === null });
  h.start(60); h.advance(60000);
  failCleanup = true;
  h.controller.markCompletionSaved('session-one');
  const cold = harness({ initialStorage: h.data(), initialTime: h.now() + 60000 });
  assert.equal(cold.snapshot().pendingCompletion, null);
  assert.equal(cold.snapshot().isRunning, false);
  assert.equal(cold.storage.get('timerPendingCompletion'), null);
  assert.equal(cold.start(60, 'next-session'), true);
  assert.equal(cold.records.length, 0);
});

test('a recovered completion retains its terminal backup until its save acknowledgment is durable', () => {
  const original = harness();
  original.start(60); original.advance(60000);
  let failCleanup = false;
  const reopened = harness({ initialStorage: original.data(), initialTime: original.now(),
    failWrite: (key, value) => failCleanup && key === 'timerPendingCompletion' && value === null });
  failCleanup = true;
  reopened.controller.markCompletionSaved('session-one');
  const cold = harness({ initialStorage: reopened.data(), initialTime: reopened.now() + 60000 });
  assert.equal(cold.snapshot().pendingCompletion, null);
  assert.equal(cold.storage.get('timerPendingCompletion'), null);
  assert.equal(cold.records.length, 0);
});

test('an explicit exit during unreadable recovery settles at its first exit boundary once reads recover', () => {
  for (const failedKey of ['timerState', 'timerPendingCompletion']) {
    for (const paused of [false, true]) {
      for (const expired of [false, true]) {
        let failing = true;
        const saved = checkpoint({ isRunning: !paused, isPaused: paused,
          pauseTimestamp: paused ? INITIAL_TIME - 30000 : 0, elapsedTime: paused ? 95 : 125 });
        const h = harness({ initialStorage: { timerState: saved },
          initialTime: INITIAL_TIME + (expired ? 600000 : 0),
          failRead: key => failing && key === failedKey });
        const exitedAt = h.now();
        h.controller.appHide({ reason: 0 });
        h.jump(300000); h.controller.appHide({ reason: 1 });
        assert.equal(h.snapshot().restorePending, true);
        assert.deepEqual(h.storage.get('timerState'), saved);
        failing = false;
        h.controller.appShow();
        const seconds = paused ? 95 : expired ? 420 : 125;
        const endedAt = !paused && expired ? saved.startTimestamp + 420000 : exitedAt;
        assert.equal(h.snapshot().isRunning, false, `${failedKey}/${paused}/${expired}`);
        assert.equal(h.snapshot().isPaused, false);
        assert.equal(h.snapshot().elapsedTime, seconds);
        assert.deepEqual(h.records, [[Math.floor(seconds / 60), [], [], endedAt, 'old-session']]);
        assert.equal(h.snapshot().pendingCompletion, null);
        assert.equal(h.storage.get('timerPendingEndReminder') == null, true);
        h.controller.appShow(); h.controller.restore(); h.controller.appHide({ reason: 0 });
        assert.equal(h.records.length, 1);
      }
    }
  }
});

test('a recorded completion is not restored from an embedded draft after its terminal acknowledgment write failed', () => {
  let failAcknowledgment = false;
  const h = harness({ failWrite: (key, value) => failAcknowledgment && key === 'timerState'
    && value && value.status === 'completed' && value.pendingCompletion === null });
  h.start(60); h.advance(60000);
  failAcknowledgment = true;
  h.controller.markCompletionSaved('session-one');
  assert.equal(h.storage.get('timerPendingCompletion'), null);
  assert.equal(h.storage.get('timerState').pendingCompletion.sessionId, 'session-one');
  const lookups = [];
  const cold = harness({ initialStorage: h.data(), initialTime: h.now() + 60000,
    isCompletionRecorded(sessionId) { lookups.push(sessionId); return sessionId === 'session-one'; } });
  assert.deepEqual(lookups, ['session-one']);
  assert.equal(cold.snapshot().pendingCompletion, null);
  assert.equal(cold.snapshot().isRunning, false);
  assert.equal(cold.storage.get('timerState').pendingCompletion, null);
  assert.equal(cold.records.length, 0);
  const next = harness({ initialStorage: cold.data(), initialTime: cold.now() + 60000 });
  assert.equal(next.snapshot().pendingCompletion, null);
  assert.equal(next.start(60, 'next-session'), true);
});

test('record lookup must explicitly confirm an embedded draft before recovery may acknowledge it', () => {
  const pending = { sessionId: 'old-session', duration: 2, endedAt: INITIAL_TIME, text: '保留感受' };
  const saved = checkpoint({ schemaVersion: 2, runtimeId: 'previous-runtime', status: 'completed',
    isRunning: false, isPaused: false, pendingCompletion: pending });
  for (const result of [false, undefined, 1, 'true', new Error('record storage unavailable')]) {
    const lookups = [];
    const h = harness({ initialStorage: { timerState: saved }, isCompletionRecorded(sessionId) {
      lookups.push(sessionId);
      if (result instanceof Error) throw result;
      return result;
    } });
    assert.deepEqual(lookups, ['old-session']);
    assert.deepEqual(h.snapshot().pendingCompletion, pending);
    assert.deepEqual(h.storage.get('timerState'), saved);
    assert.deepEqual(h.storage.get('timerPendingCompletion'), pending);
    assert.equal(h.records.length, 0);
    assert.equal(h.start(60, 'replacement'), false);
  }
});

test('a recorded separate draft is acknowledged without discarding another session checkpoint', () => {
  const pending = { sessionId: 'recorded-session', duration: 2, endedAt: INITIAL_TIME, text: '' };
  for (const sameSession of [false, true]) {
    const saved = checkpoint({ sessionId: sameSession ? pending.sessionId : 'another-active-session' });
    const lookups = [];
    const h = harness({ initialStorage: { timerState: saved, timerPendingCompletion: pending },
      isCompletionRecorded(sessionId) { lookups.push(sessionId); return sessionId === pending.sessionId; } });
    assert.deepEqual(lookups, [pending.sessionId]);
    assert.equal(h.snapshot().pendingCompletion, null);
    assert.equal(h.storage.get('timerPendingCompletion'), null);
    assert.equal(h.snapshot().isRunning, !sameSession);
    if (!sameSession) {
      assert.equal(h.snapshot().sessionId, saved.sessionId);
      assert.equal(h.snapshot().elapsedTime, saved.elapsedTime);
    } else assert.equal(h.storage.get('timerState'), null);
    assert.equal(h.records.length, 0);
  }
});

test('an unconfirmed separate draft keeps precedence over another recorded embedded completion', () => {
  const pending = { sessionId: 'unsaved-session', duration: 2, endedAt: INITIAL_TIME, text: '不能删除' };
  const embedded = { sessionId: 'old-session', duration: 2, endedAt: INITIAL_TIME, text: '' };
  const saved = checkpoint({ schemaVersion: 2, runtimeId: 'previous-runtime', status: 'completed',
    isRunning: false, isPaused: false, pendingCompletion: embedded });
  for (const lookupThrows of [false, true]) {
    const lookups = [];
    const h = harness({ initialStorage: { timerState: saved, timerPendingCompletion: pending },
      isCompletionRecorded(sessionId) {
        lookups.push(sessionId);
        if (lookupThrows) throw new Error('read failed');
        return sessionId === embedded.sessionId;
      } });
    assert.deepEqual(lookups, [pending.sessionId]);
    assert.deepEqual(h.snapshot().pendingCompletion, pending);
    assert.deepEqual(h.storage.get('timerPendingCompletion'), pending);
    assert.equal(h.records.length, 0);
  }
});
