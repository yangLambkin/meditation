const RUNS = 'bijing_sync_runs';
const DAYS = 'bijing_sync_days';
const ERRORS = 'bijing_sync_errors';
const CURSOR_ID = '__pending_repair_cursor__';
const PAGE_SIZE = 100;

// The hourly trigger also drains historical work. Runs are the durable queue
// for failures before a person could be read; errors hold all known people.
// Advance the date cursor before executing work, so a killed or broken date
// cannot monopolize every following hourly invocation.
function createPendingRepairs({ db, now, latestDate, startRepair, processBatch, processCurrent, ensureSourceCheck }) {
  async function optional(database, collection, id) {
    try { return (await database.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
      throw error;
    }
  }
  async function scan(collection, filter) {
    const found = [];
    let cursor = '';
    while (true) {
      const rows = (await db.collection(collection).where({ ...filter, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
        .orderBy('_id', 'asc').limit(PAGE_SIZE).get()).data;
      found.push(...rows);
      if (rows.length < PAGE_SIZE) return found;
      cursor = rows[rows.length - 1]._id;
    }
  }
  async function restore(recordDate, cycleKey) {
    return db.runTransaction(async tx => {
      const day = await optional(tx, DAYS, recordDate);
      if (!day) return null;
      const active = day.activeRunId ? await optional(tx, RUNS, day.activeRunId) : null;
      const fullId = day.latestFullRunId || day.latestRunId;
      const candidate = active && active.status === 'running' ? active :
        fullId ? await optional(tx, RUNS, fullId) : null;
      if (!candidate || candidate.recordDate !== recordDate ||
          !['running', 'failed', 'uploaded'].includes(candidate.status) ||
          candidate.status === 'failed' && !candidate.error) return null;
      if (candidate.leaseUntil > now() || candidate.queueAttemptCycle >= cycleKey) return { skip: true };
      const patch = { queueAttemptCycle: cycleKey, updatedAt: now() };
      if (candidate.status === 'failed' || candidate.status === 'uploaded') Object.assign(patch, {
        status: 'running', finishedAt: null, error: '', queryFailures: 0,
        consecutiveInterruptions: 0, leaseToken: '', leaseUntil: 0,
      });
      if (candidate.mode !== 'errors' && (!candidate.phase || candidate.phase === 'upload')) {
        // Upload has no durable cursor. Reconcile the original source instead
        // of replaying all already acknowledged requests after an interruption.
        Object.assign(patch, { phase: 'verify', cursor: '', sourceCheck: true });
        if (candidate.sourceCheck) Object.assign(patch, {
          // New uploads only stored summary counters, never item documents.
          // Reconciliation starts its own counts while retaining uploadSummary.
          total: 0, successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0,
        });
      }
      await tx.collection(RUNS).doc(candidate._id).update({ data: patch });
      await tx.collection(DAYS).doc(recordDate).update({ data: { activeRunId: candidate._id, status: 'running', updatedAt: now() } });
      return { ...candidate, ...patch, runId: candidate._id };
    });
  }
  async function run(cycleKey) {
    const target = latestDate();
    const [errors, running, failed, uploaded, scheduler, missingChecks] = await Promise.all([
      scan(ERRORS, {}), scan(RUNS, { status: 'running' }), scan(RUNS, { status: 'failed' }), scan(RUNS, { status: 'uploaded' }),
      optional(db, DAYS, CURSOR_ID),
      ensureSourceCheck ? scan(DAYS, { sourceCheckRequired: true }) : [],
    ]);
    const validHistorical = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value && value < target;
    const dates = [...new Set([...errors, ...running, ...failed.filter(row => row.error), ...uploaded, ...missingChecks].map(row => row.recordDate).filter(validHistorical))].sort();
    // Include the normal latest-day pass in the rotation. Even one historical
    // date that repeatedly exhausts the platform timeout cannot starve it.
    if (dates.length && processCurrent) dates.push(target);
    const cursor = scheduler && scheduler.cursor || '';
    const ordered = [...dates.filter(date => date > cursor), ...dates.filter(date => date <= cursor)];
    const outcomes = [];
    let processedCurrent = false, currentResult = null;
    for (const recordDate of ordered) {
      await db.collection(DAYS).doc(CURSOR_ID).set({ data: { cursor: recordDate, cycleKey, updatedAt: now() } });
      try {
        if (recordDate === target) {
          processedCurrent = true;
          currentResult = await processCurrent();
          continue;
        }
        if (ensureSourceCheck && missingChecks.some(row => row.recordDate === recordDate)) await ensureSourceCheck(recordDate);
        let result = await restore(recordDate, cycleKey);
        if (result && result.skip) continue;
        if (!result && errors.some(row => row.recordDate === recordDate)) result = await startRepair(recordDate, cycleKey);
        if (!result || !result.runId) continue;
        const seen = new Set();
        while (result.status === 'running' || result.status === 'interrupted') {
          result = await processBatch(result.runId, { automatic: true, allowHistorical: true });
          if (result.busy || result.error || result.status === 'waiting') break;
          const progress = JSON.stringify([result.phase, result.cursor, result.status, result.total, result.discrepancyCount]);
          if (seen.has(progress)) break;
          seen.add(progress);
        }
        outcomes.push(result);
      } catch (error) {
        // Runs/errors already retain the work. A failure for this date must not
        // prevent the remaining dates or today's source check from executing.
        outcomes.push({ recordDate, error: error.message || '历史同步修复未完成' });
      }
    }
    return { outcomes, processedCurrent, currentResult };
  }
  return { run };
}

module.exports = { createPendingRepairs };
