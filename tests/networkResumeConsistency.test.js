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

function harness({ loggedIn = true, online = true, missingLocks = false } = {}) {
  let now = INITIAL_TIME;
  let connected = online;
  let locksMissing = missingLocks;
  let nextTimerId = 1;
  let manager, app, home;
  let uploadHook, readHook;
  const timers = new Map();
  const networkHandlers = new Set();
  const cloudRows = new Map();
  const calls = { uploads: [], reads: 0, operations: [] };
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
    cloud: { init() {} }
  };
  const api = {
    async recordMeditation(...args) {
      calls.uploads.push({ time: now, args: clone(args) });
      calls.operations.push('upload');
      if (uploadHook) return uploadHook(args, calls.uploads.length - 1);
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

test('restored network while the app stays open forces upload immediately despite the existing backoff', async () => {
  const app = harness({ online: false });
  assert.equal((await app.record()).cloudSynced, false);
  const deadline = app.rows()[0].syncNextRetryAt;
  assert.ok(deadline > app.now);
  assert.ok(deadline - app.now <= 300000);
  await app.setConnected(true);
  assert.ok(app.now < deadline, 'no waiting for the old offline backoff');
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  assert.equal(app.calls.uploads.length, 2);
});

test('each reopening attempts pending uploads immediately while disconnected network events add no extra request', async () => {
  const app = harness({ online: false });
  await app.record('bounded-offline');
  const before = app.calls.uploads.length;
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.app.onShow();
    assert.equal(app.calls.uploads.length, before + attempt + 1, 'one immediate attempt for each reopening');
    await app.setConnected(false);
    assert.equal(app.calls.uploads.length, before + attempt + 1, 'disconnected events must not retry');
  }
  await app.advance(1000);
  assert.equal(app.calls.uploads.length, before + 3, 'background timers still observe backoff');
  await app.setConnected(true);
  await app.advance(5000);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, before + 4);
});

test('quick reopening before retry is due uploads immediately even when no network recovery event arrived', async () => {
  const app = harness({ online: false });
  await app.record('quick-reopen');
  const deadline = app.rows()[0].syncNextRetryAt;
  app.suspendFor(1000);
  assert.ok(app.now < deadline);
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  assert.ok(app.now < deadline, 'reopening must not wait out the old failure backoff');
  assert.equal(app.calls.uploads.length, 2);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
});

for (const firstEntry of ['app', 'home']) {
  test(`app and home visibility overlap with ${firstEntry} first without duplicating the actual upload`, async () => {
    const app = harness({ online: false });
    await app.record('overlapping-open');
    app.suspendFor(1000);
    app.setOnlineWithoutEvent(true);
    let resolveUpload;
    const inFlight = new Promise(resolve => { resolveUpload = resolve; });
    app.setUploadHook(args => {
      app.cloudRows.set(args[4], { _id: 'single-resume-cloud-row', _openid: OPENID, localId: args[4],
        timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] });
      return inFlight;
    });
    const first = app[firstEntry].onShow();
    const second = app[firstEntry === 'app' ? 'home' : 'app'].onShow();
    await flush();
    assert.equal(app.calls.uploads.length, 2, 'one failed original attempt and one shared reopening attempt');
    assert.equal(app.home.data.checkinSubmitting, false, 'the visible page stays usable during background upload');
    resolveUpload({ success: true, data: { recordId: 'single-resume-cloud-row' } });
    await Promise.all([first, second]);
    assert.equal(app.calls.uploads.length, 2);
    assert.equal(app.rows().length, 1);
    assert.equal(app.rows()[0].syncStatus, 'synced');
    assert.equal(app.cloudRows.size, 1);
    assert.equal(app.manager.getUserStats().totalCount, 1);
  });
}

test('foreground resume retries durable state even when background timers never ran', async () => {
  const app = harness({ online: false });
  await app.record('sleep-resume');
  app.suspendFor(10 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 1, 'suspended timers are not assumed to keep running');
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, 2);
});

test('restarting after OS eviction rebuilds the upload queue without the old process timers', async () => {
  const app = harness({ online: false });
  await app.record('evicted-process');
  const localId = app.rows()[0].localId;
  app.suspendFor(10 * 60 * 1000);
  app.restart();
  app.setOnlineWithoutEvent(true);
  await app.app.onShow();
  assert.equal(app.rows()[0].localId, localId);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, 2);
});

