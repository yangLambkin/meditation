// subpackages/team/pages/teamDetails/teamDetails.js
const teamManager = require('../../../../utils/teamManager.js');

// 从团队管理器中导入存储键名函数
function getTeamStorageKey() {
  const openid = wx.getStorageSync('userOpenId');
  return openid ? `userTeams_${openid}` : 'userTeams_guest';
}

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
    currentTab: 'members', // 默认显示团队成员
    isCreator: false, // 当前用户是否为团队创建者
    fromTab: 'all' // 页面来源：'created' | 'joined' | 'all'，默认'all'
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const teamId = options.teamId;
    const fromTab = options.fromTab || 'all'; // 页面来源参数
    console.log('团队详情页面加载，团队ID:', teamId, '页面来源:', fromTab);
    
    if (teamId) {
      this.setData({
        teamId: teamId,
        fromTab: fromTab
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
      
      // 1. 优先从云端获取最新信息
      console.log('🚀 优先从云端获取最新团队信息...');
      const cloudTeamInfo = await this.loadTeamFromCloud();
      
      if (cloudTeamInfo) {
        console.log('✅ 从云端获取最新团队信息成功');
        teamInfo = cloudTeamInfo;
        
        // 立即更新本地缓存，确保数据同步
        this.updateLocalTeamCache(cloudTeamInfo);
      } else {
        console.log('⚠️ 云端未找到团队信息，使用本地缓存...');
        
        // 2. 云端不存在，使用本地缓存
        const allTeams = teamManager.loadTeamsFromStorage();
        teamInfo = allTeams.find(team => team._id === this.data.teamId);
        
        if (teamInfo) {
          console.log('✅ 从本地缓存加载团队基础信息成功');
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
      
      // 6. 检查当前用户是否为团队创建者
      const currentOpenid = wx.getStorageSync('userOpenId');
      const isCreator = currentOpenid && teamInfo.creator === currentOpenid;
      
      console.log('👤 权限检查:', {
        currentOpenid: currentOpenid,
        teamCreator: teamInfo.creator,
        isCreator: isCreator,
        teamId: teamInfo._id,
        teamName: teamInfo.name
      });
      
      this.setData({
        teamInfo: teamInfo,
        members: members,
        activities: activities,
        activitiesLoading: false,
        activitiesError: false,
        isLoading: false,
        isCreator: isCreator
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
        console.log('✅ 云端返回团队信息:', result.result.data);
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
   * 更新本地团队缓存
   */
  updateLocalTeamCache(cloudTeamInfo) {
    try {
      const allTeams = teamManager.loadTeamsFromStorage();
      const teamIndex = allTeams.findIndex(team => team._id === cloudTeamInfo._id);
      
      if (teamIndex !== -1) {
        // 更新现有团队信息
        allTeams[teamIndex] = {
          ...allTeams[teamIndex],
          ...cloudTeamInfo, // 用云端数据覆盖本地数据
          updatedAt: new Date().toISOString()
        };
        console.log('✅ 更新本地团队缓存成功');
      } else {
        // 添加新团队信息
        allTeams.push({
          ...cloudTeamInfo,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        console.log('✅ 添加新团队到本地缓存');
      }
      
      // 保存到本地缓存
      const storageKey = getTeamStorageKey();
      wx.setStorageSync(storageKey, allTeams);
      
    } catch (error) {
      console.error('更新本地团队缓存失败:', error);
    }
  },

  /**
   * 获取团队成员打卡数据
   */
  async getTeamMembersCheckinData(members) {
    try {
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getTeamMembersCheckinData',
          data: {
            memberOpenids: members.map(member => member.openid)
          }
        }
      });
      
      if (result.result && result.result.success) {
        console.log('✅ 获取团队成员打卡数据成功:', result.result.data);
        return result.result.data;
      } else {
        throw new Error(result.result?.error || '获取打卡数据失败');
      }
    } catch (error) {
      console.error('获取团队成员打卡数据失败:', error);
      
      // 返回空数据，避免页面报错
      const emptyData = {};
      members.forEach(member => {
        emptyData[member.openid] = { monthlyCount: 0, totalCount: 0 };
      });
      return emptyData;
    }
  },

  /**
   * 加载团队成员信息
   */
  async loadTeamMembers(teamInfo) {
    try {
      console.log('🚀 加载真实团队成员信息...');
      
      // 1. 直接使用团队信息中的真实数据
      const realMembers = await this.getRealTeamMembers(teamInfo);
      
      if (realMembers.length > 0) {
        console.log('✅ 使用真实团队成员数据:', realMembers.length);
        return realMembers;
      }
      
      // 2. 如果没有真实数据，使用团队创建者信息
      console.log('⚠️ 使用团队创建者信息');
      const creatorOnly = this.getCreatorOnlyMember(teamInfo);
      this.saveMembersToStorage(teamInfo._id, creatorOnly);
      return creatorOnly;
      
    } catch (error) {
      console.error('加载成员信息失败，使用创建者信息:', error);
      return this.getCreatorOnlyMember(teamInfo);
    }
  },

  /**
   * 获取真实团队成员数据
   */
  async getRealTeamMembers(teamInfo) {
    try {
      const members = [];
      
      // 1. 检查是否有云端返回的详细成员信息
      if (teamInfo.members && Array.isArray(teamInfo.members)) {
        console.log('✅ 使用云端返回的详细成员信息');
        
        // 获取所有成员的打卡数据
        const memberCheckinData = await this.getTeamMembersCheckinData(teamInfo.members);
        
        // 调试：检查云函数返回的打卡数据
        console.log('📊 云函数返回的打卡数据:', memberCheckinData);
        
        teamInfo.members.forEach((member, index) => {
          // 从云存储获取用户的真实打卡次数
          const userCheckinData = memberCheckinData[member.openid] || { monthlyCount: 0, totalCount: 0 };
          
          // 调试：检查当前成员的打卡数据
          console.log(`👤 成员 ${member.nickname} 的打卡数据:`, userCheckinData);
          
          // 处理头像URL，确保使用永久链接
          let finalAvatar = member.avatarUrl || '/images/avatar.png';
          
          // 如果是临时文件路径，使用默认头像
          if (finalAvatar.startsWith('wxfile://tmp_')) {
            console.log('⚠️ 检测到临时文件头像，使用默认头像');
            finalAvatar = '/images/avatar.png';
          }
          
          // 使用云端返回的成员详细信息（包含头像、昵称等）
          const memberData = {
            id: member.openid || `member_${index}`,
            name: member.nickname || (member.isCreator ? teamInfo.creatorName : '成员'),
            role: member.isCreator ? '团长' : '成员',
            avatar: finalAvatar,
            checkInCount: userCheckinData.monthlyCount, // 使用当月真实打卡次数
            monthlyCount: userCheckinData.monthlyCount, // 同时保存到monthlyCount字段
            totalCheckInCount: userCheckinData.totalCount, // 总打卡次数
            isCreator: member.isCreator || false
          };
          
          // 调试：检查每个成员的完整数据
          console.log('👤 成员完整数据:', {
            index: index,
            name: memberData.name,
            avatar: memberData.avatar,
            checkInCount: memberData.checkInCount,
            monthlyCount: memberData.monthlyCount,
            totalCount: memberData.totalCheckInCount,
            originalAvatarUrl: member.avatarUrl
          });
          
          members.push(memberData);
        });
        
        // 计算团队总打卡次数和活跃度
        const teamTotalCheckins = members.reduce((total, member) => total + member.checkInCount, 0);
        const teamActivityRate = this.calculateActivityRate();
        
        console.log('🏆 团队总打卡次数:', teamTotalCheckins);
        console.log('📊 团队活跃度:', teamActivityRate, '%');
        
        // 设置到页面数据中
        this.setData({
          teamTotalCheckins: teamTotalCheckins,
          teamActivityRate: teamActivityRate
        });
        
        console.log('✅ 使用云端成员数据完成:', members.length);
        return members;
      }
      
      // 2. 如果没有云端详细数据，使用基础信息
      console.log('⚠️ 使用基础团队信息构建成员数据');
      
      // 添加创建者（团长）
      if (teamInfo.creator && teamInfo.creatorName) {
        const creator = this.getUserData(teamInfo.creator);
        
        members.push({
          id: 'creator',
          name: teamInfo.creatorName, // 使用真实昵称
          role: '团长',
          avatar: creator.avatarUrl || '/images/avatar.png', // 使用真实头像
          checkInCount: creator.checkInCount || 0, // 使用真实打卡次数
          isCreator: true
        });
      }
      
      // 添加其他成员（如果有）
      if (teamInfo.memberCount > 1) {
        console.log('⚠️ 团队有其他成员，但缺少详细数据，使用基础信息');
        // 这里可以添加占位成员信息，或者等待云端同步
      }
      
      console.log('✅ 获取基础团队成员数据:', members.length);
      return members;
      
    } catch (error) {
      console.error('获取真实团队成员数据失败:', error);
      return [];
    }
  },

  /**
   * 获取用户数据（昵称、头像、打卡次数）
   */
  getUserData(openid) {
    try {
      // 从本地缓存获取用户数据
      const userData = wx.getStorageSync(`user_${openid}`);
      if (userData) {
        return {
          nickname: userData.nickname,
          avatarUrl: userData.avatarUrl,
          checkInCount: userData.checkInCount || 0
        };
      }
      
      // 如果是当前用户，使用当前用户信息
      const currentOpenid = wx.getStorageSync('userOpenId');
      if (openid === currentOpenid) {
      return {
        nickname: wx.getStorageSync('userNickname') || '用户',
        avatarUrl: wx.getStorageSync('userAvatarUrl') || '/images/avatar.png',
        checkInCount: wx.getStorageSync('userCheckInCount') || 0
      };
      }
      
      return {
        nickname: '用户',
        avatarUrl: '/images/avatar.png',
        checkInCount: 0
      };
      
    } catch (error) {
      console.error('获取用户数据失败:', error);
      return {
        nickname: '用户',
        avatarUrl: '/images/avatar.png',
        checkInCount: 0
      };
    }
  },

  /**
   * 只显示创建者成员（团队只有创建者时）
   */
  getCreatorOnlyMember(teamInfo) {
    const creator = this.getUserData(teamInfo.creator);
    
    return [{
      id: 'creator',
      name: teamInfo.creatorName || '团队创建者',
      role: '团长',
      avatar: creator.avatarUrl || '/images/avatar.png',
      checkInCount: creator.checkInCount || 0,
      isCreator: true
    }];
  },

  /**
   * 获取本地缓存中的成员信息
   */
  getLocalMembers(teamInfo) {
    try {
      // 检查本地是否有缓存的团队成员信息
      const storageKey = `teamMembers_${teamInfo._id}`;
      const cachedMembers = wx.getStorageSync(storageKey);
      
      if (cachedMembers && Array.isArray(cachedMembers)) {
        console.log('✅ 从本地缓存加载成员信息成功:', cachedMembers.length);
        return cachedMembers;
      }
      
      // 如果本地缓存没有，但团队信息中有成员数据，使用团队信息中的成员
      if (teamInfo.members && Array.isArray(teamInfo.members) && teamInfo.members.length > 0) {
        console.log('✅ 使用团队信息中的成员数据:', teamInfo.members.length);
        return teamInfo.members;
      }
      
      return [];
    } catch (error) {
      console.error('获取本地成员信息失败:', error);
      return [];
    }
  },

  /**
   * 从云端获取成员信息（已废弃，使用getRealTeamMembers替代）
   */
  async getCloudMembers(teamInfo) {
    console.log('⚠️ getCloudMembers已废弃，使用getRealTeamMembers替代');
    return [];
  },

  /**
   * 保存成员信息到本地缓存
   */
  saveMembersToStorage(teamId, members) {
    try {
      const storageKey = `teamMembers_${teamId}`;
      wx.setStorageSync(storageKey, members);
      console.log('✅ 成员信息保存到本地缓存:', members.length);
    } catch (error) {
      console.error('保存成员信息到本地缓存失败:', error);
    }
  },

  /**
   * 更新团队成员列表
   */
  async updateTeamMembers(newMember) {
    try {
      const teamInfo = this.data.teamInfo;
      if (!teamInfo) return;
      
      console.log('更新团队成员列表，新成员:', newMember);
      
      // 获取当前成员列表
      const currentMembers = this.data.members || [];
      
      // 检查成员是否已存在
      const existingMemberIndex = currentMembers.findIndex(member => 
        member.id === newMember.id || member.openid === newMember.openid
      );
      
      if (existingMemberIndex === -1) {
        // 添加新成员
        const updatedMembers = [...currentMembers, newMember];
        
        // 更新页面数据
        this.setData({ members: updatedMembers });
        
        // 保存到本地缓存
        this.saveMembersToStorage(teamInfo._id, updatedMembers);
        
        console.log('✅ 团队成员列表已更新，新成员数:', updatedMembers.length);
      }
      
    } catch (error) {
      console.error('更新团队成员列表失败:', error);
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
   * 生成模拟成员数据（已废弃，使用真实数据替代）
   */
  generateMockMembers(teamInfo) {
    console.log('⚠️ generateMockMembers已废弃，使用真实数据替代');
    return this.getCreatorOnlyMember(teamInfo);
  },

  /**
   * 计算总打卡次数
   */
  calculateTotalCheckins() {
    if (!this.data.members || this.data.members.length === 0) {
      console.log('⚠️ 成员数据为空或未加载完成');
      return 0;
    }
    
    const total = this.data.members.reduce((total, member) => total + (member.checkInCount || 0), 0);
    console.log('🔢 计算总打卡次数:', {
      memberCount: this.data.members.length,
      totalCheckins: total,
      memberDetails: this.data.members.map(m => ({ name: m.name, checkInCount: m.checkInCount }))
    });
    
    return total;
  },

  /**
   * 计算活跃度（简化版：实际打卡用户数 / 团队总人数 × 100%）
   */
  calculateActivityRate() {
    if (!this.data.members || this.data.members.length === 0) return 0;
    
    console.log('🔍 开始计算活跃度，检查成员数据:', {
      成员总数: this.data.members.length,
      成员详情: this.data.members.map(m => ({ 
        name: m.name, 
        checkInCount: m.checkInCount,
        monthlyCount: m.monthlyCount
      }))
    });
    
    // 统计实际打卡的用户数（当月有打卡记录的用户）
    const activeMembers = this.data.members.filter(member => {
      // 检查多个可能的打卡数据字段
      const hasCheckins = (member.checkInCount && member.checkInCount > 0) || 
                         (member.monthlyCount && member.monthlyCount > 0);
      
      console.log(`成员 ${member.name} 打卡情况:`, {
        checkInCount: member.checkInCount,
        monthlyCount: member.monthlyCount,
        hasCheckins: hasCheckins
      });
      
      return hasCheckins;
    });
    
    // 计算活跃度百分比
    const activityRate = Math.round((activeMembers.length / this.data.members.length) * 100);
    
    console.log('📊 团队活跃度计算完成:', {
      团队总人数: this.data.members.length,
      实际打卡用户数: activeMembers.length,
      活跃度: activityRate + '%',
      活跃成员: activeMembers.map(m => ({ 
        name: m.name, 
        打卡次数: m.checkInCount || m.monthlyCount || 0 
      }))
    });
    
    return activityRate;
  },

  /**
   * 邀请成员 - 生成邀请信息
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
      // 1. 调用云函数生成邀请信息
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
        
        wx.hideLoading();
        
        // 2. 设置当前邀请信息，准备分享
        this.currentInviteData = {
          teamId: teamInfo._id,
          inviteId: inviteData.inviteId,
          teamName: teamInfo.name,
          inviterName: wx.getStorageSync('userNickname') || '匿名用户'
        };
        
        // 3. 显示分享引导提示
        wx.showModal({
          title: '邀请准备就绪',
          content: '邀请信息已生成，请点击上方的"邀请成员"按钮分享给好友',
          showCancel: false,
          confirmText: '知道了'
        });

      } else {
        throw new Error(result.result?.error || '生成邀请失败');
      }

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
  async switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    console.log('切换标签页:', tab);
    
    this.setData({
      currentTab: tab
    });
    
    // 如果切换到"练习动态"标签，加载动态数据
    if (tab === 'activities' && this.data.teamInfo) {
      await this.loadActivitiesData();
    }
  },

  /**
   * 加载练习动态数据（带加载状态）
   */
  async loadActivitiesData() {
    try {
      // 显示加载状态
      this.setData({
        activitiesLoading: true,
        activitiesError: false
      });
      
      // 加载动态数据
      const activities = await this.loadTeamActivities(this.data.teamInfo);
      
      this.setData({
        activities: activities,
        activitiesLoading: false
      });
      
      console.log('✅ 练习动态加载完成');
      
    } catch (error) {
      console.error('❌ 加载练习动态失败:', error);
      
      this.setData({
        activitiesError: true,
        activitiesLoading: false,
        activities: []
      });
      
      // 显示错误提示
      wx.showToast({
        title: '加载动态失败，请重试',
        icon: 'none',
        duration: 2000
      });
    }
  },

  /**
   * 加载团队练习动态（智能合并策略：本地优先，云端补充）
   */
  async loadTeamActivities(teamInfo) {
    try {
      console.log('🔄 开始加载团队练习动态...');
      
      // 方案1：优先使用云端数据（避免重复）
      const cloudActivities = await this.getDirectMemberWeekActivities(teamInfo);
      if (cloudActivities.length > 0) {
        console.log('✅ 使用云端数据，练习动态加载完成:', cloudActivities.length);
        return cloudActivities;
      }
      
      // 方案2：备选方案，仅使用云端数据，避免本地合并重复
      console.log('🔄 备选方案：仅使用云端数据获取成员打卡记录...');
      const members = await this.getTeamMembersWithCheckinData(teamInfo);
      
      // 仅使用云端数据，避免本地缓存重复
      const weekActivities = await this.getWeekActivitiesCloudOnly(members);
      
      // 按时间倒序排列
      const sortedActivities = weekActivities.sort((a, b) => b.timestamp - a.timestamp);
      
      console.log('✅ 练习动态加载完成:', {
        成员数量: members.length,
        本周记录数: sortedActivities.length,
        数据详情: sortedActivities.map(a => ({name: a.memberName, time: a.time, duration: a.duration}))
      });
      
      return sortedActivities;
    } catch (error) {
      console.error('❌ 加载练习动态失败:', error);
      // 降级处理：返回空数组，WXML会显示"暂无练习动态"
      return [];
    }
  },

  /**
   * 获取团队成员及其打卡数据（本地优先，云端补充）
   */
  async getTeamMembersWithCheckinData(teamInfo) {
    try {
      // 本地优先：从本地缓存获取团队成员
      const localMembers = await this.getLocalTeamMembers(teamInfo);
      
      // 如果本地有成员数据，直接返回
      if (localMembers.length > 0) {
        console.log('✅ 使用本地成员数据:', {
          成员数量: localMembers.length,
          成员列表: localMembers.map(m => ({name: m.name || m.nickname, openid: m.openid}))
        });
        return localMembers;
      }
      
      // 本地数据不足，从云端获取
      console.log('🔄 本地数据不足，从云端获取成员数据...');
      const cloudMembers = await this.getCloudMembersCheckinData(teamInfo);
      
      console.log('✅ 成员数据获取完成:', {
        本地成员数: localMembers.length,
        云端成员数: cloudMembers.length,
        最终成员数: cloudMembers.length,
        成员列表: cloudMembers.map(m => ({name: m.name || m.nickname, openid: m.openid}))
      });
      
      return cloudMembers;
    } catch (error) {
      console.error('获取团队成员数据失败:', error);
      // 降级处理：返回当前用户作为成员
      return [{
        openid: wx.getStorageSync('userOpenId') || 'current_user',
        name: wx.getStorageSync('userNickname') || '当前用户',
        avatarUrl: '/images/icons/user.png'
      }];
    }
  },

  /**
   * 从本地缓存获取团队成员
   */
  async getLocalTeamMembers(teamInfo) {
    try {
      // 直接使用团队信息中的members数组获取用户openid
      console.log('📊 直接读取team数据表中的members数组:', {
        团队ID: teamInfo._id,
        团队名称: teamInfo.name,
        members数组: teamInfo.members,
        成员数量: teamInfo.members ? teamInfo.members.length : 0,
        成员类型: typeof (teamInfo.members && teamInfo.members[0])
      });
      
      // 直接使用team数据表的members数组
      if (!teamInfo.members || !Array.isArray(teamInfo.members)) {
        console.log('⚠️ 团队members数组不存在或为空');
        return [];
      }
      
      // 处理成员数据，处理不同类型的成员格式
      const processedMembers = teamInfo.members.map((member, index) => {
        // 处理不同的成员数据格式
        let openid = '';
        let memberName = '';
        let avatarUrl = '/images/icons/user.png';
        
        if (typeof member === 'string') {
          // 成员是字符串格式的openid
          openid = member;
          const userData = this.getUserData(openid);
          memberName = userData.nickname || '成员';
          avatarUrl = userData.avatarUrl || avatarUrl;
        } else if (typeof member === 'object' && member !== null) {
          // 成员是对象格式
          openid = member.openid || member._openid || member.userId || `member_${index}`;
          memberName = member.name || member.nickname || member.userName || '成员';
          avatarUrl = member.avatarUrl || member.avatar || avatarUrl;
          
          // 如果对象中没有用户信息，尝试获取
          if (!member.name && !member.nickname) {
            const userData = this.getUserData(openid);
            memberName = userData.nickname || memberName;
            avatarUrl = userData.avatarUrl || avatarUrl;
          }
        } else {
          // 未知格式
          openid = `unknown_${index}`;
          memberName = '未知成员';
        }
        
        return {
          openid: openid,
          name: memberName,
          nickname: memberName,
          avatarUrl: avatarUrl
        };
      });
      
      console.log('✅ 处理后的成员数据:', processedMembers);
      return processedMembers;
    } catch (error) {
      console.error('获取本地团队成员失败:', error);
      return [];
    }
  },

  /**
   * 从云端获取成员数据
   */
  async getCloudMembersCheckinData(teamInfo) {
    try {
      console.log('🔄 从云端获取团队成员数据...');
      
      // 从云端获取团队成员数据
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getTeamMembers',
          data: {
            teamId: teamInfo._id
          }
        }
      });
      
      if (result.result && result.result.success) {
        const cloudMembers = result.result.data.members || [];
        
        // 处理云端成员数据，确保字段一致性
        const processedMembers = cloudMembers.map(member => {
          return {
            openid: member.openid || member._openid || member.userId || 'unknown_cloud',
            name: member.name || member.nickname || member.userName || '云端成员',
            nickname: member.nickname || member.name || '云端成员',
            avatarUrl: member.avatarUrl || member.avatar || '/images/icons/user.png'
          };
        });
        
        console.log('☁️ 云端成员数据:', {
          数量: processedMembers.length,
          成员列表: processedMembers.map(m => ({name: m.name, openid: m.openid}))
        });
        
        return processedMembers;
      } else {
        console.warn('⚠️ 云端返回数据格式异常:', result.result);
        return [];
      }
    } catch (error) {
      console.warn('⚠️ 云端成员数据获取失败:', error);
      return [];
    }
  },

  /**
   * 获取本周练习动态（智能合并策略）
   */
  async getWeekActivities(members) {
    try {
      const activities = [];
      const weekRange = this.getCurrentWeekRange();
      
      console.log('📅 本周时间范围:', weekRange);
      
      // 遍历每个成员，获取本周打卡记录
      for (const member of members) {
                const memberActivities = await this.getMemberWeekActivities(member, weekRange);
                
                // 确保所有活动数据都使用正确的格式
                const formattedActivities = memberActivities.map(activity => {
                  // 如果已经有正确格式的时间，直接使用
                  if (activity.originalTime && activity.originalTime.includes('-') && activity.originalTime.includes(':')) {
                    return activity;
                  }
                  
                  // 否则重新格式化时间
                  const formatTime = (timestamp) => {
                    const date = new Date(timestamp);
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    const hours = String(date.getHours()).padStart(2, '0');
                    const minutes = String(date.getMinutes()).padStart(2, '0');
                    const seconds = String(date.getSeconds()).padStart(2, '0');
                    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                  };
                  
                  const timestamp = activity.timestamp || Date.now();
                  const formattedTime = formatTime(timestamp);
                  
                  return {
                    ...activity,
                    originalTime: formattedTime,
                    time: formattedTime,
                    dateTime: formattedTime
                  };
                });
                
                activities.push(...formattedActivities);
      }
      
      console.log('✅ 本周活动数据汇总:', {
        成员数量: members.length,
        活动总数: activities.length,
        时间范围: weekRange
      });
      
      return activities;
    } catch (error) {
      console.error('获取本周活动数据失败:', error);
      return [];
    }
  },

  /**
   * 获取当前周的时间范围（周一至周日）
   */
  getCurrentWeekRange() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=周日, 1=周一, ..., 6=周六
    
    // 计算本周一的日期
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    
    // 计算本周日的日期
    const sunday = new Date(now);
    sunday.setDate(now.getDate() + (dayOfWeek === 0 ? 0 : 7 - dayOfWeek));
    
    // 格式化为YYYY-MM-DD
    const formatDate = (date) => date.toISOString().split('T')[0];
    
    return {
      start: formatDate(monday),
      end: formatDate(sunday),
      startTime: monday.getTime(),
      endTime: sunday.getTime() + 24 * 60 * 60 * 1000 - 1 // 当天的23:59:59
    };
  },

  /**
   * 获取单个成员本周的打卡活动
   */
  async getMemberWeekActivities(member, weekRange) {
    try {
      const activities = [];
      
      // 1. 先获取本地数据（快速响应）
      const localActivities = this.getMemberLocalWeekActivities(member, weekRange);
      
      // 2. 异步获取云端数据补充
      const cloudActivities = await this.getMemberCloudWeekActivities(member, weekRange);
      
      // 3. 智能合并（基于时间戳去重）
      const mergedActivities = this.mergeMemberActivities(localActivities, cloudActivities);
      
      console.log(`👤 成员 ${member.name} 本周活动:`, {
        本地记录数: localActivities.length,
        云端记录数: cloudActivities.length,
        合并后: mergedActivities.length
      });
      
      return mergedActivities;
    } catch (error) {
      console.error(`获取成员 ${member.name} 本周活动失败:`, error);
      return [];
    }
  },

  /**
   * 获取成员本地本周打卡记录
   */
  getMemberLocalWeekActivities(member, weekRange) {
    try {
      console.log(`🔍 获取成员 ${member.name} (${member.openid}) 的本地打卡记录`);
      
      // 如果是当前用户，获取本地打卡记录
      const currentUserOpenId = wx.getStorageSync('userOpenId');
      if (member.openid === currentUserOpenId) {
        console.log('✅ 是当前用户，获取本地打卡记录');
        
        const checkinManager = require('../../../../utils/checkin.js');
        const userData = checkinManager.getUserCheckinData();
        
        console.log('📊 用户打卡数据:', userData);
        
        const activities = [];
        
        // 遍历本周日期，查找打卡记录
        Object.keys(userData.dailyRecords || {}).forEach(date => {
          if (date >= weekRange.start && date <= weekRange.end) {
            const dayData = userData.dailyRecords[date];
            if (dayData && dayData.records) {
              dayData.records.forEach(record => {
                const timestamp = record.timestamp || Date.now();
                const date = new Date(timestamp);
                
                // 使用history页面相同的完整时间格式：YYYY-MM-DD HH:MM:SS
                const timeStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                
                activities.push({
                  id: `${member.openid}_${timestamp}`,
                  memberName: member.name || member.nickname || '未知用户',
                  avatar: member.avatarUrl || '/images/icons/user.png',
                  originalTime: timeStr, // 使用与history页面相同的格式
                  time: timeStr, // 兼容旧字段
                  dateTime: timeStr, // 兼容旧字段
                  duration: `${record.duration || 0}分钟`,
                  content: `练习了${record.duration || 0}分钟冥想`,
                  timestamp: timestamp,
                  memberOpenid: member.openid
                });
              });
            }
          }
        });
        
        console.log(`✅ 成员 ${member.name} 本地打卡记录:`, activities.length);
        return activities;
      } else {
        console.log('⚠️ 不是当前用户，无法获取本地打卡记录');
      }
      
      return [];
    } catch (error) {
      console.error('获取本地本周打卡记录失败:', error);
      return [];
    }
  },

  /**
   * 获取成员云端本周打卡记录
   */
  async getMemberCloudWeekActivities(member, weekRange) {
    try {
      console.log(`🔍 获取成员 ${member.name} (${member.openid}) 的云端打卡记录`);
      console.log('📅 时间范围:', weekRange);
      
      // 从云端获取成员本周打卡记录
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getMemberWeekCheckin',
          data: {
            memberOpenid: member.openid,
            weekStart: weekRange.start,
            weekEnd: weekRange.end
          }
        }
      });
      
      console.log('☁️ 云端返回结果:', result);
      
      if (result.result && result.result.success) {
        const cloudRecords = result.result.data.records || [];
        
        console.log(`✅ 成员 ${member.name} 云端打卡记录:`, cloudRecords.length);
        
        return cloudRecords.map(record => {
          // 处理时间戳格式
          let timestamp = record.timestamp || Date.now();
          
          // 处理时间戳格式（可能是ISO字符串或数字）
          if (typeof timestamp === 'string' && timestamp.includes('T')) {
            // 如果是ISO格式字符串，转换为时间戳
            timestamp = new Date(timestamp).getTime();
          }
          
          // 确保时间戳是有效的数字
          if (isNaN(timestamp)) {
            console.warn('⚠️ 无效的时间戳，使用当前时间:', record.timestamp);
            timestamp = Date.now();
          }
          const date = new Date(timestamp);
          
          // 使用history页面相同的完整时间格式：YYYY-MM-DD HH:MM:SS
          console.log(`🔍 云端记录时间分析:`, {
            timestamp: timestamp,
            时间对象: date,
            年: date.getFullYear(),
            月: date.getMonth() + 1,
            日: date.getDate(),
            时: date.getHours(),
            分: date.getMinutes(),
            秒: date.getSeconds()
          });
          const timeStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
          
          return {
            id: `${member.openid}_${timestamp}`,
            memberName: member.name || member.nickname || '未知用户',
            avatar: member.avatarUrl || '/images/icons/user.png',
            originalTime: timeStr, // 使用与history页面相同的格式
            time: timeStr, // 兼容旧字段
            dateTime: timeStr, // 兼容旧字段
            duration: `${record.duration || 0}分钟`,
            content: `练习了${record.duration || 0}分钟冥想`,
            timestamp: timestamp,
            memberOpenid: member.openid
          };
        });
      } else {
        console.warn('⚠️ 云端返回数据格式异常:', result.result);
        return [];
      }
    } catch (error) {
      console.warn('获取云端本周打卡记录失败:', error);
      return [];
    }
  },

  /**
   * 合并成员活动数据（智能去重）
   */
  mergeMemberActivities(localActivities, cloudActivities) {
    console.log('🔄 开始合并成员活动数据，去重处理...');
    console.log('📊 合并前数据:', {
      本地记录数: localActivities.length,
      云端记录数: cloudActivities.length,
      本地记录: localActivities.map(a => ({ id: a.id, timestamp: a.timestamp })),
      云端记录: cloudActivities.map(a => ({ id: a.id, timestamp: a.timestamp }))
    });
    
    // 使用Map来基于唯一标识符去重
    const activityMap = new Map();
    
    // 先添加本地记录
    localActivities.forEach(activity => {
      const key = this.generateActivityKey(activity);
      if (!activityMap.has(key)) {
        activityMap.set(key, activity);
      }
    });
    
    // 再添加云端记录（本地优先）
    cloudActivities.forEach(activity => {
      const key = this.generateActivityKey(activity);
      if (!activityMap.has(key)) {
        activityMap.set(key, activity);
      }
    });
    
    const merged = Array.from(activityMap.values());
    
    console.log('✅ 合并后数据:', {
      合并后记录数: merged.length,
      去重详情: {
        本地记录: localActivities.length,
        云端记录: cloudActivities.length,
        重复记录: localActivities.length + cloudActivities.length - merged.length,
        最终记录: merged.length
      }
    });
    
    return merged;
  },

  /**
   * 生成活动记录的唯一键
   */
  generateActivityKey(activity) {
    // 使用成员openid+时间戳作为唯一标识符
    // 为了应对时间戳可能存在的微小差异，使用10分钟窗口进行匹配
    const timestampKey = Math.floor(activity.timestamp / (10 * 60 * 1000)) * (10 * 60 * 1000);
    return `${activity.memberOpenid}_${timestampKey}`;
  },

  /**
   * 直接获取所有成员本周打卡记录（简化版本）
   */
  async getDirectMemberWeekActivities(teamInfo) {
    try {
      console.log('🚀 从meditation_records云端数据库实时获取团队练习动态...');
      
      // 直接获取团队的所有成员openid
      if (!teamInfo.members || !Array.isArray(teamInfo.members)) {
        console.log('⚠️ 团队成员列表为空');
        return [];
      }
      
      const weekRange = this.getCurrentWeekRange();
      const activities = [];
      
      // 从meditation_records数据库实时获取所有成员的打卡记录
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getTeamMeditationRecords',
          data: {
            teamId: teamInfo._id,
            weekStart: weekRange.start,
            weekEnd: weekRange.end
          }
        }
      });
      
      console.log('☁️ meditation_records数据库返回结果:', result);
      
      if (result.result && result.result.success) {
        const allRecords = result.result.data.records || [];
        
        console.log('📊 meditation_records数据库返回的原始记录详情:', {
          记录数量: allRecords.length,
          第一条记录: allRecords[0] ? {
            timestamp: allRecords[0].timestamp,
            timestamp类型: typeof allRecords[0].timestamp,
            duration: allRecords[0].duration,
            memberName: allRecords[0].memberName
          } : '无记录'
        });
        
        // 处理返回的记录，使用history页面相同的时间格式
        allRecords.forEach((record, index) => {
          // 使用history页面相同的时间格式：YYYY-MM-DD HH:MM:SS
          const time = new Date(record.timestamp);
          const timeStr = `${time.getFullYear()}-${(time.getMonth() + 1).toString().padStart(2, '0')}-${time.getDate().toString().padStart(2, '0')} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
          
          console.log(`📝 第${index}条记录时间分析:`, {
            原始timestamp: record.timestamp,
            时间对象: time.toISOString(),
            格式化时间: timeStr,
            时: time.getHours(),
            分: time.getMinutes(),
            秒: time.getSeconds()
          });
          
          const activity = {
            id: `${record.memberOpenid}_${record.timestamp}`,
            memberName: record.memberName || '成员',
            avatar: record.avatarUrl || '/images/icons/user.png',
            originalTime: timeStr, // 使用与history页面相同的格式
            time: timeStr, // 兼容旧字段
            dateTime: timeStr, // 兼容旧字段
            duration: `${record.duration || 0}分钟`,
            content: `练习了${record.duration || 0}分钟冥想`,
            timestamp: record.timestamp,
            memberOpenid: record.memberOpenid
          };
          
          activities.push(activity);
        });
        
        // 按时间倒序排列
        const sortedActivities = activities.sort((a, b) => b.timestamp - a.timestamp);
        
        console.log(`✅ 从meditation_records数据库实时获取成功，共 ${sortedActivities.length} 条记录`);
        return sortedActivities;
      } else {
        console.warn('⚠️ meditation_records数据库返回数据异常:', result.result);
        return [];
      }
    } catch (error) {
      console.warn('从meditation_records数据库实时获取数据失败:', error);
      return [];
    }
  },

  /**
   * 格式化时间戳为可读时间（修复版）
   */
  formatTimestamp(timestamp) {
    // 确保时间戳是有效的数字
    if (isNaN(timestamp)) {
      console.warn('⚠️ 格式化时间戳时发现无效值:', timestamp);
      return '刚刚';
    }
    
    const date = new Date(timestamp);
    const now = new Date();
    
    // 验证日期有效性
    if (isNaN(date.getTime())) {
      console.warn('⚠️ 格式化时间戳时创建了无效日期:', timestamp);
      return '刚刚';
    }
    
    // 如果是今天，显示"今天 HH:mm"
    if (date.toDateString() === now.toDateString()) {
      return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }
    
    // 如果是昨天，显示"昨天 HH:mm"
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }
    
    // 其他情况显示"MM-DD HH:mm"
    return `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  },

  /**
   * 格式化时间戳为完整日期时间
   */
  formatDateTime(timestamp) {
    const date = new Date(timestamp);
    
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    
    // 显示格式：MM-DD HH:mm
    return `${month}-${day} ${hours}:${minutes}`;
  },

  /**
   * 格式化时间戳为 YYYY-MM-DD HH:MM:SS 格式
   */
  formatTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  },

  /**
   * 生成模拟练习动态数据（备用）
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
   * 用户点击分享按钮触发
   */
  onShareAppMessage() {
    const teamInfo = this.data.teamInfo;
    
    if (!teamInfo) {
      return {
        title: '邀请您加入冥想团队',
        path: '/pages/index/index'
      };
    }
    
    // 如果有正在进行的邀请，使用邀请参数
    if (this.currentInviteData) {
      const { teamId, inviteId, teamName, inviterName } = this.currentInviteData;
      
      // 构建分享路径，包含邀请信息（使用包名路径）
      const sharePath = `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamId}&inviteId=${inviteId}&teamName=${encodeURIComponent(teamName)}&inviterName=${encodeURIComponent(inviterName)}`;
      
      // 分享成功后记录邀请行为
      setTimeout(() => {
        this.recordInviteAction(teamId, inviteId);
        wx.showToast({
          title: '邀请发送成功',
          icon: 'success',
          duration: 2000
        });
      }, 500);
      
      return {
        title: `邀请您加入 ${teamName}`,
        imageUrl: teamInfo.icon || '/images/icons/team.png',
        path: sharePath
      };
    }
    
      // 默认分享内容（直接分享团队）
    return {
      title: `邀请您加入 ${teamInfo.name}`,
      imageUrl: teamInfo.icon || '/images/icons/team.png',
      path: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamInfo._id}&teamName=${encodeURIComponent(teamInfo.name || '')}`
    };
  },


  /**
   * 获取更详细的兼容性信息
   */
  getCompatibilityInfo() {
    try {
      const systemInfo = wx.getSystemInfoSync();
      return {
        SDKVersion: systemInfo.SDKVersion,
        version: systemInfo.version,
        platform: systemInfo.platform
      };
    } catch (error) {
      return { error: error.message };
    }
  },

  /**
   * 获取本周练习动态（仅使用云端数据，避免重复）
   */
  async getWeekActivitiesCloudOnly(members) {
    try {
      const activities = [];
      const weekRange = this.getCurrentWeekRange();
      
      console.log('☁️ 仅使用云端数据获取本周活动...');
      
      // 遍历每个成员，仅获取云端打卡记录
      for (const member of members) {
        const memberActivities = await this.getMemberCloudWeekActivities(member, weekRange);
        activities.push(...memberActivities);
      }
      
      console.log('✅ 仅使用云端数据完成:', {
        成员数量: members.length,
        云端记录数: activities.length,
        时间范围: weekRange
      });
      
      return activities;
    } catch (error) {
      console.error('仅使用云端数据获取本周活动失败:', error);
      return [];
    }
  },

  /**
   * 确认解散团队（弹窗确认）
   */
  confirmDeleteTeam() {
    wx.showModal({
      title: '解散团队',
      content: '确定要解散该团队吗？此操作不可撤销，团队所有数据和成员关系将被永久删除！',
      confirmText: '解散',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.deleteTeam();
        }
      }
    });
  },

  /**
   * 删除团队（硬删除数据库记录）
   */
  async deleteTeam() {
    try {
      wx.showLoading({
        title: '解散中...',
        mask: true
      });

      // 获取当前用户openid
      const currentOpenid = wx.getStorageSync('userOpenId');
      
      // 调用云端函数删除团队
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'deleteTeam',
          data: {
            teamId: this.data.teamId
          },
          openid: currentOpenid // 传递当前用户openid
        }
      });

      wx.hideLoading();

      if (result.result && result.result.success) {
        console.log('✅ 团队删除成功:', result.result);
        
        // 从本地存储中删除团队
        this.removeTeamFromLocalStorage();
        
        // 更新团队页面的数据（通过事件机制通知团队页面更新）
        this.updateTeamPageData();
        
        wx.showToast({
          title: '团队解散成功',
          icon: 'success',
          duration: 2000
        });

        // 返回团队列表页面
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
      } else {
        throw new Error(result.result?.error || '删除团队失败');
      }
    } catch (error) {
      console.error('删除团队失败:', error);
      wx.hideLoading();
      
      wx.showModal({
        title: '解散失败',
        content: error.message || '解散团队失败，请稍后重试',
        showCancel: false,
        confirmText: '确定'
      });
    }
  },

  /**
   * 从本地存储中删除团队
   */
  removeTeamFromLocalStorage() {
    try {
      const storageKey = getTeamStorageKey();
      const teams = teamManager.loadTeamsFromStorage();
      
      // 过滤掉要删除的团队
      const updatedTeams = teams.filter(team => team._id !== this.data.teamId);
      
      // 更新本地存储
      wx.setStorageSync(storageKey, updatedTeams);
      console.log('✅ 本地存储团队删除成功');
    } catch (error) {
      console.error('从本地存储删除团队失败:', error);
    }
  },

  /**
   * 更新团队页面的数据统计和列表（解散团队专用）
   */
  updateTeamPageData() {
    try {
      console.log('🔄 开始更新团队页面数据...');
      
      // 1. 清理当前用户的本地缓存
      this.cleanupLocalCache();
      
      // 2. 获取当前页面栈
      const pages = getCurrentPages();
      
      // 3. 查找团队列表页面
      const teamPage = pages.find(page => page.route === 'pages/team/team');
      
      if (teamPage) {
        // 强制从云端刷新团队数据
        if (teamPage.refreshTeamData) {
          teamPage.refreshTeamData();
        } else if (teamPage.loadTeamData) {
          teamPage.loadTeamData(true); // true表示从云端加载
        } else {
          teamPage.onLoad && teamPage.onLoad();
        }
        console.log('✅ 团队页面数据已强制从云端更新');
      } else {
        console.log('⚠️ 未找到团队页面，下次访问时会自动从云端同步');
      }
      
    } catch (error) {
      console.error('更新团队页面数据失败:', error);
    }
  },

  /**
   * 清理当前用户的本地缓存
   */
  cleanupLocalCache() {
    try {
      const teamManager = require('../../../../utils/teamManager.js');
      
      // 1. 从已加入团队列表中移除该团队
      const removedFromJoined = teamManager.removeJoinedTeam(this.data.teamId);
      
      if (removedFromJoined) {
        console.log('✅ 已从加入团队缓存中移除团队');
      }
      
      // 2. 强制重新加载团队管理器，确保缓存最新
      teamManager.teams = teamManager.loadTeamsFromStorage();
      
      console.log('✅ 当前用户本地缓存已清理');
    } catch (error) {
      console.error('清理本地缓存失败:', error);
    }
  },

  /**
   * 返回首页
   */
  goToHomePage() {
    console.log('返回首页');
    wx.switchTab({
      url: '/pages/index/index'
    });
  }
})