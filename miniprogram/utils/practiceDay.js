const dates = require('./dateUtil.js');

// 功课只在读取、展示和统计时按北京时间 02:00 分日；写入仍用真实发生日期。
function getRecordDisplayDate(record) {
  if (dates.isDateLabel(record.displayDate)) return record.displayDate;
  const occurredAt = typeof record.occurredAt === 'string' ? record.occurredAt.replace(' ', 'T') : '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(occurredAt)) {
    const timestamp = Date.parse(`${occurredAt}+08:00`);
    if (Number.isFinite(timestamp)) return dates.getBusinessDate(timestamp);
  }
  // 旧记录没有发生时间时保留原日期，不猜测为零点。
  return record.recordDate;
}

module.exports = {
  getPracticeDate: dates.getBusinessDate,
  getRecordDisplayDate,
  watchPracticeDate: dates.watchBusinessDate
};
