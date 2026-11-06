const { getAvatarInitial, getAvatarSource } = require('./avatar.js');

const WIDTH = 750;
const HEIGHT = 1334;
const DEFAULT_IMAGE = '/images/p1.png';
const QR_IMAGE = '/images/miniP.jpg';
const ASSET_TIMEOUT_MS = 4000;
const CANVAS_TIMEOUT_MS = 4000;
const EXPORT_TIMEOUT_MS = 10000;
const COLORS = {
  paper: '#f7f5ef', card: '#ffffff', ink: '#343c37',
  muted: '#879087', gold: '#b29764', line: '#ede9df', tint: '#f5f1e8'
};

// SDK versions may return Promises as well as invoking supplied callbacks.
function invokeOnce(invoke, success, fail) {
  let received = false;
  const onSuccess = result => {
    if (received) return;
    received = true;
    try { success(result); } catch (error) { fail(error); }
  };
  const onFail = error => {
    if (received) return;
    received = true;
    fail(error);
  };
  try {
    const pending = invoke({ success: onSuccess, fail: onFail });
    if (pending && typeof pending.then === 'function') pending.then(onSuccess, onFail).catch(onFail);
  } catch (error) { onFail(error); }
}

function imageError(message, stage, cause) {
  const error = new Error(message);
  error.code = `DAILY_IMAGE_${stage.toUpperCase()}`;
  error.stage = stage;
  if (cause) {
    error.cause = cause;
    error.nativeMessage = cause.errMsg || cause.message || String(cause);
  }
  return error;
}

function normalizeImagePath(source) {
  // getImageInfo returns package paths without their leading slash on some
  // clients. Canvas Image.src otherwise resolves them relative to pages/daily.
  return /^images\//.test(source) ? `/${source}` : source;
}

function checkCurrent(page) {
  if (page && page._isUnloaded) throw imageError('页面已关闭，请重新打开后保存图片', 'cancelled');
}

function getCanvas(page, wxApi) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + CANVAS_TIMEOUT_MS;
    const timer = setTimeout(() => finish(imageError('图片画布准备超时，请重试', 'canvas_timeout')), CANVAS_TIMEOUT_MS);
    function finish(error, canvas) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error && Date.now() >= deadline) error = imageError('图片画布准备超时，请重试', 'canvas_timeout');
      if (error) reject(error);
      else resolve(canvas);
    }
    const query = () => {
      if (settled) return;
      try {
        wxApi.createSelectorQuery().in(page).select('#dailyCanvas').fields({ node: true, size: true }).exec(results => {
          const field = results && results[0];
          const canvas = field && field.node;
          if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.createImage !== 'function' ||
              field.width === 0 || field.height === 0) {
            finish(imageError('图片画布尚未就绪，请重试', 'canvas_missing', { errMsg: 'dailyCanvas type=2d node missing or has zero layout size' }));
          } else finish(null, canvas);
        });
      } catch (error) { finish(imageError('图片画布准备失败，请重试', 'canvas_query', error)); }
    };
    try {
      if (typeof wxApi.nextTick === 'function') wxApi.nextTick(query);
      else query();
    } catch (error) { finish(imageError('图片画布准备失败，请重试', 'canvas_query', error)); }
  });
}

