// subpackages/team/pages/teamDetails/teamDetails.js
const teamManager = require('../../../../utils/teamManager.js');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    teamId: '',
    teamInfo: null,
    isLoading: false,
    members: [],
    activities: [],
    currentTab: 'members' // 默认显示团队成员
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const teamId = options.teamId;
    console.log('团队详情页面加载，团队ID:', teamId);
    
    if (teamId) {
      this.setData({
        teamId: teamId
      });
      this.loadTeamData();
    } else {
      wx.showToast({
        title: '团队信息错误',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  /**
   * 加载团队数据（本地优先，云端备份）
   */
  async loadTeamData() {
    if (this.data.isLoading) return;
    
    this.setData({ isLoading: true });
    
    try {
      console.log('开始加载团队详情数据...');
      
      let teamInfo = null;
      
      // 1. 优先从本地缓存读取
      const allTeams = teamManager.loadTeamsFromStorage();
      teamInfo = allTeams.find(team => team._id === this.data.teamId);
      
      if (teamInfo) {
        console.log('✅ 从本地缓存加载团队信息成功');
      } else {
        console.log('⚠️ 本地缓存未找到团队信息，尝试从云端加载...');
        
        // 2. 本地缓存不存在，从云端加载
        teamInfo = await this.loadTeamFromCloud();
        
        if (teamInfo) {
          console.log('✅ 从云端加载团队信息成功');
        } else {
          throw new Error('团队信息不存在');
        }
      }
      
      // 3. 设置页面标题
      wx.setNavigationBarTitle({
        title: teamInfo.name
      });
      
      // 4. 加载成员信息（优先从本地，不足时从云端补充）
      const members = await this.loadTeamMembers(teamInfo);
      
      // 5. 加载练习动态数据
      const activities = await this.loadTeamActivities(teamInfo);
      
      this.setData({
        teamInfo: teamInfo,
        members: members,
        activities: activities,
        isLoading: false
      });
      
      // 5. 异步更新云端数据（确保数据同步）
      this.syncTeamData(teamInfo).catch(error => {
        console.warn('云端同步失败，不影响本地使用:', error);
      });
      
    } catch (error) {
      console.error('加载团队详情失败:', error);
      this.setData({ isLoading: false });
      
      wx.showToast({
        title: error.message || '加载失败',
        icon: 'none'
      });
      
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  /**
   * 从云端加载团队信息
   */
  async loadTeamFromCloud() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        throw new Error('用户未登录，无法从云端加载');
      }
      
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getTeamInfo',
          data: {
            teamId: this.data.teamId
          }
        }
      });
      
      if (result.result && result.result.success) {
        return result.result.data;
      } else {
        throw new Error(result.result?.error || '从云端加载失败');
      }
    } catch (error) {
      console.error('从云端加载团队信息失败:', error);
      return null;
    }
  },

  /**
   * 加载团队成员信息
   */
  async loadTeamMembers(teamInfo) {
    try {
      // 优先从本地缓存读取成员信息
      const localMembers = this.getLocalMembers(teamInfo);
      
      if (localMembers.length > 0) {
        console.log('✅ 从本地缓存加载成员信息成功:', localMembers.length);
        return localMembers;
      }
      
      // 本地缓存不存在，尝试从云端加载
      console.log('⚠️ 本地缓存未找到成员信息，尝试从云端加载...');
      const cloudMembers = await this.getCloudMembers(teamInfo);
      
      if (cloudMembers.length > 0) {
        console.log('✅ 从云端加载成员信息成功:', cloudMembers.length);
        return cloudMembers;
      }
      
      // 云端也没有，返回模拟数据
      console.log('⚠️ 云端未找到成员信息，使用模拟数据');
      return this.generateMockMembers(teamInfo);
      
    } catch (error) {
      console.error('加载成员信息失败，使用模拟数据:', error);
      return this.generateMockMembers(teamInfo);
    }
  },

  /**
   * 获取本地缓存中的成员信息
   */
  getLocalMembers(teamInfo) {
    // 这里可以扩展为从本地缓存读取更详细的成员信息
    // 目前暂时返回空数组，强制从云端加载
    return [];
  },

  /**
   * 从云端获取成员信息
   */
  async getCloudMembers(teamInfo) {
    try {
      // 如果团队信息中已经有成员数据，直接使用
      if (teamInfo.members && Array.isArray(teamInfo.members)) {
        // 转换云端成员数据格式
        return teamInfo.members.map((member, index) => ({
          id: `member_${index + 1}`,
          name: member.nickname || `成员${index + 1}`,
          role: member.isCreator ? '团长' : '成员',
          avatar: member.avatarUrl || ['👩', '👨', '👧', '👦'][index % 4],
          checkInCount: Math.floor(Math.random() * 100) + 10,
          lastActive: '在线'
        }));
      }
      
      return [];
    } catch (error) {
      console.error('从云端获取成员信息失败:', error);
      return [];
    }
  },

  /**
   * 同步团队数据到云端
   */
  async syncTeamData(teamInfo) {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return;
      
      // 检查是否需要同步到云端
      if (!teamInfo.cloudId) {
        console.log('团队没有云端ID，尝试同步到云端...');
        
        const result = await wx.cloud.callFunction({
          name: 'teamManager',
          data: {
            type: 'createTeam',
            data: teamInfo,
            openid: openid
          }
        });
        
        if (result.result && result.result.success) {
          console.log('✅ 团队数据同步到云端成功');
        }
      }
    } catch (error) {
      console.warn('团队数据同步到云端失败:', error);
    }
  },

  /**
   * 生成模拟成员数据
   */
  generateMockMembers(teamInfo) {
    const members = [];
    
    // 添加创建者
    members.push({
      id: 'member_1',
      name: teamInfo.creatorName || '团队创建者',
      role: '团长',
      avatar: '👨',
      checkInCount: Math.floor(Math.random() * 100) + 30,
      lastActive: '刚刚在线'
    });
    
    // 添加其他成员
    const mockNames = ['静心者小明', '修行者小红', '觉知者小李', '冥想者小张', '正念者小王'];
    const mockRoles = ['副团长', '管理员', '成员', '成员', '成员'];
    
    for (let i = 0; i < 4; i++) {
      members.push({
        id: `member_${i + 2}`,
        name: mockNames[i] || `成员${i + 1}`,
        role: mockRoles[i] || '成员',
        avatar: ['👩', '👨', '👧', '👦'][i % 4],
        checkInCount: Math.floor(Math.random() * 80) + 10,
        lastActive: `${Math.floor(Math.random() * 60) + 1}分钟前`
      });
    }
    
    return members;
  },

  /**
   * 计算总打卡次数
   */
  calculateTotalCheckins() {
    if (!this.data.members || this.data.members.length === 0) return 0;
    return this.data.members.reduce((total, member) => total + (member.checkInCount || 0), 0);
  },

  /**
   * 计算活跃度
   */
  calculateActivityRate() {
    if (!this.data.members || this.data.members.length === 0) return 0;
    
    // 根据成员打卡次数计算活跃度
    const totalCheckins = this.calculateTotalCheckins();
    const maxCheckins = this.data.members.length * 100; // 假设每人最多打卡100次
    
    if (maxCheckins === 0) return 0;
    
    const rate = Math.round((totalCheckins / maxCheckins) * 100);
    return Math.min(rate, 100); // 确保不超过100%
  },

  /**
   * 邀请成员
   */
  async inviteMember() {
    const teamInfo = this.data.teamInfo;
    if (!teamInfo) {
      wx.showToast({
        title: '团队信息加载失败',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({
      title: '生成邀请中...',
    });

    try {
      // 1. 调用云函数生成邀请链接，让云函数自动获取openid
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'generateInvite',
          data: {
            teamId: teamInfo._id,
            teamName: teamInfo.name,
            inviterName: wx.getStorageSync('userNickname') || '匿名用户'
          }
        }
      });

      if (result.result && result.result.success) {
        const inviteData = result.result.data;
        
        // 2. 使用新的聊天工具打开微信聊天列表
        wx.showModal({
          title: '邀请链接已生成',
          content: `邀请链接：${inviteData.sharePath}\n\n请复制此链接分享给好友`,
          showCancel: false,
          confirmText: '复制链接',
          success: (res) => {
            if (res.confirm) {
              // 复制链接到剪贴板
              wx.setClipboardData({
                data: inviteData.sharePath,
                success: () => {
                  wx.showToast({
                    title: '链接已复制',
                    icon: 'success'
                  });
                  
                  // 记录邀请记录到云端
                  this.recordInviteAction(teamInfo._id, inviteData.inviteId);
                }
              });
            }
          }
        });

      } else {
        throw new Error(result.result?.error || '生成邀请失败');
      }

      wx.hideLoading();

    } catch (error) {
      wx.hideLoading();
      console.error('邀请成员失败:', error);
      wx.showToast({
        title: error.message || '邀请失败',
        icon: 'none'
      });
    }
  },

  /**
   * 降级处理：显示分享链接让用户手动复制
   */
  showInviteLinkFallback(inviteData, teamInfo) {
    wx.showModal({
      title: '邀请链接已生成',
      content: `邀请链接：${inviteData.sharePath}\n\n请复制此链接分享给好友`,
      showCancel: false,
      confirmText: '复制链接',
      success: (res) => {
        if (res.confirm) {
          // 复制链接到剪贴板
          wx.setClipboardData({
            data: inviteData.sharePath,
            success: () => {
              wx.showToast({
                title: '链接已复制',
                icon: 'success'
              });
              
              // 记录邀请记录到云端
              this.recordInviteAction(teamInfo._id, inviteData.inviteId);
            }
          });
        }
      }
    });
  },

  /**
   * 记录邀请行为到云端
   */
  async recordInviteAction(teamId, inviteId) {
    try {
      await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'recordInviteAction',
          data: {
            teamId: teamId,
            inviteId: inviteId,
            inviteTime: new Date().toISOString()
          }
        }
      });
      console.log('✅ 邀请记录已保存到云端');
    } catch (error) {
      console.warn('邀请记录保存失败:', error);
    }
  },

  /**
   * 生成分享信息
   */
  generateShareInfo(teamInfo) {
    return {
      title: `邀请您加入${teamInfo.name}团队`,
      path: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamInfo._id}&teamName=${encodeURIComponent(teamInfo.name)}`,
      imageUrl: teamInfo.icon || '/images/icons/team.png' // 使用团队创建时上传的头像
    };
  },

  /**
   * 查看团队动态
   */
  viewTeamActivity() {
    wx.showToast({
      title: '团队动态功能开发中',
      icon: 'none'
    });
  },

  /**
   * 切换标签页
   */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    console.log('切换标签页:', tab);
    
    this.setData({
      currentTab: tab
    });
  },

  /**
   * 加载团队练习动态
   */
  async loadTeamActivities(teamInfo) {
    try {
      // 模拟练习动态数据
      return this.generateMockActivities(teamInfo);
    } catch (error) {
      console.error('加载练习动态失败:', error);
      return [];
    }
  },

  /**
   * 生成模拟练习动态数据
   */
  generateMockActivities(teamInfo) {
    const activities = [];
    const activityTypes = [
      '完成了今日冥想练习，感受内心平静',
      '分享了一段美妙的修行体验',
      '在静坐中获得了新的领悟',
      '与团队成员一起完成了集体冥想',
      '记录了下今天的修行心得'
    ];
    
    const memberNames = ['小明', '小红', '小李', '小张', '小王'];
    
    for (let i = 0; i < 5; i++) {
      activities.push({
        id: `activity_${i + 1}`,
        memberName: memberNames[i] || `成员${i + 1}`,
        time: `${Math.floor(Math.random() * 60) + 1}分钟前`,
        content: activityTypes[Math.floor(Math.random() * activityTypes.length)],
        likes: Math.floor(Math.random() * 10),
        comments: Math.floor(Math.random() * 5),
        avatar: ['👩', '👨', '👧', '👦'][i % 4]
      });
    }
    
    return activities;
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时刷新数据
    if (this.data.teamId) {
      this.loadTeamData();
    }
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

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