const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage(name = 'profile', options = {}) {
  const storage = { userOpenId: 'oz-account', userInfo: { nickName: '旧昵称', avatarUrl: 'cloud://old' }, userNickname: '旧昵称', ...options.storage };
  const calls = { cloud: [], toast: [], navigation: 0, migrations: 0 };
  let definition;
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { if (options.storageErrorKey === key) throw new Error('本机存储失败'); storage[key] = value; },
    showToast: value => calls.toast.push(value), showLoading() {}, hideLoading() {},
    showActionSheet: ({ success }) => success({ tapIndex: 1 }),
    chooseMedia: ({ success }) => { calls.avatarFlow = Promise.resolve(success({ tempFiles: [{ tempFilePath: 'tmp://avatar' }] })); },
    login: ({ success, fail }) => options.loginError ? fail(options.loginError) : success({ code: 'code' }),
    cloud: { callFunction(request) {
      calls.cloud.push(request.data);
      if (request.data.type === 'login') return Promise.resolve({ result: { success: true, openid: 'oz-account' } });
      if (options.transportError) { request.fail(options.transportError); return; }
      const reply = options.reply || { result: { success: true, data: { userInfo: { ...storage.userInfo, ...request.data.userInfo } } } };
      if (options.respond) return options.respond(request);
      request.success(reply);
    } }
  };
  const mocks = {
    '../../utils/contentSec.js': { checkText: options.checkText || (async () => options.safe !== false), checkImage: async () => options.imageResult || null },
    '../../utils/badgeManager.js': { migrateBadges: () => { calls.migrations++; } },
    '../../utils/badgeManager': {}, '../../utils/checkin.js': { isUserLoggedIn: () => true },
    '../../utils/dateUtil.js': {}, '../../utils/cloudApi.js': {},
    '../../utils/bijingApi.js': { bindBijing: options.bind || (async sn => ({ success: true, data: { studentNumber: sn, nickname: '绑定昵称', nicknameOverridden: true } })) }
  };
  const context = { wx, console: { log() {}, error() {}, warn() {} }, Date, setTimeout() {}, clearTimeout() {}, Page(value) { definition = value; }, require(name) {
    if (name === '../../utils/profileCache.js') {
      const cacheModule = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/profileCache.js'), 'utf8'), { wx, module: cacheModule });
      return cacheModule.exports;
    }
    assert.ok(name in mocks, name); return mocks[name];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${name}/${name}.js`), 'utf8'), context);
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch); } };
  page.showSuccessAndNavigate = () => { calls.navigation++; };
  page.checkBadgeAfterLogin = () => {};
  return { page, storage, calls };
}

test('all existing profile entry types initialise the existing name and avatar', () => {
  for (const userType of ['custom', 'edit', 'wechat', 'local']) {
    const { page } = createPage();
    page.data.userType = userType;
    page.initByUserType();
    assert.equal(page.data.nickname, '旧昵称', userType);
    assert.equal(page.data.avatarUrl, 'cloud://old', userType);
  }
});

test('rejected nickname ends loading and keeps the draft without cloud calls', async () => {
  const { page, calls } = createPage('profile', { safe: false });
  page.setData({ nickname: '草稿', isLoading: true });
  await page.saveUserInfo();
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.nickname, '草稿');
  assert.equal(calls.cloud.length, 0);
  assert.equal(calls.navigation, 0);
});

for (const [scenario, options] of Object.entries({ business: { reply: { result: { success: false, error: '拒绝保存' } } }, malformed: { reply: {} }, transport: { transportError: new Error('网络不可用') } })) {
  test(`${scenario} save failure does not repeat save, switch identity, or report success`, async () => {
    const { page, storage, calls } = createPage('profile', options);
    page.setData({ nickname: '新昵称', isLoading: true });
    await page.saveUserInfo();
    assert.equal(page.data.isLoading, false);
    assert.equal(page.data.nickname, '新昵称');
    assert.equal(storage.userOpenId, 'oz-account');
    assert.equal(storage.userInfo.nickName, '旧昵称');
    assert.equal(calls.cloud.filter(call => call.type === 'updateUserProfile').length, 1);
    assert.equal(calls.navigation, 0);
    assert.ok(calls.toast.some(toast => toast.icon === 'none'));
  });
}

test('login failure retains the current account and draft without a cloud save', async () => {
  const { page, storage, calls } = createPage('profile', { loginError: new Error('登录失败') });
  page.setData({ nickname: '新昵称', isLoading: true });
  await page.saveUserInfo();
  assert.equal(page.data.isLoading, false);
  assert.equal(storage.userInfo.nickName, '旧昵称');
  assert.equal(storage.userOpenId, 'oz-account');
  assert.equal(calls.cloud.length, 0);
  assert.equal(calls.navigation, 0);
});

test('nickname-only edit sends a patch and preserves the existing avatar and mirrors', async () => {
  const { page, storage, calls } = createPage('profile', { storage: { userLoginData: { openid: 'oz-account', userInfo: { nickName: '旧昵称', avatarUrl: 'cloud://old' }, extra: 'keep' } } });
  page.data.userType = 'edit'; page.initByUserType(); page.setData({ nickname: '新昵称' });
  await page.saveUserInfo();
  const sent = calls.cloud.find(call => call.type === 'updateUserProfile').userInfo;
  assert.equal(sent.nickName, '新昵称'); assert.equal(Object.hasOwn(sent, 'avatarUrl'), false);
  assert.equal(storage.userInfo.avatarUrl, 'cloud://old');
  assert.equal(storage.userInfo.nickName, '新昵称');
  assert.equal(storage.userNickname, '新昵称');
  assert.equal(storage.userLoginData.userInfo.nickName, '新昵称');
  assert.equal(storage.userLoginData.extra, 'keep');
  assert.equal(calls.navigation, 1);
});

test('binding then changing avatar cannot resend or resurrect the previous nickname', async () => {
  const { page, storage, calls } = createPage('me', { storage: { userLoginData: { openid: 'oz-account', userInfo: { nickName: '旧昵称' } } } });
  await page.doBindBijing('BJ123');
  assert.equal(storage.userInfo.nickName, '绑定昵称');
  assert.equal(storage.userLoginData.userInfo.nickName, '绑定昵称');
  await page.saveAvatarToStorage('cloud://new');
  const sent = calls.cloud.find(call => call.type === 'updateUserProfile').userInfo;
  assert.equal(Object.hasOwn(sent, 'nickName'), false);
  assert.equal(storage.userNickname, '绑定昵称');
  assert.equal(storage.userInfo.avatarUrl, 'cloud://new');
});

test('late avatar response cannot update another account cache', async () => {
  let respond;
  const { page, storage } = createPage('me', { respond: request => { respond = request.success; } });
  const saving = page.saveAvatarToStorage('cloud://new');
  storage.userOpenId = 'oz-other'; storage.userInfo = { nickName: '另一个账号', avatarUrl: 'cloud://other' }; storage.userNickname = '另一个账号';
  respond({ result: { success: true, data: { userInfo: { nickName: '旧昵称', avatarUrl: 'cloud://new' } } } });
  await saving;
  assert.equal(storage.userInfo.avatarUrl, 'cloud://other');
  assert.equal(storage.userNickname, '另一个账号');
});

async function waitForRequest(getRequest) {
  for (let i = 0; i < 10 && !getRequest(); i++) await Promise.resolve();
  assert.ok(getRequest(), 'cloud request should have started');
  return getRequest();
}

test('unexpected audit exception clears loading and retains the draft', async () => {
  const { page, calls } = createPage('profile', { checkText: async () => { throw new Error('审核暂不可用'); } });
  page.setData({ nickname: '草稿', isLoading: true });
  await page.saveUserInfo();
  assert.equal(page.data.isLoading, false); assert.equal(page.data.nickname, '草稿');
  assert.equal(calls.cloud.length, 0); assert.equal(calls.navigation, 0);
});

test('duplicate clicks cannot submit twice and failed save can be explicitly retried', async () => {
  const requests = [];
  const { page, calls } = createPage('profile', { respond: request => requests.push(request) });
  page.setData({ nickname: '草稿' });
  const first = page.saveUserInfo();
  await waitForRequest(() => requests[0]);
  assert.equal(await page.saveUserInfo(), false);
  requests[0].success({ result: { success: false, error: '临时失败' } });
  assert.equal(await first, false);
  assert.equal(page.data.nickname, '草稿');
  const second = page.saveProfile();
  await waitForRequest(() => requests[1]);
  requests[1].success({ result: { success: true, data: { userInfo: { nickName: '草稿' } } } });
  assert.equal(await second, true);
  assert.equal(calls.cloud.filter(call => call.type === 'updateUserProfile').length, 2);
  assert.equal(calls.navigation, 1);
});

test('late profile save response cannot update the newly active account or navigate', async () => {
  let request;
  const { page, storage, calls } = createPage('profile', { respond: value => { request = value; } });
  page.setData({ nickname: '草稿' });
  const saving = page.saveUserInfo();
  await waitForRequest(() => request);
  storage.userOpenId = 'oz-other'; storage.userInfo = { nickName: '另一个账号', avatarUrl: 'cloud://other' }; storage.userNickname = '另一个账号';
  request.success({ result: { success: true, data: { userInfo: { nickName: '草稿' } } } });
  assert.equal(await saving, false);
  assert.equal(storage.userInfo.nickName, '另一个账号');
  assert.equal(storage.userOpenId, 'oz-other');
  assert.equal(calls.navigation, 0); assert.equal(page.data.isLoading, false);
});

test('switching account while a profile edit page is open requires reopening', async () => {
  const { page, storage, calls } = createPage();
  page.initByUserType(); page.setData({ nickname: '旧账号草稿' }); storage.userOpenId = 'oz-other';
  assert.equal(await page.saveUserInfo(), false);
  assert.equal(calls.cloud.length, 0); assert.equal(page.data.nickname, '旧账号草稿');
});

test('failed avatar business response is unsynced and preserves the local change', async () => {
  const { page, storage } = createPage('me', { reply: { result: { success: false, error: '暂不可用' } } });
  assert.equal(await page.saveAvatarToStorage('cloud://new'), false);
  assert.equal(storage.userInfo.avatarUrl, 'cloud://new');
  assert.equal(storage.userInfo.nickName, '旧昵称');
  assert.equal(page.data.profileSyncError, '暂不可用');
});

test('late full avatar snapshot cannot reverse a nickname bound during its request', async () => {
  let request;
  const { page, storage } = createPage('me', { respond: value => { request = value; } });
  const saving = page.saveAvatarToStorage('cloud://new');
  await page.doBindBijing('BJ123');
  request.success({ result: { success: true, data: { userInfo: { nickName: '旧昵称', avatarUrl: 'cloud://new' } } } });
  assert.equal(await saving, true);
  assert.equal(storage.userInfo.nickName, '绑定昵称');
  assert.equal(storage.userNickname, '绑定昵称');
});

test('late binding response cannot write the new account nickname or page', async () => {
  let resolve;
  const { page, storage } = createPage('me', { bind: () => new Promise(done => { resolve = done; }) });
  const binding = page.doBindBijing('BJ123');
  storage.userOpenId = 'oz-other'; storage.userNickname = '另一账号'; storage.userInfo = { nickName: '另一账号' };
  resolve({ success: true, data: { studentNumber: 'BJ123', nicknameOverridden: true, nickname: '绑定昵称' } });
  await binding;
  assert.equal(storage.userNickname, '另一账号'); assert.equal(page.data.bijingBound, false);
});

test('failed avatar audit preserves the existing selected avatar', async () => {
  const { page } = createPage();
  page.initByUserType();
  await page.onChooseAvatar({ detail: { avatarUrl: 'tmp://candidate' } });
  assert.equal(page.data.avatarUrl, 'cloud://old'); assert.equal(page.data.isAvatarSelected, true);
});

test('avatar callback reports local write failure without falsely reporting local or cloud success', async () => {
  const { page, storage, calls } = createPage('me', { imageResult: 'cloud://new', storageErrorKey: 'userInfo' });
  page.setData({ userAvatar: 'cloud://old' });
  page.changeAvatar();
  await calls.avatarFlow;
  assert.equal(storage.userInfo.avatarUrl, 'cloud://old');
  assert.equal(page.data.userAvatar, 'cloud://old');
  assert.equal(calls.cloud.length, 0);
  assert.equal(calls.toast.at(-1).title, '头像保存失败，请重试');
  assert.equal(calls.toast.some(toast => /已保存到本机|修改成功/.test(toast.title)), false);
});

test('avatar callback distinguishes a successful local save from cloud business failure', async () => {
  const { page, storage, calls } = createPage('me', { imageResult: 'cloud://new', reply: { result: { success: false, error: '暂不可用' } } });
  page.changeAvatar();
  await calls.avatarFlow;
  assert.equal(storage.userInfo.avatarUrl, 'cloud://new');
  assert.equal(calls.toast.at(-1).title, '已保存到本机，云端尚未同步');
  assert.equal(calls.toast.some(toast => toast.title === '头像修改成功'), false);
});