function loadImage(canvas, source, wxApi) {
  if (!source) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    let image;
    const deadline = Date.now() + ASSET_TIMEOUT_MS;
    const timer = setTimeout(() => finish(imageError('图片加载超时，请重试', 'asset_timeout')), ASSET_TIMEOUT_MS);
    function finish(error, asset) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (image) { image.onload = null; image.onerror = null; }
      if (error) reject(error);
      else resolve(asset);
    }
    function active() {
      if (settled) return false;
      if (Date.now() >= deadline) { finish(imageError('图片加载超时，请重试', 'asset_timeout')); return false; }
      return true;
    }
    function decode(path) {
      if (!active()) return;
      if (typeof path !== 'string' || !path) { finish(imageError('图片地址不可用，请重试', 'asset_path')); return; }
      try {
        image = canvas.createImage();
        image.onload = () => {
          if (!active()) return;
          if (!(image.width > 0) || !(image.height > 0)) { finish(imageError('图片尺寸不可用，请重试', 'asset_dimensions')); return; }
          finish(null, { image, path: normalizeImagePath(path), width: image.width, height: image.height });
        };
        image.onerror = error => finish(imageError('图片读取失败，请重试', 'asset_decode', error));
        image.src = normalizeImagePath(path);
      } catch (error) { finish(imageError('图片读取失败，请重试', 'asset_decode', error)); }
    }
    function download(url) {
      if (!active()) return;
      if (!url || !wxApi || typeof wxApi.getImageInfo !== 'function') { finish(imageError('图片下载不可用，请重试', 'asset_download')); return; }
      invokeOnce(callbacks => wxApi.getImageInfo({ src: url, ...callbacks }), result => {
        if (active()) decode(result && result.path);
      }, error => finish(imageError('图片下载失败，请重试', 'asset_download', error)));
    }
    if (String(source).startsWith('cloud://')) {
      const cloud = wxApi && wxApi.cloud;
      if (cloud && typeof cloud.downloadFile === 'function') {
        invokeOnce(callbacks => cloud.downloadFile({ fileID: source, ...callbacks }),
          result => { if (active()) decode(result && result.tempFilePath); }, error => finish(imageError('图片下载失败，请重试', 'asset_download', error)));
      } else if (cloud && typeof cloud.getTempFileURL === 'function') {
        invokeOnce(callbacks => cloud.getTempFileURL({ fileList: [source], ...callbacks }), result => {
          if (!active()) return;
          const file = result && result.fileList && result.fileList[0];
          if (!file || (file.status !== undefined && file.status !== 0)) finish(imageError('图片地址不可用，请重试', 'asset_path', file));
          else download(file.tempFileURL);
        }, error => finish(imageError('图片下载失败，请重试', 'asset_download', error)));
      } else finish(imageError('图片下载不可用，请重试', 'asset_download'));
    } else if (/^https?:\/\//i.test(source)) download(source);
    else decode(source);
  });
}

function drawingContext(native) {
  const ctx = {
    setFillStyle(value) { native.fillStyle = value; },
    setGlobalCompositeOperation(value) { native.globalCompositeOperation = value; },
    setFontSize(value) { native.font = `${value}px sans-serif`; },
    setTextAlign(value) { native.textAlign = value; },
    setTextBaseline(value) { native.textBaseline = value; }
  };
  for (const name of ['beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'fill',
    'fillText', 'fillRect', 'drawImage', 'measureText', 'save', 'restore', 'arc', 'clip']) {
    ctx[name] = native[name].bind(native);
  }
  return ctx;
}

function roundedRect(ctx, x, y, width, height, radius, color) {
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
  ctx.setFillStyle(color);
  ctx.fill();
}

function text(ctx, value, x, y, size, color = COLORS.ink, align = 'left') {
  ctx.setFontSize(size);
  ctx.setFillStyle(color);
  ctx.setTextAlign(align);
  ctx.setTextBaseline('top');
  ctx.fillText(String(value == null ? '' : value), x, y);
}

function measure(ctx, value) {
  return ctx.measureText(value).width;
}

function ellipsis(ctx, value, maxWidth) {
  const characters = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
  if (measure(ctx, characters.join('')) <= maxWidth) return characters.join('');
  while (characters.length && measure(ctx, characters.join('') + '…') > maxWidth) characters.pop();
  return characters.join('') + '…';
}

