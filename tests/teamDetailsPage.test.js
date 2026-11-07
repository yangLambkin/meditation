const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/teamDetails/teamDetails.js');
const now = Date.parse('2026-09-19T10:00:00+08:00');
const nextResetAt = Date.parse('2026-09-20T02:00:00+08:00');
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
  settings: { practiceStartDate: '2026-09-01', dailyGoalMinutes: 20, dayBoundaryHour: 2 },
  history: { startDate: '2026-09-01', endDate: '2026-09-18', totalDays: 18 },
  summary: { memberCount: 3, notPracticedCount: 1, belowGoalCount: 1, qualifiedCount: 1 },
  members: [member('owner', 'qualified', 25, 18, 0, 1), member('member', 'below_goal', 12, 13, 5, 2), member('third', 'not_practiced', 0, 16, 2, 3)]
};
const optionalReport = {
  ...structuredClone(report),
  settings: { practiceStartDate: null, effectivePracticeStartDate: '2026-09-01', hasPracticeStartDate: false, dailyGoalMinutes: null, dayBoundaryHour: 2 },
  summary: { memberCount: 3, notPracticedCount: 1, belowGoalCount: 0, qualifiedCount: 0, practicedCount: 2 },
  overview: { memberCount: 3, totalPracticeCount: 52, activeMemberCount: 2, activityRate: 67 },
  members: report.members.map((item, index) => ({
    ...item,
    nickname: index === 0 ? 'Ripples 名称完整显示' : item.nickname,
    todayStatus: item.todayMinutes > 0 ? 'practiced' : 'not_practiced',
    qualifiedDays: 0, belowGoalDays: 0, unmetDays: 0,
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

// Use the actual default view unless a case explicitly starts on the members tab.
function createPage({ initialTab = null, cloud, generateInvite, deleteTeam, removeTeamMember, setTeamDeputy, transferTeamLeader, checkText, checkImage, uploadIcon, reminderImage, canvasQuery, canvasNode = {}, confirm = true, openid = 'owner', cached = [], clockNow = now } = {}) {
  let definition;
  let currentTime = clockNow;
  let timerId = 0;
  const timers = new Map();
  const storage = new Map([['userOpenId', openid], ['userNickname', '邀请人']]);
  const calls = { uploads: [], cloud: [], deletes: [], removals: [], deputyChanges: [], transfers: [], text: [], image: [], media: [], actionSheets: [], modals: [], toasts: [], redirects: [], navigation: [], scrolls: [], shareMenus: [], clipboard: [], reminderImages: [], canvasQueries: [], albums: [], previews: [], settings: [], back: 0, refreshStopped: 0, keyboardHidden: 0 };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const manager = {
    teams: cached,
    addJoinedTeam(info) { this.teams = [{ ...info, cloudId: info._id }]; },
    async removeTeamMember(teamId, memberOpenid) {
      calls.removals.push({ teamId, memberOpenid });
      return removeTeamMember ? removeTeamMember(teamId, memberOpenid) : { success: true };
    },
    async setTeamDeputy(teamId, memberOpenid, isDeputy) {
      calls.deputyChanges.push({ teamId, memberOpenid, isDeputy });
      return setTeamDeputy ? setTeamDeputy(teamId, memberOpenid, isDeputy) : { success: false, error: '未设置副团长接口' };
    },
    async transferTeamLeader(teamId, memberOpenid) {
      calls.transfers.push({ teamId, memberOpenid });
      return transferTeamLeader ? transferTeamLeader(teamId, memberOpenid) : { success: false, error: '未设置团长交接接口' };
    },
    async deleteTeam(id) {
      calls.deletes.push(id);
      return deleteTeam ? deleteTeam(id) : { success: true };
    }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name.endsWith('/teamGateway.js')) return {
        async callTeam(type, data) {
          calls.cloud.push({ type, data });
          if (type === 'generateInvite') return generateInvite ? generateInvite(data) : success(invitation());
          if (cloud) return cloud(type, data);
          return success(type === 'getTeamInfo' ? team : report);
        },
        isDataTeam: id => typeof id === 'string' && id.startsWith('bijing_'),
        getViewerKey: id => typeof id === 'string' && id.startsWith('bijing_')
          ? JSON.stringify([storage.get('userOpenId'), storage.get('bijingStudentNumber') || 'BJ007', storage.get('bijingBindingVersion') || 'v1']) : storage.get('userOpenId'),
        isDataTeamIcon: value => typeof value === 'string' && value.startsWith('https://data.bijing.life/api/public/teams/avatar?'),
        async uploadTeamIcon(file) { calls.uploads.push(file); return uploadIcon ? uploadIcon(file) : 'https://data.bijing.life/api/public/teams/avatar?key=approved'; }
      };
      if (name.endsWith('/practicePreferences.js')) return require('../miniprogram/utils/practicePreferences.js');
      if (name.endsWith('/teamPracticeSelection.js')) return require('../miniprogram/utils/teamPracticeSelection.js');
      if (name.endsWith('/dateUtil.js')) return require('../miniprogram/utils/dateUtil.js');
      if (name.endsWith('/teamManager.js')) return manager;
      if (name.endsWith('/reminderText.js')) return require('../miniprogram/subpackages/team/utils/reminderText.js');
      if (name.endsWith('/reminderImage.js')) return {
        async createReminderImage(options) {
          calls.reminderImages.push(options);
          return reminderImage ? reminderImage(options) : { tempFilePath: '/tmp/reminder.png', width: 750, height: 500 };
        }
      };
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
        if (request.data.type === 'generateInvite') return generateInvite ? generateInvite(request.data.data) : success(invitation());
        if (cloud) return cloud(request.data.type, request.data.data);
        return success(request.data.type === 'getTeamInfo' ? team : report);
      } },
      setNavigationBarTitle() {},
      hideKeyboard() { calls.keyboardHidden++; },
      hideShareMenu: options => calls.shareMenus.push({ action: 'hide', ...options }),
      showShareMenu: options => calls.shareMenus.push({ action: 'show', ...options }),
      showToast: options => calls.toasts.push(options),
      createSelectorQuery() {
        const query = {};
        const chain = {
          in(page) { query.page = page; return chain; },
          select(selector) { query.selector = selector; return chain; },
          fields(options) { query.fields = options; return chain; },
          exec(callback) {
            calls.canvasQueries.push(query);
            if (canvasQuery) return canvasQuery(callback, query);
            callback([{ node: canvasNode }]);
          }
        };
        return chain;
      },
      setClipboardData(options) { calls.clipboard.push(options); },
      saveImageToPhotosAlbum(options) { calls.albums.push(options); },
      openSetting(options) { calls.settings.push(options); },
      previewImage(options) { calls.previews.push(options); },
      chooseMedia: options => calls.media.push(options),
      showActionSheet: options => calls.actionSheets.push(options),
      showModal(options) {
        calls.modals.push(options);
        if (confirm !== null && options.success) options.success({ confirm });
      },
      redirectTo: options => calls.redirects.push(options),
      navigateTo: options => calls.navigation.push(options),
      pageScrollTo: options => calls.scrolls.push(options),
      navigateBack() { calls.back++; },
      switchTab() {}, showLoading() {}, hideLoading() {},
      stopPullDownRefresh() { calls.refreshStopped++; }
    },
    console: { log() {}, warn() {}, error() {} }
  }, { filename: pagePath });
  function createNextPage({ teamId = 'team-a' } = {}) {
    const page = { ...definition, data: structuredClone(definition.data), dataUpdates: [],
      setData(values, callback) {
        this.dataUpdates.push(structuredClone(values));
        for (const [key, value] of Object.entries(values)) {
          const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
          let target = this.data;
          for (let index = 0; index < segments.length - 1; index++) {
            const segment = segments[index];
            if (!target[segment] || typeof target[segment] !== 'object') {
              target[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
            }
            target = target[segment];
          }
          target[segments.at(-1)] = value;
        }
        if (callback) callback();
      }
    };
    page.onLoad({ teamId });
    if (initialTab) page.setData({ currentTab: initialTab });
    return page;
  }
  const page = createNextPage();
  return { page, calls, storage, manager, timers, createNextPage, setNow(value) { currentTime = value; } };
}
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
async function flushPromises() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('opening a team defaults to records and loads today practice after member profiles', async () => {
  const { page, calls, manager } = createPage();
  assert.equal(page.data.currentTab, 'records');
  await page.onShow();
  assert.equal(page.data.report.businessDate, report.businessDate);
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.teamMembers.length, 3);
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport']);
  assert.equal(calls.cloud[1].data.teamId, 'team-a');
  assert.equal(Object.hasOwn(calls.cloud[1].data, 'month'), false);
  assert.equal(page.data.currentTab, 'records');
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

test('opening member details and returning preserves the roster without a request or list reset', async () => {
  const boundTeam = structuredClone(team);
  boundTeam.members[1].bijingStudentNumber = 'BJ123456';
  const { page, calls } = createPage({ initialTab: 'members', cloud: type => {
    assert.equal(type, 'getTeamInfo');
    return success(boundTeam);
  } });
  await page.onShow();
  const members = page.data.teamMembers;
  page.openMemberRecords({ currentTarget: { dataset: { memberOpenid: 'member', view: 'month' } } });
  assert.equal(calls.navigation.length, 1);
  assert.match(calls.navigation[0].url, /memberOpenid=member/);
  page.onHide();
  const updateCount = page.dataUpdates.length;
  await page.onShow();
  assert.equal(page.data.teamMembers, members);
  assert.equal(page.data.teamMembers[1].bijingStudentNumber, 'BJ123456');
  assert.equal(page.dataUpdates.slice(updateCount).some(update => Object.hasOwn(update, 'teamMembers')), false);
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo']);
});

test('record tab and return navigation reuse the report while pull refresh invalidates it', async () => {
  const { page, calls } = createPage({ initialTab: 'members' });
  await page.onShow();
  await page.switchTab(event('tab', 'records'));
  const savedReport = page.data.report;
  await page.switchTab(event('tab', 'members'));
  await page.switchTab(event('tab', 'records'));
  page.onHide();
  await page.onShow();
  assert.equal(page.data.report, savedReport);
  assert.equal(calls.cloud.length, 2);
  await page.switchTab(event('tab', 'members'));
  await page.onPullDownRefresh();
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport', 'getTeamInfo']);
  assert.equal(page.data.report, null);
  assert.equal(calls.refreshStopped, 1);
  await page.switchTab(event('tab', 'records'));
  assert.equal(calls.cloud.filter(call => call.type === 'getTeamPracticeReport').length, 2);
});

test('member cards keep bound student numbers after a practice report replaces statistics', async () => {
  const boundTeam = structuredClone(team);
  boundTeam.members[1].bijingStudentNumber = 'BJ123456';
  const { page } = createPage({ initialTab: 'members',
    cloud: type => success(type === 'getTeamInfo' ? boundTeam : report) });
  await page.onShow();
  await page.switchTab(event('tab', 'records'));
  await page.switchTab(event('tab', 'members'));
  assert.equal(page.data.teamMembers.find(item => item.openid === 'member').bijingStudentNumber, 'BJ123456');
  assert.equal(page.data.teamMembers.find(item => item.openid === 'member').bijingStudentNumberLabel, 'BJ123456');
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  const roster = template.slice(template.indexOf('class="roster-card"'), template.indexOf('class="record-toolbar"'));
  assert.match(roster, /item.bijingStudentNumberLabel/);
  assert.doesNotMatch(roster, /totalPracticeCount|lastPracticeLabel/);
});

test('missing student numbers are unavailable until a roster refresh confirms binding state', async () => {
  let currentTeam = structuredClone(team);
  const { page } = createPage({ initialTab: 'members',
    cloud: type => success(type === 'getTeamInfo' ? currentTeam : report) });
  await page.onShow();
  assert.ok(page.data.teamMembers.every(item => item.bijingStudentNumberLabel === '学号暂未获取'));
  await page.switchTab(event('tab', 'records'));
  await page.switchTab(event('tab', 'members'));
  assert.ok(page.data.teamMembers.every(item => item.bijingStudentNumberLabel === '学号暂未获取'));

  currentTeam.members[0].bijingStudentNumber = ' BJ2407159 ';
  currentTeam.members[1].bijingStudentNumber = '';
  currentTeam.members[2].bijingStudentNumber = null;
  await page.onPullDownRefresh();
  const labels = Object.fromEntries(page.data.teamMembers.map(item => [item.openid, item.bijingStudentNumberLabel]));
  assert.deepEqual(labels, { owner: 'BJ2407159', member: '未绑定学号', third: '学号暂未获取' });
});

test('switching to records during roster loading fetches the report once after profiles are ready', async () => {
  let finishTeam;
  let finishReport;
  const { page, calls } = createPage({ initialTab: 'members', cloud: type => new Promise(resolve => {
    if (type === 'getTeamInfo') finishTeam = resolve;
    else finishReport = resolve;
  }) });
  const loading = page.onShow();
  await page.switchTab(event('tab', 'records'));
  finishTeam(success(team));
  await flushPromises();
  const duplicate = page.switchTab(event('tab', 'records'));
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport']);
  finishReport(success(report));
  await Promise.all([loading, duplicate]);
  assert.equal(page.data.report.businessDate, report.businessDate);
  assert.equal(page.data.isLoading, false);
});

test('returning to members after the practice day changes invalidates only statistics', async () => {
  const { page, calls, setNow } = createPage({ initialTab: 'members' });
  await page.onShow();
  await page.switchTab(event('tab', 'records'));
  await page.switchTab(event('tab', 'members'));
  page.onHide();
  setNow(nextResetAt + 1);
  await page.onShow();
  assert.equal(calls.cloud.length, 2);
  assert.equal(page.data.report, null);
  assert.equal(page.data.teamMembers.length, 3);
  assert.equal(page.data.isLoading, false);
});

test('saving settings from members refreshes profiles once and keeps statistics lazy', async () => {
  const currentTeam = structuredClone(team);
  const { page, calls } = createPage({ initialTab: 'members', cloud: (type, data) => {
    if (type === 'getTeamInfo') return success(currentTeam);
    assert.equal(type, 'updateTeam');
    Object.assign(currentTeam, data.teamData);
    return success({});
  } });
  await page.onShow();
  page.openSettings();
  page.changeTeamName({ detail: { value: '更新后的团队' } });
  await page.saveSettings();
  assert.equal(page.data.teamInfo.name, '更新后的团队');
  assert.equal(page.data.report, null);
  assert.equal(page.data.settingsOpen, false);
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'updateTeam', 'getTeamInfo']);
});

test('cached member profiles are cleared before showing another account', async () => {
  let currentTeam = team;
  const { page, calls, storage } = createPage({ initialTab: 'members', cloud: type => {
    assert.equal(type, 'getTeamInfo');
    return success(currentTeam);
  } });
  await page.onShow();
  page.onHide();
  storage.set('userOpenId', 'outsider');
  currentTeam = { ...team, isMember: false };
  await page.onShow();
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.teamMembers.length, 0);
  assert.equal(page.data.isMember, false);
  assert.equal(calls.cloud.length, 2);
  assert.match(calls.redirects[0].url, /joinTeam/);
});

test('a failed initial roster is retried on return instead of being treated as cached', async () => {
  let reads = 0;
  const { page, calls } = createPage({ initialTab: 'members', cloud: () => ++reads === 1
    ? { result: { success: false, error: '网络暂不可用' } } : success(team) });
  await page.onShow();
  assert.equal(page.data.teamInfo, null);
  page.onHide();
  await page.onShow();
  assert.equal(page.data.teamMembers.length, 3);
  assert.equal(page.data.loadError, '');
  assert.equal(calls.cloud.length, 2);
});

test('today filters use the same report and history defaults to descending qualification rate', async () => {
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
  assert.deepEqual(Array.from(page.data.historyMembers, item => [item.openid, item.historyRateLabel]),
    [['owner', '94.4%'], ['third', '72.2%'], ['member', '61.1%']]);
  assert.equal(page.data.practiceReports[0].historySortOrder, 'desc');
  assert.equal(page.data.historyMembers[0].unmetDays, 1);
  assert.equal(page.data.historyMembers[0].missedDays, 0);
  assert.equal(page.data.historyRangeLabel, '2026.09.01 — 2026.09.18');
  assert.equal(calls.cloud.length, 2);
});

