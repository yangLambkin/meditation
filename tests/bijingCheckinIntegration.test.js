const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

// Run both client wrappers and both deployed entry points against the same DB.
// Only the WeChat transport, persistence, and clock are replaced by test doubles.
function createHarness() {
  let now = Date.parse('2026-09-17T20:20:00+08:00');
  const openid = 'oz-integration-test';
  const calls = [];
  const collections = {
    meditation_records: [],
    meditation_locks: [],
    user_stats: [],
    users: [{ _id: 'bound-user', _openid: openid, bijingBound: true,
      bijingStudentNumber: '123456', bijingSyncedDates: {} }],
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function operation(op, value) {
    return { op, value, and(other) { return operation('and', [this, other]); } };
  }
  function matches(value, filter) {
    if (filter && filter.op === 'or') return filter.value.some(part => matches(value, part));
    if (filter && filter.op === 'and') return filter.value.every(part => matches(value, part));
    if (filter && filter.op === 'gte') return typeof value === 'number' && value >= filter.value;
    if (filter && filter.op === 'lt') return typeof value === 'number' && value < filter.value;
    if (filter && typeof filter === 'object') {
      return Object.entries(filter).every(([key, expected]) => matches(value[key], expected));
    }
    return value === filter;
  }
  function update(row, data) {
    for (const [field, value] of Object.entries(data)) {
      const parts = field.split('.');
      const key = parts.pop();
      const target = parts.reduce((parent, part) => parent[part] ||= {}, row);
      if (value && value.op === 'inc') target[key] = (target[key] || 0) + value.value;
      else if (value && value.op === 'max') target[key] = Math.max(target[key] || 0, value.value);
      else if (value && value.op === 'push') target[key] = [...(target[key] || []), clone(value.value)];
      else if (value && value.op === 'set') target[key] = clone(value.value);
      else target[key] = clone(value);
    }
  }
  const database = {
    command: Object.fromEntries(['or', 'gte', 'lt', 'inc', 'max', 'push', 'set']
      .map(op => [op, value => operation(op, value)])),
    async runTransaction(callback) { return callback({ collection(name) { return { doc: database.collection(name).doc }; } }); },
    collection(name) {
      assert.ok(Object.hasOwn(collections, name), `Unexpected collection: ${name}`);
      const rows = collections[name];
      return {
        async add({ data }) {
          const _id = data._id || `${name}-${rows.length + 1}`;
          rows.push({ ...clone(data), _id });
          return { _id };
        },
        doc(id) { return {
          async get() { return { data: clone(rows.find(row => row._id === id)) || null }; },
          async set({ data }) { rows.push({ _id: id, ...clone(data) }); return { _id: id }; },
          async update({ data }) { update(rows.find(row => row._id === id), data); return { stats: { updated: 1 } }; }
        }; },
        where(filter) {
          let offset = 0, maximum = Infinity, fields, order;
          return {
            skip(value) { offset = value; return this; },
            limit(value) { maximum = value; return this; },
            field(value) { fields = value; return this; },
            orderBy(key, direction) { order = { key, direction }; return this; },
            async get() {
              const matching = rows.filter(row => matches(row, filter));
              if (order) matching.sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key]))
                * (order.direction === 'asc' ? 1 : -1));
              const page = matching.slice(offset, offset + maximum);
              return { data: clone(fields ? page.map(row => Object.fromEntries(Object.keys(fields)
                .filter(key => fields[key] && Object.hasOwn(row, key)).map(key => [key, row[key]]))) : page) };
            },
            async update({ data }) {
              rows.filter(row => matches(row, filter)).forEach(row => update(row, data));
            },
          };
        },
      };
    },
  };
  const sdk = {
    init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
    getWXContext: () => ({ OPENID: openid }),
  };
  function load(filename, globals = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), {
      module, exports: module.exports, Date: FixedDate,
      console: { log() {}, warn() {}, error() {} },
      ...globals,
    }, { filename });
    return module.exports;
  }
  function cloudRequire(name) {
    if (name === 'crypto') return require('node:crypto');
    if (name === 'wx-server-sdk') return sdk;
    if (name === 'axios') return {
      async get() { throw new Error('Preview must not make external requests'); },
      async post() { throw new Error('Preview must not submit records'); },
    };
    throw new Error(`Unexpected cloud dependency: ${name}`);
  }
  const handlers = {
    meditationManager: load('cloudfunctions/meditationManager/index.js', { require: cloudRequire }),
    bijingSync: load('cloudfunctions/bijingSync/index.js', { require: cloudRequire }),
  };
  const api = load('miniprogram/utils/cloudApi.js', {
    wx: { cloud: { callFunction({ name, data, success, fail }) {
      calls.push({ name, data: clone(data) });
      Promise.resolve().then(() => handlers[name].main(clone(data), {}))
        .then(result => success({ result: clone(result) }), fail);
    } } },
  });
  const bijingApi = load('miniprogram/utils/bijingApi.js', {
    require(name) { assert.equal(name, './cloudApi.js'); return api; },
  });
  return {
    api, calls, collections,
    setNow(value) { now = Date.parse(value); },
    async preview(date) {
      const result = clone(await bijingApi.getBijingSyncDateDetails(date));
      assert.equal(result.success, true, result.error);
      return result.data;
    },
  };
}

