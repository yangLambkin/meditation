const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 将已上传的图片记录到数据库
 * @param {Array} fileList - 文件列表
 * @returns {Object} 处理结果
 */
const recordImagesToDatabase = async (fileList) => {
  try {
    console.log('🚀 开始将已上传图片记录到数据库...');
    console.log('📁 需要处理的文件数量:', fileList.length);
    
    const results = [];
    
    for (let i = 0; i < fileList.length; i++) {
      const fileInfo = fileList[i];
      console.log(`📤 处理第 ${i + 1}/${fileList.length} 个文件:`, fileInfo);
      
      try {
        // 检查文件是否已存在于数据库
        const existingRecord = await db.collection('images')
          .where({
            fileID: fileInfo.fileID
          })
          .get();
        
        if (existingRecord.data.length > 0) {
          console.log(`ℹ️ 文件已存在数据库，跳过: ${fileInfo.fileID}`);
          results.push({
            success: true,
            fileID: fileInfo.fileID,
            action: 'skipped',
            message: '文件已存在数据库'
          });
          continue;
        }
        
        // 从文件名提取信息
        const filename = fileInfo.fileID.split('/').pop();
        const category = fileInfo.fileID.includes('bg_image') ? 'daily_poker' : 'other';
        
        // 创建数据库记录
        const dbResult = await db.collection('images').add({
          data: {
            _openid: 'system',                    // 系统标识
            fileID: fileInfo.fileID,              // 云存储文件ID
            filename: filename,                   // 文件名
            category: category,                   // 图片分类
            description: '冥想日签扑克图片',      // 图片描述
            uploadTime: new Date(),               // 上传时间
            size: fileInfo.size || 0,             // 文件大小
            status: 'active'                      // 状态
          }
        });
        
        console.log(`✅ 文件记录成功: ${fileInfo.fileID}`);
        
        results.push({
          success: true,
          fileID: fileInfo.fileID,
          dbRecordId: dbResult._id,
          action: 'created',
          message: '图片记录到数据库成功'
        });
        
      } catch (fileError) {
        console.error(`❌ 处理文件失败: ${fileInfo.fileID}`, fileError);
        
        results.push({
          success: false,
          fileID: fileInfo.fileID,
          action: 'failed',
          error: fileError.message,
          message: `处理文件失败: ${fileError.message}`
        });
      }
      
      // 添加延迟避免请求过快
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // 统计结果
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    
    console.log(`📊 处理完成: ${successCount}/${totalCount} 成功`);
    
    return {
      success: successCount > 0,
      total: totalCount,
      successCount: successCount,
      results: results
    };
    
  } catch (error) {
    console.error('❌ 批量记录图片失败:', error);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
};

/**
 * 获取云存储中的图片文件列表
 * @param {string} prefix - 文件路径前缀
 * @returns {Array} 文件列表
 */
const getCloudStorageFiles = async (prefix = 'bg_image/') => {
  try {
    console.log('🔍 获取云存储文件列表...');
    
    // 获取文件列表（需要先上传云函数）
    // 这里使用一个简化的实现，在实际使用时需要完整的云存储API
    
    // 由于云存储列表API比较复杂，这里返回一个示例
    // 在实际使用中，您需要提供具体的文件列表
    
    return {
      success: true,
      message: '请在event参数中提供文件列表',
      sample: [
        {
          fileID: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/m1.png',
          size: 102400
        }
      ]
    };
    
  } catch (error) {
    console.error('❌ 获取云存储文件失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * 手动添加单个图片记录
 * @param {Object} imageInfo - 图片信息
 * @returns {Object} 添加结果
 */
const addSingleImageRecord = async (imageInfo) => {
  try {
    console.log('➕ 手动添加单个图片记录...');
    
    const { fileID, filename, category = 'daily_poker', description = '冥想日签扑克图片' } = imageInfo;
    
    // 检查是否已存在
    const existingRecord = await db.collection('images')
      .where({ fileID: fileID })
      .get();
    
    if (existingRecord.data.length > 0) {
      console.log('ℹ️ 图片记录已存在');
      return {
        success: true,
        action: 'exists',
        record: existingRecord.data[0],
        message: '图片记录已存在'
      };
    }
    
    // 创建新记录
    const dbResult = await db.collection('images').add({
      data: {
        _openid: 'system',
        fileID: fileID,
        filename: filename || fileID.split('/').pop(),
        category: category,
        description: description,
        uploadTime: new Date(),
        size: imageInfo.size || 0,
        status: 'active'
      }
    });
    
    console.log('✅ 单个图片记录添加成功');
    
    return {
      success: true,
      action: 'created',
      dbRecordId: dbResult._id,
      message: '图片记录添加成功'
    };
    
  } catch (error) {
    console.error('❌ 添加单个图片记录失败:', error);
    return {
      success: false,
      error: error.message,
      message: `添加图片记录失败: ${error.message}`
    };
  }
};

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('🎯 云函数 recordUploadedImages 被调用');
  console.log('📋 事件参数:', event);
  
  const { action, fileList, imageInfo } = event;
  
  try {
    switch (action) {
      case 'recordImages':
        // 批量记录已上传的图片
        if (!fileList || !Array.isArray(fileList)) {
          return {
            success: false,
            error: 'fileList参数必须为数组',
            message: '请提供fileList参数，包含需要记录的图片信息'
          };
        }
        return await recordImagesToDatabase(fileList);
        
      case 'addSingleImage':
        // 手动添加单个图片记录
        if (!imageInfo || !imageInfo.fileID) {
          return {
            success: false,
            error: 'imageInfo参数必须包含fileID',
            message: '请提供imageInfo参数，包含fileID字段'
          };
        }
        return await addSingleImageRecord(imageInfo);
        
      case 'getFileList':
        // 获取云存储文件列表（示例）
        return await getCloudStorageFiles();
        
      default:
        return {
          success: false,
          error: '未知的action参数',
          message: '请提供有效的action参数: recordImages, addSingleImage, getFileList',
          supportedActions: ['recordImages', 'addSingleImage', 'getFileList']
        };
    }
    
  } catch (error) {
    console.error('❌ 云函数执行失败:', error);
    return {
      success: false,
      error: error.message,
      message: `云函数执行失败: ${error.message}`
    };
  }
};