test('history rate sorting switches directions locally without changing report totals or today filters', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  const originalReport = JSON.stringify(page.data.report);
  const summary = JSON.stringify(page.data.historySummary);
  const todayFilter = page.data.todayFilter;
  const requests = calls.cloud.length;
  const sort = order => page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order } } });
  sort('asc');
  assert.equal(page.data.practiceReports[0].historySortOrder, 'asc');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
  assert.deepEqual(Array.from(page.data.practiceReports[0].historyMembers, item => item.openid), ['member', 'third', 'owner']);
  sort('desc');
  assert.equal(page.data.practiceReports[0].historySortOrder, 'desc');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['owner', 'third', 'member']);
  sort('unknown');
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'unknown', order: 'asc' } } });
  assert.equal(page.data.practiceReports[0].historySortOrder, 'desc');
  assert.equal(JSON.stringify(page.data.report), originalReport);
  assert.equal(JSON.stringify(page.data.historySummary), summary);
  assert.equal(page.data.todayFilter, todayFilter);
  assert.equal(calls.cloud.length, requests);
});

test('optional history ranks by participation and supports ascending participation rates', async () => {
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : optionalReport) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  assert.deepEqual(Array.from(page.data.historyMembers, item => [item.openid, item.historyRateLabel]),
    [['owner', '100%'], ['third', '88.9%'], ['member', '72.2%']]);
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order: 'asc' } } });
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
  assert.equal(page.data.practiceReports[0].hasGoal, false);
});

test('history rates use exact days to order equal rounded percentages and cap incomplete rates', async () => {
  const longHistory = structuredClone(report);
  longHistory.settings.practiceStartDate = '1999-05-04';
  longHistory.history = { startDate: '1999-05-04', endDate: '2026-09-18', totalDays: 10000 };
  longHistory.members = [
    { ...member('member', 'qualified', 20, 9998, 2, 0), nickname: 'A' },
    { ...member('third', 'qualified', 20, 9999, 1, 0), nickname: 'Z' },
    { ...member('owner', 'qualified', 20, 10000, 0, 0), nickname: 'Owner' }
  ];
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : longHistory) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  assert.deepEqual(Array.from(page.data.historyMembers, item => [item.openid, item.historyRateLabel]),
    [['owner', '100%'], ['third', '99.9%'], ['member', '99.9%']]);
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order: 'asc' } } });
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
});

test('equal history rates keep nickname and member identifier tie breakers in either direction', async () => {
  const tied = structuredClone(report);
  tied.members = [
    { ...member('third', 'qualified', 20, 10, 8, 0), nickname: 'B' },
    { ...member('owner', 'qualified', 20, 11, 7, 1), nickname: 'A' },
    { ...member('member', 'qualified', 20, 12, 6, 2), nickname: 'A' }
  ];
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : tied) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'owner', 'third']);
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order: 'asc' } } });
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'owner', 'third']);
});

test('first-day history has no percentage instead of invalid rates or a ranking scroll', async () => {
  const firstDay = structuredClone(report);
  firstDay.settings.practiceStartDate = '2026-09-19';
  firstDay.history = { startDate: '2026-09-19', endDate: '2026-09-18', totalDays: 0 };
  firstDay.members = firstDay.members.map(item => ({ ...item, practiceDays: 0, qualifiedDays: 0,
    belowGoalDays: 0, missedDays: 0, unmetDays: 0, totalMinutes: 0 }));
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : firstDay) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  assert.equal(page.data.historySummary, null);
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.historyRateLabel), ['—', '—', '—']);
  page.showHistoryRanking(event('practiceType', 'sitting'));
  assert.equal(calls.scrolls.length, 0);
});

test('overall history rate scrolls to the member ranking and preserves its selected order', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order: 'asc' } } });
  const requests = calls.cloud.length;
  page.showHistoryRanking(event('practiceType', 'sitting'));
  assert.deepEqual(calls.scrolls.map(options => ({ ...options })), [{ selector: '#history-members-sitting', duration: 300 }]);
  assert.equal(page.data.practiceReports[0].historySortOrder, 'asc');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
  assert.equal(calls.navigation.length, 0);
  assert.equal(calls.cloud.length, requests);
  page.openHistoryDetails(event('filter', 'all'));
  assert.equal(new URL(calls.navigation[0].url, 'https://local').searchParams.get('filter'), 'all');
});

test('historical summary counts distinct affected members and each member-day once', async () => {
  const { page } = createPage();
  await page.onShow();
  assert.deepEqual({ ...page.data.historySummary }, {
    memberCount: 3,
    unmetMemberCount: 3, unmetCount: 13,
    missedMemberCount: 2, missedCount: 7,
    belowGoalMemberCount: 3, belowGoalCount: 6,
    fullAttendanceCount: 0, rateLabel: '75.9%'
  });
  assert.equal(page.data.historySummary.unmetCount,
    page.data.historySummary.missedCount + page.data.historySummary.belowGoalCount);
});

test('historical summary ignores today status, today sessions, and cumulative totals', async () => {
  const { page } = createPage();
  await page.onShow();
  const originalSummary = { ...page.data.historySummary };
  const changedToday = structuredClone(report);
  changedToday.summary = { memberCount: 3, notPracticedCount: 0, belowGoalCount: 0, qualifiedCount: 3, practicedCount: 3 };
  changedToday.overview = { memberCount: 3, totalPracticeCount: 3000, activeMemberCount: 3, activityRate: 100 };
  changedToday.members = changedToday.members.map(item => ({
    ...item, todayStatus: 'qualified', todayMinutes: 500,
    todayPracticeCount: 100, totalPracticeCount: 1000, cumulativeMinutes: 10000
  }));
  page.applyReport(changedToday);
  assert.deepEqual({ ...page.data.historySummary }, originalSummary);
});

test('historical summary without a goal uses missed and practiced days while cloud unmet days stay zero', async () => {
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo'
    ? { ...team, dailyGoalMinutes: null, practiceStartDate: null } : optionalReport) });
  await page.onShow();
  assert.equal(page.data.hasGoal, false);
  assert.ok(page.data.report.members.every(item => item.unmetDays === 0));
  assert.deepEqual({ ...page.data.historySummary }, {
    memberCount: 3,
    unmetMemberCount: 0, unmetCount: 0,
    missedMemberCount: 2, missedCount: 7,
    belowGoalMemberCount: 0, belowGoalCount: 0,
    fullAttendanceCount: 1, rateLabel: '87%'
  });
});

test('historical summary distinguishes all days qualified from no historical practice', async () => {
  const { page } = createPage();
  await page.onShow();
  const allQualified = structuredClone(report);
  allQualified.members = allQualified.members.map(item => ({ ...item,
    practiceDays: 18, qualifiedDays: 18, belowGoalDays: 0, missedDays: 0, unmetDays: 0, totalMinutes: 360
  }));
  page.applyReport(allQualified);
  assert.deepEqual({ ...page.data.historySummary }, {
    memberCount: 3,
    unmetMemberCount: 0, unmetCount: 0,
    missedMemberCount: 0, missedCount: 0,
    belowGoalMemberCount: 0, belowGoalCount: 0,
    fullAttendanceCount: 3, rateLabel: '100%'
  });

  const noPractice = structuredClone(report);
  noPractice.members = noPractice.members.map(item => ({ ...item,
    practiceDays: 0, qualifiedDays: 0, belowGoalDays: 0, missedDays: 18, unmetDays: 18, totalMinutes: 0
  }));
  page.applyReport(noPractice);
  assert.deepEqual({ ...page.data.historySummary }, {
    memberCount: 3,
    unmetMemberCount: 3, unmetCount: 54,
    missedMemberCount: 3, missedCount: 54,
    belowGoalMemberCount: 0, belowGoalCount: 0,
    fullAttendanceCount: 0, rateLabel: '0%'
  });
});

test('historical summary recomputes after refreshed records or goal changes', async () => {
  let currentReport = structuredClone(report);
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : currentReport) });
  await page.onShow();
  assert.equal(page.data.historySummary.unmetCount, 13);
  currentReport.members[1] = {
    ...currentReport.members[1], practiceDays: 18, qualifiedDays: 18,
    missedDays: 0, belowGoalDays: 0, unmetDays: 0, totalMinutes: 360
  };
  await page.onPullDownRefresh();
  assert.equal(page.data.historySummary.unmetMemberCount, 2);
  assert.equal(page.data.historySummary.unmetCount, 6);
  assert.equal(page.data.historySummary.missedCount, 2);
  assert.equal(page.data.historySummary.fullAttendanceCount, 1);
  assert.equal(page.data.historySummary.rateLabel, '88.9%');

  currentReport = structuredClone(optionalReport);
  await page.onPullDownRefresh();
  assert.equal(page.data.hasGoal, false);
  assert.equal(page.data.historySummary.unmetCount, 0);
  assert.equal(page.data.historySummary.missedCount, 7);
  assert.equal(page.data.historySummary.rateLabel, '87%');
});

test('historical rates keep a real shortfall below 100 percent after display rounding', async () => {
  const almostComplete = structuredClone(report);
  almostComplete.summary = { memberCount: 1000, notPracticedCount: 0, belowGoalCount: 0, qualifiedCount: 1000 };
  almostComplete.members = Array.from({ length: 1000 }, (_, index) => member(index ? `member-${index}` : 'owner', 'qualified', 20, index ? 18 : 17, index ? 0 : 1, 0));
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : almostComplete) });
  await page.onShow();
  assert.equal(page.data.historySummary.rateLabel, '99.9%');
  assert.equal(page.data.historySummary.unmetMemberCount, 1);
  assert.equal(page.data.historySummary.unmetCount, 1);
  assert.equal(page.data.historySummary.fullAttendanceCount, 999);

  almostComplete.settings.dailyGoalMinutes = null;
  almostComplete.members = almostComplete.members.map(item => ({ ...item, todayStatus: 'practiced', qualifiedDays: 0, unmetDays: 0 }));
  page.applyReport(almostComplete);
  assert.equal(page.data.historySummary.rateLabel, '99.9%');
  assert.equal(page.data.historySummary.missedCount, 1);
});

test('history overview requests and summarizes the complete period across months', async () => {
  const fullHistory = structuredClone(report);
  fullHistory.settings.practiceStartDate = '2026-08-01';
  fullHistory.history = { startDate: '2026-08-01', endDate: '2026-09-18', totalDays: 49 };
  fullHistory.members = [member('owner', 'qualified', 25, 49, 0, 1),
    member('member', 'below_goal', 12, 40, 9, 2), member('third', 'not_practiced', 0, 0, 49, 0)];
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : fullHistory) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.historyRangeLabel, '2026.08.01 — 2026.09.18');
  assert.equal(page.data.report.history.totalDays, 49);
  assert.deepEqual(Array.from(page.data.historyMembers, item => [item.openid, item.practiceDays, item.unmetDays]),
    [['owner', 49, 1], ['member', 40, 11], ['third', 0, 49]]);
  assert.equal(page.data.historySummary.unmetMemberCount, 3);
  assert.equal(page.data.historySummary.unmetCount, 61);
  assert.equal(page.data.historySummary.missedCount, 58);
  assert.equal(page.data.historySummary.belowGoalCount, 3);
  assert.equal(page.data.historySummary.rateLabel, '58.5%');
  await page.onPullDownRefresh();
  for (const request of calls.cloud.filter(call => call.type === 'getTeamPracticeReport')) {
    assert.deepEqual({ ...request.data }, { teamId: 'team-a' });
  }
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  assert.doesNotMatch(template, /fields=["']month["']|history-month-toolbar|本月未达标|本月未练习|本月全勤|本月统计|本月暂无/);
});

test('historical details default to the current practice month while preserving filters and member scope', async () => {
  for (const [businessDate, endDate, totalDays, time] of [
    ['2026-09-01', '2026-08-31', 62, '2026-09-01T02:00:00+08:00'],
    ['2026-08-31', '2026-08-30', 61, '2026-09-01T01:59:59+08:00']
  ]) {
    const boundary = structuredClone(report);
    boundary.businessDate = businessDate;
    boundary.nextResetAt = Date.parse(`${businessDate}T02:00:00+08:00`) + 86400000;
    boundary.settings.practiceStartDate = '2026-07-01';
    boundary.history = { startDate: '2026-07-01', endDate, totalDays };
    boundary.members = boundary.members.map(item => ({ ...item,
      practiceDays: totalDays - 2, qualifiedDays: totalDays - 3,
      belowGoalDays: 1, missedDays: 2, unmetDays: 3, totalMinutes: (totalDays - 2) * 20
    }));
    const { page, calls } = createPage({ clockNow: Date.parse(time),
      cloud: type => success(type === 'getTeamInfo' ? team : boundary) });
    await page.onShow();
    for (const filter of ['unmet', 'not_practiced', 'below_goal', 'all']) page.openHistoryDetails(event('filter', filter));
    page.openHistoryDetails({ currentTarget: { dataset: { filter: 'below_goal', memberOpenid: 'member' } } });
    const urls = calls.navigation.map(item => new URL(item.url, 'https://miniprogram.local'));
    assert.equal(urls.length, 5);
    assert.ok(urls.every(url => url.searchParams.get('month') === businessDate.slice(0, 7)));
    assert.deepEqual(urls.map(url => url.searchParams.get('filter')), ['unmet', 'not_practiced', 'below_goal', 'all', 'below_goal']);
    assert.equal(urls[4].searchParams.get('memberOpenid'), 'member');
    assert.equal(urls[4].searchParams.get('memberName'), 'member');
  }
});

test('history summary and breakdown cards open their matching daily detail filters', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  for (const filter of ['unmet', 'not_practiced', 'below_goal', 'all']) {
    page.openHistoryDetails(event('filter', filter));
  }
  const urls = calls.navigation.map(item => new URL(item.url, 'https://miniprogram.local'));
  assert.deepEqual(urls.map(url => url.searchParams.get('filter')), ['unmet', 'not_practiced', 'below_goal', 'all']);
  for (const url of urls) {
    assert.equal(url.pathname, '/subpackages/team/pages/historyDetails/historyDetails');
    assert.equal(url.searchParams.get('teamId'), 'team-a');
    assert.equal(url.searchParams.get('month'), '2026-09');
    assert.equal(url.searchParams.has('memberOpenid'), false);
  }
});

test('member historical shortfall entries preserve the selected member and escaped display name', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  page.data.teamMembers.find(item => item.openid === 'member').nickname = '伙伴 & 小明 / A';
  page.openHistoryDetails({ currentTarget: { dataset: { filter: 'unmet', memberOpenid: 'member' } } });
  const url = new URL(calls.navigation[0].url, 'https://miniprogram.local');
  assert.equal(url.searchParams.get('memberOpenid'), 'member');
  assert.equal(url.searchParams.get('memberName'), '伙伴 & 小明 / A');
  assert.equal(url.searchParams.get('filter'), 'unmet');
});

test('history entries without a goal open missed-practice dates instead of suggesting unmet goals', async () => {
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : optionalReport) });
  await page.onShow();
  for (const filter of ['unmet', 'below_goal', 'not_practiced', 'all']) page.openHistoryDetails(event('filter', filter));
  assert.deepEqual(calls.navigation.map(item => new URL(item.url, 'https://miniprogram.local').searchParams.get('filter')),
    ['not_practiced', 'not_practiced', 'not_practiced', 'all']);
});

test('historical detail entry rejects missing reports, first-day statistics and stale or invalid access', async () => {
  const { page, calls, storage } = createPage();
  page.openHistoryDetails(event('filter', 'unmet'));
  await page.onShow();
  page.openHistoryDetails();
  page.openHistoryDetails({});
  page.openHistoryDetails(event('filter', 'unknown'));
  page.openHistoryDetails({ currentTarget: { dataset: { filter: 'unmet', memberOpenid: 'outsider' } } });
  page.openHistoryDetails({ currentTarget: { dataset: { filter: 'unmet', memberOpenid: { openid: 'member' } } } });
  for (const key of ['isLoading', 'isSaving', 'isDeleting']) {
    page.data[key] = true;
    page.openHistoryDetails(event('filter', 'unmet'));
    page.data[key] = false;
  }
  page.data.isMember = false;
  page.openHistoryDetails(event('filter', 'unmet'));
  page.data.isMember = true;
  storage.set('userOpenId', 'third');
  page.openHistoryDetails(event('filter', 'unmet'));
  storage.set('userOpenId', 'owner');
  page.data.teamId = 'another-team';
  page.openHistoryDetails(event('filter', 'unmet'));
  page.data.teamId = 'team-a';
  page.data.report.history.totalDays = 0;
  page.openHistoryDetails(event('filter', 'unmet'));
  page.data.report.history.totalDays = 18;
  page.onUnload();
  page.openHistoryDetails(event('filter', 'unmet'));
  assert.equal(calls.navigation.length, 0);
});

