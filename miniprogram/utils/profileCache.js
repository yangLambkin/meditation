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

module.exports = { currentAccount, isCurrentAccount, readProfile, updateProfile, confirmedPatch };
