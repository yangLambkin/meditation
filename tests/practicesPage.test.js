const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/practices/practices.js');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function createPage({ feed, summary, flush, enabled = true, enqueue } = {}) {
  let now = Date.parse('2026-10-31T00:30:37+08:00');
  let owner = { openid: 'oz-owner', studentNumber: '001', bindingVersion: 'v1' };
  const tasks = [], calls = { feed: [], summary: [], enqueue: [], flush: [], toast: [], navigation: [], modal: [], mirrorResume: 0 };
  const storage = {};
  const subscribers = new Set();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const api = {
    feed: async params => { calls.feed.push(plain(params)); return feed ? feed(params) : { records: [], nextCursor: '' }; },
    summary: async params => { calls.summary.push(plain(params)); return summary ? summary(params) : { totals: [], recordCount: 0, practiceDays: 0, daily: [], allTime: { totals: [] } }; }
  };
  const queue = {
    getPending: () => tasks.filter(task => task.owner.studentNumber === owner.studentNumber),
    enqueuePractice: options => {
      calls.enqueue.push(plain(options));
      if (enqueue) return enqueue(options, tasks, owner);
      const task = { ...options, id: `task-${calls.enqueue.length}`, owner: plain(owner), status: 'pending', attempts: 0 };
      tasks.push(task);
      return task;
    },
    flush: async options => { calls.flush.push(options); if (flush) return flush(tasks); tasks.splice(0); return { success: true, pending: 0, sent: 1 }; },
    subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    cancel: id => { const index = tasks.findIndex(task => task.id === id); if (index >= 0) tasks.splice(index, 1); }
  };
  let definition;
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigation.push(value), switchTab: value => calls.navigation.push(value),
    showModal: value => calls.modal.push(value), showActionSheet: value => { calls.actionSheet = value; },
    stopPullDownRefresh() {}
  };
  const modules = { 'practiceApi.js': api, 'practiceQueue.js': queue,
    'practiceAuth.js': { getOwner: () => owner, authorize: async () => owner },
    'practiceMirror.js': { resume: async () => { calls.mirrorResume++; } },
    'practiceConfig.js': { practicesEnabled: enabled } };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: name => { const module = modules[path.basename(name)]; assert.ok(module, name); return module; },
    Page: value => { definition = value; }, wx, Date: Clock, console
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data); } };
  page.onLoad();
  return { page, calls, tasks, storage, subscribers, queue,
    changeOwner(value) { owner = value; }, advance(milliseconds) { now += milliseconds; } };
}

test('records use a single server feed cursor and whole-range summary instead of combining per-type pages', async () => {
  const h = createPage({
    feed: params => params.cursor ? { records: [
      { id: 2, type: 'instant', recordDate: '2026-10-30', count: 3, occurredAt: '2026-10-30 14:00:00' },
      { id: 3, type: 'kindness', recordDate: '2026-10-30', quantity: 4, content: '扶助邻里', occurredAt: '2026-10-30 12:00:00' }
    ] } : { records: [
      { id: 1, type: 'walking', recordDate: '2026-10-31', durationMinutes: 12, occurredAt: '2026-10-31 00:15:00' },
      { id: 2, type: 'instant', recordDate: '2026-10-30', count: 3, occurredAt: '2026-10-30 14:00:00' }
    ], nextCursor: 'stable-cursor-1' },
    summary: () => ({ recordCount: 55, practiceDays: 20,
      totals: [{ type: 'walking', recordCount: 30, totalValue: 150, unit: '分钟' }, { type: 'kindness', recordCount: 3, totalValue: 7, unit: '件' }],
      daily: [], allTime: { recordCount: 100, practiceDays: 40, totals: [{ type: 'instant', totalValue: 90 }] } })
  });
  await h.page.refresh();
  assert.equal(h.page.data.recordCount, 55);
  assert.equal(h.page.data.practiceDays, 20);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'walking').value, 150);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'kindness').value, 7);
  assert.equal(h.page.data.allTimeRecordCount, 100);
  assert.equal(h.page.data.allTimeCards.find(item => item.type === 'instant').value, 90);
  await h.page.loadMore();
  assert.equal(h.page.data.records.length, 3);
  assert.equal(h.page.data.records[2].quantity, 4);
  assert.equal(h.page.data.groups.length, 2);
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'all' }, { month: '2026-10', type: 'all', cursor: 'stable-cursor-1' }]);
  assert.equal(h.page.data.recordCount, 55);
});

