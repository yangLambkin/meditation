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
   * 实际保存用户信息（包含微信登录流程）
   */
  async saveUserInfo() {
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
      
      // 7. 保存到云端
      await this.saveToCloud(userInfo, wechatOpenId);
      
      this.setData({ isLoading: false });
      
      // 登录成功后检查勋章解锁条件
      this.checkBadgeAfterLogin();
      
      this.showSuccessAndNavigate();
      
    } catch (error) {
      console.error('微信登录流程失败，降级为本地模式:', error);
      
      // 降级处理：使用原有的本地标识逻辑
      const openid = this.getUserOpenId(loginCode);
      
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
   * 获取微信openid（登录流程）
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
   * 建立用户映射关系
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
   * 迁移本地数据到新用户标识
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
   * 获取用户OpenID（兼容原有逻辑）
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
   * 登录成功后检查勋章解锁条件
   */
  checkBadgeAfterLogin() {
    console.log('🔍 登录成功后检查勋章解锁条件');
    
    try {
      // 动态引入勋章管理器
      const badgeManager = require('../../utils/badgeManager.js');
      
      // 延迟执行，确保登录流程完全完成
      setTimeout(() => {
        // 从本地缓存获取用户统计数据
        const checkinManager = require('../../utils/checkin.js');
        const localStats = checkinManager.getUserStats();
        
        console.log('📊 登录后检查勋章条件，用户统计:', localStats);
        
        // 检查勋章解锁条件
        const userStats = {
          currentStreak: localStats.currentStreak || 0,
          totalCheckinDays: localStats.totalDays || 0,
          lastDuration: localStats.lastDuration || 0,
          totalDuration: localStats.totalDuration || 0
        };
        
        const hasUnlocked = badgeManager.checkBadgeUnlock(userStats);
        
        if (hasUnlocked) {
          console.log('🎉 登录后检测到新勋章解锁！');
          
          // 显示勋章解锁提示
          wx.showToast({
            title: '恭喜解锁新勋章！',
            icon: 'success',
            duration: 3000
          });
        }
      }, 1000); // 延迟1秒确保登录流程完成
      
    } catch (error) {
      console.warn('勋章检查失败（不影响登录流程）:', error.message);
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
    return {
      title: '完善个人信息，开始冥想之旅',
      path: '/pages/profile/profile'
    };
  }
})