test('member cards open the selected member with the correct monthly or daily date context', async () => {
  const boundaryReport = structuredClone(report);
  boundaryReport.businessDate = '2026-09-01';
  boundaryReport.settings.practiceStartDate = '2026-08-01';
  boundaryReport.history = { startDate: '2026-08-01', endDate: '2026-08-31', totalDays: 31 };
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
    clockNow: Date.parse('2026-09-19T01:30:00+08:00'),
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
  assert.equal(page.data.historySummary, null);
  assert.equal(page.data.reportError, '网络不可用');
  assert.equal(page.data.isLoading, false);
  result = success({ ...report, members: [{ openid: 'member', todayStatus: 'not_practiced' }] });
  await page.loadTeamData();
  assert.equal(page.data.report, null);
  assert.equal(page.data.historySummary, null);
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
  assert.equal(page.data.historySummary, null);
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

test('hiding invalidates pending reports and returning retries only statistics while preserving the editable draft', async () => {
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
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport', 'getTeamPracticeReport']);
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
  const firstDay = { ...report, settings: { ...report.settings, practiceStartDate: '2026-09-19' },
    history: { startDate: '2026-09-19', endDate: '2026-09-18', totalDays: 0 },
    members: report.members.map(item => ({ ...item, practiceDays: 0, qualifiedDays: 0,
      belowGoalDays: 0, missedDays: 0, unmetDays: 0, totalMinutes: 0 })) };
  const { page } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : firstDay) });
  await page.onShow();
  assert.equal(page.data.report.history.totalDays, 0);
  assert.equal(page.data.historySummary, null);
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
  await flushPromises();
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
  await flushPromises();
  assert.equal(page.data.inviteReady, false);
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  await page.prepareInvite();
  const shared = page.onShareAppMessage();
  assert.equal(shared.title, '邀请您加入新的团队名称团队');
  const params = new URLSearchParams(shared.path.split('?')[1]);
  assert.equal(params.get('teamName'), saved.name);
  assert.equal(params.get('inviteId'), 'invite_saved');
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
  assert.equal(calls.uploads.length, 0);
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

test('02:00 rollover invalidates the report and fetches the next practice day, while hide/unload clear timers', async () => {
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
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport', 'getTeamPracticeReport']);
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

test('opening, refreshing, returning and reopening details never request invitations automatically', async () => {
  const { page, calls, createNextPage } = createPage();
  await page.onShow();
  await page.onPullDownRefresh();
  page.onHide();
  await page.onShow();
  page.onUnload();
  const reopened = createNextPage();
  await reopened.onShow();
  await flushPromises();
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  assert.equal(reopened.data.inviteDialogOpen, false);
  assert.equal(reopened.data.inviteReady, false);
  assert.equal(reopened.data.isPreparingInvite, false);
  assert.equal(reopened.dataUpdates.some(update => update.isPreparingInvite === true), false);
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  assert.equal(reopened.onShareAppMessage().path, '/pages/team/team');
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
});

test('the creator explicitly prepares an invitation and shares it from the resulting dialog', async () => {
  const { page, calls, storage } = createPage();
  storage.set('userNickname', '名字 & 百分比%');
  await page.onShow();
  assert.equal(page.data.inviteDialogOpen, false);
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.isPreparingInvite, false);
  assert.ok(page.data.inviteExpiresLabel);
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
  await page.prepareInvite();
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  assert.equal(calls.toasts.length, 0);
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  const ownerActions = template.match(/<view wx:if="\{\{isCreator \|\| isDeputy\}\}" class="hero-actions">([\s\S]*?)<\/view>/);
  assert.ok(ownerActions);
  assert.match(ownerActions[1], /class="invite-button"[^>]*bindtap="prepareInvite"/);
  assert.doesNotMatch(ownerActions[1], /open-type="share"/);
  assert.match(template, /wx:if="\{\{inviteDialogOpen\}\}"/);
  assert.match(template, /bindtap="closeInviteDialog"|catchtap="closeInviteDialog"/);
  assert.match(template, /open-type="share"/);
});

test('members cannot prepare invitation dialogs or share through the top-right menu', async () => {
  const { page, calls } = createPage({ openid: 'member' });
  await page.onShow();
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(calls.shareMenus.every(call => call.action === 'hide'), true);
  assert.deepEqual(Array.from(calls.shareMenus.at(-1).menus), ['shareAppMessage', 'shareTimeline']);
});

test('slow invitation requests are single-flight and failures wait for an explicit retry', async () => {
  let finishInvite;
  const { page, calls } = createPage({ generateInvite: () => new Promise(resolve => { finishInvite = resolve; }) });
  await page.onShow();
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.report.members[0].todayMinutes, 25);
  const preparing = page.prepareInvite();
  await page.prepareInvite();
  assert.equal(page.data.isPreparingInvite, true);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  finishInvite({ result: { success: false, error: '邀请生成失败，请重试' } });
  await preparing;
  assert.equal(page.data.isPreparingInvite, false);
  assert.match(page.data.inviteError, /生成失败/);
  await flushPromises();
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  const retry = page.prepareInvite();
  await page.prepareInvite();
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 2);
  finishInvite(success(invitation()));
  await retry;
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.inviteError, '');
});

test('slow statistics do not block an explicit invitation request after membership is verified', async () => {
  let finishReport;
  const { page, calls } = createPage({ cloud: type => type === 'getTeamInfo'
    ? success(team) : new Promise(resolve => { finishReport = resolve; }) });
  const loading = page.onShow();
  await flushPromises();
  assert.equal(page.data.isLoading, true);
  assert.equal(page.data.report, null);
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.onShareAppMessage().path, invitation().sharePath);
  finishReport(success(report));
  await loading;
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  const button = template.match(/<button[^>]*class="invite-button"[^>]*>/);
  assert.ok(button);
  assert.doesNotMatch(button[0], /isLoading/);
});

test('a slow permission check prevents explicit preparation and sharing', async () => {
  let finishTeam;
  const { page, calls } = createPage({ cloud: type => type === 'getTeamInfo'
    ? new Promise(resolve => { finishTeam = resolve; }) : success(report) });
  const loading = page.onShow();
  await flushPromises();
  await page.prepareInvite();
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo']);
  finishTeam(success(team));
  await loading;
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  await page.prepareInvite();
  assert.equal(page.data.inviteDialogOpen, true);
});

test('finishing slow statistics does not retry an invitation failure', async () => {
  let finishReport;
  const { page, calls } = createPage({
    generateInvite: () => ({ result: { success: false, error: '邀请生成失败' } }),
    cloud: type => type === 'getTeamInfo' ? success(team) : new Promise(resolve => { finishReport = resolve; })
  });
  const loading = page.onShow();
  await flushPromises();
  await page.prepareInvite();
  assert.equal(page.data.isLoading, true);
  assert.match(page.data.inviteError, /生成失败/);
  finishReport(success(report));
  await loading;
  await flushPromises();
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  assert.match(page.data.inviteError, /生成失败/);
  assert.equal(page.data.inviteDialogOpen, false);
});

test('expired or mismatched invitation responses never enable sharing or open the dialog', async () => {
  for (const invalid of [
    { ...invitation(), expireTime: now },
    { ...invitation(), expireTime: undefined },
    { ...invitation(), inviteId: '' },
    { ...invitation(), sharePath: '/pages/team/team' },
    invitation('other-team'),
    invitation('team-a', 'member'),
    { ...invitation(), sharePath: invitation().sharePath.replace('invite_saved', 'other-token') }
  ]) {
    const { page, calls } = createPage({ generateInvite: () => success(invalid) });
    await page.onShow();
    await page.prepareInvite();
    assert.equal(page.data.inviteReady, false);
    assert.equal(page.data.inviteDialogOpen, false);
    assert.equal(page.data.isPreparingInvite, false);
    assert.match(page.data.inviteError, /邀请信息无效/);
    assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
    assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  }
});

test('closing the dialog clears visible sharing state and a later click reuses the valid invitation', async () => {
  const { page, calls, timers, setNow } = createPage();
  await page.onShow();
  await page.prepareInvite();
  const oldTimer = timers.get(page._inviteExpiryTimer);
  page.closeInviteDialog();
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.isPreparingInvite, false);
  assert.equal(page.data.inviteError, '');
  assert.equal(page.data.inviteExpiresLabel, '');
  assert.equal(calls.shareMenus.at(-1).action, 'hide');
  assert.equal(page._inviteExpiryTimer, null);
  setNow(now + 60000);
  const updateCount = page.dataUpdates.length;
  await page.prepareInvite();
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.dataUpdates.slice(updateCount).some(update => update.isPreparingInvite === true), true);
  assert.equal(calls.cloud.filter(call => call.type === 'getTeamInfo').length, 2);
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  assert.equal(timers.get(page._inviteExpiryTimer).delay, invitation().expireTime - now - 60000);
  oldTimer.fn();
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.onShareAppMessage().path, invitation().sharePath);
});

test('visible invitation expiry keeps the dialog open and waits for an explicit renewal', async () => {
  let generations = 0;
  const renewed = { ...invitation('team-a', 'owner', 'invite_renewed'), expireTime: invitation().expireTime + 10000 };
  const { page, timers, setNow } = createPage({ generateInvite: () => success(++generations === 1 ? invitation() : renewed) });
  await page.onShow();
  await page.prepareInvite();
  const expiryTimer = timers.get(page._inviteExpiryTimer);
  assert.equal(expiryTimer.delay, invitation().expireTime - now);
  setNow(invitation().expireTime);
  expiryTimer.fn();
  await flushPromises();
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.isPreparingInvite, false);
  assert.match(page.data.inviteError, /过期/);
  assert.equal(generations, 1);
  await page.prepareInvite();
  assert.equal(generations, 2);
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.inviteError, '');
  assert.equal(page.onShareAppMessage().path, renewed.sharePath);
});

test('share-time expiry rejects stale links without issuing a new request', async () => {
  const { page, setNow, calls } = createPage();
  await page.onShow();
  await page.prepareInvite();
  setNow(invitation().expireTime);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.isPreparingInvite, false);
  assert.match(page.data.inviteError, /失效|过期/);
  await flushPromises();
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
});

test('late invitations cannot reopen a closed, hidden or unloaded dialog', async () => {
  for (const lifecycle of ['closeInviteDialog', 'onHide', 'onUnload']) {
    let finishInvite;
    const { page, calls } = createPage({ generateInvite: () => new Promise(resolve => { finishInvite = resolve; }) });
    await page.onShow();
    const preparing = page.prepareInvite();
    assert.equal(page.data.isPreparingInvite, true);
    page[lifecycle]();
    finishInvite(success(invitation()));
    await preparing;
    assert.equal(page.data.inviteDialogOpen, false, lifecycle);
    assert.equal(page.data.inviteReady, false, lifecycle);
    assert.equal(page.data.isPreparingInvite, false, lifecycle);
    assert.equal(calls.shareMenus.some(call => call.action === 'show'), false, lifecycle);
    assert.equal(page.onShareAppMessage().path, '/pages/team/team');
    assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  }
});

test('hiding and refreshing close prepared dialogs and require a new click before reusing the invitation', async () => {
  const { page, calls, setNow } = createPage();
  await page.onShow();
  await page.prepareInvite();
  page.onHide();
  assert.equal(page.data.inviteDialogOpen, false);
  setNow(now + 60000);
  await page.onShow();
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(page.data.inviteReady, false);
  await page.prepareInvite();
  assert.equal(page.onShareAppMessage().path, invitation().sharePath);
  await page.onPullDownRefresh();
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(page.data.inviteReady, false);
  await page.prepareInvite();
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
});

test('reusing a data invitation verifies current permissions once and disables sharing until confirmation', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', source: 'bijing', deputyLeaders: ['member'] };
  let finishCheck;
  let reads = 0;
  const { calls, createNextPage } = createPage({ initialTab: 'members', openid: 'member',
    cloud: () => ++reads === 1 ? success(current) : new Promise(resolve => { finishCheck = resolve; }),
    generateInvite: () => success(invitation(current._id, 'member')) });
  const page = createNextPage({ teamId: current._id });
  await page.onShow();
  await page.prepareInvite();
  page.onHide();
  await page.onShow();
  const checking = page.prepareInvite();
  await page.prepareInvite();
  assert.equal(reads, 2);
  assert.equal(page.data.isPreparingInvite, true);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.shareMenus.at(-1).action, 'hide');
  finishCheck(success({ ...current, name: '新的团队名称' }));
  await checking;
  assert.equal(page.data.isPreparingInvite, false);
  assert.equal(page.data.inviteReady, true);
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.data.teamInfo.name, '新的团队名称');
  assert.equal(new URLSearchParams(page.onShareAppMessage().path.split('?')[1]).get('teamName'), '新的团队名称');
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
});

test('cached data invitations cannot survive revoked deputy membership or a dissolved team on return', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', source: 'bijing', deputyLeaders: ['member'] };
  for (const state of ['revoked', 'removed', 'deleted', 'network-error']) {
    let reads = 0;
    const { calls, createNextPage } = createPage({ initialTab: 'members', openid: 'member',
      cloud: () => {
        if (++reads === 1) return success(current);
        if (state === 'deleted' || state === 'network-error') return { result: { success: false,
          error: state === 'deleted' ? '团队不存在或已解散' : '网络暂时无法连接' } };
        return success({ ...current, deputyLeaders: [], ...(state === 'removed' ? { isMember: false, members: [] } : {}) });
      }, generateInvite: () => success(invitation(current._id, 'member')) });
    const page = createNextPage({ teamId: current._id });
    await page.onShow();
    await page.prepareInvite();
    page.onHide();
    await page.onShow();
    assert.equal(reads, 1, state);
    await page.prepareInvite();
    assert.equal(reads, 2, state);
    assert.equal(page._preparedInvite, null, state);
    assert.equal(page.data.inviteReady, false, state);
    assert.equal(page.data.inviteDialogOpen, false, state);
    assert.equal(page.data.isPreparingInvite, false, state);
    assert.equal(page.canInviteTeam(), false, state);
    assert.match(page.data.inviteError, /刷新团队/, state);
    assert.equal(calls.shareMenus.filter(call => call.action === 'show').length, 1, state);
    assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1, state);
    if (state === 'revoked' || state === 'removed') {
      assert.equal(page.data.isDeputy, false, state);
      assert.match(calls.toasts.at(-1).title, /刷新团队/, state);
    }
  }
});

test('late cached invitation permission checks cannot restore sharing after identity or visibility changes', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', source: 'bijing' };
  for (const change of ['account', 'binding', 'hidden', 'closed', 'unloaded', 'share']) {
    let finishCheck;
    let reads = 0;
    const { storage, calls, createNextPage } = createPage({ initialTab: 'members',
      cloud: () => ++reads === 1 ? success(current) : new Promise(resolve => { finishCheck = resolve; }),
      generateInvite: () => success(invitation(current._id)) });
    const page = createNextPage({ teamId: current._id });
    await page.onShow();
    await page.prepareInvite();
    page.closeInviteDialog();
    const checking = page.prepareInvite();
    assert.equal(page.data.isPreparingInvite, true, change);
    if (change === 'account') storage.set('userOpenId', 'other');
    else if (change === 'binding') storage.set('bijingBindingVersion', 'v2');
    else if (change === 'hidden') page.onHide();
    else if (change === 'closed') page.closeInviteDialog();
    else if (change === 'unloaded') page.onUnload();
    else assert.equal(page.onShareAppMessage().path, '/pages/team/team');
    finishCheck(success(current));
    await checking;
    assert.equal(page.data.inviteReady, false, change);
    assert.equal(page.data.inviteDialogOpen, false, change);
    assert.equal(page.data.isPreparingInvite, false, change);
    assert.equal(calls.shareMenus.filter(call => call.action === 'show').length, 1, change);
  }
});

test('manual refresh disables cached invitations until creator permissions are confirmed and the owner clicks again', async () => {
  for (const permission of ['owner', 'member', 'outsider', 'deleted']) {
    let finishTeam;
    let teamReads = 0;
    const { page, calls } = createPage({ cloud: type => {
      if (type === 'getTeamInfo' && ++teamReads === 2) return new Promise(resolve => { finishTeam = resolve; });
      return success(type === 'getTeamInfo' ? team : report);
    } });
    await page.onShow();
    await page.prepareInvite();
    page.onHide();
    await page.onShow();
    const returning = page.onPullDownRefresh();
    await page.prepareInvite();
    assert.equal(page.data.inviteReady, false);
    assert.equal(page.data.inviteDialogOpen, false);
    finishTeam(permission === 'deleted' ? { result: { success: false, error: '团队已删除' } } : success({
      ...team, creator: permission === 'owner' ? 'owner' : 'another-owner', isMember: permission !== 'outsider'
    }));
    await returning;
    assert.equal(page.data.inviteDialogOpen, false);
    await page.prepareInvite();
    assert.equal(page.data.inviteReady, permission === 'owner', permission);
    assert.equal(page.data.inviteDialogOpen, permission === 'owner', permission);
    assert.equal(page.onShareAppMessage().path, permission === 'owner' ? invitation().sharePath : '/pages/team/team');
    assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  }
});

