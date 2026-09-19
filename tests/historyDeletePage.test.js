const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/history/history.js');
const utilsPath = path.join(__dirname, '../miniprogram/utils');
const plain = value => JSON.parse(JSON.stringify(value));
const date = '2026-09-17';
const silentConsole = { log() {}, warn() {}, error() {} };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function record(id, time, duration = 7, extra = {}) {
  return { _id: id, timestamp: Date.parse(time), duration, ...extra };
}

function day(...records) {
  return { count: records.length, records };
}

function createPage(options = {}) {
  let dailyRecords = plain(options.dailyRecords || {});
  let now = Date.parse(options.now || '2026-09-19T12:00:00+08:00');
  let definition;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const calls = { cloud: 0, reads: 0, actions: [], modals: [], deletes: [], toasts: [], redirects: [], stopRefresh: 0, updates: 0 };
  const manager = {
    getUserCheckinData() {
      calls.reads++;
      if (options.readRecords) return options.readRecords(dailyRecords);
      return { dailyRecords };
    },
    getExperienceRecordsFromLocal: ids => (options.experiences || []).filter(value => ids.includes(value._id || value.uniqueId)),
    refreshFromCloud() {
      calls.cloud++;
      return options.refreshFromCloud ? options.refreshFromCloud() : false;
    },
    async deleteCheckin(dateStr, identity) {
      calls.deletes.push([dateStr, plain(identity)]);
      const result = options.deleteCheckin ? await options.deleteCheckin(dateStr, identity) : { success: true };
      if (result && result.success && dailyRecords[dateStr]) {
        dailyRecords[dateStr].records = dailyRecords[dateStr].records.filter(value => identity.recordId
          ? value._id !== identity.recordId
          : identity.localId ? value.localId !== identity.localId : value.timestamp !== identity.timestamp);
        dailyRecords[dateStr].count = dailyRecords[dateStr].records.length;
      }
      return result;
    }
  };
  const wx = {
    getStorageSync: () => options.legacyExperiences || [],
    showActionSheet(value) {
      calls.actions.push(value);
      if (options.action) return options.action(value);
      if (options.cancelAction) value.fail({ errMsg: 'showActionSheet:fail cancel' });
      else value.success({ tapIndex: 0 });
    },
    showModal(value) {
      calls.modals.push(value);
      if (options.modal) return options.modal(value);
      value.success({ confirm: options.confirm !== false });
    },
    showToast: value => calls.toasts.push(value),
    redirectTo: value => calls.redirects.push(value),
    stopPullDownRefresh: () => { calls.stopRefresh++; }
  };
  const modules = { 'checkin.js': manager, 'lunar.js': { getLunarDate: () => '丙午年八月初七' } };
  function loadModule(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js', 'memberHistory.js'].includes(filename), `Unexpected dependency: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(utilsPath, filename), 'utf8'), {
      module, require: loadModule, wx, Date: FixedDate, console: silentConsole
    }, { filename });
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: loadModule,
    Page: value => { definition = value; }, wx, Date: FixedDate, console: silentConsole
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) {
      Object.assign(this.data, values);
      calls.updates++;
    }
  };
  page.onLoad(options.route || { date });
  return { page, calls, setRecords(value) { dailyRecords = plain(value); }, setNow(value) { now = Date.parse(value); } };
}

function eventFor(item) {
  return { currentTarget: { dataset: { recordKey: item.recordKey } } };
}

const twoRecords = () => ({ [date]: day(
  record('first', `${date}T06:30:00+08:00`, 7),
  record('second', `${date}T06:30:00+08:00`, 13)
) });

test('daily records render immediately from local data, retain stable identities and use record counts', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ dailyRecords: twoRecords(), refreshFromCloud: () => pending.promise });
  assert.equal(calls.reads, 0);
  const showing = page.onShow();
  assert.equal(calls.reads, 1);
  assert.equal(page.data.recordCount, 2);
  assert.equal(page.data.totalDuration, 20);
  assert.equal(page.data.loadingRecords, false);
  assert.equal(new Set(page.data.recordList.map(item => item.recordKey)).size, 2);
  pending.resolve(false);
  await showing;
});

