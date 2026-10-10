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
  if (filter && filter.op === 'gt') return value > filter.value;
  if (filter && filter.op === 'lt') return typeof value === 'number' && value < filter.value;
  if (filter && filter.op === 'regex') return typeof value === 'string' && new RegExp(filter.regexp, filter.options).test(value);
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
  const bindingRows = clone(options.bindings || []);
  const backfillRequests = clone(options.requests || []);
  const deletionReceipts = clone(options.receipts || []);
  const syncErrors = clone(options.syncErrors || []);
  const calls = { reads: [], documentReads: [], aggregates: [], updates: [], bindingWrites: [], posts: [], queries: [], gets: [], sleeps: [], now: 0 };

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
    RegExp: value => ({ op: 'regex', ...value }),
    async runTransaction(callback) { return callback(database); },
    command: {
      aggregate: { sum: field => ({ sum: field }) },
      or: values => ({ op: 'or', values }),
      gte: value => comparison('gte', value),
      lt: value => comparison('lt', value),
      gt: value => comparison('gt', value),
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
              if (options.onRead) options.onRead({ name, filter }, records);
              if (options.readError) throw new Error(options.readError);
              if (name === 'meditation_records' && options.detailReadError) throw new Error(options.detailReadError);
              if (name === 'backfill_requests' && options.backfillReadError) throw options.backfillReadError;
              assert.ok(['users', 'meditation_records', 'bijing_bindings', 'backfill_requests'].includes(name));
              const rows = (name === 'users' ? users : name === 'bijing_bindings' ? bindingRows : name === 'backfill_requests' ? backfillRequests : records).filter(row => matches(row, filter));
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
            async get() {
              calls.documentReads.push({ name, id });
              if (name === 'backfill_requests' && options.backfillReadError) throw options.backfillReadError;
              const rows = name === 'bijing_sync_errors' ? syncErrors : name === 'meditation_locks' ? deletionReceipts : name === 'backfill_requests' ? backfillRequests : name === 'meditation_records' ? records : name === 'users' ? users : bindingRows;
              const row = rows.find(row => row._id === id);
              return { data: row ? clone(row) : null };
            },
            async set({ data }) {
              const rows = name === 'bijing_sync_errors' ? syncErrors : name === 'backfill_requests' ? backfillRequests : name === 'users' ? users : bindingRows;
              const previous = rows.find(row => row._id === id);
              if (previous) rows.splice(rows.indexOf(previous), 1);
              rows.push({ _id: id, ...clone(data) });
              if (name !== 'bijing_sync_errors') (name === 'users' ? calls.updates : calls.bindingWrites).push({ name, id, data: clone(data) });
            },
            async update({ data }) {
              if (name === 'bijing_sync_errors') { Object.assign(syncErrors.find(row => row._id === id), clone(data)); return; }
              calls.updates.push({ name, id, data: clone(data) });
              assert.equal(name, 'users');
              Object.assign(users.find(user => user._id === id), clone(data));
            },
            async remove() {
              assert.equal(name, 'bijing_sync_errors');
              const index = syncErrors.findIndex(row => row._id === id);
              if (index >= 0) syncErrors.splice(index, 1);
            },
          };
        },
      };
    },
  };
  // Load the real historical-sync implementations with only their retry delay
  // accelerated. Recorded/deleted entrypoints must share this same lease loop.
  const historicalModules = new Map();
  function historicalModule(name) {
    if (historicalModules.has(name)) return historicalModules.get(name).exports;
    const module = { exports: {} };
    historicalModules.set(name, module);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/bijingSync', `${name.slice(2)}.js`), 'utf8'), {
      module,
      exports: module.exports,
      Date: FixedDate,
      console: { log() {}, warn() {}, error() {} },
      setTimeout(callback, delay) { calls.sleeps.push(delay); return setTimeout(callback, 0); },
      clearTimeout,
      require(dependency) {
        if (dependency === './backfillSync') return historicalModule(dependency);
        return require(dependency);
      },
    }, { filename: `bijingSync/${name.slice(2)}.js` });
    return module.exports;
  }
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    Date: FixedDate,
    process: { env: { BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'verified-timer-only', MAINTENANCE_ADMIN_OPENIDS: options.adminOpenid || '', BIJING_API_BASE: 'https://example.test', BIJING_ACCESS_TOKEN: 'test-token', ...options.env } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/bijingSync/maintenanceAuth');
      if (name === './heatmap') return require('../cloudfunctions/bijingSync/heatmap');
      if (['./backfillSync', './recordedSync', './deletedSync'].includes(name)) return historicalModule(name);
      if (name === './verifyRecord') return require('../cloudfunctions/bijingSync/verifyRecord');
      if (name === './syncFailures') return require('../cloudfunctions/bijingSync/syncFailures');
      if (name === './bindings') return require('../cloudfunctions/bijingSync/bindings');
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
            if (url.endsWith('/meditation/records/query')) {
              calls.queries.push(clone({ url, body, config }));
              if (options.onQuery) return { data: await options.onQuery({ url, body, config, attempt: calls.queries.length }, records) };
              if (options.queryError) throw new Error(options.queryError);
              if (Object.hasOwn(options, 'queryResponse')) return { data: clone(options.queryResponse) };
              const requested = body.records[0];
              const uploaded = [...calls.posts].reverse().find(call => call.body.studentNumber === requested.studentNumber && call.body.recordDate === requested.recordDate);
              return { data: { success: true, data: { total: 1, results: [{ index: 0, ...requested,
                exists: !!uploaded, durationMinutes: uploaded ? uploaded.body.durationMinutes : 0 }] } } };
            }
            calls.posts.push(clone({ url, body, config }));
            if (options.onPost) return { data: await options.onPost({ url, body, config, attempt: calls.posts.length }, records) };
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
    syncErrors,
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

test('syncRecordedDate dispatch derives the saved owner and business date and posts all of that day', async () => {
  const recordDate = '2026-08-18';
  const app = createHarness({ records: [
    { _id: 'manual-old', _openid: 'user-a', source: 'manual', date: recordDate, duration: 35 },
    { _id: 'timer-old', _openid: 'user-a', source: 'timer', timestamp: Date.parse('2026-08-18T05:00:00Z'), duration: 25 },
    { _id: 'another-owner', _openid: 'other', source: 'manual', date: recordDate, duration: 90 }
  ] });
  const result = await app.run({ type: 'syncRecordedDate', recordId: 'manual-old', expectedOpenid: 'user-a',
    openid: 'other', recordDate: '2026-09-16', date: '2026-09-16', studentNumber: 'forged' });
  assert.equal(result.success, true); assert.equal(result.data.date, recordDate); assert.equal(result.data.duration, 60);
  assert.equal(app.calls.posts.length, 1); assert.equal(app.calls.posts[0].body.recordDate, recordDate);
  assert.equal(app.calls.posts[0].body.durationMinutes, 60); assert.equal(app.calls.posts[0].body.studentNumber, '123456');
  assert.deepEqual(app.calls.queries, [{ url: 'https://example.test/api/openapi/meditation/records/query',
    body: { records: [{ studentNumber: '123456', recordDate }] },
    config: { headers: { 'X-Access-Token': 'test-token' }, timeout: 4000 } }]);
  assert.equal(app.calls.posts[0].config.timeout, 4000);
  assert.equal((await app.run({ type: 'syncRecordedDate', recordId: 'timer-old' })).success, true);
  const foreign = await app.run({ type: 'syncRecordedDate', recordId: 'another-owner' });
  assert.equal(foreign.code, 'RECORD_NOT_FOUND'); assert.equal(app.calls.posts.length, 2);
});

function remoteRecordResult(recordDate, durationMinutes, fields = {}) {
  return { success: true, data: { total: 1, results: [{ index: 0, studentNumber: '123456',
    recordDate, exists: true, durationMinutes, ...fields }] } };
}

function historicalVerificationScenario(type, options = {}) {
  const recordDate = '2026-08-18', requestId = 'br_' + '2'.repeat(64), deletionId = 'md_' + '3'.repeat(64);
  const app = createHarness({ requests: [{ _id: requestId, kind: 'request', ownerOpenid: 'user-a',
    status: 'approved', startDate: recordDate, endDate: '2026-09-16', recordedDates: [recordDate] }],
    receipts: [{ _id: deletionId, kind: 'deletion_receipt', ownerOpenid: 'user-a', recordId: 'deleted', date: recordDate }],
    records: [{ _id: 'historical', _openid: 'user-a', source: 'manual', date: recordDate, duration: 20 }],
    ...options });
  return { app, recordDate, event: { type, recordId: 'historical', requestId, backfillRequestId: requestId,
    deletionId, recordDate, expectedOpenid: 'user-a' } };
}

test('every saved historical entrypoint uploads and confirms remote data before reporting success', async t => {
  for (const type of ['syncRecordedDate', 'syncBackfillDate', 'syncDeletedDate', 'syncSelectedDate']) {
    await t.test(type, async () => {
      const { app, event, recordDate } = historicalVerificationScenario(type);
      const result = await app.run(event);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(app.calls.posts.length, 1); assert.equal(app.calls.queries.length, 1);
      assert.equal(app.calls.posts[0].config.timeout, 4000);
      assert.equal(app.calls.queries[0].config.timeout, 4000);
      assert.deepEqual(app.calls.queries[0].body, { records: [{ studentNumber: '123456', recordDate }] });
      assert.equal(app.users[0].bijingSyncedDates[recordDate], true);
    });
  }
});

test('historical uploads retry missing, mismatched, malformed and failed remote checks at most three times', async t => {
  const recordDate = '2026-08-18';
  const cases = [
    ['missing record', { queryResponse: remoteRecordResult(recordDate, 0, { exists: false }) }],
    ['wrong duration', { queryResponse: remoteRecordResult(recordDate, 19) }],
    ['wrong date', { queryResponse: remoteRecordResult('2026-08-19', 20) }],
    ['wrong account', { queryResponse: remoteRecordResult(recordDate, 20, { studentNumber: 'someone-else' }) }],
    ['HTTP failure', { queryError: 'Request failed with status code 503' }],
    ['invalid response', { queryResponse: { success: true, data: { total: 1, results: [] } } }],
    ['query rejection', { queryResponse: { success: false, message: '查询暂不可用' } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => {
      const { app, event } = historicalVerificationScenario('syncRecordedDate', options);
      const result = await app.run(event);
      assert.equal(result.success, false);
      assert.equal(app.calls.posts.length, 4, 'one initial upload and at most three retries');
      assert.equal(app.calls.queries.length, 4);
      assert.deepEqual(app.calls.sleeps, [1000, 1000, 1000]);
      assert.equal(app.calls.updates.length, 0);
      assert.equal(app.users[0].bijingSyncedDates[recordDate], undefined);
      assert.equal(app.records[0].duration, 20, 'a failed sync retains the saved meditation');
    });
  }
});

test('a historical upload succeeds when the fourth remote check finally matches', async () => {
  const { app, event, recordDate } = historicalVerificationScenario('syncBackfillDate', {
    onQuery({ attempt }) { return remoteRecordResult('2026-08-18', attempt < 4 ? 19 : 20); },
  });
  const result = await app.run(event);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.duration, 20);
  assert.equal(app.calls.posts.length, 4); assert.equal(app.calls.queries.length, 4);
  assert.deepEqual(app.calls.sleeps, [1000, 1000, 1000]);
  assert.equal(app.calls.updates.length, 1);
  assert.equal(app.users[0].bijingSyncedDates[recordDate], true);
});

test('failed historical uploads retry three times without checking remote data until an upload succeeds', async t => {
  for (const failForever of [false, true]) {
    await t.test(failForever ? 'retries exhausted' : 'fourth upload succeeds', async () => {
      const { app, event, recordDate } = historicalVerificationScenario('syncRecordedDate', {
        onPost({ attempt }) {
          if (attempt < 4 || failForever) throw new Error('network unavailable');
          return { success: true };
        },
      });
      const result = await app.run(event);
      assert.equal(result.success, !failForever);
      assert.equal(app.calls.posts.length, 4);
      assert.equal(app.calls.queries.length, failForever ? 0 : 1);
      assert.equal(app.calls.updates.length, failForever ? 0 : 1);
      assert.equal(app.users[0].bijingSyncedDates[recordDate], failForever ? undefined : true);
    });
  }
});

test('a historical query in flight never writes a success marker', async () => {
  let releaseQuery, queryStarted;
  const started = new Promise(resolve => { queryStarted = resolve; });
  const response = new Promise(resolve => { releaseQuery = resolve; });
  const { app, event, recordDate } = historicalVerificationScenario('syncRecordedDate', {
    async onQuery() { queryStarted(); return response; },
  });
  const pending = app.run(event);
  await started;
  try {
    assert.equal(app.calls.posts.length, 1); assert.equal(app.calls.queries.length, 1);
    assert.equal(app.calls.updates.length, 0);
    assert.equal(app.users[0].bijingSyncedDates[recordDate], undefined);
  } finally { releaseQuery(remoteRecordResult(recordDate, 20)); }
  assert.equal((await pending).success, true);
  assert.equal(app.calls.updates.length, 1);
});

test('each historical retry uploads the latest total and only a locally current verified total is marked synced', async () => {
  let app;
  const scenario = historicalVerificationScenario('syncRecordedDate', {
    onQuery({ attempt }, rows) {
      const remoteDuration = rows[0].duration;
      assert.equal(app.calls.updates.length, 0, 'earlier confirmations must not mark an outdated local total');
      if (attempt < 4) rows[0].duration += 10;
      return remoteRecordResult('2026-08-18', remoteDuration);
    },
  });
  app = scenario.app;
  const result = await app.run(scenario.event);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.duration, 50);
  assert.deepEqual(app.calls.posts.map(call => call.body.durationMinutes), [20, 30, 40, 50]);
  assert.equal(app.calls.queries.length, 4);
  assert.equal(app.calls.updates.length, 1);
});

