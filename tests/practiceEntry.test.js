const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const miniprogramPath = path.join(__dirname, '../miniprogram');
const plain = value => JSON.parse(JSON.stringify(value));
const SETTINGS_URL = '/pages/practiceSettings/practiceSettings';

function harness({ recordsVisible = true } = {}) {
  const storage = new Map([['userOpenId', 'owner-a'], ['practice_records_visible_v1:account:owner-a', recordsVisible]]);
  const readFailures = new Map(), writeFailures = new Map();
  const actionSheet = { failure: null, error: null };
  const calls = { sheets: [], modals: [], toast: [], navigateTo: [], switchTab: [], writes: [], chosen: [], forms: [], sitting: 0 };
  const wx = {
    getStorageSync(key) {
      if (readFailures.has(key)) throw readFailures.get(key);
      return structuredClone(storage.get(key));
    },
    setStorageSync(key, value) {
      calls.writes.push({ key, value: structuredClone(value) });
      if (writeFailures.has(key)) throw writeFailures.get(key);
      storage.set(key, structuredClone(value));
    },
    showActionSheet(value) {
      calls.sheets.push(value);
      if (actionSheet.error) throw actionSheet.error;
      if (actionSheet.failure) value.fail(actionSheet.failure);
    },
    showModal: value => calls.modals.push(value),
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigateTo.push(value),
    switchTab: value => calls.switchTab.push(value)
  };
  const modules = new Map();
  function loadModule(name) {
    const filename = path.basename(name);
    if (modules.has(filename)) return modules.get(filename);
    assert.ok(['practicePreferences.js', 'practiceEntry.js'].includes(filename), `Unexpected shared module: ${name}`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(miniprogramPath, 'utils', filename), 'utf8'), {
      module, exports: module.exports, require: loadModule, wx, console
    }, { filename });
    modules.set(filename, module.exports);
    return module.exports;
  }
  const preferences = loadModule('practicePreferences.js'), entry = loadModule('practiceEntry.js');
  function loadPage(pageName) {
    let definition;
    const stubs = {
      'checkin.js': {}, 'contentSec.js': {}, 'homeCheckin.js': {}, 'dailyWisdom.js': { DEFAULT_QUOTE: '每日金句' },
      'dateUtil.js': {}, 'bijingRecordSync.js': {}, 'homeBackfill.js': { data: {}, methods: {} },
      'practiceApi.js': {}, 'practiceQueue.js': {}, 'practiceAuth.js': { getOwner: () => ({ openid: storage.get('userOpenId') }) },
      'practiceConfig.js': { practicesEnabled: true }
    };
    const filename = path.join(miniprogramPath, 'pages', pageName, `${pageName}.js`);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require(name) {
        const base = path.basename(name);
        if (['practicePreferences.js', 'practiceEntry.js'].includes(base)) return loadModule(base);
        assert.ok(Object.hasOwn(stubs, base), `Unexpected page dependency: ${name}`);
        return stubs[base];
      },
      Page(value) { definition = value; }, wx, console, Date
    }, { filename });
    return { ...definition, data: structuredClone(definition.data),
      setData(values) { Object.assign(this.data, values); },
      openCheckinModal() { calls.sitting++; },
      openSittingForm() { calls.sitting++; },
      openForm(type) { calls.forms.push(type); } };
  }
  return { storage, calls, preferences, entry, readFailures, writeFailures, actionSheet, loadPage,
    choose() { entry.choosePractice(type => calls.chosen.push(type)); },
    changeAccount(openid) { if (openid === undefined) storage.delete('userOpenId'); else storage.set('userOpenId', openid); } };
}

function openEntry(h, pageName) {
  if (!pageName) return h.choose();
  const page = h.loadPage(pageName);
  return pageName === 'index' ? page.openPracticePicker() : page.choosePractice();
}

function assertNoEntryAction(h) {
  assert.deepEqual(h.calls.chosen, []);
  assert.deepEqual(h.calls.forms, []);
  assert.equal(h.calls.sitting, 0);
  assert.equal(h.calls.navigateTo.length, 0);
  assert.equal(h.calls.switchTab.length, 0);
  assert.equal(h.storage.has('practiceRecordEntry'), false);
}

