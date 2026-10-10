const DAYS = 'bijing_sync_days';
const RUNS = 'bijing_sync_runs';
const ERRORS = 'bijing_sync_errors';
const CHECK_CYCLE_ID = '__daily_check_cycle__';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const previousDate = date => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const getCycleKey = cycle => cycle && (cycle.cycleKey || cycle.cycleDate);
const inCheckHours = timestamp => {
  const hour = new Date(timestamp + BEIJING_OFFSET_MS).getUTCHours();
  return hour >= 3 && hour <= 10;
};

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

// The 02:00 trigger uploads. Hourly checks from 03:00 through 10:00 either
// resume unfinished work or start a fresh comparison of the latest ended day.
function createDailySchedule({ db, jobs, now = Date.now }) {
  // At 00:00–01:59 the current meditation day is still open, so continue the
  // previous completed one until the 02:00 boundary advances the target.
  const latestRecordDate = () => new Date(now() + BEIJING_OFFSET_MS - 2 * 60 * 60 * 1000 - DAY_MS).toISOString().slice(0, 10);
  async function readDocument(collection, id, database = db) {
    try { return (await database.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
      throw error;
    }
  }
  const readDay = (id, database = db) => readDocument(DAYS, id, database);
  const readCycle = (database = db) => readDay(CHECK_CYCLE_ID, database);

  async function openCheckCycle() {
    const timestamp = now();
    const beijingTime = new Date(timestamp + BEIJING_OFFSET_MS);
    const cycleDate = beijingTime.toISOString().slice(0, 10);
    const cycleKey = beijingTime.toISOString().slice(0, 13);
    const recordDate = previousDate(cycleDate);
    await db.runTransaction(async tx => {
      const current = await readCycle(tx);
      // A repeated hourly delivery never starts another check, including when
      // that hour was spent completing a run started in an earlier hour.
      if (current && (current.lastTriggerKey || getCycleKey(current)) >= cycleKey) return;
      if (current && current.status === 'running' && previousDate(current.cycleDate) === recordDate) {
        const day = await readDay(recordDate, tx);
        const activeId = day && (day.activeRunId || (day.checkCycle === getCycleKey(current) && day.checkRunId));
        const active = activeId ? await readDocument(RUNS, activeId, tx) : null;
        const checkNotEstablished = jobs.ensureDailyCheck && (!day || day.checkCycle !== getCycleKey(current) || !day.checkRunId);
        if ((active && active.status === 'running') || checkNotEstablished) {
          await tx.collection(DAYS).doc(CHECK_CYCLE_ID).update({ data: { lastTriggerKey: cycleKey, updatedAt: timestamp } });
          return;
        }
      }
      await tx.collection(DAYS).doc(CHECK_CYCLE_ID).set({ data: {
        cycleDate, cycleKey, lastTriggerKey: cycleKey, recordDate, cursor: '', status: 'running', startedAt: timestamp,
        updatedAt: timestamp, completedAt: null,
      } });
    });
  }

  async function advanceCycle(expected, patch, repairRunId = '', scannedDay) {
    return db.runTransaction(async tx => {
      const current = await readCycle(tx);
      if (!current || current.status !== 'running' || getCycleKey(current) !== getCycleKey(expected) ||
          previousDate(current.cycleDate) !== latestRecordDate() ||
          (current.cursor || '') !== (expected.cursor || '')) return false;
      // Another worker may have restored a full run since resumeActive checked.
      // Its day document participates in this transaction so it cannot lose the
      // later repair pass to a cursor advance or an early cycle completion.
      const day = await readDay(previousDate(current.cycleDate), tx);
      if (day && day.activeRunId && day.activeRunId !== repairRunId) return false;
      if (jobs.ensureDailyCheck) {
        // A concurrent continuation may observe a newly opened cycle before its
        // hourly worker establishes the check. An empty error queue is not proof
        // that the source data was checked for that cycle.
        if (!day || day.checkCycle !== getCycleKey(current) || !day.checkRunId) return false;
        const check = await readDocument(RUNS, day.checkRunId, tx);
        if (!check || !check.sourceCheck || check.checkCycle !== getCycleKey(current) ||
            check.recordDate !== previousDate(current.cycleDate) ||
            !['success', 'partial', 'failed'].includes(check.status)) return false;
      }
      // A restored run can also finish between the empty queue read and this
      // transaction. Re-scan if its progress changed while the queue was read.
      if (patch.status === 'complete' && (Boolean(day) !== Boolean(scannedDay) ||
          ['latestRunId', 'activeRunId', 'status', 'updatedAt'].some(key => (day || {})[key] !== (scannedDay || {})[key]))) return false;
      await tx.collection(DAYS).doc(CHECK_CYCLE_ID).update({ data: { ...patch, updatedAt: now() } });
      return true;
    });
  }

  async function resume() {
    const recordDate = latestRecordDate();
    const authorizedCycle = await readCycle();
    if (jobs.ensureDailyCheck && authorizedCycle && authorizedCycle.status === 'running' &&
        validDate(authorizedCycle.cycleDate) && previousDate(authorizedCycle.cycleDate) === recordDate) {
      const check = await jobs.ensureDailyCheck(recordDate, authorizedCycle.cycleDate, getCycleKey(authorizedCycle));
      if (check && check.busy) return check;
    }
    const active = await jobs.resumeActive({ recordDate });
    if (active != null) return active;
    const cycle = await readCycle();
    if (!cycle || cycle.status !== 'running' || !validDate(cycle.cycleDate)) return null;
    if (previousDate(cycle.cycleDate) !== recordDate) return null;
    if (jobs.ensureDailyCheck) {
      // Another hourly delivery may have opened this cycle after the first read, or a
      // manual task may have released the day lock while resumeActive ran.
      const check = await jobs.ensureDailyCheck(recordDate, cycle.cycleDate, getCycleKey(cycle));
      if (!check) return null;
      if (check.busy) return check;
      if (check.status === 'running') return jobs.resumeActive({ recordDate });
    }
    const scannedDay = await readDay(recordDate);
    const filter = { recordDate, ...(cycle.cursor ? { _id: db.command.gt(cycle.cursor) } : {}) };
    const rows = (await db.collection(ERRORS).where(filter).orderBy('_id', 'asc').limit(1).get()).data;
    const row = rows[0];
    if (!row) {
      await advanceCycle(cycle, { status: 'complete', completedAt: now() }, '', scannedDay);
      return null;
    }
    // Malformed rows cannot start a job or prevent valid later dates advancing.
    if (!validDate(row.recordDate) || typeof row._id !== 'string' || !row._id.startsWith(`${row.recordDate}_`)) {
      if (typeof row._id !== 'string') throw new Error('同步错误记录缺少有效ID');
      await advanceCycle(cycle, { cursor: row._id });
      return null;
    }
    // Create the durable job before claiming the scan cursor. A killed worker
    // leaves either an unchanged cursor or a job discoverable by resumeActive.
    const run = await jobs.startScheduledRepair(row.recordDate, cycle.cycleDate, getCycleKey(cycle));
    if (!run || typeof run.runId !== 'string' || !run.runId) throw new Error('失败修复任务未成功建立');
    // The day lock can return a full run that another worker just resumed.
    // Finish that work before claiming this cycle's errors-only repair pass.
    if (run.mode !== 'errors' && ['running', 'waiting', 'interrupted'].includes(run.status)) {
      return jobs.processChunk(run.runId);
    }
    // A terminal full run can be returned after this cycle's repair allowance
    // was used and a later manual full run replaced the latest run. Skip it
    // without sending HTTP, but only while no other run owns the day lock.
    const repairRunId = run.mode === 'errors' ? run.runId : '';
    if (!await advanceCycle(cycle, { cursor: `${row.recordDate}~` }, repairRunId)) return null;
    return repairRunId ? jobs.processChunk(run.runId) : null;
  }

  async function timer(triggerName) {
    if (triggerName === 'dailySyncBijing') {
      const run = await jobs.startDailyUpload();
      return run && run.runId ? jobs.processChunk(run.runId) : run;
    }
    if (triggerName === 'checkBijingSync') {
      if (!inCheckHours(now())) return null;
      await openCheckCycle();
    }
    return resume();
  }

  return { timer };
}

module.exports = { createDailySchedule, CHECK_CYCLE_ID, getCycleKey };
