const teamManager = require('../../../../utils/teamManager.js');
const pendingInviteKey = 'pendingTeamInvitation';

function decodeParameter(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch (error) { return value; }
}

Page({
  data: {
    teamId: '', teamInfo: null, members: [], inviterId: '', inviteId: '',
    isLoading: false, isJoining: false, isMember: false, loadError: '',
    teamTotalCheckins: 0, teamActivityRate: 0, statsAvailable: false
  },

  async onLoad(options = {}) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    this._firstShow = true;
    const teamId = options.teamId || options.team_id || '';
    const inviteId = options.inviteId || options.invite_id || '';
    const pending = wx.getStorageSync(pendingInviteKey);
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
    if (this._firstShow) {
      this._firstShow = false;
      return;
    }
    if (this.data.teamId) return this.refreshTeam();
  },

  onUnload() {
    this._unloaded = true;
  },

  async refreshTeam() {
    const loaded = await this.loadTeamInfo();
    if (loaded && this._resumeJoin && this.hasUserInfo()) {
      this._resumeJoin = false;
      wx.removeStorageSync(pendingInviteKey);
      if (!this.data.isMember) return this.joinTeam();
    }
  },

  async callTeam(type, data) {
    const response = await wx.cloud.callFunction({ name: 'teamManager', data: { type, data } });
    if (!response.result || !response.result.success) {
      throw new Error(response.result && response.result.error || '请求失败，请重试');
    }
    return response.result.data;
  },

  async loadTeamInfo() {
    if (this.data.isJoining || !this.data.teamId) return false;
    const openid = wx.getStorageSync('userOpenId');
    if (this.data.isLoading && this._loadingOpenid === openid) return false;
    const version = this._loadVersion = (this._loadVersion || 0) + 1;
    this._loadingOpenid = openid;
    if (this._viewerOpenid !== openid) {
      this.setData({ teamInfo: null, members: [], isMember: false, statsAvailable: false });
    }
    this._viewerOpenid = openid;
    const isCurrent = () => !this._unloaded && version === this._loadVersion && wx.getStorageSync('userOpenId') === openid;
    this.setData({ isLoading: true, loadError: '' });
    try {
      // 每次进入都验证团队及成员资格，旧缓存不能代表邀请仍有效。
      const teamInfo = await this.callTeam('getTeamInfo', { teamId: this.data.teamId });
      if (!isCurrent()) return false;
      const isMember = typeof teamInfo.isMember === 'boolean' ? teamInfo.isMember : !!openid && (
        teamInfo.creator === openid || (teamInfo.members || []).some(member =>
          (typeof member === 'string' ? member : member.openid) === openid));
      const members = (teamInfo.members || []).map((entry, index) => {
        const member = typeof entry === 'string' ? { openid: entry } : entry;
        return {
          id: member.openid || `member_${index}`,
          openid: member.openid,
          name: member.nickname || '成员',
          role: member.isCreator || member.openid && member.openid === teamInfo.creator ? '团长' : '成员',
          avatar: member.avatarUrl || '/images/avatar.png',
          checkInCount: 0,
          monthlyCount: 0
        };
      });
      let statsAvailable = false;
      if (isMember && members.length) {
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
      this.setData({
        teamInfo, members, isMember, statsAvailable,
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

  async joinTeam() {
    if (this.data.isLoading || this.data.isJoining || this._loginPending) return;
    if (!this.data.teamInfo) {
      wx.showToast({ title: '请先加载团队信息', icon: 'none' });
      return;
    }
    if (this.data.isMember) return this.enterTeamDetails();
    if (!this.data.inviteId) {
      wx.showToast({ title: '请联系团长获取邀请', icon: 'none' });
      return;
    }
    if (!this.hasUserInfo()) {
      const invitation = {
        teamId: this.data.teamId, inviterId: this.data.inviterId, inviteId: this.data.inviteId,
        expiresAt: Date.now() + 30 * 60 * 1000
      };
      // profile 的旧版回跳仅携带 teamId；保存本次用户已确认的邀请，以便登录后继续。
      wx.setStorageSync(pendingInviteKey, invitation);
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
    const openid = wx.getStorageSync('userOpenId');
    this.setData({ isJoining: true });
    wx.showLoading({ title: '加入中...', mask: true });
    try {
      await this.callTeam('joinTeam', {
        teamId: this.data.teamId, inviterId: this.data.inviterId, inviteId: this.data.inviteId
      });
      if (this._unloaded || wx.getStorageSync('userOpenId') !== openid) return;
      this.setData({ isMember: true });
      wx.removeStorageSync(pendingInviteKey);
      // 加入已由云端确认，刷新缓存失败不能将成功操作报告为失败。
      try {
        const refreshed = await teamManager.loadTeamsFromCloud();
        if (!refreshed || !refreshed.success) {
          const team = await this.callTeam('getTeamInfo', { teamId: this.data.teamId });
          if (wx.getStorageSync('userOpenId') === openid) {
            teamManager.addJoinedTeam({
              ...team,
              members: (team.members || []).map(member => typeof member === 'string' ? member : member.openid).filter(Boolean)
            });
          }
        }
      } catch (error) {
        console.warn('刷新团队缓存失败:', error);
      }
      if (this._unloaded || wx.getStorageSync('userOpenId') !== openid) return;
      wx.showToast({ title: '加入成功', icon: 'success' });
      this.enterTeamDetails();
    } catch (error) {
      if (!this._unloaded && wx.getStorageSync('userOpenId') === openid) {
        wx.showModal({ title: '加入失败', content: error.message || '网络错误，请重试', showCancel: false });
      }
    } finally {
      wx.hideLoading();
      if (!this._unloaded) this.setData({ isJoining: false });
    }
  },

  enterTeamDetails() {
    if (!this.data.isMember || !this.data.teamId) return;
    wx.redirectTo({ url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${encodeURIComponent(this.data.teamId)}` });
  },

  onAvatarError(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.members[index]) {
      this.setData({ [`members[${index}].avatar`]: '/images/avatar.png' });
    }
  }
});
