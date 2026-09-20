const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/historyDetails/historyDetails.js');
const plain = value => JSON.parse(JSON.stringify(value));
const row = (openid = 'a', date = '2026-09-18', minutes = 0, status = minutes ? 'below_goal' : 'not_practiced') => ({
  openid, date, minutes, status, nickname: `成员 ${openid}`, avatarUrl: 'cloud://avatar', isCreator: openid === 'a'
});
const details = (items = [row()], overrides = {}) => ({
  teamId: 'team-a', businessDate: '2026-09-19', filter: 'unmet',
  settings: { practiceStartDate: '2026-09-01', dailyGoalMinutes: 20, dayBoundaryHour: 2 },
  history: { month: '2026-09', minMonth: '2026-09', maxMonth: '2026-09', startDate: '2026-09-01', endDate: '2026-09-18', totalDays: 18 },
  items, nextCursor: null, ...overrides
});
function monthlyDetails(month, items = [], { practiceStartDate = '2026-07-01', businessDate = '2026-09-19', ...overrides } = {}) {
  const monthStart = `${month}-01`;
  const nextMonth = new Date(`${monthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${businessDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const startDate = practiceStartDate > monthStart ? practiceStartDate : monthStart;
  const endDate = yesterday < monthEnd ? yesterday : monthEnd;
  const totalDays = Math.max(0, (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 + 1);
  return details(items, {
    businessDate,
    settings: { practiceStartDate, dailyGoalMinutes: 20, dayBoundaryHour: 2 },
    history: { month, minMonth: practiceStartDate.slice(0, 7), maxMonth: businessDate.slice(0, 7), startDate, endDate, totalDays },
    ...overrides
  });
}
const success = value => ({ result: { success: true, data: structuredClone(value) } });
const event = values => ({ currentTarget: { dataset: values } });
const monthEvent = value => ({ detail: { value } });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createPage({ query = { teamId: 'team-a' }, cloud, account = 'viewer', now = '2026-09-19T12:00:00+08:00' } = {}) {
  let definition;
  let currentAccount = account;
  const calls = { cloud: [], navigation: [], refreshStopped: 0, updates: 0 };
  let timestamp = new Date(now).getTime();
  let timerId = 0;
  const timers = new Map();
  const setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  }
  const dateModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dateUtil.js'), 'utf8'), {
    module: dateModule, Date: ClockDate, setTimeout, clearTimeout
  });
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Date: ClockDate,
    require: name => dateModule.exports,
    Page(value) { definition = value; },
    wx: {
      getStorageSync: key => key === 'userOpenId' ? currentAccount : undefined,
      cloud: { callFunction(request) {
        calls.cloud.push(plain(request));
        return cloud ? cloud(request.data.data, calls.cloud.length) : Promise.resolve(success(details()));
      } },
      navigateTo(options) { calls.navigation.push(options); },
      stopPullDownRefresh() { calls.refreshStopped++; }
    }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); calls.updates++; } };
  page.onLoad(query);
  return { page, calls, timers, setNow(value) { timestamp = Date.parse(value); }, setAccount(value) { currentAccount = value; } };
}
const rendered = page => plain(page.data.groups.flatMap(group => group.items));

test('loads team history and formats actual minutes without rounding into the goal', async () => {
  const { page, calls } = createPage({ cloud: () => success(details([row('a'), row('b', '2026-09-18', 19.999), row('c', '2026-09-17', 12)])) });
  await page.onShow();
  assert.deepEqual(calls.cloud[0], { name: 'teamManager', data: { type: 'getTeamHistoryDetails', data: { teamId: 'team-a', filter: 'unmet', month: '2026-09', limit: 50 } } });
  assert.equal(page.data.hasLoaded, true);
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.rangeLabel, '2026.09.01 — 2026.09.18');
  assert.equal(page.data.groups.length, 2);
  assert.deepEqual(rendered(page).map(item => [item.minutesLabel, item.remainingLabel, item.statusLabel]),
    [['0', '', '未练习'], ['19.99', '少于0.01', '时长不足'], ['12', '8', '时长不足']]);
});

test('pagination merges a date across pages without duplicate members and keeps stable order', async () => {
  const cursor = { date: '2026-09-18', memberOpenid: 'b' };
  const { page, calls } = createPage({ cloud: (_, count) => success(count === 1
    ? details([row('b'), row('a')], { nextCursor: cursor })
    : details([row('b'), row('c'), row('a', '2026-09-17')])) });
  await page.onShow();
  await page.onReachBottom();
  assert.deepEqual(calls.cloud[1].data.data.cursor, cursor);
  assert.equal(calls.cloud[1].data.data.month, '2026-09');
  assert.equal(page.data.itemCount, 4);
  assert.deepEqual(plain(page.data.groups.map(group => [group.date, group.items.map(item => item.openid)])),
    [['2026-09-18', ['a', 'b', 'c']], ['2026-09-17', ['a']]]);
  assert.equal(page.data.nextCursor, null);
  await page.loadMore();
  assert.equal(calls.cloud.length, 2);
});

test('duplicate initial and pagination loads make only one request', async () => {
  const initial = deferred();
  const more = deferred();
  const { page, calls } = createPage({ cloud: (_, count) => count === 1 ? initial.promise : more.promise });
  const first = page.onShow();
  await page.onShow();
  await page.retryLoad();
  assert.equal(calls.cloud.length, 1);
  initial.resolve(success(details([row()], { nextCursor: { date: '2026-09-18', memberOpenid: 'a' } })));
  await first;
  const loadingMore = page.loadMore();
  await page.onReachBottom();
  assert.equal(calls.cloud.length, 2);
  more.resolve(success(details([row('b')])));
  await loadingMore;
});

test('changing filters discards an outstanding page from the previous filter', async () => {
  const more = deferred();
  const { page } = createPage({ cloud: (data, count) => count === 1
    ? success(details([row()], { nextCursor: { date: '2026-09-18', memberOpenid: 'a' } }))
    : data.cursor ? more.promise : success(details([row('c', '2026-09-17', 10)], { filter: 'below_goal' })) });
  await page.onShow();
  const oldRequest = page.loadMore();
  await page.changeFilter(event({ filter: 'below_goal' }));
  more.resolve(success(details([row('b')])));
  await oldRequest;
  assert.equal(page.data.filter, 'below_goal');
  assert.deepEqual(rendered(page).map(item => item.openid), ['c']);
  assert.equal(page.data.isLoadingMore, false);
});

test('rapid filter changes cannot be overwritten by an earlier first-page response', async () => {
  const old = deferred();
  const { page } = createPage({ cloud: data => data.filter === 'not_practiced' ? old.promise
    : success(details(data.filter === 'all' ? [row('q', '2026-09-18', 25, 'qualified')] : [row()], { filter: data.filter })) });
  await page.onShow();
  const earlier = page.changeFilter(event({ filter: 'not_practiced' }));
  await page.changeFilter(event({ filter: 'all' }));
  old.resolve(success(details([row('old')], { filter: 'not_practiced' })));
  await earlier;
  assert.equal(page.data.filter, 'all');
  assert.deepEqual(rendered(page).map(item => item.openid), ['q']);
});

test('first-page cloud and network errors release loading and can be retried', async () => {
  let attempt = 0;
  const { page, calls } = createPage({ cloud: () => {
    attempt++;
    if (attempt === 1) return Promise.reject(new Error('网络不可用'));
    if (attempt === 2) return { result: { success: false, error: '当前无权查看' } };
    return success(details());
  } });
  await page.onShow();
  assert.equal(page.data.loadError, '网络不可用');
  assert.equal(page.data.isLoading, false);
  await page.retryLoad();
  assert.equal(page.data.loadError, '当前无权查看');
  assert.equal(page.data.itemCount, 0);
  await page.onPullDownRefresh();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.itemCount, 1);
  assert.equal(calls.refreshStopped, 1);
});

test('load-more errors preserve earlier rows and cursor for a successful retry', async () => {
  const cursor = { date: '2026-09-18', memberOpenid: 'a' };
  const { page, calls } = createPage({ cloud: (_, count) => count === 1 ? success(details([row()], { nextCursor: cursor }))
    : count === 2 ? Promise.reject(new Error('加载更多失败')) : success(details([row('b')])) });
  await page.onShow();
  await page.loadMore();
  assert.equal(page.data.moreError, '加载更多失败');
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.itemCount, 1);
  assert.deepEqual(plain(page.data.nextCursor), cursor);
  assert.equal(page.data.isLoadingMore, false);
  await page.loadMore();
  assert.equal(page.data.moreError, '');
  assert.equal(page.data.itemCount, 2);
  assert.deepEqual(calls.cloud[2].data.data.cursor, cursor);
});

test('pull-to-refresh replaces an outstanding pagination request', async () => {
  const old = deferred();
  const { page, calls } = createPage({ cloud: (data, count) => data.cursor ? old.promise
    : success(details([row(count === 1 ? 'a' : 'refreshed')], { nextCursor: count === 1 ? { date: '2026-09-18', memberOpenid: 'a' } : null })) });
  await page.onShow();
  const earlier = page.loadMore();
  await page.onPullDownRefresh();
  old.resolve(success(details([row('stale')])));
  await earlier;
  assert.deepEqual(rendered(page).map(item => item.openid), ['refreshed']);
  assert.equal(calls.refreshStopped, 1);
});

test('account changes discard old responses and clear all previous member data', async () => {
  const old = deferred();
  const { page, setAccount, calls } = createPage({ cloud: (_, count) => count === 1
    ? success(details([row()], { nextCursor: { date: '2026-09-18', memberOpenid: 'a' } }))
    : count === 2 ? old.promise : success(details([row('new')])) });
  await page.onShow();
  const earlier = page.loadMore();
  setAccount('another-viewer');
  old.resolve(success(details([row('private')])));
  await earlier;
  assert.equal(page.data.itemCount, 0);
  assert.equal(page.data.settings, null);
  assert.equal(page.data.isLoadingMore, false);
  page.openDayRecords(event({ key: '2026-09-18:a' }));
  assert.equal(calls.navigation.length, 0);
  await page.onShow();
  assert.deepEqual(rendered(page).map(item => item.openid), ['new']);
});

test('new account onShow supersedes an in-flight first-page response', async () => {
  const old = deferred();
  const { page, setAccount } = createPage({ cloud: (_, count) => count === 1 ? old.promise : success(details([row('new')])) });
  const earlier = page.onShow();
  setAccount('another-viewer');
  await page.onShow();
  old.resolve(success(details([row('private')])));
  await earlier;
  assert.deepEqual(rendered(page).map(item => item.openid), ['new']);
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`${lifecycle} invalidates late responses without mutating the hidden page`, async () => {
    const old = deferred();
    const { page, calls } = createPage({ cloud: () => old.promise });
    const earlier = page.onShow();
    page[lifecycle]();
    const updates = calls.updates;
    old.resolve(success(details()));
    await earlier;
    assert.equal(calls.updates, updates);
    assert.equal(page.data.itemCount, 0);
  });
}

test('returning to a hidden page reloads server history', async () => {
  const { page, calls } = createPage({ cloud: (_, count) => success(details([row(String(count))])) });
  await page.onShow();
  page.onHide();
  await page.onShow();
  assert.deepEqual(rendered(page).map(item => item.openid), ['2']);
  assert.equal(calls.cloud.length, 2);
});

test('a rule or practice-day change during pagination reloads from page one', async () => {
  for (const change of ['goal', 'day', 'range']) {
    const changed = details([row('fresh')]);
    if (change === 'goal') changed.settings.dailyGoalMinutes = 30;
    if (change === 'day') {
      changed.businessDate = '2026-09-20';
      changed.history.endDate = '2026-09-19';
      changed.history.totalDays = 19;
    }
    if (change === 'range') {
      changed.settings.practiceStartDate = '2026-09-05';
      changed.history.startDate = '2026-09-05';
      changed.history.totalDays = 14;
    }
    const { page, calls } = createPage({ cloud: (_, count) => success(count === 1
      ? details([row('old')], { nextCursor: { date: '2026-09-18', memberOpenid: 'old' } }) : changed) });
    await page.onShow();
    await page.loadMore();
    assert.equal(calls.cloud.length, 3);
    assert.equal(calls.cloud[2].data.data.cursor, undefined);
    assert.deepEqual(rendered(page).map(item => item.openid), ['fresh']);
    assert.equal(page.data.isLoading, false);
  }
});

test('no-goal teams normalize unmet to not-practiced and support all daily statuses', async () => {
  const noGoal = { practiceStartDate: null, effectivePracticeStartDate: '2026-09-01', dailyGoalMinutes: null, dayBoundaryHour: 2 };
  const { page, calls } = createPage({ cloud: data => success(details(data.filter === 'all' ? [row('a', '2026-09-18', 1, 'practiced')] : [],
    { settings: noGoal, filter: data.filter === 'all' ? 'all' : 'not_practiced' })) });
  await page.onShow();
  assert.equal(page.data.hasGoal, false);
  assert.equal(page.data.filter, 'not_practiced');
  assert.equal(page.data.emptyTitle, '本月暂无未练习记录');
  await page.changeFilter(event({ filter: 'below_goal' }));
  assert.equal(calls.cloud.length, 1);
  await page.changeFilter(event({ filter: 'all' }));
  assert.equal(page.data.filter, 'all');
  assert.equal(rendered(page)[0].statusLabel, '已练习');
});

test('no historical days and each empty filter have explicit scoped empty states', async () => {
  const titles = { unmet: '本月暂无未达标记录', not_practiced: '本月暂无未练习记录', below_goal: '本月暂无时长不足记录', all: '本月暂无历史明细' };
  for (const filter of ['unmet', 'not_practiced', 'below_goal', 'all']) {
    const { page, calls } = createPage({ query: { teamId: 'team-a', filter, memberOpenid: 'member', memberName: encodeURIComponent('小林 & 朋友') },
      cloud: () => success(details([], { filter })) });
    await page.onShow();
    assert.equal(page.data.emptyTitle, titles[filter]);
    assert.match(page.data.emptyDescription, /小林 & 朋友/);
    assert.equal(calls.cloud[0].data.data.memberOpenid, 'member');
    assert.equal(page.data.itemCount, 0);
    assert.equal(page.data.hasLoaded, true);
  }
  const { page } = createPage({ query: { teamId: 'team-a', memberOpenid: 'member', memberName: '小林' }, cloud: () => success(details([], {
    settings: { practiceStartDate: '2026-09-19', dailyGoalMinutes: 20, dayBoundaryHour: 2 },
    history: { ...details().history, startDate: '2026-09-19', endDate: '2026-09-18', totalDays: 0 }
  })) });
  await page.onShow();
  assert.equal(page.data.emptyTitle, '本月暂无历史日期');
  assert.match(page.data.emptyDescription, /小林.*不包含今日/);
});

test('member identity comes from server rows and navigation only uses a returned valid row', async () => {
  const member = { ...row('id & /', '2026-09-17'), nickname: '真实昵称 & /' };
  const { page, calls, setAccount } = createPage({ query: { teamId: 'team-a', memberOpenid: encodeURIComponent(member.openid), memberName: '旧名字' },
    cloud: () => success(details([member])) });
  await page.onShow();
  assert.equal(page.data.memberName, member.nickname);
  page.openDayRecords(event({ key: 'fake-key', openid: 'intruder', date: '2026-09-19' }));
  assert.equal(calls.navigation.length, 0);
  page.openDayRecords(event({ key: rendered(page)[0].key, openid: 'intruder', date: '2026-09-19' }));
  const parsed = new URL(calls.navigation[0].url, 'https://example.test');
  assert.equal(parsed.pathname, '/pages/history/history');
  assert.equal(parsed.searchParams.get('teamId'), 'team-a');
  assert.equal(parsed.searchParams.get('memberOpenid'), member.openid);
  assert.equal(parsed.searchParams.get('memberName'), member.nickname);
  assert.equal(parsed.searchParams.get('date'), member.date);
  setAccount('another');
  page.openDayRecords(event({ key: rendered(page)[0].key }));
  assert.equal(calls.navigation.length, 1);
  assert.equal(page.data.itemCount, 0);
});

test('malformed or out-of-scope responses fail closed without navigable rows', async () => {
  const invalidReports = [
    details([row()], { teamId: 'different-team' }),
    details([row('a', '2026-09-19')]),
    details([row('a', '2026-02-30')]),
    details([row('a', '2026-09-18', -1)]),
    details([row('a', '2026-09-18', 21, 'below_goal')]),
    details([row()], { filter: 'all' }),
    details([row()], { nextCursor: { date: '2026-09-19', memberOpenid: 'a' } })
  ];
  for (const report of invalidReports) {
    const { page } = createPage({ cloud: () => success(report) });
    await page.onShow();
    assert.match(page.data.loadError, /暂不完整/);
    assert.equal(page.data.itemCount, 0);
  }
  const { page } = createPage({ query: { teamId: 'team-a', memberOpenid: 'a' }, cloud: () => success(details([row('b')])) });
  await page.onShow();
  assert.match(page.data.loadError, /暂不完整/);
});

test('floating-point goal tolerance accepts the same qualified status as the server', async () => {
  const { page } = createPage({ query: { teamId: 'team-a', filter: 'all' }, cloud: () => success(details([row('a', '2026-09-18', 19.999999999999996, 'qualified')], { filter: 'all' })) });
  await page.onShow();
  assert.equal(page.data.loadError, '');
  assert.equal(rendered(page)[0].statusLabel, '已达标');
});

test('missing team or signed-out viewer makes no history request', async () => {
  for (const options of [{ query: {} }, { account: '' }]) {
    const { page, calls } = createPage(options);
    await page.onShow();
    assert.equal(calls.cloud.length, 0);
    assert.ok(page.data.loadError);
  }
});

test('defaults to the current practice month and exposes the available month boundaries', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  assert.equal(page.data.currentMonth, '2026-09');
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(page.data.minMonth, '2026-09');
  assert.equal(page.data.maxMonth, '2026-09');
  assert.match(page.data.monthLabel, /2026.*9.*月/);
  assert.equal(page.data.canPreviousMonth, false);
  assert.equal(page.data.canNextMonth, false);
  await page.previousMonth();
  await page.nextMonth();
  await page.goToCurrentMonth();
  assert.equal(calls.cloud.length, 1);
});

test('a valid query month opens that month and invalid query months fall back to the current month', async () => {
  const { page, calls } = createPage({ query: { teamId: 'team-a', month: '2026-08' },
    cloud: () => success(monthlyDetails('2026-08', [row('a', '2026-08-31')])) });
  await page.onShow();
  assert.equal(calls.cloud[0].data.data.month, '2026-08');
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.rangeLabel, '2026.08.01 — 2026.08.31');
  for (const month of ['bad-month', '2026-13', '2026-00', '2026-9', '2026-09-01', '0000-09']) {
    const invalid = createPage({ query: { teamId: 'team-a', month } });
    await invalid.page.onShow();
    assert.equal(invalid.page.data.selectedMonth, '2026-09', month);
    assert.equal(invalid.calls.cloud[0].data.data.month, '2026-09', month);
  }
});

test('month navigation stops at both boundaries and returns directly to the current month', async () => {
  const { page, calls } = createPage({ cloud: data => success(monthlyDetails(data.month)) });
  await page.onShow();
  await page.previousMonth();
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.canPreviousMonth, true);
  assert.equal(page.data.canNextMonth, true);
  await page.previousMonth();
  assert.equal(page.data.selectedMonth, '2026-07');
  assert.equal(page.data.canPreviousMonth, false);
  const atBeginning = calls.cloud.length;
  await page.previousMonth();
  assert.equal(calls.cloud.length, atBeginning);
  await page.nextMonth();
  assert.equal(page.data.selectedMonth, '2026-08');
  await page.goToCurrentMonth();
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(page.data.canNextMonth, false);
  const atCurrent = calls.cloud.length;
  await page.nextMonth();
  await page.goToCurrentMonth();
  await page.changeMonth(monthEvent('2026-09'));
  assert.equal(calls.cloud.length, atCurrent);
  assert.deepEqual(calls.cloud.map(call => call.data.data.month), ['2026-09', '2026-08', '2026-07', '2026-08', '2026-09']);
});

test('previous and next month navigation cross a year boundary', async () => {
  const { page, calls } = createPage({ now: '2027-01-10T12:00:00+08:00',
    cloud: data => success(monthlyDetails(data.month, [], { practiceStartDate: '2026-11-15', businessDate: '2027-01-10' })) });
  await page.onShow();
  await page.previousMonth();
  assert.equal(page.data.selectedMonth, '2026-12');
  assert.equal(page.data.rangeLabel, '2026.12.01 — 2026.12.31');
  await page.nextMonth();
  assert.equal(page.data.selectedMonth, '2027-01');
  assert.deepEqual(calls.cloud.map(call => call.data.data.month), ['2027-01', '2026-12', '2027-01']);
});

test('switching month resets pagination immediately while preserving member and filter scope', async () => {
  const more = deferred();
  const august = deferred();
  const { page, calls } = createPage({ query: { teamId: 'team-a', memberOpenid: 'a', memberName: '成员 a', filter: 'below_goal' },
    cloud: data => data.cursor ? more.promise : data.month === '2026-08' ? august.promise
      : success(monthlyDetails('2026-09', [row('a', '2026-09-18', 10)], {
        filter: 'below_goal', nextCursor: { date: '2026-09-18', memberOpenid: 'a' }
      })) });
  await page.onShow();
  const oldPage = page.loadMore();
  const newMonth = page.changeMonth(monthEvent('2026-08'));
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.itemCount, 0);
  assert.deepEqual(rendered(page), []);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.isLoadingMore, false);
  assert.equal(page.data.isLoading, true);
  assert.equal(calls.cloud[2].data.data.month, '2026-08');
  assert.equal(calls.cloud[2].data.data.cursor, undefined);
  assert.equal(calls.cloud[2].data.data.memberOpenid, 'a');
  assert.equal(calls.cloud[2].data.data.filter, 'below_goal');
  august.resolve(success(monthlyDetails('2026-08', [row('a', '2026-08-31', 5)], { filter: 'below_goal' })));
  await newMonth;
  more.resolve(success(monthlyDetails('2026-09', [row('a', '2026-09-17', 1)], { filter: 'below_goal' })));
  await oldPage;
  assert.equal(page.data.filter, 'below_goal');
  assert.equal(page.data.memberOpenid, 'a');
  assert.deepEqual(rendered(page).map(item => [item.openid, item.date]), [['a', '2026-08-31']]);
});

test('month can change while the initial request is loading and stale first-page responses are ignored', async () => {
  const september = deferred();
  const { page, calls } = createPage({ cloud: data => data.month === '2026-09' ? september.promise
    : success(monthlyDetails(data.month, [row('august', '2026-08-31')])) });
  const first = page.onShow();
  await page.changeMonth(monthEvent('2026-08'));
  assert.equal(calls.cloud.length, 2);
  assert.equal(page.data.selectedMonth, '2026-08');
  september.resolve(success(monthlyDetails('2026-09', [row('old')])));
  await first;
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.deepEqual(rendered(page).map(item => item.openid), ['august']);
});

test('month can change after a failed initial request without first retrying the failed month', async () => {
  const { page, calls } = createPage({ cloud: data => data.month === '2026-09' ? Promise.reject(new Error('网络不可用'))
    : success(monthlyDetails(data.month, [row('a', '2026-08-31')])) });
  await page.onShow();
  assert.equal(page.data.loadError, '网络不可用');
  await page.changeMonth(monthEvent('2026-08'));
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.itemCount, 1);
  assert.deepEqual(calls.cloud.map(call => call.data.data.month), ['2026-09', '2026-08']);
});

test('month and filter changes cannot be overwritten by earlier requests for either scope', async () => {
  const oldMonth = deferred();
  const oldFilter = deferred();
  const { page, calls } = createPage({ cloud: data => {
    if (data.month === '2026-08') return data.filter === 'all' ? oldFilter.promise : oldMonth.promise;
    return success(monthlyDetails(data.month, [row(data.month, `${data.month}-15`)], { filter: data.filter }));
  } });
  await page.onShow();
  const first = page.changeMonth(monthEvent('2026-08'));
  const second = page.changeFilter(event({ filter: 'all' }));
  await page.changeMonth(monthEvent('2026-07'));
  oldFilter.resolve(success(monthlyDetails('2026-08', [row('old-filter', '2026-08-31')], { filter: 'all' })));
  await second;
  oldMonth.resolve(success(monthlyDetails('2026-08', [row('old-month', '2026-08-31')])));
  await first;
  assert.equal(page.data.selectedMonth, '2026-07');
  assert.equal(page.data.filter, 'all');
  assert.deepEqual(rendered(page).map(item => item.openid), ['2026-07']);
  assert.deepEqual(calls.cloud.map(call => [call.data.data.month, call.data.data.filter]),
    [['2026-09', 'unmet'], ['2026-08', 'unmet'], ['2026-08', 'all'], ['2026-07', 'all']]);
});

test('pagination, refresh, and retry keep the selected past month', async () => {
  const cursor = { date: '2026-08-31', memberOpenid: 'a' };
  const { page, calls } = createPage({ query: { teamId: 'team-a', month: '2026-08' }, cloud: (_, count) => {
    if (count === 2) return Promise.reject(new Error('加载更多失败'));
    return success(monthlyDetails('2026-08', [row(count === 3 ? 'b' : 'a', '2026-08-31')],
      { nextCursor: count === 1 ? cursor : null }));
  } });
  await page.onShow();
  await page.loadMore();
  await page.loadMore();
  assert.equal(page.data.itemCount, 2);
  await page.onPullDownRefresh();
  assert.equal(page.data.itemCount, 1);
  assert.equal(calls.refreshStopped, 1);
  assert.deepEqual(calls.cloud.map(call => call.data.data.month), ['2026-08', '2026-08', '2026-08', '2026-08']);
  assert.deepEqual(calls.cloud[2].data.data.cursor, cursor);
  assert.equal(calls.cloud[3].data.data.cursor, undefined);
});

test('the default current month follows the Beijing 02:00 practice-day boundary', async () => {
  for (const [now, month, businessDate, totalDays] of [
    ['2026-10-01T01:59:59+08:00', '2026-09', '2026-09-30', 29],
    ['2026-10-01T02:00:00+08:00', '2026-10', '2026-10-01', 0]
  ]) {
    const { page, calls } = createPage({ now, cloud: () => success(monthlyDetails(month, [], { businessDate })) });
    await page.onShow();
    assert.equal(calls.cloud[0].data.data.month, month, now);
    assert.equal(page.data.currentMonth, month, now);
    assert.equal(page.data.selectedMonth, month, now);
    assert.equal(page.data.loadError, '', now);
    assert.equal(page.data.history.totalDays, totalDays, now);
    if (!totalDays) {
      assert.equal(page.data.itemCount, 0);
      assert.equal(page.data.emptyTitle, '本月暂无历史日期');
      assert.match(page.data.emptyDescription, /不包含今日/);
    }
  }
});

test('a visible history page refreshes at 02:00 across year-end and stops watching when hidden or unloaded', async () => {
  const app = createPage({ now: '2027-01-01T01:59:59+08:00', cloud: (_, count) => success(monthlyDetails('2026-12',
    count === 1 ? [] : [row('a', '2026-12-31')], {
      practiceStartDate: '2026-12-01', businessDate: count === 1 ? '2026-12-31' : '2027-01-01'
    })) });
  await app.page.onShow();
  assert.equal(app.page.data.history.totalDays, 30);
  assert.equal(app.page.data.selectedMonth, '2026-12');
  assert.equal(app.timers.size, 1);
  const [timerId, timer] = [...app.timers.entries()][0];
  assert.equal(timer.delay, 1000);
  app.setNow('2027-01-01T02:00:00+08:00');
  app.timers.delete(timerId);
  timer.fn();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(app.calls.cloud.length, 2);
  assert.equal(app.page.data.history.totalDays, 31);
  assert.equal(app.page.data.currentMonth, '2027-01');
  assert.equal(app.page.data.selectedMonth, '2026-12', 'keep the month the member is viewing');
  assert.equal(app.page.data.canNextMonth, true);
  assert.deepEqual(rendered(app.page).map(item => item.date), ['2026-12-31']);
  assert.equal(app.timers.size, 1);
  app.page.onHide();
  assert.equal(app.timers.size, 0);
  await app.page.onShow();
  assert.equal(app.timers.size, 1);
  app.page.onUnload();
  assert.equal(app.timers.size, 0);
});

test('server-clamped query months are accepted only at the matching available boundary', async () => {
  for (const [requested, selected] of [['2026-07', '2026-08'], ['2026-12', '2026-09']]) {
    const { page, calls } = createPage({ query: { teamId: 'team-a', month: requested },
      cloud: () => success(monthlyDetails(selected, [], { practiceStartDate: '2026-08-15' })) });
    await page.onShow();
    assert.equal(calls.cloud[0].data.data.month, requested);
    assert.equal(page.data.loadError, '');
    assert.equal(page.data.selectedMonth, selected);
    assert.equal(page.data.minMonth, '2026-08');
    assert.equal(page.data.maxMonth, '2026-09');
  }
});

test('legacy responses without month metadata and inconsistent month ranges are rejected', async () => {
  const invalidReports = [];
  for (const field of ['month', 'minMonth', 'maxMonth']) {
    const report = details();
    delete report.history[field];
    invalidReports.push(report);
  }
  for (const changes of [
    { month: '2026-08' },
    { month: '2026-13' },
    { minMonth: '2026-08' },
    { maxMonth: '2026-10' },
    { minMonth: '2026-10', maxMonth: '2026-09' },
    { startDate: '2026-08-31', totalDays: 19 },
    { startDate: '2026-09-02', totalDays: 17 },
    { endDate: '2026-09-17', totalDays: 17 },
    { totalDays: 17 }
  ]) invalidReports.push(details([], { history: { ...details().history, ...changes } }));
  for (const report of invalidReports) {
    const { page } = createPage({ cloud: () => success(report) });
    await page.onShow();
    assert.match(page.data.loadError, /暂不完整/, JSON.stringify(report.history));
    assert.equal(page.data.itemCount, 0);
  }
  const { page } = createPage({ query: { teamId: 'team-a', month: '2026-08' },
    cloud: () => success(monthlyDetails('2026-09')) });
  await page.onShow();
  assert.match(page.data.loadError, /暂不完整/);
});

test('malformed month-picker values do not trigger a request or replace the selected month', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  for (const value of ['', null, '2026-00', '2026-13', '2026-9', '0000-09', '2026-09-01']) {
    await page.changeMonth(monthEvent(value));
  }
  await page.changeMonth();
  assert.equal(calls.cloud.length, 1);
  assert.equal(page.data.selectedMonth, '2026-09');
});

test('a moved practice start month resets old pagination and adopts the new server boundary', async () => {
  for (const responseType of ['invalid-cursor', 'changed-report']) {
    const changed = monthlyDetails('2026-09', [row('fresh', '2026-09-18')], { practiceStartDate: '2026-09-05' });
    const { page, calls } = createPage({ query: { teamId: 'team-a', month: '2026-08' }, cloud: (_, count) => {
      if (count === 1) return success(monthlyDetails('2026-08', [row('old', '2026-08-31')], {
        practiceStartDate: '2026-08-01', nextCursor: { date: '2026-08-31', memberOpenid: 'old' }
      }));
      if (count === 2 && responseType === 'invalid-cursor') return { result: { success: false, error: '分页游标无效，请重新加载' } };
      return success(changed);
    } });
    await page.onShow();
    await page.loadMore();
    assert.equal(calls.cloud.length, 3, responseType);
    assert.equal(calls.cloud[2].data.data.cursor, undefined, responseType);
    assert.equal(calls.cloud[2].data.data.month, responseType === 'invalid-cursor' ? '2026-08' : '2026-09', responseType);
    assert.equal(page.data.selectedMonth, '2026-09', responseType);
    assert.equal(page.data.minMonth, '2026-09', responseType);
    assert.equal(page.data.canPreviousMonth, false, responseType);
    assert.equal(page.data.loadError, '', responseType);
    assert.equal(page.data.moreError, '', responseType);
    assert.equal(page.data.isLoading, false, responseType);
    assert.equal(page.data.isLoadingMore, false, responseType);
    assert.deepEqual(rendered(page).map(item => item.openid), ['fresh'], responseType);
  }
});
