// utils/lunar.js
// 农历日期计算工具（简化版）

/**
 * 获取农历日期（简化版）
 * 实际应用中建议使用完整的农历库
 * @param {Date} solarDate - 公历日期对象
 * @returns {string} 农历日期字符串
 */
function getLunarDate(solarDate) {
  const year = solarDate.getFullYear();
  const month = solarDate.getMonth() + 1;
  const day = solarDate.getDate();
  
  // 简化版农历转换，实际需要完整的农历算法
  // 这里使用一个简单的映射作为示例
  const lunarMonths = ['正月', '二月', '三月', '四月', '五月', '六月', 
                       '七月', '八月', '九月', '十月', '冬月', '腊月'];
  
  // 简单计算农历月份（实际算法复杂）
  let lunarMonth = Math.max(1, (month + 1) % 12);
  let lunarDay = day;
  
  // 如果是月末，可能会有特殊处理
  if (day > 28) {
    lunarDay = Math.min(30, lunarDay);
  }
  
  return `农历${lunarMonths[lunarMonth - 1]}${lunarDay}日`;
}

module.exports = {
  getLunarDate
};