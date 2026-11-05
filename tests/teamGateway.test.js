const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/teamGateway.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const team = id => ({ _id: id, cloudId: id, name: id });

function harness(options = {}) {
  const calls = { cloud: [], direct: [], lists: [], uploads: [] };
  const storage = { userOpenId: 'owner' };
  let owner = { openid: 'owner', studentNumber: 'BJ007', bindingVersion: 'v1' };
  const module = { exports: {} };
  const direct = {
    getOwner: () => owner && { ...owner },
    async run(...args) {
      calls.direct.push(args);
      return options.run ? options.run(...args) : { success: true, data: { teamId: 'bijing_12' } };
    },
    async list(...args) {
      calls.lists.push(args);
      return options.list ? options.list(...args) : [team('bijing_12')];
    },
    async uploadTeamIcon(value) { calls.uploads.push(value); return 'https://data.example/api/public/teams/avatar?key=stable'; },
    isDataTeamIcon: value => typeof value === 'string' && value.includes('/api/public/teams/avatar?')
  };
  vm.runInNewContext(source, {
    module,
    require(name) {
      assert.equal(name, './dataTeams.js');
      return { createDataTeams: () => direct, isDataTeam: value => typeof value === 'string' && value.startsWith('bijing_') };
    },
    wx: {
      getStorageSync: key => storage[key],
      cloud: { async callFunction(request) {
        calls.cloud.push(plain(request));
        if (options.cloud) return options.cloud(request);
        const teams = [team('legacy')];
        return { result: { success: true, data: request.data.type === 'getAllTeams' ? { teams } : teams } };
      } }
    }
  });
  return { gateway: module.exports, calls, storage, setOwner(value) { owner = value; } };
}

test('new teams and every data team operation bypass the cloud function regardless of source hints', async () => {
  const h = harness();
  for (const [type, data] of [
    ['createTeam', { name: '新团队', practiceType: 'instant', source: 'wechat' }],
    ...['getTeamInfo', 'updateTeam', 'deleteTeam', 'leaveTeam', 'joinTeam', 'checkTeamMember',
      'removeTeamMember', 'setTeamDeputy', 'transferTeamLeader', 'generateInvite', 'recordInviteAction',
      'recordInviteRelation', 'getTeamPracticeReport', 'getTeamHistoryDetails', 'getTeamMemberPracticeRecords']
      .map(type => [type, { teamId: 'bijing_12', source: 'wechat' }]),
    ['getTeamInfo', { teamId: 'bijing_bad' }]
  ]) {
    const response = await h.gateway.callTeam(type, data);
    assert.equal(response.result.success, true);
    assert.equal(h.calls.direct.at(-1)[0], type);
    assert.deepEqual(plain(h.calls.direct.at(-1)[1]), data);
    assert.equal(h.calls.direct.at(-1)[2], 'owner');
  }
  assert.equal(h.calls.cloud.length, 0);
});

test('legacy reads and writes preserve the original cloud protocol even with a forged data source', async () => {
  const h = harness({ cloud: async () => ({ result: { success: true, data: { original: true } } }) });
  for (const type of ['getTeamInfo', 'updateTeam', 'deleteTeam', 'leaveTeam', 'joinTeam', 'getTeamPracticeReport', 'adminListTeams']) {
    const data = { teamId: 'legacy-id', source: 'bijing', expectedVersion: 3 };
    const response = await h.gateway.callTeam(type, data, 'owner');
    assert.equal(response.result.data.original, true);
    assert.deepEqual(h.calls.cloud.at(-1), { name: 'teamManager', data: { type, data, openid: 'owner' } });
  }
  assert.equal(h.calls.direct.length, 0);
  assert.equal(h.calls.lists.length, 0);
});

test('data failures are surfaced and never retried through the legacy create or write path', async () => {
  for (const status of [401, 404, 409, 503]) {
    const h = harness({ run() { throw Object.assign(new Error('data unavailable'), { status, code: 'API_UNAVAILABLE' }); } });
    for (const type of ['createTeam', 'deleteTeam']) {
      const response = await h.gateway.callTeam(type, { teamId: 'bijing_12' });
      assert.equal(response.result.success, false);
      assert.equal(response.result.error, 'data unavailable');
      assert.equal(response.result.code, 'API_UNAVAILABLE');
    }
    assert.equal(h.calls.cloud.length, 0);
  }
});

test('private and public lists combine sources, discard cloud copies of data teams, and deduplicate IDs', async () => {
  const h = harness({
    list: async () => [team('bijing_12'), team('bijing_12')],
    cloud: async ({ data }) => {
      const teams = [team('legacy'), team('legacy'), team('bijing_12')];
      return { result: { success: true, data: data.type === 'getAllTeams' ? { teams } : teams } };
    }
  });
  for (const type of ['getUserTeams', 'getAllTeams']) {
    const { result } = await h.gateway.callTeam(type);
    assert.equal(result.success, true);
    const teams = type === 'getAllTeams' ? result.data.teams : result.data;
    assert.deepEqual(plain(teams.map(item => item._id)), ['legacy', 'bijing_12']);
    assert.deepEqual(plain(result.failedSources), []);
    if (type === 'getAllTeams') assert.equal(result.data.count, 2);
    assert.equal(h.calls.lists.at(-1)[0], type === 'getAllTeams' ? 'public' : 'mine');
  }
});

