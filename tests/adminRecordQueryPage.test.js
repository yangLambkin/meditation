const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil.js');

const DATE = '2026-09-23';
const USER = { openid: 'openid-first-user', nickname: '静心', studentNumber: 'BJ001' };
const OTHER_USER = { openid: 'openid-second-user', nickname: '静心', studentNumber: '' };
const success = data => ({ success: true, data });
const input = value => ({ detail: { value } });
const tab = value => ({ currentTarget: { dataset: { tab: value } } });
const failure = error => ({ success: false, error });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function dayResult({ user = USER, recordDate = DATE, records = [], totalCount = records.length, totalDuration = 0 } = {}) {
  return success({ user, recordDate, records, totalCount, totalDuration });
}

function harness({ api, access = true, now = '2026-09-23T02:01:00+08:00', initialTab = 'query' } = {}) {
  let definition;
  let currentTime = Date.parse(now);
  let accessCount = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = { cloud: [], toast: [], alerts: [], refresh: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const cloudApi = { async callCloudFunction(name, data) {
    calls.cloud.push({ name, data });
    if (name === 'adminManager' && data.type === 'getAccess') {
      accessCount++;
      return { result: typeof access === 'function' ? await access(accessCount) : success({ isAdmin: access }) };
    }
    let reply = api && await api(name, data);
    if (reply === undefined) {
      if (data.type === 'adminStatus') reply = success({ dates: [DATE], latestDate: DATE });
      else if (data.type === 'adminSearchUsers') reply = success({ users: [USER], nextCursor: null });
      else if (data.type === 'adminGetDayRecords') reply = dayResult({ recordDate: data.recordDate });
      else reply = success({ teams: [], logs: [], runs: [], errors: [] });
    }
    return { result: reply };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/admin/admin.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp() { return { refreshSyncAlert() { calls.alerts.push('refresh'); }, clearSyncAlert() { calls.alerts.push('clear'); } }; },
    require(name) {
      if (name.includes('cloudApi')) return cloudApi;
      if (name.includes('dateUtil')) return dateUtil;
      throw new Error(`Unexpected require: ${name}`);
    },
    Date: Clock, console,
    wx: { showToast(value) { calls.toast.push(value); }, stopPullDownRefresh() { calls.refresh.push('stopped'); } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  page.data.tab = initialTab;
  return { page, calls, timers, advance(ms) { currentTime += ms; } };
}

async function openQuery(options) {
  const result = harness(options);
  await result.page.onShow();
  return result;
}

async function search(page, nickname = USER.nickname) {
  page.onQueryNicknameInput(input(nickname));
  await page.searchRecordUsers();
}

function requests(calls, type) {
  return calls.cloud.filter(call => call.data.type === type);
}

function assertQueryCleared(page) {
  assert.equal(page.data.queryNickname, '');
  assert.equal(page.data.queryDate, '');
  assert.equal(page.data.queryUsers.length, 0);
  assert.equal(page.data.selectedQueryUser, null);
  assert.equal(page.data.dayRecords.length, 0);
  assert.equal(page.data.dayTotalCount, 0);
  assert.equal(page.data.dayTotalDuration, 0);
  assert.equal(page.data.queryLoading, false);
  assert.equal(page.data.dayRecordsLoading, false);
}

test('the query tab separately authorizes against adminManager and never depends on synchronization services', async () => {
  const { page, calls, timers } = await openQuery();
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, true);
  assert.equal(requests(calls, 'getAccess').length, 2);
  assert.equal(calls.cloud.every(call => call.name === 'adminManager'), true);
  assert.equal(timers.size, 0);

  const denied = await openQuery({ access: count => success({ isAdmin: count === 1 }) });
  assert.equal(denied.page.data.entryAuthorized, true);
  assert.equal(denied.page.data.authorized, false);
  assert.match(denied.page.data.accessError, /仅指定管理员/);
  assertQueryCleared(denied.page);
  await search(denied.page);
  assert.equal(requests(denied.calls, 'adminSearchUsers').length, 0);

  const entryDenied = await openQuery({ access: false });
  assert.equal(entryDenied.calls.cloud.length, 1);
  assert.equal(entryDenied.page.data.entryAuthorized, false);
  assertQueryCleared(entryDenied.page);
});

test('record queries remain available when the sync cloud function has not been updated', async () => {
  const { page, calls } = await openQuery({ initialTab: 'sync', api: name => name === 'bijingSync' ? failure('未知操作: adminStatus') : undefined });
  assert.equal(page.data.authorized, false);
  await page.onTabChange(tab('query'));
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.accessError, '');
  await search(page);
  assert.equal(page.data.dayRecordsLoaded, true);
  assert.equal(calls.cloud.filter(call => call.name === 'bijingSync').length, 1);
});

test('the default query date changes at 02:00 Beijing time regardless of the device timezone', async () => {
  for (const [now, expected] of [
    ['2026-09-22T17:59:59.999Z', '2026-09-22'],
    ['2026-09-22T18:00:00.000Z', '2026-09-23'],
    ['2026-09-23T17:59:59.999Z', '2026-09-23']
  ]) {
    const { page } = await openQuery({ now });
    assert.equal(page.data.queryDate, expected);
    assert.equal(page.data.queryMaxDate, expected);
  }
});

test('blank nicknames and invalid or future dates are rejected without sending a search request', async () => {
  const { page, calls } = await openQuery();
  for (const nickname of ['', ' \n\t ', '名'.repeat(101)]) {
    await search(page, nickname);
    assert.match(page.data.queryError, /完整昵称/);
  }
  page.onQueryNicknameInput(input(USER.nickname));
  for (const recordDate of ['2026-02-30', '2026-09-24']) {
    await page.onQueryDateChange(input(recordDate));
    await page.searchRecordUsers();
    assert.match(page.data.queryError, /有效的静坐日期/);
  }
  assert.equal(requests(calls, 'adminSearchUsers').length, 0);
  assert.equal(requests(calls, 'adminGetDayRecords').length, 0);
});

test('a trimmed complete nickname is sent literally and a unique match loads the selected day', async () => {
  const nickname = '静心.*[小组]';
  const { page, calls } = await openQuery({ api: (name, data) => data.type === 'adminSearchUsers'
    ? success({ users: [{ ...USER, nickname }], nextCursor: null }) : undefined });
  page.onQueryNicknameInput(input(`  ${nickname}  `));
  await page.onQueryDateChange(input('2026-09-20'));
  await page.searchRecordUsers({ type: 'tap' });
  assert.equal(page.data.queryNickname, nickname);
  assert.equal(JSON.stringify(requests(calls, 'adminSearchUsers')[0]), JSON.stringify({ name: 'adminManager', data: { type: 'adminSearchUsers', nickname } }));
  assert.equal(JSON.stringify(requests(calls, 'adminGetDayRecords')[0]), JSON.stringify({ name: 'adminManager', data: { type: 'adminGetDayRecords', openid: USER.openid, recordDate: '2026-09-20' } }));
  assert.equal(page.data.querySearched, true);
  assert.equal(page.data.queryUserIndex, 0);
  assert.equal(page.data.selectedQueryUser.openid, USER.openid);
  assert.equal(page.data.dayRecordsLoaded, true);
});

test('same-name users require selection, paginate by cursor, and preserve the selected user while appending', async () => {
  const { page, calls } = await openQuery({ api: (name, data) => data.type === 'adminSearchUsers'
    ? success({ users: data.cursor ? [USER, OTHER_USER] : [USER], nextCursor: data.cursor ? null : 'next-user' }) : undefined });
  await search(page);
  assert.equal(page.data.selectedQueryUser, null, 'a first page with one user may still have duplicate names on following pages');
  assert.equal(requests(calls, 'adminGetDayRecords').length, 0);
  await page.onQueryUserChange(input('0'));
  assert.equal(page.data.selectedQueryUser.openid, USER.openid);
  assert.match(page.data.selectedQueryUser.displayName, /BJ001/);
  await page.loadMoreQueryUsers();
  assert.equal(requests(calls, 'adminSearchUsers')[1].data.cursor, 'next-user');
  assert.equal(page.data.queryUsers.length, 2, 'overlapping cursor results do not duplicate an account');
  assert.equal(page.data.queryUsersCursor, '');
  assert.equal(page.data.selectedQueryUser.openid, USER.openid);
  assert.equal(requests(calls, 'adminGetDayRecords').length, 1);
  await page.onQueryUserChange(input('1'));
  assert.equal(page.data.selectedQueryUser.openid, OTHER_USER.openid);
  assert.match(page.data.selectedQueryUser.displayName, /未绑定学号/);
  assert.match(page.data.selectedQueryUser.displayName, new RegExp(OTHER_USER.openid.slice(-6)));
  for (const index of ['-1', '99', 'invalid']) await page.onQueryUserChange(input(index));
  await page.loadMoreQueryUsers();
  assert.equal(requests(calls, 'adminSearchUsers').length, 2);
  assert.equal(requests(calls, 'adminGetDayRecords').length, 2);
});

test('daily results display server totals, Beijing timestamps and manual, timer and legacy sources', async () => {
  const records = [
    { _id: 'manual', date: DATE, timestamp: Date.parse('2026-09-23T06:20:00Z'), duration: 25, source: 'manual' },
    { _id: 'timer', date: DATE, timestamp: Date.parse('2026-09-23T17:30:00Z'), duration: 20.5, source: 'timer' },
    { _id: 'legacy', date: DATE, timestamp: null, duration: 10, source: 'unknown' }
  ];
  const { page } = await openQuery({ api: (name, data) => data.type === 'adminGetDayRecords' ? dayResult({ records, totalDuration: 55.5 }) : undefined });
  await search(page);
  assert.equal(page.data.dayTotalCount, 3);
  assert.equal(page.data.dayTotalDuration, 55.5);
  assert.equal(page.data.dayRecords[0].timeText, '2026-09-23 14:20:00');
  assert.equal(page.data.dayRecords[0].sourceText, '手动补录');
  assert.equal(page.data.dayRecords[1].timeText, '2026-09-24 01:30:00');
  assert.equal(page.data.dayRecords[1].sourceText, '计时记录');
  assert.equal(page.data.dayRecords[2].timeText, '未记录具体时间');
  assert.equal(page.data.dayRecords[2].sourceText, '历史记录');
  assert.equal(page.data.dayRecordsLoaded, true);
  assert.equal(page.data.dayRecordsLoading, false);
  assert.equal(page.data.dayRecordsError, '');
});

test('no matching user and a matched user with no records remain distinct completed states', async () => {
  const unmatched = await openQuery({ api: (name, data) => data.type === 'adminSearchUsers' ? success({ users: [], nextCursor: null }) : undefined });
  await search(unmatched.page);
  assert.equal(unmatched.page.data.querySearched, true);
  assert.equal(unmatched.page.data.queryUsers.length, 0);
  assert.equal(unmatched.page.data.queryError, '');
  assert.equal(unmatched.page.data.dayRecordsLoaded, false);
  assert.equal(requests(unmatched.calls, 'adminGetDayRecords').length, 0);

  const emptyDay = await openQuery();
  await search(emptyDay.page);
  assert.equal(emptyDay.page.data.selectedQueryUser.openid, USER.openid);
  assert.equal(emptyDay.page.data.dayRecordsLoaded, true);
  assert.equal(emptyDay.page.data.dayRecords.length, 0);
  assert.equal(emptyDay.page.data.dayTotalCount, 0);
  assert.equal(emptyDay.page.data.dayTotalDuration, 0);
});

test('editing a nickname ignores a late search response or failure from the previous nickname', async () => {
  for (const oldResult of [success({ users: [USER], nextCursor: 'old-cursor' }), failure('旧昵称查询失败')]) {
    const pending = deferred();
    const { page, calls } = await openQuery({ api: (name, data) => data.type === 'adminSearchUsers'
      ? data.nickname === '旧昵称' ? pending.promise : success({ users: [], nextCursor: null }) : undefined });
    const first = search(page, '旧昵称');
    assert.equal(page.data.queryLoading, true);
    await search(page, '新昵称');
    pending.resolve(oldResult);
    await first;
    assert.equal(page.data.queryNickname, '新昵称');
    assert.equal(page.data.queryUsers.length, 0);
    assert.equal(page.data.queryUsersCursor, '');
    assert.equal(page.data.querySearched, true);
    assert.equal(page.data.queryError, '');
    assert.equal(page.data.queryLoading, false);
    assert.equal(requests(calls, 'adminGetDayRecords').length, 0);
  }
});

test('editing a nickname clears old details and ignores their delayed record response', async () => {
  const pending = deferred();
  const { page } = await openQuery({ api: (name, data) => data.type === 'adminGetDayRecords' ? pending.promise : undefined });
  const loading = search(page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.dayRecordsLoading, true);
  page.onQueryNicknameInput(input('另一位'));
  pending.resolve(dayResult({ records: [{ _id: 'private-record', duration: 80 }], totalDuration: 80 }));
  await loading;
  assert.equal(page.data.queryNickname, '另一位');
  assert.equal(page.data.selectedQueryUser, null);
  assert.equal(page.data.dayRecords.length, 0);
  assert.equal(page.data.dayRecordsLoaded, false);
  assert.equal(page.data.dayRecordsLoading, false);
  assert.equal(page.data.dayTotalDuration, 0);
});

test('changing the selected date ignores a delayed response for the previous day', async () => {
  const pending = deferred();
  const { page, calls } = await openQuery({ api: (name, data) => data.type === 'adminGetDayRecords'
    ? data.recordDate === DATE ? pending.promise : dayResult({ recordDate: data.recordDate, records: [{ _id: 'new-day', duration: 12 }], totalDuration: 12 }) : undefined });
  const first = search(page);
  await new Promise(resolve => setImmediate(resolve));
  await page.onQueryDateChange(input('2026-09-21'));
  pending.resolve(dayResult({ records: [{ _id: 'old-day', duration: 99 }], totalDuration: 99 }));
  await first;
  assert.equal(page.data.queryDate, '2026-09-21');
  assert.equal(page.data.dayRecords[0]._id, 'new-day');
  assert.equal(page.data.dayTotalDuration, 12);
  assert.equal(page.data.dayRecordsLoading, false);
  await page.onQueryDateChange(input('2026-09-21'));
  assert.equal(requests(calls, 'adminGetDayRecords').length, 2, 'selecting the same date does not repeat the request');
});

test('switching between same-name users ignores a delayed response from the previous account', async () => {
  const pending = deferred();
  const { page } = await openQuery({ api: (name, data) => {
    if (data.type === 'adminSearchUsers') return success({ users: [USER, OTHER_USER], nextCursor: null });
    if (data.type === 'adminGetDayRecords') return data.openid === USER.openid ? pending.promise
      : dayResult({ user: OTHER_USER, records: [{ _id: 'selected-user-record', duration: 18 }], totalDuration: 18 });
  } });
  await search(page);
  const first = page.onQueryUserChange(input('0'));
  await page.onQueryUserChange(input('1'));
  pending.resolve(failure('旧用户读取失败'));
  await first;
  assert.equal(page.data.selectedQueryUser.openid, OTHER_USER.openid);
  assert.equal(page.data.dayRecords[0]._id, 'selected-user-record');
  assert.equal(page.data.dayTotalDuration, 18);
  assert.equal(page.data.dayRecordsError, '');
  assert.equal(page.data.dayRecordsLoading, false);
});

test('hiding or unloading clears query data and prevents pending searches and details from repopulating it', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    for (const pendingType of ['adminSearchUsers', 'adminGetDayRecords']) {
      const pending = deferred();
      const { page, timers } = await openQuery({ api: (name, data) => data.type === pendingType ? pending.promise : undefined });
      const loading = search(page);
      await new Promise(resolve => setImmediate(resolve));
      page[lifecycle]();
      assertQueryCleared(page);
      const hidden = JSON.stringify(page.data);
      pending.resolve(pendingType === 'adminSearchUsers' ? success({ users: [USER] }) : dayResult({ records: [{ _id: 'hidden', duration: 50 }], totalDuration: 50 }));
      await loading;
      assert.equal(JSON.stringify(page.data), hidden);
      assert.equal(timers.size, 0);
    }
  }
});

