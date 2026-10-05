const crypto = require('crypto');
const COLLECTION = 'backfill_requests';
const LEASE_MS = 90000;

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function busy() {
  return syncError('BACKFILL_SYNC_BUSY', '这一天正在同步或同步授权已过期，请稍后重试');
}

function errorText(error) {
  return [error && error.code, error && error.errCode, error && error.message, error && error.errMsg].join(' ');
}

function isMissingCollection(error) {
  return [error && error.code, error && error.errCode].map(String).includes('-502005') ||
    /\b(?:DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)\b/i.test(errorText(error)) ||
    /\bcollection\b(?:\s+["'`]?[\w.-]+["'`]?)?\s+(?:(?:does|is)\s+)?(?:not exists?|not found)\b|集合\s*(?:["'`]?[\w.-]+["'`]?)?\s*不存在/i.test(errorText(error));
}

function isExistingCollection(error) {
  return /\b(?:DATABASE_COLLECTION_(?:ALREADY_)?EXISTS?|COLLECTION_ALREADY_EXISTS?|TCB_DB_COLLECTION_EXISTS)\b/i.test(errorText(error)) ||
    /\bcollection\b[^\n]*\balready exists?\b|集合[^\n]*已存在/i.test(errorText(error));
}

async function optionalDocument(database, id) {
  try {
    const response = await database.collection(COLLECTION).doc(id).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('Invalid backfill response');
    if (response.data === null || response.data === undefined) return null;
    if (typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('Invalid backfill document');
    return response.data;
  } catch (error) {
    if (!isMissingCollection(error) && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(errorText(error))) return null;
    throw error;
  }
}

async function prepareLeaseCollection(db, id) {
  try { await optionalDocument(db, id); }
  catch (error) {
    if (!isMissingCollection(error)) throw error;
    try { await db.createCollection(COLLECTION); }
    catch (creationError) { if (!isExistingCollection(creationError)) throw creationError; }
    // Ordinary records may sync before any retreat application exists. Only
    // create an empty server-owned collection and verify it really is readable.
    await optionalDocument(db, id);
  }
}

// 同一账户同一天只有一个历史记录同步任务能够上报。租约过期后可重试；
// 旧任务每次外部 POST 前均须重验 token，不能覆盖新任务的结果。
async function acquireLease(db, openid, recordDate, now) {
  const id = 'bs_' + crypto.createHash('sha256').update(JSON.stringify([openid, recordDate])).digest('hex');
  const token = crypto.randomBytes(24).toString('hex');
  await prepareLeaseCollection(db, id);
  await db.runTransaction(async transaction => {
    const current = await optionalDocument(transaction, id), timestamp = now();
    if (current && (current.kind !== 'sync_lock' || current.ownerOpenid !== openid || current.recordDate !== recordDate)) {
      throw new Error('Invalid backfill sync lock');
    }
    if (current && current.token && (!Number.isFinite(current.leaseUntil) || current.leaseUntil > timestamp)) throw busy();
    await transaction.collection(COLLECTION).doc(id).set({ data: {
      kind: 'sync_lock', ownerOpenid: openid, recordDate, token,
      leaseUntil: timestamp + LEASE_MS, updatedAt: new Date(timestamp).toISOString()
    } });
  });
  return { id, token };
}

async function verifyLease(db, lease, now) {
  const current = await optionalDocument(db, lease.id);
  if (!current || current.kind !== 'sync_lock' || current.token !== lease.token ||
      !Number.isFinite(current.leaseUntil) || current.leaseUntil <= now()) throw busy();
}

async function releaseLease(db, lease, now) {
  await db.runTransaction(async transaction => {
    const current = await optionalDocument(transaction, lease.id);
    // A timed-out worker may never release its successor's lease.
    if (!current || current.kind !== 'sync_lock' || current.token !== lease.token) return;
    const { _id, ...stored } = current;
    await transaction.collection(COLLECTION).doc(lease.id).set({ data: {
      ...stored, token: '', leaseUntil: 0, updatedAt: new Date(now()).toISOString()
    } });
  });
}

// 仅同步本人获批且曾补录的日期。过期仅禁止新增，不阻止失败重试和删除后的总量修正。
async function syncBackfillDate({ db, openid, requestId, recordDate, expectedOpenid,
  syncDate, getDayDuration, now = Date.now, logger = console }) {
  if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请先登录' };
  if (expectedOpenid !== undefined && expectedOpenid !== openid) {
    return { success: false, code: 'ACCOUNT_CHANGED', error: '登录账号已变化，请重新进入申请补录' };
  }
  if (typeof requestId !== 'string' || !/^br_[a-f0-9]{64}$/.test(requestId) ||
      typeof recordDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate) ||
      !Number.isFinite(Date.parse(`${recordDate}T00:00:00Z`)) ||
      new Date(`${recordDate}T00:00:00Z`).toISOString().slice(0, 10) !== recordDate) {
    return { success: false, code: 'INVALID_ARGUMENT', error: '补录同步日期或申请无效' };
  }
  try {
    const grant = await optionalDocument(db, requestId);
    if (!grant || grant.kind !== 'request' || grant.ownerOpenid !== openid || grant.status !== 'approved' ||
        recordDate < grant.startDate || recordDate > grant.endDate) {
      return { success: false, code: 'BACKFILL_INVALID_GRANT', error: '只能同步本人已获批范围内的补录记录' };
    }
    const wasRecorded = Array.isArray(grant.recordedDates) && grant.recordedDates.includes(recordDate);
    if (!wasRecorded) {
      // 已有申请尚无历史凭据时，仍支持现存的旧补录记录。
      const saved = await db.collection('meditation_records').where({
        _openid: openid, source: 'manual', date: recordDate, backfillRequestId: requestId
      }).field({ _id: true }).limit(1).get();
      if (!saved || !Array.isArray(saved.data)) throw new Error('补录记录暂时无法读取');
      if (!saved.data.length) return { success: false, code: 'BACKFILL_RECORD_REQUIRED', error: '这一天尚无已保存的获批补录记录' };
    }
    return syncDayWithLease({ db, openid, recordDate, syncDate, getDayDuration, now, logger });
  } catch (error) {
    return { success: false, code: 'BACKFILL_SYNC_FAILED', error: '补录已保存，同步暂未完成，请稍后重试' };
  }
}

