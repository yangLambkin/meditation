const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createPage({ imagePending, exportPending, generate, coverPending, coverGenerate, manualTimers = false, wxOverrides = {} } = {}) {
  let definition;
  let businessDate = '2026-11-06';
  const timers = new Map();
  let nextTimer = 0;
  const wisdomListeners = new Set();
  const businessListeners = new Set();
  const calls = { menus: [], users: 0, images: [], exports: [], covers: [], saved: [], modals: [],
    settings: [], previews: [], imageShares: [], toasts: [], navigation: [], updates: [] };
  const modules = {
    'dailyShareSession.js': require('../miniprogram/utils/dailyShareSession.js'),
    'lunar.js': { getLunarDate: date => `农历 ${date.getMonth() + 1}/${date.getDate()}` },
    'checkin.js': {}, 'badgeManager.js': {}, 'homeCheckin.js': {},
    'dateUtil.js': {
      getBusinessDate: () => businessDate,
      watchBusinessDate(callback) { businessListeners.add(callback); return () => businessListeners.delete(callback); }
    },
    'dailyWisdom.js': {
      DEFAULT_QUOTE: '静心即是修心，心安即是归处。',
      watchDailyWisdom(callback) { wisdomListeners.add(callback); return () => wisdomListeners.delete(callback); }
    },
    'dailyCardImage.js': {
      DEFAULT_IMAGE: '/images/p1.png',
      normalizeImageKey: key => ['m1.png', 'm2.png'].includes(key) ? key : 'local',
      takeNextImage() { calls.images.push('random'); return imagePending || {
        key: 'm2.png', path: 'wxfile://m2.png', promise: Promise.resolve('wxfile://m2.png')
      }; },
      takeSharedImage(key) { calls.images.push(key); const safe = this.normalizeImageKey(key); return {
        key: safe, path: safe === 'local' ? '/images/p1.png' : `wxfile://${safe}`,
        promise: Promise.resolve(safe === 'local' ? '/images/p1.png' : `wxfile://${safe}`)
      }; }
    },
    'dailyShareCover.js': {
      generateDailyShareCover(page, snapshot) {
        calls.covers.push({ page, snapshot: structuredClone(snapshot) });
        return coverGenerate ? coverGenerate(page, snapshot) : coverPending ? coverPending.promise : Promise.resolve('wxfile://share-cover.png');
      }
    },
    'dailyPoster.js': {
      generateDailyPoster(page, snapshot) {
        calls.exports.push({ page, snapshot: structuredClone(snapshot) });
        return generate ? generate(page, snapshot) : exportPending ? exportPending.promise : Promise.resolve('wxfile://poster.png');
      }
    }
  };
  const wxApi = {
    showShareMenu(options) { calls.menus.push(options); },
    showToast(options) { calls.toasts.push(options); },
    showModal(options) { calls.modals.push(options); },
    openSetting(options) { calls.settings.push(options); },
    previewImage(options) { calls.previews.push(options); options.success?.({}); },
    showShareImageMenu(options) { calls.imageShares.push(options); options.success?.({}); },
    saveImageToPhotosAlbum(options) { calls.saved.push(options); options.success?.({}); options.complete?.({}); },
    getSetting(options) { options.success?.({ authSetting: {} }); },
    switchTab(options) { calls.navigation.push(options.url); },
    ...wxOverrides
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/daily/daily1.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(request) { const name = path.basename(request); assert.ok(Object.hasOwn(modules, name), request); return modules[name]; },
    console: { log() {}, warn() {}, error() {} }, wx: wxApi,
    setTimeout: manualTimers ? (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; } : setTimeout,
    clearTimeout: manualTimers ? id => timers.delete(id) : clearTimeout
  });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values, callback) { calls.updates.push(values); Object.assign(this.data, values); callback?.(); },
    getUserData() { calls.users++; this.setData({ userName: '私人昵称', userAvatar: 'https://private/avatar.png',
      totalCount: 2, totalMinutes: 30, highestLevelBadge: { name: '私人勋章' } }); }
  };
  return { page, calls, wxApi, wisdomListeners, businessListeners, timers,
    fireTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
    publishWisdom(content) { for (const listener of wisdomListeners) listener({ content }); },
    changeBusinessDate(date) { businessDate = date; for (const listener of businessListeners) listener(date); }
  };
}

function optionsFromQuery(query) {
  return Object.fromEntries(new URLSearchParams(query));
}

