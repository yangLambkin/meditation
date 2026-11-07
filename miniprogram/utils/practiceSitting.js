const checkinManager = require('./checkin.js');
const dateUtil = require('./dateUtil.js');

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// 功课 ID 与原云记录 ID 属于不同系统；只有明确的来源字段可以定位原静坐。
function sourceId(record) {
  if (!record || record.type && record.type !== 'sitting') return '';
  const source = record.source;
  const metadata = source && typeof source === 'object' ? source : {};
  const systems = [typeof source === 'string' ? source : '', metadata.system, metadata.sourceSystem]
    .filter(value => value !== undefined && value !== null && value !== '');
  if (systems.some(value => value !== 'meditation')) return '';
  const ids = [record.sourceRecordId, metadata.sourceRecordId, metadata.recordId]
    .filter(value => value !== undefined && value !== null && value !== '');
  if (!ids.length || ids.some(value => typeof value !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) || value !== ids[0])) return '';
  // 顶层 sourceRecordId 是现有 feed 的 meditation 专用字段；嵌套字段还需来源声明。
  return record.sourceRecordId || systems.includes('meditation') ? ids[0] : '';
}

function identity(record = {}) {
  return { recordId: record._id, localId: record.localId, timestamp: record.timestamp };
}

async function resolve(record, stillCurrent = () => true) {
  const id = sourceId(record);
  if (!id) throw failure('SOURCE_ID_UNAVAILABLE', '尚未取得原静坐记录标识，请刷新后重试');
  const account = wx.getStorageSync('userOpenId') || '';
  const userId = checkinManager.getUserId();
  if (!account) throw failure('AUTH_REQUIRED', '请登录后管理原静坐记录');
  const assertCurrent = () => {
    if (account !== (wx.getStorageSync('userOpenId') || '') || userId !== checkinManager.getUserId()) {
      throw failure('ACCOUNT_CHANGED', '账号已变化，请重新打开记录');
    }
    if (!stillCurrent()) throw failure('ACTION_STALE', '记录操作已变化，请重新打开记录');
  };
  const find = () => {
    assertCurrent();
    const stored = checkinManager.getUserCheckinData();
    const data = stored.checkinRecords || stored;
    const matches = Object.entries(data.dailyRecords || {}).flatMap(([date, day]) =>
      (Array.isArray(day.records) ? day.records : []).filter(item => item && item._id === id)
        .map(raw => ({ date, raw })));
    assertCurrent();
    if (matches.length > 1) throw failure('SOURCE_AMBIGUOUS', '原静坐记录标识不唯一，请刷新后重试');
    if (!matches.length) return null;
    const { date, raw } = matches[0];
    if (raw._openid && raw._openid !== account || raw.syncOpenid && raw.syncOpenid !== account) {
      throw failure('SOURCE_OWNER_MISMATCH', '请切换回保存该静坐记录时的账号后重试');
    }
    return { ...raw, date, dayDate: dateUtil.getRecordBusinessDate(raw, date),
      isBackfill: raw.recordType === 'backfill' || !!raw.backfillRequestId };
  };
  const cached = find();
  if (cached) return cached;
  const refreshed = await checkinManager.refreshFromCloud();
  assertCurrent();
  const latest = find();
  if (latest) return latest;
  throw refreshed
    ? failure('SOURCE_NOT_FOUND', '原静坐记录不存在，请刷新后重试')
    : failure('SOURCE_READ_UNAVAILABLE', '原静坐记录读取失败，请稍后重试');
}

module.exports = { sourceId, resolve, identity };
