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

function createPage({ now = '2026-09-17T04:05:00+08:00', loggedIn = true, bound = true, sync, preview, bind, check, unbind, modal, cloud, pending = 0, retry, pendingByDate, uploadingByDate = {} } = {}) {
  let currentTime = Date.parse(now);
  let isLoggedIn = loggedIn;
  let definition;
  const calls = { check: [], bind: [], unbind: [], modal: [], alerts: [], sync: [], preview: [], retry: [], summaries: [], cloud: [], toast: [], loading: [], hideLoading: 0 };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const storage = { userOpenId: loggedIn ? 'oz-test-account' : '' };
  const wxMock = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    showToast: value => calls.toast.push(value),
    showModal: value => { calls.modal.push(value); if (modal) modal(value); else value.success({ confirm: true }); },
    showLoading: value => calls.loading.push(value),
    hideLoading: () => { calls.hideLoading++; }
  };
  const profileCacheModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/profileCache.js'), 'utf8'), {
    wx: wxMock, module: profileCacheModule
  });
  const mocks = {
    '../../utils/profileCache.js': profileCacheModule.exports,
    '../../utils/badgeManager': {},
    '../../utils/checkin.js': {
      isUserLoggedIn: () => isLoggedIn,
      getPendingSyncSummary: (options = {}) => {
        calls.summaries.push(options);
        const count = pendingByDate ? (options.date ? pendingByDate[options.date] || 0
          : Object.values(pendingByDate).reduce((sum, value) => sum + value, 0)) : pending;
        const uploading = options.date ? uploadingByDate[options.date] || 0
          : Object.values(uploadingByDate).reduce((sum, value) => sum + value, 0);
        return { total: count + uploading, pending: count, uploading, failed: 0 };
      },
      retryPendingBackups: async options => {
        calls.retry.push(options);
        return retry ? retry(options) : { success: pending === 0, uploaded: 0, pending };
      }
    },
    '../../utils/dateUtil.js': dateUtil,
    '../../utils/contentSec.js': {},
    '../../utils/bijingApi.js': {
      checkBijing: async studentNumber => {
        calls.check.push(studentNumber);
        return check ? check(studentNumber) : { success: true, data: { studentNumber, nickname: '必经学员' } };
      },
      bindBijing: async studentNumber => {
        calls.bind.push(studentNumber);
        return bind ? bind(studentNumber) : { success: true, data: { studentNumber, bindingVersion: 'binding-new' } };
      },
      unbindBijing: async (...args) => {
        calls.unbind.push(args);
        return unbind ? unbind(...args) : { success: true, data: { studentNumber: args[0], bound: false } };
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
    '../../utils/cloudApi.js': { callCloudFunction: async (...args) => {
      calls.cloud.push(args);
      return cloud ? cloud(...args) : { result: { success: true, data: { isAdmin: true } } };
    } }
  };
  vm.runInNewContext(pageSource, {
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    Page: value => { definition = value; },
    getApp: () => ({ clearSyncAlert() { calls.alerts.push('clear'); }, refreshSyncAlert() { calls.alerts.push('refresh'); } }),
    Date: Clock,
    console,
    wx: wxMock
  });
  const page = {
    ...definition,
    data: { ...definition.data, bijingBound: bound, bijingStudentNumber: bound ? 'BJ2407000' : '', bijingBindingVersion: bound ? 'binding-old' : null },
    setData(values) { Object.assign(this.data, values); }
  };
  return {
    page, calls, storage,
    setNow(value) { currentTime = Date.parse(value); },
    setLoggedIn(value) { isLoggedIn = value; storage.userOpenId = value ? 'oz-test-account' : ''; },
    setPending(value) { pending = value; }
  };
}

test('cloud preview directs users to the home upload button without silently uploading pending records', async () => {
  const { page, calls, setPending } = createPage({ pending: 1 });
  await page.syncBijingNow();
  assert.equal(page.data.bijingSyncDetailsLoading, false);
  assert.equal(calls.retry.length, 0);
  assert.match(page.data.bijingSyncDetailsError, /首页.*手动上传/);
  assert.equal(calls.preview.length, 0);
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 0);
  setPending(0);
  await page.retryBijingSyncDetails();
  assert.equal(calls.preview.length, 1);
  assert.equal(page.data.bijingSyncDetailsError, '');
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 1);
});

