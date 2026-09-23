const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { authorizeControlPanel, panelForbidden } = require('../shared/maintenanceAuth');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');

const unavailable = {
  success: false,
  code: 'ADMIN_AUTH_UNAVAILABLE',
  error: '管理员权限校验暂时不可用，请稍后重试',
};

function cloudStub(response = { result: { success: true, data: { isAdmin: true } } }, options = {}) {
  const calls = [];
  const authorization = createStudentAuthDatabase(options);
  let databaseCalls = 0;
  return {
    calls, ...authorization, get databaseCalls() { return databaseCalls; },
    cloud: {
      DYNAMIC_CURRENT_ENV: 'current-cloud-environment',
      database() { databaseCalls++; return authorization.db; },
      async callFunction(request) {
        calls.push(request);
        if (options.beforeCall) await options.beforeCall(request, authorization);
        if (options.callError) throw options.callError;
        return response;
      },
    },
  };
}

test('central authorization delegates the SDK identity through a server-only expiring proof', async () => {
  let proofAtCall;
  const before = Date.now();
  const app = cloudStub(undefined, { beforeCall(request, authorization) {
    proofAtCall = structuredClone(authorization.locks.find(row => row._id === request.data.delegationId));
  } });
  const { cloud, calls } = app;
  assert.deepEqual(await authorizeControlPanel(cloud, {
    OPENID: ' admin-two ', SOURCE: 'wx_client', ENV: 'client-selected-environment',
    expectedOpenid: 'forged-admin', openid: 'forged-admin', isAdmin: true,
  }), { success: true });
  assert.equal(calls.length, 1);
  const delegationId = calls[0].data.delegationId;
  assert.match(delegationId, /^auth_[a-f0-9]{64}$/);
  assert.deepEqual(calls[0], {
    name: 'adminManager',
    data: { type: 'getAccess', expectedOpenid: 'admin-two', delegationId },
    config: { env: cloud.DYNAMIC_CURRENT_ENV },
    timeout: 8000,
  });
  assert.deepEqual(proofAtCall, { _id: delegationId, kind: 'admin-delegation', openid: 'admin-two',
    createdAt: proofAtCall.createdAt, expiresAt: proofAtCall.createdAt + 30000, audience: 'adminManager' });
  assert.ok(proofAtCall.createdAt >= before && proofAtCall.createdAt <= Date.now());
  assert.deepEqual(app.locks, [], 'the caller cleans up a proof the callee did not consume');
  assert.deepEqual(app.writes.map(write => write.action), ['set', 'remove']);
});

