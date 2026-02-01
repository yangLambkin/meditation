// 云存储功能测试脚本
// 用于验证云存储数据库和API是否正常工作

const cloudApi = require('./miniprogram/utils/cloudApi.js');

async function testCloudStorage() {
  console.log('=== 开始测试云存储功能 ===\n');
  
  try {
    // 1. 测试记录打卡
    console.log('1. 测试记录打卡...');
    const recordResult = await cloudApi.recordMeditation(25, 4, "今天的冥想体验很好，感觉很平静。");
    console.log('记录打卡结果:', recordResult);
    
    if (recordResult.success) {
      console.log('✓ 记录打卡成功\n');
    } else {
      console.log('✗ 记录打卡失败:', recordResult.error);
    }
    
    // 等待一段时间让数据同步
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 2. 测试获取用户记录
    console.log('2. 测试获取用户记录...');
    const today = new Date().toISOString().split('T')[0];
    const recordsResult = await cloudApi.getUserRecords(today);
    console.log('获取用户记录结果:', recordsResult);
    
    if (recordsResult.success) {
      console.log('✓ 获取用户记录成功，数量:', recordsResult.data.length);
      if (recordsResult.data.length > 0) {
        console.log('  最后一条记录:', recordsResult.data[0]);
      }
    } else {
      console.log('✗ 获取用户记录失败:', recordsResult.error);
    }
    console.log('');
    
    // 3. 测试获取用户统计
    console.log('3. 测试获取用户统计...');
    const statsResult = await cloudApi.getUserStats();
    console.log('获取用户统计结果:', statsResult);
    
    if (statsResult.success) {
      console.log('✓ 获取用户统计成功');
      console.log('  总打卡次数:', statsResult.data.totalCount);
      console.log('  总打卡天数:', statsResult.data.totalDays);
      console.log('  总时长:', statsResult.data.totalDuration, '分钟');
      console.log('  连续打卡:', statsResult.data.currentStreak, '天');
    } else {
      console.log('✗ 获取用户统计失败:', statsResult.error);
    }
    console.log('');
    
    // 4. 测试获取排行榜
    console.log('4. 测试获取排行榜...');
    const rankingsResult = await cloudApi.getRankings('daily');
    console.log('获取排行榜结果:', rankingsResult);
    
    if (rankingsResult.success) {
      console.log('✓ 获取排行榜成功，数量:', rankingsResult.data.length);
      if (rankingsResult.data.length > 0) {
        console.log('  第一名:', rankingsResult.data[0]);
      }
    } else {
      console.log('✗ 获取排行榜失败:', rankingsResult.error);
    }
    
    console.log('\n=== 云存储功能测试完成 ===');
    
  } catch (error) {
    console.error('测试过程中出现错误:', error);
  }
}

// 运行测试
testCloudStorage();