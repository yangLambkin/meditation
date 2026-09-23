const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { authorizeControlPanel, panelForbidden } = require('../shared/maintenanceAuth');

const unavailable = {
  success: false,
  code: 'ADMIN_AUTH_UNAVAILABLE',
  error: '管理员权限校验暂时不可用，请稍后重试',
};

function cloudStub(response = { result: { success: true, data: { isAdmin: true } } }) {
  const calls = [];
  return {
    calls,
    cloud: {
      DYNAMIC_CURRENT_ENV: 'current-cloud-environment',
      async callFunction(request) {
        calls.push(request);
        return response;
      },
    },
  };
}

test('central authorization asks adminManager about the SDK identity in the current environment', async () => {
  const { cloud, calls } = cloudStub();
  assert.deepEqual(await authorizeControlPanel(cloud, {
    OPENID: ' admin-two ', SOURCE: 'wx_client', ENV: 'client-selected-environment',
    expectedOpenid: 'forged-admin', openid: 'forged-admin', isAdmin: true,
  }), { success: true });
  assert.deepEqual(calls, [{
    name: 'adminManager',
    data: { type: 'getAccess', expectedOpenid: 'admin-two' },
    config: { env: cloud.DYNAMIC_CURRENT_ENV },
    timeout: 2000,
  }]);
});

test('missing or invalid SDK identity is forbidden before contacting adminManager', async () => {
  for (const wxContext of [
    undefined, null, {}, { OPENID: undefined }, { OPENID: null }, { OPENID: 12 },
    { OPENID: true }, { OPENID: [] }, { OPENID: {} }, { OPENID: '' }, { OPENID: ' \n\t ' },
    { OPENID: 'admin,other' }, { OPENID: 'admin other' }, { OPENID: 'admin/other' },
    { openid: 'admin-two', expectedOpenid: 'admin-two', isAdmin: true },
    { SOURCE: 'wx_client,scf', FROM_OPENID: 'admin-two' },
  ]) {
    const { cloud, calls } = cloudStub();
    assert.deepEqual(await authorizeControlPanel(cloud, wxContext), panelForbidden(), JSON.stringify(wxContext));
    assert.deepEqual(calls, []);
  }
});

test('an explicit negative central decision is forbidden', async () => {
  const { cloud, calls } = cloudStub({ result: { success: true, data: { isAdmin: false } } });
  assert.deepEqual(await authorizeControlPanel(cloud, { OPENID: 'admin-two' }), panelForbidden());
  assert.equal(calls.length, 1);
});

test('authorization never reads a local allowlist or falls back after a central failure', async () => {
  const module = { exports: {} };
  let environmentReads = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared/maintenanceAuth'), 'utf8'), {
    module,
    process: { env: new Proxy({ ADMIN_OPENIDS: 'admin-two', ADMIN_OPENID: 'admin-two' }, {
      get() { environmentReads++; throw new Error('local allowlists must not be consulted'); },
    }) },
  });
  for (const [response, expected] of [
    [{ result: { success: true, data: { isAdmin: true } } }, { success: true }],
    [{ result: { success: true, data: { isAdmin: false } } }, panelForbidden()],
    [{ result: { success: false, data: { isAdmin: true } } }, unavailable],
    [null, unavailable],
  ]) {
    const { cloud, calls } = cloudStub(response);
    const result = await module.exports.authorizeControlPanel(cloud, { OPENID: 'admin-two' });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
    assert.equal(calls.length, 1);
  }
  assert.equal(environmentReads, 0);
});

test('malformed and unsuccessful central responses fail closed without truthy-value coercion', async () => {
  for (const response of [
    null, false, 1, 'ok', {}, [],
    { success: true, data: { isAdmin: true } },
    { result: null }, { result: [] },
    { result: JSON.stringify({ success: true, data: { isAdmin: true } }) },
    { result: { success: false, data: { isAdmin: true } } },
    { result: { success: 'true', data: { isAdmin: true } } },
    { result: { success: 1, data: { isAdmin: true } } },
    { result: { data: { isAdmin: true } } },
    { result: { success: true } },
    { result: { success: true, data: null } },
    { result: { success: true, data: {} } },
    { result: { success: true, data: { isAdmin: 'true' } } },
    { result: { success: true, data: { isAdmin: 'false' } } },
    { result: { success: true, data: { isAdmin: 1 } } },
    { result: { success: true, data: { isAdmin: 0 } } },
    { result: { success: true, data: { isAdmin: null } } },
    { result: { success: true, data: { isAdmin: [] } } },
    { result: { success: true, data: { isAdmin: {} } } },
  ]) {
    const { cloud, calls } = cloudStub(response);
    assert.deepEqual(await authorizeControlPanel(cloud, { OPENID: 'admin-two' }), unavailable, JSON.stringify(response));
    assert.equal(calls.length, 1);
  }
});

test('rejections, timeouts and synchronous SDK failures return a generic unavailable result', async () => {
  for (const failure of [
    new Error('secret cloud request detail'),
    Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    'non-error SDK rejection',
  ]) {
    for (const callFunction of [
      async () => { throw failure; },
      () => { throw failure; },
    ]) {
      assert.deepEqual(await authorizeControlPanel({ DYNAMIC_CURRENT_ENV: 'test', callFunction },
        { OPENID: 'admin-two' }), unavailable);
    }
  }
});

test('each operation rechecks central access so revocation takes effect immediately', async () => {
  let isAdmin = true;
  let calls = 0;
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    async callFunction() {
      calls++;
      return { result: { success: true, data: { isAdmin } } };
    },
  };
  assert.deepEqual(await authorizeControlPanel(cloud, { OPENID: 'admin-two' }), { success: true });
  isAdmin = false;
  assert.deepEqual(await authorizeControlPanel(cloud, { OPENID: 'admin-two' }), panelForbidden());
  assert.equal(calls, 2);
});
