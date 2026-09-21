const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-21T10:15:00+08:00');
const TIMESTAMP = Date.parse('2026-09-19T08:35:00+08:00');
const LOCAL_USER = 'local-legacy-recovery';
const OPENID = 'oz-legacy-recovery';
const KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? undefined : structuredClone(value);

function legacy(overrides = {}) {
  return {
    localId: 'legacy-september-19', timestamp: TIMESTAMP, duration: 45, date: '2026-09-19',
    emotion: ['不悲不喜'], experience: [{ uniqueId: 'original-experience', text: '原始体验' }],
    ...overrides
  };
}

function identity(record) {
  return { localId: record.localId, timestamp: record.timestamp, duration: record.duration, date: record.date };
}

function harness({ records = [legacy()], nested = false, loggedIn = true, backup } = {}) {
  let failStorage = false;
  let nextTimer = 0;
  const timers = new Map();
  const cache = { businessDayVersion: 2, dailyRecords: {}, monthlyStats: {}, userStats: {} };
  for (const record of records) {
    const day = cache.dailyRecords[record.date] ||= { count: 0, lastCheckin: record.timestamp, records: [] };
    day.count++;
    day.records.push(clone(record));
  }
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', loggedIn ? OPENID : ''],
    ['cacheStatus', 'initialized'], ['needsRecovery', false],
    [KEY, nested ? { checkinRecords: cache, experienceRecords: {} } : cache]
  ]);
  const calls = { backups: [], persistedAtUpload: [], reads: 0 };
  const api = {
    async recordMeditation(...args) {
      const index = calls.backups.length;
      calls.backups.push(clone(args));
      calls.persistedAtUpload.push(clone(storage.get(KEY)));
      return backup ? backup(args, index) : { success: true, data: { recordId: `cloud-${index}` } };
    },
    async getAllRecords() { calls.reads++; return { success: true, data: [] }; },
    async getUserStats() { return { success: true, data: {} }; }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
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
    timers.clear();
    const dateUtil = load('dateUtil.js');
    return load('checkin.js', {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
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
    failStorage(value) { failStorage = value; },
    data() { const stored = storage.get(KEY); return stored.checkinRecords || stored; },
    records() { return Object.values(this.data().dailyRecords).flatMap(day => day.records); }
  };
}

for (const nested of [false, true]) {
  test(`explicit recovery persists one selected legacy record before uploading (${nested ? 'nested' : 'flat'} cache)`, async () => {
    const selected = legacy();
    const untouched = legacy({ localId: 'another-legacy', timestamp: TIMESTAMP + 60000, duration: 20 });
    const app = harness({ records: [selected, untouched], nested });

    await app.manager.retryPendingBackups();
    assert.equal(app.calls.backups.length, 0, 'bulk retry cannot opt legacy records in');
    assert.deepEqual(app.records(), [selected, untouched]);

    const result = await app.manager.retryUnconfirmedRecord(identity(selected));
    assert.equal(result.success, true);
    assert.equal(result.uploaded, 1);
    assert.equal(app.calls.backups.length, 1);
    const persisted = app.calls.persistedAtUpload[0];
    const persistedRecord = (persisted.checkinRecords || persisted).dailyRecords[selected.date].records[0];
    assert.equal(persistedRecord.localId, selected.localId);
    assert.equal(persistedRecord.syncVersion, 1);
    assert.equal(persistedRecord.syncLegacyRecovery, true);
    assert.equal(persistedRecord.syncOpenid, OPENID);
    assert.equal(app.calls.backups[0][4], selected.localId);
    assert.equal(app.calls.backups[0][5].recoverLegacy, true);
    assert.equal(app.calls.backups[0][5].expectedOpenid, OPENID);
    assert.equal(app.records()[0]._id, 'cloud-0');
    assert.equal(app.records()[0].syncStatus, 'synced');
    assert.deepEqual(app.records()[1], untouched, 'unselected legacy rows must remain byte-for-byte unchanged');
    assert.equal(app.records().length, 2);
    assert.equal(app.data().dailyRecords[selected.date].count, 2, 'recovery does not create a second local check-in');
    await app.manager.retryUnconfirmedRecord(identity(selected));
    await app.manager.retryPendingBackups();
    assert.equal(app.calls.backups.length, 1, 'a cloud-confirmed record cannot be uploaded again');
  });
}

for (const source of [{ source: 'timer' }, { source: 'manual' }, { dateSource: 'manual' }]) {
  test(`legacy recovery preserves original content and ${JSON.stringify(source)} date semantics`, async () => {
    const selected = legacy({ ...source, date: source.source === 'timer' ? '2026-09-19' : '2026-09-18' });
    const app = harness({ records: [selected] });
    const result = await app.manager.retryUnconfirmedRecord(identity(selected));
    assert.equal(result.success, true);
    const [duration, emotion, experience, timestamp, localId, options] = app.calls.backups[0];
    assert.equal(duration, selected.duration);
    assert.deepEqual(emotion, selected.emotion);
    assert.deepEqual(experience, selected.experience);
    assert.equal(timestamp, selected.timestamp);
    assert.equal(localId, selected.localId);
    assert.equal(options.source, source.source === 'timer' ? 'timer' : 'manual');
    assert.equal(options.date, selected.date);
    assert.equal(app.records()[0].date, selected.date);
    assert.equal(app.records()[0].dateSource, selected.dateSource);
  });
}

test('recovery reuses an old idempotency key when localId is missing', async () => {
  const selected = legacy({ localId: undefined, idempotencyKey: 'original-request-key' });
  const app = harness({ records: [selected] });
  assert.equal((await app.manager.retryUnconfirmedRecord(identity(selected))).success, true);
  assert.equal(app.calls.backups[0][4], 'original-request-key');
  assert.equal(app.records()[0].localId, 'original-request-key');
  assert.equal(app.records()[0].idempotencyKey, 'original-request-key');
});

test('a generated identity survives a failed upload, cache rebuild and process restart', async () => {
  const selected = legacy({ localId: undefined, dateSource: 'manual', date: '2026-09-18' });
  const untouched = legacy({ localId: 'unselected-legacy', timestamp: TIMESTAMP + 60000 });
  const app = harness({ records: [selected, untouched], backup: (args, index) => index === 0
    ? { success: false, code: 'OFFLINE', error: '网络不可用' }
    : { success: true, data: { recordId: 'recovered-after-restart' } } });
  const failed = await app.manager.retryUnconfirmedRecord(identity(selected));
  assert.equal(failed.success, false);
  assert.equal(app.calls.backups.length, 1);
  const generatedId = app.records()[0].localId;
  assert.ok(generatedId);
  assert.equal(app.records()[0].syncStatus, 'failed');
  assert.equal(app.records()[0].syncLegacyRecovery, true);
  assert.equal(app.records()[0].syncError, '网络不可用');
  assert.equal(app.records().length, 2);

  await app.manager.syncWithCloud();
  assert.equal(app.calls.backups.length, 1, 'read refresh must not retry a failed upload');
  assert.equal(app.records().find(record => record.localId === generatedId).syncLegacyRecovery, true);
  assert.equal(app.timers.size, 0, 'failed recovery cannot schedule background uploads');
  const restarted = app.restart();
  const retried = await restarted.retryPendingBackups();
  assert.equal(retried.success, true);
  assert.equal(retried.uploaded, 1);
  assert.equal(app.calls.backups.length, 2);
  assert.deepEqual(app.calls.backups[1], app.calls.backups[0], 'retry sends the same identity, content and recovery metadata');
  const recovered = app.records().find(record => record.localId === generatedId);
  assert.equal(recovered._id, 'recovered-after-restart');
  assert.equal(recovered.timestamp, selected.timestamp);
  assert.equal(recovered.date, selected.date);
  assert.equal(recovered.duration, selected.duration);
  assert.equal(app.records().find(record => record.localId === untouched.localId).syncVersion, undefined);
});

test('already confirmed legacy records are a successful no-op', async () => {
  const selected = legacy({ _id: 'known-cloud-record' });
  const app = harness({ records: [selected] });
  const result = await app.manager.retryUnconfirmedRecord(identity(selected));
  assert.equal(result.success, true);
  assert.equal(result.uploaded, 0);
  assert.equal(app.calls.backups.length, 0);
  assert.deepEqual(app.records(), [selected]);
});

test('failed local persistence leaves the original record intact and never requests cloud upload', async () => {
  const selected = legacy({ localId: undefined });
  const app = harness({ records: [selected] });
  app.failStorage(true);
  const result = await app.manager.retryUnconfirmedRecord(identity(selected));
  assert.equal(result.success, false);
  assert.match(result.error, /storage full/);
  assert.equal(app.calls.backups.length, 0);
  assert.deepEqual(app.records(), [selected]);
});

test('missing login or ownership mismatch cannot enroll or upload a legacy record', async () => {
  for (const settings of [
    { loggedIn: false, record: legacy() },
    { record: legacy({ syncOpenid: 'oz-other-account' }) },
    { record: legacy({ _openid: 'oz-other-account' }) }
  ]) {
    const app = harness({ records: [settings.record], loggedIn: settings.loggedIn });
    const result = await app.manager.retryUnconfirmedRecord(identity(settings.record));
    assert.equal(result.success, false);
    assert.equal(app.calls.backups.length, 0);
    assert.deepEqual(app.records(), [settings.record]);
  }
});

test('invalid legacy time or duration is rejected without modifying local data', async () => {
  for (const invalid of [
    { timestamp: 0 }, { timestamp: NOW + 1 }, { timestamp: 'invalid' }, { timestamp: TIMESTAMP + 0.5 },
    { duration: 0 }, { duration: -1 }, { duration: 1441 }, { duration: 2.5 }, { duration: 'invalid' }
  ]) {
    const selected = legacy(invalid);
    const app = harness({ records: [selected] });
    const result = await app.manager.retryUnconfirmedRecord(identity(selected));
    assert.equal(result.success, false, JSON.stringify(invalid));
    assert.equal(app.calls.backups.length, 0);
    assert.deepEqual(app.records(), [selected]);
  }
});

test('ambiguous time-and-duration identity or conflicting persistent keys cannot select a record', async () => {
  for (const records of [
    [legacy({ localId: undefined }), legacy({ localId: undefined })],
    [legacy(), legacy()],
    [legacy(), legacy({ localId: undefined, idempotencyKey: 'legacy-september-19', timestamp: TIMESTAMP + 60000 })]
  ]) {
    const app = harness({ records });
    const result = await app.manager.retryUnconfirmedRecord(identity(records[0]));
    assert.equal(result.success, false);
    assert.equal(app.calls.backups.length, 0);
    assert.deepEqual(app.records(), records);
  }
});

test('an unrelated active upload cannot produce a false success for the selected legacy record', async () => {
  let completeUpload;
  const selected = legacy();
  const pending = legacy({ localId: 'already-pending', timestamp: TIMESTAMP + 60000,
    syncVersion: 1, syncStatus: 'pending', syncOpenid: OPENID });
  const app = harness({ records: [selected, pending], backup: () => new Promise(resolve => { completeUpload = resolve; }) });
  const unrelated = app.manager.retryPendingBackups({ localIds: [pending.localId] });
  const recovery = app.manager.retryUnconfirmedRecord(identity(selected));
  assert.equal(app.calls.backups.length, 1);
  completeUpload({ success: true, data: { recordId: 'unrelated-cloud-record' } });
  await unrelated;
  const result = await recovery;
  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.equal(app.records()[0]._id, undefined);
  assert.equal(app.records()[0].syncStatus, 'pending');
});

test('cloudApi forwards explicit recovery metadata and preserves the original payload', async () => {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/cloudApi.js'), 'utf8'), {
    module, console: { log() {}, warn() {}, error() {} },
    wx: { cloud: { callFunction(request) {
      calls.push(clone({ name: request.name, data: request.data }));
      request.success({ result: request.name === 'contentSecCheck'
        ? { success: true, safe: true } : { success: true, data: { recordId: 'cloud-api-recovery' } } });
    } } }
  }, { filename: 'cloudApi.js' });
  const selected = legacy();
  const result = await module.exports.recordMeditation(selected.duration, selected.emotion, selected.experience,
    selected.timestamp, selected.localId, { source: 'manual', date: '2026-09-18', expectedOpenid: OPENID, recoverLegacy: true });
  assert.equal(result.success, true);
  assert.equal(calls[0].name, 'contentSecCheck', 'recovery still checks original experience text');
  assert.deepEqual(calls[1], {
    name: 'meditationManager',
    data: { type: 'recordMeditation', data: {
      duration: selected.duration, emotion: selected.emotion, experience: selected.experience,
      localId: selected.localId, source: 'manual', date: '2026-09-18', expectedOpenid: OPENID,
      recoverLegacy: true, timestamp: selected.timestamp
    } }
  });
  await module.exports.recordMeditation(10, [], [], selected.timestamp, 'ordinary-record');
  assert.equal(Object.hasOwn(calls.at(-1).data.data, 'recoverLegacy'), false, 'ordinary uploads never opt into legacy recovery');
});

