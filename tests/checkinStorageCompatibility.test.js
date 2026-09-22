const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-22T04:00:00Z');
const KEY = 'meditation_checkin_local-storage-test';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const silentConsole = { log() {}, warn() {}, error() {} };
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function harness(initial, options = {}) {
  const storage = new Map([
    ['localUserId', 'local-storage-test'], ['userOpenId', ''], [KEY, clone(initial)]
  ]);
  const uploads = [];
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) {
      if (options.failWrite && key === KEY) throw new Error('storage full');
      storage.set(key, clone(value));
    },
    removeStorageSync: key => storage.delete(key)
  };
  function load(filename) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../miniprogram/utils', filename), 'utf8'), {
      module, exports: module.exports, Date: FixedDate, console: silentConsole,
      wx, setTimeout() {}, clearTimeout() {},
      require(name) {
        if (name === './cloudApi.js') return {
          recordMeditation: async (...args) => { uploads.push(args); return { success: false }; }
        };
        return load(name);
      }
    }, { filename });
    return module.exports;
  }
  return { manager: load('checkin.js'), storage, uploads };
}

function fixture(nested) {
  const checkins = {
    businessDayVersion: 2,
    dailyRecords: {
      '2026-09-21': { count: 1, lastCheckin: NOW - 86400000, records: [{
        _id: 'cloud-old', localId: 'local-old', timestamp: NOW - 86400000,
        duration: 20, experience: ['note-old'], syncVersion: 1, syncStatus: 'synced'
      }] }
    },
    monthlyStats: {}, userStats: {}, customCheckinMetadata: { version: 7 }
  };
  const metadata = {
    experienceRecords: { 'note-old': { _id: 'note-old', text: '必须保留的体验正文' } },
    schemaVersion: 9, customEnvelopeMetadata: { enabled: true }
  };
  return nested ? { ...metadata, checkinRecords: checkins } : { ...metadata, ...checkins };
}

for (const nested of [true, false]) {
  test(`${nested ? 'nested' : 'flat'} storage retains experiences, metadata and old identities after recording and reloading`, () => {
    const original = fixture(nested);
    const { manager, storage } = harness(original);
    const result = manager.recordToLocal(10, [], ['新体验'], NOW, { idempotencyKey: 'new-local' });
    assert.equal(result.success, true);
    const saved = storage.get(KEY);
    assert.equal(Boolean(saved.checkinRecords), nested);
    assert.deepEqual(saved.experienceRecords, original.experienceRecords);
    assert.deepEqual(saved.customEnvelopeMetadata, original.customEnvelopeMetadata);
    assert.equal(saved.schemaVersion, 9);
    const data = saved.checkinRecords || saved;
    const oldData = original.checkinRecords || original;
    assert.deepEqual(data.customCheckinMetadata, oldData.customCheckinMetadata);
    assert.deepEqual(data.dailyRecords['2026-09-21'], oldData.dailyRecords['2026-09-21']);
    assert.equal(data.dailyRecords['2026-09-22'].records[0].localId, 'new-local');
    const reopened = harness(saved).manager;
    assert.equal(reopened.getDailyCheckinCountSync('2026-09-22'), 1);
    assert.equal(reopened.getExperienceRecordsFromLocal(['note-old'])[0].text, '必须保留的体验正文');
  });

  test(`${nested ? 'nested' : 'flat'} partial saves preserve omitted fields and accept explicit empty records`, () => {
    const original = fixture(nested);
    const { manager, storage } = harness(original);
    assert.equal(manager.saveUserCheckinData({ monthlyStats: { '2026-09': { total: 5 } } }), true);
    let saved = storage.get(KEY);
    assert.deepEqual((saved.checkinRecords || saved).dailyRecords, (original.checkinRecords || original).dailyRecords);
    assert.equal(manager.saveUserCheckinData({ dailyRecords: {} }), true);
    saved = storage.get(KEY);
    assert.deepEqual((saved.checkinRecords || saved).dailyRecords, {});
    assert.equal((saved.checkinRecords || saved).monthlyStats['2026-09'].total, 5);
    assert.deepEqual(saved.experienceRecords, original.experienceRecords);
  });

  test(`${nested ? 'nested' : 'flat'} checkin projection cannot overwrite a newer independently saved experience`, () => {
    const { manager, storage } = harness(fixture(nested));
    const checkinProjection = manager.getUserCheckinData();
    const newer = storage.get(KEY);
    newer.experienceRecords['note-old'].text = '刚刚修改的新正文';
    newer.customEnvelopeMetadata = { enabled: false };
    storage.set(KEY, clone(newer));
    assert.equal(manager.saveUserCheckinData(checkinProjection), true);
    assert.equal(storage.get(KEY).experienceRecords['note-old'].text, '刚刚修改的新正文');
    assert.deepEqual(storage.get(KEY).customEnvelopeMetadata, { enabled: false });
  });

  test(`${nested ? 'nested' : 'flat'} storage failure leaves original data and does not notify or upload`, () => {
    const original = fixture(nested);
    const { manager, storage, uploads } = harness(original, { failWrite: true });
    let notifications = 0;
    manager.subscribeSyncState(() => notifications++);
    assert.throws(() => manager.recordToLocal(10, [], [], NOW, { idempotencyKey: 'failed-save' }), /保存失败/);
    assert.deepEqual(storage.get(KEY), original);
    assert.equal(notifications, 0);
    assert.equal(uploads.length, 0);
  });

  test(`${nested ? 'nested' : 'flat'} checkins survive refresh and deletion without losing envelope metadata or experiences`, async () => {
    const original = fixture(nested);
    const { manager, storage } = harness(original);
    manager.recordToLocal(10, [], [], NOW, { idempotencyKey: 'local-to-delete' });
    const oldData = original.checkinRecords || original;
    const merged = manager.mergeCloudRecordsIntoCache(storage.get(KEY), oldData.dailyRecords['2026-09-21'].records);
    storage.set(KEY, clone(merged));
    assert.equal(merged.schemaVersion, 9);
    assert.deepEqual(clone(merged.experienceRecords), original.experienceRecords);
    assert.deepEqual(clone(merged.customEnvelopeMetadata), original.customEnvelopeMetadata);
    assert.deepEqual(clone((nested ? merged.checkinRecords : merged).customCheckinMetadata), { version: 7 });
    assert.equal((await manager.deleteCheckin('2026-09-22', { localId: 'local-to-delete' })).success, true);
    const saved = storage.get(KEY);
    assert.equal(saved.schemaVersion, 9);
    assert.deepEqual(saved.experienceRecords, original.experienceRecords);
    assert.equal(saved.checkinRecords.dailyRecords['2026-09-21'].records[0]._id, 'cloud-old');
    assert.equal(saved.checkinRecords.dailyRecords['2026-09-22'], undefined);
  });
}

test('experience-only and absent caches can receive their first checkin without losing unrelated data', () => {
  for (const initial of [undefined, { experienceRecords: { note: { text: '独立体验' } }, extension: 'keep' }]) {
    const { manager, storage } = harness(initial);
    assert.equal(manager.recordToLocal(15, [], [], NOW).success, true);
    assert.equal(storage.get(KEY).dailyRecords['2026-09-22'].count, 1);
    if (initial) {
      assert.deepEqual(storage.get(KEY).experienceRecords, initial.experienceRecords);
      assert.equal(storage.get(KEY).extension, 'keep');
    }
  }
});
