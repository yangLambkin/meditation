// 打卡管理系统
const checkinManager = {
  // 获取用户ID（简单的用户标识，实际应用中应该用更安全的用户识别方式）
  getUserId: function() {
    // 使用设备唯一标识或用户登录信息
    // 这里简化处理，使用固定用户ID，实际应用中应该根据具体业务逻辑获取
    return 'default_user';
  },
  
  // 获取用户打卡数据
  getUserCheckinData: function() {
    const userId = this.getUserId();
    const userKey = `meditation_checkin_${userId}`;
    const data = wx.getStorageSync(userKey) || {
      // 用户打卡数据格式：{
      //   dailyRecords: {
      //     '2026-01-25': { count: 2, lastCheckin: timestamp, records: [] },
      //     '2026-01-24': { count: 1, lastCheckin: timestamp, records: [] }
      //   },
      //   monthlyStats: {
      //     '2026-01': { total: 3, days: ['2026-01-25', '2026-01-24'] }
      //   }
      // }
      dailyRecords: {},
      monthlyStats: {}
    };
    return data;
  },
  
  // 保存用户打卡数据
  saveUserCheckinData: function(data) {
    const userId = this.getUserId();
    const userKey = `meditation_checkin_${userId}`;
    try {
      wx.setStorageSync(userKey, data);
      return true;
    } catch (error) {
      console.error('保存打卡数据失败:', error);
      return false;
    }
  },
  
  // 记录打卡
  recordCheckin: function(duration, rating, textRecords = []) {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    const monthStr = dateStr.substring(0, 7); // YYYY-MM
    
    const userData = this.getUserCheckinData();
    
    // 更新每日记录
    if (!userData.dailyRecords[dateStr]) {
      userData.dailyRecords[dateStr] = {
        count: 0,
        lastCheckin: today.getTime(),
        records: []
      };
    }
    
    // 增加打卡次数
    userData.dailyRecords[dateStr].count += 1;
    userData.dailyRecords[dateStr].lastCheckin = today.getTime();
    
    // 添加打卡记录详情
    userData.dailyRecords[dateStr].records.push({
      timestamp: today.getTime(),
      duration: duration,
      rating: rating,
      textCount: textRecords.length,
      textPreview: textRecords.length > 0 ? textRecords[0].text.substring(0, 20) + '...' : ''
    });
    
    // 更新月度统计
    if (!userData.monthlyStats[monthStr]) {
      userData.monthlyStats[monthStr] = {
        total: 0,
        days: []
      };
    }
    
    // 如果今天是本月第一次打卡，添加日期到天数列表
    if (userData.dailyRecords[dateStr].count === 1) {
      if (!userData.monthlyStats[monthStr].days.includes(dateStr)) {
        userData.monthlyStats[monthStr].days.push(dateStr);
      }
    }
    
    userData.monthlyStats[monthStr].total += 1;
    
    // 保存数据
    const success = this.saveUserCheckinData(userData);
    
    if (success) {
      // 返回打卡信息
      return {
        success: true,
        date: dateStr,
        dailyCount: userData.dailyRecords[dateStr].count,
        monthlyTotal: userData.monthlyStats[monthStr].total
      };
    } else {
      return {
        success: false,
        error: '保存打卡记录失败'
      };
    }
  },
  
  // 获取某天的打卡次数
  getDailyCheckinCount: function(dateStr) {
    const userData = this.getUserCheckinData();
    return userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].count : 0;
  },
  
  // 获取某月的打卡总天数
  getMonthlyCheckinDays: function(monthStr) {
    const userData = this.getUserCheckinData();
    return userData.monthlyStats[monthStr] ? userData.monthlyStats[monthStr].days.length : 0;
  },
  
  // 获取某月的总打卡次数
  getMonthlyCheckinCount: function(monthStr) {
    const userData = this.getUserCheckinData();
    return userData.monthlyStats[monthStr] ? userData.monthlyStats[monthStr].total : 0;
  },
  
  // 获取所有已打卡的日期列表
  getAllCheckedDates: function() {
    const userData = this.getUserCheckinData();
    const dates = [];
    
    for (const dateStr in userData.dailyRecords) {
      if (userData.dailyRecords[dateStr].count > 0) {
        dates.push(dateStr);
      }
    }
    
    return dates;
  },
  
  // 获取某天的详细打卡记录
  getDailyCheckinRecords: function(dateStr) {
    const userData = this.getUserCheckinData();
    return userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].records : [];
  },
  
  // 获取用户的总打卡统计
  getUserStats: function() {
    const userData = this.getUserCheckinData();
    let totalDays = 0;
    let totalCount = 0;
    let currentStreak = 0;
    let longestStreak = 0;
    
    const dates = Object.keys(userData.dailyRecords).sort();
    
    if (dates.length > 0) {
      // 计算连续打卡天数
      let currentStreakCalc = 0;
      let longestStreakCalc = 0;
      
      for (let i = dates.length - 1; i >= 0; i--) {
        const dateStr = dates[i];
        if (userData.dailyRecords[dateStr].count > 0) {
          currentStreakCalc++;
          longestStreakCalc = Math.max(longestStreakCalc, currentStreakCalc);
        } else {
          currentStreakCalc = 0;
        }
      }
      
      totalDays = dates.filter(date => userData.dailyRecords[date].count > 0).length;
      totalCount = Object.values(userData.dailyRecords).reduce((sum, day) => sum + day.count, 0);
      currentStreak = currentStreakCalc;
      longestStreak = longestStreakCalc;
    }
    
    return {
      totalDays: totalDays,
      totalCount: totalCount,
      currentStreak: currentStreak,
      longestStreak: longestStreak
    };
  }
};

module.exports = checkinManager;