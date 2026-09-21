const checkinManager = require('../../utils/checkin.js');
const homeCheckin = require('../../utils/homeCheckin.js');
const dateUtil = require('../../utils/dateUtil.js');
const memberHistory = require('../../utils/memberHistory.js');

function isValidMonth(month) {
  return typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)
    && homeCheckin.isValidDateKey(`${month}-01`);
}

Page({
  data: {
    checkinTotal: 0,
    selectedMonth: '',
    selectedMonthLabel: '',
    currentDate: '',
    currentMonth: '',
    monthDays: [],
    monthCount: 0,
    monthDuration: 0,
    monthDayCount: 0,
    canGoNext: false,
    canGoPrevious: true,
    isMemberHistory: false,
    checkinDeleting: false,
    deletingCheckinId: ''
  },

  onLoad(options = {}) {
    this.setData(memberHistory.initialData(options));
    const today = homeCheckin.getCheckinDay();
    const currentMonth = today.slice(0, 7);
    const date = homeCheckin.isValidDateKey(options.date) && options.date <= today ? options.date : '';
    this._preferredDate = date;
    const requestedMonth = isValidMonth(options.month) ? options.month : date.slice(0, 7);
    this.showSelectedMonth(requestedMonth && requestedMonth <= currentMonth ? requestedMonth : currentMonth);
  },

  onShow() {
    this._unloaded = false;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = dateUtil.watchBusinessDate(() => {
      this.showSelectedMonth(this.data.selectedMonth);
    });
    this.showSelectedMonth(this.data.selectedMonth);
    if (this.data.isMemberHistory) return this.refreshCheckinsFromCloud();
    this.refreshCheckinRecords();
    return this.refreshCheckinsFromCloud();
  },

  onHide() {
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
  },

  onUnload() {
    this.onHide();
    this._unloaded = true;
  },

  refreshCheckinRecords() {
    if (this._unloaded) return false;
    try {
      const records = this.data.isMemberHistory ? (this._memberRecords || []) : homeCheckin.readCheckinRecords(
        checkinManager,
        wx.getStorageSync('meditationTextRecords') || [],
        { openid: wx.getStorageSync('userOpenId') || '' }
      );
      const months = homeCheckin.buildCheckinMonths(records);
      this._allCheckinRecords = records;
      this._allCheckinMonths = months;
      this.showSelectedMonth(this.data.selectedMonth);
      return true;
    } catch (error) {
      console.warn('月度打卡记录读取失败:', error);
      return false;
    }
  },

  showSelectedMonth(requestedMonth) {
    const currentDate = homeCheckin.getCheckinDay();
    const currentMonth = currentDate.slice(0, 7);
    let selectedMonth = isValidMonth(requestedMonth) && requestedMonth <= currentMonth
      ? requestedMonth : currentMonth;
    const startMonth = this.data.memberStartDate ? this.data.memberStartDate.slice(0, 7) : '';
    if (startMonth && selectedMonth < startMonth) selectedMonth = startMonth;
    const month = (this._allCheckinMonths || []).find(item => item.month === selectedMonth);
    const [year, monthNumber] = selectedMonth.split('-');
    this.setData({
      checkinTotal: (this._allCheckinRecords || []).length,
      selectedMonth,
      selectedMonthLabel: `${year}年${Number(monthNumber)}月`,
      currentDate,
      currentMonth,
      monthDays: month ? month.days : [],
      monthCount: month ? month.count : 0,
      monthDuration: month ? month.totalDuration : 0,
      monthDayCount: month ? month.days.length : 0,
      canGoNext: selectedMonth < currentMonth,
      canGoPrevious: !startMonth || selectedMonth > startMonth
    });
  },

  selectMonth(month) {
    if (this._unloaded || this.data.checkinDeleting || !isValidMonth(month) || month > homeCheckin.getCheckinDay().slice(0, 7)) return;
    if (this.data.memberStartDate && month < this.data.memberStartDate.slice(0, 7)) return;
    this.showSelectedMonth(month);
  },

  previousMonth() {
    this.selectMonth(homeCheckin.shiftCheckinMonth(this.data.selectedMonth, -1));
  },

  nextMonth() {
    this.selectMonth(homeCheckin.shiftCheckinMonth(this.data.selectedMonth, 1));
  },

  changeMonth(e) {
    this.selectMonth(e.detail.value);
  },

  goToCurrentMonth() {
    this.selectMonth(homeCheckin.getCheckinDay().slice(0, 7));
  },

  openDailyView() {
    if (this._unloaded || this.data.checkinDeleting) return;
    const today = homeCheckin.getCheckinDay();
    const month = this.data.selectedMonth;
    let date;
    if (this._preferredDate && this._preferredDate.slice(0, 7) === month && this._preferredDate <= today) {
      date = this._preferredDate;
    } else if (month === today.slice(0, 7)) {
      date = today;
    } else {
      date = this.data.monthDays.length ? this.data.monthDays[0].date : `${month}-01`;
    }
    if (this.data.memberStartDate && date < this.data.memberStartDate) date = this.data.memberStartDate;
    if (homeCheckin.isValidDateKey(date) && date <= today) {
      wx.redirectTo({ url: `/pages/history/history?date=${date}${memberHistory.query(this.data)}` });
    }
  },

  refreshCheckinsFromCloud() {
    if (this.data.isMemberHistory) return memberHistory.load(this, () => this.refreshCheckinRecords());
    if (this._checkinCloudRefresh) return this._checkinCloudRefresh;

    this._checkinCloudRefresh = Promise.resolve()
      .then(() => checkinManager.refreshFromCloud())
      .then(refreshed => {
        if (refreshed && !this._unloaded) this.refreshCheckinRecords();
        return refreshed;
      })
      .catch(error => {
        console.warn('全部打卡云端记录刷新失败:', error);
        return false;
      })
      .finally(() => {
        this._checkinCloudRefresh = null;
      });
    return this._checkinCloudRefresh;
  },

  async onPullDownRefresh() {
    try {
      this.refreshCheckinRecords();
      await this.refreshCheckinsFromCloud();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  openCheckinHistory(e) {
    if (this._unloaded || this.data.checkinDeleting) return;
    const date = e.currentTarget.dataset.date;
    if (homeCheckin.isValidDateKey(date) && date <= homeCheckin.getCheckinDay()) {
      wx.navigateTo({ url: `/pages/history/history?date=${date}${memberHistory.query(this.data)}` });
    }
  },

  async deleteCheckinRecord(e) {
    if (this.data.isMemberHistory || this._unloaded || this.data.checkinDeleting) return;
    const record = (this._allCheckinRecords || []).find(item => item.id === e.currentTarget.dataset.id
      && (item.dayDate || item.date).slice(0, 7) === this.data.selectedMonth);
    if (!record) return;

    this.setData({ checkinDeleting: true });
    try {
      // 菜单取消或打开失败均保持原记录，选择删除后才显示二次确认。
      const action = await new Promise(resolve => {
        const menu = wx.showActionSheet({
          itemList: ['删除记录'],
          itemColor: '#b45245',
          success: resolve,
          fail: () => resolve(null)
        });
        if (menu && typeof menu.then === 'function') menu.then(resolve, () => resolve(null));
      });
      if (this._unloaded || !action || action.tapIndex !== 0) return;

      const confirmation = await new Promise((resolve, reject) => {
        const modal = wx.showModal({
          title: '删除静坐记录',
          content: `确定删除 ${record.dayDate} ${record.timeLabel} 的 ${record.duration} 分钟静坐记录吗？\n删除后无法恢复。`,
          confirmText: '删除',
          confirmColor: '#b45245',
          cancelText: '取消',
          success: resolve,
          fail: reject
        });
        if (modal && typeof modal.then === 'function') modal.then(resolve, reject);
      });
      if (this._unloaded || !confirmation.confirm) return;

      this.setData({ deletingCheckinId: record.id });
      const result = await checkinManager.deleteCheckin(record.date, {
        recordId: record._id,
        localId: record.localId,
        timestamp: record.timestamp
      });
      if (this._unloaded) return;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '删除失败，请重试', icon: 'none' });
        return;
      }

      this.refreshCheckinRecords();
      wx.showToast({ title: '记录已删除', icon: 'success' });
    } catch (error) {
      console.error('全部打卡删除静坐记录失败:', error);
      if (!this._unloaded) wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      if (!this._unloaded) this.setData({ checkinDeleting: false, deletingCheckinId: '' });
    }
  }
});
