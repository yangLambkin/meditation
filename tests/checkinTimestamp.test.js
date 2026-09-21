const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-17T04:05:06Z');
const silentConsole = { log() {}, warn() {}, error() {} };
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function loadModule(filename, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(read(filename), {
    module, exports: module.exports, Date: FixedDate, console: silentConsole,
    ...globals,
  }, { filename });
  return module.exports;
}

function createLocalHarness(options = {}) {
  const storage = new Map(Object.entries({
    localUserId: 'local-test', userOpenId: 'oz-test', ...clone(options.storage || {}),
  }));
  const backups = [];
  const writes = [];
  const cloudApi = {
    async recordMeditation(...args) {
      backups.push(clone(args));
      return { success: true, data: { recordId: `cloud-${backups.length}` } };
    },
  };
  const dateUtil = loadModule('miniprogram/utils/dateUtil.js');
  const manager = loadModule('miniprogram/utils/checkin.js', {
    setTimeout() {},
    wx: {
      getStorageSync: key => clone(storage.get(key)),
      setStorageSync(key, value) {
        if (options.failSave && key === 'meditation_checkin_local-test') throw new Error('storage full');
        writes.push(key);
        storage.set(key, clone(value));
      },
    },
    require(name) {
      if (name === './cloudApi.js') return cloudApi;
      if (name === './dateUtil.js') return dateUtil;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { manager, storage, backups, writes, dateUtil };
}

function createCloudHarness(initialStats, otherUsers = []) {
  const records = [];
  let stats = initialStats ? { _id: 'existing-stats', ...clone(initialStats) } : undefined;
  const locks = new Map();
  const peers = clone(otherUsers);
  const allStats = () => stats ? [stats, ...peers] : peers;
  const operations = {
    set: value => ({ op: 'set', value }),
    inc: value => ({ op: 'inc', value }),
    max: value => ({ op: 'max', value }),
    push: value => ({ op: 'push', value }),
    gt: value => ({ op: 'gt', value }),
    exists: value => ({ op: 'exists', value }),
    and: value => ({ op: 'and', value }),
    or: value => ({ op: 'or', value }),
  };
  function matches(row, filter) {
    if (filter.op === 'and') return filter.value.every(item => matches(row, item));
    if (filter.op === 'or') return filter.value.some(item => matches(row, item));
    return Object.entries(filter).every(([key, value]) => {
      if (value && value.op === 'gt') return row[key] > value.value;
      if (value && value.op === 'exists') return Object.hasOwn(row, key) === value.value;
      return row[key] === value;
    });
  }
  function applyUpdates(data) {
    for (const [field, rawValue] of Object.entries(data)) {
      const fields = field.split('.');
      let target = stats;
      for (const part of fields.slice(0, -1)) {
        if (!target[part]) target[part] = {};
        target = target[part];
      }
      const key = fields[fields.length - 1];
      if (rawValue && rawValue.op === 'inc') target[key] = (target[key] || 0) + rawValue.value;
      else if (rawValue && rawValue.op === 'max') target[key] = Math.max(target[key] || 0, rawValue.value);
      else if (rawValue && rawValue.op === 'push') target[key] = [...(target[key] || []), rawValue.value];
      else if (rawValue && rawValue.op === 'set') target[key] = clone(rawValue.value);
      else target[key] = clone(rawValue);
    }
  }
  const database = {
    command: operations,
    async runTransaction(callback) { return callback({ collection(name) { return { doc: database.collection(name).doc }; } }); },
    collection(name) {
      return {
        async count() {
          assert.equal(name, 'user_stats');
          return { total: allStats().length };
        },
        async add({ data }) {
          if (name === 'meditation_records') records.push({ _id: data._id || `record-${records.length}`, ...clone(data) });
          else if (name === 'user_stats') stats = { _id: data._id || 'stats', ...clone(data) };
          else throw new Error(`Unexpected collection: ${name}`);
          return { _id: data._id || (name === 'meditation_records' ? `record-${records.length - 1}` : 'stats') };
        },
        doc(id) { return {
          async get() { return { data: clone(name === 'meditation_locks' ? locks.get(id) : name === 'meditation_records' ? records.find(row => row._id === id) : stats) || null }; },
          async set({ data }) {
            if (name === 'meditation_locks') locks.set(id, { _id: id, ...clone(data) });
            else if (name === 'meditation_records') records.push({ _id: id, ...clone(data) });
            else stats = { _id: id, ...clone(data) };
            return { _id: id };
          },
          async update({ data }) { applyUpdates(data); return { stats: { updated: 1 } }; }
        }; },
        where(filter) {
          let projection, offset = 0, limit = Infinity;
          return {
            field(value) { projection = value; return this; },
            orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
            async get() {
              let rows = (name === 'meditation_records' ? records : allStats()).filter(row => matches(row, filter)).slice(offset, offset + limit);
              if (projection) rows = rows.map(row => Object.fromEntries(
                Object.keys(projection).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])
              ));
              return { data: clone(rows) };
            },
            async count() { return { total: allStats().filter(row => matches(row, filter)).length }; },
            async update({ data }) { applyUpdates(data); },
          };
        },
      };
    },
  };
  const entry = loadModule('cloudfunctions/meditationManager/index.js', {
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return {
        init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
        getWXContext: () => ({ OPENID: 'oz-test' }),
      };
    },
  });
  return {
    records,
    get stats() { return stats; },
    async record(data) { return clone(await entry.main({ type: 'recordMeditation', data })); },
    async ranking() { return clone(await entry.main({ type: 'getRankingSnapshot', rankingType: 'daily' })); },
  };
}

