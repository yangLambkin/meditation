const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../miniprogram');
const OPENID = 'oz-hidden-sitting-owner';
const LOCAL_ID = 'local-hidden-sitting';
const START = Date.parse('2026-10-31T00:30:00+08:00');
const clone = value => value === undefined ? undefined : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const occurredAt = timestamp => new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

// Run the real local save, source-cloud observation, ownership, outbox and HTTP
// modules together. Cloud/HTTP, timer device effects and unrelated badges and
// reminders are simulated; no request can reach a live account or service.
function harness({ httpAvailable = true, holdFirstHttp = false, failedSourceId = '' } = {}) {
  let now = START, timerId = 0, application, firstHttpPending;
  const timers = new Map(), modules = new Map(), sourceRows = new Map(), networkListeners = new Set();
  const requests = [], cloudRequests = [], loadedPages = [];
  const storage = new Map([
    ['localUserId', LOCAL_ID], ['userOpenId', OPENID], ['cacheStatus', 'initialized'],
    ['userInfo', { _openid: OPENID, bijingBound: true, bijingStudentNumber: 'B1234', bijingBindingVersion: 'binding-v1' }]
  ]);
  const config = { baseUrl: 'https://data.example.test', serviceAccessToken: 'test-only-token',
    practicesEnabled: true, sittingMirrorEnabled: true };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function schedule(callback, ms, interval = false) {
    const id = ++timerId;
    timers.set(id, { callback, due: now + ms, ms, interval });
    return id;
  }
  function replyHttp(options) {
    if (httpAvailable && (!failedSourceId || !options.url.endsWith(`/${failedSourceId}`))) {
      options.success({ statusCode: 200, data: { success: true, data: { id: 'mirrored-sitting' } } });
    } else options.fail({ errMsg: 'simulated data service outage' });
  }
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    onNetworkStatusChange: callback => networkListeners.add(callback),
    getNetworkType: ({ success }) => success({ networkType: 'wifi' }),
    showToast() {}, hideKeyboard() {},
    onAppShow() {}, onAppHide() {}, offAppShow() {}, offAppHide() {},
    setKeepScreenOn: options => options.success?.({}),
    createInnerAudioContext: () => ({ onPlay() {}, onEnded() {}, onError() {}, onWaiting() {}, onCanplay() {},
      play() {}, pause() {}, stop() {}, destroy() {} }),
    request(options) {
      requests.push({ url: options.url, method: options.method, data: clone(options.data), header: clone(options.header) });
      if (holdFirstHttp && requests.length === 1) firstHttpPending = options;
      else replyHttp(options);
      return { abort() {} };
    },
    cloud: {
      init() {}, getTempFileURL: options => options.success?.({ fileList: [] }),
      callFunction(options) {
        cloudRequests.push({ name: options.name, data: clone(options.data) });
        if (options.name === 'contentSecCheck') {
          options.success({ result: { success: true, safe: true } });
          return;
        }
        assert.equal(options.name, 'meditationManager');
        const event = options.data;
        if (event.type === 'recordMeditation') {
          const input = event.data;
          let record = sourceRows.get(input.localId);
          if (!record) {
            record = { ...clone(input), _id: `source-${sourceRows.size + 1}`, _openid: OPENID,
              createdAt: now, updatedAt: now };
            sourceRows.set(input.localId, record);
          }
          options.success({ result: { success: true, data: { recordId: record._id, date: input.date } } });
        } else if (event.type === 'getAllRecords') {
          options.success({ result: { success: true, data: clone([...sourceRows.values()]) } });
        } else {
          assert.fail(`Unexpected source-cloud operation: ${event.type}`);
        }
      }
    }
  };
  const globals = {
    wx, Date: Clock, console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, true), clearInterval: id => timers.delete(id),
    getApp: () => application, getCurrentPages: () => []
  };
  function load(request) {
    const name = path.basename(request).replace(/(?:\.js)?$/, '.js');
    if (name === 'practiceConfig.js') return config;
    if (name === 'bijingRecordSync.js') return { acceptSavedRecord() {}, resumePending: async () => {} };
    if (name === 'badgeManager.js') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'utils', name), 'utf8'), {
      ...globals, module, exports: module.exports, require: load
    }, { filename: name });
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), {
    ...globals, App: value => { application = value; }, require: load
  }, { filename: 'app.js' });
  // Reminder queries are unrelated to source and mirror uploads.
  application.startSyncAlertRefresh = () => {};
  const preferences = load('practicePreferences.js');
  preferences.saveRecordsVisible(false);
  preferences.saveHiddenTypes(['sitting']);
  const manager = load('checkin.js'), queue = load('practiceQueue.js');

  function timerPage(isCountdown) {
    let definition;
    loadedPages.push('timer');
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pages/timer/timer.js'), 'utf8'), {
      ...globals, Page: value => { definition = value; },
      require(request) {
        if (request.endsWith('/screenBrightness')) return { createScreenBrightnessController: () => ({ dim() {}, restore() {} }) };
        if (request.endsWith('/dailyCardImage')) return { prepareNextImage() {} };
        if (request.endsWith('/contentSec')) return { checkText: async () => true };
        return load(request);
      }
    }, { filename: 'timer.js' });
    const page = { ...definition, data: clone(definition.data),
      setData(value) { Object.assign(this.data, value); } };
    page.onLoad({});
    page.onShow();
    page.setData({ isCountdown, totalTime: 120, duration: 2, remainingTime: 120 });
    return page;
  }
  function localRecords() {
    const stored = storage.get(`meditation_checkin_${LOCAL_ID}`) || {};
    return Object.values((stored.checkinRecords || stored).dailyRecords || {}).flatMap(day => day.records || []);
  }
  async function until(predicate) {
    for (let step = 0; step < 100; step++) {
      await tick();
      if (predicate()) return;
      const next = [...timers].filter(([, timer]) => !timer.interval).sort((a, b) => a[1].due - b[1].due)[0];
      if (next) {
        timers.delete(next[0]);
        now = Math.max(now, next[1].due);
        next[1].callback();
      }
    }
    assert.fail(`Background work did not settle: ${JSON.stringify({ requests: requests.length,
      pending: queue.getPending().map(task => ({ status: task.status, attempts: task.attempts, error: task.lastError })),
      records: localRecords().map(record => ({ localId: record.localId, cloudId: record._id, status: record.syncStatus })) })}`);
  }
  async function idle(steps = 10) {
    for (let step = 0; step < steps; step++) {
      await tick();
      const next = [...timers].filter(([, timer]) => !timer.interval).sort((a, b) => a[1].due - b[1].due)[0];
      if (next) {
        timers.delete(next[0]);
        now = Math.max(now, next[1].due);
        next[1].callback();
      }
    }
    await tick();
  }
  return { application, load, manager, preferences, queue, requests, cloudRequests, sourceRows, loadedPages,
    timerPage, localRecords, until, idle, storage,
    releaseFirstHttp() {
      assert.ok(firstHttpPending, 'the first HTTP request must still be waiting');
      const request = firstHttpPending;
      firstHttpPending = null;
      replyHttp(request);
    },
    jump(ms) { now += ms; }, setHttpAvailable(value) { httpAvailable = value; } };
}

