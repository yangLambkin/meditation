const configDefault = require('./teamConfig.js');
const authDefault = require('./practiceAuth.js');

const PREFIX = 'bijing_';
const MEMBER_PREFIX = 'bijing_member_';
const TYPES = { sitting: '静坐觉察', walking: '走路觉察', instant: '即刻觉察', learning: '熏习', kindness: '日行一善', clapping: '禅拍' };
const idOf = value => {
  if (!Number.isSafeInteger(Number(value)) || !/^[1-9]\d*$/.test(String(value))) throw new Error('必经团队编号无效');
  return Number(value);
};
const isBijingTeam = value => typeof value === 'string' && value.startsWith(PREFIX);
const teamId = value => PREFIX + idOf(value);
const nativeId = value => {
  if (!isBijingTeam(value)) throw new Error('必经团队编号无效');
  return idOf(value.slice(PREFIX.length));
};
// data 的 MySQL 时间无时区，含义固定为北京时间，不能按云函数所在时区解释。
function timestamp(value) {
  if (typeof value !== 'string' || !value) return NaN;
  const text = value.replace(' ', 'T');
  return Date.parse(text + (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? '' : '+08:00'));
}
const isoTime = value => {
  const time = timestamp(value);
  if (!Number.isFinite(time)) throw new Error('团队时间格式异常');
  return new Date(time).toISOString();
};

