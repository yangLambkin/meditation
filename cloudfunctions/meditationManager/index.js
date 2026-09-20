const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// 与小程序一致：北京时间 02:00 切换业务日期，按 UTC 分量读取避免容器时区影响。
function getBusinessDate(date) {
  const timestamp = new Date(date === undefined ? Date.now() : date).getTime();
  return new Date(timestamp + 6 * 3600000).toISOString().slice(0, 10);
}
function getBusinessMonth(date) { return getBusinessDate(date).slice(0, 7); }
function isDateLabel(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
function getRecordBusinessDate(record) {
  if ((record.source === 'manual' || record.dateSource === 'manual') && isDateLabel(record.date)) return record.date;
  const timestamp = meditationTimestamp(record.timestamp);
  return Number.isFinite(timestamp) ? getBusinessDate(timestamp) : record.date;
}
function stableDocumentId(prefix, openid, key) {
  return prefix + require('crypto').createHash('sha256').update(JSON.stringify([openid, key])).digest('hex');
}

// 云函数入口函数
exports.main = async (event, context) => {
  // 添加调试日志
  console.log('云函数接收到的参数:', JSON.stringify(event));
  
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  console.log('当前用户openid:', openid);
  console.log('尝试处理的操作类型:', event.type);
  
  switch (event.type) {
    case "login":
      return await handleLogin(wxContext, event.code);
    case "recordMeditation":
      return await recordMeditation(openid, event.data, event.localUserId);
    case "deleteMeditationRecord":
      return await deleteMeditationRecord(openid, event.data);
    case "getUserRecords":
      return await getUserRecords(openid, event.date);
    case "migrateBusinessDates":
      if (openid) return { success: false, error: '仅支持云端运维调用' };
      return await migrateBusinessDates(event);
    case "getUserStats":
      return await getUserStats(openid);
    case "getMonthlyStats":
      return await getMonthlyStats(openid, event.month);
    case "getAllRecords":
      return await getAllRecords(openid);
    case "updateMeditationRecord":
      return await updateMeditationRecord(openid, event.recordId, event.experience);
    case "saveExperienceRecord":
      return await saveExperienceRecord(openid, event.record, event.localUserId);
    case "deleteExperienceRecord":
      return await deleteExperienceRecord(openid, event.recordId);
    case "migrateLocalData":
      return await migrateLocalData(openid, event.localUserId);
    case "getUserMapping":
      return await getUserMapping(openid);
    case "updateUserProfile":
      return await updateUserProfile(openid, event.userInfo, event.userType);
    case "getUserProfile":
      return await getUserProfile(openid);
    case "migrateUserProfile":
      return await migrateUserProfile(openid, event.oldUserInfo);
    case "getRankingSnapshot":
      return await getRankingSnapshot(event, context);
    case "updateUserBadges":
      return await updateUserBadges(openid, event.badges);
    case "getUserBadges":
      return await getUserBadges(openid);
    case "recomputeUserBadges":
      return await recomputeUserBadges(event);
    default:
      return { success: false, error: "未知的操作类型" };
  }
};

function databaseErrorText(error) {
  return typeof error === 'string' ? error : [error && error.code, error && error.errCode,
    error && error.message, error && error.errMsg].filter(value => value !== undefined).join(' ');
}

function isMissingCollection(error) {
  const codes = [error && error.code, error && error.errCode].map(String);
  // wx-server-sdk 的 -502005 专指集合不存在；通用请求失败码不能视为缺集合。
  return codes.includes('-502005') || /\b(?:DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)\b/i.test(databaseErrorText(error)) ||
    /\bcollection\b(?:\s+["'`]?[\w.-]+["'`]?)?\s+(?:(?:does|is)\s+)?(?:not exists?|not found)\b|集合\s*(?:["'`]?[\w.-]+["'`]?)?\s*不存在/i.test(databaseErrorText(error));
}

function isExistingCollection(error) {
  const text = databaseErrorText(error);
  return /\b(?:DATABASE_COLLECTION_(?:ALREADY_)?EXISTS?|COLLECTION_ALREADY_EXISTS?|TCB_DB_COLLECTION_EXISTS)\b/i.test(text) ||
    /\b(?:collection|table)\b[^\n]*\balready exists?\b|集合[^\n]*已存在/i.test(text);
}

async function optionalDocument(database, collection, id) {
  try { return (await database.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    // 文档不存在是首次写入的正常情况；集合不存在必须由调用方修复，不能伪装成空文档。
    if (!isMissingCollection(error) && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(databaseErrorText(error))) return null;
    throw error;
  }
}

let meditationLockCollectionCreation;
async function initializeMeditationLockCollection() {
  if (!meditationLockCollectionCreation) {
    meditationLockCollectionCreation = (async () => {
      try {
        // 仅服务端创建空辅助集合；不写样例、不设置或放宽客户端数据库权限。
        await db.createCollection('meditation_locks');
      } catch (error) {
        // 不同云函数实例可能同时创建；只允许明确的“已存在”继续执行。
        if (!isExistingCollection(error)) {
          console.error('初始化静坐记录锁集合失败:', error);
          throw deletionError('LOCK_COLLECTION_UNAVAILABLE', '云端保存暂不可用：无法初始化记录锁集合，请稍后重试或联系管理员');
        }
      }
    })();
  }
  try { await meditationLockCollectionCreation; }
  finally { meditationLockCollectionCreation = null; }
}

async function readMeditationLock(lockId) {
  try { return await optionalDocument(db, 'meditation_locks', lockId); }
  catch (error) {
    if (!isMissingCollection(error)) throw error;
    await initializeMeditationLockCollection();
    // 创建成功（或被其他实例先创建）后重新读取，不能把仍然不可用的集合当成空锁。
    return await optionalDocument(db, 'meditation_locks', lockId);
  }
}

// 查询在事务外分页执行，事务内仅使用 doc API，兼容云开发各 SDK 版本。
// 每次修改都推进用户 revision；快照读取期间发生任何写入时重读，避免丢累计统计。
async function withMeditationSnapshot(openid, operation, dryRun = false) {
  // 预览无需锁，也不能因缺少集合而创建任何云端数据。
  if (dryRun) return operation(null,
    await getMeditationDeletionRows(db, 'meditation_records', openid),
    await getMeditationDeletionRows(db, 'user_stats', openid));
  const lockId = stableDocumentId('lock_', openid, 'records');
  for (let attempt = 0; attempt < 12; attempt++) {
    const before = await readMeditationLock(lockId);
    const revision = before ? Number(before.revision) || 0 : 0;
    const records = await getMeditationDeletionRows(db, 'meditation_records', openid);
    const stats = await getMeditationDeletionRows(db, 'user_stats', openid);
    try {
      return await db.runTransaction(async transaction => {
        const current = await optionalDocument(transaction, 'meditation_locks', lockId);
        if ((current ? Number(current.revision) || 0 : 0) !== revision) {
          throw deletionError('STALE_SNAPSHOT', '记录已变更，重新读取');
        }
        const result = await operation(transaction, records, stats);
        if (!result || !result.duplicate) await transaction.collection('meditation_locks').doc(lockId).set({ data: {
          ownerOpenid: openid, revision: revision + 1, updatedAt: new Date()
        } });
        return result;
      });
    } catch (error) {
      if (error.code !== 'STALE_SNAPSHOT') throw error;
    }
  }
  throw deletionError('RETRY_REQUIRED', '同步繁忙，请稍后重试');
}

// 记录冥想打卡（支持本地用户标识）
async function recordMeditation(openid, data = {}, localUserId = null) {
  if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请先登录后再记录' };
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('打卡参数无效');
    if (data.expectedOpenid !== undefined && data.expectedOpenid !== openid) {
      return { success: false, code: 'ACCOUNT_CHANGED', error: '登录账号已变更，请切换回保存该记录时的账号后重试' };
    }
    const now = new Date();
    const timestamp = data.timestamp === undefined ? now.getTime() : data.timestamp;
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now.getTime()) {
      return { success: false, error: '打卡时间无效或晚于当前时间' };
    }
    const key = data.idempotencyKey || data.localId;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) {
      return { success: false, code: 'INVALID_RECORD', error: '本地记录标识无效' };
    }
    const duration = Number(data.duration || 0);
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('静坐时长须为 1–1440 分钟的整数');
    const source = data.source === 'manual' || data.dateSource === 'manual' ? 'manual' : 'timer';
    const dateStr = source === 'manual' && data.date ? data.date : getBusinessDate(timestamp);
    if (!isDateLabel(dateStr)) throw new Error('打卡日期无效');
    const record = {
      _openid: openid, date: dateStr, timestamp, duration, source, businessDayVersion: 2,
      emotion: Array.isArray(data.emotion) ? data.emotion : [],
      experience: Array.isArray(data.experience) ? data.experience : (data.experience ? [data.experience] : []),
      createdAt: now, updatedAt: now
    };
    if (key) {
      record.localId = key;
      record.idempotencyKey = key;
      record._id = stableDocumentId('med_', openid, key);
    }
    if (!record._id) record._id = stableDocumentId('med_', openid, require('crypto').randomBytes(16).toString('hex'));
    const result = await withMeditationSnapshot(openid, async (transaction, records, statsRows) => {
      const existing = key && records.find(row => row.localId === key || row.idempotencyKey === key || row._id === record._id);
      // 成功后的重试即使跨过三天窗口，仍返回原结果；不再次写心得或累计统计。
      if (existing) return { recordId: existing._id, date: getRecordBusinessDate(existing), timestamp: existing.timestamp, duplicate: true };
      if (source === 'manual') {
        const today = getBusinessDate(now);
        const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
        if (dateStr < earliest || dateStr > today) throw deletionError('DATE_OUT_OF_RANGE', '只能记录最近三天（含今天）的静坐');
      }
      const { _id, ...document } = record;
      await transaction.collection('meditation_records').doc(_id).set({ data: document });
      await writeRebuiltStats(transaction, openid, statsRows, rebuildMeditationStats([...records, record]));
      return { recordId: record._id, date: dateStr, timestamp, duplicate: false };
    });
    if (localUserId) await createUserMapping(openid, localUserId);
    return { success: true, data: result };
  } catch (error) {
    console.error('记录冥想打卡失败:', error);
    return { success: false, code: error.code || error.errCode || 'RECORD_FAILED', error: error.message || error.errMsg || '云端保存失败，请稍后重试' };
  }
}

