const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let now = Date.parse(options.now || '2026-09-20T12:00:00+08:00');
  let openid = options.openid === undefined ? 'owner' : options.openid;
  let state = { meditation_records: clone(options.records || []), user_stats: clone(options.stats || []), experience_records: [], meditation_locks: [], backfill_requests: clone(options.requests || []) };
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
    module, exports: module.exports, Date: Clock, process: { env: { MAINTENANCE_ADMIN_OPENIDS: options.adminOpenid || '', MAINTENANCE_ENV_ID: 'test-env' } }, console: { log() {}, error() {}, warn() {} },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/meditationManager/maintenanceAuth');
      if (name === './backfill') return require('../cloudfunctions/meditationManager/backfill');
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => database, getWXContext: () => ({ OPENID: openid, ENV: 'test-env' }) };
    }
  });
  return {
    get records() { return clone(state.meditation_records); },
    get stats() { return clone(state.user_stats); },
    get experiences() { return clone(state.experience_records); },
    get requests() { return clone(state.backfill_requests); },
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

test('explicit legacy recovery acknowledges an existing cloud record without duplicating duration or replacing experience', async () => {
  const timestamp = Date.parse('2026-09-20T00:35:00+08:00');
  for (const storedTimestamp of [timestamp, String(timestamp), '2026-09-20T00:35:00+08:00']) {
    const app = harness({ records: [{ _id: 'old-cloud', _openid: 'owner', date: '2026-09-20',
      timestamp: storedTimestamp, duration: 45, experience: [{ text: '原始心得' }] }],
    stats: [{ _id: 'stats', _openid: 'owner', totalCount: 1, totalDuration: 45 }] });
    const before = { records: app.records, stats: app.stats };
    const result = await app.record({ recoverLegacy: true, localId: 'old-local', timestamp, duration: 45,
      expectedOpenid: 'owner', experience: [{ text: '本机心得' }] });
    assert.equal(result.success, true);
    assert.equal(result.data.recordId, 'old-cloud');
    assert.equal(result.data.date, '2026-09-19');
    assert.equal(result.data.duplicate, true);
    assert.equal(result.data.autoSyncBijing, true, 'acknowledging a saved historical record should retry its day sync');
    assert.deepEqual({ records: app.records, stats: app.stats }, before);
  }
});

test('explicit recovery of a missing legacy record remains idempotent across concurrent attempts', async () => {
  const app = harness({ now: '2026-09-21T10:15:00+08:00' });
  const data = { recoverLegacy: true, localId: 'september-19-local',
    timestamp: Date.parse('2026-09-19T08:35:00+08:00'), duration: 45 };
  const results = await Promise.all(Array.from({ length: 5 }, () => app.record(data)));
  assert.ok(results.every(result => result.success));
  assert.equal(new Set(results.map(result => result.data.recordId)).size, 1);
  assert.equal(app.records.length, 1);
  assert.equal(app.stats[0].totalCount, 1);
  assert.equal(app.stats[0].totalDuration, 45);
});

test('legacy recovery refuses ambiguous cloud matches without writing records or statistics', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  const app = harness({ records: ['first', 'second'].map(_id => ({
    _id, _openid: 'owner', timestamp, date: '2026-09-19', duration: 45
  })) });
  const before = { records: app.records, stats: app.stats };
  const result = await app.record({ recoverLegacy: true, localId: 'old-local', timestamp, duration: 45 });
  assert.equal(result.success, false);
  assert.equal(result.code, 'AMBIGUOUS_RECORD');
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
});

test('ordinary uploads still keep a new identity separate from old cloud records at the same time', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  for (const cloudIdentity of [{}, { localId: 'other-local' }, { idempotencyKey: 'other-key' }]) {
    const app = harness({ records: [{ _id: 'old-cloud', _openid: 'owner', timestamp,
      date: '2026-09-19', duration: 45, ...cloudIdentity }] });
    const result = await app.record({ localId: 'new-local', timestamp, duration: 45 });
    assert.equal(result.success, true);
    assert.equal(result.data.duplicate, false);
    assert.notEqual(result.data.recordId, 'old-cloud');
    assert.equal(app.records.length, 2);
    assert.equal(app.stats[0].totalCount, 2);
    assert.equal(app.stats[0].totalDuration, 90);
  }
});