function mixedRecords() {
  return [
    legacy(),
    legacy({ localId: 'older-august', timestamp: Date.parse('2026-08-19T08:35:00+08:00'), date: '2026-08-19', duration: 25 }),
    legacy({ localId: undefined, idempotencyKey: 'old-manual-key', source: 'manual',
      timestamp: Date.parse('2026-09-18T08:35:00+08:00'), date: '2026-09-17', duration: 15 }),
    legacy({ localId: 'new-pending', timestamp: Date.parse('2026-09-21T08:35:00+08:00'),
      date: '2026-09-21', duration: 10, source: 'timer', syncVersion: 1, syncStatus: 'pending', syncOpenid: OPENID })
  ];
}

function pageHarness(options = {}) {
  const app = harness(options);
  let definition;
  const calls = { sync: [], toast: [], refresh: 0 };
  const originalSync = app.manager.syncWithCloud.bind(app.manager);
  app.manager.syncWithCloud = value => {
    calls.sync.push(clone(value));
    return originalSync(value);
  };
  const wx = {
    getStorageSync: key => clone(app.storage.get(key)),
    showToast: value => calls.toast.push(clone(value))
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const silentConsole = { log() {}, warn() {}, error() {} };
  const modules = { 'checkin.js': app.manager, 'dailyWisdom.js': { DEFAULT_QUOTE: '每日金句' }, 'contentSec.js': {} };
  function loadModule(name) {
    const filename = path.basename(name);
    if (modules[filename]) return modules[filename];
    assert.ok(['homeCheckin.js', 'dateUtil.js'].includes(filename));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', filename), 'utf8'), {
      module, require: loadModule, wx, Date: ClockDate, console: silentConsole
    }, { filename });
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.js'), 'utf8'), {
    Page(value) { definition = value; }, require: loadModule, wx, Date: ClockDate, console: silentConsole
  }, { filename: 'index.js' });
  const page = {
    ...definition, data: clone(definition.data),
    setData(value) { Object.assign(this.data, value); },
    refreshCalendarData() { calls.refresh++; this.refreshCheckinRecords(); }
  };
  page.refreshCheckinRecords();
  return { ...app, page, pageCalls: calls,
    setOpenid(value) { app.storage.set('userOpenId', value); },
    setUserId(value) { app.storage.set('localUserId', value); },
    addRecord(record) {
      const day = app.data().dailyRecords[record.date] ||= { count: 0, lastCheckin: record.timestamp, records: [] };
      day.count++;
      day.records.push(clone(record));
    }
  };
}

