const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-20T12:00:00+08:00');
const TIMESTAMP = NOW - 60 * 60 * 1000;
const LOCAL_USER = 'local-upload-queue';
const OPENID = 'oz-upload-queue';
const KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? undefined : structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));

function loadApiModule(filename, globals) {
  globals = { ...globals, wx: globals.wx && {
    getNetworkType: ({ success }) => success({ networkType: 'wifi' }), ...globals.wx
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', filename), 'utf8'), {
    module, exports: module.exports, ...globals,
    require(name) {
      assert.equal(name, './uploadNetwork.js');
      return loadApiModule('uploadNetwork.js', globals);
    }
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ loggedIn = true, backup, remove, nested = false, cloud = [], read } = {}) {
  let now = NOW;
  let failStorage = false;
  let nextTimer = 0;
  const timers = new Map();
  const cache = { dailyRecords: {}, monthlyStats: {}, userStats: {} };
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', loggedIn ? OPENID : ''],
    ['cacheStatus', 'initialized'], ['needsRecovery', false],
    [KEY, nested ? { checkinRecords: cache, experienceRecords: {} } : cache]
  ]);
  const calls = { backups: [], removes: [], reads: 0 };
  const api = {
    async recordMeditation(...args) {
      const index = calls.backups.length;
      calls.backups.push(clone(args));
      return backup ? backup(args, index) : { success: true, data: { recordId: `cloud-${index}` } };
    },
    async deleteMeditationRecord(identity) {
      calls.removes.push(clone(identity));
      return remove ? remove(identity) : { success: true };
    },
    async getAllRecords() { calls.reads++; return read ? read() : { success: true, data: clone(cloud) }; },
    async getUserStats() { return { success: true, data: {} }; }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function load(name, globals = {}) {
    globals = { ...globals, wx: globals.wx && {
      getNetworkType: ({ success }) => success({ networkType: 'wifi' }), ...globals.wx
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, Date: ClockDate,
      console: { log() {}, warn() {}, error() {} }, ...globals,
      require(name) {
        if (name === './uploadNetwork.js') return load('uploadNetwork.js', globals);
        return globals.require(name);
      }
    }, { filename: name });
    return module.exports;
  }
  function restart() {
    timers.clear();
    const dateUtil = load('dateUtil.js');
    return load('checkin.js', {
      setTimeout(callback, milliseconds) {
        const id = ++nextTimer;
        timers.set(id, { callback, at: now + Number(milliseconds || 0) });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      wx: {
        getStorageSync: key => clone(storage.get(key)),
        setStorageSync(key, value) {
          if (key === KEY && failStorage) throw new Error('device storage full');
          storage.set(key, clone(value));
        },
        removeStorageSync: key => storage.delete(key)
      },
      require(name) {
        if (name === './dateUtil.js') return dateUtil;
        if (name === './cloudApi.js') return api;
        if (name === './badgeManager.js') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
  }
  return {
    manager: restart(), restart, storage, calls, timers,
    advance(ms) { now += ms; },
    async runTimers(ms) {
      const until = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++count < 100, 'must not create an automatic retry loop');
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = until;
      await flush();
    },
    failStorage(value) { failStorage = value; },
    data() { const stored = storage.get(KEY); return stored.checkinRecords || stored; },
    records() { return Object.values(this.data().dailyRecords).flatMap(day => day.records); },
    summary(manager = this.manager) { return clone(manager.getPendingSyncSummary()); }
  };
}

function save(app, id = 'new-record', duration = 12, manager = app.manager) {
  return manager.recordToLocal(duration, ['平静'], [{ uniqueId: `${id}-note`, text: '记录体验' }], TIMESTAMP,
    { idempotencyKey: id, source: 'timer' });
}

async function settleWithRetries(app, promise) {
  await flush();
  await app.runTimers(300);
  return promise;
}

function withoutAttemptDeadline(args) {
  const payload = clone(args);
  if (payload[5]) delete payload[5].uploadDeadlineAt;
  return payload;
}

function uploadPayload(args) {
  const [duration, emotion, experience, timestamp, localId, options = {}] = args;
  return { duration, emotion, experience, timestamp, localId, source: options.source,
    date: options.source === 'manual' ? options.date : undefined, expectedOpenid: options.expectedOpenid };
}

test('transient failures wait exactly 100ms, stop after three retries and persist one failed round', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'NETWORK_ERROR', error: '暂时断网' }) });
  const states = [];
  app.manager.subscribeSyncState(() => states.push(app.summary()));
  const saving = app.manager.recordCheckinWithSync(12, ['平静'], ['原始体验'], TIMESTAMP, 'retry-limit');
  await flush();
  assert.equal(app.calls.backups.length, 1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await app.runTimers(99);
    assert.equal(app.calls.backups.length, attempt, 'a retry cannot start before 100ms');
    assert.equal(app.records()[0].syncStatus, 'uploading');
    assert.equal(app.records()[0].syncAttempts, undefined);
    assert.ok(states.every(state => state.failed === 0), 'intermediate failures stay within the active upload');
    await app.runTimers(1);
    assert.equal(app.calls.backups.length, attempt + 1);
  }
  const result = await saving;
  assert.equal(result.cloudSynced, false);
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.equal(app.records()[0].syncAttempts, 1);
  assert.equal(app.records()[0].syncErrorCode, 'NETWORK_ERROR');
  for (const args of app.calls.backups) {
    assert.deepEqual(withoutAttemptDeadline(args), withoutAttemptDeadline(app.calls.backups[0]));
  }
  assert.deepEqual(app.calls.backups.map(args => args[5].uploadDeadlineAt),
    [NOW + 3000, NOW + 3100, NOW + 3200, NOW + 3300]);
  assert.equal(app.timers.size, 0);
  await app.runTimers(60000);
  assert.equal(app.calls.backups.length, 4, 'exhausting a round never starts a later background upload');
});

for (const failures of [1, 2, 3]) {
  test(`upload stops retrying as soon as retry ${failures} succeeds`, async () => {
    const app = harness({ backup: (args, index) => index < failures
      ? { success: false, code: 'OFFLINE', error: '网络不可用' }
      : { success: true, data: { recordId: 'retry-confirmed' } } });
    const saving = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, `early-success-${failures}`);
    const result = await settleWithRetries(app, saving);
    assert.equal(result.cloudSynced, true);
    assert.equal(app.calls.backups.length, failures + 1);
    assert.equal(app.records()[0].syncStatus, 'synced');
    assert.equal(app.records()[0]._id, 'retry-confirmed');
    assert.equal(app.records()[0].syncAttempts, undefined);
    assert.equal(app.timers.size, 0);
    await app.runTimers(60000);
    assert.equal(app.calls.backups.length, failures + 1);
  });
}

