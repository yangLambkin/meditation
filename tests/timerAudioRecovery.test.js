const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../miniprogram/utils/timerAudio.js');
const OPENING = '/audio/起坐.mp3';
const CLOSING = '/audio/收坐.mp3';
const GUIDE = 'https://example.test/guide.mp3';

// This harness exercises durable audio intent; native cue retry behavior has
// separate tests in cuePlayer and timerColdStart.
function harness({ storage = new Map(), at = 100000, sessionId = 'sitting', paused = false,
  active = true, writeFails = false, readFails = false } = {}) {
  let now = at;
  let nextTimer = 0;
  const timers = new Map();
  const plays = [];
  const diagnostics = [];
  const writes = [];
  const vibrations = [];
  const urlRequests = [];
  const toasts = [];
  let cueOptions;
  let cueSource = '';
  let cuePosition = 0;
  const cue = {
    ensurePlayer() {}, preload() {},
    stop() { cueSource = ''; cuePosition = 0; },
    pause() {}, destroy() {},
    play(source) { cueSource = source; cuePosition = 0; plays.push({ source, position: 0 }); },
    prepare(source, { position }) { cueSource = source; cuePosition = position; },
    resume() { plays.push({ source: cueSource, position: cuePosition }); },
    get position() { return cuePosition; },
    progress(position) { cuePosition = position; },
    finish() { cueOptions.onEnded({ failed: false }); }
  };
  const wx = {
    cloud: { init() {}, getTempFileURL(options) { urlRequests.push(options); } },
    showToast(options) { toasts.push(options); },
    vibrateLong(options) { vibrations.push(now); options.success?.({}); },
    getStorageSync(key) {
      if (typeof readFails === 'function' ? readFails(key) : readFails) throw new Error('read failed');
      return storage.get(key);
    },
    setStorageSync(key, value) {
      if (writeFails) throw new Error('write failed');
      writes.push(key); storage.set(key, structuredClone(value));
    },
    createInnerAudioContext() {
      const events = {};
      const player = { currentTime: 0, startTime: 0, paused: true,
        play() { this.paused = false; this.currentTime = Math.max(this.currentTime, this.startTime); plays.push({ source: this.src, position: this.currentTime }); },
        pause() { this.paused = true; }, stop() { this.paused = true; this.currentTime = 0; }, destroy() { this.paused = true; },
        finish() { events.Ended?.(); }, progress(seconds) { this.currentTime = seconds; events.TimeUpdate?.(); },
        fail() { events.Error?.({ errCode: 10002, errMsg: 'expired source' }); }
      };
      for (const event of ['Play', 'Ended', 'Error', 'Waiting', 'Canplay', 'TimeUpdate']) {
        player[`on${event}`] = callback => { events[event] = callback; };
      }
      return player;
    }
  };
  const module = { exports: {} };
  class ClockDate extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, wx, Date: ClockDate, console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === './cuePlayer') return { createCuePlayer(options) { cueOptions = options; return cue; } };
      return require(path.join(__dirname, '../miniprogram/utils', name));
    }
  }, { filename });
  const page = {
    ...module.exports.timerAudioMethods,
    sessionId,
    isPageVisible: true, isAppHidden: false, isUnloaded: false,
    timerApp: { _timerForeground: true, _timerAudioInterrupted: false },
    data: { isCountdown: true, isRunning: active && !paused, isPaused: active && paused,
      backgroundMusic: 'default', defaultMusicUrl: GUIDE,
      musicOptions: [{ value: 'default', text: '引导音频' }, { value: 'none', text: '无音乐' }] },
    countdownSession: { diagnose(type) { diagnostics.push(type); }, getSnapshot() { return {}; } },
    setData(values) { Object.assign(this.data, values); },
    safeTimerEffect(type, action) { try { return action(); } catch (_) { diagnostics.push(type); } }
  };
  page.initializeSessionAudio();
  const advance = milliseconds => {
    const target = now + milliseconds;
    for (;;) {
      const due = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].callback();
    }
    now = target;
  };
  return { page, storage, plays, writes, cue, advance, diagnostics, vibrations, urlRequests, toasts, now: () => now };
}

