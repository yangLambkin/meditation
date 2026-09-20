const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/checkinHistory/checkinHistory.js');
const utilsPath = path.join(__dirname, '../miniprogram/utils');
const plain = value => JSON.parse(JSON.stringify(value));
const silentConsole = { log() {}, warn() {}, error() {} };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function record(id, time, duration = 7, extra = {}) {
  return { _id: id, timestamp: Date.parse(time), duration, experience: [], ...extra };
}

function day(...records) {
  return { count: records.length, records };
}

function createPage(options = {}) {
  let dailyRecords = plain(options.dailyRecords || {});
  let definition;
  let now = Date.parse(options.now || '2026-09-19T12:00:00+08:00');
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  const calls = { cloud: 0, reads: 0, menu: [], modal: [], deleted: [], toast: [], navigate: [], redirect: [], stopRefresh: 0, updates: 0 };
  const checkinManager = {
    getUserCheckinData() {
      calls.reads++;
      if (options.readError && options.readError()) throw new Error('storage unavailable');
      return { dailyRecords };
    },
    getExperienceRecordsFromLocal: ids => (options.experiences || []).filter(value => ids.includes(value._id || value.uniqueId)),
    refreshFromCloud() {
      calls.cloud++;
      return options.refreshFromCloud ? options.refreshFromCloud() : false;
    },
    async deleteCheckin(date, identity) {
      calls.deleted.push({ date, identity: plain(identity) });
      const result = options.remove ? await options.remove(date, identity) : { success: true };
      if (result && result.success) {
        const original = dailyRecords[date];
        if (original) {
          original.records = original.records.filter(value => identity.recordId
            ? value._id !== identity.recordId
            : identity.localId ? value.localId !== identity.localId : value.timestamp !== identity.timestamp);
          original.count = original.records.length;
          if (!original.count) delete dailyRecords[date];
        }
      }
      return result;
    }
  };
  const wx = {
    getStorageSync: key => key === 'meditationTextRecords' ? options.legacyExperiences : undefined,
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigate.push(value),
    redirectTo: value => calls.redirect.push(value),
    showActionSheet(value) {
      calls.menu.push(value);
      if (options.menu) return options.menu(value);
      value.success({ tapIndex: 0 });
    },
    stopPullDownRefresh: () => { calls.stopRefresh++; },
    showModal(value) {
      calls.modal.push(value);
      if (options.modal) return options.modal(value);
      value.success({ confirm: options.confirm !== false });
    }
  };
  const modules = { 'checkin.js': checkinManager };
  function loadModule(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js', 'memberHistory.js'].includes(filename), `Unexpected dependency: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(utilsPath, filename), 'utf8'), {
      module, require: loadModule, wx, Date: ClockDate, console: silentConsole
    }, { filename });
    if (filename === 'dateUtil.js') module.exports.watchBusinessDate = () => () => {};
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: loadModule, Page: value => { definition = value; }, wx, Date: ClockDate, console: silentConsole
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) {
      Object.assign(this.data, values);
      calls.updates++;
    }
  };
  page.onLoad(options.query || {});
  return {
    page, calls,
    setRecords(value) { dailyRecords = plain(value); },
    setNow(value) { now = Date.parse(value); }
  };
}

function deletionEvent(record) {
  return { currentTarget: { dataset: { id: record.id } } };
}

test('all months are cached but only the selected month renders, using the 02:00 boundary', async () => {
  const pending = deferred();
  const { page } = createPage({
    dailyRecords: {
      '2026-08-30': day(record('older-august', '2026-08-30T23:00:00+08:00', 10)),
      '2026-09-02': day(record('september-2', '2026-09-02T02:00:00+08:00', 20)),
      '2026-09-01': day(
        record('late-august', '2026-09-01T01:59:00+08:00', 30),
        record('september-1', '2026-09-01T02:00:00+08:00', 40)
      ),
      '2026-01-01': day(record('last-year', '2026-01-01T01:59:00+08:00', 50))
    },
    refreshFromCloud: () => pending.promise
  });
  const showing = page.onShow();
  const months = plain(page._allCheckinMonths);
  assert.equal(page.data.checkinTotal, 5);
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.deepEqual(plain(page.data.monthDays).map(day => day.date), ['2026-09-02', '2026-09-01']);
  assert.equal(page.data.monthCount, 2);
  assert.equal(page.data.monthDuration, 60);
  assert.equal(page.data.monthDayCount, 2);
  assert.deepEqual(months.map(month => month.month), ['2026-09', '2026-08', '2025-12']);
  assert.deepEqual(months.map(month => [month.count, month.totalDuration]), [[2, 60], [2, 40], [1, 50]]);
  assert.deepEqual(months[0].days.map(value => value.date), ['2026-09-02', '2026-09-01']);
  assert.deepEqual(months[1].days.map(value => value.date), ['2026-08-31', '2026-08-30']);
  assert.equal(months[1].days[0].records[0].timeLabel, '次日 01:59');
  assert.equal(months[1].days[0].records[0].date, '2026-09-01');
  assert.equal(months[2].days[0].date, '2025-12-31');
  pending.resolve(false);
  await showing;
});

