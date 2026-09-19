const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const NOW = Date.parse('2026-09-17T04:00:00Z');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const team = (extra = {}) => ({ _id: 'team', name: '一起冥想', creator: 'owner', creatorName: '队长',
  members: ['owner'], memberCount: 1, isActive: true, createdAt: '2026-09-01T00:00:00Z', ...extra });
const invitation = (extra = {}) => ({ _id: 'invite', teamId: 'team', inviterId: 'owner',
  status: 'pending', expireTime: new Date(NOW + 1000).toISOString(), ...extra });

function harness(initial = {}, options = {}) {
  let stored = clone({ teams: [], team_members: [], invites: [], invite_actions: [], users: [], meditation_records: [], ...initial });
  const reads = [];
  const writes = [];
  let transactions = 0;
  const now = options.now || NOW;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function matches(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some(condition => matches(row, condition));
      if (value && value.inValues) return value.inValues.includes(row[key]);
      if (value && value.regex !== undefined) return new RegExp(value.regex, value.options).test(row[key]);
      if (value && value.bounds) return value.bounds.every(bound => bound.kind === 'gt' ? row[key] > bound.value :
        bound.kind === 'gte' ? row[key] >= bound.value : row[key] <= bound.value);
      return Array.isArray(row[key]) ? row[key].includes(value) : row[key] === value;
    });
  }
  const shouldFail = (name, action) => {
    if (options.fail === `${name}:${action}`) throw new Error(`${name} ${action} unavailable`);
  };
  function collection(rows, name, inTransaction, readSet) {
    function query(filter = {}) {
      assert.equal(inTransaction, false, 'CloudBase transactions support document operations only');
      let offset = 0;
      let limit = 20;
      let projection;
      const orders = [];
      return {
        orderBy(field, direction) { orders.push([field, direction]); return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        field(value) { projection = value; return this; },
        async get() {
          shouldFail(name, 'get');
          reads.push({ name, filter: clone(filter), offset, limit, projection: clone(projection), inTransaction });
          const result = rows[name].filter(row => matches(row, filter)).sort((a, b) => {
            for (const [field, direction] of orders) {
              const order = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
              if (order) return direction === 'desc' ? -order : order;
            }
            return 0;
          });
          const data = clone(result.slice(offset, offset + limit).map(row => projection
            ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key])) : row));
          if (options.afterQuery) options.afterQuery({ name, filter: clone(filter), offset, limit, data: clone(data) }, rows);
          return { data };
        },
        async count() {
          shouldFail(name, 'count');
          reads.push({ name, filter: clone(filter), action: 'count' });
          return { total: rows[name].filter(row => matches(row, filter)).length };
        },
        async remove() {
          shouldFail(name, 'remove');
          writes.push({ name, action: 'removeWhere', inTransaction });
          const previous = rows[name].length;
          rows[name] = rows[name].filter(row => !matches(row, filter));
          return { stats: { removed: previous - rows[name].length } };
        }
      };
    }
    return {
      where: query,
      doc(id) {
        return {
          async get() {
            shouldFail(name, 'get');
            reads.push({ name, id, inTransaction });
            if (readSet) readSet.push([name, id]);
            return { data: clone(rows[name].find(row => row._id === id)) };
          },
          async update({ data }) {
            shouldFail(name, 'update');
            writes.push({ name, id, action: 'update', inTransaction });
            const target = rows[name].find(row => row._id === id);
            if (!target) throw new Error('document missing');
            Object.assign(target, clone(data));
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            shouldFail(name, 'set');
            writes.push({ name, id, action: 'set', inTransaction });
            rows[name] = rows[name].filter(row => row._id !== id);
            rows[name].push({ _id: id, ...clone(data) });
            return { _id: id };
          },
          async remove() {
            shouldFail(name, 'remove');
            writes.push({ name, id, action: 'remove', inTransaction });
            const previous = rows[name].length;
            rows[name] = rows[name].filter(row => row._id !== id);
            return { stats: { removed: previous - rows[name].length } };
          }
        };
      },
      async add({ data }) {
        assert.equal(inTransaction, false, 'transaction inserts must use a known document ID');
        shouldFail(name, 'add');
        writes.push({ name, action: 'add', inTransaction });
        const id = data._id || `${name}-${rows[name].length + 1}`;
        if (rows[name].some(row => row._id === id)) throw new Error('duplicate document');
        rows[name].push({ ...clone(data), _id: id });
        return { _id: id };
      }
    };
  }
  const bound = (kind, value) => ({ bounds: [{ kind, value }], and(other) { return { bounds: [...this.bounds, ...other.bounds] }; } });
  const database = {
    command: { gt: value => bound('gt', value), gte: value => bound('gte', value), lte: value => bound('lte', value), in: values => ({ inValues: values }) },
    serverDate: () => new FixedDate(),
    RegExp: value => ({ regex: value.regexp, options: value.options }),
    collection: name => collection(stored, name, false),
    async runTransaction(callback) {
      transactions++;
      // Model optimistic document conflicts, not predicate locks/full serialization.
      // This tests the transaction boundaries; a deployed CloudBase integration is still separate.
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = clone(stored);
        const pending = clone(before);
        const readSet = [];
        const value = await callback({ collection: name => collection(pending, name, true, readSet) });
        if (options.fail === 'commit') throw new Error('commit unavailable');
        const changes = [];
        for (const name of Object.keys(pending)) {
          const ids = new Set([...before[name], ...pending[name]].map(row => row._id));
          for (const id of ids) {
            const original = before[name].find(row => row._id === id);
            const updated = pending[name].find(row => row._id === id);
            if (JSON.stringify(original) !== JSON.stringify(updated)) changes.push([name, id, updated]);
          }
        }
        const hasConflict = [...readSet, ...changes].some(([name, id]) =>
          JSON.stringify(before[name].find(row => row._id === id)) !== JSON.stringify(stored[name].find(row => row._id === id)));
        if (hasConflict) continue;
        for (const [name, id, updated] of changes) {
          stored[name] = stored[name].filter(row => row._id !== id);
          if (updated) stored[name].push(updated);
        }
        return value;
      }
      throw new Error('transaction conflict');
    }
  };
  function load(openid) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/teamManager/index.js'), 'utf8'), {
      module, exports: module.exports, Date: FixedDate, console: { log() {}, warn() {}, error() {} },
      require(name) {
        if (name === 'crypto') return crypto;
        assert.equal(name, 'wx-server-sdk');
        return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database, getWXContext: () => ({ OPENID: openid }) };
      }
    });
    return module.exports.main;
  }
  return {
    reads, writes,
    get stored() { return clone(stored); },
    get transactions() { return transactions; },
    async call(type, data, openid = 'owner', extra = {}) { return clone(await load(openid)({ type, data, ...extra })); }
  };
}

test('client supplied OPENIDs cannot impersonate creator or joined user; authentication is required', async () => {
  const app = harness({ teams: [team()], invites: [invitation()] });
  assert.equal((await app.call('deleteTeam', { teamId: 'team' }, 'attacker', { openid: 'owner' })).success, false);
  assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { name: '恶意改名' } }, 'attacker', { openid: 'owner' })).success, false);
  assert.equal((await app.call('createTeam', { name: '伪造' }, '', { openid: 'owner' })).success, false);
  assert.equal((await app.call('getUserTeams', {}, 'attacker', { openid: 'owner' })).data.length, 0);
  assert.equal((await app.call('joinTeam', { teamId: 'team', inviteId: 'invite', openid: 'victim' }, 'attacker')).success, true);
  assert.deepEqual(app.stored.teams[0].members, ['owner', 'attacker']);
  assert.equal(app.stored.team_members[0].openid, 'attacker');
});