test('a single list failure reports its source while keeping the other source usable', async () => {
  const cloudDown = harness({ cloud() { throw new Error('原团队离线'); } });
  const dataDown = harness({ list() { throw new Error('新团队离线'); } });
  for (const type of ['getUserTeams', 'getAllTeams']) {
    for (const [h, sourceName, expectedId] of [[cloudDown, 'wechat', 'bijing_12'], [dataDown, 'bijing', 'legacy']]) {
      const { result } = await h.gateway.callTeam(type);
      assert.equal(result.success, true);
      assert.deepEqual(plain(result.failedSources), [sourceName]);
      assert.match(result.warning, /离线/);
      const teams = type === 'getAllTeams' ? result.data.teams : result.data;
      assert.deepEqual(plain(teams.map(item => item._id)), [expectedId]);
    }
  }
  const both = harness({ cloud() { throw new Error('原团队离线'); }, list() { throw new Error('新团队离线'); } });
  const { result } = await both.gateway.callTeam('getUserTeams');
  assert.equal(result.success, false);
  assert.deepEqual(plain(result.failedSources), ['wechat', 'bijing']);
  assert.match(result.error, /原团队离线.*新团队离线/);
});

test('malformed legacy list responses are failures, and account changes discard the combined snapshot', async () => {
  const bad = harness({ cloud: async () => ({ result: { success: true, data: { wrong: [] } } }) });
  assert.deepEqual(plain((await bad.gateway.callTeam('getUserTeams')).result.failedSources), ['wechat']);
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness({ list: () => pending });
  const request = h.gateway.callTeam('getUserTeams');
  h.storage.userOpenId = 'another';
  resolve([team('bijing_12')]);
  const { result } = await request;
  assert.equal(result.success, false);
  assert.match(result.error, /登录状态已变更/);
  assert.equal(result.data, undefined);
});

test('team avatar helpers use the direct adapter without calling teamManager', async () => {
  const h = harness();
  assert.equal(await h.gateway.uploadTeamIcon('cloud://moderated'), 'https://data.example/api/public/teams/avatar?key=stable');
  assert.equal(h.gateway.isDataTeamIcon('/api/public/teams/avatar?key=stable'), true);
  assert.deepEqual(h.calls.uploads, ['cloud://moderated']);
  assert.equal(h.calls.cloud.length, 0);
});

test('binding changes with the same WeChat account invalidate the whole list instead of returning a partial snapshot', async () => {
  for (const type of ['getUserTeams', 'getAllTeams']) {
    const h = harness({ list() { throw Object.assign(new Error('账号或绑定已变化'), { code: 'ACCOUNT_CHANGED' }); } });
    const { result } = await h.gateway.callTeam(type);
    assert.equal(h.storage.userOpenId, 'owner');
    assert.equal(h.calls.cloud.length, 1, 'the legacy source may have completed successfully');
    assert.equal(result.success, false);
    assert.equal(result.code, 'ACCOUNT_CHANGED');
    assert.equal(result.data, undefined);
    assert.equal(result.failedSources, undefined);
    assert.match(result.error, /绑定已变化/);
  }
});

test('data owner snapshots track binding changes and unbinding for cache ownership checks', () => {
  const h = harness();
  const first = h.gateway.getDataOwner();
  assert.deepEqual(plain(first), { openid: 'owner', studentNumber: 'BJ007', bindingVersion: 'v1' });
  h.setOwner({ openid: 'owner', studentNumber: 'BJ007', bindingVersion: 'v2' });
  assert.equal(first.bindingVersion, 'v1');
  assert.equal(h.gateway.getDataOwner().bindingVersion, 'v2');
  h.setOwner(null);
  assert.equal(h.gateway.getDataOwner(), null);
});

test('a data list that completed before a slow cloud list cannot survive rebinding during the wait', async () => {
  for (const type of ['getUserTeams', 'getAllTeams']) {
    let resolveCloud;
    const slowCloud = new Promise(done => { resolveCloud = done; });
    const h = harness({ cloud: () => slowCloud, list: async () => [team('bijing_owner_A')] });
    const request = h.gateway.callTeam(type);
    await new Promise(setImmediate);
    assert.equal(h.calls.lists.length, 1);
    h.setOwner({ openid: 'owner', studentNumber: 'BJ008', bindingVersion: 'v2' });
    resolveCloud({ result: { success: true, data: type === 'getAllTeams' ? { teams: [] } : [] } });
    const { result } = await request;
    assert.equal(result.success, false);
    assert.equal(result.code, 'ACCOUNT_CHANGED');
    assert.equal(result.data, undefined);
    assert.equal(result.failedSources, undefined);
  }
});

test('a late successful data mutation is discarded after the same WeChat account changes its binding', async () => {
  for (const type of ['createTeam', 'updateTeam', 'deleteTeam']) {
    let resolveMutation;
    const pending = new Promise(done => { resolveMutation = done; });
    const h = harness({ run: () => pending });
    const request = h.gateway.callTeam(type, { teamId: 'bijing_12' });
    h.setOwner({ openid: 'owner', studentNumber: 'BJ008', bindingVersion: 'v2' });
    resolveMutation({ success: true, data: { teamId: 'bijing_12' } });
    const { result } = await request;
    assert.equal(result.success, false);
    assert.equal(result.code, 'ACCOUNT_CHANGED');
    assert.equal(result.data, undefined);
    assert.equal(h.calls.cloud.length, 0);
  }
});
