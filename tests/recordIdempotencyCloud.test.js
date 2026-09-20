const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let now = Date.parse(options.now || '2026-09-20T12:00:00+08:00');
  let openid = options.openid === undefined ? 'owner' : options.openid;
  let state = { meditation_records: clone(options.records || []), user_stats: clone(options.stats || []), experience_records: [], meditation_locks: [] };
  let queue = Promise.resolve();
  let transactions = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const command = { set: value => ({ $set: value }), gt: value => ({ $gt: value }), in: value => ({ $in: value }) };
  function collection(name, data, inTransaction) {
    function query(filter = {}) {
      let offset = 0, limit = Infinity;
      return {
        where(value) { return query(value); }, orderBy() { return this; },
        skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
        async get() {
          const rows = data[name].filter(row => Object.entries(filter).every(([key, value]) =>
            value && value.$gt !== undefined ? row[key] > value.$gt : value && value.$in ? value.$in.includes(row[key]) : row[key] === value))
            .sort((a, b) => a._id.localeCompare(b._id));
          return { data: clone(rows.slice(offset, offset + limit)) };
        }
      };
    }
    return { ...query(),
      async add({ data: record }) {
        assert.ok(inTransaction, 'Every record/stat write must use the same transaction');
        if (name === 'user_stats' && options.failStats) throw new Error('stats failed');
        const _id = record._id || `${name}_${data[name].length}`;
        assert.equal(data[name].some(row => row._id === _id), false, 'Document identity must be unique');
        data[name].push({ ...clone(record), _id });
        return { _id };
      },
      doc(id) { return {
        async get() { return { data: clone(data[name].find(row => row._id === id)) || null }; },
        async set({ data: record }) {
          assert.ok(inTransaction);
          if (name === 'user_stats' && options.failStats) throw new Error('stats failed');
          const index = data[name].findIndex(row => row._id === id);
          const value = { ...clone(record), _id: id };
          if (index < 0) data[name].push(value); else data[name][index] = value;
          return { _id: id };
        },
        async update({ data: patch }) {
          assert.ok(inTransaction);
          if (name === 'user_stats' && options.failStats) throw new Error('stats failed');
          const row = data[name].find(row => row._id === id);
          if (!row) throw new Error('not found');
          Object.entries(patch).forEach(([key, value]) => row[key] = clone(value && value.$set !== undefined ? value.$set : value));
          return { stats: { updated: 1 } };
        },
        async remove() {
          assert.ok(inTransaction);
          const index = data[name].findIndex(row => row._id === id);
          if (index >= 0) data[name].splice(index, 1);
          return { stats: { removed: index >= 0 ? 1 : 0 } };
        }
      }; }
    };
  }
  const database = {
    command,
    collection(name) { return collection(name, state, false); },
    runTransaction(callback) {
      transactions++;
      const current = queue.then(async () => {
        const pending = clone(state);
        const result = await callback({ collection: name => {
          const ref = collection(name, pending, true);
          return { doc: ref.doc, where() { throw new Error('Transactions must use doc APIs'); }, add() { throw new Error('Transactions must use doc APIs'); } };
        } });
        if (options.failCommit) throw new Error('commit failed');
        state = pending;
        return result;
      });
      queue = current.catch(() => {});
      return current;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, Date: Clock, console: { log() {}, error() {}, warn() {} },
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => database, getWXContext: () => ({ OPENID: openid }) };
    }
  });
  return {
    get records() { return clone(state.meditation_records); },
    get stats() { return clone(state.user_stats); },
    get experiences() { return clone(state.experience_records); },
    get transactions() { return transactions; },
    setNow(value) { now = Date.parse(value); }, setOpenid(value) { openid = value; },
    async call(event) { return clone(await module.exports.main(event)); },
    async record(data) { return clone(await module.exports.main({ type: 'recordMeditation', data })); }
  };
}

