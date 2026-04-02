// subpackages/chattool/pages/login/login.js
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
    redirectUrl: '', // 登录成功后跳转的页面
    teamId: '', // 需要加入的团队ID
    
    // 默认头像列表
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
    console.log('聊天工具子包登录页面加载，参数:', options);
    
    // 保存页面参数
    this.setData({
      redirectUrl: options.redirectUrl || '',
      teamId: options.teamId || ''
    });
    
    // 检查是否已登录
    if (this.hasUserInfo()) {
      console.log('用户已登录，直接跳转');
      this.redirectAfterLogin();
      return;
    }
    
    // 初始化页面
    this.initPage();
  },

  /**
   * 初始化页面
   */
  initPage() {
    // 检查是否有缓存的用户信息
    const userInfo = wx.getStorageSync('userInfo');
    
    // 支持新旧格式的用户信息
    const hasValidUserInfo = userInfo && 
                           (userInfo.nickName || 
                            (userInfo.isCustomAvatar !== undefined && 
                             userInfo.profileComplete));
    
    if (hasValidUserInfo) {
      // 有完整的用户信息，直接使用
      const nickname = userInfo.nickName || '觉察者';
      
      this.setData({
        avatarUrl: userInfo.avatarUrl || '/images/avatar.png',
        nickname: nickname,
        isAvatarSelected: !!userInfo.avatarUrl,
        isProfileValid: true
      });
      
      this.setData({
        nicknameHint: '检测到您之前的头像和昵称，可以修改或直接保存'
      });
    } else {
      // 缓存中没有用户信息
      console.log('缓存中没有用户信息，需要登录');
      
      this.setData({
        nicknameHint: '昵称将用于显示您的身份'
      });
    }
    
    // 更新表单验证状态
    this.checkFormValidity();
  },

  /**
   * 检查用户是否有登录信息 - 完全复制主包逻辑
   */
  hasUserInfo() {
    const userInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    const userOpenId = wx.getStorageSync('userOpenId');
    
    console.log('用户信息检测 - userInfo:', userInfo, 'userNickname:', userNickname, 'userOpenId:', userOpenId);
    
    // 正确的用户状态检测逻辑：
    // 1. 真正登录：userOpenId以'oz'开头（微信openid）
    // 2. 本地用户：userOpenId以'local_'开头（未登录，但有本地标识）
    // 3. 未登录：没有任何用户信息
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const isLocalUser = userOpenId && userOpenId.startsWith('local_');
    
    // 只有当有微信登录信息或有用户昵称时，才认为是已登录
    const hasInfo = !!(isWechatLoggedIn || userInfo || userNickname);
    console.log('登录状态检测 - 微信登录:', isWechatLoggedIn, '本地用户:', isLocalUser, '有用户信息:', !!userInfo, '有昵称:', !!userNickname);
    console.log('hasUserInfo计算结果:', hasInfo);
    
    return hasInfo;
  },

  /**
   * 判断用户是否已登录（微信openid以'oz'开头）- 复制主包逻辑
   */
  isUserLoggedIn() {
    // 优先检查是否有微信openid存储在本地
    const wechatOpenId = wx.getStorageSync('userOpenId');
    if (wechatOpenId && wechatOpenId.startsWith('oz')) {
      return true;
    }
    
    // 如果本地存储中没有微信openid，再检查页面数据
    const userOpenId = this.data.userOpenId;
    return userOpenId && userOpenId.startsWith('oz');
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
   * 表单提交处理
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
    
    // 异步保存过程
    setTimeout(() => {
      this.saveUserInfo();
    }, 500);
  },

  /**
   * 实际保存用户信息（包含微信登录流程）- 复制主包逻辑
   */
  async saveUserInfo() {
    const { avatarUrl, nickname, redirectUrl, teamId } = this.data;
    
    // 构建新的用户信息结构
    const userInfo = {
      nickName: nickname.trim(),
      avatarUrl: avatarUrl,
      isCustomAvatar: true, // 标记为自定义信息
      profileComplete: true,
      createTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
      dataSource: 'custom', // 数据来源：自定义
      migrationStatus: 'new'
    };
    
    console.log('保存用户信息:', userInfo);
    
    try {
      // 1. 执行微信登录获取openid
      const wechatOpenId = await this.getWechatOpenId();
      
      // 2. 获取当前使用的localUserId
      const localUserId = wx.getStorageSync('localUserId');
      
      // 3. 建立用户映射关系
      if (localUserId && localUserId.startsWith('local_')) {
        this.createUserMapping(localUserId, wechatOpenId);
        
        // 4. 异步迁移本地数据（不影响主流程）
        this.migrateLocalData(localUserId, wechatOpenId)
          .then(success => {
            if (success) {
              console.log('✅ 数据迁移完成');
            } else {
              console.warn('⚠️ 数据迁移失败，但用户可继续使用');
            }
          });
      }
      
      // 5. 设置新的主标识
      wx.setStorageSync('userOpenId', wechatOpenId);
      
      console.log('✅ 微信登录完成，映射关系建立:', {
        from: localUserId,
        to: wechatOpenId
      });
      
      // 6. 保存用户信息到本地存储
      this.saveToLocalStorage(userInfo, wechatOpenId);
      
      // 7. 保存到云端（本地缓存为主，云端为辅）
      await this.saveToCloud(userInfo, wechatOpenId);
      
      this.setData({ isLoading: false });
      
      this.showSuccessAndNavigate();
      
    } catch (error) {
      console.error('微信登录流程失败，降级为本地模式:', error);
      
      // 降级处理：使用原有的本地标识逻辑
      const openid = this.getUserOpenId();
      
      // 保存到本地存储
      this.saveToLocalStorage(userInfo, openid);
      
      // 尝试保存到云端（即使失败也不影响）
      this.saveToCloud(userInfo, openid)
        .catch(cloudError => {
          console.warn('云端保存失败（不影响使用）:', cloudError);
        })
        .finally(() => {
          this.setData({ isLoading: false });
          this.showSuccessAndNavigate();
        });
    }
  },

  /**
   * 获取微信openid（登录流程）- 复制主包逻辑
   */
  async getWechatOpenId() {
    console.log('🔄 开始微信登录流程获取openid');
    
    try {
      // 1. 调用wx.login获取临时登录凭证
      const loginResult = await new Promise((resolve, reject) => {
        wx.login({
          success: resolve,
          fail: reject
        });
      });
      
      const code = loginResult.code;
      console.log('获取到微信登录code:', code);
      
      // 2. 调用云函数换取openid
      const cloudResult = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'login',
          code: code
        }
      });
      
      if (cloudResult.result && cloudResult.result.openid) {
        const openid = cloudResult.result.openid;
        console.log('✅ 成功获取微信openid:', openid);
        return openid;
      } else {
        throw new Error('云函数返回的openid为空');
      }
      
    } catch (error) {
      console.error('获取微信openid失败:', error);
      throw error; // 向上抛出错误，由调用方处理
    }
  },

  /**
   * 建立用户映射关系 - 复制主包逻辑
   */
  createUserMapping(localUserId, wechatOpenId) {
    const userMappings = wx.getStorageSync('userMappings') || {};
    
    userMappings[localUserId] = {
      wechatOpenId: wechatOpenId,
      mappedAt: Date.now(),
      migrated: false // 初始状态为未迁移
    };
    
    wx.setStorageSync('userMappings', userMappings);
    
    console.log('🔗 用户映射建立:', {
      local: localUserId,
      wechat: wechatOpenId
    });
  },

  /**
   * 迁移本地数据到新用户标识 - 复制主包逻辑
   */
  async migrateLocalData(fromLocalId, toOpenId) {
    try {
      // 1. 获取源数据
      const sourceKey = `meditation_checkin_${fromLocalId}`;
      const sourceData = wx.getStorageSync(sourceKey);
      
      if (!sourceData || Object.keys(sourceData.dailyRecords).length === 0) {
        console.log('✅ 源数据为空，无需迁移');
        return true;
      }
      
      console.log('发现需要迁移的数据，记录数:', Object.keys(sourceData.dailyRecords).length);
      
      // 2. 合并到目标数据
      const targetKey = `meditation_checkin_${toOpenId}`;
      const targetData = wx.getStorageSync(targetKey) || {
        dailyRecords: {},
        monthlyStats: {}
      };
      
      // 3. 合并打卡记录（避免重复）
      let migratedCount = 0;
      for (const [dateStr, dayData] of Object.entries(sourceData.dailyRecords)) {
        if (!targetData.dailyRecords[dateStr]) {
          targetData.dailyRecords[dateStr] = dayData;
          migratedCount++;
        } else {
          // 合并记录（如果目标日期没有记录）
          targetData.dailyRecords[dateStr].records.push(...dayData.records);
          targetData.dailyRecords[dateStr].count += dayData.count;
          migratedCount++;
        }
      }
      
      // 4. 保存目标数据
      wx.setStorageSync(targetKey, targetData);
      
      // 5. 标记源数据为已迁移
      wx.setStorageSync(`${sourceKey}_migrated`, true);
      
      // 6. 更新映射状态
      const userMappings = wx.getStorageSync('userMappings') || {};
      if (userMappings[fromLocalId]) {
        userMappings[fromLocalId].migrated = true;
        wx.setStorageSync('userMappings', userMappings);
      }
      
      console.log('✅ 数据迁移完成:', {
        from: fromLocalId,
        to: toOpenId,
        migratedRecords: migratedCount
      });
      
      return true;
      
    } catch (error) {
      console.warn('数据迁移失败，但不影响使用:', error);
      return false;
    }
  },

  /**
   * 获取用户OpenID（兼容原有逻辑）- 复制主包逻辑
   */
  getUserOpenId() {
    // 尝试获取现有的openid
    let openid = wx.getStorageSync('userOpenId');
    
    if (!openid) {
      // 生成新的本地标识
      openid = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    return openid;
  },

  /**
   * 保存到本地存储 - 复制主包逻辑
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
   * 保存到云端 - 复制主包逻辑
   */
  saveToCloud(userInfo, openid) {
    return new Promise((resolve, reject) => {
      // 调用云函数保存用户信息
      wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'updateUserProfile',
          openid: openid,
          userInfo: userInfo
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
   * 登录成功后跳转
   */
  redirectAfterLogin() {
    wx.showToast({
      title: `欢迎${this.data.nickname}`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟后跳转
    setTimeout(() => {
      console.log('🔍 登录成功，准备跳转:');
      console.log('  - teamId:', this.data.teamId);
      console.log('  - teamName:', this.data.teamName);
      
      if (this.data.teamId) {
        // 跳转到团队加入页面，并携带登录成功的标记
        const url = `/subpackages/chattool/pages/joinTeam/joinTeam?teamId=${this.data.teamId}&fromLogin=true&teamName=${encodeURIComponent(this.data.teamName || '')}&teamIcon=${encodeURIComponent(this.data.teamIcon || '')}&inviterName=${encodeURIComponent(this.data.inviterName || '')}`;
        console.log('  - 跳转到joinTeam:', url);
        
        wx.navigateTo({
          url: url
        });
      } else if (this.data.redirectUrl) {
        // 跳转到指定页面
        console.log('  - 跳转到redirectUrl:', this.data.redirectUrl);
        wx.navigateTo({
          url: this.data.redirectUrl
        });
      } else {
        // 默认跳转到聊天工具邀请页面
        console.log('  - 跳转到默认页面');
        wx.navigateTo({
          url: '/subpackages/chattool/pages/invite/invite'
        });
      }
    }, 1500);
  },

  /**
   * 显示成功提示并导航 - 复制主包逻辑
   */
  showSuccessAndNavigate() {
    wx.showToast({
      title: `欢迎${this.data.nickname}`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟后返回
    setTimeout(() => {
      this.redirectAfterLogin();
    }, 1500);
  },

  /**
   * 跳过信息设置 - 复制主包逻辑
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
   * 保存默认用户信息 - 复制主包逻辑
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
    
    const openid = this.getUserOpenId();
    
    // 保存到本地
    this.saveToLocalStorage(userInfo, openid);
    
    this.setData({ isLoading: false });
    
    wx.showToast({
      title: '已使用默认信息',
      icon: 'success',
      duration: 1500
    });
    
    setTimeout(() => {
      this.redirectAfterLogin();
    }, 1000);
  },

  /**
   * 生成随机昵称 - 复制主包逻辑
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
      path: '/subpackages/chattool/pages/login/login'
    };
  }
})