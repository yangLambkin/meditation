const test = require('node:test');
const assert = require('node:assert/strict');
const { createCountdownSessionController } = require('../miniprogram/modules/timer/countdownSession');

const START = Date.parse('2026-11-08T08:00:00+08:00');

function harness({ initialStorage = {}, initialTime = START, visible = true, recordCheckin, attach = true } = {}) {
  let at = initialTime;
  let nextTimer = 0;
  const storage = new Map(Object.entries(structuredClone(initialStorage)));
  const timers = new Map();
  const records = [];
  const events = [];
  const controller = createCountdownSessionController({
    api: { getStorageSync: key => structuredClone(storage.get(key)),
      setStorageSync: (key, value) => storage.set(key, structuredClone(value)) },
    now: () => at,
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, due: at + delay }); return id; },
    clearInterval: id => timers.delete(id),
    recordCheckin(...args) { records.push(args); return recordCheckin ? recordCheckin(...args) : { success: true }; }
  });
  if (!visible) controller.appHide({ reason: 2 });
  const detach = attach ? controller.attach((snapshot, event) => events.push({ snapshot, event })) : () => {};
  return {
    controller, storage, timers, records, events, detach,
    start(seconds = 420) { return controller.start({ sessionId: 'same-sitting', totalTime: seconds, startTimestamp: at }); },
    snapshot: () => controller.getSnapshot(),
    saved: () => Object.fromEntries(storage),
    now: () => at,
    jump(milliseconds) { at += milliseconds; },
    advance(milliseconds) {
      const end = at + milliseconds;
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        at = next.due;
        next.due += next.delay;
        next.callback();
      }
      at = end;
    }
  };
}

test('calls, alarms and unknown hide reasons preserve the same countdown and resume elapsed wall time', () => {
  for (const options of [{ reason: 2 }, { reason: 3 }, {}, { reason: 99 }]) {
    const h = harness();
    h.start(); h.advance(65000);
    const staleCallbacks = [...h.timers.values()].map(timer => timer.callback);
    h.controller.appHide(options);
    assert.equal(h.snapshot().isRunning, true);
    assert.equal(h.snapshot().interrupted, true);
    assert.equal(h.storage.get('timerState').interrupted, true);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.records, []);
    h.jump(60000);
    staleCallbacks.forEach(callback => callback());
    assert.equal(h.events.filter(item => item.event.type === 'complete' || item.event.type === 'exit').length, 0);
    h.controller.appShow();
    assert.equal(h.snapshot().sessionId, 'same-sitting');
    assert.equal(h.snapshot().elapsedTime, 125);
    assert.equal(h.snapshot().remainingTime, 295);
    assert.equal(h.snapshot().interrupted, false);
    assert.equal(h.timers.size, 2);
    staleCallbacks.forEach(callback => callback());
    assert.equal(h.timers.size, 2, 'stale native timers cannot create another scheduler');
    h.controller.dispose();
  }
});

test('a manually paused countdown stays paused through repeated interruptions and excludes all paused time', () => {
  const h = harness();
  h.start(); h.advance(65000); h.controller.pause();
  h.controller.appHide({ reason: 2 });
  h.jump(30000); h.controller.appHide({ reason: 3 });
  h.jump(30000); h.controller.appShow(); h.controller.appShow();
  assert.equal(h.snapshot().isPaused, true);
  assert.equal(h.snapshot().elapsedTime, 65);
  assert.equal(h.timers.size, 0);
  h.controller.resume();
  h.advance(10000);
  assert.equal(h.snapshot().elapsedTime, 75);
  assert.equal(h.snapshot().totalPausedTime, 60000);
  h.controller.dispose();
});

