const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/timer/timer.js');
const contentSecPath = path.join(__dirname, '../miniprogram/utils/contentSec.js');
const START_AUDIO = '/audio/起坐.mp3';
const END_AUDIO = '/audio/收坐.mp3';
const GUIDE_AUDIO = 'https://example.test/meditation-guide.mp3';

function createPage({
  withGuide = false, isCountdown = true, initialStorage = {}, checkText = async () => true,
  recordCheckin, backgroundUpload = async () => ({ success: true }), networkType,
  contentSecRequest = () => new Promise(() => {}), navigateTo
} = {}) {
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
  const storage = new Map(Object.entries(initialStorage));
  const records = [];
  const uploads = [];
  const imagePrefetches = [];

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
    getNetworkType: options => options.success?.({ networkType }),
    hideKeyboard() {},
    navigateTo(options) {
      navigations.push(options.url);
      if (navigateTo) return navigateTo(options);
      page.onHide();
      options.success?.({});
    },
    cloud: {
      init() {},
      getTempFileURL: options => options.success?.({ fileList: [] }),
      callFunction: contentSecRequest
    }
  };

  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  let contentSec = { checkText };
  if (networkType !== undefined) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(contentSecPath, 'utf8'), {
      wx, module, Date: ClockDate,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: (callback, delay) => addTimer(callback, delay),
      clearTimeout: id => timers.delete(id)
    }, { filename: contentSecPath });
    contentSec = module.exports;
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
      if (request === '../../utils/checkin') return {
        recordCheckin(...args) {
          const result = recordCheckin ? recordCheckin(...args) : { success: true };
          if (!result || !result.success) return result;
          records.push(args);
          // The manager owns background failures; the page receives only the local save result.
          if (networkType !== 'none') uploads.push(Promise.resolve(backgroundUpload(...args)).catch(() => {}));
          return result;
        },
        recordCheckinWithSync() {
          assert.fail('timer completion must not wait for or repeat the background upload');
        }
      };
      if (request === '../../utils/contentSec') return contentSec;
      if (request === '../../utils/dailyCardImage') return {
        prepareNextImage() { imagePrefetches.push(true); }
      };
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
    ...(initialStorage.timerState ? {} : { isCountdown }),
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
    page, players, audioCalls, navigations, modals, toasts, records, uploads, storage, advance, imagePrefetches,
    jump: milliseconds => { now += milliseconds; },
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

test('the guide waits until 起坐 finishes', () => {
  const { page, players, plays, advance } = createPage({ withGuide: true });
  page.startTimer();
  assert.deepEqual(plays(), []);
  advance(4999);
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
  const { page, players, plays, advance, toasts } = createPage({ withGuide: true });
  page.setData({ totalTime: 6, remainingTime: 6 });
  page.startTimer();
  advance(6000);
  assert.equal(page.data.isRunning, false);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
  assert.equal(toasts.at(-1).title, '不足1分钟，本次不会记录');
  players[0].emitEnded();
  advance(1000);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
});

test('countdown completion during the initial wait cancels 起坐 and plays only 收坐', () => {
  const { page, players, plays, advance, toasts } = createPage({ withGuide: true });
  page.setData({ totalTime: 2, remainingTime: 2 });
  page.startTimer();
  advance(2000);
  assert.equal(page.data.isRunning, false);
  assert.deepEqual(plays(), [END_AUDIO]);
  assert.equal(toasts.at(-1).title, '不足1分钟，本次不会记录');
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
        assert.equal(toasts[0].title, '不足1分钟，本次不会记录');
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
      assert.deepEqual(navigations, []);
      assert.equal(page.data.completionDuration, minutes);
      assert.equal(page.data.showCompletionDialog, true);
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
      assert.deepEqual(navigations, []);
      assert.equal(page.data.completionDuration, 2);
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
    assert.deepEqual(navigations, []);
    assert.equal(page.data.completionDuration, 2);
    assert.equal(page.data.showCompletionDialog, true);
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
  advance(4000);
  page.resetTimer();
  page.startTimer();
  advance(1000);
  assert.deepEqual(plays(), [], 'the previous session deadline cannot trigger the new opening cue');
  advance(3999);
  assert.deepEqual(plays(), []);
  advance(1);
  assert.deepEqual(plays(), [START_AUDIO]);
});

