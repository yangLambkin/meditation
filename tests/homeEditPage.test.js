const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const pagePath = path.join(root, 'miniprogram/pages/index/index.js');
const plain = value => JSON.parse(JSON.stringify(value));
const originalTimestamp = '2026-11-05T01:15:37.123+08:00';
const example = { _id: 'cloud-1', localId: 'local-1', timestamp: originalTimestamp,
  duration: 12, emotion: ['平静'], experience: [{ text: '留意呼吸' }] };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createPage({ record = example, update, checkText, readReflection, now: initialNow = '2026-11-05T12:00:00+08:00' } = {}) {
  let now = Date.parse(initialNow);
  let openid = 'oz-owner';
  let definition;
  const dailyRecords = { '2026-11-04': { count: 1, records: [structuredClone(record)] } };
  const calls = { menu: [], update: [], content: [], toast: [], modal: [], refresh: 0, reflection: [], loading: 0 };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const checkinManager = {
    getUserId: () => openid,
    getPendingSyncSummary: () => ({ pending: 0 }),
    getUserCheckinData: () => ({ dailyRecords }),
    getDailyCheckinCountSync: date => dailyRecords[date]?.count || 0,
    getExperienceRecordsFromLocal: () => [],
    getEditableCheckinReflection(...args) {
      calls.reflection.push(plain(args));
      if (readReflection) return readReflection(...args);
      return (record.experience || []).map(item => item.text || '').filter(Boolean).join('\n\n');
    },
    async updateCheckin(...args) {
      calls.update.push(plain(args));
      return update ? update(...args) : { success: true };
    }
  };
  const wx = {
    getStorageSync: key => key === 'userOpenId' ? openid : undefined,
    showToast: options => calls.toast.push(options),
    showActionSheet: options => { calls.menu.push(options); },
    showModal: options => calls.modal.push(options),
    showLoading() { calls.loading++; },
    hideLoading() { calls.loading--; },
    hideKeyboard() {}
  };
  const modules = {
    'checkin.js': checkinManager,
    'contentSec.js': { async checkText(...args) {
      calls.content.push(plain(args));
      return checkText ? checkText(...args) : true;
    } },
    'dailyWisdom.js': { DEFAULT_QUOTE: '每日金句', watchDailyWisdom: () => () => {} },
    'practiceEntry.js': { recordsVisible: () => true },
    'homeBackfill.js': { data: {}, methods: { refreshBackfillSelection() {}, stopHomeBackfill() {} } },
    'bijingRecordSync.js': { getDayState: () => null, getTasks: () => [], subscribe: () => () => {} }
  };
  function load(name) {
    const filename = path.basename(name);
    if (Object.hasOwn(modules, filename)) return modules[filename];
    assert.ok(['dateUtil.js', 'homeCheckin.js'].includes(filename), name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils', filename), 'utf8'), {
      module, require: load, Date: Clock, wx, console, setTimeout, clearTimeout
    }, { filename });
    modules[filename] = module.exports;
    return module.exports;
  }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page: value => { definition = value; }, require: load, wx, Date: Clock,
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout, clearInterval() {}
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values, callback) { Object.assign(this.data, values); if (callback) callback(); } };
  page.refreshCheckinRecords();
  const refreshCalendarData = page.refreshCalendarData;
  page.refreshCalendarData = function() { calls.refresh++; return refreshCalendarData.call(this); };
  return { page, calls, dailyRecords, changeAccount(value) { openid = value; }, setNow(value) { now = Date.parse(value); } };
}
function menuEvent(page) {
  return { type: 'longpress', currentTarget: { dataset: { id: page.data.checkinRecords[0].id } } };
}
async function openEditor(h) {
  const pending = h.page.showCheckinActions(menuEvent(h.page));
  h.calls.menu.at(-1).success({ tapIndex: 0 });
  await pending;
}
function input(page, suffix, value) {
  page[`onForm${suffix}`]({ detail: { value } });
}

test('home long press uses the record page actions and opens its populated meditation editor', async () => {
  const h = createPage();
  await openEditor(h);
  assert.deepEqual(Array.from(h.calls.menu[0].itemList), ['编辑功课', '删除记录']);
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formEditing, true);
  assert.equal(h.page.data.formType, 'sitting');
  assert.equal(h.page.data.formTypeName, '静坐');
  assert.equal(h.page.data.formDate, '2026-11-05');
  assert.equal(h.page.data.formTime, '01:15');
  assert.equal(h.page.data.formValue, '12');
  assert.equal(h.page.data.formReflection, '留意呼吸');
  assert.equal(h.page.data.formMaxReflection, 5000);
  assert.equal(h.calls.modal.length, 0);
  assert.equal(h.calls.update.length, 0);
});