// 已保存普通记录和获批补录共用账户/日期租约及总量复核，避免各自上报旧总量。
async function syncDayWithLease({ db, openid, recordDate, syncDate, getDayDuration, now = Date.now, logger = console }) {
  let lease;
  try {
    lease = await acquireLease(db, openid, recordDate, now);
    const beforePost = () => verifyLease(db, lease, now);
    for (let attempt = 0; attempt < 3; attempt++) {
      await beforePost();
      const synced = await syncDate(openid, recordDate, { beforePost, allowZero: true });
      if (synced && synced.skipped === true) return { success: true, data: { date: recordDate, ...synced } };
      if (!synced || synced.success !== true) {
        return { success: false, code: synced && synced.code === 'BACKFILL_SYNC_BUSY' ? 'BACKFILL_SYNC_BUSY' : 'BACKFILL_SYNC_FAILED',
          error: synced && synced.error || '同步失败，请重试' };
      }
      const latestDuration = await getDayDuration(openid, recordDate);
      await beforePost();
      if (Number.isFinite(latestDuration) && latestDuration === synced.duration) {
        return { success: true, data: { date: recordDate, ...synced } };
      }
      if (!Number.isFinite(latestDuration)) throw new Error('Invalid backfill day duration');
    }
    return { success: false, code: 'BACKFILL_SYNC_RETRY', error: '同步期间这一天的记录有变动，请稍后重新同步' };
  } catch (error) {
    if (error && error.code === 'BACKFILL_SYNC_BUSY') return { success: false, code: error.code, error: error.message };
    return { success: false, code: 'BACKFILL_SYNC_FAILED', error: '记录已保存，同步暂未完成，请稍后重试' };
  } finally {
    if (lease) {
      try { await releaseLease(db, lease, now); }
      catch (error) {
        // A correct remote result remains correct when cleanup fails. The lease
        // expires automatically; retain diagnostics without hiding that result.
        logger.warn('记录同步租约释放失败，将等待租约过期:', error && (error.code || error.message || error.errMsg));
      }
    }
  }
}

module.exports = { syncBackfillDate, syncDayWithLease };