test('explicit close after an interruption settles exactly once at the actual exit boundary', () => {
  for (const reason of [0, 1]) {
    const h = harness();
    h.start(); h.advance(65000);
    h.controller.appHide({ reason: 2 }); h.jump(60000);
    h.controller.appHide({ reason }); h.controller.appHide({ reason });
    h.controller.appShow();
    assert.equal(h.snapshot().status, 'exited');
    assert.equal(h.snapshot().elapsedTime, 125);
    assert.equal(h.snapshot().interrupted, false);
    assert.deepEqual(h.records, [[2, [], [], START + 125000, 'same-sitting']]);
    assert.equal(h.timers.size, 0);
    h.controller.dispose();
  }
});

test('a deadline reached during interruption completes on return without silently recording the sitting', () => {
  const h = harness();
  h.start(120); h.advance(65000);
  h.controller.appHide({ reason: 2 }); h.jump(90000);
  assert.equal(h.snapshot().isRunning, true);
  assert.deepEqual(h.records, []);
  h.controller.appShow(); h.controller.appShow();
  assert.equal(h.snapshot().status, 'completed');
  assert.deepEqual(h.snapshot().pendingCompletion, { sessionId: 'same-sitting', duration: 2, endedAt: START + 120000, text: '' });
  assert.equal(h.events.filter(item => item.event.type === 'complete').length, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.records, []);
  h.controller.dispose();
});

test('reclaimed interrupted running sessions resume their original identity and deadline', () => {
  const first = harness();
  first.start(); first.advance(65000); first.controller.appHide({ reason: 2 });
  const checkpoint = first.saved(); first.controller.dispose();
  const next = harness({ initialStorage: checkpoint, initialTime: START + 125000 });
  assert.equal(next.snapshot().isRunning, true);
  assert.equal(next.snapshot().sessionId, 'same-sitting');
  assert.equal(next.snapshot().elapsedTime, 125);
  assert.equal(next.snapshot().remainingTime, 295);
  assert.equal(next.snapshot().pendingCompletion, null);
  assert.equal(next.timers.size, 2);
  assert.deepEqual(next.records, []);
  next.controller.dispose();
});

test('reclaimed interrupted paused sessions preserve pause duration until the user resumes', () => {
  const first = harness();
  first.start(); first.advance(65000); first.controller.pause(); first.controller.appHide({ reason: 2 });
  const checkpoint = first.saved(); first.controller.dispose();
  const next = harness({ initialStorage: checkpoint, initialTime: START + 125000 });
  assert.equal(next.snapshot().isPaused, true);
  assert.equal(next.snapshot().elapsedTime, 65);
  assert.equal(next.timers.size, 0);
  next.controller.resume(); next.advance(10000);
  assert.equal(next.snapshot().elapsedTime, 75);
  assert.equal(next.snapshot().totalPausedTime, 60000);
  next.controller.dispose();
});

test('reclaimed interrupted sessions whose deadline passed deliver the historical deferred completion once', () => {
  const first = harness();
  first.start(120); first.advance(65000); first.controller.appHide({ reason: 3 });
  const checkpoint = first.saved(); first.controller.dispose();
  const next = harness({ initialStorage: checkpoint, initialTime: START + 180000 });
  assert.equal(next.snapshot().status, 'completed');
  assert.equal(next.events[0].event.type, 'complete');
  assert.equal(next.snapshot().pendingCompletion.endedAt, START + 120000);
  const reattached = [];
  next.detach(); next.controller.attach((state, event) => reattached.push(event));
  next.controller.appShow();
  assert.equal(reattached[0].type, 'restore');
  assert.equal(reattached.filter(event => event.type === 'complete').length, 0);
  assert.deepEqual(next.records, []);
  next.controller.dispose();
});

test('a background reattach cannot consume a deferred completion before foreground returns', () => {
  const h = harness();
  h.start(120); h.advance(65000); h.detach();
  h.controller.appHide({ reason: 2 }); h.jump(60000); h.controller.appShow();
  h.controller.appHide({ reason: 3 });
  const events = [];
  h.controller.attach((snapshot, event) => events.push(event));
  assert.equal(events[0].type, 'restore');
  h.controller.appShow(); h.controller.appShow();
  assert.equal(events.filter(event => event.type === 'complete').length, 1);
  h.controller.dispose();
});

