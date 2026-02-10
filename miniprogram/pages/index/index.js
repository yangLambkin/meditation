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
    if (cachedUserInfo && cachedUserInfo.nickName) {
      // 有完整的用户信息，直接使用
      this.setData({
        userNickname: cachedUserInfo.nickName,
        hasUserInfo: true
      });
      console.log('从缓存获取用户昵称:', cachedUserInfo.nickName);
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
   * 获取用户微信昵称
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
    
    // 如果没有用户昵称，设置默认昵称"微信用户"
    // 授权检查由onLoad中的checkUserInfo统一处理
    this.setData({
      userNickname: '微信用户'
    });
  },

  /**
   * 显示登录模态框（包含隐私协议）
   */
  showLoginModal: function() {
    console.log('=== showLoginModal函数被调用 ===');
    console.log('当前页面上下文:', this);
    console.log('当前页面数据:', this.data);
    console.log('函数调用栈:', new Error().stack);
    
    // 保存this引用，避免回调函数中的上下文问题
    const that = this;
    
    wx.showModal({
      title: '用户登录',
      content: '欢迎使用觉察计时小程序！我们将获取您的微信昵称和头像信息，并严格遵守《用户隐私保护协议》。',
      confirmText: '同意',
      cancelText: '不同意',
      success: function(res) {
        console.log('登录模态框用户选择结果:', res);
        if (res.confirm) {
          console.log('用户同意隐私协议，直接获取用户信息');
          that.getUserInfoDirectly();
        } else {
          console.log('用户不同意隐私协议');
          // 用户可以继续使用小程序，但部分功能受限
          wx.showToast({
            title: '您可以继续使用小程序',
            icon: 'none',
            duration: 1500
          });
        }
      },
      fail: function(err) {
        console.error('显示登录模态框失败:', err);
      }
    });
    
    console.log('=== showLoginModal函数执行完成 ===');
  },

  /**
   * 开始微信登录流程
   */
  startWechatLogin: function() {
    console.log('开始微信登录流程');
    
    // 显示加载提示
    wx.showLoading({
      title: '登录中...',
      mask: true
    });
    
    // 第一步：获取微信登录code
    wx.login({
      success: (loginRes) => {
        if (loginRes.code) {
          console.log('获取登录code成功:', loginRes.code);
          
          // 第二步：调用wx.getUserProfile()获取用户信息
          this.getUserProfile(loginRes.code);
        } else {
          console.log('获取登录code失败:', loginRes.errMsg);
          wx.hideLoading();
          wx.showToast({
            title: '登录失败，请重试',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        console.error('登录失败:', err);
        wx.hideLoading();
        wx.showToast({
          title: '登录失败，请重试',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 获取微信用户身份标识（openid）
   */
  getWechatOpenId: function() {
    console.log('=== 获取微信用户openid ===');
    
    return new Promise((resolve, reject) => {
      wx.login({
        success: (loginRes) => {
          if (loginRes.code) {
            console.log('获取登录code成功:', loginRes.code);
            
            // 在实际应用中，这里应该调用云函数或后端API
            // 使用loginRes.code换取真正的微信openid
            // 这里暂时使用本地生成的标识
            
            const localOpenId = wx.getStorageSync('wechatOpenId');
            if (!localOpenId) {
              const newOpenId = 'openid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
              wx.setStorageSync('wechatOpenId', newOpenId);
              resolve(newOpenId);
            } else {
              resolve(localOpenId);
            }
          } else {
            console.log('获取登录code失败:', loginRes.errMsg);
            reject(new Error('获取登录code失败'));
          }
        },
        fail: (err) => {
          console.error('登录失败:', err);
          reject(err);
        }
      });
    });
  },

  /**
   * 直接获取用户信息（昵称和头像）- 在最外层调用
   */
  getUserInfoDirectly: function() {
    console.log('=== 直接获取用户信息（昵称和头像） ===');
    
    // 显示加载提示
    wx.showLoading({
      title: '登录中...',
      mask: true
    });
    
    // 第一步：直接在最外层调用wx.getUserProfile获取用户信息
    wx.getUserProfile({
      desc: '用于完善会员资料和个性化服务',
      success: (res) => {
        console.log('获取用户信息成功:', res.userInfo);
        
        // 第二步：获取微信用户身份标识（openid）
        wx.login({
          success: (loginRes) => {
            wx.hideLoading();
            
            if (loginRes.code) {
              console.log('获取登录code成功:', loginRes.code);
              
              // 获取用户openid
              const openid = wx.getStorageSync('wechatOpenId') || 'openid_' + Date.now();
              
              // 用户同意授权，有完整的用户信息
              const userInfo = res.userInfo;
              const nickname = userInfo.nickName;
              
              console.log('登录成功 - 昵称:', nickname, '头像:', userInfo.avatarUrl, 'openid:', openid);
              
              // 保存用户信息
              this.saveUserInfo(userInfo, openid);
              
              // 更新页面显示
              this.setData({
                userNickname: nickname,
                hasUserInfo: true
              });
              
              // 显示登录成功提示
              wx.showToast({
                title: `欢迎回来，${nickname}`,
                icon: 'success',
                duration: 2000
              });
            } else {
              console.log('获取登录code失败:', loginRes.errMsg);
              wx.hideLoading();
              wx.showToast({
                title: '登录失败，请重试',
                icon: 'none'
              });
            }
          },
          fail: (err) => {
            wx.hideLoading();
            console.error('登录失败:', err);
            wx.showToast({
              title: '登录失败，请重试',
              icon: 'none'
            });
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('用户拒绝授权或获取失败:', err);
        
        // 用户拒绝授权，使用基础登录流程
        this.basicLoginProcess();
      }
    });
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
   * 获取用户信息（使用wx.getUserProfile）
   */
  getUserProfile: function(loginCode) {
    console.log('调用wx.getUserProfile获取用户信息');
    
    wx.getUserProfile({
      desc: '用于完善会员资料和个性化服务',
      success: (res) => {
        console.log('获取用户信息成功:', res.userInfo);
        wx.hideLoading();
        
        // 用户同意授权
        const userInfo = res.userInfo;
        const nickname = userInfo.nickName;
        const avatarUrl = userInfo.avatarUrl;
        
        console.log('登录成功 - 昵称:', nickname, '头像:', avatarUrl, '登录code:', loginCode);
        
        // 保存用户信息并与openid关联
        this.saveUserInfo(userInfo, loginCode);
        
        // 更新页面显示
        this.setData({
          userNickname: nickname,
          hasUserInfo: true
        });
        
        // 显示登录成功提示
        wx.showToast({
          title: `欢迎回来，${nickname}`,
          icon: 'success',
          duration: 2000
        });
        
      },
      fail: (err) => {
        console.error('用户拒绝授权或获取失败:', err);
        wx.hideLoading();
        
        if (err.errMsg.includes('auth deny') || err.errMsg.includes('cancel')) {
          // 用户拒绝授权
          wx.showToast({
            title: '授权取消，部分功能受限',
            icon: 'none',
            duration: 2000
          });
        } else {
          // 其他错误
          wx.showToast({
            title: '获取信息失败，请重试',
            icon: 'none'
          });
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
  saveUserInfo: function(userInfo, openid) {
    console.log('保存完整用户信息，openid:', openid);
    
    // 保存用户信息到本地缓存
    wx.setStorageSync('userInfo', userInfo);
    wx.setStorageSync('userNickname', userInfo.nickName);
    wx.setStorageSync('userOpenId', openid);
    
    // 保存用户数据到本地
    const userData = {
      openid: openid,
      userInfo: userInfo,
      loginTime: new Date().toISOString()
    };
    
    wx.setStorageSync('userLoginData', userData);
    
    // 保存用户信息到云数据库
    this.saveUserToCloud(userInfo, openid);
    
    console.log('用户信息保存完成:', userData);
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
    
    // 检查用户是否已存在（使用_openid作为标识）
    usersCollection.where({
      _openid: userOpenId
    }).get({
      success: (res) => {
        if (res.data.length > 0) {
          // 用户已存在，更新用户信息
          console.log('用户已存在，更新用户信息，头像URL:', userInfo.avatarUrl);
          usersCollection.doc(res.data[0]._id).update({
            data: {
              nickName: userInfo.nickName,
              avatarUrl: userInfo.avatarUrl,
              gender: userInfo.gender,
              country: userInfo.country,
              province: userInfo.province,
              city: userInfo.city,
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
          console.log('用户不存在，创建新用户，头像URL:', userInfo.avatarUrl);
          usersCollection.add({
            data: {
              nickName: userInfo.nickName,
              avatarUrl: userInfo.avatarUrl,
              gender: userInfo.gender,
              country: userInfo.country,
              province: userInfo.province,
              city: userInfo.city,
              createTime: new Date(),
              lastLoginTime: new Date(),
              loginCount: 1
            }
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
        usersCollection.add({
          data: {
            _openid: userOpenId,
            nickName: userInfo.nickName,
            avatarUrl: userInfo.avatarUrl,
            gender: userInfo.gender,
            country: userInfo.country,
            province: userInfo.province,
            city: userInfo.city,
            createTime: new Date(),
            lastLoginTime: new Date(),
            loginCount: 1
          }
        }).then(res => {
          console.log('用户信息保存到云数据库成功（直接创建）:', res);
        }).catch(err => {
          console.error('用户信息保存到云数据库失败（直接创建）:', err);
        });
      }
    });
  },

  /**
   * 触发用户授权
   */
  triggerUserAuth: function() {
    console.log('触发用户授权');
    
    // 显示用户授权按钮（通过设置hasUserInfo为false来触发）
    this.setData({
      hasUserInfo: false
    });
    
    // 授权按钮会通过open-type="getUserInfo"自动触发授权
  },

  /**
   * 用户授权回调
   */
  onGetUserInfo: function(e) {
    console.log('用户授权信息:', e);
    
    if (e.detail.userInfo) {
      // 用户同意授权
      const userInfo = e.detail.userInfo;
      const nickname = userInfo.nickName;
      
      console.log('用户同意授权，昵称:', nickname);
      
      // 保存到缓存
      wx.setStorageSync('userInfo', userInfo);
      wx.setStorageSync('userNickname', nickname);
      
      console.log('保存到缓存完成，开始更新页面数据');
      console.log('更新前 userNickname:', this.data.userNickname);
      
      // 更新页面显示
      this.setData({
        userNickname: nickname,
        hasUserInfo: true
      }, () => {
        console.log('页面数据更新完成，更新后 userNickname:', this.data.userNickname);
        console.log('页面数据更新完成，hasUserInfo:', this.data.hasUserInfo);
      });
      
      wx.showToast({
        title: '授权成功',
        icon: 'success',
        duration: 1500
      });
    } else {
      // 用户拒绝授权 - 阻止使用小程序
      console.log('用户拒绝授权，阻止使用小程序');
      
      // 显示模态对话框，告知用户必须授权
      wx.showModal({
        title: '授权提示',
        content: '使用本小程序需要授权获取您的昵称信息，请点击授权按钮并选择"允许"以继续使用。',
        showCancel: false,
        confirmText: '重新授权',
        success: (res) => {
          if (res.confirm) {
            // 用户点击确认，继续显示授权按钮
            this.setData({
              userNickname: '觉察者',
              hasUserInfo: false
            });
          }
        }
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
   * 检查某日期当前用户是否已打卡
   */
  isDateChecked: function(dateStr) {
    if (!this.data.userOpenId) {
      return false;
    }
    
    // 获取所有用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const userRecords = allUserRecords[this.data.userOpenId];
    
    if (!userRecords || !userRecords.dailyRecords) {
      return false;
    }
    
    const dailyRecord = userRecords.dailyRecords[dateStr];
    
    // 只要当天有打卡记录（次数>=1），就显示为已打卡
    return dailyRecord && dailyRecord.count > 0;
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