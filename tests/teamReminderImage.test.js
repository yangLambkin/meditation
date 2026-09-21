const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createReminderImage } = require('../miniprogram/subpackages/team/utils/reminderImage');
const { selectReminderMembers } = require('../miniprogram/subpackages/team/utils/reminderText');

const flush = () => new Promise(resolve => setImmediate(resolve));
const report = { settings: { dailyGoalMinutes: 60 } };
const member = (nickname, overrides = {}) => ({ nickname, todayStatus: 'below_goal',
  todayMinutes: 26, todayMinutesLabel: '26', remainingMinutesLabel: '34',
  todayPracticeCount: 1, statusLabel: '时长不足', progress: 43, ...overrides });

function harness({ getImageInfo, cloud, decode, exportImage } = {}) {
  const text = [];
  const fills = [];
  const images = [];
  const exports = [];
  const downloads = [];
  const sources = [];
  const stack = [];
  let currentPath = [];
  const context = {
    font: '14px sans-serif', textAlign: 'left',
    measureText(value) {
      const size = Number(this.font.match(/(\d+)px/)[1]);
      return { width: Array.from(String(value)).reduce((sum, character) => sum + size * (character.charCodeAt(0) > 255 ? 1 : 0.55), 0) };
    },
    fillText(value, x, y) { text.push({ value: String(value), x, y, font: this.font, color: this.fillStyle, width: this.measureText(value).width }); },
    fillRect(x, y, width, height) { fills.push({ kind: 'rect', color: this.fillStyle, x, y, width, height }); },
    beginPath() { currentPath = []; },
    moveTo(x, y) { currentPath.push([x, y]); },
    lineTo(x, y) { currentPath.push([x, y]); },
    quadraticCurveTo(...points) { for (let i = 0; i < points.length; i += 2) currentPath.push(points.slice(i, i + 2)); },
    closePath() {}, arc() {}, clip() {}, stroke() {},
    fill() { fills.push({ kind: 'path', color: this.fillStyle, points: [...currentPath] }); },
    scale(x, y) { this.transform = [x, y]; },
    save() { stack.push({ font: this.font, textAlign: this.textAlign, fillStyle: this.fillStyle }); },
    restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { images.push(args); }
  };
  const canvas = {
    getContext(kind) { assert.equal(kind, '2d'); return context; },
    createImage() {
      const image = { width: 120, height: 80 };
      Object.defineProperty(image, 'src', { set(source) {
        sources.push(source);
        if (decode) decode(image, source);
        else queueMicrotask(() => image.onload && image.onload());
      } });
      return image;
    }
  };
  const wxApi = {
    cloud,
    getImageInfo(options) {
      downloads.push(options.src);
      if (getImageInfo) return getImageInfo(options);
      options.success({ path: `wxfile://download-${downloads.length}.png` });
    },
    canvasToTempFilePath(options) {
      exports.push(options);
      if (exportImage) return exportImage(options);
      options.success({ tempFilePath: 'wxfile://reminder.png' });
    }
  };
  return { canvas, wxApi, context, text, fills, images, exports, downloads, sources,
    generate: (members, options = {}) => createReminderImage({ canvas, wxApi, report, members, ...options }) };
}

test('exports only selected unmet cards in list order, preserving their labels and practice details', async () => {
  const h = harness();
  const allMembers = [member('修一', { todayMinutes: 30, todayMinutesLabel: '30', remainingMinutesLabel: '30', progress: 50 }),
    member('已达标同学', { todayStatus: 'qualified', todayMinutes: 60 }),
    member('玉亭', { todayStatus: 'not_practiced', statusLabel: '尚未练习', todayMinutes: 0,
      todayMinutesLabel: '0', todayPracticeCount: 0, progress: 0 }), member('俊池', { isCreator: true })];
  const selected = selectReminderMembers({ ...report, members: allMembers });
  const result = await h.generate(selected);
  const values = h.text.map(item => item.value);
  assert.deepEqual(values.filter(value => ['玉亭', '俊池', '修一', '已达标同学'].includes(value)), ['玉亭', '俊池', '修一']);
  assert.ok(values.includes('今天的练习，还未开始'));
  assert.ok(values.includes('距离目标还差 34 分钟'));
  assert.ok(values.includes('团长'));
  assert.equal(values.filter(value => value === '1 次练习').length, 2);
  assert.equal(values.filter(value => value === ' / 60 分钟').length, 3);
  assert.equal(values.filter(value => value === 'ME').length, 3);
  assert.equal(h.exports.length, 1);
  assert.equal(result.tempFilePath, 'wxfile://reminder.png');
  assert.equal(h.exports[0].canvas, h.canvas);
  assert.equal(h.exports[0].fileType, 'png');
  assert.equal(h.exports[0].destWidth, result.width);
  assert.equal(h.exports[0].destHeight, result.height);
  assert.ok(h.text.filter(item => ['0', '26', '30'].includes(item.value)).every(item => item.x === 52));
  const tracks = h.fills.filter(fill => fill.kind === 'path' && fill.color === '#f2f4f6');
  assert.equal(tracks.length, 3);
  assert.ok(tracks.every(track => Math.min(...track.points.map(point => point[0])) === 52));
});

