const USER_PAGE_SIZE = 50;
const RECORD_PAGE_SIZE = 100;
const USER_FIELDS = { _id: true, _openid: true, nickName: true, bijingBound: true, bijingStudentNumber: true };
const RECORD_FIELDS = {
  _id: true, date: true, timestamp: true, duration: true,
  source: true, dateSource: true, localId: true, idempotencyKey: true
};

function queryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function validOpenid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateQuery(event) {
  if (event.type === 'adminSearchUsers') {
    const nickname = typeof event.nickname === 'string' ? event.nickname.trim() : '';
    if (!nickname || nickname.length > 100) throw queryError('INVALID_ARGUMENT', '请输入 1–100 个字符的昵称');
    const cursor = event.cursor === undefined || event.cursor === null ? '' : event.cursor;
    if (typeof cursor !== 'string' || cursor.length > 256 || cursor !== cursor.trim()) {
      throw queryError('INVALID_ARGUMENT', '查询游标无效，请重新查询');
    }
    return { nickname, cursor };
  }
  if (!validOpenid(event.openid)) throw queryError('INVALID_ARGUMENT', '请选择有效的用户');
  if (!validDate(event.recordDate)) throw queryError('INVALID_ARGUMENT', '请选择有效的查询日期');
  return { openid: event.openid, recordDate: event.recordDate };
}

function publicUser(user) {
  return {
    openid: user._openid,
    nickname: typeof user.nickName === 'string' && user.nickName.trim() ? user.nickName.trim() : '匿名用户',
    studentNumber: user.bijingBound === true && typeof user.bijingStudentNumber === 'string' ? user.bijingStudentNumber.trim() : ''
  };
}

function pageRows(result) {
  if (!result || !Array.isArray(result.data)) throw new Error('Invalid database response');
  return result.data;
}

