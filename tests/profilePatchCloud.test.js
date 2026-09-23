const test = require('node:test');
const assert = require('node:assert/strict');
const { updateUserProfile } = require('../cloudfunctions/meditationManager/profile');
function database(initial) {
  let user = initial && { _id: 'doc-1', _openid: 'oz-account', loginCount: 8, bijingStudentNumber: 'BJ123', ...initial };
  const writes = [], queries = [];
  const db = { command: { inc: value => ({ inc: value }) }, collection(name) {
    assert.equal(name, 'users');
    return {
      where(filter) { queries.push(filter); return { async get() { return { data: user ? [{ ...user }] : [] }; } }; },
      doc(id) { assert.equal(id, 'doc-1'); return { async update({ data }) { writes.push(data); user = { ...user, ...data }; }, async get() { return { data: { ...user } }; } }; },
      async add({ data }) { writes.push(data); user = { _id: 'doc-1', ...data }; return { _id: 'doc-1' }; }
    };
  } };
  return { db, writes, queries, user: () => user };
}

test('avatar patch preserves omitted name and metadata without counting a login', async () => {
  const state = database({ nickName: '绑定昵称', avatarUrl: 'cloud://old', profileComplete: true, dataSource: 'wechat', lastLoginTime: 'before' });
  const result = await updateUserProfile({ db: state.db, openid: 'oz-account', userInfo: { avatarUrl: 'cloud://new' } });
  assert.equal(result.success, true);
  assert.equal(state.user().nickName, '绑定昵称');
  assert.equal(state.user().dataSource, 'wechat');
  assert.equal(state.user().loginCount, 8);
  assert.equal(state.user().lastLoginTime, 'before');
  assert.equal(result.data.userInfo.nickName, '绑定昵称');
  assert.equal(result.data.userInfo.avatarUrl, 'cloud://new');
  assert.equal(Object.hasOwn(result.data.userInfo, 'bijingStudentNumber'), false);
});

test('nickname patch preserves avatar and ignores client-supplied identity and privileged fields', async () => {
  const state = database({ nickName: '旧昵称', avatarUrl: 'cloud://old' });
  const result = await updateUserProfile({ db: state.db, openid: 'oz-account', userInfo: { nickName: ' 新昵称 ', _openid: 'oz-victim', loginCount: 100, bijingBound: true } });
  assert.equal(result.success, true);
  assert.equal(state.user().nickName, '新昵称');
  assert.equal(state.user().avatarUrl, 'cloud://old');
  assert.equal(state.user()._openid, 'oz-account');
  assert.equal(state.user().loginCount, 8);
  assert.equal(state.user().bijingBound, undefined);
  assert.equal(state.queries[0]._openid, 'oz-account');
});

test('legacy full userInfo requests remain supported', async () => {
  const state = database({ nickName: '旧昵称', avatarUrl: 'cloud://old' });
  const result = await updateUserProfile({ db: state.db, openid: 'oz-account', userInfo: { nickName: '微信昵称', avatarUrl: 'https://example.com/avatar', gender: 1, isCustomAvatar: false, profileComplete: true, country: '中国', dataSource: 'wechat', migrationStatus: 'migrated', createTime: 'untrusted' } });
  assert.equal(result.success, true);
  assert.equal(state.user().gender, 1);
  assert.equal(state.user().isCustomAvatar, false);
  assert.equal(state.user().createTime, undefined);
});

test('only creation fills absent defaults', async () => {
  const state = database();
  const result = await updateUserProfile({ db: state.db, openid: 'oz-account', userInfo: { nickName: '新用户' } });
  assert.equal(result.success, true);
  assert.equal(state.user().nickName, '新用户');
  assert.equal(state.user().avatarUrl, '/images/avatar.png');
  assert.equal(state.user().loginCount, 0);
});

for (const userInfo of [null, [], { nickName: '' }, { nickName: null }, { avatarUrl: '' }, { avatarUrl: null }, { profileComplete: null }, { isCustomAvatar: 'yes' }]) {
  test(`invalid profile patch is rejected without writes: ${JSON.stringify(userInfo)}`, async () => {
    const state = database({ nickName: '旧昵称', avatarUrl: 'cloud://old' });
    const result = await updateUserProfile({ db: state.db, openid: 'oz-account', userInfo });
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_PROFILE');
    assert.equal(state.writes.length, 0);
  });
}

test('missing platform identity rejects before database access', async () => {
  const state = database({ nickName: '旧昵称' });
  const result = await updateUserProfile({ db: state.db, openid: '', userInfo: { nickName: '新昵称' } });
  assert.equal(result.code, 'UNAUTHORIZED');
  assert.equal(state.queries.length, 0); assert.equal(state.writes.length, 0);
});

test('the deployed entry routes profile patches through platform identity instead of event identity', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const state = database({ nickName: '当前用户', avatarUrl: 'cloud://old' });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './profile') return { updateUserProfile };
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => state.db, getWXContext: () => ({ OPENID: 'oz-account' }) };
    }
  });
  const result = await module.exports.main({
    type: 'updateUserProfile', openid: 'oz-victim',
    userInfo: { avatarUrl: 'cloud://new', _openid: 'oz-victim' }
  });
  assert.equal(result.success, true);
  assert.equal(result.data.openid, 'oz-account');
  assert.equal(state.user()._openid, 'oz-account');
  assert.equal(state.user().nickName, '当前用户');
  assert.equal(state.user().avatarUrl, 'cloud://new');
});