test('monthly records retain emotions and inline, stored and legacy experience text', async () => {
  const { page } = createPage({
    dailyRecords: {
      '2026-09-01': day(record('one', '2026-09-01T06:30:00+08:00', 15, {
        emotion: ['平静', '喜悦'],
        experience: [{ text: '觉察呼吸' }, 'stored-note', 'legacy-note']
      }))
    },
    experiences: [{ _id: 'stored-note', text: '身体放松' }],
    legacyExperiences: [{ uniqueId: 'legacy-note', text: '保持觉知' }]
  });
  await page.onShow();
  const item = plain(page._allCheckinMonths[0].days[0].records[0]);
  assert.deepEqual(item.emotion, ['平静', '喜悦']);
  assert.deepEqual(item.experienceTexts, ['觉察呼吸', '身体放松', '保持觉知']);
});

test('successful cloud refresh replaces the local month list with newly read complete records', async () => {
  const pending = deferred();
  const { page, calls, setRecords } = createPage({
    dailyRecords: { '2026-09-01': day(record('local', '2026-09-01T06:30:00+08:00')) },
    refreshFromCloud: () => pending.promise
  });
  const showing = page.onShow();
  assert.equal(page.data.checkinTotal, 1);
  setRecords({
    '2026-08-01': day(record('cloud-august', '2026-08-01T06:30:00+08:00')),
    '2026-07-01': day(record('cloud-july', '2026-07-01T06:30:00+08:00'))
  });
  pending.resolve(true);
  assert.equal(await showing, true);
  assert.equal(calls.cloud, 1);
  assert.equal(page.data.checkinTotal, 2);
  assert.deepEqual(plain(page._allCheckinMonths).map(value => value.month), ['2026-08', '2026-07']);
});

test('returning to the page reads records again so edits and deletions from another page are visible', async () => {
  const { page, setRecords, calls } = createPage({
    dailyRecords: { '2026-09-01': day(record('old', '2026-09-01T06:30:00+08:00')) }
  });
  await page.onShow();
  setRecords({ '2026-08-01': day(record('new', '2026-08-01T06:30:00+08:00', 30)) });
  await page.onShow();
  assert.equal(calls.cloud, 2);
  assert.equal(page.data.checkinTotal, 1);
  assert.equal(page._allCheckinMonths[0].month, '2026-08');
  assert.equal(page._allCheckinMonths[0].totalDuration, 30);
});

test('overlapping page entry and pull-down share one cloud request and stop the refresh indicator', async () => {
  const pending = deferred();
  const { page, calls, setRecords } = createPage({ refreshFromCloud: () => pending.promise });
  const showing = page.onShow();
  setRecords({ '2026-08-01': day(record('new-local', '2026-08-01T06:30:00+08:00')) });
  const pulling = page.onPullDownRefresh();
  assert.equal(page.data.checkinTotal, 1);
  await Promise.resolve();
  assert.equal(calls.cloud, 1);
  assert.equal(calls.stopRefresh, 0);
  pending.resolve(true);
  await Promise.all([showing, pulling]);
  assert.equal(calls.stopRefresh, 1);
  assert.equal(page.data.checkinTotal, 1);
});

test('cloud failures preserve local records and release the request lock for pull-down retry', async () => {
  const { page, calls } = createPage({
    dailyRecords: { '2026-09-01': day(record('local', '2026-09-01T06:30:00+08:00')) },
    refreshFromCloud: () => Promise.reject(new Error('offline'))
  });
  assert.equal(await page.onShow(), false);
  const before = plain(page._allCheckinMonths);
  await page.onPullDownRefresh();
  assert.deepEqual(plain(page._allCheckinMonths), before);
  assert.equal(page.data.checkinTotal, 1);
  assert.equal(calls.cloud, 2);
  assert.equal(calls.stopRefresh, 1);
});

