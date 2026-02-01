/**
 * 背景图片管理器（简化版）
 * 支持云端图片库的随机选择
 */

// 背景图片管理器类
class BackgroundManager {
  constructor() {
    this.localCacheKey = 'backgroundCache';
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24小时缓存
  }

  /**
   * 获取随机背景图片URL
   */
  async getRandomBackground() {
    try {
      // 1. 检查本地缓存
      const cached = this.getFromCache();
      if (cached) {
        console.log('💾 使用缓存的背景图片');
        return cached;
      }

      // 2. 获取云存储图片列表
      const imageList = await this.getCloudImageList();
      
      if (!imageList || imageList.length === 0) {
        console.warn('⚠️ 云存储无背景图片，使用默认图片');
        return this.getDefaultBackground();
      }

      // 3. 随机选择一张图片
      const randomIndex = Math.floor(Math.random() * imageList.length);
      const selectedImage = imageList[randomIndex];

      // 4. 缓存结果
      this.saveToCache(selectedImage);

      console.log('🎯 使用云端随机背景图片:', selectedImage);
      return selectedImage;

    } catch (error) {
      console.error('❌ 获取背景图片失败:', error);
      return this.getDefaultBackground();
    }
  }

  /**
   * 获取云存储中的背景图片列表
   */
  async getCloudImageList() {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'getBackgroundImages',
        success: (res) => {
          if (res.result.success && res.result.data.images.length > 0) {
            console.log('✅ 获取云端图片列表成功，数量:', res.result.data.images.length);
            resolve(res.result.data.images);
          } else {
            console.warn('⚠️ 云端图片列表为空，使用默认列表');
            resolve(this.getDefaultImageList());
          }
        },
        fail: (err) => {
          console.error('❌ 调用云函数失败:', err);
          console.warn('🔄 使用默认图片列表作为降级处理');
          resolve(this.getDefaultImageList());
        }
      });
    });
  }

  /**
   * 获取默认图片列表（用于降级处理）
   */
  getDefaultImageList() {
    return [
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg1.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg2.jpeg',
      'cloud://cloud1-5gct1c7e403a6c31.636c-cloud1-5gct1c7e403a6c31-1325724070/bg_image/bg3.jpeg'
    ];
  }

  /**
   * 获取默认背景图片
   */
  getDefaultBackground() {
    return '/images/bg1.jpeg';
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

  /**
   * 获取当前缓存状态
   */
  getCacheStatus() {
    const cache = this.getFromCache();
    return {
      hasCache: !!cache,
      imageUrl: cache || '无缓存',
      timestamp: cache ? new Date(wx.getStorageSync(this.localCacheKey).timestamp).toLocaleString() : '无'
    };
  }
}

// 创建单例实例
const backgroundManager = new BackgroundManager();

module.exports = backgroundManager;