test('04:00 logical day includes midnight and next-day records across original storage buckets', async () => {
  const { page } = createPage({
    route: { date: '2026-08-31' },
    dailyRecords: {
      '2026-08-31': day(record('too-early', '2026-08-31T03:59:59+08:00'), record('start', '2026-08-31T04:00:00+08:00', 10)),
      '2026-09-01': day(record('midnight', '2026-09-01T00:00:00+08:00', 20), record('late', '2026-09-01T03:59:59+08:00', 30), record('next-day', '2026-09-01T04:00:00+08:00'))
    }
  });
  await page.onShow();
  assert.deepEqual(plain(page.data.recordList.map(item => item._id)), ['late', 'midnight', 'start']);
  assert.deepEqual(plain(page.data.recordList.map(item => item.timeLabel)), ['次日 03:59', '次日 00:00', '04:00']);
  assert.equal(page.data.recordList[0].date, '2026-09-01');
  assert.equal(page.data.recordList[0].dayDate, '2026-08-31');
  assert.equal(page.data.totalDuration, 60);
});

test('daily experience and emotion preserve inline, unified and legacy values without empty placeholders', async () => {
  const { page } = createPage({
    dailyRecords: { [date]: day(record('one', `${date}T06:30:00+08:00`, 7, {
      emotion: ['平静'], experience: [{ text: '呼吸' }, 'stored', 'legacy']
    }), record('empty', `${date}T07:00:00+08:00`)) },
    experiences: [{ _id: 'stored', text: '身体' }],
    legacyExperiences: [{ uniqueId: 'legacy', text: '觉察' }]
  });
  await page.onShow();
  assert.deepEqual(plain(page.data.recordList[0].experienceTexts), []);
  assert.deepEqual(plain(page.data.recordList[1].emotion), ['平静']);
  assert.deepEqual(plain(page.data.recordList[1].experienceTexts), ['呼吸', '身体', '觉察']);
});

test('invalid or future route dates default to the current 04:00 logical day', () => {
  for (const value of ['2026-02-30', 'not-a-date', '2026年9月17日', '2026-09-19', undefined]) {
    const { page } = createPage({ route: { date: value }, now: '2026-09-19T03:59:59+08:00' });
    assert.equal(page.data.selectedDateKey, '2026-09-18');
    assert.equal(page.data.todayDate, '2026-09-18');
    assert.equal(page.data.canGoNext, false);
  }
});

test('date arrows and picker cross month/year/leap boundaries, show empty dates and enforce today', async () => {
  const { page } = createPage({ route: { date: '2026-01-01' }, dailyRecords: twoRecords() });
  await page.onShow();
  page.previousDay();
  assert.equal(page.data.selectedDateKey, '2025-12-31');
  page.nextDay();
  assert.equal(page.data.selectedDateKey, '2026-01-01');
  page.onDateChange({ detail: { value: '2024-03-01' } });
  page.previousDay();
  assert.equal(page.data.selectedDateKey, '2024-02-29');
  assert.equal(page.data.recordCount, 0);
  page.onDateChange({ detail: { value: date } });
  assert.equal(page.data.recordCount, 2);
  page.onDateChange({ detail: { value: '2026-02-30' } });
  assert.equal(page.data.selectedDateKey, date);
  page.goToday();
  assert.equal(page.data.selectedDateKey, '2026-09-19');
  assert.equal(page.data.canGoNext, false);
  page.nextDay();
  assert.equal(page.data.selectedDateKey, '2026-09-19');
});

test('a failed read after changing date cannot display the previous day beneath the new heading', async () => {
  let failRead = false;
  const { page, calls } = createPage({
    dailyRecords: twoRecords(),
    readRecords(dailyRecords) {
      if (failRead) throw new Error('storage unavailable');
      return { dailyRecords };
    }
  });
  await page.onShow();
  assert.equal(page.data.recordCount, 2);
  failRead = true;
  page.previousDay();
  assert.equal(page.data.selectedDateKey, '2026-09-16');
  assert.equal(page.data.recordCount, 0);
  assert.equal(page.data.totalDuration, 0);
  assert.deepEqual(plain(page.data.recordList), []);
  assert.equal(page.data.loadingRecords, false);
  assert.ok(calls.toasts.some(value => /加载记录失败/.test(value.title)));
});

