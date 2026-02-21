// pages/profile/profile.js
Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 用户信息
    avatarUrl: '/images/userLogin.png', // 默认头像
    nickname: '',
    
    // 页面状态
    isAvatarSelected: false,
    isProfileValid: false,
    isLoading: false,
    
    
    // 页面参数
    loginCode: '',
    userType: 'new', // new: 新用户, wechat: 微信用户, local: 本地用户
    
    // 默认头像列表（用于跳过选择的备选）
    defaultAvatars: [
      '/images/avatar-1.png',
      '/images/avatar-2.png', 
      '/images/avatar-3.png',
      '/images/avatar-4.png'
    ]
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('用户信息收集页面加载，参数:', options);
    
    // 保存页面参数
    this.setData({
      userType: options.type || 'new'
    });
    
    // 根据用户类型初始化页面
    this.initByUserType();
  },

  /**
   * 根据用户类型初始化页面
   */
  initByUserType() {
    const userInfo = wx.getStorageSync('userInfo');
    
    switch (this.data.userType) {
      case 'wechat':
        // 微信用户：迁移现有数据
        if (userInfo && userInfo.nickName) {
          this.setData({
            avatarUrl: userInfo.avatarUrl || '/images/avatar.png',
            nickname: userInfo.nickName,
            isAvatarSelected: !!userInfo.avatarUrl,
            isProfileValid: true
          });
          this.setData({
            nicknameHint: '检测到您之前的微信头像和昵称，可以修改或直接保存'
          });
        }
        break;
        
      case 'local':
        // 本地用户：提示完善信息
        this.setData({
          nicknameHint: '完善个人信息，享受更好的服务体验'
        });
        break;
        
      default:
        // 新用户：默认提示
        this.setData({
          nicknameHint: '昵称将用于显示您的身份'
        });
        break;
    }
    
    // 更新表单验证状态
    this.checkFormValidity();
  },

  /**
   * 选择头像
   */
  onChooseAvatar(e) {
    console.log('选择头像:', e.detail);
    
    const { avatarUrl } = e.detail;
    
    // 微信已处理安全检测，直接使用
    this.setData({ 
      avatarUrl,
      isAvatarSelected: true 
    });
    
    // 更新表单验证状态
    this.checkFormValidity();
    
    wx.showToast({
      title: '头像选择成功',
      icon: 'success',
      duration: 1500
    });
  },

  /**
   * 昵称输入处理
   */
  onNicknameInput(e) {
    const nickname = e.detail.value;
    
    this.setData({ nickname });
    
    // 实时验证昵称格式
    this.validateNickname(nickname);
    
    // 更新表单验证状态
    this.checkFormValidity();
  },

  /**
   * 验证昵称格式
   */
  validateNickname(nickname) {
    if (!nickname || nickname.trim().length === 0) {
      this.setData({
        nicknameHint: '请输入昵称（1-15个字符）',
        isProfileValid: false
      });
      return false;
    }
    
    if (nickname.length < 1 || nickname.length > 15) {
      this.setData({
        nicknameHint: '昵称长度应在1-15个字符之间',
        isProfileValid: false
      });
      return false;
    }
    
    // 检查昵称是否只包含允许的字符
    const validPattern = /^[\u4e00-\u9fa5a-zA-Z0-9\s\-\.\_]+$/;
    if (!validPattern.test(nickname)) {
      this.setData({
        nicknameHint: '昵称包含不允许的字符',
        isProfileValid: false
      });
      return false;
    }
    
    this.setData({
      nicknameHint: '昵称格式正确',
      isProfileValid: true
    });
    return true;
  },

  /**
   * 检查表单整体有效性
   */
  checkFormValidity() {
    const { nickname, isAvatarSelected } = this.data;
    const isNicknameValid = this.validateNickname(nickname);
    
    // 只要有昵称就认为表单有效（头像可选）
    const isValid = isNicknameValid;
    
    this.setData({
      isProfileValid: isValid
    });
    
    return isValid;
  },

  /**
   * 表单提交处理（确保安全检测）
   */
  onFormSubmit(e) {
    console.log('表单提交:', e.detail);
    
    const nickname = e.detail.value.nickname;
    if (nickname) {
      this.setData({ nickname });
      this.checkFormValidity();
    }
  },

  /**
   * 保存用户信息
   */
  saveProfile() {
    if (!this.data.isProfileValid) {
      wx.showToast({
        title: '请完善信息',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    this.setData({ isLoading: true });
    
    // 模拟异步保存过程
    setTimeout(() => {
      this.saveUserInfo();
    }, 500);
  },

  /**
   * 实际保存用户信息
   */
  saveUserInfo() {
    const { avatarUrl, nickname, userType, loginCode } = this.data;
    
    // 构建新的用户信息结构
    const userInfo = {
      nickName: nickname.trim(),
      avatarUrl: avatarUrl,
      isCustomAvatar: true, // 标记为自定义信息
      profileComplete: true,
      createTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
      dataSource: 'custom', // 数据来源：自定义
      migrationStatus: userType === 'wechat' ? 'migrated' : 'new'
    };
    
    console.log('保存用户信息:', userInfo);
    
    // 获取用户标识
    const openid = this.getUserOpenId(loginCode);
    
    // 保存到本地存储
    this.saveToLocalStorage(userInfo, openid);
    
    // 保存到云端
    this.saveToCloud(userInfo, openid)
      .then(() => {
        this.setData({ isLoading: false });
        this.showSuccessAndNavigate();
      })
      .catch(error => {
        console.error('保存到云端失败:', error);
        this.setData({ isLoading: false });
        
        // 即使云端失败，本地保存成功也要继续
        this.showSuccessAndNavigate();
      });
  },

  /**
   * 获取用户OpenID
   */
  getUserOpenId(loginCode) {
    // 尝试获取现有的openid
    let openid = wx.getStorageSync('userOpenId');
    
    if (!openid) {
      // 生成新的本地标识
      openid = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    return openid;
  },

  /**
   * 保存到本地存储
   */
  saveToLocalStorage(userInfo, openid) {
    // 保存用户信息
    wx.setStorageSync('userInfo', userInfo);
    wx.setStorageSync('userNickname', userInfo.nickName);
    wx.setStorageSync('userOpenId', openid);
    
    // 保存完整的用户数据
    const userData = {
      openid: openid,
      userInfo: userInfo,
      loginTime: new Date().toISOString(),
      profileVersion: '2.0' // 标记为新版本格式
    };
    
    wx.setStorageSync('userLoginData', userData);
    
    console.log('用户信息保存到本地完成');
  },

  /**
   * 保存到云端
   */
  saveToCloud(userInfo, openid) {
    return new Promise((resolve, reject) => {
      // 调用云函数保存用户信息
      wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'updateUserProfile',
          openid: openid,
          userInfo: userInfo,
          userType: this.data.userType
        },
        success: (res) => {
          console.log('用户信息保存到云端成功:', res);
          resolve(res);
        },
        fail: (err) => {
          console.error('用户信息保存到云端失败:', err);
          reject(err);
        }
      });
    });
  },

  /**
   * 显示成功提示并导航
   */
  showSuccessAndNavigate() {
    wx.showToast({
      title: `欢迎${this.data.nickname}`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟后返回首页
    setTimeout(() => {
      wx.switchTab({
        url: '/pages/index/index'
      });
    }, 1500);
  },

  /**
   * 跳过信息设置
   */
  skipProfile() {
    wx.showModal({
      title: '跳过设置',
      content: '跳过设置将使用默认信息，您可以在个人中心随时修改',
      confirmText: '确定跳过',
      cancelText: '继续设置',
      success: (res) => {
        if (res.confirm) {
          this.saveDefaultProfile();
        }
      }
    });
  },

  /**
   * 保存默认用户信息
   */
  saveDefaultProfile() {
    this.setData({ isLoading: true });
    
    // 生成随机昵称
    const randomNickname = this.generateRandomNickname();
    // 选择随机默认头像
    const randomAvatar = this.data.defaultAvatars[
      Math.floor(Math.random() * this.data.defaultAvatars.length)
    ] || '/images/avatar.png';
    
    const userInfo = {
      nickName: randomNickname,
      avatarUrl: randomAvatar,
      isCustomAvatar: false, // 标记为系统生成
      profileComplete: false, // 标记为不完整
      createTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
      dataSource: 'system',
      migrationStatus: 'skipped'
    };
    
    const openid = this.getUserOpenId(this.data.loginCode);
    
    // 保存到本地
    this.saveToLocalStorage(userInfo, openid);
    
    this.setData({ isLoading: false });
    
    wx.showToast({
      title: '已使用默认信息',
      icon: 'success',
      duration: 1500
    });
    
    setTimeout(() => {
      wx.switchTab({
        url: '/pages/index/index'
      });
    }, 1000);
  },

  /**
   * 生成随机昵称
   */
  generateRandomNickname() {
    const prefixes = ['静心', '觉察', '冥想', '修行', '禅意', '平和', '安宁'];
    const suffixes = ['者', '人', '客', '士', '师', '友', '生'];
    
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    
    return prefix + suffix + Math.floor(Math.random() * 1000);
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
    return {
      title: '完善个人信息，开始冥想之旅',
      path: '/pages/profile/profile'
    };
  }
})