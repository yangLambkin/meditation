// pages/me/me.js
Page({
  data: {
    userNickname: '觉察者', // 用户昵称
    userAvatar: '/images/avatar.png', // 用户头像，默认使用项目头像
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
        userAvatar: '/images/avatar.png',
        hasUserInfo: false
      });
    }
  },

  /**
   * 计算用户统计信息
   */
  calculateUserStatistics() {
    // 获取用户ID
    const userOpenId = wx.getStorageSync('localUserId');
    if (!userOpenId) {
      console.log('未找到用户ID');
      return;
    }

    // 获取用户的所有打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[userOpenId];

    if (!userRecords || !userRecords.dailyRecords) {
      console.log('未找到用户打卡记录');
      return;
    }

    // 计算总分钟数
    const totalMinutes = this.calculateTotalMinutes(userRecords.dailyRecords);
    
    // 计算连续天数
    const consecutiveDays = this.calculateConsecutiveDays(userRecords.dailyRecords);
    
    // 计算当前连续天数
    const currentStreak = this.calculateCurrentStreak(userRecords.dailyRecords);

    // 更新页面数据
    this.setData({
      totalMinutes: totalMinutes,
      consecutiveDays: consecutiveDays,
      currentStreak: currentStreak
    });

    console.log('用户统计信息:', {
      总分钟数: totalMinutes,
      最长连续天数: consecutiveDays,
      当前连续天数: currentStreak
    });
  },

  /**
   * 计算当月总分钟数
   */
  calculateTotalMinutes(dailyRecords) {
    let totalMinutes = 0;
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    
    Object.entries(dailyRecords).forEach(([dateStr, record]) => {
      // 只统计当月的数据
      const [year, month] = dateStr.split('-').map(Number);
      if (year === currentYear && month === currentMonth) {
        if (record.durations) {
          record.durations.forEach(duration => {
            // 确保duration是数字类型
            totalMinutes += parseInt(duration) || 0;
          });
        }
      }
    });
    
    return totalMinutes;
  },

  /**
   * 计算最长连续天数
   */
  calculateConsecutiveDays(dailyRecords) {
    const dates = Object.keys(dailyRecords).sort();
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    let prevDate = null;

    dates.forEach(dateStr => {
      const currentDate = new Date(dateStr);
      
      if (prevDate === null) {
        currentConsecutive = 1;
      } else {
        const diffDays = Math.floor((currentDate - prevDate) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          currentConsecutive++;
        } else if (diffDays > 1) {
          maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
          currentConsecutive = 1;
        }
      }
      
      prevDate = currentDate;
    });

    maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    return maxConsecutive;
  },

  /**
   * 计算当前连续天数
   */
  calculateCurrentStreak(dailyRecords) {
    const today = new Date();
    const todayStr = this.formatDate(today);
    const dates = Object.keys(dailyRecords).sort().reverse();
    
    let currentStreak = 0;
    let checkDate = new Date(today);
    
    // 检查今天是否打卡
    if (dates.includes(todayStr)) {
      currentStreak = 1;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    
    // 检查之前的连续天数
    while (true) {
      const checkDateStr = this.formatDate(checkDate);
      if (dates.includes(checkDateStr)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    
    return currentStreak;
  },

  /**
   * 格式化日期为 YYYY-MM-DD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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