test('continuous local edits exhaust historical retries without marking any outdated confirmed total', async () => {
  const { app, event, recordDate } = historicalVerificationScenario('syncRecordedDate', {
    onQuery(_query, rows) {
      const remoteDuration = rows[0].duration;
      rows[0].duration += 10;
      return remoteRecordResult('2026-08-18', remoteDuration);
    },
  });
  const result = await app.run(event);
  assert.equal(result.success, false);
  assert.deepEqual(app.calls.posts.map(call => call.body.durationMinutes), [20, 30, 40, 50]);
  assert.equal(app.calls.queries.length, 4);
  assert.equal(app.calls.updates.length, 0);
  assert.equal(app.users[0].bijingSyncedDates[recordDate], undefined);
});

test('zero-total corrections require remote zero or confirmed absence and reject remaining remote minutes', async t => {
  for (const [label, exists, durationMinutes, succeeds] of [
    ['stored zero', true, 0, true], ['absent zero', false, 0, true], ['stale nonzero', true, 20, false],
  ]) {
    await t.test(label, async () => {
      const { app, event, recordDate } = historicalVerificationScenario('syncDeletedDate', {
        records: [], queryResponse: remoteRecordResult('2026-08-18', durationMinutes, { exists }),
      });
      const result = await app.run(event);
      assert.equal(result.success, succeeds, JSON.stringify(result));
      assert.equal(app.calls.posts.length, succeeds ? 1 : 4);
      assert.equal(app.calls.queries.length, succeeds ? 1 : 4);
      assert.ok(app.calls.posts.every(call => call.body.durationMinutes === 0));
      assert.equal(app.calls.updates.length, succeeds ? 1 : 0);
      assert.equal(app.users[0].bijingSyncedDates[recordDate], succeeds ? true : undefined);
    });
  }
});

