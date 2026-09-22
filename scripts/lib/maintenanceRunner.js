const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseOptions(args, valueOptions, booleanOptions) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (Object.hasOwn(result, key)) throw new Error(`重复参数: ${key}`);
    if (booleanOptions.includes(key)) result[key] = true;
    else if (valueOptions.includes(key)) {
      const value = args[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`参数 ${key} 需要非空值`);
      result[key] = value;
    } else throw new Error(`未知参数: ${key}`);
  }
  return result;
}

function requireEnvironment(options) {
  const value = options['--env'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('必须使用 --env 指定完整的目标云环境 ID');
  return value;
}

// Invoker contract: executable receives routing args; request JSON is stdin, response JSON is stdout.
// The adapter must preserve a platform-authenticated allowlisted OPENID. It cannot grant authority.
function invokeMaintenance(functionName, environmentId, event, options = {}) {
  const environment = options.environment || process.env;
  const executable = environment.MAINTENANCE_INVOKER;
  if (!executable || !path.isAbsolute(executable)) throw new Error('未配置绝对路径 MAINTENANCE_INVOKER；尚未调用云端。可加 --preview 查看请求。');
  let output;
  try {
    output = (options.execute || execFileSync)(executable,
      ['--function', functionName, '--env', environmentId], {
        input: JSON.stringify(event), encoding: 'utf8', shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        env: environment,
      });
  } catch (error) {
    // child_process errors may contain argv, stdout or stderr; never print them verbatim.
    throw new Error('运维调用器执行失败或超时；结果未知，请检查受保护的调用记录后再决定是否重试');
  }
  let parsed;
  try { parsed = JSON.parse(output); } catch (error) { throw new Error('运维调用器未返回有效 JSON，不能确认结果'); }
  const result = parsed && Object.hasOwn(parsed, 'result') ? parsed.result : parsed;
  if (!result || result.success !== true) {
    const code = result && typeof result.code === 'string' && /^[A-Z_]+$/.test(result.code) ? ` (${result.code})` : '';
    throw new Error(`云端未确认操作成功${code}`);
  }
  return result;
}

module.exports = { parseOptions, requireEnvironment, invokeMaintenance };
