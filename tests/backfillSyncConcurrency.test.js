const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { syncBackfillDate } = require('../cloudfunctions/bijingSync/backfillSync');

const REQUEST_ID = 'br_' + 'a'.repeat(64);
const RECORD_DATE = '2026-09-12';
const request = (extra = {}) => ({ _id: REQUEST_ID, kind: 'request', ownerOpenid: 'owner', status: 'approved',
  startDate: '2026-09-01', endDate: '2026-09-30', recordedDates: [RECORD_DATE, '2026-09-13'],
  expiresAt: '2026-10-07T18:00:00.000Z', ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const leaseId = (openid = 'owner', date = RECORD_DATE) => 'bs_' + crypto.createHash('sha256').update(JSON.stringify([openid, date])).digest('hex');

function harness(options = {}) {
  const rows = structuredClone(options.rows || [request()]);
  const records = structuredClone(options.records || []);
  const reads = [], writes = [], posts = [], warnings = [], checks = [], calls = [], waits = [];
  let clock = Date.parse('2026-10-09T04:00:00.000Z'), total = options.total === undefined ? 30 : options.total;
  let conflicts = 0, queryCount = 0, didWrite = false;
  function collection(name, state = rows, inTransaction = false) {
    assert.ok(['backfill_requests', 'meditation_records'].includes(name));
    return {
      where(filter) {
        assert.equal(inTransaction, false, 'lease transactions use only document operations');
        assert.equal(name, 'meditation_records');
        return { field() { return this; }, limit() { return this; }, async get() {
          queryCount++;
          return { data: structuredClone(records.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(0, 1)) };
        } };
      },
      doc(id) {
        assert.equal(name, 'backfill_requests');
        return {
          async get() {
            reads.push({ id, inTransaction });
            return { data: structuredClone(state.find(row => row._id === id) || null) };
          },
          async set({ data }) {
            assert.equal(inTransaction, true);
            if (data.kind === 'sync_lock' && data.token === '' && options.failRelease) throw new Error('release permission failure');
            writes.push({ id, data: structuredClone(data) }); didWrite = true;
            const position = state.findIndex(row => row._id === id);
            if (position >= 0) state.splice(position, 1);
            state.push({ _id: id, ...structuredClone(data) });
          }
        };
      }
    };
  }
  const db = {
    collection,
    async runTransaction(callback) {
      for (let retry = 0; retry < 6; retry++) {
        const snapshot = JSON.stringify(rows), pending = structuredClone(rows);
        const result = await callback({ collection(name) { return collection(name, pending, true); } });
        if (snapshot !== JSON.stringify(rows)) { conflicts++; continue; }
        if (options.failCommit && didWrite) throw new Error('commit failed');
        rows.splice(0, rows.length, ...pending);
        return result;
      }
      throw new Error('transaction conflict');
    }
  };
  const app = {
    rows, records, reads, writes, posts, warnings, checks, calls, waits, db,
    get conflicts() { return conflicts; }, get queryCount() { return queryCount; },
    get now() { return clock; }, set now(value) { clock = value; },
    get total() { return total; }, set total(value) { total = value; },
    async run(event = {}) {
      return syncBackfillDate({ db, openid: 'owner', requestId: REQUEST_ID, recordDate: RECORD_DATE,
        now: () => clock, logger: { warn(...args) { warnings.push(args); } },
        async sleep(ms) {
          waits.push(ms); clock += ms;
          if (options.onSleep) await options.onSleep(app);
        },
        async getDayDuration(openid, date) {
          checks.push({ openid, date });
          if (options.onRecheck) await options.onRecheck(app);
          return total;
        },
        async syncDate(openid, date, controls) {
          assert.equal(controls.allowZero, true);
          assert.equal(controls.verifyRemote, true);
          assert.ok(Number.isFinite(controls.deadlineAt));
          calls.push({ openid, date, deadlineAt: controls.deadlineAt });
          if (options.skipped) return { openid, date, skipped: true, reason: '未绑定' };
          const duration = total;
          if (options.beforePost) await options.beforePost(app, controls);
          // Mirrors the production integration: this hook must run immediately
          // before the external write, after reading the current day total.
          await controls.beforePost();
          posts.push({ openid, date, duration });
          const result = options.onPost && await options.onPost(app, controls);
          if (result !== undefined) return result;
          if (options.syncFailure) return { success: false, error: 'external failure', ...options.syncFailure };
          return { success: true, duration, openid, date };
        }, ...event });
    }
  };
  return app;
}

test('a same-day concurrent request is busy while the first lease is held and can retry after release', async () => {
  const entered = deferred(), unblock = deferred();
  const app = harness({ async onPost() { entered.resolve(); await unblock.promise; } });
  const first = app.run(); await entered.promise;
  const locked = app.rows.find(row => row.kind === 'sync_lock');
  assert.equal(locked._id, leaseId()); assert.equal(locked.leaseUntil - app.now, 90000);
  assert.match(locked.token, /^[a-f0-9]{48}$/);
  const second = await app.run();
  assert.equal(second.code, 'BACKFILL_SYNC_BUSY'); assert.equal(second.success, false); assert.equal(app.posts.length, 1);
  unblock.resolve();
  assert.equal((await first).success, true);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, '');
  assert.equal((await app.run()).success, true); assert.equal(app.posts.length, 2);
});

test('simultaneous acquisition uses transaction conflict retries to permit exactly one worker', async () => {
  const entered = deferred(), unblock = deferred();
  const app = harness({ async onPost() { entered.resolve(); await unblock.promise; } });
  const first = app.run(), second = app.run();
  await entered.promise;
  const loser = await Promise.race([first, second]);
  assert.equal(loser.code, 'BACKFILL_SYNC_BUSY'); assert.ok(app.conflicts > 0);
  assert.equal(app.posts.length, 1); unblock.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.success).length, 1);
});