test('creation validates input, persists creator membership, and returns a canonical cloud team', async () => {
  const app = harness();
  for (const data of [null, {}, { name: '  ' }, { name: 'a'.repeat(21) }, { name: '团队', description: 'a'.repeat(101) }]) {
    assert.equal((await app.call('createTeam', data)).success, false);
  }
  assert.equal(app.writes.length, 0);
  const result = await app.call('createTeam', { name: '  团队  ', icon: 'wxfile://tmp_avatar', creator: 'fake', members: ['fake'] });
  assert.equal(result.success, true);
  assert.equal(result.data.teamId, result.data.team._id);
  assert.equal(result.data.team.creator, 'owner');
  assert.deepEqual(result.data.team.members, ['owner']);
  assert.equal(result.data.team.icon, '/images/icons/team.png');
  assert.equal(result.data.team.name, '团队');
  assert.ok(Number.isFinite(Date.parse(result.data.team.createdAt)));
  assert.equal((await app.call('createTeam', { name: '第二个' })).success, true);
  assert.equal((await app.call('createTeam', { name: '团队' }, 'other')).success, false);
});

test('team updates whitelist presentation fields and cannot replace owner, members or active state', async () => {
  const app = harness({ teams: [team()] });
  const result = await app.call('updateTeam', { teamId: 'team', teamData: {
    name: '新名字', description: '一起练习', creator: 'attacker', members: [], memberCount: 0, isActive: false
  } });
  assert.equal(result.success, true);
  assert.equal(app.stored.teams[0].creator, 'owner');
  assert.deepEqual(app.stored.teams[0].members, ['owner']);
  assert.equal(app.stored.teams[0].memberCount, 1);
  assert.equal(app.stored.teams[0].isActive, true);
  assert.equal(app.stored.teams[0].name, '新名字');
});

test('a creator can create multiple teams concurrently while team names stay unique', async () => {
  for (const inputs of [
    [{ name: '团队甲', owner: 'owner' }, { name: '团队乙', owner: 'owner' }],
    [{ name: '同名团队', owner: 'first' }, { name: '同名团队', owner: 'second' }]
  ]) {
    const app = harness();
    const results = await Promise.all(inputs.map(input => app.call('createTeam', { name: input.name }, input.owner)));
    const expected = inputs[0].name === inputs[1].name ? 1 : 2;
    assert.equal(results.filter(result => result.success).length, expected);
    assert.equal(app.stored.teams.filter(item => item.isActive).length, expected);
    assert.equal((await app.call('getAllTeams', {}, '')).data.count, expected);
    assert.equal(app.stored.teams.filter(item => item.lockField === 'creator').length, 0);
    assert.ok(app.reads.filter(read => read.inTransaction).every(read => typeof read.id === 'string'));
  }
});

test('simultaneous renames cannot duplicate a name, and deleted or renamed reservations can be reused', async () => {
  const app = harness({ teams: [team(), team({ _id: 'second', name: '另一团队', creator: 'other', members: ['other'] })] });
  const results = await Promise.all([
    app.call('updateTeam', { teamId: 'team', teamData: { name: '共同名字' } }),
    app.call('updateTeam', { teamId: 'second', teamData: { name: '共同名字' } }, 'other')
  ]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(app.stored.teams.filter(item => item.isActive && item.name === '共同名字').length, 1);

  const created = harness();
  const first = await created.call('createTeam', { name: '原名' });
  assert.equal((await created.call('updateTeam', { teamId: first.data.teamId, teamData: { name: '改名' } })).success, true);
  assert.equal((await created.call('createTeam', { name: '原名' }, 'another')).success, true);
  assert.equal((await created.call('deleteTeam', { teamId: first.data.teamId })).success, true);
  assert.equal((await created.call('createTeam', { name: '改名' })).success, true);
  assert.equal((await created.call('getAllTeams', {}, '')).data.count, 2);
});

test('join retries, leaving, and rejoining never duplicate members or retain stale member relations', async () => {
  const app = harness({ teams: [team()], invites: [invitation()] });
  const joinData = { teamId: 'team', inviteId: 'invite' };
  const results = await Promise.all([app.call('joinTeam', joinData, 'member'), app.call('joinTeam', joinData, 'member')]);
  assert.ok(results.every(result => result.success));
  assert.deepEqual(app.stored.teams[0].members, ['owner', 'member']);
  assert.equal(app.stored.teams[0].memberCount, 2);
  assert.equal(app.stored.team_members.length, 1);
  assert.equal((await app.call('joinTeam', { teamId: 'team' }, 'member')).success, true, 'already joined retries do not require an invite');
  assert.equal((await app.call('leaveTeam', { teamId: 'team' }, 'member')).success, true);
  assert.equal(app.stored.team_members.length, 0);
  assert.equal((await app.call('leaveTeam', { teamId: 'team' }, 'member')).success, true);
  assert.equal(app.stored.teams[0].memberCount, 1);
  assert.equal((await app.call('joinTeam', { teamId: 'team' }, 'member')).success, false, 'leaving requires a fresh admission check');
  assert.equal((await app.call('joinTeam', joinData, 'member')).success, true);
  assert.equal(app.stored.teams[0].memberCount, 2);
  assert.equal((await app.call('leaveTeam', { teamId: 'team' })).success, false);
  assert.ok(app.writes.every(write => write.inTransaction));
});

test('member relations left by old clients can be repaired when rejoining', async () => {
  const app = harness({ teams: [team()], invites: [invitation()], team_members: [{ _id: 'team_member', teamId: 'team', openid: 'member', status: 'active' }] });
  assert.equal((await app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'member')).success, true);
  assert.equal(app.stored.team_members.length, 1);
  assert.equal(app.stored.teams[0].memberCount, 2);
});

test('concurrent admission at capacity uses canonical membership, not a stale stored counter', async () => {
  const members = ['owner', ...Array.from({ length: 48 }, (_, index) => `member-${index}`)];
  const app = harness({ teams: [team({ members, memberCount: 1 })], invites: [invitation()] });
  const results = await Promise.all([app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'last-slot'), app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'over-limit')]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(app.stored.teams[0].members.length, 50);
  assert.equal(app.stored.teams[0].memberCount, 50);
  assert.equal(app.stored.team_members.length, 1);
  assert.equal((await app.call('joinTeam', { teamId: 'team' })).success, true, 'existing members can retry at capacity');
});

test('membership and relation writes roll back together on join/leave/commit failure', async () => {
  for (const fail of ['team_members:set', 'teams:update', 'commit']) {
    const initial = { teams: [team()], invites: [invitation()] };
    const app = harness(initial, { fail });
    assert.equal((await app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'member')).success, false, fail);
    assert.deepEqual(app.stored.teams, initial.teams, fail);
    assert.deepEqual(app.stored.team_members, [], fail);
  }
  const initial = { teams: [team({ members: ['owner', 'member'], memberCount: 2 })],
    team_members: [{ _id: 'team_member', teamId: 'team', openid: 'member' }] };
  const app = harness(initial, { fail: 'team_members:remove' });
  assert.equal((await app.call('leaveTeam', { teamId: 'team' }, 'member')).success, false);
  assert.deepEqual(app.stored.teams, initial.teams);
  assert.deepEqual(app.stored.team_members, initial.team_members);
});