function assertHidden(h) {
  assert.equal(h.preferences.getRecordsVisible(), false);
  assert.equal(h.preferences.getVisiblePractices().some(item => item.type === 'sitting'), false);
  assert.deepEqual(clone(h.load('practiceAuth.js').getOwner()), {
    openid: OPENID, studentNumber: 'B1234', bindingVersion: 'binding-v1'
  });
}

function assertMirror(h, { sourceId, duration, timestamp }) {
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, `https://data.example.test/api/openapi/practices/sitting/sources/meditation/${sourceId}`);
  assert.equal(request.data.durationMinutes, duration);
  assert.equal(request.data.occurredAt, occurredAt(timestamp));
  assert.equal(request.data.recordDate, '2026-10-31');
  assert.equal(request.data.operationId, request.header['Idempotency-Key']);
  assert.equal(request.header['X-Expected-Student-Number'], 'B1234');
  assert.equal(request.header['X-Expected-Binding-Version'], 'binding-v1');
  assert.equal(request.header['X-Access-Token'], 'test-only-token');
  assert.equal(h.queue.getPending().length, 0);
  assertHidden(h);
}

test('hidden record entries still save manual sitting and mirror its original time and minutes to data', async () => {
  const h = harness(), timestamp = START - 10 * 60000;
  assertHidden(h);
  const saved = await h.manager.recordCheckinWithSync(17, [], [], timestamp,
    { source: 'manual', date: '2026-10-30', idempotencyKey: 'manual-hidden-sitting' });
  assert.equal(saved.success, true);
  assert.equal(saved.cloudSynced, true);
  await h.until(() => h.requests.length === 1 && h.queue.getPending().length === 0);
  assert.equal(h.localRecords()[0].date, '2026-10-30', 'source business date remains independent from the OpenAPI natural date');
  assert.equal(h.localRecords()[0].source, 'manual');
  assertMirror(h, { sourceId: h.localRecords()[0]._id, duration: 17, timestamp });
  assert.deepEqual(h.loadedPages, []);
});

