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
const timerInterruption = require('../miniprogram/utils/timerInterruption');

function dailyPathForRecord(record) {
  assert.ok(record, 'the daily card must use a saved sitting');
  return `/pages/daily/daily1?completedAt=${encodeURIComponent(record[3])}&minutes=${encodeURIComponent(record[0])}`;
}

function createPage({
  withGuide = false, isCountdown = true, initialStorage = {}, checkText = async () => true,
  recordCheckin, backgroundUpload = async () => ({ success: true }), networkType,
  contentSecRequest = () => new Promise(() => {}), navigateTo,
  initialTime = Date.parse('2026-09-18T08:00:00+08:00'), withAppLifecycle = false,
  audioBehavior = () => 'play', modernAudio = false, vibrationBehavior = options => options.success?.({}),
  storageFailure = () => false, storageReadFailure = () => false, showToast, hasRecordedTimerCompletion
} = {}) {
  let definition;
  let now = initialTime;
  let nextTimerId = 0;
  const timers = new Map();
  const players = [];
  const audioCalls = [];
  const vibrations = [];
  const navigations = [];
  const modals = [];
  const toasts = [];
  const listeners = { show: new Set(), hide: new Set(), audioBegin: new Set(), audioEnd: new Set() };
  const storage = new Map(Object.entries(initialStorage));
  const records = [];
  const uploads = [];
  const imagePrefetches = [];

  function createAudioPlayer() {
    let src = '';
    let firstPlay = true;
    const callbacks = { play: new Set(), ended: new Set(), error: new Set(), stop: new Set(), pause: new Set(), canplay: new Set(), timeupdate: new Set() };
    const player = {
      paused: true,
      currentTime: 0,
      startTime: 0,
      destroyed: false,
      get src() { return src; },
      set src(value) {
        src = value;
        firstPlay = true;
        this.currentTime = 0;
        audioCalls.push({ action: 'src', player: this, src });
        for (const callback of [...callbacks.canplay]) callback();
      },
      play() {
        assert.equal(this.destroyed, false, 'a destroyed player must never be restarted');
        assert.equal(application._timerAudioInterrupted, false, 'native audio is unavailable during a system interruption');
        assert.equal(application._timerForeground, true, 'timer audio cannot start while the app is hidden');
        if (firstPlay) {
          this.currentTime = this.startTime;
          firstPlay = false;
        }
        audioCalls.push({ action: 'play', player: this, src });
        const behavior = audioBehavior(this, src);
        if (behavior === 'throw') throw new Error('native play failed');
        if (behavior === 'error') { this.emitError(); return; }
        if (behavior === 'silent') return;
        this.paused = false;
        for (const callback of [...callbacks.play]) callback();
      },
      pause() {
        this.paused = true;
        audioCalls.push({ action: 'pause', player: this, src });
      },
      seek(seconds) {
        this.currentTime = seconds;
        audioCalls.push({ action: 'seek', player: this, seconds, src });
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
      onStop(callback) { callbacks.stop.add(callback); },
      onPause(callback) { callbacks.pause.add(callback); },
      offStop(callback) { callbacks.stop.delete(callback); },
      offPause(callback) { callbacks.pause.delete(callback); },
      emitNativeSilence(event) {
        this.paused = true;
        for (const callback of [...callbacks[event]]) callback();
      },
      offPlay(callback) { callbacks.play.delete(callback); },
      offEnded(callback) { callbacks.ended.delete(callback); },
      offError(callback) { callbacks.error.delete(callback); },
      onWaiting() {},
      onCanplay(callback) { callbacks.canplay.add(callback); },
      offCanplay(callback) { callbacks.canplay.delete(callback); },
      emitEnded() {
        if (modernAudio) this.emitProgress(this.duration);
        this.emitNativeEnded();
      },
      emitNativeEnded(seconds) {
        if (seconds !== undefined) this.currentTime = seconds;
        this.paused = true;
        // Dispatch current listeners; cuePlayer tests also exercise captured, queued callbacks.
        for (const callback of [...callbacks.ended]) callback();
      },
      emitError() {
        for (const callback of callbacks.error) callback({ errCode: 10001, errMsg: 'queued audio error' });
      }
    };
    if (modernAudio) {
      Object.defineProperty(player, 'duration', { get: () => src === END_AUDIO ? 19.083356 : src === START_AUDIO ? 10.157256 : 60 });
      player.onTimeUpdate = callback => callbacks.timeupdate.add(callback);
      player.offTimeUpdate = callback => callbacks.timeupdate.delete(callback);
      player.emitProgress = seconds => {
        player.currentTime = seconds;
        for (const callback of [...callbacks.timeupdate]) callback();
      };
    }
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
    vibrateLong(options) {
      vibrations.push(now);
      vibrationBehavior(options);
    },
    getStorageSync(key) {
      if (storageReadFailure(key)) throw new Error('native storage read failed');
      return storage.get(key);
    },
    setStorageSync(key, value) {
      if (storageFailure(key, value)) throw new Error('native storage write failed');
      storage.set(key, value);
    },
    onAppShow: callback => listeners.show.add(callback),
    onAppHide: callback => listeners.hide.add(callback),
    offAppShow: callback => listeners.show.delete(callback),
    offAppHide: callback => listeners.hide.delete(callback),
    onAudioInterruptionBegin: callback => listeners.audioBegin.add(callback),
    onAudioInterruptionEnd: callback => listeners.audioEnd.add(callback),
    offAudioInterruptionBegin: callback => listeners.audioBegin.delete(callback),
    offAudioInterruptionEnd: callback => listeners.audioEnd.delete(callback),
    setKeepScreenOn: options => options.success?.({}),
    showModal: options => modals.push(options),
    showToast(options) {
      toasts.push(options);
      if (showToast) return showToast(options);
    },
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

  const checkin = {
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
  const audioModules = new Map();
  function loadAudioModule(filename) {
    if (audioModules.has(filename)) return audioModules.get(filename).exports;
    const module = { exports: {} };
    audioModules.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, wx, Date: ClockDate,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: (callback, delay) => addTimer(callback, delay),
      clearTimeout: id => timers.delete(id),
      require: request => loadAudioModule(require.resolve(path.resolve(path.dirname(filename), request)))
    }, { filename });
    return module.exports;
  }


  const controllerModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/countdownSession.js'), 'utf8'), {
    module: controllerModule, Date: ClockDate, console,
    require(request) {
      if (request === './timerEndReminder') return require('../miniprogram/utils/timerEndReminder');
      assert.equal(request, './timerInterruption');
      return timerInterruption;
    },
    setInterval: (callback, delay) => addTimer(callback, delay, true),
    clearInterval: id => timers.delete(id)
  });
  const countdown = controllerModule.exports.createCountdownSessionController({ api: wx,
    recordCheckin: (...args) => checkin.recordCheckin(...args) });
  let application = {
    getCountdownSession: () => countdown,
    _timerForeground: true,
    _timerAudioInterrupted: false,
    getTimerExitAudio() {
      if (!this._timerExitAudio) {
        const { createTimerExitAudio } = loadAudioModule(require.resolve('../miniprogram/utils/timerExitAudio'));
        this._timerExitAudio = createTimerExitAudio({
          api: wx,
          canPlay: () => this._timerForeground !== false && !this._timerAudioInterrupted
        });
      }
      return this._timerExitAudio;
    }
  };
  if (withAppLifecycle) {
    const appPath = path.join(__dirname, '../miniprogram/app.js');
    vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
      App(value) { application = value; }, wx, Date: ClockDate,
      console: { log() {}, warn() {}, error() {} },
      require(request) {
        if (request === './utils/timerExitAudio') return loadAudioModule(require.resolve('../miniprogram/utils/timerExitAudio'));
        if (request === './utils/timerEndReminder') return require('../miniprogram/utils/timerEndReminder');
        if (request === './utils/checkin.js') return checkin;
        if (request === './utils/countdownSession') {
          return { createCountdownSessionController: () => countdown };
        }
        assert.equal(request, './utils/timerInterruption');
        return timerInterruption;
      }
    }, { filename: appPath });
    for (const method of ['setupRecordRefresh', 'setupCacheStatus', 'setAudioOptions',
      'resumePracticeRecords', 'startSyncAlertRefresh', 'refreshRecordBackups', 'resumeRecordBackups', 'clearSyncAlert']) {
      application[method] = () => {};
    }
    application.onLaunch();
  }
  if (hasRecordedTimerCompletion) application.hasRecordedTimerCompletion = hasRecordedTimerCompletion;


  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    wx,
    getApp: () => application,
    Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => addTimer(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => addTimer(callback, delay, true),
    clearInterval: id => timers.delete(id),
    require(request) {
      if (request === '../../utils/timerEndReminder') return require('../miniprogram/utils/timerEndReminder');
      if (request === '../../utils/timerInterruption') return timerInterruption;
      if (request === '../../utils/timerAudio') return loadAudioModule(require.resolve(path.resolve(path.dirname(pagePath), request)));
      if (request === '../../utils/checkin') return checkin;
      if (request === '../../utils/contentSec') return contentSec;
      if (request === '../../utils/dailyCardImage') return {
        prepareNextImage() { imagePrefetches.push(true); }
      };
      assert.equal(request, '../../utils/screenBrightness');
      return { createScreenBrightnessController: () => ({ dim() {}, restore() {} }) };
    },
    Page: page => { definition = page; }
  }, { filename: pagePath });

  let page = {
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
    get page() { return page; }, players, audioCalls, vibrations, navigations, modals, toasts, records, uploads, storage, advance, imagePrefetches,
    jump: milliseconds => { now += milliseconds; },
    plays: () => audioCalls.filter(call => call.action === 'play').map(call => call.src),
    countdown, timers, listeners, application, now: () => now,
    recreatePage({ visible = true } = {}) {
      page = { ...definition, data: structuredClone(definition.data),
        setData(values) { Object.assign(this.data, values); } };
      page.onLoad({});
      if (visible) page.onShow();
      return page;
    },
    emitApp: (event, options = { reason: 0 }) => {
      if (withAppLifecycle) {
        if (event === 'hide') application.onHide(options); else application.onShow();
      } else {
        application._timerForeground = event === 'show';
        if (event === 'hide') countdown.appHide(options); else countdown.appShow();
        if (application._timerExitAudio) {
          if (event === 'hide') application._timerExitAudio.pause();
          else application._timerExitAudio.resume();
        }
      }
      for (const callback of [...listeners[event]]) callback(options);
    },
    emitAudio: type => {
      application._timerAudioInterrupted = type === 'begin';
      if (type === 'begin') players.forEach(player => { player.paused = true; });
      for (const callback of [...listeners[type === 'begin' ? 'audioBegin' : 'audioEnd']]) callback();
      if (!withAppLifecycle && application._timerExitAudio) {
        if (type === 'begin') application._timerExitAudio.pause();
        else application._timerExitAudio.resume();
      }
    }
  };
}

test('start and end reminders independently support vibration in either timer mode', async () => {
  for (const isCountdown of [true, false]) {
    for (const start of ['bell', 'vibrate']) {
      for (const end of ['bell', 'vibrate']) {
        const h = createPage({ isCountdown,
          initialStorage: { timerReminderSettings: { start, end } } });
        h.page.applyDuration(1);
        h.page.startTimer();
        h.advance(4999);
        assert.deepEqual(h.plays(), []);
        assert.equal(h.vibrations.length, 0);
        h.advance(1);
        assert.deepEqual(h.plays(), start === 'bell' ? [START_AUDIO] : []);
        assert.equal(h.vibrations.length, start === 'vibrate' ? 1 : 0);
        h.advance(55000);
        if (!isCountdown) h.page.handleStop();
        assert.deepEqual(h.plays(), [
          ...(start === 'bell' ? [START_AUDIO] : []),
          ...(end === 'bell' ? [END_AUDIO] : [])
        ]);
        assert.equal(h.vibrations.length, 8 * Number(start === 'vibrate') + Number(end === 'vibrate'));
        assert.equal(h.page.data.isRunning, false);
        assert.equal(h.page.pendingCompletion.duration, 1);
        if (end === 'vibrate') {
          h.advance(2999);
          assert.equal(h.storage.get('timerPendingEndReminder').sessionId, h.page.pendingCompletion.sessionId);
          h.advance(1);
          assert.equal(h.storage.get('timerPendingEndReminder'), null);
          assert.equal(h.vibrations.length, 8 * (Number(start === 'vibrate') + 1));
        }
        await h.page.confirmCompletion();
        assert.equal(h.records.length, 1);
      }
    }
  }
});

test('opening vibration preserves preparation through pause and starts guidance without replaying a bell', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true,
      initialStorage: { timerReminderSettings: { start: 'vibrate' } } });
    h.page.startTimer(); h.advance(2000); h.page.pauseTimer();
    h.advance(10000);
    assert.equal(h.vibrations.length, 0);
    assert.deepEqual(h.plays(), []);
    h.page.startTimer(); h.advance(2999);
    assert.equal(h.vibrations.length, 0);
    h.advance(1);
    assert.equal(h.vibrations.length, 1);
    assert.equal(h.page.currentSessionSound, 'start');
    h.advance(2999);
    assert.deepEqual(h.plays(), []);
    h.advance(1);
    assert.equal(h.page.currentSessionSound, null);
    assert.deepEqual(h.plays(), [GUIDE_AUDIO]);
    h.page.pauseTimer(); h.page.startTimer(); h.advance(5000);
    assert.equal(h.vibrations.length, 8);
    assert.equal(h.plays().includes(START_AUDIO), false);
  }
});

test('reminder changes take effect with the existing timer page and persist across page recreation', async () => {
  const h = createPage();
  h.page.startTimer(); h.advance(5000);
  assert.deepEqual(h.plays(), [START_AUDIO]);
  h.page.audioPlayer.emitEnded();
  h.storage.set('timerReminderSettings', { start: 'vibrate', end: 'vibrate' });
  h.advance(60000); h.page.handleStop();
  assert.equal(h.vibrations.length, 1);
  assert.equal(h.plays().includes(END_AUDIO), false);
  await h.page.confirmCompletion();
  h.page.onUnload();
  const fresh = h.recreatePage();
  fresh.startTimer(); h.advance(5000);
  assert.equal(h.vibrations.length, 2);
  assert.deepEqual(h.plays(), [START_AUDIO]);
  h.storage.set('timerReminderSettings', { start: 'bell', end: 'bell' });
  fresh.handleStop();
  assert.equal(h.plays().at(-1), END_AUDIO);
});

test('vibration failure keeps guidance, completion and saving working without a fallback bell', async () => {
  for (const failure of ['callback', 'throw']) {
    const h = createPage({ withGuide: true,
      initialStorage: { timerReminderSettings: { start: 'vibrate', end: 'vibrate' } },
      vibrationBehavior(options) {
        if (failure === 'callback') options.fail({ errMsg: 'vibrateLong:fail unavailable' });
        else throw new Error('vibrateLong unavailable');
      } });
    h.page.applyDuration(1); h.page.startTimer(); h.advance(5000);
    assert.equal(h.page.data.isRunning, true);
    assert.deepEqual(h.plays(), [GUIDE_AUDIO]);
    h.advance(55000);
    assert.equal(h.vibrations.length, 2);
    assert.equal(h.page.pendingCompletion.duration, 1);
    assert.deepEqual(h.plays(), [GUIDE_AUDIO]);
    await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
  }
});

test('a deferred closing vibration fires once after interruption and foreground return', () => {
  const h = createPage({ initialStorage: {
    timerReminderSettings: { start: 'vibrate', end: 'vibrate' }
  } });
  h.page.applyDuration(1); h.page.startTimer(); h.advance(59000);
  assert.equal(h.vibrations.length, 8);
  h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
  h.advance(1000);
  assert.equal(h.vibrations.length, 8);
  h.emitApp('show'); h.page.onShow();
  assert.equal(h.page.pendingCompletion.duration, 1);
  assert.equal(h.vibrations.length, 8);
  h.emitAudio('end');
  assert.equal(h.vibrations.length, 9);
  h.emitAudio('end'); h.page.onShow(); h.advance(10000);
  assert.equal(h.vibrations.length, 16);
  assert.deepEqual(h.plays(), []);
});

test('reset, duration changes, app exit and unload cancel a pending opening vibration', () => {
  for (const action of ['reset', 'duration', 'exit', 'unload']) {
    const h = createPage({ initialStorage: {
      timerReminderSettings: { start: 'vibrate', end: 'vibrate' }
    } });
    h.page.startTimer(); h.advance(2000);
    if (action === 'reset') h.page.resetTimer();
    if (action === 'duration') h.page.applyDuration(10);
    if (action === 'exit') h.emitApp('hide');
    if (action === 'unload') h.page.onUnload();
    h.advance(10000);
    assert.equal(h.vibrations.length, 0, 'exiting must cancel both pending opening and closing reminders');
    assert.deepEqual(h.plays(), [], action);
  }
});

test('pausing an active opening vibration freezes its remaining time before guidance', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true,
      initialStorage: { timerReminderSettings: { start: 'vibrate' } } });
    h.page.startTimer(); h.advance(6000);
    h.page.pauseTimer();
    const count = h.vibrations.length;
    h.advance(10000);
    assert.equal(h.vibrations.length, count);
    assert.deepEqual(h.plays(), []);
    h.page.startTimer(); h.advance(1999);
    assert.equal(h.page.currentSessionSound, 'start');
    assert.deepEqual(h.plays(), []);
    h.advance(1);
    assert.equal(h.page.currentSessionSound, null);
    assert.deepEqual(h.plays(), [GUIDE_AUDIO]);
  }
});

test('reset, duration changes and unload stop the rest of an active vibration', () => {
  for (const action of ['reset', 'duration', 'unload']) {
    const h = createPage({ initialStorage: { timerReminderSettings: { start: 'vibrate' } } });
    h.page.startTimer(); h.advance(6000);
    const count = h.vibrations.length;
    if (action === 'reset') h.page.resetTimer();
    if (action === 'duration') h.page.applyDuration(10);
    if (action === 'unload') h.page.onUnload();
    h.advance(10000);
    assert.equal(h.vibrations.length, count, action);
  }
});

test('a closing vibration pauses during an interruption and acknowledges only after its remaining time', () => {
  const h = createPage({ initialStorage: { timerReminderSettings: { end: 'vibrate' } } });
  h.page.applyDuration(1); h.page.startTimer(); h.advance(61000);
  const sessionId = h.page.pendingCompletion.sessionId;
  h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
  const count = h.vibrations.length;
  h.advance(10000);
  assert.equal(h.vibrations.length, count);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
  h.emitApp('show'); h.page.onShow(); h.emitAudio('end');
  h.page.onShow(); h.emitAudio('end'); h.advance(1999);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
  h.advance(1);
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
  const completedCount = h.vibrations.length;
  h.page.onShow(); h.advance(10000);
  assert.equal(h.vibrations.length, completedCount);
  assert.equal(h.plays().includes(END_AUDIO), false);
});

test('page recreation resumes the remaining opening vibration without turning it into a bell', () => {
  const h = createPage({ withGuide: true,
    initialStorage: { timerReminderSettings: { start: 'vibrate' } } });
  h.page.startTimer(); h.advance(6000);
  h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
  assert.equal(h.application._timerSessionAudio.vibrationRemainingMs, 2000);
  h.advance(10000);
  const restored = h.recreatePage({ visible: false });
  h.emitApp('show'); restored.onShow(); h.emitAudio('end');
  h.advance(1999);
  assert.equal(restored.currentSessionSound, 'start');
  assert.deepEqual(h.plays(), []);
  h.advance(1);
  assert.equal(restored.currentSessionSound, null);
  assert.deepEqual(h.plays(), [GUIDE_AUDIO]);
});

test('detached count-ups retain their checkpoint through passive hide reasons and resume the same session', () => {
  for (const reason of [2, 3, undefined]) {
    for (const paused of [false, true]) {
      const h = createPage({ isCountdown: false, withGuide: true, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000);
      if (paused) h.page.pauseTimer();
      const sessionId = h.page.sessionId;
      h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
      const checkpoint = structuredClone(h.storage.get('timerState'));
      h.advance(30000); h.emitApp('show'); h.emitAudio('end'); h.advance(60000);
      h.emitApp('hide', { reason }); h.emitApp('hide', { reason });
      assert.equal(h.records.length, 0);
      assert.deepEqual(structuredClone(h.storage.get('timerState')), checkpoint);
      assert.ok(!h.storage.get('timerPendingCompletion'));
      h.emitApp('show');
      const fresh = h.recreatePage();
      assert.equal(fresh.sessionId, sessionId);
      assert.equal(fresh.data.isRunning, !paused);
      assert.equal(fresh.data.isPaused, paused);
      assert.equal(fresh.data.elapsedTime, paused ? 65 : 155);
      fresh.handleStop();
      assert.equal(fresh.pendingCompletion.duration, paused ? 1 : 2);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
      assert.equal(h.records.length, 0);
    }
  }
});

test('a late explicit App exit settles a count-up before its interrupted page unload transfers ownership', () => {
  for (const reason of [0, 1]) {
    const h = createPage({ isCountdown: false, withAppLifecycle: true });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    h.emitApp('hide', { reason: 3 }); h.page.onHide();
    h.advance(45000);
    const exitedAt = h.now();
    const queuedHide = h.page.appHideHandler;
    h.application.onHide({ reason }); h.page.onUnload(); queuedHide({ reason });
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 1);
    assert.equal(h.records[0][3], exitedAt);
    assert.equal(h.records[0][4], sessionId);
    assert.equal(h.storage.get('timerState'), null);
    assert.ok(!h.storage.get('timerPendingCompletion'));
    assert.ok(!h.storage.get('timerPendingEndReminder'));
    h.emitApp('show'); h.recreatePage();
    assert.equal(h.records.length, 1, 'ownership transfer and a queued old callback cannot save twice');
    assert.equal(h.page.data.isRunning, false);
  }
});

test('an explicit exit settles detached count-ups once and caps their duration at 24 hours', () => {
  for (const elapsedMs of [2000, 25 * 3600000]) {
    const h = createPage({ isCountdown: false, withAppLifecycle: true });
    h.page.startTimer(); h.advance(1000);
    const startedAt = h.page.data.startTimestamp;
    const sessionId = h.page.sessionId;
    h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
    h.jump(elapsedMs - 1000); h.emitApp('hide', { reason: 1 });
    assert.equal(h.records.length, elapsedMs >= 60000 ? 1 : 0);
    if (elapsedMs >= 60000) {
      assert.equal(h.records[0][0], 1440);
      assert.equal(h.records[0][3], startedAt + 86400000);
      assert.equal(h.records[0][4], sessionId);
    }
    assert.ok(!h.storage.get('timerPendingCompletion'));
    assert.ok(!h.storage.get('timerPendingEndReminder'));
    h.emitApp('hide', { reason: 1 }); h.emitApp('show');
    const fresh = h.recreatePage();
    assert.equal(fresh.data.isRunning, false);
    assert.equal(fresh.data.isPaused, false);
    assert.equal(h.plays().includes(END_AUDIO), false);
    assert.equal(h.records.length, elapsedMs >= 60000 ? 1 : 0);
  }
});

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

