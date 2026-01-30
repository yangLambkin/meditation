const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

exports.main = async (event, context) => {
  try {
    // 获取金句总数
    const countResult = await db.collection('wisdom_quotes').count();
    const total = countResult.total;
    
    if (total === 0) {
      // 如果金句库为空，使用默认金句
      return {
        success: true,
        data: {
          _id: 'default',
          content: '本来无一物，何处惹尘埃',
          weight: 1
        }
      };
    }
    
    // 随机选择一条金句
    const randomIndex = Math.floor(Math.random() * total);
    const wisdomResult = await db.collection('wisdom_quotes')
      .skip(randomIndex)
      .limit(1)
      .get();
    
    if (wisdomResult.data.length === 0) {
      return { 
        success: false, 
        message: '暂无金句数据' 
      };
    }
    
    const wisdom = wisdomResult.data[0];
    
    return {
      success: true,
      data: wisdom
    };
    
  } catch (error) {
    console.error('获取金句失败:', error);
    
    // 出错时返回默认金句
    return {
      success: true,
      data: {
        _id: 'default',
        content: '本来无一物，何处惹尘埃',
        weight: 1
      },
      error: error.message
    };
  }
};