test('type calendar shows server daily quantities and a selected day requests the matching feed', async () => {
  const h = createPage({ summary: () => ({ totals: [{ type: 'walking', totalValue: 30 }], recordCount: 2, practiceDays: 1,
    daily: [{ date: '2026-10-30', recordCount: 2, totals: [{ type: 'walking', totalValue: 30 }] }], allTime: { totals: [] } }) });
  h.page.setData({ type: 'walking', typeIndex: 2 });
  await h.page.refresh();
  const day = h.page.data.calendar.flat().find(item => item.date === '2026-10-30');
  assert.equal(day.value, 30);
  assert.equal(day.active, true);
  assert.equal(h.page.data.trend.length, 31);
  assert.equal(h.page.data.trendMax, 30);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-30').value, 30);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-30').height, 130);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-01').value, 0);
  h.page.selectDay(day.date);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.view, 'detail');
  assert.deepEqual(h.calls.feed.at(-1), { month: '2026-10', type: 'walking', date: '2026-10-30' });
  h.page.onMonthChange({ detail: { value: '2026-11' } });
  assert.equal(h.page.data.month, '2026-10');
});

test('new practice keeps first-open Beijing date, original seconds and one identity across failed retries', async () => {
  let attempts = 0;
  const h = createPage({ flush: tasks => { if (++attempts === 1) { tasks[0].lastError = { message: '网络中断' }; return { success: false }; } tasks.splice(0); return { success: true }; } });
  h.page.openForm('walking');
  assert.equal(h.page.data.formDate, '2026-10-31');
  assert.equal(h.page.data.formTime, '00:30');
  h.page.onFormValue({ detail: { value: '15' } });
  h.page.onFormReflection({ detail: { value: '看见念头' } });
  h.advance(24 * 60 * 60 * 1000);
  await h.page.saveForm();
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formPending, true);
  assert.equal(h.page.data.formReflection, '看见念头');
  assert.equal(h.page.data.formError, '网络中断');
  assert.equal(h.calls.enqueue[0].payload.recordDate, '2026-10-31');
  assert.equal(h.calls.enqueue[0].payload.occurredAt, '2026-10-31 00:30:37');
  h.page.onFormValue({ detail: { value: '20' } });
  assert.equal(h.page.data.formValue, '15');
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.flush.length, 2);
  assert.equal(h.page.data.showForm, false);
});

