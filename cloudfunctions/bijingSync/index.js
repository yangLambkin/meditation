const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// ===== 业务日期工具：与 meditationManager / dateUtil 完全一致 =====
// 采用"时间 +8h 后读 UTC 分量"技巧，使结果不受运行环境本地时区影响，
// 保证云端与前端使用完全一致的东八区日期基准，避免时差导致同步错日期。
function getBusinessDate(date) {
  const d = date ? new Date(date) : new Date();
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_CUTOFF_MS = 4 * 60 * 60 * 1000;

// 必经同步单独按北京时间 04:00 切日；原始打卡 date 仍保留自然日。
function getSyncBusinessDate(timestamp) {
  return getBusinessDate(new Date(timestamp - SYNC_CUTOFF_MS));
}

function getSyncDateWindow(dateStr) {
  const start = Date.parse(`${dateStr}T04:00:00+08:00`);
  return { start, end: start + DAY_MS };
}

function hasRecordTimestamp(timestamp) {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 &&
    !Number.isNaN(new Date(timestamp).getTime());
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

// 预览和上报共用同一批云端记录，避免原自然日 date 丢掉次日凌晨的打卡。
async function getDayRecords(openid, dateStr) {
  const { start, end } = getSyncDateWindow(dateStr);
  const filter = _.or([
    { _openid: openid, timestamp: _.gte(start).and(_.lt(end)) },
    { _openid: openid, date: dateStr },
  ]);
  const records = [];
  const limit = 100;
  for (let skip = 0; ; skip += limit) {
    const result = await db.collection('meditation_records')
      .where(filter)
      .field({ _id: true, date: true, timestamp: true, duration: true })
      .orderBy('_id', 'asc')
      .skip(skip)
      .limit(limit)
      .get();
    for (const record of result.data) {
      const hasTime = hasRecordTimestamp(record.timestamp);
      // 旧记录缺少有效时间戳时，只能沿用原日期；不能用上传时间推测打卡时间。
      if (hasTime ? record.timestamp < start || record.timestamp >= end : record.date !== dateStr) continue;
      records.push({
        id: record._id,
        timestamp: hasTime ? record.timestamp : null,
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
  if (!studentNumber) return { success: false, error: '学号不能为空' };

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
  if (!studentNumber) return { success: false, error: '学号不能为空' };
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

  // 必须等次日 04:00 窗口结束后上报，保证同步日已完整结束。
  if (getSyncDateWindow(dateStr).end > new Date().getTime()) {
    return { openid, date: dateStr, success: false, error: '该日记录尚未结束，请在次日凌晨4点后同步', duration };
  }

  try {
    const resp = await postMeditationRecord(userDoc.bijingStudentNumber, dateStr, duration);
    if (resp && resp.success) {
      await markSynced(openid, dateStr);
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
async function markSynced(openid, dateStr) {
  try {
    const userDoc = await getUserDoc(openid);
    if (!userDoc) return;
    const synced = userDoc.bijingSyncedDates || {};
    synced[dateStr] = true;
    await db.collection('users').doc(userDoc._id).update({
      data: { bijingSyncedDates: synced },
    });
  } catch (e) {
    console.error('❌ 写入同步标记失败:', e.message);
  }
}

// ===== 凌晨 4 点自动：同步所有绑定用户最近一个已结束的同步日 =====
async function cronSyncAll() {
  const yesterday = getSyncBusinessDate(Date.now() - DAY_MS);
  console.log(`🚀 定时同步开始, 昨天=${yesterday}`);

  let skip = 0;
  const limit = 100;
  let total = 0;
  let success = 0;
  let failed = 0;

  while (true) {
    // 注意：定时触发 event 无 OPENID，需扫描全部绑定用户
    // 用户量大时本循环 limit/offset 已是分批；可进一步并行化
    const res = await db.collection('users')
      .where({ bijingBound: true })
      .skip(skip)
      .limit(limit)
      .get();
    const list = res.data;
    if (list.length === 0) break;

    for (const u of list) {
      total++;
      try {
        const r = await syncDate(u._openid, yesterday);
        if (r.success) success++;
        else if (r.success === false) failed++;
      } catch (e) {
        failed++;
        console.error(`❌ 用户同步异常 openid=${u._openid}:`, e.message);
      }
    }

    if (list.length < limit) break;
    skip += limit;
  }

  console.log(`✅ 定时同步完成: total=${total}, success=${success}, failed=${failed}, date=${yesterday}`);
  return { success: true, data: { date: yesterday, total, success, failed } };
}

// 手动同步仅允许最近三个已在次日 04:00 结束的同步日。
// 每次请求只取一次当前时间，避免跨 04:00 时生成不一致的日期范围。
function getRecentSyncDates(now = Date.now()) {
  return [1, 2, 3].map(daysAgo => getSyncBusinessDate(now - daysAgo * DAY_MS));
}

function validateManualSyncDate(openid, recordDate) {
  if (!openid) return '用户未登录';
  const allowedDates = getRecentSyncDates();
  if (typeof recordDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate) || !allowedDates.includes(recordDate)) {
    return '仅支持同步最近三天已结束的数据（北京时间次日凌晨4点结束）';
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

    // 不受绑定时间限制，刚绑定的用户也可以补同步最近三天。
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

// ===== 兼容旧版手动同步：重新上报最近三个已结束日期的数据 =====
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
exports.main = async (event, context) => {
  // 启动日志：区分触发来源（timer 定时 / 手动），便于验证触发器是否生效
  const wxContext = cloud.getWXContext();
  // 微信定时触发器：context.source === 'timer'，且 event 不含自定义 type 字段
  const isTimer = (context.source === 'timer') || (!wxContext.OPENID && !event.type);
  console.log('📥 bijingSync 触发, source=', isTimer ? 'TIMER(定时)' : 'MANUAL(手动)',
    ', openid=', wxContext.OPENID || 'none',
    ', type=', event.type,
    ', time=', new Date().toISOString());
  const openid = wxContext.OPENID;

  // 定时触发：自动走全量同步（兼容 event 不带 type 的情况）
  if (isTimer) {
    return await cronSyncAll();
  }

  switch (event.type) {
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
    case 'cronSyncAll':
      return await cronSyncAll();
    default:
      return { success: false, error: '未知操作: ' + event.type };
  }
};
