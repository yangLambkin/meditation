const dateUtil = require('./dateUtil');
const { isValidDateKey } = require('./homeCheckin');
const DAY = 24 * 60 * 60 * 1000;

function buildHeatmap(records = [], year = Number(dateUtil.getBusinessDate().slice(0, 4)), today = dateUtil.getBusinessDate()) {
  const durations = new Map();
  for (const record of records) {
    if (!record || !isValidDateKey(record.date) || !Number.isFinite(Number(record.duration)) || Number(record.duration) <= 0) continue;
    durations.set(record.date, (durations.get(record.date) || 0) + Number(record.duration));
  }
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const weeks = [];
  let totalDuration = 0;
  let totalDays = 0;
  for (let cursor = start - offset * DAY; cursor < end; cursor += 7 * DAY) {
    const days = [];
    let monthLabel = '';
    for (let weekday = 0; weekday < 7; weekday++) {
      const timestamp = cursor + weekday * DAY;
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const inYear = timestamp >= start && timestamp < end;
      const duration = inYear ? durations.get(date) || 0 : 0;
      if (duration) { totalDuration += duration; totalDays++; }
      if (inYear && date.endsWith('-01')) monthLabel = `${Number(date.slice(5, 7))}月`;
      days.push({ date, duration, empty: !inYear, future: date > today,
        level: duration >= 60 ? 3 : duration >= 20 ? 2 : duration > 0 ? 1 : 0 });
    }
    weeks.push({ id: cursor, monthLabel, days });
  }
  return { year, weeks, totalDuration, totalDays };
}

function buildYearlyHeatmaps(records = [], today = dateUtil.getBusinessDate()) {
  const currentYear = Number(today.slice(0, 4));
  const heatmaps = [];
  for (let year = currentYear; year >= 2025; year--) {
    heatmaps.push(buildHeatmap(records, year, today));
  }
  return heatmaps;
}

module.exports = { buildHeatmap, buildYearlyHeatmaps };
