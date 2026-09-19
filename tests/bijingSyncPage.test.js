const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil');

const pageSource = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/me/me.js'), 'utf8');
const pageTemplate = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/me/me.wxml'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/bijingApi.js'), 'utf8');

function previewResult(date, overrides = {}) {
  return { success: true, data: {
    date,
    records: [{ id: 'record-1', timestamp: Date.parse(`${date}T08:30:00+08:00`), duration: 20 }],
    count: 1, totalDuration: 20, syncDuration: 20, alreadySynced: false,
    ...overrides
  } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createPage({ now = '2026-09-17T04:05:00+08:00', loggedIn = true, bound = true, sync, preview } = {}) {
  let currentTime = Date.parse(now);
  let isLoggedIn = loggedIn;
  let definition;
  const calls = { check: [], bind: [], sync: [], preview: [], cloud: [], toast: [], loading: [], hideLoading: 0 };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const mocks = {
    '../../utils/badgeManager': {},
    '../../utils/checkin.js': { isUserLoggedIn: () => isLoggedIn },
    '../../utils/dateUtil.js': dateUtil,
    '../../utils/contentSec.js': {},
    '../../utils/bijingApi.js': {
      checkBijing: async studentNumber => {
        calls.check.push(studentNumber);
        return { success: true, data: { studentNumber, nickname: '必经学员' } };
      },
      bindBijing: async studentNumber => {
        calls.bind.push(studentNumber);
        return { success: true, data: { studentNumber } };
      },
      getBijingSyncDateDetails: async (...args) => {
        calls.preview.push(args);
        return preview ? preview(...args) : previewResult(args[0]);
      },
      syncBijingDate: async (...args) => {
        calls.sync.push(args);
        return sync ? sync(...args) : { success: true, data: { success: true, duration: 20 } };
      }
    },
    '../../utils/cloudApi.js': { callCloudFunction: (...args) => calls.cloud.push(args) }
  };
  vm.runInNewContext(pageSource, {
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    Page: value => { definition = value; },
    Date: Clock,
    console,
    wx: {
      showToast: value => calls.toast.push(value),
      showLoading: value => calls.loading.push(value),
      hideLoading: () => { calls.hideLoading++; }
    }
  });
  const page = {
    ...definition,
    data: { ...definition.data, bijingBound: bound },
    setData(values) { Object.assign(this.data, values); }
  };
  return {
    page, calls,
    setNow(value) { currentTime = Date.parse(value); },
    setLoggedIn(value) { isLoggedIn = value; }
  };
}

test('binding rejects lowercase, mixed-case and missing BJ prefixes before validation or confirmation', async () => {
  for (const bound of [false, true]) {
    for (const value of ['bj2407159', 'Bj2407159', 'bJ2407159', '2407159', 'ABJ2407159', ' bj2407159 ']) {
      const { page, calls } = createPage({ bound });
      page.onBijingInput({ detail: { value } });
      await page.confirmBindBijing();
      assert.equal(calls.toast.at(-1).title, '学号必须以大写 BJ 开头');
      assert.equal(calls.check.length, 0);
      assert.equal(calls.bind.length, 0);
      assert.equal(calls.loading.length, 0);
      assert.equal(page.data.bijingShowConfirm, false);
      assert.equal(page.data.bijingBound, bound);
    }
  }
});

test('uppercase BJ numbers are trimmed and bound only after confirmation for first binding and rebinding', async () => {
  for (const bound of [false, true]) {
    const { page, calls } = createPage({ bound });
    page.data.bijingStudentNumber = bound ? 'BJ2407000' : '';
    page.onBijingInput({ detail: { value: ' BJ2407159 ' } });
    await page.confirmBindBijing();
    assert.deepEqual(calls.check, ['BJ2407159']);
    assert.equal(page.data.bijingShowConfirm, true);
    assert.equal(page.data.bijingConfirmSn, 'BJ2407159');
    assert.equal(calls.bind.length, 0);
    await page.confirmBindConfirm();
    assert.deepEqual(calls.bind, ['BJ2407159']);
    assert.equal(page.data.bijingStudentNumber, 'BJ2407159');
    assert.equal(page.data.bijingBound, true);
  }
});

test('recent completed sync dates turn over at Beijing 04:00 with accurate calendar-day labels', () => {
  for (const [now, expected, beforeCutoff] of [
    ['2026-09-17T00:00:00+08:00', ['2026-09-15', '2026-09-14', '2026-09-13'], true],
    ['2026-09-17T03:59:59.999+08:00', ['2026-09-15', '2026-09-14', '2026-09-13'], true],
    ['2026-09-17T04:00:00+08:00', ['2026-09-16', '2026-09-15', '2026-09-14'], false],
    ['2026-03-01T00:00:00+08:00', ['2026-02-27', '2026-02-26', '2026-02-25'], true],
    ['2026-03-01T04:00:00+08:00', ['2026-02-28', '2026-02-27', '2026-02-26'], false],
    ['2024-03-01T03:59:59+08:00', ['2024-02-28', '2024-02-27', '2024-02-26'], true],
    ['2024-03-01T04:00:00+08:00', ['2024-02-29', '2024-02-28', '2024-02-27'], false],
    ['2026-01-01T00:00:00+08:00', ['2025-12-30', '2025-12-29', '2025-12-28'], true],
    ['2026-01-01T04:00:00+08:00', ['2025-12-31', '2025-12-30', '2025-12-29'], false]
  ]) {
    const { page } = createPage({ now });
    const options = page.getBijingSyncDateOptions();
    assert.deepEqual(Array.from(options, option => option.date), expected, now);
    assert.deepEqual(Array.from(options, option => option.label),
      beforeCutoff ? ['前天', '大前天', '4天前'] : ['昨天', '前天', '大前天'], now);
  }
});

test('opening and canceling the picker never syncs; confirmation submits only the selected date', async () => {
  const { page, calls } = createPage();
  await page.syncBijingNow();
  assert.equal(page.data.bijingShowSyncDatePicker, true);
  assert.equal(page.data.bijingSyncDate, '2026-09-16');
  page.cancelBijingSyncDate();
  assert.equal(page.data.bijingShowSyncDatePicker, false);
  assert.equal(calls.sync.length, 0);
  assert.equal(calls.cloud.length, 0);
  await page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
  assert.equal(calls.sync.length, 0);
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-09-15']]);
  assert.equal(page.data.bijingShowSyncDatePicker, false);
});

test('opening and confirmation require both login and a bound student number', async () => {
  for (const settings of [{ loggedIn: false }, { bound: false }]) {
    const { page, calls } = createPage(settings);
    page.syncBijingNow();
    assert.equal(page.data.bijingShowSyncDatePicker, false);
    assert.match(calls.toast.at(-1).title, settings.loggedIn === false ? /请先登录/ : /请先绑定学号/);
    page.data.bijingSyncDate = '2026-09-16';
    await page.confirmBijingSyncDate();
    assert.match(calls.toast.at(-1).title, /请先登录并绑定学号/);
    assert.equal(calls.sync.length, 0);
    assert.equal(calls.preview.length, 0);
    assert.equal(calls.loading.length, 0);
  }
  const { page, calls, setLoggedIn } = createPage();
  await page.syncBijingNow();
  setLoggedIn(false);
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 0, 'login may expire while the picker is open');
});

test('invalid selection events are ignored and tampered dates cannot reach the API', async () => {
  for (const invalid of ['2026-09-17', '2026-09-13', '2026-09-18', 'invalid', '']) {
    const { page, calls } = createPage();
    await page.syncBijingNow();
    page.onBijingSyncDateChange({ detail: { value: invalid } });
    assert.equal(page.data.bijingSyncDate, '2026-09-16');
    assert.equal(calls.preview.length, 1);
    page.data.bijingSyncDate = invalid;
    await page.confirmBijingSyncDate();
    assert.equal(calls.sync.length, 0);
    assert.equal(calls.loading.length, 0);
    assert.equal(page.data.bijingSyncDate, '2026-09-16');
    assert.equal(page.data.bijingShowSyncDatePicker, true);
    assert.match(calls.toast.at(-1).title, /可选日期已更新/);
  }
});

test('crossing Beijing midnight keeps the same completed sync dates available', async () => {
  const { page, calls, setNow } = createPage({ now: '2026-12-31T23:59:59+08:00' });
  await page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-12-28' } });
  setNow('2027-01-01T00:00:01+08:00');
  await page.retryBijingSyncDetails();
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.date),
    ['2026-12-30', '2026-12-29', '2026-12-28']);
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.label),
    ['前天', '大前天', '4天前']);
  assert.equal(page.data.bijingSyncDate, '2026-12-28');
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-12-28']]);
});

