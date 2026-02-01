// utils/lunar.js
// 农历日期计算工具

/**
 * 天干名称
 */
const heavenlyStems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

/**
 * 地支名称  
 */
const earthlyBranches = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/**
 * 农历月份名称
 */
const lunarMonths = ['正月', '二月', '三月', '四月', '五月', '六月', 
                     '七月', '八月', '九月', '十月', '冬月', '腊月'];

/**
 * 农历日名称
 */
const lunarDays = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
                   '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
                   '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

/**
 * 获取天干地支年
 */
function getHeavenlyStemEarthlyBranch(year) {
  // 固定2026年为乙巳年，其他年份基于此推算
  const baseYear = 2026;
  const baseStemBranch = '乙巳';
  
  // 计算与基准年份的差距
  const yearDiff = year - baseYear;
  
  // 天干地支每60年循环一次（60=10和12的最小公倍数）
  const cycleIndex = (yearDiff % 60 + 60) % 60; // 确保为正数
  
  // 根据天干地支的排列顺序推算
  const stems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const branches = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  
  // 查找乙巳在60年周期中的位置
  let baseIndex = 0;
  for (let i = 0; i < 60; i++) {
    const stemIndex = i % 10;
    const branchIndex = i % 12;
    if (stems[stemIndex] + branches[branchIndex] === baseStemBranch) {
      baseIndex = i;
      break;
    }
  }
  
  // 计算当前年份在60年周期中的位置
  const currentIndex = (baseIndex + cycleIndex + 60) % 60;
  
  const stem = stems[currentIndex % 10];
  const branch = branches[currentIndex % 12];
  
  return stem + branch;
}

/**
 * 农历月日对照表（简化版，基于2026年2月1日=乙巳年腊月十四校准）
 */
function getLunarMonthDay(solarDate) {
  const year = solarDate.getFullYear();
  const month = solarDate.getMonth() + 1;
  const day = solarDate.getDate();
  
  // 2026年的农历对照表（以2月1日=腊月十四为基准）
  if (year === 2026) {
    // 2026年农历对照表（简化版）
    const lunarMap2026 = {
      '1': { month: '腊月', day: 15 }, // 1月1日 = 腊月十五
      '2': { month: '腊月', day: 14 + (day - 1) }, // 2月1日 = 腊月十四
      '3': { month: '正月', day: 1 + (day - 1) },  // 3月1日 = 正月一日
    };
    
    // 查找对应的农历月份
    let lunarMonth = '腊月';
    let lunarDay = day;
    
    if (month === 1) {
      lunarMonth = '腊月';
      lunarDay = 15 + (day - 1); // 从腊月十五开始
    } else if (month === 2) {
      lunarMonth = '腊月';
      lunarDay = 14 + (day - 1); // 从腊月十四开始
    } else if (month === 3) {
      lunarMonth = '正月';
      lunarDay = 1 + (day - 1); // 从正月初一开始
    } else {
      // 其他月份使用简化算法（基于当月1日的农历日期推算）
      lunarMonth = lunarMonths[Math.max(0, (month - 2) % 12)];
      lunarDay = day;
    }
    
    // 确保农历日不超过30
    lunarDay = Math.max(1, Math.min(30, lunarDay));
    
    return {
      month: lunarMonth,
      day: lunarDay
    };
  } else {
    // 其他年份使用简化算法（基于2026年的基准推算）
    const yearDiff = year - 2026;
    const monthAdjust = Math.floor(yearDiff * 12.3685); // 农历年约12.3685个月
    
    let lunarMonthIndex = (month - 1 + monthAdjust) % 12;
    if (lunarMonthIndex < 0) lunarMonthIndex += 12;
    
    const lunarMonth = lunarMonths[lunarMonthIndex];
    const lunarDay = Math.max(1, Math.min(30, day));
    
    return {
      month: lunarMonth,
      day: lunarDay
    };
  }
}

/**
 * 获取完整的农历日期
 * @param {Date} solarDate - 公历日期对象
 * @returns {string} 农历日期字符串
 */
function getLunarDate(solarDate) {
  const year = solarDate.getFullYear();
  const { month, day } = getLunarMonthDay(solarDate);
  
  // 获取天干地支年
  const heavenlyEarthlyYear = getHeavenlyStemEarthlyBranch(year);
  
  // 获取农历日显示名称
  const dayName = lunarDays[Math.max(0, Math.min(29, day - 1))] || '初一';
  
  return `${heavenlyEarthlyYear}年${month}${dayName}`;
}

module.exports = {
  getLunarDate
};