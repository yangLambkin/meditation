// pages/me/me.js
const badgeManager = require('../../utils/badgeManager');
const checkinManager = require('../../utils/checkin.js');
const dateUtil = require('../../utils/dateUtil.js');
const contentSec = require('../../utils/contentSec.js');
const bijingApi = require('../../utils/bijingApi.js');
const cloudApi = require('../../utils/cloudApi.js');
const profileCache = require('../../utils/profileCache.js');

Page({
  data: {
    userNickname: '觉察者', // 用户昵称
    userAvatar: '/images/userLogin.png', // 用户头像，默认使用用户登录头像
    totalMinutes: 0, // 总分钟数
    longestCheckInDays: 0, // 最长连续天数
    currentStreak: 0, // 当前连续天数
    medals: 0, // 勋章数量
    hasUserInfo: false, // 是否已获取用户信息
    // 必经之路绑定相关
    bijingBound: false, // 是否已绑定学号
    bijingStudentNumber: '', // 已绑定的学号
    bijingBindingVersion: null,
    bijingBinding: false,
    bijingUnbinding: false,
    bijingIsAdmin: false,
    bijingShowBindInput: false, // 是否展示绑定输入框
    bijingInputValue: '', // 绑定输入框当前值
    bijingSyncing: false, // 同步中状态（防重复点击）
    bijingShowSyncDatePicker: false,
    bijingSyncDateOptions: [],
    bijingSyncDate: '',
    bijingSyncDetailsLoading: false,
    bijingSyncDetailsError: '',
    bijingSyncDetailsDate: '',
    bijingSyncRecords: [],
    bijingSyncRecordCount: 0,
    bijingSyncTotalDuration: 0,
    bijingSyncDuration: 0,
    bijingSyncAlreadySynced: false,
    bijingLastSync: '',
    bijingShowConfirm: false, // 是否显示绑定确认弹窗
    bijingConfirmSn: '', // 弹窗展示的学号
    bijingConfirmNickname: '', // 弹窗展示的昵称
    bijingPendingSn: '' // 待确认绑定的学号（弹窗确定后真正绑定用）
  },

  // 统计加载去重锁：避免 onLoad 与 onShow 并发两次云端调用（修复 4.6）
  _loadingStats: false,
  _bijingSyncDetailsRequestId: 0,

  onLoad(options) {
    // 获取用户数据
    this.getUserData();
  },

  onShow() {
    this._adminHidden = false;
    this._bijingHidden = false;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = dateUtil.watchBusinessDate(() => {
      this.calculateUserStatistics();
      if (this.data.bijingShowSyncDatePicker) {
        const options = this.getBijingSyncDateOptions();
        const date = options.some(option => option.date === this.data.bijingSyncDate)
          ? this.data.bijingSyncDate : options[0].date;
        const changed = date !== this.data.bijingSyncDate;
        this.setData({ bijingSyncDateOptions: options, bijingSyncDate: date });
        if (changed) this.loadBijingSyncDetails(date);
      }
    });
    // 页面显示时更新数据
    this.getUserData();
  },

  /**
   * 获取用户数据
   */
  getUserData() {
    // 获取用户昵称和头像
    this.getUserNickname();
    this.getUserAvatar();

    // 加载必经之路绑定状态
    this.loadBijingStatus();

    // 获取用户统计信息
    this.calculateUserStatistics();
  },

  /**
   * 获取用户昵称
   */
  getUserNickname() {
    // 尝试从缓存获取用户昵称
    const cachedNickname = profileCache.readProfile().nickName;
    this.setData({
      userNickname: cachedNickname || '觉察者',
      hasUserInfo: !!cachedNickname
    });
  },

  /**
   * 加载必经之路绑定状态（来自云端 users 文档）
   */
  async loadBijingStatus() {
    if (this._bijingHidden) return;
    const openid = wx.getStorageSync('userOpenId');
    if (this._bijingAccount !== undefined && this._bijingAccount !== openid) {
      this._bijingGeneration = (this._bijingGeneration || 0) + 1;
      this.clearBijingBindingView();
      this.setData({ bijingBinding: false, bijingUnbinding: false, bijingSyncing: false });
      this.clearBijingAdminAccess();
    }
    this._bijingAccount = openid;
    if (!checkinManager.isUserLoggedIn()) {
      this.clearBijingBindingView();
      return;
    }
    if (this._bijingOperation && this._bijingOperation.account === openid) return;
    const context = this.bijingContext();
    const requestId = this._bijingStatusRequestId = (this._bijingStatusRequestId || 0) + 1;
    try {
      const result = await cloudApi.callCloudFunction('meditationManager', {
        type: 'getUserProfile',
        openid: openid
      });
      const profile = result && result.result && result.result.data;
      if (profile && this.isBijingContextCurrent(context) && requestId === this._bijingStatusRequestId) {
        if (!profile.bijingBound || profile.bijingStudentNumber !== this.data.bijingStudentNumber ||
            (profile.bijingBindingVersion || null) !== this.data.bijingBindingVersion) {
          this.clearBijingBindingView();
          this.clearBijingAdminAccess();
        }
        this.setData({
          bijingBound: !!profile.bijingBound,
          bijingStudentNumber: profile.bijingStudentNumber || '',
          bijingBindingVersion: profile.bijingBindingVersion === undefined ? null : profile.bijingBindingVersion
        });
      }
    } catch (e) {
      console.error('加载必经之路状态失败:', e);
    }
  },

  /**
   * 获取用户头像（支持新旧格式）
   */
  getUserAvatar() {
    // 只从缓存获取用户信息，不进行静默获取
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    // 支持新旧格式的用户头像
    const hasValidAvatar = cachedUserInfo && 
                          (cachedUserInfo.avatarUrl || 
                           cachedUserInfo.isCustomAvatar !== undefined);
    
    if (hasValidAvatar && cachedUserInfo.avatarUrl) {
      // 使用缓存的用户头像
      this.setData({
        userAvatar: cachedUserInfo.avatarUrl,
        hasUserInfo: true
      });
      console.log('从缓存获取用户头像:', cachedUserInfo.avatarUrl);
    } else {
      // 缓存中没有用户头像，使用默认头像
      console.log('缓存中无用户头像，使用默认头像');
      this.setData({
        userAvatar: '/images/userLogin.png',
        hasUserInfo: !!(wx.getStorageSync('userNickname') || cachedUserInfo && cachedUserInfo.nickName)
      });
    }
  },

  /**
   * 计算用户统计信息
   */
  async calculateUserStatistics() {
    // 4.6：onLoad 与 onShow 都会触发本方法，加去重锁避免并发两次云端调用
    if (this._loadingStats) return;
    this._loadingStats = true;
    try {
      // 4.5：统一使用 checkin.isUserLoggedIn() 判定登录态（仅看 userOpenId 是否 'oz' 开头），
      // 避免「本地未登录但设过昵称的用户」被误判为已登录、进而用非 openid 调云端
      const userOpenId = wx.getStorageSync('userOpenId');
      const isLoggedIn = checkinManager.isUserLoggedIn();

      if (isLoggedIn) {
        // 已登录用户：从云端 user_stats 表获取数据
        console.log('用户已登录，从云端获取统计信息');
        await this.getUserStatisticsFromCloud(userOpenId);
      } else {
        // 未登录用户：显示 0
        console.log('用户未登录，显示默认值0');
        this.setData({
          totalMinutes: 0,
          longestCheckInDays: 0,
          currentStreak: 0,
          medals: 0
        });
      }
    } finally {
      this._loadingStats = false;
    }
  },

  /**
   * 从云端获取用户统计信息（支持月度清零）
   */
  async getUserStatisticsFromCloud(userOpenId) {
    try {
      const result = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'getUserStats',
          openid: userOpenId
        }
      });

      if (result.result && result.result.success) {
        const stats = result.result.data;
        console.log('从云端获取用户统计信息:', stats);
        
        // 尝试从云端同步勋章数据
        await badgeManager.loadBadgesFromCloud();
        
        // 检查用户是否满足新勋章解锁条件（提供完整统计数据）
        // 连续勋章判定源：历史最长连续天数（与云端重算工具同源），不再用 currentStreak
        badgeManager.checkBadgeUnlock({
          longestStreak: Math.max(stats.longestStreak || 0, stats.longestCheckInDays || 0),
          totalCheckinDays: stats.totalDays || 0, // 云端字段名为 totalDays（累计打卡天数）
          lastDuration: stats.lastCheckinDuration || 0,
          totalDuration: stats.totalDuration || 0
        });
        
        // 获取实际勋章数量
        const unlockedBadgeCount = badgeManager.getUnlockedCount();
        
        // 当月总分钟数：优先使用云端按月聚合值 monthlyStats[当前月].totalDuration，
        // 与 currentStreak / 最长连续天数 同源于 user_stats，避免换设备/清缓存时本地缺失导致口径不一致
        const currentMonth = dateUtil.getBusinessMonth(); // 与云端 monthStr 同用东八区业务日期基准（修复根因③ UTC 日期偏移）
        const currentMonthStat = (stats.monthlyStats && stats.monthlyStats[currentMonth]) || {};
        const currentMonthMinutes = currentMonthStat.totalDuration || 0;

        this.setData({
          totalMinutes: currentMonthMinutes, // 当月总分钟数（云端按月聚合）
          longestCheckInDays: stats.longestCheckInDays || 0, // 最长连续天数
          currentStreak: stats.currentStreak || 0, // 当前连续天数
          medals: unlockedBadgeCount // 动态获取勋章数量
        });
      } else {
        console.error('获取云端统计信息失败:', result.result);
        // 如果云端获取失败，降级使用本地当月分钟数（离线回退）
        const unlockedBadgeCount = badgeManager.getUnlockedCount();
        this.setData({
          totalMinutes: checkinManager.getCurrentMonthMinutes(), // 离线回退：本地当月总分钟
          longestCheckInDays: 0,
          currentStreak: 0,
          medals: unlockedBadgeCount
        });
      }
    } catch (error) {
      console.error('调用云端函数失败:', error);
      // 如果云端调用失败，降级使用本地当月分钟数（离线回退）
      const unlockedBadgeCount = badgeManager.getUnlockedCount();
      this.setData({
          totalMinutes: checkinManager.getCurrentMonthMinutes(), // 离线回退：本地当月总分钟
          longestCheckInDays: 0,
          currentStreak: 0,
          medals: unlockedBadgeCount
        });
    }
  },


  /**
   * 跳转到个人信息修改页面
   */
  goToProfilePage: function() {
    console.log('跳转到个人信息修改页面');
    
    // 获取当前用户信息
    const currentUserInfo = wx.getStorageSync('userInfo');
    const userType = currentUserInfo && currentUserInfo.isCustomAvatar !== undefined ? 'custom' : 'edit';
    
    wx.navigateTo({
      url: `/pages/profile/profile?type=${userType}&from=me`
    });
  },

  /**
   * 跳转到勋章页面
   */
  goToBadgePage: function() {
    console.log('跳转到勋章页面');
    
    wx.navigateTo({
      url: '/pages/badge/badge'
    });
  },

  /**
   * 修改头像
   */
  changeAvatar: function() {
    console.log('修改头像');
    
    // 记录原头像，便于检测不通过时回滚预览
    const originalAvatar = this.data.userAvatar;
    const startingAccount = profileCache.currentAccount();
    const selectionId = this._avatarSelectionId = (this._avatarSelectionId || 0) + 1;
    const isCurrentSelection = () => selectionId === this._avatarSelectionId && profileCache.isCurrentAccount(startingAccount);
    
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        if (!isCurrentSelection()) return;
        const sourceType = res.tapIndex === 0 ? ['camera'] : ['album'];
        
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: sourceType,
          success: async (res) => {
            const tempFilePath = res.tempFiles[0].tempFilePath;
            
            // 🔍 内容安全检测：头像图片发布前必须过腾讯云 IMS 同步检测，
            // 命中违规则回滚预览、不写存储，仅提示含违规信息。
            // returnFileID 让检测通过时直接复用检测副本的 cloud:// fileID，
            // 避免把短命临时路径写入存储，也省去二次上传；cloudPrefix 指定落盘到 avatar/。
            const avatarFileID = await contentSec.checkImage(tempFilePath, {
              scene: 1,
              bizType: 'avatar',
              returnFileID: true,
              cloudPrefix: 'avatar'
            });
            if (!isCurrentSelection()) return;
            if (!avatarFileID) {
              this.setData({ userAvatar: originalAvatar });
              return;
            }

            // 用永久 cloud:// fileID 作为头像预览与存储
            this.setData({
              userAvatar: avatarFileID
            });

            try {
              const synced = await this.saveAvatarToStorage(avatarFileID);
              if (!isCurrentSelection() || synced === null) return;
              wx.showToast({
                title: synced ? '头像修改成功' : '已保存到本机，云端尚未同步',
                icon: synced ? 'success' : 'none',
                duration: 2500
              });
            } catch (error) {
              if (!isCurrentSelection()) return;
              this.setData({ userAvatar: originalAvatar });
              wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
            }
          },
          fail: (err) => {
            if (!isCurrentSelection()) return;
            console.error('选择图片失败:', err);
            wx.showToast({
              title: '选择图片失败',
              icon: 'none'
            });
          }
        });
      },
      fail: (err) => {
        console.error('显示操作菜单失败:', err);
      }
    });
  },

  /**
   * 保存头像到本地存储
   */
  async saveAvatarToStorage(avatarUrl) {
    const openid = profileCache.currentAccount();
    const patch = { avatarUrl, isCustomAvatar: true, profileComplete: true, dataSource: 'custom' };
    const requestId = this._avatarSaveRequestId = (this._avatarSaveRequestId || 0) + 1;
    const pending = profileCache.stageProfile(patch, openid);
    return this.syncUserInfoToCloud(patch, openid, pending, requestId);
  },

  /** 只提交本次修改的字段，迟到结果不得覆盖已切换的账号。 */
  async syncUserInfoToCloud(userInfo, openid = profileCache.currentAccount(), pending = profileCache.pendingSnapshot(openid), requestId = this._avatarSaveRequestId) {
    if (!openid || !checkinManager.isUserLoggedIn()) return false;
    const isCurrentRequest = () => requestId === this._avatarSaveRequestId && profileCache.isCurrentAccount(openid) &&
      Object.prototype.hasOwnProperty.call(profileCache.currentRequestPatch(userInfo, pending, openid), 'avatarUrl');
    try {
      const result = await new Promise((resolve, reject) => {
        wx.cloud.callFunction({
          name: 'meditationManager',
          data: { type: 'updateUserProfile', userInfo },
          success: response => {
            const reply = response && response.result;
            if (!reply || reply.success !== true) {
              reject(new Error(reply && reply.error || '云端尚未确认保存，请重试'));
              return;
            }
            resolve(reply);
          },
          fail: reject
        });
      });
      if (!isCurrentRequest()) return null;
      const accepted = profileCache.currentRequestPatch(userInfo, pending, openid);
      profileCache.updateProfile(profileCache.confirmedPatch(accepted, result.data && result.data.userInfo), openid);
      profileCache.acknowledgePending(accepted, pending, openid);
      this.setData({ profileSyncError: '' });
      return true;
    } catch (error) {
      console.error('用户资料尚未同步:', error);
      if (!isCurrentRequest()) return null;
      this.setData({ profileSyncError: error.message || '资料尚未同步' });
      return false;
    }
  },

  // ===== 必经之路绑定与同步 =====

  // 隐藏入口只负责发现管控页；权限每次由云函数根据调用者身份校验。
  async onVersionTap() {
    if (this._adminOpening || this._bijingOperation) return;
    const now = Date.now();
    this._versionTapCount = now - (this._versionTapAt || 0) > 2000 ? 1 : (this._versionTapCount || 0) + 1;
    this._versionTapAt = now;
    if (this._versionTapCount < 7) return;
    this._versionTapCount = 0;
    this._adminOpening = true;
    const requestId = this._adminRequestId = (this._adminRequestId || 0) + 1;
    try {
      const response = await cloudApi.callCloudFunction('adminManager', { type: 'getAccess' });
      if (this._adminHidden || requestId !== this._adminRequestId) return;
      const result = response && response.result;
      if (!result || result.success !== true) {
        const message = result && result.error || '管理员身份校验失败，请重试';
        throw new Error(/^未知操作[：:]\s*getAccess$/.test(message)
          ? '管理员身份服务尚未更新，请先部署 adminManager 云函数' : message);
      }
      if (!result.data || result.data.isAdmin !== true) return;
      wx.navigateTo({ url: '/pages/admin/admin' });
    } catch (error) {
      if (!this._adminHidden && requestId === this._adminRequestId) {
        wx.showToast({ title: error.message || '权限校验失败，请重试', icon: 'none' });
      }
    } finally {
      this._adminOpening = false;
    }
  },

  resetAdminEntry() {
    this._adminHidden = true;
    this._versionTapCount = 0;
    this._versionTapAt = 0;
    this._adminRequestId = (this._adminRequestId || 0) + 1;
  },

  openBijingHeatmap() {
    if (this._bijingOperation) return;
    const studentNumber = (this.data.bijingStudentNumber || '').trim();
    if (!checkinManager.isUserLoggedIn() || !this.data.bijingBound || !studentNumber) {
      wx.showToast({ title: '请先登录并绑定学号', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/bijingHeatmap/bijingHeatmap?studentNumber=${encodeURIComponent(studentNumber)}`
    });
  },

  bijingContext() {
    return { account: profileCache.currentAccount(), generation: this._bijingGeneration || 0 };
  },

  isBijingContextCurrent(context) {
    return !this._bijingHidden && context.generation === (this._bijingGeneration || 0) &&
      profileCache.isCurrentAccount(context.account);
  },

  beginBijingOperation(kind) {
    if (this._bijingHidden || this._bijingOperation || this._bijingSyncOperation || this.data.bijingSyncing) return null;
    const operation = { ...this.bijingContext(), kind };
    this._bijingOperation = operation;
    this._bijingStatusRequestId = (this._bijingStatusRequestId || 0) + 1;
    this.setData({ bijingBinding: kind !== 'unbind', bijingUnbinding: kind === 'unbind' });
    return operation;
  },

  finishBijingOperation(operation) {
    if (this._bijingOperation !== operation) return;
    this._bijingOperation = null;
    if (this.isBijingContextCurrent(operation)) {
      wx.hideLoading();
      this.setData({ bijingBinding: false, bijingUnbinding: false });
      if (operation.refreshStatus) this.loadBijingStatus();
    } else if (!this._bijingHidden && profileCache.isCurrentAccount(operation.account)) {
      // A page reopened while a request was pending must read fresh server state.
      this.setData({ bijingBinding: false, bijingUnbinding: false });
      this.loadBijingStatus();
    }
  },

  clearBijingBindingView() {
    this._bijingSyncDetailsRequestId++;
    this.setData({
      bijingBound: false, bijingStudentNumber: '', bijingBindingVersion: null,
      bijingShowBindInput: false, bijingInputValue: '', bijingShowConfirm: false,
      bijingPendingSn: '', bijingConfirmSn: '', bijingConfirmNickname: '',
      bijingShowSyncDatePicker: false, bijingSyncDateOptions: [], bijingSyncDate: '',
      bijingSyncDetailsLoading: false, bijingSyncDetailsError: '', bijingSyncDetailsDate: '',
      bijingSyncRecords: [], bijingSyncRecordCount: 0, bijingSyncTotalDuration: 0,
      bijingSyncDuration: 0, bijingSyncAlreadySynced: false, bijingLastSync: '', bijingIsAdmin: false
    });
  },

  clearBijingAdminAccess() {
    this._versionTapCount = 0;
    this._versionTapAt = 0;
    this._adminRequestId = (this._adminRequestId || 0) + 1;
    this.setData({ bijingIsAdmin: false });
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.clearSyncAlert === 'function') app.clearSyncAlert();
  },

  async refreshBijingAdminAccess(context) {
    this.clearBijingAdminAccess();
    try {
      const response = await cloudApi.callCloudFunction('adminManager', { type: 'getAccess' });
      if (!this.isBijingContextCurrent(context)) return;
      const result = response && response.result;
      const allowed = !!(result && result.success === true && result.data && result.data.isAdmin === true);
      this.setData({ bijingIsAdmin: allowed });
      const app = typeof getApp === 'function' ? getApp() : null;
      if (allowed && app && typeof app.refreshSyncAlert === 'function') app.refreshSyncAlert();
    } catch (error) {
      // Binding is already saved. A failed access probe must not undo it or grant access.
    }
  },

  // 已绑定账号须先解绑，不允许直接覆盖绑定。
  toggleBindInput() {
    if (this._bijingOperation || this.data.bijingSyncing || this._bijingHidden) return;
    if (this.data.bijingBound) {
      wx.showToast({ title: '请先解绑当前学号', icon: 'none' });
      return;
    }
    this.setData({ bijingShowBindInput: !this.data.bijingShowBindInput });
  },

  onBijingInput(e) {
    if (this._bijingOperation) return;
    this.setData({ bijingInputValue: e.detail.value });
  },

  async confirmBindBijing() {
    if (this.data.bijingBound) {
      wx.showToast({ title: '请先解绑当前学号', icon: 'none' });
      return;
    }
    const sn = (this.data.bijingInputValue || '').trim();
    if (!sn || !/^BJ/.test(sn)) {
      wx.showToast({ title: sn ? '学号必须以大写 BJ 开头' : '请输入学号', icon: 'none' });
      return;
    }
    if (!checkinManager.isUserLoggedIn()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    const operation = this.beginBijingOperation('check');
    if (!operation) return;
    wx.showLoading({ title: '校验中...', mask: true });
    try {
      const result = await bijingApi.checkBijing(sn);
      if (!this.isBijingContextCurrent(operation)) return;
      if (!result || !result.success) throw new Error(result && result.error || '学号不存在');
      this.setData({ bijingShowConfirm: true, bijingConfirmSn: sn,
        bijingConfirmNickname: result.data && result.data.nickname || '未获取昵称', bijingPendingSn: sn });
    } catch (error) {
      if (this.isBijingContextCurrent(operation)) wx.showToast({ title: error.message || '校验失败，请重试', icon: 'none' });
    } finally {
      this.finishBijingOperation(operation);
    }
  },

  cancelBindConfirm() {
    if (this._bijingOperation) return;
    this.setData({ bijingShowConfirm: false, bijingPendingSn: '' });
  },

  async confirmBindConfirm() {
    if (!this.data.bijingShowConfirm || this._bijingOperation) return;
    const sn = this.data.bijingPendingSn;
    this.setData({ bijingShowConfirm: false });
    await this.doBindBijing(sn);
  },

  noop() {},

  async doBindBijing(sn) {
    if (this.data.bijingBound) {
      wx.showToast({ title: '请先解绑当前学号', icon: 'none' });
      return;
    }
    if (!checkinManager.isUserLoggedIn() || typeof sn !== 'string' || !/^BJ/.test(sn)) return;
    const operation = this.beginBijingOperation('bind');
    if (!operation) return;
    wx.showLoading({ title: '绑定中...', mask: true });
    try {
      const result = await bijingApi.bindBijing(sn);
      if (!this.isBijingContextCurrent(operation)) return;
      if (!result || !result.success || !result.data || result.data.studentNumber !== sn) {
        operation.refreshStatus = !!(result && result.code === 'UNBIND_REQUIRED');
        throw new Error(result && result.error || '绑定失败，请重试');
      }
      this.clearBijingBindingView();
      const version = result.data.bindingVersion === undefined ? null : result.data.bindingVersion;
      const patch = { bijingBound: true, bijingStudentNumber: sn, bijingBindingVersion: version };
      if (result.data.nicknameOverridden && result.data.nickname) {
        patch.nickName = result.data.nickname;
      }
      this.setData({ bijingBound: true, bijingStudentNumber: sn, bijingBindingVersion: version,
        ...(patch.nickName ? { userNickname: patch.nickName } : {}) });
      try {
        if (patch.nickName) profileCache.discardPendingFields(['nickName'], operation.account);
        profileCache.updateProfile(patch, operation.account);
      } catch (error) {
        console.error('绑定已完成，本机资料缓存更新失败:', error);
      }
      wx.showToast({ title: patch.nickName ? '已绑定并同步昵称' : '绑定成功', icon: 'success' });
      await this.refreshBijingAdminAccess(operation);
    } catch (error) {
      if (this.isBijingContextCurrent(operation)) wx.showToast({ title: error.message || '绑定失败，请重试', icon: 'none' });
    } finally {
      this.finishBijingOperation(operation);
    }
  },

  async unbindBijing() {
    if (!this.data.bijingBound || !this.data.bijingStudentNumber || !checkinManager.isUserLoggedIn()) return;
    const operation = this.beginBijingOperation('unbind');
    if (!operation) return;
    const studentNumber = this.data.bijingStudentNumber;
    const bindingVersion = this.data.bijingBindingVersion;
    try {
      const confirmation = await new Promise((resolve, reject) => wx.showModal({
        title: '解绑学号',
        content: `确定解绑 ${studentNumber}？静坐记录和已同步记录会保留，自动同步将停止；该学号带来的管控权限将立即失效。更换学号需解绑后再绑定。`,
        confirmText: '解绑', confirmColor: '#a14b3c', success: resolve, fail: reject
      }));
      if (!confirmation.confirm || !this.isBijingContextCurrent(operation) ||
          !this.data.bijingBound || this.data.bijingStudentNumber !== studentNumber ||
          this.data.bijingBindingVersion !== bindingVersion) return;
      wx.showLoading({ title: '解绑中...', mask: true });
      const result = await bijingApi.unbindBijing(studentNumber, bindingVersion);
      if (!this.isBijingContextCurrent(operation)) return;
      if (!result || !result.success) {
        operation.refreshStatus = !!(result && result.code === 'BINDING_STALE');
        throw new Error(result && result.error || '解绑失败，请重试');
      }
      this.clearBijingBindingView();
      this.clearBijingAdminAccess();
      try {
        profileCache.updateProfile({ bijingBound: false, bijingStudentNumber: '', bijingBindingVersion: null }, operation.account);
      } catch (error) {
        console.error('解绑已完成，本机资料缓存更新失败:', error);
      }
      wx.showToast({ title: '已解绑，静坐记录已保留', icon: 'none' });
    } catch (error) {
      if (this.isBijingContextCurrent(operation)) wx.showToast({ title: error.message || '解绑失败，请重试', icon: 'none' });
    } finally {
      this.finishBijingOperation(operation);
    }
  },

  cancelBindBijing() {
    if (this._bijingOperation) return;
    this.setData({ bijingShowBindInput: false, bijingInputValue: '' });
  },

  invalidateBijingRequests() {
    this._bijingHidden = true;
    this._bijingGeneration = (this._bijingGeneration || 0) + 1;
    this._bijingStatusRequestId = (this._bijingStatusRequestId || 0) + 1;
    if (this._bijingOperation || this.data.bijingSyncing) wx.hideLoading();
    this.setData({ bijingShowConfirm: false, bijingPendingSn: '', bijingBinding: false,
      bijingUnbinding: false, bijingSyncing: false });
  },

  // 同步日按北京时间 02:00 至次日 02:00 划分，只提供最近七个已结束的同步日
  getBijingSyncDateOptions() {
    const now = Date.now();
    const beforeCutoff = dateUtil.getBusinessDate(now) !== new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const labels = ['昨天', '前天', '大前天'];
    return Array.from({ length: 7 }, (_, index) => {
      const daysAgo = index + 1;
      const calendarDaysAgo = daysAgo + (beforeCutoff ? 1 : 0);
      return {
        label: labels[calendarDaysAgo - 1] || `${calendarDaysAgo}天前`,
        date: dateUtil.getBusinessDate(new Date(now - daysAgo * 24 * 3600 * 1000))
      };
    });
  },

  // 先选择日期，确认后才发起同步
  syncBijingNow() {
    if (this.data.bijingSyncing || this._bijingOperation || this._bijingSyncOperation || this._bijingHidden) return;
    if (!checkinManager.isUserLoggedIn()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!this.data.bijingBound) {
      wx.showToast({ title: '请先绑定学号', icon: 'none' });
      return;
    }
    const options = this.getBijingSyncDateOptions();
    this.setData({
      bijingShowSyncDatePicker: true,
      bijingSyncDateOptions: options,
      bijingSyncDate: options[0].date
    });
    return this.loadBijingSyncDetails(options[0].date);
  },

  onBijingSyncDateChange(e) {
    const date = e.detail.value;
    if (date !== this.data.bijingSyncDate && this.data.bijingSyncDateOptions.some(option => option.date === date)) {
      this.setData({ bijingSyncDate: date });
      return this.loadBijingSyncDetails(date);
    }
  },

  cancelBijingSyncDate() {
    this._bijingSyncDetailsRequestId++;
    this.setData({ bijingShowSyncDatePicker: false, bijingSyncDetailsLoading: false });
  },

  formatBijingSyncTime(timestamp, recordDate) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '时间未记录';
    const date = new Date(timestamp + 8 * 3600 * 1000);
    if (Number.isNaN(date.getTime())) return '时间未记录';
    const isNextDay = recordDate && date.toISOString().slice(0, 10) > recordDate;
    return `${isNextDay ? '次日 ' : ''}${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  },

  async loadBijingSyncDetails(recordDate) {
    const requestId = ++this._bijingSyncDetailsRequestId;
    const context = this.bijingContext();
    const isCurrent = () => requestId === this._bijingSyncDetailsRequestId &&
      this.isBijingContextCurrent(context) && this.data.bijingShowSyncDatePicker && this.data.bijingSyncDate === recordDate;
    this.setData({
      bijingSyncDetailsLoading: true,
      bijingSyncDetailsError: '',
      bijingSyncDetailsDate: '',
      bijingSyncRecords: [],
      bijingSyncRecordCount: 0,
      bijingSyncTotalDuration: 0,
      bijingSyncDuration: 0,
      bijingSyncAlreadySynced: false
    });
    try {
      // 查看同步明细不代替用户上传本机记录，避免预览触发后台补传。
      const uploadSummary = checkinManager.getPendingSyncSummary({ date: recordDate });
      if (uploadSummary.total > 0) {
        throw new Error(uploadSummary.pending > 0
          ? `仍有 ${uploadSummary.pending} 条记录仅保存在本机，请到首页点击“手动上传”，再同步必经`
          : '当天记录正在上传，请稍后重试');
      }
      const res = await bijingApi.getBijingSyncDateDetails(recordDate);
      if (!isCurrent()) return;
      const latestUploadSummary = checkinManager.getPendingSyncSummary({ date: recordDate });
      if (latestUploadSummary.total > 0) {
        throw new Error(latestUploadSummary.pending > 0
          ? '有记录尚未上传，请重试加载明细后再同步'
          : '当天记录正在上传，请稍后重试');
      }
      if (!res.success) throw new Error(res.error || '获取明细失败');
      const details = res.data;
      if (!details || details.date !== recordDate || !Array.isArray(details.records)) {
        throw new Error('获取明细失败，请重试');
      }
      this.setData({
        bijingSyncDetailsDate: recordDate,
        bijingSyncRecords: details.records.map(record => ({
          ...record,
          timeLabel: this.formatBijingSyncTime(record.timestamp, recordDate),
          durationText: Number(Number(record.duration).toFixed(2))
        })),
        bijingSyncRecordCount: details.count,
        bijingSyncTotalDuration: Number(Number(details.totalDuration).toFixed(2)),
        bijingSyncDuration: details.syncDuration,
        bijingSyncAlreadySynced: !!details.alreadySynced
      });
    } catch (e) {
      if (isCurrent()) this.setData({ bijingSyncDetailsError: e.message || '获取明细失败，请重试' });
    } finally {
      if (isCurrent()) this.setData({ bijingSyncDetailsLoading: false });
    }
  },

  retryBijingSyncDetails() {
    if (this.data.bijingSyncDetailsLoading || !this.data.bijingShowSyncDatePicker) return;
    const options = this.getBijingSyncDateOptions();
    const recordDate = options.some(option => option.date === this.data.bijingSyncDate)
      ? this.data.bijingSyncDate : options[0].date;
    this.setData({ bijingSyncDateOptions: options, bijingSyncDate: recordDate });
    return this.loadBijingSyncDetails(recordDate);
  },

  async confirmBijingSyncDate() {
    if (this.data.bijingSyncing || this._bijingOperation || this._bijingSyncOperation || this._bijingHidden) return;
    if (!checkinManager.isUserLoggedIn() || !this.data.bijingBound) {
      wx.showToast({ title: '请先登录并绑定学号', icon: 'none' });
      return;
    }
    const recordDate = this.data.bijingSyncDate;
    // 弹窗跨过北京时间 02:00 时重新校验，不能提交已经超出最近七个同步日的日期
    const options = this.getBijingSyncDateOptions();
    if (!options.some(option => option.date === recordDate)) {
      this.setData({ bijingSyncDateOptions: options, bijingSyncDate: options[0].date });
      this.loadBijingSyncDetails(options[0].date);
      wx.showToast({ title: '可选日期已更新，请重新选择', icon: 'none' });
      return;
    }
    if (this.data.bijingSyncDetailsLoading) {
      wx.showToast({ title: '明细加载中，请稍候', icon: 'none' });
      return;
    }
    if (this.data.bijingSyncDetailsError || this.data.bijingSyncDetailsDate !== recordDate) {
      wx.showToast({ title: '请先重试加载当天明细', icon: 'none' });
      return;
    }
    const uploadSummary = checkinManager.getPendingSyncSummary({ date: recordDate });
    if (uploadSummary.total > 0) {
      this.setData({ bijingSyncDetailsError: uploadSummary.pending > 0
        ? '有记录尚未上传，请重试加载明细后再同步'
        : '当天记录正在上传，请稍后重试' });
      wx.showToast({ title: uploadSummary.pending > 0
        ? '有记录待上传，请先重试加载明细'
        : '当天记录正在上传，请稍后重试', icon: 'none' });
      return;
    }
    if (!this.data.bijingSyncRecordCount || this.data.bijingSyncDuration <= 0) {
      wx.showToast({ title: '当天暂无可同步的时长', icon: 'none' });
      return;
    }
    this.setData({ bijingSyncing: true, bijingShowSyncDatePicker: false });
    const context = this._bijingSyncOperation = this.bijingContext();
    wx.showLoading({ title: '同步中...', mask: true });
    let message;
    try {
      const res = await bijingApi.syncBijingDate(recordDate);
      if (!res.success) {
        throw new Error(res.error || '请稍后重试');
      }
      const result = res.data || {};
      if (result.success) {
        message = `${recordDate} 已同步 ${result.duration} 分钟`;
      } else if (result.skipped && result.reason === '已同步') {
        // 兼容尚未更新的云函数：这次被跳过，不能误报失败或已重新同步成功。
        message = `${recordDate} 此前已同步，本次未更新`;
      } else if (result.skipped && result.duration === 0) {
        message = `${recordDate} 暂无打卡记录`;
      } else {
        throw new Error(result.error || result.reason || '请稍后重试');
      }
    } catch (e) {
      message = `${recordDate} 同步失败：${e.message || '请稍后重试'}`;
    } finally {
      if (this._bijingSyncOperation === context) this._bijingSyncOperation = null;
      if (this.isBijingContextCurrent(context)) {
        wx.hideLoading();
        this.setData({ bijingSyncing: false });
      }
    }
    if (!this.isBijingContextCurrent(context)) return;
    this.setData({ bijingLastSync: message });
    wx.showToast({ title: message, icon: 'none', duration: 3000 });
  },

  onReady() {

  },

  onHide() {
    this.resetAdminEntry();
    this.invalidateBijingRequests();
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    this.cancelBijingSyncDate();
  },

  onUnload() {
    this.resetAdminEntry();
    this.invalidateBijingRequests();
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    this._bijingSyncDetailsRequestId++;
  },

  onPullDownRefresh() {

  },

  onReachBottom() {

  },

  onShareAppMessage() {

  }
})
