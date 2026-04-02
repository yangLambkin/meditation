const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 团队数据管理器云函数
 * 处理团队的创建、查询、更新、删除等操作
 */
exports.main = async (event, context) => {
  const { type, data, openid } = event;
  
  try {
    switch (type) {
      case 'createTeam':
        return await createTeam(data, openid);
      case 'getUserTeams':
        return await getUserTeams(openid);
      case 'deleteTeam':
        return await deleteTeam(data.teamId, openid);
      case 'joinTeam':
        return await joinTeamWithInvite(data.teamId, data.openid, data.inviterId, data.inviteId);
      case 'leaveTeam':
        return await leaveTeam(data.teamId, openid);
      case 'updateTeam':
        return await updateTeam(data.teamId, data.teamData, openid);
      case 'getTeamInfo':
        return await getTeamInfo(data.teamId);
      case 'getTeamMembersCheckinData':
        return await getTeamMembersCheckinData(data.memberOpenids);
      case 'generateInvite':
        return await generateInvite(data, openid);
      case 'recordInviteAction':
        return await recordInviteAction(data);
      case 'recordInviteRelation':
        return await recordInviteRelation(data);
      case 'getMemberWeekCheckin':
        return await getMemberWeekCheckin(data);
      case 'getAllTeams':
        return await getAllTeams(data);
      default:
        return { success: false, error: '未知的操作类型' };
    }
  } catch (error) {
    console.error('云函数执行错误:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 创建团队
 */
async function createTeam(teamData, openid) {
  // 验证用户权限
  if (!openid) {
    throw new Error('用户未登录');
  }
  
  // 检查用户是否已经创建过团队
  const userTeams = await db.collection('teams')
    .where({
      creator: openid,
      isActive: true
    })
    .get();
  
  if (userTeams.data.length >= 1) {
    throw new Error('每个用户最多只能创建1个团队');
  }
  
  // 检查团队名称是否重复
  const existingTeam = await db.collection('teams')
    .where({
      name: teamData.name,
      isActive: true
    })
    .get();
  
  if (existingTeam.data.length > 0) {
    throw new Error('团队名称已存在');
  }
  
  // 处理团队头像：如果是临时路径，使用默认头像
  let teamIcon = teamData.icon;
  if (teamIcon && teamIcon.startsWith('http://tmp/')) {
    console.log('检测到临时头像路径，使用默认头像:', teamIcon);
    teamIcon = '/images/icons/team.png';
  }

  // 创建团队数据
  const team = {
    name: teamData.name,
    description: teamData.description || '',
    icon: teamIcon,
    creator: openid,
    creatorName: teamData.creatorName || '匿名用户',
    members: [openid], // 创建者自动加入
    memberCount: 1,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
    isActive: true
  };
  
  // 插入到数据库
  const result = await db.collection('teams').add({
    data: team
  });
  
  console.log('团队创建成功:', result._id);
  
  return {
    success: true,
    data: {
      teamId: result._id
    }
  };
}

/**
 * 获取用户相关的团队
 */
async function getUserTeams(openid) {
  if (!openid) {
    return { success: true, data: [] };
  }
  
  // 查询用户创建或加入的团队
  const teams = await db.collection('teams')
    .where({
      isActive: true,
      $or: [
        { creator: openid },
        { members: openid }
      ]
    })
    .orderBy('createdAt', 'desc')
    .get();
  
  console.log('获取用户团队成功:', teams.data.length);
  
  // 调试：检查返回的团队数据是否包含createdAt字段
  if (teams.data.length > 0) {
    console.log('团队数据字段检查:', {
      hasCreatedAt: teams.data[0].createdAt !== undefined,
      createdAt: teams.data[0].createdAt,
      fields: Object.keys(teams.data[0])
    });
  }
  
  return {
    success: true,
    data: teams.data
  };
}

/**
 * 删除团队（硬删除 - 直接从数据库删除记录）
 */
async function deleteTeam(teamId, openid) {
  console.log('开始硬删除团队:', { teamId, openid });
  
  // 如果openid为空，尝试从云函数上下文获取
  if (!openid) {
    const wxContext = cloud.getWXContext();
    openid = wxContext.OPENID;
    console.log('从上下文获取openid:', openid);
  }
  
  if (!openid) {
    throw new Error('用户未登录');
  }
  
  // 验证团队存在性和用户权限
  const team = await db.collection('teams').doc(teamId).get();
  
  if (!team.data) {
    throw new Error('团队不存在');
  }
  
  if (team.data.creator !== openid) {
    console.log('权限检查失败:', {
      当前用户: openid,
      团队创建者: team.data.creator,
      团队ID: teamId
    });
    throw new Error('只有团队创建者可以删除团队');
  }
  
  console.log('权限检查通过，开始执行硬删除...');
  
  // 硬删除：直接从数据库删除记录
  await db.collection('teams').doc(teamId).remove();
  
  // 同时删除相关的团队成员记录
  try {
    await db.collection('team_members')
      .where({ teamId: teamId })
      .remove();
  } catch (error) {
    console.log('删除团队成员记录失败（可能记录不存在）:', error);
  }
  
  // 同时删除相关的邀请记录
  try {
    await db.collection('invites')
      .where({ teamId: teamId })
      .remove();
  } catch (error) {
    console.log('删除邀请记录失败（可能记录不存在）:', error);
  }
  
  console.log('团队硬删除成功:', teamId);
  
  return {
    success: true,
    data: { teamId }
  };
}

/**
 * 加入团队
 */
async function joinTeam(teamId, openid) {
  if (!openid) {
    throw new Error('用户未登录');
  }
  
  // 验证团队存在性
  const team = await db.collection('teams').doc(teamId).get();
  
  if (!team.data || !team.data.isActive) {
    throw new Error('团队不存在或已删除');
  }
  
  // 检查用户是否已经是成员
  if (team.data.members.includes(openid)) {
    throw new Error('用户已经是团队成员');
  }
  
  // 检查团队人数限制
  if (team.data.memberCount >= 50) {
    throw new Error('团队人数已达上限');
  }
  
  // 添加用户到团队成员
  await db.collection('teams').doc(teamId).update({
    data: {
      members: db.command.push(openid),
      memberCount: db.command.inc(1),
      updatedAt: db.serverDate()
    }
  });
  
  console.log('用户加入团队成功:', { teamId, openid });
  
  return {
    success: true,
    data: { teamId }
  };
}

/**
 * 离开团队
 */
async function leaveTeam(teamId, openid) {
  if (!openid) {
    throw new Error('用户未登录');
  }
  
  // 验证团队存在性
  const team = await db.collection('teams').doc(teamId).get();
  
  if (!team.data || !team.data.isActive) {
    throw new Error('团队不存在或已删除');
  }
  
  // 检查用户是否是团队成员
  if (!team.data.members.includes(openid)) {
    throw new Error('用户不是团队成员');
  }
  
  // 如果是创建者，不能离开团队（只能删除）
  if (team.data.creator === openid) {
    throw new Error('团队创建者不能离开团队，请删除团队');
  }
  
  // 从团队成员中移除用户
  await db.collection('teams').doc(teamId).update({
    data: {
      members: db.command.pull(openid),
      memberCount: db.command.inc(-1),
      updatedAt: db.serverDate()
    }
  });
  
  console.log('用户离开团队成功:', { teamId, openid });
  
  return {
    success: true,
    data: { teamId }
  };
}

/**
 * 更新团队信息
 */
async function updateTeam(teamId, teamData, openid) {
  // 验证团队存在性和用户权限
  const team = await db.collection('teams').doc(teamId).get();
  
  if (!team.data) {
    throw new Error('团队不存在');
  }
  
  if (team.data.creator !== openid) {
    throw new Error('只有团队创建者可以更新团队信息');
  }
  
  // 如果修改了团队名称，检查是否重复
  if (teamData.name && teamData.name !== team.data.name) {
    const existingTeam = await db.collection('teams')
      .where({
        name: teamData.name,
        isActive: true
      })
      .get();
    
    if (existingTeam.data.length > 0) {
      throw new Error('团队名称已存在');
    }
  }
  
  // 更新团队信息
  const updateData = {
    ...teamData,
    updatedAt: db.serverDate()
  };
  
  await db.collection('teams').doc(teamId).update({
    data: updateData
  });
  
  console.log('团队信息更新成功:', teamId);
  
  return {
    success: true,
    data: { teamId }
  };
}

/**
 * 获取团队详细信息
 */
async function getTeamInfo(teamId) {
  // 获取团队信息
  const team = await db.collection('teams').doc(teamId).get();
  
  if (!team.data || !team.data.isActive) {
    throw new Error('团队不存在或已删除');
  }
  
  // 获取团队成员的用户信息
  const memberDetails = await Promise.all(
    team.data.members.map(async (openid) => {
      try {
        // 尝试从users表获取用户信息
        const userResult = await db.collection('users')
          .where({ _openid: openid })
          .get();
        
        if (userResult.data.length > 0) {
          const user = userResult.data[0];
          return {
            openid: openid,
            nickname: user.nickName || '匿名用户',
            avatarUrl: user.avatarUrl || '/images/avatar.png',
            isCreator: openid === team.data.creator
          };
        }
        
        // 如果users表中没有，返回基础信息
        return {
          openid: openid,
          nickname: '用户' + openid.substring(0, 6),
          avatarUrl: '/images/avatar.png',
          isCreator: openid === team.data.creator
        };
      } catch (error) {
        console.error('获取用户信息失败:', error);
        return {
          openid: openid,
          nickname: '用户' + openid.substring(0, 6),
          avatarUrl: '/images/avatar.png',
          isCreator: openid === team.data.creator
        };
      }
    })
  );
  
  const teamInfo = {
    ...team.data,
    members: memberDetails
  };
  
  return {
    success: true,
    data: teamInfo
  };
}

/**
 * 获取团队成员打卡数据
 */
async function getTeamMembersCheckinData(memberOpenids) {
  try {
    console.log('获取团队成员打卡数据:', memberOpenids);
    
    if (!Array.isArray(memberOpenids) || memberOpenids.length === 0) {
      return { success: true, data: {} };
    }
    
    // 获取当前月份
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentMonthStr = `${currentYear}-${currentMonth.toString().padStart(2, '0')}`;
    
    const checkinData = {};
    
    // 批量查询用户打卡数据
    for (const openid of memberOpenids) {
      try {
        // 查询用户当月的打卡记录
        const monthlyResult = await db.collection('meditation_records')
          .where({
            _openid: openid,
            date: db.RegExp({
              regexp: `^${currentMonthStr}`,
              options: 'i'
            })
          })
          .get();
        
        // 查询用户总打卡记录
        const totalResult = await db.collection('meditation_records')
          .where({
            _openid: openid
          })
          .count();
        
        checkinData[openid] = {
          monthlyCount: monthlyResult.data.length,
          totalCount: totalResult.total
        };
        
        console.log(`用户 ${openid} 打卡数据:`, checkinData[openid]);
        
      } catch (error) {
        console.error(`获取用户 ${openid} 打卡数据失败:`, error);
        checkinData[openid] = { monthlyCount: 0, totalCount: 0 };
      }
    }
    
    return { success: true, data: checkinData };
    
  } catch (error) {
    console.error('获取团队成员打卡数据失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 生成邀请链接
 */
async function generateInvite(inviteData, openid) {
  console.log('生成邀请链接，传入参数:', { inviteData, openid });
  
  if (!openid) {
    // 尝试从云函数上下文获取openid
    const wxContext = cloud.getWXContext();
    openid = wxContext.OPENID;
    console.log('从上下文获取openid:', openid);
  }
  
  if (!openid) {
    throw new Error('用户未登录');
  }

  // 验证团队存在性
  const team = await db.collection('teams').doc(inviteData.teamId).get();
  if (!team.data || !team.data.isActive) {
    throw new Error('团队不存在或已删除');
  }

  // 生成邀请ID和凭证
  const inviteId = 'invite_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const inviteToken = 'token_' + Math.random().toString(36).substr(2, 16);

  // 构建分享路径（修复路径：页面在chattool分包中）
  const sharePath = `/subpackages/chattool/pages/joinTeam/joinTeam?` +
    `teamId=${inviteData.teamId}&` +
    `teamName=${encodeURIComponent(inviteData.teamName)}&` +
    `inviterId=${openid}&` +
    `inviteId=${inviteId}`;

  // 创建邀请记录
  const inviteRecord = {
    _id: inviteId,
    teamId: inviteData.teamId,
    teamName: inviteData.teamName,
    inviterId: openid,
    inviterName: inviteData.inviterName || '匿名用户',
    inviteToken: inviteToken,
    sharePath: sharePath,
    status: 'pending',
    inviteTime: db.serverDate(),
    expireTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7天后过期
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };

  // 保存到数据库
  await db.collection('invites').add({
    data: inviteRecord
  });

  console.log('邀请记录创建成功:', inviteId);

  return {
    success: true,
    data: {
      inviteId: inviteId,
      sharePath: sharePath,
      title: `邀请您加入${inviteData.teamName}团队`
    }
  };
}

/**
 * 带邀请信息的加入团队
 */
async function joinTeamWithInvite(teamId, openid, inviterId, inviteId) {
  if (!openid) {
    throw new Error('用户未登录');
  }

  // 验证团队存在性
  const team = await db.collection('teams').doc(teamId).get();
  if (!team.data || !team.data.isActive) {
    throw new Error('团队不存在或已删除');
  }

  // 检查用户是否已经是成员
  if (team.data.members.includes(openid)) {
    throw new Error('用户已经是团队成员');
  }

  // 检查团队人数限制
  if (team.data.memberCount >= 50) {
    throw new Error('团队人数已达上限');
  }

  // 如果有邀请信息，验证邀请有效性
  if (inviteId) {
    const invite = await db.collection('invites').doc(inviteId).get();
    if (!invite.data || invite.data.status !== 'pending') {
      throw new Error('邀请链接已失效');
    }

    // 更新邀请状态为已接受
    await db.collection('invites').doc(inviteId).update({
      data: {
        status: 'accepted',
        inviteeId: openid,
        acceptTime: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }

  // 添加用户到团队成员
  await db.collection('teams').doc(teamId).update({
    data: {
      members: db.command.push(openid),
      memberCount: db.command.inc(1),
      updatedAt: db.serverDate()
    }
  });

  // 创建团队成员关系记录
  const memberRecord = {
    _id: `${teamId}_${openid}`,
    teamId: teamId,
    openid: openid,
    nickname: '新成员', // 实际应该从用户信息获取
    role: 'member',
    joinedAt: db.serverDate(),
    invitedBy: inviterId || null,
    inviteId: inviteId || null,
    status: 'active',
    lastActive: db.serverDate(),
    checkInCount: 0,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };

  await db.collection('team_members').add({
    data: memberRecord
  });

  console.log('用户通过邀请加入团队成功:', { teamId, openid, inviterId, inviteId });

  return {
    success: true,
    data: { teamId }
  };
}

/**
 * 记录邀请行为
 */
async function recordInviteAction(actionData) {
  const actionRecord = {
    _id: 'action_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    teamId: actionData.teamId,
    inviterId: actionData.inviterId,
    inviteId: actionData.inviteId,
    actionType: 'generate',
    actionTime: db.serverDate(),
    details: {
      inviteTime: actionData.inviteTime
    },
    createdAt: db.serverDate()
  };

  await db.collection('invite_actions').add({
    data: actionRecord
  });

  console.log('邀请行为记录成功:', actionRecord._id);

  return {
    success: true,
    data: { actionId: actionRecord._id }
  };
}

/**
 * 记录邀请关系
 */
async function recordInviteRelation(relationData) {
  const relationRecord = {
    _id: 'relation_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    teamId: relationData.teamId,
    inviterId: relationData.inviterId,
    inviteeId: relationData.inviteeId,
    inviteId: relationData.inviteId,
    inviteTime: relationData.inviteTime,
    status: relationData.status || 'accepted',
    createdAt: db.serverDate()
  };

  await db.collection('invite_actions').add({
    data: relationRecord
  });

  console.log('邀请关系记录成功:', relationRecord._id);

  return {
    success: true,
    data: { relationId: relationRecord._id }
  };
}

/**
 * 获取所有团队数据（向所有用户开放）
 */
async function getAllTeams(data) {
  try {
    console.log('🔄 获取所有团队数据...');
    
    // 查询所有团队数据，按创建时间倒序排列
    const result = await db.collection('teams')
      .where({
        isActive: true // 只查询活跃团队
      })
      .orderBy('createdAt', 'desc')
      .get();
    
    console.log('✅ 所有团队数据查询完成:', {
      团队数量: result.data.length,
      团队列表: result.data.map(team => ({name: team.name, id: team._id}))
    });
    
    // 格式化返回数据，只包含公开信息
    const teams = result.data.map(team => ({
      _id: team._id,
      name: team.name,
      description: team.description || '暂无团队介绍',
      icon: team.icon || '/images/icons/team.png',
      memberCount: team.memberCount || 0,
      isActive: team.isActive || true,
      createdAt: team.createdAt,
      creatorName: team.creatorName || '匿名创建者',
      // 不包含敏感信息如成员列表、openid等
    }));
    
    return {
      success: true,
      data: {
        teams: teams,
        count: teams.length
      }
    };
    
  } catch (error) {
    console.error('❌ 获取所有团队数据失败:', error);
    // 返回空数组而不是错误，让前端可以降级处理
    return {
      success: true,
      data: {
        teams: [],
        count: 0
      }
    };
  }
}

/**
 * 获取成员本周的打卡记录
 */
async function getMemberWeekCheckin(data) {
  const { memberOpenid, weekStart, weekEnd } = data;
  
  console.log('🔄 获取成员本周打卡记录:', { memberOpenid, weekStart, weekEnd });
  
  try {
    // 查询本周的冥想记录
    const result = await db.collection('meditation_records')
      .where({
        _openid: memberOpenid,
        date: db.command.gte(weekStart).and(db.command.lte(weekEnd))
      })
      .orderBy('date', 'desc')
      .get();
    
    console.log('✅ 本周打卡记录查询完成:', {
      记录数量: result.data.length,
      时间范围: `${weekStart} 至 ${weekEnd}`
    });
    
    // 格式化返回数据
    const records = result.data.map(record => ({
      timestamp: record.date ? new Date(record.date).getTime() : record.timestamp || Date.now(),
      duration: record.duration || 0,
      rating: record.rating || 0,
      experience: record.experience || [],
      textCount: record.textCount || 0,
      textPreview: record.textPreview || ''
    }));
    
    return {
      success: true,
      data: {
        records: records,
        count: records.length
      }
    };
    
  } catch (error) {
    console.error('❌ 获取本周打卡记录失败:', error);
    // 返回空记录而不是错误，让前端可以降级处理
    return {
      success: true,
      data: {
        records: [],
        count: 0
      }
    };
  }
}