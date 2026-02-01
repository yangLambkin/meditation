// 测试背景图片功能
const backgroundManager = require('../../utils/backgroundManager.js');

Page({
  data: {
    testResults: [],
    cacheStatus: {},
    currentImage: '',
    loading: false
  },

  onLoad() {
    this.log('🔍 开始测试背景图片功能...');
    this.testBackgroundManager();
  },

  /**
   * 测试背景图片管理器
   */
  async testBackgroundManager() {
    this.setData({ loading: true });
    
    try {
      // 1. 测试获取随机背景图片
      this.log('🚀 测试获取随机背景图片...');
      const imageUrl = await backgroundManager.getRandomBackground();
      this.setData({ currentImage: imageUrl });
      this.log('✅ 获取背景图片成功:', imageUrl);

      // 2. 测试缓存状态
      this.log('📊 测试缓存状态...');
      const cacheStatus = backgroundManager.getCacheStatus();
      this.setData({ cacheStatus: cacheStatus });
      this.log('✅ 缓存状态:', JSON.stringify(cacheStatus));

      // 3. 测试手动刷新缓存
      this.log('🔄 测试刷新缓存...');
      backgroundManager.refreshCache();
      
      // 等待缓存刷新完成
      setTimeout(() => {
        const newCacheStatus = backgroundManager.getCacheStatus();
        this.log('✅ 刷新后缓存状态:', JSON.stringify(newCacheStatus));
        
        // 4. 测试多次获取（验证随机性和缓存）
        this.testMultipleGets();
      }, 1000);

    } catch (error) {
      this.log('❌ 测试失败:', error.message);
      this.setData({ loading: false });
    }
  },

  /**
   * 测试多次获取背景图片
   */
  async testMultipleGets() {
    this.log('🎲 测试多次获取背景图片（验证随机性）...');
    
    const results = [];
    
    for (let i = 0; i < 3; i++) {
      const imageUrl = await backgroundManager.getRandomBackground();
      results.push({
        attempt: i + 1,
        imageUrl: imageUrl,
        timestamp: new Date().toLocaleTimeString()
      });
      this.log(`✅ 第${i + 1}次获取: ${imageUrl}`);
      
      // 短暂延迟，模拟正常使用间隔
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    this.log('📈 多次获取结果分析:', JSON.stringify(results));
    this.setData({ loading: false });
  },

  /**
   * 手动刷新缓存
   */
  refreshCache() {
    this.log('🔄 手动刷新缓存...');
    backgroundManager.refreshCache();
    
    setTimeout(() => {
      const newCacheStatus = backgroundManager.getCacheStatus();
      this.setData({ cacheStatus: newCacheStatus });
      this.log('✅ 缓存已刷新，新状态:', JSON.stringify(newCacheStatus));
    }, 500);
  },

  /**
   * 获取新的随机图片
   */
  async getNewRandomImage() {
    this.setData({ loading: true });
    
    try {
      const imageUrl = await backgroundManager.getRandomBackground();
      this.setData({ 
        currentImage: imageUrl,
        loading: false 
      });
      this.log('🎯 新图片获取成功:', imageUrl);
    } catch (error) {
      this.log('❌ 获取新图片失败:', error.message);
      this.setData({ loading: false });
    }
  },

  /**
   * 日志记录
   */
  log(message) {
    console.log(message);
    const timestamp = new Date().toLocaleTimeString();
    this.data.testResults.unshift(`[${timestamp}] ${message}`);
    this.setData({ testResults: this.data.testResults.slice(0, 20) }); // 限制显示数量
  }
});