test('empty data has zero records and no month headings, including after cloud removes the last record', async () => {
  const empty = createPage();
  await empty.page.onShow();
  assert.equal(empty.page.data.checkinTotal, 0);
  assert.deepEqual(plain(empty.page._allCheckinMonths), []);

  const pending = deferred();
  const { page, setRecords } = createPage({
    dailyRecords: { '2026-09-01': day(record('local', '2026-09-01T06:30:00+08:00')) },
    refreshFromCloud: () => pending.promise
  });
  const showing = page.onShow();
  setRecords({});
  pending.resolve(true);
  await showing;
  assert.equal(page.data.checkinTotal, 0);
  assert.deepEqual(plain(page._allCheckinMonths), []);
});

test('opening a record grouped into the preceding month navigates to its logical date', async () => {
  const { page, calls } = createPage({
    dailyRecords: { '2026-09-01': day(record('late', '2026-09-01T01:30:00+08:00')) }
  });
  await page.onShow();
  const item = page._allCheckinMonths[0].days[0].records[0];
  assert.equal(page._allCheckinMonths[0].month, '2026-08');
  page.openCheckinHistory({ currentTarget: { dataset: { date: item.dayDate } } });
  assert.equal(calls.navigate[0].url, '/pages/history/history?date=2026-08-31');
});

test('deleting uses the original date and stable identity, recalculates month totals and removes empty days and months', async () => {
  const late = record('late', '2026-09-01T01:30:00+08:00', 20, { localId: 'local-late' });
  const { page, calls } = createPage({
    dailyRecords: {
      '2026-09-01': day(late, record('september', '2026-09-01T02:00:00+08:00', 30)),
      '2026-08-30': day(record('august', '2026-08-30T05:00:00+08:00', 10))
    }
  });
  await page.onShow();
  page.selectMonth('2026-08');
  const august = page._allCheckinMonths[1];
  assert.equal(august.count, 2);
  assert.equal(august.totalDuration, 30);
  await page.deleteCheckinRecord(deletionEvent(august.days[0].records[0]));
  assert.deepEqual(calls.deleted[0], {
    date: '2026-09-01', identity: { recordId: 'late', localId: 'local-late', timestamp: late.timestamp }
  });
  assert.match(calls.modal[0].content, /2026-08-31 次日 01:30/);
  assert.equal(page.data.checkinTotal, 2);
  assert.equal(page._allCheckinMonths[0].count, 1);
  assert.equal(page._allCheckinMonths[0].totalDuration, 30);
  assert.equal(page._allCheckinMonths[1].count, 1);
  assert.equal(page._allCheckinMonths[1].totalDuration, 10);
  assert.equal(page._allCheckinMonths[1].days.length, 1);
  await page.deleteCheckinRecord(deletionEvent(page._allCheckinMonths[1].days[0].records[0]));
  assert.deepEqual(plain(page._allCheckinMonths).map(value => value.month), ['2026-09']);
  page.selectMonth('2026-09');
  await page.deleteCheckinRecord(deletionEvent(page._allCheckinMonths[0].days[0].records[0]));
  assert.equal(page.data.checkinTotal, 0);
  assert.deepEqual(plain(page._allCheckinMonths), []);
  assert.equal(page.data.checkinDeleting, false);
  assert.equal(page.data.deletingCheckinId, '');
});

test('cancelling deletion preserves the record and unlocks the page', async () => {
  const { page, calls } = createPage({
    dailyRecords: { '2026-09-01': day(record('one', '2026-09-01T06:30:00+08:00')) }, confirm: false
  });
  await page.onShow();
  await page.deleteCheckinRecord(deletionEvent(page._allCheckinMonths[0].days[0].records[0]));
  assert.equal(calls.modal.length, 1);
  assert.equal(calls.deleted.length, 0);
  assert.equal(page.data.checkinTotal, 1);
  assert.equal(page.data.checkinDeleting, false);
});

