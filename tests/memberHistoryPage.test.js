const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const utilsPath = path.join(__dirname, '../miniprogram/utils');
const plain = value => JSON.parse(JSON.stringify(value));
const silentConsole = { log() {}, warn() {}, error() {} };
const defaultQuery = { teamId: 'team-1', memberOpenid: 'member-1', memberName: '团员小林', date: '2026-09-17', month: '2026-09' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function record(id, date, time, duration) {
  return { _id: id, date, timestamp: time ? Date.parse(time) : null, duration };
}

function result(records = [], overrides = {}) {
  return {
    success: true,
    data: {
      member: { openid: 'member-1', nickname: '团员小林', avatarUrl: 'https://example.com/member.png', isCreator: false },
      startDate: '2026-08-01', businessDate: '2026-09-19', records, ...overrides
    }
  };
}

function createPage(kind, options = {}) {
  const pagePath = path.join(__dirname, `../miniprogram/pages/${kind}/${kind}.js`);
  let definition;
  let account = options.account || 'viewer-1';
  let now = Date.parse(options.now || '2026-09-19T12:00:00+08:00');
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  const calls = { member: [], ownReads: 0, ownCloud: 0, ownNotes: 0, ownDeletes: [], storageWrites: [], storageReads: [], actions: [], modals: [], redirects: [], navigations: [], titles: [], toast: [], stopRefresh: 0, updates: 0 };
  const manager = {
    getUserCheckinData() {
      calls.ownReads++;
      return { dailyRecords: { '2026-09-17': { count: 1, records: [record('own-private', '2026-09-17', '2026-09-17T06:00:00+08:00', 99)] } } };
    },
    refreshFromCloud() { calls.ownCloud++; return false; },
    getExperienceRecordsFromLocal() { calls.ownNotes++; return [{ _id: 'private-note', text: '私密笔记' }]; },
    async deleteCheckin(...args) { calls.ownDeletes.push(args); return { success: true }; }
  };
  const teamManager = {
    getTeamMemberPracticeRecords(...args) {
      calls.member.push(args);
      return options.fetch ? options.fetch(...args) : result(options.records || []);
    }
  };
  const wx = {
    getStorageSync(key) {
      calls.storageReads.push(key);
      if (key === 'userOpenId') return account;
      if (key === 'userInfo') return { openid: account };
      if (key === 'meditationTextRecords') return [{ _id: 'private-note', text: '私密笔记' }];
      return undefined;
    },
    setStorageSync(...args) { calls.storageWrites.push(args); },
    setNavigationBarTitle(value) { calls.titles.push(value); },
    showToast(value) { calls.toast.push(value); },
    redirectTo(value) { calls.redirects.push(value); },
    navigateTo(value) { calls.navigations.push(value); },
    stopPullDownRefresh() { calls.stopRefresh++; },
    showActionSheet(value) { calls.actions.push(value); value.success({ tapIndex: 0 }); },
    showModal(value) { calls.modals.push(value); value.success({ confirm: true }); }
  };
  const getApp = () => ({ globalData: { openid: account, userInfo: { openid: account } } });
  const modules = { 'checkin.js': manager, 'teamManager.js': teamManager, 'lunar.js': { getLunarDate: () => '丙午年八月初七' } };
  function loadModule(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js', 'memberHistory.js'].includes(filename), `Unexpected dependency: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(utilsPath, filename), 'utf8'), {
      module, require: loadModule, wx, getApp, Date: ClockDate, console: silentConsole
    }, { filename });
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: loadModule, Page(value) { definition = value; }, wx, getApp, Date: ClockDate, console: silentConsole
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); calls.updates++; }
  };
  page.onLoad(options.query === undefined ? defaultQuery : options.query);
  return { page, calls, setAccount(value) { account = value; }, setNow(value) { now = Date.parse(value); } };
}

function renderedRecords(page, kind) {
  return plain(kind === 'history' ? page.data.recordList : page.data.monthDays.flatMap(day => day.records));
}

