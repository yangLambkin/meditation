const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 使用真实日期/明细工具及可控时钟，验证前台页面无需重进也会在 02:00 换日。
function createPage(kind, { now = '2026-01-01T01:59:59+08:00', dailyRecords = {} } = {}) {
  let currentTime = Date.parse(now);
  let definition;
  let nextTimer = 0;
  const timers = new Map();
  const intervals = new Map();
  const calls = { stats: 0, user: 0, preview: [], records: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const clock = {
    Date: Clock,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: currentTime + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  const modules = {
    'checkin.js': {
      getUserCheckinData: () => ({ dailyRecords }),
      getExperienceRecordsFromLocal: () => [],
      getPendingSyncSummary: () => ({ total: 0, pending: 0, failed: 0 }),
      isUserLoggedIn: () => false,
      recordCheckin: (...args) => { calls.records.push(args); return { success: true }; }
    },
    'contentSec.js': { checkText: async () => true },
    'dailyWisdom.js': { DEFAULT_QUOTE: '静心', watchDailyWisdom: () => () => {} },
    'dailyCardImage.js': { DEFAULT_IMAGE: '/images/p1.png' },
    'memberHistory.js': { initialData: () => ({ isMemberHistory: false }) },
    'lunar.js': { getLunarDate: () => '农历' },
    'images.js': {}, 'badgeManager.js': {}, 'cloudApi.js': {},
    'bijingApi.js': { getBijingHeatmap: async () => ({ success: true, data: { records: [] } }) }
  };
  const wx = { getStorageSync: () => undefined, showToast() {}, switchTab() {} };
  const quiet = { log() {}, warn() {}, error() {} };
  function load(request) {
    const name = path.basename(request).replace(/(?:\.js)?$/, '.js');
    if (modules[name]) return modules[name];
    assert.ok(['dateUtil.js', 'homeCheckin.js', 'heatmap.js', 'profileCache.js'].includes(name), request);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, require: load, ...clock, wx, console: quiet
    });
    modules[name] = module.exports;
    return module.exports;
  }
  const pageFile = kind === 'daily' ? 'daily/daily1' : `${kind}/${kind}`;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages', `${pageFile}.js`), 'utf8'), {
    Page(value) { definition = value; }, require: load, ...clock, wx, console: quiet
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  page.getUserData = () => { calls.user++; };
  page.calculateUserStatistics = () => { calls.stats++; };
  page.checkUserInfoStatus = () => {};
  page.isUserLoggedIn = () => false;
  page.refreshCheckinsFromCloud = async () => false;
  return {
    page, calls, timers, intervals, modules,
    advance(value) {
      currentTime = Date.parse(value);
      for (const [id, timer] of [...timers]) {
        if (timer.at <= currentTime && timers.delete(id)) timer.callback();
      }
    }
  };
}

test('home advances the current calendar month and three-day form exactly at Beijing 02:00', async () => {
  const { page, advance, timers } = createPage('index');
  page.setData({ currentYear: 2025, currentMonth: 12 });
  await page.onShow();
  assert.equal(page.data.todayDate, '2025-12-31');
  assert.equal(page.data.maxCheckinDate, '2025-12-31');
  advance('2026-01-01T02:00:00+08:00');
  assert.equal(page.data.todayDate, '2026-01-01');
  assert.equal(page.data.minCheckinDate, '2025-12-30');
  assert.equal(page.data.maxCheckinDate, '2026-01-01');
  assert.equal(page.data.currentYear, 2026);
  assert.equal(page.data.currentMonth, 1);
  assert.equal(page.data.calendarDays.flat().find(day => day.isToday).fullDate, '2026-01-01');
  page.onHide();
  assert.equal(timers.size, 0);
});

test('home preserves a browsed historical month and updates a hidden page on return', async () => {
  const { page, advance } = createPage('index');
  page.setData({ currentYear: 2025, currentMonth: 11 });
  await page.onShow();
  page.onHide();
  advance('2026-01-01T02:00:00+08:00');
  await page.onShow();
  assert.equal(page.data.todayDate, '2026-01-01');
  assert.equal(page.data.currentMonth, 11);
  page.onUnload();
});