test('pending confirmation and deletion prevent duplicate attempts', async () => {
  const confirmation = deferred();
  const removal = deferred();
  const { page, calls } = createPage({
    dailyRecords: { '2026-09-01': day(record('one', '2026-09-01T06:30:00+08:00')) },
    modal: () => confirmation.promise,
    remove: () => removal.promise
  });
  await page.onShow();
  const item = page._allCheckinMonths[0].days[0].records[0];
  const event = deletionEvent(item);
  const deleting = page.deleteCheckinRecord(event);
  await page.deleteCheckinRecord(event);
  await new Promise(setImmediate);
  assert.equal(calls.menu.length, 1);
  assert.equal(calls.modal.length, 1);
  assert.equal(calls.deleted.length, 0);
  assert.equal(page.data.checkinDeleting, true);
  confirmation.resolve({ confirm: true });
  await new Promise(setImmediate);
  assert.equal(page.data.deletingCheckinId, item.id);
  assert.equal(calls.deleted.length, 1);
  await page.deleteCheckinRecord(event);
  assert.equal(calls.deleted.length, 1);
  removal.resolve({ success: true });
  await deleting;
  assert.equal(page.data.checkinTotal, 0);
  assert.equal(page.data.checkinDeleting, false);
});

test('failed deletion preserves data, reports failure and permits retry', async () => {
  for (const failure of [{ success: false, error: '同步失败' }, new Error('offline')]) {
    let fail = true;
    const { page, calls } = createPage({
      dailyRecords: { '2026-09-01': day(record('one', '2026-09-01T06:30:00+08:00')) },
      remove() {
        if (!fail) return { success: true };
        if (failure instanceof Error) throw failure;
        return failure;
      }
    });
    await page.onShow();
    const event = deletionEvent(page._allCheckinMonths[0].days[0].records[0]);
    await page.deleteCheckinRecord(event);
    assert.equal(page.data.checkinTotal, 1);
    assert.equal(page.data.checkinDeleting, false);
    assert.equal(page.data.deletingCheckinId, '');
    assert.equal(calls.toast[0].icon, 'none');
    fail = false;
    await page.deleteCheckinRecord(event);
    assert.equal(page.data.checkinTotal, 0);
    assert.equal(calls.deleted.length, 2);
  }
});

test('a stale or another month record tap does not open a deletion dialog or call the manager', async () => {
  const { page, calls } = createPage({ dailyRecords: {
    '2026-08-01': day(record('previous-month', '2026-08-01T06:00:00+08:00'))
  } });
  await page.onShow();
  await page.deleteCheckinRecord({ currentTarget: { dataset: { id: 'missing' } } });
  await page.deleteCheckinRecord(deletionEvent(page._allCheckinRecords[0]));
  assert.equal(calls.menu.length, 0);
  assert.equal(calls.modal.length, 0);
  assert.equal(calls.deleted.length, 0);
});

test('cloud completion after leaving the page does not update an unloaded page', async () => {
  const pending = deferred();
  const { page, calls, setRecords } = createPage({ refreshFromCloud: () => pending.promise });
  const showing = page.onShow();
  const updatesBeforeUnload = calls.updates;
  page.onUnload();
  setRecords({ '2026-09-01': day(record('one', '2026-09-01T06:30:00+08:00')) });
  pending.resolve(true);
  await showing;
  assert.equal(calls.updates, updatesBeforeUnload);
});

test('previous and next month cross year boundaries and stop at the current logical month', async () => {
  const { page, calls } = createPage({ now: '2026-01-10T12:00:00+08:00' });
  await page.onShow();
  assert.equal(page.data.selectedMonth, '2026-01');
  assert.equal(page.data.canGoNext, false);
  page.nextMonth();
  assert.equal(page.data.selectedMonth, '2026-01');
  page.previousMonth();
  assert.equal(page.data.selectedMonth, '2025-12');
  assert.equal(page.data.selectedMonthLabel, '2025年12月');
  assert.equal(page.data.canGoNext, true);
  page.nextMonth();
  assert.equal(page.data.selectedMonth, '2026-01');
  assert.equal(calls.reads, 1, 'month changes project the local cache without rereading storage');
});