test('cold recovery preserves an unplayed opening even if the process ended without hide or unload', () => {
  const old = harness();
  old.page.startSessionAudio();
  const fresh = harness({ storage: old.storage, at: old.now() + 20000 });
  fresh.page.restoreSessionAudio();
  fresh.page.resumeInterruptedAudio(); fresh.advance(0);
  assert.deepEqual(fresh.plays, [{ source: OPENING, position: 0 }]);
  fresh.cue.finish();
  assert.deepEqual(fresh.plays.map(value => value.source), [OPENING, GUIDE]);
  assert.equal(fresh.storage.get('timerSessionAudio').openingReminderCompleted, true);
});

test('cold recovery resumes an interrupted opening from its confirmed position', () => {
  const old = harness();
  old.page.startSessionAudio(); old.advance(5000); old.cue.progress(7);
  old.page.timerApp._timerAudioInterrupted = true;
  old.page.suspendSessionAudio();
  const fresh = harness({ storage: old.storage, at: old.now() + 30000 });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, [{ source: OPENING, position: 7 }]);
  fresh.cue.finish();
  assert.equal(fresh.plays.at(-1).source, GUIDE);
});

test('manual pause keeps preparation frozen through a cold restart until explicit resume', () => {
  const old = harness();
  old.page.startSessionAudio(); old.advance(2000);
  Object.assign(old.page.data, { isRunning: false, isPaused: true });
  old.page.pauseSessionAudio();
  const fresh = harness({ storage: old.storage, at: old.now() + 30000, paused: true });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio(); fresh.advance(10000);
  assert.deepEqual(fresh.plays, []);
  Object.assign(fresh.page.data, { isRunning: true, isPaused: false });
  fresh.page.startSessionAudio({ resume: true }); fresh.advance(2999);
  assert.deepEqual(fresh.plays, []);
  fresh.advance(1);
  assert.equal(fresh.plays[0].source, OPENING);
});

test('a process killed during the opening vibration restores vibration rather than a bell', () => {
  const old = harness({ storage: new Map([['timerReminderSettings', { start: 'vibrate', end: 'bell' }]]) });
  old.page.startSessionAudio(); old.advance(5000);
  assert.equal(old.storage.get('timerSessionAudio').vibrationRemainingMs, 3000);
  const fresh = harness({ storage: old.storage, at: old.now() + 1000 });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.equal(fresh.vibrations.length, 1);
  assert.deepEqual(fresh.plays, []);
  fresh.advance(3000);
  assert.deepEqual(fresh.plays, [{ source: GUIDE, position: 0 }]);
  assert.equal(fresh.storage.get('timerSessionAudio').openingReminderCompleted, true);
});

test('completed openings stay completed while unfinished guidance resumes across processes', () => {
  const old = harness();
  old.page.startSessionAudio(); old.advance(5000); old.cue.finish();
  old.page.backgroundMusicPlayer.currentTime = 19;
  old.page.suspendSessionAudio();
  const fresh = harness({ storage: old.storage, at: old.now() + 45000 });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, [{ source: GUIDE, position: 19 }]);
  fresh.page.backgroundMusicPlayer.finish();
  const again = harness({ storage: old.storage, at: fresh.now() + 10000 });
  again.page.restoreSessionAudio(); again.page.resumeInterruptedAudio();
  Object.assign(again.page.data, { isRunning: false, isPaused: true }); again.page.pauseSessionAudio();
  Object.assign(again.page.data, { isRunning: true, isPaused: false }); again.page.startSessionAudio({ resume: true });
  assert.deepEqual(again.plays, [], 'completed guidance must not restart after a later manual pause');
});

