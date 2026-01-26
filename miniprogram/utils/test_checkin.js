// 打卡系统测试脚本
const checkinManager = require('./checkin.js');

console.log('=== 打卡系统完整测试 ===');

// 测试1: 基本功能测试
console.log('1. 基本功能测试:');

// 模拟几次打卡
console.log('   模拟打卡记录:');
const testRecords = [
  { duration: '7分钟', rating: 4, textRecords: [{ text: '今天状态很好' }] },
  { duration: '15分钟', rating: 5, textRecords: [{ text: '深度冥想' }, { text: '内心平静' }] },
  { duration: '10分钟', rating: 3, textRecords: [] }
];

testRecords.forEach((record, index) => {
  const result = checkinManager.recordCheckin(record.duration, record.rating, record.textRecords);
  console.log(`   打卡${index + 1}:`, result.success ? '成功' : '失败', result);
});

// 测试2: 获取统计数据
console.log('2. 统计数据测试:');
const stats = checkinManager.getUserStats();
console.log('   用户统计:', stats);

// 测试3: 获取已打卡日期
console.log('3. 已打卡日期测试:');
const checkedDates = checkinManager.getAllCheckedDates();
console.log('   已打卡日期:', checkedDates);

// 测试4: 获取某天的详细记录
if (checkedDates.length > 0) {
  console.log('4. 详细记录测试:');
  const todayRecords = checkinManager.getDailyCheckinRecords(checkedDates[0]);
  console.log('   今日详细记录:', todayRecords);
}

// 测试5: 月度统计测试
console.log('5. 月度统计测试:');
const today = new Date();
const monthStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}`;
const monthlyCount = checkinManager.getMonthlyCheckinCount(monthStr);
const monthlyDays = checkinManager.getMonthlyCheckinDays(monthStr);
console.log(`   本月${monthStr}打卡:`, `总次数${monthlyCount}, 总天数${monthlyDays}`);

// 测试6: 边界情况测试
console.log('6. 边界情况测试:');

// 测试不存在日期的打卡次数
const nonExistCount = checkinManager.getDailyCheckinCount('2000-01-01');
console.log('   不存在日期的打卡次数:', nonExistCount);

// 测试不存在月份的统计
const nonExistMonthly = checkinManager.getMonthlyCheckinCount('2000-01');
console.log('   不存在月份的打卡次数:', nonExistMonthly);

console.log('=== 测试完成 ===');

// 清理测试数据（可选）
console.log('\n=== 清理测试数据（可选） ===');
console.log('注意：实际应用中不需要清理，这里只是测试演示');

// 显示完整的用户数据
console.log('完整用户数据:', checkinManager.getUserCheckinData());