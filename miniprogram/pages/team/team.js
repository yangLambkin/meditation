const { getBusinessDate } = require('../../utils/dateUtil.js');
const teamManager = require('../../utils/teamManager.js');

Page({
  data: {
    myTeams: [], joinedTeams: [], mergedJoinedTeams: [], allTeams: [],
    isLoading: false, currentTab: 'created', userNickname: '匿名用户',
    hasUserInfo: false, totalJoinedTeams: 0
  },

  createNewTeam() {
    const openid = wx.getStorageSync('userOpenId');
    if (!openid || /^(local_|test_)/.test(openid)) {
      wx.showModal({ title: '提示', content: '请先登录后再创建团队', showCancel: false, confirmText: '确定' });
      return;
    }
    wx.navigateTo({ url: '/subpackages/team/pages/createTeam/createTeam' });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'created' || tab === 'joined') this.setData({ currentTab: tab });
  },

  viewTeamDetail(e) {
    const { teamId } = e.currentTarget.dataset;
    if (this.data.currentTab !== 'created' || !this.data.mergedJoinedTeams.some(team => team._id === teamId)) return;
    wx.navigateTo({
      url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${encodeURIComponent(teamId)}`
    });
  },

  formatCreateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },

  getPracticeDate(value) {
    const date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) return '';
    return getBusinessDate(date);
  },

  onLoad() {
    this.getUserInfo();
  },

  onShow() {
    this.getUserInfo();
    return this.loadTeamData();
  },

  getUserInfo() {
    const openid = wx.getStorageSync('userOpenId');
    const userInfo = wx.getStorageSync('userInfo');
    this.setData({
      userNickname: openid ? wx.getStorageSync('userNickname') || (userInfo && userInfo.nickName) || '匿名用户' : '匿名用户',
      hasUserInfo: !!openid
    });
  },

  async getAllTeamsFromCloud() {
    const response = await wx.cloud.callFunction({ name: 'teamManager', data: { type: 'getAllTeams' } });
    const result = response && response.result;
    if (!result || !result.success || !result.data || !Array.isArray(result.data.teams)) {
      throw new Error((result && result.error) || '获取公开团队失败');
    }
    return result.data.teams;
  },

  getCachedAllTeams() {
    const teams = wx.getStorageSync('allTeams_cache');
    return Array.isArray(teams) ? teams : [];
  },

  renderTeams(allTeams = this.getCachedAllTeams()) {
    const myTeams = teamManager.getMyTeams();
    const ownIds = new Set(myTeams.map(team => team.cloudId || team._id));
    const format = team => ({
      ...team,
      _id: team.cloudId || team._id,
      icon: !team.icon || /^(wxfile:\/\/|https?:\/\/tmp\/)/.test(team.icon) ? '/images/icons/team.png' : team.icon,
      formattedCreateTime: this.formatCreateTime(team.createdAt),
      practiceStartDate: team.practiceStartDate === null ? null : team.practiceStartDate || this.getPracticeDate(team.createdAt),
      dailyGoalMinutes: team.dailyGoalMinutes === null ? null :
        Number.isInteger(team.dailyGoalMinutes) && team.dailyGoalMinutes > 0 ? team.dailyGoalMinutes : 20,
      isSelfCreated: ownIds.has(team.cloudId || team._id)
    });
    const formattedMyTeams = myTeams.map(format);
    const joinedTeams = teamManager.getJoinedTeams().map(format);
    const mergedJoinedTeams = this.mergeJoinedTeams(formattedMyTeams, joinedTeams);
    this.setData({
      myTeams: formattedMyTeams, joinedTeams, mergedJoinedTeams,
      allTeams: allTeams.map(format), totalJoinedTeams: mergedJoinedTeams.length
    });
  },

  loadTeamData(forceCloud = true) {
    const openid = wx.getStorageSync('userOpenId') || '';
    if (this._loadPromise && this._loadingUser === openid) return this._loadPromise;
    const sequence = (this._loadSequence || 0) + 1;
    this._loadSequence = sequence;
    this._loadingUser = openid;
    this.setData({ isLoading: true });
    // 两个列表先展示缓存；公开列表仅供浏览，不提供进入团队的入口。
    this.renderTeams();
    const load = async () => {
      try {
        const [privateResult, publicResult] = await Promise.all([
          forceCloud ? teamManager.loadTeamsFromCloud() : Promise.resolve({ success: true }),
          this.getAllTeamsFromCloud().then(data => ({ success: true, data }), error => ({ success: false, error: error.message }))
        ]);
        if (sequence !== this._loadSequence || openid !== (wx.getStorageSync('userOpenId') || '')) return;
        if (publicResult.success) wx.setStorageSync('allTeams_cache', publicResult.data);
        this.renderTeams();
        if (!privateResult.success || !publicResult.success) {
          wx.showToast({ title: '团队刷新失败，请稍后重试', icon: 'none' });
        }
      } catch (error) {
        if (sequence === this._loadSequence) wx.showToast({ title: error.message || '加载团队失败', icon: 'none' });
      } finally {
        if (sequence === this._loadSequence) {
          this.setData({ isLoading: false });
          this._loadPromise = null;
        }
      }
    };
    this._loadPromise = load();
    return this._loadPromise;
  },

  deleteTeam(e) {
    const { teamId, teamName } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认删除', content: `确定要删除团队"${teamName}"吗？删除后不可恢复。`,
      confirmText: '确认删除', confirmColor: '#ff4d4f', cancelText: '取消',
      success: async result => {
        if (!result.confirm || this._deletingTeam) return;
        this._deletingTeam = true;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          const deleted = await teamManager.deleteTeam(teamId);
          if (!deleted.success) throw new Error(deleted.error || '删除失败');
          // 已完成的删除优先于还在飞行中的列表快照。
          this._loadSequence = (this._loadSequence || 0) + 1;
          this._loadPromise = null;
          this.renderTeams();
          await this.loadTeamData();
          wx.hideLoading();
          wx.showToast({ title: '团队删除成功', icon: 'success' });
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        } finally {
          this._deletingTeam = false;
        }
      }
    });
  },

  onTeamCreated() {
    return this.refreshTeamData();
  },

  refreshTeamData() {
    // 来自创建/加入/解散页面的变更通知必须触发新快照。
    this._loadSequence = (this._loadSequence || 0) + 1;
    this._loadPromise = null;
    return this.loadTeamData();
  },

  async onPullDownRefresh() {
    try { await this.loadTeamData(); } finally { wx.stopPullDownRefresh(); }
  },

  calculateTotalJoinedTeams(myTeams, joinedTeams) {
    return this.mergeJoinedTeams(myTeams, joinedTeams).length;
  },

  mergeJoinedTeams(myTeams, joinedTeams) {
    const teams = new Map();
    myTeams.forEach(team => teams.set(team.cloudId || team._id, { ...team, isSelfCreated: true }));
    joinedTeams.forEach(team => {
      const id = team.cloudId || team._id;
      if (!teams.has(id)) teams.set(id, { ...team, isSelfCreated: false });
    });
    return Array.from(teams.values());
  }
});
