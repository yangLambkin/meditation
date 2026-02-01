/**
 * 简化版背景图片管理器
 * 直接使用云存储文件ID，在小程序端转换为临时URL
 */

class SimpleBackgroundManager {
  constructor() {
    this.localCacheKey = 'backgroundCache';
    this.cacheExpiry = 12 * 60 * 60 * 1000; // 12小时缓存
    this.backgroundImages = [
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg1.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg2.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg3.jpeg'
    ];
  }

  /**
   * 获取随机背景图片
   */
  async getRandomBackground() {
    try {
      // 检查缓存
      const cached = this.getFromCache();
      if (cached) {
        console.log('💾 使用缓存的背景图片');
        return cached;
      }

      // 随机选择一张图片
      const randomIndex = Math.floor(Math.random() * this.backgroundImages.length);
      const selectedImage = this.backgroundImages[randomIndex];

      // 将云存储文件ID转换为临时URL
      const tempUrl = await this.getTempFileURL(selectedImage);

      // 缓存结果
      this.saveToCache(tempUrl);

      console.log('🎯 使用随机背景图片:', tempUrl);
      return tempUrl;

    } catch (error) {
      console.error('❌ 获取背景图片失败:', error);
      return '/images/bg1.jpeg'; // 默认图片
    }
  }

  /**
   * 获取云存储文件的临时URL
   */
  async getTempFileURL(fileID) {
    return new Promise((resolve, reject) => {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: (res) => {
          if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
            resolve(res.fileList[0].tempFileURL);
          } else {
            reject(new Error('获取临时URL失败'));
          }
        },
        fail: (err) => {
          reject(err);
        }
      });
    });
  }

  /**
   * 从本地缓存获取背景图片
   */
  getFromCache() {
    try {
      const cache = wx.getStorageSync(this.localCacheKey);
      if (cache && cache.timestamp) {
        const isExpired = Date.now() - cache.timestamp > this.cacheExpiry;
        if (!isExpired && cache.imageUrl) {
          return cache.imageUrl;
        }
      }
    } catch (error) {
      console.warn('⚠️ 读取缓存失败:', error);
    }
    return null;
  }

  /**
   * 保存背景图片到本地缓存
   */
  saveToCache(imageUrl) {
    try {
      wx.setStorageSync(this.localCacheKey, {
        imageUrl: imageUrl,
        timestamp: Date.now()
      });
    } catch (error) {
      console.warn('⚠️ 保存缓存失败:', error);
    }
  }

  /**
   * 手动刷新缓存
   */
  refreshCache() {
    try {
      wx.removeStorageSync(this.localCacheKey);
      console.log('🔄 背景图片缓存已刷新');
    } catch (error) {
      console.error('❌ 刷新缓存失败:', error);
    }
  }
}

// 创建单例实例
const simpleBackgroundManager = new SimpleBackgroundManager();

module.exports = simpleBackgroundManager;