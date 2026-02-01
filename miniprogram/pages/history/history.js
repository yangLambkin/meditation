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
   * 加载历史记录数据（支持云存储）
   */
  async loadHistoryRecords(dateStr) {
    try {
      // 获取该日期的打卡次数（异步）
      const checkinCount = await checkinManager.getDailyCheckinCount(dateStr);
      
      // 获取该日期的详细打卡记录（异步）
      const dailyRecords = await checkinManager.getDailyCheckinRecords(dateStr);
      
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
        // 获取所有关联的体验记录
        const experienceIds = [];
        dailyRecords.forEach(record => {
          if (record.experience && Array.isArray(record.experience)) {
            experienceIds.push(...record.experience.filter(id => id && id.length > 0));
          } else if (record.experience && typeof record.experience === 'string') {
            // 兼容旧数据：单个ID的情况
            experienceIds.push(record.experience);
          }
        });
        
        let experienceRecordsMap = new Map();
        
        if (experienceIds.length > 0) {
          // 去重
          const uniqueIds = [...new Set(experienceIds)];
          
          // 批量查询体验记录
          const db = wx.cloud.database();
          const { data: experienceRecords } = await db.collection('experience_records')
            .where({
              _id: db.command.in(uniqueIds)
            })
            .get();
          
          console.log(`体验记录查询结果: ${JSON.stringify(experienceRecords)}`);
          
          // 构建体验记录映射
          experienceRecords.forEach(exp => {
            experienceRecordsMap.set(exp._id, exp);
          });
          
          console.log(`体验记录映射构建完成，共 ${experienceRecordsMap.size} 条记录`);
        }
        
        formattedRecords = dailyRecords.map((record, index) => {
          // 格式化完整时间: YYYY-MM-DD HH:MM:SS
          const time = new Date(record.timestamp);
          const timeStr = `${time.getFullYear()}-${(time.getMonth() + 1).toString().padStart(2, '0')}-${time.getDate().toString().padStart(2, '0')} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
          
          // 创建星星数据
          const stars = Array.from({ length: 5 }, (_, i) => ({
            active: i < (record.rating || 0)
          }));
          
          // 处理体验记录 - 根据ID数组获取实际内容
          let experienceTexts = [];
          let hasExperience = false;
          
          if (record.experience && ((Array.isArray(record.experience) && record.experience.length > 0) || (typeof record.experience === 'string' && record.experience.length > 0))) {
            // 处理数组类型（新的数据结构）
            if (Array.isArray(record.experience)) {
              record.experience.forEach(expId => {
                if (expId && experienceRecordsMap.has(expId)) {
                  const expRecord = experienceRecordsMap.get(expId);
                  if (expRecord.text) {
                    experienceTexts.push(expRecord.text);
                    hasExperience = true;
                  }
                }
              });
            } else if (typeof record.experience === 'string') {
              // 兼容旧数据：单个ID的情况
              if (experienceRecordsMap.has(record.experience)) {
                const expRecord = experienceRecordsMap.get(record.experience);
                if (expRecord.text) {
                  experienceTexts.push(expRecord.text);
                  hasExperience = true;
                }
              }
            }
          }
          
          // 如果没有体验记录，添加默认提示
          if (experienceTexts.length === 0) {
            experienceTexts = ["未记录体验"];
          }
          
          return {
            time: timeStr,
            duration: record.duration || 0,
            rating: record.rating || 0,
            stars: stars,
            experienceTexts: experienceTexts,
            hasExperience: hasExperience
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
    if (this.data.year && this.data.day) {
      // 重新构建数据库需要的日期格式：YYYY-MM-DD
      const monthNum = this.getMonthNumber(this.data.month);
      const dateStr = `${this.data.year}-${monthNum.toString().padStart(2, '0')}-${this.data.day.padStart(2, '0')}`;
      console.log('onShow重新加载数据，日期:', dateStr);
      this.loadHistoryRecords(dateStr);
    }
  },

  /**
   * 根据月份名称获取月份数字
   */
  getMonthNumber(monthName) {
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
    const index = monthNames.indexOf(monthName);
    return index !== -1 ? index + 1 : new Date().getMonth() + 1;
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