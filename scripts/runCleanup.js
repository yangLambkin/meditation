#!/usr/bin/env node

/**
 * 测试数据清理工具
 * 支持三种模式：
 * 1. 安全清理 - 按日期范围删除测试数据
 * 2. 完整清理 - 删除所有数据
 * 3. 查看统计 - 显示当前数据量
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 业务日期工具：按东八区（中国时区 UTC+8）生成 YYYY-MM-DD，与云端 cleanupTestData 统一基准（根因③）
function getBusinessDate(date) {
  const d = date ? new Date(date) : new Date();
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 配置
const CONFIG = {
  cloudFunctionName: 'cleanupTestData',
  // 测试期间日期范围（默认：2026年1月1日到今天）
  testPeriod: {
    startDate: '2026-01-01',
    endDate: getBusinessDate(new Date())  // 今天（东八区），包括今天的数据
  }
};

/**
 * 执行云函数
 */
function callCloudFunction(mode) {
  try {
    console.log(`🚀 调用云函数 ${CONFIG.cloudFunctionName}，模式: ${mode}`);
    
    // 使用微信开发者工具的命令行工具
    const command = `cli cloud function invoke --name ${CONFIG.cloudFunctionName} --data '{"mode": "${mode}"}'`;
    
    console.log(`📝 执行命令: ${command}`);
    
    const result = execSync(command, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    console.log('✅ 云函数调用成功');
    console.log('📋 返回结果:');
    console.log(result);
    
    return JSON.parse(result);
    
  } catch (error) {
    console.error('❌ 调用云函数失败:', error.message);
    console.log('💡 请确保:');
    console.log('   - 微信开发者工具已安装并配置');
    console.log('   - 云函数已上传到云环境');
    console.log('   - 当前目录是小程序项目根目录');
    return null;
  }
}

/**
 * 通过HTTP请求调用云函数（备用方案）
 */
function callCloudFunctionViaHttp(mode) {
  // 这里可以实现通过HTTP调用云函数的逻辑
  // 需要获取小程序的appid和云环境ID
  console.log('🌐 HTTP调用模式暂未实现');
  console.log('💡 请使用微信开发者工具的命令行工具');
  return null;
}

/**
 * 显示使用说明
 */
function showUsage() {
  console.log(`
🔧 测试数据清理工具使用说明

📋 可用命令:
  npm run cleanup:stats   查看当前数据统计
  npm run cleanup:safe    安全清理（按日期范围删除）
  npm run cleanup:full    完整清理（删除所有数据）

🔍 清理模式说明:
  - 安全清理: 删除 ${CONFIG.testPeriod.startDate} 至 ${CONFIG.testPeriod.endDate} 期间的测试数据
  - 完整清理: 删除所有数据（谨慎使用！）
  - 查看统计: 显示各集合的数据量

⚠️  注意事项:
  1. 清理前请确保已备份重要数据
  2. 安全清理模式是推荐的选择
  3. 完整清理会删除所有数据，包括真实用户数据
  4. 清理操作不可逆，请谨慎操作

💡 推荐流程:
  1. 先运行 npm run cleanup:stats 查看数据情况
  2. 根据统计结果选择合适的清理模式
  3. 建议使用 npm run cleanup:safe 进行安全清理

🔧 手动调用云函数:
  wx.cloud.callFunction({
    name: '${CONFIG.cloudFunctionName}',
    data: { mode: 'safe' } // 或 'full' 或 'stats'
  })
  `);
}

/**
 * 主函数
 */
function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'stats';
  
  console.log('🧹 测试数据清理工具\n');
  
  // 验证模式参数
  const validModes = ['stats', 'safe', 'full'];
  if (!validModes.includes(mode)) {
    console.error(`❌ 无效的模式: ${mode}`);
    showUsage();
    process.exit(1);
  }
  
  // 显示清理模式信息
  if (mode === 'safe') {
    console.log(`🛡️  安全清理模式`);
    console.log(`📅 将清理 ${CONFIG.testPeriod.startDate} 至 ${CONFIG.testPeriod.endDate} 期间的测试数据\n`);
  } else if (mode === 'full') {
    console.log(`⚠️  完整清理模式（谨慎使用！）`);
    console.log(`📅 将清理所有数据，包括真实用户数据！\n`);
    
    // 确认提示
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('⚠️  确认要删除所有数据吗？此操作不可逆！(输入 yes 确认): ', (answer) => {
      if (answer.toLowerCase() === 'yes') {
        console.log('✅ 确认继续执行完整清理...');
        rl.close();
        executeCleanup(mode);
      } else {
        console.log('❌ 操作已取消');
        rl.close();
        process.exit(0);
      }
    });
    
    return;
  } else {
    console.log(`📊 查看数据统计\n`);
  }
  
  executeCleanup(mode);
}

/**
 * 执行清理操作
 */
function executeCleanup(mode) {
  console.log('⏳ 正在执行清理操作...\n');
  
  // 尝试调用云函数
  let result = callCloudFunction(mode);
  
  if (!result) {
    console.log('\n💡 尝试备用方案...');
    result = callCloudFunctionViaHttp(mode);
  }
  
  if (result) {
    console.log('\n🎉 操作完成！');
    
    if (mode === 'stats') {
      console.log('📊 数据统计结果:');
      if (result.statistics) {
        Object.entries(result.statistics).forEach(([collection, count]) => {
          console.log(`   - ${collection}: ${count} 条记录`);
        });
      }
    } else {
      console.log(`📈 清理结果: ${result.message}`);
      if (result.totalDeleted !== undefined) {
        console.log(`   - 删除记录数: ${result.totalDeleted}`);
      }
    }
  } else {
    console.log('\n❌ 清理操作失败，请检查配置');
    showUsage();
  }
}

// 如果是直接运行此脚本
if (require.main === module) {
  main();
}

module.exports = { main, showUsage };