test('syncRecordedDate dispatch defers the current business day and preserves missing-account and record errors', async () => {
  const app = createHarness({ records: [{ _id: 'today', _openid: 'user-a', source: 'manual', date: '2026-09-17', duration: 20 }] });
  const today = await app.run({ type: 'syncRecordedDate', recordId: 'today' });
  assert.equal(today.success, true); assert.equal(today.data.deferred, true); assert.equal(today.data.skipped, true);
  assert.equal(app.calls.posts.length, 0); assert.equal(app.calls.bindingWrites.length, 0);
  assert.equal((await app.run({ type: 'syncRecordedDate', recordDate: '2026-09-16' })).code, 'INVALID_ARGUMENT');
  assert.equal((await app.run({ type: 'syncRecordedDate', recordId: 'deleted' })).code, 'RECORD_NOT_FOUND');
  assert.equal((await app.run({ type: 'syncRecordedDate', recordId: 'today', expectedOpenid: 'other' })).code, 'ACCOUNT_CHANGED');
  const loggedOut = createHarness({ openid: '' });
  assert.equal((await loggedOut.run({ type: 'syncRecordedDate', recordId: 'today', openid: 'user-a' })).code, 'AUTH_REQUIRED');
});

test('syncDeletedDate uses server-owned deletion evidence and replaces the remaining day total, including zero', async () => {
  const deletionId = 'md_' + '7'.repeat(64), recordDate = '2026-09-16';
  const receipts = [{ _id: deletionId, kind: 'deletion_receipt', ownerOpenid: 'user-a',
    recordId: 'deleted', date: recordDate, timestamp: Date.parse('2026-09-16T04:00:00Z') }];
  for (const duration of [0, 25]) {
    const app = createHarness({ receipts, records: [
      ...(duration ? [{ _id: 'remaining', _openid: 'user-a', source: 'manual', date: recordDate, duration }] : []),
      { _id: 'foreign', _openid: 'other', source: 'manual', date: recordDate, duration: 500 }
    ] });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.run({ type: 'syncDeletedDate', deletionId, expectedOpenid: 'user-a',
        openid: 'other', recordDate: '2000-01-01', date: '2000-01-01', durationMinutes: 999, studentNumber: 'forged' });
      assert.equal(result.success, true); assert.equal(result.data.date, recordDate); assert.equal(result.data.duration, duration);
      assert.deepEqual(app.calls.posts[attempt].body, { studentNumber: '123456', recordDate, durationMinutes: duration });
    }
    assert.equal(app.users[0].bijingSyncedDates[recordDate], true);
  }
  const rejected = createHarness({ receipts, postResponse: { success: false, message: '不支持零时长覆盖' } });
  const result = await rejected.run({ type: 'syncDeletedDate', deletionId });
  assert.equal(result.success, false); assert.match(result.error, /零时长/);
  assert.equal(rejected.calls.posts[0].body.durationMinutes, 0); assert.equal(rejected.calls.updates.length, 0);
});

