// pages/index/index.js
Page({
  data: {
    currentYear: 2026,
    currentMonth: 1,
    calendarDays: [],
    checkedDates: [], // 存储已打卡的日期
    todayDate: "", // 今天的日期
    userOpenId: '', // 当前用户标识
    monthlyCount: 0, // 本月打卡总次数
    userNickname: '觉察者', // 用户昵称，默认为"觉察者"
    wisdomQuote: '"静心即是修心，心安即是归处。"', // 每日一言金句
    currentUserRank: 1 // 当前用户排名，默认为1
  },

  /**
   * 获取用户openId
   */
  getUserOpenId: function() {
    // 使用本地生成的唯一ID作为用户标识
    const localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      const newLocalUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', newLocalUserId);
      this.setData({
        userOpenId: newLocalUserId
      }, () => {
        // 用户ID设置完成后更新数据
        this.generateCalendar();
        this.updateMonthlyCount();
        // 获取用户昵称
        this.getUserNickname();
        // 计算用户排名
        this.calculateUserRank();
      });
    } else {
      this.setData({
        userOpenId: localUserId
      }, () => {
        // 用户ID设置完成后更新数据
        this.generateCalendar();
        this.updateMonthlyCount();
        // 获取用户昵称
        this.getUserNickname();
        // 计算用户排名
        this.calculateUserRank();
      });
    }
  },

  /**
   * 获取用户微信昵称
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
    
    // 检查用户是否已授权
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.userInfo']) {
          // 用户已授权，获取用户信息
          wx.getUserInfo({
            success: (userRes) => {
              const nickname = userRes.userInfo.nickName;
              console.log('获取到用户昵称:', nickname);
              
              // 保存到缓存
              wx.setStorageSync('userNickname', nickname);
              
              // 更新页面显示
              this.setData({
                userNickname: nickname
              });
            },
            fail: (err) => {
              console.warn('获取用户信息失败:', err);
              // 使用默认昵称
              this.setData({
                userNickname: '觉察者'
              });
            }
          });
        } else {
          // 用户未授权，使用默认昵称
          console.log('用户未授权，使用默认昵称');
          this.setData({
            userNickname: '觉察者'
          });
        }
      },
      fail: (err) => {
        console.warn('检查授权设置失败:', err);
        // 出错时使用默认昵称
        this.setData({
          userNickname: '觉察者'
        });
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
   * 计算用户排名
   */
  calculateUserRank: function() {
    // 获取所有用户数据
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const currentUserId = this.data.userOpenId;
    const today = new Date().toISOString().split('T')[0];
    
    // 如果没有用户数据或当前用户ID为空，设置默认排名为1
    if (Object.keys(allUserRecords).length === 0 || !currentUserId) {
      this.setData({
        currentUserRank: 1
      });
      return;
    }
    
    // 计算每个用户当天的累计时长
    const userDurations = [];
    
    Object.keys(allUserRecords).forEach(userId => {
      const userRecords = allUserRecords[userId];
      const todayRecord = userRecords.dailyRecords[today];
      
      let totalDuration = 0;
      if (todayRecord && todayRecord.durations) {
        totalDuration = todayRecord.durations.reduce((sum, duration) => {
          return sum + parseInt(duration) || 0;
        }, 0);
      }
      
      userDurations.push({
        userId: userId,
        duration: totalDuration
      });
    });
    
    // 按时长降序排序
    userDurations.sort((a, b) => b.duration - a.duration);
    
    // 计算当前用户排名
    let currentUserRank = 0;
    for (let i = 0; i < userDurations.length; i++) {
      if (userDurations[i].userId === currentUserId) {
        currentUserRank = i + 1;
        break;
      }
    }
    
    // 如果没有找到当前用户（新用户），排名为用户总数+1
    if (currentUserRank === 0) {
      currentUserRank = userDurations.length + 1;
    }
    
    this.setData({
      currentUserRank: currentUserRank
    });
    
    console.log(`用户排名计算完成：第${currentUserRank}名，总用户数：${userDurations.length}`);
  },

  /**
   * 更新本月打卡次数
   */
  updateMonthlyCount: function() {
    const currentYear = this.data.currentYear;
    const currentMonth = this.data.currentMonth;
    
    if (!this.data.userOpenId) {
      this.setData({
        monthlyCount: 0
      });
      return;
    }
    
    // 获取当前用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[this.data.userOpenId];
    
    if (!userRecords || !userRecords.dailyRecords) {
      this.setData({
        monthlyCount: 0
      });
      return;
    }
    
    // 计算本月累计打卡总次数
    let monthlyCount = 0;
    Object.keys(userRecords.dailyRecords).forEach(dateStr => {
      const [year, month] = dateStr.split('-').map(Number);
      if (year === currentYear && month === currentMonth) {
        const dailyRecord = userRecords.dailyRecords[dateStr];
        monthlyCount += dailyRecord.count || 0;
      }
    });
    
    // 更新页面上的打卡次数显示
    this.setData({
      monthlyCount: monthlyCount
    });
    
    console.log(`本月累计打卡次数: ${monthlyCount}`);
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
   * 检查某日期当前用户是否已打卡
   */
  isDateChecked: function(dateStr) {
    if (!this.data.userOpenId) {
      return false;
    }
    
    // 获取所有用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[this.data.userOpenId];
    
    if (!userRecords || !userRecords.dailyRecords) {
      return false;
    }
    
    const dailyRecord = userRecords.dailyRecords[dateStr];
    
    // 只要当天有打卡记录（次数>=1），就显示为已打卡
    return dailyRecord && dailyRecord.count > 0;
  },

  /**
   * 生成日历数据
   */
  generateCalendar: function() {
    const year = this.data.currentYear;
    const month = this.data.currentMonth;
    
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
        isToday: false,
        isChecked: this.isDateChecked(fullDate)
      });
    }
    
    // 添加当前月的日期
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
    
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
        isToday: false,
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
   * 获取随机金句
   */
  getRandomWisdom: function() {
    wx.cloud.callFunction({
      name: 'getRandomWisdom',
      success: res => {
        if (res.result.success && res.result.data) {
          this.setData({
            wisdomQuote: '"' + res.result.data.content + '"'
          });
          console.log('index页面获取金句成功:', res.result.data.content);
        } else {
          console.warn('index页面获取金句失败，使用默认金句');
        }
      },
      fail: err => {
        console.error('index页面调用云函数失败:', err);
        // 使用默认金句
      }
    });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const today = new Date();
    this.setData({
      currentYear: today.getFullYear(),
      currentMonth: today.getMonth() + 1
    });
    
    // 获取用户标识，完成后会自动更新数据
    this.getUserOpenId();
    
    // 获取随机金句
    this.getRandomWisdom();
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
    // 重新生成日历，确保显示最新的打卡状态
    this.generateCalendar();
    
    // 更新本月打卡次数显示
    this.updateMonthlyCount();
    
    // 更新用户排名显示
    this.calculateUserRank();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

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