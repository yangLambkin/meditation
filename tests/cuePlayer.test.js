const test = require('node:test');
const assert = require('node:assert/strict');
const { createCuePlayer } = require('../miniprogram/utils/cuePlayer');

function harness({ profiles = [], progressEvents = false, lifecycleEvents = false, failCreation = 0 } = {}) {
  let now = 0;
  let nextTimer = 0;
  let available = true;
  const timers = new Map();
  const players = [];
  const calls = [];
  const ended = [];
  const diagnostics = [];
  const changes = [];
  const controller = createCuePlayer({
    api: {
      createInnerAudioContext() {
        if (failCreation-- > 0) throw new Error('native creation failed');
        const events = {};
        let src = '';
        let firstPlay = true;
        const profile = profiles[players.length] || {};
        const context = {
          currentTime: 0, startTime: 0, destroyed: false,
          get src() { return src; },
          set src(value) {
            if (profile.srcThrows) throw new Error('native src assignment failed');
            src = value;
            if (!profile.preserveTime) this.currentTime = 0;
            firstPlay = true;
          },
          play() {
            assert.equal(available, true, 'hidden or interrupted playback must not start');
            assert.equal(this.destroyed, false, 'destroyed players must not restart');
            calls.push({ action: 'play', player: this, src });
            if (firstPlay) {
              if (!profile.preserveTime) this.currentTime = this.startTime;
              firstPlay = false;
            }
            if (profile.play === 'throw') throw new Error('native play failed');
            if (profile.play === 'error') this.emit('Error', { errCode: 10001 });
            else if (profile.play !== 'silent') this.emit('Play');
          },
          pause() {
            calls.push({ action: 'pause', player: this });
            if (profile.pauseThrows) throw new Error('native pause failed');
            if (lifecycleEvents) this.emit('Pause');
          },
          stop() {
            calls.push({ action: 'stop', player: this });
            if (!profile.preserveTime) this.currentTime = 0;
            if (profile.stopThrows) throw new Error('native stop failed');
            if (lifecycleEvents) this.emit('Stop');
          },
          destroy() {
            this.destroyed = true;
            calls.push({ action: 'destroy', player: this });
            if (profile.destroyThrows) throw new Error('native destroy failed');
          },
          emit(event, value) { for (const callback of [...(events[event] || [])]) callback(value); },
          finish() { this.currentTime = Math.max(this.currentTime, this.startTime, 1); this.emit('TimeUpdate'); this.emit('Ended'); },
          queued(event) { const callbacks = [...(events[event] || [])]; return value => callbacks.forEach(callback => callback(value)); },
          profile
        };
        for (const event of ['Play', 'Ended', 'Error', ...(progressEvents ? ['TimeUpdate'] : []),
          ...(lifecycleEvents ? ['Stop', 'Pause'] : [])]) {
          events[event] = new Set();
          context[`on${event}`] = callback => events[event].add(callback);
          context[`off${event}`] = callback => events[event].delete(callback);
        }
        players.push(context);
        return context;
      }
    },
    canPlay: () => available,
    onEnded: event => ended.push(event),
    onPlayerChange: player => changes.push(player),
    diagnose: (type, detail) => diagnostics.push({ type, detail }),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  return {
    controller, players, ended, calls, timers, diagnostics, changes,
    available(value) { available = value; },
    plays: () => calls.filter(call => call.action === 'play'),
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.due;
        timer.callback();
      }
      now = target;
    }
  };
}

test('healthy cues use separate decoders and only finish naturally once', () => {
  const h = harness();
  assert.equal(h.controller.player, null);
  h.controller.play('/start.mp3');
  const player = h.controller.player;
  assert.equal(player.obeyMuteSwitch, false);
  assert.equal(player.loop, false);
  assert.equal(player.volume, 1);
  player.finish(); player.finish();
  assert.deepEqual(h.ended, [{ src: '/start.mp3', failed: false }]);
  h.controller.play('/end.mp3');
  assert.notEqual(h.controller.player, player);
  assert.equal(player.destroyed, true);
  assert.equal(h.controller.player.startTime, 0);
  assert.equal(h.players.length, 2);
  h.advance(10000);
  assert.equal(h.plays().length, 2);
});

