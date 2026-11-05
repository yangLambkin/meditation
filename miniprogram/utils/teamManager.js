/** 团队云端操作与按用户隔离的本地缓存。写操作以云端确认结果为准。 */
const gateway = require('./teamGateway.js');
const currentUser = () => wx.getStorageSync('userOpenId') || '';
const storageKey = (prefix, openid = currentUser()) => `${prefix}_${openid || 'guest'}`;
const teamIdOf = team => team.cloudId || team._id;
const memberIdsOf = team => Array.isArray(team.members)
  ? [...new Set(team.members.map(member => typeof member === 'string' ? member : member && member.openid).filter(Boolean))]
  : [];
const deputyIdsOf = team => [...new Set((Array.isArray(team.deputyLeaders) ? team.deputyLeaders : [])
  .filter(id => typeof id === 'string' && id !== team.creator && memberIdsOf(team).includes(id)))];
const isLocalIcon = icon => typeof icon === 'string' && /^(wxfile:\/\/|https?:\/\/tmp\/|\/tmp\/)/.test(icon);
const PRACTICE_TYPES = ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'];
const creationFingerprint = teamInfo => JSON.stringify([
  teamInfo && typeof teamInfo.name === 'string' ? teamInfo.name.trim() : '',
  teamInfo && typeof teamInfo.description === 'string' ? teamInfo.description.trim() : '',
  teamInfo && teamInfo.icon || '/images/icons/team.png', teamInfo && teamInfo.practiceType || 'sitting',
  teamInfo && teamInfo.practiceStartDate || null, teamInfo && teamInfo.dailyGoalMinutes != null ? teamInfo.dailyGoalMinutes : null,
  ...(teamInfo && Array.isArray(teamInfo.practices) ? [teamInfo.practices] : [])
]);

class TeamManager {
  constructor() {
    this.openid = currentUser();
    this.dataOwnerKey = this.dataOwnerFingerprint(this.openid);
    this.teams = this.loadTeamsFromStorage();
    this.cacheRevision = 0;
    this.loadSequence = 0;
  }

  readTeams(prefix, openid = currentUser()) {
    try {
      const teams = wx.getStorageSync(storageKey(prefix, openid));
      const fingerprint = this.dataOwnerFingerprint(openid);
      return Array.isArray(teams) ? teams.filter(team => team && (!gateway.isDataTeam(teamIdOf(team)) ||
        !!fingerprint && team._dataOwner === fingerprint)).map(({ _dataOwner, ...team }) => team) : [];
    } catch (error) {
      console.error('读取团队缓存失败:', error);
      return [];
    }
  }

  ensureCurrentUser() {
    const openid = currentUser();
    const fingerprint = this.dataOwnerFingerprint(openid);
    if (this.openid !== openid || this.dataOwnerKey !== fingerprint) {
      this.openid = openid;
      this.dataOwnerKey = fingerprint;
      this.teams = this.loadTeamsFromStorage();
      this.cacheRevision++;
      this.saveJoinedTeamsToStorage(this.teams.filter(team => team.isActive !== false &&
        (team.creator === openid || memberIdsOf(team).includes(openid))));
    }
    return openid;
  }

  loadTeamsFromStorage() {
    return this.readTeams('userTeams');
  }

  dataOwnerFingerprint(openid = currentUser()) {
    const owner = gateway.getDataOwner();
    return owner && owner.openid === openid
      ? JSON.stringify([openid, owner.studentNumber, String(owner.bindingVersion || '')]) : '';
  }

  assertDataOwner(fingerprint, openid = currentUser()) {
    if (fingerprint !== this.dataOwnerFingerprint(openid)) throw new Error('账号或绑定已变化，请重新进入团队');
  }

  ownedCache(teams, openid = currentUser()) {
    const fingerprint = this.dataOwnerFingerprint(openid);
    return teams.filter(team => !gateway.isDataTeam(teamIdOf(team)) || !!fingerprint)
      .map(team => gateway.isDataTeam(teamIdOf(team)) ? { ...team, _dataOwner: fingerprint } : team);
  }

  saveTeamsToStorage(openid = this.openid) {
    if (openid !== currentUser()) return;
    try {
      wx.setStorageSync(storageKey('userTeams', openid), this.ownedCache(this.teams, openid));
    } catch (error) {
      console.error('保存团队缓存失败:', error);
    }
  }