test('the optional reflection dialog allows 收坐 to finish while the timer page is hidden', () => {
  const { page, players, plays, navigations, advance } = createPage({ isCountdown: false });
  page.startTimer();
  advance(60000);
  page.handleStop();
  page.onHide();
  assert.equal(navigations.length, 0);
  assert.equal(page.data.showCompletionDialog, true);
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


test('completion saves an empty reflection and repeated confirms record and open the daily page once', async () => {
  const { page, records, navigations, advance, toasts, storage } = createPage();
  page.setData({ totalTime: 60, remainingTime: 60 });
  page.startTimer();
  const sessionId = page.sessionId;
  advance(60000);
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(page.data.showStopButton, false);
  assert.equal(page.data.showResetButton, false);
  assert.deepEqual(navigations, [], 'the daily page only opens after confirmation');
  await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  assert.equal(records[0][1].length, 0);
  assert.equal(records[0][2].length, 0);
  assert.equal(records[0][4], sessionId);
  assert.deepEqual(navigations, ['/pages/daily/daily1']);
  assert.equal(page.data.showCompletionDialog, true, 'the outgoing page retains its dialog throughout the route animation');
  page.onShow();
  assert.equal(page.data.showCompletionDialog, false);
  assert.deepEqual(toasts, [], 'saving a completed timer does not show an upload result');
  assert.equal(storage.get('timerPendingCompletion'), null, 'upload retry must not reopen completion for a second save');
});

test('completion preloads the card and keeps the dialog stable until navigation and return finish', async () => {
  let route;
  const { page, advance, records, navigations, imagePrefetches } = createPage({
    navigateTo: options => { route = options; }
  });
  page.startTimer();
  assert.equal(imagePrefetches.length, 0);
  advance(60000);
  page.handleStop();
  assert.equal(imagePrefetches.length, 1, 'the image request starts while the reflection dialog is visible');
  await page.confirmCompletion();
  assert.equal(page.data.showCompletionDialog, true, 'confirmation must not expose the timer behind the dialog');
  assert.equal(page.data.isSavingCompletion, true);
  await page.confirmCompletion();
  assert.equal(navigations.length, 1, 'double taps cannot start concurrent routes');
  assert.equal(records.length, 1);
  page.onHide();
  route.success({});
  assert.equal(page.data.showCompletionDialog, true, 'the outgoing view remains stable during the native slide');
  page.onShow();
  assert.equal(page.data.showCompletionDialog, false);
  assert.equal(page.data.isSavingCompletion, false);
  assert.equal(page.data.isCompletionSaved, false);
  page.startTimer();
  assert.equal(page.data.isRunning, true);
});

test('failed navigation can retry opening the saved card without recording or moderating twice', async () => {
  for (const throws of [false, true]) {
    let route;
    let shouldFail = true;
    const checked = [];
    const { page, advance, records, navigations, toasts, storage } = createPage({
      checkText: async text => { checked.push(text); return true; },
      navigateTo(options) {
        route = options;
        if (throws && shouldFail) throw new Error('route failed');
      }
    });
    page.startTimer();
    advance(60000);
    page.handleStop();
    page.onCompletionInput({ detail: { value: '很平静' } });
    await page.confirmCompletion();
    if (!throws) route.fail({ errMsg: 'navigateTo:fail' });
    assert.equal(page.data.showCompletionDialog, true);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.isCompletionSaved, true);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.equal(toasts.at(-1).title, '记录已保存，日签打开失败，请重试');
    page.startTimer();
    assert.equal(page.data.isRunning, false, 'the saved completion remains available for navigation retry');
    shouldFail = false;
    await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);
    assert.equal(records.length, 1);
    assert.deepEqual(checked, ['很平静']);
    assert.equal(navigations.length, 2);
    page.onHide();
    route.success({});
    page.onShow();
    assert.equal(page.data.showCompletionDialog, false);
  }
});

test('a reflection check finishing in the background saves once and waits for a visible navigation retry', async () => {
  let resolveCheck;
  const { page, advance, records, navigations } = createPage({
    checkText: () => new Promise(resolve => { resolveCheck = resolve; })
  });
  page.startTimer();
  advance(60000);
  page.handleStop();
  page.onCompletionInput({ detail: { value: '安静' } });
  const pending = page.confirmCompletion();
  page.onHide();
  resolveCheck(true);
  await pending;
  assert.equal(records.length, 1);
  assert.equal(navigations.length, 0);
  assert.equal(page.data.isSavingCompletion, false);
  page.onShow();
  await page.confirmCompletion();
  assert.equal(records.length, 1);
  assert.deepEqual(navigations, ['/pages/daily/daily1']);
});