function assertOwnDataUntouched(calls) {
  assert.equal(calls.ownReads, 0);
  assert.equal(calls.ownCloud, 0);
  assert.equal(calls.ownNotes, 0);
  assert.deepEqual(calls.ownDeletes, []);
  assert.deepEqual(calls.storageWrites, []);
  assert.equal(calls.storageReads.includes('meditationTextRecords'), false);
}

function assertNavigationContext(url, expectedPath, context = defaultQuery) {
  const parsed = new URL(url, 'https://mini.example');
  assert.equal(parsed.pathname, expectedPath);
  for (const key of ['teamId', 'memberOpenid', 'memberName']) assert.equal(parsed.searchParams.get(key), context[key]);
  return parsed.searchParams;
}

for (const kind of ['history', 'checkinHistory']) {
  test(`${kind}: member view fetches only team-authorized records and cannot delete them`, async () => {
    const { page, calls } = createPage(kind, { records: [record('member-record', '2026-09-17', '2026-09-17T06:00:00+08:00', 21)] });
    assert.equal(page.data.isMemberHistory, true);
    await page.onShow();
    assert.deepEqual(calls.member, [['team-1', 'member-1']]);
    assert.equal(page.data.memberName, '团员小林');
    assert.equal(page.data.memberAvatar, 'https://example.com/member.png');
    assert.equal(page.data.memberStartDate, '2026-08-01');
    assert.equal(page.data.memberLoading, false);
    assert.equal(page.data.memberError, '');
    const records = renderedRecords(page, kind);
    assert.deepEqual(records.map(item => item._id), ['member-record']);
    if (kind === 'history') await page.showRecordActions({ currentTarget: { dataset: { recordKey: records[0].recordKey } } });
    else await page.deleteCheckinRecord({ currentTarget: { dataset: { id: records[0].id } } });
    assert.deepEqual(calls.actions, []);
    assert.deepEqual(calls.modals, []);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: incomplete member URLs fail closed without showing personal records`, async () => {
    for (const query of [{ teamId: 'team-1' }, { memberOpenid: 'member-1' }]) {
      const { page, calls } = createPage(kind, { query });
      assert.equal(page.data.isMemberHistory, true);
      await page.onShow();
      assert.ok(page.data.memberError);
      assert.equal(renderedRecords(page, kind).length, 0);
      assert.equal(calls.member.length, 0);
      assertOwnDataUntouched(calls);
    }
  });

  test(`${kind}: cloud failure clears prior member records and pull-down retry recovers`, async () => {
    let response = result([record('member-record', '2026-09-17', '2026-09-17T06:00:00+08:00', 21)]);
    const { page, calls } = createPage(kind, { fetch: () => response });
    await page.onShow();
    assert.equal(renderedRecords(page, kind).length, 1);
    response = { success: false, error: '当前已无权查看该成员记录' };
    await page.onPullDownRefresh();
    assert.match(page.data.memberError, /无权/);
    assert.equal(renderedRecords(page, kind).length, 0);
    response = result([record('retry-record', '2026-09-17', '2026-09-17T07:00:00+08:00', 12)]);
    await page.onPullDownRefresh();
    assert.equal(page.data.memberError, '');
    assert.equal(page.data.memberLoading, false);
    assert.deepEqual(renderedRecords(page, kind).map(item => item._id), ['retry-record']);
    assert.equal(calls.stopRefresh, 2);
    assert.equal(calls.member.length, 3);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: network rejection shows an error and releases the request for retry`, async () => {
    let failing = true;
    const { page, calls } = createPage(kind, { fetch: () => failing ? Promise.reject(new Error('offline')) : result() });
    await page.onShow();
    assert.ok(page.data.memberError);
    assert.equal(page.data.memberLoading, false);
    assert.equal(renderedRecords(page, kind).length, 0);
    failing = false;
    await page.onPullDownRefresh();
    assert.equal(page.data.memberError, '');
    assert.equal(calls.member.length, 2);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: unloaded pages ignore a late member response`, async () => {
    const pending = deferred();
    const { page, calls } = createPage(kind, { fetch: () => pending.promise });
    const showing = page.onShow();
    await Promise.resolve();
    page.onUnload();
    const updates = calls.updates;
    pending.resolve(result([record('late-member', '2026-09-17', '2026-09-17T06:00:00+08:00', 21)]));
    await showing;
    assert.equal(calls.updates, updates);
    assert.equal(renderedRecords(page, kind).length, 0);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: simultaneous entry and pull-down share a member fetch and render the current selection`, async () => {
    const pending = deferred();
    const { page, calls } = createPage(kind, { fetch: () => pending.promise });
    const showing = page.onShow();
    if (kind === 'history') page.previousDay();
    else page.previousMonth();
    const pulling = page.onPullDownRefresh();
    await Promise.resolve();
    assert.equal(calls.member.length, 1);
    assert.equal(page.data.memberLoading, true);
    assert.equal(calls.stopRefresh, 0);
    const date = kind === 'history' ? '2026-09-16' : '2026-08-16';
    pending.resolve(result([record('current-selection', date, `${date}T06:00:00+08:00`, 21)]));
    await Promise.all([showing, pulling]);
    assert.deepEqual(renderedRecords(page, kind).map(item => item._id), ['current-selection']);
    assert.equal(calls.stopRefresh, 1);
    assert.equal(page.data.memberLoading, false);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: switching accounts during a request cannot expose the old account's member records`, async () => {
    const pending = deferred();
    const { page, calls, setAccount } = createPage(kind, { fetch: () => pending.promise });
    const showing = page.onShow();
    await Promise.resolve();
    setAccount('viewer-2');
    pending.resolve(result([record('old-viewer-record', '2026-09-17', '2026-09-17T06:00:00+08:00', 21)]));
    await showing;
    assert.equal(renderedRecords(page, kind).length, 0);
    assert.ok(page.data.memberError);
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: a new account's retry cannot be overwritten by the previous account's response`, async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    let request = 0;
    const { page, calls, setAccount } = createPage(kind, { fetch: () => request++ ? newRequest.promise : oldRequest.promise });
    const original = page.onShow();
    await Promise.resolve();
    setAccount('viewer-2');
    const latest = page.onShow();
    await Promise.resolve();
    assert.equal(calls.member.length, 2);
    newRequest.resolve(result([record('new-viewer-record', '2026-09-17', '2026-09-17T06:00:00+08:00', 12)]));
    await latest;
    oldRequest.resolve(result([record('old-viewer-record', '2026-09-17', '2026-09-17T06:00:00+08:00', 99)]));
    await original;
    assert.deepEqual(renderedRecords(page, kind).map(item => item._id), ['new-viewer-record']);
    assert.equal(page.data.memberError, '');
    assertOwnDataUntouched(calls);
  });

  test(`${kind}: own-history routes keep their existing personal data source`, async () => {
    const { page, calls } = createPage(kind, { query: { date: '2026-09-17', month: '2026-09' } });
    await page.onShow();
    assert.equal(page.data.isMemberHistory, false);
    assert.equal(calls.member.length, 0);
    assert.equal(calls.ownReads, 1);
    assert.equal(calls.ownCloud, 1);
    assert.deepEqual(renderedRecords(page, kind).map(item => item._id), ['own-private']);
  });
}

test('member day and month navigation preserve encoded identity and the selected business date', async () => {
  const context = { teamId: 'team/a?b=1&c', memberOpenid: 'member+a/b&c', memberName: '林 & 月 / 100% + 小组' };
  const query = { ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, encodeURIComponent(value)])), date: '2026-09-17', month: '2026-09' };
  const response = result([], { member: { openid: context.memberOpenid, nickname: context.memberName, avatarUrl: '', isCreator: false } });
  const daily = createPage('history', { query, fetch: () => response });
  await daily.page.onShow();
  daily.page.openMonthlyHistory();
  const monthQuery = assertNavigationContext(daily.calls.redirects[0].url, '/pages/checkinHistory/checkinHistory', context);
  assert.equal(monthQuery.get('date'), '2026-09-17');
  assert.equal(monthQuery.get('month'), '2026-09');
  const monthly = createPage('checkinHistory', { query, fetch: () => response });
  await monthly.page.onShow();
  monthly.page.openDailyView();
  assert.equal(assertNavigationContext(monthly.calls.redirects[0].url, '/pages/history/history', context).get('date'), '2026-09-17');
  monthly.page.openCheckinHistory({ currentTarget: { dataset: { date: '2026-09-16' } } });
  assert.equal(assertNavigationContext(monthly.calls.navigations[0].url, '/pages/history/history', context).get('date'), '2026-09-16');
});

test('member month totals use the 04:00 boundary and preserve legacy records without timestamps', async () => {
  const records = [
    record('before-boundary', '2026-08-31', '2026-09-01T03:59:00+08:00', 10),
    record('at-boundary', '2026-09-01', '2026-09-01T04:00:00+08:00', 20),
    record('legacy', '2026-08-30', null, 30)
  ];
  const { page, calls } = createPage('checkinHistory', { records, query: { ...defaultQuery, date: '2026-08-31', month: '2026-08' } });
  await page.onShow();
  assert.equal(page.data.monthCount, 2);
  assert.equal(page.data.monthDuration, 40);
  assert.equal(page.data.monthDayCount, 2);
  assert.deepEqual(plain(page.data.monthDays).map(day => day.date), ['2026-08-31', '2026-08-30']);
  assert.equal(page.data.monthDays[0].records[0].timeLabel, '次日 03:59');
  assert.equal(page.data.monthDays[1].records[0].timeLabel, '时间未记录');
  page.nextMonth();
  assert.equal(page.data.monthCount, 1);
  assert.equal(page.data.monthDuration, 20);
  assert.equal(calls.member.length, 1, 'changing periods only projects fetched member records');
  assertOwnDataUntouched(calls);
  const daily = createPage('history', { records, query: { ...defaultQuery, date: '2026-08-31' } });
  await daily.page.onShow();
  assert.equal(daily.page.data.recordCount, 1);
  assert.equal(daily.page.data.totalDuration, 10);
  assert.equal(daily.page.data.recordList[0].timeLabel, '次日 03:59');
});

test('member start date limits daily/monthly navigation and returning to a daily page', async () => {
  const response = result([], { startDate: '2026-09-12' });
  const daily = createPage('history', { fetch: () => response, query: { ...defaultQuery, date: '2026-07-01' } });
  await daily.page.onShow();
  assert.equal(daily.page.data.selectedDateKey, '2026-09-12');
  daily.page.previousDay();
  assert.equal(daily.page.data.selectedDateKey, '2026-09-12');
  daily.page.onDateChange({ detail: { value: '2026-08-31' } });
  assert.equal(daily.page.data.selectedDateKey, '2026-09-12');
  const monthly = createPage('checkinHistory', { fetch: () => response, query: { ...defaultQuery, date: '2026-07-01', month: '2026-07' } });
  await monthly.page.onShow();
  assert.equal(monthly.page.data.selectedMonth, '2026-09');
  monthly.page.previousMonth();
  assert.equal(monthly.page.data.selectedMonth, '2026-09');
  monthly.page.openDailyView();
  assert.ok(assertNavigationContext(monthly.calls.redirects[0].url, '/pages/history/history').get('date') >= '2026-09-12');
});

test('member loading and read errors are visible while delete controls are hidden in both templates', () => {
  for (const [kind, action] of [['history', 'showRecordActions'], ['checkinHistory', 'deleteCheckinRecord']]) {
    const wxml = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${kind}/${kind}.wxml`), 'utf8');
    const button = wxml.match(new RegExp(`<button\\b[^>]*catchtap="${action}"[^>]*>`));
    assert.ok(button, `${kind} retains the personal record action button`);
    assert.match(button[0], /wx:if="\{\{!isMemberHistory\}\}"/);
    assert.match(wxml, /memberLoading/);
    assert.match(wxml, /memberError/);
    assert.match(wxml, /memberName/);
  }
});
