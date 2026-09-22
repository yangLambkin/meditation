// Transitional cache writer: keep legacy readers consistent until ProfileRepository
// replaces these keys. Async callers capture the account before starting work.
function currentAccount() {
  return wx.getStorageSync('userOpenId') || '';
}

function isCurrentAccount(expectedAccount) {
  return currentAccount() === expectedAccount;
}

function readProfile() {
  const profile = wx.getStorageSync('userInfo') || {};
  const nickname = wx.getStorageSync('userNickname');
  return { ...profile, ...(nickname ? { nickName: nickname } : {}) };
}

function updateProfile(patch, expectedAccount = currentAccount()) {
  if (!isCurrentAccount(expectedAccount)) return null;
  const profile = { ...readProfile(), ...patch };
  wx.setStorageSync('userInfo', profile);
  if (typeof profile.nickName === 'string') wx.setStorageSync('userNickname', profile.nickName);
  const loginData = wx.getStorageSync('userLoginData');
  if (loginData && (!loginData.openid || loginData.openid === expectedAccount)) {
    wx.setStorageSync('userLoginData', { ...loginData, userInfo: profile });
  }
  return profile;
}

// A full server snapshot can be older than another in-flight field update. Apply
// only fields owned by this request to the latest cache, retaining other edits.
function confirmedPatch(requestPatch, serverProfile) {
  const patch = { ...requestPatch };
  for (const field of Object.keys(patch)) {
    if (serverProfile && Object.prototype.hasOwnProperty.call(serverProfile, field)) {
      patch[field] = serverProfile[field];
    }
  }
  return patch;
}

// Keep unsynced fields separate from the display cache. A cached value alone is
// not evidence that the server accepted it. Revisions also distinguish A → B → A.
function pendingSnapshot(account = currentAccount()) {
  const saved = wx.getStorageSync(`profilePending_${account}`);
  return saved && saved.fields ? saved : { revision: 0, fields: {} };
}

function pendingPatch(snapshot) {
  const patch = {};
  for (const [field, entry] of Object.entries(snapshot.fields)) patch[field] = entry.value;
  return patch;
}

function beginProfileRequest(patch, account = currentAccount()) {
  if (!isCurrentAccount(account)) return null;
  const previous = pendingSnapshot(account);
  const revision = previous.revision + 1;
  const fields = { ...previous.fields };
  for (const [field, value] of Object.entries(patch)) fields[field] = { value, revision };
  const staged = { revision, fields };
  wx.setStorageSync(`profilePending_${account}`, staged);
  return staged;
}

function stageProfile(patch, account = currentAccount()) {
  if (!isCurrentAccount(account)) return null;
  const previous = pendingSnapshot(account);
  const staged = beginProfileRequest(patch, account);
  try {
    updateProfile(patch, account);
  } catch (error) {
    wx.setStorageSync(`profilePending_${account}`, previous);
    throw error;
  }
  return staged;
}

// A newer local edit owns its fields even when an older request completes later.
function currentRequestPatch(patch, snapshot, account = currentAccount()) {
  if (!isCurrentAccount(account)) return {};
  const current = pendingSnapshot(account);
  const accepted = {};
  for (const [field, value] of Object.entries(patch)) {
    const before = snapshot.fields[field];
    const after = current.fields[field];
    if ((before && before.revision) === (after && after.revision)) accepted[field] = value;
  }
  return accepted;
}

function acknowledgePending(patch, snapshot, account = currentAccount()) {
  // This account-scoped acknowledgement can run after a successful local →
  // cloud identity transition. It never updates another account's display cache.
  const current = pendingSnapshot(account);
  const fields = { ...current.fields };
  for (const field of Object.keys(patch)) {
    const before = snapshot.fields[field];
    const after = fields[field];
    if (before && after && before.revision === after.revision) delete fields[field];
  }
  wx.setStorageSync(`profilePending_${account}`, { revision: current.revision, fields });
}

// Binding has confirmed a replacement on the server. Discard only those fields;
// in-flight requests holding their old revisions can no longer restore them.
function discardPendingFields(names, account = currentAccount()) {
  if (!isCurrentAccount(account)) return;
  const current = pendingSnapshot(account);
  const fields = { ...current.fields };
  for (const field of names) delete fields[field];
  wx.setStorageSync(`profilePending_${account}`, { revision: current.revision, fields });
}

// Edits made while the first login is in flight still belong to the same person.
// Move the remaining draft after acknowledging the fields that login saved.
function migratePending(fromAccount, toAccount) {
  if (fromAccount === toAccount || !isCurrentAccount(toAccount)) return;
  const source = pendingSnapshot(fromAccount);
  const patch = pendingPatch(source);
  if (!Object.keys(patch).length) return;
  beginProfileRequest(patch, toAccount);
  acknowledgePending(patch, source, fromAccount);
}

module.exports = {
  currentAccount, isCurrentAccount, readProfile, updateProfile, confirmedPatch,
  pendingSnapshot, pendingPatch, beginProfileRequest, stageProfile, currentRequestPatch, acknowledgePending,
  discardPendingFields, migratePending
};