test('an expired or different session cannot restore an old opening or guidance snapshot', () => {
  const old = harness(); old.page.startSessionAudio();
  for (const options of [{ active: false }, { sessionId: 'new-sitting' }]) {
    const fresh = harness({ storage: old.storage, ...options });
    fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio(); fresh.advance(10000);
    assert.deepEqual(fresh.plays, []);
  }
  const ended = harness({ storage: old.storage, active: false });
  ended.page.playSessionSound('end');
  assert.equal(ended.storage.get('timerSessionAudio'), null);
  assert.deepEqual(ended.plays, [{ source: CLOSING, position: 0 }]);
});

test('clearing an older session cannot erase a newer session audio checkpoint', () => {
  const fresh = harness({ sessionId: 'new-sitting' }); fresh.page.startSessionAudio();
  fresh.page.clearSessionAudioRecovery('old-sitting');
  assert.equal(fresh.storage.get('timerSessionAudio').sessionId, 'new-sitting');
  fresh.page.clearSessionAudioRecovery();
  assert.equal(fresh.storage.get('timerSessionAudio'), null);
});

test('storage errors do not prevent opening playback and retain a same-process recovery copy', () => {
  const h = harness({ writeFails: true });
  h.page.startSessionAudio(); h.advance(5000);
  assert.equal(h.plays[0].source, OPENING);
  assert.equal(h.page.timerApp._timerSessionAudio.currentSessionSound, 'start');
  assert.ok(h.diagnostics.includes('save_audio_checkpoint'));
  const unreadable = harness({ readFails: true });
  assert.doesNotThrow(() => unreadable.page.restoreSessionAudio());
  assert.deepEqual(unreadable.plays, []);
});

test('guidance progress checkpoints are bounded and malformed checkpoints stay silent', () => {
  const h = harness(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
  const before = h.writes.length;
  for (let i = 1; i <= 99; i++) { h.advance(100); h.page.backgroundMusicPlayer.progress(i / 10); }
  assert.equal(h.writes.length, before);
  h.advance(100); h.page.backgroundMusicPlayer.progress(10);
  assert.equal(h.writes.length, before + 1);
  assert.equal(h.storage.get('timerSessionAudio').guidePosition, 10);
  h.storage.set('timerSessionAudio', { ...h.storage.get('timerSessionAudio'), cuePosition: Infinity });
  const fresh = harness({ storage: h.storage });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, []);
});

test('an expired restored guide resumes at its position when its refreshed cloud URL arrives', () => {
  for (const refreshFirst of [false, true]) {
    const old = harness(); old.page.startSessionAudio(); old.advance(5000); old.cue.finish();
    old.page.backgroundMusicPlayer.currentTime = 19; old.page.suspendSessionAudio();
    const fresh = harness({ storage: old.storage, at: old.now() + 30000 });
    fresh.page.getBackgroundMusicUrl(); fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
    const stalePlayer = fresh.page.backgroundMusicPlayer;
    const refresh = () => fresh.urlRequests[0].success({ fileList: [{ tempFileURL: 'https://example.test/fresh-guide.mp3' }] });
    if (refreshFirst) refresh();
    stalePlayer.fail();
    if (!refreshFirst) refresh();
    assert.deepEqual(fresh.plays, [
      { source: GUIDE, position: 19 }, { source: 'https://example.test/fresh-guide.mp3', position: 19 }
    ]);
    assert.notEqual(fresh.page.backgroundMusicPlayer, stalePlayer);
  }
});

test('a refreshed guide URL cannot override a manual pause or an ongoing audio interruption', () => {
  for (const paused of [false, true]) {
    const old = harness(); old.page.startSessionAudio(); old.advance(5000); old.cue.finish();
    old.page.backgroundMusicPlayer.currentTime = 19; old.page.suspendSessionAudio();
    const fresh = harness({ storage: old.storage });
    fresh.page.getBackgroundMusicUrl(); fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
    fresh.page.backgroundMusicPlayer.fail();
    if (paused) {
      Object.assign(fresh.page.data, { isRunning: false, isPaused: true }); fresh.page.pauseSessionAudio();
    } else {
      fresh.page.timerApp._timerAudioInterrupted = true; fresh.page.suspendSessionAudio();
    }
    fresh.urlRequests[0].success({ fileList: [{ tempFileURL: 'https://example.test/fresh-guide.mp3' }] });
    assert.equal(fresh.plays.length, 1);
    if (paused) {
      Object.assign(fresh.page.data, { isRunning: true, isPaused: false }); fresh.page.startSessionAudio({ resume: true });
    } else {
      fresh.page.timerApp._timerAudioInterrupted = false; fresh.page.resumeInterruptedAudio();
    }
    assert.deepEqual(fresh.plays.at(-1), { source: 'https://example.test/fresh-guide.mp3', position: 19 });
  }
});