test('unified home preview includes legacy records across all dates without mutating or uploading them', () => {
  const app = pageHarness({ records: mixedRecords() });
  const initial = clone(app.storage.get(KEY));
  assert.equal(app.page.data.pendingCheckinCount, 4);
  assert.equal(app.page.data.checkinRecords.length, 2, 'home displays only recent records');
  assert.equal(app.page.data.hiddenCheckinCount, 2);
  app.page.openCheckinUploadPreview();
  assert.equal(app.page.data.showCheckinUploadPreview, true);
  assert.equal(app.page.data.checkinUploadCount, 4);
  assert.equal(app.page.data.checkinUploadDuration, 95);
  assert.deepEqual(clone(app.page.data.checkinUploadGroups.map(group => group.date)),
    ['2026-09-21', '2026-09-19', '2026-09-17', '2026-08-19']);
  assert.deepEqual(app.storage.get(KEY), initial, 'preview cannot enroll old rows before confirmation');
  assert.equal(app.calls.backups.length, 0);
  assert.equal(app.pageCalls.sync.length, 0);
});

test('one confirmed home batch submits all previewed legacy and newer pending records together', async () => {
  const records = mixedRecords();
  const app = pageHarness({ records });
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.pageCalls.sync.length, 1);
  const options = app.pageCalls.sync[0];
  assert.equal(options.uploadPending, true);
  assert.deepEqual(options.localIds, ['new-pending']);
  assert.deepEqual(options.unconfirmedRecords, [records[0], records[2], records[1]]
    .map(record => ({ ...identity(record), localId: record.localId || null })));
  assert.equal(app.calls.backups.length, 4);
  assert.deepEqual(app.calls.backups.map(args => args[4]).sort(),
    ['legacy-september-19', 'older-august', 'old-manual-key', 'new-pending'].sort());
  for (const args of app.calls.backups) {
    assert.equal(args[5].recoverLegacy, args[4] === 'new-pending' ? undefined : true);
    assert.equal(args[5].expectedOpenid, OPENID);
  }
  assert.equal(app.records().filter(record => record._id && record.syncStatus === 'synced').length, 4);
  assert.equal(app.page.data.pendingCheckinCount, 0);
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.pageCalls.toast.at(-1).title, '上传成功');
  assert.equal(app.pageCalls.refresh, 1);
});

