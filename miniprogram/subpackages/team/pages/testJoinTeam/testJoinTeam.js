// JoinTeam页面测试 - 测试登录和未登录状态下的加入流程

Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 测试参数
    teamId: '2d12bec269d363c3032cab5c66a2282e', // 测试团队ID
    teamName: '亘心每日觉察',
    teamIcon: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/team_icons/1775461314263_g2w01n.png',
    inviterName: '邀请者',
    
    // 多用户测试配置
    testUsers: {
      userA: { nickname: '用户A（创建者）', avatar: '/images/icons/creator.png' },
      userB: { nickname: '用户B', avatar: '/images/icons/user.png' },
      userC: { nickname: '用户C', avatar: '/images/icons/new-user.png' }
    },
    
    // 测试状态
    currentUserStatus: 'unknown', // unknown, logged_out, logged_in
    currentUserInfo: {
      openid: '',
      nickname: ''
    },
    
    // 测试结果
    testResults: [],
    isTesting: false
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad() {
    this.updateUserStatus();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this.updateUserStatus();
    this.checkTestCompletion();
  },

  /**
   * 更新用户状态显示
   */
  updateUserStatus() {
    const openid = wx.getStorageSync('userOpenId');
    const nickname = wx.getStorageSync('userNickname');
    
    let status = 'unknown';
    if (!openid && !nickname) {
      status = 'logged_out';
    } else if (openid && nickname) {
      status = 'logged_in';
    }
    
    this.setData({
      currentUserStatus: status,
      currentUserInfo: {
        openid: openid || '未设置',
        nickname: nickname || '未登录'
      }
    });
    
    console.log('🔍 用户状态更新:', {
      status: status,
      openid: openid,
      nickname: nickname
    });
  },

  /**
   * 切换到登录状态
   */
  switchToLoggedIn() {
    const testOpenId = 'test_user_' + Date.now();
    
    wx.setStorageSync('userOpenId', testOpenId);
    wx.setStorageSync('userNickname', '测试用户');
    wx.setStorageSync('userInfo', {
      nickName: '测试用户',
      avatarUrl: '/images/avatar.png',
      profileComplete: true
    });
    
    this.updateUserStatus();
    this.addTestResult('切换到登录状态', '✅ 用户已登录，OpenID: ' + testOpenId);
    
    wx.showToast({
      title: '已切换到登录状态',
      icon: 'success'
    });
  },

  /**
   * 切换到用户A（创建者）
   */
  switchToUserA() {
    const userAOpenId = 'user_a_' + Date.now();
    
    wx.setStorageSync('userOpenId', userAOpenId);
    wx.setStorageSync('userNickname', '用户A（创建者）');
    wx.setStorageSync('userInfo', {
      nickName: '用户A（创建者）',
      avatarUrl: '/images/icons/creator.png',
      profileComplete: true
    });
    
    this.updateUserStatus();
    this.addTestResult('切换到用户A', '✅ 已切换为用户A（创建者身份）');
    
    wx.showToast({
      title: '已切换为用户A',
      icon: 'success'
    });
  },

  /**
   * 切换到用户B（普通成员）
   */
  switchToUserB() {
    const userBOpenId = 'user_b_' + Date.now();
    
    wx.setStorageSync('userOpenId', userBOpenId);
    wx.setStorageSync('userNickname', '用户B');
    wx.setStorageSync('userInfo', {
      nickName: '用户B',
      avatarUrl: '/images/icons/user.png',
      profileComplete: true
    });
    
    this.updateUserStatus();
    this.addTestResult('切换到用户B', '✅ 已切换为用户B（已登录状态）');
    
    wx.showToast({
      title: '已切换为用户B',
      icon: 'success'
    });
  },

  /**
   * 切换到用户B未登录状态
   */
  switchToUserBLoggedOut() {
    // 清除所有用户信息
    wx.removeStorageSync('userOpenId');
    wx.removeStorageSync('userNickname');
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('userLoginData');
    
    this.updateUserStatus();
    this.addTestResult('切换到用户B未登录', '✅ 用户B已设置为未登录状态');
    
    wx.showToast({
      title: '用户B未登录',
      icon: 'success'
    });
  },

  /**
   * 切换到用户C（新用户）
   */
  switchToUserC() {
    const userCOpenId = 'user_c_' + Date.now();
    
    wx.setStorageSync('userOpenId', userCOpenId);
    wx.setStorageSync('userNickname', '用户C');
    wx.setStorageSync('userInfo', {
      nickName: '用户C',
      avatarUrl: '/images/icons/new-user.png',
      profileComplete: true
    });
    
    this.updateUserStatus();
    this.addTestResult('切换到用户C', '✅ 已切换为用户C（已登录状态）');
    
    wx.showToast({
      title: '已切换为用户C',
      icon: 'success'
    });
  },

  /**
   * 切换到用户C未登录状态
   */
  switchToUserCLoggedOut() {
    // 清除所有用户信息
    wx.removeStorageSync('userOpenId');
    wx.removeStorageSync('userNickname');
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('userLoginData');
    
    this.updateUserStatus();
    this.addTestResult('切换到用户C未登录', '✅ 用户C已设置为未登录状态');
    
    wx.showToast({
      title: '用户C未登录',
      icon: 'success'
    });
  },

  /**
   * 切换到未登录状态
   */
  switchToLoggedOut() {
    // 清除所有用户信息
    wx.removeStorageSync('userOpenId');
    wx.removeStorageSync('userNickname');
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('userLoginData');
    
    this.updateUserStatus();
    this.addTestResult('切换到未登录状态', '✅ 已清除所有用户信息，模拟未登录状态');
    
    wx.showToast({
      title: '已切换到未登录状态',
      icon: 'success'
    });
  },

  /**
   * 测试场景1：用户已登录，直接进入JoinTeam页面
   */
  testScenario1LoggedIn() {
    console.log('🚀 开始测试场景1：用户已登录状态');
    
    // 确保用户已登录
    if (this.data.currentUserStatus !== 'logged_in') {
      wx.showModal({
        title: '测试准备',
        content: '请先切换到登录状态再进行此测试',
        showCancel: false
      });
      return;
    }
    
    this.addTestResult('场景1测试开始', '用户已登录，直接进入JoinTeam页面');
    
    // 跳转到JoinTeam页面
    this.gotoJoinTeam('scenario1');
  },

  /**
   * 测试场景2：用户未登录，进入JoinTeam页面后需要登录
   */
  testScenario2LoggedOut() {
    console.log('🚀 开始测试场景2：用户未登录状态');
    
    // 确保用户未登录
    if (this.data.currentUserStatus !== 'logged_out') {
      wx.showModal({
        title: '测试准备',
        content: '请先切换到未登录状态再进行此测试',
        showCancel: false
      });
      return;
    }
    
    this.addTestResult('场景2测试开始', '用户未登录，进入JoinTeam页面后需要登录');
    
    // 跳转到JoinTeam页面
    this.gotoJoinTeam('scenario2');
  },

  /**
   * 测试场景3：完整流程测试（未登录 → 登录 → 加入团队）
   */
  testScenario3FullFlow() {
    console.log('🚀 开始测试场景3：完整流程测试');
    
    this.setData({ isTesting: true });
    
    wx.showModal({
      title: '完整流程测试',
      content: '测试流程：\n1. 设置用户为未登录状态\n2. 进入JoinTeam页面\n3. 点击"加入团队"按钮\n4. 登录成功后自动加入团队\n5. 跳转到团队详情页\n\n请按照提示操作。',
      showCancel: false,
      success: () => {
        // 1. 首先设置用户为未登录状态
        this.switchToLoggedOut();
        
        // 2. 延迟后跳转到JoinTeam页面
        setTimeout(() => {
          this.addTestResult('场景3测试开始', '开始完整流程测试');
          this.gotoJoinTeam('scenario3');
        }, 1000);
      }
    });
  },

  /**
   * 测试场景4：多用户切换测试（用户B未登录 → 收到邀请）
   */
  testScenario4UserBSwitch() {
    console.log('🚀 开始测试场景4：多用户切换测试（用户B）');
    
    this.setData({ isTesting: true });
    
    wx.showModal({
      title: '场景4测试',
      content: '测试流程：\n\n1. 设置用户B为未登录状态\n2. 模拟用户B收到团队邀请\n3. 点击邀请链接进入JoinTeam页面\n4. 点击"加入团队"按钮\n5. 跳转到profile页面完成登录\n6. 登录成功后自动返回并加入团队\n\n请按照提示操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景4开始', '用户B未登录收到邀请流程测试');
        
        // 1. 设置用户B为未登录状态
        this.switchToUserBLoggedOut();
        
        // 2. 延迟后跳转到JoinTeam页面（带邀请信息）
        setTimeout(() => {
          this.addTestResult('跳转准备', '即将跳转到JoinTeam页面（带邀请信息）');
          this.gotoJoinTeamWithSimulatedInvite('scenario4');
        }, 1000);
      }
    });
  },

  /**
   * 测试场景5：多用户切换测试（用户C已登录 → 收到邀请）
   */
  testScenario5UserCSwitch() {
    console.log('🚀 开始测试场景5：多用户切换测试（用户C）');
    
    this.setData({ isTesting: true });
    
    wx.showModal({
      title: '场景5测试',
      content: '测试流程：\n\n1. 设置用户C为已登录状态\n2. 模拟用户C收到团队邀请\n3. 点击邀请链接进入JoinTeam页面\n4. 直接点击"加入团队"按钮\n5. 直接加入团队并跳转到团队详情\n\n请按照提示操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景5开始', '用户C已登录收到邀请流程测试');
        
        // 1. 设置用户C为已登录状态
        this.switchToUserC();
        
        // 2. 延迟后跳转到JoinTeam页面（带邀请信息）
        setTimeout(() => {
          this.addTestResult('跳转准备', '即将跳转到JoinTeam页面（带邀请信息）');
          this.gotoJoinTeamWithSimulatedInvite('scenario5');
        }, 1000);
      }
    });
  },

  /**
   * 测试场景6：完整多用户切换测试
   */
  testScenario6MultiUser() {
    console.log('🚀 开始测试场景6：完整多用户切换测试');
    
    this.setData({ isTesting: true });
    
    wx.showModal({
      title: '场景6测试',
      content: '完整测试流程：\n\n1. 设置用户A（创建者）\n2. 设置用户B未登录状态\n3. 用户B收到邀请并加入\n4. 切换到用户C已登录状态\n5. 用户C收到邀请并加入\n6. 验证所有用户都成功加入团队\n\n这是最复杂的测试场景，请耐心操作。',
      showCancel: false,
      success: () => {
        this.addTestResult('场景6开始', '完整多用户切换测试开始');
        
        // 执行多步骤测试
        this.executeMultiStepTest();
      }
    });
  },

  /**
   * 执行多步骤测试
   */
  executeMultiStepTest() {
    console.log('🔄 开始执行多步骤测试...');
    
    // 步骤1：切换到用户A（创建者）
    this.addTestResult('步骤1', '切换到用户A（创建者）');
    this.switchToUserA();
    
    setTimeout(() => {
      // 步骤2：切换到用户B未登录状态
      this.addTestResult('步骤2', '切换到用户B未登录状态');
      this.switchToUserBLoggedOut();
      
      setTimeout(() => {
        // 步骤3：用户B测试邀请流程
        this.addTestResult('步骤3', '用户B测试邀请流程（手动操作）');
        this.promptUserBInvitation();
        
        setTimeout(() => {
          // 步骤4：切换到用户C已登录状态
          this.addTestResult('步骤4', '切换到用户C已登录状态');
          this.switchToUserC();
          
          setTimeout(() => {
            // 步骤5：用户C测试邀请流程
            this.addTestResult('步骤5', '用户C测试邀请流程');
            this.gotoJoinTeamWithSimulatedInvite('scenario6_step5');
            
          }, 2000);
        }, 2000);
      }, 2000);
    }, 2000);
  },

  /**
   * 提示用户B邀请流程
   */
  promptUserBInvitation() {
    console.log('👤 提示用户B邀请流程...');
    
    wx.showModal({
      title: '用户B邀请流程',
      content: '用户B当前处于未登录状态。\n\n请手动点击下方"测试用户B邀请"按钮，测试用户B的邀请加入流程。',
      showCancel: false
    });
  },

  /**
   * 带模拟邀请信息的跳转
   */
  gotoJoinTeamWithSimulatedInvite(scenario) {
    console.log('📱 带模拟邀请信息的跳转，场景:', scenario);
    
    const params = {
      teamId: this.data.teamId,
      teamName: this.data.teamName,
      teamIcon: this.data.teamIcon,
      inviterName: '用户A（创建者）',
      inviteId: 'test_invite_' + Date.now(),
      testScenario: scenario // 标记测试场景
    };
    
    const queryString = this.buildQueryString(params);
    
    console.log('跳转参数:', {
      scenario: scenario,
      params: params,
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`
    });
    
    this.addTestResult('跳转JoinTeam', `场景: ${scenario}, 携带邀请信息`);
    
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`,
      success: () => {
        console.log('✅ JoinTeam页面跳转成功');
        this.addTestResult('页面跳转', '成功跳转到JoinTeam页面');
      },
      fail: (err) => {
        console.error('❌ JoinTeam页面跳转失败:', err);
        this.addTestResult('页面跳转', '❌ 跳转失败: ' + err.errMsg);
      }
    });
  },

  /**
   * 跳转到JoinTeam页面
   */
  gotoJoinTeam(scenario) {
    const params = {
      teamId: this.data.teamId,
      teamName: this.data.teamName,
      teamIcon: this.data.teamIcon,
      inviterName: this.data.inviterName,
      testScenario: scenario // 标记测试场景
    };
    
    const queryString = this.buildQueryString(params);
    
    console.log('📱 跳转到JoinTeam页面:', {
      scenario: scenario,
      params: params,
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`
    });
    
    wx.navigateTo({
      url: `/subpackages/team/pages/joinTeam/joinTeam?${queryString}`,
      success: () => {
        console.log('✅ JoinTeam页面跳转成功');
        this.addTestResult('页面跳转', '成功跳转到JoinTeam页面');
      },
      fail: (err) => {
        console.error('❌ JoinTeam页面跳转失败:', err);
        this.addTestResult('页面跳转', '❌ 跳转失败: ' + err.errMsg);
      }
    });
  },

  /**
   * 构建查询字符串
   */
  buildQueryString(params) {
    return Object.keys(params)
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
      .join('&');
  },

  /**
   * 检查测试完成状态
   */
  checkTestCompletion() {
    // 检查用户是否在测试过程中完成了登录和加入团队
    const openid = wx.getStorageSync('userOpenId');
    const nickname = wx.getStorageSync('userNickname');
    
    if (this.data.isTesting && openid && nickname) {
      // 用户已登录，可能完成了测试
      this.addTestResult('测试完成检查', '✅ 用户已登录，流程可能已完成');
      this.setData({ isTesting: false });
    }
  },

  /**
   * 验证测试结果
   */
  verifyTestResults() {
    console.log('🔍 验证测试结果...');
    
    const openid = wx.getStorageSync('userOpenId');
    const nickname = wx.getStorageSync('userNickname');
    
    let verificationResult = '❌ 测试未完成';
    
    if (openid && nickname) {
      // 检查是否加入了团队（需要检查本地缓存）
      try {
        const teamManager = require('../../../../utils/teamManager.js');
        const joinedTeams = teamManager.loadJoinedTeamsFromStorage();
        const isTeamMember = joinedTeams.some(team => team._id === this.data.teamId);
        
        if (isTeamMember) {
          verificationResult = '✅ 测试完成！用户已成功加入团队';
        } else {
          verificationResult = '⚠️ 用户已登录，但未检测到团队加入记录';
        }
      } catch (error) {
        verificationResult = '✅ 用户已登录，团队加入状态需手动确认';
      }
    }
    
    wx.showModal({
      title: '测试结果验证',
      content: `用户状态：${openid && nickname ? '已登录' : '未登录'}\n${verificationResult}`,
      showCancel: false
    });
    
    this.addTestResult('最终验证', verificationResult);
  },

  /**
   * 清除测试记录
   */
  clearTestResults() {
    this.setData({
      testResults: []
    });
    
    wx.showToast({
      title: '测试记录已清除',
      icon: 'success'
    });
  },

  /**
   * 添加测试结果
   */
  addTestResult(title, description) {
    const newResult = {
      id: Date.now(),
      title: title,
      description: description,
      timestamp: new Date().toLocaleTimeString()
    };
    
    this.setData({
      testResults: [newResult, ...this.data.testResults]
    });
    
    console.log('📊 测试结果:', newResult);
  },

  /**
   * 跳转到团队详情页（手动测试）
   */
  gotoTeamDetails() {
    wx.navigateTo({
      url: `/subpackages/team/pages/teamDetails/teamDetails?teamId=${this.data.teamId}`,
      success: () => {
        console.log('✅ 跳转到团队详情页成功');
      },
      fail: (err) => {
        console.error('❌ 跳转到团队详情页失败:', err);
        wx.showToast({
          title: '跳转失败',
          icon: 'none'
        });
      }
    });
  }
})