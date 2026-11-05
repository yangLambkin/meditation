const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const miniprogram = path.join(__dirname, '../miniprogram');
const keyFor = openid => openid === undefined || openid === null || openid === ''
  ? 'practice_records_visible_v1:guest'
  : `practice_records_visible_v1:account:${encodeURIComponent(openid)}`;
const changeEvent = value => ({ detail: { value } });

function harness() {
  const storage = new Map([['userOpenId', 'oz-owner']]);
  const readFailures = new Map(), writeFailures = new Map();
  const calls = { writes: [], updates: [], toast: [], navigateTo: [], refreshTabBars: 0 };
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
    showToast(value) { calls.toast.push({ ...value }); },
    navigateTo(value) { calls.navigateTo.push({ ...value }); }
  };
  const app = { refreshTabBars() { calls.refreshTabBars++; } };
  const quietConsole = { log() {}, warn() {}, error() {} };
  const modules = new Map();
  function shared(name) {
    const file = path.basename(name);
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    const filename = path.join(miniprogram, 'utils', file);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, require: shared, wx, console: quietConsole
    }, { filename });
    modules.set(file, module.exports);
    return module.exports;
  }
  const preferences = shared('practicePreferences.js');
  function openPage(name) {
    let definition;
    const filename = path.join(miniprogram, 'pages', name, `${name}.js`);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require(request) {
        const file = path.basename(request);
        if (['practicePreferences.js', 'practiceEntry.js'].includes(file)) return shared(file);
        if (file === 'homeBackfill.js') return { data: {}, methods: {} };
        if (file === 'dailyWisdom.js') return { DEFAULT_QUOTE: '静心', watchDailyWisdom: () => () => {} };
        if (file === 'dateUtil.js') return { watchBusinessDate: () => () => {} };
        return {};
      },
      Page(value) { definition = value; }, getApp: () => app, wx, console: quietConsole,
      setInterval: () => 1, clearInterval() {}
    }, { filename });
    const page = { ...definition, data: structuredClone(definition.data),
      setData(value) { calls.updates.push(structuredClone(value)); Object.assign(this.data, value); } };
    for (const method of ['getUserData', 'initHomeBackfill', 'watchBijingRecordSync',
      'refreshCheckinDefaults', 'refreshCheckinRecords', 'generateCalendar', 'refreshCheckinsFromCloud', 'syncUserCheckinData']) {
      page[method] = () => {};
    }
    return page;
  }
  return { page: openPage('practiceSettings'), openPage, preferences, storage, readFailures, writeFailures, calls,
    changeAccount(value) {
      if (value === undefined) storage.delete('userOpenId');
      else storage.set('userOpenId', value);
    } };
}

test('record settings show record visibility on by default and do not save just by opening', () => {
  const h = harness();
  assert.equal(h.page.data.recordsVisible, true);
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, true);
  assert.deepEqual(h.calls.writes, []);
  assert.equal(h.calls.refreshTabBars, 0);
});

test('record settings switch immediately saves each direction, refreshes navigation and survives reopening', () => {
  const h = harness();
  h.page.onShow();
  h.page.onRecordVisibilityChange(changeEvent(false));
  assert.equal(h.page.data.recordsVisible, false);
  assert.equal(h.storage.get(keyFor('oz-owner')), false);
  assert.equal(h.calls.refreshTabBars, 1);
  const reopened = h.openPage('practiceSettings');
  reopened.onShow();
  assert.equal(reopened.data.recordsVisible, false);
  reopened.onRecordVisibilityChange(changeEvent(true));
  assert.equal(reopened.data.recordsVisible, true);
  assert.equal(h.storage.get(keyFor('oz-owner')), true);
  assert.equal(h.calls.refreshTabBars, 2);
  const openedAgain = h.openPage('practiceSettings');
  openedAgain.onShow();
  assert.equal(openedAgain.data.recordsVisible, true);
  assert.deepEqual(h.calls.writes, [
    { key: keyFor('oz-owner'), value: false }, { key: keyFor('oz-owner'), value: true }
  ]);
  assert.deepEqual(h.calls.toast, []);
});

test('record settings reload the current account on showing and keep logout preferences separate', () => {
  const h = harness();
  h.page.onShow();
  h.page.onRecordVisibilityChange(changeEvent(false));
  h.changeAccount('oz-other');
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, true);
  h.changeAccount(undefined);
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, true);
  h.page.onRecordVisibilityChange(changeEvent(false));
  assert.equal(h.storage.get(keyFor(undefined)), false);
  h.changeAccount('oz-other');
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, true);
  h.changeAccount('oz-owner');
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, false);
  assert.equal(h.storage.has(keyFor('oz-other')), false);
});

