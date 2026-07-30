const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// 业务日期工具：统一按东八区（中国时区 UTC+8）划分"天/月"，作为唯一日期基准。
// 避免 new Date().toISOString() 返回 UTC 日期导致中国时区 00:00-08:00 归属前一天/月（全局根因③）。
// 采用"时间 +8h 后用 UTC 分量取值"技巧，使结果不受运行环境本地时区影响，
// 保证云端与前端（用户手机）使用完全一致的日期基准。
function getBusinessDate(date) {
  const d = date ? new Date(date) : new Date();
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBusinessMonth(date) {
  return getBusinessDate(date).substring(0, 7);
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
    case "getUserRecords":
      return await getUserRecords(openid, event.date);
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

// 记录冥想打卡（支持本地用户标识）
async function recordMeditation(openid, data, localUserId = null) {
  try {
    const now = new Date();
    const dateStr = getBusinessDate(now);
    
    // 创建打卡记录 - 支持本地用户标识映射
    const record = {
      _openid: openid,
      date: dateStr,
      timestamp: now.getTime(),
      duration: data.duration || 0,
      emotion: Array.isArray(data.emotion) ? data.emotion : [], // 情绪标签数组
      experience: Array.isArray(data.experience) ? data.experience : (data.experience ? [data.experience] : []), // 体验记录ID数组，可能为空数组
      createdAt: now,
      updatedAt: now
    };
    
    // 如果提供了本地用户ID，创建用户映射
    if (localUserId) {
      await createUserMapping(openid, localUserId);
    }
    
    // 插入记录
    const result = await db.collection("meditation_records").add({
      data: record
    });
    
    // 更新用户统计
    await updateUserStats(openid, dateStr, data.duration);
    
    return {
      success: true,
      data: {
        recordId: result._id,
        date: dateStr,
        timestamp: now.getTime()
      }
    };
    
  } catch (error) {
    console.error("记录冥想打卡失败:", error);
    return { success: false, error: error.message };
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
      const isNewDay = !stats.lastCheckin || stats.lastCheckin !== dateStr;
      
      // 判断是否是同一天（当日总时长需要累加）
      // 使用lastCheckinDate字段来判断同一天，因为lastCheckin可能被其他逻辑更新
      const isSameDay = stats.lastCheckinDate === dateStr;
      
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
      } else {
        // 新的一天，重置当日总时长
        updateData.dailyTotalDuration = duration;
        updateData.lastCheckinDate = dateStr;
        updateData.lastCheckinDuration = duration;
        console.log(`新的一天打卡，重置时长: ${duration}`);
      }
      
      // 更新当月总分钟数：跨月时清零重置为当月值，避免 monthlyTotalDuration 沦为累计值（修复 4.2）
      const currentMonthlyTotal = stats.monthlyTotalDuration || 0;
      const lastMonthStr = (stats.lastCheckinDate || '').substring(0, 7);
      const isNewMonth = lastMonthStr !== monthStr;
      if (isNewMonth) {
        // 跨月首次打卡：重置为当月当前时长（与 dailyTotalDuration 同口径）
        updateData.monthlyTotalDuration = duration;
        console.log(`跨月重置当月总分钟数: ${currentMonthlyTotal} -> ${duration} (${lastMonthStr} -> ${monthStr})`);
      } else {
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
        updateData.lastCheckin = dateStr;
        
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
    const result = await db.collection("meditation_records")
      .where({
        _openid: openid,
        date: date
      })
      .orderBy('timestamp', 'desc')
      .get();
    
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
  try {
    const result = await db.collection("user_stats")
      .where({
        _openid: openid
      })
      .get();
    
    if (result.data.length === 0) {
      return {
        success: true,
        data: {
          totalDays: 0,
          totalCount: 0,
          totalDuration: 0,
          currentStreak: 0,
          longestStreak: 0,
          monthlyStats: {}
        }
      };
    }
    
    const userStats = result.data[0];
    
    // 确保返回的数据包含所有必要的字段
    return {
      success: true,
      data: {
        totalDays: userStats.totalDays || 0,
        totalCount: userStats.totalCount || 0,
        totalDuration: userStats.totalDuration || 0,
        dailyTotalDuration: userStats.dailyTotalDuration || 0,
        monthlyTotalDuration: userStats.monthlyTotalDuration || 0,
        longestCheckInDays: userStats.longestCheckInDays || 0,
        currentStreak: userStats.currentStreak || 0,
        longestStreak: userStats.longestStreak || 0,
        lastCheckinDate: userStats.lastCheckinDate || '',
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
    
    console.log(`🔍 获取用户排名，用户: ${currentUserOpenId}`);
    
    // 1. 查询当前用户的当日总时长（仅取必要字段）
    const userStatRes = await db.collection("user_stats")
      .where({ _openid: currentUserOpenId })
      .field({ dailyTotalDuration: true })
      .get();
    
    // 当前用户无任何打卡统计，视为暂无排名
    if (userStatRes.data.length === 0) {
      const total = await db.collection("user_stats").count();
      console.log(`⚠️ 当前用户暂无打卡记录，总打卡用户数: ${total.total}`);
      return {
        success: true,
        data: {
          type: period,
          period: getBusinessDate(),
          currentUserOpenId: currentUserOpenId,
          currentUserRank: 0,
          hasRanking: false,
          totalUsers: total.total
        }
      };
    }
    
    const userDuration = userStatRes.data[0].dailyTotalDuration || 0;
    
    // 2. 名次 = 当日总时长严格大于当前用户的人数 + 1
    //    count 聚合不受 get() 单次 1000 条限制，任意用户量下名次准确；
    //    并列时长者获得相同名次（均为"大于者数 + 1"），语义合理。
    const higherCount = await db.collection("user_stats")
      .where({ dailyTotalDuration: db.command.gt(userDuration) })
      .count();
    
    // 3. 真实总打卡用户数（count 返回完整总数，不受前 100 限制）
    const totalCount = await db.collection("user_stats").count();
    
    console.log(`✅ 用户排名计算完成：名次 ${higherCount.total + 1}，总用户数 ${totalCount.total}`);
    
    return {
      success: true,
      data: {
        type: period,
        period: getBusinessDate(),
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
    const result = await db.collection("meditation_records")
      .where({
        _openid: openid,
        date: db.command.regex({
          regexp: `^${month}`,
          options: 'i'
        })
      })
      .orderBy('date', 'desc')
      .get();
    
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
  try {
    const result = await db.collection("meditation_records")
      .where({
        _openid: openid
      })
      .orderBy('timestamp', 'desc')
      .get();
    
    return {
      success: true,
      data: result.data
    };
  } catch (error) {
    console.error("获取所有记录失败:", error);
    return { success: false, error: error.message };
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
    const result = await db.collection("experience_records").add({
      data: experienceRecord
    });
    
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
        date: record.date,
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
async function updateUserBadges(openid, badges) {
  try {
    console.log('更新用户勋章信息:', { openid, badges });
    
    const userStatsRef = db.collection("user_stats").where({ _openid: openid });
    const userStats = await userStatsRef.get();
    
    if (userStats.data.length === 0) {
      // 用户不存在，创建新的用户统计记录
      const now = new Date();
      await db.collection("user_stats").add({
        data: {
          _openid: openid,
          badges: badges,
          totalDays: 0,
          totalCount: 0,
          totalDuration: 0,
          dailyTotalDuration: 0,
          monthlyTotalDuration: 0,
          longestCheckInDays: 0,
          currentStreak: 0,
          longestStreak: 0,
          lastCheckinDate: '',
          lastCheckinDuration: 0,
          lastCheckin: '',
          monthlyStats: {},
          createdAt: now,
          updatedAt: now
        }
      });
    } else {
      // 更新现有用户的勋章信息
      // ⚠️ 必须做合并（只增不减），不能整字段覆盖：
      // 前端 syncBadgesToCloud 只发送「当前本地已解锁」子集，若此处用 badges 整体覆盖，
      // 会丢失其他设备/历史已颁发的勋章（如 single_duration 类无法靠统计重算），违反「颁发后终身生效」。
      // 合并策略：以云端已有 badges 为基准，叠加本次上报的已解锁项（已解锁状态不会被撤销）。
      const existingBadges = userStats.data[0].badges || {};
      const mergedBadges = { ...existingBadges, ...badges };
      await userStatsRef.update({
        data: {
          badges: mergedBadges,
          updatedAt: new Date()
        }
      });
      console.log('✅ 勋章信息已合并更新（保留历史已解锁勋章）:', {
        existing: Object.keys(existingBadges).length,
        incoming: Object.keys(badges).length,
        merged: Object.keys(mergedBadges).length
      });
    }
    
    console.log('✅ 用户勋章信息更新成功');
    return {
      success: true,
      data: { updatedBadges: Object.keys(badges).length }
    };
    
  } catch (error) {
    console.error('更新用户勋章信息失败:', error);
    return {
      success: false,
      error: error.message
    };
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
      recordsByUser[oid].push({ date: r.date, duration: Number(r.duration) || 0 });
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
      const todayNum = Math.floor((Date.now() + 8 * 3600 * 1000) / 86400000); // 东八区业务日期
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