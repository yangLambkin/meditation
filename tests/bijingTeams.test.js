const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBijingTeams } = require('../cloudfunctions/teamManager/bijingTeams');

const makeTeam = extra => ({ id: 12, name: '觉察', description: '', iconUrl: '', practiceType: 'instant', unit: '次',
  leaderMemberId: 7, leaderName: '团长', memberCount: 2, myRole: 'creator', version: 4,
  practiceStartDate: null, effectivePracticeStartDate: '2026-11-01', dailyGoal: 2000, dayBoundaryHour: 2,
  createdAt: '2026-11-01 12:00:00', updatedAt: '2026-11-05 12:00:00', ...extra });
const roster = [{ memberId: 7, nickname: '团长', studentNumber: 'BJ007', avatarUrl: '', role: 'creator' },
  { memberId: 8, nickname: '同修', studentNumber: 'BJ008', avatarUrl: '', role: 'member' }];
const rules = { practiceStartDate: null, effectivePracticeStartDate: '2026-11-01', dailyGoal: 2000, dayBoundaryHour: 2 };

function harness(options = {}) {
  const users = options.users || [{ _id: 'user', _openid: 'wx-owner', bijingBound: true, bijingStudentNumber: 'BJ007' }];
  const calls = [], reads = [], downloads = [];
  const db = { collection(name) {
    assert.ok(['users', 'bijing_bindings'].includes(name), 'new teams must never read WeChat team or practice data');
    return {
      where(filter) { return { limit() { return this; }, async get() {
        reads.push({ name, filter });
        return { data: users.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)) };
      } }; },
      doc(id) { return { async get() { return { data: options.registries && options.registries[id] }; } }; }
    };
  } };
  const adapter = createBijingTeams({ db,
    env: { BIJING_API_BASE: 'https://data.example/', BIJING_ACCESS_TOKEN: 'server-secret',
      BIJING_TEAM_ACCESS_TOKEN: 'server-only-team-secret-32-or-more-characters', ...options.env },
    cloud: { async downloadFile({ fileID }) { downloads.push(fileID); return { fileContent: Buffer.from([137, 80, 78, 71, 1]) }; } },
    http: { async request(input) {
      calls.push(input);
      const path = input.url.replace('https://data.example/api/openapi/teams', '');
      const data = options.handler ? await options.handler(path, input, users) : path === '/12' ? { team: makeTeam(), members: roster } : makeTeam();
      return { data: { success: true, data: { ...data, actorMemberId: options.actorMemberId === undefined ? 7 : options.actorMemberId } } };
    } }
  });
  return { adapter, calls, reads, users, downloads, run: (type, data) => adapter.run(type, data, 'wx-owner') };
}

test('creation sends only canonical inputs and bound identity, preserving the client operation key', async () => {
  const h = harness();
  const result = await h.run('createTeam', { name: '觉察', practiceType: 'instant', dailyGoalMinutes: 2000,
    operationKey: 'stable-operation-123', creator: 'forged', studentNumber: 'BJ999', members: ['victim'] });
  assert.equal(result.data.teamId, 'bijing_12');
  assert.equal(result.data.team.creator, 'wx-owner');
  assert.deepEqual(result.data.team.members, ['wx-owner']);
  assert.deepEqual(result.data.team.tags, ['即刻觉察']);
  assert.equal(result.data.team.unit, '次');
  assert.equal(result.data.team.createdAt, '2026-11-01T04:00:00.000Z');
  assert.deepEqual(h.calls[0].data, { name: '觉察', description: '', iconUrl: '', practiceType: 'instant', practiceStartDate: null, dailyGoal: 2000 });
  assert.equal(h.calls[0].headers['X-Expected-Student-Number'], 'BJ007');
  assert.equal(h.calls[0].headers['Idempotency-Key'], 'stable-operation-123');
  assert.equal(h.calls[0].headers['X-Access-Token'], 'server-secret');
  assert.equal(h.calls[0].headers['X-Team-Access-Token'], 'server-only-team-secret-32-or-more-characters');
});

