const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/teamManager.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/team/team.js'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const team = (id, creator = 'owner') => ({ _id: id, name: id, creator, members: [creator], memberCount: 1, isActive: true });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ stored = {}, cloud = async () => ({ success: true, data: [] }), uploadFail = false } = {}) {
  const storage = { userOpenId: 'owner', ...clone(stored) };
  const calls = [], uploads = [], toasts = [], navigations = [], modals = [];
  const wx = {
    getStorageSync: key => clone(storage[key]),
    setStorageSync: (key, value) => { storage[key] = clone(value); },
    removeStorageSync: key => { delete storage[key]; },
    showToast: value => toasts.push(value), showModal: value => modals.push(value),
    showLoading() {}, hideLoading() {}, stopPullDownRefresh() {},
    navigateTo: value => navigations.push(value),
    cloud: {
      async callFunction(request) { calls.push(clone(request.data)); return { result: await cloud(request.data) }; },
      uploadFile(request) {
        uploads.push(request.filePath);
        if (uploadFail) request.fail(new Error('offline')); else request.success({ fileID: 'cloud://icon' });
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, wx, console: quiet });
  let definition;
  vm.runInNewContext(pageSource, {
    wx, console: quiet, require: name => name.endsWith('/dateUtil.js') ? require('../miniprogram/utils/dateUtil.js') : module.exports, Page: page => { definition = page; }
  });
  const page = { ...definition, data: clone(definition.data), setData(data) { Object.assign(this.data, data); } };
  return { manager: module.exports, page, storage, calls, uploads, toasts, navigations, modals };
}

test('member practice records use the cloud wrapper without modifying personal or team caches', async () => {
  const data = { member: { openid: 'member', nickname: '成员' }, startDate: '2026-09-16', businessDate: '2026-09-17',
    records: [{ _id: 'session', date: '2026-09-16', timestamp: null, duration: 10 }] };
  const app = harness({ stored: { userTeams_owner: [team('team')], userData_owner: { personal: true } },
    cloud: async () => ({ success: true, data }) });
  const before = clone(app.storage);
  assert.deepEqual(clone(await app.manager.getTeamMemberPracticeRecords('team', 'member')), { success: true, data });
  assert.deepEqual(app.calls, [{ type: 'getTeamMemberPracticeRecords', data: { teamId: 'team', memberOpenid: 'member' }, openid: 'owner' }]);
  assert.deepEqual(app.storage, before);
});

test('member record requests validate identity and IDs before making a cloud call', async () => {
  for (const [stored, teamId, memberOpenid] of [
    [{ userOpenId: '' }, 'team', 'member'], [{}, '', 'member'], [{}, 'team', ''], [{}, 'team', { id: 'member' }]
  ]) {
    const app = harness({ stored });
    assert.equal((await app.manager.getTeamMemberPracticeRecords(teamId, memberOpenid)).success, false);
    assert.equal(app.calls.length, 0);
  }
});

test('member record failures and malformed responses never become successful empty history', async () => {
  for (const cloud of [
    async () => ({ success: false, error: '该用户已不在团队中' }),
    async () => { throw new Error('offline'); },
    async () => ({ success: true, data: null }),
    async () => ({ success: true, data: { member: { openid: 'other' }, records: [] } }),
    async () => ({ success: true, data: { member: { openid: 'member' } } })
  ]) {
    const app = harness({ cloud });
    const result = await app.manager.getTeamMemberPracticeRecords('team', 'member');
    assert.equal(result.success, false);
    assert.ok(result.error);
  }
});

test('late member record responses are rejected after switching accounts or logging out', async () => {
  for (const nextUser of ['second', '']) {
    const pending = deferred();
    const app = harness({ cloud: () => pending.promise });
    const request = app.manager.getTeamMemberPracticeRecords('team', 'member');
    app.storage.userOpenId = nextUser;
    pending.resolve({ success: true, data: { member: { openid: 'member' }, records: [] } });
    const result = await request;
    assert.equal(result.success, false);
    assert.match(result.error, /登录状态已变更/);
  }
});

test('creation waits for cloud confirmation, shares duplicate submits and returns the canonical ID', async () => {
  const pending = deferred();
  const app = harness({ cloud: () => pending.promise });
  const first = app.manager.createTeam({ name: '  静心  ' });
  const second = app.manager.createTeam({ name: '  静心  ' });
  assert.equal(app.calls.length, 1);
  assert.equal(app.manager.getMyTeams().length, 0);
  assert.equal(app.storage.userTeams_owner, undefined);
  pending.resolve({ success: true, data: { teamId: 'cloud-id' } });
  const result = await first;
  assert.equal(result.success, true);
  assert.equal(result.team._id, 'cloud-id');
  assert.equal(result.team.cloudId, 'cloud-id');
  assert.equal(result.team.name, '静心');
  assert.deepEqual(clone(result.team.members), ['owner']);
  assert.equal((await second).team._id, 'cloud-id');
  assert.equal(app.storage.userTeams_owner.length, 1);
  assert.equal(app.manager.getJoinedTeams().length, 1);
});

