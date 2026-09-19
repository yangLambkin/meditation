const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const MAX_MEMBERS = 50;
const PAGE_SIZE = 100;
const DEFAULT_ICON = '/images/icons/team.png';
const DAY_MS = 24 * 60 * 60 * 1000;
const PRACTICE_BOUNDARY_HOUR = 4;
const DEFAULT_DAILY_GOAL_MINUTES = 20;
const MEMBER_BATCH_SIZE = 20;

// 身份只信任微信云函数上下文，不能接受客户端传入的 openid。
exports.main = async (event = {}) => {
  try {
    const { type, data = {} } = event;
    const openid = cloud.getWXContext().OPENID;
    if (type !== 'getAllTeams' && type !== 'getTeamInfo') requireLogin(openid);
    switch (type) {
      case 'createTeam': return await createTeam(data, openid);
      case 'getUserTeams': return { success: true, data: await userTeams(openid) };
      case 'deleteTeam': return await deleteTeam(data.teamId, openid);
      case 'joinTeam': return await joinTeam(data, openid);
      case 'leaveTeam': return await leaveTeam(data.teamId, openid);
      case 'updateTeam': return await updateTeam(data.teamId, data.teamData, openid);
      case 'getTeamInfo': return await getTeamInfo(data.teamId, openid);
      case 'checkTeamMember': {
        const team = await activeTeam(db, data.teamId);
        return { success: true, isMember: isMember(team, openid) };
      }
      case 'getTeamMembersCheckinData': return await getTeamMembersCheckinData(data, openid);
      case 'getMemberWeekCheckin': return await getMemberWeekCheckin(data, openid);
      case 'getTeamPracticeReport': return await getTeamPracticeReport(data.teamId, openid, data.month);
      case 'getTeamHistoryDetails': return await getTeamHistoryDetails(data, openid);
      case 'getTeamMemberPracticeRecords': return await getTeamMemberPracticeRecords(data, openid);
      case 'generateInvite': return await generateInvite(data, openid);
      case 'recordInviteAction': return await recordInviteAction(data, openid);
      case 'recordInviteRelation': return await recordInviteRelation(data, openid);
      case 'getAllTeams': return await getAllTeams();
      default: throw new Error('未知的操作类型');
    }
  } catch (error) {
    console.error('团队云函数执行错误:', error);
    return { success: false, error: error.message };
  }
};

function requireLogin(openid) {
  if (!openid) throw new Error('用户未登录');
}