for (const isCountdown of [false, true]) {
  test(`${isCountdown ? 'countdown completion' : 'count-up stop'} saves and mirrors elapsed sitting minutes while record entries are hidden`, async () => {
    const h = harness(), page = h.timerPage(isCountdown);
    assertHidden(h);
    page.startTimer();
    const sessionId = page.sessionId;
    h.jump(125000);
    if (isCountdown) page.syncTimerTime();
    else page.handleStop();
    const timestamp = START + (isCountdown ? 120000 : 125000);
    assert.equal(page.pendingCompletion.duration, 2);
    assert.equal(page.pendingCompletion.endedAt, timestamp);
    assert.equal(h.localRecords().length, 0, 'front-end completion waits for the save action');
    await page.confirmCompletion();
    await h.until(() => h.requests.length === 1 && h.queue.getPending().length === 0 && h.localRecords()[0]._id);
    assert.equal(h.localRecords().length, 1);
    assert.equal(h.localRecords()[0].localId, sessionId);
    assert.equal(h.localRecords()[0].source, 'timer');
    assert.equal(h.localRecords()[0].duration, 2);
    assertMirror(h, { sourceId: h.localRecords()[0]._id, duration: 2, timestamp });
    await page.confirmCompletion();
    assert.equal(h.localRecords().length, 1);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.loadedPages, ['timer']);
  });
}

test('App foreground resumes a failed sitting mirror with the same source and operation while records stay hidden', async () => {
  const h = harness({ httpAvailable: false });
  const saved = await h.manager.recordCheckinWithSync(9, [], [], START,
    { source: 'manual', date: '2026-10-30', idempotencyKey: 'retry-hidden-sitting' });
  assert.equal(saved.cloudSynced, true, 'a data service failure cannot reverse the original sitting save');
  await h.until(() => h.requests.length >= 3);
  assert.equal(h.requests.length, 3, 'one failed background round stops after three attempts until another lifecycle trigger');
  assert.equal(h.queue.getPending()[0].attempts, 3);
  assert.equal(h.queue.getPending()[0].lastError.code, 'NETWORK_ERROR');
  await h.idle();
  assert.equal(h.requests.length, 3, 'later microtasks and pending retry timers cannot start another round on their own');
  assert.equal(h.queue.getPending()[0].attempts, 3);
  const original = clone(h.requests[0]);
  assert.equal(h.localRecords()[0].syncStatus, 'synced');
  assert.equal(h.sourceRows.size, 1);
  assert.equal(h.queue.getPending().length, 1);
  h.setHttpAvailable(true);
  await h.application.onShow();
  await h.until(() => h.queue.getPending().length === 0);
  assert.equal(h.requests.length, 4);
  const retry = h.requests.at(-1);
  assert.equal(retry.url, original.url);
  assert.equal(retry.header['Idempotency-Key'], original.header['Idempotency-Key']);
  assert.deepEqual(retry.data, original.data);
  assert.equal(retry.data.durationMinutes, 9);
  assert.equal(retry.data.occurredAt, '2026-10-31 00:30:00');
  assert.equal(h.sourceRows.size, 1);
  assert.deepEqual(h.loadedPages, []);
  assertHidden(h);
});

test('a new sitting confirmed during an older mirror request sends without another event or retrying failed older work', async () => {
  for (const failedSourceId of ['', 'source-1']) {
    const h = harness({ holdFirstHttp: true, failedSourceId });
    const older = { _id: 'source-1', _openid: OPENID, localId: 'older-source', timestamp: START - 60000,
      duration: 4, experience: [], createdAt: START, updatedAt: START };
    h.sourceRows.set(older.localId, older);
    const intent = h.queue.enqueueSourceIntent({ operation: 'create',
      identity: { recordId: older._id, localId: older.localId, timestamp: older.timestamp }, snapshot: older });
    h.queue.confirmSource(intent.id, older._id, { sourceVersion: String(START), recordDate: '2026-10-31',
      occurredAt: '2026-10-31 00:29:00', durationMinutes: 4, reflection: '' });
    const sendingOlder = h.queue.flush();
    await h.until(() => h.requests.length === 1);

    const saved = await h.manager.recordCheckinWithSync(6, [], [], START,
      { source: 'manual', date: '2026-10-30', idempotencyKey: 'newer-source' });
    assert.equal(saved.cloudSynced, true);
    await h.until(() => h.queue.getPending().some(task => task.sourceId === 'source-2' && task.status === 'pending' && task.attempts === 0));
    assert.equal(h.requests.length, 1, 'new work is confirmed while the older HTTP request is still waiting');
    h.releaseFirstHttp();
    await h.until(() => h.requests.some(request => request.url.endsWith('/source-2')) &&
      h.queue.getPending().length === (failedSourceId ? 1 : 0));
    await sendingOlder;
    await h.idle();
    assert.equal(h.requests.filter(request => request.url.endsWith('/source-1')).length, failedSourceId ? 3 : 1);
    const newerRequests = h.requests.filter(request => request.url.endsWith('/source-2'));
    assert.equal(newerRequests.length, 1);
    assert.equal(newerRequests[0].data.durationMinutes, 6);
    assert.equal(newerRequests[0].data.occurredAt, '2026-10-31 00:30:00');
    if (failedSourceId) {
      assert.equal(h.queue.getPending()[0].sourceId, 'source-1');
      assert.equal(h.queue.getPending()[0].attempts, 3);
      assert.equal(h.queue.getPending()[0].lastError.code, 'NETWORK_ERROR');
    }
    assert.deepEqual(h.loadedPages, []);
    assertHidden(h);
  }
});
