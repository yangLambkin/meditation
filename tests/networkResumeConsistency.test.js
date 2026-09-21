const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INITIAL_TIME = Date.parse('2026-09-20T12:00:00+08:00');
const LOCAL_USER = 'local_network_resume';
const OPENID = 'oz-network-resume';
const KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? value : structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));
const uploadPayload = args => [...args.slice(0, 5), Object.fromEntries(Object.entries(args[5])
  .filter(([key]) => key !== 'uploadDeadlineAt'))];

function harness({ loggedIn = true, online = true, missingLocks = false, uploadDelay = 0 } = {}) {
  let now = INITIAL_TIME;
  let connected = online;
  let locksMissing = missingLocks;
  let nextTimerId = 1;
  let manager, app, home;
  let uploadHook, readHook;
  const timers = new Map();
  const networkHandlers = new Set();
  const cloudRows = new Map();
  const calls = { uploads: [], reads: 0, operations: [], toasts: [], stoppedPullRefresh: 0 };
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', loggedIn ? OPENID : ''],
    ['hasSyncedOnLogin', true], ['cacheStatus', 'initialized'], ['needsRecovery', false],
    [KEY, { dailyRecords: {}, monthlyStats: {}, userStats: {} }]
  ]);
  const console = { log() {}, error() {}, warn() {} };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const clockApi = {
    setTimeout(callback, milliseconds) {
      const id = nextTimerId++;
      timers.set(id, { callback, time: now + Number(milliseconds || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return nextTimerId++; },
    clearInterval() {}
  };
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    onNetworkStatusChange: callback => networkHandlers.add(callback),
    showToast: options => calls.toasts.push(clone(options)),
    stopPullDownRefresh: () => calls.stoppedPullRefresh++,
    cloud: { init() {} }
  };
  const api = {
    async recordMeditation(...args) {
      calls.uploads.push({ time: now, args: clone(args) });
      calls.operations.push('upload');
      if (uploadHook) return uploadHook(args, calls.uploads.length - 1);
      if (uploadDelay) await new Promise(resolve => clockApi.setTimeout(resolve, uploadDelay));
      if (!connected) return { success: false, code: 'NETWORK_ERROR', error: '网络不可用' };
      if (locksMissing) return { success: false, code: 'MISSING_COLLECTION', error: 'meditation_locks 集合不存在' };
      const [duration, emotion, experience, timestamp, localId, options = {}] = args;
      const existing = cloudRows.get(localId);
      if (!existing) cloudRows.set(localId, { _id: `cloud-${localId}`, _openid: OPENID,
        duration, emotion, experience, timestamp, localId, date: options.date || '2026-09-20' });
      return { success: true, data: { recordId: `cloud-${localId}`, duplicate: !!existing } };
    },
    async getAllRecords() {
      const index = calls.reads++;
      calls.operations.push('read');
      if (readHook) return readHook(index);
      return connected ? { success: true, data: clone([...cloudRows.values()]) }
        : { success: false, code: 'NETWORK_ERROR', error: '网络不可用' };
    },
    async getUserStats() { return { success: true, data: {} }; }
  };
  function load(file, globals = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8'), {
      module, exports: module.exports, wx, Date: Clock, console, ...clockApi, ...globals
    }, { filename: file });
    return module.exports;
  }
  function restart() {
    timers.clear();
    networkHandlers.clear();
    const dateUtil = load('utils/dateUtil.js');
    dateUtil.watchBusinessDate = () => () => {};
    manager = load('utils/checkin.js', { require(name) {
      if (name === './dateUtil.js') return dateUtil;
      if (name === './cloudApi.js') return api;
      if (name === './badgeManager.js') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
      throw new Error(`Unexpected checkin dependency: ${name}`);
    } });
    load('app.js', {
      App: definition => { app = definition; },
      require: () => manager
    });
    app.setupCacheStatus = () => {};
    app.testCloudEnvironment = () => {};
    app.setAudioOptions = () => {};
    app.onLaunch();
    const homeCheckin = load('utils/homeCheckin.js', { require: () => dateUtil });
    load('pages/index/index.js', {
      Page: definition => { home = definition; },
      require(name) {
        if (name.endsWith('/checkin.js')) return manager;
        if (name.endsWith('/dateUtil.js')) return dateUtil;
        if (name.endsWith('/homeCheckin.js')) return homeCheckin;
        if (name.endsWith('/dailyWisdom.js')) return { DEFAULT_QUOTE: '', watchDailyWisdom: () => () => {} };
        if (name.endsWith('/contentSec.js')) return { checkText: async () => true };
        throw new Error(`Unexpected home dependency: ${name}`);
      }
    });
    home.data = clone(home.data);
    home.setData = values => Object.assign(home.data, values);
    home.checkUserInfoStatus = () => {};
    home.generateCalendar = () => {};
    home.refreshCheckinDefaults = () => {};
    return { manager, app, home };
  }
  async function advance(milliseconds) {
    const end = now + milliseconds;
    let callbacks = 0;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
      if (!due) break;
      assert.ok(++callbacks < 100, 'a foreground retry must not create a busy timer loop');
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.time);
      timer.callback();
      await flush();
    }
    now = end;
    await flush();
  }
  restart();
  return {
    calls, storage, timers, cloudRows, advance, restart,
    async finishRetries(request) {
      await flush();
      await advance(300);
      return request;
    },
    get manager() { return manager; }, get app() { return app; }, get home() { return home; },
    get now() { return now; },
    setUploadHook(hook) { uploadHook = hook; },
    setReadHook(hook) { readHook = hook; },
    setOnlineWithoutEvent(value) { connected = value; },
    rows() { const value = storage.get(KEY); return Object.values((value.checkinRecords || value).dailyRecords).flatMap(day => day.records); },
    async setConnected(value) {
      connected = value;
      for (const handler of networkHandlers) handler({ isConnected: value, networkType: value ? 'wifi' : 'none' });
      await flush();
    },
    repairLocks() { locksMissing = false; },
    suspendFor(milliseconds) { timers.clear(); now += milliseconds; },
    async record(id = 'offline-checkin') {
      return manager.recordCheckinWithSync(12, [], [], INITIAL_TIME - 1000, id);
    }
  };
}