test('leases are independent for separate dates and openids', async () => {
  const entered = deferred(), unblock = deferred();
  const app = harness({ rows: [request(), request({ _id: 'br_' + 'b'.repeat(64), ownerOpenid: 'second' })],
    async onPost() { entered.resolve(); await unblock.promise; } });
  const first = app.run(); await entered.promise;
  const second = app.run({ recordDate: '2026-09-13' });
  const third = app.run({ openid: 'second', requestId: 'br_' + 'b'.repeat(64) });
  unblock.resolve();
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every(result => result.success)); assert.equal(app.posts.length, 3);
  assert.equal(new Set(app.rows.filter(row => row.kind === 'sync_lock').map(row => row._id)).size, 3);
});

test('a concurrent change during POST is re-synced using the latest total before reporting success', async () => {
  const app = harness({ onPost(app) { if (app.posts.length === 1) app.total = 75; } });
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 75);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 75]);
  assert.equal(app.checks.length, 2);
});

test('continuously changing data makes at most four attempts and returns a retry result', async () => {
  const app = harness({ onPost(app) { app.total += 10; } });
  const result = await app.run();
  assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_SYNC_RETRY');
  assert.match(result.error, /重新同步/); assert.equal(app.posts.length, 4);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 40, 50, 60]);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, '');
});

test('a failed upload is retried and checked against the latest saved duration', async () => {
  const app = harness({ onPost(app) {
    if (app.posts.length === 1) return { success: false, error: 'temporary failure' };
  } });
  const started = app.now, result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 30);
  assert.equal(app.posts.length, 2); assert.equal(app.checks.length, 1);
  assert.deepEqual(app.waits, [1000]);
  assert.deepEqual(app.calls.map(call => call.deadlineAt), [started + 40000, started + 40000]);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, '');
});