test('unexpected native stop or pause repairs a closing cue even without an error or progress callback', () => {
  for (const event of ['Stop', 'Pause']) {
    const h = harness({ lifecycleEvents: true });
    h.controller.play('/end.mp3');
    const original = h.players[0];
    original.currentTime = 0.5;
    original.emit(event);
    assert.equal(original.destroyed, true);
    assert.equal(h.ended.length, 0, 'native silence cannot acknowledge the closing reminder');
    h.advance(150);
    assert.equal(h.plays().length, 2);
    assert.equal(h.players[1].startTime, 0.5);
    h.players[1].finish();
    assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
  }
});

test('an unexpected stop during unavailable audio preserves the cue until explicit resume', () => {
  const h = harness({ lifecycleEvents: true });
  h.controller.play('/end.mp3');
  const original = h.players[0];
  original.currentTime = 1;
  h.available(false);
  original.emit('Pause');
  h.advance(10000);
  assert.equal(h.plays().length, 1);
  assert.equal(h.ended.length, 0);
  h.available(true);
  h.controller.resume();
  assert.equal(h.plays().length, 2);
  assert.equal(h.players[1].startTime, 1);
});

test('intentional stop and pause cannot trigger native-silence recovery', () => {
  const h = harness({ lifecycleEvents: true });
  h.controller.play('/start.mp3');
  h.controller.pause();
  h.advance(10000);
  assert.equal(h.plays().length, 1);
  assert.equal(h.players[0].destroyed, false);
  h.controller.resume();
  h.controller.stop();
  h.advance(10000);
  assert.equal(h.plays().length, 2);
  assert.equal(h.players[0].destroyed, false);
  assert.equal(h.ended.length, 0);
});

test('delayed native stop and pause from switching cues cannot exhaust the replacement player retry', () => {
  const h = harness({ lifecycleEvents: true });
  h.controller.play('/start.mp3');
  const original = h.players[0];
  h.controller.play('/end.mp3');
  const queuedPause = original.queued('Pause');
  // Delayed native notifications stay on the released context and cannot use
  // up the closing cue's recovery attempt.
  original.emit('Stop');
  original.emit('Pause');
  queuedPause();
  h.advance(150);
  assert.equal(h.players.length, 2);
  original.emit('Stop');
  original.emit('Pause');
  queuedPause();
  h.advance(10000);
  assert.equal(h.players[1].destroyed, false);
  assert.equal(h.plays().length, 2, 'one opening and one isolated closing');
  assert.equal(h.ended.length, 0);
  h.players[1].finish();
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
});

test('two consecutive native errors retry once and leave the next cue a fresh player', () => {
  const h = harness({ profiles: [{ play: 'error' }, { play: 'error' }] });
  h.controller.play('/end.mp3');
  assert.equal(h.plays().length, 1, 'retry must not recurse inside the native callback');
  h.advance(150);
  assert.equal(h.plays().length, 2);
  assert.equal(h.controller.player, null);
  assert.ok(h.players.every(player => player.destroyed));
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: true }]);
  h.advance(10000);
  assert.equal(h.plays().length, 2, 'a failing native runtime must not cause unbounded retries');
  h.controller.play('/start.mp3');
  assert.equal(h.players.length, 3);
  assert.equal(h.controller.player.destroyed, false);
  assert.equal(h.plays().at(-1).src, '/start.mp3');
});

test('a play call without callbacks rebuilds after the startup timeout', () => {
  const h = harness({ profiles: [{ play: 'silent' }] });
  h.controller.play('/end.mp3');
  h.advance(2499);
  assert.equal(h.players.length, 1);
  h.advance(1);
  assert.equal(h.players[0].destroyed, true);
  h.advance(150);
  assert.equal(h.players.length, 2);
  assert.equal(h.plays().length, 2);
  assert.equal(h.ended.length, 0);
  h.players[1].finish();
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
});

test('a decoder reporting Play without advancing also rebuilds when progress events exist', () => {
  const h = harness({ progressEvents: true });
  h.controller.play('/end.mp3');
  h.advance(2650);
  assert.equal(h.players.length, 2);
  for (let second = 1; second <= 10; second += 1) {
    h.players[1].currentTime = second;
    h.players[1].emit('TimeUpdate');
    h.advance(1000);
  }
  assert.equal(h.plays().length, 2);
  assert.equal(h.ended.length, 0);
});

