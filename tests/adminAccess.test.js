const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const { canRunMaintenance } = require('../shared/maintenanceAuth');
const { adminStudentNumbers } = require('../cloudfunctions/adminManager/studentAuth');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');

const DENIED = { success: true, data: { isAdmin: false } };
const ALLOWED = { success: true, data: { isAdmin: true } };
const UNAVAILABLE = { success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试' };
const idFor = (kind, value) => `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;
const user = (openid, studentNumber, extra = {}) => ({ _id: `user-${openid}`, _openid: openid,
  bijingBound: true, bijingStudentNumber: studentNumber, ...extra });
const defaultUsers = () => [user('admin-one', 'BJ0001'), user('admin-two', 'BJ0002')];
const registry = (profile, extra = {}) => ['student', 'account'].map(kind => ({
  _id: idFor(kind, kind === 'student' ? profile.bijingStudentNumber : profile._openid),
  kind, active: true, studentNumber: profile.bijingStudentNumber, openid: profile._openid,
  userId: profile._id, bindingVersion: profile.bijingBindingVersion, revision: 1, ...extra
}));
const delegation = (extra = {}) => {
  const now = Date.now();
  return { _id: `auth_${'a'.repeat(64)}`, kind: 'admin-delegation', openid: 'admin-one',
    audience: 'adminManager', createdAt: now - 1000, expiresAt: now + 29000, ...extra };
};
const delegatedEvent = proof => ({ type: 'getAccess', expectedOpenid: proof.openid, delegationId: proof._id });

function harness(wxContext = { OPENID: 'admin-one' }, environment = { ADMIN_STUDENT_NUMBERS: 'BJ0001,BJ0002' }, options = {}) {
  const exports = {};
  const authorization = createStudentAuthDatabase({ authUsers: defaultUsers(), ...options });
  let contextReads = 0;
  let databaseCalls = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: environment },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      if (name === './delegation') return require('../cloudfunctions/adminManager/delegation');
      if (name === './studentAuth') return require('../cloudfunctions/adminManager/studentAuth');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test',
        getWXContext() { contextReads++; return wxContext; },
        database() { databaseCalls++; return authorization.db; } };
    }
  });
  return { ...authorization,
    get conflicts() { return authorization.conflicts; },
    get contextReads() { return contextReads; }, get databaseCalls() { return databaseCalls; },
    async run(event = { type: 'getAccess' }) { return JSON.parse(JSON.stringify(await exports.main(event))); } };
}

test('administrator configuration normalizes student numbers and supports multiple administrators', async () => {
  for (const ADMIN_STUDENT_NUMBERS of ['BJ0001,BJ0002', ' bj0001 , BJ0002 ', 'BJ0001,BJ0002,BJ0001']) {
    assert.deepEqual(adminStudentNumbers({ ADMIN_STUDENT_NUMBERS }), ['BJ0001', 'BJ0002']);
    for (const OPENID of ['admin-one', 'admin-two', ' admin-one ']) {
      assert.deepEqual(await harness({ OPENID }, { ADMIN_STUDENT_NUMBERS }).run(), ALLOWED);
    }
  }
  assert.deepEqual(adminStudentNumbers({ ADMIN_STUDENT_NUMBERS: 'BJ2026_A-1' }), ['BJ2026_A-1']);
});

test('empty or malformed student configuration denies all without old OpenID or maintenance fallback', async () => {
  for (const ADMIN_STUDENT_NUMBERS of [undefined, null, 12, [], {}, '', ' ', ',', ',BJ0001', 'BJ0001,',
    'BJ0001,,BJ0002', 'BJ0001, ,BJ0002', 'BJ0001，BJ0002', 'BJ0001;BJ0002', 'BJ0001 BJ0002',
    'BJ0001,BJ 0002', 'BJ0001,BJ/0002', 'BJ0001,BJ\n0002', 'BJ', '12345', `BJ${'1'.repeat(63)}`]) {
    const environment = { ADMIN_STUDENT_NUMBERS, ADMIN_OPENIDS: 'admin-one,admin-two',
      ADMIN_OPENID: 'admin-one', MAINTENANCE_ADMIN_OPENIDS: 'admin-one' };
    for (const OPENID of ['admin-one', 'admin-two']) {
      const app = harness({ OPENID }, environment);
      assert.deepEqual(await app.run(), DENIED, JSON.stringify(ADMIN_STUDENT_NUMBERS));
      assert.equal(app.databaseCalls, 0);
    }
  }
});

test('invalid SDK identities deny access before all authorization database reads', async () => {
  for (const wxContext of [undefined, null, {}, { FROM_OPENID: 'admin-one' }, { SOURCE: 'wx_trigger' },
    ...[null, 12, [], {}, '', ' ', 'admin one', 'admin/one'].map(OPENID => ({ OPENID }))]) {
    // Explicit undefined context is represented by an absent SDK identity.
    const app = harness(wxContext === undefined ? {} : wxContext);
    assert.deepEqual(await app.run({ type: 'getAccess', OPENID: 'admin-one', studentNumber: 'BJ0001' }), DENIED);
    assert.equal(app.databaseCalls, 0);
  }
});

test('access returns only a boolean, never the configured students, accounts or profile fields', async () => {
  for (const [OPENID, expected] of [['admin-one', ALLOWED], ['admin-two', ALLOWED], ['outsider', DENIED]]) {
    const app = harness({ OPENID });
    assert.deepEqual(await app.run(), expected);
    assert.equal(app.contextReads, 1);
  }
});

test('only an authoritative active bound profile grants access, not request claims or profile privilege fields', async () => {
  for (const authUsers of [[], [user('outsider', 'BJ0099', { isAdmin: true, nickName: '管理员' })],
    [user('outsider', 'BJ0001', { bijingBound: false, isAdmin: true })]]) {
    const app = harness({ OPENID: 'outsider' }, undefined, { authUsers });
    assert.deepEqual(await app.run({ type: 'getAccess', OPENID: 'admin-one', openid: 'admin-one', FROM_OPENID: 'admin-one',
      studentNumber: 'BJ0001', ADMIN_STUDENT_NUMBERS: 'BJ0099', bijingBound: true, isAdmin: true,
      SOURCE: 'wx_client,scf', data: { OPENID: 'admin-one', studentNumber: 'BJ0001', isAdmin: true } }), DENIED);
  }
  const legitimate = harness({ OPENID: 'replacement' }, undefined, { authUsers: [user('replacement', ' bj0001 ')] });
  assert.deepEqual(await legitimate.run(), ALLOWED, 'student authorization follows the currently bound account');
});

test('expected identity can restrict a nested probe but can never replace the SDK identity', async () => {
  for (const OPENID of ['admin-one', ' admin-one ']) {
    const app = harness({ OPENID, SOURCE: 'wx_client,scf' });
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one' }), ALLOWED);
    for (const expectedOpenid of ['admin-two', ' admin-one ', '', null, 12, true, [], {}, ['admin-one']]) {
      assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid }), DENIED);
    }
  }
  for (const wxContext of [{}, { FROM_OPENID: 'admin-one', SOURCE: 'scf' },
    { OPENID: 'admin-two', SOURCE: 'wx_client,scf' }, { OPENID: 'outsider' }]) {
    assert.deepEqual(await harness(wxContext).run({ type: 'getAccess', expectedOpenid: 'admin-one', OPENID: 'admin-one' }), DENIED);
  }
});

test('student-list removal and unbinding revoke the next probe without an authorization cache', async () => {
  const environment = { ADMIN_STUDENT_NUMBERS: 'BJ0001,BJ0002', ADMIN_OPENIDS: 'admin-one' };
  const app = harness({ OPENID: 'admin-one' }, environment);
  assert.deepEqual(await app.run(), ALLOWED);
  environment.ADMIN_STUDENT_NUMBERS = 'BJ0002';
  assert.deepEqual(await app.run(), DENIED);
  environment.ADMIN_STUDENT_NUMBERS = 'BJ0001';
  assert.deepEqual(await app.run(), ALLOWED);
  app.users[0].bijingBound = false;
  assert.deepEqual(await app.run(), DENIED);
  app.users.push(user('replacement', 'BJ0001'));
  assert.deepEqual(await app.run(), DENIED);
  assert.deepEqual(await harness({ OPENID: 'replacement' }, environment, { authUsers: app.users }).run(), ALLOWED);
});

test('multiple active profiles for one account cannot choose an administrator binding', async () => {
  for (const number of ['BJ0001', 'BJ0002', 'BJ0099']) {
    const authUsers = [user('admin-one', 'BJ0001'), user('admin-one', number, { _id: 'other-profile' })];
    assert.deepEqual(await harness(undefined, undefined, { authUsers }).run(), DENIED);
  }
});

test('legacy duplicate student numbers fail closed for both accounts regardless of case or surrounding whitespace', async () => {
  const authUsers = [user('admin-one', 'BJ0001'), user('duplicate', ' bj0001 ')];
  for (const OPENID of ['admin-one', 'duplicate']) {
    const app = harness({ OPENID }, undefined, { authUsers });
    assert.deepEqual(await app.run(), DENIED);
    assert.equal(app.reads.some(read => read.filter && read.filter.bijingStudentNumber && read.limit === 2), true);
  }
});

test('managed bindings require both current ownership documents and the profile to agree', async () => {
  const profile = user('admin-one', 'BJ0001', { bijingBindingVersion: 'binding-current' });
  const app = harness(undefined, undefined, { authUsers: [profile], authLocks: registry(profile) });
  assert.deepEqual(await app.run(), ALLOWED);
  for (const index of [0, 1]) {
    for (const patch of [{ kind: 'history' }, { active: false }, { active: 'true' }, { openid: 'someone-else' },
      { userId: 'stale-profile' }, { studentNumber: 'BJ0002' }, { bindingVersion: 'old-binding' }, { bindingVersion: '' }]) {
      const authLocks = registry(profile);
      Object.assign(authLocks[index], patch);
      assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks }).run(), DENIED, JSON.stringify({ index, patch }));
    }
    const authLocks = registry(profile).filter((_, position) => position !== index);
    assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks }).run(), DENIED);
  }
  assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile] }).run(), DENIED);
});

test('a remaining unique legacy account may authorize after the other duplicate unbinds', async () => {
  const profile = user('admin-one', 'BJ0001');
  const other = user('previous-account', 'BJ0001', { bijingBindingVersion: '' });
  const authLocks = registry(other, { active: false, revision: 3 });
  const app = harness(undefined, undefined, { authUsers: [profile, { ...other, bijingBound: false }], authLocks });
  assert.deepEqual(await app.run(), ALLOWED);
  const ownTombstones = registry(profile, { active: false, bindingVersion: '', revision: 2 });
  assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks: [ownTombstones[0]] }).run(), DENIED);
  assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks: [ownTombstones[1]] }).run(), DENIED);
  assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks: registry(other) }).run(), DENIED);
  assert.deepEqual(await harness(undefined, undefined, { authUsers: [{ ...profile, bijingBindingVersion: 'stale' }], authLocks }).run(), DENIED);
});

test('legacy tombstone compatibility rejects malformed or unrelated ownership records', async () => {
  const profile = user('admin-one', 'BJ0001');
  const other = user('previous-account', 'BJ0001', { bijingBindingVersion: '' });
  for (const patch of [{ kind: undefined }, { kind: 'account' }, { active: undefined }, { active: 'false' },
    { studentNumber: undefined }, { studentNumber: 'BJ0002' }, { openid: undefined }, { openid: '' },
    { openid: 'invalid account' }, { userId: undefined }, { userId: '' }, { bindingVersion: undefined },
    { bindingVersion: null }, { revision: undefined }, { revision: 0 }, { revision: -1 },
    { revision: 1.5 }, { revision: '1' }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    const student = { ...registry(other, { active: false })[0], ...patch };
    assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks: [student] }).run(), DENIED,
      JSON.stringify(patch));
  }
});

test('managed student and account revisions must be positive safe integers', async () => {
  const profile = user('admin-one', 'BJ0001', { bijingBindingVersion: 'current' });
  for (const index of [0, 1]) {
    for (const revision of [undefined, null, 0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const authLocks = registry(profile);
      authLocks[index].revision = revision;
      assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile], authLocks }).run(), DENIED);
    }
  }
});

test('malformed profile versions cannot opt into the unversioned legacy path', async () => {
  for (const bijingBindingVersion of [null, false, 0, [], {}]) {
    const profile = user('admin-one', 'BJ0001', { bijingBindingVersion });
    assert.deepEqual(await harness(undefined, undefined, { authUsers: [profile] }).run(), DENIED);
  }
});

test('a student revision change during the duplicate query discards the authorization snapshot', async () => {
  const profile = user('admin-one', 'BJ0001', { bijingBindingVersion: 'current' });
  const app = harness(undefined, undefined, { authUsers: [profile], authLocks: registry(profile),
    authAfterRead(read, { locks }) {
      if (read.filter && read.filter.bijingStudentNumber) locks.find(lock => lock.kind === 'student').revision++;
    } });
  assert.deepEqual(await app.run(), DENIED);
});

test('transaction revalidation rejects unbinding, account replacement and student changes after the initial query', async () => {
  for (const patch of [{ bijingBound: false }, { _openid: 'replacement' }, { bijingStudentNumber: 'BJ0002' }]) {
    const app = harness(undefined, undefined, { authBeforeTransaction({ users }) { Object.assign(users[0], patch); } });
    assert.deepEqual(await app.run(), DENIED, JSON.stringify(patch));
  }
  const app = harness(undefined, undefined, { authBeforeTransaction({ users }) { users.shift(); } });
  assert.deepEqual(await app.run(), DENIED);
});

test('an ownership record appearing or disappearing during the query cannot authorize a mixed snapshot', async () => {
  const profile = user('admin-one', 'BJ0001');
  const other = user('previous-account', 'BJ0001', { bijingBindingVersion: '' });
  const tombstone = registry(other, { active: false })[0];
  for (const initiallyPresent of [false, true]) {
    const app = harness(undefined, undefined, { authUsers: [profile], authLocks: initiallyPresent ? [tombstone] : [],
      authAfterRead(read, { locks }) {
        if (!read.filter || !read.filter.bijingStudentNumber) return;
        if (initiallyPresent) locks.pop();
        else locks.push(tombstone);
      } });
    assert.deepEqual(await app.run(), DENIED);
  }
});

test('database errors, malformed query results and missing collections never authorize or reveal private details', async () => {
  for (const authDatabaseError of [new Error('private network failure'),
    { errCode: 'DATABASE_COLLECTION_NOT_EXIST', errMsg: 'private missing collection' },
    { errCode: -502003, errMsg: 'private permission failure' }]) {
    const app = harness(undefined, undefined, { authDatabaseError });
    assert.deepEqual(await app.run(), UNAVAILABLE);
  }
  for (const target of [1, 2, 3, 4, 5, 6]) {
    const app = harness(undefined, undefined, { authReadResult(read, result, count) { return count === target ? {} : result; } });
    assert.deepEqual(await app.run(), UNAVAILABLE, `malformed read ${target}`);
  }
  for (const data of [undefined, null, {}, 'private']) {
    const app = harness(undefined, undefined, { authReadResult(read, result) { return read.filter ? { data } : result; } });
    assert.deepEqual(await app.run(), UNAVAILABLE);
  }
  for (const data of [[], '', false, 0, 'private']) {
    const app = harness(undefined, undefined, { authReadResult(read, result) { return read.id ? { data } : result; } });
    assert.deepEqual(await app.run(), UNAVAILABLE);
  }
});

test('missing ownership documents support unique legacy profiles while a missing bound user is denied', async () => {
  const legacy = harness(undefined, undefined, { authReadResult(read, result) {
    if (read.id && read.name === 'bijing_bindings') throw { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' };
    return result;
  } });
  assert.deepEqual(await legacy.run(), ALLOWED);
  const missingUser = harness(undefined, undefined, { authReadResult(read, result) {
    if (read.id && read.name === 'users') throw { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' };
    return result;
  } });
  assert.deepEqual(await missingUser.run(), DENIED);
});

test('student-based panel access remains independent of maintenance and timer permission', async () => {
  const environment = { ADMIN_STUDENT_NUMBERS: 'BJ0001,BJ0002', MAINTENANCE_ADMIN_OPENIDS: 'maintenance-one,maintenance-two',
    BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger' };
  for (const OPENID of ['admin-one', 'admin-two']) {
    assert.deepEqual(await harness({ OPENID }, environment).run(), ALLOWED);
    assert.equal(canRunMaintenance({ OPENID }, environment), false);
  }
  for (const OPENID of ['maintenance-one', 'maintenance-two']) {
    assert.equal(canRunMaintenance({ OPENID }, environment), true);
    assert.deepEqual(await harness({ OPENID }, environment).run(), DENIED);
  }
  assert.equal(canRunMaintenance({ SOURCE: 'wx_trigger' }, environment, true), true);
  assert.deepEqual(await harness({ SOURCE: 'wx_trigger' }, environment).run(), DENIED);
});

test('unsupported access mutations fail before reading identity or the database', async () => {
  const app = harness();
  for (const event of [{}, { type: 'setAdmin', openid: 'other' }, null]) assert.equal((await app.run(event)).success, false);
  assert.equal(app.contextReads, 0);
  assert.equal(app.databaseCalls, 0);
});

test('a server-written one-time proof restores missing nested identity and never exposes the credential', async () => {
  const proof = delegation();
  const app = harness({ SOURCE: 'wx_client,scf' }, undefined, { authLocks: [proof] });
  assert.deepEqual(await app.run(delegatedEvent(proof)), ALLOWED);
  assert.deepEqual(app.locks, []);
  assert.equal(app.writes.filter(write => write.id === proof._id && write.action === 'remove' && write.inTransaction).length, 1);
  assert.deepEqual(await app.run(delegatedEvent(proof)), DENIED, 'replay cannot reuse a consumed proof');
});

test('simultaneous attempts to consume one delegation authorize at most one access probe', async () => {
  const proof = delegation();
  const app = harness({}, undefined, { authLocks: [proof] });
  const results = await Promise.all([app.run(delegatedEvent(proof)), app.run(delegatedEvent(proof))]);
  assert.equal(results.filter(result => result.success && result.data.isAdmin).length, 1);
  assert.equal(results.filter(result => result.success && !result.data.isAdmin).length, 1);
  assert.deepEqual(app.locks, []);
  assert.ok(app.conflicts > 0, 'the database model must exercise a real document conflict');
});

test('SDK identity and expected identity still restrict delegated identity instead of being replaced by it', async () => {
  for (const OPENID of ['admin-one', ' admin-one ']) {
    const proof = delegation();
    assert.deepEqual(await harness({ OPENID }, undefined, { authLocks: [proof] }).run(delegatedEvent(proof)), ALLOWED);
  }
  for (const OPENID of ['admin-two', 'outsider', '  ', 1, {}, []]) {
    const proof = delegation();
    const app = harness({ OPENID }, undefined, { authLocks: [proof] });
    assert.deepEqual(await app.run(delegatedEvent(proof)), DENIED);
    assert.equal(app.locks.length, 1, 'a mismatched platform identity cannot consume another account proof');
  }
  for (const expectedOpenid of ['admin-two', ' admin-one ', '', null, undefined, 1, {}, []]) {
    const proof = delegation();
    const app = harness({}, undefined, { authLocks: [proof] });
    assert.deepEqual(await app.run({ ...delegatedEvent(proof), expectedOpenid }), DENIED);
    assert.equal(app.locks.length, 1);
  }
});

test('empty nested SDK identity grants nothing unless a valid server proof supplies the identity', async () => {
  for (const OPENID of [undefined, null, '']) {
    const proof = delegation();
    const app = harness({ OPENID }, undefined, { authLocks: [proof] });
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one' }), DENIED);
    assert.deepEqual(await app.run(delegatedEvent(proof)), ALLOWED);
    assert.deepEqual(await app.run(delegatedEvent(proof)), DENIED);
  }
});

test('client claims, guessed tokens and scf source never create a valid delegation', async () => {
  const proof = delegation();
  for (const wxContext of [{}, { SOURCE: 'scf' }, { SOURCE: 'wx_client,scf' }, { OPENID: 'outsider' }]) {
    const app = harness(wxContext);
    assert.deepEqual(await app.run({ ...delegatedEvent(proof), OPENID: 'admin-one', SOURCE: 'scf',
      proof, data: { ...proof }, isAdmin: true }), DENIED);
    assert.deepEqual(app.writes, []);
  }
  for (const delegationId of ['', 'auth_admin-one', `auth_${'A'.repeat(64)}`, `auth_${'a'.repeat(63)}`,
    `auth_${'a'.repeat(65)}`, '../users/admin-one', null, undefined, 1, {}, []]) {
    const app = harness({ OPENID: 'admin-one' });
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one', delegationId }), DENIED);
    assert.equal(app.databaseCalls, 0, 'invalid token syntax cannot fall back to direct SDK access');
  }
});

test('delegations reject wrong scope, subject and malformed or expired time bounds', async () => {
  const now = Date.now();
  for (const patch of [{ kind: 'student' }, { kind: undefined }, { audience: 'teamManager' }, { audience: undefined },
    { openid: 'admin-two' }, { openid: undefined }, { createdAt: 0 }, { createdAt: -1 },
    { createdAt: String(now) }, { createdAt: null }, { createdAt: now + 60000, expiresAt: now + 90000 },
    { createdAt: now - 60000, expiresAt: now - 30000 }, { expiresAt: now },
    { createdAt: now - 1000, expiresAt: now - 1000 }, { createdAt: now - 1000, expiresAt: now + 30001 },
    { expiresAt: String(now + 30000) }, { expiresAt: null }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    const proof = delegation(patch);
    const app = harness({}, undefined, { authLocks: [proof] });
    assert.deepEqual(await app.run({ type: 'getAccess', expectedOpenid: 'admin-one', delegationId: proof._id }), DENIED,
      JSON.stringify(patch));
    assert.equal(app.writes.length, 0);
  }
});

test('valid delegation establishes identity but still checks the current configured student and binding', async () => {
  for (const options of [{ authUsers: [] }, { authUsers: [user('admin-one', 'BJ0099')] },
    { authUsers: [user('admin-one', 'BJ0001', { bijingBound: false })] },
    { authUsers: [user('admin-one', 'BJ0001'), user('duplicate', 'BJ0001')] }]) {
    const proof = delegation();
    const app = harness({}, undefined, { ...options, authLocks: [proof] });
    assert.deepEqual(await app.run(delegatedEvent(proof)), DENIED);
    assert.deepEqual(app.locks, [], 'denied subjects also consume their one-time proof');
  }
});

test('delegation cannot directly authorize record or alert endpoints', async () => {
  const proof = delegation();
  const app = harness({}, undefined, { authLocks: [proof] });
  for (const type of ['adminSearchUsers', 'adminGetDayRecords']) {
    assert.equal((await app.run({ ...delegatedEvent(proof), type })).code, 'FORBIDDEN');
  }
  assert.deepEqual(await app.run({ ...delegatedEvent(proof), type: 'getSyncAlert' }),
    { success: true, data: { isAdmin: false, hasErrors: false } });
  assert.deepEqual(app.reads, []);
  assert.equal(app.locks.length, 1);
});

test('delegation read, consume or commit failures fail closed without deleting or exposing the proof', async () => {
  for (const options of [{ authDatabaseError: new Error('private read failure') },
    { authRemoveError: new Error('private removal failure') }, { authCommitError: new Error('private commit failure') },
    { authReadResult() { return {}; } }, { authReadResult() { return { data: [] }; } }]) {
    const proof = delegation();
    const app = harness({}, undefined, { ...options, authLocks: [proof] });
    assert.deepEqual(await app.run(delegatedEvent(proof)), UNAVAILABLE);
    assert.equal(app.locks.length, 1);
  }
  const proof = delegation();
  const missing = harness({}, undefined, { authReadResult() { throw { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' }; } });
  assert.deepEqual(await missing.run(delegatedEvent(proof)), DENIED);
});
