const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const OPENID = 'owner';
const NOW = Date.parse('2026-09-17T04:00:00Z');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function record(id, date, duration = 10, extra = {}) {
  return { _id: id, _openid: OPENID, date, duration, timestamp: Date.parse(`${date}T04:00:00Z`), ...extra };
}

function createHarness(records, stats = [], options = {}) {
  let stored = clone({ meditation_records: records, user_stats: stats, meditation_locks: [] });
  const queries = [];
  const writes = [];
  let transactionCount = 0;
  const database = {
    command: { set: value => ({ replace: clone(value) }) },
    collection(name) {
      return {
        doc(id) { return { async get() { return { data: clone(stored[name].find(row => row._id === id)) || null }; } }; },
        where(filter) {
          let offset = 0, limit = 20;
          return {
            orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
            async get() {
              queries.push({ name, offset, limit });
              if (options.fail === 'read') throw new Error('query unavailable');
              const rows = stored[name].filter(row => row._openid === filter._openid).sort((a, b) => a._id.localeCompare(b._id));
              return { data: clone(rows.slice(offset, offset + limit)) };
            }
          };
        }
      };
    },
    async runTransaction(callback) {
      transactionCount++;
      const pending = clone(stored);
      const transaction = {
        collection(name) {
          assert.ok(Object.hasOwn(pending, name));
          return {
            where() { throw new Error('Transactions must use doc APIs'); },
            doc(id) {
              return {
                async get() { return { data: clone(pending[name].find(row => row._id === id)) || null }; },
                async set({ data }) {
                  writes.push({ name, id, action: 'set' });
                  if (options.fail === 'add') throw new Error('stats insert unavailable');
                  const index = pending[name].findIndex(row => row._id === id);
                  if (index < 0) pending[name].push({ _id: id, ...clone(data) });
                  else pending[name][index] = { _id: id, ...clone(data) };
                  return { _id: id };
                },
                async remove() {
                  writes.push({ name, id, action: 'remove' });
                  if (options.fail === 'remove') throw new Error('delete unavailable');
                  if (options.fail === 'remove-zero') return { stats: { removed: 0 } };
                  const index = pending[name].findIndex(row => row._id === id);
                  if (index < 0) return { stats: { removed: 0 } };
                  pending[name].splice(index, 1);
                  return { stats: { removed: 1 } };
                },
                async update({ data }) {
                  writes.push({ name, id, action: 'update' });
                  if (options.fail === 'update') throw new Error('stats unavailable');
                  if (options.fail === 'update-zero') return { stats: { updated: 0 } };
                  const target = pending[name].find(row => row._id === id);
                  if (!target) return { stats: { updated: 0 } };
                  for (const [key, value] of Object.entries(data)) {
                    if (value && Object.hasOwn(value, 'replace')) target[key] = clone(value.replace);
                    // Model database object updates merging nested keys unless command.set is used.
                    else if (key === 'monthlyStats') target[key] = { ...target[key], ...clone(value) };
                    else target[key] = clone(value);
                  }
                  return { stats: { updated: 1 } };
                }
              };
            },
            async add() { throw new Error('Transactions must use doc APIs'); }
          };
        }
      };
      const result = await callback(transaction);
      if (options.fail === 'commit') throw new Error('commit failed');
      stored = pending;
      return result;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, Date: FixedDate, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
        getWXContext: () => ({ OPENID: options.openid === undefined ? OPENID : options.openid }) };
    }
  });
  return {
    queries, writes,
    get records() { return clone(stored.meditation_records); },
    get stats() { return clone(stored.user_stats); },
    get transactionCount() { return transactionCount; },
    async remove(data, extra = {}) {
      return clone(await module.exports.main({ type: 'deleteMeditationRecord', data, ...extra }));
    },
    async record(data) {
      return clone(await module.exports.main({ type: 'recordMeditation', data }));
    }
  };
}

test('deletion trusts authenticated OPENID only; missing auth, foreign IDs and repeats cannot change records', async () => {
  const own = record('own', '2026-09-17');
  const foreign = record('foreign', '2026-09-17', 90, { _openid: 'other' });
  const app = createHarness([own, foreign]);
  const denied = await app.remove({ recordId: 'foreign', _openid: 'other' }, { openid: 'other' });
  assert.equal(denied.code, 'RECORD_NOT_FOUND');
  assert.deepEqual(app.records, [own, foreign]);
  assert.equal(app.writes.length, 0);
  assert.equal((await app.remove({ recordId: 'own' })).success, true);
  assert.equal((await app.remove({ recordId: 'own' })).code, 'RECORD_NOT_FOUND');
  assert.deepEqual(app.records, [foreign]);
  const unauthenticated = createHarness([own], [], { openid: '' });
  assert.equal((await unauthenticated.remove({ recordId: 'own' })).code, 'AUTH_REQUIRED');
  assert.equal(unauthenticated.transactionCount, 0);
});

