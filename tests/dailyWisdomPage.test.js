const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createWisdomStore() {
  let content = '今天，安住于每一次呼吸。';
  const subscribers = new Set();
  const calls = { watch: 0, stop: 0 };
  return {
    DEFAULT_QUOTE: '静心即是修心，心安即是归处。',
    subscribers,
    calls,
    watchDailyWisdom(callback) {
      calls.watch++;
      subscribers.add(callback);
      callback({ content });
      return () => {
        calls.stop++;
        assert.equal(subscribers.delete(callback), true, 'each subscription stops only once');
      };
    },
    publish(nextContent) {
      content = nextContent;
      for (const callback of subscribers) callback({ content });
    }
  };
}

function createPage(name, dailyWisdom) {
  const filename = path.join(__dirname, '../miniprogram/pages', name === 'home' ? 'index/index.js' : 'daily/daily1.js');
  const calls = {};
  const intervals = new Map();
  const timeouts = [];
  const navigation = [];
  let definition;
  let nextTimer = 0;
  const modules = {
    'dailyWisdom.js': dailyWisdom,
    'homeCheckin.js': { getCheckinDay: () => '2026-09-19' },
    'checkin.js': {}, 'contentSec.js': {}, 'lunar.js': {},
    'images.js': {}, 'badgeManager.js': {}, 'dateUtil.js': {}
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    require(request) {
      const dependency = path.basename(request);
      assert.ok(Object.hasOwn(modules, dependency), `Unexpected dependency: ${request}`);
      return modules[dependency];
    },
    console: { log() {}, warn() {}, error() {} },
    wx: {
      cloud: { callFunction() { assert.fail('pages must obtain wisdom through the shared daily service'); } },
      switchTab(options) { navigation.push(options.url); }
    },
    setInterval(callback, milliseconds) {
      const id = ++nextTimer;
      intervals.set(id, { callback, milliseconds });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { timeouts.push(callback); }
  }, { filename });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  };
  for (const method of [
    'refreshCheckinDefaults', 'refreshCheckinRecords', 'checkUserInfoStatus',
    'generateCalendar', 'refreshPageData', 'getUserData', 'setCurrentDateInfo'
  ]) {
    page[method] = () => { calls[method] = (calls[method] || 0) + 1; };
  }
  for (const method of [
    'getUserOpenId', 'checkAndRecoverFromCloud', 'refreshCheckinsFromCloud', 'preloadRandomImage'
  ]) {
    page[method] = async () => { calls[method] = (calls[method] || 0) + 1; };
  }
  return { page, calls, intervals, timeouts, navigation };
}

function displayedQuote(name, content) {
  return name === 'home' ? `"${content}"` : content;
}

test('home and daily card share daily wisdom while preserving loading and refresh behavior', async () => {
  const wisdom = createWisdomStore();
  const home = createPage('home', wisdom);
  const card = createPage('card', wisdom);
  assert.equal(home.page.data.wisdomQuote, displayedQuote('home', wisdom.DEFAULT_QUOTE));
  assert.equal(card.page.data.wisdomQuote, wisdom.DEFAULT_QUOTE);

  home.page.onLoad({});
  card.page.onLoad({});
  for (const callback of [...home.timeouts, ...card.timeouts]) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(home.calls.getUserOpenId, 1);
  assert.equal(home.calls.checkAndRecoverFromCloud, 1);
  assert.equal(home.calls.refreshPageData, 1);
  assert.equal(home.page.data.currentYear, 2026);
  assert.equal(home.page.data.currentMonth, 9);
  assert.equal(card.calls.setCurrentDateInfo, 1);
  assert.equal(card.calls.preloadRandomImage, 1);

  await home.page.onShow();
  card.page.onShow();
  assert.equal(home.page.data.wisdomQuote, displayedQuote('home', card.page.data.wisdomQuote));
  assert.equal(card.page.data.wisdomQuote, '今天，安住于每一次呼吸。');
  assert.equal(home.calls.refreshCheckinRecords, 1);
  assert.equal(home.calls.generateCalendar, 1);
  assert.equal(home.calls.refreshCheckinsFromCloud, 1);
  assert.equal(home.calls.checkUserInfoStatus, 2);
  assert.equal(card.calls.setCurrentDateInfo, 2);
  assert.equal(card.calls.getUserData, 1);
  assert.equal(Array.from(home.intervals.values())[0].milliseconds, 30000);

  wisdom.publish('新的一天，从觉察开始。');
  assert.equal(card.page.data.wisdomQuote, '新的一天，从觉察开始。');
  assert.equal(home.page.data.wisdomQuote, displayedQuote('home', card.page.data.wisdomQuote));
  home.page.onUnload();
  card.page.onUnload();
  assert.equal(wisdom.subscribers.size, 0);
});

for (const name of ['home', 'card']) {
  test(`${name} replaces repeated subscriptions, stops when hidden or unloaded and refreshes on return`, async () => {
    const wisdom = createWisdomStore();
    const { page, intervals, navigation } = createPage(name, wisdom);
    await page.onShow();
    await page.onShow();
    assert.equal(wisdom.calls.watch, 2);
    assert.equal(wisdom.calls.stop, 1);
    assert.equal(wisdom.subscribers.size, 1);
    assert.equal(intervals.size, name === 'home' ? 1 : 0);

    const previousQuote = page.data.wisdomQuote;
    page.onHide();
    page.onHide();
    assert.equal(wisdom.calls.stop, 2);
    assert.equal(wisdom.subscribers.size, 0);
    assert.equal(page._stopWisdomWatch, null);
    assert.equal(intervals.size, 0);
    wisdom.publish('凌晨四点后，开启新的觉察。');
    assert.equal(page.data.wisdomQuote, previousQuote, 'hidden pages no longer receive updates');

    await page.onShow();
    assert.equal(page.data.wisdomQuote, displayedQuote(name, '凌晨四点后，开启新的觉察。'));
    assert.equal(wisdom.subscribers.size, 1);
    page.onUnload();
    assert.equal(wisdom.calls.stop, 3);
    assert.equal(wisdom.subscribers.size, 0);
    assert.equal(page._stopWisdomWatch, null);
    assert.equal(intervals.size, 0);
    assert.deepEqual(navigation, name === 'card' ? ['/pages/index/index'] : []);
    wisdom.publish('这条更新不应再进入已卸载页面。');
    assert.equal(page.data.wisdomQuote, displayedQuote(name, '凌晨四点后，开启新的觉察。'));
  });
}
