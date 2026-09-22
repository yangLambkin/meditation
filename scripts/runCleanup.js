#!/usr/bin/env node
const { parseOptions, requireEnvironment, invokeMaintenance } = require('./lib/maintenanceRunner');

function buildRequest(args) {
  const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'stats';
  if (!['stats', 'safe', 'full'].includes(mode)) throw new Error('仅支持 stats、safe 或 full');
  const options = parseOptions(args.slice(args[0] === mode ? 1 : 0),
    ['--env', '--scope', '--openid', '--start-date', '--end-date'], ['--apply', '--preview']);
  const event = { mode, targetEnv: requireEnvironment(options), dryRun: !options['--apply'] };
  if (mode === 'stats') {
    if (options['--apply'] || options['--scope'] || options['--openid'] || options['--start-date'] || options['--end-date']) throw new Error('stats 只读，不接受删除范围或 --apply');
    return event;
  }
  event.scope = options['--scope'];
  if (!['all', 'user'].includes(event.scope)) throw new Error('必须使用 --scope all 或 --scope user 指定清理范围');
  if (mode === 'full' && event.scope !== 'all') throw new Error('full 仅支持 --scope all');
  if (event.scope === 'user') {
    if (!options['--openid']) throw new Error('用户范围需要 --openid');
    event.openid = options['--openid'];
  } else if (options['--openid']) throw new Error('all 范围不能混用 --openid');
  if (mode === 'safe') {
    event.startDate = options['--start-date'];
    event.endDate = options['--end-date'];
    for (const date of [event.startDate, event.endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('safe 需要有效日期 --start-date 和 --end-date');
    }
    if (event.startDate > event.endDate) throw new Error('开始日期不能晚于结束日期');
  } else if (options['--start-date'] || options['--end-date']) throw new Error('full 不接受日期范围');
  return event;
}

function showUsage() {
  console.log('用法: node scripts/runCleanup.js [stats|safe|full] --env <环境ID> [--scope all|user] [--openid <用户>] [--start-date YYYY-MM-DD --end-date YYYY-MM-DD] [--preview] [--apply]');
  console.log('默认 stats；safe/full 默认云端只读预览。--preview 只打印本地请求，不调用云端。写入必须显式 --apply。');
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
    const result = invokeMaintenance('cleanupTestData', event.targetEnv, event);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main, showUsage, buildRequest };
