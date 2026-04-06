// 测试页面 - 用于验证子包到主包的跳转
Page({
  data: {},

  onLoad() {
    console.log('测试页面加载')
  },

  // 测试从主包跳转到子包
  testToSubPackage() {
    wx.navigateTo({
      url: '/pages/team/team',
      success: () => {
        console.log('跳转到团队页面成功')
      },
      fail: (err) => {
        console.error('跳转到团队页面失败:', err)
      }
    })
  },

  // 测试从子包跳转到主包（模拟子包环境）
  testFromSubPackage() {
    // 模拟子包跳转到主包
    wx.navigateTo({
      url: '/pages/profile/profile?type=invite&teamId=test123&teamName=测试团队',
      success: () => {
        console.log('从子包跳转到主包成功')
      },
      fail: (err) => {
        console.error('从子包跳转到主包失败:', err)
        
        // 尝试相对路径
        wx.navigateTo({
          url: '../../pages/profile/profile?type=invite&teamId=test123&teamName=测试团队',
          success: () => {
            console.log('相对路径跳转成功')
          },
          fail: (err2) => {
            console.error('相对路径也失败:', err2)
          }
        })
      }
    })
  }
})