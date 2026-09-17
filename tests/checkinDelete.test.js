const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-17T04:00:00Z');
const KEY = 'meditation_checkin_local-test';
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const silentConsole = { log() {}, warn() {}, error() {} };
function load(file, globals) {
  const module = { exports: {} };
  vm.runInNewContext(read(file), { module, exports: module.exports, Date: FixedDate, console: silentConsole, ...globals });
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness(data = {}, options = {}) {
  const storage = new Map(Object.entries({
    localUserId: 'local-test', userOpenId: options.loggedIn === false ? '' : 'oz-test',
    [KEY]: clone(data), cloud_ranking_cache: { old: true }
  }));
  const calls = [];
  const backups = [];
  let failSave = false;
  const manager = load('miniprogram/utils/checkin.js', {
    setTimeout() {},
    wx: {
      getStorageSync: key => clone(storage.get(key)),
      setStorageSync(key, value) {
        if (key === KEY && failSave) throw new Error('存储失败');
        storage.set(key, clone(value));
      },
      removeStorageSync: key => storage.delete(key)
    },
    require(name) {
      if (name === './dateUtil.js') return load('miniprogram/utils/dateUtil.js');
      if (name === './cloudApi.js') return {
        async recordMeditation(...args) {
          backups.push(clone(args));
          return options.backup ? options.backup(...args) : { success: true, data: { recordId: `cloud-${backups.length}` } };
        },
        async deleteMeditationRecord(identity) {
          calls.push(clone(identity));
          return options.remove ? options.remove(identity) : { success: true };
        }
      };
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  return { manager, storage, calls, backups, failSave(value) { failSave = value; } };
}
const record = (id, timestamp = NOW, duration = 10) => ({ _id: id, timestamp, duration, experience: [] });
const day = records => ({ count: records.length, records, lastCheckin: records[records.length - 1].timestamp });

test('deleting one same-time record uses its cloud ID and recalculates both storage formats without losing notes', async () => {
  const data = {
    dailyRecords: { '2026-09-17': day([record('first'), record('second', NOW, 20)]) },
    monthlyStats: { '2026-09': { total: 2, count: 2, totalDuration: 30, days: ['2026-09-17'] } },
    userStats: { badges: { earned: true }, totalDuration: 30 }
  };
  for (const nested of [false, true]) {
    const stored = nested ? { checkinRecords: data, experienceRecords: { note: { text: '保留' } } }
      : { ...data, experienceRecords: { note: { text: '保留' } } };
    const app = harness(stored);
    assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'second', timestamp: NOW })).success, true);
    assert.equal(app.calls[0].recordId, 'second');
    const result = app.storage.get(KEY);
    const checkins = result.checkinRecords || result;
    assert.deepEqual(checkins.dailyRecords['2026-09-17'], day([record('first')]));
    assert.equal(checkins.monthlyStats['2026-09'].total, 1);
    assert.equal(checkins.monthlyStats['2026-09'].totalDuration, 10);
    assert.equal(checkins.userStats.totalDuration, 10);
    assert.deepEqual(checkins.userStats.badges, { earned: true });
    assert.equal(result.experienceRecords.note.text, '保留');
    assert.equal(app.storage.get('meditation_monthly_stats_local-test').totalMinutes, 10);
    assert.equal(app.storage.has('cloud_ranking_cache'), false);
  }
});

test('deleting the final record clears its calendar day and counts, including guest records', async () => {
  const app = harness({ dailyRecords: { '2026-09-17': day([record(undefined)]) }, monthlyStats: {} }, { loggedIn: false });
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { timestamp: NOW })).success, true);
  assert.deepEqual(app.storage.get(KEY).dailyRecords, {});
  assert.equal(app.storage.get(KEY).monthlyStats['2026-09'].total, 0);
  assert.equal(app.storage.get(KEY).userStats.totalCount, 0);
  assert.equal(app.storage.get('meditation_monthly_stats_local-test').totalMinutes, 0);
  assert.equal(app.calls.length, 0);
});

