const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/index/index.js');
const utilsPath = path.join(__dirname, '../miniprogram/utils');

function createPage({ now = '2026-09-17T08:25:37.123+08:00', dailyRecords = {}, experiences = [], legacyExperiences = [], legacyUserRecords = {}, record, checkText, refreshFromCloud } = {}) {
  let currentTime = Date.parse(now);
  let definition;
  const calls = { record: [], content: [], toast: [], navigation: [], refresh: 0, cloudRefresh: 0, userDataReads: 0, stopPullDownRefresh: 0 };
  const intervals = new Map();
  let nextInterval = 1;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const checkinManager = {
    getUserCheckinData: () => { calls.userDataReads++; return { dailyRecords }; },
    getDailyCheckinCountSync: date => dailyRecords[date] ? dailyRecords[date].count : 0,
    getExperienceRecordsFromLocal: ids => experiences.filter(value => ids.includes(value._id || value.uniqueId)),
    refreshFromCloud: () => {
      calls.cloudRefresh++;
      return refreshFromCloud ? refreshFromCloud() : false;
    },
    recordCheckin: (...args) => {
      calls.record.push(args);
      return record ? record(...args) : { success: true };
    }
  };
  const wx = {
    getStorageSync: key => key === 'meditationTextRecords' ? legacyExperiences
      : key === 'meditationUserRecords' ? legacyUserRecords : undefined,
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigation.push(value),
    showLoading() {},
    hideLoading() {},
    stopPullDownRefresh: () => { calls.stopPullDownRefresh++; }
  };
  const modules = {
    'dailyWisdom.js': { DEFAULT_QUOTE: '每日金句', watchDailyWisdom: () => () => {} },
    'checkin.js': checkinManager,
    'contentSec.js': {
      checkText: async (...args) => {
        calls.content.push(args);
        return checkText ? checkText(...args) : true;
      }
    }
  };
  function loadModule(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js'].includes(filename), `Unexpected dependency: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(utilsPath, filename), 'utf8'), {
      module, require: loadModule, Date: Clock, wx, console
    }, { filename });
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: loadModule,
    Page: value => { definition = value; },
    Date: Clock,
    wx,
    console,
    setInterval(callback, milliseconds) {
      const id = nextInterval++;
      intervals.set(id, { callback, milliseconds });
      return id;
    },
    clearInterval(id) { intervals.delete(id); }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values, callback) {
      Object.assign(this.data, values);
      if (callback) callback();
    },
    refreshPageData() { calls.refresh++; }
  };
  return { page, calls, intervals, setNow: value => { currentTime = Date.parse(value); } };
}

function change(page, field, value) {
  page[`onCheckin${field}Change`]({ detail: { value } });
}

function makeRecords(count, startAt = '2026-09-17T04:10:00+08:00') {
  const dailyRecords = {};
  const start = Date.parse(startAt);
  for (let index = 0; index < count; index++) {
    const timestamp = start + index * 60 * 1000;
    const date = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!dailyRecords[date]) dailyRecords[date] = { count: 0, records: [] };
    dailyRecords[date].records.unshift({ timestamp, duration: index + 1, experience: [] });
    dailyRecords[date].count++;
  }
  return dailyRecords;
}

test('home form starts with seven minutes and the current Beijing date and time', () => {
  const { page } = createPage({ now: '2026-09-16T16:05:37.123Z' });
  page.refreshCheckinDefaults();
  assert.equal(page.data.checkinDate, '2026-09-17');
  assert.equal(page.data.checkinTime, '00:05');
  assert.equal(page.data.maxCheckinDate, '2026-09-17');
  assert.equal(page.data.checkinDuration, '7');
  assert.equal(page.data.checkinExperience, '');
  assert.equal(page.data.checkinSubmitting, false);
});