test('explicit recovery cannot recreate or absorb an exact cloud match with a different identity', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  for (const cloudIdentity of [{ localId: 'other-local' }, { idempotencyKey: 'other-key' }]) {
    const app = harness({ records: [{ _id: 'old-cloud', _openid: 'owner', timestamp,
      date: '2026-09-19', duration: 45, ...cloudIdentity }] });
    const before = { records: app.records, stats: app.stats };
    const result = await app.record({ recoverLegacy: true, localId: 'new-local', timestamp, duration: 45 });
    assert.equal(result.success, false);
    assert.equal(result.code, 'AMBIGUOUS_RECORD');
    assert.match(result.error, /核对/);
    assert.deepEqual({ records: app.records, stats: app.stats }, before);
  }
});

test('an unkeyed exact match beside a differently keyed exact match remains ambiguous', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  const app = harness({ records: [
    { _id: 'unkeyed-cloud', _openid: 'owner', timestamp, date: '2026-09-19', duration: 45 },
    { _id: 'keyed-cloud', _openid: 'owner', timestamp, date: '2026-09-19', duration: 45, localId: 'original-key' }
  ] });
  const before = { records: app.records, stats: app.stats };
  const ambiguous = await app.record({ recoverLegacy: true, localId: 'recovered-local', timestamp, duration: 45 });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_RECORD');
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
  // A known identity still confirms its own record even beside identical legacy rows.
  const identified = await app.record({ recoverLegacy: true, localId: 'original-key', timestamp, duration: 45 });
  assert.equal(identified.success, true);
  assert.equal(identified.data.recordId, 'keyed-cloud');
  assert.equal(identified.data.duplicate, true);
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
});

test('pre-September legacy uploads with server-generated timestamps cannot be counted twice', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  // The July client sent no timestamp: its local save time and the server's
  // upload time differed, and delayed background uploads could differ by hours.
  for (const delay of [1, 500, 60000, 12 * 3600000]) {
    const app = harness({ records: [{ _id: 'july-client-cloud-record', _openid: 'owner',
      timestamp: new Date(timestamp + delay).toISOString(), date: '2026-09-19', duration: 45 }],
    stats: [{ _id: 'stats', _openid: 'owner', totalCount: 1, totalDuration: 45 }] });
    const before = { records: app.records, stats: app.stats };
    const result = await app.record({ recoverLegacy: true, localId: 'recovered-local', timestamp, duration: 45 });
    assert.equal(result.success, false);
    assert.equal(result.code, 'AMBIGUOUS_RECORD');
    assert.match(result.error, /核对/);
    assert.deepEqual({ records: app.records, stats: app.stats }, before);
  }
});

test('legacy recovery does not conflate a different account, duration or business date', async () => {
  const timestamp = Date.parse('2026-09-19T08:35:00+08:00');
  for (const mismatch of [{ _openid: 'another-owner' }, { duration: 44 },
    { source: 'manual', date: '2026-09-18' }]) {
    const app = harness({ records: [{ _id: 'different-record', _openid: 'owner', timestamp,
      date: '2026-09-19', duration: 45, ...mismatch }] });
    const result = await app.record({ recoverLegacy: true, localId: 'old-local', timestamp, duration: 45 });
    assert.equal(result.success, true);
    assert.equal(result.data.duplicate, false);
    assert.notEqual(result.data.recordId, 'different-record');
    assert.equal(app.records.length, 2);
  }
});

test('legacy recovery needs a stable identity and rejects account changes before any writes', async () => {
  const app = harness();
  assert.equal((await app.record({ recoverLegacy: true, duration: 45 })).code, 'INVALID_RECORD');
  assert.equal((await app.record({ recoverLegacy: true, localId: 'old-local', duration: 45,
    expectedOpenid: 'another-owner' })).code, 'ACCOUNT_CHANGED');
  assert.equal(app.records.length, 0);
  assert.equal(app.stats.length, 0);
});

