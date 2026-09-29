const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function meHarness({ profile, adminOnlyClear = true, access } = {}) {
  let definition;
  const calls = { apply: 0, refresh: [], clearAdmin: 0, clearAll: 0, profiles: 0, stopWatch: 0, access: [] };
  const app = {
    applySyncAlertDot() { calls.apply++; },
    refreshSyncAlert(options) { calls.refresh.push(plain(options)); return Promise.resolve(); },
    clearSyncAlert() { calls.clearAll++; },
    ...(adminOnlyClear ? { clearAdminSyncAlert() { calls.clearAdmin++; } } : {})
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/me/me.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp: () => app,
    wx: { hideLoading() {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name.endsWith('/dateUtil.js')) return { watchBusinessDate() { return () => { calls.stopWatch++; }; } };
      if (name.endsWith('/profileCache.js')) return {
        currentAccount: () => 'oz-owner', isCurrentAccount: account => account === 'oz-owner'
      };
      if (name.endsWith('/cloudApi.js')) return { async callCloudFunction(name, data) {
        calls.access.push({ name, data: plain(data) });
        return access ? access() : { result: { success: true, data: { isAdmin: true } } };
      } };
      return {};
    }
  });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value); },
    getUserData() { calls.profiles++; return profile && profile(calls.profiles); }
  };
  return { page, calls, app };
}

test('Me showing and completing its profile only reapplies cached reminders', async () => {
  const pending = deferred();
  const { page, calls } = meHarness({ profile: () => pending.promise });
  page.onShow();
  assert.equal(calls.apply, 1, 'cached state is reapplied while profile loads');
  assert.equal(calls.profiles, 1);
  await flush();
  assert.equal(calls.refresh.length, 0);
  pending.resolve();
  await flush();
  assert.deepEqual(calls.refresh, [], 'profile completion must not duplicate the application opening query');
  assert.equal(calls.clearAdmin, 0);
  assert.equal(calls.clearAll, 0);
});

test('Me hidden or unloaded before profile completion does not refresh reminders', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const pending = deferred();
    const { page, calls } = meHarness({ profile: () => pending.promise });
    page.onShow();
    page[lifecycle]();
    pending.resolve();
    await flush();
    assert.equal(calls.refresh.length, 0, lifecycle);
    assert.equal(calls.stopWatch, 1, lifecycle);
  }
});

test('Me onReady reapplies the cached tabbar reminder without querying the server', () => {
  const { page, calls } = meHarness();
  page.onReady();
  assert.equal(calls.apply, 1);
  assert.equal(calls.refresh.length, 0);
  assert.equal(calls.profiles, 0);
});

test('Me ignores the previous showing profile completion after hiding and reopening', async () => {
  const first = deferred(), second = deferred();
  const { page, calls } = meHarness({ profile: number => number === 1 ? first.promise : second.promise });
  page.onShow();
  page.onHide();
  page.onShow();
  first.resolve();
  await flush();
  assert.equal(calls.refresh.length, 0, 'old profile completion never queries reminders');
  second.resolve();
  await flush();
  assert.deepEqual(calls.refresh, [], 'reopening Me also uses the current application cache');
});

test('successful binding authorization forces fresh alerts after invalidating the old administrator query', async () => {
  const pending = deferred();
  const { page, calls } = meHarness({ access: () => pending.promise });
  const request = page.refreshBijingAdminAccess({ account: 'oz-owner', generation: 0 });
  assert.equal(calls.clearAdmin, 1);
  assert.equal(calls.refresh.length, 0);
  pending.resolve({ result: { success: true, data: { isAdmin: true } } });
  await request;
  assert.equal(page.data.bijingIsAdmin, true);
  assert.deepEqual(calls.access, [{ name: 'adminManager', data: { type: 'getAccess' } }]);
  assert.deepEqual(calls.refresh, [{ force: true }], 'force bypasses an in-flight query with invalidated admin generation');
  assert.equal(calls.clearAll, 0);
});

test('denied or hidden binding authorization does not requery reminders', async () => {
  for (const outcome of ['denied', 'hidden']) {
    const pending = deferred();
    const { page, calls } = meHarness({ access: () => pending.promise });
    const request = page.refreshBijingAdminAccess({ account: 'oz-owner', generation: 0 });
    if (outcome === 'hidden') page.onHide();
    pending.resolve({ result: { success: true, data: { isAdmin: outcome !== 'denied' } } });
    await request;
    assert.equal(calls.refresh.length, 0, outcome);
    assert.equal(page.data.bijingIsAdmin, false, outcome);
  }
});

test('clearing Me administrator access preserves the independent personal result reminder', () => {
  const { page, calls, app } = meHarness();
  let personalUnread = true;
  const clearAll = app.clearSyncAlert;
  app.clearSyncAlert = () => { personalUnread = false; clearAll(); };
  page.data.bijingIsAdmin = true;
  page._versionTapCount = 4;
  page._adminRequestId = 10;
  page.clearBijingAdminAccess();
  assert.equal(page.data.bijingIsAdmin, false);
  assert.equal(page._versionTapCount, 0);
  assert.equal(page._adminRequestId, 11);
  assert.equal(calls.clearAdmin, 1);
  assert.equal(calls.clearAll, 0);
  assert.equal(personalUnread, true);
});

test('clearing only the local administrator entry preserves the application reminder sources', () => {
  const { page, calls } = meHarness();
  page.data.bijingIsAdmin = true;
  page._versionTapCount = 4;
  page.clearBijingAdminAccess({ clearAlert: false });
  assert.equal(page.data.bijingIsAdmin, false);
  assert.equal(page._versionTapCount, 0);
  assert.equal(calls.clearAdmin, 0);
  assert.equal(calls.clearAll, 0);
});

test('administrator entry authorization denial clears only the administrator source', async () => {
  const { page, calls } = meHarness({ access: () => ({ result: { success: true, data: { isAdmin: false } } }) });
  page._versionTapCount = 6;
  page._versionTapAt = Date.now();
  await page.onVersionTap();
  assert.equal(calls.clearAdmin, 1);
  assert.equal(calls.clearAll, 0);
  assert.equal(calls.refresh.length, 0);
});

test('Me retains the legacy reminder clearing fallback when the app lacks the scoped method', () => {
  const { page, calls } = meHarness({ adminOnlyClear: false });
  page.clearBijingAdminAccess();
  assert.equal(calls.clearAll, 1);
  assert.equal(calls.clearAdmin, 0);
});
