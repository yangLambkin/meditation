const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const OPENID = 'owner';
const clone = value => JSON.parse(JSON.stringify(value));

function createHarness(records, options = {}) {
  const queries = [];
  const openid = Object.hasOwn(options, 'openid') ? options.openid : OPENID;
  const database = {
    collection(name) {
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
      assert.equal(name, 'wx-server-sdk');
      return {
        init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
        getWXContext: () => ({ OPENID: openid })
      };
    }
  });
  return {
    queries,
    async get(extra = {}) { return clone(await module.exports.main({ type: 'getAllRecords', ...extra })); }
  };
}

function record(index, extra = {}) {
  return {
    _id: `record-${String(index).padStart(4, '0')}`,
    _openid: OPENID,
    timestamp: 1750000000000 + index * 60000,
    duration: 7,
    ...extra
  };
}

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
