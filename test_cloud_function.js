// 测试云函数功能
const cloudApi = require('./miniprogram/utils/cloudApi.js');

async function testCloudFunctions() {
  console.log('开始测试云函数...\n');
  
  try {
    // 测试1: 获取用户统计信息
    console.log('测试1: 获取用户统计信息');
    const stats = await cloudApi.getUserStats();
    console.log('统计信息结果:', JSON.stringify(stats, null, 2));
    
    if (stats.success) {
      console.log('✅ 获取用户统计信息成功');
    } else {
      console.log('❌ 获取用户统计信息失败:', stats.error);
    }
    
    // 测试2: 记录一次测试打卡
    console.log('\n测试2: 记录一次测试打卡');
    const recordResult = await cloudApi.recordMeditation(30, 5, "测试云函数功能");
    console.log('打卡结果:', JSON.stringify(recordResult, null, 2));
    
    if (recordResult.success) {
      console.log('✅ 记录打卡成功');
    } else {
      console.log('❌ 记录打卡失败:', recordResult.error);
    }
    
    // 测试3: 获取今天的打卡记录
    console.log('\n测试3: 获取今天的打卡记录');
    const today = new Date().toISOString().split('T')[0];
    const records = await cloudApi.getUserRecords(today);
    console.log('今日记录结果:', JSON.stringify(records, null, 2));
    
    if (records.success) {
      console.log('✅ 获取今日记录成功');
      if (records.data && records.data.length > 0) {
        console.log(`今日打卡次数: ${records.data.length}`);
      } else {
        console.log('今日暂无打卡记录');
      }
    } else {
      console.log('❌ 获取今日记录失败:', records.error);
    }
    
    // 总结测试结果
    console.log('\n=== 测试总结 ===');
    const tests = [
      { name: '获取用户统计', result: stats.success },
      { name: '记录打卡', result: recordResult.success },
      { name: '获取记录', result: records.success }
    ];
    
    tests.forEach(test => {
      console.log(`${test.result ? '✅' : '❌'} ${test.name}`);
    });
    
    const successCount = tests.filter(t => t.result).length;
    console.log(`\n成功: ${successCount}/${tests.length}`);
    
  } catch (error) {
    console.error('测试过程中发生错误:', error);
  }
}

// 运行测试
testCloudFunctions().catch(console.error);