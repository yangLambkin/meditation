const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const preferences = require('../miniprogram/utils/timerReminderSettings');

const pagePath = path.join(__dirname, '../miniprogram/pages/timerSettings/timerSettings.js');
const plain = value => JSON.parse(JSON.stringify(value));
const changeEvent = (type, index) => ({ currentTarget: { dataset: { type } }, detail: { value: String(index) } });

function createSettings(saved) {
  const storage = new Map();
  if (saved !== undefined) storage.set(preferences.STORAGE_KEY, structuredClone(saved));
  const writes = [], toasts = [];
  let readError, writeError;
  const wx = {
    getStorageSync(key) {
      if (readError) throw readError;
      return structuredClone(storage.get(key));
    },
    setStorageSync(key, value) {
      if (writeError) throw writeError;
      writes.push({ key, value: structuredClone(value) });
      storage.set(key, structuredClone(value));
    },
    showToast(value) { toasts.push(plain(value)); }
  };
  function openPage() {
    let definition;
    vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
      wx,
      require(name) { assert.equal(name, '../../utils/timerReminderSettings'); return preferences; },
      Page(value) { definition = value; }
    }, { filename: pagePath });
    const page = { ...definition, data: structuredClone(definition.data),
      setData(value) { Object.assign(this.data, value); } };
    page.onShow();
    return page;
  }
  return { wx, storage, writes, toasts, openPage,
    failRead(value = new Error('读取失败')) { readError = value; },
    failWrite(value = new Error('存储已满')) { writeError = value; } };
}

test('reminders default to bells and normalize each malformed saved field independently', () => {
  for (const [saved, expected] of [
    [undefined, { start: 'bell', end: 'bell' }],
    [null, { start: 'bell', end: 'bell' }],
    ['vibrate', { start: 'bell', end: 'bell' }],
    [{ start: 'vibrate', end: 'unknown' }, { start: 'vibrate', end: 'bell' }],
    [{ start: false, end: 'vibrate' }, { start: 'bell', end: 'vibrate' }]
  ]) {
    const h = createSettings(saved);
    assert.deepEqual(preferences.getReminderSettings(h.wx), expected);
    assert.equal(h.writes.length, 0, 'reading defaults must not create or replace storage');
  }
});

test('start and end choices persist separately and survive reopening and changing back to bell', () => {
  const h = createSettings();
  const page = h.openPage();
  assert.deepEqual(plain(page.data.reminders.map(item => item.modeIndex)), [0, 0]);
  page.onReminderChange(changeEvent('start', 1));
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'vibrate', end: 'bell' });
  const reopened = h.openPage();
  assert.deepEqual(plain(reopened.data.reminders.map(item => item.modeIndex)), [1, 0]);
  reopened.onReminderChange(changeEvent('end', 1));
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'vibrate', end: 'vibrate' });
  reopened.onReminderChange(changeEvent('start', 0));
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'bell', end: 'vibrate' });
  assert.deepEqual(plain(h.openPage().data.reminders.map(item => item.modeIndex)), [0, 1]);
  assert.equal(h.writes.length, 3);
});

test('returning to an open settings page refreshes choices from current device preferences', () => {
  const h = createSettings();
  const page = h.openPage();
  h.storage.set(preferences.STORAGE_KEY, { start: 'bell', end: 'vibrate' });
  page.onShow();
  assert.deepEqual(plain(page.data.reminders.map(item => item.modeIndex)), [0, 1]);
  assert.equal(h.writes.length, 0);
});

test('a failed save restores the displayed choice and preserves the previously saved preferences', () => {
  const h = createSettings({ start: 'bell', end: 'vibrate' });
  const page = h.openPage();
  h.failWrite();
  page.onReminderChange(changeEvent('start', 1));
  assert.deepEqual(plain(page.data.reminders.map(item => item.modeIndex)), [0, 1]);
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'bell', end: 'vibrate' });
  assert.match(page.data.error, /未能保存/);
  assert.equal(h.toasts.at(-1).icon, 'none');
  assert.equal(h.writes.length, 0);
  h.failWrite(null);
  page.onReminderChange(changeEvent('start', 1));
  assert.equal(page.data.error, '');
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'vibrate', end: 'vibrate' });
});

test('a failed read uses bell fallback for cues but cannot overwrite saved preferences', () => {
  const h = createSettings({ start: 'vibrate', end: 'vibrate' });
  const page = h.openPage();
  h.failRead();
  assert.deepEqual(preferences.getReminderSettings(h.wx), { start: 'bell', end: 'bell' });
  page.onReminderChange(changeEvent('start', 0));
  assert.deepEqual(plain(page.data.reminders.map(item => item.modeIndex)), [1, 1]);
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'vibrate', end: 'vibrate' });
  assert.equal(h.writes.length, 0);
  assert.match(page.data.error, /未能保存/);
});

test('invalid reminder types or modes cannot create arbitrary settings', () => {
  const h = createSettings({ start: 'bell', end: 'bell' });
  for (const [type, mode] of [['other', 'vibrate'], ['start', 'silent'], ['__proto__', 'bell']]) {
    assert.throws(() => preferences.setReminderMode(type, mode, h.wx), /无效/);
  }
  const page = h.openPage();
  page.onReminderChange(changeEvent('other', 1));
  page.onReminderChange(changeEvent('end', 2));
  page.onReminderChange(changeEvent('end', -1));
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.storage.get(preferences.STORAGE_KEY), { start: 'bell', end: 'bell' });
});