test('three failed uploads allow the fourth and final upload to succeed', async () => {
  const app = harness({ onPost(app) {
    if (app.posts.length <= 3) return { success: false, error: 'temporary failure' };
  } });
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(app.posts.length, 4);
  assert.deepEqual(app.waits, [1000, 1000, 1000]);
  assert.equal(app.checks.length, 1);
});

test('returned failures and thrown errors both stop after three retries', async t => {
  for (const throws of [false, true]) {
    await t.test(throws ? 'thrown error' : 'returned failure', async () => {
      const app = harness({ onPost() {
        if (throws) throw new Error('temporary failure');
        return { success: false, error: 'temporary failure' };
      } });
      const result = await app.run();
      assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_SYNC_FAILED');
      assert.equal(app.posts.length, 4); assert.equal(app.checks.length, 0);
      assert.deepEqual(app.waits, [1000, 1000, 1000]);
      assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, '');
    });
  }
});

test('a failed attempt and a later concurrent edit share the same retry budget and use fresh totals', async () => {
  const app = harness({ onPost(app) {
    if (app.posts.length === 1) {
      app.total = 45;
      return { success: false, error: 'temporary failure' };
    }
    if (app.posts.length === 2) app.total = 65;
  } });
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 65);
  assert.deepEqual(app.posts.map(post => post.duration), [30, 45, 65]);
  assert.equal(app.checks.length, 2);
});

test('the 40-second budget stops retries while the 90-second lease is still valid', async () => {
  const app = harness({ onPost(app) {
    app.now += 40000;
    return { success: false, error: 'slow remote failure' };
  } });
  const result = await app.run();
  assert.equal(result.success, false); assert.equal(result.code, 'BACKFILL_SYNC_TIMEOUT');
  assert.equal(app.posts.length, 1); assert.equal(app.checks.length, 0);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, '');
});

test('a retry cannot POST or release a successor lease when ownership changes immediately before upload', async () => {
  const app = harness({
    beforePost(app) {
      if (app.calls.length !== 2) return;
      const lease = app.rows.find(row => row.kind === 'sync_lock');
      lease.token = 'successor'; lease.leaseUntil = app.now + 90000;
    },
    onPost() { return { success: false, error: 'temporary failure' }; }
  });
  const result = await app.run();
  assert.equal(result.code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 1);
  assert.equal(app.calls.length, 2); assert.deepEqual(app.waits, [1000]);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, 'successor');
  assert.equal(app.writes.length, 1, 'old worker does not clear a newer lease');
});

test('an expired grant with a recorded-date receipt can correct deletion to zero without a current record', async () => {
  const app = harness({ total: 0 });
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 0);
  assert.equal(app.queryCount, 0); assert.deepEqual(app.posts.map(post => post.duration), [0]);
  assert.equal(app.rows.find(row => row.kind === 'request').expiresAt < new Date(app.now).toISOString(), true);
});

test('legacy grants without receipts require a saved owned backfill record and never expand authorization', async () => {
  const grant = request({ recordedDates: undefined });
  const record = { _id: 'r1', _openid: 'owner', source: 'manual', date: RECORD_DATE, backfillRequestId: REQUEST_ID };
  const valid = harness({ rows: [grant], records: [record] });
  assert.equal((await valid.run()).success, true); assert.equal(valid.queryCount, 1);
  for (const change of [{}, { records: [{ ...record, _openid: 'other' }] },
    { records: [{ ...record, backfillRequestId: 'different' }] }]) {
    const app = harness({ rows: [grant], ...change });
    assert.equal((await app.run()).code, 'BACKFILL_RECORD_REQUIRED'); assert.equal(app.posts.length, 0);
  }
  for (const changed of [request({ ownerOpenid: 'other' }), request({ status: 'pending' }), request({ startDate: '2026-09-13' })]) {
    const app = harness({ rows: [changed] });
    assert.equal((await app.run()).code, 'BACKFILL_INVALID_GRANT'); assert.equal(app.posts.length, 0);
    assert.equal(app.writes.length, 0);
  }
});

