const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const cover = require('../miniprogram/utils/dailyShareCover.js');

const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = { quote: '以不紧不慢的心，安住每一个当下。', date: '2026-11-06', weekDay: '星期五',
  session: { name: '小涟', minutes: 30, endedAt: 1793968200000, dateLabel: '2026.11.06', timeLabel: '20:30' } };

function harness({ nextTick, selector, exportImage, nativeContext } = {}) {
  const text = [], rects = [], selectors = [], exports = [], scales = [], states = [], clears = [];
  const page = { _isUnloaded: false };
  const ctx = {
    font: '20px sans-serif', fillStyle: '#000', textAlign: 'left', textBaseline: 'top',
    scale(x, y) { scales.push([x, y]); },
    measureText(value) {
      const size = Number.parseFloat(this.font);
      return { width: Array.from(value).reduce((sum, character) => sum + size * (/^[\x00-\x7F]$/.test(character) ? 0.55 : 1), 0) };
    },
    fillText(value, x, y) { text.push({ value, x, y, size: Number.parseFloat(this.font), color: this.fillStyle, width: this.measureText(value).width }); },
    fillRect(x, y, width, height) { rects.push({ x, y, width, height, color: this.fillStyle }); },
    clearRect(...args) { clears.push(args); },
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arc() {}, fill() {}, stroke() {}, clip() {},
    save() { states.push({ font: this.font, fillStyle: this.fillStyle, textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { Object.assign(this, states.pop()); },
    drawImage() { assert.fail('friend covers must have no poker, avatars or other image assets'); }
  };
  const canvas = { width: 300, height: 150,
    getContext(kind) { assert.equal(kind, '2d'); return nativeContext ? nativeContext(ctx) : ctx; },
    createImage() { assert.fail('friend covers must not decode or download images'); } };
  const wxApi = {
    nextTick(callback) { if (nextTick) nextTick(callback); else queueMicrotask(callback); },
    createSelectorQuery() {
      return {
        in(value) { selectors.push({ page: value }); return this; },
        select(id) { selectors.at(-1).id = id; return this; },
        fields(fields) { selectors.at(-1).fields = fields; return this; },
        exec(callback) { if (selector) selector(callback, canvas); else callback([{ node: canvas, width: 500, height: 400 }]); }
      };
    },
    canvasToTempFilePath(options) {
      exports.push({ ...options, backingWidth: canvas.width, backingHeight: canvas.height });
      if (exportImage) return exportImage(options);
      options.success({ tempFilePath: 'wxfile://daily-share-cover.png' });
    },
    getImageInfo() { assert.fail('friend covers must render without network or image requests'); }
  };
  return { page, canvas, ctx, wxApi, text, rects, selectors, exports, scales, clears,
    generate(data = snapshot, api = cover) { return api.generateDailyShareCover(page, data, wxApi); } };
}

function quoteText(h) {
  return h.text.filter(item => item.x >= 260 && item.y >= 170 && item.y < 320);
}

test('renders a completed session as the focus of a dedicated 5:4 native Canvas2d friend cover', async () => {
  const h = harness();
  assert.equal(await h.generate(), 'wxfile://daily-share-cover.png');
  assert.equal(h.selectors[0].id, '#dailyShareCanvas');
  assert.strictEqual(h.selectors[0].page, h.page);
  assert.deepEqual(h.selectors[0].fields, { node: true, size: true });
  assert.deepEqual([h.exports[0].backingWidth, h.exports[0].backingHeight], [1000, 800]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
  assert.deepEqual(h.scales, [[2, 2]]);
  assert.strictEqual(h.exports[0].canvas, h.canvas);
  assert.deepEqual([h.exports[0].destWidth, h.exports[0].destHeight, h.exports[0].fileType], [1000, 800, 'png']);
  assert.equal(Object.hasOwn(h.exports[0], 'canvasId'), false);
  assert.equal(Object.hasOwn(h.exports[0], 'width'), false);
  const quote = quoteText(h);
  assert.equal(quote.map(item => item.value).join(''), snapshot.quote);
  assert.ok(quote.every(item => item.size >= 20), 'supporting text remains readable in a chat thumbnail');
  const duration = h.text.find(item => item.value === '30 分钟');
  assert.ok(duration, 'the duration keeps its unit on the same line');
  assert.ok(duration.size > quote[0].size && duration.size <= quote[0].size * 2, 'session emphasis does not overwhelm the supporting text');
  assert.ok(h.text.some(item => item.value === '小涟'));
  assert.ok(h.text.some(item => item.value === '2026.11.06  20:30 收坐'));
  assert.ok(h.text.some(item => item.value === '静坐觉察'));
  assert.ok(h.text.some(item => item.value === '查看静心卡 →'));
  assert.deepEqual(h.rects[0], { x: 0, y: 0, width: 500, height: 400, color: '#f7f5ef' });
});

test('cover uses only the explicit session snapshot and excludes unrelated profile, statistics, avatar and poker data', async () => {
  const h = harness();
  await h.generate({ ...snapshot, userName: 'PRIVATE_PERSON', totalCount: 314159, totalMinutes: 271828,
    userAvatar: 'https://private.example/avatar.png', displayImage: 'cloud://private-poker.png' });
  const values = h.text.map(item => item.value).join('');
  for (const privateValue of ['PRIVATE_PERSON', '314159', '271828', 'private.example', 'private-poker']) assert.equal(values.includes(privateValue), false);
  assert.equal(h.exports.length, 1);
});

test('waits for layout and freezes the quote and nested session before later page updates', async () => {
  let release;
  const h = harness({ nextTick(callback) { release = callback; } });
  const data = structuredClone(snapshot), generating = h.generate(data);
  data.quote = '后来的更新不应进入这张封面';
  Object.assign(data.session, { name: '后来的名字', minutes: 999, dateLabel: '2026.11.07', timeLabel: '21:00' });
  assert.equal(h.selectors.length, 0); assert.equal(h.text.length, 0); assert.equal(h.exports.length, 0);
  release(); await generating;
  assert.equal(quoteText(h).map(item => item.value).join(''), snapshot.quote);
  for (const value of ['小涟', '30 分钟', '2026.11.06  20:30 收坐']) assert.ok(h.text.some(item => item.value === value));
  assert.equal(h.text.some(item => item.value.includes('后来的') || item.value === '999 分钟'), false);
});

test('long Unicode quotes remain readable in the side column without obscuring the duration or footer', async () => {
  const h = harness();
  await h.generate({ ...snapshot, quote: '🙂安住于当下，温柔觉察每一次呼吸。'.repeat(40) });
  const quote = quoteText(h);
  assert.ok(quote.length >= 3 && quote.length <= 5); assert.ok(quote.at(-1).value.endsWith('…'));
  assert.ok(quote.every(item => item.size >= 20 && item.x + item.width <= 454 && item.x >= 260 && item.y >= 170 && item.y + item.size < 323));
  assert.ok(quote.every(item => item.value.isWellFormed()), 'surrogate pairs are kept intact');
  assert.ok(h.text.every(item => item.x >= 20 && item.x + item.width <= 480 && item.y >= 20 && item.y + item.size <= 380));
});

test('line wrapping avoids stranding closing punctuation and prefers whole English words', async () => {
  const chinese = harness();
  await chinese.generate({ ...snapshot, quote: '安'.repeat(14) + '，' + '静坐觉察当下。'.repeat(8) });
  const lines = quoteText(chinese).map(item => item.value);
  assert.ok(lines.every(line => !/^[，。！？；：、）》】」』]/.test(line)));
  const english = harness();
  await english.generate({ ...snapshot, quote: 'Be still and breathe. Return to this moment.' });
  const englishLines = quoteText(english).map(item => item.value);
  assert.deepEqual(englishLines.join(' ').split(/\s+/), 'Be still and breathe. Return to this moment.'.split(' '));
});

test('short sayings wrap at complete phrases instead of leaving one or two characters alone', async () => {
  for (const [quote, expected] of [
    ['慢下来，安住当下。', ['慢下来，', '安住当下。']],
    ['心染沉寂，岁月是禅', ['心染沉寂，', '岁月是禅']]
  ]) {
    const h = harness(); await h.generate({ ...snapshot, quote });
    const lines = quoteText(h);
    assert.deepEqual(lines.map(item => item.value), expected);
    assert.ok(lines.every(item => item.size >= 20 && item.x + item.width <= 454), 'semantic wrapping keeps complete phrases in the secondary column');
  }
});

test('a short saying without punctuation balances its final lines instead of orphaning one character', async () => {
  const quote = '把温柔留给当下的自己';
  const h = harness(); await h.generate({ ...snapshot, quote });
  const lines = quoteText(h);
  assert.equal(lines.length, 2);
  assert.equal(lines.map(item => item.value).join(''), quote);
  assert.ok(lines.every(item => Array.from(item.value).length >= 4 && item.size >= 20 && item.x + item.width <= 454));
  assert.ok(Math.abs(lines[0].width - lines[1].width) <= lines[0].size, 'the two short lines remain visually balanced');
});

test('explicit newlines remain readable and empty quotes use a calm local fallback', async () => {
  const multiline = harness(); await multiline.generate({ quote: '此时\n此地\n此心\n安住' });
  assert.deepEqual(quoteText(multiline).map(item => item.value), ['此时', '此地', '此心', '安住']);
  assert.ok(quoteText(multiline).every(item => item.size >= 20));
  const empty = harness(); await empty.generate({ quote: ' \n ' });
  assert.equal(quoteText(empty).map(item => item.value).join(''), '静心即是修心，心安即是归处。');
});

test('long names and a 1440-minute session stay within their columns while the duration remains prominent', async () => {
  const h = harness();
  await h.generate({ ...snapshot, session: { ...snapshot.session, name: '温柔安住于每个当下的静坐同学🙂'.repeat(5), minutes: 1440 },
    quote: '安住当下，温柔觉察每一次呼吸。'.repeat(20) });
  const name = h.text.find(item => item.value.startsWith('温柔'));
  assert.ok(name.value.endsWith('…')); assert.ok(name.value.isWellFormed());
  assert.ok(name.x + name.width <= 454);
  const duration = h.text.find(item => item.value === '1440 分钟');
  assert.ok(duration, 'even a four-digit duration retains its full number and unit');
  assert.ok(duration.size >= 26 && duration.x + duration.width < 244);
  assert.ok(h.text.every(item => item.x >= 20 && item.x + item.width <= 480 && item.y >= 20 && item.y + item.size <= 380));
  const quote = quoteText(h);
  assert.ok(quote.every(item => item.size < duration.size && item.size >= 20 && item.x >= 260));
});

test('legacy or incomplete shares use a neutral card without inventing a name, date, time or zero-minute record', async () => {
  for (const session of [null, undefined, {}, { ...snapshot.session, minutes: 0 }, { ...snapshot.session, name: '' },
    { ...snapshot.session, timeLabel: '' }, { ...snapshot.session, minutes: NaN }]) {
    const h = harness(); await h.generate({ ...snapshot, session });
    assert.ok(h.text.some(item => item.value === '一刻静坐'));
    assert.equal(h.text.some(item => item.value === '小涟' || /^\d+(?:\s*分钟)?$/.test(item.value) || /2026|20:30|收坐/.test(item.value)), false);
    assert.ok(h.text.every(item => item.x + item.width <= 480));
  }
});

test('callbacks and Promises together settle once and preserve native export errors', async () => {
  const h = harness({ exportImage(options) {
    options.success({ tempFilePath: 'wxfile://once.png' }); return Promise.reject(new Error('late duplicate failure'));
  } });
  assert.equal(await h.generate(), 'wxfile://once.png'); await flush(); assert.equal(h.exports.length, 1);
  const native = { errMsg: 'canvasToTempFilePath:fail native canvas unavailable' };
  const failed = harness({ exportImage(options) { options.fail(native); } });
  await assert.rejects(failed.generate(), error => {
    assert.equal(error.code, 'DAILY_SHARE_COVER_EXPORT'); assert.equal(error.stage, 'export');
    assert.strictEqual(error.cause, native); assert.equal(error.nativeMessage, native.errMsg); return true;
  });
});

test('missing APIs, zero-size nodes and context errors are distinct failures', async () => {
  await assert.rejects(cover.generateDailyShareCover({}, snapshot, {}), { stage: 'unsupported' });
  await assert.rejects(harness({ selector(callback) { callback([]); } }).generate(), { stage: 'canvas_missing' });
  await assert.rejects(harness({ selector(callback, canvas) { callback([{ node: canvas, width: 0, height: 0 }]); } }).generate(), { stage: 'canvas_missing' });
  const native = new Error('2d context missing');
  await assert.rejects(harness({ nativeContext() { throw native; } }).generate(), error => {
    assert.equal(error.stage, 'draw'); assert.strictEqual(error.cause, native); return true;
  });
});

test('unloading before layout prevents drawing, and an export completing after unload is discarded', async () => {
  let release;
  const layout = harness({ nextTick(callback) { release = callback; } });
  const first = layout.generate(), firstRejected = assert.rejects(first, { stage: 'cancelled' });
  layout.page._isUnloaded = true; release(); await firstRejected;
  assert.equal(layout.text.length, 0); assert.equal(layout.exports.length, 0);
  let request;
  const exporting = harness({ exportImage(options) { request = options; } });
  const second = exporting.generate(), secondRejected = assert.rejects(second, { stage: 'cancelled' });
  await flush(); exporting.page._isUnloaded = true; request.success({ tempFilePath: 'wxfile://stale.png' }); await secondRejected;
});

function timedCover() {
  let now = 0, nextTimer = 0;
  const timers = new Map(), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dailyShareCover.js'), 'utf8'), {
    module, Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { api: module.exports, timers,
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    }, elapse(milliseconds) { now += milliseconds; }
  };
}

test('layout, selector and export stages each have a two-second ceiling with timer cleanup', async () => {
  for (const [configuration, stage] of [[{ nextTick() {} }, 'canvas_timeout'], [{ selector() {} }, 'canvas_timeout'], [{ exportImage() {} }, 'export_timeout']]) {
    const timed = timedCover(), h = harness(configuration), generating = h.generate(snapshot, timed.api);
    const rejection = assert.rejects(generating, { stage }); await flush(); await timed.advance(2000); await rejection;
    assert.equal(timed.timers.size, 0);
  }
});

test('a late native export success cannot beat a suspended two-second deadline', async () => {
  const timed = timedCover(); let request;
  const h = harness({ exportImage(options) { request = options; } });
  const generating = h.generate(snapshot, timed.api), rejection = assert.rejects(generating, { stage: 'export_timeout' });
  await flush(); timed.elapse(2000); request.success({ tempFilePath: 'wxfile://too-late.png' }); await rejection;
  assert.equal(timed.timers.size, 0);
});

test('share covers release native pixels after export and redraw at full size on the next request', async () => {
  const h = harness();
  assert.equal(await h.generate(), 'wxfile://daily-share-cover.png');
  assert.deepEqual(h.clears, [[0, 0, 1000, 800]]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
  assert.equal(await h.generate({ ...snapshot, quote: '新的金句' }), 'wxfile://daily-share-cover.png');
  assert.deepEqual(h.exports.map(item => [item.backingWidth, item.backingHeight]), [[1000, 800], [1000, 800]]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});

test('a failed cover export cannot leave its native drawing surface over the page', async () => {
  const failure = { errMsg: 'canvasToTempFilePath:fail native error' };
  const h = harness({ exportImage(options) { options.fail(failure); } });
  await assert.rejects(h.generate(), error => error.cause === failure);
  assert.deepEqual(h.clears, [[0, 0, 1000, 800]]);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1]);
});
