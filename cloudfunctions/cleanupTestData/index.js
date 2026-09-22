const cloud = require('wx-server-sdk');

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 业务日期与前端一致：北京时间每日 02:00 换日。
function getBusinessDate(date) {
  const d = new Date(date === undefined ? Date.now() : date);
  const utc8 = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRecordBusinessDate(record) {
  const validDate = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
    Number.isFinite(Date.parse(`${record.date}T00:00:00Z`)) && new Date(`${record.date}T00:00:00Z`).toISOString().slice(0, 10) === record.date;
  if ((record.source === 'manual' || record.dateSource === 'manual') && validDate) return record.date;
  const value = record.timestamp;
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
    ? getBusinessDate(timestamp) : validDate ? record.date : '';
}

async function readAllRecords(collectionName, filter = {}) {
  const records = [];
  const limit = 100;
  while (true) {
    const page = await db.collection(collectionName).where(filter).orderBy('_id', 'asc')
      .skip(records.length).limit(limit).get();
    records.push(...page.data);
    if (page.data.length < limit) return records;
  }
}

function failure(code, error) { return { success: false, code, error }; }

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Validate the entire request before touching any business collection.
function validateRequest(event, wxContext, environment) {
  if (!environment.MAINTENANCE_ENV_ID || environment.MAINTENANCE_ENV_ID !== wxContext.ENV ||
      event.targetEnv !== wxContext.ENV) return failure('ENVIRONMENT_MISMATCH', '目标环境必须与平台环境和部署配置一致');
  const mode = event.mode === undefined ? 'stats' : event.mode;
  if (!['stats', 'safe', 'full'].includes(mode)) return failure('INVALID_MODE', '仅支持 stats、safe 或 full');
  if (event.dryRun !== undefined && typeof event.dryRun !== 'boolean') return failure('INVALID_DRY_RUN', 'dryRun 必须为布尔值');
  if (mode === 'stats') return { mode, dryRun: true };
  if (!event.scope) return failure('TARGET_REQUIRED', '请显式指定 all 或 user 范围');
  if (!['all', 'user'].includes(event.scope) || (mode === 'full' && event.scope !== 'all') ||
      (event.scope === 'all' && event.openid !== undefined) ||
      (event.scope === 'user' && (typeof event.openid !== 'string' || !event.openid.trim()))) {
    return failure('INVALID_TARGET', '清理范围无效；full 仅支持显式 all');
  }
  if (mode === 'safe' && (!validDate(event.startDate) || !validDate(event.endDate) || event.startDate > event.endDate)) {
    return failure('INVALID_DATE_RANGE', 'safe 模式需要明确且有效的 startDate 和 endDate');
  }
  const dryRun = event.dryRun !== false;
  if (!dryRun) {
    if (!['test', 'production'].includes(environment.MAINTENANCE_DEPLOYMENT_TIER)) return failure('DEPLOYMENT_TIER_REQUIRED', '部署环境类型尚未配置，写入已关闭');
    if (environment.MAINTENANCE_DEPLOYMENT_TIER === 'production' && environment.CLEANUP_ALLOW_PRODUCTION !== 'true') {
      return failure('PRODUCTION_CLEANUP_DISABLED', '生产环境清理默认关闭');
    }
  }
  return { mode, dryRun, scope: event.scope, openid: event.scope === 'user' ? event.openid.trim() : undefined,
    startDate: event.startDate, endDate: event.endDate };
}

async function cleanup(request) {
  const collections = request.mode === 'full'
    ? ['meditation_records', 'experience_records', 'user_stats', 'rankings']
    : ['meditation_records', 'experience_records'];
  const selected = {};
  const userFilter = request.scope === 'user' ? { _openid: request.openid } : {};
  // Read the complete selection before deleting; deletion cannot shift pagination offsets.
  for (const name of collections) {
    let filter = userFilter;
    if (request.mode === 'safe' && name === 'experience_records') {
      const start = Date.parse(`${request.startDate}T02:00:00+08:00`);
      const end = Date.parse(`${request.endDate}T02:00:00+08:00`) + 86400000;
      filter = { ...userFilter, timestamp: db.command.gte(start).and(db.command.lt(end)) };
    }
    selected[name] = await readAllRecords(name, filter);
    if (request.mode === 'safe' && name === 'meditation_records') selected[name] = selected[name].filter(record => {
      const date = getRecordBusinessDate(record);
      return date >= request.startDate && date <= request.endDate;
    });
  }
  const matchedByCollection = Object.fromEntries(Object.entries(selected).map(([name, records]) => [name, records.length]));
  const totalMatched = Object.values(matchedByCollection).reduce((total, count) => total + count, 0);
  let totalDeleted = 0;
  if (!request.dryRun) {
    for (const [name, records] of Object.entries(selected)) {
      for (let offset = 0; offset < records.length; offset += 10) {
        const outcomes = await Promise.allSettled(records.slice(offset, offset + 10).map(record => db.collection(name).doc(record._id).remove()));
        totalDeleted += outcomes.filter(result => result.status === 'fulfilled').length;
        if (outcomes.some(result => result.status === 'rejected')) return {
          ...failure('PARTIAL_CLEANUP_FAILED', '部分删除失败；请重新预览剩余记录'), totalMatched, totalDeleted
        };
      }
    }
  }
  return { success: true, dryRun: request.dryRun, totalMatched, totalDeleted, matchedByCollection,
    ...(request.mode === 'safe' ? { testPeriod: { startDate: request.startDate, endDate: request.endDate } } : {}),
    message: request.dryRun ? `预览匹配 ${totalMatched} 条记录，未删除` : `已删除 ${totalDeleted} 条记录` };
}

exports.main = async (event = {}, context) => {
  const { canRunMaintenance, forbidden } = require('./maintenanceAuth');
  const wxContext = cloud.getWXContext();
  const environment = typeof process === 'undefined' ? {} : process.env;
  if (!canRunMaintenance(wxContext, environment)) return forbidden();
  const request = validateRequest(event, wxContext, environment);
  if (request.success === false) return request;
  try {
    if (request.mode === 'stats') {
      const statistics = {};
      for (const name of ['meditation_records', 'experience_records', 'user_stats', 'rankings']) {
        statistics[name] = (await db.collection(name).count()).total;
      }
      return { success: true, dryRun: true, statistics };
    }
    return await cleanup(request);
  } catch (error) {
    return failure('CLEANUP_FAILED', '清理或预览失败，请检查服务端数据库状态');
  }
};
