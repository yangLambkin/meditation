function hasDailyGoal(report) {
  return Boolean(report && report.settings && Number(report.settings.dailyGoalMinutes) > 0);
}

function normalizeName(value) {
  // Keep Unicode names and emoji joiners intact while preventing extra lines or bidi overrides.
  return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+/g, ' ')
    .trim() || '未设置昵称';
}

function selectReminderMembers(report) {
  const hasGoal = hasDailyGoal(report);
  return (report && Array.isArray(report.members) ? report.members : [])
    .filter(member => member && (member.todayStatus === 'not_practiced' ||
      hasGoal && member.todayStatus === 'below_goal'))
    .map(member => ({ ...member, nickname: normalizeName(member.nickname),
      todayMinutes: Math.max(0, Number(member.todayMinutes) || 0) }))
    .sort((a, b) => Number(a.todayStatus !== 'not_practiced') - Number(b.todayStatus !== 'not_practiced') ||
      a.todayMinutes - b.todayMinutes || a.nickname.localeCompare(b.nickname));
}

function buildReminderText({ report } = {}) {
  if (!report || !Array.isArray(report.members)) {
    throw new Error('当日练习数据不完整，请刷新后重试');
  }
  const members = selectReminderMembers(report);
  if (!members.length) throw new Error('当日没有需要提醒的成员');
  return { text: members.map(member => member.nickname).join('\n'), memberCount: members.length };
}

module.exports = { selectReminderMembers, buildReminderText };