test('native picker failures show a retry hint without invoking an entry action', () => {
  for (const pageName of [null, 'index', 'practices']) {
    const h = harness();
    h.actionSheet.failure = { errMsg: 'showActionSheet:fail api unavailable' };
    assert.doesNotThrow(() => openEntry(h, pageName));
    assert.equal(h.calls.sheets.length, 1);
    assert.match(h.calls.toast.at(-1).title, /重试/);
    assertNoEntryAction(h);
    h.actionSheet.failure = null;
    openEntry(h, pageName);
    assert.equal(h.calls.sheets.length, 2);
  }
});

test('cancelling the native picker stays quiet without invoking an entry action', () => {
  for (const pageName of [null, 'index', 'practices']) {
    const h = harness();
    h.actionSheet.failure = { errMsg: 'showActionSheet:fail cancel' };
    assert.doesNotThrow(() => openEntry(h, pageName));
    assert.equal(h.calls.sheets.length, 1);
    assert.deepEqual(h.calls.toast, []);
    assertNoEntryAction(h);
  }
});

test('synchronous native picker errors show a retry hint without invoking an entry action', () => {
  for (const pageName of [null, 'index', 'practices']) {
    const h = harness();
    h.actionSheet.error = new Error('native picker unavailable');
    assert.doesNotThrow(() => openEntry(h, pageName));
    assert.equal(h.calls.sheets.length, 1);
    assert.match(h.calls.toast.at(-1).title, /重试/);
    assertNoEntryAction(h);
  }
});

test('filtered picker indices resolve to the displayed practice rather than the original position', () => {
  const h = harness();
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  h.choose();
  assert.deepEqual(plain(h.calls.sheets[0].itemList), ['日行一善', '禅拍']);
  h.calls.sheets[0].success({ tapIndex: 0 });
  h.calls.sheets[0].success({ tapIndex: 1 });
  assert.deepEqual(h.calls.chosen, ['kindness', 'clapping']);
});

test('each supported practice can remain as the first and only picker choice', () => {
  const h = harness();
  for (const practice of h.preferences.PRACTICES) {
    h.preferences.saveHiddenTypes(h.preferences.PRACTICES.filter(item => item.type !== practice.type).map(item => item.type));
    h.choose();
    assert.deepEqual(plain(h.calls.sheets.at(-1).itemList), [practice.name]);
    h.calls.sheets.at(-1).success({ tapIndex: 0 });
    assert.equal(h.calls.chosen.at(-1), practice.type);
  }
});

test('opening the picker rereads settings and a newly hidden old choice cannot be selected', () => {
  const h = harness();
  h.choose();
  const oldSheet = h.calls.sheets[0];
  assert.equal(oldSheet.itemList.length, 6);
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  oldSheet.success({ tapIndex: 0 });
  assert.deepEqual(h.calls.chosen, []);
  h.choose();
  assert.deepEqual(plain(h.calls.sheets[1].itemList), ['日行一善', '禅拍']);
  h.calls.sheets[1].success({ tapIndex: 0 });
  assert.deepEqual(h.calls.chosen, ['kindness']);
});

test('a selection from a previous account is discarded before invoking its entry action', () => {
  const h = harness();
  h.choose();
  h.changeAccount('owner-b');
  h.calls.sheets[0].success({ tapIndex: 4 });
  assert.deepEqual(h.calls.chosen, []);
  assert.equal(h.calls.navigateTo.length, 0);
  assert.equal(h.calls.switchTab.length, 0);
  assert.match(h.calls.toast.at(-1).title, /账号已变化/);
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning', 'kindness']);
  h.choose();
  assert.deepEqual(plain(h.calls.sheets.at(-1).itemList), ['禅拍']);
});

test('hiding every entry offers settings and respects both confirmation and cancellation', () => {
  for (const confirm of [false, true]) {
    const h = harness();
    h.preferences.saveHiddenTypes(h.preferences.PRACTICES.map(item => item.type));
    h.choose();
    assert.equal(h.calls.sheets.length, 0);
    assert.equal(h.calls.modals.length, 1);
    assert.match(h.calls.modals[0].title, /全部隐藏/);
    h.calls.modals[0].success({ confirm });
    assert.deepEqual(plain(h.calls.navigateTo), confirm ? [{ url: SETTINGS_URL }] : []);
    assert.deepEqual(h.calls.chosen, []);
    assert.equal(h.calls.switchTab.length, 0);
  }
});