test('the immediate pre-POST hook prevents a expired worker from posting and preserves a successor token', async () => {
  const app = harness({ beforePost(app) {
    const locked = app.rows.find(row => row.kind === 'sync_lock');
    app.now += 90000;
    locked.token = 'successor'; locked.leaseUntil = app.now + 90000;
  } });
  const result = await app.run();
  assert.equal(result.code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 0);
  assert.equal(app.rows.find(row => row.kind === 'sync_lock').token, 'successor');
  assert.equal(app.writes.length, 1, 'old worker does not clear a newer lease');
});

test('the exact 90-second expiry prevents POST while permitting a replacement request', async () => {
  const options = { beforePost(app) { app.now += 90000; } }, app = harness(options);
  assert.equal((await app.run()).code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 0);
  options.beforePost = null;
  assert.equal((await app.run()).success, true); assert.equal(app.posts.length, 1);
  assert.notEqual(app.writes[0].data.token, app.writes.findLast(write => write.data.token).data.token);
});

test('a preexisting expired lease is reclaimed but a live lease makes no external calls', async () => {
  const app = harness();
  app.rows.push({ _id: leaseId(), kind: 'sync_lock', ownerOpenid: 'owner', recordDate: RECORD_DATE,
    token: 'old-token', leaseUntil: app.now + 1 });
  assert.equal((await app.run()).code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 0);
  app.now++;
  assert.equal((await app.run()).success, true); assert.equal(app.posts.length, 1);
});

test('expiry or changing ownership after POST never returns a false stable success', async () => {
  const app = harness({ onRecheck(app) { app.now += 90000; } });
  const result = await app.run();
  assert.equal(result.code, 'BACKFILL_SYNC_BUSY'); assert.equal(app.posts.length, 1);
});

test('remote failures and unbound skips release leases and preserve the original response style', async () => {
  const failed = harness({ syncFailure: {} });
  const result = await failed.run();
  assert.equal(result.code, 'BACKFILL_SYNC_FAILED'); assert.match(result.error, /external failure/);
  assert.equal(failed.posts.length, 4);
  assert.equal(failed.rows.find(row => row.kind === 'sync_lock').token, '');
  const busy = harness({ syncFailure: { code: 'BACKFILL_SYNC_BUSY', error: 'lease expired' } });
  assert.equal((await busy.run()).code, 'BACKFILL_SYNC_BUSY');
  assert.equal(busy.calls.length, 1); assert.deepEqual(busy.waits, []);
  const unbound = harness({ skipped: true });
  const skip = await unbound.run();
  assert.equal(skip.success, true); assert.equal(skip.data.skipped, true); assert.equal(skip.data.reason, '未绑定');
  assert.equal(unbound.posts.length, 0); assert.equal(unbound.checks.length, 0);
  assert.equal(unbound.calls.length, 1); assert.deepEqual(unbound.waits, []);
  assert.equal(unbound.rows.find(row => row.kind === 'sync_lock').token, '');
});

test('lease release errors preserve a correct result, emit diagnostics and remain retryable after expiry', async () => {
  const options = { failRelease: true }, app = harness(options);
  const result = await app.run();
  assert.equal(result.success, true); assert.equal(result.data.duration, 30);
  assert.equal(app.warnings.length, 1); assert.match(app.warnings[0][0], /租约释放失败/);
  assert.equal((await app.run()).code, 'BACKFILL_SYNC_BUSY');
  options.failRelease = false; app.now += 90000;
  assert.equal((await app.run()).success, true);
});

test('failed lease commits fail closed before any external writes', async () => {
  const app = harness({ failCommit: true });
  assert.equal((await app.run()).code, 'BACKFILL_SYNC_FAILED');
  assert.equal(app.posts.length, 0); assert.equal(app.rows.filter(row => row.kind === 'sync_lock').length, 0);
});
