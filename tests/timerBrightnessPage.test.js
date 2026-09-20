const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/timer/timer.js');

function createPage({ platform, readFails = false, deferRead = false, deferWrite = false } = {}) {
  let definition;
  let now = Date.parse('2026-09-18T08:00:00+08:00');
  let timerId = 0;
  let currentBrightness = 0.25;
  let activeWrites = 0;
  const timers = new Map();
  const storage = new Map();
  const listeners = { show: new Set(), hide: new Set() };
  const calls = { reads: [], writes: [], keepScreenOn: [], maxActiveWrites: 0 };
  const addTimer = (callback, delay, interval = false) => {
    const id = ++timerId;
    timers.set(id, { callback, due: now + delay, delay, interval });
    return id;
  };
  const wx = {
    getDeviceInfo: () => ({ platform }),
    getSystemInfoSync: () => ({ platform }),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    onAppShow: callback => listeners.show.add(callback),
    onAppHide: callback => listeners.hide.add(callback),
    offAppShow: callback => listeners.show.delete(callback),
    offAppHide: callback => listeners.hide.delete(callback),
    getScreenBrightness(options) {
      calls.reads.push(options);
      if (deferRead) return;
      if (readFails) options.fail?.({ errMsg: 'getScreenBrightness:fail' });
      else options.success?.({ value: currentBrightness });
    },
    setScreenBrightness(options) {
      calls.writes.push({ options, finished: false });
      activeWrites++;
      calls.maxActiveWrites = Math.max(calls.maxActiveWrites, activeWrites);
      if (!deferWrite) finishWrite(calls.writes.length - 1);
    },
    setKeepScreenOn(options) {
      calls.keepScreenOn.push(options.keepScreenOn);
      options.success?.({});
    },
    createInnerAudioContext: () => ({
      play() {}, pause() {}, stop() {}, destroy() {},
      onPlay() {}, onEnded() {}, onError() {}, onWaiting() {}, onCanplay() {}
    }),
    showModal: options => options.success?.({ confirm: false }),
    navigateTo() {},
    cloud: {
      init() {},
      getTempFileURL: options => options.success?.({ fileList: [] })
    }
  };
  function finishWrite(index, succeeds = true) {
    const write = calls.writes[index];
    assert.ok(write, `brightness write ${index} must exist`);
    assert.equal(write.finished, false, 'a brightness request must complete only once');
    write.finished = true;
    activeWrites--;
    if (succeeds) {
      currentBrightness = write.options.value;
      write.options.success?.({});
    } else {
      write.options.fail?.({ errMsg: 'setScreenBrightness:fail' });
    }
    write.options.complete?.({});
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const globals = {
    wx,
    Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => addTimer(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => addTimer(callback, delay, true),
    clearInterval: id => timers.delete(id)
  };
  const modules = new Map();
  function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      ...globals,
      module,
      exports: module.exports,
      require: request => loadModule(require.resolve(path.resolve(path.dirname(filename), request)))
    }, { filename });
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    ...globals,
    Page: page => { definition = page; },
    require(request) {
      if (request === '../../utils/checkin') return { recordCheckin: () => ({ success: true }) };
      if (request === '../../utils/contentSec') return { checkText: async () => true };
      return loadModule(require.resolve(path.resolve(path.dirname(pagePath), request)));
    }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  async function advance(milliseconds) {
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
      await flush();
    }
    now = target;
    await flush();
  }
  page.onLoad({});
  page.onShow();
  return {
    page, calls, listeners, advance, flush, finishWrite,
    values: () => calls.writes.map(write => write.options.value),
    setBrightness: value => { currentBrightness = value; },
    emit: type => { for (const callback of [...listeners[type]]) callback({}); }
  };
}

test('visiting the timer and leaving without dimming never writes brightness', async () => {
  for (const elapsed of [null, 0, 59999]) {
    const harness = createPage();
    const { page, advance, emit, flush, values } = harness;
    if (elapsed !== null) page.startTimer();
    await advance(elapsed ?? 70000);
    page.onHide();
    emit('hide');
    page.onUnload();
    await advance(70000);
    await flush();
    assert.deepEqual(values(), [], `brightness must not change after ${elapsed} ms of timing`);
  }
});

test('pausing and stopping before one minute cancel dimming without writing brightness', async () => {
  for (const action of ['pauseTimer', 'stopTimer']) {
    const { page, advance, values } = createPage();
    page.startTimer();
    await advance(59999);
    page[action]();
    await advance(60001);
    page.onHide();
    assert.deepEqual(values(), [], action);
  }
});

