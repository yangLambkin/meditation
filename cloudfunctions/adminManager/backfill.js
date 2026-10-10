// Keep this module identical in meditationManager and adminManager: cloud functions
// are deployed separately and cannot require files from a sibling deployment.
const crypto = require('crypto');
const COLLECTION = 'backfill_requests';
const DAY = 86400000;
const STATUSES = ['pending', 'approved', 'rejected'];
const KNOWN_ERRORS = new Set(['AUTH_REQUIRED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'CONFLICT',
  'REQUEST_ID_REUSED', 'CONTENT_REJECTED', 'CONTENT_CHECK_FAILED', 'ACTIVE_REQUEST_EXISTS',
  'BACKFILL_INVALID_GRANT', 'BACKFILL_EXPIRED', 'BACKFILL_DATE_OUT_OF_RANGE']);

function backfillError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorText(error) {
  return typeof error === 'string' ? error : [error && error.code, error && error.errCode,
    error && error.message, error && error.errMsg].filter(value => value !== undefined).join(' ');
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

async function optionalRequest(database, id) {
  try {
    const result = await database.collection(COLLECTION).doc(id).get();
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid backfill response');
    if (result.data === null || result.data === undefined) return null;
    if (typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid backfill document');
    return result.data;
  } catch (error) {
    if (!isMissingCollection(error) && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(errorText(error))) return null;
    throw error;
  }
}

function requireIdentity(openid) {
  if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)) {
    throw backfillError('AUTH_REQUIRED', '请先登录后再申请补录');
  }
}

function textValue(value, maximum, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > maximum || (!optional && !value.trim())) {
    throw backfillError('INVALID_ARGUMENT', `${label}${optional ? '不能超过' : '须为 1–'}${maximum} 个字符`);
  }
  return value.trim();
}

function isTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isRequestId(value) {
  return typeof value === 'string' && /^br_[a-f0-9]{64}$/.test(value);
}