test('actual playback progress prevents unnecessary recovery even if a progress callback is missed', () => {
  const h = harness({ progressEvents: true });
  h.controller.play('/end.mp3');
  for (let second = 1; second <= 10; second += 1) {
    h.players[0].currentTime = second;
    h.advance(1000);
  }
  assert.equal(h.players.length, 1);
  assert.equal(h.ended.length, 0);
});

test('a closing cue that stalls after trusted progress rebuilds once at that position and then reports failure', () => {
  const h = harness({ progressEvents: true });
  h.controller.play('/end.mp3');
  const original = h.players[0];
  original.currentTime = 0.75;
  original.emit('TimeUpdate');
  const staleEnded = original.queued('Ended');
  h.advance(5000);
  assert.equal(original.destroyed, true);
  assert.equal(h.ended.length, 0);
  h.advance(150);
  assert.equal(h.players[1].startTime, 0.75, 'stall recovery retains the last confirmed position');
  staleEnded();
  assert.equal(h.ended.length, 0, 'a discarded player cannot acknowledge the new request');
  h.players[1].currentTime = 1.25;
  h.players[1].emit('TimeUpdate');
  h.advance(5000);
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: true }]);
  assert.equal(h.controller.player, null);
  assert.equal(h.timers.size, 0);
  h.advance(10000);
  assert.equal(h.plays().length, 2, 'a stalled decoder cannot create an unbounded retry loop');
  assert.equal(h.diagnostics.filter(item => item.type === 'cue_stall_timeout').length, 2);
});

test('repeated progress events and a native time reset cannot disguise a stalled cue', () => {
  const h = harness({ progressEvents: true });
  h.controller.play('/end.mp3');
  const original = h.players[0];
  original.currentTime = 2;
  original.emit('TimeUpdate');
  h.advance(2500);
  for (let step = 0; step < 5; step += 1) {
    original.currentTime = step % 2 === 0 ? 0 : 2;
    original.emit('TimeUpdate');
    h.advance(500);
  }
  assert.equal(original.destroyed, true);
  h.advance(150);
  assert.equal(h.players[1].startTime, 2, 'only new monotonic playback time advances the recovery position');
  h.players[1].finish();
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
});

test('pausing or hiding a cue cancels ongoing progress checks until an explicit resume', () => {
  for (const explicitPause of [true, false]) {
    const h = harness({ progressEvents: true });
    h.controller.play('/end.mp3');
    const original = h.players[0];
    original.currentTime = 3;
    original.emit('TimeUpdate');
    h.advance(2500);
    assert.equal(h.timers.size, 1);
    h.available(false);
    if (explicitPause) h.controller.pause();
    h.advance(10000);
    assert.equal(h.timers.size, 0);
    assert.equal(original.destroyed, false, 'an unavailable audio session is paused without spending a recovery attempt');
    assert.equal(h.ended.length, 0);
    h.available(true);
    h.controller.resume();
    assert.equal(h.players.length, 1);
    original.currentTime = 4;
    original.emit('TimeUpdate');
    h.advance(2500);
    original.finish();
    assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
    assert.equal(h.timers.size, 0);
  }
});

test('old clients retain Play-only compatibility but detect stalls after readable time is observed', () => {
  const h = harness();
  h.controller.play('/end.mp3');
  h.players[0].currentTime = 1.5;
  h.advance(5000);
  assert.equal(h.players[0].destroyed, true);
  h.advance(150);
  assert.equal(h.players[1].startTime, 1.5);
  h.advance(10000);
  assert.equal(h.plays().length, 2, 'a replacement without readable progress keeps legacy Play-only behavior');
  assert.equal(h.ended.length, 0);
});

test('synchronous creation and play exceptions use the same finite recovery path', () => {
  for (const options of [{ failCreation: 1 }, { profiles: [{ play: 'throw' }] }]) {
    const h = harness(options);
    assert.doesNotThrow(() => h.controller.play('/start.mp3'));
    h.advance(150);
    assert.equal(h.controller.player.destroyed, false);
    assert.equal(h.plays().at(-1).src, '/start.mp3');
    assert.equal(h.ended.length, 0);
  }
});

