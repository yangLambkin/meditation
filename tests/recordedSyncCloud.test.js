const assert = require('node:assert/strict');
const test = require('node:test');
const { syncRecordedDate } = require('../cloudfunctions/bijingSync/recordedSync');
const { syncBackfillDate } = require('../cloudfunctions/bijingSync/backfillSync');

const requestId = 'br_' + 'a'.repeat(64);
const recordDate = '2026-09-12';
const savedRecord = (extra = {}) => ({ _id: 'med_legacy_12', _openid: 'owner', source: 'manual',
  date: recordDate, timestamp: Date.parse('2026-09-12T04:00:00.000Z'), duration: 30, ...extra });
const savedGrant = () => ({ _id: requestId, kind: 'request', ownerOpenid: 'owner', status: 'approved',
  startDate: '2026-09-01', endDate: '2026-09-30', recordedDates: [recordDate] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  const records = structuredClone(options.records || [savedRecord()]);
  const requests = structuredClone(options.requests || []);
  const reads = [], writes = [], posts = [], creations = [], checks = [];
  let missing = options.collectionMissing === true;
  let currentTime = Date.parse('2026-10-05T04:00:00.000Z'), total = 30;
  function collection(name, state = requests, inTransaction = false) {
    assert.ok(['meditation_records', 'backfill_requests'].includes(name));
    function readable() {
      if (name === 'meditation_records' && options.recordError) throw options.recordError;
      if (name === 'backfill_requests' && options.leaseReadError) throw options.leaseReadError;
      if (name === 'backfill_requests' && missing) throw Object.assign(new Error('collection backfill_requests does not exist'), { errCode: -502005 });
    }
    return {
      where(filter) {
        assert.equal(inTransaction, false);
        return { field() { return this; }, limit() { return this; }, async get() {
          readable();
          return { data: structuredClone(records.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(0, 1)) };
        } };
      },
      doc(id) {
        return {
          async get() {
            reads.push({ name, id, inTransaction }); readable();
            if (name === 'meditation_records' && options.invalidRecordResponse) return options.invalidRecordResponse;
            const row = (name === 'meditation_records' ? records : state).find(item => item._id === id);
            return { data: structuredClone(row || null) };
          },
          async set({ data }) {
            assert.equal(name, 'backfill_requests'); assert.equal(inTransaction, true); readable();
            writes.push({ id, data: structuredClone(data) });
            const previous = state.findIndex(row => row._id === id);
            if (previous !== -1) state.splice(previous, 1);
            state.push({ _id: id, ...structuredClone(data) });
          }
        };
      }
    };
  }
  const db = {
    collection,
    async createCollection(name) {
      assert.equal(name, 'backfill_requests'); creations.push(name);
      if (options.creationError) {
        if (options.createdByOther) missing = false;
        throw options.creationError;
      }
      if (!options.creationDoesNothing) missing = false;
    },
    async runTransaction(operation) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const before = JSON.stringify(requests), pending = structuredClone(requests);
        const result = await operation({ collection: name => collection(name, pending, true) });
        if (before !== JSON.stringify(requests)) continue;
        requests.splice(0, requests.length, ...pending);
        return result;
      }
      throw new Error('transaction conflict');
    }
  };
  const app = { records, requests, reads, writes, posts, checks, creations, db,
    get now() { return currentTime; }, set now(value) { currentTime = value; },
    get total() { return total; }, set total(value) { total = value; },
    async call(type, overrides = {}) {
      const dependencies = { db, openid: 'owner', recordId: 'med_legacy_12', requestId, recordDate,
        now: () => currentTime,
        async syncDate(openid, date, options) {
          assert.equal(options.allowZero, true);
          if (app.unbound) return { openid, date, skipped: true, reason: '未绑定' };
          const duration = total;
          await options.beforePost(); posts.push({ openid, date, duration });
          if (app.onPost) await app.onPost();
          return { success: true, duration, date };
        },
        async getDayDuration(openid, date) { checks.push({ openid, date }); return total; },
        ...overrides };
      return type === 'backfill' ? syncBackfillDate(dependencies) : syncRecordedDate(dependencies);
    },
    run(overrides) { return this.call('recorded', overrides); }
  };
  return app;
}