test('legacy manual recovery acknowledges existing old records but cannot bypass the backfill window for missing records', async () => {
  const timestamp = Date.parse('2026-09-01T08:35:00+08:00');
  const data = { recoverLegacy: true, localId: 'old-local', timestamp, duration: 45,
    dateSource: 'manual', date: '2026-09-01' };
  const existing = harness({ records: [{ _id: 'old-cloud', _openid: 'owner', timestamp,
    duration: 45, dateSource: 'manual', date: '2026-09-01' }] });
  const result = await existing.record(data);
  assert.equal(result.success, true);
  assert.equal(result.data.recordId, 'old-cloud');
  assert.equal(result.data.duplicate, true);
  const missing = harness();
  assert.equal((await missing.record(data)).code, 'DATE_OUT_OF_RANGE');
  assert.equal(missing.records.length, 0);
  assert.equal(missing.stats.length, 0);
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

const backfillId = 'br_' + 'a'.repeat(64);
function backfillGrant(extra = {}) {
  return { _id: backfillId, kind: 'request', ownerOpenid: 'owner', status: 'approved',
    startDate: '2026-08-20', endDate: '2026-09-18', expiresAt: '2026-09-25T18:00:00.000Z', ...extra };
}
function backfillRecord(extra = {}) {
  return { source: 'manual', backfillRequestId: backfillId, idempotencyKey: 'retreat-session',
    date: '2026-08-20', timestamp: Date.parse('2026-08-20T08:00:00+08:00'), duration: 30, ...extra };
}

test('confirmed historical manual, approved backfill and delayed timer uploads request automatic day sync, including retries', async () => {
  const scenarios = [
    { options: {}, data: { localId: 'historical-manual', source: 'manual', date: '2026-09-19', duration: 20 }, date: '2026-09-19' },
    { options: { requests: [backfillGrant()] }, data: backfillRecord(), date: '2026-08-20' },
    { options: {}, data: { localId: 'offline-timer', source: 'timer', timestamp: Date.parse('2026-08-01T01:30:00+08:00'), duration: 25 }, date: '2026-07-31' }
  ];
  for (const scenario of scenarios) {
    const app = harness(scenario.options);
    const first = await app.record(scenario.data);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.data.date, scenario.date);
    assert.equal(first.data.autoSyncBijing, true);
    assert.equal(first.data.duplicate, false);
    assert.equal(Object.hasOwn(app.records[0], 'autoSyncBijing'), false, 'the sync instruction belongs to the confirmation response');
    app.setNow('2026-10-05T12:00:00+08:00');
    const retry = await app.record(scenario.data);
    assert.equal(retry.success, true, JSON.stringify(retry));
    assert.equal(retry.data.recordId, first.data.recordId);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.autoSyncBijing, true, 'a lost sync response can be retried even beyond the recording/grant window');
    assert.equal(app.records.length, 1);
    assert.equal(app.stats[0].totalCount, 1);
  }
});

test('current-day manual and timer confirmations omit automatic sync even when a client asks for it', async () => {
  for (const source of ['manual', 'timer']) {
    const app = harness();
    const data = { localId: `today-${source}`, source, date: '2026-09-20', duration: 20, autoSyncBijing: true };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.record(data);
      assert.equal(result.success, true);
      assert.equal(result.data.date, '2026-09-20');
      assert.equal(result.data.duplicate, attempt > 0);
      assert.equal(Object.hasOwn(result.data, 'autoSyncBijing'), false);
      assert.equal(Object.hasOwn(result, 'autoSyncBijing'), false);
    }
    assert.equal(app.records.length, 1);
  }
});

test('automatic sync eligibility changes exactly at Beijing 02:00 using the confirmed record business date', async () => {
  const app = harness({ now: '2026-10-01T01:59:59+08:00' });
  const data = { localId: 'near-cutover', source: 'timer', timestamp: Date.parse('2026-10-01T01:59:30+08:00'), duration: 10 };
  const before = await app.record(data);
  assert.equal(before.success, true); assert.equal(before.data.date, '2026-09-30');
  assert.equal(Object.hasOwn(before.data, 'autoSyncBijing'), false);
  const sameDayRetry = await app.record(data);
  assert.equal(sameDayRetry.data.duplicate, true);
  assert.equal(Object.hasOwn(sameDayRetry.data, 'autoSyncBijing'), false);
  app.setNow('2026-10-01T02:00:00+08:00');
  const after = await app.record(data);
  assert.equal(after.data.recordId, before.data.recordId);
  assert.equal(after.data.duplicate, true); assert.equal(after.data.autoSyncBijing, true);
  assert.equal(after.data.date, '2026-09-30');
  const current = await app.record({ localId: 'new-business-day', source: 'timer', duration: 10 });
  assert.equal(current.data.date, '2026-10-01'); assert.equal(Object.hasOwn(current.data, 'autoSyncBijing'), false);
  const previous = await app.record({ localId: 'previous-manual-day', source: 'manual', date: '2026-09-30', duration: 15 });
  assert.equal(previous.data.autoSyncBijing, true);
});

test('failed historical writes never request automatic sync or leave committed records, but successful retries do', async () => {
  for (const failure of ['failStats', 'failCommit']) {
    for (const data of [{ localId: 'historical-failure', source: 'manual', date: '2026-09-19', duration: 20 }, backfillRecord()]) {
      const options = { [failure]: true, requests: [backfillGrant()] }, app = harness(options);
      const failed = await app.record(data);
      assert.equal(failed.success, false);
      assert.equal(Object.hasOwn(failed, 'autoSyncBijing'), false);
      assert.equal(Object.hasOwn(failed.data || {}, 'autoSyncBijing'), false);
      assert.equal(app.records.length, 0); assert.equal(app.stats.length, 0);
      assert.equal(app.requests[0].recordedDates, undefined);
      options[failure] = false;
      const retried = await app.record(data);
      assert.equal(retried.success, true); assert.equal(retried.data.autoSyncBijing, true);
      assert.equal(app.records.length, 1); assert.equal(app.stats[0].totalCount, 1);
    }
  }
});

