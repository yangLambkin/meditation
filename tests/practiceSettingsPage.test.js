const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/practiceSettings/practiceSettings.js');
const preferencesPath = path.join(__dirname, '../miniprogram/utils/practicePreferences.js');
const PREFIX = 'practice_entry_preferences_v1';
const keyFor = openid => openid === undefined || openid === null || openid === ''
  ? `${PREFIX}:guest` : `${PREFIX}:account:${encodeURIComponent(openid)}`;
const TYPES = ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'];
const plain = value => JSON.parse(JSON.stringify(value));
const changeEvent = (type, value) => ({ currentTarget: { dataset: { type } }, detail: { value } });

function createPage({ openid = 'oz-owner', hiddenTypes } = {}) {
  const storage = new Map([['userOpenId', openid]]);
  if (hiddenTypes !== undefined) storage.set(keyFor(openid), structuredClone(hiddenTypes));
  const reads = [], writes = [], updates = [], toast = [];
  const readFailures = new Map(), writeFailures = new Map();
  const wx = {
    getStorageSync(key) {
      reads.push(key);
      if (readFailures.has(key)) throw readFailures.get(key);
      return structuredClone(storage.get(key));
    },
    setStorageSync(key, value) {
      writes.push({ key, value: structuredClone(value) });
      if (writeFailures.has(key)) throw writeFailures.get(key);
      storage.set(key, structuredClone(value));
    },
    showToast(value) { toast.push(plain(value)); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(preferencesPath, 'utf8'), { module, exports: module.exports, wx, console }, { filename: preferencesPath });
  const preferences = module.exports;
  function openPage() {
    let definition;
    vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
      require(name) { assert.equal(name, '../../utils/practicePreferences.js'); return preferences; },
      Page(value) { definition = value; }, wx, console
    }, { filename: pagePath });
    return { ...definition, data: structuredClone(definition.data),
      setData(value) { updates.push(plain(value)); Object.assign(this.data, value); } };
  }
  return { page: openPage(), openPage, storage, preferences, reads, writes, updates, toast, readFailures, writeFailures,
    changeAccount(value) {
      if (value === undefined) storage.delete('userOpenId');
      else storage.set('userOpenId', value);
    } };
}

function visibleTypes(page) { return plain(page.data.entries.filter(item => item.visible).map(item => item.type)); }

test('onShow renders all default practice entries with their metadata and no storage writes', () => {
  const h = createPage();
  h.page.onShow();
  assert.deepEqual(plain(h.page.data.entries), plain(h.preferences.PRACTICES.map(item => ({ ...item, visible: true }))));
  assert.deepEqual(visibleTypes(h.page), TYPES);
  assert.equal(h.page.data.visibleCount, 6);
  assert.equal(h.page.data.hiddenCount, 0);
  assert.equal(h.page.data.error, '');
  assert.equal(h.writes.length, 0);
});

test('onShow loads saved hidden entries and rereads them when the settings page returns', () => {
  const h = createPage({ hiddenTypes: ['clapping', 'walking'] });
  h.page.onShow();
  assert.deepEqual(visibleTypes(h.page), ['sitting', 'instant', 'learning', 'kindness']);
  assert.equal(h.page.data.visibleCount, 4);
  assert.equal(h.page.data.hiddenCount, 2);
  h.storage.set(keyFor('oz-owner'), ['instant']);
  h.page.onShow();
  assert.deepEqual(visibleTypes(h.page), TYPES.filter(type => type !== 'instant'));
  assert.equal(h.page.data.visibleCount, 5);
  assert.equal(h.page.data.hiddenCount, 1);
  assert.equal(h.writes.length, 0);
});

test('switch changes persist immediately and reopening the page preserves both disabled and reenabled entries', () => {
  const h = createPage();
  h.page.onShow();
  h.page.onEntryChange(changeEvent('walking', false));
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['walking']);
  assert.deepEqual(h.writes, [{ key: keyFor('oz-owner'), value: ['walking'] }]);
  assert.equal(h.page.data.entries.find(item => item.type === 'walking').visible, false);
  assert.equal(h.page.data.visibleCount, 5);
  assert.equal(h.page.data.hiddenCount, 1);
  const reopened = h.openPage();
  reopened.onShow();
  assert.equal(reopened.data.entries.find(item => item.type === 'walking').visible, false);
  reopened.onEntryChange(changeEvent('walking', true));
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), []);
  assert.equal(h.writes.length, 2);
  const openedAgain = h.openPage();
  openedAgain.onShow();
  assert.deepEqual(visibleTypes(openedAgain), TYPES);
  assert.equal(openedAgain.data.visibleCount, 6);
  assert.equal(openedAgain.data.hiddenCount, 0);
});

test('restoreAll saves the empty hidden selection and restores every switch', () => {
  const h = createPage({ hiddenTypes: ['sitting', 'kindness', 'clapping'] });
  h.page.onShow();
  h.page.restoreAll();
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), []);
  assert.deepEqual(visibleTypes(h.page), TYPES);
  assert.equal(h.page.data.visibleCount, 6);
  assert.equal(h.page.data.hiddenCount, 0);
  assert.equal(h.page.data.error, '');
  assert.deepEqual(h.toast, [{ title: '已显示全部功课', icon: 'success' }]);
  const reopened = h.openPage();
  reopened.onShow();
  assert.deepEqual(visibleTypes(reopened), TYPES);
});

