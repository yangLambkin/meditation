const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataTeams } = require('../miniprogram/utils/dataTeams.js');

const makeTeam = extra => ({ id: 12, name: '觉察', description: '', iconUrl: '', practiceType: 'instant', unit: '次',
  leaderMemberId: 7, leaderName: '团长', memberCount: 2, myRole: 'creator', version: 4,
  practiceStartDate: null, effectivePracticeStartDate: '2026-11-01', dailyGoal: 2000, dayBoundaryHour: 2,
  createdAt: '2026-11-01 12:00:00', updatedAt: '2026-11-05 12:00:00', ...extra });
const roster = [{ memberId: 7, nickname: '团长', studentNumber: 'BJ007', avatarUrl: '', role: 'creator' },
  { memberId: 8, nickname: '同修', studentNumber: 'BJ008', avatarUrl: '', role: 'member' }];
const rules = { practiceStartDate: null, effectivePracticeStartDate: '2026-11-01', dailyGoal: 2000, dayBoundaryHour: 2 };
const token = 'a'.repeat(64);
const icon = '/api/public/teams/avatar?key=stable&signature=stable';
// Match WeChat's RequestOption.method contract so unsupported HTTP verbs cannot
// pass in Node while failing on devices.
const requestMethods = new Set(['OPTIONS', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'CONNECT']);

function harness(options = {}) {
  let owner = options.guest ? null : { openid: 'wx-owner', studentNumber: 'BJ007', bindingVersion: 'v1' };
  const calls = [], downloads = [], uploads = [], cloudCalls = [];
  const auth = { getOwner: () => owner && { ...owner }, async authorize() {
    if (!owner) throw Object.assign(new Error('请先绑定学号'), { code: 'AUTH_REQUIRED' });
    return { ...owner };
  }, async getAccessToken() { return 'authorized-service-token'; } };
  const respond = (request, upload = false) => {
    const url = new URL(request.url);
    const apiPath = url.pathname.replace('/api/openapi/teams', '');
    const input = { ...request, params: Object.fromEntries(url.searchParams), apiPath };
    (upload ? uploads : calls).push(input);
    Promise.resolve().then(() => {
      if (options.response) return options.response(apiPath, input);
      return Promise.resolve(options.handler ? options.handler(apiPath, input) : apiPath === '/12'
        ? { team: makeTeam(), members: roster } : makeTeam())
        .then(data => ({ statusCode: 200, data: { success: true, data: { ...data,
          actorMemberId: options.actorMemberId === undefined ? 7 : options.actorMemberId } } }));
    }).then(request.success, error => request.fail({ errMsg: error.message }));
    return { abort() {} };
  };
  const wxApi = {
    getStorageSync: key => key === 'userOpenId' ? owner && owner.openid : undefined,
    request: request => {
      assert.ok(requestMethods.has(request.method || 'GET'), `wx.request does not support ${request.method}`);
      return respond(request);
    }, uploadFile: request => respond(request, true),
    cloud: {
      async downloadFile({ fileID }) { downloads.push(fileID); return options.download ? options.download(fileID) : { tempFilePath: '/tmp/checked.png' }; },
      async callFunction(request) { cloudCalls.push(request); throw new Error('new teams must not call cloud functions'); },
      database() { throw new Error('new teams must not read cloud collections'); }
    }
  };
  const adapter = createDataTeams({ auth, config: { enabled: true, baseUrl: 'https://data.example/', serviceAccessToken: 'authorized-service-token', ...options.config }, wxApi });
  return { adapter, calls, downloads, uploads, cloudCalls,
    setOwner(value) { owner = value; },
    run: (type, data) => adapter.run(type, data, options.guest ? '' : 'wx-owner') };
}

test('creation uses wx.request with canonical OpenAPI fields, binding headers and a stable operation key', async () => {
  const h = harness();
  const result = await h.run('createTeam', { name: '觉察', practiceType: 'instant', dailyGoalMinutes: 2000,
    operationKey: 'stable-operation-123', creator: 'forged', studentNumber: 'BJ999', members: ['victim'] });
  assert.equal(result.data.teamId, 'bijing_12');
  assert.equal(result.data.team.creator, 'wx-owner');
  assert.deepEqual(result.data.team.members, ['wx-owner']);
  assert.deepEqual(result.data.team.tags, ['即刻觉察']);
  assert.equal(result.data.team.createdAt, '2026-11-01T04:00:00.000Z');
  assert.deepEqual(h.calls[0].data, { name: '觉察', description: '', iconUrl: '', practiceType: 'instant', practiceStartDate: null, dailyGoal: 2000 });
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].header['X-Expected-Student-Number'], 'BJ007');
  assert.equal(h.calls[0].header['X-Expected-Binding-Version'], 'v1');
  assert.equal(h.calls[0].header['Idempotency-Key'], 'stable-operation-123');
  assert.equal(h.calls[0].header['X-Access-Token'], 'authorized-service-token');
  assert.equal(h.calls[0].header['X-Team-Access-Token'], undefined);
  assert.equal(h.cloudCalls.length, 0);
});