test('joined and inactive cached teams never block creation of another team', async () => {
  const joined = { ...team('joined', 'someone'), members: ['someone', 'owner'] };
  const app = harness({ stored: { userTeams_owner: [joined, { ...team('deleted'), isActive: false }] },
    cloud: async () => ({ success: true, data: { teamId: 'own' } }) });
  assert.equal((await app.manager.createTeam({ name: 'own' })).success, true);
  assert.equal(app.manager.getMyTeams().length, 1);
});

test('creation rejection and network failure never create a local phantom team', async () => {
  for (const cloud of [async () => ({ success: false, error: '名称已存在' }), async () => { throw new Error('offline'); }]) {
    const app = harness({ cloud });
    assert.equal((await app.manager.createTeam({ name: 'demo' })).success, false);
    assert.equal(app.manager.getMyTeams().length, 0);
    assert.equal(app.storage.userTeams_owner, undefined);
  }
});

test('wxfile and https temp avatars are uploaded; upload failure prevents creating the team', async () => {
  for (const icon of ['wxfile://tmp_avatar.png', 'https://tmp/avatar.png', 'http://tmp/avatar.png']) {
    const app = harness({ cloud: async () => ({ success: true, data: { teamId: 'own' } }) });
    assert.equal((await app.manager.createTeam({ name: 'demo', icon })).team.icon, 'cloud://icon');
    assert.deepEqual(app.uploads, [icon]);
    assert.equal(app.calls[0].data.icon, 'cloud://icon');
  }
  const failed = harness({ uploadFail: true });
  assert.equal((await failed.manager.createTeam({ name: 'demo', icon: 'wxfile://tmp_a' })).success, false);
  assert.equal(failed.calls.length, 0);
});

test('failed deletion preserves membership and a successful retry clears both caches using cloud ID', async () => {
  let failure = true;
  const saved = { ...team('legacy-id'), cloudId: 'real-id' };
  const app = harness({ stored: { userTeams_owner: [saved], joinedTeams_owner: [saved], allTeams_cache: [saved] },
    cloud: async () => failure ? { success: false, error: '删除失败' } : { success: true } });
  assert.equal((await app.manager.deleteTeam('legacy-id')).success, false);
  assert.deepEqual(app.storage.userTeams_owner, [saved]);
  assert.equal(app.manager.getJoinedTeams().length, 1);
  failure = false;
  assert.equal((await app.manager.deleteTeam('legacy-id')).success, true);
  assert.equal(app.calls.at(-1).data.teamId, 'real-id');
  assert.deepEqual(app.storage.userTeams_owner, []);
  assert.deepEqual(app.storage.joinedTeams_owner, []);
  assert.equal(app.storage.allTeams_cache, undefined);
});

test('empty cloud snapshot removes legacy phantom teams and stale joined cache', async () => {
  const saved = team('local-phantom');
  const app = harness({ stored: { userTeams_owner: [saved], joinedTeams_owner: [saved] } });
  assert.equal((await app.manager.loadTeamsFromCloud()).success, true);
  assert.deepEqual(app.storage.userTeams_owner, []);
  assert.deepEqual(app.storage.joinedTeams_owner, []);
});

test('cloud failure retains cache and changed cloud icons replace stale local icons', async () => {
  let failed = true;
  const saved = { ...team('one'), icon: 'cloud://old' };
  const app = harness({ stored: { userTeams_owner: [saved] }, cloud: async () => failed
    ? { success: false, error: 'offline' }
    : { success: true, data: [{ ...saved, icon: 'cloud://new' }] } });
  assert.equal((await app.manager.loadTeamsFromCloud()).success, false);
  assert.deepEqual(app.storage.userTeams_owner, [saved]);
  failed = false;
  await app.manager.loadTeamsFromCloud();
  assert.equal(app.manager.getMyTeams()[0].icon, 'cloud://new');
});

