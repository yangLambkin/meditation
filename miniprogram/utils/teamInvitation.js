const KEY = 'pendingTeamInvitation';

function getPendingInvitation() {
  const invitation = wx.getStorageSync(KEY);
  const account = wx.getStorageSync('userOpenId') || '';
  if (!invitation || typeof invitation.teamId !== 'string' || !invitation.teamId ||
      typeof invitation.inviteId !== 'string' || !invitation.inviteId ||
      !Number.isFinite(invitation.expiresAt) || invitation.expiresAt <= Date.now() ||
      invitation.account && invitation.account !== account) return null;
  return invitation;
}

function savePendingInvitation(invitation) {
  wx.setStorageSync(KEY, invitation);
}

function clearPendingInvitation(invitation) {
  const pending = getPendingInvitation();
  if (pending && pending.teamId === invitation.teamId && pending.inviteId === invitation.inviteId) wx.removeStorageSync(KEY);
}

function bindingSnapshot() {
  const profileCache = require('./profileCache.js');
  const account = profileCache.currentAccount();
  const profile = profileCache.readProfile();
  return JSON.stringify([account, profile._openid || profile.openid || '', profile.bijingBound,
    profile.bijingStudentNumber, profile.bijingBindingVersion, wx.getStorageSync(`bijingStatus_${account}`),
    profileCache.getConfirmedBijingBinding(account)]);
}

// Login only saves display fields. Recover the server binding before deciding
// that a student needs to bind again, without overwriting a newer local change.
async function restoreDataBinding(account, isCurrent = () => true) {
  const profileCache = require('./profileCache.js');
  const practiceAuth = require('./practiceAuth.js');
  const cloudApi = require('./cloudApi.js');
  const snapshot = bindingSnapshot();
  let timer;
  let response;
  try {
    response = await Promise.race([
      cloudApi.callCloudFunction('meditationManager', { type: 'getUserProfile', openid: account }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('学号绑定状态加载超时，请重试')), 10000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!isCurrent() || !profileCache.isCurrentAccount(account) || snapshot !== bindingSnapshot()) {
    throw new Error('账号或绑定已变化，请重新接受邀请');
  }
  const result = response && response.result;
  const profile = result && result.data;
  if (!result || result.success !== true || !(profile === null || profile && typeof profile === 'object' && !Array.isArray(profile))) {
    throw new Error(result && result.error || '学号绑定状态加载失败，请重试');
  }
  if (profile && (profile._openid || profile.openid) && (profile._openid || profile.openid) !== account) {
    throw new Error('账号资料不匹配，请重新登录');
  }
  const bound = !!(profile && profile.bijingBound === true &&
    typeof profile.bijingStudentNumber === 'string' && profile.bijingStudentNumber.trim());
  const binding = { bijingBound: bound, bijingStudentNumber: bound ? profile.bijingStudentNumber.trim().toUpperCase() : '',
    bijingBindingVersion: bound ? profile.bijingBindingVersion || null : null };
  profileCache.rememberBijingBinding(binding, account);
  profileCache.updateProfile({ ...binding, _openid: account }, account);
  wx.setStorageSync(`bijingStatus_${account}`, { account, updatedAt: Date.now(), binding });
  return practiceAuth.getOwner();
}

module.exports = { getPendingInvitation, savePendingInvitation, clearPendingInvitation, restoreDataBinding };
