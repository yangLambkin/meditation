const { createDataTeams, isDataTeam } = require('./dataTeams.js');
const direct = createDataTeams();
const currentUser = () => wx.getStorageSync('userOpenId') || '';
const ownerKey = () => {
  const owner = direct.getOwner();
  return JSON.stringify(owner ? [owner.openid, owner.studentNumber, String(owner.bindingVersion || '')] : null);
};
function assertOwner(key) {
  if (key !== ownerKey()) throw Object.assign(new Error('账号或绑定已变化，请重新加载团队'), { code: 'ACCOUNT_CHANGED' });
}

async function legacy(type, data, openid) {
  return wx.cloud.callFunction({ name: 'teamManager', data: { type, data, openid } });
}

async function lists(type, openid) {
  const owner = ownerKey();
  const scope = type === 'getUserTeams' ? 'mine' : 'public';
  const results = await Promise.all([
    legacy(type, undefined, openid).then(response => {
      const result = response && response.result;
      if (!result || !result.success) throw new Error(result && result.error || '原团队暂时无法加载');
      const teams = type === 'getAllTeams' ? result.data && result.data.teams : result.data;
      if (!Array.isArray(teams)) throw new Error('原团队列表格式异常');
      return teams.filter(team => team && !isDataTeam(team.cloudId || team._id));
    }),
    direct.list(scope, openid)
  ].map(promise => promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))));
  if (openid !== currentUser()) throw new Error('登录状态已变更，请重新加载');
  assertOwner(owner);
  const changed = results.find(result => result.status === 'rejected' && result.reason && result.reason.code === 'ACCOUNT_CHANGED');
  if (changed) throw changed.reason;
  const failedSources = [], warnings = [], teams = [], ids = new Set();
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failedSources.push(index === 0 ? 'wechat' : 'bijing');
      warnings.push(result.reason && result.reason.message || '团队暂时无法加载');
      return;
    }
    for (const team of result.value) {
      const id = team.cloudId || team._id;
      if (id && !ids.has(id)) { ids.add(id); teams.push(team); }
    }
  });
  return { result: { success: failedSources.length < 2,
    data: type === 'getAllTeams' ? { teams, count: teams.length } : teams,
    failedSources, warning: warnings.join('；'), ...(failedSources.length === 2 ? { error: warnings.join('；') } : {}) } };
}

async function callTeam(type, data, openid = currentUser()) {
  try {
    if (type === 'getUserTeams' || type === 'getAllTeams') return await lists(type, openid);
    // 来源由 ID 决定；新建永远直连 data，失败不会创建旧微信团队。
    if (type === 'createTeam' || isDataTeam(data && data.teamId)) {
      const owner = ownerKey();
      const result = await direct.run(type, data, openid);
      assertOwner(owner);
      return { result };
    }
    return await legacy(type, data, openid);
  } catch (error) {
    return { result: { success: false, error: error.message || '团队操作失败，请重试', code: error.code } };
  }
}

function getViewerKey(teamId) {
  const openid = currentUser();
  if (!isDataTeam(teamId)) return openid;
  const owner = direct.getOwner();
  return JSON.stringify([openid, owner && owner.openid === openid ? owner.studentNumber : '',
    owner && owner.openid === openid ? String(owner.bindingVersion || '') : '']);
}

module.exports = { callTeam, isDataTeam, getViewerKey, getDataOwner: () => direct.getOwner(),
  uploadTeamIcon: value => direct.uploadTeamIcon(value), isDataTeamIcon: value => direct.isDataTeamIcon(value) };
