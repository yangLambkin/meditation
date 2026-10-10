const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceCheck } = require('../cloudfunctions/bijingSync/sourceCheck');
const { createDailySchedule, CHECK_CYCLE_ID } = require('../cloudfunctions/bijingSync/dailySchedule');

const DATE = '2026-10-09';
const CYCLE = '2026-10-10';
const clone = value => value == null ? value : structuredClone(value);

function harness(options = {}) {
  let timestamp = Date.parse(options.now || `${CYCLE}T05:00:00+08:00`);
  let queue = Promise.resolve();
  const state = {
    bijing_sync_days: {
      [CHECK_CYCLE_ID]: { _id: CHECK_CYCLE_ID, cycleDate: CYCLE, recordDate: DATE, status: 'running', cursor: '' },
      ...(options.days || {}),
    },
    bijing_sync_runs: clone(options.runs || {}),
  };
  const writes = [];
  const db = {
    command: { gt: value => ({ gt: value }) },
    collection(name) {
      if (name === 'bijing_sync_errors') {
        const query = { where() { return query; }, orderBy() { return query; }, limit() { return query; }, async get() { return { data: [] }; } };
        return query;
      }
      assert.ok(state[name], `unexpected collection ${name}`);
      return { doc(id) {
        return {
          async get() {
            if (options.readError) throw options.readError;
            const data = clone(state[name][id] || null);
            if (options.afterRead) options.afterRead(name, id, () => timestamp, value => { timestamp = Date.parse(value); });
            return { data };
          },
          async set({ data }) {
            if (options.failWrite && options.failWrite(name, id, data)) throw new Error('write unavailable');
            state[name][id] = { _id: id, ...clone(data) };
            writes.push([name, id, clone(data)]);
          },
          async update({ data }) {
            assert.ok(state[name][id]);
            Object.assign(state[name][id], clone(data));
            writes.push([name, id, clone(data)]);
          },
        };
      } };
    },
    async runTransaction(fn) {
      const task = queue.then(async () => {
        const before = clone(state);
        try { return await fn(db); }
        catch (error) {
          for (const key of Object.keys(state)) state[key] = before[key];
          throw error;
        }
      });
      queue = task.catch(() => {});
      return task;
    },
  };
  const sourceCheck = createSourceCheck({ db, now: () => timestamp });
  return { db, state, writes, sourceCheck, now: () => timestamp,
    setTime(value) { timestamp = Date.parse(value); } };
}

function activeRun(overrides = {}) {
  return { _id: 'old-upload', recordDate: DATE, status: 'running', phase: 'upload', mode: 'full', trigger: 'timer',
    startedAt: Date.parse(`${CYCLE}T02:00:00+08:00`), cursor: 'old-cursor', total: 30,
    failedCount: 10, leaseToken: 'old-token', leaseUntil: 0, ...overrides };
}

function withRun(run, day = {}) {
  return { runs: { [run._id]: run }, days: { [DATE]: { _id: DATE, recordDate: DATE,
    activeRunId: run.status === 'running' ? run._id : '', latestRunId: run._id, latestFullRunId: run._id,
    attempts: 2, timerAttempts: 2, ...day } } };
}

test('05:00 creates a fresh full source check even when the upload never existed', async () => {
  const app = harness();
  const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.match(run.runId, /^\d{13}_[a-f0-9]{16}$/);
  assert.equal(run.trigger, 'timer-check');
  assert.equal(run.sourceCheck, true);
  assert.equal(run.mode, 'full');
  assert.equal(run.phase, 'verify');
  assert.equal(run.status, 'running');
  assert.equal(run.cursor, '');
  assert.equal(run.total, 0);
  assert.equal(run.failedCount, 0);
  assert.equal(run.leaseToken, undefined);
  assert.equal(run.leaseUntil, undefined);
  const day = app.state.bijing_sync_days[DATE];
  assert.equal(day.checkCycle, CYCLE);
  for (const key of ['checkRunId', 'activeRunId', 'latestRunId', 'latestFullRunId']) assert.equal(day[key], run.runId);
});

test('an uploaded run supplies no cursor, items, or counters to the independent check', async () => {
  const old = activeRun({ status: 'uploaded' });
  const app = harness(withRun(old));
  const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.notEqual(run.runId, old._id);
  assert.equal(run.cursor, '');
  assert.equal(run.total, 0);
  assert.equal(run.failedCount, 0);
  assert.equal(run.attempt, 3);
  assert.deepEqual(app.state.bijing_sync_runs[old._id], old);
});