test('home calendar and detail navigation agree on the day before 04:00 across a month boundary', () => {
  const { page, calls } = createPage({ now: '2026-10-01T03:59:59+08:00', dailyRecords: {
    '2026-10-01': { count: 1, records: [{ timestamp: Date.parse('2026-10-01T00:04:33+08:00'), duration: 15 }] }
  } });
  page.setData({ currentYear: 2026, currentMonth: 9, userOpenId: 'local-user' });
  page.generateCalendar();
  assert.equal(calls.userDataReads, 1, 'all 42 calendar cells share one standard record read');
  assert.equal(page.data.todayDate, '2026-09-30');
  const days = page.data.calendarDays.flat();
  assert.equal(days.find(day => day.fullDate === '2026-09-30').isToday, true);
  assert.equal(days.find(day => day.fullDate === '2026-09-30').isChecked, true);
  assert.equal(days.find(day => day.fullDate === '2026-10-01').isChecked, false);
  page.selectDate({ currentTarget: { dataset: { date: '2026-09-30' } } });
  page.refreshCheckinRecords();
  const record = page.data.checkinRecords[0];
  const template = fs.readFileSync(pagePath.replace(/\.js$/, '.wxml'), 'utf8');
  assert.match(template, /bindtap="openCheckinHistory" data-date="\{\{record\.dayDate\}\}"/);
  page.openCheckinHistory({ currentTarget: { dataset: { date: record.dayDate } } });
  assert.deepEqual(calls.navigation.map(item => item.url), [
    '/pages/history/history?date=2026-09-30', '/pages/history/history?date=2026-09-30'
  ]);
  assert.equal(record.date, '2026-10-01', 'the original bucket remains available for deletion');
});

test('calendar retains count-only legacy records without adding a midnight bucket beside real details', () => {
  const { page } = createPage({
    dailyRecords: {
      '2026-09-17': { count: 1, records: [{ timestamp: '2026-09-17T00:04:33+08:00', duration: 15 }] },
      '2026-09-12': { count: 2 }
    },
    legacyUserRecords: {
      'local-user': { dailyRecords: { '2026-09-17': { count: 1 }, '2026-09-11': { count: 1 } } },
      migrated: { migrated: true, migratedTo: 'local-user', dailyRecords: {
        '2026-09-10': { count: 1 },
        '2026-09-09': { count: 1, records: [{ timestamp: '2026-09-09T03:59:59+08:00', duration: 7 }] }
      } },
      unrelated: { dailyRecords: { '2026-09-07': { count: 1 } } }
    }
  });
  page.setData({ currentYear: 2026, currentMonth: 9, userOpenId: 'local-user' });
  page.generateCalendar();
  assert.deepEqual(Array.from(page.data.calendarDays.flat().filter(day => day.isChecked), day => day.fullDate), [
    '2026-09-08', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-16'
  ]);
});

test('home clock advances the calendar today marker at 04:00 together with the recent-day window', async () => {
  const { page, intervals, setNow } = createPage({ now: '2026-10-01T03:59:30+08:00' });
  page.setData({ currentYear: 2026, currentMonth: 10, userOpenId: 'local-user' });
  page.checkUserInfoStatus = () => {};
  await page.onShow();
  assert.equal(page.data.todayDate, '2026-09-30');
  assert.equal(page.data.calendarDays.flat().find(day => day.isToday).fullDate, '2026-09-30');
  setNow('2026-10-01T04:00:00+08:00');
  Array.from(intervals.values())[0].callback();
  assert.equal(page.data.todayDate, '2026-10-01');
  assert.equal(page.data.calendarDays.flat().find(day => day.isToday).fullDate, '2026-10-01');
  page.onUnload();
});

test('refresh preserves explicitly edited date and time independently', () => {
  const dateOnly = createPage();
  dateOnly.page.refreshCheckinDefaults();
  change(dateOnly.page, 'Date', '2026-09-15');
  dateOnly.setNow('2026-09-18T09:42:00+08:00');
  dateOnly.page.refreshCheckinDefaults();
  assert.equal(dateOnly.page.data.checkinDate, '2026-09-15');
  assert.equal(dateOnly.page.data.checkinTime, '09:42');
  assert.equal(dateOnly.page.data.maxCheckinDate, '2026-09-18');

  const timeOnly = createPage();
  timeOnly.page.refreshCheckinDefaults();
  change(timeOnly.page, 'Time', '07:15');
  timeOnly.setNow('2026-09-18T09:42:00+08:00');
  timeOnly.page.refreshCheckinDefaults();
  assert.equal(timeOnly.page.data.checkinDate, '2026-09-18');
  assert.equal(timeOnly.page.data.checkinTime, '07:15');
});