test('concurrent same-key retries create one record, one experience payload and count once', async () => {
  const app = harness();
  const data = { localId: 'timer-session', duration: 10, experience: [{ text: '安静' }] };
  const results = await Promise.all(Array.from({ length: 12 }, () => app.record(data)));
  assert.ok(results.every(result => result.success));
  assert.equal(new Set(results.map(result => result.data.recordId)).size, 1);
  assert.equal(app.records.length, 1);
  assert.equal(app.records[0].experience.length, 1);
  assert.equal(app.stats[0].totalCount, 1);
  assert.equal(app.stats[0].totalDuration, 10);
});

test('distinct sessions at the exact same time/duration stay separate and both update statistics', async () => {
  const app = harness();
  const timestamp = Date.parse('2026-09-20T10:00:00+08:00');
  const results = await Promise.all(['one', 'two'].map(localId => app.record({ localId, timestamp, duration: 10 })));
  assert.ok(results.every(result => result.success));
  assert.equal(app.records.length, 2);
  assert.equal(app.stats[0].totalCount, 2);
  assert.equal(app.stats[0].totalDuration, 20);
});

test('same client identity is scoped to the authenticated account', async () => {
  const app = harness();
  const first = await app.record({ localId: 'same-session', duration: 10 });
  app.setOpenid('another-owner');
  const second = await app.record({ localId: 'same-session', duration: 10 });
  assert.notEqual(first.data.recordId, second.data.recordId);
  assert.equal(app.records.length, 2);
  assert.equal(app.stats.length, 2);
});

test('a stats or transaction failure rolls back the record and retry can succeed once', async () => {
  for (const failure of ['failStats', 'failCommit']) {
    const options = { [failure]: true };
    const app = harness(options);
    assert.equal((await app.record({ localId: 'retry', duration: 20 })).success, false);
    assert.equal(app.records.length, 0);
    assert.equal(app.stats.length, 0);
    options[failure] = false;
    assert.equal((await app.record({ localId: 'retry', duration: 20 })).success, true);
    assert.equal(app.records.length, 1);
    assert.equal(app.stats[0].totalCount, 1);
  }
});

test('02:00 crosses the day/month, manual backfill accepts only three days, old timer retries still upload', async () => {
  const app = harness({ now: '2026-10-01T01:59:59+08:00' });
  assert.equal((await app.record({ localId: 'before', duration: 10 })).data.date, '2026-09-30');
  assert.equal((await app.record({ localId: 'manual-ok', source: 'manual', date: '2026-09-28', duration: 10 })).success, true);
  assert.equal((await app.record({ localId: 'manual-old', source: 'manual', date: '2026-09-27', duration: 10 })).code, 'DATE_OUT_OF_RANGE');
  assert.equal((await app.record({ localId: 'manual-future', source: 'manual', date: '2026-10-01', duration: 10 })).code, 'DATE_OUT_OF_RANGE');
  app.setNow('2026-10-01T02:00:00+08:00');
  assert.equal((await app.record({ localId: 'after', duration: 10 })).data.date, '2026-10-01');
  // A successful manual operation may be retried after it falls outside the backfill window.
  assert.equal((await app.record({ localId: 'manual-ok', source: 'manual', date: '2026-09-28', duration: 10 })).data.duplicate, true);
  assert.equal((await app.record({ localId: 'offline', source: 'timer', timestamp: Date.parse('2026-08-01T01:30:00+08:00'), duration: 20 })).data.date, '2026-07-31');
});

test('standalone experience retries use their stable identity exactly once', async () => {
  const app = harness();
  const results = await Promise.all(Array.from({ length: 6 }, () => app.call({ type: 'saveExperienceRecord', record: { uniqueId: 'session-id', text: '静下来' } })));
  assert.ok(results.every(result => result.success));
  assert.equal(app.experiences.length, 1);
});