test('missing, duplicate and contradictory bindings fail before any OpenAPI mutation', async () => {
  for (const users of [[], [{ _id: 'u', _openid: 'wx-owner', bijingBound: true, bijingStudentNumber: 'BJ007', bijingBindingVersion: 'v1' }],
    [{ _id: 'u', _openid: 'wx-owner', bijingBound: true, bijingStudentNumber: 'BJ007' },
      { _id: 'other', _openid: 'wx-other', bijingBound: true, bijingStudentNumber: 'BJ007' }]]) {
    const h = harness({ users });
    await assert.rejects(h.run('createTeam', { name: 'a', operationKey: 'stable-operation-123' }), /绑定/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  await assert.rejects(h.run('createTeam', { name: 'a' }), /标识/);
  assert.equal(h.calls.length, 0);
});

test('the server-only team credential is required in addition to the distributed service token', async () => {
  for (const token of [undefined, '', 'short', 'server-secret']) {
    const h = harness({ env: { BIJING_TEAM_ACCESS_TOKEN: token } });
    await assert.rejects(h.run('createTeam', { name: 'a', operationKey: 'stable-operation-key' }), /尚未配置/);
    assert.equal(h.calls.length, 0);
  }
});

test('versioned bindings require both server registry documents', async () => {
  const user = { _id: 'user', _openid: 'wx-owner', bijingBound: true, bijingStudentNumber: 'BJ007', bijingBindingVersion: 'v1' };
  const registry = { userId: 'user', openid: 'wx-owner', studentNumber: 'BJ007', bindingVersion: 'v1', active: true };
  const key = (kind, value) => `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;
  const h = harness({ users: [user], registries: { [key('account', 'wx-owner')]: registry, [key('student', 'BJ007')]: registry } });
  assert.equal((await h.run('getTeamInfo', { teamId: 'bijing_12' })).data.creator, 'wx-owner');
});

test('mine lists exhaust all pages and preserve roles without exposing a public roster', async () => {
  const h = harness({ handler: (path, input) => ({ teams: [makeTeam(input.params.cursor ? { id: 13, myRole: 'deputy', leaderMemberId: 8 } : {})],
    nextCursor: input.params.cursor ? null : '12' }) });
  const teams = await h.adapter.list('mine', 'wx-owner');
  assert.equal(teams.length, 2);
  assert.equal(teams[1].creator, 'bijing_member_8');
  assert.deepEqual(teams[1].deputyLeaders, ['wx-owner']);
  assert.ok(teams[1].members.includes('wx-owner'));
  const guest = harness({ users: [], handler: () => ({ teams: [makeTeam({ leaderMemberId: undefined, myRole: null })], nextCursor: null }) });
  assert.deepEqual(await guest.adapter.list('mine', ''), []);
  const preview = await guest.adapter.run('getTeamInfo', { teamId: 'bijing_12' }, '');
  assert.equal(preview.data.creator, undefined);
  assert.equal(preview.data.isMember, false);
  assert.deepEqual(preview.data.members, []);
  assert.equal(guest.calls[0].headers['X-Expected-Student-Number'], undefined);
});

test('details and role changes map native member identities and retain optimistic version checks', async () => {
  let changed = false;
  const h = harness({ handler(path, input) {
    if (path === '/12/actions') { assert.deepEqual(input.data, { action: 'setDeputy', memberId: 8, isDeputy: true }); changed = true; return { teamId: 12 }; }
    if (input.method === 'PATCH') { assert.equal(input.data.expectedVersion, 3); return makeTeam(); }
    return { team: makeTeam(), members: roster.map(member => changed && member.memberId === 8 ? { ...member, role: 'deputy' } : member) };
  } });
  const detail = await h.run('getTeamInfo', { teamId: 'bijing_12' });
  assert.deepEqual(detail.data.members.map(member => member.openid), ['wx-owner', 'bijing_member_8']);
  const deputy = await h.run('setTeamDeputy', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8', isDeputy: true });
  assert.deepEqual(deputy.data.deputyLeaders, ['bijing_member_8']);
  await h.run('updateTeam', { teamId: 'bijing_12', expectedVersion: 3, teamData: { name: '更新' } });
});

test('reports and history read data values, units and opaque cursors without querying WeChat records', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/12') return { team: makeTeam(), members: roster };
    if (path === '/12/report') return { teamId: 12, practiceType: 'instant', unit: '次', settings: rules,
      members: roster.map(member => ({ ...member, todayValue: 2001, totalValue: 5000, cumulativeValue: 7001 })), overview: {} };
    assert.equal(input.params.cursor, 'opaque-cursor');
    assert.equal(input.params.memberId, 8);
    return { teamId: 12, settings: rules, items: [{ ...roster[1], date: '2026-11-04', value: 1900, status: 'below_goal' }], nextCursor: 'next-token' };
  } });
  const report = (await h.run('getTeamPracticeReport', { teamId: 'bijing_12' })).data;
  assert.equal(report.members[0].todayMinutes, 2001);
  assert.equal(report.members[0].cumulativeMinutes, 7001);
  assert.equal(report.settings.dailyGoalMinutes, 2000);
  assert.equal(report.creator, 'wx-owner');
  const history = (await h.run('getTeamHistoryDetails', { teamId: 'bijing_12', cursor: 'opaque-cursor', memberOpenid: 'bijing_member_8', month: '2026-11' })).data;
  assert.equal(history.items[0].minutes, 1900);
  assert.equal(history.items[0].openid, 'bijing_member_8');
  assert.equal(history.nextCursor, 'next-token');
});

test('member records preserve values, business dates and pagination, with Beijing timestamp interpretation', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/12') return { team: makeTeam(), members: roster };
    assert.equal(path, '/12/members/8/records');
    assert.equal(input.params.cursor, 'records-cursor');
    return { member: roster[1], records: [{ id: 33, date: '2026-11-04', occurredAt: '2026-11-05 01:00:00', value: 5, source: 'manual' }], nextCursor: 'more' };
  } });
  const result = (await h.run('getTeamMemberPracticeRecords', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8', cursor: 'records-cursor' })).data;
  assert.equal(result.records[0].timestamp, Date.parse('2026-11-05T01:00:00+08:00'));
  assert.equal(result.records[0].date, '2026-11-04');
  assert.equal(result.records[0].value, 5);
  assert.equal(result.nextCursor, 'more');
});

test('invites retain the page share contract and join cannot use an invite from another team', async () => {
  const token = 'a'.repeat(64);
  const h = harness({ handler(path) {
    if (path === '/12') return { team: makeTeam(), members: roster };
    if (path === '/12/invite') return { token, expireTime: '2026-11-12 12:00:00', teamName: '觉察' };
    return { team: makeTeam({ id: 99 }), isMember: false };
  } });
  const invite = (await h.run('generateInvite', { teamId: 'bijing_12' })).data;
  const params = new URL('https://local/' + invite.sharePath).searchParams;
  assert.equal(params.get('inviterId'), 'wx-owner');
  assert.equal(params.get('inviteId'), token);
  assert.ok(Number.isFinite(invite.expireTime));
  assert.equal(invite.expireTime, Date.parse('2026-11-12T12:00:00+08:00'));
  await assert.rejects(h.run('joinTeam', { teamId: 'bijing_12', inviteId: token }), /不匹配/);
  assert.equal(h.calls.filter(call => call.url.includes('/invites/') && call.method === 'POST').length, 0);
});

test('binding changes between API calls stop the next mutation, and service errors never fall back to WeChat', async () => {
  const h = harness({ handler(path, input, users) { users[0].bijingStudentNumber = 'BJ008'; return { team: makeTeam(), members: roster }; } });
  await assert.rejects(h.run('updateTeam', { teamId: 'bijing_12', expectedVersion: 4, teamData: { name: 'a' } }), /绑定已变化/);
  assert.equal(h.calls.length, 1);
  const down = harness({ handler() { throw Object.assign(new Error('request failed secret'), { response: { status: 500, data: { message: 'secret database details' } } }); } });
  await assert.rejects(down.run('deleteTeam', { teamId: 'bijing_12' }), /暂时无法连接/);
  await assert.rejects(down.run('deleteTeam', { teamId: 'bijing_bad' }), /编号无效/);
  assert.equal(down.calls.length, 1);
});

test('cloud avatars upload through the authenticated OpenAPI and display using the data origin', async () => {
  const relative = '/api/public/teams/avatar?key=stable&signature=stable';
  const h = harness({ async handler(path, input) {
    if (path === '/avatar') {
      assert.match(input.headers['Content-Type'], /multipart\/form-data/);
      const form = await new Response(input.data, { headers: { 'Content-Type': input.headers['Content-Type'] } }).formData();
      assert.equal(form.get('file').type, 'image/png');
      assert.equal(form.get('file').size, 5);
      return { url: relative };
    }
    assert.equal(input.data.iconUrl, relative);
    return makeTeam({ iconUrl: relative });
  } });
  const result = await h.run('createTeam', { name: 'a', icon: 'cloud://checked-image', operationKey: 'avatar-stable-key' });
  assert.deepEqual(h.downloads, ['cloud://checked-image']);
  assert.equal(result.data.team.icon, 'https://data.example' + relative);
});