test('unedited fields submit the actual current instant even after Beijing midnight', async () => {
  const { page, calls, setNow } = createPage({ now: '2026-09-17T23:59:30+08:00' });
  page.refreshCheckinDefaults();
  setNow('2026-09-18T00:02:37.456+08:00');
  await page.submitCheckin();
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0][0], 7);
  assert.deepEqual(Array.from(calls.record[0][1]), []);
  assert.deepEqual(Array.from(calls.record[0][2]), []);
  assert.equal(calls.record[0][3], Date.parse('2026-09-18T00:02:37.456+08:00'));
  assert.equal(calls.content.length, 0);
  assert.equal(calls.refresh, 1);
  assert.equal(page.data.checkinDate, '2026-09-18');
  assert.equal(page.data.checkinTime, '00:02');
  assert.equal(page.data.checkinSubmitting, false);
  assert.ok(calls.toast.some(value => /成功/.test(value.title)));
});

test('manual date/time and experience are submitted together after text approval', async () => {
  const { page, calls } = createPage();
  page.refreshCheckinDefaults();
  change(page, 'Date', '2026-09-15');
  change(page, 'Time', '06:32');
  page.onCheckinDurationInput({ detail: { value: '35' } });
  page.onCheckinExperienceInput({ detail: { value: '今天更能觉察呼吸。' } });
  await page.submitCheckin();
  assert.deepEqual(calls.content, [['今天更能觉察呼吸。', 2]]);
  assert.equal(calls.record.length, 1);
  const [duration, emotion, experience, timestamp] = calls.record[0];
  assert.equal(duration, 35);
  assert.deepEqual(Array.from(emotion), []);
  assert.equal(experience.length, 1);
  assert.equal(experience[0].text, '今天更能觉察呼吸。');
  assert.equal(timestamp, Date.parse('2026-09-15T06:32:00+08:00'));
  assert.equal(page.data.checkinExperience, '');
  assert.equal(page.data.checkinDate, '2026-09-17');
  assert.equal(page.data.checkinTime, '08:25');
  assert.equal(calls.refresh, 1);
});

test('duration must be an integer from one through 1440 minutes', async () => {
  for (const invalid of ['', '0', '-1', '1.5', '1441', 'invalid', 'Infinity']) {
    const { page, calls } = createPage();
    page.refreshCheckinDefaults();
    page.onCheckinDurationInput({ detail: { value: invalid } });
    await page.submitCheckin();
    assert.equal(calls.record.length, 0, invalid);
    assert.equal(calls.content.length, 0, invalid);
    assert.equal(page.data.checkinSubmitting, false, invalid);
    assert.ok(calls.toast.length > 0, invalid);
  }
  for (const valid of ['1', '1440']) {
    const { page, calls } = createPage();
    page.refreshCheckinDefaults();
    page.onCheckinDurationInput({ detail: { value: valid } });
    await page.submitCheckin();
    assert.equal(calls.record.length, 1, valid);
    assert.equal(calls.record[0][0], Number(valid));
  }
});

test('impossible, malformed and future dates or times cannot be saved', async () => {
  for (const [date, time] of [
    ['2026-02-30', '07:00'],
    ['2026-13-01', '07:00'],
    ['invalid', '07:00'],
    ['2026-09-16', '24:00'],
    ['2026-09-16', '12:60'],
    ['2026-09-16', 'invalid'],
    ['2026-09-18', '07:00'],
    ['2026-09-17', '08:26']
  ]) {
    const { page, calls } = createPage();
    page.refreshCheckinDefaults();
    change(page, 'Date', date);
    change(page, 'Time', time);
    await page.submitCheckin();
    assert.equal(calls.record.length, 0, `${date} ${time}`);
    assert.equal(calls.content.length, 0, `${date} ${time}`);
    assert.equal(page.data.checkinSubmitting, false);
    assert.ok(calls.toast.length > 0, `${date} ${time}`);
  }
});