test('invalid durations cannot write records or statistics', async () => {
  const app = harness();
  for (const duration of [0, -1, 1.5, 1441, Infinity, NaN]) {
    assert.equal((await app.record({ localId: 'invalid', duration })).success, false);
  }
  assert.equal(app.records.length, 0);
  assert.equal(app.stats.length, 0);
  assert.equal((await app.record({ localId: 'maximum', duration: 1440 })).success, true);
});

test('maintenance defaults to dry run, preserves explicit dates and only merges stable duplicate identities', async () => {
  const timestamp = Date.parse('2026-09-20T00:30:00+08:00');
  const app = harness({ openid: '', records: [
    { _id: 'a', _openid: 'owner', localId: 'same', date: '2026-09-20', timestamp, duration: 10, experience: [{ text: '初次' }] },
    { _id: 'b', _openid: 'owner', localId: 'same', date: '2026-09-20', timestamp, duration: 10, experience: [{ text: '补充' }] },
    { _id: 'c', _openid: 'owner', localId: 'distinct', date: '2026-09-20', timestamp, duration: 10 },
    { _id: 'd', _openid: 'owner', source: 'manual', date: '2026-09-18', timestamp, duration: 10 },
    { _id: 'e', _openid: 'owner', date: '2026-09-20', timestamp, duration: 10 },
  ] });
  const before = app.records;
  const preview = await app.call({ type: 'migrateBusinessDates' });
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(app.records, before);
  assert.equal(app.stats.length, 0);
  assert.deepEqual(preview.data.users[0].duplicates, [{ recordId: 'b', keepRecordId: 'a' }]);
  assert.equal(preview.data.users[0].dateChanges.length, 3);
  const applied = await app.call({ type: 'migrateBusinessDates', dryRun: false });
  assert.equal(applied.data.dryRun, false);
  assert.equal(app.records.length, 4);
  assert.equal(app.records.find(record => record._id === 'a').date, '2026-09-19');
  assert.equal(app.records.find(record => record._id === 'a').experience.length, 2);
  assert.equal(app.records.find(record => record._id === 'd').date, '2026-09-18');
  assert.equal(app.stats[0].totalCount, 4);
  assert.equal(app.stats[0].totalDuration, 40);
  assert.equal(app.stats[0].totalDays, 2);
  await app.call({ type: 'migrateBusinessDates', dryRun: false });
  assert.equal(app.records.length, 4);
  assert.equal(app.stats[0].totalCount, 4);
  app.setOpenid('owner');
  assert.equal((await app.call({ type: 'migrateBusinessDates', dryRun: false })).success, false);
});

test('first badge award racing the first record creates one statistics document with both results', async () => {
  const app = harness();
  const results = await Promise.all([
    app.record({ localId: 'first-session', duration: 10 }),
    app.call({ type: 'updateUserBadges', badges: { first: { unlockTime: '2026-09-20', name: '初次' } } })
  ]);
  assert.ok(results.every(result => result.success));
  assert.equal(app.stats.length, 1);
  assert.equal(app.stats[0].totalCount, 1);
  assert.equal(app.stats[0].totalDuration, 10);
  assert.equal(app.stats[0].badges.first.unlockTime, '2026-09-20');
  await app.call({ type: 'updateUserBadges', badges: { first: null, second: { unlockTime: '2026-09-21' } } });
  assert.equal(app.stats[0].badges.first.unlockTime, '2026-09-20');
  assert.equal(app.stats[0].badges.second.unlockTime, '2026-09-21');
});

test('statistics readings reset daily/month totals at 02:00 and expire stale current streak without a new checkin', async () => {
  const app = harness({ now: '2026-10-01T01:59:59+08:00' });
  await app.record({ localId: 'last-month', duration: 10 });
  const readStats = async () => (await app.call({ type: 'getUserStats' })).data;
  assert.equal((await readStats()).dailyTotalDuration, 10);
  assert.equal((await readStats()).monthlyTotalDuration, 10);
  app.setNow('2026-10-01T02:00:00+08:00');
  assert.equal((await readStats()).dailyTotalDuration, 0);
  assert.equal((await readStats()).monthlyTotalDuration, 0);
  assert.equal((await readStats()).currentStreak, 1);
  app.setNow('2026-10-02T02:00:00+08:00');
  assert.equal((await readStats()).currentStreak, 0);
  assert.equal((await readStats()).longestStreak, 1);
});

