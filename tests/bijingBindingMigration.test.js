const assert = require('node:assert/strict');
const test = require('node:test');
const { createBindingMigration } = require('../cloudfunctions/adminManager/bindingMigration');
const { bindingId, createBindings, normalizeStudentNumber } = require('../cloudfunctions/bijingSync/bindings');
const { canManageControlPanel } = require('../cloudfunctions/adminManager/studentAuth');
const { createBindingMigrationDatabase } = require('./helpers/bindingMigrationDatabase');

const profile = (openid = 'a', extra = {}) => ({ _id: `user-${openid}`, _openid: openid,
  bijingBound: true, bijingStudentNumber: 'BJ001', ...extra });
const registry = (user, extra = {}) => ['student', 'account'].map(kind => ({
  _id: bindingId(kind, kind === 'student' ? normalizeStudentNumber(user.bijingStudentNumber) : user._openid),
  kind, studentNumber: normalizeStudentNumber(user.bijingStudentNumber), openid: user._openid,
  userId: user._id, bindingVersion: user.bijingBindingVersion || '', active: true, revision: 1, ...extra
}));

function harness(initial, options) {
  const database = createBindingMigrationDatabase(initial, options);
  const migration = createBindingMigration({ db: database.db, now: () => new Date('2026-09-23T02:00:00Z') });
  const bindings = createBindings({ db: database.db, checkStudentExists: async () => ({ success: true, data: {} }) });
  return { database, ...migration, ...bindings };
}

function assertManaged(database, userId) {
  const state = database.stored;
  const user = state.users.find(row => row._id === userId);
  assert.equal(user.bijingBound, true);
  assert.equal(typeof user.bijingBindingVersion, 'string');
  assert.ok(user.bijingBindingVersion);
  for (const expected of registry(user)) {
    const entry = state.bijing_bindings.find(row => row._id === expected._id);
    for (const field of ['kind', 'studentNumber', 'openid', 'userId', 'bindingVersion', 'active']) {
      assert.deepEqual(entry[field], expected[field], field);
    }
    assert.ok(Number.isSafeInteger(entry.revision) && entry.revision > 0);
  }
}