test('returning to the home page after guest login uploads new guest records without an app resume event', async () => {
  const app = harness({ loggedIn: false });
  assert.equal((await app.record('guest-home-return')).cloudSynced, false);
  assert.equal(app.calls.uploads.length, 0);
  app.storage.set('userOpenId', OPENID);
  await app.home.onShow();
  await flush();
  assert.equal(app.rows().length, 1);
  assert.equal(app.rows()[0].syncOpenid, OPENID);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
});

test('login synchronization uploads a guest pending record even when its previous login flag is set', async () => {
  const app = harness({ loggedIn: false });
  await app.record('guest-login-sync');
  app.storage.set('userOpenId', OPENID);
  await app.manager.performLoginSync();
  await flush();
  assert.equal(app.rows()[0].syncStatus, 'synced', 'login cannot depend on a later page or network transition');
  assert.equal(app.cloudRows.size, 1);
});

test('a missing lock collection stays retryable with increasing bounded delay and recovers after the dependency is repaired', async () => {
  const app = harness({ missingLocks: true });
  await app.record('missing-lock-retry');
  let lastDelay = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = app.rows()[0];
    assert.equal(record.syncStatus, 'failed');
    assert.equal(record.syncErrorCode, 'MISSING_COLLECTION');
    assert.equal(record.syncBlocked, false);
    const delay = record.syncNextRetryAt - app.now;
    assert.ok(delay >= lastDelay && delay <= 300000);
    const count = app.calls.uploads.length;
    await app.advance(Math.max(0, delay - 1));
    assert.equal(app.calls.uploads.length, count, 'must not hammer a missing dependency before its retry deadline');
    await app.advance(1);
    assert.equal(app.calls.uploads.length, count + 1);
    lastDelay = delay;
  }
  app.repairLocks();
  await app.advance(app.rows()[0].syncNextRetryAt - app.now);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 12);
});

test('coordinated sync uploads before reading and reconciles canonical corrections, added rows and cloud deletions', async () => {
  const app = harness();
  app.manager.recordToLocal(12, ['旧情绪'], [], INITIAL_TIME - 1000, 'canonical-upload');
  const stored = app.storage.get(KEY);
  stored.dailyRecords['2026-09-20'].records.push({ _id: 'removed-in-cloud', localId: 'removed-in-cloud',
    date: '2026-09-20', timestamp: INITIAL_TIME - 2000, duration: 5, experience: [] });
  stored.dailyRecords['2026-09-20'].count++;
  app.setUploadHook(args => {
    const localId = args[4];
    app.cloudRows.set(localId, { _id: 'canonical-cloud', _openid: OPENID, localId,
      timestamp: INITIAL_TIME - 60000, date: '2026-09-20', duration: 30, emotion: ['平静'], experience: [] });
    app.cloudRows.set('another-device', { _id: 'another-device', _openid: OPENID, localId: 'another-device',
      timestamp: INITIAL_TIME - 120000, date: '2026-09-20', duration: 7, emotion: [], experience: [] });
    return { success: true, data: { recordId: 'canonical-cloud' } };
  });
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.success, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(app.calls.operations, ['upload', 'read']);
  assert.deepEqual(app.rows().map(record => record._id).sort(), ['another-device', 'canonical-cloud']);
  const corrected = app.rows().find(record => record._id === 'canonical-cloud');
  assert.equal(corrected.duration, 30);
  assert.equal(corrected.timestamp, INITIAL_TIME - 60000);
  assert.deepEqual(corrected.emotion, ['平静']);
  assert.equal(app.manager.getCurrentMonthMinutes(), 37);
});

test('concurrent coordinated entry points share one upload followed by one refresh', async () => {
  const app = harness();
  let resolveUpload;
  const upload = new Promise(resolve => { resolveUpload = resolve; });
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'concurrent-coordinator');
  app.setUploadHook(() => upload);
  const first = app.manager.syncWithCloud();
  const second = app.manager.syncWithCloud();
  const third = app.manager.syncWithCloud();
  assert.strictEqual(first, second);
  assert.strictEqual(first, third);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.calls.reads, 0, 'no cloud snapshot before upload confirmation');
  app.cloudRows.set('concurrent-coordinator', { _id: 'coordinated-row', localId: 'concurrent-coordinator',
    _openid: OPENID, timestamp: INITIAL_TIME - 1000, date: '2026-09-20', duration: 12, experience: [] });
  resolveUpload({ success: true, data: { recordId: 'coordinated-row' } });
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every(result => result.refreshed));
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.calls.reads, 1);
  assert.equal(app.rows().length, 1);
});