function quoteLines(ctx, value, maxWidth, maxLines) {
  const characters = Array.from(String(value || '静心即是修心，心安即是归处。').replace(/\s+/g, ' ').trim());
  const lines = [];
  let current = '';
  for (let index = 0; index < characters.length; index++) {
    const next = current + characters[index];
    if (current && measure(ctx, next) > maxWidth) {
      if (lines.length === maxLines - 1) {
        lines.push(ellipsis(ctx, current + characters.slice(index).join(''), maxWidth));
        return lines;
      }
      lines.push(current);
      current = characters[index];
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function drawFittedImage(ctx, image, x, y, width, height) {
  if (!image || !image.path) return;
  const ratio = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * ratio;
  const drawHeight = image.height * ratio;
  ctx.drawImage(image.image || image.path, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawAvatar(ctx, image, nickname) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(112, 999, 32, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    const edge = Math.min(image.width, image.height);
    ctx.drawImage(image.image || image.path, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 80, 967, 64, 64);
  } else {
    ctx.setFillStyle(COLORS.gold);
    ctx.fillRect(80, 967, 64, 64);
    text(ctx, getAvatarInitial(nickname), 112, 984, 30, '#ffffff', 'center');
  }
  ctx.restore();
}

function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function drawDailyPoster(ctx, snapshot, assets = {}) {
  const data = snapshot || {};
  const main = assets.main || { path: DEFAULT_IMAGE, width: 495, height: 720 };
  ctx.setFillStyle(COLORS.paper);
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  roundedRect(ctx, 32, 32, 686, 1188, 28, COLORS.card);
  text(ctx, '静 心 卡', 80, 73, 23, COLORS.gold);
  text(ctx, String(data.day || '').padStart(2, '0'), 76, 119, 76);
  text(ctx, data.month || '', 185, 131, 27, COLORS.ink);
  text(ctx, `${data.year || ''} 年`, 187, 172, 22, COLORS.muted);
  text(ctx, data.weekDay || '', 670, 137, 25, COLORS.ink, 'right');
  ctx.setFontSize(22);
  text(ctx, ellipsis(ctx, data.lunarDate, 235), 670, 174, 22, COLORS.muted, 'right');
  ctx.setFillStyle(COLORS.line);
  ctx.fillRect(80, 218, 590, 1);

  // The photograph/card keeps its native aspect ratio on every export.
  roundedRect(ctx, 184, 249, 382, 504, 18, COLORS.tint);
  drawFittedImage(ctx, main, 200, 261, 350, 480);
  ctx.setFontSize(28);
  const lines = quoteLines(ctx, data.wisdomQuote, 548, 4);
  const firstLine = 808 + Math.max(0, 4 - lines.length) * 14;
  lines.forEach((line, index) => text(ctx, line, WIDTH / 2, firstLine + index * 38, 28, COLORS.ink, 'center'));

  if (data.isSharedView && data.session) {
    ctx.setFontSize(30);
    text(ctx, ellipsis(ctx, data.session.name, 590), 80, 975, 30, COLORS.ink);
    text(ctx, `${data.session.dateLabel} ${data.session.timeLabel} 收坐`, 80, 1024, 23, COLORS.muted);
    text(ctx, `静坐 ${data.session.minutes} 分钟`, 80, 1076, 39, COLORS.ink);
    text(ctx, '把这一刻的安静，分享给你', 80, 1142, 22, COLORS.gold);
  } else if (data.isSharedView) {
    text(ctx, '一张静心卡，一份安静', WIDTH / 2, 1011, 30, COLORS.ink, 'center');
    text(ctx, '愿你在忙碌里，也有片刻安住。', WIDTH / 2, 1063, 23, COLORS.muted, 'center');
    roundedRect(ctx, 310, 1131, 130, 2, 1, COLORS.gold);
  } else {
    drawAvatar(ctx, assets.avatar, data.userName);
    ctx.setFontSize(27);
    text(ctx, ellipsis(ctx, data.userName || '静心者', 472), 164, 970, 27);
    ctx.setFontSize(21);
    const badge = data.highestLevelBadge && data.highestLevelBadge.name;
    text(ctx, ellipsis(ctx, badge || '每天，和自己安静相处', 472), 164, 1011, 21, badge ? COLORS.gold : COLORS.muted);
    ctx.setFillStyle(COLORS.line);
    ctx.fillRect(80, 1058, 590, 1);
    ctx.fillRect(375, 1088, 1, 70);
    text(ctx, `${safeCount(data.totalCount)} 次`, 225, 1083, 43, COLORS.ink, 'center');
    text(ctx, '今日静坐', 225, 1142, 22, COLORS.muted, 'center');
    text(ctx, `${safeCount(data.totalMinutes)} 分钟`, 525, 1083, 43, COLORS.ink, 'center');
    text(ctx, '本次静坐', 525, 1142, 22, COLORS.muted, 'center');
  }

  text(ctx, '觉察计时器', 56, 1251, 25, COLORS.ink);
  text(ctx, '每天，留一点时间给自己', 56, 1290, 21, COLORS.muted);
  const qr = assets.qr || { path: QR_IMAGE, width: 344, height: 344 };
  // Blend the QR's white paper into the footer without changing its dark marks.
  ctx.save();
  ctx.setGlobalCompositeOperation('multiply');
  drawFittedImage(ctx, qr, 604, 1230, 96, 96);
  ctx.restore();
}

function exportImage(canvas, wxApi) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + EXPORT_TIMEOUT_MS;
    const timer = setTimeout(() => finish(imageError('图片导出超时，请重试', 'export_timeout')), EXPORT_TIMEOUT_MS);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error && Date.now() >= deadline) error = imageError('图片导出超时，请重试', 'export_timeout');
      if (error || !result || !result.tempFilePath) reject(error || imageError('图片导出失败，请重试', 'export_result', result));
      else resolve(result.tempFilePath);
    }
    // type=2d draws synchronously; legacy ctx.draw/canvasId cannot export it.
    // Omitting crop dimensions exports the entire physical backing store.
    invokeOnce(callbacks => wxApi.canvasToTempFilePath({
      canvas, destWidth: WIDTH * 2, destHeight: HEIGHT * 2, fileType: 'png', ...callbacks
    }), result => finish(null, result), error => finish(imageError('图片导出失败，请重试', 'export', error)));
  });
}