test('showing or refreshing the page preserves the chosen historical day and updates the current-day bound', async () => {
  const { page, setNow } = createPage({ now: '2026-09-19T03:59:59+08:00', route: { date: '2026-09-18' } });
  await page.onShow();
  assert.equal(page.data.isToday, true);
  setNow('2026-09-19T04:00:00+08:00');
  await page.onShow();
  assert.equal(page.data.selectedDateKey, '2026-09-18');
  assert.equal(page.data.canGoNext, true);
  await page.onPullDownRefresh();
  assert.equal(page.data.selectedDateKey, '2026-09-18');
  page.goToday();
  assert.equal(page.data.selectedDateKey, '2026-09-19');
});

test('switching to month and sharing carry machine-readable logical dates', () => {
  const { page, calls } = createPage({ route: { date: '2026-08-31' } });
  page.openMonthlyHistory();
  assert.equal(calls.redirects[0].url, '/pages/checkinHistory/checkinHistory?month=2026-08&date=2026-08-31');
  assert.equal(page.onShareAppMessage().path, '/pages/history/history?date=2026-08-31');
});

test('cancelling the more menu or confirmation preserves records and releases the lock', async () => {
  for (const options of [{ cancelAction: true }, { confirm: false }]) {
    const { page, calls } = createPage({ dailyRecords: twoRecords(), ...options });
    await page.onShow();
    await page.showRecordActions(eventFor(page.data.recordList[0]));
    assert.deepEqual(plain(calls.actions[0].itemList), ['删除记录']);
    assert.equal(calls.modals.length, options.cancelAction ? 0 : 1);
    assert.equal(calls.deletes.length, 0);
    assert.equal(page.data.recordCount, 2);
    assert.equal(page.data.totalDuration, 20);
    assert.equal(page.data.deleteBusy, false);
    assert.equal(page.data.deletingRecordKey, '');
  }
});

test('deletion uses the original storage bucket and stable ID for a next-day record', async () => {
  const late = record('late', '2026-09-01T03:30:00+08:00', 20, { localId: 'local-late' });
  const { page, calls } = createPage({
    route: { date: '2026-08-31' },
    dailyRecords: { '2026-09-01': day(late, record('keep', '2026-09-01T05:00:00+08:00', 30)) }
  });
  await page.onShow();
  await page.showRecordActions(eventFor(page.data.recordList[0]));
  assert.deepEqual(calls.deletes[0], ['2026-09-01', { recordId: 'late', timestamp: late.timestamp, localId: 'local-late' }]);
  assert.match(calls.modals[0].content, /2026-08-31 次日 03:30/);
  assert.match(calls.modals[0].content, /20 分钟.*不可恢复/);
  assert.equal(page.data.selectedDateKey, '2026-08-31');
  assert.equal(page.data.recordCount, 0);
  assert.equal(page.data.totalDuration, 0);
  assert.ok(calls.toasts.some(value => value.title === '记录已删除'));
  page.nextDay();
  assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.recordList[0]._id, 'keep');
});

test('deletion preserves the other record when timestamps collide and supports local-only identities', async () => {
  const { page, calls } = createPage({ dailyRecords: twoRecords() });
  await page.onShow();
  const target = page.data.recordList.find(item => item._id === 'second');
  await page.showRecordActions(eventFor(target));
  assert.equal(calls.deletes[0][1].recordId, 'second');
  assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.totalDuration, 7);
  const local = createPage({ dailyRecords: { [date]: day(record(null, `${date}T06:30:00+08:00`, 7, { localId: 'offline' })) } });
  await local.page.onShow();
  await local.page.showRecordActions(eventFor(local.page.data.recordList[0]));
  assert.equal(local.calls.deletes[0][1].localId, 'offline');
  assert.equal(local.page.data.recordCount, 0);
});

