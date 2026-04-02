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
    // 所有团队列表（向所有用户开放）
    allTeams: [],
    // 加载状态
    isLoading: false,
    // 当前选中的标签
    currentTab: 'created', // created: 我创建的, joined: 所有团队
    // 用户信息
    userNickname: '匿名用户',
    hasUserInfo: false,
    // 统计数据
    totalJoinedTeams: 0 // 正确的已加入团队数量（包含自建团队，但不重复计算）
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
   * 格式化创建时间
   * @param {string} isoTime ISO时间字符串
   * @returns {string} 格式化的时间 YYYY-MM-DD HH:MM:SS
   */
  formatCreateTime(isoTime) {
    if (!isoTime) return '';
    
    try {
      const date = new Date(isoTime);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch (error) {
      console.error('时间格式化失败:', error);
      return isoTime.split('T')[0] + ' 00:00:00'; // 备用格式
    }
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
   * 从云端获取所有团队数据
   */
  async getAllTeams() {
    try {
      console.log('🔄 从云端获取所有团队数据...');
      
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getAllTeams'
        }
      });
      
      if (result.result && result.result.success) {
        const allTeams = result.result.data.teams || [];
        console.log('✅ 云端所有团队数据获取成功:', {
          团队数量: allTeams.length,
          团队列表: allTeams.map(t => ({name: t.name, id: t._id}))
        });
        return allTeams;
      } else {
        console.warn('⚠️ 云端返回数据格式异常:', result.result);
        return [];
      }
    } catch (error) {
      console.error('❌ 获取所有团队数据失败:', error);
      // 降级处理：返回空数组
      return [];
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
      
      // 调试：检查团队数据中的createdAt字段
      console.log('我创建的团队详情:', myTeams);
      console.log('团队数据详细检查:', {
        teamCount: myTeams.length,
        teams: myTeams.map(team => ({
          name: team.name,
          createdAt: team.createdAt,
          hasCreatedAt: !!team.createdAt,
          allFields: Object.keys(team)
        }))
      });
      
      // 预处理团队数据，格式化创建时间，并添加自建标识
      const formattedMyTeams = myTeams.map(team => ({
        ...team,
        formattedCreateTime: this.formatCreateTime(team.createdAt),
        isSelfCreated: true // 自建团队标识
      }));
      
      const formattedJoinedTeams = joinedTeams.map(team => ({
        ...team,
        formattedCreateTime: this.formatCreateTime(team.createdAt),
        isSelfCreated: team.creator === wx.getStorageSync('userOpenId') // 判断是否为自建团队
      }));
      
      // 加载所有团队数据（向所有用户开放）- 添加容错处理
      let allTeams = [];
      try {
        console.log('🔄 开始加载所有团队数据...');
        allTeams = await this.getAllTeams();
      } catch (error) {
        console.warn('⚠️ 加载所有团队数据失败，使用降级方案:', error);
        // 降级：使用我创建的团队和加入的团队合并作为所有团队
        allTeams = [...myTeams, ...joinedTeams.filter(team => 
          !myTeams.some(myTeam => myTeam._id === team._id)
        )];
      }
      
      const formattedAllTeams = allTeams.map(team => {
        // 修复头像URL：如果使用临时路径，检查本地是否有正确的云存储路径
        let teamIcon = team.icon;
        if (teamIcon && teamIcon.startsWith('http://tmp/')) {
          // 检查本地缓存中是否有正确的头像路径
          const myTeams = teamManager.getMyTeams();
          const joinedTeams = teamManager.getJoinedTeams();
          const allLocalTeams = [...myTeams, ...joinedTeams];
          const localTeam = allLocalTeams.find(t => t._id === team._id);
          
          if (localTeam && localTeam.icon && !localTeam.icon.startsWith('http://tmp/')) {
            teamIcon = localTeam.icon;
            console.log('修复头像路径:', { 原路径: team.icon, 新路径: teamIcon });
          } else {
            // 使用默认头像
            teamIcon = '/images/icons/team.png';
          }
        }
        
        return {
          ...team,
          icon: teamIcon,
          formattedCreateTime: this.formatCreateTime(team.createdAt),
          isSelfCreated: team.creator === wx.getStorageSync('userOpenId') // 判断是否为自建团队
        };
      });
      
      console.log('✅ 团队数据加载完成:', {
        总团队数: formattedAllTeams.length,
        我创建的团队数: formattedMyTeams.length,
        我加入的团队数: formattedJoinedTeams.length
      });
      
      // 计算正确的已加入团队数量（去重计算）
      const totalJoinedTeams = this.calculateTotalJoinedTeams(formattedMyTeams, formattedJoinedTeams);
      
      this.setData({
        myTeams: formattedMyTeams,
        joinedTeams: formattedJoinedTeams,
        allTeams: formattedAllTeams,
        totalJoinedTeams: totalJoinedTeams,
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

  },

  /**
   * 刷新团队数据（供外部调用）
   */
  refreshTeamData() {
    console.log('🔄 刷新团队页面数据');
    this.loadTeamData();
  },

  /**
   * 计算正确的已加入团队数量（避免重复计算）
   */
  calculateTotalJoinedTeams(myTeams, joinedTeams) {
    // 合并所有团队，并去重（基于团队ID）
    const allTeamsMap = new Map();
    
    // 首先添加我创建的团队
    myTeams.forEach(team => {
      allTeamsMap.set(team._id, team);
    });
    
    // 然后添加我加入的团队（不包括已存在的）
    joinedTeams.forEach(team => {
      if (!allTeamsMap.has(team._id)) {
        allTeamsMap.set(team._id, team);
      }
    });
    
    const totalCount = allTeamsMap.size;
    
    console.log('✅ 已加入团队数量计算:', {
      我创建的团队数: myTeams.length,
      我加入的团队数: joinedTeams.length,
      去重后的总数: totalCount
    });
    
    return totalCount;
  }
})