test('a late navigation failure stays silent while hidden and allows retry on return', async () => {
  let route;
  const { page, advance, records, navigations, toasts } = createPage({
    navigateTo: options => { route = options; }
  });
  page.startTimer();
  advance(60000);
  page.handleStop();
  await page.confirmCompletion();
  page.onHide();
  route.fail({ errMsg: 'navigateTo:fail' });
  assert.deepEqual(toasts, []);
  assert.equal(page.data.isSavingCompletion, false);
  page.onShow();
  await page.confirmCompletion();
  assert.equal(records.length, 1);
  assert.equal(navigations.length, 2);
});

test('both timer modes finish locally and a late upload result cannot interrupt the next session', async () => {
  for (const ending of ['count-up stop', 'countdown stop', 'countdown automatic']) {
    for (const outcome of ['success', 'failure', 'rejection']) {
      let resolveUpload;
      let rejectUpload;
      const uploadCalls = [];
      const { page, records, uploads, advance, toasts, storage, navigations } = createPage({
        isCountdown: ending !== 'count-up stop',
        backgroundUpload(...args) {
          uploadCalls.push(args);
          return new Promise((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
        }
      });
      const totalTime = ending === 'countdown automatic' ? 60 : 120;
      page.setData({ totalTime, remainingTime: totalTime });
      page.startTimer();
      const completedSessionId = page.sessionId;
      advance(60000);
      if (ending !== 'countdown automatic') page.handleStop();
      assert.deepEqual(navigations, [], ending);
      await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);
      assert.deepEqual(navigations, ['/pages/daily/daily1'], ending);
      page.onShow();
      assert.equal(page.data.isSavingCompletion, false, 'returning to the timer releases controls before the upload finishes');
      assert.equal(page.data.showCompletionDialog, false);
      assert.equal(toasts.length, 0);
      assert.equal(records.length, 1);
      assert.equal(uploadCalls.length, 1);
      assert.equal(uploadCalls[0][4], records[0][4]);
      assert.equal(uploadCalls[0][3], records[0][3]);
      assert.equal(storage.get('timerPendingCompletion'), null, 'the saved record owns recovery while upload is in flight');
      page.startTimer();
      assert.equal(page.data.isRunning, true, 'a new session can start before the upload finishes');
      assert.notEqual(page.sessionId, completedSessionId);
      const nextSessionId = page.sessionId;
      const nextState = structuredClone(storage.get('timerState'));
      if (outcome === 'rejection') rejectUpload(new Error('network disconnected'));
      else resolveUpload({ success: outcome === 'success', cloudSynced: outcome === 'success' });
      await Promise.all(uploads);
      assert.equal(page.data.isRunning, true);
      assert.equal(page.sessionId, nextSessionId);
      assert.deepEqual(structuredClone(storage.get('timerState')), nextState);
      assert.equal(page.data.showCompletionDialog, false);
      assert.equal(page.data.completionNotice, '');
      assert.deepEqual(toasts, [], `${ending}: ${outcome} must stay silent`);
      await page.confirmCompletion();
      assert.equal(records.length, 1);
      assert.equal(uploadCalls.length, 1);
      assert.deepEqual(navigations, ['/pages/daily/daily1'], 'late uploads and repeated confirms must not navigate again');
    }
  }
});

test('timer upload timeout stays silent after local completion and reopening does not record again', async () => {
  let resolveUpload;
  const { page, records, uploads, advance, toasts, storage } = createPage({
    backgroundUpload: () => new Promise(resolve => { resolveUpload = resolve; })
  });
  page.setData({ totalTime: 60, remainingTime: 60 });
  page.startTimer();
  advance(60000);
  await page.confirmCompletion();
  page.onShow();
  advance(12299);
  assert.equal(page.data.isSavingCompletion, false);
  assert.equal(page.data.showCompletionDialog, false);
  assert.equal(toasts.length, 0);
  page.onUnload();
  page.setData = () => { throw new Error('a completed upload cannot update an unloaded page'); };
  advance(1);
  resolveUpload({ success: true, cloudSynced: false, syncErrorCode: 'CLOUD_TIMEOUT' });
  await Promise.all(uploads);
  assert.deepEqual(toasts, []);
  assert.equal(records.length, 1);
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
  assert.equal(reopened.page.data.showCompletionDialog, false);
  assert.deepEqual(reopened.toasts, []);
  await reopened.page.confirmCompletion();
  assert.equal(reopened.records.length, 0);
});

test('a background timer completion keeps its neutral notice after an upload failure', async () => {
  let resolveUpload;
  const { page, records, uploads, advance, emitApp, storage } = createPage({
    isCountdown: false,
    backgroundUpload: () => new Promise(resolve => { resolveUpload = resolve; })
  });
  page.startTimer();
  advance(60000);
  emitApp('hide');
  assert.equal(records.length, 1);
  assert.equal(storage.get('timerPendingCompletion'), null);
  assert.equal(storage.get('timerCompletionNotice'), '正计时已结束，1分钟已存本机');
  page.onUnload();
  page.setData = () => { throw new Error('a completed upload cannot update an unloaded page'); };
  resolveUpload({ success: true, cloudSynced: false, syncErrorCode: 'CLOUD_TIMEOUT' });
  await Promise.all(uploads);
  assert.equal(storage.get('timerCompletionNotice'), '正计时已结束，1分钟已存本机');
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
  assert.equal(reopened.records.length, 0);
  assert.equal(reopened.toasts.at(-1).title, '正计时已结束，1分钟已存本机');
});

test('optional reflection is checked and recorded as text with no emotion', async () => {
  const checked = [];
  let releaseCheck;
  const { page, records, advance } = createPage({
    isCountdown: false,
    checkText: text => { checked.push(text); return new Promise(resolve => { releaseCheck = resolve; }); }
  });
  page.startTimer();
  advance(120000);
  page.handleStop();
  page.onCompletionInput({ detail: { value: '  很安静  ' } });
  const pending = page.confirmCompletion();
  await page.confirmCompletion();
  assert.equal(records.length, 0);
  assert.deepEqual(checked, ['很安静']);
  releaseCheck(true);
  await pending;
  assert.equal(records.length, 1);
  assert.equal(records[0][2][0].text, '很安静');
  assert.equal(records[0][2][0].emotion.length, 0);
});

test('count-up and countdown save offline reflections locally without contacting the cloud or duplicate records', async () => {
  for (const isCountdown of [false, true]) {
    let cloudRequests = 0;
    const { page, records, storage, advance, toasts } = createPage({
      isCountdown,
      networkType: 'none',
      contentSecRequest() {
        cloudRequests += 1;
        return new Promise(() => {});
      }
    });
    page.setData({ totalTime: 120, remainingTime: 120 });
    page.startTimer();
    const sessionId = page.sessionId;
    advance(120000);
    if (!isCountdown) page.handleStop();
    const endedAt = page.pendingCompletion.endedAt;
    page.onCompletionInput({ detail: { value: '  离线时也很安静  ' } });

    await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);

    assert.equal(cloudRequests, 0, 'known offline status must skip cloud moderation');
    assert.equal(records.length, 1);
    assert.equal(records[0][0], 2);
    assert.equal(records[0][2][0].text, '离线时也很安静');
    assert.equal(records[0][3], endedAt);
    assert.equal(records[0][4], sessionId);
    page.onShow();
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.showCompletionDialog, false);
    assert.equal(page.pendingCompletion, null);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.deepEqual(toasts, [], 'an offline timer completion does not show an upload failure');
    await page.confirmCompletion();
    assert.equal(records.length, 1);

    const reopened = createPage({ initialStorage: Object.fromEntries(storage), networkType: 'none' });
    await reopened.page.confirmCompletion();
    assert.equal(reopened.records.length, 0, 'reopening must not save an offline completion a second time');
  }
});

