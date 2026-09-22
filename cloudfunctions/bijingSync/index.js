const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

// ===== 业务日期工具：与 meditationManager / dateUtil 完全一致 =====
// 采用"时间 +6h 后读 UTC 分量"技巧，使结果不受运行环境本地时区影响，
// 保证云端与前端使用完全一致的东八区日期基准，避免时差导致同步错日期。
function getBusinessDate(date) {
  const d = new Date(date === undefined ? Date.now() : date);
  const utc8 = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;


// 必经同步按北京时间 02:00 切日，与所有静坐业务日保持一致。
function getSyncBusinessDate(timestamp) {
  return getBusinessDate(timestamp);
}

function getSyncDateWindow(dateStr) {
  const start = Date.parse(`${dateStr}T02:00:00+08:00`);
  return { start, end: start + DAY_MS };
}

function recordTimestamp(value) {
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : NaN;
}

function isDateLabel(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

// ===== 外部系统配置（全部走环境变量，前端不持有） =====
// 环境变量在云开发控制台 → 云函数 bijingSync → 配置 → 环境变量 中设置
// 测试环境: BIJING_API_BASE=https://data.bjzl.net.cn
// 生产环境: BIJING_API_BASE=https://data.bijing.life
function getApiBase() {
  const base = process.env.BIJING_API_BASE;
  if (!base) throw new Error('缺少环境变量 BIJING_API_BASE，请在云函数配置中设置');
  return base;
}
function getAccessToken() {
  const token = process.env.BIJING_ACCESS_TOKEN;
  if (!token) throw new Error('缺少环境变量 BIJING_ACCESS_TOKEN，请在云函数配置中设置');
  return token;
}

// 调外部系统：GET /api/openapi/users/{studentNumber}
async function checkStudentExists(studentNumber) {
  const url = `${getApiBase()}/api/openapi/users/${encodeURIComponent(studentNumber)}`;
  console.log(`🔍 校验学号存在性: ${url}`);
  const res = await axios.get(url, {
    headers: { 'X-Access-Token': getAccessToken() },
    timeout: 10000,
  });
  // 200 = 存在，返回 data（含 nickname 等）；404 = 不存在
  return res.data; // { success, data: { nickname, ... } }
}

// 调外部系统：POST /api/openapi/meditation/records
async function postMeditationRecord(studentNumber, recordDate, durationMinutes) {
  const url = `${getApiBase()}/api/openapi/meditation/records`;
  console.log(`📤 上报静坐时长: sn=${studentNumber}, date=${recordDate}, min=${durationMinutes}`);
  const res = await axios.post(url, {
    studentNumber,
    recordDate,
    durationMinutes,
  }, {
    headers: { 'X-Access-Token': getAccessToken() },
    timeout: 10000,
  });
  return res.data; // { success, data } 或 { success:false, message }
}

// 预览和上报共用同一批云端记录。旧数据的 timestamp 可能是数字串或带时区 ISO，
// 按用户分页读取后统一归属，避免数据库数值范围查询漏掉次日凌晨的历史记录。
async function getDayRecords(openid, dateStr) {
  const { start, end } = getSyncDateWindow(dateStr);
  const records = [];
  const identities = new Set();
  const limit = 100;
  for (let skip = 0; ; skip += limit) {
    const result = await db.collection('meditation_records')
      .where({ _openid: openid })
      .field({ _id: true, date: true, timestamp: true, duration: true, source: true, dateSource: true, localId: true, idempotencyKey: true })
      .orderBy('_id', 'asc')
      .skip(skip)
      .limit(limit)
      .get();
    for (const record of result.data) {
      const keys = [record.localId, record.idempotencyKey].filter(Boolean);
      const duplicate = keys.some(key => identities.has(key));
      keys.forEach(key => identities.add(key));
      if (duplicate) continue;
      const timestamp = recordTimestamp(record.timestamp);
      const hasTime = Number.isFinite(timestamp);
      // 旧记录缺少有效时间戳时，只能沿用原日期；不能用上传时间推测打卡时间。
      const manualDate = (record.source === 'manual' || record.dateSource === 'manual') && isDateLabel(record.date);
      if (manualDate ? record.date !== dateStr : hasTime ? timestamp < start || timestamp >= end : record.date !== dateStr) continue;
      records.push({
        id: record._id,
        timestamp: hasTime ? timestamp : null,
        duration: typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : 0,
      });
    }
    if (result.data.length < limit) break;
  }
  records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  return records;
}

async function getDayDuration(openid, dateStr) {
  const records = await getDayRecords(openid, dateStr);
  return Math.round(records.reduce((total, record) => total + record.duration, 0));
}

// 读取用户文档
async function getUserDoc(openid) {
  const res = await db.collection('users').where({ _openid: openid }).get();
  return res.data.length > 0 ? res.data[0] : null;
}

// ===== 绑定学号（含昵称覆盖） =====
async function bindStudentNumber(openid, studentNumber) {
  if (!openid) return { success: false, error: '用户未登录' };
  if (typeof studentNumber === 'string') studentNumber = studentNumber.trim();
  if (!studentNumber) return { success: false, error: '学号不能为空' };
  if (typeof studentNumber !== 'string' || !/^BJ/.test(studentNumber)) {
    return { success: false, error: '学号必须以大写 BJ 开头' };
  }

  // 1. 校验学号存在性
  // 重新绑定不同学号时，重置同步状态，避免显示旧学号的同步历史
  const existing = await getUserDoc(openid);
  const isRebind = !!(existing && existing.bijingBound &&
    existing.bijingStudentNumber && existing.bijingStudentNumber !== studentNumber);
  let userData;
  try {
    const resp = await checkStudentExists(studentNumber);
    if (!resp || !resp.success) {
      return { success: false, error: '学号不存在或校验失败' };
    }
    userData = resp.data || {};
  } catch (e) {
    // 404 等
    if (e.response && e.response.status === 404) {
      return { success: false, error: '学号不存在' };
    }
    console.error('❌ 校验学号异常:', e.message);
    return { success: false, error: '校验学号失败: ' + e.message };
  }

  // 2. 写绑定字段 + 昵称覆盖（昵称非空时覆盖当前用户昵称）
  const userDoc = await getUserDoc(openid);
  const updateData = {
    bijingStudentNumber: studentNumber,
    bijingBound: true,
    bijingBoundAt: new Date(),
    // 重新绑定不同学号：清空同步标记，旧学号的历史同步记录不继承
    bijingSyncedDates: isRebind ? {} : ((userDoc && userDoc.bijingSyncedDates) || {}),
    lastUpdateTime: new Date(),
  };

  // 昵称覆盖：取必经之路昵称，非空则覆盖 users.nickName
  let overriddenNickname = null;
  if (userData.nickname && String(userData.nickname).trim()) {
    updateData.nickName = String(userData.nickname).trim();
    overriddenNickname = updateData.nickName;
    console.log(`📝 绑定覆盖昵称: ${overriddenNickname}`);
  }

  if (userDoc) {
    await db.collection('users').doc(userDoc._id).update({ data: updateData });
  } else {
    await db.collection('users').add({
      data: {
        _openid: openid,
        ...updateData,
        nickName: overriddenNickname || '静心者',
        avatarUrl: '/images/avatar.png',
        createTime: new Date(),
      },
    });
  }

  return {
    success: true,
    data: {
      studentNumber,
      nickname: overriddenNickname,
      nicknameOverridden: !!overriddenNickname,
    },
  };
}

// ===== 仅校验学号（不绑定，用于绑定前确认弹窗） =====
// 返回 { success, data: { studentNumber, nickname }, error }
async function checkStudentNumber(studentNumber) {
  if (typeof studentNumber === 'string') studentNumber = studentNumber.trim();
  if (!studentNumber) return { success: false, error: '学号不能为空' };
  if (typeof studentNumber !== 'string' || !/^BJ/.test(studentNumber)) {
    return { success: false, error: '学号必须以大写 BJ 开头' };
  }
  try {
    const resp = await checkStudentExists(studentNumber);
    if (!resp || !resp.success) {
      return { success: false, error: '学号不存在' };
    }
    const userData = resp.data || {};
    return {
      success: true,
      data: {
        studentNumber,
        nickname: (userData.nickname && String(userData.nickname).trim()) || '',
      },
    };
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return { success: false, error: '学号不存在' };
    }
    console.error('❌ 校验学号异常:', e.message);
    return { success: false, error: '校验学号失败: ' + e.message };
  }
}

// ===== 核心：同步某用户某一天 =====
async function syncDate(openid, dateStr) {
  const userDoc = await getUserDoc(openid);
  if (!userDoc || !userDoc.bijingBound) {
    return { openid, date: dateStr, skipped: true, reason: '未绑定' };
  }
  // 同号同日由对端幂等覆盖；自动、手动同步都重新汇总最新记录。
  // bijingSyncedDates 仅表示曾同步成功，不用于拦截再次上报。
  const duration = await getDayDuration(openid, dateStr);
  if (duration <= 0) {
    // 当天云端查不到打卡数据：不标记 synced。
    // 可能是备份异步未完成（暂时性），留待下次同步复查，
    // 避免把"查不到"误显示为"已同步"。
    return { openid, date: dateStr, skipped: true, reason: '无打卡数据(未标记待复查)', duration: 0 };
  }

  // 必须等次日 02:00 窗口结束后上报，保证同步日已完整结束。
  if (getSyncDateWindow(dateStr).end > new Date().getTime()) {
    return { openid, date: dateStr, success: false, error: '该日记录尚未结束，请在次日凌晨2点后同步', duration };
  }

  try {
    const resp = await postMeditationRecord(userDoc.bijingStudentNumber, dateStr, duration);
    if (resp && resp.success === true) {
      await markSynced(openid, dateStr, userDoc.bijingStudentNumber);
      return { openid, date: dateStr, success: true, duration };
    }
    // 对端返回失败；若为 400（通常因尝试上报当天数据）统一提示
    console.error(`❌ 上报失败 date=${dateStr}:`, resp && resp.message);
    const is400 = (resp && resp.message && String(resp.message).indexOf('400') >= 0);
    return { openid, date: dateStr, success: false, error: is400 ? '不支持同步当天数据' : ((resp && resp.message) || '未知错误'), duration };
  } catch (e) {
    console.error(`❌ 上报异常 date=${dateStr}:`, e.message);
    // 请求异常且为 400（如手动同步恰为当天触发对端拦截）统一提示
    const is400 = e.message && String(e.message).indexOf('400') >= 0;
    return { openid, date: dateStr, success: false, error: is400 ? '不支持同步当天数据' : e.message, duration };
  }
}

// 记录曾同步成功的日期，仅供状态展示（不覆盖其它日期）
async function markSynced(openid, dateStr, studentNumber) {
  const userDoc = await getUserDoc(openid);
  if (!userDoc) throw new Error('写入同步标记失败：用户不存在');
  // 只修改本次日期，避免自动/手动同步不同日期时整张状态表互相覆盖。
  // 条件更新同时防止上报期间换绑后，把旧学号的成功状态写给新学号。
  const result = await db.collection('users').where({
    _id: userDoc._id, bijingBound: true, bijingStudentNumber: studentNumber,
  }).update({ data: { [`bijingSyncedDates.${dateStr}`]: true } });
  // 部分数据库版本对“原值已为 true”的写入返回更新 0 条；只在重新
  // 核实相同绑定已有此日期的成功标记后，将它视为幂等成功。
  if (result && result.stats && result.stats.updated === 0) {
    const current = await getUserDoc(openid);
    if (current && current.bijingBound && current.bijingStudentNumber === studentNumber &&
      current.bijingSyncedDates && current.bijingSyncedDates[dateStr] === true) return;
  }
  if (!result || !result.stats || result.stats.updated !== 1) {
    throw new Error('写入同步标记失败：用户绑定已变化，请重新同步');
  }
}

// ===== 凌晨 2 点自动：同步所有绑定用户最近一个已结束的同步日 =====
const CRON_MAX_RETRIES = 3;

async function syncDateWithRetry(openid, dateStr) {
  let result;
  for (let attempt = 0; attempt <= CRON_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.warn('⏳ 定时同步重试', { openid, date: dateStr, retry: attempt, error: result.error });
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
    }
    try {
      result = await syncDate(openid, dateStr);
    } catch (error) {
      result = { success: false, error: error.message || '用户同步异常' };
    }
    // 无记录/未绑定属于跳过，不重试；上报或本地标记失败都必须明确失败。
    if (result.success === true || result.skipped === true) return { result, retries: attempt, attempts: attempt + 1 };
    if (attempt === CRON_MAX_RETRIES) return { result, retries: attempt, attempts: attempt + 1 };
  }
}