test('switching tabs clears query data and late authorization errors cannot revoke the active tab', async () => {
  const pending = deferred();
  const { page, calls } = await openQuery({ api: (name, data) => data.type === 'adminGetDayRecords' ? pending.promise : undefined });
  const loading = search(page);
  await new Promise(resolve => setImmediate(resolve));
  await page.onTabChange(tab('team'));
  assertQueryCleared(page);
  pending.resolve({ success: false, code: 'FORBIDDEN', error: '旧查询已失效' });
  await loading;
  assert.equal(page.data.tab, 'team');
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.accessError, '');
  await page.onTabChange(tab('query'));
  assert.equal(requests(calls, 'getAccess').length, 3, 'returning rechecks query access');
  assert.equal(page.data.queryDate, DATE);
  assert.equal(page.data.queryUsers.length, 0);
});

test('revoked permission during either query endpoint clears sensitive results and blocks further queries', async () => {
  for (const deniedType of ['adminSearchUsers', 'adminGetDayRecords']) {
    let deny = false;
    const { page, calls, timers } = await openQuery({ api: (name, data) => deny && data.type === deniedType
      ? { success: false, code: 'FORBIDDEN', error: '查询权限已撤销' } : undefined });
    await search(page);
    deny = true;
    if (deniedType === 'adminSearchUsers') await page.searchRecordUsers();
    else await page.loadDayRecords();
    assert.equal(page.data.authorized, false);
    assert.match(page.data.accessError, /查询权限已撤销/);
    assertQueryCleared(page);
    const count = calls.cloud.length;
    await page.searchRecordUsers();
    await page.loadDayRecords();
    assert.equal(calls.cloud.length, count);
    assert.equal(timers.size, 0);
  }
});