test('missing binding, malformed operation key and invalid data IDs stop before HTTP', async () => {
  const guest = harness({ guest: true });
  await assert.rejects(guest.run('createTeam', { name: 'a', operationKey: 'stable-key' }), { code: 'AUTH_REQUIRED' });
  assert.equal(guest.calls.length, 0);
  const h = harness();
  await assert.rejects(h.run('createTeam', { name: 'a' }), /标识/);
  for (const id of ['legacy', 'bijing_bad', 'bijing_0', 'bijing_9007199254740992']) {
    await assert.rejects(h.run('deleteTeam', { teamId: id }), /编号无效/);
  }
  assert.equal(h.calls.length, 0);
});

test('lists exhaust opaque cursor pages, preserve roles, and reject repeated cursors', async () => {
  const h = harness({ handler: (path, input) => ({ teams: [makeTeam(input.params.cursor ? { id: 13, myRole: 'deputy', leaderMemberId: 8 } : {})],
    nextCursor: input.params.cursor ? null : 'opaque-list-cursor' }) });
  const teams = await h.adapter.list('mine', 'wx-owner');
  assert.equal(teams.length, 2);
  assert.equal(teams[1].creator, 'bijing_member_8');
  assert.deepEqual(teams[1].deputyLeaders, ['wx-owner']);
  assert.equal(h.calls[1].params.cursor, 'opaque-list-cursor');
  const cyclic = harness({ handler: () => ({ teams: [], nextCursor: 'same' }) });
  await assert.rejects(cyclic.adapter.list('mine', 'wx-owner'), /分页异常/);
  assert.equal(cyclic.calls.length, 2);
});

test('unbound viewers only read public previews and cannot obtain a roster or create', async () => {
  const h = harness({ guest: true, handler: () => ({ teams: [makeTeam({ leaderMemberId: undefined, myRole: null })], nextCursor: null }) });
  assert.deepEqual(await h.adapter.list('mine', ''), []);
  const preview = await h.run('getTeamInfo', { teamId: 'bijing_12' });
  assert.equal(preview.data.creator, undefined);
  assert.equal(preview.data.isMember, false);
  assert.deepEqual(preview.data.members, []);
  assert.equal(h.calls[0].header['X-Expected-Student-Number'], undefined);
  assert.equal(h.calls[0].header['X-Access-Token'], 'authorized-service-token');
});

