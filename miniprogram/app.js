// app.js
const checkinManager = require('./utils/checkin.js');

App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    
    // 初始化云开发
    wx.cloud.init({
      // 明确指定环境ID
      env: 'cloud1-2g2rbxbu2c126d4a',
      traceUser: true
    });
    
    console.log('云开发初始化完成');
    this.setupRecordRefresh();
    
    // 设置缓存状态标记
    this.setupCacheStatus();
    
    // 测试云环境连接
    this.testCloudEnvironment();
    
    // 设置音频选项，解决iOS静音模式下无声音问题
    this.setAudioOptions();
    
    // 注意：数据库集合只需在项目部署时创建一次
    // 如需创建数据库集合，请手动调用 autoCreateCollections 云函数
    // this.autoCreateCollections();
  },

  onShow() {
    if (!wx.cloud) return;
    this.startSyncAlertRefresh();
    // 打开/返回小程序补传当天记录，同时读取云端；历史记录仍需手动确认。
    const refresh = this.refreshRecordBackups();
    const upload = Promise.resolve().then(() => checkinManager.retryTodayBackups()).catch(error => {
      console.warn('当天记录自动上传失败，保留本机记录:', error);
    });
    return Promise.all([refresh, upload]);
  },

  onHide() {
    this._syncAlertVisible = false;
    this.clearSyncAlert();
  },

  syncAlertIdentity() {
    try { return typeof wx.getStorageSync === 'function' ? wx.getStorageSync('userOpenId') || '' : ''; }
    catch (error) { return ''; }
  },
  setSyncAlertDot(visible) {
    const action = visible ? wx.showTabBarRedDot : wx.hideTabBarRedDot;
    if (typeof action === 'function') action.call(wx, { index: 3, fail() {} });
  },
  getSyncAlertState() {
    const state = this._syncAlertState || {};
    const current = this._syncAlertVisible && this._syncAlertAccount === this.syncAlertIdentity();
    return { admin: !!(current && state.admin), user: !!(current && state.user) };
  },
  watchSyncAlerts(listener) {
    if (!this._syncAlertListeners) this._syncAlertListeners = new Set();
    this._syncAlertListeners.add(listener);
    listener(this.getSyncAlertState());
    return () => this._syncAlertListeners.delete(listener);
  },
  applySyncAlertDot() {
    const state = this.getSyncAlertState();
    this.setSyncAlertDot(state.admin || state.user);
    if (this._syncAlertListeners) this._syncAlertListeners.forEach(listener => {
      try { listener({ ...state }); }
      catch (error) { console.warn('更新提醒入口失败:', error); }
    });
  },
  clearAdminSyncAlert() {
    this._adminAlertGeneration = (this._adminAlertGeneration || 0) + 1;
    if (this._syncAlertState) this._syncAlertState.admin = false;
    this.applySyncAlertDot();
  },
  clearSyncAlert({ preserveState = false } = {}) {
    const state = preserveState && this._syncAlertAccount === this.syncAlertIdentity() ? this._syncAlertState : null;
    this._syncAlertGeneration = (this._syncAlertGeneration || 0) + 1;
    this._syncAlertRequest = null;
    if (this._syncAlertCancel) this._syncAlertCancel();
    this._syncAlertCancel = null;
    this._syncAlertState = state || { admin: false, user: false };
    this.applySyncAlertDot();
  },
  startSyncAlertRefresh() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function' || typeof wx.showTabBarRedDot !== 'function') return;
    // 同一次前台期间只自动读取一轮，重复生命周期通知复用当前结果。
    if (this._syncAlertVisible) return this._syncAlertRequest || Promise.resolve();
    this._syncAlertVisible = true;
    this.clearSyncAlert();
    return this.refreshSyncAlert();
  },
  // 管理员待办与本人的反馈处理结果独立核对，共用“我”的红点。
  // 仅打开/返回小程序时自动刷新；页面切换使用缓存，不轮询或自动重试。
  // 账号/权限变化、处理/删除/已读成功后可主动刷新，核对剩余提醒。
  refreshSyncAlert({ force = false } = {}) {
    if (!this._syncAlertVisible || !wx.cloud || typeof wx.cloud.callFunction !== 'function') return Promise.resolve();
    const identity = this.syncAlertIdentity();
    if (force || identity !== this._syncAlertAccount) this.clearSyncAlert({ preserveState: identity === this._syncAlertAccount });
    if (this._syncAlertRequest) return this._syncAlertRequest;
    this._syncAlertAccount = identity;
    const generation = this._syncAlertGeneration;
    const adminGeneration = this._adminAlertGeneration;
    const cancellations = [];
    const current = () => this._syncAlertVisible && generation === this._syncAlertGeneration && identity === this.syncAlertIdentity();
    const read = (source, name, type, hasAlert) => {
      let deadline;
      const valid = () => current() && (source !== 'admin' || adminGeneration === this._adminAlertGeneration);
      return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(deadline); reject(new Error('提醒已暂停')); };
        cancellations.push(cancel);
        deadline = setTimeout(() => reject(new Error('提醒请求超时')), 10000);
        wx.cloud.callFunction({ name, data: { type }, success: resolve, fail: reject });
      }).then(response => {
        if (!valid()) return;
        const result = response && response.result;
        if (!result || result.success !== true || !result.data) throw new Error('提醒读取失败');
        this._syncAlertState[source] = hasAlert(result.data);
        this.applySyncAlertDot();
      }).catch(() => {
        if (!valid()) return;
        // 读取失败不能确认已无未读；保留同一账号上次已确认的提醒。
        this.applySyncAlertDot();
      }).finally(() => clearTimeout(deadline));
    };
    this._syncAlertCancel = () => cancellations.forEach(cancel => cancel());
    const request = Promise.all([
      read('admin', 'adminManager', 'getSyncAlert', data => {
        if (typeof data.isAdmin !== 'boolean') throw new Error('管理员提醒数据无效');
        return data.isAdmin && (data.hasErrors === true || data.hasFeedback === true);
      }),
      read('user', 'meditationManager', 'getFeedbackAlert', data => {
        if (typeof data.hasUnreadFeedback !== 'boolean') throw new Error('反馈提醒数据无效');
        return data.hasUnreadFeedback;
      })
    ]).finally(() => {
      if (generation !== this._syncAlertGeneration) return;
      this._syncAlertRequest = null;
      this._syncAlertCancel = null;
      if (!this._syncAlertVisible) return;
      if (identity !== this.syncAlertIdentity()) {
        this.applySyncAlertDot();
      }
    });
    this._syncAlertRequest = request;
    return request;
  },

  setupRecordRefresh() {
    if (this._networkStatusHandler) return;
    this._networkStatusHandler = ({ isConnected }) => {
      if (isConnected) this.refreshRecordBackups();
    };
    wx.onNetworkStatusChange(this._networkStatusHandler);
  },

  refreshRecordBackups() {
    // 网络状态变化只刷新；当天补传由 onShow 单独触发，不弹全局加载框。
    return Promise.resolve().then(() => checkinManager.syncWithCloud({ uploadPending: false })).catch(error => {
      console.warn('读取云端静坐记录失败，保留本机记录:', error);
    });
  },
  
  // 测试云环境连接
  testCloudEnvironment: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      console.log('🔍 开始测试云环境连接...');
      
      // 测试云存储连接（使用实际存在的文件路径）
      wx.cloud.getTempFileURL({
        fileList: ['cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/bg1.jpeg'],
        success: (res) => {
          if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
            console.log('✅ 云存储连接成功，可以正常访问背景图片');
          } else {
            console.warn('⚠️ 云存储文件不存在，将使用本地图片');
          }
        },
        fail: (err) => {
          console.warn('⚠️ 云存储连接失败，将使用本地图片:', err);
        }
      });
      
    }, 500); // 延迟500毫秒执行
  },
  
  // 设置缓存状态标记
  setupCacheStatus: function() {
    try {
      console.log('🔍 设置缓存状态标记...');
      
      // 检查是否首次启动或缓存已清除
      const cacheStatus = wx.getStorageSync('cacheStatus');
      if (!cacheStatus) {
        console.log('✅ 设置初始缓存状态标记');
        wx.setStorageSync('cacheStatus', 'initialized');
        wx.setStorageSync('needsRecovery', true);
      } else {
        console.log('✅ 缓存状态标记已存在:', cacheStatus);
      }
      
      // 检查应用版本，版本变更时可能需要数据恢复
      const CURRENT_VERSION = '1.0.0';
      const storedVersion = wx.getStorageSync('appVersion');
      
      if (storedVersion !== CURRENT_VERSION) {
        console.log('🔄 检测到版本变更，设置恢复标记');
        wx.setStorageSync('appVersion', CURRENT_VERSION);
        wx.setStorageSync('needsRecovery', true);
      }
      
    } catch (error) {
      console.warn('⚠️ 设置缓存状态标记失败:', error);
    }
  },
  
  // 设置音频选项
  setAudioOptions: function() {
    try {
      wx.setInnerAudioOption({
        obeyMuteSwitch: false,  // 不遵循静音开关，iOS静音模式下也能播放声音
        success: () => {
          console.log('✅ 音频选项设置成功，iOS静音模式可播放声音');
        },
        fail: (err) => {
          console.warn('⚠️ 音频选项设置失败:', err);
        }
      });
    } catch (error) {
      console.warn('⚠️ 设置音频选项时出错:', error);
    }
  },

  // 自动创建数据库集合
  autoCreateCollections: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      wx.cloud.callFunction({
        name: 'autoCreateCollections',
        success: res => {
          console.log('数据库集合自动创建结果:', res.result);
          if (res.result.success) {
            console.log('✅ 数据库集合创建成功');
            // 可以在这里添加成功后的回调逻辑
          } else {
            console.warn('⚠️ 数据库集合创建部分成功:', res.result.message);
          }
        },
        fail: err => {
          console.warn('⚠️ 数据库集合创建失败（可能是云函数未上传）:', err);
          // 忽略初始化错误，不影响小程序正常使用
        }
      });
    }, 1000); // 延迟1秒执行
  }
});
