const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const DEFAULT_IMAGE = '/images/p1.png';
const ORIGINAL_CARD = 'm2.png';
const ORIGINAL_DATE = '2026-11-06';
const ORIGINAL_QUOTE = '留一刻安静，回到此时此地。';
const flush = () => new Promise(resolve => setImmediate(resolve));
const imageSource = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dailyCardImage.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/daily/daily1.js'), 'utf8');

// Each harness has a fresh real image service, like reopening the link after
// WeChat discards its process. Only SDK calls and unrelated services are mocked.
function harness({ date = ORIGINAL_DATE, pickedCard = ORIGINAL_CARD, network = 'online', userName = '发起者' } = {}) {
  let now = 1000;
  let nextTimer = 0;
  let selections = 0;
  let businessDate = date;
  let networkMode = network;
  const timers = new Map();
  const businessListeners = new Set();
  const calls = { cloud: [], downloads: [], users: 0 };
  const setTimer = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const wx = {
    cloud: {
      getTempFileURL(options) {
        const fileID = options.fileList[0];
        calls.cloud.push(fileID);
        if (networkMode === 'timeout') return;
        if (networkMode === 'cloud-failure') return options.fail(new Error('offline'));
        const filename = fileID.split('/').pop();
        options.success({ fileList: [{ status: 0, tempFileURL: `https://images.example/${filename}` }] });
      }
    },
    getImageInfo(options) {
      calls.downloads.push(options.src);
      if (networkMode === 'download-failure') return options.fail(new Error('download failed'));
      options.success({ path: `wxfile://downloaded/${options.src.split('/').pop()}` });
    },
    showShareMenu() {}, switchTab() {}, showToast() {}, previewImage() {}
  };
  const imageModule = { exports: {} };
  vm.runInNewContext(imageSource, {
    module: imageModule,
    Date: { now: () => now },
    wx, setTimeout: setTimer, clearTimeout: clearTimer,
    require(request) {
      assert.equal(request, '../config/images.js');
      return {
        DEFAULT_IMAGE,
        DAILY_POKER_CONFIG: { images: ['m1.png', ORIGINAL_CARD, 'SJoker.png'] },
        getImageInfo(filename) { return { filename, fileID: `cloud://configured/${filename}` }; },
        getRandomDailyPokerImage() {
          selections++;
          return { filename: pickedCard, fileID: `cloud://configured/${pickedCard}`, isDefault: false };
        }
      };
    }
  }, { filename: 'dailyCardImage.js' });
  const modules = {
    'dailyCardImage.js': imageModule.exports,
    'dailyShareSession.js': require('../miniprogram/utils/dailyShareSession.js'),
    'lunar.js': { getLunarDate: () => '农历' },
    'checkin.js': {}, 'badgeManager.js': {}, 'homeCheckin.js': {},
    'dateUtil.js': {
      getBusinessDate: () => businessDate,
      watchBusinessDate(callback) { businessListeners.add(callback); return () => businessListeners.delete(callback); }
    },
    'dailyWisdom.js': {
      DEFAULT_QUOTE: ORIGINAL_QUOTE,
      watchDailyWisdom(callback) { callback({ content: ORIGINAL_QUOTE }); return () => {}; }
    },
    'dailyShareCover.js': { generateDailyShareCover: () => Promise.resolve('wxfile://share-cover.png') },
    'dailyPoster.js': { generateDailyPoster: () => Promise.resolve('wxfile://poster.png') }
  };
  function makePage() {
    let definition;
    vm.runInNewContext(pageSource, {
      Page(value) { definition = value; },
      require(request) {
        const name = path.basename(request);
        assert.ok(Object.hasOwn(modules, name), request);
        return modules[name];
      },
      wx, setTimeout: setTimer, clearTimeout: clearTimer,
      console: { log() {}, warn() {}, error() {} }
    }, { filename: 'daily1.js' });
    return {
      ...definition,
      data: structuredClone(definition.data),
      setData(values, callback) { Object.assign(this.data, values); callback?.(); },
      getUserData() { calls.users++; this.setData({ userName }); }
    };
  }
  return {
    calls, makePage,
    get selections() { return selections; },
    open(options = {}) {
      const page = makePage();
      page.onLoad(options);
      page.onShow();
      page.onReady();
      return page;
    },
    setNetwork(mode) { networkMode = mode; },
    changeDate(value) {
      businessDate = value;
      for (const callback of businessListeners) callback(value);
    },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
      await flush();
    }
  };
}