test('account changes close prepared dialogs and discard pending owner invitations', async () => {
  let finishInvite;
  const { page, calls, storage } = createPage({ generateInvite: () => new Promise(resolve => { finishInvite = resolve; }) });
  await page.onShow();
  const preparing = page.prepareInvite();
  storage.set('userOpenId', 'member');
  await page.onShow();
  finishInvite(success(invitation()));
  await preparing;
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.shareMenus.some(call => call.action === 'show'), false);
  assert.equal(page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  const ready = createPage();
  await ready.page.onShow();
  await ready.page.prepareInvite();
  ready.storage.set('userOpenId', 'member');
  assert.equal(ready.page.onShareAppMessage().path, '/pages/team/team');
  assert.equal(ready.page.data.inviteReady, false);
  assert.equal(ready.page.data.inviteDialogOpen, false);
});

test('changing teams closes the dialog and a late old invitation cannot replace the explicitly requested current invitation', async () => {
  let finishOld;
  const { page, calls } = createPage({
    generateInvite: data => data.teamId === 'team-a'
      ? new Promise(resolve => { finishOld = resolve; }) : success(invitation(data.teamId)),
    cloud: (type, data) => success(type === 'getTeamInfo' ? { ...team, _id: data.teamId } : { ...report, teamId: data.teamId })
  });
  await page.onShow();
  const old = page.prepareInvite();
  page.setData({ teamId: 'team-b' });
  await page.loadTeamData();
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.cloud.filter(call => call.type === 'generateInvite').length, 1);
  await page.prepareInvite();
  const currentPath = invitation('team-b').sharePath;
  assert.equal(page.onShareAppMessage().path, currentPath);
  finishOld(success(invitation()));
  await old;
  assert.equal(page.onShareAppMessage().path, currentPath);
});

test('saving cancels pending invitations and a failed save does not prepare another invitation automatically', async () => {
  const finishInvites = [];
  let finishSave;
  const { page } = createPage({
    generateInvite: () => new Promise(resolve => { finishInvites.push(resolve); }),
    cloud: type => type === 'updateTeam' ? new Promise(resolve => { finishSave = resolve; }) : success(type === 'getTeamInfo' ? team : report)
  });
  await page.onShow();
  const preparing = page.prepareInvite();
  page.openSettings();
  const saving = page.saveSettings();
  await flushPromises();
  finishInvites[0](success(invitation()));
  await preparing;
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  finishSave({ result: { success: false, error: '保存失败' } });
  await saving;
  assert.equal(page.data.isPreparingInvite, false);
  assert.equal(finishInvites.length, 1);
  const retry = page.prepareInvite();
  assert.equal(finishInvites.length, 2);
  const recovered = invitation('team-a', 'owner', 'invite_after_save');
  finishInvites[1](success(recovered));
  await retry;
  assert.equal(page.data.inviteDialogOpen, true);
  assert.equal(page.onShareAppMessage().path, recovered.sharePath);
});

test('settings moderation, save outcomes and deletion outcomes never prepare invitations automatically', async () => {
  for (const action of ['moderation', 'save-failure', 'save-success', 'delete-failure', 'delete-success']) {
    const { page, calls } = createPage({
      checkText: () => action !== 'moderation',
      deleteTeam: () => ({ success: action === 'delete-success', error: '解散失败' }),
      cloud: type => type === 'updateTeam' ? { result: { success: action === 'save-success', error: '保存失败' } }
        : success(type === 'getTeamInfo' ? team : report)
    });
    await page.onShow();
    if (action.startsWith('delete')) await page.deleteTeam();
    else {
      page.openSettings();
      await page.saveSettings();
    }
    await flushPromises();
    assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false, action);
    assert.equal(page.data.inviteDialogOpen, false, action);
    assert.equal(page.data.isPreparingInvite, false, action);
    if (action === 'delete-success') assert.equal(page.data.teamInfo, null);
  }
});

test('settings date maximum follows the 02:00 practice-day boundary rather than natural midnight', () => {
  const beforeReset = createPage({ clockNow: Date.parse('2026-09-19T01:59:59+08:00') });
  const afterReset = createPage({ clockNow: Date.parse('2026-09-19T02:00:00+08:00') });
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
  const scrollStart = template.indexOf('<scroll-view class="settings-scroll"');
  const scrollArea = template.slice(scrollStart, template.indexOf('</scroll-view>', scrollStart));
  assert.match(scrollArea, /bindtap="saveSettings"/);
  assert.match(scrollArea, /bindtap="confirmDeleteTeam"/);
});

test('practice rule switch reflects persisted settings, including teams with just one optional rule', async () => {
  for (const [startDate, goalMinutes, enabled] of [
    [null, null, false], ['2026-09-01', null, true], [null, 45, true], ['2026-09-01', 20, true]
  ]) {
    const savedTeam = { ...team, practiceStartDate: startDate, dailyGoalMinutes: goalMinutes };
    const { page } = createPage({ cloud: type => type === 'getTeamInfo' ? success(savedTeam)
      : { result: { success: false, error: '统计暂不可用' } } });
    await page.onShow();
    page.openSettings();
    assert.equal(page.data.draftPracticeRulesEnabled, enabled);
    page.closeSettings();
    page.openSettings();
    assert.equal(page.data.draftPracticeRulesEnabled, enabled);
  }
});

test('disabling practice rules collapses the keyboard and preserves drafts until a null-rule save', async () => {
  let saved;
  const { page, calls } = createPage({ cloud: (type, data) => {
    if (type === 'updateTeam') { saved = data.teamData; return success({}); }
    if (type === 'getTeamInfo') return success({ ...team, ...saved });
    return success(saved ? optionalReport : report);
  } });
  await page.onShow();
  page.openSettings();
  page.changeStartDate({ detail: { value: '2026-08-20' } });
  page.changeGoalMinutes({ detail: { value: '45' } });
  page.onGoalKeyboardHeightChange({ detail: { height: 280 } });
  page.changePracticeRulesEnabled({ detail: { value: false } });
  assert.equal(page.data.draftPracticeRulesEnabled, false);
  assert.equal(page.data.keyboardHeight, 0);
  assert.equal(page.data.settingsScrollTarget, '');
  assert.equal(calls.keyboardHidden, 1);
  page.onGoalKeyboardHeightChange({ detail: { height: 280 } });
  page.changeStartDate({ detail: { value: '2026-09-02' } });
  page.clearStartDate();
  page.changeGoalMinutes({ detail: { value: '90' } });
  page.chooseGoalMinutes(event('minutes', 60));
  assert.equal(page.data.keyboardHeight, 0);
  assert.equal(page.data.draftStartDate, '2026-08-20');
  assert.equal(page.data.draftGoalMinutes, '45');
  page.changePracticeRulesEnabled({ detail: { value: true } });
  assert.equal(page.data.draftStartDate, '2026-08-20');
  assert.equal(page.data.draftGoalMinutes, '45');
  page.changePracticeRulesEnabled({ detail: { value: false } });
  await page.saveSettings();
  assert.equal(saved.practiceStartDate, null);
  assert.equal(saved.dailyGoalMinutes, null);
  assert.equal(saved.name, team.name);
  page.openSettings();
  assert.equal(page.data.draftPracticeRulesEnabled, false);
  assert.equal(page.data.draftStartDate, '');
  assert.equal(page.data.draftGoalMinutes, '');
});

test('disabled invalid rules do not block saving and a failed save keeps the disabled draft', async () => {
  const { page, calls } = createPage({ cloud: type => type === 'updateTeam'
    ? { result: { success: false, error: '保存失败' } } : success(type === 'getTeamInfo' ? team : report) });
  await page.onShow();
  page.openSettings();
  page.changeStartDate({ detail: { value: 'invalid-date' } });
  page.changeGoalMinutes({ detail: { value: '1441' } });
  page.changePracticeRulesEnabled({ detail: { value: false } });
  await page.saveSettings();
  const update = calls.cloud.find(call => call.type === 'updateTeam');
  assert.equal(update.data.teamData.practiceStartDate, null);
  assert.equal(update.data.teamData.dailyGoalMinutes, null);
  assert.equal(page.data.settingsOpen, true);
  assert.equal(page.data.draftPracticeRulesEnabled, false);
  assert.equal(page.data.draftStartDate, 'invalid-date');
  assert.equal(page.data.draftGoalMinutes, '1441');
  page.changePracticeRulesEnabled({ detail: { value: true } });
  await page.saveSettings();
  assert.match(page.data.settingsError, /日期/);
  assert.equal(calls.cloud.filter(call => call.type === 'updateTeam').length, 1);
});

test('practice rule switch cannot change member views, locked saves, or closed settings', async () => {
  for (const reason of ['member', 'saving', 'deleting', 'closed']) {
    const { page } = createPage({ openid: reason === 'member' ? 'member' : 'owner' });
    await page.onShow();
    page.openSettings();
    if (reason === 'saving') page.setData({ isSaving: true });
    if (reason === 'deleting') page.setData({ isDeleting: true });
    if (reason === 'closed') page.closeSettings();
    page.changePracticeRulesEnabled({ detail: { value: false } });
    assert.equal(page.data.draftPracticeRulesEnabled, true, reason);
  }
});

test('creator reminder refreshes the full report and renders all unqualified member cards regardless of filter', async () => {
  let reports = 0;
  const latest = structuredClone(report);
  latest.members[1].todayMinutes = 18;
  latest.members[1].nickname = '长名字 冥想伙伴 👩🏽‍💻';
  const canvasNode = { id: 'reminder-canvas-node' };
  const { page, calls } = createPage({ canvasNode, cloud: type => {
    if (type === 'getTeamInfo') return success(team);
    return success(++reports === 1 ? report : latest);
  } });
  await page.onShow();
  page.changeTodayFilter(event('filter', 'qualified'));
  await page.showReminderList();
  assert.equal(reports, 2);
  assert.equal(page.data.report.members[1].todayMinutes, 18);
  assert.equal(page.data.todayFilter, 'qualified');
  assert.equal(page.data.reminderDialogOpen, true);
  assert.equal(page.data.reminderImagePath, '/tmp/reminder.png');
  assert.equal(page.data.reminderCount, 2);
  assert.equal(page.data.reminderDate, report.businessDate);
  assert.equal(page.data.isPreparingReminder, false);
  assert.equal(calls.canvasQueries.length, 1);
  assert.equal(calls.canvasQueries[0].page, page);
  assert.equal(calls.canvasQueries[0].selector, '#reminderCanvas');
  assert.equal(calls.canvasQueries[0].fields.node, true);
  assert.equal(calls.reminderImages.length, 1);
  const image = calls.reminderImages[0];
  assert.equal(image.canvas, canvasNode);
  assert.equal(image.teamName, team.name);
  assert.deepEqual(Array.from(image.members, item => item.openid), ['third', 'member']);
  assert.equal(image.members[1].nickname, latest.members[1].nickname);
  assert.equal(image.members[1].todayMinutes, 18);
  assert.equal(image.report.businessDate, latest.businessDate);
  assert.equal(image.isCurrent(), true);
  assert.equal(calls.clipboard.length, 0);
  assert.equal(calls.albums.length, 0);
  assert.equal(calls.toasts.length, 0);
});

test('ordinary members and a forged creator flag cannot request reminder images', async () => {
  for (const forgedFlag of [false, true]) {
    const { page, calls } = createPage({ openid: 'member' });
    await page.onShow();
    page.setData({ isCreator: forgedFlag });
    await page.showReminderList();
    assert.equal(calls.cloud.length, 2);
    assert.equal(calls.canvasQueries.length, 0);
    assert.equal(calls.reminderImages.length, 0);
    assert.equal(page.data.reminderDialogOpen, false);
    assert.equal(page.data.reminderImagePath, '');
  }
});

test('reminder image without a daily goal contains only unpracticed members', async () => {
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : optionalReport) });
  await page.onShow();
  await page.showReminderList();
  assert.equal(page.data.reminderDialogOpen, true);
  assert.equal(page.data.reminderCount, 1);
  assert.equal(calls.reminderImages.length, 1);
  assert.deepEqual(Array.from(calls.reminderImages[0].members, item => item.openid), ['third']);
  assert.equal(calls.clipboard.length, 0);
  assert.equal(calls.albums.length, 0);
});

test('fresh reports with no reminder members show a message instead of generating an empty image', async () => {
  for (const hasGoal of [true, false]) {
    let reports = 0;
    const latest = structuredClone(hasGoal ? report : optionalReport);
    latest.members.forEach(item => { item.todayStatus = hasGoal ? 'qualified' : 'practiced'; item.todayMinutes = 25; });
    latest.summary = { memberCount: 3, notPracticedCount: 0, belowGoalCount: 0, qualifiedCount: hasGoal ? 3 : 0, practicedCount: 3 };
    const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : ++reports === 1 ? report : latest) });
    await page.onShow();
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, false);
    assert.equal(page.data.reminderImagePath, '');
    assert.equal(page.data.reminderCount, 0);
    assert.equal(page.data.attentionCount, 0);
    assert.equal(calls.reminderImages.length, 0);
    assert.equal(calls.toasts.at(-1).title, hasGoal ? '今天大家都已达标' : '今天大家都已练习');
    assert.equal(page.data.isPreparingReminder, false);
  }
});

test('duplicate reminder taps request only one report and render only one image', async () => {
  let finishReport;
  let finishImage;
  let reports = 0;
  const { page, calls } = createPage({ cloud: type => {
    if (type === 'getTeamInfo') return success(team);
    return ++reports === 1 ? success(report) : new Promise(resolve => { finishReport = resolve; });
  }, reminderImage: () => new Promise(resolve => { finishImage = resolve; }) });
  await page.onShow();
  const first = page.showReminderList();
  await page.showReminderList();
  assert.equal(reports, 2);
  assert.equal(page.data.isPreparingReminder, true);
  assert.equal(page.data.reminderDialogOpen, false);
  finishReport(success(report));
  await flushPromises();
  assert.equal(calls.reminderImages.length, 1);
  await page.showReminderList();
  assert.equal(reports, 2);
  assert.equal(calls.reminderImages.length, 1);
  assert.equal(page.data.isPreparingReminder, true);
  finishImage({ tempFilePath: '/tmp/current.png', width: 750, height: 500 });
  await first;
  assert.equal(page.data.reminderDialogOpen, true);
  assert.equal(page.data.reminderImagePath, '/tmp/current.png');
  assert.equal(page.data.isPreparingReminder, false);
});

test('late reminder reports cannot reopen a closed, hidden, replaced or refreshed dialog', async () => {
  for (const change of ['closeReminderDialog', 'onHide', 'onUnload', 'account', 'team', 'creator', 'refresh']) {
    let finish;
    let reports = 0;
    const { page, calls, storage } = createPage({ cloud: type => {
      if (type === 'getTeamInfo') return success(team);
      if (++reports === 2) return new Promise(resolve => { finish = resolve; });
      return success(report);
    } });
    await page.onShow();
    const request = page.showReminderList();
    if (change === 'account') storage.set('userOpenId', 'other');
    else if (change === 'team') page.setData({ teamId: 'other-team' });
    else if (change === 'creator') page.setData({ teamInfo: { ...page.data.teamInfo, creator: 'other' } });
    else if (change === 'refresh') await page.loadTeamData();
    else page[change]();
    finish(success(report));
    await request;
    assert.equal(page.data.reminderDialogOpen, false, change);
    assert.equal(page.data.reminderImagePath, '', change);
    assert.equal(page.data.isPreparingReminder, false, change);
    assert.equal(calls.reminderImages.length, 0, change);
    assert.equal(calls.modals.length, 0, change);
  }
});

test('late generated reminder images cannot survive cancellation, account changes or permission loss', async () => {
  for (const change of ['closeReminderDialog', 'onHide', 'onUnload', 'account', 'team', 'creator', 'refresh']) {
    let finishImage;
    const { page, calls, storage } = createPage({ reminderImage: () => new Promise(resolve => { finishImage = resolve; }) });
    await page.onShow();
    const request = page.showReminderList();
    await flushPromises();
    assert.equal(calls.reminderImages.length, 1, change);
    const image = calls.reminderImages[0];
    assert.equal(image.isCurrent(), true, change);
    if (change === 'account') storage.set('userOpenId', 'other');
    else if (change === 'team') page.setData({ teamId: 'other-team' });
    else if (change === 'creator') page.setData({ teamInfo: { ...page.data.teamInfo, creator: 'other' } });
    else if (change === 'refresh') await page.loadTeamData();
    else page[change]();
    assert.equal(image.isCurrent(), false, change);
    finishImage({ tempFilePath: '/tmp/stale.png', width: 750, height: 500 });
    await request;
    assert.equal(page.data.reminderDialogOpen, false, change);
    assert.equal(page.data.reminderImagePath, '', change);
    assert.equal(page.data.isPreparingReminder, false, change);
    assert.equal(calls.modals.length, 0, change);
  }
});

