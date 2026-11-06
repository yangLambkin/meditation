const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const reminders = require('../miniprogram/utils/timerEndReminder');
const { queueEndReminder, getEndReminder, clearEndReminder } = reminders;

function storageApi() {
  const storage = new Map();
  const writes = [];
  return {
    storage, writes,
    getStorageSync: key => storage.get(key),
    setStorageSync(key, value) { writes.push({ key, value }); storage.set(key, value); }
  };
}

test('end reminders persist once per pending session and stale acknowledgements cannot clear a newer reminder', () => {
  const api = storageApi();
  assert.equal(getEndReminder(api), null);
  assert.deepEqual(queueEndReminder(api, 'first'), { sessionId: 'first' });
  queueEndReminder(api, 'first');
  assert.equal(api.writes.length, 1);
  queueEndReminder(api, 'second');
  assert.equal(clearEndReminder(api, 'first'), false);
  assert.deepEqual(getEndReminder(api), { sessionId: 'second' });
  assert.equal(clearEndReminder(api, 'second'), true);
  assert.equal(getEndReminder(api), null);
  assert.equal(api.storage.get('timerPendingEndReminder'), null);
});

test('reminder reads return copies and malformed session ids do not replace a valid reminder', () => {
  const api = storageApi();
  queueEndReminder(api, 'pending');
  getEndReminder(api).sessionId = 'mutated';
  for (const invalid of ['', null, 10, 'x'.repeat(257)]) queueEndReminder(api, invalid);
  assert.deepEqual(getEndReminder(api), { sessionId: 'pending' });
  api.storage.set('timerPendingEndReminder', { sessionId: '' });
  assert.equal(getEndReminder(api), null);
});

test('storage failures retain the latest intent and its acknowledgement without interrupting the timer', () => {
  const api = storageApi();
  queueEndReminder(api, 'old');
  api.setStorageSync = () => { throw new Error('disk unavailable'); };
  assert.doesNotThrow(() => queueEndReminder(api, 'new'));
  assert.deepEqual(getEndReminder(api), { sessionId: 'new' });
  assert.equal(clearEndReminder(api, 'old'), false);
  assert.equal(clearEndReminder(api, 'new'), true);
  assert.equal(getEndReminder(api), null, 'an old disk value must not revive an acknowledged cue');
  api.getStorageSync = () => { throw new Error('read unavailable'); };
  assert.doesNotThrow(() => queueEndReminder(api, 'latest'));
  assert.deepEqual(getEndReminder(api), { sessionId: 'latest' });
});

test('a failed bell acknowledgement is flushed after storage recovers so a cold page stays silent', () => {
  const api = storageApi();
  const h = audioHarness({ api });
  h.page.playSessionSound('end');
  const store = api.setStorageSync;
  api.setStorageSync = () => { throw new Error('temporary write failure'); };
  h.ended({ failed: false });
  assert.deepEqual(api.storage.get('timerPendingEndReminder'), { sessionId: 'sitting' });
  api.setStorageSync = store;
  h.page.resumeInterruptedAudio({ allowEndRetry: true });
  assert.equal(api.storage.get('timerPendingEndReminder'), null);
  assert.equal(h.plays.length, 1, 'flushing an acknowledgement must not replay the bell');

  const coldApi = {
    getStorageSync: key => api.storage.get(key),
    setStorageSync: (key, value) => api.storage.set(key, value)
  };
  const cold = audioHarness({ api: coldApi });
  cold.page.resumeInterruptedAudio();
  assert.equal(getEndReminder(coldApi), null);
  assert.deepEqual(cold.plays, []);
});

test('a failed queued reminder is flushed on a later read and survives a cold runtime', () => {
  const api = storageApi();
  queueEndReminder(api, 'older');
  const store = api.setStorageSync;
  api.setStorageSync = () => { throw new Error('temporary write failure'); };
  queueEndReminder(api, 'newest');
  assert.deepEqual(api.storage.get('timerPendingEndReminder'), { sessionId: 'older' });
  api.setStorageSync = store;
  const pending = getEndReminder(api);
  assert.deepEqual(pending, { sessionId: 'newest' });
  pending.sessionId = 'mutated';
  assert.deepEqual(api.storage.get('timerPendingEndReminder'), { sessionId: 'newest' });
  assert.deepEqual(getEndReminder({ getStorageSync: key => api.storage.get(key) }), { sessionId: 'newest' });
  const written = api.writes.length;
  getEndReminder(api);
  assert.equal(api.writes.length, written, 'a successful flush returns to ordinary read-only access');
});

