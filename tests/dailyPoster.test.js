const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const poster = require('../miniprogram/utils/dailyPoster.js');

const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = {
  year: 2026, month: 'November', day: 6, weekDay: '星期五', lunarDate: '九月廿八',
  displayImage: 'wxfile://current-card.png', wisdomQuote: '今天，安住于每一次呼吸。',
  userName: 'ripples', userAvatar: '/images/userLogin.png',
  totalCount: 3, totalMinutes: 25, highestLevelBadge: { name: '初心' }
};

function harness({ imageInfo, exportImage, decode, selector, nextTick, context } = {}) {
  const text = [], images = [], fills = [], clears = [], requests = [], exports = [], exportSizes = [], selectors = [], decoded = [], scales = [], states = [];
  const page = { id: 'page', _isUnloaded: false };
  const ctx = {
    font: '20px sans-serif', fillStyle: '#000', textAlign: 'left', textBaseline: 'top',
    scale(x, y) { scales.push([x, y]); },
    measureText(value) {
      const size = Number.parseFloat(this.font);
      return { width: Array.from(value).reduce((width, char) => width + size * (/^[\x00-\x7F]$/.test(char) ? 0.6 : 1), 0) };
    },
    fillText(value, x, y) { text.push({ value, x, y, size: Number.parseFloat(this.font), color: this.fillStyle, align: this.textAlign, width: this.measureText(value).width }); },
    fillRect(x, y, width, height) { fills.push({ x, y, width, height, color: this.fillStyle }); },
    clearRect(x, y, width, height) { clears.push([x, y, width, height]); },
    drawImage(image, ...args) {
      assert.equal(typeof image, 'object', 'native 2d drawImage requires decoded Image objects, never string paths');
      assert.equal(image.loaded, true);
      images.push([image.src, ...args]);
    },
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, arc() {}, clip() {},
    save() { states.push({ font: this.font, fillStyle: this.fillStyle, textAlign: this.textAlign }); },
    restore() { Object.assign(this, states.pop()); }
  };
  const canvas = {
    width: 300, height: 150,
    getContext(kind) { assert.equal(kind, '2d'); return context ? context(ctx) : ctx; },
    createImage() {
      let source;
      return {
        width: 0, height: 0,
        set src(value) {
          source = value; decoded.push(this);
          if (decode) { decode(this, value); return; }
          this.width = /avatar/.test(value) ? 120 : /miniP/.test(value) ? 344 : 495;
          this.height = /avatar/.test(value) ? 80 : /miniP/.test(value) ? 344 : 720;
          this.loaded = true;
          queueMicrotask(() => { if (this.onload) this.onload(); });
        },
        get src() { return source; }
      };
    }
  };
  const wxApi = {
    nextTick(callback) { if (nextTick) nextTick(callback); else queueMicrotask(callback); },
    createSelectorQuery() {
      return {
        in(value) { selectors.push({ page: value }); return this; },
        select(id) { selectors.at(-1).id = id; return this; },
        fields(fields) { selectors.at(-1).fields = fields; return this; },
        exec(callback) { if (selector) selector(callback, canvas); else callback([{ node: canvas, width: 750, height: 1334 }]); }
      };
    },
    getImageInfo(options) {
      requests.push(options);
      if (imageInfo) return imageInfo(options);
      options.success({ path: 'wxfile://downloaded-avatar.png', width: 120, height: 80 });
    },
    canvasToTempFilePath(options) {
      exports.push(options);
      exportSizes.push([options.canvas.width, options.canvas.height]);
      if (exportImage) return exportImage(options);
      options.success({ tempFilePath: 'wxfile://daily-image.png' });
    }
  };
  return { page, ctx, canvas, wxApi, text, images, fills, clears, requests, exports, exportSizes, selectors, decoded, scales,
    generate(data = snapshot, api = poster) { return api.generateDailyPoster(page, data, wxApi); } };
}

