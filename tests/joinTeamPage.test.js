const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/joinTeam/joinTeam.js');
const preview = { _id: 'team-a', name: '一起冥想', isMember: false, members: [{ nickname: '团长', isCreator: true }] };
const success = data => ({ result: { success: true, data } });

function createPage({ cloud, openid = 'wechat-any-prefix', stored = {}, refresh } = {}) {
  let definition;
  const storage = new Map(Object.entries({ userOpenId: openid, ...stored }));
  const calls = { cloud: [], navigate: [], redirects: [], modals: [], toasts: [], joined: [], refresh: 0, hiddenShares: [] };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (!name.endsWith('/teamManager.js')) throw new Error(name);
      return {
        addJoinedTeam(team) { calls.joined.push(team); },
        async loadTeamsFromCloud() { calls.refresh++; return refresh ? refresh() : { success: true }; },
        loadTeamsFromStorage: () => [preview],
        loadJoinedTeamsFromStorage: () => [preview]
      };
    },
    Page(value) { definition = value; },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      cloud: { async callFunction(request) {
        calls.cloud.push(request.data);
        return cloud ? cloud(request.data.type, request.data.data) : success(structuredClone(preview));
      } },
      setNavigationBarTitle() {},
      hideShareMenu: options => calls.hiddenShares.push(options),
      showToast: options => calls.toasts.push(options),
      showModal: options => calls.modals.push(options),
      redirectTo: options => calls.redirects.push(options),
      navigateTo(options) { calls.navigate.push(options); if (options.complete) options.complete(); },
      showLoading() {}, hideLoading() {}
    },
    console: { log() {}, warn() {}, error() {} }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  return { page, calls, storage };
}

test('invitation preview trusts the current server membership and never invents checkin counts', async () => {
  const { page, calls } = createPage();
  await page.onLoad({ teamId: 'team-a', teamName: '冥想100%' });
  assert.equal(page.data.teamName, '冥想100%');
  assert.equal(page.data.isMember, false);
  assert.equal(page.data.members[0].checkInCount, 0);
  assert.equal(page.data.statsAvailable, false);
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo']);
});

test('network or deleted-team errors discard the preview and allow an explicit retry', async () => {
  let fails = true;
  const { page } = createPage({ cloud: () => fails ? Promise.reject(new Error('网络不可用')) : success(preview) });
  await page.onLoad({ teamId: 'team-a' });
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.loadError, '网络不可用');
  assert.equal(page.data.isLoading, false);
  fails = false;
  await page.refreshTeam();
  assert.equal(page.data.teamInfo._id, 'team-a');
  assert.equal(page.data.loadError, '');
});

test('only a real stored cloud identity counts as login regardless of its WeChat prefix', async () => {
  const { page, storage } = createPage({ openid: 'oOtherPrefix123' });
  assert.equal(page.hasUserInfo(), true);
  storage.set('userOpenId', 'local_123');
  storage.set('userNickname', '已有昵称');
  storage.set('userInfo', { nickName: '已有昵称' });
  assert.equal(page.hasUserInfo(), false);
  storage.delete('userOpenId');
  assert.equal(page.hasUserInfo(), false);
});

test('the login round trip retains invite attribution and resumes the previously confirmed join', async () => {
  const first = createPage({ openid: 'local_123' });
  await first.page.onLoad({ teamId: 'team-a', inviteId: 'invite-123', inviterId: 'owner' });
  await first.page.joinTeam();
  assert.equal(first.calls.navigate.length, 1);
  const pending = first.storage.get('pendingTeamInvitation');
  assert.equal(pending.inviteId, 'invite-123');
  const returned = createPage({ stored: { pendingTeamInvitation: pending }, cloud: type => success(type === 'getTeamInfo' ? preview : {}) });
  // Existing profile returns only teamId after registration.
  await returned.page.onLoad({ teamId: 'team-a' });
  const join = returned.calls.cloud.find(call => call.type === 'joinTeam');
  assert.equal(join.data.inviteId, 'invite-123');
  assert.equal(join.data.inviterId, 'owner');
  assert.equal(returned.page.data.isMember, true);
  assert.equal(returned.storage.has('pendingTeamInvitation'), false);
  assert.equal(returned.calls.redirects.length, 1);
});

test('expired pending invitations do not automatically join a team', async () => {
  const { page, calls } = createPage({ stored: { pendingTeamInvitation: { teamId: 'team-a', expiresAt: Date.now() - 1 } } });
  await page.onLoad({ teamId: 'team-a' });
  assert.equal(calls.cloud.some(call => call.type === 'joinTeam'), false);
});