test('approved backfill updates its original month and preserves provenance, with expired retries counted once', async () => {
  const app = harness({ requests: [backfillGrant()] });
  const data = backfillRecord();
  const results = await Promise.all(Array.from({ length: 5 }, () => app.record(data)));
  assert.ok(results.every(result => result.success), JSON.stringify(results));
  assert.equal(app.records.length, 1);
  assert.equal(app.records[0].source, 'manual');
  assert.equal(app.records[0].backfillRequestId, backfillId);
  assert.equal(app.records[0].recordType, 'backfill');
  assert.deepEqual(app.requests[0].recordedDates, ['2026-08-20']);
  assert.equal(app.stats[0].monthlyStats['2026-08'].totalDuration, 30);
  assert.equal(app.stats[0].totalCount, 1);
  app.setNow('2026-10-05T12:00:00+08:00');
  assert.equal((await app.record(data)).data.duplicate, true);
  assert.equal((await app.record(backfillRecord({ idempotencyKey: 'new-session' }))).code, 'BACKFILL_EXPIRED');
  assert.equal(app.records.length, 1);
});

test('backfill requires ownership, approval and a selected date within the grant', async () => {
  for (const grant of [null, backfillGrant({ ownerOpenid: 'other' }),
    backfillGrant({ status: 'pending' }), backfillGrant({ status: 'rejected' }),
    backfillGrant({ startDate: '2026-08-12', endDate: '2026-09-10' }),
    backfillGrant({ startDate: '2026-08-21' })]) {
    const app = harness({ requests: grant ? [grant] : [] });
    assert.equal((await app.record(backfillRecord())).success, false);
    assert.equal(app.records.length, 0);
    assert.equal(app.stats.length, 0);
  }
});

test('historical single-session achievements remain recoverable after leaving the recording page', async () => {
  const app = harness({ requests: [backfillGrant()], records: [{ _id: 'latest-short', _openid: 'owner',
    date: '2026-09-20', source: 'manual', timestamp: Date.parse('2026-09-20T08:00:00+08:00'), duration: 5 }] });
  assert.equal((await app.record(backfillRecord())).success, true);
  const stats = (await app.call({ type: 'getUserStats' })).data;
  assert.equal(stats.lastCheckinDuration, 5);
  assert.equal(stats.maxSingleDuration, 30);
});

test('backfill cannot disguise its source, mismatch date and time, reuse a changed payload or duplicate a prior record', async () => {
  const app = harness({ requests: [backfillGrant()] });
  for (const extra of [{ source: 'timer' }, { backfillRequestId: '' }, { idempotencyKey: '' },
    { timestamp: Date.parse('2026-08-21T02:00:00+08:00') }]) {
    assert.equal((await app.record(backfillRecord(extra))).code, 'BACKFILL_INVALID_RECORD');
  }
  assert.equal((await app.record(backfillRecord())).success, true);
  assert.equal((await app.record(backfillRecord({ duration: 31 }))).code, 'REQUEST_ID_REUSED');
  assert.equal((await app.record(backfillRecord({ idempotencyKey: 'second-form' }))).code, 'BACKFILL_DUPLICATE');
  assert.equal(app.records.length, 1);
});

test('backfill daily cap counts existing sessions and is enforced across concurrent submissions', async () => {
  const app = harness({ requests: [backfillGrant()], records: [{ _id: 'old', _openid: 'owner',
    date: '2026-08-20', source: 'manual', timestamp: Date.parse('2026-08-20T06:00:00+08:00'), duration: 1400 }] });
  const results = await Promise.all([8, 9].map(hour => app.record(backfillRecord({
    idempotencyKey: `session-${hour}`, timestamp: Date.parse(`2026-08-20T0${hour}:00:00+08:00`), duration: 30
  }))));
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.filter(result => result.code === 'DAILY_DURATION_EXCEEDED').length, 1);
  assert.equal(app.stats[0].totalDuration, 1430);
});

