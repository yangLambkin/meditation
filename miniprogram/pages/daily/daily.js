Page({
  data: {
    backgroundImage: '', // 背景图片URL
    year: 2026, // 年份
    month: 1, // 月份
    day: 23, // 日期
    weekDay: '星期五', // 星期
    lunarDate: '农历腊月初五', // 农历日期
    userName: '静心者', // 用户名
    userAvatar: '/images/avatar.png', // 用户头像，默认使用项目头像
    userLevel: 'Lv.3 修行中', // 用户等级
    totalMinutes: 0, // 本次打卡静坐分钟数
    totalCount: 43 // 累计打卡次数
  },

  onLoad(options) {
    // 页面加载时设置背景图片
    this.setBackgroundImage();
    
    // 设置当前日期信息
    this.setCurrentDateInfo();
    
    // 调试：检查数据是否正确绑定
    console.log('页面加载，totalMinutes:', this.data.totalMinutes);
  },

  /**
   * 设置背景图片
   */
  setBackgroundImage: function() {
    // 使用本地images文件夹下的bg1.jpeg文件
    const localImagePath = '/images/bg1.jpeg';
    
    console.log('设置背景图片:', localImagePath);
    
    // 直接设置本地图片路径
    this.setData({
      backgroundImage: localImagePath
    });
    
    console.log('背景图片设置成功');
  },

  /**
   * 设置当前日期信息
   */
  setCurrentDateInfo: function() {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    
    // 获取星期几
    const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekDay = weekDays[today.getDay()];
    
    // 计算农历日期（简化版，实际应用中可以使用更精确的农历库）
    const lunarDate = this.getLunarDate(today);
    
    // 获取用户数据
    this.getUserData();
    
    // 更新页面显示
    this.setData({
      year: year,
      month: month,
      day: day,
      weekDay: weekDay,
      lunarDate: lunarDate
    });
    
    console.log(`打卡日期: ${year}.${month} ${weekDay} ${lunarDate}`);
  },

  /**
   * 格式化时间显示（直接显示分钟数）
   */
  formatTime: function(minutes) {
    return `${minutes}分钟`;
  },

  /**
   * 获取用户数据
   */
  getUserData: function() {
    // 尝试从缓存获取用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    if (cachedUserInfo) {
      // 使用缓存的用户信息
      this.setData({
        userName: cachedUserInfo.nickName || '觉察者',
        userAvatar: cachedUserInfo.avatarUrl || '/images/avatar.png'
      });
    } else {
      // 检查用户是否已授权
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.userInfo']) {
            // 用户已授权，获取用户信息
            wx.getUserInfo({
              success: (userRes) => {
                const userInfo = userRes.userInfo;
                
                // 缓存用户信息
                wx.setStorageSync('userInfo', userInfo);
                
                // 更新页面显示
                this.setData({
                  userName: userInfo.nickName,
                  userAvatar: userInfo.avatarUrl
                });
                
                console.log('获取到用户头像:', userInfo.avatarUrl);
              },
              fail: (err) => {
                console.warn('获取用户信息失败:', err);
              }
            });
          } else {
            console.log('用户未授权，使用默认头像');
          }
        },
        fail: (err) => {
          console.warn('检查授权设置失败:', err);
        }
      });
    }
    
    // 获取用户打卡统计数据
    this.calculateUserStats();
  },

  /**
   * 计算用户统计数据
   */
  calculateUserStats: function() {
    const userOpenId = wx.getStorageSync('localUserId');
    if (!userOpenId) return;

    // 获取用户的所有打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[userOpenId];

    if (!userRecords || !userRecords.dailyRecords) return;

    // 计算总打卡次数
    const totalCount = Object.keys(userRecords.dailyRecords).length;
    
    // 计算本次打卡的静坐时长（当天最后一次打卡的时长）
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    let currentMinutes = 0;
    const todayRecord = userRecords.dailyRecords[todayStr];
    
    if (todayRecord && todayRecord.durations && todayRecord.durations.length > 0) {
      // 取当天最后一次打卡的时长
      currentMinutes = parseInt(todayRecord.durations[todayRecord.durations.length - 1]) || 0;
    }
    
    // 计算用户等级（基于累计总分钟数）
    let totalMinutes = 0;
    Object.values(userRecords.dailyRecords).forEach(record => {
      if (record.durations) {
        record.durations.forEach(duration => {
          totalMinutes += parseInt(duration) || 0;
        });
      }
    });
    
    const userLevel = this.calculateUserLevel(totalMinutes);

    this.setData({
      totalMinutes: currentMinutes, // 显示本次打卡时长
      totalCount: totalCount,
      userLevel: userLevel
    });
    
    console.log('本次打卡时长:', currentMinutes + '分钟');
  },

  /**
   * 计算用户等级
   */
  calculateUserLevel: function(totalMinutes) {
    if (totalMinutes >= 10080) return 'Lv.10 禅定大师';
    if (totalMinutes >= 5040) return 'Lv.9 静心高手';
    if (totalMinutes >= 2520) return 'Lv.8 修行达人';
    if (totalMinutes >= 1260) return 'Lv.7 精进者';
    if (totalMinutes >= 600) return 'Lv.6 坚持者';
    if (totalMinutes >= 300) return 'Lv.5 探索者';
    if (totalMinutes >= 150) return 'Lv.4 初学者';
    if (totalMinutes >= 60) return 'Lv.3 修行中';
    if (totalMinutes >= 30) return 'Lv.2 入门者';
    return 'Lv.1 新手上路';
  },

  /**
   * 获取农历日期（简化版）
   * 实际应用中建议使用完整的农历库
   */
  getLunarDate: function(solarDate) {
    const year = solarDate.getFullYear();
    const month = solarDate.getMonth() + 1;
    const day = solarDate.getDate();
    
    // 简化版农历转换，实际需要完整的农历算法
    // 这里使用一个简单的映射作为示例
    const lunarMonths = ['正月', '二月', '三月', '四月', '五月', '六月', 
                         '七月', '八月', '九月', '十月', '冬月', '腊月'];
    
    // 简单计算农历月份（实际算法复杂）
    let lunarMonth = Math.max(1, (month + 1) % 12);
    let lunarDay = day;
    
    // 如果是月末，可能会有特殊处理
    if (day > 28) {
      lunarDay = Math.min(30, lunarDay);
    }
    
    return `农历${lunarMonths[lunarMonth - 1]}${lunarDay}日`;
  },

  // 重写页面返回逻辑
  onUnload() {
    // 页面返回时跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  // 自定义返回按钮点击事件
  onBack() {
    // 直接跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  onShareAppMessage() {
    return {};
  },
});