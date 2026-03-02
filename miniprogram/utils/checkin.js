// 云存储API（仅在需要时使用）
const cloudApi = require('./cloudApi.js');

// 打卡管理系统 - 本地优先架构
const checkinManager = {
  
  // === 用户身份管理 ===
  
  // 获取用户ID（本地优先架构 - 统一使用local user id）
  getUserId: function() {
    // 在本地缓存为主架构中，统一使用local user id作为存储键
    // 微信openid仅用于云端同步
    
    let localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      localUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', localUserId);
    }
    
    // 检查是否已登录（用于调试信息）
    const wechatOpenId = wx.getStorageSync('userOpenId');
    if (wechatOpenId && wechatOpenId.startsWith('oz')) {
      // 静默处理用户登录状态
    } else {
      console.log('📱 未登录用户，使用本地标识:', localUserId);
    }
    
    return localUserId;
  },

  // 保存体验记录到本地缓存（统一架构）
  saveExperienceRecordToLocal: function(uniqueId, experienceRecord) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_checkin_${userId}`; // 统一存储键名
      
      // 获取用户完整数据
      const userData = wx.getStorageSync(storageKey) || {
        dailyRecords: {},
        monthlyStats: {},
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
      const storageKey = `meditation_checkin_${userId}`;
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

  // 获取用户打卡数据（统一架构，支持迁移旧数据和新结构）
  getUserCheckinData: function() {
    const userId = this.getUserId();
    const storageKey = `meditation_checkin_${userId}`;
    
    // 尝试从统一存储获取数据
    const unifiedData = wx.getStorageSync(storageKey);
    
    // 支持新的数据结构：{checkinRecords: {dailyRecords: {...}}, experienceRecords: {...}}
    if (unifiedData && unifiedData.checkinRecords && unifiedData.checkinRecords.dailyRecords) {
      // 返回新的数据结构，转换为兼容格式
      return {
        dailyRecords: unifiedData.checkinRecords.dailyRecords || {},
        monthlyStats: unifiedData.checkinRecords.monthlyStats || {},
        userStats: unifiedData.checkinRecords.userStats || {}
      };
    }
    
    // 支持旧的数据结构：{dailyRecords: {...}, monthlyStats: {...}}
    if (unifiedData && unifiedData.dailyRecords) {
      // 已经有统一数据，直接返回
      return unifiedData;
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
    wx.setStorageSync(`meditation_checkin_${userId}`, unifiedData);
    
    // 清理旧存储（可选，保留一段时间用于回滚）
    // wx.removeStorageSync(oldStorageKey);
    
    console.log('✅ 旧打卡数据迁移完成');
    return oldData;
  },

  // 保存用户打卡数据（统一架构）
  saveUserCheckinData: function(data) {
    const userId = this.getUserId();
    const storageKey = `meditation_checkin_${userId}`;
    
    // 直接保存打卡数据（无需嵌套结构）
    wx.setStorageSync(storageKey, data);
    
    return true;
  },

  // === 严格缓存检测机制 ===
  
  // 严格的缓存状态检测
  strictCacheCheck: function() {
    try {
      console.log('🔍 开始严格缓存检测...');
      
      // 1. 检查恢复标记位（最快检测）
      const needsRecovery = wx.getStorageSync('needsRecovery');
      if (needsRecovery) {
        console.log('🔍 标记位显示需要数据恢复');
        return true;
      }
      
      // 2. 检查缓存状态标记
      const cacheStatus = wx.getStorageSync('cacheStatus');
      if (!cacheStatus) {
        console.log('🔍 缓存状态标记不存在，可能是首次启动或缓存清除');
        // 设置初始标记，但不立即恢复（避免重复）
        wx.setStorageSync('cacheStatus', 'initialized');
        wx.setStorageSync('needsRecovery', true);
        return true;
      }
      
      // 3. 轻量级关键数据检查
      const criticalDataExists = this.checkCriticalDataExists();
      if (!criticalDataExists) {
        console.log('🔍 关键数据不存在，需要恢复');
        return true;
      }
      
      // 4. 详细用户数据完整性检查
      const hasActualData = this.hasActualUserData();
      if (!hasActualData) {
        console.log('🔍 无实际用户数据，需要恢复');
        return true;
      }
      
      console.log('✅ 缓存状态正常，无需恢复');
      return false;
      
    } catch (error) {
      console.error('严格缓存检测失败:', error);
      return false; // 出错时保守处理，不触发恢复
    }
  },
  
  // 检查关键数据存在性
  checkCriticalDataExists: function() {
    const keysToCheck = [
      'userOpenId',
      'localUserId',
      'userNickname'
    ];
    
    for (const key of keysToCheck) {
      const data = wx.getStorageSync(key);
      if (data && data !== '') {
        console.log('🔑 关键数据存在:', key);
        return true;
      }
    }
    
    console.log('❌ 关键数据不存在');
    return false;
  },
  
  // 检查是否有实际用户数据
  hasActualUserData: function() {
    const userId = this.getUserId();
    const storageKey = `meditation_checkin_${userId}`;
    const localData = wx.getStorageSync(storageKey);
    
    if (!localData) {
      console.log('📭 用户数据存储键不存在');
      return false;
    }
    
    // 1. 检查是否有实际打卡记录（排除空对象）
    const hasDailyRecords = localData.checkinRecords && 
                           localData.checkinRecords.dailyRecords && 
                           Object.keys(localData.checkinRecords.dailyRecords).length > 0;
    
    // 2. 检查是否有体验记录
    const hasExperienceRecords = localData.experienceRecords && 
                                Object.keys(localData.experienceRecords).length > 0;
    
    // 3. 检查是否有用户统计信息
    const hasUserStats = localData.checkinRecords && 
                        localData.checkinRecords.userStats && 
                        Object.keys(localData.checkinRecords.userStats).length > 0;
    
    const result = hasDailyRecords || hasExperienceRecords || hasUserStats;
    
    console.log('📊 实际用户数据检查结果:', {
      hasDailyRecords,
      hasExperienceRecords, 
      hasUserStats,
      result
    });
    
    return result;
  },

  // 检查是否需要从云端恢复数据（使用严格检测）
  checkAndRecoverFromCloud: async function() {
    try {
      console.log('🔍 checkAndRecoverFromCloud开始执行');
      
      // 使用严格的缓存检测
      const needsRecovery = this.strictCacheCheck();
      
      if (!needsRecovery) {
        console.log('✅ 严格缓存检测通过，无需从云端恢复');
        return false;
      }
      
      // 检查用户是否已登录（只有已登录用户才能从云端恢复）
      const isLoggedIn = this.isUserLoggedIn();
      console.log('  - 用户登录状态:', isLoggedIn);
      
      if (!isLoggedIn) {
        console.log('⚠️ 用户未登录，无法从云端恢复数据');
        return false;
      }
      
      console.log('🔄 严格检测到需要数据恢复，开始从云端恢复...');
      
      const userId = this.getUserId();
      const success = await this.safeRecoverFromCloud(userId);
      
      if (success) {
        console.log('✅ 云端数据恢复完成');
        // 恢复成功后清除恢复标记
        wx.setStorageSync('needsRecovery', false);
        return true;
      } else {
        console.log('⚠️ 云端数据恢复失败，保留恢复标记');
        return false;
      }
      
    } catch (error) {
      console.error('检查数据恢复状态失败:', error);
      return false;
    }
  },

  // 安全的云端数据恢复（含去重保护）
  async safeRecoverFromCloud(userId) {
    try {
      console.log('🛡️ 开始安全数据恢复...');
      
      // 1. 获取当前本地数据快照（用于去重检查）
      const currentData = this.getUserCheckinDataByUserId(userId);
      
      console.log('📊 当前本地数据状态:', {
        hasData: !!currentData,
        recordCount: Object.keys(currentData?.dailyRecords || {}).length
      });
      
      // 2. 从云端获取数据
      const cloudApi = require('./cloudApi.js');
      const allRecordsResult = await cloudApi.getAllRecords();
      
      if (!allRecordsResult.success) {
        console.error('获取云端打卡记录失败:', allRecordsResult.error);
        return false;
      }
      
      console.log('📡 云端数据获取成功，记录数:', allRecordsResult.data?.length || 0);
      
      // 3. 智能合并（避免重复）- 使用与本地打卡记录一致的数据格式
      const mergedData = this.rebuildLocalCacheFromCloudRecords(allRecordsResult.data);
      
      // 4. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        mergedData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 5. 保存合并结果（使用与本地打卡记录一致的键名和格式）
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, mergedData);
      
      console.log('✅ 安全数据恢复完成，合并结果:', {
        '恢复前记录数': Object.keys(currentData?.dailyRecords || {}).length,
        '云端记录数': allRecordsResult.data?.length || 0,
        '合并后记录数': Object.keys(mergedData.checkinRecords.dailyRecords || {}).length
      });
      
      return true;
      
    } catch (error) {
      console.error('安全数据恢复失败:', error);
      return false;
    }
  },
  
  // 数据指纹（用于去重检查）
  getDataFingerprint: function(data) {
    if (!data || !data.checkinRecords) return 'empty';
    
    const dailyRecords = data.checkinRecords.dailyRecords || {};
    const recordKeys = Object.keys(dailyRecords).sort();
    
    return {
      recordCount: recordKeys.length,
      latestRecord: recordKeys[recordKeys.length - 1] || 'none',
      totalRecords: recordKeys.reduce((sum, date) => {
        const dayData = dailyRecords[date];
        return sum + (dayData.records ? dayData.records.length : 0);
      }, 0)
    };
  },
  
  // 智能数据合并（避免重复）
  intelligentMerge: function(localData, cloudRecords) {
    const mergedData = {
      checkinRecords: {
        dailyRecords: { ...(localData?.dailyRecords || {}) },
        monthlyStats: { ...(localData?.monthlyStats || {}) }
      },
      experienceRecords: { ...(localData?.experienceRecords || {}) }
    };
    
    if (!cloudRecords || cloudRecords.length === 0) {
      console.log('📭 云端无数据，使用本地数据');
      return mergedData;
    }
    
    console.log('🔄 开始智能数据合并...');
    
    // 按日期合并云端记录
    for (const cloudRecord of cloudRecords) {
      if (!cloudRecord.date) continue;
      
      const dateStr = cloudRecord.date;
      const existingDayData = mergedData.checkinRecords.dailyRecords[dateStr];
      
      if (!existingDayData) {
        // 本地没有该日期数据，直接添加
        mergedData.checkinRecords.dailyRecords[dateStr] = {
          date: dateStr,
          records: [this.formatCloudRecord(cloudRecord)]
        };
      } else {
        // 本地已有该日期数据，进行记录级去重
        mergedData.checkinRecords.dailyRecords[dateStr] = this.mergeDailyRecords(
          existingDayData, 
          cloudRecord
        );
      }
    }
    
    console.log('✅ 智能合并完成');
    return mergedData;
  },
  
  // 合并单日记录（去重逻辑）
  mergeDailyRecords: function(existingDayData, cloudRecord) {
    const existingRecords = existingDayData.records || [];
    
    // 检查是否已存在相同记录（基于时间戳和内容）
    const isDuplicate = existingRecords.some(existingRecord => 
      existingRecord.timestamp === cloudRecord.timestamp &&
      existingRecord.duration === cloudRecord.duration
    );
    
    if (isDuplicate) {
      console.log('🔄 跳过重复记录:', cloudRecord.timestamp);
      return existingDayData;
    }
    
    // 添加新记录
    return {
      ...existingDayData,
      records: [...existingRecords, this.formatCloudRecord(cloudRecord)]
    };
  },
  
  // 格式化云端记录
  formatCloudRecord: function(cloudRecord) {
    return {
      _id: cloudRecord._id,
      timestamp: cloudRecord.timestamp,
      duration: cloudRecord.duration,
      rating: cloudRecord.rating,
      experience: cloudRecord.experience,
      created_at: cloudRecord.created_at
    };
  },

  // 安全的云端数据恢复（含去重保护）
  async safeRecoverFromCloud(userId) {
    try {
      console.log('🛡️ 开始安全数据恢复...');
      
      // 1. 获取当前本地数据快照（用于去重检查）
      const currentData = this.getUserCheckinDataByUserId(userId);
      
      console.log('📊 当前本地数据状态:', {
        hasData: !!currentData,
        recordCount: Object.keys(currentData?.dailyRecords || {}).length
      });
      
      // 2. 从云端获取数据
      const cloudApi = require('./cloudApi.js');
      const allRecordsResult = await cloudApi.getAllRecords();
      
      if (!allRecordsResult.success) {
        console.error('获取云端打卡记录失败:', allRecordsResult.error);
        return false;
      }
      
      console.log('📡 云端数据获取成功，记录数:', allRecordsResult.data?.length || 0);
      
      // 3. 智能合并（避免重复）- 使用与本地打卡记录一致的数据格式
      const mergedData = this.rebuildLocalCacheFromCloudRecords(allRecordsResult.data);
      
      // 4. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        mergedData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 5. 保存合并结果（使用与本地打卡记录一致的键名和格式）
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, mergedData);
      
      console.log('✅ 安全数据恢复完成，合并结果:', {
        '恢复前记录数': Object.keys(currentData?.dailyRecords || {}).length,
        '云端记录数': allRecordsResult.data?.length || 0,
        '合并后记录数': Object.keys(mergedData.checkinRecords.dailyRecords || {}).length
      });
      
      return true;
      
    } catch (error) {
      console.error('安全数据恢复失败:', error);
      return false;
    }
  },
  
  // 智能数据合并（避免重复）
  intelligentMerge: function(localData, cloudRecords) {
    const mergedData = {
      checkinRecords: {
        dailyRecords: { ...(localData?.dailyRecords || {}) },
        monthlyStats: { ...(localData?.monthlyStats || {}) }
      },
      experienceRecords: { ...(localData?.experienceRecords || {}) }
    };
    
    if (!cloudRecords || cloudRecords.length === 0) {
      console.log('📭 云端无数据，使用本地数据');
      return mergedData;
    }
    
    console.log('🔄 开始智能数据合并...');
    
    // 按日期合并云端记录
    for (const cloudRecord of cloudRecords) {
      if (!cloudRecord.date) continue;
      
      const dateStr = cloudRecord.date;
      const existingDayData = mergedData.checkinRecords.dailyRecords[dateStr];
      
      if (!existingDayData) {
        // 本地没有该日期数据，直接添加
        mergedData.checkinRecords.dailyRecords[dateStr] = {
          date: dateStr,
          records: [this.formatCloudRecord(cloudRecord)]
        };
      } else {
        // 本地已有该日期数据，进行记录级去重
        mergedData.checkinRecords.dailyRecords[dateStr] = this.mergeDailyRecords(
          existingDayData, 
          cloudRecord
        );
      }
    }
    
    console.log('✅ 智能合并完成');
    return mergedData;
  },
  
  // 合并单日记录（去重逻辑）
  mergeDailyRecords: function(existingDayData, cloudRecord) {
    const existingRecords = existingDayData.records || [];
    
    // 检查是否已存在相同记录（基于时间戳和内容）
    const isDuplicate = existingRecords.some(existingRecord => 
      existingRecord.timestamp === cloudRecord.timestamp &&
      existingRecord.duration === cloudRecord.duration
    );
    
    if (isDuplicate) {
      console.log('🔄 跳过重复记录:', cloudRecord.timestamp);
      return existingDayData;
    }
    
    // 添加新记录
    return {
      ...existingDayData,
      records: [...existingRecords, this.formatCloudRecord(cloudRecord)]
    };
  },
  
  // 格式化云端记录
  formatCloudRecord: function(cloudRecord) {
    return {
      _id: cloudRecord._id,
      timestamp: cloudRecord.timestamp,
      duration: cloudRecord.duration,
      rating: cloudRecord.rating,
      experience: cloudRecord.experience,
      created_at: cloudRecord.created_at
    };
  },

  // 从云端恢复用户数据
  async recoverUserDataFromCloud(userId) {
    try {
      const cloudApi = require('./cloudApi.js');
      
      console.log('📡 开始从云端恢复用户数据...');
      
      // 1. 获取用户所有打卡记录
      const allRecordsResult = await cloudApi.getAllRecords();
      if (!allRecordsResult.success) {
        console.error('获取云端打卡记录失败:', allRecordsResult.error);
        return false;
      }
      
      // 2. 重建本地缓存结构
      const recoveredData = this.rebuildLocalCacheFromCloudRecords(allRecordsResult.data);
      
      // 3. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        recoveredData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 4. 保存到本地缓存
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, recoveredData);
      
      console.log('✅ 云端数据恢复完成，共恢复:', {
        checkinRecords: Object.keys(recoveredData.checkinRecords.dailyRecords || {}).length,
        experienceRecords: Object.keys(recoveredData.experienceRecords || {}).length
      });
      
      return true;
      
    } catch (error) {
      console.error('从云端恢复数据失败:', error);
      return false;
    }
  },

  // 根据云端记录重建本地缓存（确保格式与本地打卡记录一致）
  rebuildLocalCacheFromCloudRecords(cloudRecords) {
    const localData = {
      checkinRecords: {
        dailyRecords: {},
        monthlyStats: {},
        userStats: {}
      },
      experienceRecords: {}
    };
    
    console.log(`🔄 重建本地缓存，共 ${cloudRecords.length} 条云端记录`);
    
    // 处理打卡记录（格式与本地打卡记录一致）
    cloudRecords.forEach(record => {
      const dateStr = record.date;
      
      if (!localData.checkinRecords.dailyRecords[dateStr]) {
        localData.checkinRecords.dailyRecords[dateStr] = {
          count: 0,
          lastCheckin: record.timestamp,
          records: []
        };
      }
      
      // 增加打卡次数
      localData.checkinRecords.dailyRecords[dateStr].count++;
      
      // 添加详细记录（格式与本地打卡记录一致）
      localData.checkinRecords.dailyRecords[dateStr].records.push({
        timestamp: record.timestamp,
        duration: record.duration || 0,
        rating: record.rating || 0,
        experience: record.experience || [],
        textCount: Array.isArray(record.experience) ? record.experience.length : 0,
        textPreview: Array.isArray(record.experience) && record.experience.length > 0 ? 
          `包含${record.experience.length}条体验记录` : ''
      });
      
      // 处理体验记录
      if (record.experience && Array.isArray(record.experience)) {
        record.experience.forEach(exp => {
          if (exp && exp._id) {
            // 保存体验记录到experienceRecords中
            localData.experienceRecords[exp._id] = {
              _id: exp._id,
              timestamp: exp.timestamp || record.timestamp,
              text: exp.text || '',
              rating: exp.rating || 0,
              duration: exp.duration || 0
            };
          }
        });
      }
      
      // 更新最后打卡时间
      localData.checkinRecords.dailyRecords[dateStr].lastCheckin = record.timestamp;
    });
    
    console.log(`✅ 重建完成: 打卡记录${Object.keys(localData.checkinRecords.dailyRecords).length}天，体验记录${Object.keys(localData.experienceRecords).length}条`);
    
    return localData;
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
    
    // 3. 异步检查勋章解锁条件（基于本地统计数据）
    this.asyncCheckBadgeUnlock(duration);
    
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
    
    // 更新月度统计缓存
    this.updateMonthlyStatsCache(userData, duration, monthStr);
    
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

  // 异步检查勋章解锁条件（基于本地统计数据）
  asyncCheckBadgeUnlock: async function(duration) {
    try {
      // 延迟执行，确保本地数据已经保存
      setTimeout(() => {
        // 基于本地统计数据检查勋章条件
        const localStats = this.getUserStats();
        
        // 获取最后一条记录的时长
        const lastDuration = duration;
        
        // 准备勋章检查需要的用户数据
        const userStats = {
          currentStreak: localStats.currentStreak || 0,
          totalCheckinDays: localStats.totalDays || 0,
          lastDuration: lastDuration,
          totalDuration: localStats.totalDuration || 0
        };
        
        console.log('🔍 打卡后检查勋章条件:', userStats);
        
        // 动态引入勋章管理器（避免循环依赖）
        const badgeManager = require('./badgeManager.js');
        
        // 检查勋章解锁条件
        const hasUnlocked = badgeManager.checkBadgeUnlock(userStats);
        
        if (hasUnlocked) {
          console.log('🎉 打卡后检测到新勋章解锁！');
          
          // 触发勋章解锁通知
          this.triggerBadgeUnlockNotification();
        }
        
      }, 100); // 延迟100ms确保本地数据保存完成
      
    } catch (error) {
      console.warn('⚠️ 勋章检查失败（不影响打卡）:', error.message);
    }
  },

  // 触发勋章解锁通知
  triggerBadgeUnlockNotification: function() {
    try {
      // 获取最新解锁的勋章
      const badgeManager = require('./badgeManager.js');
      const unlockedBadges = badgeManager.getUnlockedBadges();
      
      if (unlockedBadges.length > 0) {
        // 显示勋章解锁通知
        wx.showToast({
          title: `解锁新勋章: ${unlockedBadges[unlockedBadges.length - 1].name}`,
          icon: 'success',
          duration: 3000
        });
        
        // 设置全局标记，在me页面显示解锁提示
        wx.setStorageSync('showBadgeUnlockHint', true);
        
        console.log('✅ 勋章解锁通知已触发');
      }
    } catch (error) {
      console.warn('⚠️ 勋章解锁通知失败:', error.message);
    }
  },
  
  // === 数据获取（本地优先） ===
  
  // 获取用户打卡数据（直接从本地，支持新格式）
  getUserCheckinData: function() {
    const userId = this.getUserId();
    const userKey = `meditation_checkin_${userId}`;
    
    const data = wx.getStorageSync(userKey);
    
    // 支持新的数据结构：{checkinRecords: {dailyRecords: {...}}, experienceRecords: {...}}
    if (data && data.checkinRecords && data.checkinRecords.dailyRecords) {
      // 返回新的数据结构，转换为兼容格式
      const result = {
        dailyRecords: data.checkinRecords.dailyRecords || {},
        monthlyStats: data.checkinRecords.monthlyStats || {},
        userStats: data.checkinRecords.userStats || {}
      };
      return result;
    }
    
    // 支持旧的数据结构：{dailyRecords: {...}, monthlyStats: {...}}
    if (data && data.dailyRecords) {
      // 执行数据完整性检查
      this.validateDataIntegrity(data);
      return data;
    }
    
    // 如果没有数据，返回默认结构
    const defaultData = {
      dailyRecords: {},
      monthlyStats: {}
    };
    
    return defaultData;
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
    
    // 静默返回本地获取结果
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
    
    // 登录后立即检查是否需要数据恢复
    console.log('🔍 登录后检查数据恢复状态...');
    const needsRecovery = this.strictCacheCheck();
    
    if (needsRecovery) {
      console.log('🔄 登录后检测到需要数据恢复，开始恢复...');
      const recoverySuccess = await this.checkAndRecoverFromCloud();
      
      // 数据恢复完成后，触发页面刷新
      if (recoverySuccess) {
        console.log('🔄 数据恢复完成，触发页面刷新');
        // 通过全局事件机制通知页面刷新
        if (typeof globalThis !== 'undefined' && globalThis.triggerPageRefresh) {
          globalThis.triggerPageRefresh();
        }
        // 兼容旧版本：直接调用页面方法（如果页面已加载）
        try {
          const pages = getCurrentPages();
          if (pages.length > 0) {
            const currentPage = pages[pages.length - 1];
            if (currentPage && currentPage.refreshCalendarData) {
              currentPage.refreshCalendarData();
            }
          }
        } catch (e) {
          console.log('⚠️ 自动刷新页面失败，需要手动刷新:', e.message);
        }
      }
    } else {
      console.log('✅ 登录后数据状态正常，无需恢复');
    }
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
    
    // 支持新格式数据：{checkinRecords: {dailyRecords: {...}}, experienceRecords: {...}}
    if (data.checkinRecords && data.checkinRecords.dailyRecords) {
      // 新格式数据，不需要修复
      return false;
    }
    
    // 旧格式数据：{dailyRecords: {...}, monthlyStats: {...}}
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

  // === 月度统计缓存管理 ===
  
  // 更新月度统计缓存（每次打卡后调用）
  updateMonthlyStatsCache: function(data, duration, monthStr) {
    try {
      // 实时计算最新的当月总分钟数
      const currentMinutes = this.calculateCurrentMonthMinutes();
      
      // 更新缓存
      this.updateMonthlyCache(currentMinutes);
      
      console.log(`📊 打卡后缓存更新完成: ${currentMinutes} 分钟 (月: ${monthStr})`);
      
      return currentMinutes;
    } catch (error) {
      console.error('更新月度统计缓存失败:', error);
      return 0;
    }
  },

  // 获取当月总分钟数（智能缓存 + 实时计算）
  getCurrentMonthMinutes: function() {
    try {
      // 先检查缓存是否有效
      if (this.isMonthlyCacheValid()) {
        return this.getCachedMonthlyMinutes();
      }
      
      // 缓存失效时实时计算并更新缓存
      const minutes = this.calculateCurrentMonthMinutes();
      this.updateMonthlyCache(minutes);
      return minutes;
    } catch (error) {
      console.error('获取当月总分钟数失败:', error);
      return 0;
    }
  },

  // 实时计算当月总分钟数
  calculateCurrentMonthMinutes: function() {
    try {
      const currentMonth = new Date().toISOString().split('T')[0].substring(0, 7);
      const userData = this.getUserCheckinData();
      
      const totalMinutes = Object.keys(userData.dailyRecords || {})
        .filter(date => date.startsWith(currentMonth))
        .reduce((total, date) => {
          const dayRecords = userData.dailyRecords[date].records || [];
          return total + dayRecords.reduce((sum, record) => 
            sum + (record.duration || 0), 0
          );
        }, 0);
      
      console.log(`📊 实时计算当月总分钟数: ${totalMinutes} 分钟 (月: ${currentMonth})`);
      return totalMinutes;
    } catch (error) {
      console.error('实时计算当月分钟数失败:', error);
      return 0;
    }
  },

  // 检查月度统计缓存是否有效
  isMonthlyCacheValid: function() {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_monthly_stats_${userId}`;
      const monthlyStatsCache = wx.getStorageSync(storageKey) || {};
      
      // 检查缓存月份是否匹配
      const currentMonth = new Date().toISOString().split('T')[0].substring(0, 7);
      if (monthlyStatsCache.currentMonth !== currentMonth) {
        console.log(`📊 缓存月份不匹配，需要重新计算 (缓存: ${monthlyStatsCache.currentMonth}, 当前: ${currentMonth})`);
        return false;
      }
      
      // 检查缓存是否过期（1小时有效期）
      const lastUpdateTime = new Date(monthlyStatsCache.lastUpdateTime || 0).getTime();
      const cacheExpiry = 60 * 60 * 1000; // 1小时
      const isExpired = Date.now() - lastUpdateTime > cacheExpiry;
      
      if (isExpired) {
        console.log(`📊 缓存已过期，需要重新计算 (最后更新: ${monthlyStatsCache.lastUpdateTime})`);
        return false;
      }
      
      console.log(`📊 缓存有效，使用缓存数据: ${monthlyStatsCache.totalMinutes} 分钟`);
      return true;
    } catch (error) {
      console.error('检查缓存有效性失败:', error);
      return false;
    }
  },

  // 获取缓存中的当月分钟数
  getCachedMonthlyMinutes: function() {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_monthly_stats_${userId}`;
      const monthlyStatsCache = wx.getStorageSync(storageKey) || {};
      return monthlyStatsCache.totalMinutes || 0;
    } catch (error) {
      console.error('获取缓存数据失败:', error);
      return 0;
    }
  },

  // 更新月度统计缓存
  updateMonthlyCache: function(minutes) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_monthly_stats_${userId}`;
      const currentMonth = new Date().toISOString().split('T')[0].substring(0, 7);
      
      const monthlyStatsCache = {
        currentMonth: currentMonth,
        totalMinutes: minutes,
        lastUpdateTime: new Date().toISOString()
      };
      
      wx.setStorageSync(storageKey, monthlyStatsCache);
      console.log(`📊 月度缓存更新完成: ${minutes} 分钟 (月: ${currentMonth})`);
    } catch (error) {
      console.error('更新月度缓存失败:', error);
    }
  },
  
  // 根据用户ID获取数据
  getUserCheckinDataByUserId: function(userId) {
    const userKey = `meditation_checkin_${userId}`;
    return wx.getStorageSync(userKey) || {
      dailyRecords: {},
      monthlyStats: {}
    };
  },
  
  // 检查用户是否已登录
  isUserLoggedIn: function() {
    const wechatOpenId = wx.getStorageSync('userOpenId');
    return !!(wechatOpenId && wechatOpenId.startsWith('oz'));
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