for (const code of ['INVALID_RECORD', 'DATE_OUT_OF_RANGE', 'CONTENT_REJECTED', 'AMBIGUOUS_RECORD',
  'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'IDENTITY_MISMATCH']) {
  test(`${code} stops the upload without scheduling a retry`, async () => {
    const app = harness({ backup: () => ({ success: false, code, error: code }) });
    save(app, `terminal-${code}`);
    const result = await app.manager.asyncBackupToCloud(12, [], [], TIMESTAMP, `terminal-${code}`);
    assert.equal(result.success, false);
    assert.equal(result.code, code);
    assert.equal(app.records()[0].syncAttempts, 1);
    assert.equal(app.timers.size, 0);
    await app.runTimers(60000);
    assert.equal(app.calls.backups.length, 1);
  });
}

test('concurrent submissions share the same active upload while it waits to retry', async () => {
  const app = harness({ backup: (args, index) => index === 0
    ? { success: false, code: 'OFFLINE', error: '断网' }
    : { success: true, data: { recordId: 'shared-retry' } } });
  save(app, 'shared-retry');
  const upload = app.manager.asyncBackupToCloud(12, [], [], TIMESTAMP, 'shared-retry');
  await flush();
  const concurrent = app.manager.asyncBackupToCloud(90, ['修改'], ['修改'], TIMESTAMP, 'shared-retry');
  assert.strictEqual(concurrent, upload);
  const queue = app.manager.retryPendingBackups();
  await app.runTimers(100);
  await Promise.all([upload, concurrent, queue]);
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(withoutAttemptDeadline(app.calls.backups[1]), withoutAttemptDeadline(app.calls.backups[0]));
  assert.equal(app.records().length, 1);
});

for (const switchedKey of ['userOpenId', 'localUserId']) {
  test(`changing ${switchedKey} during the retry delay stops further uploads`, async () => {
    const app = harness({ backup: () => ({ success: false, code: 'OFFLINE', error: '断网' }) });
    const upload = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, `switched-${switchedKey}`);
    await flush();
    app.storage.set(switchedKey, switchedKey === 'userOpenId' ? 'oz-another-account' : 'another-local-account');
    await app.runTimers(100);
    await upload;
    assert.equal(app.calls.backups.length, 1);
    assert.equal(app.records()[0].syncOpenid, OPENID);
    assert.equal(app.timers.size, 0);
  });
}

test('deleting a record during the retry delay cancels further uploads', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'OFFLINE', error: '断网' }),
    remove: () => ({ success: false, code: 'RECORD_NOT_FOUND' }) });
  const record = save(app, 'delete-during-retry');
  const upload = app.manager.retryPendingBackups();
  await flush();
  const deletion = app.manager.deleteCheckin(record.date, { localId: record.localId });
  await app.runTimers(100);
  assert.equal((await deletion).success, true);
  await upload;
  assert.equal(app.calls.backups.length, 1);
  assert.deepEqual(app.records(), []);
  assert.equal(app.timers.size, 0);
});

test('cloud confirmation during the retry delay prevents another upload', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'TIMEOUT', error: '响应丢失' }), cloud: [{
    _id: 'retry-found-by-refresh', _openid: OPENID, localId: 'refresh-during-retry',
    duration: 12, timestamp: TIMESTAMP, date: '2026-09-20', experience: []
  }] });
  const upload = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'refresh-during-retry');
  await flush();
  assert.equal(await app.manager.refreshFromCloud(), true);
  await app.runTimers(100);
  assert.equal((await upload).cloudSynced, true);
  assert.equal(app.records()[0]._id, 'retry-found-by-refresh');
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.timers.size, 0);
});

test('a failure near the deadline gives its retry a fresh full three-second timeout', async () => {
  const first = deferred();
  const second = deferred();
  const app = harness({ backup: (args, index) => index === 0 ? first.promise : second.promise });
  save(app, 'retry-near-deadline');
  let settled = false;
  const upload = app.manager.syncWithCloud({ uploadPending: true });
  upload.then(() => { settled = true; });
  await app.runTimers(2950);
  first.resolve({ success: false, code: 'OFFLINE', error: '断网' });
  await flush();
  await app.runTimers(99);
  assert.equal(app.calls.backups.length, 1);
  await app.runTimers(1);
  assert.equal(app.calls.backups.length, 2);
  assert.equal(app.calls.backups[0][5].uploadDeadlineAt, NOW + 3000);
  assert.equal(app.calls.backups[1][5].uploadDeadlineAt, NOW + 6050);
  await app.runTimers(2999);
  assert.equal(settled, false);
  assert.equal(app.records()[0].syncStatus, 'uploading');
  second.resolve({ success: true, data: { recordId: 'fresh-timeout-success' } });
  assert.equal((await upload).success, true);
  assert.equal(app.calls.backups.length, 2);
  assert.equal(app.records()[0].syncStatus, 'synced');
  assert.equal(app.timers.size, 0);
});

for (const nested of [false, true]) {
  test(`new ${nested ? 'nested' : 'flat'} records persist upload state before a cloud request`, () => {
    const app = harness({ nested });
    const result = save(app);
    assert.equal(result.success, true);
    assert.equal(app.calls.backups.length, 0);
    const record = app.records()[0];
    assert.equal(record.localId, result.localId);
    assert.equal(record.syncVersion, 1);
    assert.equal(record.syncStatus, 'pending');
    assert.equal(record.syncOpenid, OPENID);
    assert.equal(record.timestamp, TIMESTAMP);
    assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 0 });
  });
}

test('missing-lock upload failure is durable while local completion and the original record survive', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'DATABASE_COLLECTION_NOT_EXIST', error: 'meditation_locks 集合不存在' }) });
  const result = await settleWithRetries(app,
    app.manager.recordCheckinWithSync(12, ['平静'], ['记录体验'], TIMESTAMP, 'lock-failure'));
  assert.equal(app.calls.backups.length, 4);
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, false);
  assert.equal(result.syncErrorCode, 'DATABASE_COLLECTION_NOT_EXIST');
  assert.match(result.syncError, /meditation_locks/);
  assert.equal(app.records().length, 1);
  const record = app.records()[0];
  assert.equal(record.localId, result.localId);
  assert.equal(record.syncStatus, 'failed');
  assert.equal(record.syncErrorCode, 'DATABASE_COLLECTION_NOT_EXIST');
  assert.equal(record.timestamp, TIMESTAMP);
  assert.equal(record.duration, 12);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 12);
  assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 1 });
});