  async callCloud(type, data, openid = currentUser()) {
    const response = await gateway.callTeam(type, data, openid);
    const result = response && response.result;
    if (!result || !result.success) throw new Error((result && result.error) || '团队操作失败，请重试');
    return result.data;
  }

  createTeam(teamInfo) {
    // 只合并同一账号、同一份表单的重试，不能把另一团队的创建误报为成功。
    const creationKey = JSON.stringify([currentUser(), creationFingerprint(teamInfo)]);
    if (this.creationPromise) {
      return creationKey === this.creationKey ? this.creationPromise
        : Promise.resolve({ success: false, error: '另一个团队正在创建，请稍后重试' });
    }
    this.creationKey = creationKey;
    this.creationPromise = this.performCreateTeam(teamInfo).finally(() => {
      this.creationPromise = null;
      this.creationKey = null;
    });
    return this.creationPromise;
  }

  async performCreateTeam(teamInfo) {
    try {
      const openid = this.ensureCurrentUser();
      if (!openid) throw new Error('请先登录后再创建团队');
      const dataOwner = this.dataOwnerFingerprint(openid);
      const name = teamInfo && typeof teamInfo.name === 'string' ? teamInfo.name.trim() : '';
      if (!name) throw new Error('请输入团队名称');
      const practiceType = teamInfo.practiceType || 'sitting';
      if (!PRACTICE_TYPES.includes(practiceType)) throw new Error('请选择有效的功课类型');
      const fingerprint = creationFingerprint(teamInfo);
      const operation = this.getCreationOperation(openid, fingerprint);
      let icon = teamInfo.icon || '/images/icons/team.png';
      if (isLocalIcon(icon) || icon.startsWith('cloud://')) {
        icon = operation.uploadedIcon || await gateway.uploadTeamIcon(icon);
        operation.uploadedIcon = icon;
        this.saveCreationOperation(openid, operation);
      }
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重试');
      this.assertDataOwner(dataOwner, openid);
      // 允许创建多个团队；名称唯一性由云端检查。
      const draft = {
        name, description: (teamInfo.description || '').trim(), icon, practiceType,
        ...(teamInfo.practiceStartDate !== undefined ? { practiceStartDate: teamInfo.practiceStartDate } : {}),
        ...(teamInfo.dailyGoalMinutes !== undefined ? { dailyGoalMinutes: teamInfo.dailyGoalMinutes } : {}),
        ...(Array.isArray(teamInfo.practices) ? { practices: teamInfo.practices.map(item => ({ ...item })) } : {}),
        creator: openid, creatorName: wx.getStorageSync('userNickname') || '匿名用户',
        members: [openid], memberCount: 1, deputyLeaders: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isActive: true
      };
      const data = await this.syncTeamToCloud(draft, operation.operationKey);
      this.assertDataOwner(dataOwner, openid);
      if (!data || !/^bijing_[1-9]\d*$/.test(data.teamId || '') || !data.team ||
          data.team.source !== 'bijing' || data.team.practiceType !== practiceType) {
        throw new Error('团队服务未确认所选功课类型，请刷新后重试');
      }
      const team = { ...data.team, _id: data.teamId, cloudId: data.teamId };
      this.clearCreationOperation(openid, operation.operationKey);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重新进入团队列表');
      this.teams = this.loadTeamsFromStorage().filter(item => teamIdOf(item) !== team._id);
      this.teams.push(team);
      this.cacheRevision++;
      this.saveTeamsToStorage(openid);
      this.cleanupJoinedTeamsFromCloud(this.teams);
      return { success: true, team };
    } catch (error) {
      console.error('创建团队失败:', error);
      return { success: false, error: error.message };
    }
  }

  getCreationOperation(openid, fingerprint) {
    const operations = this.readCreationOperations(openid);
    const existing = operations.find(item => item.fingerprint === fingerprint);
    if (existing) return existing;
    const operation = { fingerprint, operationKey: `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` };
    this.saveCreationOperation(openid, operation);
    return operation;
  }

  readCreationOperations(openid) {
    const operations = wx.getStorageSync(storageKey('teamCreateOperations_v1', openid));
    return Array.isArray(operations) ? operations.filter(item => item && typeof item.fingerprint === 'string' &&
      typeof item.operationKey === 'string' && /^[\x21-\x7e]{8,128}$/.test(item.operationKey)) : [];
  }

