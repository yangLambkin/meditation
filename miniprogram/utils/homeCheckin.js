const dateUtil = require('./dateUtil.js');

function getDateTime(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const hours = String(utc8.getUTCHours()).padStart(2, '0');
  const minutes = String(utc8.getUTCMinutes()).padStart(2, '0');
  return { date: dateUtil.getBusinessDate(date), time: `${hours}:${minutes}` };
}

function parseDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return NaN;
  }
  const timestamp = new Date(`${date}T${time}:00+08:00`).getTime();
  return Number.isFinite(timestamp) && dateUtil.getBusinessDate(timestamp) === date ? timestamp : NaN;
}

// 将同一用户各日期下的明细合并，兼容体验对象和旧版体验 ID。
function buildCheckinRecords(userData, experienceRecords = []) {
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
      const timestamp = Number(record.timestamp);
      const hasTime = Number.isFinite(timestamp) && timestamp > 0;
      const experiences = Array.isArray(record.experience) ? record.experience : [record.experience];
      const experienceTexts = experiences.map(experience => {
        if (experience && typeof experience === 'object') return experience.text || '';
        return experienceMap.get(String(experience)) || '';
      }).filter(Boolean);
      records.push({
        id: `${date}-${record._id || `${record.timestamp || 'record'}-${index}`}`,
        date,
        time: hasTime ? getDateTime(timestamp).time : '时间未记录',
        timestamp: hasTime ? timestamp : 0,
        duration: Number(record.duration) || 0,
        emotion: Array.isArray(record.emotion) ? record.emotion : [],
        experienceTexts,
        order: index
      });
    });
  });
  return records.sort((a, b) => b.date.localeCompare(a.date) || b.timestamp - a.timestamp || b.order - a.order);
}

module.exports = { getDateTime, parseDateTime, buildCheckinRecords };
