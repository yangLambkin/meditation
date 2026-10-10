const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailySchedule, CHECK_CYCLE_ID } = require('../cloudfunctions/bijingSync/dailySchedule');

const clone = value => value == null ? value : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const errorRow = (date, suffix = 'one') => ({ _id: `${date}_${suffix}`, recordDate: date });
const cycleFor = (recordDate = '2026-10-09', cycleDate = '2026-10-10') => ({ cycleDate, recordDate, cursor: '', status: 'running' });

function harness(options = {}) {
  let timestamp = Date.parse(options.now || '2026-10-10T05:00:00+08:00');
  let transaction = Promise.resolve();
  const state = { cycle: clone(options.cycle || null), days: clone(options.days || {}), runs: clone(options.runs || {}), errors: clone(options.errors || []) };
  const calls = [], changes = [], repairs = new Map(), scans = [];
  const db = {
    command: { gt: value => ({ gt: value }) },
    collection(name) {
      if (name === 'bijing_sync_days') return {
        doc(id) {
          if (id !== CHECK_CYCLE_ID) return {
            async get() { return { data: clone(state.days[id] || null) }; },
          };
          return {
            async get() { if (options.readError) throw options.readError; return { data: clone(state.cycle) }; },
            async set({ data }) { state.cycle = { _id: id, ...clone(data) }; changes.push(clone(state.cycle)); },
            async update({ data }) { assert.ok(state.cycle); Object.assign(state.cycle, clone(data)); changes.push(clone(state.cycle)); },
          };
        },
      };
      if (name === 'bijing_sync_runs') return { doc(id) { return { async get() { return { data: clone(state.runs[id] || null) }; } }; } };
      assert.equal(name, 'bijing_sync_errors');
      let filter = {}, maximum;
      const query = {
        where(value) { filter = value; return query; },
        orderBy(key, direction) { assert.equal(key, '_id'); assert.equal(direction, 'asc'); return query; },
        limit(value) { maximum = value; return query; },
        async get() {
          assert.equal(maximum, 1);
          assert.equal(typeof filter.recordDate, 'string', 'error scans must always specify their target day');
          scans.push(clone(filter));
          const data = clone(state.errors.filter(row => row.recordDate === filter.recordDate && (!filter._id || row._id > filter._id.gt))
            .sort((a, b) => a._id.localeCompare(b._id)).slice(0, maximum));
          if (options.afterErrorScan) await options.afterErrorScan(data, state);
          return { data };
        },
      };
      return query;
    },
    async runTransaction(fn) {
      const pending = transaction.then(async () => {
        const before = clone(state.cycle);
        try { return await fn(db); } catch (error) { state.cycle = before; throw error; }
      });
      transaction = pending.catch(() => {});
      return pending;
    },
  };
  const jobs = {
    async startDailyUpload() { calls.push(['startDailyUpload']); return options.uploadRun || { runId: 'daily-upload', status: 'running' }; },
    async resumeActive(scope) { calls.push(['resumeActive', clone(scope)]); return options.resumeActive ? options.resumeActive(scope) : null; },
    async startScheduledRepair(recordDate, cycleDate, cycleKey) {
      calls.push(['startScheduledRepair', recordDate, cycleDate]);
      if (options.startError) throw options.startError;
      if (options.startScheduledRepair) return options.startScheduledRepair(recordDate, cycleDate, state);
      const key = `${recordDate}/${cycleKey || cycleDate}`;
      if (!repairs.has(key)) repairs.set(key, { runId: `repair-${key}`, mode: 'errors', status: 'running' });
      const run = repairs.get(key);
      if (options.afterStartRepair) await options.afterStartRepair(run);
      return run;
    },
    async processChunk(runId) {
      calls.push(['processChunk', runId]);
      if (options.processChunk) return options.processChunk(runId, state);
      return { runId, status: 'running' };
    },
  };
  return { schedule: createDailySchedule({ db, jobs, now: () => timestamp }), state, calls, changes, repairs, scans,
    setTime(value) { timestamp = Date.parse(value); } };
}

test('the 02:00 trigger creates or reuses the full upload and processes one batch', async () => {
  const app = harness({ now: '2026-10-10T02:00:00+08:00' });
  assert.deepEqual(await app.schedule.timer('dailySyncBijing'), { runId: 'daily-upload', status: 'running' });
  assert.deepEqual(app.calls, [['startDailyUpload'], ['processChunk', 'daily-upload']]);
  assert.equal(app.state.cycle, null);
  assert.equal(app.scans.length, 0);
});

