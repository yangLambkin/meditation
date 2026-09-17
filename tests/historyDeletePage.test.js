const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/history/history.js');
const date = '2026-09-17';
const timestamp = Date.parse('2026-09-17T06:30:00+08:00');

function createPage({ records = [], deleteCheckin, confirm = true, getRecords } = {}) {
  let definition;
  let storedRecords = structuredClone(records);
  const calls = { deletes: [], modals: [], toasts: [], counts: [], records: [] };
  const manager = {
    async getDailyCheckinCount(dateStr) {
      calls.counts.push(dateStr);
      return storedRecords.length;
    },
    async getDailyCheckinRecords(dateStr) {
      calls.records.push(dateStr);
      return getRecords ? getRecords(calls.records.length, storedRecords) : structuredClone(storedRecords);
    },
    async deleteCheckin(dateStr, identity) {
      calls.deletes.push([dateStr, identity]);
      if (deleteCheckin) return deleteCheckin(dateStr, identity);
      storedRecords = storedRecords.filter(record => identity.recordId
        ? record._id !== identity.recordId
        : identity.localId
          ? record.localId !== identity.localId
          : record.timestamp !== identity.timestamp);
      return { success: true };
    },
    getExperienceRecordsFromLocal: () => []
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name.endsWith('/checkin.js')) return manager;
      if (name.endsWith('/lunar.js')) return { getLunarDate: () => '八月初七' };
      if (name.endsWith('/dateUtil.js')) return { getBusinessDate: () => date };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    Page(value) { definition = value; },
    wx: {
      showModal(options) {
        calls.modals.push(options);
        if (confirm !== null) options.success({ confirm, cancel: !confirm });
      },
      showToast(options) { calls.toasts.push(options); },
      getStorageSync: () => []
    },
    console: { log() {}, warn() {}, error() {} }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  };
  page.onLoad({ date });
  return { page, calls };
}

function eventFor(record) {
  return { currentTarget: { dataset: { recordKey: record.recordKey } } };
}

test('history loads once on entry and retains identities for records with identical timestamps', async () => {
  const { page, calls } = createPage({ records: [
    { _id: 'first', timestamp, duration: 7 },
    { _id: 'second', timestamp, duration: 13 }
  ] });
  assert.equal(calls.counts.length, 0);
  await page.onShow();
  assert.equal(calls.counts.length, 1);
  assert.equal(calls.records.length, 1);
  assert.equal(page.data.selectedDateKey, date);
  assert.deepEqual(Array.from(page.data.recordList, record => record._id), ['first', 'second']);
  assert.ok(page.data.recordList.every(record => record.timestamp === timestamp));
  assert.equal(new Set(page.data.recordList.map(record => record.recordKey)).size, 2);
  assert.equal(page.data.recordCount, 2);
  assert.equal(page.data.totalDuration, 20);
  assert.equal(page.data.loadingRecords, false);
});

test('cancelling deletion preserves records and statistics without calling the manager', async () => {
  const { page, calls } = createPage({ confirm: false, records: [{ _id: 'keep', timestamp, duration: 7 }] });
  await page.onShow();
  const before = page.data.recordList;
  await page.deleteRecord(eventFor(before[0]));
  assert.equal(calls.modals.length, 1);
  assert.ok(calls.modals[0].content.includes(before[0].time));
  assert.match(calls.modals[0].content, /7 分钟/);
  assert.match(calls.modals[0].content, /不可恢复/);
  assert.equal(calls.deletes.length, 0);
  assert.equal(page.data.recordList, before);
  assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.totalDuration, 7);
  assert.equal(page.data.deleteBusy, false);
});

test('deleting one of two simultaneous records sends its cloud ID and refreshes the totals', async () => {
  const { page, calls } = createPage({ records: [
    { _id: 'keep', timestamp, duration: 7, experience: [{ text: '第一条体验' }, { text: '第二条体验' }] },
    { _id: 'delete', timestamp, duration: 13 }
  ] });
  await page.onShow();
  await page.deleteRecord(eventFor(page.data.recordList[1]));
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.deletes[0][0], date);
  assert.equal(calls.deletes[0][1].recordId, 'delete');
  assert.equal(calls.deletes[0][1].timestamp, timestamp);
  assert.equal(calls.counts.length, 2);
  assert.equal(calls.records.length, 2);
  assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.totalDuration, 7);
  assert.equal(page.data.recordList[0]._id, 'keep');
  assert.deepEqual(Array.from(page.data.recordList[0].experienceTexts), ['第一条体验', '第二条体验']);
  assert.ok(calls.toasts.some(toast => toast.title === '记录已删除'));
});

