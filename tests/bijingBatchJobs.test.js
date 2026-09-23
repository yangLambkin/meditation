const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatchJobs, BATCH_SIZE, errorId } = require('../cloudfunctions/bijingSync/batchJobs');
const clone = value => value == null ? value : structuredClone(value);
const date = '2026-09-22';
const users = count => Array.from({ length: count }, (_, i) => ({
  _id: `u${String(i).padStart(4, '0')}`, _openid: `openid${i}`, bijingBound: true, bijingStudentNumber: `BJ${i}`, nickName: `用户${i}`,
}));
function harness(options = {}) {
  const state = { bijing_sync_runs: [], bijing_sync_days: [], bijing_sync_items: [], bijing_sync_errors: [], users: options.users || users(2) };
  let clock = 1790100000000, transaction = Promise.resolve();
  const posts = [], queries = [], markers = [], requests = [], remote = new Map();
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
      const pending = transaction.then(async () => { const before = clone(state); try { return await fn(db); } catch (error) { Object.assign(state, before); throw error; } });
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
    getDayDuration: async (openid, recordDate) => options.duration ? options.duration(openid, recordDate) : 20,
    markSynced: async (...args) => { markers.push(args); if (options.markError) throw new Error('marker failed'); },
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
    return run;
  }
  function seedError(studentNumber = 'BJ0', recordDate = date, extra = {}) {
    const user = state.users.find(row => row.bijingStudentNumber.trim().toUpperCase() === studentNumber);
    const row = { _id: errorId(studentNumber, recordDate), studentNumber, recordDate, userId: user && user._id || '', openid: user && user._openid || '',
      bindingStudentNumber: user && user.bijingStudentNumber || studentNumber, nickname: '', expectedDurationMinutes: 20, actualDurationMinutes: 0,
      exists: false, reason: 'missing', error: '远端缺少该学号当日记录', retryCount: 0, createdAt: clock, updatedAt: clock, ...extra };
    state.bijing_sync_errors.push(row); return row;
  }
  return { jobs, state, posts, queries, markers, requests, remote, finish, seedError, advance: ms => clock += ms };
}

test('all uploads checkpoint before the first query; only confirmed remote records become successful', async () => {
  const app = harness({ users: users(45) });
  let run = await app.jobs.start(date, 'manual', 'admin');
  assert.equal(run.trigger, 'manual'); assert.equal(run.operator, 'admin');
  for (let i = 0; i < 3; i++) { app.advance(1000); run = await app.jobs.processChunk(run.runId); assert.equal(app.queries.length, 0); assert.equal(run.successCount, 0); }
  assert.equal(run.total, 45); assert.equal(run.phase, 'verify'); assert.equal(app.markers.length, 0);
  run = await app.finish(run);
  assert.equal(run.status, 'success'); assert.equal(run.successCount, 45); assert.equal(run.durationMs, 3000);
  assert.deepEqual(app.posts.map(p => p.records.length), [20, 20, 5]);
  assert.deepEqual(app.queries.map(records => records.length), [20, 20, 5]);
  assert.equal(app.state.bijing_sync_items.length, 45); assert.equal(app.state.bijing_sync_errors.length, 0);
  await app.jobs.processChunk(run.runId); assert.equal(app.posts.length, 3);
});

test('duplicate starts and concurrent workers cannot process the same day twice', async () => {
  const app = harness();
  const starts = await Promise.all([app.jobs.start(date, 'timer'), app.jobs.start(date, 'manual', 'admin')]);
  assert.equal(starts[0].runId, starts[1].runId);
  await Promise.all([app.jobs.processChunk(starts[0].runId), app.jobs.processChunk(starts[0].runId)]);
  assert.equal(app.posts.length, 1); assert.equal(app.state.bijing_sync_items.length, 2);
});

test('expired leases resume verification and preserve previously completed upload cursors', async () => {
  const app = harness(); let run = await app.jobs.start(date, 'timer'); run = await app.jobs.processChunk(run.runId);
  Object.assign(app.state.bijing_sync_runs[0], { leaseToken: 'dead-worker', leaseUntil: run.startedAt + 100 }); app.advance(101);
  assert.equal((await app.jobs.listRuns(date)).runs[0].status, 'interrupted');
  const resumed = await app.finish(run);
  assert.equal(resumed.status, 'success'); assert.equal(resumed.interruptions, 1);
  assert.match(resumed.lastInterruption, /中断/); assert.equal(app.posts.length, 1);
});

