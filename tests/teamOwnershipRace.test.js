const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const gatewaySource = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/teamGateway.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/teamManager.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const initialOwner = { openid: 'wx-owner', studentNumber: 'BJ007', bindingVersion: 'v1' };
const changedOwner = { ...initialOwner, studentNumber: 'BJ008', bindingVersion: 'v2' };
const ownerKey = owner => JSON.stringify([owner.openid, owner.studentNumber, owner.bindingVersion]);
const oldTeam = { _id: 'bijing_12', cloudId: 'bijing_12', source: 'bijing', practiceType: 'instant', name: '学号A团队',
  creator: 'wx-owner', creatorName: '团长', members: ['wx-owner', 'bijing_member_8'], memberCount: 2,
  deputyLeaders: [], isActive: true, _dataOwner: ownerKey(initialOwner) };

function harness(data) {
  let owner = { ...initialOwner };
  const storage = { userOpenId: owner.openid, userTeams_wx_owner: undefined,
    'userTeams_wx-owner': [clone(oldTeam)], 'joinedTeams_wx-owner': [clone(oldTeam)] };
  const confirmations = [], cacheWrites = [], directCalls = [];
  const wx = {
    getStorageSync: key => clone(storage[key]),
    setStorageSync(key, value) {
      storage[key] = clone(value);
      if (key === 'userTeams_wx-owner' || key === 'joinedTeams_wx-owner') cacheWrites.push({ key, value: clone(value) });
    },
    removeStorageSync: key => { delete storage[key]; },
    cloud: { callFunction() { throw new Error('these operations must use data'); } }
  };
  const gatewayModule = { exports: {} };
  vm.runInNewContext(gatewaySource, {
    module: gatewayModule, wx,
    require(name) {
      assert.equal(name, './dataTeams.js');
      return {
        isDataTeam: id => typeof id === 'string' && id.startsWith('bijing_'),
        createDataTeams: () => ({
          getOwner: () => ({ ...owner }),
          run: async (...args) => { directCalls.push(args); return { success: true, data: clone(data) }; }
        })
      };
    }
  });
  const actualGateway = gatewayModule.exports;
  // Queue the binding update only after the real gateway has confirmed the
  // response. The manager's own await boundary must still reject that result.
  const observedGateway = { ...actualGateway, callTeam: (...args) => actualGateway.callTeam(...args).then(response => {
    confirmations.push(clone(response.result));
    queueMicrotask(() => { owner = { ...changedOwner }; });
    return response;
  }) };
  const managerModule = { exports: {} };
  vm.runInNewContext(managerSource, {
    module: managerModule, wx, console: { error() {}, warn() {} },
    require(name) { assert.equal(name, './teamGateway.js'); return observedGateway; }
  });
  return { manager: managerModule.exports, storage, confirmations, cacheWrites, directCalls, getOwner: () => owner };
}

const cases = [
  {
    name: 'creation',
    data: { teamId: 'bijing_13', team: { ...oldTeam, _id: 'bijing_13', cloudId: 'bijing_13', _dataOwner: undefined } },
    invoke: manager => manager.createTeam({ name: '学号A团队', practiceType: 'instant' })
  },
  {
    name: 'deputy assignment',
    data: { teamId: 'bijing_12', creator: 'wx-owner', creatorName: '团长', members: ['wx-owner', 'bijing_member_8'],
      memberCount: 2, deputyLeaders: ['bijing_member_8'] },
    invoke: manager => manager.setTeamDeputy('bijing_12', 'bijing_member_8', true)
  },
  {
    name: 'member removal',
    data: { teamId: 'bijing_12', creator: 'wx-owner', members: ['wx-owner'], memberCount: 1, deputyLeaders: [] },
    invoke: manager => manager.removeTeamMember('bijing_12', 'bijing_member_8')
  }
];

for (const entry of cases) {
  test(`${entry.name} cannot cache a response under a binding changed after gateway confirmation`, async () => {
    const h = harness(entry.data);
    const beforeTeams = clone(h.storage['userTeams_wx-owner']);
    const beforeJoined = clone(h.storage['joinedTeams_wx-owner']);
    const result = await entry.invoke(h.manager);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.confirmations[0].success, true, 'the gateway had already confirmed the response for the original binding');
    assert.equal(h.getOwner().studentNumber, 'BJ008');
    assert.equal(h.storage.userOpenId, 'wx-owner', 'the WeChat account did not change');
    assert.equal(result.success, false);
    assert.match(result.error, /账号或绑定已变化/);
    assert.equal(h.directCalls.length, 1);
    assert.deepEqual(h.cacheWrites, [], 'old data must not be relabeled or applied to the new binding');
    assert.deepEqual(h.storage['userTeams_wx-owner'], beforeTeams);
    assert.deepEqual(h.storage['joinedTeams_wx-owner'], beforeJoined);
  });
}
