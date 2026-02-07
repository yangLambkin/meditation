// app.js
App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    
    // 初始化云开发
    wx.cloud.init({
      // 使用自动环境检测，避免env配置错误
      traceUser: true
    });
    
    console.log('云开发初始化完成');
    
    // 测试云环境连接
    this.testCloudEnvironment();
    
    // 注意：数据库集合只需在项目部署时创建一次
    // 如需创建数据库集合，请手动调用 autoCreateCollections 云函数
    // this.autoCreateCollections();
  },
  
  // 测试云环境连接
  testCloudEnvironment: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      console.log('🔍 开始测试云环境连接...');
      
      // 测试云存储连接（使用实际存在的文件路径）
      wx.cloud.getTempFileURL({
        fileList: ['cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/bg1.jpeg'],
        success: (res) => {
          if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
            console.log('✅ 云存储连接成功，可以正常访问背景图片');
          } else {
            console.warn('⚠️ 云存储文件不存在，将使用本地图片');
          }
        },
        fail: (err) => {
          console.warn('⚠️ 云存储连接失败，将使用本地图片:', err);
        }
      });
      
    }, 500); // 延迟500毫秒执行
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