test('network or ambiguous cloud failures preserve local data and allow retry', async () => {
  for (const failure of [{ success: false, error: '网络错误' }, { success: false, code: 'AMBIGUOUS_RECORD', error: '无法确定记录' }]) {
    let response = failure;
    const data = { dailyRecords: { '2026-09-17': day([record('first')]) }, monthlyStats: {} };
    const app = harness(data, { remove: () => response });
    assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, false);
    assert.deepEqual(app.storage.get(KEY), data);
    assert.equal(app.storage.has('cloud_ranking_cache'), true);
    response = { success: true };
    assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, true);
  }
});

test('records absent from the cloud can still be deleted locally, and a failed local write can be retried', async () => {
  const app = harness({ dailyRecords: { '2026-09-17': day([record('first')]) }, monthlyStats: {} }, {
    remove: () => ({ success: false, code: 'RECORD_NOT_FOUND', error: '不存在' })
  });
  app.failSave(true);
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, false);
  assert.equal(app.storage.get(KEY).dailyRecords['2026-09-17'].count, 1);
  app.failSave(false);
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, true);
});

test('deletion waits for an in-flight backup, captures its cloud ID, and cannot be uploaded again', async () => {
  const backup = deferred();
  const app = harness({}, { backup: () => backup.promise });
  const result = app.manager.recordCheckin(10, [], [], NOW);
  const deletion = app.manager.deleteCheckin('2026-09-17', { localId: result.localId, timestamp: NOW });
  assert.equal(app.calls.length, 0);
  backup.resolve({ success: true, data: { recordId: 'new-cloud-id' } });
  assert.equal((await deletion).success, true);
  assert.equal(app.calls[0].recordId, 'new-cloud-id');
  await app.manager.syncLocalToCloud('local-test', 'oz-test');
  assert.equal(app.backups.length, 1);
  assert.deepEqual(app.storage.get(KEY).dailyRecords, {});
});

test('new local IDs disambiguate same-time records and backed-up IDs prevent duplicate sync uploads', async () => {
  const app = harness();
  const first = app.manager.recordCheckin(10, [], [], NOW);
  const second = app.manager.recordCheckin(20, [], [], NOW);
  assert.notEqual(first.localId, second.localId);
  await new Promise(resolve => setImmediate(resolve));
  await app.manager.syncLocalToCloud('local-test', 'oz-test');
  assert.equal(app.backups.length, 2);
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { localId: second.localId })).success, true);
  assert.equal(app.calls[0].recordId, 'cloud-2');
  const remaining = app.storage.get(KEY).dailyRecords['2026-09-17'];
  assert.equal(remaining.records[0].localId, first.localId);
  assert.equal(remaining.count, 1);
});

test('overlapping delete attempts stay locked and new records created during the request survive', async () => {
  const removal = deferred();
  const app = harness({ dailyRecords: { '2026-09-17': day([record('first')]) }, monthlyStats: {} }, { remove: () => removal.promise });
  const deletion = app.manager.deleteCheckin('2026-09-17', { recordId: 'first' });
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, false);
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { recordId: 'first' })).success, false);
  const saved = app.manager.recordCheckin(5, [], [], NOW - 1000);
  removal.resolve({ success: true });
  assert.equal((await deletion).success, true);
  assert.equal(app.calls.length, 1);
  const remaining = app.storage.get(KEY).dailyRecords['2026-09-17'].records;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].localId, saved.localId);
});

