const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeCheckin = require('../miniprogram/utils/homeCheckin.js');

const pagePath = path.join(__dirname, '../miniprogram/pages/index/index.js');

function createPage({ records = [], dailyRecords: storedRecords, now = '2026-09-17T12:00:00+08:00', confirm = true, showModal, showActionSheet, remove } = {}) {
  let definition;
  const currentTime = Date.parse(now);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const dailyRecords = structuredClone(storedRecords || { '2026-09-17': { count: records.length, records } });
  const calls = { menu: [], modal: [], remove: [], toast: [], rank: 0 };
  const checkinManager = {
    getUserCheckinData: () => ({ dailyRecords }),
    getDailyCheckinCountSync: date => dailyRecords[date] ? dailyRecords[date].count : 0,
    getExperienceRecordsFromLocal: () => [],
    async deleteCheckin(date, identity) {
      calls.remove.push({ date, identity });
      if (remove) return remove(date, identity);
      const day = dailyRecords[date];
      const index = day.records.findIndex(record => identity.recordId
        ? record._id === identity.recordId
        : identity.localId ? record.localId === identity.localId : record.timestamp === identity.timestamp);
      assert.ok(index >= 0);
      day.records.splice(index, 1);
      day.count--;
      if (!day.records.length) delete dailyRecords[date];
      return { success: true };
    }
  };
  const wx = {
    getStorageSync: key => key === 'userOpenId' ? 'local-user' : undefined,
    showToast: options => calls.toast.push(options),
    showActionSheet(options) {
      calls.menu.push(options);
      if (showActionSheet) return showActionSheet(options);
      options.success({ tapIndex: 0 });
    },
    showModal(options) {
      calls.modal.push(options);
      if (showModal) return showModal(options);
      options.success({ confirm, cancel: !confirm });
    }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page: page => { definition = page; },
    require(name) {
      const file = path.basename(name);
      if (file === 'checkin.js') return checkinManager;
      if (file === 'homeCheckin.js') return homeCheckin;
      if (file === 'dateUtil.js') return require('../miniprogram/utils/dateUtil.js');
      if (file === 'contentSec.js') return {};
      throw new Error(`Unexpected dependency: ${file}`);
    },
    wx,
    Date: Clock,
    console: { log() {}, error() {}, warn() {} }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: { ...structuredClone(definition.data), currentYear: 2026, currentMonth: 9, userOpenId: 'local-user' },
    setData(values) { Object.assign(this.data, values); },
    loadRanking() { calls.rank++; }
  };
  page.refreshCalendarData();
  return { page, calls, dailyRecords };
}

function tapDelete(page, index = 0) {
  return page.deleteCheckinRecord({ currentTarget: { dataset: { id: page.data.checkinRecords[index].id } } });
}

function tapMore(page, index = 0) {
  return page.showCheckinActions({ currentTarget: { dataset: { id: page.data.checkinRecords[index].id } } });
}

function calendarDay(page) {
  return page.data.calendarDays.flat().find(day => day.fullDate === '2026-09-17');
}

const example = { _id: 'cloud-1', localId: 'local-1', timestamp: '2026-09-17T07:15:00+08:00', duration: 12 };

test('cancelling the record menu never opens confirmation or changes the records', async () => {
  const { page, calls } = createPage({
    records: [example],
    showActionSheet: options => options.fail({ errMsg: 'showActionSheet:fail cancel' })
  });
  const before = JSON.stringify(page.data);
  await tapMore(page);
  assert.deepEqual(Array.from(calls.menu[0].itemList), ['删除记录']);
  assert.equal(calls.modal.length, 0);
  assert.equal(calls.remove.length, 0);
  assert.equal(JSON.stringify(page.data), before);
});

