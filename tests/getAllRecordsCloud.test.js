const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const OPENID = 'owner';
const clone = value => JSON.parse(JSON.stringify(value));

function createHarness(records, options = {}) {
  const queries = [];
  const lockReads = [];
  const openid = Object.hasOwn(options, 'openid') ? options.openid : OPENID;
  const database = {
    collection(name) {
      if (name === 'meditation_locks') return {
        doc(id) { return { async get() {
          lockReads.push(id);
          if (options.missingLockCollection) throw { errCode: -502005, errMsg: 'database collection not exists' };
          if (options.lockDocumentError) throw options.lockDocumentError;
          if (options.lockError && (!options.failLockOnRead || lockReads.length === options.failLockOnRead)) throw options.lockError;
          return { data: { _id: id, revision: options.revision || 0 } };
        } }; }
      };
      assert.equal(name, 'meditation_records');
      return {
        where(filter) {
          const orderings = [];
          let offset = 0;
          let limit = 20;
          return {
            orderBy(field, direction) { orderings.push([field, direction]); return this; },
            skip(value) { offset = value; return this; },
            limit(value) { limit = value; return this; },
            async get() {
              queries.push({ filter: clone(filter), orderings, offset, limit });
              if (options.onPage) options.onPage(queries.length, records);
              if (queries.length === options.failOnPage) throw new Error('cloud query unavailable');
              const rows = records.filter(row => row._openid === filter._openid).sort((a, b) => {
                for (const [field, direction] of orderings) {
                  const comparison = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
                  if (comparison) return direction === 'desc' ? -comparison : comparison;
                }
                return 0;
              });
              return { data: clone(rows.slice(offset, offset + limit)) };
            }
          };
        }
      };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return {
        init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
        getWXContext: () => ({ OPENID: openid })
      };
    }
  });
  return {
    queries, lockReads,
    async get(extra = {}) { return clone(await module.exports.main({ type: 'getAllRecords', ...extra })); }
  };
}

function record(index, extra = {}) {
  const timestamp = extra.timestamp === undefined ? 1750000000000 + index * 60000 : extra.timestamp;
  return {
    _id: `record-${String(index).padStart(4, '0')}`,
    _openid: OPENID,
    timestamp,
    date: typeof timestamp === 'number' ? new Date(timestamp + 6 * 3600000).toISOString().slice(0, 10) : '2025-06-15',
    duration: 7,
    ...extra
  };
}

test('all, daily and monthly reads normalize legacy timestamps at the year boundary and preserve manual dates', async () => {
  const app = createHarness([
    record(1, { date: '2027-01-01', timestamp: Date.parse('2027-01-01T01:59:59.999+08:00') }),
    record(2, { date: '2026-12-31', timestamp: Date.parse('2027-01-01T02:00:00+08:00') }),
    record(3, { date: '2026-12-29', dateSource: 'manual', timestamp: '2027-01-01T01:00:00+08:00' }),
    record(4, { date: '2027-01-01', timestamp: String(Date.parse('2027-01-01T01:30:00+08:00')) }),
    record(5, { date: '2026-12-30', timestamp: '2027-01-01T01:00:00' }),
  ]);
  const all = (await app.get()).data;
  assert.deepEqual(Object.fromEntries(all.map(row => [row._id, row.date])), {
    'record-0001': '2026-12-31', 'record-0002': '2027-01-01', 'record-0003': '2026-12-29',
    'record-0004': '2026-12-31', 'record-0005': '2026-12-30',
  });
  const december31 = await app.get({ type: 'getUserRecords', date: '2026-12-31' });
  assert.deepEqual(december31.data.map(row => row._id).sort(), ['record-0001', 'record-0004']);
  const december = await app.get({ type: 'getMonthlyStats', month: '2026-12' });
  assert.equal(december.data.totalCount, 4);
  assert.equal(december.data.totalDuration, 28);
  const january = await app.get({ type: 'getMonthlyStats', month: '2027-01' });
  assert.equal(january.data.totalCount, 1);
});

test('getAllRecords reads every page and retains the existing descending timestamp API', async () => {
  const records = Array.from({ length: 235 }, (_, index) => record(index));
  const app = createHarness(records);
  const result = await app.get();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, [...records].reverse());
  assert.deepEqual(app.queries.map(query => query.offset), [0, 100, 200]);
  assert.ok(app.queries.every(query => query.limit === 100));
});

test('identical timestamps across full pages have a stable ID order with no omitted or repeated records', async () => {
  const records = Array.from({ length: 200 }, (_, index) => record(index, { timestamp: 1750000000000 }));
  const app = createHarness([...records].reverse());
  const result = await app.get();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, records);
  assert.deepEqual(app.queries.map(query => query.offset), [0, 100, 200]);
  for (const query of app.queries) {
    assert.deepEqual(query.orderings, [['timestamp', 'desc'], ['_id', 'asc']]);
  }
});

