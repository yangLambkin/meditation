const crypto = require('crypto');

const RUNS = 'bijing_sync_runs';
const DAYS = 'bijing_sync_days';
const ITEMS = 'bijing_sync_items';
const ERRORS = 'bijing_sync_errors';
const BATCH_SIZE = 100;
const CHUNK_SIZE = 20;
const REQUEST_LEASE_MARGIN_MS = 20000;
const LEASE_MS = 120000;
const RENEW_LEASE_MARGIN_MS = 60000;
const SOURCE_SLICE_MS = 5000;
const MARK_SLICE_MS = 5000;
const PAGE_SIZE = 50;
const REPAIR_CURSOR_ID = '__error_retry_cursor__';

const normalizeStudentNumber = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const validStudentNumber = value => /^[A-Z0-9_-]{1,64}$/.test(value);
const errorId = (studentNumber, recordDate) => `${recordDate}_${crypto.createHash('sha256').update(normalizeStudentNumber(studentNumber)).digest('hex').slice(0, 40)}`;
const errorMessage = (error, fallback) => error.response && error.response.data && error.response.data.message || error.message || fallback;

// Upload uses an in-memory cursor and sends 100 records per request. The later
// source reconciliation is independent of upload logs and commits its results
// in 20-row transactions under a renewable lease.
function createBatchJobs({ db, getDayDuration, markSynced, postBatch, postZero, queryBatch, recentDates, now = Date.now }) {
  const coverage = () => require('./coverage').createCoverage({ db, now, latestDate: () => recentDates(1)[0] });
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
    const waiting = waitsForCheck(run);
    return { ...value, phase: run.phase || 'upload', runId: run._id, status: waiting ? 'waiting' : run.status === 'running' &&
      ((leaseUntil && leaseUntil < now()) || (!leaseUntil && now() - Math.max(run.updatedAt, verificationTime(run)) > 10 * 60000)) ? 'interrupted' : run.status };
  }
  function verificationTime(run) {
    // Legacy automatic runs wait for the first scheduled check at 03:00.
    return run.trigger === 'timer' && run.mode !== 'errors' && !run.verifyImmediately
      ? Date.parse(`${run.recordDate}T03:00:00+08:00`) + 86400000 : 0;
  }
  function waitsForCheck(run) {
    return run.status === 'running' && run.phase && run.phase !== 'upload' && verificationTime(run) > now();
  }
  async function startRun(recordDate, trigger, operator, mode = 'full', schedule = {}) {
    const timestamp = now();
    const id = `${String(timestamp).padStart(13, '0')}_${crypto.randomBytes(8).toString('hex')}`;
    const automatic = trigger === 'timer' || trigger === 'timer-errors';
    const result = await db.runTransaction(async tx => {
      if (schedule.authorizedCycle) {
        const { CHECK_CYCLE_ID, getCycleKey } = require('./dailySchedule');
        const cycle = await optional(tx, DAYS, CHECK_CYCLE_ID);
        if (!cycle || cycle.status !== 'running' || getCycleKey(cycle) !== schedule.authorizedCycle ||
          cycle.cycleDate !== schedule.cycleDate || recordDate !== recentDates(1)[0]) return null;
      }
      const day = await optional(tx, DAYS, recordDate);
      if (day && day.activeRunId) {
        const active = await optional(tx, RUNS, day.activeRunId);
        if (active && active.status === 'running') {
          const expiredUploadLease = active.leaseUntil ? active.leaseUntil <= now() :
            now() - (active.updatedAt || active.startedAt || 0) > 10 * 60000;
          const abandonedUpload = trigger === 'manual' && mode === 'full' && active.trigger === 'timer' &&
            (active.mode || 'full') === 'full' && (active.phase || 'upload') === 'upload' && expiredUploadLease;
          if (!abandonedUpload) return active;
          // The UI deliberately never auto-resumes scheduled uploads. An
          // explicit manual request may replace an abandoned upload under the
          // same day lock; a live lease or any other task keeps its ownership.
          const interruptedAt = now();
          await tx.collection(RUNS).doc(active._id).update({ data: {
            status: 'failed', error: '自动上传已中断，已由管理员手动全量同步接管',
            finishedAt: interruptedAt, durationMs: interruptedAt - active.startedAt, updatedAt: interruptedAt,
            leaseToken: '', leaseUntil: 0,
          } });
        }
      }
      const latest = day && day.latestRunId ? await optional(tx, RUNS, day.latestRunId) : null;
      // A successful errors-only repair says nothing about users whose source
      // data failed to load in the full run. Track full completion independently.
      const latestFullRunId = day && day.latestFullRunId || (latest && latest.mode !== 'errors' ? latest._id : '');
      const latestFull = latestFullRunId === (latest && latest._id) ? latest : latestFullRunId ? await optional(tx, RUNS, latestFullRunId) : null;
      // Repeated daily triggers reuse their run even when it has failed. Only
      // each authorized hourly cycle may create another automatic repair.
      if (schedule.upload && latestFull) return latestFull;
      if (schedule.repairCycle && day && day.repairCycle >= schedule.repairCycle && latest) return latest;
      if (automatic && mode === 'full' && latestFull && latestFull.status === 'success') return latestFull;
      const run = {
        _id: id, recordDate, trigger, operator: operator || '', mode, phase: 'upload', status: 'running', startedAt: timestamp,
        finishedAt: null, durationMs: 0, updatedAt: timestamp, cursor: '', total: 0,
        successCount: 0, failedCount: 0, skippedCount: 0, discrepancyCount: 0, error: '', interruptions: 0, consecutiveInterruptions: 0,
        queryFailures: 0, attempt: (day && day.attempts || 0) + 1, leaseToken: '', leaseUntil: 0,
        ...(mode === 'full' ? { sourceCheck: true } : {}),
        ...(schedule.upload ? { verifyImmediately: true } : {}),
        ...(automatic && mode === 'full' && !schedule.upload ? { verifyAfter: Date.parse(`${recordDate}T03:00:00+08:00`) + 86400000 } : {}),
        ...(schedule.repairCycle ? { repairCycle: schedule.repairCycle, queueAttemptCycle: schedule.repairCycle } : {}),
      };
      const { _id, ...data } = run;
      await tx.collection(RUNS).doc(id).set({ data });
      const { _id: dayId, ...previousDay } = day || {};
      await tx.collection(DAYS).doc(recordDate).set({ data: {
        ...previousDay,
        recordDate, activeRunId: id, latestRunId: id, latestFullRunId: mode === 'full' ? id : latestFullRunId, attempts: run.attempt,
        timerAttempts: (day && day.timerAttempts || 0) + (automatic ? 1 : 0),
        ...(schedule.repairCycle ? { repairCycle: schedule.repairCycle } : {}),
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
  async function acquire(runId, { expectedPhase, automatic = false, allowHistorical = false } = {}) {
    const token = crypto.randomBytes(16).toString('hex');
    return db.runTransaction(async tx => {
      const run = await optional(tx, RUNS, runId);
      if (!run) throw new Error('同步任务不存在');
      if ((expectedPhase && (run.phase || 'upload') !== expectedPhase) ||
        (automatic && !allowHistorical && run.recordDate !== recentDates(1)[0])) return { run, acquired: false };
      if (run.status !== 'running' || run.leaseUntil > now() || waitsForCheck(run)) return { run, acquired: false };
      if (run.leaseUntil && (run.consecutiveInterruptions || 0) >= 2) {
        const patch = { status: 'failed', error: '连续三次执行中断或超时，等待下次定时修复；管理员可检查云函数日志', finishedAt: now(), durationMs: now() - run.startedAt, updatedAt: now(), leaseToken: '', leaseUntil: 0 };
        await tx.collection(RUNS).doc(runId).update({ data: patch });
        await tx.collection(DAYS).doc(run.recordDate).update({ data: { status: 'failed', activeRunId: '', updatedAt: now() } });
        return { run: { ...run, ...patch }, acquired: false };
      }
      const patch = { phase: run.phase || 'upload', leaseToken: token, leaseUntil: now() + LEASE_MS, updatedAt: now() };
      if (['timer', 'timer-check'].includes(run.trigger) && run.mode !== 'errors' && patch.phase !== 'upload') {
        const { CHECK_CYCLE_ID, getCycleKey } = require('./dailySchedule');
        const cycle = await optional(tx, DAYS, CHECK_CYCLE_ID);
        patch.recoveryCycle = run.checkCycle || (cycle && cycle.status === 'running' && getCycleKey(cycle)) ||
          new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
      }
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
  function onlySourceFailure(row) {
    return row.zeroEligible !== true && row.reason === 'source_read_failed' && row.expectedDurationMinutes === 0 &&
      row.exists === null && row.actualDurationMinutes === null;
  }
  const sameQueueVersion = (row, item) => (row && row.queueVersion || '') === (item.queueVersion || '') &&
    (!row || row.userId === item.userId && row.openid === item.openid);
  const permitsZero = (row, user, recordDate) => !!(user.bijingSyncedDates && user.bijingSyncedDates[recordDate]) ||
    !!(row && row.userId === user._id && row.openid === user._openid &&
      (row.zeroEligible === true || row.expectedDurationMinutes > 0));
  async function writeFailure(database, run, item, reason, knownPrevious) {
    const id = errorId(item.studentNumber, run.recordDate);
    const previous = knownPrevious === undefined ? await optional(database, ERRORS, id) : knownPrevious;
    if (!sameQueueVersion(previous, item)) {
      if (previous) return false;
      // A newer successful personal sync may already have removed its version.
      // The late request still needs reconciliation, even though the queue is
      // now empty. Do not reinstate its old expected total as authoritative.
      reason = 'source_changed';
    }
    const timestamp = now();
    const queueVersion = previous && previous.queueVersion || crypto.randomBytes(16).toString('hex');
    await database.collection(ERRORS).doc(id).set({ data: {
      studentNumber: item.studentNumber, recordDate: run.recordDate, userId: item.userId, openid: item.openid || '',
      bindingStudentNumber: item.bindingStudentNumber || item.studentNumber, nickname: item.nickname || '',
      expectedDurationMinutes: ['source_read_failed', 'source_changed'].includes(reason) ? previous && previous.expectedDurationMinutes || 0 : item.durationMinutes,
      actualDurationMinutes: previous ? previous.actualDurationMinutes : null,
      exists: previous ? previous.exists : null, reason, error: item.uploadError || item.error || '同步未完成，等待自动重试',
      zeroEligible: !!(item.zeroEligible || previous && previous.zeroEligible || item.durationMinutes > 0),
      runId: run._id, retryCount: previous && previous.retryCount || 0, queueVersion,
      createdAt: previous && previous.createdAt || timestamp, updatedAt: timestamp,
    } });
    item.queueVersion = queueVersion;
    return true;
  }
  async function persistFailures(run, items, reason) {
    for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
      await renewLeaseIfNeeded(run);
      const page = items.slice(offset, offset + CHUNK_SIZE);
      const versions = page.map(item => item.queueVersion || '');
      await db.runTransaction(async tx => {
        page.forEach((item, index) => { item.queueVersion = versions[index]; });
        const current = await optional(tx, RUNS, run._id);
        if (!current || current.leaseToken !== run.leaseToken || current.leaseUntil <= now()) throw leaseUnavailable();
        for (const item of page) await writeFailure(tx, run, item, reason || item.failureReason || 'source_read_failed');
      });
    }
  }
  async function checkpoint(run, { items = [], errorChanges = [], sourceFailures = [], sourceResolved = [], cursor, phase, complete = false, error = '', queryFailure = false, releaseLease = true } = {}) {
    const versions = new Map([...items, ...errorChanges.map(change => change.item), ...sourceFailures, ...sourceResolved]
      .map(item => [item, item.queueVersion || '']));
    return db.runTransaction(async tx => {
      for (const [item, version] of versions) item.queueVersion = version;
      const current = await optional(tx, RUNS, run._id);
      if (!current || current.leaseToken !== run.leaseToken || current.leaseUntil <= now()) throw leaseUnavailable();
      // Error handling after a partial commit must preserve the committed
      // cursor, never the snapshot from before the 100-record request.
      if (cursor === undefined) cursor = current.cursor;
      if (phase === undefined) phase = current.phase;
      const counts = { total: current.total || 0, successCount: current.successCount || 0, failedCount: current.failedCount || 0, skippedCount: current.skippedCount || 0, discrepancyCount: current.discrepancyCount || 0 };
      const timestamp = now();
      // Queue versions are captured before reading source data. A later record
      // mutation owns a new version, which an older request must never erase.
      for (const change of errorChanges) {
        const item = change.item;
        const id = errorId(item.studentNumber, run.recordDate);
        const previous = await optional(tx, ERRORS, id);
        if (!sameQueueVersion(previous, item)) {
          item.status = 'failed'; item.retryEligible = false;
          item.error = '源记录在同步期间已变化，保留新待办等待再次核对';
          if (!previous) await writeFailure(tx, run, item, 'source_changed', previous);
          continue;
        }
        if (change.recovered) {
          if (previous) await tx.collection(ERRORS).doc(id).remove();
          item.queueVersion = '';
        } else {
          const queueVersion = previous && previous.queueVersion || crypto.randomBytes(16).toString('hex');
          await tx.collection(ERRORS).doc(id).set({ data: {
            studentNumber: item.studentNumber, recordDate: run.recordDate, userId: item.userId, openid: item.openid || '',
            bindingStudentNumber: item.bindingStudentNumber || item.studentNumber, nickname: item.nickname || '',
            expectedDurationMinutes: item.durationMinutes, actualDurationMinutes: change.result.durationMinutes,
            exists: change.result.exists, reason: change.result.exists ? 'duration_mismatch' : 'missing', error: item.error,
            zeroEligible: !!(item.zeroEligible || previous && previous.zeroEligible),
            runId: run._id, retryCount: (previous && previous.retryCount || 0) + (phase === 'reverify' && item.retryAttempted ? 1 : 0),
            queueVersion, createdAt: previous && previous.createdAt || timestamp, updatedAt: timestamp,
          } });
          item.queueVersion = queueVersion;
        }
      }
      // Transport/source failures are durable pending work, not proof that the
      // remote record is missing. Keep any previously observed remote value.
      for (const item of sourceFailures) await writeFailure(tx, run, item, item.failureReason || 'source_read_failed');
      for (const item of sourceResolved) {
        const id = errorId(item.studentNumber, run.recordDate);
        const previous = await optional(tx, ERRORS, id);
        if (previous && sameQueueVersion(previous, item) && onlySourceFailure(previous) && previous.userId === item.userId && previous.openid === item.openid) {
          await tx.collection(ERRORS).doc(id).remove();
          item.queueVersion = '';
        }
      }
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
      const queryFailures = queryFailure ? (current.queryFailures || 0) + 1 : 0;
      const fatal = error && (!queryFailure || queryFailures >= 3);
      const verifiedWithoutDifferences = run.phase === 'verify' && phase === 'retry' && counts.discrepancyCount === 0;
      const status = fatal ? 'failed' : !(complete || verifiedWithoutDifferences) ? 'running' : counts.failedCount ? (counts.successCount ? 'partial' : 'failed') : 'success';
      const patch = { ...counts, cursor, phase, status, error, queryFailures, updatedAt: timestamp,
        finishedAt: status === 'running' ? null : timestamp, durationMs: timestamp - run.startedAt,
        leaseToken: status === 'running' && !releaseLease ? run.leaseToken : '',
        leaseUntil: status === 'running' && !releaseLease ? timestamp + LEASE_MS : 0, consecutiveInterruptions: 0 };
      await tx.collection(RUNS).doc(run._id).update({ data: patch });
      const sourceScanComplete = current.sourceCheck && current.mode !== 'errors' && current.phase === 'verify' && phase === 'retry';
      await tx.collection(DAYS).doc(run.recordDate).update({ data: { status, activeRunId: status === 'running' ? run._id : '', updatedAt: timestamp,
        ...(sourceScanComplete ? { sourceCheckedAt: timestamp, sourceCheckRunId: run._id, sourceCheckRequired: false } : {}) } });
      if (sourceScanComplete) {
        const { COVERAGE_ID, nextDate } = require('./syncCoverage');
        const progress = await optional(tx, DAYS, COVERAGE_ID);
        if (progress && progress.nextDate === run.recordDate) {
          await tx.collection(DAYS).doc(COVERAGE_ID).update({ data: {
            nextDate: nextDate(run.recordDate), scannedThrough: run.recordDate, updatedAt: timestamp,
          } });
        }
      }
      return publicRun({ ...current, ...patch });
    });
  }
  function leaseUnavailable() {
    const error = new Error('当前批次执行锁已到期或目标日期已切换，等待从已保存进度续跑');
    error.code = 'SYNC_LEASE_UNAVAILABLE';
    return error;
  }
  async function renewLeaseIfNeeded(run) {
    if (run.leaseUntil > now() + RENEW_LEASE_MARGIN_MS) return;
    const leaseUntil = await db.runTransaction(async tx => {
      const current = await optional(tx, RUNS, run._id);
      if (!current || current.status !== 'running' || current.leaseToken !== run.leaseToken || current.leaseUntil <= now()) throw leaseUnavailable();
      const until = now() + LEASE_MS;
      await tx.collection(RUNS).doc(run._id).update({ data: { leaseUntil: until } });
      return until;
    });
    run.leaseUntil = leaseUntil;
  }
  async function commitRows(run, entries, final) {
    if (!entries.length) return checkpoint(run, final);
    let result;
    for (let offset = 0; offset < entries.length;) {
      const candidates = entries.slice(offset, offset + CHUNK_SIZE), page = [];
      const markDeadline = now() + MARK_SLICE_MS;
      await renewLeaseIfNeeded(run);
      for (const entry of candidates) {
        if (page.length && now() >= markDeadline) break;
        page.push(entry);
        if (!entry.errorChange || !entry.errorChange.recovered) continue;
        await renewLeaseIfNeeded(run);
        const item = entry.item;
        try {
          const duration = await getDayDuration(item.openid, run.recordDate, now() + 20000);
          if (!Number.isInteger(duration) || duration < 0) throw new Error('确认同步时读取到无效本地总量');
          if (duration !== item.durationMinutes) {
            item.zeroEligible = item.zeroEligible || item.durationMinutes > 0;
            item.durationMinutes = duration;
            entry.errorChange = compare(item, entry.errorChange.result);
            item.error = '源记录在同步期间已变化，等待按最新总量重试';
            continue;
          }
        } catch (error) {
          item.status = 'failed'; item.retryEligible = false;
          item.error = error.message || '确认同步时读取源记录失败';
          item.failureReason = 'source_read_failed';
          entry.errorChange = null; entry.sourceFailure = true;
          continue;
        }
        try { await markSynced(item.openid, run.recordDate, item.bindingStudentNumber); item.markError = ''; }
        catch (error) { item.markError = error.message || '写入本地同步标记失败'; }
      }
      const last = offset + page.length === entries.length;
      await renewLeaseIfNeeded(run);
      result = await checkpoint(run, {
        items: page.flatMap(entry => entry.item ? [entry.item] : []),
        errorChanges: page.flatMap(entry => entry.errorChange ? [entry.errorChange] : []),
        sourceFailures: page.flatMap(entry => entry.sourceFailure ? [entry.item] : []),
        sourceResolved: page.flatMap(entry => entry.sourceResolved ? [entry.item] : []),
        cursor: last ? final.cursor : page[page.length - 1].cursor,
        phase: last ? final.phase : run.phase,
        complete: last && !!final.complete,
        releaseLease: last,
      });
      // Keep the private token; the public checkpoint result deliberately omits it.
      run.cursor = result.cursor; run.phase = result.phase;
      run.leaseUntil = last ? 0 : result.updatedAt + LEASE_MS;
      offset += page.length;
    }
    return result;
  }
  async function ownersOf(studentNumber) {
    return (await db.collection('users').where({ bijingBound: true, bijingStudentNumber: db.RegExp({ regexp: `^\\s*${studentNumber}\\s*$`, options: 'i' }) }).limit(2).get()).data;
  }
  async function sourcePage(run, cursor) {
    const filter = { bijingBound: true, ...(cursor ? { _id: db.command.gt(cursor) } : {}) };
    const rows = (await db.collection('users').where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
    const entries = [], pending = [];
    const sourceDeadline = now() + SOURCE_SLICE_MS;
    for (const row of rows) {
      // Preserve progress before slow source reads can consume a whole worker.
      // The HTTP capacity stays 100; slow pages are allowed to be smaller.
      if (entries.length && now() >= sourceDeadline) break;
      await renewLeaseIfNeeded(run);
      const readDeadline = now() + 20000;
      const item = { userId: row._id, openid: row._openid || '', studentNumber: normalizeStudentNumber(row.bijingStudentNumber),
        bindingStudentNumber: row.bijingStudentNumber || '', nickname: row.nickName || '', durationMinutes: 0,
        status: 'failed', error: '', attempts: run.attempt, verifyEligible: false, retryEligible: false };
      item._id = itemId(run, item);
      const entry = { cursor: row._id, item };
      entries.push(entry);
      let readingSource = false;
      try {
        if (!row._openid || typeof row.bijingStudentNumber !== 'string') throw new Error('绑定资料不完整，请重新绑定学号');
        if (!validStudentNumber(item.studentNumber)) throw new Error('绑定学号格式错误，请重新绑定');
        readingSource = true;
        const queued = await optional(db, ERRORS, errorId(item.studentNumber, run.recordDate));
        item.queueVersion = queued && queued.queueVersion || '';
        item.zeroEligible = permitsZero(queued, row, run.recordDate);
        const owners = await ownersOf(item.studentNumber);
        if (owners.length !== 1 || owners[0]._id !== row._id || owners[0]._openid !== row._openid) {
          item.failureReason = 'binding_conflict';
          throw new Error('学号绑定已变更或存在冲突，请核对绑定后重试');
        }
        item.durationMinutes = await getDayDuration(row._openid, run.recordDate, readDeadline);
        if (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 0) throw new Error('本地静坐时长无效');
        if (item.durationMinutes === 0 && !item.zeroEligible) {
          item.status = 'skipped'; item.error = '当日无静坐数据'; entry.sourceResolved = true;
          continue;
        }
        item.status = 'pending'; item.verifyEligible = true;
        pending.push(item);
      } catch (error) {
        item.error = error.message || '读取静坐记录失败';
        entry.sourceFailure = readingSource;
      }
    }
    return { rows: rows.slice(0, entries.length), entries, pending,
      hasMore: entries.length < rows.length || rows.length === BATCH_SIZE };
  }
  async function uploadAll(run) {
    let cursor = '';
    const summary = { total: 0, acknowledged: 0, failed: 0, skipped: 0 };
    while (true) {
      await renewLeaseIfNeeded(run);
      if (run.automatic && run.recordDate !== recentDates(1)[0]) throw leaseUnavailable();
      const { rows, entries, pending, hasMore } = await sourcePage(run, cursor);
      if (pending.length) await post(run, pending);
      await persistFailures(run, entries.filter(entry => entry.sourceFailure || entry.item.uploadError).map(entry => {
        if (entry.item.uploadError) entry.item.failureReason = 'upload_failed';
        return entry.item;
      }));
      summary.total += entries.length;
      summary.skipped += entries.filter(entry => entry.item.status === 'skipped').length;
      summary.failed += entries.filter(entry => entry.item.status === 'failed').length + pending.filter(item => item.uploadError).length;
      summary.acknowledged += pending.filter(item => !item.uploadError).length;
      if (!hasMore) break;
      cursor = rows[rows.length - 1]._id;
    }
    await renewLeaseIfNeeded(run);
    return db.runTransaction(async tx => {
      const current = await optional(tx, RUNS, run._id);
      if (!current || current.leaseToken !== run.leaseToken || current.leaseUntil <= now()) throw leaseUnavailable();
      const automaticUpload = run.trigger === 'timer' && !run.verifyImmediately;
      const timestamp = now();
      const patch = { phase: automaticUpload ? 'upload' : 'verify', status: automaticUpload ? 'uploaded' : 'running',
        cursor: '', sourceCheck: true, uploadSummary: summary, uploadedAt: timestamp,
        total: automaticUpload ? summary.total : 0, successCount: 0,
        failedCount: automaticUpload ? summary.failed : 0, skippedCount: automaticUpload ? summary.skipped : 0,
        discrepancyCount: 0, error: '', queryFailures: 0, leaseToken: '', leaseUntil: 0,
        finishedAt: automaticUpload ? timestamp : null, durationMs: timestamp - run.startedAt, updatedAt: timestamp };
      await tx.collection(RUNS).doc(run._id).update({ data: patch });
      await tx.collection(DAYS).doc(run.recordDate).update({ data: {
        status: patch.status, activeRunId: automaticUpload ? '' : run._id, updatedAt: timestamp,
      } });
      return publicRun({ ...current, ...patch });
    });
  }
  async function uploadLegacy(run) {
    // Runs already in progress before source reconciliation retain their item
    // counters and cursor. Resetting counters while keeping those items would
    // double-count later status deltas. New full runs always use uploadAll.
    const { rows, entries, pending, hasMore } = await sourcePage(run, run.cursor);
    if (pending.length) await post(run, pending);
    const complete = !hasMore;
    return commitRows(run, entries,
    { cursor: complete ? '' : rows[rows.length - 1]._id, phase: complete ? 'verify' : 'upload' });
  }
  async function upload(run) {
    if (run.mode !== 'errors') return run.sourceCheck ? uploadAll(run) : uploadLegacy(run);
    const filter = { recordDate: run.recordDate, ...(run.cursor ? { _id: db.command.gt(run.cursor) } : {}) };
    const rows = (await db.collection(ERRORS).where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
    const entries = [];
    const sourceDeadline = now() + SOURCE_SLICE_MS;
    for (const row of rows) {
      if (entries.length && now() >= sourceDeadline) break;
      await renewLeaseIfNeeded(run);
      const readDeadline = now() + 20000;
      const studentNumber = normalizeStudentNumber(row.studentNumber);
      const item = { _id: `${run._id}_${crypto.createHash('sha256').update(`error:${row._id}`).digest('hex').slice(0, 24)}`,
        userId: row.userId || '', openid: row.openid || '', studentNumber,
        bindingStudentNumber: row.bindingStudentNumber || studentNumber, nickname: row.nickname || '',
        durationMinutes: row.expectedDurationMinutes, status: 'failed', error: '', attempts: run.attempt, verifyEligible: false,
        zeroEligible: true, queueVersion: row.queueVersion || '' };
      const entry = { cursor: row._id, item };
      entries.push(entry);
      try {
        if (!validStudentNumber(studentNumber)) throw new Error('错误记录的学号无效，请人工检查');
        const owners = await ownersOf(studentNumber);
        if (owners.length !== 1 || owners[0]._id !== item.userId || owners[0]._openid !== item.openid) throw new Error('学号绑定已变更或存在冲突，保留错误待人工检查');
        // Re-read the source before comparing; old error snapshots cannot
        // establish the current expected value or authorize clearing errors.
        const duration = await getDayDuration(item.openid, run.recordDate, readDeadline);
        if (duration === 0 && !permitsZero(row, owners[0], run.recordDate)) {
          item.durationMinutes = 0; item.status = 'skipped'; item.error = '当日无静坐数据';
          entry.sourceResolved = true;
          continue;
        }
        if (!Number.isInteger(duration) || duration < 0) throw new Error('本地当日静坐数据无效，保留错误待重试');
        item.durationMinutes = duration;
        item.bindingStudentNumber = owners[0].bijingStudentNumber;
        item.verifyEligible = true; item.status = 'pending';
      } catch (error) { item.error = error.message || '读取当前静坐数据失败，保留原错误'; }
    }
    const complete = entries.length === rows.length && rows.length < BATCH_SIZE;
    return commitRows(run, entries,
    { cursor: complete ? '' : entries[entries.length - 1].cursor, phase: complete ? 'verify' : 'upload' });
  }
  async function post(run, items) {
    await assertRequestLease(run);
    const zeroItems = items.filter(item => item.durationMinutes === 0);
    for (const item of zeroItems) {
      await assertRequestLease(run);
      try {
        if (!postZero) throw new Error('单条清零接口尚未配置');
        const response = await postZero(run.recordDate, item.studentNumber);
        item.uploadError = response && response.success === true ? '' : response && response.message || '清零接口未确认成功，等待核对';
      } catch (error) { item.uploadError = errorMessage(error, '请求必经清零接口失败'); }
    }
    items = items.filter(item => item.durationMinutes > 0);
    if (!items.length) return;
    await assertRequestLease(run);
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
  async function assertRequestLease(run) {
    if (run.automatic && !run.allowHistorical && run.recordDate !== recentDates(1)[0]) throw leaseUnavailable();
    await renewLeaseIfNeeded(run);
    const current = await optional(db, RUNS, run._id);
    if (!current || current.status !== 'running' || current.leaseToken !== run.leaseToken ||
      current.leaseUntil < now() + REQUEST_LEASE_MARGIN_MS) {
      throw leaseUnavailable();
    }
  }
  async function phaseRows(run) {
    const filter = { runId: run._id };
    if (run.phase === 'retry' || run.phase === 'reverify') filter.retryEligible = true;
    if (run.cursor) filter._id = db.command.gt(run.cursor);
    return (await db.collection(ITEMS).where(filter).orderBy('_id', 'asc').limit(BATCH_SIZE).get()).data;
  }
  function eligible(item) {
    // Existing pre-reconciliation jobs have no verifyEligible field. Recheck
    // their formerly acknowledged successes before considering them complete.
    return item.verifyEligible !== false && validStudentNumber(item.studentNumber) && Number.isInteger(item.durationMinutes) &&
      (item.durationMinutes > 0 || item.durationMinutes === 0 && item.zeroEligible);
  }
  async function queryExpected(run, pending) {
    const records = pending.map(item => ({ studentNumber: item.studentNumber, recordDate: run.recordDate }));
    await assertRequestLease(run);
    const response = await queryBatch(records);
    if (!response || response.success !== true || !response.data || response.data.total !== pending.length ||
      !Array.isArray(response.data.results) || response.data.results.length !== pending.length) throw new Error('批量核对接口返回无效响应');
    return pending.map((item, index) => {
      const matches = response.data.results.filter(result => result && result.index === index);
      const result = matches.length === 1 ? matches[0] : null;
      if (!result || result.studentNumber !== records[index].studentNumber || result.recordDate !== run.recordDate ||
        typeof result.exists !== 'boolean' || !Number.isInteger(result.durationMinutes) || result.durationMinutes < 0 ||
        (!result.exists && result.durationMinutes !== 0)) throw new Error('批量核对接口返回不完整或不匹配的记录');
      return result;
    });
  }
  function compare(item, result) {
    const recovered = result.durationMinutes === item.durationMinutes && (result.exists || item.durationMinutes === 0);
    item.verifiedAt = now(); item.actualDurationMinutes = result.durationMinutes; item.remoteExists = result.exists;
    item.status = recovered ? 'success' : 'failed'; item.retryEligible = !recovered;
    item.error = recovered ? '' : `${result.exists ? `远端时长为${result.durationMinutes}分钟，期望${item.durationMinutes}分钟` : '远端缺少该学号当日记录'}${item.retryBlocked ? `；${item.retryBlocked}` : ''}`;
    return { item, result, recovered };
  }
  async function verifySource(run) {
    // Users and current local totals are authoritative. The 02:00 upload may
    // have never run or stopped mid-request; its logs are deliberately unused.
    const { rows, entries, pending, hasMore } = await sourcePage(run, run.cursor);
    if (pending.length) {
      let results;
      try { results = await queryExpected(run, pending); }
      catch (error) {
        if (error.code === 'SYNC_LEASE_UNAVAILABLE') throw error;
        for (const item of pending) item.error = errorMessage(error, '远端核对失败');
        await persistFailures(run, entries.filter(entry => entry.sourceFailure).map(entry => entry.item));
        await persistFailures(run, pending, 'query_failed');
        return checkpoint(run, { error: errorMessage(error, '远端核对失败，已记录待重试'), queryFailure: true });
      }
      const changes = new Map(pending.map((item, index) => [item._id, compare(item, results[index])]));
      for (const entry of entries) entry.errorChange = changes.get(entry.item._id);
    }
    const complete = !hasMore;
    return commitRows(run, entries, { cursor: complete ? '' : rows[rows.length - 1]._id, phase: complete ? 'retry' : 'verify' });
  }
  async function verify(run) {
    if (run.phase === 'verify' && run.mode !== 'errors' && run.sourceCheck) return verifySource(run);
    const rows = await phaseRows(run);
    const pending = rows.filter(item => eligible(item) && (run.phase === 'verify' || item.retryEligible));
    const changes = new Map();
    if (pending.length) {
      let results;
      try {
        results = await queryExpected(run, pending);
      } catch (error) {
        if (error.code === 'SYNC_LEASE_UNAVAILABLE') throw error;
        for (const item of pending) item.error = errorMessage(error, '远端核对失败');
        await persistFailures(run, pending, 'query_failed');
        return checkpoint(run, { error: errorMessage(error, '远端核对失败，已记录待重试'), queryFailure: true });
      }
      for (let index = 0; index < pending.length; index++) {
        const item = pending[index];
        changes.set(item._id, compare(item, results[index]));
      }
    }
    const complete = rows.length < BATCH_SIZE;
    const nextPhase = run.phase === 'verify' ? 'retry' : 'reverify';
    return commitRows(run, rows.map(row => ({ cursor: row._id, item: changes.has(row._id) ? row : null, errorChange: changes.get(row._id) })),
    { cursor: complete ? '' : rows[rows.length - 1]._id,
      phase: complete ? nextPhase : run.phase, complete: complete && run.phase === 'reverify' });
  }
  async function retry(run) {
    const rows = await phaseRows(run);
    const items = [], pending = [], processed = [];
    const sourceDeadline = now() + SOURCE_SLICE_MS;
    for (const item of rows) {
      if (processed.length && now() >= sourceDeadline) break;
      await renewLeaseIfNeeded(run);
      const readDeadline = now() + 20000;
      if (!item.retryEligible || !eligible(item)) { processed.push(item); continue; }
      items.push(item);
      try {
        const queued = await optional(db, ERRORS, errorId(item.studentNumber, run.recordDate));
        item.queueVersion = queued && queued.queueVersion || '';
        const owners = await ownersOf(item.studentNumber);
        if (owners.length !== 1 || owners[0]._id !== item.userId || owners[0]._openid !== item.openid) throw new Error('学号绑定已变更或存在冲突，未自动覆盖');
        const duration = await getDayDuration(item.openid, run.recordDate, readDeadline);
        if (!Number.isInteger(duration) || duration < 0) throw new Error('本地当日静坐数据无效，等待重试');
        // Refresh the source under the same day lock before retrying so a stale
        // expected snapshot cannot replace a newer local daily total.
        item.durationMinutes = duration;
        item.zeroEligible = item.zeroEligible || duration === 0 && !!queued;
        item.bindingStudentNumber = owners[0].bijingStudentNumber;
        item.retryAttempted = true; item.retryBlocked = '';
        // Zero uses a single-record endpoint. Commit each zero request before
        // starting another so a worker timeout cannot replay the same prefix.
        if (duration === 0 && pending.length) { items.pop(); break; }
        pending.push(item);
      } catch (error) { item.retryBlocked = error.message || '重试前检查失败'; }
      processed.push(item);
      if (pending.some(row => row.durationMinutes === 0)) break;
    }
    if (pending.length) await post(run, pending);
    await persistFailures(run, pending.filter(item => item.uploadError), 'upload_failed');
    const complete = processed.length === rows.length && rows.length < BATCH_SIZE;
    return commitRows(run, processed.map(row => ({ cursor: row._id, item: items.includes(row) ? row : null })),
    { cursor: complete ? '' : processed[processed.length - 1]._id, phase: complete ? 'reverify' : 'retry' });
  }
  async function processChunk(runId, options = {}) {
    if (typeof runId !== 'string' || !/^\d{13}_[a-f0-9]{16}$/.test(runId)) throw new Error('同步任务ID无效');
    const { run, acquired } = await acquire(runId, options);
    if (!acquired) return { ...publicRun(run), busy: run.status === 'running' && !waitsForCheck(run) };
    run.automatic = !!options.automatic;
    run.allowHistorical = !!options.allowHistorical;
    const checkingSource = run.sourceCheck && run.mode !== 'errors' && run.phase === 'verify';
    let result;
    try {
      if (run.phase === 'upload') result = await upload(run);
      else if (run.phase === 'verify' || run.phase === 'reverify') result = await verify(run);
      else if (run.phase === 'retry') result = await retry(run);
      else throw new Error('未知同步阶段，请重新发起任务');
    } catch (error) {
      if (error.code === 'SYNC_LEASE_UNAVAILABLE') {
        // Do not write through a stale token or classify a slow read as a
        // permanent failure. The next worker replays this uncommitted chunk.
        const current = await optional(db, RUNS, runId);
        return { ...publicRun(current || run), busy: true };
      }
      // Earlier 20-row checkpoints remain committed; record an error without
      // moving their cursor backward. If this write also fails, the lease expires.
      return checkpoint(run, { error: error.message || '同步任务执行失败' });
    }
    // A completed old gap can have many already checked dates behind it. Finish
    // their durable, bounded watermark pages so manual repair clears its alert.
    if (checkingSource && result.phase === 'retry') await coverage().settle();
    return result;
  }
  async function processBatch(runId, { automatic = false, allowHistorical = false, expectedPhase } = {}) {
    if (typeof runId !== 'string' || !/^\d{13}_[a-f0-9]{16}$/.test(runId)) throw new Error('同步任务ID无效');
    const initial = await optional(db, RUNS, runId);
    if (!initial) throw new Error('同步任务不存在');
    const phase = expectedPhase || initial.phase || 'upload';
    return processChunk(runId, { expectedPhase: phase, automatic, allowHistorical });
  }
  async function retryErrors(operator = '', automatic = false) {
    // A persistent scan cursor keeps one permanently broken date (or >20 errors
    // on that date) from starving later dates. Manual retries have no date cutoff.
    const scheduler = await optional(db, DAYS, REPAIR_CURSOR_ID);
    const filter = {};
    if (scheduler && scheduler.cursor) filter._id = db.command.gt(scheduler.cursor);
    let rows = (await db.collection(ERRORS).where(filter).orderBy('_id', 'asc').limit(CHUNK_SIZE).get()).data;
    if (!rows.length && scheduler && scheduler.cursor) rows = (await db.collection(ERRORS).orderBy('_id', 'asc').limit(CHUNK_SIZE).get()).data;
    await db.collection(DAYS).doc(REPAIR_CURSOR_ID).set({ data: { cursor: rows.length === CHUNK_SIZE ? rows[rows.length - 1]._id : '', updatedAt: now() } });
    for (const recordDate of [...new Set(rows.map(row => row.recordDate))]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) continue;
      await db.collection(DAYS).doc(REPAIR_CURSOR_ID).set({ data: { cursor: `${recordDate}~`, updatedAt: now() } });
      return startRun(recordDate, automatic ? 'timer-errors' : 'manual-errors', operator, 'errors');
    }
    return null;
  }
  async function startDailyUpload() {
    return startRun(recentDates(1)[0], 'timer', '', 'full', { upload: true });
  }
  async function startScheduledRepair(recordDate, cycleDate, cycleKey) {
    for (const date of [recordDate, cycleDate]) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error('修复日期无效');
      }
    }
    if (recordDate !== new Date(Date.parse(`${cycleDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)) {
      throw new Error('自动修复仅处理核对日期前一天的静坐日');
    }
    return startRun(recordDate, 'timer-errors', '', 'errors', { repairCycle: cycleKey || cycleDate,
      ...(cycleKey ? { authorizedCycle: cycleKey, cycleDate } : {}) });
  }
  async function resumeActive({ batch = false, recordDate = recentDates(1)[0] } = {}) {
    const processRun = runId => batch ? processBatch(runId, { automatic: true }) : processChunk(runId, { automatic: true });
    let cursor = '', candidate = null, busy = null;
    // Automatic continuation only touches the latest completed meditation day.
    // Historical work remains available through explicit runId/manual actions.
    while (true) {
      const filter = { status: 'running', recordDate, ...(cursor ? { _id: db.command.gt(cursor) } : {}) };
      const rows = (await db.collection(RUNS).where(filter).orderBy('_id', 'asc').limit(PAGE_SIZE).get()).data;
      for (const run of rows) {
        // Upload has no durable cursor. An interrupted automatic upload waits
        // for the next scheduled source check instead of starting over.
        if (run.trigger === 'timer' && run.mode !== 'errors' && (!run.phase || run.phase === 'upload')) continue;
        if (waitsForCheck(run)) continue;
        if (run.leaseUntil > now()) { busy = busy || run; continue; }
        if (run.mode !== 'errors' && (!run.phase || run.phase === 'upload')) return processRun(run._id);
        candidate = candidate || run;
      }
      if (rows.length < PAGE_SIZE) break;
      cursor = rows[rows.length - 1]._id;
    }
    if (candidate) return processRun(candidate._id);
    if (busy) return { ...publicRun(busy), busy: true };
    return resumeFailedRun({ batch, recordDate });
  }
  async function resumeFailedRun({ batch = false, recordDate = recentDates(1)[0] } = {}) {
    const { CHECK_CYCLE_ID, getCycleKey } = require('./dailySchedule');
    const cycle = await optional(db, DAYS, CHECK_CYCLE_ID);
    if (!cycle || cycle.status !== 'running' ||
      recordDate !== new Date(Date.parse(`${cycle.cycleDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)) return null;
    let cursor = '';
    while (true) {
      const filter = { status: 'failed', recordDate, ...(cursor ? { _id: db.command.gt(cursor) } : {}) };
      const rows = (await db.collection(RUNS).where(filter).orderBy('_id', 'asc').limit(PAGE_SIZE).get()).data;
      for (const failed of rows) {
        // A scan/query/worker failure may occur before any discrepancy exists.
        // Resume its checkpoint once per check cycle instead of losing the job.
        // Per-item source failures already have entries in the repair queue.
        if (failed.mode === 'errors' || (failed.trigger === 'timer' && (!failed.phase || failed.phase === 'upload')) ||
          !failed.error || failed.recoveryCycle >= getCycleKey(cycle)) continue;
        const resumed = await db.runTransaction(async tx => {
          const currentCycle = await optional(tx, DAYS, CHECK_CYCLE_ID);
          const run = await optional(tx, RUNS, failed._id);
          const day = await optional(tx, DAYS, failed.recordDate);
          if (!currentCycle || currentCycle.status !== 'running' || getCycleKey(currentCycle) !== getCycleKey(cycle) ||
            !run || run.recordDate !== recordDate || run.status !== 'failed' || !run.error || run.recoveryCycle >= getCycleKey(cycle) || !day ||
            (day.latestFullRunId || day.latestRunId) !== run._id || day.activeRunId) return false;
          await tx.collection(RUNS).doc(run._id).update({ data: {
            status: 'running', finishedAt: null, error: '', queryFailures: 0,
            consecutiveInterruptions: 0, leaseToken: '', leaseUntil: 0,
            recoveryCycle: getCycleKey(cycle), updatedAt: now(),
          } });
          await tx.collection(DAYS).doc(run.recordDate).update({ data: {
            status: 'running', activeRunId: run._id, updatedAt: now(),
          } });
          return true;
        });
        if (resumed) return batch ? processBatch(failed._id, { automatic: true }) : processChunk(failed._id, { automatic: true });
      }
      if (rows.length < PAGE_SIZE) return null;
      cursor = rows[rows.length - 1]._id;
    }
  }
  async function timer(triggerName) {
    const { createDailySchedule, CHECK_CYCLE_ID, getCycleKey } = require('./dailySchedule');
    const dailySync = triggerName === 'dailySyncBijing';
    const schedule = createDailySchedule({
      db, now, jobs: { startDailyUpload, startScheduledRepair,
        repairPending: async (cycleKey, processCurrent) => {
          await coverage().plan();
          const result = await require('./pendingRepairs').createPendingRepairs({
            db, now, latestDate: () => recentDates(1)[0], processBatch, processCurrent,
            ensureSourceCheck: recordDate => coverage().ensureDate(recordDate),
            startRepair: (recordDate, repairCycle) => startRun(recordDate, 'timer-errors', '', 'errors', { repairCycle }),
          }).run(cycleKey);
          await coverage().advance();
          return result;
        },
        ensureDailyCheck: require('./sourceCheck').createSourceCheck({ db, now }).ensureDailyCheck,
        resumeActive: options => resumeActive({ ...options, batch: true }),
        processChunk: runId => processBatch(runId, { automatic: true }) },
    });
    const recordDate = recentDates(1)[0];
    const cycleProgress = cycle => JSON.stringify(cycle && [getCycleKey(cycle), cycle.cursor, cycle.status]);
    const seen = new Set();
    let nextTrigger = triggerName, last = null;
    // The 100-record limit bounds an API batch, not the whole invocation.
    // There is no wall-clock cutoff: ordinary progress continues in this call.
    while (recentDates(1)[0] === recordDate) {
      const cycleBefore = dailySync ? null : await optional(db, DAYS, CHECK_CYCLE_ID);
      // Finish this daily run through the same verification and repair phases
      // as manual synchronization, without opening an hourly check cycle.
      const result = dailySync && last
        ? await processBatch(last.runId, { automatic: true })
        : await schedule.timer(nextTrigger);
      nextTrigger = 'resumeBijingBatches';
      if (result != null) last = result;
      if (recentDates(1)[0] !== recordDate) break;
      if (result == null) {
        // null may also mean a malformed error row was skipped. Continue only
        // if the authorized repair cycle actually advanced and is still open.
        const cycleAfter = await optional(db, DAYS, CHECK_CYCLE_ID);
        if (cycleAfter && cycleAfter.status === 'running' && cycleProgress(cycleAfter) !== cycleProgress(cycleBefore)) continue;
        break;
      }
      if (result.busy || result.status === 'waiting' || result.status === 'uploaded' || result.error) break;
      if (dailySync && !['running', 'interrupted'].includes(result.status)) break;
      const progress = JSON.stringify([result.runId, result.recordDate, result.phase, result.cursor, result.status,
        result.total, result.successCount, result.failedCount, result.skippedCount, result.discrepancyCount, result.queryFailures]);
      if (seen.has(progress)) break;
      seen.add(progress);
    }
    return last;
  }
  async function listRuns(recordDate, cursor) {
    if (recordDate) validateDate(recordDate);
    // The overview stays compact; an explicitly selected date uses the same
    // thirty-day range offered for manual synchronization.
    const dates = recordDate ? [recordDate] : recentDates(7);
    // Active repairs can target older dates; keep their continuation independent
    // of the bounded history, using the same indexed lookup as the timer.
    const activeRun = (await db.collection(RUNS).where({ status: 'running' }).orderBy('startedAt', 'asc').limit(1).get()).data[0];
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
  async function repairCoverage(operator = '') { return publicRun(await coverage().repair(operator)) || { runId: '' }; }
  return { start, processChunk, processBatch, timer, listRuns, details, listErrors, retryErrors, startDailyUpload, startScheduledRepair, resumeActive, repairCoverage };
}
module.exports = { createBatchJobs, BATCH_SIZE, CHUNK_SIZE, errorId };
