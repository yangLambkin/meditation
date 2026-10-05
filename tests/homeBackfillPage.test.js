const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const utilsPath = path.join(__dirname, '../miniprogram/utils');
const pagePath = path.join(__dirname, '../miniprogram/pages/index/index.js');
const NOW = Date.parse('2026-10-05T12:00:00+08:00');
const plain = value => JSON.parse(JSON.stringify(value));
const input = value => ({ detail: { value } });
const success = data => ({ success: true, data });
const approved = (extra = {}) => ({ _id: 'request-1', startDate: '2026-09-20', endDate: '2026-10-04',
  status: 'approved', canRecord: true, expired: false, expiresAt: '2026-10-11T18:00:00Z', ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ api, owner = 'oz-student', grants = [approved()], confirm = true, refresh = true, badge, intent, network = 'wifi' } = {}) {
  let definition;
  const clock = { now: NOW };
  const storage = new Map(intent ? [['homeBackfillIntent', intent]] : []);
  const calls = { cloud: [], local: [], toast: [], modals: [], updates: [], refresh: 0, cache: 0,
    badges: [], accepted: [], alert: [], content: [], navigation: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const wx = {
    getStorageSync: key => key === 'userOpenId' ? owner : storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast: options => calls.toast.push(plain(options)),
    showModal(options) { calls.modals.push(options); if (typeof confirm === 'function') confirm(options); else options.success({ confirm }); },
    getNetworkType(options) { options.success({ networkType: network }); },
    navigateTo: options => calls.navigation.push(plain(options)),
    hideKeyboard() {}, showLoading() {}, hideLoading() {}, stopPullDownRefresh() {}
  };
  const application = { refreshSyncAlert: options => calls.alert.push(plain(options)), applySyncAlertDot() {} };
  const modules = {
    'dailyWisdom.js': { DEFAULT_QUOTE: '每日金句', watchDailyWisdom: () => () => {} },
    'contentSec.js': { async checkText(...args) { calls.content.push(args); return true; } },
    'checkin.js': {
      isUserLoggedIn: () => !!owner,
      getPendingSyncSummary: () => ({ total: 0, pending: 0, failed: 0 }),
      getUserCheckinData: () => ({ dailyRecords: {} }),
      getDailyCheckinCountSync: () => 0,
      getExperienceRecordsFromLocal: () => [],
      subscribeSyncState: () => () => {},
      syncWithCloud: async () => ({ success: true, refreshed: false, pending: 0 }),
      async refreshFromCloud() { calls.cache++; return typeof refresh === 'function' ? refresh() : refresh; },
      async asyncCheckBadgeUnlock(duration) { calls.badges.push(duration); if (badge) return badge(duration); },
      recordCheckin(...args) { calls.local.push(args); return { success: true }; }
    },
    'bijingRecordSync.js': { getDayState: () => null, subscribe: () => () => {},
      acceptSavedRecord(...args) { calls.accepted.push(plain(args)); } },
    'cloudApi.js': { async callCloudFunction(name, data) {
      calls.cloud.push({ name, data: plain(data) });
      let result = api && await api(name, data, calls.cloud.filter(call => call.data.type === data.type).length);
      if (result === undefined) result = success(data.type === 'getMyBackfillRequests'
        ? { requests: grants, nextCursor: '' } : data.type === 'getUserRecords' ? []
          : data.type === 'recordMeditation' ? { recordId: 'saved-1', date: data.data.date, duration: data.data.duration }
            : {});
      return { result };
    } }
  };
  function loadModule(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js', 'homeBackfill.js'].includes(filename), `Unexpected dependency: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(utilsPath, filename), 'utf8'), {
      module, require: loadModule, Date: Clock, wx, getApp: () => application,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout
    }, { filename });
    if (filename === 'dateUtil.js') module.exports.watchBusinessDate = () => () => {};
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page: value => { definition = value; }, require: loadModule, wx, Date: Clock,
    getApp: () => application, console: { log() {}, warn() {}, error() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}
  }, { filename: pagePath });
  const page = { ...definition, data: plain(definition.data),
    setData(values, callback) { calls.updates.push(plain(values)); Object.assign(this.data, values); if (callback) callback(); },
    refreshPageData() { calls.refresh++; },
    checkUserInfoStatus() {}, generateCalendar() {}
  };
  return { page, calls, clock, storage, setAccount: value => { owner = value; } };
}
const requests = (calls, type) => calls.cloud.filter(call => call.data.type === type);
async function recorder(options = {}, date = '2026-09-20') {
  const result = harness(options);
  await result.page.onShow();
  await flush();
  result.page.openCheckinModal();
  await flush();
  selectDate(result.page, date);
  await flush();
  result.page.onCheckinDurationInput(input('30'));
  result.page.onCheckinTimeChange(input('08:30'));
  return result;
}
function selectDate(page, date) {
  const index = page.data.checkinDateOptions.findIndex(option => option.date === date);
  assert.ok(index >= 0, `${date} should be offered by the homepage`);
  page.onAllowedCheckinDateChange(input(String(index)));
}

