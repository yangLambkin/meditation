const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('safe cleanup uses inclusive 02:00 and exclusive next-day 02:00 for legacy records and every page', async () => {
  const epoch = value => Date.parse(value);
  const now = epoch('2026-02-01T01:59:59.999+08:00');
  const collections = {
    meditation_records: [
      { _id: 'before-start', date: '2026-01-01', timestamp: epoch('2026-01-01T01:59:59.999+08:00') },
      { _id: 'start', date: '2026-01-01', timestamp: epoch('2026-01-01T02:00:00+08:00') },
      { _id: 'before-end', date: '2026-02-01', timestamp: String(now) },
      { _id: 'end', date: '2026-01-31', timestamp: epoch('2026-02-01T02:00:00+08:00') },
      { _id: 'manual-prior', date: '2025-12-31', source: 'manual', timestamp: epoch('2026-01-31T12:00:00+08:00') },
      { _id: 'manual-valid', date: '2026-01-31', dateSource: 'manual', timestamp: epoch('2026-02-01T02:00:00+08:00') },
      ...Array.from({ length: 105 }, (_, index) => ({ _id: `page-${index}`, date: '2026-01-15' })),
    ],
    experience_records: [
      { _id: 'exp-before-start', timestamp: epoch('2026-01-01T01:59:59.999+08:00') },
      { _id: 'exp-start', timestamp: epoch('2026-01-01T02:00:00+08:00') },
      { _id: 'exp-before-end', timestamp: now },
      { _id: 'exp-end', timestamp: epoch('2026-02-01T02:00:00+08:00') },
    ],
  };
  const reads = [];
  const op = (name, value) => ({ name, value, and(other) { return op('and', [this, other]); } });
  function matches(value, condition) {
    if (condition.name === 'and') return condition.value.every(part => matches(value, part));
    if (condition.name === 'gte') return value >= condition.value;
    if (condition.name === 'lt') return value < condition.value;
    return false;
  }
  const database = {
    command: { gte: value => op('gte', value), lt: value => op('lt', value) },
    collection(name) {
      return {
        where(filter) {
          let offset = 0, limit = 20;
          return {
            orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
            async get() {
              reads.push({ name, offset });
              const rows = collections[name].filter(row => Object.entries(filter).every(([key, expected]) => matches(row[key], expected)))
                .sort((a, b) => a._id.localeCompare(b._id));
              return { data: rows.slice(offset, offset + limit) };
            },
          };
        },
        doc(id) { return { async remove() { collections[name] = collections[name].filter(row => row._id !== id); } }; },
      };
    },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const entry = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/cleanupTestData/index.js'), 'utf8'), {
    module: entry, exports: entry.exports, Date: Clock, console: { log() {}, error() {} },
    require(name) {
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => database };
    },
  });
  const result = await entry.exports.main({ mode: 'safe' });
  assert.equal(result.success, true);
  assert.equal(result.testPeriod.endDate, '2026-01-31');
  assert.equal(result.totalDeleted, 110);
  assert.deepEqual(collections.meditation_records.map(row => row._id), ['before-start', 'end', 'manual-prior']);
  assert.deepEqual(collections.experience_records.map(row => row._id), ['exp-before-start', 'exp-end']);
  assert.deepEqual(reads.filter(row => row.name === 'meditation_records').map(row => row.offset), [0, 100]);
});
