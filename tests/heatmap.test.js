const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildHeatmap, buildYearlyHeatmaps } = require('../miniprogram/utils/heatmap');
const { getBusinessDate } = require('../miniprogram/utils/dateUtil');
const { getHeatmap } = require('../cloudfunctions/bijingSync/heatmap');

const pagePath = path.join(__dirname, '../miniprogram/pages/bijingHeatmap/bijingHeatmap.js');
const inYearDays = chart => chart.weeks.flatMap(week => week.days).filter(day => !day.empty);

test('an empty heatmap still renders all days of the current year', () => {
  const chart = buildHeatmap([], 2026, '2026-09-20');
  assert.equal(chart.year, 2026);
  assert.equal(chart.totalDays, 0);
  assert.equal(chart.totalDuration, 0);
  assert.equal(inYearDays(chart).length, 365);
  assert.equal(chart.weeks.every(week => week.days.length === 7), true);
  assert.equal(inYearDays(chart)[0].date, '2026-01-01');
  assert.equal(inYearDays(chart).at(-1).date, '2026-12-31');
  assert.equal(inYearDays(chart).find(day => day.date === '2026-09-21').future, true);
  assert.equal(inYearDays(chart).find(day => day.date === '2026-09-20').future, false);
});

test('heatmaps handle leap day and years that need 54 week columns without losing December 31', () => {
  for (const [year, count] of [[2024, 366], [2028, 366], [2012, 366], [2025, 365]]) {
    const chart = buildHeatmap([{ date: `${year}-12-31`, duration: 7 }], year, `${year}-12-31`);
    const days = inYearDays(chart);
    assert.equal(days.length, count, String(year));
    assert.equal(new Set(days.map(day => day.date)).size, count);
    assert.equal(days.at(-1).date, `${year}-12-31`);
    assert.equal(days.at(-1).duration, 7);
    assert.equal(days.some(day => day.date === `${year}-02-29`), count === 366);
  }
  assert.equal(buildHeatmap([{ date: '2012-12-31', duration: 7 }], 2012, '2012-12-31').weeks.length, 54);
});

test('heatmap aggregates duplicate dates, ignores malformed records, and totals only the selected year', () => {
  const chart = buildHeatmap([
    { date: '2024-02-29', duration: 15 }, { date: '2024-02-29', duration: '20' },
    { date: '2024-03-01', duration: 60 }, { date: '2026-09-20', duration: 7 },
    { date: '2024-02-30', duration: 100 }, { date: '2025-02-29', duration: 100 },
    { date: 'bad', duration: 100 }, { date: '2024-03-02', duration: 0 },
    { date: '2024-03-03', duration: -1 }, { date: '2024-03-04', duration: 'bad' }, null
  ], 2024, '2026-09-20');
  assert.equal(chart.totalDays, 2);
  assert.equal(chart.totalDuration, 95);
  const leapDay = inYearDays(chart).find(day => day.date === '2024-02-29');
  assert.equal(leapDay.duration, 35);
  assert.equal(leapDay.level, 2);
  assert.equal(inYearDays(chart).find(day => day.date === '2024-03-01').level, 3);
  assert.equal(inYearDays(chart).find(day => day.date === '2024-03-04').level, 0);
  assert.equal(chart.weeks.filter(week => week.monthLabel).length, 12);
});

test('a requested year without records retains its own complete calendar', () => {
  const chart = buildHeatmap([{ date: '2024-01-01', duration: 7 }], 2025, '2026-09-20');
  assert.equal(chart.year, 2025);
  assert.equal(chart.totalDays, 0);
  assert.equal(inYearDays(chart).length, 365);
  assert.equal(inYearDays(chart)[0].date, '2025-01-01');
  assert.equal(inYearDays(chart).at(-1).date, '2025-12-31');
});

test('yearly heatmaps render the current business year first and earlier years below, including empty years', () => {
  const charts = buildYearlyHeatmaps([
    { date: '2024-12-31', duration: 90 }, { date: '2025-01-01', duration: 20 },
    { date: '2028-02-29', duration: 60 }, { date: '2029-01-01', duration: 90 }
  ], '2028-09-20');
  assert.deepEqual(charts.map(chart => chart.year), [2028, 2027, 2026, 2025]);
  assert.deepEqual(charts.map(chart => chart.totalDays), [1, 0, 0, 1]);
  assert.deepEqual(charts.map(chart => chart.totalDuration), [60, 0, 0, 20]);
  for (const chart of charts) {
    const days = inYearDays(chart);
    assert.equal(days.length, chart.year === 2028 ? 366 : 365);
    assert.equal(new Set(days.map(day => day.date)).size, days.length);
    assert.equal(days[0].date, `${chart.year}-01-01`);
    assert.equal(days.at(-1).date, `${chart.year}-12-31`);
    assert.equal(chart.weeks.every(week => week.days.length === 7), true);
    assert.equal(chart.weeks.filter(week => week.monthLabel).length, 12);
    if (chart.year < 2028) assert.equal(days.some(day => day.future), false);
  }
  const currentDays = inYearDays(charts[0]);
  assert.equal(currentDays.find(day => day.date === '2028-09-20').future, false);
  assert.equal(currentDays.find(day => day.date === '2028-09-21').future, true);
});

