// 用户切换测试页面
Page({
  data: {
    currentUser: {
      openid: '',
      nickname: ''
    },
    teamId: '3bef321d69ca6cb5023b3f3a4184ac8a', // 您的团队ID
    teamName: '冥想测试团队'
  },

  onLoad() {
    this.updateCurrentUserInfo()
  },

  // 更新当前用户信息显示
  updateCurrentUserInfo() {
    const openid = wx.getStorageSync('userOpenId')
    const nickname = wx.getStorageSync('userNickname')
    
    this.setData({
      currentUser: {
        openid: openid || '未设置',
        nickname: nickname || '未登录'
      }
    })
  },

  // 切换到创建者身份
  switchToCreator() {
    // 创建者身份（您的真实OpenID）
    const creatorOpenId = wx.getStorageSync('userOpenId') // 保留您原来的OpenID
    
    wx.setStorageSync('userOpenId', creatorOpenId)
    wx.setStorageSync('userNickname', '团队创建者')
    wx.setStorageSync('userInfo', {nickName: '团队创建者', avatarUrl: ''})
    
    this.updateCurrentUserInfo()
    wx.showToast({
      title: '已切换为创建者',
      icon: 'success'
    })
    
    console.log('✅ 切换到创建者身份:', creatorOpenId)
  },

  // 切换到用户B身份
  switchToUserB() {
    wx.setStorageSync('userOpenId', 'test_user_b_' + Date.now())
    wx.setStorageSync('userNickname', '测试用户B')
    wx.setStorageSync('userInfo', {nickName: '测试用户B', avatarUrl: ''})
    
    this.updateCurrentUserInfo()
    wx.showToast({
      title: '已切换为用户B',
      icon: 'success'
    })
    
    console.log('✅ 切换到用户B身份')
  },

  // 切换到用户C身份
  switchToUserC() {
    wx.setStorageSync('userOpenId', 'test_user_c_' + Date.now())
    wx.setStorageSync('userNickname', '测试用户C')
    wx.setStorageSync('userInfo', {nickName: '测试用户C', avatarUrl: ''})
    
    this.updateCurrentUserInfo()
    wx.showToast({
      title: '已切换为用户C',
      icon: 'success'
    })
    
    console.log('✅ 切换到用户C身份')
  },

  // 跳转到团队加入页面
  gotoJoinTeam() {
    const params = {
      teamId: this.data.teamId,
      teamName: this.data.teamName
    }
    
    wx.navigateTo({
      url: `/subpackages/chattool/pages/joinTeam/joinTeam?${this.buildQueryString(params)}`
    })
  },

  // 构建查询字符串
  buildQueryString(params) {
    return Object.keys(params)
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
      .join('&')
  }
})