test('migration defaults to a read-only preview, then preserves every existing profile field and meditation record', async () => {
  const original = profile('a', { bijingStudentNumber: ' bj001 ', nickName: '已有昵称', avatarUrl: '/avatar.png',
    bijingBoundAt: new Date('2021-01-02T03:04:05Z'), bijingSyncedDates: { '2026-09-20': true },
    lastUpdateTime: new Date('2024-02-01T00:00:00Z'), unrelated: { value: 4 } });
  const records = [{ _id: 'record-a', _openid: 'a', duration: 30 }];
  const history = { _id: 'history-old', kind: 'history', openid: 'a', profiles: [] };
  const app = harness({ users: [original], meditation_records: records, bijing_bindings: [history] });
  const before = app.database.stored;
  const preview = await app.run({});
  assert.equal(preview.dryRun, true);
  assert.equal(preview.scanned, 1);
  assert.equal(preview.items[0].status, 'would_migrate');
  assert.deepEqual(app.database.stored, before);
  assert.deepEqual(app.database.calls.writes, []);

  const result = await app.run({ dryRun: false });
  assert.equal(result.migrated, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(result.items[0].status, 'migrated');
  assertManaged(app.database, original._id);
  const { bijingBindingVersion, ...preserved } = app.database.stored.users[0];
  assert.deepEqual(preserved, original);
  assert.deepEqual(app.database.stored.meditation_records, records);
  assert.deepEqual(app.database.stored.bijing_bindings.find(row => row.kind === 'history'), history);
});

test('rerunning migration keeps versions and revisions unchanged and makes no further writes', async () => {
  const app = harness({ users: [profile()] });
  await app.run({ dryRun: false });
  const before = app.database.stored;
  const writes = app.database.calls.writes.length;
  const result = await app.run({ dryRun: false });
  assert.equal(result.migrated, 0);
  assert.equal(result.alreadyManaged, 1);
  assert.equal(result.items[0].status, 'already_managed');
  assert.deepEqual(app.database.stored, before);
  assert.equal(app.database.calls.writes.length, writes);
});

test('already managed bindings remain untouched, and an existing valid version is preserved when adopting missing reservations', async () => {
  const user = profile('a', { bijingBindingVersion: 'existing-version' });
  for (const bijing_bindings of [[], registry(user, { revision: 8 })]) {
    const app = harness({ users: [user], bijing_bindings });
    const result = await app.run({ dryRun: false });
    assert.equal(result.conflicts, 0);
    assert.equal(app.database.stored.users[0].bijingBindingVersion, 'existing-version');
    assertManaged(app.database, user._id);
    if (bijing_bindings.length) assert.deepEqual(app.database.stored.bijing_bindings, bijing_bindings);
  }
});

test('migration retains central administrator access and a current-version unbind works without rebinding', async () => {
  const app = harness({ users: [profile()] });
  const allowed = () => canManageControlPanel({ OPENID: 'a' }, { ADMIN_STUDENT_NUMBERS: 'BJ001' }, () => app.database.db);
  assert.equal(await allowed(), true);
  await app.run({ dryRun: false });
  assert.equal(await allowed(), true);
  const version = app.database.stored.users[0].bijingBindingVersion;
  assert.equal((await app.unbind('a', 'BJ001')).code, 'BINDING_STALE');
  assert.equal((await app.unbind('a', 'BJ001', version)).success, true);
  assert.equal(await allowed(), false);
});

test('duplicate student numbers and multiple active profiles for an account are reported without choosing an owner', async () => {
  for (const users of [
    [profile(), profile('b', { bijingStudentNumber: ' bj001 ' })],
    [profile(), profile('a', { _id: 'duplicate-a' })],
    [profile(), profile('a', { _id: 'duplicate-a', bijingStudentNumber: 'BJ002' })]
  ]) {
    const app = harness({ users });
    const before = app.database.stored;
    const result = await app.run({ dryRun: false });
    assert.equal(result.conflicts, 2);
    assert.ok(result.items.every(row => row.status === 'conflict'));
    assert.deepEqual(app.database.stored, before);
    assert.deepEqual(app.database.calls.writes, []);
  }
});

test('invalid legacy identities and versions are reported while unbound profiles are excluded', async () => {
  for (const patch of [{ _openid: '' }, { bijingStudentNumber: '' }, { bijingStudentNumber: 'invalid' },
    { bijingBindingVersion: null }, { bijingBindingVersion: false }, { bijingBindingVersion: {} }]) {
    const app = harness({ users: [profile('a', patch), profile('unbound', { bijingBound: false })] });
    const before = app.database.stored;
    const result = await app.run({ dryRun: false });
    assert.equal(result.scanned, 1);
    assert.equal(result.conflicts, 1);
    assert.deepEqual(app.database.stored, before);
  }
});

test('foreign or malformed live reservations and own-account tombstones are never overwritten', async () => {
  const user = profile('a', { bijingBindingVersion: 'version-a' });
  for (const index of [0, 1]) {
    for (const patch of [{ openid: 'other' }, { userId: 'other-profile' }, { studentNumber: 'BJ002' },
      { bindingVersion: 'other-version' }, { kind: 'history' }, { active: 'true' }, { revision: 0 },
      { revision: '1' }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      const bijing_bindings = registry(user);
      Object.assign(bijing_bindings[index], patch);
      const app = harness({ users: [user], bijing_bindings });
      const before = app.database.stored;
      const result = await app.run({ dryRun: false });
      assert.equal(result.conflicts, 1, JSON.stringify({ index, patch }));
      assert.deepEqual(app.database.stored, before);
    }
  }
  const app = harness({ users: [profile()], bijing_bindings: [registry(profile(), { active: false })[1]] });
  const before = app.database.stored;
  assert.equal((await app.run({ dryRun: false })).conflicts, 1);
  assert.deepEqual(app.database.stored, before);
});

test('the remaining unique legacy owner can adopt another account’s valid student tombstone', async () => {
  const other = profile('former-owner');
  const student = registry(other, { active: false, revision: 4 })[0];
  const app = harness({ users: [profile(), { ...other, bijingBound: false }], bijing_bindings: [student] });
  const result = await app.run({ dryRun: false });
  assert.equal(result.migrated, 1);
  assertManaged(app.database, 'user-a');
  assert.equal(app.database.stored.bijing_bindings.find(row => row.kind === 'student').revision, 5);
});

test('two simultaneous migrations produce one stable binding through an optimistic conflict', async () => {
  const app = harness({ users: [profile()] });
  const results = await Promise.all([app.run({ dryRun: false }), app.run({ dryRun: false })]);
  assert.equal(results.reduce((count, result) => count + result.migrated, 0), 1);
  assertManaged(app.database, 'user-a');
  assert.equal(app.database.stored.bijing_bindings.length, 2);
  assert.ok(app.database.calls.conflicts > 0);
});

test('migration and an ordinary bind of the same existing account converge on one version', async () => {
  const app = harness({ users: [profile()] });
  const [migration, bound] = await Promise.all([app.run({ dryRun: false }), app.bind('a', 'BJ001')]);
  assert.equal(bound.success, true);
  assert.equal(migration.conflicts, 0);
  assertManaged(app.database, 'user-a');
  assert.equal(app.database.stored.bijing_bindings.length, 2);
  assert.equal(app.database.stored.users[0].bijingBindingVersion, bound.data.bindingVersion);
});

test('concurrent legacy unbind and migration never resurrect an unbound profile or release a migrated binding with a stale request', async () => {
  const app = harness({ users: [profile()] });
  const [, unbound] = await Promise.all([app.run({ dryRun: false }), app.unbind('a', 'BJ001')]);
  const user = app.database.stored.users[0];
  if (unbound.success) {
    assert.equal(user.bijingBound, false);
    assert.ok(app.database.stored.bijing_bindings.filter(row => row.kind !== 'history').every(row => row.active === false));
  } else {
    assert.equal(unbound.code, 'BINDING_STALE');
    assertManaged(app.database, 'user-a');
  }
});

test('a profile unbound after the scan is not migrated back into an active binding', async () => {
  let changed = false;
  const app = harness({ users: [profile()] }, { beforeTransaction(stored) {
    if (changed) return;
    changed = true;
    Object.assign(stored.users[0], { bijingBound: false, bijingStudentNumber: '', bijingBindingVersion: '' });
  } });
  const result = await app.run({ dryRun: false });
  assert.equal(result.migrated, 0);
  assert.equal(app.database.stored.users[0].bijingBound, false);
  assert.deepEqual(app.database.stored.bijing_bindings, []);
});

test('database write and commit failures roll back the version and both reservations together', async () => {
  for (const options of [{ failWrite: 'users:update' }, { failWrite: 'bijing_bindings:set' }, { failCommit: true },
    { missingCollection: 'bijing_bindings' }, { failRead: 'bijing_bindings' }]) {
    const app = harness({ users: [profile()] }, options);
    const before = app.database.stored;
    await assert.rejects(app.run({ dryRun: false }));
    assert.deepEqual(app.database.stored, before);
    assert.deepEqual(app.database.calls.committedWrites, []);
  }
});

test('cursor pagination migrates more than 100 existing users exactly once', async () => {
  const users = Array.from({ length: 137 }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    return profile(`account-${suffix}`, { _id: `user-${suffix}`, bijingStudentNumber: `BJ${suffix}` });
  });
  const app = harness({ users });
  let cursor = '', scanned = 0, migrated = 0;
  const visited = new Set();
  for (let page = 0; page < 10; page++) {
    const result = await app.run({ dryRun: false, limit: 17, cursor });
    assert.ok(result.scanned <= 17);
    scanned += result.scanned;
    migrated += result.migrated;
    for (const item of result.items) {
      assert.equal(visited.has(item.userId), false);
      visited.add(item.userId);
    }
    if (!result.hasMore) break;
    assert.equal(typeof result.nextCursor, 'string');
    assert.ok(result.nextCursor > cursor);
    cursor = result.nextCursor;
  }
  assert.equal(scanned, 137);
  assert.equal(migrated, 137);
  assert.equal(visited.size, 137);
  assert.equal(app.database.stored.bijing_bindings.length, 274);
  for (const user of users) assertManaged(app.database, user._id);
});

test('duplicate detection reads all of an account’s profiles beyond a 100-document page', async () => {
  const users = Array.from({ length: 103 }, (_, index) => profile('a', { _id: `profile-${String(index).padStart(4, '0')}`,
    bijingBound: index === 0 || index === 102 }));
  const app = harness({ users });
  const before = app.database.stored;
  assert.equal((await app.run({ dryRun: false })).conflicts, 2);
  assert.deepEqual(app.database.stored, before);
});