test('persistent storage failures attempt at most one write per operation without recursive retries', () => {
  const api = storageApi();
  queueEndReminder(api, 'older');
  let writes = 0;
  api.setStorageSync = () => { writes += 1; throw new Error('persistent write failure'); };
  const once = action => {
    const before = writes;
    assert.doesNotThrow(action);
    assert.equal(writes - before, 1);
  };
  once(() => queueEndReminder(api, 'pending'));
  for (let repeat = 0; repeat < 3; repeat += 1) {
    once(() => assert.deepEqual(getEndReminder(api), { sessionId: 'pending' }));
  }
  once(() => queueEndReminder(api, 'pending'));
  once(() => queueEndReminder(api, 'newer'));
  once(() => assert.equal(clearEndReminder(api, 'newer'), true));
  once(() => assert.equal(getEndReminder(api), null));
  once(() => assert.equal(reminders.dismissEndReminder(api), null));
  once(() => queueEndReminder(api, 'latest'));
  once(() => assert.deepEqual(reminders.dismissEndReminder(api), { sessionId: 'latest' }));
});

test('stale callbacks cannot clear the newest dirty intent or revive an older acknowledgement', () => {
  const api = storageApi();
  queueEndReminder(api, 'old');
  const store = api.setStorageSync;
  let failedWrites = 0;
  api.setStorageSync = () => { failedWrites += 1; throw new Error('write unavailable'); };
  clearEndReminder(api, 'old');
  queueEndReminder(api, 'newer');
  const beforeStale = failedWrites;
  assert.equal(clearEndReminder(api, 'old'), false);
  assert.equal(failedWrites, beforeStale, 'stale acknowledgements must not write a replacement intent');
  api.setStorageSync = store;
  assert.deepEqual(getEndReminder(api), { sessionId: 'newer' });
  assert.deepEqual(api.storage.get('timerPendingEndReminder'), { sessionId: 'newer' });
  assert.equal(clearEndReminder(api, 'old'), false);
  assert.deepEqual(getEndReminder(api), { sessionId: 'newer' });
});

function audioHarness({ api = storageApi(), reminderMode = 'bell' } = {}) {
  const plays = [];
  const toasts = [];
  const vibrations = [];
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  let onEnded;
  let resumes = 0;
  class ClockDate extends Date {
    static now() { return now; }
  }
  const wx = Object.assign(api, {
    vibrateLong(options) { vibrations.push(options); options.success?.({}); },
    showToast(options) { toasts.push(options); }
  });
  const module = { exports: {} };
  const audioPath = path.join(__dirname, '../miniprogram/utils/timerAudio.js');
  vm.runInNewContext(fs.readFileSync(audioPath, 'utf8'), {
    module, wx, Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, due: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    require(request) {
      if (request === './timerEndReminder') return reminders;
      if (request === './timerReminderSettings') return { getReminderSettings: () => ({ start: 'bell', end: reminderMode }) };
      if (request === './vibrationCue') return require('../miniprogram/utils/vibrationCue');
      assert.equal(request, './cuePlayer');
      return {
        createCuePlayer(options) {
          onEnded = options.onEnded;
          return {
            ensurePlayer() {}, stop() {}, destroy() {}, pause() {},
            resume() { resumes += 1; },
            play(src) { plays.push(src); }
          };
        }
      };
    }
  }, { filename: audioPath });
  const page = Object.assign({
    sessionId: 'sitting', isPageVisible: true, isAppHidden: false, isUnloaded: false,
    timerApp: { _timerForeground: true, _timerAudioInterrupted: false },
    countdownSession: { diagnose() {} },
    data: { isRunning: false, isPaused: false },
    safeTimerEffect(_type, action) { try { return action(); } catch (_) { return undefined; } }
  }, module.exports.timerAudioMethods);
  page.initializeSessionAudio();
  return { api, page, plays, toasts, vibrations, timers,
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
    },
    ended: result => onEnded(result), get resumes() { return resumes; } };
}

test('a closing cue survives hidden playback and page destruction, and is acknowledged only after natural completion', () => {
  const h = audioHarness();
  h.page.isAppHidden = true;
  h.page.playSessionSound('end');
  assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  assert.deepEqual(h.plays, []);
  h.page.destroyAudioPlayer();
  const replacement = audioHarness({ api: h.api });
  replacement.page.resumeInterruptedAudio();
  replacement.page.resumeInterruptedAudio();
  replacement.page.playSessionSound('end');
  assert.deepEqual(replacement.plays, ['/audio/收坐.mp3']);
  assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  replacement.ended({ failed: false });
  assert.equal(getEndReminder(h.api), null);
  replacement.page.resumeInterruptedAudio();
  replacement.page.playSessionSound('end');
  assert.equal(replacement.plays.length, 1, 'an acknowledged session cannot be replayed by duplicate callbacks');
});

test('interrupted closing playback resumes instead of restarting on repeated foreground events', () => {
  const h = audioHarness();
  h.page.playSessionSound('end');
  h.page.suspendSessionAudio();
  h.page.resumeInterruptedAudio();
  h.page.resumeInterruptedAudio();
  assert.equal(h.plays.length, 1);
  assert.equal(h.resumes, 1);
});

test('a pending end marker cannot announce a still-running or paused session even when the ids match', () => {
  for (const isPaused of [false, true]) {
    const h = audioHarness();
    queueEndReminder(h.api, 'sitting');
    h.page.data.isRunning = !isPaused;
    h.page.data.isPaused = isPaused;
    h.page.deferredEndSound = true;
    h.page.resumeInterruptedAudio();
    assert.deepEqual(h.plays, []);
    assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  }
});