test('legacy statistics are read correctly before migration without mutating records or cached statistics', async () => {
  const app = harness({ now: '2027-01-01T01:59:59+08:00', records: [
    { _id: 'a', _openid: 'owner', date: '2026-12-31', timestamp: Date.parse('2026-12-31T22:00:00+08:00'), duration: 10 },
    { _id: 'b', _openid: 'owner', date: '2027-01-01', timestamp: '2027-01-01T00:30:00+08:00', duration: 20 },
    { _id: 'c', _openid: 'owner', date: '2026-12-30', dateSource: 'manual', timestamp: Date.parse('2027-01-01T01:30:00+08:00'), duration: 15 },
  ], stats: [{ _id: 'stats', _openid: 'owner', totalDays: 3, totalCount: 3, totalDuration: 45,
    lastCheckinDate: '2027-01-01', dailyTotalDuration: 20, monthlyTotalDuration: 20, currentStreak: 3, longestStreak: 3 }] });
  const before = { records: app.records, stats: app.stats };
  const stats = (await app.call({ type: 'getUserStats' })).data;
  assert.equal(stats.totalDays, 2);
  assert.equal(stats.totalCount, 3);
  assert.equal(stats.dailyTotalDuration, 30);
  assert.equal(stats.monthlyTotalDuration, 45);
  assert.equal(stats.lastCheckinDate, '2026-12-31');
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.longestStreak, 2);
  assert.deepEqual(stats.monthlyStats, { '2026-12': { days: ['2026-12-30', '2026-12-31'], count: 3, totalDuration: 45 } });
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
  assert.equal(app.transactions, 0);
  app.setNow('2027-01-01T02:00:00+08:00');
  const next = (await app.call({ type: 'getUserStats' })).data;
  assert.equal(next.dailyTotalDuration, 0);
  assert.equal(next.monthlyTotalDuration, 0);
});

test('manual dateSource survives old pending uploads and respects the business-day backfill window', async () => {
  const app = harness({ now: '2027-01-01T01:59:59+08:00' });
  const result = await app.record({ localId: 'legacy-manual', dateSource: 'manual', date: '2026-12-29', duration: 10 });
  assert.equal(result.success, true);
  assert.equal(result.data.date, '2026-12-29');
  assert.equal(app.records[0].source, 'manual');
  assert.equal((await app.record({ localId: 'tomorrow', dateSource: 'manual', date: '2027-01-01', duration: 10 })).code, 'DATE_OUT_OF_RANGE');
});

test('badge recomputation counts business days when two natural dates collapse into one before 02:00', async () => {
  const records = Array.from({ length: 7 }, (_, index) => ({
    _id: `day-${index}`, _openid: 'owner', date: `2027-01-0${index + 1}`,
    timestamp: Date.parse(`2027-01-0${index + 1}T${index === 0 ? '12' : '00'}:30:00+08:00`), duration: 1,
  }));
  const app = harness({ now: '2027-01-07T01:59:59+08:00', records,
    stats: [{ _id: 'stats', _openid: 'owner', badges: { 'continuous-7': { unlockTime: '2027-01-07' } } }] });
  const before = { records: app.records, stats: app.stats };
  const report = await app.call({ type: 'recomputeUserBadges', mode: 'report', openid: 'owner' });
  assert.equal(report.success, true);
  assert.equal(report.data.details[0].longestRun, 6);
  assert.deepEqual(report.data.details[0].removed, ['continuous-7']);
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
});
