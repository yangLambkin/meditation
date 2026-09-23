const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { canManageControlPanel, canRunMaintenance } = require('../shared/maintenanceAuth');

function harness(wxContext = {}, environment = {}, userProfile = null) {
  const exports = {};
  let contextReads = 0;
  let profileReads = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: environment },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext() { contextReads++; return wxContext; },
        database() {
          return { collection() { return { where() { return { async get() {
            profileReads++;
            return { data: userProfile ? [userProfile] : [] };
          } }; } }; } };
        } };
    }
  });
  return { get contextReads() { return contextReads; }, get profileReads() { return profileReads; },
    async run(event = { type: 'getAccess' }) { return JSON.parse(JSON.stringify(await exports.main(event))); } };
}

test('legacy ADMIN_OPENID still requires exactly one valid server-configured openid', () => {
  for (const ADMIN_OPENID of [undefined, null, 12, [], {}, '', ' ', 'fixed,other', 'fixed,fixed',
    'fixed，other', 'fixed other', 'fixed\nother', 'fixed;other', 'fixed/other']) {
    assert.equal(canManageControlPanel({ OPENID: 'fixed' }, { ADMIN_OPENID, MAINTENANCE_ADMIN_OPENIDS: 'fixed' }), false);
  }
  for (const OPENID of [undefined, null, 12, '', 'other', 'fixed-extra']) {
    assert.equal(canManageControlPanel({ OPENID }, { ADMIN_OPENID: 'fixed' }), false);
  }
  assert.equal(canManageControlPanel({ OPENID: 'o_fixed-01' }, { ADMIN_OPENID: ' o_fixed-01 ' }), true);
});

test('the server allowlist admits either administrator, trims entries and accepts duplicate IDs', () => {
  for (const ADMIN_OPENIDS of ['admin-one,admin_two', ' admin-one , admin_two ', 'admin-one,admin_two,admin-one']) {
    for (const OPENID of ['admin-one', 'admin_two']) {
      assert.equal(canManageControlPanel({ OPENID }, { ADMIN_OPENIDS }), true);
    }
    assert.equal(canManageControlPanel({ OPENID: ' admin-one ' }, { ADMIN_OPENIDS }), true);
    for (const OPENID of ['outsider', 'admin', 'admin-one-extra', 'ADMIN-ONE', undefined, null, 12, '']) {
      assert.equal(canManageControlPanel({ OPENID }, { ADMIN_OPENIDS }), false);
    }
  }
});

test('an invalid explicit allowlist rejects every account without falling back to legacy configuration', () => {
  for (const ADMIN_OPENIDS of [null, 12, [], {}, '', ' ', ',', ',admin-one', 'admin-one,',
    'admin-one,,admin-two', 'admin-one, ,admin-two', 'admin-one，admin-two', 'admin-one;admin-two',
    'admin-one admin-two', 'admin-one,admin two', 'admin-one,admin/two', 'admin-one,admin\ntwo']) {
    const environment = { ADMIN_OPENIDS, ADMIN_OPENID: 'admin-one', MAINTENANCE_ADMIN_OPENIDS: 'admin-two' };
    for (const OPENID of ['admin-one', 'admin-two']) {
      assert.equal(canManageControlPanel({ OPENID }, environment), false, JSON.stringify(ADMIN_OPENIDS));
    }
  }
});

test('an explicit allowlist replaces the legacy account and revocation applies on the next access probe', async () => {
  const environment = { ADMIN_OPENIDS: 'admin-one,admin-two', ADMIN_OPENID: 'legacy-admin' };
  const context = { OPENID: 'admin-two' };
  const app = harness(context, environment);
  assert.deepEqual(await app.run(), { success: true, data: { isAdmin: true } });
  assert.equal(canManageControlPanel({ OPENID: 'legacy-admin' }, environment), false);
  environment.ADMIN_OPENIDS = 'admin-one';
  assert.deepEqual(await app.run(), { success: true, data: { isAdmin: false } });
  context.OPENID = 'legacy-admin';
  environment.ADMIN_OPENIDS = '';
  assert.deepEqual(await app.run(), { success: true, data: { isAdmin: false } });
  environment.ADMIN_OPENIDS = undefined;
  assert.deepEqual(await app.run(), { success: true, data: { isAdmin: true } });
  assert.equal(app.profileReads, 0);
});

