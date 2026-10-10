const { syncDayWithLease } = require('./backfillSync');

function isDateLabel(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function businessDate(timestamp) {
  return new Date(timestamp + 6 * 3600000).toISOString().slice(0, 10);
}

async function readReceipt(db, deletionId) {
  try {
    const response = await db.collection('meditation_locks').doc(deletionId).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('Invalid deletion receipt response');
    if (response.data === null || response.data === undefined) return null;
    if (typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('Invalid deletion receipt');
    return response.data;
  } catch (error) {
    const text = [error && error.code, error && error.errCode, error && error.message, error && error.errMsg].join(' ');
    const missingCollection = [error && error.code, error && error.errCode].map(String).includes('-502005') ||
      /COLLECTION_NOT_EXIST|COLLECTION_NOT_EXISTS|\bcollection\b[^\n]*(?:not exist|not found)|集合[^\n]*不存在/i.test(text);
    if (!missingCollection && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(text)) return null;
    throw error;
  }
}

// 日期仅来自与删除共同提交的本人凭据。客户端日期、时长、已不存在的记录都不能授权清零。
async function syncDeletedDate({ db, openid, deletionId, expectedOpenid, syncDate,
  getDayDuration, getBusinessDate = businessDate, now = Date.now, logger = console }) {
  if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)) {
    return { success: false, code: 'AUTH_REQUIRED', error: '请先登录' };
  }
  if (expectedOpenid !== undefined && expectedOpenid !== openid) {
    return { success: false, code: 'ACCOUNT_CHANGED', error: '登录账号已变化，请切换回删除记录的账号后重试' };
  }
  if (typeof deletionId !== 'string' || !/^md_[a-f0-9]{64}$/.test(deletionId)) {
    return { success: false, code: 'INVALID_ARGUMENT', error: '缺少有效的删除凭据，请重试删除记录' };
  }
  try {
    const receipt = await readReceipt(db, deletionId);
    if (!receipt || receipt.kind !== 'deletion_receipt' || receipt.ownerOpenid !== openid) {
      return { success: false, code: 'DELETION_NOT_FOUND', error: '删除凭据不存在或不属于当前账号，请刷新后重试' };
    }
    const date = receipt.date, today = getBusinessDate(now());
    if (!isDateLabel(date) || date > today) {
      return { success: false, code: 'INVALID_RECORD_DATE', error: '删除记录的练习日期无效，暂时无法同步' };
    }
    if (date === today) {
      return { success: true, data: { date, skipped: true, deferred: true, reason: '该日尚未结束，次日凌晨 2 点后同步' } };
    }
    // 与新增记录、获批补录共享同一日租约；每次从云端重算总量并允许发送零。
    const result = await syncDayWithLease({ db, openid, recordDate: date, syncDate, getDayDuration, now, logger });
    if (result && result.success === false && result.error === '记录已保存，同步暂未完成，请稍后重试') {
      return { ...result, error: '记录已删除，同步暂未完成，请稍后重试' };
    }
    return result;
  } catch (error) {
    return { success: false, code: 'DELETION_SYNC_FAILED', error: '记录已删除，同步暂未完成，请稍后重试' };
  }
}

module.exports = { syncDeletedDate };
