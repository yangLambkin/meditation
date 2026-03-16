// pages/createTeam/createTeam.js
const teamManager = require('../../../../utils/teamManager.js');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 团队头像列表 - 只保留上传选项
    teamIcons: [
      { id: 1, path: '/subpackages/team/images/icons/upload.png', selected: false, type: 'upload' },
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
    descCharCount: 0,
    // 创建状态
    isCreating: false,
    // 用户信息
    userNickname: '匿名用户',
    hasUserInfo: false,
    // 成功弹窗相关
    showSuccessModal: false,
    teamNameForModal: '',
    teamDescriptionForModal: '',
    teamIconForModal: '',
    customIconPath: ''
  },

  /**
   * 选择团队头像
   */
  selectTeamIcon: function(e) {
    const iconId = parseInt(e.currentTarget.dataset.id);
    
    // 只有一个上传图标，点击时触发选择图片
    this.chooseImageFromAlbum();
  },

  /**
   * 从相册选择图片（使用微信官方API）
   */
  chooseImageFromAlbum() {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        const sourceType = res.tapIndex === 0 ? ['camera'] : ['album'];
        
        // 使用微信官方chooseMedia API
        wx.chooseMedia({
          count: 1, // 只能选择1张图片
          mediaType: ['image'], // 只选择图片
          sourceType: sourceType, // 来源类型：拍照或相册
          maxDuration: 30, // 最大时长30秒（主要用于视频）
          camera: 'back', // 后置摄像头
          success: (res) => {
            if (res.tempFiles && res.tempFiles.length > 0) {
              const tempFilePath = res.tempFiles[0].tempFilePath;
              console.log('选择的图片路径:', tempFilePath);
              
              // 更新图标显示为选择的图片
              const teamIcons = this.data.teamIcons.map(icon => ({
                ...icon,
                path: tempFilePath,
                selected: true
              }));
              
              this.setData({
                teamIcons: teamIcons,
                selectedIcon: 1,
                customIconPath: tempFilePath // 保存自定义图片路径
              });
              
              wx.showToast({
                title: '图片选择成功',
                icon: 'success'
              });
            }
          },
          fail: (err) => {
            console.error('选择图片失败:', err);
            wx.showToast({
              title: '选择图片失败',
              icon: 'none'
            });
          }
        });
      },
      fail: (err) => {
        console.error('显示操作菜单失败:', err);
      }
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
  async createTeam() {
    // 防止重复提交
    if (this.data.isCreating) {
      return;
    }

    // 验证表单 - 检查是否选择了图标（预设或自定义）
    if (!this.data.selectedIcon && !this.data.customIconPath) {
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

    // 设置创建状态
    this.setData({ isCreating: true });

    try {
      // 验证是否已选择图标（无论是预设还是自定义）
      if (!this.data.selectedIcon && !this.data.customIconPath) {
        wx.showToast({
          title: '请选择团队图标',
          icon: 'none'
        });
        return;
      }
      
      // 确定使用的图标路径
      let iconPath = '';
      if (this.data.customIconPath) {
        // 使用自定义上传的图片
        iconPath = this.data.customIconPath;
      } else {
        // 使用预设图标
        const selectedIcon = this.data.teamIcons.find(icon => icon.id === this.data.selectedIcon);
        iconPath = selectedIcon.path;
      }
      
      // 创建团队信息
      const teamInfo = {
        name: this.data.teamName.trim(),
        description: this.data.teamDescription.trim(),
        icon: iconPath
      };

      // 调用团队管理器创建团队
      const result = await teamManager.createTeam(teamInfo);

      if (result.success) {
        console.log('✅ 团队创建成功:', result.team);
        
        // 使用简单的 toast 提示用户
        wx.showToast({
          title: '团队创建成功！',
          icon: 'success',
          duration: 2000,
          success: () => {
            // 2秒后自动返回上一页
            setTimeout(() => {
              wx.navigateBack();
            }, 2000);
          }
        });
      } else {
        throw new Error(result.error || '创建团队失败');
      }

    } catch (error) {
      console.error('❌ 创建团队失败:', error);
      wx.showToast({
        title: error.message || '创建团队失败',
        icon: 'none',
        duration: 2000
      });
    } finally {
      this.setData({ isCreating: false });
    }
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('=== createTeam页面加载 ===');
    
    // 获取用户信息
    this.getUserInfo();
    
    // 检查团队图标路径
    if (this.data.teamIcons.length > 0) {
      console.log('团队图标数量:', this.data.teamIcons.length);
      console.log('第一个图标路径:', this.data.teamIcons[0].path);
    }
  },

  /**
   * 获取用户信息
   */
  getUserInfo() {
    try {
      // 尝试从缓存获取用户信息
      const userInfo = wx.getStorageSync('userInfo');
      const userNickname = wx.getStorageSync('userNickname');
      
      if (userInfo || userNickname) {
        const nickname = userNickname || (userInfo && userInfo.nickName) || '匿名用户';
        this.setData({
          userNickname: nickname,
          hasUserInfo: true
        });
        console.log('✅ 获取到用户信息:', nickname);
      } else {
        console.log('❌ 未获取到用户信息，使用默认值');
      }
    } catch (error) {
      console.error('获取用户信息失败:', error);
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