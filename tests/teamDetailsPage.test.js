const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/teamDetails/teamDetails.js');
const now = Date.parse('2026-09-19T10:00:00+08:00');
const nextResetAt = Date.parse('2026-09-20T04:00:00+08:00');
const team = { _id: 'team-a', name: '一起冥想', description: '每天一起练习', icon: 'cloud://existing-team-icon', creator: 'owner', isMember: true,
  practiceStartDate: '2026-09-01', dailyGoalMinutes: 20,
  members: ['owner', 'member', 'third'].map(openid => ({ openid, nickname: openid, isCreator: openid === 'owner' }))
};
const member = (openid, status, minutes, practiceDays, missedDays, belowGoalDays) => ({
  openid, nickname: openid, avatarUrl: '/images/avatar.png', isCreator: openid === 'owner',
  todayStatus: status, todayMinutes: minutes, practiceDays,
  qualifiedDays: practiceDays - belowGoalDays, missedDays, belowGoalDays,
  unmetDays: missedDays + belowGoalDays, totalMinutes: practiceDays * 20
});
const report = {
  teamId: 'team-a', businessDate: '2026-09-19', nextResetAt,
  settings: { practiceStartDate: '2026-09-01', dailyGoalMinutes: 20, dayBoundaryHour: 4 },
  history: { startDate: '2026-09-01', endDate: '2026-09-18', totalDays: 18 },
  summary: { memberCount: 3, notPracticedCount: 1, belowGoalCount: 1, qualifiedCount: 1 },
  members: [member('owner', 'qualified', 25, 18, 0, 1), member('member', 'below_goal', 12, 13, 5, 2), member('third', 'not_practiced', 0, 16, 2, 3)]
};
const optionalReport = {
  ...structuredClone(report),
  settings: { practiceStartDate: null, effectivePracticeStartDate: '2026-09-01', hasPracticeStartDate: false, dailyGoalMinutes: null, dayBoundaryHour: 4 },
  summary: { memberCount: 3, notPracticedCount: 1, belowGoalCount: 0, qualifiedCount: 0, practicedCount: 2 },
  overview: { memberCount: 3, totalPracticeCount: 52, activeMemberCount: 2, activityRate: 67 },
  members: report.members.map((item, index) => ({
    ...item,
    nickname: index === 0 ? 'Ripples 名称完整显示' : item.nickname,
    todayStatus: item.todayMinutes > 0 ? 'practiced' : 'not_practiced',
    qualifiedDays: 0, belowGoalDays: 0, unmetDays: item.missedDays,
    totalPracticeCount: [20, 15, 17][index], cumulativeMinutes: [385, 272, 320][index],
    todayPracticeCount: item.todayMinutes > 0 ? 1 : 0,
    lastPracticeAt: index === 2 ? null : now - (index + 1) * 60 * 60 * 1000,
    lastPracticeDate: index === 2 ? '2026-09-18' : '2026-09-19'
  }))
};
const success = data => ({ result: { success: true, data: structuredClone(data) } });
const invitation = (teamId = 'team-a', openid = 'owner', inviteId = 'invite_saved') => ({
  inviteId, expireTime: now + 7 * 24 * 60 * 60 * 1000,
  sharePath: `/subpackages/team/pages/joinTeam/joinTeam?teamId=${encodeURIComponent(teamId)}&teamName=${encodeURIComponent(team.name)}&inviterId=${encodeURIComponent(openid)}&inviteId=${encodeURIComponent(inviteId)}`,
  title: `邀请您加入${team.name}团队`
});

function createPage({ cloud, deleteTeam, checkText, checkImage, confirm = true, openid = 'owner', cached = [], clockNow = now } = {}) {
  let definition;
  let currentTime = clockNow;
  let timerId = 0;
  const timers = new Map();
  const storage = new Map([['userOpenId', openid], ['userNickname', '邀请人']]);
  const calls = { cloud: [], deletes: [], text: [], image: [], media: [], actionSheets: [], modals: [], toasts: [], redirects: [], navigation: [], shareMenus: [], back: 0, refreshStopped: 0 };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const manager = {
    teams: cached,
    addJoinedTeam(info) { this.teams = [{ ...info, cloudId: info._id }]; },
    async deleteTeam(id) {
      calls.deletes.push(id);
      return deleteTeam ? deleteTeam(id) : { success: true };
    }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name.endsWith('/teamManager.js')) return manager;
      if (name.endsWith('/contentSec.js')) return {
        async checkText(text, scene) {
          calls.text.push([text, scene]);
          return checkText ? checkText(text, scene) : true;
        },
        async checkImage(file, options) {
          calls.image.push({ file, options: { ...options } });
          return checkImage ? checkImage(file, options) : 'cloud://approved-team-icon';
        }
      };
      throw new Error(name);
    },
    Page(value) { definition = value; },
    Date: ClockDate,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      getStorageSync: key => storage.get(key),
      cloud: { async callFunction(request) {
        calls.cloud.push(request.data);
        if (cloud) return cloud(request.data.type, request.data.data);
        if (request.data.type === 'generateInvite') return success(invitation());
        return success(request.data.type === 'getTeamInfo' ? team : report);
      } },
      setNavigationBarTitle() {},
      hideShareMenu: options => calls.shareMenus.push({ action: 'hide', ...options }),
      showShareMenu: options => calls.shareMenus.push({ action: 'show', ...options }),
      showToast: options => calls.toasts.push(options),
      chooseMedia: options => calls.media.push(options),
      showActionSheet: options => calls.actionSheets.push(options),
      showModal(options) {
        calls.modals.push(options);
        if (confirm !== null && options.success) options.success({ confirm });
      },
      redirectTo: options => calls.redirects.push(options),
      navigateTo: options => calls.navigation.push(options),
      navigateBack() { calls.back++; },
      switchTab() {}, showLoading() {}, hideLoading() {},
      stopPullDownRefresh() { calls.refreshStopped++; }
    },
    console: { log() {}, warn() {}, error() {} }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  page.onLoad({ teamId: 'team-a' });
  return { page, calls, storage, manager, timers, setNow(value) { currentTime = value; } };
}
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
async function flushPromises() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('team members are the default tab, report is the only statistics source, and attention prioritizes non-practitioners', async () => {
  const { page, calls, manager } = createPage();
  await page.onShow();
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport']);
  assert.equal(calls.cloud[1].data.teamId, 'team-a');
  assert.equal(page.data.currentTab, 'members');
  assert.equal(page.data.recordTab, 'today');
  assert.equal(page.data.todayFilter, 'attention');
  assert.equal(page.data.attentionCount, 2);
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['third', 'member']);
  assert.equal(page.data.todayMembers[1].remainingMinutesLabel, '8');
  assert.equal(page.data.todayMembers[1].progress, 60);
  assert.equal(page.data.isCreator, true);
  assert.deepEqual(Array.from(manager.teams[0].members), ['owner', 'member', 'third']);
  assert.equal(manager.teams[0].cloudId, 'team-a');
});

