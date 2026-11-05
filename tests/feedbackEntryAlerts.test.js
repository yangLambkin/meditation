const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const adminData = active => ({ isAdmin: active, hasErrors: false, hasFeedback: active });

// Load the real application and Me page together. Only unrelated profile and
// business-day loading is stubbed; each alert source completes independently.
function entryHarness(t) {
  let app, definition;
  const storage = { userOpenId: 'oz-owner' };
  const requests = [], profileRequests = [], tabDots = [], timers = new Set();
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    showTabBarRedDot({ index }) { assert.equal(index, 3); tabDots.push(true); },
    hideTabBarRedDot({ index }) { assert.equal(index, 3); tabDots.push(false); },
    hideLoading() {},
    cloud: { callFunction(options) {
      assert.ok(['getSyncAlert', 'getFeedbackAlert'].includes(options.data.type));
      requests.push({ ...options, account: storage.userOpenId, answered: false });
    } }
  };
  const context = {
    wx,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    ...context, App(value) { app = value; }, require: () => ({})
  });
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/me/me.js'), 'utf8'), {
    ...context, Page(value) { definition = value; }, getApp: () => app,
    require(name) {
      if (name.endsWith('/dateUtil.js')) return { watchBusinessDate: () => () => {} };
      if (name.endsWith('/profileCache.js')) return {
        currentAccount: () => storage.userOpenId,
        isCurrentAccount: account => account === storage.userOpenId
      };
      if (name.endsWith('/checkin.js')) return { isUserLoggedIn: () => !!storage.userOpenId };
      if (name.endsWith('/cloudApi.js')) return { callCloudFunction(name, data) {
        assert.equal(name, 'meditationManager');
        assert.equal(data.type, 'getUserProfile');
        return new Promise(resolve => profileRequests.push({ resolve, answered: false }));
      } };
      return {};
    }
  });
  const pages = [];
  function createPage({ loadBindingProfile = false } = {}) {
    const changes = [], profiles = [];
    const page = { ...definition, data: structuredClone(definition.data),
      setData(value) { changes.push(plain(value)); Object.assign(this.data, value); },
      getUserData() {
        return loadBindingProfile ? this.loadBijingStatus() : new Promise(resolve => profiles.push(resolve));
      }
    };
    const view = { page, changes, profiles };
    pages.push(view);
    return view;
  }
  function reply(type, data, account = storage.userOpenId) {
    const request = requests.find(item => !item.answered && item.data.type === type && item.account === account);
    assert.ok(request, `expected an outstanding ${type} request for ${account}`);
    assert.equal(request.name, type === 'getSyncAlert' ? 'adminManager' : 'meditationManager');
    request.answered = true;
    request.success({ result: { success: true, data } });
  }
  function replyProfile(data) {
    const request = profileRequests.find(item => !item.answered);
    assert.ok(request, 'expected an outstanding profile request');
    request.answered = true;
    request.resolve({ result: { success: true, data } });
  }
  async function respond({ admin = false, user = false } = {}, account = storage.userOpenId) {
    const pending = app._syncAlertRequest;
    reply('getSyncAlert', adminData(admin), account);
    reply('getFeedbackAlert', { hasUnreadFeedback: user }, account);
    await pending;
    await flush();
  }
  async function seed(state) {
    app.startSyncAlertRefresh();
    await respond(state);
  }
  t.after(async () => {
    pages.forEach(({ page }) => page.onUnload());
    app.onHide();
    await flush();
    assert.equal(timers.size, 0, 'no alert timeout remains after leaving the application');
  });
  return { app, storage, requests, tabDots, createPage, reply, replyProfile, respond, seed };
}

function assertEntries(page, { admin, user }) {
  assert.equal(page.data.hasUnreadFeedback, user, 'Submit feedback follows the personal unread source');
  assert.equal(page.data.hasAdminAlert, admin, 'Version follows the administrator source');
}

