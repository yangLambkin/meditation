/**
 * 简化版背景图片管理器
 * 直接使用云存储文件ID，在小程序端转换为临时URL
 */

class SimpleBackgroundManager {
  constructor() {
    this.localCacheKey = 'backgroundCache';
    this.cacheExpiry = 12 * 60 * 60 * 1000; // 12小时缓存
    this.backgroundFolder = 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/';
    this.backupImages = [
      '/images/bg1.jpeg',
      '/images/bg2.jpeg', 
      '/images/bg3.jpeg'
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

      // 调用云函数获取随机背景图片
      const randomImage = await this.getRandomBackgroundFromCloud();
      
      if (randomImage) {
        // 缓存结果
        this.saveToCache(randomImage);
        console.log('🎯 使用云存储随机背景图片:', randomImage);
        return randomImage;
      } else {
        // 云存储中没有可用图片，使用本地图片
        console.log('🔄 云存储无可用图片，使用本地图片');
        return this.getLocalBackground();
      }

    } catch (error) {
      console.error('❌ 获取云存储背景图片失败，使用本地图片:', error);
      // 云存储失败时，使用本地图片作为降级方案
      return this.getLocalBackground();
    }
  }

  /**
   * 从云函数获取随机背景图片
   */
  async getRandomBackgroundFromCloud() {
    return new Promise((resolve) => {
      // 调用云函数获取随机背景图片
      wx.cloud.callFunction({
        name: 'getBackgroundImages',
        success: (res) => {
          console.log('🔍 云函数返回结果:', res);
          
          if (res.result && res.result.success && res.result.data && res.result.data.fileURL) {
            console.log(`✅ 获取到随机背景图片: ${res.result.data.fileURL}`);
            resolve(res.result.data.fileURL);
          } else {
            console.log('❌ 云函数返回无可用背景图片');
            resolve(null);
          }
        },
        fail: (err) => {
          console.error('❌ 调用云函数失败:', err);
          // 即使云函数失败也返回null，让降级机制生效
          resolve(null);
        }
      });
    });
  }

  /**
   * 获取本地背景图片（降级方案）
   */
  getLocalBackground() {
    const randomIndex = Math.floor(Math.random() * this.backupImages.length);
    return this.backupImages[randomIndex];
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