async function writeRebuiltStats(transaction, openid, rows, stats) {
  if (rows.length) {
    for (const row of rows) {
      const result = await transaction.collection('user_stats').doc(row._id).update({
        data: { ...stats, businessDayVersion: 2, monthlyStats: db.command.set(stats.monthlyStats) }
      });
      if (!result.stats || result.stats.updated !== 1) throw deletionError('STATS_UPDATE_FAILED', '更新统计失败，请重试');
    }
  } else {
    // 同一用户并发写第一条记录时，同一个统计文档使事务冲突并自动重试。
    await transaction.collection('user_stats').doc(stableDocumentId('stats_', openid, 'statistics')).set({ data: {
      _openid: openid, ...stats, businessDayVersion: 2, createdAt: new Date()
    } });
  }
}

// 上线后可从云端控制台分批调用，重新归属旧记录及日/月/连续天数统计。
// 返回 nextCursor，下一批带 afterId；仅云端运维调用，无客户端身份时才开放。
function mergeDuplicateRecords(records) {
  const canonical = [];
  const byKey = new Map();
  const duplicates = [];
  for (const record of records) {
    const keys = [record.localId, record.idempotencyKey].filter(Boolean);
    const prior = keys.map(key => byKey.get(key)).find(Boolean);
    if (prior) {
      const experiences = Array.isArray(prior.experience) ? prior.experience : prior.experience ? [prior.experience] : [];
      const incoming = Array.isArray(record.experience) ? record.experience : record.experience ? [record.experience] : [];
      for (const experience of incoming) {
        if (!experiences.some(existing => JSON.stringify(existing) === JSON.stringify(experience))) experiences.push(experience);
      }
      prior.experience = experiences;
      duplicates.push({ recordId: record._id, keepRecordId: prior._id });
      keys.forEach(key => byKey.set(key, prior));
    } else {
      const copy = { ...record };
      if (Array.isArray(record.experience)) copy.experience = record.experience.slice();
      canonical.push(copy);
      keys.forEach(key => byKey.set(key, copy));
    }
  }
  return { records: canonical, duplicates };
}

async function migrateBusinessDates(event) {
  const dryRun = event.dryRun !== false;
  let query = db.collection('meditation_records');
  if (event.afterId) query = query.where({ _id: db.command.gt(event.afterId) });
  const batch = await query.orderBy('_id', 'asc').limit(100).get();
  const users = [];
  for (const openid of new Set(batch.data.map(record => record._openid))) {
    const summary = await withMeditationSnapshot(openid, async (transaction, records, stats) => {
      const merged = mergeDuplicateRecords(records);
      const dateChanges = merged.records.filter(record => record.date !== getRecordBusinessDate(record))
        .map(record => ({ recordId: record._id, from: record.date, to: getRecordBusinessDate(record) }));
      if (!dryRun) {
        for (const record of merged.records) {
          await transaction.collection('meditation_records').doc(record._id).update({ data: {
            date: getRecordBusinessDate(record), businessDayVersion: 2,
            ...(record.experience !== undefined ? { experience: record.experience } : {})
          } });
        }
        for (const duplicate of merged.duplicates) {
          await transaction.collection('meditation_records').doc(duplicate.recordId).remove();
        }
        await writeRebuiltStats(transaction, openid, stats, rebuildMeditationStats(merged.records));
      }
      return { openid, recordCount: records.length, dateChanges, duplicates: merged.duplicates,
        resultingRecordCount: merged.records.length };
    }, dryRun);
    users.push(summary);
  }
  return { success: true, data: { dryRun, scannedRecords: batch.data.length, users,
    nextCursor: batch.data.length === 100 ? batch.data[batch.data.length - 1]._id : null } };
}

function meditationTimestamp(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}

function deletionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 分页读取每位用户的记录；调用方用用户 revision 保障快照在写入事务时仍有效。
async function getMeditationDeletionRows(database, collection, openid) {
  const rows = [];
  const pageSize = 100;
  while (true) {
    const result = await database.collection(collection)
      .where({ _openid: openid }).orderBy('_id', 'asc')
      .skip(rows.length).limit(pageSize).get();
    rows.push(...result.data);
    if (result.data.length < pageSize) return rows;
  }
}