test('concurrent delivery creates only one check and increments attempts once', async () => {
  const app = harness();
  const runs = await Promise.all(Array.from({ length: 5 }, () => app.sourceCheck.ensureDailyCheck(DATE, CYCLE)));
  assert.equal(new Set(runs.map(run => run.runId)).size, 1);
  assert.equal(Object.keys(app.state.bijing_sync_runs).length, 1);
  assert.equal(app.state.bijing_sync_days[DATE].attempts, 1);
});

test('each newly authorized hour creates a fresh source check after the preceding check ends', async () => {
  const app = harness({ now: `${CYCLE}T03:00:00+08:00` });
  const firstKey = `${CYCLE}T03`;
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = firstKey;
  const first = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, firstKey);
  Object.assign(app.state.bijing_sync_runs[first.runId], { status: 'success', cursor: 'old-cursor', total: 100 });
  app.state.bijing_sync_days[DATE].activeRunId = '';
  const secondKey = `${CYCLE}T04`;
  app.setTime(`${CYCLE}T04:00:00+08:00`);
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = secondKey;
  const second = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, secondKey);
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.checkCycle, secondKey);
  assert.equal(second.cursor, '');
  assert.equal(second.total, 0);
  assert.equal(second.phase, 'verify');
  assert.equal(app.state.bijing_sync_days[DATE].checkCycle, secondKey);
  assert.equal(app.state.bijing_sync_days[DATE].checkRunId, second.runId);
  assert.equal(app.state.bijing_sync_runs[first.runId].total, 100);
});

test('duplicate delivery within an hour reuses failed checks without resetting them', async () => {
  const app = harness({ now: `${CYCLE}T03:00:00+08:00` });
  const key = `${CYCLE}T03`;
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = key;
  const runs = await Promise.all(Array.from({ length: 3 }, () => app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key)));
  assert.equal(new Set(runs.map(run => run.runId)).size, 1);
  const run = app.state.bijing_sync_runs[runs[0].runId];
  Object.assign(run, { status: 'failed', total: 60, cursor: 'verified-60', error: 'query unavailable', queryFailures: 3 });
  app.state.bijing_sync_days[DATE].activeRunId = '';
  const repeated = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key);
  assert.equal(repeated.runId, run._id);
  assert.equal(repeated.cursor, 'verified-60');
  assert.equal(repeated.error, 'query unavailable');
  assert.equal(Object.keys(app.state.bijing_sync_runs).length, 1);
  const nextKey = `${CYCLE}T04`;
  app.setTime(`${CYCLE}T04:00:00+08:00`);
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = nextKey;
  const retry = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, nextKey);
  assert.notEqual(retry.runId, run._id);
  assert.equal(retry.phase, 'verify');
  assert.equal(retry.cursor, '');
  assert.equal(retry.error, '');
});

test('stale and future hourly keys cannot create or replace the currently authorized check', async () => {
  const app = harness();
  const currentKey = `${CYCLE}T05`;
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = currentKey;
  for (const key of [CYCLE, `${CYCLE}T04`, `${CYCLE}T06`]) {
    assert.equal(await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key), null);
  }
  assert.equal(app.writes.length, 0);
  const current = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, currentKey);
  const before = clone(app.state);
  assert.equal(await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, `${CYCLE}T04`), null);
  assert.deepEqual(app.state, before);
  assert.equal(app.state.bijing_sync_days[DATE].checkRunId, current.runId);
});

test('a newer hourly authorization does not interrupt the previous running check', async () => {
  for (const live of [false, true]) {
    const key = `${CYCLE}T04`;
    const old = activeRun({ _id: 'previous-check', trigger: 'timer-check', sourceCheck: true, phase: 'verify',
      checkCycle: key, leaseUntil: live ? Date.parse(`${CYCLE}T05:01:00+08:00`) : 0 });
    const app = harness(withRun(old, { checkCycle: key, checkRunId: old._id }));
    const nextKey = `${CYCLE}T05`;
    app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = nextKey;
    const result = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, nextKey);
    assert.equal(result.runId, old._id);
    assert.equal(Boolean(result.busy), live);
    assert.equal(app.writes.length, 0);
    assert.equal(app.state.bijing_sync_days[DATE].checkCycle, key);
  }
});

