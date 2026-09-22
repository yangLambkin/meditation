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

function summary(extra = {}) {
  return { date: recordDate, total: 1, success: 1, failed: 0, skipped: 0, retries: 0, failedUsers: [], ...extra };
}

test('a successful first attempt sends once and reports users rather than attempts', async () => {
  const app = harness();
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, summary());
  assert.equal(app.calls.posts.length, 1);
  assert.deepEqual(app.calls.waits, []);
  assert.equal(app.calls.maxHttp, 1);
  assert.deepEqual(app.calls.posts[0].body, { studentNumber: 'BJ001', recordDate, durationMinutes: 10 });
});

test('transient failures recover on the second or fourth attempt and immediately stop retrying', async t => {
  for (const succeedsAt of [2, 4]) {
    await t.test(`success on attempt ${succeedsAt}`, async () => {
      const app = harness({ post(body, attempt) {
        if (attempt === succeedsAt) return { success: true };
        if (attempt % 2 === 1) throw new Error(`network timeout ${attempt}`);
        return { success: false, message: `upstream rejected ${attempt}` };
      } });
      const result = await app.run();
      assert.equal(result.success, true);
      assert.deepEqual(result.data, summary({ retries: succeedsAt - 1 }));
      assert.equal(app.calls.posts.length, succeedsAt);
      assert.deepEqual(app.calls.waits, [500, 1000, 2000].slice(0, succeedsAt - 1));
      assert.ok(app.calls.posts.every(call => JSON.stringify(call.body) === JSON.stringify(app.calls.posts[0].body)), 'Retries must replace the same student/date total, never accumulate it');
      assert.equal(app.calls.updates.length, 1);
    });
  }
});

test('four failed attempts retain the final error and continue to the next user serially', async () => {
  const app = harness({ users: [user(1), user(2), user(3)], records: [record(1), record(2)], post(body, attempt) {
    if (body.studentNumber === 'BJ001') return { success: false, message: `temporary failure ${attempt}` };
    return { success: true };
  } });
  const result = await app.run();
  assert.equal(result.success, false);
  assert.equal(result.code, 'PARTIAL_SYNC_FAILED');
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(result.data, summary({ total: 3, success: 1, failed: 1, skipped: 1, retries: 3,
    failedUsers: [{ openid: 'owner-001', date: recordDate, attempts: 4, error: 'temporary failure 4' }] }));
  assert.deepEqual(app.calls.posts.map(call => call.body.studentNumber), ['BJ001', 'BJ001', 'BJ001', 'BJ001', 'BJ002']);
  assert.deepEqual(app.calls.waits, [500, 1000, 2000]);
  assert.equal(app.calls.maxHttp, 1);
  assert.deepEqual(app.state.users[0].bijingSyncedDates, {});
  assert.deepEqual(app.state.users[1].bijingSyncedDates, { [recordDate]: true });
});

test('user and record lookup failures are retried even when they throw before the HTTP call', async t => {
  for (const failingCollection of ['users', 'meditation_records']) {
    await t.test(failingCollection, async () => {
      let failures = 0;
      const app = harness({ onRead(request) {
        if (request.name === failingCollection && request.filter._openid === 'owner-001' && failures < 3) {
          failures++;
          throw new Error('database temporarily unavailable');
        }
      } });
      const result = await app.run();
      assert.equal(result.success, true);
      assert.deepEqual(result.data, summary({ retries: 3 }));
      assert.equal(failures, 3);
      assert.equal(app.calls.posts.length, 1);
      assert.deepEqual(app.calls.waits, [500, 1000, 2000]);
    });
  }
});

test('an exhausted database error is recorded once and does not abort remaining users', async () => {
  const app = harness({ users: [user(1), user(2)], records: [record(1), record(2)], onRead(request) {
    if (request.name === 'meditation_records' && request.filter._openid === 'owner-001') throw new Error('record reads failed');
  } });
  const result = await app.run();
  assert.equal(result.success, false);
  assert.deepEqual(result.data, summary({ total: 2, success: 1, failed: 1, retries: 3,
    failedUsers: [{ openid: 'owner-001', date: recordDate, attempts: 4, error: 'record reads failed' }] }));
  assert.deepEqual(app.calls.posts.map(call => call.body.studentNumber), ['BJ002']);
});