test('only the creator can generate an invitation even if an ordinary member impersonates them', async () => {
  const app = harness({ teams: [team({ members: ['owner', 'member'] })] });
  for (const openid of ['outsider', 'member', '']) {
    const denied = await app.call('generateInvite', { teamId: 'team', inviterId: 'owner', creator: 'owner' }, openid, { openid: 'owner' });
    assert.equal(denied.success, false, openid);
  }
  assert.equal(app.writes.length, 0);
  const result = await app.call('generateInvite', { teamId: 'team', teamName: '伪造名字', inviterId: 'member' });
  assert.equal(result.success, true);
  assert.ok(result.data.sharePath.startsWith('/subpackages/team/pages/joinTeam/joinTeam?'));
  assert.ok(result.data.sharePath.includes(`teamName=${encodeURIComponent('一起冥想')}`));
  assert.equal(app.stored.invites[0].inviterId, 'owner');
  assert.equal(app.stored.invites[0].teamName, '一起冥想');
  assert.equal(result.data.expireTime, NOW + 7 * 24 * 60 * 60 * 1000);
  assert.equal(Date.parse(app.stored.invites[0].expireTime), result.data.expireTime);
});

test('direct joins and forged creator parameters cannot admit a new member without a saved invitation', async () => {
  for (const data of [
    { teamId: 'team' },
    { teamId: 'team', inviterId: 'owner' },
    { teamId: 'team', inviteId: '', inviterId: 'owner' },
    { teamId: 'team', inviteId: '   ', inviterId: 'owner' },
    { teamId: 'team', inviteId: { inviterId: 'owner' } },
    { teamId: 'team', inviteId: 'missing', inviterId: 'owner', creator: 'owner' }
  ]) {
    const app = harness({ teams: [team()] });
    const result = await app.call('joinTeam', data, 'new-member');
    assert.equal(result.success, false, JSON.stringify(data));
    assert.deepEqual(app.stored.teams[0].members, ['owner']);
    assert.equal(app.stored.team_members.length, 0);
    assert.equal(app.writes.length, 0);
  }
});

test('group invitations remain usable by multiple people, bind inviter/team, and enforce expiry', async () => {
  const app = harness({ teams: [team()], invites: [invitation()] });
  const joined = await Promise.all(['first', 'second'].map(openid =>
    app.call('joinTeam', { teamId: 'team', inviteId: 'invite', inviterId: 'spoofed' }, openid)));
  assert.ok(joined.every(result => result.success));
  assert.equal(app.stored.teams[0].memberCount, 3);
  assert.ok(app.stored.team_members.every(member => member.invitedBy === 'owner'));
  assert.ok(app.stored.team_members.every(member => member.inviteId === 'invite'));
  assert.equal(app.stored.invites[0].status, 'pending');
  assert.ok(app.reads.filter(read => read.name === 'invites').every(read => read.inTransaction));
  for (const change of [{ teamId: 'other-team' }, { expireTime: new Date(NOW).toISOString() },
    { expireTime: new Date(NOW - 1).toISOString() }, { status: 'revoked' }, { status: 'unknown' },
    { expireTime: null }, { expireTime: 'invalid' }, { expireTime: {} }]) {
    const invalid = harness({ teams: [team()], invites: [invitation(change)] });
    assert.equal((await invalid.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'member')).success, false);
    assert.equal(invalid.stored.teams[0].memberCount, 1);
    assert.equal(invalid.writes.length, 0);
  }
  const legacyAccepted = harness({ teams: [team()], invites: [invitation({ status: 'accepted' })] });
  assert.equal((await legacyAccepted.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'new-member')).success, true);
});

test('historical invitations from ordinary members and former creators no longer admit new members', async () => {
  for (const inviterId of ['member', 'former-owner', 'outsider', '', null]) {
    const app = harness({ teams: [team({ members: ['owner', 'member', 'former-owner'] })], invites: [invitation({ inviterId })] });
    const denied = await app.call('joinTeam', { teamId: 'team', inviteId: 'invite', inviterId: 'owner' }, 'new-member');
    assert.equal(denied.success, false, String(inviterId));
    assert.equal(app.stored.team_members.length, 0);
    assert.equal(app.writes.length, 0);
  }
});

test('invitation storage failures cannot be mistaken for permission to join', async () => {
  const app = harness({ teams: [team()], invites: [invitation()] }, { fail: 'invites:get' });
  assert.equal((await app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'member')).success, false);
  assert.deepEqual(app.stored.teams[0].members, ['owner']);
  assert.equal(app.writes.length, 0);
});

test('only the creator can record invitation generation, including historical member invitations', async () => {
  const app = harness({ teams: [team({ members: ['owner', 'member'] })], invites: [
    invitation(), invitation({ _id: 'member-invite', inviterId: 'member' })
  ] });
  for (const [openid, inviteId] of [['member', 'invite'], ['member', 'member-invite'], ['outsider', 'invite'], ['', 'invite']]) {
    const denied = await app.call('recordInviteAction', { teamId: 'team', inviteId, inviterId: 'owner' }, openid, { openid: 'owner' });
    assert.equal(denied.success, false, `${openid}:${inviteId}`);
  }
  assert.equal((await app.call('recordInviteAction', { teamId: 'team', inviteId: 'member-invite' })).success, false);
  assert.equal(app.writes.length, 0);
  assert.equal((await app.call('recordInviteAction', { teamId: 'team', inviteId: 'invite' })).success, true);
  assert.equal(app.stored.invite_actions[0].inviterId, 'owner');
});

test('invitation telemetry derives identities from saved invite/membership, not payload values', async () => {
  const app = harness({ teams: [team()], invites: [{ _id: 'invite', teamId: 'team', inviterId: 'owner', status: 'pending', expireTime: new Date(NOW + 1000).toISOString() }] });
  assert.equal((await app.call('recordInviteAction', { teamId: 'team', inviteId: 'invite', inviterId: 'fake' })).success, true);
  assert.equal(app.stored.invite_actions[0].inviterId, 'owner');
  await app.call('joinTeam', { teamId: 'team', inviteId: 'invite' }, 'member');
  assert.equal((await app.call('recordInviteRelation', { teamId: 'team', inviterId: 'fake', inviteeId: 'victim', inviteId: 'fake' }, 'member')).success, true);
  assert.equal(app.stored.invite_actions[1].inviterId, 'owner');
  assert.equal(app.stored.invite_actions[1].inviteeId, 'member');
  assert.equal(app.stored.invite_actions[1].inviteId, 'invite');
});

test('public team preview hides OPENIDs and reports membership from cloud identity', async () => {
  const app = harness({ teams: [team()], users: [{ _openid: 'owner', nickName: '真实昵称', avatarUrl: 'avatar' }] });
  const preview = await app.call('getTeamInfo', { teamId: 'team' }, '', { openid: 'owner' });
  assert.equal(preview.success, true);
  assert.equal(preview.data.isMember, false);
  assert.equal(preview.data.creator, undefined);
  assert.equal(preview.data.members[0].openid, undefined);
  assert.equal(preview.data.members[0].nickname, '真实昵称');
  const member = await app.call('getTeamInfo', { teamId: 'team' });
  assert.equal(member.data.isMember, true);
  assert.equal(member.data.members[0].openid, 'owner');
  assert.equal((await app.call('checkTeamMember', { teamId: 'team', openid: 'owner' }, 'outsider')).isMember, false);
});

