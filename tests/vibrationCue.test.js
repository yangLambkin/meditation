const test = require('node:test');
const assert = require('node:assert/strict');
const { createVibrationCue } = require('../miniprogram/utils/vibrationCue');

function harness({ vibration, api: apiOverride } = {}) {
  let now = 0;
  let nextTimer = 0;
  let available = true;
  const timers = new Map();
  const pulses = [];
  const ended = [];
  const cue = createVibrationCue({
    api: apiOverride || {
      vibrateLong(options) {
        pulses.push({ at: now, options });
        if (vibration) vibration(options);
        else options.success({});
      }
    },
    now: () => now,
    canPlay: () => available,
    onEnded: result => ended.push(result),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  return {
    cue, pulses, ended, timers,
    available(value) { available = value; },
    advance(ms, { delayed = false } = {}) {
      const target = now + ms;
      if (delayed) now = target;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        if (!delayed) now = timer.due;
        timer.callback();
      }
      now = target;
    }
  };
}

test('a reminder covers three seconds and native success does not complete it early', () => {
  const h = harness();
  h.cue.play();
  h.cue.resume();
  assert.equal(h.pulses.length, 1);
  assert.deepEqual(h.ended, []);
  h.advance(2999);
  assert.deepEqual(h.pulses.map(pulse => pulse.at), [0, 400, 800, 1200, 1600, 2000, 2400, 2600]);
  assert.equal(h.cue.remainingMs, 1);
  assert.deepEqual(h.ended, []);
  h.advance(1);
  assert.deepEqual(h.ended, [{ failed: false }]);
  assert.equal(h.cue.remainingMs, 0);
  assert.equal(h.timers.size, 0);
  h.advance(10000);
  h.cue.resume();
  assert.equal(h.pulses.length, 8);
  assert.equal(h.ended.length, 1);
});

test('pause freezes the remaining duration and resume continues only that duration', () => {
  const h = harness();
  h.cue.play();
  h.advance(650);
  assert.equal(h.cue.remainingMs, 2350);
  h.cue.pause();
  h.cue.pause();
  h.pulses[1].options.fail(new Error('late failure after pause'));
  h.advance(10000);
  assert.equal(h.pulses.length, 2);
  assert.equal(h.cue.remainingMs, 2350);
  assert.deepEqual(h.ended, []);
  h.cue.resume();
  h.cue.resume();
  h.advance(2349);
  assert.deepEqual(h.ended, []);
  h.advance(1);
  assert.deepEqual(h.ended, [{ failed: false }]);
});

test('stop cancels future work and stale failures cannot end a replacement cue', () => {
  const h = harness();
  h.cue.play();
  const old = h.pulses[0].options;
  h.advance(150);
  h.cue.stop();
  h.advance(5000);
  assert.equal(h.pulses.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.cue.remainingMs, 0);
  assert.deepEqual(h.ended, []);
  h.cue.play({ remainingMs: 1000 });
  old.success();
  old.fail(new Error('replaced request'));
  h.advance(1000);
  assert.deepEqual(h.ended, [{ failed: false }]);
});

test('callbacks belonging to an earlier pulse cannot fail a later native request', () => {
  const h = harness();
  h.cue.play();
  const old = h.pulses[0].options;
  h.advance(400);
  old.fail(new Error('old native failure'));
  assert.deepEqual(h.ended, []);
  h.advance(2600);
  assert.deepEqual(h.ended, [{ failed: false }]);
});

test('callback failures, thrown errors, and an unavailable native API stop the cue once', () => {
  const failure = new Error('native vibration unavailable');
  for (const options of [
    { vibration: callbacks => callbacks.fail(failure) },
    { vibration() { throw failure; } },
    { api: {} }
  ]) {
    const h = harness(options);
    h.cue.play();
    assert.equal(h.ended.length, 1);
    assert.equal(h.ended[0].failed, true);
    assert.ok(h.ended[0].error instanceof Error);
    assert.equal(h.cue.remainingMs, 0);
    assert.equal(h.timers.size, 0);
    h.pulses[0]?.options.fail(failure);
    h.advance(10000);
    assert.equal(h.ended.length, 1);
  }
});

test('a failed later pulse stops the remaining vibration and reports its error', () => {
  let requested = 0;
  const h = harness({ vibration(callbacks) {
    requested += 1;
    if (requested < 4) callbacks.success();
  } });
  h.cue.play();
  h.advance(1200);
  const error = { errMsg: 'vibrateLong:fail' };
  h.pulses.at(-1).options.fail(error);
  h.advance(10000);
  assert.equal(h.pulses.length, 4);
  assert.deepEqual(h.ended, [{ failed: true, error }]);
  assert.equal(h.timers.size, 0);
});

test('elapsed reminder duration cannot acknowledge native requests whose callbacks never arrive', () => {
  const h = harness({ vibration() {} });
  h.cue.play();
  h.advance(2499);
  assert.deepEqual(h.ended, []);
  h.advance(1);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].failed, true);
  assert.equal(h.ended[0].error.errMsg, 'vibrateLong:timeout');
  assert.equal(h.timers.size, 0, 'a failed request cancels every pulse and confirmation timeout');
  for (const pulse of h.pulses) { pulse.options.success(); pulse.options.fail(new Error('late')); }
  h.advance(10000);
  assert.equal(h.ended.length, 1);
});