test('continuation, unknown and missing triggers resume only the latest ended day without creating work', async () => {
  for (const trigger of ['resumeBijingBatches', 'unknown', undefined]) {
    const app = harness({ errors: [errorRow('2026-10-08'), errorRow('2026-10-09')] });
    assert.equal(await app.schedule.timer(trigger), null);
    assert.deepEqual(app.calls, [['resumeActive', { recordDate: '2026-10-09' }]]);
    assert.equal(app.state.cycle, null);
    assert.equal(app.scans.length, 0);
    assert.equal(app.state.errors.length, 2);
  }
});

test('continuation keeps the previous meditation day until the exact Beijing 02:00 boundary', async () => {
  for (const [now, recordDate] of [
    ['2026-10-10T00:00:00+08:00', '2026-10-08'],
    ['2026-10-10T01:59:59.999+08:00', '2026-10-08'],
    ['2026-10-10T02:00:00+08:00', '2026-10-09'],
    ['2027-01-01T01:59:59.999+08:00', '2026-12-30'],
    ['2027-01-01T02:00:00+08:00', '2026-12-31'],
  ]) {
    const app = harness({ now });
    await app.schedule.timer('resumeBijingBatches');
    assert.deepEqual(app.calls, [['resumeActive', { recordDate }]], now);
  }
});

test('check cycle starts at Beijing 03:00 and persists its hour and the previous date as its sole target', async () => {
  const app = harness({ now: '2026-10-10T02:59:59.999+08:00' });
  assert.equal(await app.schedule.timer('checkBijingSync'), null);
  assert.equal(app.state.cycle, null);
  app.setTime('2026-10-10T03:00:00+08:00');
  assert.equal(await app.schedule.timer('checkBijingSync'), null);
  assert.equal(app.state.cycle.cycleDate, '2026-10-10');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T03');
  assert.equal(app.state.cycle.recordDate, '2026-10-09');
  assert.equal(app.state.cycle.status, 'complete');
  assert.deepEqual(app.scans, [{ recordDate: '2026-10-09' }]);
});

test('same-hour duplicate delivery preserves the completed cycle until the next scheduled hour', async () => {
  const app = harness();
  await app.schedule.timer('checkBijingSync');
  const completed = clone(app.state.cycle);
  app.state.errors.push(errorRow('2026-10-09'));
  app.setTime('2026-10-10T05:30:00+08:00');
  assert.equal(await app.schedule.timer('checkBijingSync'), null);
  assert.deepEqual(app.state.cycle, completed);
  assert.equal(app.repairs.size, 0);
  app.setTime('2026-10-10T06:00:00+08:00');
  const next = await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T06');
  assert.equal(next.runId, 'repair-2026-10-09/2026-10-10T06');
  assert.equal(app.repairs.size, 1);
});

test('active target-day work has priority and consumes the whole invocation', async () => {
  const active = { runId: 'active-full', status: 'running' };
  const app = harness({ errors: [errorRow('2026-10-08'), errorRow('2026-10-09')], resumeActive: async () => active });
  assert.deepEqual(await app.schedule.timer('checkBijingSync'), active);
  assert.equal(app.state.cycle.status, 'running');
  assert.equal(app.state.cycle.recordDate, '2026-10-09');
  assert.deepEqual(app.calls, [['resumeActive', { recordDate: '2026-10-09' }]]);
  assert.equal(app.scans.length, 0);
});

test('a cycle repairs only its target date once and retains all historical and future error rows', async () => {
  const errors = [errorRow('2026-01-01'), errorRow('2026-10-08'), errorRow('2026-10-09', 'a'),
    errorRow('2026-10-09', 'b'), errorRow('2026-10-10')];
  const app = harness({ errors });
  const first = await app.schedule.timer('checkBijingSync');
  assert.equal(first.runId, 'repair-2026-10-09/2026-10-10T05');
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.status, 'complete');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 1);
  assert.deepEqual([...app.repairs.keys()], ['2026-10-09/2026-10-10T05']);
  assert.deepEqual(app.state.errors, errors);
  assert.ok(app.scans.every(filter => filter.recordDate === '2026-10-09'));
});

test('historical errors alone complete the target-day cycle without starting a repair', async () => {
  const errors = [errorRow('2026-01-01'), errorRow('2026-10-08')];
  const app = harness({ errors });
  assert.equal(await app.schedule.timer('checkBijingSync'), null);
  assert.equal(app.state.cycle.status, 'complete');
  assert.equal(app.repairs.size, 0);
  assert.deepEqual(app.state.errors, errors);
});