test('crossing Beijing 04:00 refreshes an expired selection across year and month boundaries', async () => {
  for (const [before, after, oldest, expected] of [
    ['2027-01-01T03:59:59+08:00', '2027-01-01T04:00:00+08:00', '2026-12-28', ['2026-12-31', '2026-12-30', '2026-12-29']],
    ['2026-03-01T03:59:59+08:00', '2026-03-01T04:00:00+08:00', '2026-02-25', ['2026-02-28', '2026-02-27', '2026-02-26']]
  ]) {
    const { page, calls, setNow } = createPage({ now: before });
    await page.syncBijingNow();
    await page.onBijingSyncDateChange({ detail: { value: oldest } });
    setNow(after);
    await page.confirmBijingSyncDate();
    assert.equal(calls.sync.length, 0);
    assert.equal(page.data.bijingSyncDate, expected[0]);
    assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.date), expected);
    assert.equal(page.data.bijingShowSyncDatePicker, true);
    assert.deepEqual(calls.preview.at(-1), [expected[0]]);
  }
});

test('an in-flight sync blocks duplicate confirmation and reopening, then releases its lock', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { page, calls } = createPage({ sync: () => pending });
  await page.syncBijingNow();
  const first = page.confirmBijingSyncDate();
  assert.equal(page.data.bijingSyncing, true);
  await page.syncBijingNow();
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 1);
  assert.equal(page.data.bijingShowSyncDatePicker, false);
  resolve({ success: true, data: { success: true, duration: 12 } });
  await first;
  assert.equal(page.data.bijingSyncing, false);
  assert.equal(calls.hideLoading, 1);
  await page.syncBijingNow();
  assert.equal(page.data.bijingShowSyncDatePicker, true);
});

