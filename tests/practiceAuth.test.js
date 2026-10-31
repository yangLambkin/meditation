const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const values = { userOpenId: 'wechat-a', userInfo: { bijingBound: true, bijingStudentNumber: ' bj001 ', bijingBindingVersion: 'version-a' } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/practiceAuth.js'), 'utf8'), {
    module, exports: module.exports, wx: { getStorageSync: key => values[key] },
    require: name => name === './profileCache.js' ? { getConfirmedBijingBinding: () => null }
      : { serviceAccessToken: 'test-credential' },
  });
  return { values, auth: module.exports };
}

test('temporary direct access uses the current local binding and isolated credential configuration', async () => {
  const { values, auth } = harness();
  const owner = await auth.authorize();
  assert.equal(owner.openid, 'wechat-a');
  assert.equal(owner.studentNumber, 'BJ001');
  assert.equal(owner.bindingVersion, 'version-a');
  assert.equal(await auth.getAccessToken(), 'test-credential');
  values.userInfo.bijingBound = false;
  await assert.rejects(auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
});

test('stale profiles and contradictory bind/unbind caches cannot create a new queue owner', () => {
  const { values, auth } = harness();
  values.userInfo._openid = 'wechat-b';
  assert.equal(auth.getOwner(), null);
  delete values.userInfo._openid;
  values.bijingStatus_wechat_a = undefined;
  values['bijingStatus_wechat-a'] = { account: 'wechat-a', binding: { bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'version-old' } };
  assert.equal(auth.getOwner(), null);
  values['bijingStatus_wechat-a'].binding.bijingBindingVersion = 'version-a';
  assert.equal(auth.getOwner().bindingVersion, 'version-a');
  values.userInfo.bijingBound = false;
  assert.equal(auth.getOwner(), null);
  values.userInfo.bijingBound = true;
  values['bijingStatus_wechat-a'].binding.bijingBound = false;
  assert.equal(auth.getOwner(), null);
});

test('a missing account or failed storage read pauses authorization', async () => {
  const { values, auth } = harness();
  delete values.userOpenId;
  assert.equal(auth.getOwner(), null);
  await assert.rejects(auth.authorize(), { code: 'AUTH_REQUIRED' });
});

function bindingHarness(options = {}) {
  const profileVersion = Object.hasOwn(options, 'profileVersion') ? options.profileVersion : 'version-old';
  const serverVersion = options.serverVersion || 'version-new';
  const account = 'oz-account';
  const binding = version => ({ bijingBound: true, bijingStudentNumber: 'BJ001',
    ...(version === undefined ? {} : { bijingBindingVersion: version }) });
  const values = {
    userOpenId: account,
    userInfo: { _openid: account, nickName: '保留昵称', avatarUrl: 'cloud://avatar', ...binding(profileVersion) },
    userLoginData: { openid: account, userInfo: {} },
    [`bijingStatus_${account}`]: { account, updatedAt: Date.now(), binding: binding(profileVersion) }
  };
  const writeFailures = new Set();
  const calls = [];
  let serverProfile = binding(serverVersion);
  let pendingResponse;
  const wx = {
    getStorageSync: key => structuredClone(values[key]),
    setStorageSync(key, value) {
      if (writeFailures.has(key)) throw new Error('temporary storage failure');
      values[key] = structuredClone(value);
    },
    showLoading() {}, hideLoading() {}, showToast() {},
    showModal(options) { options.success({ confirm: true }); }
  };
  function loadUtility(name, dependencies) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, wx, require: name => dependencies[name]
    });
    return module.exports;
  }
  const config = { serviceAccessToken: 'test-credential', practicesEnabled: true };
  const profileCache = loadUtility('profileCache.js', {});
  const auth = loadUtility('practiceAuth.js', { './practiceConfig.js': config, './profileCache.js': profileCache });
  const api = loadUtility('practiceApi.js', { './practiceConfig.js': config, './practiceAuth.js': auth });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/me/me.js'), 'utf8'), {
    Page: value => { definition = value; }, wx, getApp: () => null, console: { error() {} },
    require(name) {
      if (name.endsWith('profileCache.js')) return profileCache;
      if (name.endsWith('checkin.js')) return { isUserLoggedIn: () => true };
      if (name.endsWith('bijingApi.js')) return {
        bindBijing: async studentNumber => ({ success: true, data: {
          studentNumber, bindingVersion: serverProfile.bijingBindingVersion
        } }),
        unbindBijing: async () => ({ success: true })
      };
      if (name.endsWith('cloudApi.js')) return { callCloudFunction: async (...args) => {
        calls.push(args);
        return pendingResponse ? pendingResponse() : { result: { success: true, data: serverProfile } };
      } };
      return {};
    }
  });
  const openPage = () => ({ ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); } });
  return { account, values, calls, auth, api, writeFailures, page: openPage(), openPage,
    setServerProfile(value) { serverProfile = value; },
    deferResponse() {
      let resolve;
      const response = new Promise(done => { resolve = done; });
      pendingResponse = () => response;
      return resolve;
    }
  };
}