test('both timer modes release saving within 1500 ms when the network request hangs', async () => {
  for (const isCountdown of [false, true]) {
    let resolveRequest;
    const { page, records, advance } = createPage({
      isCountdown,
      networkType: 'wifi',
      contentSecRequest: () => new Promise(resolve => { resolveRequest = resolve; })
    });
    page.setData({ totalTime: 60, remainingTime: 60 });
    page.startTimer();
    advance(60000);
    if (!isCountdown) page.handleStop();
    page.onCompletionInput({ detail: { value: '弱网时的感受' } });
    const pending = page.confirmCompletion();
    await page.confirmCompletion();
    assert.equal(page.data.isSavingCompletion, true);
    advance(1499);
    await Promise.resolve();
    assert.equal(records.length, 0);
    advance(1);
    await pending;

    assert.equal(records.length, 1);
    assert.equal(records[0][2][0].text, '弱网时的感受');
    page.onShow();
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.showCompletionDialog, false);
    resolveRequest({ result: { success: true, safe: true } });
    await Promise.resolve();
    await page.confirmCompletion();
    assert.equal(records.length, 1, 'a late network response cannot save the completed session again');
  }
});

test('an online rejected reflection stays editable and can be cleared to finish in both modes', async () => {
  for (const isCountdown of [false, true]) {
    const { page, records, advance, storage } = createPage({
      isCountdown,
      networkType: 'wifi',
      contentSecRequest: async () => ({ result: { success: true, safe: false } })
    });
    page.setData({ totalTime: 60, remainingTime: 60 });
    page.startTimer();
    advance(60000);
    if (!isCountdown) page.handleStop();
    page.onCompletionInput({ detail: { value: 'blocked' } });
    await page.confirmCompletion();
    assert.equal(records.length, 0);
    assert.equal(page.data.showCompletionDialog, true);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.completionText, 'blocked');
    assert.equal(storage.get('timerPendingCompletion').text, 'blocked');
    page.onCompletionInput({ detail: { value: '' } });
    await page.confirmCompletion();
    page.onShow();
    assert.equal(records.length, 1);
    assert.equal(page.data.isSavingCompletion, false);
  }
});