test('exports the current daily card, quote and accurate statistics through a mounted Canvas2d node', async () => {
  const h = harness();
  assert.equal(await h.generate(), 'wxfile://daily-image.png');
  const strings = h.text.map(item => item.value);
  for (const value of ['06', 'November', '2026 年', '星期五', '九月廿八', snapshot.wisdomQuote, 'ripples', '初心', '3 次', '25 分钟', '今日静坐', '本次静坐']) assert.ok(strings.includes(value), value);
  const main = h.images.find(item => item[0] === snapshot.displayImage);
  assert.ok(main);
  assert.equal(main[3] / main[4], 495 / 720);
  assert.ok(main[1] >= 200 && main[1] + main[3] <= 550);
  assert.ok(main[2] >= 261 && main[2] + main[4] <= 741);
  assert.ok(h.text.find(item => item.value === snapshot.wisdomQuote).color !== '#ffffff');
  assert.ok(h.images.some(item => item[0] === '/images/miniP.jpg'));
  assert.strictEqual(h.selectors[0].page, h.page);
  assert.equal(h.selectors[0].id, '#dailyCanvas');
  assert.deepEqual(h.selectors[0].fields, { node: true, size: true });
  assert.deepEqual(h.scales, [[2, 2]]);
  assert.deepEqual(h.exportSizes[0], [1500, 2668]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1], 'temporary native pixels are released after the file exists');
  assert.deepEqual(h.clears, [[0, 0, 1500, 2668]]);
  const options = h.exports[0];
  assert.strictEqual(options.canvas, h.canvas);
  assert.equal(Object.hasOwn(options, 'canvasId'), false);
  assert.equal(Object.hasOwn(options, 'width'), false, 'export entire backing store without a logical-size crop');
  assert.deepEqual([options.destWidth, options.destHeight, options.fileType], [1500, 2668, 'png']);
  assert.equal(h.requests.length, 0, 'package/local images decode directly');
  assert.ok(h.decoded.every(image => image.onload === null && image.onerror === null));
});

test('waits for page layout before selecting and decoding the native canvas', async () => {
  let release;
  const h = harness({ nextTick(callback) { release = callback; } });
  const generating = h.generate();
  assert.equal(h.selectors.length, 0); assert.equal(h.decoded.length, 0); assert.equal(h.exports.length, 0);
  release(); await generating;
  assert.equal(h.selectors.length, 1); assert.equal(h.exports.length, 1);
});

test('normalizes package-relative getImageInfo results before setting Canvas Image.src', async () => {
  const h = harness({ imageInfo(options) { options.success({ path: 'images/p1.png' }); } });
  await h.generate({ ...snapshot, displayImage: 'https://example.com/card.png' });
  assert.deepEqual(h.requests.map(item => item.src), ['https://example.com/card.png']);
  assert.ok(h.decoded.some(image => image.src === '/images/p1.png'));
  assert.equal(h.decoded.some(image => image.src === 'images/p1.png'), false);
});

test('placeholder and failed avatars use initials, and decoded avatars crop without stretching', async () => {
  const placeholder = harness(); await placeholder.generate();
  assert.ok(placeholder.text.some(item => item.value === 'R' && item.color === '#ffffff'));
  assert.equal(placeholder.decoded.some(item => item.src === '/images/userLogin.png'), false);
  const failed = harness({ imageInfo(options) { options.fail({ errMsg: 'getImageInfo:fail download failed' }); } });
  await failed.generate({ ...snapshot, userName: '小林', userAvatar: 'https://example.com/avatar.png' });
  assert.ok(failed.text.some(item => item.value === '小' && item.color === '#ffffff'));
  assert.ok(failed.images.some(item => item[0] === snapshot.displayImage));
  const loaded = harness(); await loaded.generate({ ...snapshot, userAvatar: 'wxfile://avatar.png' });
  assert.deepEqual(loaded.images.find(item => item[0] === 'wxfile://avatar.png').slice(1), [20, 0, 80, 80, 80, 967, 64, 64]);
});