test('saved manual, timer and backfill records sync historical dates without a grant or seven-day limit', async () => {
  for (const source of ['manual', 'timer', 'legacy']) {
    const app = harness({ records: [savedRecord({ source, ...(source === 'manual' ? { backfillRequestId: requestId } : {}) })] });
    const result = await app.run({ recordDate: '2026-10-04', date: '2026-10-04', source: 'manual', ownerOpenid: 'victim' });
    assert.equal(result.success, true); assert.equal(result.data.date, recordDate);
    assert.deepEqual(app.posts, [{ openid: 'owner', date: recordDate, duration: 30 }]);
    assert.equal(app.reads.filter(read => read.name === 'backfill_requests' && read.id.startsWith('br_')).length, 0);
  }
});

test('manual dates and timer timestamps use the same business date as saved-record aggregation', async () => {
  for (const [record, expected] of [
    [savedRecord({ source: 'manual', date: '2026-09-10', timestamp: Date.parse('2026-09-12T04:00:00Z') }), '2026-09-10'],
    [savedRecord({ source: 'timer', dateSource: 'manual', date: '2026-09-10' }), '2026-09-10'],
    [savedRecord({ source: 'timer', date: '2026-09-14', timestamp: Date.parse('2026-09-12T17:59:59.999Z') }), '2026-09-12'],
    [savedRecord({ source: 'timer', timestamp: '2026-09-12T18:00:00.000Z' }), '2026-09-13'],
    [savedRecord({ source: 'timer', timestamp: String(Date.parse('2026-09-12T18:00:00Z')) }), '2026-09-13'],
    [savedRecord({ source: 'timer', timestamp: new Date('2026-09-12T18:00:00Z') }), '2026-09-13'],
    [savedRecord({ source: 'legacy', timestamp: null, date: '2026-09-09' }), '2026-09-09']
  ]) {
    const app = harness({ records: [record] });
    const result = await app.run();
    assert.equal(result.success, true); assert.equal(result.data.date, expected); assert.equal(app.posts[0].date, expected);
  }
});

test('today is deferred until the precise Beijing 02:00 boundary without acquiring a lease or posting', async () => {
  const app = harness({ records: [savedRecord({ date: '2026-10-04' })], collectionMissing: true });
  app.now = Date.parse('2026-10-04T17:59:59.999Z');
  const today = await app.run();
  assert.equal(today.success, true); assert.equal(today.data.skipped, true); assert.equal(today.data.deferred, true);
  assert.equal(today.data.date, '2026-10-04'); assert.equal(app.creations.length, 0); assert.equal(app.posts.length, 0);
  assert.equal(app.reads.length, 1);
  app.now++;
  assert.equal((await app.run()).success, true); assert.equal(app.posts.length, 1);
  assert.deepEqual(app.creations, ['backfill_requests']);
});

