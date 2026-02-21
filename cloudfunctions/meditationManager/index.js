const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  switch (event.type) {
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
      // 创建新用户统计 - 字段与数据库完全一致
      await db.collection("user_stats").add({
        data: {
          _openid: openid,
          totalDays: 1,
          totalCount: 1,
          totalDuration: duration,
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
      
      const updateData = {
        totalCount: db.command.inc(1),
        totalDuration: db.command.inc(duration),
        updatedAt: today
      };
      
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
    
    return {
      success: true,
      data: result.data[0]
    };
  } catch (error) {
    console.error("获取用户统计失败:", error);
    return { success: false, error: error.message };
  }
}

// 获取排行榜
async function getRankings(period) {
  try {
    let query = db.collection("rankings");
    
    if (period === "daily") {
      const today = new Date().toISOString().split('T')[0];
      query = query.where({
        type: "daily",
        period: today
      });
    } else if (period === "monthly") {
      const monthStr = new Date().toISOString().substring(0, 7);
      query = query.where({
        type: "monthly",
        period: monthStr
      });
    } else {
      query = query.where({
        type: "total",
        period: "all"
      });
    }
    
    const result = await query
      .orderBy('duration', 'desc')
      .limit(100)
      .get();
    
    // 简化版用户信息
    const rankingsWithUser = result.data.map((ranking, index) => ({
      ...ranking,
      rank: index + 1,
      userInfo: {
        nickname: "用户" + ranking._openid.substring(0, 6)
      }
    }));
    
    return {
      success: true,
      data: rankingsWithUser
    };
  } catch (error) {
    console.error("获取排行榜失败:", error);
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
async function migrateLocalData(openid, localUserId) {
  try {
    console.log(`开始迁移本地数据: openid=${openid}, localUserId=${localUserId}`);
    
    // 1. 创建用户映射
    await createUserMapping(openid, localUserId);
    
    // 2. 获取本地记录（这里需要前端配合，因为本地数据在前端）
    // 实际迁移逻辑需要前端调用，这里只返回迁移指令
    
    return {
      success: true,
      data: {
        openid: openid,
        localUserId: localUserId,
        migrationStatus: "ready",
        message: "请在前端调用数据迁移功能"
      }
    };
  } catch (error) {
    console.error("迁移本地数据失败:", error);
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