test('a rejected network request also persists failure and can be retried after a fresh manager loads', async () => {
  const app = harness({ backup: (args, index) => {
    if (index < 4) throw new Error('request:fail timeout');
    return { success: true, data: { recordId: 'recovered-record' } };
  } });
  const result = await settleWithRetries(app,
    app.manager.recordCheckinWithSync(18, ['平静'], ['体验'], TIMESTAMP, 'restart-record'));
  assert.equal(result.cloudSynced, false);
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.ok(app.records()[0].syncError);
  const persisted = clone(app.records()[0]);
  const restarted = app.restart();
  app.advance(10 * 60 * 1000);
  const retried = await restarted.retryPendingBackups();
  assert.equal(retried.success, true);
  assert.equal(retried.uploaded, 1);
  assert.equal(retried.failed, 0);
  assert.equal(retried.pending, 0);
  assert.equal(app.calls.backups.length, 5);
  assert.deepEqual(uploadPayload(app.calls.backups[4]), uploadPayload(app.calls.backups[0]), 'retry reuses timestamp, local ID and payload');
  assert.equal(app.calls.backups[4][5].expectedOpenid, OPENID);
  const record = app.records()[0];
  assert.equal(record.localId, persisted.localId);
  assert.equal(record.timestamp, persisted.timestamp);
  assert.equal(record._id, 'recovered-record');
  assert.equal(record.syncStatus, 'synced');
  assert.ok(!record.syncError);
  assert.ok(!record.syncErrorCode);
  assert.deepEqual(app.summary(restarted), { total: 0, pending: 0, failed: 0 });
  await restarted.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 5, 'confirmed uploads must not be resent');
});

test('background reads and legacy force never retry pending uploads, including after restarting', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'OFFLINE', error: '网络不可用' }) });
  await settleWithRetries(app, app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'backoff-record'));
  assert.equal(app.calls.backups.length, 4);
  assert.equal(app.records()[0].syncNextRetryAt, undefined);
  await app.manager.syncWithCloud();
  await app.manager.syncWithCloud({ force: true });
  await app.restart().syncWithCloud({ force: true });
  await app.runTimers(10 * 60 * 1000);
  assert.equal(app.calls.backups.length, 4, 'reads, restarts and elapsed time cannot upload');
  assert.equal(app.timers.size, 0, 'failed uploads and reads schedule no automatic retries');
  const forced = await settleWithRetries(app, app.manager.syncWithCloud({ force: true, uploadPending: true }));
  assert.equal(app.calls.backups.length, 8);
  assert.equal(forced.failed, 1);
  assert.equal(forced.pending, 1);
  assert.equal(forced.refreshed, false);
  await settleWithRetries(app, app.manager.retryPendingBackups());
  assert.equal(app.calls.backups.length, 12);
  assert.equal(app.records()[0].syncAttempts, 3, 'attempt count tracks complete upload rounds');
});

test('deferred content rejection keeps the local check-in and stops automatic upload retries', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'CONTENT_REJECTED', error: '所发布内容含违规信息' }) });
  const saved = app.manager.recordCheckin(12, [], [{ text: '离线体验' }], TIMESTAMP, 'offline-moderation');
  assert.equal(saved.success, true);
  await flush();
  assert.equal(app.records().length, 1);
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.equal(app.records()[0].syncBlocked, true);
  assert.equal(app.records()[0].syncErrorCode, 'CONTENT_REJECTED');
  assert.equal(app.records()[0].experience[0].text, '离线体验');
  assert.equal(app.manager.getUserStats().totalCount, 1);
  app.advance(10 * 60 * 1000);
  await app.restart().syncWithCloud();
  assert.equal(app.calls.backups.length, 1, 'rejected content must not loop through automatic retries');
});

test('read refreshes and manual retries leave historical unversioned dirty records untouched', async () => {
  const app = harness();
  const legacy = {
    localId: 'legacy-local', timestamp: TIMESTAMP - 1000, duration: 50,
    date: '2026-09-20', emotion: [], experience: [], syncError: '旧上传错误'
  };
  app.data().dailyRecords['2026-09-20'] = { count: 1, lastCheckin: legacy.timestamp, records: [clone(legacy)] };
  save(app, 'new-versioned');
  assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 0 });
  await app.manager.retryPendingBackups();
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.calls.backups[0][4], 'new-versioned');
  assert.deepEqual(app.records().find(record => record.localId === legacy.localId), legacy);
});

test('pending summary filters by selected record date and excludes historical unversioned dirty rows', () => {
  const app = harness();
  const legacy = { localId: 'legacy-yesterday', timestamp: TIMESTAMP - 86400000, duration: 50,
    date: '2026-09-19', syncError: '旧记录失败', emotion: [], experience: [] };
  app.data().dailyRecords['2026-09-19'] = { count: 1, lastCheckin: legacy.timestamp, records: [legacy] };
  app.manager.recordToLocal(12, [], [], TIMESTAMP - 86400000,
    { idempotencyKey: 'pending-yesterday', source: 'manual', date: '2026-09-19' });
  save(app, 'pending-today');
  app.records().find(record => record.localId === 'pending-yesterday').syncStatus = 'failed';
  assert.deepEqual(app.summary(), { total: 2, pending: 2, failed: 1 });
  assert.deepEqual(clone(app.manager.getPendingSyncSummary({ date: '2026-09-19' })), { total: 1, pending: 1, failed: 1 });
  assert.deepEqual(clone(app.manager.getPendingSyncSummary({ date: '2026-09-20' })), { total: 1, pending: 1, failed: 0 });
  assert.deepEqual(clone(app.manager.getPendingSyncSummary({ date: '2026-09-18' })), { total: 0, pending: 0, failed: 0 });
  assert.equal(app.calls.backups.length, 0);
});

for (const nested of [false, true]) {
  test(`upload preview reads all dates from ${nested ? 'nested' : 'flat'} storage and includes only eligible waiting records`, async () => {
    const response = deferred();
    const app = harness({ nested, backup: () => response.promise });
    app.manager.recordToLocal(18, [], [], TIMESTAMP - 86400000,
      { idempotencyKey: 'preview-yesterday', source: 'manual', date: '2026-09-19' });
    for (const id of ['preview-today', 'preview-blocked', 'preview-confirmed', 'preview-other-account', 'preview-guest']) {
      save(app, id);
    }
    Object.assign(app.records().find(record => record.localId === 'preview-blocked'), {
      syncStatus: 'failed', syncBlocked: true, syncError: '已超出补录期限', syncErrorCode: 'DATE_OUT_OF_RANGE'
    });
    app.records().find(record => record.localId === 'preview-confirmed')._id = 'confirmed-cloud-id';
    app.records().find(record => record.localId === 'preview-other-account').syncOpenid = 'oz-someone-else';
    delete app.records().find(record => record.localId === 'preview-guest').syncOpenid;
    app.data().dailyRecords['2026-09-19'].records.push({
      localId: 'preview-legacy', timestamp: TIMESTAMP - 86400000, duration: 10,
      date: '2026-09-19', syncStatus: 'failed', syncError: '旧缓存错误'
    });
    app.manager.recordCheckin(12, [], [], TIMESTAMP, 'preview-uploading');
    await flush();
    if (nested) app.storage.set(KEY, { checkinRecords: clone(app.data()), experienceRecords: {} });

    const preview = clone(app.manager.getPendingUploadEntries());
    assert.deepEqual(preview.map(({ date, record }) => [date, record.localId]), [
      ['2026-09-19', 'preview-yesterday'], ['2026-09-20', 'preview-today'],
      ['2026-09-20', 'preview-blocked'], ['2026-09-20', 'preview-guest']
    ]);
    assert.equal(preview.find(({ record }) => record.localId === 'preview-blocked').record.syncBlocked, true);
    assert.deepEqual(clone(app.manager.getPendingUploadEntries({ date: '2026-09-19' }))
      .map(({ record }) => record.localId), ['preview-yesterday']);
    assert.deepEqual(clone(app.manager.getPendingUploadEntries({ date: '2026-09-18' })), []);
    assert.equal(app.calls.reads, 0, 'preview is derived from persisted upload state without fetching cloud data');
    assert.equal(app.calls.backups.length, 1, 'opening preview cannot start uploads');
    response.resolve({ success: true, data: { recordId: 'preview-active-finished' } });
    await flush();
  });
}