test('daily card enables native friend and timeline share menus on arrival', () => {
  const h = createPage();
  h.page.onLoad({});
  assert.equal(h.calls.menus.length, 1);
  assert.deepEqual(Array.from(h.calls.menus[0].menus), ['shareAppMessage', 'shareTimeline']);
});

test('friend and timeline shares preserve the displayed card, date and wisdom without profile data', async () => {
  const h = createPage();
  h.page.onLoad({});
  h.page.onShow();
  h.publishWisdom('把心放慢一点，安住于每一次呼吸。');
  await flush();
  const friend = h.page.onShareAppMessage();
  assert.equal(friend.path.split('?')[0], '/pages/daily/daily1');
  const shared = optionsFromQuery(friend.path.split('?')[1]);
  assert.equal(shared.shared, '1');
  assert.equal(shared.card, 'm2.png');
  assert.equal(shared.date, '2026-11-06');
  assert.equal(shared.quote, `q1:${h.page.data.wisdomQuote}`);
  assert.deepEqual(Object.keys(shared).sort(), ['card', 'date', 'quote', 'shared']);
  assert.ok(!friend.path.includes('私人'));
  assert.ok(!friend.path.includes('private'));
  const timeline = h.page.onShareTimeline();
  assert.deepEqual(optionsFromQuery(timeline.query), shared);
  assert.ok(timeline.title.includes('静心卡'));
  assert.equal(friend.title, '送你一张静心卡');
  h.page.onHide();
});

test('opening and resharing a received card keeps its original artwork and day across business-day changes', async () => {
  const h = createPage();
  const quote = '愿你在忙碌里，也有片刻安住。';
  h.page.onLoad({ shared: '1', card: 'm1.png', date: '2026-10-31', quote: encodeURIComponent(quote) });
  h.page.onShow();
  await flush();
  assert.equal(h.page.data.isSharedView, true);
  assert.equal(h.page.data.displayImage, 'wxfile://m1.png');
  assert.equal(h.page.data.year, 2026);
  assert.equal(h.page.data.month, 'October');
  assert.equal(h.page.data.day, 31);
  assert.equal(h.page.data.wisdomQuote, quote);
  assert.equal(h.calls.users, 0, 'shared cards must not read recipient profile or private records');
  assert.deepEqual(h.calls.images, ['m1.png']);
  assert.equal(h.wisdomListeners.size, 0);
  assert.equal(h.businessListeners.size, 0);
  h.changeBusinessDate('2026-11-07');
  h.publishWisdom('新的一天');
  h.page.onHide();
  h.page.onShow();
  assert.equal(h.page.data.day, 31);
  assert.equal(h.page.data.wisdomQuote, quote);
  assert.equal(h.calls.users, 0);
  const reshared = optionsFromQuery(h.page.onShareAppMessage().path.split('?')[1]);
  assert.equal(reshared.date, '2026-10-31');
  assert.equal(reshared.card, 'm1.png');
  assert.equal(reshared.quote, `q1:${quote}`);
  h.page.onHide();
});

test('malformed incoming share data falls back safely and bounds long quote text by characters', async () => {
  const h = createPage();
  h.page.onLoad({ shared: '1', card: 'https://untrusted.test/art.png', date: '2026-02-30',
    quote: encodeURIComponent(`\u0000${'静🌱'.repeat(100)}\n`) });
  await flush();
  assert.equal(h.page.data.displayImage, '/images/p1.png');
  assert.equal(h.page.data.day, 6, 'invalid calendar dates use the business date');
  assert.equal(h.page.data.month, 'November');
  assert.equal(Array.from(h.page.data.wisdomQuote).length, 96);
  assert.ok(h.page.data.wisdomQuote.endsWith('…'));
  assert.ok(!/[\u0000-\u001f]/.test(h.page.data.wisdomQuote));
  const output = optionsFromQuery(h.page.onShareAppMessage().path.split('?')[1]);
  assert.equal(output.card, 'local');
  assert.ok(!h.page.onShareAppMessage().path.includes('untrusted'));
});