test('today filters use the same report and history orders by unmet days including missed practice', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.changeTodayFilter(event('filter', 'qualified'));
  assert.equal(page.data.currentTab, 'records');
  assert.equal(page.data.recordTab, 'today');
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['owner']);
  page.changeTodayFilter(event('filter', 'all'));
  assert.equal(page.data.todayMembers.length, 3);
  page.switchRecordTab(event('tab', 'history'));
  assert.equal(page.data.currentTab, 'records');
  assert.equal(page.data.recordTab, 'history');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
  assert.equal(page.data.historyMembers[0].unmetDays, 7);
  assert.equal(page.data.historyMembers[0].missedDays, 5);
  assert.equal(page.data.historyRangeLabel, '2026.09.01 — 2026.09.18');
  assert.equal(calls.cloud.length, 2);
});

test('member cards open the selected member with the correct monthly or daily date context', async () => {
  const boundaryReport = structuredClone(report);
  boundaryReport.businessDate = '2026-09-01';
  boundaryReport.history.endDate = '2026-08-31';
  boundaryReport.members[1].nickname = '伙伴 & 小明 / A';
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : boundaryReport) });
  await page.onShow();
  const open = dataset => page.openMemberRecords({ currentTarget: { dataset } });
  open({ memberOpenid: 'member', view: 'month', recordScope: 'history' });
  open({ memberOpenid: 'member', view: 'month' });
  open({ memberOpenid: 'third', view: 'day' });
  const urls = calls.navigation.map(item => new URL(item.url, 'https://miniprogram.local'));
  assert.equal(urls[0].pathname, '/pages/checkinHistory/checkinHistory');
  assert.equal(urls[0].searchParams.get('teamId'), 'team-a');
  assert.equal(urls[0].searchParams.get('memberOpenid'), 'member');
  assert.equal(urls[0].searchParams.get('memberName'), '伙伴 & 小明 / A');
  assert.equal(urls[0].searchParams.get('month'), '2026-08');
  assert.equal(urls[0].searchParams.get('date'), '2026-08-31');
  assert.equal(urls[1].pathname, '/pages/checkinHistory/checkinHistory');
  assert.equal(urls[1].searchParams.get('month'), '2026-09');
  assert.equal(urls[1].searchParams.get('date'), '2026-09-01');
  assert.equal(urls[2].pathname, '/pages/history/history');
  assert.equal(urls[2].searchParams.get('memberOpenid'), 'third');
  assert.equal(urls[2].searchParams.get('date'), '2026-09-01');
  assert.equal(calls.cloud.length, 2);
});

test('member cards remain usable when team statistics fail and default to the current practice date', async () => {
  const { page, calls } = createPage({
    clockNow: Date.parse('2026-09-19T03:30:00+08:00'),
    cloud: type => type === 'getTeamInfo' ? success(team) : { result: { success: false, error: '统计加载失败' } }
  });
  await page.onShow();
  page.openMemberRecords({ currentTarget: { dataset: { memberOpenid: 'member', view: 'month' } } });
  assert.equal(calls.navigation.length, 1);
  assert.match(calls.navigation[0].url, /&month=2026-09&date=2026-09-18$/);
});

test('member record entry rejects malformed events, unknown members, nonmembers and stale account context', async () => {
  const { page, calls, storage } = createPage();
  const open = dataset => page.openMemberRecords({ currentTarget: { dataset } });
  open({ memberOpenid: 'member', view: 'month' });
  await page.onShow();
  page.openMemberRecords();
  page.openMemberRecords({});
  open({ memberOpenid: { openid: 'member' }, view: 'month' });
  open({ memberOpenid: 'outsider', view: 'month' });
  open({ memberOpenid: 'member', view: 'unknown' });
  page.data.isMember = false;
  open({ memberOpenid: 'member', view: 'month' });
  page.data.isMember = true;
  storage.set('userOpenId', 'third');
  open({ memberOpenid: 'member', view: 'day' });
  storage.set('userOpenId', 'owner');
  page.data.teamId = 'another-team';
  open({ memberOpenid: 'member', view: 'month' });
  assert.equal(calls.navigation.length, 0);
});