test('a force request upgrades an ordinary sync already reading during upload backoff', async () => {
  const app = harness({ online: false });
  await app.record('force-upgrade');
  app.setOnlineWithoutEvent(true);
  let resolveRead;
  const delayedRead = new Promise(resolve => { resolveRead = resolve; });
  app.setReadHook(index => index === 0 ? delayedRead : { success: true, data: clone([...app.cloudRows.values()]) });
  const normal = app.manager.syncWithCloud();
  await flush();
  assert.equal(app.calls.reads, 1);
  assert.equal(app.calls.uploads.length, 1, 'normal sync observes the existing backoff');
  const forced = app.manager.syncWithCloud({ force: true });
  assert.strictEqual(normal, forced);
  resolveRead({ success: true, data: [] });
  const result = await forced;
  assert.equal(result.refreshed, true);
  assert.equal(result.success, true);
  assert.equal(result.uploaded, 1);
  assert.equal(app.calls.uploads.length, 2);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.calls.reads, 2, 'the forced upload gets a subsequent fresh snapshot');
});

test('failed upload and failed refresh both retain the durable pending record and original identity', async () => {
  const app = harness({ online: false });
  await app.record('both-phases-offline');
  const before = clone(app.rows()[0]);
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.success, false);
  assert.equal(result.refreshed, false);
  assert.equal(result.pending, 1);
  assert.equal(app.rows().length, 1);
  assert.equal(app.rows()[0].localId, before.localId);
  assert.equal(app.rows()[0].timestamp, before.timestamp);
  assert.equal(app.rows()[0].syncStatus, 'failed');
});

test('successful upload survives a failed refresh and a later sync can reconcile it without reuploading', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'upload-then-read-fails');
  app.setReadHook(() => ({ success: false, code: 'NETWORK_ERROR', error: '读取失败' }));
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.uploaded, 1);
  assert.equal(result.refreshed, false);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.rows()[0]._id, 'cloud-upload-then-read-fails');
  app.setReadHook(undefined);
  assert.equal((await app.manager.syncWithCloud()).refreshed, true);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.rows().length, 1);
});

test('a failed cloud refresh schedules a five-second retry even with no pending uploads, then stops after success', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'refresh-only-retry');
  app.setReadHook(index => index === 0
    ? { success: false, code: 'NETWORK_ERROR', error: '读取暂时失败' }
    : { success: true, data: clone([...app.cloudRows.values()]).map(record => ({ ...record, duration: 25 })) });
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, false);
  assert.equal(result.pending, 0);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.calls.reads, 1);
  assert.equal(app.rows()[0].duration, 12);
  await app.advance(4999);
  assert.equal(app.calls.reads, 1, 'refresh failures must honor their retry delay');
  await app.advance(1);
  assert.equal(app.calls.reads, 2);
  assert.equal(app.calls.uploads.length, 1, 'a read retry must not repeat the confirmed upload');
  assert.equal(app.rows()[0].duration, 25);
  await app.advance(10 * 60 * 1000);
  assert.equal(app.calls.reads, 2, 'successful canonical refresh clears its retry timer');
});

