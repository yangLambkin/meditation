// 云存储API
const cloudApi = require('./cloudApi.js');

// 打卡管理系统（支持云存储和本地存储双重方案）
const checkinManager = {
  // 存储模式：true使用云存储，false使用本地存储
  useCloudStorage: true,
  
  // 获取用户ID（简单的用户标识，实际应用中应该用更安全的用户识别方式）
  getUserId: function() {
    // 使用设备唯一标识或用户登录信息
    // 这里简化处理，使用固定用户ID，实际应用中应该根据具体业务逻辑获取
    return 'default_user';
  },
  
  // 获取用户打卡数据（本地存储）
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
  
  // 保存用户打卡数据（本地存储）
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
  
  // 记录打卡（支持云存储和本地存储）
  recordCheckin: async function(duration, rating, experience = "") {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // 优先使用云存储
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.recordMeditation(duration, rating, experience);
        if (result.success) {
          // 云存储成功后，同步到本地存储作为缓存
          this.recordLocalCheckin(duration, rating, experience);
          return {
            success: true,
            date: dateStr,
            dailyCount: 1, // 云存储每次都是新记录
            monthlyTotal: 1
          };
        } else {
          // 云存储失败，降级到本地存储
          console.warn('云存储失败，降级到本地存储:', result.error);
          return this.recordLocalCheckin(duration, rating, experience);
        }
      } catch (error) {
        console.warn('云存储异常，降级到本地存储:', error);
        return this.recordLocalCheckin(duration, rating, experience);
      }
    } else {
      // 直接使用本地存储
      return this.recordLocalCheckin(duration, rating, experience);
    }
  },
  
  // 本地存储打卡记录
  recordLocalCheckin: function(duration, rating, experience = "") {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const monthStr = dateStr.substring(0, 7);
    
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
      experience: experience,
      textCount: experience ? 1 : 0,
      textPreview: experience ? experience.substring(0, 20) + '...' : ''
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
  
  // 获取某天的打卡次数（支持云存储）
  getDailyCheckinCount: async function(dateStr) {
    console.log(`获取 ${dateStr} 的打卡次数...`);
    
    if (this.useCloudStorage) {
      try {
        console.log('尝试使用云存储获取记录...');
        const result = await cloudApi.getUserRecords(dateStr);
        console.log(`云存储返回结果:`, JSON.stringify(result, null, 2));
        
        if (result.success) {
          const count = result.data.length;
          console.log(`✅ 云存储获取成功，${dateStr} 有 ${count} 条记录`);
          return count;
        } else {
          console.warn('❌ 云存储获取失败:', result.error);
        }
      } catch (error) {
        console.warn('❌ 获取云记录失败，使用本地数据:', error);
      }
    }
    
    // 降级到本地存储
    console.log('降级到本地存储获取记录...');
    const userData = this.getUserCheckinData();
    const count = userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].count : 0;
    console.log(`本地存储: ${dateStr} 有 ${count} 条记录`);
    
    return count;
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
  
  // 获取所有已打卡的日期列表（支持云存储）
  getAllCheckedDates: async function() {
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.getAllRecords();
        if (result.success) {
          // 从云记录中提取唯一日期
          const dates = [...new Set(result.data.map(record => record.date))];
          return dates.sort().reverse();
        }
      } catch (error) {
        console.warn('获取云记录失败，使用本地数据:', error);
      }
    }
    
    // 降级到本地存储
    const userData = this.getUserCheckinData();
    const dates = [];
    
    for (const dateStr in userData.dailyRecords) {
      if (userData.dailyRecords[dateStr].count > 0) {
        dates.push(dateStr);
      }
    }
    
    return dates.sort().reverse();
  },
  
  // 获取某天的详细打卡记录（支持云存储）
  getDailyCheckinRecords: async function(dateStr) {
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.getUserRecords(dateStr);
        if (result.success) {
          console.log(`✅ 云存储获取详细记录成功，记录数: ${result.data.length}`);
          // 直接返回云存储数据，格式与本地格式一致
          return result.data;
        }
      } catch (error) {
        console.warn('获取云记录失败，使用本地数据:', error);
      }
    }
    
    // 降级到本地存储
    const userData = this.getUserCheckinData();
    return userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].records : [];
  },
  
  // 获取用户的总打卡统计（支持云存储）
  getUserStats: async function() {
    console.log('开始获取用户统计信息...');
    
    if (this.useCloudStorage) {
      try {
        console.log('尝试使用云存储获取统计信息...');
        const result = await cloudApi.getUserStats();
        console.log('云存储返回结果:', JSON.stringify(result, null, 2));
        
        if (result.success) {
          console.log('✅ 云存储获取成功，数据:', {
            totalDays: result.data.totalDays,
            totalCount: result.data.totalCount,
            totalDuration: result.data.totalDuration,
            currentStreak: result.data.currentStreak,
            longestStreak: result.data.longestStreak
          });
          return {
            totalDays: result.data.totalDays || 0,
            totalCount: result.data.totalCount || 0,
            totalDuration: result.data.totalDuration || 0,
            currentStreak: result.data.currentStreak || 0,
            longestStreak: result.data.longestStreak || 0
          };
        } else {
          console.warn('云存储获取失败，错误:', result.error);
        }
      } catch (error) {
        console.warn('获取云统计失败，使用本地数据:', error);
      }
    }
    
    // 降级到本地存储
    console.log('降级到本地存储获取统计信息...');
    const userData = this.getUserCheckinData();
    console.log('本地存储数据:', userData);
    
    let totalDays = 0;
    let totalCount = 0;
    let totalDuration = 0;
    let currentStreak = 0;
    let longestStreak = 0;
    
    // 如果本地没有数据，生成一些测试数据用于调试
    if (Object.keys(userData.dailyRecords).length === 0) {
      console.log('本地没有数据，生成测试数据...');
      
      // 生成过去7天的测试数据
      const today = new Date();
      for (let i = 0; i < 7; i++) {
        const testDate = new Date(today);
        testDate.setDate(today.getDate() - i);
        const dateStr = testDate.toISOString().split('T')[0];
        
        userData.dailyRecords[dateStr] = {
          count: 1,
          lastCheckin: testDate.getTime(),
          records: [{
            timestamp: testDate.getTime(),
            duration: 15 + Math.floor(Math.random() * 30), // 15-45分钟随机
            rating: 3 + Math.floor(Math.random() * 3),     // 3-5星随机
            experience: "测试数据",
            textCount: 1,
            textPreview: "测试数据..."
          }]
        };
      }
      
      // 保存测试数据
      this.saveUserCheckinData(userData);
      console.log('测试数据已生成并保存');
    }
    
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
          totalDuration += userData.dailyRecords[dateStr].records.reduce((sum, record) => sum + record.duration, 0);
        } else {
          currentStreakCalc = 0;
        }
      }
      
      totalDays = dates.filter(date => userData.dailyRecords[date].count > 0).length;
      totalCount = Object.values(userData.dailyRecords).reduce((sum, day) => sum + day.count, 0);
      currentStreak = currentStreakCalc;
      longestStreak = longestStreakCalc;
    }
    
    console.log('本地统计计算结果:', {
      totalDays: totalDays,
      totalCount: totalCount,
      totalDuration: totalDuration,
      currentStreak: currentStreak,
      longestStreak: longestStreak
    });
    
    return {
      totalDays: totalDays,
      totalCount: totalCount,
      totalDuration: totalDuration,
      currentStreak: currentStreak,
      longestStreak: longestStreak
    };
  },
  
  // 获取排行榜
  getRankings: async function(period = 'total') {
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.getRankings(period);
        if (result.success) {
          return result.data;
        }
      } catch (error) {
        console.warn('获取排行榜失败:', error);
      }
    }
    
    // 本地存储不支持多用户排行榜，返回空数组
    return [];
  },
  
  // 获取月度统计（支持云存储）
  getMonthlyStats: async function(month) {
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.getMonthlyStats(month);
        if (result.success) {
          return result.data;
        }
      } catch (error) {
        console.warn('获取月度统计失败，使用本地数据:', error);
      }
    }

    // 降级到本地存储
    const userData = this.getUserCheckinData();
    const dailyStats = [];
    let totalCount = 0;
    let totalDuration = 0;

    for (const dateStr in userData.dailyRecords) {
      if (dateStr.startsWith(month) && userData.dailyRecords[dateStr].count > 0) {
        const dayData = userData.dailyRecords[dateStr];
        const dayDuration = dayData.records.reduce((sum, record) => sum + record.duration, 0);

        dailyStats.push({
          date: dateStr,
          count: dayData.count,
          totalDuration: dayDuration,
          records: dayData.records
        });

        totalCount += dayData.count;
        totalDuration += dayDuration;
      }
    }

    return {
      month: month,
      dailyStats: dailyStats.sort((a, b) => b.date.localeCompare(a.date)),
      totalCount: totalCount,
      totalDuration: totalDuration
    };
  },

  // 删除体验记录（支持云存储和本地存储同步）
  deleteExperienceRecord: async function(recordId, dateStr) {
    console.log(`开始删除体验记录: recordId=${recordId}, date=${dateStr}`);
    
    // 优先使用云存储
    if (this.useCloudStorage) {
      try {
        const result = await cloudApi.deleteExperienceRecord(recordId);
        if (result.success) {
          console.log('✅ 云存储删除成功');
          // 云存储成功后，同步删除本地存储
          this.deleteLocalExperienceRecord(recordId, dateStr);
          return {
            success: true,
            message: '删除成功'
          };
        } else {
          console.warn('❌ 云存储删除失败，降级到本地删除:', result.error);
          // 云存储失败，降级到本地存储
          return this.deleteLocalExperienceRecord(recordId, dateStr);
        }
      } catch (error) {
        console.warn('❌ 云存储删除异常，降级到本地删除:', error);
        return this.deleteLocalExperienceRecord(recordId, dateStr);
      }
    } else {
      // 直接使用本地存储
      return this.deleteLocalExperienceRecord(recordId, dateStr);
    }
  },

  // 本地存储删除体验记录（从meditationTextRecords中删除）
  deleteLocalExperienceRecord: function(recordId, dateStr) {
    console.log('执行本地体验记录删除:', { recordId, dateStr });
    
    try {
      // 获取所有体验记录
      const allExperienceRecords = wx.getStorageSync('meditationTextRecords') || [];
      
      // 删除指定记录
      const originalCount = allExperienceRecords.length;
      const updatedRecords = allExperienceRecords.filter(record => {
        // 使用uniqueId匹配记录，避免时间戳格式问题
        const rId = record.uniqueId || record.timestamp;
        return rId !== recordId && rId.toString() !== recordId.toString();
      });
      
      const deletedCount = originalCount - updatedRecords.length;
      
      if (deletedCount > 0) {
        // 保存更新后的记录
        wx.setStorageSync('meditationTextRecords', updatedRecords);
        
        console.log('✅ 本地体验记录删除成功');
        return {
          success: true,
          message: '删除成功'
        };
      } else {
        console.warn('⚠️ 未找到匹配的体验记录');
        return {
          success: false,
          error: '未找到匹配的体验记录'
        };
      }
    } catch (error) {
      console.error('❌ 本地体验记录删除失败:', error);
      return {
        success: false,
        error: '本地存储删除失败'
      };
    }
  },

  // 根据记录详情查找记录ID（时间戳作为唯一标识）
  findRecordId: function(dateStr, duration, rating, experience, timestamp) {
    const userData = this.getUserCheckinData();
    
    if (userData.dailyRecords[dateStr] && userData.dailyRecords[dateStr].records) {
      const matchingRecord = userData.dailyRecords[dateStr].records.find(record => {
        return (
          record.duration === duration &&
          record.rating === rating &&
          record.experience === experience &&
          (timestamp ? record.timestamp === timestamp : true)
        );
      });
      
      return matchingRecord ? matchingRecord.timestamp : null;
    }
    
    return null;
  }
};

module.exports = checkinManager;