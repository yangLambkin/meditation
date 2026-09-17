const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeCheckin = require('../miniprogram/utils/homeCheckin.js');

const pagePath = path.join(__dirname, '../miniprogram/pages/index/index.js');

function createPage({ records = [], confirm = true, showModal, remove } = {}) {
  let definition;
  const dailyRecords = { '2026-09-17': { count: records.length, records: structuredClone(records) } };
  const calls = { modal: [], remove: [], toast: [], rank: 0 };
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

function calendarDay(page) {
  return page.data.calendarDays.flat().find(day => day.fullDate === '2026-09-17');
}

const example = { _id: 'cloud-1', localId: 'local-1', timestamp: '2026-09-17T07:15:00+08:00', duration: 12 };

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

test('confirmed deletion uses original identity and refreshes empty list, calendar, monthly total and ranking', async () => {
  const { page, calls } = createPage({ records: [example] });
  assert.equal(calendarDay(page).isChecked, true);
  assert.equal(page.data.monthlyCount, 1);
  await tapDelete(page);
  assert.equal(calls.remove.length, 1);
  assert.equal(calls.remove[0].date, '2026-09-17');
  assert.deepEqual({ ...calls.remove[0].identity }, {
    recordId: example._id, localId: example.localId, timestamp: example.timestamp
  });
  assert.equal(page.data.checkinRecords.length, 0);
  assert.equal(page.data.checkinTotal, 0);
  assert.equal(page.data.hasMoreCheckins, false);
  assert.equal(calendarDay(page).isChecked, false);
  assert.equal(page.data.monthlyCount, 0);
  assert.equal(calls.rank, 1);
  assert.equal(page.data.checkinDeleting, false);
  assert.equal(page.data.deletingCheckinId, '');
  assert.ok(calls.toast.some(toast => toast.title === '记录已删除'));
});

test('deleting a record on a loaded later page preserves the visible pagination window', async () => {
  const records = Array.from({ length: 45 }, (_, index) => ({
    localId: `local-${index}`,
    timestamp: Date.parse('2026-09-17T07:00:00+08:00') + index * 60000,
    duration: index + 1
  }));
  const { page } = createPage({ records });
  page.loadMoreCheckins();
  const removedId = page.data.checkinRecords[30].id;
  assert.equal(page.data.checkinRecords.length, 40);
  await tapDelete(page, 30);
  assert.equal(page.data.checkinRecords.length, 40);
  assert.equal(page.data.checkinTotal, 44);
  assert.equal(page.data.hasMoreCheckins, true);
  assert.equal(page.data.checkinRecords.some(record => record.id === removedId), false);
  assert.equal(page.data.monthlyCount, 44);
  assert.equal(calendarDay(page).isChecked, true);
  page.loadMoreCheckins();
  assert.equal(page.data.checkinRecords.length, 44);
  assert.equal(page.data.hasMoreCheckins, false);
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
