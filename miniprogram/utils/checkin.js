// 云存储API（仅在需要时使用）
const cloudApi = require('./cloudApi.js');
const dateUtil = require('./dateUtil.js');
const uploadNetwork = require('./uploadNetwork.js');
const pendingBackups = new Map();
const activeUploads = new Set();
const pendingDeletions = new Set();
const userStorageRevisions = new Map();
const pendingRefreshes = new Map();
const pendingUploadDrains = new Map();
const pendingCloudSyncs = new Map();
const syncStateListeners = new Set();
const UPLOAD_TIMEOUT_MS = 3000;
const UPLOAD_RETRY_DELAY_MS = 100;
const MAX_UPLOAD_RETRIES = 3;
const NON_RETRYABLE_UPLOAD_CODES = new Set([
  'INVALID_RECORD', 'DATE_OUT_OF_RANGE', 'CONTENT_REJECTED', 'AMBIGUOUS_RECORD',
  'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'IDENTITY_MISMATCH', 'RECORD_NOT_FOUND', 'STORAGE_FAILED', 'UPLOAD_IGNORED',
  'UPLOAD_PAUSED'
]);

function currentUploadOpenid() {
  const openid = wx.getStorageSync('userOpenId');
  return typeof openid === 'string' && openid.startsWith('oz') ? openid : '';
}

// 待上传队列仅认新版记录的显式标记；不把历史无云端 ID 的记录推断为待上传。
function uploadEntries(userId) {
  const stored = wx.getStorageSync(`meditation_checkin_${userId}`) || {};
  restoreInterruptedUploads(stored, userId);
  const data = stored.checkinRecords || stored;
  return Object.keys(data.dailyRecords || {}).flatMap(date =>
    (data.dailyRecords[date].records || []).filter(Boolean).map(record => ({ date, record })));
}

// 请求只在当前进程有效；重开后恢复为待上传，再按当天自动/历史手动的规则处理。
function restoreInterruptedUploads(stored, userId) {
  const data = stored.checkinRecords || stored;
  let changed = false;
  Object.values(data.dailyRecords || {}).forEach(day => {
    (day.records || []).filter(Boolean).forEach(record => {
      if (record.syncVersion === 1 && !record._id && record.syncStatus === 'uploading' &&
          !activeUploads.has(backupKey(userId, record.timestamp, record.localId))) {
        record.syncStatus = 'pending';
        changed = true;
      }
    });
  });
  if (changed) {
    try {
      wx.setStorageSync(`meditation_checkin_${userId}`, stored);
      bumpUserStorageRevision(userId);
    } catch (error) {
      // 存储已满也要展示可手动处理的状态，不能让读取结果变成“保存失败”。
      console.warn('恢复中断的上传状态失败:', error.message);
    }
  }
}

function isPendingUpload(record, openid) {
  return record.syncVersion === 1 && !record._id && record.syncIgnored !== true &&
    (!record.syncOpenid || record.syncOpenid === openid);
}

function notifySyncState() {
  syncStateListeners.forEach(listener => {
    try { listener(); } catch (error) { console.warn('刷新上传状态失败:', error.message); }
  });
}

function updateStoredUpload(userId, localId, update) {
  const storageKey = `meditation_checkin_${userId}`;
  const stored = wx.getStorageSync(storageKey);
  if (!stored) return false;
  const data = stored.checkinRecords || stored;
  for (const day of Object.values(data.dailyRecords || {})) {
    const record = (day.records || []).find(item => item && item.localId === localId);
    if (!record) continue;
    update(record);
    wx.setStorageSync(storageKey, stored);
    bumpUserStorageRevision(userId);
    return true;
  }
  return false;
}

function uploadTimeoutResult() {
  return { success: false, code: 'CLOUD_TIMEOUT', error: '上传超时（3秒），请手动重试' };
}

// 截止时间只结束本次尝试；外层负责重试，耗尽后仍保留本机记录。
function awaitUploadUntil(request, deadlineAt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      if (Date.now() >= deadlineAt) resolve(uploadTimeoutResult());
      else callback(value);
    };
    const timer = setTimeout(() => finish(resolve, uploadTimeoutResult()), Math.max(0, deadlineAt - Date.now()));
    Promise.resolve(request).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function getUserStorageRevision(userId) {
  return userStorageRevisions.get(userId) || 0;
}

function bumpUserStorageRevision(userId) {
  userStorageRevisions.set(userId, getUserStorageRevision(userId) + 1);
}

function canCommitRecovery(userId, revision) {
  if (getUserStorageRevision(userId) !== revision) return false;
  const prefix = `${userId}:`;
  return !Array.from(pendingDeletions).some(key => key.startsWith(prefix));
}

function recordTime(timestamp) {
  return typeof timestamp === 'number' || /^\d+$/.test(String(timestamp))
    ? Number(timestamp) : Date.parse(timestamp);
}

function mergeCheckinExperiences(local, remote) {
  const asArray = value => Array.isArray(value) ? value : value ? [value] : [];
  const identifiers = value => value && typeof value === 'object'
    ? [value._id, value.uniqueId].filter(Boolean).map(String) : [String(value)];
  const merged = asArray(local).slice();
  asArray(remote).forEach(experience => {
    const ids = identifiers(experience);
    const index = merged.findIndex(existing => identifiers(existing).some(id => ids.includes(id)) ||
      JSON.stringify(existing) === JSON.stringify(experience));
    if (index === -1) merged.push(experience);
    else if (experience && typeof experience === 'object' && typeof merged[index] !== 'object') {
      // 旧缓存只有体验 ID 时，补上云端返回的正文。
      merged[index] = experience;
    }
  });
  return merged;
}

function findRecordIndex(records, identity) {
  const matches = records.map((record, index) => ({ record, index })).filter(({ record }) => {
    if (identity.localId) return record.localId === identity.localId;
    if (identity.recordId) return record._id === identity.recordId;
    const timestamp = recordTime(identity.timestamp);
    return Number.isFinite(timestamp) && timestamp > 0 && recordTime(record.timestamp) === timestamp;
  });
  if (matches.length > 1) throw new Error('存在相同时间的记录，暂时无法确定要删除的记录');
  return matches.length ? matches[0].index : -1;
}

function backupKey(userId, timestamp, localId) {
  return `${userId}:${localId || recordTime(timestamp)}`;
}

function resolveCheckinTimestamp(timestamp) {
  const now = Date.now();
  const value = timestamp === undefined ? now : timestamp;
  if (!Number.isSafeInteger(value) || value <= 0 || value > now) {
    throw new Error('打卡时间无效或晚于当前时间');
  }
  return value;
}

function normalizeRecordOptions(options) {
  const value = typeof options === 'string' ? { idempotencyKey: options } : (options || {});
  const key = value.idempotencyKey || value.localId;
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) {
    throw new Error('打卡记录标识无效');
  }
  return { ...value, idempotencyKey: key, source: value.source || 'timer' };
}