test('late refresh from another account cannot contaminate the new account cache or memory', async () => {
  const pending = deferred();
  const second = team('second-team', 'second');
  const app = harness({ stored: { userTeams_owner: [team('first')], userTeams_second: [second] }, cloud: () => pending.promise });
  const refresh = app.manager.loadTeamsFromCloud();
  app.storage.userOpenId = 'second';
  assert.equal(app.manager.getMyTeams()[0]._id, 'second-team');
  pending.resolve({ success: true, data: [team('first-refreshed')] });
  assert.equal((await refresh).success, false);
  assert.deepEqual(app.storage.userTeams_second, [second]);
  assert.equal(app.manager.getJoinedTeams()[0]._id, 'second-team');
});

test('late refresh cannot resurrect a deleted team or erase a newly created team', async () => {
  for (const mutation of ['delete', 'create']) {
    const pending = deferred();
    const saved = team('one');
    const app = harness({ stored: { userTeams_owner: mutation === 'delete' ? [saved] : [] },
      cloud: request => request.type === 'getUserTeams' ? pending.promise : Promise.resolve({ success: true, data: { teamId: 'new' } }) });
    const refresh = app.manager.loadTeamsFromCloud();
    if (mutation === 'delete') await app.manager.deleteTeam('one');
    else await app.manager.createTeam({ name: 'new' });
    pending.resolve({ success: true, data: mutation === 'delete' ? [saved] : [] });
    await refresh;
    assert.deepEqual(app.storage.userTeams_owner.map(item => item._id), mutation === 'delete' ? [] : ['new']);
  }
});

test('newer refresh wins when cloud snapshots finish out of order', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const app = harness({ cloud: () => (++calls === 1 ? first.promise : second.promise) });
  const older = app.manager.loadTeamsFromCloud(), newer = app.manager.loadTeamsFromCloud();
  second.resolve({ success: true, data: [team('new')] });
  await newer;
  first.resolve({ success: true, data: [team('old')] });
  await older;
  assert.equal(app.storage.userTeams_owner[0]._id, 'new');
});

test('list refreshes personal and discovered teams independently and retains the failed list cache', async () => {
  const saved = team('own');
  const cachedPublic = team('public', 'other');
  for (const failedType of ['getUserTeams', 'getAllTeams', 'both']) {
    const app = harness({ stored: { userTeams_owner: [saved], allTeams_cache: [cachedPublic] },
      cloud: async request => failedType === 'both' || request.type === failedType
        ? { success: false, error: 'unavailable' }
        : { success: true, data: request.type === 'getUserTeams' ? [team('new-own')] : { teams: [team('new-public', 'other')] } } });
    await app.page.loadTeamData();
    const personalId = failedType === 'getAllTeams' ? 'new-own' : 'own';
    const publicId = failedType === 'getUserTeams' ? 'new-public' : 'public';
    assert.deepEqual(clone(app.page.data.mergedJoinedTeams.map(team => team._id)), [personalId]);
    assert.equal(app.page.data.mergedJoinedTeams[0].isSelfCreated, true);
    assert.deepEqual(clone(app.page.data.allTeams.map(team => team._id)), [publicId]);
    assert.deepEqual(app.storage.userTeams_owner.map(team => team._id), [personalId]);
    assert.deepEqual(app.storage.allTeams_cache.map(team => team._id), [publicId]);
    assert.deepEqual(app.calls.map(call => call.type).sort(), ['getAllTeams', 'getUserTeams']);
    assert.equal(app.page.data.isLoading, false);
    assert.equal(app.toasts.length, 1);
  }
});

test('list displays public cache immediately and deduplicates concurrent personal and public refreshes', async () => {
  const pending = deferred();
  const app = harness({ stored: { allTeams_cache: [team('public', 'other')] },
    cloud: request => pending.promise.then(() => ({ success: true, data: request.type === 'getAllTeams' ? { teams: [] } : [] })) });
  const first = app.page.onShow(), second = app.page.onShow();
  assert.deepEqual(app.calls.map(call => call.type).sort(), ['getAllTeams', 'getUserTeams']);
  assert.equal(app.page.data.totalJoinedTeams, 0);
  assert.deepEqual(clone(app.page.data.allTeams.map(team => team._id)), ['public']);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(app.page.data.totalJoinedTeams, 0);
  assert.deepEqual(clone(app.page.data.allTeams), []);
  assert.deepEqual(app.storage.allTeams_cache, []);
  assert.equal(app.page.data.isLoading, false);
});