test('count-up ends on background with the actual duration and never accrues offline time', () => {
  for (const pauseFirst of [false, true]) {
    const { page, records, storage, advance, emitApp, toasts } = createPage({ isCountdown: false });
    page.startTimer();
    advance(125000);
    if (pauseFirst) { page.pauseTimer(); advance(120000); }
    const beforeHide = page.calculateElapsedTime();
    emitApp('hide');
    assert.equal(records.length, 1);
    assert.equal(records[0][0], 2);
    assert.equal(page.data.elapsedTime, beforeHide);
    assert.equal(page.data.isRunning, false);
    assert.equal(page.data.isPaused, false);
    assert.equal(page.data.timerInterval, null);
    assert.equal(page.startSoundTimer, null);
    assert.equal(storage.get('timerState'), null);
    advance(3600000);
    emitApp('show');
    page.onShow();
    assert.equal(page.data.elapsedTime, beforeHide);
    assert.match(toasts.at(-1).title, /正计时已结束/);
    assert.equal(records.length, 1);
    page.onUnload();
    assert.equal(records.length, 1);
  }
});

test('closing an unfinished count-up shorter than one minute does not create a record or restart the cue', () => {
  const { page, records, plays, advance, emitApp } = createPage({ isCountdown: false });
  page.startTimer();
  advance(2000);
  emitApp('hide');
  advance(60000);
  assert.equal(records.length, 0);
  assert.deepEqual(plays(), []);
  assert.equal(page.data.isRunning, false);
});

test('exiting a running or paused countdown stops it immediately and records only completed minutes once', () => {
  for (const pauseFirst of [false, true]) {
    for (const pageHidesFirst of [false, true]) {
      const { page, records, storage, advance, emitApp, toasts } = createPage();
      page.startTimer();
      const sessionId = page.sessionId;
      advance(125000);
      if (pauseFirst) { page.pauseTimer(); advance(120000); }
      if (pageHidesFirst) page.onHide();
      emitApp('hide');
      if (!pageHidesFirst) page.onHide();
      assert.equal(page.data.isRunning, false);
      assert.equal(page.data.isPaused, false);
      assert.equal(page.data.elapsedTime, 125);
      assert.equal(page.data.remainingTime, 1675);
      assert.equal(page.data.timerInterval, null);
      assert.equal(page.startSoundTimer, null);
      assert.equal(page.data.showStopButton, false);
      assert.equal(page.data.showResetButton, false);
      assert.equal(storage.get('timerState'), null);
      assert.equal(records.length, 1);
      assert.equal(records[0][0], 2);
      assert.equal(records[0][4], sessionId);
      const endedAt = records[0][3];
      emitApp('hide');
      advance(3600000);
      emitApp('show');
      page.onShow();
      assert.equal(page.data.isRunning, false);
      assert.equal(page.data.elapsedTime, 125);
      assert.equal(page.data.remainingTime, 1675);
      assert.match(toasts.at(-1).title, /倒计时已结束/);
      assert.equal(records.length, 1);
      assert.equal(records[0][3], endedAt);
      page.onUnload();
      assert.equal(records.length, 1);
      const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
      assert.equal(reopened.page.data.isRunning, false);
      assert.equal(reopened.records.length, 0);
    }
  }
});

