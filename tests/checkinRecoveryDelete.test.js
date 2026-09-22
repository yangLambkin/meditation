const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const USER_ID = 'local-recovery';
const STORAGE_KEY = `meditation_checkin_${USER_ID}`;
const DATE = '2026-09-17';
const NOW = Date.parse('2026-09-17T04:00:00Z');
const savedRecord = { _id: 'cloud-record', localId: 'local-record', timestamp: NOW, duration: 7, experience: [] };
const cloudRecord = { ...savedRecord, date: DATE };
const clone = value => value === undefined ? value : structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ remove, stats } = {}) {
  const storage = new Map([
    ['localUserId', USER_ID],
    ['userOpenId', 'oz-recovery'],
    [STORAGE_KEY, {
      dailyRecords: { [DATE]: { count: 1, lastCheckin: NOW, records: [clone(savedRecord)] } },
      monthlyStats: {},
      experienceRecords: { note: { text: '保留本地体验' } }
    }]
  ]);
  const statistics = deferred();
  const statisticsStarted = deferred();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  function load(filename, globals = {}) {
    globals = { ...globals, wx: globals.wx && {
      getNetworkType: ({ success }) => success({ networkType: 'wifi' }), ...globals.wx
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', filename), 'utf8'), {
      module, exports: module.exports, Date: FixedDate,
      console: { log() {}, warn() {}, error() {} },
      ...globals,
      require(name) {
        if (name === './uploadNetwork.js') return load('uploadNetwork.js', globals);
        return globals.require(name);
      }
    }, { filename });
    return module.exports;
  }
  const dateUtil = load('dateUtil.js');
  const manager = load('checkin.js', {
    wx: {
      getStorageSync: key => clone(storage.get(key)),
      setStorageSync: (key, value) => storage.set(key, clone(value)),
      removeStorageSync: key => storage.delete(key)
    },
    setTimeout() {},
    require(name) {
      if (name === './dateUtil.js') return dateUtil;
      if (name === './cloudApi.js') return {
        async getAllRecords() { return { success: true, data: [clone(cloudRecord)] }; },
        async getUserStats() {
          statisticsStarted.resolve();
          return stats ? stats() : statistics.promise;
        },
        async deleteMeditationRecord() { return remove ? remove() : { success: true }; },
        async recordMeditation() { return { success: true, data: { recordId: 'new-cloud-record' } }; }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return {
    manager, storage, statistics, statisticsStarted,
    checkins() {
      const data = storage.get(STORAGE_KEY);
      return data.checkinRecords || data;
    }
  };
}

for (const method of ['safeRecoverFromCloud', 'recoverUserDataFromCloud']) {
  test(`${method} discards a cloud snapshot captured before a completed deletion`, async () => {
    const app = harness();
    const recovery = app.manager[method](USER_ID);
    await app.statisticsStarted.promise;
    const result = await app.manager.deleteCheckin(DATE, { recordId: savedRecord._id, localId: savedRecord.localId });
    assert.equal(result.success, true);
    assert.deepEqual(app.checkins().dailyRecords, {});
    app.statistics.resolve({ success: true, data: { totalCount: 1 } });
    assert.equal(await recovery, false);
    assert.deepEqual(app.checkins().dailyRecords, {});
    assert.equal(app.checkins().userStats.totalCount, 0);
    assert.equal(app.storage.get(STORAGE_KEY).experienceRecords.note.text, '保留本地体验');
  });

  test(`${method} cannot replace local identities while a deletion is in flight`, async () => {
    const removal = deferred();
    const app = harness({ remove: () => removal.promise });
    const recovery = app.manager[method](USER_ID);
    await app.statisticsStarted.promise;
    const deletion = app.manager.deleteCheckin(DATE, { localId: savedRecord.localId });
    app.statistics.resolve({ success: true, data: {} });
    assert.equal(await recovery, false);
    assert.equal(app.checkins().dailyRecords[DATE].records[0].localId, savedRecord.localId);
    assert.equal(app.storage.get(STORAGE_KEY).experienceRecords.note.text, '保留本地体验');
    removal.resolve({ success: true });
    assert.equal((await deletion).success, true);
    assert.deepEqual(app.checkins().dailyRecords, {});
  });

  test(`${method} preserves a new local record created after recovery started`, async () => {
    const app = harness();
    const recovery = app.manager[method](USER_ID);
    await app.statisticsStarted.promise;
    const newRecord = app.manager.recordCheckin(12, [], [], NOW - 60000);
    assert.equal(newRecord.success, true);
    app.statistics.resolve({ success: true, data: {} });
    assert.equal(await recovery, false);
    const records = app.checkins().dailyRecords[DATE].records;
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.localId === newRecord.localId));
    assert.equal(app.checkins().dailyRecords[DATE].count, 2);
  });

  test(`${method} can still restore data when there is no concurrent local change`, async () => {
    const app = harness();
    const recovery = app.manager[method](USER_ID);
    await app.statisticsStarted.promise;
    app.statistics.resolve({ success: true, data: { totalCount: 1 } });
    assert.equal(await recovery, true);
    assert.equal(app.checkins().dailyRecords[DATE].count, 1);
    assert.equal(app.checkins().dailyRecords[DATE].records[0]._id, savedRecord._id);
    assert.equal(app.checkins().userStats.totalCount, 1);
  });
}

test('an older concurrent recovery cannot overwrite a newer completed recovery', async () => {
  const firstStats = deferred();
  const secondStats = deferred();
  const secondStarted = deferred();
  let statsCall = 0;
  const app = harness({ stats() {
    statsCall++;
    if (statsCall === 1) return firstStats.promise;
    secondStarted.resolve();
    return secondStats.promise;
  } });
  const firstRecovery = app.manager.safeRecoverFromCloud(USER_ID);
  await app.statisticsStarted.promise;
  const secondRecovery = app.manager.recoverUserDataFromCloud(USER_ID);
  await secondStarted.promise;
  secondStats.resolve({ success: true, data: { revision: 'newer' } });
  assert.equal(await secondRecovery, true);
  firstStats.resolve({ success: true, data: { revision: 'older' } });
  assert.equal(await firstRecovery, false);
  assert.equal(app.checkins().userStats.revision, 'newer');
});
