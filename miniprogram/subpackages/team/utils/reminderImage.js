const LOGICAL_WIDTH = 750;
const MAX_CANVAS_EDGE = 8192;
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
const AVATAR_CONCURRENCY = 4;
const AVATAR_TIMEOUT_MS = 4000;
const AVATAR_BATCH_TIMEOUT_MS = 7000;
const EXPORT_TIMEOUT_MS = 10000;

const colors = {
  background: '#f8f9fb', card: '#ffffff', border: '#f0f2f5',
  text: '#354152', muted: '#99a1ae', gold: '#b29764',
  goldText: '#a68a57', goldTint: '#f9f7f3', track: '#f2f4f6'
};

function checkCurrent(isCurrent) {
  if (!isCurrent()) {
    const error = new Error('提醒图片已取消，请重新生成');
    error.code = 'REMINDER_CANCELLED';
    throw error;
  }
}

function font(context, size, weight = 'normal') {
  context.font = `${weight} ${size}px sans-serif`;
}

function wrapText(context, value, maxWidth) {
  const lines = [];
  let line = '';
  for (const character of Array.from(String(value))) {
    if (line && context.measureText(line + character).width > maxWidth) {
      lines.push(line);
      line = character;
    } else {
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['未设置昵称'];
}

function layoutHeading(context, teamName, businessDate) {
  font(context, 32, '500');
  const name = String(teamName || '').replace(/\s+/g, ' ').trim();
  const nameLines = name ? wrapText(context, name, 646) : [];
  const captionTop = 32 + (nameLines.length ? nameLines.length * 44 + 12 : 0);
  return { nameLines, caption: `${businessDate} · 待达标同学`, captionTop, height: captionTop + 36 + 28 };
}

function drawHeading(context, heading) {
  context.textAlign = 'center';
  context.fillStyle = colors.text;
  font(context, 32, '500');
  heading.nameLines.forEach((line, index) => context.fillText(line, LOGICAL_WIDTH / 2, 32 + index * 44));
  font(context, 26);
  context.fillStyle = colors.goldText;
  context.fillText(heading.caption, LOGICAL_WIDTH / 2, heading.captionTop);
  context.textAlign = 'left';
}

function roundedRect(context, x, y, width, height, radius, fill, stroke) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 1.5;
    context.stroke();
  }
}

function layoutCard(context, member, hasGoal) {
  const status = member.statusLabel || (member.todayStatus === 'not_practiced' ? '尚未练习' : '时长不足');
  font(context, 20);
  const statusWidth = context.measureText(status).width + 24;
  const nameWidth = 646 - 93 - statusWidth - 38;
  font(context, 28, '500');
  const nameLines = wrapText(context, member.nickname || '未设置昵称', nameWidth);
  const lastNameWidth = context.measureText(nameLines[nameLines.length - 1]).width;
  const creatorOnNewLine = Boolean(member.isCreator && lastNameWidth + 66 > nameWidth);
  const nameHeight = nameLines.length * 42 + (creatorOnNewLine ? 36 : 0);
  const subtitle = member.todayStatus === 'not_practiced'
    ? '今天的练习，还未开始'
    : `距离目标还差 ${member.remainingMinutesLabel} 分钟`;
  font(context, 22);
  const subtitleLines = wrapText(context, subtitle, nameWidth);
  const headerHeight = Math.max(76, nameHeight + 8 + subtitleLines.length * 33);
  return { member, status, statusWidth, nameLines, lastNameWidth, creatorOnNewLine,
    nameHeight, subtitleLines, headerHeight, height: 24 + headerHeight + 22 + 44 + (hasGoal ? 20 : 0) + 24 };
}

// Both callback-only and Promise-returning WeChat SDK versions are supported.
function sdkRequest(invoke, success, fail) {
  let received = false;
  const onceSuccess = value => {
    if (received) return;
    received = true;
    try { success(value); } catch (error) { fail(error); }
  };
  const onceFail = error => {
    if (received) return;
    received = true;
    fail(error);
  };
  try {
    const pending = invoke({ success: onceSuccess, fail: onceFail });
    if (pending && typeof pending.then === 'function') pending.then(onceSuccess, onceFail).catch(onceFail);
  } catch (error) {
    onceFail(error);
  }
}

