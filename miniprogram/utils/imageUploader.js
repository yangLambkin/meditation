/**
 * 图片上传工具 - 同时处理云存储和数据库记录
 */

// 初始化云开发环境
const initCloud = () => {
  wx.cloud.init({
    env: 'cloud1-2g2rbxbu2c126d4a'
  });
};

/**
 * 上传图片并自动记录到数据库
 * @param {string} filePath - 本地文件路径
 * @param {string} category - 图片分类（默认：daily_poker）
 * @param {string} description - 图片描述
 * @returns {Promise} 上传结果
 */
const uploadImageToDatabase = async (filePath, category = 'daily_poker', description = '冥想日签扑克图片') => {
  try {
    initCloud();
    
    console.log('🚀 开始上传图片并记录到数据库...');
    
    // 生成唯一文件名
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substr(2, 8);
    const filename = `daily_poker_${timestamp}_${randomStr}.png`;
    
    // 云存储路径（使用您提供的路径格式）
    const cloudPath = `636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/${filename}`;
    
    console.log('📁 上传文件信息:', {
      本地路径: filePath,
      云存储路径: cloudPath,
      文件名: filename
    });
    
    // 1. 上传到云存储
    console.log('⬆️ 上传到云存储...');
    const uploadResult = await wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: filePath
    });
    
    console.log('✅ 云存储上传成功:', {
      fileID: uploadResult.fileID,
      fileSize: uploadResult.fileSize
    });
    
    // 2. 记录到数据库
    console.log('💾 记录到数据库...');
    const dbResult = await wx.cloud.database().collection('images').add({
      data: {
        _openid: 'system',                    // 系统标识
        fileID: uploadResult.fileID,          // 云存储文件ID
        filename: filename,                   // 文件名
        category: category,                   // 图片分类
        description: description,             // 图片描述
        uploadTime: new Date(),               // 上传时间
        size: uploadResult.fileSize || 0,     // 文件大小
        status: 'active'                      // 状态
      }
    });
    
    console.log('✅ 数据库记录成功:', {
      记录ID: dbResult._id,
      文件ID: uploadResult.fileID
    });
    
    return {
      success: true,
      fileID: uploadResult.fileID,
      dbRecordId: dbResult._id,
      filename: filename,
      message: '图片上传并记录到数据库成功'
    };
    
  } catch (error) {
    console.error('❌ 图片上传失败:', error);
    
    // 提供详细的错误信息
    let errorMessage = error.message || '未知错误';
    if (error.errCode === 'STORAGE_FILE_NONEXIST') {
      errorMessage = '本地文件不存在';
    } else if (error.errCode === 'STORAGE_PERMISSION_DENIED') {
      errorMessage = '云存储权限不足';
    } else if (error.errCode === 'DATABASE_PERMISSION_DENIED') {
      errorMessage = '数据库权限不足';
    }
    
    return {
      success: false,
      error: errorMessage,
      errCode: error.errCode,
      message: `图片上传失败: ${errorMessage}`
    };
  }
};

/**
 * 批量上传图片
 * @param {Array} filePaths - 本地文件路径数组
 * @param {string} category - 图片分类
 * @returns {Promise} 批量上传结果
 */
const uploadImagesBatch = async (filePaths, category = 'daily_poker') => {
  try {
    console.log(`🔄 开始批量上传 ${filePaths.length} 张图片...`);
    
    const results = [];
    
    for (let i = 0; i < filePaths.length; i++) {
      console.log(`📤 上传第 ${i + 1}/${filePaths.length} 张图片...`);
      
      const result = await uploadImageToDatabase(filePaths[i], category, `日签扑克图片 ${i + 1}`);
      results.push({
        index: i,
        filename: filePaths[i],
        ...result
      });
      
      // 添加延迟避免请求过快
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`✅ 批量上传完成: ${successCount}/${filePaths.length} 成功`);
    
    return {
      success: true,
      total: filePaths.length,
      successCount: successCount,
      results: results
    };
    
  } catch (error) {
    console.error('❌ 批量上传失败:', error);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
};

/**
 * 获取已上传的图片列表
 * @param {string} category - 图片分类
 * @returns {Promise} 图片列表
 */
const getUploadedImages = async (category = 'daily_poker') => {
  try {
    initCloud();
    
    const queryResult = await wx.cloud.database().collection('images')
      .where({ 
        category: category,
        status: 'active' 
      })
      .orderBy('uploadTime', 'desc')
      .get();
    
    console.log(`📊 获取到 ${queryResult.data.length} 张图片`);
    
    return {
      success: true,
      data: queryResult.data,
      count: queryResult.data.length
    };
    
  } catch (error) {
    console.error('❌ 获取图片列表失败:', error);
    return {
      success: false,
      error: error.message,
      data: []
    };
  }
};

/**
 * 删除图片（从云存储和数据库同时删除）
 * @param {string} fileID - 云存储文件ID
 * @param {string} dbRecordId - 数据库记录ID
 * @returns {Promise} 删除结果
 */
const deleteImage = async (fileID, dbRecordId) => {
  try {
    initCloud();
    
    console.log('🗑️ 开始删除图片...');
    
    // 1. 从云存储删除
    const storageResult = await wx.cloud.deleteFile({
      fileList: [fileID]
    });
    
    console.log('✅ 云存储删除成功:', storageResult);
    
    // 2. 从数据库删除
    const dbResult = await wx.cloud.database().collection('images')
      .doc(dbRecordId)
      .remove();
    
    console.log('✅ 数据库删除成功:', dbResult);
    
    return {
      success: true,
      message: '图片删除成功'
    };
    
  } catch (error) {
    console.error('❌ 删除图片失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = {
  uploadImageToDatabase,
  uploadImagesBatch,
  getUploadedImages,
  deleteImage
};