test('exiting a countdown silences pending 起坐, playing 起坐, and playing guide audio', () => {
  for (const sound of ['waiting', 'start', 'guide']) {
    const { page, players, plays, records, advance, emitApp } = createPage({ withGuide: true });
    page.startTimer();
    advance(sound === 'waiting' ? 2000 : 5000);
    if (sound === 'guide') players[0].emitEnded();
    const beforeExit = plays();
    emitApp('hide');
    assert.ok(players.every(player => player.paused), sound);
    players[0].emitEnded();
    advance(3600000);
    emitApp('show');
    page.onShow();
    assert.deepEqual(plays(), beforeExit, 'exit must cancel pending cues without playing 收坐');
    assert.equal(page.data.isRunning, false);
    assert.equal(records.length, 0, 'less than a minute must not create a record');
  }
});

test('unloading a countdown ends it and a fresh start has a new identity and full duration', () => {
  const { page, records, storage, advance } = createPage();
  page.startTimer();
  const sessionId = page.sessionId;
  advance(90000);
  page.onUnload();
  assert.equal(page.data.isRunning, false);
  assert.equal(storage.get('timerState'), null);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
  reopened.page.startTimer();
  assert.equal(reopened.page.data.isRunning, true);
  assert.equal(reopened.page.data.elapsedTime, 0);
  assert.equal(reopened.page.data.remainingTime, 1800);
  assert.notEqual(reopened.page.sessionId, sessionId);
});

test('countdown checkpoints recover only the last known duration after an exit without callbacks', () => {
  const { page, storage, advance } = createPage();
  page.startTimer();
  advance(127000);
  const state = storage.get('timerState');
  assert.equal(state.elapsedTime, 125);
  assert.equal(state.saveTime, state.startTimestamp + 125000);
  for (const isPaused of [false, true]) {
    const savedAt = Date.parse('2026-09-17T08:00:00+08:00');
    const reopened = createPage({ initialStorage: {
      timerState: {
        ...state, isRunning: !isPaused, isPaused, saveTime: savedAt,
        startTimestamp: savedAt - 125000, pauseTimestamp: isPaused ? savedAt : 0
      }
    } });
    assert.equal(reopened.page.data.isRunning, false);
    assert.equal(reopened.page.data.isPaused, false);
    assert.equal(reopened.page.data.elapsedTime, 125);
    assert.equal(reopened.page.data.remainingTime, 1675);
    assert.equal(reopened.records.length, 1);
    assert.equal(reopened.records[0][0], 2);
    assert.equal(reopened.records[0][3], savedAt);
    assert.equal(reopened.records[0][4], state.sessionId);
    assert.equal(reopened.storage.get('timerState'), null);
  }
});

