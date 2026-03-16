// 聊天工具模式页面 - 主要用于自动发送团队邀请卡片
Page({
  /**
   * 页面的初始数据
   */
  data: {
    isLoading: true
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
    
    // 解析团队信息
    this.parseTeamInfo(options);
    
    // 自动发送邀请（聊天工具模式会自动处理）
    this.autoSendInvite();
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
   * 聊天工具模式页面展示
   */
  autoSendInvite() {
    const teamInfo = this.teamInfo;
    if (!teamInfo) {
      console.error('缺少团队信息');
      this.showErrorModal('缺少团队信息');
      return;
    }

    console.log('聊天工具页面已加载，团队信息:', teamInfo);

    // 保存团队信息到页面数据，供WXML使用
    this.setData({ 
      teamInfo: teamInfo,
      isLoading: false 
    });

    // 记录邀请行为
    this.recordInviteAction();

    console.log('聊天工具页面已就绪，等待用户操作');
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

    console.log('用户点击发送邀请，团队信息:', teamInfo);

    // 在聊天工具模式下，使用正确的API发送邀请卡片
    try {
      console.log('开始调用 shareAppMessageToGroup API');
      
      // 使用 wx.shareAppMessageToGroup 发送邀请卡片
      console.log('调用 wx.shareAppMessageToGroup');
      
      wx.shareAppMessageToGroup({
        query: `teamId=${teamInfo.teamId}&inviteId=${teamInfo.inviteId}`, // 传递给页面的查询参数
        title: `邀请您加入 ${teamInfo.teamName}`,
        imageUrl: '/images/icons/team.png',
        success: (res) => {
          console.log('shareAppMessageToGroup success 回调:', res);
          if (res.errMsg === 'shareAppMessageToGroup:ok') {
            console.log('✅ 邀请卡片发送成功');
            this.showSendSuccessModal(teamInfo);
          } else {
            console.error('❌ 邀请卡片发送失败:', res.errMsg);
            this.showErrorModal(`发送失败: ${res.errMsg}`);
          }
        },
        fail: (err) => {
          console.error('shareAppMessageToGroup fail 回调:', err);
          this.showErrorModal('发送失败，请重试');
        },
        complete: (res) => {
          console.log('shareAppMessageToGroup complete 回调:', res);
        }
      });

    } catch (error) {
      console.error('发送邀请异常:', error);
      this.showErrorModal('发送邀请失败，请重试');
    }
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
   * 显示发送成功模态框
   */
  showSendSuccessModal(teamInfo) {
    wx.showModal({
      title: '邀请已发送',
      content: `邀请卡片已成功发送到聊天室，邀请好友加入${teamInfo.teamName}`,
      confirmText: '确定',
      showCancel: false,
      success: (res) => {
        if (res.confirm) {
          console.log('邀请发送完成，执行navigateBack');
          wx.navigateBack();
        }
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