// pages/badge/badge.js
const badgeManager = require('../../utils/badgeManager');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    totalUnlockedCount: 0, // 已解锁勋章总数
    badgeCategories: [], // 按分类分组的勋章数据
    hasBadges: false // 是否有勋章
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this.loadBadgeData();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 加载勋章数据
   */
  async loadBadgeData() {
    try {
      // 尝试从云端同步勋章数据
      await badgeManager.loadBadgesFromCloud();
      
      // 获取当前用户统计数据
      const userStats = await this.getUserStatistics();
      
      // 检查用户数据是否符合勋章解锁条件
      const hasUnlocked = badgeManager.checkBadgeUnlock(userStats);
      
      if (hasUnlocked) {
        console.log('🎉 检测到新勋章解锁');
      }
      
      // 更新页面数据
      this.updateBadgeDisplay();
      
    } catch (error) {
      console.error('加载勋章数据失败:', error);
      // 降级处理：只使用本地数据
      this.updateBadgeDisplay();
    }
  },

  /**
   * 获取用户统计数据
   */
  async getUserStatistics() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        return { currentStreak: 0, totalCheckinDays: 0, lastDuration: 0, totalDuration: 0 };
      }

      const result = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'getUserStats',
          openid: openid
        }
      });

      if (result.result && result.result.success) {
        const stats = result.result.data;
        return {
          currentStreak: stats.currentStreak || 0,
          totalCheckinDays: stats.totalCheckinDays || 0,
          lastDuration: stats.lastCheckinDuration || 0,
          totalDuration: stats.totalDuration || 0
        };
      }
    } catch (error) {
      console.error('获取用户统计数据失败:', error);
    }
    
    return { currentStreak: 0, totalCheckinDays: 0, lastDuration: 0, totalDuration: 0 };
  },

  /**
   * 更新勋章显示
   */
  updateBadgeDisplay() {
    const badgeCategories = badgeManager.getBadgesGroupedByCategory();
    const totalUnlockedCount = badgeManager.getUnlockedCount();
    const hasBadges = totalUnlockedCount > 0;
    
    this.setData({
      totalUnlockedCount: totalUnlockedCount,
      badgeCategories: badgeCategories,
      hasBadges: hasBadges
    });
    
    console.log('勋章页面数据渲染完成:', {
      分类数量: badgeCategories.length,
      已解锁勋章总数: totalUnlockedCount,
      各分类情况: badgeCategories.map(cat => ({
        分类: cat.name,
        已解锁: cat.unlockedCount,
        总计: cat.totalCount,
        勋章: cat.badges.map(b => b.name)
      }))
    });
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时重新加载数据
    this.loadBadgeData();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})