test('an established target-day cycle continues across midnight until 02:00', async () => {
  const app = harness({ cycle: cycleFor('2026-10-08', '2026-10-09'),
    now: '2026-10-10T01:59:59.999+08:00', errors: [errorRow('2026-10-08')] });
  await app.schedule.timer('resumeBijingBatches');
  assert.deepEqual(app.calls[0], ['resumeActive', { recordDate: '2026-10-08' }]);
  assert.deepEqual(app.calls[1], ['startScheduledRepair', '2026-10-08', '2026-10-09']);
  assert.equal(app.state.cycle.cycleDate, '2026-10-09');
});

test('at 02:00 a stale cycle is retained without scanning or automatically repairing its historical date', async () => {
  const cycle = cycleFor('2026-10-08', '2026-10-09');
  const errors = [errorRow('2026-10-08'), errorRow('2026-10-09')];
  const app = harness({ cycle, now: '2026-10-10T02:00:00+08:00', errors });
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.deepEqual(app.calls, [['resumeActive', { recordDate: '2026-10-09' }]]);
  assert.deepEqual(app.state.cycle, cycle);
  assert.deepEqual(app.state.errors, errors);
  assert.equal(app.scans.length, 0);
  assert.equal(app.repairs.size, 0);
});

test('legacy cycles infer their target from cycleDate and obey the same 02:00 cutoff', async () => {
  for (const [now, shouldRepair] of [
    ['2026-10-10T01:59:59.999+08:00', true],
    ['2026-10-10T02:00:00+08:00', false],
  ]) {
    const legacy = { cycleDate: '2026-10-09', cursor: '', status: 'running' };
    const app = harness({ cycle: legacy, now, errors: [errorRow('2026-10-08')] });
    const result = await app.schedule.timer('resumeBijingBatches');
    assert.equal(Boolean(result), shouldRepair, now);
    assert.equal(app.repairs.size, shouldRepair ? 1 : 0);
    if (shouldRepair) assert.deepEqual(app.calls[1], ['startScheduledRepair', '2026-10-08', '2026-10-09']);
    else {
      assert.deepEqual(app.state.cycle, legacy);
      assert.equal(app.scans.length, 0);
    }
  }
});

test('the following 05:00 targets the new preceding day and does not retry the former target again', async () => {
  const app = harness({ errors: [errorRow('2026-10-09'), errorRow('2026-10-10')] });
  await app.schedule.timer('checkBijingSync');
  await app.schedule.timer('resumeBijingBatches');
  app.setTime('2026-10-11T05:00:00+08:00');
  await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleDate, '2026-10-11');
  assert.equal(app.state.cycle.recordDate, '2026-10-10');
  assert.deepEqual([...app.repairs.keys()], ['2026-10-09/2026-10-10T05', '2026-10-10/2026-10-11T05']);
  assert.equal(app.state.errors.length, 2);
});

test('a malformed target-day error ID is skipped without blocking a later valid target-day error', async () => {
  const app = harness({ errors: [{ _id: '0000_bad', recordDate: '2026-10-09' }, errorRow('2026-10-09'), errorRow('2026-02-30')] });
  assert.equal(await app.schedule.timer('checkBijingSync'), null);
  assert.equal(app.state.cycle.cursor, '0000_bad');
  await app.schedule.timer('resumeBijingBatches');
  assert.equal(app.repairs.size, 1);
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 1);
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
});

test('repair creation failure leaves the target-day cursor unchanged for the next continuation', async () => {
  const app = harness({ errors: [errorRow('2026-10-09')], startError: new Error('database unavailable') });
  await assert.rejects(app.schedule.timer('checkBijingSync'), /database unavailable/);
  assert.equal(app.state.cycle.cursor, '');
  assert.equal(app.state.cycle.status, 'running');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 0);
});