test('member detail, WeChat-compatible versioned edits and each role mutation retain data member identities', async () => {
  let action = null;
  const h = harness({ handler(path, input) {
    if (path === '/12/actions') { action = input.data; return { teamId: 12 }; }
    if (input.method === 'PUT') return makeTeam({ name: input.data.name });
    const members = action && action.action === 'remove' ? roster.slice(0, 1) : roster.map(member => ({ ...member,
      role: action && action.action === 'transferLeader' ? member.memberId === 8 ? 'creator' : 'member'
        : action && action.action === 'setDeputy' && member.memberId === 8 ? 'deputy' : member.role }));
    return { team: makeTeam(action && action.action === 'transferLeader' ? { leaderMemberId: 8, myRole: 'member' } : {}), members };
  } });
  const detail = await h.run('getTeamInfo', { teamId: 'bijing_12' });
  assert.deepEqual(detail.data.members.map(member => member.openid), ['wx-owner', 'bijing_member_8']);
  assert.equal((await h.run('checkTeamMember', { teamId: 'bijing_12' })).isMember, true);
  await h.run('updateTeam', { teamId: 'bijing_12', expectedVersion: 3, teamData: { name: '更新', practiceType: 'walking', dailyGoalMinutes: 3000 } });
  const edit = h.calls.find(input => input.method === 'PUT');
  assert.ok(edit, 'team edits must use the WeChat-supported PUT method');
  assert.equal(edit.data.expectedVersion, 3);
  assert.equal(edit.data.practiceType, 'instant');
  assert.equal(edit.data.dailyGoal, 3000);
  const deputy = await h.run('setTeamDeputy', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8', isDeputy: true });
  assert.deepEqual(action, { action: 'setDeputy', memberId: 8, isDeputy: true });
  assert.deepEqual(deputy.data.deputyLeaders, ['bijing_member_8']);
  const transfer = await h.run('transferTeamLeader', { teamId: 'bijing_12', newLeaderOpenid: 'bijing_member_8', expectedLeaderOpenid: 'wx-owner' });
  assert.deepEqual(action, { action: 'transferLeader', memberId: 8, expectedLeaderMemberId: 7 });
  assert.equal(transfer.data.creator, 'bijing_member_8');
  const removed = await h.run('removeTeamMember', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8' });
  assert.deepEqual(action, { action: 'remove', memberId: 8 });
  assert.deepEqual(removed.data.members, ['wx-owner']);
});

test('delete and leave use their dedicated data mutations without querying cloud state', async () => {
  const h = harness({ handler: () => ({ teamId: 12 }) });
  assert.equal((await h.run('deleteTeam', { teamId: 'bijing_12' })).success, true);
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].apiPath, '/12');
  assert.equal((await h.run('leaveTeam', { teamId: 'bijing_12' })).success, true);
  assert.equal(h.calls[1].apiPath, '/12/actions');
  assert.deepEqual(h.calls[1].data, { action: 'leave' });
  assert.equal(h.cloudCalls.length, 0);
});

test('invitations preserve the share URL and data audit, while cross-team invitations cannot join', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/12') return { team: makeTeam(), members: roster };
    if (path === '/12/invite') return { token, expireTime: '2026-11-12 12:00:00', teamName: '觉察' };
    if (input.method === 'POST') return { teamId: 12 };
    return { team: makeTeam(), isMember: false };
  } });
  const invite = (await h.run('generateInvite', { teamId: 'bijing_12' })).data;
  const params = new URL('https://local/' + invite.sharePath).searchParams;
  assert.equal(params.get('teamId'), 'bijing_12');
  assert.equal(params.get('inviterId'), 'wx-owner');
  assert.equal(params.get('inviteId'), token);
  assert.equal(invite.expireTime, Date.parse('2026-11-12T12:00:00+08:00'));
  assert.equal((await h.run('recordInviteAction', { teamId: 'bijing_12', inviteId: token })).data.actionId, token);
  assert.equal((await h.run('recordInviteRelation', { teamId: 'bijing_12' })).data.relationId, 'bijing_12');
  assert.equal((await h.run('joinTeam', { teamId: 'bijing_12', inviteId: token })).data.teamId, 'bijing_12');
  const crossTeam = harness({ handler: () => ({ team: makeTeam({ id: 99 }), isMember: false }) });
  await assert.rejects(crossTeam.run('joinTeam', { teamId: 'bijing_12', inviteId: token }), /不匹配/);
  assert.equal(crossTeam.calls.filter(call => call.method === 'POST').length, 0);
});

test('reports, history and member records retain units, opaque cursors and Beijing timestamps', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/12') return { team: makeTeam(), members: roster };
    if (path === '/12/report') return { settings: rules,
      members: roster.map(member => ({ ...member, todayValue: 2001, totalValue: 5000, cumulativeValue: 7001 })) };
    if (path === '/12/history') {
      assert.equal(input.params.cursor, 'history-cursor');
      assert.equal(input.params.memberId, '8');
      return { settings: rules, items: [{ ...roster[1], date: '2026-11-04', value: 1900, status: 'below_goal' }], nextCursor: 'history-next' };
    }
    assert.equal(path, '/12/members/8/records');
    assert.equal(input.params.cursor, 'records-cursor');
    return { member: roster[1], records: [{ id: 33, date: '2026-11-04', occurredAt: '2026-11-05 01:00:00', value: 5, source: 'manual' }], nextCursor: 'records-next' };
  } });
  const report = (await h.run('getTeamPracticeReport', { teamId: 'bijing_12', month: '2026-11' })).data;
  assert.equal(report.members[0].todayMinutes, 2001);
  assert.equal(report.members[0].cumulativeMinutes, 7001);
  assert.equal(report.settings.dailyGoalMinutes, 2000);
  assert.equal(report.unit, '次');
  const history = (await h.run('getTeamHistoryDetails', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8', cursor: 'history-cursor' })).data;
  assert.equal(history.items[0].openid, 'bijing_member_8');
  assert.equal(history.items[0].minutes, 1900);
  assert.equal(history.nextCursor, 'history-next');
  const records = (await h.run('getTeamMemberPracticeRecords', { teamId: 'bijing_12', memberOpenid: 'bijing_member_8', cursor: 'records-cursor' })).data;
  assert.equal(records.records[0].timestamp, Date.parse('2026-11-05T01:00:00+08:00'));
  assert.equal(records.records[0].date, '2026-11-04');
  assert.equal(records.records[0].value, 5);
  assert.equal(records.nextCursor, 'records-next');
  await assert.rejects(h.run('getTeamMembersCheckinData', { teamId: 'bijing_12' }), /功课报表/);
});