test('local check-in uses the selected Beijing date/month and identical backup timestamp', () => {
  const { manager, backups, storage } = createLocalHarness();
  const timestamp = Date.parse('2026-08-31T16:05:00Z');
  const experience = [{ text: '平静', uniqueId: String(timestamp) }];
  const result = manager.recordCheckin(20, ['平静'], experience, timestamp);
  assert.equal(result.date, '2026-08-31');
  const data = storage.get('meditation_checkin_local-test');
  assert.equal(data.dailyRecords['2026-08-31'].records[0].timestamp, timestamp);
  assert.deepEqual(data.dailyRecords['2026-08-31'].records[0].experience, experience);
  assert.equal(data.monthlyStats['2026-08'].total, 1);
  assert.equal(storage.get('meditation_monthly_stats_local-test').totalMinutes, 0);
  assert.deepEqual(backups[0].slice(0, 5), [20, ['平静'], experience, timestamp, result.localId]);
});

test('legacy calls default to now; earlier same-day and previous-month records do not regress latest time/current-month cache', () => {
  const { manager, storage } = createLocalHarness();
  manager.recordCheckin(10, []);
  manager.recordCheckin(15, [], [], NOW - 3600000);
  manager.recordCheckin(50, [], [], Date.parse('2026-08-30T06:00:00Z'));
  const data = storage.get('meditation_checkin_local-test');
  assert.equal(data.dailyRecords['2026-09-17'].lastCheckin, NOW);
  assert.equal(data.dailyRecords['2026-09-17'].records[0].timestamp, NOW);
  assert.equal(data.dailyRecords['2026-09-17'].count, 2);
  assert.equal(data.monthlyStats['2026-08'].total, 1);
  assert.equal(storage.get('meditation_monthly_stats_local-test').totalMinutes, 25);
});

test('invalid and future local timestamps cannot write or start a backup', () => {
  for (const timestamp of [null, '', String(NOW), NaN, Infinity, -1, 0, NOW + 1, NOW - 0.5]) {
    const app = createLocalHarness();
    assert.throws(() => app.manager.recordCheckin(10, [], [], timestamp), /打卡时间/);
    assert.equal(app.writes.length, 0);
    assert.equal(app.backups.length, 0);
  }
});

test('failed local storage cannot report success, update the cache, or start a cloud backup', () => {
  const app = createLocalHarness({ failSave: true });
  assert.throws(() => app.manager.recordCheckin(10, []), /保存失败/);
  assert.equal(app.backups.length, 0);
  assert.equal(app.storage.has('meditation_checkin_local-test'), false);
  assert.equal(app.storage.has('meditation_monthly_stats_local-test'), false);
});