test('closing the unified preview never enrolls legacy rows or uploads newer pending rows', async () => {
  const app = pageHarness({ records: mixedRecords() });
  const initial = clone(app.storage.get(KEY));
  app.page.openCheckinUploadPreview();
  app.page.closeCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  assert.deepEqual(app.storage.get(KEY), initial);
  assert.equal(app.calls.backups.length, 0);
  assert.equal(app.pageCalls.sync.length, 0);
});

test('unified confirmation checks login and both account identifiers before enrolling legacy records', async () => {
  const loggedOut = pageHarness({ loggedIn: false, records: mixedRecords().slice(0, 3) });
  const loggedOutSnapshot = clone(loggedOut.storage.get(KEY));
  loggedOut.page.openCheckinUploadPreview();
  await loggedOut.page.retryCheckinUploads();
  assert.equal(loggedOut.calls.backups.length, 0);
  assert.equal(loggedOut.pageCalls.sync.length, 0);
  assert.deepEqual(loggedOut.storage.get(KEY), loggedOutSnapshot);
  assert.match(loggedOut.pageCalls.toast.at(-1).title, /登录/);
  for (const changeAccount of [app => app.setOpenid('oz-new-account'), app => app.setUserId('local-new-account')]) {
    const app = pageHarness({ records: mixedRecords() });
    const initial = clone(app.storage.get(KEY));
    app.page.openCheckinUploadPreview();
    changeAccount(app);
    await app.page.retryCheckinUploads();
    assert.equal(app.calls.backups.length, 0);
    assert.equal(app.pageCalls.sync.length, 0);
    assert.deepEqual(app.storage.get(KEY), initial);
    assert.match(app.pageCalls.toast.at(-1).title, /账号已切换/);
    assert.equal(app.page.data.showCheckinUploadPreview, false);
  }
});