function shareOptions(page, channel = 'friend') {
  const query = channel === 'friend'
    ? page.onShareAppMessage().path.split('?')[1]
    : page.onShareTimeline().query;
  return Object.fromEntries(new URLSearchParams(query));
}

function assertOriginal(page, options) {
  assert.equal(page.data.displayImage, `wxfile://downloaded/${ORIGINAL_CARD}`);
  assert.equal(options.card, ORIGINAL_CARD);
  assert.equal(options.date, ORIGINAL_DATE);
  assert.equal(options.quote, `q1:${ORIGINAL_QUOTE}`);
}

for (const channel of ['friend', 'timeline']) {
  test(`${channel} link preserves the original card across cold opens, days and forwarding chains`, async () => {
    const sender = harness();
    const original = sender.open();
    await flush();
    const initialOptions = shareOptions(original, channel);
    assertOriginal(original, initialOptions);
    assert.equal(sender.selections, 1);
    original.onUnload();

    for (const date of [ORIGINAL_DATE, ORIGINAL_DATE, '2026-11-07', '2027-01-01']) {
      const recipient = harness({ date, pickedCard: 'SJoker.png' });
      const received = recipient.open(initialOptions);
      await flush();
      assertOriginal(received, shareOptions(received, channel));
      assert.equal(recipient.selections, 0, 'opening the same link must never draw a card');
      assert.deepEqual(recipient.calls.cloud, [`cloud://configured/${ORIGINAL_CARD}`]);
      assert.equal(recipient.calls.users, 0);
      recipient.changeDate('2027-01-02');
      received.onHide();
      received.onShow();
      assertOriginal(received, shareOptions(received, channel));
      received.onUnload();
    }

    let forwarded = initialOptions;
    for (let hop = 0; hop < 3; hop++) {
      const recipient = harness({ date: '2026-12-01', pickedCard: 'm1.png' });
      const received = recipient.open(forwarded);
      await flush();
      forwarded = shareOptions(received, hop % 2 ? 'friend' : 'timeline');
      assertOriginal(received, forwarded);
      assert.equal(recipient.selections, 0);
      received.onUnload();
    }
  });
}

for (const failure of ['cloud-failure', 'download-failure', 'timeout']) {
  test(`a shared card retains its identity after ${failure} and can be forwarded or retried`, async () => {
    const sender = harness();
    const original = sender.open();
    await flush();
    const initialOptions = shareOptions(original);
    const recipient = harness({ network: failure, pickedCard: 'SJoker.png' });
    const received = recipient.open(initialOptions);
    await flush();
    if (failure === 'timeout') await recipient.advance(5000);
    for (const channel of ['friend', 'timeline']) {
      const forwarded = shareOptions(received, channel);
      assert.equal(forwarded.card, ORIGINAL_CARD);
      const recovered = harness({ pickedCard: 'm1.png' });
      const reopened = recovered.open(forwarded);
      await flush();
      assertOriginal(reopened, shareOptions(reopened));
      assert.equal(recovered.selections, 0);
      reopened.onUnload();
    }
    recipient.setNetwork('online');
    received.retryDailyImage();
    await flush();
    assertOriginal(received, shareOptions(received));
    assert.equal(recipient.selections, 0);
    assert.ok(recipient.calls.cloud.every(fileID => fileID === `cloud://configured/${ORIGINAL_CARD}`));
    received.onUnload();
    original.onUnload();
  });
}

