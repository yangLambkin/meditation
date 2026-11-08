const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage(name, { account = 'local_guest', appMode = 'available', storageErrorKey } = {}) {
  let definition;
  let tabReady = false;
  const storage = { userOpenId: account };
  const calls = { applied: 0, dots: [], refresh: [], migrations: [], homeRefresh: 0, teamRefresh: 0,
    tabSync: [], timerScreen: 0, timerAudio: 0 };
  const app = {
    syncTabBar(page) { calls.tabSync.push(page); },
    applySyncAlertDot() {
      calls.applied++;
      // The initial route can show before the native tab bar accepts updates.
      if (tabReady) calls.dots.push(true);
    },
    refreshSyncAlert(options) {
      calls.refresh.push({ options: { ...options }, account: storage.userOpenId,
        profile: storage.userInfo && { ...storage.userInfo }, login: storage.userLoginData && { ...storage.userLoginData } });
      return Promise.resolve();
    }
  };
  const context = {
    Page(value) { definition = value; },
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    wx: {
      getStorageSync: key => storage[key],
      setStorageSync(key, value) {
        if (key === storageErrorKey) throw new Error('storage unavailable');
        storage[key] = value;
      }
    },
    require(module) {
      if (module.endsWith('/practiceEntry.js')) return { recordsVisible: () => false };
      if (module.endsWith('/homeBackfill.js')) return { data: {}, methods: { initHomeBackfill() {}, stopHomeBackfill() {}, refreshBackfillSelection() {} } };
      if (module.endsWith('/bijingRecordSync.js')) return { getDayState: () => null, subscribe: () => () => {} };
      if (module.endsWith('/dailyWisdom.js')) return { DEFAULT_QUOTE: '', watchDailyWisdom: () => () => {} };
      if (module.endsWith('/dateUtil.js')) return { watchBusinessDate: () => () => {} };
      if (module.endsWith('/badgeManager.js')) return { migrateBadges: (...args) => calls.migrations.push(args) };
      if (module.endsWith('/profileCache.js')) return {
        currentAccount: () => storage.userOpenId,
        isCurrentAccount: expected => expected === storage.userOpenId,
        updateProfile(profile) {
          if (storageErrorKey === 'userInfo') throw new Error('storage unavailable');
          storage.userInfo = { ...profile };
          storage.userNickname = profile.nickName;
          return storage.userInfo;
        }
      };
      return {};
    }
  };
  if (appMode !== 'missing') context.getApp = () => appMode === 'null' ? null : appMode === 'empty' ? {} : app;
  const file = path.join(__dirname, name === 'timer'
    ? '../miniprogram/modules/timer/definition.js'
    : `../miniprogram/pages/${name}/${name}.js`);
  if (name === 'timer') context.module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  if (name === 'timer') {
    definition = context.module.exports.createPage({ api: context.wx, app: context.getApp?.() });
  }
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values, callback) { Object.assign(this.data, values); if (callback) callback(); } };
  if (name === 'index') {
    for (const method of ['refreshCheckinDefaults', 'refreshCheckinRecords', 'checkUserInfoStatus', 'generateCalendar',
      'refreshPageData', 'saveBasicUserToCloud', 'saveUserToCloud']) page[method] = () => {};
    page.hasUserInfo = () => false;
    page.refreshCheckinsFromCloud = () => { calls.homeRefresh++; return Promise.resolve('home refreshed'); };
  }
  if (name === 'timer') {
    page.setKeepScreenOn = () => { calls.timerScreen++; };
    page.resumeInterruptedAudio = () => { calls.timerAudio++; };
  }
  if (name === 'team') {
    page.getUserInfo = () => {};
    page.loadTeamData = () => { calls.teamRefresh++; return Promise.resolve('team refreshed'); };
  }
  return { page, storage, calls, ready() { tabReady = true; } };
}

for (const name of ['index', 'team']) {
  test(`${name} reapplies cached reminders when its tab is ready and shown again without requesting alerts`, async () => {
    const { page, calls, ready } = createPage(name);
    await page.onShow();
    assert.equal(calls.applied, 1);
    assert.deepEqual(calls.dots, []);
    ready();
    page.onReady();
    assert.deepEqual(calls.dots, [true], 'ready redraws the reminder missed during initial route creation');
    await page.onShow();
    assert.deepEqual(calls.dots, [true, true], 'returning from another page redraws the cached reminder');
    assert.deepEqual(calls.tabSync, [page, page, page], 'each tab synchronizes its own page on show and ready');
    assert.deepEqual(calls.refresh, [], 'tab redraws introduce no alert requests or polling');
    if (name === 'index') assert.equal(calls.homeRefresh, 2);
    if (name === 'team') assert.equal(calls.teamRefresh, 2);
  });

  test(`${name} lifecycle remains compatible when the app or reminder API is unavailable`, async () => {
    for (const appMode of ['missing', 'null', 'empty']) {
      const { page, calls } = createPage(name, { appMode });
      await page.onShow();
      assert.doesNotThrow(() => page.onReady());
      assert.equal(calls.applied, 0);
    }
  });
}

