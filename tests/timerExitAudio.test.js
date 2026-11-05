const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimerExitAudio } = require('../miniprogram/utils/timerExitAudio');
const { queueEndReminder, getEndReminder, clearEndReminder } = require('../miniprogram/utils/timerEndReminder');

function harness({ profiles = [], vibration, settings } = {}) {
  let now = 0;
  let nextTimer = 0;
  let available = true;
  const storage = new Map(settings ? [['timerReminderSettings', settings]] : []);
  const players = [], calls = [], vibrations = [], toasts = [], diagnostics = [];
  const timers = new Map();
  const api = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    vibrateLong(options) {
      vibrations.push(options);
      if (vibration) vibration(options);
      else options.success?.({});
    },
    showToast(options) { toasts.push(options); },
    createInnerAudioContext() {
      const profile = profiles[players.length] || {};
      let src = '', firstPlay = true;
      const callbacks = {};
      const player = {
        currentTime: 0, startTime: 0, destroyed: false,
        get src() { return src; },
        set src(value) { src = value; this.currentTime = 0; firstPlay = true; },
        play() {
          assert.equal(available, true);
          assert.equal(this.destroyed, false);
          calls.push({ type: 'play', player: this, src });
          if (firstPlay) { firstPlay = false; this.currentTime = this.startTime; }
          if (profile.play === 'throw') throw new Error('native playback unavailable');
          if (profile.play === 'error') this.emit('Error', { errCode: 10001 });
          else if (profile.play !== 'silent') this.emit('Play');
        },
        pause() { calls.push({ type: 'pause', player: this }); },
        stop() { calls.push({ type: 'stop', player: this }); this.currentTime = 0; },
        destroy() { this.destroyed = true; calls.push({ type: 'destroy', player: this }); },
        emit(type, value) { [...callbacks[type]].forEach(callback => callback(value)); },
        queued(type) { const pending = [...callbacks[type]]; return value => pending.forEach(callback => callback(value)); }
      };
      for (const type of ['Play', 'Ended', 'Error', 'TimeUpdate']) {
        callbacks[type] = new Set();
        player[`on${type}`] = callback => callbacks[type].add(callback);
        player[`off${type}`] = callback => callbacks[type].delete(callback);
      }
      players.push(player);
      return player;
    }
  };
  const audio = createTimerExitAudio({
    api, canPlay: () => available,
    diagnose: (type, details) => diagnostics.push({ type, details }),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  return {
    api, audio, storage, players, calls, vibrations, toasts, diagnostics, timers,
    queue: sessionId => queueEndReminder(api, sessionId),
    pending: () => getEndReminder(api),
    available(value) { available = value; },
    plays: () => calls.filter(call => call.type === 'play'),
    advance(ms) {
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
  };
}

test('exit playback only claims a pending matching reminder and never recreates a completed one', () => {
  const h = harness();
  assert.equal(h.audio.play({ sessionId: 'one' }), false);
  assert.equal(h.audio.resume(), false);
  h.queue('two');
  assert.equal(h.audio.play({ sessionId: 'one' }), false);
  assert.equal(h.audio.owns('two'), false);
  assert.equal(h.players.length, 0);
  h.audio.play({ sessionId: 'two' });
  assert.equal(h.audio.owns('two'), true);
  const player = h.players[0];
  assert.equal(player.src, '/audio/收坐.mp3');
  h.audio.play({ sessionId: 'two' }); h.audio.resume(); h.audio.resume();
  assert.equal(h.plays().length, 1, 'repeated lifecycle calls cannot restart a ringing bell');
  player.emit('Ended');
  assert.equal(h.pending(), null);
  assert.equal(h.audio.owns('two'), false);
  assert.equal(player.destroyed, true, 'the app player is released after ringing');
  assert.equal(h.audio.play({ sessionId: 'two' }), false);
  h.advance(20000);
  assert.equal(h.plays().length, 1);
  assert.equal(h.timers.size, 0);
});

test('the app-owned bell continues from the page handoff position', () => {
  const h = harness(); h.queue('page-sit');
  h.audio.play({ sessionId: 'page-sit', position: 3.25 });
  assert.equal(h.players[0].currentTime, 3.25);
  h.players[0].currentTime = 4;
  h.players[0].emit('TimeUpdate');
  h.advance(10000);
  assert.equal(h.plays().length, 1, 'no page timer is needed to keep the cue alive');
  h.players[0].emit('Ended');
  assert.equal(h.pending(), null);
});

test('a late page handoff updates a deferred claim without overwriting live or paused playback', () => {
  const h = harness(); h.queue('handoff'); h.available(false);
  h.audio.play();
  h.audio.play({ sessionId: 'handoff', position: 3.5 });
  h.audio.play({ sessionId: 'handoff', position: 2 });
  h.available(true); h.audio.resume();
  const player = h.players[0];
  assert.equal(player.currentTime, 3.5);
  player.currentTime = 4; player.emit('TimeUpdate');
  h.audio.play({ sessionId: 'handoff', position: 100 });
  assert.equal(h.plays().length, 1);
  h.available(false); h.audio.pause();
  h.audio.play({ sessionId: 'handoff', position: 100 });
  h.available(true); h.audio.resume();
  assert.equal(player.currentTime, 4, 'the existing cue owns its confirmed position after playback begins');
  player.emit('Ended');
});

test('hidden exits defer audio until foreground and audio interruptions resume trusted progress', () => {
  const h = harness(); h.queue('one'); h.available(false);
  h.audio.play({ sessionId: 'one' });
  h.audio.resume();
  assert.equal(h.audio.owns('one'), true);
  assert.equal(h.players.length, 0);
  h.available(true); h.audio.resume();
  const player = h.players[0]; player.currentTime = 2.5; player.emit('TimeUpdate');
  h.available(false); h.audio.pause();
  h.advance(10000); h.audio.resume();
  assert.equal(h.plays().length, 1);
  h.available(true); h.audio.resume(); h.audio.resume();
  assert.equal(h.plays().length, 2);
  assert.equal(h.players.length, 1, 'an ordinary interruption can reuse the trusted audio context');
  assert.equal(player.currentTime, 2.5);
  player.emit('Ended');
  assert.equal(h.pending(), null);
});

test('a deferred exit follows the saved vibration preference without creating an audio player', () => {
  const h = harness(); h.queue('vibration'); h.available(false);
  h.audio.play();
  h.storage.set('timerReminderSettings', { end: 'vibrate' });
  h.available(true); h.audio.resume(); h.audio.resume();
  assert.equal(h.vibrations.length, 1);
  assert.equal(h.players.length, 0);
  assert.equal(h.pending(), null);
  assert.equal(h.audio.owns('vibration'), false);
});

test('exhausted native playback preserves the reminder, falls back once and retries on the next resume', () => {
  const h = harness({ profiles: [{ play: 'error' }, { play: 'error' }] });
  h.queue('failed'); h.audio.play(); h.advance(150);
  assert.equal(h.plays().length, 2);
  assert.equal(h.pending().sessionId, 'failed');
  assert.equal(h.vibrations.length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.audio.owns('failed'), true);
  h.advance(30000);
  assert.equal(h.plays().length, 2, 'there is no automatic failure loop');
  assert.ok(h.players.every(player => player.destroyed));
  h.audio.play({ sessionId: 'failed', position: 5 });
  assert.equal(h.plays().length, 3);
  assert.equal(h.players[2].currentTime, 5, 'failed claims can also accept a late trusted page handoff');
  h.players[2].emit('Ended');
  assert.equal(h.pending(), null);
  assert.equal(h.players[2].destroyed, true);
});

test('audio failure retries from its last confirmed playback progress', () => {
  const h = harness(); h.queue('progress'); h.audio.play();
  h.players[0].currentTime = 4; h.players[0].emit('TimeUpdate'); h.players[0].emit('Error');
  h.advance(150);
  assert.equal(h.players[1].currentTime, 4);
  h.players[1].emit('Error');
  h.audio.resume();
  assert.equal(h.players[2].currentTime, 4);
});

test('newer reminders replace the app cue and stale native completion cannot clear them', () => {
  const h = harness(); h.queue('old'); h.audio.play();
  const old = h.players[0], queuedEnded = old.queued('Ended');
  h.queue('new'); h.audio.play({ sessionId: 'new' });
  assert.equal(old.destroyed, true);
  assert.equal(h.audio.owns('old'), false);
  assert.equal(h.audio.owns('new'), true);
  queuedEnded();
  assert.equal(h.pending().sessionId, 'new');
  h.players[1].emit('Ended');
  assert.equal(h.pending(), null);
});

test('stale asynchronous vibration callbacks cannot acknowledge the replacement session', () => {
  const h = harness({ settings: { end: 'vibrate' }, vibration() {} });
  h.queue('old'); h.audio.play();
  const old = h.vibrations[0];
  h.queue('new'); h.audio.play();
  old.success(); old.fail();
  assert.equal(h.pending().sessionId, 'new');
  assert.equal(h.audio.owns('new'), true);
  assert.equal(h.toasts.length, 0);
  h.vibrations[1].success();
  assert.equal(h.pending(), null);
});

test('stopping playback releases all work without acknowledging an unfinished reminder', () => {
  const h = harness({ profiles: [{ play: 'silent' }] });
  h.queue('one'); h.audio.play();
  const queuedEnded = h.players[0].queued('Ended');
  assert.ok(h.timers.size);
  h.audio.stop(); queuedEnded(); h.advance(20000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.players[0].destroyed, true);
  assert.equal(h.audio.owns('one'), false);
  assert.equal(h.pending().sessionId, 'one');
  assert.equal(h.audio.resume(), false, 'only a new explicit play can claim it again');
  h.audio.play();
  assert.equal(h.plays().length, 2);
});

test('a reminder acknowledged elsewhere cannot keep an app player alive or play twice', () => {
  const h = harness(); h.queue('one'); h.audio.play();
  clearEndReminder(h.api, 'one');
  assert.equal(h.audio.owns('one'), false);
  assert.equal(h.audio.resume(), false);
  assert.equal(h.players[0].destroyed, true);
  h.audio.play({ sessionId: 'one' });
  assert.equal(h.plays().length, 1);
});
