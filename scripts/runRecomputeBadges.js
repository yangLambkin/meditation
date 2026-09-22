#!/usr/bin/env node
const { parseOptions, requireEnvironment, invokeMaintenance } = require('./lib/maintenanceRunner');

function parseTarget(options) {
  const targets = [options['--openid'], options['--nickname'], options['--all']].filter(Boolean);
  if (targets.length !== 1) throw new Error('必须且只能指定一个目标：--openid、--nickname 或 --all');
  if (options['--all']) return { scope: 'all' };
  if (options['--openid']) return { openid: options['--openid'] };
  return { nickName: options['--nickname'] };
}

function buildData(mode, target) {
  if (!['report', 'apply'].includes(mode)) throw new Error('仅支持 report / apply');
  if (!target || (!target.openid && !target.nickName && target.scope !== 'all')) throw new Error('缺少重算目标');
  return { type: 'recomputeUserBadges', mode, ...target };
}

function buildRequest(args) {
  const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'report';
  if (!['report', 'apply'].includes(mode)) throw new Error('仅支持 report / apply');
  const options = parseOptions(args.slice(args[0] === mode ? 1 : 0),
    ['--env', '--openid', '--nickname'], ['--all', '--preview']);
  return { ...buildData(mode, parseTarget(options)), targetEnv: requireEnvironment(options) };
}

function showUsage() {
  console.log('用法: node scripts/runRecomputeBadges.js [report|apply] --env <环境ID> <--openid 用户 | --nickname 昵称 | --all> [--preview]');
  console.log('默认 report，只读。--preview 只打印本地请求，不调用云端。无目标将拒绝执行。');
  console.log('调用需要已验证的 MAINTENANCE_INVOKER 适配器及平台运维身份，见 docs/maintenance-access.md。');
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { showUsage(); return; }
  try {
    const event = buildRequest(args);
    if (args.includes('--preview')) {
      console.log('本地请求预览，尚未调用云端：');
      console.log(JSON.stringify(event, null, 2));
      return;
    }
    const result = invokeMaintenance('meditationManager', event.targetEnv, event);
    console.log(JSON.stringify(result.data, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main, showUsage, buildData, buildRequest, parseTarget };