  saveCreationOperation(openid, operation) {
    const operations = this.readCreationOperations(openid).filter(item => item.fingerprint !== operation.fingerprint);
    wx.setStorageSync(storageKey('teamCreateOperations_v1', openid), [...operations, operation]);
  }

  clearCreationOperation(openid, operationKey) {
    // 创建已确认成功；清理失败不能把成功误报为失败，重试仍由服务端幂等键兜底。
    try {
      const operations = this.readCreationOperations(openid).filter(item => item.operationKey !== operationKey);
      wx.setStorageSync(storageKey('teamCreateOperations_v1', openid), operations);
    } catch (error) { console.warn('清理团队创建请求缓存失败:', error); }
  }

  async syncTeamToCloud(team, operationKey) {
    if (!currentUser()) throw new Error('用户未登录');
    return this.callCloud('createTeam', { ...team, operationKey });
  }

  async getTeamMemberPracticeRecords(teamId, memberOpenid) {
    try {
      const openid = this.ensureCurrentUser();
      const dataOwner = this.dataOwnerFingerprint(openid);
      if (!openid) throw new Error('请先登录后再查看成员记录');
      if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('团队ID无效');
      if (typeof memberOpenid !== 'string' || !memberOpenid.trim()) throw new Error('成员ID无效');
      const data = await this.callCloud('getTeamMemberPracticeRecords', { teamId, memberOpenid }, openid);
      if (gateway.isDataTeam(teamId)) this.assertDataOwner(dataOwner, openid);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重试');
      if (!data || !data.member || data.member.openid !== memberOpenid || !Array.isArray(data.records)) {
        throw new Error('云端成员记录格式异常');
      }
      return { success: true, data };
    } catch (error) {
      console.error('加载成员练习记录失败:', error);
      return { success: false, error: error.message };
    }
  }

  getMyTeams() {
    const openid = this.ensureCurrentUser();
    return openid ? this.teams.filter(team => team.creator === openid && team.isActive) : [];
  }

  getJoinedTeams() {
    const openid = this.ensureCurrentUser();
    return openid ? this.teams.filter(team => team.isActive &&
      (team.creator === openid || memberIdsOf(team).includes(openid))) : [];
  }

  getTeamCount() {
    return this.getJoinedTeams().length;
  }

  async loadTeamsFromCloud() {
    const openid = this.ensureCurrentUser();
    if (!openid) return { success: true, data: [] };
    const revision = this.cacheRevision;
    const sequence = ++this.loadSequence;
    const dataOwner = this.dataOwnerFingerprint(openid);
    try {
      const response = await gateway.callTeam('getUserTeams', undefined, openid);
      const result = response && response.result;
      if (!result || !result.success) throw new Error(result && result.error || '团队暂时无法加载');
      const teams = result.data;
      if (!Array.isArray(teams)) throw new Error('云端团队数据格式异常');
      if (openid !== currentUser()) return { success: false, error: '登录状态已变更' };
      if (dataOwner !== this.dataOwnerFingerprint(openid)) return { success: false, error: '账号或绑定已变化，请重新加载团队' };
      // 忽略晚于创建、删除或新刷新返回的旧快照。
      if (revision !== this.cacheRevision || sequence !== this.loadSequence) {
        return { success: true, data: this.teams };
      }
      const failedSources = Array.isArray(result.failedSources) ? result.failedSources : [];
      const retained = this.loadTeamsFromStorage().filter(team => failedSources.includes(gateway.isDataTeam(teamIdOf(team)) ? 'bijing' : 'wechat'));
      const combined = [...retained, ...teams];
      this.teams = combined.filter((team, index) => team && team._id && team.isActive !== false &&
        combined.findIndex(item => item && teamIdOf(item) === teamIdOf(team)) === index)
        .map(team => ({ ...team, members: memberIdsOf(team), cloudId: team._id, isActive: true }));
      this.saveTeamsToStorage(openid);
      // 空快照也必须清理缓存，包括旧版本遗留的无 cloudId 团队。
      this.cleanupJoinedTeamsFromCloud(this.teams);
      return { success: true, data: this.teams, warning: result.warning || '', failedSources };
    } catch (error) {
      console.error('加载云端团队失败:', error);
      return { success: false, error: error.message };
    }
  }

  cleanupJoinedTeamsFromCloud(teams) {
    const openid = this.ensureCurrentUser();
    const joined = teams.filter(team => team.isActive !== false &&
      (team.creator === openid || memberIdsOf(team).includes(openid)));
    this.saveJoinedTeamsToStorage(joined);
  }