for (const method of ['retryPendingBackups', 'syncWithCloud']) {
  test(`${method} uploads only the specified cross-date identities once`, async () => {
    const app = harness();
    app.manager.recordToLocal(18, [], [], TIMESTAMP - 86400000,
      { idempotencyKey: 'selected-yesterday', source: 'manual', date: '2026-09-19' });
    save(app, 'selected-today');
    save(app, 'unselected-today');
    const result = await app.manager[method]({ uploadPending: true,
      localIds: ['selected-today', 'selected-yesterday', 'selected-today', 'missing-record'] });
    assert.deepEqual(app.calls.backups.map(args => args[4]), ['selected-yesterday', 'selected-today']);
    assert.equal(result.total, 2);
    assert.equal(result.uploaded, 2);
    assert.equal(result.pending, 1, 'remaining pending count still covers the whole account');
    assert.equal(app.records().find(record => record.localId === 'unselected-today').syncStatus, 'pending');
  });

  test(`${method} treats an empty selection as no upload, including during another active queue`, async () => {
    const response = deferred();
    const app = harness({ backup: () => response.promise });
    save(app, 'empty-selection-pending');
    const empty = await app.manager[method]({ uploadPending: true, localIds: [] });
    assert.equal(empty.total, 0);
    assert.equal(empty.uploaded, 0);
    assert.equal(app.calls.backups.length, 0);
    const active = app.manager[method]({ uploadPending: true, localIds: ['empty-selection-pending'] });
    const concurrentEmpty = await app.manager[method]({ uploadPending: true, localIds: [] });
    assert.equal(concurrentEmpty.total, 0);
    assert.equal(concurrentEmpty.uploaded, 0);
    assert.equal(app.calls.backups.length, 1);
    response.resolve({ success: true, data: { recordId: 'active-selection-finished' } });
    await active;
  });
}

test('confirmed preview uploads skip records confirmed or deleted since preview and do not include newly added records', async () => {
  const app = harness({ remove: () => ({ success: false, code: 'RECORD_NOT_FOUND' }) });
  for (const id of ['preview-remains', 'preview-now-confirmed', 'preview-now-deleted']) save(app, id);
  const localIds = app.manager.getPendingUploadEntries().map(({ record }) => record.localId);
  save(app, 'added-after-preview');
  const confirmed = app.records().find(record => record.localId === 'preview-now-confirmed');
  Object.assign(confirmed, { _id: 'confirmed-after-preview', syncStatus: 'synced' });
  assert.equal((await app.manager.deleteCheckin('2026-09-20', { localId: 'preview-now-deleted' })).success, true);
  const result = await app.manager.syncWithCloud({ uploadPending: true, localIds });
  assert.deepEqual(app.calls.backups.map(args => args[4]), ['preview-remains']);
  assert.equal(result.uploaded, 1);
  assert.equal(result.pending, 1);
  assert.equal(app.records().find(record => record.localId === 'added-after-preview').syncStatus, 'pending');
  assert.equal(app.records().some(record => record.localId === 'preview-now-deleted'), false);
});

test('a selected record newly confirmed during another upload is rechecked and skipped', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  save(app, 'selected-inflight');
  save(app, 'selected-later-confirmed');
  const localIds = app.manager.getPendingUploadEntries().map(({ record }) => record.localId);
  const upload = app.manager.syncWithCloud({ uploadPending: true, localIds });
  await flush();
  Object.assign(app.records().find(record => record.localId === 'selected-later-confirmed'),
    { _id: 'other-request-confirmed', syncStatus: 'synced' });
  response.resolve({ success: true, data: { recordId: 'selected-inflight-confirmed' } });
  assert.equal((await upload).success, true);
  assert.deepEqual(app.calls.backups.map(args => args[4]), ['selected-inflight']);
});

test('an account switch after preview cannot upload the original account selection', async () => {
  const app = harness();
  save(app, 'selected-account-a');
  const localIds = app.manager.getPendingUploadEntries().map(({ record }) => record.localId);
  app.storage.set('userOpenId', 'oz-preview-account-b');
  assert.deepEqual(clone(app.manager.getPendingUploadEntries()), []);
  await app.manager.syncWithCloud({ uploadPending: true, localIds });
  assert.equal(app.calls.backups.length, 0);
  assert.equal(app.records()[0].syncStatus, 'pending');
});

test('concurrent retries and caller mutations cannot widen the fixed preview selection', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  save(app, 'fixed-preview-record');
  save(app, 'outside-preview');
  const localIds = ['fixed-preview-record'];
  const upload = app.manager.syncWithCloud({ uploadPending: true, localIds });
  localIds.push('outside-preview');
  const concurrent = app.manager.syncWithCloud({ uploadPending: true });
  assert.strictEqual(concurrent, upload);
  const directRetry = app.manager.retryPendingBackups({ localIds: ['outside-preview'] });
  response.resolve({ success: true, data: { recordId: 'fixed-preview-confirmed' } });
  await Promise.all([upload, concurrent, directRetry]);
  assert.deepEqual(app.calls.backups.map(args => args[4]), ['fixed-preview-record']);
  assert.equal(app.records().find(record => record.localId === 'outside-preview').syncStatus, 'pending');
});

test('recordCheckin keeps its synchronous local interface and concurrent retry does not duplicate its request', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  const local = app.manager.recordCheckin(12, [], [], TIMESTAMP, 'sync-interface');
  assert.equal(local.success, true);
  assert.equal(typeof local.then, 'undefined');
  assert.equal(app.records().length, 1);
  const retry = app.manager.retryPendingBackups({ force: true });
  const secondRetry = app.manager.retryPendingBackups({ force: true });
  await flush();
  assert.equal(app.calls.backups.length, 1);
  response.resolve({ success: true, data: { recordId: 'single-cloud-row' } });
  await Promise.all([retry, secondRetry]);
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records().length, 1);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 12);
});