for (const isShared of [false, true]) {
  test(`an image binderror preserves the ${isShared ? 'received' : 'sender'} card through sharing and retry`, async () => {
    const h = harness();
    const page = h.open(isShared ? {
      shared: '1', card: ORIGINAL_CARD, date: ORIGINAL_DATE, quote: `q1:${ORIGINAL_QUOTE}`
    } : {});
    await flush();
    page.fallbackToDefaultImage();
    assert.equal(shareOptions(page).card, ORIGINAL_CARD);
    assert.equal(shareOptions(page, 'timeline').card, ORIGINAL_CARD);
    page.retryDailyImage();
    await flush();
    assertOriginal(page, shareOptions(page));
    assert.equal(h.selections, isShared ? 0 : 1);
    assert.ok(h.calls.cloud.every(fileID => fileID === `cloud://configured/${ORIGINAL_CARD}`));
    page.onUnload();
  });
}

test('sharing synchronously after first load already includes the originally selected card', async () => {
  const h = harness();
  const page = h.makePage();
  page.onLoad({});
  assert.equal(h.calls.cloud.length, 0, 'SDK work remains asynchronous');
  assert.equal(h.selections, 1);
  assert.equal(shareOptions(page).card, ORIGINAL_CARD);
  assert.equal(shareOptions(page, 'timeline').card, ORIGINAL_CARD);
  await flush();
  assertOriginal(page, shareOptions(page));
  page.onUnload();
});

test('a card query without the shared flag opens that card without selecting another', async () => {
  const h = harness({ pickedCard: 'SJoker.png', date: '2026-12-01' });
  const page = h.open({ card: ORIGINAL_CARD, date: ORIGINAL_DATE, quote: `q1:${ORIGINAL_QUOTE}` });
  await flush();
  assertOriginal(page, shareOptions(page));
  assert.equal(h.selections, 0);
  assert.equal(h.calls.users, 0);
  page.onUnload();
});

test('a sender download failure and later image refreshes never draw a replacement card', async () => {
  const h = harness({ network: 'download-failure' });
  const page = h.open();
  await flush();
  assert.equal(shareOptions(page).card, ORIGINAL_CARD);
  h.setNetwork('online');
  page.retryDailyImage();
  await flush();
  assertOriginal(page, shareOptions(page));
  await page.preloadRandomImage();
  await page.getRandomImage();
  assertOriginal(page, shareOptions(page));
  assert.equal(h.selections, 1);
  page.onUnload();
});

test('completion metadata is captured once and survives recipients with different names and dates', async () => {
  const endedAt = Date.parse('2026-11-07T01:00:00+08:00');
  const sender = harness({ userName: '秋水%25🌱', date: '2026-11-06' });
  const original = sender.open({ completedAt: String(endedAt), minutes: '17' });
  await flush();
  assert.equal(original.data.session.dateLabel, '2026.11.07');
  assert.equal(original.data.session.timeLabel, '01:00');
  original.setData({ userName: '后来修改的昵称', totalMinutes: 90 });
  let options = shareOptions(original);
  assert.equal(options.name, 'n1:秋水%25🌱');
  assert.equal(options.at, String(endedAt));
  assert.equal(options.minutes, '17');
  const expectedSession = structuredClone(original.data.session);
  for (const channel of ['timeline', 'friend']) {
    const recipient = harness({ date: '2027-01-01', userName: '接收者' });
    const page = recipient.open(options);
    await flush();
    assert.deepEqual(page.data.session, expectedSession);
    options = shareOptions(page, channel);
    assert.equal(options.name, 'n1:秋水%25🌱');
    assert.equal(options.at, String(endedAt));
    assert.equal(options.minutes, '17');
    assert.equal(recipient.calls.users, 0);
    page.onUnload();
  }
  original.onUnload();
});