test('restored network only refreshes cloud records and pending uploads wait for the home retry button', async () => {
  const app = harness({ online: false });
  assert.equal((await app.finishRetries(app.record())).cloudSynced, false);
  const original = clone(app.rows()[0]);
  await app.setConnected(true);
  assert.equal(app.calls.uploads.length, 4);
  assert.deepEqual(app.calls.uploads.map(call => call.time - INITIAL_TIME), [0, 100, 200, 300]);
  assert.ok(app.calls.reads > 0, 'network recovery still refreshes the cloud snapshot');
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.cloudRows.size, 0);
  app.home.openCheckinUploadPreview();
  assert.equal(app.home.data.showCheckinUploadPreview, true);
  assert.equal(app.home.data.checkinUploadCount, 1);
  assert.equal(app.calls.uploads.length, 4, 'the retry button previews the queue before upload');
  await app.home.retryCheckinUploads();
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.rows()[0].localId, original.localId);
  assert.equal(app.rows()[0].timestamp, original.timestamp);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  assert.equal(app.calls.uploads.length, 5);
  assert.equal(app.home.data.checkinRetrying, false);
  assert.equal(app.home.data.showCheckinUploadPreview, false);
});

test('network recovery during the retry delay completes the same upload without a manual retry', async () => {
  const app = harness({ online: false });
  let completed = false;
  const saving = app.record('brief-disconnection').then(result => { completed = true; return result; });
  await flush();
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.rows()[0].syncStatus, 'uploading');
  await app.advance(99);
  await app.setConnected(true);
  assert.equal(app.calls.uploads.length, 1, 'network recovery only refreshes during the retry delay');
  assert.equal(completed, false);
  await app.advance(1);
  assert.equal((await saving).cloudSynced, true);
  assert.equal(app.calls.uploads.length, 2);
  assert.deepEqual(uploadPayload(app.calls.uploads[1].args), uploadPayload(app.calls.uploads[0].args));
  for (const call of app.calls.uploads) assert.equal(call.args[5].uploadDeadlineAt, call.time + 3000);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  await app.advance(1000);
  assert.equal(app.calls.uploads.length, 2, 'successful retry cancels the remaining attempts');
});

