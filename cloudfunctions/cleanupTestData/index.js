const cloud = require('wx-server-sdk');

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 一键删除测试数据云函数
 * 支持完整清理和安全清理两种模式
 */

// 完整清理模式 - 删除所有数据
async function cleanupTestData() {
  console.log('🚀 开始执行完整测试数据清理...');
  
  try {
    const collections = [
      'meditation_records',     // 冥想打卡记录
      'experience_records',     // 体验记录
      'user_stats',             // 用户统计
      'rankings'                // 排行榜数据
    ];
    
    let totalDeleted = 0;
    
    for (const collectionName of collections) {
      console.log(`📊 正在清理集合: ${collectionName}...`);
      
      try {
        const result = await db.collection(collectionName).get();
        const records = result.data;
        
        if (records.length === 0) {
          console.log(`   - 集合 ${collectionName} 为空，跳过清理`);
          continue;
        }
        
        console.log(`   - 找到 ${records.length} 条记录`);
        
        // 批量删除
        const deletePromises = records.map(record => 
          db.collection(collectionName).doc(record._id).remove()
        );
        
        const batchSize = 10;
        for (let i = 0; i < deletePromises.length; i += batchSize) {
          const batch = deletePromises.slice(i, i + batchSize);
          await Promise.all(batch);
          console.log(`   - 已删除 ${Math.min(i + batchSize, deletePromises.length)}/${deletePromises.length} 条记录`);
        }
        
        totalDeleted += records.length;
        console.log(`   ✅ 集合 ${collectionName} 清理完成`);
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`   ❌ 清理集合 ${collectionName} 时出错:`, error.message);
      }
    }
    
    console.log('🎉 完整清理完成！');
    
    return {
      success: true,
      totalDeleted: totalDeleted,
      message: `完整清理完成，删除 ${totalDeleted} 条测试数据`
    };
    
  } catch (error) {
    console.error('❌ 完整清理失败:', error);
    return {
      success: false,
      error: error.message,
      message: '完整清理失败'
    };
  }
}

// 安全清理模式 - 按日期范围删除
async function safeCleanupTestData() {
  console.log('🛡️  安全清理模式启动...');
  
  try {
    // 定义测试期间
    const testPeriod = {
      startDate: '2026-01-01',  // 测试开始日期
      endDate: '2026-02-07'     // 测试结束日期（今天）
    };
    
    let totalDeleted = 0;
    
    console.log(`📅 清理日期范围: ${testPeriod.startDate} 至 ${testPeriod.endDate}`);
    
    // 清理冥想打卡记录
    console.log('\n📊 正在按日期范围清理 meditation_records...');
    const meditationRecords = await db.collection('meditation_records')
      .where({
        date: db.command.gte(testPeriod.startDate).and(db.command.lte(testPeriod.endDate))
      })
      .get();
    
    if (meditationRecords.data.length > 0) {
      console.log(`   - 找到 ${meditationRecords.data.length} 条测试期间的打卡记录`);
      
      const deletePromises = meditationRecords.data.map(record => 
        db.collection('meditation_records').doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      totalDeleted += meditationRecords.data.length;
      console.log(`   ✅ 删除 ${meditationRecords.data.length} 条打卡记录`);
    } else {
      console.log('   - 未找到测试期间的打卡记录');
    }
    
    // 清理体验记录
    console.log('\n📊 正在按时间范围清理 experience_records...');
    const startTimestamp = new Date(testPeriod.startDate).getTime();
    const endTimestamp = new Date(testPeriod.endDate).getTime();
    
    const experienceRecords = await db.collection('experience_records')
      .where({
        timestamp: db.command.gte(startTimestamp).and(db.command.lte(endTimestamp))
      })
      .get();
    
    if (experienceRecords.data.length > 0) {
      console.log(`   - 找到 ${experienceRecords.data.length} 条测试期间的体验记录`);
      
      const deletePromises = experienceRecords.data.map(record => 
        db.collection('experience_records').doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      totalDeleted += experienceRecords.data.length;
      console.log(`   ✅ 删除 ${experienceRecords.data.length} 条体验记录`);
    } else {
      console.log('   - 未找到测试期间的体验记录');
    }
    
    console.log('\n📊 跳过清理 user_stats 和 rankings...');
    console.log('   - 这些数据将在下次使用时自动重建');
    
    console.log('\n🎉 安全清理完成！');
    
    return {
      success: true,
      totalDeleted: totalDeleted,
      testPeriod: testPeriod,
      message: `安全清理完成，删除 ${totalDeleted} 条测试数据`
    };
    
  } catch (error) {
    console.error('❌ 安全清理失败:', error);
    return {
      success: false,
      error: error.message,
      message: '安全清理失败'
    };
  }
}

// 查看数据统计
async function showDataStatistics() {
  console.log('📊 当前数据统计...');
  
  try {
    const collections = [
      'meditation_records',
      'experience_records', 
      'user_stats',
      'rankings'
    ];
    
    const stats = {};
    
    for (const collectionName of collections) {
      try {
        const result = await db.collection(collectionName).count();
        stats[collectionName] = result.total;
        console.log(`   - ${collectionName}: ${result.total} 条记录`);
      } catch (error) {
        console.log(`   - ${collectionName}: 无法访问`);
        stats[collectionName] = 'N/A';
      }
    }
    
    return {
      success: true,
      statistics: stats,
      message: '数据统计获取完成'
    };
    
  } catch (error) {
    console.error('❌ 获取数据统计失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 云函数入口
exports.main = async (event, context) => {
  const { mode = 'safe' } = event;
  
  console.log(`🔧 执行清理模式: ${mode}`);
  
  switch (mode) {
    case 'full':
      return await cleanupTestData();
    case 'safe':
      return await safeCleanupTestData();
    case 'stats':
      return await showDataStatistics();
    default:
      return {
        success: false,
        error: '未知的清理模式',
        message: '请使用 full、safe 或 stats 模式'
      };
  }
};