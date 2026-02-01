// 云函数：获取背景图片列表
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

/**
 * 获取云存储中bg_image文件夹下的图片列表
 */
exports.main = async (event, context) => {
  try {
    console.log('🔄 开始获取背景图片列表...');
    
    // 定义图片文件列表
    const imageFiles = [
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg1.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg2.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg3.jpeg'
    ];
    
    // 获取临时文件URL（有效期24小时）
    const tempFileResult = await cloud.getTempFileURL({
      fileList: imageFiles
    });
    
    console.log('✅ 获取临时文件URL结果:', tempFileResult);
    
    // 过滤有效的文件URL
    const validFiles = tempFileResult.fileList.filter(file => 
      file.status === 0 && file.tempFileURL && file.tempFileURL !== ''
    );
    
    console.log('📊 有效图片数量:', validFiles.length);
    
    return {
      success: true,
      data: {
        images: validFiles.map(file => file.tempFileURL),
        total: validFiles.length,
        fileInfos: validFiles.map(file => ({
          fileID: file.fileID,
          tempFileURL: file.tempFileURL,
          maxAge: file.maxAge
        })),
        timestamp: new Date().toISOString()
      },
      message: '获取背景图片列表成功'
    };
    
  } catch (error) {
    console.error('❌ 获取背景图片列表失败:', error);
    
    return {
      success: false,
      data: {
        images: [],
        total: 0
      },
      message: '获取背景图片列表失败: ' + error.message
    };
  }
};