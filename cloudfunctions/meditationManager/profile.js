// Only displayable profile fields may be written by a client. Identity is supplied
// by the entry point's WXContext; login and binding fields belong to other flows.
const PROFILE_FIELDS = [
  'nickName', 'avatarUrl', 'isCustomAvatar', 'profileComplete', 'dataSource',
  'migrationStatus', 'gender', 'country', 'province', 'city'
];
const DISPLAY_FIELDS = [...PROFILE_FIELDS, 'createTime', 'lastUpdateTime'];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validatePatch(userInfo) {
  if (!userInfo || typeof userInfo !== 'object' || Array.isArray(userInfo)) {
    throw new Error('用户资料格式无效');
  }
  const patch = {};
  for (const field of PROFILE_FIELDS) {
    if (!has(userInfo, field)) continue;
    const value = userInfo[field];
    if (field === 'isCustomAvatar' || field === 'profileComplete') {
      if (typeof value !== 'boolean') throw new Error(`${field} 必须为布尔值`);
    } else if (field === 'gender') {
      if (![0, 1, 2].includes(value)) throw new Error('性别格式无效');
    } else {
      if (typeof value !== 'string') throw new Error(`${field} 必须为文本`);
      if (field === 'nickName' && (!value.trim() || value.trim().length > 15)) throw new Error('昵称长度应在 1–15 个字符之间');
      if (field === 'avatarUrl' && (!value.trim() || value.length > 2048)) throw new Error('头像地址无效');
      if (!['nickName', 'avatarUrl'].includes(field) && value.length > 100) throw new Error(`${field} 过长`);
    }
    patch[field] = field === 'nickName' ? value.trim() : value;
  }
  return patch;
}

function displayProfile(record) {
  const profile = {};
  for (const field of DISPLAY_FIELDS) {
    if (has(record, field)) profile[field] = record[field];
  }
  return profile;
}

async function updateUserProfile({ db, openid, userInfo, userType = 'new' }) {
  if (typeof openid !== 'string' || !openid.trim()) {
    return { success: false, code: 'UNAUTHORIZED', error: '请先登录' };
  }
  let patch;
  try { patch = validatePatch(userInfo); } catch (error) {
    return { success: false, code: 'INVALID_PROFILE', error: error.message };
  }
  try {
    const users = db.collection('users');
    const existing = await users.where({ _openid: openid }).get();
    const now = new Date();
    let saved;
    if (existing.data.length) {
      const userRef = users.doc(existing.data[0]._id);
      if (Object.keys(patch).length) {
        await userRef.update({ data: { ...patch, lastUpdateTime: now } });
        saved = (await userRef.get()).data;
      } else {
        saved = existing.data[0];
      }
    } else {
      saved = {
        nickName: '静心者', avatarUrl: '/images/avatar.png', isCustomAvatar: false,
        profileComplete: false, dataSource: 'custom', migrationStatus: 'new',
        ...patch, _openid: openid, loginCount: 0, createTime: now, lastUpdateTime: now
      };
      await users.add({ data: saved });
    }
    return { success: true, data: { openid, userType, updateTime: now, userInfo: displayProfile(saved) } };
  } catch (error) {
    return { success: false, code: 'PROFILE_SAVE_FAILED', error: error.message || '资料保存失败，请重试' };
  }
}

module.exports = { updateUserProfile };
