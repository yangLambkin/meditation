const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/bijingSync/index.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function comparison(op, value) {
  return { op, value, and(other) { return { op: 'and', values: [this, other] }; } };
}

function matches(value, filter) {
  if (filter && filter.op === 'or') return filter.values.some(part => matches(value, part));
  if (filter && filter.op === 'and') return filter.values.every(part => matches(value, part));
  if (filter && filter.op === 'gte') return typeof value === 'number' && value >= filter.value;
  if (filter && filter.op === 'lt') return typeof value === 'number' && value < filter.value;
  if (filter && typeof filter === 'object') return Object.entries(filter).every(([key, expected]) => matches(value[key], expected));
  return value === filter;
}

function createHarness(options = {}) {
  const now = Date.parse(options.now || '2026-09-17T02:00:00Z');
  const openid = Object.hasOwn(options, 'openid') ? options.openid : 'user-a';
  let wxContext = { OPENID: openid, SOURCE: options.platformSource || 'wx_client' };
  const users = clone(options.users || [{
    _id: 'doc-a',
    _openid: 'user-a',
    bijingBound: true,
    bijingStudentNumber: '123456',
    bijingBoundAt: '2026-09-17T03:00:00Z',
    bijingSyncedDates: {},
  }]);
  const records = clone(options.records || []);
  const calls = { reads: [], aggregates: [], updates: [], posts: [], gets: [], now: 0 };

  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      calls.now++;
      // A changing clock makes repeated Date.now reads observable in boundary tests.
      return now + (calls.now - 1) * (options.clockStep || 0);
    }
  }

  const database = {
    command: {
      aggregate: { sum: field => ({ sum: field }) },
      or: values => ({ op: 'or', values }),
      gte: value => comparison('gte', value),
      lt: value => comparison('lt', value),
    },
    collection(name) {
      return {
        where(filter) {
          let offset = 0;
          let maximum = Infinity;
          let order;
          let fields;
          return {
            skip(value) { offset = value; return this; },
            limit(value) { maximum = value; return this; },
            orderBy(key, direction) { order = { key, direction }; return this; },
            field(value) { fields = clone(value); return this; },
            async get() {
              calls.reads.push({ name, filter: clone(filter), offset, maximum, order, fields });
              if (options.readError) throw new Error(options.readError);
              if (name === 'meditation_records' && options.detailReadError) throw new Error(options.detailReadError);
              assert.ok(['users', 'meditation_records'].includes(name));
              const rows = (name === 'users' ? users : records).filter(row => matches(row, filter));
              if (order) rows.sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.direction === 'asc' ? 1 : -1));
              const page = rows.slice(offset, offset + maximum);
              return { data: clone(fields ? page.map(row => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && Object.hasOwn(row, key)).map(key => [key, row[key]]))) : page) };
            },
            async update({ data }) {
              assert.equal(name, 'users');
              const matched = users.filter(row => matches(row, filter));
              for (const user of matched) {
                calls.updates.push({ name, id: user._id, data: clone(data) });
                for (const [field, value] of Object.entries(data)) {
                  const parts = field.split('.');
                  const key = parts.pop();
                  const target = parts.reduce((object, part) => object[part] ||= {}, user);
                  target[key] = clone(value);
                }
              }
              return { stats: { updated: matched.length } };
            },
          };
        },
        aggregate() {
          let filter;
          return {
            match(value) { filter = value; return this; },
            group(value) {
              assert.equal(value.total.sum, '$duration');
              return this;
            },
            async end() {
              assert.equal(name, 'meditation_records');
              calls.aggregates.push(clone(filter));
              const matching = records.filter(record => Object.entries(filter).every(([key, value]) => record[key] === value));
              return { list: matching.length ? [{ total: matching.reduce((sum, record) => sum + (typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : 0), 0) }] : [] };
            },
          };
        },
        doc(id) {
          return {
            async update({ data }) {
              calls.updates.push({ name, id, data: clone(data) });
              assert.equal(name, 'users');
              Object.assign(users.find(user => user._id === id), clone(data));
            },
          };
        },
      };
    },
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    Date: FixedDate,
    process: { env: { BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'verified-timer-only', MAINTENANCE_ADMIN_OPENIDS: options.adminOpenid || '', BIJING_API_BASE: 'https://example.test', BIJING_ACCESS_TOKEN: 'test-token', ...options.env } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/bijingSync/maintenanceAuth');
      if (name === './heatmap') return require('../cloudfunctions/bijingSync/heatmap');
      if (name === 'wx-server-sdk') {
        return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database, getWXContext: () => wxContext };
      }
      if (name === 'axios') {
        return {
          async get(...args) {
            calls.gets.push(clone(args));
            if (options.getResponse) return { data: clone(options.getResponse) };
            throw new Error('Unexpected external GET');
          },
          async post(url, body, config) {
            calls.posts.push(clone({ url, body, config }));
            if (options.postError) throw new Error(options.postError);
            return { data: options.postResponse || { success: true } };
          },
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: 'bijingSync/index.js' });

  return {
    calls,
    users,
    records,
    async run(event, context = {}) { return clone(await exports.main(event, context)); },
    async timer(event = {}, context = {}) {
      const previous = wxContext;
      wxContext = { SOURCE: 'verified-timer-only' };
      try { return clone(await exports.main(event, context)); } finally { wxContext = previous; }
    },
    async select(recordDate) { return this.run({ type: 'syncSelectedDate', recordDate }); },
    async details(recordDate) { return this.run({ type: 'getSyncDateDetails', recordDate }); },
  };
}