test('home offers approved dates together with the usual three days and fetches the selected day total', async () => {
  const { page, calls } = await recorder({ api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'existing', duration: 45 }]) : undefined });
  const dates = page.data.checkinDateOptions.map(option => option.date);
  assert.equal(new Set(dates).size, dates.length, 'overlapping days appear once');
  assert.equal(dates.length, 16);
  assert.ok(dates.includes('2026-10-05'));
  assert.ok(dates.includes('2026-09-20'));
  assert.equal(page.data.checkinBackfillGrant._id, 'request-1');
  assert.equal(page.data.backfillDayTotal, 45);
  assert.equal(page.data.backfillDayLoaded, true);
  assert.ok(requests(calls, 'getUserRecords').some(call => call.data.date === '2026-09-20'));
});

test('a 72-hour approval keeps the submitted 30-day range until its exact expiry and always offers the latest three days', async () => {
  const expiresAt = '2026-10-08T04:00:00.000Z';
  const grant = approved({ ruleVersion: 2, startDate: '2026-09-05', endDate: '2026-10-04',
    handledAt: '2026-10-05T04:00:00.000Z', expiresAt });
  const { page, clock, calls } = await recorder({ grants: [grant] }, '2026-09-05');
  assert.equal(page.data.checkinDateOptions.length, 31);
  clock.now = Date.parse(expiresAt) - 1;
  page.refreshCheckinDefaults();
  const dates = Array.from(page.data.checkinDateOptions, option => option.date);
  assert.ok(dates.includes('2026-09-05'), 'the submitted range stays fixed after a business-day rollover');
  assert.ok(dates.includes('2026-10-04'));
  assert.deepEqual(dates.slice(0, 3), ['2026-10-08', '2026-10-07', '2026-10-06']);
  assert.ok(!dates.includes('2026-10-05'), 'unapproved dates between the two ranges remain unavailable');
  assert.equal(page.data.checkinBackfillGrant._id, 'request-1');
  clock.now = Date.parse(expiresAt);
  page.refreshCheckinDefaults();
  assert.equal(page.data.checkinBackfillGrant, null);
  assert.deepEqual(Array.from(page.data.checkinDateOptions, option => option.date), ['2026-10-08', '2026-10-07', '2026-10-06']);
  assert.equal(page.data.checkinDate, '2026-09-05');
  assert.equal(page.data.checkinDuration, '30');
  assert.match(page.data.checkinDateAccessHint, /不在当前可录范围/);
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
});

