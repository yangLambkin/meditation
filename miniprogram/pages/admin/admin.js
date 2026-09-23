const cloudApi = require('../../utils/cloudApi.js');
const dateUtil = require('../../utils/dateUtil.js');

const STATUS_LABELS = { pending: '待核对', running: '同步中', success: '已完成', partial: '部分失败', failed: '失败', interrupted: '已中断', skipped: '已跳过' };
const PHASE_LABELS = { upload: '批量上传', verify: '核对必经数据', retry: '重试缺失记录', reverify: '复核修复结果' };
function clearSyncAlert() {
  if (typeof getApp !== 'function') return;
  const app = getApp();
  if (!app) return;
  if (typeof app.clearSyncAlert === 'function') app.clearSyncAlert();
}
function errorText(error) {
  return typeof error === 'string' ? error : error && (error.message || error.errMsg) || '操作失败，请重试';
}
function timestamp(value) {
  if (value && value.$date !== undefined) value = value.$date;
  const time = new Date(value).getTime();
  return value && Number.isFinite(time) ? time : 0;
}
function timeText(value) {
  const time = timestamp(value);
  return time ? new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '—';
}
function durationText(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function presentRun(run) {
  const elapsed = ['running', 'interrupted'].includes(run.status) && timestamp(run.startedAt)
    ? Date.now() - timestamp(run.startedAt) : run.durationMs;
  const legacySuccess = run.status === 'success' && (!run.phase || run.phase === 'upload');
  return { ...run, statusText: legacySuccess ? '历史完成 · 未核对' : run.status === 'success' ? '核对完成' : STATUS_LABELS[run.status] || run.status,
    verifiedCountLabel: legacySuccess ? '历史上报成功' : '核对通过',
    phaseText: PHASE_LABELS[run.phase] || '',
    triggerText: ({ timer: '自动同步', 'timer-errors': '自动修复', 'manual-errors': '手动修复' })[run.trigger] || '手动同步',
    startedText: timeText(run.startedAt), finishedText: timeText(run.finishedAt), interruptionText: timeText(run.lastInterruptionAt), durationText: durationText(elapsed) };
}
function clearedRecordQuery() {
  return { queryNickname: '', queryDate: '', queryMaxDate: '', queryUsers: [], queryUsersCursor: '',
    queryUserIndex: -1, selectedQueryUser: null, queryLoading: false, querySearched: false, queryError: '',
    dayRecords: [], dayRecordsLoading: false, dayRecordsLoaded: false, dayRecordsError: '', dayTotalCount: 0, dayTotalDuration: 0 };
}
function clearedDayRecords() {
  return { dayRecords: [], dayRecordsLoading: false, dayRecordsLoaded: false, dayRecordsError: '', dayTotalCount: 0, dayTotalDuration: 0 };
}
function clearedPrivateData() {
  return { ...clearedRecordQuery(), authorized: false, dates: [], dateIndex: 0, recordDate: '', timerEnabled: false, apiConfigured: false,
    runs: [], runsLoading: false, showAllRuns: true, syncError: '', syncMessage: '', runningRunId: '', runningRecordDate: '',
    selectedRunId: '', items: [], itemsLoading: false, itemsError: '', itemsCursor: '',
    syncErrors: [], syncErrorsLoading: false, syncErrorsError: '', syncErrorsCursor: '',
    teams: [], teamsLoading: false, teamsError: '', teamsCursor: '', teamIndex: -1, selectedTeam: null,
    membersLoading: false, candidates: [], candidateIndex: -1, selectedCandidate: null,
    logs: [], logsLoading: false, logsError: '', logsCursor: '' };
}

Page({
  data: {
    ...clearedRecordQuery(),
    entryVerifying: true, entryAuthorized: false, entryError: '',
    verifying: true, authorized: false, accessError: '', tab: 'sync',
    dates: [], dateIndex: 0, recordDate: '', timerEnabled: false, apiConfigured: false,
    runs: [], runsLoading: false, showAllRuns: true, syncBusy: false, syncError: '', syncMessage: '', runningRunId: '', runningRecordDate: '',
    selectedRunId: '', items: [], itemsLoading: false, itemsError: '', itemsCursor: '',
    syncErrors: [], syncErrorsLoading: false, syncErrorsError: '', syncErrorsCursor: '',
    teams: [], teamsLoading: false, teamsError: '', teamsCursor: '', teamIndex: -1, selectedTeam: null,
    membersLoading: false, candidates: [], candidateIndex: -1, selectedCandidate: null, transferBusy: false,
    logs: [], logsLoading: false, logsError: '', logsCursor: ''
  },

  async onShow() {
    this._visible = true;
    const generation = this._generation = (this._generation || 0) + 1;
    this.clearPoll();
    this.setData({ ...clearedPrivateData(), entryVerifying: true, entryAuthorized: false, entryError: '',
      verifying: false, accessError: '', syncBusy: !!this._syncBusy, transferBusy: !!this._transferBusy });
    try {
      const access = await this.callAdmin('adminManager', 'getAccess');
      if (!this.isCurrent(generation)) return;
      if (access.isAdmin !== true) {
        clearSyncAlert();
        throw new Error('仅指定管理员可进入管控');
      }
      this.setData({ entryAuthorized: true, entryVerifying: false });
      await this.activateTab(this.data.tab);
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ entryVerifying: false, entryAuthorized: false, entryError: errorText(error) });
    }
  },

  async activateTab(tab) {
    if (!this._visible || !this.data.entryAuthorized) return;
    this.clearPoll();
    const generation = this._generation = (this._generation || 0) + 1;
    this._continuePaused = false;
    this._workerBusy = false;
    this.setData({ ...clearedPrivateData(), tab, verifying: true, accessError: '',
      syncBusy: !!this._syncBusy, transferBusy: !!this._transferBusy });
    try {
      if (tab === 'sync') {
        const status = await this.callAdmin('bijingSync', 'adminStatus');
        if (!this.isCurrent(generation)) return;
        const dates = Array.isArray(status.dates) ? status.dates : [];
        const recordDate = status.latestDate || dates[0] || '';
        this.setData({ authorized: true, verifying: false, dates, recordDate,
          dateIndex: Math.max(0, dates.indexOf(recordDate)), timerEnabled: status.timerEnabled === true, apiConfigured: status.apiConfigured === true });
        await this.loadSyncErrors();
        await this.loadRuns();
      } else if (tab === 'query') {
        const access = await this.callAdmin('adminManager', 'getAccess');
        if (!this.isCurrent(generation)) return;
        if (access.isAdmin !== true) throw new Error('仅指定管理员可查询记录');
        const today = dateUtil.getBusinessDate(Date.now());
        this.setData({ authorized: true, verifying: false, queryDate: today, queryMaxDate: today });
      } else if (tab === 'team') {
        const result = await this.callAdmin('teamManager', 'adminListTeams');
        if (!this.isCurrent(generation)) return;
        this.setData({ authorized: true, verifying: false, teams: result.teams || [], teamsCursor: result.nextCursor || '' });
      } else {
        const result = await this.callAdmin('teamManager', 'adminAuditLogs');
        if (!this.isCurrent(generation)) return;
        this.setData({ authorized: true, verifying: false,
          logs: (result.logs || []).map(log => ({ ...log, createdText: timeText(log.createdAt) })), logsCursor: result.nextCursor || '' });
      }
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ ...clearedPrivateData(), verifying: false, accessError: errorText(error) });
    }
  },

  onHide() { this.stopPage(); },
  onUnload() { this.stopPage(); },
  stopPage() {
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.clearPoll();
    this.setData({ ...clearedPrivateData(), entryAuthorized: false, entryVerifying: false, verifying: false });
  },
  isCurrent(generation) { return this._visible && generation === this._generation; },
  clearPoll() {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },

  async callAdmin(functionName, type, data = {}) {
    const generation = this._generation;
    const payload = functionName === 'teamManager' ? { type, data } : { type, ...data };
    const response = await cloudApi.callCloudFunction(functionName, payload);
    const result = response && response.result;
    if (!result || result.success !== true) {
      const message = errorText(result && result.error || '服务未返回有效结果，请重试');
      const unknown = message.match(/^未知操作[：:]\s*(\w+)$/);
      const outdated = (unknown && unknown[1] === type) || (['teamManager', 'adminManager'].includes(functionName) && message === '未知的操作类型');
      const error = new Error(outdated ? `管控服务尚未更新，请先部署 ${functionName} 云函数` : message);
      error.code = result && result.code;
      if (error.code === 'FORBIDDEN' && this.isCurrent(generation)) {
        this.clearPoll();
        this.setData({ ...clearedPrivateData(), verifying: false, accessError: error.message });
        clearSyncAlert();
      }
      throw error;
    }
    return result.data || {};
  },

  async onTabChange(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!this.data.entryAuthorized || !['sync', 'query', 'team', 'audit'].includes(tab) || tab === this.data.tab) return;
    await this.activateTab(tab);
  },
  async refreshTab() {
    if (!this._visible) return;
    if (!this.data.entryAuthorized || !this.data.authorized) return this.retryAccess();
    if (this.data.tab === 'sync') {
      await this.loadSyncErrors();
      await this.loadRuns();
    }
    else if (this.data.tab === 'query') {
      if (this.data.selectedQueryUser) await this.loadDayRecords();
      else if (this.data.queryNickname.trim()) await this.searchRecordUsers();
    }
    else if (this.data.tab === 'team') {
      await this.loadTeams();
      if (this.data.selectedTeam) await this.loadMembers();
    }
    else await this.loadLogs();
  },
  async onPullDownRefresh() {
    try { await this.refreshTab(); } finally { wx.stopPullDownRefresh(); }
  },
  retryAccess() { return this.data.entryAuthorized ? this.activateTab(this.data.tab) : this.onShow(); },

  canQueryRecords() { return this._visible && this.data.authorized && this.data.tab === 'query'; },
  onQueryNicknameInput(event) {
    this._queryUsersRequest = (this._queryUsersRequest || 0) + 1;
    this._dayRecordsRequest = (this._dayRecordsRequest || 0) + 1;
    this.setData({ ...clearedDayRecords(), queryNickname: event.detail.value, queryUsers: [], queryUsersCursor: '',
      queryUserIndex: -1, selectedQueryUser: null, queryLoading: false, querySearched: false, queryError: '' });
  },
  async onQueryDateChange(event) {
    if (event.detail.value === this.data.queryDate) return;
    this._dayRecordsRequest = (this._dayRecordsRequest || 0) + 1;
    this.setData({ ...clearedDayRecords(), queryDate: event.detail.value });
    if (this.data.selectedQueryUser) await this.loadDayRecords();
  },
  loadMoreQueryUsers() { return this.searchRecordUsers(true); },
  async searchRecordUsers(append = false) {
    // bindtap/bindconfirm pass an event object; only an explicit true appends a page.
    append = append === true;
    if (!this.canQueryRecords() || this.data.queryLoading || (append && !this.data.queryUsersCursor)) return;
    const nickname = this.data.queryNickname.trim();
    if (!nickname || nickname.length > 100) {
      this.setData({ queryError: '请输入完整昵称（1–100 个字符）' });
      return;
    }
    if (!dateUtil.isDateLabel(this.data.queryDate) || this.data.queryDate > this.data.queryMaxDate) {
      this.setData({ queryError: '请选择有效的静坐日期' });
      return;
    }
    const generation = this._generation;
    const request = this._queryUsersRequest = (this._queryUsersRequest || 0) + 1;
    if (!append) {
      this._dayRecordsRequest = (this._dayRecordsRequest || 0) + 1;
      this.setData({ ...clearedDayRecords(), queryUsers: [], queryUsersCursor: '', queryUserIndex: -1, selectedQueryUser: null, querySearched: false });
    }
    this.setData({ queryNickname: nickname, queryLoading: true, queryError: '' });
    try {
      const result = await this.callAdmin('adminManager', 'adminSearchUsers', { nickname, ...(append ? { cursor: this.data.queryUsersCursor } : {}) });
      if (!this.isCurrent(generation) || request !== this._queryUsersRequest || !this.data.authorized) return;
      const users = (result.users || []).map(user => ({ ...user,
        displayName: `${user.nickname} · ${user.studentNumber || '未绑定学号'} · ${user.openid.slice(-6)}` }));
      const queryUsers = append ? this.data.queryUsers.concat(users).filter((user, index, all) => all.findIndex(other => other.openid === user.openid) === index) : users;
      this.setData({ queryUsers, queryUsersCursor: result.nextCursor || '', querySearched: true });
      if (queryUsers.length === 1 && !result.nextCursor && !this.data.selectedQueryUser) {
        this.setData({ queryUserIndex: 0, selectedQueryUser: queryUsers[0] });
        await this.loadDayRecords();
      }
    } catch (error) {
      if (this.isCurrent(generation) && request === this._queryUsersRequest && this.data.authorized) this.setData({ queryError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._queryUsersRequest) this.setData({ queryLoading: false });
    }
  },
  async onQueryUserChange(event) {
    const index = Number(event.detail.value);
    const user = this.data.queryUsers[index];
    if (!this.canQueryRecords() || !user) return;
    this.setData({ queryUserIndex: index, selectedQueryUser: user });
    await this.loadDayRecords();
  },
  async loadDayRecords() {
    if (!this.canQueryRecords() || !this.data.selectedQueryUser) return;
    const generation = this._generation;
    const request = this._dayRecordsRequest = (this._dayRecordsRequest || 0) + 1;
    const openid = this.data.selectedQueryUser.openid;
    const recordDate = this.data.queryDate;
    this.setData({ ...clearedDayRecords(), dayRecordsLoading: true });
    try {
      const result = await this.callAdmin('adminManager', 'adminGetDayRecords', { openid, recordDate });
      if (!this.isCurrent(generation) || request !== this._dayRecordsRequest || !this.data.authorized) return;
      this.setData({ dayRecordsLoaded: true, dayTotalCount: result.totalCount, dayTotalDuration: result.totalDuration,
        dayRecords: (result.records || []).map(record => ({ ...record,
          timeText: record.timestamp ? timeText(record.timestamp) : '未记录具体时间',
          sourceText: ({ manual: '手动补录', timer: '计时记录' })[record.source] || '历史记录' })) });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._dayRecordsRequest && this.data.authorized) this.setData({ dayRecordsError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._dayRecordsRequest) this.setData({ dayRecordsLoading: false });
    }
  },

  async onDateChange(event) {
    const index = Number(event.detail.value);
    if (this._syncBusy || !this.data.dates[index] || index === this.data.dateIndex) return;
    this._continuePaused = false;
    this._itemsRequest = (this._itemsRequest || 0) + 1;
    this.setData({ dateIndex: index, recordDate: this.data.dates[index], showAllRuns: false, runs: [], runningRunId: '', runningRecordDate: '',
      selectedRunId: '', items: [], itemsError: '', itemsCursor: '', itemsLoading: false, syncError: '', syncMessage: '' });
    await this.loadRuns();
  },

  async onHistoryScopeChange(event) {
    const showAllRuns = event.currentTarget.dataset.scope === 'all';
    if (showAllRuns === this.data.showAllRuns) return;
    this.setData({ showAllRuns, runs: [], selectedRunId: '', items: [], itemsCursor: '' });
    this._itemsRequest = (this._itemsRequest || 0) + 1;
    await this.loadRuns();
  },

  async loadRuns() {
    if (!this.data.authorized || this.data.tab !== 'sync' || !this.data.recordDate || !this._visible) return;
    const generation = this._generation;
    const request = this._runsRequest = (this._runsRequest || 0) + 1;
    const recordDate = this.data.recordDate;
    this.setData({ runsLoading: true });
    try {
      const result = await this.callAdmin('bijingSync', 'adminListSyncRuns', this.data.showAllRuns ? {} : { recordDate });
      if (!this.isCurrent(generation) || request !== this._runsRequest || !this.data.authorized) return;
      const runs = (result.runs || []).map(presentRun);
      const activeRuns = runs.filter(run => ['running', 'interrupted'].includes(run.status));
      const active = activeRuns.find(run => run._id === this.data.runningRunId) || activeRuns.find(run => run.recordDate === recordDate)
        || (this.data.showAllRuns && activeRuns.find(run => run.mode === 'errors'));
      this.setData({ runs, runningRunId: active && active._id || '', runningRecordDate: active && active.recordDate || '' });
      if (!this._continuePaused) this.setData({ syncError: '' });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._runsRequest) this.setData({ syncError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._runsRequest) {
        this.setData({ runsLoading: false });
        this.schedulePoll();
      }
    }
  },

  schedulePoll() {
    this.clearPoll();
    if (!this._visible || !this.data.authorized || this.data.tab !== 'sync' || this._syncBusy) return;
    const activelyRunning = this.data.runningRunId && !this._continuePaused;
    this._pollTimer = setTimeout(async () => {
      this._pollTimer = null;
      if (!this._visible || !this.data.authorized || this.data.tab !== 'sync') return;
      if (this.data.runningRunId && !this._continuePaused) await this.continueSync(this.data.runningRunId);
      else await this.refreshTab();
    }, activelyRunning ? (this._workerBusy ? 10000 : 1500) : 15000);
  },

  async startSync() {
    if (this._syncBusy || !this.data.authorized || this.data.tab !== 'sync' || !this.data.recordDate || !this._visible) return;
    if (!this.data.apiConfigured) {
      this.setData({ syncError: '必经接口尚未配置，请完成服务端配置后重试。' });
      return;
    }
    this._continuePaused = false;
    if (this.data.runningRunId) return this.continueSync(this.data.runningRunId);
    await this.runSyncAction('adminStartSync', { recordDate: this.data.recordDate });
  },
  continueSync(runId) {
    return this.runSyncAction('adminContinueSync', { runId });
  },
  async runSyncAction(type, payload) {
    if (this._syncBusy || !this._visible || !this.data.authorized || this.data.tab !== 'sync') return;
    this.clearPoll();
    this._syncBusy = true;
    const generation = this._generation;
    this.setData({ syncBusy: true, syncError: '', syncMessage: '' });
    try {
      const run = await this.callAdmin('bijingSync', type, payload);
      if (!this.isCurrent(generation) || !this.data.authorized) return;
      const runId = run.runId || run._id || payload.runId;
      if (!runId && type === 'adminRetrySyncErrors') {
        await this.loadSyncErrors();
        if (!this.isCurrent(generation) || !this.data.authorized) return;
        this.setData({ syncMessage: this.data.syncErrors.length || this.data.syncErrorsError
          ? '当前没有可启动的修复任务，请查看待处理错误。' : '待处理错误已恢复，无需再次重试。' });
        await this.loadRuns();
        return;
      }
      if (!runId) throw new Error('未返回执行记录，请刷新后重试');
      this._workerBusy = run.busy === true;
      const continuing = ['running', 'interrupted'].includes(run.status);
      this.setData({ runningRunId: continuing ? runId : '', runningRecordDate: continuing ? run.recordDate || '' : '',
        syncMessage: continuing ? '正在同步并核对必经数据。离开页面后由后台继续处理。'
          : run.status === 'success' ? '同步核对完成，已恢复的记录已从待处理错误中移除。' : '本次执行已结束，请查看待处理错误及执行记录。' });
      await this.loadSyncErrors();
      await this.loadRuns();
      if (this.data.selectedRunId === runId) await this.loadItems(false);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this._continuePaused = true;
        this.setData({ syncError: `${errorText(error)}。可刷新查看结果或点击一键同步继续。` });
      }
    } finally {
      this._syncBusy = false;
      if (this._visible) {
        this.setData({ syncBusy: false });
        this.schedulePoll();
      }
    }
  },

  loadMoreSyncErrors() { return this.loadSyncErrors(true); },
  async loadSyncErrors(append = false) {
    if (!this._visible || !this.data.authorized || this.data.tab !== 'sync' || (append && (!this.data.syncErrorsCursor || this.data.syncErrorsLoading))) return;
    const generation = this._generation;
    const request = this._syncErrorsRequest = (this._syncErrorsRequest || 0) + 1;
    this.setData({ syncErrorsLoading: true, syncErrorsError: '' });
    try {
      const result = await this.callAdmin('bijingSync', 'adminListSyncErrors', append ? { cursor: this.data.syncErrorsCursor } : {});
      if (!this.isCurrent(generation) || request !== this._syncErrorsRequest || !this.data.authorized) return;
      const errors = (result.errors || []).map(item => ({ ...item, updatedText: timeText(item.updatedAt),
        actualText: item.reason !== 'missing' && Number.isFinite(item.actualDurationMinutes) ? `${item.actualDurationMinutes} 分钟` : '未查到',
        reasonText: item.error || ({ missing: '必经侧缺少记录', duration_mismatch: '必经侧时长与预期不一致',
          student_not_found: '必经侧未找到该学号' })[item.reason] || item.reason || '尚未通过最终核对' }));
      this.setData({ syncErrors: append ? this.data.syncErrors.concat(errors) : errors, syncErrorsCursor: result.nextCursor || '' });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._syncErrorsRequest) this.setData({ syncErrorsError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._syncErrorsRequest) this.setData({ syncErrorsLoading: false });
    }
  },
  async retrySyncErrors() {
    if (this._syncBusy || !this._visible || !this.data.authorized || this.data.tab !== 'sync' || !this.data.syncErrors.length) return;
    if (!this.data.apiConfigured) {
      this.setData({ syncError: '必经接口尚未配置，请完成服务端配置后重试。' });
      return;
    }
    this._continuePaused = false;
    if (this.data.runningRunId) return this.continueSync(this.data.runningRunId);
    // 修复可能属于另一个日期，使用最近记录保留该任务的续跑入口。
    this.setData({ showAllRuns: true });
    await this.runSyncAction('adminRetrySyncErrors', {});
  },

  async selectRun(event) {
    const runId = event.currentTarget.dataset.id;
    if (!this.data.runs.some(run => run._id === runId)) return;
    this._itemsRequest = (this._itemsRequest || 0) + 1;
    this.setData({ selectedRunId: this.data.selectedRunId === runId ? '' : runId, items: [], itemsError: '', itemsCursor: '', itemsLoading: false });
    if (this.data.selectedRunId) await this.loadItems(false);
  },
  loadMoreItems() { return this.loadItems(true); },
  retryItems() { return this.loadItems(false); },
  async loadItems(append) {
    if (!this.data.authorized || this.data.tab !== 'sync' || !this.data.selectedRunId || (append && (!this.data.itemsCursor || this.data.itemsLoading))) return;
    const generation = this._generation;
    const request = this._itemsRequest = (this._itemsRequest || 0) + 1;
    const runId = this.data.selectedRunId;
    this.setData({ itemsLoading: true, itemsError: '' });
    try {
      const result = await this.callAdmin('bijingSync', 'adminSyncDetails', { runId, ...(append ? { cursor: this.data.itemsCursor } : {}) });
      if (!this.isCurrent(generation) || request !== this._itemsRequest || !this.data.authorized) return;
      const items = (result.items || []).map(item => ({ ...item, statusText: STATUS_LABELS[item.status] || item.status }));
      this.setData({ items: append ? this.data.items.concat(items) : items, itemsCursor: result.nextCursor || '' });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._itemsRequest) this.setData({ itemsError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._itemsRequest) this.setData({ itemsLoading: false });
    }
  },

  loadMoreTeams() { return this.loadTeams(true); },
  async loadTeams(append = false) {
    if (!this.data.authorized || this.data.tab !== 'team' || this._teamsLoading || (append && !this.data.teamsCursor)) return;
    const generation = this._generation;
    this._teamsLoading = true;
    this.setData({ teamsLoading: true, teamsError: '' });
    try {
      const result = await this.callAdmin('teamManager', 'adminListTeams', append ? { cursor: this.data.teamsCursor } : {});
      if (!this.isCurrent(generation) || !this.data.authorized) return;
      const teams = append ? this.data.teams.concat(result.teams || []) : result.teams || [];
      const selectedId = this.data.selectedTeam && this.data.selectedTeam._id;
      const index = teams.findIndex(team => team._id === selectedId);
      this.setData({ teams, teamsCursor: result.nextCursor || '', teamIndex: index,
        selectedTeam: index >= 0 ? teams[index] : null });
      if (index < 0) this.setData({ candidates: [], candidateIndex: -1, selectedCandidate: null });
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ teamsError: errorText(error) });
    } finally {
      this._teamsLoading = false;
      if (this._visible) this.setData({ teamsLoading: false });
    }
  },
  async onTeamChange(event) {
    if (this._transferBusy) return;
    const index = Number(event.detail.value);
    const team = this.data.teams[index];
    if (!team) return;
    this.setData({ teamIndex: index, selectedTeam: team });
    await this.loadMembers();
  },
  async loadMembers() {
    if (!this.data.authorized || this.data.tab !== 'team' || !this.data.selectedTeam) return;
    const generation = this._generation;
    const request = this._membersRequest = (this._membersRequest || 0) + 1;
    const teamId = this.data.selectedTeam._id;
    this.setData({ membersLoading: true, candidates: [], candidateIndex: -1, selectedCandidate: null, teamsError: '' });
    try {
      const result = await this.callAdmin('teamManager', 'adminTeamMembers', { teamId });
      if (!this.isCurrent(generation) || request !== this._membersRequest || !this.data.authorized || !this.data.selectedTeam || this.data.selectedTeam._id !== teamId) return;
      const candidates = (result.members || []).filter(member => !member.isCreator && member.openid !== this.data.selectedTeam.creator)
        .map(member => ({ ...member, displayName: `${member.nickname || '未命名成员'} · ${member.openid.slice(-6)}` }));
      this.setData({ candidates });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._membersRequest) this.setData({ teamsError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._membersRequest) this.setData({ membersLoading: false });
    }
  },
  onCandidateChange(event) {
    if (this._transferBusy) return;
    const index = Number(event.detail.value);
    if (this.data.candidates[index]) this.setData({ candidateIndex: index, selectedCandidate: this.data.candidates[index] });
  },
  async transferLeader() {
    if (this._transferBusy || !this.data.authorized || this.data.tab !== 'team' || !this.data.selectedTeam || !this.data.selectedCandidate) return;
    this._transferBusy = true;
    this.setData({ transferBusy: true, teamsError: '' });
    const generation = this._generation;
    const team = this.data.selectedTeam;
    const member = this.data.selectedCandidate;
    try {
      const confirmed = await new Promise((resolve, reject) => wx.showModal({ title: '确认更换团长',
        content: `将「${team.name}」的团长由「${team.creatorName || '未命名成员'}」更换为「${member.nickname || '未命名成员'}」？原团长将保留为团队成员。`,
        confirmText: '确认更换', confirmColor: '#8c7345', success: result => resolve(result.confirm), fail: reject }));
      if (!confirmed || !this.isCurrent(generation)) return;
      await this.callAdmin('teamManager', 'adminTransferLeader', { teamId: team._id, newLeaderOpenid: member.openid, expectedLeaderOpenid: team.creator });
      if (!this.isCurrent(generation)) return;
      wx.showToast({ title: '团长已更换', icon: 'success' });
      await this.loadTeams();
      if (this.data.selectedTeam) await this.loadMembers();
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ teamsError: errorText(error) });
    } finally {
      this._transferBusy = false;
      if (this._visible) this.setData({ transferBusy: false });
    }
  },

  loadMoreLogs() { return this.loadLogs(true); },
  async loadLogs(append = false) {
    if (!this.data.authorized || this.data.tab !== 'audit' || this._logsLoading || (append && !this.data.logsCursor)) return;
    const generation = this._generation;
    this._logsLoading = true;
    this.setData({ logsLoading: true, logsError: '' });
    try {
      const result = await this.callAdmin('teamManager', 'adminAuditLogs', append ? { cursor: this.data.logsCursor } : {});
      if (!this.isCurrent(generation) || !this.data.authorized) return;
      const logs = (result.logs || []).map(log => ({ ...log, createdText: timeText(log.createdAt) }));
      this.setData({ logs: append ? this.data.logs.concat(logs) : logs, logsCursor: result.nextCursor || '' });
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ logsError: errorText(error) });
    } finally {
      this._logsLoading = false;
      if (this._visible) this.setData({ logsLoading: false });
    }
  }
});