test('syncDeletedDate dispatch rejects absent receipts, foreign receipts and account switches without posting', async () => {
  const deletionId = 'md_' + '8'.repeat(64);
  const app = createHarness({ receipts: [{ _id: deletionId, kind: 'deletion_receipt',
    ownerOpenid: 'other', date: '2026-09-16', recordId: 'foreign-deleted' }] });
  assert.equal((await app.run({ type: 'syncDeletedDate', deletionId })).code, 'DELETION_NOT_FOUND');
  assert.equal((await app.run({ type: 'syncDeletedDate', deletionId: 'md_' + '9'.repeat(64) })).code, 'DELETION_NOT_FOUND');
  assert.equal((await app.run({ type: 'syncDeletedDate', recordDate: '2026-09-16' })).code, 'INVALID_ARGUMENT');
  assert.equal((await app.run({ type: 'syncDeletedDate', deletionId, expectedOpenid: 'other' })).code, 'ACCOUNT_CHANGED');
  assert.equal(app.calls.posts.length, 0); assert.equal(app.calls.bindingWrites.length, 0);
});

test('authorized retreat sync covers older dates, includes all daily sessions and can retry after permission expiry', async () => {
  const requestId = 'br_' + 'b'.repeat(64);
  const recordDate = '2026-08-18';
  const app = createHarness({ now: '2026-10-05T10:00:00+08:00', requests: [{ _id: requestId,
    kind: 'request', ownerOpenid: 'user-a', status: 'approved', startDate: '2026-08-18', endDate: '2026-09-16',
    expiresAt: '2026-09-23T18:00:00.000Z' }], records: [
      { _id: 'retreat', _openid: 'user-a', source: 'manual', date: recordDate, backfillRequestId: requestId, duration: 45 },
      { _id: 'ordinary', _openid: 'user-a', source: 'manual', date: recordDate, duration: 15 },
      { _id: 'other-person', _openid: 'other', source: 'manual', date: recordDate, duration: 90 }
    ] });
  assert.equal((await app.select(recordDate)).success, false, 'ordinary seven-day window stays unchanged');
  for (let count = 0; count < 2; count++) {
    const result = await app.run({ type: 'syncBackfillDate', requestId, recordDate, expectedOpenid: 'user-a' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.duration, 60);
    assert.equal(app.calls.posts[count].body.durationMinutes, 60);
    assert.equal(app.calls.posts[count].body.studentNumber, '123456');
  }
});

test('retreat sync rejects foreign, pending, out-of-range or unwritten dates without external calls', async () => {
  const requestId = 'br_' + 'c'.repeat(64), recordDate = '2026-08-18';
  const request = { _id: requestId, kind: 'request', ownerOpenid: 'user-a', status: 'approved',
    startDate: recordDate, endDate: '2026-09-16' };
  const record = { _id: 'retreat', _openid: 'user-a', source: 'manual', date: recordDate, backfillRequestId: requestId, duration: 45 };
  for (const scenario of [
    { requests: [] }, { requests: [{ ...request, ownerOpenid: 'other' }] },
    { requests: [{ ...request, status: 'pending' }] }, { requests: [{ ...request, startDate: '2026-08-19' }] },
    { records: [] }, { records: [{ ...record, backfillRequestId: 'different' }] },
    { records: [{ ...record, _openid: 'other' }] }, { expectedOpenid: 'other' }
  ]) {
    const app = createHarness({ requests: [request], records: [record], ...scenario });
    assert.equal((await app.run({ type: 'syncBackfillDate', requestId, recordDate,
      ...(scenario.expectedOpenid ? { expectedOpenid: scenario.expectedOpenid } : {}) })).success, false);
    assert.equal(app.calls.posts.length, 0);
    assert.equal(app.calls.updates.length, 0);
  }
});

test('retreat sync reports unbound accounts and remote failures without changing saved meditation', async () => {
  const requestId = 'br_' + 'd'.repeat(64), recordDate = '2026-08-18';
  const requests = [{ _id: requestId, kind: 'request', ownerOpenid: 'user-a', status: 'approved',
    startDate: recordDate, endDate: '2026-09-16' }];
  const records = [{ _id: 'retreat', _openid: 'user-a', source: 'manual', date: recordDate, backfillRequestId: requestId, duration: 45 }];
  const unbound = createHarness({ users: [], requests, records });
  const skipped = await unbound.run({ type: 'syncBackfillDate', requestId, recordDate });
  assert.equal(skipped.success, true);
  assert.equal(skipped.data.skipped, true);
  assert.equal(skipped.data.reason, '未绑定');
  assert.equal(unbound.calls.posts.length, 0);
  const failed = createHarness({ requests, records, postResponse: { success: false, message: '历史同步暂不可用' } });
  const result = await failed.run({ type: 'syncBackfillDate', requestId, recordDate });
  assert.equal(result.success, false);
  assert.match(result.error, /历史同步/);
  assert.deepEqual(failed.records, records);
  assert.equal(failed.calls.updates.length, 0);
});

test('recorded-date evidence permits correcting deleted backfill, including an explicit zero total', async () => {
  const requestId = 'br_' + 'e'.repeat(64), recordDate = '2026-08-18';
  const requests = [{ _id: requestId, kind: 'request', ownerOpenid: 'user-a', status: 'approved',
    startDate: recordDate, endDate: '2026-09-16', recordedDates: [recordDate] }];
  for (const duration of [0, 10]) {
    const app = createHarness({ requests, records: duration ? [{ _id: 'ordinary', _openid: 'user-a',
      source: 'manual', date: recordDate, duration }] : [] });
    const result = await app.run({ type: 'syncBackfillDate', requestId, recordDate });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.duration, duration);
    assert.equal(app.calls.posts[0].body.durationMinutes, duration);
  }
  const deniedZero = createHarness({ requests, records: [], postResponse: { success: false, message: '不支持零时长覆盖' } });
  const rejected = await deniedZero.run({ type: 'syncBackfillDate', requestId, recordDate });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /零时长/);
  assert.equal(deniedZero.calls.updates.length, 0);
});

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
        const app = createHarness({ users: [{ _id: 'doc-a', _openid: 'user-a', bijingBound: false }],
          getResponse: { success: true, data: { nickname: '必经用户' } } });
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

