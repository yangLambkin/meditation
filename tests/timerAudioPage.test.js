const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/timer/timer.js');
const START_AUDIO = '/audio/起坐.mp3';
const END_AUDIO = '/audio/收坐.mp3';
const GUIDE_AUDIO = 'https://example.test/meditation-guide.mp3';

function createPage({ withGuide = false, isCountdown = true } = {}) {
  let definition;
  let now = Date.parse('2026-09-18T08:00:00+08:00');
  let nextTimerId = 0;
  const timers = new Map();
  const players = [];
  const audioCalls = [];
  const navigations = [];
  const modals = [];
  const toasts = [];
  const listeners = { show: new Set(), hide: new Set() };
  const storage = new Map();

  function createAudioPlayer() {
    let src = '';
    const callbacks = { play: new Set(), ended: new Set(), error: new Set() };
    const player = {
      paused: true,
      currentTime: 0,
      destroyed: false,
      get src() { return src; },
      set src(value) {
        src = value;
        this.currentTime = 0;
        audioCalls.push({ action: 'src', player: this, src });
      },
      play() {
        assert.equal(this.destroyed, false, 'a destroyed player must never be restarted');
        this.paused = false;
        audioCalls.push({ action: 'play', player: this, src });
        for (const callback of callbacks.play) callback();
      },
      pause() {
        this.paused = true;
        audioCalls.push({ action: 'pause', player: this, src });
      },
      stop() {
        this.paused = true;
        this.currentTime = 0;
        audioCalls.push({ action: 'stop', player: this, src });
      },
      destroy() {
        this.paused = true;
        this.destroyed = true;
        audioCalls.push({ action: 'destroy', player: this, src });
      },
      onPlay(callback) { callbacks.play.add(callback); },
      onEnded(callback) { callbacks.ended.add(callback); },
      onError(callback) { callbacks.error.add(callback); },
      onWaiting() {},
      onCanplay() {},
      emitEnded() {
        this.paused = true;
        // Retain registered callbacks so tests can deliver a queued callback after unload.
        for (const callback of callbacks.ended) callback();
      }
    };
    players.push(player);
    return player;
  }

  function addTimer(callback, delay, interval = false) {
    const id = ++nextTimerId;
    timers.set(id, { callback, due: now + delay, delay, interval });
    return id;
  }

  const wx = {
    createInnerAudioContext: createAudioPlayer,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    onAppShow: callback => listeners.show.add(callback),
    onAppHide: callback => listeners.hide.add(callback),
    offAppShow: callback => listeners.show.delete(callback),
    offAppHide: callback => listeners.hide.delete(callback),
    setKeepScreenOn: options => options.success?.({}),
    showModal: options => modals.push(options),
    showToast: options => toasts.push(options),
    navigateTo: options => navigations.push(options.url),
    cloud: {
      init() {},
      getTempFileURL: options => options.success?.({ fileList: [] })
    }
  };

  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    wx,
    Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => addTimer(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => addTimer(callback, delay, true),
    clearInterval: id => timers.delete(id),
    require(request) {
      assert.equal(request, '../../utils/screenBrightness');
      return { createScreenBrightnessController: () => ({ dim() {}, restore() {} }) };
    },
    Page: page => { definition = page; }
  }, { filename: pagePath });

  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  };
  page.onLoad({});
  page.onShow();
  page.setData({
    isCountdown,
    backgroundMusic: withGuide ? 'default' : 'none',
    defaultMusicUrl: GUIDE_AUDIO
  });

  function advance(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due;
      if (timer.interval) timer.due += timer.delay;
      else timers.delete(id);
      timer.callback();
    }
    now = target;
  }

  return {
    page, players, audioCalls, navigations, modals, toasts, advance,
    plays: () => audioCalls.filter(call => call.action === 'play').map(call => call.src),
    emitApp: event => { for (const callback of [...listeners[event]]) callback(); }
  };
}