test('repeated app visibility, disconnected events and elapsed time never retry a failed upload', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('bounded-offline'));
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.app.onShow();
    await app.setConnected(false);
    assert.equal(app.calls.uploads.length, 4);
  }
  await app.advance(24 * 60 * 60 * 1000);
  await app.setConnected(true);
  await app.advance(24 * 60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 4, 'no timer may retransmit a failed local record');
  assert.equal(app.cloudRows.size, 0);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
});

test('quick reopening and pulling down the home page only read cloud state', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('quick-reopen'));
  app.suspendFor(1000);
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  await app.home.onShow();
  await app.home.onPullDownRefresh();
  assert.equal(app.calls.stoppedPullRefresh, 1);
  assert.ok(app.calls.reads >= 1);
  assert.equal(app.calls.uploads.length, 4);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.home.data.pendingCheckinCount, 1);
  assert.equal(app.cloudRows.size, 0);
});

for (const firstEntry of ['app', 'home']) {
  test(`app and home visibility overlap with ${firstEntry} first and share a read without uploading`, async () => {
    const app = harness({ online: false });
    await app.finishRetries(app.record('overlapping-open'));
    app.setOnlineWithoutEvent(true);
    let resolveRead;
    app.setReadHook(() => new Promise(resolve => { resolveRead = resolve; }));
    const first = app[firstEntry].onShow();
    const second = app[firstEntry === 'app' ? 'home' : 'app'].onShow();
    await flush();
    assert.equal(app.calls.uploads.length, 4);
    assert.equal(app.calls.reads, 1);
    assert.equal(app.home.data.checkinSubmitting, false);
    resolveRead({ success: true, data: [] });
    await Promise.all([first, second]);
    assert.equal(app.rows().length, 1);
    assert.equal(app.rows()[0].syncStatus, 'failed');
    assert.equal(app.manager.getUserStats().totalCount, 1);
    app.home.openCheckinUploadPreview();
    await app.home.retryCheckinUploads();
    assert.equal(app.calls.uploads.length, 5);
    assert.equal(app.cloudRows.size, 1);
  });
}

test('resuming after suspended timers preserves failed records until manual upload', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('sleep-resume'));
  app.suspendFor(10 * 60 * 1000);
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  assert.equal(app.calls.uploads.length, 4);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.cloudRows.size, 0);
  app.home.openCheckinUploadPreview();
  await app.home.retryCheckinUploads();
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.calls.uploads.length, 5);
});

test('restarting after OS eviction retains pending identity and never reconstructs an automatic upload timer', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('evicted-process'));
  const before = clone(app.rows()[0]);
  app.suspendFor(10 * 60 * 1000);
  app.restart();
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  await app.home.onShow();
  await app.advance(24 * 60 * 60 * 1000);
  assert.equal(app.rows()[0].localId, before.localId);
  assert.equal(app.rows()[0].timestamp, before.timestamp);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.cloudRows.size, 0);
  assert.equal(app.calls.uploads.length, 4);
  app.home.openCheckinUploadPreview();
  await app.home.retryCheckinUploads();
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, 5);
});

for (const entry of ['home', 'login']) {
  test(`${entry} after guest login refreshes without uploading guest pending records`, async () => {
    const app = harness({ loggedIn: false });
    assert.equal((await app.record(`guest-${entry}`)).cloudSynced, false);
    app.storage.set('userOpenId', OPENID);
    if (entry === 'home') await app.home.onShow();
    else await app.manager.performLoginSync();
    await flush();
    assert.equal(app.calls.uploads.length, 0);
    assert.equal(app.rows().length, 1);
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    assert.equal(app.cloudRows.size, 0);
    app.home.openCheckinUploadPreview();
    await app.home.retryCheckinUploads();
    assert.equal(app.rows()[0].syncOpenid, OPENID);
    assert.equal(app.rows()[0].syncStatus, 'synced');
    assert.equal(app.cloudRows.size, 1);
  });
}