test('record menu waits for confirmation and blocks repeat taps until deletion finishes', async () => {
  let menuOptions;
  let modalOptions;
  let finishDeletion;
  const { page, calls } = createPage({
    records: [example],
    showActionSheet: options => { menuOptions = options; },
    showModal: options => { modalOptions = options; },
    remove: () => new Promise(resolve => { finishDeletion = resolve; })
  });
  const pending = tapMore(page);
  assert.equal(page.data.checkinActionsOpen, true);
  await tapMore(page);
  assert.equal(calls.menu.length, 1);
  assert.equal(calls.modal.length, 0);
  menuOptions.success({ tapIndex: 0 });
  await Promise.resolve();
  await tapMore(page);
  assert.equal(calls.modal.length, 1);
  assert.equal(calls.remove.length, 0);
  modalOptions.success({ confirm: true });
  await Promise.resolve();
  await tapMore(page);
  assert.equal(calls.menu.length, 1);
  assert.equal(calls.remove.length, 1);
  assert.equal(calls.remove[0].date, '2026-09-17');
  finishDeletion({ success: true });
  await pending;
  assert.equal(page.data.checkinActionsOpen, false);
  assert.equal(page.data.checkinDeleting, false);
});

test('selecting delete can still be cancelled and Promise-style menus release their lock', async () => {
  const cancelled = createPage({ records: [example], confirm: false, showActionSheet: () => Promise.resolve({ tapIndex: 0 }) });
  await tapMore(cancelled.page);
  assert.equal(cancelled.calls.modal.length, 1);
  assert.equal(cancelled.calls.remove.length, 0);
  assert.equal(cancelled.page.data.checkinActionsOpen, false);

  for (const showActionSheet of [
    () => Promise.reject(new Error('showActionSheet:fail cancel')),
    () => { throw new Error('菜单不可用'); }
  ]) {
    const { page, calls } = createPage({ records: [example], showActionSheet });
    await tapMore(page);
    await tapMore(page);
    assert.equal(calls.menu.length, 2);
    assert.equal(calls.modal.length, 0);
    assert.equal(calls.remove.length, 0);
    assert.equal(page.data.checkinActionsOpen, false);
  }
});

test('home details retain deletion identities and sort numeric and ISO timestamps together', () => {
  const numeric = { timestamp: Date.parse('2026-09-17T08:30:00+08:00'), duration: 8 };
  const records = homeCheckin.buildCheckinRecords({ dailyRecords: {
    '2026-09-17': { records: [example, numeric] }
  } });
  assert.equal(records[0].time, '08:30');
  assert.equal(records[0].timestamp, numeric.timestamp);
  assert.equal(records[1].time, '07:15');
  assert.equal(records[1].timestamp, example.timestamp);
  assert.equal(records[1]._id, example._id);
  assert.equal(records[1].localId, example.localId);
});

test('cancelled deletion includes the selected record details and leaves records and totals unchanged', async () => {
  const { page, calls } = createPage({ records: [example], confirm: false });
  const before = JSON.stringify(page.data);
  await tapDelete(page);
  assert.equal(calls.modal.length, 1);
  assert.match(calls.modal[0].content, /2026-09-17 07:15/);
  assert.match(calls.modal[0].content, /12 分钟/);
  assert.match(calls.modal[0].content, /无法恢复/);
  assert.equal(calls.remove.length, 0);
  assert.equal(calls.rank, 0);
  assert.equal(JSON.stringify(page.data), before);
});

test('confirmed deletion uses original identity and refreshes the empty list and calendar without rankings', async () => {
  const { page, calls } = createPage({ records: [example] });
  assert.equal(calendarDay(page).isChecked, true);
  await tapDelete(page);
  assert.equal(calls.remove.length, 1);
  assert.equal(calls.remove[0].date, '2026-09-17');
  assert.deepEqual({ ...calls.remove[0].identity }, {
    recordId: example._id, localId: example.localId, timestamp: example.timestamp
  });
  assert.equal(page.data.checkinRecords.length, 0);
  assert.equal(page.data.checkinTotal, 0);
  assert.equal(page.data.checkinGroups.length, 0);
  assert.equal(page.data.hiddenCheckinCount, 0);
  assert.equal(calendarDay(page).isChecked, false);
  assert.equal(calls.rank, 0);
  assert.equal(page.data.checkinDeleting, false);
  assert.equal(page.data.deletingCheckinId, '');
  assert.ok(calls.toast.some(toast => toast.title === '记录已删除'));
});