test('the historical timer reapplies cached reminder dots without syncing tab bars or requesting reminders', async () => {
  for (const appMode of ['available', 'missing', 'null', 'empty']) {
    const { page, calls, ready } = createPage('timer', { appMode });
    await page.onShow();
    ready();
    if (page.onReady) page.onReady();
    await page.onShow();
    assert.equal(page.isPageVisible, true);
    assert.equal(calls.timerScreen, 2, 'timer screen handling still runs on each show');
    assert.equal(calls.timerAudio, 2, 'timer audio handling still runs on each show');
    assert.deepEqual(calls.tabSync, []);
    assert.equal(calls.applied, appMode === 'available' ? 3 : 0);
    assert.deepEqual(calls.dots, appMode === 'available' ? [true, true] : []);
    assert.deepEqual(calls.refresh, []);
  }
});

test('successful profile login refreshes reminders after the new account and profile are stored', () => {
  const { page, calls, storage } = createPage('profile');
  page.saveToLocalStorage({ nickName: '登录用户' }, 'oz-user');
  assert.equal(calls.refresh.length, 1);
  assert.deepEqual(calls.refresh[0].options, { force: true });
  assert.equal(calls.refresh[0].account, 'oz-user');
  assert.equal(calls.refresh[0].profile.nickName, '登录用户');
  assert.equal(calls.refresh[0].login.openid, 'oz-user');
  assert.equal(storage.userOpenId, 'oz-user');
  assert.deepEqual(calls.migrations, [['local_guest', 'oz-user']]);
  page.saveToLocalStorage({ nickName: '修改昵称' }, 'oz-user');
  assert.equal(calls.refresh.length, 1, 'editing the existing profile does not trigger an account refresh');
});

test('rejected or incomplete profile storage cannot report a successful login reminder refresh', () => {
  const wrongAccount = createPage('profile');
  assert.throws(() => wrongAccount.page.saveToLocalStorage({ nickName: '用户' }, 'oz-user', 'other'), /账号已切换/);
  assert.equal(wrongAccount.calls.refresh.length, 0);
  for (const storageErrorKey of ['userOpenId', 'userInfo', 'userLoginData']) {
    const { page, calls } = createPage('profile', { storageErrorKey });
    assert.throws(() => page.saveToLocalStorage({ nickName: '用户' }, 'oz-user'), /storage unavailable/);
    assert.equal(calls.refresh.length, 0);
  }
});

for (const method of ['saveBasicUserInfo', 'saveUserInfo']) {
  test(`${method} refreshes reminders only after a different account is stored`, () => {
    const { page, calls } = createPage('index');
    const save = account => method === 'saveUserInfo'
      ? page[method]({ nickName: '登录用户' }, account) : page[method](account);
    save('oz-user');
    assert.equal(calls.refresh.length, 1);
    assert.deepEqual(calls.refresh[0].options, { force: true });
    assert.equal(calls.refresh[0].account, 'oz-user');
    if (method === 'saveUserInfo') {
      assert.equal(calls.refresh[0].profile.nickName, '登录用户');
      assert.equal(calls.refresh[0].login.openid, 'oz-user');
    }
    save('oz-user');
    assert.equal(calls.refresh.length, 1);
  });
}

test('initial guest identity reapplies reminder identity checks without another cloud refresh', async () => {
  const { page, storage, calls } = createPage('index', { account: '' });
  await page.getUserOpenId();
  assert.match(storage.userOpenId, /^local_/);
  assert.equal(calls.applied, 1);
  assert.deepEqual(calls.refresh, []);
  await page.getUserOpenId();
  assert.equal(calls.applied, 1, 'reusing the same identity does not duplicate the initialization hook');
});

test('account persistence remains compatible without the app or reminder API', async () => {
  for (const appMode of ['missing', 'null', 'empty']) {
    const profile = createPage('profile', { appMode });
    assert.doesNotThrow(() => profile.page.saveToLocalStorage({ nickName: '用户' }, 'oz-user'));
    const home = createPage('index', { appMode, account: '' });
    await home.page.getUserOpenId();
    assert.doesNotThrow(() => home.page.saveBasicUserInfo('oz-first'));
    assert.doesNotThrow(() => home.page.saveUserInfo({ nickName: '用户' }, 'oz-second'));
    assert.equal(home.storage.userOpenId, 'oz-second');
  }
});