function requireId(id, label = '团队') {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label}ID无效`);
  return id;
}

function memberIds(team) {
  return [...new Set([team.creator, ...(Array.isArray(team.members) ? team.members : [])]
    .filter(id => typeof id === 'string' && id))];
}

function isMember(team, openid) {
  return Boolean(openid && memberIds(team).includes(openid));
}

async function activeTeam(database, teamId) {
  requireId(teamId);
  const team = await optionalDocument(database, 'teams', teamId);
  if (!team || !team.isActive) throw new Error('团队不存在或已删除');
  return team;
}

async function optionalDocument(database, collection, id) {
  try { return (await database.collection(collection).doc(id).get()).data; }
  catch (error) {
    if (error.code === 'DATABASE_DOCUMENT_NOT_EXIST' ||
        /document.*(?:not exist|not found)|文档不存在/i.test(error.message || error.errMsg || '')) return null;
    throw error;
  }
}

async function readAll(query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await query.skip(offset).limit(PAGE_SIZE).get();
    rows.push(...result.data);
    if (result.data.length < PAGE_SIZE) return rows;
  }
}

async function userTeams(openid) {
  const teams = await readAll(db.collection('teams').where({
    isActive: true,
    $or: [{ creator: openid }, { members: openid }]
  }).orderBy('createdAt', 'desc').orderBy('_id', 'asc'));
  const now = Date.now();
  return teams.map(team => ({ ...team, ...practiceSettings(team, now) }));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function timestampValue(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 &&
    Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}

// 北京时间04:00切日等价于时间戳加4小时后读取UTC日期。
function practiceDate(timestamp) {
  return new Date(timestamp + (8 - PRACTICE_BOUNDARY_HOUR) * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function practiceSettings(team, now = Date.now()) {
  const today = practiceDate(now);
  const createdAt = timestampValue(team.createdAt);
  const defaultStart = Number.isFinite(createdAt) && createdAt <= now ? practiceDate(createdAt) : today;
  const hasPracticeStartDate = validDate(team.practiceStartDate) && team.practiceStartDate <= today;
  const effectivePracticeStartDate = hasPracticeStartDate ? team.practiceStartDate : defaultStart;
  return {
    // null明确表示未设置；旧团队缺字段时沿用创建日和20分钟，保留原统计规则。
    practiceStartDate: team.practiceStartDate === null ? null : effectivePracticeStartDate,
    effectivePracticeStartDate, hasPracticeStartDate,
    dailyGoalMinutes: team.dailyGoalMinutes === null ? null :
      Number.isInteger(team.dailyGoalMinutes) && team.dailyGoalMinutes >= 1 && team.dailyGoalMinutes <= 1440
        ? team.dailyGoalMinutes : DEFAULT_DAILY_GOAL_MINUTES,
    dayBoundaryHour: PRACTICE_BOUNDARY_HOUR
  };
}

function teamFields(data, creating = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('团队信息无效');
  const fields = {};
  if (creating || Object.prototype.hasOwnProperty.call(data, 'name')) {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 20) {
      throw new Error('团队名称须为1至20个字符');
    }
    fields.name = data.name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(data, 'description')) {
    if (typeof data.description !== 'string' || data.description.length > 100) throw new Error('团队介绍不能超过100个字符');
    fields.description = data.description;
  } else if (creating) fields.description = '';
  if (Object.prototype.hasOwnProperty.call(data, 'icon')) {
    if (data.icon != null && typeof data.icon !== 'string') throw new Error('团队头像无效');
    fields.icon = !data.icon || /^(?:http:\/\/tmp\/|wxfile:\/\/tmp)/.test(data.icon) ? DEFAULT_ICON : data.icon;
  } else if (creating) fields.icon = DEFAULT_ICON;
  if (Object.prototype.hasOwnProperty.call(data, 'practiceStartDate')) {
    if (data.practiceStartDate !== null && (!validDate(data.practiceStartDate) || data.practiceStartDate > practiceDate(Date.now()))) {
      throw new Error('共修开始日期须为不晚于当前共修日的有效日期');
    }
    fields.practiceStartDate = data.practiceStartDate;
  } else if (creating) fields.practiceStartDate = null;
  if (Object.prototype.hasOwnProperty.call(data, 'dailyGoalMinutes')) {
    if (data.dailyGoalMinutes !== null && (!Number.isInteger(data.dailyGoalMinutes) || data.dailyGoalMinutes < 1 || data.dailyGoalMinutes > 1440)) {
      throw new Error('每日目标须为1至1440之间的整数分钟');
    }
    fields.dailyGoalMinutes = data.dailyGoalMinutes;
  } else if (creating) fields.dailyGoalMinutes = null;
  // creator、members、memberCount、isActive 等字段只能由专门的服务端操作修改。
  return fields;
}

async function reserveUniqueField(transaction, field, value, teamId) {
  // 云数据库事务只使用 doc 操作。确定 ID 的预留文档在读后写时产生版本冲突，
  // 防止两个请求同时通过事务外的旧数据查询。预留文档不属于活跃团队。
  const id = `_team_lock_${field}_${crypto.createHash('sha256').update(value).digest('hex')}`;
  const reservation = await optionalDocument(transaction, 'teams', id);
  if (reservation && reservation.targetTeamId && reservation.targetTeamId !== teamId) {
    const reservedTeam = await optionalDocument(transaction, 'teams', reservation.targetTeamId);
    if (reservedTeam && reservedTeam.isActive && reservedTeam[field] === value) {
      throw new Error('团队名称已存在');
    }
  }
  await transaction.collection('teams').doc(id).set({ data: {
    isActive: false, _type: 'team_uniqueness_reservation',
    targetTeamId: teamId, lockField: field, updatedAt: db.serverDate()
  } });
}

async function createTeam(data, openid) {
  const fields = teamFields(data, true);
  const team = {
    ...fields, creator: openid,
    creatorName: typeof data.creatorName === 'string' ? data.creatorName : '匿名用户',
    members: [openid], memberCount: 1,
    createdAt: db.serverDate(), updatedAt: db.serverDate(), isActive: true
  };
  // 兼容尚未拥有预留文档的历史团队；事务内部不能使用 where/add。
  const named = await db.collection('teams').where({ name: fields.name, isActive: true }).limit(1).get();
  if (named.data.length) throw new Error('团队名称已存在');
  const teamId = `team_${crypto.randomBytes(16).toString('hex')}`;
  await db.runTransaction(async transaction => {
    await reserveUniqueField(transaction, 'name', fields.name, teamId);
    await transaction.collection('teams').doc(teamId).set({ data: team });
  });
  return { success: true, data: { teamId, team: {
    ...team, _id: teamId, createdAt: new Date(), updatedAt: new Date()
  } } };
}

async function updateTeam(teamId, data, openid) {
  const fields = teamFields(data);
  if (fields.name) {
    const existing = await db.collection('teams').where({ name: fields.name, isActive: true }).limit(2).get();
    if (existing.data.some(team => team._id !== teamId)) throw new Error('团队名称已存在');
  }
  await db.runTransaction(async transaction => {
    const team = await activeTeam(transaction, teamId);
    if (team.creator !== openid) throw new Error('只有团队创建者可以更新团队信息');
    if (fields.name && fields.name !== team.name) {
      await reserveUniqueField(transaction, 'name', fields.name, teamId);
    }
    await transaction.collection('teams').doc(teamId).update({ data: { ...fields, updatedAt: db.serverDate() } });
  });
  return { success: true, data: { teamId } };
}

async function deleteTeam(teamId, openid) {
  await db.runTransaction(async transaction => {
    const team = await activeTeam(transaction, teamId);
    if (team.creator !== openid) throw new Error('只有团队创建者可以删除团队');
    await transaction.collection('teams').doc(teamId).remove();
  });
  // 团队文档是权限和成员身份的唯一依据；清理旧索引失败不能恢复已删除的团队。
  for (const name of ['team_members', 'invites']) {
    try { await db.collection(name).where({ teamId }).remove(); }
    catch (error) { console.warn('清理团队附属记录失败:', name, error); }
  }
  return { success: true, data: { teamId } };
}

async function joinTeam(data, openid) {
  const { teamId, inviteId } = data;
  await db.runTransaction(async transaction => {
    const team = await activeTeam(transaction, teamId);
    const members = memberIds(team);
    // 重试同一请求时返回成功，避免重复成员和人数增长。
    if (members.includes(openid)) return;
    if (typeof inviteId !== 'string' || !inviteId.trim()) throw new Error('请通过团长的邀请加入团队');
    const invite = await optionalDocument(transaction, 'invites', inviteId);
    // 邀请必须由当前团长签发。忽略客户端 inviterId，也拒绝历史普通成员签发的邀请。
    // 分享到群聊的邀请仍可被多人使用，但不能跨团队、撤销后或过期后使用。
    if (!invite || invite.teamId !== teamId || invite.inviterId !== team.creator ||
        !['pending', 'accepted'].includes(invite.status) ||
        !Number.isFinite(timestampValue(invite.expireTime)) || timestampValue(invite.expireTime) <= Date.now()) {
      throw new Error('邀请链接已失效，请联系团长重新邀请');
    }
    if (members.length >= MAX_MEMBERS) throw new Error('团队人数已达上限');
    members.push(openid);
    await transaction.collection('teams').doc(teamId).update({
      data: { members, memberCount: members.length, updatedAt: db.serverDate() }
    });
    // set 可以覆盖旧版本退出后遗留的关系，团队及关系写入必须一起成功。
    await transaction.collection('team_members').doc(`${teamId}_${openid}`).set({ data: {
      teamId, openid, nickname: '新成员', role: 'member', joinedAt: db.serverDate(),
      invitedBy: invite.inviterId, inviteId, status: 'active',
      lastActive: db.serverDate(), checkInCount: 0,
      createdAt: db.serverDate(), updatedAt: db.serverDate()
    } });
  });
  return { success: true, data: { teamId } };
}

async function leaveTeam(teamId, openid) {
  await db.runTransaction(async transaction => {
    const team = await activeTeam(transaction, teamId);
    if (team.creator === openid) throw new Error('团队创建者不能离开团队，请删除团队');
    const members = memberIds(team).filter(id => id !== openid);
    await transaction.collection('teams').doc(teamId).update({
      data: { members, memberCount: members.length, updatedAt: db.serverDate() }
    });
    await transaction.collection('team_members').doc(`${teamId}_${openid}`).remove();
  });
  return { success: true, data: { teamId } };
}

async function getTeamInfo(teamId, openid) {
  const team = await activeTeam(db, teamId);
  const allowed = isMember(team, openid);
  const members = await Promise.all(memberIds(team).map(async memberOpenid => {
    let user = {};
    try {
      const users = await db.collection('users').where({ _openid: memberOpenid }).limit(1).get();
      user = users.data[0] || {};
    } catch (error) { console.warn('获取成员资料失败:', error); }
    return {
      ...(allowed ? { openid: memberOpenid } : {}),
      nickname: user.nickName || (memberOpenid === team.creator ? team.creatorName : '') || '匿名用户',
      avatarUrl: user.avatarUrl || '/images/avatar.png', isCreator: memberOpenid === team.creator
    };
  }));
  const info = allowed ? { ...team } : publicTeam(team);
  return { success: true, data: { ...info, ...practiceSettings(team), members, memberCount: members.length, isMember: allowed } };
}

// 打卡数据只能被本人或同一活跃团队的成员读取，不能接受任意 OPENID 查询。
async function authorizeMembers(data, requested, openid) {
  if (!Array.isArray(requested) || requested.length > MAX_MEMBERS || requested.some(id => typeof id !== 'string' || !id)) {
    throw new Error('成员列表无效');
  }
  const permitted = new Set([openid]);
  if (data.teamId) {
    const team = await activeTeam(db, data.teamId);
    if (!isMember(team, openid)) throw new Error('只有团队成员可以查看打卡数据');
    memberIds(team).forEach(id => permitted.add(id));
  } else {
    const teams = await userTeams(openid);
    teams.forEach(team => memberIds(team).forEach(id => permitted.add(id)));
  }
  if (requested.some(id => !permitted.has(id))) throw new Error('只能查看同团队成员的打卡数据');
  return [...new Set(requested)];
}

async function getTeamMembersCheckinData(data, openid) {
  const members = await authorizeMembers(data, data.memberOpenids, openid);
  const month = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const counts = await Promise.all(members.map(async memberOpenid => {
    const [monthly, total] = await Promise.all([
      db.collection('meditation_records').where({ _openid: memberOpenid,
        date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`)) }).count(),
      db.collection('meditation_records').where({ _openid: memberOpenid }).count()
    ]);
    return [memberOpenid, { monthlyCount: monthly.total, totalCount: total.total }];
  }));
  return { success: true, data: Object.fromEntries(counts) };
}

