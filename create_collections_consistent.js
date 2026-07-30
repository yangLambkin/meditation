// 冥想打卡数据库集合创建脚本
// 确保与API字段结构完全一致

const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 根据API中的数据结构定义集合字段
const COLLECTION_SCHEMAS = {
  // meditation_records 表结构（与recordMeditation函数中的字段一致）
  meditation_records: {
    description: '冥想打卡记录表',
    fields: {
      _openid: 'string',           // 用户唯一标识
      date: 'string',              // 打卡日期 YYYY-MM-DD
      timestamp: 'number',         // 打卡时间戳
      duration: 'number',          // 静坐时长（分钟）
      emotion: 'array',            // 情绪标签数组（字符串数组）
      experience: 'string',        // 体验记录文字
      createdAt: 'date',           // 创建时间
      updatedAt: 'date'            // 更新时间
    },
    required: ['_openid', 'date', 'timestamp', 'duration']
  },
  
  // user_stats 表结构（与updateUserStats函数中的字段一致）
  user_stats: {
    description: '用户统计数据表',
    fields: {
      _openid: 'string',           // 用户唯一标识
      totalDays: 'number',         // 总打卡天数
      totalCount: 'number',        // 总打卡次数
      totalDuration: 'number',     // 总静坐时长（分钟）
      currentStreak: 'number',     // 当前连续打卡天数
      longestStreak: 'number',     // 最长连续打卡天数
      lastCheckin: 'string',       // 最后打卡日期 YYYY-MM-DD
      monthlyStats: 'object',      // 月度统计数据
      createdAt: 'date',           // 创建时间
      updatedAt: 'date'            // 更新时间
    },
    required: ['_openid']
  },
  
  // rankings 表结构（与updateRankings函数中的字段一致）
  rankings: {
    description: '排行榜数据表',
    fields: {
      _openid: 'string',           // 用户唯一标识
      type: 'string',              // 排行榜类型（daily/monthly/total）
      period: 'string',            // 统计周期（日期/月份/all）
      duration: 'number',          // 静坐总时长
      count: 'number',             // 打卡次数
      updatedAt: 'date'            // 更新时间
    },
    required: ['_openid', 'type', 'period']
  },
  
  // experience_records 表结构（体验记录独立存储）
  experience_records: {
    description: '体验记录表',
    fields: {
      _openid: 'string',           // 用户唯一标识
      text: 'string',              // 体验内容
      timestamp: 'number',         // 记录时间戳
      duration: 'string',          // 时长文本
      created_at: 'date',          // 创建时间
      updated_at: 'date'           // 更新时间
    },
    required: ['_openid', 'text', 'timestamp']
  },
  
  // images 表结构（日签扑克图片表）
  images: {
    description: '日签扑克图片表',
    fields: {
      _openid: 'string',           // 用户唯一标识
      fileID: 'string',            // 云存储文件ID
      filename: 'string',          // 文件名
      category: 'string',          // 图片分类
      description: 'string',       // 图片描述
      uploadTime: 'date',          // 上传时间
      size: 'number',              // 文件大小（字节）
      status: 'string'             // 状态（active/inactive）
    },
    required: ['fileID', 'filename', 'category', 'uploadTime']
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
    const schema = COLLECTION_SCHEMAS[collectionName];
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
    
    // 设置_openid为sample_user
    sampleData._openid = 'sample_user';
    
    // 添加特定字段的示例值
    if (collectionName === 'meditation_records') {
      sampleData.date = '2026-01-31';
      sampleData.timestamp = Date.now();
      sampleData.duration = 25;
      sampleData.emotion = ['不悲不喜'];
      sampleData.experience = '示例体验记录';
    } else if (collectionName === 'user_stats') {
      sampleData.totalDays = 1;
      sampleData.totalCount = 1;
      sampleData.totalDuration = 25;
      sampleData.currentStreak = 1;
      sampleData.longestStreak = 1;
      sampleData.lastCheckin = '2026-01-31';
      sampleData.monthlyStats = {
        '2026-01': {
          days: ['2026-01-31'],
          count: 1,
          totalDuration: 25
        }
      };
    } else if (collectionName === 'rankings') {
      sampleData.type = 'daily';
      sampleData.period = '2026-01-31';
      sampleData.duration = 25;
      sampleData.count = 1;
    } else if (collectionName === 'experience_records') {
      sampleData.text = '示例体验记录内容';
      sampleData.timestamp = Date.now();
      sampleData.duration = '25分钟';
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
      const schema = COLLECTION_SCHEMAS[collectionName];
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

// 主函数：创建并验证所有集合
async function createAllCollections() {
  console.log('🚀 开始创建冥想打卡数据库集合...\n');
  
  const results = [];
  
  for (const [collectionName, schema] of Object.entries(COLLECTION_SCHEMAS)) {
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

// 云函数入口
exports.main = async (event, context) => {
  return await createAllCollections();
};

// 直接运行（用于测试）
if (require.main === module) {
  createAllCollections().then(result => {
    console.log('\n✨ 数据库集合创建完成');
    process.exit(result.success ? 0 : 1);
  }).catch(error => {
    console.error('❌ 创建过程出错:', error);
    process.exit(1);
  });
}