test('a stale all-hidden confirmation cannot navigate after the account changes', () => {
  const h = harness();
  h.preferences.saveHiddenTypes(h.preferences.PRACTICES.map(item => item.type));
  h.choose();
  h.changeAccount(undefined);
  h.calls.modals[0].success({ confirm: true });
  assert.equal(h.calls.navigateTo.length, 0);
  assert.equal(h.calls.switchTab.length, 0);
  assert.match(h.calls.toast.at(-1).title, /账号已变化/);
});

test('account storage errors prevent opening or completing a picker without navigating', () => {
  const h = harness();
  h.readFailures.set('userOpenId', new Error('账号存储不可用'));
  h.choose();
  assert.equal(h.calls.sheets.length, 0);
  assert.equal(h.calls.modals.length, 0);
  assert.ok(h.calls.toast.length);
  h.readFailures.clear();
  h.choose();
  h.readFailures.set('userOpenId', new Error('账号存储不可用'));
  h.calls.sheets[0].success({ tapIndex: 0 });
  assert.deepEqual(h.calls.chosen, []);
  assert.equal(h.calls.navigateTo.length, 0);
  assert.equal(h.calls.switchTab.length, 0);
});

test('invalid picker indices cannot invoke any practice entry', () => {
  const h = harness();
  h.choose();
  for (const tapIndex of [-1, 6, 99, 0.5, undefined]) h.calls.sheets[0].success({ tapIndex });
  assert.deepEqual(h.calls.chosen, []);
  assert.equal(h.calls.navigateTo.length, 0);
  assert.equal(h.calls.switchTab.length, 0);
});

test('the home entry stores kindness and opens records when kindness is the first visible choice', () => {
  const h = harness();
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  const page = h.loadPage('index');
  page.openPracticePicker();
  assert.deepEqual(plain(h.calls.sheets.at(-1).itemList), ['日行一善', '禅拍']);
  h.calls.sheets.at(-1).success({ tapIndex: 0 });
  assert.equal(h.storage.get('practiceRecordEntry'), 'kindness');
  assert.deepEqual(plain(h.calls.switchTab), [{ url: '/pages/practices/practices' }]);
  assert.equal(h.calls.sitting, 0);
});

test('the records entry opens the kindness form when kindness is the first visible choice', () => {
  const h = harness();
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  const page = h.loadPage('practices');
  page.choosePractice();
  assert.deepEqual(plain(h.calls.sheets.at(-1).itemList), ['日行一善', '禅拍']);
  h.calls.sheets.at(-1).success({ tapIndex: 0 });
  assert.deepEqual(h.calls.forms, ['kindness']);
  assert.equal(h.calls.sitting, 0);
  assert.equal(h.calls.switchTab.length, 0);
});

test('the home entry does not navigate when its selected practice cannot be persisted', () => {
  const h = harness();
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  h.writeFailures.set('practiceRecordEntry', new Error('存储已满'));
  const page = h.loadPage('index');
  page.openPracticePicker();
  assert.doesNotThrow(() => h.calls.sheets.at(-1).success({ tapIndex: 0 }));
  assert.equal(h.storage.has('practiceRecordEntry'), false);
  assert.equal(h.calls.switchTab.length, 0);
  assert.ok(h.calls.toast.length);
});

test('home defaults to a usable practice picker while an explicit false preference keeps it hidden', () => {
  for (const initial of [false, undefined]) {
    const h = harness({ recordsVisible: false });
    if (initial === undefined) h.storage.delete('practice_records_visible_v1:account:owner-a');
    const page = h.loadPage('index');
    assert.equal(page.data.recordsVisible, true);
    page.refreshRecordVisibility();
    assert.equal(page.data.recordsVisible, initial !== false);
    page.openPracticePicker();
    assert.equal(h.entry.recordsVisible(), initial !== false);
    assert.equal(h.calls.sheets.length, initial === false ? 0 : 1);
    assert.equal(h.calls.modals.length, 0);
    assertNoEntryAction(h);
  }
});

test('home rereads record visibility before opening so a stale visible entry is inert', () => {
  const h = harness();
  const page = h.loadPage('index');
  page.refreshRecordVisibility();
  assert.equal(page.data.recordsVisible, true);
  h.preferences.saveRecordsVisible(false);
  page.openPracticePicker();
  assert.equal(h.calls.sheets.length, 0);
  assertNoEntryAction(h);
});
