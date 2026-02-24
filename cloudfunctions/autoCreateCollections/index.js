const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 根据新的1对多关系设计数据库表结构
const COLLECTION_SCHEMAS = {
  // users 表结构（用户信息表）
  users: {
    description: '用户信息表',
    sampleData: {
      _openid: 'user_openid_123',           // 用户唯一标识
      nickName: '微信用户',                   // 微信昵称
      avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/vi_32/xxx', // 微信头像URL
      gender: 1,                            // 性别（0：未知，1：男，2：女）
      country: '中国',                       // 国家
      province: '北京市',                    // 省份
      city: '北京市',                        // 城市
      language: 'zh_CN',                    // 语言
      createTime: new Date(),               // 创建时间
      lastLoginTime: new Date(),            // 最后登录时间
      loginCount: 1,                        // 登录次数
      updatedAt: new Date()                 // 更新时间
    }
  },
  
  // meditation_records 表结构（打卡记录表，1对多关系中的1）
  meditation_records: {
    description: '冥想打卡记录表',
    sampleData: {
      _openid: 'user_openid_123',           // 用户唯一标识
      date: '2026-01-31',                   // 打卡日期 YYYY-MM-DD
      timestamp: 1643625600000,             // 打卡时间戳
      duration: 25,                         // 静坐时长（分钟）
      rating: 4,                            // 体验评分（1-5星）
      experience: ['exp_123456789'],        // 关联的体验记录ID数组（可能为空数组）
      createdAt: new Date(),                // 创建时间
      updatedAt: new Date()                 // 更新时间
    }
  },
  
  // experience_records 表结构（体验记录表，1对多关系中的多）
  experience_records: {
    description: '体验记录表',
    sampleData: {
      _openid: 'user_openid_123',           // 用户唯一标识
      text: '今天的冥想体验很好',            // 体验内容
      timestamp: 1643625600000,             // 记录时间戳
      created_at: new Date(),               // 创建时间
      updated_at: new Date()                // 更新时间
    }
  },
  
  // user_stats 表结构（用户统计数据表）
  user_stats: {
    description: '用户统计数据表',
    sampleData: {
      _openid: 'user_openid_123',           // 用户唯一标识
      totalDays: 1,                         // 总打卡天数
      totalCount: 1,                        // 总打卡次数
      totalDuration: 25,                    // 总静坐时长（分钟）
      currentStreak: 1,                     // 当前连续打卡天数
      longestStreak: 1,                     // 最长连续打卡天数
      lastCheckin: '2026-01-31',            // 最后打卡日期 YYYY-MM-DD
      monthlyStats: {                       // 月度统计数据
        '2026-01': {
          days: ['2026-01-31'],
          count: 1,
          totalDuration: 25
        }
      },
      createdAt: new Date(),                // 创建时间
      updatedAt: new Date()                 // 更新时间
    }
  },
  
  // rankings 表结构（排行榜数据表）
  rankings: {
    description: '排行榜数据表',
    sampleData: {
      _openid: 'user_openid_123',           // 用户唯一标识
      type: 'daily',                        // 排行榜类型（daily/monthly/total）
      period: '2026-01-31',                 // 统计周期（日期/月份/all）
      duration: 25,                         // 静坐总时长
      count: 1,                             // 打卡次数
      updatedAt: new Date()                 // 更新时间
    }
  },
  
  // user_mappings 表结构（用户ID映射表）
  user_mappings: {
    description: '用户ID映射表',
    sampleData: {
      _openid: 'user_openid_123',           // 微信openid
      local_user_id: 'local_1771865524171_7cun3y9q8',  // 本地用户ID
      created_at: new Date(),               // 创建时间
      updated_at: new Date()                // 更新时间
    }
  }
  
};

// 创建集合的通用函数
async function createCollection(collectionName, sampleData) {
  try {
    console.log(`开始创建集合: ${collectionName}`);
    
    // 先检查集合是否存在
    try {
      await db.collection(collectionName).limit(1).get();
      console.log(`集合 ${collectionName} 已存在，跳过创建`);
      return { success: true, action: 'exists', message: `集合 ${collectionName} 已存在` };
    } catch (error) {
      if (error.errCode === 'DATABASE_COLLECTION_NOT_EXIST' || 
          error.errMsg.includes('DATABASE_COLLECTION_NOT_EXIST')) {
        
        // 集合不存在，创建集合
        await db.createCollection(collectionName);
        console.log(`集合 ${collectionName} 创建成功`);
        
        // 等待一小段时间让集合创建完成
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 添加一条示例记录来验证字段结构
        try {
          const result = await db.collection(collectionName).add({
            data: sampleData
          });
          console.log(`集合 ${collectionName} 示例数据添加成功，ID: ${result._id}`);
          
          // 删除示例数据
          await db.collection(collectionName).doc(result._id).remove();
          console.log(`集合 ${collectionName} 示例数据清理完成`);
          
          return { 
            success: true, 
            action: 'created', 
            message: `集合 ${collectionName} 创建成功，字段结构验证通过` 
          };
          
        } catch (addError) {
          console.error(`添加示例数据失败:`, addError);
          return { 
            success: false, 
            action: 'created', 
            message: `集合 ${collectionName} 创建成功，但添加示例数据失败` 
          };
        }
        
      } else {
        // 其他错误
        console.error(`检查集合 ${collectionName} 时出错:`, error);
        return { success: false, action: 'check', message: error.message };
      }
    }
    
  } catch (error) {
    console.error(`创建集合 ${collectionName} 失败:`, error);
    return { success: false, action: 'create', message: error.message };
  }
}

// 云函数入口函数
exports.main = async (event, context) => {
  try {
    console.log('开始自动创建数据库集合...');
    
    const results = [];
    
    // 按顺序创建所有集合
    for (const [collectionName, schema] of Object.entries(COLLECTION_SCHEMAS)) {
      const result = await createCollection(collectionName, schema.sampleData);
      results.push({
        collection: collectionName,
        description: schema.description,
        ...result
      });
      
      // 集合之间稍作间隔
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 统计结果
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    
    console.log('数据库集合创建完成');
    console.log(`成功: ${successCount}/${totalCount}`);
    
    return {
      success: successCount > 0,
      message: `数据库集合创建完成: ${successCount}/${totalCount} 成功`,
      total: totalCount,
      successCount: successCount,
      results: results,
      collections: Object.entries(COLLECTION_SCHEMAS).map(([name, schema]) => ({
        name: name,
        description: schema.description,
        fields: Object.keys(schema.sampleData)
      }))
    };
    
  } catch (error) {
    console.error('自动创建数据库集合失败:', error);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
};