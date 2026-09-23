const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createBindingMigration } = require('../cloudfunctions/adminManager/bindingMigration');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');
const { createBindingMigrationDatabase } = require('./helpers/bindingMigrationDatabase');

const source = fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const authorization = createStudentAuthDatabase(options);
  const database = createBindingMigrationDatabase({ users: [{ _id: 'user-existing', _openid: 'existing',
    bijingBound: true, bijingStudentNumber: 'BJ001', bijingSyncedDates: { '2026-09-20': true } }] });
  const context = options.context || { OPENID: 'admin', SOURCE: 'wx_client' };
  const calls = [];
  const exports = {};
  vm.runInNewContext(source, {
    exports, console: { error() {} },
    process: { env: options.environment || { ADMIN_STUDENT_NUMBERS: 'BJ0099' } },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test',
        database: () => authorization.db, getWXContext: () => context };
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      if (name === './studentAuth') return require('../cloudfunctions/adminManager/studentAuth');
      if (name === './delegation') return require('../cloudfunctions/adminManager/delegation');
      if (name === './bindingMigration') return { createBindingMigration({ db }) {
        assert.equal(db, authorization.db);
        const migration = createBindingMigration({ db: database.db });
        return { async run(input) { calls.push(plain(input)); return migration.run(input); } };
      } };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  return { database, calls, authorization, run: async event => plain(await exports.main(event)) };
}

test('the direct administrator migration route defaults to preview without changing existing bindings', async () => {
  const app = harness();
  const before = app.database.stored;
  const result = await app.run({ type: 'adminMigrateBindings' });
  assert.equal(result.success, true);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.wouldMigrate, 1);
  assert.equal(result.data.migrated, 0);
  assert.deepEqual(app.calls, [{}]);
  assert.deepEqual(app.database.stored, before);
  assert.deepEqual(app.database.calls.writes, []);
  assert.ok(app.authorization.reads.length > 0);
  assert.deepEqual(app.authorization.writes, []);
});

test('an explicit execution passes only migration options after direct administrator authorization', async () => {
  const app = harness({ context: { OPENID: 'second-admin', SOURCE: 'wx_client' },
    environment: { ADMIN_STUDENT_NUMBERS: 'BJ0002' } });
  const result = await app.run({ type: 'adminMigrateBindings', dryRun: false, cursor: 'before', limit: 7,
    OPENID: 'forged', expectedOpenid: 'forged', operator: 'forged', userId: 'forged', studentNumber: 'BJ999',
    users: [{ _openid: 'forged' }], delegationId: `auth_${'0'.repeat(64)}` });
  assert.equal(result.success, true);
  assert.equal(result.data.migrated, 1);
  assert.deepEqual(app.calls, [{ dryRun: false, cursor: 'before', limit: 7 }]);
  assert.equal(app.database.stored.users[0]._openid, 'existing');
  assert.equal(app.database.stored.users[0].bijingStudentNumber, 'BJ001');
  assert.equal(app.authorization.reads[0].filter._openid, 'second-admin');
  assert.deepEqual(app.authorization.writes, []);
});

test('ordinary callers, timers and forged administrator fields cannot preview or execute migration', async () => {
  for (const context of [{ OPENID: 'ordinary', SOURCE: 'wx_client' }, { SOURCE: 'wx_trigger' }, {},
    { OPENID: 'maintenance', SOURCE: 'wx_client' }]) {
    for (const dryRun of [true, false]) {
      const app = harness({ context, environment: { ADMIN_OPENID: 'ordinary', ADMIN_OPENIDS: 'ordinary,maintenance',
        ADMIN_STUDENT_NUMBERS: 'BJ0099', MAINTENANCE_ADMIN_OPENIDS: 'maintenance' } });
      const result = await app.run({ type: 'adminMigrateBindings', dryRun, OPENID: 'admin',
        expectedOpenid: 'admin', admin: true, bijingBound: true, studentNumber: 'BJ0099' });
      assert.equal(result.code, 'FORBIDDEN');
      assert.deepEqual(app.calls, []);
      assert.deepEqual(app.database.calls.queries, []);
      assert.deepEqual(app.database.calls.writes, []);
    }
  }
});

test('migration rejects an obsolete OpenID allowlist without administrator student numbers', async () => {
  const app = harness({ environment: { ADMIN_OPENID: 'admin', ADMIN_OPENIDS: 'admin', MAINTENANCE_ADMIN_OPENIDS: 'admin' } });
  assert.equal((await app.run({ type: 'adminMigrateBindings', dryRun: false })).code, 'FORBIDDEN');
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.database.calls.queries, []);
});

test('migration waits for identity verification and fails closed on unavailable or malformed authorization data', async () => {
  let release;
  const pendingAuthorization = new Promise(resolve => { release = resolve; });
  const app = harness({ authAfterRead: () => pendingAuthorization });
  const pending = app.run({ type: 'adminMigrateBindings', dryRun: false });
  for (let tick = 0; tick < 30 && app.authorization.reads.length === 0; tick++) await Promise.resolve();
  assert.ok(app.authorization.reads.length > 0);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.database.calls.queries, []);
  release();
  assert.equal((await pending).data.migrated, 1);

  for (const failure of [{ authDatabaseError: new Error('private authorization error') },
    { authReadResult: () => ({ data: 'invalid' }) }]) {
    const failed = harness(failure);
    const result = await failed.run({ type: 'adminMigrateBindings', dryRun: false });
    assert.equal(result.code, 'ADMIN_AUTH_UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.deepEqual(failed.calls, []);
    assert.deepEqual(failed.database.calls.queries, []);
  }
});

test('administrator unbinding between preview and execution revokes migration permission immediately', async () => {
  const app = harness();
  assert.equal((await app.run({ type: 'adminMigrateBindings' })).success, true);
  app.authorization.users.find(user => user._openid === 'admin').bijingBound = false;
  assert.equal((await app.run({ type: 'adminMigrateBindings', dryRun: false })).code, 'FORBIDDEN');
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.database.calls.writes, []);
});

test('an access-probe delegation cannot authorize migration without the direct SDK identity', async () => {
  const proof = { _id: `auth_${'a'.repeat(64)}`, kind: 'admin-delegation', audience: 'adminManager',
    openid: 'admin', createdAt: Date.now() - 1000, expiresAt: Date.now() + 29000 };
  const app = harness({ context: { SOURCE: 'wx_client,scf' }, authLocks: [proof] });
  const result = await app.run({ type: 'adminMigrateBindings', dryRun: false,
    expectedOpenid: 'admin', delegationId: proof._id, OPENID: 'admin' });
  assert.equal(result.code, 'FORBIDDEN');
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.authorization.writes, []);
  assert.deepEqual(app.database.calls.queries, []);
});

test('malformed migration options never fall back to execution', async () => {
  for (const options of [{ dryRun: 'false' }, { dryRun: null }, { limit: 21 }, { limit: 0 }, { cursor: {} }]) {
    const app = harness();
    const result = await app.run({ type: 'adminMigrateBindings', ...options });
    assert.equal(result.success, false);
    assert.deepEqual(app.database.calls.writes, []);
    assert.deepEqual(app.database.calls.queries, []);
  }
});