async function cronSyncAll() {
  const yesterday = getSyncBusinessDate(Date.now() - DAY_MS);
  console.log(`🚀 定时同步开始, 昨天=${yesterday}`);

  let skip = 0;
  const limit = 100;
  let total = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let retries = 0;
  const failedUsers = [];

  while (true) {
    // 注意：定时触发 event 无 OPENID，需扫描全部绑定用户
    // 这里只是数据库分页，所有用户仍在同一次云函数里依次执行，共用执行超时。
    const res = await db.collection('users')
      .where({ bijingBound: true })
      .skip(skip)
      .limit(limit)
      .get();
    const list = res.data;
    if (list.length === 0) break;

    for (const u of list) {
      total++;
      const attempt = await syncDateWithRetry(u._openid, yesterday);
      retries += attempt.retries;
      if (attempt.result.success === true) success++;
      else if (attempt.result.skipped === true) skipped++;
      else {
        failed++;
        const failure = { openid: u._openid, date: yesterday, attempts: attempt.attempts, error: attempt.result.error || '未知同步错误' };
        failedUsers.push(failure);
        console.error('❌ 定时同步重试后仍失败', failure);
      }
    }

    if (list.length < limit) break;
    skip += limit;
  }

  const data = { date: yesterday, total, success, failed, skipped, retries, failedUsers };
  if (failed > 0) {
    console.error('❌ 定时同步部分失败', data);
    return { success: false, code: 'PARTIAL_SYNC_FAILED', error: `${failed} 位同学同步失败，请查看失败明细后补同步`, data };
  }
  console.log('✅ 定时同步完成', data);
  return { success: true, data };
}

