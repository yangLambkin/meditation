#!/usr/bin/env node

/**
 * 勋章重新计算 / 重新颁发工具
 * 调用 meditationManager 云函数的 recomputeUserBadges 处理器。
 *
 * 用法:
 *   node scripts/runRecomputeBadges.js report [昵称|openid]   只读输出差异报告（不写库，推荐先跑）
 *   node scripts/runRecomputeBadges.js apply  [昵称|openid]   按推导结果写回（覆盖式重算）
 *
 * 不跟目标参数 → 遍历全部用户。
 * 第二个参数若为纯 ASCII 长串（约 28 位）按 openid 解析，否则按昵称（如「亘心」）。
 *
 * 重算逻辑见 cloudfunctions/meditationManager/index.js#recomputeUserBadges：
 *   - continuous_checkin：历史最长连续无中断天数 >= days 即颁发
 *   - total_duration    ：累计时长 >= minutes 即颁发
 *   - single_duration   ：保留现有（不撤销）+ 记录达标则补发
 */

const { execSync } = require('child_process');
const fs = require('fs');

const CLOUD_FUNCTION = 'meditationManager';

// 自动定位微信开发者工具 CLI：优先 PATH 中的 cli，否则回退到 macOS 标准安装路径
function findCli() {
  try {
    const p = execSync('which cli', { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* PATH 中无 cli，继续回退 */ }
  const candidates = [
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    `${process.env.HOME}/Applications/wechatwebdevtools.app/Contents/MacOS/cli`
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function parseTarget(arg) {
  if (!arg) return {};
  // openid 为约 28 位 ASCII（通常以 o 开头）；其余（含中文昵称）按 nickName
  if (/^[A-Za-z0-9_-]{20,}$/.test(arg)) {
    return { openid: arg };
  }
  return { nickName: arg };
}

function buildData(mode, target) {
  return { type: 'recomputeUserBadges', mode, ...target };
}

function callCloudFunction(data) {
  const cli = findCli();
  if (!cli) {
    console.error('❌ 未找到微信开发者工具 CLI（cli）。请确认已安装微信开发者工具。');
    console.log('💡 标准路径: /Applications/wechatwebdevtools.app/Contents/MacOS/cli');
    return null;
  }
  const json = JSON.stringify(data);
  const command = `"${cli}" cloud function invoke --name ${CLOUD_FUNCTION} --data '${json}'`;
  console.log(`🚀 调用云函数 ${CLOUD_FUNCTION}`);
  console.log(`📝 命令: ${command}`);
  try {
    const result = execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result;
  } catch (error) {
    console.error('❌ 调用云函数失败:', error.message);
    console.log('💡 请确保:');
    console.log('   - 微信开发者工具已打开并登录（cli 调用云函数依赖开发者工具进程）');
    console.log('   - meditationManager 已「上传并部署：云端安装依赖」到云环境');
    console.log('   - 当前目录是小程序项目根目录');
    return null;
  }
}

function printReport(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log('📋 原始返回:');
    console.log(raw);
    return;
  }
  if (!parsed || !parsed.result || !parsed.result.success) {
    console.log('❌ 云函数返回失败:', JSON.stringify(parsed));
    return;
  }
  const d = parsed.result.data;
  console.log('\n========== 勋章重算报告 ==========');
  console.log(`模式:      ${d.mode}`);
  console.log(`目标:      ${d.target}`);
  console.log(`用户总数:  ${d.totalUsers}`);
  console.log(`变动用户:  ${d.changedUsers}`);
  console.log(`新增勋章:  ${d.totalAdded}`);
  console.log(`移除勋章:  ${d.totalRemoved}`);
  if (d.applied) console.log(`已写回:    ${d.applied} 人`);
  console.log('----------------------------------');
  if (d.details && d.details.length) {
    d.details.forEach(u => {
      console.log(`\n用户: ${u.openid}`);
      console.log(`  最长连续天数=${u.longestRun}  累计时长=${u.totalDuration}  单次最长=${u.maxSingleDuration}`);
      console.log(`  现有: [${u.existing.join(', ') || '无'}]`);
      console.log(`  应得: [${u.computed.join(', ') || '无'}]`);
      if (u.added.length) console.log(`  ➕ 新增: ${u.added.join(', ')}`);
      if (u.removed.length) console.log(`  ➖ 移除: ${u.removed.join(', ')}`);
    });
  } else {
    console.log('✅ 无需变动的用户。');
  }
  console.log('==================================\n');
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'report';
  if (!['report', 'apply'].includes(mode)) {
    console.error('❌ 无效模式，仅支持 report / apply');
    console.log('用法: node scripts/runRecomputeBadges.js <report|apply> [昵称|openid]');
    process.exit(1);
  }
  const target = parseTarget(args[1]);

  if (mode === 'apply') {
    console.log('⚠️  APPLY 模式将按推导结果覆盖式写回 user_stats.badges（仅针对有变化的用户）。');
  } else {
    console.log('🔍 REPORT 模式：只读，不会修改任何数据。');
  }
  if (target.openid) console.log(`🎯 目标 openid: ${target.openid}`);
  else if (target.nickName) console.log(`🎯 目标昵称: ${target.nickName}`);
  else console.log('🎯 目标: 全部用户');

  console.log('');
  const raw = callCloudFunction(buildData(mode, target));
  if (raw) printReport(raw);
  else process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main, buildData, parseTarget };
