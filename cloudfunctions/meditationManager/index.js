const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// 云函数入口函数
exports.main = async (event, context) => {
  // 处理定时触发器
  if (event.Type === 'timer') {
    console.log('定时触发器执行，生成排名快照');
    return await generateRankingSnapshot({ type: 'daily' });
  }
  
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
    case "getRankings":
      return await getRankings(event.period);
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
    case "generateRankingSnapshot":
      return await generateRankingSnapshot(event);
    case "initRankingSnapshot":
      return await initRankingSnapshot();
    default:
      return { success: false, error: "未知的操作类型" };
  }
};

// 记录冥想打卡（支持本地用户标识）
async function recordMeditation(openid, data, localUserId = null) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    
    // 创建打卡记录 - 支持本地用户标识映射
    const record = {
      _openid: openid,
      date: dateStr,
      timestamp: now.getTime(),
      duration: data.duration || 0,
      rating: data.rating || 0,
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
    
    // 更新排行榜
    await updateRankings(openid, dateStr, data.duration);
    
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
      
      // 更新当月总分钟数
      const currentMonthlyTotal = stats.monthlyTotalDuration || 0;
      updateData.monthlyTotalDuration = db.command.inc(duration);
      console.log(`更新当月总分钟数: ${currentMonthlyTotal} + ${duration} = ${currentMonthlyTotal + duration}`);
      
      // 更新最长连续天数
      const currentLongestCheckInDays = stats.longestCheckInDays || 1;
      const newCurrentStreak = stats.currentStreak + 1;
      if (newCurrentStreak > currentLongestCheckInDays) {
        updateData.longestCheckInDays = newCurrentStreak;
        console.log(`更新最长连续天数: ${currentLongestCheckInDays} -> ${newCurrentStreak}`);
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

// 更新排行榜（字段与数据库完全一致）
async function updateRankings(openid, dateStr, duration) {
  try {
    const monthStr = dateStr.substring(0, 7);
    
    // 更新日榜
    await updateDailyRanking(openid, dateStr, duration);
    
    // 更新月榜
    await updateMonthlyRanking(openid, monthStr, duration);
    
    // 更新总榜
    await updateTotalRanking(openid, duration);
    
  } catch (error) {
    console.error("更新排行榜失败:", error);
  }
}

// 更新日榜
async function updateDailyRanking(openid, dateStr, duration) {
  const rankingRef = db.collection("rankings").where({
    type: "daily",
    period: dateStr,
    _openid: openid
  });
  
  const ranking = await rankingRef.get();
  
  if (ranking.data.length === 0) {
    await db.collection("rankings").add({
      data: {
        _openid: openid,
        type: "daily",
        period: dateStr,
        duration: duration,
        count: 1,
        updatedAt: new Date()
      }
    });
  } else {
    await rankingRef.update({
      data: {
        duration: db.command.inc(duration),
        count: db.command.inc(1),
        updatedAt: new Date()
      }
    });
  }
}

// 更新月榜
async function updateMonthlyRanking(openid, monthStr, duration) {
  const rankingRef = db.collection("rankings").where({
    type: "monthly",
    period: monthStr,
    _openid: openid
  });
  
  const ranking = await rankingRef.get();
  
  if (ranking.data.length === 0) {
    await db.collection("rankings").add({
      data: {
        _openid: openid,
        type: "monthly",
        period: monthStr,
        duration: duration,
        count: 1,
        updatedAt: new Date()
      }
    });
  } else {
    await rankingRef.update({
      data: {
        duration: db.command.inc(duration),
        count: db.command.inc(1),
        updatedAt: new Date()
      }
    });
  }
}

// 更新总榜
async function updateTotalRanking(openid, duration) {
  const rankingRef = db.collection("rankings").where({
    type: "total",
    period: "all",
    _openid: openid
  });
  
  const ranking = await rankingRef.get();
  
  if (ranking.data.length === 0) {
    await db.collection("rankings").add({
      data: {
        _openid: openid,
        type: "total",
        period: "all",
        duration: duration,
        count: 1,
        updatedAt: new Date()
      }
    });
  } else {
    await rankingRef.update({
      data: {
        duration: db.command.inc(duration),
        count: db.command.inc(1),
        updatedAt: new Date()
      }
    });
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

// 获取实时排行榜（基于user_stats，仅显示前100名）
async function getRankings(period) {
  try {
    const wxContext = cloud.getWXContext();
    const currentUserOpenId = wxContext.OPENID;
    
    console.log(`获取实时排名，用户: ${currentUserOpenId}, 周期: ${period}`);
    
    // 直接查询user_stats表，按当日总时长降序排列，获取前100名
    const userStats = await db.collection("user_stats")
      .orderBy("dailyTotalDuration", "desc")
      .limit(100) // 仅显示前100名用户
      .get();
    
    console.log(`查询到 ${userStats.data.length} 名用户统计信息`);
    
    // 构建排名数据，使用更完善的昵称获取逻辑
    const rankings = await Promise.all(userStats.data.map(async (user, index) => {
      let userNickname = "用户" + user._openid.substring(0, 6);
      
      // 1. 首先尝试从user_stats表中获取昵称
      if (user.nickname && user.nickname.trim() !== "") {
        userNickname = user.nickname;
      } else {
        // 2. 尝试从user_profiles表中获取昵称
        try {
          const userProfile = await db.collection("user_profiles")
            .where({ _openid: user._openid })
            .get();
          
          if (userProfile.data.length > 0 && userProfile.data[0].nickname && userProfile.data[0].nickname.trim() !== "") {
            userNickname = userProfile.data[0].nickname;
          }
        } catch (error) {
          console.log(`获取用户 ${user._openid} 档案失败，使用默认昵称`);
        }
      }
      
      // 3. 如果是当前用户，显示"当前用户"标识
      if (user._openid === currentUserOpenId) {
        userNickname = "当前用户";
      }
      
      return {
        openid: user._openid,
        nickname: userNickname,
        duration: user.dailyTotalDuration || 0, // 使用当日总时长
        rank: index + 1
      };
    }));
    
    // 检查当前用户是否在前100名内
    const currentUserRank = rankings.find(r => r.openid === currentUserOpenId);
    const currentUserInTop100 = !!currentUserRank;
    
    // 如果用户不在前100名，获取其真实排名
    let userTotalRank = 0;
    if (!currentUserInTop100) {
      const userStat = await db.collection("user_stats")
        .where({ _openid: currentUserOpenId })
        .get();
      
      if (userStat.data.length > 0) {
        // 计算用户在所有用户中的排名（按当日总时长）
        const allUsers = await db.collection("user_stats")
          .orderBy("dailyTotalDuration", "desc")
          .get();
        
        userTotalRank = allUsers.data.findIndex(user => 
          user._openid === currentUserOpenId
        ) + 1;
      }
    }
    
    return {
      success: true,
      data: {
        type: period,
        period: new Date().toISOString().split('T')[0],
        snapshotTime: new Date(),
        rankings: rankings,
        totalUsers: userStats.data.length,
        currentUserOpenId: currentUserOpenId,
        currentUserRank: currentUserRank ? currentUserRank.rank : userTotalRank,
        currentUserInTop100: currentUserInTop100
      }
    };
  } catch (error) {
    console.error("获取实时排行榜失败:", error);
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

// 获取排名快照
async function getRankingSnapshot(event, context) {
  try {
    const { rankingType = 'daily' } = event;
    
    // 获取当前用户的微信真实openid
    const wxContext = cloud.getWXContext();
    const currentUserOpenId = wxContext.OPENID;
    
    console.log('获取实时排名快照，当前用户openid:', currentUserOpenId, '排名类型:', rankingType);
    
    // 直接使用实时排名逻辑，不再使用弃用的rankings集合
    const realTimeRankings = await getRankings(rankingType);
    
    if (!realTimeRankings.success) {
      throw new Error(realTimeRankings.error);
    }
    
    const rankingData = realTimeRankings.data;
    
    console.log('当前用户openid:', currentUserOpenId);
    console.log('排名数据中的openid列表:', rankingData.rankings.map(r => r.openid));
    
    // 检查当前用户是否在前100名内
    const currentUserInTop100 = rankingData.currentUserInTop100;
    console.log('当前用户是否在前100名内:', currentUserInTop100);
    console.log('当前用户排名:', rankingData.currentUserRank);
    
    // 如果用户不在前100名，显示"未上排行榜"
    if (!currentUserInTop100 && rankingData.currentUserRank > 100) {
      console.log('当前用户排名超过100名，显示"未上排行榜"');
      rankingData.currentUserRank = "未上排行榜";
    }
    
    return {
      success: true,
      data: rankingData
    };
  } catch (error) {
    console.error('获取排名快照失败:', error);
    console.error('错误详情:', error.stack);
    return {
      success: false,
      message: "排名数据加载失败",
      error: error.message,
      errorCode: error.errCode || 'UNKNOWN_ERROR'
    };
  }
}

// 生成排名快照
async function generateRankingSnapshot(event) {
  try {
    const { type = 'daily' } = event;
    const today = new Date().toISOString().split('T')[0];
    
    // 查询当前所有登录用户数据（按当日总时长降序）
    const users = await db.collection("user_stats")
      .orderBy("dailyTotalDuration", "desc")
      .limit(1000) // 限制返回数量，避免性能问题
      .get();
    
    // 生成排名快照
    const snapshot = {
      type: type,
      period: today,
      snapshotTime: new Date(),
      rankings: users.data.map((user, index) => ({
        openid: user._openid,
        nickname: user.nickname || "匿名用户",
        duration: user.dailyTotalDuration || 0,
        rank: index + 1
      })),
      totalUsers: users.data.length
    };
    
    // 存储快照，覆盖旧数据
    await db.collection("ranking_snapshots")
      .where({ type: type, period: today })
      .remove();
      
    await db.collection("ranking_snapshots").add({
      data: snapshot
    });
    
    console.log(`✅ 排名快照生成成功: type=${type}, period=${today}, users=${users.data.length}`);
    
    return {
      success: true,
      data: snapshot
    };
  } catch (error) {
    console.error('生成排名快照失败:', error);
    return {
      success: false,
      message: "排名快照生成失败"
    };
  }
}

// 初始化排名快照集合（创建集合和索引）
async function initRankingSnapshot() {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    console.log('开始初始化排名快照集合...');
    
    // 创建一个空的排名快照作为测试数据
    const testSnapshot = {
      type: 'daily',
      period: today,
      snapshotTime: new Date(),
      rankings: [
        {
          openid: 'test_user_1',
          nickname: '测试用户1',
          duration: 3600,
          rank: 1
        },
        {
          openid: 'test_user_2', 
          nickname: '测试用户2',
          duration: 1800,
          rank: 2
        }
      ],
      totalUsers: 2
    };
    
    // 尝试插入测试数据（如果集合不存在会自动创建）
    const result = await db.collection("ranking_snapshots").add({
      data: testSnapshot
    });
    
    console.log('排名快照集合初始化成功，插入测试数据ID:', result._id);
    
    return {
      success: true,
      message: "排名快照集合初始化成功",
      data: {
        snapshotId: result._id,
        testData: testSnapshot
      }
    };
    
  } catch (error) {
    console.error('初始化排名快照集合失败:', error);
    return {
      success: false,
      message: "初始化排名快照集合失败",
      error: error.message
    };
  }
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