  async deleteTeam(teamId) {
    try {
      const openid = this.ensureCurrentUser();
      const dataOwner = this.dataOwnerFingerprint(openid);
      if (!openid) throw new Error('用户未登录');
      const team = this.teams.find(item => item._id === teamId || teamIdOf(item) === teamId);
      if (!team) throw new Error('团队不存在，请刷新后重试');
      if (team.creator !== openid) throw new Error('只有团长可以解散团队');
      await this.syncDeleteTeamToCloud(teamId);
      if (gateway.isDataTeam(teamIdOf(team))) this.assertDataOwner(dataOwner, openid);
      if (openid === currentUser()) this.removeJoinedTeam(teamIdOf(team));
      return { success: true };
    } catch (error) {
      console.error('删除团队失败:', error);
      return { success: false, error: error.message };
    }
  }

  async syncDeleteTeamToCloud(teamId) {
    const openid = this.ensureCurrentUser();
    if (!openid) throw new Error('用户未登录');
    const team = this.teams.find(item => item._id === teamId || teamIdOf(item) === teamId);
    return this.callCloud('deleteTeam', { teamId: team ? teamIdOf(team) : teamId }, openid);
  }

  setTeamDeputy(teamId, memberOpenid, isDeputy) {
    return this.changeTeamRole('setTeamDeputy', teamId, memberOpenid, isDeputy);
  }

  transferTeamLeader(teamId, newLeaderOpenid) {
    return this.changeTeamRole('transferTeamLeader', teamId, newLeaderOpenid);
  }

  async changeTeamRole(type, teamId, memberOpenid, isDeputy) {
    try {
      const openid = this.ensureCurrentUser();
      const dataOwner = this.dataOwnerFingerprint(openid);
      if (!openid) throw new Error('用户未登录');
      if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('团队ID无效');
      if (typeof memberOpenid !== 'string' || !memberOpenid.trim()) throw new Error('成员ID无效');
      const team = this.teams.find(item => teamIdOf(item) === teamId);
      if (!team || team.isActive === false) throw new Error('团队不存在，请刷新后重试');
      if (team.creator !== openid) throw new Error('只有团长可以调整成员身份');
      if (memberOpenid === openid) throw new Error('不能对团长本人执行此操作');
      if (!memberIdsOf(team).includes(memberOpenid)) throw new Error('该成员已不在团队中');
      const isTransfer = type === 'transferTeamLeader';
      if (!isTransfer) {
        if (type !== 'setTeamDeputy' || typeof isDeputy !== 'boolean') throw new Error('成员身份设置无效');
        const deputies = deputyIdsOf(team);
        if (isDeputy && !deputies.includes(memberOpenid) && deputies.length >= 7) {
          throw new Error('副团长最多可设置7位');
        }
      }
      const request = isTransfer ? { teamId, newLeaderOpenid: memberOpenid, expectedLeaderOpenid: openid }
        : { teamId, memberOpenid, isDeputy };
      const data = await this.callCloud(type, request, openid);
      if (gateway.isDataTeam(teamId)) this.assertDataOwner(dataOwner, openid);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重新进入团队');
      if (!data || data.teamId !== teamId || data.creator !== (isTransfer ? memberOpenid : openid) ||
          typeof data.creatorName !== 'string' || !Array.isArray(data.members) ||
          data.members.some(id => typeof id !== 'string' || !id) ||
          !data.members.includes(openid) || !data.members.includes(memberOpenid) ||
          new Set(data.members).size !== data.members.length || data.memberCount !== data.members.length ||
          !Array.isArray(data.deputyLeaders) || data.deputyLeaders.length > 7 ||
          deputyIdsOf(data).length !== data.deputyLeaders.length ||
          (!isTransfer && data.deputyLeaders.includes(memberOpenid) !== isDeputy)) {
        throw new Error('成员身份变更结果异常，请刷新团队');
      }
      const update = { creator: data.creator, creatorName: data.creatorName, members: data.members,
        memberCount: data.memberCount, deputyLeaders: data.deputyLeaders };
      this.teams = this.loadTeamsFromStorage().map(item => teamIdOf(item) === teamId ? { ...item, ...update } : item);
      this.cacheRevision++;
      this.saveTeamsToStorage(openid);
      this.cleanupJoinedTeamsFromCloud(this.teams);
      try { wx.removeStorageSync('allTeams_cache'); } catch (_) {}
      return { success: true, data };
    } catch (error) {
      console.error('调整团队成员身份失败:', error);
      return { success: false, error: error.message };
    }
  }