test('timing starts immediately but 起坐 waits until exactly five seconds in either mode', () => {
  for (const isCountdown of [true, false]) {
    const { page, players, plays, advance } = createPage({ isCountdown });
    assert.deepEqual(plays(), []);
    page.startTimer();
    assert.equal(page.data.isRunning, true);
    assert.deepEqual(plays(), []);
    advance(1000);
    assert.equal(page.data.elapsedTime, 1, 'the initial wait is included in meditation time');
    advance(3999);
    assert.deepEqual(plays(), [], 'no cue may play at 4,999 ms');
    advance(1);
    assert.equal(page.data.elapsedTime, 5);
    assert.deepEqual(plays(), [START_AUDIO]);
    assert.equal(players[0].loop, false);
    assert.equal(players[0].obeyMuteSwitch, false);
    players[0].emitEnded();
    assert.deepEqual(plays(), [START_AUDIO]);
  }
});

test('the guide waits until 起坐 finishes, including when the app goes into the background', () => {
  const { page, players, plays, emitApp, advance } = createPage({ withGuide: true });
  page.startTimer();
  assert.deepEqual(plays(), []);
  emitApp('hide');
  advance(100);
  assert.deepEqual(plays(), []);
  advance(4899);
  assert.deepEqual(plays(), [], 'the initial wait must also keep the guide silent');
  advance(1);
  assert.deepEqual(plays(), [START_AUDIO]);
  players[0].emitEnded();
  assert.deepEqual(plays(), [START_AUDIO, GUIDE_AUDIO]);
});

test('pausing during the five-second wait freezes its remaining time until the timer resumes', () => {
  for (const pauseAt of [0, 2000, 4999]) {
    const { page, players, plays, advance } = createPage({ withGuide: true });
    page.startTimer();
    advance(pauseAt);
    page.pauseTimer();
    advance(10000);
    assert.deepEqual(plays(), [], `paused after ${pauseAt} ms`);
    page.startTimer();
    assert.deepEqual(plays(), [], 'resuming a pending cue must not play it immediately');
    advance(4999 - pauseAt);
    assert.deepEqual(plays(), [], '4,999 ms of cumulative running time is still silent');
    advance(1);
    assert.deepEqual(plays(), [START_AUDIO]);
    players[0].emitEnded();
    assert.deepEqual(plays(), [START_AUDIO, GUIDE_AUDIO]);
  }
});

test('multiple pauses preserve the cumulative five-second wait without adding another full delay', () => {
  const { page, plays, advance } = createPage({ withGuide: true });
  page.startTimer();
  advance(1200);
  page.pauseTimer();
  advance(10000);
  page.startTimer();
  advance(800);
  page.pauseTimer();
  advance(10000);
  page.startTimer();
  advance(2999);
  assert.deepEqual(plays(), []);
  advance(1);
  assert.deepEqual(plays(), [START_AUDIO]);
});

test('pausing and resuming 起坐 preserves its playback position and does not start the guide early', () => {
  const { page, players, audioCalls, plays, advance } = createPage({ withGuide: true });
  page.startTimer();
  advance(5000);
  const cue = players[0];
  cue.currentTime = 12.5;
  page.pauseTimer();
  assert.equal(cue.paused, true);
  const resumeIndex = audioCalls.length;
  page.startTimer();
  assert.equal(cue.currentTime, 12.5);
  assert.equal(cue.paused, false);
  assert.equal(audioCalls.slice(resumeIndex).some(call => call.player === cue && ['src', 'stop'].includes(call.action)), false);
  assert.deepEqual(plays(), [START_AUDIO, START_AUDIO]);
  cue.emitEnded();
  assert.deepEqual(plays(), [START_AUDIO, START_AUDIO, GUIDE_AUDIO]);
});

test('resuming after 起坐 finished resumes the guide without replaying 起坐', () => {
  const { page, players, plays, advance } = createPage({ withGuide: true });
  page.startTimer();
  advance(5000);
  players[0].emitEnded();
  const guide = players.find(player => player.src === GUIDE_AUDIO);
  guide.currentTime = 7;
  page.pauseTimer();
  assert.equal(guide.paused, true);
  page.startTimer();
  assert.equal(guide.currentTime, 7);
  assert.deepEqual(plays(), [START_AUDIO, GUIDE_AUDIO, GUIDE_AUDIO]);
});

