const crypto = require('crypto');

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

function createBijingTeams({ db, cloud, http, env = process.env }) {
  const base = () => {
    if (!env.BIJING_API_BASE || !env.BIJING_ACCESS_TOKEN || typeof env.BIJING_TEAM_ACCESS_TOKEN !== 'string' ||
        env.BIJING_TEAM_ACCESS_TOKEN.length < 32 || env.BIJING_TEAM_ACCESS_TOKEN === env.BIJING_ACCESS_TOKEN) {
      throw new Error('团队服务尚未配置，请稍后重试');
    }
    return env.BIJING_API_BASE.replace(/\/+$/, '');
  };
  const displayUrl = value => value && value.startsWith('/api/public/teams/avatar?') ? base() + value : value || '/images/icons/team.png';
  async function binding(openid, optional = false) {
    if (!openid) { if (optional) return null; throw new Error('请先登录并绑定必经之路学号'); }
    const rows = (await db.collection('users').where({ _openid: openid, bijingBound: true }).limit(2).get()).data;
    if (!rows.length && optional) return null;
    if (rows.length !== 1 || typeof rows[0].bijingStudentNumber !== 'string' || !rows[0].bijingStudentNumber.trim()) {
      throw new Error('请先绑定本人必经之路学号');
    }
    const user = rows[0];
    const number = user.bijingStudentNumber.trim();
    // 同一学号只接受一个已绑定微信账号；版本化绑定还须与双向登记一致。
    const peers = (await db.collection('users').where({ bijingBound: true, bijingStudentNumber: number }).limit(2).get()).data;
    if (peers.length !== 1 || peers[0]._openid !== openid) throw new Error('学号绑定状态异常，请重新绑定');
    if (user.bijingBindingVersion) {
      for (const [kind, value] of [['account', openid], ['student', number]]) {
        const key = `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;
        let registry;
        try { registry = (await db.collection('bijing_bindings').doc(key).get()).data; }
        catch (_) { throw new Error('学号绑定已变化，请重新绑定'); }
        if (!registry || registry.active !== true || registry.openid !== openid || registry.studentNumber !== number ||
            registry.bindingVersion !== user.bijingBindingVersion || registry.userId !== user._id) {
          throw new Error('学号绑定已变化，请重新绑定');
        }
      }
    }
    return { openid, number, version: user.bijingBindingVersion || null };
  }
  async function request(actor, method, path, data, params, extraHeaders = {}) {
    const url = base() + '/api/openapi/teams' + path;
    if (actor) {
      const current = await binding(actor.openid);
      if (current.number !== actor.number || current.version !== actor.version) throw new Error('学号绑定已变化，请刷新后重试');
    }
    try {
      const response = await (http || require('axios')).request({ url, method, data, params, timeout: 15000,
        maxContentLength: 4 * 1024 * 1024, maxBodyLength: 3 * 1024 * 1024,
        headers: { 'X-Access-Token': env.BIJING_ACCESS_TOKEN, 'X-Team-Access-Token': env.BIJING_TEAM_ACCESS_TOKEN,
          ...(actor ? { 'X-Expected-Student-Number': actor.number } : {}), ...extraHeaders } });
      const payload = response.data;
      if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') throw new Error('团队服务未返回完整结果，请重试');
      if (actor && !Number.isSafeInteger(payload.data.actorMemberId)) throw new Error('团队服务身份结果异常');
      if (actor) {
        const current = await binding(actor.openid);
        if (current.number !== actor.number || current.version !== actor.version) throw new Error('学号绑定已变化，请刷新后重试');
      }
      if (actor) actor.memberId = idOf(payload.data.actorMemberId);
      return payload.data;
    } catch (error) {
      const status = error.response && error.response.status;
      const message = error.response && error.response.data && error.response.data.message;
      if (status >= 400 && status < 500 && typeof message === 'string') throw Object.assign(new Error(message), { status });
      if (error.response || error.code) throw new Error('团队服务暂时无法连接，请稍后重试');
      throw error;
    }
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
  async function iconUrl(value, actor) {
    if (!value || value === '/images/icons/team.png') return '';
    const root = base();
    const relative = value.startsWith(root + '/api/public/teams/avatar?') ? value.slice(root.length) : value;
    if (relative.startsWith('/api/public/teams/avatar?')) return relative;
    if (!value.startsWith('cloud://')) throw new Error('请重新选择并上传团队头像');
    const result = await cloud.downloadFile({ fileID: value });
    const content = result.fileContent;
    if (!Buffer.isBuffer(content) || content.length < 1 || content.length > 2 * 1024 * 1024) throw new Error('请选择2MB以内的团队头像');
    const mime = content[0] === 0xff && content[1] === 0xd8 ? 'image/jpeg' : content.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
    const boundary = 'team-avatar-' + crypto.randomBytes(16).toString('hex');
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`),
      content, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const valueOut = await request(actor, 'POST', '/avatar', form, undefined,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(form.length) });
    if (typeof valueOut.url !== 'string' || !valueOut.url.startsWith('/api/public/teams/avatar?')) throw new Error('团队头像上传结果异常');
    return valueOut.url;
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
      const updated = await request(actor, 'PATCH', path, body);
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
  return { list, run, binding };
}

module.exports = { createBijingTeams, isBijingTeam };