function releaseCanvas(canvas) {
  // The exported file owns its pixels after the native export callback. Release
  // this temporary surface so a native-layer visibility regression cannot leave
  // the full-size export painted over the page. Keep the WXML/CSS size intact.
  try {
    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, canvas.width, canvas.height);
  } catch (_) {}
  try { canvas.width = 1; } catch (_) {}
  try { canvas.height = 1; } catch (_) {}
}

async function generateDailyPoster(page, data, wxApi = wx) {
  checkCurrent(page);
  if (!wxApi || typeof wxApi.createSelectorQuery !== 'function' || typeof wxApi.canvasToTempFilePath !== 'function') {
    throw imageError('暂时无法保存图片，请更新微信后重试', 'unsupported');
  }
  // Callers can continue receiving image/wisdom updates while this frozen
  // snapshot is loading. Export always represents the requested daily card.
  const snapshot = { ...(data || {}), highestLevelBadge: data && data.highestLevelBadge ? { ...data.highestLevelBadge } : null };
  const canvas = await getCanvas(page, wxApi);
  try {
    checkCurrent(page);
    const [main, avatar, qr] = await Promise.all([
      loadImage(canvas, snapshot.displayImage || DEFAULT_IMAGE, wxApi).catch(error => {
        if (!snapshot.displayImage || normalizeImagePath(snapshot.displayImage) === DEFAULT_IMAGE) throw error;
        return loadImage(canvas, DEFAULT_IMAGE, wxApi).catch(fallbackError => {
          fallbackError.originalAssetError = error;
          throw fallbackError;
        });
      }),
      snapshot.isSharedView ? null : loadImage(canvas, getAvatarSource(snapshot.userAvatar), wxApi).catch(() => null),
      loadImage(canvas, QR_IMAGE, wxApi)
    ]);
    checkCurrent(page);
    try {
      canvas.width = WIDTH * 2;
      canvas.height = HEIGHT * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('CanvasRenderingContext2D is unavailable');
      ctx.scale(2, 2);
      drawDailyPoster(drawingContext(ctx), snapshot, { main, avatar, qr });
    } catch (error) { throw imageError('图片绘制失败，请重试', 'draw', error); }
    const path = await exportImage(canvas, wxApi);
    checkCurrent(page);
    return path;
  } finally {
    releaseCanvas(canvas);
  }
}

module.exports = { generateDailyPoster, drawDailyPoster, WIDTH, HEIGHT };
