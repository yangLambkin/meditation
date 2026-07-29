// 业务日期工具：全应用唯一的"天/月"基准。
// 原因：业务上的"今天/本月"此前用 new Date().toISOString().split('T')[0] 生成，
// 该值基于 UTC，导致中国时区 00:00–08:00 期间归属前一天/上月（全局根因 ③）。
// 解决：显式按东八区（中国时区 UTC+8）划分业务日期。采用"时间 +8h 后用 UTC 分量取值"
// 的技巧，使结果不受运行环境本地时区影响，从而保证前端（用户手机）与云端
// （云函数容器）使用完全一致的日期基准。

function getBusinessDate(date) {
  const d = date ? new Date(date) : new Date();
  // 加 8 小时使其落在东八区，再用 UTC 分量读取，规避环境时区差异
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBusinessMonth(date) {
  return getBusinessDate(date).substring(0, 7);
}

module.exports = {
  getBusinessDate,
  getBusinessMonth
};