test('discovered teams cannot open details even when already joined, while personal teams can', () => {
  const own = team('own');
  const joined = { ...team('joined', 'other'), members: ['other', 'owner'] };
  const app = harness({ stored: { userTeams_owner: [own, joined] } });
  app.page.renderTeams([own, joined, team('public', 'other')]);
  assert.equal(app.page.data.currentTab, 'created');
  const view = teamId => app.page.viewTeamDetail({ currentTarget: { dataset: { teamId } } });
  view('public');
  assert.equal(app.navigations.length, 0);
  view('own');
  view('joined');
  assert.deepEqual(app.navigations.map(item => item.url), [
    '/subpackages/team/pages/teamDetails/teamDetails?teamId=own',
    '/subpackages/team/pages/teamDetails/teamDetails?teamId=joined'
  ]);
  app.page.switchTab({ currentTarget: { dataset: { tab: 'joined' } } });
  assert.equal(app.page.data.currentTab, 'joined');
  view('public');
  view('own');
  view('joined');
  assert.equal(app.navigations.length, 2);
});

test('list blocks creation for profile-only login and clears personal state on logout', async () => {
  const app = harness({ stored: { userInfo: { nickName: 'old' }, userTeams_owner: [team('own')] },
    cloud: async () => ({ success: true, data: { teams: [] } }) });
  app.page.renderTeams([]);
  app.storage.userOpenId = '';
  app.page.createNewTeam();
  assert.equal(app.navigations.length, 0);
  assert.equal(app.modals.length, 1);
  await app.page.onShow();
  assert.equal(app.page.data.myTeams.length, 0);
  assert.equal(app.page.data.totalJoinedTeams, 0);
  assert.equal(app.page.data.hasUserInfo, false);
});

test('expanded member profiles in legacy detail cache still count as joined teams', () => {
  const saved = { ...team('joined', 'other'), members: [{ openid: 'other' }, { openid: 'owner' }] };
  const app = harness({ stored: { userTeams_owner: [saved] } });
  assert.equal(app.manager.getJoinedTeams().length, 1);
  app.manager.addJoinedTeam(saved);
  assert.deepEqual(app.storage.userTeams_owner[0].members, ['other', 'owner']);
  assert.equal(app.storage.userTeams_owner[0].memberCount, 2);
});

test('late personal and public list responses cannot restore stale teams after a newer refresh', async () => {
  const oldPersonal = deferred(), oldPublic = deferred();
  const reads = { getUserTeams: 0, getAllTeams: 0 };
  const app = harness({ cloud: request => {
    if (++reads[request.type] === 1) return request.type === 'getUserTeams' ? oldPersonal.promise : oldPublic.promise;
    return Promise.resolve({ success: true, data: request.type === 'getAllTeams' ? { teams: [] } : [] });
  } });
  const oldRefresh = app.page.loadTeamData();
  await app.page.refreshTeamData();
  oldPersonal.resolve({ success: true, data: [team('deleted')] });
  oldPublic.resolve({ success: true, data: { teams: [team('deleted-public', 'other')] } });
  await oldRefresh;
  assert.deepEqual(app.storage.userTeams_owner, []);
  assert.deepEqual(app.storage.allTeams_cache, []);
  assert.deepEqual(clone(app.page.data.mergedJoinedTeams), []);
  assert.deepEqual(clone(app.page.data.allTeams), []);
});

test('a user can create multiple teams and each retains its own practice rules', async () => {
  let count = 0;
  const app = harness({ cloud: async request => ({ success: true, data: { teamId: `team-${++count}` } }) });
  const first = await app.manager.createTeam({ name: '晨间组', practiceStartDate: '2026-09-01', dailyGoalMinutes: 20 });
  const second = await app.manager.createTeam({ name: '进阶组', practiceStartDate: '2026-09-10', dailyGoalMinutes: 45 });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(app.manager.getMyTeams().length, 2);
  assert.equal(app.calls[0].data.practiceStartDate, '2026-09-01');
  assert.equal(app.calls[1].data.dailyGoalMinutes, 45);
  assert.deepEqual(app.storage.userTeams_owner.map(team => [team.practiceStartDate, team.dailyGoalMinutes]),
    [['2026-09-01', 20], ['2026-09-10', 45]]);
  app.page.renderTeams([]);
  assert.equal(app.page.data.mergedJoinedTeams.length, 2);
  assert.equal(app.page.data.mergedJoinedTeams[1].dailyGoalMinutes, 45);
});

test('dissolving one owned team preserves the user’s other teams and rules', async () => {
  const first = { ...team('first'), practiceStartDate: '2026-09-01', dailyGoalMinutes: 20 };
  const second = { ...team('second'), practiceStartDate: '2026-09-10', dailyGoalMinutes: 60 };
  const app = harness({ stored: { userTeams_owner: [first, second], joinedTeams_owner: [first, second] },
    cloud: async () => ({ success: true }) });
  assert.equal((await app.manager.deleteTeam('first')).success, true);
  assert.deepEqual(app.storage.userTeams_owner, [second]);
  assert.deepEqual(app.storage.joinedTeams_owner, [second]);
  assert.equal(app.manager.getMyTeams().length, 1);
});