test('manually uploading recent queued records preserves their original timestamps in both storage formats', async () => {
  const timestamp = Date.parse('2026-09-16T02:30:00Z');
  const data = { dailyRecords: { '2026-09-16': { records: [{ timestamp, duration: 12, emotion: [], experience: [],
    localId: 'recent-pending', syncVersion: 1, syncStatus: 'pending', syncOpenid: 'oz-test' }] } }, monthlyStats: {} };
  for (const storedData of [data, { checkinRecords: data, experienceRecords: {} }]) {
    const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': storedData } });
    await app.manager.retryPendingBackups();
    assert.deepEqual(app.backups[0].slice(0, 4), [12, [], [], timestamp]);
    assert.equal(app.backups[0][4], 'recent-pending');
  }
});

test('cloud API forwards exact selected/default timestamps and rejects invalid input before calling the network', async () => {
  const calls = [];
  const api = loadModule('miniprogram/utils/cloudApi.js', {
    wx: { cloud: { callFunction(options) {
      calls.push(clone(options.data));
      options.success({ result: { success: true, data: {} } });
    } } },
  });
  const timestamp = NOW - 86400000;
  await api.recordMeditation(10, [], [], timestamp);
  await api.recordMeditation(10, []);
  assert.equal(calls[0].data.timestamp, timestamp);
  assert.equal(calls[1].data.timestamp, NOW);
  for (const invalid of [NOW + 1, null, NaN, 'invalid']) {
    assert.equal((await api.recordMeditation(10, [], [], invalid)).success, false);
  }
  assert.equal(calls.length, 2);
});