test('local-only records block incomplete manual sync and can recover through the existing retry action', async () => {
  const { page, calls, setPending } = createPage({ pending: 2 });
  await page.syncBijingNow();
  assert.equal(calls.preview.length, 0);
  assert.match(page.data.bijingSyncDetailsError, /2 条记录仅保存在本机/);
  assert.equal(page.data.bijingSyncDetailsLoading, false);
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 0);
  setPending(0);
  await page.retryBijingSyncDetails();
  assert.equal(page.data.bijingSyncDetailsError, '');
  assert.equal(calls.preview.length, 1);
});

test('new pending records invalidate a preview both while loading and before confirmation', async () => {
  const response = deferred();
  const first = createPage({ preview: () => response.promise });
  const opening = first.page.syncBijingNow();
  first.setPending(1);
  response.resolve(previewResult('2026-09-16'));
  await opening;
  assert.match(first.page.data.bijingSyncDetailsError, /尚未上传/);
  assert.equal(first.page.data.bijingSyncRecordCount, 0);
  const second = createPage();
  await second.page.syncBijingNow();
  second.setPending(1);
  await second.page.confirmBijingSyncDate();
  assert.equal(second.calls.sync.length, 0);
  assert.match(second.calls.toast.at(-1).title, /待上传/);
  assert.equal(second.page.data.bijingShowSyncDatePicker, true);
});

test('an initial upload on the selected day blocks preview without starting a backup retry', async () => {
  const uploadingByDate = { '2026-09-16': 1 };
  const { page, calls } = createPage({ uploadingByDate });
  await page.syncBijingNow();
  assert.equal(calls.preview.length, 0);
  assert.equal(page.data.bijingSyncDetailsError, '当天记录正在上传，请稍后重试');
  assert.equal(page.data.bijingSyncDetailsLoading, false);
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 0);
  assert.equal(calls.retry.length, 0);
  assert.equal(calls.cloud.length, 0);

  uploadingByDate['2026-09-16'] = 0;
  await page.retryBijingSyncDetails();
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.preview, [['2026-09-16']]);
  assert.deepEqual(calls.sync, [['2026-09-16']]);
  assert.equal(calls.retry.length, 0);
});

test('an initial upload on the selected day invalidates loaded or in-flight previews', async () => {
  for (const stage of ['during preview', 'before confirmation']) {
    const response = deferred();
    const uploadingByDate = {};
    const { page, calls } = createPage({ uploadingByDate, preview: () => response.promise });
    const opening = page.syncBijingNow();
    if (stage === 'during preview') uploadingByDate['2026-09-16'] = 1;
    response.resolve(previewResult('2026-09-16'));
    await opening;
    if (stage === 'before confirmation') {
      assert.equal(page.data.bijingSyncRecordCount, 1);
      uploadingByDate['2026-09-16'] = 1;
    } else {
      assert.equal(page.data.bijingSyncRecordCount, 0);
    }
    await page.confirmBijingSyncDate();
    assert.equal(page.data.bijingSyncDetailsError, '当天记录正在上传，请稍后重试', stage);
    if (stage === 'before confirmation') {
      assert.equal(calls.toast.at(-1).title, '当天记录正在上传，请稍后重试');
    }
    assert.equal(page.data.bijingShowSyncDatePicker, true, stage);
    assert.equal(calls.sync.length, 0, stage);
    assert.equal(calls.retry.length, 0, stage);
    assert.equal(calls.cloud.length, 0, stage);
    assert.ok(calls.summaries.every(options => options.date === '2026-09-16'), stage);
  }
});