test('each page is scoped to authenticated OPENID and ignores caller-supplied identities', async () => {
  const own = Array.from({ length: 105 }, (_, index) => record(index));
  const foreign = Array.from({ length: 110 }, (_, index) => record(index + 200, { _openid: 'other' }));
  const app = createHarness([...foreign, ...own]);
  const result = await app.get({ openid: 'other', _openid: 'other', data: { _openid: 'other' } });
  assert.deepEqual(result.data, [...own].reverse());
  assert.equal(app.queries.length, 2);
  for (const query of app.queries) assert.deepEqual(query.filter, { _openid: OPENID });

  const unauthenticated = createHarness(own, { openid: '' });
  assert.equal((await unauthenticated.get()).code, 'AUTH_REQUIRED');
  assert.equal(unauthenticated.queries.length, 0);
  assert.equal(unauthenticated.lockReads.length, 0);
});

test('failure on a later page returns an error without a partial success payload', async () => {
  const app = createHarness(Array.from({ length: 210 }, (_, index) => record(index)), { failOnPage: 2 });
  const result = await app.get();
  assert.deepEqual(result, { success: false, error: 'cloud query unavailable' });
  assert.equal(app.queries.length, 2);
});

test('a user without cloud records receives a successful empty list', async () => {
  const app = createHarness([record(1, { _openid: 'other' })]);
  assert.deepEqual(await app.get(), { success: true, data: [] });
  assert.equal(app.queries.length, 1);
});

test('a concurrent deletion cannot turn offset pagination into an incomplete authoritative snapshot', async () => {
  const records = Array.from({ length: 201 }, (_, index) => record(index));
  const options = { revision: 5, onPage(page, rows) {
    if (page !== 2) return;
    rows.splice(rows.findIndex(row => row._id === 'record-0200'), 1);
    options.revision++;
  } };
  const app = createHarness(records, options);
  const result = await app.get();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, [...records].reverse());
  assert.ok(result.data.some(row => row._id === 'record-0100'), 'Offset shift must not omit a still-existing record');
  assert.ok(!result.data.some(row => row._id === 'record-0200'), 'The abandoned first page must not preserve a deleted record');
  assert.deepEqual(app.queries.map(query => query.offset), [0, 100, 200, 0, 100, 200]);
  assert.equal(app.lockReads.length, 4);
});

test('a concurrent insertion causes a complete reread with the new record and no duplicate pages', async () => {
  const records = Array.from({ length: 150 }, (_, index) => record(index));
  const options = { onPage(page, rows) {
    if (page !== 2) return;
    rows.push(record(200));
    options.revision = 1;
  } };
  const app = createHarness(records, options);
  const result = await app.get();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, [...records].reverse());
  assert.equal(new Set(result.data.map(row => row._id)).size, 151);
  assert.deepEqual(app.queries.map(query => query.offset), [0, 100, 0, 100]);
});

test('continually changing revisions return RETRY_REQUIRED without any partial success data', async () => {
  const options = { revision: 0, onPage() { options.revision++; } };
  const app = createHarness([record(1)], options);
  const result = await app.get();
  assert.equal(result.success, false);
  assert.equal(result.code, 'RETRY_REQUIRED');
  assert.equal(result.data, undefined);
  assert.equal(app.queries.length, 3);
  assert.equal(app.lockReads.length, 6);
});

test('legacy environments with no lock collection or user lock remain readable without initialization', async () => {
  const records = [record(1)];
  for (const options of [
    { missingLockCollection: true },
    { lockDocumentError: { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' } }
  ]) {
    // The database harness deliberately has no createCollection or write APIs.
    const app = createHarness(records, options);
    assert.deepEqual(await app.get(), { success: true, data: records });
    assert.deepEqual(records, [record(1)]);
    assert.equal(app.lockReads.length, 2);
    assert.equal(app.queries.length, 1);
  }
});

test('lock permission and late revision-read failures cannot silently accept an unverified snapshot', async () => {
  for (const failLockOnRead of [1, 2]) {
    const app = createHarness([record(1)], { failLockOnRead,
      lockError: { errCode: -502003, errMsg: 'document.get:fail database permission denied' } });
    const result = await app.get();
    assert.equal(result.success, false);
    assert.equal(result.code, -502003);
    assert.match(result.error, /permission denied/);
    assert.equal(result.data, undefined);
    assert.equal(app.queries.length, failLockOnRead - 1);
  }
});