for (const [name, state] of [
  ['a user with an unread processing result', { admin: false, user: true }],
  ['an administrator with pending feedback', { admin: true, user: false }],
  ['an administrator who also has an unread personal result', { admin: true, user: true }]
]) {
  test(`Me restores the correct entry dots for ${name} without extra alert requests`, async t => {
    const harness = entryHarness(t);
    await harness.seed(state);
    const { page, profiles } = harness.createPage();
    page.onShow();
    assertEntries(page, state);
    assert.deepEqual(plain(harness.app.getSyncAlertState()), state);
    assert.equal(harness.tabDots.at(-1), true);
    assert.equal(harness.requests.length, 2, 'subscribing only reads the existing cache');
    page.onReady();
    assert.equal(harness.requests.length, 2, 'ready only reapplies cached alerts');

    profiles[0]();
    await flush();
    assert.equal(harness.requests.length, 2, 'profile completion reuses the application opening snapshot');
    assertEntries(page, state);
    for (let visit = 0; visit < 3; visit++) {
      page.onHide();
      page.onShow();
      profiles.at(-1)();
      await flush();
      assertEntries(page, state);
      assert.equal(harness.requests.length, 2, 'repeated tab visits do not query either reminder source');
    }
  });
}

for (const alertFirst of [true, false]) {
  for (const existingBinding of [false, true]) {
    test(`binding profile hydration preserves ${alertFirst ? 'completed' : 'pending'} opening reminders with ${existingBinding ? 'changed' : 'initial'} local binding`, async t => {
      const harness = entryHarness(t);
      harness.app.startSyncAlertRefresh();
      if (alertFirst) await harness.respond({ admin: true, user: true });
      const { page } = harness.createPage({ loadBindingProfile: true });
      if (existingBinding) Object.assign(page.data, {
        bijingBound: true, bijingStudentNumber: 'BJ-old', bijingBindingVersion: 'old', bijingIsAdmin: true
      });
      page.onShow();
      harness.replyProfile({ bijingBound: true, bijingStudentNumber: 'BJ-new', bijingBindingVersion: 'new' });
      await flush();
      if (!alertFirst) await harness.respond({ admin: true, user: true });
      assertEntries(page, { admin: true, user: true });
      assert.equal(page.data.bijingIsAdmin, false, 'local navigation access is still reset until explicitly checked');
      assert.equal(page.data.bijingStudentNumber, 'BJ-new');
      assert.equal(harness.requests.length, 2, 'profile loading neither invalidates nor repeats the opening query');
    });
  }
}

for (const profile of [
  { bijingBound: false, bijingStudentNumber: '' },
  { bijingBound: true, bijingStudentNumber: '  ' }
]) {
  test(`profile without a valid binding clears only the administrator reminder: ${JSON.stringify(profile)}`, async t => {
    const harness = entryHarness(t);
    await harness.seed({ admin: true, user: true });
    const { page } = harness.createPage({ loadBindingProfile: true });
    page.onShow();
    harness.replyProfile(profile);
    await flush();
    assertEntries(page, { admin: false, user: true });
    assert.equal(page.data.bijingBound, false);
    assert.equal(harness.tabDots.at(-1), true);
    assert.equal(harness.requests.length, 2, 'permission revocation only clears the local administrator source');
  });
}

test('a revoked binding blocks a pending administrator alert without losing personal results', async t => {
  const harness = entryHarness(t);
  harness.app.startSyncAlertRefresh();
  const { page } = harness.createPage({ loadBindingProfile: true });
  page.onShow();
  harness.replyProfile({ bijingBound: false, bijingStudentNumber: '' });
  await flush();
  await harness.respond({ admin: true, user: true });
  assertEntries(page, { admin: false, user: true });
  assert.equal(harness.requests.length, 2);
});

test('independent cloud responses update both entries while Me remains visible', async t => {
  const harness = entryHarness(t);
  harness.app.startSyncAlertRefresh();
  const { page } = harness.createPage();
  page.onShow();
  assertEntries(page, { admin: false, user: false });
  harness.reply('getFeedbackAlert', { hasUnreadFeedback: true });
  await flush();
  assertEntries(page, { admin: false, user: true });
  assert.equal(harness.tabDots.at(-1), true);
  harness.reply('getSyncAlert', adminData(true));
  await flush();
  assertEntries(page, { admin: true, user: true });
  assert.equal(harness.requests.length, 2);

  harness.app.clearAdminSyncAlert();
  assertEntries(page, { admin: false, user: true });
  assert.equal(harness.tabDots.at(-1), true, 'removing administrator access preserves the personal result');
  assert.equal(harness.requests.length, 2, 'scoped clearing is a local state update');
});

