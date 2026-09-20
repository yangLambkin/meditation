const { getBusinessDate, watchBusinessDate } = require('../../../../utils/dateUtil.js');
const FILTERS = ['unmet', 'not_practiced', 'below_goal', 'all'];
const STATUS_LABELS = { not_practiced: '未练习', below_goal: '时长不足', qualified: '已达标', practiced: '已练习' };
const DAY_MS = 24 * 60 * 60 * 1000;

function decodeParameter(value) {
  if (typeof value !== 'string') return '';
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== '0000' &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && validDate(`${value}-01`);
}

function currentPracticeMonth() {
  return getBusinessDate(Date.now()).slice(0, 7);
}

function shiftMonth(month, amount) {
  if (!validMonth(month)) return '';
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const result = date.toISOString().slice(0, 7);
  return validMonth(result) ? result : '';
}

function lastDateOfMonth(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}

function rowKey(item) {
  return `${item.date}:${encodeURIComponent(item.openid)}`;
}

function formatMinutes(value) {
  if (value > 0 && value < 0.01) return '少于0.01';
  // 与团队统计一致：截取小数，避免 19.999 分钟显示为 20 分钟。
  return (Math.floor((value + Number.EPSILON * Math.max(1, value)) * 100) / 100).toString();
}

function reportSignature(report) {
  return JSON.stringify([report.businessDate, report.history.startDate, report.history.endDate,
    report.history.totalDays, report.history.month, report.history.minMonth, report.history.maxMonth,
    report.settings.practiceStartDate, report.settings.effectivePracticeStartDate,
    report.settings.dailyGoalMinutes, report.settings.dayBoundaryHour]);
}