test('first natural completion, then manual completion, then natural completion each ring and save once', async () => {
  for (const withGuide of [false, true]) {
    const h = createPage({ withGuide, withAppLifecycle: true });
    const retiredCues = [];
    const sessionIds = new Set();
    const sessions = [
      { duration: 1, finishAfter: 60000, manual: false },
      { duration: 2, finishAfter: 65000, manual: true },
      { duration: 1, finishAfter: 60000, manual: false }
    ];
    for (const [index, session] of sessions.entries()) {
      h.page.applyDuration(session.duration);
      const before = h.plays().length;
      h.page.startTimer();
      const sessionId = h.page.sessionId;
      const startedAt = h.page.data.startTimestamp;
      sessionIds.add(sessionId);
      const preparedClosing = h.players.filter(player => player.src === END_AUDIO && !player.destroyed).at(-1);
      assert.ok(preparedClosing, 'the closing asset is prepared when the user starts the sitting');
      assert.equal(preparedClosing.paused, true);
      assert.equal(h.plays().length, before, 'preparation cannot play either bell early');
      h.advance(4999);
      assert.equal(h.plays().length, before);
      h.advance(1);
      const opening = h.page.audioPlayer;
      assert.equal(opening.src, START_AUDIO);
      assert.notEqual(opening, preparedClosing);
      opening.emitEnded();
      retiredCues.push(opening);
      const guide = h.page.backgroundMusicPlayer;

      h.advance(session.finishAfter - 5001);
      assert.equal(h.page.data.isRunning, true);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, index);
      h.advance(1);
      if (session.manual) h.page.handleStop();
      const closing = h.page.audioPlayer;
      assert.equal(closing, preparedClosing, 'first playback uses the already prepared closing asset');
      assert.equal(closing.src, END_AUDIO);
      assert.equal(closing.paused, false);
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.pendingCompletion.sessionId, sessionId);
      assert.equal(h.page.pendingCompletion.duration, 1);
      assert.equal(h.page.pendingCompletion.endedAt, startedAt + session.finishAfter);
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
      assert.equal(h.records.length, index, 'ringing leaves saving to the completion action');
      if (guide) assert.equal(guide.paused, true);

      // Native events can be delivered to whatever listeners exist when the
      // event arrives, rather than retaining the old JavaScript callback.
      for (const retired of retiredCues) {
        retired.emitEnded();
        retired.emitNativeSilence('stop');
        retired.emitNativeSilence('pause');
      }
      h.countdown.tick();
      h.page.handleStop();
      h.page.onShow();
      assert.equal(h.page.audioPlayer, closing);
      assert.equal(closing.paused, false);
      assert.equal(h.page.currentSessionSound, 'end');
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId,
        'old native events cannot acknowledge the new closing reminder');
      assert.deepEqual(h.plays().slice(before), withGuide
        ? [START_AUDIO, GUIDE_AUDIO, END_AUDIO] : [START_AUDIO, END_AUDIO]);

      closing.emitEnded();
      assert.equal(h.storage.get('timerPendingEndReminder'), null);
      await h.page.confirmCompletion();
      await h.page.confirmCompletion();
      h.page.onShow();
      assert.equal(h.records.length, index + 1);
      assert.equal(h.records[index][0], 1);
      assert.equal(h.records[index][3], startedAt + session.finishAfter);
      assert.equal(h.records[index][4], sessionId);
      assert.equal(h.storage.get('timerPendingCompletion'), null);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, index + 1);
      retiredCues.push(closing);
    }
    assert.equal(sessionIds.size, 3, 'every sitting owns its own reminder and record identity');
  }
});

test('unanswered calls preserve either timer with or without guidance across lifecycle event orders', () => {
  for (const isCountdown of [true, false]) {
    for (const withGuide of [false, true]) {
      for (const beginBeforeHide of [false, true]) {
        for (const endBeforeShow of [false, true]) {
          const h = createPage({ isCountdown, withGuide });
          const { page } = h;
          const scenario = JSON.stringify({ isCountdown, withGuide, beginBeforeHide, endBeforeShow });
          page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
          const sessionId = page.sessionId;
          const playsBeforeCall = h.plays().length;
          if (withGuide) page.backgroundMusicPlayer.currentTime = 19;
          if (beginBeforeHide) h.emitAudio('begin');
          h.emitApp('hide', { reason: 3 }); page.onHide();
          if (!beginBeforeHide) h.emitAudio('begin');
          assert.equal(page.data.isRunning, true, scenario);
          assert.equal(h.records.length, 0, scenario);
          assert.ok(h.players.every(player => player.paused), scenario);
          h.advance(45000);
          assert.equal(h.plays().length, playsBeforeCall, scenario);
          if (endBeforeShow) h.emitAudio('end');
          h.emitApp('show');
          assert.equal(h.plays().length, playsBeforeCall, 'AppShow alone cannot restart a hidden page');
          page.onShow();
          if (!endBeforeShow) {
            assert.equal(h.plays().length, playsBeforeCall, 'PageShow must wait for audio interruption to end');
            h.emitAudio('end');
          }
          assert.equal(page.sessionId, sessionId, scenario);
          assert.equal(page.data.elapsedTime, 110, scenario);
          assert.equal(page.data.isRunning, true, scenario);
          assert.equal(h.records.length, 0, scenario);
          assert.equal(page.pendingCompletion, null, scenario);
          assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1, 'the opening cue is not repeated');
          if (withGuide) {
            assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 2, scenario);
            assert.equal(page.backgroundMusicPlayer.currentTime, 19, 'guidance resumes without seeking to the start');
            assert.equal(page.backgroundMusicPlayer.paused, false, scenario);
          } else assert.equal(h.plays().length, playsBeforeCall, scenario);
          h.advance(1000);
          assert.equal(page.data.elapsedTime, 111, 'the foreground ticker is installed again');
        }
      }
    }
  }
});

test('native screens and old clients without a hide reason retain either timer without audio events', () => {
  for (const isCountdown of [true, false]) {
    for (const options of [{ reason: 2 }, { reason: 3 }, {}, null]) {
      const h = createPage({ isCountdown });
      h.page.startTimer(); h.advance(65000);
      const sessionId = h.page.sessionId;
      h.emitApp('hide', options); h.advance(30000);
      h.emitApp('show'); h.page.onShow(); h.advance(1000);
      assert.equal(h.page.sessionId, sessionId);
      assert.equal(h.page.data.isRunning, true);
      assert.equal(h.page.data.elapsedTime, 96);
      assert.equal(h.records.length, 0);
    }
  }
});

test('calls never resume a manually paused sitting or count its paused time', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
    h.page.pauseTimer();
    const beforeCall = h.plays().length;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.advance(45000);
    h.emitApp('show'); h.page.onShow(); h.emitAudio('end'); h.advance(1000);
    assert.equal(h.page.data.isPaused, true);
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.page.data.elapsedTime, 65);
    assert.equal(h.plays().length, beforeCall);
    assert.equal(h.records.length, 0);
    h.page.startTimer(); h.advance(1000);
    assert.equal(h.page.data.elapsedTime, 66);
  }
});

test('a countdown due during a call announces and records its original deadline once after both returns', async () => {
  for (const endBeforeShow of [false, true]) {
    const h = createPage({ withGuide: true });
    h.page.applyDuration(2); h.page.startTimer(); h.advance(5000); h.players[0].emitEnded();
    const deadline = h.page.data.startTimestamp + 120000;
    h.advance(60000); h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
    h.advance(90000);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 0);
    assert.equal(h.records.length, 0);
    if (endBeforeShow) h.emitAudio('end');
    h.emitApp('show');
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 0, 'completion waits for the visible page');
    h.page.onShow();
    if (!endBeforeShow) {
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 0, 'completion waits for audio availability');
      h.emitAudio('end');
    }
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.page.pendingCompletion.duration, 2);
    assert.equal(h.page.pendingCompletion.endedAt, deadline);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    h.emitAudio('end'); h.emitApp('show'); h.page.onShow();
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    await h.page.confirmCompletion(); await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 2);
    assert.equal(h.records[0][3], deadline);
  }
});

test('audio-only interruptions preserve pending cues and playback positions without ending either timer', () => {
  for (const isCountdown of [true, false]) {
    for (const stage of ['waiting', 'start', 'guide']) {
      const h = createPage({ isCountdown, withGuide: true });
      h.page.startTimer(); h.advance(stage === 'waiting' ? 2000 : 5000);
      if (stage === 'guide') h.players[0].emitEnded();
      const activePlayer = stage === 'guide' ? h.page.backgroundMusicPlayer : h.page.audioPlayer;
      if (stage !== 'waiting') activePlayer.currentTime = 7;
      const beforeCall = h.plays().length;
      h.emitAudio('begin'); h.advance(10000);
      assert.equal(h.page.data.isRunning, true);
      assert.equal(h.records.length, 0);
      assert.equal(h.plays().length, beforeCall);
      h.emitAudio('end'); h.advance(0);
      assert.equal(h.plays().length, beforeCall + 1, stage);
      if (stage !== 'waiting') assert.equal(activePlayer.currentTime, 7, stage);
      assert.equal(h.page.data.elapsedTime, stage === 'waiting' ? 12 : 15);
    }
  }
});

test('leaving during preparation keeps audio silent until the running timer page returns', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(2000); h.page.onHide();
    h.advance(2999);
    assert.deepEqual(h.plays(), []);
    h.advance(1);
    assert.deepEqual(h.plays(), [], 'hidden timer pages cannot play their opening cue');
    h.advance(1000); h.page.onShow();
    h.advance(0);
    assert.equal(h.page.data.elapsedTime, 6);
    assert.equal(h.page.data.isRunning, true);
    assert.deepEqual(h.plays(), [START_AUDIO], 'returning restores the opening cue after its preparation time');
    h.page.audioPlayer.emitEnded();
    assert.deepEqual(h.plays(), [START_AUDIO, GUIDE_AUDIO]);
  }
});

test('guidance resumes when PageShow arrives before AppShow after a call', () => {
  for (const isCountdown of [true, false]) {
    for (const endBeforeShow of [false, true]) {
      const h = createPage({ isCountdown, withGuide: true });
      h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
      const guide = h.page.backgroundMusicPlayer;
      guide.currentTime = 18;
      h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.emitAudio('begin'); h.advance(45000);
      const countBeforeShow = h.plays().length;
      if (endBeforeShow) h.emitAudio('end');
      h.page.onShow();
      assert.equal(h.plays().length, countBeforeShow, 'PageShow alone cannot play while the app is hidden');
      h.emitApp('show');
      if (!endBeforeShow) {
        assert.equal(h.plays().length, countBeforeShow, 'AppShow still waits for audio availability');
        h.emitAudio('end');
      }
      assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 2);
      assert.equal(guide.currentTime, 18);
      assert.equal(guide.paused, false);
      h.advance(1000);
      assert.equal(h.page.data.elapsedTime, 111);
      assert.equal(h.records.length, 0);
    }
  }
});

test('timer pages rebuilt during a call keep the session and its original hide checkpoint', () => {
  for (const isCountdown of [true, false]) {
    for (const paused of [false, true]) {
      const h = createPage({ isCountdown });
      h.page.startTimer(); h.advance(65000);
      if (paused) h.page.pauseTimer();
      const sessionId = h.page.sessionId;
      h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
      const boundary = structuredClone(h.storage.get('timerState'));
      h.advance(45000); h.page.onUnload();
      assert.equal(h.records.length, 0);
      assert.deepEqual(structuredClone(h.storage.get('timerState')), boundary, 'unload cannot extend the recovery checkpoint');
      const fresh = h.recreatePage();
      assert.equal(fresh.sessionId, sessionId);
      assert.equal(h.records.length, 0);
      assert.equal(fresh.data.showStartButton, paused);
      assert.equal(fresh.data.showPauseButton, !paused);
      assert.equal(fresh.data.showStopButton, true);
      assert.equal(fresh.data.showResetButton, true);
      assert.equal(fresh.data.displayTime, isCountdown ? (paused ? '05:55' : '05:10') : (paused ? '01:05' : '01:50'));
      h.emitApp('show'); fresh.onShow(); h.emitAudio('end'); h.advance(1000);
      assert.equal(fresh.data.isRunning, !paused);
      assert.equal(fresh.data.isPaused, paused);
      assert.equal(fresh.data.elapsedTime, paused ? 65 : 111);
      assert.equal(fresh.data.displayTime, isCountdown ? (paused ? '05:55' : '05:09') : (paused ? '01:05' : '01:51'));
      if (!paused) {
        fresh.pauseTimer();
        assert.equal(fresh.data.isPaused, true);
        assert.equal(fresh.data.showStartButton, true);
      }
      fresh.startTimer();
      assert.equal(fresh.data.isRunning, true);
      assert.equal(fresh.data.showPauseButton, true);
      h.advance(1000);
      assert.equal(fresh.data.elapsedTime, paused ? 66 : 112);
      fresh.handleStop();
      assert.equal(fresh.data.isRunning, false);
      assert.equal(fresh.data.showStopButton, false);
      assert.equal(fresh.data.completionDuration, 1);
      assert.equal(h.records.length, 0);
    }
  }
});

test('passive unloads before page hide callbacks preserve either timer through both hot and cold recovery', () => {
  for (const isCountdown of [true, false]) {
    for (const order of ['app-main-hide-before-page-handler', 'audio-begin-before-app-hide']) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000);
      const sessionId = h.page.sessionId;
      const queuedHide = h.page.appHideHandler;
      if (order === 'app-main-hide-before-page-handler') {
        h.application.onHide({ reason: 3 });
        assert.equal(h.page.isAppHidden, false, 'the Page AppHide listener has not run yet');
        h.page.onUnload(); queuedHide({ reason: 3 });
      } else {
        h.emitAudio('begin'); h.page.onHide(); h.page.onUnload();
        h.emitApp('hide', { reason: 3 }); queuedHide({ reason: 3 });
      }
      assert.equal(h.records.length, 0, order);
      assert.equal(h.plays().includes(END_AUDIO), false, order);
      const checkpoint = structuredClone(h.storage.get('timerState'));
      assert.equal(checkpoint.sessionId, sessionId);
      assert.equal(checkpoint.elapsedTime, 65);
      assert.ok(!h.storage.get('timerPendingCompletion'));
      const cold = createPage({ withAppLifecycle: true,
        initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 3600000 });
      assert.equal(cold.page.sessionId, sessionId);
      assert.equal(cold.page.data.isRunning, !isCountdown);
      assert.equal(cold.page.data.isPaused, false);
      assert.equal(cold.page.data.elapsedTime, isCountdown ? 420 : 3665);
      assert.equal(cold.records.length, 0);
      assert.equal(cold.plays().includes(END_AUDIO), isCountdown);
      if (isCountdown) assert.equal(cold.page.pendingCompletion.duration, 7);
      h.advance(45000); h.emitApp('show');
      const fresh = h.recreatePage();
      if (order === 'audio-begin-before-app-hide') h.emitAudio('end');
      assert.equal(fresh.sessionId, sessionId);
      assert.equal(fresh.data.isRunning, true);
      assert.equal(fresh.data.isPaused, false);
      assert.equal(fresh.data.elapsedTime, 110);
      assert.equal(h.records.length, 0);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
  }
});

test('an explicit app exit still settles either timer after audio interruption or passive ownership transfer', () => {
  for (const isCountdown of [true, false]) {
    for (const reason of [0, 1]) {
      for (const appHidesBeforeUnload of [true, false]) {
        const h = createPage({ isCountdown, withAppLifecycle: true });
        h.page.startTimer(); h.advance(65000);
        const sessionId = h.page.sessionId;
        const endedAt = h.now();
        const queuedHide = h.page.appHideHandler;
        h.emitAudio('begin'); h.page.onHide();
        if (appHidesBeforeUnload) h.application.onHide({ reason });
        h.page.onUnload();
        if (!appHidesBeforeUnload) h.emitApp('hide', { reason });
        queuedHide({ reason });
        assert.equal(h.records.length, 1);
        assert.equal(h.records[0][0], 1);
        assert.equal(h.records[0][3], endedAt);
        assert.equal(h.records[0][4], sessionId);
        assert.ok(!h.storage.get('timerPendingEndReminder'));
        h.emitApp('hide', { reason }); h.emitApp('show'); h.emitAudio('end'); h.recreatePage();
        assert.equal(h.page.data.isRunning, false);
        assert.equal(h.page.data.isPaused, false);
        assert.equal(h.records.length, 1);
        assert.equal(h.plays().includes(END_AUDIO), false);
      }
    }
  }
});

test('rebuilt timer pages restore guidance selection and position after visibility and audio both return', () => {
  for (const isCountdown of [true, false]) {
    for (const endBeforeShow of [false, true]) {
      const h = createPage({ isCountdown, withGuide: true });
      h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
      const sessionId = h.page.sessionId;
      const oldGuide = h.page.backgroundMusicPlayer;
      oldGuide.currentTime = 19;
      h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
      h.advance(45000); h.page.onUnload();
      const fresh = h.recreatePage({ visible: false });
      const playCount = h.plays().length;
      if (endBeforeShow) h.emitAudio('end');
      assert.equal(h.plays().length, playCount, 'reconstruction cannot play while hidden');
      h.emitApp('show');
      assert.equal(h.plays().length, playCount, 'AppShow waits for the visible timer page');
      fresh.onShow();
      if (!endBeforeShow) {
        assert.equal(h.plays().length, playCount, 'PageShow waits for audio availability');
        h.emitAudio('end');
      }
      h.advance(0);
      assert.equal(fresh.sessionId, sessionId);
      assert.equal(fresh.data.backgroundMusic, 'default');
      assert.equal(fresh.data.musicText, '引导音频');
      assert.equal(fresh.backgroundMusicPlayer.currentTime, 19);
      assert.equal(fresh.backgroundMusicPlayer.paused, false);
      assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 2);
      assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1);
      h.advance(1000);
      assert.equal(fresh.data.elapsedTime, 111);
      assert.equal(h.records.length, 0);
      const resumedCount = h.plays().length;
      // Queued callbacks from the old page/player must not restart or alter the new one.
      if (oldGuide !== fresh.backgroundMusicPlayer) oldGuide.emitEnded();
      h.emitAudio('end'); fresh.onShow();
      assert.equal(h.plays().length, resumedCount);
    }
  }
});

test('rebuilding a paused interrupted timer preserves guide position until the user resumes', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
    h.page.backgroundMusicPlayer.currentTime = 19;
    h.page.pauseTimer();
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
    h.advance(45000); h.page.onUnload();
    const fresh = h.recreatePage({ visible: false });
    const playCount = h.plays().length;
    h.emitApp('show'); fresh.onShow(); h.emitAudio('end'); h.advance(1000);
    assert.equal(fresh.data.isPaused, true);
    assert.equal(fresh.data.elapsedTime, 65);
    assert.equal(h.plays().length, playCount, 'system return must not resume a manual pause');
    fresh.startTimer(); h.advance(1000);
    assert.equal(fresh.backgroundMusicPlayer.currentTime, 19);
    assert.equal(fresh.backgroundMusicPlayer.paused, false);
    assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 2);
    assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1);
    assert.equal(fresh.data.elapsedTime, 66);
  }
});

test('rebuilt interrupted timers retain pending or playing opening cues before their guidance', () => {
  for (const isCountdown of [true, false]) {
    for (const stage of ['waiting', 'start']) {
      const h = createPage({ isCountdown, withGuide: true });
      h.page.startTimer(); h.advance(stage === 'waiting' ? 2000 : 5000);
      if (stage === 'start') h.page.audioPlayer.currentTime = 7;
      h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
      h.advance(10000); h.page.onUnload();
      const fresh = h.recreatePage({ visible: false });
      const playCount = h.plays().length;
      h.emitApp('show'); fresh.onShow();
      assert.equal(h.plays().length, playCount, 'the cue must wait for audio availability');
      h.emitAudio('end'); h.advance(0);
      assert.equal(fresh.audioPlayer.src, START_AUDIO);
      assert.equal(fresh.audioPlayer.currentTime, stage === 'start' ? 7 : 0);
      assert.equal(fresh.audioPlayer.paused, false);
      assert.equal(h.plays().filter(src => src === START_AUDIO).length, stage === 'start' ? 2 : 1);
      assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 0);
      fresh.audioPlayer.emitEnded();
      assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 1);
      assert.equal(fresh.data.elapsedTime, stage === 'start' ? 15 : 12);
    }
  }
});

test('a countdown expiring while its page is rebuilt plays only its closing cue on return', async () => {
  for (const showBeforeRebuild of [false, true]) {
    const h = createPage({ withGuide: true });
    h.page.applyDuration(2); h.page.startTimer(); h.advance(5000); h.players[0].emitEnded();
    h.page.backgroundMusicPlayer.currentTime = 19;
    const deadline = h.page.data.startTimestamp + 120000;
    h.advance(60000); h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
    h.page.onUnload(); h.advance(90000);
    if (showBeforeRebuild) h.emitApp('show');
    const fresh = h.recreatePage({ visible: false });
    if (!showBeforeRebuild) h.emitApp('show');
    fresh.onShow(); h.emitAudio('end'); h.advance(0);
    assert.equal(fresh.data.isRunning, false);
    assert.equal(fresh.pendingCompletion.endedAt, deadline);
    assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 1, 'expired guidance must not resume');
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    await fresh.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 2);
    assert.equal(h.records[0][3], deadline);
  }
});

test('explicit app exits save either timer at actual minutes and discard its unfinished audio', () => {
  for (const isCountdown of [true, false]) {
    for (const reason of [0, 1]) {
      const h = createPage({ isCountdown, withGuide: true, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000);
      const sessionId = h.page.sessionId;
      const endedAt = h.now();
      h.emitApp('hide', { reason }); h.advance(30000);
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 1);
      assert.equal(h.records[0][3], endedAt);
      assert.equal(h.records[0][4], sessionId);
      assert.ok(!h.storage.get('timerPendingCompletion'));
      assert.ok(!h.storage.get('timerPendingEndReminder'));
      assert.equal(h.plays().includes(END_AUDIO), false);
      h.emitApp('show'); h.page.onShow();
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.data.isPaused, false);
      assert.equal(h.records.length, 1);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
  }
});