test('failed native card decoding loads and decodes the bundled fallback before drawing', async () => {
  const h = harness({ decode(image, source) {
    if (source === snapshot.displayImage) { queueMicrotask(() => image.onerror({ errMsg: 'Image:fail expired file' })); return; }
    image.width = 495; image.height = 720; image.loaded = true; queueMicrotask(() => image.onload());
  } });
  await h.generate();
  const main = h.images.find(item => item[0] === '/images/p1.png');
  assert.ok(main); assert.equal(main[3] / main[4], 495 / 720);
  assert.ok(h.text.some(item => item.value === snapshot.wisdomQuote));
  assert.equal(h.images.some(item => item[0] === snapshot.displayImage), false);
});

test('failure to decode original and fallback images retains both native errors', async () => {
  const native = { errMsg: 'Image:fail invalid image path' };
  const h = harness({ decode(image, source) {
    if (source.includes('miniP')) { image.width = 344; image.height = 344; image.loaded = true; queueMicrotask(() => image.onload()); }
    else queueMicrotask(() => image.onerror(native));
  } });
  await assert.rejects(h.generate(), error => {
    assert.equal(error.stage, 'asset_decode'); assert.strictEqual(error.cause, native);
    assert.equal(error.nativeMessage, native.errMsg); assert.equal(error.originalAssetError.stage, 'asset_decode'); return true;
  });
  assert.equal(h.exports.length, 0); assert.equal(h.images.length, 0);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('a frozen snapshot stays consistent while the visible daily card receives updates', async () => {
  const pending = [], data = { ...snapshot, highestLevelBadge: { name: '初心' } };
  const h = harness({ decode(image) { pending.push(image); } });
  const generating = h.generate(data);
  data.wisdomQuote = '后来更新的金句'; data.displayImage = 'wxfile://new-card.png'; data.totalMinutes = 60; data.highestLevelBadge.name = '更新的勋章';
  await flush();
  for (const image of pending) { image.width = 495; image.height = 720; image.loaded = true; image.onload(); }
  await generating;
  for (const value of [snapshot.wisdomQuote, '初心', '25 分钟']) assert.ok(h.text.some(item => item.value === value));
  assert.ok(h.images.some(item => item[0] === snapshot.displayImage)); assert.equal(h.text.some(item => item.value === data.wisdomQuote), false);
});

test('unloading during image decoding prevents canvas drawing and exporting', async () => {
  const pending = [];
  const h = harness({ decode(image) { pending.push(image); } });
  const generating = h.generate(), rejection = assert.rejects(generating, { stage: 'cancelled' });
  await flush(); h.page._isUnloaded = true;
  for (const image of pending) { image.width = 495; image.height = 720; image.loaded = true; image.onload(); }
  await rejection;
  assert.equal(h.images.length, 0); assert.equal(h.exports.length, 0);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('a native export finishing after unload is discarded', async () => {
  let request;
  const h = harness({ exportImage(options) { request = options; } });
  const generating = h.generate(), rejection = assert.rejects(generating, { stage: 'cancelled' });
  await flush(); h.page._isUnloaded = true; request.success({ tempFilePath: 'wxfile://stale.png' });
  await rejection;
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('shared cards omit private profile and statistics', async () => {
  const h = harness(); await h.generate({ ...snapshot, isSharedView: true, userAvatar: 'https://example.com/private-avatar.png' });
  assert.equal(h.requests.length, 0); assert.ok(h.text.some(item => item.value === '一张静心卡，一份安静'));
  assert.equal(h.text.some(item => ['ripples', '初心', '3 次', '25 分钟', '今日静坐', '本次静坐'].includes(item.value)), false);
  assert.ok(h.images.some(item => item[0] === snapshot.displayImage));
});

test('a saved shared card shows the original public sitting instead of recipient statistics', async () => {
  const h = harness();
  await h.generate({ ...snapshot, isSharedView: true, session: {
    name: '原分享者', minutes: 45, endedAt: Date.parse('2026-11-07T01:15:00+08:00'),
    dateLabel: '2026.11.07', timeLabel: '01:15'
  } });
  for (const value of ['原分享者', '2026.11.07 01:15 收坐', '静坐 45 分钟']) {
    assert.ok(h.text.some(item => item.value === value));
  }
  assert.equal(h.text.some(item => ['ripples', '初心', '3 次', '25 分钟'].includes(item.value)), false);
  assert.equal(h.requests.length, 0);
});

test('long quotes and names fit inside the image without overlapping profile or statistics', async () => {
  const h = harness();
  await h.generate({ ...snapshot, wisdomQuote: '安住于当下的每一次呼吸。'.repeat(30), userName: '非常长的静坐者昵称🙂'.repeat(20), highestLevelBadge: { name: '很长的等级名称'.repeat(20) } });
  const quote = h.text.filter(item => item.size === 28);
  assert.equal(quote.length, 4); assert.ok(quote.at(-1).value.endsWith('…'));
  assert.ok(quote.every(item => item.width <= 548 && item.y + item.size < 967));
  const name = h.text.find(item => item.size === 27 && item.x === 164); assert.ok(name.value.endsWith('…') && name.width <= 472);
  assert.ok(h.text.every(item => {
    const left = item.align === 'center' ? item.x - item.width / 2 : item.align === 'right' ? item.x - item.width : item.x;
    return left >= 0 && left + item.width <= 750 && item.y >= 0 && item.y + item.size <= 1334;
  }));
});

test('duplicate SDK callbacks and promises still decode and export once', async () => {
  const h = harness({ imageInfo(options) {
    const result = { path: 'wxfile://downloaded.png' }; options.success(result); return Promise.resolve(result);
  }, exportImage(options) { options.success({ tempFilePath: 'wxfile://once.png' }); return Promise.reject(new Error('late duplicate error')); } });
  assert.equal(await h.generate({ ...snapshot, displayImage: 'https://example.com/card.png' }), 'wxfile://once.png');
  await flush(); assert.equal(h.requests.length, 1); assert.equal(h.exports.length, 1);
  assert.equal(h.decoded.filter(image => image.src === 'wxfile://downloaded.png').length, 1);
});

test('native export failures retain stage, code, cause and the original errMsg', async () => {
  const native = { errMsg: 'canvasToTempFilePath:fail canvas is empty', errno: 1001 };
  const h = harness({ exportImage(options) { options.fail(native); } });
  await assert.rejects(h.generate(), error => {
    assert.equal(error.message, '图片导出失败，请重试'); assert.equal(error.stage, 'export');
    assert.equal(error.code, 'DAILY_IMAGE_EXPORT'); assert.strictEqual(error.cause, native); assert.equal(error.nativeMessage, native.errMsg); return true;
  });
  assert.deepEqual(h.clears, [[0, 0, 1500, 2668]]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('the native surface stays intact until its export callback and is then released', async () => {
  let request;
  const h = harness({ exportImage(options) { request = options; } });
  const generating = h.generate();
  await flush();
  assert.deepEqual([h.canvas.width, h.canvas.height], [1500, 2668]);
  assert.equal(h.clears.length, 0, 'do not clear pixels while native export is pending');
  request.success({ tempFilePath: 'wxfile://completed-image.png' });
  assert.equal(await generating, 'wxfile://completed-image.png');
  assert.deepEqual(h.clears, [[0, 0, 1500, 2668]]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('a later export restores full resolution and draws its new snapshot after releasing the first surface', async () => {
  let exported = 0;
  const h = harness({ exportImage(options) { options.success({ tempFilePath: `wxfile://image-${++exported}.png` }); } });
  assert.equal(await h.generate(), 'wxfile://image-1.png');
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
  const nextQuote = '此刻，重新安住。';
  assert.equal(await h.generate({ ...snapshot, wisdomQuote: nextQuote, totalMinutes: 45 }), 'wxfile://image-2.png');
  assert.deepEqual(h.exportSizes, [[1500, 2668], [1500, 2668]]);
  assert.deepEqual(h.scales, [[2, 2], [2, 2]]);
  assert.equal(h.text.filter(item => item.value === nextQuote).length, 1);
  assert.ok(h.text.some(item => item.value === '45 分钟'));
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('cleanup errors cannot replace the actual export failure or turn a valid exported file into a failure', async () => {
  for (const fail of [false, true]) {
    const native = { errMsg: 'canvasToTempFilePath:fail native export error' };
    let cleaning = false;
    const h = harness({ exportImage(options) {
      cleaning = true;
      if (fail) options.fail(native);
      else options.success({ tempFilePath: 'wxfile://valid-file.png' });
    } });
    const originalGetContext = h.canvas.getContext;
    h.canvas.getContext = kind => { if (cleaning) throw new Error('native canvas disposed'); return originalGetContext(kind); };
    if (fail) await assert.rejects(h.generate(), error => { assert.equal(error.stage, 'export'); assert.strictEqual(error.cause, native); return true; });
    else assert.equal(await h.generate(), 'wxfile://valid-file.png');
    assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
  }
});

test('missing API, missing node, zero layout and native context errors remain distinguishable', async () => {
  await assert.rejects(poster.generateDailyPoster({}, snapshot, {}), { stage: 'unsupported' });
  await assert.rejects(harness({ selector(callback) { callback([]); } }).generate(), { stage: 'canvas_missing' });
  await assert.rejects(harness({ selector(callback, canvas) { callback([{ node: canvas, width: 0, height: 0 }]); } }).generate(), { stage: 'canvas_missing' });
  const native = new Error('Context2D not ready');
  await assert.rejects(harness({ context() { throw native; } }).generate(), error => { assert.equal(error.stage, 'draw'); assert.strictEqual(error.cause, native); return true; });
});

function timedPoster() {
  let now = 0, nextTimer = 0;
  const timers = new Map(), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dailyPoster.js'), 'utf8'), {
    module, require(request) { assert.equal(request, './avatar.js'); return require('../miniprogram/utils/avatar.js'); },
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, deadline: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { api: module.exports, timers,
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.deadline <= now) { timers.delete(id); timer.callback(); }
      await flush();
    }, elapse(milliseconds) { now += milliseconds; }
  };
}

test('stalled decoding falls back to decoded local art and ignores late native image loads', async () => {
  const timed = timedPoster(); let late;
  const h = harness({ decode(image, source) {
    if (source === snapshot.displayImage) { late = image.onload; return; }
    image.width = 495; image.height = 720; image.loaded = true; queueMicrotask(() => image.onload());
  } });
  const generating = h.generate(snapshot, timed.api); await flush(); await timed.advance(4000);
  assert.equal(await generating, 'wxfile://daily-image.png'); assert.ok(h.images.some(item => item[0] === '/images/p1.png'));
  const drawings = h.images.length; late(); await flush();
  assert.equal(h.images.length, drawings); assert.equal(h.exports.length, 1); assert.equal(timed.timers.size, 0);
});

test('stalled layout, selector and export calls time out and release their timers', async () => {
  for (const [configuration, stage, timeout] of [
    [{ nextTick() {} }, 'canvas_timeout', 4000], [{ selector() {} }, 'canvas_timeout', 4000], [{ exportImage() {} }, 'export_timeout', 10000]
  ]) {
    const timed = timedPoster(), h = harness(configuration), generating = h.generate(snapshot, timed.api);
    const rejection = assert.rejects(generating, { stage }); await flush(); await timed.advance(timeout); await rejection;
    assert.equal(timed.timers.size, 0);
  }
});

test('an export callback arriving after a suspended deadline cannot return a stale success', async () => {
  const timed = timedPoster(); let request;
  const h = harness({ exportImage(options) { request = options; } });
  const generating = h.generate(snapshot, timed.api), rejection = assert.rejects(generating, { stage: 'export_timeout' });
  await flush(); timed.elapse(10000); request.success({ tempFilePath: 'wxfile://too-late.png' }); await rejection;
  assert.equal(timed.timers.size, 0);
});
