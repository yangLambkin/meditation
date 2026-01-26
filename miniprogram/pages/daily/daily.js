Page({
  data: {
    backgroundImage: '' // 背景图片URL
  },

  onLoad(options) {
    // 页面加载时设置背景图片
    this.setBackgroundImage();
    
    // 设置当前日期信息
    this.setCurrentDateInfo();
  },

  /**
   * 设置背景图片
   */
  setBackgroundImage: function() {
    const backgroundImageUrl = 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/bg1.jpeg';
    
    console.log('开始获取背景图片:', backgroundImageUrl);
    
    // 初始化云开发
    wx.cloud.init({
      env: 'cloud1-2g2rbxbu2c126d4a' // 请替换为您的环境ID
    });
    
    // 获取临时文件URL
    wx.cloud.getTempFileURL({
      fileList: [{
        fileID: backgroundImageUrl
      }],
      success: urlRes => {
        console.log('获取临时URL响应:', urlRes);
        if (urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) {
          const tempUrl = urlRes.fileList[0].tempFileURL;
          console.log('获取到临时URL:', tempUrl);
          
          this.setData({
            backgroundImage: tempUrl
          });
          console.log('设置背景图片成功');
        } else {
          console.warn('获取临时文件URL失败，响应为空');
          // 尝试直接使用云存储路径
          this.setData({
            backgroundImage: backgroundImageUrl
          });
        }
      },
      fail: err => {
        console.error('获取背景图片失败:', err);
        // 如果获取失败，尝试直接使用云存储路径
        this.setData({
          backgroundImage: backgroundImageUrl
        });
        console.log('尝试直接使用云存储路径');
      }
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
    
    // 可以在这里更新页面上的日期显示
    console.log(`当前日期: ${year}.${month} ${weekDay}`);
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

  onShareAppMessage() {
    return {};
  },
});