test('members and records are independent main tabs and record filters return to today without fetching again', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.switchTab(event('tab', 'records'));
  page.switchRecordTab(event('tab', 'history'));
  assert.equal(page.data.currentTab, 'records');
  assert.equal(page.data.recordTab, 'history');
  page.switchTab(event('tab', 'members'));
  assert.equal(page.data.currentTab, 'members');
  assert.equal(page.data.recordTab, 'history');
  page.switchTab(event('tab', 'today'));
  page.switchRecordTab(event('tab', 'members'));
  assert.equal(page.data.currentTab, 'members');
  assert.equal(page.data.recordTab, 'history');
  page.changeTodayFilter(event('filter', 'not_practiced'));
  assert.equal(page.data.currentTab, 'records');
  assert.equal(page.data.recordTab, 'today');
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['third']);
  assert.equal(calls.cloud.length, 2);
});

test('optional rules preserve member activity and show practiced members without goal or progress claims', async () => {
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo'
    ? { ...team, practiceStartDate: null, dailyGoalMinutes: null } : optionalReport) });
  await page.onShow();
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.report.settings.practiceStartDate, null);
  assert.equal(page.data.report.settings.effectivePracticeStartDate, '2026-09-01');
  assert.equal(page.data.hasGoal, false);
  assert.equal(page.data.attentionCount, 1);
  assert.equal(page.data.teamMembers.length, 3);
  const owner = page.data.teamMembers[0];
  assert.equal(owner.openid, 'owner');
  assert.equal(owner.nickname, 'Ripples 名称完整显示');
  assert.equal(owner.isCreator, true);
  assert.equal(owner.totalPracticeCount, 20);
  assert.equal(owner.cumulativeMinutesLabel, '385');
  assert.equal(owner.lastPracticeLabel, '9月19日 09:00');
  assert.equal(page.data.overview.totalPracticeCount, 52);
  assert.equal(page.data.overview.activityRate, 67);
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['third']);
  page.changeTodayFilter(event('filter', 'practiced'));
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['member', 'owner']);
  for (const item of page.data.todayMembers) {
    assert.equal(item.statusLabel, '已练习');
    assert.equal(item.remainingMinutesLabel, '');
    assert.equal(item.progress, 0);
  }
  page.openSettings();
  assert.equal(page.data.draftStartDate, '');
  assert.equal(page.data.draftGoalMinutes, '');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['owner', 'third', 'member']);
});

test('member profiles stay visible when practice statistics fail without fabricating activity counts', async () => {
  const { page } = createPage({ cloud: type => type === 'getTeamInfo'
    ? success(team) : { result: { success: false, error: '统计加载失败' } } });
  await page.onShow();
  assert.equal(page.data.report, null);
  assert.equal(page.data.reportError, '统计加载失败');
  assert.deepEqual(Array.from(page.data.teamMembers, item => item.openid), ['owner', 'member', 'third']);
  assert.equal(page.data.teamMembers.some(item => item.totalPracticeCount === 0), false);
});

test('19.99 minutes remains visibly below the 20 minute goal and tiny remaining durations are not shown as zero', async () => {
  const fractional = structuredClone(report);
  fractional.members[1].todayMinutes = 19.99;
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : fractional) });
  await page.onShow();
  const short = page.data.todayMembers.find(item => item.openid === 'member');
  assert.equal(short.todayMinutesLabel, '19.99');
  assert.equal(short.remainingMinutesLabel, '0.01');
  assert.equal(short.statusLabel, '时长不足');
  assert.ok(short.progress < 100);
  assert.equal(page.formatMinutes(19.999), '19.99');
  assert.equal(page.formatMinutes(0.001), '少于0.01');
});

test('report errors and malformed reports never manufacture empty success statistics and can retry', async () => {
  let result = { result: { success: false, error: '网络不可用' } };
  const { page } = createPage({ cloud: type => type === 'getTeamInfo' ? success(team) : result });
  await page.onShow();
  assert.equal(page.data.teamInfo._id, 'team-a');
  assert.equal(page.data.report, null);
  assert.equal(page.data.reportError, '网络不可用');
  assert.equal(page.data.isLoading, false);
  result = success({ ...report, members: [{ openid: 'member', todayStatus: 'not_practiced' }] });
  await page.loadTeamData();
  assert.equal(page.data.report, null);
  assert.match(page.data.reportError, /不完整/);
  result = success(report);
  await page.loadTeamData();
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.report.summary.memberCount, 3);
});

test('a failed refresh clears previous report rather than presenting old current-day counts as fresh', async () => {
  let failed = false;
  const { page } = createPage({ cloud: type => {
    if (type === 'getTeamInfo') return success(team);
    if (failed) throw new Error('刷新失败');
    return success(report);
  } });
  await page.onShow();
  failed = true;
  await page.onPullDownRefresh();
  assert.equal(page.data.report, null);
  assert.equal(page.data.todayMembers.length, 0);
  assert.equal(page.data.reportError, '刷新失败');
});

