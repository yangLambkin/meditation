// 全应用业务日：北京时间每日 02:00（含）至次日 02:00（不含）。
// UTC+8 再减去两小时，使用 UTC 分量，避免手机/云函数所在时区影响。
const DAY_MS = 86400000;
function dateLabel(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
function getBusinessDate(date) {
  return dateLabel(new Date(date === undefined ? Date.now() : date).getTime() + 6 * 3600000);
}
function getBusinessMonth(date) { return getBusinessDate(date).slice(0, 7); }
function getCalendarDate(date) {
  return dateLabel(new Date(date === undefined ? Date.now() : date).getTime() + 8 * 3600000);
}
function isDateLabel(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && dateLabel(Date.parse(`${date}T00:00:00Z`)) === date;
}
function addBusinessDays(date, days) {
  if (!isDateLabel(date) || !Number.isInteger(days)) throw new Error('业务日期无效');
  return dateLabel(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}
function getBusinessDateWindow(date) {
  if (!isDateLabel(date)) throw new Error('业务日期无效');
  const start = Date.parse(`${date}T02:00:00+08:00`);
  return { start, end: start + DAY_MS };
}
// 没有时区的旧字符串不能按设备时区猜测，保留记录原有日期。
function getRecordTimestamp(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}
function getRecordBusinessDate(record, fallbackDate) {
  // 手动选择的是业务日期，不能因为补录/上传时刻重新归属。
  if ((record.source === 'manual' || record.dateSource === 'manual') && isDateLabel(record.date || fallbackDate)) {
    return record.date || fallbackDate;
  }
  const timestamp = getRecordTimestamp(record.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? getBusinessDate(timestamp) : record.date || fallbackDate;
}
function isRecentBusinessDate(date, now) {
  const today = getBusinessDate(now);
  return isDateLabel(date) && date >= addBusinessDays(today, -2) && date <= today;
}
// 页面显示时订阅，在北京时间 02:00 精确刷新；隐藏/卸载时调用返回的 stop。
function watchBusinessDate(onChange) {
  let day = getBusinessDate();
  let stopped = false;
  let timer;
  function schedule() {
    const now = Date.now();
    timer = setTimeout(() => {
      if (stopped) return;
      const nextDay = getBusinessDate();
      const previousDay = day;
      day = nextDay;
      schedule();
      if (nextDay !== previousDay) onChange(nextDay, previousDay);
    }, Math.max(1, getBusinessDateWindow(getBusinessDate(now)).end - now));
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
module.exports = { DAY_MS, getBusinessDate, getBusinessMonth, getCalendarDate, isDateLabel,
  addBusinessDays, getBusinessDateWindow, getRecordTimestamp, getRecordBusinessDate, isRecentBusinessDate, watchBusinessDate };