test('missing lock failures stay local through time and dependency repair until another manual attempt', async () => {
  const app = harness({ missingLocks: true });
  await app.finishRetries(app.record('missing-lock-retry'));
  assert.equal(app.rows()[0].syncErrorCode, 'MISSING_COLLECTION');
  await app.advance(24 * 60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 4);
  app.home.openCheckinUploadPreview();
  await app.finishRetries(app.home.retryCheckinUploads());
  assert.equal(app.calls.uploads.length, 8);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.home.data.checkinRetrying, false);
  app.repairLocks();
  await app.app.onShow();
  await app.advance(24 * 60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 8);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  app.home.openCheckinUploadPreview();
  await app.home.retryCheckinUploads();
  assert.equal(app.calls.uploads.length, 9);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getUserStats().totalCount, 1);
});

test('read-only synchronization reconciles cloud corrections, added rows and deletions while preserving local pending records', async () => {
  const app = harness();
  app.manager.recordToLocal(12, ['旧情绪'], [], INITIAL_TIME - 1000, 'local-pending');
  const stored = app.storage.get(KEY);
  stored.dailyRecords['2026-09-20'].records.push({ _id: 'removed-in-cloud', localId: 'removed-in-cloud',
    date: '2026-09-20', timestamp: INITIAL_TIME - 2000, duration: 5, experience: [] });
  stored.dailyRecords['2026-09-20'].count++;
  app.cloudRows.set('another-device', { _id: 'another-device', _openid: OPENID, localId: 'another-device',
    timestamp: INITIAL_TIME - 120000, date: '2026-09-20', duration: 7, emotion: [], experience: [] });
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.uploaded || 0, 0);
  assert.equal(app.calls.uploads.length, 0, 'force alone does not authorize upload');
  assert.equal(app.rows().length, 2);
  assert.ok(app.rows().some(record => record.localId === 'local-pending' && record.syncStatus === 'pending'));
  assert.ok(app.rows().some(record => record._id === 'another-device'));
  assert.equal(app.manager.getCurrentMonthMinutes(), 19);

  app.cloudRows.get('another-device').duration = 30;
  await app.manager.syncWithCloud();
  assert.equal(app.rows().find(record => record._id === 'another-device').duration, 30);
  assert.equal(app.manager.getCurrentMonthMinutes(), 42);
  assert.equal(app.calls.uploads.length, 0);
});

test('concurrent read-only entry points share one refresh without draining pending records', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'concurrent-coordinator');
  let resolveRead;
  app.setReadHook(() => new Promise(resolve => { resolveRead = resolve; }));
  const first = app.manager.syncWithCloud();
  const second = app.manager.syncWithCloud();
  const third = app.manager.syncWithCloud({ force: true });
  assert.strictEqual(first, second);
  assert.strictEqual(first, third);
  await flush();
  assert.equal(app.calls.uploads.length, 0);
  assert.equal(app.calls.reads, 1);
  resolveRead({ success: true, data: [] });
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every(result => result.refreshed));
  assert.equal(app.rows().length, 1);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
});

test('manual upload completes independently of an already pending cloud read', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('manual-during-read'));
  app.setOnlineWithoutEvent(true);
  let resolveRead;
  app.setReadHook(() => new Promise(resolve => { resolveRead = resolve; }));
  const refresh = app.manager.syncWithCloud();
  await flush();
  let completed = false;
  app.home.openCheckinUploadPreview();
  const manual = app.home.retryCheckinUploads().then(() => { completed = true; });
  await flush();
  assert.equal(completed, true, 'a cloud refresh cannot hold the manual-upload button open');
  await manual;
  assert.equal(app.home.data.checkinRetrying, false);
  assert.equal(app.calls.uploads.length, 5);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  app.setReadHook(undefined);
  resolveRead({ success: true, data: [] });
  await refresh;
  assert.equal(app.rows().length, 1, 'the older snapshot cannot erase the confirmed local upload');
});

test('failed read-only refresh preserves pending fields and does not repeat the original failed upload', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('offline-read'));
  const before = clone(app.rows()[0]);
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, false);
  assert.equal(result.pending, 1);
  assert.equal(app.calls.uploads.length, 4);
  assert.deepEqual(app.rows()[0], before);
});

test('manual upload success does not await cloud refresh and later read-only sync reconciles without reuploading', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'upload-then-read-fails');
  app.setReadHook(() => ({ success: false, code: 'NETWORK_ERROR', error: '读取失败' }));
  const result = await app.manager.syncWithCloud({ force: true, uploadPending: true });
  assert.equal(result.uploaded, 1);
  assert.equal(result.success, true);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.rows()[0]._id, 'cloud-upload-then-read-fails');
  await app.manager.syncWithCloud();
  app.setReadHook(undefined);
  assert.equal((await app.manager.syncWithCloud()).refreshed, true);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.rows().length, 1);
});