test('editing duration and reflection retains the selected identity and original seconds', async () => {
  const h = createPage();
  await openEditor(h);
  input(h.page, 'Value', '18');
  input(h.page, 'Reflection', '  呼吸安稳  ');
  await h.page.saveForm();
  assert.equal(h.calls.update.length, 1);
  const [date, identity, updates, options] = h.calls.update[0];
  assert.equal(date, '2026-11-04');
  assert.deepEqual(identity, { recordId: example._id, localId: example.localId, timestamp: originalTimestamp });
  assert.deepEqual(updates, { duration: 18, timestamp: Date.parse(originalTimestamp), reflection: '呼吸安稳' });
  assert.ok(typeof options.requestId === 'string' && options.requestId.length > 0);
  assert.equal(h.calls.content[0][0], '呼吸安稳');
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.page.data.formBusy, false);
  assert.ok(h.calls.refresh > 0);
});

test('the editor waits for every original reflection before opening and preserves it in a duration-only edit', async () => {
  const response = deferred();
  const h = createPage({ record: { ...example, experience: [{ text: '可见部分' }, 'missing-reference'] },
    readReflection: () => response.promise });
  const opening = openEditor(h);
  await Promise.resolve();
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.page.data.formBusy, true);
  assert.equal(h.calls.loading, 1);
  await h.page.saveForm();
  assert.equal(h.calls.update.length, 0);
  response.resolve('可见部分\n\n完整原文');
  await opening;
  assert.equal(h.page.data.formReflection, '可见部分\n\n完整原文');
  assert.equal(h.calls.loading, 0);
  input(h.page, 'Value', '15');
  await h.page.saveForm();
  assert.equal(h.calls.update[0][2].reflection, '可见部分\n\n完整原文');
});

test('failed all-or-partial reflection loading blocks editing and allows a fresh retry', async () => {
  for (const experience of [['missing-reference'], [{ text: '可见部分' }, 'missing-reference']]) {
    let failed = true;
    const h = createPage({ record: { ...example, experience }, readReflection: async () => {
      if (failed) throw new Error('原感悟尚未完整读取，请重新打开');
      return '完整原文';
    } });
    const original = plain(h.dailyRecords);
    await openEditor(h);
    await h.page.saveForm();
    assert.equal(h.page.data.showForm, false);
    assert.equal(h.page.data.formBusy, false);
    assert.equal(h.calls.loading, 0);
    assert.equal(h.calls.update.length, 0);
    assert.match(h.calls.toast.at(-1).title, /完整读取/);
    assert.deepEqual(plain(h.dailyRecords), original);
    failed = false;
    await openEditor(h);
    assert.equal(h.page.data.formReflection, '完整原文');
    input(h.page, 'Reflection', '');
    await h.page.saveForm();
    assert.equal(h.calls.update[0][2].reflection, '', 'an explicit clear after hydration remains supported');
  }
});

test('account changes, hiding and unloading discard a late reflection read without opening the editor', async () => {
  for (const change of ['account', 'hide', 'unload']) {
    const response = deferred();
    const h = createPage({ readReflection: () => response.promise });
    h.page.stopHomeBackfill = () => {};
    h.page.stopBijingRecordSync = () => {};
    const opening = openEditor(h);
    await Promise.resolve();
    if (change === 'account') h.changeAccount('oz-other');
    else if (change === 'hide') h.page.onHide();
    else h.page.onUnload();
    response.resolve('旧账号感悟');
    await opening;
    assert.equal(h.page.data.showForm, false, change);
    assert.equal(h.calls.update.length, 0, change);
    assert.equal(h.calls.loading, 0, change);
    assert.equal(h.calls.toast.length, 0, change);
  }
});

test('changing date and time parses the natural Beijing calendar day without adding a day', async () => {
  const h = createPage();
  await openEditor(h);
  input(h.page, 'Date', '2026-11-05');
  input(h.page, 'Time', '01:45');
  await h.page.saveForm();
  assert.equal(h.calls.update[0][2].timestamp, Date.parse('2026-11-05T01:45:00+08:00'));
});

test('legacy records without time require the actual time and preserve all reflection paragraphs', async () => {
  const h = createPage({ record: { ...example, timestamp: null,
    experience: [{ text: '第一段' }, { text: '第二段' }] } });
  await openEditor(h);
  assert.equal(h.page.data.formTime, '');
  assert.match(h.page.data.formReflection, /第一段/);
  assert.match(h.page.data.formReflection, /第二段/);
  await h.page.saveForm();
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.page.data.showForm, true);
  assert.ok(h.page.data.formError);
  input(h.page, 'Time', '08:30');
  await h.page.saveForm();
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.update[0][2].timestamp, Date.parse('2026-11-04T08:30:00+08:00'));
});