test('account changes discard late responses and stop subsequent edits or uploads', async () => {
  const nextOwner = { openid: 'wx-owner', studentNumber: 'BJ007', bindingVersion: 'v2' };
  let changed;
  changed = harness({ handler() { changed.setOwner(nextOwner); return { team: makeTeam(), members: roster }; } });
  await assert.rejects(changed.run('updateTeam', { teamId: 'bijing_12', expectedVersion: 4, teamData: { name: 'a' } }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(changed.calls.length, 1);
  const uploading = harness({ download() { uploading.setOwner(null); return { tempFilePath: '/tmp/checked.png' }; } });
  await assert.rejects(uploading.adapter.uploadTeamIcon('cloud://checked'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(uploading.uploads.length, 0);
});

test('unavailable data routes, invalid actor IDs and unknown practice types never report success', async () => {
  for (const response of [
    { statusCode: 401, data: { success: false, message: '未登录' } },
    { statusCode: 404, data: '<html>not found</html>' },
    { statusCode: 503, data: { success: false, message: 'unavailable' } }
  ]) {
    const h = harness({ response: () => response });
    await assert.rejects(h.run('createTeam', { name: 'a', operationKey: 'stable-retry-key' }), { code: 'API_UNAVAILABLE' });
    assert.equal(h.cloudCalls.length, 0);
  }
  for (const actorMemberId of [null, 0, '7']) {
    const h = harness({ actorMemberId });
    await assert.rejects(h.run('createTeam', { name: 'a', operationKey: 'stable-retry-key' }), /身份结果异常/);
  }
  const unknown = harness({ handler: () => makeTeam({ practiceType: 'unknown' }) });
  await assert.rejects(unknown.run('createTeam', { name: 'a', operationKey: 'stable-retry-key' }), /功课类型/);
  const wrongType = harness({ handler: () => makeTeam({ practiceType: 'walking' }) });
  await assert.rejects(wrongType.run('createTeam', { name: 'a', practiceType: 'instant', operationKey: 'stable-retry-key' }), /所选功课类型/);
});

test('moderated cloud images upload directly to data and reuse relative signed URLs in mutations', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/avatar') return { url: icon };
    assert.equal(input.data.iconUrl, icon);
    return makeTeam({ iconUrl: icon });
  } });
  const uploaded = await h.adapter.uploadTeamIcon('cloud://checked-image');
  assert.equal(uploaded, 'https://data.example' + icon);
  assert.deepEqual(h.downloads, ['cloud://checked-image']);
  assert.equal(h.uploads[0].url, 'https://data.example/api/openapi/teams/avatar');
  assert.equal(h.uploads[0].name, 'file');
  assert.equal(h.uploads[0].filePath, '/tmp/checked.png');
  assert.equal(h.uploads[0].header['X-Expected-Student-Number'], 'BJ007');
  const created = await h.run('createTeam', { name: 'a', practiceType: 'instant', icon: uploaded, operationKey: 'avatar-stable-key' });
  assert.equal(created.data.team.icon, uploaded);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.cloudCalls.length, 0);
});

const multiTeam = extra => makeTeam({ practices: [
  { practiceType: 'instant', practiceStartDate: null, effectivePracticeStartDate: '2026-11-01', dailyGoal: 2000, unit: '次' },
  { practiceType: 'kindness', practiceStartDate: '2026-11-04', effectivePracticeStartDate: '2026-11-04', dailyGoal: 1, unit: '件' },
  { practiceType: 'walking', practiceStartDate: '2026-11-05', effectivePracticeStartDate: '2026-11-05', dailyGoal: 30, unit: '分钟' }
], ...extra });