test('an image display error preserves the selected card and can retry without drawing again', async () => {
  const h = createPage();
  h.page.onLoad({});
  await flush();
  h.page.fallbackToDefaultImage();
  assert.equal(h.page.data.displayImage, '/images/p1.png');
  assert.equal(h.page.data.imageLoadFailed, true);
  assert.equal(optionsFromQuery(h.page.onShareAppMessage().path.split('?')[1]).card, 'm2.png');
  assert.equal(h.page.onShareTimeline().imageUrl, '/images/daily-share.png');
  h.page.previewDailyCard();
  assert.equal(h.calls.previews.length, 0, 'the fallback poker must not appear in a preview');
  assert.equal(await h.page.saveDailyImage(), false);
  assert.equal(h.calls.exports.length, 0, 'the fallback poker must not replace the original in saved images');
  await h.page.retryDailyImage();
  assert.deepEqual(h.calls.images, ['random', 'm2.png']);
  assert.equal(h.page.data.imageLoadFailed, false);
  assert.equal(h.page.data.displayImage, 'wxfile://m2.png');
});

test('saving the daily card directly writes the rendered image to the album without an extra dialog', async () => {
  const h = createPage();
  h.page.onLoad({});
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.exports.length, 1);
  assert.equal(h.calls.saved.length, 1);
  assert.equal(h.calls.saved[0].filePath, 'wxfile://poster.png');
  assert.equal(h.calls.modals.length, 0);
  assert.equal(h.page.data.isSavingImage, false);
  assert.equal(h.page.data.showPoster, undefined);
  assert.equal(h.calls.toasts[0].title, '图片已保存到相册');
});

test('repeat save taps coalesce into one export and one album write', async () => {
  const pending = deferred();
  const h = createPage({ exportPending: pending });
  h.page.onLoad({});
  const first = h.page.saveDailyImage();
  const second = h.page.saveDailyImage();
  assert.strictEqual(first, second);
  await flush();
  assert.equal(h.page.data.isSavingImage, true);
  assert.equal(h.calls.exports.length, 1);
  assert.equal(h.calls.saved.length, 0);
  pending.resolve('wxfile://saved-daily.png');
  assert.equal(await first, true);
  assert.equal(h.calls.saved.length, 1);
  assert.equal(h.calls.saved[0].filePath, 'wxfile://saved-daily.png');
  assert.equal(h.page.data.isSavingImage, false);
});

test('saving waits for the selected daily artwork and freezes the requested data during export', async () => {
  const image = deferred();
  const output = deferred();
  const h = createPage({ imagePending: { key: 'm2.png', path: null, promise: image.promise }, exportPending: output });
  h.page.onLoad({});
  h.page.setData({ wisdomQuote: '保存时的金句' });
  const saving = h.page.saveDailyImage();
  await flush();
  assert.equal(h.calls.exports.length, 0);
  image.resolve('wxfile://selected-card.png');
  await flush();
  assert.equal(h.calls.exports[0].snapshot.displayImage, 'wxfile://selected-card.png');
  h.page.setData({ wisdomQuote: '之后的金句', totalMinutes: 45 });
  assert.equal(h.calls.exports[0].snapshot.wisdomQuote, '保存时的金句');
  assert.equal(h.calls.exports[0].snapshot.totalMinutes, 30);
  output.resolve('wxfile://frozen.png');
  await saving;
  assert.equal(h.calls.saved[0].filePath, 'wxfile://frozen.png');
});

test('saved image is reused only while the displayed daily card remains unchanged', async () => {
  const h = createPage();
  h.page.onLoad({});
  await h.page.saveDailyImage();
  await h.page.saveDailyImage();
  assert.equal(h.calls.exports.length, 1);
  assert.equal(h.calls.saved.length, 2);
  h.page.setData({ wisdomQuote: '新的金句' });
  await h.page.saveDailyImage();
  assert.equal(h.calls.exports.length, 2);
  h.page.setData({ totalMinutes: 45 });
  await h.page.saveDailyImage();
  assert.equal(h.calls.exports.length, 3);
});

test('export failure allows a direct retry and never saves an unrelated image', async () => {
  let attempts = 0;
  const h = createPage({ generate() { return ++attempts === 1
    ? Promise.reject(new Error('native canvas export failed')) : Promise.resolve('wxfile://retry.png'); } });
  h.page.onLoad({});
  assert.equal(await h.page.saveDailyImage(), false);
  assert.equal(h.page.data.isSavingImage, false);
  assert.equal(h.calls.saved.length, 0);
  assert.equal(h.calls.modals.length, 0, 'failure should not trap users in a large empty preview');
  assert.equal(h.calls.toasts[0].title, '图片保存失败，请重试');
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.saved[0].filePath, 'wxfile://retry.png');
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`a pending image export cannot save after ${lifecycle}`, async () => {
    const pending = deferred();
    const h = createPage({ exportPending: pending });
    h.page.onLoad({});
    h.page.onShow();
    const saving = h.page.saveDailyImage();
    await flush();
    h.page[lifecycle]();
    const updates = h.calls.updates.length;
    pending.resolve('wxfile://late.png');
    assert.equal(await saving, false);
    assert.equal(h.calls.saved.length, 0);
    assert.equal(h.calls.toasts.length, 0);
    if (lifecycle === 'onUnload') assert.equal(h.calls.updates.length, updates);
  });
}

