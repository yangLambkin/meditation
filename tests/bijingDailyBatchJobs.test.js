const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatchJobs, BATCH_SIZE, CHUNK_SIZE, errorId } = require('../cloudfunctions/bijingSync/batchJobs');
const clone = value => value == null ? value : structuredClone(value);
const date = '2026-09-22';
const users = count => Array.from({ length: count }, (_, i) => ({
  _id: `u${String(i).padStart(4, '0')}`, _openid: `openid${i}`, bijingBound: true, bijingStudentNumber: `BJ${i}`, nickName: `用户${i}`,
}));
function harness(options = {}) {
  const state = { bijing_sync_runs: [], bijing_sync_days: [], bijing_sync_items: [], bijing_sync_errors: [], users: options.users || users(2) };
  let clock = options.clock ?? 1790100000000, transaction = Promise.resolve();
  const posts = [], queries = [], markers = [], requests = [], sourceReads = [], remote = new Map();
  const transactionOperations = [], leaseAcquisitions = [], checkpoints = [];
  let currentTransactionOperations = null;
  function trackTransactionOperation() { if (currentTransactionOperations !== null) currentTransactionOperations++; }
  function matches(row, filter) {
    if (filter.op === 'and') return filter.value.every(value => matches(row, value));
    if (filter.op === 'or') return filter.value.some(value => matches(row, value));
    return Object.entries(filter).every(([key, value]) => {
      if (value && value.regexp) return new RegExp(value.regexp, value.options).test(row[key]);
      if (!value || !value.op) return row[key] === value;
      if (value.op === 'gt') return row[key] > value.value;
      if (value.op === 'lt') return row[key] < value.value;
      if (value.op === 'in') return value.value.includes(row[key]);
      throw new Error(`Unsupported query operator: ${value.op}`);
    });
  }
  const db = { RegExp: value => value, command: {
    gt: value => ({ op: 'gt', value }), lt: value => ({ op: 'lt', value }), in: value => ({ op: 'in', value }),
    and: value => ({ op: 'and', value }), or: value => ({ op: 'or', value }),
  },
    collection(name) {
      assert.ok(state[name], name);
      let filter = {}, order = [], maximum = 100;
      const q = {
        where(value) { filter = value; return q; }, orderBy(key, direction) { order.push([key, direction]); return q; }, limit(value) { maximum = value; return q; },
        async get() {
          if (options.readError && name === 'users') throw new Error('scan unavailable');
          if (options.ownerReadError && name === 'users' && filter.bijingStudentNumber) throw new Error('owner lookup unavailable');
          const rows = state[name].filter(row => matches(row, filter));
          rows.sort((a, b) => { for (const [key, direction] of order) { if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (direction === 'asc' ? 1 : -1); } return 0; });
          return { data: clone(rows.slice(0, maximum)) };
        },
        doc(id) { return {
          async get() { trackTransactionOperation(); return { data: clone(state[name].find(row => row._id === id) || null) }; },
          async set({ data }) { trackTransactionOperation(); if (options.failErrorWrite && name === 'bijing_sync_errors') throw new Error('error write failed'); const i = state[name].findIndex(row => row._id === id); const row = { _id: id, ...clone(data) }; if (i < 0) state[name].push(row); else state[name][i] = row; },
          async update({ data }) {
            trackTransactionOperation();
            const row = state[name].find(row => row._id === id);
            if (!row) throw new Error('document not exist');
            if (name === 'bijing_sync_runs' && data.leaseToken && data.leaseUntil && !Object.hasOwn(data, 'total')) {
              if (options.beforeAcquire) options.beforeAcquire(clone(row));
              leaseAcquisitions.push({ runId: id, total: row.total, cursor: row.cursor, phase: row.phase });
            }
            const checkpoint = name === 'bijing_sync_runs' && Object.hasOwn(data, 'total');
            if (checkpoint && options.beforeCheckpoint) options.beforeCheckpoint(clone(row), clone(data));
            Object.assign(row, clone(data));
            if (checkpoint) checkpoints.push(clone(row));
          },
          async remove() { trackTransactionOperation(); state[name] = state[name].filter(row => row._id !== id); },
        }; },
      }; return q;
    },
    async runTransaction(fn) {
      const pending = transaction.then(async () => {
        const before = clone(state); currentTransactionOperations = 0;
        try { return await fn(db); }
        catch (error) { Object.assign(state, before); throw error; }
        finally { transactionOperations.push(currentTransactionOperations); currentTransactionOperations = null; }
      });
      transaction = pending.catch(() => {}); return pending;
    },
  };
  function writeRemote(recordDate, records) { records.forEach(record => remote.set(`${record.studentNumber}/${recordDate}`, record.durationMinutes)); }
  function ack(recordDate, records) { return { success: true, data: { recordDate, total: records.length, results: records.map((record, index) => ({ ...record, index, success: true })) } }; }
  function result(records) { return { success: true, data: { total: records.length, results: records.map((record, index) => ({
    ...record, index, exists: remote.has(`${record.studentNumber}/${record.recordDate}`), durationMinutes: remote.get(`${record.studentNumber}/${record.recordDate}`) || 0,
  })) } }; }
  const jobs = createBatchJobs({ db, now: () => clock,
    recentDates: count => {
      // A meditation day ends at 02:00 Beijing time (18:00 UTC).
      const latestEndedDate = new Date(clock - 18 * 3600000).toISOString().slice(0, 10);
      return Array.from({ length: count }, (_, i) => new Date(Date.parse(`${latestEndedDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10));
    },
    getDayDuration: async (openid, recordDate, deadline) => { sourceReads.push({ openid, recordDate, deadline, at: clock }); return options.duration ? options.duration(openid, recordDate, deadline) : 20; },
    markSynced: async (...args) => { markers.push(args); if (options.markError) throw new Error('marker failed'); if (options.mark) return options.mark(...args); },
    postBatch: async (recordDate, records) => { posts.push({ recordDate, records: clone(records) }); requests.push('post'); if (options.post) return options.post(recordDate, records, { writeRemote, ack }); writeRemote(recordDate, records); return ack(recordDate, records); },
    queryBatch: async records => { queries.push(clone(records)); requests.push('query'); return options.query ? options.query(records, result) : result(records); },
  });
  async function finish(run) {
    for (let i = 0; i < 1000 && ['running', 'interrupted'].includes(run.status); i++) {
      const before = requests.length;
      run = await jobs.processChunk(run.runId);
      assert.ok(requests.length - before <= 1, 'one bounded network request per invocation');
    }
    assert.ok(!['running', 'interrupted'].includes(run.status), 'job eventually finishes');
    assert.ok(transactionOperations.every(count => count <= 100), 'every transaction has at most 100 document operations');
    return run;
  }
  function seedError(studentNumber = 'BJ0', recordDate = date, extra = {}) {
    const user = state.users.find(row => row.bijingStudentNumber.trim().toUpperCase() === studentNumber);
    const row = { _id: errorId(studentNumber, recordDate), studentNumber, recordDate, userId: user && user._id || '', openid: user && user._openid || '',
      bindingStudentNumber: user && user.bijingStudentNumber || studentNumber, nickname: '', expectedDurationMinutes: 20, actualDurationMinutes: 0,
      exists: false, reason: 'missing', error: '远端缺少该学号当日记录', retryCount: 0, createdAt: clock, updatedAt: clock, ...extra };
    state.bijing_sync_errors.push(row); return row;
  }
  return { jobs, state, posts, queries, markers, requests, sourceReads, remote, finish, seedError, transactionOperations, leaseAcquisitions, checkpoints, advance: ms => clock += ms, now: () => clock };
}

const HOUR = 3600000;
const firstCycle = '2026-09-23';
const sourceChecks = app => app.state.bijing_sync_runs.filter(run => run.trigger === 'timer-check' && run.sourceCheck === true);
const uploads = app => app.state.bijing_sync_runs.filter(run => run.trigger === 'timer' && run.phase === 'upload');
const cycle = app => app.state.bijing_sync_days.find(row => row._id === '__daily_check_cycle__');
function atCheckTime(app, hour = 3) { app.advance(Date.parse(`${firstCycle}T${String(hour).padStart(2, '0')}:00:00+08:00`) - app.now()); }
function withinLimits(app) {
  assert.equal(BATCH_SIZE, 100);
  assert.equal(CHUNK_SIZE, 20);
  assert.ok(app.posts.every(post => post.records.length <= 100));
  assert.ok(app.queries.every(records => records.length <= 100));
  assert.ok(app.transactionOperations.every(count => count <= 100));
}

// Upload traverses users in memory. Only the independent check persists per-user
// outcomes and checkpoints; an upload's acknowledgement is not verification.
test('02:00 uploads all 1000 users without progress items and 03:00 independently checks them in ten requests', async () => {
  let app;
  const snapshots = [];
  app = harness({ users: users(1000), post: (recordDate, records, { ack, writeRemote }) => {
    snapshots.push({ items: app.state.bijing_sync_items.length, cursors: uploads(app).map(run => run.cursor), totals: uploads(app).map(run => run.total) });
    writeRemote(recordDate, records);
    app.advance(9000);
    return ack(recordDate, records);
  }, query: (records, result) => { app.advance(5000); return result(records); } });
  const uploaded = await app.jobs.timer('dailySyncBijing');
  assert.equal(uploaded.status, 'uploaded');
  assert.equal(uploaded.phase, 'upload');
  assert.equal(uploaded.total, 1000);
  assert.ok(!uploaded.cursor);
  assert.equal(app.posts.length, 10);
  assert.equal(app.queries.length, 0);
  assert.equal(app.markers.length, 0);
  assert.equal(app.state.bijing_sync_items.length, 0);
  assert.equal(app.state.bijing_sync_days.find(row => row._id === date).activeRunId, '');
  assert.ok(snapshots.every(snapshot => snapshot.items === 0 && snapshot.cursors.every(cursor => !cursor) && snapshot.totals.every(total => !total)));
  assert.ok(app.checkpoints.filter(row => row._id === uploaded.runId).length <= 1, 'upload writes only a terminal summary');
  assert.equal(app.sourceReads.length, 1000);
  assert.equal(new Set(app.posts.flatMap(post => post.records.map(record => record.studentNumber))).size, 1000);

  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.notEqual(checked.runId, uploaded.runId);
  assert.equal(checked.sourceCheck, true);
  assert.equal(checked.mode, 'full');
  assert.equal(checked.status, 'success');
  assert.equal(checked.total, 1000);
  assert.equal(checked.successCount, 1000);
  assert.equal(app.posts.length, 10);
  assert.equal(app.queries.length, 10);
  assert.equal(app.sourceReads.length, 2000, '03:00 reads every current source total again');
  assert.equal(app.state.bijing_sync_items.length, 1000);
  assert.ok(app.state.bijing_sync_items.every(item => item.runId === checked.runId));
  assert.equal(uploads(app)[0].status, 'uploaded');
  assert.equal(cycle(app).status, 'complete');
  assert.equal(app.state.bijing_sync_errors.length, 0);
  withinLimits(app);
});

for (const count of [99, 100, 101, 1000]) {
  test(`upload and independent source check cover the ${count}-user API boundary without lost or duplicate users`, async () => {
    const app = harness({ users: users(count) });
    const uploaded = await app.jobs.timer('dailySyncBijing');
    assert.equal(uploaded.status, 'uploaded');
    assert.equal(uploaded.total, count);
    assert.equal(app.state.bijing_sync_items.length, 0);
    assert.equal(app.posts.length, Math.ceil(count / BATCH_SIZE));
    atCheckTime(app);
    const checked = await app.jobs.timer('checkBijingSync');
    assert.equal(checked.status, 'success');
    assert.equal(checked.total, count);
    assert.equal(checked.successCount, count);
    assert.equal(app.queries.length, Math.ceil(count / BATCH_SIZE));
    const sent = app.posts.flatMap(post => post.records.map(record => record.studentNumber));
    const verified = app.queries.flatMap(records => records.map(record => record.studentNumber));
    assert.equal(sent.length, count);
    assert.equal(verified.length, count);
    assert.equal(new Set(sent).size, count);
    assert.deepEqual(new Set(verified), new Set(sent));
    withinLimits(app);
  });
}

test('03:00 scans and repairs all current users when the 02:00 upload never ran', async () => {
  const app = harness({ users: users(145) });
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.sourceCheck, true);
  assert.equal(checked.status, 'success');
  assert.equal(checked.total, 145);
  assert.equal(checked.successCount, 145);
  assert.equal(uploads(app).length, 0);
  assert.deepEqual(app.posts.map(post => post.records.length), [100, 45]);
  assert.deepEqual(app.queries.map(records => records.length), [100, 45, 100, 45]);
  assert.equal(app.state.bijing_sync_items.length, 145);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(cycle(app).status, 'complete');
  withinLimits(app);
});

test('an expired partial upload does not hide users from the independent check', async () => {
  const app = harness({ users: users(145) });
  const upload = await app.jobs.startDailyUpload();
  const savedUpload = uploads(app)[0];
  savedUpload.leaseToken = 'terminated-upload';
  savedUpload.leaseUntil = app.now() + 120000;
  for (let i = 0; i < 100; i++) app.remote.set(`BJ${i}/${date}`, 20);
  assert.equal(app.state.bijing_sync_items.length, 0);
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.notEqual(checked.runId, upload.runId);
  assert.equal(checked.sourceCheck, true);
  assert.equal(checked.status, 'success');
  assert.equal(checked.total, 145);
  assert.equal(checked.successCount, 145);
  assert.equal(uploads(app)[0].status, 'failed');
  assert.equal(app.posts.length, 1);
  assert.equal(app.posts[0].records.length, 45);
  assert.ok(app.posts[0].records.every(record => Number(record.studentNumber.slice(2)) >= 100));
  assert.deepEqual(app.queries.map(records => records.length), [100, 45, 45]);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  const postsBeforeOldContinuation = app.posts.length;
  assert.equal((await app.jobs.processChunk(upload.runId)).status, 'failed');
  await app.jobs.timer('resumeBijingBatches');
  assert.equal(app.posts.length, postsBeforeOldContinuation, 'the superseded upload cannot send more records');
  withinLimits(app);
});

test('source-check interruption after 40 committed users holds the lease and rechecks only the remaining 60', async () => {
  let interrupted = false;
  const app = harness({ users: users(100), beforeCheckpoint: (row, patch) => {
    if (!interrupted && row.sourceCheck && row.phase === 'verify' && row.total === 40 && patch.total === 60) {
      interrupted = true;
      const error = new Error('check worker interrupted after two committed groups');
      error.code = 'SYNC_LEASE_UNAVAILABLE';
      throw error;
    }
  } });
  await app.jobs.timer('dailySyncBijing');
  assert.equal(app.state.bijing_sync_items.length, 0);
  atCheckTime(app);
  const paused = await app.jobs.timer('checkBijingSync');
  assert.equal(paused.busy, true);
  const saved = sourceChecks(app)[0];
  assert.equal(saved.total, 40);
  assert.equal(saved.successCount, 40);
  assert.equal(saved.cursor, 'u0039');
  assert.ok(saved.leaseToken);
  assert.ok(saved.leaseUntil > app.now());
  assert.equal(app.state.bijing_sync_items.length, 40);
  assert.deepEqual(app.queries.map(records => records.length), [100]);
  const committed = app.checkpoints.filter(row => row._id === saved._id);
  assert.deepEqual(committed.map(row => row.total), [20, 40]);
  assert.ok(committed.every(row => row.leaseToken === saved.leaseToken));
  assert.equal((await app.jobs.timer('checkBijingSync')).busy, true);
  assert.equal(app.queries.length, 1);

  app.advance(saved.leaseUntil - app.now() + 1);
  const done = await app.jobs.timer('resumeBijingBatches');
  assert.equal(done.runId, saved._id);
  assert.equal(done.status, 'success');
  assert.equal(done.total, 100);
  assert.equal(done.successCount, 100);
  assert.deepEqual(app.queries.map(records => records.length), [100, 60]);
  assert.equal(app.queries[1][0].studentNumber, 'BJ40');
  assert.ok(app.queries[1].every(record => Number(record.studentNumber.slice(2)) >= 40));
  assert.equal(app.posts.length, 1, 'check recovery never repeats the upload');
  assert.equal(app.state.bijing_sync_items.length, 100);
  assert.equal(new Set(app.state.bijing_sync_items.map(item => item.studentNumber)).size, 100);
  assert.equal(sourceChecks(app)[0].leaseToken, '');
  assert.equal(cycle(app).status, 'complete');
  withinLimits(app);
});

test('successful upload acknowledgements cannot hide records still missing in the final query response', async () => {
  const app = harness({ post: (recordDate, records, { ack }) => ack(recordDate, records) });
  const uploaded = await app.jobs.timer('dailySyncBijing');
  assert.equal(uploaded.status, 'uploaded');
  assert.equal(app.state.bijing_sync_items.length, 0);
  atCheckTime(app);
  const failed = await app.jobs.timer('checkBijingSync');
  assert.equal(failed.status, 'failed');
  assert.equal(sourceChecks(app)[0].status, 'failed');
  assert.equal(sourceChecks(app)[0].failedCount, 2);
  assert.equal(app.state.bijing_sync_errors.length, 2);
  assert.ok(app.state.bijing_sync_errors.every(error => error.reason === 'missing' && error.exists === false && error.actualDurationMinutes === 0));
  assert.equal(app.markers.length, 0);
  assert.equal(app.posts.length, 3, 'initial upload plus one check retry and one bounded error repair');
  assert.equal(app.queries.length, 4);
  assert.equal(cycle(app).status, 'complete');
  const requestsBefore = app.requests.length;
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, requestsBefore);
  withinLimits(app);
});

test('a timeout after the remote upload commit is resolved by source verification without another upload', async () => {
  const app = harness({ post: (recordDate, records, { writeRemote }) => {
    writeRemote(recordDate, records);
    throw new Error('upload acknowledgement timed out');
  } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.status, 'success');
  assert.equal(checked.successCount, 2);
  assert.equal(app.posts.length, 1);
  assert.equal(app.queries.length, 1);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(app.markers.length, 2);
});

test('the independent check compares current source totals and confirms the repaired remote duration', async () => {
  let duration = 20;
  const app = harness({ duration: () => duration });
  await app.jobs.timer('dailySyncBijing');
  duration = 35;
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.status, 'success');
  assert.equal(checked.successCount, 2);
  assert.equal(app.posts.length, 2);
  assert.ok(app.posts[0].records.every(record => record.durationMinutes === 20));
  assert.ok(app.posts[1].records.every(record => record.durationMinutes === 35));
  assert.equal(app.queries.length, 2);
  assert.equal(app.remote.get(`BJ0/${date}`), 35);
  assert.equal(app.remote.get(`BJ1/${date}`), 35);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.ok(app.state.bijing_sync_items.every(item => item.actualDurationMinutes === 35));
});

test('zero-duration users are skipped and source-read failures remain repairable without inventing remote differences', async () => {
  let healthy = false;
  const app = harness({ users: users(3), duration: openid => {
    if (openid === 'openid0') return 0;
    if (openid === 'openid1' && !healthy) throw new Error('source temporarily unavailable');
    return openid === 'openid1' ? 35 : 20;
  } });
  await app.jobs.timer('dailySyncBijing');
  assert.equal(app.state.bijing_sync_items.length, 0);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  const checked = sourceChecks(app)[0];
  assert.equal(checked.total, 3);
  assert.equal(checked.skippedCount, 1);
  assert.equal(checked.successCount, 1);
  assert.equal(checked.failedCount, 1);
  assert.equal(app.state.bijing_sync_errors.length, 1);
  const sourceError = app.state.bijing_sync_errors[0];
  assert.equal(sourceError.studentNumber, 'BJ1');
  assert.equal(sourceError.reason, 'source_read_failed');
  assert.equal(sourceError.exists, null);
  assert.equal(sourceError.actualDurationMinutes, null);
  assert.ok(app.posts.flatMap(post => post.records).every(record => record.studentNumber === 'BJ2'));
  assert.ok(app.queries.flat().every(record => record.studentNumber === 'BJ2'));
  healthy = true;
  const recovered = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(recovered.status, 'success');
  assert.equal(app.remote.get(`BJ1/${date}`), 35);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.ok(app.posts.flatMap(post => post.records).every(record => record.studentNumber !== 'BJ0'));
  withinLimits(app);
});

test('a fresh zero-duration source does not erase an already confirmed positive-duration discrepancy', async () => {
  const app = harness({ users: users(1), duration: () => 0 });
  const prior = clone(app.seedError('BJ0', date, { reason: 'duration_mismatch', expectedDurationMinutes: 20, actualDurationMinutes: 5, exists: true }));
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(sourceChecks(app)[0].skippedCount, 1);
  assert.deepEqual(app.state.bijing_sync_errors, [prior]);
  assert.equal(app.posts.length, 0);
  assert.equal(app.queries.length, 0);
});

test('a busy upload lease prevents duplicate work and its expiry permits an idempotent upload restart', async () => {
  const app = harness({ users: users(145) });
  const run = await app.jobs.startDailyUpload();
  const saved = uploads(app)[0];
  saved.leaseToken = 'active-upload-worker';
  saved.leaseUntil = app.now() + 120000;
  const busy = await app.jobs.timer('dailySyncBijing');
  assert.equal(busy.runId, run.runId);
  assert.equal(busy.busy, true);
  assert.equal(app.posts.length, 0);
  assert.equal(app.state.bijing_sync_items.length, 0);
  app.advance(120001);
  const restarted = await app.jobs.timer('dailySyncBijing');
  assert.equal(restarted.status, 'uploaded');
  assert.equal(restarted.total, 145);
  assert.deepEqual(app.posts.map(post => post.records.length), [100, 45]);
  assert.equal(app.state.bijing_sync_items.length, 0);
  assert.ok(!restarted.cursor);
});

test('03:00 respects a live upload lease and starts its separate source check after the lease expires', async () => {
  const app = harness();
  const uploaded = await app.jobs.startDailyUpload();
  atCheckTime(app);
  const saved = uploads(app)[0];
  saved.leaseToken = 'still-uploading';
  saved.leaseUntil = app.now() + 120000;
  const busy = await app.jobs.timer('checkBijingSync');
  assert.equal(busy.runId, uploaded.runId);
  assert.equal(busy.busy, true);
  assert.equal(sourceChecks(app).length, 0);
  assert.equal(app.queries.length, 0);
  app.advance(120001);
  const checked = await app.jobs.timer('resumeBijingBatches');
  assert.notEqual(checked.runId, uploaded.runId);
  assert.equal(checked.sourceCheck, true);
  assert.equal(checked.status, 'success');
  assert.equal(checked.total, 2);
  assert.equal(uploads(app)[0].status, 'failed');
  assert.equal(sourceChecks(app).length, 1);
  assert.equal(cycle(app).status, 'complete');
  const postsBeforeOldContinuation = app.posts.length;
  assert.equal((await app.jobs.processChunk(uploaded.runId)).status, 'failed');
  await app.jobs.timer('resumeBijingBatches');
  assert.equal(app.posts.length, postsBeforeOldContinuation, 'the superseded upload remains terminal after the source check');
});

test('duplicate upload and check deliveries do not create runs or repeat completed HTTP work', async () => {
  const app = harness();
  const upload = await app.jobs.timer('dailySyncBijing');
  atCheckTime(app);
  const duplicateUpload = await app.jobs.timer('dailySyncBijing');
  assert.equal(duplicateUpload.runId, upload.runId);
  assert.equal(duplicateUpload.status, 'uploaded');
  assert.equal(app.posts.length, 1);
  assert.equal(app.queries.length, 0);
  assert.equal(sourceChecks(app).length, 0);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.status, 'success');
  const before = { runs: app.state.bijing_sync_runs.length, requests: app.requests.length };
  await app.jobs.timer('dailySyncBijing');
  await app.jobs.timer('checkBijingSync');
  await app.jobs.timer('resumeBijingBatches');
  assert.equal(app.state.bijing_sync_runs.length, before.runs);
  assert.equal(app.requests.length, before.requests);
  assert.equal(sourceChecks(app).length, 1);
});

test('03:00 checks only its target day and leaves historical errors available for manual repair', async () => {
  const app = harness({ users: users(1) });
  const historical = clone(app.seedError('BJ0', '2026-01-01'));
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.recordDate, date);
  assert.equal(checked.status, 'success');
  assert.ok(app.queries.flat().every(record => record.recordDate === date));
  assert.deepEqual(app.state.bijing_sync_errors, [historical]);
  const manual = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(manual.recordDate, '2026-01-01');
  assert.equal(manual.status, 'success');
  assert.equal(app.remote.get('BJ0/2026-01-01'), 20);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('a query error exits each timer call and three failures terminate the independent check without deleting evidence', async () => {
  const app = harness({ query: () => { throw new Error('check endpoint unavailable'); } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app);
  let runId;
  for (let failures = 1; failures <= 3; failures++) {
    const failed = await app.jobs.timer(failures === 1 ? 'checkBijingSync' : 'resumeBijingBatches');
    runId = runId || failed.runId;
    assert.equal(failed.runId, runId);
    assert.equal(failed.sourceCheck, true);
    assert.equal(failed.queryFailures, failures);
    assert.match(failed.error, /check endpoint unavailable/);
    assert.equal(app.queries.length, failures);
    assert.equal(failed.status, failures === 3 ? 'failed' : 'running');
  }
  await app.jobs.timer('resumeBijingBatches');
  assert.equal(app.queries.length, 3);
  assert.equal(sourceChecks(app).length, 1);
  assert.equal(app.state.bijing_sync_errors.length, 0, 'an unavailable query cannot invent remote missing rows');
  assert.equal(uploads(app)[0].status, 'uploaded');
});

test('slow success markers keep the check lease alive while committing every 20 results', async () => {
  let app;
  app = harness({ users: users(125), mark: () => { app.advance(21000); } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.status, 'success');
  assert.equal(checked.successCount, 125);
  assert.equal(checked.interruptions, 0);
  assert.deepEqual(app.queries.map(records => records.length), [100, 25]);
  const committed = app.checkpoints.filter(row => row._id === checked.runId && row.successCount > 0);
  assert.deepEqual(committed.map(row => row.successCount), [20, 40, 60, 80, 100, 120, 125]);
  assert.ok(committed.slice(0, 4).every(row => row.leaseToken));
  assert.equal(committed[4].leaseToken, '');
  assert.equal(committed.at(-1).leaseToken, '');
  assert.equal(app.markers.length, 125);
  assert.equal(new Set(app.markers.map(args => args[0])).size, 125);
  withinLimits(app);
});

test('a timer exits if its scheduler reports the same check progress repeatedly', async () => {
  const app = harness();
  const stagnant = { runId: '1790100000000_0000000000000001', recordDate: date, phase: 'verify', status: 'running', cursor: '', total: 0, successCount: 0, failedCount: 0 };
  const schedulerModule = require('../cloudfunctions/bijingSync/dailySchedule');
  const originalFactory = schedulerModule.createDailySchedule;
  let calls = 0;
  schedulerModule.createDailySchedule = () => ({ timer: async () => {
    assert.ok(++calls <= 2, 'the third identical result would be an unbounded loop');
    return clone(stagnant);
  } });
  try {
    const result = await app.jobs.timer('resumeBijingBatches');
    assert.equal(result.runId, stagnant.runId);
    assert.equal(calls, 2);
    assert.equal(app.requests.length, 0);
  } finally { schedulerModule.createDailySchedule = originalFactory; }
});

test('continuation after an interrupted upload does not retransmit it and the 03:00 source check repairs only missing users', async () => {
  const app = harness();
  const initial = await app.jobs.startDailyUpload();
  const abandoned = uploads(app)[0];
  Object.assign(abandoned, { status: 'failed', error: 'upload worker terminated', finishedAt: app.now(), leaseToken: '', leaseUntil: 0 });
  Object.assign(app.state.bijing_sync_days.find(row => row._id === date), { status: 'failed', activeRunId: '' });
  app.remote.set(`BJ0/${date}`, 20);
  const before = clone(abandoned);
  app.advance(60000);
  assert.equal(await app.jobs.timer('resumeBijingBatches'), null);
  assert.equal(await app.jobs.timer('resumeBijingBatches'), null);
  assert.equal(app.posts.length, 0);
  assert.equal(app.queries.length, 0);
  assert.equal(app.state.bijing_sync_items.length, 0);
  assert.deepEqual(uploads(app)[0], before);

  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.notEqual(checked.runId, initial.runId);
  assert.equal(checked.sourceCheck, true);
  assert.equal(checked.status, 'success');
  assert.equal(checked.total, 2);
  assert.equal(checked.successCount, 2);
  assert.deepEqual(app.posts.map(post => post.records), [[{ studentNumber: 'BJ1', durationMinutes: 20 }]]);
  assert.deepEqual(app.queries.map(records => records.length), [2, 1]);
  assert.deepEqual(uploads(app)[0], before);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  withinLimits(app);
});


test('03:00 and 04:00 create distinct hourly checks while repeated delivery within either hour is idempotent', async () => {
  let write = false;
  const app = harness({ post: (recordDate, records, { ack, writeRemote }) => {
    if (write) writeRemote(recordDate, records);
    return ack(recordDate, records);
  } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app, 3);
  const first = await app.jobs.timer('checkBijingSync');
  assert.equal(first.status, 'failed');
  const firstCheck = sourceChecks(app)[0];
  assert.equal(firstCheck.status, 'failed');
  assert.equal(firstCheck.checkCycle, `${firstCycle}T03`);
  assert.equal(cycle(app).cycleDate, firstCycle);
  assert.equal(cycle(app).cycleKey, `${firstCycle}T03`);
  assert.equal(cycle(app).status, 'complete');
  assert.equal(app.state.bijing_sync_errors.length, 2);
  const requestsAtThree = app.requests.length;
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, requestsAtThree);
  assert.equal(sourceChecks(app).length, 1);

  write = true;
  atCheckTime(app, 4);
  const recovered = await app.jobs.timer('checkBijingSync');
  assert.equal(recovered.status, 'success');
  assert.equal(recovered.sourceCheck, true);
  assert.notEqual(recovered.runId, firstCheck._id);
  assert.equal(recovered.checkCycle, `${firstCycle}T04`);
  assert.equal(recovered.recordDate, date);
  assert.equal(recovered.successCount, 2);
  assert.equal(sourceChecks(app).length, 2);
  assert.equal(cycle(app).cycleKey, `${firstCycle}T04`);
  assert.equal(app.state.bijing_sync_days.find(row => row._id === date).checkCycle, `${firstCycle}T04`);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  const requestsAtFour = app.requests.length;
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, requestsAtFour);
  assert.equal(sourceChecks(app).length, 2);
  assert.equal(uploads(app).length, 1);
  withinLimits(app);
});

test('the next hourly trigger resumes an active check and consumes that hour without opening another cycle', async () => {
  let interrupted = false;
  const app = harness({ users: users(100), beforeCheckpoint: (row, patch) => {
    if (!interrupted && row.trigger === 'timer-check' && row.total === 40 && patch.total === 60) {
      interrupted = true;
      const error = new Error('check paused with a durable cursor');
      error.code = 'SYNC_LEASE_UNAVAILABLE';
      throw error;
    }
  } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app, 3);
  const paused = await app.jobs.timer('checkBijingSync');
  assert.equal(paused.busy, true);
  assert.equal(sourceChecks(app)[0].total, 40);
  assert.equal(cycle(app).cycleKey, `${firstCycle}T03`);
  atCheckTime(app, 4);
  const continued = await app.jobs.timer('checkBijingSync');
  assert.equal(continued.runId, paused.runId);
  assert.equal(continued.checkCycle, `${firstCycle}T03`);
  assert.equal(continued.status, 'success');
  assert.equal(continued.successCount, 100);
  assert.equal(sourceChecks(app).length, 1);
  assert.equal(cycle(app).cycleKey, `${firstCycle}T03`);
  assert.equal(cycle(app).lastTriggerKey, `${firstCycle}T04`);
  assert.equal(cycle(app).status, 'complete');
  assert.deepEqual(app.queries.map(records => records.length), [100, 60]);
  const requestsAfterContinuation = app.requests.length;
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, requestsAfterContinuation);
  assert.equal(sourceChecks(app).length, 1);

  atCheckTime(app, 5);
  const next = await app.jobs.timer('checkBijingSync');
  assert.equal(next.status, 'success');
  assert.notEqual(next.runId, paused.runId);
  assert.equal(next.checkCycle, `${firstCycle}T05`);
  assert.equal(sourceChecks(app).length, 2);
  assert.equal(app.queries.length, 3);
  withinLimits(app);
});

test('the hourly trigger is inactive before 03:00 and after 10:00 and never scans historical errors', async () => {
  let duration = 20;
  const app = harness({ users: users(1), duration: () => duration });
  const historical = clone(app.seedError('BJ0', '2026-01-01'));
  const uploaded = await app.jobs.timer('dailySyncBijing');
  assert.equal(uploaded.status, 'uploaded');
  app.advance(59 * 60000);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(sourceChecks(app).length, 0);
  assert.equal(app.queries.length, 0);
  assert.equal(cycle(app), undefined);
  atCheckTime(app, 10);
  const last = await app.jobs.timer('checkBijingSync');
  assert.equal(last.status, 'success');
  assert.equal(last.recordDate, date);
  assert.equal(last.checkCycle, `${firstCycle}T10`);
  assert.equal(app.queries.length, 1);
  assert.deepEqual(app.state.bijing_sync_errors, [historical]);
  const before = { requests: app.requests.length, cycle: clone(cycle(app)), checks: sourceChecks(app).length };
  duration = 35;
  atCheckTime(app, 11);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  atCheckTime(app, 23);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, before.requests);
  assert.equal(sourceChecks(app).length, before.checks);
  assert.deepEqual(cycle(app), before.cycle);
  assert.deepEqual(app.state.bijing_sync_errors, [historical]);
  assert.equal(app.remote.get(`BJ0/${date}`), 20, 'out-of-hours calls do not apply a changed source total');
});

test('an 11:00 check trigger does not advance an unfinished 10:00 check', async () => {
  let interrupted = false;
  const app = harness({ users: users(100), beforeCheckpoint: (row, patch) => {
    if (!interrupted && row.trigger === 'timer-check' && row.total === 40 && patch.total === 60) {
      interrupted = true;
      const error = new Error('10:00 worker stopped');
      error.code = 'SYNC_LEASE_UNAVAILABLE';
      throw error;
    }
  } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app, 10);
  const paused = await app.jobs.timer('checkBijingSync');
  assert.equal(paused.busy, true);
  const saved = clone(sourceChecks(app)[0]);
  const cycleBefore = clone(cycle(app));
  const requestsBefore = app.requests.length;
  atCheckTime(app, 11);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.deepEqual(sourceChecks(app)[0], saved);
  assert.deepEqual(cycle(app), cycleBefore);
  assert.equal(app.requests.length, requestsBefore);
});
