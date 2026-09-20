/** 团队云端操作与按用户隔离的本地缓存。写操作以云端确认结果为准。 */
const currentUser = () => wx.getStorageSync('userOpenId') || '';
const storageKey = (prefix, openid = currentUser()) => `${prefix}_${openid || 'guest'}`;
const teamIdOf = team => team.cloudId || team._id;
const memberIdsOf = team => Array.isArray(team.members)
  ? [...new Set(team.members.map(member => typeof member === 'string' ? member : member && member.openid).filter(Boolean))]
  : [];
const isLocalIcon = icon => typeof icon === 'string' && /^(wxfile:\/\/|https?:\/\/tmp\/|\/tmp\/)/.test(icon);

class TeamManager {
  constructor() {
    this.openid = currentUser();
    this.teams = this.loadTeamsFromStorage();
    this.cacheRevision = 0;
    this.loadSequence = 0;
  }

  readTeams(prefix, openid = currentUser()) {
    try {
      const teams = wx.getStorageSync(storageKey(prefix, openid));
      return Array.isArray(teams) ? teams : [];
    } catch (error) {
      console.error('读取团队缓存失败:', error);
      return [];
    }
  }

  ensureCurrentUser() {
    const openid = currentUser();
    if (this.openid !== openid) {
      this.openid = openid;
      this.teams = this.loadTeamsFromStorage();
      this.cacheRevision++;
    }
    return openid;
  }

  loadTeamsFromStorage() {
    return this.readTeams('userTeams');
  }

  saveTeamsToStorage(openid = this.openid) {
    if (openid !== currentUser()) return;
    try {
      wx.setStorageSync(storageKey('userTeams', openid), this.teams);
    } catch (error) {
      console.error('保存团队缓存失败:', error);
    }
  }

  async callCloud(type, data, openid = currentUser()) {
    const response = await wx.cloud.callFunction({ name: 'teamManager', data: { type, data, openid } });
    const result = response && response.result;
    if (!result || !result.success) throw new Error((result && result.error) || '团队操作失败，请重试');
    return result.data;
  }

  createTeam(teamInfo) {
    // 只合并同一账号、同一份表单的重试，不能把另一团队的创建误报为成功。
    const creationKey = JSON.stringify([currentUser(), teamInfo && teamInfo.name,
      teamInfo && teamInfo.description, teamInfo && teamInfo.icon,
      teamInfo && teamInfo.practiceStartDate, teamInfo && teamInfo.dailyGoalMinutes]);
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
      const name = teamInfo && typeof teamInfo.name === 'string' ? teamInfo.name.trim() : '';
      if (!name) throw new Error('请输入团队名称');
      let icon = teamInfo.icon || '/images/icons/team.png';
      if (isLocalIcon(icon)) icon = await this.uploadTeamIconToCloud(icon);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重试');
      // 允许创建多个团队；名称唯一性由云端检查。
      const draft = {
        name, description: (teamInfo.description || '').trim(), icon,
        ...(teamInfo.practiceStartDate !== undefined ? { practiceStartDate: teamInfo.practiceStartDate } : {}),
        ...(teamInfo.dailyGoalMinutes !== undefined ? { dailyGoalMinutes: teamInfo.dailyGoalMinutes } : {}),
        creator: openid, creatorName: wx.getStorageSync('userNickname') || '匿名用户',
        members: [openid], memberCount: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isActive: true
      };
      const data = await this.syncTeamToCloud(draft);
      if (!data || !data.teamId) throw new Error('云端未返回团队ID，请刷新团队列表');
      const team = { ...draft, ...(data.team || {}), _id: data.teamId, cloudId: data.teamId };
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

  async syncTeamToCloud(team) {
    if (!currentUser()) throw new Error('用户未登录');
    return this.callCloud('createTeam', team);
  }

  async getTeamMemberPracticeRecords(teamId, memberOpenid) {
    try {
      const openid = this.ensureCurrentUser();
      if (!openid) throw new Error('请先登录后再查看成员记录');
      if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('团队ID无效');
      if (typeof memberOpenid !== 'string' || !memberOpenid.trim()) throw new Error('成员ID无效');
      const data = await this.callCloud('getTeamMemberPracticeRecords', { teamId, memberOpenid }, openid);
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
    try {
      const teams = await this.callCloud('getUserTeams', undefined, openid);
      if (!Array.isArray(teams)) throw new Error('云端团队数据格式异常');
      if (openid !== currentUser()) return { success: false, error: '登录状态已变更' };
      // 忽略晚于创建、删除或新刷新返回的旧快照。
      if (revision !== this.cacheRevision || sequence !== this.loadSequence) {
        return { success: true, data: this.teams };
      }
      this.teams = teams.filter(team => team && team._id && team.isActive !== false)
        .map(team => ({ ...team, members: memberIdsOf(team), cloudId: team._id, isActive: true }));
      this.saveTeamsToStorage(openid);
      // 空快照也必须清理缓存，包括旧版本遗留的无 cloudId 团队。
      this.cleanupJoinedTeamsFromCloud(this.teams);
      return { success: true, data: this.teams };
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
      if (!openid) throw new Error('用户未登录');
      const team = this.teams.find(item => item._id === teamId || teamIdOf(item) === teamId);
      if (!team) throw new Error('团队不存在，请刷新后重试');
      if (team.creator !== openid) throw new Error('只有创建者可以解散团队');
      await this.syncDeleteTeamToCloud(teamId);
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

  async removeTeamMember(teamId, memberOpenid) {
    try {
      const openid = this.ensureCurrentUser();
      if (!openid) throw new Error('用户未登录');
      const team = this.teams.find(item => teamIdOf(item) === teamId);
      if (!team || team.isActive === false) throw new Error('团队不存在，请刷新后重试');
      if (team.creator !== openid) throw new Error('只有团长可以移除成员');
      if (memberOpenid === openid) throw new Error('不能移除团长本人');
      if (!memberIdsOf(team).includes(memberOpenid)) throw new Error('该成员已不在团队中');
      const data = await this.callCloud('removeTeamMember', { teamId, memberOpenid }, openid);
      if (openid !== currentUser()) throw new Error('登录状态已变更，请重新进入团队');
      if (!data || data.teamId !== teamId || !Array.isArray(data.members) || data.members.includes(memberOpenid)) {
        throw new Error('成员变更结果异常，请刷新团队');
      }
      this.teams = this.loadTeamsFromStorage().map(item => teamIdOf(item) === teamId
        ? { ...item, members: [...new Set(data.members)], memberCount: new Set(data.members).size } : item);
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
      wx.setStorageSync(storageKey('joinedTeams'), teams);
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

  async uploadTeamIconToCloud(tempFilePath) {
    if (!isLocalIcon(tempFilePath)) return tempFilePath;
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: `team-icons/${Date.now()}_${Math.random().toString(36).slice(2, 11)}.png`,
        filePath: tempFilePath,
        success: result => result.fileID ? resolve(result.fileID) : reject(new Error('头像上传失败，请重试')),
        fail: () => reject(new Error('头像上传失败，请重试'))
      });
    });
  }
}

module.exports = new TeamManager();