test('success, skipped responses, no records and failures report the selected date and clear loading', async () => {
  const cases = [
    [{ success: true, data: { success: true, duration: 35 } }, /已同步 35 分钟/],
    [{ success: true, data: { skipped: true, reason: '已同步' } }, /此前已同步，本次未更新/],
    [{ success: true, data: { skipped: true, duration: 0 } }, /暂无打卡记录/],
    [{ success: false, error: '服务不可用' }, /同步失败：服务不可用/],
    [{ success: true, data: { error: '上传失败' } }, /同步失败：上传失败/],
    [new Error('连接中断'), /同步失败：连接中断/]
  ];
  for (const [result, feedback] of cases) {
    const { page, calls } = createPage({ sync: () => {
      if (result instanceof Error) throw result;
      return result;
    } });
    await page.syncBijingNow();
    await page.onBijingSyncDateChange({ detail: { value: '2026-09-14' } });
    await page.confirmBijingSyncDate();
    assert.match(page.data.bijingLastSync, /^2026-09-14 /);
    assert.match(page.data.bijingLastSync, feedback);
    assert.equal(calls.toast.at(-1).title, page.data.bijingLastSync);
    assert.equal(calls.loading.length, 1);
    assert.equal(calls.loading[0].mask, true);
    assert.equal(calls.hideLoading, 1);
    assert.equal(page.data.bijingSyncing, false);
  }
});

