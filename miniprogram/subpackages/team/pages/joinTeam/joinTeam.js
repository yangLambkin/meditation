const { callTeam, getViewerKey, getDataOwner, isDataTeam } = require('../../../../utils/teamGateway.js');
const teamManager = require('../../../../utils/teamManager.js');
const { PRACTICES } = require('../../../../utils/practicePreferences.js');
const { getPendingInvitation, savePendingInvitation, clearPendingInvitation, restoreDataBinding } = require('../../../../utils/teamInvitation.js');

function getPracticeLabels(team) {
  const types = Array.isArray(team.practices) && team.practices.length
    ? team.practices.map(practice => practice && practice.practiceType) : [team.practiceType];
  const labels = [...new Set(types)].map(type => PRACTICES.find(practice => practice.type === type))
    .filter(Boolean).map(practice => practice.name);
  return labels.length ? labels : [PRACTICES[0].name];
}

function decodeParameter(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch (error) { return value; }
}

Page({
  data: {
    teamId: '', teamInfo: null, members: [], inviterId: '', inviteId: '',
    isLoading: false, isJoining: false, isCheckingBinding: false, isMember: false, loadError: '',
    teamTotalCheckins: 0, teamActivityRate: 0, statsAvailable: false, practiceLabels: []
  },

  async onLoad(options = {}) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    this._isVisible = true;
    this._firstShow = true;
    const teamId = options.teamId || options.team_id || '';
    const inviteId = options.inviteId || options.invite_id || '';
    const pending = getPendingInvitation();
    const resume = pending && pending.teamId === teamId && pending.inviteId && pending.expiresAt > Date.now() &&
      (!inviteId || inviteId === pending.inviteId);
    this._resumeJoin = !!resume;
    this.setData({
      teamId,
      teamName: decodeParameter(options.teamName || options.team_name),
      inviterId: options.inviterId || options.inviter_id || (resume && pending.inviterId) || '',
      inviteId: inviteId || (resume && pending.inviteId) || ''
    });
    if (!teamId) {
      this.setData({ loadError: '邀请链接错误' });
      wx.showToast({ title: '邀请链接错误', icon: 'none' });
      return;
    }
    return this.refreshTeam();
  },

  onShow() {
    this._isVisible = true;
    if (this._firstShow) {
      this._firstShow = false;
      if (this._viewerKey === getViewerKey(this.data.teamId)) return;
    }
    if (this.data.teamId) return this.refreshTeam();
  },

  onUnload() {
    this._unloaded = true;
    this._isVisible = false;
  },

  onHide() {
    this._isVisible = false;
  },

  async refreshTeam() {
    const viewerKey = getViewerKey(this.data.teamId);
    const loaded = await this.loadTeamInfo();
    if (this._unloaded || !this._isVisible || viewerKey !== getViewerKey(this.data.teamId)) return;
    if (loaded && this._resumeJoin && this.hasUserInfo()) {
      this._resumeJoin = false;
      if (!this.data.isMember) return this.joinTeam();
      clearPendingInvitation(this.data);
    }
  },

  async callTeam(type, data) {
    const response = await callTeam(type, data);
    if (!response.result || !response.result.success) {
      throw new Error(response.result && response.result.error || '请求失败，请重试');
    }
    return response.result.data;
  },

  async loadTeamInfo() {
    if (!this.data.teamId) return false;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    if (this._viewerKey !== viewerKey) {
      this.setData({ teamInfo: null, members: [], isMember: false, statsAvailable: false, isJoining: false });
    }
    if (this.data.isJoining) return false;
    if (this.data.isLoading && this._loadingOpenid === openid && this._loadingViewerKey === viewerKey) return false;
    const version = this._loadVersion = (this._loadVersion || 0) + 1;
    this._loadingOpenid = openid;
    this._loadingViewerKey = viewerKey;
    if (this._viewerOpenid !== openid) {
      this.setData({ teamInfo: null, members: [], isMember: false, statsAvailable: false });
    }
    this._viewerOpenid = openid;
    this._viewerKey = viewerKey;
    const isCurrent = () => !this._unloaded && version === this._loadVersion && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    this.setData({ isLoading: true, loadError: '' });
    try {
      // 每次进入都验证团队及成员资格，旧缓存不能代表邀请仍有效。
      const teamInfo = await this.callTeam('getTeamInfo', { teamId: this.data.teamId, ...(this.data.inviteId ? { inviteId: this.data.inviteId } : {}) });
      if (!isCurrent()) return false;
      const isMember = typeof teamInfo.isMember === 'boolean' ? teamInfo.isMember : !!openid && (
        teamInfo.creator === openid || (teamInfo.members || []).some(member =>
          (typeof member === 'string' ? member : member.openid) === openid));
      const members = (teamInfo.members || []).map((entry, index) => {
        const member = typeof entry === 'string' ? { openid: entry } : entry;
        const isCreator = member.isCreator || member.openid && member.openid === teamInfo.creator;
        const isDeputy = member.isDeputy || member.openid && Array.isArray(teamInfo.deputyLeaders) && teamInfo.deputyLeaders.includes(member.openid);
        return {
          id: member.openid || `member_${index}`,
          openid: member.openid,
          name: member.nickname || '成员',
          role: isCreator ? '团长' : isDeputy ? '副团长' : '成员',
          avatar: member.avatarUrl || '/images/avatar.png',
          checkInCount: 0,
          monthlyCount: 0
        };
      });
      let statsAvailable = false;
      if (isMember && members.length && !/^bijing_/.test(teamInfo._id)) {
        try {
          const counts = await this.callTeam('getTeamMembersCheckinData', {
            teamId: teamInfo._id, memberOpenids: members.map(member => member.openid)
          });
          members.forEach(member => {
            const count = counts[member.openid] || {};
            member.checkInCount = Number(count.totalCount) || 0;
            member.monthlyCount = Number(count.monthlyCount) || 0;
          });
          statsAvailable = true;
        } catch (error) {
          console.warn('加载团队打卡统计失败:', error);
        }
      }
      if (!isCurrent()) return false;
      wx.setNavigationBarTitle({ title: `加入${teamInfo.name}` });
      const practiceLabels = getPracticeLabels(teamInfo);
      this.setData({
        teamInfo, members, isMember, statsAvailable,
        practiceLabels, practiceTypeName: practiceLabels.join(' · '),
        teamTotalCheckins: members.reduce((sum, member) => sum + member.checkInCount, 0),
        teamActivityRate: members.length ? Math.round(members.filter(member => member.monthlyCount > 0).length / members.length * 100) : 0
      });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      this.setData({ teamInfo: null, members: [], isMember: false, statsAvailable: false, loadError: error.message || '加载失败，请重试' });
      return false;
    } finally {
      if (!this._unloaded && version === this._loadVersion) this.setData({ isLoading: false });
    }
  },

  hasUserInfo() {
    const openid = wx.getStorageSync('userOpenId');
    return typeof openid === 'string' && !!openid && !/^(local_|guest)/.test(openid);
  },

  rememberInvitation() {
    const pending = getPendingInvitation();
    const sameInvite = pending && pending.teamId === this.data.teamId && pending.inviteId === this.data.inviteId;
    const invitation = { teamId: this.data.teamId, inviterId: this.data.inviterId, inviteId: this.data.inviteId,
      expiresAt: sameInvite ? pending.expiresAt : Date.now() + 30 * 60 * 1000,
      account: this.hasUserInfo() ? wx.getStorageSync('userOpenId') : '' };
    savePendingInvitation(invitation);
    return invitation;
  },

  async prepareDataJoin() {
    const openid = wx.getStorageSync('userOpenId');
    const teamId = this.data.teamId, inviteId = this.data.inviteId;
    const isCurrent = () => !this._unloaded && this._isVisible && this.data.teamId === teamId &&
      this.data.inviteId === inviteId && wx.getStorageSync('userOpenId') === openid;
    this.setData({ isCheckingBinding: true });
    try {
      const owner = await restoreDataBinding(openid, isCurrent);
      if (!isCurrent()) return false;
      if (!owner) {
        wx.showModal({ title: '尚未绑定学号', content: '你还没有绑定学号，请先在「我」中绑定本人学号，再接受邀请加入团队。', showCancel: false });
        return false;
      }
      const viewerKey = getViewerKey(teamId);
      // The recovered binding changes the viewer. Validate this invitation again
      // as that student before allowing the join request.
      const loaded = await this.loadTeamInfo();
      return !!loaded && isCurrent() && getViewerKey(teamId) === viewerKey;
    } catch (error) {
      if (isCurrent()) wx.showModal({ title: '暂时无法加入', content: error.message || '学号绑定状态加载失败，请重试', showCancel: false });
      return false;
    } finally {
      if (!this._unloaded) this.setData({ isCheckingBinding: false });
    }
  },

  async joinTeam() {
    if (this._unloaded || !this._isVisible) return;
    if (this._viewerKey !== getViewerKey(this.data.teamId)) return this.refreshTeam();
    if (this.data.isLoading || this.data.isJoining || this.data.isCheckingBinding || this._loginPending) return;
    if (!this.data.teamInfo) {
      wx.showToast({ title: '请先加载团队信息', icon: 'none' });
      return;
    }
    if (this.data.isMember) return this.enterTeamDetails();
    if (!this.data.inviteId) {
      wx.showToast({ title: '请联系团长或副团长获取邀请', icon: 'none' });
      return;
    }
    if (!this.hasUserInfo()) {
      const invitation = this.rememberInvitation();
      // profile 的旧版回跳仅携带 teamId；保存本次用户已确认的邀请，以便登录后继续。
      this._resumeJoin = true;
      this._loginPending = true;
      const params = {
        ...invitation,
        teamName: this.data.teamInfo.name || '',
        teamIcon: this.data.teamInfo.icon || '',
        inviterName: this.data.teamInfo.creatorName || '',
        type: 'new',
        fromPage: '/subpackages/team/pages/joinTeam/joinTeam',
        fromParams: JSON.stringify({ ...invitation, fromLogin: 'true' })
      };
      wx.navigateTo({
        url: '/pages/profile/profile?' + Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&'),
        fail: () => wx.showToast({ title: '登录跳转失败，请重试', icon: 'none' }),
        complete: () => { this._loginPending = false; }
      });
      return;
    }
    this.rememberInvitation();
    const openid = wx.getStorageSync('userOpenId');
    const teamId = this.data.teamId, inviteId = this.data.inviteId;
    if (isDataTeam(this.data.teamId) && !getDataOwner()) {
      if (!await this.prepareDataJoin()) return;
      if (this._unloaded || !this._isVisible || wx.getStorageSync('userOpenId') !== openid ||
          this.data.teamId !== teamId || this.data.inviteId !== inviteId || this._viewerKey !== getViewerKey(teamId)) return;
      if (this.data.isMember) {
        clearPendingInvitation(this.data);
        return this.enterTeamDetails();
      }
    }
    const viewerKey = getViewerKey(this.data.teamId);
    this.setData({ isJoining: true });
    wx.showLoading({ title: '加入中...', mask: true });
    try {
      await this.callTeam('joinTeam', {
        teamId: this.data.teamId, inviterId: this.data.inviterId, inviteId: this.data.inviteId
      });
      if (this._unloaded || (wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey)) return;
      this.setData({ isMember: true });
      clearPendingInvitation(this.data);
      // 加入已由云端确认，刷新缓存失败不能将成功操作报告为失败。
      try {
        const refreshed = await teamManager.loadTeamsFromCloud();
        if (!refreshed || !refreshed.success) {
          const team = await this.callTeam('getTeamInfo', { teamId: this.data.teamId });
          if (wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey) {
            teamManager.addJoinedTeam({
              ...team,
              members: (team.members || []).map(member => typeof member === 'string' ? member : member.openid).filter(Boolean)
            });
          }
        }
      } catch (error) {
        console.warn('刷新团队缓存失败:', error);
      }
      if (this._unloaded || (wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey)) return;
      wx.showToast({ title: '加入成功', icon: 'success' });
      this.enterTeamDetails();
    } catch (error) {
      if (!this._unloaded && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey) {
        wx.showModal({ title: '加入失败', content: error.message || '网络错误，请重试', showCancel: false });
      }
    } finally {
      wx.hideLoading();
      if (!this._unloaded) this.setData({ isJoining: false });
    }
  },

  enterTeamDetails() {
    if (!this.data.isMember || !this.data.teamId || this._viewerKey !== getViewerKey(this.data.teamId)) return;
    wx.redirectTo({ url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${encodeURIComponent(this.data.teamId)}` });
  },

  onAvatarError(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.members[index]) {
      this.setData({ [`members[${index}].avatar`]: '/images/avatar.png' });
    }
  }
});
