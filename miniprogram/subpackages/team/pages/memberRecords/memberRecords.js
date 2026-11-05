const { callTeam, getViewerKey } = require('../../../../utils/teamGateway.js');
const { getBusinessDate } = require('../../../../utils/dateUtil.js');
const { PRACTICES } = require('../../../../utils/practicePreferences.js');

function decode(value) {
  try { return decodeURIComponent(value || ''); } catch (_) { return ''; }
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validMonth(value) { return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function displayValue(value) { return (Math.floor((value + Number.EPSILON * Math.max(1, value)) * 100) / 100).toString(); }

Page({
  data: {
    teamId: '', practiceType: '', memberOpenid: '', memberName: '团队成员', memberAvatar: '/images/avatar.png',
    mode: 'month', date: '', month: '', today: '', todayMonth: '', startDate: '', startMonth: '',
    practiceTypeName: '', unit: '分钟', records: [], totalValueLabel: '0',
    nextCursor: null, hasLoaded: false, isLoading: false, isLoadingMore: false, loadError: '', moreError: ''
  },

  onLoad(options = {}) {
    const today = getBusinessDate(Date.now());
    const date = decode(options.date);
    const month = decode(options.month);
    this.setData({ teamId: decode(options.teamId), practiceType: PRACTICES.some(item => item.type === options.practiceType) ? options.practiceType : '', memberOpenid: decode(options.memberOpenid),
      memberName: decode(options.memberName) || '团队成员', today, todayMonth: today.slice(0, 7),
      mode: validDate(date) ? 'day' : 'month', date: validDate(date) && date <= today ? date : today,
      month: validMonth(month) && month <= today.slice(0, 7) ? month : today.slice(0, 7) });
  },

  onShow() {
    this._visible = true;
    if (!this.data.hasLoaded || this._viewer !== wx.getStorageSync('userOpenId') ||
        this._viewerKey !== getViewerKey(this.data.teamId) || this.data.today !== getBusinessDate(Date.now())) {
      this._version = (this._version || 0) + 1;
      this.setData({ isLoading: false, isLoadingMore: false });
      const today = getBusinessDate(Date.now());
      this.setData({ today, todayMonth: today.slice(0, 7) });
      return this.loadRecords();
    }
  },
  onHide() {
    this._visible = false;
    this._version = (this._version || 0) + 1;
    this.setData({ isLoading: false, isLoadingMore: false });
  },
  onUnload() { this._unloaded = true; this.onHide(); },
  async onPullDownRefresh() {
    try { await this.loadRecords(); } finally { wx.stopPullDownRefresh(); }
  },
  onReachBottom() { return this.loadMore(); },

  synchronizeViewer() {
    const viewer = wx.getStorageSync('userOpenId');
    const viewerKey = getViewerKey(this.data.teamId);
    const changed = this._viewer !== viewer || this._viewerKey !== viewerKey;
    if (changed) {
      this._viewer = viewer;
      this._viewerKey = viewerKey;
      this._version = (this._version || 0) + 1;
      this.setData({ records: [], nextCursor: null, hasLoaded: false, totalValueLabel: '0',
        memberName: '团队成员', memberAvatar: '/images/avatar.png', startDate: '', startMonth: '',
        practiceTypeName: '', unit: '分钟', isLoading: false, isLoadingMore: false, loadError: '', moreError: '' });
    }
    return { viewer, viewerKey, changed };
  },

  async loadRecords(append = false) {
    if (!this._visible || this._unloaded) return;
    const { viewer, viewerKey, changed } = this.synchronizeViewer();
    if (this.data.isLoading || this.data.isLoadingMore) return;
    if (!viewer || !this.data.teamId || !this.data.memberOpenid) {
      this.setData({ records: [], hasLoaded: false, loadError: !viewer ? '请先登录后查看成员记录' : '成员链接不完整，请返回团队重新打开' });
      return;
    }
    if (changed) append = false;
    if (append && !this.data.nextCursor) return;
    const version = this._version = (this._version || 0) + 1;
    this._viewer = viewer;
    const { teamId, memberOpenid, date, month, mode } = this.data;
    const cursor = append ? this.data.nextCursor : null;
    const current = () => !this._unloaded && this._visible && this._version === version &&
      viewer === wx.getStorageSync('userOpenId') && viewerKey === getViewerKey(teamId);
    this.setData(append ? { isLoadingMore: true, moreError: '' } : {
      isLoading: true, loadError: '', moreError: '', records: [], totalValueLabel: '0', hasLoaded: false, nextCursor: null
    });
    try {
      const response = await callTeam('getTeamMemberPracticeRecords',
        { teamId, memberOpenid, ...(this.data.practiceType ? { practiceType: this.data.practiceType } : {}), ...(mode === 'day' ? { date } : { month }), ...(cursor ? { cursor } : {}), limit: 100 });
      if (!current()) return;
      const result = response && response.result;
      if (!result || !result.success) throw new Error(result && result.error || '成员记录暂时无法加载');
      const data = result.data;
      if (!data || !data.member || data.member.openid !== memberOpenid || this.data.practiceType && data.practiceType !== this.data.practiceType || !Array.isArray(data.records) ||
          data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor.trim()) ||
          cursor && data.nextCursor === cursor) throw new Error('成员记录暂不完整，请重试');
      const seen = new Set();
      const records = (append ? this.data.records : []).concat(data.records.map(record => {
        const value = record.value === undefined ? record.duration : record.value;
        const id = record._id;
        if (typeof id !== 'string' || !id || !validDate(record.date) ||
            (mode === 'day' ? record.date !== date : !record.date.startsWith(month + '-')) ||
            typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('成员记录暂不完整，请重试');
        const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Date.parse(record.timestamp);
        const time = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp + 8 * 60 * 60 * 1000) : null;
        return { ...record, value, valueLabel: displayValue(value),
          timeLabel: time ? `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}` : '时间未记录' };
      })).filter(record => { if (seen.has(record._id)) return false; seen.add(record._id); return true; });
      const practice = PRACTICES.find(item => item.type === data.practiceType) || PRACTICES[0];
      this.setData({ records, nextCursor: data.nextCursor, hasLoaded: true, loadError: '', moreError: '',
        unit: practice.unit, practiceTypeName: practice.name, memberName: data.member.nickname || '团队成员',
        memberAvatar: data.member.avatarUrl || '/images/avatar.png', startDate: validDate(data.startDate) ? data.startDate : '',
        startMonth: validDate(data.startDate) ? data.startDate.slice(0, 7) : '',
        totalValueLabel: displayValue(records.reduce((sum, record) => sum + record.value, 0)) });
    } catch (error) {
      if (current() && append && /分页游标无效|团队规则已变更/.test(error.message || '')) {
        // 成员或规则变化会使原游标失效，保留日期范围并按新版本重新加载第一页。
        this._version = (this._version || 0) + 1;
        this.setData({ isLoading: false, isLoadingMore: false, nextCursor: null, records: [],
          totalValueLabel: '0', hasLoaded: false, loadError: '', moreError: '' });
        return this.loadRecords();
      }
      if (current()) this.setData(append ? { moreError: error.message } : { loadError: error.message });
    } finally {
      if (!this._unloaded && this._version === version) {
        this.setData({ isLoading: false, isLoadingMore: false });
        if (viewer !== wx.getStorageSync('userOpenId') || viewerKey !== getViewerKey(teamId)) {
          const accountChanged = viewer !== wx.getStorageSync('userOpenId');
          this.synchronizeViewer();
          this.setData({ loadError: accountChanged ? '登录状态已变更，请重新加载' : '账号或绑定已变化，请重新加载' });
        }
      }
    }
  },

  changeMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!['day', 'month'].includes(mode) || mode === this.data.mode) return;
    this._version = (this._version || 0) + 1;
    this.setData({ mode, isLoading: false, isLoadingMore: false });
    return this.loadRecords();
  },
  changePeriod(event) {
    const value = event.detail.value;
    if (this.data.mode === 'day' ? !validDate(value) || value > this.data.today || this.data.startDate && value < this.data.startDate
      : !validMonth(value) || value > this.data.today.slice(0, 7) || this.data.startDate && value < this.data.startDate.slice(0, 7)) return;
    this._version = (this._version || 0) + 1;
    this.setData({ [this.data.mode === 'day' ? 'date' : 'month']: value, isLoading: false, isLoadingMore: false });
    return this.loadRecords();
  },
  retryLoad() { return this.loadRecords(); },
  loadMore() { return this.loadRecords(true); }
});