test('a reminder report arriving after its practice day ends cannot generate yesterday cards', async () => {
  let finish;
  let reports = 0;
  const { page, calls, setNow } = createPage({ cloud: type => {
    if (type === 'getTeamInfo') return success(team);
    return ++reports === 1 ? success(report) : new Promise(resolve => { finish = resolve; });
  } });
  await page.onShow();
  const request = page.showReminderList();
  setNow(nextResetAt);
  finish(success(report));
  await request;
  assert.equal(page.data.reminderDialogOpen, false);
  assert.equal(page.data.reminderImagePath, '');
  assert.equal(page.data.isPreparingReminder, false);
  assert.equal(calls.reminderImages.length, 0);
  assert.match(calls.modals.at(-1).content, /练习日已更新/);
});

test('a reminder image completing across the practice-day boundary never displays stale cards', async () => {
  let finishImage;
  const { page, calls, setNow } = createPage({ reminderImage: () => new Promise(resolve => { finishImage = resolve; }) });
  await page.onShow();
  const request = page.showReminderList();
  await flushPromises();
  assert.equal(calls.reminderImages.length, 1);
  setNow(nextResetAt);
  finishImage({ tempFilePath: '/tmp/yesterday.png', width: 750, height: 500 });
  await request;
  assert.equal(page.data.reminderDialogOpen, false);
  assert.equal(page.data.reminderImagePath, '');
  assert.equal(page.data.reminderCount, 0);
  assert.equal(page.data.isPreparingReminder, false);
});

test('failed or malformed reminder refresh clears the prior image and permits retry', async () => {
  for (const failure of ['network', 'malformed']) {
    let failed = false;
    const { page, calls } = createPage({ cloud: type => {
      if (type === 'getTeamInfo') return success(team);
      if (failed && failure === 'network') throw new Error('同步失败');
      return success(failed ? { ...report, members: null } : report);
    } });
    await page.onShow();
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true);
    failed = true;
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, false, failure);
    assert.equal(page.data.reminderImagePath, '', failure);
    assert.equal(page.data.isPreparingReminder, false, failure);
    assert.match(calls.modals.at(-1).title, /失败/, failure);
    assert.equal(calls.reminderImages.length, 1, failure);
    failed = false;
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true, failure);
    assert.equal(page.data.reminderImagePath, '/tmp/reminder.png', failure);
    assert.equal(calls.reminderImages.length, 2, failure);
  }
});

test('failed canvas lookup or image export leaves no stale image and allows a fresh retry', async () => {
  for (const failure of ['canvas', 'export']) {
    let failed = false;
    const { page, calls } = createPage({
      canvasQuery: callback => callback(failed && failure === 'canvas' ? [] : [{ node: {} }]),
      reminderImage: async () => {
        if (failed && failure === 'export') throw new Error('长图生成失败');
        return { tempFilePath: '/tmp/retry.png', width: 750, height: 500 };
      }
    });
    await page.onShow();
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true, failure);
    failed = true;
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, false, failure);
    assert.equal(page.data.reminderImagePath, '', failure);
    assert.equal(page.data.isPreparingReminder, false, failure);
    assert.match(calls.modals.at(-1).title, /失败/, failure);
    failed = false;
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true, failure);
    assert.equal(page.data.reminderImagePath, '/tmp/retry.png', failure);
  }
});

test('reminders require current creator membership and are blocked during team mutations', async () => {
  for (const flag of ['isLoading', 'isSaving', 'isDeleting', 'removingMemberId', 'isMember', 'isCreator', 'account', 'team', 'hidden', 'report']) {
    const { page, calls, storage } = createPage();
    await page.onShow();
    if (flag === 'account') storage.set('userOpenId', 'other');
    else if (flag === 'team') page.setData({ teamId: 'other-team' });
    else if (flag === 'hidden') page.onHide();
    else if (flag === 'report') page.setData({ report: null });
    else page.setData({ [flag]: ['isMember', 'isCreator'].includes(flag) ? false : flag === 'removingMemberId' ? 'member' : true });
    await page.showReminderList();
    assert.equal(calls.cloud.length, 2, flag);
    assert.equal(page.data.reminderDialogOpen, false, flag);
    assert.equal(calls.reminderImages.length, 0, flag);
  }
});

test('closing, hiding, unloading or refreshing clears the displayed reminder image', async () => {
  for (const action of ['cancelReminder', 'closeReminderDialog', 'onHide', 'onUnload', 'loadTeamData']) {
    const { page, calls } = createPage();
    await page.onShow();
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true, action);
    await page[action]();
    assert.equal(page.data.reminderDialogOpen, false, action);
    assert.equal(page.data.reminderImagePath, '', action);
    assert.equal(page.data.reminderCount, 0, action);
    assert.equal(page.data.reminderDate, '', action);
    assert.equal(page.data.isPreparingReminder, false, action);
    assert.equal(calls.reminderImages[0].isCurrent(), false, action);
    assert.equal(calls.clipboard.length, 0, action);
    assert.equal(calls.albums.length, 0, action);
  }
});

test('late image failure cannot revive a closed reminder or affect a newly generated image', async () => {
  for (const action of ['closeReminderDialog', 'onHide', 'onUnload', 'loadTeamData', 'reopen']) {
    let failImage;
    let renders = 0;
    const { page, calls } = createPage({ reminderImage: () => ++renders === 1
      ? new Promise((resolve, reject) => { failImage = reject; })
      : { tempFilePath: '/tmp/new.png', width: 750, height: 500 }
    });
    await page.onShow();
    const oldImage = page.showReminderList();
    await flushPromises();
    assert.equal(calls.reminderImages.length, 1, action);
    if (action === 'reopen') {
      page.closeReminderDialog();
      await page.showReminderList();
    } else await page[action]();
    failImage(new Error('过期任务生成失败'));
    await oldImage;
    assert.equal(calls.modals.length, 0, action);
    assert.equal(page.data.reminderDialogOpen, action === 'reopen', action);
    assert.equal(page.data.reminderImagePath, action === 'reopen' ? '/tmp/new.png' : '', action);
    assert.equal(page.data.isPreparingReminder, false, action);
  }
});

test('reminder controls support creators and deputies and offer direct saving while retaining image preview', () => {
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  const reminderButton = template.match(/<button[^>]*bindtap="showReminderList"[^>]*>/)[0];
  assert.match(reminderButton, /wx:if="{{isCreator \|\| isDeputy}}"/);
  const reminderImage = template.match(/<image[^>]*src="{{reminderImagePath}}"[^>]*>/)[0];
  assert.match(reminderImage, /show-menu-by-longpress="{{true}}"/);
  assert.match(reminderImage, /bindtap="previewReminderImage"/);
  const saveButton = template.match(/<button[^>]*bindtap="saveReminderImage"[^>]*>保存图片<\/button>/)[0];
  assert.match(saveButton, /loading="{{isSavingReminder}}"/);
  assert.match(saveButton, /disabled="{{isSavingReminder}}"/);
  assert.doesNotMatch(template, /<button[^>]*>查看大图<\/button>/);
  assert.doesNotMatch(template, /copyReminderList|reminderText/);
});

test('explicit preview opens exactly the generated reminder image without clipboard or album writes', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  await page.showReminderList();
  assert.equal(calls.previews.length, 0);
  await page.previewReminderImage();
  assert.equal(calls.previews.length, 1);
  assert.equal(calls.previews[0].current, '/tmp/reminder.png');
  assert.deepEqual(Array.from(calls.previews[0].urls), ['/tmp/reminder.png']);
  assert.equal(calls.clipboard.length, 0);
  assert.equal(calls.albums.length, 0);
});

test('reminder preview and saving require the same creator and an open current image outside team mutations', async () => {
  for (const flag of ['isLoading', 'isSaving', 'isDeleting', 'removingMemberId', 'isMember', 'isCreator', 'account', 'team', 'creator', 'viewer', 'hidden', 'closed', 'empty']) {
    const { page, calls, storage } = createPage();
    await page.onShow();
    await page.showReminderList();
    if (flag === 'account') storage.set('userOpenId', 'other');
    else if (flag === 'team') page.setData({ teamId: 'other-team' });
    else if (flag === 'creator') page.setData({ teamInfo: { ...page.data.teamInfo, creator: 'other' } });
    else if (flag === 'viewer') page._viewerOpenid = 'other';
    else if (flag === 'hidden') page.onHide();
    else if (flag === 'closed') page.closeReminderDialog();
    else if (flag === 'empty') page.setData({ reminderImagePath: '' });
    else page.setData({ [flag]: ['isMember', 'isCreator'].includes(flag) ? false : flag === 'removingMemberId' ? 'member' : true });
    await page.previewReminderImage();
    await page.saveReminderImage();
    assert.equal(calls.previews.length, 0, flag);
    assert.equal(calls.albums.length, 0, flag);
  }
});

test('saving writes the generated reminder image once and allows another save after completion', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  await page.showReminderList();
  assert.equal(calls.albums.length, 0);
  await Promise.all([page.saveReminderImage(), page.saveReminderImage()]);
  assert.equal(calls.albums.length, 1);
  assert.equal(calls.albums[0].filePath, '/tmp/reminder.png');
  assert.equal(page.data.isSavingReminder, true);
  calls.albums[0].success();
  assert.equal(page.data.isSavingReminder, false);
  assert.equal(calls.toasts.at(-1).title, '图片已保存到相册');
  assert.equal(calls.previews.length, 0);
  assert.equal(calls.clipboard.length, 0);
  await page.saveReminderImage();
  assert.equal(calls.albums.length, 2);
});

test('failed reminder saving permits retry and permission denial offers settings only after confirmation', async () => {
  for (const confirm of [true, false]) {
    const { page, calls } = createPage({ confirm });
    await page.onShow();
    await page.showReminderList();
    await page.saveReminderImage();
    calls.albums[0].fail({ errMsg: 'saveImageToPhotosAlbum:fail file not found' });
    assert.equal(page.data.isSavingReminder, false);
    assert.equal(calls.toasts.at(-1).title, '图片保存失败，请重试');
    assert.equal(calls.modals.length, 0);
    await page.saveReminderImage();
    calls.albums[1].fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
    assert.equal(page.data.isSavingReminder, false);
    assert.equal(calls.modals.at(-1).title, '保存图片需要授权');
    assert.equal(calls.settings.length, confirm ? 1 : 0);
    if (confirm) {
      calls.settings[0].fail();
      assert.equal(calls.toasts.at(-1).title, '无法打开设置，请重试');
    }
  }
});

test('callbacks from a previous reminder save cannot change a newly opened reminder', async () => {
  for (const outcome of ['success', 'fail']) {
    const { page, calls } = createPage();
    await page.onShow();
    await page.showReminderList();
    await page.saveReminderImage();
    page.closeReminderDialog();
    assert.equal(page.data.isSavingReminder, false);
    await page.showReminderList();
    await page.saveReminderImage();
    const toastCount = calls.toasts.length;
    calls.albums[0][outcome]({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
    assert.equal(page.data.isSavingReminder, true);
    assert.equal(calls.toasts.length, toastCount);
    assert.equal(calls.modals.length, 0);
  }
});

test('saving after the practice day ends rejects the stale image and refreshes statistics', async () => {
  const tomorrow = { ...structuredClone(report), businessDate: '2026-09-20', nextResetAt: nextResetAt + 24 * 60 * 60 * 1000 };
  let currentReport = report;
  const { page, calls, setNow } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : currentReport) });
  await page.onShow();
  await page.showReminderList();
  currentReport = tomorrow;
  setNow(nextResetAt);
  await page.saveReminderImage();
  assert.equal(calls.albums.length, 0);
  assert.equal(page.data.reminderDialogOpen, false);
  assert.equal(page.data.isSavingReminder, false);
  assert.equal(calls.toasts.at(-1).title, '练习日已更新，请重新查看');
  assert.equal(page.data.report.businessDate, '2026-09-20');
});

test('preview after the practice day ends closes the stale image and refreshes current statistics', async () => {
  const tomorrow = { ...structuredClone(report), businessDate: '2026-09-20', nextResetAt: nextResetAt + 24 * 60 * 60 * 1000 };
  let currentReport = report;
  const { page, calls, setNow } = createPage({ cloud: type => success(type === 'getTeamInfo' ? team : currentReport) });
  await page.onShow();
  await page.showReminderList();
  currentReport = tomorrow;
  setNow(nextResetAt);
  await page.previewReminderImage();
  assert.equal(calls.previews.length, 0);
  assert.equal(calls.toasts.at(-1).title, '练习日已更新，请重新查看');
  assert.equal(page.data.reminderDialogOpen, false);
  assert.equal(page.data.reminderImagePath, '');
  assert.equal(page.data.report.businessDate, '2026-09-20');
  assert.equal(calls.cloud.length, 5);
  await page.showReminderList();
  assert.equal(page.data.reminderDate, '2026-09-20');
  await page.previewReminderImage();
  assert.equal(calls.previews.length, 1);
});

test('member removal requires a creator, current non-self member and confirmation', async () => {
  for (const [openid, target, confirm] of [['member', 'third', true], ['owner', 'owner', true], ['owner', 'missing', true], ['owner', 'member', false]]) {
    const { page, calls } = createPage({ openid, confirm });
    await page.onShow();
    await page.confirmRemoveMember(event('memberOpenid', target));
    assert.equal(calls.removals.length, 0);
  }
});

test('member removal blocks duplicate taps and refreshes roster and statistics after success', async () => {
  let complete;
  let removed = false;
  const nextTeam = structuredClone(team);
  nextTeam.members = nextTeam.members.filter(member => member.openid !== 'member');
  const nextReport = structuredClone(report);
  nextReport.members = nextReport.members.filter(member => member.openid !== 'member');
  nextReport.summary = { memberCount: 2, notPracticedCount: 1, belowGoalCount: 0, qualifiedCount: 1 };
  const { page, calls } = createPage({
    removeTeamMember: () => new Promise(resolve => { complete = () => { removed = true; resolve({ success: true }); }; }),
    cloud: type => success(type === 'getTeamInfo' ? (removed ? nextTeam : team) : (removed ? nextReport : report))
  });
  await page.onShow();
  const first = page.confirmRemoveMember(event('memberOpenid', 'member'));
  await flushPromises();
  assert.equal(page.data.removingMemberId, 'member');
  await page.confirmRemoveMember(event('memberOpenid', 'member'));
  assert.equal(calls.removals.length, 1);
  complete();
  await first;
  assert.deepEqual(Array.from(page.data.teamMembers, member => member.openid).sort(), ['owner', 'third']);
  assert.equal(page.data.report.summary.memberCount, 2);
  assert.equal(page.data.removingMemberId, '');
});

test('failed removal retains members and reports the server error', async () => {
  const { page, calls } = createPage({ removeTeamMember: async () => ({ success: false, error: '暂时无法移除' }) });
  await page.onShow();
  await page.confirmRemoveMember(event('memberOpenid', 'member'));
  assert.equal(page.data.teamMembers.length, 3);
  assert.equal(page.data.removingMemberId, '');
  assert.equal(calls.modals.at(-1).title, '移除失败');
});

test('failed removal resumes a report requested while removal was pending', async () => {
  for (const failure of ['response', 'network']) {
    let finishRemoval;
    const { page, calls } = createPage({ initialTab: 'members',
      removeTeamMember: () => new Promise((resolve, reject) => {
        finishRemoval = () => failure === 'network' ? reject(new Error('网络暂不可用'))
          : resolve({ success: false, error: '暂时无法移除' });
      })
    });
    await page.onShow();
    const removing = page.confirmRemoveMember(event('memberOpenid', 'member'));
    await flushPromises();
    assert.equal(page.data.removingMemberId, 'member');
    await page.switchTab(event('tab', 'records'));
    assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo']);
    finishRemoval();
    await removing;
    assert.equal(page.data.currentTab, 'records');
    assert.equal(page.data.report.businessDate, report.businessDate);
    assert.equal(page.data.teamMembers.length, 3);
    assert.equal(page.data.isLoading, false);
    assert.equal(page.data.removingMemberId, '');
    assert.equal(page.data.reportError, '');
    assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo', 'getTeamPracticeReport']);
  }
});