test('manual quantity and future or impossible Beijing times never enter the queue', async () => {
  const h = createPage();
  for (const type of ['walking', 'learning', 'clapping', 'instant']) {
    h.page.openForm(type);
    for (const value of ['0', '-1', '1.5', '01', type === 'instant' ? '1000001' : '1441']) {
      h.page.onFormValue({ detail: { value } });
      await h.page.saveForm();
      assert.ok(h.page.data.formError);
    }
  }
  h.page.openForm('walking');
  h.page.onFormValue({ detail: { value: '1' } });
  h.page.onFormTime({ detail: { value: '00:31' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /北京时间/);
  h.page.onFormDate({ detail: { value: '2026-02-30' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /北京时间/);
  assert.equal(h.calls.enqueue.length, 0);
});

test('editing kindness preserves its original deed quantity by excluding quantity from PATCH payload', async () => {
  const h = createPage();
  h.page.openForm('kindness', { id: 7, type: 'kindness', recordDate: '2026-10-30', occurredAt: '2026-10-30 20:15:24', quantity: 5, content: '原善行', reflection: '' });
  assert.equal(h.page.data.formValue, '5');
  h.page.onFormContent({ detail: { value: '更新善行内容' } });
  await h.page.saveForm();
  const submitted = h.calls.enqueue[0];
  assert.equal(submitted.operation, 'update');
  assert.equal(submitted.recordId, 7);
  assert.deepEqual(submitted.payload, { recordDate: '2026-10-30', occurredAt: '2026-10-30 20:15:24', reflection: '', content: '更新善行内容' });
});

test('date-only history does not invent a time and requires the user to select the real clock time', async () => {
  const h = createPage();
  h.page.openForm('walking', { id: 4, type: 'walking', recordDate: '2026-10-30', durationMinutes: 15 });
  assert.equal(h.page.data.formTime, '');
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 0);
  assert.match(h.page.data.formError, /真实发生时间/);
  h.page.onFormTime({ detail: { value: '13:45' } });
  await h.page.saveForm();
  assert.equal(h.calls.enqueue[0].payload.occurredAt, '2026-10-30 13:45:00');
});

test('meditation mirrors are read only and their original history uses the existing 02:00 business day', async () => {
  const h = createPage({ feed: () => ({ records: [{ id: 1, type: 'sitting', source: 'meditation', sourceRecordId: 'source-1', recordDate: '2026-10-31', occurredAt: '2026-10-31 00:30:00', durationMinutes: 20, canEdit: true, canDelete: true }] }) });
  await h.page.refresh();
  h.page.openDetail({ currentTarget: { dataset: { key: 'sitting:1' } } });
  assert.equal(h.page.data.detail.mirrored, true);
  assert.equal(h.page.data.detail.canEdit, false);
  assert.equal(h.page.data.detail.canDelete, false);
  h.page.editDetail(); h.page.deleteDetail();
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.calls.modal.length, 0);
  h.page.openOriginalRecord();
  assert.equal(h.calls.navigation[0].url, '/pages/history/history?date=2026-10-30');
});

test('late reads and delayed delete confirmations cannot apply another binding data', async () => {
  const response = deferred();
  const h = createPage({ feed: () => response.promise });
  const pending = h.page.refresh();
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  response.resolve({ records: [{ id: 99, type: 'instant', count: 2, recordDate: '2026-10-30' }] });
  await pending;
  assert.equal(h.page.data.records.length, 0);
  h.page.setData({ records: [{ key: 'walking:1', id: 1, type: 'walking', canDelete: true }] });
  h.page.openDetail({ currentTarget: { dataset: { key: 'walking:1' } } });
  h.page.deleteDetail();
  h.changeOwner({ openid: 'oz-third', studentNumber: '003', bindingVersion: 'v3' });
  h.calls.modal[0].success({ confirm: true });
  assert.equal(h.calls.enqueue.length, 0);
  assert.match(h.calls.toast.at(-1).title, /已变化/);
});

test('account switches during upload cannot announce success or clear another account form', async () => {
  const upload = deferred();
  const h = createPage({ flush: () => upload.promise });
  h.page.openForm('instant');
  h.page.onFormValue({ detail: { value: '1' } });
  const save = h.page.saveForm();
  await new Promise(resolve => setImmediate(resolve));
  h.changeOwner({ openid: 'oz-new', studentNumber: '004', bindingVersion: 'v4' });
  upload.resolve({ success: true });
  await save;
  assert.equal(h.calls.toast.length, 0);
  assert.equal(h.tasks.length, 1);
});

test('feature disabled performs no requests and the page lifecycle replaces queue subscriptions', async () => {
  const h = createPage({ enabled: false });
  h.page.onShow(); h.page.onShow();
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
  assert.equal(h.subscribers.size, 1);
  h.page.onHide();
  assert.equal(h.subscribers.size, 0);
  h.page.openForm('walking');
  assert.equal(h.page.data.showForm, false);
});

test('an unconfirmed sent create exposes deletion through a dependent operation instead of erasing local state', async () => {
  const h = createPage({ flush: () => ({ success: false, pending: 2 }) });
  h.tasks.push({ id: 'unknown-create', kind: 'practice', owner: { studentNumber: '001' }, type: 'walking',
    operation: 'create', attempts: 1, status: 'pending', payload: { recordDate: '2026-10-30' } });
  h.page.refreshPending();
  assert.equal(h.page.data.pending[0].canCancel, false);
  assert.equal(h.page.data.pending[0].canDeletePending, true);
  h.page.deletePending({ currentTarget: { dataset: { id: 'unknown-create' } } });
  assert.match(h.calls.modal[0].content, /先确认原记录/);
  h.calls.modal[0].success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].recordId, 'local:unknown-create');
  assert.equal(h.calls.enqueue[0].operation, 'delete');
  assert.equal(h.tasks.length, 2);
  const original = h.page.data.pending.find(item => item.id === 'unknown-create');
  assert.equal(original.deletionQueued, true);
  assert.equal(original.canDeletePending, false);
  h.page.deletePending({ currentTarget: { dataset: { id: 'unknown-create' } } });
  assert.equal(h.calls.modal.length, 1);
});

test('retry also rechecks original cloud confirmation and shows specific source errors', async () => {
  const h = createPage({ flush: () => ({ success: false, pending: 1 }) });
  h.tasks.push({ id: 'source-intent', kind: 'mirror', type: 'sitting', operation: 'update', status: 'waiting_source',
    owner: { studentNumber: '001' }, lastError: { message: '原记录缺少可靠更新时间，保留待核对' }, payload: {} });
  h.page.refreshPending();
  assert.match(h.page.data.pending[0].stateText, /可靠更新时间/);
  assert.equal(h.page.data.pending[0].canDeletePending, false);
  await h.page.retryPending();
  assert.equal(h.calls.mirrorResume, 1);
  assert.equal(h.calls.flush[0].manual, true);
});

test('five tab navigation retains existing sitting entry and the profile reminder targets tab 4', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.deepEqual(app.tabBar.list.map(item => item.text), ['首页', '计时', '记录', '团队', '我']);
  assert.equal(app.tabBar.list[2].pagePath, 'pages/practices/practices');
  const home = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.match(home, /bindtap="startMeditation"[\s\S]*?开始静坐/);
  assert.match(home, /bindtap="openPracticePicker"[\s\S]*?记录功课/);
  assert.match(home, /每日金句/);
  assert.match(home, /最近三天静坐/);
  const page = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
  assert.match(page, /对已登录成员可见/);
  assert.match(page, /静坐历史尚未全部导入/);
  assert.match(page, /原记录仅有日期/);
});
