const crypto = require('crypto');
const { COVERAGE_ID, COVERAGE_FROM_DATE, nextDate } = require('./syncCoverage');

const DAYS = 'bijing_sync_days';
const RUNS = 'bijing_sync_runs';
const PLAN_SIZE = 7;
const ADVANCE_SIZE = 30;
const previousDate = date => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

// Discovery has its own watermark. A broken old date cannot stop later missing
// dates from acquiring durable work; completion advances only after source scan.
function createCoverage({ db, now = Date.now, latestDate }) {
  async function optional(database, collection, id) {
    try { return (await database.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
      throw error;
    }
  }
  async function initialize() {
    return db.runTransaction(async tx => {
      const existing = await optional(tx, DAYS, COVERAGE_ID);
      if (existing) return existing;
      const coverage = { fromDate: COVERAGE_FROM_DATE, nextDate: COVERAGE_FROM_DATE,
        scannedThrough: previousDate(COVERAGE_FROM_DATE), scheduledThrough: previousDate(COVERAGE_FROM_DATE),
        createdAt: now(), updatedAt: now() };
      await tx.collection(DAYS).doc(COVERAGE_ID).set({ data: coverage });
      return coverage;
    });
  }
  async function advance() {
    await initialize();
    return db.runTransaction(async tx => {
      const coverage = await optional(tx, DAYS, COVERAGE_ID);
      let date = coverage.nextDate;
      for (let count = 0; count < ADVANCE_SIZE && date <= latestDate(); count++) {
        const day = await optional(tx, DAYS, date);
        if (!day || !day.sourceCheckedAt) break;
        date = nextDate(date);
      }
      if (date !== coverage.nextDate) {
        const patch = { nextDate: date, scannedThrough: previousDate(date), updatedAt: now() };
        await tx.collection(DAYS).doc(COVERAGE_ID).update({ data: patch });
        return { ...coverage, ...patch };
      }
      return coverage;
    });
  }
  async function settle() {
    let before = await initialize();
    while (true) {
      const after = await advance();
      if (after.nextDate === before.nextDate || after.nextDate > latestDate()) return after;
      before = after;
    }
  }
  async function ensureDate(recordDate, { operator = '', manual = false } = {}) {
    if (!validDate(recordDate) || recordDate < COVERAGE_FROM_DATE || recordDate > latestDate()) {
      throw new Error('补核对日期不在自动覆盖范围内');
    }
    const id = `${String(now()).padStart(13, '0')}_${crypto.randomBytes(8).toString('hex')}`;
    return db.runTransaction(async tx => {
      const day = await optional(tx, DAYS, recordDate);
      if (day && day.sourceCheckedAt) return null;
      const active = day && day.activeRunId ? await optional(tx, RUNS, day.activeRunId) : null;
      const fullId = day && (day.latestFullRunId || day.latestRunId);
      const full = fullId ? await optional(tx, RUNS, fullId) : null;
      // Older completed source checks predate the explicit day marker.
      if (full && full.sourceCheck && full.mode !== 'errors' && ['retry', 'reverify'].includes(full.phase)) {
        await tx.collection(DAYS).doc(recordDate).update({ data: {
          sourceCheckedAt: full.updatedAt || now(), sourceCheckRunId: full._id, sourceCheckRequired: false,
        } });
        return null;
      }
      const { _id, ...previousDay } = day || {};
      const required = { ...previousDay, recordDate, sourceCheckRequired: true, updatedAt: now() };
      const abandonedUpload = manual && active && active.trigger === 'timer' && active.mode !== 'errors' &&
        (!active.phase || active.phase === 'upload') && (active.leaseUntil ? active.leaseUntil <= now() :
          now() - (active.updatedAt || active.startedAt || 0) > 10 * 60000);
      if (active && active.status === 'running' && !abandonedUpload) {
        await tx.collection(DAYS).doc(recordDate).set({ data: required });
        return { ...active, runId: active._id, busy: active.leaseUntil > now() };
      }
      // Keep a recoverable full run's checkpoint instead of starting from zero.
      if (full && full.mode !== 'errors' && ['running', 'failed', 'uploaded'].includes(full.status) &&
          (full.status !== 'failed' || full.error)) {
        const patch = manual ? { status: 'running', finishedAt: null, error: '', queryFailures: 0,
          consecutiveInterruptions: 0, leaseToken: '', leaseUntil: 0,
          ...(!full.phase || full.phase === 'upload' ? { phase: 'verify', cursor: '', sourceCheck: true,
            ...(full.sourceCheck ? { total: 0, successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0 } : {}) } : {}),
          updatedAt: now() } : {};
        if (manual) await tx.collection(RUNS).doc(full._id).update({ data: patch });
        await tx.collection(DAYS).doc(recordDate).set({ data: { ...required,
          ...(manual ? { activeRunId: full._id, status: 'running' } : {}) } });
        return { ...full, ...patch, runId: full._id };
      }
      const timestamp = now();
      const run = { recordDate, trigger: manual ? 'manual-coverage' : 'timer-coverage', operator,
        mode: 'full', sourceCheck: true, phase: 'verify', status: 'running', startedAt: timestamp,
        finishedAt: null, durationMs: 0, updatedAt: timestamp, cursor: '', total: 0,
        successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0, error: '',
        interruptions: 0, consecutiveInterruptions: 0, queryFailures: 0,
        attempt: (day && day.attempts || 0) + 1, leaseToken: '', leaseUntil: 0 };
      await tx.collection(RUNS).doc(id).set({ data: run });
      await tx.collection(DAYS).doc(recordDate).set({ data: { ...required,
        activeRunId: id, latestRunId: id, latestFullRunId: id, attempts: run.attempt,
        timerAttempts: (day && day.timerAttempts || 0) + Number(!manual), status: 'running' } });
      return { ...run, _id: id, runId: id };
    });
  }
  async function plan() {
    await advance();
    for (let count = 0; count < PLAN_SIZE; count++) {
      const coverage = await optional(db, DAYS, COVERAGE_ID);
      const date = nextDate(coverage.scheduledThrough || previousDate(coverage.fromDate));
      if (date >= latestDate()) break; // Latest day is owned by its hourly cycle.
      await ensureDate(date);
      // A killed process can leave a job without a watermark advance, never the
      // inverse. Repeating ensureDate reuses the day lock and existing run.
      await db.runTransaction(async tx => {
        const current = await optional(tx, DAYS, COVERAGE_ID);
        if ((current.scheduledThrough || previousDate(current.fromDate)) >= date) return;
        await tx.collection(DAYS).doc(COVERAGE_ID).update({ data: { scheduledThrough: date, updatedAt: now() } });
      });
    }
  }
  async function repair(operator) {
    while (true) {
      const coverage = await settle();
      if (coverage.nextDate > latestDate()) return null;
      const run = await ensureDate(coverage.nextDate, { manual: true, operator });
      if (run) return run;
      // A pre-upgrade completed run may have just gained its source marker.
      // Continue to the actual gap instead of returning an empty repair action.
    }
  }
  return { plan, advance, settle, ensureDate, repair };
}

module.exports = { createCoverage, PLAN_SIZE, ADVANCE_SIZE };