test('a rejected edit during initial or refreshed report loading restores records and ignores the interrupted report', async () => {
  for (const refresh of [false, true]) {
    for (const failure of ['moderation', 'update']) {
      let finishInterruptedReport;
      let reportReads = 0;
      const interruptedRead = refresh ? 2 : 1;
      const { page, calls } = createPage({
        checkText: () => failure !== 'moderation',
        cloud: type => {
          if (type === 'getTeamInfo') return success(team);
          if (type === 'updateTeam') return { result: { success: false, error: '保存失败，请重试' } };
          if (++reportReads === interruptedRead) return new Promise(resolve => { finishInterruptedReport = resolve; });
          return success(report);
        }
      });
      let interrupted = page.onShow();
      if (refresh) {
        await interrupted;
        interrupted = page.loadTeamData();
      }
      await flushPromises();
      assert.equal(typeof finishInterruptedReport, 'function');
      assert.equal(page.data.isLoading, true);
      assert.equal(page.data.report, null);
      page.openSettings();
      page.changeTeamName({ detail: { value: '保留编辑草稿' } });
      await page.saveSettings();
      assert.equal(page.data.isSaving, false);
      assert.equal(page.data.isLoading, false);
      assert.equal(page.data.reportError, '');
      assert.equal(page.data.report.members[0].todayMinutes, 25);
      assert.equal(page.data.settingsOpen, true);
      assert.equal(page.data.draftName, '保留编辑草稿');
      assert.equal(reportReads, interruptedRead + 1);
      assert.equal(calls.cloud.filter(call => call.type === 'updateTeam').length, failure === 'update' ? 1 : 0);
      if (failure === 'update') assert.match(page.data.settingsError, /保存失败/);
      const staleReport = structuredClone(report);
      staleReport.members[0].todayMinutes = 99;
      finishInterruptedReport(success(staleReport));
      await interrupted;
      assert.equal(page.data.report.members[0].todayMinutes, 25);
      assert.equal(page.data.reportError, '');
    }
  }
});

test('hiding invalidates pending reports and returning reloads while preserving the editable draft', async () => {
  const finishReports = [];
  const { page, calls } = createPage({ cloud: type => type === 'getTeamInfo'
    ? success(team) : new Promise(resolve => { finishReports.push(resolve); }) });
  const interrupted = page.onShow();
  await flushPromises();
  assert.equal(finishReports.length, 1);
  page.openSettings();
  page.changeTeamName({ detail: { value: '相册返回后保留名称' } });
  page.changeTeamDescription({ detail: { value: '相册返回后保留介绍' } });
  page.onHide();
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.settingsOpen, true);
  const resumed = page.onShow();
  await flushPromises();
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport', 'getTeamInfo', 'getTeamPracticeReport']);
  assert.equal(finishReports.length, 2);
  assert.equal(page.data.isLoading, true);
  const staleReport = structuredClone(report);
  staleReport.members[0].todayMinutes = 99;
  finishReports[0](success(staleReport));
  await interrupted;
  assert.equal(page.data.report, null);
  assert.equal(page.data.isLoading, true, 'the interrupted read cannot finish the replacement loading state');
  finishReports[1](success(report));
  await resumed;
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.report.members[0].todayMinutes, 25);
  assert.equal(page.data.settingsOpen, true);
  assert.equal(page.data.draftName, '相册返回后保留名称');
  assert.equal(page.data.draftDescription, '相册返回后保留介绍');
});

test('first-day history supports an end date before the start date and shows a dedicated empty state', async () => {
  const firstDay = { ...report, settings: { ...report.settings, practiceStartDate: '2026-09-19' }, history: { startDate: '2026-09-19', endDate: '2026-09-18', totalDays: 0 } };
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : firstDay) });
  await page.onShow();
  assert.equal(page.data.report.history.totalDays, 0);
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  assert.match(template, /report.history.totalDays > 0 \? historyRangeLabel/);
  assert.match(template, /今日不计入历史/);
});

test('creator settings save the full team fields to the cloud and reload the report under the persisted rule', async () => {
  let saved = null;
  const { page, calls } = createPage({ cloud: (type, data) => {
    if (type === 'updateTeam') { saved = data.teamData; return success({ teamId: data.teamId }); }
    if (type === 'getTeamInfo') return success({ ...team, ...saved });
    return success({ ...report, settings: { ...report.settings, ...saved } });
  } });
  await page.onShow();
  page.openSettings();
  page.changeTeamName({ detail: { value: '新的团队名称' } });
  page.changeTeamDescription({ detail: { value: '新的团队介绍' } });
  page.changeStartDate({ detail: { value: '2026-08-20' } });
  page.chooseGoalMinutes(event('minutes', 30));
  await page.saveSettings();
  assert.equal(saved.practiceStartDate, '2026-08-20');
  assert.equal(saved.dailyGoalMinutes, 30);
  assert.equal(saved.name, '新的团队名称');
  assert.equal(saved.description, '新的团队介绍');
  assert.equal(saved.icon, team.icon);
  assert.deepEqual(calls.text, [['新的团队名称', 2], ['新的团队介绍', 2]]);
  assert.equal(page.data.report.settings.dailyGoalMinutes, 30);
  assert.equal(page.data.settingsOpen, false);
  assert.equal(page.data.isSaving, false);
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport', 'updateTeam', 'getTeamInfo', 'getTeamPracticeReport']);
});

test('settings reject invalid or future dates and fractional, zero or oversized goals without writes', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.openSettings();
  for (const date of ['2026-02-30', '2026-09-20']) {
    page.setData({ draftStartDate: date });
    await page.saveSettings();
    assert.match(page.data.settingsError, /日期/);
  }
  page.setData({ draftStartDate: '2026-09-01' });
  for (const minutes of ['0', '1.5', '1441', 'abc']) {
    page.setData({ draftGoalMinutes: minutes });
    await page.saveSettings();
    assert.match(page.data.settingsError, /整数分钟/);
  }
  assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
});

