const assert = require('node:assert/strict');
const test = require('node:test');
const { syncDeletedDate } = require('../cloudfunctions/bijingSync/deletedSync');
const { syncRecordedDate } = require('../cloudfunctions/bijingSync/recordedSync');

const deletionId = 'md_' + 'a'.repeat(64);
const recordDate = '2026-09-16';
const savedReceipt = (extra = {}) => ({ _id: deletionId, kind: 'deletion_receipt', ownerOpenid: 'owner',
  recordId: 'deleted-record', date: recordDate, timestamp: Date.parse('2026-09-16T04:00:00Z'), ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  const receipts = structuredClone(options.receipts || [savedReceipt()]);
  const requests = [];
  const reads = [], writes = [], posts = [], checks = [];
  let currentTime = Date.parse('2026-09-17T04:00:00Z'), total = options.total === undefined ? 30 : options.total;
  function collection(name, leaseRows = requests, inTransaction = false) {
    assert.ok(['meditation_locks', 'meditation_records', 'backfill_requests'].includes(name));
    return { doc(id) { return {
      async get() {
        reads.push({ name, id, inTransaction });
        if (name === 'meditation_locks' && options.receiptError) throw options.receiptError;
        if (name === 'backfill_requests' && options.leaseReadError) throw options.leaseReadError;
        if (name === 'meditation_locks' && options.invalidReceiptResponse) return options.invalidReceiptResponse;
        if (name === 'meditation_records') return { data: { _id: id, _openid: 'owner', date: recordDate, source: 'manual' } };
        return { data: structuredClone((name === 'meditation_locks' ? receipts : leaseRows).find(row => row._id === id) || null) };
      },
      async set({ data }) {
        assert.equal(name, 'backfill_requests'); assert.equal(inTransaction, true);
        writes.push({ id, data: structuredClone(data) });
        const previous = leaseRows.findIndex(row => row._id === id);
        if (previous >= 0) leaseRows.splice(previous, 1);
        leaseRows.push({ _id: id, ...structuredClone(data) });
      }
    }; } };
  }
  const db = { collection, async runTransaction(operation) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const before = JSON.stringify(requests), pending = structuredClone(requests);
      const result = await operation({ collection: name => collection(name, pending, true) });
      if (before !== JSON.stringify(requests)) continue;
      requests.splice(0, requests.length, ...pending);
      return result;
    }
    throw new Error('transaction conflict');
  } };
  const app = { receipts, requests, reads, writes, posts, checks,
    get now() { return currentTime; }, set now(value) { currentTime = value; },
    get total() { return total; }, set total(value) { total = value; },
    async run(overrides = {}, recorded = false) {
      const dependencies = { db, openid: 'owner', deletionId, recordId: 'remaining-record', now: () => currentTime,
        async syncDate(openid, date, options) {
          assert.equal(options.allowZero, true);
          if (app.unbound) return { skipped: true, reason: '未绑定' };
          const duration = total;
          await options.beforePost(); posts.push({ openid, date, duration });
          if (app.onPost) await app.onPost();
          return { success: true, duration };
        },
        async getDayDuration(openid, date) { checks.push({ openid, date }); return total; },
        ...overrides };
      return recorded ? syncRecordedDate(dependencies) : syncDeletedDate(dependencies);
    }
  };
  return app;
}

test('owned deletion evidence authorizes authoritative day totals including zero and repeated retries', async () => {
  for (const total of [0, 35, 80]) {
    const app = harness({ total });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.run({ date: '2000-01-01', recordDate: '2000-01-01', duration: 999,
        ownerOpenid: 'forged', recordId: 'arbitrary-missing-record' });
      assert.equal(result.success, true); assert.equal(result.data.date, recordDate); assert.equal(result.data.duration, total);
    }
    assert.deepEqual(app.posts, Array.from({ length: 2 }, () => ({ openid: 'owner', date: recordDate, duration: total })));
    assert.deepEqual(app.receipts, [savedReceipt()]);
    assert.equal(app.requests.length, 1);
  }
});

test('identity, expected account and receipt identifiers are checked before database reads', async () => {
  for (const [overrides, code] of [
    [{ openid: '' }, 'AUTH_REQUIRED'], [{ openid: null }, 'AUTH_REQUIRED'], [{ openid: ' invalid ' }, 'AUTH_REQUIRED'],
    [{ expectedOpenid: 'other' }, 'ACCOUNT_CHANGED'], [{ deletionId: undefined, recordDate }, 'INVALID_ARGUMENT'],
    [{ deletionId: 'record-id' }, 'INVALID_ARGUMENT'], [{ deletionId: { $ne: '' } }, 'INVALID_ARGUMENT'],
    [{ deletionId: '../private' }, 'INVALID_ARGUMENT']
  ]) {
    const app = harness();
    assert.equal((await app.run(overrides)).code, code);
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0); assert.equal(app.posts.length, 0);
  }
});