test('a completed countdown can announce despite stale running page data, but an active controller cannot', () => {
  for (const status of ['running', 'paused', 'completed', 'exited']) {
    const h = audioHarness();
    h.page.data.isCountdown = true;
    h.page.data.isRunning = true;
    h.page.countdownSession.getSnapshot = () => ({ sessionId: 'sitting', status });
    queueEndReminder(h.api, 'sitting');
    h.page.resumeInterruptedAudio();
    assert.equal(h.plays.length, ['completed', 'exited'].includes(status) ? 1 : 0, status);
  }
});

test('failed closing audio keeps its durable cue, falls back once, and only retries after another foreground visit', () => {
  const h = audioHarness();
  h.page.playSessionSound('end');
  h.ended({ failed: true });
  assert.equal(h.vibrations.length, 1);
  assert.equal(h.toasts.length, 1);
  assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  h.page.resumeInterruptedAudio();
  h.page.playSessionSound('end');
  assert.equal(h.plays.length, 1, 'ordinary callbacks cannot loop failed cue playback');
  h.page.resumeInterruptedAudio({ allowEndRetry: true });
  assert.equal(h.plays.length, 2);
  h.ended({ failed: false });
  assert.equal(getEndReminder(h.api), null);
});

test('a selected closing vibration acknowledges the cue after three seconds without attempting bell playback', () => {
  const h = audioHarness({ reminderMode: 'vibrate' });
  h.page.playSessionSound('end');
  h.page.resumeInterruptedAudio();
  assert.equal(h.vibrations.length, 1);
  assert.deepEqual(h.plays, []);
  assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  h.vibrations[0].success?.({});
  h.advance(2999);
  assert.deepEqual(getEndReminder(h.api), { sessionId: 'sitting' });
  assert.ok(h.vibrations.length > 1);
  h.advance(1);
  assert.equal(getEndReminder(h.api), null);
  const completedPulses = h.vibrations.length;
  h.page.resumeInterruptedAudio();
  h.page.playSessionSound('end');
  h.advance(3000);
  assert.equal(h.vibrations.length, completedPulses, 'completed reminders do not replay');
});

test('dismissing a closing vibration cancels the remaining pulses and ignores late native callbacks', () => {
  const h = audioHarness({ reminderMode: 'vibrate' });
  h.page.playSessionSound('end');
  h.advance(800);
  const pulsesBeforeDismissal = h.vibrations.length;
  const firstPulse = h.vibrations[0];
  h.page.dismissSessionEndReminder();
  firstPulse.success?.({});
  firstPulse.fail?.({ errMsg: 'late native failure' });
  h.advance(10000);
  assert.equal(h.vibrations.length, pulsesBeforeDismissal);
  assert.equal(getEndReminder(h.api), null);
  assert.equal(h.toasts.length, 0);
});

test('a new foreground visit permits one failed-cue retry even when PageShow precedes AppShow', () => {
  const h = audioHarness();
  h.page.playSessionSound('end');
  h.ended({ failed: true });
  h.page.isAppHidden = true;
  h.page.resumeInterruptedAudio({ allowEndRetry: true });
  assert.equal(h.plays.length, 1);
  h.page.isAppHidden = false;
  h.page.resumeInterruptedAudio();
  h.page.resumeInterruptedAudio();
  assert.equal(h.plays.length, 2);
});

test('a newly started sitting discards an older pending closing cue before scheduling its opening cue', () => {
  const h = audioHarness();
  queueEndReminder(h.api, 'old-sitting');
  h.page.data.isRunning = true;
  h.page.startSessionAudio();
  h.page.resumeInterruptedAudio();
  assert.equal(getEndReminder(h.api), null);
  assert.deepEqual(h.plays, []);
  assert.equal(h.timers.size, 1);
});


test('explicit dismissal persists even when the first reminder read fails', () => {
  for (const failWrite of [false, true]) {
    const api = storageApi();
    api.storage.set('timerPendingEndReminder', { sessionId: 'previous-sitting' });
    const read = api.getStorageSync;
    const write = api.setStorageSync;
    api.getStorageSync = () => { throw new Error('temporary read failure'); };
    if (failWrite) api.setStorageSync = () => { throw new Error('temporary write failure'); };
    assert.equal(reminders.dismissEndReminder(api), null);
    api.getStorageSync = read; api.setStorageSync = write;
    assert.equal(getEndReminder(api), null, 'dismissed intent cannot revive after storage recovers');
    assert.equal(api.storage.get('timerPendingEndReminder'), null);
  }
});

test('starting a new sitting retires an unreadable old reminder before opening playback', () => {
  const api = storageApi();
  api.storage.set('timerPendingEndReminder', { sessionId: 'previous-sitting' });
  const read = api.getStorageSync;
  api.getStorageSync = () => { throw new Error('temporary read failure'); };
  const h = audioHarness({ api }); h.page.data.isRunning = true;
  h.page.startSessionAudio();
  api.getStorageSync = read;
  assert.equal(getEndReminder(api), null);
  assert.deepEqual(h.plays, []);
});