test('without a daily goal the unpracticed cards omit target minutes and progress tracks', async () => {
  const h = harness();
  await h.generate([member('未练习', { todayStatus: 'not_practiced', todayMinutesLabel: '0', todayPracticeCount: 0 })],
    { report: { settings: { dailyGoalMinutes: null } } });
  assert.ok(h.text.some(item => item.value === ' 分钟'));
  assert.equal(h.text.some(item => item.value.includes('/ 60')), false);
  assert.equal(h.fills.some(fill => fill.kind === 'path' && fill.color === '#f2f4f6'), false);
});

test('all 50 cards fit within a bounded canvas, including the last card and outer padding', async () => {
  const h = harness();
  const members = Array.from({ length: 50 }, (_, index) => member(`同学${index + 1}`));
  const result = await h.generate(members);
  assert.ok(result.width <= 8192 && result.height <= 8192);
  assert.ok(result.width * result.height <= 8 * 1024 * 1024);
  assert.equal(h.text.filter(item => /^同学\d+$/.test(item.value)).length, 50);
  const cards = h.fills.filter(fill => fill.kind === 'path' && fill.color === '#ffffff');
  assert.equal(cards.length, 50);
  const logicalHeight = h.fills.find(fill => fill.kind === 'rect' && fill.color === '#f8f9fb').height;
  const lastBottom = Math.max(...cards[49].points.map(point => point[1]));
  assert.equal(logicalHeight - lastBottom, 24);
  assert.equal(logicalHeight * h.context.transform[1], result.height);
});

test('long names wrap in full and increase card height without overlapping the subtitle or badge', async () => {
  const h = harness();
  const nickname = '这是一位名字非常非常长而且不应该被省略的同学🙂'.repeat(3);
  await h.generate([member(nickname, { isCreator: true })]);
  const nameParts = h.text.filter(item => item.font === '500 28px sans-serif');
  assert.equal(nameParts.map(item => item.value).join(''), nickname);
  assert.ok(nameParts.length > 2);
  const badge = h.text.find(item => item.value === '时长不足');
  assert.ok(nameParts.every(item => item.x + item.width < badge.x));
  const subtitle = h.text.find(item => item.value === '距离目标还差 34 分钟');
  assert.ok(subtitle.y > nameParts[nameParts.length - 1].y + 28);
  const minutes = h.text.find(item => item.value === '26');
  assert.ok(minutes.y > subtitle.y + 22);
});

test('loads local and HTTPS avatars and crops non-square images to a circle', async () => {
  const h = harness();
  await h.generate([member('本地', { avatar: '/images/avatar.png' }), member('网络', { avatar: 'https://example.com/avatar.jpg' })]);
  assert.deepEqual(h.downloads, ['https://example.com/avatar.jpg']);
  assert.deepEqual(h.sources, ['/images/avatar.png', 'wxfile://download-1.png']);
  assert.equal(h.images.length, 2);
  assert.deepEqual(h.images[0].slice(1, 5), [20, 0, 80, 80]);
  assert.equal(h.text.some(item => item.value === 'ME'), false);
});

test('cloud avatars support direct cloud download and temporary URL resolution', async () => {
  const direct = harness({ cloud: { downloadFile: () => Promise.resolve({ tempFilePath: 'wxfile://cloud.png' }) } });
  await direct.generate([member('云头像', { avatar: 'cloud://avatar.png' })]);
  assert.deepEqual(direct.sources, ['wxfile://cloud.png']);
  const url = harness({ cloud: { getTempFileURL(options) {
    options.success({ fileList: [{ status: 0, tempFileURL: 'https://example.com/cloud.png' }] });
    return Promise.resolve({ fileList: [{ status: 0, tempFileURL: 'https://example.com/cloud.png' }] });
  } } });
  await url.generate([member('云头像', { avatar: 'cloud://avatar.png' })]);
  assert.deepEqual(url.downloads, ['https://example.com/cloud.png']);
  assert.equal(url.images.length, 1);
});

