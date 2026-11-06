const test = require('node:test');
const assert = require('node:assert/strict');
const { createCuePlayer } = require('../miniprogram/utils/cuePlayer');

const OPENING = '/audio/起坐.mp3';
const CLOSING = '/audio/收坐.mp3';

// Native events are independent of the JavaScript playback request: an old
// decoder can deliver queued events after its source was changed or destroyed.
function harness({ profiles = [] } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const players = [];
  const plays = [];
  const ended = [];
  const diagnostics = [];
  const schedule = (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const cancel = id => timers.delete(id);
  const advance = milliseconds => {
    const target = now + milliseconds;
    let remaining = 1000;
    while (remaining-- > 0) {
      const next = [...timers].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) { now = target; return; }
      const [id, timer] = next;
      timers.delete(id);
      now = timer.due;
      timer.callback();
    }
    assert.fail('audio recovery must not schedule an unbounded callback loop');
  };
  const controller = createCuePlayer({
    api: {
      createInnerAudioContext() {
        const profile = profiles[players.length] || {};
        const listeners = new Map();
        let source = '';
        const player = {
          currentTime: 0, startTime: 0, duration: 19.08,
          destroyed: false, sourceAssignments: 0,
          get src() { return source; },
          set src(value) {
            source = value;
            this.sourceAssignments += 1;
            this.currentTime = 0;
            if (profile.readyDelay !== null) {
              schedule(() => this.emit('Canplay'), profile.readyDelay || 0);
            }
          },
          play() {
            assert.equal(this.destroyed, false, 'a released decoder must never restart');
            plays.push({ player: this, src: source, at: now });
            this.currentTime = Math.max(this.currentTime, this.startTime);
            if (profile.announcePlay !== false) this.emit('Play');
          },
          stop() {},
          pause() {},
          destroy() { this.destroyed = true; },
          emit(event, value) {
            for (const callback of [...(listeners.get(event) || [])]) callback(value);
          },
          queued(event) {
            const callbacks = [...(listeners.get(event) || [])];
            return value => callbacks.forEach(callback => callback(value));
          },
          progress(seconds) { this.currentTime = seconds; this.emit('TimeUpdate'); },
          finish() { this.progress(this.duration); this.emit('Ended'); }
        };
        for (const event of ['Canplay', 'Play', 'TimeUpdate', 'Ended', 'Error', 'Stop', 'Pause']) {
          if (event === 'TimeUpdate' && profile.progressEvents === false) continue;
          listeners.set(event, new Set());
          player[`on${event}`] = callback => listeners.get(event).add(callback);
          player[`off${event}`] = callback => listeners.get(event).delete(callback);
        }
        players.push(player);
        return player;
      }
    },
    setTimeout: schedule, clearTimeout: cancel, now: () => now,
    onEnded: result => ended.push(result),
    diagnose: (type, details) => diagnostics.push({ type, details })
  });
  return { controller, players, plays, ended, diagnostics, timers, advance };
}

test('the first closing bell is isolated from delayed opening Ended, Stop and Pause events', () => {
  const h = harness();
  h.controller.play(OPENING);
  h.advance(0);
  const opening = h.controller.player;
  opening.progress(1);
  const queued = ['Ended', 'Stop', 'Pause'].map(event => opening.queued(event));

  h.controller.play(CLOSING);
  h.advance(0);
  const closing = h.controller.player;
  assert.notEqual(closing, opening, 'switching sources must isolate their native event streams');
  assert.equal(opening.destroyed, true);
  for (const event of ['Ended', 'Stop', 'Pause']) opening.emit(event);
  for (const callback of queued) callback();
  h.advance(200);

  assert.deepEqual(h.ended, [], 'the old opening cue cannot acknowledge an unheard closing bell');
  assert.equal(h.controller.player, closing);
  assert.equal(h.plays.filter(call => call.src === CLOSING).length, 1);
  closing.finish();
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
});

test('Ended without Play or progress cannot acknowledge an unheard bell and recovery is bounded', () => {
  const h = harness({ profiles: [{ announcePlay: false }, { announcePlay: false }] });
  h.controller.play(CLOSING);
  h.advance(0);
  h.players[0].emit('Ended');
  assert.equal(h.ended.some(result => !result.failed), false);
  h.advance(3000);
  assert.equal(h.plays.length, 2, 'an unstarted bell gets one fresh playback attempt');
  h.players[1].emit('Ended');
  h.advance(20000);
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: true }]);
  assert.equal(h.plays.length, 2, 'native failure must not produce an endless retry loop');
  assert.equal(h.timers.size, 0);
});

test('a first cold decoder may load beyond 2.5 seconds before playback progress checks begin', () => {
  const h = harness({ profiles: [{ readyDelay: 6000 }] });
  h.controller.play(CLOSING);
  const cold = h.players[0];
  h.advance(5999);
  assert.equal(h.players.length, 1, 'a still-loading decoder must not be repeatedly destroyed');
  assert.equal(cold.destroyed, false);
  assert.deepEqual(h.ended, []);
  h.advance(1);
  assert.equal(h.plays.some(call => call.player === cold), true);
  cold.progress(0.5);
  h.advance(1000);
  cold.progress(1.5);
  cold.finish();
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
  assert.equal(h.players.length, 1);
});

test('a decoder that becomes ready but never advances still retries and fails within a bound', () => {
  const h = harness({ profiles: [{ readyDelay: 6000 }] });
  h.controller.play(CLOSING);
  h.advance(6000);
  assert.equal(h.players.length, 1);
  h.advance(2650);
  assert.equal(h.players.length, 2, 'readiness must not disable the startup watchdog');
  assert.equal(h.players[0].destroyed, true);
  h.advance(20000);
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: true }]);
  assert.equal(h.plays.length, 2);
  assert.equal(h.timers.size, 0);
});

