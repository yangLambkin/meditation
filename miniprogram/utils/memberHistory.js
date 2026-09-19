const homeCheckin = require('./homeCheckin.js');

function decodeParameter(value) {
  if (typeof value !== 'string') return '';
  try { return decodeURIComponent(value); } catch (error) { return value; }
}

function initialData(options) {
  // 不完整的成员链接也必须保留成员模式，不能回退到当前用户的个人记录。
  const isMemberHistory = options.teamId !== undefined || options.memberOpenid !== undefined;
  return {
    isMemberHistory,
    teamId: decodeParameter(options.teamId),
    memberOpenid: decodeParameter(options.memberOpenid),
    memberName: decodeParameter(options.memberName) || '成员',
    memberAvatar: '',
    memberStartDate: '',
    memberLoading: isMemberHistory,
    memberError: ''
  };
}

function query(data) {
  if (!data.isMemberHistory) return '';
  return `&teamId=${encodeURIComponent(data.teamId)}&memberOpenid=${encodeURIComponent(data.memberOpenid)}&memberName=${encodeURIComponent(data.memberName)}`;
}

function buildRecords(records) {
  const dailyRecords = {};
  records.forEach(record => {
    if (!homeCheckin.isValidDateKey(record.date)) return;
    if (!dailyRecords[record.date]) dailyRecords[record.date] = { records: [] };
    // 成员页只呈现练习时间与时长，不合并个人体验缓存。
    dailyRecords[record.date].records.push({
      _id: record._id, timestamp: record.timestamp, duration: record.duration
    });
  });
  return homeCheckin.buildCheckinRecords({ dailyRecords });
}

function load(page, render) {
  const viewer = wx.getStorageSync('userOpenId') || '';
  if (page._memberRequest && page._memberViewer === viewer) return page._memberRequest;
  page._memberViewer = viewer;
  const version = page._memberLoadVersion = (page._memberLoadVersion || 0) + 1;
  const isCurrent = () => !page._unloaded && page._memberLoadVersion === version;
  page._memberRecords = [];
  page.setData({ memberLoading: true, memberError: '' });
  render();

  const request = Promise.resolve().then(() => {
    if (!page.data.teamId || !page.data.memberOpenid) throw new Error('成员链接不完整，请返回团队重新打开');
    return require('./teamManager.js').getTeamMemberPracticeRecords(page.data.teamId, page.data.memberOpenid);
  }).then(result => {
    if (!isCurrent()) return false;
    if (viewer !== (wx.getStorageSync('userOpenId') || '')) throw new Error('登录状态已变更，请返回团队重新打开');
    if (!result || !result.success) throw new Error(result && result.error || '加载成员记录失败，请重试');
    const data = result.data;
    if (!data || !data.member || data.member.openid !== page.data.memberOpenid || !Array.isArray(data.records)) {
      throw new Error('成员记录暂不可用，请重试');
    }
    page._memberRecords = buildRecords(data.records);
    page.setData({
      memberName: data.member.nickname || '匿名用户',
      memberAvatar: data.member.avatarUrl || '/images/avatar.png',
      memberStartDate: homeCheckin.isValidDateKey(data.startDate) ? data.startDate : '',
      memberLoading: false,
      memberError: ''
    });
    render();
    return true;
  }).catch(error => {
    if (!isCurrent()) return false;
    page._memberRecords = [];
    page.setData({ memberLoading: false, memberError: error.message || '加载成员记录失败，请重试' });
    render();
    return false;
  }).finally(() => {
    if (page._memberRequest === request) page._memberRequest = null;
  });
  page._memberRequest = request;
  return request;
}

module.exports = { initialData, query, load };