test('checkin queries reject arbitrary users and outsiders before reading records', async () => {
  const app = harness({ teams: [team({ members: ['owner', 'member'] })] });
  for (const [type, data, openid] of [
    ['getTeamMembersCheckinData', { teamId: 'team', memberOpenids: ['member'] }, 'outsider'],
    ['getTeamMembersCheckinData', { memberOpenids: ['victim'] }, 'owner'],
    ['getMemberWeekCheckin', { teamId: 'team', memberOpenid: 'victim', weekStart: '2026-09-14', weekEnd: '2026-09-20' }, 'owner']
  ]) assert.equal((await app.call(type, data, openid)).success, false);
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 0);
  assert.equal((await app.call('getTeamMembersCheckinData', { memberOpenids: ['member'] })).success, true);
});

test('monthly counts include every record and use the same UTC+8 month as meditation records', async () => {
  const records = Array.from({ length: 125 }, (_, index) => ({ _id: `record-${index}`, _openid: 'member', date: '2026-09-01' }));
  records.push({ _id: 'previous-month', _openid: 'member', date: '2026-08-31' });
  const app = harness({ teams: [team({ members: ['owner', 'member'] })], meditation_records: records }, { now: Date.parse('2026-08-31T17:00:00Z') });
  const result = await app.call('getTeamMembersCheckinData', { teamId: 'team', memberOpenids: ['member'] });
  assert.deepEqual(result.data.member, { monthlyCount: 125, totalCount: 126 });
  assert.ok(app.reads.filter(read => read.name === 'meditation_records').every(read => read.action === 'count'));
});

test('weekly records paginate and retain actual numeric/ISO timestamps and recorded dates', async () => {
  const records = Array.from({ length: 125 }, (_, index) => ({ _id: `record-${String(index).padStart(3, '0')}`, _openid: 'owner', date: '2026-09-17',
    timestamp: index % 2 ? new Date(NOW - index * 60000).toISOString() : String(NOW - index * 60000), duration: 10 }));
  records.push({ _id: 'legacy', _openid: 'owner', date: '2026-09-16', duration: 5 });
  const app = harness({ teams: [team()], meditation_records: records });
  const result = await app.call('getMemberWeekCheckin', { teamId: 'team', memberOpenid: 'owner', weekStart: '2026-09-14', weekEnd: '2026-09-20' });
  assert.equal(result.success, true);
  assert.equal(result.data.count, 126);
  assert.equal(result.data.records[0].timestamp, NOW);
  assert.equal(result.data.records[0].date, '2026-09-17');
  assert.equal(result.data.records[1].timestamp, NOW - 60000);
  assert.equal(result.data.records[125].timestamp, Date.parse('2026-09-16T00:00:00+08:00'));
  assert.deepEqual(app.reads.filter(read => read.name === 'meditation_records').map(read => read.offset), [0, 100]);
});

test('team lists paginate, expose public fields only, and database failures remain failures', async () => {
  const teams = Array.from({ length: 125 }, (_, index) => team({ _id: `team-${String(index).padStart(3, '0')}` }));
  const app = harness({ teams });
  assert.equal((await app.call('getUserTeams')).data.length, 125);
  const all = await app.call('getAllTeams', {}, '');
  assert.equal(all.data.count, 125);
  assert.ok(all.data.teams.every(item => item.creator === undefined && item.members === undefined));
  const broken = harness({ teams }, { fail: 'teams:get' });
  assert.equal((await broken.call('getAllTeams', {}, '')).success, false);
  const recordsFailure = harness({ teams: [team()] }, { fail: 'meditation_records:get' });
  assert.equal((await recordsFailure.call('getMemberWeekCheckin', { teamId: 'team', memberOpenid: 'owner', weekStart: '2026-09-14', weekEnd: '2026-09-20' })).success, false);
});

test('practice settings persist independently per team; only its creator can edit or dissolve it', async () => {
  const app = harness();
  const first = await app.call('createTeam', { name: '早课', practiceStartDate: '2026-09-01', dailyGoalMinutes: 30 });
  const second = await app.call('createTeam', { name: '晚课', practiceStartDate: '2026-09-10', dailyGoalMinutes: 10 });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.team.practiceStartDate, '2026-09-01');
  assert.equal(first.data.team.dailyGoalMinutes, 30);
  const secondId = second.data.teamId;
  const invite = await app.call('generateInvite', { teamId: secondId });
  assert.equal(invite.success, true);
  assert.equal((await app.call('joinTeam', { teamId: secondId, inviteId: invite.data.inviteId }, 'member')).success, true);
  assert.equal((await app.call('updateTeam', { teamId: secondId, teamData: { dailyGoalMinutes: 90 } }, 'member', { openid: 'owner' })).success, false);
  assert.equal((await app.call('deleteTeam', { teamId: secondId }, 'member', { openid: 'owner' })).success, false);
  assert.equal((await app.call('updateTeam', { teamId: secondId, teamData: {
    practiceStartDate: '2026-09-12', dailyGoalMinutes: 45, dayBoundaryHour: 0, creator: 'member'
  } })).success, true);
  for (const type of ['getUserTeams', 'getAllTeams']) {
    const result = await app.call(type);
    const teams = type === 'getAllTeams' ? result.data.teams : result.data;
    assert.equal(teams.find(row => row._id === first.data.teamId).dailyGoalMinutes, 30);
    assert.equal(teams.find(row => row._id === secondId).dailyGoalMinutes, 45);
    assert.equal(teams.find(row => row._id === secondId).practiceStartDate, '2026-09-12');
    assert.equal(teams.find(row => row._id === secondId).dayBoundaryHour, 4);
  }
  const info = await app.call('getTeamInfo', { teamId: secondId });
  assert.equal(info.data.creator, 'owner');
  assert.equal(info.data.dailyGoalMinutes, 45);
  assert.equal(info.data.practiceStartDate, '2026-09-12');
  const saved = app.stored.teams.find(row => row._id === secondId);
  assert.equal(saved.dailyGoalMinutes, 45);
  assert.equal(saved.practiceStartDate, '2026-09-12');
});

test('practice settings validate actual calendar dates and integer goals against the current 04:00 practice day', async () => {
  const beforeReset = Date.parse('2026-09-18T03:59:59+08:00');
  const app = harness({ teams: [team()] }, { now: beforeReset });
  for (const practiceStartDate of ['2026-09-18', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-9-1', '', 1]) {
    assert.equal((await app.call('createTeam', { name: '日期校验', practiceStartDate })).success, false, String(practiceStartDate));
    assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { practiceStartDate } })).success, false);
  }
  for (const dailyGoalMinutes of [0, -1, 1.5, 1441, '20', true]) {
    assert.equal((await app.call('createTeam', { name: '目标校验', dailyGoalMinutes })).success, false, String(dailyGoalMinutes));
    assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { dailyGoalMinutes } })).success, false);
  }
  assert.equal(app.writes.length, 0);
  assert.equal((await app.call('createTeam', { name: '历史闰日', practiceStartDate: '2024-02-29', dailyGoalMinutes: 1440 })).success, true);
  const defaults = await app.call('createTeam', { name: '默认设置' });
  assert.equal(defaults.data.team.practiceStartDate, null);
  assert.equal(defaults.data.team.dailyGoalMinutes, null);
  const afterReset = harness({}, { now: Date.parse('2026-09-18T04:00:00+08:00') });
  assert.equal((await afterReset.call('createTeam', { name: '边界当天', practiceStartDate: '2026-09-18', dailyGoalMinutes: 1 })).success, true);
});