test('the binding entrypoint requires unbind before switching and uses SDK identity for unbind', async () => {
  const app = createHarness({ users: [{ _id: 'doc-a', _openid: 'user-a', bijingBound: true,
    bijingStudentNumber: 'BJ001', bijingBindingVersion: 'current-version', bijingSyncedDates: { old: true } }] });
  assert.equal((await app.run({ type: 'bindStudentNumber', studentNumber: 'BJ002' })).code, 'UNBIND_REQUIRED');
  assert.equal(app.calls.gets.length, 0);
  assert.equal((await app.run({ type: 'unbindStudentNumber', studentNumber: 'BJ001', bindingVersion: 'stale' })).code, 'BINDING_STALE');
  assert.equal((await app.run({ type: 'unbindStudentNumber', studentNumber: 'BJ001', bindingVersion: 'current-version',
    openid: 'somebody-else', OPENID: 'somebody-else' })).success, true);
  assert.equal(app.users[0].bijingBound, false);
  assert.deepEqual(app.users[0].bijingSyncedDates, { old: true });

  const attacker = createHarness({ openid: 'outsider', users: [{ _id: 'victim', _openid: 'victim',
    bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'known-version' }] });
  assert.equal((await attacker.run({ type: 'unbindStudentNumber', studentNumber: 'BJ001', bindingVersion: 'known-version',
    OPENID: 'victim', openid: 'victim' })).code, 'BINDING_STALE');
  assert.equal(attacker.calls.updates.length, 0);
  assert.equal(attacker.calls.bindingWrites.length, 0);
});

test('personal sync selects the unique bound profile even when unbound legacy profiles come first', async () => {
  const app = createHarness({ users: [
    { _id: 'a-unbound', _openid: 'user-a', bijingBound: false },
    { _id: 'z-bound', _openid: 'user-a', bijingBound: true, bijingStudentNumber: 'BJ001' }
  ], getResponse: { success: true, data: { records: [] } } });
  assert.equal((await app.run({ type: 'getHeatmap' })).success, true);
  assert.equal(app.calls.gets[0][1].params.studentNumber, 'BJ001');
  const duplicate = createHarness({ users: [
    { _id: 'a', _openid: 'user-a', bijingBound: true, bijingStudentNumber: 'BJ001' },
    { _id: 'b', _openid: 'user-a', bijingBound: true, bijingStudentNumber: 'BJ002' }
  ] });
  assert.equal((await duplicate.run({ type: 'getHeatmap' })).success, false);
  assert.equal(duplicate.calls.gets.length, 0);
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
  assert.equal(app.calls.queries.length, 0, 'ordinary seven-day selection keeps its existing upload-only API');
  assert.equal(app.calls.posts[0].url, 'https://example.test/api/openapi/meditation/records');
  assert.deepEqual(app.calls.posts[0].config, { headers: { 'X-Access-Token': 'test-token' }, timeout: 10000 });
  assert.deepEqual(app.calls.posts[0].body, { studentNumber: '123456', recordDate: '2026-09-15', durationMinutes: 40 });
  assert.deepEqual(app.users[0].bijingSyncedDates, { '2026-09-15': true });
  assert.equal(app.syncErrors.length, 1, 'upload-only acknowledgement stays queued until remote verification');
});