// 手动同步仅允许最近七个已在次日 02:00 结束的同步日。
// 每次请求只取一次当前时间，避免跨 02:00 时生成不一致的日期范围。
function getRecentSyncDates(now = Date.now()) {
  return Array.from({ length: 7 }, (_, index) => getSyncBusinessDate(now - (index + 1) * DAY_MS));
}

function validateManualSyncDate(openid, recordDate) {
  if (!openid) return '用户未登录';
  const allowedDates = getRecentSyncDates();
  if (typeof recordDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate) || !allowedDates.includes(recordDate)) {
    return '仅支持同步最近七天已结束的数据（北京时间次日凌晨2点结束）';
  }
  return null;
}

// ===== 同步预览：读取所选日期的明细与按天合计，不上报、不修改数据 =====
async function getSyncDateDetails(openid, recordDate) {
  const validationError = validateManualSyncDate(openid, recordDate);
  if (validationError) return { success: false, error: validationError };

  try {
    const userDoc = await getUserDoc(openid);
    if (!userDoc || !userDoc.bijingBound || !userDoc.bijingStudentNumber) {
      return { success: false, error: '尚未绑定学号' };
    }

    const records = await getDayRecords(openid, recordDate);
    const totalDuration = records.reduce((total, record) => total + record.duration, 0);

    return {
      success: true,
      data: {
        date: recordDate,
        records,
        count: records.length,
        totalDuration,
        syncDuration: Math.round(totalDuration),
        alreadySynced: !!(userDoc.bijingSyncedDates && userDoc.bijingSyncedDates[recordDate]),
      },
    };
  } catch (e) {
    console.error(`❌ 读取同步明细异常 date=${recordDate}:`, e.message);
    return { success: false, error: e.message || '读取同步明细失败' };
  }
}