function rebuildMeditationStats(records) {
  records = mergeDuplicateRecords(records).records;
  const days = new Map();
  const monthlyStats = {};
  let totalDuration = 0;
  let latestRecord;
  let latestDate = '';
  let latestTimestamp = -Infinity;
  for (const record of records) {
    const timestamp = meditationTimestamp(record.timestamp);
    const date = getRecordBusinessDate(record);
    if (!isDateLabel(date)) throw deletionError('INVALID_STORED_RECORD', '历史记录日期异常，暂时无法更新统计');
    const rawDuration = Number(record.duration);
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const month = date.substring(0, 7);
    totalDuration += duration;
    days.set(date, (days.get(date) || 0) + duration);
    if (!monthlyStats[month]) monthlyStats[month] = { days: [], count: 0, totalDuration: 0 };
    monthlyStats[month].count++;
    monthlyStats[month].totalDuration += duration;
    if (!monthlyStats[month].days.includes(date)) monthlyStats[month].days.push(date);
    const comparableTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
    if (date > latestDate || (date === latestDate && comparableTimestamp >= latestTimestamp)) {
      latestDate = date;
      latestTimestamp = comparableTimestamp;
      latestRecord = { duration };
    }
  }
  const dates = Array.from(days.keys()).sort();
  let currentStreak = 0;
  let longestStreak = 0;
  let previousDay;
  for (const date of dates) {
    const day = Date.parse(`${date}T00:00:00Z`) / 86400000;
    currentStreak = previousDay !== undefined && day - previousDay === 1 ? currentStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, currentStreak);
    previousDay = day;
  }
  Object.values(monthlyStats).forEach(month => month.days.sort());
  return {
    totalDays: dates.length,
    totalCount: records.length,
    totalDuration,
    // 与写入和排名逻辑一致：日/月累计对应最近一次打卡所在日/月。
    dailyTotalDuration: days.get(latestDate) || 0,
    monthlyTotalDuration: monthlyStats[latestDate.substring(0, 7)]?.totalDuration || 0,
    longestCheckInDays: longestStreak,
    currentStreak,
    longestStreak,
    lastCheckinDate: latestDate,
    lastCheckinDuration: latestRecord ? latestRecord.duration : 0,
    lastCheckin: latestDate,
    monthlyStats,
    updatedAt: new Date()
  };
}

// 删除记录和重算统计共同提交；统计写入失败时，原记录仍然保留。
async function deleteMeditationRecord(openid, data = {}) {
  if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请先登录后再删除记录' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { success: false, code: 'INVALID_RECORD', error: '删除记录参数无效' };
  }
  const recordId = data.recordId;
  if (recordId !== undefined && recordId !== null && recordId !== '' &&
      (typeof recordId !== 'string' || !recordId.trim())) {
    return { success: false, code: 'INVALID_RECORD', error: '记录标识无效' };
  }
  const localId = data.localId;
  if (!recordId && localId !== undefined && (typeof localId !== 'string' || !localId.trim())) {
    return { success: false, code: 'INVALID_RECORD', error: '本地记录标识无效' };
  }
  const timestamp = meditationTimestamp(data.timestamp);
  if (!recordId && !localId && (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date || ''))) {
    return { success: false, code: 'INVALID_RECORD', error: '缺少记录标识或打卡日期、时间' };
  }
  try {
    const result = await withMeditationSnapshot(openid, async (transaction, records, statsRows) => {
      // 新本地记录的备份可能失败，此时 localId 未命中不能降级为时间匹配，
      // 否则会误删云端恰好同一时间的另一条记录。仅旧缓存使用时间定位。
      const matches = records.filter(record => recordId
        ? record._id === recordId
        : localId ? record.localId === localId
          : getRecordBusinessDate(record) === data.date && meditationTimestamp(record.timestamp) === timestamp);
      if (!matches.length) throw deletionError('RECORD_NOT_FOUND', '记录不存在或已被删除');
      if (matches.length !== 1) throw deletionError('AMBIGUOUS_RECORD', '存在多条匹配记录，请刷新记录后重试');
      const target = matches[0];
      const stats = rebuildMeditationStats(records.filter(record => record._id !== target._id));

      const removed = await transaction.collection('meditation_records').doc(target._id).remove();
      if (!removed.stats || removed.stats.removed !== 1) {
        throw deletionError('RECORD_NOT_FOUND', '记录不存在或已被删除');
      }
      if (statsRows.length) {
        for (const row of statsRows) {
          const updated = await transaction.collection('user_stats').doc(row._id).update({
            data: { ...stats, businessDayVersion: 2, monthlyStats: db.command.set(stats.monthlyStats) }
          });
          if (!updated.stats || updated.stats.updated !== 1) {
            throw deletionError('STATS_UPDATE_FAILED', '更新统计失败，请重试');
          }
        }
      } else {
        await transaction.collection('user_stats').doc(stableDocumentId('stats_', openid, 'statistics')).set({
          data: { _openid: openid, ...stats, businessDayVersion: 2, createdAt: new Date() }
        });
      }
      return { recordId: target._id, date: getRecordBusinessDate(target), timestamp: target.timestamp, stats };
    });
    return { success: true, data: result };
  } catch (error) {
    console.error('删除冥想记录失败:', error);
    return { success: false, code: error.code || 'DELETE_FAILED', error: error.message || '删除失败，请重试' };
  }
}

