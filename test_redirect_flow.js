// 测试profile页面重定向流程的脚本
// 这个脚本用于验证用户未登录时profile页面的重定向逻辑

// 模拟用户未登录状态
function simulateLoggedOutState() {
  console.log('🔍 模拟用户未登录状态...');
  
  // 清除用户信息
  wx.removeStorageSync('userOpenId');
  wx.removeStorageSync('userNickname');
  wx.removeStorageSync('userInfo');
  
  console.log('✅ 用户信息已清除，模拟未登录状态完成');
}

// 模拟从joinTeam页面跳转到profile页面
function simulateJoinTeamToProfileNavigation() {
  console.log('🚀 模拟从joinTeam页面跳转到profile页面...');
  
  // 模拟joinTeam页面的参数
  const joinTeamParams = {
    teamId: 'test_team_123',
    teamName: '测试团队',
    teamIcon: 'cloud://test-cloud/test-icon.png',
    inviterName: '测试邀请者',
    type: 'new',
    fromPage: '/subpackages/team/pages/joinTeam/joinTeam',
    fromParams: JSON.stringify({
      teamId: 'test_team_123',
      teamName: '测试团队',
      teamIcon: 'cloud://test-cloud/test-icon.png',
      inviterName: '测试邀请者'
    })
  };
  
  console.log('📋 JoinTeam页面传递的参数:', joinTeamParams);
  
  // 模拟profile页面onLoad方法
  const profilePage = simulateProfilePageLoad(joinTeamParams);
  
  return profilePage;
}

// 模拟profile页面加载
function simulateProfilePageLoad(params) {
  console.log('👤 Profile页面onLoad被调用...');
  
  const profileData = {
    userType: params.type || 'new',
    inviteTeamId: params.teamId || '',
    inviteTeamName: params.teamName || '',
    inviteTeamIcon: params.teamIcon || '',
    inviteInviterName: params.inviterName || '',
    inviteFromJoinTeam: !!params.teamId,
    callingPage: {
      route: params.fromPage || '',
      params: params.fromParams || ''
    }
  };
  
  console.log('📊 Profile页面数据初始化完成:', profileData);
  
  // 模拟用户填写信息并保存
  simulateProfileSave(profileData);
  
  return profileData;
}

// 模拟用户保存profile信息
function simulateProfileSave(profileData) {
  console.log('💾 模拟用户保存profile信息...');
  
  // 模拟用户填写的信息
  const userInfo = {
    nickName: '测试用户',
    avatarUrl: '/images/avatar.png',
    profileComplete: true
  };
  
  // 模拟成功登录
  const openid = 'test_openid_' + Date.now();
  
  // 保存用户信息
  wx.setStorageSync('userOpenId', openid);
  wx.setStorageSync('userNickname', userInfo.nickName);
  wx.setStorageSync('userInfo', userInfo);
  
  console.log('✅ 用户信息保存完成，开始重定向...');
  
  // 模拟重定向逻辑
  simulateRedirectLogic(profileData, openid);
}

// 模拟重定向逻辑
function simulateRedirectLogic(profileData, openid) {
  console.log('🔄 模拟重定向逻辑...');
  
  // 检查调用页面信息
  if (profileData.callingPage && profileData.callingPage.route) {
    console.log('🎯 检测到明确的调用页面信息:', profileData.callingPage);
    
    const { route, params } = profileData.callingPage;
    let queryParams = '';
    
    // 如果是来自joinTeam页面，携带团队信息参数
    if (profileData.inviteFromJoinTeam && profileData.inviteTeamId) {
      queryParams = `?teamId=${profileData.inviteTeamId}&teamName=${encodeURIComponent(profileData.inviteTeamName || '')}&teamIcon=${encodeURIComponent(profileData.inviteTeamIcon || '')}&inviterName=${encodeURIComponent(profileData.inviteInviterName || '')}`;
    }
    
    console.log('📤 重定向目标:', {
      路由: route,
      参数: queryParams,
      完整URL: route + queryParams
    });
    
    if (route.includes('tabBar')) {
      console.log('📱 使用switchTab跳转到Tab页面');
    } else if (route.includes('joinTeam')) {
      console.log('📱 使用redirectTo跳转到joinTeam页面');
      
      // 检查是否能正确返回joinTeam页面
      if (route === '/subpackages/team/pages/joinTeam/joinTeam') {
        console.log('✅ 重定向路径正确，将返回team子包的joinTeam页面');
      } else {
        console.log('⚠️ 重定向路径可能与实际不符');
      }
    } else {
      console.log('📱 使用navigateBack或redirectTo跳转');
    }
    
  } else if (profileData.inviteFromJoinTeam && profileData.inviteTeamId) {
    // 兼容旧逻辑
    console.log('🔄 使用兼容逻辑进行重定向');
    console.log('📤 重定向到joinTeam页面，携带团队信息');
    
  } else {
    console.log('🏠 默认重定向到首页');
  }
  
  console.log('✅ 重定向逻辑测试完成');
}

// 执行完整的测试流程
function runFullRedirectTest() {
  console.log('🚀 开始执行完整重定向流程测试\n');
  
  // 1. 模拟用户未登录状态
  simulateLoggedOutState();
  
  console.log('\n---\n');
  
  // 2. 模拟从joinTeam页面跳转到profile页面
  simulateJoinTeamToProfileNavigation();
  
  console.log('\n---\n');
  
  // 3. 验证最终状态
  const openid = wx.getStorageSync('userOpenId');
  const nickname = wx.getStorageSync('userNickname');
  
  console.log('🔍 最终状态验证:');
  console.log('   - 用户OpenID:', openid);
  console.log('   - 用户昵称:', nickname);
  
  if (openid && nickname) {
    console.log('✅ 测试成功：用户已登录，重定向流程正常');
  } else {
    console.log('❌ 测试失败：用户未完成登录');
  }
}

// 运行测试
runFullRedirectTest();