test('a stale record settings gesture cannot write into a new account or logged out identity', () => {
  for (const nextAccount of ['oz-other', undefined]) {
    const h = harness();
    h.storage.set(keyFor('oz-owner'), false);
    h.page.onShow();
    h.changeAccount(nextAccount);
    h.page.onRecordVisibilityChange(changeEvent(false));
    assert.equal(h.page.data.recordsVisible, true);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.storage.get(keyFor('oz-owner')), false);
    assert.equal(h.storage.has(keyFor(nextAccount)), false);
    assert.equal(h.calls.refreshTabBars, 0);
    assert.match(h.calls.toast.at(-1).title, /账号已变化/);
    h.page.onRecordVisibilityChange(changeEvent(false));
    assert.equal(h.storage.get(keyFor(nextAccount)), false);
    assert.equal(h.calls.refreshTabBars, 1);
  }
});

test('a failed record settings save restores the previous visible state and leaves navigation unchanged', () => {
  for (const previous of [false, true]) {
    const h = harness();
    h.storage.set(keyFor('oz-owner'), previous);
    h.page.onShow();
    h.writeFailures.set(keyFor('oz-owner'), new Error('本机存储已满'));
    const updatesBefore = h.calls.updates.length;
    h.page.onRecordVisibilityChange(changeEvent(!previous));
    assert.deepEqual(h.calls.updates.slice(updatesBefore).map(update => update.recordsVisible), [!previous, previous]);
    assert.equal(h.page.data.recordsVisible, previous);
    assert.equal(h.storage.get(keyFor('oz-owner')), previous);
    assert.equal(h.calls.refreshTabBars, 0);
    assert.match(h.calls.toast.at(-1).title, /未能保存/);
    assert.equal(h.calls.toast.at(-1).icon, 'none');
  }
});

test('record settings account read failures keep the switch off and cannot write guest preferences', () => {
  const h = harness();
  h.storage.set(keyFor(undefined), true);
  h.readFailures.set('userOpenId', new Error('账号缓存不可用'));
  h.page.onShow();
  assert.equal(h.page.data.recordsVisible, false);
  h.page.onRecordVisibilityChange(changeEvent(true));
  assert.equal(h.page.data.recordsVisible, false);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.storage.get(keyFor(undefined)), true);
  assert.equal(h.calls.refreshTabBars, 0);
  assert.ok(h.calls.toast.length);
});

test('Me has one unified settings entry that keeps all preferences accessible when records are hidden', () => {
  const template = fs.readFileSync(path.join(miniprogram, 'pages/me/me.wxml'), 'utf8');
  const entries = template.match(/<view\b[^>]*bindtap="goToSettings"[^>]*>/g) || [];
  assert.equal(entries.length, 1);
  assert.doesNotMatch(entries[0], /wx:if|wx:elif/);
  assert.match(template, /<text[^>]*>设置<\/text>/);
  assert.doesNotMatch(template, /goToPracticeSettings|goToTimerSettings/);
  assert.doesNotMatch(template, /recordsVisible|onRecordVisibilityChange|显示记录|功课入口设置/);
  const h = harness();
  const me = h.openPage('me');
  assert.equal(me.onRecordVisibilityChange, undefined);
  for (const visible of [false, true]) {
    h.storage.set(keyFor('oz-owner'), visible);
    me.goToSettings();
  }
  const settings = h.openPage('settings');
  settings.goToTimerSettings();
  settings.goToPracticeSettings();
  assert.deepEqual(h.calls.navigateTo, [
    { url: '/pages/settings/settings' },
    { url: '/pages/settings/settings' },
    { url: '/pages/timerSettings/timerSettings' },
    { url: '/pages/practiceSettings/practiceSettings' }
  ]);
});

test('home refreshes record visibility when it returns and when the current login changes', () => {
  const h = harness();
  const home = h.openPage('index');
  home.onShow();
  assert.equal(home.data.recordsVisible, true);
  h.storage.set(keyFor('oz-owner'), false);
  home.onShow();
  assert.equal(home.data.recordsVisible, false);
  h.changeAccount('oz-other');
  home.checkUserInfoStatus(false);
  assert.equal(home.data.recordsVisible, true);
  h.changeAccount('oz-owner');
  home.checkUserInfoStatus(false);
  assert.equal(home.data.recordsVisible, false);
  h.preferences.saveRecordsVisible(true);
  home.onShow();
  assert.equal(home.data.recordsVisible, true);
  assert.ok(h.calls.refreshTabBars >= 5);
});