test('opening loads the default date preview and presents backend records, count and duration', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ preview: () => pending.promise });
  const opening = page.syncBijingNow();
  assert.deepEqual(calls.preview, [['2026-09-16']]);
  assert.equal(page.data.bijingSyncDetailsLoading, true);
  assert.equal(page.data.bijingSyncRecords.length, 0);
  assert.equal(calls.sync.length, 0);
  await page.confirmBijingSyncDate();
  assert.match(calls.toast.at(-1).title, /明细加载中/);
  assert.equal(calls.sync.length, 0);
  pending.resolve(previewResult('2026-09-16', {
    records: [
      { id: 'a', timestamp: Date.parse('2026-09-16T16:05:00Z'), duration: 11.234 },
      { id: 'b', timestamp: null, duration: 9.235 }
    ],
    count: 2, totalDuration: 20.469, syncDuration: 20, alreadySynced: true
  }));
  await opening;
  assert.equal(page.data.bijingSyncDetailsLoading, false);
  assert.equal(page.data.bijingSyncDetailsDate, '2026-09-16');
  assert.equal(page.data.bijingSyncRecordCount, 2);
  assert.equal(page.data.bijingSyncTotalDuration, 20.47);
  assert.equal(page.data.bijingSyncDuration, 20);
  assert.equal(page.data.bijingSyncAlreadySynced, true);
  assert.deepEqual(Array.from(page.data.bijingSyncRecords, record => [record.id, record.timeLabel, record.durationText]),
    [['a', '次日 00:05', 11.23], ['b', '时间未记录', 9.23]]);
  assert.equal(calls.sync.length, 0);
});

test('switching dates clears the old preview and selecting the same date avoids a duplicate read', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ preview: date => date === '2026-09-16'
    ? previewResult(date, { alreadySynced: true }) : pending.promise });
  await page.syncBijingNow();
  const switching = page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
  assert.equal(page.data.bijingSyncDetailsLoading, true);
  assert.equal(page.data.bijingSyncDetailsDate, '');
  assert.equal(page.data.bijingSyncRecords.length, 0);
  assert.equal(page.data.bijingSyncRecordCount, 0);
  assert.equal(page.data.bijingSyncTotalDuration, 0);
  assert.equal(page.data.bijingSyncDuration, 0);
  assert.equal(page.data.bijingSyncAlreadySynced, false);
  page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
  assert.deepEqual(calls.preview, [['2026-09-16'], ['2026-09-15']]);
  pending.resolve(previewResult('2026-09-15', { totalDuration: 17, syncDuration: 17 }));
  await switching;
  assert.equal(page.data.bijingSyncDetailsDate, '2026-09-15');
  assert.equal(page.data.bijingSyncTotalDuration, 17);
  assert.equal(calls.sync.length, 0);
});

test('stale preview success or failure cannot clear loading or replace the newest selection', async () => {
  for (const staleFails of [false, true]) {
    const old = deferred();
    const newest = deferred();
    const { page, calls } = createPage({ preview: date => date === '2026-09-16' ? old.promise : newest.promise });
    const opening = page.syncBijingNow();
    const switching = page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
    if (staleFails) old.reject(new Error('旧请求失败'));
    else old.resolve(previewResult('2026-09-16'));
    await opening;
    assert.equal(page.data.bijingSyncDetailsLoading, true);
    assert.equal(page.data.bijingSyncDetailsError, '');
    assert.equal(page.data.bijingSyncDetailsDate, '');
    newest.resolve(previewResult('2026-09-15'));
    await switching;
    assert.equal(page.data.bijingSyncDetailsDate, '2026-09-15');
    assert.equal(page.data.bijingSyncDetailsLoading, false);
    assert.equal(calls.sync.length, 0);
  }
});

test('a slow older preview cannot overwrite a newer completed preview', async () => {
  const old = deferred();
  const { page } = createPage({ preview: date => date === '2026-09-16' ? old.promise : previewResult(date) });
  const opening = page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
  old.resolve(previewResult('2026-09-16', { count: 99, totalDuration: 99 }));
  await opening;
  assert.equal(page.data.bijingSyncDetailsDate, '2026-09-15');
  assert.equal(page.data.bijingSyncRecordCount, 1);
  assert.equal(page.data.bijingSyncTotalDuration, 20);
  assert.equal(page.data.bijingSyncDetailsError, '');
});