test('backfill respects the 02:00 deadline and leaves no record when statistics fail', async () => {
  const options = { requests: [backfillGrant()], now: '2026-09-26T01:59:59+08:00', failStats: true };
  const app = harness(options);
  assert.equal((await app.record(backfillRecord())).success, false);
  assert.equal(app.records.length, 0);
  assert.equal(app.requests[0].recordedDates, undefined, 'sync evidence rolls back with the record');
  options.failStats = false;
  assert.equal((await app.record(backfillRecord())).success, true);
  app.setNow('2026-09-26T02:00:00+08:00');
  assert.equal((await app.record(backfillRecord({ idempotencyKey: 'after-cutoff' }))).code, 'BACKFILL_EXPIRED');
});

test('new backfill grants expire exactly 72 hours after approval and keep confirmed retries idempotent', async () => {
  const grant = backfillGrant({ ruleVersion: 2, createdAt: '2026-09-19T03:00:00.000Z',
    handledAt: '2026-09-19T04:00:00.123Z', expiresAt: '2026-09-22T04:00:00.123Z' });
  const options = { requests: [grant], now: '2026-09-22T04:00:00.122Z', failStats: true };
  const app = harness(options), data = backfillRecord();
  assert.equal((await app.record(data)).success, false);
  assert.equal(app.records.length, 0); assert.equal(app.requests[0].recordedDates, undefined);
  options.failStats = false;
  const saved = await app.record(data);
  assert.equal(saved.success, true); assert.equal(saved.data.duplicate, false);
  assert.equal(saved.data.date, grant.startDate, 'the submitted range stays fixed after another business day starts');
  app.setNow(grant.expiresAt);
  assert.equal((await app.record(backfillRecord({ idempotencyKey: 'after-72-hours' }))).code, 'BACKFILL_EXPIRED');
  const retry = await app.record(data);
  assert.equal(retry.success, true); assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.recordId, saved.data.recordId); assert.equal(app.records.length, 1);
  assert.equal(app.stats[0].totalCount, 1);
  assert.equal((await app.record(backfillRecord({ duration: 31 }))).code, 'REQUEST_ID_REUSED');
});

test('new pending applications and approved applications without a deadline cannot create records', async () => {
  for (const extra of [{ status: 'pending', expiresAt: null }, { status: 'approved', expiresAt: null },
    { status: 'approved', expiresAt: undefined }, { status: 'approved', expiresAt: 'invalid' }]) {
    const app = harness({ requests: [backfillGrant({ ruleVersion: 2, ...extra })] });
    const result = await app.record(backfillRecord());
    assert.equal(result.code, extra.status === 'pending' ? 'BACKFILL_INVALID_GRANT' : 'BACKFILL_EXPIRED');
    assert.equal(app.records.length, 0); assert.equal(app.stats.length, 0);
  }
});

test('maintenance defaults to dry run, preserves explicit dates and only merges stable duplicate identities', async () => {
  const timestamp = Date.parse('2026-09-20T00:30:00+08:00');
  const app = harness({ openid: 'operator', adminOpenid: 'operator', records: [
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
  const applied = await app.call({ type: 'migrateBusinessDates', dryRun: false, scope: 'all', targetEnv: 'test-env' });
  assert.equal(applied.data.dryRun, false);
  assert.equal(app.records.length, 4);
  assert.equal(app.records.find(record => record._id === 'a').date, '2026-09-19');
  assert.equal(app.records.find(record => record._id === 'a').experience.length, 2);
  assert.equal(app.records.find(record => record._id === 'd').date, '2026-09-18');
  assert.equal(app.stats[0].totalCount, 4);
  assert.equal(app.stats[0].totalDuration, 40);
  assert.equal(app.stats[0].totalDays, 2);
  await app.call({ type: 'migrateBusinessDates', dryRun: false, scope: 'all', targetEnv: 'test-env' });
  assert.equal(app.records.length, 4);
  assert.equal(app.stats[0].totalCount, 4);
  app.setOpenid('owner');
  assert.equal((await app.call({ type: 'migrateBusinessDates', dryRun: false, scope: 'all', targetEnv: 'test-env' })).success, false);
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
  const app = harness({ openid: 'operator', adminOpenid: 'operator', now: '2027-01-07T01:59:59+08:00', records,
    stats: [{ _id: 'stats', _openid: 'owner', badges: { 'continuous-7': { unlockTime: '2027-01-07' } } }] });
  const before = { records: app.records, stats: app.stats };
  const report = await app.call({ type: 'recomputeUserBadges', mode: 'report', openid: 'owner' });
  assert.equal(report.success, true);
  assert.equal(report.data.details[0].longestRun, 6);
  assert.deepEqual(report.data.details[0].removed, ['continuous-7']);
  assert.deepEqual({ records: app.records, stats: app.stats }, before);
});