test('multi-practice creation confirms every rule and shows all tags without changing the default', async () => {
  const input = multiTeam().practices.map(({ practiceType, practiceStartDate, dailyGoal }) => ({ practiceType, practiceStartDate, dailyGoalMinutes: dailyGoal }));
  const h = harness({ handler: () => multiTeam() });
  const result = await h.run('createTeam', { name: '一起练习', practices: input, operationKey: 'multi-stable-key' });
  assert.equal(h.calls[0].data.practiceType, 'instant');
  assert.equal(h.calls[0].data.dailyGoal, 2000);
  assert.deepEqual(h.calls[0].data.practices, multiTeam().practices.map(({ practiceType, practiceStartDate, dailyGoal }) => ({ practiceType, practiceStartDate, dailyGoal })));
  assert.deepEqual(result.data.team.tags, ['即刻觉察', '日行一善', '走路觉察']);
  assert.equal(result.data.team.practices[1].dailyGoalMinutes, 1);
  const oldServer = harness();
  await assert.rejects(oldServer.run('createTeam', { name: 'a', practiceType: 'instant', practices: input, operationKey: 'multi-retry-key' }), /全部功课配置/);
});

test('editing a secondary practice retains default scalar rules and checks full server confirmation', async () => {
  const h = harness({ handler(path, input) {
    return input.method === 'PUT' ? multiTeam({ practices: input.data.practices.map(item => ({ ...item,
      effectivePracticeStartDate: item.practiceStartDate || '2026-11-01', unit: item.practiceType === 'instant' ? '次' : item.practiceType === 'kindness' ? '件' : '分钟' })) })
      : { team: multiTeam(), members: roster };
  } });
  const practices = multiTeam().practices.map(item => ({ ...item, dailyGoalMinutes: item.practiceType === 'kindness' ? 3 : item.dailyGoal }));
  practices.forEach(item => { delete item.dailyGoal; });
  const result = await h.run('updateTeam', { teamId: 'bijing_12', expectedVersion: 4, teamData: { practices, dailyGoalMinutes: 3 } });
  const edit = h.calls.find(call => call.method === 'PUT');
  assert.equal(edit.data.dailyGoal, 2000);
  assert.equal(edit.data.practices[1].dailyGoal, 3);
  assert.equal(result.data.team.practices[1].dailyGoalMinutes, 3);
});

test('selected homework scopes reports, history and member records including their independent start dates', async () => {
  const h = harness({ handler(path, input) {
    if (path === '/12') return { team: multiTeam(), members: roster };
    assert.equal(input.params.practiceType, 'kindness');
    if (path.endsWith('/report')) return { practiceType: 'kindness', unit: '件', settings: { ...rules, dailyGoal: 1 }, members: roster.map(item => ({ ...item, todayValue: 1, totalValue: 2, cumulativeValue: 3 })) };
    if (path.endsWith('/history')) return { practiceType: 'kindness', unit: '件', settings: { ...rules, dailyGoal: 1 }, items: [], nextCursor: null };
    return { practiceType: 'kindness', unit: '件', member: roster[1], records: [], nextCursor: null };
  } });
  for (const type of ['getTeamPracticeReport', 'getTeamHistoryDetails', 'getTeamMemberPracticeRecords']) {
    const result = await h.run(type, { teamId: 'bijing_12', practiceType: 'kindness', memberOpenid: 'bijing_member_8' });
    assert.equal(result.data.practiceType, 'kindness');
    assert.equal(result.data.unit, '件');
    if (type === 'getTeamMemberPracticeRecords') assert.equal(result.data.startDate, '2026-11-04');
  }
  await assert.rejects(h.run('getTeamPracticeReport', { teamId: 'bijing_12', practiceType: 'clapping' }), /未加入团队/);
});

test('a selected homework rejects an old/default response instead of relabeling its quantities', async () => {
  const h = harness({ handler: path => path === '/12' ? { team: multiTeam(), members: roster }
    : { practiceType: 'instant', settings: rules, members: roster, items: [], member: roster[1], records: [], nextCursor: null } });
  for (const type of ['getTeamPracticeReport', 'getTeamHistoryDetails', 'getTeamMemberPracticeRecords']) {
    await assert.rejects(h.run(type, { teamId: 'bijing_12', practiceType: 'kindness', memberOpenid: 'bijing_member_8' }), /未确认所选功课/);
  }
});