test('a report resumed after failed removal exposes fetch errors and permits retry', async () => {
  let finishRemoval;
  let failReport = true;
  const { page, calls } = createPage({ initialTab: 'members',
    removeTeamMember: () => new Promise(resolve => {
      finishRemoval = () => resolve({ success: false, error: '暂时无法移除' });
    }),
    cloud: type => type === 'getTeamPracticeReport' && failReport
      ? { result: { success: false, error: '统计暂不可用' } } : success(type === 'getTeamInfo' ? team : report)
  });
  await page.onShow();
  const removing = page.confirmRemoveMember(event('memberOpenid', 'member'));
  await flushPromises();
  await page.switchTab(event('tab', 'records'));
  finishRemoval();
  await removing;
  assert.equal(page.data.report, null);
  assert.equal(page.data.reportError, '统计暂不可用');
  assert.equal(page.data.isLoading, false);
  failReport = false;
  await page.switchTab(event('tab', 'records'));
  assert.equal(page.data.report.businessDate, report.businessDate);
  assert.equal(page.data.reportError, '');
  assert.equal(calls.cloud.filter(call => call.type === 'getTeamPracticeReport').length, 2);
});

test('failed removal keeps reports lazy when the user leaves the records view', async () => {
  for (const leave of ['members', 'onHide', 'onUnload']) {
    let finishRemoval;
    const { page, calls } = createPage({ initialTab: 'members',
      removeTeamMember: () => new Promise(resolve => {
        finishRemoval = () => resolve({ success: false, error: '暂时无法移除' });
      })
    });
    await page.onShow();
    const removing = page.confirmRemoveMember(event('memberOpenid', 'member'));
    await flushPromises();
    await page.switchTab(event('tab', 'records'));
    if (leave === 'members') await page.switchTab(event('tab', 'members'));
    else page[leave]();
    finishRemoval();
    await removing;
    assert.equal(page.data.report, null);
    assert.deepEqual(calls.cloud.map(call => call.type), ['getTeamInfo']);
  }
});

test('confirmation opened for one account cannot remove a member after identity or visibility changes', async () => {
  for (const hide of [true, false]) {
    const { page, calls, storage } = createPage({ confirm: null });
    await page.onShow();
    const request = page.confirmRemoveMember(event('memberOpenid', 'member'));
    if (hide) page.onHide(); else storage.set('userOpenId', 'other');
    calls.modals.at(-1).success({ confirm: true });
    await request;
    assert.equal(calls.removals.length, 0);
  }
});

const deputyTeam = { ...structuredClone(team), deputyLeaders: ['member'] };
const roleReport = value => ({ ...structuredClone(report), creator: value.creator,
  deputyLeaders: value.deputyLeaders || [],
  members: value.members.map((item, index) => ({ ...member(item.openid || item, index ? 'below_goal' : 'qualified', 10, 10, 8, 0),
    nickname: item.nickname || item.openid || item }))
});
const roleResult = value => ({ success: true, data: { teamId: value._id, creator: value.creator,
  creatorName: value.creator, members: value.members.map(item => item.openid || item),
  memberCount: value.members.length, deputyLeaders: value.deputyLeaders || [] } });

test('deputies have badges and can invite and remind but cannot edit, remove, appoint or dissolve', async () => {
  const { page, calls } = createPage({ openid: 'member',
    cloud: type => success(type === 'getTeamInfo' ? deputyTeam : roleReport(deputyTeam)),
    generateInvite: () => success(invitation('team-a', 'member'))
  });
  await page.onShow();
  assert.equal(page.data.isDeputy, true);
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.deputyCount, 1);
  assert.equal(page.data.teamMembers.find(item => item.openid === 'member').isDeputy, true);
  await page.prepareInvite();
  assert.equal(new URLSearchParams(page.onShareAppMessage().path.split('?')[1]).get('inviterId'), 'member');
  await page.showReminderList();
  assert.equal(page.data.reminderDialogOpen, true);
  await page.previewReminderImage();
  await page.saveReminderImage();
  assert.equal(calls.previews.length, 1);
  assert.equal(calls.albums.length, 1);
  page.openSettings();
  const originalName = page.data.draftName;
  page.changeTeamName({ detail: { value: '不允许编辑' } });
  assert.equal(page.data.draftName, originalName);
  await page.saveSettings();
  await page.confirmDeleteTeam();
  await page.confirmRemoveMember(event('memberOpenid', 'third'));
  await page.openMemberActions(event('memberOpenid', 'third'));
  await page.confirmMemberRoleChange(event('memberOpenid', 'third'), 'deputy');
  await page.confirmMemberRoleChange(event('memberOpenid', 'third'), 'leader');
  assert.equal(calls.modals.length, 0);
  assert.equal(calls.actionSheets.length, 0);
  assert.equal(calls.deletes.length + calls.removals.length + calls.deputyChanges.length + calls.transfers.length, 0);
  assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
});

test('old teams have zero deputies and forged deputy flags cannot grant assistant permissions', async () => {
  const { page, calls } = createPage({ openid: 'member' });
  await page.onShow();
  assert.equal(page.data.isDeputy, false);
  assert.equal(page.data.deputyCount, 0);
  page.setData({ isDeputy: true });
  await page.prepareInvite();
  await page.showReminderList();
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  assert.equal(calls.reminderImages.length, 0);
});

test('member management sheet exposes deputy appointment, leader transfer and existing removal', async () => {
  for (const [tapIndex, expected] of [[0, '设为副团长'], [1, '交接团长'], [2, '移除成员']]) {
    const { page, calls } = createPage({ confirm: false });
    await page.onShow();
    const request = page.openMemberActions(event('memberOpenid', 'member'));
    assert.deepEqual(Array.from(calls.actionSheets[0].itemList), ['设为副团长', '交接团长', '移除成员']);
    calls.actionSheets[0].success({ tapIndex });
    await request;
    assert.equal(calls.modals[0].title, expected);
  }
  const { page, calls } = createPage({ cloud: type => success(type === 'getTeamInfo' ? deputyTeam : roleReport(deputyTeam)) });
  await page.onShow();
  const request = page.openMemberActions(event('memberOpenid', 'member'));
  assert.equal(calls.actionSheets[0].itemList[0], '取消副团长');
  calls.actionSheets[0].fail({ errMsg: 'cancel' });
  await request;
  const template = fs.readFileSync(pagePath.replace('.js', '.wxml'), 'utf8');
  assert.match(template, /catchlongpress="openMemberActions"/);
  assert.match(template, /副团长 {{deputyCount}} \/ 7 位/);
  assert.match(template, /wx:elif="{{item.isDeputy}}"/);
  assert.match(template, /<button wx:if="{{isCreator}}" class="hero-dissolve"/);
});

test('a leader can appoint and dismiss deputies and role badges update from canonical results', async () => {
  for (const appoint of [true, false]) {
    let current = structuredClone(appoint ? team : deputyTeam);
    const { page, calls, manager } = createPage({
      cloud: type => success(type === 'getTeamInfo' ? current : roleReport(current)),
      setTeamDeputy: async (teamId, memberOpenid, isDeputy) => {
        current = { ...current, deputyLeaders: isDeputy ? [memberOpenid] : [] };
        return roleResult(current);
      }
    });
    await page.onShow();
    await page.confirmMemberRoleChange(event('memberOpenid', 'member'), 'deputy');
    assert.deepEqual(calls.deputyChanges, [{ teamId: 'team-a', memberOpenid: 'member', isDeputy: appoint }]);
    assert.equal(page.data.deputyCount, appoint ? 1 : 0);
    assert.equal(page.data.teamMembers.find(item => item.openid === 'member').isDeputy, appoint);
    assert.equal(page.data.roleChangingMemberId, '');
    assert.deepEqual(Array.from(manager.teams[0].deputyLeaders), appoint ? ['member'] : []);
  }
});

test('seven deputies block another appointment but permit dismissal', async () => {
  const ids = ['owner', 'member', 'third', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  let current = { ...structuredClone(team), members: ids.map(openid => ({ openid, nickname: openid })),
    deputyLeaders: ['member', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'] };
  const { page, calls } = createPage({
    cloud: type => success(type === 'getTeamInfo' ? current : roleReport(current)),
    setTeamDeputy: async (teamId, memberOpenid) => {
      current = { ...current, deputyLeaders: current.deputyLeaders.filter(id => id !== memberOpenid) };
      return roleResult(current);
    }
  });
  await page.onShow();
  await page.confirmMemberRoleChange(event('memberOpenid', 'third'), 'deputy');
  assert.equal(calls.deputyChanges.length, 0);
  assert.equal(calls.modals.length, 0);
  assert.match(calls.toasts.at(-1).title, /最多 7 位/);
  await page.confirmMemberRoleChange(event('memberOpenid', 'member'), 'deputy');
  assert.equal(calls.deputyChanges.length, 1);
  assert.equal(calls.deputyChanges[0].isDeputy, false);
  assert.equal(page.data.deputyCount, 6);
});

test('leadership can transfer to a member or deputy and immediately revokes all old leader controls', async () => {
  for (const recipient of ['third', 'member']) {
    let current = structuredClone(deputyTeam);
    let finishReport;
    let transferred = false;
    const { page, calls, manager } = createPage({
      cloud: type => {
        if (transferred) return new Promise(resolve => { finishReport = resolve; });
        return success(type === 'getTeamInfo' ? current : roleReport(current));
      },
      transferTeamLeader: async (teamId, memberOpenid) => {
        transferred = true;
        current = { ...current, creator: memberOpenid, deputyLeaders: current.deputyLeaders.filter(id => id !== memberOpenid) };
        return roleResult(current);
      }
    });
    await page.onShow();
    await page.prepareInvite();
    await page.showReminderList();
    const request = page.confirmMemberRoleChange(event('memberOpenid', recipient), 'leader');
    await flushPromises();
    assert.match(calls.modals[0].content, /成为普通成员/);
    assert.match(calls.modals[0].content, /邀请成员或发送提醒/);
    assert.equal(page.data.isCreator, false);
    assert.equal(page.data.isDeputy, false);
    assert.equal(page.data.teamInfo.creator, recipient);
    assert.equal(page.data.inviteDialogOpen, false);
    assert.equal(page.data.reminderDialogOpen, false);
    assert.equal(page.data.settingsOpen, false);
    assert.equal(page.canManageTeam(), false);
    assert.equal(page.canAssistTeam(), false);
    assert.equal(page.onShareAppMessage().path, '/pages/team/team');
    assert.equal(manager.teams[0].creator, recipient);
    finishReport({ result: { success: false, error: '刷新失败' } });
    await request;
    assert.equal(page.data.isCreator, false);
    assert.equal(page.data.isDeputy, false);
    assert.equal(calls.transfers.length, 1);
  }
});

test('role changes reject self, missing members, cancelled confirmations and stale action sheets', async () => {
  for (const role of ['deputy', 'leader']) {
    for (const target of ['owner', 'missing', 'member']) {
      const { page, calls } = createPage({ confirm: false });
      await page.onShow();
      await page.confirmMemberRoleChange(event('memberOpenid', target), role);
      assert.equal(calls.deputyChanges.length + calls.transfers.length, 0);
    }
    for (const change of ['account', 'team', 'hide', 'refresh', 'permission']) {
      const { page, calls, storage } = createPage({ confirm: null });
      await page.onShow();
      const pending = page.confirmMemberRoleChange(event('memberOpenid', 'member'), role);
      if (change === 'account') storage.set('userOpenId', 'third');
      if (change === 'team') page.setData({ teamId: 'other-team' });
      if (change === 'hide') page.onHide();
      if (change === 'refresh') await page.loadTeamData();
      if (change === 'permission') page.setData({ teamInfo: { ...page.data.teamInfo, creator: 'third' } });
      calls.modals[0].success({ confirm: true });
      await pending;
      assert.equal(calls.deputyChanges.length + calls.transfers.length, 0, `${role} ${change}`);
    }
  }
  const { page, calls } = createPage();
  await page.onShow();
  const pending = page.openMemberActions(event('memberOpenid', 'member'));
  await page.loadTeamData();
  calls.actionSheets[0].success({ tapIndex: 0 });
  await pending;
  assert.equal(calls.modals.length, 0);
});

test('role mutations block duplicate writes, invitation preparation and reminder generation', async () => {
  let finish;
  const { page, calls } = createPage({ setTeamDeputy: () => new Promise(resolve => { finish = resolve; }) });
  await page.onShow();
  const request = page.confirmMemberRoleChange(event('memberOpenid', 'member'), 'deputy');
  await flushPromises();
  assert.equal(page.data.roleChangingMemberId, 'member');
  await page.confirmMemberRoleChange(event('memberOpenid', 'third'), 'leader');
  await page.confirmRemoveMember(event('memberOpenid', 'third'));
  await page.prepareInvite();
  await page.showReminderList();
  assert.equal(calls.deputyChanges.length, 1);
  assert.equal(calls.transfers.length + calls.removals.length + calls.reminderImages.length, 0);
  assert.equal(calls.cloud.some(call => call.type === 'generateInvite'), false);
  finish({ success: false, error: '副团长名额已满' });
  await request;
  assert.equal(page.data.roleChangingMemberId, '');
  assert.equal(page.data.deputyCount, 0);
  assert.equal(calls.modals.at(-1).content, '副团长名额已满');
});

test('a cloud report revoking deputy permissions prevents image generation and clears prepared invitations', async () => {
  let revoked = false;
  const { page, calls } = createPage({ openid: 'member',
    cloud: type => success(type === 'getTeamInfo' ? deputyTeam : roleReport(revoked ? team : deputyTeam)),
    generateInvite: () => success(invitation('team-a', 'member'))
  });
  await page.onShow();
  await page.prepareInvite();
  revoked = true;
  await page.showReminderList();
  assert.equal(page.data.isDeputy, false);
  assert.equal(page.data.isPreparingReminder, false);
  assert.equal(page.data.reminderDialogOpen, false);
  assert.equal(page.data.inviteReady, false);
  assert.equal(page.data.inviteDialogOpen, false);
  assert.equal(calls.reminderImages.length, 0);
});

test('deputy invite and image results cannot survive revocation, account changes or hiding', async () => {
  for (const change of ['revocation', 'account', 'hide']) {
    let finishInvite;
    let finishImage;
    const { page, calls, storage } = createPage({ openid: 'member',
      cloud: type => success(type === 'getTeamInfo' ? deputyTeam : roleReport(deputyTeam)),
      generateInvite: () => new Promise(resolve => { finishInvite = resolve; }),
      reminderImage: () => new Promise(resolve => { finishImage = resolve; })
    });
    await page.onShow();
    const inviteRequest = page.prepareInvite();
    const imageRequest = page.showReminderList();
    await flushPromises();
    if (change === 'revocation') page.setData({ teamInfo: { ...page.data.teamInfo, deputyLeaders: [] } });
    if (change === 'account') storage.set('userOpenId', 'third');
    if (change === 'hide') page.onHide();
    finishInvite(success(invitation('team-a', 'member')));
    finishImage({ tempFilePath: '/tmp/stale.png' });
    await Promise.all([inviteRequest, imageRequest]);
    assert.equal(page.data.inviteReady, false, change);
    assert.equal(page.data.isPreparingInvite, false, change);
    assert.equal(page.data.reminderDialogOpen, false, change);
    assert.equal(page.data.isPreparingReminder, false, change);
    assert.equal(calls.shareMenus.some(item => item.action === 'show'), false, change);
  }
});

test('a report reflecting a leadership transfer refreshes role badges and the cached leader name', async () => {
  const transferred = { ...structuredClone(team), creator: 'member', deputyLeaders: ['third'] };
  const { page, manager } = createPage({ cloud: type => success(type === 'getTeamInfo'
    ? { ...team, creatorName: '旧团长' } : roleReport(transferred)) });
  await page.onShow();
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.teamInfo.creator, 'member');
  assert.equal(page.data.teamInfo.creatorName, 'member');
  assert.equal(manager.teams[0].creatorName, 'member');
  assert.equal(page.data.teamMembers.find(item => item.openid === 'member').isCreator, true);
  assert.equal(page.data.teamMembers.find(item => item.openid === 'owner').isCreator, false);
});

test('a denied role mutation refreshes current permissions before allowing another management action', async () => {
  let current = structuredClone(team);
  const { page, calls } = createPage({
    cloud: type => success(type === 'getTeamInfo' ? current : roleReport(current)),
    setTeamDeputy: async () => {
      current = { ...current, creator: 'third' };
      return { success: false, error: '仅团长可设置副团长' };
    }
  });
  await page.onShow();
  await page.confirmMemberRoleChange(event('memberOpenid', 'member'), 'deputy');
  assert.equal(calls.modals.at(-1).content, '仅团长可设置副团长');
  assert.equal(page.data.isCreator, false);
  assert.equal(page.data.roleChangingMemberId, '');
  await page.confirmRemoveMember(event('memberOpenid', 'member'));
  await page.confirmMemberRoleChange(event('memberOpenid', 'member'), 'leader');
  assert.equal(calls.transfers.length + calls.removals.length, 0);
});

test('a successful role response for a replaced account cannot overwrite the new viewer role', async () => {
  for (const role of ['deputy', 'leader']) {
    let finish;
    let current = structuredClone(team);
    const { page, storage } = createPage({
      cloud: type => success(type === 'getTeamInfo' ? current : roleReport(current)),
      setTeamDeputy: () => new Promise(resolve => { finish = resolve; }),
      transferTeamLeader: () => new Promise(resolve => { finish = resolve; })
    });
    await page.onShow();
    const pending = page.confirmMemberRoleChange(event('memberOpenid', 'member'), role);
    await flushPromises();
    storage.set('userOpenId', 'third');
    await page.loadTeamData();
    current = role === 'leader' ? { ...current, creator: 'member' } : { ...current, deputyLeaders: ['member'] };
    finish(roleResult(current));
    await pending;
    assert.equal(page.data.isCreator, false, role);
    assert.equal(page.data.isDeputy, false, role);
    assert.equal(page.data.roleChangingMemberId, '', role);
    assert.equal(page._viewerOpenid, 'third', role);
    assert.equal(page.data.teamInfo.creator, current.creator, role);
  }
});

test('bijing team cards use the practice tag and units, route member records to the paginated page and preserve edit version', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', practiceType: 'instant', dailyGoalMinutes: 2000, version: 7 };
  const currentReport = { ...structuredClone(report), teamId: current._id, practiceType: 'instant', unit: '次',
    settings: { ...report.settings, dailyGoalMinutes: 2000 } };
  const { calls, createNextPage } = createPage({ cloud: type => success(type === 'getTeamInfo' ? current : currentReport) });
  const page = createNextPage({ teamId: current._id });
  await page.onShow();
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.practiceTypeName, '即刻觉察');
  assert.equal(page.data.practiceUnit, '次');
  assert.equal(page.data.belowGoalLabel, '数量不足');
  page.openMemberRecords({ currentTarget: { dataset: { memberOpenid: 'member', view: 'day' } } });
  assert.match(calls.navigation.at(-1).url, /^\/subpackages\/team\/pages\/memberRecords\/memberRecords\?/);
  assert.match(calls.navigation.at(-1).url, /date=2026-09-19/);
  page.openSettings();
  await page.saveSettings();
  const update = calls.cloud.find(call => call.type === 'updateTeam');
  assert.equal(update.data.expectedVersion, 7);
  assert.equal(update.data.teamData.dailyGoalMinutes, 2000);
});