test('home discovers an approved application on later pages and ignores pending or expired applications', async () => {
  const { page, calls } = await recorder({ api: (name, data) => data.type === 'getMyBackfillRequests'
    ? success(data.cursor ? { requests: [approved()], nextCursor: '' }
      : { requests: [approved({ _id: 'pending', status: 'pending', canRecord: false }),
        approved({ _id: 'expired', expired: true, expiresAt: '2026-10-04T00:00:00Z' })], nextCursor: 'later' }) : undefined });
  assert.equal(page.data.checkinBackfillGrant._id, 'request-1');
  assert.ok(requests(calls, 'getMyBackfillRequests').some(call => call.data.cursor === 'later'));
  const noGrant = harness({ grants: [approved({ status: 'pending', canRecord: false }), approved({ expired: true })] });
  await noGrant.page.onShow(); await flush();
  assert.deepEqual(Array.from(noGrant.page.data.checkinDateOptions, item => item.date).sort(), ['2026-10-03', '2026-10-04', '2026-10-05']);
});

test('rejected applications never unlock historical dates even when canRecord is stale', async () => {
  const { page, calls } = harness({ grants: [approved({ status: 'rejected', canRecord: true })] });
  await page.onShow(); await flush();
  page.openCheckinModal(); await flush();
  assert.deepEqual(Array.from(page.data.checkinDateOptions, item => item.date), ['2026-10-05', '2026-10-04', '2026-10-03']);
  assert.equal(page.data.homeBackfillGrant, null);
  page.onCheckinDateChange(input('2026-09-20'));
  page.onCheckinDurationInput(input('30'));
  page.onCheckinTimeChange(input('08:30'));
  assert.match(page.data.checkinDateAccessHint, /不在当前可录范围/);
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
});

test('expiration explains an unavailable selected date without moving or clearing its draft', async () => {
  const { page, calls, clock } = await recorder();
  page.onCheckinExperienceInput(input('未完成的补录草稿'));
  page.setData({ checkinBackfillError: '原保存错误', checkinBackfillMessage: '原保存提示' });
  clock.now = Date.parse('2026-10-12T12:00:00+08:00');
  page.refreshCheckinDefaults();
  assert.equal(page.data.checkinBackfillGrant, null);
  assert.equal(page.data.checkinDate, '2026-09-20');
  assert.equal(page.data.checkinTime, '08:30');
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinExperience, '未完成的补录草稿');
  assert.match(page.data.checkinDateAccessHint, /不在当前可录范围.*重新选择最近三天或有效获批日期/);
  assert.equal(page.data.checkinBackfillError, '原保存错误');
  assert.equal(page.data.checkinBackfillMessage, '原保存提示');
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
  selectDate(page, '2026-10-12');
  assert.equal(page.data.checkinDateAccessHint, '');
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinExperience, '未完成的补录草稿');
});

test('failed permission refresh explains how to recover a historical draft and clears the hint after recovery', async () => {
  let unavailable = false;
  const { page, calls } = await recorder({ api: (name, data) => {
    if (data.type === 'getMyBackfillRequests' && unavailable) throw new Error('权限读取失败');
  } });
  page.onCheckinExperienceInput(input('保留此草稿'));
  unavailable = true;
  await page.initHomeBackfill();
  assert.equal(page.data.checkinBackfillGrant, null);
  assert.equal(page.data.checkinDate, '2026-09-20');
  assert.equal(page.data.checkinTime, '08:30');
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinExperience, '保留此草稿');
  assert.match(page.data.checkinDateAccessHint, /重试读取补录权限/);
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
  unavailable = false;
  await page.initHomeBackfill();
  assert.equal(page.data.checkinBackfillGrant._id, 'request-1');
  assert.equal(page.data.checkinDateAccessHint, '');
  assert.equal(page.data.checkinDate, '2026-09-20');
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinExperience, '保留此草稿');
});