test('records arriving after the preview are excluded from the confirmed batch', async () => {
  const app = pageHarness({ records: mixedRecords() });
  app.page.openCheckinUploadPreview();
  const lateLegacy = legacy({ localId: 'late-legacy', timestamp: TIMESTAMP + 60000 });
  const latePending = legacy({ localId: 'late-pending', timestamp: TIMESTAMP + 120000,
    syncVersion: 1, syncStatus: 'pending', syncOpenid: OPENID });
  app.addRecord(lateLegacy);
  app.addRecord(latePending);
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 4);
  assert.ok(app.calls.backups.every(args => !['late-legacy', 'late-pending'].includes(args[4])));
  assert.deepEqual(app.records().find(record => record.localId === 'late-legacy'), lateLegacy);
  assert.deepEqual(app.records().find(record => record.localId === 'late-pending'), latePending);
  assert.equal(app.page.data.pendingCheckinCount, 2);
});

test('invalid legacy records remain visible as blocked without preventing valid rows from uploading', async () => {
  const invalid = legacy({ localId: 'missing-time', timestamp: null });
  const app = pageHarness({ records: [legacy(), invalid] });
  app.page.openCheckinUploadPreview();
  assert.equal(app.page.data.checkinUploadCount, 1);
  assert.equal(app.page.data.checkinUploadBlockedRecords.length, 1);
  assert.equal(app.page.data.checkinUploadBlockedRecords[0].localId, invalid.localId);
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 1);
  assert.equal(app.calls.backups[0][4], legacy().localId);
  assert.deepEqual(app.records().find(record => record.localId === invalid.localId), invalid);
});

test('failed unified recovery preserves all rows and uses the same single entry to retry them', async () => {
  let fail = true;
  const app = pageHarness({ records: mixedRecords(), backup: () => fail
    ? { success: false, code: 'OFFLINE', error: '网络不可用' }
    : { success: true, data: { recordId: 'confirmed-after-retry' } } });
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 1, 'a network failure pauses the remaining queue');
  assert.equal(app.records().length, 4);
  assert.equal(app.records().filter(record => record.syncStatus === 'failed').length, 1);
  assert.equal(app.records().filter(record => record.syncStatus === 'pending').length, 3);
  assert.ok(app.records().every(record => record.syncVersion === 1));
  assert.equal(app.page.data.pendingCheckinCount, 4);
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  fail = false;
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 5);
  assert.equal(app.pageCalls.sync.length, 2);
  assert.equal(app.pageCalls.sync[1].unconfirmedRecords, undefined, 'enrolled rows use the normal queue on retry');
  assert.equal(app.pageCalls.sync[1].localIds.length, 4);
  assert.equal(app.page.data.pendingCheckinCount, 0);
});

