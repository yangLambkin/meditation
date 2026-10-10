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
  const posts = [], zeros = [], queries = [], markers = [], requests = [], sourceReads = [], remote = new Map();
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
          const data = clone(rows.slice(0, maximum));
          if (name === 'users' && options.afterUsersRead) options.afterUsersRead(clone(filter), state);
          return { data };
        },
        doc(id) { return {
          async get() {
            trackTransactionOperation();
            if (options.beforeDocRead) options.beforeDocRead(name, id);
            return { data: clone(state[name].find(row => row._id === id) || null) };
          },
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
    postZero: async (recordDate, studentNumber) => {
      zeros.push({ recordDate, studentNumber }); requests.push('zero');
      if (options.zero) return options.zero(recordDate, studentNumber, { writeRemote });
      writeRemote(recordDate, [{ studentNumber, durationMinutes: 0 }]);
      return { success: true };
    },
    queryBatch: async records => { queries.push(clone(records)); requests.push('query'); return options.query ? options.query(records, result) : result(records); },
  });
  async function finish(run) {
    for (let i = 0; i < 1000 && ['running', 'interrupted'].includes(run.status); i++) {
      const before = requests.length;
      run = await jobs.processChunk(run.runId);
      assert.ok(requests.slice(before).filter(type => type !== 'zero').length <= 1, 'one bounded network request per invocation');
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
  return { jobs, state, posts, zeros, queries, markers, requests, sourceReads, remote, finish, seedError, transactionOperations, leaseAcquisitions, checkpoints, advance: ms => clock += ms, now: () => clock };
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

const coverageState = app => app.state.bijing_sync_days.find(row => row._id === '__source_check_coverage__');
const dayState = (app, recordDate) => app.state.bijing_sync_days.find(row => row._id === recordDate);

test('a completely missed scheduled day is discovered without upload logs or personal errors', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-09-24T03:00:00+08:00'),
    duration: (_, recordDate) => recordDate === date ? 35 : 0 });
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${date}`), 35);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(dayState(app, date).sourceCheckRequired, false);
  assert.ok(dayState(app, date).sourceCheckedAt);
  assert.equal(coverageState(app).nextDate, '2026-09-24');
  withinLimits(app);
});

test('long outages discover older than thirty days in bounded pages without dropping later dates', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-11-03T03:00:00+08:00'), duration: () => 0 });
  await app.jobs.timer('checkBijingSync');
  assert.equal(coverageState(app).scheduledThrough, '2026-09-28');
  assert.equal(coverageState(app).nextDate, '2026-09-29');
  for (let hour = 4; hour <= 8; hour++) {
    app.advance(HOUR);
    await app.jobs.timer('checkBijingSync');
  }
  assert.equal(coverageState(app).scheduledThrough, '2026-11-01');
  assert.equal(coverageState(app).nextDate, '2026-11-03');
  const scannedDates = new Set(app.sourceReads.map(row => row.recordDate));
  for (let timestamp = Date.parse(`${date}T00:00:00Z`); timestamp <= Date.parse('2026-11-02T00:00:00Z'); timestamp += 86400000) {
    assert.ok(scannedDates.has(new Date(timestamp).toISOString().slice(0, 10)));
  }
  withinLimits(app);
});

test('an unfinished oldest source scan cannot advance completion or block later missing dates', async () => {
  let healthy = false;
  const app = harness({ users: users(1), clock: Date.parse('2026-09-26T03:00:00+08:00'), query: (records, result) => {
    if (!healthy && records[0].recordDate === date) throw new Error('oldest date unavailable');
    return result(records);
  } });
  await app.jobs.timer('checkBijingSync');
  assert.equal(coverageState(app).nextDate, date);
  assert.equal(coverageState(app).scheduledThrough, '2026-09-24');
  assert.equal(dayState(app, date).sourceCheckedAt, undefined);
  assert.equal(app.remote.get('BJ0/2026-09-24'), 20);
  assert.equal(app.remote.get('BJ0/2026-09-25'), 20);
  healthy = true;
  app.advance(HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.equal(coverageState(app).nextDate, '2026-09-26');
});

test('an existing errors-only lease retains missing full-source work after its own repair succeeds', async () => {
  const app = harness({ users: users(1) });
  app.seedError('BJ0', date);
  const repair = await app.jobs.retryErrors('admin');
  app.advance(Date.parse('2026-09-24T03:00:00+08:00') - app.now());
  Object.assign(app.state.bijing_sync_runs.find(row => row._id === repair.runId), { leaseToken: 'existing-repair', leaseUntil: app.now() + 120000 });
  await app.jobs.timer('checkBijingSync');
  assert.equal(dayState(app, date).activeRunId, repair.runId);
  assert.equal(dayState(app, date).sourceCheckRequired, true);
  assert.equal(coverageState(app).nextDate, date);
  app.advance(HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_runs.find(row => row._id === repair.runId).status, 'success');
  assert.equal(dayState(app, date).sourceCheckRequired, true);
  app.advance(HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.ok(dayState(app, date).sourceCheckedAt);
  assert.equal(coverageState(app).nextDate, '2026-09-24');
});

test('concurrent discovery reuses the same missing-date run and day lock', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-09-24T03:00:00+08:00') });
  await Promise.all([app.jobs.timer('checkBijingSync'), app.jobs.timer('checkBijingSync')]);
  const historical = app.state.bijing_sync_runs.filter(run => run.recordDate === date && run.mode === 'full');
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, 'success');
  assert.equal(coverageState(app).nextDate, '2026-09-24');
});

test('administrator coverage repair starts a source check beyond the normal thirty-day range', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-11-03T11:00:00+08:00') });
  const run = await app.jobs.repairCoverage('admin');
  assert.equal(run.recordDate, date);
  assert.equal(run.phase, 'verify');
  assert.equal(run.operator, 'admin');
  assert.equal(app.posts.length, 0);
  await app.finish(run);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.equal(coverageState(app).nextDate, '2026-09-23');
});

test('a killed source checkpoint keeps coverage pending until its original run resumes', async () => {
  let killed = false;
  const app = harness({ users: users(1), clock: Date.parse('2026-09-24T03:00:00+08:00'), beforeCheckpoint: (run, patch) => {
    if (!killed && run.recordDate === date && patch.phase === 'retry') {
      killed = true;
      throw Object.assign(new Error('worker terminated'), { code: 'SYNC_LEASE_UNAVAILABLE' });
    }
  } });
  await app.jobs.timer('checkBijingSync');
  assert.equal(coverageState(app).nextDate, date);
  assert.equal(dayState(app, date).sourceCheckedAt, undefined);
  app.advance(HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(coverageState(app).nextDate, '2026-09-24');
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
});

test('manual completion closes an old gap and advances already checked later dates immediately', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-09-26T11:00:00+08:00') });
  for (const checkedDate of ['2026-09-23', '2026-09-24', '2026-09-25']) {
    app.state.bijing_sync_days.push({ _id: checkedDate, recordDate: checkedDate, sourceCheckedAt: app.now() - HOUR });
  }
  await app.finish(await app.jobs.repairCoverage('admin'));
  assert.equal(coverageState(app).nextDate, '2026-09-26');
  assert.equal((await app.jobs.repairCoverage('admin')).runId, '');
});

test('failure before enumerating any user cannot consume a missing-date coverage intent', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-09-24T03:00:00+08:00'), readError: true });
  await app.jobs.timer('checkBijingSync');
  assert.equal(coverageState(app).scheduledThrough, date);
  assert.equal(coverageState(app).nextDate, date);
  assert.equal(dayState(app, date).sourceCheckRequired, true);
  assert.equal(dayState(app, date).sourceCheckedAt, undefined);
  assert.equal(app.state.bijing_sync_errors.length, 0, 'run-level failures remain durable without inventing person errors');
  const run = app.state.bijing_sync_runs.find(row => row.recordDate === date);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /scan unavailable/);
});

test('manual coverage repair converts an abandoned automatic upload to source verification', async () => {
  const app = harness({ users: users(1) });
  const upload = await app.jobs.startDailyUpload();
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'killed-upload', leaseUntil: app.now() + 120000 });
  app.advance(Date.parse('2026-09-24T11:00:00+08:00') - app.now());
  const repair = await app.jobs.repairCoverage('admin');
  assert.equal(repair.runId, upload.runId);
  assert.equal(repair.phase, 'verify');
  await app.finish(repair);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
});

test('manual coverage repair recognizes completed pre-upgrade checks and selects the next real gap', async () => {
  const app = harness({ users: users(1), clock: Date.parse('2026-09-24T11:00:00+08:00') });
  await app.finish(await app.jobs.start(date, 'manual', 'admin'));
  app.state.bijing_sync_days = app.state.bijing_sync_days.filter(row => row._id !== '__source_check_coverage__');
  delete dayState(app, date).sourceCheckedAt;
  delete dayState(app, date).sourceCheckRunId;
  delete dayState(app, date).sourceCheckRequired;
  const repair = await app.jobs.repairCoverage('admin');
  assert.equal(repair.recordDate, '2026-09-23');
  assert.equal(repair.phase, 'verify');
  assert.equal(coverageState(app).nextDate, '2026-09-23');
  assert.equal(app.state.bijing_sync_runs.filter(run => run.recordDate === date).length, 1);
});

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
  assert.equal(app.sourceReads.length, 3000, '03:00 reads every source total and rechecks it before confirming success');
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

test('a fresh zero-duration source repairs a known positive remote record through the single-record endpoint', async () => {
  const app = harness({ users: users(1), duration: () => 0 });
  app.seedError('BJ0', date, { reason: 'duration_mismatch', expectedDurationMinutes: 20, actualDurationMinutes: 5, exists: true });
  app.remote.set(`BJ0/${date}`, 5);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(sourceChecks(app)[0].successCount, 1);
  assert.deepEqual(app.state.bijing_sync_errors, []);
  assert.equal(app.remote.get(`BJ0/${date}`), 0);
  assert.equal(app.posts.length, 0);
  assert.deepEqual(app.zeros, [{ recordDate: date, studentNumber: 'BJ0' }]);
  assert.equal(app.queries.length, 2);
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

test('03:00 repairs historical errors as well as independently checking the latest ended day', async () => {
  const app = harness({ users: users(1) });
  app.seedError('BJ0', '2026-01-01');
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.recordDate, date);
  assert.equal(checked.status, 'success');
  assert.deepEqual([...new Set(app.queries.flat().map(record => record.recordDate))].sort(), ['2026-01-01', date]);
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
  assert.equal(app.queries.length, 4);
  assert.equal(sourceChecks(app).length, 1);
  assert.equal(app.state.bijing_sync_errors.length, 2);
  assert.ok(app.state.bijing_sync_errors.every(row => row.reason === 'query_failed' && row.exists === null), 'query failures are pending work, not a claim of missing remote rows');
  assert.equal(uploads(app)[0].status, 'uploaded');
});

test('slow success markers shorten checkpoints so a worker can save progress before its time limit', async () => {
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
  assert.deepEqual(committed.map(row => row.successCount), Array.from({ length: 125 }, (_, i) => i + 1));
  assert.ok(committed.slice(0, 99).every(row => row.leaseToken));
  assert.equal(committed[99].leaseToken, '');
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

test('the hourly trigger repairs historical errors in the allowed window and is inactive outside it', async () => {
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
  assert.equal(app.queries.length, 3);
  assert.deepEqual(app.state.bijing_sync_errors, []);
  assert.equal(app.remote.get('BJ0/2026-01-01'), 20);
  const before = { requests: app.requests.length, cycle: clone(cycle(app)), checks: sourceChecks(app).length };
  duration = 35;
  atCheckTime(app, 11);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  atCheckTime(app, 23);
  assert.equal(await app.jobs.timer('checkBijingSync'), null);
  assert.equal(app.requests.length, before.requests);
  assert.equal(sourceChecks(app).length, before.checks);
  assert.deepEqual(cycle(app), before.cycle);
  assert.deepEqual(app.state.bijing_sync_errors, []);
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

test('zero totals are reconciled only for a known synchronization or an owned pending record', async () => {
  for (const known of [false, true]) {
    const bound = users(1);
    if (known) bound[0].bijingSyncedDates = { [date]: true };
    const app = harness({ users: bound, duration: () => 0 });
    app.remote.set(`BJ0/${date}`, 20);
    atCheckTime(app);
    await app.jobs.timer('checkBijingSync');
    assert.equal(app.zeros.length, known ? 1 : 0);
    assert.equal(app.remote.get(`BJ0/${date}`), known ? 0 : 20);
    assert.equal(app.posts.length, 0, 'the batch endpoint never receives zero');
  }
});

test('an old owner error cannot authorize zeroing records for a newly bound account', async () => {
  const app = harness({ users: users(1), duration: () => 0 });
  const previous = clone(app.seedError('BJ0', date, { userId: 'former-user', openid: 'former-openid', queueVersion: 'old-owner' }));
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.deepEqual(app.state.bijing_sync_errors, [previous]);
  assert.equal(app.zeros.length, 0);
  assert.equal(app.queries.length, 0);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
});

test('a confirmed query cannot clear a newer source mutation queued while the request was in flight', async () => {
  let app, current = 20;
  app = harness({ users: users(1), duration: () => current, query: (records, result) => {
    const response = result(records);
    current = 30;
    app.seedError('BJ0', date, { queueVersion: 'new-source-version', reason: 'sync_pending', expectedDurationMinutes: 30, exists: null, actualDurationMinutes: null });
    return response;
  } });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  run = await app.jobs.processChunk(run.runId);
  assert.equal(run.status, 'failed');
  assert.equal(app.state.bijing_sync_errors.length, 1);
  assert.equal(app.state.bijing_sync_errors[0].queueVersion, 'new-source-version');
  assert.equal(app.state.bijing_sync_errors[0].expectedDurationMinutes, 30);
});

test('query failure diagnostics cannot overwrite a newer queued source version', async () => {
  let app;
  app = harness({ users: users(1), query: () => {
    const queued = app.state.bijing_sync_errors[0];
    Object.assign(queued, { queueVersion: 'new-version', reason: 'sync_pending', expectedDurationMinutes: 35, error: 'new change' });
    throw new Error('old request timed out');
  } });
  app.seedError('BJ0', date, { queueVersion: 'old-version' });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  await app.jobs.processChunk(run.runId);
  assert.equal(app.state.bijing_sync_errors[0].queueVersion, 'new-version');
  assert.equal(app.state.bijing_sync_errors[0].reason, 'sync_pending');
  assert.equal(app.state.bijing_sync_errors[0].expectedDurationMinutes, 35);
  assert.equal(app.state.bijing_sync_errors[0].error, 'new change');
});

test('historical repairs remain queued after more than four failed hourly attempts and recover later', async () => {
  const historicalDate = '2026-01-01';
  let healthy = false;
  const app = harness({ users: users(1), post: (recordDate, records, { writeRemote, ack }) => {
    if (recordDate === historicalDate && !healthy) throw new Error('remote temporarily unavailable');
    writeRemote(recordDate, records);
    return ack(recordDate, records);
  } });
  app.seedError('BJ0', historicalDate, { queueVersion: 'pending-history' });
  for (let hour = 3; hour <= 8; hour++) {
    atCheckTime(app, hour);
    await app.jobs.timer('checkBijingSync');
    assert.ok(app.state.bijing_sync_errors.some(row => row.recordDate === historicalDate));
  }
  assert.equal(app.posts.filter(post => post.recordDate === historicalDate).length, 6);
  healthy = true;
  atCheckTime(app, 9);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${historicalDate}`), 20);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  withinLimits(app);
});

