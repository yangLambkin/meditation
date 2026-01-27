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
    // 使用本地images文件夹下的bg1.jpeg文件
    const localImagePath = '/images/bg1.jpeg';
    
    console.log('设置背景图片:', localImagePath);
    
    // 直接设置本地图片路径
    this.setData({
      backgroundImage: localImagePath
    });
    
    console.log('背景图片设置成功');
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