test('reading feedback clears its entry while the administrator entry and Me tab remain lit', async t => {
  const harness = entryHarness(t);
  await harness.seed({ admin: true, user: true });
  const { page } = harness.createPage();
  page.onShow();
  const refresh = harness.app.refreshSyncAlert({ force: true });
  harness.reply('getFeedbackAlert', { hasUnreadFeedback: false });
  await flush();
  assertEntries(page, { admin: true, user: false });
  assert.equal(harness.tabDots.at(-1), true, 'administrator work remains while its new query is pending');
  harness.reply('getSyncAlert', adminData(true));
  await refresh;
  assertEntries(page, { admin: true, user: false });
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`${lifecycle} stops entry updates and reentry restores the latest cache`, async t => {
    const harness = entryHarness(t);
    await harness.seed({ admin: true, user: true });
    const first = harness.createPage();
    first.page.onShow();
    first.page[lifecycle]();
    assertEntries(first.page, { admin: false, user: false });
    const changeCount = first.changes.length;
    first.profiles[0]();
    await flush();
    assert.equal(harness.requests.length, 2, 'hidden profile completion cannot refresh alerts');

    harness.app.refreshSyncAlert({ force: true });
    await harness.respond({ admin: false, user: true });
    assert.equal(first.changes.length, changeCount, 'hidden or destroyed pages receive no setData calls');
    assertEntries(first.page, { admin: false, user: false });

    const reopened = lifecycle === 'onHide' ? first : harness.createPage();
    reopened.page.onShow();
    assertEntries(reopened.page, { admin: false, user: true });
    reopened.profiles.at(-1)();
    await flush();
    assert.equal(harness.requests.length, 4, 'reentering restores the latest cache without another query after profile completion');
    harness.app.clearSyncAlert();
    assertEntries(reopened.page, { admin: false, user: false });
    if (lifecycle === 'onUnload') assert.equal(first.changes.length, changeCount);
  });
}

test('switching accounts immediately removes the previous account entry dots', async t => {
  const harness = entryHarness(t);
  await harness.seed({ admin: true, user: true });
  const { page } = harness.createPage();
  page.onShow();
  harness.storage.userOpenId = 'oz-next';
  assert.deepEqual(plain(harness.app.getSyncAlertState()), { admin: false, user: false });
  harness.app.applySyncAlertDot();
  assertEntries(page, { admin: false, user: false });
  assert.equal(harness.tabDots.at(-1), false);

  harness.app.refreshSyncAlert({ force: true });
  await harness.respond({ admin: false, user: true });
  assertEntries(page, { admin: false, user: true });
});

test('Me account cleanup preserves a new account reminder request already started by login', async t => {
  const harness = entryHarness(t);
  await harness.seed({ admin: true, user: true });
  const { page } = harness.createPage({ loadBindingProfile: true });
  page.onShow();
  harness.replyProfile({ bijingBound: true, bijingStudentNumber: 'BJ-old' });
  await flush();
  assert.equal(page._bijingAccount, 'oz-owner');
  page.onHide();

  harness.storage.userOpenId = 'oz-next';
  harness.app.refreshSyncAlert({ force: true });
  page.onShow();
  assertEntries(page, { admin: false, user: false });
  harness.replyProfile({ bijingBound: true, bijingStudentNumber: 'BJ-new' });
  await flush();
  await harness.respond({ admin: true, user: false });
  assertEntries(page, { admin: true, user: false });
  assert.equal(page._bijingAccount, 'oz-next');
  assert.equal(harness.requests.length, 4, 'new account uses its login refresh without a second query from Me');
});

test('previous account responses cannot restore entry dots after an account switch', async t => {
  const harness = entryHarness(t);
  await harness.seed({ admin: true, user: true });
  const { page } = harness.createPage();
  page.onShow();
  const previousRefresh = harness.app.refreshSyncAlert({ force: true });
  harness.storage.userOpenId = 'oz-next';
  harness.reply('getFeedbackAlert', { hasUnreadFeedback: true }, 'oz-owner');
  harness.reply('getSyncAlert', adminData(true), 'oz-owner');
  await previousRefresh;
  assertEntries(page, { admin: false, user: false });
  assert.equal(harness.tabDots.at(-1), false);
});

test('backgrounding the application clears both entry sources for visible subscribers', async t => {
  const harness = entryHarness(t);
  await harness.seed({ admin: true, user: true });
  const { page } = harness.createPage();
  page.onShow();
  harness.app.onHide();
  assertEntries(page, { admin: false, user: false });
  assert.deepEqual(plain(harness.app.getSyncAlertState()), { admin: false, user: false });
  assert.equal(harness.tabDots.at(-1), false);
});