test('canceling and reopening the same date invalidates the original pending preview', async () => {
  const old = deferred();
  const latest = deferred();
  let request = 0;
  const { page, calls } = createPage({ preview: () => ++request === 1 ? old.promise : latest.promise });
  const opening = page.syncBijingNow();
  page.cancelBijingSyncDate();
  assert.equal(page.data.bijingSyncDetailsLoading, false);
  const reopening = page.syncBijingNow();
  old.resolve(previewResult('2026-09-16', { count: 99 }));
  await opening;
  assert.equal(page.data.bijingSyncDetailsLoading, true);
  assert.equal(page.data.bijingSyncRecordCount, 0);
  latest.resolve(previewResult('2026-09-16'));
  await reopening;
  assert.equal(page.data.bijingSyncRecordCount, 1);
  assert.equal(calls.sync.length, 0);
});

test('closing, hiding or unloading prevents a pending preview from writing page data', async () => {
  for (const action of ['cancelBijingSyncDate', 'onHide', 'onUnload']) {
    const pending = deferred();
    const { page } = createPage({ preview: () => pending.promise });
    const opening = page.syncBijingNow();
    page[action]();
    const data = JSON.stringify(page.data);
    pending.resolve(previewResult('2026-09-16'));
    await opening;
    assert.equal(JSON.stringify(page.data), data, action);
  }
});

test('preview failures block sync, allow retry, and clear the error after recovery', async () => {
  for (const failure of [{ success: false, error: '服务暂不可用' }, new Error('网络断开')]) {
    let shouldFail = true;
    const { page, calls } = createPage({ preview: date => {
      if (!shouldFail) return previewResult(date);
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    await page.syncBijingNow();
    assert.equal(page.data.bijingSyncDetailsLoading, false);
    assert.match(page.data.bijingSyncDetailsError, /服务暂不可用|网络断开/);
    assert.equal(page.data.bijingSyncRecords.length, 0);
    await page.confirmBijingSyncDate();
    assert.match(calls.toast.at(-1).title, /请先重试/);
    assert.equal(calls.sync.length, 0);
    shouldFail = false;
    await page.retryBijingSyncDetails();
    assert.deepEqual(calls.preview, [['2026-09-16'], ['2026-09-16']]);
    assert.equal(page.data.bijingSyncDetailsError, '');
    assert.equal(page.data.bijingSyncDetailsDate, '2026-09-16');
    await page.confirmBijingSyncDate();
    assert.deepEqual(calls.sync, [['2026-09-16']]);
  }
});

test('retry is ignored while preview is loading or the date picker is closed', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ preview: () => pending.promise });
  page.retryBijingSyncDetails();
  assert.equal(calls.preview.length, 0);
  const opening = page.syncBijingNow();
  page.retryBijingSyncDetails();
  assert.equal(calls.preview.length, 1);
  page.cancelBijingSyncDate();
  page.retryBijingSyncDetails();
  assert.equal(calls.preview.length, 1);
  pending.resolve(previewResult('2026-09-16'));
  await opening;
});

test('retry after Beijing 04:00 replaces an expired date and loads the refreshed default preview', async () => {
  const { page, calls, setNow } = createPage({
    now: '2027-01-01T03:59:59+08:00',
    preview: date => date === '2026-12-28' ? { success: false, error: '读取失败' } : previewResult(date)
  });
  await page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-12-28' } });
  assert.equal(page.data.bijingSyncDetailsError, '读取失败');
  setNow('2027-01-01T04:00:00+08:00');
  await page.retryBijingSyncDetails();
  assert.equal(page.data.bijingSyncDate, '2026-12-31');
  assert.equal(page.data.bijingSyncDetailsDate, '2026-12-31');
  assert.equal(page.data.bijingSyncDetailsError, '');
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.date),
    ['2026-12-31', '2026-12-30', '2026-12-29']);
  assert.deepEqual(calls.preview.at(-1), ['2026-12-31']);
  assert.equal(calls.sync.length, 0);
});

