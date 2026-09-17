const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/index/index.js');
const utilsPath = path.join(__dirname, '../miniprogram/utils');

function createPage({ now = '2026-09-17T08:25:37.123+08:00', dailyRecords = {}, experiences = [], legacyExperiences = [], record, checkText } = {}) {
  let currentTime = Date.parse(now);
  let definition;
  const calls = { record: [], content: [], toast: [], refresh: 0, stopPullDownRefresh: 0 };
  const intervals = new Map();
  let nextInterval = 1;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const checkinManager = {
    getUserCheckinData: () => ({ dailyRecords }),
    getExperienceRecordsFromLocal: ids => experiences.filter(value => ids.includes(value._id || value.uniqueId)),
    recordCheckin: (...args) => {
      calls.record.push(args);
      return record ? record(...args) : { success: true };
    }
  };
  const wx = {
    getStorageSync: key => key === 'meditationTextRecords' ? legacyExperiences : undefined,
    showToast: value => calls.toast.push(value),
    showLoading() {},
    hideLoading() {},
    stopPullDownRefresh: () => { calls.stopPullDownRefresh++; }
  };
  const modules = {
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

function makeRecords(count) {
  const dailyRecords = {};
  const start = Date.parse('2026-09-14T00:10:00+08:00');
  for (let index = 0; index < count; index++) {
    const timestamp = start + index * 60 * 60 * 1000;
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

test('details page in batches of twenty, newest first, without repeats at the end', () => {
  const { page } = createPage({ dailyRecords: makeRecords(45) });
  page.refreshCheckinRecords();
  assert.equal(page.data.checkinTotal, 45);
  assert.equal(page.data.checkinRecords.length, 20);
  assert.equal(page.data.hasMoreCheckins, true);
  assert.deepEqual(Array.from(page.data.checkinRecords, value => value.duration), Array.from({ length: 20 }, (_, index) => 45 - index));
  page.onReachBottom();
  assert.equal(page.data.checkinRecords.length, 40);
  assert.equal(page.data.hasMoreCheckins, true);
  page.onReachBottom();
  assert.equal(page.data.checkinRecords.length, 45);
  assert.equal(page.data.hasMoreCheckins, false);
  page.onReachBottom();
  assert.equal(page.data.checkinRecords.length, 45);
  assert.deepEqual(Array.from(page.data.checkinRecords, value => value.duration), Array.from({ length: 45 }, (_, index) => 45 - index));
  assert.equal(new Set(page.data.checkinRecords.map(value => value.timestamp)).size, 45);
  page.refreshCheckinRecords();
  assert.equal(page.data.checkinRecords.length, 20);
  assert.equal(page.data.hasMoreCheckins, true);
});

test('empty and exact-page data report whether more details exist correctly', () => {
  for (const count of [0, 1, 20, 40]) {
    const { page } = createPage({ dailyRecords: makeRecords(count) });
    page.refreshCheckinRecords();
    assert.equal(page.data.checkinRecords.length, Math.min(count, 20));
    assert.equal(page.data.checkinTotal, count);
    assert.equal(page.data.hasMoreCheckins, count > 20);
    page.loadMoreCheckins();
    assert.equal(page.data.checkinRecords.length, count);
    assert.equal(page.data.hasMoreCheckins, false);
  }
});

test('pulling down rereads storage and adds another twenty without resetting the visible count', () => {
  const dailyRecords = makeRecords(45);
  const { page, calls, setNow } = createPage({ dailyRecords });
  page.generateCalendar = () => {};
  page.updateMonthlyCount = () => {};
  page.refreshCheckinRecords();
  page.loadMoreCheckins();
  assert.equal(page.data.checkinRecords.length, 40);
  Object.assign(dailyRecords, makeRecords(65));
  setNow('2026-09-18T09:42:00+08:00');
  page.onPullDownRefresh();
  assert.equal(page.data.checkinRecords.length, 60);
  assert.equal(page.data.checkinTotal, 65);
  assert.equal(page.data.checkinRecords[0].duration, 65);
  assert.equal(page.data.hasMoreCheckins, true);
  assert.equal(page.data.checkinDate, '2026-09-18');
  assert.equal(page.data.checkinTime, '09:42');
  assert.equal(calls.stopPullDownRefresh, 1);
  page.onPullDownRefresh();
  assert.equal(page.data.checkinRecords.length, 65);
  assert.equal(page.data.hasMoreCheckins, false);
  assert.equal(calls.stopPullDownRefresh, 2);
});

test('pull-to-refresh releases the spinner when reading page data fails', () => {
  const { page, calls } = createPage();
  page.refreshCalendarData = () => { throw new Error('读取失败'); };
  assert.throws(() => page.onPullDownRefresh(), /读取失败/);
  assert.equal(calls.stopPullDownRefresh, 1);
});

test('showing the page keeps defaults current and hides/unloads release the clock', () => {
  const { page, intervals, setNow } = createPage();
  for (const method of ['checkUserInfoStatus', 'generateCalendar', 'updateMonthlyCount', 'loadRanking']) {
    page[method] = () => {};
  }
  page.onShow();
  assert.equal(intervals.size, 1);
  assert.equal(Array.from(intervals.values())[0].milliseconds, 30000);
  page.onShow();
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
  page.onShow();
  assert.equal(intervals.size, 1);
  page.onUnload();
  assert.equal(intervals.size, 0);
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
