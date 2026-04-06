// 多用户切换及邀请加入团队测试页面
Page({
  data: {
    // 测试配置
    currentUser: {
      openid: '',
      nickname: '',
      status: 'unknown' // unknown, logged_out, logged_in
    },
    teamId: 'd3a457a269cfd43702d28083527b655d', // 测试团队ID
    teamName: '亘心打卡',
    teamIcon: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/team_icons/1775227957980_yph78o.png',
    
    // 测试状态
    testResults: [],
    currentTestScenario: '',
    isTesting: false
  },

  onLoad() {
    this.updateCurrentUserInfo()
  },

  onShow() {
    this.updateCurrentUserInfo()
    this.checkTestCompletion()
  },

  // 更新当前用户信息显示
  updateCurrentUserInfo() {
    const openid = wx.getStorageSync('userOpenId')
    const nickname = wx.getStorageSync('userNickname')
    
    let status = 'unknown'
    if (!openid && !nickname) {
      status = 'logged_out'
    } else if (openid && nickname) {
      status = 'logged_in'
    }
    
    this.setData({
      currentUser: {
        openid: openid || '未设置',
        nickname: nickname || '未登录',
        status: status
      }
    })
  },

  // 清空测试记录
  clearTestResults() {
    this.setData({
      testResults: []
    })
    wx.showToast({
      title: '测试记录已清除',
      icon: 'success'
    })
  },

  // 添加测试结果
  addTestResult(title, description) {
    const newResult = {
      id: Date.now(),
      title: title,
      description: description,
      timestamp: new Date().toLocaleTimeString()
    }
    
    const testResults = [...this.data.testResults, newResult]
    this.setData({ testResults })
  },

  // === 用户身份切换功能 ===

  // 切换到用户A（创建者）
  switchToUserA() {
    const creatorOpenId = 'user_a_' + Date.now()
    
    wx.setStorageSync('userOpenId', creatorOpenId)
    wx.setStorageSync('userNickname', '用户A（创建者）')
    wx.setStorageSync('userInfo', {
      nickName: '用户A（创建者）',
      avatarUrl: '/images/icons/creator.png',
      profileComplete: true
    })
    
    this.updateCurrentUserInfo()
    this.addTestResult('切换到用户A', '✅ 已切换为用户A（创建者身份）')
    
    wx.showToast({
      title: '已切换为用户A',
      icon: 'success'
    })
  },

  // 切换到用户B（普通成员）
  switchToUserB() {
    const userBOpenId = 'user_b_' + Date.now()
    
    wx.setStorageSync('userOpenId', userBOpenId)
    wx.setStorageSync('userNickname', '用户B')
    wx.setStorageSync('userInfo', {
      nickName: '用户B',
      avatarUrl: '/images/icons/user.png',
      profileComplete: true
    })
    
    this.updateCurrentUserInfo()
    this.addTestResult('切换到用户B', '✅ 已切换为用户B（已登录状态）')
    
    wx.showToast({
      title: '已切换为用户B',
      icon: 'success'
    })
  },

  // 切换到用户B未登录状态
  switchToUserBLoggedOut() {
    // 清除所有用户信息
    wx.removeStorageSync('userOpenId')
    wx.removeStorageSync('userNickname')
    wx.removeStorageSync('userInfo')
    wx.removeStorageSync('userLoginData')
    
    this.updateCurrentUserInfo()
    this.addTestResult('切换到用户B未登录', '✅ 用户B已设置为未登录状态')
    
    wx.showToast({
      title: '用户B未登录',
      icon: 'success'
    })
  },

  // 切换到用户C（新用户）
  switchToUserC() {
    const userCOpenId = 'user_c_' + Date.now()
    
    wx.setStorageSync('userOpenId', userCOpenId)
    wx.setStorageSync('userNickname', '用户C')
    wx.setStorageSync('userInfo', {
      nickName: '用户C',
      avatarUrl: '/images/icons/new-user.png',
      profileComplete: true
    })
    
    this.updateCurrentUserInfo()
    this.addTestResult('切换到用户C', '✅ 已切换为用户C（已登录状态）')
    
    wx.showToast({
      title: '已切换为用户C',
      icon: 'success'
    })
  },

  // 切换到用户C未登录状态
  switchToUserCLoggedOut() {
    // 清除所有用户信息
    wx.removeStorageSync('userOpenId')
    wx.removeStorageSync('userNickname')
    wx.removeStorageSync('userInfo')
    wx.removeStorageSync('userLoginData')
    
    this.updateCurrentUserInfo()
    this.addTestResult('切换到用户C未登录', '✅ 用户C已设置为未登录状态')
    
    wx.showToast({
      title: '用户C未登录',
      icon: 'success'
    })
  },

  // === 测试场景功能 ===

  // 场景1：用户B未登录收到邀请
  testScenario1UserBLoggedOut() {
    console.log('🚀 开始测试场景1：用户B未登录收到邀请')
    
    this.setData({
      currentTestScenario: '用户B未登录收到邀请',
      isTesting: true
    })
    
    wx.showModal({
      title: '场景1测试',
      content: '测试流程：\n\n1. 设置用户B为未登录状态\n2. 模拟收到团队邀请\n3. 点击邀请链接进入JoinTeam页面\n4. 在JoinTeam页面点击"加入团队"\n5. 跳转到profile页面完成登录\n6. 登录成功后自动返回并加入团队\n7. 跳转到团队详情页面\n\n请按照提示操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景1开始', '用户B未登录收到邀请流程测试')
        
        // 1. 设置用户B为未登录状态
        this.switchToUserBLoggedOut()
        
        // 2. 延迟后跳转到JoinTeam页面
        setTimeout(() => {
          this.addTestResult('跳转准备', '即将跳转到JoinTeam页面')
          this.gotoJoinTeamWithSimulatedInvite('scenario1')
        }, 1000)
      }
    })
  },

  // 场景2：用户C已登录收到邀请
  testScenario2UserCLoggedIn() {
    console.log('🚀 开始测试场景2：用户C已登录收到邀请')
    
    this.setData({
      currentTestScenario: '用户C已登录收到邀请',
      isTesting: true
    })
    
    wx.showModal({
      title: '场景2测试',
      content: '测试流程：\n\n1. 设置用户C为已登录状态\n2. 模拟收到团队邀请\n3. 点击邀请链接进入JoinTeam页面\n4. 在JoinTeam页面直接点击"加入团队"\n5. 直接加入团队并跳转到团队详情\n\n请按照提示操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景2开始', '用户C已登录收到邀请流程测试')
        
        // 1. 设置用户C为已登录状态
        this.switchToUserC()
        
        // 2. 延迟后跳转到JoinTeam页面
        setTimeout(() => {
          this.addTestResult('跳转准备', '即将跳转到JoinTeam页面')
          this.gotoJoinTeamWithSimulatedInvite('scenario2')
        }, 1000)
      }
    })
  },

  // 场景3：完整多用户切换测试
  testScenario3MultiUserSwitch() {
    console.log('🚀 开始测试场景3：完整多用户切换测试')
    
    this.setData({
      currentTestScenario: '完整多用户切换测试',
      isTesting: true
    })
    
    wx.showModal({
      title: '场景3测试',
      content: '完整测试流程：\n\n1. 设置用户A（创建者）\n2. 设置用户B未登录状态\n3. 用户B收到邀请并加入\n4. 切换到用户C已登录状态\n5. 用户C收到邀请并加入\n6. 验证所有用户都成功加入团队\n\n这是最复杂的测试场景，请耐心操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景3开始', '完整多用户切换测试开始')
        
        // 执行多步骤测试
        this.executeMultiStepTest()
      }
    })
  },

  // 执行多步骤测试
  executeMultiStepTest() {
    console.log('🔄 开始执行多步骤测试...')
    
    // 步骤1：切换到用户A（创建者）
    this.addTestResult('步骤1', '切换到用户A（创建者）')
    this.switchToUserA()
    
    setTimeout(() => {
      // 步骤2：切换到用户B未登录状态
      this.addTestResult('步骤2', '切换到用户B未登录状态')
      this.switchToUserBLoggedOut()
      
      setTimeout(() => {
        // 步骤3：用户B测试邀请流程
        this.addTestResult('步骤3', '用户B测试邀请流程（模拟）')
        this.simulateUserBInvitation()
        
        setTimeout(() => {
          // 步骤4：切换到用户C已登录状态
          this.addTestResult('步骤4', '切换到用户C已登录状态')
          this.switchToUserC()
          
          setTimeout(() => {
            // 步骤5：用户C测试邀请流程
            this.addTestResult('步骤5', '用户C测试邀请流程')
            this.gotoJoinTeamWithSimulatedInvite('scenario3_step5')
            
          }, 2000)
        }, 2000)
      }, 2000)
    }, 2000)
  },

  // 模拟用户B邀请流程
  simulateUserBInvitation() {
    console.log('👤 模拟用户B邀请流程...')
    
    // 这里可以添加更复杂的模拟逻辑
    // 目前只是提示用户手动操作
    wx.showModal({
      title: '用户B邀请流程',
      content: '用户B当前处于未登录状态。\n\n请手动点击下方"跳转到JoinTeam页面"按钮，测试用户B的邀请加入流程。',
      showCancel: false
    })
  },

  // 带模拟邀请信息的跳转
  gotoJoinTeamWithSimulatedInvite(scenario) {
    console.log('📱 带模拟邀请信息的跳转，场景:', scenario)
    
    const params = {
      teamId: this.data.teamId,
      teamName: this.data.teamName,
      teamIcon: this.data.teamIcon,
      inviterName: '用户A（创建者）',
      inviteId: 'test_invite_' + Date.now(),
      testScenario: scenario // 标记测试场景
    }
    
    const queryString = this.buildQueryString(params)
    
    console.log('跳转参数:', {
      scenario: scenario,
      params: params,
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`
    })
    
    this.addTestResult('跳转JoinTeam', `场景: ${scenario}, 携带邀请信息`)
    
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`,
      success: () => {
        console.log('✅ JoinTeam页面跳转成功')
        this.addTestResult('页面跳转', '成功跳转到JoinTeam页面')
      },
      fail: (err) => {
        console.error('❌ JoinTeam页面跳转失败:', err)
        this.addTestResult('页面跳转', '❌ 跳转失败: ' + err.errMsg)
      }
    })
  },

  // 直接跳转到JoinTeam页面（不带模拟邀请）
  gotoJoinTeamDirect() {
    const params = {
      teamId: this.data.teamId,
      teamName: this.data.teamName,
      teamIcon: this.data.teamIcon
    }
    
    const queryString = this.buildQueryString(params)
    
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`,
      success: () => {
        console.log('✅ JoinTeam页面跳转成功')
        this.addTestResult('直接跳转', '直接跳转到JoinTeam页面成功')
      }
    })
  },

  // 构建查询字符串
  buildQueryString(params) {
    return Object.keys(params)
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
      .join('&')
  },

  // 检查测试完成状态
  checkTestCompletion() {
    // 检查用户是否在测试过程中完成了登录和加入团队
    const openid = wx.getStorageSync('userOpenId')
    const nickname = wx.getStorageSync('userNickname')
    
    if (this.data.isTesting && openid && nickname) {
      // 用户已登录，可能完成了测试
      this.addTestResult('测试完成检查', '✅ 用户已登录，流程可能已完成')
      this.setData({ isTesting: false })
      
      // 自动验证测试结果
      setTimeout(() => {
        this.verifyTestResults()
      }, 500)
    }
  },

  // 验证测试结果
  verifyTestResults() {
    console.log('🔍 验证测试结果...')
    
    const openid = wx.getStorageSync('userOpenId')
    const nickname = wx.getStorageSync('userNickname')
    
    let verificationResult = '❌ 测试未完成'
    let teamStatus = '未知'
    
    if (openid && nickname) {
      // 检查是否加入了团队（需要检查本地缓存）
      try {
        const teamManager = require('../../../../utils/teamManager.js')
        const joinedTeams = teamManager.loadJoinedTeamsFromStorage()
        const isTeamMember = joinedTeams.some(team => team._id === this.data.teamId)
        
        if (isTeamMember) {
          verificationResult = '✅ 测试完成！用户已成功加入团队'
          teamStatus = '已加入'
        } else {
          verificationResult = '⚠️ 用户已登录，但未检测到团队加入记录'
          teamStatus = '未加入'
        }
      } catch (error) {
        verificationResult = '✅ 用户已登录，团队加入状态需手动确认'
        teamStatus = '需手动确认'
      }
    }
    
    this.addTestResult('最终验证', verificationResult)
    
    wx.showModal({
      title: '测试结果验证',
      content: `测试场景：${this.data.currentTestScenario}\n\n用户状态：${openid && nickname ? '已登录' : '未登录'}\n团队状态：${teamStatus}\n\n${verificationResult}`,
      showCancel: false
    })
  },

  // 手动验证团队加入状态
  verifyTeamMembership() {
    console.log('🔍 手动验证团队加入状态...')
    
    try {
      const teamManager = require('../../../../utils/teamManager.js')
      const joinedTeams = teamManager.loadJoinedTeamsFromStorage()
      const isTeamMember = joinedTeams.some(team => team._id === this.data.teamId)
      
      const currentOpenid = wx.getStorageSync('userOpenId')
      const currentNickname = wx.getStorageSync('userNickname')
      
      let content = ''
      if (isTeamMember) {
        content = `✅ 验证成功！\n\n当前用户：${currentNickname}\nOpenID：${currentOpenid}\n\n已成功加入团队：${this.data.teamName}`
      } else {
        content = `❌ 验证失败！\n\n当前用户：${currentNickname}\nOpenID：${currentOpenid}\n\n未检测到团队加入记录。`
      }
      
      this.addTestResult('手动验证', isTeamMember ? '团队加入验证成功' : '团队加入验证失败')
      
      wx.showModal({
        title: '团队加入状态验证',
        content: content,
        showCancel: false
      })
      
    } catch (error) {
      console.error('验证团队加入状态失败:', error)
      wx.showModal({
        title: '验证失败',
        content: '验证过程中出现错误：' + error.message,
        showCancel: false
      })
    }
  },

  // 检查用户是否有登录信息
  hasUserInfo() {
    const userInfo = wx.getStorageSync('userInfo')
    const userNickname = wx.getStorageSync('userNickname')
    const userOpenId = wx.getStorageSync('userOpenId')
    
    const hasInfo = !!(userInfo || userNickname)
    return hasInfo
  }
})