test('a new session after rebuilding an interrupted timer starts its own audio from zero', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
    h.page.backgroundMusicPlayer.currentTime = 19;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
    const fresh = h.recreatePage({ visible: false });
    h.emitApp('show'); fresh.onShow(); h.emitAudio('end'); h.advance(0);
    fresh.stopTimer({ playEndSound: false });
    const playCount = h.plays().length;
    fresh.startTimer(); h.emitAudio('end'); h.advance(4999);
    assert.equal(h.plays().length, playCount, 'stale recovery cannot bypass a new session preparation delay');
    h.advance(1);
    assert.equal(fresh.audioPlayer.src, START_AUDIO);
    assert.equal(fresh.audioPlayer.currentTime, 0);
    fresh.audioPlayer.emitEnded();
    assert.equal(fresh.backgroundMusicPlayer.currentTime, 0);
    assert.equal(fresh.backgroundMusicPlayer.paused, false);
    assert.equal(fresh.backgroundMusicPlayer.startTime, 0);
    fresh.backgroundMusicPlayer.currentTime = 3;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); fresh.onHide(); fresh.onUnload();
    const rebuilt = h.recreatePage({ visible: false });
    h.emitApp('show'); rebuilt.onShow(); h.emitAudio('end'); h.advance(0);
    assert.equal(rebuilt.backgroundMusicPlayer.currentTime, 3, 'a later interruption uses the new session position');
  }
});

test('an already finished guide is not replayed after interrupted page reconstruction', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
    h.page.backgroundMusicPlayer.emitEnded();
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
    const fresh = h.recreatePage({ visible: false });
    const playCount = h.plays().length;
    h.emitApp('show'); fresh.onShow(); h.emitAudio('end'); h.advance(1000);
    assert.equal(fresh.data.isRunning, true);
    assert.equal(h.plays().length, playCount);
  }
});

test('a cold restart after a call continues either timer and resumes guidance without replaying the opening cue', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000); h.players[0].emitEnded(); h.advance(60000);
    h.page.backgroundMusicPlayer.currentTime = 19;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onUnload();
    const fresh = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 60000 });
    fresh.emitApp('show'); fresh.page.onShow(); fresh.emitAudio('end'); fresh.advance(1000);
    assert.equal(fresh.page.data.isPaused, false);
    assert.equal(fresh.page.data.isRunning, true);
    assert.equal(fresh.page.data.elapsedTime, 126);
    assert.equal(fresh.page.sessionId, h.storage.get('timerState').sessionId);
    assert.equal(fresh.records.length, 0);
    assert.equal(fresh.page.backgroundMusicPlayer.currentTime, 19);
    assert.deepEqual(fresh.plays(), [GUIDE_AUDIO]);
    fresh.page.startTimer(); fresh.advance(5000);
    assert.equal(fresh.page.data.elapsedTime, 131);
    assert.deepEqual(fresh.plays(), [GUIDE_AUDIO], 'a redundant start cannot restart either cue or guidance');
  }
});


test('a cold restart after a long call completes an expired countdown and continues a count-up', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown });
    h.page.startTimer(); h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(60000);
    const sessionId = h.page.sessionId;
    const startedAt = h.page.data.startTimestamp;
    h.emitApp('hide', { reason: 3 });
    h.advance(3600000); h.emitApp('hide', { reason: 3 }); h.page.onUnload();
    const fresh = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() });
    assert.equal(fresh.page.data.isRunning, !isCountdown);
    assert.equal(fresh.page.data.isPaused, false);
    assert.equal(fresh.page.data.elapsedTime, isCountdown ? 420 : 3665);
    assert.equal(fresh.page.data.remainingTime, 0);
    assert.equal(fresh.records.length, 0);
    assert.equal(fresh.page.sessionId, sessionId);
    if (isCountdown) {
      assert.equal(fresh.page.pendingCompletion.duration, 7);
      assert.equal(fresh.page.pendingCompletion.endedAt, startedAt + 420000);
      assert.deepEqual(fresh.plays(), [END_AUDIO]);
    } else {
      assert.equal(fresh.page.pendingCompletion, null);
      assert.deepEqual(fresh.plays(), []);
    }
    fresh.emitApp('show'); fresh.page.onShow(); fresh.advance(1000);
    assert.equal(fresh.records.length, 0);
    assert.equal(fresh.page.data.elapsedTime, isCountdown ? 420 : 3666);
    assert.equal(fresh.plays().filter(src => src === END_AUDIO).length, Number(isCountdown));
  }
});


test('direct process reclamation without lifecycle callbacks preserves running and manually paused sessions', async () => {
  for (const isCountdown of [true, false]) {
    for (const paused of [false, true]) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(60000);
      const sessionId = h.page.sessionId;
      const startedAt = h.page.data.startTimestamp;
      if (paused) h.page.pauseTimer();
      // A killed process gets no onHide, onUnload or audio interruption event.
      const saved = structuredClone(Object.fromEntries(h.storage));
      const fresh = createPage({ withAppLifecycle: true, initialStorage: saved, initialTime: h.now() + 60000 });
      assert.equal(fresh.page.sessionId, sessionId);
      assert.equal(fresh.page.data.startTimestamp, startedAt);
      assert.equal(fresh.page.data.isRunning, !paused);
      assert.equal(fresh.page.data.isPaused, paused);
      assert.equal(fresh.page.data.elapsedTime, paused ? 65 : 125);
      assert.equal(fresh.records.length, 0);
      assert.deepEqual(fresh.plays(), [], 'a completed opening reminder cannot replay after process reclamation');
      fresh.advance(30000);
      assert.equal(fresh.page.calculateElapsedTime(), paused ? 65 : 155);
      fresh.page.startTimer(); fresh.advance(5000);
      assert.equal(fresh.page.data.elapsedTime, paused ? 70 : 160);
      assert.equal(fresh.page.sessionId, sessionId);
      fresh.page.handleStop();
      assert.deepEqual(fresh.plays(), [END_AUDIO]);
      await fresh.page.confirmCompletion(); await fresh.page.confirmCompletion();
      assert.equal(fresh.records.length, 1);
      assert.equal(fresh.records[0][0], paused ? 1 : 2);
      assert.equal(fresh.records[0][4], sessionId);
      const savedAgain = createPage({ initialStorage: structuredClone(Object.fromEntries(fresh.storage)), initialTime: fresh.now() + 60000 });
      assert.equal(savedAgain.page.data.isRunning, false);
      assert.equal(savedAgain.page.pendingCompletion, null);
      assert.equal(savedAgain.records.length, 0);
      assert.deepEqual(savedAgain.plays(), []);
    }
  }
});

test('a reclaimed count-up reaches its original 24-hour limit once across repeated cold starts', async () => {
  const h = createPage({ isCountdown: false, withAppLifecycle: true });
  h.page.startTimer(); h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(60000);
  const sessionId = h.page.sessionId;
  const startedAt = h.page.data.startTimestamp;
  h.page.pauseTimer(); h.advance(30000); h.page.startTimer(); h.advance(10000);
  const fresh = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: startedAt + 26 * 3600000 });
  assert.equal(fresh.page.data.isRunning, false);
  assert.equal(fresh.page.data.isPaused, false);
  assert.equal(fresh.page.pendingCompletion.duration, 1440);
  assert.equal(fresh.page.pendingCompletion.endedAt, startedAt + 86400000 + 30000);
  assert.equal(fresh.page.pendingCompletion.sessionId, sessionId);
  assert.deepEqual(fresh.plays(), [END_AUDIO]);
  assert.equal(fresh.records.length, 0);
  fresh.page.audioPlayer.emitEnded();
  const again = createPage({ initialStorage: structuredClone(Object.fromEntries(fresh.storage)), initialTime: fresh.now() + 86400000 });
  assert.deepEqual({ ...again.page.pendingCompletion }, { ...fresh.page.pendingCompletion });
  assert.deepEqual(again.plays(), [], 'an acknowledged closing reminder cannot ring on another restart');
  await again.page.confirmCompletion(); await again.page.confirmCompletion();
  assert.equal(again.records.length, 1);
  assert.equal(again.records[0][0], 1440);
  assert.equal(again.records[0][3], startedAt + 86400000 + 30000);
  assert.equal(again.records[0][4], sessionId);
  const saved = createPage({ initialStorage: structuredClone(Object.fromEntries(again.storage)), initialTime: again.now() + 86400000 });
  assert.equal(saved.page.data.isRunning, false);
  assert.equal(saved.page.pendingCompletion, null);
  assert.equal(saved.records.length, 0);
  assert.deepEqual(saved.plays(), []);
});

test('alarms and short or long calls keep either timer running in the foreground and background', async () => {
  for (const isCountdown of [true, false]) {
    for (const background of [false, true]) {
      // The API exposes only audio interruption begin/end: neither its reason
      // nor its duration is evidence that a call was answered or an alarm closed.
      for (const interruptedFor of [3000, 65000, 180000]) {
        const h = createPage({ isCountdown, withGuide: true, withAppLifecycle: true });
        h.page.applyDuration(10); h.page.startTimer();
        h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(60000);
        const sessionId = h.page.sessionId;
        h.page.backgroundMusicPlayer.currentTime = 12;
        h.emitAudio('begin');
        if (background) { h.emitApp('hide', { reason: 3 }); h.page.onHide(); }
        const playedAtInterruption = h.plays().length;
        h.advance(interruptedFor);
        assert.equal(h.page.data.isRunning, true);
        assert.equal(h.page.data.isPaused, false);
        assert.equal(h.page.calculateElapsedTime(), 65 + interruptedFor / 1000);
        assert.equal(h.page.pendingCompletion, null);
        assert.equal(h.records.length, 0);
        assert.equal(h.plays().length, playedAtInterruption);
        h.emitAudio('end');
        if (background) { h.emitApp('show'); h.page.onShow(); }
        assert.equal(h.page.sessionId, sessionId);
        assert.equal(h.page.backgroundMusicPlayer.currentTime, 12);
        assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1);
        assert.equal(h.plays().includes(END_AUDIO), false);
        assert.equal(h.records.length, 0);
        if (isCountdown) h.advance(600000 - (65000 + interruptedFor));
        else h.page.handleStop();
        assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
        assert.equal(h.page.pendingCompletion.duration, isCountdown ? 10 : Math.floor((65000 + interruptedFor) / 60000));
        await h.page.confirmCompletion(); await h.page.confirmCompletion();
        assert.equal(h.records.length, 1);
        assert.equal(h.records[0][4], sessionId);
      }
    }
  }
});

test('unloading releases audio interruption listeners and queued events cannot restart old players', () => {
  const h = createPage({ withGuide: true });
  h.page.startTimer(); h.advance(5000); h.players[0].emitEnded();
  const queuedBegin = [...h.listeners.audioBegin];
  const queuedEnd = [...h.listeners.audioEnd];
  assert.equal(queuedBegin.length, 1);
  assert.equal(queuedEnd.length, 1);
  h.page.onUnload();
  assert.equal(h.listeners.audioBegin.size, 0);
  assert.equal(h.listeners.audioEnd.size, 0);
  assert.equal(h.players.some(player => !player.destroyed && player.src === END_AUDIO), false);
  const playCount = h.plays().length;
  h.emitAudio('begin'); h.emitAudio('end');
  [...queuedBegin, ...queuedEnd].forEach(callback => callback());
  h.advance(1000);
  assert.equal(h.plays().length, playCount);
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
  const { page, plays, advance, toasts } = createPage({ withGuide: true });
  page.setData({ totalTime: 2, remainingTime: 2 });
  page.startTimer();
  advance(2000);
  assert.equal(page.data.isRunning, false);
  assert.deepEqual(plays(), [END_AUDIO]);
  assert.equal(toasts.at(-1).title, '不足1分钟，本次不会记录');
  page.audioPlayer.emitEnded();
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
        assert.equal(page.timerInterval, null);
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
      page.applyDuration(30);
      page.startTimer();
      advance(seconds * 1000);
      page.handleStop();
      assert.deepEqual(navigations, []);
      assert.equal(page.data.completionDuration, minutes);
      assert.equal(page.data.showCompletionDialog, true);
      assert.deepEqual(toasts, []);
      assert.equal(page.data.isRunning, false);
      assert.equal(page.data.isPaused, false);
      assert.equal(page.timerInterval, null);
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
  const { page, plays, advance } = createPage();
  page.startTimer();
  advance(5000);
  page.stopTimer();
  const closing = page.audioPlayer;
  closing.currentTime = 8;
  page.startTimer();
  assert.equal(closing.paused, true, 'the old closing cue must stop during the new wait');
  advance(4999);
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
  advance(1);
  assert.notEqual(page.audioPlayer, closing);
  assert.equal(page.audioPlayer.currentTime, 0);
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

test('leaving the optional reflection dialog stops 收坐 without losing the dialog', () => {
  const { page, plays, navigations, advance } = createPage({ isCountdown: false });
  page.startTimer();
  advance(60000);
  page.handleStop();
  const closing = page.audioPlayer;
  page.onHide();
  assert.equal(navigations.length, 0);
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(closing.src, END_AUDIO);
  assert.equal(closing.paused, true);
  closing.emitEnded();
  assert.deepEqual(plays(), [START_AUDIO, END_AUDIO]);
});

test('a closing bell interrupted by passive app hides resumes without losing its reflection draft', () => {
  for (const reason of [2, 3, undefined]) {
    for (const pageHidesFirst of [false, true]) {
      const h = createPage({ withGuide: true });
      h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
      h.page.onCompletionInput({ detail: { value: '下次打开继续填写' } });
      const completion = { ...h.page.pendingCompletion };
      const closing = h.page.audioPlayer;
      closing.currentTime = 8;
      if (pageHidesFirst) h.page.onHide();
      h.emitApp('hide', { reason });
      if (!pageHidesFirst) h.page.onHide();
      assert.equal(closing.paused, true);
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, completion.sessionId);
      closing.emitEnded(); h.advance(30000);
      h.emitApp('show'); h.page.onShow();
      assert.equal(h.page.audioPlayer, closing);
      assert.equal(closing.paused, false);
      assert.equal(closing.currentTime, 8);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
      h.page.onShow();
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
      assert.deepEqual({ ...h.page.pendingCompletion }, completion);
      assert.equal(h.records.length, 0);
    }
  }
});

test('closing from the daily page stops 收坐 without saving twice and a new session still plays 起坐 after five seconds', async () => {
  for (const isCountdown of [true, false]) {
    const { page, plays, records, storage, navigations, advance, emitApp } = createPage({ isCountdown });
    page.startTimer();
    const sessionId = page.sessionId;
    advance(60000);
    page.handleStop();
    const closing = page.audioPlayer;
    await page.confirmCompletionAndViewDaily();
    assert.deepEqual(navigations, [dailyPathForRecord(records[0])]);
    assert.equal(closing.src, END_AUDIO);
    assert.equal(closing.paused, true, 'leaving for the daily page stops 收坐 immediately');
    assert.equal(records.length, 1);
    const beforeExit = plays();

    emitApp('hide');
    assert.equal(closing.paused, true, 'closing from another page must stop the retained timer player');
    assert.equal(storage.get('timerPendingEndReminder'), null, 'the completed action has already acknowledged the bell');
    closing.emitEnded();
    advance(60000);
    emitApp('show');
    page.onShow();
    await page.confirmCompletion();
    assert.deepEqual(plays(), beforeExit, 'a dismissed closing reminder stays silent on return');
    assert.equal(records.length, 1);
    assert.equal(records[0][4], sessionId);
    assert.equal(storage.get('timerPendingCompletion'), null);

    page.startTimer();
    assert.notEqual(page.sessionId, sessionId);
    advance(4999);
    assert.deepEqual(plays(), beforeExit);
    advance(1);
    assert.deepEqual(plays(), [...beforeExit, START_AUDIO]);
    assert.equal(page.audioPlayer.currentTime, 0);
    assert.equal(records.length, 1, 'starting another session must not resubmit the saved completion');
  }
});

test('callbacks from an unloaded closing cue cannot interrupt the next sitting or start its guide early', () => {
  for (const event of ['emitEnded', 'emitError']) {
    const h = createPage({ withGuide: true });
    h.page.startTimer(); h.advance(5000); h.page.handleStop();
    const closing = h.page.audioPlayer;
    h.page.onUnload();
    const fresh = h.recreatePage();
    fresh.setData({ backgroundMusic: 'default', defaultMusicUrl: GUIDE_AUDIO });
    fresh.startTimer(); h.advance(5000);
    const opening = fresh.audioPlayer;
    assert.notEqual(opening, closing);
    assert.equal(closing.destroyed, true);
    const count = h.plays().length;
    closing[event]();
    assert.equal(fresh.currentSessionSound, 'start');
    assert.equal(opening.paused, false);
    assert.equal(h.plays().length, count);
    opening.emitEnded();
    assert.equal(h.plays().at(-1), GUIDE_AUDIO);
  }
});

test('unloading stops all cues without an App closing bell and rejects old cue callbacks', () => {
  for (const cue of ['waiting', 'start', 'end']) {
    const h = createPage({ withGuide: true });
    h.page.startTimer();
    h.advance(cue === 'waiting' ? 2000 : 5000);
    if (cue === 'end') h.page.stopTimer();
    const oldPlayers = [...h.players];
    h.page.onUnload();
    assert.ok(oldPlayers.every(player => player.destroyed));
    const afterUnload = h.plays();
    const closing = h.players.findLast(player => !player.destroyed && player.src === END_AUDIO);
    assert.equal(closing, undefined, 'leaving the page cannot transfer a closing reminder to the App');
    for (const player of oldPlayers) { player.emitEnded(); player.emitError(); }
    assert.deepEqual(h.plays(), afterUnload, 'queued page callbacks cannot start another sound');
    h.emitApp('hide'); h.emitApp('show'); h.advance(6000);
    assert.deepEqual(h.plays(), afterUnload, 'a dismissed closing bell does not replay');
    assert.equal(h.plays().includes(GUIDE_AUDIO), false);
  }
});

test('completion saves an empty reflection once and closes the dialog without opening the daily page', async () => {
  const { page, records, navigations, advance, toasts, storage } = createPage();
  page.setData({ totalTime: 60, remainingTime: 60 });
  page.startTimer();
  const sessionId = page.sessionId;
  advance(60000);
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(page.data.showStopButton, false);
  assert.equal(page.data.showResetButton, false);
  assert.deepEqual(navigations, []);
  await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  assert.equal(records[0][1].length, 0);
  assert.equal(records[0][2].length, 0);
  assert.equal(records[0][4], sessionId);
  assert.deepEqual(navigations, [], 'the primary completion action stays on the timer');
  assert.equal(page.data.showCompletionDialog, false);
  assert.equal(page.data.isSavingCompletion, false);
  assert.equal(page.data.isCompletionSaved, false);
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
  await page.confirmCompletionAndViewDaily();
  assert.equal(page.data.showCompletionDialog, true, 'confirmation must not expose the timer behind the dialog');
  assert.equal(page.data.isSavingCompletion, true);
  await page.confirmCompletionAndViewDaily();
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
    await page.confirmCompletionAndViewDaily();
    if (!throws) route.fail({ errMsg: 'navigateTo:fail' });
    assert.equal(page.data.showCompletionDialog, true);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.isCompletionSaved, true);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.equal(toasts.at(-1).title, '记录已保存，静心卡打开失败，请重试');
    page.startTimer();
    assert.equal(page.data.isRunning, false, 'the saved completion remains available for navigation retry');
    shouldFail = false;
    await Promise.all([page.confirmCompletionAndViewDaily(), page.confirmCompletionAndViewDaily()]);
    assert.equal(records.length, 1);
    assert.deepEqual(checked, ['很平静']);
    assert.equal(navigations.length, 2);
    page.onHide();
    route.success({});
    page.onShow();
    assert.equal(page.data.showCompletionDialog, false);
  }
});

test('a saved completion can finish on the timer after daily navigation fails without another save or text check', async () => {
  for (const throws of [false, true]) {
    let route;
    const checked = [];
    const { page, advance, records, navigations, storage } = createPage({
      checkText: async text => { checked.push(text); return true; },
      navigateTo(options) {
        route = options;
        if (throws) throw new Error('route failed');
      }
    });
    page.startTimer();
    const completedId = page.sessionId;
    advance(60000);
    page.handleStop();
    page.onCompletionInput({ detail: { value: '已保存的感受' } });
    await page.confirmCompletionAndViewDaily();
    if (!throws) route.fail({ errMsg: 'navigateTo:fail' });
    assert.equal(page.data.isCompletionSaved, true);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.showCompletionDialog, true);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.equal(records.length, 1);
    await Promise.all([page.confirmCompletion(), page.confirmCompletion()]);
    assert.equal(page.data.showCompletionDialog, false);
    assert.equal(page.data.isCompletionSaved, false);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.completionText, '');
    assert.deepEqual(checked, ['已保存的感受']);
    assert.equal(records.length, 1);
    assert.deepEqual(navigations, [dailyPathForRecord(records[0])]);
    await page.confirmCompletionAndViewDaily();
    assert.equal(navigations.length, 1, 'a queued daily click after finishing cannot reopen the old record');
    page.startTimer();
    assert.equal(page.data.isRunning, true);
    assert.notEqual(page.sessionId, completedId);
  }
});

test('daily navigation retries keep the saved sitting across midnight and a new session replaces its snapshot', async () => {
  for (const isCountdown of [true, false]) {
    let route;
    const h = createPage({ isCountdown, initialTime: Date.parse('2026-11-06T23:58:00+08:00'),
      navigateTo: options => { route = options; } });
    h.page.startTimer();
    h.advance(60000);
    h.page.handleStop();
    const firstCompletion = { ...h.page.pendingCompletion };
    await h.page.confirmCompletionAndViewDaily();
    route.fail({ errMsg: 'navigateTo:fail' });
    h.jump(3 * 60 * 60 * 1000);
    await h.page.confirmCompletionAndViewDaily();
    assert.deepEqual(h.navigations, [dailyPathForRecord(h.records[0]), dailyPathForRecord(h.records[0])]);
    const firstQuery = new URLSearchParams(h.navigations[1].split('?')[1]);
    assert.equal(Number(firstQuery.get('completedAt')), firstCompletion.endedAt);
    assert.equal(Number(firstQuery.get('minutes')), firstCompletion.duration);
    assert.equal(h.records.length, 1);

    h.page.onHide(); route.success({}); h.page.onShow();
    assert.equal(h.page._dailyCompletion, null, 'leaving the completion dialog releases its snapshot');
    h.page.startTimer();
    h.advance(120000);
    h.page.handleStop();
    await h.page.confirmCompletionAndViewDaily();
    assert.equal(h.records.length, 2);
    assert.equal(h.navigations[2], dailyPathForRecord(h.records[1]));
    const nextQuery = new URLSearchParams(h.navigations[2].split('?')[1]);
    assert.equal(Number(nextQuery.get('minutes')), 2);
    assert.notEqual(nextQuery.get('completedAt'), firstQuery.get('completedAt'));
  }
});