test('getHeatmap dispatches to OpenAPI with the server token and ignores client supplied identity and credentials', async () => {
  const app = createHarness({ getResponse: { success: true, data: {
    studentNumber: 'other-user', nickname: '静心者', records: [{ date: '2026-09-15', duration: '30' }]
  } } });
  const result = await app.run({ type: 'getHeatmap', studentNumber: 'other-user', accessToken: 'client-token' });
  assert.deepEqual(result, { success: true, data: {
    studentNumber: '123456', nickname: '静心者', records: [{ date: '2026-09-15', duration: 30 }]
  } });
  assert.deepEqual(app.calls.gets, [['https://example.test/api/openapi/meditation/heatmap', {
    params: { studentNumber: '123456' }, headers: { 'X-Access-Token': 'test-token' }, timeout: 10000
  }]]);
  assert.equal(app.calls.posts.length, 0);
  assert.equal(app.calls.updates.length, 0);
});

test('getHeatmap requires the cloud OpenAPI token even if a client supplies one', async () => {
  const app = createHarness({ env: { BIJING_ACCESS_TOKEN: '' } });
  assert.deepEqual(await app.run({ type: 'getHeatmap', accessToken: 'client-token' }), {
    success: false, error: '热力图加载失败，请稍后重试'
  });
  assert.equal(app.calls.gets.length, 0);
});

test('checking and binding reject student numbers without an uppercase BJ prefix before reads, writes or external calls', async t => {
  for (const type of ['checkStudentNumber', 'bindStudentNumber']) {
    for (const studentNumber of ['bj123456', 'Bj123456', 'bJ123456', '123456', 'AB123456', 'XBJ123456', ' bj123456 ', 123456, ['BJ123456'], {}]) {
      await t.test(`${type}: ${JSON.stringify(studentNumber)}`, async () => {
        const app = createHarness();
        const originalUsers = clone(app.users);
        assert.deepEqual(await app.run({ type, studentNumber }), {
          success: false, error: '学号必须以大写 BJ 开头',
        });
        for (const key of ['reads', 'aggregates', 'updates', 'posts', 'gets']) assert.equal(app.calls[key].length, 0);
        assert.deepEqual(app.users, originalUsers);
      });
    }
  }
});

test('checking and binding keep the empty student number error, including whitespace-only input', async t => {
  for (const type of ['checkStudentNumber', 'bindStudentNumber']) {
    for (const studentNumber of [undefined, null, '', '   ']) {
      await t.test(`${type}: ${JSON.stringify(studentNumber)}`, async () => {
        const app = createHarness();
        assert.deepEqual(await app.run({ type, studentNumber }), { success: false, error: '学号不能为空' });
        for (const key of ['reads', 'updates', 'posts', 'gets']) assert.equal(app.calls[key].length, 0);
      });
    }
  }
});