for (const reopen of [false, true]) {
test(`a confirmed binding pauses the old owner when both persistent cache writes fail${reopen ? ' and recovers on a recreated page' : ''}`, async () => {
  const h = bindingHarness(), previousOwner = h.auth.getOwner();
  h.writeFailures.add('userInfo');
  h.writeFailures.add(`bijingStatus_${h.account}`);
  await h.page.loadBijingStatus({ force: true });
  assert.equal(h.values.userInfo.bijingBindingVersion, 'version-old');
  assert.equal(h.values[`bijingStatus_${h.account}`].binding.bijingBindingVersion, 'version-old');
  assert.equal(h.page.data.bijingBindingVersion, 'version-new');
  assert.equal(h.auth.getOwner(), null, 'matching persisted caches cannot override a newer server confirmation');
  assert.throws(() => h.api.assertOwner(previousOwner), { code: 'ACCOUNT_CHANGED' });
  h.writeFailures.clear();
  const page = reopen ? h.openPage() : h.page;
  await page.loadBijingStatus();
  assert.equal(h.calls.length, 2);
  assert.equal(h.auth.getOwner().bindingVersion, 'version-new');
  assert.throws(() => h.api.assertOwner(previousOwner), { code: 'ACCOUNT_CHANGED' });
});
}

test('successful unbind and rebind advance the confirmation barrier even after both unbind cache writes fail', async () => {
  const h = bindingHarness();
  await h.page.loadBijingStatus({ force: true });
  const previousOwner = h.auth.getOwner();
  h.writeFailures.add('userInfo');
  h.writeFailures.add(`bijingStatus_${h.account}`);
  await h.page.unbindBijing();
  assert.equal(h.page.data.bijingBound, false);
  assert.equal(h.values.userInfo.bijingBound, true);
  assert.equal(h.auth.getOwner(), null, 'a confirmed unbind immediately pauses the persisted bound owner');
  h.writeFailures.clear();
  h.setServerProfile({ bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'rebound-version' });
  await h.page.doBindBijing('BJ001');
  assert.equal(h.auth.getOwner().bindingVersion, 'rebound-version', 'a new confirmed bind replaces the unbound barrier');
  assert.throws(() => h.api.assertOwner(previousOwner), { code: 'ACCOUNT_CHANGED' });
});

test('a failed binding-cache save only pauses its own account when switching away and back', async () => {
  const h = bindingHarness();
  const previousProfile = structuredClone(h.values.userInfo);
  h.writeFailures.add('userInfo');
  h.writeFailures.add(`bijingStatus_${h.account}`);
  await h.page.loadBijingStatus({ force: true });
  h.values.userOpenId = 'oz-next';
  h.values.userInfo = { _openid: 'oz-next', bijingBound: true,
    bijingStudentNumber: 'BJ002', bijingBindingVersion: 'next-version' };
  assert.equal(h.auth.getOwner().studentNumber, 'BJ002');
  h.values.userOpenId = h.account;
  h.values.userInfo = previousProfile;
  assert.equal(h.auth.getOwner(), null, 'returning to the old account cannot reuse its stale persisted version');
});

