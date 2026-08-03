// 必经之路同步接口封装
// 所有外部系统交互都在 bijingSync 云函数内完成，前端只负责调用云函数。
const cloudApi = require('./cloudApi.js');

// 调用 bijingSync 云函数并标准化返回 { success, data, error }
async function callBijingSync(data) {
  try {
    const res = await cloudApi.callCloudFunction('bijingSync', data);
    const result = res && res.result;
    if (result && result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: (result && result.error) || '操作失败' };
  } catch (e) {
    return { success: false, error: e.message || '网络错误' };
  }
}

// 绑定必经之路学号
// 返回 { success, data: { studentNumber, nickname, nicknameOverridden }, error }
async function bindBijing(studentNumber) {
  return callBijingSync({ type: 'bindStudentNumber', studentNumber });
}

// 手动兜底同步（绑定日 -> 昨天 区间里所有未标记日期）
// force=true 时清除目标区间历史标记重新核算（纠正误标）
// 返回 { success, data: { pending, synced, skipped, failed, pendingCount, results }, error }
async function syncBijingPending(force = false) {
  return callBijingSync({ type: 'syncPending', force: !!force });
}

module.exports = {
  bindBijing,
  syncBijingPending,
};