test('the authorized 10:00 check can continue after its scheduling window closes', async () => {
  const key = `${CYCLE}T10`;
  const app = harness({ now: `${CYCLE}T10:00:00+08:00` });
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = key;
  const first = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key);
  app.setTime(`${CYCLE}T11:00:00+08:00`);
  assert.equal((await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key)).runId, first.runId);
  app.setTime('2026-10-11T01:59:59.999+08:00');
  assert.equal((await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key)).runId, first.runId);
  app.setTime('2026-10-11T02:00:00+08:00');
  assert.equal(await app.sourceCheck.ensureDailyCheck(DATE, CYCLE, key), null);
});

test('continuation never resets a same-cycle check in any phase or terminal state', async () => {
  for (const [status, phase] of [['running', 'verify'], ['running', 'retry'], ['running', 'reverify'], ['failed', 'verify'], ['partial', 'reverify'], ['success', 'retry']]) {
    const run = activeRun({ _id: 'existing-check', trigger: 'timer-check', sourceCheck: true, checkCycle: CYCLE, status, phase,
      cursor: 'verified-60', total: 80, failedCount: 12, queryFailures: 2, error: status === 'failed' ? 'query unavailable' : '' });
    const app = harness(withRun(run, { checkCycle: CYCLE, checkRunId: run._id }));
    const result = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
    assert.equal(result.runId, run._id);
    assert.equal(result.cursor, run.cursor);
    assert.deepEqual(app.state.bijing_sync_runs[run._id], run);
    assert.equal(app.writes.length, 0);
  }
});

test('a live upload blocks check creation until its lease expires', async () => {
  const old = activeRun({ leaseUntil: Date.parse(`${CYCLE}T05:01:00+08:00`) });
  const app = harness(withRun(old));
  const busy = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.equal(busy.runId, old._id);
  assert.equal(busy.busy, true);
  assert.equal(app.writes.length, 0);
  app.setTime(`${CYCLE}T05:01:00+08:00`);
  const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.equal(run.sourceCheck, true);
  const interrupted = app.state.bijing_sync_runs[old._id];
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.leaseToken, '');
  assert.equal(interrupted.leaseUntil, 0);
  assert.equal(app.state.bijing_sync_days[DATE].activeRunId, run.runId);
});

test('an automatic upload with no live lease is superseded without reading its progress', async () => {
  for (const extra of [{}, { phase: undefined, mode: undefined }]) {
    const old = activeRun(extra);
    const app = harness(withRun(old));
    const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
    assert.equal(run.phase, 'verify');
    assert.equal(run.cursor, '');
    assert.equal(app.state.bijing_sync_runs[old._id].status, 'failed');
  }
});

test('sourceCheck-enabled full uploads are superseded after lease expiry and are not treated as completed checks', async () => {
  const old = activeRun({ sourceCheck: true, leaseUntil: Date.parse(`${CYCLE}T05:01:00+08:00`) });
  const app = harness(withRun(old));
  const busy = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.equal(busy.runId, old._id);
  assert.equal(busy.busy, true);
  assert.equal(app.writes.length, 0);
  app.setTime(`${CYCLE}T05:01:00+08:00`);
  const check = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.notEqual(check.runId, old._id);
  assert.equal(check.trigger, 'timer-check');
  assert.equal(check.sourceCheck, true);
  assert.equal(check.phase, 'verify');
  assert.equal(check.cursor, '');
  assert.equal(check.total, 0);
  assert.equal(app.state.bijing_sync_runs[old._id].status, 'failed');
  assert.equal(app.state.bijing_sync_runs[old._id].leaseToken, '');
  assert.equal(app.state.bijing_sync_days[DATE].checkRunId, check.runId);
});

test('manual work, errors repairs, and existing verification retain their day lock', async () => {
  for (const extra of [{ trigger: 'manual' }, { trigger: 'timer-errors', mode: 'errors' }, { phase: 'verify' }]) {
    for (const live of [false, true]) {
      const old = activeRun({ ...extra, leaseUntil: live ? Date.parse(`${CYCLE}T05:01:00+08:00`) : 0 });
      const app = harness(withRun(old));
      const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
      assert.equal(run.runId, old._id);
      assert.equal(Boolean(run.busy), live);
      assert.equal(app.writes.length, 0);
      assert.equal(app.state.bijing_sync_days[DATE].activeRunId, old._id);
    }
  }
});

test('a manual full run completed before 05:00 cannot substitute for the daily source check', async () => {
  const old = activeRun({ trigger: 'manual', status: 'success', phase: 'reverify' });
  const app = harness(withRun(old));
  const run = await app.sourceCheck.ensureDailyCheck(DATE, CYCLE);
  assert.notEqual(run.runId, old._id);
  assert.equal(run.sourceCheck, true);
});