test('legacy ISO and numeric timestamps match the exact date; numeric strings also remain compatible', async () => {
  for (const storedISO of [true, false]) {
    const target = record('target', '2026-09-17');
    const timestamp = target.timestamp;
    if (storedISO) target.timestamp = new Date(timestamp).toISOString();
    const otherDate = record('other-day', '2026-09-16', 15, { timestamp: target.timestamp, source: 'manual' });
    const app = createHarness([target, otherDate]);
    const result = await app.remove({ date: target.date, timestamp: storedISO ? String(timestamp) : new Date(timestamp).toISOString() });
    assert.equal(result.success, true);
    assert.equal(result.data.recordId, 'target');
    assert.equal(result.data.timestamp, target.timestamp);
    assert.deepEqual(app.records, [otherDate]);
  }
});

test('ambiguous timestamp fallback refuses deletion, while recordId takes precedence and removes exactly one', async () => {
  const first = record('first', '2026-09-17');
  const second = record('second', '2026-09-17', 20);
  const app = createHarness([first, second]);
  assert.equal((await app.remove({ date: first.date, timestamp: first.timestamp })).code, 'AMBIGUOUS_RECORD');
  assert.equal(app.writes.length, 0);
  assert.equal((await app.remove({ recordId: 'second', date: 'bad-date', timestamp: 'bad-time' })).success, true);
  assert.deepEqual(app.records, [first]);
  assert.equal(app.stats[0].totalDuration, 10);
});

test('a failed local backup cannot delete another cloud record at the same timestamp', async () => {
  const cloudRecord = record('existing', '2026-09-17', 20, { localId: 'uploaded-local' });
  const app = createHarness([cloudRecord]);
  const result = await app.remove({ localId: 'failed-backup-local', timestamp: cloudRecord.timestamp, date: cloudRecord.date });
  assert.equal(result.code, 'RECORD_NOT_FOUND');
  assert.deepEqual(app.records, [cloudRecord]);
  assert.equal(app.writes.length, 0);
});

test('localId selects one exact record even with duplicate timestamps; cloud recordId has higher priority', async () => {
  const first = record('first', '2026-09-17', 10, { localId: 'local-first' });
  const second = record('second', '2026-09-17', 20, { localId: 'local-second' });
  const app = createHarness([first, second]);
  assert.equal((await app.remove({ localId: 'local-second' })).data.recordId, 'second');
  assert.deepEqual(app.records, [first]);
  assert.equal((await app.remove({ recordId: 'first', localId: 'missing' })).success, true);

  const duplicate = createHarness([first, { ...second, localId: 'local-first' }]);
  assert.equal((await duplicate.remove({ localId: 'local-first' })).code, 'AMBIGUOUS_RECORD');
  assert.equal(duplicate.writes.length, 0);
  const foreign = createHarness([{ ...first, _openid: 'someone-else' }]);
  assert.equal((await foreign.remove({ localId: 'local-first' })).code, 'RECORD_NOT_FOUND');
});

test('cloud backup saves a valid localId for deletion while legacy records continue to omit it', async () => {
  for (const localId of ['local-unique-record', undefined]) {
    const app = createHarness([]);
    const result = await app.record({ duration: 20, timestamp: NOW, localId });
    assert.equal(result.success, true);
    assert.equal(app.records[0].localId, localId);
    assert.equal(app.stats[0].totalDuration, 20);
    assert.equal((await app.remove(localId ? { localId } : { recordId: result.data.recordId })).success, true);
  }
  for (const localId of [null, '', '  ', 1, {}, []]) {
    const app = createHarness([]);
    const result = await app.record({ duration: 20, timestamp: NOW, localId });
    assert.equal(result.code, 'INVALID_RECORD');
    assert.equal(app.writes.length, 0);
  }
});

test('invalid deletion arguments are rejected before transaction or writes', async () => {
  const app = createHarness([record('target', '2026-09-17')]);
  for (const data of [null, [], 'target', {}, { recordId: 123 }, { recordId: '   ' },
    { timestamp: 'invalid', date: '2026-09-17' }, { timestamp: NOW }, { timestamp: NOW, date: 'invalid' },
    ...[null, '', ' ', 1, {}, []].map(localId => ({ localId, timestamp: NOW, date: '2026-09-17' }))]) {
    const result = await app.remove(data);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_RECORD');
  }
  assert.equal(app.transactionCount, 0);
});