test('ordinary cold checkpoints retain historical last-checkpoint settlement behavior', () => {
  const first = harness();
  first.start(); first.advance(65000);
  const checkpoint = first.saved(); first.controller.dispose();
  const next = harness({ initialStorage: checkpoint, initialTime: START + 185000 });
  assert.equal(next.snapshot().status, 'exited');
  assert.equal(next.snapshot().elapsedTime, 65);
  assert.deepEqual(next.records, [[1, [], [], START + 65000, 'same-sitting']]);
  assert.equal(next.timers.size, 0);
  next.controller.dispose();
});

test('failed recording after explicit exit retains its historical draft without duplicate retries on lifecycle callbacks', () => {
  const h = harness({ recordCheckin: () => ({ success: false }) });
  h.start(); h.advance(65000); h.controller.appHide({ reason: 2 }); h.jump(60000);
  h.controller.appHide({ reason: 0 }); h.controller.appHide({ reason: 0 }); h.controller.appShow();
  assert.equal(h.records.length, 1);
  assert.equal(h.snapshot().pendingCompletion.duration, 2);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, 'same-sitting');
  assert.equal(h.snapshot().isRunning, false);
  h.controller.dispose();
});

test('an explicit cold close before restore settles an interrupted checkpoint at that exit time', () => {
  const first = harness();
  first.start(); first.advance(65000); first.controller.appHide({ reason: 2 });
  const checkpoint = first.saved(); first.controller.dispose();
  const cold = harness({ initialStorage: checkpoint, initialTime: START + 125000, attach: false });
  cold.controller.appHide({ reason: 0 });
  cold.jump(60000);
  cold.controller.appShow();
  cold.controller.attach(() => {});
  assert.equal(cold.snapshot().status, 'exited');
  assert.equal(cold.snapshot().elapsedTime, 125);
  assert.deepEqual(cold.records, [[2, [], [], START + 125000, 'same-sitting']]);
  cold.controller.appHide({ reason: 1 });
  assert.equal(cold.records.length, 1);
  cold.controller.dispose();
});

test('audio-only interruptions leave visible pause and resume controls available', () => {
  const h = harness();
  h.start(); h.advance(65000);
  h.controller.audioInterruptionBegin(); h.controller.audioInterruptionBegin();
  assert.equal(h.snapshot().foreground, true);
  assert.equal(h.snapshot().interrupted, true);
  h.controller.pause();
  assert.equal(h.snapshot().isPaused, true);
  h.jump(60000);
  h.controller.appShow();
  assert.equal(h.snapshot().interrupted, true, 'showing the app does not return audio focus');
  h.controller.resume(); h.advance(10000);
  assert.equal(h.snapshot().elapsedTime, 75);
  assert.equal(h.snapshot().totalPausedTime, 60000);
  h.controller.audioInterruptionEnd(); h.controller.audioInterruptionEnd();
  assert.equal(h.snapshot().isRunning, true);
  assert.equal(h.snapshot().interrupted, false);
  assert.equal(h.records.length, 0);
  h.controller.dispose();
});

test('a sitting started while audio is interrupted is marked and an audio-end callback cannot foreground a hidden app', () => {
  const h = harness();
  h.controller.audioInterruptionBegin();
  h.start();
  assert.equal(h.storage.get('timerState').interrupted, true);
  h.controller.appShow();
  assert.equal(h.storage.get('timerState').interrupted, true);
  h.controller.appHide({ reason: 2 });
  h.controller.audioInterruptionEnd();
  assert.equal(h.snapshot().foreground, false);
  assert.equal(h.snapshot().interrupted, true);
  assert.equal(h.timers.size, 0);
  h.jump(65000); h.controller.appShow();
  assert.equal(h.snapshot().elapsedTime, 65);
  assert.equal(h.snapshot().interrupted, false);
  h.controller.dispose();
});
