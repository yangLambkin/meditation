// 清理测试数据的脚本
// 此脚本会删除测试数据，但保留重要的基础数据

const cloud = require("wx-server-sdk");

// 配置云环境（请根据实际环境修改）
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

/**
 * 主函数 - 清理测试数据
 */
async function cleanTestData() {
  console.log('🚀 开始清理测试数据...\n');

  try {
    // 1. 清理冥想打卡记录（meditation_records）
    console.log('📊 清理冥想打卡记录...');
    await cleanMeditationRecords();

    // 2. 清理体验记录（experience_records）
    console.log('📝 清理体验记录...');
    await cleanExperienceRecords();

    // 3. 清理用户统计数据（user_stats）
    console.log('📈 清理用户统计数据...');
    await cleanUserStats();

    // 4. 清理排行榜数据（rankings）
    console.log('🏆 清理排行榜数据...');
    await cleanRankings();

    console.log('✅ 测试数据清理完成！');
    console.log('\n🔒 重要数据保留：');
    console.log('   - 金句库 (wisdom_quotes) 未受影响');
    console.log('   - 云存储图片未受影响');
    console.log('   - 用户基础数据保留');

  } catch (error) {
    console.error('❌ 清理过程中出现错误:', error);
  }
}

/**
 * 清理冥想打卡记录
 * 删除所有记录，保留空集合结构
 */
async function cleanMeditationRecords() {
  try {
    // 获取所有记录
    const result = await db.collection("meditation_records").get();
    
    if (result.data.length === 0) {
      console.log('   冥想打卡记录已为空');
      return;
    }
    
    console.log(`   找到 ${result.data.length} 条冥想打卡记录`);
    
    // 批量删除记录
    const batchSize = 100;
    for (let i = 0; i < result.data.length; i += batchSize) {
      const batch = result.data.slice(i, i + batchSize);
      const deletePromises = batch.map(record => 
        db.collection("meditation_records").doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      console.log(`   已删除 ${Math.min(i + batchSize, result.data.length)}/${result.data.length} 条记录`);
    }
    
    console.log('   ✅ 冥想打卡记录清理完成');
  } catch (error) {
    console.error('   清理冥想打卡记录失败:', error);
    throw error;
  }
}

/**
 * 清理体验记录
 */
async function cleanExperienceRecords() {
  try {
    const result = await db.collection("experience_records").get();
    
    if (result.data.length === 0) {
      console.log('   体验记录已为空');
      return;
    }
    
    console.log(`   找到 ${result.data.length} 条体验记录`);
    
    // 批量删除记录
    const batchSize = 100;
    for (let i = 0; i < result.data.length; i += batchSize) {
      const batch = result.data.slice(i, i + batchSize);
      const deletePromises = batch.map(record => 
        db.collection("experience_records").doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      console.log(`   已删除 ${Math.min(i + batchSize, result.data.length)}/${result.data.length} 条记录`);
    }
    
    console.log('   ✅ 体验记录清理完成');
  } catch (error) {
    console.error('   清理体验记录失败:', error);
    throw error;
  }
}

/**
 * 清理用户统计数据
 * 保留用户统计记录，但重置为初始状态
 */
async function cleanUserStats() {
  try {
    const result = await db.collection("user_stats").get();
    
    if (result.data.length === 0) {
      console.log('   用户统计数据已为空');
      return;
    }
    
    console.log(`   找到 ${result.data.length} 条用户统计记录`);
    
    // 重置所有用户统计数据为初始状态
    const updatePromises = result.data.map(userStat => 
      db.collection("user_stats").doc(userStat._id).update({
        data: {
          totalDays: 0,
          totalCount: 0,
          totalDuration: 0,
          currentStreak: 0,
          longestStreak: 0,
          lastCheckin: null,
          monthlyStats: {},
          updatedAt: new Date()
        }
      })
    );
    
    await Promise.all(updatePromises);
    console.log('   ✅ 用户统计数据重置完成');
  } catch (error) {
    console.error('   清理用户统计数据失败:', error);
    throw error;
  }
}

/**
 * 清理排行榜数据
 */
async function cleanRankings() {
  try {
    const result = await db.collection("rankings").get();
    
    if (result.data.length === 0) {
      console.log('   排行榜数据已为空');
      return;
    }
    
    console.log(`   找到 ${result.data.length} 条排行榜记录`);
    
    // 删除所有排行榜记录
    const batchSize = 100;
    for (let i = 0; i < result.data.length; i += batchSize) {
      const batch = result.data.slice(i, i + batchSize);
      const deletePromises = batch.map(record => 
        db.collection("rankings").doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      console.log(`   已删除 ${Math.min(i + batchSize, result.data.length)}/${result.data.length} 条记录`);
    }
    
    console.log('   ✅ 排行榜数据清理完成');
  } catch (error) {
    console.error('   清理排行榜数据失败:', error);
    throw error;
  }
}

/**
 * 安全检查 - 确认是否要执行清理操作
 */
function confirmClean() {
  console.log('⚠️ 警告：此操作将删除以下数据：');
  console.log('   - 所有冥想打卡记录');
  console.log('   - 所有体验记录');
  console.log('   - 所有排行榜数据');
  console.log('   - 重置用户统计数据');
  console.log('\n✅ 以下数据将保留：');
  console.log('   - 金句库 (wisdom_quotes)');
  console.log('   - 云存储图片');
  console.log('   - 用户基础信息');
  
  // 在实际部署时，可以取消下面的注释来要求确认
  // const readline = require('readline');
  // const rl = readline.createInterface({
  //   input: process.stdin,
  //   output: process.stdout
  // });
  
  // rl.question('\n确认执行清理操作？(输入 yes 继续): ', (answer) => {
  //   if (answer.toLowerCase() === 'yes') {
  //     cleanTestData();
  //   } else {
  //     console.log('操作已取消');
  //   }
  //   rl.close();
  // });

  // 为了便于测试，这里直接执行清理
  cleanTestData();
}

// 导出模块
module.exports = {
  cleanTestData,
  cleanMeditationRecords,
  cleanExperienceRecords,
  cleanUserStats,
  cleanRankings
};

// 如果直接运行此文件，则执行清理
if (require.main === module) {
  confirmClean();
}