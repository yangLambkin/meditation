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
    const fromTab = e.currentTarget.dataset.fromTab; // 页面来源：'created' | 'joined' | 'all'
    console.log('查看团队详情:', { teamId, fromTab });
    
    // 跳转到团队详情页面，传递页面来源信息
    wx.navigateTo({
      url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${teamId}&fromTab=${fromTab || 'all'}`
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
    
    // 强制从云端加载团队数据，确保数据最新
    this.loadTeamData(true);
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    console.log('=== team页面显示 ===');
    
    // 每次显示页面时都强制从云端刷新数据
    this.loadTeamData(true);
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
   * 从云端获取所有团队数据（强制刷新版）
   */
  async getAllTeamsFromCloud() {
    try {
      console.log('🚀 强制从云端获取所有团队数据...');
      
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
        
        // 缓存所有团队数据，用于下次快速显示
        wx.setStorageSync('allTeams_cache', allTeams);
        
        return allTeams;
      } else {
        console.warn('⚠️ 云端返回数据格式异常:', result.result);
        // 尝试使用缓存的数据
        const cachedAllTeams = wx.getStorageSync('allTeams_cache') || [];
        console.log('⚠️ 使用缓存的全部团队数据:', cachedAllTeams.length);
        return cachedAllTeams;
      }
    } catch (error) {
      console.error('❌ 获取所有团队数据失败:', error);
      // 尝试使用缓存的数据
      const cachedAllTeams = wx.getStorageSync('allTeams_cache') || [];
      console.log('⚠️ 使用缓存的全部团队数据作为降级:', cachedAllTeams.length);
      return cachedAllTeams;
    }
  },

  /**
   * 加载团队数据
   * @param {boolean} forceCloud 是否强制从云端加载数据，默认true
   */
  async loadTeamData(forceCloud = true) {
    if (this.data.isLoading) return;
    
    this.setData({ isLoading: true });
    
    try {
      console.log('开始加载团队数据，强制从云端:', forceCloud);
      
      // 强制从云端加载最新数据，覆盖本地缓存
      if (forceCloud) {
        console.log('🔄 强制从云端加载最新团队数据...');
        await this.loadTeamsFromCloudAndRefresh();
      }
      
      // 从本地缓存获取团队数据（此时已经是云端最新数据）
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
      
      // 加载所有团队数据（向所有用户开放）- 确保使用云端最新数据
      let allTeams = [];
      try {
        console.log('🔄 开始加载所有团队数据...');
        allTeams = await this.getAllTeamsFromCloud();
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
      
      // 计算去重后的团队列表（用于页面显示）
      const mergedJoinedTeams = this.mergeJoinedTeams(formattedMyTeams, formattedJoinedTeams);
      
      this.setData({
        myTeams: formattedMyTeams,
        joinedTeams: formattedJoinedTeams,
        allTeams: formattedAllTeams,
        totalJoinedTeams: totalJoinedTeams,
        mergedJoinedTeams: mergedJoinedTeams,
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
   * 强制从云端加载团队数据并刷新缓存
   */
  async loadTeamsFromCloudAndRefresh() {
    try {
      console.log('🚀 执行强制云端数据刷新...');
      
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        console.warn('用户未登录，无法从云端加载');
        return;
      }
      
      // 直接从云端获取用户团队数据
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getUserTeams',
          openid: openid
        }
      });
      
      if (result.result && result.result.success) {
        const cloudTeams = result.result.data || [];
        console.log('✅ 云端数据获取成功:', {
          团队数量: cloudTeams.length,
          团队列表: cloudTeams.map(t => ({ name: t.name, id: t._id }))
        });
        
        // 构建新的本地团队数据
        const newTeamData = cloudTeams.map(team => ({
          ...team,
          cloudId: team._id, // 保存云端ID用于后续匹配
          createdAt: team.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isActive: true
        }));
        
        // 完全覆盖本地缓存
        const storageKey = this.getTeamStorageKey();
        wx.setStorageSync(storageKey, newTeamData);
        
        // 更新teamManager实例中的数据
        teamManager.teams = newTeamData;
        
        console.log('✅ 本地缓存已完全刷新为云端最新数据');
        
        // 同时清理已加入团队缓存
        await this.refreshJoinedTeamsFromCloud(cloudTeams);
        
      } else {
        console.error('云端数据获取失败:', result.result);
        throw new Error('获取云端团队数据失败');
      }
      
    } catch (error) {
      console.error('强制云端数据刷新失败:', error);
      throw error;
    }
  },

  /**
   * 刷新已加入团队缓存
   */
  async refreshJoinedTeamsFromCloud(cloudTeams) {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return;
      
      // 过滤用户已加入的团队
      const joinedTeams = cloudTeams.filter(team => 
        team.members && team.members.includes(openid)
      );
      
      const joinedTeamsWithInfo = joinedTeams.map(team => ({
        ...team,
        joinedAt: new Date().toISOString()
      }));
      
      // 保存到已加入团队缓存
      const joinedStorageKey = this.getJoinedTeamsKey();
      wx.setStorageSync(joinedStorageKey, joinedTeamsWithInfo);
      
      console.log('✅ 已加入团队缓存已刷新:', {
        已加入团队数: joinedTeams.length
      });
      
    } catch (error) {
      console.error('刷新已加入团队缓存失败:', error);
    }
  },

  /**
   * 获取团队存储键名
   */
  getTeamStorageKey() {
    const openid = wx.getStorageSync('userOpenId');
    return openid ? `userTeams_${openid}` : 'userTeams_guest';
  },

  /**
   * 获取已加入团队存储键名
   */
  getJoinedTeamsKey() {
    const openid = wx.getStorageSync('userOpenId');
    return openid ? `joinedTeams_${openid}` : 'joinedTeams_guest';
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
  },

  /**
   * 合并去重团队列表（用于页面显示）
   */
  mergeJoinedTeams(myTeams, joinedTeams) {
    // 使用Map去重，基于团队ID
    const teamsMap = new Map();
    
    // 首先添加我创建的团队
    myTeams.forEach(team => {
      teamsMap.set(team._id, {
        ...team,
        isSelfCreated: true // 确保标记为自建
      });
    });
    
    // 然后添加我加入的团队（不包括已存在的自建团队）
    joinedTeams.forEach(team => {
      if (!teamsMap.has(team._id)) {
        teamsMap.set(team._id, {
          ...team,
          isSelfCreated: false // 标记为已加入
        });
      }
    });
    
    const mergedTeams = Array.from(teamsMap.values());
    
    console.log('✅ 团队合并去重结果:', {
      我创建的团队数: myTeams.length,
      我加入的团队数: joinedTeams.length,
      去重后总数: mergedTeams.length
    });
    
    return mergedTeams;
  }
})