test('approved recording uses the shared modal, preserves the 02:00 business date, and waits for cloud confirmation', async () => {
  const pending = deferred();
  const { page, calls } = await recorder({ api: (name, data) => data.type === 'recordMeditation' ? pending.promise : undefined });
  page.onCheckinTimeChange(input('01:30'));
  page.onCheckinExperienceInput(input('  身心平静  '));
  const saving = page.submitCheckin(); await flush();
  assert.equal(calls.local.length, 0);
  assert.equal(page.data.showCheckinModal, true);
  assert.equal(page.data.checkinSubmitting, true);
  await page.submitCheckin();
  const sent = requests(calls, 'recordMeditation');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.data.date, '2026-09-20');
  assert.equal(sent[0].data.data.timestamp, Date.parse('2026-09-21T01:30:00+08:00'));
  assert.equal(sent[0].data.data.backfillRequestId, 'request-1');
  assert.equal(sent[0].data.data.source, 'manual');
  assert.equal(sent[0].data.data.expectedOpenid, 'oz-student');
  assert.ok(sent[0].data.data.idempotencyKey);
  assert.equal(sent[0].data.data.experience[0].text, '身心平静');
  pending.resolve(success({ recordId: 'saved-1', date: '2026-09-20', duration: 30 }));
  await saving; await flush();
  assert.equal(page.data.checkinSubmitting, false);
  assert.equal(page.data.checkinDuration, '');
  assert.ok(calls.toast.some(toast => toast.icon === 'success'));
});

test('overlapping recent approved days use cloud backfill while today keeps local saving', async () => {
  const backfill = await recorder({}, '2026-10-04');
  await backfill.page.submitCheckin();
  assert.equal(requests(backfill.calls, 'recordMeditation').length, 1);
  assert.equal(backfill.calls.local.length, 0);
  const normal = await recorder({}, '2026-10-05');
  await normal.page.submitCheckin();
  assert.equal(normal.calls.local.length, 1);
  assert.equal(requests(normal.calls, 'recordMeditation').length, 0);
});

test('uncertain saves preserve their draft and retry identity, while an edited draft gets a new identity', async () => {
  const { page, calls, clock } = await recorder({ api: (name, data) => data.type === 'recordMeditation'
    ? { success: false, error: '连接中断，请重试' } : undefined });
  page.onCheckinExperienceInput(input('仍保留我的体验'));
  await page.submitCheckin();
  assert.equal(page.data.showCheckinModal, true);
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinExperience, '仍保留我的体验');
  assert.equal(calls.cache, 0);
  assert.equal(calls.toast.some(toast => toast.icon === 'success'), false);
  clock.now += 60000;
  await page.submitCheckin();
  let sent = requests(calls, 'recordMeditation');
  assert.equal(sent[0].data.data.idempotencyKey, sent[1].data.data.idempotencyKey);
  page.onCheckinDurationInput(input('31'));
  await page.submitCheckin();
  sent = requests(calls, 'recordMeditation');
  assert.notEqual(sent[1].data.data.idempotencyKey, sent[2].data.data.idempotencyKey);
});

test('hiding during an uncertain save suppresses its late result and preserves retry identity on return', async () => {
  const pending = deferred();
  const { page, calls } = await recorder({ api: (name, data, count) => data.type === 'recordMeditation'
    ? count === 1 ? pending.promise : { success: false, error: '仍需重试' } : undefined });
  const saving = page.submitCheckin(); await flush();
  page.onHide();
  const updates = calls.updates.length;
  pending.reject(new Error('连接中断'));
  await saving;
  assert.equal(calls.updates.length, updates);
  assert.equal(calls.toast.length, 0);
  await page.onShow(); await flush();
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(page.data.checkinDate, '2026-09-20');
  await page.submitCheckin();
  const sent = requests(calls, 'recordMeditation');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].data.data.idempotencyKey, sent[1].data.data.idempotencyKey);
});