test('mixed completion clicks save once and keep the destination chosen by the first click', async () => {
  for (const isCountdown of [true, false]) {
    for (const viewDaily of [false, true]) {
      let resolveCheck;
      let route;
      const checked = [];
      const { page, advance, records, navigations } = createPage({
        isCountdown,
        checkText(text) {
          checked.push(text);
          return new Promise(resolve => { resolveCheck = resolve; });
        },
        navigateTo: options => { route = options; }
      });
      page.startTimer();
      advance(60000);
      page.handleStop();
      page.onCompletionInput({ detail: { value: '一次确认' } });
      const pending = viewDaily ? page.confirmCompletionAndViewDaily() : page.confirmCompletion();
      assert.equal(page.data.isSavingCompletion, true);
      await (viewDaily ? page.confirmCompletion() : page.confirmCompletionAndViewDaily());
      assert.equal(records.length, 0);
      assert.deepEqual(checked, ['一次确认']);
      resolveCheck(true);
      await pending;
      assert.equal(records.length, 1);
      assert.deepEqual(navigations, viewDaily ? [dailyPathForRecord(records[0])] : []);
      if (viewDaily) {
        assert.equal(page.data.showCompletionDialog, true);
        assert.equal(page.data.isSavingCompletion, true);
        await page.confirmCompletion();
        await page.confirmCompletionAndViewDaily();
        assert.equal(page.data.showCompletionDialog, true, 'a pending route must retain its outgoing dialog');
        assert.equal(navigations.length, 1);
        page.onHide();
        route.success({});
        page.onShow();
      } else {
        assert.equal(page.data.showCompletionDialog, false);
        await page.confirmCompletionAndViewDaily();
        assert.deepEqual(navigations, [], 'a queued secondary click cannot change a completed stay action');
      }
      assert.equal(page.data.isSavingCompletion, false);
      assert.equal(page.data.isCompletionSaved, false);
      assert.equal(records.length, 1);
      assert.deepEqual(checked, ['一次确认']);
    }
  }
});

test('a background reflection check saves once and preserves the chosen completion destination without auto-navigation', async () => {
  for (const isCountdown of [true, false]) {
    for (const viewDaily of [false, true]) {
      let resolveCheck;
      const { page, advance, records, navigations, emitApp, storage } = createPage({
        isCountdown,
        checkText: () => new Promise(resolve => { resolveCheck = resolve; })
      });
      page.startTimer();
      advance(60000);
      page.handleStop();
      page.onCompletionInput({ detail: { value: '安静' } });
      const pending = viewDaily ? page.confirmCompletionAndViewDaily() : page.confirmCompletion();
      page.onHide();
      emitApp('hide');
      resolveCheck(true);
      await pending;
      assert.equal(records.length, 1);
      assert.deepEqual(navigations, []);
      assert.equal(page.pendingCompletion, null);
      assert.equal(storage.get('timerPendingCompletion'), null);
      assert.equal(page.data.isSavingCompletion, false);
      assert.equal(page.data.isCompletionSaved, viewDaily);
      assert.equal(page.data.showCompletionDialog, viewDaily);
      emitApp('show');
      page.onShow();
      assert.deepEqual(navigations, [], 'returning to the timer must not resume a navigation implicitly');
      if (viewDaily) {
        await page.confirmCompletionAndViewDaily();
        assert.deepEqual(navigations, [dailyPathForRecord(records[0])]);
        assert.equal(records.length, 1);
      } else {
        page.startTimer();
        assert.equal(page.data.isRunning, true);
      }
    }
  }
});

test('a late navigation failure stays silent while hidden and allows retry on return', async () => {
  let route;
  const { page, advance, records, navigations, toasts } = createPage({
    navigateTo: options => { route = options; }
  });
  page.startTimer();
  advance(60000);
  page.handleStop();
  await page.confirmCompletionAndViewDaily();
  page.onHide();
  route.fail({ errMsg: 'navigateTo:fail' });
  assert.deepEqual(toasts, []);
  assert.equal(page.data.isSavingCompletion, false);
  page.onShow();
  await page.confirmCompletionAndViewDaily();
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
      assert.deepEqual(navigations, [], ending);
      page.onShow();
      assert.equal(page.data.isSavingCompletion, false, 'completion releases controls before the upload finishes');
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
      assert.deepEqual(navigations, [], 'late uploads and repeated confirms must not navigate');
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

test('an already completed timer keeps its saved notice after a background upload failure', async () => {
  let resolveUpload;
  const h = createPage({ isCountdown: false,
    backgroundUpload: () => new Promise(resolve => { resolveUpload = resolve; }) });
  h.page.startTimer(); h.advance(60000); h.page.handleStop(); h.emitApp('hide');
  assert.equal(h.records.length, 1);
  assert.equal(h.storage.get('timerPendingCompletion'), null);
  h.page.onUnload();
  h.page.setData = () => { throw new Error('an upload cannot render an unloaded page'); };
  resolveUpload({ success: true, cloudSynced: false, syncErrorCode: 'CLOUD_TIMEOUT' });
  await Promise.all(h.uploads);
  const reopened = createPage({ initialStorage: Object.fromEntries(h.storage) });
  assert.equal(reopened.records.length, 0);
  assert.equal(reopened.page.pendingCompletion, null);
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

test('an online rejected reflection stays editable and either completion action can retry after clearing it', async () => {
  for (const isCountdown of [false, true]) {
    for (const action of ['confirmCompletion', 'confirmCompletionAndViewDaily']) {
      const { page, records, advance, storage, navigations } = createPage({
        isCountdown,
        networkType: 'wifi',
        contentSecRequest: async () => ({ result: { success: true, safe: false } })
      });
      page.setData({ totalTime: 60, remainingTime: 60 });
      page.startTimer();
      advance(60000);
      if (!isCountdown) page.handleStop();
      page.onCompletionInput({ detail: { value: 'blocked' } });
      await page[action]();
      assert.equal(records.length, 0);
      assert.deepEqual(navigations, []);
      assert.equal(page.data.showCompletionDialog, true);
      assert.equal(page.data.isSavingCompletion, false);
      assert.equal(page.data.isCompletionSaved, false);
      assert.equal(page.data.completionText, 'blocked');
      assert.equal(storage.get('timerPendingCompletion').text, 'blocked');
      page.onCompletionInput({ detail: { value: '' } });
      await page[action]();
      assert.equal(records.length, 1);
      assert.deepEqual(navigations, action === 'confirmCompletion' ? [] : [dailyPathForRecord(records[0])]);
      page.onShow();
      assert.equal(page.data.showCompletionDialog, false);
      assert.equal(page.data.isSavingCompletion, false);
    }
  }
});

test('count-up keeps running or manually paused across background time without saving early', () => {
  for (const paused of [false, true]) {
    const h = createPage({ isCountdown: false });
    h.page.startTimer(); h.advance(125000);
    if (paused) { h.page.pauseTimer(); h.advance(120000); }
    h.emitApp('hide', { reason: 3 });
    assert.equal(h.records.length, 0);
    assert.equal(h.page.timerInterval, null);
    assert.ok(h.storage.get('timerState'));
    h.advance(30000); h.emitApp('show'); h.page.onShow();
    assert.equal(h.page.data.isRunning, !paused);
    assert.equal(h.page.data.isPaused, paused);
    assert.equal(h.page.calculateElapsedTime(), paused ? 125 : 155);
    assert.equal(h.records.length, 0);
  }
});

test('hiding a subminute count-up defers audio while retaining the running session', () => {
  const h = createPage({ isCountdown: false });
  h.page.startTimer(); h.advance(2000); h.emitApp('hide', { reason: 3 }); h.advance(60000);
  assert.equal(h.records.length, 0);
  assert.deepEqual(h.plays(), []);
  assert.equal(h.page.data.isRunning, true);
  h.emitApp('show'); h.page.onShow(); h.advance(0);
  assert.equal(h.page.data.elapsedTime, 62);
  assert.equal(h.plays().includes(END_AUDIO), false);
});

test('explicit exits settle both modes once while passive hides preserve them across page lifecycle orders', () => {
  for (const isCountdown of [true, false]) {
    for (const reason of [0, 1, 2, 3, undefined]) {
      for (const paused of [false, true]) {
        for (const pageHidesFirst of [false, true]) {
          const h = createPage({ isCountdown, withAppLifecycle: true });
          h.page.startTimer(); h.advance(125000);
          const sessionId = h.page.sessionId;
          if (paused) { h.page.pauseTimer(); h.advance(120000); }
          const endedAt = h.now();
          const explicit = reason === 0 || reason === 1;
          if (pageHidesFirst) h.page.onHide();
          h.emitApp('hide', { reason });
          if (!pageHidesFirst) h.page.onHide();
          assert.equal(h.records.length, explicit ? 1 : 0);
          assert.equal(h.plays().includes(END_AUDIO), false);
          if (explicit) {
            assert.equal(h.records[0][0], 2);
            assert.equal(h.records[0][3], endedAt);
            assert.equal(h.records[0][4], sessionId);
            assert.ok(!h.storage.get('timerPendingEndReminder'));
          }
          h.emitApp('hide', { reason }); h.page.onUnload(); h.page.onUnload();
          h.advance(30000); h.emitApp('show');
          const fresh = h.recreatePage();
          if (explicit) {
            assert.equal(fresh.data.isRunning, false);
            assert.equal(fresh.data.isPaused, false);
          } else {
            assert.equal(fresh.sessionId, sessionId);
            assert.equal(fresh.data.isRunning, !paused);
            assert.equal(fresh.data.isPaused, paused);
            assert.equal(fresh.data.elapsedTime, paused ? 125 : 155);
          }
          assert.equal(fresh.pendingCompletion, null);
          assert.equal(h.records.length, explicit ? 1 : 0);
          assert.equal(h.plays().includes(END_AUDIO), false);
        }
      }
    }
  }
});

test('a system interruption suspends countdown audio without ending the session or playing 收坐', () => {
  for (const sound of ['waiting', 'start', 'guide']) {
    const { page, players, plays, records, advance, emitApp } = createPage({ withGuide: true });
    page.startTimer();
    advance(sound === 'waiting' ? 2000 : 5000);
    if (sound === 'guide') players[0].emitEnded();
    const beforeExit = plays();
    emitApp('hide', { reason: 3 });
    assert.ok(players.every(player => player.paused), sound);
    advance(10000);
    emitApp('show');
    page.onShow();
    assert.equal(plays().filter(src => src === END_AUDIO).length, 0);
    assert.equal(page.data.isRunning, true);
    assert.ok(plays().length >= beforeExit.length);
    assert.equal(records.length, 0);
  }
});

test('page recreation during system interruptions retains an unfinished countdown', () => {
  const h = createPage();
  h.page.startTimer();
  const sessionId = h.page.sessionId;
  h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(85000);
  h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
  h.page.setData = () => { throw new Error('unloaded page cannot render'); };
  assert.equal(h.countdown.getSnapshot().isRunning, true);
  assert.equal(h.records.length, 0);
  h.advance(30000);
  h.emitApp('show');
  const reopened = h.recreatePage();
  assert.equal(reopened.sessionId, sessionId);
  assert.equal(reopened.data.elapsedTime, 120);
  assert.equal(reopened.data.remainingTime, 300);
  assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1);
  h.emitApp('hide', { reason: 3 });
  assert.equal(h.records.length, 0);
  h.advance(1000);
  h.emitApp('show'); reopened.onShow(); reopened.startTimer();
  assert.equal(reopened.data.elapsedTime, 121);
  assert.equal(reopened.sessionId, sessionId);
});

test('cold countdown checkpoints keep running time and preserve only explicit manual pauses', () => {
  const { page, storage, advance } = createPage();
  page.startTimer();
  advance(127000);
  const state = storage.get('timerState');
  assert.equal(state.elapsedTime, 125);
  assert.equal(state.saveTime, state.startTimestamp + 125000);
  for (const isPaused of [false, true]) {
    const savedAt = Date.parse('2026-09-17T08:00:00+08:00');
    const reopened = createPage({ initialTime: savedAt + 60000, initialStorage: {
      timerState: {
        ...state, isRunning: !isPaused, isPaused, status: isPaused ? 'paused' : 'running', saveTime: savedAt,
        startTimestamp: savedAt - 125000, pauseTimestamp: isPaused ? savedAt : 0
      }
    } });
    const expected = isPaused ? 125 : 185;
    assert.equal(reopened.page.data.isRunning, !isPaused);
    assert.equal(reopened.page.data.isPaused, isPaused);
    assert.equal(reopened.page.data.elapsedTime, expected);
    assert.equal(reopened.page.data.remainingTime, state.totalTime - expected);
    assert.equal(reopened.records.length, 0);
    assert.equal(reopened.page.sessionId, state.sessionId);
    assert.equal(reopened.storage.get('timerState').status, isPaused ? 'paused' : 'running');
    reopened.page.startTimer(); reopened.advance(1000);
    assert.equal(reopened.page.data.elapsedTime, expected + 1);
  }
});


test('a delayed background callback completes at the real deadline after returning and retains its bell', () => {
  const { page, records, jump, emitApp, plays, storage } = createPage();
  page.setData({ totalTime: 60, remainingTime: 60 });
  page.startTimer();
  const startedAt = page.data.startTimestamp;
  jump(125000);
  emitApp('hide', { reason: 3 });
  assert.equal(records.length, 0);
  emitApp('show'); page.onShow();
  assert.equal(page.data.isRunning, false);
  assert.equal(page.data.elapsedTime, 60);
  assert.equal(page.data.remainingTime, 0);
  assert.equal(page.pendingCompletion.duration, 1);
  assert.equal(page.pendingCompletion.endedAt, startedAt + 60000);
  assert.equal(storage.get('timerPendingEndReminder').sessionId, page.sessionId);
  assert.deepEqual(plays(), [END_AUDIO]);
});

test('foreground page unload saves either active mode once without a closing reminder on return', () => {
  for (const isCountdown of [true, false]) {
    for (const paused of [false, true]) {
      const h = createPage({ isCountdown, withGuide: true, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000);
      if (paused) h.page.pauseTimer();
      const sessionId = h.page.sessionId;
      const endedAt = h.now();
      const oldPlayers = [...h.players];
      h.page.onHide(); h.page.onUnload(); h.advance(30000);
      assert.ok(oldPlayers.every(player => player.destroyed));
      oldPlayers.forEach(player => { player.emitEnded(); player.emitError(); });
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 1);
      assert.equal(h.records[0][3], endedAt);
      assert.equal(h.records[0][4], sessionId);
      assert.ok(!h.storage.get('timerPendingEndReminder'));
      const fresh = h.recreatePage();
      assert.equal(fresh.data.isRunning, false);
      assert.equal(fresh.data.isPaused, false);
      assert.equal(fresh.pendingCompletion, null);
      assert.equal(h.plays().includes(END_AUDIO), false);
      h.page.onUnload(); h.recreatePage();
      assert.equal(h.records.length, 1);
    }
  }
});

test('failed automatic exit saves retain the original draft for an explicit retry without reviving timing or sound', async () => {
  for (const isCountdown of [true, false]) {
    for (const exit of ['page', 'app']) {
      for (const failure of ['throw', 'result']) {
        let allowSave = false;
        const attempts = [];
        const h = createPage({ isCountdown, withAppLifecycle: true, recordCheckin(...args) {
          attempts.push(args);
          if (allowSave) return { success: true };
          if (failure === 'throw') throw new Error('local storage temporarily unavailable');
          return { success: false };
        } });
        h.page.applyDuration(30); h.page.startTimer(); h.advance(125000);
        const sessionId = h.page.sessionId;
        const endedAt = h.now();
        if (exit === 'page') h.page.onUnload(); else h.emitApp('hide', { reason: 0 });
        assert.equal(h.records.length, 0);
        assert.equal(attempts.length, 1);
        const draft = h.storage.get('timerPendingCompletion');
        assert.equal(draft.sessionId, sessionId);
        assert.equal(draft.duration, 2);
        assert.equal(draft.endedAt, endedAt);
        assert.ok(!h.storage.get('timerPendingEndReminder'));
        h.page.onUnload(); h.advance(60000); h.emitApp('show');
        const fresh = h.recreatePage();
        assert.equal(fresh.data.isRunning, false);
        assert.equal(fresh.data.isPaused, false);
        assert.equal(fresh.pendingCompletion.sessionId, sessionId);
        assert.equal(h.plays().includes(END_AUDIO), false);
        allowSave = true;
        await fresh.confirmCompletion();
        assert.equal(h.records.length, 1);
        assert.equal(h.records[0][0], 2);
        assert.equal(h.records[0][3], endedAt);
        assert.equal(h.records[0][4], sessionId);
        assert.equal(h.storage.get('timerPendingCompletion'), null);
        h.emitApp('hide', { reason: 0 }); h.emitApp('show'); fresh.onShow();
        assert.equal(h.records.length, 1, 'later lifecycle callbacks cannot retry an already saved exit');
      }
    }
  }
});

test('a failed detached count-up exit retains its draft at the actual exit time for a single retry', async () => {
  let allowSave = false;
  const h = createPage({ isCountdown: false, withAppLifecycle: true,
    recordCheckin: () => ({ success: allowSave }) });
  h.page.startTimer(); h.advance(65000);
  const sessionId = h.page.sessionId;
  h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
  h.advance(60000);
  const endedAt = h.now();
  h.emitApp('hide', { reason: 1 });
  assert.equal(h.records.length, 0);
  assert.equal(h.storage.get('timerState'), null);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, sessionId);
  assert.equal(h.storage.get('timerPendingCompletion').duration, 2);
  assert.equal(h.storage.get('timerPendingCompletion').endedAt, endedAt);
  h.emitApp('hide', { reason: 1 }); h.emitApp('show');
  const fresh = h.recreatePage();
  allowSave = true;
  await fresh.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][4], sessionId);
  assert.equal(h.records[0][3], endedAt);
  fresh.onUnload(); h.recreatePage();
  assert.equal(h.records.length, 1);
  assert.equal(h.plays().includes(END_AUDIO), false);
});

test('detached count-up exit write failures cannot revive its old checkpoint or duplicate a saved record', async () => {
  for (const failure of ['draft-write', 'state-clear', 'draft-clear', 'all-writes']) {
    for (const savedInitially of [true, false]) {
      let failWrites = false;
      let allowRecord = savedInitially;
      const attempts = [];
      const h = createPage({ isCountdown: false, withAppLifecycle: true,
        storageFailure(key, value) {
          if (!failWrites) return false;
          if (failure === 'all-writes') return true;
          if (failure === 'draft-write') return key === 'timerPendingCompletion' && !!value;
          if (failure === 'draft-clear') return key === 'timerPendingCompletion' && value === null;
          return key === 'timerState' && value === null;
        },
        recordCheckin(...args) { attempts.push(args); return { success: allowRecord }; }
      });
      h.page.startTimer(); h.advance(65000);
      const sessionId = h.page.sessionId;
      h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
      h.advance(60000);
      const endedAt = h.now();
      failWrites = true;
      assert.doesNotThrow(() => h.emitApp('hide', { reason: 0 }));
      const terminal = h.application.getDetachedCountupExit(sessionId);
      assert.equal(terminal.saved, savedInitially);
      assert.equal(terminal.completion.duration, 2);
      assert.equal(terminal.completion.endedAt, endedAt);
      assert.equal(h.application._detachedCountupSessionId, null);
      assert.equal(attempts.length, 1);
      h.emitApp('hide', { reason: 0 });
      assert.equal(attempts.length, 1);
      assert.doesNotThrow(() => h.emitApp('show'));
      const fresh = h.recreatePage({ visible: false });
      assert.equal(fresh.data.isRunning, false);
      assert.equal(fresh.data.isPaused, false);
      assert.equal(h.records.length, savedInitially ? 1 : 0);
      if (savedInitially) assert.equal(fresh.pendingCompletion, null);
      else {
        assert.equal(fresh.pendingCompletion.sessionId, sessionId);
        assert.equal(fresh.pendingCompletion.duration, 2);
        assert.equal(fresh.pendingCompletion.endedAt, endedAt);
      }
      assert.equal(h.plays().includes(END_AUDIO), false);
      failWrites = false;
      fresh.onShow();
      if (!savedInitially) {
        allowRecord = true;
        await fresh.confirmCompletion();
      }
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 2);
      assert.equal(h.records[0][3], endedAt);
      assert.equal(h.records[0][4], sessionId);
      fresh.onUnload(); h.emitApp('show'); h.recreatePage();
      assert.equal(h.page.pendingCompletion, null);
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.records.length, 1);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
  }
});

test('either completion action stops an unfinished closing bell without replaying or resaving it', async () => {
  for (const isCountdown of [true, false]) {
    for (const action of ['confirmCompletion', 'confirmCompletionAndViewDaily']) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
      if (!isCountdown) h.page.handleStop();
      const closing = h.page.audioPlayer;
      assert.equal(closing.src, END_AUDIO);
      assert.equal(closing.paused, false);
      closing.currentTime = 3;
      const playsBeforeConfirmation = h.plays();
      await h.page[action]();
      assert.equal(closing.paused, true, 'confirmation must stop the current native bell');
      assert.equal(h.storage.get('timerPendingEndReminder'), null);
      assert.equal(h.records.length, 1);
      h.page.onShow(); h.emitApp('hide'); h.emitApp('show'); h.page.onShow();
      closing.emitEnded(); closing.emitError(); h.advance(10000);
      assert.deepEqual(h.plays(), playsBeforeConfirmation);
      assert.equal(h.records.length, 1);
      h.page.onUnload(); h.recreatePage();
      assert.deepEqual(h.plays(), playsBeforeConfirmation);
    }
  }
});

test('subminute explicit exits stop either mode without creating records or delayed reminders', () => {
  for (const isCountdown of [true, false]) {
    for (const reason of [0, 1]) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(2000);
      h.emitApp('hide', { reason }); h.page.onHide(); h.page.onUnload(); h.advance(30000);
      assert.equal(h.records.length, 0);
      assert.deepEqual(h.plays(), []);
      assert.ok(!h.storage.get('timerPendingEndReminder'));
      h.emitApp('show');
      const fresh = h.recreatePage();
      assert.equal(fresh.data.isRunning, false);
      assert.equal(fresh.data.isPaused, false);
      assert.equal(fresh.data.showCompletionDialog, false);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
  }
});

