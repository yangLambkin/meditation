// 团队邀请数据库集合创建脚本
// 创建邀请功能所需的云端数据库集合

const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 团队邀请相关集合结构定义
const TEAM_COLLECTION_SCHEMAS = {
  // invites 表结构 - 邀请记录集合
  invites: {
    description: '团队邀请记录表',
    fields: {
      _id: 'string',                 // 邀请ID（唯一标识）
      teamId: 'string',              // 团队ID
      teamName: 'string',            // 团队名称
      inviterId: 'string',           // 邀请者openid
      inviterName: 'string',         // 邀请者昵称
      inviteeId: 'string',           // 被邀请者openid（可为空，表示未指定）
      inviteeName: 'string',         // 被邀请者昵称
      inviteToken: 'string',         // 邀请凭证（用于验证）
      sharePath: 'string',           // 分享路径
      status: 'string',              // 邀请状态（pending/accepted/expired）
      inviteTime: 'date',            // 邀请时间
      acceptTime: 'date',            // 接受时间
      expireTime: 'date',            // 过期时间
      createdAt: 'date',             // 创建时间
      updatedAt: 'date'              // 更新时间
    },
    required: ['_id', 'teamId', 'inviterId', 'inviteToken', 'status']
  },

  // team_members 表结构 - 团队成员关系集合
  team_members: {
    description: '团队成员关系表',
    fields: {
      _id: 'string',                 // 关系ID（团队ID+用户ID）
      teamId: 'string',              // 团队ID
      openid: 'string',              // 用户openid
      nickname: 'string',            // 用户昵称
      role: 'string',                // 成员角色（creator/admin/member）
      joinedAt: 'date',              // 加入时间
      invitedBy: 'string',           // 邀请者openid（可为空）
      inviteId: 'string',            // 邀请记录ID（可为空）
      status: 'string',              // 成员状态（active/inactive）
      lastActive: 'date',            // 最后活跃时间
      checkInCount: 'number',        // 打卡次数
      createdAt: 'date',             // 创建时间
      updatedAt: 'date'              // 更新时间
    },
    required: ['_id', 'teamId', 'openid', 'role', 'status']
  },

  // invite_actions 表结构 - 邀请行为记录集合
  invite_actions: {
    description: '邀请行为记录表',
    fields: {
      _id: 'string',                 // 行为ID
      teamId: 'string',              // 团队ID
      inviterId: 'string',           // 邀请者openid
      inviteeId: 'string',           // 被邀请者openid（可为空，recordInviteRelation 写入）
      inviteId: 'string',            // 邀请记录ID
      actionType: 'string',          // 行为类型（generate/accept/decline）
      actionTime: 'date',            // 行为时间
      inviteTime: 'date',            // 邀请时间（recordInviteRelation 写入）
      status: 'string',              // 状态（recordInviteRelation 写入）
      details: 'object',             // 行为详情
      createdAt: 'date'              // 创建时间
    },
    required: ['_id', 'teamId', 'inviterId', 'actionType', 'actionTime']
  }
};

// 检查集合是否存在
async function checkCollectionExists(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
    return true;
  } catch (error) {
    if (error.errCode === 'DATABASE_COLLECTION_NOT_EXIST') {
      return false;
    }
    throw error;
  }
}

// 创建集合
async function createCollection(collectionName) {
  try {
    await db.createCollection(collectionName);
    console.log(`✅ 集合 ${collectionName} 创建成功`);
    return { success: true, message: `集合 ${collectionName} 创建成功` };
  } catch (error) {
    if (error.errCode === 'DATABASE_COLLECTION_EXISTS') {
      console.log(`ℹ️  集合 ${collectionName} 已存在`);
      return { success: true, message: `集合 ${collectionName} 已存在` };
    }
    console.error(`❌ 创建集合 ${collectionName} 失败:`, error);
    return { success: false, error: error.message };
  }
}