test('unavailable daily records and a daily total over 1440 minutes prevent cloud writes', async () => {
  for (const records of [{ success: false, error: '暂时无法读取记录' }, success([{ _id: 'existing', duration: 1420 }])]) {
    const { page, calls } = await recorder({ api: (name, data) => data.type === 'getUserRecords' ? records : undefined });
    await page.submitCheckin();
    assert.equal(requests(calls, 'recordMeditation').length, 0);
    assert.equal(calls.local.length, 0);
    assert.ok(page.data.checkinBackfillError || page.data.backfillDayError);
  }
  const exactly = await recorder({ api: (name, data) => data.type === 'getUserRecords'
    ? success([{ _id: 'existing', duration: 1410 }]) : undefined });
  await exactly.page.submitCheckin();
  assert.equal(requests(exactly.calls, 'recordMeditation').length, 1);
});

test('long approved entries require confirmation before saving', async () => {
  const cancelled = await recorder({ confirm: false });
  cancelled.page.onCheckinDurationInput(input('360'));
  await cancelled.page.submitCheckin();
  assert.equal(cancelled.calls.modals.length, 1);
  assert.equal(requests(cancelled.calls, 'recordMeditation').length, 0);
  assert.equal(cancelled.page.data.checkinDuration, '360');
  const confirmed = await recorder();
  confirmed.page.onCheckinDurationInput(input('360'));
  await confirmed.page.submitCheckin();
  assert.equal(confirmed.calls.modals.length, 1);
  assert.equal(requests(confirmed.calls, 'recordMeditation').length, 1);
});

test('cloud acceptance remains a success when refreshing statistics or badges fails', async () => {
  for (const options of [{ refresh: () => { throw new Error('统计暂时不可用'); } },
    { badge: () => { throw new Error('勋章暂时不可用'); } }]) {
    const { page, calls } = await recorder(options);
    await page.submitCheckin(); await flush();
    assert.equal(requests(calls, 'recordMeditation').length, 1);
    assert.equal(calls.local.length, 0);
    assert.equal(page.data.checkinDuration, '');
    assert.ok(calls.toast.some(toast => toast.icon === 'success'));
    assert.equal(calls.toast.some(toast => /保存失败/.test(toast.title)), false);
    if (options.badge) assert.deepEqual(calls.badges, [30]);
  }
});

test('expired authorization and a switched account cannot submit the old student draft', async () => {
  for (const change of ['expiry', 'account']) {
    const { page, calls, clock, setAccount } = await recorder();
    if (change === 'expiry') clock.now = Date.parse('2026-10-12T12:00:00+08:00');
    else setAccount('oz-someone-else');
    await page.submitCheckin();
    assert.equal(requests(calls, 'recordMeditation').length, 0, change);
    assert.equal(calls.local.length, 0, change);
  }
});

test('returning from an approved application consumes its intent only after rechecking authorization', async () => {
  const intent = { account: 'oz-student', requestId: 'request-1', date: '2026-09-22' };
  const allowed = harness({ intent });
  await allowed.page.onShow(); await flush();
  assert.ok(requests(allowed.calls, 'getMyBackfillRequests').length);
  assert.equal(allowed.page.data.showCheckinModal, true);
  assert.equal(allowed.page.data.checkinDate, intent.date);
  assert.equal(allowed.storage.has('homeBackfillIntent'), false);
  for (const options of [{ grants: [] }, { owner: 'oz-other' }]) {
    const denied = harness({ intent, ...options });
    await denied.page.onShow(); await flush();
    assert.equal(denied.page.data.showCheckinModal, false);
    assert.equal(denied.storage.has('homeBackfillIntent'), false);
  }
});

test('late authorization reads cannot repopulate a hidden page or another account', async () => {
  const pending = deferred();
  const { page, calls, setAccount } = harness({ api: (name, data) => data.type === 'getMyBackfillRequests' ? pending.promise : undefined });
  const showing = page.onShow(); await flush();
  page.onHide(); setAccount('oz-other');
  const updates = calls.updates.length;
  pending.resolve(success({ requests: [approved()], nextCursor: '' }));
  await showing; await flush();
  assert.equal(calls.updates.length, updates);
  assert.equal(page.data.checkinBackfillGrant, null);
});