test('deleting the final record clears all derived stats while retaining earned badges and unrelated fields', async () => {
  const stats = { _id: 'stats', _openid: OPENID, totalCount: 1, totalDuration: 50,
    monthlyStats: { '2026-09': { count: 1, totalDuration: 50, days: ['2026-09-17'] } },
    badges: { 'level-1': { unlockedAt: '2026-09-17' } }, nickName: '保留', createdAt: 'created-before' };
  const app = createHarness([record('target', '2026-09-17', 50)], [stats]);
  const result = await app.remove({ recordId: 'target' });
  assert.equal(result.success, true);
  assert.equal(app.records.length, 0);
  for (const key of ['totalCount', 'totalDays', 'totalDuration', 'dailyTotalDuration', 'monthlyTotalDuration',
    'lastCheckinDuration', 'currentStreak', 'longestStreak', 'longestCheckInDays']) {
    assert.equal(result.data.stats[key], 0, key);
    assert.equal(app.stats[0][key], 0, key);
  }
  assert.equal(app.stats[0].lastCheckinDate, '');
  assert.equal(app.stats[0].lastCheckin, '');
  assert.deepEqual(app.stats[0].monthlyStats, {});
  assert.deepEqual(app.stats[0].badges, stats.badges);
  assert.equal(app.stats[0].nickName, stats.nickName);
  assert.equal(app.stats[0].createdAt, stats.createdAt);
});

test('removing the newest month recomputes latest day/month, latest duration, and both streaks', async () => {
  const rows = [record('a', '2026-08-28', 10), record('b', '2026-08-29', 20),
    record('c', '2026-08-30', 30), record('d', '2026-08-31', 40), record('newest', '2026-09-01', 50),
    record('same-day', '2026-08-31', 5, { timestamp: Date.parse('2026-08-31T05:00:00Z') })];
  const app = createHarness(rows, [{ _id: 'stats', _openid: OPENID, monthlyStats: { '2026-09': { count: 1 } } }]);
  const result = await app.remove({ recordId: 'newest' });
  const stats = result.data.stats;
  assert.equal(stats.totalCount, 5);
  assert.equal(stats.totalDays, 4);
  assert.equal(stats.totalDuration, 105);
  assert.equal(stats.dailyTotalDuration, 45);
  assert.equal(stats.monthlyTotalDuration, 105);
  assert.equal(stats.lastCheckinDate, '2026-08-31');
  assert.equal(stats.lastCheckinDuration, 5);
  assert.equal(stats.currentStreak, 4);
  assert.equal(stats.longestStreak, 4);
  assert.equal(stats.longestCheckInDays, 4);
  assert.deepEqual(app.stats[0].monthlyStats, { '2026-08': { days: ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'], count: 5, totalDuration: 105 } });
  const next = await app.remove({ recordId: 'c' });
  assert.equal(next.data.stats.currentStreak, 1);
  assert.equal(next.data.stats.longestStreak, 2);
  assert.equal(next.data.stats.longestCheckInDays, 2);
  assert.equal(next.data.stats.totalDays, 3);
  assert.equal(next.data.stats.dailyTotalDuration, 45);
});

test('same-day deletion preserves the day and rebuilds sums from every page', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => record(`record-${String(index).padStart(3, '0')}`, '2026-09-17', 2,
    { timestamp: NOW - index * 60000 }));
  const app = createHarness(rows);
  const result = await app.remove({ recordId: 'record-104' });
  assert.equal(result.success, true);
  assert.equal(result.data.stats.totalCount, 204);
  assert.equal(result.data.stats.totalDays, 1);
  assert.equal(result.data.stats.totalDuration, 408);
  assert.equal(result.data.stats.dailyTotalDuration, 408);
  assert.equal(result.data.stats.monthlyStats['2026-09'].count, 204);
  assert.deepEqual(app.queries.filter(query => query.name === 'meditation_records').map(query => query.offset), [0, 100, 200]);
});

test('read, delete, stats update, and commit failures preserve the original record and all stats', async () => {
  const rows = [record('target', '2026-09-17')];
  const stats = [{ _id: 'stats', _openid: OPENID, totalCount: 1, totalDuration: 10 }];
  for (const fail of ['read', 'remove', 'remove-zero', 'update', 'update-zero', 'commit']) {
    const app = createHarness(rows, stats, { fail });
    assert.equal((await app.remove({ recordId: 'target' })).success, false, fail);
    assert.deepEqual(app.records, rows, fail);
    assert.deepEqual(app.stats, stats, fail);
  }
  const missingStats = createHarness(rows, [], { fail: 'add' });
  assert.equal((await missingStats.remove({ recordId: 'target' })).success, false);
  assert.deepEqual(missingStats.records, rows);
  assert.deepEqual(missingStats.stats, []);
});