// 更新用户统计（字段与数据库完全一致）
async function updateUserStats(openid, dateStr, duration) {
  try {
    const today = new Date();
    const monthStr = dateStr.substring(0, 7);
    
    const userStatsRef = db.collection("user_stats").where({
      _openid: openid
    });
    
    const userStats = await userStatsRef.get();
    
    if (userStats.data.length === 0) {
      // 创建新用户统计 - 增加每日时长统计
      await db.collection("user_stats").add({
        data: {
          _openid: openid,
          totalDays: 1,
          totalCount: 1,
          totalDuration: duration,
          dailyTotalDuration: duration, // 当日总时长
          monthlyTotalDuration: duration, // 当月总分钟数
          longestCheckInDays: 1,         // 最长连续天数
          lastCheckinDate: dateStr,     // 上次打卡日期
          lastCheckinDuration: duration, // 上次打卡时长
          currentStreak: 1,
          longestStreak: 1,
          lastCheckin: dateStr,
          monthlyStats: {
            [monthStr]: {
              days: [dateStr],
              count: 1,
              totalDuration: duration
            }
          },
          createdAt: today,
          updatedAt: today
        }
      });
    } else {
      // 更新现有用户统计
      const stats = userStats.data[0];
      const latestDate = [stats.lastCheckinDate, stats.lastCheckin].filter(Boolean).sort().pop() || '';
      const knownDates = new Set(Object.values(stats.monthlyStats || {})
        .flatMap(month => Array.isArray(month.days) ? month.days : []));
      if (latestDate) knownDates.add(latestDate);
      const isNewDay = !knownDates.has(dateStr);
      const isBackdated = !!latestDate && dateStr < latestDate;
      
      // 判断是否是同一天（当日总时长需要累加）
      // 使用lastCheckinDate字段来判断同一天，因为lastCheckin可能被其他逻辑更新
      const isSameDay = latestDate === dateStr;
      
      console.log(`更新用户统计: openid=${openid}, dateStr=${dateStr}, lastCheckinDate=${stats.lastCheckinDate}, dailyTotalDuration=${stats.dailyTotalDuration || 0}, isSameDay=${isSameDay}, isNewDay=${isNewDay}`);
      
      const updateData = {
        totalCount: db.command.inc(1),
        totalDuration: db.command.inc(duration),
        updatedAt: today
      };
      
      // 处理每日时长统计
      if (isSameDay) {
        // 同一天打卡，累加当日总时长
        const currentDailyTotal = stats.dailyTotalDuration || 0;
        updateData.dailyTotalDuration = db.command.inc(duration);
        console.log(`同一天打卡，累加时长: ${currentDailyTotal} + ${duration} = ${currentDailyTotal + duration}`);
      } else if (!isBackdated) {
        // 新的一天，重置当日总时长
        updateData.dailyTotalDuration = duration;
        updateData.lastCheckinDate = dateStr;
        updateData.lastCheckinDuration = duration;
        console.log(`新的一天打卡，重置时长: ${duration}`);
      }
      
      // 更新当月总分钟数：跨月时清零重置为当月值，避免 monthlyTotalDuration 沦为累计值（修复 4.2）
      const currentMonthlyTotal = stats.monthlyTotalDuration || 0;
      const lastMonthStr = latestDate.substring(0, 7);
      if (monthStr > lastMonthStr) {
        // 跨月首次打卡：重置为当月当前时长（与 dailyTotalDuration 同口径）
        updateData.monthlyTotalDuration = duration;
        console.log(`跨月重置当月总分钟数: ${currentMonthlyTotal} -> ${duration} (${lastMonthStr} -> ${monthStr})`);
      } else if (monthStr === lastMonthStr) {
        updateData.monthlyTotalDuration = db.command.inc(duration);
        console.log(`更新当月总分钟数: ${currentMonthlyTotal} + ${duration} = ${currentMonthlyTotal + duration}`);
      }
      
      // 计算本次打卡后的连续天数（用于最长连续天数取 max；修复 4.3：同一天多次打卡不再虚高）
      let newStreak = stats.currentStreak || 1;
      if (isNewDay && stats.lastCheckin) {
        const lastDate = new Date(stats.lastCheckin);
        const currentDate = new Date(dateStr);
        const diffDays = Math.floor((currentDate - lastDate) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          newStreak = (stats.currentStreak || 0) + 1;
        } else if (diffDays > 1) {
          newStreak = 1;
        }
        // diffDays === 0（同一天）时 newStreak 保持 stats.currentStreak，连续天数不增长
      }

      // 更新最长连续天数：取历史最大值，仅在连续天数真正增长时更新
      const currentLongestCheckInDays = stats.longestCheckInDays || 1;
      if (newStreak > currentLongestCheckInDays) {
        updateData.longestCheckInDays = newStreak;
        console.log(`更新最长连续天数: ${currentLongestCheckInDays} -> ${newStreak}`);
      }
      
      if (isNewDay) {
        updateData.totalDays = db.command.inc(1);
        if (!isBackdated) updateData.lastCheckin = dateStr;
        
        // 计算连续打卡
        if (stats.lastCheckin) {
          const lastDate = new Date(stats.lastCheckin);
          const currentDate = new Date(dateStr);
          const diffDays = Math.floor((currentDate - lastDate) / (1000 * 60 * 60 * 24));
          
          if (diffDays === 1) {
            updateData.currentStreak = db.command.inc(1);
            updateData.longestStreak = db.command.max(stats.currentStreak + 1);
          } else if (diffDays > 1) {
            updateData.currentStreak = 1;
          }
        }
      }

      // 补齐历史缺口时按已知日期重新计算连续天数，且始终以最新打卡日结尾。
      // 旧统计若缺少完整日期明细，保留既有连续统计，避免因不完整缓存倒退。
      if (isBackdated && knownDates.size >= (stats.totalDays || 0)) {
        knownDates.add(dateStr);
        const orderedDates = Array.from(knownDates).sort();
        let streak = 0;
        let longest = 0;
        let previousDay;
        orderedDates.forEach(date => {
          const day = Date.parse(`${date}T00:00:00Z`) / 86400000;
          streak = previousDay !== undefined && day - previousDay === 1 ? streak + 1 : 1;
          longest = Math.max(longest, streak);
          previousDay = day;
        });
        updateData.currentStreak = streak;
        updateData.longestStreak = db.command.max(longest);
        updateData.longestCheckInDays = db.command.max(longest);
      }
      
      // 更新月度统计
      const monthlyUpdate = {};
      if (!stats.monthlyStats || !stats.monthlyStats[monthStr]) {
        monthlyUpdate[`monthlyStats.${monthStr}`] = {
          days: [dateStr],
          count: 1,
          totalDuration: duration
        };
      } else {
        monthlyUpdate[`monthlyStats.${monthStr}.count`] = db.command.inc(1);
        monthlyUpdate[`monthlyStats.${monthStr}.totalDuration`] = db.command.inc(duration);
        if (isNewDay) {
          monthlyUpdate[`monthlyStats.${monthStr}.days`] = db.command.push(dateStr);
        }
      }
      
      Object.assign(updateData, monthlyUpdate);
      
      await userStatsRef.update({
        data: updateData
      });
    }
    
  } catch (error) {
    console.error("更新用户统计失败:", error);
  }
}