test('shared daily images retain the received card without recipient personal details', async () => {
  const h = createPage();
  h.page.onLoad({ shared: '1', card: 'm1.png', date: '2026-10-31', quote: '同一份安静' });
  await h.page.saveDailyImage();
  const snapshot = h.calls.exports[0].snapshot;
  assert.equal(snapshot.isSharedView, true);
  assert.equal(snapshot.day, 31);
  assert.equal(snapshot.displayImage, 'wxfile://m1.png');
  assert.equal(snapshot.wisdomQuote, '同一份安静');
  for (const field of ['userName', 'userAvatar', 'highestLevelBadge', 'totalCount', 'totalMinutes']) {
    assert.equal(snapshot[field], undefined, field);
  }
  assert.equal(h.calls.users, 0);
  assert.equal(h.calls.saved.length, 1);
});

test('denied album permission opens settings only on confirmation and requires an explicit save retry', async () => {
  let deny = true;
  const h = createPage({ wxOverrides: { saveImageToPhotosAlbum(options) {
    h.calls.saved.push(options);
    if (deny) options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
    else options.success({});
  } } });
  h.page.onLoad({});
  assert.equal(await h.page.saveDailyImage(), false);
  assert.equal(h.calls.modals.length, 1);
  assert.ok(h.calls.modals[0].content.includes('保存图片'));
  assert.equal(h.page.data.isSavingImage, false);
  h.calls.modals[0].success({ confirm: true });
  assert.equal(h.calls.settings.length, 1);
  assert.equal(h.calls.saved.length, 1);
  deny = false;
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.exports.length, 1, 'permission changes do not invalidate the exported picture');
  assert.equal(h.calls.saved.length, 2);
});

test('cancelled album saving stays quiet and releases the save button', async () => {
  const h = createPage({ wxOverrides: { saveImageToPhotosAlbum(options) { options.fail({ errMsg: 'saveImageToPhotosAlbum:fail cancel' }); } } });
  h.page.onLoad({});
  assert.equal(await h.page.saveDailyImage(), false);
  assert.equal(h.page.data.isSavingImage, false);
  assert.equal(h.calls.toasts.length, 0);
  assert.equal(h.calls.modals.length, 0);
});

test('an expired temporary image is drawn again on the next save tap', async () => {
  let fail = false;
  const h = createPage({ wxOverrides: { saveImageToPhotosAlbum(options) {
    h.calls.saved.push(options);
    if (fail) options.fail({ errMsg: 'saveImageToPhotosAlbum:fail file not found' });
    else options.success({});
  } } });
  h.page.onLoad({});
  await h.page.saveDailyImage();
  fail = true;
  assert.equal(await h.page.saveDailyImage(), false);
  fail = false;
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.exports.length, 2);
});

test('promise-returning album SDKs work without triggering duplicate completion messages', async () => {
  const h = createPage({ wxOverrides: { saveImageToPhotosAlbum(options) {
    h.calls.saved.push(options);
    options.success({});
    return Promise.resolve({});
  } } });
  h.page.onLoad({});
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.saved.length, 1);
  assert.equal(h.calls.toasts.length, 1);
});

for (const decoded of [false, true]) {
  test(`shared wisdom preserves literal percent escapes when native query is ${decoded ? 'decoded' : 'encoded'}`, () => {
    const sender = createPage();
    sender.page.onLoad({});
    const quote = '100%25 是原文，%E5%AE%89、%20 与 🌱 都应保留。';
    sender.page.setData({ wisdomQuote: quote });
    const query = sender.page.onShareAppMessage().path.split('?')[1];
    const options = decoded ? optionsFromQuery(query) : Object.fromEntries(query.split('&').map(part => part.split('=')));
    const recipient = createPage();
    recipient.page.onLoad(options);
    assert.equal(recipient.page.data.wisdomQuote, quote);
    const reshared = optionsFromQuery(recipient.page.onShareAppMessage().path.split('?')[1]);
    assert.equal(reshared.quote, `q1:${quote}`);
  });
}