test('rejected text preserves the draft and never writes a check-in', async () => {
  const { page, calls } = createPage({ checkText: () => false });
  page.refreshCheckinDefaults();
  page.onCheckinExperienceInput({ detail: { value: '待修改的体验' } });
  await page.submitCheckin();
  assert.deepEqual(calls.content, [['待修改的体验', 2]]);
  assert.equal(calls.record.length, 0);
  assert.equal(calls.refresh, 0);
  assert.equal(page.data.checkinExperience, '待修改的体验');
  assert.equal(page.data.checkinSubmitting, false);
});

test('pending text approval locks submission and prevents duplicate check-ins', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { page, calls } = createPage({ checkText: () => pending });
  page.refreshCheckinDefaults();
  page.onCheckinExperienceInput({ detail: { value: '一次练习，一条记录' } });
  const first = page.submitCheckin();
  assert.equal(page.data.checkinSubmitting, true);
  await page.submitCheckin();
  assert.equal(calls.content.length, 1);
  assert.equal(calls.record.length, 0);
  resolve(true);
  await first;
  assert.equal(calls.record.length, 1);
  assert.equal(page.data.checkinSubmitting, false);
});

test('storage and moderation errors preserve inputs, report failure and release the lock', async () => {
  for (const settings of [
    { record: () => { throw new Error('存储空间不足'); } },
    { record: () => ({ success: false }) },
    { checkText: () => { throw new Error('审核服务不可用'); } }
  ]) {
    const { page, calls } = createPage(settings);
    page.refreshCheckinDefaults();
    change(page, 'Date', '2026-09-15');
    change(page, 'Time', '06:32');
    page.onCheckinDurationInput({ detail: { value: '35' } });
    page.onCheckinExperienceInput({ detail: { value: '保存失败后保留体验' } });
    await page.submitCheckin();
    assert.equal(page.data.checkinExperience, '保存失败后保留体验');
    assert.equal(page.data.checkinDuration, '35');
    assert.equal(page.data.checkinDate, '2026-09-15');
    assert.equal(page.data.checkinTime, '06:32');
    assert.equal(page.data.checkinSubmitting, false);
    assert.equal(calls.refresh, 0);
    assert.ok(calls.toast.length > 0);
    if (settings.checkText) assert.equal(calls.record.length, 0);
  }
});

test('rapid taps with an empty experience save once and allow a later check-in', async () => {
  const { page, calls, setNow } = createPage();
  await page.submitCheckin();
  await page.submitCheckin();
  assert.equal(calls.record.length, 1);
  setNow('2026-09-17T08:25:39.123+08:00');
  await page.submitCheckin();
  assert.equal(calls.record.length, 2);
});

test('details show every record from the latest three 04:00 days, grouped newest first', () => {
  const dailyRecords = makeRecords(45);
  dailyRecords['2026-09-16'] = { count: 2, records: [
    { timestamp: Date.parse('2026-09-16T12:00:00+08:00'), duration: 7 },
    { timestamp: Date.parse('2026-09-16T03:59:00+08:00'), duration: 8 }
  ] };
  dailyRecords['2026-09-15'] = { count: 2, records: [
    { timestamp: Date.parse('2026-09-15T04:00:00+08:00'), duration: 9 },
    { timestamp: Date.parse('2026-09-15T03:59:59+08:00'), duration: 10 }
  ] };
  dailyRecords['2026-09-14'] = { count: 1, records: [
    { timestamp: Date.parse('2026-09-14T20:00:00+08:00'), duration: 11 }
  ] };
  const { page, calls } = createPage({ dailyRecords });
  page.refreshCheckinRecords();

  assert.equal(page.data.checkinTotal, 50);
  assert.equal(page.data.hiddenCheckinCount, 2);
  assert.equal(page.data.checkinRecords.length, 48, 'recent days have no twenty-record limit');
  assert.deepEqual(Array.from(page.data.checkinGroups, group => [group.date, group.count, group.totalDuration]), [
    ['2026-09-17', 45, 1035], ['2026-09-16', 1, 7], ['2026-09-15', 2, 17]
  ]);
  assert.deepEqual(Array.from(page.data.checkinGroups[0].records, record => record.duration),
    Array.from({ length: 45 }, (_, index) => 45 - index));
  const earlyMorning = page.data.checkinGroups[2].records[0];
  assert.equal(earlyMorning.date, '2026-09-16', 'retain the original storage bucket');
  assert.equal(earlyMorning.dayDate, '2026-09-15');
  assert.equal(earlyMorning.time, '03:59');
  assert.match(earlyMorning.timeLabel, /次日.*03:59/);

  page.onReachBottom();
  assert.equal(page.data.checkinRecords.length, 48, 'scrolling never expands older records');
  const beforeNavigation = JSON.stringify(page.data);
  page.openAllCheckins();
  assert.deepEqual(calls.navigation.map(value => ({ ...value })), [
    { url: '/pages/checkinHistory/checkinHistory' }
  ]);
  assert.equal(JSON.stringify(page.data), beforeNavigation, 'opening history never expands the homepage');
  assert.deepEqual(Array.from(page.data.checkinGroups, group => group.date),
    ['2026-09-17', '2026-09-16', '2026-09-15']);
  assert.equal(new Set(page.data.checkinRecords.map(record => record.id)).size, 48);
});