for (const kind of ['history', 'checkinHistory']) {
  test(`${kind} refreshes today's bounds at 02:00 while preserving the selected historical date`, async () => {
    const { page, advance, timers } = createPage(kind);
    page.onLoad({});
    await page.onShow();
    advance('2026-01-01T02:00:00+08:00');
    if (kind === 'history') {
      assert.equal(page.data.todayDate, '2026-01-01');
      assert.equal(page.data.selectedDateKey, '2025-12-31');
      assert.equal(page.data.isToday, false);
    } else {
      assert.equal(page.data.currentDate, '2026-01-01');
      assert.equal(page.data.currentMonth, '2026-01');
      assert.equal(page.data.selectedMonth, '2025-12');
    }
    assert.equal(page.data.canGoNext, true);
    page.onHide();
    assert.equal(timers.size, 0);
  });
}

test('daily card rolls its visible date and reloads statistics at 02:00 independently of wisdom requests', () => {
  const { page, calls, advance, timers } = createPage('daily');
  page.onShow();
  assert.equal(page.data.year, 2025);
  assert.equal(page.data.day, 31);
  const before = calls.user;
  advance('2026-01-01T02:00:00+08:00');
  assert.equal(page.data.year, 2026);
  assert.equal(page.data.month, 'January');
  assert.equal(page.data.day, 1);
  assert.equal(calls.user, before + 1);
  page.onUnload();
  assert.equal(timers.size, 0);
});

test('daily card picks the latest actual record in the business day across old calendar buckets', () => {
  const { page } = createPage('daily', { dailyRecords: {
    '2025-12-31': { records: [{ timestamp: Date.parse('2025-12-31T23:00:00+08:00'), duration: 10 }] },
    '2026-01-01': { records: [
      { timestamp: Date.parse('2026-01-01T01:30:00+08:00'), duration: 30 },
      { timestamp: Date.parse('2026-01-01T00:30:00+08:00'), duration: 20 }
    ] }
  } });
  assert.equal(page.getCurrentMeditationMinutes('2025-12-31'), 30);
  assert.equal(page.getCurrentMeditationMinutes('2026-01-01'), 0);
});

test('personal page expires an open sync selection and updates stats at 02:00', () => {
  const { page, calls, advance, timers } = createPage('me');
  page.loadBijingSyncDetails = date => { calls.preview.push(date); };
  page.onShow();
  page.setData({ bijingShowSyncDatePicker: true, bijingSyncDate: '2025-12-24' });
  advance('2026-01-01T02:00:00+08:00');
  assert.equal(calls.stats, 1);
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, entry => entry.date),
    ['2025-12-31', '2025-12-30', '2025-12-29', '2025-12-28', '2025-12-27', '2025-12-26', '2025-12-25']);
  assert.equal(page.data.bijingSyncDate, '2025-12-31');
  assert.deepEqual(calls.preview, ['2025-12-31']);
  page.onHide();
  assert.equal(timers.size, 0);
});

test('heatmap adds the new year at 02:00 and removes its timer when hidden', async () => {
  const { page, advance, timers } = createPage('bijingHeatmap');
  await page.onLoad();
  page.onShow();
  assert.deepEqual(Array.from(page.data.heatmaps, chart => chart.year), [2025]);
  advance('2026-01-01T02:00:00+08:00');
  assert.deepEqual(Array.from(page.data.heatmaps, chart => chart.year), [2026, 2025]);
  const january1 = page.data.heatmaps[0].weeks.flatMap(week => week.days).find(day => day.date === '2026-01-01');
  assert.equal(january1.future, false);
  page.onUnload();
  assert.equal(timers.size, 0);
});

test('manual moderation crossing 02:00 keeps the date and timestamp captured at submission', async () => {
  const { page, modules, calls, advance } = createPage('index');
  let approve;
  modules['contentSec.js'].checkText = () => new Promise(resolve => { approve = resolve; });
  page.refreshPageData = () => {};
  page.setData({ currentYear: 2025, currentMonth: 12 });
  await page.onShow();
  page.openCheckinModal();
  page.setData({ checkinExperience: '平静' });
  const saving = page.submitCheckin();
  advance('2026-01-01T02:00:00+08:00');
  approve(true);
  await saving;
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0][3], Date.parse('2026-01-01T01:59:59+08:00'));
  assert.equal(calls.records[0][4].date, '2025-12-31');
  page.onUnload();
});