test('a failed success-marker write retries the same idempotent HTTP payload instead of reporting false success', async () => {
  let failures = 0;
  const app = harness({ users: [user(1, { bijingSyncedDates: { '2026-09-14': true } })], onUpdate() {
    if (failures++ === 0) throw new Error('sync marker unavailable');
  } });
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, summary({ retries: 1 }));
  assert.equal(app.calls.posts.length, 2);
  assert.deepEqual(app.calls.posts[0].body, app.calls.posts[1].body);
  assert.deepEqual(app.calls.waits, [500]);
  assert.deepEqual(app.state.users[0].bijingSyncedDates, { '2026-09-14': true, [recordDate]: true });
  assert.deepEqual(app.calls.updates[1].data, { [`bijingSyncedDates.${recordDate}`]: true });
});

test('success-marker failures on all four attempts remain visible as a failed user', async () => {
  const app = harness({ onUpdate() { throw new Error('cannot persist success marker'); } });
  const result = await app.run();
  assert.equal(result.success, false);
  assert.equal(result.code, 'PARTIAL_SYNC_FAILED');
  assert.deepEqual(result.data, summary({ success: 0, failed: 1, retries: 3,
    failedUsers: [{ openid: 'owner-001', date: recordDate, attempts: 4, error: 'cannot persist success marker' }] }));
  assert.equal(app.calls.posts.length, 4);
  assert.deepEqual(app.state.users[0].bijingSyncedDates, {});
});

test('a binding change cannot write an old student response into the new binding status', async () => {
  const app = harness({ post(body, attempt, state) {
    if (body.studentNumber === 'BJ001') {
      state.users[0].bijingStudentNumber = 'BJNEW';
      state.users[0].bijingSyncedDates = {};
    }
    return { success: true };
  } });
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, summary({ retries: 1 }));
  assert.deepEqual(app.calls.posts.map(call => call.body.studentNumber), ['BJ001', 'BJNEW']);
  assert.equal(app.calls.updates[0].updated, 0);
  assert.equal(app.calls.updates[0].filter.bijingStudentNumber, 'BJ001');
  assert.equal(app.calls.updates[1].updated, 1);
  assert.equal(app.calls.updates[1].filter.bijingStudentNumber, 'BJNEW');
  assert.ok(app.calls.updates.every(call => call.filter._id === 'doc-001' && call.filter.bijingBound === true));
  assert.deepEqual(app.state.users[0].bijingSyncedDates, { [recordDate]: true });
});

test('zero-duration records and a binding removed after the user scan are skipped without retries', async t => {
  for (const scenario of ['empty', 'zero', 'unbound']) {
    await t.test(scenario, async () => {
      const app = harness({ records: scenario === 'empty' ? [] : [record(1, scenario === 'zero' ? 0 : 10)], onRead(request, state) {
        if (scenario === 'unbound' && request.name === 'users' && request.filter._openid) state.users[0].bijingBound = false;
      } });
      const result = await app.run();
      assert.equal(result.success, true);
      assert.deepEqual(result.data, summary({ success: 0, skipped: 1 }));
      assert.equal(app.calls.posts.length, 0);
      assert.equal(app.calls.updates.length, 0);
      assert.deepEqual(app.calls.waits, []);
    });
  }
});

test('more than one hundred users preserve pagination, serial requests and per-user counters', async () => {
  const app = harness({ users: Array.from({ length: 205 }, (_, index) => user(index)), records: Array.from({ length: 205 }, (_, index) => record(index)),
    post(body, attempt) {
      if (body.studentNumber === 'BJ099' && attempt === 1) throw new Error('retry at the page boundary');
      return { success: true };
    } });
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, summary({ total: 205, success: 205, retries: 1 }));
  assert.equal(app.calls.posts.length, 206);
  assert.equal(app.calls.maxHttp, 1);
  assert.equal(app.calls.updates.length, 205);
  assert.deepEqual(app.calls.reads.filter(call => call.name === 'users' && call.filter.bijingBound === true).map(call => [call.skip, call.limit]), [[0, 100], [100, 100], [200, 100]]);
  assert.ok(app.state.users.every(value => value.bijingSyncedDates[recordDate]));
});

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