test('stop, pause and destroy cancel scheduled retries and queued callbacks', () => {
  for (const method of ['stop', 'pause', 'destroy']) {
    const h = harness({ profiles: [{ play: 'silent' }] });
    h.controller.play('/start.mp3');
    const queuedError = h.players[0].queued('Error');
    const queuedEnded = h.players[0].queued('Ended');
    h.advance(2500);
    h.controller[method]();
    queuedError({ errCode: 10001 }); queuedEnded();
    h.advance(10000);
    assert.equal(h.plays().length, 1, method);
    assert.equal(h.ended.length, 0, method);
    assert.equal(h.timers.size, 0, method);
  }
});

test('hidden or interrupted playback waits for explicit resume without spending its recovery attempt', () => {
  const h = harness({ profiles: [{ play: 'error' }] });
  h.controller.play('/start.mp3');
  h.available(false);
  h.advance(10000);
  assert.equal(h.plays().length, 1);
  h.controller.resume();
  assert.equal(h.plays().length, 1);
  h.available(true);
  h.controller.resume();
  assert.equal(h.plays().length, 2);
  assert.equal(h.players.length, 2);
});

test('callbacks queued by an old cue or discarded context cannot end a newer cue', () => {
  const h = harness();
  h.controller.play('/start.mp3');
  const oldEnded = h.players[0].queued('Ended');
  const oldError = h.players[0].queued('Error');
  h.controller.play('/end.mp3');
  oldEnded(); oldError({ errCode: 10001 });
  assert.equal(h.ended.length, 0);
  assert.equal(h.players.length, 2);
  const failedContext = h.players[1];
  const failedEnded = failedContext.queued('Ended');
  failedContext.emit('Error', { errCode: 10001 });
  h.advance(150);
  failedEnded();
  assert.equal(h.ended.length, 0);
  assert.equal(h.players.length, 3);
  h.players[2].finish();
  assert.deepEqual(h.ended, [{ src: '/end.mp3', failed: false }]);
});

test('pause and resume preserve position and recover a failed native resume without starting over', () => {
  const h = harness();
  h.controller.play('/start.mp3');
  const original = h.players[0];
  original.currentTime = 7;
  h.controller.pause();
  h.advance(10000);
  assert.equal(h.plays().length, 1);
  h.controller.resume();
  assert.equal(original.currentTime, 7);
  original.currentTime = 9;
  h.controller.pause();
  original.profile.play = 'throw';
  h.controller.resume();
  h.advance(150);
  assert.equal(original.destroyed, true);
  assert.equal(h.players[1].startTime, 9);
  assert.equal(h.players[1].currentTime, 9);
  assert.equal(h.ended.length, 0);
});

test('preparing an interrupted cue does not play until resume and retains its saved position', () => {
  const h = harness();
  h.available(false);
  const empty = h.controller.ensurePlayer();
  h.controller.prepare('/start.mp3', { position: 12 });
  assert.equal(h.controller.player, empty);
  assert.equal(h.plays().length, 0);
  h.controller.resume();
  assert.equal(h.plays().length, 0);
  h.available(true);
  h.controller.resume();
  assert.equal(h.plays().length, 1);
  assert.equal(empty.currentTime, 12);
});

test('cleanup exceptions release the native reference and cannot poison the next cue', () => {
  const h = harness({ profiles: [{ stopThrows: true, destroyThrows: true }] });
  h.controller.play('/start.mp3');
  assert.doesNotThrow(() => h.controller.destroy());
  assert.equal(h.controller.player, null);
  assert.deepEqual(h.changes, [h.players[0], null]);
  h.controller.play('/end.mp3');
  assert.equal(h.players.length, 2);
  assert.equal(h.plays().at(-1).src, '/end.mp3');
});

test('an immediate new-cue error cannot reuse the previous source currentTime', () => {
  for (const progressEvents of [false, true]) {
    const h = harness({ profiles: [{ preserveTime: true }, { play: 'error' }], progressEvents });
    h.controller.play('/start.mp3');
    const original = h.players[0];
    original.currentTime = 10;
    original.emit('TimeUpdate');
    original.finish();
    h.controller.play('/end.mp3');
    h.advance(150);
    assert.equal(h.players.length, 3);
    assert.equal(h.players[2].src, '/end.mp3');
    assert.equal(h.players[2].startTime, 0, 'the closing cue must retry from its own beginning');
  }
});

