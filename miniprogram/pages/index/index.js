// pages/index/index.js
Page({
  data: {
    currentYear: 2026,
    currentMonth: 1,
    calendarDays: [],
    checkedDates: [], // 存储已打卡的日期
    todayDate: "", // 今天的日期
    userOpenId: '', // 当前用户标识
    monthlyCount: 0, // 本月打卡总次数
    userNickname: '觉察者', // 用户昵称，默认为"觉察者"
    wisdomQuote: '"静心即是修心，心安即是归处。"', // 每日一言金句
    currentUserRank: 1, // 当前用户排名，默认为1
    hasUserInfo: false // 是否已获取用户信息
  },

  /**
   * 获取用户openId
   */
  getUserOpenId: function() {
    // 使用本地生成的唯一ID作为用户标识
    const localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      const newLocalUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', newLocalUserId);
      this.setData({
        userOpenId: newLocalUserId
      }, () => {
        // 用户ID设置完成后更新数据
        this.generateCalendar();
        this.updateMonthlyCount();
        // 获取用户昵称
        this.getUserNickname();
        // 计算用户排名
        this.calculateUserRank();
      });
    } else {
      this.setData({
        userOpenId: localUserId
      }, () => {
        // 用户ID设置完成后更新数据
        this.generateCalendar();
        this.updateMonthlyCount();
        // 获取用户昵称
        this.getUserNickname();
        // 计算用户排名
        this.calculateUserRank();
      });
    }
  },

  /**
   * 检查用户信息缓存
   */
  checkUserInfoCache: function() {
    // 检查缓存中是否有完整的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    // 支持新旧格式的用户信息
    const hasValidUserInfo = cachedUserInfo && 
                           (cachedUserInfo.nickName || 
                            (cachedUserInfo.isCustomAvatar !== undefined && 
                             cachedUserInfo.profileComplete));
    
    if (hasValidUserInfo) {
      // 有完整的用户信息，直接使用
      const nickname = cachedUserInfo.nickName || '觉察者';
      
      this.setData({
        userNickname: nickname,
        hasUserInfo: true
      });
      console.log('从缓存获取用户昵称:', nickname);
    } else {
      // 缓存中没有用户信息，显示授权必需提示
      console.log('缓存中没有用户信息，显示授权提示');
      this.showAuthRequiredModal();
      
      // 设置默认昵称并显示授权按钮
      this.setData({
        userNickname: '觉察者',
        hasUserInfo: false
      });
    }
  },

  /**
   * 获取用户昵称（支持新旧格式）
   */
  getUserNickname: function() {
    // 尝试从缓存获取用户昵称
    const cachedNickname = wx.getStorageSync('userNickname');
    if (cachedNickname) {
      this.setData({
        userNickname: cachedNickname
      });
      return;
    }
    
    // 尝试从用户信息中获取昵称
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.nickName) {
      this.setData({
        userNickname: cachedUserInfo.nickName
      });
      // 同时保存到独立的昵称缓存
      wx.setStorageSync('userNickname', cachedUserInfo.nickName);
      return;
    }
    
    // 如果没有用户昵称，设置默认昵称"微信用户"
    this.setData({
      userNickname: '微信用户'
    });
  },

  /**
   * 显示登录模态框（直接跳转到用户信息收集页面）
   */
  showLoginModal: function() {
    console.log('=== showLoginModal函数被调用 ===');
    
    // 直接调用新的登录流程，跳转到用户信息收集页面
    this.getUserInfoDirectly();
    
    console.log('=== showLoginModal函数执行完成 ===');
  },

  /**
   * 开始微信登录流程 - 使用新的个人信息收集方式
   */
  startWechatLogin: function() {
    console.log('开始新的微信登录流程');
    
    // 直接使用新的登录流程
    this.getUserInfoDirectly();
  },

  /**
   * 获取微信用户身份标识（openid）- 已弃用，使用本地生成的ID
   */
  getWechatOpenId: function() {
    console.log('=== 获取用户标识ID ===');
    
    return new Promise((resolve, reject) => {
      try {
        // 不再使用微信登录，直接使用本地生成的标识
        const localOpenId = wx.getStorageSync('wechatOpenId');
        if (!localOpenId) {
          const newOpenId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          wx.setStorageSync('wechatOpenId', newOpenId);
          resolve(newOpenId);
        } else {
          resolve(localOpenId);
        }
      } catch (error) {
        console.error('获取用户标识失败:', error);
        reject(error);
      }
    });
  },

  /**
   * 新的登录流程 - 替代原有的getUserInfoDirectly
   */
  getUserInfoDirectly: function() {
    console.log('=== 启动新的用户信息收集流程 ===');
    
    // 直接检查用户信息状态，并设置跳转标志
    this.checkUserInfoStatus(true);
  },

  /**
   * 检查用户信息状态
   */
  checkUserInfoStatus: function(shouldNavigate = false) {
    console.log('检查用户信息状态，是否跳转:', shouldNavigate);
    
    // 首先尝试从缓存读取最新的用户信息
    const existingUserInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    
    console.log('缓存中的用户信息:', existingUserInfo);
    console.log('缓存中的用户昵称:', userNickname);
    
    // 如果有用户信息，直接显示（无论是什么类型）
    if (existingUserInfo && existingUserInfo.nickName) {
      console.log('找到用户信息，直接登录');
      this.setData({
        userNickname: existingUserInfo.nickName,
        hasUserInfo: true
      });
      console.log('用户登录状态已更新:', this.data.hasUserInfo, this.data.userNickname);
      return;
    }
    
    // 如果有独立的昵称缓存，也认为是已登录
    if (userNickname) {
      console.log('找到独立昵称缓存，直接登录');
      this.setData({
        userNickname: userNickname,
        hasUserInfo: true
      });
      console.log('用户登录状态已更新:', this.data.hasUserInfo, this.data.userNickname);
      return;
    }
    
    // 如果没有用户信息，检查用户类型并决定处理方式
    const userType = this.detectUserTypeAndMigration(existingUserInfo);
    
    console.log('用户类型检测结果:', userType);
    
    // 如果没有用户信息，设置未登录状态
    this.setData({
      userNickname: '点击登录',
      hasUserInfo: false
    });
    
    // 只有当用户主动点击"点击登录"时才跳转
    if (shouldNavigate) {
      switch (userType.type) {
        case 'wechat':
          // 微信用户：迁移现有数据
          this.handleExistingUser(existingUserInfo, userType);
          break;
          
        case 'custom':
          // 已使用新格式的用户：直接使用
          console.log('用户已使用新格式，直接登录');
          if (existingUserInfo && existingUserInfo.nickName) {
            this.setData({
              userNickname: existingUserInfo.nickName,
              hasUserInfo: true
            });
          }
          break;
          
        case 'local':
        case 'new':
        default:
          // 新用户或本地用户：跳转到信息收集页面
          console.log(`跳转到profile页面，用户类型: ${userType.type}`);
          wx.navigateTo({
            url: `/pages/profile/profile?type=${userType.type}`,
            success: (res) => {
              console.log('跳转profile页面成功:', res);
            },
            fail: (err) => {
              console.error('跳转profile页面失败:', err);
            }
          });
          break;
      }
    }
  },

  /**
   * 检测用户类型和迁移需求
   */
  detectUserTypeAndMigration: function(userInfo) {
    if (!userInfo) {
      return { type: 'new', needsMigration: false };
    }
    
    // 检查是否是新格式的用户信息
    if (userInfo.isCustomAvatar !== undefined) {
      return { type: 'custom', needsMigration: false };
    }
    
    // 检查是否是微信获取的用户信息（旧格式）
    if (userInfo.nickName && userInfo.avatarUrl) {
      return { type: 'wechat', needsMigration: true };
    }
    
    // 检查是否有本地用户标识
    const localUserId = wx.getStorageSync('localUserId');
    if (localUserId) {
      return { type: 'local', needsMigration: true };
    }
    
    return { type: 'new', needsMigration: false };
  },

  /**
   * 处理现有用户数据迁移
   */
  handleExistingUser: function(oldUserInfo, userType) {
    console.log('处理现有用户数据迁移');
    
    if (userType.needsMigration) {
      // 需要迁移：跳转到信息收集页面进行迁移
      wx.navigateTo({
        url: '/pages/profile/profile?type=wechat'
      });
    } else {
      // 已迁移或无需迁移：直接使用
      this.setData({
        userNickname: oldUserInfo.nickName,
        hasUserInfo: true
      });
      
      wx.showToast({
        title: `欢迎回来，${oldUserInfo.nickName}`,
        icon: 'success',
        duration: 2000
      });
    }
  },

  /**
   * 基础登录流程（没有用户详细信息）
   */
  basicLoginProcess: function() {
    console.log('=== 开始基础登录流程 ===');
    
    // 获取用户openid
    const openid = wx.getStorageSync('wechatOpenId') || 'openid_' + Date.now();
    const nickname = '微信用户';
    
    // 保存基础用户信息（只有openid）
    this.saveBasicUserInfo(openid);
    
    // 更新页面显示
    this.setData({
      userNickname: nickname,
      hasUserInfo: false
    });
    
    // 显示基础登录成功提示
    wx.showToast({
      title: `欢迎使用小程序`,
      icon: 'success',
      duration: 2000
    });
  },

  /**
   * 获取用户信息 - 已弃用（微信getUserProfile接口已关闭）
   */
  getUserProfile: function(loginCode) {
    console.warn('⚠️ wx.getUserProfile接口已关闭，使用新的登录流程');
    
    // 提示用户使用新的登录方式
    wx.showModal({
      title: '登录方式更新',
      content: '微信登录方式已更新，请使用新的个人信息收集功能',
      showCancel: false,
      confirmText: '确定',
      success: (res) => {
        if (res.confirm) {
          // 跳转到新的登录流程
          this.getUserInfoDirectly();
        }
      }
    });
  },

  /**
   * 保存基础用户信息（只有openid，没有用户详细信息）
   */
  saveBasicUserInfo: function(openid) {
    console.log('保存基础用户信息，openid:', openid);
    
    // 保存到本地缓存
    wx.setStorageSync('userOpenId', openid);
    wx.setStorageSync('userNickname', '微信用户');
    
    // 保存到云数据库（只有openid）
    this.saveBasicUserToCloud(openid);
  },

  /**
   * 保存完整用户信息（包含昵称、头像等）
   */
  saveUserInfo: async function(userInfo, openid) {
    console.log('保存完整用户信息，openid:', openid);
    
    // 检查是否是新的用户信息格式
    const isNewFormat = userInfo.isCustomAvatar !== undefined;
    
    if (!isNewFormat) {
      // 旧格式：转换为新格式
      userInfo = this.convertToNewFormat(userInfo);
    }
    
    // 保存用户信息到本地缓存
    wx.setStorageSync('userInfo', userInfo);
    wx.setStorageSync('userNickname', userInfo.nickName);
    wx.setStorageSync('userOpenId', openid);
    
    // 保存用户数据到本地
    const userData = {
      openid: openid,
      userInfo: userInfo,
      loginTime: new Date().toISOString(),
      profileVersion: '2.0'
    };
    
    wx.setStorageSync('userLoginData', userData);
    
    // 保存用户信息到云数据库
    this.saveUserToCloud(userInfo, openid);
    
    // 检查并处理数据迁移
    await this.handleDataMigration(openid);
    
    console.log('用户信息保存完成:', userData);
  },

  /**
   * 将旧格式用户信息转换为新格式
   */
  convertToNewFormat: function(oldUserInfo) {
    return {
      nickName: oldUserInfo.nickName,
      avatarUrl: oldUserInfo.avatarUrl,
      gender: oldUserInfo.gender,
      country: oldUserInfo.country,
      province: oldUserInfo.province,
      city: oldUserInfo.city,
      isCustomAvatar: false, // 标记为微信获取
      profileComplete: true,
      dataSource: 'wechat',
      migrationStatus: 'converted',
      originalInfo: oldUserInfo, // 保留原始信息
      createTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString()
    };
  },
  
  /**
   * 处理用户数据迁移
   */
  handleDataMigration: async function(openid) {
    try {
      // 获取本地用户ID
      const localUserId = wx.getStorageSync('localUserId');
      
      if (!localUserId) {
        console.log('没有本地用户ID，无需数据迁移');
        return;
      }
      
      console.log(`开始检查数据迁移: openid=${openid}, localUserId=${localUserId}`);
      
      // 检查本地是否有未同步的数据
      const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
      const localRecords = allUserRecords[localUserId];
      
      if (!localRecords || !localRecords.dailyRecords || Object.keys(localRecords.dailyRecords).length === 0) {
        console.log('本地没有打卡记录，无需迁移');
        return;
      }
      
      // 静默执行数据迁移
      console.log(`检测到${Object.keys(localRecords.dailyRecords).length}天的本地打卡记录，开始静默迁移...`);
      await this.silentDataMigration(openid, localUserId, localRecords);
      
    } catch (error) {
      console.error('处理数据迁移失败:', error);
    }
  },
  
  /**
   * 静默执行数据迁移（无用户提示）
   */
  silentDataMigration: async function(openid, localUserId, localRecords) {
    try {
      console.log('开始静默数据迁移...');
      
      // 调用云函数创建用户映射
      const migrationResult = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'migrateLocalData',
          openid: openid,
          localUserId: localUserId
        }
      });
      
      if (migrationResult.result.success) {
        console.log('静默数据迁移成功');
        
        // 标记本地记录为已迁移
        this.markRecordsAsMigrated(openid, localUserId);
        
        // 静默更新日历显示（无提示）
        this.generateCalendar();
        
      } else {
        console.warn('静默数据迁移失败:', migrationResult.result.error);
      }
      
    } catch (error) {
      console.error('静默数据迁移执行失败:', error);
      // 静默失败，不提示用户
    }
  },

  /**
   * 执行数据迁移（保留原有函数，但不再使用）
   */
  performDataMigration: async function(openid, localUserId, localRecords) {
    try {
      wx.showLoading({
        title: '数据迁移中...',
        mask: true
      });
      
      console.log('开始执行数据迁移...');
      
      // 调用云函数创建用户映射
      const migrationResult = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'migrateLocalData',
          openid: openid,
          localUserId: localUserId
        }
      });
      
      if (migrationResult.result.success) {
        console.log('用户映射创建成功');
        
        // 标记本地记录为已迁移
        this.markRecordsAsMigrated(openid, localUserId);
        
        wx.hideLoading();
        wx.showToast({
          title: '数据迁移成功',
          icon: 'success',
          duration: 2000
        });
        
        // 更新日历显示
        this.generateCalendar();
        
      } else {
        throw new Error(migrationResult.result.error);
      }
      
    } catch (error) {
      wx.hideLoading();
      console.error('数据迁移执行失败:', error);
      wx.showToast({
        title: '迁移失败，请重试',
        icon: 'none',
        duration: 2000
      });
    }
  },
  
  /**
   * 标记记录为已迁移
   */
  markRecordsAsMigrated: function(openid, localUserId) {
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    
    if (allUserRecords[localUserId]) {
      // 添加迁移标记
      allUserRecords[localUserId].migrated = true;
      allUserRecords[localUserId].migratedTo = openid;
      allUserRecords[localUserId].migrationTime = new Date().toISOString();
      
      wx.setStorageSync('meditationUserRecords', allUserRecords);
      console.log('标记本地记录为已迁移');
    }
  },

  /**
   * 保存基础用户信息到云数据库（只有openid）
   */
  saveBasicUserToCloud: function(openid) {
    console.log('保存基础用户信息到云数据库，openid:', openid);
    
    const db = wx.cloud.database();
    const usersCollection = db.collection('users');
    
    // 检查用户是否已存在（使用_openid作为标识）
    usersCollection.where({
      _openid: openid
    }).get({
      success: (res) => {
        if (res.data.length > 0) {
          // 用户已存在，更新最后登录时间
          console.log('用户已存在，更新最后登录时间');
          usersCollection.doc(res.data[0]._id).update({
            data: {
              lastLoginTime: new Date(),
              loginCount: wx.cloud.database().command.inc(1)
            }
          }).then(res => {
            console.log('用户信息更新成功:', res);
          }).catch(err => {
            console.error('用户信息更新失败:', err);
          });
        } else {
          // 用户不存在，创建新用户
          console.log('用户不存在，创建新用户');
          usersCollection.add({
            data: {
              openid: openid,
              nickName: '微信用户',
              createTime: new Date(),
              lastLoginTime: new Date(),
              loginCount: 1
            }
          }).then(res => {
            console.log('基础用户信息保存到云数据库成功:', res);
          }).catch(err => {
            console.error('基础用户信息保存到云数据库失败:', err);
          });
        }
      },
      fail: (err) => {
        console.error('查询用户信息失败:', err);
      }
    });
  },

  /**
   * 保存用户信息到云数据库
   */
  saveUserToCloud: function(userInfo, userOpenId) {
    console.log('开始保存用户信息到云数据库');
    
    const db = wx.cloud.database();
    const usersCollection = db.collection('users');
    
    // 准备更新数据，支持新格式
    const updateData = {
      nickName: userInfo.nickName,
      avatarUrl: userInfo.avatarUrl,
      lastLoginTime: new Date(),
      loginCount: wx.cloud.database().command.inc(1)
    };
    
    // 添加新格式的字段（如果存在）
    if (userInfo.isCustomAvatar !== undefined) {
      updateData.isCustomAvatar = userInfo.isCustomAvatar;
      updateData.profileComplete = userInfo.profileComplete || true;
      updateData.dataSource = userInfo.dataSource || 'custom';
      updateData.migrationStatus = userInfo.migrationStatus || 'new';
    }
    
    // 添加传统字段（如果存在）
    if (userInfo.gender !== undefined) updateData.gender = userInfo.gender;
    if (userInfo.country !== undefined) updateData.country = userInfo.country;
    if (userInfo.province !== undefined) updateData.province = userInfo.province;
    if (userInfo.city !== undefined) updateData.city = userInfo.city;
    
    // 检查用户是否已存在（使用_openid作为标识）
    usersCollection.where({
      _openid: userOpenId
    }).get({
      success: (res) => {
        if (res.data.length > 0) {
          // 用户已存在，更新用户信息
          console.log('用户已存在，更新用户信息，头像URL:', userInfo.avatarUrl);
          usersCollection.doc(res.data[0]._id).update({
            data: updateData
          }).then(res => {
            console.log('用户信息更新成功:', res);
          }).catch(err => {
            console.error('用户信息更新失败:', err);
          });
        } else {
          // 用户不存在，创建新用户
          console.log('用户不存在，创建新用户，头像URL:', userInfo.avatarUrl);
          
          const createData = {
            ...updateData,
            createTime: new Date()
          };
          
          usersCollection.add({
            data: createData
          }).then(res => {
            console.log('用户信息保存到云数据库成功:', res);
          }).catch(err => {
            console.error('用户信息保存到云数据库失败:', err);
          });
        }
      },
      fail: (err) => {
        console.error('查询用户信息失败:', err);
        // 如果查询失败，尝试直接创建用户
        const createData = {
          _openid: userOpenId,
          ...updateData,
          createTime: new Date()
        };
        
        usersCollection.add({
          data: createData
        }).then(res => {
          console.log('用户信息保存到云数据库成功（直接创建）:', res);
        }).catch(err => {
          console.error('用户信息保存到云数据库失败（直接创建）:', err);
        });
      }
    });
  },

  /**
   * 触发用户登录（已弃用授权，使用新的信息收集方式）
   */
  triggerUserLogin: function() {
    console.log('触发用户登录');
    
    // 设置用户未登录状态
    this.setData({
      hasUserInfo: false
    });
    
    // 跳转到用户信息收集页面
    this.getUserInfoDirectly();
  },

  /**
   * 用户信息收集回调（已弃用微信授权）
   */
  onUserInfoCollected: function(userInfo) {
    console.log('用户信息收集完成:', userInfo);
    
    if (userInfo) {
      const nickname = userInfo.nickName;
      
      console.log('用户信息收集成功，昵称:', nickname);
      
      // 保存到缓存
      wx.setStorageSync('userInfo', userInfo);
      wx.setStorageSync('userNickname', nickname);
      
      // 更新页面显示
      this.setData({
        userNickname: nickname,
        hasUserInfo: true
      }, () => {
        console.log('页面数据更新完成');
      });
      
      wx.showToast({
        title: '登录成功',
        icon: 'success',
        duration: 1500
      });
    } else {
      console.log('用户信息收集失败');
      
      // 用户取消信息收集，可以继续使用基础功能
      wx.showToast({
        title: '您可以继续使用基础功能',
        icon: 'none',
        duration: 1500
      });
    }
  },

  /**
   * 检查用户信息，当无法获取userNickname时显示授权信息
   */
  checkUserInfo: function() {
    console.log('=== checkUserInfo函数开始执行 ===');
    console.log('当前页面数据 userNickname:', this.data.userNickname);
    console.log('当前页面数据 hasUserInfo:', this.data.hasUserInfo);
    
    // 获取缓存的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    console.log('缓存中 userInfo:', cachedUserInfo);
    
    const cachedNickname = wx.getStorageSync('userNickname');
    console.log('缓存中 userNickname:', cachedNickname);
    
    if (cachedUserInfo && cachedUserInfo.nickName) {
      // 有用户信息，显示欢迎信息
      console.log('用户已授权，显示欢迎信息');
      // 确保页面数据正确更新
      this.setData({
        userNickname: cachedUserInfo.nickName,
        hasUserInfo: true
      }, () => {
        console.log('页面数据更新完成，userNickname:', this.data.userNickname);
      });
      
      wx.showToast({
        title: `欢迎回来，${cachedUserInfo.nickName}`,
        icon: 'none',
        duration: 2000
      });
    } else {
      // 无法获取用户信息，显示授权窗口
      console.log('无法获取用户信息，显示授权窗口');
      this.showAuthRequiredModal();
    }
    
    console.log('=== checkUserInfo函数执行完成 ===');
  },

  /**
   * 显示授权必需提示
   */
  showAuthRequiredModal: function() {
    wx.showModal({
      title: '授权提示',
      content: '欢迎使用觉察计时小程序！使用本小程序需要授权获取您的昵称信息。',
      showCancel: false,
      confirmText: '立即授权',
      success: (res) => {
        if (res.confirm) {
          // 用户确认，继续显示授权按钮
          console.log('用户点击立即授权');
        }
      }
    });
  },

  /**
   * 开始静坐打卡
   */
  startMeditation: function() {
    // 获取用户标识
    this.getUserOpenId();
    
    // 跳转到计时页面
    wx.switchTab({
      url: '/pages/timer/timer'
    });
  },

  /**
   * 计算用户排名
   */
  calculateUserRank: function() {
    // 获取所有用户数据
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const currentUserId = this.data.userOpenId;
    const today = new Date().toISOString().split('T')[0];
    
    // 如果没有用户数据或当前用户ID为空，设置默认排名为1
    if (Object.keys(allUserRecords).length === 0 || !currentUserId) {
      this.setData({
        currentUserRank: 1
      });
      return;
    }
    
    // 计算每个用户当天的累计时长
    const userDurations = [];
    
    Object.keys(allUserRecords).forEach(userId => {
      const userRecords = allUserRecords[userId];
      const todayRecord = userRecords.dailyRecords[today];
      
      let totalDuration = 0;
      if (todayRecord && todayRecord.durations) {
        totalDuration = todayRecord.durations.reduce((sum, duration) => {
          return sum + parseInt(duration) || 0;
        }, 0);
      }
      
      userDurations.push({
        userId: userId,
        duration: totalDuration
      });
    });
    
    // 按时长降序排序
    userDurations.sort((a, b) => b.duration - a.duration);
    
    // 计算当前用户排名
    let currentUserRank = 0;
    for (let i = 0; i < userDurations.length; i++) {
      if (userDurations[i].userId === currentUserId) {
        currentUserRank = i + 1;
        break;
      }
    }
    
    // 如果没有找到当前用户（新用户），排名为用户总数+1
    if (currentUserRank === 0) {
      currentUserRank = userDurations.length + 1;
    }
    
    this.setData({
      currentUserRank: currentUserRank
    });
    
    console.log(`用户排名计算完成：第${currentUserRank}名，总用户数：${userDurations.length}`);
  },

  /**
   * 更新本月打卡次数
   */
  updateMonthlyCount: function() {
    const currentYear = this.data.currentYear;
    const currentMonth = this.data.currentMonth;
    
    if (!this.data.userOpenId) {
      this.setData({
        monthlyCount: 0
      });
      return;
    }
    
    // 获取当前用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[this.data.userOpenId];
    
    if (!userRecords || !userRecords.dailyRecords) {
      this.setData({
        monthlyCount: 0
      });
      return;
    }
    
    // 计算本月累计打卡总次数
    let monthlyCount = 0;
    Object.keys(userRecords.dailyRecords).forEach(dateStr => {
      const [year, month] = dateStr.split('-').map(Number);
      if (year === currentYear && month === currentMonth) {
        const dailyRecord = userRecords.dailyRecords[dateStr];
        monthlyCount += dailyRecord.count || 0;
      }
    });
    
    // 更新页面上的打卡次数显示
    this.setData({
      monthlyCount: monthlyCount
    });
    
    console.log(`本月累计打卡次数: ${monthlyCount}`);
  },

  /**
   * 选择日期
   */
  selectDate: function(e) {
    const date = e.currentTarget.dataset.date;
    if (date) {
      console.log('选择日期:', date);
      
      // 检查日期是否已打卡
      if (this.isDateChecked(date)) {
        // 已打卡日期，跳转到历史记录页面
        wx.navigateTo({
          url: `/pages/history/history?date=${date}`
        });
      } else {
        // 未打卡日期，显示提示
        wx.showToast({
          title: '该日期尚未打卡',
          icon: 'none',
          duration: 1500
        });
      }
    }
  },

  /**
   * 切换到上个月
   */
  prevMonth: function() {
    let year = this.data.currentYear;
    let month = this.data.currentMonth;
    
    if (month === 1) {
      year--;
      month = 12;
    } else {
      month--;
    }
    
    this.setData({
      currentYear: year,
      currentMonth: month
    });
    
    this.generateCalendar();
  },

  /**
   * 切换到下个月
   */
  nextMonth: function() {
    let year = this.data.currentYear;
    let month = this.data.currentMonth;
    
    if (month === 12) {
      year++;
      month = 1;
    } else {
      month++;
    }
    
    this.setData({
      currentYear: year,
      currentMonth: month
    });
    
    this.generateCalendar();
  },

  /**
   * 检查某日期当前用户是否已打卡（支持迁移数据）
   */
  isDateChecked: function(dateStr) {
    if (!this.data.userOpenId) {
      return false;
    }
    
    // 1. 检查当前用户ID的记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[this.data.userOpenId];
    
    if (userRecords && userRecords.dailyRecords) {
      const dailyRecord = userRecords.dailyRecords[dateStr];
      if (dailyRecord && dailyRecord.count > 0) {
        return true;
      }
    }
    
    // 2. 检查是否有迁移数据关联
    const migratedRecords = this.checkMigratedRecords(dateStr);
    if (migratedRecords) {
      return true;
    }
    
    // 3. 如果没有缓存数据，延迟异步加载并同步到本地
    this.syncUserCheckinData();
    
    return false;
  },
  
  /**
   * 检查迁移数据
   */
  checkMigratedRecords: function(dateStr) {
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    
    // 查找所有已迁移到当前用户的数据
    for (const [userId, userRecord] of Object.entries(allUserRecords)) {
      if (userRecord.migrated && userRecord.migratedTo === this.data.userOpenId) {
        if (userRecord.dailyRecords && userRecord.dailyRecords[dateStr]) {
          const dailyRecord = userRecord.dailyRecords[dateStr];
          if (dailyRecord && dailyRecord.count > 0) {
            console.log(`✅ 找到迁移记录: ${dateStr} (来源: ${userId})`);
            return true;
          }
        }
      }
    }
    
    return false;
  },
  
  /**
   * 异步同步用户打卡数据到本地存储
   */
  syncUserCheckinData: function() {
    // 避免频繁同步，每10分钟同步一次
    const lastSyncTime = wx.getStorageSync('lastSyncTime') || 0;
    const now = Date.now();
    const syncInterval = 10 * 60 * 1000; // 10分钟
    
    if (now - lastSyncTime < syncInterval) {
      return;
    }
    
    wx.setStorageSync('lastSyncTime', now);
    
    // 异步同步数据
    setTimeout(() => {
      const checkinManager = require('../../utils/checkin.js');
      
      // 获取最近30天的打卡记录（避免数据量过大）
      const today = new Date();
      const syncPromises = [];
      
      for (let i = 0; i < 30; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        
        syncPromises.push(
          checkinManager.getDailyCheckinCount(dateStr)
            .then(count => ({ dateStr, count }))
            .catch(() => ({ dateStr, count: 0 }))
        );
      }
      
      Promise.all(syncPromises).then(results => {
        const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
        const userRecords = allUserRecords[this.data.userOpenId] || {
          dailyRecords: {},
          totalCount: 0
        };
        
        results.forEach(({ dateStr, count }) => {
          if (count > 0) {
            if (!userRecords.dailyRecords[dateStr]) {
              userRecords.dailyRecords[dateStr] = { count: 0 };
            }
            userRecords.dailyRecords[dateStr].count = count;
          }
        });
        
        allUserRecords[this.data.userOpenId] = userRecords;
        wx.setStorageSync('meditationUserRecords', allUserRecords);
        
        console.log('✅ 用户打卡数据同步完成');
      }).catch(error => {
        console.warn('❌ 数据同步失败:', error);
      });
    }, 1000); // 延迟1秒执行，避免阻塞页面渲染
  },

  /**
   * 生成日历数据
   */
  generateCalendar: function() {
    const year = this.data.currentYear;
    const month = this.data.currentMonth;
    
    // 获取当月第一天和最后一天
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    
    // 获取当月第一天是星期几（0-6，0代表周日，1代表周一）
    const firstDayOfWeek = firstDay.getDay() === 0 ? 7 : firstDay.getDay(); // 转换为周一为1
    
    // 获取上个月最后几天
    const prevMonthLastDay = new Date(year, month - 1, 0).getDate();
    
    // 计算需要显示的天数 - 固定显示6行（42天）
    const daysInMonth = lastDay.getDate();
    const totalCells = 42; // 固定6行 * 7天 = 42天
    
    const calendarDays = [];
    let week = [];
    
    // 添加上个月的最后几天
    const prevMonthDaysNeeded = firstDayOfWeek - 1;
    for (let i = 0; i < prevMonthDaysNeeded; i++) {
      const day = prevMonthLastDay - prevMonthDaysNeeded + i + 1;
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const fullDate = `${prevYear}-${prevMonth.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      week.push({
        day: day,
        type: 'prev-month',
        fullDate: fullDate,
        isToday: false,
        isChecked: this.isDateChecked(fullDate)
      });
    }
    
    // 添加当前月的日期
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
    
    for (let day = 1; day <= daysInMonth; day++) {
      const fullDate = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      week.push({
        day: day,
        type: 'current-month',
        fullDate: fullDate,
        isToday: fullDate === todayStr,
        isChecked: this.isDateChecked(fullDate)
      });
      
      // 每7天一周
      if (week.length === 7) {
        calendarDays.push(week);
        week = [];
      }
    }
    
    // 添加下个月的日期 - 补齐到42天
    let nextMonthDay = 1;
    const remainingDays = totalCells - (prevMonthDaysNeeded + daysInMonth);
    for (let i = 0; i < remainingDays; i++) {
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const fullDate = `${nextYear}-${nextMonth.toString().padStart(2, '0')}-${nextMonthDay.toString().padStart(2, '0')}`;
      
      week.push({
        day: nextMonthDay,
        type: 'next-month',
        fullDate: fullDate,
        isToday: false,
        isChecked: this.isDateChecked(fullDate)
      });
      nextMonthDay++;
      
      // 每7天一周
      if (week.length === 7) {
        calendarDays.push(week);
        week = [];
      }
    }
    
    this.setData({
      calendarDays: calendarDays,
      todayDate: todayStr
    });
  },

  /**
   * 获取随机金句
   */
  getRandomWisdom: function() {
    wx.cloud.callFunction({
      name: 'getRandomWisdom',
      success: res => {
        if (res.result.success && res.result.data) {
          this.setData({
            wisdomQuote: '"' + res.result.data.content + '"'
          });
          console.log('index页面获取金句成功:', res.result.data.content);
        } else {
          console.warn('index页面获取金句失败，使用默认金句');
        }
      },
      fail: err => {
        console.error('index页面调用云函数失败:', err);
        // 使用默认金句
      }
    });
  },

  /**
   * 测试函数 - 用于验证showLoginModal能否被调用
   */
  testShowLoginModal: function() {
    console.log('=== testShowLoginModal函数被调用 ===');
    console.log('测试函数开始，将调用showLoginModal');
    
    // 直接调用showLoginModal函数
    if (typeof this.showLoginModal === 'function') {
      console.log('showLoginModal函数存在，准备调用');
      this.showLoginModal();
    } else {
      console.error('showLoginModal函数不存在或未定义');
    }
    
    console.log('=== testShowLoginModal函数执行完成 ===');
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('=== index页面onLoad函数开始 ===');
    console.log('页面参数:', options);
    
    const today = new Date();
    this.setData({
      currentYear: today.getFullYear(),
      currentMonth: today.getMonth() + 1
    });
    
    console.log('初始化页面数据完成');
    
    // 获取用户标识，完成后会自动更新数据
    this.getUserOpenId();
    
    // 获取随机金句
    this.getRandomWisdom();
    
    // 页面加载时不自动检查用户信息，只有在用户点击"点击登录"时才触发
    console.log('index页面加载完成，等待用户点击登录按钮');
    
    console.log('=== index页面onLoad函数结束 ===');
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
    console.log('=== index页面onShow函数开始 ===');
    
    // 检查用户信息状态（不跳转，只更新显示）
    this.checkUserInfoStatus(false);
    
    // 重新生成日历，确保显示最新的打卡状态
    this.generateCalendar();
    
    // 更新本月打卡次数显示
    this.updateMonthlyCount();
    
    // 更新用户排名显示
    this.calculateUserRank();
    
    console.log('页面显示完成，当前用户状态:', {
      hasUserInfo: this.data.hasUserInfo,
      userNickname: this.data.userNickname,
      userOpenId: this.data.userOpenId
    });
    console.log('=== index页面onShow函数结束 ===');
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
    return {};
  }
})