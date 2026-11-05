const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/memberRecords/memberRecords.js');
const success = data => ({ result: { success: true, data } });
const record = (id, value = 3, date = '2026-09-18') => ({ _id: id, date, value, timestamp: Date.parse(`${date}T01:30:00+08:00`) });
const data = (records = [record('1')], nextCursor = null) => ({ member: { openid: 'bijing_member_2', nickname: '同学' },
  practiceType: 'kindness', unit: '件', startDate: '2026-09-01', records, nextCursor });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function createPage({ cloud, query } = {}) {
  let definition;
  let account = 'viewer';
  let binding = { studentNumber: 'BJ001', bindingVersion: 'v1' };
  const calls = [];
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name.endsWith('/teamGateway.js')) return { getViewerKey(teamId) {
        return /^bijing_/.test(teamId) ? JSON.stringify([account, binding && binding.studentNumber, binding && binding.bindingVersion]) : account;
      }, callTeam(type, requestData) {
        calls.push(structuredClone({ name: 'teamManager', data: { type, data: requestData } }));
        return cloud ? cloud(requestData, calls.length) : Promise.resolve(success(data()));
      } };
      if (name.endsWith('/dateUtil.js')) return { getBusinessDate: () => '2026-09-19' };
      if (name.endsWith('/practicePreferences.js')) return require('../miniprogram/utils/practicePreferences.js');
      throw new Error(name);
    },
    Page(value) { definition = value; },
    wx: { getStorageSync: () => account, stopPullDownRefresh() {}, cloud: { callFunction(request) {
      calls.push(structuredClone(request));
      return cloud ? cloud(request.data.data, calls.length) : Promise.resolve(success(data()));
    } } }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  page.onLoad(query || { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', month: '2026-09' });
  return { page, calls, setAccount(value) { account = value; }, setBinding(value) { binding = value; } };
}

test('member records preserve practice quantity and paginate with opaque cursors without duplicate entries', async () => {
  const { page, calls } = createPage({ cloud: (_, count) => success(count === 1
    ? data([record('1')], 'page-two') : data([record('1'), record('2', 4)])) });
  await page.onShow();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.unit, '件');
  assert.equal(page.data.practiceTypeName, '日行一善');
  assert.equal(page.data.totalValueLabel, '3');
  assert.equal(page.data.records[0].timeLabel, '01:30');
  assert.deepEqual(calls[0].data.data, { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', month: '2026-09', limit: 100 });
  await page.loadMore();
  assert.equal(calls[1].data.data.cursor, 'page-two');
  assert.equal(page.data.records.length, 2);
  assert.equal(page.data.totalValueLabel, '7');
  assert.equal(page.data.nextCursor, null);
});

test('changing the selected day discards an older in-flight period and retries only the new scope', async () => {
  const old = deferred();
  const { page, calls } = createPage({ query: { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', date: '2026-09-18' },
    cloud: (_, count) => count === 1 ? old.promise : success(data([record('new', 2, '2026-09-17')])) });
  const pending = page.onShow();
  await page.changePeriod({ detail: { value: '2026-09-17' } });
  old.resolve(success(data([record('old')])));
  await pending;
  assert.equal(page.data.records[0]._id, 'new');
  assert.equal(calls[1].data.data.date, '2026-09-17');
  assert.equal('month' in calls[1].data.data, false);
});

test('member records reject another member or period and clear records after an account switch', async () => {
  for (const invalid of [{ ...data(), member: { openid: 'different' } }, data([record('wrong-day', 1, '2026-08-01')])]) {
    const { page } = createPage({ cloud: () => success(invalid) });
    await page.onShow();
    assert.match(page.data.loadError, /暂不完整/);
    assert.equal(page.data.records.length, 0);
  }
  const later = deferred();
  const { page, setAccount } = createPage({ cloud: (_, count) => count === 1 ? success(data([record('1')], 'next')) : later.promise });
  await page.onShow();
  const pending = page.loadMore();
  setAccount('other-viewer');
  later.resolve(success(data([record('2')])));
  await pending;
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.isLoadingMore, false);
  assert.match(page.data.loadError, /登录状态/);
});

test('a failed later page preserves existing rows and lets the user retry its cursor', async () => {
  const { page, calls } = createPage({ cloud: (_, count) => count === 1 ? success(data([record('1')], 'next'))
    : count === 2 ? { result: { success: false, error: '请求失败' } } : success(data([record('2')])) });
  await page.onShow();
  await page.loadMore();
  assert.equal(page.data.records.length, 1);
  assert.equal(page.data.moreError, '请求失败');
  await page.loadMore();
  assert.equal(calls[2].data.data.cursor, 'next');
  assert.equal(page.data.records.length, 2);
});

test('repeated cursors are rejected and hidden pages ignore late records', async () => {
  const { page } = createPage({ cloud: () => success(data([record('1')], 'same')) });
  await page.onShow();
  await page.loadMore();
  assert.match(page.data.moreError, /暂不完整/);
  const old = deferred();
  const hidden = createPage({ cloud: () => old.promise });
  const pending = hidden.page.onShow();
  hidden.page.onHide();
  old.resolve(success(data()));
  await pending;
  assert.equal(hidden.page.data.records.length, 0);
  assert.equal(hidden.page.data.isLoading, false);
});

test('invalidated member cursors restart the selected period without mixing old and new records', async () => {
  for (const scope of [{ month: '2026-09' }, { date: '2026-09-18' }]) {
    const replacement = deferred();
    const { page, calls } = createPage({ query: { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', ...scope },
      cloud: (_, count) => count === 1 ? success(data([record('old')], 'obsolete'))
        : count === 2 ? { result: { success: false, error: '分页游标无效或团队规则已变更' } } : replacement.promise });
    await page.onShow();
    const pending = page.loadMore();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    assert.equal(calls.length, 3);
    assert.equal(calls[1].data.data.cursor, 'obsolete');
    assert.deepEqual(calls[2].data.data, { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', ...scope, limit: 100 });
    assert.equal(page.data.records.length, 0);
    assert.equal(page.data.nextCursor, null);
    replacement.resolve(success(data([record('new', 5)], 'fresh')));
    await pending;
    assert.deepEqual(Array.from(page.data.records, item => item._id), ['new']);
    assert.equal(page.data.totalValueLabel, '5');
    assert.equal(page.data.nextCursor, 'fresh');
    assert.equal(page.data.moreError, '');
  }
});

test('cursor recovery stops after one first-page retry and exposes a recoverable load error', async () => {
  const { page, calls } = createPage({ cloud: (_, count) => count === 1 ? success(data([record('old')], 'obsolete'))
    : { result: { success: false, error: '团队规则已变更' } } });
  await page.onShow();
  await page.loadMore();
  assert.equal(calls.length, 3);
  assert.equal('cursor' in calls[2].data.data, false);
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.loadError, '团队规则已变更');
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.isLoadingMore, false);
});

test('returning to member records after rebinding reloads the same period and clears the former profile', async () => {
  const refreshed = deferred();
  const { page, calls, setBinding } = createPage({ cloud: (_, count) => count === 1
    ? success({ ...data([record('owner-a')]), member: { openid: 'bijing_member_2', nickname: '原成员', avatarUrl: 'https://data.example/old.png' } })
    : refreshed.promise });
  await page.onShow();
  page.onHide();
  setBinding({ studentNumber: 'BJ002', bindingVersion: 'v2' });
  const loading = page.onShow();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.data.month, '2026-09');
  assert.equal('cursor' in calls[1].data.data, false);
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.memberName, '团队成员');
  assert.equal(page.data.memberAvatar, '/images/avatar.png');
  assert.equal(page.data.startDate, '');
  refreshed.resolve(success(data([record('owner-b')])));
  await loading;
  assert.deepEqual(Array.from(page.data.records, item => item._id), ['owner-b']);
});

test('a member-record append received after same-account rebinding discards records and profile', async () => {
  const more = deferred();
  const { page, setBinding } = createPage({ cloud: (_, count) => count === 1
    ? success(data([record('owner-a')], 'old-cursor')) : more.promise });
  await page.onShow();
  const loading = page.loadMore();
  setBinding({ studentNumber: 'BJ002', bindingVersion: 'v2' });
  more.resolve(success(data([record('old-late-record')])));
  await loading;
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.memberName, '团队成员');
  assert.equal(page.data.memberAvatar, '/images/avatar.png');
  assert.equal(page.data.startDate, '');
  assert.equal(page.data.isLoadingMore, false);
  assert.match(page.data.loadError, /账号或绑定已变化/);
});

test('member records keep selected homework across paging and period changes and reject a mismatched response', async () => {
  const { page, calls } = createPage({ query: { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', month: '2026-09', practiceType: 'kindness' },
    cloud: (_, count) => success(count === 1 ? data([record('1')], 'kindness-cursor') : data([record('2')])) });
  await page.onShow();
  await page.loadMore();
  await page.changePeriod({ detail: { value: '2026-08' } });
  assert.ok(calls.every(call => call.data.data.practiceType === 'kindness'));
  const mismatch = createPage({ query: { teamId: 'bijing_1', memberOpenid: 'bijing_member_2', month: '2026-09', practiceType: 'walking' } });
  await mismatch.page.onShow();
  assert.match(mismatch.page.data.loadError, /暂不完整/);
  assert.equal(mismatch.page.data.records.length, 0);
});