test('deleting a recent record updates group totals and never reveals older records', async () => {
  const records = Array.from({ length: 45 }, (_, index) => ({
    localId: `local-${index}`,
    timestamp: Date.parse('2026-09-17T07:00:00+08:00') + index * 60000,
    duration: index + 1
  }));
  const { page, calls } = createPage({ dailyRecords: {
    '2026-09-17': { count: 45, records },
    '2026-09-14': { count: 1, records: [{ localId: 'old-record', timestamp: Date.parse('2026-09-14T12:00:00+08:00'), duration: 8 }] }
  } });
  const removedId = page.data.checkinRecords[30].id;
  assert.equal(page.data.checkinRecords.length, 45);
  await tapDelete(page, 30);
  assert.equal(page.data.checkinRecords.length, 44);
  assert.equal(page.data.checkinTotal, 45);
  assert.equal(page.data.hiddenCheckinCount, 1);
  assert.equal(page.data.checkinRecords.some(record => record.id === removedId), false);
  assert.equal(page.data.checkinRecords.some(record => record.localId === 'old-record'), false);
  assert.equal(page.data.checkinGroups[0].count, 44);
  assert.equal(page.data.checkinGroups[0].totalDuration, 1020);
  assert.equal(page.data.checkinGroups[0].date, '2026-09-17');
  assert.equal(page.data.checkinGroups.length, 1);
  assert.equal(calendarDay(page).isChecked, true);
  assert.equal(calls.rank, 0);
});

test('a before-04:00 record is grouped under the previous day but deleted from its original bucket', async () => {
  const earlyMorning = { ...example, timestamp: '2026-09-17T03:59:59+08:00' };
  const { page, calls } = createPage({ records: [earlyMorning] });
  assert.equal(page.data.checkinGroups[0].date, '2026-09-16');
  assert.equal(page.data.checkinRecords[0].date, '2026-09-17');
  assert.equal(page.data.checkinRecords[0].dayDate, '2026-09-16');
  assert.match(page.data.checkinRecords[0].timeLabel, /次日.*03:59/);
  await tapDelete(page);
  assert.equal(calls.remove[0].date, '2026-09-17');
  assert.deepEqual({ ...calls.remove[0].identity }, {
    recordId: earlyMorning._id, localId: earlyMorning.localId, timestamp: earlyMorning.timestamp
  });
  assert.equal(page.data.checkinGroups.length, 0);
  assert.equal(page.data.checkinTotal, 0);
  assert.equal(page.data.hiddenCheckinCount, 0);
});

test('confirmation and pending removal each prevent duplicate deletions and show loading only during removal', async () => {
  let modalOptions;
  let completeDelete;
  const pendingDelete = new Promise(resolve => { completeDelete = resolve; });
  const { page, calls } = createPage({
    records: [example],
    showModal: options => { modalOptions = options; },
    remove: () => pendingDelete
  });
  const pending = tapDelete(page);
  assert.equal(page.data.checkinDeleting, true);
  assert.equal(page.data.deletingCheckinId, '');
  await tapDelete(page);
  assert.equal(calls.modal.length, 1);
  modalOptions.success({ confirm: true });
  await Promise.resolve();
  assert.equal(page.data.deletingCheckinId, page.data.checkinRecords[0].id);
  await tapDelete(page);
  assert.equal(calls.remove.length, 1);
  completeDelete({ success: true });
  await pending;
  assert.equal(page.data.checkinDeleting, false);
  assert.equal(page.data.deletingCheckinId, '');
});

test('a failed delete preserves list and summary data and permits a retry', async () => {
  for (const remove of [
    () => ({ success: false, error: '删除失败' }),
    () => { throw new Error('网络不可用'); }
  ]) {
    const { page, calls } = createPage({ records: [example], remove });
    const before = JSON.stringify(page.data);
    await tapDelete(page);
    assert.equal(JSON.stringify(page.data), before);
    assert.equal(calls.rank, 0);
    assert.ok(calls.toast.some(toast => /失败/.test(toast.title)));
    await tapDelete(page);
    assert.equal(calls.remove.length, 2);
  }
});

test('Promise-style modal APIs work and modal failures release the deletion lock', async () => {
  const successful = createPage({ records: [example], showModal: () => Promise.resolve({ confirm: true }) });
  await tapDelete(successful.page);
  assert.equal(successful.calls.remove.length, 1);

  const failed = createPage({ records: [example], showModal: options => options.fail(new Error('弹窗不可用')) });
  await tapDelete(failed.page);
  assert.equal(failed.calls.remove.length, 0);
  assert.equal(failed.page.data.checkinDeleting, false);
  assert.equal(failed.page.data.checkinTotal, 1);
});
