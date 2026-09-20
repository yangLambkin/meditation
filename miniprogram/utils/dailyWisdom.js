const { getCheckinDay } = require('./homeCheckin.js');

const DEFAULT_QUOTE = '静心即是修心，心安即是归处。';
const STORAGE_KEY = 'dailyWisdom';
const DAY = 24 * 60 * 60 * 1000;
let cachedQuote = null;
const pending = new Map();

// 首页和分享卡片共用当天首次成功取得的金句，以北京时间 02:00 分日。
function getDailyWisdom() {
  const day = getCheckinDay();
  if (cachedQuote && cachedQuote.day === day) return Promise.resolve(cachedQuote);
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    if (saved && saved.day === day && typeof saved.content === 'string' && saved.content.trim()) {
      cachedQuote = { day, content: saved.content.trim() };
      return Promise.resolve(cachedQuote);
    }
  } catch (error) {
    // 本地存储不可用时，仍通过内存缓存保持本次会话的一致性。
  }
  if (pending.has(day)) return pending.get(day);

  const request = Promise.resolve()
    .then(() => wx.cloud.callFunction({ name: 'getRandomWisdom' }))
    .then(response => {
      // 请求可能跨过 02:00；旧日响应不能写入缓存或显示到新日页面。
      if (getCheckinDay() !== day) return getDailyWisdom();
      const result = response && response.result;
      const quote = result && result.data;
      if (!result || !result.success || result.error || !quote || quote._id === 'default' ||
          typeof quote.content !== 'string' || !quote.content.trim()) {
        return { day, content: DEFAULT_QUOTE };
      }
      cachedQuote = { day, content: quote.content.trim() };
      try {
        wx.setStorageSync(STORAGE_KEY, cachedQuote);
      } catch (error) {
        // 写入失败不影响内存缓存。
      }
      return cachedQuote;
    })
    .catch(() => getCheckinDay() === day ? { day, content: DEFAULT_QUOTE } : getDailyWisdom())
    .finally(() => pending.delete(day));
  pending.set(day, request);
  return request;
}

function watchDailyWisdom(onChange) {
  let stopped = false;
  let timer = null;
  let revision = 0;

  function refresh() {
    const currentRevision = ++revision;
    getDailyWisdom().then(quote => {
      if (stopped || currentRevision !== revision) return;
      if (quote.day !== getCheckinDay()) {
        refresh();
        return;
      }
      onChange(quote);
    });
  }

  function schedule() {
    const now = Date.now();
    const nextBoundary = Date.parse(`${getCheckinDay(now)}T02:00:00+08:00`) + DAY;
    timer = setTimeout(() => {
      if (stopped) return;
      refresh();
      schedule();
    }, Math.max(1, nextBoundary - now));
  }

  schedule();
  refresh();
  return function stop() {
    stopped = true;
    revision++;
    clearTimeout(timer);
  };
}

module.exports = { DEFAULT_QUOTE, getDailyWisdom, watchDailyWisdom };