function pagination(event) {
  const limit = event.limit === undefined ? 20 : event.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw backfillError('INVALID_ARGUMENT', '每页数量须为 1–50');
  if (event.cursor === undefined || event.cursor === '') return { limit, cursor: null };
  try {
    if (typeof event.cursor !== 'string' || event.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(event.cursor)) throw new Error('cursor');
    const decoded = Buffer.from(event.cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const cursor = JSON.parse(decoded);
    if (!Array.isArray(cursor) || cursor.length !== 2 || !isTimestamp(cursor[0]) || !isRequestId(cursor[1])) throw new Error('cursor');
    return { limit, cursor };
  } catch (_) {
    throw backfillError('INVALID_ARGUMENT', '分页信息无效，请刷新后重试');
  }
}

function encodeCursor(row) {
  if (!isTimestamp(row.createdAt) || !isRequestId(row._id)) throw new Error('Invalid backfill pagination');
  return Buffer.from(JSON.stringify([row.createdAt, row._id])).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function moderate(cloud, openid, content) {
  if (!content) return;
  try {
    const response = await cloud.openapi.security.msgSecCheck({ content, version: 2, scene: 2, openid });
    const code = response && (response.errCode !== undefined ? response.errCode : response.errcode);
    if (code !== undefined && code !== null && Number(code) !== 0) throw response;
    const suggestion = response && response.result && response.result.suggest;
    if (suggestion === 'pass') return;
    if (suggestion === 'risky' || suggestion === 'review') throw backfillError('CONTENT_REJECTED', '内容未通过安全检测，请修改后重试');
    throw backfillError('CONTENT_CHECK_FAILED', '内容安全检测暂不可用，请稍后重试');
  } catch (error) {
    if (error && ['CONTENT_REJECTED', 'CONTENT_CHECK_FAILED'].includes(error.code)) throw error;
    const code = error && (error.errCode !== undefined ? error.errCode : error.errcode);
    if (Number(code) === 87014) throw backfillError('CONTENT_REJECTED', '内容未通过安全检测，请修改后重试');
    // Never publish on missing permissions, network failures or unknown results.
    throw backfillError('CONTENT_CHECK_FAILED', '内容安全检测暂不可用，请稍后重试');
  }
}

async function profileSnapshot(db, openid) {
  let cursor = '', first = null, bound = null, versioned = null;
  for (;;) {
    const response = await db.collection('users').where({ _openid: openid,
      ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
      .field({ _id: true, nickName: true, bijingBound: true, bijingStudentNumber: true, bijingBindingVersion: true })
      .orderBy('_id', 'asc').limit(100).get();
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid profile response');
    const rows = response.data;
    if (!first && rows.length) first = rows[0];
    const candidates = rows.filter(row => row.bijingBound === true && typeof row.bijingStudentNumber === 'string' && row.bijingStudentNumber.trim());
    if (!bound && candidates.length) bound = candidates[0];
    versioned = candidates.find(row => typeof row.bijingBindingVersion === 'string' && row.bijingBindingVersion.trim());
    if (versioned || rows.length < 100) break;
    const next = rows[rows.length - 1]._id;
    if (typeof next !== 'string' || next <= cursor) throw new Error('Invalid profile pagination');
    cursor = next;
  }
  const user = versioned || bound || first || {};
  return {
    nickname: typeof user.nickName === 'string' && user.nickName.trim() ? user.nickName.trim() : '匿名用户',
    studentNumber: user.bijingBound === true && typeof user.bijingStudentNumber === 'string' ? user.bijingStudentNumber.trim() : ''
  };
}

function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const number = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value ? number : NaN;
}

function range(startDate, endDate) {
  const start = dateNumber(startDate), end = dateNumber(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start >= 30 * DAY) {
    throw backfillError('INVALID_ARGUMENT', '请选择有效的闭关日期，含首尾最多 30 天');
  }
  return { start, end };
}

function assertSubmissionWindow(startDate, endDate, now) {
  const bounds = range(startDate, endDate);
  // Beijing's business day starts at 02:00 (18:00 UTC on the preceding day).
  const today = dateNumber(new Date(now + 6 * 3600000).toISOString().slice(0, 10));
  if (bounds.start < today - 30 * DAY || bounds.end >= today) {
    throw backfillError('INVALID_ARGUMENT', '只能申请今天之前最近 30 天内的日期');
  }
  return bounds;
}

function legacyExpiresAt(row) {
  return new Date(range(row.startDate, row.endDate).end + 8 * DAY - 6 * 3600000).toISOString();
}

function assertLegacyOpenWindow(startDate, endDate, now) {
  const bounds = range(startDate, endDate);
  const today = dateNumber(new Date(now + 6 * 3600000).toISOString().slice(0, 10));
  if (bounds.end >= today) throw backfillError('INVALID_ARGUMENT', '只能申请已经结束的闭关日期');
  if (now >= Date.parse(legacyExpiresAt({ startDate, endDate }))) {
    throw backfillError('BACKFILL_EXPIRED', '已超过原申请的补录期限');
  }
  return bounds;
}

function expiresAt(row) {
  // Existing applications retain their original deadline; deploying new rules
  // must never revive expired grants or extend an old pending application.
  if (row.ruleVersion !== 2) return legacyExpiresAt(row);
  return row.status === 'approved' && isTimestamp(row.expiresAt) ? row.expiresAt : null;
}

function isExpired(row, now) {
  const deadline = expiresAt(row);
  if (row.ruleVersion === 2 && row.status !== 'approved') return false;
  // Missing/corrupt approved deadlines fail closed, while pending v2 requests
  // have no recording permission or countdown until an administrator approves.
  return !deadline || now >= Date.parse(deadline);
}

function publicRequest(row, admin, now) {
  const deadline = expiresAt(row), expired = isExpired(row, now);
  const recordedDates = Array.isArray(row.recordedDates) ? [...new Set(row.recordedDates.filter(date =>
    Number.isFinite(dateNumber(date)) && date >= row.startDate && date <= row.endDate))].sort() : [];
  const result = { _id: row._id, nickname: row.nickname || '匿名用户', studentNumber: row.studentNumber || '',
    startDate: row.startDate, endDate: row.endDate, reason: row.reason, status: row.status,
    reply: row.reply || '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    handledAt: row.handledAt || null, unreadForUser: row.unreadForUser === true,
    ruleVersion: row.ruleVersion === 2 ? 2 : 1,
    expiresAt: deadline, expired, canRecord: row.status === 'approved' && !expired, recordedDates };
  if (admin) { result.ownerOpenid = row.ownerOpenid; result.handledBy = row.handledBy || ''; }
  return result;
}

const requestIdFor = (openid, requestId) => 'br_' + crypto.createHash('sha256').update(JSON.stringify([openid, requestId])).digest('hex');
const lockIdFor = openid => 'bl_' + crypto.createHash('sha256').update(openid).digest('hex');
const isActive = (row, now) => Boolean(row && row.kind === 'request' && ['pending', 'approved'].includes(row.status) && !isExpired(row, now));

// Call inside the same transaction that adds the meditation. Approval and
// ownership cannot be asserted from client parameters or a prior, separate read.
async function assertBackfillGrant(transaction, openid, id, date, now = Date.now(), { allowExpiredReplay = false } = {}) {
  requireIdentity(openid);
  if (!isRequestId(id)) throw backfillError('BACKFILL_INVALID_GRANT', '请选择已通过审批的补录申请');
  let row;
  try { row = await optionalRequest(transaction, id); }
  catch (error) { if (!isMissingCollection(error)) throw error; }
  if (!row || row.kind !== 'request' || row.ownerOpenid !== openid || row.status !== 'approved') {
    throw backfillError('BACKFILL_INVALID_GRANT', '补录申请未通过审批或不属于本人');
  }
  const bounds = range(row.startDate, row.endDate);
  // 原有本机记录的固定身份重放不受恢复联网时刻限制；新补录仍遵循期限。
  // 缺失或损坏的批准期限不能视为一个曾经有效、现在仅过期的申请。
  if (isExpired(row, now) && !(allowExpiredReplay && expiresAt(row))) {
    throw backfillError('BACKFILL_EXPIRED', '补录申请已过期，请查看申请结果');
  }
  const selected = dateNumber(date);
  if (!Number.isFinite(selected) || selected < bounds.start || selected > bounds.end) {
    throw backfillError('BACKFILL_DATE_OUT_OF_RANGE', '补录日期不在获批范围内');
  }
  return row;
}

function createBackfillService({ db, cloud, now: clock = Date.now }) {
  const now = () => typeof clock === 'function' ? clock() : clock;
  async function readForSubmit(id) {
    try { return await optionalRequest(db, id); }
    catch (error) {
      if (!isMissingCollection(error)) throw error;
      try { await db.createCollection(COLLECTION); }
      catch (creationError) { if (!isExistingCollection(creationError)) throw creationError; }
      return optionalRequest(db, id);
    }
  }

  function duplicate(row, openid, event) {
    if (row.kind !== 'request' || row.ownerOpenid !== openid) throw backfillError('NOT_FOUND', '补录申请不存在');
    if (row.startDate !== event.startDate || row.endDate !== event.endDate || row.reason !== event.reason) {
      throw backfillError('REQUEST_ID_REUSED', '本次申请标识已使用，请刷新后重新提交');
    }
    return { request: publicRequest(row, false, now()) };
  }

  async function lockedRequest(transaction, openid) {
    const lockId = lockIdFor(openid), lock = await optionalRequest(transaction, lockId);
    if (lock && (lock.kind !== 'lock' || lock.ownerOpenid !== openid)) throw new Error('Invalid backfill lock');
    let active = null;
    if (lock && lock.activeRequestId) {
      if (!isRequestId(lock.activeRequestId)) throw new Error('Invalid backfill lock reference');
      active = await optionalRequest(transaction, lock.activeRequestId);
      if (active && (active.kind !== 'request' || active.ownerOpenid !== openid)) throw new Error('Invalid backfill lock owner');
    }
    return { lockId, lock, active };
  }

  async function submit(openid, event) {
    requireIdentity(openid);
    const reason = textValue(event.reason, 500, '申请说明');
    range(event.startDate, event.endDate);
    if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(event.requestId)) {
      throw backfillError('INVALID_ARGUMENT', '申请提交标识无效，请刷新后重试');
    }
    const id = requestIdFor(openid, event.requestId), normalized = { ...event, reason };
    const existing = await readForSubmit(id);
    // A committed submission remains retryable across expiration and moderation outages.
    if (existing) return duplicate(existing, openid, normalized);
    assertSubmissionWindow(event.startDate, event.endDate, now());
    await moderate(cloud, openid, reason);
    const snapshot = await profileSnapshot(db, openid);
    return db.runTransaction(async transaction => {
      const concurrent = await optionalRequest(transaction, id);
      if (concurrent) return duplicate(concurrent, openid, normalized);
      const locked = await lockedRequest(transaction, openid), timestamp = now();
      assertSubmissionWindow(event.startDate, event.endDate, timestamp);
      if (isActive(locked.active, timestamp)) throw backfillError('ACTIVE_REQUEST_EXISTS', '已有待审批或有效的补录申请，请先查看该申请');
      const iso = new Date(timestamp).toISOString();
      const row = { kind: 'request', ownerOpenid: openid, ...snapshot, startDate: event.startDate, endDate: event.endDate,
        reason, status: 'pending', reply: '', createdAt: iso, updatedAt: iso,
        handledAt: null, handledBy: '', unreadForUser: false, ruleVersion: 2, expiresAt: null };
      await transaction.collection(COLLECTION).doc(id).set({ data: row });
      await transaction.collection(COLLECTION).doc(locked.lockId).set({ data: {
        kind: 'lock', ownerOpenid: openid, activeRequestId: id, updatedAt: iso } });
      return { request: publicRequest({ ...row, _id: id }, false, timestamp) };
    });
  }

  async function list(openid, event, admin = false) {
    requireIdentity(openid);
    const { limit, cursor } = pagination(event), status = event.status === undefined ? 'all' : event.status;
    if (admin && !['all', ...STATUSES].includes(status)) throw backfillError('INVALID_ARGUMENT', '补录申请状态无效');
    let filter = { kind: 'request', ...(admin ? (status === 'all' ? {} : { status }) : { ownerOpenid: openid }) };
    if (cursor) filter = db.command.and([filter, db.command.or([
      { createdAt: db.command.lt(cursor[0]) }, { createdAt: cursor[0], _id: db.command.lt(cursor[1]) }
    ])]);
    let response;
    try {
      response = await db.collection(COLLECTION).where(filter).orderBy('createdAt', 'desc')
        .orderBy('_id', 'desc').limit(limit + 1).get();
    } catch (error) {
      if (isMissingCollection(error)) return { requests: [], nextCursor: '' };
      throw error;
    }
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid backfill response');
    const page = response.data.slice(0, limit), timestamp = now();
    return { requests: page.map(row => publicRequest(row, admin, timestamp)),
      nextCursor: response.data.length > limit ? encodeCursor(page[page.length - 1]) : '' };
  }

  async function alert(openid, admin = false) {
    requireIdentity(openid);
    const resultKey = admin ? 'hasPendingBackfill' : 'hasUnreadBackfill';
    const filter = admin ? db.command.or([
      { kind: 'request', status: 'pending', ruleVersion: 2 },
      { kind: 'request', status: 'pending', expiresAt: db.command.gt(new Date(now()).toISOString()) }
    ]) :
      { kind: 'request', ownerOpenid: openid, unreadForUser: true };
    let response;
    try { response = await db.collection(COLLECTION).where(filter).field({ _id: true }).limit(1).get(); }
    catch (error) { if (isMissingCollection(error)) return { [resultKey]: false }; throw error; }
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid backfill alert response');
    return { [resultKey]: response.data.length > 0 };
  }

  async function markRead(openid, event) {
    requireIdentity(openid);
    if (!Array.isArray(event.requests) || event.requests.length > 50 || event.requests.some(row =>
      !row || !isRequestId(row.requestId) || !isTimestamp(row.expectedUpdatedAt)) ||
      new Set(event.requests.map(row => row.requestId)).size !== event.requests.length) {
      throw backfillError('INVALID_ARGUMENT', '补录申请已读参数无效，请刷新后重试');
    }
    if (!event.requests.length) return { markedCount: 0 };
    try {
      return await db.runTransaction(async transaction => {
        const seen = [];
        for (const item of event.requests) {
          const row = await optionalRequest(transaction, item.requestId);
          if (row && row.kind === 'request' && row.ownerOpenid === openid && ['approved', 'rejected'].includes(row.status) &&
            row.unreadForUser === true && row.updatedAt === item.expectedUpdatedAt) seen.push(item.requestId);
        }
        for (const id of seen) await transaction.collection(COLLECTION).doc(id).update({ data: { unreadForUser: false } });
        return { markedCount: seen.length };
      });
    } catch (error) { if (isMissingCollection(error)) return { markedCount: 0 }; throw error; }
  }

  function assertReviewable(row, event, timestamp = now()) {
    if (!row || row.kind !== 'request') throw backfillError('NOT_FOUND', '补录申请不存在');
    if (row.updatedAt !== event.expectedUpdatedAt || row.status !== 'pending') {
      throw backfillError('CONFLICT', '申请已被审批，请刷新后查看最新结果');
    }
    if (row.ruleVersion === 2) {
      if (!isTimestamp(row.createdAt)) throw backfillError('INVALID_ARGUMENT', '申请提交时间无效，请核对申请');
      // The submitted range is fixed: waiting for review does not move its
      // earliest permitted date or start its 72-hour recording window.
      return assertSubmissionWindow(row.startDate, row.endDate, Date.parse(row.createdAt));
    }
    return assertLegacyOpenWindow(row.startDate, row.endDate, timestamp);
  }

  async function review(openid, event) {
    requireIdentity(openid);
    if (!isRequestId(event.requestId) || !['approved', 'rejected'].includes(event.status) || !isTimestamp(event.expectedUpdatedAt)) {
      throw backfillError('INVALID_ARGUMENT', '审批参数无效，请刷新后重试');
    }
    const reply = textValue(event.reply, 500, event.status === 'rejected' ? '未通过原因' : '审批说明', event.status === 'approved');
    let before;
    try { before = await optionalRequest(db, event.requestId); }
    catch (error) { if (!isMissingCollection(error)) throw error; }
    assertReviewable(before, event);
    await moderate(cloud, openid, reply);
    return db.runTransaction(async transaction => {
      const current = await optionalRequest(transaction, event.requestId);
      assertReviewable(current, event);
      const locked = await lockedRequest(transaction, current.ownerOpenid), timestamp = now();
      assertReviewable(current, event, timestamp);
      if (event.status === 'approved' && locked.active && locked.active._id !== current._id && isActive(locked.active, timestamp)) {
        throw backfillError('ACTIVE_REQUEST_EXISTS', '该同学已有其他有效的补录申请，请刷新后核对');
      }
      // Millisecond-monotonic revisions keep competing approvals distinguishable.
      const iso = new Date(Math.max(timestamp, Date.parse(current.updatedAt) + 1)).toISOString();
      const deadline = current.ruleVersion === 2
        ? (event.status === 'approved' ? new Date(timestamp + 3 * DAY).toISOString() : null)
        : legacyExpiresAt(current);
      const changes = { status: event.status, reply, updatedAt: iso, handledBy: openid,
        handledAt: new Date(timestamp).toISOString(), unreadForUser: true, expiresAt: deadline };
      await transaction.collection(COLLECTION).doc(event.requestId).update({ data: changes });
      if (event.status === 'approved' || !locked.lock || locked.lock.activeRequestId === current._id) {
        await transaction.collection(COLLECTION).doc(locked.lockId).set({ data: { kind: 'lock', ownerOpenid: current.ownerOpenid,
          activeRequestId: event.status === 'approved' ? current._id : '', updatedAt: iso } });
      }
      return { request: publicRequest({ ...current, ...changes }, true, timestamp) };
    });
  }
  return { submit, list, alert, markRead, review };
}

async function handleBackfill(event, dependencies, admin = false) {
  try {
    const service = createBackfillService(dependencies), openid = dependencies.openid;
    let data;
    if (!admin && event.type === 'submitBackfillRequest') data = await service.submit(openid, event);
    else if (!admin && event.type === 'getMyBackfillRequests') data = await service.list(openid, event);
    else if (!admin && event.type === 'getBackfillAlert') data = await service.alert(openid);
    else if (!admin && event.type === 'markBackfillRead') data = await service.markRead(openid, event);
    else if (admin && event.type === 'adminListBackfillRequests') data = await service.list(openid, event, true);
    else if (admin && event.type === 'adminReviewBackfillRequest') data = await service.review(openid, event);
    else if (admin && event.type === 'adminGetBackfillAlert') data = await service.alert(openid, true);
    else throw backfillError('INVALID_ARGUMENT', '未知的补录申请操作');
    return { success: true, data };
  } catch (error) {
    if (KNOWN_ERRORS.has(error && error.code)) return { success: false, code: error.code, error: error.message };
    return { success: false, code: 'BACKFILL_UNAVAILABLE', error: '补录申请服务暂时不可用，请稍后重试' };
  }
}

module.exports = { handleBackfill, assertBackfillGrant };