// ===== 手动同步：只同步用户选择的一天 =====
async function manualSyncSelectedDate(openid, recordDate) {
  const validationError = validateManualSyncDate(openid, recordDate);
  if (validationError) return { success: false, error: validationError };

  try {
    const userDoc = await getUserDoc(openid);
    if (!userDoc || !userDoc.bijingBound || !userDoc.bijingStudentNumber) {
      return { success: false, error: '尚未绑定学号' };
    }

    // 不受绑定时间限制，刚绑定的用户也可以补同步最近七天。
    // 复用 syncDate 的幂等上报与无数据处理，不清除已有同步状态。
    const result = await syncDate(openid, recordDate);
    if (result.success === false) {
      return { success: false, error: result.error || '同步失败' };
    }
    return { success: true, data: { date: recordDate, ...result } };
  } catch (e) {
    console.error(`❌ 手动同步异常 date=${recordDate}:`, e.message);
    return { success: false, error: e.message || '同步失败' };
  }
}

// ===== 兼容旧版手动同步：重新上报最近七个已结束日期的数据 =====
// 无需 force 即可重复同步；旧版传入的 force 不清除状态，也不扩大日期范围。
async function manualSyncPending(openid) {
  if (!openid) return { success: false, error: '用户未登录' };
  const dates = getRecentSyncDates().reverse();
  const userDoc = await getUserDoc(openid);
  if (!userDoc || !userDoc.bijingBound || !userDoc.bijingStudentNumber) {
    return { success: false, error: '尚未绑定学号' };
  }

  console.log(`🚀 手动同步开始: openid=${openid}, dates=${dates.length}`);
  const results = [];
  for (const d of dates) {
    try {
      results.push(await syncDate(openid, d));
    } catch (e) {
      results.push({ openid, date: d, success: false, error: e.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const skipCount = results.filter(r => r.skipped).length;
  const failCount = results.filter(r => r.success === false).length;
  // 既不能成功、也不失败（查不到数据未标记）的日期 = 待同步
  const pendingCount = results.filter(r => !r.success && r.success !== false && !r.skipped).length;

  return {
    success: true,
    data: {
      pending: dates.length,
      synced: successCount,
      skipped: skipCount,
      failed: failCount,
      pendingCount,
      forced: false,
      results,
    },
  };
}

// ===== 入口 =====
exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  // Missing type remains the timer dispatch shape, but never authenticates a caller.
  if (!event.type || event.type === 'cronSyncAll') {
    const { canRunMaintenance, forbidden } = require('./maintenanceAuth');
    if (!canRunMaintenance(wxContext, typeof process === 'undefined' ? {} : process.env, true)) return forbidden();
    return await cronSyncAll();
  }

  switch (event.type) {
    case 'getHeatmap':
      return await require('./heatmap').getHeatmap({ openid, getUserDoc, getApiBase, getAccessToken, axios });
    case 'bindStudentNumber':
      return await bindStudentNumber(openid, event.studentNumber);
    case 'checkStudentNumber':
      return await checkStudentNumber(event.studentNumber);
    case 'getSyncDateDetails':
      return await getSyncDateDetails(openid, event.recordDate);
    case 'syncSelectedDate':
      return await manualSyncSelectedDate(openid, event.recordDate);
    case 'syncPending':
      return await manualSyncPending(openid);
    default:
      return { success: false, error: '未知操作: ' + event.type };
  }
};
