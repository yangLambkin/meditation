const cloud = require('wx-server-sdk');

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 一键删除测试数据脚本
 * 此脚本会删除所有数据库集合中的测试数据，保留数据结构
 */
async function cleanupTestData() {
  console.log('🚀 开始执行测试数据清理...\n');
  
  try {
    // 定义需要清理的数据库集合
    const collections = [
      'meditation_records',     // 冥想打卡记录
      'experience_records',     // 体验记录
      'user_stats',             // 用户统计
      'rankings'                // 排行榜数据
    ];
    
    let totalDeleted = 0;
    
    // 按顺序清理每个集合
    for (const collectionName of collections) {
      console.log(`📊 正在清理集合: ${collectionName}...`);
      
      try {
        // 获取当前集合中的所有数据
        const result = await db.collection(collectionName).get();
        const records = result.data;
        
        if (records.length === 0) {
          console.log(`   - 集合 ${collectionName} 为空，跳过清理\n`);
          continue;
        }
        
        console.log(`   - 找到 ${records.length} 条记录`);
        
        // 批量删除所有记录
        const deletePromises = records.map(record => 
          db.collection(collectionName).doc(record._id).remove()
        );
        
        // 分批删除，避免一次性删除过多数据
        const batchSize = 10;
        for (let i = 0; i < deletePromises.length; i += batchSize) {
          const batch = deletePromises.slice(i, i + batchSize);
          await Promise.all(batch);
          console.log(`   - 已删除 ${Math.min(i + batchSize, deletePromises.length)}/${deletePromises.length} 条记录`);
        }
        
        totalDeleted += records.length;
        console.log(`   ✅ 集合 ${collectionName} 清理完成，删除 ${records.length} 条记录\n`);
        
        // 稍微延迟，避免对数据库造成过大压力
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`   ❌ 清理集合 ${collectionName} 时出错:`, error.message);
        console.log(`   ⚠️  继续处理下一个集合...\n`);
      }
    }
    
    console.log('🎉 测试数据清理完成！');
    console.log(`📈 总共删除了 ${totalDeleted} 条测试数据`);
    console.log('\n📋 清理的集合包括:');
    console.log('   - meditation_records (冥想打卡记录)');
    console.log('   - experience_records (体验记录)');
    console.log('   - user_stats (用户统计)');
    console.log('   - rankings (排行榜数据)');
    console.log('\n⚠️  注意：此操作仅删除数据，不会删除数据库集合结构');
    console.log('💡 下次小程序启动时，数据库结构将保持不变，可以正常使用');
    
    return {
      success: true,
      totalDeleted: totalDeleted,
      message: `成功删除 ${totalDeleted} 条测试数据`
    };
    
  } catch (error) {
    console.error('❌ 清理测试数据失败:', error);
    return {
      success: false,
      error: error.message,
      message: '清理测试数据失败'
    };
  }
}

/**
 * 安全清理模式 - 只删除特定日期范围的测试数据
 * 用于生产环境，避免误删真实用户数据
 */
async function safeCleanupTestData() {
  console.log('🛡️  安全清理模式启动...\n');
  console.log('📅 将删除指定日期范围内的测试数据\n');
  
  try {
    // 定义需要清理的日期范围（测试期间的数据）
    const testPeriod = {
      startDate: '2026-01-01',  // 测试开始日期
      endDate: '2026-02-07'     // 测试结束日期（今天）
    };
    
    let totalDeleted = 0;
    
    console.log(`📊 清理日期范围: ${testPeriod.startDate} 至 ${testPeriod.endDate}`);
    
    // 清理冥想打卡记录（按日期范围）
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
    
    // 清理体验记录（按时间戳范围）
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
    
    // 清理用户统计和排行榜数据（这些表会随着主记录删除而自动更新）
    console.log('\n📊 正在清理 user_stats 和 rankings...');
    console.log('   - 由于冥想记录已删除，相关统计和排行数据将在下次使用时自动重建');
    console.log('   - 跳过直接删除，避免数据结构问题');
    
    console.log('\n🎉 安全清理完成！');
    console.log(`📈 总共删除了 ${totalDeleted} 条测试数据`);
    
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

/**
 * 查看当前数据统计
 */
async function showDataStatistics() {
  console.log('📊 当前数据统计...\n');
  
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
        console.log(`   - ${collectionName}: 无法访问（可能不存在）`);
        stats[collectionName] = 'N/A';
      }
    }
    
    console.log('\n💡 建议：');
    console.log('   - 如果记录数较多，建议使用安全清理模式');
    console.log('   - 如果确认都是测试数据，可以使用完整清理模式');
    
    return {
      success: true,
      statistics: stats
    };
    
  } catch (error) {
    console.error('❌ 获取数据统计失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 导出云函数
if (typeof exports !== 'undefined') {
  exports.main = async (event, context) => {
    const { mode = 'safe' } = event;
    
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
}

// 本地测试用
if (require.main === module) {
  console.log('🧪 本地测试模式\n');
  
  // 显示当前数据统计
  showDataStatistics().then(async (statsResult) => {
    if (statsResult.success) {
      console.log('\n💡 请根据统计结果选择合适的清理模式：');
      console.log('   - npm run cleanup:safe    (安全清理 - 推荐)');
      console.log('   - npm run cleanup:full    (完整清理 - 谨慎使用)');
      console.log('   - npm run cleanup:stats   (查看统计)');
    }
  });
}