test('bijing team avatar changes upload the approved image to data before saving the persistent URL', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', practiceType: 'instant', version: 7 };
  const { calls, createNextPage } = createPage({ initialTab: 'members', cloud: type => success(type === 'getTeamInfo' ? current : {}) });
  const page = createNextPage({ teamId: current._id });
  await page.onShow();
  page.openSettings();
  page.chooseTeamIcon();
  await calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new-icon' }] });
  assert.deepEqual(calls.uploads, ['cloud://approved-team-icon']);
  assert.equal(page.data.draftIcon, 'https://data.bijing.life/api/public/teams/avatar?key=approved');
  await page.saveSettings();
  assert.equal(calls.cloud.find(call => call.type === 'updateTeam').data.teamData.icon,
    'https://data.bijing.life/api/public/teams/avatar?key=approved');
});

test('a same-WeChat binding change immediately disables old data team roles and reloads the roster on return', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', source: 'bijing', practiceType: 'instant' };
  let finishReload;
  let reads = 0;
  const { calls, storage, createNextPage } = createPage({ initialTab: 'members',
    cloud: type => type === 'getTeamInfo' && ++reads === 1 ? success(current) : new Promise(resolve => { finishReload = resolve; }) });
  const page = createNextPage({ teamId: current._id });
  await page.onShow();
  assert.equal(page.canManageTeam(), true);
  storage.set('bijingStudentNumber', 'BJ008');
  assert.equal(page.canManageTeam(), false);
  assert.equal(page.canAssistTeam(), false);
  assert.equal(page.canInviteTeam(), false);
  page.openSettings();
  await page.prepareInvite();
  await page.confirmRemoveMember(event('memberOpenid', 'member'));
  assert.equal(page.data.settingsOpen, false);
  assert.equal(calls.cloud.length, 1);
  assert.equal(calls.removals.length, 0);
  const reload = page.onShow();
  assert.equal(page.data.teamInfo, null);
  assert.equal(page.data.report, null);
  assert.equal(page.data.teamMembers.length, 0);
  finishReload(success({ ...current, creator: 'member', deputyLeaders: [] }));
  await reload;
  assert.equal(page.data.isCreator, false);
  assert.equal(page.canManageTeam(), false);
});

test('data report responses for a previous binding never populate the new binding page', async () => {
  const current = { ...structuredClone(team), _id: 'bijing_8', source: 'bijing', practiceType: 'instant' };
  const oldReport = { ...structuredClone(report), teamId: current._id, practiceType: 'instant', unit: '次' };
  let finishReport;
  const { storage, createNextPage } = createPage({ initialTab: 'members', cloud: type => type === 'getTeamInfo'
    ? success(current) : new Promise(resolve => { finishReport = resolve; }) });
  const page = createNextPage({ teamId: current._id });
  await page.onShow();
  const pending = page.switchTab(event('tab', 'records'));
  storage.set('bijingBindingVersion', 'v2');
  finishReport(success(oldReport));
  await pending;
  assert.equal(page.data.report, null);
  assert.equal(page.data.todayMembers.length, 0);
  assert.equal(page.data.historyMembers.length, 0);
  assert.equal(page.canAssistTeam(), false);
});

const dataTeamWithPractices = () => ({ ...structuredClone(team), _id: 'bijing_12', source: 'bijing', version: 4,
  practiceType: 'sitting', practices: [
    { practiceType: 'sitting', practiceStartDate: '2026-09-01', effectivePracticeStartDate: '2026-09-01', dailyGoalMinutes: 20, unit: '分钟' },
    { practiceType: 'kindness', practiceStartDate: '2026-09-10', effectivePracticeStartDate: '2026-09-10', dailyGoalMinutes: 1, unit: '件' },
    { practiceType: 'walking', practiceStartDate: null, effectivePracticeStartDate: '2026-09-01', dailyGoalMinutes: null, unit: '分钟' }
  ] });
const dataReportFor = type => ({ ...structuredClone(report), teamId: 'bijing_12', practiceType: type,
  unit: type === 'kindness' ? '件' : '分钟', settings: { ...report.settings,
    practiceStartDate: type === 'walking' ? null : report.settings.practiceStartDate, effectivePracticeStartDate: '2026-09-01',
    dailyGoalMinutes: type === 'kindness' ? 1 : type === 'walking' ? null : 20 } });

function combinedReportFor(type, { allOptional = false } = {}) {
  const current = dataReportFor(type);
  const goal = allOptional ? null : current.settings.dailyGoalMinutes;
  const values = type === 'sitting' ? [25, 12, 0] : type === 'kindness' ? [1, 0, 0] : [5, 0, 0];
  const statuses = values.map(value => !value ? 'not_practiced' : goal === null ? 'practiced' : value >= goal ? 'qualified' : 'below_goal');
  current.settings.dailyGoalMinutes = goal;
  current.members = current.members.map((item, index) => ({ ...item,
    todayMinutes: values[index], todayStatus: statuses[index], todayPracticeCount: values[index] > 0 ? 1 : 0,
    totalPracticeCount: [20, 15, 17][index],
    ...(goal === null ? { qualifiedDays: 0, belowGoalDays: 0, unmetDays: 0 } : {})
  }));
  current.summary = { memberCount: 3,
    notPracticedCount: statuses.filter(status => status === 'not_practiced').length,
    belowGoalCount: statuses.filter(status => status === 'below_goal').length,
    qualifiedCount: statuses.filter(status => status === 'qualified').length,
    practicedCount: statuses.filter(status => status !== 'not_practiced').length };
  current.overview = { memberCount: 3, totalPracticeCount: 52,
    activeMemberCount: current.summary.practicedCount, activityRate: Math.round(current.summary.practicedCount / 3 * 100) };
  return current;
}

async function combinedPage(extra = {}) {
  const h = createPage({ ...extra, cloud: extra.cloud || ((type, request) => success(type === 'getTeamInfo'
    ? dataTeamWithPractices() : combinedReportFor(request.practiceType))) });
  h.page.setData({ teamId: 'bijing_12' });
  await h.page.onShow();
  return h;
}

test('all homework reports form one student card with independent progress and units', async () => {
  const { page, calls } = await combinedPage();
  assert.deepEqual(calls.cloud.filter(call => call.type === 'getTeamPracticeReport').map(call => call.data.practiceType),
    ['sitting', 'kindness', 'walking']);
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.todayHasGoal, true);
  assert.deepEqual({ ...page.data.todaySummary }, {
    memberCount: 3, notPracticedCount: 1, belowGoalCount: 1, qualifiedCount: 1, practicedCount: 0
  });
  assert.equal(page.data.attentionCount, 2);
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['third', 'member']);
  page.changeTodayFilter(event('filter', 'all'));
  assert.equal(page.data.todayMembers.length, 3);
  const partial = page.data.todayMembers.find(item => item.openid === 'member');
  assert.equal(partial.todayStatus, 'below_goal');
  assert.deepEqual(Array.from(partial.practices, item => [item.practiceType, item.unit, item.todayMinutesLabel, item.dailyGoalMinutes, item.progress]),
    [['sitting', '分钟', '12', 20, 60], ['kindness', '件', '0', 1, 0], ['walking', '分钟', '0', null, 0]]);
  page.changeTodayFilter(event('filter', 'qualified'));
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['owner']);
  assert.deepEqual(Array.from(page.data.practiceReports, item => item.practiceType), ['sitting', 'kindness', 'walking']);
  assert.equal(page.data.overview.totalPracticeCount, 156);
  assert.equal(page.data.overview.activeMemberCount, 2);
  assert.equal(page.data.overview.activityRate, 67);
  assert.equal(page.data.teamInfo.practiceType, 'sitting');
  assert.equal(page.data.teamInfo.dailyGoalMinutes, 20);
});

test('all homework waits for the complete set and discards late reports after an account change', async () => {
  let resolveWalking;
  const walking = new Promise(resolve => { resolveWalking = resolve; });
  const h = createPage({ cloud: (type, request) => type === 'getTeamInfo' ? success(dataTeamWithPractices())
    : request.practiceType === 'walking' ? walking : success(combinedReportFor(request.practiceType)) });
  h.page.setData({ teamId: 'bijing_12' });
  const pending = h.page.onShow();
  await flushPromises();
  assert.equal(h.page.data.report, null);
  assert.equal(h.page.data.todayMembers.length, 0);
  assert.equal(h.page.data.practiceReports.length, 0);
  h.storage.set('userOpenId', 'third');
  resolveWalking(success(combinedReportFor('walking')));
  await pending;
  assert.equal(h.page.data.report, null);
  assert.equal(h.page.data.todayMembers.length, 0);
  assert.equal(h.page.data.practiceReports.length, 0);
});

test('a missing optional homework still needs attention and all optional homework uses participation filters', async () => {
  const current = dataTeamWithPractices();
  current.practices = current.practices.map(item => ({ ...item, dailyGoalMinutes: null }));
  const { page } = await combinedPage({ cloud: (type, request) => success(type === 'getTeamInfo'
    ? current : combinedReportFor(request.practiceType, { allOptional: true })) });
  assert.equal(page.data.todayHasGoal, false);
  assert.equal(page.data.todaySummary.qualifiedCount, 0);
  assert.equal(page.data.attentionCount, 2);
  assert.equal(page.data.todayMembers.find(item => item.openid === 'member').todayStatus, 'below_goal');
  page.changeTodayFilter(event('filter', 'practiced'));
  assert.deepEqual(Array.from(page.data.todayMembers, item => item.openid), ['owner']);
  assert.equal(page.data.todayMembers[0].practices.every(item => !item.hasGoal), true);
});

test('a practiced optional homework cannot hide an incomplete homework with a target', async () => {
  const { page } = await combinedPage({ cloud(type, request) {
    if (type === 'getTeamInfo') return success(dataTeamWithPractices());
    const current = combinedReportFor(request.practiceType);
    if (request.practiceType === 'walking') {
      current.members[1].todayMinutes = 10;
      current.members[1].todayStatus = 'practiced';
      current.members[1].todayPracticeCount = 1;
    }
    return success(current);
  } });
  const partial = page.data.todayMembers.find(item => item.openid === 'member');
  assert.equal(partial.todayStatus, 'below_goal');
  assert.equal(partial.practices.find(item => item.practiceType === 'walking').todayStatus, 'practiced');
});

test('a failed or inconsistent homework report never leaves partially populated student cards', async () => {
  for (const mismatch of ['request', 'date', 'reset', 'members', 'invalid']) {
    const { page } = await combinedPage({ cloud(type, request) {
      if (type === 'getTeamInfo') return success(dataTeamWithPractices());
      const current = combinedReportFor(request.practiceType);
      if (request.practiceType === 'kindness') {
        if (mismatch === 'request') return Promise.reject(new Error('功课暂时无法加载'));
        if (mismatch === 'date') current.businessDate = '2026-09-20';
        if (mismatch === 'reset') current.nextResetAt += 24 * 60 * 60 * 1000;
        if (mismatch === 'members') current.members.pop();
        if (mismatch === 'invalid') current.members[0].todayMinutes = -1;
      }
      return success(current);
    } });
    assert.ok(page.data.reportError, mismatch);
    assert.equal(page.data.report, null, mismatch);
    assert.equal(page.data.todayMembers.length, 0, mismatch);
    assert.equal(page.data.practiceReports.length, 0, mismatch);
  }
});

test('homework row links preserve the explicit type for member and historical details', async () => {
  const { page, calls } = await combinedPage();
  page.openMemberRecords({ currentTarget: { dataset: { memberOpenid: 'owner', view: 'day', practiceType: 'kindness' } } });
  page.openHistoryDetails({ currentTarget: { dataset: { filter: 'all', practiceType: 'walking' } } });
  assert.equal(new URL('https://local' + calls.navigation[0].url).searchParams.get('practiceType'), 'kindness');
  assert.equal(new URL('https://local' + calls.navigation[1].url).searchParams.get('practiceType'), 'walking');
});

test('history homework tabs select independent statistics and record links without reloading today', async () => {
  const { page, calls } = await combinedPage();
  page.switchRecordTab(event('tab', 'history'));
  assert.equal(page.data.historyPracticeType, 'sitting');
  const original = { report: page.data.report, todayMembers: page.data.todayMembers,
    todaySummary: page.data.todaySummary, selectedPracticeType: page.data.selectedPracticeType };
  const requestCount = calls.cloud.length;
  for (const [practiceType, unit, hasGoal] of [['kindness', '件', true], ['walking', '分钟', false]]) {
    page.switchHistoryPractice(event('practiceType', practiceType));
    assert.equal(page.data.historyPracticeType, practiceType);
    const view = page.data.practiceReports.find(item => item.practiceType === page.data.historyPracticeType);
    assert.equal(view.unit, unit);
    assert.equal(view.hasGoal, hasGoal);
    assert.equal(view.report.practiceType, practiceType);
    assert.equal(view.historySummary.rateLabel, hasGoal ? '75.9%' : '87%');
    const context = { practiceType: page.data.historyPracticeType };
    page.openHistoryDetails({ currentTarget: { dataset: { ...context, filter: 'unmet', memberOpenid: 'member' } } });
    page.openMemberRecords({ currentTarget: { dataset: { ...context, memberOpenid: 'owner', view: 'month', recordScope: 'history' } } });
    const [details, records] = calls.navigation.slice(-2).map(item => new URL('https://local' + item.url));
    assert.equal(details.searchParams.get('practiceType'), practiceType);
    assert.equal(details.searchParams.get('memberOpenid'), 'member');
    assert.equal(details.searchParams.get('filter'), hasGoal ? 'unmet' : 'not_practiced');
    assert.equal(records.searchParams.get('practiceType'), practiceType);
    assert.equal(records.searchParams.get('month'), '2026-09');
  }
  assert.equal(calls.cloud.length, requestCount);
  for (const [key, value] of Object.entries(original)) assert.equal(page.data[key], value, key);
});

test('history homework selection survives record tabs, member tabs, return navigation, and refresh', async () => {
  const { page, calls } = await combinedPage();
  page.switchRecordTab(event('tab', 'history'));
  page.switchHistoryPractice(event('practiceType', 'kindness'));
  const requestCount = calls.cloud.length;
  page.switchRecordTab(event('tab', 'today'));
  page.switchRecordTab(event('tab', 'history'));
  await page.switchTab(event('tab', 'members'));
  await page.switchTab(event('tab', 'records'));
  page.onHide();
  await page.onShow();
  assert.equal(page.data.historyPracticeType, 'kindness');
  assert.equal(page.data.recordTab, 'history');
  assert.equal(calls.cloud.length, requestCount);
  await page.onPullDownRefresh();
  assert.equal(page.data.historyPracticeType, 'kindness');
  assert.equal(page.data.recordTab, 'history');
  assert.equal(calls.refreshStopped, 1);
  assert.equal(calls.cloud.length, requestCount + 4);
});