test('legacy team list rule start uses the Beijing 02:00 practice-day boundary', () => {
  const app = harness();
  assert.equal(app.page.getPracticeDate('2026-09-19T01:59:59+08:00'), '2026-09-18');
  assert.equal(app.page.getPracticeDate('2026-09-19T02:00:00+08:00'), '2026-09-19');
  assert.equal(app.page.getPracticeDate('2026-01-01T01:00:00+08:00'), '2025-12-31');
});

test('team lists preserve explicitly unset rules independently and keep legacy missing-field defaults', () => {
  const saved = [
    { ...team('unset'), practiceStartDate: null, dailyGoalMinutes: null },
    { ...team('date-only'), practiceStartDate: '2026-09-01', dailyGoalMinutes: null },
    { ...team('goal-only'), practiceStartDate: null, dailyGoalMinutes: 45 },
    { ...team('legacy'), createdAt: '2026-09-19T01:59:59+08:00' }
  ];
  const app = harness({ stored: { userTeams_owner: saved } });
  app.page.renderTeams(saved);
  const expected = [[null, null], ['2026-09-01', null], [null, 45], ['2026-09-18', 20]];
  for (const list of ['myTeams', 'joinedTeams', 'mergedJoinedTeams', 'allTeams']) {
    assert.deepEqual(clone(app.page.data[list].map(item => [item.practiceStartDate, item.dailyGoalMinutes])), expected, list);
  }
});

test('a different team submitted during a pending creation is not reported as that team’s success', async () => {
  const pending = deferred();
  const app = harness({ cloud: () => pending.promise });
  const first = app.manager.createTeam({ name: '团队甲', practiceStartDate: '2026-09-01', dailyGoalMinutes: 20 });
  const other = await app.manager.createTeam({ name: '团队乙', practiceStartDate: '2026-09-10', dailyGoalMinutes: 60 });
  assert.equal(other.success, false);
  assert.match(other.error, /正在创建/);
  assert.equal(app.calls.length, 1);
  pending.resolve({ success: true, data: { teamId: 'first-team' } });
  assert.equal((await first).team.name, '团队甲');
  assert.equal(app.storage.userTeams_owner.length, 1);
});

test('remove-member client rejects non-creators, self and missing members before cloud access', async () => {
  const teamInfo = { ...team('team'), members: ['owner', 'member'], memberCount: 2 };
  for (const [viewer, target] of [['member', 'owner'], ['owner', 'owner'], ['owner', 'missing']]) {
    const app = harness({ stored: { userOpenId: viewer, [`userTeams_${viewer}`]: [teamInfo] } });
    assert.equal((await app.manager.removeTeamMember('team', target)).success, false);
    assert.equal(app.calls.length, 0);
  }
});

test('remove-member client updates both caches only after server confirmation', async () => {
  const teamInfo = { ...team('team'), members: ['owner', 'member'], memberCount: 2 };
  const stored = { userTeams_owner: [teamInfo], joinedTeams_owner: [teamInfo], allTeams_cache: [teamInfo] };
  const pending = deferred();
  const app = harness({ stored, cloud: () => pending.promise });
  const request = app.manager.removeTeamMember('team', 'member');
  assert.equal(app.storage.userTeams_owner[0].memberCount, 2);
  pending.resolve({ success: true, data: { teamId: 'team', members: ['owner'], memberCount: 1 } });
  assert.equal((await request).success, true);
  assert.equal(app.storage.userTeams_owner[0].memberCount, 1);
  assert.equal(app.storage.joinedTeams_owner[0].memberCount, 1);
  assert.equal(app.storage.allTeams_cache, undefined);
  const failure = harness({ stored, cloud: async () => ({ success: false, error: 'offline' }) });
  assert.equal((await failure.manager.removeTeamMember('team', 'member')).success, false);
  assert.equal(failure.storage.userTeams_owner[0].memberCount, 2);
});

test('remove-member responses cannot overwrite another account cache', async () => {
  const teamInfo = { ...team('team'), members: ['owner', 'member'], memberCount: 2 };
  const pending = deferred();
  const app = harness({ stored: { userTeams_owner: [teamInfo], userTeams_second: [] }, cloud: () => pending.promise });
  const request = app.manager.removeTeamMember('team', 'member');
  app.storage.userOpenId = 'second';
  pending.resolve({ success: true, data: { teamId: 'team', members: ['owner'], memberCount: 1 } });
  assert.equal((await request).success, false);
  assert.deepEqual(app.storage.userTeams_second, []);
});
