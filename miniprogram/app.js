// app.js
App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    
    // 初始化云开发
    wx.cloud.init({
      traceUser: true
    });
    
    console.log('云开发初始化完成');
    
    // 自动创建数据库集合
    this.autoCreateCollections();
  },
  
  // 自动创建数据库集合
  autoCreateCollections: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      wx.cloud.callFunction({
        name: 'autoCreateCollections',
        success: res => {
          console.log('数据库集合自动创建结果:', res.result);
          if (res.result.success) {
            console.log('✅ 数据库集合创建成功');
            // 可以在这里添加成功后的回调逻辑
          } else {
            console.warn('⚠️ 数据库集合创建部分成功:', res.result.message);
          }
        },
        fail: err => {
          console.warn('⚠️ 数据库集合创建失败（可能是云函数未上传）:', err);
          // 忽略初始化错误，不影响小程序正常使用
        }
      });
    }, 1000); // 延迟1秒执行
  }
});