test('new teams may omit practice settings and the creator may set or clear them independently', async () => {
  const app = harness();
  for (const input of [{ name: '未填设置' }, { name: '显式留空', practiceStartDate: null, dailyGoalMinutes: null }]) {
    const result = await app.call('createTeam', input);
    assert.equal(result.success, true);
    const teamId = result.data.teamId;
    const stored = app.stored.teams.find(row => row._id === teamId);
    assert.equal(stored.practiceStartDate, null);
    assert.equal(stored.dailyGoalMinutes, null);
    for (const type of ['getUserTeams', 'getAllTeams', 'getTeamInfo', 'getTeamPracticeReport']) {
      const read = await app.call(type, { teamId });
      const settings = type === 'getUserTeams' ? read.data.find(row => row._id === teamId) :
        type === 'getAllTeams' ? read.data.teams.find(row => row._id === teamId) :
          type === 'getTeamPracticeReport' ? read.data.settings : read.data;
      assert.equal(settings.practiceStartDate, null, type);
      assert.equal(settings.dailyGoalMinutes, null, type);
      assert.equal(settings.hasPracticeStartDate, false, type);
      assert.equal(settings.effectivePracticeStartDate, '2026-09-17', type);
    }
    assert.equal((await app.call('updateTeam', { teamId, teamData: {
      practiceStartDate: '2026-09-14', dailyGoalMinutes: 30
    } })).success, true);
    assert.equal((await app.call('updateTeam', { teamId, teamData: {
      practiceStartDate: null, dailyGoalMinutes: null
    } }, 'outsider')).success, false);
    assert.equal(app.stored.teams.find(row => row._id === teamId).dailyGoalMinutes, 30);
    assert.equal((await app.call('updateTeam', { teamId, teamData: { dailyGoalMinutes: null } })).success, true);
    let settings = (await app.call('getTeamInfo', { teamId })).data;
    assert.equal(settings.dailyGoalMinutes, null);
    assert.equal(settings.practiceStartDate, '2026-09-14');
    assert.equal(settings.hasPracticeStartDate, true);
    assert.equal((await app.call('updateTeam', { teamId, teamData: { practiceStartDate: null } })).success, true);
    settings = (await app.call('getTeamInfo', { teamId })).data;
    assert.equal(settings.practiceStartDate, null);
    assert.equal(settings.dailyGoalMinutes, null);
    assert.equal(settings.effectivePracticeStartDate, '2026-09-17');
  }
});

test('legacy teams derive defaults from their creation practice day without being limited by old creator reservations', async () => {
  const app = harness({ teams: [
    team({ createdAt: '2026-09-02T03:59:59+08:00' }),
    team({ _id: 'after-reset', name: '四点创建', createdAt: '2026-09-02T04:00:00+08:00' }),
    { _id: '_old_creator_reservation', isActive: false, lockField: 'creator', targetTeamId: 'team' }
  ] });
  const before = await app.call('getTeamInfo', { teamId: 'team' });
  const after = await app.call('getTeamInfo', { teamId: 'after-reset' });
  assert.equal(before.data.practiceStartDate, '2026-09-01');
  assert.equal(after.data.practiceStartDate, '2026-09-02');
  assert.equal(before.data.dailyGoalMinutes, 20);
  assert.equal(before.data.hasPracticeStartDate, false);
  assert.equal(before.data.effectivePracticeStartDate, '2026-09-01');
  assert.equal((await app.call('createTeam', { name: '第三个团队' })).success, true);
  assert.equal((await app.call('getAllTeams')).data.count, 3);
});

function practiceRecord(id, openid, date, duration, timestamp) {
  return { _id: id, _openid: openid, date, duration, ...(timestamp === undefined ? {} : { timestamp }),
    experience: ['private experience'], textPreview: 'private journal' };
}

test('practice report sums same-day sessions, keeps today separate, and counts qualified/below/missed historical days', async () => {
  const initialTeam = team({ members: ['owner', 'member', 'absent'], practiceStartDate: '2026-09-14', dailyGoalMinutes: 20 });
  const app = harness({ teams: [initialTeam], users: [
    { _id: 'u-owner', _openid: 'owner', nickName: '队长昵称', avatarUrl: 'cloud://avatar' },
    { _id: 'u-member', _openid: 'member', nickName: '新成员' }
  ], team_members: [{ _id: 'team_member', teamId: 'team', openid: 'member', joinedAt: '2026-09-17T00:00:00Z' }], meditation_records: [
    practiceRecord('one', 'owner', '2026-09-14', 12),
    practiceRecord('two', 'owner', '2026-09-14', 8),
    practiceRecord('below', 'owner', '2026-09-15', 19.99),
    practiceRecord('zero', 'owner', '2026-09-16', 0),
    practiceRecord('today-one', 'owner', '2026-09-17', 5),
    practiceRecord('today-two', 'owner', '2026-09-17', 15),
    practiceRecord('early-member-history', 'member', '2026-09-14', 40),
    practiceRecord('member-today', 'member', '2026-09-17', 19.99),
    practiceRecord('before-start', 'owner', '2026-09-13', 500),
    practiceRecord('future', 'owner', '2026-09-18', 100),
    practiceRecord('not-a-member', 'outsider', '2026-09-17', 500)
  ] });
  const result = await app.call('getTeamPracticeReport', { teamId: 'team' });
  assert.equal(result.success, true);
  const report = result.data;
  assert.equal(report.businessDate, '2026-09-17');
  assert.equal(report.nextResetAt, Date.parse('2026-09-18T04:00:00+08:00'));
  assert.deepEqual(report.settings, { practiceStartDate: '2026-09-14', effectivePracticeStartDate: '2026-09-14',
    hasPracticeStartDate: true, dailyGoalMinutes: 20, dayBoundaryHour: 4 });
  assert.deepEqual(report.history, { startDate: '2026-09-14', endDate: '2026-09-16', totalDays: 3 });
  assert.deepEqual(report.summary, { memberCount: 3, notPracticedCount: 1, practicedCount: 2, belowGoalCount: 1, qualifiedCount: 1 });
  assert.deepEqual(report.overview, { memberCount: 3, totalPracticeCount: 7, activeMemberCount: 2, activityRate: 67 });
  assert.ok(Math.abs(report.members[0].totalMinutes - 39.99) < 1e-10);
  assert.ok(Math.abs(report.members[0].cumulativeMinutes - 59.99) < 1e-10);
  assert.deepEqual({ ...report.members[0], totalMinutes: 39.99, cumulativeMinutes: 59.99 }, { openid: 'owner', nickname: '队长昵称', avatarUrl: 'cloud://avatar', isCreator: true,
    todayMinutes: 20, todayStatus: 'qualified', practiceDays: 2, qualifiedDays: 1, belowGoalDays: 1, missedDays: 1, unmetDays: 2, totalMinutes: 39.99,
    totalPracticeCount: 5, todayPracticeCount: 2, cumulativeMinutes: 59.99, lastPracticeAt: null, lastPracticeDate: '2026-09-17' });
  const member = report.members.find(row => row.openid === 'member');
  assert.equal(member.todayMinutes, 19.99);
  assert.equal(member.todayStatus, 'below_goal');
  assert.equal(member.practiceDays, 1, 'history uses the uniform team start even for a newly joined member');
  assert.equal(member.qualifiedDays, 1);
  assert.equal(member.missedDays, 2);
  const absent = report.members.find(row => row.openid === 'absent');
  assert.equal(absent.practiceDays, 0);
  assert.equal(absent.missedDays, 3);
  assert.equal(absent.unmetDays, 3);
  assert.equal(JSON.stringify(report).includes('private journal'), false);
});