test('a new Play event without time progress does not satisfy the progress watchdog', () => {
  const h = harness({ profiles: [{ preserveTime: true }], progressEvents: true });
  h.controller.play('/start.mp3');
  const original = h.players[0];
  original.currentTime = 10;
  original.emit('TimeUpdate');
  original.finish();
  h.controller.play('/end.mp3');
  const closing = h.controller.player;
  closing.emit('TimeUpdate');
  h.advance(2650);
  assert.equal(closing.destroyed, true);
  assert.equal(h.players.length, 3);
  assert.equal(h.players[2].startTime, 0);
});

test('a native src assignment failure cannot retain the preceding source startTime', () => {
  const h = harness({ profiles: [{ preserveTime: true }, { srcThrows: true }] });
  h.controller.play('/start.mp3', { position: 12 });
  const original = h.players[0];
  original.currentTime = 15;
  original.finish();
  h.controller.play('/end.mp3');
  assert.equal(original.startTime, 12, 'the previous decoder retains only its own startTime');
  h.advance(150);
  assert.equal(h.players.length, 3);
  assert.equal(h.players[2].src, '/end.mp3');
  assert.equal(h.players[2].startTime, 0);
});

test('a mid-cue error retains observed progress even if native time resets before the error', () => {
  for (const resetsBeforeError of [false, true]) {
    const h = harness({ profiles: [{ preserveTime: true }], progressEvents: true });
    h.controller.play('/start.mp3');
    const original = h.players[0];
    original.currentTime = 10;
    original.emit('TimeUpdate');
    original.finish();
    h.controller.play('/end.mp3');
    const closing = h.controller.player;
    closing.currentTime = 0.25;
    closing.emit('TimeUpdate');
    closing.currentTime = 3.5;
    closing.emit('TimeUpdate');
    if (resetsBeforeError) closing.currentTime = 0;
    closing.emit('Error', { errCode: 10001 });
    h.advance(150);
    assert.equal(h.players[2].src, '/end.mp3');
    assert.equal(h.players[2].startTime, 3.5);
  }
});

test('old clients can preserve changed playback time without a TimeUpdate event', () => {
  const h = harness({ profiles: [{ preserveTime: true }] });
  h.controller.play('/start.mp3');
  const original = h.players[0];
  original.currentTime = 7.5;
  original.emit('Error', { errCode: 10001 });
  h.advance(150);
  assert.equal(h.players[1].startTime, 7.5);
});

test('the confirmed position survives a missing native player during error recovery', () => {
  const h = harness({ progressEvents: true });
  h.controller.play('/start.mp3');
  const original = h.players[0];
  original.currentTime = 7;
  original.emit('TimeUpdate');
  original.emit('Error', { errCode: 10001 });
  assert.equal(h.controller.player, null);
  assert.equal(h.controller.position, 7, 'page handoff must not replace a recovering cue position with zero');
  h.controller.pause();
  h.advance(1000);
  assert.equal(h.controller.position, 7);
  h.controller.resume();
  assert.equal(h.players[1].startTime, 7);
});

test('a failed native pause retains its confirmed position for page reconstruction', () => {
  const h = harness({ profiles: [{ pauseThrows: true }] });
  h.controller.play('/start.mp3');
  h.players[0].currentTime = 9;
  h.controller.pause();
  assert.equal(h.controller.player, null);
  assert.equal(h.controller.position, 9);
  h.controller.resume();
  assert.equal(h.players[1].startTime, 9);
});

test('position reads reject stale native time until the current source really advances', () => {
  const h = harness({ profiles: [{ preserveTime: true }], progressEvents: true });
  h.controller.play('/start.mp3');
  const original = h.players[0];
  original.currentTime = 10;
  original.emit('TimeUpdate');
  original.finish();
  h.controller.play('/end.mp3');
  const closing = h.controller.player;
  assert.equal(original.currentTime, 10);
  assert.equal(h.controller.position, 0, 'a new cue cannot inherit the preceding source time');
  original.currentTime = 99;
  assert.equal(h.controller.position, 0, 'late native time on the old decoder is isolated');
  closing.currentTime = 0.5;
  assert.equal(h.controller.position, 0.5, 'a page handoff also samples confirmed current playback');
  h.controller.pause();
  closing.currentTime = 99;
  assert.equal(h.controller.position, 0.5, 'paused requests retain the position captured before native pause');
  h.controller.prepare('/start.mp3', { position: 12 });
  assert.equal(h.controller.position, 12, 'a prepared but unplayed cue uses only its requested position');
  h.controller.stop();
  assert.equal(h.controller.position, 0);
});