test('creator can clear both optional rules and save explicit nulls without restoring defaults', async () => {
  let saved;
  const { page, calls } = createPage({ cloud: (type, data) => {
    if (type === 'updateTeam') { saved = data.teamData; return success({}); }
    if (type === 'getTeamInfo') return success({ ...team, ...saved });
    return success(saved ? optionalReport : report);
  } });
  await page.onShow();
  page.openSettings();
  page.clearStartDate();
  page.changeGoalMinutes({ detail: { value: '' } });
  await page.saveSettings();
  assert.equal(saved.practiceStartDate, null);
  assert.equal(saved.dailyGoalMinutes, null);
  assert.equal(saved.name, team.name);
  assert.equal(saved.description, team.description);
  assert.equal(saved.icon, team.icon);
  assert.equal(page.data.report.settings.dailyGoalMinutes, null);
  assert.equal(page.data.settingsOpen, false);
  page.openSettings();
  assert.equal(page.data.draftStartDate, '');
  assert.equal(page.data.draftGoalMinutes, '');
  assert.equal(calls.cloud.filter(call => call.type === 'updateTeam').length, 1);
});

test('team editing validates names, descriptions and icons before text moderation or cloud writes', async () => {
  for (const fields of [
    { draftName: '' }, { draftName: '   ' }, { draftName: '名'.repeat(21) },
    { draftDescription: '介'.repeat(101) }, { draftIcon: 'wxfile://tmp_unchecked' }, { draftIcon: true }
  ]) {
    const { page, calls } = createPage();
    await page.onShow();
    page.openSettings();
    page.setData(fields);
    await page.saveSettings();
    assert.equal(calls.text.length, 0, JSON.stringify(fields));
    assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
    assert.equal(page.data.isSaving, false);
    assert.ok(page.data.settingsError);
  }
});

test('team editing persists exactly the trimmed snapshot accepted by text moderation', async () => {
  let finishCheck;
  const { page, calls } = createPage({ checkText: text => text === '已审核名称'
    ? new Promise(resolve => { finishCheck = resolve; }) : true });
  await page.onShow();
  page.openSettings();
  page.changeTeamName({ detail: { value: ' 已审核名称 ' } });
  page.changeTeamDescription({ detail: { value: ' 已审核介绍 ' } });
  page.chooseGoalMinutes(event('minutes', 30));
  const saving = page.saveSettings();
  await page.saveSettings();
  page.changeTeamName({ detail: { value: '不应写入' } });
  page.changeTeamDescription({ detail: { value: '不应写入' } });
  page.clearStartDate();
  page.chooseGoalMinutes(event('minutes', 60));
  assert.equal(page.data.draftName, ' 已审核名称 ');
  assert.equal(page.data.draftDescription, ' 已审核介绍 ');
  assert.equal(page.data.draftStartDate, '2026-09-01');
  assert.equal(page.data.draftGoalMinutes, '30');
  page.setData({ draftName: '外部变更名称', draftDescription: '外部变更介绍', draftIcon: 'cloud://unchecked-change', draftGoalMinutes: '90' });
  finishCheck(true);
  await saving;
  assert.deepEqual(calls.text, [['已审核名称', 2], ['已审核介绍', 2]]);
  const writes = calls.cloud.filter(call => call.type === 'updateTeam');
  assert.equal(writes.length, 1);
  assert.deepEqual({ ...writes[0].data.teamData }, {
    name: '已审核名称', description: '已审核介绍', icon: team.icon, practiceStartDate: '2026-09-01', dailyGoalMinutes: 30
  });
});

test('rejected team text keeps the editable draft and blocks all cloud updates', async () => {
  for (const rejectedField of ['新的名称', '新的介绍']) {
    const { page, calls } = createPage({ checkText: text => text !== rejectedField });
    await page.onShow();
    page.openSettings();
    page.changeTeamName({ detail: { value: '新的名称' } });
    page.changeTeamDescription({ detail: { value: '新的介绍' } });
    await page.saveSettings();
    assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
    assert.equal(page.data.settingsOpen, true);
    assert.equal(page.data.draftName, '新的名称');
    assert.equal(page.data.draftDescription, '新的介绍');
    assert.equal(page.data.isSaving, false);
  }
});

test('account changes or leaving the detail page during text moderation cannot update the team', async () => {
  for (const action of ['account', 'onHide', 'onUnload']) {
    let finishCheck;
    let checks = 0;
    const { page, calls, storage } = createPage({ checkText: () => ++checks === 1 ? new Promise(resolve => { finishCheck = resolve; }) : true });
    await page.onShow();
    page.openSettings();
    const saving = page.saveSettings();
    if (action === 'account') storage.set('userOpenId', 'other-account');
    else page[action]();
    finishCheck(true);
    await saving;
    assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false, action);
    assert.equal(calls.toasts.some(item => item.icon === 'success'), false, action);
  }
});

test('team icon selection blocks parallel selection and saves and persists only the approved permanent file', async () => {
  let finishCheck;
  const { page, calls } = createPage({ checkImage: () => new Promise(resolve => { finishCheck = resolve; }) });
  await page.onShow();
  page.openSettings();
  page.chooseTeamIcon();
  page.chooseTeamIcon();
  assert.equal(calls.media.length, 1);
  const choosing = calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new-icon' }] });
  await page.saveSettings();
  page.closeSettings();
  assert.equal(page.data.isChoosingIcon, true);
  assert.equal(page.data.settingsOpen, true);
  assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
  assert.equal(calls.text.length, 0);
  finishCheck('cloud://approved-team-icon');
  await choosing;
  assert.equal(page.data.draftIcon, 'cloud://approved-team-icon');
  assert.equal(page.data.isChoosingIcon, false);
  assert.equal(calls.image[0].file, 'wxfile://tmp_new-icon');
  assert.equal(calls.image[0].options.returnFileID, true);
  assert.equal(calls.image[0].options.cloudPrefix, 'team_icons');
  await page.saveSettings();
  assert.equal(calls.cloud.find(call => call.type === 'updateTeam').data.teamData.icon, 'cloud://approved-team-icon');
});