test('trusted timer events and explicitly allowlisted administrators keep their existing authorization paths', async () => {
  const timer = harness();
  assert.equal((await timer.run({})).success, true);
  const operator = harness({ wxContext: { OPENID: 'operator', SOURCE: 'wx_client' }, env: { BIJING_TIMER_ENABLED: 'false', MAINTENANCE_ADMIN_OPENIDS: 'operator' } });
  assert.equal((await operator.run()).success, true);
  assert.equal(operator.calls.posts.length, 1);
});

test('manual sync preserves its one-request behavior while a marker failure is surfaced', async () => {
  const app = harness({ wxContext: { OPENID: 'owner-001', SOURCE: 'wx_client' }, onUpdate() { throw new Error('manual marker unavailable'); } });
  const result = await app.run({ type: 'syncSelectedDate', recordDate });
  assert.equal(result.success, false);
  assert.match(result.error, /manual marker unavailable/);
  assert.equal(app.calls.posts.length, 1);
  assert.deepEqual(app.calls.waits, []);
});

test('a no-op marker update is accepted only after rereading a true flag for the same binding and date', async () => {
  const app = harness({ users: [user(1, { bijingSyncedDates: { [recordDate]: true, '2026-09-14': true } })],
    onUpdate() { return { stats: { updated: 0 } }; } });
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, summary());
  assert.equal(app.calls.posts.length, 1);
  assert.equal(app.calls.updates.length, 1);
  assert.equal(app.calls.updates[0].updated, 0);
  assert.deepEqual(app.calls.waits, []);
  assert.deepEqual(app.state.users[0].bijingSyncedDates, { [recordDate]: true, '2026-09-14': true });
  assert.equal(app.calls.reads.filter(call => call.name === 'users' && call.filter._openid === 'owner-001').length, 3,
    'The zero-update result must reread binding and marker after the conditional update');
});

test('zero updated documents without a confirmed true date flag remain a failure after all retries', async t => {
  for (const flags of [{}, { [recordDate]: false }, { [recordDate]: 'true' }, { '2026-09-14': true }]) {
    await t.test(JSON.stringify(flags), async () => {
      const app = harness({ users: [user(1, { bijingSyncedDates: flags })], onUpdate() { return { stats: { updated: 0 } }; } });
      const result = await app.run();
      assert.equal(result.success, false);
      assert.equal(result.code, 'PARTIAL_SYNC_FAILED');
      assert.equal(result.data.success, 0);
      assert.equal(result.data.failed, 1);
      assert.equal(result.data.retries, 3);
      assert.equal(result.data.failedUsers[0].attempts, 4);
      assert.match(result.data.failedUsers[0].error, /写入同步标记失败/);
      assert.equal(app.calls.posts.length, 4);
      assert.equal(app.calls.updates.length, 4);
      assert.deepEqual(app.calls.waits, [500, 1000, 2000]);
      assert.deepEqual(app.state.users[0].bijingSyncedDates, flags);
    });
  }
});

test('truthy nonboolean upstream success values never mark a date as synced', async t => {
  for (const invalidSuccess of ['true', 1, {}, []]) {
    await t.test(JSON.stringify(invalidSuccess), async () => {
      const app = harness({ post() { return { success: invalidSuccess, message: 'invalid upstream success type' }; } });
      const result = await app.run();
      assert.equal(result.success, false);
      assert.equal(result.code, 'PARTIAL_SYNC_FAILED');
      assert.deepEqual(result.data, summary({ success: 0, failed: 1, retries: 3,
        failedUsers: [{ openid: 'owner-001', date: recordDate, attempts: 4, error: 'invalid upstream success type' }] }));
      assert.equal(app.calls.posts.length, 4);
      assert.equal(app.calls.updates.length, 0);
      assert.deepEqual(app.state.users[0].bijingSyncedDates, {});
    });
  }
});
