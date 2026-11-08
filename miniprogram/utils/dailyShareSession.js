// Only the information deliberately shown on a shared card travels in its URL.
// Account IDs, avatars, reflections and cumulative statistics stay on the device.
function cleanName(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return Array.from(text || '静心者').slice(0, 20).join('');
}

function createSession(name, endedAt, minutes) {
  if (!['string', 'number'].includes(typeof endedAt) || !['string', 'number'].includes(typeof minutes)) return null;
  const timestamp = Number(endedAt);
  const duration = Number(minutes);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 253402271999999 ||
      !Number.isInteger(duration) || duration < 1 || duration > 1440) return null;
  // The record timestamp is the actual end of the sitting. Do not infer a start
  // time by subtracting minutes, since pauses are excluded from its duration.
  const date = new Date(timestamp + 8 * 3600000);
  const dateLabel = date.toISOString().slice(0, 10).replace(/-/g, '.');
  const timeLabel = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return { name: cleanName(name), minutes: duration, endedAt: timestamp, dateLabel, timeLabel };
}

function readName(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('n1:')) return value.slice(3);
  if (/^n1%3a/i.test(value)) {
    try { return decodeURIComponent(value).slice(3); } catch (_) { return ''; }
  }
  return '';
}

function readSession(options) {
  return createSession(readName(options.name), options.at, options.minutes);
}

function sessionQuery(session) {
  if (!session) return '';
  return `&name=${encodeURIComponent(`n1:${session.name}`)}&at=${session.endedAt}&minutes=${session.minutes}`;
}

function shareTitle(session) {
  // WeChat controls the native title's font size; keep it brief and leave the
  // completion date and time on the cover.
  return session
    ? `${session.name} · 静坐${session.minutes}分钟`
    : '送你一张静心卡';
}

module.exports = { createSession, readSession, sessionQuery, shareTitle };
