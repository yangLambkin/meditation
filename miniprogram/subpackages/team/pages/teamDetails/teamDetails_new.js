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
        try {
          await wx.openChatTool({
            title: `邀请您加入${teamInfo.name}团队`,
            path: inviteData.sharePath,
            imageUrl: teamInfo.icon || '/images/icons/team.png',
            success: (res) => {
              console.log('打开聊天工具成功', res);
              
              // 记录邀请记录到云端
              this.recordInviteAction(teamInfo._id, inviteData.inviteId);
              
              wx.showToast({
                title: '邀请已发送',
                icon: 'success'
              });
            },
            fail: (err) => {
              console.error('打开聊天工具失败', err);
              
              // 如果新API不可用，降级到复制链接方式
              this.showInviteLinkFallback(inviteData, teamInfo);
            }
          });
        } catch (error) {
          console.error('调用openChatTool失败', error);
          
          // 如果API不存在，降级到复制链接方式
          this.showInviteLinkFallback(inviteData, teamInfo);
        }

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