test('future or malformed stored dates cannot be repaired with a client-supplied date', async () => {
  for (const record of [savedRecord({ date: '2026-10-06' }),
    savedRecord({ source: 'timer', timestamp: null, date: '2026-09-31' }),
    savedRecord({ source: 'timer', timestamp: Date.parse('2026-10-06T04:00:00Z') })]) {
    const app = harness({ records: [record] });
    assert.equal((await app.run({ date: recordDate, recordDate })).code, 'INVALID_RECORD_DATE');
    assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('missing, deleted and foreign records return RECORD_NOT_FOUND without authorization leakage', async () => {
  for (const options of [{ records: [] }, { records: [savedRecord({ _openid: 'other' })] },
    { recordError: Object.assign(new Error('document not found'), { code: 'DATABASE_DOCUMENT_NOT_EXIST' }) }]) {
    const app = harness(options);
    const result = await app.run({ ownerOpenid: 'owner', recordDate });
    assert.equal(result.code, 'RECORD_NOT_FOUND'); assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
  const app = harness();
  app.records.length = 0;
  assert.equal((await app.run()).code, 'RECORD_NOT_FOUND');
});

test('trusted identity, expected account and record ID are validated before database reads', async () => {
  for (const [event, code] of [
    [{ openid: '' }, 'AUTH_REQUIRED'], [{ openid: null }, 'AUTH_REQUIRED'], [{ openid: ' invalid ' }, 'AUTH_REQUIRED'],
    [{ expectedOpenid: 'other' }, 'ACCOUNT_CHANGED'], [{ recordId: undefined, recordDate }, 'INVALID_ARGUMENT'],
    [{ recordId: '../private' }, 'INVALID_ARGUMENT'], [{ recordId: { $ne: '' } }, 'INVALID_ARGUMENT'],
    [{ recordId: 'x'.repeat(129) }, 'INVALID_ARGUMENT']
  ]) {
    const app = harness();
    assert.equal((await app.run(event)).code, code);
    assert.equal(app.reads.length, 0); assert.equal(app.posts.length, 0);
  }
});

test('unbound accounts retain a skipped result and do not perform external writes', async () => {
  const app = harness(); app.unbound = true;
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.skipped, true); assert.equal(result.data.reason, '未绑定');
  assert.equal(app.posts.length, 0); assert.equal(app.checks.length, 0);
});

test('first ordinary sync initializes only an explicitly missing empty lease collection', async () => {
  const app = harness({ collectionMissing: true });
  assert.equal((await app.run()).success, true);
  assert.deepEqual(app.creations, ['backfill_requests']);
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].kind, 'sync_lock');
  assert.equal((await app.run()).success, true); assert.equal(app.creations.length, 1);
  const race = harness({ collectionMissing: true, createdByOther: true,
    creationError: new Error('collection backfill_requests already exists') });
  assert.equal((await race.run()).success, true); assert.equal(race.posts.length, 1);
});

test('unknown lock failures never create a collection; failed creation or unreadable creation never posts', async () => {
  for (const leaseReadError of [new Error('permission denied'), Object.assign(new Error('request failed'), { errCode: -502001 })]) {
    const app = harness({ leaseReadError });
    assert.equal((await app.run()).code, 'BACKFILL_SYNC_FAILED'); assert.equal(app.creations.length, 0);
    assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
  for (const options of [{ collectionMissing: true, creationError: new Error('permission denied') },
    { collectionMissing: true, creationDoesNothing: true }]) {
    const app = harness(options);
    assert.equal((await app.run()).code, 'BACKFILL_SYNC_FAILED'); assert.equal(app.posts.length, 0);
  }
});

test('record reads fail closed on infrastructure errors and malformed responses', async () => {
  for (const options of [{ recordError: new Error('network down') },
    { recordError: Object.assign(new Error('collection meditation_records does not exist'), { errCode: -502005 }) },
    { invalidRecordResponse: {} }, { invalidRecordResponse: { data: [] } }]) {
    const app = harness(options);
    assert.equal((await app.run()).code, 'RECORD_SYNC_FAILED'); assert.equal(app.posts.length, 0);
    assert.equal(app.creations.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('ordinary automatic and backfill retry paths share a single account/day lease', async () => {
  const app = harness({ requests: [savedGrant()] });
  const entered = deferred(), unblock = deferred();
  app.onPost = async () => { entered.resolve(); await unblock.promise; };
  const ordinary = app.run(); await entered.promise;
  const otherPath = await app.call('backfill');
  assert.equal(otherPath.code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 1);
  unblock.resolve(); assert.equal((await ordinary).success, true);
  assert.equal((await app.call('backfill')).success, true); assert.equal(app.posts.length, 2);
  assert.equal(app.requests.filter(row => row.kind === 'sync_lock').length, 1);
});

test('ordinary sync uses the same total verification and can correct a concurrent deletion to zero', async () => {
  const app = harness();
  app.onPost = () => { app.records.length = 0; app.total = 0; };
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 0);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 0]);
  assert.equal(app.checks.length, 2);
  assert.equal((await app.run()).code, 'RECORD_NOT_FOUND');
});