  async removeTeamMember(teamId, memberOpenid) {
    try {
      const openid = this.ensureCurrentUser();
      const dataOwner = this.dataOwnerFingerprint(openid);
      if (!openid) throw new Error('用户未登录');
      const team = this.teams.find(item => teamIdOf(item) === teamId);
      if (!team || team.isActive === false) throw new Error('团队不存在，请刷新后重试');
      if (team.creator !== openid) throw new Error('只有团长可以移除成员');
      if (memberOpenid === openid) throw new Error('不能移除团长本人');
      if (!memberIdsOf(team).includes(memberOpenid)) throw new Error('该成员已不在团队中');
      const data = await this.callCloud('removeTeamMember', { teamId, memberOpenid }, openid);
      if (gateway.isDataTeam(teamId)) this.assertDataOwner(dataOwner, openid);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重新进入团队');
      if (!data || data.teamId !== teamId || !Array.isArray(data.members) || data.members.includes(memberOpenid)) {
        throw new Error('成员变更结果异常，请刷新团队');
      }
      this.teams = this.loadTeamsFromStorage().map(item => teamIdOf(item) === teamId
        ? { ...item, members: [...new Set(data.members)], memberCount: new Set(data.members).size,
          deputyLeaders: deputyIdsOf({ ...item, members: data.members,
            deputyLeaders: data.deputyLeaders || item.deputyLeaders }) } : item);
      this.cacheRevision++;
      this.saveTeamsToStorage(openid);
      this.cleanupJoinedTeamsFromCloud(this.teams);
      try { wx.removeStorageSync('allTeams_cache'); } catch (_) {}
      return { success: true, data };
    } catch (error) {
      console.error('移除团队成员失败:', error);
      return { success: false, error: error.message };
    }
  }

  loadJoinedTeamsFromStorage() {
    return this.readTeams('joinedTeams');
  }

  saveJoinedTeamsToStorage(teams) {
    try {
      wx.setStorageSync(storageKey('joinedTeams'), this.ownedCache(teams));
    } catch (error) {
      console.error('保存已加入团队缓存失败:', error);
    }
  }

  addJoinedTeam(teamInfo) {
    const openid = this.ensureCurrentUser();
    if (!openid || !teamInfo || !teamIdOf(teamInfo)) return;
    const id = teamIdOf(teamInfo);
    const members = memberIdsOf(teamInfo);
    if (!members.includes(openid)) members.push(openid);
    const team = { ...teamInfo, _id: id, cloudId: id, members, isActive: true,
      memberCount: members.length, joinedAt: teamInfo.joinedAt || new Date().toISOString() };
    this.teams = this.loadTeamsFromStorage().filter(item => teamIdOf(item) !== id);
    this.teams.push(team);
    this.cacheRevision++;
    this.saveTeamsToStorage(openid);
    this.cleanupJoinedTeamsFromCloud(this.teams);
  }

  checkIsMember(teamId) {
    return this.getJoinedTeams().some(team => team._id === teamId || teamIdOf(team) === teamId);
  }

  getUserJoinedTeams() {
    return this.loadJoinedTeamsFromStorage();
  }

  removeJoinedTeam(teamId) {
    this.ensureCurrentUser();
    const matches = team => team._id === teamId || teamIdOf(team) === teamId;
    const joined = this.loadJoinedTeamsFromStorage();
    const teams = this.loadTeamsFromStorage();
    const removed = joined.some(matches) || teams.some(matches);
    this.teams = teams.filter(team => !matches(team));
    this.cacheRevision++;
    this.saveTeamsToStorage();
    this.saveJoinedTeamsToStorage(joined.filter(team => !matches(team)));
    // 删除/退队后，旧的公共列表快照不再可靠。
    try { wx.removeStorageSync('allTeams_cache'); } catch (error) { console.warn(error); }
    return removed;
  }

  clearLocalTeamCache() {
    this.ensureCurrentUser();
    this.teams = [];
    this.cacheRevision++;
    this.saveTeamsToStorage();
    this.saveJoinedTeamsToStorage([]);
    return true;
  }

}

module.exports = new TeamManager();