test('cancelled or rejected team icon selection preserves the old icon and permits another selection', async () => {
  for (const checkImage of [() => false, () => true, () => 'wxfile://tmp_unchecked', () => { throw new Error('图片检测失败'); }]) {
    const { page, calls } = createPage({ checkImage });
    await page.onShow();
    page.openSettings();
    page.chooseTeamIcon();
    await calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new-icon' }] });
    assert.equal(page.data.draftIcon, team.icon);
    assert.equal(page.data.isChoosingIcon, false);
    page.chooseTeamIcon();
    assert.equal(calls.media.length, 2);
    calls.media[1].fail({ errMsg: 'chooseMedia:fail cancel' });
    assert.equal(page.data.isChoosingIcon, false);
    assert.equal(page.data.draftIcon, team.icon);
  }
});

test('an icon approved after account changes or page unload cannot replace the draft', async () => {
  for (const action of ['account', 'unload']) {
    let finishCheck;
    const { page, calls, storage } = createPage({ checkImage: () => new Promise(resolve => { finishCheck = resolve; }) });
    await page.onShow();
    page.openSettings();
    page.chooseTeamIcon();
    const choosing = calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new-icon' }] });
    if (action === 'account') storage.set('userOpenId', 'other-account');
    else page.onUnload();
    finishCheck('cloud://approved-for-old-owner');
    await choosing;
    assert.equal(page.data.draftIcon, team.icon);
    assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
  }
});

test('failed settings saves preserve the edited form and the report for the saved rule, then permit retry', async () => {
  let finishSave;
  const { page, calls } = createPage({ cloud: type => type === 'updateTeam'
    ? new Promise(resolve => { finishSave = resolve; }) : success(type === 'getTeamInfo' ? team : report) });
  await page.onShow();
  page.openSettings();
  page.chooseGoalMinutes(event('minutes', 60));
  const savedReport = page.data.report;
  const attempt = page.saveSettings();
  await flushPromises();
  await page.saveSettings();
  page.closeSettings();
  assert.equal(page.data.isSaving, true);
  assert.equal(page.data.settingsOpen, true);
  assert.equal(calls.cloud.filter(call => call.type === 'updateTeam').length, 1);
  finishSave({ result: { success: false, error: '保存失败，请重试' } });
  await attempt;
  assert.equal(page.data.report, savedReport);
  assert.equal(page.data.report.settings.dailyGoalMinutes, 20);
  assert.equal(page.data.draftGoalMinutes, '60');
  assert.equal(page.data.settingsOpen, true);
  assert.equal(page.data.isSaving, false);
  assert.match(page.data.settingsError, /保存失败/);
});

test('members can inspect persisted settings but cannot change, save, or dissolve the team', async () => {
  const { page, calls } = createPage({ openid: 'member' });
  await page.onShow();
  page.openSettings();
  assert.equal(page.data.settingsOpen, true);
  assert.equal(page.data.draftGoalMinutes, '20');
  page.changeTeamName({ detail: { value: '不应更名' } });
  page.changeTeamDescription({ detail: { value: '不应修改介绍' } });
  page.chooseTeamIcon();
  page.clearStartDate();
  page.chooseGoalMinutes(event('minutes', 60));
  page.changeStartDate({ detail: { value: '2026-08-20' } });
  await page.saveSettings();
  await page.confirmDeleteTeam();
  assert.equal(page.data.draftGoalMinutes, '20');
  assert.equal(page.data.draftStartDate, '2026-09-01');
  assert.equal(page.data.draftName, team.name);
  assert.equal(page.data.draftDescription, team.description);
  assert.equal(page.data.draftIcon, team.icon);
  assert.equal(calls.cloud.length, 2);
  assert.equal(calls.text.length, 0);
  assert.equal(calls.image.length, 0);
  assert.equal(calls.media.length, 0);
  assert.equal(calls.modals.length, 0);
});

test('04:00 rollover invalidates the report and fetches the next practice day, while hide/unload clear timers', async () => {
  let day = structuredClone(report);
  const { page, calls, timers, setNow } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : day) });
  await page.onShow();
  const scheduled = [...timers.values()][0];
  assert.equal(scheduled.delay, nextResetAt - now + 100);
  setNow(nextResetAt + 200);
  day.businessDate = '2026-09-20';
  day.nextResetAt += 24 * 60 * 60 * 1000;
  scheduled.fn();
  assert.equal(page.data.report, null);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(page.data.report.businessDate, '2026-09-20');
  assert.equal(calls.cloud.length, 4);
  page.onHide();
  assert.equal(page._resetTimer, null);
  await page.onShow();
  assert.ok(page._resetTimer);
  page.onUnload();
  assert.equal(page._resetTimer, null);
});

test('reports from an already finished practice day are explicitly stale instead of being displayed as today', async () => {
  const { page } = createPage({ clockNow: nextResetAt + 1 });
  await page.onShow();
  assert.equal(page.data.report, null);
  assert.match(page.data.reportError, /练习日已更新/);
});

test('a late response from another account cannot replace the current nonmember redirect', async () => {
  let finishOld;
  let reads = 0;
  const { page, storage, calls } = createPage({ cloud: type => {
    assert.equal(type, 'getTeamInfo');
    return ++reads === 1 ? new Promise(resolve => { finishOld = resolve; }) : success({ ...team, isMember: false });
  } });
  const oldRead = page.onShow();
  storage.set('userOpenId', 'new-account');
  await page.onShow();
  finishOld(success(team));
  await oldRead;
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.report, null);
  assert.equal(calls.cloud.length, 2);
  assert.match(calls.redirects[0].url, /joinTeam/);
});