test('teams without a goal show actual activity since creation without inventing qualified or unmet days', async () => {
  const todayTimestamp = Date.parse('2026-09-17T05:30:00+08:00');
  const app = harness({ teams: [team({ members: ['owner', 'member', 'absent'],
    createdAt: '2026-09-15T03:59:59+08:00', practiceStartDate: null, dailyGoalMinutes: null })], meditation_records: [
    practiceRecord('start-day', 'owner', '2026-09-14', 3),
    practiceRecord('history-second', 'owner', '2026-09-14', 7),
    practiceRecord('older-known-time', 'owner', '2026-09-16', 4, '2026-09-16T22:30:00+08:00'),
    practiceRecord('today-later', 'owner', '2026-09-17', 6, todayTimestamp),
    practiceRecord('today-earlier', 'owner', '2026-09-17', 2, '2026-09-17T04:30:00+08:00'),
    practiceRecord('member-older-known', 'member', '2026-09-15', 8, '2026-09-15T13:00:00+08:00'),
    practiceRecord('member-newer-date-only', 'member', '2026-09-16', 12),
    practiceRecord('before-creation-day', 'owner', '2026-09-13', 100),
    practiceRecord('future-time', 'owner', '2026-09-17', 100, NOW + 1),
    practiceRecord('zero-duration', 'absent', '2026-09-17', 0),
    practiceRecord('outsider', 'outsider', '2026-09-17', 100)
  ] });
  const result = await app.call('getTeamPracticeReport', { teamId: 'team' });
  assert.equal(result.success, true);
  const report = result.data;
  assert.deepEqual(report.settings, { practiceStartDate: null, dailyGoalMinutes: null,
    effectivePracticeStartDate: '2026-09-14', hasPracticeStartDate: false, dayBoundaryHour: 4 });
  assert.deepEqual(report.history, { startDate: '2026-09-14', endDate: '2026-09-16', totalDays: 3 });
  assert.deepEqual(report.summary, { memberCount: 3, practicedCount: 1, notPracticedCount: 2, belowGoalCount: 0, qualifiedCount: 0 });
  assert.deepEqual(report.overview, { memberCount: 3, totalPracticeCount: 7, activeMemberCount: 1, activityRate: 33 });
  const [owner, member, absent] = report.members;
  assert.equal(owner.todayStatus, 'practiced');
  assert.equal(owner.todayMinutes, 8);
  assert.equal(owner.todayPracticeCount, 2);
  assert.equal(owner.totalPracticeCount, 5);
  assert.equal(owner.cumulativeMinutes, 22);
  assert.equal(owner.totalMinutes, 14);
  assert.equal(owner.practiceDays, 2);
  assert.equal(owner.missedDays, 1);
  assert.equal(owner.lastPracticeAt, todayTimestamp);
  assert.equal(owner.lastPracticeDate, '2026-09-17');
  assert.equal(member.todayStatus, 'not_practiced');
  assert.equal(member.lastPracticeDate, '2026-09-16');
  assert.equal(member.lastPracticeAt, null, 'date-only recent practice must not show an older precise time');
  assert.equal(absent.totalPracticeCount, 0);
  assert.equal(absent.cumulativeMinutes, 0);
  assert.equal(absent.lastPracticeAt, null);
  assert.equal(absent.lastPracticeDate, null);
  for (const row of report.members) {
    for (const field of ['qualifiedDays', 'belowGoalDays', 'unmetDays']) assert.equal(row[field], 0, field);
  }
  assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { dailyGoalMinutes: 5 } })).success, true);
  const withGoal = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.equal(withGoal.members[0].todayStatus, 'qualified');
  assert.equal(withGoal.members[0].qualifiedDays, 1);
  assert.equal(withGoal.members[0].belowGoalDays, 1);
  assert.equal(withGoal.members[0].unmetDays, 2);
  assert.equal(withGoal.members[0].totalPracticeCount, owner.totalPracticeCount);
  assert.equal(withGoal.members[0].cumulativeMinutes, owner.cumulativeMinutes);
});