test('access probe returns only a boolean and never exposes the configured account', async () => {
  for (const [OPENID, isAdmin] of [['only-fixed-account', true], ['someone-else', false], ['', false]]) {
    const app = harness({ OPENID }, { ADMIN_OPENID: 'only-fixed-account' });
    const result = await app.run();
    assert.deepEqual(result, { success: true, data: { isAdmin } });
    assert.equal(JSON.stringify(result).includes('only-fixed-account'), false);
    assert.equal(app.contextReads, 1);
  }
});

test('multi-administrator access probes reveal neither the allowlist nor the legacy identity', async () => {
  for (const [OPENID, isAdmin] of [['admin-one', true], ['admin-two', true], ['outsider', false], ['', false]]) {
    const app = harness({ OPENID }, { ADMIN_OPENIDS: 'admin-one,admin-two', ADMIN_OPENID: 'legacy-admin' });
    const result = await app.run();
    assert.deepEqual(result, { success: true, data: { isAdmin } });
    for (const account of ['admin-one', 'admin-two', 'legacy-admin']) {
      assert.equal(JSON.stringify(result).includes(account), false);
    }
    assert.equal(app.contextReads, 1);
    assert.equal(app.profileReads, 0);
  }
});

test('access probes bind an expected identity to the trimmed SDK identity', async () => {
  const environment = { ADMIN_OPENIDS: 'admin-one,admin-two' };
  for (const OPENID of ['admin-one', ' admin-one ']) {
    const app = harness({ OPENID, SOURCE: 'wx_client,scf' }, environment);
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one' }),
      { success: true, data: { isAdmin: true } });
    for (const expectedOpenid of ['admin-two', ' admin-one ', '', null, 12, true, [], {}, ['admin-one']]) {
      assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid }),
        { success: true, data: { isAdmin: false } }, JSON.stringify(expectedOpenid));
    }
    assert.equal(app.profileReads, 0);
  }
});

test('lost or replaced nested SDK identity denies the original caller even when both identities are administrators', async () => {
  const environment = { ADMIN_OPENIDS: 'admin-one,admin-two' };
  for (const wxContext of [
    { SOURCE: 'wx_client,scf' },
    { OPENID: '', SOURCE: 'wx_client,scf' },
    { FROM_OPENID: 'admin-one', SOURCE: 'wx_client,scf' },
    { OPENID: 'admin-two', SOURCE: 'wx_client,scf' },
    { OPENID: 'outsider', SOURCE: 'wx_client,scf' },
  ]) {
    const app = harness(wxContext, environment);
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one' }),
      { success: true, data: { isAdmin: false } });
    assert.equal(app.contextReads, 1);
    assert.equal(app.profileReads, 0);
  }
});

test('forged expected identity and cloud-call source cannot grant client access', async () => {
  for (const wxContext of [
    {}, { OPENID: 'outsider', SOURCE: 'wx_client' },
    { OPENID: 'outsider', SOURCE: 'wx_client,scf' },
    { SOURCE: 'scf', FROM_OPENID: 'admin-two' },
  ]) {
    const app = harness(wxContext, { ADMIN_OPENIDS: 'admin-one,admin-two' });
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-two',
      OPENID: 'admin-two', openid: 'admin-two', FROM_OPENID: 'admin-two',
      SOURCE: 'wx_client,scf', source: 'scf', isAdmin: true,
      data: { OPENID: 'admin-two', expectedOpenid: 'admin-two', isAdmin: true } }),
    { success: true, data: { isAdmin: false } });
    assert.equal(app.profileReads, 0);
  }
});