test('checking and binding accept trimmed uppercase BJ prefixes without changing or restricting the suffix', async t => {
  for (const type of ['checkStudentNumber', 'bindStudentNumber']) {
    for (const studentNumber of ['BJ123456', '  BJabc-123  ', 'BJ']) {
      await t.test(`${type}: ${JSON.stringify(studentNumber)}`, async () => {
        const app = createHarness({ getResponse: { success: true, data: { nickname: '必经用户' } } });
        const result = await app.run({ type, studentNumber });
        const normalizedNumber = studentNumber.trim();
        assert.equal(result.success, true);
        assert.equal(result.data.studentNumber, normalizedNumber);
        assert.equal(app.calls.gets.length, 1);
        assert.equal(app.calls.gets[0][0], `https://example.test/api/openapi/users/${encodeURIComponent(normalizedNumber)}`);
        assert.deepEqual(app.calls.gets[0][1], { headers: { 'X-Access-Token': 'test-token' }, timeout: 10000 });
        if (type === 'bindStudentNumber') {
          assert.equal(app.calls.updates.length, 1);
          assert.equal(app.users[0].bijingBound, true);
          assert.equal(app.users[0].bijingStudentNumber, normalizedNumber);
        } else {
          assert.equal(app.calls.updates.length, 0);
        }
      });
    }
  }
});

test('selected sync includes legacy records for only the chosen date and current user, including dates before binding', async () => {
  const app = createHarness({ records: [
    { _openid: 'user-a', date: '2026-09-15', duration: 20.2 },
    { _openid: 'user-a', date: '2026-09-15', duration: 19.6 },
    { _openid: 'user-a', date: '2026-09-16', duration: 99 },
    { _openid: 'user-b', date: '2026-09-15', duration: 100 },
  ] });
  assert.deepEqual(await app.select('2026-09-15'), {
    success: true,
    data: { openid: 'user-a', date: '2026-09-15', success: true, duration: 40 },
  });
  assert.equal(app.calls.reads.filter(call => call.name === 'meditation_records').length, 1);
  assert.equal(app.calls.posts.length, 1);
  assert.equal(app.calls.posts[0].url, 'https://example.test/api/openapi/meditation/records');
  assert.deepEqual(app.calls.posts[0].config, { headers: { 'X-Access-Token': 'test-token' }, timeout: 10000 });
  assert.deepEqual(app.calls.posts[0].body, { studentNumber: '123456', recordDate: '2026-09-15', durationMinutes: 40 });
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-15': true });
  assert.equal(app.calls.now, 1);
});

test('a leftover batch environment flag cannot change manual or timer sync into asynchronous submission', async t => {
  for (const mode of ['manual', 'timer']) {
    await t.test(mode, async () => {
      const app = createHarness({
        env: { BIJING_BATCH_ENABLED: 'true' },
        records: [{ _openid: 'user-a', date: '2026-09-16', duration: 25 }],
      });
      const result = mode === 'manual' ? await app.select('2026-09-16') : await app.timer();
      assert.equal(result.success, true);
      assert.deepEqual(app.calls.posts, [{
        url: 'https://example.test/api/openapi/meditation/records',
        body: { studentNumber: '123456', recordDate: '2026-09-16', durationMinutes: 25 },
        config: { headers: { 'X-Access-Token': 'test-token' }, timeout: 10000 },
      }]);
      assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-16': true });
      assert.equal(result.data.accepted, undefined);
    });
  }
});