test('04:00 boundaries include next-calendar-day early records and prioritize numeric, ISO and numeric-string timestamps', async () => {
  const before = Date.parse('2026-09-18T03:59:59.999+08:00');
  const exact = Date.parse('2026-09-18T04:00:00+08:00');
  const records = [
    practiceRecord('previous-day', 'owner', '2026-09-17', 11, Date.parse('2026-09-17T03:59:59.999+08:00')),
    practiceRecord('day-start', 'owner', 'wrong-date', 7, '2026-09-17T04:00:00+08:00'),
    practiceRecord('next-calendar-early', 'owner', '2026-09-18', 13, String(before)),
    practiceRecord('at-reset', 'owner', '2026-09-18', 5, exact),
    practiceRecord('date-only', 'owner', '2026-09-16', 9),
    practiceRecord('invalid-time-legacy', 'owner', '2026-09-16', 1, 'invalid'),
    practiceRecord('date-only-today', 'owner', '2026-09-17', 2),
    practiceRecord('too-old-timestamp', 'owner', '2026-09-17', 999, Date.parse('2026-09-15T12:00:00+08:00'))
  ];
  const initial = { teams: [team({ practiceStartDate: '2026-09-16', dailyGoalMinutes: 20 })], meditation_records: records };
  const beforeApp = harness(initial, { now: before });
  const beforeReport = (await beforeApp.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.equal(beforeReport.businessDate, '2026-09-17');
  assert.equal(beforeReport.members[0].todayMinutes, 22);
  assert.equal(beforeReport.members[0].totalMinutes, 21);
  assert.equal(beforeReport.members[0].qualifiedDays, 1);
  assert.equal(beforeReport.nextResetAt, exact);
  const atApp = harness(initial, { now: exact });
  const atReport = (await atApp.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.equal(atReport.businessDate, '2026-09-18');
  assert.equal(atReport.members[0].todayMinutes, 5);
  assert.equal(atReport.members[0].todayStatus, 'below_goal');
  assert.equal(atReport.members[0].totalMinutes, 43);
  assert.equal(atReport.members[0].qualifiedDays, 2);
  assert.equal(atReport.members[0].practiceDays, 2);
  assert.equal(atReport.history.totalDays, 2);
  assert.equal(atReport.nextResetAt, Date.parse('2026-09-19T04:00:00+08:00'));
});

test('starting today has zero historical days, and malformed durations/dates or future timestamps cannot add practice', async () => {
  const app = harness({ teams: [team({ practiceStartDate: '2026-09-17' })], meditation_records: [
    practiceRecord('valid', 'owner', '2026-09-17', '19.99'),
    practiceRecord('negative', 'owner', '2026-09-17', -5),
    practiceRecord('boolean', 'owner', '2026-09-17', true),
    practiceRecord('invalid-duration', 'owner', '2026-09-17', '20 minutes'),
    practiceRecord('empty-duration', 'owner', '2026-09-17', ''),
    practiceRecord('missing-duration', 'owner', '2026-09-17', null),
    practiceRecord('invalid-date', 'owner', '2026-02-30', 100),
    practiceRecord('future-time', 'owner', '2026-09-17', 100, NOW + 1000),
    practiceRecord('yesterday', 'owner', '2026-09-16', 50)
  ] });
  const report = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.deepEqual(report.history, { startDate: '2026-09-17', endDate: '2026-09-16', totalDays: 0 });
  const member = report.members[0];
  assert.equal(member.todayMinutes, 19.99);
  assert.equal(member.todayStatus, 'below_goal');
  for (const key of ['practiceDays', 'qualifiedDays', 'belowGoalDays', 'missedDays', 'unmetDays', 'totalMinutes']) assert.equal(member[key], 0, key);
});

test('practice reports require membership and scope reads to current members without returning private record contents', async () => {
  const initial = { teams: [team({ members: ['owner', 'current'], practiceStartDate: '2026-09-16' })], meditation_records: [
    practiceRecord('old-member', 'left-team', '2026-09-16', 100)
  ] };
  const denied = harness(initial);
  assert.equal((await denied.call('getTeamPracticeReport', { teamId: 'team' }, '', { openid: 'owner' })).success, false);
  assert.equal((await denied.call('getTeamPracticeReport', { teamId: 'team', openid: 'owner' }, 'outsider')).success, false);
  assert.equal(denied.reads.filter(read => ['users', 'meditation_records'].includes(read.name)).length, 0);
  const allowed = harness(initial);
  const report = await allowed.call('getTeamPracticeReport', { teamId: 'team', memberOpenids: ['left-team'] }, 'current');
  assert.equal(report.success, true);
  assert.deepEqual(report.data.members.map(member => member.openid), ['owner', 'current']);
  for (const read of allowed.reads.filter(read => read.name === 'meditation_records')) {
    assert.deepEqual(read.filter._openid.inValues, ['owner', 'current']);
    assert.deepEqual(Object.keys(read.projection).sort(), ['_id', '_openid', 'date', 'duration', 'timestamp']);
  }
});

test('practice reports page beyond 100 rows and batch large rosters without losing days or minutes', async () => {
  const members = ['owner', ...Array.from({ length: 44 }, (_, index) => `member-${index}`)];
  const records = members.map((member, index) => practiceRecord(`member-record-${index}`, member, '2026-09-16', 1));
  for (let index = 0; index < 205; index++) records.push(practiceRecord(`extra-${String(index).padStart(3, '0')}`, 'owner', '2026-09-16', 1));
  records.push(practiceRecord('outsider', 'outsider', '2026-09-16', 9999));
  const app = harness({ teams: [team({ members, practiceStartDate: '2026-09-16' })], meditation_records: records });
  const report = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.equal(report.members.length, 45);
  assert.equal(report.members[0].totalMinutes, 206);
  assert.equal(report.members[0].practiceDays, 1);
  assert.equal(report.members[0].qualifiedDays, 1);
  assert.equal(report.members[0].totalPracticeCount, 206);
  assert.equal(report.members[0].cumulativeMinutes, 206);
  assert.equal(report.overview.totalPracticeCount, 250);
  assert.equal(report.summary.notPracticedCount, 45);
  const reads = app.reads.filter(read => read.name === 'meditation_records');
  assert.equal(reads.length, 5);
  assert.ok(reads.every(read => read.filter._openid.inValues.length <= 20));
  assert.ok(reads.every(read => read.offset === 0));
  assert.equal(reads.filter(read => read.filter._id).length, 2);
  assert.equal(app.reads.filter(read => read.name === 'users').length, 3);
});

test('practice report storage failures surface rather than fabricating absence or resetting settings', async () => {
  const initial = { teams: [team({ practiceStartDate: '2026-09-14', dailyGoalMinutes: 30 })] };
  const app = harness(initial, { fail: 'meditation_records:get' });
  assert.equal((await app.call('getTeamPracticeReport', { teamId: 'team' })).success, false);
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.stored.teams, initial.teams);
  const failedUpdate = harness(initial, { fail: 'commit' });
  assert.equal((await failedUpdate.call('updateTeam', { teamId: 'team', teamData: { dailyGoalMinutes: 10 } })).success, false);
  assert.equal(failedUpdate.stored.teams[0].dailyGoalMinutes, 30);
});

test('fractional session sums meet an exact goal without rounding genuinely insufficient minutes up', async () => {
  const records = [];
  for (let index = 0; index < 100; index++) records.push(practiceRecord(`past-${index}`, 'owner', '2026-09-16', 0.2));
  for (let index = 0; index < 200; index++) records.push(practiceRecord(`today-${index}`, 'owner', '2026-09-17', 0.1));
  records.push(practiceRecord('below', 'member', '2026-09-17', 19.999999));
  const app = harness({ teams: [team({ members: ['owner', 'member'], practiceStartDate: '2026-09-16' })], meditation_records: records });
  const report = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  const owner = report.members[0];
  assert.equal(owner.todayMinutes, 20);
  assert.equal(owner.todayStatus, 'qualified');
  assert.equal(owner.totalMinutes, 20);
  assert.equal(owner.qualifiedDays, 1);
  assert.equal(report.members[1].todayStatus, 'below_goal');
  assert.equal(report.members[1].todayMinutes, 19.999999);
});

test('ISO timestamps without a timezone use the legacy date instead of the cloud runtime timezone', async () => {
  const app = harness({ teams: [team({ practiceStartDate: '2026-09-16' })], meditation_records: [
    practiceRecord('timezone-missing', 'owner', '2026-09-16', 20, '2026-09-17T03:00:00')
  ] });
  const report = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  assert.equal(report.members[0].todayMinutes, 0);
  assert.equal(report.members[0].totalMinutes, 20);
  assert.equal(report.members[0].qualifiedDays, 1);
});

test('practice report does not count a prior-page record twice when a new checkin sorts before the cursor', async () => {
  const records = Array.from({ length: 101 }, (_, index) => practiceRecord(
    `r${String(index).padStart(3, '0')}`, 'owner', '2026-09-17', index === 100 ? 0.9 : 0.19, NOW - 1000));
  let inserted = false;
  const app = harness({ teams: [team({ practiceStartDate: '2026-09-17', dailyGoalMinutes: 20 })], meditation_records: records }, {
    afterQuery({ name }, rows) {
      if (name !== 'meditation_records' || inserted) return;
      inserted = true;
      // A new checkin completed after this report started must not change its as-of time.
      rows.meditation_records.push(practiceRecord('a-new-checkin', 'owner', '2026-09-17', 50, NOW + 1000));
    }
  });
  const result = await app.call('getTeamPracticeReport', { teamId: 'team' });
  assert.equal(result.success, true);
  assert.equal(inserted, true);
  assert.ok(Math.abs(result.data.members[0].todayMinutes - 19.9) < 1e-10);
  assert.equal(result.data.members[0].todayStatus, 'below_goal');
  assert.equal(result.data.summary.qualifiedCount, 0);
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 2);
});

test('practice report retains the next-page record when an already-read document is deleted before the cursor', async () => {
  const records = Array.from({ length: 101 }, (_, index) => practiceRecord(
    `r${String(index).padStart(3, '0')}`, 'owner', '2026-09-17', index === 0 ? 0 : index === 100 ? 1.2 : 0.19, NOW - 1000));
  let removed = false;
  const app = harness({ teams: [team({ practiceStartDate: '2026-09-17', dailyGoalMinutes: 20 })], meditation_records: records }, {
    afterQuery({ name }, rows) {
      if (name !== 'meditation_records' || removed) return;
      removed = true;
      rows.meditation_records = rows.meditation_records.filter(record => record._id !== 'r000');
    }
  });
  const result = await app.call('getTeamPracticeReport', { teamId: 'team' });
  assert.equal(result.success, true);
  assert.equal(removed, true);
  assert.ok(Math.abs(result.data.members[0].todayMinutes - 20.01) < 1e-10);
  assert.equal(result.data.members[0].todayStatus, 'qualified');
  assert.equal(result.data.summary.qualifiedCount, 1);
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 2);
});