test('a 10:00 query failure is durably queued and the next day repairs its original date', async () => {
  let fail = true;
  const app = harness({ users: users(1), query: (records, result) => {
    if (fail) throw new Error('last check timed out');
    return result(records);
  } });
  await app.jobs.timer('dailySyncBijing');
  atCheckTime(app, 10);
  const failed = await app.jobs.timer('checkBijingSync');
  assert.equal(failed.status, 'running');
  assert.equal(app.state.bijing_sync_errors[0].reason, 'query_failed');
  assert.equal(app.state.bijing_sync_errors[0].exists, null);
  fail = false;
  app.advance(17 * HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_runs.find(run => run._id === failed.runId).status, 'success');
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
});

test('an interrupted historical upload with no per-person errors is recovered through source verification', async () => {
  const app = harness({ users: users(2) });
  const abandoned = await app.jobs.startDailyUpload();
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'killed-upload', leaseUntil: app.now() + 120000 });
  app.remote.set(`BJ0/${date}`, 20);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  app.advance(25 * HOUR);
  await app.jobs.timer('checkBijingSync');
  const recovered = app.state.bijing_sync_runs.find(run => run._id === abandoned.runId);
  assert.equal(recovered.status, 'success');
  assert.deepEqual(app.posts.filter(post => post.recordDate === date).flatMap(post => post.records), [{ studentNumber: 'BJ1', durationMinutes: 20 }]);
  assert.equal(app.remote.get(`BJ1/${date}`), 20);
});

