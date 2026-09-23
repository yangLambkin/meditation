const crypto = require('crypto');

const RUNS = 'bijing_sync_runs';
const DAYS = 'bijing_sync_days';
const ITEMS = 'bijing_sync_items';
const ERRORS = 'bijing_sync_errors';
const BATCH_SIZE = 20;
const LEASE_MS = 120000;
const MAX_TIMER_ATTEMPTS = 4;
const PAGE_SIZE = 50;
const REPAIR_CURSOR_ID = '__error_retry_cursor__';

const normalizeStudentNumber = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const validStudentNumber = value => /^[A-Z0-9_-]{1,64}$/.test(value);
const errorId = (studentNumber, recordDate) => `${recordDate}_${crypto.createHash('sha256').update(normalizeStudentNumber(studentNumber)).digest('hex').slice(0, 40)}`;
const errorMessage = (error, fallback) => error.response && error.response.data && error.response.data.message || error.message || fallback;

// A lease executes at most one HTTP request. Durable phase/cursor checkpoints
// keep all uploads ahead of verification and allow the timer to resume any phase.
function createBatchJobs({ db, getDayDuration, markSynced, postBatch, queryBatch, recentDates, now = Date.now }) {
  async function optional(database, collection, id) {
    try { return (await database.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
      throw error;
    }
  }
  function validateDate(date) {
    if (!recentDates(30).includes(date)) throw new Error('仅支持最近30个已结束的静坐日（北京时间次日02:00结束）');
  }
  function publicRun(run) {
    if (!run) return run;
    const { leaseToken, leaseUntil, ...value } = run;
    return { ...value, phase: run.phase || 'upload', runId: run._id, status: run.status === 'running' &&
      ((leaseUntil && leaseUntil < now()) || (!leaseUntil && now() - run.updatedAt > 10 * 60000)) ? 'interrupted' : run.status };
  }
  async function startRun(recordDate, trigger, operator, mode = 'full') {
    const timestamp = now();
    const id = `${String(timestamp).padStart(13, '0')}_${crypto.randomBytes(8).toString('hex')}`;
    const automatic = trigger === 'timer' || trigger === 'timer-errors';
    const result = await db.runTransaction(async tx => {
      const day = await optional(tx, DAYS, recordDate);
      if (day && day.activeRunId) {
        const active = await optional(tx, RUNS, day.activeRunId);
        if (active && active.status === 'running') return active;
      }
      const latest = day && day.latestRunId ? await optional(tx, RUNS, day.latestRunId) : null;
      // A successful errors-only repair says nothing about users whose source
      // data failed to load in the full run. Track full completion independently.
      const latestFullRunId = day && day.latestFullRunId || (latest && latest.mode !== 'errors' ? latest._id : '');
      const latestFull = latestFullRunId === (latest && latest._id) ? latest : latestFullRunId ? await optional(tx, RUNS, latestFullRunId) : null;
      if (automatic && mode === 'full' && latestFull && latestFull.status === 'success') return latestFull;
      if (automatic && latest && (day.timerAttempts || 0) >= MAX_TIMER_ATTEMPTS) return latest;
      const run = {
        _id: id, recordDate, trigger, operator: operator || '', mode, phase: 'upload', status: 'running', startedAt: timestamp,
        finishedAt: null, durationMs: 0, updatedAt: timestamp, cursor: '', total: 0,
        successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0, error: '', interruptions: 0, consecutiveInterruptions: 0,
        queryFailures: 0, attempt: (day && day.attempts || 0) + 1, leaseToken: '', leaseUntil: 0,
      };
      const { _id, ...data } = run;
      await tx.collection(RUNS).doc(id).set({ data });
      await tx.collection(DAYS).doc(recordDate).set({ data: {
        recordDate, activeRunId: id, latestRunId: id, latestFullRunId: mode === 'full' ? id : latestFullRunId, attempts: run.attempt,
        timerAttempts: (day && day.timerAttempts || 0) + (automatic ? 1 : 0),
        status: 'running', updatedAt: timestamp,
      } });
      return run;
    });
    return publicRun(result);
  }
  async function start(recordDate, trigger, operator = '') {
    validateDate(recordDate);
    return startRun(recordDate, trigger, operator);
  }
  async function acquire(runId) {
    const token = crypto.randomBytes(16).toString('hex');
    return db.runTransaction(async tx => {
      const run = await optional(tx, RUNS, runId);
      if (!run) throw new Error('同步任务不存在');
      if (run.status !== 'running' || run.leaseUntil > now()) return { run, acquired: false };
      if (run.leaseUntil && (run.consecutiveInterruptions || 0) >= 2) {
        const patch = { status: 'failed', error: '连续三次执行中断或超时，请查看云函数日志后手动重试', finishedAt: now(), durationMs: now() - run.startedAt, updatedAt: now(), leaseToken: '', leaseUntil: 0 };
        await tx.collection(RUNS).doc(runId).update({ data: patch });
        await tx.collection(DAYS).doc(run.recordDate).update({ data: { status: 'failed', activeRunId: '', updatedAt: now() } });
        return { run: { ...run, ...patch }, acquired: false };
      }
      const patch = { phase: run.phase || 'upload', leaseToken: token, leaseUntil: now() + LEASE_MS, updatedAt: now() };
      if (run.leaseUntil) {
        patch.interruptions = (run.interruptions || 0) + 1;
        patch.consecutiveInterruptions = (run.consecutiveInterruptions || 0) + 1;
        patch.lastInterruptionAt = now();
        patch.lastInterruption = '上次执行超时或中断，已从保存的进度恢复';
      }
      await tx.collection(RUNS).doc(runId).update({ data: patch });
      return { run: { ...run, ...patch }, acquired: true };
    });
  }
  function itemId(run, item) {
    return item._id || `${run._id}_${crypto.createHash('sha256').update(item.userId || item.studentNumber).digest('hex').slice(0, 24)}`;
  }
  async function checkpoint(run, { items = [], errorChanges = [], cursor = run.cursor, phase = run.phase, complete = false, error = '', queryFailure = false } = {}) {
    return db.runTransaction(async tx => {
      const current = await optional(tx, RUNS, run._id);
      if (!current || current.leaseToken !== run.leaseToken) throw new Error('执行锁已过期，请刷新任务状态');
      const counts = { total: current.total || 0, successCount: current.successCount || 0, failedCount: current.failedCount || 0, skippedCount: current.skippedCount || 0, discrepancyCount: current.discrepancyCount || 0 };
      const timestamp = now();
      for (const item of items) {
        const id = itemId(run, item);
        const old = await optional(tx, ITEMS, id);
        if (!old) counts.total++;
        counts.discrepancyCount += Number(Boolean(item.retryEligible)) - Number(Boolean(old && old.retryEligible));
        for (const [status, key] of [['success', 'successCount'], ['failed', 'failedCount'], ['skipped', 'skippedCount']]) {
          counts[key] += Number(item.status === status) - Number(old && old.status === status);
        }
        const { _id, ...data } = item;
        await tx.collection(ITEMS).doc(id).set({ data: { ...data, runId: run._id, recordDate: run.recordDate, updatedAt: timestamp } });
      }
      // Only a fully validated query response can supply these mutations. They
      // commit with the cursor, so a killed worker cannot lose an error or clear it.
      for (const change of errorChanges) {
        const id = errorId(change.item.studentNumber, run.recordDate);
        const previous = await optional(tx, ERRORS, id);
        if (change.recovered) {
          if (previous) await tx.collection(ERRORS).doc(id).remove();
        } else {
          const item = change.item;
          await tx.collection(ERRORS).doc(id).set({ data: {
            studentNumber: item.studentNumber, recordDate: run.recordDate, userId: item.userId, openid: item.openid || '',
            bindingStudentNumber: item.bindingStudentNumber || item.studentNumber, nickname: item.nickname || '',
            expectedDurationMinutes: item.durationMinutes, actualDurationMinutes: change.result.durationMinutes,
            exists: change.result.exists, reason: change.result.exists ? 'duration_mismatch' : 'missing', error: item.error,
            runId: run._id, retryCount: (previous && previous.retryCount || 0) + (phase === 'reverify' && item.retryAttempted ? 1 : 0),
            createdAt: previous && previous.createdAt || timestamp, updatedAt: timestamp,
          } });
        }
      }
      const queryFailures = queryFailure ? (current.queryFailures || 0) + 1 : 0;
      const fatal = error && (!queryFailure || queryFailures >= 3);
      const verifiedWithoutDifferences = run.phase === 'verify' && phase === 'retry' && counts.discrepancyCount === 0;
      const status = fatal ? 'failed' : !(complete || verifiedWithoutDifferences) ? 'running' : counts.failedCount ? (counts.successCount ? 'partial' : 'failed') : 'success';
      const patch = { ...counts, cursor, phase, status, error, queryFailures, updatedAt: timestamp,
        finishedAt: status === 'running' ? null : timestamp, durationMs: timestamp - run.startedAt,
        leaseToken: '', leaseUntil: 0, consecutiveInterruptions: 0 };
      await tx.collection(RUNS).doc(run._id).update({ data: patch });
      await tx.collection(DAYS).doc(run.recordDate).update({ data: { status, activeRunId: status === 'running' ? run._id : '', updatedAt: timestamp } });
      return publicRun({ ...current, ...patch });
    });
  }
  async function ownersOf(studentNumber) {
    return (await db.collection('users').where({ bijingBound: true, bijingStudentNumber: db.RegExp({ regexp: `^\\s*${studentNumber}\\s*$`, options: 'i' }) }).limit(2).get()).data;
  }
  async function upload(run) {
    const readDeadline = now() + 20000;
    const filter = run.mode === 'errors' ? { recordDate: run.recordDate } : { bijingBound: true };
    if (run.cursor) filter._id = db.command.gt(run.cursor);
    const rows = (await db.collection(run.mode === 'errors' ? ERRORS : 'users').where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
    const items = [], pending = [];
    for (const row of rows) {
      if (items.length && now() >= readDeadline) break;
      if (run.mode === 'errors') {
        const studentNumber = normalizeStudentNumber(row.studentNumber);
        const item = { _id: `${run._id}_${crypto.createHash('sha256').update(`error:${row._id}`).digest('hex').slice(0, 24)}`,
          userId: row.userId || '', openid: row.openid || '', studentNumber,
          bindingStudentNumber: row.bindingStudentNumber || studentNumber, nickname: row.nickname || '',
          durationMinutes: row.expectedDurationMinutes, status: 'failed', error: '', attempts: run.attempt, verifyEligible: false };
        items.push(item);
        try {
          if (!validStudentNumber(studentNumber)) throw new Error('错误记录的学号无效，请人工检查');
          const owners = await ownersOf(studentNumber);
          if (owners.length !== 1 || owners[0]._id !== item.userId || owners[0]._openid !== item.openid) throw new Error('学号绑定已变更或存在冲突，保留错误待人工检查');
          // Old error snapshots are not a current source of truth: comparing an
          // old expected 20 with remote 20 must not clear an error if local is 45.
          // A source read failure likewise cannot authorize deletion of an error.
          const duration = await getDayDuration(item.openid, run.recordDate, readDeadline);
          if (!Number.isInteger(duration) || duration <= 0) throw new Error('本地当日静坐数据已变更，保留错误待人工检查');
          item.durationMinutes = duration;
          item.bindingStudentNumber = owners[0].bijingStudentNumber;
          item.verifyEligible = true; item.status = 'pending';
        } catch (error) { item.error = error.message || '读取当前静坐数据失败，保留原错误'; }
        continue;
      }
      const item = { userId: row._id, openid: row._openid || '', studentNumber: normalizeStudentNumber(row.bijingStudentNumber),
        bindingStudentNumber: row.bijingStudentNumber || '', nickname: row.nickName || '', durationMinutes: 0,
        status: 'failed', error: '', attempts: run.attempt, verifyEligible: false };
      items.push(item);
      try {
        if (!row._openid || typeof row.bijingStudentNumber !== 'string') throw new Error('绑定资料不完整，请重新绑定学号');
        if (!validStudentNumber(item.studentNumber)) throw new Error('绑定学号格式错误，请重新绑定');
        if ((await ownersOf(item.studentNumber)).length > 1) throw new Error('同一学号绑定了多个用户，请核对绑定后重试');
        item.durationMinutes = await getDayDuration(row._openid, run.recordDate, readDeadline);
        if (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 0) throw new Error('本地静坐时长无效');
        if (item.durationMinutes === 0) { item.status = 'skipped'; item.error = '当日无静坐数据'; continue; }
        item.status = 'pending'; item.verifyEligible = true;
        pending.push(item);
      } catch (error) { item.error = error.message || '读取静坐记录失败'; }
    }
    if (pending.length) await post(run, pending);
    const complete = items.length === rows.length && rows.length < BATCH_SIZE;
    return checkpoint(run, { items, cursor: complete ? '' : items.length ? rows[items.length - 1]._id : run.cursor, phase: complete ? 'verify' : 'upload' });
  }
  async function post(run, items) {
    try {
      const response = await postBatch(run.recordDate, items.map(item => ({ studentNumber: item.studentNumber, durationMinutes: item.durationMinutes })));
      // A timeout may happen after the remote commit, and a success acknowledgement
      // is not proof of the eventual state. Retain it only as upload diagnostics.
      const results = response && response.success === true && response.data && response.data.recordDate === run.recordDate &&
        response.data.total === items.length && Array.isArray(response.data.results) ? response.data.results : [];
      items.forEach((item, index) => {
        const matches = results.filter(result => result.index === index && result.studentNumber === item.studentNumber);
        const result = matches.length === 1 ? matches[0] : null;
        item.uploadError = result && result.success === true && result.durationMinutes === item.durationMinutes ? '' :
          result && result.error || response && response.message || '上传接口未确认成功，等待最终核对';
      });
    } catch (error) { items.forEach(item => { item.uploadError = errorMessage(error, '请求必经批量接口失败'); }); }
  }
  async function phaseRows(run) {
    const filter = { runId: run._id };
    if (run.cursor) filter._id = db.command.gt(run.cursor);
    return (await db.collection(ITEMS).where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
  }
  function eligible(item) {
    // Existing pre-reconciliation jobs have no verifyEligible field. Recheck
    // their formerly acknowledged successes before considering them complete.
    return item.verifyEligible !== false && validStudentNumber(item.studentNumber) && Number.isInteger(item.durationMinutes) && item.durationMinutes > 0;
  }
  async function verify(run) {
    const rows = await phaseRows(run);
    const pending = rows.filter(item => eligible(item) && (run.phase === 'verify' || item.retryEligible));
    const errorChanges = [];
    if (pending.length) {
      const records = pending.map(item => ({ studentNumber: item.studentNumber, recordDate: run.recordDate }));
      let response;
      try {
        response = await queryBatch(records);
        if (!response || response.success !== true || !response.data || response.data.total !== pending.length ||
          !Array.isArray(response.data.results) || response.data.results.length !== pending.length) throw new Error('批量核对接口返回无效响应');
        for (let index = 0; index < pending.length; index++) {
          const matches = response.data.results.filter(result => result && result.index === index);
          const result = matches.length === 1 ? matches[0] : null;
          if (!result || result.studentNumber !== records[index].studentNumber || result.recordDate !== run.recordDate ||
            typeof result.exists !== 'boolean' || !Number.isInteger(result.durationMinutes) || result.durationMinutes < 0 ||
            (!result.exists && result.durationMinutes !== 0)) throw new Error('批量核对接口返回不完整或不匹配的记录');
        }
      } catch (error) {
        return checkpoint(run, { error: errorMessage(error, '远端核对失败，未修改错误表'), queryFailure: true });
      }
      for (let index = 0; index < pending.length; index++) {
        const item = pending[index];
        const result = response.data.results.find(value => value.index === index);
        const recovered = result.exists && result.durationMinutes === item.durationMinutes;
        item.verifiedAt = now(); item.actualDurationMinutes = result.durationMinutes; item.remoteExists = result.exists;
        item.status = recovered ? 'success' : 'failed'; item.retryEligible = !recovered;
        item.error = recovered ? '' : `${result.exists ? `远端时长为${result.durationMinutes}分钟，期望${item.durationMinutes}分钟` : '远端缺少该学号当日记录'}${item.retryBlocked ? `；${item.retryBlocked}` : ''}`;
        if (recovered) {
          try { await markSynced(item.openid, run.recordDate, item.bindingStudentNumber); item.markError = ''; }
          catch (error) { item.markError = error.message || '写入本地同步标记失败'; }
        }
        errorChanges.push({ item, result, recovered });
      }
    }
    const complete = rows.length < BATCH_SIZE;
    const nextPhase = run.phase === 'verify' ? 'retry' : 'reverify';
    return checkpoint(run, { items: pending, errorChanges, cursor: complete ? '' : rows[rows.length - 1]._id,
      phase: complete ? nextPhase : run.phase, complete: complete && run.phase === 'reverify' });
  }
  async function retry(run) {
    const rows = await phaseRows(run);
    const readDeadline = now() + 20000;
    const items = [], pending = [];
    let processed = 0;
    for (const item of rows) {
      if (processed && now() >= readDeadline) break;
      processed++;
      if (!item.retryEligible || !eligible(item)) continue;
      items.push(item);
      try {
        const owners = await ownersOf(item.studentNumber);
        if (owners.length !== 1 || owners[0]._id !== item.userId || owners[0]._openid !== item.openid) throw new Error('学号绑定已变更或存在冲突，未自动覆盖');
        const duration = await getDayDuration(item.openid, run.recordDate, readDeadline);
        if (!Number.isInteger(duration) || duration <= 0) throw new Error('本地当日静坐数据已变更，需人工检查');
        // Refresh the source under the same day lock before retrying so a stale
        // expected snapshot cannot replace a newer local daily total.
        item.durationMinutes = duration;
        item.bindingStudentNumber = owners[0].bijingStudentNumber;
        item.retryAttempted = true; item.retryBlocked = '';
        pending.push(item);
      } catch (error) { item.retryBlocked = error.message || '重试前检查失败'; }
    }
    if (pending.length) await post(run, pending);
    const complete = processed === rows.length && rows.length < BATCH_SIZE;
    return checkpoint(run, { items, cursor: complete ? '' : processed ? rows[processed - 1]._id : run.cursor, phase: complete ? 'reverify' : 'retry' });
  }
  async function processChunk(runId) {
    if (typeof runId !== 'string' || !/^\d{13}_[a-f0-9]{16}$/.test(runId)) throw new Error('同步任务ID无效');
    const { run, acquired } = await acquire(runId);
    if (!acquired) return { ...publicRun(run), busy: run.status === 'running' };
    try {
      if (run.phase === 'upload') return await upload(run);
      if (run.phase === 'verify' || run.phase === 'reverify') return await verify(run);
      if (run.phase === 'retry') return await retry(run);
      throw new Error('未知同步阶段，请重新发起任务');
    } catch (error) {
      // Failed checkpoint transactions roll back both items and error changes.
      // If this write also fails, the expired lease safely replays the same cursor.
      return checkpoint(run, { error: error.message || '同步任务执行失败' });
    }
  }
  async function retryErrors(operator = '', automatic = false) {
    // A persistent scan cursor keeps one permanently broken date (or >20 errors
    // on that date) from starving later dates. Manual retries have no date cutoff.
    const scheduler = await optional(db, DAYS, REPAIR_CURSOR_ID);
    const filter = {};
    if (scheduler && scheduler.cursor) filter._id = db.command.gt(scheduler.cursor);
    let rows = (await db.collection(ERRORS).where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
    if (!rows.length && scheduler && scheduler.cursor) rows = (await db.collection(ERRORS).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
    await db.collection(DAYS).doc(REPAIR_CURSOR_ID).set({ data: { cursor: rows.length === BATCH_SIZE ? rows[rows.length - 1]._id : '', updatedAt: now() } });
    for (const recordDate of [...new Set(rows.map(row => row.recordDate))]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) continue;
      const day = await optional(db, DAYS, recordDate);
      if (automatic && day && (day.timerAttempts || 0) >= MAX_TIMER_ATTEMPTS) continue;
      await db.collection(DAYS).doc(REPAIR_CURSOR_ID).set({ data: { cursor: `${recordDate}~`, updatedAt: now() } });
      return startRun(recordDate, automatic ? 'timer-errors' : 'manual-errors', operator, 'errors');
    }
    return null;
  }
  async function timer() {
    const latest = await start(recentDates(1)[0], 'timer');
    const active = (await db.collection(RUNS).where({ status: 'running' }).orderBy('startedAt', 'asc').limit(1).get()).data[0];
    if (active) return processChunk(active._id);
    if (latest.status === 'running' || latest.status === 'interrupted') return processChunk(latest.runId);
    for (const date of recentDates(7)) {
      const run = await start(date, 'timer');
      if (run.status === 'running' || run.status === 'interrupted') return processChunk(run.runId);
    }
    const repair = await retryErrors('', true);
    if (repair && (repair.status === 'running' || repair.status === 'interrupted')) return processChunk(repair.runId);
    return latest;
  }
  async function listRuns(recordDate, cursor) {
    if (recordDate) validateDate(recordDate);
    const dates = recentDates(7);
    // Active repairs can target older dates; keep their continuation independent
    // of the bounded history, using the same indexed lookup as the timer.
    const activeRun = (await db.collection(RUNS).where({ status: 'running' }).orderBy('startedAt', 'asc').limit(1).get()).data[0];
    if (recordDate && !dates.includes(recordDate)) return { runs: [], nextCursor: null, activeRun: publicRun(activeRun) || null };
    let filter = { recordDate: recordDate || db.command.in(dates) };
    if (cursor) {
      if (typeof cursor !== 'string' || !/^\d{13}_[a-f0-9]{16}$/.test(cursor)) throw new Error('执行记录分页游标无效');
      const anchor = await optional(db, RUNS, cursor);
      if (!anchor || !dates.includes(anchor.recordDate) || (recordDate && anchor.recordDate !== recordDate)) throw new Error('执行记录分页游标无效');
      filter = db.command.and([filter, db.command.or([
        { recordDate: db.command.lt(anchor.recordDate) },
        { recordDate: anchor.recordDate, _id: db.command.lt(cursor) },
      ])]);
    }
    // IDs begin with the execution timestamp, so descending IDs order retries
    // within a day while recordDate keeps newer meditation days first.
    const rows = (await db.collection(RUNS).where(filter).orderBy('recordDate', 'desc').orderBy('_id', 'desc').limit(PAGE_SIZE).get()).data;
    return { runs: rows.map(publicRun), nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1]._id : null,
      activeRun: publicRun(activeRun) || null };
  }
  async function details(runId, cursor) {
    if (typeof runId !== 'string' || !/^\d{13}_[a-f0-9]{16}$/.test(runId)) throw new Error('同步任务ID无效');
    const filter = { runId };
    if (cursor) filter._id = db.command.gt(cursor);
    const rows = (await db.collection(ITEMS).where(filter).orderBy('_id', 'asc').limit(PAGE_SIZE).get()).data;
    return { items: rows, nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1]._id : null };
  }
  async function listErrors(cursor) {
    const filter = cursor ? { _id: db.command.gt(cursor) } : {};
    const rows = (await db.collection(ERRORS).where(filter).orderBy('_id', 'asc').limit(PAGE_SIZE).get()).data;
    return { errors: rows, nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1]._id : null };
  }
  return { start, processChunk, timer, listRuns, details, listErrors, retryErrors };
}
module.exports = { createBatchJobs, BATCH_SIZE, errorId };