test('a concurrently resumed full or legacy run finishes before the cycle claims its errors repair', async () => {
  for (const mode of ['full', undefined]) {
    for (const status of ['running', 'waiting', 'interrupted']) {
      let starts = 0;
      const app = harness({ cycle: cycleFor(), errors: [errorRow('2026-10-09')],
        startScheduledRepair: async (recordDate, cycleDate, state) => {
          const run = ++starts === 1 ? { runId: 'resumed-full', mode, status } :
            { runId: 'scheduled-repair', mode: 'errors', status: 'running' };
          state.days[recordDate] = { activeRunId: run.runId };
          return run;
        },
        processChunk: async (runId, state) => {
          assert.equal(state.cycle.cursor, runId === 'resumed-full' ? '' : '2026-10-09~');
          state.days['2026-10-09'].activeRunId = '';
          return { runId, status: 'success' };
        },
      });
      assert.equal((await app.schedule.timer('resumeBijingBatches')).runId, 'resumed-full');
      assert.equal(app.state.cycle.cursor, '');
      assert.equal(app.state.cycle.status, 'running');
      assert.equal((await app.schedule.timer('resumeBijingBatches')).runId, 'scheduled-repair');
      assert.equal(app.state.cycle.cursor, '2026-10-09~');
      assert.deepEqual(app.calls.filter(call => call[0] === 'processChunk'),
        [['processChunk', 'resumed-full'], ['processChunk', 'scheduled-repair']]);
    }
  }
});

test('a terminal full run returned after the repair allowance was used advances without HTTP', async () => {
  const app = harness({ cycle: cycleFor(), errors: [errorRow('2026-10-09')],
    startScheduledRepair: async () => ({ runId: 'full', mode: 'full', status: 'failed' }) });
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 0);
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.status, 'complete');
});

test('a full run restored after the empty error scan prevents premature cycle completion', async () => {
  let scans = 0;
  const app = harness({ cycle: cycleFor(), afterErrorScan: async (rows, state) => {
    if (++scans === 1) state.days['2026-10-09'] = { activeRunId: 'restored-full' };
  } });
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.status, 'running');
  assert.equal(app.state.cycle.cursor, '');
  // Once the restored full run completes, its new error remains eligible for
  // the cycle's one errors-only repair instead of being stranded by completion.
  app.state.days['2026-10-09'].activeRunId = '';
  app.state.errors.push(errorRow('2026-10-09'));
  await app.schedule.timer('resumeBijingBatches');
  assert.equal(app.repairs.size, 1);
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
});

test('a different active run appearing before the cursor transaction defers the repair claim', async () => {
  let app;
  app = harness({ cycle: cycleFor(), errors: [errorRow('2026-10-09')],
    afterStartRepair: async () => { app.state.days['2026-10-09'] = { activeRunId: 'new-full' }; } });
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.cursor, '');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 0);
});

test('a restored full run finishing during the empty error scan still preserves its new errors for repair', async () => {
  let scans = 0;
  const app = harness({ cycle: cycleFor(), days: { '2026-10-09': {
    activeRunId: '', latestRunId: 'full', status: 'failed', updatedAt: 1,
  } }, afterErrorScan: async (rows, state) => {
    if (++scans !== 1) return;
    state.days['2026-10-09'] = { activeRunId: '', latestRunId: 'full', status: 'partial', updatedAt: 2 };
    state.errors.push(errorRow('2026-10-09'));
  } });
  assert.equal(await app.schedule.timer('resumeBijingBatches'), null);
  assert.equal(app.state.cycle.status, 'running');
  await app.schedule.timer('resumeBijingBatches');
  assert.equal(app.repairs.size, 1);
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
});

test('the repair is durable and its cursor committed before processing can fail', async () => {
  let app;
  app = harness({ errors: [errorRow('2026-10-09')], processChunk: async (runId, state) => {
    assert.equal(app.repairs.size, 1);
    assert.equal(state.cycle.cursor, '2026-10-09~');
    throw new Error('worker killed');
  } });
  await assert.rejects(app.schedule.timer('checkBijingSync'), /worker killed/);
  assert.equal(app.repairs.size, 1);
  assert.equal(app.state.cycle.cursor, '2026-10-09~');
});

test('concurrent continuations claim the target date once and only the cursor winner processes it', async () => {
  const entered = deferred(), release = deferred();
  let starts = 0;
  const app = harness({ cycle: cycleFor(), errors: [errorRow('2026-10-09')],
    afterStartRepair: async () => { if (++starts === 2) entered.resolve(); await release.promise; } });
  const pending = Promise.all([app.schedule.timer('resumeBijingBatches'), app.schedule.timer('resumeBijingBatches')]);
  await entered.promise;
  release.resolve();
  const results = await pending;
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(app.repairs.size, 1);
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 1);
});

