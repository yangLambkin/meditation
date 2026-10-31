const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preferencesPath = path.join(__dirname, '../miniprogram/utils/practicePreferences.js');
const PREFIX = 'practice_entry_preferences_v1';
const accountKey = openid => `${PREFIX}:account:${encodeURIComponent(openid)}`;
const GUEST_KEY = `${PREFIX}:guest`;
const PRACTICES = [
  { type: 'sitting', name: '静坐觉察', unit: '分钟' },
  { type: 'walking', name: '走路觉察', unit: '分钟' },
  { type: 'instant', name: '即刻觉察', unit: '次' },
  { type: 'learning', name: '熏习', unit: '分钟' },
  { type: 'kindness', name: '日行一善', unit: '件' },
  { type: 'clapping', name: '禅拍', unit: '分钟' }
];
const TYPES = PRACTICES.map(item => item.type);
const plain = value => JSON.parse(JSON.stringify(value));

function createPreferences({ openid = 'oz-owner', storage = new Map() } = {}) {
  if (openid === undefined) storage.delete('userOpenId');
  else storage.set('userOpenId', openid);
  const reads = [], writes = [], readFailures = new Map(), writeFailures = new Map();
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
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(preferencesPath, 'utf8'), { module, exports: module.exports, wx, console }, { filename: preferencesPath });
  return { preferences: module.exports, storage, reads, writes, readFailures, writeFailures,
    changeAccount(value) {
      if (value === undefined) storage.delete('userOpenId');
      else storage.set('userOpenId', value);
    } };
}

test('practice preferences expose the six supported practices in their fixed order and show all by default', () => {
  const h = createPreferences();
  assert.deepEqual(plain(h.preferences.PRACTICES), PRACTICES);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
  assert.equal(h.writes.length, 0);
});

test('account storage keys encode the complete raw openid and keep named accounts separate from guests', () => {
  const h = createPreferences();
  for (const openid of ['oz-owner', '账户:/ %', ' guest ', 'guest']) {
    h.changeAccount(openid);
    assert.equal(h.preferences.currentAccountKey(), accountKey(openid));
    assert.notEqual(h.preferences.currentAccountKey(), GUEST_KEY);
  }
  for (const openid of [undefined, null, '']) {
    h.changeAccount(openid);
    assert.equal(h.preferences.currentAccountKey(), GUEST_KEY);
  }
});

test('saving hidden types persists a normalized fixed-order array synchronously and survives a fresh module load', () => {
  const h = createPreferences();
  const saved = h.preferences.saveHiddenTypes(['clapping', 'walking', 'all', 'walking', 'unknown', null, 5, 'sitting']);
  assert.deepEqual(plain(saved), ['sitting', 'walking', 'clapping']);
  assert.deepEqual(h.storage.get(accountKey('oz-owner')), ['sitting', 'walking', 'clapping']);
  assert.deepEqual(h.writes, [{ key: accountKey('oz-owner'), value: ['sitting', 'walking', 'clapping'] }]);
  const reloaded = createPreferences({ storage: h.storage });
  assert.deepEqual(plain(reloaded.preferences.getHiddenTypes()), ['sitting', 'walking', 'clapping']);
  assert.deepEqual(plain(reloaded.preferences.getVisiblePractices()), PRACTICES.filter(item => !['sitting', 'walking', 'clapping'].includes(item.type)));
});

test('hidden and visible practices reread the current stored value on every call', () => {
  const h = createPreferences();
  h.storage.set(accountKey('oz-owner'), ['walking']);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['walking']);
  h.storage.set(accountKey('oz-owner'), ['kindness', 'instant', 'kindness', 'unsupported']);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['instant', 'kindness']);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES.filter(item => !['instant', 'kindness'].includes(item.type)));
  h.storage.delete(accountKey('oz-owner'));
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
});

test('account switching and logout preserve independent preferences including an account literally named guest', () => {
  const h = createPreferences();
  for (const [openid, hidden] of [
    ['oz-owner', ['sitting']], ['oz-other', ['walking']], [undefined, ['kindness']], ['guest', ['clapping']]
  ]) {
    h.changeAccount(openid);
    assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
    h.preferences.saveHiddenTypes(hidden);
  }
  for (const [openid, hidden] of [
    ['oz-owner', ['sitting']], ['oz-other', ['walking']], [null, ['kindness']], ['', ['kindness']], ['guest', ['clapping']]
  ]) {
    h.changeAccount(openid);
    assert.deepEqual(plain(h.preferences.getHiddenTypes()), hidden, String(openid));
    assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES.filter(item => !hidden.includes(item.type)), String(openid));
  }
  assert.deepEqual(h.storage.get(GUEST_KEY), ['kindness']);
  assert.deepEqual(h.storage.get(accountKey('guest')), ['clapping']);
});