test('single-user sync retains its synchronous single-record API with a batch flag present', async t => {
  for (const mode of ['manual']) {
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
          if (method === 'details') assert.equal(app.calls.now, 1);
          else assert.equal(app.syncErrors[0].recordDate, date);
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
  assert.equal(app.syncErrors.length, 7);
  assert.deepEqual(await app.run({ type: 'syncPending' }), result);
  assert.deepEqual(app.calls.posts.slice(7).map(value => value.body.recordDate), dates);
});

test('failed historical upload remains in the server repair table until a verified retry succeeds', async () => {
  let offline = true;
  const app = createHarness({ records: [{ _id: 'history', _openid: 'user-a', date: '2026-08-18', source: 'manual', duration: 20 }],
    onPost: () => { if (offline) throw new Error('temporarily unavailable'); return { success: true }; } });
  const failed = await app.run({ type: 'syncRecordedDate', recordId: 'history' });
  assert.equal(failed.success, false);
  assert.equal(app.syncErrors.length, 1);
  assert.equal(app.syncErrors[0].recordDate, '2026-08-18');
  assert.equal(app.syncErrors[0].reason, 'sync_failed');
  assert.match(app.syncErrors[0].error, /temporarily unavailable/);
  assert.match(app.syncErrors[0].queueVersion, /^[a-f0-9]{32}$/);
  assert.equal(app.syncErrors[0].retryCount, 4);
  offline = false;
  assert.equal((await app.run({ type: 'syncRecordedDate', recordId: 'history' })).success, true);
  assert.equal(app.syncErrors.length, 0);
});

test('a successful response cannot clear a newer recording transaction repair intent', async () => {
  let app;
  app = createHarness({ records: [{ _id: 'history', _openid: 'user-a', date: '2026-08-18', source: 'manual', duration: 20 }],
    onQuery: ({ body }) => {
      app.syncErrors[0].queueVersion = 'new-mutation';
      return { success: true, data: { total: 1, results: [{ index: 0, ...body.records[0], exists: true, durationMinutes: 20 }] } };
    } });
  assert.equal((await app.run({ type: 'syncRecordedDate', recordId: 'history' })).success, true);
  assert.equal(app.syncErrors.length, 1);
  assert.equal(app.syncErrors[0].queueVersion, 'new-mutation');
});

test('a late successful manual upload restores pending verification after a newer repair removed its row', async () => {
  let app, initialVersion, remoteDuration = 0;
  app = createHarness({ records: [{ _id: 'history', _openid: 'user-a', date: '2026-09-16', source: 'manual', duration: 10 }],
    onPost: ({ body }, records) => {
      initialVersion = app.syncErrors[0].queueVersion;
      // While the original request is in flight, a recording transaction adds
      // new source data and a scheduled worker repairs and clears that intent.
      records[0].duration = 20;
      Object.assign(app.syncErrors[0], { queueVersion: 'new-mutation', expectedDurationMinutes: 20 });
      remoteDuration = 20;
      app.syncErrors.splice(0);
      // The old request reaches the remote API last and succeeds with 10.
      remoteDuration = body.durationMinutes;
      return { success: true };
    } });
  const result = await app.run({ type: 'syncSelectedDate', recordDate: '2026-09-16' });
  assert.equal(result.success, true);
  assert.equal(app.calls.posts.length, 1, 'The manual entry point retains its one-request behavior');
  assert.equal(remoteDuration, 10);
  assert.equal(app.records[0].duration, 20);
  assert.equal(app.syncErrors.length, 1, 'The stale remote overwrite must remain discoverable by scheduled repair');
  const pending = app.syncErrors[0];
  assert.notEqual(pending.queueVersion, initialVersion);
  assert.notEqual(pending.queueVersion, 'new-mutation');
  assert.equal(pending.reason, 'sync_pending');
  assert.equal(pending.retryCount, 0);
  assert.equal(pending.actualDurationMinutes, null);
  assert.equal(pending.exists, null);
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
  assert.deepEqual(pages.map(page => page.offset), [0, 0, 0]);
  assert.ok(pages.slice(1).every(page => page.filter._id.op === 'gt'));
  assert.ok(pages[2].filter._id.value > pages[1].filter._id.value);
  for (const page of pages) {
    assert.equal(page.filter._openid, 'user-a');
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

test('before 02:00 manual calls reject the unfinished date and upload the latest finished day', async () => {
  const app = createHarness({ now: '2026-09-17T01:59:59.999+08:00', records: [
    { _id: 'finished', _openid: 'user-a', date: '2026-09-16', timestamp: Date.parse('2026-09-16T01:00:00+08:00'), duration: 10 },
    { _id: 'unfinished', _openid: 'user-a', date: '2026-09-17', timestamp: Date.parse('2026-09-17T01:00:00+08:00'), duration: 20 },
  ] });
  assert.equal((await app.select('2026-09-16')).success, false);
  assert.equal((await app.details('2026-09-16')).success, false);
  assert.equal(app.calls.reads.length, 0);
  const selected = await app.select('2026-09-15');
  assert.equal(selected.data.date, '2026-09-15');
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


test('record cursor does not lose the next page when an earlier historical record is deleted', async () => {
  const records = Array.from({ length: 201 }, (_, i) => ({ _id: `r${String(i).padStart(3, '0')}`, _openid: 'user-a', date: i === 0 ? '2026-09-10' : '2026-09-16', duration: 1 }));
  const app = createHarness({ records, onRead({ name, filter }, rows) {
    if (name === 'meditation_records' && filter._id && rows[0]._id === 'r000') rows.shift();
  } });
  const result = await app.details('2026-09-16');
  assert.equal(result.data.totalDuration, 200);
  assert.equal(result.data.count, 200);
});

const manualBackfillId = 'br_' + 'f'.repeat(64);
const manualBackfillGrant = (extra = {}) => ({ _id: manualBackfillId, kind: 'request', ownerOpenid: 'user-a',
  status: 'approved', startDate: '2026-08-18', endDate: '2026-09-16', expiresAt: '2026-09-17T18:00:00.000Z', ...extra });

test('manual sync lists every owned approved historical range across cursor pages, including expired grants', async () => {
  const requests = Array.from({ length: 205 }, (_, index) => manualBackfillGrant({
    _id: 'br_' + index.toString(16).padStart(64, '0'), reason: 'private application reason', recordedDates: ['2026-08-18'],
  }));
  const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [
    ...requests.slice().reverse(),
    manualBackfillGrant({ _id: 'foreign', ownerOpenid: 'another-user' }),
    manualBackfillGrant({ _id: 'pending', status: 'pending' }),
    manualBackfillGrant({ _id: 'rejected', status: 'rejected' }),
    manualBackfillGrant({ _id: 'lease', kind: 'sync_lock' }),
    manualBackfillGrant({ _id: 'invalid-id' }),
    manualBackfillGrant({ _id: 'br_' + 'a'.repeat(64), startDate: '2026-08-17' }),
    manualBackfillGrant({ _id: 'br_' + 'b'.repeat(64), startDate: '2026-09-31' }),
    manualBackfillGrant({ _id: 'br_' + 'c'.repeat(64), endDate: '2026-08-17' }),
    manualBackfillGrant({ _id: 'br_' + 'd'.repeat(64), startDate: '2026-10-01', endDate: '2026-10-06' }),
    manualBackfillGrant({ _id: 'br_' + 'e'.repeat(64), startDate: '2026-10-07', endDate: '2026-10-08' }),
  ] });
  const result = await app.run({ type: 'getBackfillSyncRanges', openid: 'another-user', ownerOpenid: 'another-user' });
  assert.deepEqual(result, { success: true, data: { ranges: requests.map(({ _id, startDate, endDate }) => ({ requestId: _id, startDate, endDate })) } });
  const pages = app.calls.reads;
  assert.equal(pages.length, 3);
  for (const page of pages) {
    assert.equal(page.name, 'backfill_requests');
    assert.equal(page.filter.ownerOpenid, 'user-a');
    assert.equal(page.filter.status, 'approved');
    assert.equal(page.filter.kind, 'request');
    assert.equal(page.maximum, 100);
    assert.deepEqual(page.order, { key: '_id', direction: 'asc' });
    assert.equal(page.fields.reason, undefined); assert.equal(page.fields.recordedDates, undefined);
  }
  assert.equal(pages[1].filter._id.op, 'gt');
  assert.ok(pages[2].filter._id.value > pages[1].filter._id.value);
  assert.equal(app.calls.now, 1); assert.equal(app.calls.posts.length, 0); assert.equal(app.calls.updates.length, 0);
});

test('backfill range listing requires login and distinguishes an absent collection from unavailable permissions', async () => {
  const loggedOut = createHarness({ openid: '' });
  assert.equal((await loggedOut.run({ type: 'getBackfillSyncRanges', openid: 'user-a' })).code, 'AUTH_REQUIRED');
  assert.equal(loggedOut.calls.reads.length, 0);
  for (const options of [{}, { backfillReadError: Object.assign(new Error('collection does not exist'), { errCode: -502005 }) }]) {
    assert.deepEqual(await createHarness(options).run({ type: 'getBackfillSyncRanges' }), { success: true, data: { ranges: [] } });
  }
  const unavailable = createHarness({ backfillReadError: new Error('permission denied') });
  const result = await unavailable.run({ type: 'getBackfillSyncRanges' });
  assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_RANGES_READ_FAILED');
});

test('backfill range listing treats a day as complete only at the Beijing 02:00 boundary', async () => {
  const requests = [manualBackfillGrant({ startDate: '2026-09-16', endDate: '2026-09-16' })];
  const before = createHarness({ now: '2026-09-17T01:59:59.999+08:00', requests });
  assert.deepEqual((await before.run({ type: 'getBackfillSyncRanges' })).data.ranges, []);
  const after = createHarness({ now: '2026-09-17T02:00:00.000+08:00', requests });
  assert.equal((await after.run({ type: 'getBackfillSyncRanges' })).data.ranges.length, 1);
});

test('approved older dates can be previewed before recording, without granting permission to post unrelated records', async () => {
  for (const records of [[], [{ _id: 'ordinary', _openid: 'user-a', source: 'manual', date: '2026-08-18', duration: 25 }]]) {
    const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [manualBackfillGrant()], records });
    const event = { recordDate: '2026-08-18', backfillRequestId: manualBackfillId };
    const preview = await app.run({ type: 'getSyncDateDetails', ...event });
    assert.equal(preview.success, true); assert.equal(preview.data.count, records.length);
    assert.equal(preview.data.totalDuration, records.length ? 25 : 0);
    assert.equal(app.calls.bindingWrites.length, 0); assert.equal(app.calls.posts.length, 0);
    const sync = await app.run({ type: 'syncSelectedDate', ...event });
    assert.equal(sync.success, false); assert.equal(sync.code, 'BACKFILL_RECORD_REQUIRED');
    assert.equal(app.calls.bindingWrites.length, 0); assert.equal(app.calls.posts.length, 0);
  }
});

test('selected older backfill dates retry after grant expiry and aggregate all owned daily records under a lease', async () => {
  const recordDate = '2026-08-18';
  const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [manualBackfillGrant()], records: [
    { _id: 'backfill', _openid: 'user-a', source: 'manual', date: recordDate, backfillRequestId: manualBackfillId, duration: 30 },
    { _id: 'ordinary', _openid: 'user-a', source: 'manual', date: recordDate, duration: 15 },
    { _id: 'foreign', _openid: 'other', source: 'manual', date: recordDate, duration: 90 },
  ] });
  const event = { recordDate, backfillRequestId: manualBackfillId };
  assert.equal((await app.run({ type: 'getSyncDateDetails', ...event })).data.totalDuration, 45);
  for (let retry = 0; retry < 2; retry++) {
    const result = await app.run({ type: 'syncSelectedDate', ...event, openid: 'forged', studentNumber: 'forged' });
    assert.equal(result.success, true); assert.equal(result.data.duration, 45);
    assert.deepEqual(app.calls.posts[retry].body, { studentNumber: '123456', recordDate, durationMinutes: 45 });
  }
  const leaseWrites = app.calls.bindingWrites.filter(write => write.data.kind === 'sync_lock');
  assert.equal(leaseWrites.length, 4); assert.equal(leaseWrites[0].data.ownerOpenid, 'user-a');
  assert.ok(leaseWrites[0].data.token); assert.equal(leaseWrites[1].data.token, '');
});