test('upload timeouts and malformed acknowledgements never create false error rows after remote commit', async () => {
  for (const post of [
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); throw new Error('network timeout'); },
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); return { success: false, message: 'ambiguous' }; },
    (recordDate, records, { writeRemote }) => { writeRemote(recordDate, records); return { success: true, data: { results: [] } }; },
  ]) {
    const app = harness({ post }); let run = await app.jobs.start(date, 'timer'); run = await app.jobs.processChunk(run.runId);
    assert.equal(app.state.bijing_sync_errors.length, 0); assert.equal(app.markers.length, 0);
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
  const app = harness({ duration: () => duration });
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
    assert.deepEqual(app.state.bijing_sync_errors, [existing]); assert.equal(app.markers.length, 0);
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
  const app = harness({ users: users(25), post: (d, records, { ack }) => ack(d, records) });
  for (let i = 0; i < 25; i++) app.seedError(`BJ${i}`, '2026-01-01');
  app.seedError('BJ0', '2026-01-02');
  const first = await app.finish(await app.jobs.retryErrors('admin'));
  const second = await app.jobs.retryErrors('admin');
  assert.equal(first.recordDate, '2026-01-01'); assert.equal(second.recordDate, '2026-01-02');
});

test('automatic per-day attempts stop at four while a later manual run can recover', async () => {
  let fails = true;
  const app = harness({ post: (d, records, { writeRemote, ack }) => { if (!fails) writeRemote(d, records); return ack(d, records); } });
  for (let i = 0; i < 4; i++) { await app.finish(await app.jobs.start(date, 'timer')); app.advance(300000); }
  const capped = await app.jobs.start(date, 'timer'); assert.equal(capped.status, 'failed');
  assert.equal(app.state.bijing_sync_runs.filter(r => r.recordDate === date).length, 4);
  fails = false; const recovered = await app.finish(await app.jobs.start(date, 'manual', 'admin'));
  assert.equal(recovered.status, 'success'); assert.equal(recovered.attempt, 5); assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('zero records skip and duplicate bindings fail without uploading or inventing remote errors', async () => {
  const app = harness({ users: [{ _id: 'u1', _openid: 'a', bijingBound: true, bijingStudentNumber: 'BJabc' }, { _id: 'u2', _openid: 'b', bijingBound: true, bijingStudentNumber: ' BJABC ' }, { _id: 'u3', _openid: 'c', bijingBound: true, bijingStudentNumber: 'BJ2' }], duration: () => 0 });
  const done = await app.finish(await app.jobs.timer());
  assert.equal(done.failedCount, 2); assert.equal(done.skippedCount, 1); assert.equal(app.posts.length, 0); assert.equal(app.queries.length, 0);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('scan errors fail the run and preserve its cursor without writing error rows', async () => {
  const app = harness({ readError: true }); const done = await app.jobs.timer();
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'scan unavailable'); assert.equal(done.cursor, ''); assert.ok(done.finishedAt);
  assert.equal(app.state.bijing_sync_errors.length, 0);
});

test('recent date validation and timer backfill create only ended meditation days', async () => {
  const app = harness({ users: [] });
  await assert.rejects(app.jobs.start('2026-09-23', 'manual'), /已结束/);
  await assert.rejects(app.jobs.start('2026-02-30', 'manual'), /已结束/);
  await app.finish(await app.jobs.timer()); app.advance(300000); await app.finish(await app.jobs.timer());
  assert.deepEqual(app.state.bijing_sync_runs.map(r => r.recordDate), [date, '2026-09-21']);
});

function historyRun(recordDate, sequence, extra = {}) {
  const startedAt = 1790100000000 + sequence;
  return { _id: `${startedAt}_${String(sequence).padStart(16, '0')}`, recordDate, startedAt, updatedAt: startedAt,
    status: 'success', phase: 'reverify', mode: 'full', trigger: 'manual', ...extra };
}

test('run history includes exactly the latest seven ended days even when older repairs ran more recently', async () => {
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
  assert.deepEqual((await app.jobs.listRuns('2026-09-15')).runs, []);
  await assert.rejects(app.jobs.listRuns('2026-09-23'), /已结束/);
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
  assert.equal(new Set([...errors.errors, ...next.errors].map(row => row._id)).size, 65); assert.equal(BATCH_SIZE, 20);
  assert.ok(app.posts.every(p => p.records.length <= 20)); assert.ok(app.queries.every(p => p.length <= 20));
});

test('canonical requests preserve original binding spelling for conditional success markers', async () => {
  const app = harness({ users: [{ _id: 'u1', _openid: 'a', bijingBound: true, bijingStudentNumber: 'BJabc-123' }] });
  const done = await app.finish(await app.jobs.timer()); assert.equal(done.status, 'success');
  assert.equal(app.posts[0].records[0].studentNumber, 'BJABC-123'); assert.equal(app.queries[0][0].studentNumber, 'BJABC-123'); assert.equal(app.markers[0][2], 'BJabc-123');
});

test('read budgets checkpoint the processed prefix then finish the upload before querying', async () => {
  let app; app = harness({ duration: () => { app.advance(21000); return 20; } });
  const run = await app.jobs.start(date, 'timer'); const first = await app.jobs.processChunk(run.runId);
  assert.equal(first.total, 1); assert.equal(first.status, 'running'); assert.equal(first.cursor, 'u0000');
  const second = await app.jobs.processChunk(run.runId); assert.equal(second.total, 2); assert.equal(second.phase, 'verify'); assert.equal(app.queries.length, 0);
  assert.equal((await app.finish(second)).status, 'success');
});

test('three killed workers explicitly fail and release the day', async () => {
  const app = harness(); const run = await app.jobs.start(date, 'timer');
  Object.assign(app.state.bijing_sync_runs[0], { interruptions: 2, consecutiveInterruptions: 2, leaseUntil: run.startedAt + 10, leaseToken: 'dead' }); app.advance(11);
  const done = await app.jobs.processChunk(run.runId); assert.equal(done.status, 'failed'); assert.match(done.error, /连续三次/);
  assert.equal(app.state.bijing_sync_days[0].activeRunId, ''); assert.equal(app.posts.length, 0);
});

test('in-progress legacy runs without a phase recheck previously acknowledged item successes', async () => {
  const app = harness(); const run = await app.jobs.start(date, 'manual');
  const saved = app.state.bijing_sync_runs[0]; delete saved.phase; delete saved.discrepancyCount;
  Object.assign(saved, { cursor: 'u0000', total: 1, successCount: 1 });
  app.state.bijing_sync_items.push({ _id: `${run.runId}_legacy`, runId: run.runId, recordDate: date, userId: 'u0000', openid: 'openid0', studentNumber: 'BJ0', bindingStudentNumber: 'BJ0', durationMinutes: 20, status: 'success' });
  const done = await app.finish(run);
  assert.equal(done.status, 'success'); assert.equal(done.total, 2); assert.equal(done.successCount, 2);
  assert.ok(app.queries[0].some(row => row.studentNumber === 'BJ0')); assert.ok(app.posts[1].records.some(row => row.studentNumber === 'BJ0'));
});

test('error-table write failure rolls back item status and never advances the verification cursor', async () => {
  const app = harness({ failErrorWrite: true, post: (d, records, { ack }) => ack(d, records) });
  const run = await app.finish(await app.jobs.start(date, 'manual'));
  assert.equal(run.status, 'failed'); assert.equal(run.phase, 'verify'); assert.equal(run.cursor, ''); assert.equal(run.error, 'error write failed');
  assert.equal(app.state.bijing_sync_errors.length, 0); assert.ok(app.state.bijing_sync_items.every(row => row.status === 'pending'));
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


test('successful error-only repair does not hide a full-run source failure from the daily timer', async () => {
  let sourceHealthy = false, write = false;
  const app = harness({ duration: openid => { if (openid === 'openid1' && !sourceHealthy) throw new Error('source unavailable'); return 20; },
    post: (d, records, { ack, writeRemote }) => { if (write) writeRemote(d, records); return ack(d, records); } });
  const full = await app.finish(await app.jobs.start(date, 'timer'));
  assert.equal(full.status, 'failed'); assert.equal(full.failedCount, 2); assert.equal(app.state.bijing_sync_errors.length, 1);
  write = true;
  const repaired = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(repaired.status, 'success'); assert.equal(repaired.mode, 'errors'); assert.equal(repaired.total, 1);
  assert.equal(app.state.bijing_sync_errors.length, 0);
  sourceHealthy = true;
  const next = await app.jobs.start(date, 'timer');
  assert.equal(next.status, 'running'); assert.equal(next.mode, 'full'); assert.notEqual(next.runId, repaired.runId);
  const done = await app.finish(next); assert.equal(done.total, 2); assert.equal(done.status, 'success'); assert.equal(app.remote.get(`BJ1/${date}`), 20);
});

test('an independent full-run success survives later error-only repair status changes', async () => {
  const app = harness(); const full = await app.finish(await app.jobs.start(date, 'timer'));
  app.seedError('UNKNOWN', date);
  const repaired = await app.finish(await app.jobs.retryErrors('admin'));
  assert.equal(repaired.status, 'failed'); assert.equal(repaired.mode, 'errors');
  const next = await app.jobs.start(date, 'timer'); assert.equal(next.runId, full.runId); assert.equal(next.status, 'success');
});
