// These preferences control new-record entry points and practice filter choices.
// Existing records, statistics and pending uploads keep their original scope.
const STORAGE_PREFIX = 'practice_entry_preferences_v1';
const RECORD_VISIBILITY_PREFIX = 'practice_records_visible_v1';
const PRACTICES = Object.freeze([
  { type: 'sitting', name: '静坐觉察', unit: '分钟' },
  { type: 'walking', name: '走路觉察', unit: '分钟' },
  { type: 'instant', name: '即刻觉察', unit: '次' },
  { type: 'learning', name: '熏习', unit: '分钟' },
  { type: 'kindness', name: '日行一善', unit: '件' },
  { type: 'clapping', name: '禅拍', unit: '分钟' }
].map(item => Object.freeze(item)));

function currentAccountKey(prefix = STORAGE_PREFIX) {
  // Do not convert a failed account read into the guest account: a save must
  // stop rather than overwrite settings belonging to a different identity.
  const openid = wx.getStorageSync('userOpenId');
  if (openid === undefined || openid === null || openid === '') return `${prefix}:guest`;
  if (typeof openid !== 'string') {
    throw Object.assign(new Error('当前账号信息无法读取，请重试'), { code: 'INVALID_ACCOUNT' });
  }
  return `${prefix}:account:${encodeURIComponent(openid)}`;
}

function normalizeHiddenTypes(hiddenTypes) {
  const hidden = new Set(Array.isArray(hiddenTypes) ? hiddenTypes : []);
  return PRACTICES.filter(item => hidden.has(item.type)).map(item => item.type);
}

function getHiddenTypes() {
  try { return normalizeHiddenTypes(wx.getStorageSync(currentAccountKey())); }
  catch (_) { return []; }
}

function getVisiblePractices() {
  const hidden = new Set(getHiddenTypes());
  return PRACTICES.filter(item => !hidden.has(item.type));
}

function saveHiddenTypes(hiddenTypes) {
  const key = currentAccountKey();
  const hidden = normalizeHiddenTypes(hiddenTypes);
  wx.setStorageSync(key, hidden);
  return hidden;
}

function getRecordsVisible() {
  try { return wx.getStorageSync(currentAccountKey(RECORD_VISIBILITY_PREFIX)) !== false; }
  catch (_) { return false; }
}

function saveRecordsVisible(visible) {
  const value = visible === true;
  wx.setStorageSync(currentAccountKey(RECORD_VISIBILITY_PREFIX), value);
  return value;
}

module.exports = { PRACTICES, getVisiblePractices, getHiddenTypes, saveHiddenTypes, currentAccountKey,
  getRecordsVisible, saveRecordsVisible };