test('cloud persists selected Beijing date and experience objects while creation time stays current', async () => {
  const app = createCloudHarness();
  const timestamp = Date.parse('2026-08-31T16:05:00Z');
  const experience = [{ text: '平静', uniqueId: String(timestamp), timestamp: '2026-09-01 00:05:00' }];
  const result = await app.record({ duration: 20, emotion: [], experience, timestamp });
  assert.equal(result.success, true);
  assert.equal(result.data.date, '2026-08-31');
  assert.equal(result.data.timestamp, timestamp);
  assert.equal(app.records[0].timestamp, timestamp);
  assert.equal(app.records[0].createdAt, new Date(NOW).toISOString());
  assert.equal(app.records[0].updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(app.records[0].experience, experience);
  assert.equal(app.stats.monthlyStats['2026-08'].count, 1);
});

test('cloud accepts old callers without timestamp and rejects invalid/future timestamps without writes', async () => {
  const app = createCloudHarness();
  assert.equal((await app.record({ duration: 10 })).data.timestamp, NOW);
  for (const timestamp of [NOW + 1, NaN, Infinity, '', null, 0, -1]) {
    assert.equal((await app.record({ duration: 10, timestamp })).success, false);
  }
  assert.equal(app.records.length, 1);
  assert.equal(app.stats.totalCount, 1);
});

test('backdated cloud records keep latest day/month totals and do not double-count a historical day', async () => {
  const app = createCloudHarness();
  await app.record({ duration: 10, timestamp: NOW });
  const timestamp = Date.parse('2026-08-30T06:00:00Z');
  await app.record({ duration: 20, timestamp });
  await app.record({ duration: 30, timestamp: timestamp + 60000 });
  assert.equal(app.stats.lastCheckin, '2026-09-17');
  assert.equal(app.stats.lastCheckinDate, '2026-09-17');
  assert.equal(app.stats.dailyTotalDuration, 10);
  assert.equal(app.stats.monthlyTotalDuration, 10);
  assert.equal(app.stats.totalDays, 2);
  assert.equal(app.stats.totalCount, 3);
  assert.equal(app.stats.totalDuration, 60);
  assert.deepEqual(app.stats.monthlyStats['2026-08'], { days: ['2026-08-30'], count: 2, totalDuration: 50 });
});

test('filling an earlier gap updates streaks and monthly totals without resetting the latest day', async () => {
  const app = createCloudHarness();
  await app.record({ duration: 10, timestamp: NOW - 2 * 86400000 });
  await app.record({ duration: 10, timestamp: NOW });
  assert.equal(app.stats.currentStreak, 1);
  await app.record({ duration: 20, timestamp: NOW - 86400000 });
  assert.equal(app.stats.currentStreak, 3);
  assert.equal(app.stats.longestStreak, 3);
  assert.equal(app.stats.longestCheckInDays, 3);
  assert.equal(app.stats.lastCheckin, '2026-09-17');
  assert.equal(app.stats.dailyTotalDuration, 10);
  assert.equal(app.stats.monthlyTotalDuration, 40);
  assert.equal(app.stats.totalDays, 3);
});

test('a first check-in backdated to yesterday does not grant a daily ranking; total users still includes everyone', async () => {
  const app = createCloudHarness(undefined, [
    { _openid: 'other', lastCheckinDate: '2026-09-17', dailyTotalDuration: 5 },
  ]);
  await app.record({ duration: 100, timestamp: NOW - 86400000 });
  const result = await app.ranking();
  assert.equal(result.success, true);
  assert.equal(result.data.hasRanking, false);
  assert.equal(result.data.currentUserRank, 0);
  assert.equal(result.data.period, '2026-09-17');
  assert.equal(result.data.totalUsers, 2);
});

test('daily rank ignores other users\' historical durations and supports a missing legacy date field', async () => {
  const app = createCloudHarness(undefined, [
    { _openid: 'yesterday', lastCheckinDate: '2026-09-16', dailyTotalDuration: 200 },
    { _openid: 'today-higher', lastCheckinDate: '2026-09-17', dailyTotalDuration: 30 },
    { _openid: 'today-tied', lastCheckinDate: '2026-09-17', dailyTotalDuration: 20 },
    { _openid: 'legacy-today', lastCheckin: '2026-09-17', dailyTotalDuration: 40 },
    { _openid: 'legacy-old', lastCheckin: '2026-09-16', dailyTotalDuration: 400 },
    { _openid: 'canonical-old', lastCheckinDate: '2026-09-16', lastCheckin: '2026-09-17', dailyTotalDuration: 500 },
    { _openid: 'unknown-date', dailyTotalDuration: 600 },
  ]);
  await app.record({ duration: 20, timestamp: NOW });
  const result = await app.ranking();
  assert.equal(result.success, true);
  assert.equal(result.data.hasRanking, true);
  assert.equal(result.data.currentUserRank, 3);
  assert.equal(result.data.totalUsers, 8);
});

test('the current user can use a legacy lastCheckin date, but an explicit old lastCheckinDate takes precedence', async () => {
  const legacy = createCloudHarness({ _openid: 'oz-test', lastCheckin: '2026-09-17', dailyTotalDuration: 20 });
  assert.equal((await legacy.ranking()).data.currentUserRank, 1);
  const old = createCloudHarness({
    _openid: 'oz-test', lastCheckinDate: '2026-09-16', lastCheckin: '2026-09-17', dailyTotalDuration: 20,
  });
  assert.equal((await old.ranking()).data.hasRanking, false);
});

test('one stable local identity survives repeated submits and restart, distinct identities remain separate', async () => {
  const app = createLocalHarness();
  const first = app.manager.recordCheckin(10, [], [], NOW, 'session');
  const second = app.manager.recordCheckin(10, [], [], NOW, 'session');
  assert.equal(second.duplicate, true);
  assert.equal(first.localId, second.localId);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  app.manager.recordCheckin(10, [], [], NOW, 'another-session');
  assert.equal(app.manager.getUserStats().totalCount, 2);
  const restarted = createLocalHarness({ storage: Object.fromEntries(app.storage) });
  assert.equal(restarted.manager.recordCheckin(10, [], [], NOW, 'session').duplicate, true);
  assert.equal(restarted.manager.getUserStats().totalCount, 2);
});

test('legacy sync entry points and manual queues never implicitly upload unversioned historical records', async () => {
  const timestamp = NOW - 30 * 86400000;
  const date = loadModule('miniprogram/utils/dateUtil.js').getBusinessDate(timestamp);
  const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': {
    dailyRecords: { [date]: { count: 1, records: [{ timestamp, duration: 10 }] } }, monthlyStats: {}
  } } });
  await Promise.all([app.manager.syncLocalToCloud('local-test', 'oz-test'), app.manager.syncLocalToCloud('local-test', 'oz-test')]);
  assert.equal(app.backups.length, 0);
  const record = app.storage.get('meditation_checkin_local-test').dailyRecords[date].records[0];
  assert.equal(record.localId, undefined);
  assert.equal(record.timestamp, timestamp);
  await app.manager.syncLocalToCloud('local-test', 'oz-test');
  await app.manager.retryPendingBackups();
  assert.equal(app.backups.length, 0);
});