test('several retry entry points share one serial queue and do not inflate statistics', async () => {
  const first = deferred();
  const second = deferred();
  let active = 0, maxActive = 0;
  const app = harness({ backup: async (args, index) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const result = await (index === 0 ? first.promise : second.promise);
    active--;
    return result;
  } });
  save(app, 'queued-one', 10);
  save(app, 'queued-two', 20);
  const retries = [app.manager.retryPendingBackups(), app.manager.retryPendingBackups({ force: true }), app.manager.retryPendingBackups()];
  await flush();
  assert.equal(app.calls.backups.length, 1);
  first.resolve({ success: true, data: { recordId: 'cloud-one' } });
  await flush();
  assert.equal(app.calls.backups.length, 2);
  second.resolve({ success: true, data: { recordId: 'cloud-two' } });
  await Promise.all(retries);
  assert.equal(maxActive, 1);
  assert.deepEqual(app.calls.backups.map(args => args[4]), ['queued-one', 'queued-two']);
  assert.equal(app.manager.getUserStats().totalCount, 2);
  assert.equal(app.manager.getCurrentMonthMinutes(), 30);
});

test('manual uploads give subsequent records fresh timeouts and stop after one record exhausts its retries', async () => {
  const first = deferred();
  const hung = deferred();
  const app = harness({ backup: (args, index) => index === 0 ? first.promise : hung.promise });
  save(app, 'budget-first');
  save(app, 'budget-timeout');
  save(app, 'budget-untouched');
  let settled = false;
  const upload = app.manager.syncWithCloud({ uploadPending: true });
  assert.strictEqual(app.manager.syncWithCloud({ force: true, uploadPending: true }), upload);
  upload.then(() => { settled = true; });
  await app.runTimers(2500);
  first.resolve({ success: true, data: { recordId: 'first-finished' } });
  await flush();
  assert.equal(app.calls.backups.length, 2);
  assert.equal(app.calls.backups[0][5].uploadDeadlineAt, NOW + 3000);
  assert.equal(app.calls.backups[1][5].uploadDeadlineAt, NOW + 5500);
  await app.runTimers(12299);
  assert.equal(settled, false);
  assert.equal(app.records()[1].syncStatus, 'uploading');
  await app.runTimers(1);
  assert.equal(settled, true);
  const result = await upload;
  assert.equal(result.code, 'CLOUD_TIMEOUT');
  assert.equal(result.refreshed, false);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 2);
  assert.equal(app.calls.reads, 0, 'manual upload never adds a serial cloud refresh');
  assert.deepEqual(app.calls.backups.map(args => args[4]),
    ['budget-first', 'budget-timeout', 'budget-timeout', 'budget-timeout', 'budget-timeout']);
  assert.deepEqual(app.calls.backups.map(args => args[5].uploadDeadlineAt),
    [NOW + 3000, NOW + 5500, NOW + 8600, NOW + 11700, NOW + 14800]);
  assert.equal(app.records()[1].syncStatus, 'failed');
  assert.equal(app.records()[1].syncErrorCode, 'CLOUD_TIMEOUT');
  assert.equal(app.records()[1].syncAttempts, 1);
  assert.equal(app.records()[2].syncStatus, 'pending');
  assert.equal(app.records()[2].syncAttempts, undefined);
  assert.equal(app.timers.size, 0);
  hung.resolve({ success: true, data: { recordId: 'late-result' } });
  await flush();
  assert.equal(app.records()[1].syncStatus, 'failed', 'late results cannot overwrite an exhausted upload');
  assert.equal(app.records()[1]._id, undefined);
});

test('four hung attempts each time out after three seconds and persist one failure at 12300ms', async () => {
  const app = harness({ backup: () => new Promise(() => {}) });
  let settled = false;
  const saving = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'first-timeout');
  saving.then(() => { settled = true; });
  assert.equal(app.records()[0].syncStatus, 'uploading');
  assert.deepEqual(app.summary(), { total: 1, pending: 0, failed: 0 });
  for (let attempt = 0; attempt < 4; attempt++) {
    await app.runTimers(2999);
    assert.equal(settled, false);
    assert.equal(app.calls.backups.length, attempt + 1);
    assert.equal(app.records()[0].syncStatus, 'uploading');
    await app.runTimers(1);
    if (attempt < 3) {
      assert.equal(settled, false);
      await app.runTimers(99);
      assert.equal(app.calls.backups.length, attempt + 1);
      await app.runTimers(1);
      assert.equal(app.calls.backups.length, attempt + 2);
    }
  }
  const result = await saving;
  assert.equal(settled, true);
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, false);
  assert.equal(result.syncErrorCode, 'CLOUD_TIMEOUT');
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.equal(app.records()[0].syncAttempts, 1);
  assert.deepEqual(app.calls.backups.map(args => args[5].uploadDeadlineAt),
    [NOW + 3000, NOW + 6100, NOW + 9200, NOW + 12300]);
  assert.equal(app.timers.size, 0);
  const restarted = app.restart();
  await restarted.recordCheckinWithSync(12, [], [], TIMESTAMP, 'first-timeout');
  await app.runTimers(60000);
  assert.equal(app.calls.backups.length, 4, 'repeated submission cannot start a new upload round');
  assert.equal(app.records().length, 1);
});

for (const nested of [false, true]) {
  test(`interrupted ${nested ? 'nested' : 'flat'} uploading state becomes manual-only after a restart`, async () => {
    const app = harness({ nested, backup: () => new Promise(() => {}) });
    app.manager.recordCheckin(12, [], [], TIMESTAMP, 'interrupted-first-attempt');
    await flush();
    assert.equal(app.records()[0].syncStatus, 'uploading');
    assert.deepEqual(app.summary(), { total: 1, pending: 0, failed: 0 });
    if (nested) app.storage.set(KEY, { checkinRecords: clone(app.data()), experienceRecords: {} });
    const restarted = app.restart();
    const record = restarted.getUserCheckinData().dailyRecords['2026-09-20'].records[0];
    assert.equal(record.syncStatus, 'pending');
    assert.deepEqual(app.summary(restarted), { total: 1, pending: 1, failed: 0 });
    await restarted.syncWithCloud();
    await app.runTimers(60000);
    assert.equal(app.calls.backups.length, 1, 'reopening and refreshing do not restart the upload');
    assert.equal(app.records()[0].syncStatus, 'pending');
  });
}

test('cloud refresh during the initial upload preserves uploading without exposing a manual pending count', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  const states = [];
  app.manager.subscribeSyncState(() => states.push(app.summary()));
  const saving = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'initial-upload-refresh');
  await app.manager.syncWithCloud();
  assert.equal(app.records()[0].syncStatus, 'uploading');
  assert.equal(app.summary().pending, 0);
  assert.equal(app.summary().total, 1);
  response.resolve({ success: true, data: { recordId: 'confirmed-first-upload' } });
  assert.equal((await saving).cloudSynced, true);
  assert.ok(states.every(state => state.pending === 0));
  assert.equal(app.records()[0].syncStatus, 'synced');
  assert.equal(app.calls.backups.length, 1);
});