function loadAvatar({ canvas, source, wxApi, isCurrent, deadline }) {
  checkCurrent(isCurrent);
  if (!source || Date.now() >= deadline) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    let image;
    const expiresAt = Math.min(deadline, Date.now() + AVATAR_TIMEOUT_MS);
    const timer = setTimeout(() => finish(null), Math.max(0, expiresAt - Date.now()));
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (image) { image.onload = null; image.onerror = null; }
      try { checkCurrent(isCurrent); resolve(value); } catch (error) { reject(error); }
    }
    function active() {
      if (settled) return false;
      if (!isCurrent() || Date.now() >= expiresAt) { finish(null); return false; }
      return true;
    }
    function decode(path) {
      if (!active()) return;
      if (!path) { finish(null); return; }
      try {
        image = canvas.createImage();
        image.onload = () => { if (active()) finish(image); };
        image.onerror = () => finish(null);
        image.src = path;
      } catch (_) { finish(null); }
    }
    function download(url) {
      if (!active()) return;
      if (!wxApi || typeof wxApi.getImageInfo !== 'function') { finish(null); return; }
      sdkRequest(callbacks => wxApi.getImageInfo({ src: url, ...callbacks }),
        result => { if (active()) decode(result && result.path); }, () => finish(null));
    }
    if (String(source).startsWith('cloud://')) {
      const cloud = wxApi && wxApi.cloud;
      if (cloud && typeof cloud.downloadFile === 'function') {
        sdkRequest(callbacks => cloud.downloadFile({ fileID: source, ...callbacks }),
          result => { if (active()) decode(result && result.tempFilePath); }, () => finish(null));
      } else if (cloud && typeof cloud.getTempFileURL === 'function') {
        sdkRequest(callbacks => cloud.getTempFileURL({ fileList: [source], ...callbacks }), result => {
          if (!active()) return;
          const file = result && result.fileList && result.fileList[0];
          if (!file || (file.status !== undefined && file.status !== 0) || !file.tempFileURL) finish(null);
          else download(file.tempFileURL);
        }, () => finish(null));
      } else finish(null);
    } else if (/^https?:\/\//i.test(source)) download(source);
    else decode(source);
  });
}

async function loadAvatars(canvas, members, wxApi, isCurrent) {
  const avatars = new Array(members.length).fill(null);
  const deadline = Date.now() + AVATAR_BATCH_TIMEOUT_MS;
  let next = 0;
  async function worker() {
    while (next < members.length) {
      checkCurrent(isCurrent);
      const index = next++;
      avatars[index] = await loadAvatar({ canvas, source: members[index].avatar, wxApi, isCurrent, deadline });
      checkCurrent(isCurrent);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AVATAR_CONCURRENCY, members.length) }, worker));
  return avatars;
}

function drawAvatar(context, avatar, x, y) {
  context.save();
  context.beginPath();
  context.arc(x + 38, y + 38, 38, 0, Math.PI * 2);
  context.clip();
  if (avatar && avatar.width > 0 && avatar.height > 0) {
    const edge = Math.min(avatar.width, avatar.height);
    context.drawImage(avatar, (avatar.width - edge) / 2, (avatar.height - edge) / 2, edge, edge, x, y, 76, 76);
  } else {
    context.fillStyle = colors.gold;
    context.fillRect(x, y, 76, 76);
    font(context, 25, '600');
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.fillText('ME', x + 38, y + 25);
  }
  context.restore();
}

function drawCard(context, layout, avatar, top, goal) {
  const { member, status, statusWidth, nameLines, lastNameWidth, creatorOnNewLine,
    nameHeight, subtitleLines, headerHeight, height } = layout;
  roundedRect(context, 24, top, 702, height, 20, colors.card, colors.border);
  const left = 52;
  const headerTop = top + 24;
  const identityLeft = left + 93;
  drawAvatar(context, avatar, left, headerTop);
  context.textAlign = 'left';
  font(context, 28, '500');
  context.fillStyle = colors.text;
  nameLines.forEach((line, index) => context.fillText(line, identityLeft, headerTop + index * 42));
  if (member.isCreator) {
    const tagX = creatorOnNewLine ? identityLeft : identityLeft + lastNameWidth + 10;
    const tagY = headerTop + (nameLines.length - 1) * 42 + (creatorOnNewLine ? 42 : 3);
    roundedRect(context, tagX, tagY, 56, 32, 6, colors.goldTint);
    font(context, 20);
    context.fillStyle = colors.goldText;
    context.fillText('团长', tagX + 8, tagY + 4);
  }
  font(context, 22);
  context.fillStyle = colors.muted;
  subtitleLines.forEach((line, index) => context.fillText(line, identityLeft, headerTop + nameHeight + 8 + index * 33));
  const statusX = LOGICAL_WIDTH - 52 - 26 - statusWidth;
  const statusY = headerTop + 22;
  const notPracticed = member.todayStatus === 'not_practiced';
  roundedRect(context, statusX, statusY, statusWidth, 34, 9, notPracticed ? '#f3f4f6' : colors.goldTint);
  font(context, 20);
  context.fillStyle = notPracticed ? '#7a8493' : colors.goldText;
  context.fillText(status, statusX + 12, statusY + 6);
  font(context, 32);
  context.fillStyle = '#a9b0ba';
  context.fillText('›', LOGICAL_WIDTH - 65, statusY - 1);
  const detailsTop = headerTop + headerHeight + 22;
  font(context, 36, '500');
  context.fillStyle = colors.text;
  const minutes = String(member.todayMinutesLabel == null ? member.todayMinutes || 0 : member.todayMinutesLabel);
  context.fillText(minutes, left, detailsTop);
  const minutesWidth = context.measureText(minutes).width;
  font(context, 22);
  context.fillStyle = colors.muted;
  const unit = goal === null ? ' 分钟' : ` / ${goal} 分钟`;
  context.fillText(unit, left + minutesWidth + 2, detailsTop + 11);
  if (member.todayPracticeCount > 0) {
    context.fillText(`${member.todayPracticeCount} 次练习`, left + minutesWidth + 2 + context.measureText(unit).width + 18, detailsTop + 11);
  }
  if (goal !== null) {
    const progressTop = detailsTop + 58;
    roundedRect(context, left, progressTop, 646, 6, 3, colors.track);
    const progress = Math.max(0, Math.min(100, Number(member.progress) || 0));
    if (progress > 0) roundedRect(context, left, progressTop, 646 * progress / 100, 6, 3, colors.gold);
  }
}

