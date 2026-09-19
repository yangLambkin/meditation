const checkinManager = require('../../utils/checkin.js');
const homeCheckin = require('../../utils/homeCheckin.js');
const lunarUtil = require('../../utils/lunar.js');
const memberHistory = require('../../utils/memberHistory.js');

Page({
  data: {
    selectedDate: '',
    selectedDateKey: '', // 北京时间 04:00 切分后的记录日期。
    todayDate: '',
    isToday: false,
    canGoNext: false,
    canGoPrevious: true,
    isMemberHistory: false,
    lunarDate: '',
    recordList: [],
    recordCount: 0,
    totalDuration: 0,
    loadingRecords: true,
    deleteBusy: false,
    deletingRecordKey: ''
  },

  onLoad(options = {}) {
    this._unloaded = false;
    this.setData(memberHistory.initialData(options));
    const today = homeCheckin.getCheckinDay();
    const date = homeCheckin.isValidDateKey(options.date) && options.date <= today ? options.date : today;
    this.updateSelectedDate(date);
  },

  onShow() {
    this._unloaded = false;
    const today = homeCheckin.getCheckinDay();
    const selected = this.data.selectedDateKey;
    this.updateSelectedDate(selected && selected <= today ? selected : today);
    if (this.data.isMemberHistory) return this.refreshCheckinsFromCloud();
    if (this._deleteBusy) return;
    this.loadHistoryRecords();
    return this.refreshCheckinsFromCloud();
  },

  onUnload() {
    this._unloaded = true;
  },

  updateSelectedDate(date) {
    const today = homeCheckin.getCheckinDay();
    if (this.data.memberStartDate && date < this.data.memberStartDate) date = this.data.memberStartDate;
    const [year, month, day] = date.split('-').map(Number);
    const dateChanged = this.data.selectedDateKey !== date;
    this.setData({
      selectedDateKey: date,
      selectedDate: this.formatDateForDisplay(date),
      todayDate: today,
      isToday: date === today,
      canGoNext: date < today,
      canGoPrevious: !this.data.memberStartDate || date > this.data.memberStartDate,
      lunarDate: lunarUtil.getLunarDate(new Date(year, month - 1, day, 12)),
      ...(dateChanged ? { recordList: [], recordCount: 0, totalDuration: 0, loadingRecords: true } : {})
    });
  },

  selectDate(date) {
    if (!homeCheckin.isValidDateKey(date) || date > homeCheckin.getCheckinDay()) return;
    if (this.data.memberStartDate && date < this.data.memberStartDate) return;
    this.updateSelectedDate(date);
    this.loadHistoryRecords();
  },

  onDateChange(event) {
    this.selectDate(event.detail.value);
  },

  previousDay() {
    this.selectDate(homeCheckin.shiftCheckinDate(this.data.selectedDateKey, -1));
  },

  nextDay() {
    this.selectDate(homeCheckin.shiftCheckinDate(this.data.selectedDateKey, 1));
  },

  goToday() {
    this.selectDate(homeCheckin.getCheckinDay());
  },

  openMonthlyHistory() {
    const date = this.data.selectedDateKey;
    wx.redirectTo({ url: `/pages/checkinHistory/checkinHistory?month=${date.slice(0, 7)}&date=${date}${memberHistory.query(this.data)}` });
  },

  // 使用与首页、月记录相同的完整缓存，跨午夜的记录仍归入正确的逻辑日。
  loadHistoryRecords(date = this.data.selectedDateKey) {
    if (this._unloaded || date !== this.data.selectedDateKey) return false;
    try {
      const allRecords = this.data.isMemberHistory ? (this._memberRecords || []) : homeCheckin.readCheckinRecords(
        checkinManager,
        wx.getStorageSync('meditationTextRecords') || []
      );
      const records = allRecords.filter(record => record.dayDate === date).map(record => ({
        ...record,
        recordKey: record.id
      }));
      this.setData({
        recordList: records,
        recordCount: records.length,
        totalDuration: records.reduce((sum, record) => sum + record.duration, 0),
        loadingRecords: this.data.isMemberHistory ? this.data.memberLoading : false
      });
      return true;
    } catch (error) {
      console.warn('读取单日打卡记录失败:', error);
      this.setData({ loadingRecords: false });
      wx.showToast({ title: '加载记录失败，请重试', icon: 'none' });
      return false;
    }
  },

  refreshCheckinsFromCloud() {
    if (this.data.isMemberHistory) {
      return memberHistory.load(this, () => {
        this.updateSelectedDate(this.data.selectedDateKey);
        this.loadHistoryRecords();
      });
    }
    if (this._checkinCloudRefresh) return this._checkinCloudRefresh;
    const mutation = this._historyMutation || 0;
    this._checkinCloudRefresh = Promise.resolve()
      .then(() => checkinManager.refreshFromCloud())
      .then(refreshed => {
        // 网络返回时始终读取当前选择的日期；删除开始前的请求不能覆盖删除后的列表。
        if (refreshed && !this._unloaded && mutation === (this._historyMutation || 0) && !this._deleteBusy) {
          this.loadHistoryRecords();
        }
        return refreshed;
      })
      .catch(error => {
        console.warn('单日打卡云端刷新失败，保留本地记录:', error);
        return false;
      })
      .finally(() => { this._checkinCloudRefresh = null; });
    return this._checkinCloudRefresh;
  },

  async onPullDownRefresh() {
    try {
      if (this._deleteBusy) return;
      this.updateSelectedDate(this.data.selectedDateKey);
      this.loadHistoryRecords();
      await this.refreshCheckinsFromCloud();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async showRecordActions(event) {
    if (this.data.isMemberHistory || this._deleteBusy || this._unloaded) return;
    const recordKey = event.currentTarget.dataset.recordKey;
    const record = this.data.recordList.find(item => item.recordKey === recordKey);
    if (!record) return;

    this._deleteBusy = true;
    this.setData({ deleteBusy: true });
    try {
      const action = await new Promise((resolve, reject) => {
        const result = wx.showActionSheet({
          itemList: ['删除记录'],
          itemColor: '#b45245',
          success: resolve,
          fail: error => /cancel/i.test((error && error.errMsg) || '') ? resolve(null) : reject(error)
        });
        if (result && typeof result.then === 'function') {
          result.then(resolve, error => /cancel/i.test((error && error.errMsg) || '') ? resolve(null) : reject(error));
        }
      });
      if (!action || action.tapIndex !== 0 || this._unloaded) return;

      const confirmation = await new Promise((resolve, reject) => {
        const result = wx.showModal({
          title: '删除静坐记录',
          content: `确定删除 ${record.dayDate} ${record.timeLabel} 的 ${record.duration} 分钟静坐记录吗？删除后不可恢复。`,
          confirmText: '删除',
          confirmColor: '#b45245',
          cancelText: '保留',
          success: resolve,
          fail: reject
        });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      });
      if (!confirmation.confirm || this._unloaded) return;

      this._historyMutation = (this._historyMutation || 0) + 1;
      this.setData({ deletingRecordKey: recordKey });
      const result = await checkinManager.deleteCheckin(record.date, {
        recordId: record._id,
        timestamp: record.timestamp,
        localId: record.localId
      });
      if (this._unloaded) return;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '删除失败，请重试', icon: 'none' });
        return;
      }
      const refreshed = this.loadHistoryRecords();
      wx.showToast({ title: refreshed ? '记录已删除' : '已删除，请下拉刷新', icon: refreshed ? 'success' : 'none' });
    } catch (error) {
      console.warn('删除静坐记录失败:', error);
      if (!this._unloaded) wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      this._deleteBusy = false;
      if (!this._unloaded) this.setData({ deleteBusy: false, deletingRecordKey: '' });
    }
  },

  formatDateForDisplay(date) {
    const [year, month, day] = date.split('-');
    return `${year}年${Number(month)}月${Number(day)}日`;
  },

  onShareAppMessage() {
    return {
      title: `${this.data.isMemberHistory ? this.data.memberName + ' · ' : ''}${this.data.selectedDate} 的静坐打卡记录`,
      path: `/pages/history/history?date=${this.data.selectedDateKey}${memberHistory.query(this.data)}`
    };
  }
});