test('manual upload is independent of a suspended read and stops at the first failed record', async () => {
  const reading = deferred();
  const app = harness({ read: () => reading.promise,
    backup: () => ({ success: false, code: 'NETWORK_ERROR', error: '离线' }) });
  save(app, 'failed-first');
  save(app, 'unattempted-second');
  const read = app.manager.syncWithCloud({ force: true });
  assert.equal(app.calls.reads, 1);
  const result = await settleWithRetries(app, app.manager.syncWithCloud({ uploadPending: true }));
  assert.equal(result.success, false);
  assert.equal(result.code, 'NETWORK_ERROR');
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 2);
  assert.equal(result.refreshed, false);
  assert.equal(app.calls.backups.length, 4);
  assert.equal(app.records()[1].syncStatus, 'pending');
  reading.resolve({ success: false, code: 'NETWORK_ERROR' });
  await read;
  await app.runTimers(60000);
  assert.equal(app.calls.backups.length, 4);
  assert.equal(app.calls.reads, 1);
});

test('already blocked and newly rejected rows do not prevent manual upload of the remaining valid records', async () => {
  const app = harness({ backup: args => args[4] === 'newly-rejected'
    ? { success: false, code: 'CONTENT_REJECTED', error: '所发布内容含违规信息' }
    : { success: true, data: { recordId: 'valid-cloud-row' } } });
  save(app, 'already-expired');
  save(app, 'newly-rejected');
  save(app, 'valid-record');
  Object.assign(app.records()[0], { syncBlocked: true, syncStatus: 'failed',
    syncErrorCode: 'DATE_OUT_OF_RANGE', syncError: '已超出补录期限' });
  const result = await app.manager.syncWithCloud({ uploadPending: true });
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 2);
  assert.deepEqual(app.calls.backups.map(args => args[4]), ['newly-rejected', 'valid-record']);
  assert.equal(app.records()[0].syncBlocked, true);
  assert.equal(app.records()[1].syncBlocked, true);
  assert.equal(app.records()[2].syncStatus, 'synced');
  await app.manager.syncWithCloud({ uploadPending: true });
  assert.equal(app.calls.backups.length, 2, 'terminal failures stay local without repeatedly blocking the queue');
});

test('a success arriving at exactly three seconds before its timer callback still requires a retry', async () => {
  const response = deferred();
  const app = harness({ backup: (args, index) => index === 0 ? response.promise
    : { success: true, data: { recordId: 'boundary-retry-confirmed' } } });
  save(app, 'boundary-response');
  const saving = app.manager.syncWithCloud({ uploadPending: true });
  app.advance(3000);
  response.resolve({ success: true, data: { recordId: 'too-late' } });
  await flush();
  assert.equal(app.records()[0].syncStatus, 'uploading');
  assert.equal(app.records()[0]._id, undefined);
  await app.runTimers(99);
  assert.equal(app.calls.backups.length, 1);
  await app.runTimers(1);
  const result = await saving;
  assert.equal(result.success, true);
  assert.equal(result.pending, 0);
  assert.equal(app.calls.backups.length, 2);
  assert.equal(app.records()[0]._id, 'boundary-retry-confirmed');
  assert.equal(app.timers.size, 0);
});

test('a first-attempt timeout can recover on the second attempt and ignores the first late success', async () => {
  const first = deferred();
  const second = deferred();
  const app = harness({ backup: (args, index) => index === 0 ? first.promise : second.promise });
  const saving = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'timeout-then-success');
  await app.runTimers(3000);
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records()[0].syncStatus, 'uploading');
  await app.runTimers(99);
  assert.equal(app.calls.backups.length, 1);
  await app.runTimers(1);
  assert.equal(app.calls.backups.length, 2);
  assert.equal(app.calls.backups[1][5].uploadDeadlineAt, NOW + 6100);
  first.resolve({ success: true, data: { recordId: 'late-first-attempt' } });
  await flush();
  assert.equal(app.records()[0].syncStatus, 'uploading');
  assert.equal(app.records()[0]._id, undefined, 'a timed-out request cannot acknowledge an active retry');
  second.resolve({ success: true, data: { recordId: 'second-attempt-confirmed' } });
  assert.equal((await saving).cloudSynced, true);
  assert.equal(app.records()[0]._id, 'second-attempt-confirmed');
  assert.equal(app.records()[0].syncAttempts, undefined);
  assert.equal(app.timers.size, 0);
  await app.runTimers(60000);
  assert.equal(app.calls.backups.length, 2);
});

test('login and the legacy local sync entry point read cloud state without uploading guest records', async () => {
  const app = harness({ loggedIn: false });
  save(app, 'guest-waits-for-button');
  app.storage.set('userOpenId', OPENID);
  app.storage.set('hasSyncedOnLogin', true);
  await app.manager.performLoginSync();
  await app.manager.syncLocalToCloud(LOCAL_USER, OPENID);
  assert.equal(app.calls.backups.length, 0);
  assert.equal(app.records()[0].syncStatus, 'pending');
  const result = await app.manager.syncWithCloud({ uploadPending: true });
  assert.equal(result.uploaded, 1);
  assert.equal(app.records()[0].syncStatus, 'synced');
});

test('a timed-out stable identity is retried from its saved payload even if the submit form has changed', async () => {
  const app = harness({ backup: (args, index) => index < 4
    ? { success: false, code: 'TIMEOUT', error: '结果未知' }
    : { success: true, data: { recordId: 'server-already-saved', duplicate: true } } });
  await settleWithRetries(app,
    app.manager.recordCheckinWithSync(12, ['平静'], ['原始体验'], TIMESTAMP, 'stable-timeout'));
  const result = await app.manager.recordCheckinWithSync(90, ['疲倦'], ['修改过的表单'], NOW, 'stable-timeout');
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, false);
  assert.equal(app.calls.backups.length, 4, 'resubmitting a saved record cannot implicitly retry its upload');
  const retry = await app.manager.syncWithCloud({ uploadPending: true });
  assert.equal(retry.success, true);
  assert.equal(app.calls.backups.length, 5);
  assert.deepEqual(uploadPayload(app.calls.backups[4]), uploadPayload(app.calls.backups[0]));
  assert.equal(app.records().length, 1);
  assert.equal(app.records()[0].timestamp, TIMESTAMP);
  assert.equal(app.records()[0].duration, 12);
  assert.equal(app.manager.getUserStats().totalCount, 1);
});

test('repeated successful submission of the same identity returns confirmation without another upload', async () => {
  const app = harness();
  const first = await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'already-confirmed');
  assert.equal(first.cloudSynced, true);
  const second = await app.restart().recordCheckinWithSync(12, [], [], TIMESTAMP, 'already-confirmed');
  assert.equal(second.cloudSynced, true);
  assert.equal(first.localId, second.localId);
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records().length, 1);
});

test('manual check-in retry preserves its selected date, source, experience and original timestamp', async () => {
  const app = harness({ backup: (args, index) => index < 4
    ? { success: false, code: 'OFFLINE', error: '网络不可用' }
    : { success: true, data: { recordId: 'manual-confirmed' } } });
  const timestamp = TIMESTAMP - 86400000;
  const options = { source: 'manual', date: '2026-09-19', idempotencyKey: 'manual-retry' };
  const result = await settleWithRetries(app,
    app.manager.recordCheckinWithSync(23, ['平静'], ['补记体验'], timestamp, options));
  assert.equal(result.cloudSynced, false);
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 5);
  assert.deepEqual(uploadPayload(app.calls.backups[4]), uploadPayload(app.calls.backups[0]));
  assert.equal(app.calls.backups[4][3], timestamp);
  assert.equal(app.calls.backups[4][5].source, 'manual');
  assert.equal(app.calls.backups[4][5].date, '2026-09-19');
  assert.equal(app.records()[0].date, '2026-09-19');
  assert.equal(app.records()[0].syncStatus, 'synced');
});