test('all practice switches may be turned off and stay off after reopening', () => {
  const h = createPage();
  h.page.onShow();
  for (const [index, type] of TYPES.entries()) {
    h.page.onEntryChange(changeEvent(type, false));
    assert.equal(h.page.data.visibleCount, 5 - index, type);
    assert.equal(h.page.data.hiddenCount, index + 1, type);
  }
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), TYPES);
  assert.deepEqual(visibleTypes(h.page), []);
  assert.equal(h.page.data.error, '');
  const reopened = h.openPage();
  reopened.onShow();
  assert.deepEqual(visibleTypes(reopened), []);
  assert.equal(reopened.data.visibleCount, 0);
  assert.equal(reopened.data.hiddenCount, 6);
});

test('a failed switch save first applies the gesture then restores the prior switch values and shows an error', () => {
  const h = createPage({ hiddenTypes: ['kindness'] });
  h.page.onShow();
  const previousEntries = plain(h.page.data.entries);
  h.writeFailures.set(keyFor('oz-owner'), new Error('存储已满'));
  const before = h.updates.length;
  h.page.onEntryChange(changeEvent('walking', false));
  const changedEntries = h.updates.slice(before).filter(update => update.entries).map(update => update.entries);
  assert.ok(changedEntries.length >= 2);
  assert.equal(changedEntries[0].find(item => item.type === 'walking').visible, false);
  assert.deepEqual(changedEntries.at(-1), previousEntries);
  assert.deepEqual(plain(h.page.data.entries), previousEntries);
  assert.equal(h.page.data.visibleCount, 5);
  assert.equal(h.page.data.hiddenCount, 1);
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['kindness']);
  assert.match(h.page.data.error, /保存|重试/);
  assert.match(h.toast.at(-1).title, /未能保存/);
  assert.equal(h.toast.at(-1).icon, 'none');
});

test('a failed restore leaves existing preferences in place and never reports success', () => {
  const h = createPage({ hiddenTypes: ['sitting', 'clapping'] });
  h.page.onShow();
  const previousEntries = plain(h.page.data.entries);
  h.writeFailures.set(keyFor('oz-owner'), new Error('存储不可用'));
  h.page.restoreAll();
  assert.deepEqual(plain(h.page.data.entries), previousEntries);
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['sitting', 'clapping']);
  assert.equal(h.page.data.visibleCount, 4);
  assert.equal(h.page.data.hiddenCount, 2);
  assert.ok(h.page.data.error);
  assert.equal(h.toast.some(item => item.icon === 'success'), false);
});

test('an account change while the page is open cannot save a stale switch change into the next account or guest', () => {
  for (const nextAccount of ['oz-other', undefined]) {
    const h = createPage({ hiddenTypes: ['walking'] });
    h.storage.set(keyFor(nextAccount), ['kindness']);
    h.page.onShow();
    h.changeAccount(nextAccount);
    h.page.onEntryChange(changeEvent('clapping', false));
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['walking']);
    assert.deepEqual(h.storage.get(keyFor(nextAccount)), ['kindness']);
    assert.deepEqual(visibleTypes(h.page), TYPES.filter(type => type !== 'kindness'));
    assert.match(h.toast.at(-1).title, /账号已变化/);
    h.page.onEntryChange(changeEvent('clapping', false));
    assert.deepEqual(h.storage.get(keyFor(nextAccount)), ['kindness', 'clapping']);
    assert.equal(h.writes.length, 1);
  }
});

test('an account change also prevents restoreAll from erasing the new account preferences', () => {
  const h = createPage({ hiddenTypes: ['walking'] });
  h.storage.set(keyFor('oz-other'), ['kindness']);
  h.page.onShow();
  h.changeAccount('oz-other');
  h.page.restoreAll();
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.storage.get(keyFor('oz-other')), ['kindness']);
  assert.deepEqual(visibleTypes(h.page), TYPES.filter(type => type !== 'kindness'));
  assert.equal(h.toast.some(item => item.icon === 'success'), false);
  assert.match(h.toast.at(-1).title, /账号已变化/);
});

test('unreadable account storage shows a page error without loading or writing guest preferences', () => {
  const h = createPage({ hiddenTypes: ['walking'] });
  h.storage.set(keyFor(undefined), ['kindness']);
  h.readFailures.set('userOpenId', new Error('账号信息不可读'));
  h.page.onShow();
  assert.deepEqual(plain(h.page.data.entries), []);
  assert.match(h.page.data.error, /读取|重试/);
  h.page.onEntryChange(changeEvent('walking', false));
  h.page.restoreAll();
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.includes(keyFor(undefined)), false);
  assert.deepEqual(h.storage.get(keyFor(undefined)), ['kindness']);
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['walking']);
  h.readFailures.clear();
  h.page.onShow();
  assert.equal(h.page.data.error, '');
  assert.deepEqual(visibleTypes(h.page), TYPES.filter(type => type !== 'walking'));
});

test('an account read failure after opening rolls back a switch gesture and never writes a guest fallback', () => {
  const h = createPage({ hiddenTypes: ['kindness'] });
  h.page.onShow();
  const previousEntries = plain(h.page.data.entries);
  h.readFailures.set('userOpenId', new Error('账号读取失败'));
  h.page.onEntryChange(changeEvent('walking', false));
  assert.deepEqual(plain(h.page.data.entries), previousEntries);
  assert.ok(h.page.data.error);
  assert.equal(h.writes.length, 0);
  assert.equal(h.storage.has(keyFor(undefined)), false);
  assert.deepEqual(h.storage.get(keyFor('oz-owner')), ['kindness']);
});
