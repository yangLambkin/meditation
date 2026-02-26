// 云存储API（仅在需要时使用）
const cloudApi = require('./cloudApi.js');

// 打卡管理系统 - 本地优先架构
const checkinManager = {
  
  // === 用户身份管理 ===
  
  // 获取用户ID（本地优先架构）
  getUserId: function() {
    // 1. 优先检查是否已登录（微信openid）
    const wechatOpenId = wx.getStorageSync('userOpenId');
    if (wechatOpenId && wechatOpenId.startsWith('oz')) {
      console.log('✅ 使用已登录的微信openid:', wechatOpenId);
      return wechatOpenId;
    }
    
    // 2. 未登录用户使用本地标识
    let localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      localUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', localUserId);
    }
    
    console.log('📱 使用本地用户标识:', localUserId);
    return localUserId;
  },

  // 保存体验记录到本地缓存（统一架构）
  saveExperienceRecordToLocal: function(uniqueId, experienceRecord) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_user_data_${userId}`; // 统一存储键名
      
      // 获取用户完整数据
      const userData = wx.getStorageSync(storageKey) || {
        checkinRecords: { dailyRecords: {}, monthlyStats: {} },
        experienceRecords: {}
      };
      
      // 保存体验记录
      userData.experienceRecords[uniqueId] = {
        _id: experienceRecord._id, // 云端ID（如果有）
        timestamp: parseInt(uniqueId), // 使用uniqueId的时间戳部分
        text: experienceRecord.text || '',
        created_at: new Date()
      };
      
      wx.setStorageSync(storageKey, userData);
      console.log(`✅ 体验记录保存到统一本地缓存: ${uniqueId}`);
      return true;
    } catch (error) {
      console.error('保存体验记录到本地失败:', error);
      return false;
    }
  },

  // 从本地缓存获取体验记录（统一架构）
  getExperienceRecordsFromLocal: function(uniqueIds) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_user_data_${userId}`;
      const userData = wx.getStorageSync(storageKey) || { experienceRecords: {} };
      
      const result = [];
      uniqueIds.forEach(id => {
        if (userData.experienceRecords && userData.experienceRecords[id]) {
          result.push(userData.experienceRecords[id]);
        }
      });
      
      console.log(`📄 从统一本地缓存获取体验记录: 请求${uniqueIds.length}个，找到${result.length}个`);
      return result;
    } catch (error) {
      console.error('从本地获取体验记录失败:', error);
      return [];
    }
  },

  // 获取用户打卡数据（统一架构，支持迁移旧数据）
  getUserCheckinData: function() {
    const userId = this.getUserId();
    const storageKey = `meditation_user_data_${userId}`;
    
    // 尝试从统一存储获取数据
    const unifiedData = wx.getStorageSync(storageKey);
    if (unifiedData && unifiedData.checkinRecords) {
      // 已经有统一数据，直接返回
      return unifiedData.checkinRecords;
    }
    
    // 如果没有统一数据，尝试从旧存储迁移数据
    return this.migrateOldCheckinData(userId);
  },

  // 迁移旧打卡数据到统一存储
  migrateOldCheckinData: function(userId) {
    console.log('🔄 开始迁移旧打卡数据到统一存储');
    
    const oldStorageKey = `meditation_checkin_${userId}`;
    const oldData = wx.getStorageSync(oldStorageKey) || {
      dailyRecords: {},
      monthlyStats: {}
    };
    
    // 创建统一存储结构
    const unifiedData = {
      checkinRecords: oldData,
      experienceRecords: {}
    };
    
    // 保存到统一存储
    wx.setStorageSync(`meditation_user_data_${userId}`, unifiedData);
    
    // 清理旧存储（可选，保留一段时间用于回滚）
    // wx.removeStorageSync(oldStorageKey);
    
    console.log('✅ 旧打卡数据迁移完成');
    return oldData;
  },

  // 保存用户打卡数据（统一架构）
  saveUserCheckinData: function(data) {
    const userId = this.getUserId();
    const storageKey = `meditation_user_data_${userId}`;
    
    // 获取现有数据
    const userData = wx.getStorageSync(storageKey) || {
      checkinRecords: { dailyRecords: {}, monthlyStats: {} },
      experienceRecords: {}
    };
    
    // 更新打卡记录
    userData.checkinRecords = data;
    
    // 保存回统一存储
    wx.setStorageSync(storageKey, userData);
    
    return true;
  },
  
  // 检查用户是否已登录
  isUserLoggedIn: function() {
    const userOpenId = wx.getStorageSync('userOpenId');
    return !!(userOpenId && userOpenId.startsWith('oz'));
  },
  
  // === 核心数据操作（本地优先） ===
  
  // 记录打卡（本地优先，异步云端备份）
  recordCheckin: function(duration, rating, experience = "") {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    
    // 1. 立即写入本地存储（保证响应速度）
    const localResult = this.recordToLocal(duration, rating, experience);
    
    // 2. 异步备份到云端（如果已登录）
    if (this.isUserLoggedIn()) {
      this.asyncBackupToCloud(duration, rating, experience);
    }
    
    return localResult;
  },
  
  // 本地存储记录
  recordToLocal: function(duration, rating, experience = "") {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const monthStr = dateStr.substring(0, 7);
    
    // 获取本地数据
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
    
    // 处理体验记录参数（支持字符串或数组）
    let experienceArray = [];
    let textCount = 0;
    let textPreview = '';
    
    if (Array.isArray(experience)) {
      // 如果是数组，直接使用（与云端保持一致）
      experienceArray = experience;
      textCount = experience.length;
      textPreview = experience.length > 0 ? `包含${experience.length}条体验记录` : '';
    } else if (typeof experience === 'string') {
      // 如果是字符串，转换为单元素数组（兼容旧数据）
      experienceArray = experience ? [experience] : [];
      textCount = experience ? 1 : 0;
      textPreview = experience ? (experience.substring(0, 20) + (experience.length > 20 ? '...' : '')) : '';
    }
    
    // 添加打卡记录详情（与云端数据结构保持一致）
    const newRecord = {
      timestamp: today.getTime(),
      duration: duration,
      rating: rating,
      experience: experienceArray, // 存储为数组，与云端一致
      textCount: textCount,
      textPreview: textPreview
    };
    
    userData.dailyRecords[dateStr].records.push(newRecord);
    
    // 更新月度统计
    this.updateMonthlyStats(userData, monthStr);
    
    // 保存数据
    this.saveUserCheckinData(userData);
    
    console.log('✅ 本地记录成功:', { date: dateStr, count: userData.dailyRecords[dateStr].count });
    
    return {
      success: true,
      date: dateStr,
      dailyCount: userData.dailyRecords[dateStr].count,
      monthlyTotal: userData.monthlyStats[monthStr] ? userData.monthlyStats[monthStr].total : 0
    };
  },
  
  // 异步备份到云端
  asyncBackupToCloud: async function(duration, rating, experience = "") {
    try {
      // 处理experience参数格式（确保与云端接口兼容）
      let experienceToSend = experience;
      if (Array.isArray(experience)) {
        // 云函数期望experience为数组，直接传递
        experienceToSend = experience;
      } else if (typeof experience === 'string') {
        // 如果是字符串，转换为单元素数组
        experienceToSend = experience ? [experience] : [];
      }
      
      const result = await cloudApi.recordMeditation(duration, rating, experienceToSend);
      if (result.success) {
        console.log('☁️ 云端备份成功');
      } else {
        console.warn('⚠️ 云端备份失败（不影响本地使用）:', result.error);
      }
    } catch (error) {
      console.warn('⚠️ 云端备份异常（不影响本地使用）:', error.message);
    }
  },
  
  // === 数据获取（本地优先） ===
  
  // 获取用户打卡数据（直接从本地）
  getUserCheckinData: function() {
    const userId = this.getUserId();
    const userKey = `meditation_checkin_${userId}`;
    
    const data = wx.getStorageSync(userKey) || {
      dailyRecords: {},
      monthlyStats: {}
    };
    
    // 执行数据完整性检查
    this.validateDataIntegrity(data);
    
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
  
  // 获取某天的打卡次数（直接从本地）- 同步版本
  getDailyCheckinCountSync: function(dateStr) {
    const userData = this.getUserCheckinData();
    const count = userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].count : 0;
    
    console.log(`📊 本地获取(同步): ${dateStr} 有 ${count} 条记录`);
    return count;
  },

  // 获取某天的打卡次数（直接从本地）- 异步版本
  getDailyCheckinCount: function(dateStr) {
    const userData = this.getUserCheckinData();
    const count = userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].count : 0;
    
    console.log(`📊 本地获取: ${dateStr} 有 ${count} 条记录`);
    return count;
  },
  
  // 获取某天的详细打卡记录
  getDailyCheckinRecords: function(dateStr) {
    const userData = this.getUserCheckinData();
    const records = userData.dailyRecords[dateStr] ? userData.dailyRecords[dateStr].records : [];
    
    console.log(`📄 本地获取: ${dateStr} 有 ${records.length} 条详细记录`);
    return records;
  },
  
  // 获取用户统计信息（直接从本地）
  getUserStats: function() {
    const userData = this.getUserCheckinData();
    
    let totalDays = 0;
    let totalCount = 0;
    let totalDuration = 0;
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
          totalDuration += userData.dailyRecords[dateStr].records.reduce((sum, record) => sum + record.duration, 0);
        } else {
          currentStreakCalc = 0;
        }
      }
      
      currentStreak = currentStreakCalc;
      longestStreak = longestStreakCalc;
      totalDays = dates.filter(dateStr => userData.dailyRecords[dateStr].count > 0).length;
      totalCount = dates.reduce((sum, dateStr) => sum + (userData.dailyRecords[dateStr].count || 0), 0);
    }
    
    const stats = {
      totalDays: totalDays,
      totalCount: totalCount,
      totalDuration: totalDuration,
      currentStreak: currentStreak,
      longestStreak: longestStreak
    };
    
    console.log('📈 本地统计:', stats);
    return stats;
  },
  
  // === 数据同步（按需同步，去除冗余） ===
  
  // 登录时执行一次同步（简化版本）
  performLoginSync: async function() {
    if (!this.isUserLoggedIn()) {
      console.log('❌ 未登录，跳过同步');
      return;
    }
    
    // 检查是否已经执行过登录同步
    const hasSyncedOnLogin = wx.getStorageSync('hasSyncedOnLogin');
    if (hasSyncedOnLogin) {
      console.log('✅ 登录同步已执行过，跳过');
      return;
    }
    
    console.log('🔄 开始登录同步...');
    
    const wechatOpenId = this.getUserId();
    const localUserId = wx.getStorageSync('localUserId');
    
    // 建立用户映射关系
    this.createUserMapping(localUserId, wechatOpenId);
    
    // 标记同步完成
    wx.setStorageSync('hasSyncedOnLogin', true);
    
    console.log('✅ 登录同步完成');
  },
  
  // 同步本地数据到云端（简化版本）
  syncLocalToCloud: async function(localUserId, wechatOpenId) {
    console.log('📤 同步本地数据到云端...');
    
    // 获取本地数据
    const localData = this.getUserCheckinDataByUserId(localUserId);
    
    if (!localData || Object.keys(localData.dailyRecords).length === 0) {
      console.log('✅ 本地没有数据，无需同步');
      return;
    }
    
    console.log('✅ 本地数据检查完成');
    
    // 在本地优先架构下，数据同步是静默的异步操作
    // 不需要复杂的逐条检查，云端会处理重复数据的检测
    
    // 异步批量同步最近7天的数据（简化策略）
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    for (const dateStr in localData.dailyRecords) {
      const recordDate = new Date(dateStr);
      if (recordDate >= sevenDaysAgo) {
        const dayData = localData.dailyRecords[dateStr];
        for (const localRecord of dayData.records) {
          // 异步记录到云端（失败不影响本地使用）
          cloudApi.recordMeditation(
            localRecord.duration, 
            localRecord.rating, 
            localRecord.experience
          ).then(() => {
            console.log(`✅ 记录同步成功: ${dateStr}`);
          }).catch(error => {
            console.warn(`⚠️ 记录同步失败 ${dateStr}:`, error.message);
          });
        }
      }
    }
    
    console.log('✅ 同步任务已提交');
  },
  
  // === 辅助功能 ===
  
  // 数据完整性检查
  validateDataIntegrity: function(data) {
    let needsFix = false;
    
    if (!data.dailyRecords) {
      data.dailyRecords = {};
      needsFix = true;
    }
    
    if (!data.monthlyStats) {
      data.monthlyStats = {};
      needsFix = true;
    }
    
    // 验证日期格式
    for (const dateStr in data.dailyRecords) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        console.warn(`发现无效日期格式: ${dateStr}`);
        delete data.dailyRecords[dateStr];
        needsFix = true;
        continue;
      }
      
      const dayData = data.dailyRecords[dateStr];
      
      if (!dayData.records || !Array.isArray(dayData.records)) {
        dayData.records = [];
        needsFix = true;
      }
      
      if (typeof dayData.count !== 'number') {
        dayData.count = dayData.records ? dayData.records.length : 0;
        needsFix = true;
      }
    }
    
    if (needsFix) {
      console.log('✅ 数据完整性检查完成，已修复问题');
    }
    
    return needsFix;
  },
  
  // 更新月度统计
  updateMonthlyStats: function(data, monthStr) {
    if (!data.monthlyStats[monthStr]) {
      data.monthlyStats[monthStr] = { total: 0, days: [] };
    }
    
    // 重新计算该月的总记录数
    data.monthlyStats[monthStr].total = Object.keys(data.dailyRecords)
      .filter(date => date.startsWith(monthStr))
      .reduce((sum, date) => sum + (data.dailyRecords[date].count || 0), 0);
    
    // 更新该月的打卡天数列表
    data.monthlyStats[monthStr].days = Object.keys(data.dailyRecords)
      .filter(date => date.startsWith(monthStr) && data.dailyRecords[date].count > 0)
      .sort()
      .reverse();
  },
  
  // 根据用户ID获取数据
  getUserCheckinDataByUserId: function(userId) {
    const userKey = `meditation_checkin_${userId}`;
    return wx.getStorageSync(userKey) || {
      dailyRecords: {},
      monthlyStats: {}
    };
  },
  
  // 建立用户映射关系（简化版本）
  createUserMapping: function(localUserId, wechatOpenId) {
    // 本地优先架构下，只需要记录当前用户正在使用的标识
    wx.setStorageSync('currentUserId', wechatOpenId);
    
    console.log(`🔗 用户登录: ${localUserId} → ${wechatOpenId}`);
    
    return true;
  },
  
  // 手动同步功能（用户主动触发）
  manualSync: async function() {
    if (!this.isUserLoggedIn()) {
      return { success: false, message: '未登录用户无法同步' };
    }
    
    console.log('🔄 用户手动触发同步...');
    
    try {
      await this.performLoginSync();
      return { success: true, message: '同步完成' };
    } catch (error) {
      return { success: false, message: '同步失败: ' + error.message };
    }
  }
};

module.exports = checkinManager;