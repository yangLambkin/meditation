const lunarUtil = require('../../utils/lunar.js');
const checkinManager = require('../../utils/checkin.js');
const simpleBackgroundManager = require('../../utils/simpleBackgroundManager.js');

Page({
  data: {
    backgroundImage: '', // 背景图片URL
    year: 2026, // 年份
    month: 1, // 月份
    day: 23, // 日期
    weekDay: '星期五', // 星期
    lunarDate: '农历腊月初五', // 农历日期
    userName: '静心者', // 用户名
    userAvatar: '/images/avatar.png', // 用户头像，默认使用项目头像
    userLevel: 'Lv.3 修行中', // 用户等级
    totalMinutes: 0, // 本次打卡静坐分钟数
    totalCount: 43, // 累计打卡次数
    wisdomQuote: '' // 金句内容，初始为空
  },

  onLoad(options) {
    // 优化：分阶段加载，立即显示页面框架
    
    // 1. 立即设置基本数据（同步操作）
    this.setCurrentDateInfo();
    
    // 2. 立即开始加载网络数据，但不阻塞页面渲染
    setTimeout(() => {
      // 后台加载背景图
      this.setBackgroundImage().catch(err => {
        console.error('背景图加载失败:', err);
      });
      
      // 后台加载金句
      this.getRandomWisdom();
    }, 100); // 微小延迟，确保页面先渲染
    
    console.log('页面基础框架已加载，开始异步数据加载');
  },

  /**
   * 设置背景图片（使用随机云端图片）
   */
  setBackgroundImage: function() {
    return new Promise((resolve) => {
      console.log('🔄 开始设置背景图片...');
      
      // 使用回调方式，不阻塞页面渲染
      simpleBackgroundManager.getRandomBackground()
        .then(backgroundImage => {
          console.log('✅ 背景图片获取成功:', backgroundImage);
          
          // 设置背景图片
          this.setData({
            backgroundImage: backgroundImage
          });
          
          console.log('🎉 背景图片设置成功');
          resolve(backgroundImage);
        })
        .catch(error => {
          console.error('❌ 设置背景图片失败:', error);
          
          // 降级处理：使用默认图片
          this.setData({
            backgroundImage: '/images/bg1.jpeg'
          });
          console.log('🔄 使用默认背景图片作为降级处理');
          resolve(null);
        });
    });
  },

  /**
   * 设置当前日期信息
   */
  setCurrentDateInfo: function() {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    
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
      month: month,
      day: day,
      weekDay: weekDay,
      lunarDate: lunarDate
    });
    
    console.log(`打卡日期: ${year}.${month} ${weekDay} ${lunarDate}`);
  },

  /**
   * 格式化时间显示（直接显示分钟数）
   */
  formatTime: function(minutes) {
    return `${minutes}分钟`;
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
            wisdomQuote: res.result.data.content
          });
          console.log('获取金句成功:', res.result.data.content);
        } else {
          console.warn('获取金句失败，使用默认金句');
        }
      },
      fail: err => {
        console.error('调用云函数失败:', err);
        // 使用默认金句
      }
    });
  },

  /**
   * 获取用户数据
   */
  getUserData: function() {
    // 尝试从缓存获取用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    if (cachedUserInfo) {
      // 使用缓存的用户信息
      this.setData({
        userName: cachedUserInfo.nickName || '觉察者',
        userAvatar: cachedUserInfo.avatarUrl || '/images/avatar.png'
      });
    } else {
      // 检查用户是否已授权
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.userInfo']) {
            // 用户已授权，获取用户信息
            wx.getUserInfo({
              success: (userRes) => {
                const userInfo = userRes.userInfo;
                
                // 缓存用户信息
                wx.setStorageSync('userInfo', userInfo);
                
                // 更新页面显示
                this.setData({
                  userName: userInfo.nickName,
                  userAvatar: userInfo.avatarUrl
                });
                
                console.log('获取到用户头像:', userInfo.avatarUrl);
              },
              fail: (err) => {
                console.warn('获取用户信息失败:', err);
              }
            });
          } else {
            console.log('用户未授权，使用默认头像');
          }
        },
        fail: (err) => {
          console.warn('检查授权设置失败:', err);
        }
      });
    }
    
    // 获取用户打卡统计数据
    this.calculateUserStats();
  },

  /**
   * 计算用户统计数据（使用云存储）
   */
  calculateUserStats: async function() {
    try {
      // 使用云存储获取用户统计信息
      const stats = await checkinManager.getUserStats();
      
      // 获取今天的打卡记录
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const todayRecords = await checkinManager.getDailyCheckinRecords(todayStr);
      
      // 计算今日累计打卡次数
      const todayCount = todayRecords ? todayRecords.length : 0;
      
      // 计算本次打卡的静坐时长（当天最后一次打卡的时长）
      let currentMinutes = 0;
      if (todayRecords && todayRecords.length > 0) {
        // 取当天最后一次打卡的时长
        currentMinutes = todayRecords[todayRecords.length - 1].duration || 0;
      }
      
      // 计算用户等级（基于累计总分钟数）
      const userLevel = this.calculateUserLevel(stats.totalDuration || 0);

      // 如果当天没有打卡记录，显示一个默认的本次打卡时长（测试用）
      const displayMinutes = currentMinutes > 0 ? currentMinutes : 15;
      
      this.setData({
        totalMinutes: displayMinutes, // 显示本次打卡时长
        totalCount: todayCount, // 显示今日累计打卡次数
        userLevel: userLevel
      }, () => {
        // 数据设置完成后的回调，验证数据绑定
        console.log('用户统计信息:', stats);
        console.log('本次打卡时长:', currentMinutes + '分钟');
        console.log('实际设置的totalMinutes:', displayMinutes);
        console.log('页面数据totalMinutes:', this.data.totalMinutes);
      });
      
    } catch (error) {
      console.error('获取用户统计数据失败:', error);
      // 降级处理：显示默认值
      this.setData({
        totalMinutes: 15,
        totalCount: 0,
        userLevel: 'Lv.1 新手上路'
      });
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


  // 重写页面返回逻辑
  onUnload() {
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
    
    // 1. 绘制背景图片（全屏）- 使用当前页面的背景图片
    // 如果当前背景图片是云端图片，绘制时需要处理跨域问题
    // 这里使用默认图片作为降级处理
    const bgImage = this.data.backgroundImage.startsWith('cloud://') 
      ? '/images/bg1.jpeg' 
      : this.data.backgroundImage;
    
    ctx.drawImage(bgImage, 0, 0, width, height);
    
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