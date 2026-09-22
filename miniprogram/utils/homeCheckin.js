const dateUtil = require('./dateUtil.js');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const numericTimestamp = Number(value);
  const timestamp = Number.isFinite(numericTimestamp) ? numericTimestamp : Date.parse(value);
  return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}

// 所有静坐记录统一以北京时间 02:00 分日。
function getCheckinDay(timestamp = Date.now()) {
  const value = parseTimestamp(timestamp);
  return Number.isFinite(value) ? dateUtil.getBusinessDate(value) : '';
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 用 UTC 日历分量切换日期/月，避免手机时区和夏令时影响选择结果。
function shiftCheckinDate(value, offsetDays) {
  if (!isValidDateKey(value) || !Number.isInteger(offsetDays)) return '';
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  if (!Number.isFinite(date.getTime())) return '';
  const shifted = date.toISOString().slice(0, 10);
  return isValidDateKey(shifted) ? shifted : '';
}

function shiftCheckinMonth(value, offsetMonths) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value) ||
      !isValidDateKey(`${value}-01`) || !Number.isInteger(offsetMonths)) return '';
  const date = new Date(`${value}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offsetMonths);
  if (!Number.isFinite(date.getTime())) return '';
  const shifted = date.toISOString().slice(0, 10);
  return isValidDateKey(shifted) ? shifted.slice(0, 7) : '';
}

function compareCheckinRecords(a, b) {
  const dateA = a.dayDate || a.date;
  const dateB = b.dayDate || b.date;
  return dateB.localeCompare(dateA) || (b.sortTimestamp || 0) - (a.sortTimestamp || 0) || (b.order || 0) - (a.order || 0);
}

function getDateTime(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const hours = String(utc8.getUTCHours()).padStart(2, '0');
  const minutes = String(utc8.getUTCMinutes()).padStart(2, '0');
  return { date: utc8.toISOString().slice(0, 10), time: `${hours}:${minutes}` };
}

function parseDateTime(date, time) {
  if (!isValidDateKey(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return NaN;
  }
  // 业务日中的 00:00–01:59 是次日凌晨。
  const calendarDate = time < '02:00' ? shiftCheckinDate(date, 1) : date;
  const timestamp = new Date(`${calendarDate}T${time}:00+08:00`).getTime();
  return Number.isFinite(timestamp) && dateUtil.getBusinessDate(timestamp) === date ? timestamp : NaN;
}

function getRecordSyncState(record) {
  if (record._id) return {};
  if (record.syncIgnored === true) {
    return { syncStatus: 'ignored', syncStatusText: '已存本机，已忽略上传' };
  }
  // 旧本机记录在首页统一预览后确认，不因展示列表就加上新版上传标记。
  if (record.syncVersion !== 1) {
    return { syncStatus: 'unconfirmed', syncStatusText: '本机记录，未确认上传' };
  }
  if (record.syncErrorCode === 'DATE_OUT_OF_RANGE') {
    return { syncStatus: 'blocked', syncStatusText: '已存本机，已超出补录期限，无法上传' };
  }
  if (record.syncErrorCode === 'AMBIGUOUS_RECORD') {
    return { syncStatus: 'blocked', syncStatusText: '已存本机，云端有相似记录，请核对' };
  }
  if (record.syncBlocked) {
    return { syncStatus: 'blocked', syncStatusText: '已存本机，记录无法上传，请核对记录' };
  }
  return {
    syncStatus: record.syncStatus || 'pending',
    syncStatusText: record.syncStatus === 'uploading' ? '正在上传'
      : record.syncStatus === 'failed' ? '上传失败，已存本机，请手动上传' : '已存本机，待上传'
  };
}

// 将同一用户各日期下的明细合并，兼容体验对象和旧版体验 ID。
function buildCheckinRecords(userData, experienceRecords = [], { openid } = {}) {
  const experienceMap = new Map();
  experienceRecords.forEach(record => {
    if (!record || !record.text) return;
    [record._id, record.uniqueId, record.timestamp].forEach(id => {
      if (id !== undefined && id !== null) experienceMap.set(String(id), record.text);
    });
  });

  const records = [];
  const dailyRecords = userData.dailyRecords || {};
  Object.keys(dailyRecords).forEach(date => {
    const day = dailyRecords[date] || {};
    (Array.isArray(day.records) ? day.records : []).forEach((record, index) => {
      if (!record) return;
      if (openid && ((record.syncOpenid && record.syncOpenid !== openid) ||
          (record._openid && record._openid !== openid))) return;
      const timestamp = dateUtil.getRecordTimestamp(record.timestamp);
      const hasTime = Number.isFinite(timestamp) && timestamp > 0;
      const dateTime = hasTime ? getDateTime(timestamp) : null;
      const dayDate = dateUtil.getRecordBusinessDate(record, date);
      const time = hasTime ? dateTime.time : '时间未记录';
      const experiences = Array.isArray(record.experience) ? record.experience : [record.experience];
      const experienceTexts = experiences.map(experience => {
        if (experience && typeof experience === 'object') return experience.text || '';
        return experienceMap.get(String(experience)) || '';
      }).filter(Boolean);
      records.push({
        id: `${date}-${record._id || record.localId || `${record.timestamp || 'record'}-${index}`}`,
        _id: record._id || null,
        localId: record.localId || null,
        date,
        dayDate,
        time,
        timeLabel: hasTime && dateTime.date > dayDate ? `次日 ${time}` : time,
        timestamp: record.timestamp == null ? null : record.timestamp,
        sortTimestamp: hasTime ? timestamp : 0,
        duration: Number(record.duration) || 0,
        emotion: Array.isArray(record.emotion) ? record.emotion : [],
        experienceTexts,
        ...getRecordSyncState(record),
        ...(record.syncError ? { syncError: record.syncError } : {}),
        ...(record.syncErrorCode ? { syncErrorCode: record.syncErrorCode } : {}),
        order: index
      });
    });
  });
  return records.sort(compareCheckinRecords);
}

function buildCheckinGroups(records, { now = Date.now(), showAll = false } = {}) {
  const today = getCheckinDay(now);
  const firstDate = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * DAY).toISOString().slice(0, 10);
  const groups = [];
  let hiddenCount = 0;
  records.slice().sort(compareCheckinRecords).forEach(record => {
    const date = record.dayDate || record.date;
    if (!showAll && (date < firstDate || date > today)) {
      hiddenCount++;
      return;
    }
    let group = groups[groups.length - 1];
    if (!group || group.date !== date) {
      group = { date, records: [], count: 0, totalDuration: 0 };
      groups.push(group);
    }
    group.records.push(record);
    group.count++;
    group.totalDuration += Number(record.duration) || 0;
  });
  return { groups, hiddenCount };
}

// 首页与完整历史共用同一套体验文本读取逻辑，兼容两种本地缓存格式。
function readCheckinRecords(checkinManager, legacyRecords = [], options = {}) {
  const userData = checkinManager.getUserCheckinData();
  const experienceIds = new Set();
  Object.keys(userData.dailyRecords || {}).forEach(date => {
    const day = userData.dailyRecords[date] || {};
    (Array.isArray(day.records) ? day.records : []).forEach(record => {
      if (!record) return;
      const experiences = Array.isArray(record.experience) ? record.experience : [record.experience];
      experiences.forEach(experience => {
        if (typeof experience === 'string' && experience) experienceIds.add(experience);
      });
    });
  });
  const experiences = (Array.isArray(legacyRecords) ? legacyRecords : []).concat(
    experienceIds.size ? checkinManager.getExperienceRecordsFromLocal(Array.from(experienceIds)) : []
  );
  return buildCheckinRecords(userData, experiences, options);
}

function buildCheckinMonths(records) {
  const { groups } = buildCheckinGroups(records, { showAll: true });
  const months = [];
  groups.forEach(day => {
    // 月份遵循 02:00 分日结果，如 10 月 1 日 01:00 仍属于 9 月。
    const month = day.date.slice(0, 7);
    let group = months[months.length - 1];
    if (!group || group.month !== month) {
      const [year, monthNumber] = month.split('-');
      group = { month, label: `${year}年${Number(monthNumber)}月`, count: 0, totalDuration: 0, days: [] };
      months.push(group);
    }
    group.days.push(day);
    group.count += day.count;
    group.totalDuration += day.totalDuration;
  });
  return months;
}

module.exports = {
  getDateTime, parseDateTime, getCheckinDay, buildCheckinRecords, buildCheckinGroups,
  readCheckinRecords, buildCheckinMonths, isValidDateKey, shiftCheckinDate, shiftCheckinMonth
};
