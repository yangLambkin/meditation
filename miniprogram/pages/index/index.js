// pages/index/index.js
Page({
  data: {
    currentYear: 2026,
    currentMonth: 1,
    calendarDays: [],
    checkedDates: [], // 存储已打卡的日期
    todayDate: "" // 今天的日期
  },

  /**
   * 开始静坐打卡
   */
  startMeditation: function() {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    const todayStr = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    
    // 添加打卡记录（无论是否已打卡都记录）
    let checkedDates = this.data.checkedDates;
    if (!checkedDates.includes(todayStr)) {
      checkedDates.push(todayStr);
      this.setData({
        checkedDates: checkedDates
      });
      
      // 更新本月打卡次数
      this.updateMonthlyCount();
      
      // 重新渲染日历
      this.generateCalendar();
      
      wx.showToast({
        title: '打卡成功',
        icon: 'success',
        duration: 1000
      });
    }
    
    // 立即跳转到计时页面
    wx.navigateTo({
      url: '/pages/timer/timer'
    });
  },

  /**
   * 更新本月打卡次数
   */
  updateMonthlyCount: function() {
    const currentYear = this.data.currentYear;
    const currentMonth = this.data.currentMonth;
    const checkedDates = this.data.checkedDates;
    
    const monthlyCount = checkedDates.filter(date => {
      const [year, month] = date.split('-').map(Number);
      return year === currentYear && month === currentMonth;
    }).length;
    
    // 这里可以更新页面上的打卡次数显示
    console.log(`本月打卡次数: ${monthlyCount}`);
  },

  /**
   * 选择日期
   */
  selectDate: function(e) {
    const date = e.currentTarget.dataset.date;
    if (date) {
      // 这里可以添加点击日期的处理逻辑
      console.log('选择日期:', date);
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
   * 生成日历数据
   */
  generateCalendar: function() {
    const year = this.data.currentYear;
    const month = this.data.currentMonth;
    const checkedDates = this.data.checkedDates;
    
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
        isChecked: checkedDates.includes(fullDate)
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
        isChecked: checkedDates.includes(fullDate)
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
        isChecked: checkedDates.includes(fullDate)
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
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const today = new Date();
    this.setData({
      currentYear: today.getFullYear(),
      currentMonth: today.getMonth() + 1
    });
    
    this.generateCalendar();
    
    // 从本地存储加载已打卡的日期
    const checkedDates = wx.getStorageSync('meditationCheckedDates') || [];
    this.setData({
      checkedDates: checkedDates
    });
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 重新生成日历，确保显示最新的打卡状态
    this.generateCalendar();
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