for (const [label, profileVersion] of [['remote rebind', 'version-old'], ['legacy binding migration', undefined]]) {
  test(`confirmed ${label} converges both caches while rejecting the prior task owner`, async () => {
    const h = bindingHarness({ profileVersion });
    const previousOwner = h.auth.getOwner();
    assert.equal(previousOwner.bindingVersion, profileVersion || '');
    await h.page.loadBijingStatus({ force: true });
    const owner = h.auth.getOwner();
    assert.equal(owner.bindingVersion, 'version-new');
    assert.equal(h.values.userInfo.bijingBindingVersion, 'version-new');
    assert.equal(h.values.userLoginData.userInfo.bijingBindingVersion, 'version-new');
    assert.equal(h.values.userInfo.nickName, '保留昵称');
    assert.equal(h.values.userInfo.avatarUrl, 'cloud://avatar');
    assert.equal(h.page.data.bijingBindingVersion, 'version-new');
    assert.throws(() => h.api.assertOwner(previousOwner), { code: 'ACCOUNT_CHANGED' });
    assert.doesNotThrow(() => h.api.assertOwner(owner));
    await h.page.loadBijingStatus();
    assert.equal(h.calls.length, 1, 'converged fresh caches still avoid duplicate server requests');
  });
}

test('contradictory fresh caches pause ownership until another authoritative confirmation', async () => {
  const h = bindingHarness();
  h.values[`bijingStatus_${h.account}`].binding.bijingBindingVersion = 'unconfirmed-version';
  const resolve = h.deferResponse();
  const reading = h.page.loadBijingStatus();
  assert.equal(h.calls.length, 1, 'a fresh display cache cannot suppress reconciliation');
  assert.equal(h.auth.getOwner(), null);
  assert.equal(h.values.userInfo.bijingBindingVersion, 'version-old');
  resolve({ result: { success: true, data: {
    bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'confirmed-version'
  } } });
  await reading;
  assert.equal(h.auth.getOwner().bindingVersion, 'confirmed-version');
});

for (const failure of ['profile', 'status']) {
  for (const reopen of [false, true]) {
    test(`${failure} cache write failure recovers after server confirmation${reopen ? ' on a recreated page' : ''}`, async () => {
      const h = bindingHarness();
      const key = failure === 'profile' ? 'userInfo' : `bijingStatus_${h.account}`;
      h.writeFailures.add(key);
      await h.page.loadBijingStatus({ force: true });
      assert.equal(h.page.data.bijingBindingVersion, 'version-new');
      assert.equal(h.auth.getOwner(), null, 'partially saved binding cannot authorize requests');
      h.writeFailures.clear();
      const page = reopen ? h.openPage() : h.page;
      await page.loadBijingStatus();
      assert.equal(h.calls.length, 2, 'recovery rechecks the server even while the display cache is fresh');
      assert.equal(h.auth.getOwner().bindingVersion, 'version-new');
      assert.equal(h.values.userInfo.bijingBindingVersion, 'version-new');
      assert.equal(h.values[`bijingStatus_${h.account}`].binding.bijingBindingVersion, 'version-new');
    });
  }
}

test('an account change discards a late binding confirmation before writing either cache', async () => {
  const h = bindingHarness();
  const resolve = h.deferResponse();
  const reading = h.page.loadBijingStatus({ force: true });
  h.values.userOpenId = 'oz-next';
  h.values.userInfo = { _openid: 'oz-next', bijingBound: true,
    bijingStudentNumber: 'BJ002', bijingBindingVersion: 'next-version' };
  resolve({ result: { success: true, data: {
    bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'version-new'
  } } });
  await reading;
  assert.equal(h.values.userInfo.bijingBindingVersion, 'next-version');
  assert.equal(h.values[`bijingStatus_${h.account}`].binding.bijingBindingVersion, 'version-old');
  assert.equal(h.values['bijingStatus_oz-next'], undefined);
  assert.equal(h.auth.getOwner().studentNumber, 'BJ002');
});