test('manual backfill validates the three business dates but returns a previously saved identity after the window', () => {
  const app = createLocalHarness();
  assert.throws(() => app.manager.recordCheckin(10, [], [], NOW, { idempotencyKey: 'new', source: 'manual', date: '2026-09-14' }), /最近三天/);
  const result = app.manager.recordCheckin(10, [], [], NOW, { idempotencyKey: 'saved', source: 'manual', date: '2026-09-15' });
  assert.equal(result.date, '2026-09-15');
  assert.equal(app.manager.recordCheckin(10, [], [], NOW, { idempotencyKey: 'saved', source: 'manual', date: '2026-09-14' }).duplicate, true);
  assert.equal(app.manager.getUserStats().totalCount, 1);
});

test('cached automatic history is regrouped at 02:00 while explicit manual dates are kept', () => {
  const timestamp = Date.parse('2026-09-01T00:30:00+08:00');
  const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': {
    dailyRecords: { '2026-09-01': { count: 2, records: [
      { localId: 'timer', timestamp, duration: 10 },
      { localId: 'manual', timestamp, duration: 20, source: 'manual' }
    ] } }, monthlyStats: {}
  } } });
  const data = app.manager.getUserCheckinData();
  assert.equal(data.dailyRecords['2026-08-31'].count, 1);
  assert.equal(data.dailyRecords['2026-09-01'].count, 1);
  assert.equal(data.monthlyStats['2026-08'].total, 1);
  assert.equal(data.monthlyStats['2026-09'].total, 1);
});

test('business date helpers use 02:00 across year/month/leap boundaries independent of local timezone', () => {
  const dates = loadModule('miniprogram/utils/dateUtil.js');
  assert.equal(dates.getBusinessDate('2027-01-01T01:59:59+08:00'), '2026-12-31');
  assert.equal(dates.getBusinessDate('2027-01-01T02:00:00+08:00'), '2027-01-01');
  assert.equal(dates.getCalendarDate('2027-01-01T01:00:00+08:00'), '2027-01-01');
  assert.equal(dates.getBusinessMonth('2027-01-01T01:00:00+08:00'), '2026-12');
  assert.equal(dates.addBusinessDays('2028-03-01', -1), '2028-02-29');
  assert.equal(dates.getBusinessDateWindow('2028-02-29').end, Date.parse('2028-03-01T02:00:00+08:00'));
});

test('cloud recovery retains legacy explicit manual dates and clears resolved upload errors', () => {
  const app = createLocalHarness();
  const timestamp = NOW;
  const stored = { dailyRecords: { '2026-09-15': { count: 1, records: [
    { localId: 'manual', date: '2026-09-15', dateSource: 'manual', timestamp, duration: 10, syncError: '失败', syncErrorCode: 'SYNC_FAILED' }
  ] } }, monthlyStats: {} };
  const remote = { _id: 'cloud', localId: 'manual', date: '2026-09-15', dateSource: 'manual', timestamp, duration: 10 };
  const merged = app.manager.mergeCloudRecordsIntoCache(stored, [remote]);
  const record = merged.checkinRecords.dailyRecords['2026-09-15'].records[0];
  assert.equal(record.dateSource, 'manual');
  assert.equal(record.syncError, undefined);
  assert.equal(record.syncErrorCode, undefined);
  const dates = loadModule('miniprogram/utils/dateUtil.js');
  assert.equal(dates.getRecordBusinessDate(record), '2026-09-15');
});

