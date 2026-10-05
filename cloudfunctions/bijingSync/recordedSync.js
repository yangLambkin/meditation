const { syncDayWithLease } = require('./backfillSync');

function isDateLabel(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function businessDate(timestamp) {
  return new Date(timestamp + 6 * 3600000).toISOString().slice(0, 10);
}

function recordTimestamp(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}

// Match the day used by meditationManager and bijingSync.getDayRecords: a
// manual date is authoritative, timed records follow the Beijing 02:00 day,
// and legacy records without a valid timestamp retain their stored date.
function recordedDate(record, getBusinessDate) {
  if ((record.source === 'manual' || record.dateSource === 'manual') && isDateLabel(record.date)) return record.date;
  const timestamp = recordTimestamp(record.timestamp);
  return Number.isFinite(timestamp) ? getBusinessDate(timestamp) : record.date;
}

async function readRecord(db, recordId) {
  try {
    const response = await db.collection('meditation_records').doc(recordId).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('Invalid record response');
    if (response.data === null || response.data === undefined) return null;
    if (typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('Invalid record document');
    return response.data;
  } catch (error) {
    const text = [error && error.code, error && error.errCode, error && error.message, error && error.errMsg].join(' ');
    const missingCollection = [error && error.code, error && error.errCode].map(String).includes('-502005') ||
      /COLLECTION_NOT_EXIST|COLLECTION_NOT_EXISTS|\bcollection\b[^\n]*(?:not exist|not found)|集合[^\n]*不存在/i.test(text);
    if (!missingCollection && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(text)) return null;
    throw error;
  }
}

// A saved owned record is the authority. Client dates, sources and retreat
// claims never authorize an arbitrary historical date or another account.
async function syncRecordedDate({ db, openid, recordId, expectedOpenid, syncDate,
  getDayDuration, getBusinessDate = businessDate, now = Date.now, logger = console }) {
  if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)) {
    return { success: false, code: 'AUTH_REQUIRED', error: '请先登录' };
  }
  if (expectedOpenid !== undefined && expectedOpenid !== openid) {
    return { success: false, code: 'ACCOUNT_CHANGED', error: '登录账号已变化，请切换回保存记录的账号后重试' };
  }
  if (typeof recordId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(recordId)) {
    return { success: false, code: 'INVALID_ARGUMENT', error: '请选择已保存的静坐记录后重试' };
  }
  try {
    const record = await readRecord(db, recordId);
    if (!record || record._openid !== openid) {
      return { success: false, code: 'RECORD_NOT_FOUND', error: '记录不存在、已删除或不属于当前账号，请刷新后查看' };
    }
    const date = recordedDate(record, getBusinessDate), today = getBusinessDate(now());
    if (!isDateLabel(date) || date > today) {
      return { success: false, code: 'INVALID_RECORD_DATE', error: '已保存记录的练习日期无效，暂时无法同步' };
    }
    if (date === today) {
      return { success: true, data: { date, skipped: true, deferred: true, reason: '该日尚未结束，次日凌晨 2 点后同步' } };
    }
    return syncDayWithLease({ db, openid, recordDate: date, syncDate, getDayDuration, now, logger });
  } catch (error) {
    return { success: false, code: 'RECORD_SYNC_FAILED', error: '记录已保存，同步暂未完成，请稍后重试' };
  }
}

module.exports = { syncRecordedDate };