test('60 seconds in the foreground dims and each exit restores the brightness captured just before dimming once', async () => {
  for (const action of ['pauseTimer', 'stopTimer', 'onHide', 'appHide']) {
    const { page, calls, advance, setBrightness, emit, flush, values } = createPage();
    page.startTimer();
    await advance(59999);
    assert.deepEqual(values(), []);
    setBrightness(0.73);
    await advance(1);
    assert.deepEqual(values(), [0.01]);
    if (action === 'appHide') emit('hide');
    else page[action]();
    page.onHide();
    emit('hide');
    page.onUnload();
    await flush();
    assert.deepEqual(values(), [0.01, 0.73], action);
    assert.equal(calls.maxActiveWrites, 1);
  }
});

test('Android returns brightness control to the system after dimming', async () => {
  const { page, advance, emit, flush, values } = createPage({ platform: 'android' });
  page.startTimer();
  await advance(60000);
  page.onHide();
  emit('hide');
  page.onUnload();
  await flush();
  assert.deepEqual(values(), [0.01, -1]);
});

test('iOS restores the captured brightness after dimming', async () => {
  const { page, advance, setBrightness, flush, values } = createPage({ platform: 'ios' });
  page.startTimer();
  setBrightness(0.62);
  await advance(60000);
  page.stopTimer();
  await flush();
  assert.deepEqual(values(), [0.01, 0.62]);
});

test('a brightness read failure never dims or restores a fabricated default value', async () => {
  const { page, calls, advance, emit, flush, values } = createPage({ readFails: true });
  page.startTimer();
  await advance(60000);
  assert.ok(calls.reads.length > 0);
  page.pauseTimer();
  page.onHide();
  emit('hide');
  page.onUnload();
  await flush();
  assert.deepEqual(values(), []);
});

test('a brightness read completing after leaving or pausing cannot dim the screen', async () => {
  for (const action of ['onHide', 'pauseTimer', 'appHide']) {
    const { page, calls, advance, emit, flush, values } = createPage({ deferRead: true });
    page.startTimer();
    await advance(60000);
    assert.equal(calls.reads.length, 1);
    if (action === 'appHide') emit('hide');
    else page[action]();
    calls.reads[0].success({ value: 0.68 });
    await flush();
    assert.deepEqual(values(), [], action);
  }
});

test('global AppShow after switching tabs cannot enable keep-awake or dim a hidden page', async () => {
  const { page, calls, advance, emit, values } = createPage();
  page.startTimer();
  await advance(30000);
  page.onHide();
  const writesBeforeAppShow = calls.keepScreenOn.length;
  emit('hide');
  emit('show');
  await advance(120000);
  assert.equal(calls.keepScreenOn.slice(writesBeforeAppShow).includes(true), false);
  assert.deepEqual(values(), []);
});

test('unloading unregisters both app lifecycle listeners', async () => {
  const { page, calls, listeners, emit, advance } = createPage();
  assert.equal(listeners.show.size, 1);
  assert.equal(listeners.hide.size, 1);
  page.onUnload();
  assert.equal(listeners.show.size, 0);
  assert.equal(listeners.hide.size, 0);
  const before = calls.keepScreenOn.length;
  emit('show');
  emit('hide');
  await advance(60000);
  assert.equal(calls.keepScreenOn.length, before);
});

test('leaving while the dim write is pending waits for it then restores once without concurrent writes', async () => {
  const { page, calls, advance, emit, finishWrite, flush, values } = createPage({ deferWrite: true });
  page.startTimer();
  await advance(60000);
  assert.deepEqual(values(), [0.01]);
  page.onHide();
  emit('hide');
  page.onUnload();
  await flush();
  assert.deepEqual(values(), [0.01], 'restoration must wait for the dim request to finish');
  finishWrite(0);
  await flush();
  assert.deepEqual(values(), [0.01, 0.25]);
  assert.equal(calls.maxActiveWrites, 1);
  finishWrite(1);
  await flush();
  assert.deepEqual(values(), [0.01, 0.25]);
});

test('returning to a running timer starts a fresh foreground minute before dimming again', async () => {
  const { page, calls, advance, setBrightness, emit, flush, values } = createPage();
  page.startTimer();
  await advance(60000);
  page.onHide();
  await flush();
  assert.deepEqual(values(), [0.01, 0.25]);
  await advance(90000);
  emit('show');
  assert.equal(calls.keepScreenOn.at(-1), false);
  setBrightness(0.81);
  page.onShow();
  assert.equal(calls.keepScreenOn.at(-1), true);
  await advance(59999);
  assert.deepEqual(values(), [0.01, 0.25]);
  await advance(1);
  assert.deepEqual(values(), [0.01, 0.25, 0.01]);
  page.onHide();
  await flush();
  assert.deepEqual(values(), [0.01, 0.25, 0.01, 0.81]);
});