test('legacy cards without a sitting use a neutral title on both share channels', () => {
  const h = createPage();
  h.page.onLoad({});
  h.page.setData({ wisdomQuote: `${'安'.repeat(35)}🌱再安静一点` });
  assert.equal(h.page.onShareAppMessage().title, '送你一张静心卡');
  assert.equal(h.page.onShareTimeline().title, '送你一张静心卡');
});

test('both channels and saved shared images retain the completed sitting and use its session cover', async () => {
  const sender = createPage();
  const endedAt = Date.parse('2026-11-07T01:15:00+08:00');
  sender.page.onLoad({ completedAt: String(endedAt), minutes: '45' });
  sender.page.onReady();
  await flush();
  const friend = sender.page.onShareAppMessage();
  const timeline = sender.page.onShareTimeline();
  assert.equal(friend.title, '私人昵称｜2026.11.07 01:15 收坐 · 静坐45分钟');
  assert.equal(timeline.title, friend.title);
  assert.equal(timeline.imageUrl, friend.imageUrl);
  assert.equal(friend.imageUrl, 'wxfile://share-cover.png');
  const resolved = await friend.promise;
  assert.equal(resolved.path, friend.path, 'the asynchronous share must retain the direct card route');
  assert.equal(resolved.title, friend.title);
  const options = optionsFromQuery(friend.path.split('?')[1]);
  assert.equal(options.at, String(endedAt));
  assert.equal(options.minutes, '45');
  assert.equal(options.name, 'n1:私人昵称');
  const recipient = createPage();
  recipient.page.onLoad(options);
  recipient.page.onShow();
  assert.equal(recipient.calls.users, 0);
  assert.equal(recipient.page.data.session.dateLabel, '2026.11.07', 'session date uses the real Beijing calendar day');
  assert.equal(recipient.page.data.day, 6, 'the original business-day artwork remains fixed');
  await recipient.page.saveDailyImage();
  assert.deepEqual(recipient.calls.exports[0].snapshot.session, structuredClone(sender.page.data.session));
  assert.equal(recipient.calls.exports[0].snapshot.userAvatar, undefined);
  assert.equal(recipient.calls.exports[0].snapshot.totalCount, undefined);
  recipient.page.onHide();
});

test('maximum emoji names and quotes fit in a native launch path without losing session information', () => {
  const h = createPage();
  h.page.getUserData = function() { this.setData({ userName: '🌱'.repeat(30) }); };
  h.page.onLoad({ completedAt: '1793960100000', minutes: '1440' });
  h.page.setData({ wisdomQuote: '🧘'.repeat(96) });
  const shared = h.page.onShareAppMessage();
  assert.ok(shared.path.length <= 1000);
  const options = optionsFromQuery(shared.path.split('?')[1]);
  assert.equal(options.name, `n1:${'🌱'.repeat(20)}`);
  assert.equal(options.minutes, '1440');
  assert.equal(options.at, '1793960100000');
  assert.ok(options.quote.startsWith('q1:'));
  assert.ok(options.quote.isWellFormed());
  const recipient = createPage();
  recipient.page.onLoad(options);
  assert.equal(recipient.page.onShareAppMessage().path, shared.path);
});


test('friend cards always use a landscape cover rather than the displayed poker image', async () => {
  const h = createPage();
  h.page.onLoad({});
  const first = h.page.onShareAppMessage();
  assert.equal(first.imageUrl, '/images/daily-share.png');
  assert.notEqual(first.imageUrl, h.page.data.displayImage);
  assert.equal((await first.promise).imageUrl, '/images/daily-share.png');
  h.page.onShow();
  h.publishWisdom('慢下来，听见内心的声音。');
  h.page.onReady();
  await flush();
  const ready = h.page.onShareAppMessage();
  assert.equal(ready.imageUrl, 'wxfile://share-cover.png');
  assert.equal((await ready.promise).imageUrl, ready.imageUrl);
  assert.equal(h.calls.covers.length, 1);
  assert.deepEqual(h.calls.covers[0].snapshot, { quote: '慢下来，听见内心的声音。', date: '2026-11-06', weekDay: '星期五', session: null });
  assert.equal(h.calls.saved.length, 0);
  h.page.onHide();
});