function exportImage(canvas, width, height, wxApi, isCurrent) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('图片生成超时，请重试')), EXPORT_TIMEOUT_MS);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { checkCurrent(isCurrent); } catch (cancelled) { reject(cancelled); return; }
      if (error || !result || !result.tempFilePath) {
        reject(new Error('提醒图片生成失败，请重试'));
      } else resolve({ tempFilePath: result.tempFilePath, width, height });
    }
    sdkRequest(callbacks => wxApi.canvasToTempFilePath({ canvas, x: 0, y: 0, width, height,
      destWidth: width, destHeight: height, fileType: 'png', ...callbacks }),
    result => finish(null, result), error => finish(error));
  });
}

async function createReminderImage({ canvas, report, members, teamName = '', wxApi = wx, isCurrent = () => true } = {}) {
  checkCurrent(isCurrent);
  const goal = report && report.settings && report.settings.dailyGoalMinutes;
  if (!report || !/^\d{4}-\d{2}-\d{2}$/.test(report.businessDate || '') ||
      !report.settings || !(goal === null || Number.isFinite(goal) && goal > 0) ||
      !Array.isArray(members) || members.some(member => !member ||
        !(member.todayStatus === 'not_practiced' || goal !== null && member.todayStatus === 'below_goal'))) {
    throw new Error('当日练习数据不完整，请刷新后重试');
  }
  if (!members.length) throw new Error('当日没有需要提醒的成员');
  if (members.length > 50) throw new Error('团队成员数据异常，请刷新后重试');
  if (!canvas || typeof canvas.getContext !== 'function' || !wxApi || typeof wxApi.canvasToTempFilePath !== 'function') {
    throw new Error('暂时无法生成图片，请重试或更新微信');
  }
  const context = canvas.getContext('2d');
  if (!context) throw new Error('暂时无法生成图片，请重试或更新微信');
  const heading = layoutHeading(context, teamName, report.businessDate);
  const layouts = members.map(member => layoutCard(context, member, goal !== null));
  const logicalHeight = heading.height + 24 + layouts.reduce((sum, layout) => sum + layout.height, 0) + (layouts.length - 1) * 16;
  const scale = Math.min(2, MAX_CANVAS_EDGE / logicalHeight, MAX_CANVAS_EDGE / LOGICAL_WIDTH,
    Math.sqrt(MAX_CANVAS_PIXELS / (LOGICAL_WIDTH * logicalHeight)));
  const width = Math.max(1, Math.floor(LOGICAL_WIDTH * scale));
  const height = Math.max(1, Math.floor(logicalHeight * scale));
  const avatars = await loadAvatars(canvas, members, wxApi, isCurrent);
  checkCurrent(isCurrent);
  canvas.width = width;
  canvas.height = height;
  context.scale(width / LOGICAL_WIDTH, height / logicalHeight);
  context.textBaseline = 'top';
  context.fillStyle = colors.background;
  context.fillRect(0, 0, LOGICAL_WIDTH, logicalHeight);
  drawHeading(context, heading);
  let top = heading.height;
  layouts.forEach((layout, index) => {
    checkCurrent(isCurrent);
    drawCard(context, layout, avatars[index], top, goal);
    top += layout.height + 16;
  });
  checkCurrent(isCurrent);
  return exportImage(canvas, width, height, wxApi, isCurrent);
}

module.exports = { createReminderImage };