test('failed avatar downloads or decoding fall back without losing any cards', async () => {
  const h = harness({ getImageInfo: () => Promise.reject(new Error('offline')),
    decode: image => queueMicrotask(() => image.onerror()), cloud: { downloadFile: options => options.fail(new Error('missing')) } });
  await h.generate([member('网络失败', { avatar: 'https://example.com/a.png' }),
    member('解码失败', { avatar: '/images/b.png' }), member('云图失败', { avatar: 'cloud://c.png' })]);
  assert.equal(h.text.filter(item => item.value === 'ME').length, 3);
  assert.equal(h.images.length, 0);
  assert.equal(h.exports.length, 1);
});

test('avatar downloads have bounded concurrency', async () => {
  const pending = [];
  let active = 0;
  let peak = 0;
  const h = harness({ getImageInfo(options) { active++; peak = Math.max(peak, active); pending.push(options); } });
  const generating = h.generate(Array.from({ length: 10 }, (_, index) => member(`同学${index}`, { avatar: `https://example.com/${index}.png` })));
  await flush();
  assert.equal(pending.length, 4);
  while (pending.length) {
    const request = pending.shift();
    active--;
    request.success({ path: 'wxfile://avatar.png' });
    await flush();
  }
  await generating;
  assert.equal(h.downloads.length, 10);
  assert.equal(peak, 4);
});

test('stalled avatars share a seven-second budget and late responses cannot redraw the result', async () => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/subpackages/team/utils/reminderImage.js'), 'utf8'), {
    module, Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const requests = [];
  const h = harness({ getImageInfo: options => { requests.push(options); } });
  const generating = module.exports.createReminderImage({ canvas: h.canvas, wxApi: h.wxApi, report,
    members: Array.from({ length: 50 }, (_, index) => member(`同学${index}`, { avatar: `https://example.com/${index}.png` })) });
  async function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    await flush();
  }
  await advance(4000);
  assert.equal(requests.length, 8);
  await advance(3000);
  await generating;
  assert.equal(h.text.filter(item => item.value === 'ME').length, 50);
  assert.equal(timers.size, 0);
  requests.forEach(request => request.success({ path: 'wxfile://late.png' }));
  assert.equal(h.sources.length, 0);
  assert.equal(h.exports.length, 1);
});

test('cancellation during avatar loading prevents canvas drawing and export', async () => {
  let current = true;
  let request;
  const h = harness({ getImageInfo: options => { request = options; } });
  const generating = h.generate([member('取消', { avatar: 'https://example.com/a.png' })], { isCurrent: () => current });
  current = false;
  request.success({ path: 'wxfile://avatar.png' });
  await assert.rejects(generating, { code: 'REMINDER_CANCELLED' });
  assert.equal(h.fills.length, 0);
  assert.equal(h.exports.length, 0);
  assert.equal(h.sources.length, 0);
});

test('cancellation after drawing discards a late exported image', async () => {
  let current = true;
  let request;
  const h = harness({ exportImage: options => { request = options; } });
  const generating = h.generate([member('取消')], { isCurrent: () => current });
  await flush();
  current = false;
  request.success({ tempFilePath: 'wxfile://stale.png' });
  await assert.rejects(generating, { code: 'REMINDER_CANCELLED' });
});

test('canvas export errors and invalid results produce readable errors', async () => {
  for (const exportImage of [options => options.fail(new Error('out of memory')), () => Promise.resolve({}),
    () => { throw new Error('unavailable'); }]) {
    const h = harness({ exportImage });
    await assert.rejects(h.generate([member('同学')]), /提醒图片生成失败，请重试/);
  }
});

test('invalid reports, empty lists and qualified members cannot produce an image', async () => {
  const h = harness();
  await assert.rejects(h.generate([member('同学')], { report: null }), /数据不完整/);
  await assert.rejects(h.generate([member('同学')], { report: { settings: {} } }), /数据不完整/);
  await assert.rejects(h.generate([]), /没有需要提醒/);
  await assert.rejects(h.generate([member('达标', { todayStatus: 'qualified' })]), /数据不完整/);
  assert.equal(h.exports.length, 0);
});