test('a check needs a running matching cycle and cannot start before 03:00 or after the next 02:00', async () => {
  for (const options of [
    { days: { [CHECK_CYCLE_ID]: null } },
    { days: { [CHECK_CYCLE_ID]: { cycleDate: CYCLE, status: 'complete' } } },
    { days: { [CHECK_CYCLE_ID]: { cycleDate: '2026-10-11', status: 'running' } } },
    { now: `${CYCLE}T02:59:59.999+08:00` },
    { now: '2026-10-11T02:00:00+08:00' },
  ]) {
    const app = harness(options);
    assert.equal(await app.sourceCheck.ensureDailyCheck(DATE, CYCLE), null);
    assert.equal(app.writes.length, 0);
  }
  for (const now of [`${CYCLE}T03:00:00+08:00`, `${CYCLE}T11:00:00+08:00`, '2026-10-11T01:59:59.999+08:00']) {
    const app = harness({ now });
    assert.equal((await app.sourceCheck.ensureDailyCheck(DATE, CYCLE)).sourceCheck, true);
  }
});

test('crossing 02:00 during the transaction prevents superseding an old upload', async () => {
  const old = activeRun();
  const app = harness({ ...withRun(old), now: '2026-10-11T01:59:59.999+08:00',
    afterRead(name, id, now, setTime) { if (name === 'bijing_sync_runs' && id === old._id) setTime('2026-10-11T02:00:00+08:00'); } });
  assert.equal(await app.sourceCheck.ensureDailyCheck(DATE, CYCLE), null);
  assert.equal(app.writes.length, 0);
  assert.equal(app.state.bijing_sync_runs[old._id].status, 'running');
});

test('invalid date pairs and broken same-cycle references fail without creating another check', async () => {
  for (const [date, cycle] of [['2026-02-30', CYCLE], [DATE, 'bad'], ['2026-10-08', CYCLE]]) {
    const app = harness();
    await assert.rejects(app.sourceCheck.ensureDailyCheck(date, cycle), /自动核对/);
    assert.equal(app.writes.length, 0);
  }
  const app = harness({ days: { [DATE]: { checkCycle: CYCLE, checkRunId: 'missing' } } });
  await assert.rejects(app.sourceCheck.ensureDailyCheck(DATE, CYCLE), /任务记录缺失或不匹配/);
  assert.equal(app.writes.length, 0);
});

test('failed check creation rolls back both upload interruption and day ownership', async () => {
  const old = activeRun();
  const app = harness({ ...withRun(old), failWrite(name) { return name === 'bijing_sync_runs'; } });
  const before = clone(app.state);
  await assert.rejects(app.sourceCheck.ensureDailyCheck(DATE, CYCLE), /write unavailable/);
  assert.deepEqual(app.state, before);
});

test('scheduler ensures a fresh check before resuming it, without processing it twice', async () => {
  const app = harness();
  const key = `${CYCLE}T05`;
  app.state.bijing_sync_days[CHECK_CYCLE_ID].cycleKey = key;
  const calls = [];
  const schedule = createDailySchedule({ db: app.db, now: app.now, jobs: {
    async ensureDailyCheck(...args) { calls.push(['ensure', ...args]); return app.sourceCheck.ensureDailyCheck(...args); },
    async resumeActive(scope) {
      calls.push(['resume', scope]);
      const run = app.state.bijing_sync_runs[app.state.bijing_sync_days[DATE].checkRunId];
      assert.equal(run.sourceCheck, true);
      return { runId: run._id, phase: 'verify', status: 'running' };
    },
    async processChunk() { assert.fail('ensure must not execute the check directly'); },
  } });
  const result = await schedule.timer('resumeBijingBatches');
  assert.equal(result.phase, 'verify');
  assert.deepEqual(calls, [['ensure', DATE, CYCLE, key], ['resume', { recordDate: DATE }]]);
});

test('scheduler leaves a live upload alone, then ensures its replacement on a continuation', async () => {
  const old = activeRun({ leaseUntil: Date.parse(`${CYCLE}T05:01:00+08:00`) });
  const app = harness(withRun(old));
  let resumes = 0;
  const schedule = createDailySchedule({ db: app.db, now: app.now, jobs: {
    ensureDailyCheck: app.sourceCheck.ensureDailyCheck,
    async resumeActive() { resumes++; return { status: 'running', phase: 'verify' }; },
  } });
  assert.equal((await schedule.timer('checkBijingSync')).busy, true);
  assert.equal(resumes, 0);
  app.setTime(`${CYCLE}T05:01:00+08:00`);
  await schedule.timer('resumeBijingBatches');
  assert.equal(resumes, 1);
  assert.equal(app.state.bijing_sync_runs[app.state.bijing_sync_days[DATE].checkRunId].sourceCheck, true);
});