test('offline approved entries retain their draft without announcing a local save', async () => {
  const { page, calls } = await recorder({ network: 'none' });
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
  assert.equal(page.data.checkinDuration, '30');
  assert.match(page.data.checkinBackfillError, /联网/);
  assert.equal(calls.toast.some(toast => toast.icon === 'success'), false);
});

test('a response without a confirmed record id remains retryable with its original identity', async () => {
  const { page, calls } = await recorder({ api: (name, data, count) => data.type === 'recordMeditation' && count === 1
    ? success({}) : undefined });
  await page.submitCheckin();
  assert.equal(page.data.checkinDuration, '30');
  assert.equal(calls.cache, 0);
  assert.equal(calls.toast.some(toast => toast.icon === 'success'), false);
  await page.submitCheckin();
  const sent = requests(calls, 'recordMeditation');
  assert.equal(sent[0].data.data.idempotencyKey, sent[1].data.data.idempotencyKey);
  assert.equal(page.data.checkinDuration, '');
});

test('switching selected dates ignores stale daily records and only uses the visible day total', async () => {
  const oldDay = deferred();
  const { page } = await recorder({ api: (name, data) => data.type === 'getUserRecords'
    ? data.date === '2026-09-20' ? oldDay.promise : success([{ _id: 'new-day', duration: 40 }]) : undefined });
  assert.equal(page.data.backfillDayLoading, true);
  selectDate(page, '2026-09-21'); await flush();
  assert.equal(page.data.backfillDayTotal, 40);
  oldDay.resolve(success([{ _id: 'old-day', duration: 1430 }])); await flush();
  assert.equal(page.data.checkinDate, '2026-09-21');
  assert.equal(page.data.backfillDayTotal, 40);
  assert.deepEqual(Array.from(page.data.backfillDayRecords, row => row._id), ['new-day']);
});

test('a cloud success received while hidden is applied once on return without sending another record', async () => {
  const pending = deferred();
  const { page, calls } = await recorder({ api: (name, data) => data.type === 'recordMeditation' ? pending.promise : undefined });
  const saving = page.submitCheckin(); await flush();
  page.onHide(); const updates = calls.updates.length;
  pending.resolve(success({ recordId: 'saved-while-hidden', date: '2026-09-20', duration: 30 }));
  await saving;
  assert.equal(calls.updates.length, updates);
  assert.equal(calls.toast.length, 0);
  await page.onShow(); await flush();
  assert.equal(page.data.checkinDuration, '');
  assert.equal(calls.toast.filter(toast => toast.icon === 'success').length, 1);
  page.onHide(); await page.onShow(); await flush();
  assert.equal(requests(calls, 'recordMeditation').length, 1);
  assert.equal(calls.toast.filter(toast => toast.icon === 'success').length, 1);
});

test('a saved response for the previous account cannot clear or announce the new account draft', async () => {
  const pending = deferred();
  const { page, calls, setAccount } = await recorder({ api: (name, data) => data.type === 'recordMeditation' ? pending.promise : undefined });
  const saving = page.submitCheckin(); await flush();
  page.onHide(); setAccount('oz-other');
  await page.onShow(); await flush();
  page.openCheckinModal(); await flush();
  page.onCheckinDurationInput(input('17'));
  page.onCheckinExperienceInput(input('另一位同学的草稿'));
  const updates = calls.updates.length;
  pending.resolve(success({ recordId: 'saved-for-old-student', date: '2026-09-20', duration: 30 }));
  await saving; await flush();
  assert.equal(calls.updates.length, updates);
  assert.equal(calls.toast.length, 0);
  assert.equal(page.data.checkinDuration, '17');
  assert.equal(page.data.checkinExperience, '另一位同学的草稿');
  assert.equal(calls.cache, 0);
});

