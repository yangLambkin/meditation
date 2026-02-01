const checkinManager = require('../../utils/checkin.js');

Page({
  data: {
    currentTab: 'daily', // 当前选项卡
    userStats: {}, // 用户统计信息
    dailyRankings: [], // 日榜数据
    monthlyRankings: [], // 月榜数据
    totalRankings: [], // 总榜数据
    loading: false,
    currentDate: '',
    currentMonth: ''
  },

  onLoad: function() {
    this.setCurrentDateInfo();
    this.loadUserStats();
    this.loadRankings('daily');
  },

  // 设置当前日期信息
  setCurrentDateInfo: function() {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    
    this.setData({
      currentDate: `${year}年${month}月${day}日`,
      currentMonth: `${year}年${month}月`
    });
  },

  // 切换选项卡
  switchTab: function(e) {
    const tab = e.currentTarget.dataset.tab;
    if (this.data.currentTab === tab) return;
    
    this.setData({
      currentTab: tab,
      loading: true
    });
    
    this.loadRankings(tab);
  },

  // 加载用户统计信息
  loadUserStats: async function() {
    try {
      const stats = await checkinManager.getUserStats();
      this.setData({
        userStats: stats
      });
    } catch (error) {
      console.error('加载用户统计信息失败:', error);
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  // 加载排行榜数据
  loadRankings: async function(tab) {
    try {
      this.setData({ loading: true });
      
      const rankings = await checkinManager.getRankings(tab);
      
      // 添加排名序号
      const rankingsWithRank = rankings.map((item, index) => ({
        ...item,
        rank: index + 1
      }));

      const dataKey = `${tab}Rankings`;
      this.setData({
        [dataKey]: rankingsWithRank,
        loading: false
      });
      
    } catch (error) {
      console.error(`加载${tab}排行榜失败:`, error);
      this.setData({ loading: false });
      
      // 显示空数据
      const dataKey = `${tab}Rankings`;
      this.setData({
        [dataKey]: []
      });
      
      // 如果是本地存储模式，提示不支持多用户排行榜
      if (!checkinManager.useCloudStorage) {
        wx.showToast({
          title: '本地模式不支持排行榜',
          icon: 'none'
        });
      }
    }
  },

  // 下拉刷新
  onPullDownRefresh: function() {
    this.refreshData();
  },

  // 刷新数据
  refreshData: async function() {
    try {
      await Promise.all([
        this.loadUserStats(),
        this.loadRankings(this.data.currentTab)
      ]);
      
      wx.showToast({
        title: '刷新成功',
        icon: 'success'
      });
      
    } catch (error) {
      console.error('刷新数据失败:', error);
      wx.showToast({
        title: '刷新失败',
        icon: 'none'
      });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  // 分享功能
  onShareAppMessage: function() {
    return {
      title: '静坐觉察 - 统计排行',
      path: '/pages/stats/stats',
      imageUrl: '/images/stats-share.jpg'
    };
  }
});