test('a late old-account upload failure leaves both accounts local until their own explicit manual retry', async () => {
  const app = harness();
  let resolveOldUpload;
  const oldUpload = new Promise(resolve => { resolveOldUpload = resolve; });
  let currentAttempts = 0;
  app.setUploadHook(args => {
    if (args[4] === 'old-account-inflight') return oldUpload;
    currentAttempts++;
    if (currentAttempts <= 4) return { success: false, code: 'NETWORK_ERROR', error: '新账号首次上传失败' };
    const row = { _id: 'current-account-cloud', _openid: args[5].expectedOpenid, localId: args[4],
      timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] };
    app.cloudRows.set(args[4], row);
    return { success: true, data: { recordId: row._id } };
  });
  app.setReadHook(() => ({ success: true,
    data: clone([...app.cloudRows.values()].filter(record => record._openid === app.storage.get('userOpenId'))) }));
  const previous = app.record('old-account-inflight');
  await flush();
  app.storage.set('userOpenId', 'oz-current-account');
  await app.finishRetries(app.record('current-account-pending'));
  resolveOldUpload({ success: false, code: 'NETWORK_ERROR', error: '旧账号迟到的失败回调' });
  await app.finishRetries(previous);
  await app.advance(60 * 60 * 1000);
  assert.equal(currentAttempts, 4);
  await app.app.onShow();
  assert.equal(currentAttempts, 4);
  app.home.openCheckinUploadPreview();
  await app.home.retryCheckinUploads();
  assert.equal(currentAttempts, 5);
  assert.equal(app.rows().find(record => record.localId === 'current-account-pending').syncStatus, 'synced');
  const old = app.rows().find(record => record.localId === 'old-account-inflight');
  assert.equal(old.syncOpenid, OPENID);
  assert.equal(old.syncStatus, 'failed');
  assert.equal(app.calls.uploads.filter(call => call.args[4] === 'old-account-inflight').length, 1);
});

test('a read-only refresh can confirm a previously committed timed-out upload without retransmission', async () => {
  const app = harness();
  app.setUploadHook(args => {
    app.cloudRows.set(args[4], { _id: 'actually-committed', _openid: OPENID, localId: args[4],
      timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] });
    return { success: false, code: 'NETWORK_ERROR', error: '确认超时' };
  });
  assert.equal((await app.finishRetries(app.record('timeout-confirmed-on-read'))).cloudSynced, false);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  const result = await app.manager.syncWithCloud();
  assert.equal(result.refreshed, true);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  assert.equal(result.pending, 0);
  assert.equal(app.calls.uploads.length, 4);
  assert.equal(app.rows().length, 1);
});

test('concurrent manual retry taps create one upload and never reopen an automatic retry loop', async () => {
  const app = harness({ online: false });
  await app.finishRetries(app.record('manual-double-tap'));
  app.setOnlineWithoutEvent(true);
  let resolveUpload;
  app.setUploadHook(args => {
    app.cloudRows.set(args[4], { _id: 'manual-once', _openid: OPENID, localId: args[4],
      timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] });
    return new Promise(resolve => { resolveUpload = resolve; });
  });
  app.home.openCheckinUploadPreview();
  const first = app.home.retryCheckinUploads();
  app.home.openCheckinUploadPreview();
  const second = app.home.retryCheckinUploads();
  await flush();
  assert.equal(app.calls.uploads.length, 5);
  assert.equal(app.home.data.checkinRetrying, true);
  app.home.closeCheckinUploadPreview();
  assert.equal(app.home.data.showCheckinUploadPreview, true, 'repeat taps cannot close or replace an active upload preview');
  assert.equal(app.home.data.checkinUploadCount, 1);
  resolveUpload({ success: true, data: { recordId: 'manual-once' } });
  await Promise.all([first, second]);
  assert.equal(app.home.data.showCheckinUploadPreview, false);
  app.home.openCheckinUploadPreview();
  await app.home.retryCheckinUploads();
  await app.advance(60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 5);
  assert.equal(app.rows().length, 1);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.home.data.checkinRetrying, false);
});