test('a late old-account upload failure cannot cancel the current account\'s scheduled retry', async () => {
  const app = harness();
  let resolveOldUpload;
  const oldUpload = new Promise(resolve => { resolveOldUpload = resolve; });
  let currentAttempts = 0;
  app.setUploadHook(args => {
    if (args[4] === 'old-account-inflight') return oldUpload;
    currentAttempts++;
    if (currentAttempts === 1) return { success: false, code: 'NETWORK_ERROR', error: '新账号首次上传失败' };
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
  await app.record('current-account-pending');
  const deadline = app.rows().find(record => record.localId === 'current-account-pending').syncNextRetryAt;
  resolveOldUpload({ success: false, code: 'NETWORK_ERROR', error: '旧账号迟到的失败回调' });
  await previous;
  await app.advance(deadline - app.now);
  assert.equal(currentAttempts, 2, 'current account retains the timer created before the old callback');
  assert.equal(app.rows().find(record => record.localId === 'current-account-pending').syncStatus, 'synced');
  const old = app.rows().find(record => record.localId === 'old-account-inflight');
  assert.equal(old.syncOpenid, OPENID);
  assert.equal(old.syncStatus, 'failed');
  assert.equal(app.calls.uploads.filter(call => call.args[4] === 'old-account-inflight').length, 1);
});

test('when upload times out after commit and refresh confirms it, the final sync summary reflects no pending data', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'timeout-confirmed-on-read');
  app.setUploadHook(args => {
    app.cloudRows.set(args[4], { _id: 'actually-committed', _openid: OPENID, localId: args[4],
      timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] });
    return { success: false, code: 'NETWORK_ERROR', error: '确认超时' };
  });
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, true);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  assert.equal(result.pending, 0, 'summary must reflect the completed refresh, not its earlier failed upload');
  assert.equal(result.success, true);
});

test('forced coordinated sync is not swallowed by a direct ordinary upload drain already in flight', async () => {
  const app = harness({ online: false });
  await app.record('backoff-first');
  app.setOnlineWithoutEvent(true);
  app.manager.recordToLocal(8, [], [], INITIAL_TIME - 2000, 'uploading-second');
  let resolveUpload;
  const inFlight = new Promise(resolve => { resolveUpload = resolve; });
  app.setUploadHook(args => {
    const row = { _id: `cloud-${args[4]}`, _openid: OPENID, localId: args[4],
      timestamp: args[3], date: '2026-09-20', duration: args[0], emotion: args[1], experience: args[2] };
    app.cloudRows.set(args[4], row);
    return args[4] === 'uploading-second' ? inFlight : { success: true, data: { recordId: row._id } };
  });
  const ordinary = app.manager.retryPendingBackups();
  await flush();
  assert.equal(app.calls.uploads.length, 2, 'ordinary drain skipped first record in backoff and started second');
  const forced = app.manager.syncWithCloud({ force: true });
  resolveUpload({ success: true, data: { recordId: 'cloud-uploading-second' } });
  await ordinary;
  const result = await forced;
  assert.equal(result.success, true);
  assert.equal(result.pending, 0);
  assert.equal(app.calls.uploads.length, 3);
  assert.deepEqual(app.calls.uploads.map(call => call.args[4]), ['backoff-first', 'uploading-second', 'backoff-first']);
  assert.ok(app.rows().every(record => record.syncStatus === 'synced'));
});

test('coordinated sync waits for an earlier cloud snapshot and then obtains a post-upload canonical snapshot', async () => {
  const app = harness();
  app.manager.recordToLocal(12, [], [], INITIAL_TIME - 1000, 'snapshot-race');
  let resolveOldSnapshot;
  const oldSnapshot = new Promise(resolve => { resolveOldSnapshot = resolve; });
  app.setReadHook(index => index === 0 ? oldSnapshot : { success: true, data: clone([...app.cloudRows.values()]) });
  app.setUploadHook(args => {
    app.cloudRows.set(args[4], { _id: 'snapshot-canonical', localId: args[4], _openid: OPENID,
      duration: 21, timestamp: INITIAL_TIME - 5000, date: '2026-09-20', emotion: [], experience: [] });
    return { success: true, data: { recordId: 'snapshot-canonical' } };
  });
  const earlierRefresh = app.manager.refreshFromCloud();
  const sync = app.manager.syncWithCloud({ force: true });
  await flush();
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.calls.reads, 1, 'earlier outstanding snapshot must finish before the final new read');
  resolveOldSnapshot({ success: true, data: [] });
  await earlierRefresh;
  const result = await sync;
  assert.equal(result.refreshed, true);
  assert.equal(app.rows().length, 1);
  assert.equal(app.rows()[0]._id, 'snapshot-canonical');
  assert.equal(app.rows()[0].duration, 21);
  assert.equal(app.rows()[0].timestamp, INITIAL_TIME - 5000);
  assert.ok(app.calls.reads >= 2);
});

test('switching account during the final read stops synchronization without starting work for the new account', async () => {
  const app = harness();
  let resolveRead;
  const read = new Promise(resolve => { resolveRead = resolve; });
  app.setReadHook(() => read);
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