test('active page and app exits save actual minutes excluding completed and current pauses', () => {
  for (const isCountdown of [true, false]) {
    for (const exit of ['page', 'app']) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000); h.page.pauseTimer(); h.advance(90000);
      h.page.startTimer(); h.advance(60000); h.page.pauseTimer(); h.advance(30000);
      const sessionId = h.page.sessionId;
      if (exit === 'page') h.page.onUnload(); else h.emitApp('hide', { reason: 1 });
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 2);
      assert.equal(h.records[0][4], sessionId);
      h.advance(60000);
      if (exit === 'page') h.recreatePage(); else { h.emitApp('show'); h.page.onShow(); }
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.data.isPaused, false);
      assert.equal(h.records.length, 1);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
  }
});

test('leaving an already finished session stops its bell and automatically saves its reflection', async () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '保留这段静坐感受' } });
    const completion = structuredClone(h.storage.get('timerPendingCompletion'));
    const oldClosing = h.page.audioPlayer;
    oldClosing.currentTime = 8;
    h.page.onHide(); h.page.onUnload();
    assert.equal(h.records.length, 0, 'an existing reflection draft still requires confirmation');
    assert.deepEqual({ ...h.storage.get('timerPendingCompletion') }, completion);
    assert.equal(oldClosing.destroyed, true);
    const closing = h.players.findLast(player => !player.destroyed && player.src === END_AUDIO);
    assert.equal(closing, undefined, 'the App must not continue the unfinished closing cue');
    const playCount = h.plays().length;
    await new Promise(resolve => setImmediate(resolve));
    const fresh = h.recreatePage();
    assert.equal(fresh.data.showCompletionDialog, false);
    assert.equal(fresh.pendingCompletion, null);
    assert.equal(h.plays().length, playCount, 'an explicit page exit discards its unfinished closing reminder');
    await fresh.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][4], completion.sessionId);
    assert.equal(h.records[0][2][0].text, completion.text);
  }
});

test('exiting an already finished session with no reflection saves synchronously in either mode', () => {
  for (const isCountdown of [true, false]) {
    for (const exit of ['page', 0, 1]) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000); h.page.handleStop();
      const completion = { ...h.page.pendingCompletion };
      if (exit === 'page') h.page.onUnload();
      else h.emitApp('hide', { reason: exit });
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], completion.duration);
      assert.equal(h.records[0][3], completion.endedAt);
      assert.equal(h.records[0][4], completion.sessionId);
      assert.equal(h.storage.get('timerPendingCompletion'), null);
      h.page.onUnload(); h.emitApp('show');
      assert.equal(h.recreatePage().pendingCompletion, null);
      assert.equal(h.records.length, 1);
    }
  }
});

test('a rejected exit reflection stays available for a later explicit save', async () => {
  for (const isCountdown of [true, false]) {
    let allowed = false;
    const checks = [];
    const h = createPage({ isCountdown, checkText: async (...args) => { checks.push(args); return allowed; } });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '需要重新确认的感受' } });
    const completion = { ...h.page.pendingCompletion };
    h.page.onUnload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.records.length, 0);
    assert.deepEqual({ ...h.storage.get('timerPendingCompletion') }, completion);
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0].slice(0, 2), [completion.text, 2]);
    const fresh = h.recreatePage();
    assert.equal(fresh.data.showCompletionDialog, true);
    assert.equal(fresh.data.completionText, completion.text);
    allowed = true;
    await fresh.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][4], completion.sessionId);
  }
});

test('a returning page and the exit reflection check cannot save the same completion twice', async () => {
  for (const isCountdown of [true, false]) {
    let resolveCheck;
    const checked = new Promise(resolve => { resolveCheck = resolve; });
    const h = createPage({ isCountdown, checkText: () => checked });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '退出后马上回来确认' } });
    const sessionId = h.page.pendingCompletion.sessionId;
    h.page.onUnload();
    const fresh = h.recreatePage();
    const confirmation = fresh.confirmCompletion();
    resolveCheck(true);
    await confirmation;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][4], sessionId);
    assert.equal(h.storage.get('timerPendingCompletion'), null);
    assert.equal(fresh.pendingCompletion, null);
  }
});

test('a late exit reflection response cannot save or clear a newer completion draft', async () => {
  for (const isCountdown of [true, false]) {
    let resolveCheck;
    const checked = new Promise(resolve => { resolveCheck = resolve; });
    const h = createPage({ isCountdown, checkText: () => checked });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '旧静坐的感受' } });
    h.page.onUnload();
    const fresh = h.recreatePage();
    const newer = { sessionId: 'newer-completion', duration: 3, endedAt: h.now() + 180000, text: '新静坐的感受' };
    h.storage.set('timerPendingCompletion', newer);
    fresh.pendingCompletion = newer;
    fresh.setData({ completionDuration: newer.duration, completionText: newer.text });
    resolveCheck(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.records.length, 0, 'a stale approval cannot save the replacement draft');
    assert.deepEqual(h.storage.get('timerPendingCompletion'), newer);
    assert.equal(fresh.pendingCompletion, newer);
    assert.equal(fresh.data.completionText, newer.text);
  }
});

test('render failures cannot block either mode from saving once on an explicit page or app exit', () => {
  for (const isCountdown of [true, false]) {
    for (const exit of ['page', 'app']) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000);
      const sessionId = h.page.sessionId;
      h.page.setData = () => { throw new Error('native renderer unavailable'); };
      if (exit === 'app') assert.doesNotThrow(() => h.emitApp('hide', { reason: 0 }));
      assert.doesNotThrow(() => h.page.onUnload());
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], 1);
      assert.equal(h.records[0][4], sessionId);
      h.emitApp('show');
      const fresh = h.recreatePage();
      assert.equal(fresh.data.isRunning, false);
      assert.equal(fresh.pendingCompletion, null);
      assert.equal(h.plays().includes(END_AUDIO), false);
      assert.equal(h.records.length, 1);
    }
  }
});

test('App foreground recovery does not ring an old reminder for the active timer session', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(2000);
    const sessionId = h.page.sessionId;
    h.storage.set('timerPendingEndReminder', { sessionId });
    assert.equal(h.application._timerExitAudio, undefined);
    h.emitApp('show'); h.page.onShow();
    assert.equal(h.application._timerExitAudio, undefined, 'active timing cannot be claimed as an exit bell');
    assert.equal(h.page.sessionId, sessionId);
    assert.equal(h.page.data.isRunning, true);
    assert.equal(h.records.length, 0);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 0);
  }
});

test('a natural completion interrupted after three seconds resumes its page-owned bell in either hide order', () => {
  for (const pageHidesFirst of [true, false]) {
    const h = createPage({ withAppLifecycle: true });
    h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
    const closing = h.page.audioPlayer;
    closing.currentTime = 3;
    if (pageHidesFirst) h.page.onHide();
    h.emitApp('hide', { reason: 3 });
    if (!pageHidesFirst) h.page.onHide();
    assert.equal(closing.paused, true);
    assert.ok(h.storage.get('timerPendingEndReminder'));
    h.advance(30000);
    h.emitApp('show'); h.page.onShow();
    assert.equal(h.application._timerExitAudio, undefined, 'App foreground recovery leaves the visible page in control');
    assert.equal(h.page.audioPlayer, closing);
    assert.equal(closing.currentTime, 3);
    assert.equal(closing.paused, false);
    assert.equal(h.players.filter(player => !player.destroyed && !player.paused && player.src === END_AUDIO).length, 1);
    assert.equal(h.page.pendingCompletion.duration, 1);
    assert.equal(h.records.length, 0);
    closing.emitEnded();
    const playCount = h.plays().length;
    h.page.onShow(); h.emitApp('show'); h.page.onShow();
    assert.equal(h.plays().length, playCount);
  }
});

test('repeated passive page rebuilds cannot generate a closing bell or record for an active sit', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    for (let turn = 0; turn < 3; turn += 1) {
      h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload(); h.emitApp('show'); h.recreatePage(); h.page.onShow();
      assert.equal(h.page.sessionId, sessionId);
      assert.equal(h.page.data.isRunning, true);
    }
    assert.equal(h.records.length, 0);
    assert.equal(h.plays().includes(END_AUDIO), false);
    assert.ok(!h.storage.get('timerPendingEndReminder'));
  }
});

test('either completion action can retry a failed save with the original session id, timestamp and reflection', async () => {
  for (const action of ['confirmCompletion', 'confirmCompletionAndViewDaily']) {
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
    const pendingReminder = { ...storage.get('timerPendingEndReminder') };
    page.onCompletionInput({ detail: { value: '继续保留感受' } });
    await page[action]();
    assert.equal(page.data.showCompletionDialog, true);
    assert.equal(page.data.isSavingCompletion, false, 'a local write failure must release both save actions');
    assert.equal(page.data.isCompletionSaved, false);
    assert.equal(storage.get('timerPendingCompletion').text, '继续保留感受');
    assert.deepEqual({ ...storage.get('timerPendingEndReminder') }, pendingReminder,
      'a record-save failure cannot acknowledge or discard the unfinished closing reminder');
    assert.equal(toasts.at(-1).title, '保存失败，请重试');
    assert.deepEqual(navigations, [], 'a failed save must never open the daily page');
    advance(60000);
    await page[action]();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0][3], attempts[1][3]);
    assert.equal(attempts[0][4], attempts[1][4]);
    assert.equal(attempts[1][2][0].text, '继续保留感受');
    assert.deepEqual(navigations, action === 'confirmCompletion' ? [] : [dailyPathForRecord(attempts[1])]);
    page.onShow();
    assert.equal(page.data.showCompletionDialog, false);
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.equal(toasts.length, 1, 'successful retry adds no upload result notification');
  }
});

test('a cold count-up includes offline running time but excludes a manual pause before explicit completion', async () => {
  for (const isPaused of [false, true]) {
    const savedAt = Date.parse('2026-09-17T08:00:00+08:00');
    const h = createPage({ initialTime: savedAt + 60000, initialStorage: { timerState: {
      sessionId: 'timer_saved', isCountdown: false, isRunning: !isPaused, isPaused,
      elapsedTime: 125, totalTime: 1800, saveTime: savedAt, startTimestamp: savedAt - 155000,
      totalPausedTime: 30000, pauseTimestamp: isPaused ? savedAt : 0
    } } });
    assert.equal(h.records.length, 0);
    assert.equal(h.page.data.isRunning, !isPaused);
    assert.equal(h.page.data.isPaused, isPaused);
    assert.equal(h.page.data.elapsedTime, isPaused ? 125 : 185);
    h.advance(60000); h.page.startTimer(); h.advance(1000);
    assert.equal(h.page.data.elapsedTime, isPaused ? 126 : 246);
    h.page.handleStop(); await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], isPaused ? 2 : 4);
    assert.equal(h.records[0][4], 'timer_saved');
  }
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

test('either timer mode can start a fresh session immediately after completing without navigation', async () => {
  for (const isCountdown of [true, false]) {
    const { page, advance, records, navigations, storage } = createPage({ isCountdown });
    page.startTimer();
    const firstId = page.sessionId;
    advance(60000);
    page.handleStop();
    page.onCompletionInput({ detail: { value: '已结束' } });
    await page.confirmCompletion();
    assert.deepEqual(navigations, []);
    assert.equal(page.data.showCompletionDialog, false);
    assert.equal(page.data.completionText, '');
    assert.equal(page.data.isSavingCompletion, false);
    assert.equal(page.data.isCompletionSaved, false);
    assert.equal(page.pendingCompletion, null);
    assert.equal(storage.get('timerPendingCompletion'), null);
    assert.equal(records.length, 1);
    assert.equal(records[0][2][0].text, '已结束');
    page.startTimer();
    assert.equal(page.data.isRunning, true, 'the next session must not need an onShow cleanup');
    assert.notEqual(page.sessionId, firstId);
    assert.equal(page.data.elapsedTime, 0);
    assert.equal(page.data.showStopButton, true);
    assert.equal(page.data.showResetButton, true);
    assert.equal(records.length, 1);
  }
});

test('opening the timer selects the first recommendation in its saved order, even when 30 remains available', () => {
  for (const durations of [[20, 7, 10], [60, 30, 7], ['15', 0, 'invalid', 10, 15, 181]]) {
    const { page } = createPage({ initialStorage: { timerRecommendedDurations: durations } });
    const first = Number(durations[0]);
    assert.equal(page.data.duration, first);
    assert.equal(page.data.durationText, `${first} 分钟`);
    assert.equal(page.data.totalTime, first * 60);
    assert.equal(page.data.remainingTime, first * 60);
    assert.equal(page.data.displayTime, `${String(first).padStart(2, '0')}:00`);
    page.startTimer();
    assert.equal(page.data.totalTime, first * 60);
  }
});

test('an empty recommendation list remains empty and custom durations still work', () => {
  const { page } = createPage({ initialStorage: { timerRecommendedDurations: [] } });
  assert.equal(page.data.timeOptions.length, 0);
  assert.equal(page.data.duration, 7);
  page.applyDuration(42);
  assert.equal(page.data.displayTime, '42:00');
});

test('removing the selected recommendation updates an idle timer but keeps an explicit custom duration', () => {
  const { page } = createPage({ initialStorage: { timerRecommendedDurations: [10, 30, 60] } });
  page.applyDuration(30);
  page.removeRecommendedDuration({ currentTarget: { dataset: { value: 30 } } });
  assert.equal(page.data.duration, 10);
  assert.equal(page.data.totalTime, 600);
  assert.equal(page.data.remainingTime, 600);
  assert.equal(page.data.displayTime, '10:00');
  page.applyDuration(42);
  page.removeRecommendedDuration({ currentTarget: { dataset: { value: 10 } } });
  assert.equal(page.data.duration, 42);
});

test('moving recommendations in either direction persists their order and respects the ends of the list', () => {
  const { page, storage } = createPage({ initialStorage: { timerRecommendedDurations: [10, 30, 60] } });
  page.showTimePicker();
  page.toggleDurationEditing();
  const move = (value, offset) => page.moveRecommendedDuration({ currentTarget: { dataset: { value, offset } } });
  move(30, -1);
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [30, 10, 60]);
  move(10, 1);
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [30, 60, 10]);
  move(30, -1);
  move(10, 1);
  move(99, 1);
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [30, 60, 10]);
  assert.equal(page.data.showTimePicker, true);
  assert.equal(page.data.editingDurations, true);
  const reopened = createPage({ initialStorage: Object.fromEntries(storage) }).page;
  assert.deepEqual(Array.from(reopened.data.timeOptions, item => item.value), [30, 60, 10]);
  assert.equal(reopened.data.duration, 30);
});

test('editing and adding recommendations preserve manual order without duplicating durations', () => {
  const { page, storage } = createPage({ initialStorage: { timerRecommendedDurations: [60, 10, 30] } });
  page.editRecommendedDuration({ currentTarget: { dataset: { value: 10 } } });
  page.onCustomTimeInput({ detail: { value: '15' } });
  page.confirmCustomTime();
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [60, 15, 30]);
  page.addRecommendedDuration();
  page.onCustomTimeInput({ detail: { value: '7' } });
  page.confirmCustomTime();
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [60, 15, 30, 7]);
  page.editRecommendedDuration({ currentTarget: { dataset: { value: 30 } } });
  page.onCustomTimeInput({ detail: { value: '60' } });
  page.confirmCustomTime();
  assert.deepEqual(Array.from(storage.get('timerRecommendedDurations')), [15, 60, 7]);
});

test('recommended durations can be added, edited, removed, reordered and restored without changing a running session', () => {
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
  page.toggleDurationEditing();
  page.moveRecommendedDuration({ currentTarget: { dataset: { value: 60, offset: -1 } } });
  assert.equal(page.data.duration, 7);
  assert.equal(page.data.totalTime, 420);
  assert.equal(page.data.elapsedTime, 10);
  assert.equal(page.data.isRunning, true);
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


test('reopening an expired countdown completes at its original deadline and saves only once', async () => {
  const startTimestamp = Date.parse('2026-09-18T01:59:00+08:00');
  const { page, records, plays } = createPage({ initialStorage: {
    timerState: {
      sessionId: 'timer_countdown', isCountdown: true, isRunning: true, isPaused: false,
      elapsedTime: 30, totalTime: 60, saveTime: startTimestamp + 30000, startTimestamp,
      totalPausedTime: 0, pauseTimestamp: 0
    }
  } });
  assert.equal(page.data.isRunning, false);
  assert.equal(page.data.isPaused, false);
  assert.equal(page.data.showStopButton, false);
  assert.equal(page.data.showCompletionDialog, true);
  assert.equal(page.data.elapsedTime, 60);
  assert.equal(page.data.remainingTime, 0);
  assert.equal(page.pendingCompletion.endedAt, startTimestamp + 60000);
  assert.deepEqual(plays(), [END_AUDIO]);
  await page.confirmCompletion(); await page.confirmCompletion();
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 1);
  assert.equal(records[0][3], startTimestamp + 60000);
});


test('a cold running count-up continues without an obsolete interruption or saved-record notice', () => {
  const h = createPage({ isCountdown: false });
  h.page.startTimer(); h.advance(60000); h.emitApp('hide', { reason: 3 });
  const reopened = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 60000 });
  assert.equal(reopened.records.length, 0);
  assert.equal(reopened.page.data.isPaused, false);
  assert.equal(reopened.page.data.isRunning, true);
  assert.equal(reopened.page.data.elapsedTime, 120);
  assert.ok(reopened.toasts.every(item => !/点击继续|已存本机/.test(item.title)));
  const count = reopened.toasts.length;
  reopened.page.onShow(); assert.equal(reopened.toasts.length, count);
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

test('a delayed count-up caps at its 24-hour deadline during foreground reconciliation or explicit exit', async () => {
  for (const action of ['updateForegroundTimer', 'syncTimerTime', 'appHide']) {
    const h = createPage({ isCountdown: false });
    h.page.startTimer(); const startedAt = h.page.data.startTimestamp;
    h.jump(90000000);
    if (action === 'appHide') {
      h.emitApp('hide');
      assert.equal(h.records.length, 1);
      assert.equal(h.page.data.isRunning, false);
      h.emitApp('show'); h.page.onShow();
    } else h.page[action]();
    await h.page.confirmCompletion();
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 1440);
    assert.equal(h.records[0][3], startedAt + 86400000);
  }
});

test('foreground ticker loss and corrupted display recover without restarting or short records', async () => {
  const h = createPage();
  h.page.applyDuration(30);
  h.page.startTimer();
  const sessionId = h.page.sessionId;
  h.advance(65000);
  const ticker = [...h.timers].find(([, task]) => task.interval && task.delay === 1000);
  assert.ok(ticker);
  h.timers.delete(ticker[0]);
  h.page.setData({ isRunning: false, remainingTime: 0, displayTime: '00:00' });
  h.advance(5000);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.page.data.remainingTime, 1730);
  assert.equal(h.page.sessionId, sessionId);
  assert.equal(h.records.length, 0);
  assert.deepEqual(h.plays(), [START_AUDIO]);
  h.advance(1730000);
  assert.equal(h.page.pendingCompletion.duration, 30);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  await h.page.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][4], sessionId);
});

test('an unexplained early finish is rejected but the explicit stop still works', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown });
    h.page.applyDuration(30); h.page.startTimer(); h.advance(125000);
    const sessionId = h.page.sessionId;
    for (const reason of ['unknown', 'unexpected_callback', 'timeout', 'deadline']) {
      h.page.finishSession(125, { reason });
    }
    h.page.handleTimerFinished();
    // Repeated framework and native callbacks before the real deadline are not
    // completion signals, even when their delivery order changes.
    for (let repeat = 0; repeat < 3; repeat += 1) {
      h.countdown.tick(); h.page.onShow();
      h.emitAudio('begin'); h.emitApp('hide', { reason: 3 });
      h.emitApp('hide', { reason: 3 }); h.page.onHide();
      h.emitApp('show'); h.page.onShow(); h.emitAudio('end'); h.emitAudio('end');
    }
    assert.equal(h.page.data.isRunning, true);
    assert.equal(h.page.sessionId, sessionId);
    assert.equal(h.page.calculateElapsedTime(), 125);
    assert.equal(h.records.length, 0);
    assert.equal(h.page.pendingCompletion, null);
    assert.ok(!h.storage.get('timerPendingEndReminder'));
    assert.equal(h.plays().includes(END_AUDIO), false);
    h.page.handleStop();
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.page.pendingCompletion.duration, 2);
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  }
});

test('foreground countdown exits save once even when resource cleanup throws', () => {
  const h = createPage({ withAppLifecycle: true });
  h.page.startTimer(); h.advance(125000);
  const sessionId = h.page.sessionId;
  h.page.stopBackgroundMusic = () => { throw new Error('native stop failed'); };
  h.page.restoreScreenSettings = () => { throw new Error('native brightness failed'); };
  h.page.onUnload();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 2);
  assert.equal(h.records[0][4], sessionId);
  h.emitApp('hide'); h.emitApp('hide'); h.emitApp('show');
  const fresh = h.recreatePage(); h.advance(10000);
  assert.equal(fresh.data.isRunning, false);
  assert.equal(fresh.pendingCompletion, null);
  assert.equal(h.records.length, 1);
  assert.equal(h.plays().includes(END_AUDIO), false);
});

test('a pause arriving at the deadline cannot revive the completed countdown', () => {
  const h = createPage();
  h.page.applyDuration(1); h.page.startTimer(); h.jump(60000);
  h.page.pauseTimer();
  assert.equal(h.page.data.isRunning, false);
  assert.equal(h.page.data.isPaused, false);
  assert.equal(h.page.pendingCompletion.duration, 1);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
});

test('a failed display update does not block completion or repeat its sound on return', () => {
  const h = createPage();
  h.page.applyDuration(1); h.page.startTimer(); h.advance(59000);
  const setData = h.page.setData;
  let failed = false;
  h.page.setData = function(values) {
    if (!failed && 'elapsedTime' in values) { failed = true; throw new Error('one frame failed'); }
    setData.call(this, values);
  };
  h.advance(1000);
  assert.equal(h.page.pendingCompletion.duration, 1);
  h.page.onShow();
  assert.equal(h.page.data.isRunning, false);
  assert.equal(h.page.data.showCompletionDialog, true);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
});

test('a completed reflection automatically saves on exit before page recreation within the same App runtime', async () => {
  const h = createPage();
  h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
  const completion = { ...h.page.pendingCompletion };
  h.page.onCompletionInput({ detail: { value: '保留这段感受' } });
  h.page.audioPlayer.emitEnded();
  h.page.saveDurationOptions([20, 7, 10]);
  h.page.onUnload();
  await new Promise(resolve => setImmediate(resolve));
  const fresh = h.recreatePage();
  assert.equal(fresh.data.duration, 20);
  assert.equal(fresh.data.showCompletionDialog, false);
  assert.equal(fresh.pendingCompletion, null);
  await fresh.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 1);
  assert.equal(h.records[0][3], completion.endedAt);
  assert.equal(h.records[0][4], completion.sessionId);
  assert.equal(h.records[0][2][0].text, '保留这段感受');
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
});