test('selected backfill date receipts permit zero-total correction after the records have been deleted', async () => {
  const recordDate = '2026-08-18';
  const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [manualBackfillGrant({ recordedDates: [recordDate] })] });
  const result = await app.run({ type: 'syncSelectedDate', recordDate, backfillRequestId: manualBackfillId });
  assert.equal(result.success, true); assert.equal(result.data.duration, 0);
  assert.equal(app.calls.posts[0].body.durationMinutes, 0);
  assert.equal(app.users[0].bijingSyncedDates[recordDate], true);
});

test('overlapping approved ranges use recorded evidence from another owned approved application', async () => {
  const recordDate = '2026-08-18', otherId = 'br_' + 'e'.repeat(64);
  const selected = manualBackfillGrant(), other = manualBackfillGrant({ _id: otherId, recordedDates: [recordDate] });
  for (const scenario of [
    { requests: [selected, other], records: [] },
    { requests: [selected, { ...other, recordedDates: [] }], records: [
      { _id: 'saved', _openid: 'user-a', source: 'manual', date: recordDate, backfillRequestId: otherId, duration: 30 },
    ] },
  ]) {
    const app = createHarness({ now: '2026-10-06T02:00:00Z', ...scenario });
    const direct = await app.run({ type: 'syncBackfillDate', requestId: manualBackfillId, recordDate });
    assert.equal(direct.code, 'BACKFILL_RECORD_REQUIRED', 'single-application sync keeps its existing authorization scope');
    const result = await app.run({ type: 'syncSelectedDate', recordDate, backfillRequestId: manualBackfillId });
    assert.equal(result.success, true); assert.equal(result.data.duration, scenario.records.length ? 30 : 0);
    assert.equal(app.calls.posts.length, 1);
  }
  for (const change of [{ ownerOpenid: 'other' }, { status: 'pending' }, { status: 'rejected' },
    { startDate: '2026-08-19' }, { recordedDates: [] }]) {
    const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [selected, { ...other, ...change }] });
    const result = await app.run({ type: 'syncSelectedDate', recordDate, backfillRequestId: manualBackfillId });
    assert.equal(result.code, 'BACKFILL_RECORD_REQUIRED'); assert.equal(app.calls.posts.length, 0);
  }
});