function profileReadHarness(rows, options = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const queries = [];
  const db = { command: { gt: value => ({ gt: value }) }, collection(name) {
    assert.equal(name, 'users');
    return { where(filter) {
      const orderings = [];
      let limit = 20;
      return {
        orderBy(field, direction) { orderings.push([field, direction]); return this; },
        limit(value) { limit = value; return this; },
        async get() {
          queries.push({ filter: JSON.parse(JSON.stringify(filter)), orderings, limit });
          if (options.failOnPage === queries.length) throw new Error('profile read unavailable');
          const matches = rows.filter(row => row._openid === filter._openid && (!filter._id || row._id > filter._id.gt));
          matches.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
          return { data: matches.slice(0, limit).map(row => ({ ...row })) };
        }
      };
    } };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    require(name) {
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => db, getWXContext: () => ({ OPENID: Object.hasOwn(options, 'openid') ? options.openid : 'owner' }) };
    }
  });
  return { queries, async read(extra = {}) {
    return JSON.parse(JSON.stringify(await module.exports.main({ type: 'getUserProfile', ...extra })));
  } };
}

test('profile reads find an active binding beyond an entire page of older unbound duplicates', async () => {
  const rows = Array.from({ length: 105 }, (_, index) => ({
    _id: `profile-${String(index).padStart(3, '0')}`, _openid: 'owner', nickName: '旧资料', bijingBound: false
  }));
  const active = { _id: 'profile-999', _openid: 'owner', nickName: '当前绑定', bijingBound: true,
    bijingStudentNumber: 'BJ2407159', bijingBindingVersion: 'current-version' };
  const app = profileReadHarness([...rows, active, { ...active, _id: 'profile-000', _openid: 'other' }]);
  const result = await app.read({ openid: 'other', _openid: 'other' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, active);
  assert.equal(app.queries.length, 2);
  assert.ok(app.queries.every(query => query.filter._openid === 'owner'));
  assert.deepEqual(app.queries.map(query => query.orderings), [[['_id', 'asc']], [['_id', 'asc']]]);
});

test('profile reads consistently show the first active duplicate so its unbind action remains available', async () => {
  const first = { _id: 'b', _openid: 'owner', bijingBound: true, bijingStudentNumber: 'BJ0001', bijingBindingVersion: 'v1' };
  const rows = [
    { _id: 'a', _openid: 'owner', nickName: '未绑定旧资料' },
    first,
    { _id: 'c', _openid: 'owner', bijingBound: true, bijingStudentNumber: 'BJ0002', bijingBindingVersion: 'v2' }
  ];
  for (const input of [rows, [...rows].reverse()]) {
    const result = await profileReadHarness(input).read();
    assert.equal(result.success, true);
    assert.deepEqual(result.data, first);
  }
});

test('profiles with no binding consistently return the canonical oldest id and retain the empty-profile contract', async () => {
  const rows = [{ _id: 'z', _openid: 'owner', nickName: 'later', bijingBound: false },
    { _id: 'a', _openid: 'owner', nickName: 'canonical', bijingBound: false }];
  assert.deepEqual((await profileReadHarness(rows).read()).data, rows[1]);
  const empty = await profileReadHarness([]).read();
  assert.equal(empty.success, true);
  assert.equal(empty.data, null);
});

test('profile read failures do not report an unbound fallback and missing SDK identity performs no read', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ _id: `p-${String(index).padStart(3, '0')}`, _openid: 'owner' }));
  const failed = await profileReadHarness(rows, { failOnPage: 2 }).read();
  assert.equal(failed.success, false);
  assert.match(failed.error, /unavailable/);
  const anonymous = profileReadHarness(rows, { openid: '' });
  assert.equal((await anonymous.read({ openid: 'owner' })).code, 'AUTH_REQUIRED');
  assert.equal(anonymous.queries.length, 0);
});

test('a versioned active profile after page one takes precedence over earlier legacy active rows', async () => {
  const legacy = { _id: 'profile-000', _openid: 'owner', nickName: '旧绑定', bijingBound: true,
    bijingStudentNumber: 'BJ2407159' };
  const others = Array.from({ length: 104 }, (_, index) => ({
    _id: `profile-${String(index + 1).padStart(3, '0')}`, _openid: 'owner', bijingBound: false
  }));
  const current = { _id: 'profile-999', _openid: 'owner', nickName: '新版绑定', bijingBound: true,
    bijingStudentNumber: 'BJ2407159', bijingBindingVersion: 'current-binding-version' };
  const app = profileReadHarness([current, ...others, legacy]);
  const result = await app.read();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, current);
  assert.equal(result.data.bijingBindingVersion, 'current-binding-version', 'the page must receive the token required to unbind both rows');
  assert.equal(app.queries.length, 2);
});

test('an unbound row with a historical token never overrides the active legacy binding', async () => {
  const legacy = { _id: 'a', _openid: 'owner', bijingBound: true, bijingStudentNumber: 'BJ2407159' };
  const old = { _id: 'b', _openid: 'owner', bijingBound: false, bijingStudentNumber: '', bijingBindingVersion: 'old-token' };
  assert.deepEqual((await profileReadHarness([old, legacy]).read()).data, legacy);
});