test('business date migration preserves early-hours records beside older count-only buckets in either order', () => {
  const timestamp = Date.parse('2026-09-01T01:59:59.999+08:00');
  const entries = [
    ['2026-09-01', { count: 1, records: [{ localId: 'late', timestamp, duration: 10 }] }],
    ['2026-08-31', { count: 2, records: [] }]
  ];
  for (const ordered of [entries, entries.slice().reverse()]) {
    for (const nested of [false, true]) {
      const data = { dailyRecords: Object.fromEntries(ordered), monthlyStats: {}, userStats: { totalDays: 2 } };
      const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': nested ? { checkinRecords: data } : data } });
      const migrated = app.manager.getUserCheckinData();
      assert.deepEqual(Object.keys(migrated.dailyRecords), ['2026-08-31']);
      assert.equal(migrated.dailyRecords['2026-08-31'].count, 3);
      assert.equal(migrated.dailyRecords['2026-08-31'].records[0].localId, 'late');
      assert.equal(migrated.monthlyStats['2026-08'].totalDuration, 10);
      assert.equal(migrated.userStats.totalDays, 1);
      const writes = app.writes.length;
      assert.deepEqual(clone(app.manager.getUserCheckinData().dailyRecords), clone(migrated.dailyRecords));
      assert.equal(app.writes.length, writes, 'repeat reads do not migrate a second time');
    }
  }
});

test('recent legacy monthly cache is invalidated before returning totals under the 02:00 rule', () => {
  const app = createLocalHarness({ storage: {
    'meditation_checkin_local-test': { dailyRecords: {
      '2026-09-01': { count: 2, records: [
        { timestamp: Date.parse('2026-09-01T01:00:00+08:00'), duration: 10 },
        { timestamp: Date.parse('2026-09-01T02:00:00+08:00'), duration: 20 }
      ] }
    }, monthlyStats: {} },
    'meditation_monthly_stats_local-test': {
      currentMonth: '2026-09', totalMinutes: 30, lastUpdateTime: new Date(NOW).toISOString()
    }
  } });
  assert.equal(app.manager.getCurrentMonthMinutes(), 20);
  assert.equal(app.storage.get('meditation_monthly_stats_local-test').businessDayVersion, 2);
  assert.equal(app.manager.getUserStats().totalDays, 2);
});

test('migration retains historical counts without detail when a partially known day moves across months', () => {
  const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': {
    dailyRecords: { '2026-09-01': { count: 3, records: [
      { localId: 'known', timestamp: Date.parse('2026-09-01T01:00:00+08:00'), duration: 10 }
    ] } }, monthlyStats: {}
  } } });
  const data = app.manager.getUserCheckinData();
  assert.equal(data.dailyRecords['2026-08-31'].count, 1);
  assert.equal(data.dailyRecords['2026-09-01'].count, 2);
  assert.equal(data.dailyRecords['2026-09-01'].records.length, 0);
  assert.equal(data.monthlyStats['2026-08'].total, 1);
  assert.equal(data.monthlyStats['2026-09'].total, 2);
  assert.equal(app.manager.getUserStats().totalDays, 2);
  assert.equal(app.manager.getUserStats().totalCount, 3);
});

test('monthly cache keeps the month used for calculation when 02:00 passes before cache write', () => {
  const app = createLocalHarness({ storage: { 'meditation_checkin_local-test': {
    businessDayVersion: 2,
    dailyRecords: {
      '2026-09-30': { count: 1, records: [{ duration: 10 }] },
      '2026-10-01': { count: 1, records: [{ duration: 20 }] }
    }, monthlyStats: {}
  } } });
  let calls = 0;
  app.dateUtil.getBusinessMonth = () => calls++ === 0 ? '2026-09' : '2026-10';
  assert.equal(app.manager.updateMonthlyStatsCache({}, 0, '2026-09'), 10);
  assert.equal(app.storage.get('meditation_monthly_stats_local-test').currentMonth, '2026-09');
  assert.equal(app.manager.getCurrentMonthMinutes(), 20);
  assert.equal(app.storage.get('meditation_monthly_stats_local-test').currentMonth, '2026-10');
});
