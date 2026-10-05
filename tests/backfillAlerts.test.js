const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const sources = {
  admin: ['adminManager', 'getSyncAlert', value => ({ isAdmin: true, hasErrors: value, hasFeedback: false })],
  user: ['meditationManager', 'getFeedbackAlert', value => ({ hasUnreadFeedback: value })],
  backfillUser: ['meditationManager', 'getBackfillAlert', value => ({ hasUnreadBackfill: value })],
  backfillAdmin: ['adminManager', 'adminGetBackfillAlert', value => ({ hasPendingBackfill: value })]
};
const empty = () => ({ admin: false, user: false, backfillUser: false, backfillAdmin: false });

function harness(t) {
  let app, definition, account = 'oz-owner';
  const requests = [], dots = [], navigations = [], pages = [], timers = new Set();
  const wx = {
    getStorageSync: () => account,
    showTabBarRedDot({ index }) { assert.equal(index, 3); dots.push(true); },
    hideTabBarRedDot({ index }) { assert.equal(index, 3); dots.push(false); },
    navigateTo(options) { navigations.push(plain(options)); },
    hideLoading() {},
    cloud: { callFunction(request) {
      assert.ok(Object.values(sources).some(([name, type]) => name === request.name && type === request.data.type));
      requests.push({ ...request, account, answered: false });
    } }
  };
  const context = {
    wx, console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    ...context, App(value) { app = value; }, require: () => ({})
  });
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/me/me.js'), 'utf8'), {
    ...context, Page(value) { definition = value; }, getApp: () => app,
    require(name) {
      if (name.endsWith('/dateUtil.js')) return { watchBusinessDate: () => () => {} };
      return {};
    }
  });
  const getRequest = (source, owner = account) => {
    const request = requests.find(item => item.account === owner && item.data.type === sources[source][1] && !item.answered);
    assert.ok(request, `expected an outstanding ${source} request for ${owner}`);
    request.answered = true;
    return request;
  };
  const result = (source, value, owner) => getRequest(source, owner).success({ result: value });
  const reply = (source, value, owner) => result(source, { success: true, data: sources[source][2](value) }, owner);
  const fail = source => getRequest(source).fail(new Error('service unavailable'));
  async function respond(state = {}, owner = account) {
    const pending = app._syncAlertRequest;
    Object.keys(sources).forEach(source => reply(source, state[source] === true, owner));
    await pending;
  }
  t.after(async () => {
    pages.forEach(page => page.onUnload());
    app.onHide();
    await flush();
    assert.equal(timers.size, 0, 'no request deadlines remain after hiding');
  });
  return {
    app, requests, dots, timers, navigations, result, reply, fail, respond,
    state: () => plain(app.getSyncAlertState({ includeBackfill: true })),
    setAccount(value) { account = value; },
    createPage() {
      const page = { ...definition, data: structuredClone(definition.data),
        setData(value) { Object.assign(this.data, value); }, getUserData() {} };
      pages.push(page);
      return page;
    }
  };
}

test('the legacy alert state stays compatible while subscribers receive all four sources', t => {
  const view = harness(t);
  assert.deepEqual(plain(view.app.getSyncAlertState()), { admin: false, user: false });
  const snapshots = [];
  const stop = view.app.watchSyncAlerts(state => snapshots.push(plain(state)));
  assert.deepEqual(snapshots, [empty()]);
  stop();
  view.app.applySyncAlertDot();
  assert.equal(snapshots.length, 1);
});

for (const source of Object.keys(sources)) {
  test(`${source} alone shows the tab reminder and clearing other sources leaves it visible`, async t => {
    const view = harness(t);
    view.app.startSyncAlertRefresh();
    const pending = view.app._syncAlertRequest;
    assert.equal(view.requests.length, 4);
    view.reply(source, true);
    await flush();
    assert.equal(view.dots.at(-1), true, 'a slow unrelated source never delays the visible result');
    Object.keys(sources).filter(key => key !== source).forEach(key => view.reply(key, false));
    await pending;
    assert.deepEqual(view.state(), { ...empty(), [source]: true });
    assert.equal(view.dots.at(-1), true);
    view.app.refreshSyncAlert({ force: true });
    await view.respond();
    assert.equal(view.dots.at(-1), false, 'the successful next snapshot can clear that source');
  });
}

test('source failures and missing backfill deployment preserve independently confirmed reminders', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  await view.respond({ admin: true, user: true, backfillUser: true, backfillAdmin: true });
  const pending = view.app.refreshSyncAlert({ force: true });
  view.reply('admin', false);
  view.fail('user');
  view.result('backfillUser', { success: false, error: '未知操作：getBackfillAlert' });
  view.result('backfillAdmin', { success: false, error: '未知操作：adminGetBackfillAlert' });
  await pending;
  assert.deepEqual(view.state(), { admin: false, user: true, backfillUser: true, backfillAdmin: true });
  assert.equal(view.dots.at(-1), true);

  view.app.onHide();
  view.app.startSyncAlertRefresh();
  const reopened = view.app._syncAlertRequest;
  view.reply('admin', true);
  view.reply('user', false);
  view.fail('backfillUser');
  view.fail('backfillAdmin');
  await reopened;
  assert.deepEqual(view.state(), { ...empty(), admin: true });
});