// 获取用户某天的打卡记录
async function getUserRecords(openid, date) {
  try {
    const result = await getAllRecords(openid);
    if (!result.success) return result;
    result.data = result.data.map(record => ({ ...record, date: getRecordBusinessDate(record) }))
      .filter(record => record.date === date);

    return {
      success: true,
      data: result.data
    };
  } catch (error) {
    console.error("获取用户记录失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取用户统计信息
async function getUserStats(openid) {
  if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请先登录后再获取统计' };
  try {
    const result = await db.collection("user_stats")
      .where({
        _openid: openid
      })
      .get();
    
    let userStats = result.data[0] || {};
    // 历史统计尚未迁移时，读取也必须按 02:00 重算；不等待用户下一次打卡。
    // 只读回退保留勋章和创建信息，不触发迁移写入或改变原始记录。
    if (userStats.businessDayVersion !== 2) {
      const records = await getAllRecords(openid);
      if (!records.success) return records;
      userStats = { ...userStats, ...rebuildMeditationStats(records.data) };
    }
    const latestDate = userStats.lastCheckinDate || userStats.lastCheckin || '';
    const today = getBusinessDate();
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

    // 确保返回的数据包含所有必要的字段
    return {
      success: true,
      data: {
        totalDays: userStats.totalDays || 0,
        totalCount: userStats.totalCount || 0,
        totalDuration: userStats.totalDuration || 0,
        dailyTotalDuration: latestDate === today ? userStats.dailyTotalDuration || 0 : 0,
        monthlyTotalDuration: latestDate.slice(0, 7) === today.slice(0, 7) ? userStats.monthlyTotalDuration || 0 : 0,
        longestCheckInDays: userStats.longestCheckInDays || 0,
        currentStreak: latestDate >= yesterday ? userStats.currentStreak || 0 : 0,
        longestStreak: userStats.longestStreak || 0,
        lastCheckinDate: latestDate,
        lastCheckinDuration: userStats.lastCheckinDuration || 0,
        lastCheckin: userStats.lastCheckin || '',
        monthlyStats: userStats.monthlyStats || {},
        createdAt: userStats.createdAt || '',
        updatedAt: userStats.updatedAt || ''
      }
    };
  } catch (error) {
    console.error("获取用户统计失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取用户排名（仅计算当前用户在打卡用户中的名次与总人数，无榜单/无前100限制/不取昵称）
// 性能模型：固定 3 次 DB 调用（1 次 get + 2 次 count），不再 orderBy 全表、不再 N+1 昵称查询
async function getRankings(period) {
  try {
    const wxContext = cloud.getWXContext();
    const currentUserOpenId = wxContext.OPENID;
    const today = getBusinessDate();
    
    console.log(`🔍 获取用户排名，用户: ${currentUserOpenId}`);
    
    // 1. 查询当前用户的当日总时长（仅取必要字段）
    const userStatRes = await db.collection("user_stats")
      .where({ _openid: currentUserOpenId })
      .field({ dailyTotalDuration: true, lastCheckinDate: true, lastCheckin: true })
      .get();
    
    // 日累计字段保留最近打卡日的值；历史补卡不参与今日排名。
    const userStat = userStatRes.data[0];
    const latestDate = userStat && (userStat.lastCheckinDate || userStat.lastCheckin);
    if (!userStat || latestDate !== today) {
      const total = await db.collection("user_stats").count();
      console.log(`⚠️ 当前用户暂无打卡记录，总打卡用户数: ${total.total}`);
      return {
        success: true,
        data: {
          type: period,
          period: today,
          currentUserOpenId: currentUserOpenId,
          currentUserRank: 0,
          hasRanking: false,
          totalUsers: total.total
        }
      };
    }
    
    const userDuration = userStat.dailyTotalDuration || 0;
    
    // 2. 名次 = 当日总时长严格大于当前用户的人数 + 1
    //    count 聚合不受 get() 单次 1000 条限制，任意用户量下名次准确；
    //    并列时长者获得相同名次（均为"大于者数 + 1"），语义合理。
    const higherCount = await db.collection("user_stats")
      .where(db.command.and([
        { dailyTotalDuration: db.command.gt(userDuration) },
        db.command.or([
          { lastCheckinDate: today },
          { lastCheckinDate: db.command.exists(false), lastCheckin: today },
          { lastCheckinDate: '', lastCheckin: today },
          { lastCheckinDate: null, lastCheckin: today }
        ])
      ]))
      .count();
    
    // 3. 真实总打卡用户数（count 返回完整总数，不受前 100 限制）
    const totalCount = await db.collection("user_stats").count();
    
    console.log(`✅ 用户排名计算完成：名次 ${higherCount.total + 1}，总用户数 ${totalCount.total}`);
    
    return {
      success: true,
      data: {
        type: period,
        period: today,
        currentUserOpenId: currentUserOpenId,
        currentUserRank: higherCount.total + 1,
        hasRanking: true,
        totalUsers: totalCount.total
      }
    };
  } catch (error) {
    console.error("❌ 获取用户排名失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取月度统计
async function getMonthlyStats(openid, month) {
  try {
    const result = await getAllRecords(openid);
    if (!result.success) return result;
    result.data = result.data.map(record => ({ ...record, date: getRecordBusinessDate(record) }))
      .filter(record => record.date && record.date.slice(0, 7) === month);

    // 按日期分组统计
    const dailyStats = {};
    result.data.forEach(record => {
      if (!dailyStats[record.date]) {
        dailyStats[record.date] = {
          date: record.date,
          count: 0,
          totalDuration: 0,
          records: []
        };
      }
      dailyStats[record.date].count++;
      dailyStats[record.date].totalDuration += record.duration;
      dailyStats[record.date].records.push(record);
    });
    
    return {
      success: true,
      data: {
        month: month,
        dailyStats: Object.values(dailyStats),
        totalCount: result.data.length,
        totalDuration: result.data.reduce((sum, record) => sum + record.duration, 0)
      }
    };
  } catch (error) {
    console.error("获取月度统计失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取用户所有记录
async function getAllRecords(openid) {
  if (!openid) return { success: false, code: 'AUTH_REQUIRED', error: '请先登录后再获取记录' };
  try {
    const lockId = stableDocumentId('lock_', openid, 'records');
    const readRevision = async () => {
      try {
        const lock = await optionalDocument(db, 'meditation_locks', lockId);
        return lock ? Number(lock.revision) || 0 : 0;
      } catch (error) {
        // 兼容旧环境尚未有锁集合：读记录不能创建集合或吞掉权限/网络错误。
        if (isMissingCollection(error)) return null;
        throw error;
      }
    };
    const pageSize = 100;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readRevision();
      const records = [];
      while (true) {
        // 排序只保证同一快照的分页顺序；跨页发生增删时须丢弃本轮并完整重读。
        const result = await db.collection("meditation_records")
          .where({ _openid: openid })
          .orderBy('timestamp', 'desc')
          .orderBy('_id', 'asc')
          .skip(records.length)
          .limit(pageSize)
          .get();
        records.push(...result.data);
        if (result.data.length < pageSize) break;
      }
      if (before !== await readRevision()) continue;
      return {
        success: true,
        data: mergeDuplicateRecords(records).records.map(record => ({ ...record, date: getRecordBusinessDate(record) }))
      };
    }
    throw deletionError('RETRY_REQUIRED', '记录正在更新，请稍后刷新');
  } catch (error) {
    console.error("获取所有记录失败:", error);
    return { success: false, ...(error.code || error.errCode ? { code: error.code || error.errCode } : {}),
      error: error.message || error.errMsg || '获取记录失败，请稍后刷新' };
  }
}

// 保存体验记录（支持本地用户标识）
async function saveExperienceRecord(openid, record, localUserId = null) {
  try {
    console.log(`开始保存体验记录: openid=${openid}, record=`, record);
    
    const now = new Date();
    
    // 创建体验记录 - 无需关联打卡记录ID
    const experienceRecord = {
      _openid: openid,
      text: record.text || "",
      timestamp: parseInt(record.uniqueId) || now.getTime(),
      created_at: now,
      updated_at: now
    };
    
    // 插入到体验记录集合
    let result;
    if (record.uniqueId) {
      const id = stableDocumentId('exp_', openid, String(record.uniqueId));
      result = await db.runTransaction(async transaction => {
        const existing = await optionalDocument(transaction, 'experience_records', id);
        if (existing) return { _id: existing._id };
        await transaction.collection('experience_records').doc(id).set({
          data: { ...experienceRecord, uniqueId: String(record.uniqueId) }
        });
        return { _id: id };
      });
    } else {
      result = await db.collection('experience_records').add({ data: experienceRecord });
    }
    
    console.log(`✅ 体验记录保存成功: recordId=${result._id}`);
    
    return {
      success: true,
      data: {
        recordId: result._id,
        timestamp: experienceRecord.timestamp
      }
    };
    
  } catch (error) {
    console.error("保存体验记录失败:", error);
    return { success: false, error: error.message };
  }
}

// 删除体验记录
async function deleteExperienceRecord(openid, recordId) {
  try {
    console.log(`开始删除体验记录: openid=${openid}, recordId=${recordId}`);
    
    // 查找体验记录 - 使用字符串匹配，因为前端传递的是字符串格式的时间戳
    const recordRef = db.collection("experience_records")
      .where({
        _openid: openid,
        timestamp: db.command.eq(parseInt(recordId))
      });
    
    const recordResult = await recordRef.get();
    
    if (recordResult.data.length === 0) {
      console.warn(`未找到体验记录: recordId=${recordId}`);
      return { success: false, error: "未找到要删除的体验记录" };
    }
    
    const record = recordResult.data[0];
    console.log(`找到体验记录:`, record);
    
    // 删除体验记录
    await recordRef.remove();
    
    console.log(`✅ 体验记录删除成功: recordId=${recordId}`);
    
    return {
      success: true,
      data: {
        deletedRecordId: recordId
      }
    };
    
  } catch (error) {
    console.error("删除体验记录失败:", error);
    return { success: false, error: error.message };
  }
}

// 创建用户标识映射
async function createUserMapping(openid, localUserId) {
  try {
    const now = new Date();
    
    // 检查是否已存在映射
    const existingMapping = await db.collection("user_mappings")
      .where({
        _openid: openid,
        local_user_id: localUserId
      })
      .get();
    
    if (existingMapping.data.length === 0) {
      // 创建新映射
      await db.collection("user_mappings").add({
        data: {
          _openid: openid,
          local_user_id: localUserId,
          created_at: now,
          updated_at: now
        }
      });
      console.log(`✅ 创建用户映射: openid=${openid}, localUserId=${localUserId}`);
    }
    
    return true;
  } catch (error) {
    console.error("创建用户映射失败:", error);
    return false;
  }
}

// 获取用户映射信息
async function getUserMapping(openid) {
  try {
    const result = await db.collection("user_mappings")
      .where({
        _openid: openid
      })
      .get();
    
    return {
      success: true,
      data: result.data
    };
  } catch (error) {
    console.error("获取用户映射失败:", error);
    return { success: false, error: error.message };
  }
}

// 迁移本地数据到微信账号
async function migrateLocalData(openid, localUserId, localData = null) {
  try {
    console.log(`本地优先架构：用户登录迁移，openid=${openid}, localUserId=${localUserId}`);
    
    // 简化版本：只记录用户登录，不执行复杂的数据迁移
    // 实际的数据同步由前端按需处理
    
    // 记录用户登录事件
    await createUserMapping(openid, localUserId);
    
    console.log(`用户登录迁移完成`);
    
    return {
      success: true,
      data: {
        openid: openid,
        localUserId: localUserId,
        migrationStatus: "completed",
        migratedCount: 0,
        message: `用户登录迁移完成`
      }
    };
  } catch (error) {
    console.error("用户登录迁移失败:", error);
    return { success: false, error: error.message };
  }
}

// 更新冥想打卡记录的体验内容（支持数组类型）
async function updateMeditationRecord(openid, recordId, experience = "") {
  try {
    console.log(`开始更新记录体验: openid=${openid}, recordId=${recordId}, experience=`, experience);
    
    // 查找记录
    const recordRef = db.collection("meditation_records")
      .where({
        _openid: openid,
        timestamp: parseInt(recordId)
      });
    
    const recordResult = await recordRef.get();
    
    if (recordResult.data.length === 0) {
      console.warn(`未找到记录: recordId=${recordId}`);
      return { success: false, error: "未找到要更新的记录" };
    }
    
    const record = recordResult.data[0];
    console.log(`找到记录:`, record);
    
    // 处理体验记录数组
    let updatedExperience = [];
    
    if (record.experience && Array.isArray(record.experience)) {
      // 已存在的体验记录数组
      updatedExperience = [...record.experience];
    } else if (record.experience && typeof record.experience === 'string') {
      // 兼容旧数据：单个ID的情况
      updatedExperience = [record.experience];
    }
    
    // 添加新的体验记录ID（如果提供了且不在数组中）
    if (experience && typeof experience === 'string' && !updatedExperience.includes(experience)) {
      updatedExperience.push(experience);
    }
    
    // 更新记录的体验内容
    await recordRef.update({
      data: {
        experience: updatedExperience,
        updatedAt: new Date()
      }
    });
    
    console.log(`✅ 更新记录体验成功: recordId=${recordId}, 体验记录数: ${updatedExperience.length}`);
    
    return {
      success: true,
      data: {
        recordId: recordId,
        date: getRecordBusinessDate(record),
        experience: updatedExperience
      }
    };
    
  } catch (error) {
    console.error("更新记录体验失败:", error);
    return { success: false, error: error.message };
  }
}

// 更新用户档案信息
async function updateUserProfile(openid, userInfo, userType = 'new') {
  try {
    console.log(`开始更新用户档案: openid=${openid}, userType=${userType}`);
    
    const usersCollection = db.collection('users');
    const now = new Date();
    
    // 准备更新数据
    const updateData = {
      nickName: userInfo.nickName || '静心者',
      avatarUrl: userInfo.avatarUrl || '/images/avatar.png',
      lastLoginTime: now,
      loginCount: db.command.inc(1),
      lastUpdateTime: now
    };
    
    // 添加新格式的字段
    if (userInfo.isCustomAvatar !== undefined) {
      updateData.isCustomAvatar = userInfo.isCustomAvatar;
      updateData.profileComplete = userInfo.profileComplete !== false;
      updateData.dataSource = userInfo.dataSource || 'custom';
      updateData.migrationStatus = userInfo.migrationStatus || 'new';
    }
    
    // 添加传统字段（如果存在）
    if (userInfo.gender !== undefined) updateData.gender = userInfo.gender;
    if (userInfo.country !== undefined) updateData.country = userInfo.country;
    if (userInfo.province !== undefined) updateData.province = userInfo.province;
    if (userInfo.city !== undefined) updateData.city = userInfo.city;
    
    // 检查用户是否已存在
    const userQuery = await usersCollection.where({ _openid: openid }).get();
    
    if (userQuery.data.length > 0) {
      // 用户已存在，更新信息
      await usersCollection.doc(userQuery.data[0]._id).update({
        data: updateData
      });
      console.log(`✅ 用户档案更新成功: openid=${openid}`);
    } else {
      // 用户不存在，创建新用户
      const createData = {
        ...updateData,
        _openid: openid,
        createTime: now
      };
      
      await usersCollection.add({
        data: createData
      });
      console.log(`✅ 新用户档案创建成功: openid=${openid}`);
    }
    
    return {
      success: true,
      data: {
        openid: openid,
        updateTime: now,
        userType: userType
      }
    };
    
  } catch (error) {
    console.error("更新用户档案失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取用户档案信息
async function getUserProfile(openid) {
  try {
    console.log(`获取用户档案: openid=${openid}`);
    
    const usersCollection = db.collection('users');
    const userQuery = await usersCollection.where({ _openid: openid }).get();
    
    if (userQuery.data.length === 0) {
      console.log(`未找到用户档案: openid=${openid}`);
      return {
        success: true,
        data: null,
        message: '用户档案不存在'
      };
    }
    
    const userProfile = userQuery.data[0];
    console.log(`✅ 获取用户档案成功: openid=${openid}`);
    
    return {
      success: true,
      data: userProfile
    };
    
  } catch (error) {
    console.error("获取用户档案失败:", error);
    return { success: false, error: error.message };
  }
}

// 迁移用户档案（从旧格式到新格式）
async function migrateUserProfile(openid, oldUserInfo) {
  try {
    console.log(`开始迁移用户档案: openid=${openid}`);
    
    const usersCollection = db.collection('users');
    const now = new Date();
    
    // 构建新的用户档案
    const newUserInfo = {
      nickName: oldUserInfo.nickName,
      avatarUrl: oldUserInfo.avatarUrl,
      gender: oldUserInfo.gender,
      country: oldUserInfo.country,
      province: oldUserInfo.province,
      city: oldUserInfo.city,
      isCustomAvatar: false, // 标记为微信获取
      profileComplete: true,
      dataSource: 'wechat',
      migrationStatus: 'migrated',
      originalInfo: oldUserInfo, // 保留原始信息
      createTime: oldUserInfo.createTime ? new Date(oldUserInfo.createTime) : now,
      lastUpdateTime: now,
      lastLoginTime: now,
      loginCount: 1
    };
    
    // 检查用户是否已存在
    const userQuery = await usersCollection.where({ _openid: openid }).get();
    
    if (userQuery.data.length > 0) {
      // 用户已存在，更新信息
      await usersCollection.doc(userQuery.data[0]._id).update({
        data: newUserInfo
      });
      console.log(`✅ 用户档案迁移成功（更新）: openid=${openid}`);
    } else {
      // 用户不存在，创建新用户
      newUserInfo._openid = openid;
      await usersCollection.add({
        data: newUserInfo
      });
      console.log(`✅ 用户档案迁移成功（创建）: openid=${openid}`);
    }
    
    return {
      success: true,
      data: {
        openid: openid,
        migrationTime: now,
        migratedFrom: 'wechat'
      }
    };
    
  } catch (error) {
    console.error("迁移用户档案失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取排名快照（首页入口：直接复用实时排名聚合逻辑）
async function getRankingSnapshot(event, context) {
  try {
    const { rankingType = 'daily' } = event;
    
    const wxContext = cloud.getWXContext();
    const currentUserOpenId = wxContext.OPENID;
    console.log('🔍 获取用户排名快照，当前用户openid:', currentUserOpenId, '排名类型:', rankingType);
    
    // 复用实时排名聚合逻辑（3 次固定查询，无榜单、无前100限制、不取昵称）
    const result = await getRankings(rankingType);
    if (!result.success) {
      throw new Error(result.error);
    }
    
    console.log('✅ 排名快照获取成功:', JSON.stringify(result.data));
    return {
      success: true,
      data: result.data
    };
  } catch (error) {
    console.error('❌ 获取排名快照失败:', error);
    console.error('错误详情:', error.stack);
    return {
      success: false,
      message: "排名数据加载失败",
      error: error.message,
      errorCode: error.errCode || 'UNKNOWN_ERROR'
    };
  }
}

// 更新用户勋章信息
async function updateUserBadges(openid, badges = {}) {
  if (!openid) return { success: false, error: '请先登录' };
  try {
    await withMeditationSnapshot(openid, async (transaction, records, statsRows) => {
      const existing = Object.assign({}, ...statsRows.map(row => row.badges || {}));
      const incoming = Object.fromEntries(Object.entries(badges || {}).filter(([, badge]) => badge && badge.unlockTime));
      // 保留已颁发勋章及原颁发时间；跨设备上报只能补充。
      const merged = { ...incoming, ...existing };
      if (!statsRows.length) {
        await transaction.collection('user_stats').doc(stableDocumentId('stats_', openid, 'statistics')).set({ data: {
          _openid: openid, ...rebuildMeditationStats(records), badges: merged,
          businessDayVersion: 2, createdAt: new Date()
        } });
      } else {
        for (const row of statsRows) {
          await transaction.collection('user_stats').doc(row._id).update({ data: {
            badges: db.command.set(merged), updatedAt: new Date()
          } });
        }
      }
      return { updatedBadges: Object.keys(incoming).length };
    });
    return { success: true, data: { updatedBadges: Object.keys(badges || {}).length } };
  } catch (error) {
    console.error('更新用户勋章信息失败:', error);
    return { success: false, error: error.message };
  }
}

// 获取用户勋章信息
async function getUserBadges(openid) {
  try {
    console.log('获取用户勋章信息:', openid);
    
    const userStats = await db.collection("user_stats")
      .where({ _openid: openid })
      .get();
    
    if (userStats.data.length === 0) {
      console.log('用户统计记录不存在，返回空勋章数据');
      return {
        success: true,
        data: {}
      };
    }
    
    const userData = userStats.data[0];
    const badges = userData.badges || {};
    
    console.log('✅ 获取用户勋章信息成功，勋章数量:', Object.keys(badges).length);
    return {
      success: true,
      data: badges
    };
    
  } catch (error) {
    console.error('获取用户勋章信息失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 重新计算并重新颁发用户勋章（数据纠错工具，2026-07 新增）
// 设计目标：按「正确逻辑」从 meditation_records 真实打卡数据推导出应得勋章，
// 用于纠正旧 bug（如连续打卡被虚高、single_duration 按末次时长误判）导致的错误颁发。
//
// 语义（与 §3.4「连续打卡无中断 + 终身生效」及 badgeManager.js 判定保持一致）：
//   - continuous_checkin：以「历史最长连续无中断天数」(longestRun) 为判定源，>= days 即颁发。
//     使用历史最长连续而非当前 running streak，等价于「曾经达成过」，符合终身生效语义；
//     同时也纠正了连续天数被虚高的旧数据。
//   - total_duration（等级勋章）：以「累计时长」(sum duration) 为判定源，>= minutes 颁发。
//   - single_duration：强制保留现有已颁发（终身生效、不撤销）；若记录中存在达标单次则补发。
//
// mode:
//   'report' 只读，输出「现有勋章 vs 应得勋章」差异报告，不写库（推荐先跑）。
//   'apply'  按推导结果覆盖式写回 user_stats.badges（仅针对有变化的用户）。
//
// 入参：
//   event.mode         'report' | 'apply'
//   event.openid       指定单个用户（优先）
//   event.nickName     按昵称解析 openid（如 '亘心'）
//   两者皆缺省 → 遍历全部用户
async function recomputeUserBadges(event) {
  const mode = event.mode || 'report';
  const targetOpenid = event.openid || null;
  const targetNickName = event.nickName || null;

  // 勋章定义镜像（与 miniprogram/utils/badgeManager.js 保持一致；仅保留判定所需字段）
  const BADGES = [
    { id: 'continuous-7',   name: '连续打卡7天',    type: 'continuous_checkin', days: 7 },
    { id: 'continuous-14',  name: '连续打卡14天',   type: 'continuous_checkin', days: 14 },
    { id: 'continuous-30',  name: '连续打卡30天',   type: 'continuous_checkin', days: 30 },
    { id: 'continuous-60',  name: '连续打卡60天',   type: 'continuous_checkin', days: 60 },
    { id: 'continuous-100', name: '连续打卡100天',  type: 'continuous_checkin', days: 100 },
    { id: 'continuous-365', name: '连续打卡365天',  type: 'continuous_checkin', days: 365 },
    { id: 'meditation-20',  name: '单次觉察20分钟', type: 'single_duration', minutes: 20 },
    { id: 'level-1',  name: 'LV1.新手',     type: 'total_duration', minutes: 10 },
    { id: 'level-2',  name: 'LV2.入门者',   type: 'total_duration', minutes: 100 },
    { id: 'level-3',  name: 'LV3.修行中',   type: 'total_duration', minutes: 300 },
    { id: 'level-4',  name: 'LV4.初学者',   type: 'total_duration', minutes: 600 },
    { id: 'level-5',  name: 'LV5.探索者',   type: 'total_duration', minutes: 1000 },
    { id: 'level-6',  name: 'LV6.坚持者',   type: 'total_duration', minutes: 2000 },
    { id: 'level-7',  name: 'LV7.精进者',   type: 'total_duration', minutes: 4000 },
    { id: 'level-8',  name: 'LV8.修行达人', type: 'total_duration', minutes: 8000 },
    { id: 'level-9',  name: 'LV9.静心高手', type: 'total_duration', minutes: 15000 },
    { id: 'level-10', name: '禅定大师',     type: 'total_duration', minutes: 30000 },
  ];

  // 解析目标 openid
  let targetOpenids = null;
  if (targetOpenid) {
    targetOpenids = [targetOpenid];
  } else if (targetNickName) {
    const uRes = await db.collection('users').where({ nickName: targetNickName }).limit(100).get();
    targetOpenids = uRes.data.map(u => u._openid);
    console.log(`🔍 按昵称「${targetNickName}」解析到 ${targetOpenids.length} 个 openid:`, targetOpenids);
  }

  // 拉取冥想记录（分页，避免单次超限）
  const recordsByUser = {};
  let skip = 0;
  const BATCH = 1000;
  while (true) {
    let q = db.collection('meditation_records');
    if (targetOpenids && targetOpenids.length) {
      q = q.where({ _openid: db.command.in(targetOpenids) });
    }
    const res = await q.skip(skip).limit(BATCH).get();
    res.data.forEach(r => {
      const oid = r._openid;
      if (!recordsByUser[oid]) recordsByUser[oid] = [];
      recordsByUser[oid].push({ date: getRecordBusinessDate(r), duration: Number(r.duration) || 0 });
    });
    if (res.data.length < BATCH) break;
    skip += BATCH;
  }
  const openids = Object.keys(recordsByUser);
  if (openids.length === 0) {
    console.log('⚠️ 未读取到任何冥想记录，结束。');
    return { success: true, data: { mode, changedUsers: 0, totalAdded: 0, totalRemoved: 0, details: [] } };
  }
  console.log(`📊 共读取 ${openids.length} 个用户的冥想记录`);

  // 加载现有勋章
  const statsRes = await db.collection('user_stats')
    .where({ _openid: db.command.in(openids) })
    .get();
  const existingBadgesByUser = {};
  const existingStatsByUser = {};
  statsRes.data.forEach(s => {
    existingBadgesByUser[s._openid] = s.badges || {};
    existingStatsByUser[s._openid] = s;
  });

  const nowISO = new Date().toISOString();
  const dayNumber = (dateStr) => {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };

  const changed = [];
  let totalAdded = 0, totalRemoved = 0, applyCount = 0;

  for (const oid of openids) {
    const recs = recordsByUser[oid];
    const distinctDays = [...new Set(recs.map(r => r.date))].map(dayNumber).sort((a, b) => a - b);
    // 历史最长连续无中断天数
    let longest = 0, cur = 0, prev = null;
    for (const dd of distinctDays) {
      if (prev === null) cur = 1;
      else if (dd === prev + 1) cur += 1;
      else cur = 1;
      if (cur > longest) longest = cur;
      prev = dd;
    }
    const totalDuration = recs.reduce((s, r) => s + r.duration, 0);
    const maxSingleDuration = recs.reduce((m, r) => r.duration > m ? r.duration : m, 0);

    // 当前连续天数（以最后一个打卡日结尾的连续段；若最后打卡日早于昨天则已断签，归 0）
    // 用于 apply 时校准 user_stats 中被旧 bug 虚高的 currentStreak / longestStreak / longestCheckInDays，
    // 避免前端 checkBadgeUnlock 读到脏「连续天数」后把已纠正的勋章重新发回（脏数据回灌）。
    let trailingRun = 0;
    {
      let run = 0, p = null;
      for (const dd of distinctDays) {
        run = (p !== null && dd === p + 1) ? run + 1 : 1;
        p = dd;
      }
      const lastDay = distinctDays.length ? distinctDays[distinctDays.length - 1] : null;
      const todayNum = Math.floor((Date.now() + 6 * 3600 * 1000) / 86400000); // 东八区业务日期
      trailingRun = (lastDay !== null && lastDay >= todayNum - 1) ? run : 0;
    }

    const existing = existingBadgesByUser[oid] || {};
    const existingIds = Object.keys(existing).filter(id => existing[id] && existing[id].unlockTime);

    // 计算应得勋章
    const computed = {};
    for (const b of BADGES) {
      let earned = false;
      if (b.type === 'continuous_checkin') earned = longest >= b.days;
      else if (b.type === 'total_duration') earned = totalDuration >= b.minutes;
      // single_duration 不在此处直接判定（见下方）
      if (earned) computed[b.id] = { name: b.name, unlockTime: nowISO };
    }
    // single_duration 类：保留现有（不撤销）+ 记录达标则补发
    for (const b of BADGES) {
      if (b.type !== 'single_duration') continue;
      const fromRecords = maxSingleDuration >= b.minutes;
      if (fromRecords || existing[b.id]) {
        computed[b.id] = existing[b.id] || { name: b.name, unlockTime: nowISO };
      }
    }

    const newIds = Object.keys(computed);
    const added = newIds.filter(id => !existingIds.includes(id));
    const removed = existingIds.filter(id => !newIds.includes(id));

    if (added.length || removed.length) {
      changed.push({
        openid: oid,
        longestRun: longest,
        totalDuration,
        maxSingleDuration,
        existing: existingIds,
        computed: newIds,
        added,
        removed
      });
      totalAdded += added.length;
      totalRemoved += removed.length;

      if (mode === 'apply') {
        const ref = db.collection('user_stats').where({ _openid: oid });
        // 同步校准连续天数字段（从真实记录推导），根治 currentStreak/longestStreak 虚高的脏数据
        const upd = await ref.update({ data: {
          badges: computed,
          longestCheckInDays: longest,
          longestStreak: longest,
          currentStreak: trailingRun,
          updatedAt: new Date()
        } });
        if (!upd.stats || upd.stats.updated === 0) {
          // 无 user_stats 记录则创建（带 badges，其余字段给默认值）
          await db.collection('user_stats').add({
            data: {
              _openid: oid, badges: computed,
              totalDays: 0, totalCount: 0, totalDuration: 0,
              dailyTotalDuration: 0, monthlyTotalDuration: 0,
              longestCheckInDays: longest, currentStreak: trailingRun, longestStreak: longest,
              lastCheckinDate: '', lastCheckinDuration: 0, lastCheckin: '',
              monthlyStats: {}, createdAt: new Date(), updatedAt: new Date()
            }
          });
        }
        applyCount++;
      }
    } else if (mode === 'apply') {
      // 勋章无变化，但连续天数字段可能仍是脏值（虚高）——单独校准，
      // 否则前端以 longestStreak/longestCheckInDays 为判定源时仍会误发勋章。
      const s = existingStatsByUser[oid];
      if (s && ((s.longestCheckInDays || 0) !== longest ||
                (s.longestStreak || 0) !== longest ||
                (s.currentStreak || 0) !== trailingRun)) {
        await db.collection('user_stats').where({ _openid: oid }).update({ data: {
          longestCheckInDays: longest,
          longestStreak: longest,
          currentStreak: trailingRun,
          updatedAt: new Date()
        } });
        console.log(`🧹 校准连续天数字段: ${oid} → longest=${longest}, current=${trailingRun}`);
      }
    }
  }

  const result = {
    mode,
    target: targetOpenids ? (targetOpenid || targetNickName) : 'ALL',
    totalUsers: openids.length,
    changedUsers: changed.length,
    totalAdded,
    totalRemoved,
    applied: mode === 'apply' ? applyCount : 0,
    details: changed
  };
  console.log('✅ 勋章重算完成:', { mode, changedUsers: changed.length, totalAdded, totalRemoved });
  return { success: true, data: result };
}

// 处理微信登录
async function handleLogin(wxContext, code) {
  try {
    console.log('处理微信登录请求，code:', code);
    
    // 获取微信openid
    const openid = wxContext.OPENID;
    console.log('当前用户openid:', openid);
    
    if (!openid) {
      throw new Error('无法获取用户openid');
    }
    
    return {
      success: true,
      openid: openid,
      message: '登录成功'
    };
    
  } catch (error) {
    console.error('处理微信登录失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