test('missing or invalid SDK identity is forbidden before contacting adminManager', async () => {
  for (const wxContext of [
    undefined, null, {}, { OPENID: undefined }, { OPENID: null }, { OPENID: 12 },
    { OPENID: true }, { OPENID: [] }, { OPENID: {} }, { OPENID: '' }, { OPENID: ' \n\t ' },
    { OPENID: 'admin,other' }, { OPENID: 'admin other' }, { OPENID: 'admin/other' },
    { openid: 'admin-two', expectedOpenid: 'admin-two', isAdmin: true },
    { SOURCE: 'wx_client,scf', FROM_OPENID: 'admin-two' },
  ]) {
    const { cloud, calls, writes, databaseCalls } = cloudStub();
    assert.deepEqual(await authorizeControlPanel(cloud, wxContext), panelForbidden(), JSON.stringify(wxContext));
    assert.deepEqual(calls, []);
    assert.deepEqual(writes, []);
    assert.equal(databaseCalls, 0);
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
    module, setTimeout, clearTimeout, require(name) { assert.equal(name, 'crypto'); return require('node:crypto'); },
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

test('rejections, timeouts and synchronous SDK failures clean up proofs and return a generic unavailable result', async () => {
  for (const failure of [
    new Error('secret cloud request detail'),
    Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    'non-error SDK rejection',
  ]) {
    for (const callFunction of [async () => { throw failure; }, () => { throw failure; }]) {
      const app = cloudStub();
      app.cloud.callFunction = callFunction;
      const result = await authorizeControlPanel(app.cloud, { OPENID: 'admin-two' });
      assert.deepEqual(result, unavailable);
      assert.deepEqual(app.locks, []);
      assert.deepEqual(app.writes.map(write => write.action), ['set', 'remove']);
      assert.equal(JSON.stringify(result).includes(app.writes[0].id), false);
    }
  }
});

test('each operation creates a different proof and rechecks central access so revocation applies immediately', async () => {
  const response = { result: { success: true, data: { isAdmin: true } } };
  const app = cloudStub(response);
  assert.deepEqual(await authorizeControlPanel(app.cloud, { OPENID: 'admin-two' }), { success: true });
  response.result.data.isAdmin = false;
  assert.deepEqual(await authorizeControlPanel(app.cloud, { OPENID: 'admin-two' }), panelForbidden());
  assert.equal(app.calls.length, 2);
  assert.notEqual(app.calls[0].data.delegationId, app.calls[1].data.delegationId);
  assert.deepEqual(app.locks, []);
});

test('failed proof creation never calls adminManager or falls back to local authorization', async () => {
  const app = cloudStub(undefined, { authWriteError: new Error('private credential write failure') });
  assert.deepEqual(await authorizeControlPanel(app.cloud, { OPENID: 'admin-two' }), unavailable);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.locks, []);
});

test('callee consumption and cleanup failure do not expose a proof or replace the central decision', async () => {
  const consumed = cloudStub(undefined, { async beforeCall(request, authorization) {
    await authorization.db.collection('bijing_bindings').doc(request.data.delegationId).remove();
  } });
  assert.deepEqual(await authorizeControlPanel(consumed.cloud, { OPENID: 'admin-two' }), { success: true });
  assert.deepEqual(consumed.locks, []);
  for (const isAdmin of [true, false]) {
    const failedCleanup = cloudStub({ result: { success: true, data: { isAdmin } } },
      { authRemoveError: new Error('private proof cleanup failure') });
    assert.deepEqual(await authorizeControlPanel(failedCleanup.cloud, { OPENID: 'admin-two' }), isAdmin ? { success: true } : panelForbidden());
    assert.equal(failedCleanup.locks.length, 1);
    assert.equal(failedCleanup.locks[0].expiresAt - failedCleanup.locks[0].createdAt, 30000);
  }
});

test('stalled proof creation is bounded and never reaches the authorization endpoint', async () => {
  const module = { exports: {} }, timers = new Map();
  let handle = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared/maintenanceAuth'), 'utf8'), {
    module, require,
    setTimeout(callback, delay) { const id = ++handle; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  let calls = 0, removals = 0;
  const cloud = { database: () => ({ collection: () => ({ doc: () => ({
    set: () => new Promise(() => {}), async remove() { removals++; }
  }) }) }), async callFunction() { calls++; } };
  const pending = module.exports.authorizeControlPanel(cloud, { OPENID: 'admin-two' });
  const timeout = [...timers.values()].find(timer => timer.delay === 2000);
  assert.ok(timeout);
  timeout.callback();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), unavailable);
  assert.equal(calls, 0);
  assert.equal(removals, 1);
  assert.equal(timers.size, 0);
});

test('stalled cleanup cannot hold a completed central decision beyond its one-second allowance', async () => {
  for (const isAdmin of [true, false]) {
    const module = { exports: {} }, timers = new Map();
    let handle = 0;
    vm.runInNewContext(fs.readFileSync(require.resolve('../shared/maintenanceAuth'), 'utf8'), {
      module, require,
      setTimeout(callback, delay) { const id = ++handle; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); }
    });
    const cloud = { database: () => ({ collection: () => ({ doc: () => ({
      async set() {}, remove: () => new Promise(() => {})
    }) }) }), async callFunction() { return { result: { success: true, data: { isAdmin } } }; } };
    const pending = module.exports.authorizeControlPanel(cloud, { OPENID: 'admin-two' });
    for (let i = 0; i < 20 && ![...timers.values()].some(timer => timer.delay === 1000); i++) await Promise.resolve();
    const timeout = [...timers.values()].find(timer => timer.delay === 1000);
    assert.ok(timeout);
    timeout.callback();
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), isAdmin ? { success: true } : panelForbidden());
    assert.equal(timers.size, 0);
  }
});
