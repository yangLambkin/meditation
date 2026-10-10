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
  let clock = 1790110800000, transaction = Promise.resolve();
  const posts = [], zeros = [], queries = [], markers = [], requests = [], transactions = [], remote = new Map();
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
          const rows = state[name].filter(row => matches(row, filter));
          rows.sort((a, b) => { for (const [key, direction] of order) { if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (direction === 'asc' ? 1 : -1); } return 0; });
          return { data: clone(rows.slice(0, maximum)) };
        },
        doc(id) { return {
          async get() { return { data: clone(state[name].find(row => row._id === id) || null) }; },
          async set({ data }) { if (options.failErrorWrite && name === 'bijing_sync_errors') throw new Error('error write failed'); const i = state[name].findIndex(row => row._id === id); const row = { _id: id, ...clone(data) }; if (i < 0) state[name].push(row); else state[name][i] = row; },
          async update({ data }) { const row = state[name].find(row => row._id === id); if (!row) throw new Error('document not exist'); Object.assign(row, clone(data)); },
          async remove() { state[name] = state[name].filter(row => row._id !== id); },
        }; },
      }; return q;
    },
    async runTransaction(fn) {
      const pending = transaction.then(async () => {
        const before = clone(state), trace = { operations: 0, itemWrites: 0 };
        const tx = { ...db, collection(name) {
          const collection = db.collection(name);
          return { ...collection, doc(id) {
            const document = collection.doc(id);
            return Object.fromEntries(Object.entries(document).map(([method, operation]) => [method, async (...args) => {
              trace.operations++;
              if (name === 'bijing_sync_items' && method === 'set') trace.itemWrites++;
              return operation(...args);
            }]));
          } };
        } };
        try {
          const result = await fn(tx);
          transactions.push({ ...trace, run: clone(state.bijing_sync_runs[0] || null) });
          return result;
        } catch (error) { Object.assign(state, before); throw error; }
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
    recentDates: count => Array.from({ length: count }, (_, i) => new Date(Date.parse(`${date}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10)),
    getDayDuration: async (openid, recordDate, deadline) => options.duration ? options.duration(openid, recordDate, deadline) : 20,
    markSynced: async (...args) => { markers.push(args); if (options.markError) throw new Error('marker failed'); if (options.mark) await options.mark(...args); },
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
      const fullUpload = run.mode !== 'errors' && (!run.phase || run.phase === 'upload');
      run = await jobs.processChunk(run.runId);
      if (!fullUpload) {
        assert.ok(requests.slice(before).filter(type => type !== 'zero').length <= 1, 'verification and repair process one bounded request per invocation');
      }
    }
    assert.ok(!['running', 'interrupted'].includes(run.status), 'job eventually finishes');
    return run;
  }
  function seedError(studentNumber = 'BJ0', recordDate = date, extra = {}) {
    const user = state.users.find(row => row.bijingStudentNumber.trim().toUpperCase() === studentNumber);
    const row = { _id: errorId(studentNumber, recordDate), studentNumber, recordDate, userId: user && user._id || '', openid: user && user._openid || '',
      bindingStudentNumber: user && user.bijingStudentNumber || studentNumber, nickname: '', expectedDurationMinutes: 20, actualDurationMinutes: 0,
      exists: false, reason: 'missing', error: '远端缺少该学号当日记录', retryCount: 0, createdAt: clock, updatedAt: clock, ...extra };
    state.bijing_sync_errors.push(row); return row;
  }
  return { jobs, state, posts, zeros, queries, markers, requests, transactions, remote, finish, seedError, now: () => clock, advance: ms => clock += ms };
}

test('upload stores no per-person progress before source verification confirms actual remote records', async () => {
  const app = harness({ users: users(45) });
  let run = await app.jobs.start(date, 'manual', 'admin');
  assert.equal(run.trigger, 'manual'); assert.equal(run.operator, 'admin');
  app.advance(1000); run = await app.jobs.processChunk(run.runId);
  assert.equal(app.queries.length, 0); assert.equal(run.successCount, 0);
  assert.equal(run.total, 0); assert.equal(run.uploadSummary.total, 45);
  assert.equal(run.phase, 'verify'); assert.equal(app.markers.length, 0);
  assert.equal(run.cursor, ''); assert.equal(run.sourceCheck, true);
  assert.equal(app.state.bijing_sync_items.length, 0);
  assert.ok(app.transactions.every(tx => tx.itemWrites === 0));
  run = await app.finish(run);
  assert.equal(run.status, 'success'); assert.equal(run.successCount, 45); assert.equal(run.durationMs, 1000);
  assert.deepEqual(app.posts.map(p => p.records.length), [45]);
  assert.deepEqual(app.queries.map(records => records.length), [45]);
  assert.equal(app.state.bijing_sync_items.length, 45); assert.equal(app.state.bijing_sync_errors.length, 0);
  await app.jobs.processChunk(run.runId); assert.equal(app.posts.length, 1);
});

test('each upload entry point sends all users in real 100-record requests without saving upload cursors', async () => {
  for (const process of ['processChunk', 'processBatch']) {
    const app = harness({ users: users(150) });
    let run = await app.jobs.start(date, 'manual');
    run = await app.jobs[process](run.runId);
    assert.equal(run.total, 0); assert.equal(run.uploadSummary.total, 150);
    assert.equal(run.phase, 'verify'); assert.equal(run.cursor, '');
    assert.deepEqual(app.posts.map(post => post.records.length), [100, 50]);
    assert.equal(app.queries.length, 0);
    assert.equal(app.state.bijing_sync_items.length, 0);
    assert.ok(app.transactions.every(tx => tx.itemWrites === 0 && !tx.run.cursor));
    run = await app.finish(run);
    assert.equal(run.status, 'success'); assert.equal(run.successCount, 150);
    assert.deepEqual(app.queries.map(records => records.length), [100, 50]);
    assert.equal(new Set(app.posts.flatMap(post => post.records.map(row => row.studentNumber))).size, 150);
  }
});

test('one 100-person source-verification response saves progress in bounded transactions under one lease', async () => {
  const app = harness({ users: users(100) });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId);
  assert.deepEqual(app.posts.map(post => post.records.length), [100]);
  assert.equal(app.state.bijing_sync_items.length, 0);
  run = await app.jobs.processChunk(run.runId);
  const checkCommits = app.transactions.filter(tx => tx.itemWrites);
  assert.deepEqual(checkCommits.map(tx => tx.itemWrites), [20, 20, 20, 20, 20]);
  assert.deepEqual(checkCommits.map(tx => tx.run.successCount), [20, 40, 60, 80, 100]);
  assert.deepEqual(checkCommits.map(tx => tx.run.cursor), ['u0019', 'u0039', 'u0059', 'u0079', 'u0099']);
  const token = checkCommits[0].run.leaseToken;
  assert.ok(token);
  assert.ok(checkCommits.slice(0, -1).every(tx => tx.run.leaseToken === token && tx.run.leaseUntil > app.now()));
  assert.equal(app.state.bijing_sync_runs[0].leaseToken, '');
  run = await app.finish(run);
  assert.equal(run.status, 'success'); assert.equal(run.successCount, 100);
  assert.deepEqual(app.queries.map(records => records.length), [100]);
  assert.ok(app.transactions.every(tx => tx.operations <= 100), 'every database transaction stays within the platform operation limit');
  assert.ok(app.transactions.filter(tx => tx.itemWrites).every(tx => tx.itemWrites <= 20));
});

test('timer upload finishes as uploaded and releases the day without writing verification items or errors', async () => {
  const app = harness({ users: users(150) });
  const started = await app.jobs.startDailyUpload();
  const uploaded = await app.jobs.processChunk(started.runId);
  assert.equal(uploaded.status, 'uploaded'); assert.equal(uploaded.phase, 'upload');
  assert.equal(uploaded.total, 150); assert.equal(uploaded.successCount, 0); assert.equal(uploaded.cursor, '');
  assert.deepEqual(app.posts.map(post => post.records.length), [100, 50]);
  assert.equal(app.queries.length, 0); assert.equal(app.markers.length, 0);
  assert.equal(app.state.bijing_sync_items.length, 0); assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(app.state.bijing_sync_days[0].activeRunId, '');
  await app.jobs.processChunk(started.runId);
  assert.equal(app.posts.length, 2);
});

test('duplicate starts and concurrent workers cannot process the same day twice', async () => {
  const app = harness();
  const starts = await Promise.all([app.jobs.start(date, 'timer'), app.jobs.start(date, 'manual', 'admin')]);
  assert.equal(starts[0].runId, starts[1].runId);
  await Promise.all([app.jobs.processChunk(starts[0].runId), app.jobs.processChunk(starts[0].runId)]);
  assert.equal(app.posts.length, 1); assert.equal(app.state.bijing_sync_items.length, 0);
});

test('an explicit manual full sync atomically replaces an expired automatic upload for its selected date', async () => {
  const app = harness();
  const automatic = await app.jobs.start(date, 'timer');
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'abandoned-upload', leaseUntil: app.now() + 100 });
  app.advance(101);
  const [first, repeated] = await Promise.all([app.jobs.start(date, 'manual', 'admin'), app.jobs.start(date, 'manual', 'admin')]);
  assert.notEqual(first.runId, automatic.runId);
  assert.equal(repeated.runId, first.runId);
  assert.equal(first.recordDate, date);
  assert.equal(first.trigger, 'manual');
  assert.equal(first.operator, 'admin');
  assert.equal(first.phase, 'upload');
  assert.equal(first.total, 0);
  const old = app.state.bijing_sync_runs.find(run => run._id === automatic.runId);
  assert.equal(old.status, 'failed');
  assert.match(old.error, /手动全量同步接管/);
  assert.equal(old.leaseToken, '');
  assert.equal(old.leaseUntil, 0);
  assert.ok(old.finishedAt);
  assert.equal(app.state.bijing_sync_days[0].activeRunId, first.runId);
  assert.equal((await app.jobs.processChunk(automatic.runId)).status, 'failed');
  assert.equal(app.posts.length, 0);
  const done = await app.finish(first);
  assert.equal(done.status, 'success');
  assert.ok(app.posts.every(request => request.recordDate === date));
  assert.ok(app.queries.every(records => records.every(record => record.recordDate === date)));
});

test('manual sync preserves live uploads and newly registered uploads before lease acquisition', async () => {
  for (const leaseUntil of [0, 1790110800000 + 120000]) {
    const app = harness();
    const automatic = await app.jobs.start(date, 'timer');
    Object.assign(app.state.bijing_sync_runs[0], { leaseToken: leaseUntil ? 'live-worker' : '', leaseUntil });
    const before = clone(app.state);
    const manual = await app.jobs.start(date, 'manual', 'admin');
    assert.equal(manual.runId, automatic.runId);
    assert.deepEqual(app.state, before);
  }
  const app = harness();
  const abandoned = await app.jobs.start(date, 'timer');
  app.advance(10 * 60000 + 1);
  const manual = await app.jobs.start(date, 'manual', 'admin');
  assert.notEqual(manual.runId, abandoned.runId);
  assert.equal(app.state.bijing_sync_runs[0].status, 'failed');
});

test('manual full sync does not replace other task kinds even when their leases have expired', async () => {
  for (const fields of [
    { trigger: 'manual', mode: 'full', phase: 'upload' },
    { trigger: 'timer-errors', mode: 'errors', phase: 'upload' },
    { trigger: 'timer-check', mode: 'full', phase: 'verify' },
    { trigger: 'timer', mode: 'full', phase: 'retry' },
  ]) {
    const app = harness();
    const active = await app.jobs.start(date, 'timer');
    Object.assign(app.state.bijing_sync_runs[0], { ...fields, leaseToken: 'old-token', leaseUntil: app.now() - 1 });
    const before = clone(app.state);
    assert.equal((await app.jobs.start(date, 'manual', 'admin')).runId, active.runId);
    assert.deepEqual(app.state, before);
  }
});

test('an active task for another date cannot redirect a manual request for the selected date', async () => {
  const app = harness();
  const otherDate = '2026-09-21';
  const other = await app.jobs.start(otherDate, 'manual', 'admin');
  const selected = await app.jobs.start(date, 'manual', 'admin');
  assert.notEqual(selected.runId, other.runId);
  assert.equal(selected.recordDate, date);
  assert.equal(app.state.bijing_sync_days.find(day => day.recordDate === otherDate).activeRunId, other.runId);
  assert.equal(app.state.bijing_sync_days.find(day => day.recordDate === date).activeRunId, selected.runId);
});

test('expired leases resume source verification without repeating the completed upload', async () => {
  const app = harness(); let run = await app.jobs.start(date, 'manual'); run = await app.jobs.processChunk(run.runId);
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'dead-worker', leaseUntil: run.startedAt + 100 }); app.advance(101);
  assert.equal((await app.jobs.listRuns(date)).runs[0].status, 'interrupted');
  const resumed = await app.finish(run);
  assert.equal(resumed.status, 'success'); assert.equal(resumed.interruptions, 1);
  assert.match(resumed.lastInterruption, /中断/); assert.equal(app.posts.length, 1);
});

test('upload timeouts and malformed acknowledgements remain pending until a remote query confirms the commit', async () => {
  for (const post of [
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); throw new Error('network timeout'); },
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); return { success: false, message: 'ambiguous' }; },
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); return { success: true, data: { results: [] } }; },
  ]) {
    const app = harness({ post }); let run = await app.jobs.start(date, 'manual'); run = await app.jobs.processChunk(run.runId);
    assert.equal(app.state.bijing_sync_errors.length, 2); assert.equal(app.markers.length, 0);
    assert.ok(app.state.bijing_sync_errors.every(row => row.reason === 'upload_failed' && row.exists === null));
    const done = await app.finish(run);
    assert.equal(done.status, 'success'); assert.equal(done.successCount, 2); assert.equal(app.posts.length, 1); assert.equal(app.state.bijing_sync_errors.length, 0);
  }
});

test('missing records are written only after verification, retried once and removed after re-verification', async () => {
  let writes = 0;
  const app = harness({ post: (recordDate, records, { ack, writeRemote }) => { if (++writes > 1) writeRemote(recordDate, records); return ack(recordDate, records); } });
  let run = await app.jobs.start(date, 'manual');
  run = await app.jobs.processChunk(run.runId); assert.equal(app.state.bijing_sync_errors.length, 0);
  run = await app.jobs.processChunk(run.runId); assert.equal(run.phase, 'retry'); assert.equal(run.failedCount, 2); assert.equal(app.state.bijing_sync_errors.length, 2);
  assert.deepEqual(app.state.bijing_sync_errors.map(row => row.reason), ['missing', 'missing']);
  run = await app.jobs.processChunk(run.runId); assert.equal(run.phase, 'reverify'); assert.equal(app.state.bijing_sync_errors.length, 2);
  run = await app.jobs.processChunk(run.runId); assert.equal(run.status, 'success'); assert.equal(run.failedCount, 0); assert.equal(run.successCount, 2);
  assert.equal(app.state.bijing_sync_errors.length, 0); assert.deepEqual(app.requests, ['post', 'query', 'post', 'query']);
});

test('successful acknowledgements without stored records stay failed after the single automatic retry', async () => {
  const app = harness({ post: (recordDate, records, { ack }) => ack(recordDate, records) });
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(run.status, 'failed'); assert.equal(run.failedCount, 2); assert.equal(app.posts.length, 2);
  assert.equal(app.state.bijing_sync_errors.length, 2); assert.ok(app.state.bijing_sync_errors.every(row => row.retryCount === 1));
  assert.equal(app.markers.length, 0);
});

test('duration mismatches are detected and source totals are refreshed before retrying', async () => {
  let duration = 20;
  const app = harness({ duration: openid => openid === 'openid0' ? duration : 20 });
  let run = await app.jobs.processChunk((await app.jobs.start(date, 'manual')).runId);
  app.remote.set(`BJ0/${date}`, 5); duration = 35;
  run = await app.jobs.processChunk(run.runId);
  assert.equal(app.state.bijing_sync_errors[0].reason, 'duration_mismatch'); assert.equal(app.state.bijing_sync_errors[0].actualDurationMinutes, 5);
  run = await app.jobs.processChunk(run.runId);
  assert.deepEqual(app.posts[1].records, [{ studentNumber: 'BJ0', durationMinutes: 35 }]);
  run = await app.finish(run); assert.equal(run.status, 'success'); assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('query failures and malformed batches neither invent missing rows nor remove prior errors', async () => {
  const invalid = [
    () => { throw new Error('query timeout'); },
    () => ({ success: false, data: {} }),
    (records, result) => { const r = result(records); r.data.total++; return r; },
    (records, result) => { const r = result(records); r.data.results.pop(); return r; },
    (records, result) => { const r = result(records); r.data.results[1].index = 0; return r; },
    (records, result) => { const r = result(records); r.data.results[1].recordDate = '2026-09-21'; return r; },
    (records, result) => { const r = result(records); r.data.results[1].studentNumber = 'other'; return r; },
    (records, result) => { const r = result(records); r.data.results[1].exists = false; return r; },
    (records, result) => { const r = result(records); r.data.results[1].durationMinutes = -1; return r; },
  ];
  for (const query of invalid) {
    const app = harness({ query }); const existing = clone(app.seedError());
    const run = await app.finish(await app.jobs.start(date, 'manual'));
    assert.equal(run.status, 'failed'); assert.equal(run.queryFailures, 3); assert.equal(app.queries.length, 3); assert.equal(app.posts.length, 1);
    assert.equal(app.state.bijing_sync_errors.length, 2);
    const preserved = app.state.bijing_sync_errors.find(row => row._id === existing._id);
    assert.equal(preserved.actualDurationMinutes, existing.actualDurationMinutes);
    assert.equal(preserved.exists, existing.exists);
    assert.ok(app.state.bijing_sync_errors.every(row => row.reason === 'query_failed' && row.queueVersion));
    assert.equal(app.state.bijing_sync_errors.find(row => row.studentNumber === 'BJ1').exists, null);
    assert.equal(app.markers.length, 0);
  }
});

test('a transient query failure resumes the same phase and cursor', async () => {
  let calls = 0;
  const app = harness({ query: (records, result) => { if (++calls === 1) throw new Error('transient'); return result(records); } });
  let run = await app.jobs.processChunk((await app.jobs.start(date, 'manual')).runId);
  run = await app.jobs.processChunk(run.runId); assert.equal(run.status, 'running'); assert.equal(run.phase, 'verify'); assert.equal(run.cursor, '');
  run = await app.finish(run); assert.equal(run.status, 'success'); assert.equal(run.queryFailures, 0); assert.equal(app.posts.length, 1);
});

test('verified recovery removes errors even if the local success marker fails', async () => {
  const app = harness({ markError: true }); app.seedError();
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(run.status, 'success'); assert.equal(run.failedCount, 0); assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.ok(app.state.bijing_sync_items.every(item => item.markError === 'marker failed'));
});

test('re-verification failure preserves confirmed errors even after a successful retry POST', async () => {
  let writes = 0, reads = 0;
  const app = harness({ post: (d, records, { writeRemote, ack }) => { if (++writes > 1) writeRemote(d, records); return ack(d, records); },
    query: (records, result) => { if (++reads > 1) throw new Error('offline'); return result(records); } });
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(run.status, 'failed'); assert.equal(run.phase, 'reverify'); assert.equal(app.state.bijing_sync_errors.length, 2); assert.equal(app.posts.length, 2);
});

test('changed or duplicate bindings are retained as errors without blind retries', async () => {
  for (const change of [
    app => { app.state.users[0].bijingStudentNumber = 'OTHER'; },
    app => { app.state.users.push({ ...app.state.users[0], _id: 'duplicate', _openid: 'different' }); },
  ]) {
    const app = harness({ post: (d, records, { ack }) => ack(d, records) });
    let run = await app.jobs.processChunk((await app.jobs.start(date, 'manual')).runId);
    run = await app.jobs.processChunk(run.runId); change(app);
    run = await app.finish(run);
    assert.equal(run.status, 'failed'); assert.deepEqual(app.posts[1].records.map(r => r.studentNumber), ['BJ1']);
    assert.match(app.state.bijing_sync_errors.find(row => row.studentNumber === 'BJ0').error, /绑定已变更|冲突/);
  }
});

test('manual error repair starts with a query and supports records older than the normal thirty-day window', async () => {
  const oldDate = '2026-01-10'; const app = harness(); app.seedError('BJ0', oldDate); app.remote.set(`BJ0/${oldDate}`, 20);
  const run = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(run.recordDate, oldDate); assert.equal(run.mode, 'errors'); assert.equal(run.operator, 'admin'); assert.equal(run.status, 'success');
  assert.equal(app.posts.length, 0); assert.equal(app.queries.length, 1); assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(await app.jobs.retryErrors('admin'), null);
});

test('manual error repair refreshes old snapshots before posting and is idempotent across runs', async () => {
  const app = harness({ duration: () => 45 }); app.seedError();
  const run = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(run.status, 'success'); assert.equal(app.posts.length, 1); assert.equal(app.posts[0].records[0].durationMinutes, 45); assert.equal(app.state.bijing_sync_errors.length, 0);
  assert.equal(errorId(' bj0 ', date), errorId('BJ0', date));
});

test('multiple old bindings remain separate and changed bindings cannot clear historical errors', async () => {
  const app = harness(); const first = app.seedError(); app.seedError('OLD-BJ0', date, { userId: first.userId, openid: first.openid });
  app.remote.set(`BJ0/${date}`, 20); app.remote.set(`OLD-BJ0/${date}`, 20);
  const run = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(run.total, 2); assert.equal(run.successCount, 1); assert.equal(run.failedCount, 1);
  assert.equal(app.state.bijing_sync_errors.length, 1); assert.equal(app.state.bijing_sync_errors[0].studentNumber, 'OLD-BJ0');
});

test('error repair rotates dates so permanent old errors cannot starve later dates', async () => {
  const app = harness({ users: users(101), post: (d, records, { ack }) => ack(d, records) });
  for (let i = 0; i < 101; i++) app.seedError(`BJ${i}`, '2026-01-01');
  app.seedError('BJ0', '2026-01-02');
  const first = await app.finish(await app.jobs.retryErrors('admin'));
  const second = await app.jobs.retryErrors('admin');
  assert.equal(first.recordDate, '2026-01-01'); assert.equal(second.recordDate, '2026-01-02');
});

test('the same daily upload is not recreated or resent while an explicit manual full run can still recover', async () => {
  let fails = true;
  const app = harness({ post: (d, records, { writeRemote, ack }) => { if (!fails) writeRemote(d, records); return ack(d, records); } });
  const first = await app.jobs.timer('dailySyncBijing');
  assert.equal(first.status, 'uploaded');
  app.advance(300000);
  const repeated = await app.jobs.timer('dailySyncBijing');
  assert.equal(repeated.runId, first.runId); assert.equal(repeated.status, 'uploaded');
  assert.equal(app.state.bijing_sync_runs.filter(r => r.recordDate === date).length, 1);
  assert.equal(app.posts.length, 1); assert.equal(app.queries.length, 0);
  fails = false; const recovered = await app.finish(await app.jobs.start(date, 'manual', 'admin'));
  assert.equal(recovered.status, 'success'); assert.equal(recovered.attempt, 2); assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('zero records without history skip and duplicate bindings remain queued without remote claims', async () => {
  const app = harness({ users: [{ _id: 'u1', _openid: 'a', bijingBound: true, bijingStudentNumber: 'BJabc' }, { _id: 'u2', _openid: 'b', bijingBound: true, bijingStudentNumber: ' BJABC ' }, { _id: 'u3', _openid: 'c', bijingBound: true, bijingStudentNumber: 'BJ2' }], duration: () => 0 });
  const done = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(done.failedCount, 2); assert.equal(done.skippedCount, 1); assert.equal(app.posts.length, 0); assert.equal(app.queries.length, 0);
  assert.equal(app.state.bijing_sync_errors.length, 1);
  assert.equal(app.state.bijing_sync_errors[0].reason, 'binding_conflict');
  assert.equal(app.state.bijing_sync_errors[0].exists, null);
});

test('scan errors fail the run and preserve its cursor without writing error rows', async () => {
  const app = harness({ readError: true }); const done = await app.jobs.processChunk((await app.jobs.start(date, 'manual')).runId);
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'scan unavailable'); assert.equal(done.cursor, ''); assert.ok(done.finishedAt);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('recent date validation remains bounded and idle continuation does not backfill days', async () => {
  const app = harness({ users: [] });
  await assert.rejects(app.jobs.start('2026-09-23', 'manual'), /已结束/);
  await assert.rejects(app.jobs.start('2026-02-30', 'manual'), /已结束/);
  await app.jobs.timer(); app.advance(300000); await app.jobs.timer();
  assert.deepEqual(app.state.bijing_sync_runs, []);
});

function historyRun(recordDate, sequence, extra = {}) {
  const startedAt = 1790100000000 + sequence;
  return { _id: `${startedAt}_${String(sequence).padStart(16, '0')}`, recordDate, startedAt, updatedAt: startedAt,
    status: 'success', phase: 'reverify', mode: 'full', trigger: 'manual', ...extra };
}

test('the history overview includes seven ended days while an explicit date can show older results', async () => {
  const app = harness();
  const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${date}T00:00:00Z`) - index * 86400000).toISOString().slice(0, 10));
  app.state.bijing_sync_runs.push(...dates.map((recordDate, index) => historyRun(recordDate, index)));
  // New executions of old dates must not consume the first fifty history rows.
  app.state.bijing_sync_runs.push(...Array.from({ length: 60 }, (_, index) => historyRun('2026-09-15', 100 + index)));
  app.state.bijing_sync_runs.push(historyRun('2026-09-23', 200), historyRun('2026-01-10', 201));
  const recent = await app.jobs.listRuns();
  assert.deepEqual(recent.runs.map(run => run.recordDate), dates);
  assert.equal(recent.nextCursor, null);
  assert.equal((await app.jobs.listRuns('2026-09-16')).runs.length, 1);
  const selected = await app.jobs.listRuns('2026-09-15');
  assert.equal(selected.runs.length, 50);
  assert.ok(selected.runs.every(run => run.recordDate === '2026-09-15'));
  assert.ok(selected.nextCursor);
  await assert.rejects(app.jobs.listRuns('2026-09-23'), /已结束/);
});

test('the thirtieth ended date can be synchronized and viewed, while the thirty-first date is rejected', async () => {
  const app = harness();
  const dateAt = offset => new Date(Date.parse(`${date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
  const oldestAllowed = dateAt(29), tooOld = dateAt(30);
  const done = await app.finish(await app.jobs.start(oldestAllowed, 'manual', 'admin'));
  assert.equal(done.recordDate, oldestAllowed);
  assert.equal(done.status, 'success');
  const selected = await app.jobs.listRuns(oldestAllowed);
  assert.deepEqual(selected.runs.map(run => run.runId), [done.runId]);
  assert.equal(selected.nextCursor, null);
  assert.deepEqual((await app.jobs.listRuns()).runs, []);
  assert.ok(app.posts.every(request => request.recordDate === oldestAllowed));
  await assert.rejects(app.jobs.start(tooOld, 'manual', 'admin'), /最近30/);
  await assert.rejects(app.jobs.listRuns(tooOld), /最近30/);
});

test('run history orders record dates first and newer executions first within each day', async () => {
  const app = harness();
  const newestDateEarlierRun = historyRun(date, 1);
  const newestDateLaterRun = historyRun(date, 3);
  const olderDateNewestRun = historyRun('2026-09-21', 100);
  app.state.bijing_sync_runs.push(newestDateEarlierRun, olderDateNewestRun, newestDateLaterRun);
  assert.deepEqual((await app.jobs.listRuns()).runs.map(run => run._id), [newestDateLaterRun, newestDateEarlierRun, olderDateNewestRun].map(run => run._id));
  assert.deepEqual((await app.jobs.listRuns(date)).runs.map(run => run._id), [newestDateLaterRun._id, newestDateEarlierRun._id]);
});

test('run history paginates fifty rows across dates without repeating or skipping executions', async () => {
  const app = harness();
  const dates = [date, '2026-09-21', '2026-09-20'];
  const rows = Array.from({ length: 125 }, (_, index) => historyRun(dates[index % dates.length], index));
  app.state.bijing_sync_runs.push(...rows);
  const expected = [...rows].sort((a, b) => b.recordDate.localeCompare(a.recordDate) || b._id.localeCompare(a._id));
  const first = await app.jobs.listRuns();
  const second = await app.jobs.listRuns(undefined, first.nextCursor);
  const third = await app.jobs.listRuns(undefined, second.nextCursor);
  assert.deepEqual([first.runs.length, second.runs.length, third.runs.length], [50, 50, 25]);
  assert.equal(first.nextCursor, first.runs.at(-1)._id);
  assert.equal(second.nextCursor, second.runs.at(-1)._id);
  assert.equal(third.nextCursor, null);
  const returned = [...first.runs, ...second.runs, ...third.runs].map(run => run._id);
  assert.deepEqual(returned, expected.map(run => run._id));
  assert.equal(new Set(returned).size, rows.length);
  await assert.rejects(app.jobs.listRuns(undefined, '1790100999999_0000000000000000'), /分页游标无效/);
});

test('selected-date pagination includes older results and rejects cursors from another date or overview scope', async () => {
  const app = harness();
  const selectedDate = '2026-09-15', anotherDate = '2026-09-14';
  const rows = Array.from({ length: 125 }, (_, index) => historyRun(selectedDate, index + 1));
  const current = historyRun(date, 1000), other = historyRun(anotherDate, 1001);
  app.state.bijing_sync_runs.push(...rows, current, other);
  const first = await app.jobs.listRuns(selectedDate);
  const second = await app.jobs.listRuns(selectedDate, first.nextCursor);
  const third = await app.jobs.listRuns(selectedDate, second.nextCursor);
  assert.deepEqual([first.runs.length, second.runs.length, third.runs.length], [50, 50, 25]);
  const expected = [...rows].sort((a, b) => b._id.localeCompare(a._id)).map(run => run._id);
  assert.deepEqual([...first.runs, ...second.runs, ...third.runs].map(run => run.runId), expected);
  assert.equal(third.nextCursor, null);
  await assert.rejects(app.jobs.listRuns(selectedDate, other._id), /分页游标无效/);
  await assert.rejects(app.jobs.listRuns(selectedDate, current._id), /分页游标无效/);
  await assert.rejects(app.jobs.listRuns(anotherDate, first.nextCursor), /分页游标无效/);
  await assert.rejects(app.jobs.listRuns(undefined, first.nextCursor), /分页游标无效/);
});

test('old active repairs remain separately resumable without appearing in recent history', async () => {
  const app = harness();
  app.seedError('BJ0', '2026-01-10');
  const repair = await app.jobs.retryErrors('admin');
  app.state.bijing_sync_runs.push(historyRun(date, 1));
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'expired-worker', leaseUntil: repair.startedAt - 1 });
  const result = await app.jobs.listRuns();
  assert.deepEqual(result.runs.map(run => run.recordDate), [date]);
  assert.equal(result.activeRun.runId, repair.runId);
  assert.equal(result.activeRun.recordDate, '2026-01-10');
  assert.equal(result.activeRun.status, 'interrupted');
  assert.equal(result.activeRun.leaseToken, undefined);
  assert.equal(result.activeRun.leaseUntil, undefined);
  assert.equal((await app.jobs.listRuns('2026-09-15')).activeRun.runId, repair.runId);
  const completed = await app.finish(repair);
  assert.equal(completed.status, 'success');
  assert.equal((await app.jobs.listRuns()).activeRun, null);
});

test('items and errors use stable fifty-row pagination', async () => {
  const app = harness({ users: users(65), post: (d, records, { ack }) => ack(d, records) });
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  const first = await app.jobs.details(run.runId), second = await app.jobs.details(run.runId, first.nextCursor);
  assert.equal(first.items.length, 50); assert.equal(second.items.length, 15);
  const errors = await app.jobs.listErrors(), next = await app.jobs.listErrors(errors.nextCursor);
  assert.equal(errors.errors.length, 50); assert.equal(next.errors.length, 15);
  assert.equal(new Set([...errors.errors, ...next.errors].map(row => row._id)).size, 65);
  assert.equal(BATCH_SIZE, 100); assert.equal(CHUNK_SIZE, 20);
  assert.ok(app.posts.every(p => p.records.length <= 100)); assert.ok(app.queries.every(p => p.length <= 100));
  assert.ok(app.transactions.every(tx => tx.operations <= 100));
});

test('canonical requests preserve original binding spelling for conditional success markers', async () => {
  const app = harness({ users: [{ _id: 'u1', _openid: 'a', bijingBound: true, bijingStudentNumber: 'BJabc-123' }] });
  const done = await app.finish(await app.jobs.start(date, 'manual')); assert.equal(done.status, 'success');
  assert.equal(app.posts[0].records[0].studentNumber, 'BJABC-123'); assert.equal(app.queries[0][0].studentNumber, 'BJABC-123'); assert.equal(app.markers[0][2], 'BJabc-123');
});

test('slow source reads retain individual budgets and shorten API pages without losing users', async () => {
  let app, reads = 0;
  app = harness({ users: users(45), duration: async (openid, recordDate, deadline) => {
    assert.equal(deadline - app.now(), 20000, 'each person receives an independent source-read budget');
    app.advance(10000);
    const stored = app.state.bijing_sync_runs[0];
    assert.ok(stored.leaseUntil > app.now(), 'the current worker still owns a live lease during slow reads');
    if (++reads === 15) assert.equal((await app.jobs.processChunk(stored._id)).busy, true);
    return 20;
  } });
  const run = await app.jobs.start(date, 'manual');
  const uploaded = await app.jobs.processChunk(run.runId);
  assert.equal(app.now() - run.startedAt, 450000);
  assert.equal(uploaded.total, 0); assert.equal(uploaded.uploadSummary.total, 45);
  assert.equal(uploaded.phase, 'verify'); assert.equal(uploaded.interruptions, 0);
  assert.deepEqual(app.posts.map(post => post.records.length), Array(45).fill(1)); assert.equal(app.queries.length, 0);
  assert.equal((await app.finish(uploaded)).status, 'success');
});

test('slow success markers renew the lease and commit every verified person after a single query', async () => {
  let app, marked = 0;
  app = harness({ users: users(45), mark: async () => {
    app.advance(10000);
    const stored = app.state.bijing_sync_runs[0];
    assert.ok(stored.leaseUntil > app.now(), 'local marking does not outlive the renewed lease');
    if (++marked === 15) assert.equal((await app.jobs.processChunk(stored._id)).busy, true);
  } });
  const uploaded = await app.jobs.processChunk((await app.jobs.start(date, 'manual')).runId);
  const verified = await app.jobs.processChunk(uploaded.runId);
  assert.equal(app.now() - uploaded.startedAt, 450000);
  assert.equal(verified.status, 'success'); assert.equal(verified.successCount, 45); assert.equal(verified.interruptions, 0);
  assert.deepEqual(app.queries.map(records => records.length), [45]); assert.equal(app.markers.length, 45);
  assert.ok(app.transactions.filter(tx => tx.itemWrites).every(tx => tx.itemWrites <= 20));
  assert.ok(app.state.bijing_sync_items.every(item => item.status === 'success' && !item.markError));
});

test('three killed workers explicitly fail and release the day', async () => {
  const app = harness(); const run = await app.jobs.start(date, 'timer');
  Object.assign(app.state.bijing_sync_runs[0], { interruptions: 2, consecutiveInterruptions: 2, leaseUntil: run.startedAt + 10, leaseToken: 'dead' }); app.advance(11);
  const done = await app.jobs.processChunk(run.runId); assert.equal(done.status, 'failed'); assert.match(done.error, /连续三次/);
  assert.equal(app.state.bijing_sync_days[0].activeRunId, ''); assert.equal(app.posts.length, 0);
});

test('in-progress legacy runs preserve real item counters while completing and verifying their saved upload', async () => {
  for (const previousStatus of ['failed', 'success', 'pending']) {
    const app = harness();
    let run = await app.jobs.start(date, 'manual');
    const stored = app.state.bijing_sync_runs[0];
    delete stored.phase;
    delete stored.sourceCheck;
    stored.total = 1;
    stored.failedCount = Number(previousStatus === 'failed');
    stored.successCount = Number(previousStatus === 'success');
    stored.cursor = 'u0000';
    const id = `${run.runId}_${require('crypto').createHash('sha256').update('u0000').digest('hex').slice(0, 24)}`;
    app.state.bijing_sync_items.push({ _id: id, runId: run.runId, recordDate: date,
      userId: 'u0000', openid: 'openid0', studentNumber: 'BJ0', bindingStudentNumber: 'BJ0',
      durationMinutes: 20, status: previousStatus });
    run = await app.finish(run);
    assert.equal(run.status, 'success');
    assert.equal(run.total, 2);
    assert.equal(run.successCount, 2);
    assert.equal(run.failedCount, 0);
    assert.equal(app.state.bijing_sync_items.length, 2);
    assert.deepEqual(app.posts.map(post => post.records.map(row => row.studentNumber)), [['BJ1'], ['BJ0']]);
    assert.equal(app.remote.get(`BJ0/${date}`), 20);
    assert.equal(app.state.bijing_sync_errors.length, 0);
  }
});

test('error-table write failure rolls back item status and never advances the verification cursor', async () => {
  const app = harness({ failErrorWrite: true, post: (d, records, { ack }) => ack(d, records) });
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(run.status, 'failed'); assert.equal(run.phase, 'verify'); assert.equal(run.cursor, ''); assert.equal(run.error, 'error write failed');
  assert.equal(app.state.bijing_sync_errors.length, 0); assert.equal(app.state.bijing_sync_items.length, 0);
});


test('repair cannot mistake a remote value matching an old snapshot for current source consistency', async () => {
  const app = harness({ duration: () => 45 }); app.seedError(); app.remote.set(`BJ0/${date}`, 20);
  let run = await app.jobs.retryErrors('admin');
  run = await app.jobs.processChunk(run.runId); assert.equal(app.state.bijing_sync_errors.length, 1);
  run = await app.jobs.processChunk(run.runId); assert.equal(run.phase, 'retry'); assert.equal(app.state.bijing_sync_errors.length, 1);
  assert.equal(app.state.bijing_sync_errors[0].expectedDurationMinutes, 45);
  run = await app.finish(run);
  assert.equal(run.status, 'success'); assert.equal(app.remote.get(`BJ0/${date}`), 45);
  assert.equal(app.posts.length, 1); assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('repair source failures and changed bindings preserve errors even if remote matches an old snapshot', async () => {
  for (const mutate of [
    app => { app.state.users[0].bijingStudentNumber = 'CHANGED'; },
    app => { app.state.users.push({ ...app.state.users[0], _id: 'duplicate', _openid: 'other' }); },
    () => {},
  ]) {
    const app = harness({ duration: () => { throw new Error('source read failed'); } });
    const before = clone(app.seedError()); app.remote.set(`BJ0/${date}`, 20); mutate(app);
    const run = await app.finish(await app.jobs.retryErrors('admin'));
    assert.equal(run.status, 'failed'); assert.deepEqual(app.state.bijing_sync_errors, [before]);
    assert.equal(app.queries.length, 0); assert.equal(app.posts.length, 0);
  }
});


test('source read failures enter the repair queue separately from confirmed remote discrepancies', async () => {
  let sourceHealthy = false, write = false;
  const app = harness({ duration: openid => { if (openid === 'openid1' && !sourceHealthy) throw new Error('source unavailable'); return 20; },
    post: (d, records, { ack, writeRemote }) => { if (write) writeRemote(d, records); return ack(d, records); } });
  const full = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(full.status, 'failed'); assert.equal(full.failedCount, 2); assert.equal(app.state.bijing_sync_errors.length, 2);
  const sourceError = app.state.bijing_sync_errors.find(row => row.studentNumber === 'BJ1');
  assert.equal(sourceError.reason, 'source_read_failed'); assert.equal(sourceError.exists, null);
  assert.equal(sourceError.actualDurationMinutes, null);
  write = true;
  const repaired = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(repaired.status, 'partial'); assert.equal(repaired.mode, 'errors'); assert.equal(repaired.total, 2);
  assert.equal(app.state.bijing_sync_errors.length, 1);
  assert.equal(app.state.bijing_sync_errors[0].reason, 'source_read_failed');
  sourceHealthy = true;
  const next = await app.jobs.retryErrors('admin');
  const done = await app.finish(next); assert.equal(done.total, 1); assert.equal(done.status, 'success');
  assert.equal(app.remote.get(`BJ1/${date}`), 20); assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('the scheduled source-check success survives later error-only repair status changes', async () => {
  const app = harness();
  await app.jobs.timer('dailySyncBijing');
  await app.jobs.timer('checkBijingSync');
  const full = app.state.bijing_sync_runs.find(run => run.trigger === 'timer-check');
  assert.ok(full); assert.equal(full.status, 'success');
  app.seedError('UNKNOWN', date);
  const repaired = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(repaired.status, 'failed'); assert.equal(repaired.mode, 'errors');
  const before = app.state.bijing_sync_runs.length;
  await app.jobs.timer('checkBijingSync');
  assert.equal(app.state.bijing_sync_runs.length, before);
  assert.equal(app.state.bijing_sync_days.find(day => day._id === date).checkRunId, full._id);
  assert.equal(app.state.bijing_sync_runs.find(run => run._id === full._id).status, 'success');
});


test('a repair request from an older hourly cycle cannot claim the day after a newer cycle opens', async () => {
  const app = harness();
  const cycleDate = '2026-09-23';
  const currentKey = `${cycleDate}T04`;
  app.state.bijing_sync_days.push({ _id: '__daily_check_cycle__', cycleDate, recordDate: date,
    cycleKey: currentKey, status: 'running', cursor: '' });
  const before = clone(app.state);
  assert.equal(await app.jobs.startScheduledRepair(date, cycleDate, `${cycleDate}T03`), null);
  assert.deepEqual(app.state, before, 'stale hourly work leaves the new cycle and day lock untouched');
  const run = await app.jobs.startScheduledRepair(date, cycleDate, currentKey);
  assert.equal(run.mode, 'errors');
  assert.equal(run.repairCycle, currentKey);
  assert.equal(app.state.bijing_sync_days.find(day => day._id === date).repairCycle, currentKey);
});
