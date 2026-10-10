const crypto = require('crypto');

const DAYS = 'bijing_sync_days';
const RUNS = 'bijing_sync_runs';
const CHECK_CYCLE_ID = '__daily_check_cycle__';
const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;

const previousDate = date => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const latestRecordDate = timestamp => new Date(timestamp + BEIJING_OFFSET_MS - 2 * 3600000 - DAY_MS).toISOString().slice(0, 10);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function publicRun(run, busy = false) {
  if (!run) return null;
  const { leaseToken, leaseUntil, ...value } = run;
  return { ...value, runId: run._id, ...(busy ? { busy: true } : {}) };
}

// Each authorized hourly check owns a fresh source-data scan. Its existence
// and cursor do not depend on whether the 02:00 upload started or finished.
function createSourceCheck({ db, now = Date.now }) {
  async function optional(database, collection, id) {
    try { return (await database.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
      throw error;
    }
  }

  async function ensureDailyCheck(recordDate, cycleDate, cycleKey = cycleDate) {
    if (!validDate(recordDate) || !validDate(cycleDate) || previousDate(cycleDate) !== recordDate ||
        typeof cycleKey !== 'string' || !cycleKey) {
      throw new Error('自动核对仅处理核对日期前一天的静坐日');
    }
    const id = `${String(now()).padStart(13, '0')}_${crypto.randomBytes(8).toString('hex')}`;
    return db.runTransaction(async tx => {
      const cycle = await optional(tx, DAYS, CHECK_CYCLE_ID);
      if (!cycle || cycle.status !== 'running' || cycle.cycleDate !== cycleDate ||
          (cycle.cycleKey || cycle.cycleDate) !== cycleKey) return null;
      const day = await optional(tx, DAYS, recordDate);
      const timestamp = now();
      if (latestRecordDate(timestamp) !== recordDate || timestamp < Date.parse(`${cycleDate}T03:00:00+08:00`)) return null;
      // Repeated delivery and continuation reuse every state, including failed
      // and completed checks. Recovery policy belongs to the batch runner.
      if (day && day.checkCycle >= cycleKey) {
        if (day.checkCycle !== cycleKey) return null;
        const existing = day.checkRunId ? await optional(tx, RUNS, day.checkRunId) : null;
        if (!existing || existing.recordDate !== recordDate || existing.sourceCheck !== true || existing.checkCycle !== cycleKey) {
          throw new Error('定时全量核对任务记录缺失或不匹配');
        }
        return publicRun(existing, existing.status === 'running' && existing.leaseUntil > now());
      }
      const active = day && day.activeRunId ? await optional(tx, RUNS, day.activeRunId) : null;
      if (active && active.status === 'running') {
        if (active.leaseUntil > now()) return publicRun(active, true);
        // Only an abandoned automatic upload is superseded. Administrators'
        // work and errors-only repairs finish under their existing day lock.
        if (active.trigger !== 'timer' || active.mode === 'errors' || (active.phase || 'upload') !== 'upload') {
          return publicRun(active);
        }
      }
      const updatedAt = now();
      if (latestRecordDate(updatedAt) !== recordDate) return null;
      if (active && active.status === 'running') {
        await tx.collection(RUNS).doc(active._id).update({ data: {
          status: 'failed', error: '上传未完成，已由定时全量源数据核对接管',
          finishedAt: updatedAt, durationMs: updatedAt - active.startedAt, updatedAt,
          leaseToken: '', leaseUntil: 0,
        } });
      }
      const run = {
        _id: id, recordDate, trigger: 'timer-check', operator: '', mode: 'full', sourceCheck: true,
        checkCycle: cycleKey, phase: 'verify', status: 'running', startedAt: updatedAt,
        finishedAt: null, durationMs: 0, updatedAt, cursor: '', total: 0,
        successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0, error: '',
        interruptions: 0, consecutiveInterruptions: 0, queryFailures: 0,
        attempt: (day && day.attempts || 0) + 1, leaseToken: '', leaseUntil: 0,
      };
      const { _id, ...data } = run;
      await tx.collection(RUNS).doc(id).set({ data });
      const { _id: dayId, ...previousDay } = day || {};
      await tx.collection(DAYS).doc(recordDate).set({ data: {
        ...previousDay, recordDate, checkCycle: cycleKey, checkRunId: id,
        activeRunId: id, latestRunId: id, latestFullRunId: id,
        attempts: run.attempt, timerAttempts: (day && day.timerAttempts || 0) + 1,
        status: 'running', updatedAt,
      } });
      return publicRun(run);
    });
  }

  return { ensureDailyCheck };
}

module.exports = { createSourceCheck };