test('failure to persist a new local record cannot start a cloud request', async () => {
  const app = harness();
  app.failStorage(true);
  await assert.rejects(app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'not-persisted'));
  assert.equal(app.calls.backups.length, 0);
  assert.deepEqual(app.records(), []);
});

test('switching accounts cannot upload another account\'s pending records', async () => {
  const app = harness();
  save(app, 'belongs-to-a');
  const original = clone(app.records()[0]);
  app.storage.set('userOpenId', 'oz-other-account');
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 0);
  assert.deepEqual(app.records()[0], original);
  app.storage.set('userOpenId', OPENID);
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.calls.backups[0][5].expectedOpenid, OPENID);
});

test('account switch while a queue is in flight stops its remaining uploads', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  save(app, 'owner-a-first');
  save(app, 'owner-a-second');
  const retry = app.manager.retryPendingBackups({ force: true });
  await flush();
  app.storage.set('userOpenId', 'oz-other-account');
  response.resolve({ success: true, data: { recordId: 'owner-a-cloud' } });
  await retry;
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.calls.backups[0][5].expectedOpenid, OPENID);
  assert.equal(app.records().find(record => record.localId === 'owner-a-second').syncOpenid, OPENID);
  assert.ok(!app.records().find(record => record.localId === 'owner-a-second')._id);
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
});

test('guest check-in is retained and binds its first logged-in owner durably before sending', async () => {
  let app;
  app = harness({ loggedIn: false, backup: args => {
    assert.equal(app.records()[0].syncOpenid, OPENID, 'owner must already be persisted when sending');
    assert.equal(args[5].expectedOpenid, OPENID);
    return { success: true, data: { recordId: 'guest-uploaded' } };
  } });
  const result = await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'guest-record');
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, false);
  assert.equal(app.calls.backups.length, 0);
  assert.equal(app.records()[0].syncStatus, 'pending');
  assert.ok(!app.records()[0].syncOpenid);
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 0);
  app.storage.set('userOpenId', OPENID);
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records()[0].syncStatus, 'synced');
});

test('guest owner binding storage failure prevents sending an untracked cloud upload', async () => {
  const app = harness({ loggedIn: false });
  save(app, 'guest-storage-failure');
  app.storage.set('userOpenId', OPENID);
  app.failStorage(true);
  const result = await app.manager.retryPendingBackups({ force: true });
  assert.equal(result.success, false);
  assert.equal(app.calls.backups.length, 0);
  assert.ok(!app.records()[0].syncOpenid);
  app.failStorage(false);
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records()[0].syncStatus, 'synced');
});

for (const response of [{ success: true }, { success: true, data: {} }]) {
  test(`a success response without recordId cannot mark a record synced (${JSON.stringify(response)})`, async () => {
    const app = harness({ backup: () => response });
    const result = await settleWithRetries(app,
      app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'missing-cloud-id'));
    assert.equal(app.calls.backups.length, 4);
    assert.equal(result.success, true);
    assert.equal(result.cloudSynced, false);
    assert.ok(result.syncError);
    assert.ok(!app.records()[0]._id);
    assert.equal(app.records()[0].syncStatus, 'failed');
    assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 1 });
  });
}

test('deleting a queued record during another upload prevents it from being resurrected by the queue snapshot', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise,
    remove: () => ({ success: false, code: 'RECORD_NOT_FOUND' }) });
  save(app, 'queue-survivor');
  const deleted = save(app, 'queue-deleted');
  const retry = app.manager.retryPendingBackups({ force: true });
  await flush();
  assert.equal((await app.manager.deleteCheckin(deleted.date, { localId: deleted.localId })).success, true);
  response.resolve({ success: true, data: { recordId: 'survivor-cloud' } });
  await retry;
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.deepEqual(app.records().map(record => record.localId), ['queue-survivor']);
});

test('deleting an in-flight pending record waits for upload and removes its exact confirmed cloud identity', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise });
  const record = save(app, 'inflight-deleted');
  const retry = app.manager.retryPendingBackups({ force: true });
  await flush();
  const deletion = app.manager.deleteCheckin(record.date, { localId: record.localId });
  assert.equal(app.calls.removes.length, 0);
  response.resolve({ success: true, data: { recordId: 'remove-this-cloud-row' } });
  assert.equal((await deletion).success, true);
  await retry;
  assert.equal(app.calls.removes[0].recordId, 'remove-this-cloud-row');
  assert.equal(app.calls.removes[0].localId, record.localId);
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.deepEqual(app.records(), []);
});

test('sync subscribers observe persisted failure and recovery, and unsubscribe stops later notifications', async () => {
  const app = harness({ backup: (args, index) => index < 4
    ? { success: false, code: 'OFFLINE', error: '离线' }
    : { success: true, data: { recordId: `subscribed-${index}` } } });
  const snapshots = [];
  const unsubscribe = app.manager.subscribeSyncState(() => snapshots.push(app.summary()));
  await settleWithRetries(app, app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'subscription-record'));
  assert.ok(snapshots.some(summary => summary.pending === 1 && summary.failed === 1));
  await app.manager.retryPendingBackups({ force: true });
  assert.deepEqual(snapshots.at(-1), { total: 0, pending: 0, failed: 0 });
  unsubscribe();
  const count = snapshots.length;
  await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'unsubscribed-record');
  assert.equal(snapshots.length, count);
});

for (const method of ['refreshFromCloud', 'safeRecoverFromCloud', 'recoverUserDataFromCloud']) {
  test(`${method} with an empty cloud preserves pending owner, failure details and retry eligibility`, async () => {
    const app = harness({ backup: (args, index) => index < 4
      ? { success: false, code: 'NETWORK_ERROR', error: '断网' }
      : { success: true, data: { recordId: 'recovered-after-refresh' } } });
    await settleWithRetries(app, app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'refresh-pending'));
    const before = clone(app.records()[0]);
    assert.equal(await app.manager[method](LOCAL_USER), true);
    const after = app.records()[0];
    for (const key of ['localId', 'timestamp', 'duration', 'syncVersion', 'syncStatus', 'syncOpenid',
      'syncError', 'syncErrorCode', 'syncAttempts', 'syncNextRetryAt', 'syncBlocked']) {
      assert.deepEqual(after[key], before[key], `${method} must preserve ${key}`);
    }
    assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 1 });
    const restarted = app.restart();
    await restarted.retryPendingBackups({ force: true });
    assert.equal(app.calls.backups.length, 5);
    assert.equal(app.records()[0].syncStatus, 'synced');
    assert.equal(app.manager.getUserStats().totalCount, 1);
  });
}