test('invalid minutes, future times and overlong reflections keep the editor open without writing', async () => {
  for (const invalid of ['', '0', '1441', '1.5', '-2', 'abc']) {
    const h = createPage();
    await openEditor(h);
    input(h.page, 'Value', invalid);
    await h.page.saveForm();
    assert.equal(h.calls.update.length, 0, invalid);
    assert.equal(h.page.data.showForm, true, invalid);
    assert.ok(h.page.data.formError, invalid);
  }
  for (const [field, value] of [['Time', '23:59'], ['Reflection', '觉'.repeat(5001)]]) {
    const h = createPage();
    await openEditor(h);
    input(h.page, field, value);
    await h.page.saveForm();
    assert.equal(h.calls.update.length, 0, field);
    assert.equal(h.page.data.showForm, true, field);
  }
});

test('content rejection and cancellation leave the original record untouched', async () => {
  const h = createPage({ checkText: () => false });
  const before = plain(h.dailyRecords);
  await openEditor(h);
  input(h.page, 'Reflection', '更新感悟');
  await h.page.saveForm();
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formBusy, false);
  h.page.closeForm();
  assert.equal(h.page.data.showForm, false);
  assert.deepEqual(plain(h.dailyRecords), before);
});

test('failed saves retain the draft and reuse their request ID until the payload changes', async () => {
  const h = createPage({ update: () => ({ success: false, error: '网络未连接' }) });
  await openEditor(h);
  input(h.page, 'Value', '20');
  input(h.page, 'Reflection', '保留草稿');
  await h.page.saveForm();
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formValue, '20');
  assert.equal(h.page.data.formReflection, '保留草稿');
  assert.match(h.page.data.formError, /网络未连接/);
  assert.equal(h.page.data.formBusy, false);
  await h.page.saveForm();
  assert.equal(h.calls.update[0][3].requestId, h.calls.update[1][3].requestId);
  input(h.page, 'Value', '21');
  await h.page.saveForm();
  assert.notEqual(h.calls.update[1][3].requestId, h.calls.update[2][3].requestId);
});

test('an in-flight save blocks duplicate writes and closing the form', async () => {
  const response = deferred();
  const h = createPage({ update: () => response.promise });
  await openEditor(h);
  const pending = h.page.saveForm();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.page.data.formBusy, true);
  await h.page.saveForm();
  h.page.closeForm();
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.page.data.showForm, true);
  response.resolve({ success: true });
  await pending;
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.page.data.formBusy, false);
});

test('switching accounts invalidates old menu selections and open form submissions', async () => {
  const menu = createPage();
  const selection = menu.page.showCheckinActions(menuEvent(menu.page));
  menu.changeAccount('oz-other');
  menu.calls.menu[0].success({ tapIndex: 0 });
  await selection;
  assert.equal(menu.page.data.showForm, false);
  assert.equal(menu.calls.update.length, 0);

  const form = createPage();
  await openEditor(form);
  form.changeAccount('oz-other');
  await form.page.saveForm();
  assert.equal(form.calls.update.length, 0);
});

test('switching accounts while checking content prevents a write and ignores an old save success', async () => {
  const moderation = deferred();
  const checking = createPage({ checkText: () => moderation.promise });
  await openEditor(checking);
  const save = checking.page.saveForm();
  checking.changeAccount('oz-other');
  moderation.resolve(true);
  await save;
  assert.equal(checking.calls.update.length, 0);

  const response = deferred();
  const saving = createPage({ update: () => response.promise });
  await openEditor(saving);
  const pending = saving.page.saveForm();
  await new Promise(resolve => setImmediate(resolve));
  saving.changeAccount('oz-other');
  response.resolve({ success: true });
  await pending;
  assert.equal(saving.calls.toast.some(item => item.icon === 'success'), false);
  assert.equal(saving.calls.refresh, 0);
});

test('home and record screens include the same form template and stylesheet', () => {
  const home = fs.readFileSync(path.join(root, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const records = fs.readFileSync(path.join(root, 'miniprogram/pages/practices/practiceDialogs.wxml'), 'utf8');
  assert.match(home, /catchlongpress="showCheckinActions"/);
  assert.doesNotMatch(home, /catchlongpress="deleteCheckinRecord"/);
  assert.match(home, /长按记录可编辑或删除/);
  for (const source of [home, records]) assert.match(source, /<include src="\.\.\/\.\.\/templates\/practiceForm\.wxml"\s*\/>/);
  for (const file of ['pages/index/index.wxss', 'pages/practices/practices.wxss']) {
    const style = fs.readFileSync(path.join(root, 'miniprogram', file), 'utf8');
    assert.match(style, /@import "\.\.\/\.\.\/styles\/practiceForm\.wxss"/);
  }
});