test('a cold countdown continues without asking the user to resume it', () => {
  const startTimestamp = Date.parse('2026-09-18T07:00:00+08:00');
  const h = createPage({ initialTime: startTimestamp + 185000, initialStorage: { timerState: {
    sessionId: 'cold-notice', isCountdown: true, isRunning: true, isPaused: false,
    elapsedTime: 125, totalTime: 1800, saveTime: startTimestamp + 125000,
    startTimestamp, totalPausedTime: 0, pauseTimestamp: 0
  } } });
  assert.equal(h.records.length, 0);
  assert.equal(h.page.data.isPaused, false);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.page.data.elapsedTime, 185);
  assert.deepEqual(h.toasts.map(item => item.title), []);
  h.page.onShow(); h.advance(1000);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.page.data.elapsedTime, 186);
});


test('a cancelled countdown cannot restore its discarded progress after page recreation', () => {
  const h = createPage();
  h.page.startTimer(); h.advance(125000); h.page.resetTimer(); h.page.onUnload();
  const fresh = h.recreatePage();
  assert.equal(fresh.data.elapsedTime, 0);
  assert.equal(fresh.data.remainingTime, fresh.data.totalTime);
  assert.equal(fresh.data.isRunning, false);
  assert.equal(fresh.data.isPaused, false);
  assert.equal(h.records.length, 0);
});

for (const restart of ['page recreation', 'cold startup']) {
  test(`settled countdowns use current recommendations after ${restart}`, async () => {
    for (const ending of ['timeout', 'manual', 'app hide', 'under one minute']) {
      const h = createPage();
      h.page.applyDuration(ending === 'timeout' ? 1 : 7);
      h.page.startTimer();
      const oldSessionId = h.page.sessionId;
      h.advance(ending === 'timeout' ? 60000 : ending === 'under one minute' ? 30000 : 65000);
      if (ending === 'app hide') {
        h.emitApp('hide');
        h.emitApp('show');
        h.page.onShow();
        h.page.handleStop();
        await h.page.confirmCompletion();
      } else {
        if (ending !== 'timeout') h.page.handleStop();
        await h.page.confirmCompletion();
      }
      h.page.onShow();
      const savedRecords = ending === 'under one minute' ? 0 : 1;
      assert.equal(h.records.length, savedRecords, ending);
      assert.equal(h.page.pendingCompletion, null, ending);
      h.page.saveDurationOptions([20, 7, 10]);
      h.page.onUnload();
      const reopened = restart === 'cold startup'
        ? createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)) }) : h;
      const fresh = restart === 'cold startup' ? reopened.page : h.recreatePage();

      assert.equal(fresh.data.duration, 20, ending);
      assert.equal(fresh.data.displayTime, '20:00', ending);
      assert.equal(fresh.data.elapsedTime, 0, ending);
      assert.equal(fresh.data.isRunning, false, ending);
      assert.equal(fresh.data.isPaused, false, ending);
      assert.equal(fresh.data.showCompletionDialog, false, ending);
      assert.equal(reopened.records.length, restart === 'cold startup' ? 0 : savedRecords, ending);
      const playsBeforeStart = reopened.plays().length;
      fresh.startTimer();
      assert.notEqual(fresh.sessionId, oldSessionId, ending);
      assert.equal(fresh.data.isRunning, true, ending);
      assert.equal(reopened.countdown.getSnapshot().totalTime, 1200, ending);
      assert.equal(reopened.plays().length, playsBeforeStart, 'the new opening cue still waits five seconds');
    }
  });
}

test('a paused countdown keeps its session when recommendations change before page recreation', () => {
  const h = createPage();
  h.page.startTimer(); h.advance(65000); h.page.pauseTimer();
  const sessionId = h.page.sessionId;
  h.page.saveDurationOptions([20, 7, 10]);
  h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload(); h.advance(30000);
  h.emitApp('show');
  const fresh = h.recreatePage();
  assert.equal(fresh.sessionId, sessionId);
  assert.equal(fresh.data.duration, 7);
  assert.equal(fresh.data.isPaused, true);
  assert.equal(fresh.data.elapsedTime, 65);
  assert.equal(fresh.data.remainingTime, 355);
  fresh.startTimer(); h.advance(1000);
  assert.equal(fresh.sessionId, sessionId);
  assert.equal(fresh.data.elapsedTime, 66);
  assert.equal(h.records.length, 0);
});

test('manual countdown completion saves on exit and retains its reset display on recreation', () => {
  const h = createPage();
  h.page.startTimer(); h.advance(125000); h.page.handleStop();
  h.page.onShow();
  assert.equal(h.page.data.elapsedTime, 0);
  assert.equal(h.page.data.remainingTime, h.page.data.totalTime);
  h.page.audioPlayer.emitEnded();
  h.page.onUnload();
  const fresh = h.recreatePage();
  assert.equal(fresh.data.elapsedTime, 0);
  assert.equal(fresh.pendingCompletion, null);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 2);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
});

test('exit-saved completions keep both dialog actions usable when the same timer page returns', async () => {
  for (const isCountdown of [true, false]) {
    for (const action of ['confirmCompletion', 'confirmCompletionAndViewDaily']) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(65000); h.page.handleStop();
      const completionId = h.page.pendingCompletion.sessionId;
      h.emitApp('hide', { reason: 0 }); h.emitApp('show'); h.page.onShow();

      assert.equal(h.page.pendingCompletion, null);
      assert.equal(h.page.data.showCompletionDialog, true);
      assert.equal(h.page.data.isCompletionSaved, true);
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][4], completionId);
      await h.page[action]();
      assert.deepEqual(h.navigations, action === 'confirmCompletion' ? [] : [dailyPathForRecord(h.records[0])]);
      h.page.onShow();
      assert.equal(h.page.data.showCompletionDialog, false);
      assert.equal(h.records.length, 1, 'using either action cannot save the exit-settled sitting twice');
      h.page.startTimer();
      assert.equal(h.page.data.isRunning, true);
    }
  }
});

test('a reflection saved by the exit check after returning keeps both dialog actions usable', async () => {
  for (const isCountdown of [true, false]) {
    for (const action of ['confirmCompletion', 'confirmCompletionAndViewDaily']) {
      let finishCheck;
      const h = createPage({ isCountdown, withAppLifecycle: true,
        checkText: () => new Promise(resolve => { finishCheck = resolve; }) });
      h.page.startTimer(); h.advance(65000); h.page.handleStop();
      h.page.onCompletionInput({ detail: { value: '平静地结束' } });
      h.emitApp('hide', { reason: 0 });
      await Promise.resolve();
      h.emitApp('show'); h.page.onShow();
      assert.equal(h.page.data.isCompletionSaved, false);
      finishCheck(true);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

      assert.equal(h.page.pendingCompletion, null);
      assert.equal(h.page.data.isCompletionSaved, true);
      assert.equal(h.page.data.showCompletionDialog, true);
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][2][0].text, '平静地结束');
      await h.page[action]();
      assert.deepEqual(h.navigations, action === 'confirmCompletion' ? [] : [dailyPathForRecord(h.records[0])]);
      h.page.onShow();
      assert.equal(h.page.data.showCompletionDialog, false);
      assert.equal(h.records.length, 1);
    }
  }
});

test('a late exit reflection check cannot mark a replacement completion as saved', async () => {
  for (const isCountdown of [true, false]) {
    const checks = [];
    const h = createPage({ isCountdown, withAppLifecycle: true,
      checkText: () => new Promise(resolve => { checks.push(resolve); }) });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '第一次感受' } });
    h.emitApp('hide', { reason: 0 });
    await Promise.resolve();
    h.emitApp('show'); h.page.onShow();
    const confirm = h.page.confirmCompletion();
    checks[1](true);
    await confirm;
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    h.page.onCompletionInput({ detail: { value: '第二次感受' } });
    const replacementId = h.page.pendingCompletion.sessionId;
    checks[0](true);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    assert.equal(h.records.length, 1);
    assert.equal(h.page.pendingCompletion.sessionId, replacementId);
    assert.equal(h.storage.get('timerPendingCompletion').sessionId, replacementId);
    assert.equal(h.page.data.completionText, '第二次感受');
    assert.equal(h.page.data.showCompletionDialog, true);
    assert.equal(h.page.data.isCompletionSaved, false);
  }
});

test('an explicit exit saves a paused countdown once even when its page cannot render', () => {
  const h = createPage({ withAppLifecycle: true });
  h.page.startTimer(); h.advance(65000); h.page.pauseTimer(); h.advance(120000);
  const sessionId = h.page.sessionId;
  const setData = h.page.setData;
  h.page.setData = () => { throw new Error('render interrupted during exit'); };
  h.emitApp('hide', { reason: 0 }); h.page.setData = setData;
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 1);
  assert.equal(h.records[0][4], sessionId);
  h.page.onUnload(); h.emitApp('show');
  const fresh = h.recreatePage();
  assert.equal(fresh.data.isRunning, false);
  assert.equal(fresh.data.isPaused, false);
  assert.equal(fresh.pendingCompletion, null);
  assert.equal(h.records.length, 1);
  assert.equal(h.plays().includes(END_AUDIO), false);
});

test('an old countdown terminal state cannot hide a newer count-up completion draft', async () => {
  let allowed = false;
  const h = createPage({ checkText: async () => allowed });
  h.page.startTimer(); h.advance(65000); h.page.handleStop();
  await h.page.confirmCompletion(); h.page.onShow();
  h.page.toggleMode({ detail: { value: false } });
  h.page.startTimer(); h.advance(125000); h.page.handleStop();
  const completionId = h.page.pendingCompletion.sessionId;
  h.page.onCompletionInput({ detail: { value: '正计时感受' } });
  h.page.onUnload();
  const fresh = h.recreatePage();
  assert.equal(fresh.pendingCompletion.sessionId, completionId);
  assert.equal(fresh.data.completionText, '正计时感受');
  allowed = true;
  await fresh.confirmCompletion();
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1][4], completionId);
  assert.equal(h.records[1][2][0].text, '正计时感受');
});

test('repeated native render failures are throttled without stopping the countdown', () => {
  const h = createPage();
  h.page.startTimer();
  h.page.setData = () => { throw new Error('same render failure'); };
  h.advance(29000);
  assert.equal(h.countdown.getSnapshot().isRunning, true);
  const faults = h.storage.get('timerDiagnostics').filter(item => item.type === 'render_countdown_error');
  assert.equal(faults.length, 1);
});

test('a countdown finishing during interrupted page reconstruction announces once on reattach', () => {
  const h = createPage();
  h.page.applyDuration(1); h.page.startTimer(); h.advance(59000); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
  h.advance(1000);
  h.emitApp('show');
  assert.equal(h.countdown.getSnapshot().status, 'completed');
  const fresh = h.recreatePage();
  assert.equal(fresh.data.showCompletionDialog, true);
  assert.equal(fresh.pendingCompletion.duration, 1);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  fresh.audioPlayer.emitEnded();
  fresh.onUnload(); h.recreatePage();
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
});

test('leaving the app retains the pending completion cue until it can ring on return', () => {
  const h = createPage();
  h.page.applyDuration(1); h.page.startTimer(); h.advance(59000); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
  h.advance(1000); h.emitApp('hide', { reason: 3 }); h.emitApp('show');
  const fresh = h.recreatePage();
  assert.equal(fresh.pendingCompletion.duration, 1);
  assert.equal(fresh.data.showCompletionDialog, true);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  fresh.audioPlayer.emitEnded();
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
});

test('a completed countdown restores its full ring and selected time through confirmation, return and the next start', async () => {
  for (const changeDuration of [false, true]) {
    const h = createPage();
    let selectedTime = '01:00';
    const fullRing = () => {
      assert.equal(h.page.data.progressAngleLeft, 0);
      assert.equal(h.page.data.progressAngleRight, 0);
      assert.equal(h.page.data.isProgressAnimating, false);
      assert.equal(h.page.data.displayTime, selectedTime);
    };
    h.page.applyDuration(1);
    h.page.startTimer();
    const sessionId = h.page.sessionId;
    h.advance(60000);
    fullRing();
    assert.equal(h.countdown.getSnapshot().elapsedTime, 60);
    assert.equal(h.countdown.getSnapshot().remainingTime, 0);
    assert.equal(h.page.pendingCompletion.duration, 1);
    h.page.onShow();
    fullRing();
    await h.page.confirmCompletion();
    h.page.onShow();
    fullRing();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 1);
    assert.equal(h.records[0][4], sessionId);
    if (changeDuration) {
      h.page.selectDuration({ currentTarget: { dataset: { value: 10 } } });
      selectedTime = '10:00';
    }
    fullRing();
    h.page.startTimer();
    fullRing();
    assert.equal(h.page.data.isRunning, true);
    assert.notEqual(h.page.sessionId, sessionId);
    h.advance(1000);
    assert.ok(h.page.data.progressAngleLeft < 0);
    assert.equal(h.page.data.isProgressAnimating, true);
  }
});

test('manual stops, resets and explicit exits restore idle displays without changing their save policy', () => {
  for (const isCountdown of [true, false]) {
    for (const ending of ['manual', 'reset', 'app exit', 'delayed app exit']) {
      const h = createPage({ isCountdown });
      h.page.startTimer(); h.advance(125000);
      if (ending === 'manual') { h.page.pauseTimer(); h.page.handleStop(); }
      else if (ending === 'reset') h.page.resetTimer();
      else {
        if (ending === 'delayed app exit') h.jump(600000);
        h.emitApp('hide'); h.emitApp('show');
      }
      h.page.onShow();
      const automatic = ending.includes('app exit');
      assert.equal(h.records.length, automatic ? 1 : 0);
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.data.isPaused, false);
      assert.equal(h.page.data.progressAngleLeft, 0);
      assert.equal(h.page.data.progressAngleRight, 0);
      assert.equal(h.page.data.displayTime, isCountdown ? '07:00' : '00:00');
      if (ending === 'manual') assert.equal(h.page.pendingCompletion.duration, 2);
      if (automatic) {
        const duration = ending === 'app exit' ? 2 : isCountdown ? 7 : 12;
        assert.equal(h.records[0][0], duration);
        assert.ok(!h.storage.get('timerPendingEndReminder'));
      }
    }
  }
});

test('only countdown ticks animate the ring; pause, resume and page restore retain its progress', () => {
  const h = createPage();
  h.page.startTimer();
  assert.equal(h.page.data.isProgressAnimating, false);
  h.advance(125000);
  const angles = [h.page.data.progressAngleLeft, h.page.data.progressAngleRight];
  assert.ok(angles[0] < 0);
  assert.equal(h.page.data.isProgressAnimating, true);
  h.page.pauseTimer();
  h.advance(30000);
  assert.deepEqual([h.page.data.progressAngleLeft, h.page.data.progressAngleRight], angles);
  assert.equal(h.page.data.displayTime, '04:55');
  assert.equal(h.page.data.isProgressAnimating, false);
  h.page.startTimer();
  assert.deepEqual([h.page.data.progressAngleLeft, h.page.data.progressAngleRight], angles);
  assert.equal(h.page.data.displayTime, '04:55');
  assert.equal(h.page.data.isProgressAnimating, false);
  h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload(); h.emitApp('show');
  const fresh = h.recreatePage();
  assert.deepEqual([fresh.data.progressAngleLeft, fresh.data.progressAngleRight], angles);
  assert.equal(fresh.data.displayTime, '04:55');
  assert.equal(fresh.data.isProgressAnimating, false);
  h.advance(1000);
  assert.ok(fresh.data.progressAngleLeft < angles[0]);
  assert.equal(fresh.data.displayTime, '04:54');
  assert.equal(fresh.data.isProgressAnimating, true);
});

test('manual pause during an audio interruption preserves the remaining five-second preparation', () => {
  for (const isCountdown of [true, false]) {
    for (const interruptedRunningTime of [2000, 4000]) {
      for (const endBeforeResume of [true, false]) {
        const h = createPage({ isCountdown });
        h.page.startTimer();
        h.advance(2000);
        h.emitAudio('begin');
        h.advance(interruptedRunningTime);
        h.page.pauseTimer();
        h.advance(10000);
        if (endBeforeResume) h.emitAudio('end');
        assert.deepEqual(h.plays(), [], 'the opening cue stays silent throughout the manual pause');
        assert.equal(h.page.calculateElapsedTime(), (2000 + interruptedRunningTime) / 1000);

        h.page.startTimer();
        if (!endBeforeResume) h.emitAudio('end');
        const remaining = Math.max(0, 5000 - 2000 - interruptedRunningTime);
        if (remaining) {
          h.advance(remaining - 1);
          assert.deepEqual(h.plays(), [], 'the opening cue still waits for five cumulative running seconds');
          h.advance(1);
        } else h.advance(0);
        assert.deepEqual(h.plays(), [START_AUDIO], 'running time during the interruption counts toward preparation');
        h.advance(5000);
        assert.deepEqual(h.plays(), [START_AUDIO], 'the opening cue only plays once');
      }
    }
  }
});


test('a failed closing cue rebuilds once and later sittings sound without reopening the app', async () => {
  for (const isCountdown of [true, false]) {
    let failedContext;
    const h = createPage({ isCountdown, audioBehavior: (player, src) => {
      if (src === END_AUDIO && !failedContext) failedContext = player;
      return src === END_AUDIO && player === failedContext ? 'error' : 'play';
    } });
    h.page.setData({ totalTime: 60, remainingTime: 60 });
    h.page.startTimer(); h.advance(5000);
    h.page.audioPlayer.emitEnded();
    const sessionId = h.page.sessionId;
    h.advance(55000);
    if (!isCountdown) h.page.handleStop();
    assert.equal(failedContext.destroyed, true, 'the failed native context is discarded immediately');
    assert.equal(h.page.pendingCompletion.duration, 1);
    assert.equal(h.page.pendingCompletion.sessionId, sessionId);
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.records.length, 0, 'audio repair cannot save or repeat a completion');
    h.advance(150);
    const recovered = h.page.audioPlayer;
    assert.notEqual(recovered, failedContext);
    assert.equal(recovered.src, END_AUDIO);
    assert.equal(recovered.paused, false);
    await h.page.confirmCompletion();
    h.page.startTimer(); h.advance(5000);
    assert.equal(h.page.audioPlayer.src, START_AUDIO);
    assert.equal(h.page.audioPlayer.paused, false);
    h.page.handleStop();
    assert.equal(h.page.audioPlayer.src, END_AUDIO);
    assert.equal(h.page.audioPlayer.paused, false);
    assert.equal(h.records.length, 1);
  }
});

test('silent native playback is repaired without altering the deadline or starting guidance early', () => {
  for (const isCountdown of [true, false]) {
    let silentContext;
    const h = createPage({ isCountdown, withGuide: true,
      audioBehavior: player => player === silentContext ? 'silent' : 'play' });
    silentContext = h.page.audioPlayer;
    h.page.startTimer();
    const startedAt = h.page.data.startTimestamp;
    h.advance(5000);
    assert.equal(h.page.backgroundMusicPlayer, null);
    h.advance(2650);
    assert.equal(silentContext.destroyed, true);
    assert.notEqual(h.page.audioPlayer, silentContext);
    assert.equal(h.page.audioPlayer.paused, false);
    assert.equal(h.page.data.startTimestamp, startedAt);
    assert.equal(h.page.data.elapsedTime, 7);
    assert.equal(h.page.backgroundMusicPlayer, null);
    h.page.audioPlayer.emitEnded();
    assert.equal(h.page.backgroundMusicPlayer.src, GUIDE_AUDIO);
    assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 1);
    assert.equal(h.records.length, 0);
  }
});

test('Huawei opening progress that freezes near zero cannot replay the bell five seconds later', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true, modernAudio: true });
    h.page.startTimer();
    const sessionId = h.page.sessionId;
    const startedAt = h.page.data.startTimestamp;
    h.advance(4999);
    assert.deepEqual(h.plays(), [], 'the opening still waits for five seconds of preparation');
    h.advance(1);
    const opening = h.page.audioPlayer;
    assert.deepEqual(h.plays(), [START_AUDIO]);
    opening.emitProgress(0.01);

    h.advance(5150);
    assert.deepEqual(h.plays(), [START_AUDIO], 'stale native progress must not replay an already-started bell');
    assert.equal(h.page.audioPlayer, opening, 'the active opening decoder remains owned until it ends');
    assert.equal(opening.destroyed, false);
    assert.equal(h.page.backgroundMusicPlayer, null, 'uncertain progress must not start guidance over the bell');
    assert.equal(h.page.sessionId, sessionId);
    assert.equal(h.page.data.startTimestamp, startedAt);
    assert.equal(h.page.data.elapsedTime, 10);

    h.advance(5000);
    opening.emitProgress(10.157);
    opening.emitNativeEnded();
    opening.emitNativeEnded();
    assert.deepEqual(h.plays(), [START_AUDIO, GUIDE_AUDIO], 'natural completion starts guidance exactly once');
    const completions = h.storage.get('timerDiagnostics')
      .filter(event => event.type === 'cue_completed' && event.src === START_AUDIO);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].failed, false, 'normal Ended must succeed rather than consume a failed opening');
    assert.equal(h.page.openingReminderCompleted, true);
    assert.equal(h.storage.get('timerSessionAudio').openingReminderCompleted, true);
    assert.equal(h.records.length, 0, 'opening playback never completes or saves the sitting');
    h.page.onUnload();
  }
});

test('Huawei opening with no progress or Ended expires once without owing another opening bell', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true, modernAudio: true });
    h.page.startTimer();
    h.advance(5000);
    const opening = h.page.audioPlayer;
    opening.emitProgress(0);

    h.advance(12999);
    assert.deepEqual(h.plays(), [START_AUDIO], 'missing progress cannot trigger a second audible opening');
    assert.equal(opening.destroyed, false);
    assert.equal(h.page.backgroundMusicPlayer, null, 'guidance waits for the bounded opening playback window');
    h.advance(1);
    assert.equal(opening.destroyed, true, 'a missing Ended must not keep the native decoder alive indefinitely');
    assert.deepEqual(h.plays(), [START_AUDIO, GUIDE_AUDIO]);
    assert.equal(h.page.currentSessionSound, null);
    assert.equal(h.page.openingReminderCompleted, true);
    assert.equal(h.storage.get('timerSessionAudio').openingReminderCompleted, true,
      'recovery must remember that this already-started opening must not be replayed');
    opening.emitNativeEnded();
    h.page.onShow();
    assert.deepEqual(h.plays(), [START_AUDIO, GUIDE_AUDIO], 'late completion and foreground callbacks cannot replay either sound');

    h.emitApp('hide', { reason: 3 });
    h.page.onHide();
    h.page.onUnload();
    const fresh = createPage({ isCountdown, withGuide: true, modernAudio: true,
      initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 1000 });
    assert.equal(fresh.page.sessionId, h.page.sessionId);
    assert.equal(fresh.page.openingReminderCompleted, true);
    fresh.advance(15000);
    assert.equal(fresh.plays().filter(src => src === START_AUDIO).length, 0,
      'a restored sitting must not owe the opening whose replay was suppressed');
    assert.equal(fresh.records.length, 0);
    fresh.page.onUnload();
  }
});