test('a cloud URL refreshed before checkpoint restoration is not replaced by its expired predecessor', () => {
  const old = harness(); old.page.startSessionAudio(); old.advance(5000); old.cue.finish();
  old.page.backgroundMusicPlayer.currentTime = 19; old.page.suspendSessionAudio();
  const fresh = harness({ storage: old.storage });
  fresh.page.getBackgroundMusicUrl();
  fresh.urlRequests[0].success({ fileList: [{ tempFileURL: 'https://example.test/fresh-guide.mp3' }] });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, [{ source: 'https://example.test/fresh-guide.mp3', position: 19 }]);
});

test('audio restoration waits for a late timer identity without overwriting its saved opening', () => {
  const old = harness(); old.page.startSessionAudio();
  const checkpoint = structuredClone(old.storage.get('timerSessionAudio'));
  const fresh = harness({ storage: old.storage, sessionId: null, active: false, at: old.now() + 20000 });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, []);
  fresh.page.sessionId = 'sitting'; fresh.page.data.isRunning = true;
  fresh.page.suspendSessionAudio();
  assert.deepEqual(fresh.storage.get('timerSessionAudio'), checkpoint, 'unrestored defaults cannot overwrite the original cue');
  fresh.page.resumeInterruptedAudio(); fresh.advance(0);
  assert.deepEqual(fresh.plays, [{ source: OPENING, position: 0 }]);
  fresh.cue.progress(7); fresh.page.resumeInterruptedAudio(); fresh.page.restoreSessionAudio();
  assert.equal(fresh.cue.position, 7, 'later shows cannot rewind a successfully restored cue');
  assert.equal(fresh.plays.length, 1);
});

test('a failed audio checkpoint read retries on the next show and a new sitting cancels that retry', () => {
  for (const newSession of [false, true]) {
    const old = harness(); old.page.startSessionAudio();
    let failed = true;
    const fresh = harness({ storage: old.storage, at: old.now() + 20000,
      readFails: key => failed && key === 'timerSessionAudio' });
    fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio(); fresh.advance(1000);
    assert.deepEqual(fresh.plays, []);
    if (newSession) {
      fresh.page.sessionId = 'next-sitting'; fresh.page.startSessionAudio();
    }
    failed = false;
    fresh.page.resumeInterruptedAudio(); fresh.advance(newSession ? 4999 : 0);
    if (newSession) {
      assert.deepEqual(fresh.plays, [], 'an old pending recovery cannot bypass the new preparation');
      fresh.advance(1);
      assert.equal(fresh.storage.get('timerSessionAudio').sessionId, 'next-sitting');
    }
    assert.deepEqual(fresh.plays, [{ source: OPENING, position: 0 }]);
    fresh.page.resumeInterruptedAudio();
    assert.equal(fresh.plays.length, 1);
  }
});