test('malformed preference caches fall back to all visible without writing over stored data', () => {
  const h = createPreferences();
  for (const cached of [undefined, null, 'walking', '["walking"]', {}, { hiddenTypes: ['walking'] }, 1, true]) {
    h.storage.set(accountKey('oz-owner'), cached);
    assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
    assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
    assert.deepEqual(h.storage.get(accountKey('oz-owner')), cached);
  }
  assert.equal(h.writes.length, 0);
});

test('cached hidden arrays discard invalid values and duplicates while retaining only supported practice types', () => {
  const h = createPreferences();
  h.storage.set(accountKey('oz-owner'), ['clapping', 'all', 'instant', 'walking', 'instant', '', 'WALKING', {}, null]);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['walking', 'instant', 'clapping']);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES.filter(item => !['walking', 'instant', 'clapping'].includes(item.type)));
  assert.equal(h.writes.length, 0);
});

test('account read failures fall back to all visible but prevent account key resolution and saving', () => {
  const h = createPreferences();
  const error = new Error('账号缓存无法读取');
  h.storage.set(GUEST_KEY, ['kindness']);
  h.storage.set(accountKey('oz-owner'), ['walking']);
  h.readFailures.set('userOpenId', error);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
  assert.throws(() => h.preferences.currentAccountKey(), error);
  assert.throws(() => h.preferences.saveHiddenTypes(['clapping']), error);
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.includes(GUEST_KEY), false);
  assert.deepEqual(h.storage.get(GUEST_KEY), ['kindness']);
  assert.deepEqual(h.storage.get(accountKey('oz-owner')), ['walking']);
});

test('malformed account caches cannot reuse or overwrite guest preferences', () => {
  const h = createPreferences();
  h.storage.set(GUEST_KEY, ['kindness']);
  for (const openid of [false, 12, {}, ['oz-owner']]) {
    h.changeAccount(openid);
    assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
    assert.throws(() => h.preferences.currentAccountKey(), { code: 'INVALID_ACCOUNT' });
    assert.throws(() => h.preferences.saveHiddenTypes(['walking']), { code: 'INVALID_ACCOUNT' });
  }
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.includes(GUEST_KEY), false);
  assert.deepEqual(h.storage.get(GUEST_KEY), ['kindness']);
});

test('preference read failures fall back to all visible without repairing or erasing the saved array', () => {
  const h = createPreferences();
  h.storage.set(accountKey('oz-owner'), ['walking']);
  h.readFailures.set(accountKey('oz-owner'), new Error('偏好缓存无法读取'));
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), []);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.storage.get(accountKey('oz-owner')), ['walking']);
  h.readFailures.clear();
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['walking']);
});

test('failed saves throw synchronously and leave the previous preference usable', () => {
  const h = createPreferences();
  h.preferences.saveHiddenTypes(['walking']);
  const error = new Error('本机存储已满');
  h.writeFailures.set(accountKey('oz-owner'), error);
  assert.throws(() => h.preferences.saveHiddenTypes(['kindness']), error);
  assert.deepEqual(h.storage.get(accountKey('oz-owner')), ['walking']);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['walking']);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES.filter(item => item.type !== 'walking'));
  assert.equal(h.storage.has(GUEST_KEY), false);
});

test('an empty or invalid hidden selection restores all practice entries', () => {
  const h = createPreferences();
  for (const hiddenTypes of [[], undefined, null, 'walking', { type: 'walking' }, 1]) {
    h.preferences.saveHiddenTypes(['walking', 'kindness']);
    assert.deepEqual(plain(h.preferences.saveHiddenTypes(hiddenTypes)), []);
    assert.deepEqual(h.storage.get(accountKey('oz-owner')), []);
    assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
  }
});

test('all six practices may be hidden and later restored together', () => {
  const h = createPreferences();
  assert.deepEqual(plain(h.preferences.saveHiddenTypes([...TYPES].reverse())), TYPES);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), TYPES);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), []);
  h.preferences.saveHiddenTypes([]);
  assert.deepEqual(plain(h.preferences.getVisiblePractices()), PRACTICES);
});