test('a delayed countdown exit cannot record more than its configured duration', () => {
  const { page, records, jump, emitApp } = createPage();
  page.setData({ totalTime: 60, remainingTime: 60 });
  page.startTimer();
  const startedAt = page.data.startTimestamp;
  jump(125000);
  emitApp('hide');
  assert.equal(page.data.isRunning, false);
  assert.equal(page.data.elapsedTime, 60);
  assert.equal(page.data.remainingTime, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  assert.equal(records[0][3], startedAt + 60000);
});

test('unloading a count-up records it once and ends the session', () => {
  const { page, records, advance } = createPage({ isCountdown: false });
  page.startTimer();
  advance(90000);
  page.onUnload();
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  assert.equal(page.data.isRunning, false);
});

test('a failed completion retries with the original session id and timestamp', async () => {
  const attempts = [];
  const { page, storage, advance, toasts, navigations } = createPage({
    recordCheckin(...args) {
      attempts.push(args);
      if (attempts.length === 1) throw new Error('disk busy');
      return { success: true };
    }
  });
  page.startTimer();
  advance(60000);
  page.handleStop();
  await page.confirmCompletion();
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(page.data.isSavingCompletion, false, 'a local write failure must release the save button');
  assert.ok(storage.get('timerPendingCompletion'));
  assert.equal(toasts.at(-1).title, '保存失败，请重试');
  assert.deepEqual(navigations, [], 'a failed save must keep the completion available for retry');
  advance(60000);
  await page.confirmCompletion();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0][3], attempts[1][3]);
  assert.equal(attempts[0][4], attempts[1][4]);
  page.onShow();
  assert.equal(page.data.showCompletionDialog, false);
  assert.equal(page.data.isSavingCompletion, false);
  assert.equal(storage.get('timerPendingCompletion'), null);
  assert.equal(toasts.length, 1, 'successful retry adds no upload result notification');
  assert.deepEqual(navigations, ['/pages/daily/daily1']);
});

test('a restored count-up uses its last foreground checkpoint without adding closed time', () => {
  const savedAt = Date.parse('2026-09-17T08:00:00+08:00');
  const { page, records, storage } = createPage({ initialStorage: {
    timerState: {
      sessionId: 'timer_saved', isCountdown: false, isRunning: true, isPaused: false,
      elapsedTime: 125, totalTime: 1800, saveTime: savedAt, startTimestamp: savedAt - 125000,
      totalPausedTime: 0, pauseTimestamp: 0
    }
  } });
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 2);
  assert.equal(records[0][3], savedAt);
  assert.equal(records[0][4], 'timer_saved');
  assert.equal(page.data.isRunning, false);
  assert.equal(storage.get('timerState'), null);
});

test('unfinished reflection restores the same completion and text after reopening', async () => {
  const completion = { sessionId: 'timer_pending', duration: 7, endedAt: 1720000000000, text: '坐得很稳' };
  const { page, records } = createPage({ initialStorage: { timerPendingCompletion: completion } });
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(page.data.completionText, completion.text);
  page.startTimer();
  assert.equal(page.data.isRunning, false);
  await page.confirmCompletion();
  assert.equal(records[0][3], completion.endedAt);
  assert.equal(records[0][4], completion.sessionId);
});

test('a new session after completion starts at zero with a fresh identity', async () => {
  const { page, advance } = createPage({ isCountdown: false });
  page.startTimer();
  const firstId = page.sessionId;
  advance(60000);
  page.handleStop();
  await page.confirmCompletion();
  page.onShow();
  page.startTimer();
  assert.notEqual(page.sessionId, firstId);
  assert.equal(page.data.elapsedTime, 0);
  assert.equal(page.data.showStopButton, true);
  assert.equal(page.data.showResetButton, true);
});

test('recommended durations can be added, edited, removed and restored without changing a running session', () => {
  const { page, storage, advance } = createPage();
  page.startTimer();
  advance(10000);
  page.addRecommendedDuration();
  page.onCustomTimeInput({ detail: { value: '12' } });
  page.confirmCustomTime();
  assert.ok(page.data.timeOptions.some(item => item.value === 12));
  assert.equal(page.data.isRunning, true);
  page.editRecommendedDuration({ currentTarget: { dataset: { value: 12 } } });
  page.onCustomTimeInput({ detail: { value: '25' } });
  page.confirmCustomTime();
  assert.equal(page.data.timeOptions.some(item => item.value === 12), false);
  assert.ok(page.data.timeOptions.some(item => item.value === 25));
  page.removeRecommendedDuration({ currentTarget: { dataset: { value: 7 } } });
  const saved = storage.get('timerRecommendedDurations');
  const restored = createPage({ initialStorage: { timerRecommendedDurations: saved } }).page;
  assert.deepEqual(Array.from(restored.data.timeOptions, item => item.value), Array.from(saved));
  assert.equal(saved.includes(7), false);
});