test('a local identity is passed through and deleting the last record clears all daily totals', async () => {
  const { page, calls } = createPage({ records: [{ localId: 'offline-1', timestamp, duration: 7 }] });
  await page.onShow();
  await page.deleteRecord(eventFor(page.data.recordList[0]));
  assert.equal(calls.deletes[0][1].localId, 'offline-1');
  assert.equal(calls.deletes[0][1].timestamp, timestamp);
  assert.equal(page.data.recordList.length, 0);
  assert.equal(page.data.recordCount, 0);
  assert.equal(page.data.totalDuration, 0);
  assert.equal(page.data.loadingRecords, false);
  assert.equal(page.data.deleteBusy, false);
  assert.equal(page.data.deletingRecordKey, '');
});

test('confirmation and an in-flight deletion both block repeated taps and page-show refreshes', async () => {
  let resolveDeletion;
  const pendingDeletion = new Promise(resolve => { resolveDeletion = resolve; });
  const { page, calls } = createPage({
    records: [{ _id: 'first', timestamp, duration: 7 }],
    confirm: null,
    deleteCheckin: () => pendingDeletion
  });
  await page.onShow();
  const event = eventFor(page.data.recordList[0]);
  const firstAttempt = page.deleteRecord(event);
  assert.equal(page.data.deleteBusy, true);
  assert.equal(page.data.deletingRecordKey, '');
  await page.deleteRecord(event);
  assert.equal(calls.modals.length, 1);
  calls.modals[0].success({ confirm: true });
  await Promise.resolve();
  assert.equal(page.data.deletingRecordKey, event.currentTarget.dataset.recordKey);
  await page.deleteRecord(event);
  await page.onShow();
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.counts.length, 1);
  resolveDeletion({ success: false, error: '请稍后重试' });
  await firstAttempt;
  assert.equal(page.data.deleteBusy, false);
  assert.equal(page.data.deletingRecordKey, '');
});

test('manager failures preserve the record and totals, show an error, and allow retrying', async () => {
  for (const deleteCheckin of [
    () => ({ success: false, error: '网络异常，删除失败' }),
    () => { throw new Error('云服务不可用'); }
  ]) {
    const { page, calls } = createPage({ records: [{ _id: 'keep', timestamp, duration: 7 }], deleteCheckin });
    await page.onShow();
    const before = page.data.recordList;
    await page.deleteRecord(eventFor(before[0]));
    assert.equal(page.data.recordList, before);
    assert.equal(page.data.recordCount, 1);
    assert.equal(page.data.totalDuration, 7);
    assert.equal(calls.counts.length, 1);
    assert.equal(page.data.deleteBusy, false);
    assert.equal(page.data.deletingRecordKey, '');
    assert.ok(calls.toasts.some(toast => /失败/.test(toast.title)));
    await page.deleteRecord(eventFor(before[0]));
    assert.equal(calls.deletes.length, 2);
  }
});

test('a late history request cannot bring a deleted record back into the list', async () => {
  let resolveOldRead;
  const oldRead = new Promise(resolve => { resolveOldRead = resolve; });
  const record = { _id: 'delete', timestamp, duration: 7 };
  const { page } = createPage({
    records: [record],
    getRecords: (readNumber, records) => readNumber === 2 ? oldRead : structuredClone(records)
  });
  await page.onShow();
  const oldLoad = page.onShow();
  await Promise.resolve();
  await page.deleteRecord(eventFor(page.data.recordList[0]));
  assert.equal(page.data.recordCount, 0);
  resolveOldRead([record]);
  await oldLoad;
  assert.equal(page.data.recordList.length, 0);
  assert.equal(page.data.recordCount, 0);
  assert.equal(page.data.totalDuration, 0);
});

test('an outdated button event cannot delete a different record', async () => {
  const { page, calls } = createPage({ records: [{ _id: 'keep', timestamp, duration: 7 }] });
  await page.onShow();
  await page.deleteRecord(eventFor({ recordKey: 'cloud-no-longer-visible' }));
  assert.equal(calls.modals.length, 0);
  assert.equal(calls.deletes.length, 0);
  assert.equal(page.data.recordCount, 1);
});