test('menu, confirmation and deletion all block duplicate taps while date changes remain safe', async () => {
  const action = deferred();
  const confirmation = deferred();
  const deletion = deferred();
  const { page, calls } = createPage({ dailyRecords: twoRecords(), action: () => action.promise, modal: () => confirmation.promise, deleteCheckin: () => deletion.promise });
  await page.onShow();
  const event = eventFor(page.data.recordList[0]);
  const deleting = page.showRecordActions(event);
  await page.showRecordActions(event);
  assert.equal(calls.actions.length, 1);
  action.resolve({ tapIndex: 0 });
  await Promise.resolve();
  await Promise.resolve();
  await page.showRecordActions(event);
  assert.equal(calls.modals.length, 1);
  confirmation.resolve({ confirm: true });
  await Promise.resolve();
  await Promise.resolve();
  await page.showRecordActions(event);
  await page.onShow();
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.cloud, 1);
  page.previousDay();
  assert.equal(page.data.selectedDateKey, '2026-09-16');
  deletion.resolve({ success: true });
  await deleting;
  assert.equal(page.data.selectedDateKey, '2026-09-16');
  assert.equal(page.data.recordCount, 0);
  assert.equal(page.data.deleteBusy, false);
});

test('deletion failures preserve data, report errors and allow another attempt', async () => {
  for (const failure of [{ success: false, error: '网络异常，删除失败' }, new Error('offline')]) {
    const { page, calls } = createPage({ dailyRecords: twoRecords(), deleteCheckin: () => {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    await page.onShow();
    const event = eventFor(page.data.recordList[0]);
    await page.showRecordActions(event);
    assert.equal(page.data.recordCount, 2);
    assert.equal(page.data.totalDuration, 20);
    assert.equal(page.data.deleteBusy, false);
    assert.ok(calls.toasts.some(value => /失败/.test(value.title)));
    await page.showRecordActions(event);
    assert.equal(calls.deletes.length, 2);
  }
});

test('stale button events cannot open the menu or delete a different record', async () => {
  const { page, calls } = createPage({ dailyRecords: twoRecords() });
  await page.onShow();
  const event = eventFor(page.data.recordList[0]);
  page.previousDay();
  await page.showRecordActions(event);
  assert.equal(calls.actions.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test('cloud completion and shared pull-down refresh only render the currently selected day', async () => {
  const pending = deferred();
  const { page, calls, setRecords } = createPage({ dailyRecords: twoRecords(), refreshFromCloud: () => pending.promise });
  const showing = page.onShow();
  page.previousDay();
  const pulling = page.onPullDownRefresh();
  setRecords({ '2026-09-16': day(record('new', '2026-09-16T05:00:00+08:00', 30)), ...twoRecords() });
  pending.resolve(true);
  await Promise.all([showing, pulling]);
  assert.equal(calls.cloud, 1);
  assert.equal(calls.stopRefresh, 1);
  assert.equal(page.data.selectedDateKey, '2026-09-16');
  assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.totalDuration, 30);
  assert.equal(page.data.recordList[0]._id, 'new');
});

test('cloud callbacks from before deletion cannot repaint deleted records', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ dailyRecords: twoRecords(), refreshFromCloud: () => pending.promise });
  const showing = page.onShow();
  await page.showRecordActions(eventFor(page.data.recordList[0]));
  const readsAfterDeletion = calls.reads;
  pending.resolve(true);
  await showing;
  assert.equal(calls.reads, readsAfterDeletion);
  assert.equal(page.data.recordCount, 1);
});

test('cloud failure retains local data and supports pull-down retry without changing the date', async () => {
  const { page, calls } = createPage({ dailyRecords: twoRecords(), refreshFromCloud: () => Promise.reject(new Error('offline')) });
  assert.equal(await page.onShow(), false);
  await page.onPullDownRefresh();
  assert.equal(page.data.recordCount, 2);
  assert.equal(page.data.selectedDateKey, date);
  assert.equal(calls.cloud, 2);
  assert.equal(calls.stopRefresh, 1);
});

test('unloading prevents late cloud and menu callbacks from updating or deleting', async () => {
  const pending = deferred();
  const action = deferred();
  const { page, calls } = createPage({ dailyRecords: twoRecords(), refreshFromCloud: () => pending.promise, action: () => action.promise });
  const showing = page.onShow();
  const deleting = page.showRecordActions(eventFor(page.data.recordList[0]));
  page.onUnload();
  const before = calls.updates;
  pending.resolve(true);
  action.resolve({ tapIndex: 0 });
  await Promise.all([showing, deleting]);
  assert.equal(calls.updates, before);
  assert.equal(calls.modals.length, 0);
  assert.equal(calls.deletes.length, 0);
});