test('initial uploads on other dates do not block the selected sync day', async () => {
  const { page, calls } = createPage({ uploadingByDate: { '2026-09-15': 1 } });
  await page.syncBijingNow();
  assert.equal(page.data.bijingSyncDetailsError, '');
  assert.deepEqual(calls.preview, [['2026-09-16']]);
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-09-16']]);
  assert.equal(calls.retry.length, 0);
  assert.equal(calls.cloud.length, 0);
  assert.ok(calls.summaries.every(options => options.date === '2026-09-16'));
});

test('canceling a preview with pending records cannot initiate an upload or later reopen it', async () => {
  const { page, calls, setPending } = createPage({ pending: 1 });
  await page.syncBijingNow();
  page.cancelBijingSyncDate();
  const data = JSON.stringify(page.data);
  setPending(0);
  await page.retryBijingSyncDetails();
  assert.equal(calls.retry.length, 0);
  assert.equal(calls.preview.length, 0);
  assert.equal(JSON.stringify(page.data), data);
});

test('pending uploads on other dates do not block the selected sync day', async () => {
  const pendingByDate = { '2026-09-13': 1, '2026-09-15': 1 };
  const { page, calls } = createPage({ pendingByDate });
  await page.syncBijingNow();
  assert.equal(page.data.bijingSyncDetailsError, '');
  assert.equal(calls.retry.length, 0, 'an expired record on another day must not block this preview');
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-09-16']]);
  assert.ok(calls.summaries.every(options => options.date === '2026-09-16'));

  await page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-09-15' } });
  assert.equal(calls.retry.length, 0, 'selecting another day must not upload pending records');
  assert.match(page.data.bijingSyncDetailsError, /1 条记录仅保存在本机/);
  await page.confirmBijingSyncDate();
  assert.equal(calls.sync.length, 1);

  pendingByDate['2026-09-15'] = 0;
  await page.retryBijingSyncDetails();
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-09-16'], ['2026-09-15']]);
  assert.equal(pendingByDate['2026-09-13'], 1, 'unrelated failed uploads remain available for separate handling');
  assert.ok(calls.summaries.every(options => options.date), 'every preview and submission check must specify its selected date');
});