// 添加示例数据验证字段结构
async function addSampleData(collectionName) {
  try {
    const schema = TEAM_COLLECTION_SCHEMAS[collectionName];
    const sampleData = {};
    
    // 根据字段结构创建示例数据
    Object.keys(schema.fields).forEach(field => {
      switch(schema.fields[field]) {
        case 'string':
          sampleData[field] = `sample_${field}`;
          break;
        case 'number':
          sampleData[field] = 0;
          break;
        case 'date':
          sampleData[field] = new Date();
          break;
        case 'object':
          sampleData[field] = { sample: 'data' };
          break;
        default:
          sampleData[field] = null;
      }
    });
    
    // 设置特定字段的示例值
    if (collectionName === 'invites') {
      sampleData._id = 'invite_sample_001';
      sampleData.teamId = 'team_sample_001';
      sampleData.teamName = '示例团队';
      sampleData.inviterId = 'sample_inviter';
      sampleData.inviterName = '示例邀请者';
      sampleData.inviteToken = 'sample_token_123';
      sampleData.sharePath = '/pages/joinTeam/joinTeam?teamId=team_sample_001&inviterId=sample_inviter&inviteId=invite_sample_001';
      sampleData.status = 'pending';
      sampleData.inviteTime = new Date();
      sampleData.expireTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7天后过期
    } else if (collectionName === 'team_members') {
      sampleData._id = 'team_sample_001_sample_user';
      sampleData.teamId = 'team_sample_001';
      sampleData.openid = 'sample_user';
      sampleData.nickname = '示例成员';
      sampleData.role = 'member';
      sampleData.joinedAt = new Date();
      sampleData.status = 'active';
      sampleData.checkInCount = 5;
    } else if (collectionName === 'invite_actions') {
      sampleData._id = 'action_sample_001';
      sampleData.teamId = 'team_sample_001';
      sampleData.inviterId = 'sample_inviter';
      sampleData.inviteId = 'invite_sample_001';
      sampleData.actionType = 'generate';
      sampleData.actionTime = new Date();
      sampleData.details = { message: '示例邀请行为' };
    }
    
    const result = await db.collection(collectionName).add({
      data: sampleData
    });
    
    console.log(`✅ 集合 ${collectionName} 示例数据添加成功，ID: ${result._id}`);
    
    // 删除示例数据
    await db.collection(collectionName).doc(result._id).remove();
    console.log(`✅ 集合 ${collectionName} 示例数据清理完成`);
    
    return { success: true, message: `集合 ${collectionName} 字段结构验证通过` };
  } catch (error) {
    console.error(`❌ 集合 ${collectionName} 字段结构验证失败:`, error);
    return { success: false, error: error.message };
  }
}

// 验证集合字段结构
async function validateCollectionSchema(collectionName) {
  try {
    // 尝试查询一条记录来验证字段结构
    const records = await db.collection(collectionName).limit(1).get();
    
    if (records.data.length > 0) {
      const record = records.data[0];
      const schema = TEAM_COLLECTION_SCHEMAS[collectionName];
      let valid = true;
      
      // 检查必需字段是否存在
      for (const field of schema.required) {
        if (!(field in record)) {
          console.warn(`⚠️  字段 ${field} 不存在于集合 ${collectionName}`);
          valid = false;
        }
      }
      
      if (valid) {
        console.log(`✅ 集合 ${collectionName} 字段结构验证通过`);
        return { success: true, message: `集合 ${collectionName} 字段结构正确` };
      } else {
        return { success: false, error: `集合 ${collectionName} 字段结构不完整` };
      }
    } else {
      // 如果没有记录，通过添加示例数据来验证
      return await addSampleData(collectionName);
    }
  } catch (error) {
    console.error(`❌ 验证集合 ${collectionName} 失败:`, error);
    return { success: false, error: error.message };
  }
}

// 创建所有团队相关集合
async function createTeamCollections() {
  console.log('🚀 开始创建团队邀请数据库集合...\n');
  
  const results = [];
  
  for (const [collectionName, schema] of Object.entries(TEAM_COLLECTION_SCHEMAS)) {
    console.log(`📋 处理集合: ${collectionName} (${schema.description})`);
    
    // 检查集合是否存在
    const exists = await checkCollectionExists(collectionName);
    
    if (!exists) {
      // 创建集合
      const createResult = await createCollection(collectionName);
      results.push({
        collection: collectionName,
        action: 'create',
        ...createResult
      });
    } else {
      console.log(`ℹ️  集合 ${collectionName} 已存在，跳过创建`);
      results.push({
        collection: collectionName,
        action: 'check',
        success: true,
        message: `集合 ${collectionName} 已存在`
      });
    }
    
    // 验证字段结构
    const validateResult = await validateCollectionSchema(collectionName);
    results.push({
      collection: collectionName,
      action: 'validate',
      ...validateResult
    });
    
    console.log(''); // 空行分隔
  }
  
  // 输出总结
  console.log('📊 创建结果总结:');
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  
  results.forEach(result => {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${result.collection} - ${result.action}: ${result.message}`);
  });
  
  console.log(`\n🎯 完成情况: ${successCount}/${totalCount} 项成功`);
  
  return {
    success: successCount === totalCount,
    total: totalCount,
    successCount: successCount,
    results: results
  };
}

// 云函数入口（可作为独立的创建云函数）
exports.main = async (event, context) => {
  return await createTeamCollections();
};

// 直接运行（用于测试）
if (require.main === module) {
  createTeamCollections().then(result => {
    console.log('\n✨ 团队邀请数据库集合创建完成');
    process.exit(result.success ? 0 : 1);
  }).catch(error => {
    console.error('❌ 创建过程出错:', error);
    process.exit(1);
  });
}