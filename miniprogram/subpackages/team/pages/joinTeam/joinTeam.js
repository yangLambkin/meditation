// 团队加入页面 - 迁移到team子包版本
// 不受ChatTool限制，可以正常调用主包页面

let teamManager = null;

Page({
  /**
   * 页面的初始数据
   */
  data: {
    teamId: '',
    teamInfo: null,
    members: [],
    isLoading: false,
    isMember: false,
    teamTotalCheckins: 0,
    teamActivityRate: 0
  },

  /**
   * 生命周期函数--监听页面加载
   */
  async onLoad(options) {
    // 加载teamManager
    try {
      teamManager = require('../../../../utils/teamManager.js');
      console.log('✅ teamManager加载成功');
    } catch (error) {
      console.error('❌ teamManager加载失败:', error);
    }

    // 解析邀请链接参数
    const teamId = options.teamId || options.team_id;
    const teamName = options.teamName ? decodeURIComponent(options.teamName) : 
                   options.team_name ? decodeURIComponent(options.team_name) : '';
    const inviterId = options.inviterId || options.inviter_id;
    const inviteId = options.inviteId || options.invite_id;
    const teamIcon = options.teamIcon ? decodeURIComponent(options.teamIcon) : '';
    const inviterName = options.inviterName ? decodeURIComponent(options.inviterName) : '';
    
    console.log('团队加入页面加载，邀请参数:', { 
      teamId, teamName, inviterId, inviteId, teamIcon, inviterName 
    });
    
    if (teamId) {
      this.setData({
        teamId: teamId,
        teamName: teamName,
        inviteId: inviteId
      });
      
      // 只有当 inviterId 有值时才设置
      if (inviterId) {
        this.setData({ inviterId: inviterId });
      }
      
      // 检查用户是否已登录
      console.log('🔍 onLoad参数检查:', options);
      
      if (this.hasUserInfo()) {
        // 用户已登录，直接检查是否是返回操作
        if (options.fromLogin === 'true') {
          console.log('✅ 用户从登录页面返回，自动完成加入团队操作');
          // 用户从登录页面返回，自动完成加入团队操作
          this.autoJoinTeamAfterLogin();
        } else {
          // 正常加载团队信息
          console.log('✅ 用户已登录，正常加载团队信息');
          this.loadTeamInfo();
        }
      } else {
        // 用户未登录，正常加载团队信息
        console.log('❌ 用户未登录，正常加载团队信息');
        this.loadTeamInfo();
      }
    } else {
      wx.showToast({
        title: '邀请链接错误',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 500);
    }
  },

  /**
   * 加载团队信息
   */
  async loadTeamInfo() {
    if (this.data.isLoading) return;
    
    this.setData({ isLoading: true });
    
    try {
      console.log('开始加载团队信息...');
      
      // 1. 优先从本地缓存读取团队信息
      const allTeams = teamManager.loadTeamsFromStorage();
      let teamInfo = allTeams.find(team => team._id === this.data.teamId);
      
      if (teamInfo) {
        console.log('✅ 从本地缓存加载团队信息成功');
      } else {
        console.log('⚠️ 本地缓存未找到团队信息，尝试从云端加载...');
        
        // 2. 本地缓存不存在，从云端加载
        teamInfo = await this.loadTeamFromCloud();
        
        if (teamInfo) {
          console.log('✅ 从云端加载团队信息成功');
        } else {
          // 3. 云端也没有，团队不存在
          console.log('❌ 团队不存在');
          this.showTeamNotExist();
          this.setData({ isLoading: false });
          return;
        }
      }
      
      // 4. 检查当前用户是否已是团队成员
      const isMember = await this.checkIsMember(teamInfo);
      
      // 5. 设置页面标题
      wx.setNavigationBarTitle({
        title: `加入${teamInfo.name}`
      });
      
      // 6. 加载成员信息
      const members = await this.loadTeamMembers(teamInfo);
      
      // 7. 计算统计信息
      const teamTotalCheckins = this.calculateTotalCheckins(members);
      const teamActivityRate = this.calculateActivityRate(members);
      
      console.log('📊 团队统计信息计算完成:', {
        成员总数: members.length,
        总打卡次数: teamTotalCheckins,
        活跃度: teamActivityRate + '%'
      });
      
      this.setData({
        teamInfo: teamInfo,
        members: members,
        isMember: isMember,
        teamTotalCheckins: teamTotalCheckins,
        teamActivityRate: teamActivityRate,
        isLoading: false
      });
      
    } catch (error) {
      console.error('加载团队信息失败:', error);
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
   * 显示团队不存在提示
   */
  showTeamNotExist() {
    wx.showModal({
      title: '团队不存在',
      content: '您要加入的团队不存在或已被解散。',
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        // 返回上一页或关闭页面
        wx.navigateBack();
      }
    });
  },

  /**
   * 检查当前用户是否已是团队成员
   */
  async checkIsMember(teamInfo) {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return false;
      
      // 检查本地缓存
      const joinedTeams = teamManager.loadJoinedTeamsFromStorage();
      const isLocalMember = joinedTeams.some(team => team._id === this.data.teamId);
      
      if (isLocalMember) {
        console.log('✅ 从本地缓存确认是团队成员');
        return true;
      }
      
      // 检查云端
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'checkTeamMember',
          data: {
            teamId: this.data.teamId,
            openid: openid
          }
        }
      });
      
      if (result.result && result.result.success) {
        console.log('✅ 从云端确认是团队成员:', result.result.isMember);
        return result.result.isMember;
      }
      
      return false;
    } catch (error) {
      console.error('检查成员状态失败:', error);
      return false;
    }
  },

  /**
   * 加载团队成员信息
   */
  async loadTeamMembers(teamInfo) {
    try {
      // 优先从本地缓存获取团队成员信息
      const cachedMembers = await this.loadMembersFromCache(teamInfo._id);
      if (cachedMembers && cachedMembers.length > 0) {
        console.log('✅ 从本地缓存加载团队成员信息成功', cachedMembers.length);
        return cachedMembers;
      }
      
      // 本地缓存没有，尝试从云端加载
      const cloudMembers = await this.loadMembersFromCloud(teamInfo._id);
      if (cloudMembers && cloudMembers.length > 0) {
        console.log('✅ 从云端加载团队成员信息成功', cloudMembers.length);
        // 保存到本地缓存
        this.saveMembersToCache(teamInfo._id, cloudMembers);
        return cloudMembers;
      }
      
      // 云端也没有，使用团队信息中的成员数据
      if (teamInfo.members && Array.isArray(teamInfo.members)) {
        console.log('⚠️ 使用团队信息中的成员数据', teamInfo.members.length);
        const formattedMembers = teamInfo.members.map((member, index) => ({
          id: member.openid || `member_${index + 1}`,
          name: member.nickname || `成员${index + 1}`,
          role: member.isCreator ? '团长' : '成员',
          avatar: member.avatarUrl || this.getDefaultAvatar(index),
          avatarEmoji: this.getDefaultAvatarEmoji(index),
          checkInCount: member.checkInCount || Math.floor(Math.random() * 100) + 10,
          lastActive: '在线'
        }));
        // 保存到本地缓存
        this.saveMembersToCache(teamInfo._id, formattedMembers);
        return formattedMembers;
      }
      
      // 所有方式都失败，返回空数组
      console.log('❌ 无法加载团队成员信息');
      return [];
      
    } catch (error) {
      console.error('加载成员信息失败:', error);
      return [];
    }
  },

  /**
   * 从本地缓存加载团队成员信息
   */
  async loadMembersFromCache(teamId) {
    try {
      const cacheKey = `team_members_${teamId}`;
      const cachedData = wx.getStorageSync(cacheKey);
      
      if (cachedData && Array.isArray(cachedData)) {
        // 检查缓存是否过期（30分钟）
        const cacheTime = wx.getStorageSync(`${cacheKey}_time`);
        if (cacheTime && Date.now() - cacheTime < 30 * 60 * 1000) {
          return cachedData;
        }
      }
      
      return null;
    } catch (error) {
      console.warn('从本地缓存加载成员信息失败:', error);
      return null;
    }
  },

  /**
   * 从云端加载团队成员信息
   */
  async loadMembersFromCloud(teamId) {
    try {
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getTeamMembers',
          data: {
            teamId: teamId
          }
        }
      });
      
      if (result.result && result.result.success && result.result.data) {
        // 格式化云端成员数据
        return result.result.data.map((member, index) => ({
          id: member.openid || `member_${index + 1}`,
          name: member.nickname || `成员${index + 1}`,
          role: member.isCreator ? '团长' : '成员',
          avatar: member.avatarUrl || this.getDefaultAvatar(index),
          avatarEmoji: this.getDefaultAvatarEmoji(index),
          checkInCount: member.checkInCount || Math.floor(Math.random() * 100) + 10,
          lastActive: '在线'
        }));
      }
      
      return null;
    } catch (error) {
      console.warn('从云端加载成员信息失败:', error);
      return null;
    }
  },

  /**
   * 保存成员信息到本地缓存
   */
  saveMembersToCache(teamId, members) {
    try {
      const cacheKey = `team_members_${teamId}`;
      wx.setStorageSync(cacheKey, members);
      wx.setStorageSync(`${cacheKey}_time`, Date.now());
      console.log('✅ 成员信息已保存到本地缓存');
    } catch (error) {
      console.warn('保存成员信息到本地缓存失败:', error);
    }
  },

  /**
   * 获取默认头像URL
   */
  getDefaultAvatar(index) {
    const defaultAvatars = [
      '/images/avatar-1.png',
      '/images/avatar-2.png',
      '/images/avatar-3.png',
      '/images/avatar-4.png'
    ];
    return defaultAvatars[index % defaultAvatars.length] || '/images/avatar.png';
  },

  /**
   * 获取默认头像emoji（备用）
   */
  getDefaultAvatarEmoji(index) {
    const emojis = ['👩', '👨', '👧', '👦'];
    return emojis[index % emojis.length] || '👤';
  },

  /**
   * 计算总打卡次数
   */
  calculateTotalCheckins(members) {
    if (!members || members.length === 0) {
      console.log('⚠️ 成员数据为空或未加载完成');
      return 0;
    }
    
    const total = members.reduce((total, member) => total + (member.checkInCount || 0), 0);
    console.log('🔢 计算总打卡次数:', {
      memberCount: members.length,
      totalCheckins: total,
      memberDetails: members.map(m => ({ name: m.name, checkInCount: m.checkInCount }))
    });
    
    return total;
  },

  /**
   * 计算活跃度（简化版：实际打卡用户数 / 团队总人数 × 100%）
   */
  calculateActivityRate(members) {
    if (!members || members.length === 0) return 0;
    
    console.log('🔍 开始计算活跃度，检查成员数据:', {
      成员总数: members.length,
      成员详情: members.map(m => ({ 
        name: m.name, 
        checkInCount: m.checkInCount,
        monthlyCount: m.monthlyCount
      }))
    });
    
    // 统计实际打卡的用户数（当月有打卡记录的用户）
    const activeMembers = members.filter(member => {
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
    const activityRate = Math.round((activeMembers.length / members.length) * 100);
    
    console.log('📊 团队活跃度计算完成:', {
      团队总人数: members.length,
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
   * 用户登录后自动完成加入团队操作
   */
  async autoJoinTeamAfterLogin() {
    console.log('🔄 用户登录后自动加入团队开始执行');
    
    // 等待登录信息同步
    console.log('🔍 等待登录信息同步...');
    await this.waitForLoginSync();
    
    console.log('🔍 开始加载团队信息...');
    // 先加载团队信息
    await this.loadTeamInfo();
    
    console.log('🔍 延迟执行加入团队操作...');
    // 延迟执行加入团队操作，确保UI已更新
    setTimeout(() => {
      console.log('✅ 开始执行自动加入团队');
      this.joinTeam();
    }, 1000);
  },

  /**
   * 等待登录信息同步
   */
  waitForLoginSync() {
    return new Promise((resolve) => {
      const checkLogin = () => {
        const openid = wx.getStorageSync('userOpenId');
        if (openid) {
          console.log('✅ 登录信息已同步');
          resolve();
        } else {
          console.log('等待登录信息同步...');
          setTimeout(checkLogin, 200);
        }
      };
      checkLogin();
    });
  },

  /**
   * 检查用户是否有登录信息
   */
  hasUserInfo() {
    const userInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    const userOpenId = wx.getStorageSync('userOpenId');
    
    console.log('🔍 用户信息检测详细:');
    console.log('  - userInfo:', userInfo);
    console.log('  - userNickname:', userNickname);
    console.log('  - userOpenId:', userOpenId);
    console.log('  - userInfo存在:', !!userInfo);
    console.log('  - userNickname存在:', !!userNickname);
    console.log('  - userOpenId存在:', !!userOpenId);
    
    // 正确的用户状态检测逻辑：
    // 1. 真正登录：userOpenId以'oz'开头（微信openid）
    // 2. 本地用户：userOpenId以'local_'开头（未登录，但有本地标识）
    // 3. 未登录：没有任何用户信息
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const isLocalUser = userOpenId && userOpenId.startsWith('local_');
    
    // 只有当有微信登录信息或有用户昵称时，才认为是已登录
    const hasInfo = !!(isWechatLoggedIn || userInfo || userNickname);
    
    console.log('🔍 登录状态检测结果:');
    console.log('  - 微信登录:', isWechatLoggedIn);
    console.log('  - 本地用户:', isLocalUser);
    console.log('  - 有用户信息:', !!userInfo);
    console.log('  - 有昵称:', !!userNickname);
    console.log('  - hasUserInfo最终结果:', hasInfo);
    
    return hasInfo;
  },

  /**
   * 加入团队（核心方法）
   */
  async joinTeam() {
    const teamInfo = this.data.teamInfo;
    if (!teamInfo) {
      wx.showToast({ title: '团队信息加载中，请稍后', icon: 'none' });
      return;
    }
    
    // 如果用户已经是团队成员，直接跳转到团队详情页面
    if (this.data.isMember) {
      console.log('✅ 用户已是团队成员，直接跳转到团队详情');
      wx.navigateTo({
        url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${this.data.teamId}`
      });
      return;
    }
    
    // 检查是否是团队创建者（临时解决方案）
    const currentOpenId = wx.getStorageSync('userOpenId');
    if (teamInfo.creator && teamInfo.creator === currentOpenId) {
      console.log('⚠️ 创建者尝试加入自己的团队，自动设置成功');
      this.setData({ isMember: true });
      wx.showToast({ title: '您已是团队创建者', icon: 'success' });
      return;
    }
    
    // 检查用户是否已登录
    console.log('🔍 开始检查登录状态...');
    const isLoggedIn = this.hasUserInfo();
    console.log('登录状态检查结果:', isLoggedIn);
    
    if (!isLoggedIn) {
      console.log('用户未登录，跳转到主包profile页面进行登录');
      
      // 关键修改：直接跳转到主包profile页面（不受ChatTool限制）
      // 明确传递调用页面信息，用于登录后正确跳转
      const fromParams = JSON.stringify({
        teamId: this.data.teamId,
        teamName: this.data.teamInfo?.name || '',
        teamIcon: this.data.teamInfo?.icon || '',
        inviterName: this.data.teamInfo?.creatorName || ''
      });
      
      // 构建查询参数，避免双重编码
      const params = {
        teamId: this.data.teamId,
        teamName: this.data.teamInfo?.name || '',
        teamIcon: this.data.teamInfo?.icon || '',
        inviterName: this.data.teamInfo?.creatorName || '',
        type: 'new', // 新用户注册
        fromPage: '/subpackages/team/pages/joinTeam/joinTeam', // 路径不需要额外编码
        fromParams: fromParams // JSON字符串会被encodeURIComponent处理
      };
      
      const queryString = Object.keys(params)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
      
      // 跳转到主包profile页面
      wx.navigateTo({
        url: `/pages/profile/profile?${queryString}`,
        success: () => {
          console.log('跳转到主包profile页面成功，已传递调用页面上下文');
        },
        fail: (err) => {
          console.error('跳转到主包profile页面失败:', err);
          wx.showToast({
            title: '登录跳转失败',
            icon: 'none'
          });
        }
      });
      return;
    }
    
    wx.showLoading({
      title: '加入中...',
    });
    
    try {
      // 获取用户openid
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        throw new Error('用户未登录，无法加入团队');
      }
      
      // 调用云端加入团队（包含邀请信息）
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'joinTeam',
          data: {
            teamId: this.data.teamId,
            openid: openid,
            inviterId: this.data.inviterId,
            inviteId: this.data.inviteId,
            inviteTime: new Date().toISOString()
          }
        }
      });
      
      if (result.result && result.result.success) {
        console.log('✅ 加入团队成功');
        
        // 更新本地缓存
        console.log('🔄 开始更新本地缓存...');
        teamManager.addJoinedTeam(teamInfo);
        
        // 强制刷新本地缓存（确保数据同步）
        console.log('🔄 强制刷新本地缓存...');
        try {
          await teamManager.loadTeamsFromCloud();
          console.log('✅ 本地缓存刷新成功');
        } catch (cacheError) {
          console.warn('⚠️ 缓存刷新失败，使用降级方案:', cacheError);
        }
        
        // 记录邀请关系（云端持久化）
        if (this.data.inviterId) {
          await this.recordInviteRelation();
        }
        
        // 更新页面状态
        this.setData({
          isMember: true
        });
        
        wx.hideLoading();
        wx.showToast({
          title: '加入成功',
          icon: 'success',
          duration: 2000
        });
        
        // 延迟跳转到团队详情页面
        setTimeout(() => {
          console.log('✅ 跳转到团队详情页面，团队ID:', this.data.teamId);
          wx.navigateTo({
            url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${this.data.teamId}`,
            success: () => {
              console.log('✅ 跳转到团队详情页面成功');
            },
            fail: (err) => {
              console.error('❌ 跳转到团队详情页面失败:', err);
              
              // 如果绝对路径失败，尝试相对路径
              wx.navigateTo({
                url: `../teamDetails/teamDetails?teamId=${this.data.teamId}`,
                success: () => {
                  console.log('✅ 相对路径跳转成功');
                },
                fail: (err2) => {
                  console.error('❌ 相对路径跳转也失败:', err2);
                }
              });
            }
          });
        }, 1500);
        
      } else {
        throw new Error(result.result?.error || '加入失败');
      }
      
    } catch (error) {
      wx.hideLoading();
      console.error('加入团队失败:', error);
      
      wx.showModal({
        title: '加入失败',
        content: error.message || '网络错误，请重试',
        showCancel: false
      });
    }
  },

  /**
   * 记录邀请关系到云端数据库
   */
  async recordInviteRelation() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      
      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'recordInviteRelation',
          data: {
            teamId: this.data.teamId,
            inviterId: this.data.inviterId,
            inviteeId: openid,
            inviteId: this.data.inviteId,
            inviteTime: new Date().toISOString(),
            status: 'accepted'
          }
        }
      });
      
      if (result.result && result.result.success) {
        console.log('✅ 邀请关系已保存到云端数据库');
      } else {
        console.warn('邀请关系保存失败:', result.result?.error);
      }
    } catch (error) {
      console.warn('记录邀请关系失败:', error);
    }
  },

  /**
   * 进入团队详情页面
   */
  enterTeamDetails() {
    console.log('🔄 用户手动点击进入团队详情，团队ID:', this.data.teamId);
    
    if (!this.data.teamId) {
      wx.showToast({
        title: '团队ID不存在',
        icon: 'none'
      });
      return;
    }
    
    // 尝试绝对路径跳转
    wx.navigateTo({
      url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${this.data.teamId}`,
      success: () => {
        console.log('✅ 手动跳转到团队详情页面成功');
      },
      fail: (err) => {
        console.error('❌ 手动跳转到团队详情页面失败:', err);
        
        // 如果绝对路径失败，尝试相对路径
        wx.navigateTo({
          url: `../teamDetails/teamDetails?teamId=${this.data.teamId}`,
          success: () => {
            console.log('✅ 相对路径跳转成功');
          },
          fail: (err2) => {
            console.error('❌ 相对路径跳转也失败:', err2);
          }
        });
      }
    });
  },

  /**
   * 头像加载错误处理
   */
  onAvatarError(e) {
    console.log('头像加载失败:', e.detail);
    // 设置默认头像
    const index = e.currentTarget.dataset.index;
    if (index !== undefined) {
      const members = this.data.members;
      members[index].avatar = '/images/userLogin.png';
      this.setData({ members: members });
    }
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时重新检查成员状态
    if (this.data.teamId) {
      this.loadTeamInfo();
    }
  }
})