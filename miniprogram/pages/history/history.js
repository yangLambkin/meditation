// pages/history/history.js
const checkinManager = require('../../utils/checkin.js');
const lunarUtil = require('../../utils/lunar.js');

Page({
  data: {
    selectedDate: '', // 选择的日期
    recordList: [],   // 打卡记录列表
    recordCount: 0,   // 打卡次数
    totalDuration: 0, // 合计时长（分钟）
    year: '',         // 年
    month: '',        // 月
    day: '',          // 日
    lunarDate: ''     // 农历日期
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // 从URL参数获取日期
    const date = options.date || '';
    
    if (date) {
      // 解析日期参数，分别设置年、月、日
      const [year, month, day] = date.split('-');
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      
      // 计算农历日期
      const solarDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      const lunarDate = lunarUtil.getLunarDate(solarDate);
      
      // 格式化日期显示：YYYY-MM-DD → YYYY年MM月DD日
      const formattedDate = this.formatDateForDisplay(date);
      this.setData({
        selectedDate: formattedDate,
        year: year,
        month: monthNames[parseInt(month) - 1],
        day: day,
        lunarDate: lunarDate
      });
      
      // 加载该日期的打卡记录
      this.loadHistoryRecords(date);
    } else {
      // 如果没有日期参数，默认显示今天
      const today = new Date().toISOString().split('T')[0];
      const [year, month, day] = today.split('-');
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      const solarDate = new Date();
      const lunarDate = lunarUtil.getLunarDate(solarDate);
      const formattedToday = this.formatDateForDisplay(today);
      this.setData({
        selectedDate: formattedToday,
        year: year,
        month: monthNames[parseInt(month) - 1],
        day: day,
        lunarDate: lunarDate
      });
      this.loadHistoryRecords(today);
    }
  },

  /**
   * 加载历史记录数据
   */
  loadHistoryRecords(dateStr) {
    try {
      // 获取该日期的打卡次数
      const checkinCount = checkinManager.getDailyCheckinCount(dateStr);
      
      // 获取该日期的详细打卡记录
      const dailyRecords = checkinManager.getDailyCheckinRecords(dateStr);
      
      if (checkinCount === 0) {
        console.warn('该日期暂无打卡记录');
        this.setData({
          recordList: [],
          recordCount: 0,
          totalDuration: 0
        });
        return;
      }

      // 格式化记录数据
      let formattedRecords = [];
      let totalDuration = 0;
      
      if (dailyRecords && dailyRecords.length > 0) {
        formattedRecords = dailyRecords.map((record, index) => {
          // 格式化时间
          const time = new Date(record.timestamp);
          const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
          
          // 创建星星数据
          const stars = Array.from({ length: 5 }, (_, i) => ({
            active: i < (record.rating || 0)
          }));
          
          // 获取文本记录
          let textRecords = [];
          if (record.textRecords && Array.isArray(record.textRecords)) {
            textRecords = record.textRecords.map(text => text.content || text);
          }
          
          return {
            time: timeStr,
            duration: record.duration || 0,
            rating: record.rating || 0,
            stars: stars,
            textCount: textRecords.length,
            textRecords: textRecords
          };
        });
        
        // 计算合计时长
        totalDuration = formattedRecords.reduce((total, record) => {
          return total + (record.duration || 0);
        }, 0);
      } else {
        // 如果有打卡次数但没有详细记录，设置默认值
        totalDuration = 0; // 如果没有详细记录，时长设为0
      }

      this.setData({
        recordList: formattedRecords,
        recordCount: checkinCount, // 使用打卡次数作为记录数
        totalDuration: totalDuration
      });

      console.log(`加载 ${dateStr} 的打卡记录成功，打卡次数: ${checkinCount}, 合计时长: ${totalDuration}分钟`);
      
    } catch (error) {
      console.error('加载历史记录失败:', error);
      this.setData({
        recordList: [],
        recordCount: 0,
        totalDuration: 0
      });
    }
  },

  /**
   * 格式化日期显示
   */
  formatDateForDisplay(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${year}年${month}月${day}日`;
  },

  /**
   * 返回上一页
   */
  goBack() {
    wx.navigateBack();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时重新加载数据，确保数据最新
    if (this.data.selectedDate) {
      this.loadHistoryRecords(this.data.selectedDate);
    }
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {
    return {
      title: `${this.data.selectedDate} 的静坐打卡记录`,
      path: `/pages/history/history?date=${this.data.selectedDate}`
    };
  }
});