test('retired guide events cannot complete or destroy guidance in a new sitting', () => {
  for (const beforeOpening of [false, true]) {
    const h = harness(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
    const retired = h.page.backgroundMusicPlayer;
    h.page.stopBackgroundMusic();
    h.page.sessionId = 'next-sitting'; h.page.startSessionAudio();
    if (!beforeOpening) { h.advance(5000); h.cue.finish(); }
    retired.finish(); retired.fail();
    assert.equal(h.page.guideCompleted, false, 'old ended events cannot mark the new guide complete');
    if (beforeOpening) { h.advance(5000); h.cue.finish(); }
    assert.ok(h.page.backgroundMusicPlayer, 'new guidance remains playable');
    assert.notEqual(h.page.backgroundMusicPlayer, retired);
    assert.equal(h.storage.get('timerSessionAudio').guideCompleted, false);
    assert.deepEqual(h.plays.map(play => play.source), [OPENING, GUIDE, OPENING, GUIDE]);
  }
});

test('a guide URL arriving after the opening starts the selected guidance once', () => {
  const h = harness(); h.page.data.defaultMusicUrl = '';
  h.page.getBackgroundMusicUrl(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
  assert.deepEqual(h.plays.map(play => play.source), [OPENING]);
  h.urlRequests[0].success({ fileList: [{ tempFileURL: GUIDE }] });
  assert.deepEqual(h.plays.map(play => play.source), [OPENING, GUIDE]);
  h.page.resumeGuideAfterUrlRefresh();
  assert.equal(h.plays.length, 2);
});

test('unavailable guide loading preserves timing and never requests a missing bundled fallback', () => {
  const h = harness(); h.page.data.defaultMusicUrl = '';
  h.page.getBackgroundMusicUrl();
  h.urlRequests[0].fail({ errMsg: 'offline' });
  assert.equal(h.toasts.length, 0, 'opening the timer alone does not need a guide warning');
  h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
  assert.deepEqual(h.plays.map(play => play.source), [OPENING]);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.toasts.length, 1);
  h.page.playBackgroundMusic();
  assert.equal(h.toasts.length, 1, 'one unavailable source does not repeatedly interrupt the sitting');
  h.page.getBackgroundMusicUrl();
  h.urlRequests[1].success({ fileList: [{ tempFileURL: GUIDE }] });
  assert.deepEqual(h.plays.map(play => play.source), [OPENING, GUIDE]);
});

test('late first guide URLs respect manual pause, interruption and page teardown', () => {
  for (const boundary of ['pause', 'interruption', 'unload']) {
    const h = harness(); h.page.data.defaultMusicUrl = '';
    h.page.getBackgroundMusicUrl(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
    if (boundary === 'pause') {
      Object.assign(h.page.data, { isRunning: false, isPaused: true }); h.page.pauseSessionAudio();
    } else if (boundary === 'interruption') {
      h.page.timerApp._timerAudioInterrupted = true; h.page.suspendSessionAudio();
    } else {
      h.page.isUnloaded = true;
      h.page.setData = () => { throw new Error('the old page must not render'); };
    }
    assert.doesNotThrow(() => h.urlRequests[0].success({ fileList: [{ tempFileURL: GUIDE }] }));
    assert.deepEqual(h.plays.map(play => play.source), [OPENING]);
    if (boundary === 'pause') {
      Object.assign(h.page.data, { isRunning: true, isPaused: false }); h.page.startSessionAudio({ resume: true });
    } else if (boundary === 'interruption') {
      h.page.timerApp._timerAudioInterrupted = false; h.page.resumeInterruptedAudio();
    }
    assert.deepEqual(h.plays.map(play => play.source), boundary === 'unload' ? [OPENING] : [OPENING, GUIDE]);
  }
});

test('a failed opening does not discard the selected guide while its URL is loading', () => {
  const h = harness(); h.page.data.defaultMusicUrl = '';
  h.page.getBackgroundMusicUrl(); h.page.startSessionAudio(); h.advance(5000);
  h.page.handleSessionSoundEnded({ failed: true });
  h.urlRequests[0].success({ fileList: [{ tempFileURL: GUIDE }] });
  assert.deepEqual(h.plays.map(play => play.source), [OPENING, GUIDE]);
  assert.equal(h.page.openingReminderCompleted, false, 'the failed opening still retains its separate recovery intent');
});


function selectGuide(page, value) {
  page.selectMusic({ currentTarget: { dataset: { value } } });
}

test('live guide selection pauses immediately and resumes the same position without duplicate play', () => {
  const h = harness(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
  const guide = h.page.backgroundMusicPlayer; guide.progress(19);
  selectGuide(h.page, 'none');
  assert.equal(guide.paused, true);
  assert.equal(h.page.guidePlaybackWanted, false);
  assert.equal(h.page.resumeGuideAfterInterruption, false);
  assert.equal(h.storage.get('timerSessionAudio').backgroundMusic, 'none');
  assert.equal(h.storage.get('timerSessionAudio').guidePosition, 19);
  selectGuide(h.page, 'default');
  assert.equal(h.page.backgroundMusicPlayer, guide);
  assert.equal(guide.paused, false);
  assert.deepEqual(h.plays.at(-1), { source: GUIDE, position: 19 });
  const count = h.plays.length;
  selectGuide(h.page, 'default');
  assert.equal(h.plays.length, count, 'selecting the already playing option does not restart native playback');
});

test('live selection respects preparation, opening audio, manual pause and interruptions', () => {
  for (const boundary of ['preparation', 'opening', 'pause', 'interruption', 'hidden']) {
    const h = harness(); h.page.data.backgroundMusic = 'none'; h.page.startSessionAudio();
    if (boundary !== 'preparation') h.advance(5000);
    if (!['preparation', 'opening'].includes(boundary)) h.cue.finish();
    if (boundary === 'pause') {
      Object.assign(h.page.data, { isRunning: false, isPaused: true }); h.page.pauseSessionAudio();
    } else if (boundary === 'interruption') {
      h.page.timerApp._timerAudioInterrupted = true; h.page.suspendSessionAudio();
    } else if (boundary === 'hidden') {
      h.page.isPageVisible = false; h.page.suspendSessionAudio();
    }
    selectGuide(h.page, 'default');
    assert.equal(h.plays.filter(play => play.source === GUIDE).length, 0, boundary);
    if (boundary === 'preparation') { h.advance(5000); h.cue.finish(); }
    else if (boundary === 'opening') h.cue.finish();
    else if (boundary === 'pause') {
      Object.assign(h.page.data, { isRunning: true, isPaused: false }); h.page.startSessionAudio({ resume: true });
    } else {
      h.page.timerApp._timerAudioInterrupted = false; h.page.isPageVisible = true; h.page.resumeInterruptedAudio();
    }
    assert.equal(h.plays.filter(play => play.source === GUIDE).length, 1, boundary);
  }
});

test('choosing silence cancels deferred guidance and preserves progress through cold recovery', () => {
  const old = harness(); old.page.startSessionAudio(); old.advance(5000); old.cue.finish();
  old.page.backgroundMusicPlayer.progress(19);
  old.page.timerApp._timerAudioInterrupted = true; old.page.suspendSessionAudio();
  selectGuide(old.page, 'none');
  assert.equal(old.page.resumeGuideAfterInterruption, false);
  old.page.timerApp._timerAudioInterrupted = false; old.page.resumeInterruptedAudio();
  assert.equal(old.plays.filter(play => play.source === GUIDE).length, 1);
  const fresh = harness({ storage: old.storage });
  fresh.page.restoreSessionAudio(); fresh.page.resumeInterruptedAudio();
  assert.deepEqual(fresh.plays, []);
  selectGuide(fresh.page, 'default');
  assert.deepEqual(fresh.plays, [{ source: GUIDE, position: 19 }]);
});

test('explicitly selecting completed guidance starts it again while ordinary resumes stay silent', () => {
  const h = harness(); h.page.startSessionAudio(); h.advance(5000); h.cue.finish();
  const finished = h.page.backgroundMusicPlayer; finished.progress(120); finished.finish();
  h.page.playBackgroundMusic();
  assert.equal(h.plays.filter(play => play.source === GUIDE).length, 1);
  selectGuide(h.page, 'default');
  assert.notEqual(h.page.backgroundMusicPlayer, finished);
  assert.equal(h.page.guideCompleted, false);
  assert.deepEqual(h.plays.at(-1), { source: GUIDE, position: 0 });
  finished.finish();
  assert.equal(h.page.guideCompleted, false, 'finished player callbacks cannot terminate the explicit replay');
});