test('a paused pre-02:00 worker cannot overwrite the next 05:00 target-day cycle', async () => {
  const entered = deferred(), release = deferred();
  let hold = true;
  const app = harness({ cycle: cycleFor('2026-10-08', '2026-10-09'), now: '2026-10-10T01:00:00+08:00',
    errors: [errorRow('2026-10-08'), errorRow('2026-10-09')],
    afterStartRepair: async () => { if (hold) { entered.resolve(); await release.promise; } } });
  const oldWorker = app.schedule.timer('resumeBijingBatches');
  await entered.promise;
  hold = false;
  app.setTime('2026-10-10T05:00:00+08:00');
  await app.schedule.timer('checkBijingSync');
  const current = clone(app.state.cycle);
  release.resolve();
  assert.equal(await oldWorker, null);
  assert.deepEqual(app.state.cycle, current);
  assert.equal(current.cycleDate, '2026-10-10');
  assert.equal(current.recordDate, '2026-10-09');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 1);
});

test('a repair created across the 02:00 boundary is not processed or allowed to advance the stale cycle', async () => {
  const entered = deferred(), release = deferred();
  const cycle = cycleFor('2026-10-08', '2026-10-09');
  const app = harness({ cycle, now: '2026-10-10T01:59:59.999+08:00', errors: [errorRow('2026-10-08')],
    afterStartRepair: async () => { entered.resolve(); await release.promise; } });
  const worker = app.schedule.timer('resumeBijingBatches');
  await entered.promise;
  app.setTime('2026-10-10T02:00:00+08:00');
  release.resolve();
  assert.equal(await worker, null);
  assert.deepEqual(app.state.cycle, cycle);
  assert.equal(app.repairs.size, 1, 'the durable task remains available for manual inspection');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 0);
});

test('unexpected database errors are surfaced instead of being treated as an empty cycle', async () => {
  const app = harness({ readError: new Error('permission denied') });
  await assert.rejects(app.schedule.timer('resumeBijingBatches'), /permission denied/);
  assert.equal(app.repairs.size, 0);
});


test('new hourly delivery preserves an active prior cycle and repeated delivery cannot open another round', async () => {
  const cycle = { ...cycleFor(), cycleKey: '2026-10-10T03', lastTriggerKey: '2026-10-10T03' };
  const app = harness({ cycle, now: '2026-10-10T04:00:00+08:00',
    days: { '2026-10-09': { activeRunId: 'checking' } }, runs: { checking: { status: 'running' } },
    resumeActive: async () => ({ runId: 'checking', status: 'running', busy: true }) });
  await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T03');
  assert.equal(app.state.cycle.lastTriggerKey, '2026-10-10T04');
  app.state.cycle.status = 'complete';
  app.state.days['2026-10-09'].activeRunId = '';
  app.state.runs.checking.status = 'success';
  app.setTime('2026-10-10T04:20:00+08:00');
  await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T03');
  app.setTime('2026-10-10T05:00:00+08:00');
  await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T05');
});

test('check trigger starts cycles only during Beijing hours 03 through 10 inclusive', async () => {
  for (const hour of [0, 1, 2, 11, 12, 23]) {
    const app = harness({ now: `2026-10-10T${String(hour).padStart(2, '0')}:00:00+08:00`, cycle: cycleFor() });
    assert.equal(await app.schedule.timer('checkBijingSync'), null);
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.changes, []);
  }
  const app = harness({ now: '2026-10-10T10:00:00+08:00' });
  await app.schedule.timer('checkBijingSync');
  assert.equal(app.state.cycle.cycleKey, '2026-10-10T10');
});

test('a stale hourly worker cannot advance a newer cycle for the same record date', async () => {
  const entered = deferred(), release = deferred();
  let hold = true;
  const cycle = { ...cycleFor(), cycleKey: '2026-10-10T03', lastTriggerKey: '2026-10-10T03' };
  const app = harness({ cycle, now: '2026-10-10T03:00:00+08:00', errors: [errorRow('2026-10-09')],
    afterStartRepair: async () => { if (hold) { entered.resolve(); await release.promise; } } });
  const oldWorker = app.schedule.timer('resumeBijingBatches');
  await entered.promise;
  hold = false;
  app.setTime('2026-10-10T04:00:00+08:00');
  await app.schedule.timer('checkBijingSync');
  const current = clone(app.state.cycle);
  release.resolve();
  assert.equal(await oldWorker, null);
  assert.deepEqual(app.state.cycle, current);
  assert.equal(current.cycleKey, '2026-10-10T04');
  assert.equal(app.calls.filter(call => call[0] === 'processChunk').length, 1);
});