test('an exhausted closing bell retries on the next visit without losing the reminder or duplicating records', () => {
  for (const isCountdown of [true, false]) {
    let audioAvailable = false;
    const h = createPage({ isCountdown,
      audioBehavior: (_player, src) => src === END_AUDIO && !audioAvailable ? 'error' : 'play' });
    h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
    if (!isCountdown) h.page.handleStop();
    const sessionId = h.page.pendingCompletion.sessionId;
    h.advance(150);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
    assert.equal(h.vibrations.length, 1);
    assert.match(h.toasts.at(-1).title, /铃声播放失败/);
    h.page.resumeInterruptedAudio(); h.emitAudio('end'); h.advance(10000);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2, 'no retry loop in the same foreground visit');
    audioAvailable = true;
    h.page.onShow();
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 3);
    h.page.onShow();
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 3, 'a playing retry is not restarted');
    h.page.audioPlayer.emitEnded();
    assert.equal(h.storage.get('timerPendingEndReminder'), null);
    h.page.onShow();
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 3);
    assert.equal(h.records.length, 0);
    assert.equal(h.page.pendingCompletion.sessionId, sessionId);
  }
});

test('manual and natural completion repair an unexpected native stop or pause without losing the closing reminder', () => {
  for (const ending of ['manual-countdown', 'manual-countup', 'natural']) {
    for (const nativeEvent of ['stop', 'pause']) {
      const h = createPage({ isCountdown: ending !== 'manual-countup', withGuide: true });
      h.page.applyDuration(1);
      h.page.startTimer();
      h.advance(5000);
      h.page.audioPlayer.emitEnded();
      h.advance(ending === 'natural' ? 55000 : 5000);
      if (ending !== 'natural') h.page.handleStop();
      const closing = h.page.audioPlayer;
      const reminder = h.storage.get('timerPendingEndReminder');
      assert.equal(closing.src, END_AUDIO);
      assert.equal(closing.volume, 1);
      closing.currentTime = 0.5;
      closing.emitNativeSilence(nativeEvent);
      assert.equal(closing.destroyed, true);
      assert.deepEqual(h.storage.get('timerPendingEndReminder'), reminder);
      h.advance(150);
      assert.equal(h.page.audioPlayer.src, END_AUDIO);
      assert.equal(h.page.audioPlayer.paused, false);
      assert.equal(h.page.audioPlayer.startTime, 0.5);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.records.length, 0, 'audio repair cannot save a record on its own');
      h.page.audioPlayer.emitEnded();
      assert.equal(h.storage.get('timerPendingEndReminder'), null);
    }
  }
});

test('foreground natural and manual completion recover a Play-only closing bell and save the original completion once', async () => {
  for (const ending of ['natural', 'manual']) {
    for (const withGuide of [false, true]) {
      const h = createPage({ modernAudio: true, withGuide });
      h.page.applyDuration(ending === 'natural' ? 1 : 2);
      h.page.startTimer(); h.advance(5000); h.page.audioPlayer.emitEnded();
      h.advance(ending === 'natural' ? 55000 : 60000);
      if (ending === 'manual') h.page.handleStop();
      const original = h.page.audioPlayer;
      const completion = { ...h.page.pendingCompletion };
      assert.equal(original.src, END_AUDIO);
      assert.equal(original.paused, false, 'Play has fired although native playback never advances');
      assert.equal(original.currentTime, 0);
      assert.equal(h.page.isPageVisible, true);
      assert.equal(h.application._timerForeground, true);
      assert.equal(h.records.length, 0);
      if (withGuide) assert.equal(h.page.backgroundMusicPlayer, null, 'guidance stops before closing playback');
      h.advance(2650);
      const recovered = h.page.audioPlayer;
      assert.equal(original.destroyed, true);
      assert.notEqual(recovered, original);
      assert.equal(recovered.src, END_AUDIO);
      assert.equal(recovered.startTime, 0);
      assert.equal(recovered.paused, false);
      assert.equal(h.storage.get('timerPendingEndReminder').sessionId, completion.sessionId);
      assert.deepEqual({ ...h.page.pendingCompletion }, completion, 'audio repair preserves the original deadline and draft');
      h.page.handleTimerFinished(); h.page.handleStop(); h.page.onShow();
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
      recovered.emitEnded();
      recovered.emitNativeEnded(); h.page.onShow();
      assert.equal(h.storage.get('timerPendingEndReminder'), null);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
      assert.equal(h.vibrations.length, 0);
      await h.page.confirmCompletion(); await h.page.confirmCompletion();
      assert.equal(h.records.length, 1);
      assert.equal(h.records[0][0], completion.duration);
      assert.equal(h.records[0][3], completion.endedAt);
      assert.equal(h.records[0][4], completion.sessionId);
    }
  }
});

test('a long foreground countdown replaces an expired preloaded closing context and retains its exact deadline', async () => {
  let stale;
  const h = createPage({ modernAudio: true,
    audioBehavior: player => player === stale ? 'error' : 'play' });
  h.page.applyDuration(20); h.page.startTimer();
  stale = h.players.find(player => player.src === END_AUDIO);
  assert.ok(stale, 'closing audio was preloaded when the sit began');
  const sessionId = h.page.sessionId;
  const deadline = h.page.data.startTimestamp + 20 * 60000;
  h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(20 * 60000 - 5000);
  h.advance(150);
  const recovered = h.page.audioPlayer;
  assert.equal(stale.destroyed, true);
  assert.notEqual(recovered, stale);
  assert.equal(recovered.src, END_AUDIO);
  assert.equal(recovered.paused, false);
  assert.equal(h.page.isPageVisible, true);
  assert.equal(h.application._timerForeground, true);
  assert.equal(h.page.pendingCompletion.sessionId, sessionId);
  assert.equal(h.page.pendingCompletion.endedAt, deadline);
  assert.equal(h.page.pendingCompletion.duration, 20);
  assert.equal(h.records.length, 0);
  recovered.emitEnded(); h.page.onShow();
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
  await h.page.confirmCompletion(); await h.page.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][3], deadline);
  assert.equal(h.records[0][4], sessionId);
});

test('a premature native Ended after 0.02 seconds cannot acknowledge the foreground closing reminder', async () => {
  const h = createPage({ modernAudio: true });
  h.page.applyDuration(1); h.page.startTimer();
  h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(55000);
  const original = h.page.audioPlayer;
  const completion = { ...h.page.pendingCompletion };
  original.emitProgress(0.02);
  original.emitNativeEnded();
  assert.equal(h.storage.get('timerPendingEndReminder')?.sessionId, completion.sessionId);
  assert.equal(original.destroyed, true, 'a tiny native progress value cannot confirm the full 19-second bell');
  h.advance(150);
  const recovered = h.page.audioPlayer;
  assert.notEqual(recovered, original);
  assert.equal(recovered.src, END_AUDIO);
  assert.equal(recovered.paused, false);
  assert.deepEqual({ ...h.page.pendingCompletion }, completion);
  assert.equal(h.records.length, 0);
  recovered.emitEnded(); original.emitNativeEnded(19.083); h.page.onShow();
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 2);
  await h.page.confirmCompletion(); await h.page.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][3], completion.endedAt);
  assert.equal(h.records[0][4], completion.sessionId);
});

test('a failed count-up draft write cannot leave the timer running while its closing bell plays', () => {
  let failDraft = false;
  const h = createPage({ isCountdown: false,
    storageFailure: key => failDraft && key === 'timerPendingCompletion' });
  h.page.startTimer(); h.advance(65000);
  failDraft = true;
  assert.doesNotThrow(() => h.page.handleStop());
  assert.equal(h.page.data.isRunning, false);
  assert.equal(h.page.data.isPaused, false);
  assert.equal(h.page.timerInterval, null);
  assert.equal(h.page.pendingCompletion.duration, 1);
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  h.page.onShow();
  assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  assert.equal(h.records.length, 0);
});

test('unacknowledged closing bells survive cold restart, while confirmed completions stay silent', async () => {
  for (const isCountdown of [true, false]) {
    for (const seconds of [30, 60]) {
      const h = createPage({ isCountdown, withAppLifecycle: true });
      h.page.startTimer(); h.advance(seconds * 1000); h.page.handleStop();
      const reminder = h.storage.get('timerPendingEndReminder');
      if (seconds >= 60) await h.page.confirmCompletion();
      h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
      const fresh = createPage({ withAppLifecycle: true,
        initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 60000 });
      assert.deepEqual(fresh.plays(), seconds < 60 ? [END_AUDIO] : []);
      assert.equal(fresh.records.length, 0);
      assert.equal(fresh.page.pendingCompletion, null);
      if (seconds < 60) {
        assert.equal(fresh.storage.get('timerPendingEndReminder').sessionId, reminder.sessionId);
        fresh.page.audioPlayer.emitEnded();
      }
      fresh.page.onShow();
      assert.equal(fresh.storage.get('timerPendingEndReminder'), null);
      assert.equal(fresh.plays().length, seconds < 60 ? 1 : 0);
    }
  }
});

test('reset, app exit and unload cancel recovery of the old opening cue', () => {
  for (const action of ['reset', 'exit', 'unload']) {
    const h = createPage({ audioBehavior: () => 'error', withGuide: true });
    h.page.startTimer(); h.advance(5000);
    assert.equal(h.page.audioPlayer, null);
    if (action === 'reset') h.page.resetTimer();
    if (action === 'exit') h.emitApp('hide');
    if (action === 'unload') h.page.onUnload();
    const before = h.plays().length;
    h.advance(10000);
    assert.equal(h.plays().length, before, `${action} cannot retry an old cue or create a closing cue`);
    assert.equal(h.page.backgroundMusicPlayer, null);
  }
});

test('a missing interruption-end callback cannot mute the next user-started sitting', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(5000);
    h.emitAudio('begin');
    h.page.handleStop();
    assert.equal(h.application._timerAudioInterrupted, true);
    const before = h.plays().length;
    h.emitApp('show'); h.page.onShow(); h.advance(3000);
    assert.equal(h.plays().length, before, 'automatic foregrounding cannot claim the call has ended');
    h.page.startTimer();
    assert.equal(h.application._timerAudioInterrupted, false, 'a new explicit sitting can request audio again');
    h.advance(4999);
    assert.equal(h.plays().length, before);
    h.advance(1);
    assert.equal(h.plays().at(-1), START_AUDIO);
    h.page.handleStop();
    assert.equal(h.plays().at(-1), END_AUDIO);
  }
});

test('resuming a paused sitting still waits for the real audio interruption end', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(5000);
    h.emitAudio('begin'); h.page.pauseTimer();
    const before = h.plays().length;
    h.page.startTimer(); h.advance(3000);
    assert.equal(h.application._timerAudioInterrupted, true);
    assert.equal(h.plays().length, before);
    h.emitAudio('end');
    assert.equal(h.plays().length, before + 1);
    assert.equal(h.plays().at(-1), START_AUDIO);
  }
});

test('a broken optional guide cannot prevent the next opening or closing cue', () => {
  for (const failure of ['stop', 'pause', 'error']) {
    const h = createPage({ withGuide: true });
    h.page.startTimer(); h.advance(5000); h.page.audioPlayer.emitEnded();
    const guide = h.page.backgroundMusicPlayer;
    if (failure === 'error') guide.emitError();
    else guide[failure] = () => { throw new Error('native guide unavailable'); };
    if (failure === 'pause') h.page.pauseTimer();
    h.page.resetTimer();
    assert.equal(h.page.backgroundMusicPlayer, null);
    h.page.startTimer(); h.advance(5000);
    assert.equal(h.page.audioPlayer.src, START_AUDIO);
    assert.equal(h.page.audioPlayer.paused, false);
    h.page.handleStop();
    assert.equal(h.page.audioPlayer.src, END_AUDIO);
    assert.equal(h.page.audioPlayer.paused, false);
  }
});

test('page recovery preserves opening progress when intentional native pause fails', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000);
    const sessionId = h.page.sessionId;
    const original = h.page.audioPlayer;
    original.currentTime = 7;
    original.pause = () => { throw new Error('native pause failed'); };
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
    assert.equal(h.page.audioPlayer, null, 'the failed native context has already been released');
    h.page.onUnload();
    assert.equal(h.application._timerSessionAudio.cuePosition, 7,
      'same-runtime reconstruction must keep trusted progress outside the native context');
    h.advance(10000);
    const fresh = h.recreatePage({ visible: false });
    const before = h.plays().length;
    h.emitApp('show'); fresh.onShow();
    assert.equal(h.plays().length, before, 'the reconstructed cue waits for the audio interruption end');
    h.emitAudio('end');
    assert.equal(fresh.sessionId, sessionId);
    assert.equal(fresh.audioPlayer.src, START_AUDIO);
    assert.equal(fresh.audioPlayer.currentTime, 7);
    assert.equal(fresh.audioPlayer.paused, false);
    assert.equal(fresh.backgroundMusicPlayer, null);
    fresh.audioPlayer.emitEnded();
    assert.equal(h.plays().filter(src => src === GUIDE_AUDIO).length, 1);
    assert.equal(h.records.length, 0);
  }
});

test('an opening error after Play consumes its checkpoint and page recovery cannot replay it', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withGuide: true });
    h.page.startTimer(); h.advance(5000);
    const sessionId = h.page.sessionId;
    const original = h.page.audioPlayer;
    original.currentTime = 7;
    original.emitError();
    assert.equal(original.destroyed, true);
    assert.equal(h.page.audioPlayer, null);
    assert.equal(h.page.currentSessionSound, null);
    assert.equal(h.page.openingReminderCompleted, true);
    assert.equal(h.storage.get('timerSessionAudio').openingReminderCompleted, true);
    assert.equal(h.storage.get('timerSessionAudio').currentSessionSound, null);
    h.advance(150);
    assert.deepEqual(h.plays(), [START_AUDIO, GUIDE_AUDIO], 'a started opening is not retried after its error');

    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
    assert.equal(h.application._timerSessionAudio.openingReminderCompleted, true);
    assert.equal(h.application._timerSessionAudio.currentSessionSound, null);
    h.advance(10000);
    const fresh = h.recreatePage({ visible: false });
    const before = h.plays().length;
    h.emitApp('show'); fresh.onShow();
    assert.equal(h.plays().length, before, 'guide recovery still waits for the real interruption end');
    h.emitAudio('end');
    assert.equal(fresh.sessionId, sessionId);
    assert.equal(fresh.currentSessionSound, null);
    assert.equal(fresh.openingReminderCompleted, true);
    assert.equal(fresh.backgroundMusicPlayer.src, GUIDE_AUDIO);
    assert.equal(fresh.backgroundMusicPlayer.paused, false);
    h.advance(15000);
    assert.equal(h.plays().filter(src => src === START_AUDIO).length, 1,
      'the consumed opening cannot return through a restored page or delayed retry');
    assert.equal(h.records.length, 0);
    fresh.onUnload();
  }
});


test('failed closing vibrations retain one reminder until a successful retry without duplicating the record', async () => {
  for (const failure of ['fail', 'throw']) {
    let fail = true;
    const h = createPage({ initialStorage: { timerReminderSettings: { end: 'vibrate' } },
      vibrationBehavior(options) {
        if (!fail) return options.success?.({});
        if (failure === 'throw') throw new Error('vibration unavailable');
        options.fail?.({ errMsg: 'vibrateLong:fail' });
      } });
    h.page.applyDuration(1); h.page.startTimer(); h.advance(60000);
    const sessionId = h.page.pendingCompletion.sessionId;
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
    assert.equal(h.page.endReminderFailed, true);
    assert.match(h.toasts.at(-1).title, /震动提醒失败/);
    h.page.resumeInterruptedAudio();
    assert.equal(h.vibrations.length, 1);
    fail = false; h.page.onShow();
    assert.equal(h.vibrations.length, 2);
    h.advance(2999);
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
    h.advance(1);
    assert.equal(h.storage.get('timerPendingEndReminder'), null);
    h.page.onShow(); assert.equal(h.vibrations.length, 9);
    await h.page.confirmCompletion(); await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
  }
});

test('late vibration callbacks cannot acknowledge a later sitting closing reminder', () => {
  const requests = [];
  const h = createPage({ initialStorage: { timerReminderSettings: { end: 'vibrate' } },
    vibrationBehavior(callbacks) { requests.push(callbacks); if (requests.length > 1) callbacks.success({}); } });
  h.page.startTimer(); h.advance(2000); h.page.handleStop();
  const old = requests[0];
  h.page.startTimer(); h.advance(2000); h.page.handleStop();
  const currentSession = h.storage.get('timerPendingEndReminder').sessionId;
  old.success({}); old.fail({ errMsg: 'late failure' });
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, currentSession);
  requests[1].success({});
  h.advance(2999);
  assert.equal(h.storage.get('timerPendingEndReminder').sessionId, currentSession);
  h.advance(1);
  assert.equal(h.storage.get('timerPendingEndReminder'), null);
});

test('clock rollback while a count-up is paused never turns the pause into counted time', () => {
  const h = createPage({ isCountdown: false });
  h.page.startTimer(); h.advance(65000); h.page.pauseTimer();
  h.jump(-30000); h.page.startTimer(); h.advance(1000);
  assert.equal(h.page.data.elapsedTime, 66);
  assert.ok(h.page.data.totalPausedTime >= 0);
  assert.equal(h.records.length, 0);
});

test('a cold count-up already confirmed at its limit rings once without extending its duration', async () => {
  const savedAt = Date.parse('2026-09-18T07:59:00+08:00');
  const h = createPage({ initialStorage: { timerState: {
    sessionId: 'confirmed-countup-limit', isCountdown: false, isRunning: true, isPaused: false,
    totalTime: 420, elapsedTime: 86400, startTimestamp: savedAt - 86400000,
    saveTime: savedAt, pauseTimestamp: 0, totalPausedTime: 0
  } } });
  assert.equal(h.page.data.isRunning, false);
  assert.equal(h.page.data.isPaused, false);
  assert.equal(h.page.pendingCompletion.duration, 1440);
  assert.equal(h.page.pendingCompletion.endedAt, savedAt);
  assert.deepEqual(h.plays(), [END_AUDIO]);
  h.page.audioPlayer.emitEnded(); h.page.onShow();
  assert.deepEqual(h.plays(), [END_AUDIO]);
  await h.page.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][4], 'confirmed-countup-limit');
});

test('a saved detached count-up notice is shown once while its terminal marker still prevents revival', () => {
  const h = createPage({ isCountdown: false, withAppLifecycle: true });
  h.page.startTimer(); h.advance(65000);
  h.emitApp('hide', { reason: 3 }); h.page.onUnload();
  h.emitApp('hide', { reason: 0 }); h.emitApp('show'); h.recreatePage();
  const notices = () => h.toasts.filter(item => item.title === '正计时已结束，1分钟已存本机').length;
  assert.equal(notices(), 1);
  h.page.onUnload(); h.recreatePage();
  assert.equal(notices(), 1);
  h.page.setData({ isCountdown: false });
  h.page.startTimer(); h.advance(2000); h.page.handleStop();
  h.page.onUnload(); h.recreatePage();
  assert.equal(notices(), 1);
  assert.equal(h.records.length, 1);
  assert.equal(h.application.getDetachedCountupExit().saved, true);
});

test('a count-up interruption checkpoint survives a failed disk write and restores running or manually paused in the same process', () => {
  for (const paused of [false, true]) {
    let failCheckpoint = false;
    const h = createPage({ isCountdown: false, withAppLifecycle: true,
      storageFailure: key => failCheckpoint && key === 'timerState' });
    h.page.startTimer(); h.advance(65000);
    if (paused) h.page.pauseTimer();
    const sessionId = h.page.sessionId;
    const lastDiskCheckpoint = structuredClone(h.storage.get('timerState'));
    failCheckpoint = true;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.page.onUnload();
    assert.deepEqual(structuredClone(h.storage.get('timerState')), lastDiskCheckpoint,
      'the interrupted checkpoint could not reach disk');
    assert.equal(h.application._timerCountupCheckpoint.sessionId, sessionId);
    assert.equal(h.application._timerCountupCheckpoint.interrupted, true);
    h.advance(30000);
    failCheckpoint = false;
    h.emitAudio('end'); h.emitApp('show');
    const fresh = h.recreatePage();
    assert.equal(fresh.sessionId, sessionId);
    assert.equal(fresh.data.isRunning, !paused);
    assert.equal(fresh.data.isPaused, paused);
    assert.equal(fresh.data.elapsedTime, paused ? 65 : 95,
      'a failed checkpoint write cannot turn the call into a cold-start pause');
    assert.equal(h.records.length, 0);
    assert.equal(fresh.pendingCompletion, null);
    assert.equal(h.plays().includes(END_AUDIO), false);
    h.advance(1000);
    assert.equal(fresh.calculateElapsedTime(), paused ? 65 : 96);
  }
});

test('count-up memory recovery cannot override a different stored session or runtime', () => {
  for (const replacement of ['stored-session', 'stored-runtime', 'memory-session', 'memory-runtime']) {
    const h = createPage({ isCountdown: false, withAppLifecycle: true });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onUnload();
    h.advance(30000);
    const disk = { ...h.storage.get('timerState'), elapsedTime: 20,
      startTimestamp: h.now() - 20000, saveTime: h.now() };
    if (replacement === 'stored-session') disk.sessionId = 'replacement-count-up';
    if (replacement === 'stored-runtime') disk.runtimeId = 'replacement-runtime';
    h.storage.set('timerState', disk);
    if (replacement === 'memory-session') {
      h.application._timerCountupCheckpoint = { ...h.application._timerCountupCheckpoint,
        sessionId: 'stale-memory-session' };
    }
    if (replacement === 'memory-runtime') {
      h.application._timerCountupCheckpoint = { ...h.application._timerCountupCheckpoint,
        runtimeId: 'stale-memory-runtime' };
    }
    h.emitAudio('end'); h.emitApp('show');
    const fresh = h.recreatePage();
    assert.equal(fresh.sessionId, replacement === 'stored-session' ? 'replacement-count-up' : sessionId,
      replacement);
    assert.equal(fresh.data.elapsedTime, 20, replacement);
    assert.equal(fresh.data.isRunning, true, replacement);
    assert.equal(fresh.data.isPaused, false, replacement);
    assert.equal(h.records.length, 0, replacement);
    assert.equal(fresh.pendingCompletion, null, replacement);
    assert.equal(h.plays().includes(END_AUDIO), false, replacement);
  }
});

