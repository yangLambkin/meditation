// 云存储API
const cloudApi = require('./cloudApi.js');

// 打卡管理系统（支持云存储和本地存储双重方案）
const checkinManager = {
  // 存储模式：true使用云存储，false使用本地存储
  useCloudStorage: true,
  
  // 获取用户ID（优先使用已登录的微信openid，如果没有则使用本地标识）
  getUserId: function() {
    // 优先使用缓存的userOpenId（已登录状态）
    const userOpenId = wx.getStorageSync('userOpenId');
    if (userOpenId && userOpenId.startsWith('oz')) {
      console.log('使用已登录的微信openid:', userOpenId);
      return userOpenId;
    }
    
    // 如果没有openid，使用本地存储的用户标识
    let localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      // 生成新的本地用户标识
      localUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', localUserId);
    }
    
    console.log('使用本地用户标识:', localUserId);
    return localUserId;
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
      // 如果是已登录用户，自动同步到云端
      const userOpenId = wx.getStorageSync('userOpenId');
      if (userOpenId && userOpenId.startsWith('oz')) {
        // 异步同步到云端，不阻塞本地保存
        setTimeout(() => {
          this.syncLocalCheckinToCloud(duration, rating, experience);
        }, 100);
      }
      
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
  
  // 获取某天的打卡次数（支持云存储和本地存储）
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
  
  // 获取某天的打卡次数（同步版本，用于页面显示）
  getDailyCheckinCountSync: function(dateStr) {
    console.log(`同步获取 ${dateStr} 的打卡次数...`);
    
    // 直接从本地存储获取
    const userData = this.getUserCheckinData();
    const count = userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].count : 0;
    console.log(`本地存储同步: ${dateStr} 有 ${count} 条记录`);
    
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
  },
  
  // 上传本地数据到云端（迁移历史用户数据）
  uploadLocalDataToCloud: async function() {
    console.log('开始上传本地数据到云端...');
    
    // 检查是否已经上传过（避免重复上传）
    const isDataUploaded = wx.getStorageSync('localDataUploaded');
    if (isDataUploaded) {
      console.log('本地数据已上传过，跳过上传');
      return { success: true, message: '数据已上传过，无需重复上传' };
    }
    
    // 检查用户是否已登录（有openid）
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.openid) {
      console.log('用户未登录，无法上传数据');
      return { success: false, error: '用户未登录' };
    }
    
    // 获取本地数据
    const localUserData = this.getUserCheckinData();
    
    // 只获取近1个月的数据
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    
    const recentDates = Object.keys(localUserData.dailyRecords)
      .filter(dateStr => {
        const recordDate = new Date(dateStr);
        return recordDate >= oneMonthAgo && localUserData.dailyRecords[dateStr].count > 0;
      })
      .sort(); // 按日期排序
    
    if (recentDates.length === 0) {
      console.log('近1个月没有本地打卡数据，无需上传');
      wx.setStorageSync('localDataUploaded', true); // 标记为已上传
      return { success: true, message: '没有需要上传的数据' };
    }
    
    console.log(`发现${recentDates.length}天的本地数据需要上传`);
    
    try {
      // 逐个日期上传数据
      let uploadedCount = 0;
      
      for (const dateStr of recentDates) {
        const dayRecords = localUserData.dailyRecords[dateStr].records;
        
        for (const record of dayRecords) {
          try {
            // 检查云端是否已有该记录（避免重复上传）
            const cloudResult = await cloudApi.getUserRecords(dateStr);
            const existingRecords = cloudResult.success ? cloudResult.data : [];
            
            // 检查是否已有相同记录
            const isDuplicate = existingRecords.some(existing => 
              existing.duration === record.duration && 
              existing.rating === record.rating && 
              existing.experience === record.experience
            );
            
            if (!isDuplicate) {
              // 上传记录到云端
              const uploadResult = await cloudApi.recordMeditation(
                record.duration, 
                record.rating, 
                record.experience
              );
              
              if (uploadResult.success) {
                uploadedCount++;
                console.log(`✅ 上传记录成功: ${dateStr} ${record.duration}分钟`);
              } else {
                console.warn(`⚠️ 上传记录失败: ${dateStr}`, uploadResult.error);
              }
            } else {
              console.log(`⏭️ 跳过已存在的记录: ${dateStr}`);
            }
          } catch (error) {
            console.warn(`❌ 上传记录异常: ${dateStr}`, error);
          }
        }
      }
      
      // 标记数据已上传
      wx.setStorageSync('localDataUploaded', true);
      
      console.log(`✅ 本地数据上传完成，成功上传${uploadedCount}条记录`);
      
      return { 
        success: true, 
        message: `成功上传${uploadedCount}条记录到云端`,
        uploadedCount: uploadedCount,
        totalDates: recentDates.length
      };
      
    } catch (error) {
      console.error('❌ 上传本地数据失败:', error);
      return { 
        success: false, 
        error: '上传本地数据失败: ' + error.message 
      };
    }
  },
  
  // 检查是否需要数据迁移
  checkNeedDataMigration: function() {
    console.log('检查是否需要数据迁移...');
    
    // 检查是否已登录（使用正确的登录状态检查）
    const userOpenId = wx.getStorageSync('userOpenId');
    if (!userOpenId || !userOpenId.startsWith('oz')) {
      console.log('用户未登录，不需要数据迁移');
      return false;
    }
    
    console.log('用户已登录，检查本地数据...');
    
    // 检查本地ID下是否有数据需要迁移（不是基于当前ID）
    const localUserId = wx.getStorageSync('localUserId');
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const localRecords = allUserRecords[localUserId];
    
    const hasLocalData = localRecords && 
                        localRecords.dailyRecords && 
                        Object.keys(localRecords.dailyRecords).some(dateStr => 
                          localRecords.dailyRecords[dateStr] && 
                          localRecords.dailyRecords[dateStr].count > 0
                        );
    
    if (hasLocalData) {
      console.log('检测到本地ID下有数据需要迁移');
      return true;
    } else {
      console.log('没有本地数据需要迁移');
      return false;
    }
  },
  
  // 建立用户映射关系（local user id ↔ openid）
  createUserMapping: function(localUserId, openid) {
    console.log(`建立用户映射关系: localUserId=${localUserId} -> openid=${openid}`);
    
    try {
      // 获取现有的映射关系
      const userMappings = wx.getStorageSync('userMappings') || {};
      
      // 建立双向映射
      userMappings[localUserId] = openid;
      userMappings[openid] = localUserId;
      
      // 保存映射关系
      wx.setStorageSync('userMappings', userMappings);
      
      console.log('✅ 用户映射关系建立成功');
      return true;
    } catch (error) {
      console.error('❌ 建立用户映射关系失败:', error);
      return false;
    }
  },
  
  // 根据openid获取localUserId
  getLocalUserIdByOpenId: function(openid) {
    const userMappings = wx.getStorageSync('userMappings') || {};
    const localUserId = userMappings[openid];
    
    if (localUserId) {
      console.log(`找到映射关系: openid=${openid} -> localUserId=${localUserId}`);
    } else {
      console.log(`未找到openid=${openid}的映射关系`);
    }
    
    return localUserId;
  },
  
  // 根据localUserId获取openid
  getOpenIdByLocalUserId: function(localUserId) {
    const userMappings = wx.getStorageSync('userMappings') || {};
    const openid = userMappings[localUserId];
    
    if (openid) {
      console.log(`找到映射关系: localUserId=${localUserId} -> openid=${openid}`);
    } else {
      console.log(`未找到localUserId=${localUserId}的映射关系`);
    }
    
    return openid;
  },
  
  // 合并用户数据（将本地数据合并到当前用户）
  mergeUserData: function(targetOpenId, sourceLocalUserId) {
    console.log(`合并用户数据: targetOpenId=${targetOpenId}, sourceLocalUserId=${sourceLocalUserId}`);
    
    try {
      // 获取目标用户数据（使用openid）
      const targetUserData = this.getUserCheckinDataByUserId(targetOpenId);
      
      // 获取源用户数据（使用localUserId）
      const sourceUserData = this.getUserCheckinDataByUserId(sourceLocalUserId);
      
      if (!sourceUserData || Object.keys(sourceUserData.dailyRecords || {}).length === 0) {
        console.log('源用户没有数据，无需合并');
        return true;
      }
      
      // 合并每日记录
      for (const dateStr in sourceUserData.dailyRecords) {
        if (sourceUserData.dailyRecords[dateStr].count > 0) {
          if (!targetUserData.dailyRecords[dateStr]) {
            targetUserData.dailyRecords[dateStr] = { count: 0, lastCheckin: 0, records: [] };
          }
          
          // 合并打卡次数
          targetUserData.dailyRecords[dateStr].count += sourceUserData.dailyRecords[dateStr].count;
          
          // 合并记录详情
          targetUserData.dailyRecords[dateStr].records.push(...sourceUserData.dailyRecords[dateStr].records);
          
          // 更新最后打卡时间
          targetUserData.dailyRecords[dateStr].lastCheckin = Math.max(
            targetUserData.dailyRecords[dateStr].lastCheckin,
            sourceUserData.dailyRecords[dateStr].lastCheckin
          );
        }
      }
      
      // 合并月度统计
      for (const monthStr in sourceUserData.monthlyStats) {
        if (!targetUserData.monthlyStats[monthStr]) {
          targetUserData.monthlyStats[monthStr] = { total: 0, days: [] };
        }
        
        targetUserData.monthlyStats[monthStr].total += sourceUserData.monthlyStats[monthStr].total;
        
        // 合并日期列表（去重）
        const combinedDays = [...new Set([
          ...targetUserData.monthlyStats[monthStr].days,
          ...sourceUserData.monthlyStats[monthStr].days
        ])];
        
        targetUserData.monthlyStats[monthStr].days = combinedDays;
      }
      
      // 保存合并后的数据
      this.saveUserCheckinDataByUserId(targetOpenId, targetUserData);
      
      console.log('✅ 用户数据合并成功');
      return true;
      
    } catch (error) {
      console.error('❌ 合并用户数据失败:', error);
      return false;
    }
  },
  
  // 根据用户ID获取打卡数据
  getUserCheckinDataByUserId: function(userId) {
    const userKey = `meditation_checkin_${userId}`;
    const data = wx.getStorageSync(userKey) || {
      dailyRecords: {},
      monthlyStats: {}
    };
    return data;
  },
  
  // 根据用户ID保存打卡数据
  saveUserCheckinDataByUserId: function(userId, data) {
    const userKey = `meditation_checkin_${userId}`;
    try {
      wx.setStorageSync(userKey, data);
      return true;
    } catch (error) {
      console.error('保存打卡数据失败:', error);
      return false;
    }
  }
};

module.exports = checkinManager;