test('legacy query actions show the adminManager deployment message and can be retried after an update', async () => {
  for (const pendingType of ['adminSearchUsers', 'adminGetDayRecords']) {
    for (const legacyMessage of [`未知操作: ${pendingType}`, '未知的操作类型']) {
      let legacy = true;
      const { page } = await openQuery({ api: (name, data) => legacy && data.type === pendingType ? failure(legacyMessage) : undefined });
      await search(page);
      assert.equal(page.data.authorized, true);
      assert.equal(pendingType === 'adminSearchUsers' ? page.data.queryError : page.data.dayRecordsError, '管控服务尚未更新，请先部署 adminManager 云函数');
      legacy = false;
      await page.refreshTab();
      assert.equal(page.data.queryError, '');
      assert.equal(page.data.dayRecordsError, '');
      assert.equal(page.data.dayRecordsLoaded, true);
    }
  }
});

test('failed searches and day requests release loading state and support refresh retries', async () => {
  for (const pendingType of ['adminSearchUsers', 'adminGetDayRecords']) {
    let fail = true;
    const { page, calls } = await openQuery({ api: (name, data) => {
      if (fail && data.type === pendingType) throw new Error('网络暂时不可用');
    } });
    await search(page);
    assert.equal(pendingType === 'adminSearchUsers' ? page.data.queryError : page.data.dayRecordsError, '网络暂时不可用');
    assert.equal(page.data.queryLoading, false);
    assert.equal(page.data.dayRecordsLoading, false);
    fail = false;
    await page.onPullDownRefresh();
    assert.equal(page.data.dayRecordsLoaded, true);
    assert.equal(page.data.queryError, '');
    assert.equal(page.data.dayRecordsError, '');
    assert.equal(calls.refresh.length, 1);
    assert.equal(requests(calls, pendingType).length, 2);
  }
});
