// subpackages/team/pages/joinTeam/joinTeam.js
const teamManager = require('../../../../utils/teamManager.js');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    teamId: '',
    teamName: '',
    teamInfo: null,
    isLoading: false,
    isMember: false
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // 解析邀请链接参数
    const teamId = options.teamId || options.team_id;
    const teamName = options.teamName ? decodeURIComponent(options.teamName) : 
                   options.team_name ? decodeURIComponent(options.team_name) : '';
    const inviterId = options.inviterId || options.inviter_id;
    const inviteId = options.inviteId || options.invite_id;
    
    console.log('加入团队页面加载，邀请参数:', { teamId, teamName, inviterId, inviteId });
    
    if (teamId) {
      this.setData({
        teamId: teamId,
        teamName: teamName,
        inviterId: inviterId,
        inviteId: inviteId
      });
      this.loadTeamInfo();
    } else {
      wx.showToast({
        title: '邀请链接错误',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
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
          throw new Error('团队信息不存在或已解散');
        }
      }
      
      // 3. 检查当前用户是否已是团队成员
      const isMember = await this.checkIsMember(teamInfo);
      
      // 4. 设置页面标题
      wx.setNavigationBarTitle({
        title: `加入${teamInfo.name}`
      });
      
      this.setData({
        teamInfo: teamInfo,
        isMember: isMember,
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
   * 加入团队
   */
  async joinTeam() {
    const teamInfo = this.data.teamInfo;
    if (!teamInfo || this.data.isMember) return;
    
    wx.showLoading({
      title: '加入中...',
    });
    
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        throw new Error('请先登录');
      }
      
      // 1. 调用云端加入团队（包含邀请信息）
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
        
        // 2. 更新本地缓存
        teamManager.addJoinedTeam(teamInfo);
        
        // 3. 记录邀请关系（云端持久化）
        if (this.data.inviterId) {
          await this.recordInviteRelation();
        }
        
        // 4. 更新页面状态
        this.setData({
          isMember: true
        });
        
        wx.hideLoading();
        wx.showToast({
          title: '加入成功',
          icon: 'success',
          duration: 2000
        });
        
        // 5. 延迟返回团队详情页面
        setTimeout(() => {
          wx.navigateTo({
            url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${this.data.teamId}`
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
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时重新检查成员状态
    if (this.data.teamId) {
      this.loadTeamInfo();
    }
  }
})