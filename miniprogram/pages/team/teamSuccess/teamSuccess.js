// pages/team/teamSuccess/teamSuccess.js
const app = getApp();

Page({
  data: {
    teamName: '',
    teamDescription: '',
    teamIcon: '',
    teamId: '',
    inviteLink: ''
  },

  onLoad(options) {
    // 从页面参数获取团队信息
    if (options.teamData) {
      const teamData = JSON.parse(options.teamData);
      this.setData({
        teamName: teamData.name || '',
        teamDescription: teamData.description || '',
        teamIcon: this.getTeamIcon(teamData.icon),
        teamId: teamData._id || teamData.cloudId || ''
      });
      
      // 生成邀请链接
      this.generateInviteLink();
    }
  },

  /**
   * 根据团队图标路径获取显示的emoji
   */
  getTeamIcon(iconPath) {
    const iconMap = {
      '/subpackages/team/images/team-icons/image1.png': '🥋',
      '/subpackages/team/images/team-icons/image2.png': '🧘',
      '/subpackages/team/images/team-icons/image3.png': '🌟',
      '/subpackages/team/images/team-icons/image4.png': '💫',
      '/subpackages/team/images/team-icons/image5.png': '☯️',
      '/subpackages/team/images/team-icons/image6.png': '🌿',
      '/subpackages/team/images/team-icons/image7.png': '🧠',
      '/subpackages/team/images/team-icons/image8.png': '💖'
    };
    
    return iconMap[iconPath] || '🧘';
  },

  /**
   * 生成邀请链接
   */
  generateInviteLink() {
    // 这里可以生成一个包含团队ID的分享链接
    // 实际实现可能需要使用小程序路径或生成短链接
    const inviteLink = `pages/team/teamDetail/teamDetail?teamId=${this.data.teamId}`;
    this.setData({
      inviteLink: inviteLink
    });
  },

  /**
   * 分享团队
   */
  shareTeam() {
    // 微信小程序自定义分享按钮
    wx.share({
      provider: 'weixin',
      scene: 'WXSceneSession', // 分享给好友
      type: 0,
      title: `邀请你加入我的冥想团队：${this.data.teamName}`,
      imageUrl: '/images/icons/team-active.png',
      success: (res) => {
        wx.showToast({
          title: '分享成功',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('分享失败:', err);
        wx.showToast({
          title: '分享失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 复制邀请链接
   */
  copyInviteLink() {
    const inviteText = `邀请你加入我的冥想团队：${this.data.teamName}\n\n点击链接加入：${this.data.inviteLink}`;
    
    wx.setClipboardData({
      data: inviteText,
      success: () => {
        wx.showToast({
          title: '链接已复制',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('复制失败:', err);
        wx.showToast({
          title: '复制失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 关闭弹窗
   */
  closeModal() {
    wx.navigateBack();
  },

  /**
   * 页面分享
   */
  onShareAppMessage() {
    return {
      title: `邀请你加入我的冥想团队：${this.data.teamName}`,
      path: this.data.inviteLink,
      imageUrl: '/images/team-share-thumb.png'
    };
  },

  onReady() {

  },

  onShow() {

  },

  onHide() {

  },

  onUnload() {

  },

  onPullDownRefresh() {

  },

  onReachBottom() {

  }
})