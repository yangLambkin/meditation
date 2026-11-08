const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const START_AUDIO = '/modules/timer/audio/起坐.mp3';
const END_AUDIO = '/modules/timer/audio/收坐.mp3';
const GUIDE_AUDIO = 'https://example.test/guide.mp3';

function timerHarness({ stored = {}, now: initialNow = 1794096000000, save, failWrite = () => false } = {}) {
  let now = initialNow;
  let nextId = 0;
  let page;
  const storage = new Map(Object.entries(structuredClone(stored)));
  const timers = new Map();
  const listeners = Object.fromEntries(['show', 'hide', 'audioBegin', 'audioEnd'].map(key => [key, new Set()]));
  const players = [];
  const calls = [];
  const records = [];
  const attempts = [];
  const toasts = [];
  const schedule = (fn, delay, interval = false) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  const emit = (name, options) => { for (const fn of [...listeners[name]]) fn(options); };
  const api = {
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync(key, value) {
      if (failWrite(key)) throw Error('storage unavailable');
      storage.set(key, structuredClone(value));
    },
    removeStorageSync: key => storage.delete(key),
    onAppShow: fn => listeners.show.add(fn), offAppShow: fn => listeners.show.delete(fn),
    onAppHide: fn => listeners.hide.add(fn), offAppHide: fn => listeners.hide.delete(fn),
    onAudioInterruptionBegin: fn => listeners.audioBegin.add(fn), offAudioInterruptionBegin: fn => listeners.audioBegin.delete(fn),
    onAudioInterruptionEnd: fn => listeners.audioEnd.add(fn), offAudioInterruptionEnd: fn => listeners.audioEnd.delete(fn),
    setKeepScreenOn() {}, hideKeyboard() {},
    showToast: options => toasts.push(options.title), showModal() {},
    cloud: { init() {}, getTempFileURL: options => options.success?.({ fileList: [{ tempFileURL: GUIDE_AUDIO }] }) },
    createInnerAudioContext() {
      const events = {};
      const player = { currentTime: 0, startTime: 0, src: '', paused: true,
        play() { assert.ok(!this.destroyed); this.paused = false; calls.push({ action: 'play', src: this.src, at: now }); this.emit('Play'); },
        pause() { this.paused = true; }, stop() { this.paused = true; this.currentTime = 0; },
        destroy() { this.destroyed = true; this.paused = true; },
        emit(name, options) { for (const fn of events[name] || []) fn(options); }
      };
      for (const name of ['Play', 'Ended', 'Error', 'Waiting', 'Canplay']) player['on' + name] = fn => (events[name] ||= []).push(fn);
      players.push(player);
      return player;
    }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const checkin = { recordCheckin(...args) {
    attempts.push(args);
    const result = save ? save(...args) : { success: true };
    if (result?.success && !records.some(record => record[4] === args[4])) records.push(args);
    return result;
  } };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const requireLocal = request => {
      if (request === '../../utils/checkin') return checkin;
      if (request === '../../utils/contentSec') return { checkText: async () => true };
      if (request === '../../utils/dailyCardImage') return { prepareNextImage() {} };
      if (request === './screenBrightness') return { createScreenBrightnessController: () => ({ dim() {}, restore() {} }) };
      assert.ok(request.startsWith('./'), 'unexpected module: ' + request);
      return load(path.resolve(path.dirname(filename), request + '.js'));
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, require: requireLocal, Date: ClockDate, wx: api,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id)
    }, { filename });
    return module.exports;
  }
  const root = path.resolve(__dirname, '../../miniprogram/modules/timer');
  const runtime = load(path.join(root, 'index.js')).createTimerModule({ api, recordCheckin: checkin.recordCheckin });
  runtime.onLaunch();
  function mount({ countdown = true, guide = false } = {}) {
    const definition = load(path.join(root, 'definition.js')).createPage({ api, app: runtime });
    page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
    page.onLoad({}); page.onShow();
    if (!page.sessionId && !page.pendingCompletion) page.setData({ isCountdown: countdown });
    if (guide) page.setData({ backgroundMusic: 'default' });
    return page;
  }
  return {
    api, runtime, storage, players, calls, records, attempts, toasts, listeners, mount,
    get page() { return page; }, get now() { return now; },
    advance(milliseconds, { suspended = false } = {}) {
      const target = now + milliseconds;
      if (suspended) {
        now = target;
        for (const timer of timers.values()) timer.at = Math.max(timer.at, now);
        return;
      }
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.delay; else timers.delete(id);
        timer.fn();
      }
      now = target;
    },
    hide(options = { reason: 2 }) { runtime.onHide(options); emit('hide', options); if (page && !page.isUnloaded) page.onHide(); },
    show() { runtime.onShow(); emit('show'); if (page && !page.isUnloaded) page.onShow(); },
    audioBegin() { emit('audioBegin'); }, audioEnd() { emit('audioEnd'); },
    snapshot() { return Object.fromEntries(storage); },
    played(src) { return calls.filter(call => call.action === 'play' && call.src === src); }
  };
}
module.exports = { timerHarness, START_AUDIO, END_AUDIO, GUIDE_AUDIO };
