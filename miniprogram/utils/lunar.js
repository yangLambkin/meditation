// 真实农历日期工具
// 使用 npm 包 lunar-javascript（6tail，纯 CommonJS，对微信小程序「构建 npm」最友好）
// 经微信「构建 npm」打包后，本文件 require('lunar-javascript') 即可解析
const { Lunar } = require('lunar-javascript')

// 6tail 的 getMonthInChinese 返回不带「月」的中文数字（如「正」「五」「闰二」），这里补「月」
function getLunarMonth(lunar) {
  const m = lunar.getMonthInChinese()
  return m.endsWith('月') ? m : m + '月'
}

// 对外契约不变：getLunarDate(Date) -> "丙午年正月初五"，调用方无需改动
function getLunarDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return ''
  }
  try {
    const lunar = Lunar.fromDate(date)
    const year = lunar.getYearInGanZhi()  // 丙午
    const month = getLunarMonth(lunar)    // 正月 / 闰二月
    const day = lunar.getDayInChinese()   // 初五
    return year + '年' + month + day
  } catch (e) {
    return ''
  }
}

module.exports = {
  getLunarDate
}
