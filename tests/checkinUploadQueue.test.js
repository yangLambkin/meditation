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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ loggedIn = true, backup, remove, nested = false, cloud = [], read } = {}) {
  let now = NOW;
  let failStorage = false;
  const cache = { dailyRecords: {}, monthlyStats: {}, userStats: {} };
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', loggedIn ? OPENID : ''],
    ['cacheStatus', 'initialized'], ['needsRecovery', false],
    [KEY, nested ? { checkinRecords: cache, experienceRecords: {} } : cache]
  ]);
  const calls = { backups: [], removes: [] };
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
    async getAllRecords() { return read ? read() : { success: true, data: clone(cloud) }; },
    async getUserStats() { return { success: true, data: {} }; }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function load(name, globals = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, Date: ClockDate,
      console: { log() {}, warn() {}, error() {} }, ...globals
    }, { filename: name });
    return module.exports;
  }
  function restart() {
    const dateUtil = load('dateUtil.js');
    return load('checkin.js', {
      setTimeout() {}, clearTimeout() {},
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
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
  }
  return {
    manager: restart(), restart, storage, calls,
    advance(ms) { now += ms; },
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

function uploadPayload(args) {
  const [duration, emotion, experience, timestamp, localId, options = {}] = args;
  return { duration, emotion, experience, timestamp, localId, source: options.source,
    date: options.source === 'manual' ? options.date : undefined, expectedOpenid: options.expectedOpenid };
}

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
  const result = await app.manager.recordCheckinWithSync(12, ['平静'], ['记录体验'], TIMESTAMP, 'lock-failure');
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
    if (index === 0) throw new Error('request:fail timeout');
    return { success: true, data: { recordId: 'recovered-record' } };
  } });
  const result = await app.manager.recordCheckinWithSync(18, ['平静'], ['体验'], TIMESTAMP, 'restart-record');
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
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(uploadPayload(app.calls.backups[1]), uploadPayload(app.calls.backups[0]), 'retry reuses timestamp, local ID and payload');
  assert.equal(app.calls.backups[1][5].expectedOpenid, OPENID);
  const record = app.records()[0];
  assert.equal(record.localId, persisted.localId);
  assert.equal(record.timestamp, persisted.timestamp);
  assert.equal(record._id, 'recovered-record');
  assert.equal(record.syncStatus, 'synced');
  assert.ok(!record.syncError);
  assert.ok(!record.syncErrorCode);
  assert.deepEqual(app.summary(restarted), { total: 0, pending: 0, failed: 0 });
  await restarted.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 2, 'confirmed uploads must not be resent');
});

test('background retries respect persisted backoff while explicit retry bypasses it', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'OFFLINE', error: '网络不可用' }) });
  await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'backoff-record');
  assert.equal(app.calls.backups.length, 1);
  assert.ok(app.records()[0].syncNextRetryAt > NOW);
  await app.manager.retryPendingBackups();
  await app.restart().retryPendingBackups();
  assert.equal(app.calls.backups.length, 1, 'restarting must not bypass persisted backoff');
  const forced = await app.manager.retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 2);
  assert.equal(forced.failed, 1);
  assert.equal(forced.pending, 1);
  app.advance(10 * 60 * 1000);
  await app.manager.retryPendingBackups();
  assert.equal(app.calls.backups.length, 3);
});

