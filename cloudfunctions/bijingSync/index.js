const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

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

// ===== 外部系统配置（全部走环境变量，前端不持有） =====
function getApiBase() {
  // 测试: data.bjzl.net.cn  生产: data.bijing.life
  return process.env.BIJING_API_BASE || 'https://data.bjzl.net.cn';
}
function getAccessToken() {
  return process.env.BIJING_ACCESS_TOKEN || 'JINGZUO_XIAOCHENGXU';
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

// 仅云端聚合：某用户某天 sum(duration)
async function getDayDuration(openid, dateStr) {
  const result = await db.collection('meditation_records')
    .aggregate()
    .match({ _openid: openid, date: dateStr })
    .group({ _id: null, total: $.sum('$duration') })
    .end();
  if (result.list && result.list.length > 0) {
    return Math.round(result.list[0].total || 0);
  }
  return 0;
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
    bijingSyncedDates: (userDoc && userDoc.bijingSyncedDates) || {},
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

// ===== 核心：同步某用户某一天 =====
async function syncDate(openid, dateStr) {
  const userDoc = await getUserDoc(openid);
  if (!userDoc || !userDoc.bijingBound) {
    return { openid, date: dateStr, skipped: true, reason: '未绑定' };
  }
  // 去重：已标记则跳过
  const synced = userDoc.bijingSyncedDates || {};
  if (synced[dateStr]) {
    return { openid, date: dateStr, skipped: true, reason: '已同步' };
  }

  const duration = await getDayDuration(openid, dateStr);
  if (duration <= 0) {
    // 当天云端查不到打卡数据：不标记 synced。
    // 可能是备份异步未完成（暂时性），留待下次同步复查，
    // 避免把"查不到"误标为"已同步"而永久跳过（修复 8.1 漏同步）。
    return { openid, date: dateStr, skipped: true, reason: '无打卡数据(未标记待复查)', duration: 0 };
  }

  try {
    const resp = await postMeditationRecord(userDoc.bijingStudentNumber, dateStr, duration);
    if (resp && resp.success) {
      await markSynced(openid, dateStr);
      return { openid, date: dateStr, success: true, duration };
    }
    // 对端返回失败
    console.error(`❌ 上报失败 date=${dateStr}:`, resp && resp.message);
    return { openid, date: dateStr, success: false, error: (resp && resp.message) || '未知错误', duration };
  } catch (e) {
    console.error(`❌ 上报异常 date=${dateStr}:`, e.message);
    return { openid, date: dateStr, success: false, error: e.message, duration };
  }
}

// 写入同步标记（不覆盖其它日期）
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

// ===== 凌晨 4 点自动：同步所有绑定用户各自"昨天" =====
async function cronSyncAll() {
  const yesterday = getBusinessDate(new Date(Date.now() - 24 * 3600 * 1000));
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

// ===== 手动兜底：补"绑定日 → 今天"区间里所有未标记日期 =====
// force=true 时：先清空目标区间内的同步标记，再重新核算上报（用于纠正历史误标）
async function manualSyncPending(openid, force = false) {
  if (!openid) return { success: false, error: '用户未登录' };
  const userDoc = await getUserDoc(openid);
  if (!userDoc || !userDoc.bijingBound) {
    return { success: false, error: '尚未绑定学号' };
  }

  const today = getBusinessDate(new Date());
  // 起始日期：绑定日（bijingBoundAt 当天）
  const boundDate = userDoc.bijingBoundAt
    ? getBusinessDate(new Date(userDoc.bijingBoundAt))
    : today;

  // 生成 [boundDate, 今天] 区间所有日期（含今天，同步"绑定日 → 当前时间"的全部未标记数据）
  const dates = [];
  let cursor = new Date(boundDate + 'T00:00:00+08:00');
  const end = new Date(today + 'T00:00:00+08:00');
  while (cursor <= end) {
    dates.push(getBusinessDate(cursor));
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }

  const synced = userDoc.bijingSyncedDates || {};
  let pending = dates.filter(d => !synced[d]);

  // 强制重同步：清除目标区间内标记，使这些日期重新进入 pending 被复查
  if (force) {
    const cleared = dates.filter(d => synced[d]);
    if (cleared.length > 0) {
      const newSynced = { ...synced };
      cleared.forEach(d => { delete newSynced[d]; });
      try {
        await db.collection('users').doc(userDoc._id).update({
          data: { bijingSyncedDates: newSynced },
        });
        console.log(`🧹 强制重同步: 已清除 ${cleared.length} 个历史标记, dates=${cleared.join(',')}`);
      } catch (e) {
        console.error('❌ 清除同步标记失败:', e.message);
      }
    }
    pending = dates.slice(); // 全部重新核算
  }

  console.log(`🚀 手动同步开始: openid=${openid}, force=${!!force}, pending=${pending.length}`);
  const results = [];
  for (const d of pending) {
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
      pending: pending.length,
      synced: successCount,
      skipped: skipCount,
      failed: failCount,
      pendingCount,
      forced: !!force,
      results,
    },
  };
}

// ===== 入口 =====
exports.main = async (event, context) => {
  // 启动日志：区分触发来源（timer 定时 / 手动），便于验证触发器是否生效
  const wxContext = cloud.getWXContext();
  const isTimer = !wxContext.OPENID && event.type === 'cronSyncAll';
  console.log('📥 bijingSync 触发, source=', isTimer ? 'TIMER(定时)' : 'MANUAL(手动)',
    ', openid=', wxContext.OPENID || 'none',
    ', type=', event.type,
    ', time=', new Date().toISOString());
  const openid = wxContext.OPENID;

  switch (event.type) {
    case 'bindStudentNumber':
      return await bindStudentNumber(openid, event.studentNumber);
    case 'syncPending':
      return await manualSyncPending(openid, event.force === true);
    case 'cronSyncAll':
      // 定时触发（无 OPENID）
      return await cronSyncAll();
    default:
      return { success: false, error: '未知操作: ' + event.type };
  }
};