test('preloading the closing bell is silent and matching playback reuses its ready decoder', () => {
  const h = harness();
  h.controller.play(OPENING);
  h.advance(0);
  const opening = h.controller.player;
  opening.progress(1);
  h.controller.preload(CLOSING);
  h.advance(0);
  const prepared = h.players.find(player => player.src === CLOSING);

  assert.ok(prepared, 'preload must prepare the requested local resource');
  assert.notEqual(prepared, opening);
  assert.equal(h.controller.player, opening, 'warming the closing bell must not replace the active opening cue');
  assert.equal(opening.destroyed, false);
  assert.deepEqual(h.plays.map(call => call.src), [OPENING]);
  opening.finish();
  h.controller.play(CLOSING);
  h.advance(0);
  assert.equal(h.controller.player, prepared);
  assert.equal(prepared.sourceAssignments, 1, 'using a prepared cue must not reload the same source');
  assert.deepEqual(h.plays.map(call => call.src), [OPENING, CLOSING]);
  prepared.finish();
  assert.deepEqual(h.ended, [
    { src: OPENING, failed: false }, { src: CLOSING, failed: false }
  ]);
});

test('a failed preload leaves opening playback intact and does not spend the closing retry', () => {
  const h = harness();
  h.controller.play(OPENING);
  h.advance(0);
  const opening = h.controller.player;
  opening.progress(1);
  h.controller.preload(CLOSING);
  const prepared = h.players.find(player => player.src === CLOSING);
  prepared.emit('Error', { errCode: 10001 });
  h.advance(0);
  assert.equal(h.controller.player, opening);
  assert.equal(opening.destroyed, false);
  assert.deepEqual(h.ended, []);
  assert.deepEqual(h.plays.map(call => call.src), [OPENING]);
  opening.finish();

  h.controller.play(CLOSING);
  h.advance(0);
  const firstAttempt = h.controller.player;
  assert.notEqual(firstAttempt, prepared, 'failed speculative loading must not poison actual playback');
  firstAttempt.emit('Error', { errCode: 10001 });
  h.advance(150);
  const recovery = h.controller.player;
  assert.notEqual(recovery, firstAttempt);
  assert.equal(h.plays.filter(call => call.src === CLOSING).length, 2);
  recovery.finish();
  assert.deepEqual(h.ended, [
    { src: OPENING, failed: false }, { src: CLOSING, failed: false }
  ]);
});

test('a modern decoder reporting Play then Ended at zero cannot acknowledge an unheard bell', () => {
  const h = harness();
  h.controller.play(CLOSING);
  h.advance(0);
  const silent = h.controller.player;
  silent.emit('Ended');
  assert.deepEqual(h.ended, [], 'Play alone is not evidence that the closing bell was audible');
  h.advance(150);
  assert.notEqual(h.controller.player, silent);
  h.controller.player.finish();
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
  assert.equal(h.plays.length, 2);
});

test('natural completion accepts trusted progress even when native time resets before Ended', () => {
  const h = harness();
  h.controller.play(CLOSING);
  h.advance(0);
  const closing = h.controller.player;
  closing.progress(closing.duration);
  closing.currentTime = 0;
  closing.emit('Ended');
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
  h.advance(20000);
  assert.equal(h.plays.length, 1);
});

test('natural completion samples final playback time when the TimeUpdate callback was missed', () => {
  const h = harness();
  h.controller.play(CLOSING);
  h.advance(0);
  const closing = h.controller.player;
  closing.currentTime = closing.duration;
  closing.emit('Ended');
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
  assert.equal(h.plays.length, 1);
});

test('a pause at the natural end retains confirmed playback evidence across resume', () => {
  const h = harness();
  h.controller.play(CLOSING);
  h.advance(0);
  const closing = h.controller.player;
  closing.progress(closing.duration);
  h.controller.pause();
  h.advance(10000);
  h.controller.resume();
  closing.emit('Ended');
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
  assert.equal(h.players.length, 1, 'finishing a successfully played bell must not restart a new decoder');
});

test('older native contexts without progress support retain Play and Ended compatibility', () => {
  const h = harness({ profiles: [{ progressEvents: false }] });
  h.controller.play(CLOSING);
  h.advance(0);
  h.controller.player.emit('Ended');
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: false }]);
});

test('a cold decoder that never becomes ready receives only one bounded retry', () => {
  const h = harness({ profiles: [{ readyDelay: null }, { readyDelay: null }] });
  h.controller.play(CLOSING);
  h.advance(9999);
  assert.equal(h.players.length, 1);
  assert.deepEqual(h.ended, []);
  h.advance(10151);
  assert.equal(h.plays.length, 2);
  assert.deepEqual(h.ended, [{ src: CLOSING, failed: true }]);
  assert.equal(h.timers.size, 0);
});

test('replacing and destroying preloads releases resources and invalidates their late callbacks', () => {
  const h = harness();
  h.controller.preload(CLOSING);
  const first = h.players[0];
  const staleReady = first.queued('Canplay');
  const staleError = first.queued('Error');
  h.controller.preload(OPENING);
  const replacement = h.players[1];
  assert.equal(first.destroyed, true);
  staleReady(); staleError({ errCode: 10001 });
  assert.equal(replacement.destroyed, false);
  h.controller.destroy();
  staleReady(); staleError({ errCode: 10001 });
  replacement.emit('Canplay'); replacement.emit('Error', { errCode: 10001 });
  h.advance(20000);
  assert.equal(replacement.destroyed, true);
  assert.deepEqual(h.plays, []);
  assert.deepEqual(h.ended, []);
  assert.equal(h.controller.player, null);
});
