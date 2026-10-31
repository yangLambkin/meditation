const config = require('./practiceConfig.js');

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// This is local queue ownership, not server-verified personal authorization.
// All new requests pass through this module so login can replace the shared
// service credential without changing forms, queries or persisted tasks.
function getOwner() {
  try {
    const openid = wx.getStorageSync('userOpenId');
    if (!openid || typeof openid !== 'string') return null;
    const profile = wx.getStorageSync('userInfo') || {};
    const cached = wx.getStorageSync(`bijingStatus_${openid}`);
    const profileOpenid = profile._openid || profile.openid;
    if (profileOpenid && profileOpenid !== openid) return null;
    const binding = cached && cached.account === openid && cached.binding
      ? cached.binding : profile;
    // A partially saved bind/unbind must pause rather than reuse an old owner.
    if (binding !== profile && typeof profile.bijingBound === 'boolean' &&
        (profile.bijingBound !== binding.bijingBound || profile.bijingBound &&
        (String(profile.bijingStudentNumber || '').trim().toUpperCase() !== String(binding.bijingStudentNumber || '').trim().toUpperCase() ||
          String(profile.bijingBindingVersion || '') !== String(binding.bijingBindingVersion || '')))) return null;
    if (binding.bijingBound !== true || typeof binding.bijingStudentNumber !== 'string' ||
        !binding.bijingStudentNumber.trim()) return null;
    return { openid, studentNumber: binding.bijingStudentNumber.trim().toUpperCase(),
      bindingVersion: typeof binding.bijingBindingVersion === 'string' ? binding.bijingBindingVersion : '' };
  } catch (_) { return null; }
}

async function authorize() {
  const owner = getOwner();
  if (!owner) throw failure('AUTH_REQUIRED', '请先在「我」中登录并绑定学号');
  if (!config.serviceAccessToken) throw failure('AUTH_UNAVAILABLE', '功课接口凭证尚未配置');
  return owner;
}

async function getAccessToken() {
  await authorize();
  return config.serviceAccessToken;
}

// The temporary shared credential has no per-user cached session to clear.
function clearSession() {}

module.exports = { getOwner, authorize, getAccessToken, clearSession };
