// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// 云函数入口函数
exports.main = async (event, context) => {
  try {
    // 获取云存储中bg_image目录下的所有文件
    const result = await cloud.getTempFileURL({
      fileList: [
        {
          fileID: 'cloud://wx256002217162c2b4.7778-wx256002217162c2b4-1315734428/bg_image/bg1.jpg',
          maxAge: 60 * 60, // 临时链接有效期1小时
        },
        {
          fileID: 'cloud://wx256002217162c2b4.7778-wx256002217162c2b4-1315734428/bg_image/bg2.jpg',
          maxAge: 60 * 60,
        },
        {
          fileID: 'cloud://wx256002217162c2b4.7778-wx256002217162c2b4-1315734428/bg_image/bg3.jpg',
          maxAge: 60 * 60,
        }
      ]
    })

    // 提取有效的文件链接
    const availableImages = result.fileList
      .filter(file => file.status === 0)
      .map(file => ({
        fileID: file.fileID,
        tempFileURL: file.tempFileURL
      }))

    return {
      success: true,
      data: availableImages,
      message: '获取背景图片列表成功'
    }
  } catch (error) {
    console.error('获取背景图片失败:', error)
    return {
      success: false,
      data: [],
      message: '获取背景图片失败'
    }
  }
}