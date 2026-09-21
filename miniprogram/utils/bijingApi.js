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

// 仅校验学号（不绑定），用于绑定前确认弹窗
// 返回 { success, data: { studentNumber, nickname }, error }
async function checkBijing(studentNumber) {
  return callBijingSync({ type: 'checkStudentNumber', studentNumber });
}

// 同步选中的一天；云端限制为北京时间 02:00 切日后的最近七个已结束同步日
// 使用独立操作名，避免旧版云函数忽略日期参数后执行批量同步
async function syncBijingDate(recordDate) {
  return callBijingSync({ type: 'syncSelectedDate', recordDate });
}

// 只读取所选日期的同步明细与合计，不上报、不写入同步标记
async function getBijingSyncDateDetails(recordDate) {
  return callBijingSync({ type: 'getSyncDateDetails', recordDate });
}

async function getBijingHeatmap() {
  return callBijingSync({ type: 'getHeatmap' });
}

module.exports = {
  getBijingHeatmap,
  bindBijing,
  checkBijing,
  syncBijingDate,
  getBijingSyncDateDetails,
};