test('the final pulse must succeed even after all three seconds have elapsed', () => {
  for (const confirm of [true, false]) {
    let requested = 0;
    const h = harness({ vibration(callbacks) {
      requested += 1;
      if (requested < 8) callbacks.success();
    } });
    h.cue.play(); h.advance(3000);
    assert.equal(h.pulses.length, 8);
    assert.deepEqual(h.ended, []);
    if (confirm) {
      h.pulses[7].options.success();
      assert.deepEqual(h.ended, [{ failed: false }]);
    } else {
      h.advance(2099);
      assert.deepEqual(h.ended, []);
      h.advance(1);
      assert.equal(h.ended.length, 1);
      assert.equal(h.ended[0].failed, true);
      assert.equal(h.ended[0].error.errMsg, 'vibrateLong:timeout');
    }
    assert.equal(h.timers.size, 0);
  }
});

test('an unresolved earlier pulse remains accountable after later pulses succeed', () => {
  let requested = 0;
  const h = harness({ vibration(callbacks) {
    requested += 1;
    if (requested > 1) callbacks.success();
  } });
  h.cue.play(); h.advance(800);
  const failure = { errMsg: 'first pulse failed late' };
  h.pulses[0].options.fail(failure);
  assert.deepEqual(h.ended, [{ failed: true, error: failure }]);
  assert.equal(h.timers.size, 0);
});

test('interruption discards unconfirmed callbacks and resumes the remaining vibration with fresh requests', () => {
  let answer = false;
  const h = harness({ vibration(callbacks) { if (answer) callbacks.success(); } });
  h.cue.play(); h.advance(650);
  const interrupted = h.pulses.map(pulse => pulse.options);
  h.cue.pause(); h.available(false); h.advance(10000);
  assert.equal(h.cue.remainingMs, 2350);
  assert.equal(h.timers.size, 0);
  for (const callbacks of interrupted) { callbacks.success(); callbacks.fail(new Error('interrupted')); }
  assert.deepEqual(h.ended, []);
  answer = true; h.available(true); h.cue.resume();
  h.advance(2350);
  assert.deepEqual(h.ended, [{ failed: false }]);
  assert.equal(h.timers.size, 0);
});

test('pausing while the final callback is missing requires a confirmed pulse on resume', () => {
  let requested = 0;
  let answer = false;
  const h = harness({ vibration(callbacks) {
    requested += 1;
    if (requested < 8 || answer) callbacks.success();
  } });
  h.cue.play(); h.advance(3000);
  const final = h.pulses[7].options;
  h.cue.pause();
  assert.equal(h.timers.size, 0);
  final.success();
  assert.deepEqual(h.ended, []);
  answer = true; h.cue.resume();
  assert.equal(h.pulses.length, 9);
  h.advance(400);
  assert.deepEqual(h.ended, [{ failed: false }]);
});

test('unavailable playback pauses scheduled pulses until explicitly resumed', () => {
  const h = harness();
  h.available(false);
  h.cue.play();
  h.advance(10000);
  assert.equal(h.pulses.length, 0);
  assert.equal(h.cue.remainingMs, 3000);
  h.available(true);
  h.cue.resume();
  h.advance(500);
  h.available(false);
  h.advance(300);
  assert.equal(h.pulses.length, 2);
  assert.equal(h.cue.remainingMs, 2200);
  h.advance(10000);
  assert.deepEqual(h.ended, []);
  h.available(true);
  h.cue.resume();
  h.advance(2200);
  assert.deepEqual(h.ended, [{ failed: false }]);
});

test('delayed timer ticks use elapsed time without replaying missed pulses or extending the cue', () => {
  const h = harness();
  h.cue.play();
  h.advance(1500, { delayed: true });
  assert.deepEqual(h.pulses.map(pulse => pulse.at), [0, 1500]);
  assert.equal(h.cue.remainingMs, 1500);
  h.advance(2000, { delayed: true });
  assert.equal(h.pulses.length, 2);
  assert.deepEqual(h.ended, [{ failed: false }]);
  assert.equal(h.timers.size, 0);
});