test('one failing historical date does not block another and duplicate hourly delivery does not retry it', async () => {
  const brokenDate = '2026-01-01', healthyDate = '2026-01-02';
  const app = harness({ users: users(1), query: (records, result) => {
    if (records[0].recordDate === brokenDate) throw new Error('date-specific query failure');
    return result(records);
  } });
  app.seedError('BJ0', brokenDate);
  app.seedError('BJ0', healthyDate);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${healthyDate}`), 20);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.ok(app.state.bijing_sync_errors.some(row => row.recordDate === brokenDate));
  const attempts = () => app.queries.filter(records => records[0].recordDate === brokenDate).length;
  assert.equal(attempts(), 1);
  await app.jobs.timer('checkBijingSync');
  assert.equal(attempts(), 1);
  atCheckTime(app, 4);
  await app.jobs.timer('checkBijingSync');
  assert.equal(attempts(), 2);
});

test('the durable date rotation gives the latest day a turn after a historical worker stalls', async () => {
  const historicalDate = '2026-01-01';
  let releaseSource, enteredSource, observedCurrent;
  const heldSource = new Promise(resolve => { releaseSource = resolve; });
  const entered = new Promise(resolve => { enteredSource = resolve; });
  const current = new Promise(resolve => { observedCurrent = resolve; });
  const app = harness({ users: users(1), duration: async (openid, recordDate) => {
    if (recordDate === historicalDate) { enteredSource(); await heldSource; }
    return 20;
  }, query: (records, result) => {
    if (records[0].recordDate === date) observedCurrent();
    return result(records);
  } });
  app.seedError('BJ0', historicalDate);
  atCheckTime(app);
  const first = app.jobs.timer('checkBijingSync');
  await entered;
  assert.equal(app.state.bijing_sync_days.find(row => row._id === '__pending_repair_cursor__').cursor, historicalDate);
  atCheckTime(app, 4);
  const second = app.jobs.timer('checkBijingSync');
  await current;
  assert.equal(sourceChecks(app).length, 1, 'the newer invocation checks the latest day before returning to the stalled historical date');
  releaseSource();
  await Promise.all([first, second]);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
});

test('a shortened source page saves progress and does not mistake the soft time budget for end of data', async () => {
  let app;
  app = harness({ users: users(3), duration: () => { app.advance(7000); return 20; } });
  for (const user of app.state.users) app.remote.set(`${user.bijingStudentNumber}/${date}`, 20);
  atCheckTime(app);
  const checked = await app.jobs.timer('checkBijingSync');
  assert.equal(checked.status, 'success');
  assert.equal(checked.successCount, 3);
  assert.deepEqual(app.queries.map(rows => rows.length), [1, 1, 1]);
  assert.deepEqual(app.checkpoints.filter(row => row._id === checked.runId).map(row => row.total), [1, 2, 3]);
  assert.equal(app.posts.length, 0);
});

test('historical error-source reads also checkpoint short pages without losing later queued people', async () => {
  const historicalDate = '2026-01-01';
  let app;
  app = harness({ users: users(3), duration: () => { app.advance(7000); return 20; } });
  for (const user of app.state.users) app.seedError(user.bijingStudentNumber, historicalDate);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  for (const user of app.state.users) assert.equal(app.remote.get(`${user.bijingStudentNumber}/${historicalDate}`), 20);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  const run = app.state.bijing_sync_runs.find(row => row.recordDate === historicalDate);
  assert.equal(run.status, 'success');
  assert.deepEqual(app.checkpoints.filter(row => row._id === run._id && row.phase === 'upload').map(row => row.total), [1, 2]);
  withinLimits(app);
});

test('multiple pending deletions use separate zero requests and commit their retry cursors individually', async () => {
  const app = harness({ users: users(3), duration: () => 0 });
  for (const user of app.state.users) {
    app.seedError(user.bijingStudentNumber, date, { reason: 'sync_pending', queueVersion: `delete-${user._id}`, expectedDurationMinutes: 0, zeroEligible: true });
    app.remote.set(`${user.bijingStudentNumber}/${date}`, 20);
  }
  atCheckTime(app);
  const done = await app.jobs.timer('checkBijingSync');
  assert.equal(done.status, 'success');
  assert.equal(app.zeros.length, 3);
  assert.equal(app.posts.length, 0);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(app.checkpoints.filter(row => row._id === done.runId && row.phase === 'retry').length, 3);
  assert.ok(app.queries.at(-1).length === 3);
  withinLimits(app);
});

test('a source-page ownership change cannot use the old account synchronization flag to clear the new owner', async () => {
  const bound = users(1);
  bound[0].bijingSyncedDates = { [date]: true };
  let changed = false;
  const app = harness({ users: bound, duration: () => 0, afterUsersRead: (filter, state) => {
    if (!filter.bijingStudentNumber && !changed) {
      changed = true;
      state.users[0].bijingBound = false;
      state.users.push({ _id: 'new-owner', _openid: 'new-openid', bijingBound: true, bijingStudentNumber: 'BJ0' });
    }
  } });
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.sourceReads.length, 0);
  assert.equal(app.zeros.length, 0);
  assert.equal(app.posts.length, 0);
  assert.equal(app.queries.length, 0);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.equal(app.state.bijing_sync_errors[0].reason, 'binding_conflict');
});

test('a historical acknowledged upload that never received its first source check is verified on a later day', async () => {
  const app = harness({ users: users(1) });
  const uploaded = await app.jobs.timer('dailySyncBijing');
  assert.equal(uploaded.status, 'uploaded');
  app.remote.delete(`BJ0/${date}`);
  app.advance(25 * HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_runs.find(row => row._id === uploaded.runId).status, 'success');
  assert.equal(app.state.bijing_sync_runs.find(row => row._id === uploaded.runId).total, 1);
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.ok(app.queries.some(records => records[0].recordDate === date));
});

test('an upload already superseded by a completed source check is not rechecked historically', async () => {
  const app = harness({ users: users(1) });
  const uploaded = await app.jobs.timer('dailySyncBijing');
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  const priorQueries = app.queries.filter(records => records[0].recordDate === date).length;
  app.advance(24 * HOUR);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_runs.find(row => row._id === uploaded.runId).status, 'uploaded');
  assert.equal(app.queries.filter(records => records[0].recordDate === date).length, priorQueries);
});

test('resolving a binding conflict with no known source history never authorizes remote zeroing', async () => {
  const app = harness({ users: users(1), duration: () => 0 });
  app.seedError('BJ0', date, { reason: 'binding_conflict', expectedDurationMinutes: 0, actualDurationMinutes: null, exists: null, zeroEligible: false });
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.equal(app.zeros.length, 0);
  assert.equal(app.queries.length, 0);
});

test('a real deletion retains zero authorization even when an earlier source-failure diagnostic remains', async () => {
  const app = harness({ users: users(1), duration: () => 0 });
  app.seedError('BJ0', date, { reason: 'source_read_failed', queueVersion: 'new-delete', expectedDurationMinutes: 0, actualDurationMinutes: null, exists: null, zeroEligible: true });
  app.remote.set(`BJ0/${date}`, 20);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.remote.get(`BJ0/${date}`), 0);
  assert.equal(app.zeros.length, 1);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('a transient queue-version read failure persists the person for repair instead of losing a partial source run', async () => {
  let fail = true;
  const app = harness({ users: users(1), beforeDocRead: name => {
    if (name === 'bijing_sync_errors' && fail) { fail = false; throw new Error('queue version read unavailable'); }
  } });
  atCheckTime(app, 10);
  await app.jobs.timer('checkBijingSync');
  assert.equal(sourceChecks(app)[0].failedCount, 1);
  const repair = app.state.bijing_sync_runs.find(row => row.mode === 'errors');
  assert.equal(repair.status, 'success');
  assert.equal(app.remote.get(`BJ0/${date}`), 20);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('a late batch rebuilds cleared newer work as unknown pending source instead of silently losing reconciliation', async () => {
  let app, total = 20, posts = 0;
  app = harness({ users: users(20), duration: () => total, post: (recordDate, records, { writeRemote, ack }) => {
    if (++posts === 2) {
      total = 30;
      writeRemote(recordDate, records.map(row => ({ ...row, durationMinutes: 30 })));
      app.state.bijing_sync_errors = []; // A newer personal synchronization confirmed and removed its versions.
    }
    writeRemote(recordDate, records); // The older batch request commits after that confirmation.
    return ack(recordDate, records);
  } });
  for (const user of app.state.users) app.seedError(user.bijingStudentNumber, date, { queueVersion: `v1-${user._id}` });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  for (const user of app.state.users) app.remote.set(`${user.bijingStudentNumber}/${date}`, 0);
  run = await app.jobs.processChunk(run.runId);
  run = await app.jobs.processChunk(run.runId);
  run = await app.jobs.processChunk(run.runId);
  assert.equal(run.status, 'failed');
  assert.equal(app.state.bijing_sync_errors.length, 20);
  assert.ok(app.state.bijing_sync_errors.every(row => row.reason === 'source_changed' && row.expectedDurationMinutes === 0 && row.queueVersion && !row.queueVersion.startsWith('v1-')));
  withinLimits(app);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_errors.length, 0);
  for (const user of app.state.users) assert.equal(app.remote.get(`${user.bijingStudentNumber}/${date}`), 30);
});

test('success rechecks current source even when a newer pending version was created and removed between two empty queue reads', async () => {
  let app, total = 20, changed = false;
  app = harness({ users: users(1), duration: () => total, query: (records, result) => {
    const response = result(records);
    if (!changed) {
      changed = true;
      total = 30;
      app.seedError('BJ0', date, { reason: 'sync_pending', queueVersion: 'new-personal-version', expectedDurationMinutes: 30, zeroEligible: true });
      app.remote.set(`BJ0/${date}`, 30);
      app.state.bijing_sync_errors = [];
      app.remote.set(`BJ0/${date}`, 20); // Delayed older write after personal confirmation.
    }
    return response;
  } });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  run = await app.jobs.processChunk(run.runId);
  assert.equal(run.status, 'running');
  assert.equal(run.failedCount, 1);
  assert.equal(app.state.bijing_sync_errors[0].expectedDurationMinutes, 30);
  run = await app.finish(run);
  assert.equal(run.status, 'success');
  assert.equal(app.remote.get(`BJ0/${date}`), 30);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('failure to re-read source before success keeps a durable error and does not mark the person synchronized', async () => {
  let reads = 0;
  const app = harness({ users: users(1), duration: () => {
    if (++reads === 3) throw new Error('final source read unavailable');
    return 20;
  } });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  run = await app.jobs.processChunk(run.runId);
  assert.equal(run.status, 'failed');
  assert.equal(app.markers.length, 0);
  assert.equal(app.state.bijing_sync_errors[0].reason, 'source_read_failed');
  assert.match(app.state.bijing_sync_errors[0].error, /final source read unavailable/);
  atCheckTime(app);
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_errors.length, 0);
});
