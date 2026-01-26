// 背景图片功能测试脚本
const imageConfig = require('./images.js');

// 测试图片存储系统
console.log('=== 背景图片存储系统测试 ===');

// 测试获取所有背景图片
console.log('1. 所有背景图片:', imageConfig.getAllBackgrounds());

// 测试随机选择功能
console.log('2. 随机背景图片测试:');
for (let i = 0; i < 5; i++) {
  const randomBg = imageConfig.getRandomBackground();
  console.log(`   测试 ${i + 1}:`, randomBg);
}

// 测试根据ID获取图片
console.log('3. 根据ID获取图片:');
console.log('   bg1:', imageConfig.getBackgroundById('bg1'));
console.log('   bg3:', imageConfig.getBackgroundById('bg3'));
console.log('   不存在的ID:', imageConfig.getBackgroundById('nonexistent'));

// 测试添加新图片功能
console.log('4. 添加新背景图片测试:');
const addResult = imageConfig.addBackground('bg6', '/images/bg6.jpeg');
console.log('   添加结果:', addResult);
console.log('   更新后的图片列表:', imageConfig.getAllBackgrounds());

// 测试删除图片功能
console.log('5. 删除背景图片测试:');
const removeResult = imageConfig.removeBackground('bg6');
console.log('   删除结果:', removeResult);
console.log('   删除后的图片列表:', imageConfig.getAllBackgrounds());

console.log('=== 测试完成 ===');