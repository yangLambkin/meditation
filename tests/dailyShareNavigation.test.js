const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CARD_ROUTE = '/pages/daily/daily1';
const HOME_ROUTE = '/pages/index/index';
const pageSource = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/daily/daily1.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let route = CARD_ROUTE;
  const calls = { navigation: [], users: 0, sharedCards: [], cloudInit: 0 };
  const listeners = new Set();
  const navigate = (kind, options) => {
    calls.navigation.push({ kind, url: options.url });
    route = options.url.split('?')[0];
  };
  const wx = {
    cloud: { init() { calls.cloudInit++; } },
    showShareMenu() {},
    switchTab: options => navigate('switchTab', options),
    navigateTo: options => navigate('navigateTo', options),
    redirectTo: options => navigate('redirectTo', options),
    reLaunch: options => navigate('reLaunch', options)
  };
  const watch = callback => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const image = key => ({ key, path: `wxfile://${key}`, promise: Promise.resolve(`wxfile://${key}`) });
  const modules = {
    'dailyShareSession.js': require('../miniprogram/utils/dailyShareSession.js'),
    'lunar.js': { getLunarDate: () => '农历' },
    'checkin.js': {}, 'badgeManager.js': {}, 'homeCheckin.js': {},
    'dateUtil.js': { getBusinessDate: () => '2026-11-06', watchBusinessDate: watch },
    'dailyWisdom.js': { DEFAULT_QUOTE: '心安即归处。', watchDailyWisdom: watch },
    'dailyCardImage.js': {
      DEFAULT_IMAGE: '/images/p1.png',
      normalizeImageKey: key => ['m1.png', 'm2.png'].includes(key) ? key : 'local',
      takeNextImage: () => image('m2.png'),
      takeSharedImage(key) { calls.sharedCards.push(key); return image(key); }
    }
  };
  function makePage(options = {}) {
    let definition;
    vm.runInNewContext(pageSource, {
      Page(value) { definition = value; },
      require(request) {
        const name = path.basename(request);
        assert.ok(Object.hasOwn(modules, name), request);
        return modules[name];
      },
      wx, setTimeout, clearTimeout,
      console: { log() {}, warn() {}, error() {} }
    });
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(values) { Object.assign(this.data, values); },
      getUserData() { calls.users++; }
    };
    page.onLoad(options);
    page.onShow();
    return page;
  }
  function makeApp() {
    let definition;
    vm.runInNewContext(appSource, {
      App(value) { definition = value; },
      require(request) { assert.equal(request, './utils/checkin.js'); return {}; },
      wx,
      console: { log() {}, warn() {}, error() {} }
    });
    const app = { ...definition };
    // These independent services are unrelated to route selection. Execute
    // the real launch/show handlers while keeping their background work inert.
    for (const name of ['setupTimerAudioInterruption', 'setupRecordRefresh', 'resumePracticeRecords',
      'setupCacheStatus', 'testCloudEnvironment', 'setAudioOptions', 'flushDetachedCountupExit',
      'refreshTabBars', 'startSyncAlertRefresh', 'refreshRecordBackups', 'resumeRecordBackups']) {
      app[name] = () => {};
    }
    return app;
  }
  return {
    calls, listeners, makePage, makeApp,
    get route() { return route; },
    nativeEntry(url) {
      route = url.split('?')[0];
      return Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
    }
  };
}

test('a friend share launches directly into its card on a cold app without an intermediate home navigation', async () => {
  const sender = harness();
  const source = sender.makePage();
  const share = source.onShareAppMessage();
  await share.promise;
  assert.equal(share.path.split('?')[0], CARD_ROUTE);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(config.pages.includes(CARD_ROUTE.slice(1)));
  assert.ok(!config.tabBar.list.some(tab => tab.pagePath === CARD_ROUTE.slice(1)));

  const recipient = harness();
  const options = recipient.nativeEntry(share.path);
  const launch = { scene: 1007, path: CARD_ROUTE.slice(1), query: options };
  const app = recipient.makeApp();
  app.onLaunch(launch);
  await app.onShow(launch);
  const received = recipient.makePage(options);
  await flush();
  assert.equal(recipient.route, CARD_ROUTE);
  assert.deepEqual(recipient.calls.navigation, []);
  assert.equal(recipient.calls.cloudInit, 1);
  assert.deepEqual(recipient.calls.sharedCards, ['m2.png']);
  assert.equal(recipient.calls.users, 0);
  assert.equal(received.data.displayImage, 'wxfile://m2.png');
  received.onUnload();
  source.onUnload();
});

for (const oldPageKind of ['own', 'shared']) {
  for (const unloadOrder of ['before', 'after']) {
    test(`unloading an old ${oldPageKind} card ${unloadOrder} the new share loads cannot redirect it home`, async () => {
      const h = harness();
      const oldPage = h.makePage(oldPageKind === 'shared'
        ? { shared: '1', card: 'm1.png', date: '2026-11-05', quote: 'q1:旧卡' } : {});
      oldPage.onHide();
      const options = h.nativeEntry(`${CARD_ROUTE}?shared=1&card=m2.png&date=2026-11-06&quote=q1%3Anew`);
      if (unloadOrder === 'before') oldPage.onUnload();
      const newPage = h.makePage(options);
      if (unloadOrder === 'after') oldPage.onUnload();
      await flush();
      assert.equal(h.route, CARD_ROUTE);
      assert.deepEqual(h.calls.navigation, [], 'page cleanup must not launch another navigation');
      assert.equal(oldPage._isUnloaded, true);
      assert.equal(newPage.data.displayImage, 'wxfile://m2.png');
      assert.equal(newPage.data.wisdomQuote, 'new');
      newPage.onUnload();
      assert.equal(h.listeners.size, 0);
    });
  }
}

test('an explicit back action opens home once and subsequent page cleanup does not navigate again', () => {
  const h = harness();
  const page = h.makePage({ shared: '1', card: 'm1.png' });
  page.onBack();
  assert.equal(h.route, HOME_ROUTE);
  assert.deepEqual(h.calls.navigation, [{ kind: 'switchTab', url: HOME_ROUTE }]);
  page.onUnload();
  assert.deepEqual(h.calls.navigation, [{ kind: 'switchTab', url: HOME_ROUTE }]);
  assert.equal(h.listeners.size, 0);
});
