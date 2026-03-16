// pages/team/team.js
const teamManager = require('../../utils/teamManager.js');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 我创建的团队列表
    myTeams: [],
    // 我加入的团队列表
    joinedTeams: [],
    // 加载状态
    isLoading: false,
    // 当前选中的标签
    currentTab: 'created', // created: 我创建的, joined: 我加入的
    // 用户信息
    userNickname: '匿名用户',
    hasUserInfo: false
  },

  /**
   * 创建新团队按钮点击事件
   */
  createNewTeam: function() {
    wx.navigateTo({
      url: '/subpackages/team/pages/createTeam/createTeam'
    })
  },

  /**
   * 切换标签页
   */
  switchTab: function(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      currentTab: tab
    });
  },

  /**
   * 查看团队详情
   */
  viewTeamDetail: function(e) {
    const teamId = e.currentTarget.dataset.teamId;
    console.log('查看团队详情:', teamId);
    
    // 跳转到团队详情页面
    wx.navigateTo({
      url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${teamId}`
    });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('=== team页面加载 ===');
    
    // 获取用户信息
    this.getUserInfo();
    
    // 加载团队数据
    this.loadTeamData();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    console.log('=== team页面显示 ===');
    
    // 刷新团队数据
    this.loadTeamData();
  },

  /**
   * 获取用户信息
   */
  getUserInfo() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const userNickname = wx.getStorageSync('userNickname');
      
      if (userInfo || userNickname) {
        const nickname = userNickname || (userInfo && userInfo.nickName) || '匿名用户';
        this.setData({
          userNickname: nickname,
          hasUserInfo: true
        });
        console.log('✅ 获取到用户信息:', nickname);
      }
    } catch (error) {
      console.error('获取用户信息失败:', error);
    }
  },

  /**
   * 加载团队数据
   * @param {boolean} fromCloud 是否从云端加载数据，默认true
   */
  async loadTeamData(fromCloud = true) {
    if (this.data.isLoading) return;
    
    this.setData({ isLoading: true });
    
    try {
      console.log('开始加载团队数据，从云端:', fromCloud);
      
      if (fromCloud) {
        // 从云端加载团队数据
        await teamManager.loadTeamsFromCloud();
      }
      
      // 从本地缓存获取团队数据
      const myTeams = teamManager.getMyTeams();
      const joinedTeams = teamManager.getJoinedTeams();
      
      console.log('团队数据加载完成:', {
        myTeams: myTeams.length,
        joinedTeams: joinedTeams.length
      });
      
      this.setData({
        myTeams: myTeams,
        joinedTeams: joinedTeams,
        isLoading: false
      });
      
    } catch (error) {
      console.error('加载团队数据失败:', error);
      this.setData({ isLoading: false });
      
      wx.showToast({
        title: '加载团队数据失败',
        icon: 'none'
      });
    }
  },

  /**
   * 删除团队
   */
  async deleteTeam(e) {
    const teamId = e.currentTarget.dataset.teamId;
    const teamName = e.currentTarget.dataset.teamName;
    
    // 确认删除
    wx.showModal({
      title: '确认删除',
      content: `确定要删除团队"${teamName}"吗？此操作将同时删除本地和云端数据，且不可恢复。`,
      confirmText: '确认删除',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          try {
            // 显示加载中
            wx.showLoading({
              title: '删除中...',
              mask: true
            });
            
            // 调用teamManager删除团队
            const result = await teamManager.deleteTeam(teamId);
            
            if (result.success) {
              console.log('✅ 团队删除成功:', teamName);
              
              // 刷新团队数据（不从云端加载，避免覆盖本地删除）
              await this.loadTeamData(false);
              
              wx.showToast({
                title: '团队删除成功',
                icon: 'success',
                duration: 2000
              });
            } else {
              throw new Error(result.error || '删除失败');
            }
            
          } catch (error) {
            console.error('❌ 删除团队失败:', error);
            wx.showToast({
              title: error.message || '删除失败',
              icon: 'none'
            });
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  },

  /**
   * 团队创建成功回调
   */
  onTeamCreated: function(team) {
    console.log('团队创建成功回调:', team);
    
    // 刷新团队数据
    this.loadTeamData();
    
    wx.showToast({
      title: `${team.name} 创建成功`,
      icon: 'success'
    });
  },

  /**
   * 页面显示时刷新数据
   */
  onShow() {
    // 当从成功页面返回时，刷新团队数据
    this.loadTeamData();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

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