test('a cycle opened between the hourly worker reads is checked before an empty queue can complete it', async () => {
  for (const initialCycle of [null, { _id: CHECK_CYCLE_ID, cycleDate: '2026-10-09', status: 'complete' }]) {
    const app = harness({ days: { [CHECK_CYCLE_ID]: initialCycle,
      [DATE]: { _id: DATE, recordDate: DATE, status: 'uploaded', activeRunId: '' } } });
    let resumes = 0, ensures = 0;
    const schedule = createDailySchedule({ db: app.db, now: app.now, jobs: {
      async ensureDailyCheck(...args) { ensures++; return app.sourceCheck.ensureDailyCheck(...args); },
      async resumeActive() {
        if (++resumes === 1) {
          // The separate 05:00 worker has opened its cycle but has not created
          // a check yet when this hourly worker resumes after its first read.
          app.state.bijing_sync_days[CHECK_CYCLE_ID] = { _id: CHECK_CYCLE_ID, cycleDate: CYCLE,
            recordDate: DATE, status: 'running', cursor: '' };
          return null;
        }
        const day = app.state.bijing_sync_days[DATE];
        const check = app.state.bijing_sync_runs[day.checkRunId];
        assert.equal(check.sourceCheck, true);
        return { runId: check._id, phase: 'verify', status: 'running' };
      },
    } });
    const result = await schedule.timer('resumeBijingBatches');
    assert.equal(result.phase, 'verify');
    assert.equal(ensures, 1);
    assert.equal(resumes, 2);
    assert.equal(Object.keys(app.state.bijing_sync_runs).length, 1);
    assert.equal(app.state.bijing_sync_days[CHECK_CYCLE_ID].status, 'running');
  }
});

test('a manual task releasing its day lock during resume cannot bypass the independent source check', async () => {
  const old = activeRun({ trigger: 'manual' });
  const app = harness(withRun(old));
  let resumes = 0;
  const schedule = createDailySchedule({ db: app.db, now: app.now, jobs: {
    ensureDailyCheck: app.sourceCheck.ensureDailyCheck,
    async resumeActive() {
      if (++resumes === 1) {
        // Another worker finished the manual task after ensure returned it.
        app.state.bijing_sync_runs[old._id].status = 'success';
        app.state.bijing_sync_days[DATE].activeRunId = '';
        return null;
      }
      return { runId: app.state.bijing_sync_days[DATE].checkRunId, status: 'running', phase: 'verify' };
    },
  } });
  const result = await schedule.timer('resumeBijingBatches');
  assert.notEqual(result.runId, old._id);
  assert.equal(result.phase, 'verify');
  assert.equal(resumes, 2);
  assert.equal(app.state.bijing_sync_days[CHECK_CYCLE_ID].status, 'running');
});

test('cycle completion transaction requires its own persisted, terminal source check', async () => {
  for (const variant of ['missing-day', 'wrong-cycle', 'missing-run', 'upload-only', 'running', 'failed', 'partial', 'success']) {
    const check = activeRun({ _id: 'check-run', trigger: 'timer-check', phase: 'verify', sourceCheck: variant !== 'upload-only',
      checkCycle: CYCLE, status: ['failed', 'partial', 'success'].includes(variant) ? variant : 'running' });
    const options = withRun(check, { checkCycle: variant === 'wrong-cycle' ? '2026-10-09' : CYCLE,
      checkRunId: variant === 'missing-run' ? 'missing' : check._id, activeRunId: '' });
    if (variant === 'missing-day') delete options.days[DATE];
    const app = harness(options);
    const schedule = createDailySchedule({ db: app.db, now: app.now, jobs: {
      // The transaction must verify persisted state even if the earlier
      // ensure response described an already-completed check.
      async ensureDailyCheck() { return { runId: check._id, status: 'success' }; },
      async resumeActive() { return null; },
    } });
    assert.equal(await schedule.timer('resumeBijingBatches'), null);
    const terminal = ['failed', 'partial', 'success'].includes(variant);
    assert.equal(app.state.bijing_sync_days[CHECK_CYCLE_ID].status, terminal ? 'complete' : 'running', variant);
  }
});
