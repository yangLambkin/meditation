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

function audioHarness({ api = storageApi(), reminderMode = 'bell' } = {}) {
  const plays = [];
  const toasts = [];
  const vibrations = [];
  const timers = new Map();
  let nextTimer = 0;
  let onEnded;
  let resumes = 0;
  const wx = Object.assign(api, {
    vibrateLong(options) { vibrations.push(options); },
    showToast(options) { toasts.push(options); }
  });
  const module = { exports: {} };
  const audioPath = path.join(__dirname, '../miniprogram/utils/timerAudio.js');
  vm.runInNewContext(fs.readFileSync(audioPath, 'utf8'), {
    module, wx, Date,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    require(request) {
      if (request === './timerEndReminder') return reminders;
      if (request === './timerReminderSettings') return { getReminderSettings: () => ({ start: 'bell', end: reminderMode }) };
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

test('a selected closing vibration acknowledges the cue without attempting bell playback', () => {
  const h = audioHarness({ reminderMode: 'vibrate' });
  h.page.playSessionSound('end');
  h.page.resumeInterruptedAudio();
  assert.equal(h.vibrations.length, 1);
  assert.deepEqual(h.plays, []);
  assert.equal(getEndReminder(h.api), null);
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