test('countdown completion replaces a still-playing 起坐 with 收坐 and never starts the guide afterward', () => {
  const { page, players, plays, advance, modals } = createPage({ withGuide: true });
  page.setData({ totalTime: 6, remainingTime: 6 });
  page.startTimer();
  advance(6000);
  assert.equal(page.data.isRunning, false);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
  assert.equal(modals.at(-1).title, '计时结束');
  players[0].emitEnded();
  advance(1000);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
});

test('countdown completion during the initial wait cancels 起坐 and plays only 收坐', () => {
  const { page, players, plays, advance, modals } = createPage({ withGuide: true });
  page.setData({ totalTime: 2, remainingTime: 2 });
  page.startTimer();
  advance(2000);
  assert.equal(page.data.isRunning, false);
  assert.deepEqual(plays(), [END_AUDIO]);
  assert.equal(modals.at(-1).title, '计时结束');
  players[0].emitEnded();
  advance(10000);
  assert.deepEqual(plays(), [END_AUDIO], 'the canceled opening cue must not fire later');
});

test('manual stop plays 收坐 in both modes, including paused and still-waiting sessions', () => {
  for (const isCountdown of [true, false]) {
    for (const pauseFirst of [false, true]) {
      for (const stopAt of [1000, 5000]) {
        const { page, plays, navigations, advance } = createPage({ isCountdown });
        page.startTimer();
        advance(stopAt);
        if (pauseFirst) page.pauseTimer();
        page.handleStop();
        const expected = stopAt < 5000 ? [END_AUDIO] : [START_AUDIO, END_AUDIO];
        assert.deepEqual(plays(), expected, `countdown=${isCountdown}, paused=${pauseFirst}, stopAt=${stopAt}`);
        assert.deepEqual(navigations, []);
        page.stopTimer();
        advance(6000);
        assert.deepEqual(plays(), expected, 'stopping must cancel the pending cue and an idle stop must remain silent');
      }
    }
  }
});

test('manual stop under one minute shows a toast without opening a record in either mode', () => {
  for (const isCountdown of [true, false]) {
    for (const pauseFirst of [false, true]) {
      for (const stopAt of [0, 1000, 30000, 59999]) {
        const { page, navigations, toasts, advance } = createPage({ isCountdown });
        page.startTimer();
        advance(stopAt);
        if (pauseFirst) {
          page.pauseTimer();
          advance(120000);
        }
        page.handleStop();
        assert.deepEqual(navigations, []);
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].title, '时间不足1分钟');
        assert.equal(toasts[0].icon, 'none');
        assert.equal(page.data.isRunning, false);
        assert.equal(page.data.isPaused, false);
        assert.equal(page.data.timerInterval, null);
        page.handleStop();
        assert.equal(toasts.length, 1, 'repeated stops must not show another toast');
      }
    }
  }
});

test('manual stop rounds elapsed minutes down once a full minute has elapsed in either mode', () => {
  for (const isCountdown of [true, false]) {
    for (const [seconds, minutes] of [[60, 1], [89, 1], [90, 1], [119, 1], [120, 2], [629, 10], [630, 10]]) {
      const { page, navigations, toasts, advance } = createPage({ isCountdown });
      page.startTimer();
      advance(seconds * 1000);
      page.handleStop();
      assert.deepEqual(navigations, [`/pages/recorder/recorder?duration=${minutes}`]);
      assert.deepEqual(toasts, []);
      assert.equal(page.data.isRunning, false);
      assert.equal(page.data.isPaused, false);
      assert.equal(page.data.timerInterval, null);
    }
  }
});