test('member practice records require active membership for both requester and target before reading private collections', async () => {
  const initial = { teams: [team({ members: ['owner', 'member'] })] };
  const app = harness(initial);
  for (const [data, requester, extra] of [
    [{ teamId: 'team', memberOpenid: 'member' }, '', { openid: 'owner' }],
    [{ teamId: 'team', memberOpenid: 'member', openid: 'owner' }, 'outsider', { openid: 'owner' }],
    [{ teamId: 'team', memberOpenid: 'former-member' }, 'owner'],
    [{ teamId: 'team', memberOpenid: '' }, 'owner'],
    [{ teamId: 'team', memberOpenid: { $ne: '' } }, 'owner'],
    [{ teamId: 'missing', memberOpenid: 'member' }, 'owner']
  ]) {
    assert.equal((await app.call('getTeamMemberPracticeRecords', data, requester, extra)).success, false);
  }
  assert.equal(app.reads.filter(read => ['users', 'meditation_records'].includes(read.name)).length, 0);
  const inactive = harness({ teams: [team({ isActive: false, members: ['owner', 'member'] })] });
  assert.equal((await inactive.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'member' })).success, false);
  assert.equal(inactive.reads.filter(read => ['users', 'meditation_records'].includes(read.name)).length, 0);
  const allowed = await app.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'owner' }, 'member');
  assert.equal(allowed.success, true);
  assert.deepEqual(allowed.data.member, { openid: 'owner', nickname: '队长', avatarUrl: '/images/avatar.png', isCreator: true });
});

test('member practice records match report business dates and accepted durations without exposing journal content', async () => {
  const numericTimestamp = Date.parse('2026-09-17T04:00:00+08:00');
  const app = harness({ teams: [team({ members: ['owner', 'member'], practiceStartDate: '2026-09-16' })], users: [
    { _id: 'user-member', _openid: 'member', nickName: '成员昵称', avatarUrl: 'cloud://member', secret: 'profile secret' }
  ], meditation_records: [
    practiceRecord('before-boundary', 'member', '2026-09-17', '12.5', '2026-09-17T03:59:59+08:00'),
    { ...practiceRecord('at-boundary', 'member', '2026-09-01', 3, String(numericTimestamp)), source: 'bijing' },
    practiceRecord('legacy', 'member', '2026-09-16', 5),
    practiceRecord('invalid-timezone', 'member', '2026-09-16', 7, '2026-09-17T03:00:00'),
    practiceRecord('today-now', 'member', 'wrong-date', 0.2, NOW),
    practiceRecord('before-start', 'member', '2026-09-16', 100, '2026-09-16T03:59:59+08:00'),
    practiceRecord('future-time', 'member', '2026-09-17', 100, NOW + 1),
    practiceRecord('future-date', 'member', '2026-09-18', 100),
    practiceRecord('bad-date', 'member', '2026-02-30', 100),
    practiceRecord('zero', 'member', '2026-09-16', 0),
    practiceRecord('negative', 'member', '2026-09-16', -2),
    practiceRecord('invalid-duration', 'member', '2026-09-16', '3minutes'),
    practiceRecord('owner-private', 'owner', '2026-09-16', 999),
    practiceRecord('outsider-private', 'outsider', '2026-09-16', 999)
  ] });
  const result = await app.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'member' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.member, { openid: 'member', nickname: '成员昵称', avatarUrl: 'cloud://member', isCreator: false });
  assert.equal(result.data.startDate, '2026-09-16');
  assert.equal(result.data.businessDate, '2026-09-17');
  assert.deepEqual(result.data.records, [
    { _id: 'today-now', date: '2026-09-17', timestamp: NOW, duration: 0.2 },
    { _id: 'at-boundary', date: '2026-09-17', timestamp: numericTimestamp, duration: 3, source: 'bijing' },
    { _id: 'before-boundary', date: '2026-09-16', timestamp: numericTimestamp - 1000, duration: 12.5 },
    { _id: 'invalid-timezone', date: '2026-09-16', timestamp: null, duration: 7 },
    { _id: 'legacy', date: '2026-09-16', timestamp: null, duration: 5 }
  ]);
  for (const read of app.reads.filter(read => read.name === 'meditation_records')) {
    assert.equal(read.filter._openid, 'member');
    assert.deepEqual(Object.keys(read.projection).sort(), ['_id', 'date', 'duration', 'source', 'timestamp']);
  }
  assert.equal(JSON.stringify(result).includes('private'), false);
  const report = (await app.call('getTeamPracticeReport', { teamId: 'team' })).data;
  const memberReport = report.members.find(member => member.openid === 'member');
  assert.equal(memberReport.totalPracticeCount, result.data.records.length);
  assert.ok(Math.abs(memberReport.cumulativeMinutes - result.data.records.reduce((sum, record) => sum + record.duration, 0)) < 1e-10);
});

test('member records use the effective team creation date and keep empty records with profile fallback', async () => {
  const app = harness({ teams: [team({ members: ['member'], createdAt: '2026-09-17T03:59:59+08:00', practiceStartDate: null })], meditation_records: [
    practiceRecord('old', 'member', '2026-09-15', 10)
  ] });
  const result = await app.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'member' });
  assert.equal(result.success, true, 'creator is a member even if missing from the stored roster');
  assert.deepEqual(result.data, { member: { openid: 'member', nickname: '匿名用户', avatarUrl: '/images/avatar.png', isCreator: false },
    startDate: '2026-09-16', businessDate: '2026-09-17', records: [] });
});

test('member records page all sessions with stable cursors despite concurrent insertion and removal', async () => {
  const records = Array.from({ length: 205 }, (_, index) => practiceRecord(
    `r${String(index).padStart(3, '0')}`, 'member', '2026-09-17', 1, NOW - 1000));
  let changed = false;
  const app = harness({ teams: [team({ members: ['owner', 'member'], practiceStartDate: '2026-09-17' })], meditation_records: records }, {
    afterQuery({ name }, rows) {
      if (name !== 'meditation_records' || changed) return;
      changed = true;
      rows.meditation_records = rows.meditation_records.filter(record => record._id !== 'r000');
      rows.meditation_records.push(practiceRecord('a-new', 'member', '2026-09-17', 1, NOW + 1000));
      rows.meditation_records.push(practiceRecord('z-new', 'member', '2026-09-17', 1, NOW + 1000));
    }
  });
  const result = await app.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'member' });
  assert.equal(result.success, true);
  assert.equal(result.data.records.length, 205);
  assert.deepEqual(result.data.records.map(record => record._id), records.map(record => record._id));
  const reads = app.reads.filter(read => read.name === 'meditation_records');
  assert.equal(reads.length, 3);
  assert.ok(reads.every(read => read.offset === 0 && read.limit === 100));
  assert.deepEqual(reads.slice(1).map(read => read.filter._id.bounds[0].value), ['r099', 'r199']);
});

test('member record database failures are returned as errors instead of an empty history', async () => {
  for (const name of ['users', 'meditation_records']) {
    const app = harness({ teams: [team()] }, { fail: `${name}:get` });
    const result = await app.call('getTeamMemberPracticeRecords', { teamId: 'team', memberOpenid: 'owner' });
    assert.equal(result.success, false);
    assert.match(result.error, /unavailable/);
    assert.equal(app.writes.length, 0);
  }
});
