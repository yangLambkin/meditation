/**
 * 背景图片管理器
 * 支持云端图片库的可扩展管理和性能优化
 */

// 背景图片管理器类
class BackgroundManager {
  constructor() {
    this.cloudStoragePath = 'bg_image/'; // 云存储背景图片路径
    this.localCacheKey = 'backgroundCache'; // 本地缓存键
    this.imageListCacheKey = 'backgroundListCache'; // 图片列表缓存键
    this.cacheExpiry = 12 * 60 * 60 * 1000; // 缓存有效期：12小时
    this.imageListExpiry = 6 * 60 * 60 * 1000; // 图片列表缓存有效期：6小时
    this.preloadQueue = []; // 预加载队列
    this.maxPreloadCount = 3; // 最大预加载数量
  }

  /**
   * 获取随机背景图片URL
   * 支持多级缓存和性能优化
   */
  async getRandomBackground() {
    try {
      // 1. 检查本地缓存（优先使用缓存）
      const cached = this.getFromCache();
      if (cached) {
        console.log('💾 使用缓存的背景图片');
        
        // 异步预加载其他图片，为下次使用做准备
        this.asyncPreloadOtherImages();
        
        return cached;
      }

      // 2. 获取云存储图片列表（使用缓存策略）
      const imageList = await this.getCloudImageList();
      
      if (!imageList || imageList.length === 0) {
        console.warn('⚠️ 云存储无背景图片，使用默认图片');
        return this.getDefaultBackground();
      }

      // 3. 智能随机选择（避免连续重复）
      const selectedImage = this.selectRandomImage(imageList);

      // 4. 多级预加载策略
      this.smartPreload(imageList, selectedImage);

      // 5. 缓存结果
      this.saveToCache(selectedImage);

      console.log('🎯 使用云端随机背景图片:', selectedImage);
      return selectedImage;

    } catch (error) {
      console.error('❌ 获取背景图片失败:', error);
      return this.getDefaultBackground();
    }
  }

  /**
   * 智能随机选择图片（避免连续重复）
   */
  selectRandomImage(imageList) {
    const lastUsed = this.getLastUsedImage();
    const availableImages = imageList.filter(img => img !== lastUsed);
    
    // 如果所有图片都相同或只有一张图片，直接随机选择
    const sourceList = availableImages.length > 0 ? availableImages : imageList;
    
    const randomIndex = Math.floor(Math.random() * sourceList.length);
    const selectedImage = sourceList[randomIndex];
    
    // 记录本次使用的图片
    this.setLastUsedImage(selectedImage);
    
    return selectedImage;
  }

  /**
   * 智能预加载策略
   */
  smartPreload(imageList, currentImage) {
    // 1. 立即预加载当前图片
    this.preloadImage(currentImage);
    
    // 2. 异步预加载其他图片（限制数量）
    const otherImages = imageList.filter(img => img !== currentImage);
    const preloadImages = otherImages.slice(0, this.maxPreloadCount);
    
    preloadImages.forEach((image, index) => {
      setTimeout(() => {
        this.preloadImage(image);
      }, index * 500); // 分批预加载，避免网络阻塞
    });
  }

  /**
   * 异步预加载其他图片
   */
  asyncPreloadOtherImages() {
    setTimeout(async () => {
      try {
        const imageList = await this.getCloudImageList();
        if (imageList && imageList.length > 1) {
          const randomImages = this.getRandomImages(imageList, this.maxPreloadCount);
          randomImages.forEach((image, index) => {
            setTimeout(() => {
              this.preloadImage(image);
            }, index * 300);
          });
        }
      } catch (error) {
        console.warn('⚠️ 异步预加载失败:', error);
      }
    }, 1000); // 延迟1秒执行，避免影响当前页面加载
  }