test('manual stop excludes completed and current pauses from the recorded duration', () => {
  for (const isCountdown of [true, false]) {
    for (const stopWhilePaused of [false, true]) {
      const { page, navigations, advance } = createPage({ isCountdown });
      page.startTimer();
      advance(60000);
      page.pauseTimer();
      advance(300000);
      page.startTimer();
      advance(90000);
      if (stopWhilePaused) {
        page.pauseTimer();
        advance(180000);
      }
      page.handleStop();
      assert.deepEqual(navigations, ['/pages/recorder/recorder?duration=2']);
    }
  }
});

test('idle or repeated manual stops do not open another record', () => {
  for (const isCountdown of [true, false]) {
    const { page, navigations, advance } = createPage({ isCountdown });
    page.handleStop();
    assert.deepEqual(navigations, []);
    page.startTimer();
    advance(120000);
    page.handleStop();
    page.handleStop();
    assert.deepEqual(navigations, ['/pages/recorder/recorder?duration=2']);
  }
});

test('reset, mode changes, and duration changes cancel the cue without playing 收坐', () => {
  const changes = {
    reset: page => page.resetTimer(),
    mode: page => page.toggleMode({ detail: { value: false } }),
    duration: page => page.selectDuration({ currentTarget: { dataset: { value: 10 } } }),
    customDuration(page) {
      page.setData({ isValidCustomTime: true, customTimeInput: '12' });
      page.confirmCustomTime();
    }
  };
  for (const [name, change] of Object.entries(changes)) {
    for (const pauseFirst of [false, true]) {
      for (const changeAt of [2000, 5000]) {
        const { page, players, plays, advance } = createPage({ withGuide: true });
        page.startTimer();
        advance(changeAt);
        if (pauseFirst) page.pauseTimer();
        change(page);
        assert.equal(page.data.isRunning, false, name);
        assert.equal(page.data.isPaused, false, name);
        assert.equal(players[0].paused, true, name);
        players[0].emitEnded();
        advance(6000);
        assert.deepEqual(plays(), changeAt < 5000 ? [] : [START_AUDIO], `${name}, paused=${pauseFirst}, changeAt=${changeAt}`);
      }
    }
  }
});

test('a new session interrupts 收坐 and waits its own five seconds before 起坐 starts from the beginning', () => {
  const { page, players, plays, advance } = createPage();
  page.startTimer();
  advance(5000);
  page.stopTimer();
  players[0].currentTime = 8;
  page.startTimer();
  assert.equal(players[0].paused, true, 'the old closing cue must stop during the new wait');
  advance(4999);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
  advance(1);
  assert.equal(players[0].currentTime, 0);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO, START_AUDIO]);
});

test('resetting during the wait gives a new session a full five-second delay', () => {
  const { page, plays, advance } = createPage({ withGuide: true });
  page.startTimer();
  advance(2000);
  page.resetTimer();
  page.startTimer();
  advance(3000);
  assert.deepEqual(plays(), [], 'the previous session deadline cannot trigger the new opening cue');
  advance(1999);
  assert.deepEqual(plays(), []);
  advance(1);
  assert.deepEqual(plays(), [START_AUDIO]);
});

test('navigating to the recorder allows 收坐 to finish while the timer page is hidden', () => {
  const { page, players, plays, navigations, advance } = createPage({ isCountdown: false });
  page.startTimer();
  advance(60000);
  page.handleStop();
  page.onHide();
  assert.equal(navigations.length, 1);
  assert.equal(players[0].src, END_AUDIO);
  assert.equal(players[0].paused, false);
  players[0].emitEnded();
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
});

test('unloading destroys the cue player and queued callbacks cannot start or restart audio', () => {
  for (const cue of ['waiting', 'start', 'end']) {
    const { page, players, plays, advance, emitApp } = createPage({ withGuide: true });
    page.startTimer();
    advance(cue === 'waiting' ? 2000 : 5000);
    if (cue === 'end') page.stopTimer();
    const beforeUnload = plays();
    page.onUnload();
    assert.equal(players[0].destroyed, true);
    players[0].emitEnded();
    emitApp('hide');
    emitApp('show');
    advance(6000);
    assert.deepEqual(plays(), beforeUnload);
  }
});