test('malformed backfill responses do not erase unread results or pending approvals', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  await view.respond({ backfillUser: true, backfillAdmin: true });
  const pending = view.app.refreshSyncAlert({ force: true });
  view.reply('admin', false);
  view.reply('user', false);
  view.result('backfillUser', { success: true, data: { hasUnreadBackfill: 'false' } });
  view.result('backfillAdmin', { success: true, data: {} });
  await pending;
  assert.deepEqual(view.state(), { ...empty(), backfillUser: true, backfillAdmin: true });
});

for (const response of [
  { success: false, code: 'FORBIDDEN' },
  { success: true, data: { isAdmin: false, hasPendingBackfill: true } },
  { success: true, data: { hasPendingBackfill: false } }
]) {
  test(`an explicit negative admin backfill result clears only that source: ${JSON.stringify(response)}`, async t => {
    const view = harness(t);
    view.app.startSyncAlertRefresh();
    await view.respond({ admin: true, user: true, backfillUser: true, backfillAdmin: true });
    const pending = view.app.refreshSyncAlert({ force: true });
    view.fail('admin');
    view.fail('user');
    view.fail('backfillUser');
    view.result('backfillAdmin', response);
    await pending;
    assert.deepEqual(view.state(), { admin: true, user: true, backfillUser: true, backfillAdmin: false });
  });
}

test('revoking administrator access prevents both late administrator responses and preserves personal reminders', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  const pending = view.app._syncAlertRequest;
  view.reply('user', true);
  view.reply('backfillUser', true);
  await flush();
  view.app.clearAdminSyncAlert();
  view.reply('admin', true);
  view.reply('backfillAdmin', true);
  await pending;
  assert.deepEqual(view.state(), { ...empty(), user: true, backfillUser: true });
  assert.equal(view.dots.at(-1), true);
});

test('account switches discard all old source responses without leaking reminders into the next account', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  const oldRequest = view.app._syncAlertRequest;
  view.setAccount('oz-next');
  view.app.refreshSyncAlert({ force: true });
  assert.deepEqual(view.state(), empty());
  Object.keys(sources).forEach(source => view.reply(source, true, 'oz-owner'));
  await oldRequest;
  assert.deepEqual(view.state(), empty());
  await view.respond({ backfillUser: true });
  assert.deepEqual(view.state(), { ...empty(), backfillUser: true });
});

test('hiding cancels four deadlines and ignores late responses; returning checks each source once', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  const pending = view.app._syncAlertRequest;
  assert.equal(view.timers.size, 4);
  view.app.onHide();
  await pending;
  Object.keys(sources).forEach(source => view.reply(source, true));
  await flush();
  assert.deepEqual(view.state(), empty());
  assert.equal(view.dots.at(-1), false);
  assert.equal(view.timers.size, 0);
  view.app.startSyncAlertRefresh();
  view.app.startSyncAlertRefresh();
  assert.equal(view.requests.length, 8);
  await view.respond({ backfillAdmin: true });
  await view.app.startSyncAlertRefresh();
  assert.equal(view.requests.length, 8, 'completed foreground checks do not poll');
});

test('an unavailable new source times out independently without clearing an existing legacy reminder', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  const pending = view.app._syncAlertRequest;
  view.reply('admin', true);
  view.reply('user', false);
  view.reply('backfillUser', false);
  await flush();
  assert.equal(view.dots.at(-1), true);
  assert.equal(view.timers.size, 1);
  const [timer] = view.timers;
  assert.equal(timer.delay, 10000);
  timer.callback();
  await pending;
  assert.deepEqual(view.state(), { ...empty(), admin: true });
  assert.equal(view.timers.size, 0);
});

test('Me shows both backfill reminder types from cache and restores them after returning without additional queries', async t => {
  const view = harness(t);
  view.app.startSyncAlertRefresh();
  await view.respond({ backfillUser: true, backfillAdmin: true });
  const page = view.createPage();
  page.onShow();
  assert.equal(page.data.hasUnreadBackfill, true);
  assert.equal(page.data.hasPendingBackfill, true);
  assert.equal(page.data.hasUnreadFeedback, false);
  assert.equal(page.data.hasAdminAlert, false);
  page.goToBackfillPage();
  assert.deepEqual(view.navigations, [{ url: '/pages/backfill/backfill' }]);
  page.onHide();
  assert.equal(page.data.hasUnreadBackfill, false);
  assert.equal(page.data.hasPendingBackfill, false);
  page.onShow();
  assert.equal(page.data.hasUnreadBackfill, true);
  assert.equal(page.data.hasPendingBackfill, true);
  assert.equal(view.requests.length, 4, 'Me subscribes to the current cached snapshot');
  const pending = view.app.refreshSyncAlert({ force: true });
  await view.respond({ backfillUser: false, backfillAdmin: true });
  await pending;
  assert.equal(page.data.hasUnreadBackfill, false);
  assert.equal(page.data.hasPendingBackfill, true);
  assert.equal(view.dots.at(-1), true);
});

test('Me backfill entry includes both result and approval labels', () => {
  const template = fs.readFileSync(require.resolve('../miniprogram/pages/me/me.wxml'), 'utf8');
  assert.match(template, /bindtap="goToBackfillPage"/);
  assert.match(template, />申请补录<\/text>/);
  assert.match(template, /wx:if="\{\{hasPendingBackfill \|\| hasUnreadBackfill\}\}"/);
  assert.match(template, /wx:if="\{\{hasPendingBackfill\}\}"[^>]*>待审批<\/text>/);
  assert.match(template, /wx:if="\{\{hasUnreadBackfill\}\}"[^>]*>审批结果<\/text>/);
});
