const WIDTH = 500;
const HEIGHT = 400;
const SCALE = 2;
const TIMEOUT_MS = 2000;
const DEFAULT_QUOTE = '静心即是修心，心安即是归处。';
const COLORS = {
  paper: '#f7f5ef', white: '#ffffff', ink: '#343c37',
  gold: '#8f7648', muted: '#697364', quote: '#566252', line: '#eae4d8', halo: '#f1ece2'
};

function coverError(stage, cause) {
  const error = new Error(stage === 'cancelled' ? '页面已关闭' : '分享封面暂未准备好');
  error.code = `DAILY_SHARE_COVER_${stage.toUpperCase()}`;
  error.stage = stage;
  if (cause) {
    error.cause = cause;
    error.nativeMessage = cause.errMsg || cause.message || String(cause);
  }
  return error;
}

function checkCurrent(page) {
  if (page && page._isUnloaded) throw coverError('cancelled');
}

function roundedPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function font(ctx, size) { ctx.font = `${size}px sans-serif`; }
function measure(ctx, value) { return ctx.measureText(value).width; }

function trimLine(ctx, value, width) {
  const characters = Array.from(value.trim());
  while (characters.length && measure(ctx, characters.join('') + '…') > width) characters.pop();
  return characters.join('') + '…';
}

function shortPhraseLines(ctx, value, width, maxLines) {
  if (value.includes('\n') || Array.from(value).length > 32) return null;
  const clauses = [];
  const characters = Array.from(value);
  let current = '';
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    current += character;
    if (/[，；：。！？,;:!?]/.test(character) &&
        characters.slice(index + 1).some(next => next.trim() && !/[，；：。！？,;:!?）》】」』”’]/.test(next))) {
      clauses.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) clauses.push(current.trim());
  // A short daily saying reads more naturally in complete phrases, even when
  // the entire sentence would narrowly fit in one line.
  if (clauses.length < 2 || clauses.length > maxLines ||
      clauses.some(clause => Array.from(clause).length < 3 || measure(ctx, clause) > width) ||
      Array.from(clauses[clauses.length - 1]).length < 4) return null;
  return clauses;
}

function balanceShortTail(ctx, lines, value, width) {
  if (value.includes('\n') || Array.from(value).length > 32 || lines.length < 2 || Array.from(lines[lines.length - 1]).length > 3) return lines;
  const previous = lines[lines.length - 2];
  const last = lines[lines.length - 1];
  const combined = value.includes(previous + last) ? previous + last : previous + ' ' + last;
  const characters = Array.from(combined);
  let best = null;
  for (let split = 4; split <= characters.length - 4; split++) {
    const before = characters[split - 1], after = characters[split];
    if (/^[，。！？；：、）》】」』,.!?;:]$/.test(after) || /^[（《【「『“]$/.test(before) ||
        /^[a-zA-Z]$/.test(before) && /^[a-zA-Z]$/.test(after)) continue;
    const first = characters.slice(0, split).join('').trim();
    const second = characters.slice(split).join('').trim();
    const firstWidth = measure(ctx, first), secondWidth = measure(ctx, second);
    if (firstWidth > width || secondWidth > width) continue;
    const difference = Math.abs(firstWidth - secondWidth);
    if (!best || difference < best.difference) best = { first, second, difference };
  }
  if (best) return [...lines.slice(0, -2), best.first, best.second];
  return lines;
}

function wrapQuote(ctx, value, width, maxLines) {
  const phrases = shortPhraseLines(ctx, value, width, maxLines);
  if (phrases) return phrases;
  const lines = [];
  let current = '';
  const characters = Array.from(value);
  const closing = /^[，。！？；：、）》】」』,.!?;:]$/;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === '\n') {
      if (current) { lines.push(current.trim()); current = ''; }
    } else if (current && measure(ctx, current + character) > width) {
      const boundary = current.lastIndexOf(' ');
      if (boundary > 0 && measure(ctx, current.slice(0, boundary)) > width / 2) {
        lines.push(current.slice(0, boundary).trim());
        current = current.slice(boundary + 1) + character;
      } else if (closing.test(character) && Array.from(current).length > 1) {
        const previous = Array.from(current);
        const last = previous.pop();
        lines.push(previous.join('').trim());
        current = last + character;
      } else {
        lines.push(current.trim());
        current = character.trimStart();
      }
    } else current += character;
    if (lines.length === maxLines) {
      if (current.trim() || characters.slice(index + 1).join('').trim()) {
        lines[maxLines - 1] = trimLine(ctx, lines[maxLines - 1], width);
      }
      return lines;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return balanceShortTail(ctx, lines, value, width);
}

function normalizedQuote(value) {
  const quote = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim() : '';
  return quote || DEFAULT_QUOTE;
}

