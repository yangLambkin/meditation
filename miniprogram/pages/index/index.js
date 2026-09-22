// pages/index/index.js
const checkinManager = require('../../utils/checkin.js');
const contentSec = require('../../utils/contentSec.js');
const homeCheckin = require('../../utils/homeCheckin.js');
const dailyWisdom = require('../../utils/dailyWisdom.js');
const dateUtil = require('../../utils/dateUtil.js');

Page({
  data: {
    currentYear: 2026,
    currentMonth: 1,
    calendarDays: [],
    checkedDates: [], // 存储已打卡的日期
    todayDate: "", // 今天的日期
    userOpenId: '', // 当前用户标识
    userNickname: '觉察者', // 用户昵称，默认为"觉察者"
    wisdomQuote: '"' + dailyWisdom.DEFAULT_QUOTE + '"', // 每日一言金句
    hasUserInfo: false, // 是否已获取用户信息
    checkinDate: '',
    checkinTime: '',
    minCheckinDate: '',
    maxCheckinDate: '',
    checkinDuration: '7',
    checkinExperience: '',
    showCheckinModal: false,
    showCheckinTimePicker: false,
    checkinSubmitting: false,
    checkinRetrying: false,
    pendingCheckinCount: 0,
    showCheckinUploadPreview: false,
    checkinUploadGroups: [],
    checkinUploadCount: 0,
    checkinUploadDuration: 0,
    checkinUploadBlockedRecords: [],
    checkinDeleting: false,
    checkinActionsOpen: false,
    deletingCheckinId: '',
    checkinRecords: [],
    checkinGroups: [],
    checkinTotal: 0,
    hiddenCheckinCount: 0
  },

  openCheckinModal() {
    if (this.data.checkinSubmitting) return;
    this._checkinDateEdited = false;
    this._checkinTimeEdited = false;
    this._checkinSubmissionId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.refreshCheckinDefaults();
    this.setData({
      showCheckinModal: true,
      showCheckinTimePicker: false,
      checkinDuration: '7',
      checkinExperience: ''
    });
  },

  closeCheckinModal() {
    if (this.data.checkinSubmitting) return;
    this.setData({ showCheckinModal: false, showCheckinTimePicker: false });
  },

  preventCheckinModalTouchMove() {},

  refreshCheckinDefaults() {
    const current = homeCheckin.getDateTime();
    const today = homeCheckin.getCheckinDay();
    this.setData({
      minCheckinDate: homeCheckin.shiftCheckinDate(today, -2),
      maxCheckinDate: today,
      checkinDate: this._checkinDateEdited ? this.data.checkinDate : today,
      checkinTime: this._checkinTimeEdited || this.data.showCheckinTimePicker ? this.data.checkinTime : current.time
    });
  },

  onCheckinDateChange(e) {
    this._checkinDateEdited = true;
    this.setData({ checkinDate: e.detail.value });
  },

  openCheckinTimePicker() {
    if (this.data.checkinSubmitting || !this.data.showCheckinModal || this.data.showCheckinTimePicker) return;
    this.refreshCheckinDefaults();
    wx.hideKeyboard();
    this.setData({ showCheckinTimePicker: true });
  },

  closeCheckinTimePicker() {
    this.setData({ showCheckinTimePicker: false });
  },

  onCheckinTimeChange(e) {
    if (this.data.checkinSubmitting) return;
    this._checkinTimeEdited = true;
    this.setData({ checkinTime: e.detail.value, showCheckinTimePicker: false });
  },

  onCheckinDurationInput(e) {
    this.setData({ checkinDuration: e.detail.value });
  },

  onCheckinExperienceInput(e) {
    this.setData({ checkinExperience: e.detail.value });
  },

  async submitCheckin() {
    if (this.data.checkinSubmitting || this.data.showCheckinTimePicker || (this._lastCheckinSubmittedAt && Date.now() - this._lastCheckinSubmittedAt < 1000)) return;
    this.refreshCheckinDefaults();
    const durationText = String(this.data.checkinDuration).trim();
    const duration = Number(durationText);
    if (!/^\d+$/.test(durationText) || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
      wx.showToast({ title: '请输入1至1440分钟的整数时长', icon: 'none' });
      return;
    }

    if (this.data.checkinDate < this.data.minCheckinDate || this.data.checkinDate > this.data.maxCheckinDate) {
      wx.showToast({ title: '只能记录最近三天的静坐（含今天）', icon: 'none' });
      return;
    }
    const selectedTimestamp = homeCheckin.parseDateTime(this.data.checkinDate, this.data.checkinTime);
    if (!Number.isFinite(selectedTimestamp) || selectedTimestamp > Date.now()) {
      wx.showToast({ title: '请选择有效且不晚于当前的时间', icon: 'none' });
      return;
    }
    // 未修改日期时间时保留实际秒数，避免同一分钟内的正常打卡被同步去重。
    const timestamp = this._checkinDateEdited || this._checkinTimeEdited ? selectedTimestamp : Date.now();
    const recordDate = this.data.checkinDate;
    const text = this.data.checkinExperience.trim();
    if (!this._checkinSubmissionId) this._checkinSubmissionId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.setData({ checkinSubmitting: true });
    try {
      if (text && !(await contentSec.checkText(text, 2, { allowOffline: true, timeoutMs: 1500 }))) return;
      const selected = homeCheckin.getDateTime(timestamp);
      const experience = text ? [{
        text,
        uniqueId: this._checkinSubmissionId,
        timestamp: `${selected.date} ${selected.time}:00`,
        duration: `${duration}分钟`,
        emotion: []
      }] : [];
      // 本机保存成功即可完成操作，云端上传及状态更新由记录管理器在后台处理。
      const result = checkinManager.recordCheckin(duration, [], experience, timestamp, {
        idempotencyKey: this._checkinSubmissionId, source: 'manual', date: recordDate
      });
      if (!result || !result.success) throw new Error('本地保存失败');
      this._lastCheckinSubmittedAt = Date.now();
      this._checkinSubmissionId = null;

      this._checkinDateEdited = false;
      this._checkinTimeEdited = false;
      this.setData({ checkinExperience: '', showCheckinModal: false });
      this.refreshCheckinDefaults();
      this.refreshPageData();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) {
      console.error('首页打卡保存失败:', error);
      wx.showToast({ title: '打卡保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ checkinSubmitting: false });
    }
  },

  refreshCheckinRecords() {
    const pendingCheckinCount = checkinManager.getPendingSyncSummary().pending;
    this._allCheckinRecords = homeCheckin.readCheckinRecords(
      checkinManager, wx.getStorageSync('meditationTextRecords') || [], this.getCheckinDisplayOptions()
    );
    const unconfirmedCount = this._allCheckinRecords.filter(record => record.syncStatus === 'unconfirmed').length;
    this.setData({ pendingCheckinCount: pendingCheckinCount + unconfirmedCount });
    this.updateCheckinGroups();
  },

  getCheckinDisplayOptions() {
    const openid = wx.getStorageSync('userOpenId');
    return { openid: typeof openid === 'string' && openid.startsWith('oz') ? openid : '' };
  },

  openCheckinUploadPreview() {
    if (this.data.checkinRetrying || this.data.checkinSubmitting) return;
    this.refreshCheckinRecords();
    const records = (this._allCheckinRecords || []).filter(record =>
      ['unconfirmed', 'pending', 'failed', 'blocked'].includes(record.syncStatus)).map(record => {
      if (record.syncStatus !== 'unconfirmed') return record;
      const timestamp = dateUtil.getRecordTimestamp(record.timestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() ||
          !Number.isInteger(record.duration) || record.duration < 1 || record.duration > 1440) {
        return { ...record, syncStatus: 'blocked', syncError: '记录的时间或时长不完整，无法上传' };
      }
      return record;
    });
    const uploadRecords = records.filter(record => record.syncStatus !== 'blocked');
    const blockedRecords = records.filter(record => record.syncStatus === 'blocked').map(record => ({
      ...record,
      canIgnoreUpload: !record._id && !!record.localId && record.syncErrorCode === 'AMBIGUOUS_RECORD'
    }));
    if (!records.length) {
      wx.showToast({ title: '暂无待上传记录', icon: 'none' });
      return;
    }
    this._checkinUploadAccount = {
      userId: checkinManager.getUserId(), openid: this.getCheckinDisplayOptions().openid
    };
    this._checkinUploadLocalIds = uploadRecords.filter(record => record.syncStatus !== 'unconfirmed')
      .map(record => record.localId);
    this._checkinUploadUnconfirmedRecords = uploadRecords.filter(record => record.syncStatus === 'unconfirmed')
      .map(record => ({ localId: record.localId, timestamp: record.timestamp, duration: record.duration, date: record.dayDate }));
    this.setData({
      showCheckinUploadPreview: true,
      checkinUploadGroups: homeCheckin.buildCheckinGroups(uploadRecords, { showAll: true }).groups,
      checkinUploadCount: uploadRecords.length,
      checkinUploadDuration: uploadRecords.reduce((total, record) => total + record.duration, 0),
      checkinUploadBlockedRecords: blockedRecords
    });
  },

  closeCheckinUploadPreview() {
    if (this.data.checkinRetrying) return;
    this._checkinUploadAccount = null;
    this._checkinUploadLocalIds = null;
    this._checkinUploadUnconfirmedRecords = null;
    this.setData({ showCheckinUploadPreview: false, checkinUploadGroups: [],
      checkinUploadCount: 0, checkinUploadDuration: 0, checkinUploadBlockedRecords: [] });
  },

  ignoreCheckinUpload(e) {
    if (this.data.checkinRetrying || this.data.checkinSubmitting || !this.data.showCheckinUploadPreview) return;
    const account = this._checkinUploadAccount;
    if (!account || account.userId !== checkinManager.getUserId() ||
        account.openid !== this.getCheckinDisplayOptions().openid) {
      this.closeCheckinUploadPreview();
      this.refreshCheckinRecords();
      wx.showToast({ title: '账号已切换，请重新查看待上传记录', icon: 'none' });
      return;
    }
    const localId = e && e.currentTarget && e.currentTarget.dataset.localId;
    const blockedRecords = this.data.checkinUploadBlockedRecords || [];
    const record = blockedRecords.find(item => item.localId === localId);
    if (!localId || !record || record._id || record.syncStatus !== 'blocked' ||
        record.syncErrorCode !== 'AMBIGUOUS_RECORD' || !record.canIgnoreUpload) return;

    let result;
    try {
      result = checkinManager.ignoreAmbiguousUpload({ localId });
    } catch (error) {
      console.error('首页忽略上传失败:', error);
      wx.showToast({ title: '忽略失败，请重试', icon: 'none' });
      return;
    }
    if (!result || !result.success) {
      wx.showToast({ title: result && result.error || '忽略失败，请重试', icon: 'none' });
      return;
    }

    // 只移除本次忽略项，保留用户已经核对的上传选择，不纳入后来新增的记录。
    const remaining = blockedRecords.filter(item => item !== record);
    this.setData({ checkinUploadBlockedRecords: remaining });
    this.refreshCheckinRecords();
    if (!remaining.length && !this.data.checkinUploadCount) this.closeCheckinUploadPreview();
    wx.showToast({ title: '已忽略，记录保留在本机', icon: 'none' });
  },

  async retryCheckinUploads() {
    if (this.data.checkinRetrying || this.data.checkinSubmitting || !this.data.showCheckinUploadPreview) return;
    const account = this._checkinUploadAccount;
    if (!account || account.userId !== checkinManager.getUserId() ||
        account.openid !== this.getCheckinDisplayOptions().openid) {
      this.closeCheckinUploadPreview();
      this.refreshCheckinRecords();
      wx.showToast({ title: '账号已切换，请重新查看待上传记录', icon: 'none' });
      return;
    }
    if (!account.openid) {
      wx.showToast({ title: '请登录后上传本机记录', icon: 'none' });
      return;
    }
    const localIds = (this._checkinUploadLocalIds || []).slice();
    const unconfirmedRecords = (this._checkinUploadUnconfirmedRecords || []).slice();
    if (!localIds.length && !unconfirmedRecords.length) return;
    this.setData({ checkinRetrying: true });
    let result;
    try {
      result = await checkinManager.syncWithCloud({ force: true, uploadPending: true, localIds,
        ...(unconfirmedRecords.length ? { unconfirmedRecords } : {}) });
    } catch (error) {
      console.error('首页重试上传失败:', error);
      wx.showToast({ title: '记录仍在本机，请稍后重试上传', icon: 'none' });
    } finally {
      this.refreshCalendarData();
      this.setData({ checkinRetrying: false });
      this.closeCheckinUploadPreview();
    }
    if (result) {
      const pending = this.data.pendingCheckinCount;
      const blocked = (this._allCheckinRecords || []).some(record => record.syncStatus === 'blocked');
      wx.showToast({
        title: pending > 0 ? (blocked ? '部分记录无法上传，请查看记录提示'
          : result.code === 'CLOUD_TIMEOUT' ? '上传超时，请手动重试'
            : result.error || `仍有 ${pending} 条未上传，请手动重试`)
          : result.error || (result.uploaded > 0 ? '上传成功' : '暂无待上传记录'),
        icon: pending === 0 && result.uploaded > 0 ? 'success' : 'none'
      });
    }
  },

  updateCheckinGroups() {
    const records = this._allCheckinRecords || [];
    const now = Date.now();
    const { groups, hiddenCount } = homeCheckin.buildCheckinGroups(records, { now });
    this._checkinDay = homeCheckin.getCheckinDay(now);
    this.setData({
      checkinRecords: groups.reduce((visible, group) => visible.concat(group.records), []),
      checkinGroups: groups,
      checkinTotal: records.length,
      hiddenCheckinCount: hiddenCount
    });
  },

  refreshBusinessDay() {
    const today = homeCheckin.getCheckinDay();
    const previousDay = this.data.todayDate;
    const shownMonth = `${this.data.currentYear}-${String(this.data.currentMonth).padStart(2, '0')}`;
    if (previousDay && shownMonth === previousDay.slice(0, 7) && shownMonth !== today.slice(0, 7)) {
      const [currentYear, currentMonth] = today.split('-').map(Number);
      this.setData({ currentYear, currentMonth });
    }
    if (!this.data.checkinSubmitting) this.refreshCheckinDefaults();
    this.updateCheckinGroups();
    this.generateCalendar();
  },

  openAllCheckins() {
    wx.navigateTo({ url: '/pages/checkinHistory/checkinHistory' });
  },

  openCheckinHistory(e) {
    const date = e.currentTarget.dataset.date;
    if (date) wx.navigateTo({ url: `/pages/history/history?date=${date}` });
  },

  async showCheckinActions(e) {
    if (this.data.checkinDeleting || this.data.checkinActionsOpen) return;
    if (!this.data.checkinRecords.some(record => record.id === e.currentTarget.dataset.id)) return;
    this.setData({ checkinActionsOpen: true });
    try {
      const selection = await new Promise(resolve => {
        const menu = wx.showActionSheet({
          itemList: ['删除记录'],
          success: resolve,
          fail: () => resolve(null)
        });
        if (menu && typeof menu.then === 'function') menu.then(resolve, () => resolve(null));
      });
      if (selection && selection.tapIndex === 0) await this.deleteCheckinRecord(e);
    } catch (error) {
      console.warn('打开记录操作菜单失败:', error);
    } finally {
      this.setData({ checkinActionsOpen: false });
    }
  },

  async deleteCheckinRecord(e) {
    if (this.data.checkinDeleting) return;
    const record = this.data.checkinRecords.find(item => item.id === e.currentTarget.dataset.id);
    if (!record) return;

    this.setData({ checkinDeleting: true });
    try {
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
      if (!confirmation.confirm) return;

      this.setData({ deletingCheckinId: record.id });
      const result = await checkinManager.deleteCheckin(record.date, {
        recordId: record._id,
        localId: record.localId,
        timestamp: record.timestamp
      });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '删除失败，请重试', icon: 'none' });
        return;
      }

      this.refreshCalendarData();
      wx.showToast({ title: '记录已删除', icon: 'success' });
    } catch (error) {
      console.error('首页删除静坐记录失败:', error);
      wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      this.setData({ checkinDeleting: false, deletingCheckinId: '' });
    }
  },

  /**
   * 获取用户openId（简化版本）
   */
  getUserOpenId: function() {
    return new Promise((resolve) => {
      console.log('🔍 getUserOpenId开始执行');
      
      // 本地优先：检查是否已有用户标识
      const existingOpenId = wx.getStorageSync('userOpenId');
      console.log('当前存储的userOpenId:', existingOpenId);
      
      // 检查用户是否已登录
      const hasUserInfo = this.hasUserInfo();
      console.log('hasUserInfo检查结果:', hasUserInfo);
      
      // 检查是否已有微信登录信息
      const wechatOpenId = wx.getStorageSync('userOpenId');
      const isWechatLoggedIn = wechatOpenId && wechatOpenId.startsWith('oz');
      console.log('微信登录状态检查:', { wechatOpenId, isWechatLoggedIn });
      
      // 关键诊断：检查微信登录状态与现有用户标识的匹配情况
      console.log('🔍 关键诊断信息:');
      console.log('  - 现有用户标识类型:', existingOpenId ? (existingOpenId.startsWith('oz') ? '微信openid' : '本地用户ID') : '无');
      console.log('  - 微信登录状态:', isWechatLoggedIn);
      console.log('  - 是否需要更新标识:', isWechatLoggedIn && existingOpenId && !existingOpenId.startsWith('oz'));
      
      if (existingOpenId) {
        // 使用现有用户标识
        console.log('使用现有用户标识:', existingOpenId);
        this.setData({
          userOpenId: existingOpenId,
          hasUserInfo: hasUserInfo
        }, () => {
          console.log('用户标识设置完成，开始刷新页面数据');
          this.refreshPageData();
          resolve();
        });
        return;
      }
      
      // 如果没有现有标识，检查是否有微信登录信息
      if (isWechatLoggedIn) {
        console.log('检测到微信已登录，使用微信openid:', wechatOpenId);
        this.setData({
          userOpenId: wechatOpenId,
          hasUserInfo: hasUserInfo
        }, () => {
          console.log('微信用户标识设置完成，开始刷新页面数据');
          this.refreshPageData();
          resolve();
        });
        return;
      }
      
      // 生成新的本地用户标识
      const newLocalUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      console.log('生成新的本地用户标识:', newLocalUserId);
      wx.setStorageSync('localUserId', newLocalUserId);
      wx.setStorageSync('userOpenId', newLocalUserId);
      
      this.setData({
        userOpenId: newLocalUserId,
        hasUserInfo: hasUserInfo
      }, () => {
        console.log('新的本地用户标识设置完成，开始刷新页面数据');
        this.refreshPageData();
        resolve();
      });
    });
  },

  // 检查是否需要从云端恢复数据
  checkAndRecoverFromCloud: function() {
    return new Promise((resolve) => {
      try {
        const checkinManager = require('../../utils/checkin.js');
        
        checkinManager.checkAndRecoverFromCloud().then((recovered) => {
          if (recovered) {
            console.log('✅ 云端数据恢复完成，刷新页面数据');
            this.refreshPageData();
          }
          resolve();
        }).catch(error => {
          console.error('数据恢复检查失败:', error);
          resolve();
        });
        
      } catch (error) {
        console.error('数据恢复检查异常:', error);
        resolve();
      }
    });
  },

  /**
   * 检查用户信息缓存
   */
  checkUserInfoCache: function() {
    // 检查缓存中是否有完整的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    // 支持新旧格式的用户信息
    const hasValidUserInfo = cachedUserInfo && 
                           (cachedUserInfo.nickName || 
                            (cachedUserInfo.isCustomAvatar !== undefined && 
                             cachedUserInfo.profileComplete));
    
    if (hasValidUserInfo) {
      // 有完整的用户信息，直接使用
      const nickname = cachedUserInfo.nickName || '觉察者';
      
      this.setData({
        userNickname: nickname,
        hasUserInfo: true
      }, () => {
        console.log('从缓存获取用户昵称:', nickname);
        
        // 用户登录后立即同步云端数据并刷新日历
        this.syncUserCheckinData();
      });
    } else {
      // 缓存中没有用户信息，显示授权必需提示
      console.log('缓存中没有用户信息，显示授权提示');
      this.showAuthRequiredModal();
      
      // 设置默认昵称并显示授权按钮
      this.setData({
        userNickname: '觉察者',
        hasUserInfo: false
      });
    }
  },

  /**
   * 获取用户昵称（支持新旧格式）
   */
  getUserNickname: function() {
    // 尝试从缓存获取用户昵称
    const cachedNickname = wx.getStorageSync('userNickname');
    if (cachedNickname) {
      this.setData({
        userNickname: cachedNickname
      });
      return;
    }
    
    // 尝试从用户信息中获取昵称
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.nickName) {
      this.setData({
        userNickname: cachedUserInfo.nickName
      });
      // 同时保存到独立的昵称缓存
      wx.setStorageSync('userNickname', cachedUserInfo.nickName);
      return;
    }
    
    // 如果没有用户昵称，设置默认昵称"微信用户"
    this.setData({
      userNickname: '微信用户'
    });
  },

  /**
   * 显示登录模态框（直接跳转到用户信息收集页面）
   */
  showLoginModal: function() {
    console.log('=== showLoginModal函数被调用 ===');
    
    // 直接调用新的登录流程，跳转到用户信息收集页面
    this.getUserInfoDirectly();
    
    console.log('=== showLoginModal函数执行完成 ===');
  },

  /**
   * 开始微信登录流程 - 使用新的个人信息收集方式
   */
  startWechatLogin: function() {
    console.log('开始新的微信登录流程');
    
    // 直接使用新的登录流程
    this.getUserInfoDirectly();
  },

  /**
   * 获取微信用户身份标识（openid）- 已弃用，使用本地生成的ID
   */
  getWechatOpenId: function() {
    console.log('=== 获取用户标识ID ===');
    
    return new Promise((resolve, reject) => {
      try {
        // 不再使用微信登录，直接使用本地生成的标识
        const localOpenId = wx.getStorageSync('wechatOpenId');
        if (!localOpenId) {
          const newOpenId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          wx.setStorageSync('wechatOpenId', newOpenId);
          resolve(newOpenId);
        } else {
          resolve(localOpenId);
        }
      } catch (error) {
        console.error('获取用户标识失败:', error);
        reject(error);
      }
    });
  },

  /**
   * 新的登录流程 - 替代原有的getUserInfoDirectly
   */
  getUserInfoDirectly: function() {
    console.log('=== 启动新的用户信息收集流程 ===');
    
    // 直接检查用户信息状态，并设置跳转标志
    this.checkUserInfoStatus(true);
  },

  /**
   * 检查用户信息状态（简化版本）
   */
  checkUserInfoStatus: function(shouldNavigate = false) {
    console.log('检查用户信息状态，是否跳转:', shouldNavigate);
    console.log('当前页面数据 - hasUserInfo:', this.data.hasUserInfo, 'userNickname:', this.data.userNickname);
    
    // 检查用户是否已登录
    const hasUserInfo = this.hasUserInfo();
    console.log('hasUserInfo检测结果:', hasUserInfo);
    
    // 获取用户信息进行详细判断
    const userNickname = wx.getStorageSync('userNickname');
    const userOpenId = wx.getStorageSync('userOpenId');
    const userInfo = wx.getStorageSync('userInfo');
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const isLocalUser = userOpenId && userOpenId.startsWith('local_');
    const hasWechatInfo = !!(userInfo || userNickname);
    
    console.log('详细状态检测 - 微信登录:', isWechatLoggedIn, '本地用户:', isLocalUser, '有微信信息:', hasWechatInfo);
    
    if (hasUserInfo && (isWechatLoggedIn || hasWechatInfo)) {
      // 真正微信登录状态 或 通过本地用户标识成功获取微信信息：显示真实用户昵称
      const displayName = userNickname || '觉察者';
      console.log('已登录，显示昵称:', displayName);
      this.setData({
        userNickname: displayName,
        hasUserInfo: true
      });
      
      // 登录后只需要同步一次云端数据
      if (!shouldNavigate) {
        this.syncUserCheckinData();
      }
      
      
    } else {
      // 未登录或未获取到微信信息：显示"点击登录"
      console.log('未登录，显示"点击登录"');
      this.setData({
        userNickname: '点击登录',
        hasUserInfo: false
      });
    }
    
    console.log('设置后页面数据 - hasUserInfo:', this.data.hasUserInfo, 'userNickname:', this.data.userNickname);
    
    // 只有当用户主动点击"点击登录"时才跳转
    if (shouldNavigate && !hasUserInfo) {
      console.log('跳转到profile页面');
      wx.navigateTo({
        url: '/pages/profile/profile',
        success: (res) => {
          console.log('跳转profile页面成功:', res);
        },
        fail: (err) => {
          console.error('跳转profile页面失败:', err);
        }
      });
    }
  },
  
  /**
   * 简化：检查用户是否有登录信息
   */
  hasUserInfo: function() {
    const userInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    const userOpenId = wx.getStorageSync('userOpenId');
    
    console.log('用户信息检测 - userInfo:', userInfo, 'userNickname:', userNickname, 'userOpenId:', userOpenId);
    
    // 正确的用户状态检测逻辑：
    // 1. 真正登录：userOpenId以'oz'开头（微信openid）
    // 2. 本地用户：userOpenId以'local_'开头（未登录，但有本地标识）
    // 3. 未登录：没有任何用户信息
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const isLocalUser = userOpenId && userOpenId.startsWith('local_');
    
    // 只有当有微信登录信息或有用户昵称时，才认为是已登录
    const hasInfo = !!(isWechatLoggedIn || userInfo || userNickname);
    console.log('登录状态检测 - 微信登录:', isWechatLoggedIn, '本地用户:', isLocalUser, '有用户信息:', !!userInfo, '有昵称:', !!userNickname);
    console.log('hasUserInfo计算结果:', hasInfo);
    
    return hasInfo;
  },




  /**
   * 基础登录流程（没有用户详细信息）
   */
  basicLoginProcess: function() {
    console.log('=== 开始基础登录流程 ===');
    
    // 获取用户openid
    const openid = wx.getStorageSync('wechatOpenId') || 'openid_' + Date.now();
    const nickname = '微信用户';
    
    // 保存基础用户信息（只有openid）
    this.saveBasicUserInfo(openid);
    
    // 更新页面显示
    this.setData({
      userNickname: nickname,
      hasUserInfo: false
    });
    
    // 显示基础登录成功提示
    wx.showToast({
      title: `欢迎使用小程序`,
      icon: 'success',
      duration: 2000
    });
  },

  /**
   * 获取用户信息 - 已弃用（微信getUserProfile接口已关闭）
   */
  getUserProfile: function(loginCode) {
    console.warn('⚠️ wx.getUserProfile接口已关闭，使用新的登录流程');
    
    // 提示用户使用新的登录方式
    wx.showModal({
      title: '登录方式更新',
      content: '微信登录方式已更新，请使用新的个人信息收集功能',
      showCancel: false,
      confirmText: '确定',
      success: (res) => {
        if (res.confirm) {
          // 跳转到新的登录流程
          this.getUserInfoDirectly();
        }
      }
    });
  },

  /**
   * 保存基础用户信息（只有openid，没有用户详细信息）
   */
  saveBasicUserInfo: function(openid) {
    console.log('保存基础用户信息，openid:', openid);
    
    // 保存到本地缓存
    const oldUserOpenId = wx.getStorageSync('userOpenId');
    wx.setStorageSync('userOpenId', openid);
    wx.setStorageSync('userNickname', '微信用户');
    // 登录/换绑：将本地(local_)期间已解锁的勋章迁移到新 openid 缓存（修复风险③）
    require('../../utils/badgeManager.js').migrateBadges(oldUserOpenId, openid);
    
    // 保存到云数据库（只有openid）
    this.saveBasicUserToCloud(openid);
  },

  /**
   * 保存用户信息（简化版本）
   */
  saveUserInfo: function(userInfo, openid) {
    console.log('保存用户信息，openid:', openid);
    
    // 保存用户信息到本地缓存
    const oldUserOpenId = wx.getStorageSync('userOpenId');
    wx.setStorageSync('userInfo', userInfo);
    wx.setStorageSync('userNickname', userInfo.nickName);
    wx.setStorageSync('userOpenId', openid);
    // 登录/换绑：将本地(local_)期间已解锁的勋章迁移到新 openid 缓存（修复风险③）
    require('../../utils/badgeManager.js').migrateBadges(oldUserOpenId, openid);
    
    // 保存用户数据到本地
    const userData = {
      openid: openid,
      userInfo: userInfo,
      loginTime: new Date().toISOString()
    };
    
    wx.setStorageSync('userLoginData', userData);
    
    // 异步保存用户信息到云数据库
    this.saveUserToCloud(userInfo, openid);
    
    console.log('用户信息保存完成');
  },

  
  
  

  /**
   * 保存基础用户信息到云数据库（只有openid）
   */
  saveBasicUserToCloud: function(openid) {
    console.log('保存基础用户信息到云数据库，openid:', openid);
    
    const db = wx.cloud.database();
    const usersCollection = db.collection('users');
    
    // 检查用户是否已存在（使用_openid作为标识）
    usersCollection.where({
      _openid: openid
    }).get({
      success: (res) => {
        if (res.data.length > 0) {
          // 用户已存在，更新最后登录时间
          console.log('用户已存在，更新最后登录时间');
          usersCollection.doc(res.data[0]._id).update({
            data: {
              lastLoginTime: new Date(),
              loginCount: wx.cloud.database().command.inc(1)
            }
          }).then(res => {
            console.log('用户信息更新成功:', res);
          }).catch(err => {
            console.error('用户信息更新失败:', err);
          });
        } else {
          // 用户不存在，创建新用户
          console.log('用户不存在，创建新用户');
          usersCollection.add({
            data: {
              openid: openid,
              nickName: '微信用户',
              createTime: new Date(),
              lastLoginTime: new Date(),
              loginCount: 1
            }
          }).then(res => {
            console.log('基础用户信息保存到云数据库成功:', res);
          }).catch(err => {
            console.error('基础用户信息保存到云数据库失败:', err);
          });
        }
      },
      fail: (err) => {
        console.error('查询用户信息失败:', err);
      }
    });
  },

  /**
   * 保存用户信息到云数据库（简化版本）
   */
  saveUserToCloud: function(userInfo, userOpenId) {
    console.log('开始保存用户信息到云数据库');
    
    const db = wx.cloud.database();
    const usersCollection = db.collection('users');
    
    // 准备用户数据
    const userData = {
      nickName: userInfo.nickName,
      avatarUrl: userInfo.avatarUrl,
      lastLoginTime: new Date(),
      loginCount: wx.cloud.database().command.inc(1)
    };
    
    // 尝试创建或更新用户数据
    usersCollection.add({
      data: userData
    }).then(res => {
      console.log('用户信息保存到云数据库成功');
    }).catch(err => {
      console.error('用户信息保存到云数据库失败:', err);
    });
  },

  /**
   * 触发用户登录（已弃用授权，使用新的信息收集方式）
   */
  triggerUserLogin: function() {
    console.log('触发用户登录');
    
    // 设置用户未登录状态
    this.setData({
      hasUserInfo: false
    });
    
    // 跳转到用户信息收集页面
    this.getUserInfoDirectly();
  },

  /**
   * 用户信息收集回调（已弃用微信授权）
   */
  onUserInfoCollected: function(userInfo) {
    console.log('用户信息收集完成:', userInfo);
    
    if (userInfo) {
      const nickname = userInfo.nickName;
      
      console.log('用户信息收集成功，昵称:', nickname);
      
      // 保存到缓存
      wx.setStorageSync('userInfo', userInfo);
      wx.setStorageSync('userNickname', nickname);
      
      // 更新页面显示
      this.setData({
        userNickname: nickname,
        hasUserInfo: true
      }, () => {
        console.log('页面数据更新完成');
        
        // 注意：数据迁移逻辑已移动到获取微信openid成功后的回调中
        console.log('等待获取微信openid后再执行数据迁移...');
      });
      
      wx.showToast({
        title: '登录成功',
        icon: 'success',
        duration: 1500
      });
    } else {
      console.log('用户信息收集失败');
      
      // 用户取消信息收集，可以继续使用基础功能
      wx.showToast({
        title: '您可以继续使用基础功能',
        icon: 'none',
        duration: 1500
      });
    }
  },

  /**
   * 检查用户信息，当无法获取userNickname时显示授权信息
   */
  checkUserInfo: function() {
    console.log('=== checkUserInfo函数开始执行 ===');
    console.log('当前页面数据 userNickname:', this.data.userNickname);
    console.log('当前页面数据 hasUserInfo:', this.data.hasUserInfo);
    
    // 获取缓存的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    console.log('缓存中 userInfo:', cachedUserInfo);
    
    const cachedNickname = wx.getStorageSync('userNickname');
    console.log('缓存中 userNickname:', cachedNickname);
    
    if (cachedUserInfo && cachedUserInfo.nickName) {
      // 有用户信息，显示欢迎信息
      console.log('用户已授权，显示欢迎信息');
      // 确保页面数据正确更新
      this.setData({
        userNickname: cachedUserInfo.nickName,
        hasUserInfo: true
      }, () => {
        console.log('页面数据更新完成，userNickname:', this.data.userNickname);
        
        // 用户登录后立即同步云端数据并刷新日历
        this.syncUserCheckinData();
      });
      
      wx.showToast({
        title: `欢迎回来，${cachedUserInfo.nickName}`,
        icon: 'none',
        duration: 2000
      });
    } else {
      // 无法获取用户信息，显示授权窗口
      console.log('无法获取用户信息，显示授权窗口');
      this.showAuthRequiredModal();
    }
    
    console.log('=== checkUserInfo函数执行完成 ===');
  },

  /**
   * 显示授权必需提示
   */
  showAuthRequiredModal: function() {
    wx.showModal({
      title: '授权提示',
      content: '欢迎使用觉察计时小程序！使用本小程序需要授权获取您的昵称信息。',
      showCancel: false,
      confirmText: '立即授权',
      success: (res) => {
        if (res.confirm) {
          // 用户确认，继续显示授权按钮
          console.log('用户点击立即授权');
        }
      }
    });
  },

  /**
   * 开始静坐打卡
   */
  startMeditation: function() {
    // 获取用户标识
    this.getUserOpenId();
    
    // 跳转到计时页面
    wx.switchTab({
      url: '/pages/timer/timer'
    });
  },


  /**
   * 刷新页面数据
   */
  refreshPageData: function() {
    this.generateCalendar();
    this.getUserNickname();
    this.refreshCheckinRecords();
  },

  /**
   * 刷新日历数据
   */
  refreshCalendarData: function() {
    this.generateCalendar();
    this.refreshCheckinRecords();
  },

  /**
   * 只读取云端校准缓存，未上传记录留在本机等待手动上传。
   */
  refreshCheckinsFromCloud(options) {
    let request;
    try {
      request = checkinManager.syncWithCloud({ ...options, uploadPending: false });
    } catch (error) {
      console.warn('首页云端打卡记录刷新失败:', error);
      return Promise.resolve(false);
    }
    if (this._checkinCloudSyncRequest === request) return this._checkinCloudRefresh;

    const refresh = Promise.resolve(request)
      .then(result => {
        if (result.refreshed) this.refreshCalendarData();
        return result.refreshed;
      })
      .catch(error => {
        console.warn('首页云端打卡记录刷新失败:', error);
        return false;
      })
      .finally(() => {
        if (this._checkinCloudRefresh === refresh) {
          this._checkinCloudRefresh = null;
          this._checkinCloudSyncRequest = null;
        }
      });
    this._checkinCloudSyncRequest = request;
    this._checkinCloudRefresh = refresh;
    return refresh;
  },

  /**
   * 判断用户是否已登录（微信openid以'oz'开头）
   */
  isUserLoggedIn() {
    // 优先检查是否有微信openid存储在本地
    const wechatOpenId = wx.getStorageSync('userOpenId');
    if (wechatOpenId && wechatOpenId.startsWith('oz')) {
      return true;
    }
    
    // 如果本地存储中没有微信openid，再检查页面数据
    const userOpenId = this.data.userOpenId;
    return userOpenId && userOpenId.startsWith('oz');
  },

  /**
   * 选择日期
   */
  selectDate: function(e) {
    const date = e.currentTarget.dataset.date;
    if (date) {
      console.log('选择日期:', date);
      
      // 检查日期是否已打卡
      if (this.isDateChecked(date)) {
        // 已打卡日期，跳转到历史记录页面
        wx.navigateTo({
          url: `/pages/history/history?date=${date}`
        });
      } else {
        // 未打卡日期，显示提示
        wx.showToast({
          title: '该日期尚未打卡',
          icon: 'none',
          duration: 1500
        });
      }
    }
  },

  /**
   * 切换到上个月
   */
  prevMonth: function() {
    let year = this.data.currentYear;
    let month = this.data.currentMonth;
    
    if (month === 1) {
      year--;
      month = 12;
    } else {
      month--;
    }
    
    this.setData({
      currentYear: year,
      currentMonth: month
    });
    
    this.generateCalendar();
  },

  /**
   * 切换到下个月
   */
  nextMonth: function() {
    let year = this.data.currentYear;
    let month = this.data.currentMonth;
    
    if (month === 12) {
      year++;
      month = 1;
    } else {
      month++;
    }
    
    this.setData({
      currentYear: year,
      currentMonth: month
    });
    
    this.generateCalendar();
  },

  /**
   * 一次读取日历打卡日期，以明细的 02:00 分日结果为准。
   */
  getCalendarCheckedDates() {
    const userData = checkinManager.getUserCheckinData();
    const displayOptions = this.getCheckinDisplayOptions();
    const records = homeCheckin.buildCheckinRecords(userData, [], displayOptions);
    const dates = new Set(records.map(record => record.dayDate));
    const standardDetailedDates = new Set(records.filter(record => record.sortTimestamp > 0).map(record => record.date));
    const userOpenId = wx.getStorageSync('userOpenId') || this.data.userOpenId;
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const legacySources = userOpenId ? Object.entries(allUserRecords)
      .filter(([id, data]) => data && (id === userOpenId || (data.migrated && data.migratedTo === userOpenId)))
      .map(([, data]) => data) : [];

    const sources = [{ data: userData, records }].concat(legacySources.map(data => ({
      data, records: homeCheckin.buildCheckinRecords(data, [], displayOptions)
    })));
    const detailedDates = new Set();
    sources.forEach(source => source.records.forEach(record => {
      if (record.sortTimestamp > 0) detailedDates.add(record.date);
    }));
    sources.slice(1).forEach(source => {
      source.records.forEach(record => {
        // 同一存储日期已有标准明细时，不再用旧缓存补出午夜日期。
        if (!standardDetailedDates.has(record.date) &&
            (record.sortTimestamp > 0 || !detailedDates.has(record.date))) dates.add(record.dayDate);
      });
    });
    sources.forEach(source => {
      Object.entries(source.data.dailyRecords || {}).forEach(([date, day]) => {
        // 无明细的老数据只能沿用存储日期；有真实时间戳时不补标。
        if (day && Number(day.count) > 0 && !detailedDates.has(date) &&
            !(Array.isArray(day.records) && day.records.some(Boolean))) dates.add(date);
      });
    });
    return dates;
  },

  /**
   * 检查日期，日历生成时复用同一个日期集合。
   */
  isDateChecked: function(dateStr) {
    if (!this._calendarCheckedDates) this._calendarCheckedDates = this.getCalendarCheckedDates();
    if (this._calendarCheckedDates.has(dateStr)) return true;

    // 保留原有的登录同步入口。
    if (this.isUserLoggedIn()) {
      // 标记需要重新检查日历，避免频繁调用
      if (!this.data.needsCalendarRefresh) {
        this.setData({
          needsCalendarRefresh: true
        });
        
        // 延迟调用同步，避免阻塞当前函数执行
        setTimeout(() => {
          this.syncUserCheckinData();
        }, 500);
      }
    }
    
    // 静默处理未找到打卡记录的情况
    return false;
  },
  
  /**
   * 检查迁移数据
   */
  checkMigratedRecords: function(dateStr) {
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    
    // 查找所有已迁移到当前用户的数据
    for (const [userId, userRecord] of Object.entries(allUserRecords)) {
      if (userRecord.migrated && userRecord.migratedTo === this.data.userOpenId) {
        const records = homeCheckin.buildCheckinRecords(userRecord);
        if (records.some(record => record.dayDate === dateStr)) return true;
        const dailyRecord = (userRecord.dailyRecords || {})[dateStr];
        if (dailyRecord && Number(dailyRecord.count) > 0 &&
            !(Array.isArray(dailyRecord.records) && dailyRecord.records.some(Boolean))) return true;
      }
    }
    
    return false;
  },
  
  /**
   * 异步同步用户打卡数据到本地存储
   */
  syncUserCheckinData: function() {
    const checkinManager = require('../../utils/checkin.js');
    
    // 本地优先架构：简化同步逻辑，只在登录时执行一次
    if (!checkinManager.isUserLoggedIn()) {
      console.log('❌ 未登录用户，跳过同步');
      return;
    }
    
    // 检查是否已经执行过登录同步（登录后10分钟内只执行一次）
    const now = Date.now();
    const lastSyncTime = wx.getStorageSync('lastLoginSync') || 0;
    const syncInterval = 10 * 60 * 1000; // 10分钟
    
    if (now - lastSyncTime < syncInterval) {
      console.log('✅ 同步已跳过（10分钟内已执行过）');
      return;
    }
    
    console.log('🔄 执行登录同步...');
    wx.setStorageSync('lastLoginSync', now);
    
    // 异步执行同步，不阻塞页面
    checkinManager.performLoginSync().then(() => {
      console.log('✅ 登录同步完成');
      // 同步完成后刷新页面数据
      this.refreshCalendarData();
    }).catch(error => {
      console.warn('⚠️ 登录同步失败:', error.message);
    });
  },

  /**
   * 生成日历数据
   */
  generateCalendar: function() {
    const year = this.data.currentYear;
    const month = this.data.currentMonth;
    this._calendarCheckedDates = this.getCalendarCheckedDates();
    const todayStr = homeCheckin.getCheckinDay();
    
    // 获取当月第一天和最后一天
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    
    // 获取当月第一天是星期几（0-6，0代表周日，1代表周一）
    const firstDayOfWeek = firstDay.getDay() === 0 ? 7 : firstDay.getDay(); // 转换为周一为1
    
    // 获取上个月最后几天
    const prevMonthLastDay = new Date(year, month - 1, 0).getDate();
    
    // 计算需要显示的天数 - 固定显示6行（42天）
    const daysInMonth = lastDay.getDate();
    const totalCells = 42; // 固定6行 * 7天 = 42天
    
    const calendarDays = [];
    let week = [];
    
    // 添加上个月的最后几天
    const prevMonthDaysNeeded = firstDayOfWeek - 1;
    for (let i = 0; i < prevMonthDaysNeeded; i++) {
      const day = prevMonthLastDay - prevMonthDaysNeeded + i + 1;
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const fullDate = `${prevYear}-${prevMonth.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      week.push({
        day: day,
        type: 'prev-month',
        fullDate: fullDate,
        isToday: fullDate === todayStr,
        isChecked: this.isDateChecked(fullDate)
      });
    }
    
    // 添加当前月的日期
    for (let day = 1; day <= daysInMonth; day++) {
      const fullDate = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      week.push({
        day: day,
        type: 'current-month',
        fullDate: fullDate,
        isToday: fullDate === todayStr,
        isChecked: this.isDateChecked(fullDate)
      });
      
      // 每7天一周
      if (week.length === 7) {
        calendarDays.push(week);
        week = [];
      }
    }
    
    // 添加下个月的日期 - 补齐到42天
    let nextMonthDay = 1;
    const remainingDays = totalCells - (prevMonthDaysNeeded + daysInMonth);
    for (let i = 0; i < remainingDays; i++) {
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const fullDate = `${nextYear}-${nextMonth.toString().padStart(2, '0')}-${nextMonthDay.toString().padStart(2, '0')}`;
      
      week.push({
        day: nextMonthDay,
        type: 'next-month',
        fullDate: fullDate,
        isToday: fullDate === todayStr,
        isChecked: this.isDateChecked(fullDate)
      });
      nextMonthDay++;
      
      // 每7天一周
      if (week.length === 7) {
        calendarDays.push(week);
        week = [];
      }
    }
    
    this.setData({
      calendarDays: calendarDays,
      todayDate: todayStr
    });
  },

  /**
   * 测试函数 - 用于验证showLoginModal能否被调用
   */
  testShowLoginModal: function() {
    console.log('=== testShowLoginModal函数被调用 ===');
    console.log('测试函数开始，将调用showLoginModal');
    
    // 直接调用showLoginModal函数
    if (typeof this.showLoginModal === 'function') {
      console.log('showLoginModal函数存在，准备调用');
      this.showLoginModal();
    } else {
      console.error('showLoginModal函数不存在或未定义');
    }
    
    console.log('=== testShowLoginModal函数执行完成 ===');
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('=== index页面onLoad函数开始 ===');
    console.log('页面参数:', options);
    if (this._stopCheckinSyncWatch) this._stopCheckinSyncWatch();
    this._stopCheckinSyncWatch = checkinManager.subscribeSyncState(() => {
      this.refreshCalendarData();
    });
    
    const [year, month] = homeCheckin.getCheckinDay().split('-').map(Number);
    this.setData({
      currentYear: year,
      currentMonth: month
    });
    this.refreshCheckinDefaults();
    
    console.log('初始化页面数据完成');
    
    // 获取用户标识，完成后会自动更新数据
    this.getUserOpenId().then(() => {
      // 用户标识获取完成后，检查是否需要从云端恢复数据
      return this.checkAndRecoverFromCloud();
    }).then(() => {
      // 数据恢复完成后，刷新页面数据
      this.refreshPageData();
    });
    
    // 页面加载时立即检查用户信息状态，确保正确显示登录按钮
    this.checkUserInfoStatus(false);
    
    console.log('index页面加载完成，用户状态检查完成');
    
    console.log('=== index页面onLoad函数结束 ===');
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    console.log('=== index页面onShow函数开始 ===');
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = dailyWisdom.watchDailyWisdom(({ content }) => {
      this.setData({ wisdomQuote: '"' + content + '"' });
    });
    if (this.data.todayDate && this.data.todayDate !== homeCheckin.getCheckinDay()) this.refreshBusinessDay();
    this.refreshCheckinDefaults();
    this.refreshCheckinRecords();
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = dateUtil.watchBusinessDate(() => this.refreshBusinessDay());
    clearInterval(this._checkinClock);
    this._checkinClock = setInterval(() => {
      if (!this.data.checkinSubmitting) this.refreshCheckinDefaults();
      if (this._checkinDay !== homeCheckin.getCheckinDay()) {
        this.refreshBusinessDay();
      }
    }, 30000);
    
    // 检查用户信息状态（不跳转，只更新显示）
    // 每次显示页面时都检查用户状态，确保显示正确的登录状态
    this.checkUserInfoStatus(false);
    
    // 重新生成日历，确保显示最新的打卡状态
    this.generateCalendar();
    
    console.log('页面显示完成，当前用户状态:', {
      hasUserInfo: this.data.hasUserInfo,
      userNickname: this.data.userNickname,
      userOpenId: this.data.userOpenId
    });
    console.log('=== index页面onShow函数结束 ===');
    return this.refreshCheckinsFromCloud();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {
    clearInterval(this._checkinClock);
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    clearInterval(this._checkinClock);
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
    if (this._stopCheckinSyncWatch) this._stopCheckinSyncWatch();
    this._stopCheckinSyncWatch = null;
  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  async onPullDownRefresh() {
    try {
      this.refreshCheckinDefaults();
      const refreshed = await this.refreshCheckinsFromCloud({ force: true });
      if (!refreshed) this.refreshCalendarData();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {
    return {};
  }
})