test('only the seven completed sync dates can be previewed and uploaded across 02:00, month, leap-year and year boundaries', async t => {
  const cases = [
    ['2026-09-16T15:59:59.999Z', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09'], '2026-09-08', '2026-09-16'],
    ['2026-09-16T16:00:00.000Z', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09'], '2026-09-08', '2026-09-16'],
    ['2026-09-16T17:59:59.999Z', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09'], '2026-09-08', '2026-09-16'],
    ['2026-09-16T18:00:00.000Z', ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10'], '2026-09-09', '2026-09-17'],
    ['2026-10-02T18:00:00.000Z', ['2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26'], '2026-09-25', '2026-10-03'],
    ['2027-01-02T18:00:00.000Z', ['2027-01-02', '2027-01-01', '2026-12-31', '2026-12-30', '2026-12-29', '2026-12-28', '2026-12-27'], '2026-12-26', '2027-01-03'],
    ['2028-03-02T18:00:00.000Z', ['2028-03-02', '2028-03-01', '2028-02-29', '2028-02-28', '2028-02-27', '2028-02-26', '2028-02-25'], '2028-02-24', '2028-03-03'],
  ];
  for (const [now, allowed, expired, unfinished] of cases) {
    await t.test(now, async () => {
      for (const method of ['select', 'details']) {
        for (const date of allowed) {
          const app = createHarness({ now, clockStep: 24 * 3600 * 1000, records: [{ _openid: 'user-a', date, duration: 20 }] });
          const result = await app[method](date);
          assert.equal(result.success, true);
          assert.equal(result.data.date, date);
          assert.equal(result.data[method === 'select' ? 'duration' : 'totalDuration'], 20);
          assert.equal(app.calls.posts.length, method === 'select' ? 1 : 0);
          assert.equal(app.calls.now, 1);
        }
        for (const date of [expired, unfinished]) {
          const app = createHarness({ now });
          assert.equal((await app[method](date)).success, false);
          assert.equal(app.calls.reads.length, 0);
          assert.equal(app.calls.posts.length, 0);
        }
      }
    });
  }
});

test('invalid, missing, today, future and expired dates are rejected before database reads or external calls', async t => {
  for (const date of [undefined, null, '', 20260916, ['2026-09-16'], {}, true, '2026-9-16', ' 2026-09-16', '2026-09-16T00:00:00+08:00', '2026-09-31', '2026-09-09', '2026-09-17', '2026-09-18']) {
    await t.test(String(date), async () => {
      const app = createHarness();
      const result = await app.select(date);
      assert.equal(result.success, false);
      assert.match(result.error, /最近七天/);
      for (const key of ['reads', 'aggregates', 'updates', 'posts', 'gets']) assert.equal(app.calls[key].length, 0);
    });
  }
});

test('manual selection requires a logged-in user', async () => {
  const app = createHarness({ openid: undefined });
  assert.deepEqual(await app.select('2026-09-16'), { success: false, error: '用户未登录' });
  assert.equal(app.calls.reads.length, 0);
  assert.equal(app.calls.posts.length, 0);
});

test('manual selection requires an existing complete binding', async t => {
  for (const users of [[], [{ _id: 'doc-a', _openid: 'user-a', bijingBound: false }], [{ _id: 'doc-a', _openid: 'user-a', bijingBound: true }]]) {
    await t.test(JSON.stringify(users), async () => {
      const app = createHarness({ users });
      assert.deepEqual(await app.select('2026-09-16'), { success: false, error: '尚未绑定学号' });
      assert.equal(app.calls.aggregates.length, 0);
      assert.equal(app.calls.posts.length, 0);
      assert.equal(app.calls.updates.length, 0);
    });
  }
});

test('repeated manual sync posts every time, recalculates changed totals and preserves sync history', async () => {
  const app = createHarness({ records: [{ _openid: 'user-a', date: '2026-09-16', duration: 20 }] });
  app.users[0].bijingSyncedDates = { '2026-09-10': true };
  for (const duration of [20, 20, 35, 15]) {
    app.records[0].duration = duration;
    assert.deepEqual(await app.select('2026-09-16'), {
      success: true, data: { openid: 'user-a', date: '2026-09-16', success: true, duration },
    });
  }
  assert.deepEqual(app.calls.posts.map(call => call.body), [20, 20, 35, 15].map(durationMinutes => ({
    studentNumber: '123456', recordDate: '2026-09-16', durationMinutes,
  })));
  assert.equal(app.calls.reads.filter(call => call.name === 'meditation_records').length, 4);
  assert.equal(app.calls.updates.length, 4);
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-10': true, '2026-09-16': true });
});

test('automatic and manual sync can repeat in either order and include late-arriving records', async t => {
  for (const first of ['automatic', 'manual']) {
    await t.test(first, async () => {
      const app = createHarness({ records: [{ _openid: 'user-a', date: '2026-09-16', duration: 20 }] });
      const automatic = () => app.timer();
      const manual = () => app.select('2026-09-16');
      const initial = first === 'automatic' ? automatic : manual;
      const following = first === 'automatic' ? manual : automatic;
      await initial();
      assert.equal((await app.details('2026-09-16')).data.alreadySynced, true);
      app.records.push({ _openid: 'user-a', date: '2026-09-17',
        timestamp: Date.parse('2026-09-17T01:30:00+08:00'), duration: 10 });
      await following();
      await automatic();
      assert.deepEqual(app.calls.posts.map(call => call.body), [20, 30, 30].map(durationMinutes => ({
        studentNumber: '123456', recordDate: '2026-09-16', durationMinutes,
      })));
      assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-16': true });
    });
  }
});

test('failed resync reports the failure despite a previous success and remains retryable', async () => {
  const options = { records: [{ _openid: 'user-a', date: '2026-09-16', duration: 20 }] };
  const app = createHarness(options);
  assert.equal((await app.select('2026-09-16')).data.success, true);
  options.postError = '请求超时';
  assert.deepEqual(await app.select('2026-09-16'), { success: false, error: '请求超时' });
  assert.equal(app.calls.posts.length, 2);
  assert.equal(app.calls.updates.length, 1);
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-16': true });
  delete options.postError;
  assert.equal((await app.select('2026-09-16')).data.success, true);
  assert.equal(app.calls.posts.length, 3);
  assert.equal(app.calls.updates.length, 2);
});

test('a date with no records is skipped without a synchronization flag', async () => {
  const app = createHarness();
  const result = await app.select('2026-09-16');
  assert.equal(result.success, true);
  assert.equal(result.data.skipped, true);
  assert.match(result.data.reason, /无打卡数据/);
  assert.equal(result.data.duration, 0);
  assert.equal(app.calls.posts.length, 0);
  assert.equal(app.calls.updates.length, 0);
  assert.deepEqual(app.users[0].bijingSyncedDates, {});
});

test('external rejection or exception becomes a top-level failure and never marks the date', async t => {
  for (const options of [{ postResponse: { success: false, message: '后端维护' } }, { postError: '请求超时' }]) {
    await t.test(JSON.stringify(options), async () => {
      const app = createHarness({ ...options, records: [{ _openid: 'user-a', date: '2026-09-16', duration: 20 }] });
      const result = await app.select('2026-09-16');
      assert.equal(result.success, false);
      assert.equal(result.error, options.postError || options.postResponse.message);
      assert.equal(app.calls.updates.length, 0);
      assert.equal(app.calls.posts.length, 1);
    });
  }
});

test('database failure becomes a top-level failure', async () => {
  const app = createHarness({ readError: '数据库暂不可用' });
  assert.deepEqual(await app.select('2026-09-16'), { success: false, error: '数据库暂不可用' });
  assert.equal(app.calls.posts.length, 0);
});

test('legacy syncPending repeats all seven completed dates with or without force and preserves its summary shape', async () => {
  const dates = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16'];
  const app = createHarness({ records: ['2026-09-01', '2026-09-09', ...dates, '2026-09-17'].map(date => ({ _openid: 'user-a', date, duration: 20 })) });
  app.users[0].bijingBoundAt = '2026-09-01T03:00:00Z';
  app.users[0].bijingSyncedDates = { '2026-09-01': true, '2026-09-15': true };
  const result = await app.run({ type: 'syncPending', force: true });
  assert.equal(result.success, true);
  assert.deepEqual({ ...result.data, results: undefined }, { pending: 7, synced: 7, skipped: 0, failed: 0, pendingCount: 0, forced: false, results: undefined });
  assert.deepEqual(result.data.results.map(value => value.date), dates);
  assert.deepEqual(app.calls.posts.map(value => value.body.recordDate), dates);
  assert.equal(app.calls.updates.length, 7);
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-01': true, ...Object.fromEntries(dates.map(date => [date, true])) });
  assert.equal(app.calls.now, 1);
  assert.deepEqual(await app.run({ type: 'syncPending' }), result);
  assert.deepEqual(app.calls.posts.slice(7).map(value => value.body.recordDate), dates);
});

test('legacy syncPending can backfill all seven recent dates for a newly bound user', async () => {
  const app = createHarness({ records: [{ _openid: 'user-a', date: '2026-09-10', duration: 20 }] });
  const result = await app.run({ type: 'syncPending' });
  assert.deepEqual(result.data.results.map(value => value.date), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
  assert.equal(result.data.pending, 7);
  assert.equal(result.data.synced, 1);
  assert.equal(result.data.skipped, 6);
  assert.deepEqual(app.calls.posts.map(value => value.body.recordDate), ['2026-09-10']);
  assert.equal(app.calls.updates.length, 1);
});

test('automatic timer sync still synchronizes only yesterday for all bound users', async t => {
  for (const [event, context] of [[{}, { source: 'timer' }], [{}, {}], [{ type: 'cronSyncAll' }, {}]]) {
    await t.test(JSON.stringify({ event, context }), async () => {
      const app = createHarness({
        openid: undefined,
        now: '2026-09-30T18:00:00Z',
        users: [
          { _id: 'doc-a', _openid: 'user-a', bijingBound: true, bijingStudentNumber: '123456' },
          { _id: 'doc-b', _openid: 'user-b', bijingBound: true, bijingStudentNumber: '234567' },
          { _id: 'doc-c', _openid: 'user-c', bijingBound: false },
        ],
        records: ['user-a', 'user-b', 'user-c'].flatMap(_openid => ['2026-09-29', '2026-09-30', '2026-10-01'].map(date => ({ _openid, date, duration: 30 }))),
      });
      assert.deepEqual(await app.timer(event, context), { success: true, data: {
        date: '2026-09-30', total: 2, success: 2, failed: 0, skipped: 0, retries: 0, failedUsers: [],
      } });
      assert.deepEqual(app.calls.posts.map(value => value.body), [
        { studentNumber: '123456', recordDate: '2026-09-30', durationMinutes: 30 },
        { studentNumber: '234567', recordDate: '2026-09-30', durationMinutes: 30 },
      ]);
    });
  }
});

test('date details paginate all matching records, omit private fields and match the uploaded day total', async () => {
  const selectedRecords = Array.from({ length: 205 }, (_, index) => ({
    _id: `record-${String(index).padStart(3, '0')}`,
    _openid: 'user-a',
    date: '2026-09-16',
    timestamp: Date.parse('2026-09-16T01:00:00Z') + index * 1000,
    duration: 0.25,
    emotion: 'private mood',
    experience: 'private journal',
  }));
  const app = createHarness({ records: [
    ...selectedRecords.slice().reverse(),
    { _id: 'other-day', _openid: 'user-a', date: '2026-09-15', duration: 99 },
    { _id: 'other-user', _openid: 'user-b', date: '2026-09-16', duration: 99 },
  ] });
  const result = await app.details('2026-09-16');
  assert.equal(result.success, true);
  assert.equal(result.data.date, '2026-09-16');
  assert.equal(result.data.count, 205);
  assert.equal(result.data.totalDuration, 51.25);
  assert.equal(result.data.syncDuration, 51);
  assert.equal(result.data.alreadySynced, false);
  assert.deepEqual(result.data.records, selectedRecords.slice().reverse().map(({ _id, timestamp, duration }) => ({ id: _id, timestamp, duration })));
  const pages = app.calls.reads.filter(call => call.name === 'meditation_records');
  assert.deepEqual(pages.map(page => page.offset), [0, 100, 200]);
  for (const page of pages) {
    assert.deepEqual(page.filter, { _openid: 'user-a' });
    assert.equal(page.maximum, 100);
    assert.deepEqual(page.order, { key: '_id', direction: 'asc' });
    assert.deepEqual(page.fields, { _id: true, date: true, timestamp: true, duration: true, source: true, dateSource: true, localId: true, idempotencyKey: true });
  }
  assert.equal(app.calls.now, 1);
  for (const key of ['aggregates', 'posts', 'gets', 'updates']) assert.equal(app.calls[key].length, 0);

  await app.select('2026-09-16');
  assert.equal(app.calls.posts[0].body.durationMinutes, result.data.syncDuration);
});

test('details preserve missing legacy times, sort equal times by id and ignore nonnumeric durations', async () => {
  const timestamp = Date.parse('2026-09-16T08:00:00+08:00');
  const app = createHarness({ records: [
    { _id: 'b', _openid: 'user-a', date: '2026-09-16', timestamp, duration: 20.25 },
    { _id: 'a', _openid: 'user-a', date: '2026-09-16', timestamp, duration: 20.25 },
    { _id: 'missing-time', _openid: 'user-a', date: '2026-09-16', duration: '99', createTime: '2026-09-17T01:00:00Z' },
    { _id: 'invalid-time', _openid: 'user-a', date: '2026-09-16', timestamp: 'invalid', duration: null },
  ] });
  const result = await app.details('2026-09-16');
  assert.deepEqual(result.data.records, [
    { id: 'a', timestamp, duration: 20.25 },
    { id: 'b', timestamp, duration: 20.25 },
    { id: 'invalid-time', timestamp: null, duration: 0 },
    { id: 'missing-time', timestamp: null, duration: 0 },
  ]);
  assert.equal(result.data.count, 4);
  assert.equal(result.data.totalDuration, 40.5);
  assert.equal(result.data.syncDuration, 41);
  await app.select('2026-09-16');
  assert.equal(app.calls.posts[0].body.durationMinutes, 41);
});

test('empty date details return zero totals and the existing sync status without changing it', async () => {
  const app = createHarness();
  app.users[0].bijingSyncedDates = { '2026-09-16': true };
  assert.deepEqual(await app.details('2026-09-16'), {
    success: true,
    data: { date: '2026-09-16', records: [], count: 0, totalDuration: 0, syncDuration: 0, alreadySynced: true },
  });
  assert.equal(app.calls.posts.length, 0);
  assert.equal(app.calls.updates.length, 0);
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-16': true });
});

test('date details apply the same login, binding and recent-date validation as selected sync', async t => {
  const cases = [
    [{ openid: undefined }, '2026-09-16', '用户未登录'],
    [{}, undefined, '最近七天'],
    [{}, null, '最近七天'],
    [{}, 20260916, '最近七天'],
    [{}, '2026-09-09', '最近七天'],
    [{}, '2026-09-17', '最近七天'],
    [{}, '2026-09-18', '最近七天'],
    [{}, '2026-9-16', '最近七天'],
    [{ users: [] }, '2026-09-16', '尚未绑定学号'],
    [{ users: [{ _id: 'a', _openid: 'user-a', bijingBound: false }] }, '2026-09-16', '尚未绑定学号'],
    [{ users: [{ _id: 'a', _openid: 'user-a', bijingBound: true }] }, '2026-09-16', '尚未绑定学号'],
  ];
  for (const [options, date, error] of cases) {
    await t.test(`${String(date)}: ${error}`, async () => {
      const app = createHarness(options);
      const result = await app.details(date);
      assert.equal(result.success, false);
      assert.match(result.error, new RegExp(error));
      assert.equal(app.calls.reads.filter(call => call.name === 'meditation_records').length, 0);
      if (error !== '尚未绑定学号') assert.equal(app.calls.reads.length, 0);
      assert.equal(app.calls.posts.length, 0);
      assert.equal(app.calls.updates.length, 0);
    });
  }
  const midnight = createHarness({ now: '2026-09-30T16:00:00Z', clockStep: 24 * 3600 * 1000 });
  assert.equal((await midnight.details('2026-09-28')).success, true);
  assert.equal(midnight.calls.now, 1);
});

test('date details return a failure when user or detail reads fail', async t => {
  for (const options of [{ readError: '用户读取失败' }, { detailReadError: '明细读取失败' }]) {
    await t.test(JSON.stringify(options), async () => {
      const app = createHarness(options);
      assert.deepEqual(await app.details('2026-09-16'), { success: false, error: options.readError || options.detailReadError });
      assert.equal(app.calls.posts.length, 0);
      assert.equal(app.calls.updates.length, 0);
    });
  }
});

test('preview and upload use [02:00, next-day 02:00) without counting a record in adjacent days', async () => {
  const record = (id, time, duration, extra = {}) => ({
    _id: id, _openid: 'user-a', date: time.slice(0, 10), timestamp: Date.parse(time), duration, ...extra,
  });
  const app = createHarness({ records: [
    record('before-start', '2026-09-15T01:59:59.999+08:00', 1),
    record('start', '2026-09-15T02:00:00+08:00', 2),
    record('midnight', '2026-09-16T00:00:00+08:00', 3),
    record('before-end', '2026-09-16T01:59:59.999+08:00', 4),
    record('end', '2026-09-16T02:00:00+08:00', 5),
    record('wrong-date', '2026-09-16T01:00:00+08:00', 6, { date: '2026-09-01' }),
    record('other-user', '2026-09-16T02:00:00+08:00', 100, { _openid: 'user-b' }),
  ] });
  const previous = (await app.details('2026-09-14')).data;
  const selected = (await app.details('2026-09-15')).data;
  const following = (await app.details('2026-09-16')).data;
  assert.deepEqual(previous.records.map(item => item.id), ['before-start']);
  assert.deepEqual(selected.records.map(item => item.id), ['before-end', 'wrong-date', 'midnight', 'start']);
  assert.deepEqual(following.records.map(item => item.id), ['end']);
  assert.equal(selected.totalDuration, 15);
  const ids = [...previous.records, ...selected.records, ...following.records].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  await app.select('2026-09-15');
  assert.equal(app.calls.posts[0].body.durationMinutes, selected.syncDuration);
});

test('sync windows include next-day early hours across month, year and leap-day boundaries', async t => {
  for (const [date, nextDate] of [['2026-09-30', '2026-10-01'], ['2026-12-31', '2027-01-01'], ['2028-02-29', '2028-03-01']]) {
    await t.test(date, async () => {
      const app = createHarness({ now: `${nextDate}T02:00:00+08:00`, records: [
        { _id: 'late', _openid: 'user-a', date: nextDate, timestamp: Date.parse(`${nextDate}T01:59:59.999+08:00`), duration: 20 },
        { _id: 'new-day', _openid: 'user-a', date: nextDate, timestamp: Date.parse(`${nextDate}T02:00:00+08:00`), duration: 99 },
      ] });
      assert.equal((await app.details(date)).data.totalDuration, 20);
      await app.select(date);
      assert.deepEqual(app.calls.posts[0].body, { studentNumber: '123456', recordDate: date, durationMinutes: 20 });
    });
  }
});

test('before 02:00 manual calls reject the unfinished date and cron only uploads the latest finished day', async () => {
  const app = createHarness({ now: '2026-09-17T01:59:59.999+08:00', records: [
    { _id: 'finished', _openid: 'user-a', date: '2026-09-16', timestamp: Date.parse('2026-09-16T01:00:00+08:00'), duration: 10 },
    { _id: 'unfinished', _openid: 'user-a', date: '2026-09-17', timestamp: Date.parse('2026-09-17T01:00:00+08:00'), duration: 20 },
  ] });
  assert.equal((await app.select('2026-09-16')).success, false);
  assert.equal((await app.details('2026-09-16')).success, false);
  assert.equal(app.calls.reads.length, 0);
  const cron = await app.timer({ type: 'cronSyncAll' });
  assert.equal(cron.data.date, '2026-09-15');
  assert.deepEqual(app.calls.posts.map(item => item.body), [{ studentNumber: '123456', recordDate: '2026-09-15', durationMinutes: 10 }]);
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-15': true });
});

test('sync normalizes legacy string timestamps, preserves manual days and counts stable retries once', async () => {
  const app = createHarness({ records: [
    { _id: 'a', _openid: 'user-a', date: '2026-09-16', timestamp: '2026-09-16T01:00:00+08:00', duration: 10, localId: 'same-session' },
    { _id: 'b', _openid: 'user-a', date: '2026-09-16', timestamp: String(Date.parse('2026-09-16T01:00:00+08:00')), duration: 10, idempotencyKey: 'same-session' },
    { _id: 'c', _openid: 'user-a', date: '2026-09-16', timestamp: String(Date.parse('2026-09-16T01:59:59.999+08:00')), duration: 20 },
    { _id: 'd', _openid: 'user-a', date: '2026-09-14', timestamp: '2026-09-16T01:30:00+08:00', source: 'manual', duration: 30 },
    { _id: 'e', _openid: 'user-a', date: '2026-09-14', timestamp: '2026-09-16T01:30:00', duration: 40 },
    { _id: 'f', _openid: 'user-b', date: '2026-09-15', timestamp: '2026-09-16T01:30:00+08:00', duration: 99 },
  ] });
  const selected = (await app.details('2026-09-15')).data;
  assert.deepEqual(selected.records.map(row => row.id), ['c', 'a']);
  assert.equal(selected.totalDuration, 30);
  assert.ok(selected.records.every(row => typeof row.timestamp === 'number'));
  assert.equal((await app.details('2026-09-14')).data.totalDuration, 70);
  assert.equal((await app.details('2026-09-16')).data.count, 0);
  await app.select('2026-09-15');
  assert.equal(app.calls.posts[0].body.durationMinutes, 30);
});