test('binding rejects lowercase, mixed-case and missing BJ prefixes before validation or confirmation', async () => {
  for (const bound of [false]) {
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

test('uppercase BJ numbers are trimmed and bound only after explicit confirmation', async () => {
  for (const bound of [false]) {
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

test('seven recent completed sync dates turn over at Beijing 02:00 with accurate calendar-day labels', () => {
  for (const [now, expected, beforeCutoff] of [
    ['2026-09-17T00:00:00+08:00', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09'], true],
    ['2026-09-17T01:59:59.999+08:00', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09'], true],
    ['2026-09-17T02:00:00+08:00', ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10'], false],
    ['2026-03-01T00:00:00+08:00', ['2026-02-27', '2026-02-26', '2026-02-25', '2026-02-24', '2026-02-23', '2026-02-22', '2026-02-21'], true],
    ['2026-03-01T02:00:00+08:00', ['2026-02-28', '2026-02-27', '2026-02-26', '2026-02-25', '2026-02-24', '2026-02-23', '2026-02-22'], false],
    ['2024-03-01T01:59:59+08:00', ['2024-02-28', '2024-02-27', '2024-02-26', '2024-02-25', '2024-02-24', '2024-02-23', '2024-02-22'], true],
    ['2024-03-01T02:00:00+08:00', ['2024-02-29', '2024-02-28', '2024-02-27', '2024-02-26', '2024-02-25', '2024-02-24', '2024-02-23'], false],
    ['2026-01-01T00:00:00+08:00', ['2025-12-30', '2025-12-29', '2025-12-28', '2025-12-27', '2025-12-26', '2025-12-25', '2025-12-24'], true],
    ['2026-01-01T02:00:00+08:00', ['2025-12-31', '2025-12-30', '2025-12-29', '2025-12-28', '2025-12-27', '2025-12-26', '2025-12-25'], false]
  ]) {
    const { page } = createPage({ now });
    const options = page.getBijingSyncDateOptions();
    assert.deepEqual(Array.from(options, option => option.date), expected, now);
    assert.deepEqual(Array.from(options, option => option.label),
      beforeCutoff ? ['前天', '大前天', '4天前', '5天前', '6天前', '7天前', '8天前'] : ['昨天', '前天', '大前天', '4天前', '5天前', '6天前', '7天前'], now);
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

test('each of the seven completed dates can be previewed and synced, including the oldest', async () => {
  for (const [now, dates] of [
    ['2026-09-17T01:59:59+08:00', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09']],
    ['2026-09-17T02:00:00+08:00', ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10']]
  ]) {
    for (const date of dates) {
      const { page, calls } = createPage({ now });
      await page.syncBijingNow();
      await page.onBijingSyncDateChange({ detail: { value: date } });
      assert.equal(page.data.bijingSyncDate, date);
      assert.equal(page.data.bijingSyncDetailsDate, date);
      assert.deepEqual(calls.preview.at(-1), [date]);
      await page.confirmBijingSyncDate();
      assert.deepEqual(calls.sync, [[date]]);
    }
  }
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
  for (const invalid of ['2026-09-17', '2026-09-09', '2026-09-18', 'invalid', '']) {
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
  await page.onBijingSyncDateChange({ detail: { value: '2026-12-24' } });
  setNow('2027-01-01T00:00:01+08:00');
  await page.retryBijingSyncDetails();
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.date),
    ['2026-12-30', '2026-12-29', '2026-12-28', '2026-12-27', '2026-12-26', '2026-12-25', '2026-12-24']);
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.label),
    ['前天', '大前天', '4天前', '5天前', '6天前', '7天前', '8天前']);
  assert.equal(page.data.bijingSyncDate, '2026-12-24');
  await page.confirmBijingSyncDate();
  assert.deepEqual(calls.sync, [['2026-12-24']]);
});

test('crossing Beijing 02:00 refreshes an expired selection across year and month boundaries', async () => {
  for (const [before, after, oldest, expected] of [
    ['2027-01-01T01:59:59+08:00', '2027-01-01T02:00:00+08:00', '2026-12-24', ['2026-12-31', '2026-12-30', '2026-12-29', '2026-12-28', '2026-12-27', '2026-12-26', '2026-12-25']],
    ['2026-03-01T01:59:59+08:00', '2026-03-01T02:00:00+08:00', '2026-02-21', ['2026-02-28', '2026-02-27', '2026-02-26', '2026-02-25', '2026-02-24', '2026-02-23', '2026-02-22']]
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

test('retry after Beijing 02:00 replaces an expired date and loads the refreshed default preview', async () => {
  const { page, calls, setNow } = createPage({
    now: '2027-01-01T01:59:59+08:00',
    preview: date => date === '2026-12-24' ? { success: false, error: '读取失败' } : previewResult(date)
  });
  await page.syncBijingNow();
  await page.onBijingSyncDateChange({ detail: { value: '2026-12-24' } });
  assert.equal(page.data.bijingSyncDetailsError, '读取失败');
  setNow('2027-01-01T02:00:00+08:00');
  await page.retryBijingSyncDetails();
  assert.equal(page.data.bijingSyncDate, '2026-12-31');
  assert.equal(page.data.bijingSyncDetailsDate, '2026-12-31');
  assert.equal(page.data.bijingSyncDetailsError, '');
  assert.deepEqual(Array.from(page.data.bijingSyncDateOptions, option => option.date),
    ['2026-12-31', '2026-12-30', '2026-12-29', '2026-12-28', '2026-12-27', '2026-12-26', '2026-12-25']);
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
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-16T02:00:00+08:00'), '2026-09-16'), '02:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-16T23:59:00+08:00'), '2026-09-16'), '23:59');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-09-17T02:00:00+08:00'), '2026-09-16'), '次日 02:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2026-10-01T00:00:00+08:00'), '2026-09-30'), '次日 00:00');
  assert.equal(page.formatBijingSyncTime(Date.parse('2027-01-01T01:59:59+08:00'), '2026-12-31'), '次日 01:59');
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

test('bound accounts must unbind before opening or submitting a different binding', async () => {
  const { page, calls } = createPage();
  page.toggleBindInput();
  page.data.bijingInputValue = 'BJ2407159';
  await page.confirmBindBijing();
  await page.doBindBijing('BJ2407159');
  assert.equal(page.data.bijingShowBindInput, false);
  assert.equal(page.data.bijingStudentNumber, 'BJ2407000');
  assert.equal(calls.check.length, 0);
  assert.equal(calls.bind.length, 0);
  assert.ok(calls.toast.every(item => /先解绑/.test(item.title)));
  assert.doesNotMatch(pageTemplate, /重新绑定|输入新学号/);
  assert.match(pageTemplate, /bindtap="unbindBijing"/);
});

test('canceling unbind keeps the binding and never invokes the cloud operation', async () => {
  const { page, calls } = createPage({ modal: request => request.success({ confirm: false }) });
  await page.unbindBijing();
  assert.equal(calls.modal.length, 1);
  assert.match(calls.modal[0].content, /BJ2407000/);
  assert.match(calls.modal[0].content, /记录.*保留/);
  assert.match(calls.modal[0].content, /管控权限.*失效/);
  assert.equal(calls.unbind.length, 0);
  assert.equal(page.data.bijingBound, true);
  assert.equal(page.data.bijingUnbinding, false);
  assert.equal(calls.alerts.length, 0);
});

test('unbind clears binding, pending previews and admin alerts while preserving records and profile', async () => {
  const preview = deferred();
  const { page, calls, storage } = createPage({ preview: () => preview.promise });
  storage.meditationRecords = [{ id: 'keep', duration: 25 }];
  storage.userInfo = { nickName: '保留昵称', avatarUrl: 'cloud://keep', bijingBound: true,
    bijingStudentNumber: 'BJ2407000', bijingSyncedDates: { '2026-09-16': true } };
  page.setData({ bijingLastSync: '旧同步结果', bijingIsAdmin: true });
  const reading = page.syncBijingNow();
  await page.unbindBijing();
  assert.deepEqual(calls.unbind, [['BJ2407000', 'binding-old']]);
  assert.equal(page.data.bijingBound, false);
  assert.equal(page.data.bijingStudentNumber, '');
  assert.equal(page.data.bijingBindingVersion, null);
  assert.equal(page.data.bijingLastSync, '');
  assert.equal(page.data.bijingShowSyncDatePicker, false);
  assert.equal(page.data.bijingIsAdmin, false);
  assert.deepEqual(calls.alerts, ['clear']);
  assert.equal(storage.userInfo.bijingBound, false);
  assert.equal(storage.userInfo.bijingStudentNumber, '');
  assert.equal(storage.userInfo.nickName, '保留昵称');
  assert.equal(storage.userInfo.avatarUrl, 'cloud://keep');
  assert.deepEqual(storage.userInfo.bijingSyncedDates, { '2026-09-16': true });
  assert.deepEqual(storage.meditationRecords, [{ id: 'keep', duration: 25 }]);
  const after = JSON.stringify(page.data);
  preview.resolve(previewResult('2026-09-16'));
  await reading;
  assert.equal(JSON.stringify(page.data), after, 'old previews cannot restore cleared sync data');
  await page.syncBijingNow();
  assert.equal(calls.preview.length, 1);
});

test('unbind confirmation and submission both block duplicate requests, binding and synchronization', async () => {
  let modal;
  const pending = deferred();
  const { page, calls } = createPage({ modal: value => { modal = value; }, unbind: () => pending.promise });
  const removing = page.unbindBijing();
  await page.unbindBijing();
  await page.syncBijingNow();
  assert.equal(calls.modal.length, 1);
  assert.equal(calls.unbind.length, 0);
  modal.success({ confirm: true });
  await Promise.resolve();
  await page.unbindBijing();
  page.toggleBindInput();
  await page.syncBijingNow();
  assert.equal(calls.unbind.length, 1);
  assert.equal(calls.preview.length, 0);
  pending.resolve({ success: true, data: { bound: false } });
  await removing;
  assert.equal(page.data.bijingUnbinding, false);
});

test('failed unbind preserves current binding and can be explicitly retried', async () => {
  let attempt = 0;
  const { page, calls } = createPage({ unbind: async () => ++attempt === 1
    ? { success: false, error: '绑定已变化，请刷新后重试' } : { success: true, data: { bound: false } } });
  await page.unbindBijing();
  assert.equal(page.data.bijingBound, true);
  assert.equal(page.data.bijingBindingVersion, 'binding-old');
  assert.equal(page.data.bijingUnbinding, false);
  assert.match(calls.toast.at(-1).title, /绑定已变化/);
  assert.equal(calls.alerts.length, 0);
  await page.unbindBijing();
  assert.equal(calls.unbind.length, 2);
  assert.equal(page.data.bijingBound, false);
});

test('hiding or changing accounts cancels a pending unbind confirmation before any cloud call', async () => {
  for (const change of ['hide', 'account', 'binding']) {
    let modal;
    const { page, calls, storage } = createPage({ modal: value => { modal = value; } });
    const removing = page.unbindBijing();
    if (change === 'hide') page.onHide();
    if (change === 'account') storage.userOpenId = 'oz-other';
    if (change === 'binding') page.data.bijingBindingVersion = 'newer-binding';
    modal.success({ confirm: true });
    await removing;
    assert.equal(calls.unbind.length, 0, change);
    assert.equal(page.data.bijingBound, true, change);
  }
});

test('late bind, unbind and validation responses cannot change a hidden page or another account', async () => {
  for (const kind of ['bind', 'unbind', 'check']) {
    for (const change of ['hide', 'account']) {
      const pending = deferred();
      const { page, calls, storage } = createPage({ bound: kind === 'unbind', [kind]: () => pending.promise });
      storage.userInfo = { nickName: '保持原昵称' };
      page.data.bijingInputValue = 'BJ2407159';
      const running = kind === 'bind' ? page.doBindBijing('BJ2407159') : kind === 'unbind' ? page.unbindBijing() : page.confirmBindBijing();
      await Promise.resolve();
      if (change === 'hide') page.onHide();
      else storage.userOpenId = 'oz-other';
      const before = JSON.stringify(page.data);
      const toastCount = calls.toast.length;
      pending.resolve({ success: true, data: { studentNumber: 'BJ2407159', nickname: '不能覆盖', nicknameOverridden: true, bound: false } });
      await running;
      assert.equal(JSON.stringify(page.data), before, `${kind}/${change}`);
      assert.equal(storage.userInfo.nickName, '保持原昵称', `${kind}/${change}`);
      assert.equal(calls.toast.length, toastCount, `${kind}/${change}`);
      assert.equal(calls.alerts.length, 0, `${kind}/${change}`);
    }
  }
});

test('an older profile response cannot restore a binding after unbind succeeds', async () => {
  const pending = deferred();
  const { page } = createPage({ cloud: () => pending.promise });
  const reading = page.loadBijingStatus();
  await page.unbindBijing();
  pending.resolve({ result: { success: true, data: { bijingBound: true, bijingStudentNumber: 'BJ2407000', bijingBindingVersion: 'binding-old' } } });
  await reading;
  assert.equal(page.data.bijingBound, false);
  assert.equal(page.data.bijingStudentNumber, '');
});

test('binding after unbind stores the new version and rechecks central admin access', async () => {
  const { page, calls, storage } = createPage();
  await page.unbindBijing();
  page.toggleBindInput();
  page.onBijingInput({ detail: { value: 'BJ2407159' } });
  await page.confirmBindBijing();
  await page.confirmBindConfirm();
  assert.equal(page.data.bijingStudentNumber, 'BJ2407159');
  assert.equal(page.data.bijingBindingVersion, 'binding-new');
  assert.equal(storage.userInfo.bijingBindingVersion, 'binding-new');
  assert.equal(page.data.bijingIsAdmin, true);
  assert.deepEqual(calls.cloud.map(([name, data]) => [name, data.type]), [['adminManager', 'getAccess']]);
  assert.deepEqual(calls.alerts, ['clear', 'clear', 'refresh']);
});

test('a central access failure does not undo successful binding or grant cached permissions', async () => {
  const { page, calls } = createPage({ bound: false, cloud: async () => { throw new Error('暂时不可用'); } });
  await page.doBindBijing('BJ2407159');
  assert.equal(page.data.bijingBound, true);
  assert.equal(page.data.bijingIsAdmin, false);
  assert.equal(page.data.bijingBinding, false);
  assert.deepEqual(calls.alerts, ['clear']);
  assert.equal(calls.toast.at(-1).title, '绑定成功');
});

test('a late access recheck after hiding does not restore admin state or red dots', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ bound: false, cloud: () => pending.promise });
  const binding = page.doBindBijing('BJ2407159');
  for (let attempt = 0; attempt < 10 && calls.cloud.length === 0; attempt++) await Promise.resolve();
  assert.equal(calls.cloud.length, 1);
  page.onHide();
  pending.resolve({ result: { success: true, data: { isAdmin: true } } });
  await binding;
  assert.equal(page.data.bijingIsAdmin, false);
  assert.deepEqual(calls.alerts, ['clear']);
});

test('a sync in flight prevents unbinding and cannot publish old results after hiding', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ sync: () => pending.promise });
  await page.syncBijingNow();
  const syncing = page.confirmBijingSyncDate();
  await page.unbindBijing();
  assert.equal(calls.modal.length, 0);
  page.onHide();
  const before = JSON.stringify(page.data);
  pending.resolve({ success: true, data: { success: true, duration: 20 } });
  await syncing;
  assert.equal(JSON.stringify(page.data), before);
  assert.equal(page.data.bijingLastSync, '');
});

test('unbind API carries the observed student number and optional binding version', async () => {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(apiSource, { module, require: () => ({ callCloudFunction: async (name, data) => {
    calls.push({ name, data: { ...data } });
    return { result: { success: true, data: { bound: false } } };
  } }) });
  await module.exports.unbindBijing('BJ2407000', 'binding-old');
  await module.exports.unbindBijing('BJ2407000');
  await module.exports.unbindBijing('BJ2407000', null);
  assert.deepEqual(calls, [
    { name: 'bijingSync', data: { type: 'unbindStudentNumber', studentNumber: 'BJ2407000', bindingVersion: 'binding-old' } },
    { name: 'bijingSync', data: { type: 'unbindStudentNumber', studentNumber: 'BJ2407000' } },
    { name: 'bijingSync', data: { type: 'unbindStudentNumber', studentNumber: 'BJ2407000' } }
  ]);
});

test('a stale unbind rejection reloads the latest binding without repeating the mutation', async () => {
  const { page, calls } = createPage({
    unbind: async () => ({ success: false, code: 'BINDING_STALE', error: '绑定已变化，请重试' }),
    cloud: async () => ({ result: { success: true, data: {
      bijingBound: true, bijingStudentNumber: 'BJ2407159', bijingBindingVersion: 'binding-newer'
    } } })
  });
  await page.unbindBijing();
  for (let attempt = 0; attempt < 10 && page.data.bijingBindingVersion !== 'binding-newer'; attempt++) await Promise.resolve();
  assert.deepEqual(calls.unbind, [['BJ2407000', 'binding-old']]);
  assert.equal(page.data.bijingStudentNumber, 'BJ2407159');
  assert.equal(page.data.bijingBindingVersion, 'binding-newer');
  assert.equal(page.data.bijingBound, true);
  assert.deepEqual(calls.cloud.map(([name, data]) => [name, data.type]), [['meditationManager', 'getUserProfile']]);
});

test('unbind API preserves stale-binding error codes for safe state refresh', async () => {
  const module = { exports: {} };
  vm.runInNewContext(apiSource, { module, require: () => ({ callCloudFunction: async () => ({
    result: { success: false, code: 'BINDING_STALE', error: '绑定已变化' }
  }) }) });
  const result = await module.exports.unbindBijing('BJ2407000', 'binding-old');
  assert.equal(result.success, false);
  assert.equal(result.code, 'BINDING_STALE');
  assert.equal(result.error, '绑定已变化');
});