test('refresh discovers a timed-out cloud commit by local identity and clears all retry state without another upload', async () => {
  const cloud = [];
  const app = harness({ cloud, backup: (args, index) => {
    const [duration, emotion, experience, timestamp, localId] = args;
    if (index === 0) cloud.push({ _id: 'timeout-actually-committed', _openid: OPENID, duration, emotion, experience,
      timestamp, localId, date: '2026-09-20' });
    return { success: false, code: 'TIMEOUT', error: '服务器已保存，但客户端没收到结果' };
  } });
  await settleWithRetries(app, app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'found-by-refresh'));
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.equal(await app.manager.refreshFromCloud(), true);
  const record = app.records()[0];
  assert.equal(app.records().length, 1);
  assert.equal(record.syncVersion, 1);
  assert.equal(record.syncOpenid, OPENID);
  assert.equal(record.syncStatus, 'synced');
  assert.equal(record._id, 'timeout-actually-committed');
  for (const key of ['syncError', 'syncErrorCode', 'syncAttempts', 'syncNextRetryAt', 'syncBlocked']) {
    assert.equal(Object.hasOwn(record, key), false, `${key} is obsolete after cloud confirmation`);
  }
  assert.deepEqual(app.summary(), { total: 0, pending: 0, failed: 0 });
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 4);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 12);
});

test('a late failed upload response cannot undo cloud confirmation already discovered by refresh', async () => {
  const response = deferred();
  const app = harness({ backup: () => response.promise, cloud: [{
    _id: 'confirmed-by-refresh', _openid: OPENID, localId: 'late-response',
    duration: 12, timestamp: TIMESTAMP, date: '2026-09-20', experience: []
  }] });
  const submission = app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'late-response');
  await flush();
  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.equal(app.records()[0].syncStatus, 'synced');
  response.resolve({ success: false, code: 'TIMEOUT', error: '迟到的超时回调' });
  assert.equal((await submission).cloudSynced, true);
  assert.equal(app.records()[0].syncStatus, 'synced');
  assert.ok(!app.records()[0].syncError);
  assert.deepEqual(app.summary(), { total: 0, pending: 0, failed: 0 });
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
});

test('an unrelated same-time cloud row cannot consume a versioned pending record by timestamp fallback', async () => {
  const app = harness({ cloud: [{ _id: 'unrelated-legacy-row', _openid: OPENID,
    timestamp: TIMESTAMP, duration: 12, date: '2026-09-20', experience: [] }] });
  save(app, 'still-needs-upload');
  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.equal(app.records().length, 2);
  const pending = app.records().find(record => record.localId === 'still-needs-upload');
  assert.equal(pending.syncVersion, 1);
  assert.equal(pending.syncStatus, 'pending');
  assert.ok(!pending._id);
  assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 0 });
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.calls.backups[0][4], 'still-needs-upload');
});

test('refresh cannot confirm another account\'s pending record even when a cloud localId collides', async () => {
  const app = harness({ cloud: [{ _id: 'other-owner-cloud', _openid: 'oz-other-account', localId: 'same-id',
    timestamp: TIMESTAMP, duration: 12, date: '2026-09-20', experience: [] }] });
  save(app, 'same-id');
  app.storage.set('userOpenId', 'oz-other-account');
  assert.equal(await app.manager.refreshFromCloud(), true);
  const original = app.records().find(record => record.syncOpenid === OPENID);
  assert.ok(original);
  assert.equal(original.syncStatus, 'pending');
  assert.ok(!original._id);
  await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 0);
  app.storage.set('userOpenId', OPENID);
  assert.deepEqual(app.summary(), { total: 1, pending: 1, failed: 0 });
});

test('a confirmed cloud save whose local acknowledgement cannot persist is retried with one server identity', async () => {
  const serverRows = new Map();
  let app;
  app = harness({ backup: (args, index) => {
    const payload = uploadPayload(args);
    if (!serverRows.has(payload.localId)) serverRows.set(payload.localId, clone(payload));
    if (index === 0) app.failStorage(true);
    return { success: true, data: { recordId: 'one-server-row', duplicate: index > 0 } };
  } });
  const result = await app.manager.recordCheckinWithSync(12, ['平静'], ['第一次内容'], TIMESTAMP, 'confirmation-storage-failure');
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, false);
  assert.equal(result.syncErrorCode, 'STORAGE_FAILED');
  assert.equal(app.records().length, 1);
  assert.ok(!app.records()[0]._id);
  assert.equal(app.records()[0].syncVersion, 1);
  assert.equal(app.records()[0].localId, 'confirmation-storage-failure');
  app.failStorage(false);
  const retried = await app.restart().retryPendingBackups({ force: true });
  assert.equal(retried.success, true);
  assert.equal(retried.uploaded, 1);
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(uploadPayload(app.calls.backups[1]), uploadPayload(app.calls.backups[0]));
  assert.equal(serverRows.size, 1);
  assert.equal(app.records()[0]._id, 'one-server-row');
  assert.equal(app.records()[0].syncStatus, 'synced');
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 12);
});

test('failed cache refresh persistence leaves the original pending retry state intact', async () => {
  const app = harness();
  save(app, 'refresh-save-failure');
  const before = clone(app.storage.get(KEY));
  app.failStorage(true);
  assert.equal(await app.manager.refreshFromCloud(), false);
  assert.deepEqual(app.storage.get(KEY), before);
  app.failStorage(false);
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.records()[0].syncStatus, 'synced');
});

for (const data of [undefined, {}, { recordId: '' }, { recordId: 7 }, { recordId: '   ' }]) {
  test(`cloud API rejects malformed success data ${JSON.stringify(data)}`, async () => {
    const api = loadApiModule('cloudApi.js', {
      console: { log() {}, warn() {}, error() {} },
      wx: { cloud: { callFunction(options) { options.success({ result: { success: true, data } }); } } }
    });
    const result = await api.recordMeditation(12, [], [], 1000, 'malformed-confirmation');
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_RESPONSE');
  });
}

test('cloud API forwards expected owner and preserves server failure codes for the durable queue', async () => {
  const calls = [];
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const api = loadApiModule('cloudApi.js', {
    Date: FixedDate,
    console: { log() {}, warn() {}, error() {} },
    wx: { cloud: { callFunction(options) {
      calls.push(clone(options.data));
      options.success({ result: { success: false, code: 'IDENTITY_MISMATCH', error: '登录用户已变化' } });
    } } }
  });
  const result = await api.recordMeditation(12, [], [], TIMESTAMP, 'api-owner-check',
    { source: 'timer', expectedOpenid: OPENID });
  assert.equal(result.success, false);
  assert.equal(result.code, 'IDENTITY_MISMATCH');
  assert.equal(calls[0].data.expectedOpenid, OPENID);
  assert.equal(calls[0].data.localId, 'api-owner-check');
  assert.equal(calls[0].data.timestamp, TIMESTAMP);
});
