const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/bijingSync/index.js'), 'utf8');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const recordDate = '2026-09-16';
const now = Date.parse('2026-09-17T02:05:00+08:00');

function user(index, extra = {}) {
  const suffix = String(index).padStart(3, '0');
  return { _id: `doc-${suffix}`, _openid: `owner-${suffix}`, bijingBound: true,
    bijingStudentNumber: `BJ${suffix}`, bijingSyncedDates: {}, ...extra };
}

function record(index, duration = 10, extra = {}) {
  const suffix = String(index).padStart(3, '0');
  return { _id: `record-${suffix}`, _openid: `owner-${suffix}`, date: recordDate, duration, ...extra };
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split('.');
    let destination = target;
    for (const part of parts.slice(0, -1)) {
      if (!destination[part] || typeof destination[part] !== 'object') destination[part] = {};
      destination = destination[part];
    }
    destination[parts[parts.length - 1]] = clone(value);
  }
}

function harness(options = {}) {
  const state = {
    users: clone(options.users || [user(1)]),
    meditation_records: clone(options.records || [record(1)]),
  };
  const calls = { reads: [], updates: [], posts: [], waits: [], logs: [], activeHttp: 0, maxHttp: 0 };
  const attempts = new Map();
  const wxContext = options.wxContext || { SOURCE: 'wx_trigger' };
  const environment = {
    BIJING_API_BASE: 'https://example.test', BIJING_ACCESS_TOKEN: 'test-token',
    BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger',
    MAINTENANCE_ADMIN_OPENIDS: '', ...options.env,
  };
  const database = {
    collection(name) {
      assert.ok(Object.hasOwn(state, name), `Unexpected collection: ${name}`);
      function query(filter = {}) {
        let skip = 0;
        let limit = Infinity;
        let order;
        let fields;
        return {
          where(value) { return query(value); },
          skip(value) { skip = value; return this; },
          limit(value) { limit = value; return this; },
          orderBy(key, direction) { order = { key, direction }; return this; },
          field(value) { fields = value; return this; },
          async get() {
            const request = { name, filter: clone(filter), skip, limit, order, fields };
            calls.reads.push(request);
            if (options.onRead) await options.onRead(request, state, calls);
            const selected = state[name].filter(row => matches(row, filter));
            if (order) selected.sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.direction === 'asc' ? 1 : -1));
            const page = selected.slice(skip, skip + limit);
            return { data: clone(fields ? page.map(row => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && Object.hasOwn(row, key)).map(key => [key, row[key]]))) : page) };
          },
          async update({ data }) {
            const request = { name, filter: clone(filter), data: clone(data) };
            calls.updates.push(request);
            if (options.onUpdate) {
              const override = await options.onUpdate(request, state, calls);
              if (override !== undefined) {
                request.updated = override && override.stats && override.stats.updated;
                return clone(override);
              }
            }
            const selected = state[name].filter(row => matches(row, filter));
            selected.forEach(row => applyPatch(row, data));
            request.updated = selected.length;
            return { stats: { updated: selected.length } };
          },
        };
      }
      return { ...query(), doc(id) {
        return {
          async get() { return query({ _id: id }).get(); },
          async update({ data }) { return query({ _id: id }).update({ data }); },
        };
      } };
    },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Date: FixedDate, process: { env: environment },
    console: { log: (...values) => calls.logs.push(values), warn: (...values) => calls.logs.push(values), error: (...values) => calls.logs.push(values) },
    setTimeout(callback, duration) { calls.waits.push(duration); callback(); return 0; },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/bijingSync/maintenanceAuth');
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database, getWXContext: () => wxContext };
      if (name === 'axios') return {
        async post(url, body, config) {
          const attempt = (attempts.get(body.studentNumber) || 0) + 1;
          attempts.set(body.studentNumber, attempt);
          calls.posts.push(clone({ url, body, config, attempt }));
          calls.activeHttp++;
          calls.maxHttp = Math.max(calls.maxHttp, calls.activeHttp);
          try {
            // Keep the request pending across microtasks so accidental parallelism is observable.
            await Promise.resolve();
            const response = options.post ? await options.post(body, attempt, state, calls) : { success: true };
            await Promise.resolve();
            return { data: response };
          } finally {
            calls.activeHttp--;
          }
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: 'bijingSync/index.js' });
  return { state, calls, async run(event = { type: 'cronSyncAll' }) { return clone(await module.exports.main(event, {})); } };
}

// 全员重试已改为持久化分批任务，详见 bijingBatchJobs.test.js。

test('concurrent successful dates merge their flags atomically and keep older successful dates', async () => {
  const app = harness({ wxContext: { OPENID: 'owner-001', SOURCE: 'wx_client' },
    users: [user(1, { bijingSyncedDates: { '2026-09-12': true } })],
    records: [record(1), record(1, 15, { _id: 'previous-day', date: '2026-09-15' })] });
  const results = await Promise.all([app.run({ type: 'syncSelectedDate', recordDate }), app.run({ type: 'syncSelectedDate', recordDate: '2026-09-15' })]);
  assert.ok(results.every(result => result.success));
  assert.deepEqual(app.state.users[0].bijingSyncedDates, { '2026-09-12': true, '2026-09-15': true, [recordDate]: true });
  assert.deepEqual(app.calls.updates.map(call => Object.keys(call.data)), [[`bijingSyncedDates.${recordDate}`], ['bijingSyncedDates.2026-09-15']]);
});

test('ordinary callers and disabled or spoofed timer sources still fail before all business access', async t => {
  for (const options of [
    { wxContext: { OPENID: 'ordinary-user', SOURCE: 'wx_trigger' } },
    { wxContext: { SOURCE: 'wx_client' } },
    { wxContext: {} },
    { env: { BIJING_TIMER_ENABLED: 'false' } },
    { wxContext: { SOURCE: 'wx_client' }, env: { BIJING_TIMER_SOURCE: 'wx_client' } },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const app = harness(options);
      const result = await app.run({ type: 'cronSyncAll', source: 'wx_trigger', OPENID: 'operator' });
      assert.equal(result.success, false);
      assert.equal(result.code, 'FORBIDDEN');
      assert.deepEqual([app.calls.reads, app.calls.updates, app.calls.posts, app.calls.waits], [[], [], [], []]);
    });
  }
});

test('manual sync preserves its one-request behavior while a marker failure is surfaced', async () => {
  const app = harness({ wxContext: { OPENID: 'owner-001', SOURCE: 'wx_client' }, onUpdate() { throw new Error('manual marker unavailable'); } });
  const result = await app.run({ type: 'syncSelectedDate', recordDate });
  assert.equal(result.success, false);
  assert.match(result.error, /manual marker unavailable/);
  assert.equal(app.calls.posts.length, 1);
  assert.deepEqual(app.calls.waits, []);
});