test('missing, foreign and non-deletion receipts cannot clear client supplied dates', async () => {
  for (const options of [{ receipts: [] }, { receipts: [savedReceipt({ ownerOpenid: 'other' })] },
    { receipts: [savedReceipt({ kind: 'lock' })] },
    { receiptError: Object.assign(new Error('document not found'), { code: 'DATABASE_DOCUMENT_NOT_EXIST' }) }]) {
    const app = harness(options);
    assert.equal((await app.run({ recordDate, date: recordDate, ownerOpenid: 'owner', duration: 0 })).code, 'DELETION_NOT_FOUND');
    assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('future and malformed receipt dates fail closed, and today waits for Beijing 02:00', async () => {
  for (const date of ['2026-09-18', '2026-09-31', 'invalid', undefined]) {
    const app = harness({ receipts: [savedReceipt({ date })] });
    assert.equal((await app.run({ recordDate })).code, 'INVALID_RECORD_DATE');
    assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
  const app = harness(); app.now = Date.parse('2026-09-16T17:59:59.999Z');
  const deferred = await app.run();
  assert.equal(deferred.success, true); assert.equal(deferred.data.deferred, true); assert.equal(deferred.data.skipped, true);
  assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  app.now++;
  assert.equal((await app.run()).success, true); assert.equal(app.posts.length, 1);
});

test('receipt read failures and malformed database responses never issue a sync', async () => {
  for (const options of [{ receiptError: new Error('network down') },
    { receiptError: Object.assign(new Error('collection meditation_locks does not exist'), { errCode: -502005 }) },
    { invalidReceiptResponse: {} }, { invalidReceiptResponse: { data: [] } }]) {
    const app = harness(options);
    assert.equal((await app.run()).code, 'DELETION_SYNC_FAILED');
    assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('unbound accounts are skipped and rejected remote zero writes remain retryable failures', async () => {
  const app = harness({ total: 0 }); app.unbound = true;
  const skipped = await app.run();
  assert.equal(skipped.success, true); assert.equal(skipped.data.skipped, true);
  assert.equal(app.posts.length, 0); assert.equal(app.checks.length, 0);
  const failed = harness({ total: 0 });
  const result = await failed.run({ async syncDate() { return { success: false, error: '不支持零时长覆盖' }; } });
  assert.equal(result.success, false); assert.match(result.error, /零时长/);
  assert.equal(failed.requests[0].token, ''); assert.deepEqual(failed.receipts, [savedReceipt()]);
  assert.equal((await failed.run()).success, true); assert.equal(failed.posts[0].duration, 0);
});

test('lease infrastructure failures describe the committed deletion while preserving specific upstream errors', async () => {
  const app = harness({ leaseReadError: new Error('network unavailable') });
  const result = await app.run();
  assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_SYNC_FAILED');
  assert.equal(result.error, '记录已删除，同步暂未完成，请稍后重试');
  assert.equal(app.posts.length, 0); assert.equal(app.writes.length, 0);
  const remote = harness();
  const rejected = await remote.run({ async syncDate() { return { success: false, error: '必经服务暂时不可用' }; } });
  assert.match(rejected.error, /必经服务暂时不可用$/);
});

test('deletion and recording share the day lease and converge after concurrent additions or deletions', async () => {
  const app = harness();
  const entered = deferred(), unblock = deferred();
  app.onPost = async () => { entered.resolve(); await unblock.promise; };
  const deletion = app.run(); await entered.promise;
  assert.equal((await app.run({}, true)).code, 'BACKFILL_SYNC_BUSY');
  assert.equal((await app.run()).code, 'BACKFILL_SYNC_BUSY');
  assert.equal(app.posts.length, 1);
  app.total = 0; unblock.resolve();
  const result = await deletion;
  assert.equal(result.success, true); assert.equal(result.data.duration, 0);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 0]);
  app.onPost = () => { app.total = 70; };
  assert.equal((await app.run()).data.duration, 70);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 0, 0, 70]);
  assert.equal(app.requests.length, 1);
});

test('repeated concurrent changes return retry status rather than marking an obsolete total complete', async () => {
  const app = harness(); app.onPost = () => { app.total++; };
  const result = await app.run();
  assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_SYNC_RETRY');
  assert.deepEqual(app.posts.map(post => post.duration), [30, 31, 32, 33]);
  app.onPost = undefined;
  assert.equal((await app.run()).data.duration, 34);
});
