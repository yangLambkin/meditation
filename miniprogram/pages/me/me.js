// pages/me/me.js
Page({
  data: {
    userNickname: '觉察者', // 用户昵称
    userAvatar: '/images/userLogin.png', // 用户头像，默认使用用户登录头像
    totalMinutes: 0, // 总分钟数
    consecutiveDays: 0, // 连续天数
    currentStreak: 0, // 当前连续天数
    medals: 0, // 勋章数量
    hasUserInfo: false // 是否已获取用户信息
  },

  onLoad(options) {
    // 获取用户数据
    this.getUserData();
  },

  onShow() {
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
    
    // 获取用户统计信息
    this.calculateUserStatistics();
  },

  /**
   * 获取用户昵称
   */
  getUserNickname() {
    // 尝试从缓存获取用户昵称
    const cachedNickname = wx.getStorageSync('userNickname');
    if (cachedNickname) {
      this.setData({
        userNickname: cachedNickname,
        hasUserInfo: true
      });
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
        hasUserInfo: false
      });
    }
  },

  /**
   * 计算用户统计信息
   */
  async calculateUserStatistics() {
    // 检查用户是否已登录
    const userOpenId = wx.getStorageSync('userOpenId');
    
    console.log('me.js检查用户登录状态:', {
      userOpenId: userOpenId,
      isLoggedIn: userOpenId && userOpenId.startsWith('oz'),
      currentTime: new Date().toISOString()
    });
    
    if (userOpenId && userOpenId.startsWith('oz')) {
      // 已登录用户（微信openid以'oz'开头）：从云端user_stats表获取数据
      console.log('用户已登录，从云端获取统计信息');
      await this.getUserStatisticsFromCloud(userOpenId);
    } else {
      // 未登录用户：显示0
      console.log('用户未登录，显示默认值0');
        this.setData({
          totalMinutes: 0,
          consecutiveDays: 0,
          currentStreak: 0,
          medals: 0
        });
    }
  },

  /**
   * 从云端获取用户统计信息
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
        
        this.setData({
          totalMinutes: stats.monthlyTotalDuration || 0, // 当月总分钟数
          consecutiveDays: stats.longestCheckInDays || 0, // 最长连续天数
          currentStreak: stats.currentStreak || 0, // 当前连续天数
          medals: 0 // 勋章功能待开发
        });
      } else {
        console.error('获取云端统计信息失败:', result.result);
        // 如果云端获取失败，显示0
        this.setData({
          totalMinutes: 0,
          consecutiveDays: 0,
          currentStreak: 0,
          medals: 0
        });
      }
    } catch (error) {
      console.error('调用云端函数失败:', error);
      // 如果云端调用失败，显示0
        this.setData({
          totalMinutes: 0,
          consecutiveDays: 0,
          currentStreak: 0,
          medals: 0
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
   * 修改头像
   */
  changeAvatar: function() {
    console.log('修改头像');
    
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        const sourceType = res.tapIndex === 0 ? ['camera'] : ['album'];
        
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: sourceType,
          success: (res) => {
            const tempFilePath = res.tempFiles[0].tempFilePath;
            
            // 更新头像显示
            this.setData({
              userAvatar: tempFilePath
            });
            
            // 保存到本地存储
            this.saveAvatarToStorage(tempFilePath);
            
            wx.showToast({
              title: '头像修改成功',
              icon: 'success',
              duration: 1500
            });
          },
          fail: (err) => {
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
  saveAvatarToStorage: function(avatarUrl) {
    const currentUserInfo = wx.getStorageSync('userInfo') || {};
    
    // 更新用户信息
    const updatedUserInfo = {
      ...currentUserInfo,
      avatarUrl: avatarUrl,
      isCustomAvatar: true,
      profileComplete: true,
      dataSource: 'custom',
      lastUpdateTime: new Date().toISOString()
    };
    
    wx.setStorageSync('userInfo', updatedUserInfo);
    
    // 同步到云端
    this.syncUserInfoToCloud(updatedUserInfo);
  },

  /**
   * 同步用户信息到云端
   */
  syncUserInfoToCloud: function(userInfo) {
    const openid = wx.getStorageSync('userOpenId');
    
    if (!openid) {
      console.warn('无法同步用户信息：缺少openid');
      return;
    }
    
    wx.cloud.callFunction({
      name: 'meditationManager',
      data: {
        type: 'updateUserProfile',
        openid: openid,
        userInfo: userInfo
      },
      success: (res) => {
        console.log('用户信息同步到云端成功:', res);
      },
      fail: (err) => {
        console.error('用户信息同步到云端失败:', err);
      }
    });
  },

  onReady() {

  },

  onHide() {

  },

  onUnload() {

  },

  onPullDownRefresh() {

  },

  onReachBottom() {

  },

  onShareAppMessage() {

  }
})