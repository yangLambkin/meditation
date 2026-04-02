// 测试加入团队功能的脚本
// 在团队页面控制台执行此函数

async function testJoinTeamFix() {
  console.log('=== 测试加入团队修复效果 ===');
  
  // 1. 切换到用户B身份
  const testUserBOpenId = 'test_user_b_' + Date.now();
  wx.setStorageSync('userOpenId', testUserBOpenId);
  wx.setStorageSync('userNickname', '测试用户B');
  
  console.log('✅ 切换到用户B身份:', testUserBOpenId);
  
  // 2. 获取团队页面实例
  const teamPage = getCurrentPages().find(p => p.route === 'pages/team/team');
  if (!teamPage) {
    console.error('❌ 未找到团队页面实例');
    return;
  }
  
  // 3. 检查当前团队数据
  console.log('📊 当前团队数据状态:');
  console.log('   - 我创建的团队数:', teamPage.data.myTeams.length);
  console.log('   - 我加入的团队数:', teamPage.data.joinedTeams.length);
  console.log('   - 总团队数:', teamPage.data.totalJoinedTeams);
  
  // 4. 跳转到joinTeam页面进行测试
  console.log('🚀 跳转到团队加入页面...');
  
  // 注意：这里需要替换为真实的团队ID
  const teamId = '3bef321d69ca6cb5023b3f3a4184ac8a'; // 您的团队ID
  const teamName = '冥想测试团队';
  
  wx.navigateTo({
    url: `/subpackages/chattool/pages/joinTeam/joinTeam?teamId=${teamId}&teamName=${encodeURIComponent(teamName)}`,
    success: () => {
      console.log('✅ 跳转成功，请在joinTeam页面点击"加入团队"按钮');
      console.log('📋 观察日志中的以下关键信息:');
      console.log('   1. ✅ 加入团队成功');
      console.log('   2. 🔄 开始更新本地缓存...');
      console.log('   3. 🔄 强制刷新本地缓存...');
      console.log('   4. ✅ 本地缓存刷新成功');
      console.log('   5. ✅ 加入成功提示');
    },
    fail: (err) => {
      console.error('❌ 跳转失败:', err);
    }
  });
}

// 辅助函数：验证团队页面数据
function verifyTeamData() {
  const teamPage = getCurrentPages().find(p => p.route === 'pages/team/team');
  if (!teamPage) {
    console.log('⚠️ 请先打开团队页面');
    return;
  }
  
  console.log('=== 团队数据验证 ===');
  console.log('我创建的团队:', teamPage.data.myTeams.map(t => t.name));
  console.log('我加入的团队:', teamPage.data.joinedTeams.map(t => t.name));
  console.log('总团队数:', teamPage.data.totalJoinedTeams);
  
  // 检查是否包含用户B加入的团队
  const hasJoinedTeam = teamPage.data.joinedTeams.some(t => 
    t.members && t.members.some(m => m.openid && m.openid.includes('test_user_b_'))
  );
  
  console.log('✅ 包含用户B加入的团队:', hasJoinedTeam);
}

// 导出函数供控制台使用
window.testJoinTeamFix = testJoinTeamFix;
window.verifyTeamData = verifyTeamData;

console.log('✅ 测试脚本加载完成！');
console.log('使用方式:');
console.log('1. testJoinTeamFix() - 测试加入团队功能');
console.log('2. verifyTeamData() - 验证团队数据');