test('a September 17 backdated check-in reaches September 16 sync preview with its original time and duration', async () => {
  const app = createHarness();
  const timestamp = Date.parse('2026-09-16T12:00:00+08:00');
  const experience = [{ text: '平静', uniqueId: String(timestamp) }];
  const result = clone(await app.api.recordMeditation(15, ['平静'], experience, timestamp));
  assert.equal(result.success, true);
  assert.equal(app.calls[0].data.data.timestamp, timestamp);
  assert.equal(result.data.date, '2026-09-16');
  assert.equal(result.data.timestamp, timestamp);

  const [stored] = app.collections.meditation_records;
  assert.equal(stored.timestamp, timestamp);
  assert.equal(stored.date, '2026-09-16');
  assert.equal(stored.duration, 15);
  assert.deepEqual(stored.experience, experience);
  assert.equal(stored.createdAt, '2026-09-17T12:20:00.000Z');
  assert.equal(stored._id, result.data.recordId);

  const beforePreview = clone(app.collections);
  assert.deepEqual(await app.preview('2026-09-16'), {
    date: '2026-09-16',
    records: [{ id: stored._id, timestamp, duration: 15 }],
    count: 1, totalDuration: 15, syncDuration: 15, alreadySynced: false,
  });
  // September 17 must finish before its preview is available.
  app.setNow('2026-09-18T02:00:00+08:00');
  const nextDay = await app.preview('2026-09-17');
  assert.equal(nextDay.count, 0);
  assert.equal(nextDay.totalDuration, 0);
  assert.deepEqual(app.collections, beforePreview, 'Reading previews must not mutate records or sync markers');
  assert.deepEqual(app.calls.map(call => call.name), ['meditationManager', 'bijingSync', 'bijingSync']);
});

test('front-end check-ins around 02:00 belong to exactly one sync day with the same business storage dates', async () => {
  const app = createHarness();
  const cases = [
    { time: '2026-09-16T01:59:59.999+08:00', duration: 5, storedDate: '2026-09-15', syncDate: '2026-09-15' },
    { time: '2026-09-16T02:00:00.000+08:00', duration: 10, storedDate: '2026-09-16', syncDate: '2026-09-16' },
    { time: '2026-09-17T01:59:59.999+08:00', duration: 20, storedDate: '2026-09-16', syncDate: '2026-09-16' },
    { time: '2026-09-17T02:00:00.000+08:00', duration: 40, storedDate: '2026-09-17', syncDate: '2026-09-17' },
  ];
  for (const item of cases) {
    const result = await app.api.recordMeditation(item.duration, [], [], Date.parse(item.time));
    assert.equal(result.success, true);
    item.id = result.data.recordId;
  }
  assert.deepEqual(app.collections.meditation_records.map(row => row.date), cases.map(item => item.storedDate));

  app.setNow('2026-09-18T02:00:00+08:00');
  const allPreviewIds = [];
  for (const date of ['2026-09-15', '2026-09-16', '2026-09-17']) {
    const preview = await app.preview(date);
    const expected = cases.filter(item => item.syncDate === date).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const total = expected.reduce((sum, item) => sum + item.duration, 0);
    assert.deepEqual(preview.records, expected.map(item => ({ id: item.id, timestamp: Date.parse(item.time), duration: item.duration })));
    assert.equal(preview.count, expected.length);
    assert.equal(preview.totalDuration, total);
    assert.equal(preview.syncDuration, Math.round(total));
    allPreviewIds.push(...preview.records.map(row => row.id));
  }
  assert.deepEqual(allPreviewIds.sort(), cases.map(item => item.id).sort(), 'Each saved record must appear exactly once across adjacent sync dates');
  assert.deepEqual(app.collections.users[0].bijingSyncedDates, {});
});
