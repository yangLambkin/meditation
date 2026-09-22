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
