// 测试集合是否存在
const cloud = require("wx-server-sdk");

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// 测试函数
async function checkCollections() {
  console.log('开始检查集合是否存在...');
  
  try {
    // 检查 meditation_records 集合
    console.log('检查 meditation_records 集合...');
    try {
      const meditationResult = await db.collection("meditation_records").get();
      console.log('✅ meditation_records 集合存在，记录数:', meditationResult.data.length);
    } catch (error) {
      console.log('❌ meditation_records 集合不存在或无权访问:', error.message);
    }
    
    // 检查 experience_records 集合
    console.log('检查 experience_records 集合...');
    try {
      const experienceResult = await db.collection("experience_records").get();
      console.log('✅ experience_records 集合存在，记录数:', experienceResult.data.length);
    } catch (error) {
      console.log('❌ experience_records 集合不存在或无权访问:', error.message);
    }
    
  } catch (error) {
    console.error('检查集合时出错:', error);
  }
}

// 运行测试
checkCollections();