test('empty and older-only data do not pull old dates into the latest three days', () => {
  const empty = createPage().page;
  empty.refreshCheckinRecords();
  assert.equal(empty.data.checkinTotal, 0);
  assert.equal(empty.data.checkinRecords.length, 0);
  assert.equal(empty.data.checkinGroups.length, 0);
  assert.equal(empty.data.hiddenCheckinCount, 0);

  const { page: older, calls } = createPage({ dailyRecords: makeRecords(1, '2026-09-14T12:00:00+08:00') });
  older.refreshCheckinRecords();
  assert.equal(older.data.checkinTotal, 1);
  assert.equal(older.data.checkinRecords.length, 0);
  assert.equal(older.data.checkinGroups.length, 0);
  assert.equal(older.data.hiddenCheckinCount, 1);
  older.openAllCheckins();
  assert.equal(calls.navigation[0].url, '/pages/checkinHistory/checkinHistory');
  assert.equal(older.data.checkinRecords.length, 0);
  assert.equal(older.data.checkinGroups.length, 0);
  assert.equal(older.data.hiddenCheckinCount, 1);
});

test('pulling down refreshes records and defaults while keeping only the latest three days', async () => {
  const dailyRecords = { ...makeRecords(45), ...makeRecords(2, '2026-09-14T12:00:00+08:00') };
  const { page, calls, setNow } = createPage({ dailyRecords });
  page.generateCalendar = () => {};
  page.refreshCheckinRecords();
  page.openAllCheckins();
  Object.assign(dailyRecords, makeRecords(65));
  setNow('2026-09-18T09:42:00+08:00');
  await page.onPullDownRefresh();
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.checkinTotal, 67);
  assert.equal(page.data.hiddenCheckinCount, 2);
  assert.equal(page.data.checkinRecords[0].duration, 65);
  assert.deepEqual(Array.from(page.data.checkinGroups, group => group.date), ['2026-09-17']);
  assert.equal(page.data.checkinDate, '2026-09-18');
  assert.equal(page.data.checkinTime, '09:42');
  assert.equal(calls.stopPullDownRefresh, 1);
  await page.onPullDownRefresh();
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.hiddenCheckinCount, 2);
  assert.equal(calls.stopPullDownRefresh, 2);
  assert.equal(calls.cloudRefresh, 2);
});

test('pull-to-refresh releases the spinner when reading page data fails', async () => {
  const { page, calls } = createPage();
  page.refreshCalendarData = () => { throw new Error('读取失败'); };
  await assert.rejects(page.onPullDownRefresh(), /读取失败/);
  assert.equal(calls.stopPullDownRefresh, 1);
});

test('showing the page keeps defaults current and hides/unloads release the clock', async () => {
  const { page, intervals, setNow } = createPage();
  for (const method of ['checkUserInfoStatus', 'generateCalendar']) {
    page[method] = () => {};
  }
  await page.onShow();
  assert.equal(intervals.size, 1);
  assert.equal(Array.from(intervals.values())[0].milliseconds, 30000);
  await page.onShow();
  assert.equal(intervals.size, 1, 'reopening must not accumulate clocks');
  setNow('2026-09-18T09:42:00+08:00');
  Array.from(intervals.values())[0].callback();
  assert.equal(page.data.checkinDate, '2026-09-18');
  assert.equal(page.data.checkinTime, '09:42');
  change(page, 'Date', '2026-09-15');
  change(page, 'Time', '06:32');
  setNow('2026-09-18T09:43:00+08:00');
  Array.from(intervals.values())[0].callback();
  assert.equal(page.data.checkinDate, '2026-09-15');
  assert.equal(page.data.checkinTime, '06:32');
  page.onHide();
  assert.equal(intervals.size, 0);
  await page.onShow();
  assert.equal(intervals.size, 1);
  page.onUnload();
  assert.equal(intervals.size, 0);
});