function recordTimestamp(record) {
  const value = record.timestamp;
  const timestamp = typeof value === 'number' ? value :
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.parse(`${record.date}T00:00:00+08:00`);
}

async function getMemberWeekCheckin(data, openid) {
  const { memberOpenid, weekStart, weekEnd } = data;
  await authorizeMembers(data, [memberOpenid], openid);
  if (![weekStart, weekEnd].every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) || weekStart > weekEnd) {
    throw new Error('打卡查询日期无效');
  }
  const result = await readAll(db.collection('meditation_records').where({
    _openid: memberOpenid, date: db.command.gte(weekStart).and(db.command.lte(weekEnd))
  }).orderBy('date', 'desc').orderBy('_id', 'asc'));
  const records = result.map(record => ({
    date: record.date, timestamp: recordTimestamp(record), duration: record.duration || 0,
    emotion: record.emotion || [], experience: record.experience || [],
    textCount: record.textCount || 0, textPreview: record.textPreview || ''
  })).sort((a, b) => b.timestamp - a.timestamp);
  return { success: true, data: { records, count: records.length } };
}

function positiveMinutes(value) {
  const minutes = typeof value === 'number' ? value :
    typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function addMinutes(total, minutes) {
  // 补偿求和，避免多次短练习累加后20分钟变成19.99999999999996。
  const corrected = minutes - total.correction;
  const next = total.sum + corrected;
  total.correction = (next - total.sum) - corrected;
  total.sum = next;
}

function meetsGoal(minutes, goal) {
  // 只容忍机器浮点误差，不将19.99等真实不足时长四舍五入成达标。
  return minutes >= goal || goal - minutes <= Number.EPSILON * Math.max(1, goal) * 4;
}

function practiceSession(record, startDate, businessDate, now) {
  const timestamp = timestampValue(record.timestamp);
  const hasTimestamp = Number.isFinite(timestamp);
  if (hasTimestamp && timestamp > now) return null;
  // 缺少有效时间戳的旧记录沿用原始日期，不能先补成零点再回退一天。
  const date = hasTimestamp ? practiceDate(timestamp) : validDate(record.date) ? record.date : null;
  const duration = positiveMinutes(record.duration);
  if (!date || date < startDate || date > businessDate || !duration) return null;
  return { date, timestamp: hasTimestamp ? timestamp : null, duration };
}

async function getTeamMemberPracticeRecords(data, openid) {
  const now = Date.now();
  const team = await activeTeam(db, data.teamId);
  if (!isMember(team, openid)) throw new Error('只有团队成员可以查看练习记录');
  const memberOpenid = requireId(data.memberOpenid, '成员');
  if (!isMember(team, memberOpenid)) throw new Error('该用户已不在团队中');
  const startDate = practiceSettings(team, now).effectivePracticeStartDate;
  const businessDate = practiceDate(now);
  const users = await db.collection('users').where({ _openid: memberOpenid })
    .field({ _id: true, nickName: true, avatarUrl: true }).orderBy('_id', 'asc').limit(1).get();
  const user = users.data[0] || {};
  const member = {
    openid: memberOpenid,
    nickname: user.nickName || (memberOpenid === team.creator ? team.creatorName : '') || '匿名用户',
    avatarUrl: user.avatarUrl || '/images/avatar.png', isCreator: memberOpenid === team.creator
  };
  const records = [];
  let cursor = null;
  for (;;) {
    const filter = { _openid: memberOpenid, ...(cursor === null ? {} : { _id: db.command.gt(cursor) }) };
    const result = await db.collection('meditation_records').where(filter)
      .field({ _id: true, date: true, timestamp: true, duration: true, source: true })
      .orderBy('_id', 'asc').limit(PAGE_SIZE).get();
    for (const record of result.data) {
      const session = practiceSession(record, startDate, businessDate, now);
      if (session) records.push({ _id: record._id, ...session,
        ...(typeof record.source === 'string' && record.source ? { source: record.source } : {}) });
    }
    if (result.data.length < PAGE_SIZE) break;
    cursor = result.data[result.data.length - 1]._id;
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || (b.timestamp || 0) - (a.timestamp || 0) || a._id.localeCompare(b._id));
  return { success: true, data: { member, startDate, businessDate, records } };
}

async function teamPracticeContext(teamId, openid, now) {
  const team = await activeTeam(db, teamId);
  if (!isMember(team, openid)) throw new Error('只有团队成员可以查看共修统计');
  const ids = memberIds(team);
  const settings = practiceSettings(team, now);
  const businessDate = practiceDate(now);
  const startDate = settings.effectivePracticeStartDate;
  const hasGoal = settings.dailyGoalMinutes !== null;
  const endDate = shiftDate(businessDate, -1);
  const totalDays = Math.max(0, Math.round((Date.parse(`${businessDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS));
  return { team, ids, settings, businessDate, startDate, hasGoal, endDate, totalDays, now };
}

function practiceHistoryWindow(context, requestedMonth) {
  const { startDate: practiceStartDate, businessDate } = context;
  if (requestedMonth === undefined) {
    return { startDate: practiceStartDate, endDate: context.endDate, totalDays: context.totalDays };
  }
  if (typeof requestedMonth !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(requestedMonth) ||
      !validDate(`${requestedMonth}-01`)) throw new Error('历史统计月份须为有效的YYYY-MM格式');
  const minMonth = practiceStartDate.slice(0, 7);
  const maxMonth = businessDate.slice(0, 7);
  // 规则修改或过期分享链接可使原月份超界，此时回到最近的有效月份。
  const month = requestedMonth < minMonth ? minMonth : requestedMonth > maxMonth ? maxMonth : requestedMonth;
  const monthStartDate = `${month}-01`;
  const monthEnd = new Date(Date.parse(`${monthStartDate}T00:00:00Z`));
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const monthEndDate = monthEnd.toISOString().slice(0, 10);
  const startDate = practiceStartDate > monthStartDate ? practiceStartDate : monthStartDate;
  const endDate = context.endDate < monthEndDate ? context.endDate : monthEndDate;
  const totalDays = Math.max(0, Math.round((Date.parse(`${endDate}T00:00:00Z`) -
    Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1);
  return { startDate, endDate, totalDays, month, minMonth, maxMonth };
}

// 汇总卡片与按日明细共用记录归属、时长累加及资料读取，避免统计口径漂移。
async function aggregateTeamPractice({ ids, startDate, businessDate, now }) {
  const totals = new Map(ids.map(id => [id, new Map()]));
  const activity = new Map(ids.map(id => [id, {
    totalPracticeCount: 0, todayPracticeCount: 0, minutes: { sum: 0, correction: 0 },
    lastPracticeAt: null, lastPracticeDate: null
  }]));
  const profiles = new Map();

  for (let offset = 0; offset < ids.length; offset += MEMBER_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MEMBER_BATCH_SIZE);
    const filter = { _openid: db.command.in(batch) };
    const users = await readAll(db.collection('users').where(filter)
      .field({ _id: true, _openid: true, nickName: true, avatarUrl: true }).orderBy('_id', 'asc'));
    users.forEach(user => { if (!profiles.has(user._openid)) profiles.set(user._openid, user); });

    // 旧记录的timestamp存在数字/ISO/数字字符串三种类型，date又是自然日。
    // 仅按date裁剪会漏掉次日凌晨或旧的错日数据，因此按当前成员分批扫描，
    // 只投影统计必需字段，逐页归属04:00业务日，不读取日记和感受内容。
    let cursor = null;
    for (;;) {
      // 读取期间新增/删除前面的记录会改变skip偏移；按最后一条_id继续，
      // 避免同一条打卡重复累计或漏掉后一页记录而误判是否达标。
      const pageFilter = cursor === null ? filter : { ...filter, _id: db.command.gt(cursor) };
      const result = await db.collection('meditation_records').where(pageFilter)
        .field({ _id: true, _openid: true, date: true, timestamp: true, duration: true })
        .orderBy('_id', 'asc').limit(PAGE_SIZE).get();
      for (const record of result.data) {
        const session = practiceSession(record, startDate, businessDate, now);
        if (!session) continue;
        const { date, timestamp, duration: minutes } = session;
        const hasTimestamp = timestamp !== null;
        const days = totals.get(record._openid);
        if (days) {
          if (!days.has(date)) days.set(date, { sum: 0, correction: 0 });
          addMinutes(days.get(date), minutes);
          const memberActivity = activity.get(record._openid);
          memberActivity.totalPracticeCount++;
          if (date === businessDate) memberActivity.todayPracticeCount++;
          addMinutes(memberActivity.minutes, minutes);
          if (!memberActivity.lastPracticeDate || date > memberActivity.lastPracticeDate) {
            memberActivity.lastPracticeDate = date;
            memberActivity.lastPracticeAt = hasTimestamp ? timestamp : null;
          } else if (date === memberActivity.lastPracticeDate && hasTimestamp &&
              (memberActivity.lastPracticeAt === null || timestamp > memberActivity.lastPracticeAt)) {
            memberActivity.lastPracticeAt = timestamp;
          }
        }
      }
      if (result.data.length < PAGE_SIZE) break;
      cursor = result.data[result.data.length - 1]._id;
    }
  }
  return { totals, activity, profiles };
}

function memberPracticeProfile(team, id, profiles) {
  const user = profiles.get(id) || {};
  return {
    openid: id, nickname: user.nickName || (id === team.creator ? team.creatorName : '') || '匿名用户',
    avatarUrl: user.avatarUrl || '/images/avatar.png', isCreator: id === team.creator
  };
}

function practiceStatus(minutes, goal) {
  return minutes <= 0 ? 'not_practiced' : goal === null ? 'practiced' :
    meetsGoal(minutes, goal) ? 'qualified' : 'below_goal';
}

async function getTeamPracticeReport(teamId, openid, month) {
  // 一次请求只读取一次当前时间，避免恰好跨04:00时今日与历史窗口不一致。
  const context = await teamPracticeContext(teamId, openid, Date.now());
  const { team, ids, settings, businessDate, hasGoal } = context;
  const history = practiceHistoryWindow(context, month);
  const { startDate, endDate, totalDays } = history;
  const { totals, activity, profiles } = await aggregateTeamPractice(context);

  const summary = { memberCount: ids.length, notPracticedCount: 0, practicedCount: 0, belowGoalCount: 0, qualifiedCount: 0 };
  const members = ids.map(id => {
    const days = totals.get(id);
    const todayMinutes = days.has(businessDate) ? days.get(businessDate).sum : 0;
    const todayStatus = practiceStatus(todayMinutes, settings.dailyGoalMinutes);
    if (todayMinutes > 0) summary.practicedCount++;
    if (todayStatus === 'not_practiced') summary.notPracticedCount++;
    else if (todayStatus === 'below_goal') summary.belowGoalCount++;
    else if (todayStatus === 'qualified') summary.qualifiedCount++;
    let practiceDays = 0;
    let qualifiedDays = 0;
    const historicalMinutes = { sum: 0, correction: 0 };
    for (const [date, total] of days) {
      if (date < startDate || date > endDate) continue;
      practiceDays++;
      if (hasGoal && meetsGoal(total.sum, settings.dailyGoalMinutes)) qualifiedDays++;
      addMinutes(historicalMinutes, total.sum);
    }
    const belowGoalDays = hasGoal ? practiceDays - qualifiedDays : 0;
    const missedDays = totalDays - practiceDays;
    const memberActivity = activity.get(id);
    return {
      ...memberPracticeProfile(team, id, profiles),
      todayMinutes, todayStatus, practiceDays, qualifiedDays, belowGoalDays, missedDays,
      unmetDays: hasGoal ? belowGoalDays + missedDays : 0, totalMinutes: historicalMinutes.sum,
      totalPracticeCount: memberActivity.totalPracticeCount, todayPracticeCount: memberActivity.todayPracticeCount,
      cumulativeMinutes: memberActivity.minutes.sum,
      lastPracticeAt: memberActivity.lastPracticeAt, lastPracticeDate: memberActivity.lastPracticeDate
    };
  });
  return { success: true, data: {
    teamId, businessDate,
    nextResetAt: Date.parse(`${businessDate}T04:00:00+08:00`) + DAY_MS,
    settings, history, summary, members,
    overview: {
      memberCount: ids.length,
      totalPracticeCount: members.reduce((count, member) => count + member.totalPracticeCount, 0),
      activeMemberCount: summary.practicedCount,
      activityRate: ids.length ? Math.round(summary.practicedCount / ids.length * 100) : 0
    }
  } };
}

async function getTeamHistoryDetails(data, openid) {
  const requestedFilter = data.filter === undefined ? 'unmet' : data.filter;
  if (!['unmet', 'not_practiced', 'below_goal', 'all'].includes(requestedFilter)) {
    throw new Error('历史统计筛选条件无效');
  }
  const limit = data.limit === undefined ? 50 : data.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每页条数须为1至100之间的整数');
  const context = await teamPracticeContext(data.teamId, openid, Date.now());
  const { team, settings, businessDate, hasGoal } = context;
  const history = practiceHistoryWindow(context, data.month);
  const { startDate, endDate, totalDays } = history;
  if (data.memberOpenid !== undefined) {
    requireId(data.memberOpenid, '成员');
    if (!isMember(team, data.memberOpenid)) throw new Error('该用户已不在团队中');
  }
  const ids = (data.memberOpenid === undefined ? context.ids : [data.memberOpenid]).slice().sort();
  const cursor = data.cursor == null ? null : data.cursor;
  if (cursor !== null && (typeof cursor !== 'object' || Array.isArray(cursor) ||
      !validDate(cursor.date) || cursor.date < startDate || cursor.date > endDate ||
      typeof cursor.memberOpenid !== 'string' || !ids.includes(cursor.memberOpenid))) {
    throw new Error('历史统计分页游标无效，请刷新后重试');
  }
  const filter = !hasGoal && ['unmet', 'below_goal'].includes(requestedFilter) ? 'not_practiced' : requestedFilter;
  const items = [];
  if (totalDays > 0) {
    const { totals, profiles } = await aggregateTeamPractice({ ...context, ids });
    // 时长不足只可能发生在已有练习的日期；稀疏日期集合避免多年空白记录的无效遍历。
    const practicedDates = filter === 'below_goal'
      ? [...new Set(ids.flatMap(id => [...totals.get(id).keys()]))]
        .filter(date => date >= startDate && date <= (cursor ? cursor.date : endDate)).sort().reverse()
      : null;
    let dateIndex = 0;
    let date = practicedDates ? practicedDates[0] : cursor ? cursor.date : endDate;
    // 逐日按成员稳定排序，仅构造本页加一条探测记录，不展开全部成员×历史天数。
    while (date && date >= startDate && items.length <= limit) {
      for (const id of ids) {
        if (cursor && date === cursor.date && id <= cursor.memberOpenid) continue;
        const total = totals.get(id).get(date);
        const minutes = total ? total.sum : 0;
        const status = practiceStatus(minutes, settings.dailyGoalMinutes);
        if (filter !== 'all' && (filter === 'unmet'
          ? status !== 'not_practiced' && status !== 'below_goal' : status !== filter)) continue;
        items.push({ date, ...memberPracticeProfile(team, id, profiles), minutes, status });
        if (items.length > limit) break;
      }
      if (items.length > limit || date === startDate) break;
      date = practicedDates ? practicedDates[++dateIndex] : shiftDate(date, -1);
    }
  }
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const lastItem = items[items.length - 1];
  return { success: true, data: {
    teamId: data.teamId, businessDate, settings, history, filter, items,
    nextCursor: hasMore ? { date: lastItem.date, memberOpenid: lastItem.openid } : null
  } };
}

async function generateInvite(data, openid) {
  const invitation = await db.runTransaction(async transaction => {
    const team = await activeTeam(transaction, data.teamId);
    if (team.creator !== openid) throw new Error('只有团长可以邀请新成员');
    // 确定 ID 的指针让并发请求产生文档冲突并重试，实际入群凭证仍使用随机 ID。
    const cacheId = `_invite_cache_${crypto.createHash('sha256').update(data.teamId).digest('hex')}`;
    const cache = await optionalDocument(transaction, 'invites', cacheId);
    const cachedInvite = cache && cache._type === 'team_invite_cache' && cache.teamId === data.teamId &&
      typeof cache.inviteId === 'string' && cache.inviteId.trim()
      ? await optionalDocument(transaction, 'invites', cache.inviteId) : null;
    const now = Date.now();
    const cachedExpiry = cachedInvite && timestampValue(cachedInvite.expireTime);
    const reusable = cachedInvite && cachedInvite.teamId === data.teamId && cachedInvite.inviterId === openid &&
      ['pending', 'accepted'].includes(cachedInvite.status) && Number.isFinite(cachedExpiry) && cachedExpiry > now;
    const inviteId = reusable ? cache.inviteId : 'invite_' + crypto.randomBytes(16).toString('hex');
    const expireTime = reusable ? cachedExpiry : now + 7 * DAY_MS;
    // 团队改名只更新本次分享信息，复用邀请时不续期，也不额外写数据库。
    const sharePath = '/subpackages/team/pages/joinTeam/joinTeam?' +
      `teamId=${encodeURIComponent(data.teamId)}&teamName=${encodeURIComponent(team.name)}` +
      `&inviterId=${encodeURIComponent(openid)}&inviteId=${encodeURIComponent(inviteId)}`;
    if (!reusable) {
      await transaction.collection('invites').doc(inviteId).set({ data: {
        teamId: data.teamId, teamName: team.name, inviterId: openid,
        inviterName: typeof data.inviterName === 'string' ? data.inviterName : '匿名用户',
        sharePath, status: 'pending', inviteTime: db.serverDate(),
        expireTime: new Date(expireTime),
        createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      // 指针不具备 status/expireTime，不能用可预测的缓存 ID 作为邀请入群。
      await transaction.collection('invites').doc(cacheId).set({ data: {
        _type: 'team_invite_cache', teamId: data.teamId, inviteId, updatedAt: db.serverDate()
      } });
    }
    return { inviteId, sharePath, expireTime, title: `邀请您加入${team.name}团队` };
  });
  return { success: true, data: invitation };
}

async function recordInviteAction(data, openid) {
  const team = await activeTeam(db, data.teamId);
  if (team.creator !== openid) throw new Error('只有团长可以记录邀请');
  requireId(data.inviteId, '邀请');
  const invite = (await db.collection('invites').doc(data.inviteId).get()).data;
  if (!invite || invite.teamId !== data.teamId || invite.inviterId !== openid) throw new Error('邀请信息无效');
  const result = await db.collection('invite_actions').add({ data: {
    teamId: data.teamId, inviterId: openid, inviteId: data.inviteId,
    actionType: 'generate', actionTime: db.serverDate(), createdAt: db.serverDate()
  } });
  return { success: true, data: { actionId: result._id } };
}

async function recordInviteRelation(data, openid) {
  const team = await activeTeam(db, data.teamId);
  if (!isMember(team, openid)) throw new Error('用户不是团队成员');
  const member = (await db.collection('team_members').doc(`${data.teamId}_${openid}`).get()).data;
  if (!member || !member.invitedBy) throw new Error('邀请关系不存在');
  const result = await db.collection('invite_actions').add({ data: {
    teamId: data.teamId, inviterId: member.invitedBy, inviteeId: openid,
    inviteId: member.inviteId, inviteTime: member.joinedAt,
    status: 'accepted', createdAt: db.serverDate()
  } });
  return { success: true, data: { relationId: result._id } };
}

function publicTeam(team) {
  return { _id: team._id, name: team.name, description: team.description || '',
    icon: team.icon || DEFAULT_ICON, memberCount: memberIds(team).length,
    isActive: true, createdAt: team.createdAt, creatorName: team.creatorName || '匿名创建者',
    ...practiceSettings(team) };
}

async function getAllTeams() {
  const rows = await readAll(db.collection('teams').where({ isActive: true })
    .orderBy('createdAt', 'desc').orderBy('_id', 'asc'));
  const teams = rows.map(publicTeam);
  return { success: true, data: { teams, count: teams.length } };
}