test('joining is single-flight and a failed request preserves the preview and permits retry', async () => {
  let resolveJoin;
  const { page, calls } = createPage({ cloud: type => type === 'getTeamInfo' ? success(preview) : new Promise(resolve => { resolveJoin = resolve; }) });
  await page.onLoad({ teamId: 'team-a', inviteId: 'invite-123' });
  const attempt = page.joinTeam();
  await page.joinTeam();
  assert.equal(page.data.isJoining, true);
  assert.equal(calls.cloud.filter(call => call.type === 'joinTeam').length, 1);
  resolveJoin({ result: { success: false, error: '团队已满' } });
  await attempt;
  assert.equal(page.data.isJoining, false);
  assert.equal(page.data.isMember, false);
  assert.equal(page.data.teamInfo._id, 'team-a');
  assert.equal(calls.modals[0].content, '团队已满');
  const retry = page.joinTeam();
  resolveJoin(success({}));
  await retry;
  assert.equal(page.data.isMember, true);
  assert.equal(calls.cloud.filter(call => call.type === 'joinTeam').length, 2);
});

test('a committed join remains successful when refreshing its local cache fails', async () => {
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? preview : {}), refresh: () => { throw new Error('刷新失败'); } });
  await page.onLoad({ teamId: 'team-a', inviteId: 'invite-123' });
  await page.joinTeam();
  assert.equal(page.data.isMember, true);
  assert.equal(calls.modals.length, 0);
  assert.equal(calls.redirects.length, 1);
});

test('existing members use verified cloud statistics and go directly to details', async () => {
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo'
    ? { ...preview, isMember: true, members: [{ openid: 'member', nickname: '成员' }] }
    : { member: { monthlyCount: 1, totalCount: 12 } }) });
  await page.onLoad({ teamId: 'team-a' });
  assert.equal(page.data.teamTotalCheckins, 12);
  assert.equal(page.data.teamActivityRate, 100);
  await page.joinTeam();
  assert.equal(calls.cloud.some(call => call.type === 'joinTeam'), false);
  assert.equal(calls.redirects.length, 1);
});

test('a prior account response cannot restore stale membership after switching users', async () => {
  let finishOld;
  let reads = 0;
  const { page, storage } = createPage({ cloud: type => {
    assert.equal(type, 'getTeamInfo');
    reads++;
    return reads === 1 ? new Promise(resolve => { finishOld = resolve; }) : success(preview);
  } });
  const oldRead = page.onLoad({ teamId: 'team-a' });
  storage.set('userOpenId', 'another-account');
  await page.loadTeamInfo();
  finishOld(success({ ...preview, isMember: true }));
  await oldRead;
  assert.equal(page.data.isMember, false);
  assert.equal(page.data.isLoading, false);
});

test('a bare team link or forged inviter context cannot start a join or a login flow', async () => {
  for (const openid of ['wechat-member', '']) {
    const { page, calls, storage } = createPage({ openid });
    await page.onLoad({ teamId: 'team-a', inviterId: 'owner', fromLogin: 'true' });
    await page.joinTeam();
    assert.equal(page.data.inviteId, '');
    assert.equal(calls.cloud.some(call => call.type === 'joinTeam'), false);
    assert.equal(calls.navigate.length, 0);
    assert.equal(storage.has('pendingTeamInvitation'), false);
    assert.match(calls.toasts.at(-1).title, /团长/);
    assert.equal(calls.hiddenShares.length, 1);
  }
});

test('an unconfirmed invitation does not autojoin via fromLogin or a different pending invitation', async () => {
  for (const pending of [undefined, { teamId: 'team-a', inviteId: 'old-invite', expiresAt: Date.now() + 30000 }]) {
    const { page, calls } = createPage({ stored: { pendingTeamInvitation: pending } });
    await page.onLoad({ teamId: 'team-a', inviteId: 'new-invite', fromLogin: 'true' });
    assert.equal(page.data.inviteId, 'new-invite');
    assert.equal(calls.cloud.some(call => call.type === 'joinTeam'), false);
  }
});

test('expired login recovery does not restore an old invitation or join without a token', async () => {
  const { page, calls } = createPage({ stored: { pendingTeamInvitation: {
    teamId: 'team-a', inviteId: 'old-invite', expiresAt: Date.now() - 1
  } } });
  await page.onLoad({ teamId: 'team-a', fromLogin: 'true' });
  await page.joinTeam();
  assert.equal(page.data.inviteId, '');
  assert.equal(calls.cloud.some(call => call.type === 'joinTeam'), false);
});