test('unconfigured, malformed legacy and forged client access checks fail closed without database access', async () => {
  for (const env of [{}, { ADMIN_OPENID: '' }, { ADMIN_OPENID: 'fixed,other' }, { MAINTENANCE_ADMIN_OPENIDS: 'fixed' }]) {
    const app = harness({ OPENID: 'fixed' }, env);
    assert.deepEqual(await app.run(), { success: true, data: { isAdmin: false } });
  }
  for (const wxContext of [{}, { OPENID: 'outsider' }, { SOURCE: 'wx_trigger' }]) {
    const app = harness(wxContext, { ADMIN_OPENID: 'fixed', BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger' });
    const result = await app.run({ type: 'getAccess', OPENID: 'fixed', openid: 'fixed', ADMIN_OPENID: 'fixed',
      admin: true, source: 'wx_trigger', data: { OPENID: 'fixed', isAdmin: true } });
    assert.deepEqual(result, { success: true, data: { isAdmin: false } });
  }
  for (const wxContext of [{}, { OPENID: 'outsider' }, { OPENID: 'maintenance' }, { SOURCE: 'wx_trigger' }]) {
    const app = harness(wxContext, { ADMIN_OPENIDS: 'admin-one,admin-two', MAINTENANCE_ADMIN_OPENIDS: 'maintenance',
      BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger' });
    assert.deepEqual(await app.run({ type: 'getAccess', OPENID: 'admin-two', openid: 'admin-two',
      ADMIN_OPENIDS: 'outsider,maintenance', admin: true, source: 'wx_trigger',
      data: { OPENID: 'admin-two', isAdmin: true } }), { success: true, data: { isAdmin: false } });
    assert.equal(app.profileReads, 0);
  }
});

test('control-panel account and legacy maintenance permissions stay independent', () => {
  const env = { ADMIN_OPENIDS: 'fixed,second-admin', MAINTENANCE_ADMIN_OPENIDS: 'maintenance-one,maintenance-two',
    BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger' };
  for (const OPENID of ['fixed', 'second-admin']) {
    assert.equal(canManageControlPanel({ OPENID }, env), true);
    assert.equal(canRunMaintenance({ OPENID }, env), false);
  }
  for (const OPENID of ['maintenance-one', 'maintenance-two']) {
    assert.equal(canRunMaintenance({ OPENID }, env), true);
    assert.equal(canManageControlPanel({ OPENID }, env), false);
  }
  assert.equal(canRunMaintenance({ SOURCE: 'wx_trigger' }, env, true), true);
  assert.equal(canManageControlPanel({ SOURCE: 'wx_trigger' }, env), false);
});

test('binding the administrator student number or claiming their nickname never grants panel ownership', async () => {
  const profile = { _id: 'other-user-document', _openid: 'other-wechat-openid',
    bijingBound: true, bijingStudentNumber: 'BJ2407159', nickName: '瑞璞', isAdmin: true };
  const wxContext = { OPENID: profile._openid, SOURCE: 'wx_client' };
  const forgedEvent = { type: 'getAccess', studentNumber: 'BJ2407159', nickname: '瑞璞',
    userInfo: profile, profile, isAdmin: true, OPENID: 'fixed-admin-test-openid' };
  for (const env of [{ ADMIN_OPENID: 'fixed-admin-test-openid' }, {}]) {
    const app = harness(wxContext, env, profile);
    assert.deepEqual(await app.run(forgedEvent), { success: true, data: { isAdmin: false } });
    assert.equal(app.profileReads, 0, 'the access probe must not authorize from user profile fields');
    assert.equal(canManageControlPanel({ ...wxContext, ...profile, userInfo: profile }, env), false);
  }
});

test('access function only supports the read-only getAccess action', async () => {
  const app = harness({ OPENID: 'fixed' }, { ADMIN_OPENID: 'fixed' });
  for (const event of [{}, { type: 'setAdmin', openid: 'other' }, null]) {
    assert.equal((await app.run(event)).success, false);
  }
  assert.equal(app.contextReads, 0);
});