  /**
   * 获取随机图片数组
   */
  getRandomImages(imageList, count) {
    const shuffled = [...imageList].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  /**
   * 获取云存储中的背景图片列表（支持缓存）
   */
  async getCloudImageList() {
    // 1. 检查图片列表缓存
    const cachedList = this.getImageListFromCache();
    if (cachedList) {
      console.log('💾 使用缓存的图片列表，数量:', cachedList.length);
      return cachedList;
    }

    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'getBackgroundImages',
        success: (res) => {
          if (res.result.success && res.result.data.images.length > 0) {
            console.log('✅ 获取云端图片列表成功，数量:', res.result.data.images.length);
            
            // 缓存图片列表
            this.saveImageListToCache(res.result.data.images);
            
            resolve(res.result.data.images);
          } else {
            console.warn('⚠️ 云端图片列表为空，使用默认列表');
            
            // 缓存默认列表
            const defaultList = this.getDefaultImageList();
            this.saveImageListToCache(defaultList);
            
            resolve(defaultList);
          }
        },
        fail: (err) => {
          console.error('❌ 调用云函数失败:', err);
          console.warn('🔄 使用默认图片列表作为降级处理');
          
          // 缓存默认列表
          const defaultList = this.getDefaultImageList();
          this.saveImageListToCache(defaultList);
          
          resolve(defaultList);
        }
      });
    });
  }

  /**
   * 获取默认图片列表（用于演示和降级处理）
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
   * 获取最后使用的图片
   */
  getLastUsedImage() {
    try {
      return wx.getStorageSync('lastBackgroundImage') || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 设置最后使用的图片
   */
  setLastUsedImage(imageUrl) {
    try {
      wx.setStorageSync('lastBackgroundImage', imageUrl);
    } catch (error) {
      console.warn('⚠️ 保存最后使用图片失败:', error);
    }
  }

  /**
   * 获取图片列表缓存
   */
  getImageListFromCache() {
    try {
      const cache = wx.getStorageSync(this.imageListCacheKey);
      if (cache && cache.timestamp) {
        const isExpired = Date.now() - cache.timestamp > this.imageListExpiry;
        if (!isExpired && cache.imageList && cache.imageList.length > 0) {
          return cache.imageList;
        }
      }
    } catch (error) {
      console.warn('⚠️ 读取图片列表缓存失败:', error);
    }
    return null;
  }

  /**
   * 保存图片列表到缓存
   */
  saveImageListToCache(imageList) {
    try {
      wx.setStorageSync(this.imageListCacheKey, {
        imageList: imageList,
        timestamp: Date.now()
      });
    } catch (error) {
      console.warn('⚠️ 保存图片列表缓存失败:', error);
    }
  }

  /**
   * 预加载图片，提升用户体验（支持云存储临时URL）
   */
  preloadImage(imageUrl) {
    // 检查图片URL是否有效
    if (!imageUrl || imageUrl.trim() === '') {
      console.warn('⚠️ 预加载失败：图片URL为空');
      return;
    }
    
    // 如果是本地图片，直接跳过预加载（本地图片无需预加载）
    if (imageUrl.startsWith('/') || imageUrl.startsWith('http://localhost')) {
      console.log('📱 本地图片跳过预加载:', imageUrl);
      return;
    }
    
    // 如果是云存储临时URL（http开头的），直接使用
    if (imageUrl.startsWith('http')) {
      console.log('☁️ 云存储临时URL，直接预加载:', imageUrl);
      wx.getImageInfo({
        src: imageUrl,
        success: () => {
          console.log('🚀 图片预加载成功');
        },
        fail: (err) => {
          console.warn('⚠️ 图片预加载失败:', {
            url: imageUrl,
            error: err.errMsg || err
          });
        }
      });
      return;
    }
    
    // 如果是云存储文件ID（cloud://开头的），需要先获取临时URL
    if (imageUrl.startsWith('cloud://')) {
      console.log('☁️ 云存储文件ID，需要获取临时URL:', imageUrl);
      
      // 跳过预加载，因为使用时会自动获取临时URL
      console.log('⏭️ 跳过云存储文件ID的预加载');
      return;
    }
    
    console.warn('⚠️ 未知图片格式:', imageUrl);
  }

  /**
   * 手动刷新缓存（可用于管理员更新图片库时）
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