test('showing the page restores a missing cloud check-in despite existing local records', async () => {
  const dailyRecords = {
    '2026-09-17': {
      count: 1,
      records: [{ timestamp: Date.parse('2026-09-17T03:39:00+08:00'), duration: 13 }]
    }
  };
  const { page, calls } = createPage({
    dailyRecords,
    refreshFromCloud: () => {
      dailyRecords['2026-09-16'] = {
        count: 1,
        records: [{ timestamp: Date.parse('2026-09-16T20:39:00+08:00'), duration: 7 }]
      };
      return true;
    }
  });
  page.setData({ currentYear: 2026, currentMonth: 9, userOpenId: 'local-user' });
  page.checkUserInfoStatus = () => {};
  page.loadRanking = () => assert.fail('the homepage must not load rankings');
  page.refreshCalendarData();
  assert.equal(page.data.checkinTotal, 1);
  assert.equal(page.data.calendarDays.flat().find(day => day.fullDate === '2026-09-16').isChecked, true);
  assert.equal(page.data.calendarDays.flat().find(day => day.fullDate === '2026-09-17').isChecked, false);

  await page.onShow();

  assert.equal(calls.cloudRefresh, 1);
  assert.equal(page.data.checkinTotal, 2);
  assert.equal(page.data.calendarDays.flat().find(day => day.fullDate === '2026-09-16').isChecked, true);
  assert.deepEqual(Array.from(page.data.checkinRecords, record => [record.date, record.time, record.duration]), [
    ['2026-09-17', '03:39', 13],
    ['2026-09-16', '20:39', 7]
  ]);
  page.onUnload();
});

test('returning from history and cloud refresh keep the homepage limited to the latest three days', async () => {
  const dailyRecords = { ...makeRecords(45), ...makeRecords(2, '2026-09-14T12:00:00+08:00') };
  const { page, calls } = createPage({
    dailyRecords,
    refreshFromCloud: () => {
      Object.assign(dailyRecords, makeRecords(65));
      return true;
    }
  });
  page.checkUserInfoStatus = () => {};
  page.generateCalendar = () => {};
  page.loadRanking = () => assert.fail('the homepage must not load rankings');
  page.refreshCheckinRecords();
  page.openAllCheckins();
  page.onHide();

  await page.onShow();
  assert.equal(page.data.checkinTotal, 67);
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.hiddenCheckinCount, 2);
  assert.equal(page.data.checkinRecords[0].duration, 65);
  assert.deepEqual(Array.from(page.data.checkinGroups, group => group.date), ['2026-09-17']);

  page.refreshCheckinRecords();
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.hiddenCheckinCount, 2);
  await page.onPullDownRefresh();
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.hiddenCheckinCount, 2);
  assert.equal(calls.stopPullDownRefresh, 1);
  assert.equal(calls.navigation.length, 1);
  page.onUnload();
});

test('the running clock rolls the recent-day window at 04:00', async () => {
  const dailyRecords = {
    ...makeRecords(1, '2026-09-15T04:00:00+08:00'),
    ...makeRecords(1, '2026-09-16T04:00:00+08:00'),
    ...makeRecords(1, '2026-09-17T04:00:00+08:00'),
    ...makeRecords(1, '2026-09-18T03:59:00+08:00')
  };
  const { page, intervals, setNow } = createPage({ now: '2026-09-18T03:59:30+08:00', dailyRecords });
  page.checkUserInfoStatus = () => {};
  page.generateCalendar = () => {};
  await page.onShow();
  assert.equal(page.data.checkinRecords.length, 4);
  assert.deepEqual(Array.from(page.data.checkinGroups, group => group.date),
    ['2026-09-17', '2026-09-16', '2026-09-15']);

  setNow('2026-09-18T04:00:00+08:00');
  Array.from(intervals.values())[0].callback();
  assert.equal(page.data.checkinRecords.length, 3);
  assert.equal(page.data.hiddenCheckinCount, 1);
  assert.deepEqual(Array.from(page.data.checkinGroups, group => group.date),
    ['2026-09-17', '2026-09-16']);
  assert.equal(page.data.checkinTime, '04:00');
  page.onUnload();
});