// 仅处理用户确认的旧记录名单：在独立快照中校验整批，再一次落盘。
function prepareUnconfirmedUploads(userId, openid, identities) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (!Array.isArray(identities)) fail('INVALID_RECORD', '待上传记录名单无效，记录已保留在本机');
  if (!identities.length) return { localIds: [], total: 0, alreadySynced: 0 };
  if (!openid) fail('AUTH_REQUIRED', '请登录后上传本机记录');
  const storageKey = `meditation_checkin_${userId}`;
  const original = wx.getStorageSync(storageKey) || {};
  const originalData = original.checkinRecords || original;
  const data = { ...originalData, dailyRecords: Object.fromEntries(
    Object.entries(originalData.dailyRecords || {}).map(([date, day]) => [date, {
      ...day, records: (day.records || []).map(record => record && { ...record })
    }])
  ) };
  const stored = original.checkinRecords ? { ...original, checkinRecords: data } : data;
  const entries = Object.entries(data.dailyRecords).flatMap(([date, day]) =>
    day.records.filter(Boolean).map(record => ({ date, record })));
  const selected = new Set();
  const localIds = [];
  let changed = false;
  let alreadySynced = 0;
  for (const identity of identities) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      fail('INVALID_RECORD', '待上传记录名单无效，记录已保留在本机');
    }
    const matches = entries.filter(({ date, record }) => identity.localId
      ? record.localId === identity.localId
      : dateUtil.getRecordTimestamp(record.timestamp) === dateUtil.getRecordTimestamp(identity.timestamp) &&
        Number(record.duration) === Number(identity.duration) &&
        dateUtil.getRecordBusinessDate(record, date) === identity.date);
    if (matches.length !== 1) fail('INVALID_RECORD', '记录已变更或无法唯一识别，请刷新后重试；记录已保留在本机');
    const { record, date } = matches[0];
    if (selected.has(record)) continue;
    selected.add(record);
    if ((record.syncOpenid && record.syncOpenid !== openid) || (record._openid && record._openid !== openid)) {
      fail('ACCOUNT_CHANGED', '请切换回保存该记录时的账号后重试');
    }
    if (record._id) { alreadySynced++; continue; }
    if (record.syncIgnored === true) fail('UPLOAD_IGNORED', '该记录已忽略上传，仍保留在本机');
    if (record.syncVersion !== 1) {
      const timestamp = dateUtil.getRecordTimestamp(record.timestamp);
      const duration = Number(record.duration);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() ||
          !Number.isInteger(duration) || duration < 1 || duration > 1440) {
        fail('INVALID_RECORD', '记录的时间或时长不完整，无法上传；记录已保留在本机');
      }
      const localId = record.localId || record.idempotencyKey || `legacy_${timestamp}_${Math.random().toString(36).slice(2)}`;
      if (typeof localId !== 'string' || !localId.trim() || localId.length > 200 ||
          entries.some(entry => entry.record !== record &&
            (entry.record.localId === localId || entry.record.idempotencyKey === localId))) {
        fail('INVALID_RECORD', '记录标识冲突，无法上传；记录已保留在本机');
      }
      Object.assign(record, {
        localId, timestamp, duration, syncVersion: 1, syncStatus: 'pending',
        syncOpenid: openid, syncLegacyRecovery: true,
        source: record.source === 'manual' || record.dateSource === 'manual' ? 'manual' : 'timer',
        date: dateUtil.getRecordBusinessDate(record, date)
      });
      ['syncError', 'syncErrorCode', 'syncBlocked', 'syncNextRetryAt'].forEach(key => { delete record[key]; });
      changed = true;
    }
    localIds.push(record.localId);
  }
  if (wx.getStorageSync('localUserId') !== userId || currentUploadOpenid() !== openid) {
    fail('ACCOUNT_CHANGED', '账号已切换，已暂停上传');
  }
  if (changed) {
    wx.setStorageSync(storageKey, stored);
    bumpUserStorageRevision(userId);
    notifySyncState();
  }
  return { localIds, total: selected.size, alreadySynced };
}

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
      // 兼容旧缓存：确保 experienceRecords 对象存在
      if (!userData.experienceRecords) {
        userData.experienceRecords = {};
      }
      
      // 保存体验记录
      userData.experienceRecords[uniqueId] = {
        _id: experienceRecord._id, // 云端ID（如果有）
        timestamp: parseInt(uniqueId), // 使用uniqueId的时间戳部分
        text: experienceRecord.text || '',
        created_at: new Date()
      };
      
      wx.setStorageSync(storageKey, userData);
      bumpUserStorageRevision(userId);
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
    if (unifiedData) restoreInterruptedUploads(unifiedData, userId);
    if (unifiedData) this.normalizeBusinessDates(unifiedData, storageKey);
    
    // 支持新的数据结构：{checkinRecords: {dailyRecords: {...}}, experienceRecords: {...}}
    if (unifiedData && unifiedData.checkinRecords && unifiedData.checkinRecords.dailyRecords) {
      // 返回新的数据结构，转换为兼容格式
      return {
        businessDayVersion: 2,
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

  normalizeBusinessDates: function(stored, storageKey) {
    const data = stored.checkinRecords || stored;
    if (!data.dailyRecords || data.businessDayVersion === 2) return;
    const days = {};
    // 无法还原时间的旧次数保留原日期，再移动有明细的记录；避免丢失部分明细的旧桶。
    Object.keys(data.dailyRecords).forEach(oldDate => {
      const oldDay = data.dailyRecords[oldDate] || {};
      const details = Array.isArray(oldDay.records) ? oldDay.records.filter(Boolean) : [];
      const unknownCount = Math.max(0, (Number(oldDay.count) || 0) - details.length);
      if (unknownCount || !details.length) {
        days[oldDate] = { ...oldDay, count: unknownCount, records: [] };
      }
    });
    Object.keys(data.dailyRecords).forEach(oldDate => {
      const oldDay = data.dailyRecords[oldDate] || {};
      const records = Array.isArray(oldDay.records) ? oldDay.records : [];
      records.forEach(record => {
        if (!record) return;
        const date = dateUtil.getRecordBusinessDate(record, oldDate);
        record.date = date;
        if (!days[date]) days[date] = { count: 0, lastCheckin: 0, records: [] };
        days[date].records.push(record);
        days[date].count++;
        days[date].lastCheckin = Math.max(recordTime(days[date].lastCheckin) || 0, recordTime(record.timestamp) || 0);
      });
    });
    data.dailyRecords = days;
    const months = new Set([...Object.keys(data.monthlyStats || {}), ...Object.keys(days).map(date => date.slice(0, 7))]);
    data.monthlyStats = {};
    months.forEach(month => {
      this.updateMonthlyStats(data, month);
      data.monthlyStats[month].count = data.monthlyStats[month].total;
      data.monthlyStats[month].totalDuration = Object.keys(days).filter(date => date.slice(0, 7) === month)
        .reduce((total, date) => total + (days[date].records || []).reduce((sum, record) => sum + (Number(record.duration) || 0), 0), 0);
    });
    data.userStats = { ...(data.userStats || {}), ...this.getUserStats(data) };
    data.businessDayVersion = 2;
    wx.setStorageSync(storageKey, stored);
    bumpUserStorageRevision(storageKey.slice('meditation_checkin_'.length));
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
    bumpUserStorageRevision(userId);
    
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

  // 首页主动校准云端记录，不受「本地已有数据」或登录同步标记限制。
  refreshFromCloud: function() {
    if (!this.isUserLoggedIn()) return Promise.resolve(false);
    const userId = this.getUserId();
    const openid = wx.getStorageSync('userOpenId');
    const key = `${userId}:${openid}`;
    if (pendingRefreshes.has(key)) return pendingRefreshes.get(key);

    const refresh = (async () => {
      try {
        // 本轮只清理请求前已同步的记录；请求/重试期间刚备份成功的记录，留待下轮确认。
        const storedAtStart = this.getUserCheckinDataByUserId(userId);
        const localAtStart = storedAtStart.checkinRecords || storedAtStart;
        const removableCloudIds = new Set();
        Object.values(localAtStart.dailyRecords || {}).forEach(day => {
          (Array.isArray(day.records) ? day.records : []).forEach(record => {
            if (record && record._id) removableCloudIds.add(record._id);
          });
        });
        // 打卡备份或其他恢复可能在读取期间落盘，重新读取一次以补齐最新数据。
        for (let attempt = 0; attempt < 2; attempt++) {
          const revision = getUserStorageRevision(userId);
          if (!canCommitRecovery(userId, revision)) return false;
          const result = await cloudApi.getAllRecords();
          if (!result.success || !Array.isArray(result.data)) return false;
          if (wx.getStorageSync('localUserId') !== userId || wx.getStorageSync('userOpenId') !== openid) return false;
          if (!canCommitRecovery(userId, revision)) continue;

          const stored = this.getUserCheckinDataByUserId(userId);
          const merged = this.mergeCloudRecordsIntoCache(stored, result.data, removableCloudIds);
          wx.setStorageSync(`meditation_checkin_${userId}`, merged);
          bumpUserStorageRevision(userId);
          this.updateMonthlyStatsCache(merged.checkinRecords, 0, dateUtil.getBusinessMonth());
          notifySyncState();
          return true;
        }
      } catch (error) {
        console.warn('首页云端记录刷新失败，保留本地记录:', error.message);
      }
      return false;
    })();
    pendingRefreshes.set(key, refresh);
    refresh.finally(() => {
      if (pendingRefreshes.get(key) === refresh) pendingRefreshes.delete(key);
    });
    return refresh;
  },

  // 完整云端快照校准已同步记录，保留离线打卡和体验；旧记录按时间/时长一对一匹配。
  mergeCloudRecordsIntoCache: function(stored, cloudRecords, removableCloudIds = null) {
    const local = stored.checkinRecords || stored;
    const records = [];
    const byId = new Map();
    const byLocalId = new Map();
    const byTime = new Map();
    Object.keys(local.dailyRecords || {}).forEach(date => {
      const day = local.dailyRecords[date] || {};
      (Array.isArray(day.records) ? day.records : []).forEach(record => {
        if (!record) return;
        const copy = { ...record, date };
        records.push(copy);
        if (copy._id) byId.set(copy._id, copy);
        if (copy.localId) byLocalId.set(copy.localId, copy);
        const time = recordTime(copy.timestamp);
        if (Number.isFinite(time) && time > 0) {
          const key = `${time}:${Number(copy.duration) || 0}`;
          if (!byTime.has(key)) byTime.set(key, []);
          byTime.get(key).push(copy);
        }
      });
    });
    const matched = new Set();
    const seenCloudIds = new Set();
    cloudRecords.forEach(record => {
      if (record._id && seenCloudIds.has(record._id)) return;
      if (record._id) seenCloudIds.add(record._id);
      // 与手动同步的时长读取规则一致，新记录和已缓存记录使用相同的默认值。
      const duration = typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : 0;
      let existing = record._id && byId.get(record._id);
      if (!existing && record.localId) {
        const candidate = byLocalId.get(record.localId);
        if (candidate && !candidate._id && !matched.has(candidate) &&
            (!candidate.syncOpenid || candidate.syncOpenid === (record._openid || currentUploadOpenid()))) existing = candidate;
      }
      if (!existing) {
        const key = `${recordTime(record.timestamp)}:${Number(record.duration) || 0}`;
        existing = (byTime.get(key) || []).find(candidate => !candidate._id && !matched.has(candidate) &&
          candidate.syncVersion !== 1 &&
          !(candidate.localId && record.localId && candidate.localId !== record.localId));
      }
      if (existing) {
        matched.add(existing);
        // 时长、时间以云端为准；本地体验可能仍在保存/上传，继续单独合并。
        const combined = {
          ...existing,
          ...record,
          timestamp: record.timestamp,
          duration
        };
        if (record._id) combined._id = record._id;
        if (record.localId) combined.localId = record.localId;
        combined.experience = mergeCheckinExperiences(existing.experience, record.experience);
        if (combined._id) {
          if (existing.syncVersion === 1) combined.syncStatus = 'synced';
          ['syncError', 'syncErrorCode', 'syncAttempts', 'syncNextRetryAt', 'syncBlocked', 'syncIgnored'].forEach(key => {
            delete combined[key];
            delete existing[key];
          });
        }
        Object.assign(existing, combined);
      } else {
        const added = { ...record, duration };
        records.push(added);
        matched.add(added);
      }
    });
    // 云端已不存在的已同步记录应退出缓存，避免每次刷新都累加陈旧记录。
    const reconciled = records.filter(record => !record._id || matched.has(record) ||
      (removableCloudIds && !removableCloudIds.has(record._id)));
    reconciled.forEach(record => {
      const time = recordTime(record.timestamp);
      if (Number.isFinite(time) && time > 0 && !Number.isNaN(new Date(time).getTime())) {
        record.date = dateUtil.getRecordBusinessDate(record);
      }
    });
    const merged = this.rebuildLocalCacheFromCloudRecords(reconciled);
    merged.experienceRecords = { ...merged.experienceRecords, ...(stored.experienceRecords || {}) };
    const data = merged.checkinRecords;
    data.userStats = { ...(local.userStats || {}), ...this.getUserStats(data) };
    Object.keys(local.monthlyStats || {}).forEach(month => {
      data.monthlyStats[month] = { ...local.monthlyStats[month] };
    });
    Object.keys(data.dailyRecords).forEach(date => {
      const day = data.dailyRecords[date];
      day.lastCheckin = day.records.reduce((latest, record) =>
        recordTime(record.timestamp) > recordTime(latest.timestamp) ? record : latest
      ).timestamp;
    });
    new Set([...Object.keys(data.monthlyStats), ...Object.keys(data.dailyRecords).map(date => date.slice(0, 7))]).forEach(month => {
      this.updateMonthlyStats(data, month);
      data.monthlyStats[month].count = data.monthlyStats[month].total;
      data.monthlyStats[month].totalDuration = Object.keys(data.dailyRecords)
        .filter(date => date.startsWith(month))
        .reduce((sum, date) => sum + data.dailyRecords[date].records.reduce((total, record) =>
          total + (Number(record.duration) || 0), 0), 0);
    });
    return merged;
  },

  // 安全的云端数据恢复（含去重保护）
  async safeRecoverFromCloud(userId) {
    try {
      const storageRevision = getUserStorageRevision(userId);
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
      const mergedData = this.mergeCloudRecordsIntoCache(this.getUserCheckinDataByUserId(userId), allRecordsResult.data);
      
      // 4. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        mergedData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 5. 保存合并结果（使用与本地打卡记录一致的键名和格式）
      if (!canCommitRecovery(userId, storageRevision)) return false;
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, mergedData);
      bumpUserStorageRevision(userId);
      this.updateMonthlyStatsCache(mergedData.checkinRecords, 0, dateUtil.getBusinessMonth());
      
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
      
      const dateStr = dateUtil.getRecordBusinessDate(cloudRecord);
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
      (existingRecord._id && existingRecord._id === cloudRecord._id) ||
      (existingRecord.localId && existingRecord.localId === cloudRecord.localId)
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
      localId: cloudRecord.localId,
      idempotencyKey: cloudRecord.idempotencyKey,
      source: cloudRecord.source,
      dateSource: cloudRecord.dateSource,
      date: dateUtil.getRecordBusinessDate(cloudRecord),
      timestamp: cloudRecord.timestamp,
      duration: cloudRecord.duration,
      emotion: cloudRecord.emotion || [],
      experience: cloudRecord.experience,
      created_at: cloudRecord.created_at
    };
  },

  // 安全的云端数据恢复（含去重保护）
  async safeRecoverFromCloud(userId) {
    try {
      const storageRevision = getUserStorageRevision(userId);
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
      const mergedData = this.mergeCloudRecordsIntoCache(this.getUserCheckinDataByUserId(userId), allRecordsResult.data);
      
      // 4. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        mergedData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 5. 保存合并结果（使用与本地打卡记录一致的键名和格式）
      if (!canCommitRecovery(userId, storageRevision)) return false;
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, mergedData);
      bumpUserStorageRevision(userId);
      this.updateMonthlyStatsCache(mergedData.checkinRecords, 0, dateUtil.getBusinessMonth());
      
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
      
      const dateStr = dateUtil.getRecordBusinessDate(cloudRecord);
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
      (existingRecord._id && existingRecord._id === cloudRecord._id) ||
      (existingRecord.localId && existingRecord.localId === cloudRecord.localId)
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
      localId: cloudRecord.localId,
      idempotencyKey: cloudRecord.idempotencyKey,
      source: cloudRecord.source,
      dateSource: cloudRecord.dateSource,
      date: dateUtil.getRecordBusinessDate(cloudRecord),
      timestamp: cloudRecord.timestamp,
      duration: cloudRecord.duration,
      emotion: cloudRecord.emotion || [],
      experience: cloudRecord.experience,
      created_at: cloudRecord.created_at
    };
  },

  // 从云端恢复用户数据
  async recoverUserDataFromCloud(userId) {
    try {
      const storageRevision = getUserStorageRevision(userId);
      const cloudApi = require('./cloudApi.js');
      
      console.log('📡 开始从云端恢复用户数据...');
      
      // 1. 获取用户所有打卡记录
      const allRecordsResult = await cloudApi.getAllRecords();
      if (!allRecordsResult.success) {
        console.error('获取云端打卡记录失败:', allRecordsResult.error);
        return false;
      }
      
      // 2. 重建本地缓存结构
      const recoveredData = this.mergeCloudRecordsIntoCache(this.getUserCheckinDataByUserId(userId), allRecordsResult.data);
      
      // 3. 获取用户统计信息
      const userStatsResult = await cloudApi.getUserStats();
      if (userStatsResult.success) {
        recoveredData.checkinRecords.userStats = userStatsResult.data;
      }
      
      // 4. 保存到本地缓存
      if (!canCommitRecovery(userId, storageRevision)) return false;
      const storageKey = `meditation_checkin_${userId}`;
      wx.setStorageSync(storageKey, recoveredData);
      bumpUserStorageRevision(userId);
      this.updateMonthlyStatsCache(recoveredData.checkinRecords, 0, dateUtil.getBusinessMonth());
      
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
        businessDayVersion: 2,
        dailyRecords: {},
        monthlyStats: {},
        userStats: {}
      },
      experienceRecords: {}
    };
    
    console.log(`🔄 重建本地缓存，共 ${cloudRecords.length} 条云端记录`);
    
    // 处理打卡记录（格式与本地打卡记录一致）
    cloudRecords.forEach(record => {
      const dateStr = dateUtil.getRecordBusinessDate(record);
      
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
        // 重建缓存也必须保留未确认记录的补传状态，不能把它们变成历史脏数据。
        ...Object.fromEntries(['syncVersion', 'syncStatus', 'syncOpenid', 'syncAttempts',
          'syncNextRetryAt', 'syncBlocked', 'syncError', 'syncErrorCode', 'syncLegacyRecovery', 'syncIgnored']
          .filter(key => record[key] !== undefined).map(key => [key, record[key]])),
        ...(record._openid ? { syncOpenid: record._openid } : {}),
        _id: record._id,
        localId: record.localId,
        idempotencyKey: record.idempotencyKey || record.localId,
        source: record.source,
        dateSource: record.dateSource,
        date: dateStr,
        timestamp: record.timestamp,
        duration: record.duration || 0,
        emotion: record.emotion || [],
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

  subscribeSyncState: function(listener) {
    syncStateListeners.add(listener);
    return () => syncStateListeners.delete(listener);
  },

  // 单条兼容入口与首页整批上传共用同一套显式准备规则。
  retryUnconfirmedRecord: async function(identity = {}) {
    const userId = this.getUserId();
    const openid = currentUploadOpenid();
    try {
      const prepared = prepareUnconfirmedUploads(userId, openid, [identity]);
      if (!prepared.localIds.length) return { success: true, uploaded: 0, alreadySynced: true };
      const result = await this.retryPendingBackups({ localIds: prepared.localIds });
      const confirmed = uploadEntries(userId).some(entry => prepared.localIds.includes(entry.record.localId) && entry.record._id);
      return { ...result, success: confirmed,
        ...(!confirmed && !result.error ? { error: '记录尚未确认上传，请稍后重试' } : {}) };
    } catch (error) {
      return { success: false, code: error.code, error: error.message || '记录仍在本机，请稍后重试上传' };
    }
  },

  // 用户核对后只忽略这一条疑似重复记录；保留原始内容和云端核对结果。
  ignoreAmbiguousUpload: function({ localId } = {}) {
    const userId = this.getUserId();
    const openid = currentUploadOpenid();
    if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请登录后忽略本机记录' };
    if (typeof localId !== 'string' || !localId.trim()) {
      return { success: false, code: 'INVALID_RECORD', error: '记录无法识别，请刷新后重试' };
    }
    try {
      const storageKey = `meditation_checkin_${userId}`;
      const stored = wx.getStorageSync(storageKey) || {};
      const data = stored.checkinRecords || stored;
      const matches = Object.entries(data.dailyRecords || {}).flatMap(([date, day]) =>
        (day.records || []).map((record, index) => ({ date, record, index }))
          .filter(({ record }) => record && record.localId === localId));
      if (matches.length !== 1) {
        return { success: false, code: 'INVALID_RECORD', error: '记录已变更或无法唯一识别，请刷新后重试' };
      }
      const { date, record, index } = matches[0];
      if ((record.syncOpenid && record.syncOpenid !== openid) || (record._openid && record._openid !== openid)) {
        return { success: false, code: 'ACCOUNT_CHANGED', error: '请切换回保存该记录时的账号后重试' };
      }
      if (record._id || record.syncVersion !== 1 || !record.syncBlocked || record.syncErrorCode !== 'AMBIGUOUS_RECORD') {
        return { success: false, code: 'INVALID_RECORD', error: '仅可忽略待核对的相似记录，请刷新后重试' };
      }
      const key = backupKey(userId, record.timestamp, localId);
      if (record.syncStatus === 'uploading' || activeUploads.has(key) || pendingBackups.has(key) || pendingDeletions.has(key)) {
        return { success: false, code: 'RECORD_BUSY', error: '记录正在处理，请稍后重试' };
      }
      if (record.syncIgnored === true) return { success: true };
      const day = data.dailyRecords[date];
      const updatedData = { ...data, dailyRecords: { ...data.dailyRecords,
        [date]: { ...day, records: day.records.map((item, position) => position === index
          ? { ...item, syncIgnored: true } : item) }
      } };
      wx.setStorageSync(storageKey, stored.checkinRecords ? { ...stored, checkinRecords: updatedData } : updatedData);
      bumpUserStorageRevision(userId);
      notifySyncState();
      return { success: true };
    } catch (error) {
      console.warn('保存忽略上传状态失败:', error.message);
      return { success: false, code: 'STORAGE_FAILED', error: '忽略状态保存失败，请重试' };
    }
  },

  getPendingSyncSummary: function({ date } = {}) {
    const openid = currentUploadOpenid();
    const entries = uploadEntries(this.getUserId()).filter(entry =>
      (!date || entry.date === date) && isPendingUpload(entry.record, openid));
    return { total: entries.length, pending: entries.filter(({ record }) => record.syncStatus !== 'uploading').length,
      failed: entries.filter(({ record }) => record.syncStatus === 'failed').length };
  },

  // 预览与实际补传使用同一资格规则，包含需单独说明的不可重试记录。
  getPendingUploadEntries: function({ date } = {}) {
    const openid = currentUploadOpenid();
    return uploadEntries(this.getUserId()).filter(entry =>
      (!date || entry.date === date) && isPendingUpload(entry.record, openid) &&
      entry.record.syncStatus !== 'uploading');
  },

  // 打开小程序只补传当前业务日的明确待上传记录，历史记录仍由首页手动确认。
  retryTodayBackups: function() {
    const userId = this.getUserId();
    const openid = currentUploadOpenid();
    if (!openid) return Promise.resolve({ success: false, uploaded: 0, code: 'AUTH_REQUIRED' });
    const today = dateUtil.getBusinessDate();
    const localIds = uploadEntries(userId).filter(({ date, record }) =>
      isPendingUpload(record, openid) && !record.syncBlocked && record.syncStatus !== 'uploading' &&
      typeof record.localId === 'string' && record.localId &&
      dateUtil.getRecordBusinessDate(record, date) === today &&
      !pendingDeletions.has(backupKey(userId, record.timestamp, record.localId)))
      .map(({ record }) => record.localId);
    return this.syncWithCloud({ uploadPending: true, localIds });
  },

  // 默认只读云端；打开小程序的补传入口必须传入当天名单，手动入口使用用户预览的名单。
  // 读请求与手动上传分别去重，慢读请求不阻塞补传。
  syncWithCloud: function({ uploadPending = false, localIds, unconfirmedRecords } = {}) {
    const userId = this.getUserId();
    const openid = currentUploadOpenid();
    const key = `${userId}:${openid}:${uploadPending ? 'upload' : 'read'}`;
    const hasLegacySelection = uploadPending && unconfirmedRecords !== undefined;
    if (hasLegacySelection && !Array.isArray(unconfirmedRecords)) {
      return Promise.resolve({ success: false, uploaded: 0, refreshed: false, code: 'INVALID_RECORD',
        error: '待上传记录名单无效，记录已保留在本机' });
    }
    const legacySelection = hasLegacySelection ? unconfirmedRecords.map(record => record && { ...record }) : [];
    const selectedLocalIds = Array.isArray(localIds) ? localIds.slice() : localIds;
    // 空预览始终是无操作，不能复用另一批正在上传的结果。
    if (uploadPending && Array.isArray(selectedLocalIds) && !selectedLocalIds.length && !legacySelection.length) {
      return this.retryPendingBackups({ localIds }).then(result => ({ ...result, refreshed: false }));
    }
    if (pendingCloudSyncs.has(key)) {
      if (legacySelection.length) return Promise.resolve({ success: false, uploaded: 0, refreshed: false,
        code: 'UPLOAD_IN_PROGRESS', error: '正在上传另一批记录，请稍后重试；记录已保留在本机' });
      return pendingCloudSyncs.get(key);
    }
    const sync = (async () => {
      if (uploadPending) {
        try {
          const prepared = prepareUnconfirmedUploads(userId, openid, legacySelection);
          const selection = hasLegacySelection
            ? Array.from(new Set([...(Array.isArray(selectedLocalIds) ? selectedLocalIds : []), ...prepared.localIds]))
            : selectedLocalIds;
          if (wx.getStorageSync('localUserId') !== userId || currentUploadOpenid() !== openid) {
            return { success: false, uploaded: 0, refreshed: false, code: 'ACCOUNT_CHANGED', error: '账号已切换，已暂停上传' };
          }
          const result = await this.retryPendingBackups({ localIds: selection });
          const unconfirmed = hasLegacySelection && uploadEntries(userId).some(({ record }) =>
            selection.includes(record.localId) && !record._id);
          return { ...result, refreshed: false, ...(unconfirmed ? { success: false,
            error: result.error || '部分记录尚未确认上传，请稍后重试' } : {}) };
        } catch (error) {
          return { success: false, uploaded: 0, refreshed: false, code: error.code,
            error: error.message || '记录仍在本机，请稍后重试上传' };
        }
      }
      const refreshed = await this.refreshFromCloud();
      const sameAccount = wx.getStorageSync('localUserId') === userId && currentUploadOpenid() === openid;
      const summary = this.getPendingSyncSummary();
      return { ...summary, uploaded: 0, success: refreshed && sameAccount, refreshed: refreshed && sameAccount,
        ...(!sameAccount ? { error: '账号已切换，已暂停同步' } : {}) };
    })();
    pendingCloudSyncs.set(key, sync);
    const clear = () => { if (pendingCloudSyncs.get(key) === sync) pendingCloudSyncs.delete(key); };
    sync.then(clear, clear);
    return sync;
  },

  // 手动补传和当天自动补传复用队列；每条记录的每次上传尝试独立计时。
  retryPendingBackups: function({ localIds } = {}) {
    const userId = this.getUserId();
    const openid = currentUploadOpenid();
    // 确认后固定上传名单；预览期间新产生的记录留给下次确认。
    const selectedIds = Array.isArray(localIds) ? new Set(localIds) : null;
    if (selectedIds && !selectedIds.size) {
      return Promise.resolve({ success: true, total: 0, uploaded: 0, failed: 0, pending: 0 });
    }
    const key = `${userId}:${openid}`;
    if (pendingUploadDrains.has(key)) return pendingUploadDrains.get(key);
    const uploadNetworkVersion = uploadNetwork.capture();
    const drain = (async () => {
      const entries = uploadEntries(userId).filter(({ record }) =>
        isPendingUpload(record, openid) && (!selectedIds || selectedIds.has(record.localId)));
      const summary = { success: false, total: entries.length, uploaded: 0, failed: 0, pending: entries.length };
      if (!entries.length) return { ...summary, success: true };
      if (!openid) return { ...summary, error: '请登录后上传本机记录' };
      try {
        for (const entry of entries) {
          if (wx.getStorageSync('localUserId') !== userId || currentUploadOpenid() !== openid) {
            summary.error = '账号已切换，已暂停上传';
            break;
          }
          // 每次重读，跳过已删除/已确认记录，不上传队列开始时的过期快照。
          const current = uploadEntries(userId).find(({ record }) => record.localId === entry.record.localId);
          if (!current || !isPendingUpload(current.record, openid)) continue;
          const { record, date } = current;
          if (record.syncBlocked) {
            summary.error = record.syncError || '部分记录无法上传，请查看记录提示';
            summary.code = record.syncErrorCode;
            continue;
          }
          const result = await this.asyncBackupToCloud(record.duration, record.emotion || [], record.experience,
            record.timestamp, record.localId, { source: record.source, date, uploadNetworkVersion });
          if (result.success) summary.uploaded++;
          else {
            summary.failed++;
            summary.error = result.error || '部分记录仍待上传';
            summary.code = result.code;
            if (!['INVALID_RECORD', 'DATE_OUT_OF_RANGE', 'CONTENT_REJECTED', 'AMBIGUOUS_RECORD'].includes(result.code)) break;
          }
        }
      } catch (error) {
        summary.error = error.message || '上传失败，记录已保存在本机';
      }
      summary.pending = uploadEntries(userId).filter(({ record }) => isPendingUpload(record, openid)).length;
      summary.success = summary.pending === 0;
      notifySyncState();
      return summary;
    })();
    pendingUploadDrains.set(key, drain);
    const clear = () => { if (pendingUploadDrains.get(key) === drain) pendingUploadDrains.delete(key); };
    drain.then(clear, clear);
    return drain;
  },

  // 保留先落本地的离线能力，但页面必须等云端返回记录 ID 才能显示上传成功。
  recordCheckinWithSync: async function(...args) {
    const userId = this.getUserId();
    const local = this.recordCheckin(...args);
    const pending = pendingBackups.get(backupKey(userId, args[3], local.localId));
    const response = pending ? await pending : null;
    const entry = uploadEntries(userId).find(({ record }) => record.localId === local.localId);
    const synced = !!(wx.getStorageSync('localUserId') === userId && entry && entry.record._id &&
      (!entry.record.syncOpenid || entry.record.syncOpenid === currentUploadOpenid()));
    return { ...local, cloudSynced: synced,
      ...(synced ? {} : {
        syncError: response && response.error || entry && entry.record.syncError || '已保存在本机，等待上传',
        syncErrorCode: response && response.code || entry && entry.record.syncErrorCode || 'UPLOAD_PENDING'
      }) };
  },
  
  // 记录打卡（本地优先，异步云端备份）
  recordCheckin: function(duration, emotion, experience = "", timestamp, options) {
    const metadata = normalizeRecordOptions(options);
    const recordTimestamp = resolveCheckinTimestamp(timestamp);
    const userId = this.getUserId();
    metadata.idempotencyKey = metadata.idempotencyKey || `record_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const key = backupKey(userId, recordTimestamp, metadata.idempotencyKey);
    const shouldUpload = this.isUserLoggedIn();
    if (shouldUpload) activeUploads.add(key);
    let localResult;
    try {
      // 1. 先落本机保障记录安全，首次请求结束前显示上传中。
      localResult = this.recordToLocal(duration, emotion, experience, recordTimestamp, metadata);
      if (!localResult || !localResult.success) {
        throw new Error('本地打卡记录保存失败');
      }

      // 2. 只尝试这条新记录；重复提交不能重传已有的待上传记录。
      const saved = uploadEntries(userId).find(({ record }) => record.localId === localResult.localId);
      if (!localResult.duplicate && shouldUpload && saved && saved.record.syncVersion === 1 && !saved.record._id) {
        this.asyncBackupToCloud(duration, emotion, experience, recordTimestamp, localResult.localId,
          metadata);
      }
    } finally {
      if (!pendingBackups.has(key)) activeUploads.delete(key);
    }
    
    // 3. 异步检查勋章解锁条件（基于本地统计数据）
    if (!localResult.duplicate) this.asyncCheckBadgeUnlock(duration);
    
    return localResult;
  },
  
  // 本地存储记录
  recordToLocal: function(duration, emotion, experience = "", timestamp, options) {
    const metadata = normalizeRecordOptions(options);
    const recordTimestamp = resolveCheckinTimestamp(timestamp);
    const dateStr = metadata.source === 'manual' && metadata.date ? metadata.date : dateUtil.getBusinessDate(recordTimestamp);
    const monthStr = dateStr.substring(0, 7);
    
    // 获取本地数据
    const userData = this.getUserCheckinData();
    
    if (metadata.idempotencyKey) {
      for (const date of Object.keys(userData.dailyRecords || {})) {
        const existing = (userData.dailyRecords[date].records || []).find(record =>
          record.localId === metadata.idempotencyKey || record.idempotencyKey === metadata.idempotencyKey);
        if (existing) return { success: true, duplicate: true, localId: existing.localId, date,
          dailyCount: userData.dailyRecords[date].count,
          monthlyTotal: (userData.monthlyStats[date.slice(0, 7)] || {}).total || 0 };
      }
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
      throw new Error('静坐时长须为 1–1440 分钟的整数');
    }
    if (metadata.source === 'manual' && !dateUtil.isRecentBusinessDate(dateStr)) {
      throw new Error('只能记录最近三天（含今天）的静坐');
    }
    // 更新每日记录
    if (!userData.dailyRecords[dateStr]) {
      userData.dailyRecords[dateStr] = {
        count: 0,
        lastCheckin: recordTimestamp,
        records: []
      };
    }
    
    // 增加打卡次数
    userData.dailyRecords[dateStr].count += 1;
    userData.dailyRecords[dateStr].lastCheckin = Math.max(
      Number(userData.dailyRecords[dateStr].lastCheckin) || 0,
      recordTimestamp
    );
    
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
      localId: metadata.idempotencyKey || `record_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      syncVersion: 1,
      syncStatus: activeUploads.has(backupKey(this.getUserId(), recordTimestamp, metadata.idempotencyKey)) ? 'uploading' : 'pending',
      syncOpenid: currentUploadOpenid(),
      source: metadata.source,
      date: dateStr,
      timestamp: recordTimestamp,
      duration: duration,
      emotion: emotion,
      experience: experienceArray, // 存储为数组，与云端一致
      textCount: textCount,
      textPreview: textPreview
    };
    
    userData.dailyRecords[dateStr].records.push(newRecord);
    
    // 更新月度统计
    this.updateMonthlyStats(userData, monthStr);
    
    // 保存数据
    if (!this.saveUserCheckinData(userData)) {
      throw new Error('本地打卡记录保存失败');
    }

    // 保存成功后再从存储刷新当前月缓存，避免漏计本次记录或缓存未保存的数据。
    this.updateMonthlyStatsCache(userData, duration, monthStr);
    notifySyncState();
    
    console.log('✅ 本地记录成功:', { date: dateStr, count: userData.dailyRecords[dateStr].count });
    
    return {
      success: true,
      localId: newRecord.localId,
      date: dateStr,
      dailyCount: userData.dailyRecords[dateStr].count,
      monthlyTotal: userData.monthlyStats[monthStr] ? userData.monthlyStats[monthStr].total : 0
    };
  },
  
  // 异步备份到云端
  asyncBackupToCloud: function(duration, emotion, experience = "", timestamp, localId, metadata) {
    const userId = this.getUserId();
    const key = backupKey(userId, timestamp, localId);
    if (pendingDeletions.has(key)) return Promise.resolve({ success: false });
    if (pendingBackups.has(key)) return pendingBackups.get(key);
    activeUploads.add(key);
    const backup = this.backupRecordToCloud(userId, duration, emotion, experience, timestamp, localId, metadata);
    pendingBackups.set(key, backup);
    const clear = () => {
      if (pendingBackups.get(key) === backup) {
        pendingBackups.delete(key);
        activeUploads.delete(key);
        notifySyncState();
      }
    };
    backup.then(clear, clear);
    return backup;
  },

  backupRecordToCloud: async function(userId, duration, emotion, experience, timestamp, localId, metadata) {
    const uploadNetworkVersion = metadata && Number.isSafeInteger(metadata.uploadNetworkVersion)
      ? metadata.uploadNetworkVersion : uploadNetwork.capture();
    let managed = false;
    let openid = '';
    let result;
    try {
      const entry = localId && uploadEntries(userId).find(({ record }) => record.localId === localId);
      managed = !!(entry && entry.record.syncVersion === 1);
      if (managed) {
        const record = entry.record;
        openid = currentUploadOpenid();
        if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请登录后上传本机记录' };
        if (wx.getStorageSync('localUserId') !== userId || (record.syncOpenid && record.syncOpenid !== openid)) {
          return { success: false, code: 'ACCOUNT_CHANGED', error: '请切换回保存该记录时的账号后重试' };
        }
        if (record._id) return { success: true, data: { recordId: record._id } };
        if (record.syncIgnored === true) {
          return { success: false, code: 'UPLOAD_IGNORED', error: '该记录已忽略上传，仍保留在本机' };
        }
        // 游客记录先持久化归属；落盘失败时绝不发送无法追踪的上传。
        if (!record.syncOpenid) {
          if (!updateStoredUpload(userId, localId, item => { item.syncOpenid = openid; })) {
            return { success: false, code: 'RECORD_NOT_FOUND', error: '本地记录已移除' };
          }
        }
        // 同一身份始终使用第一次保存的内容，不能被重提表单的新内容覆盖。
        duration = record.duration;
        emotion = record.emotion || [];
        experience = record.experience;
        timestamp = record.timestamp;
        metadata = { source: record.source || 'timer', date: record.date || entry.date, expectedOpenid: openid,
          ...(record.syncLegacyRecovery ? { recoverLegacy: true } : {}) };
        updateStoredUpload(userId, localId, item => {
          item.syncStatus = 'uploading';
          delete item.syncError;
          delete item.syncErrorCode;
        });
        notifySyncState();
      }
      metadata = { ...metadata };
      const experienceToSend = typeof experience === 'string' ? (experience ? [experience] : []) : experience;
      // 整轮重试复用固定身份及原始参数，避免云端已保存但响应丢失时重复入账。
      const uploadLocalId = localId || metadata.idempotencyKey || `record_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const args = [duration, emotion, experienceToSend, timestamp === undefined ? Date.now() : timestamp,
        uploadLocalId];
      for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
        const uploadDeadlineAt = Date.now() + UPLOAD_TIMEOUT_MS;
        try {
          await uploadNetwork.ensureOnline(uploadNetworkVersion, uploadDeadlineAt);
        } catch (error) {
          result = { success: false, code: error.code, error: error.message };
          break;
        }
        if (pendingDeletions.has(backupKey(userId, timestamp, localId))) {
          result = { success: false, code: 'UPLOAD_CANCELLED', error: '记录正在删除，已停止上传' };
          break;
        }
        if (managed) {
          // 等待重试时可能切换账号、删除记录或通过刷新取得云端确认。
          if (wx.getStorageSync('localUserId') !== userId || currentUploadOpenid() !== openid) {
            result = { success: false, code: 'ACCOUNT_CHANGED', error: '账号已切换，已暂停上传' };
            break;
          }
          const current = uploadEntries(userId).find(({ record }) => record.localId === localId);
          if (!current) {
            result = { success: false, code: 'RECORD_NOT_FOUND', error: '本地记录已移除' };
            break;
          }
          if (current.record._id) {
            result = { success: true, data: { recordId: current.record._id } };
            break;
          }
        }
        try {
          uploadNetwork.assertUninterrupted(uploadNetworkVersion);
          result = await awaitUploadUntil(cloudApi.recordMeditation(...args,
            { ...metadata, uploadDeadlineAt, uploadNetworkVersion }), uploadDeadlineAt);
          if (!result || (result.success && !(result.data && typeof result.data.recordId === 'string' && result.data.recordId.trim()))) {
            result = { success: false, code: 'INVALID_RESPONSE', error: '云端尚未确认保存，请重试上传' };
          }
        } catch (error) {
          result = { success: false, code: error && error.code || 'UPLOAD_FAILED',
            error: error && error.message || '上传失败，记录已保存在本机' };
        }
        if (managed && !result.success && wx.getStorageSync('localUserId') === userId && currentUploadOpenid() === openid) {
          const confirmed = uploadEntries(userId).find(({ record }) => record.localId === localId && record._id);
          if (confirmed) result = { success: true, data: { recordId: confirmed.record._id } };
        }
        if (result.success || NON_RETRYABLE_UPLOAD_CODES.has(result.code) || attempt === MAX_UPLOAD_RETRIES) break;
        // 每次失败后等待 100ms 再重试，并重新获得三秒期限；期间保持 uploading。
        await new Promise(resolve => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
      }
    } catch (error) {
      result = { success: false, code: error.code || 'UPLOAD_FAILED', error: error.message || '上传失败，记录已保存在本机' };
    }
    try {
      if (localId) updateStoredUpload(userId, localId, record => {
        // 首页刷新可能先拿到云端确认，不能让迟到的失败响应覆盖成功状态。
        if (record._id && !result.success) return;
        if (result.success) {
          record._id = result.data.recordId;
          if (managed) record.syncStatus = 'synced';
          delete record.syncError;
          delete record.syncErrorCode;
          delete record.syncAttempts;
          delete record.syncNextRetryAt;
          delete record.syncBlocked;
          delete record.syncIgnored;
        } else {
          record.syncError = result.error || '云端同步失败';
          record.syncErrorCode = result.code || 'SYNC_FAILED';
          if (managed) {
            record.syncStatus = 'failed';
            record.syncAttempts = (Number(record.syncAttempts) || 0) + 1;
            delete record.syncNextRetryAt;
            record.syncBlocked = ['INVALID_RECORD', 'DATE_OUT_OF_RANGE', 'CONTENT_REJECTED', 'AMBIGUOUS_RECORD'].includes(record.syncErrorCode);
          }
        }
      });
    } catch (error) {
      // 云端已写入但本机确认落盘失败，也保留原身份重试，由云端幂等去重。
      result = { success: false, code: 'STORAGE_FAILED', error: '上传状态保存失败，请重试' };
      console.warn('保存上传状态失败:', error.message);
    }
    if (managed) {
      notifySyncState();
    }
    return result;
  },

  // 云端确认后再删除本地记录；失败保留列表，重试不会重复扣减统计。
  deleteCheckin: async function(dateStr, identity = {}) {
    const userId = this.getUserId();
    const storageKey = `meditation_checkin_${userId}`;
    let key;
    let locked = false;
    try {
      const initial = this.getUserCheckinDataByUserId(userId);
      const initialData = initial.checkinRecords || initial;
      const records = (initialData.dailyRecords[dateStr] || {}).records || [];
      const index = findRecordIndex(records, identity);
      if (index === -1) return { success: false, error: '记录不存在，请刷新后重试' };
      const target = records[index];
      key = backupKey(userId, target.timestamp, target.localId);
      if (pendingDeletions.has(key)) return { success: false, error: '正在删除，请稍候' };
      pendingDeletions.add(key);
      locked = true;
      const targetIdentity = { localId: target.localId, recordId: target._id, timestamp: target.timestamp };

      // 等待已提交的备份，避免删除后尚未完成的上传又把记录写回云端。
      if (pendingBackups.has(key)) await pendingBackups.get(key);
      const latest = this.getUserCheckinDataByUserId(userId);
      const latestData = latest.checkinRecords || latest;
      const latestRecords = (latestData.dailyRecords[dateStr] || {}).records || [];
      const latestIndex = findRecordIndex(latestRecords, targetIdentity);
      if (latestIndex === -1) return { success: false, error: '记录已变更，请刷新后重试' };
      const record = latestRecords[latestIndex];
      let cloudResult;
      if (this.isUserLoggedIn()) {
        cloudResult = await cloudApi.deleteMeditationRecord({
          recordId: record._id,
          ...(record.localId ? { localId: record.localId } : {}),
          timestamp: record.timestamp,
          date: dateStr
        });
        if (!cloudResult.success && cloudResult.code !== 'RECORD_NOT_FOUND') {
          return { success: false, error: cloudResult.error || '删除记录失败，请重试' };
        }
      } else if (record._id) {
        return { success: false, error: '请登录后删除已同步的记录' };
      }

      // 网络请求期间可能新增记录，始终在最新缓存上只移除目标记录。
      const stored = this.getUserCheckinDataByUserId(userId);
      const data = stored.checkinRecords || stored;
      const day = data.dailyRecords[dateStr];
      const deleteIndex = findRecordIndex(day ? day.records : [], targetIdentity);
      if (deleteIndex !== -1) {
        day.records.splice(deleteIndex, 1);
        if (day.records.length) {
          day.count = day.records.length;
          day.lastCheckin = day.records.reduce((latestRecord, item) =>
            recordTime(item.timestamp) > recordTime(latestRecord.timestamp) ? item : latestRecord
          ).timestamp;
        } else {
          delete data.dailyRecords[dateStr];
        }
      }
      const month = dateStr.substring(0, 7);
      data.monthlyStats = data.monthlyStats || {};
      this.updateMonthlyStats(data, month);
      const monthRecords = Object.keys(data.dailyRecords).filter(date => date.startsWith(month))
        .flatMap(date => data.dailyRecords[date].records || []);
      data.monthlyStats[month].count = monthRecords.length;
      data.monthlyStats[month].totalDuration = monthRecords.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
      data.userStats = {
        ...(data.userStats || {}),
        ...this.getUserStats(data)
      };
      wx.setStorageSync(storageKey, stored);
      bumpUserStorageRevision(userId);
      this.updateMonthlyStatsCache(data, 0, month);
      wx.removeStorageSync('cloud_ranking_cache');
      notifySyncState();
      return { success: true };
    } catch (error) {
      console.error('删除静坐记录失败:', error);
      return { success: false, error: error.message || '删除记录失败，请重试' };
    } finally {
      if (locked) pendingDeletions.delete(key);
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
        // 连续勋章判定源为 longestStreak（历史最长连续，终身生效），与 badgeManager/云端重算工具一致
        const userStats = {
          longestStreak: localStats.longestStreak || 0,
          totalCheckinDays: localStats.totalDays || 0,
          lastDuration: lastDuration,
          totalDuration: localStats.totalDuration || 0
        };
        
        console.log('🔍 打卡后检查勋章条件:', userStats);
        
        // 动态引入勋章管理器（避免循环依赖）
        const badgeManager = require('./badgeManager.js');
        
        // 检查勋章解锁条件
        const result = badgeManager.checkBadgeUnlock(userStats);
        
        if (result.hasNewUnlock) {
          console.log('🎉 打卡后检测到新勋章解锁！');
          
          // 触发勋章解锁通知（基于本次新解锁集合）
          this.showBadgeUnlockToast(result.newlyUnlocked);
        }
        
      }, 100); // 延迟100ms确保本地数据保存完成
      
    } catch (error) {
      console.warn('⚠️ 勋章检查失败（不影响打卡）:', error.message);
    }
  },

  // 统一的勋章/等级解锁提示（打卡与登录两条路径共用）
  // newlyUnlocked: 本次新解锁的勋章对象数组（来自 badgeManager.checkBadgeUnlock）
  showBadgeUnlockToast: function(newlyUnlocked) {
    try {
      if (!newlyUnlocked || newlyUnlocked.length === 0) return;

      // 优先展示等级升级（category === 'level'），保证等级提升这一"值得庆祝"的事件不被覆盖丢弃
      const levelBadge = newlyUnlocked.find(b => b.category === 'level');
      const toastTitle = levelBadge
        ? `恭喜升级到 ${levelBadge.name}`
        : `解锁新勋章: ${newlyUnlocked[0].name}`;

      wx.showToast({
        title: toastTitle,
        icon: 'success',
        duration: 3000
      });

      console.log(`✅ 勋章解锁通知已触发: ${toastTitle}`);
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
    if (data) restoreInterruptedUploads(data, userId);
    if (data) this.normalizeBusinessDates(data, userKey);

    // 支持新的数据结构：{checkinRecords: {dailyRecords: {...}}, experienceRecords: {...}}
    if (data && data.checkinRecords && data.checkinRecords.dailyRecords) {
      // 返回新的数据结构，转换为兼容格式
      const result = {
        businessDayVersion: 2,
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
      bumpUserStorageRevision(userId);
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
  getUserStats: function(userData = this.getUserCheckinData()) {
    
    let totalDays = 0;
    let totalCount = 0;
    let totalDuration = 0;
    let currentStreak = 0;
    let longestStreak = 0;
    
    const dates = Object.keys(userData.dailyRecords).sort();
    
    if (dates.length > 0) {
      // 计算连续打卡天数
      // ⚠️ 修复：旧逻辑只按「有记录的日期个数」累加，没有校验日期是否真正相邻（相差1天），
      // 导致断签也被算作连续，currentStreak/longestStreak 被虚高（勋章误发的根因）。
      const dayNumber = (dateStr) => {
        const parts = String(dateStr).split('-').map(Number);
        return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
      };
      
      // 仅保留有打卡记录的日期（升序）
      const activeDates = dates.filter(dateStr => userData.dailyRecords[dateStr].count > 0);
      
      let run = 0;
      let longestStreakCalc = 0;
      let prevDayNum = null;
      
      activeDates.forEach(dateStr => {
        const dayNum = dayNumber(dateStr);
        // 仅当与上一打卡日恰好相差1天才算连续，否则重新起算
        run = (prevDayNum !== null && dayNum === prevDayNum + 1) ? run + 1 : 1;
        longestStreakCalc = Math.max(longestStreakCalc, run);
        prevDayNum = dayNum;
        totalDuration += userData.dailyRecords[dateStr].records.reduce((sum, record) => sum + record.duration, 0);
      });
      
      // currentStreak = 以最后一个打卡日结尾的连续段长度
      currentStreak = activeDates.length && activeDates[activeDates.length - 1] >= dateUtil.addBusinessDays(dateUtil.getBusinessDate(), -1) ? run : 0;
      longestStreak = longestStreakCalc;
      totalDays = activeDates.length;
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

    // 登录仅刷新云端快照，待上传记录由用户手动补传。
    await this.syncWithCloud();
    
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
  
  // 兼容旧登录/恢复入口：只刷新云端快照，不隐式补传本机记录。
  syncLocalToCloud: async function() {
    return this.syncWithCloud();
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
      const currentMonth = dateUtil.getBusinessMonth();
      const currentMinutes = this.calculateCurrentMonthMinutes(currentMonth);
      
      // 更新缓存
      this.updateMonthlyCache(currentMinutes, currentMonth);
      
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
      const currentMonth = dateUtil.getBusinessMonth();
      // 先检查缓存是否有效
      if (this.isMonthlyCacheValid(currentMonth)) {
        return this.getCachedMonthlyMinutes();
      }
      
      // 缓存失效时实时计算并更新缓存
      const minutes = this.calculateCurrentMonthMinutes(currentMonth);
      this.updateMonthlyCache(minutes, currentMonth);
      return minutes;
    } catch (error) {
      console.error('获取当月总分钟数失败:', error);
      return 0;
    }
  },

  // 实时计算当月总分钟数
  calculateCurrentMonthMinutes: function(currentMonth = dateUtil.getBusinessMonth()) {
    try {
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
  isMonthlyCacheValid: function(currentMonth = dateUtil.getBusinessMonth()) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_monthly_stats_${userId}`;
      const monthlyStatsCache = wx.getStorageSync(storageKey) || {};
      if (monthlyStatsCache.businessDayVersion !== 2) return false;
      
      // 检查缓存月份是否匹配
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
  updateMonthlyCache: function(minutes, currentMonth = dateUtil.getBusinessMonth()) {
    try {
      const userId = this.getUserId();
      const storageKey = `meditation_monthly_stats_${userId}`;
      // 计算与写入使用同一月份，避免月初 02:00 跨界把旧月分钟数写入新月缓存。
      const monthlyStatsCache = {
        businessDayVersion: 2,
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