Page({
  data: {
    teamId: '', memberOpenid: '', memberName: '', filter: 'unmet',
    selectedMonth: '', currentMonth: '', minMonth: '', maxMonth: '', monthLabel: '',
    canPreviousMonth: false, canNextMonth: false,
    settings: null, history: null, hasGoal: true, rangeLabel: '', goalLabel: '',
    groups: [], itemCount: 0, nextCursor: null, hasLoaded: false,
    isLoading: false, isLoadingMore: false, loadError: '', moreError: '',
    emptyTitle: '', emptyDescription: ''
  },

  onLoad(options = {}) {
    const teamId = decodeParameter(options.teamId);
    const memberOpenid = decodeParameter(options.memberOpenid);
    this._queryMemberName = memberOpenid ? decodeParameter(options.memberName) || '当前成员' : '';
    this._items = [];
    this.setData({ teamId, memberOpenid, memberName: this._queryMemberName,
      filter: FILTERS.includes(options.filter) ? options.filter : 'unmet' });
    const currentMonth = currentPracticeMonth();
    const month = decodeParameter(options.month);
    this.updateMonthControls({ selectedMonth: validMonth(month) ? month : currentMonth,
      currentMonth, maxMonth: currentMonth });
    if (!teamId) this.setData({ loadError: '团队链接不完整，请从团队重新进入' });
  },

  onShow() {
    this._isVisible = true;
    if (this._stopBusinessDateWatch) this._stopBusinessDateWatch();
    this._stopBusinessDateWatch = watchBusinessDate(date => {
      if (!this._isVisible || this._unloaded) return;
      // 前台跨过 02:00 时，已结束的练习日应立即进入历史统计。
      this.invalidateRequest();
      this.clearDetails(true);
      const currentMonth = date.slice(0, 7);
      this.updateMonthControls({ currentMonth, maxMonth: currentMonth });
      this.loadDetails();
    });
    return this.loadDetails();
  },

  onHide() {
    this._isVisible = false;
    if (this._stopBusinessDateWatch) this._stopBusinessDateWatch();
    this._stopBusinessDateWatch = null;
    this.invalidateRequest();
  },

  onUnload() {
    this._unloaded = true;
    this._isVisible = false;
    if (this._stopBusinessDateWatch) this._stopBusinessDateWatch();
    this._stopBusinessDateWatch = null;
    this._loadVersion = (this._loadVersion || 0) + 1;
    this._items = [];
  },

  async onPullDownRefresh() {
    this.invalidateRequest();
    try { await this.loadDetails(); } finally { wx.stopPullDownRefresh(); }
  },

  onReachBottom() {
    return this.loadMore();
  },

  invalidateRequest() {
    this._loadVersion = (this._loadVersion || 0) + 1;
    this.setData({ isLoading: false, isLoadingMore: false });
  },

  clearDetails(clearMetadata = false) {
    this._items = [];
    this._signature = null;
    const values = { groups: [], itemCount: 0, nextCursor: null, hasLoaded: false,
      loadError: '', moreError: '', emptyTitle: '', emptyDescription: '' };
    if (clearMetadata) Object.assign(values, { settings: null, history: null, rangeLabel: '', goalLabel: '',
      hasGoal: true, memberName: this._queryMemberName });
    this.setData(values);
  },

  updateMonthControls(values = {}) {
    const state = { ...this.data, ...values };
    const selectedMonth = state.selectedMonth;
    this.setData({ ...values,
      monthLabel: validMonth(selectedMonth) ? `${selectedMonth.slice(0, 4)}年${Number(selectedMonth.slice(5))}月` : '',
      canPreviousMonth: !!shiftMonth(selectedMonth, -1) && (!state.minMonth || selectedMonth > state.minMonth),
      canNextMonth: !!shiftMonth(selectedMonth, 1) && (!state.maxMonth || selectedMonth < state.maxMonth)
    });
  },

  synchronizeViewer() {
    const openid = wx.getStorageSync('userOpenId');
    if (this._viewerOpenid !== openid || this._viewerTeamId !== this.data.teamId) {
      this.invalidateRequest();
      this.clearDetails(true);
      const currentMonth = currentPracticeMonth();
      this.updateMonthControls({ currentMonth, minMonth: '', maxMonth: currentMonth });
      this._viewerOpenid = openid;
      this._viewerTeamId = this.data.teamId;
    }
    return openid;
  },

  isCurrentRequest(version, openid, teamId) {
    if (this._unloaded || !this._isVisible || version !== this._loadVersion || teamId !== this.data.teamId) return false;
    if (wx.getStorageSync('userOpenId') !== openid) {
      this.synchronizeViewer();
      return false;
    }
    return true;
  },

  async loadDetails({ append = false } = {}) {
    if (this._unloaded || !this._isVisible || !this.data.teamId) return;
    const openid = this.synchronizeViewer();
    if (!openid) {
      this.setData({ loadError: '请先登录后查看团队历史' });
      return;
    }
    if (this.data.isLoading || this.data.isLoadingMore || (append && !this.data.nextCursor)) return;
    const { teamId, memberOpenid, filter, selectedMonth: month } = this.data;
    const cursor = append ? this.data.nextCursor : null;
    const version = this._loadVersion = (this._loadVersion || 0) + 1;
    if (!append) this.clearDetails();
    this.setData(append ? { isLoadingMore: true, moreError: '' } : { isLoading: true, loadError: '' });
    try {
      const data = { teamId, filter, month, limit: 50 };
      if (memberOpenid) data.memberOpenid = memberOpenid;
      if (cursor) data.cursor = cursor;
      const response = await wx.cloud.callFunction({ name: 'teamManager', data: { type: 'getTeamHistoryDetails', data } });
      if (!this.isCurrentRequest(version, openid, teamId)) return;
      const result = response && response.result;
      if (append && result && !result.success && typeof result.error === 'string' && result.error.includes('分页游标无效')) {
        // 起始日期调整后，旧游标可能已不在本月窗口内；无游标重载即可取得新边界。
        this.invalidateRequest();
        this.clearDetails(true);
        return this.loadDetails();
      }
      if (!result || !result.success) throw new Error(result && result.error || '暂时无法连接，请稍后重试');
      const report = result.data;
      this.validateReport(report, filter, memberOpenid, month);
      if (append && this._signature !== reportSignature(report)) {
        // 规则修改或跨练习日后，从第一页重新获取，避免不同口径混在一起。
        this.invalidateRequest();
        this.clearDetails(true);
        this.updateMonthControls({ selectedMonth: report.history.month, minMonth: report.history.minMonth,
          maxMonth: report.history.maxMonth, currentMonth: report.history.maxMonth });
        return this.loadDetails();
      }
      if (cursor && report.nextCursor && cursor.date === report.nextCursor.date && cursor.memberOpenid === report.nextCursor.memberOpenid) {
        throw new Error('历史明细暂不完整，请重试');
      }
      this.applyReport(report, append);
    } catch (error) {
      if (!this.isCurrentRequest(version, openid, teamId)) return;
      this.setData(append ? { moreError: error.message || '更多明细暂时无法加载' } : { loadError: error.message || '历史明细暂时无法加载' });
    } finally {
      if (this.isCurrentRequest(version, openid, teamId)) this.setData({ isLoading: false, isLoadingMore: false });
    }
  },

  validateReport(report, requestedFilter, memberOpenid, requestedMonth) {
    const fail = () => { throw new Error('历史明细暂不完整，请刷新重试'); };
    if (!report || report.teamId !== this.data.teamId || !validDate(report.businessDate) || !report.settings || !report.history) return fail();
    const { settings, history, filter, items, nextCursor } = report;
    const hasGoal = settings.dailyGoalMinutes !== null;
    const expectedFilter = !hasGoal && ['unmet', 'below_goal'].includes(requestedFilter) ? 'not_practiced' : requestedFilter;
    if (!(settings.practiceStartDate === null ? validDate(settings.effectivePracticeStartDate) : validDate(settings.practiceStartDate)) ||
        !(settings.dailyGoalMinutes === null || Number.isInteger(settings.dailyGoalMinutes) && settings.dailyGoalMinutes > 0 && settings.dailyGoalMinutes <= 1440) ||
        settings.dayBoundaryHour !== 2 || !validDate(history.startDate) || !validDate(history.endDate) ||
        !Number.isInteger(history.totalDays) || history.totalDays < 0 || history.endDate >= report.businessDate ||
        filter !== expectedFilter || !Array.isArray(items)) return fail();
    // 必须由月接口明确返回范围，不能把旧版的全历史结果展示为当月数据。
    const practiceStartDate = settings.effectivePracticeStartDate || settings.practiceStartDate;
    if (!validDate(practiceStartDate) || !validMonth(requestedMonth) || !validMonth(history.month) ||
        !validMonth(history.minMonth) || !validMonth(history.maxMonth) || history.minMonth > history.maxMonth ||
        history.minMonth !== practiceStartDate.slice(0, 7) || history.maxMonth !== report.businessDate.slice(0, 7)) return fail();
    const expectedMonth = requestedMonth < history.minMonth ? history.minMonth :
      requestedMonth > history.maxMonth ? history.maxMonth : requestedMonth;
    const monthStartDate = `${expectedMonth}-01`;
    const monthEndDate = lastDateOfMonth(expectedMonth);
    const yesterday = new Date(Date.parse(`${report.businessDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    const expectedStart = practiceStartDate > monthStartDate ? practiceStartDate : monthStartDate;
    const expectedEnd = yesterday < monthEndDate ? yesterday : monthEndDate;
    const expectedDays = Math.max(0, Math.round((Date.parse(`${expectedEnd}T00:00:00Z`) - Date.parse(`${expectedStart}T00:00:00Z`)) / DAY_MS) + 1);
    if (history.month !== expectedMonth || history.startDate !== expectedStart || history.endDate !== expectedEnd ||
        history.totalDays !== expectedDays) return fail();
    for (const item of items) {
      if (!item || !validDate(item.date) || item.date < history.startDate || item.date > history.endDate ||
          !history.totalDays || typeof item.openid !== 'string' || !item.openid || memberOpenid && item.openid !== memberOpenid ||
          typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes < 0 || !STATUS_LABELS[item.status]) return fail();
      const meetsGoal = hasGoal && (item.minutes >= settings.dailyGoalMinutes ||
        settings.dailyGoalMinutes - item.minutes <= Number.EPSILON * Math.max(1, settings.dailyGoalMinutes) * 4);
      const expectedStatus = item.minutes === 0 ? 'not_practiced' : !hasGoal ? 'practiced' : meetsGoal ? 'qualified' : 'below_goal';
      if (item.status !== expectedStatus || filter !== 'all' && (filter === 'unmet' ? !['not_practiced', 'below_goal'].includes(item.status) : item.status !== filter)) return fail();
    }
    if (nextCursor !== null && (!nextCursor || !validDate(nextCursor.date) || nextCursor.date < history.startDate ||
        nextCursor.date > history.endDate || typeof nextCursor.memberOpenid !== 'string' || !nextCursor.memberOpenid ||
        memberOpenid && nextCursor.memberOpenid !== memberOpenid)) return fail();
  },

  applyReport(report, append) {
    const seen = new Set();
    this._items = (append ? this._items : []).concat(report.items).filter(item => {
      const key = rowKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || (a.openid < b.openid ? -1 : a.openid > b.openid ? 1 : 0));
    const hasGoal = report.settings.dailyGoalMinutes !== null;
    const groups = [];
    this._items.forEach(item => {
      let group = groups[groups.length - 1];
      if (!group || group.date !== item.date) {
        group = { date: item.date, dateLabel: item.date.replace(/-/g, '.'), items: [] };
        groups.push(group);
      }
      group.items.push({ ...item, key: rowKey(item), nickname: item.nickname || '团队成员',
        avatar: typeof item.avatarUrl === 'string' && item.avatarUrl && !/^(wxfile:|https?:\/\/tmp\/)/.test(item.avatarUrl) ? item.avatarUrl : '/images/avatar.png',
        statusLabel: STATUS_LABELS[item.status], minutesLabel: formatMinutes(item.minutes),
        remainingLabel: item.status === 'below_goal' ? formatMinutes(Math.max(0, report.settings.dailyGoalMinutes - item.minutes)) : '' });
    });
    const member = this.data.memberOpenid && this._items.find(item => item.openid === this.data.memberOpenid);
    const memberName = member ? member.nickname || '团队成员' : this.data.memberName;
    const subject = this.data.memberOpenid ? `${memberName}在本月统计日期内` : '本月统计日期内';
    const emptyMessages = {
      unmet: ['本月暂无未达标记录', `${subject}每天均已达标`],
      not_practiced: ['本月暂无未练习记录', `${subject}每天都有练习`],
      below_goal: ['本月暂无时长不足记录', `${subject}没有练习时长不足的日期`],
      all: ['本月暂无历史明细', `${subject}暂无可展示的成员练习明细`]
    };
    const empty = report.history.totalDays ? emptyMessages[report.filter] : ['本月暂无历史日期',
      `${this.data.memberOpenid ? memberName + '的' : ''}本月明细不包含今日，已结束的练习日会显示在这里`];
    this._signature = reportSignature(report);
    this.updateMonthControls({ selectedMonth: report.history.month, minMonth: report.history.minMonth,
      maxMonth: report.history.maxMonth, currentMonth: report.history.maxMonth });
    this.setData({ settings: report.settings, history: report.history, filter: report.filter, hasGoal,
      rangeLabel: `${report.history.startDate.replace(/-/g, '.')} — ${report.history.endDate.replace(/-/g, '.')}`,
      goalLabel: hasGoal ? `每日期望 ${report.settings.dailyGoalMinutes} 分钟，多次练习累计计算` : '未设置期望分钟，按每日是否练习统计',
      memberName, groups, itemCount: this._items.length, nextCursor: report.nextCursor,
      hasLoaded: true, loadError: '', moreError: '', emptyTitle: empty[0], emptyDescription: empty[1] });
  },

  changeFilter(event) {
    const filter = event && event.currentTarget && event.currentTarget.dataset.filter;
    if (this._unloaded || !this._isVisible || !FILTERS.includes(filter)) return;
    this.synchronizeViewer();
    if (this.data.settings && !this.data.hasGoal && ['unmet', 'below_goal'].includes(filter)) return;
    if (filter === this.data.filter) return;
    this.invalidateRequest();
    this.setData({ filter });
    return this.loadDetails();
  },

  selectMonth(month) {
    if (this._unloaded || !this._isVisible || !validMonth(month)) return;
    this.synchronizeViewer();
    if (month === this.data.selectedMonth || this.data.minMonth && month < this.data.minMonth ||
        this.data.maxMonth && month > this.data.maxMonth) return;
    this.invalidateRequest();
    this.updateMonthControls({ selectedMonth: month });
    this.setData({ history: null, rangeLabel: '' });
    return this.loadDetails();
  },

  changeMonth(event) {
    return this.selectMonth(event && event.detail && event.detail.value);
  },

  previousMonth() {
    return this.selectMonth(shiftMonth(this.data.selectedMonth, -1));
  },

  nextMonth() {
    return this.selectMonth(shiftMonth(this.data.selectedMonth, 1));
  },

  goToCurrentMonth() {
    return this.selectMonth(this.data.currentMonth);
  },

  retryLoad() {
    return this.loadDetails();
  },

  loadMore() {
    if (this._unloaded || !this._isVisible) return;
    const previousViewer = this._viewerOpenid;
    const currentViewer = this.synchronizeViewer();
    if (previousViewer !== currentViewer) return this.loadDetails();
    return this.loadDetails({ append: true });
  },

  openDayRecords(event) {
    if (this._unloaded || !this._isVisible || this.data.isLoading || !this.data.hasLoaded) return;
    if (wx.getStorageSync('userOpenId') !== this._viewerOpenid) {
      this.synchronizeViewer();
      return;
    }
    const key = event && event.currentTarget && event.currentTarget.dataset.key;
    const item = this._items.find(row => rowKey(row) === key);
    if (!item) return;
    const query = `teamId=${encodeURIComponent(this.data.teamId)}&memberOpenid=${encodeURIComponent(item.openid)}&memberName=${encodeURIComponent(item.nickname || '团队成员')}&date=${encodeURIComponent(item.date)}`;
    wx.navigateTo({ url: `/pages/history/history?${query}` });
  }
});