test('an uncertain request can be confirmed after expiry with the same key even if its minutes already appear in the daily total', async () => {
  const { page, calls, clock } = await recorder({ api: (name, data, count) => data.type === 'getUserRecords'
    ? success([{ _id: 'existing', duration: count === 1 ? 1410 : 1440 }])
    : data.type === 'recordMeditation' ? { success: false, error: '保存结果尚未确认' } : undefined });
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 1);
  await page.loadBackfillDayRecords();
  assert.equal(page.data.backfillDayTotal, 1440);
  clock.now = Date.parse('2026-10-12T12:00:00+08:00');
  page.refreshCheckinDefaults();
  assert.match(page.data.checkinDateAccessHint, /原提交尚未确认.*重试核对.*新增补录需有效权限/);
  assert.equal(page.data.checkinBackfillError, '保存结果尚未确认');
  await page.submitCheckin();
  const sent = requests(calls, 'recordMeditation');
  assert.equal(sent.length, 2, 'confirm the uncertain operation even after its permission window closes');
  assert.equal(sent[0].data.data.idempotencyKey, sent[1].data.data.idempotencyKey);
  assert.equal(page.data.checkinBackfillGrant, null);
  page.onCheckinDurationInput(input('31'));
  assert.match(page.data.checkinDateAccessHint, /不在当前可录范围/);
  assert.doesNotMatch(page.data.checkinDateAccessHint, /原提交尚未确认/);
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 2, 'changed content requires a currently valid grant');
  assert.equal(calls.local.length, 0);
});

test('the gap between an approved range and the recent three days cannot be selected or saved', async () => {
  const { page, calls } = await recorder({ grants: [approved({ endDate: '2026-09-25' })] });
  const dates = Array.from(page.data.checkinDateOptions, option => option.date);
  assert.ok(dates.includes('2026-09-25'));
  assert.ok(dates.includes('2026-10-03'));
  assert.equal(dates.includes('2026-09-30'), false);
  assert.equal(dates.length, 9);
  page.onCheckinDateChange(input('2026-09-30'));
  await page.submitCheckin();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
  assert.match(calls.toast.at(-1).title, /最近三天或获批/);
});

test('switching account without showing the page again cannot save a recent approved draft as an ordinary local record', async () => {
  const { page, calls, setAccount } = await recorder({}, '2026-10-04');
  setAccount('oz-other');
  await page.submitCheckin(); await flush();
  assert.equal(requests(calls, 'recordMeditation').length, 0);
  assert.equal(calls.local.length, 0);
  assert.equal(page.data.showCheckinModal, false);
  assert.equal(page.data.checkinDuration, '');
  assert.match(calls.toast.at(-1).title, /账号已切换/);
});

test('late statistics failures cannot add an earlier saved message to a new draft on the same or another date', async () => {
  for (const date of ['2026-09-20', '2026-09-21']) {
    for (const failure of [false, new Error('统计读取失败')]) {
      const pending = deferred();
      const { page, calls } = await recorder({ refresh: () => pending.promise });
      const saving = page.submitCheckin(); await flush();
      assert.equal(page.data.checkinSubmitting, false, 'cloud acceptance releases the form before statistics finish');
      assert.equal(calls.toast.filter(toast => toast.icon === 'success').length, 1);
      if (date !== page.data.checkinDate) selectDate(page, date);
      page.onCheckinDurationInput(input('17'));
      page.onCheckinExperienceInput(input('下一次静坐尚未保存'));
      assert.equal(page.data.checkinBackfillMessage, '');
      if (failure instanceof Error) pending.reject(failure);
      else pending.resolve(failure);
      await saving; await flush();
      assert.equal(page.data.checkinDate, date);
      assert.equal(page.data.checkinDuration, '17');
      assert.equal(page.data.checkinExperience, '下一次静坐尚未保存');
      assert.equal(page.data.checkinBackfillMessage, '', 'a statistics failure belongs to the previous completed save');
      assert.equal(calls.toast.filter(toast => toast.icon === 'success').length, 1);
    }
  }
});
