// 聊天工具模式页面 - 主要用于自动发送团队邀请卡片
Page({
  /**
   * 页面的初始数据
   */
  data: {
    isLoading: true,
    sendSuccess: false,
    teamInfo: null,
    isJoinInvitation: false  // 是否是加入邀请流程
  },

  /**
   * 分享配置 - 在聊天工具模式下非常重要
   */
  onShareAppMessage(options) {
    const teamInfo = this.teamInfo;
    if (!teamInfo) {
      return {
        title: '邀请您加入团队',
        path: '/pages/index/index'
      };
    }

    return {
      title: `邀请您加入 ${teamInfo.teamName}`,
      imageUrl: '/images/icons/team.png',
      path: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamInfo.teamId}&inviteId=${teamInfo.inviteId}`
    };
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('聊天工具邀请页面加载，参数:', options);
    
    // 检查是否是从分享卡片点击进入的
    if (options.teamId && options.inviteId) {
      // 这是用户点击邀请卡片进入的，直接跳转到团队加入页面
      this.navigateToJoinTeam(options);
    } else if (options.teamInfo) {
      // 这是发起邀请的流程
      this.parseTeamInfo(options);
      this.autoSendInvite();
    } else {
      console.error('缺少必要的参数');
      this.showErrorModal('页面参数错误');
    }
  },

  /**
   * 解析团队信息
   */
  parseTeamInfo(options) {
    try {
      if (options.teamInfo) {
        const teamInfo = JSON.parse(decodeURIComponent(options.teamInfo));
        console.log('解析到的团队信息:', teamInfo);
        
        // 可以在这里保存团队信息供后续使用
        this.teamInfo = teamInfo;
      }
    } catch (error) {
      console.error('解析团队信息失败:', error);
    }
  },

  /**
   * 自动发送邀请
   */
  autoSendInvite() {
    const teamInfo = this.teamInfo;
    if (!teamInfo) {
      console.error('缺少团队信息');
      wx.navigateBack();
      return;
    }

    console.log('聊天工具页面已加载，团队信息:', teamInfo);

    // 记录邀请行为
    this.recordInviteAction();

    // 自动触发发送邀请
    setTimeout(() => {
      this.sendInvite();
    }, 500);
  },

  /**
   * 发送邀请到聊天室
   */
  sendInvite() {
    const teamInfo = this.teamInfo;
    if (!teamInfo) {
      this.showErrorModal('缺少团队信息');
      return;
    }

    console.log('自动发送邀请，团队信息:', teamInfo);

    // 使用 wx.shareAppMessageToGroup 发送邀请卡片
    console.log('调用 wx.shareAppMessageToGroup');
    
    wx.shareAppMessageToGroup({
      path: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamInfo.teamId}&inviteId=${teamInfo.inviteId}&teamName=${encodeURIComponent(teamInfo.teamName)}&teamIcon=${encodeURIComponent(teamInfo.teamIcon)}&inviterName=${encodeURIComponent(teamInfo.inviterName)}`,
      title: `邀请您加入 ${teamInfo.teamName}`,
      imageUrl: teamInfo.teamIcon || '/images/icons/team.png',
      success: (res) => {
        console.log('shareAppMessageToGroup success 回调:', res);
        if (res.errMsg === 'shareAppMessageToGroup:ok') {
          console.log('✅ 邀请卡片发送成功');
          // 使用setTimeout包装navigateBack，规避微信安全限制
          console.log('延迟返回团队详情页');
          setTimeout(() => {
            wx.navigateBack();
          }, 0);
        } else {
          console.error('❌ 邀请卡片发送失败:', res.errMsg);
          // 发送失败时也延迟返回
          setTimeout(() => {
            wx.navigateBack();
          }, 0);
        }
      },
      fail: (err) => {
        console.error('shareAppMessageToGroup fail 回调:', err);
        // 发送失败时也延迟返回
        setTimeout(() => {
          wx.navigateBack();
        }, 0);
      }
    });
  },

  /**
   * 显示错误模态框
   */
  showErrorModal(message) {
    wx.showModal({
      title: '发送失败',
      content: message,
      confirmText: '确定',
      showCancel: false,
      success: (res) => {
        if (res.confirm) {
          wx.navigateBack();
        }
      }
    });
  },

  /**
   * 直接跳转到团队加入页面
   */
  navigateToJoinTeam(options) {
    console.log('用户点击邀请卡片，直接跳转到团队加入页面，参数:', options);
    
    const { teamId, inviteId, teamName, teamIcon, inviterName } = options;
    
    if (!teamId || !inviteId) {
      this.showErrorModal('邀请链接参数不完整');
      return;
    }
    
    // 直接跳转到团队加入页面
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamId}&inviteId=${inviteId}&teamName=${encodeURIComponent(teamName || '')}&teamIcon=${encodeURIComponent(teamIcon || '')}&inviterName=${encodeURIComponent(inviterName || '')}`,
      success: () => {
        console.log('成功跳转到团队加入页面');
        // 跳转成功后关闭当前页面
        setTimeout(() => {
          wx.navigateBack();
        }, 500);
      },
      fail: (err) => {
        console.error('跳转失败:', err);
        // 跳转失败时显示邀请页面作为备选
        this.showInvitePage(options);
      }
    });
  },

  /**
   * 显示邀请页面（作为跳转失败的备选方案）
   */
  showInvitePage(options) {
    const { teamId, inviteId, teamName, teamIcon, inviterName } = options;
    
    // 保存邀请信息供页面使用
    this.teamInfo = {
      teamId: teamId,
      inviteId: inviteId,
      teamName: teamName || '一个团队',
      teamIcon: teamIcon || '/images/icons/team.png',
      inviterName: inviterName || '好友'
    };
    
    this.setData({ 
      teamInfo: this.teamInfo,
      isLoading: false,
      sendSuccess: true,
      isJoinInvitation: true  // 标记这是加入邀请流程
    });
  },

  /**
   * 用户点击确认返回
   */
  confirmReturn() {
    console.log('用户点击确认，执行navigateBack');
    wx.navigateBack();
  },

  /**
   * 用户点击重试发送
   */
  retrySend() {
    console.log('用户点击重试发送');
    this.setData({ 
      isLoading: true,
      sendSuccess: false 
    });
    
    setTimeout(() => {
      this.sendInvite();
    }, 500);
  },

  /**
   * 用户点击加入团队按钮
   */
  joinTeam() {
    const teamInfo = this.teamInfo;
    if (!teamInfo || !teamInfo.teamId || !teamInfo.inviteId) {
      this.showErrorModal('邀请信息不完整');
      return;
    }
    
    console.log('用户点击加入团队，团队信息:', teamInfo);
    
    // 跳转到团队加入页面
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${teamInfo.teamId}&inviteId=${teamInfo.inviteId}`,
      success: () => {
        console.log('成功跳转到团队加入页面');
      },
      fail: (err) => {
        console.error('跳转失败:', err);
        this.showErrorModal('跳转失败，请重试');
      }
    });
  },

  /**
   * 记录邀请行为
   */
  async recordInviteAction() {
    try {
      const teamInfo = this.teamInfo;
      if (!teamInfo) return;
      
      await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'recordInviteAction',
          data: {
            teamId: teamInfo._id || 'unknown',
            inviteTime: new Date().toISOString(),
            inviteType: 'chatTool'
          }
        }
      });
      
      console.log('✅ 聊天工具邀请记录已保存');
      
    } catch (error) {
      console.warn('记录邀请行为失败:', error);
    }
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    console.log('聊天工具邀请页面显示');
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {
    console.log('聊天工具邀请页面隐藏');
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    console.log('聊天工具邀请页面卸载');
  }
});