// pages/createTeam/createTeam.js
Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 团队头像列表 - 使用12个不同的图标文件
    teamIcons: [
      { id: 1, path: '/subpackages/team/images/team-icons/image1.png', selected: false },
      { id: 2, path: '/subpackages/team/images/team-icons/image2.png', selected: false },
      { id: 3, path: '/subpackages/team/images/team-icons/image3.png', selected: false },
      { id: 4, path: '/subpackages/team/images/team-icons/image4.png', selected: false },
      { id: 5, path: '/subpackages/team/images/team-icons/image5.png', selected: false },
      { id: 6, path: '/subpackages/team/images/team-icons/image6.png', selected: false },
      { id: 7, path: '/subpackages/team/images/team-icons/image7.png', selected: false },
      { id: 8, path: '/subpackages/team/images/team-icons/image8.png', selected: false },
      { id: 9, path: '/subpackages/team/images/team-icons/image9.png', selected: false },
      { id: 10, path: '/subpackages/team/images/team-icons/image10.png', selected: false },
      { id: 11, path: '/subpackages/team/images/team-icons/image11.png', selected: false },
      { id: 12, path: '/subpackages/team/images/team-icons/image12.png', selected: false }
    ],
    // 当前选中的团队头像
    selectedIcon: null,
    // 团队名称
    teamName: '',
    // 团队介绍
    teamDescription: '',
    // 团队名称字符数
    nameCharCount: 0,
    // 团队介绍字符数
    descCharCount: 0
  },

  /**
   * 选择团队头像
   */
  selectTeamIcon: function(e) {
    const iconId = parseInt(e.currentTarget.dataset.id);
    const teamIcons = this.data.teamIcons.map(icon => ({
      ...icon,
      selected: icon.id === iconId
    }));
    
    this.setData({
      teamIcons: teamIcons,
      selectedIcon: iconId
    });
  },

  /**
   * 输入团队名称
   */
  onTeamNameInput: function(e) {
    const value = e.detail.value;
    this.setData({
      teamName: value,
      nameCharCount: value.length
    });
  },

  /**
   * 输入团队介绍
   */
  onTeamDescriptionInput: function(e) {
    const value = e.detail.value;
    this.setData({
      teamDescription: value,
      descCharCount: value.length
    });
  },

  /**
   * 创建团队
   */
  createTeam: function() {
    if (!this.data.selectedIcon) {
      wx.showToast({
        title: '请选择团队图标',
        icon: 'none'
      });
      return;
    }

    if (!this.data.teamName.trim()) {
      wx.showToast({
        title: '请输入团队名称',
        icon: 'none'
      });
      return;
    }

    if (this.data.teamName.length > 20) {
      wx.showToast({
        title: '团队名称不能超过20个字符',
        icon: 'none'
      });
      return;
    }

    if (this.data.teamDescription.length > 100) {
      wx.showToast({
        title: '团队介绍不能超过100个字符',
        icon: 'none'
      });
      return;
    }

    // 这里可以添加创建团队的API调用
    const selectedIcon = this.data.teamIcons.find(icon => icon.id === this.data.selectedIcon);
    
    wx.showToast({
      title: '创建团队成功',
      icon: 'success',
      success: () => {
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
      }
    });

    console.log('创建团队信息:', {
      icon: selectedIcon.path,
      name: this.data.teamName,
      description: this.data.teamDescription
    });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('=== createTeam页面加载 ===');
    console.log('teamIcons数据:', this.data.teamIcons);
    console.log('teamIcons数量:', this.data.teamIcons.length);
    
    // 检查第一个图标的路径
    if (this.data.teamIcons.length > 0) {
      console.log('第一个图标路径:', this.data.teamIcons[0].path);
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