test('a share tapped before cover preparation finishes receives the ready cover asynchronously', async () => {
  const pending = deferred();
  const h = createPage({ coverPending: pending });
  h.page.onLoad({});
  h.page.onReady();
  await flush();
  const shared = h.page.onShareAppMessage();
  assert.equal(shared.imageUrl, '/images/daily-share.png');
  pending.resolve('wxfile://async-cover.png');
  const resolved = await shared.promise;
  assert.equal(resolved.imageUrl, 'wxfile://async-cover.png');
  assert.equal(resolved.path, shared.path);
  assert.equal(resolved.title, shared.title);
  assert.equal(h.calls.covers.length, 1, 'sharing reuses the in-flight preparation');
});

test('cover failure keeps a polished packaged cover and never interrupts sharing or saving', async () => {
  const h = createPage({ coverGenerate: () => Promise.reject(new Error('native canvas unavailable')) });
  h.page.onLoad({});
  h.page.onReady();
  await flush();
  const shared = h.page.onShareAppMessage();
  assert.equal(shared.imageUrl, '/images/daily-share.png');
  assert.equal((await shared.promise).imageUrl, '/images/daily-share.png');
  assert.ok(shared.path.startsWith('/pages/daily/daily1?'));
  assert.equal(h.calls.toasts.length, 0);
  assert.equal(h.calls.modals.length, 0);
  assert.equal(await h.page.saveDailyImage(), true);
});

test('a slow cover resolves to the bundled fallback before the native three-second deadline', async () => {
  const pending = deferred();
  const h = createPage({ coverPending: pending, manualTimers: true });
  h.page.onLoad({});
  h.page.onReady();
  await flush();
  const shared = h.page.onShareAppMessage();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 2500);
  h.fireTimers();
  assert.equal((await shared.promise).imageUrl, '/images/daily-share.png');
  pending.resolve('wxfile://too-late-cover.png');
  await flush();
  assert.equal(h.page.onShareAppMessage().imageUrl, 'wxfile://too-late-cover.png', 'a late result remains useful for the next share');
  await flush();
  assert.equal(h.timers.size, 0);
});

test('quote updates are serialized and an older cover cannot replace the current one', async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const h = createPage({ coverGenerate: () => ++count === 1 ? first.promise : second.promise });
  h.page.onLoad({});
  h.page.onShow();
  h.publishWisdom('原来的金句');
  h.page.onReady();
  await flush();
  h.publishWisdom('现在的金句');
  await flush();
  assert.equal(h.calls.covers.length, 1, 'one canvas must not render concurrent covers');
  first.resolve('wxfile://old-cover.png');
  await flush();
  assert.equal(h.calls.covers.length, 2);
  assert.equal(h.page.onShareAppMessage().imageUrl, '/images/daily-share.png', 'stale content is never shared as the current quote');
  second.resolve('wxfile://current-cover.png');
  await flush();
  assert.equal(h.page.onShareAppMessage().imageUrl, 'wxfile://current-cover.png');
  assert.equal(h.calls.covers[1].snapshot.quote, '现在的金句');
  h.page.onHide();
});

test('cover preparation remains independent of saving the complete daily image', async () => {
  const pending = deferred();
  const h = createPage({ coverPending: pending });
  h.page.onLoad({});
  h.page.onReady();
  await flush();
  assert.equal(await h.page.saveDailyImage(), true);
  assert.equal(h.calls.covers.length, 1);
  assert.equal(h.calls.exports.length, 1);
  assert.equal(h.calls.saved.length, 1);
  assert.equal(h.calls.saved[0].filePath, 'wxfile://poster.png');
  pending.resolve('wxfile://independent-cover.png');
  await flush();
});

test('an unloaded daily page does not cache a late share cover', async () => {
  const pending = deferred();
  const h = createPage({ coverPending: pending });
  h.page.onLoad({});
  h.page.onReady();
  await flush();
  h.page.onUnload();
  const updates = h.calls.updates.length;
  pending.resolve('wxfile://closed-page-cover.png');
  await flush();
  assert.equal(h.page._shareCoverPath, undefined);
  assert.equal(h.calls.updates.length, updates);
});

test('the packaged fallback has the native friend card 5:4 aspect ratio', () => {
  const png = fs.readFileSync(path.join(__dirname, '../miniprogram/images/daily-share.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 500);
  assert.equal(png.readUInt32BE(20), 400);
});