test('switching accounts during settings save immediately removes the previous account view', async () => {
  let finishSave;
  const { page, storage, calls } = createPage({ cloud: type => type === 'updateTeam'
    ? new Promise(resolve => { finishSave = resolve; })
    : success(type === 'getTeamInfo' ? { ...team, isMember: storage.get('userOpenId') === 'owner' } : report) });
  await page.onShow();
  page.openSettings();
  page.chooseGoalMinutes(event('minutes', 30));
  const saving = page.saveSettings();
  await flushPromises();
  storage.set('userOpenId', 'another-account');
  await page.onShow();
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.report, null);
  assert.equal(page.data.settingsOpen, false);
  finishSave(success({}));
  await saving;
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(calls.toasts.length, 0);
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.report, null);
});

test('deletion is single-flight and failed deletion preserves the team and its report', async () => {
  let finishDelete;
  const { page, calls } = createPage({ confirm: null, deleteTeam: () => new Promise(resolve => { finishDelete = resolve; }) });
  await page.onShow();
  const deleting = page.confirmDeleteTeam();
  await page.confirmDeleteTeam();
  assert.equal(calls.modals.length, 1);
  calls.modals[0].success({ confirm: true });
  await Promise.resolve();
  await page.deleteTeam();
  assert.equal(calls.deletes.length, 1);
  finishDelete({ success: false, error: '网络不可用' });
  await deleting;
  assert.equal(page.data.isDeleting, false);
  assert.equal(page.data.teamInfo._id, 'team-a');
  assert.equal(page.data.report.summary.memberCount, 3);
});

test('a report issued before deletion cannot restore the deleted team', async () => {
  let finishRead;
  let reads = 0;
  const { page, manager } = createPage({ cloud: type => {
    if (type === 'getTeamInfo') return success(team);
    return ++reads === 1 ? success(report) : new Promise(resolve => { finishRead = resolve; });
  }, deleteTeam: () => { manager.teams = []; return { success: true }; } });
  await page.onShow();
  const oldRead = page.loadTeamData();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await page.deleteTeam();
  finishRead(success(report));
  await oldRead;
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.report, null);
  assert.equal(manager.teams.length, 0);
});

test('only a prepared cloud invitation can be shared and the request preserves the inviter name', async () => {
  const { page, calls, storage } = createPage();
  await page.onShow();
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  storage.set('userNickname', '名字 & 百分比%');
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, true);
  const request = calls.cloud.find(call => call.type === 'generateInvite');
  assert.equal(request.data.inviterName, '名字 & 百分比%');
  assert.equal(request.data.teamId, 'team-a');
  const shared = page.onShareAppMessage();
  assert.equal(shared.path, invitation().sharePath);
  assert.equal(shared.title, invitation().title);
  const params = new URLSearchParams(shared.path.split('?')[1]);
  assert.equal(params.get('inviterId'), 'owner');
  assert.equal(params.get('inviteId'), 'invite_saved');
  assert.deepEqual(Array.from(calls.shareMenus.at(-1).menus), ['shareAppMessage']);
  assert.equal(calls.toasts.length, 0);
});

test('members cannot prepare invitations or share one through the top-right menu', async () => {
  const { page, calls } = createPage({ openid: 'member' });
  await page.onShow();
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, false);
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(calls.shareMenus.every(call => call.action === 'hide'), true);
  assert.deepEqual(Array.from(calls.shareMenus.at(-1).menus), ['shareAppMessage', 'shareTimeline']);
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  const ownerActions = template.match(/<view wx:if="\{\{isCreator\}\}" class="hero-actions">([\s\S]*?)<\/view>/);
  assert.ok(ownerActions, 'invitation controls are only rendered for the creator');
  assert.match(ownerActions[1], /wx:if="\{\{inviteReady\}\}"[^>]*open-type="share"/);
  assert.match(ownerActions[1], /wx:else[^>]*bindtap="prepareInvite"/);
});

test('invitation generation is single-flight and failures allow a retry before sharing', async () => {
  let finishInvite;
  const { page, calls } = createPage({ cloud: type => type === 'generateInvite'
    ? new Promise(resolve => { finishInvite = resolve; }) : success(type === 'getTeamInfo' ? team : report) });
  await page.onShow();
  const failedAttempt = page.prepareInvite();
  await page.prepareInvite();
  assert.equal(page.data.isPreparingInvite, true);
  assert.equal(page.data.inviteReady, false);
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  finishInvite({ result: { success: false, error: '邀请生成失败，请重试' } });
  await failedAttempt;
  assert.equal(page.data.isPreparingInvite, false);
  assert.match(page.data.inviteError, /生成失败/);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  const retry = page.prepareInvite();
  finishInvite(success(invitation()));
  await retry;
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.data.inviteError, '');
  assert.equal(page.onShareAppMessage().path, invitation().sharePath);
});

test('expired or mismatched cloud invitations never enable sharing', async () => {
  let result;
  const { page, calls } = createPage({ cloud: type => success(type === 'generateInvite' ? result : type === 'getTeamInfo' ? team : report) });
  await page.onShow();
  for (const invalid of [
    { ...invitation(), expireTime: now },
    { ...invitation(), expireTime: undefined },
    { ...invitation(), inviteId: '' },
    { ...invitation(), sharePath: '/pages/team/team' },
    invitation('other-team'),
    invitation('team-a', 'member'),
    { ...invitation(), sharePath: invitation().sharePath.replace('invite_saved', 'other-token') }
  ]) {
    result = invalid;
    await page.prepareInvite();
    assert.equal(page.data.inviteReady, false);
    assert.equal(page.data.isPreparingInvite, false);
    assert.match(page.data.inviteError, /邀请信息无效/);
  }
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
});

