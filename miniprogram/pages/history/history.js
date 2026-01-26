// pages/history/history.js
const checkinManager = require('../../utils/checkin.js');

Page({
  data: {
    historyList: [], // 历史记录列表
    totalDays: 0,    // 总打卡天数
    totalCount: 0,   // 总打卡次数
    currentStreak: 0, // 当前连续天数
    longestStreak: 0, // 最长连续天数
    monthlyCount: 0  // 本月打卡次数
  },

  // 页面加载
  onLoad(options) {
    this.loadHistoryData();
  },

  // 页面显示
  onShow() {
    this.loadHistoryData();
  },

  // 加载历史数据
  loadHistoryData() {
    // 获取用户统计信息
    const userStats = checkinManager.getUserStats();
    
    // 获取所有已打卡的日期
    const checkedDates = checkinManager.getAllCheckedDates();
    
    // 组织历史记录数据
    const historyList = [];
    
    checkedDates.sort((a, b) => b.localeCompare(a)).forEach(dateStr => {
      const records = checkinManager.getDailyCheckinRecords(dateStr);
      
      if (records.length > 0) {
        const formattedRecords = records.map(record => {
          // 格式化时间
          const time = new Date(record.timestamp);
          const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
          
          // 创建星星数据
          const stars = Array.from({ length: 5 }, (_, i) => ({
            active: i < (record.rating || 0)
          }));
          
          return {
            time: timeStr,
            duration: record.duration,
            rating: record.rating || 0,
            stars: stars,
            textCount: record.textCount || 0,
            textPreview: record.textPreview || ''
          };
        });
        
        historyList.push({
          date: dateStr,
          count: records.length,
          records: formattedRecords
        });
      }
    });

    // 计算本月打卡次数
    const today = new Date();
    const monthStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}`;
    const monthlyCount = checkinManager.getMonthlyCheckinCount(monthStr);

    this.setData({
      historyList: historyList,
      totalDays: userStats.totalDays,
      totalCount: userStats.totalCount,
      currentStreak: userStats.currentStreak,
      longestStreak: userStats.longestStreak,
      monthlyCount: monthlyCount
    });
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  },

  // 用户点击右上角分享
  onShareAppMessage() {
    return {
      title: '我的静坐打卡记录',
      path: '/pages/history/history'
    };
  }
});