function createDataTeams({ auth = authDefault, config = configDefault, wxApi = () => wx } = {}) {
  const wxClient = () => typeof wxApi === 'function' ? wxApi() : wxApi;
  const base = () => {
    if (config.enabled !== true || !/^https:\/\//.test(config.baseUrl || '')) throw new Error('团队接口尚未开放，请稍后重试');
    return config.baseUrl.replace(/\/+$/, '');
  };
  const displayUrl = value => value && value.startsWith('/api/public/teams/avatar?') ? base() + value : value || '/images/icons/team.png';
  const sameOwner = (a, b) => !!(a && b && a.openid === b.openid && a.studentNumber === b.studentNumber && String(a.bindingVersion || '') === String(b.bindingVersion || ''));
  const assertActor = actor => {
    if (!actor) return;
    if (!sameOwner(actor.owner, auth.getOwner())) throw Object.assign(new Error('账号或绑定已变化，请重新进入团队'), { code: 'ACCOUNT_CHANGED' });
  };
  async function binding(openid, optional = false) {
    const owner = auth.getOwner();
    if (!owner || owner.openid !== openid) {
      if (optional) return null;
      throw Object.assign(new Error('请先在「我」中登录并绑定本人学号'), { code: 'AUTH_REQUIRED' });
    }
    await auth.authorize();
    if (!sameOwner(owner, auth.getOwner())) throw Object.assign(new Error('账号或绑定已变化，请重新进入团队'), { code: 'ACCOUNT_CHANGED' });
    return { openid, number: owner.studentNumber, version: owner.bindingVersion, owner };
  }
  function transport(options, upload = false) {
    return new Promise((resolve, reject) => {
      let settled = false, task;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
      const timer = setTimeout(() => {
        finish(reject, Object.assign(new Error('团队请求超时，请使用原表单重试'), { code: 'REQUEST_TIMEOUT' }));
        if (task && task.abort) task.abort();
      }, 15000);
      try {
        task = wxClient()[upload ? 'uploadFile' : 'request']({ ...options, timeout: 15000,
          success: value => finish(resolve, value),
          fail: () => finish(reject, Object.assign(new Error('团队服务暂时无法连接，请稍后重试'), { code: 'NETWORK_ERROR' })) });
      } catch (_) { finish(reject, new Error('团队服务暂时无法连接，请稍后重试')); }
    });
  }
  function decode(result) {
    let payload = result.data;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) {} }
    const status = Number(result.statusCode);
    if (status >= 200 && status < 300 && payload && payload.success === true && payload.data && typeof payload.data === 'object') return payload.data;
    const unavailable = status === 401 || status === 503 || status === 404 && (!payload || typeof payload !== 'object' || typeof payload.success !== 'boolean');
    const message = unavailable ? '团队接口尚未就绪或凭据未配置，请稍后重试' : payload && (payload.message || payload.error) || '团队服务未返回完整确认，请重试';
    throw Object.assign(new Error(typeof message === 'string' ? message : '团队操作失败，请重试'), { status, code: unavailable ? 'API_UNAVAILABLE' : 'TEAM_REQUEST_FAILED' });
  }
  async function headers(actor, extra = {}) {
    // 与功课 OpenAPI 共用过渡服务凭据；学号和绑定版本用于请求归属核对。
    const token = actor ? await auth.getAccessToken() : config.serviceAccessToken;
    if (!token) throw new Error('团队接口凭据尚未配置');
    assertActor(actor);
    return { 'X-Access-Token': token, ...(actor ? { 'X-Expected-Student-Number': actor.number,
      'X-Expected-Binding-Version': String(actor.version || '') } : {}), ...extra };
  }
  async function request(actor, method, path, data, params, extraHeaders = {}) {
    assertActor(actor);
    const query = Object.entries(params || {}).filter(([,value]) => value !== undefined && value !== null && value !== '')
      .map(([key,value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
    const result = await transport({ url: base() + '/api/openapi/teams' + path + (query ? '?' + query : ''), method,
      ...(data !== undefined ? { data } : {}), header: await headers(actor, { 'Content-Type': 'application/json', ...extraHeaders }) });
    assertActor(actor);
    const payload = decode(result);
    if (actor && (!Number.isSafeInteger(payload.actorMemberId) || payload.actorMemberId < 1)) throw new Error('团队服务身份结果异常');
    if (actor) {
      if (actor.memberId && actor.memberId !== payload.actorMemberId) throw new Error('团队服务身份已变化，请重新进入团队');
      actor.memberId = payload.actorMemberId;
    }
    return payload;
  }
  function memberKey(id, actor) { return actor && Number(id) === actor.memberId ? actor.openid : MEMBER_PREFIX + idOf(id); }
  function memberId(value, actor) {
    if (actor && value === actor.openid) return idOf(actor.memberId);
    if (typeof value !== 'string' || !value.startsWith(MEMBER_PREFIX)) throw new Error('必经团队成员编号无效');
    return idOf(value.slice(MEMBER_PREFIX.length));
  }
  function settings(value) {
    return { practiceStartDate: value.practiceStartDate, effectivePracticeStartDate: value.effectivePracticeStartDate,
      dailyGoalMinutes: value.dailyGoal, dayBoundaryHour: value.dayBoundaryHour };
  }
  function profile(value, actor) {
    return { openid: memberKey(value.memberId, actor), nickname: value.nickname || '匿名用户',
      avatarUrl: value.avatarUrl || '/images/avatar.png', bijingStudentNumber: value.studentNumber || '',
      role: value.role, isCreator: value.role === 'creator', isDeputy: value.role === 'deputy' };
  }
  function normalize(value, actor, roster) {
    if (!TYPES[value.practiceType]) throw new Error('团队功课类型异常');
    const creator = value.leaderMemberId ? memberKey(value.leaderMemberId, actor) : undefined;
    const own = actor && value.myRole ? actor.openid : null;
    const members = roster ? roster.map(item => memberKey(item.memberId, actor)) : [...new Set([creator, own].filter(Boolean))];
    return { _id: teamId(value.id), cloudId: teamId(value.id), source: 'bijing', name: value.name,
      description: value.description || '', icon: displayUrl(value.iconUrl), iconUrl: value.iconUrl || '',
      practiceType: value.practiceType, practiceTypeName: TYPES[value.practiceType], tags: [TYPES[value.practiceType]], unit: value.unit,
      creator, creatorName: value.leaderName || '匿名用户', members, memberCount: value.memberCount,
      deputyLeaders: roster ? roster.filter(item => item.role === 'deputy').map(item => memberKey(item.memberId, actor))
        : value.myRole === 'deputy' && actor ? [actor.openid] : [],
      ...settings(value), version: value.version, myRole: value.myRole, isActive: true,
      createdAt: isoTime(value.createdAt), updatedAt: isoTime(value.updatedAt), isMember: !!value.myRole };
  }
  async function detail(actor, id) {
    const value = await request(actor, 'GET', `/${id}`);
    if (!value.team || !Array.isArray(value.members)) throw new Error('团队详情格式异常');
    return { raw: value, team: { ...normalize(value.team, actor, value.members),
      members: value.members.map(item => profile(item, actor)), isMember: true } };
  }
  async function list(scope, openid) {
    const actor = await binding(openid, true);
    if (!actor && scope === 'mine') return [];
    const teams = [], cursors = new Set();
    let cursor;
    do {
      const value = await request(actor, 'GET', '', undefined, { scope, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(value.teams)) throw new Error('团队列表格式异常');
      teams.push(...value.teams.map(item => normalize(item, actor)));
      cursor = value.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('团队分页异常，请重试');
      cursors.add(cursor);
    } while (cursor);
    return teams;
  }
  function isDataTeamIcon(value) {
    return typeof value === 'string' && (value.startsWith(base() + '/api/public/teams/avatar?') || value.startsWith('/api/public/teams/avatar?'));
  }
  async function uploadTeamIcon(value, actor) {
    actor = actor || await binding(wxClient().getStorageSync('userOpenId'));
    if (isDataTeamIcon(value)) return displayUrl(value);
    if (typeof value !== 'string' || !value.startsWith('cloud://')) throw new Error('请重新选择并审核团队头像');
    assertActor(actor);
    const file = await wxClient().cloud.downloadFile({ fileID: value });
    assertActor(actor);
    if (!file || !file.tempFilePath) throw new Error('团队头像读取失败，请重新选择');
    const result = await transport({ url: base() + '/api/openapi/teams/avatar', filePath: file.tempFilePath,
      name: 'file', header: await headers(actor) }, true);
    assertActor(actor);
    const uploaded = decode(result);
    if (!Number.isSafeInteger(uploaded.actorMemberId) || uploaded.actorMemberId < 1 || actor.memberId && actor.memberId !== uploaded.actorMemberId) throw new Error('团队服务身份结果异常');
    actor.memberId = uploaded.actorMemberId;
    if (typeof uploaded.url !== 'string' || !uploaded.url.startsWith('/api/public/teams/avatar?')) throw new Error('团队头像上传结果异常');
    return displayUrl(uploaded.url);
  }
  async function iconUrl(value, actor) {
    if (!value || value === '/images/icons/team.png') return '';
    if (isDataTeamIcon(value)) return value.startsWith(base()) ? value.slice(base().length) : value;
    const uploaded = await uploadTeamIcon(value, actor);
    return uploaded.slice(base().length);
  }
  function rosterResult(team) {
    return { teamId: team._id, creator: team.creator, creatorName: team.creatorName,
      members: team.members.map(member => member.openid), memberCount: team.memberCount, deputyLeaders: team.deputyLeaders };
  }
  async function run(type, data = {}, openid) {
    const actor = await binding(openid, type === 'getTeamInfo');
    if (type === 'createTeam') {
      if (!data || !/^[\x21-\x7e]{8,128}$/.test(data.operationKey || '')) throw new Error('创建请求标识无效，请重新进入创建页面');
      // 输入先由 data 验证，身份及成员始终由服务端绑定决定。
      const input = { name: data.name, description: data.description || '', practiceType: data.practiceType || 'sitting',
        practiceStartDate: data.practiceStartDate ?? null, dailyGoal: data.dailyGoalMinutes ?? null,
        iconUrl: await iconUrl(data.icon || '', actor) };
      const created = await request(actor, 'POST', '', input, undefined, { 'Idempotency-Key': data.operationKey });
      if (created.practiceType !== input.practiceType) throw new Error('团队服务未确认所选功课类型，请稍后重试');
      const team = normalize(created, actor);
      return { success: true, data: { teamId: team._id, team } };
    }
    const id = nativeId(data.teamId), path = `/${id}`;
    if (type === 'getTeamInfo') {
      if (!actor) {
        const team = (await list('public', openid)).find(item => item._id === data.teamId);
        if (!team) throw new Error('团队不存在或已解散');
        return { success: true, data: { ...team, members: [], isMember: false } };
      }
      if (data.inviteId) {
        const preview = await request(actor, 'GET', '/invites/' + encodeURIComponent(data.inviteId));
        if (!preview.team || preview.team.id !== id) throw new Error('邀请与团队不匹配');
        if (!preview.isMember) return { success: true, data: { ...normalize(preview.team, actor), members: [], isMember: false } };
      }
      try { return { success: true, data: (await detail(actor, id)).team }; }
      catch (error) {
        if (error.status !== 403) throw error;
        const team = (await list('public', openid)).find(item => item._id === data.teamId);
        if (!team) throw new Error('团队不存在或已解散');
        return { success: true, data: { ...team, members: [], isMember: false } };
      }
    }
    if (type === 'joinTeam') {
      if (typeof data.inviteId !== 'string' || !/^[a-f0-9]{64}$/.test(data.inviteId)) throw new Error('请通过团长或副团长的邀请加入团队');
      const invitePath = '/invites/' + data.inviteId;
      const preview = await request(actor, 'GET', invitePath);
      if (!preview.team || preview.team.id !== id) throw new Error('邀请与团队不匹配');
      const joined = await request(actor, 'POST', invitePath);
      if (joined.teamId !== id) throw new Error('加入团队结果异常，请刷新团队');
      return { success: true, data: { teamId: data.teamId } };
    }
    if (type === 'deleteTeam' || type === 'leaveTeam') {
      await request(actor, type === 'deleteTeam' ? 'DELETE' : 'POST', path + (type === 'leaveTeam' ? '/actions' : ''),
        type === 'leaveTeam' ? { action: 'leave' } : undefined);
      return { success: true, data: { teamId: data.teamId } };
    }
    const current = await detail(actor, id);
    if (type === 'checkTeamMember') return { success: true, isMember: true };
    if (type === 'updateTeam') {
      const input = data.teamData || {};
      const body = { name: input.name ?? current.team.name, description: input.description ?? current.team.description,
        iconUrl: input.icon === undefined ? current.raw.team.iconUrl : await iconUrl(input.icon, actor),
        practiceType: current.raw.team.practiceType, practiceStartDate: input.practiceStartDate === undefined ? current.raw.team.practiceStartDate : input.practiceStartDate,
        dailyGoal: input.dailyGoalMinutes === undefined ? current.raw.team.dailyGoal : input.dailyGoalMinutes,
        expectedVersion: data.expectedVersion ?? input.expectedVersion };
      // wx.request does not support PATCH; data also accepts PUT for versioned edits.
      const updated = await request(actor, 'PUT', path, body);
      return { success: true, data: { teamId: data.teamId, team: normalize(updated, actor, current.raw.members) } };
    }
    if (['setTeamDeputy', 'removeTeamMember', 'transferTeamLeader'].includes(type)) {
      const target = memberId(data.memberOpenid || data.newLeaderOpenid, actor);
      const body = type === 'setTeamDeputy' ? { action: 'setDeputy', memberId: target, isDeputy: data.isDeputy }
        : type === 'removeTeamMember' ? { action: 'remove', memberId: target }
          : { action: 'transferLeader', memberId: target, expectedLeaderMemberId: memberId(data.expectedLeaderOpenid, actor) };
      await request(actor, 'POST', path + '/actions', body);
      const changed = (await detail(actor, id)).team;
      return { success: true, data: { ...rosterResult(changed), ...(type === 'removeTeamMember' ? { memberOpenid: data.memberOpenid } : {}) } };
    }
    if (type === 'generateInvite') {
      const invite = await request(actor, 'POST', path + '/invite');
      const sharePath = '/subpackages/team/pages/joinTeam/joinTeam?' +
        `teamId=${encodeURIComponent(data.teamId)}&teamName=${encodeURIComponent(current.team.name)}&inviterId=${encodeURIComponent(openid)}&inviteId=${encodeURIComponent(invite.token)}`;
      return { success: true, data: { inviteId: invite.token, sharePath, expireTime: timestamp(invite.expireTime), title: `邀请您加入${current.team.name}团队` } };
    }
    // 邀请签发和加入的审计已由 data 在相应事务保存，不再向微信写重复遥测。
    if (type === 'recordInviteAction') {
      if (!['creator', 'deputy'].includes(current.raw.team.myRole)) throw new Error('只有团长或副团长可以邀请');
      const preview = await request(actor, 'GET', '/invites/' + encodeURIComponent(data.inviteId));
      if (!preview.team || preview.team.id !== id) throw new Error('邀请与团队不匹配');
      return { success: true, data: { actionId: data.inviteId } };
    }
    if (type === 'recordInviteRelation') return { success: true, data: { relationId: data.teamId } };
    if (type === 'getTeamPracticeReport' || type === 'getTeamMembersCheckinData') {
      const report = await request(actor, 'GET', path + '/report', undefined, data.month ? { month: data.month } : undefined);
      const members = report.members.map(member => ({ ...profile(member, actor), ...member,
        openid: memberKey(member.memberId, actor), todayMinutes: member.todayValue, totalMinutes: member.totalValue, cumulativeMinutes: member.cumulativeValue }));
      if (type === 'getTeamMembersCheckinData') throw new Error('请使用团队功课报表查看打卡数据');
      return { success: true, data: { ...report, teamId: data.teamId,
        creator: members.find(member => member.role === 'creator')?.openid,
        deputyLeaders: members.filter(member => member.role === 'deputy').map(member => member.openid),
        practiceType: current.team.practiceType, unit: current.team.unit, settings: settings(report.settings), members } };
    }
    if (type === 'getTeamHistoryDetails') {
      const history = await request(actor, 'GET', path + '/history', undefined, {
        ...(data.month ? { month: data.month } : {}), ...(data.filter ? { filter: data.filter } : {}),
        ...(data.memberOpenid ? { memberId: memberId(data.memberOpenid, actor) } : {}),
        ...(data.cursor ? { cursor: data.cursor } : {}), ...(data.limit ? { limit: data.limit } : {}) });
      return { success: true, data: { ...history, teamId: data.teamId, settings: settings(history.settings),
        practiceType: current.team.practiceType, unit: current.team.unit,
        items: history.items.map(item => ({ ...profile(item, actor), date: item.date, minutes: item.value, status: item.status })) } };
    }
    if (type === 'getTeamMemberPracticeRecords') {
      const records = await request(actor, 'GET', path + `/members/${memberId(data.memberOpenid, actor)}/records`, undefined,
        { ...(data.cursor ? { cursor: data.cursor } : {}), ...(data.month ? { month: data.month } : {}),
          ...(data.date ? { date: data.date } : {}), limit: 100 });
      return { success: true, data: { ...records, member: profile(records.member, actor),
        startDate: current.team.effectivePracticeStartDate, businessDate: new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10),
        practiceType: current.team.practiceType, unit: current.team.unit,
        records: records.records.map(record => ({ _id: String(record.id), date: record.date,
          timestamp: record.occurredAt ? timestamp(record.occurredAt) : null,
          duration: record.value, value: record.value, source: record.source })) } };
    }
    throw new Error('该团队操作暂不支持，请刷新团队页面');
  }
  return { list, run, uploadTeamIcon, isDataTeamIcon, getOwner: () => auth.getOwner() };
}

module.exports = { createDataTeams, isDataTeam: isBijingTeam };