test('an invitation expires while the page is visible and cannot be shared after its deadline', async () => {
  const { page, timers, setNow, calls } = createPage();
  await page.onShow();
  await page.prepareInvite();
  const expiryTimer = timers.get(page._inviteExpiryTimer);
  assert.equal(expiryTimer.delay, invitation().expireTime - now);
  setNow(invitation().expireTime);
  expiryTimer.fn();
  assert.equal(page.data.inviteReady, false);
  assert.match(page.data.inviteError, /过期/);
  assert.equal(calls.shareMenus.at(-1).action, 'hide');
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
});

test('late invitations from a hidden or unloaded page cannot enable sharing', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    let finishInvite;
    const { page, calls } = createPage({ cloud: type => type === 'generateInvite'
      ? new Promise(resolve => { finishInvite = resolve; }) : success(type === 'getTeamInfo' ? team : report) });
    await page.onShow();
    const pending = page.prepareInvite();
    page[lifecycle]();
    finishInvite(success(invitation()));
    await pending;
    assert.equal(page.data.inviteReady, false);
    assert.equal(page.data.isPreparingInvite, false);
    assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
    assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  }
});

test('account changes discard pending and already prepared owner invitations', async () => {
  let finishInvite;
  const { page, calls, storage } = createPage({ cloud: type => type === 'generateInvite'
    ? new Promise(resolve => { finishInvite = resolve; }) : success(type === 'getTeamInfo' ? team : report) });
  await page.onShow();
  const pending = page.prepareInvite();
  storage.set('userOpenId', 'member');
  await page.onShow();
  finishInvite(success(invitation()));
  await pending;
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.inviteReady, false);
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');

  const ready = createPage();
  await ready.page.onShow();
  await ready.page.prepareInvite();
  ready.storage.set('userOpenId', 'member');
  assert.equal(ready.page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(ready.page.data.inviteReady, false);
});

test('a late invitation for a previous team cannot replace the current team invitation', async () => {
  let finishOld;
  const { page } = createPage({ cloud: (type, data) => {
    if (type === 'generateInvite') return data.teamId === 'team-a'
      ? new Promise(resolve => { finishOld = resolve; }) : success(invitation(data.teamId));
    return success(type === 'getTeamInfo' ? { ...team, _id: data.teamId } : { ...report, teamId: data.teamId });
  } });
  await page.onShow();
  const pending = page.prepareInvite();
  page.setData({ teamId: 'team-b' });
  await page.loadTeamData();
  await page.prepareInvite();
  const currentPath = invitation('team-b').sharePath;
  assert.equal(page.onShareAppMessage().path, currentPath);
  finishOld(success(invitation()));
  await pending;
  assert.equal(page.onShareAppMessage().path, currentPath);
});

test('saving settings cancels an invitation in progress even when the save later fails', async () => {
  let finishInvite;
  let finishSave;
  const { page, calls } = createPage({ cloud: type => {
    if (type === 'generateInvite') return new Promise(resolve => { finishInvite = resolve; });
    if (type === 'updateTeam') return new Promise(resolve => { finishSave = resolve; });
    return success(type === 'getTeamInfo' ? team : report);
  } });
  await page.onShow();
  const inviting = page.prepareInvite();
  page.openSettings();
  const saving = page.saveSettings();
  await flushPromises();
  finishInvite(success(invitation()));
  await inviting;
  finishSave({ result: { success: false, error: '保存失败' } });
  await saving;
  assert.equal(page.data.isPreparingInvite, false);
  assert.equal(page.data.inviteReady, false);
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  const retry = page.prepareInvite();
  finishInvite(success(invitation()));
  await retry;
  assert.equal(page.data.inviteReady, true);
});

test('settings date maximum follows the 04:00 practice-day boundary rather than natural midnight', () => {
  const beforeReset = createPage({ clockNow: Date.parse('2026-09-19T03:59:59+08:00') });
  const afterReset = createPage({ clockNow: Date.parse('2026-09-19T04:00:00+08:00') });
  assert.equal(beforeReset.page.data.dateMax, '2026-09-18');
  assert.equal(afterReset.page.data.dateMax, '2026-09-19');
});

test('the settings sheet makes room for the keyboard and preserves a scrollable form and action area', async () => {
  const { page } = createPage();
  await page.onShow();
  page.openSettings();
  page.onGoalKeyboardHeightChange({ detail: { height: 280 } });
  assert.equal(page.data.keyboardHeight, 280);
  assert.equal(page.data.settingsScrollTarget, 'daily-goal-field');
  assert.equal(page.data.draftGoalMinutes, '20');
  page.onGoalKeyboardHeightChange({ detail: { height: 0 } });
  assert.equal(page.data.keyboardHeight, 0);
  assert.equal(page.data.settingsScrollTarget, '');
  page.onGoalKeyboardHeightChange({ detail: { height: 260 } });
  page.closeSettings();
  assert.equal(page.data.keyboardHeight, 0);
  page.onGoalKeyboardHeightChange({ detail: { height: 200 } });
  assert.equal(page.data.keyboardHeight, 0);
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  assert.match(template, /<scroll-view class="settings-scroll" scroll-y="true"/);
  assert.match(template, /class="sheet-backdrop" catchtap="closeSettings" catchtouchmove="preventSheetClose"/);
  assert.doesNotMatch(template, /class="sheet-overlay"[^>]*catchtouchmove/);
  const scrollArea = template.slice(template.indexOf('<scroll-view class="settings-scroll"'), template.indexOf('</scroll-view>'));
  assert.match(scrollArea, /bindtap="saveSettings"/);
  assert.match(scrollArea, /bindtap="confirmDeleteTeam"/);
});