test('custom time accepts only whole minutes within 1 to 180 and can be selected without becoming a recommendation', () => {
  const { page, storage } = createPage();
  for (const value of ['', '0', '-1', '181', '12x', '1.5']) {
    page.onCustomTimeInput({ detail: { value } });
    assert.equal(page.data.isValidCustomTime, false, value);
  }
  page.chooseCustomDuration();
  page.onCustomTimeInput({ detail: { value: '42' } });
  page.confirmCustomTime();
  assert.equal(page.data.duration, 42);
  assert.equal(page.data.remainingTime, 2520);
  assert.equal(page.data.displayTime, '42:00');
  assert.equal(storage.has('timerRecommendedDurations'), false);
});


test('reopening a countdown never fills the remaining duration with time spent outside the app', async () => {
  const startTimestamp = Date.parse('2026-09-18T01:59:00+08:00');
  const { page, records } = createPage({ initialStorage: {
    timerState: {
      sessionId: 'timer_countdown', isCountdown: true, isRunning: true, isPaused: false,
      elapsedTime: 30, totalTime: 60, saveTime: startTimestamp + 30000, startTimestamp,
      totalPausedTime: 0, pauseTimestamp: 0
    }
  } });
  assert.equal(page.data.isRunning, false);
  assert.equal(page.data.showStopButton, false);
  assert.equal(page.data.showResetButton, false);
  assert.equal(page.data.showCompletionDialog, false);
  assert.equal(page.data.elapsedTime, 30);
  assert.equal(page.data.remainingTime, 30);
  await page.confirmCompletion();
  assert.equal(records.length, 0, 'only 30 seconds were completed before exiting');
});

test('count-up background completion notice survives restarting the page', () => {
  const { page, storage, emitApp, advance } = createPage({ isCountdown: false });
  page.startTimer();
  advance(60000);
  emitApp('hide');
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
  assert.equal(reopened.toasts.at(-1).title, '正计时已结束，1分钟已存本机');
  assert.equal(reopened.toasts.at(-1).icon, 'none');
  assert.equal(reopened.records.length, 0);
  assert.equal(reopened.storage.get('timerCompletionNotice'), '');
});

test('a locally saved timer completion is not resubmitted by foreground or page recovery', async () => {
  const { page, storage, records, advance, emitApp, toasts } = createPage();
  page.startTimer();
  advance(60000);
  page.handleStop();
  await page.confirmCompletion();
  assert.equal(records.length, 1);
  assert.equal(page.pendingCompletion, null);
  assert.equal(storage.get('timerPendingCompletion'), null);
  assert.deepEqual(toasts, []);
  emitApp('hide');
  emitApp('show');
  page.onShow();
  await page.confirmCompletion();
  assert.equal(records.length, 1);
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) });
  assert.equal(reopened.page.data.showCompletionDialog, false);
  await reopened.page.confirmCompletion();
  assert.equal(reopened.records.length, 0, 'the shared upload queue owns unfinished cloud uploads');
});


test('count-up ends at the 24-hour limit in foreground updates and timestamp resynchronization', async () => {
  for (const method of ['updateForegroundTimer', 'syncTimerTime']) {
    const { page, records, jump } = createPage({ isCountdown: false });
    page.startTimer();
    const startedAt = page.data.startTimestamp;
    jump(86400000 - 1000);
    page[method]();
    assert.equal(page.data.isRunning, true, method);
    jump(1000);
    page[method]();
    assert.equal(page.data.isRunning, false, method);
    assert.equal(page.data.elapsedTime, 86400);
    assert.equal(page.data.completionDuration, 1440);
    assert.equal(page.data.showResetButton, false);
    await page.confirmCompletion();
    assert.equal(records.length, 1);
    assert.equal(records[0][0], 1440);
    assert.equal(records[0][3], startedAt + 86400000);
  }
});

test('delayed updates or background exits cannot create a record over 1440 minutes', async () => {
  for (const action of ['updateForegroundTimer', 'syncTimerTime', 'appHide']) {
    const { page, records, jump, emitApp } = createPage({ isCountdown: false });
    page.startTimer();
    const startedAt = page.data.startTimestamp;
    jump(90000000);
    if (action === 'appHide') emitApp('hide');
    else page[action]();
    await page.confirmCompletion();
    assert.equal(page.data.isRunning, false, action);
    assert.equal(records.length, 1);
    assert.equal(records[0][0], 1440);
    assert.equal(records[0][3], startedAt + 86400000);
  }
});
