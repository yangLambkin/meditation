const lunarUtil = require('../../utils/lunar.js');
const checkinManager = require('../../utils/checkin.js');
const dailyCardImage = require('../../utils/dailyCardImage.js');
const badgeManager = require('../../utils/badgeManager.js');
const dateUtil = require('../../utils/dateUtil.js');
const homeCheckin = require('../../utils/homeCheckin.js');
const dailyWisdom = require('../../utils/dailyWisdom.js');

Page({
  data: {
    wisdomQuote: dailyWisdom.DEFAULT_QUOTE,
    // 未预热时先显示本地卡片，云图片下载完成后再替换。
    displayImage: dailyCardImage.DEFAULT_IMAGE
  },

  onLoad(options) {
    this._isUnloaded = false;
    this._initialShowPending = true;
    // 1. 立即同步设置当前日期，避免首屏闪现默认日期 23（日期设置不应依赖异步图片预加载）
    this.setCurrentDateInfo();

    // 2. 预加载随机图片（仅影响 displayImage，不阻塞日期）
    this.preloadRandomImage().catch(error => {
      // 如果预加载失败，降级到默认图片
      console.warn('图片预加载失败，使用默认图片:', error);
      this.fallbackToDefaultImage();
    });

    console.log('开始预加载图片，避免闪烁');
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this._isPageVisible = true;
    console.log('=== daily1页面onShow函数开始 ===');
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = dailyWisdom.watchDailyWisdom(({ content }) => {
      this.setData({ wisdomQuote: content });
    });
    
    // 首次 onLoad 已同步刷新日期、用户和统计；返回页面时再刷新。
    if (!this._initialShowPending || this._displayedBusinessDate !== dateUtil.getBusinessDate()) {
      this.setCurrentDateInfo();
    }
    this._initialShowPending = false;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = dateUtil.watchBusinessDate(() => this.setCurrentDateInfo());
    
    console.log('=== daily1页面onShow函数结束 ===');
  },

  /**
   * 设置当前日期信息
   */
  setCurrentDateInfo: function() {
    this._displayedBusinessDate = dateUtil.getBusinessDate();
    const [year, month, day] = this._displayedBusinessDate.split('-').map(Number);
    const today = new Date(year, month - 1, day, 12);
    
    // 获取英文月份名称
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
    const englishMonth = monthNames[today.getMonth()];
    
    // 获取星期几
    const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekDay = weekDays[today.getDay()];
    
    // 计算农历日期（简化版，实际应用中可以使用更精确的农历库）
    const lunarDate = lunarUtil.getLunarDate(today);
    
    // 获取用户数据
    this.getUserData();
    
    // 更新页面显示
    this.setData({
      year: year,
      month: englishMonth,
      day: day,
      weekDay: weekDay,
      lunarDate: lunarDate
    });
    
    console.log(`打卡日期: ${year}.${englishMonth} ${weekDay} ${lunarDate}`);
  },

  /**
   * 格式化时间显示（直接显示分钟数）
   */
  formatTime: function(minutes) {
    return `${minutes}分钟`;
  },

  /**
   * 消费计时完成时预热的图片，直接进入日签时也复用相同的下载流程。
   */
  preloadRandomImage: function() {
    const image = dailyCardImage.takeNextImage();
    if (image.path) {
      if (!this._isUnloaded) this.setData({ displayImage: image.path });
      return image.promise;
    }
    return image.promise.then(path => {
      if (!this._isUnloaded) this.setData({ displayImage: path });
      return path;
    });
  },

  getRandomImage: function() {
    return this.preloadRandomImage();
  },

  /**
   * 图片读取失败时使用本地卡片，避免临时文件失效造成裂图。
   */
  fallbackToDefaultImage: function() {
    if (!this._isUnloaded && this.data.displayImage !== dailyCardImage.DEFAULT_IMAGE) {
      this.setData({ displayImage: dailyCardImage.DEFAULT_IMAGE });
    }
  },

  /**
   * 获取用户数据（支持新旧格式）
   */
  getUserData: function() {
    // 使用与index页面一致的登录状态检测逻辑
    const userOpenId = wx.getStorageSync('userOpenId');
    const userInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const hasWechatInfo = !!(userInfo || userNickname);
    const isLoggedIn = isWechatLoggedIn || hasWechatInfo;
    
    // 尝试从缓存获取用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    console.log('daily1页面用户状态检测 - 微信登录:', isWechatLoggedIn, '有微信信息:', hasWechatInfo, '已登录:', isLoggedIn);
    
    // 支持新旧格式的用户信息
    const hasValidUserInfo = cachedUserInfo && 
                           (cachedUserInfo.nickName || 
                            (cachedUserInfo.isCustomAvatar !== undefined && 
                             cachedUserInfo.profileComplete));
    
    if (hasValidUserInfo) {
      // 使用缓存的用户信息
      const userName = cachedUserInfo.nickName || '静心者';
      
      // 头像显示逻辑优化：
      // 1. 已登录用户：优先使用用户头像，否则使用登录图标
      // 2. 未登录用户：使用默认头像
      let userAvatar;
      if (isLoggedIn) {
        userAvatar = cachedUserInfo.avatarUrl || '/images/userLogin.png';
      } else {
        userAvatar = '/images/avatar.png'; // 未登录用户使用默认头像
      }
      
      this.setData({
        userName: userName,
        userAvatar: userAvatar
      });
      
      console.log('获取到用户信息 - 昵称:', userName, '头像:', userAvatar, '登录状态:', isLoggedIn);
    } else {
      // 没有用户信息，根据登录状态使用不同默认值
      const userName = isLoggedIn ? '微信用户' : '静心者';
      
      // 头像显示逻辑优化：
      // 已登录用户显示登录图标，未登录用户显示默认头像
      const userAvatar = isLoggedIn ? '/images/userLogin.png' : '/images/avatar.png';
      
      this.setData({
        userName: userName,
        userAvatar: userAvatar
      });
      
      console.log('未找到用户信息，使用默认值 - 昵称:', userName, '头像:', userAvatar, '登录状态:', isLoggedIn);
      
      // 提示用户设置个人信息
      this.showProfileHint();
    }
    
    // 获取用户打卡统计数据（使用本地缓存优先的架构）
    this.calculateUserStatsFromLocal();
    
    // 获取最高等级勋章
    this.getHighestLevelBadge();
  },

  /**
   * 获取当前用户的最高等级勋章
   */
  getHighestLevelBadge: function() {
    try {
      // 获取所有已解锁的勋章
      const unlockedBadges = badgeManager.getUnlockedBadges();
      
      // 筛选出等级勋章
      const levelBadges = unlockedBadges.filter(badge => badge.category === 'level' && badge.isUnlocked);
      
      if (levelBadges.length === 0) {
        console.log('用户暂未解锁任何等级勋章');
        this.setData({
          highestLevelBadge: null
        });
        return;
      }
      
      // 找出最高等级的勋章（按level序号排序）
      const highestBadge = levelBadges.reduce((max, badge) => {
        // 从level-X中提取数字X
        const currentLevel = parseInt(badge.id.split('-')[1]);
        const maxLevel = max ? parseInt(max.id.split('-')[1]) : -1;
        
        return currentLevel > maxLevel ? badge : max;
      }, null);
      
      console.log('📊 最高等级勋章:', highestBadge);
      
      this.setData({
        highestLevelBadge: highestBadge
      });
      
    } catch (error) {
      console.warn('获取最高等级勋章失败:', error);
      this.setData({
        highestLevelBadge: null
      });
    }
  },

  /**
   * 显示个人信息设置提示
   */
  showProfileHint: function() {
    if (this._profileHintTimer || this._profileHintShown || this._isUnloaded) return;
    // 延迟显示提示，避免影响页面加载
    this._profileHintTimer = setTimeout(() => {
      this._profileHintTimer = null;
      if (!this._isPageVisible || this._isUnloaded) return;
      this._profileHintShown = true;
      wx.showModal({
        title: '完善个人信息',
        content: '设置个性化昵称和头像，享受更好的冥想体验',
        confirmText: '立即设置',
        cancelText: '稍后再说',
        success: (res) => {
          if (res.confirm && this._isPageVisible && !this._isUnloaded) {
            // 跳转到个人信息设置页面
            wx.navigateTo({
              url: '/pages/profile/profile?type=new&from=daily'
            });
          }
        }
      });
    }, 2000);
  },

  /**
   * 计算用户统计数据（本地缓存优先架构）
   */
  calculateUserStatsFromLocal: function() {
    console.log('=== 开始从本地缓存获取用户统计数据 ===');
    
    try {
      // 获取当前日期
      const today = new Date();
      const todayStr = dateUtil.getBusinessDate(today);
      
      // 1. 直接从本地缓存获取今日打卡数据
      const todayCheckinCount = this.getTodayCheckinCountFromLocal(todayStr);
      console.log('本地获取今日打卡次数:', todayCheckinCount);
      
      // 2. 获取本次觉察时长（当天最后一次打卡的时长）
      const currentMinutes = this.getCurrentMeditationMinutes(todayStr);
      console.log('本地获取本次觉察时长:', currentMinutes, '分钟');
      
      // 3. 获取用户累计统计信息（从本地）
      const userStats = this.getUserStatsFromLocal();
      console.log('本地获取用户统计信息:', userStats);
      
      // 4. 计算用户等级（基于累计总分钟数）
      const userLevel = this.calculateUserLevel(userStats.totalDuration || 0);
      
      // 设置页面数据
      this.setData({
        totalMinutes: currentMinutes, // 显示本次打卡时长
        totalCount: todayCheckinCount, // 显示今日累计打卡次数
        userLevel: userLevel
      }, () => {
        // 数据设置完成后的回调，验证数据绑定
        console.log('数据设置完成 - 本次打卡时长:', currentMinutes + '分钟');
        console.log('数据设置完成 - 今日打卡次数:', todayCheckinCount);
        console.log('数据设置完成 - 用户等级:', userLevel);
        console.log('页面数据验证:', {
          totalMinutes: this.data.totalMinutes,
          totalCount: this.data.totalCount,
          userLevel: this.data.userLevel
        });
      });
      
    } catch (error) {
      console.error('从本地缓存获取用户统计数据失败:', error);
      // 降级处理：显示0分钟，表示没有打卡记录
      this.setData({
        totalMinutes: 0,
        totalCount: 0,
        userLevel: 'Lv.1 新手上路'
      });
    }
  },

  /**
   * 从本地缓存获取今日打卡次数
   */
  getTodayCheckinCountFromLocal: function(todayStr) {
    const checkinManager = require('../../utils/checkin.js');
    
    // 使用checkinManager的同步版本获取今日打卡次数
    const count = checkinManager.getDailyCheckinCountSync(todayStr);
    return count || 0;
  },

  /**
   * 获取本次觉察时长（当天最后一次打卡的时长）
   */
  getCurrentMeditationMinutes: function(todayStr) {
    const checkinManager = require('../../utils/checkin.js');
    
    try {
      const records = homeCheckin.buildCheckinRecords(checkinManager.getUserCheckinData());
      const lastRecord = records.find(record => record.dayDate === todayStr);
      return lastRecord ? lastRecord.duration : 0;

    } catch (error) {
      console.warn('获取本次觉察时长失败:', error);
      return 0;
    }
  },

  /**
   * 从本地缓存获取用户统计信息
   */
  getUserStatsFromLocal: function() {
    const checkinManager = require('../../utils/checkin.js');
    
    try {
      // 使用checkinManager的本地统计功能
      const stats = checkinManager.getUserStats();
      return stats;
    } catch (error) {
      console.warn('获取本地用户统计失败:', error);
      return {
        totalDays: 0,
        totalCount: 0,
        totalDuration: 0,
        currentStreak: 0,
        longestStreak: 0
      };
    }
  },

  /**
   * 计算用户等级
   */
  calculateUserLevel: function(totalMinutes) {
    if (totalMinutes >= 10080) return 'Lv.10 禅定大师';
    if (totalMinutes >= 5040) return 'Lv.9 静心高手';
    if (totalMinutes >= 2520) return 'Lv.8 修行达人';
    if (totalMinutes >= 1260) return 'Lv.7 精进者';
    if (totalMinutes >= 600) return 'Lv.6 坚持者';
    if (totalMinutes >= 300) return 'Lv.5 探索者';
    if (totalMinutes >= 150) return 'Lv.4 初学者';
    if (totalMinutes >= 60) return 'Lv.3 修行中';
    if (totalMinutes >= 30) return 'Lv.2 入门者';
    return 'Lv.1 新手上路';
  },

  /**
   * 保留原有的云端数据获取函数作为备用（兼容性）
   */
  calculateUserStats: async function() {
    // 直接调用本地版本，保持兼容性
    this.calculateUserStatsFromLocal();
  },


  onHide() {
    this._isPageVisible = false;
    this._initialShowPending = false;
    if (this._profileHintTimer) clearTimeout(this._profileHintTimer);
    this._profileHintTimer = null;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
  },

  // 重写页面返回逻辑
  onUnload() {
    this._isUnloaded = true;
    this._isPageVisible = false;
    if (this._profileHintTimer) clearTimeout(this._profileHintTimer);
    this._profileHintTimer = null;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
    // 页面返回时跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  // 自定义返回按钮点击事件
  onBack() {
    // 直接跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  /**
   * 分享到微信朋友圈
   */
  shareToWechat: function() {
    console.log('点击分享朋友圈');
    
    // 显示分享菜单
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
    
    // 对于朋友圈分享，显示提示信息
    wx.showModal({
      title: '分享朋友圈',
      content: '请点击右上角菜单，选择"分享到朋友圈"',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 保存图片到相册
   */
  saveImage: function() {
    console.log('点击保存图片');
    
    // 首先获取用户授权
    wx.authorize({
      scope: 'scope.writePhotosAlbum',
      success: () => {
        // 授权成功，开始保存图片
        this.saveDailyImage();
      },
      fail: (err) => {
        console.log('用户未授权保存图片权限:', err);
        // 引导用户授权
        wx.showModal({
          title: '保存图片需要授权',
          content: '请授权访问相册以保存图片',
          success: (res) => {
            if (res.confirm) {
              // 用户确认，重新请求授权
              wx.authorize({
                scope: 'scope.writePhotosAlbum',
                success: () => {
                  this.saveDailyImage();
                },
                fail: () => {
                  wx.showToast({
                    title: '授权失败',
                    icon: 'none'
                  });
                }
              });
            }
          }
        });
      }
    });
  },

  /**
   * 保存打卡图片 - 简化版Canvas绘制
   */
  saveDailyImage: function() {
    const that = this;
    
    // 创建Canvas上下文
    const ctx = wx.createCanvasContext('dailyCanvas');
    
    // 设置Canvas尺寸（使用简单尺寸）
    const width = 750;
    const height = 1334;
    
    // 1. 绘制白色背景（全屏）
    ctx.setFillStyle('#ffffff');
    ctx.fillRect(0, 0, width, height);
    
    // 2. 绘制简单布局（避免复杂的布局计算）
    this.drawSimpleLayout(ctx, width, height);
    
    // 绘制完成，生成图片
    ctx.draw(false, () => {
      setTimeout(() => {
        wx.canvasToTempFilePath({
          canvasId: 'dailyCanvas',
          success: (res) => {
            // 保存图片到相册
            wx.saveImageToPhotosAlbum({
              filePath: res.tempFilePath,
              success: () => {
                wx.showToast({
                  title: '打卡图片保存成功',
                  icon: 'success'
                });
              },
              fail: (err) => {
                console.error('保存图片失败:', err);
                wx.showToast({
                  title: '保存失败',
                  icon: 'none'
                });
              }
            });
          },
          fail: (err) => {
            console.error('生成图片失败:', err);
            that.saveDefaultImage();
          }
        });
      }, 500);
    });
  },

  /**
   * 绘制简单布局 - 使用更接近实际页面的比例
   */
  drawSimpleLayout: function(ctx, width, height) {
    // 使用更接近实际页面比例的尺寸（基于rpx到px的转换，通常1rpx=0.5px）
    
    // 1. 绘制顶部金句（左上角）
    ctx.setFillStyle('#ffffff');
    ctx.setFontSize(60); // 相当于30rpx -> 60px
    ctx.setTextAlign('left');
    ctx.fillText(this.data.wisdomQuote, 100, 240); // 相当于50rpx -> 100px, 120rpx -> 240px
    
    // 2. 绘制日期信息（右上角）
    ctx.setTextAlign('right');
    ctx.setFontSize(50); // 相当于25rpx -> 50px
    ctx.fillText(`${this.data.year}.${this.data.month} ${this.data.weekDay}`, width - 100, 160);
    ctx.fillText(this.data.lunarDate, width - 100, 240);
    
    // 3. 绘制用户信息区域（中间）
    const userY = 600; // 相当于300rpx -> 600px
    
    // 绘制头像（使用更大的尺寸）
    ctx.drawImage(this.data.userAvatar, 200, userY, 200, 200); // 相当于100rpx -> 200px
    
    // 绘制用户等级
    ctx.setFontSize(50); // 相当于25rpx -> 50px
    ctx.setTextAlign('center');
    ctx.fillText(this.data.userLevel, 300, userY + 280);
    
    // 绘制用户名
    ctx.setTextAlign('left');
    ctx.setFontSize(80); // 相当于40rpx -> 80px
    ctx.fillText(this.data.userName, 440, userY + 100);
    
    // 4. 绘制打卡数据（中间下方）
    const statsY = 900; // 相当于450rpx -> 900px
    const centerX = width / 2;
    
    ctx.setFontSize(70); // 相当于35rpx -> 70px
    ctx.setTextAlign('center');
    ctx.fillText(`${this.data.totalCount} 次`, centerX - 200, statsY);
    
    ctx.setFontSize(50); // 相当于25rpx -> 50px
    ctx.fillText('累计打卡', centerX - 200, statsY + 80);
    
    // 绘制分割线
    ctx.setStrokeStyle('#b29764');
    ctx.setLineWidth(6); // 相当于3rpx -> 6px
    ctx.beginPath();
    ctx.moveTo(centerX, statsY - 40);
    ctx.lineTo(centerX, statsY + 40);
    ctx.stroke();
    
    // 绘制静坐时长
    ctx.setFontSize(70); // 相当于35rpx -> 70px
    ctx.fillText(`${this.data.totalMinutes}分钟`, centerX + 200, statsY);
    
    ctx.setFontSize(50); // 相当于25rpx -> 50px
    ctx.fillText('静坐时长', centerX + 200, statsY + 80);
    
    // 5. 绘制底部信息
    const bottomY = height - 160; // 相当于80rpx -> 160px
    ctx.setFontSize(40); // 相当于20rpx -> 40px
    ctx.fillText('静坐觉察 · 每日打卡', centerX, bottomY);
  },

  /**
   * 保存默认图片
   */
  saveDefaultImage: function() {
    // 使用项目中的默认图片
    const imagePath = '/images/bg1.jpeg';
    
    wx.saveImageToPhotosAlbum({
      filePath: imagePath,
      success: () => {
        wx.showToast({
          title: '图片保存成功',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('保存默认图片失败:', err);
        wx.showToast({
          title: '保存失败',
          icon: 'none'
        });
      }
    });
  },


  onShareAppMessage() {
    return {
      title: '静坐觉察 - 每日打卡',
      path: '/pages/index/index',
      imageUrl: '/images/logo.png'
    };
  },
});