test('a newer countdown remains the active session when an old count-up memory checkpoint exists', () => {
  const h = createPage({ isCountdown: false, withAppLifecycle: true });
  h.page.startTimer(); h.advance(65000);
  const oldSessionId = h.page.sessionId;
  h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onUnload();
  h.advance(30000); h.emitAudio('end'); h.emitApp('show');
  assert.equal(h.countdown.start({ sessionId: 'newer-countdown', totalTime: 120,
    startTimestamp: h.now() }), true);
  const fresh = h.recreatePage();
  assert.equal(h.application._timerCountupCheckpoint.sessionId, oldSessionId);
  assert.equal(fresh.sessionId, 'newer-countdown');
  assert.equal(fresh.data.isCountdown, true);
  assert.equal(fresh.data.isRunning, true);
  assert.equal(fresh.data.remainingTime, 120);
  assert.equal(h.storage.get('timerState').sessionId, 'newer-countdown');
  assert.equal(h.records.length, 0);
});

test('a detached count-up terminal marker takes precedence over its active memory checkpoint after failed disk cleanup', () => {
  for (const saveSucceeds of [false, true]) {
    let failCheckpoint = false;
    const h = createPage({ isCountdown: false, withAppLifecycle: true,
      recordCheckin: () => ({ success: saveSucceeds }),
      storageFailure: key => failCheckpoint && key === 'timerState' });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onUnload();
    failCheckpoint = true;
    h.emitApp('hide', { reason: 0 });
    const terminal = h.application.getDetachedCountupExit(sessionId);
    assert.equal(terminal.saved, saveSucceeds);
    assert.equal(h.application._timerCountupCheckpoint.isRunning, true,
      'the old memory checkpoint still describes the pre-exit sitting');
    assert.equal(h.storage.get('timerState').isRunning, true,
      'the old disk checkpoint could not be cleared');
    h.advance(30000); h.emitAudio('end'); h.emitApp('show');
    const fresh = h.recreatePage();
    assert.equal(fresh.data.isRunning, false);
    assert.equal(fresh.data.isPaused, false);
    assert.equal(h.records.length, Number(saveSucceeds));
    if (saveSucceeds) assert.equal(fresh.pendingCompletion, null);
    else assert.deepEqual({ ...fresh.pendingCompletion }, { ...terminal.completion });
    assert.equal(h.plays().includes(END_AUDIO), false);
    failCheckpoint = false;
    h.emitApp('show'); fresh.onShow();
    assert.equal(h.records.length, Number(saveSucceeds), 'foreground retries only flush the terminal state');
    assert.equal(fresh.data.isRunning, false);
  }
});

test('both timers expose growing elapsed time throughout an unanswered call before any foreground return', () => {
  for (const isCountdown of [true, false]) {
    const h = createPage({ isCountdown, withAppLifecycle: true });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide();
    for (let step = 1; step <= 3; step += 1) {
      h.advance(15000);
      assert.equal(h.application._timerForeground, false);
      assert.equal(h.application._timerAudioInterrupted, true);
      const elapsed = isCountdown ? h.countdown.getSnapshot().elapsedTime : h.page.calculateElapsedTime();
      assert.equal(elapsed, 65 + step * 15,
        'logical time keeps accumulating while the call is still ringing');
      assert.equal(h.page.data.elapsedTime, 65, 'a suspended renderer need not tick for time to advance');
      assert.equal(h.page.data.isRunning, true);
      assert.equal(h.page.sessionId, sessionId);
      assert.equal(h.records.length, 0);
      assert.equal(h.page.pendingCompletion, null);
      assert.equal(h.plays().includes(END_AUDIO), false);
    }
    h.emitAudio('end'); h.emitApp('show'); h.page.onShow();
    assert.equal(h.page.data.elapsedTime, 110);
    assert.equal(h.page.data.isRunning, true);
    assert.equal(h.records.length, 0);
  }
});

test('completion dialog and notice failures cannot block a countdown bell after an unanswered call', async () => {
  for (const failure of ['completion-dialog', 'completion-notice']) {
    let failUi = true;
    const h = createPage({ withAppLifecycle: true,
      showToast() {
        if (failUi && failure === 'completion-notice') throw new Error('native toast failed');
      } });
    h.page.applyDuration(1); h.page.startTimer();
    const sessionId = h.page.sessionId;
    const deadline = h.page.data.startTimestamp + 60000;
    h.advance(5000); h.page.audioPlayer.emitEnded(); h.advance(54000);
    if (failure === 'completion-dialog') {
      const render = h.page.setData;
      h.page.setData = values => {
        if (failUi && values.showCompletionDialog === true) throw new Error('completion dialog render failed');
        return render.call(h.page, values);
      };
    }
    h.emitAudio('begin'); h.emitApp('hide', { reason: 3 }); h.page.onHide(); h.advance(2000);
    if (failure === 'completion-notice') h.storage.set('timerCompletionNotice', '倒计时已结束，待播放收坐提醒');
    assert.doesNotThrow(() => h.emitApp('show'), failure);
    assert.doesNotThrow(() => h.page.onShow(), failure);
    assert.equal(h.application._timerAudioInterrupted, true);
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.page.pendingCompletion.sessionId, sessionId);
    assert.equal(h.page.pendingCompletion.duration, 1);
    assert.equal(h.page.pendingCompletion.endedAt, deadline);
    assert.equal(h.records.length, 0);
    assert.equal(h.plays().includes(END_AUDIO), false, 'a UI failure cannot release the system audio interruption');
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId);
    h.emitAudio('end');
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1, failure);
    const closing = h.page.audioPlayer;
    assert.equal(closing.paused, false);
    assert.equal(h.storage.get('timerPendingEndReminder').sessionId, sessionId,
      'starting audio cannot acknowledge an unfinished closing bell');
    assert.doesNotThrow(() => h.page.onShow(), failure);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    closing.emitEnded();
    assert.equal(h.storage.get('timerPendingEndReminder'), null);
    assert.doesNotThrow(() => h.page.onShow(), failure);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    failUi = false;
    h.page.onShow();
    await h.page.confirmCompletion(); await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][3], deadline);
    assert.equal(h.records[0][4], sessionId);
    assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
  }
});

test('a transient countdown checkpoint read failure retries on PageShow without discarding or replacing its session', () => {
  for (const persistent of [false, true]) {
    const savedAt = Date.parse('2026-09-18T07:59:00+08:00');
    const original = { sessionId: 'read-retry-countdown', isCountdown: true, isRunning: true, isPaused: false,
      elapsedTime: 65, totalTime: 420, startTimestamp: savedAt - 65000, saveTime: savedAt,
      pauseTimestamp: 0, totalPausedTime: 0 };
    let failRead = true;
    const h = createPage({ initialStorage: { timerState: original }, storageReadFailure(key) {
      if (key !== 'timerState' || !failRead) return false;
      if (!persistent) failRead = false;
      return true;
    } });
    if (persistent) {
      h.page.startTimer();
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.sessionId, null);
      assert.deepEqual(h.storage.get('timerState'), original, 'an unread checkpoint cannot be replaced by a new sitting');
      assert.equal(h.records.length, 0);
      failRead = false;
      h.page.onShow();
    }
    assert.equal(h.page.sessionId, original.sessionId);
    assert.equal(h.page.data.isPaused, false);
    assert.equal(h.page.data.elapsedTime, 125);
    assert.equal(h.records.length, 0);
    h.page.startTimer(); h.advance(1000);
    assert.equal(h.page.sessionId, original.sessionId);
    assert.equal(h.page.data.isRunning, true);
    assert.equal(h.page.data.elapsedTime, 126);
    assert.equal(h.plays().includes(END_AUDIO), false);
  }
});

test('late countdown or audio checkpoint reads still deliver the owed opening once on PageShow', () => {
  for (const failedKey of ['timerState', 'timerSessionAudio']) {
    const old = createPage(); old.page.startTimer(); old.advance(2000);
    const sessionId = old.page.sessionId;
    let failRead = true;
    const fresh = createPage({ initialStorage: structuredClone(Object.fromEntries(old.storage)),
      initialTime: old.now() + 10000,
      storageReadFailure: key => failRead && key === failedKey });
    assert.deepEqual(fresh.plays(), []);
    failRead = false;
    fresh.page.onShow(); fresh.advance(0);
    assert.equal(fresh.page.sessionId, sessionId);
    assert.equal(fresh.page.data.isRunning, true);
    assert.equal(fresh.page.data.elapsedTime, 12);
    assert.deepEqual(fresh.plays(), [START_AUDIO]);
    const opening = fresh.page.audioPlayer;
    opening.currentTime = 2;
    fresh.page.onShow(); fresh.emitAudio('end');
    assert.equal(fresh.page.audioPlayer, opening);
    assert.equal(opening.currentTime, 2);
    assert.deepEqual(fresh.plays(), [START_AUDIO], 'repeated lifecycle events cannot replay a successfully restored opening');
    assert.equal(fresh.records.length, 0);
  }
});

test('an exited count-up restores its embedded completion even when the separate draft could not be written', async () => {
  for (const failDraftWrite of [false, true]) {
    const endedAt = Date.parse('2026-09-18T07:59:00+08:00');
    const completion = { sessionId: 'detached-terminal-countup', duration: 2, endedAt, text: '' };
    const terminal = { sessionId: completion.sessionId, isCountdown: false, status: 'exited',
      isRunning: false, isPaused: false, pendingCompletion: completion };
    let h = createPage({ initialStorage: { timerState: terminal },
      storageFailure: key => failDraftWrite && key === 'timerPendingCompletion' });
    assert.equal(h.page.data.isRunning, false);
    assert.equal(h.page.data.isPaused, false);
    assert.equal(h.page.data.showCompletionDialog, true);
    assert.equal(h.page.pendingCompletion.sessionId, completion.sessionId);
    assert.equal(h.page.pendingCompletion.duration, 2);
    assert.equal(h.records.length, 0);
    if (failDraftWrite) {
      assert.deepEqual(structuredClone(h.storage.get('timerState')), terminal,
        'the embedded terminal is the only durable draft and cannot be cleared on a failed copy');
      assert.equal(h.storage.get('timerPendingCompletion'), undefined);
      h = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)) });
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.data.showCompletionDialog, true);
    }
    assert.equal(h.storage.get('timerState'), null);
    await h.page.confirmCompletion(); await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0][0], 2);
    assert.equal(h.records[0][3], endedAt);
    assert.equal(h.records[0][4], completion.sessionId);
  }
});

test('running count-up rollback preserves confirmed progress and a valid cold-start checkpoint', () => {
  const h = createPage({ isCountdown: false });
  h.page.startTimer(); h.advance(125000);
  const sessionId = h.page.sessionId;
  h.jump(-180000);
  h.page.syncTimerTime();
  assert.equal(h.page.data.elapsedTime, 125);
  assert.equal(h.page.data.displayTime, '02:05');
  h.page.saveTimerState();
  const stored = structuredClone(Object.fromEntries(h.storage));
  assert.ok(stored.timerState.saveTime >= stored.timerState.startTimestamp);
  const cold = createPage({ initialStorage: stored, initialTime: h.now() + 10000 });
  assert.equal(cold.page.sessionId, sessionId);
  assert.equal(cold.page.data.elapsedTime, 135);
  assert.equal(cold.page.data.isRunning, true);
  cold.page.handleStop();
  assert.equal(cold.page.pendingCompletion.duration, 2);
});

test('pausing a count-up synchronizes elapsed time and completes a sitting already at its limit', () => {
  for (const elapsed of [65000, 86400000]) {
    const h = createPage({ isCountdown: false });
    h.page.startTimer(); h.jump(elapsed);
    h.page.pauseTimer();
    if (elapsed < 86400000) {
      assert.equal(h.page.data.displayTime, '01:05');
      assert.equal(h.page.data.elapsedTime, 65);
      assert.equal(h.page.data.isPaused, true);
    } else {
      assert.equal(h.page.data.isRunning, false);
      assert.equal(h.page.data.isPaused, false);
      assert.equal(h.page.pendingCompletion.duration, 1440);
      assert.equal(h.plays().filter(src => src === END_AUDIO).length, 1);
    }
  }
});

test('a count-up completion survives cold restart when its separate draft write fails', async () => {
  for (const ending of ['manual', 'limit', 'app-exit']) {
    let failDraft = false;
    const h = createPage({ isCountdown: false, recordCheckin: () => ({ success: false }),
      storageFailure: (key, value) => failDraft && key === 'timerPendingCompletion' && !!value });
    h.page.startTimer(); h.advance(65000);
    const sessionId = h.page.sessionId;
    failDraft = true;
    if (ending === 'manual') h.page.handleStop();
    else if (ending === 'limit') { h.jump(86400000); h.page.syncTimerTime(); }
    else h.emitApp('hide', { reason: 0 });
    const completion = { ...h.page.pendingCompletion };
    assert.equal(h.storage.get('timerState').isRunning, false);
    assert.equal(h.storage.get('timerState').pendingCompletion.sessionId, sessionId);
    assert.ok(!h.storage.get('timerPendingCompletion'));
    const cold = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)), initialTime: h.now() + 60000 });
    assert.equal(cold.page.data.isRunning, false);
    assert.equal(cold.page.data.isPaused, false);
    assert.deepEqual({ ...cold.page.pendingCompletion }, completion);
    assert.equal(cold.page.data.showCompletionDialog, true);
    await cold.page.confirmCompletion(); await cold.page.confirmCompletion();
    assert.equal(cold.records.length, 1);
    assert.equal(cold.records[0][0], completion.duration);
    assert.equal(cold.records[0][3], completion.endedAt);
    assert.equal(cold.records[0][4], sessionId);
    assert.equal(cold.storage.get('timerState'), null);
  }
});

test('critical timer reads retry without losing a count-up or overwriting its unread checkpoint', () => {
  const savedAt = Date.parse('2026-09-18T07:59:00+08:00');
  const original = { sessionId: 'read-retry-countup', isCountdown: false, isRunning: true, isPaused: false,
    elapsedTime: 65, totalTime: 420, startTimestamp: savedAt - 65000, saveTime: savedAt,
    pauseTimestamp: 0, totalPausedTime: 0 };
  let failRead = true;
  const h = createPage({ initialStorage: { timerState: original },
    storageReadFailure: key => failRead && key === 'timerState' });
  h.page.toggleMode({ detail: { value: false } });
  h.page.resetTimer(); h.page.applyDuration(20); h.page.startTimer();
  assert.equal(h.page.data.isRunning, false);
  assert.deepEqual(h.storage.get('timerState'), original);
  assert.equal(h.records.length, 0);
  failRead = false;
  h.page.onShow();
  assert.equal(h.page.sessionId, original.sessionId);
  assert.equal(h.page.data.isCountdown, false);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.page.data.elapsedTime, 125);
});

test('an unread completion cannot abort initialization or be replaced by a new sitting', () => {
  const completion = { sessionId: 'unread-completion', duration: 7,
    endedAt: Date.parse('2026-09-18T07:59:00+08:00'), text: '保留感受' };
  let failRead = true;
  const h = createPage({ initialStorage: { timerPendingCompletion: completion },
    storageReadFailure: key => failRead && key === 'timerPendingCompletion' });
  h.page.startTimer();
  assert.equal(h.page.data.isRunning, false);
  assert.deepEqual(h.storage.get('timerPendingCompletion'), completion);
  failRead = false;
  h.page.onShow();
  assert.equal(h.page.pendingCompletion.sessionId, completion.sessionId);
  assert.equal(h.page.data.showCompletionDialog, true);
  assert.equal(h.page.data.completionText, completion.text);
  assert.equal(h.records.length, 0);
});

test('optional timer preferences and notices cannot prevent starting a sitting when their reads fail', () => {
  const h = createPage({ storageReadFailure: key => ['timerCompletionNotice', 'timerRecommendedDurations'].includes(key) });
  assert.equal(h.page.data.duration, 7);
  h.page.startTimer(); h.advance(1000);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.page.data.elapsedTime, 1);
});

test('a saved countdown terminal clears the stale completion read before controller attachment', async () => {
  const old = createPage();
  old.page.applyDuration(1); old.page.startTimer(); old.advance(60000);
  const completion = { ...old.page.pendingCompletion };
  await old.page.confirmCompletion();
  const stored = structuredClone(Object.fromEntries(old.storage));
  stored.timerPendingCompletion = completion;
  const cold = createPage({ initialStorage: stored });
  assert.equal(cold.page.pendingCompletion, null);
  assert.equal(cold.page.data.showCompletionDialog, false);
  await cold.page.confirmCompletion();
  assert.equal(cold.records.length, 0);
  assert.equal(cold.storage.get('timerPendingCompletion'), null);
});

test('successful local completion stays successful when draft cleanup fails and cold startup cannot ask to save it again', async () => {
  for (const isCountdown of [true, false]) {
    let failCleanup = false;
    const h = createPage({ isCountdown,
      storageFailure: (key, value) => failCleanup && key === 'timerPendingCompletion' && value === null });
    h.page.startTimer(); h.advance(65000); h.page.handleStop();
    const sessionId = h.page.pendingCompletion.sessionId;
    failCleanup = true;
    await h.page.confirmCompletion();
    assert.equal(h.records.length, 1);
    assert.equal(h.page.pendingCompletion, null);
    assert.equal(h.page.data.showCompletionDialog, false);
    assert.equal(h.toasts.some(item => item.title === '保存失败，请重试'), false);
    assert.equal(h.storage.get('timerState').pendingCompletion, null);
    assert.equal(h.storage.get('timerPendingCompletion').sessionId, sessionId);
    h.page.toggleMode({ detail: { value: false } });
    h.page.startTimer();
    assert.equal(h.page.data.isRunning, false, 'a fresh count-up cannot overwrite the saved marker until the old draft is cleared');
    const cold = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)) });
    assert.equal(cold.page.pendingCompletion, null);
    assert.equal(cold.page.data.showCompletionDialog, false);
    await cold.page.confirmCompletion();
    assert.equal(cold.records.length, 0);
    assert.equal(cold.storage.get('timerPendingCompletion'), null);
    failCleanup = false;
    h.page.startTimer();
    assert.equal(h.page.data.isRunning, true);
    assert.equal(h.page.data.isCountdown, false);
    assert.notEqual(h.page.sessionId, sessionId);
  }
});

test('a count-up reflection remains recoverable through the terminal backup when draft writes fail', () => {
  let failDraft = false;
  const h = createPage({ isCountdown: false,
    storageFailure: (key, value) => failDraft && key === 'timerPendingCompletion' && !!value });
  h.page.startTimer(); h.advance(65000); failDraft = true; h.page.handleStop();
  assert.doesNotThrow(() => h.page.onCompletionInput({ detail: { value: '记录这段感受' } }));
  const cold = createPage({ initialStorage: structuredClone(Object.fromEntries(h.storage)) });
  assert.equal(cold.page.data.showCompletionDialog, true);
  assert.equal(cold.page.data.completionText, '记录这段感受');
  assert.equal(cold.page.pendingCompletion.duration, 1);
});

test('count-up recovery checks recorded session identity when the saved terminal acknowledgment could not be written', async () => {
  let failTerminal = false;
  const old = createPage({ isCountdown: false,
    storageFailure: key => failTerminal && key === 'timerState' });
  old.page.startTimer(); old.advance(65000); old.page.handleStop();
  const completion = { ...old.page.pendingCompletion };
  failTerminal = true;
  await old.page.confirmCompletion();
  assert.equal(old.records.length, 1);
  assert.equal(old.storage.get('timerPendingCompletion'), null);
  assert.equal(old.storage.get('timerState').pendingCompletion.sessionId, completion.sessionId);
  for (const source of ['embedded', 'separate', 'both']) {
    for (const answer of ['saved', 'missing', 'read-error']) {
      const stored = structuredClone(Object.fromEntries(old.storage));
      if (source === 'separate') stored.timerState = null;
      if (source !== 'embedded') stored.timerPendingCompletion = completion;
      const checked = [];
      const cold = createPage({ initialStorage: stored, hasRecordedTimerCompletion(sessionId) {
        checked.push(sessionId);
        if (answer === 'read-error') throw new Error('record ledger read failed');
        return answer === 'saved';
      } });
      assert.deepEqual(checked, [completion.sessionId]);
      assert.equal(cold.records.length, 0, 'checking recorded identity must never attempt a new record write');
      assert.equal(cold.page.data.isRunning, false);
      if (answer === 'saved') {
        assert.equal(cold.page.pendingCompletion, null, source);
        assert.equal(cold.page.data.showCompletionDialog, false, source);
        assert.equal(cold.storage.get('timerState'), null, source);
        assert.equal(cold.storage.get('timerPendingCompletion'), null, source);
        await cold.page.confirmCompletion();
        assert.equal(cold.records.length, 0);
      } else {
        assert.equal(cold.page.pendingCompletion.sessionId, completion.sessionId, `${source}/${answer}`);
        assert.equal(cold.page.data.showCompletionDialog, true, `${source}/${answer}`);
      }
    }
  }
});

test('clearing an already recorded count-up draft preserves a newer active sitting', () => {
  const now = Date.parse('2026-09-18T08:00:00+08:00');
  const completion = { sessionId: 'recorded-old-countup', duration: 2, endedAt: now - 120000, text: '' };
  const active = { isCountdown: false, sessionId: 'newer-running-countup', totalTime: 420,
    isRunning: true, isPaused: false, elapsedTime: 65, startTimestamp: now - 65000,
    pauseTimestamp: 0, totalPausedTime: 0, saveTime: now };
  const h = createPage({ initialStorage: { timerState: active, timerPendingCompletion: completion },
    hasRecordedTimerCompletion: sessionId => sessionId === completion.sessionId });
  assert.equal(h.page.sessionId, active.sessionId);
  assert.equal(h.page.data.isRunning, true);
  assert.equal(h.page.pendingCompletion, null);
  assert.equal(h.page.data.showCompletionDialog, false);
  assert.equal(h.storage.get('timerState').sessionId, active.sessionId);
  assert.equal(h.storage.get('timerPendingCompletion'), null);
  assert.equal(h.records.length, 0);
});