async function searchUsers(db, { nickname, cursor }) {
  const users = [];
  const identities = new Set();
  for (;;) {
    const rows = pageRows(await db.collection('users')
      .where({ nickName: nickname, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
      .field(USER_FIELDS).orderBy('_id', 'asc').limit(USER_PAGE_SIZE).get());
    for (let index = 0; index < rows.length; index++) {
      const user = rows[index];
      if (!validOpenid(user._openid) || identities.has(user._openid)) continue;
      identities.add(user._openid);
      users.push(publicUser(user));
      if (users.length === USER_PAGE_SIZE) {
        // 一页只返回有效且不同的账号；停在最后已返回候选处，不越过同批未展示用户。
        const hasMore = index < rows.length - 1 || rows.length === USER_PAGE_SIZE;
        return { users, nextCursor: hasMore ? nextPageCursor([user], cursor) : null };
      }
    }
    if (rows.length < USER_PAGE_SIZE) return { users, nextCursor: null };
    // 重复资料或缺少身份的旧文档不能造成“未找到用户”的假空页。
    cursor = nextPageCursor(rows, cursor);
  }
}

// 与静坐记录及必经同步一致：数字、数字字符串及明确带时区的 ISO 时间均可读取。
function recordTimestamp(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
}

function nextPageCursor(rows, cursor) {
  const next = rows[rows.length - 1]._id;
  if (typeof next !== 'string' || !next || next <= cursor) throw new Error('Invalid database pagination');
  return next;
}

function databaseErrorText(error) {
  return typeof error === 'string' ? error : [error && error.code, error && error.errCode,
    error && error.message, error && error.errMsg].filter(value => value !== undefined).join(' ');
}

function isMissingCollection(error) {
  const codes = [error && error.code, error && error.errCode].map(String);
  return codes.includes('-502005') || /\b(?:DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)\b/i.test(databaseErrorText(error)) ||
    /\bcollection\b(?:\s+["'`]?[\w.-]+["'`]?)?\s+(?:(?:does|is)\s+)?(?:not exists?|not found)\b|集合\s*(?:["'`]?[\w.-]+["'`]?)?\s*不存在/i.test(databaseErrorText(error));
}

async function readRecordRevision(db, lockId) {
  try {
    const rows = pageRows(await db.collection('meditation_locks').where({ _id: lockId })
      .field({ _id: true, revision: true }).limit(1).get());
    return rows.length ? Number(rows[0].revision) || 0 : 0;
  } catch (error) {
    // 旧环境尚未创建集合时仍可只读查询；权限、网络等错误不能当作无锁继续。
    if (isMissingCollection(error)) return null;
    if (/\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(databaseErrorText(error))) return 0;
    throw error;
  }
}

async function scanDayRecords(db, { openid, recordDate }) {
  const start = Date.parse(`${recordDate}T02:00:00+08:00`);
  const end = start + 24 * 60 * 60 * 1000;
  const records = [];
  const identities = new Set();
  const documentIds = new Set();
  let cursor = '';
  let totalDuration = 0;
  let durationCorrection = 0;
  for (;;) {
    // 旧数据的 date 可能是自然日，timestamp 也可能是字符串。按用户完整分页后归属，
    // 避免按 date 或数值时间范围查询漏掉凌晨记录；游标避免增删导致 skip 位移。
    const rows = pageRows(await db.collection('meditation_records')
      .where({ _openid: openid, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
      .field(RECORD_FIELDS).orderBy('_id', 'asc').limit(RECORD_PAGE_SIZE).get());
    for (const record of rows) {
      const keys = [record.localId, record.idempotencyKey].filter(key => typeof key === 'string' && key);
      const duplicate = documentIds.has(record._id) || keys.some(key => identities.has(key));
      documentIds.add(record._id);
      keys.forEach(key => identities.add(key));
      if (duplicate) continue;
      const timestamp = recordTimestamp(record.timestamp);
      const isManual = record.source === 'manual' || record.dateSource === 'manual';
      const useStoredDate = isManual && validDate(record.date);
      if (useStoredDate ? record.date !== recordDate : timestamp !== null ? timestamp < start || timestamp >= end : record.date !== recordDate) continue;
      const rawDuration = typeof record.duration === 'number' || typeof record.duration === 'string' && record.duration.trim() ? Number(record.duration) : NaN;
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
      records.push({
        _id: record._id, date: recordDate, timestamp, duration,
        source: isManual ? 'manual' : record.source === 'timer' ? 'timer' : 'unknown'
      });
      const corrected = duration - durationCorrection;
      const next = totalDuration + corrected;
      durationCorrection = (next - totalDuration) - corrected;
      totalDuration = next;
    }
    if (rows.length < RECORD_PAGE_SIZE) break;
    cursor = nextPageCursor(rows, cursor);
  }
  if (!Number.isFinite(totalDuration)) throw new Error('Invalid stored duration');
  records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || String(a._id).localeCompare(String(b._id)));
  return { records, totalCount: records.length, totalDuration };
}

async function getDayRecords(db, { openid, recordDate }) {
  const users = pageRows(await db.collection('users').where({ _openid: openid })
    .field(USER_FIELDS).orderBy('_id', 'asc').limit(1).get());
  if (!users.length) throw queryError('USER_NOT_FOUND', '该用户不存在或资料已移除，请重新查询');
  const user = publicUser(users[0]);
  const lockId = 'lock_' + require('crypto').createHash('sha256').update(JSON.stringify([openid, 'records'])).digest('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readRecordRevision(db, lockId);
    const day = await scanDayRecords(db, { openid, recordDate });
    // 游标能避免分页位移，但只有 revision 不变才可接受整轮记录和汇总。
    if (before === await readRecordRevision(db, lockId)) return { user, recordDate, ...day };
  }
  throw queryError('RETRY_REQUIRED', '记录正在更新，请稍后重新查询');
}

async function handleRecordQuery(event, getDatabase) {
  try {
    // 参数错误无需触碰数据库，也不把 SDK 查询运算符对象当成昵称或身份接收。
    const query = validateQuery(event);
    const db = getDatabase();
    const data = event.type === 'adminSearchUsers' ? await searchUsers(db, query) : await getDayRecords(db, query);
    return { success: true, data };
  } catch (error) {
    if (['INVALID_ARGUMENT', 'USER_NOT_FOUND', 'RETRY_REQUIRED'].includes(error && error.code)) return { success: false, code: error.code, error: error.message };
    return { success: false, code: 'QUERY_FAILED', error: '记录查询暂时不可用，请稍后重试' };
  }
}

module.exports = { handleRecordQuery };