test('legacy ISO timestamps are forwarded intact and ambiguous local records cannot be deleted', async () => {
  const iso = new Date(NOW).toISOString();
  const app = harness({ dailyRecords: { '2026-09-17': day([record(undefined, iso)]) }, monthlyStats: {} });
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { timestamp: NOW })).success, true);
  assert.equal(app.calls[0].timestamp, iso);
  const ambiguous = harness({ dailyRecords: { '2026-09-17': day([record(undefined), record(undefined)]) }, monthlyStats: {} });
  assert.equal((await ambiguous.manager.deleteCheckin('2026-09-17', { timestamp: NOW })).success, false);
  assert.equal(ambiguous.calls.length, 0);
  assert.equal(ambiguous.storage.get(KEY).dailyRecords['2026-09-17'].count, 2);
});

test('failed backups still delete by local identity rather than another cloud record at the same time', async () => {
  const app = harness({}, {
    backup: () => ({ success: false, error: '备份失败' }),
    remove: identity => {
      assert.ok(identity.localId);
      return { success: false, code: 'RECORD_NOT_FOUND' };
    }
  });
  const saved = app.manager.recordCheckin(10, [], [], NOW);
  assert.equal((await app.manager.deleteCheckin('2026-09-17', { localId: saved.localId })).success, true);
  assert.equal(app.calls[0].localId, saved.localId);
  assert.equal(app.backups[0][4], saved.localId);
});

test('deleting a historical day rebuilds the streak and affected month without changing current-month minutes', async () => {
  const app = harness({ dailyRecords: {
    '2026-08-30': day([record('august', Date.parse('2026-08-30T01:00:00Z'), 50)]),
    '2026-09-15': day([record('first', NOW - 2 * 86400000)]),
    '2026-09-16': day([record('middle', NOW - 86400000)]),
    '2026-09-17': day([record('last')])
  }, monthlyStats: {} });
  assert.equal((await app.manager.deleteCheckin('2026-09-16', { recordId: 'middle' })).success, true);
  assert.equal(app.storage.get(KEY).userStats.longestStreak, 1);
  assert.equal(app.storage.get(KEY).userStats.totalDays, 3);
  assert.equal((await app.manager.deleteCheckin('2026-08-30', { recordId: 'august' })).success, true);
  assert.equal(app.storage.get(KEY).monthlyStats['2026-08'].totalDuration, 0);
  assert.equal(app.storage.get('meditation_monthly_stats_local-test').totalMinutes, 20);
});

test('recovering cloud records retains the server identity needed for subsequent deletion', () => {
  const app = harness();
  const result = app.manager.rebuildLocalCacheFromCloudRecords([{ ...record('cloud-record'), date: '2026-09-17' }]);
  assert.equal(result.checkinRecords.dailyRecords['2026-09-17'].records[0]._id, 'cloud-record');
});

test('cloud deletion API forwards identity, preserves error codes, and reports network failures', async () => {
  const calls = [];
  let result = { success: false, code: 'RECORD_NOT_FOUND', error: '记录不存在' };
  const api = load('miniprogram/utils/cloudApi.js', {
    wx: { cloud: { callFunction(options) {
      calls.push(clone(options.data));
      if (result) options.success({ result });
      else options.fail(new Error('offline'));
    } } }
  });
  const identity = { recordId: 'first', date: '2026-09-17', timestamp: NOW };
  assert.equal((await api.deleteMeditationRecord(identity)).code, 'RECORD_NOT_FOUND');
  assert.deepEqual(calls[0], { type: 'deleteMeditationRecord', data: identity });
  result = null;
  assert.equal((await api.deleteMeditationRecord(identity)).success, false);
});

test('cloud backup API includes the stable local ID used to locate a record after a lost response', async () => {
  const calls = [];
  const api = load('miniprogram/utils/cloudApi.js', {
    wx: { cloud: { callFunction(options) {
      calls.push(clone(options.data));
      options.success({ result: { success: true, data: { recordId: 'server-id' } } });
    } } }
  });
  await api.recordMeditation(10, [], [], NOW, 'stable-local-id');
  assert.equal(calls[0].data.localId, 'stable-local-id');
  await api.recordMeditation(10, [], [], NOW);
  assert.equal(Object.hasOwn(calls[1].data, 'localId'), false);
});