test('empty and zero-minute previews prevent sync requests', async () => {
  for (const [details, message] of [
    [{ records: [], count: 0, totalDuration: 0, syncDuration: 0 }, /暂无可同步/],
    [{ totalDuration: 0.4, syncDuration: 0 }, /暂无可同步/]
  ]) {
    const { page, calls } = createPage({ preview: date => previewResult(date, details) });
    await page.syncBijingNow();
    await page.confirmBijingSyncDate();
    assert.match(calls.toast.at(-1).title, message);
    assert.equal(calls.sync.length, 0);
    assert.equal(calls.loading.length, 0);
    assert.equal(page.data.bijingShowSyncDatePicker, true);
  }
});

test('already-synced dates keep the submit button enabled and can be submitted repeatedly', async () => {
  const { page, calls } = createPage({ preview: date => previewResult(date, { alreadySynced: true }) });
  const button = pageTemplate.match(/<button\b[^>]*bindtap="confirmBijingSyncDate"[^>]*>/)[0];
  const disabledExpression = button.match(/disabled="\{\{([\s\S]*?)\}\}"/)[1];
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.syncBijingNow();
    assert.equal(page.data.bijingSyncAlreadySynced, true);
    assert.equal(vm.runInNewContext(disabledExpression, { ...page.data }), false);
    await page.confirmBijingSyncDate();
    assert.equal(page.data.bijingSyncing, false);
    assert.match(calls.toast.at(-1).title, /2026-09-16 已同步 20 分钟/);
  }
  assert.deepEqual(calls.sync, [['2026-09-16'], ['2026-09-16']]);
  assert.equal(calls.hideLoading, 2);
});

test('malformed or mismatched preview dates cannot authorize a sync', async () => {
  for (const details of [{ date: '2026-09-15' }, { records: null }]) {
    const { page, calls } = createPage({ preview: date => previewResult(date, details) });
    await page.syncBijingNow();
    assert.match(page.data.bijingSyncDetailsError, /获取明细失败/);
    assert.equal(page.data.bijingSyncDetailsLoading, false);
    await page.confirmBijingSyncDate();
    assert.equal(calls.sync.length, 0);
  }
  const { page, calls } = createPage();
  await page.syncBijingNow();
  page.data.bijingSyncDate = '2026-09-15';
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 0);
  assert.match(calls.toast.at(-1).title, /请先重试/);
});

test('record times are formatted in Beijing time and missing/invalid timestamps have a fallback', () => {
  const { page } = createPage();
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-15T16:05:00Z')), '00:05');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-16T15:59:00Z')), '23:59');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-16T04:00:00+08:00'), '2026-09-16'), '04:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-16T23:59:00+08:00'), '2026-09-16'), '23:59');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-17T02:00:00+08:00'), '2026-09-16'), '次日 02:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-10-01T00:00:00+08:00'), '2026-09-30'), '次日 00:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2027-01-01T03:59:59+08:00'), '2026-12-31'), '次日 03:59');
  for (const timestamp of [null, undefined, '', '2026-09-16', 0, -1, NaN, Infinity]) {
    assert.equal(page.formatBijingSyncTime(timestamp), '时间未记录');
  }
});

test('API wrappers distinguish read-only getSyncDateDetails from syncSelectedDate and preserve recordDate', async () => {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(apiSource, {
    module,
    require(name) {
      assert.equal(name, './cloudApi.js');
      return { callCloudFunction: async (name, data) => {
        calls.push({ name, data: { ...data } });
        return { result: data.type === 'getSyncDateDetails' ? previewResult(data.recordDate)
          : { success: true, data: { success: true, duration: 5 } } };
      } };
    }
  });
  const preview = await module.exports.getBijingSyncDateDetails('2026-09-16');
  assert.equal(preview.success, true);
  assert.equal(preview.data.date, '2026-09-16');
  assert.equal(preview.data.count, 1);
  const response = await module.exports.syncBijingDate('2026-09-15');
  assert.deepEqual(calls, [
    { name: 'bijingSync', data: { type: 'getSyncDateDetails', recordDate: '2026-09-16' } },
    { name: 'bijingSync', data: { type: 'syncSelectedDate', recordDate: '2026-09-15' } }
  ]);
  assert.equal(response.success, true);
  assert.equal(response.data.duration, 5);
});