test('month picker jumps directly, renders empty months and ignores invalid or future input', async () => {
  const { page } = createPage({ dailyRecords: {
    '2026-09-01': day(record('september', '2026-09-01T06:00:00+08:00', 30)),
    '2025-12-31': day(record('december', '2025-12-31T06:00:00+08:00', 20))
  } });
  await page.onShow();
  page.changeMonth({ detail: { value: '2025-12' } });
  assert.equal(page.data.selectedMonth, '2025-12');
  assert.equal(page.data.monthCount, 1);
  assert.equal(page.data.monthDuration, 20);
  page.changeMonth({ detail: { value: '2026-07' } });
  assert.equal(page.data.selectedMonth, '2026-07');
  assert.equal(page.data.monthCount, 0);
  assert.equal(page.data.monthDuration, 0);
  assert.equal(page.data.monthDayCount, 0);
  assert.deepEqual(plain(page.data.monthDays), []);
  for (const value of ['2026-10', '2026-13', 'invalid', '', '2026-01-01']) {
    page.changeMonth({ detail: { value } });
    assert.equal(page.data.selectedMonth, '2026-07');
  }
  page.goToCurrentMonth();
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(page.data.monthCount, 1);
  assert.equal(page.data.monthDuration, 30);
});

test('month defaults and limits use 02:00 Beijing time, and refresh preserves the selected month across the boundary', async () => {
  const { page, setNow } = createPage({ now: '2026-09-01T01:59:59+08:00' });
  await page.onShow();
  assert.equal(page.data.currentDate, '2026-08-31');
  assert.equal(page.data.currentMonth, '2026-08');
  assert.equal(page.data.selectedMonth, '2026-08');
  page.nextMonth();
  assert.equal(page.data.selectedMonth, '2026-08');
  setNow('2026-09-01T02:00:00+08:00');
  await page.onPullDownRefresh();
  assert.equal(page.data.currentMonth, '2026-09');
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.canGoNext, true);
  page.goToCurrentMonth();
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(page.data.canGoNext, false);
});

test('query month is validated and dates preserve a logical day when returning to daily mode', async () => {
  const { page, calls } = createPage({ query: { month: '2026-08', date: '2026-08-12' } });
  await page.onShow();
  assert.equal(page.data.selectedMonth, '2026-08');
  page.openDailyView();
  assert.equal(calls.redirect[0].url, '/pages/history/history?date=2026-08-12');
  page.goToCurrentMonth();
  page.openDailyView();
  assert.equal(calls.redirect[1].url, '/pages/history/history?date=2026-09-19');
  for (const query of [{ month: '2026-13' }, { month: '2027-01' }, { date: '2026-02-30' }, { date: '2027-01-01' }]) {
    const invalid = createPage({ query });
    assert.equal(invalid.page.data.selectedMonth, '2026-09');
  }
});

test('daily mode opens the latest recorded logical day in a historical month, or its first day when empty', async () => {
  const { page, calls } = createPage({ query: { month: '2026-08' }, dailyRecords: {
    '2026-09-01': day(record('late-august', '2026-09-01T01:30:00+08:00')),
    '2026-08-11': day(record('august', '2026-08-11T06:00:00+08:00'))
  } });
  await page.onShow();
  page.openDailyView();
  assert.equal(calls.redirect[0].url, '/pages/history/history?date=2026-08-31');
  page.previousMonth();
  page.openDailyView();
  assert.equal(calls.redirect[1].url, '/pages/history/history?date=2026-07-01');
});

test('cloud refresh, pull-down and returning preserve the chosen month and keep an empty selection', async () => {
  const cloud = deferred();
  const { page, setRecords } = createPage({
    query: { month: '2026-08' },
    dailyRecords: { '2026-08-11': day(record('local', '2026-08-11T06:00:00+08:00')) },
    refreshFromCloud: () => cloud.promise
  });
  const showing = page.onShow();
  page.previousMonth();
  setRecords({ '2026-09-01': day(record('cloud', '2026-09-01T06:00:00+08:00')) });
  cloud.resolve(true);
  await showing;
  assert.equal(page.data.selectedMonth, '2026-07');
  assert.equal(page.data.monthCount, 0);
  await page.onPullDownRefresh();
  await page.onShow();
  assert.equal(page.data.selectedMonth, '2026-07');
  assert.equal(page.data.monthCount, 0);
});

