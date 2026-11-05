const { callTeam, isDataTeam, uploadTeamIcon, isDataTeamIcon, getViewerKey } = require('../../../../utils/teamGateway.js');
const { getBusinessDate } = require('../../../../utils/dateUtil.js');
const teamManager = require('../../../../utils/teamManager.js');
const { PRACTICES } = require('../../../../utils/practicePreferences.js');
const { practiceDraft, selectionOptions, practiceCards, stablePracticeOrder } = require('../../../../utils/teamPracticeSelection.js');
const contentSec = require('../../../../utils/contentSec.js');
const { selectReminderMembers } = require('../../utils/reminderText.js');
const { createReminderImage } = require('../../utils/reminderImage.js');
const DAY_MS = 24 * 60 * 60 * 1000;
const practiceConfig = type => PRACTICES.find(item => item.type === type) || PRACTICES[0];
const maxGoal = type => type === 'instant' ? 1000000 : type === 'kindness' ? 100000 : 1440;
const statusLabels = { not_practiced: '尚未练习', below_goal: '时长不足', qualified: '已达标', practiced: '已练习' };

// 练习日按北京时间 02:00 切换；页面统计日期仍以云端报告为准。
function currentPracticeDate() {
  return getBusinessDate(Date.now());
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value.slice(0, 4) !== '0000' &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

Page({
  data: {
    teamId: '', teamInfo: null, report: null, selectedPracticeType: '', practiceOptions: [], selectedPractice: null,
    draftSelectionOptions: [], draftPracticeCards: [], draftLockedPracticeTypes: [],
    draftPractices: [], draftPracticeType: '', draftPracticeIndex: 0, availablePractices: [], draftUnit: '', draftGoalMax: 1440, draftGoalPresets: [20, 30, 60],
    isLoading: false, isMember: false, isCreator: false, isDeputy: false, deputyCount: 0,
    loadError: '', reportError: '',
    currentTab: 'members', recordTab: 'today', todayFilter: 'attention',
    teamMembers: [], todayMembers: [], historyMembers: [], attentionCount: 0,
    overview: null, historySummary: null, hasGoal: false,
    practiceTypeName: '静坐觉察', practiceUnit: '分钟', goalMax: 1440, belowGoalLabel: '时长不足',
    dayLabel: '', nextDayLabel: '', historyRangeLabel: '',
    settingsOpen: false, keyboardHeight: 0, settingsScrollTarget: '', draftStartDate: '', draftGoalMinutes: '', dateMax: '',
    draftName: '', draftDescription: '', draftIcon: '', isChoosingIcon: false,
    draftPracticeRulesEnabled: false,
    settingsError: '', isSaving: false, isDeleting: false, removingMemberId: '', roleChangingMemberId: '',
    isPreparingInvite: false, inviteReady: false, inviteError: '',
    inviteDialogOpen: false, inviteExpiresLabel: '',
    isPreparingReminder: false, isSavingReminder: false,
    reminderDialogOpen: false, reminderImagePath: '', reminderCount: 0, reminderDate: '',
    reminderCanvasWidth: 750, reminderCanvasHeight: 1000
  },

  onLoad(options = {}) {
    this.resetInvitation();
    this.setData({ teamId: options.teamId || '', dateMax: currentPracticeDate() });
    if (!this.data.teamId) this.setData({ loadError: '团队链接不完整，请从团队列表重新进入' });
  },

  onShow() {
    this._isVisible = true;
    if (!this.data.teamId) return;
    if (!this._teamInfoReady || !this.data.teamInfo ||
        this._viewerOpenid !== wx.getStorageSync('userOpenId') || this._viewerKey !== getViewerKey(this.data.teamId) || this._viewerTeamId !== this.data.teamId) {
      return this.loadTeamData();
    }
    // 返回时复用本页的成员、选中项和滚动位置，只让过期的练习统计失效。
    if (this.data.report && this.data.report.nextResetAt <= Date.now()) this.clearPracticeReport();
    if (this.data.report) this.scheduleReset(this.data.report.nextResetAt);
    if (this.data.currentTab === 'records') return this.loadTeamReport();
  },

  onHide() {
    this._isVisible = false;
    this.cancelReminder();
    this._editVisibilityVersion = (this._editVisibilityVersion || 0) + 1;
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.resetInvitation({ keepPrepared: true });
    this.setData({ isLoading: false, keyboardHeight: 0, settingsScrollTarget: '' });
    this.clearResetTimer();
  },

  onUnload() {
    this.resetInvitation();
    this.cancelReminder();
    this._unloaded = true;
    this._isVisible = false;
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.clearResetTimer();
  },

  async onPullDownRefresh() {
    try { await this.loadTeamData(); } finally { wx.stopPullDownRefresh(); }
  },

  async callTeam(type, data) {
    const response = await callTeam(type, data);
    const result = response && response.result;
    if (!result || !result.success) throw new Error(result && result.error || '暂时无法连接，请稍后重试');
    return result.data;
  },

  clearResetTimer() {
    if (this._resetTimer) clearTimeout(this._resetTimer);
    this._resetTimer = null;
  },

  scheduleReset(nextResetAt) {
    this.clearResetTimer();
    if (!this._isVisible || this._unloaded) return;
    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      if (!this._isVisible || this._unloaded) return;
      // 新练习日不能继续显示上一天的「今日」结果。
      this.clearPracticeReport();
      if (this.data.currentTab === 'records') this.loadTeamReport();
    }, Math.max(1000, Math.min(DAY_MS + 1000, nextResetAt - Date.now() + 100)));
  },

  clearPracticeReport() {
    this._reportMembers = [];
    this.setData({ report: null, overview: null, historySummary: null, todayMembers: [], historyMembers: [], reportError: '', dateMax: currentPracticeDate() });
  },

  async loadTeamReport() {
    const { teamId, teamInfo } = this.data;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    if (!this._teamInfoReady || !teamInfo || teamInfo._id !== teamId || !this.data.isMember ||
        !this._isVisible || this._unloaded || this._viewerOpenid !== openid || this._viewerKey !== viewerKey || this._viewerTeamId !== teamId ||
        this.data.isSaving || this.data.isDeleting || this.data.removingMemberId || this.data.roleChangingMemberId) return;
    if (this.data.report && this.data.report.nextResetAt > Date.now()) return;
    const practiceType = this.data.selectedPracticeType;
    const version = this._loadVersion;
    if (this._reportRequest && this._reportRequest.version === version) return this._reportRequest.promise;
    if (this.data.isLoading) return;
    const request = { version };
    const isCurrent = () => !this._unloaded && this._isVisible && version === this._loadVersion &&
      this.data.teamId === teamId && this.data.selectedPracticeType === practiceType && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    this.clearPracticeReport();
    this.setData({ isLoading: true });
    this._reportRequest = request;
    request.promise = (async () => {
      try {
        const report = await this.callTeam('getTeamPracticeReport', { teamId, ...(isDataTeam(teamId) ? { practiceType: this.data.selectedPracticeType } : {}) });
        if (!isCurrent()) return;
        this.applyReport(report);
        this.scheduleReset(Number(report.nextResetAt));
      } catch (error) {
        if (isCurrent()) this.setData({ reportError: error.message || '练习数据暂时无法加载' });
      } finally {
        if (this._reportRequest === request) this._reportRequest = null;
        if (isCurrent()) this.setData({ isLoading: false });
      }
    })();
    return request.promise;
  },

  async loadTeamData() {
    if (!this.data.teamId) return;
    const teamId = this.data.teamId;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    if (this._viewerOpenid !== openid || this._viewerKey !== viewerKey || this._viewerTeamId !== teamId) {
      this.resetInvitation();
      this._reportMembers = [];
      this.setData({ teamInfo: null, report: null, overview: null, historySummary: null, teamMembers: [], todayMembers: [], historyMembers: [], isMember: false, isCreator: false, isDeputy: false, deputyCount: 0, settingsOpen: false, settingsError: '', isChoosingIcon: false });
    }
    if (this.data.isDeleting || this.data.isSaving || this.data.removingMemberId || this.data.roleChangingMemberId) return;
    if (this.data.isLoading && this._loadingOpenid === openid && this._loadingViewerKey === viewerKey && this._loadingTeamId === teamId) return;
    this.cancelReminder();
    const version = this._loadVersion = (this._loadVersion || 0) + 1;
    this._loadingOpenid = openid;
    this._loadingViewerKey = viewerKey;
    this._loadingTeamId = teamId;
    this._teamInfoReady = false;
    this.clearResetTimer();
    this.resetInvitation({ keepPrepared: true });
    this._viewerOpenid = openid;
    this._viewerKey = viewerKey;
    this._viewerTeamId = teamId;
    const isCurrent = () => !this._unloaded && version === this._loadVersion && this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    this._reportMembers = [];
    this.setData({ isLoading: true, loadError: '', reportError: '', report: null, overview: null, historySummary: null, teamMembers: [], todayMembers: [], historyMembers: [] });
    try {
      const team = await this.callTeam('getTeamInfo', { teamId });
      if (!isCurrent()) return;
      const isMember = typeof team.isMember === 'boolean' ? team.isMember : !!openid && (
        team.creator === openid || (team.members || []).some(member => (typeof member === 'string' ? member : member.openid) === openid));
      if (!isMember) {
        this.resetInvitation();
        this.setData({ teamInfo: null, isMember: false, isCreator: false, isDeputy: false, deputyCount: 0 });
        wx.redirectTo({ url: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${encodeURIComponent(teamId)}` });
        return;
      }
      this.updateLocalTeamCache(team);
      this.setData({ ...this.teamRoleData(team), teamMembers: this.profileMembers(team.members || [], team), isMember: true,
        hasGoal: Number.isInteger((this.practiceFor(team) || team).dailyGoalMinutes) && (this.practiceFor(team) || team).dailyGoalMinutes > 0 });
      this._teamInfoReady = true;
      if (!this.data.isCreator && !this.data.isDeputy) {
        this.resetInvitation();
      }
      wx.setNavigationBarTitle({ title: team.name });
      this.setData({ isLoading: false });
      if (this.data.currentTab === 'records') await this.loadTeamReport();
    } catch (error) {
      if (!isCurrent()) return;
      this.setData({ teamInfo: null, isCreator: false, isDeputy: false, deputyCount: 0, isMember: false, settingsOpen: false, loadError: error.message || '团队信息暂时无法加载' });
    } finally {
      if (isCurrent()) {
        this.setData({ isLoading: false });
      }
    }
  },

  applyReport(report) {
    const counts = ['todayMinutes', 'practiceDays', 'qualifiedDays', 'belowGoalDays', 'missedDays', 'unmetDays', 'totalMinutes'];
    const summaryKeys = ['memberCount', 'notPracticedCount', 'belowGoalCount', 'qualifiedCount'];
    const validCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!report || report.teamId !== this.data.teamInfo._id ||
        isDataTeam(this.data.teamId) && report.practiceType !== this.data.selectedPracticeType || !validDate(report.businessDate) ||
        !report.settings || !(report.settings.practiceStartDate === null ? validDate(report.settings.effectivePracticeStartDate) : validDate(report.settings.practiceStartDate)) ||
        !(report.settings.dailyGoalMinutes === null || (Number.isInteger(report.settings.dailyGoalMinutes) && report.settings.dailyGoalMinutes >= 1 && report.settings.dailyGoalMinutes <= maxGoal(report.practiceType || this.data.teamInfo.practiceType))) || report.settings.dayBoundaryHour !== 2 ||
        !report.history || !validCount(report.history.totalDays) || !validDate(report.history.startDate) || !validDate(report.history.endDate) ||
        !report.summary || !summaryKeys.every(key => validCount(report.summary[key])) || !Array.isArray(report.members) ||
        !report.members.every(member => member && member.openid && statusLabels[member.todayStatus] && counts.every(key => validCount(member[key]))) ||
        !Number.isFinite(report.nextResetAt)) {
      throw new Error('练习数据暂不完整，请刷新重试');
    }
    if (report.nextResetAt <= Date.now()) throw new Error('练习日已更新，请刷新查看最新数据');
    if (typeof report.creator === 'string' && Array.isArray(report.deputyLeaders)) {
      const leader = report.members.find(member => member.openid === report.creator);
      this.setData(this.teamRoleData({ ...this.data.teamInfo, creator: report.creator,
        creatorName: leader && leader.nickname || '团队成员', deputyLeaders: report.deputyLeaders, members: report.members }));
      this.updateLocalTeamCache(this.data.teamInfo);
      if (!this.data.isCreator && !this.data.isDeputy) {
        this.resetInvitation();
        this.cancelReminder();
      }
    }
    const goal = report.settings.dailyGoalMinutes;
    const hasGoal = goal !== null;
    const profiles = new Map(this.data.teamMembers.map(member => [member.openid, member]));
    const members = this.profileMembers(report.members.map(member => ({ ...profiles.get(member.openid), ...member }))).map(member => ({
      ...member,
      statusLabel: member.todayStatus === 'below_goal' && practiceConfig(report.practiceType || this.data.teamInfo.practiceType).unit !== '分钟' ? '数量不足' : statusLabels[member.todayStatus],
      todayMinutesLabel: this.formatMinutes(member.todayMinutes),
      totalMinutesLabel: this.formatMinutes(member.totalMinutes),
      cumulativeMinutesLabel: this.formatMinutes(member.cumulativeMinutes === undefined ? member.totalMinutes + member.todayMinutes : member.cumulativeMinutes),
      lastPracticeLabel: this.formatLastPractice(member),
      remainingMinutesLabel: hasGoal ? this.formatMinutes(Math.max(0, goal - member.todayMinutes)) : '',
      progress: !hasGoal ? 0 : member.todayStatus === 'qualified' ? 100 : Math.min(99, Math.floor(member.todayMinutes / goal * 100))
    }));
    this._reportMembers = members;
    const historyMembers = [...members].sort((a, b) => (hasGoal ? b.unmetDays - a.unmetDays || b.missedDays - a.missedDays : b.practiceDays - a.practiceDays || b.totalMinutes - a.totalMinutes) || a.nickname.localeCompare(b.nickname));
    const date = new Date(`${report.businessDate}T00:00:00Z`);
    const nextDay = new Date(date.getTime() + DAY_MS);
    this.setData({
      report,
      hasGoal,
      todayFilter: !hasGoal && ['below_goal', 'qualified'].includes(this.data.todayFilter) || hasGoal && this.data.todayFilter === 'practiced' ? 'attention' : this.data.todayFilter,
      overview: report.overview || null,
      historySummary: this.buildHistorySummary(report),
      teamMembers: [...members].sort((a, b) => Number(b.isCreator) - Number(a.isCreator) || Number(b.isDeputy) - Number(a.isDeputy) || a.nickname.localeCompare(b.nickname)),
      teamInfo: isDataTeam(this.data.teamId) ? this.data.teamInfo : { ...this.data.teamInfo, ...report.settings },
      selectedPractice: { ...(this.data.selectedPractice || {}), ...report.settings },
      attentionCount: report.summary.notPracticedCount + report.summary.belowGoalCount,
      historyMembers,
      dayLabel: `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`,
      nextDayLabel: `${nextDay.getUTCMonth() + 1}月${nextDay.getUTCDate()}日`,
      historyRangeLabel: `${report.history.startDate.replace(/-/g, '.')} — ${report.history.endDate.replace(/-/g, '.')}`,
      dateMax: report.businessDate,
      reportError: ''
    });
    this.updateTodayMembers();
  },

  buildHistorySummary(report) {
    const { members, history, settings } = report;
    if (!history.totalDays || !members.length) return null;
    const hasGoal = settings.dailyGoalMinutes !== null;
    const summary = {
      memberCount: members.length,
      unmetMemberCount: 0, unmetCount: 0,
      missedMemberCount: 0, missedCount: 0,
      belowGoalMemberCount: 0, belowGoalCount: 0,
      fullAttendanceCount: 0
    };
    let completedCount = 0;
    members.forEach(member => {
      summary.missedMemberCount += Number(member.missedDays > 0);
      summary.missedCount += member.missedDays;
      if (hasGoal) {
        summary.unmetMemberCount += Number(member.unmetDays > 0);
        summary.unmetCount += member.unmetDays;
        summary.belowGoalMemberCount += Number(member.belowGoalDays > 0);
        summary.belowGoalCount += member.belowGoalDays;
      }
      const completedDays = hasGoal ? member.qualifiedDays : member.practiceDays;
      completedCount += completedDays;
      summary.fullAttendanceCount += Number(completedDays === history.totalDays);
    });
    // 历史按每人每天计一次，与当日练习次数、今日状态无关。
    const totalCount = members.length * history.totalDays;
    const rate = Math.round(completedCount / totalCount * 1000) / 10;
    // 有未完成的练习日时，不能因为四舍五入而显示为全部完成。
    summary.rateLabel = `${completedCount < totalCount ? Math.min(99.9, rate) : 100}%`;
    return summary;
  },

  teamRoleData(team) {
    const openid = wx.getStorageSync('userOpenId');
    const members = (team.members || []).map(member => typeof member === 'string' ? member : member.openid);
    const deputyLeaders = [...new Set((Array.isArray(team.deputyLeaders) ? team.deputyLeaders : [])
      .filter(id => typeof id === 'string' && id !== team.creator && members.includes(id)))];
    const isCreator = !!openid && team.creator === openid;
    const currentPractice = this.practiceFor(team);
    const practice = practiceConfig(currentPractice.practiceType || team.practiceType);
    return { selectedPracticeType: practice.type, selectedPractice: currentPractice,
      practiceOptions: this.practicesFor(team).map(item => ({ ...item, ...practiceConfig(item.practiceType) })), teamInfo: { ...team, deputyLeaders }, isCreator,
      practiceTypeName: practice.name, practiceUnit: practice.unit, goalMax: maxGoal(practice.type),
      belowGoalLabel: practice.unit === '分钟' ? '时长不足' : '数量不足',
      isDeputy: !isCreator && !!openid && deputyLeaders.includes(openid), deputyCount: deputyLeaders.length,
      ...(!isCreator ? { settingsOpen: false, isChoosingIcon: false } : {}) };
  },

  practicesFor(team) {
    return isDataTeam(team._id) && Array.isArray(team.practices) && team.practices.length ? team.practices : [{ ...team, practiceType: team.practiceType || 'sitting' }];
  },

  practiceFor(team = this.data.teamInfo) {
    const practices = this.practicesFor(team);
    return practices.find(item => item.practiceType === this.data.selectedPracticeType) || practices[0];
  },

  async switchPractice(event) {
    const type = event.currentTarget.dataset.type;
    if (!this._teamInfoReady || !this.data.teamInfo || !isDataTeam(this.data.teamId) || this.data.isSaving || this.data.isDeleting || this.data.settingsOpen ||
        this.data.removingMemberId || this.data.roleChangingMemberId || type === this.data.selectedPracticeType ||
        !this.practicesFor(this.data.teamInfo).some(item => item.practiceType === type)) return;
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.cancelReminder();
    this.clearResetTimer();
    this.setData({ selectedPracticeType: type, isLoading: false });
    const practice = this.practiceFor();
    this.setData({ ...this.teamRoleData(this.data.teamInfo), hasGoal: Number.isInteger(practice.dailyGoalMinutes) && practice.dailyGoalMinutes > 0 });
    this.clearPracticeReport();
    if (this.data.currentTab === 'records') await this.loadTeamReport();
  },

  profileMembers(members, team = this.data.teamInfo) {
    return members.map(value => {
      const member = typeof value === 'string' ? { openid: value } : value;
      const studentNumber = typeof member.bijingStudentNumber === 'string' ? member.bijingStudentNumber.trim() : null;
      return { ...member,
        bijingStudentNumberLabel: studentNumber === null ? '学号暂未获取' : studentNumber || '未绑定学号',
        isCreator: !!team && member.openid === team.creator,
        isDeputy: !!team && member.openid !== team.creator && (team.deputyLeaders || []).includes(member.openid),
        avatar: typeof member.avatarUrl === 'string' && member.avatarUrl && !/^(wxfile:|https?:\/\/tmp\/)/.test(member.avatarUrl) ? member.avatarUrl : '/images/avatar.png',
        nickname: member.nickname || '团队成员'
      };
    });
  },

  formatLastPractice(member) {
    if (member.lastPracticeAt) {
      const date = new Date(member.lastPracticeAt + 8 * 60 * 60 * 1000);
      return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    }
    return member.lastPracticeDate ? member.lastPracticeDate.replace(/-/g, '.') : '';
  },

  formatMinutes(value) {
    if (value > 0 && value < 0.01) return '少于0.01';
    // 截取小数而不向上取整，19.999 分钟也不能展示为 20 分钟已完成。
    return (Math.floor((value + Number.EPSILON * Math.max(1, value)) * 100) / 100).toString();
  },

  updateTodayMembers() {
    const filter = this.data.todayFilter;
    const priority = { not_practiced: 0, below_goal: 1, qualified: 2, practiced: 2 };
    const members = (this._reportMembers || []).filter(member => filter === 'all' ||
      (filter === 'attention' ? ['not_practiced', 'below_goal'].includes(member.todayStatus) : member.todayStatus === filter));
    members.sort((a, b) => priority[a.todayStatus] - priority[b.todayStatus] || a.todayMinutes - b.todayMinutes || a.nickname.localeCompare(b.nickname));
    this.setData({ todayMembers: members });
  },

  switchTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (tab !== 'members' && tab !== 'records') return;
    this.setData({ currentTab: tab });
    if (tab === 'records') return this.loadTeamReport();
  },

  switchRecordTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (tab === 'today' || tab === 'history') this.setData({ recordTab: tab });
  },

  changeTodayFilter(event) {
    const filter = event.currentTarget.dataset.filter;
    if (!['attention', 'all', 'not_practiced', 'below_goal', 'qualified', 'practiced'].includes(filter)) return;
    this.setData({ todayFilter: filter, currentTab: 'records', recordTab: 'today' });
    if (this.data.report) this.updateTodayMembers();
  },

  cancelReminder() {
    this._reminderVersion = (this._reminderVersion || 0) + 1;
    this._reminderContext = null;
    if (!this._unloaded) this.setData({ isPreparingReminder: false, isSavingReminder: false,
      reminderDialogOpen: false, reminderImagePath: '', reminderCount: 0, reminderDate: '' });
  },

  closeReminderDialog() {
    this.cancelReminder();
  },

  getReminderCanvas() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#reminderCanvas').fields({ node: true }).exec(results => {
        const canvas = results && results[0] && results[0].node;
        if (canvas) resolve(canvas);
        else reject(new Error('图片画布暂时无法使用，请重试'));
      });
    });
  },

  async showReminderList() {
    const { teamId, teamInfo } = this.data;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    if (this._unloaded || !this._isVisible || !this.canAssistTeam() || !teamInfo ||
        teamInfo._id !== teamId ||
        !openid || this._viewerOpenid !== openid || this._viewerKey !== viewerKey || this._viewerTeamId !== teamId ||
        !this.data.report || this.data.isLoading || this.data.isPreparingReminder ||
        this.data.isSaving || this.data.isDeleting || this.data.removingMemberId || this.data.roleChangingMemberId) return;
    this.cancelReminder();
    const version = this._reminderVersion;
    const loadVersion = this._loadVersion;
    const practiceType = this.data.selectedPracticeType;
    const isCurrent = () => !this._unloaded && this._isVisible && this.data.selectedPracticeType === practiceType && version === this._reminderVersion &&
      loadVersion === this._loadVersion && this.data.teamId === teamId && this.data.isMember &&
      this.canAssistTeam() && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey &&
      !this.data.isSaving && !this.data.isDeleting && !this.data.removingMemberId && !this.data.roleChangingMemberId;
    this.setData({ isPreparingReminder: true });
    try {
      // 长图包含全体未达标成员，不受当前列表筛选影响；生成前重新获取云端统计。
      const report = await this.callTeam('getTeamPracticeReport', { teamId, ...(isDataTeam(teamId) ? { practiceType: this.data.selectedPracticeType } : {}) });
      if (!isCurrent()) return;
      this.applyReport(report);
      if (!isCurrent()) return;
      this.scheduleReset(report.nextResetAt);
      const hasGoal = report.settings.dailyGoalMinutes !== null;
      const members = selectReminderMembers({ ...report, members: this._reportMembers });
      if (!members.length) {
        wx.showToast({ title: hasGoal ? '今天大家都已达标' : '今天大家都已练习', icon: 'none' });
        return;
      }
      const canvas = await this.getReminderCanvas();
      if (!isCurrent()) return;
      const reminder = await createReminderImage({ canvas, report, members, teamName: isDataTeam(teamId) ? `${teamInfo.name} · ${practiceConfig(practiceType).name}` : teamInfo.name, isCurrent,
        resizeCanvas: (width, height) => new Promise(resolve => {
          this.setData({ reminderCanvasWidth: width, reminderCanvasHeight: height }, resolve);
        }) });
      if (!isCurrent()) return;
      if (report.nextResetAt <= Date.now()) {
        wx.showToast({ title: '练习日已更新，请重新查看', icon: 'none' });
        await this.loadTeamData();
        return;
      }
      this._reminderContext = { teamId, openid, viewerKey, practiceType, nextResetAt: report.nextResetAt };
      this.setData({ reminderDialogOpen: true, reminderImagePath: reminder.tempFilePath,
        reminderCount: members.length, reminderDate: report.businessDate });
    } catch (error) {
      if (isCurrent()) wx.showModal({ title: '长图生成失败', content: error.message || '请稍后重试', showCancel: false });
    } finally {
      if (!this._unloaded && version === this._reminderVersion) this.setData({ isPreparingReminder: false });
    }
  },

  canUseReminderImage(context) {
    return !!context && this._reminderContext === context && !(this._unloaded || !this._isVisible || !this.data.reminderDialogOpen ||
        !this.data.reminderImagePath || !this.canAssistTeam() ||
        this.data.teamId !== context.teamId || this.data.selectedPracticeType !== context.practiceType || this._viewerOpenid !== context.openid ||
        wx.getStorageSync('userOpenId') !== context.openid || getViewerKey(context.teamId) !== context.viewerKey || this.data.isLoading ||
        this.data.isSaving || this.data.isDeleting || this.data.removingMemberId || this.data.roleChangingMemberId);
  },

  async getCurrentReminderContext() {
    const context = this._reminderContext;
    if (!this.canUseReminderImage(context)) return null;
    if (context.nextResetAt <= Date.now()) {
      this.closeReminderDialog();
      wx.showToast({ title: '练习日已更新，请重新查看', icon: 'none' });
      await this.loadTeamData();
      return null;
    }
    return context;
  },

  async previewReminderImage() {
    const context = await this.getCurrentReminderContext();
    if (!this.canUseReminderImage(context)) return;
    wx.previewImage({ current: this.data.reminderImagePath, urls: [this.data.reminderImagePath],
      fail: () => {
        if (!this._unloaded && this._isVisible && this._reminderContext === context) {
          wx.showToast({ title: '图片预览失败，请重试', icon: 'none' });
        }
      }
    });
  },

  async saveReminderImage() {
    if (this.data.isSavingReminder) return;
    const context = await this.getCurrentReminderContext();
    if (!this.canUseReminderImage(context) || this.data.isSavingReminder) return;
    const filePath = this.data.reminderImagePath;
    const isCurrent = () => this.canUseReminderImage(context) &&
      context.nextResetAt > Date.now() && this.data.reminderImagePath === filePath;
    const finish = () => {
      if (!this._unloaded && this._reminderContext === context) this.setData({ isSavingReminder: false });
    };
    this.setData({ isSavingReminder: true });
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        finish();
        if (isCurrent()) wx.showToast({ title: '图片已保存到相册', icon: 'success' });
      },
      fail: error => {
        finish();
        if (!isCurrent()) return;
        if (/auth deny|auth denied|authorize/i.test(error && error.errMsg || '')) {
          wx.showModal({
            title: '保存图片需要授权',
            content: '请在设置中允许保存到相册，开启后重新保存图片。',
            confirmText: '去设置',
            success: result => {
              if (!result.confirm || !isCurrent()) return;
              wx.openSetting({
                fail: () => {
                  if (isCurrent()) wx.showToast({ title: '无法打开设置，请重试', icon: 'none' });
                }
              });
            }
          });
        } else {
          wx.showToast({ title: '图片保存失败，请重试', icon: 'none' });
        }
      }
    });
  },

  openHistoryDetails(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const { teamId, teamInfo, report, isMember, hasGoal, teamMembers } = this.data;
    if (this._unloaded || this.data.isLoading || this.data.isSaving || this.data.isDeleting ||
        !isMember || !teamInfo || teamInfo._id !== teamId || !report || report.teamId !== teamId ||
        !report.history || report.history.totalDays <= 0 ||
        !this._viewerOpenid || wx.getStorageSync('userOpenId') !== this._viewerOpenid || this._viewerKey !== getViewerKey(teamId) ||
        !['unmet', 'not_practiced', 'below_goal', 'all'].includes(dataset.filter)) return;
    let memberQuery = '';
    if (dataset.memberOpenid !== undefined) {
      const member = teamMembers.find(item => item.openid === dataset.memberOpenid);
      if (!member) return;
      memberQuery = `&memberOpenid=${encodeURIComponent(member.openid)}&memberName=${encodeURIComponent(member.nickname)}`;
    }
    const filter = !hasGoal && ['unmet', 'below_goal'].includes(dataset.filter) ? 'not_practiced' : dataset.filter;
    wx.navigateTo({ url: `/subpackages/team/pages/historyDetails/historyDetails?teamId=${encodeURIComponent(teamId)}&month=${report.businessDate.slice(0, 7)}&filter=${filter}${memberQuery}${isDataTeam(teamId) ? '&practiceType=' + encodeURIComponent(this.data.selectedPracticeType) : ''}` });
  },

  openMemberRecords(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const { teamId, teamInfo, report, isMember, teamMembers } = this.data;
    if (!isMember || !teamInfo || teamInfo._id !== teamId || typeof teamId !== 'string' || !teamId ||
        !this._viewerOpenid || wx.getStorageSync('userOpenId') !== this._viewerOpenid || this._viewerKey !== getViewerKey(teamId) ||
        typeof dataset.memberOpenid !== 'string' || !['month', 'day'].includes(dataset.view)) return;
    const member = teamMembers.find(item => item.openid === dataset.memberOpenid);
    if (!member) return;
    const reportDate = dataset.recordScope === 'history' && report && report.history
      ? report.history.endDate : report && report.businessDate;
    const date = validDate(reportDate) ? reportDate : currentPracticeDate();
    const context = `teamId=${encodeURIComponent(teamId)}&memberOpenid=${encodeURIComponent(member.openid)}&memberName=${encodeURIComponent(member.nickname || '团队成员')}`;
    if (/^bijing_/.test(teamId)) {
      wx.navigateTo({ url: `/subpackages/team/pages/memberRecords/memberRecords?${context}&practiceType=${encodeURIComponent(this.data.selectedPracticeType)}&${dataset.view === 'day' ? 'date=' + date : 'month=' + date.slice(0, 7)}` });
      return;
    }
    const url = dataset.view === 'day'
      ? `/pages/history/history?${context}&date=${date}`
      : `/pages/checkinHistory/checkinHistory?${context}&month=${date.slice(0, 7)}&date=${date}`;
    wx.navigateTo({ url });
  },

  updateLocalTeamCache(team) {
    try {
      teamManager.addJoinedTeam({ ...team, members: (team.members || []).map(member => typeof member === 'string' ? member : member.openid).filter(Boolean) });
    } catch (error) { console.warn('缓存团队信息失败:', error); }
  },

  openSettings() {
    const team = this.data.teamInfo;
    if (!team || this._viewerKey !== getViewerKey(this.data.teamId) || !this.data.isMember || this.data.isDeleting || this.data.isSaving || this.data.isChoosingIcon ||
        this.data.removingMemberId || this.data.roleChangingMemberId) return;
    const settings = this.data.report ? this.data.report.settings : this.practiceFor(team);
    const draftPractices = this.practicesFor(team).map(item => practiceDraft(item));
    this._draftPracticeCache = {};
    this._draftPracticeRanks = Object.fromEntries(draftPractices.map((item, index) => [item.practiceType, index]));
    const lockedTypes = draftPractices.map(item => item.practiceType);
    const draftPracticeType = this.data.selectedPracticeType || team.practiceType || 'sitting';
    this.setData({
      settingsOpen: true, keyboardHeight: 0, settingsScrollTarget: '',
      draftSelectionOptions: selectionOptions(draftPractices, lockedTypes), draftPracticeCards: practiceCards(draftPractices, '启用日起'), draftLockedPracticeTypes: lockedTypes,
      draftPractices, draftPracticeType, draftPracticeIndex: Math.max(0, draftPractices.findIndex(item => item.practiceType === draftPracticeType)),
      draftUnit: practiceConfig(draftPracticeType).unit, draftGoalMax: maxGoal(draftPracticeType),
      draftGoalPresets: ['instant', 'kindness'].includes(draftPracticeType) ? [1, 3, 10] : [20, 30, 60],
      availablePractices: isDataTeam(this.data.teamId) ? PRACTICES.filter(item => !draftPractices.some(row => row.practiceType === item.type)) : [],
      draftName: team.name || '', draftDescription: team.description || '', draftIcon: team.icon || '/images/icons/team.png',
      draftStartDate: settings.practiceStartDate || '',
      draftGoalMinutes: settings.dailyGoalMinutes == null ? '' : String(settings.dailyGoalMinutes),
      draftPracticeRulesEnabled: Boolean(settings.practiceStartDate || settings.dailyGoalMinutes != null && settings.dailyGoalMinutes !== ''),
      dateMax: this.data.report ? this.data.report.businessDate : currentPracticeDate(),
      settingsError: ''
    });
  },

  currentDraftPractices() {
    return this.data.draftPractices.map(item => item.practiceType === this.data.draftPracticeType
      ? { ...item, rulesEnabled: this.data.draftPracticeRulesEnabled,
        practiceStartDate: this.data.draftStartDate || '', dailyGoalMinutes: this.data.draftGoalMinutes == null ? '' : String(this.data.draftGoalMinutes) } : item);
  },

  selectDraftPractice(event) {
    if (!this.canViewDraftPractices() || !this.data.settingsOpen || this.data.isSaving || this.data.isDeleting || this._unloaded || !isDataTeam(this.data.teamId)) return;
    const list = this.currentDraftPractices();
    const type = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.type;
    const index = type ? list.findIndex(item => item.practiceType === type) : Number(event.detail && event.detail.value);
    if (Number.isInteger(index) && list[index]) this.applyDraftPractice(list, index);
  },

  addDraftPractice(event) {
    const type = event.currentTarget.dataset.type;
    if (this.data.draftPractices.some(item => item.practiceType === type)) return;
    this.toggleDraftPractice(event);
    if (this.data.draftPractices.some(item => item.practiceType === type)) this.selectDraftPractice(event);
  },

  applyDraftPractice(drafts, index) {
    const activeType = drafts[index] && drafts[index].practiceType;
    this._draftPracticeRanks = this._draftPracticeRanks || {};
    const list = stablePracticeOrder(drafts.map(item => practiceDraft(item)), this._draftPracticeRanks, false);
    index = list.findIndex(item => item.practiceType === activeType);
    const item = list[index];
    if (!item) return;
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.setData({ draftPractices: list, draftPracticeCards: practiceCards(list, '启用日起'),
      draftSelectionOptions: selectionOptions(list, this.data.draftLockedPracticeTypes),
      draftPracticeType: item.practiceType, draftPracticeIndex: index,
      draftUnit: item.unit, draftGoalMax: item.maxGoal, draftGoalPresets: item.presets,
      draftStartDate: item.practiceStartDate, draftGoalMinutes: item.dailyGoalMinutes, draftPracticeRulesEnabled: item.rulesEnabled,
      keyboardHeight: 0, settingsScrollTarget: '',
      availablePractices: PRACTICES.filter(config => !list.some(row => row.practiceType === config.type)), settingsError: '' });
  },

  closeSettings() {
    if (!this.data.isSaving && !this.data.isDeleting && !this.data.isChoosingIcon) this.setData({ settingsOpen: false, keyboardHeight: 0, settingsScrollTarget: '' });
  },

  preventSheetClose() {},

  changePracticeRulesEnabled(event) {
    if (!this.canManageTeam() || !this.data.settingsOpen || this.data.isSaving || this.data.isDeleting || this._unloaded || !this.isDraftRuleEventCurrent(event)) return;
    const enabled = event.detail.value === true;
    // 关闭时保留本次编辑的草稿，提交时再将两项规则清空。
    this.updateDraftDisplay({
      draftPracticeRulesEnabled: enabled, settingsError: '',
      ...(!enabled ? { keyboardHeight: 0, settingsScrollTarget: '' } : {})
    });
    if (!enabled && typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
  },

  onGoalKeyboardHeightChange(event) {
    if (!this.data.settingsOpen || !this.data.draftPracticeRulesEnabled || !this.isDraftRuleEventCurrent(event)) return;
    const height = Number(event.detail && event.detail.height);
    const keyboardHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
    // 只收缩设置层的可用高度，表单与底部操作都留在可滚动区域。
    this.setData({ keyboardHeight, settingsScrollTarget: keyboardHeight > 0 ? 'daily-goal-field' : '' });
  },

  onFieldKeyboardHeightChange(event) {
    if (!this.data.settingsOpen) return;
    const height = Number(event.detail && event.detail.height);
    const keyboardHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
    this.setData({ keyboardHeight, settingsScrollTarget: keyboardHeight > 0 ? event.currentTarget.dataset.field || '' : '' });
  },

  changeTeamName(event) {
    if (this.canManageTeam() && !this.data.isSaving) this.setData({ draftName: event.detail.value, settingsError: '' });
  },

  changeTeamDescription(event) {
    if (this.canManageTeam() && !this.data.isSaving) this.setData({ draftDescription: event.detail.value, settingsError: '' });
  },

  chooseTeamIcon() {
    if (!this.canManageTeam() || !this.data.settingsOpen || this.data.isSaving || this.data.isDeleting || this.data.isChoosingIcon) return;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const teamId = this.data.teamId;
    const version = this._iconVersion = (this._iconVersion || 0) + 1;
    const isCurrent = () => !this._unloaded && this._iconVersion === version && this.data.settingsOpen &&
      this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey && this.canManageTeam();
    this.setData({ isChoosingIcon: true, settingsError: '' });
    const finish = () => {
      if (!this._unloaded && this._iconVersion === version) this.setData({ isChoosingIcon: false });
    };
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: async result => {
        try {
          if (!isCurrent()) return;
          const file = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath;
          if (!file) throw new Error('未获取到图片，请重新选择');
          let icon = await contentSec.checkImage(file, { scene: 1, bizType: 'avatar', returnFileID: true, cloudPrefix: 'team_icons' });
          if (!isCurrent()) return;
          if (!icon) return;
          if (typeof icon !== 'string' || !icon.startsWith('cloud://')) throw new Error('图片上传失败，请重新选择');
          if (isDataTeam(teamId)) {
            icon = await uploadTeamIcon(icon);
            if (!isCurrent()) return;
            if (!isDataTeamIcon(icon)) throw new Error('图片上传失败，请重新选择');
          }
          this.setData({ draftIcon: icon });
        } catch (error) {
          if (isCurrent()) this.setData({ settingsError: error.message || '图片选择失败，请重试' });
        } finally { finish(); }
      },
      fail: error => {
        if (isCurrent() && !/cancel/i.test(error.errMsg || '')) this.setData({ settingsError: '图片选择失败，请重试' });
        finish();
      }
    });
  },

  changeStartDate(event) {
    if (this.canEditPracticeRules() && this.isDraftRuleEventCurrent(event)) this.updateDraftDisplay({ draftStartDate: event.detail.value, settingsError: '' });
  },

  clearStartDate(event) {
    if (this.canEditPracticeRules() && this.isDraftRuleEventCurrent(event)) this.updateDraftDisplay({ draftStartDate: '', settingsError: '' });
  },

  changeGoalMinutes(event) {
    if (this.canEditPracticeRules() && this.isDraftRuleEventCurrent(event)) this.updateDraftDisplay({ draftGoalMinutes: event.detail.value, settingsError: '' });
  },

  chooseGoalMinutes(event) {
    if (this.canEditPracticeRules() && this.isDraftRuleEventCurrent(event)) this.updateDraftDisplay({ draftGoalMinutes: String(event.currentTarget.dataset.minutes), settingsError: '' });
  },

  canEditPracticeRules() {
    return this.canManageTeam() && this.data.settingsOpen && this.data.draftPracticeRulesEnabled &&
      !this.data.isSaving && !this.data.isDeleting && !this._unloaded;
  },

  canManageTeam() {
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    return !this.data.removingMemberId && !this.data.roleChangingMemberId && this.data.isMember && !!openid &&
      !!this.data.teamInfo && this.data.isCreator && this._viewerOpenid === openid && this._viewerKey === viewerKey &&
      this._viewerTeamId === this.data.teamId && this.data.teamInfo._id === this.data.teamId && this.data.teamInfo.creator === openid;
  },

  canAssistTeam() {
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const team = this.data.teamInfo;
    return !!openid && !!team && this.data.isMember && this._viewerOpenid === openid && this._viewerKey === viewerKey &&
      this._viewerTeamId === this.data.teamId && team._id === this.data.teamId &&
      ((this.data.isCreator && team.creator === openid) ||
        (this.data.isDeputy && team.creator !== openid && (team.deputyLeaders || []).includes(openid)));
  },

  canChangeMemberRole() {
    return this.canManageTeam() && this._isVisible && !this._unloaded &&
      !this.data.isLoading && !this.data.isSaving && !this.data.isDeleting;
  },

  async openMemberActions(event) {
    if (!this.canChangeMemberRole() || this._memberActionPrompt || this._rolePrompt || this._removePrompt) return;
    const memberOpenid = event && event.currentTarget && event.currentTarget.dataset.memberOpenid;
    const member = this.data.teamMembers.find(item => item.openid === memberOpenid);
    if (!member || member.isCreator || memberOpenid === this.data.teamInfo.creator) return;
    const teamId = this.data.teamId;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const visibilityVersion = this._editVisibilityVersion || 0;
    const loadVersion = this._loadVersion;
    this._memberActionPrompt = true;
    let action;
    try {
      action = await new Promise(resolve => wx.showActionSheet({
        itemList: [member.isDeputy ? '取消副团长' : '设为副团长', '交接团长', '移除成员'],
        success: result => resolve(result.tapIndex), fail: () => resolve(-1)
      }));
    } finally { this._memberActionPrompt = false; }
    if (!this.canChangeMemberRole() || this.data.teamId !== teamId || (wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey) ||
        visibilityVersion !== (this._editVisibilityVersion || 0) || loadVersion !== this._loadVersion) return;
    if (action === 0) return this.confirmMemberRoleChange(event, 'deputy');
    if (action === 1) return this.confirmMemberRoleChange(event, 'leader');
    if (action === 2) return this.confirmRemoveMember(event);
  },

  async confirmMemberRoleChange(event, role) {
    if (!this.canChangeMemberRole() || this._rolePrompt || this._removePrompt || !['deputy', 'leader'].includes(role)) return;
    const memberOpenid = event && event.currentTarget && event.currentTarget.dataset.memberOpenid;
    const member = this.data.teamMembers.find(item => item.openid === memberOpenid);
    if (!member || member.isCreator || memberOpenid === this.data.teamInfo.creator) return;
    const isDeputy = !member.isDeputy;
    if (role === 'deputy' && isDeputy && this.data.deputyCount >= 7) {
      wx.showToast({ title: '副团长最多 7 位，请先取消一位', icon: 'none' });
      return;
    }
    const title = role === 'leader' ? '交接团长' : isDeputy ? '设为副团长' : '取消副团长';
    const content = role === 'leader'
      ? `确定将团长身份交接给「${member.nickname}」吗？交接后你将成为普通成员，无法再管理团队、邀请成员或发送提醒。`
      : isDeputy ? `将「${member.nickname}」设为副团长？副团长可提醒和邀请成员，不能移除成员、任免副团长、编辑或解散团队。`
        : `确定取消「${member.nickname}」的副团长身份吗？对方将成为普通成员。`;
    const teamId = this.data.teamId;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const visibilityVersion = this._editVisibilityVersion || 0;
    const loadVersion = this._loadVersion;
    const isCurrent = () => !this._unloaded && this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    this._rolePrompt = true;
    let changed = false;
    let attempted = false;
    try {
      const confirmed = await new Promise(resolve => wx.showModal({ title, content,
        confirmText: role === 'leader' ? '确认交接' : '确定', cancelText: '取消',
        success: result => resolve(result.confirm), fail: () => resolve(false)
      }));
      if (!confirmed || !isCurrent() || !this.canChangeMemberRole() ||
          visibilityVersion !== (this._editVisibilityVersion || 0) || loadVersion !== this._loadVersion ||
          !this.data.teamMembers.some(item => item.openid === memberOpenid && !item.isCreator)) return;
      this._loadVersion = (this._loadVersion || 0) + 1;
      this.resetInvitation();
      this.cancelReminder();
      this.clearResetTimer();
      this.setData({ roleChangingMemberId: memberOpenid, isLoading: false });
      attempted = true;
      const result = role === 'leader' ? await teamManager.transferTeamLeader(teamId, memberOpenid)
        : await teamManager.setTeamDeputy(teamId, memberOpenid, isDeputy);
      if (!result || !result.success) throw new Error(result && result.error || `${title}失败，请重试`);
      if (!isCurrent()) return;
      changed = true;
      const updatedTeam = { ...this.data.teamInfo, ...result.data, _id: teamId };
      const profiles = new Map(this.data.teamMembers.map(item => [item.openid, item]));
      updatedTeam.members = (updatedTeam.members || []).map(id => typeof id === 'string' ? profiles.get(id) || { openid: id } : id);
      const roles = this.teamRoleData(updatedTeam);
      this._reportMembers = [];
      this.updateLocalTeamCache(roles.teamInfo);
      this.setData({ ...roles, teamMembers: this.profileMembers(updatedTeam.members, roles.teamInfo),
        report: null, overview: null, historySummary: null, todayMembers: [], historyMembers: [], settingsOpen: false });
      if (this._isVisible) wx.showToast({ title: role === 'leader' ? '已交接团长' : isDeputy ? '已设为副团长' : '已取消副团长', icon: 'success' });
    } catch (error) {
      if (isCurrent() && this._isVisible) wx.showModal({ title: `${title}失败`, content: error.message || '请稍后重试', showCancel: false });
    } finally {
      this._rolePrompt = false;
      if (!this._unloaded) this.setData({ roleChangingMemberId: '' });
      if (!this._unloaded && this._isVisible && (changed || attempted || !isCurrent())) await this.loadTeamData();
      else if (isCurrent() && this.data.report) this.scheduleReset(this.data.report.nextResetAt);
    }
  },

  async confirmRemoveMember(event) {
    if (!this.canManageTeam() || !this._isVisible || this._unloaded || this._removePrompt || this._rolePrompt ||
        this.data.isLoading || this.data.isSaving || this.data.isDeleting) return;
    const memberOpenid = event && event.currentTarget && event.currentTarget.dataset.memberOpenid;
    const member = this.data.teamMembers.find(item => item.openid === memberOpenid);
    const teamId = this.data.teamId;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const visibilityVersion = this._editVisibilityVersion || 0;
    if (!member || memberOpenid === openid || member.isCreator) return;
    this._removePrompt = true;
    let removed = false;
    const isCurrent = () => !this._unloaded && this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    try {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '移除成员', content: `确定将「${member.nickname}」移出团队吗？对方的个人练习记录会保留。`,
        confirmText: '移除', confirmColor: '#a4594e', cancelText: '取消',
        success: result => resolve(result.confirm), fail: () => resolve(false)
      }));
      if (!confirmed || !isCurrent() || !this._isVisible || visibilityVersion !== (this._editVisibilityVersion || 0) ||
          !this.canManageTeam() || this.data.isSaving || this.data.isDeleting) return;
      this._loadVersion = (this._loadVersion || 0) + 1;
      this.clearResetTimer();
      this.setData({ removingMemberId: memberOpenid, isLoading: false });
      const result = await teamManager.removeTeamMember(teamId, memberOpenid);
      if (!result || !result.success) throw new Error(result && result.error || '移除失败，请重试');
      if (!isCurrent()) return;
      removed = true;
      // 云端已确认移除，立即清除旧统计，避免刷新失败时继续显示该成员。
      this._reportMembers = [];
      const teamMembers = this.data.teamMembers.filter(item => item.openid !== memberOpenid);
      const roles = this.teamRoleData({ ...this.data.teamInfo, members: teamMembers, memberCount: teamMembers.length });
      this.setData({ ...roles, teamMembers,
        report: null, overview: null, historySummary: null, todayMembers: [], historyMembers: [] });
      wx.showToast({ title: '已移除成员', icon: 'success' });
    } catch (error) {
      if (isCurrent()) wx.showModal({ title: '移除失败', content: error.message || '请稍后重试', showCancel: false });
    } finally {
      this._removePrompt = false;
      if (!this._unloaded) this.setData({ removingMemberId: '' });
      if (removed && isCurrent() && this._isVisible) await this.loadTeamData();
      else if (!this._unloaded && !isCurrent() && this._isVisible) await this.loadTeamData();
      else if (isCurrent()) {
        if (this.data.report) this.scheduleReset(this.data.report.nextResetAt);
        // 移除期间切换到记录页会暂缓统计请求，失败后也要恢复加载。
        if (this._isVisible && this.data.currentTab === 'records') await this.loadTeamReport();
      }
    }
  },

  async saveSettings() {
    if (!this.canManageTeam() || this.data.isSaving || this.data.isDeleting || this.data.isChoosingIcon || this._unloaded) return;
    const practiceStartDate = this.data.draftPracticeRulesEnabled ? this.data.draftStartDate || null : null;
    const goalInput = !this.data.draftPracticeRulesEnabled || this.data.draftGoalMinutes == null ? '' : String(this.data.draftGoalMinutes).trim();
    const dailyGoalMinutes = goalInput === '' ? null : Number(goalInput);
    const name = this.data.draftName.trim();
    const description = this.data.draftDescription.trim();
    const icon = this.data.draftIcon;
    if (!name || name.length > 20) {
      this.setData({ settingsError: '团队名称须为 1–20 个字符' });
      return;
    }
    if (description.length > 100) {
      this.setData({ settingsError: '团队介绍不能超过 100 个字符' });
      return;
    }
    if (typeof icon !== 'string' || !icon || /^(wxfile:|https?:\/\/tmp\/|\/tmp\/)/.test(icon)) {
      this.setData({ settingsError: '请选择已上传的团队头像' });
      return;
    }
    if (practiceStartDate !== null && (!validDate(practiceStartDate) || practiceStartDate > currentPracticeDate())) {
      this.showDraftPracticeError(this.data.draftPracticeType, '请选择不晚于当前练习日的起始日期');
      return;
    }
    if (dailyGoalMinutes !== null && (!/^\d+$/.test(goalInput) || !Number.isInteger(dailyGoalMinutes) || dailyGoalMinutes < 1 || dailyGoalMinutes > maxGoal(this.data.draftPracticeType || this.data.teamInfo.practiceType))) {
      this.showDraftPracticeError(this.data.draftPracticeType, `每日目标请输入 1–${maxGoal(this.data.draftPracticeType || this.data.teamInfo.practiceType)} 之间的整数${this.data.draftUnit || this.data.practiceUnit}`);
      return;
    }
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const teamId = this.data.teamInfo._id;
    const teamData = { name, description, icon, practiceStartDate, dailyGoalMinutes };
    if (isDataTeam(teamId)) {
      const drafts = this.currentDraftPractices();
      const practices = [];
      for (const item of drafts) {
        const start = item.rulesEnabled === false ? null : item.practiceStartDate || null;
        const raw = item.rulesEnabled === false || item.dailyGoalMinutes == null ? '' : String(item.dailyGoalMinutes).trim();
        const goal = raw === '' ? null : Number(raw);
        if (start !== null && (!validDate(start) || start > currentPracticeDate()) ||
            goal !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(goal) || goal < 1 || goal > maxGoal(item.practiceType))) {
          this.showDraftPracticeError(item.practiceType, `请检查${practiceConfig(item.practiceType).name}的起始日期和目标`);
          return;
        }
        practices.push({ practiceType: item.practiceType, practiceStartDate: start, dailyGoalMinutes: goal });
      }
      teamData.practices = practices;
      teamData.practiceStartDate = practices[0].practiceStartDate;
      teamData.dailyGoalMinutes = practices[0].dailyGoalMinutes;
    }
    const visibilityVersion = this._editVisibilityVersion || 0;
    const isCurrent = () => !this._unloaded && this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey && this.canManageTeam();
    const canSubmit = () => isCurrent() && visibilityVersion === (this._editVisibilityVersion || 0);
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.clearResetTimer();
    this.resetInvitation({ keepPrepared: true });
    this.setData({ isSaving: true, isLoading: false, settingsError: '' });
    try {
      if (!await contentSec.checkText(name, 2)) return;
      if (!canSubmit()) return;
      if (!await contentSec.checkText(description, 2)) return;
      if (!canSubmit()) return;
      await this.callTeam('updateTeam', { teamId, teamData, expectedVersion: this.data.teamInfo.version });
      if (!isCurrent()) return;
      const team = { ...this.data.teamInfo, ...teamData };
      this.updateLocalTeamCache(team);
      this.setData({ teamInfo: team, settingsOpen: false, keyboardHeight: 0, settingsScrollTarget: '', isSaving: false, report: null, historySummary: null });
      wx.setNavigationBarTitle({ title: name });
      wx.showToast({ title: '团队已更新', icon: 'success' });
      await this.loadTeamData();
    } catch (error) {
      if (isCurrent()) {
        this.setData({ settingsError: error.message || '保存失败，请重试' });
        if (this.data.report) this.scheduleReset(this.data.report.nextResetAt);
      }
    } finally {
      if (!this._unloaded) {
        this.setData({ isSaving: false });
        if (isCurrent() && this.data.report) this.scheduleReset(this.data.report.nextResetAt);
        if (isCurrent() && this._isVisible && !this.data.report && !this.data.reportError &&
            (!this._teamInfoReady || this.data.currentTab === 'records')) await this.loadTeamData();
        if ((wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey) && this._isVisible) this.loadTeamData();
      }
    }
  },

  resetInvitation({ keepPrepared = false, keepDialog = false } = {}) {
    this._inviteVersion = (this._inviteVersion || 0) + 1;
    // 暂停分享时保留有效邀请；页面重新验证团队及邀请权限后才能恢复使用。
    if (!keepPrepared) this._preparedInvite = null;
    if (this._inviteExpiryTimer) clearTimeout(this._inviteExpiryTimer);
    this._inviteExpiryTimer = null;
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    if (!this._unloaded) this.setData({ isPreparingInvite: false, inviteReady: false, inviteError: '',
      inviteDialogOpen: keepDialog && this.data.inviteDialogOpen, inviteExpiresLabel: '' });
  },

  closeInviteDialog() {
    this.resetInvitation({ keepPrepared: true });
  },

  noop() {},

  canInviteTeam() {
    return this.canAssistTeam() && this.data.isMember && this._isVisible && !this._unloaded &&
      this._teamInfoReady && !this.data.isSaving && !this.data.isDeleting && !this.data.removingMemberId && !this.data.roleChangingMemberId &&
      this._viewerTeamId === this.data.teamId && this.data.teamInfo._id === this.data.teamId;
  },

  async prepareInvite() {
    if (!this.canInviteTeam() || this.data.isPreparingInvite) return;
    const prepared = this._preparedInvite;
    const canReuse = prepared && prepared.teamId === this.data.teamId &&
      prepared.openid === wx.getStorageSync('userOpenId') && prepared.viewerKey === getViewerKey(this.data.teamId) && prepared.expireTime > Date.now();
    this.resetInvitation({ keepDialog: true });
    const version = this._inviteVersion;
    const teamId = this.data.teamId;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const isCurrent = () => version === this._inviteVersion && this.canInviteTeam() &&
      this.data.teamId === teamId && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey;
    this.setData({ isPreparingInvite: true });
    try {
      if (canReuse) {
        // 返回页面或重新打开弹窗时，缓存的身份和邀请都可能已被团长撤销。
        const team = await this.callTeam('getTeamInfo', { teamId });
        if (!isCurrent()) return;
        if (!team || team._id !== teamId) throw new Error('团队信息已变化');
        const isMember = team.isActive !== false && (typeof team.isMember === 'boolean' ? team.isMember :
          team.creator === openid || (team.members || []).some(member => (typeof member === 'string' ? member : member.openid) === openid));
        const roles = this.teamRoleData(team);
        this.setData({ ...roles, isMember,
          teamMembers: this.profileMembers(team.members || [], team) });
        if (!isMember || (!roles.isCreator && !roles.isDeputy)) {
          this.resetInvitation();
          this._teamInfoReady = false;
          this.setData({ isCreator: false, isDeputy: false, inviteError: '团队或邀请权限已变化，请刷新团队后重试' });
          wx.showToast({ title: '邀请权限已变化，请刷新团队', icon: 'none' });
          return;
        }
        this.updateLocalTeamCache(team);
      }
      const invite = canReuse ? prepared : await this.callTeam('generateInvite', {
        teamId, inviterName: wx.getStorageSync('userNickname') || ''
      });
      if (!isCurrent()) return;
      const prefix = '/subpackages/team/pages/joinTeam/joinTeam?';
      if (!invite || !invite.inviteId || typeof invite.sharePath !== 'string' || !invite.sharePath.startsWith(prefix) ||
          !Number.isFinite(invite.expireTime) || invite.expireTime <= Date.now()) throw new Error('邀请信息无效，请重新生成');
      const params = Object.create(null);
      for (const part of invite.sharePath.slice(prefix.length).split('&')) {
        const separator = part.indexOf('=');
        const key = decodeURIComponent(part.slice(0, separator));
        if (separator < 1 || Object.prototype.hasOwnProperty.call(params, key)) throw new Error('邀请信息无效，请重新生成');
        params[key] = decodeURIComponent(part.slice(separator + 1));
      }
      if (params.teamId !== teamId || params.inviterId !== openid || params.inviteId !== invite.inviteId) throw new Error('邀请信息无效，请重新生成');
      this._preparedInvite = { ...invite, teamId, openid, viewerKey };
      const expires = new Date(invite.expireTime);
      const pad = value => String(value).padStart(2, '0');
      const inviteExpiresLabel = `${expires.getFullYear()}.${pad(expires.getMonth() + 1)}.${pad(expires.getDate())} ${pad(expires.getHours())}:${pad(expires.getMinutes())}`;
      this.setData({ inviteReady: true, inviteError: '', inviteDialogOpen: true, inviteExpiresLabel });
      if (typeof wx.showShareMenu === 'function') wx.showShareMenu({ menus: ['shareAppMessage'] });
      this._inviteExpiryTimer = setTimeout(() => {
        if (!isCurrent()) return;
        this.resetInvitation({ keepDialog: true });
        this.setData({ inviteError: '邀请已过期，请重新生成' });
      }, Math.min(invite.expireTime - Date.now(), 2147483647));
    } catch (error) {
      if (isCurrent()) {
        if (canReuse) {
          this.resetInvitation();
          this._teamInfoReady = false;
          this.setData({ inviteError: `${error.message || '邀请权限暂时无法确认'}，请刷新团队后重试` });
        } else this.setData({ inviteReady: false, inviteError: error.message || '邀请准备失败，请重试' });
      }
    } finally {
      if (!this._unloaded && version === this._inviteVersion) {
        if (!this.canInviteTeam()) this.resetInvitation();
        else this.setData({ isPreparingInvite: false });
      }
    }
  },

  onShareAppMessage() {
    const invite = this._preparedInvite;
    if (!this.canInviteTeam() || !this.data.inviteReady || !invite ||
        invite.teamId !== this.data.teamId || invite.openid !== wx.getStorageSync('userOpenId') || invite.viewerKey !== getViewerKey(this.data.teamId) || invite.expireTime <= Date.now()) {
      this.resetInvitation({ keepDialog: this.canInviteTeam() });
      if (this.data.inviteDialogOpen) this.setData({ inviteError: '邀请已失效，请重新生成' });
      return { title: '一起做功课，让坚持有伴', path: '/pages/team/team' };
    }
    const path = '/subpackages/team/pages/joinTeam/joinTeam?' +
      `teamId=${encodeURIComponent(invite.teamId)}&teamName=${encodeURIComponent(this.data.teamInfo.name)}` +
      `&inviterId=${encodeURIComponent(invite.openid)}&inviteId=${encodeURIComponent(invite.inviteId)}`;
    return { title: `邀请您加入${this.data.teamInfo.name}团队`,
      imageUrl: this.data.teamInfo.icon || '/images/icons/team.png', path };
  },

  async confirmDeleteTeam() {
    if (!this.canManageTeam() || this._deletePrompt || this.data.isDeleting || this.data.isSaving) return;
    this._deletePrompt = true;
    try {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '解散团队', content: '确定要解散这个团队吗？解散后，成员将无法再进入团队，个人功课记录会保留。此操作不可撤销。',
        confirmText: '解散', confirmColor: '#a4594e', cancelText: '取消',
        success: result => resolve(result.confirm), fail: () => resolve(false)
      }));
      if (confirmed) await this.deleteTeam();
    } finally { this._deletePrompt = false; }
  },

  async deleteTeam() {
    if (!this.canManageTeam() || this.data.isDeleting || this.data.isSaving) return;
    const openid = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.resetInvitation();
    this.clearResetTimer();
    this.setData({ isDeleting: true, isLoading: false });
    wx.showLoading({ title: '解散中...', mask: true });
    try {
      const result = await teamManager.deleteTeam(this.data.teamInfo._id);
      if (!result || !result.success) throw new Error(result && result.error || '解散失败，请重试');
      if (this._unloaded || (wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey)) return;
      this.setData({ teamInfo: null, report: null, historySummary: null, isCreator: false, isDeputy: false, deputyCount: 0, isMember: false, settingsOpen: false });
      wx.showToast({ title: '团队解散成功', icon: 'success' });
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/team/team' }) });
    } catch (error) {
      if (!this._unloaded && wx.getStorageSync('userOpenId') === openid && getViewerKey(this.data.teamId) === viewerKey) {
        wx.showModal({ title: '解散失败', content: error.message || '请稍后重试', showCancel: false });
        if (this.data.report) this.scheduleReset(this.data.report.nextResetAt);
      }
    } finally {
      wx.hideLoading();
      if (!this._unloaded) {
        this.setData({ isDeleting: false });
        if ((wx.getStorageSync('userOpenId') !== openid || getViewerKey(this.data.teamId) !== viewerKey) && this._isVisible) this.loadTeamData();
      }
    }
  },

  goToTeamList() {
    wx.switchTab({ url: '/pages/team/team' });
  },
  updateDraftDisplay(values = {}) {
    this.setData(values);
    const list = this.currentDraftPractices();
    this.setData({ draftPractices: list, draftPracticeCards: practiceCards(list, '启用日起'),
      draftSelectionOptions: selectionOptions(list, this.data.draftLockedPracticeTypes) });
  },

  canViewDraftPractices() {
    return !this._unloaded && this.data.settingsOpen && this.data.isMember && this.data.teamInfo && this.data.teamInfo._id === this.data.teamId && Boolean(this._viewerOpenid) &&
      this._viewerTeamId === this.data.teamId && this._viewerOpenid === wx.getStorageSync('userOpenId') &&
      this._viewerKey === getViewerKey(this.data.teamId);
  },

  toggleDraftPractice(event) {
    if (!this.canManageTeam() || !this.data.settingsOpen || this.data.isSaving || this.data.isDeleting || this._unloaded || !isDataTeam(this.data.teamId)) return;
    const type = event.currentTarget.dataset.type;
    if (!PRACTICES.some(item => item.type === type)) return;
    if (this.data.draftLockedPracticeTypes.includes(type)) {
      this.setData({ settingsError: '已开启的功课暂不支持取消，可调整目标和起始日期' }); return;
    }
    const list = this.currentDraftPractices();
    const index = list.findIndex(item => item.practiceType === type);
    this._draftPracticeCache = this._draftPracticeCache || {};
    if (index >= 0) {
      this._draftPracticeCache[type] = { ...list[index] };
      list.splice(index, 1);
      const active = this.data.draftPracticeType === type ? Math.min(index, list.length - 1) : list.findIndex(item => item.practiceType === this.data.draftPracticeType);
      this.applyDraftPractice(list, active);
    } else {
      list.push(practiceDraft(this._draftPracticeCache[type] || { practiceType: type, practiceStartDate: currentPracticeDate(), rulesEnabled: true }));
      this.applyDraftPractice(list, list.length - 1);
    }
  },

  isDraftRuleEventCurrent(event) {
    const type = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.type;
    return !type || type === this.data.draftPracticeType;
  },

  showDraftPracticeError(type, message) {
    const list = this.currentDraftPractices();
    const index = list.findIndex(item => item.practiceType === type);
    if (index >= 0) this.applyDraftPractice(list, index);
    this.setData({ settingsError: message, settingsScrollTarget: `practice-rule-${type}` });
  },

});