test('the yearly range advances at Beijing 02:00 on New Year\'s Day', () => {
  const before = getBusinessDate('2026-01-01T01:59:59+08:00');
  const after = getBusinessDate('2026-01-01T02:00:00+08:00');
  assert.deepEqual(buildYearlyHeatmaps([], before).map(chart => chart.year), [2025]);
  assert.deepEqual(buildYearlyHeatmaps([], after).map(chart => chart.year), [2026, 2025]);
});

function cloudHarness({ openid = 'user-a', user = { bijingBound: true, bijingStudentNumber: 'BJ-bound' }, payload, getError, userError, tokenError } = {}) {
  const calls = { users: [], gets: [], tokens: 0 };
  return {
    calls,
    run: () => getHeatmap({
      openid,
      getUserDoc: async id => { calls.users.push(id); if (userError) throw userError; return user; },
      getApiBase: () => 'https://example.test/',
      getAccessToken: () => { calls.tokens++; if (tokenError) throw tokenError; return 'test-token'; },
      axios: { get: async (...args) => {
        calls.gets.push(args);
        if (getError) throw getError;
        return { data: payload === undefined ? { success: true, data: { records: [], nickname: '静心者' } } : payload };
      } }
    })
  };
}

test('heatmap cloud requests authenticate with OpenAPI using only the current user binding and sanitize the response', async () => {
  const { calls, run } = cloudHarness({ payload: { success: true, data: {
    studentNumber: 'BJ-other', nickname: '云中人',
    records: [{ date: '2024-02-29', duration: '25', privateField: 'omit' },
      { date: '2026-02-30', duration: 15 }, { date: '2026-09-20', duration: -1 },
      { date: '2026-09-21', duration: 'NaN' }, null]
  } } });
  const result = await run();
  assert.deepEqual(calls.users, ['user-a']);
  assert.equal(calls.tokens, 1);
  assert.deepEqual(calls.gets, [['https://example.test/api/openapi/meditation/heatmap', {
    params: { studentNumber: 'BJ-bound' }, headers: { 'X-Access-Token': 'test-token' }, timeout: 10000
  }]]);
  assert.deepEqual(result, { success: true, data: {
    studentNumber: 'BJ-bound', nickname: '云中人', records: [{ date: '2024-02-29', duration: 25 }]
  } });
});

test('heatmap cloud requests reject missing login or bindings before requesting external data', async () => {
  for (const settings of [{ openid: '' }, { user: null }, { user: {} }, { user: { bijingBound: false, bijingStudentNumber: 'BJ-a' } }]) {
    const { calls, run } = cloudHarness(settings);
    const result = await run();
    assert.equal(result.success, false);
    assert.match(result.error, /登录|绑定/);
    assert.equal(calls.gets.length, 0);
    assert.equal(calls.tokens, 0);
    if (settings.openid === '') assert.equal(calls.users.length, 0);
  }
});

test('heatmap stops before requesting data when the OpenAPI token is not configured', async () => {
  const { calls, run } = cloudHarness({ tokenError: new Error('missing private token configuration') });
  const result = await run();
  assert.deepEqual(result, { success: false, error: '热力图加载失败，请稍后重试' });
  assert.equal(calls.gets.length, 0);
});

test('heatmap OpenAPI authorization failures do not fall back to the public endpoint or expose credentials', async () => {
  for (const status of [401, 403]) {
    const getError = Object.assign(new Error('secret upstream token'), {
      response: { status, data: { message: 'secret upstream detail' } }
    });
    const { calls, run } = cloudHarness({ getError });
    assert.deepEqual(await run(), { success: false, error: '热力图加载失败，请稍后重试' });
    assert.equal(calls.gets.length, 1);
    assert.equal(calls.gets[0][0], 'https://example.test/api/openapi/meditation/heatmap');
  }
});

test('heatmap cloud errors are actionable and do not leak upstream errors', async () => {
  for (const settings of [
    { payload: null }, { payload: { success: true, data: {} } },
    { payload: { success: false, message: '记录查询暂不可用' } },
    { getError: new Error('secret upstream detail') }, { userError: new Error('secret database detail') }
  ]) {
    const result = await cloudHarness(settings).run();
    assert.equal(result.success, false);
    assert.match(result.error, /热力图|记录查询/);
    assert.doesNotMatch(result.error, /secret/);
  }
});

