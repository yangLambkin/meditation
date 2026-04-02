// 测试工具入口页面
Page({
  data: {
    testTools: [
      {
        name: '邀请流程测试',
        description: '自动化测试邀请发送和接收流程',
        path: '/pages/test/inviteTest/inviteTest'
      }
    ]
  },

  onLoad() {
    console.log('测试工具页面加载');
  },

  navigateToTest(e) {
    const path = e.currentTarget.dataset.path;
    wx.navigateTo({
      url: path
    });
  },

  // 快速测试邀请功能
  quickTestInvite() {
    // 直接跳转到邀请测试页面
    wx.navigateTo({
      url: '/pages/test/inviteTest/inviteTest'
    });
  }
})