test('bulk legacy enrollment persists every selected identity before the first cloud request', async () => {
  const records = mixedRecords();
  const app = harness({ records, nested: true });
  const result = await app.manager.syncWithCloud({ uploadPending: true, localIds: ['new-pending'],
    unconfirmedRecords: records.slice(0, 3).map(identity) });
  assert.equal(result.success, true);
  assert.equal(result.uploaded, 4);
  const persisted = app.calls.persistedAtUpload[0].checkinRecords;
  const persistedRecords = Object.values(persisted.dailyRecords).flatMap(day => day.records);
  assert.ok(persistedRecords.every(record => record.localId && record.syncVersion === 1 && record.syncOpenid === OPENID));
  assert.equal(persistedRecords.filter(record => record.syncLegacyRecovery).length, 3);
  assert.equal(app.calls.reads, 0, 'confirmation needs only one upload drain, with no read refresh');
});

test('bulk storage failure cannot upload even newer pending rows from the selected batch', async () => {
  const records = mixedRecords();
  const app = harness({ records });
  const original = clone(app.storage.get(KEY));
  app.failStorage(true);
  const result = await app.manager.syncWithCloud({ uploadPending: true, localIds: ['new-pending'],
    unconfirmedRecords: records.slice(0, 3).map(identity) });
  assert.equal(result.success, false);
  assert.equal(app.calls.backups.length, 0);
  assert.deepEqual(app.storage.get(KEY), original);
});

test('an ambiguous legacy record is blocked while the same batch uploads other dates', async () => {
  const records = mixedRecords();
  const app = pageHarness({ records, backup: args => args[4] === records[0].localId
    ? { success: false, code: 'AMBIGUOUS_RECORD', error: '云端有相似记录，请核对' }
    : { success: true, data: { recordId: `confirmed-${args[4]}` } } });
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 4);
  const ambiguous = app.records().find(record => record.localId === records[0].localId);
  assert.equal(ambiguous._id, undefined);
  assert.equal(ambiguous.syncBlocked, true);
  assert.equal(ambiguous.syncErrorCode, 'AMBIGUOUS_RECORD');
  assert.equal(ambiguous.timestamp, records[0].timestamp);
  assert.equal(ambiguous.duration, records[0].duration);
  assert.equal(app.records().filter(record => record._id && record.syncStatus === 'synced').length, 3);
  assert.equal(app.page.data.pendingCheckinCount, 1);
  app.page.openCheckinUploadPreview();
  assert.equal(app.page.data.checkinUploadCount, 0);
  assert.equal(app.page.data.checkinUploadBlockedRecords.length, 1);
  assert.equal(app.page.data.checkinUploadBlockedRecords[0].localId, records[0].localId);
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.backups.length, 4, 'the blocked record is not repeatedly uploaded');
});

test('home keeps one unified retry entry and history templates have no upload actions', () => {
  const home = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.equal((home.match(/bindtap="openCheckinUploadPreview"/g) || []).length, 1);
  assert.doesNotMatch(home, /retryUnconfirmedCheckin/);
  for (const page of ['history', 'checkinHistory']) {
    const template = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${page}/${page}.wxml`), 'utf8');
    assert.doesNotMatch(template, /retryUnconfirmedCheckin|retryCheckinUploads|openCheckinUploadPreview/);
  }
});

test('ambiguous cloud records keep the original local record and block repeated bulk uploads', async () => {
  const app = harness({ backup: () => ({ success: false, code: 'AMBIGUOUS_RECORD', error: '云端有相似记录，请核对' }) });
  const result = await app.manager.retryUnconfirmedRecord(identity(legacy()));
  assert.equal(result.success, false);
  assert.equal(app.records()[0]._id, undefined);
  assert.equal(app.records()[0].syncBlocked, true);
  assert.equal(app.records()[0].timestamp, TIMESTAMP);
  assert.equal(app.records()[0].duration, 45);
  await app.restart().retryPendingBackups();
  assert.equal(app.calls.backups.length, 1);
  const homeCheckin = require('../miniprogram/utils/homeCheckin.js');
  const displayed = homeCheckin.buildCheckinRecords(app.data());
  assert.equal(displayed[0].syncStatus, 'blocked');
  assert.match(displayed[0].syncStatusText, /云端有相似记录，请核对/);
});