function createPage(fetch) {
  let definition;
  const calls = { requests: [], stopPullDownRefresh: 0, updates: [] };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page: value => { definition = value; },
    wx: { stopPullDownRefresh: () => { calls.stopPullDownRefresh++; } },
    require(request) {
      if (request === '../../utils/dateUtil.js') return { watchBusinessDate: () => () => {} };
      if (request === '../../utils/heatmap') return {
        buildYearlyHeatmaps: records => buildYearlyHeatmaps(records, '2026-09-20')
      };
      assert.equal(request, '../../utils/bijingApi');
      return { getBijingHeatmap: (...args) => { calls.requests.push(args); return fetch(); } };
    }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) {
    for (const [key, entry] of Object.entries(value)) {
      const match = key.match(/^heatmaps\[(\d+)\]\.selectedDay$/);
      if (match) this.data.heatmaps[Number(match[1])].selectedDay = entry;
      else this.data[key] = entry;
    }
    calls.updates.push(value);
  } };
  return { page, calls };
}

const successResponse = records => ({ success: true, data: { records, studentNumber: 'BJ-bound', nickname: '修习者' } });

test('heatmap page loads its own binding and all annual charts with independent day selections', async () => {
  const { page, calls } = createPage(() => successResponse([
    { date: '2024-02-29', duration: 90 }, { date: '2025-02-28', duration: 20 },
    { date: '2026-09-19', duration: 7 }
  ]));
  await page.onLoad({ studentNumber: 'BJ-other' });
  assert.deepEqual(calls.requests, [[]]);
  assert.equal(page.data.studentNumber, 'BJ-bound');
  assert.equal(page.data.loading, false);
  assert.deepEqual(Array.from(page.data.heatmaps, chart => chart.year), [2026, 2025]);
  const [current, previous] = page.data.heatmaps;
  assert.equal(previous.totalDuration, 20);
  assert.equal(current.totalDuration, 7);
  assert.equal(inYearDays(previous).length, 365);
  assert.equal(inYearDays(current).length, 365);
  assert.equal(calls.requests.length, 1);
  page.selectDay({ currentTarget: { dataset: { year: 2025, date: '2025-02-28', duration: 20, empty: false } } });
  assert.equal(previous.selectedDay, '2025-02-28 · 20 分钟');
  assert.equal(current.selectedDay, '');
  page.selectDay({ currentTarget: { dataset: { year: '2026', date: '2026-09-19', duration: 7, empty: false } } });
  assert.equal(current.selectedDay, '2026-09-19 · 7 分钟');
  assert.equal(previous.selectedDay, '2025-02-28 · 20 分钟');
  page.selectDay({ currentTarget: { dataset: { year: 2025, date: '2024-12-31', duration: 0, empty: true } } });
  assert.equal(previous.selectedDay, '2025-02-28 · 20 分钟');
  page.selectDay({ currentTarget: { dataset: { year: 2024, date: '2024-02-29', duration: 90, empty: false } } });
  assert.equal(previous.selectedDay, '2025-02-28 · 20 分钟');
  assert.equal(current.selectedDay, '2026-09-19 · 7 分钟');
  assert.equal(calls.requests.length, 1);
});

test('empty heatmap response renders a complete empty calendar for every year since 2025', async () => {
  const { page } = createPage(() => successResponse([]));
  await page.onLoad();
  assert.equal(page.data.errorMessage, '');
  assert.deepEqual(Array.from(page.data.heatmaps, chart => chart.year), [2026, 2025]);
  for (const chart of page.data.heatmaps) {
    assert.equal(chart.totalDays, 0);
    assert.equal(chart.totalDuration, 0);
    assert.equal(inYearDays(chart).length, 365);
    assert.equal(inYearDays(chart)[0].date, `${chart.year}-01-01`);
    assert.equal(inYearDays(chart).at(-1).date, `${chart.year}-12-31`);
    assert.equal(chart.selectedDay, '');
  }
});

test('heatmap failures release loading and pull-refresh states and allow retry', async () => {
  for (const failure of [() => ({ success: false, error: '网络不可用' }), () => { throw new Error('读取失败'); }, () => ({ success: true, data: {} })]) {
    let attempts = 0;
    const { page, calls } = createPage(() => ++attempts === 1 ? failure() : successResponse([]));
    await page.onPullDownRefresh();
    assert.ok(page.data.errorMessage);
    assert.equal(page.data.loading, false);
    assert.equal(calls.stopPullDownRefresh, 1);
    await page.retry();
    assert.equal(page.data.errorMessage, '');
    assert.equal(page.data.loading, false);
    assert.equal(calls.requests.length, 2);
  }
});

test('heatmap avoids duplicate in-flight requests and ignores replies after page unload', async () => {
  let resolve;
  const { page, calls } = createPage(() => new Promise(done => { resolve = done; }));
  const first = page.onLoad();
  await page.retry();
  assert.equal(calls.requests.length, 1);
  page.onUnload();
  const before = calls.updates.length;
  resolve(successResponse([{ date: '2026-09-19', duration: 7 }]));
  await first;
  assert.equal(calls.updates.length, before);
});