test('concurrent page shows and pull-down share one cloud request and allow another after completion', async () => {
  let completeRefresh;
  const pendingRefresh = new Promise(resolve => { completeRefresh = resolve; });
  const { page, calls } = createPage({
    dailyRecords: makeRecords(45),
    refreshFromCloud: () => pendingRefresh
  });
  for (const method of ['checkUserInfoStatus', 'generateCalendar']) {
    page[method] = () => {};
  }

  const firstShow = page.onShow();
  const secondShow = page.onShow();
  const pullDown = page.onPullDownRefresh();
  assert.equal(firstShow, secondShow);
  await Promise.resolve();
  assert.equal(calls.cloudRefresh, 1);
  assert.equal(calls.stopPullDownRefresh, 0);
  completeRefresh(true);
  await Promise.all([firstShow, secondShow, pullDown]);
  assert.equal(calls.stopPullDownRefresh, 1);
  assert.equal(page.data.checkinRecords.length, 45);

  await page.onShow();
  assert.equal(calls.cloudRefresh, 2);
  assert.equal(page.data.checkinRecords.length, 45);
  page.onUnload();
});

test('failed cloud refresh retains local records, releases the spinner and permits retry', async () => {
  for (const failure of [false, new Error('网络不可用')]) {
    let completeRefresh;
    let failRefresh;
    const pendingRefresh = new Promise((resolve, reject) => {
      completeRefresh = resolve;
      failRefresh = reject;
    });
    const { page, calls } = createPage({
      dailyRecords: makeRecords(1),
      refreshFromCloud: () => pendingRefresh
    });
    page.setData({ currentYear: 2026, currentMonth: 9 });
    page.refreshCalendarData();
    const before = JSON.stringify({ records: page.data.checkinRecords, groups: page.data.checkinGroups, hiddenCount: page.data.hiddenCheckinCount });
    const pullDown = page.onPullDownRefresh();
    await Promise.resolve();
    assert.equal(calls.cloudRefresh, 1);
    assert.equal(calls.stopPullDownRefresh, 0);
    if (failure instanceof Error) failRefresh(failure);
    else completeRefresh(failure);

    await pullDown;
    assert.equal(JSON.stringify({ records: page.data.checkinRecords, groups: page.data.checkinGroups, hiddenCount: page.data.hiddenCheckinCount }), before);
    assert.equal(calls.stopPullDownRefresh, 1);
    await page.onPullDownRefresh();
    assert.equal(calls.cloudRefresh, 2);
    assert.equal(calls.stopPullDownRefresh, 2);
  }
});

test('details resolve inline experiences and IDs from both local storage formats', () => {
  const dailyRecords = {
    '2026-09-16': {
      count: 3,
      records: [
        { timestamp: Date.parse('2026-09-16T06:00:00+08:00'), duration: 7, experience: [{ text: '直接存储的体验' }] },
        { timestamp: Date.parse('2026-09-16T07:00:00+08:00'), duration: 8, experience: ['unified-id', 'legacy-id'] },
        { timestamp: Date.parse('2026-09-16T08:00:00+08:00'), duration: 9, experience: 'legacy-id' }
      ]
    }
  };
  const { page } = createPage({
    dailyRecords,
    experiences: [{ _id: 'unified-id', text: '统一缓存体验' }],
    legacyExperiences: [{ uniqueId: 'legacy-id', text: '旧缓存体验' }]
  });
  page.refreshCheckinRecords();
  assert.deepEqual(Array.from(page.data.checkinRecords[0].experienceTexts), ['旧缓存体验']);
  assert.deepEqual(Array.from(page.data.checkinRecords[1].experienceTexts), ['统一缓存体验', '旧缓存体验']);
  assert.deepEqual(Array.from(page.data.checkinRecords[2].experienceTexts), ['直接存储的体验']);
});