test('automatic and explicit queue retry leave historical unversioned dirty records untouched', async () => {
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

test('a timed-out stable identity is retried from its saved payload even if the submit form has changed', async () => {
  const app = harness({ backup: (args, index) => index === 0
    ? { success: false, code: 'TIMEOUT', error: '结果未知' }
    : { success: true, data: { recordId: 'server-already-saved', duplicate: true } } });
  await app.manager.recordCheckinWithSync(12, ['平静'], ['原始体验'], TIMESTAMP, 'stable-timeout');
  const result = await app.manager.recordCheckinWithSync(90, ['疲倦'], ['修改过的表单'], NOW, 'stable-timeout');
  assert.equal(result.success, true);
  assert.equal(result.cloudSynced, true);
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(uploadPayload(app.calls.backups[1]), uploadPayload(app.calls.backups[0]));
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
  const app = harness({ backup: (args, index) => index === 0
    ? { success: false, code: 'OFFLINE', error: '网络不可用' }
    : { success: true, data: { recordId: 'manual-confirmed' } } });
  const timestamp = TIMESTAMP - 86400000;
  const options = { source: 'manual', date: '2026-09-19', idempotencyKey: 'manual-retry' };
  const result = await app.manager.recordCheckinWithSync(23, ['平静'], ['补记体验'], timestamp, options);
  assert.equal(result.cloudSynced, false);
  await app.restart().retryPendingBackups({ force: true });
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(uploadPayload(app.calls.backups[1]), uploadPayload(app.calls.backups[0]));
  assert.equal(app.calls.backups[1][3], timestamp);
  assert.equal(app.calls.backups[1][5].source, 'manual');
  assert.equal(app.calls.backups[1][5].date, '2026-09-19');
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
    const result = await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'missing-cloud-id');
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
  const app = harness({ backup: (args, index) => index === 0
    ? { success: false, code: 'OFFLINE', error: '离线' }
    : { success: true, data: { recordId: `subscribed-${index}` } } });
  const snapshots = [];
  const unsubscribe = app.manager.subscribeSyncState(() => snapshots.push(app.summary()));
  await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'subscription-record');
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
    const app = harness({ backup: (args, index) => index === 0
      ? { success: false, code: 'NETWORK_ERROR', error: '断网' }
      : { success: true, data: { recordId: 'recovered-after-refresh' } } });
    await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'refresh-pending');
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
    assert.equal(app.calls.backups.length, 2);
    assert.equal(app.records()[0].syncStatus, 'synced');
    assert.equal(app.manager.getUserStats().totalCount, 1);
  });
}

test('refresh discovers a timed-out cloud commit by local identity and clears all retry state without another upload', async () => {
  const cloud = [];
  const app = harness({ cloud, backup: args => {
    const [duration, emotion, experience, timestamp, localId] = args;
    cloud.push({ _id: 'timeout-actually-committed', _openid: OPENID, duration, emotion, experience,
      timestamp, localId, date: '2026-09-20' });
    return { success: false, code: 'TIMEOUT', error: '服务器已保存，但客户端没收到结果' };
  } });
  await app.manager.recordCheckinWithSync(12, [], [], TIMESTAMP, 'found-by-refresh');
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
  assert.equal(app.calls.backups.length, 1);
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
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/cloudApi.js'), 'utf8'), {
      module, exports: module.exports,
      console: { log() {}, warn() {}, error() {} },
      wx: { cloud: { callFunction(options) { options.success({ result: { success: true, data } }); } } }
    }, { filename: 'cloudApi.js' });
    const result = await module.exports.recordMeditation(12, [], [], 1000, 'malformed-confirmation');
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_RESPONSE');
  });
}

test('cloud API forwards expected owner and preserves server failure codes for the durable queue', async () => {
  const calls = [];
  const module = { exports: {} };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/cloudApi.js'), 'utf8'), {
    module, exports: module.exports, Date: FixedDate,
    console: { log() {}, warn() {}, error() {} },
    wx: { cloud: { callFunction(options) {
      calls.push(clone(options.data));
      options.success({ result: { success: false, code: 'IDENTITY_MISMATCH', error: '登录用户已变化' } });
    } } }
  }, { filename: 'cloudApi.js' });
  const result = await module.exports.recordMeditation(12, [], [], TIMESTAMP, 'api-owner-check',
    { source: 'timer', expectedOpenid: OPENID });
  assert.equal(result.success, false);
  assert.equal(result.code, 'IDENTITY_MISMATCH');
  assert.equal(calls[0].data.expectedOpenid, OPENID);
  assert.equal(calls[0].data.localId, 'api-owner-check');
  assert.equal(calls[0].data.timestamp, TIMESTAMP);
});