test('history sort choices are independent per homework and survive returning and refreshing reports', async () => {
  let changed = false;
  const { page } = await combinedPage({ cloud: (type, request) => {
    if (type === 'getTeamInfo') return success(dataTeamWithPractices());
    const current = combinedReportFor(request.practiceType);
    if (changed && request.practiceType === 'sitting') {
      current.members[0] = { ...current.members[0], practiceDays: 1, qualifiedDays: 1,
        missedDays: 17, belowGoalDays: 0, unmetDays: 17, totalMinutes: 20 };
    }
    return success(current);
  } });
  page.switchRecordTab(event('tab', 'history'));
  const sort = (practiceType, order) => page.changeHistorySort({ currentTarget: { dataset: { practiceType, order } } });
  sort('sitting', 'asc');
  page.switchHistoryPractice(event('practiceType', 'walking'));
  sort('walking', 'asc');
  const orders = () => Array.from(page.data.practiceReports, view => [view.practiceType, view.historySortOrder]);
  const expectedOrders = [['sitting', 'asc'], ['kindness', 'desc'], ['walking', 'asc']];
  assert.deepEqual(orders(), expectedOrders);
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['member', 'third', 'owner']);
  assert.deepEqual(Array.from(page.data.practiceReports[1].historyMembers, item => item.openid), ['owner', 'third', 'member']);
  page.onHide();
  await page.onShow();
  assert.deepEqual(orders(), expectedOrders);
  changed = true;
  await page.onPullDownRefresh();
  assert.deepEqual(orders(), expectedOrders);
  assert.equal(page.data.historyPracticeType, 'walking');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['owner', 'member', 'third']);
  assert.deepEqual(Array.from(page.data.practiceReports[0].historyMembers, item => item.openid), ['owner', 'member', 'third']);
  assert.deepEqual(Array.from(page.data.practiceReports[2].historyMembers, item => item.openid), ['member', 'third', 'owner']);
});

test('history homework selection rejects unavailable tabs and falls back when a refreshed team removes one', async () => {
  let currentTeam = dataTeamWithPractices();
  const { page, calls } = await combinedPage({ cloud: (type, request) => success(type === 'getTeamInfo'
    ? currentTeam : combinedReportFor(request.practiceType)) });
  page.switchHistoryPractice(event('practiceType', 'kindness'));
  const requestCount = calls.cloud.length;
  const updates = page.dataUpdates.length;
  for (const value of ['', undefined, null, 'instant', 'unknown']) page.switchHistoryPractice(event('practiceType', value));
  page.switchHistoryPractice();
  page.switchHistoryPractice(event('practiceType', 'kindness'));
  assert.equal(page.data.historyPracticeType, 'kindness');
  assert.equal(calls.cloud.length, requestCount);
  assert.equal(page.dataUpdates.length, updates);
  currentTeam = { ...currentTeam, practices: currentTeam.practices.filter(item => item.practiceType !== 'kindness') };
  await page.onPullDownRefresh();
  assert.equal(page.data.historyPracticeType, 'sitting');
  assert.deepEqual(Array.from(page.data.practiceReports, item => item.practiceType), ['sitting', 'walking']);
  const single = createPage();
  await single.page.onShow();
  assert.equal(single.page.data.hasMultiplePractices, false);
  assert.equal(single.page.data.historyPracticeType, 'sitting');
  assert.equal(single.page.data.historySummary.unmetCount, 13);
});

test('changing viewer account or binding resets the historical homework selection and sort choices', async () => {
  for (const [key, value] of [['userOpenId', 'member'], ['bijingBindingVersion', 'v2']]) {
    const { page, storage } = await combinedPage();
    page.switchRecordTab(event('tab', 'history'));
    page.switchHistoryPractice(event('practiceType', 'walking'));
    for (const practiceType of ['sitting', 'walking']) {
      page.changeHistorySort({ currentTarget: { dataset: { practiceType, order: 'asc' } } });
    }
    page.onHide();
    storage.set(key, value);
    await page.onShow();
    assert.equal(page.data.reportError, '', key);
    assert.equal(page.data.historyPracticeType, 'sitting', key);
    assert.equal(page.data.practiceReports.length, 3, key);
    assert.equal(page.data.practiceReports.every(view => view.historySortOrder === 'desc'), true, key);
  }
});

test('changing teams resets history sorting to descending rates', async () => {
  const { page } = createPage({ cloud: (type, request) => success(type === 'getTeamInfo'
    ? { ...team, _id: request.teamId } : { ...report, teamId: request.teamId }) });
  await page.onShow();
  page.switchRecordTab(event('tab', 'history'));
  page.changeHistorySort({ currentTarget: { dataset: { practiceType: 'sitting', order: 'asc' } } });
  page.onHide();
  page.setData({ teamId: 'team-b' });
  await page.onShow();
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.practiceReports[0].historySortOrder, 'desc');
  assert.deepEqual(Array.from(page.data.historyMembers, item => item.openid), ['owner', 'third', 'member']);
});

test('editing and adding homework retain all rules and work when the selected homework has no target', async () => {
  let updated;
  const h = createPage({ cloud(type, request) {
    if (type === 'updateTeam') { updated = structuredClone(request); return success({ teamId: 'bijing_12' }); }
    return success(type === 'getTeamInfo' ? dataTeamWithPractices() : dataReportFor(request.practiceType));
  } });
  h.page.setData({ teamId: 'bijing_12' });
  await h.page.onShow();
  h.page.openSettings();
  h.page.selectDraftPractice(event('type', 'walking'));
  assert.equal(h.page.data.draftPracticeRulesEnabled, false);
  h.page.addDraftPractice(event('type', 'instant'));
  assert.equal(h.page.data.draftPracticeType, 'instant');
  assert.equal(h.page.data.draftStartDate, '2026-09-19');
  h.page.changeGoalMinutes({ detail: { value: '2000' } });
  await h.page.saveSettings();
  assert.equal(updated.teamData.dailyGoalMinutes, 20);
  assert.equal(updated.teamData.practiceStartDate, '2026-09-01');
  assert.deepEqual(updated.teamData.practices.map(item => [item.practiceType, item.dailyGoalMinutes]),
    [['sitting', 20], ['kindness', 1], ['walking', null], ['instant', 2000]]);
});

test('reminder generation refreshes all homework and exports each student with every progress row', async () => {
  const h = await combinedPage();
  await h.page.showReminderList();
  assert.equal(h.calls.cloud.filter(call => call.type === 'getTeamPracticeReport').length, 6);
  assert.equal(h.calls.reminderImages[0].report.multiPractice, true);
  assert.equal(h.calls.reminderImages[0].teamName, team.name);
  assert.deepEqual(Array.from(h.calls.reminderImages[0].members, item => item.openid), ['third', 'member']);
  assert.equal(h.calls.reminderImages[0].members.every(item => item.practices.length === 3), true);
  assert.equal(h.page.data.reminderDialogOpen, true);
  h.page.onHide();
  assert.equal(h.page.data.reminderDialogOpen, false);
  assert.equal(await h.page.getCurrentReminderContext(), null);
});

test('repeated homework reminder refreshes keep progress rows flat instead of nesting earlier snapshots', async () => {
  const { page, calls } = await combinedPage();
  for (let refresh = 0; refresh < 3; refresh++) {
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true);
    const members = calls.reminderImages.at(-1).members;
    assert.equal(members.every(member => member.practices.length === 3), true);
    for (const member of members) {
      assert.equal(member.practices.some(practice => Object.hasOwn(practice, 'practices')), false);
    }
    page.closeReminderDialog();
  }
});

test('large team progress updates stay below the bridge payload limit and replace shortened snapshots completely', async () => {
  const types = ['sitting', 'kindness', 'walking', 'instant', 'learning', 'clapping'];
  let memberCount = 500;
  const profiles = Array.from({ length: memberCount }, (_, index) => ({
    openid: index === 0 ? 'owner' : `bijing_member_${100000 + index}`,
    nickname: `瑞璞练习同学${String(index).padStart(4, '0')}`,
    bijingStudentNumber: `BJ${100000 + index}`,
    avatarUrl: `https://example.test/avatars/practice-student-${100000 + index}.png`,
    isCreator: index === 0
  }));
  const currentTeam = dataTeamWithPractices();
  currentTeam.practices = types.map(practiceType => ({ practiceType,
    practiceStartDate: '2026-09-01', effectivePracticeStartDate: '2026-09-01',
    dailyGoalMinutes: practiceType === 'kindness' ? 1 : practiceType === 'instant' ? 10 : 20,
    unit: practiceType === 'kindness' ? '件' : practiceType === 'instant' ? '次' : '分钟' }));
  function currentReport(practiceType) {
    const settings = currentTeam.practices.find(item => item.practiceType === practiceType);
    const current = combinedReportFor(practiceType === 'kindness' ? 'kindness' : 'sitting');
    const members = profiles.slice(0, memberCount).map((profile, index) => ({
      ...current.members[index % 3], ...profile,
      todayStatus: ['qualified', 'below_goal', 'not_practiced'][index % 3],
      todayMinutes: index % 3 === 0 ? settings.dailyGoalMinutes + 1 : index % 3 === 1 ? settings.dailyGoalMinutes / 2 : 0,
      todayPracticeCount: index % 3 === 2 ? 0 : 1
    }));
    return { ...current, practiceType, unit: settings.unit, creator: 'owner', deputyLeaders: [],
      settings: { ...current.settings, ...settings }, members,
      summary: { memberCount,
        notPracticedCount: members.filter(item => item.todayStatus === 'not_practiced').length,
        belowGoalCount: members.filter(item => item.todayStatus === 'below_goal').length,
        qualifiedCount: members.filter(item => item.todayStatus === 'qualified').length,
        practicedCount: members.filter(item => item.todayStatus !== 'not_practiced').length } };
  }
  const { page, calls } = await combinedPage({ cloud(type, request) {
    return success(type === 'getTeamInfo' ? { ...currentTeam, members: profiles.slice(0, memberCount) }
      : currentReport(request.practiceType));
  } });
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.teamMembers.length, 500);
  assert.equal(page.data.practiceReports.length, 6);
  assert.equal(page.data.practiceReports.every(item => item.report.members.length === 500 && item.historyMembers.length === 500), true);
  page.changeTodayFilter(event('filter', 'all'));
  assert.equal(page.data.todayMembers.length, 500);
  assert.equal(page.data.todayMembers.every(item => item.practices.length === 6), true);
  for (let refresh = 0; refresh < 2; refresh++) {
    await page.showReminderList();
    assert.equal(page.data.reminderDialogOpen, true);
    assert.equal(calls.reminderImages.at(-1).members.every(item => item.practices.length === 6 &&
      item.practices.every(practice => !Object.hasOwn(practice, 'practices'))), true);
    page.closeReminderDialog();
  }
  page.changeTodayFilter(event('filter', 'qualified'));
  assert.equal(page.data.todayMembers.length, 167);
  assert.equal(page.data.todayMembers.every(item => item.todayStatus === 'qualified'), true);
  page.changeTodayFilter(event('filter', 'all'));
  memberCount = 100;
  await page.showReminderList();
  assert.equal(page.data.reportError, '');
  assert.equal(page.data.teamMembers.length, 100);
  assert.equal(page.data.todayMembers.length, 100);
  assert.equal(page.data.historyMembers.length, 100);
  assert.equal(page.data.report.members.length, 100);
  assert.equal(page.data.practiceReports.every(item => item.report.members.length === 100 &&
    item.members.length === 100 && item.historyMembers.length === 100), true);
  assert.equal(page.data.todayMembers.every(item => item.practices.length === 6), true);
  const maxPayloadBytes = page.dataUpdates.reduce((max, update) => Math.max(max, Buffer.byteLength(JSON.stringify(update), 'utf8')), 0);
  assert.ok(maxPayloadBytes < 1024 * 1024, `largest setData payload was ${maxPayloadBytes} bytes`);
});

const draftEvent = (type, value) => ({ currentTarget: { dataset: { type } }, detail: { value } });
async function dataSelectionPage(extra = {}) {
  const h = createPage({ ...extra, cloud: extra.cloud || ((type, request) => success(type === 'getTeamInfo' ? dataTeamWithPractices() : dataReportFor(request.practiceType))) });
  h.page.setData({ teamId: 'bijing_12' });
  await h.page.onShow();
  h.page.openSettings();
  return h;
}

test('edit selection locks saved types while unsaved choices can be cancelled and restored with raw drafts', async () => {
  const { page } = await dataSelectionPage();
  page.toggleDraftPractice(draftEvent('sitting'));
  assert.deepEqual(Array.from(page.data.draftPractices, item => item.practiceType), ['sitting', 'kindness', 'walking']);
  page.toggleDraftPractice(draftEvent('instant'));
  assert.equal(page.data.draftPracticeType, 'instant');
  page.changeGoalMinutes(draftEvent('instant', '2000'));
  page.changePracticeRulesEnabled(draftEvent('instant', false));
  page.toggleDraftPractice(draftEvent('instant'));
  assert.equal(page.data.draftPracticeType, 'walking');
  page.toggleDraftPractice(draftEvent('instant'));
  assert.equal(page.data.draftGoalMinutes, '2000');
  assert.equal(page.data.draftPracticeRulesEnabled, false);
  assert.equal(page.data.draftStartDate, '2026-09-19');
  assert.deepEqual(Array.from(page.data.draftLockedPracticeTypes), ['sitting', 'kindness', 'walking']);
});

test('disabling rules and switching editors never destroys the hidden target or starting date', async () => {
  const { page, calls } = await dataSelectionPage();
  page.changeStartDate(draftEvent('sitting', '2026-09-02'));
  page.changeGoalMinutes(draftEvent('sitting', '45'));
  page.changePracticeRulesEnabled(draftEvent('sitting', false));
  page.selectDraftPractice(draftEvent('kindness'));
  page.selectDraftPractice(draftEvent('sitting'));
  assert.equal(page.data.draftPracticeRulesEnabled, false);
  assert.equal(page.data.draftStartDate, '2026-09-02');
  assert.equal(page.data.draftGoalMinutes, '45');
  page.changePracticeRulesEnabled(draftEvent('sitting', true));
  assert.match(page.data.draftPracticeCards[0].summary, /每日 45 分钟/);
  assert.ok(calls.keyboardHidden > 0);
});

test('edit late inputs cannot write another homework and invalid hidden choices open before saving', async () => {
  const { page, calls } = await dataSelectionPage();
  page.toggleDraftPractice(draftEvent('instant'));
  page.changeGoalMinutes(draftEvent('instant', '0'));
  page.selectDraftPractice(draftEvent('kindness'));
  page.changeGoalMinutes(draftEvent('instant', '100'));
  assert.equal(page.data.draftGoalMinutes, '1');
  await page.saveSettings();
  assert.equal(page.data.draftPracticeType, 'instant');
  assert.equal(page.data.settingsScrollTarget, 'practice-rule-instant');
  assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
  page.closeSettings();
  page.openSettings();
  assert.deepEqual(Array.from(page.data.draftPractices, item => item.practiceType), ['sitting', 'kindness', 'walking']);
});

test('members can inspect other homework rules without gaining selection or save permissions', async () => {
  const { page, calls } = await dataSelectionPage({ openid: 'member' });
  assert.equal(page.data.isCreator, false);
  page.selectDraftPractice(draftEvent('kindness'));
  assert.equal(page.data.draftPracticeType, 'kindness');
  page.toggleDraftPractice(draftEvent('instant'));
  page.changeGoalMinutes(draftEvent('kindness', '10'));
  await page.saveSettings();
  assert.equal(page.data.draftGoalMinutes, '1');
  assert.equal(page.data.draftPractices.length, 3);
  assert.equal(calls.cloud.some(call => call.type === 'updateTeam'), false);
});

test('restoring a new edit choice keeps server order and the original order of unsaved additions', async () => {
  const { page } = await dataSelectionPage();
  page.toggleDraftPractice(draftEvent('instant'));
  page.toggleDraftPractice(draftEvent('clapping'));
  page.toggleDraftPractice(draftEvent('instant'));
  page.toggleDraftPractice(draftEvent('instant'));
  assert.deepEqual(Array.from(page.data.draftPractices, item => item.practiceType), ['sitting', 'kindness', 'walking', 'instant', 'clapping']);
  assert.equal(page.data.draftPracticeType, 'instant');
});