function label(ctx, value, x, y, size, color) {
  font(ctx, size);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function singleLine(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}

function fittedLabel(ctx, value, x, y, size, color, width) {
  font(ctx, size);
  label(ctx, measure(ctx, value) > width ? trimLine(ctx, value, width) : value, x, y, size, color);
}

function usableSession(value) {
  if (!value || typeof value !== 'object' || typeof value.minutes !== 'number' ||
      !Number.isFinite(value.minutes) || value.minutes <= 0 || !singleLine(value.name) ||
      !/^\d{4}\.\d{2}\.\d{2}$/.test(value.dateLabel) || !/^\d{2}:\d{2}$/.test(value.timeLabel)) return null;
  return value;
}

function drawDailyShareCover(ctx, snapshot = {}) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  roundedPath(ctx, 20, 20, 460, 360, 20);
  ctx.fillStyle = COLORS.white;
  ctx.fill();
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  const session = usableSession(snapshot.session);
  if (session) {
    fittedLabel(ctx, singleLine(session.name), 46, 48, 26, COLORS.ink, 408);
    label(ctx, `${session.dateLabel}  ${session.timeLabel} 收坐`, 46, 96, 18, COLORS.muted);
    label(ctx, '本次静坐', 46, 178, 20, COLORS.gold);
    const duration = `${session.minutes} 分钟`;
    let size = 30;
    font(ctx, size);
    while (size > 26 && measure(ctx, duration) > 182) font(ctx, --size);
    fittedLabel(ctx, duration, 46, 220, size, COLORS.ink, 182);
  } else {
    label(ctx, '一份安静，送给你', 46, 48, 26, COLORS.ink);
    label(ctx, '每天，留一点时间给自己', 46, 96, 18, COLORS.muted);
    label(ctx, '与自己相处', 46, 178, 20, COLORS.gold);
    label(ctx, '一刻静坐', 46, 220, 30, COLORS.ink);
  }

  // Keep a quiet hierarchy at chat-thumbnail size: modest name/duration
  // emphasis, smaller metadata and enough space around the supporting quote.
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(46, 138, 408, 1);
  ctx.fillRect(244, 176, 1, 120);
  font(ctx, 20);
  const lines = wrapQuote(ctx, normalizedQuote(snapshot.quote), 194, 4);
  lines.forEach((line, index) => label(ctx, line, 260, 178 + index * 30, 20, COLORS.quote));

  ctx.fillStyle = COLORS.line;
  ctx.fillRect(46, 323, 408, 1);
  label(ctx, '静坐觉察', 46, 341, 18, COLORS.muted);
  label(ctx, '查看静心卡 →', 334, 341, 18, COLORS.gold);
}

function getCanvas(page, wxApi) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + TIMEOUT_MS;
    const timer = setTimeout(() => finish(coverError('canvas_timeout')), TIMEOUT_MS);
    function finish(error, canvas) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error && Date.now() >= deadline) error = coverError('canvas_timeout');
      if (error) reject(error);
      else resolve(canvas);
    }
    function select() {
      if (settled) return;
      if (Date.now() >= deadline) { finish(coverError('canvas_timeout')); return; }
      try {
        checkCurrent(page);
        wxApi.createSelectorQuery().in(page).select('#dailyShareCanvas').fields({ node: true, size: true }).exec(results => {
          const field = results && results[0];
          const canvas = field && field.node;
          if (!canvas || typeof canvas.getContext !== 'function' || field.width === 0 || field.height === 0) {
            finish(coverError('canvas_missing'));
          } else finish(null, canvas);
        });
      } catch (error) { finish(error && error.stage ? error : coverError('canvas_query', error)); }
    }
    try {
      if (typeof wxApi.nextTick === 'function') wxApi.nextTick(select);
      else select();
    } catch (error) { finish(coverError('canvas_query', error)); }
  });
}

function exportCover(canvas, wxApi) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + TIMEOUT_MS;
    const timer = setTimeout(() => finish(coverError('export_timeout')), TIMEOUT_MS);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error && Date.now() >= deadline) error = coverError('export_timeout');
      if (!error && (!result || typeof result.tempFilePath !== 'string' || !result.tempFilePath)) error = coverError('export_result', result);
      if (error) reject(error);
      else resolve(result.tempFilePath);
    }
    try {
      const pending = wxApi.canvasToTempFilePath({
        canvas, destWidth: WIDTH * SCALE, destHeight: HEIGHT * SCALE, fileType: 'png',
        success: result => finish(null, result), fail: error => finish(coverError('export', error))
      });
      if (pending && typeof pending.then === 'function') {
        pending.then(result => finish(null, result), error => finish(coverError('export', error))).catch(error => finish(coverError('export', error)));
      }
    } catch (error) { finish(coverError('export', error)); }
  });
}

async function generateDailyShareCover(page, snapshot = {}, wxApi = wx) {
  checkCurrent(page);
  if (!wxApi || typeof wxApi.createSelectorQuery !== 'function' || typeof wxApi.canvasToTempFilePath !== 'function') throw coverError('unsupported');
  // Capture only the share snapshot's primitive fields before awaiting layout.
  // A later page refresh must not mutate a nested session already being drawn.
  const session = snapshot.session;
  const data = { quote: snapshot.quote, date: snapshot.date, weekDay: snapshot.weekDay,
    session: session && { name: session.name, minutes: session.minutes, endedAt: session.endedAt,
      dateLabel: session.dateLabel, timeLabel: session.timeLabel } };
  const canvas = await getCanvas(page, wxApi);
  try {
    checkCurrent(page);
    try {
      canvas.width = WIDTH * SCALE;
      canvas.height = HEIGHT * SCALE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('CanvasRenderingContext2D is unavailable');
      ctx.scale(SCALE, SCALE);
      drawDailyShareCover(ctx, data);
    } catch (error) { throw coverError('draw', error); }
    const path = await exportCover(canvas, wxApi);
    checkCurrent(page);
    return path;
  } finally {
    // Exported PNGs are independent files. Discard the native drawing surface
    // so a client ignoring parent opacity can never leave a cover on the page.
    try {
      const ctx = canvas.getContext('2d');
      if (ctx && typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch (_) {}
    try { canvas.width = 1; canvas.height = 1; } catch (_) {}
  }
}

module.exports = { generateDailyShareCover, drawDailyShareCover, WIDTH, HEIGHT };