test('storage read failure preserves a consistent selected month and cached month switching still works', async () => {
  let unavailable = false;
  const { page, calls } = createPage({ readError: () => unavailable, dailyRecords: {
    '2026-09-01': day(record('september', '2026-09-01T06:00:00+08:00', 30)),
    '2026-08-31': day(record('august', '2026-08-31T06:00:00+08:00', 20))
  } });
  await page.onShow();
  unavailable = true;
  await page.onPullDownRefresh();
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(page.data.monthDuration, 30);
  page.previousMonth();
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.selectedMonthLabel, '2026年8月');
  assert.equal(page.data.monthDuration, 20);
  await page.onShow();
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.monthDays[0].date, '2026-08-31');
  assert.equal(calls.stopRefresh, 1);
});

test('cancelled and failed action menus never show a delete confirmation or delete records', async () => {
  for (const menu of [
    value => value.fail({ errMsg: 'showActionSheet:fail cancel' }),
    () => Promise.reject(new Error('menu unavailable')),
    value => value.success({ tapIndex: 1 })
  ]) {
    const { page, calls } = createPage({ menu, dailyRecords: {
      '2026-09-01': day(record('one', '2026-09-01T06:00:00+08:00'))
    } });
    await page.onShow();
    await page.deleteCheckinRecord(deletionEvent(page.data.monthDays[0].records[0]));
    assert.equal(calls.menu.length, 1);
    assert.equal(calls.modal.length, 0);
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.toast.length, 0);
    assert.equal(page.data.checkinDeleting, false);
    assert.equal(page.data.monthCount, 1);
  }
});

test('pending menu blocks duplicate actions and month navigation, then unload prevents confirmation', async () => {
  const menu = deferred();
  const { page, calls } = createPage({ menu: () => menu.promise, dailyRecords: {
    '2026-09-01': day(record('one', '2026-09-01T06:00:00+08:00'))
  } });
  await page.onShow();
  const event = deletionEvent(page.data.monthDays[0].records[0]);
  const deleting = page.deleteCheckinRecord(event);
  await page.deleteCheckinRecord(event);
  page.previousMonth();
  page.openDailyView();
  assert.equal(calls.menu.length, 1);
  assert.equal(page.data.selectedMonth, '2026-09');
  assert.equal(calls.redirect.length, 0);
  const updatesBeforeUnload = calls.updates;
  page.onUnload();
  menu.resolve({ tapIndex: 0 });
  await deleting;
  assert.equal(calls.modal.length, 0);
  assert.equal(calls.deleted.length, 0);
  assert.equal(calls.updates, updatesBeforeUnload);
});

test('deleting the final record keeps the selected historical month with zero summaries', async () => {
  const { page } = createPage({ query: { month: '2026-08' }, dailyRecords: {
    '2026-09-01': day(record('late-august', '2026-09-01T01:30:00+08:00'))
  } });
  await page.onShow();
  await page.deleteCheckinRecord(deletionEvent(page.data.monthDays[0].records[0]));
  assert.equal(page.data.selectedMonth, '2026-08');
  assert.equal(page.data.monthCount, 0);
  assert.equal(page.data.monthDuration, 0);
  assert.equal(page.data.monthDayCount, 0);
  assert.deepEqual(plain(page.data.monthDays), []);
});

test('leaving during confirmation prevents deletion, and leaving during deletion prevents later view updates', async () => {
  const modal = deferred();
  const first = createPage({ modal: () => modal.promise, dailyRecords: {
    '2026-09-01': day(record('one', '2026-09-01T06:00:00+08:00'))
  } });
  await first.page.onShow();
  const confirming = first.page.deleteCheckinRecord(deletionEvent(first.page.data.monthDays[0].records[0]));
  await new Promise(setImmediate);
  first.page.onUnload();
  modal.resolve({ confirm: true });
  await confirming;
  assert.equal(first.calls.deleted.length, 0);

  const removal = deferred();
  const second = createPage({ remove: () => removal.promise, dailyRecords: {
    '2026-09-01': day(record('one', '2026-09-01T06:00:00+08:00'))
  } });
  await second.page.onShow();
  const deleting = second.page.deleteCheckinRecord(deletionEvent(second.page.data.monthDays[0].records[0]));
  await new Promise(setImmediate);
  const updatesBeforeUnload = second.calls.updates;
  second.page.onUnload();
  removal.resolve({ success: true });
  await deleting;
  assert.equal(second.calls.deleted.length, 1);
  assert.equal(second.calls.updates, updatesBeforeUnload);
  assert.equal(second.calls.toast.length, 0);
});