test('manual upload gives each pending record its own timeout even when the batch lasts more than five seconds', async () => {
  const app = harness({ uploadDelay: 2999 });
  for (let index = 0; index < 3; index++) {
    app.manager.recordToLocal(12 + index, [], [], INITIAL_TIME - 1000 - index, `slow-batch-${index}`);
  }
  app.home.openCheckinUploadPreview();
  let completed = false;
  const manual = app.home.retryCheckinUploads().then(() => { completed = true; });
  await flush();
  await app.advance(5000);
  assert.equal(completed, false, 'a batch has no shared five-second cutoff');
  assert.equal(app.home.data.checkinRetrying, true);
  assert.equal(app.calls.uploads.length, 2);
  await app.advance(3997);
  await manual;
  assert.equal(completed, true);
  assert.equal(app.home.data.checkinRetrying, false);
  assert.equal(app.home.data.showCheckinUploadPreview, false);
  assert.equal(app.calls.toasts.at(-1).title, '上传成功');
  assert.deepEqual(app.calls.uploads.map(call => call.time - INITIAL_TIME), [0, 2999, 5998]);
  for (const call of app.calls.uploads) assert.equal(call.args[5].uploadDeadlineAt, call.time + 3000);
  assert.ok(app.rows().every(record => record.syncStatus === 'synced'));
  assert.equal(app.cloudRows.size, 3);
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
});

test('manual upload pauses the remaining queue after four three-second timeouts and never starts another round', async () => {
  const app = harness();
  for (let index = 0; index < 3; index++) {
    app.manager.recordToLocal(12 + index, [], [], INITIAL_TIME - 1000 - index, `batch-timeout-${index}`);
  }
  app.setUploadHook(() => new Promise(() => {}));
  let complete = false;
  app.home.openCheckinUploadPreview();
  const manual = app.home.retryCheckinUploads().then(() => { complete = true; });
  await flush();
  await app.advance(3000);
  assert.equal(complete, false);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.rows()[0].syncStatus, 'uploading');
  await app.advance(100);
  assert.equal(app.calls.uploads.length, 2);
  await app.advance(9199);
  assert.equal(complete, false);
  assert.equal(app.home.data.checkinRetrying, true);
  assert.equal(app.rows()[0].syncStatus, 'uploading');
  assert.equal(app.calls.uploads.length, 4);
  assert.deepEqual(app.calls.uploads.map(call => call.time - INITIAL_TIME), [0, 3100, 6200, 9300]);
  for (const call of app.calls.uploads) {
    assert.equal(call.args[5].uploadDeadlineAt, call.time + 3000);
    assert.deepEqual(uploadPayload(call.args), uploadPayload(app.calls.uploads[0].args));
  }
  await app.advance(1);
  await manual;
  assert.equal(complete, true);
  assert.equal(app.home.data.checkinRetrying, false);
  assert.equal(app.manager.getPendingSyncSummary().pending, 3);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.rows()[0].syncErrorCode, 'CLOUD_TIMEOUT');
  assert.ok(app.rows().slice(1).every(record => record.syncStatus === 'pending'));
  const attempts = app.calls.uploads.length;
  await app.advance(60 * 60 * 1000);
  await app.app.onShow();
  assert.equal(app.calls.uploads.length, attempts);
  assert.equal(app.rows().length, 3);
});

test('switching account during a read stops refresh without starting uploads for the new account', async () => {
  const app = harness();
  let resolveRead;
  app.setReadHook(() => new Promise(resolve => { resolveRead = resolve; }));
  const sync = app.manager.syncWithCloud();
  await flush();
  assert.equal(app.calls.reads, 1);
  app.storage.set('userOpenId', 'oz-new-account');
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'new-account-pending');
  resolveRead({ success: true, data: [] });
  const result = await sync;
  assert.equal(result.success, false);
  assert.equal(result.refreshed, false);
  assert.equal(app.calls.reads, 1);
  assert.equal(app.calls.uploads.length, 0);
  assert.equal(app.rows()[0].syncOpenid, 'oz-new-account');
  assert.equal(app.rows()[0].syncStatus, 'pending');
});