test('older manual previews and sync fail closed for missing, pending, rejected, foreign, malformed or out-of-range grants', async () => {
  const request = manualBackfillGrant({ recordedDates: ['2026-08-18'] });
  for (const requests of [[], [{ ...request, ownerOpenid: 'other' }], [{ ...request, status: 'pending' }],
    [{ ...request, status: 'rejected' }], [{ ...request, kind: 'sync_lock' }], [{ ...request, startDate: '2026-08-19' }],
    [{ ...request, startDate: undefined }], [{ ...request, endDate: '2026-09-31' }], [{ ...request, startDate: '2026-08-17' }]]) {
    for (const type of ['getSyncDateDetails', 'syncSelectedDate']) {
      const app = createHarness({ now: '2026-10-06T02:00:00Z', requests });
      const result = await app.run({ type, recordDate: '2026-08-18', backfillRequestId: manualBackfillId, openid: 'other' });
      assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_INVALID_GRANT');
      assert.equal(app.calls.reads.length, 0); assert.equal(app.calls.posts.length, 0); assert.equal(app.calls.bindingWrites.length, 0);
    }
  }
  for (const type of ['getSyncDateDetails', 'syncSelectedDate']) {
    const app = createHarness({ now: '2026-10-06T02:00:00Z', requests: [request] });
    for (const backfillRequestId of [undefined, 'forged', { requestId: manualBackfillId }]) {
      assert.equal((await app.run({ type, recordDate: '2026-08-18', backfillRequestId })).success, false);
    }
    for (const recordDate of ['2026-10-06', '2026-10-07', '2026-09-31']) {
      assert.equal((await app.run({ type, recordDate, backfillRequestId: manualBackfillId })).success, false);
    }
    assert.equal(app.calls.documentReads.length, 0); assert.equal(app.calls.posts.length, 0);
    const unavailable = createHarness({ requests: [request], backfillReadError: new Error('permission denied') });
    assert.equal((await unavailable.run({ type, recordDate: '2026-08-18', backfillRequestId: manualBackfillId })).code, 'BACKFILL_RANGES_READ_FAILED');
    assert.equal(unavailable.calls.posts.length, 0);
  }
});

test('the seven completed dates keep ordinary preview and sync semantics even with a stale backfill selection', async () => {
  for (const type of ['getSyncDateDetails', 'syncSelectedDate']) {
    for (const backfillRequestId of [undefined, manualBackfillId, 'invalid', { requestId: manualBackfillId }]) {
      const app = createHarness({ backfillReadError: new Error('no grant lookup should be needed'), records: [
        { _id: 'ordinary', _openid: 'user-a', source: 'manual', date: '2026-09-10', duration: 25 },
      ] });
      const result = await app.run({ type, recordDate: '2026-09-10', backfillRequestId });
      assert.equal(result.success, true);
      assert.equal(result.data[type === 'getSyncDateDetails' ? 'totalDuration' : 'duration'], 25);
      assert.equal(app.calls.documentReads.filter(call => call.name === 'backfill_requests').length, 0);
      assert.equal(app.calls.bindingWrites.length, 0);
      assert.equal(app.calls.queries.length, 0);
      if (type === 'getSyncDateDetails') assert.equal(app.calls.now, 1);
      else assert.equal(app.syncErrors[0].recordDate, '2026-09-10');
    }
  }
});
