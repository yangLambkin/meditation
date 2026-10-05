const cloudApi = require('../../utils/cloudApi.js');
const checkinManager = require('../../utils/checkin.js');
const dateUtil = require('../../utils/dateUtil.js');
const bijingRecordSync = require('../../utils/bijingRecordSync.js');

const LABELS = { pending: '待审批', approved: '已通过', rejected: '未通过' };
function account() { return wx.getStorageSync('userOpenId') || ''; }
function timeValue(value) {
  const raw = value && value.$date !== undefined ? value.$date : value;
  return raw === null || raw === undefined || raw === '' || typeof raw === 'boolean' ? NaN : new Date(raw).getTime();
}
function timeText(value) {
  const time = timeValue(value);
  return value && Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
}
function rangeHint(startDate, endDate, today = dateUtil.getBusinessDate()) {
  if (!dateUtil.isDateLabel(startDate) || !dateUtil.isDateLabel(endDate) ||
      endDate < startDate || startDate < dateUtil.addBusinessDays(today, -30) || endDate >= today) {
    return { rangeDays: 0 };
  }
  const rangeDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / dateUtil.DAY_MS + 1;
  return { rangeDays };
}
function dateBounds(today) {
  const earliest = dateUtil.addBusinessDays(today, -30);
  return { maxEndDate: dateUtil.addBusinessDays(today, -1), minEndDate: earliest, minStartDate: earliest };
}
function present(row) {
  const expired = row.expired === true || (Number.isFinite(timeValue(row.expiresAt)) && timeValue(row.expiresAt) <= Date.now());
  return { ...row, expired, canRecord: row.status === 'approved' && row.canRecord === true && !expired,
    statusText: expired && row.status !== 'rejected' ? '已过期' : LABELS[row.status] || '待审批',
    createdText: timeText(row.createdAt), updatedText: timeText(row.updatedAt), expiresText: timeText(row.expiresAt) };
}
function hasActiveRequest(rows) { return rows.some(row => (row.status === 'pending' || row.canRecord) && !row.expired); }
function message(error) { return error && (error.message || error.errMsg) || '暂时无法连接，请稍后重试'; }
function uniqueId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`; }
function syncVersion(task) { return task ? JSON.stringify([task.recordId, task.revision, task.completedRevision, task.status, task.message]) : ''; }
function taskIsSyncing(task) { return !!(task && ['pending', 'syncing'].includes(task.status)); }
function taskRecordExists(task, records) { return !!(task && records.some(record => record._id === task.recordId)); }
function recordsVersion(records) { return JSON.stringify(records.map(record => [record._id, Number(record.duration) || 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))); }
function begin(operation) {
  Object.assign(operation, { pending: true, result: null, error: '' });
  operation.completion = new Promise(resolve => { operation.finish = resolve; });
}
function refreshAlerts(owner) {
  try {
    if (!owner || owner !== account()) return;
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.refreshSyncAlert === 'function') Promise.resolve(app.refreshSyncAlert({ force: true })).catch(() => {});
  } catch (_) {}
}
function clearedDayRecords() {
  return { selectedRequest: null, recordDate: '', dayRecords: [], dayTotal: 0,
    dayLoaded: false, dayLoading: false, dayError: '',
    syncMessage: '', syncError: '', syncBusy: false, canSyncDay: false,
    bijingTaskStatus: '', bijingTaskText: '', bijingCanRetry: false, bijingSyncing: false };
}

Page({
  data: {
    loggedIn: false, tab: 'mine', isAdmin: false, accessLoading: false, accessError: '',
    startDate: '', endDate: '', reason: '', maxEndDate: '', minEndDate: '', minStartDate: '',
    rangeDays: 0,
    submitting: false, submitError: '', activeRequest: false,
    requests: [], nextCursor: '', loading: false, loaded: false, listError: '',
    adminRequests: [], adminCursor: '', adminLoading: false, adminLoaded: false, adminError: '', adminFilter: 'pending',
    filters: [{ value: 'pending', label: '待审批' }, { value: 'approved', label: '已通过' },
      { value: 'rejected', label: '未通过' }, { value: 'all', label: '全部' }],
    reviewRequest: null, reviewReply: '', reviewing: false, reviewError: '',
    ...clearedDayRecords()
  },
  onLoad(options = {}) { this._initialTab = options.tab === 'review' ? 'review' : 'mine'; },
  async onShow() {
    const owner = account();
    if (this._account !== undefined && this._account !== owner) {
      this._submission = null; this._review = null;
      this._manualDaySync = new Map();
      this.setData({ startDate: '', endDate: '', reason: '', tab: 'mine', reviewReply: '', ...rangeHint('', '') });
    }
    this._account = owner;
    if (!this._manualDaySync) this._manualDaySync = new Map();
    this._visible = true;
    const generation = this._generation = (this._generation || 0) + 1;
    const today = dateUtil.getBusinessDate();
    this.setData({ loggedIn: checkinManager.isUserLoggedIn(), tab: this._initialTab === 'review' ? 'review' : this.data.tab, isAdmin: false, accessError: '',
      ...dateBounds(today),
      ...rangeHint(this.data.startDate, this.data.endDate, today),
      requests: [], nextCursor: '', loading: false, loaded: false, listError: '', activeRequest: false,
      adminRequests: [], adminCursor: '', adminLoading: false, adminLoaded: false, adminError: '',
      reviewRequest: null, reviewReply: '', reviewError: '',
      submitting: !!(this._submission && this._submission.pending), reviewing: !!(this._review && this._review.pending),
      ...clearedDayRecords() });
    this.watchBijingTask();
    this.watchDateRange();
    this.scheduleExpiration();
    this.applySubmission();
    this.applyReview();
    this.observePendingOperations(generation);
    if (this.data.loggedIn) await Promise.all([this.loadRequests(), this.checkAccess()]);
  },
  onHide() { this.stopPage(); },
  onUnload() { this.stopPage(); },
  stopPage() {
    this.clearExpirationTimer();
    if (this._stopBusinessDate) this._stopBusinessDate();
    this._stopBusinessDate = null;
    if (this._stopBijingTask) this._stopBijingTask();
    this._stopBijingTask = null;
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.setData({ requests: [], adminRequests: [], reviewRequest: null, reviewReply: '', ...clearedDayRecords() });
  },
  isCurrent(generation) { return this._visible && generation === this._generation && this._account === account(); },
  clearExpirationTimer() {
    if (this._expirationTimer !== undefined && this._expirationTimer !== null) clearTimeout(this._expirationTimer);
    this._expirationTimer = null;
    this._expirationToken = (this._expirationToken || 0) + 1;
  },
  scheduleExpiration() {
    this.clearExpirationTimer();
    if (!this.isCurrent(this._generation)) return;
    const rows = [...this.data.requests, ...this.data.adminRequests, this.data.selectedRequest, this.data.reviewRequest];
    const deadlines = rows.filter(row => row && !row.expired && ['pending', 'approved'].includes(row.status))
      .map(row => timeValue(row.expiresAt)).filter(Number.isFinite);
    if (!deadlines.length) return;
    const generation = this._generation, token = this._expirationToken;
    const delay = Math.min(2147483647, Math.max(0, Math.min(...deadlines) - Date.now()));
    this._expirationTimer = setTimeout(() => {
      if (!this.isCurrent(generation) || token !== this._expirationToken) return;
      this._expirationTimer = null;
      this.refreshExpirations();
    }, delay);
  },
  refreshExpirations() {
    if (!this.isCurrent(this._generation)) return;
    const requests = this.data.requests.map(present);
    this.setData({ requests, adminRequests: this.data.adminRequests.map(present),
      selectedRequest: this.data.selectedRequest ? present(this.data.selectedRequest) : null,
      reviewRequest: this.data.reviewRequest ? present(this.data.reviewRequest) : null,
      activeRequest: hasActiveRequest(requests) });
    this.scheduleExpiration();
  },
  watchDateRange() {
    if (this._stopBusinessDate) this._stopBusinessDate();
    const generation = this._generation;
    this._stopBusinessDate = dateUtil.watchBusinessDate(today => {
      if (!this.isCurrent(generation)) return;
      this.setData({ ...dateBounds(today), ...rangeHint(this.data.startDate, this.data.endDate, today) });
    });
  },
  watchBijingTask() {
    if (this._stopBijingTask) this._stopBijingTask();
    this._stopBijingTask = null;
    if (!this.data.loggedIn) return;
    const generation = this._generation, owner = this._account;
    this._stopBijingTask = bijingRecordSync.subscribe(change => {
      if (change && change.account && change.account !== owner) return;
      if (this.isCurrent(generation)) this.refreshBijingTask();
    });
  },
  refreshBijingTask() {
    if (!this.isCurrent(this._generation) || !this.data.selectedRequest) return;
    const task = bijingRecordSync.getDayState(this.data.recordDate, this._account);
    const key = `${this.data.selectedRequest._id}:${this.data.recordDate}`;
    const manual = this._manualDaySync && this._manualDaySync.get(key);
    if (manual && manual.version === syncVersion(task) && (!this.data.dayLoaded || manual.recordsVersion === recordsVersion(this.data.dayRecords))) {
      this.setData({ bijingTaskStatus: manual.status, bijingTaskText: '', bijingCanRetry: false, bijingSyncing: false,
        syncMessage: manual.syncMessage, syncError: manual.syncError });
      return;
    }
    if (manual) this._manualDaySync.delete(key);
    const hasTaskRecord = this.data.dayLoaded && taskRecordExists(task, this.data.dayRecords);
    const missingTaskRecord = task && this.data.dayLoaded && !hasTaskRecord && this.data.canSyncDay && !taskIsSyncing(task);
    this.setData({ bijingTaskStatus: task ? task.status : '',
      bijingTaskText: missingTaskRecord ? '当天记录已变更，可重新同步当天记录。' : task ? task.message || '记录已保存，必经同步待处理' : '',
      bijingCanRetry: !!(task && task.canRetry && hasTaskRecord && !taskIsSyncing(task)), bijingSyncing: taskIsSyncing(task),
      syncMessage: '', syncError: '' });
  },
  observePendingOperations(generation) {
    for (const kind of ['_submission', '_review']) {
      const operation = this[kind];
      if (!operation || !operation.pending || !operation.completion) continue;
      // A newly shown page explicitly takes responsibility for displaying a pending result.
      // The old page generation never writes into the newly rendered form.
      operation.completion.then(async () => {
        if (!this.isCurrent(generation) || this[kind] !== operation || operation.account !== this._account) return;
        if (kind === '_submission') { this.applySubmission(); if (operation.result) await this.loadRequests(); }
        else { this.applyReview(); if (operation.result) await this.loadAdminRequests(); }
      }).catch(() => {});
    }
  },
  login() { wx.navigateTo({ url: `/pages/profile/profile?fromPage=${encodeURIComponent('/pages/backfill/backfill')}` }); },
  async call(functionName, type, data = {}) {
    const response = await cloudApi.callCloudFunction(functionName, { type, ...data });
    const result = response && response.result;
    if (!result || result.success !== true) {
      const error = new Error(result && result.error || '云端尚未确认，请重试');
      error.code = result && result.code;
      throw error;
    }
    return result.data === undefined ? {} : result.data;
  },
  async online() {
    const generation = this._generation;
    await new Promise((resolve, reject) => {
      if (typeof wx.getNetworkType !== 'function') { reject(new Error('请联网后再操作')); return; }
      wx.getNetworkType({ success: result => result && result.networkType && !['none', 'unknown'].includes(result.networkType)
        ? resolve() : reject(new Error('请联网后再操作，补录不会离线保存')), fail: () => reject(new Error('无法确认网络状态，请联网后重试')) });
    });
    if (!this.isCurrent(generation) || !checkinManager.isUserLoggedIn()) throw new Error('页面或登录状态已变化，请重新操作');
  },
  async checkAccess() {
    if (!this.isCurrent(this._generation) || !this.data.loggedIn) return;
    const generation = this._generation;
    this.setData({ accessLoading: true, accessError: '' });
    try {
      const result = await this.call('adminManager', 'getAccess');
      if (!this.isCurrent(generation)) return;
      this.setData({ isAdmin: result.isAdmin === true });
      if (result.isAdmin === true && (this.data.tab === 'review' || this._initialTab === 'review')) {
        this._initialTab = 'mine';
        this.setData({ tab: 'review' });
        await this.loadAdminRequests();
      } else if (result.isAdmin !== true && this.data.tab !== 'mine') this.setData({ tab: 'mine' }, () => this.markRead(this.data.requests, generation, this._listToken));
    } catch (error) {
      if (this.isCurrent(generation)) this.setData({ accessError: message(error), tab: 'mine' });
    } finally {
      if (this.isCurrent(generation)) this.setData({ accessLoading: false });
    }
  },
  async switchTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!this.isCurrent(this._generation) || !['mine', 'review'].includes(tab) || tab === this.data.tab || (tab === 'review' && !this.data.isAdmin)) return;
    this.setData({ tab, reviewRequest: null, reviewReply: '', reviewError: '', ...clearedDayRecords() });
    this.scheduleExpiration();
    if (tab === 'review') await this.loadAdminRequests();
    else await this.loadRequests();
  },
  onStartChange(event) {
    if (!this.data.submitting) this.setData({ startDate: event.detail.value, submitError: '', ...rangeHint(event.detail.value, this.data.endDate) });
  },
  onEndChange(event) {
    if (!this.data.submitting) this.setData({ endDate: event.detail.value, submitError: '', ...rangeHint(this.data.startDate, event.detail.value) });
  },
  onReasonInput(event) { if (!this.data.submitting) this.setData({ reason: event.detail.value, submitError: '' }); },
  async submitRequest() {
    if (!this.isCurrent(this._generation) || this.data.submitting) return;
    if (!this.data.loggedIn) { this.login(); return; }
    const generation = this._generation;
    const { startDate, endDate } = this.data;
    const reason = this.data.reason.trim();
    const today = dateUtil.getBusinessDate();
    let error = '';
    if (!dateUtil.isDateLabel(startDate) || !dateUtil.isDateLabel(endDate)) error = '请选择补录开始和结束日期';
    else if (endDate < startDate || endDate > dateUtil.addBusinessDays(startDate, 29)) error = '一次申请最多连续 30 天，结束日期不能早于开始日期';
    else if (startDate < dateUtil.addBusinessDays(today, -30) || endDate >= today) {
      error = `可申请日期为 ${dateUtil.addBusinessDays(today, -30)} 至 ${dateUtil.addBusinessDays(today, -1)}，请选择今天之前最近 30 天内的日期`;
    }
    else if (!reason || reason.length > 500) error = '请填写 1–500 字的补录原因';
    else if (this.data.activeRequest) error = '已有待审批或有效申请，请先完成现有申请';
    if (error) { this.setData({ submitError: error, ...rangeHint(startDate, endDate, today) }); return; }
    const signature = JSON.stringify({ startDate, endDate, reason });
    const previous = this._submission;
    const operation = previous && previous.account === this._account && previous.signature === signature ? previous
      : { account: this._account, signature, requestId: uniqueId('backfill') };
    begin(operation);
    this._submission = operation;
    this.setData({ submitting: true, submitError: '' });
    try {
      await this.online();
      if (!this.isCurrent(generation) || this._submission !== operation) throw new Error('页面或登录状态已变化，请重新操作');
      const result = await this.call('meditationManager', 'submitBackfillRequest', { requestId: operation.requestId, startDate, endDate, reason });
      if (!result.request || !result.request._id) throw new Error('未收到申请提交确认，请重试');
      operation.result = result.request;
      refreshAlerts(operation.account);
    } catch (error) { operation.error = message(error); }
    finally {
      operation.pending = false;
      operation.finish();
      if (this._submission === operation && this.isCurrent(generation)) {
        this.applySubmission();
        if (operation.result) await this.loadRequests();
      }
    }
  },
  applySubmission() {
    const operation = this._submission;
    if (!operation || operation.pending || operation.account !== this._account || !this.isCurrent(this._generation)) return;
    if (operation.result) {
      this._submission = null;
      const request = present(operation.result);
      const requests = [request, ...this.data.requests.filter(row => row._id !== request._id)];
      this.setData({ submitting: false, submitError: '', startDate: '', endDate: '', reason: '', requests,
        activeRequest: hasActiveRequest(requests), ...rangeHint('', '') });
      this.scheduleExpiration();
      wx.showToast({ title: '申请已提交，待审批', icon: 'none' });
    } else this.setData({ submitting: false, submitError: operation.error });
  },
  async loadRequests(append = false) {
    append = append === true;
    if (!this.isCurrent(this._generation) || !this.data.loggedIn || (append && (this.data.loading || !this.data.nextCursor))) return;
    const generation = this._generation, token = this._listToken = (this._listToken || 0) + 1;
    this.setData({ loading: true, listError: '' });
    try {
      const result = await this.call('meditationManager', 'getMyBackfillRequests', append ? { cursor: this.data.nextCursor } : {});
      if (!this.isCurrent(generation) || token !== this._listToken) return;
      if (!Array.isArray(result.requests)) throw new Error('未能读取申请，请重试');
      const rows = result.requests.map(present);
      const requests = append ? this.data.requests.concat(rows).filter((row, i, all) => all.findIndex(other => other._id === row._id) === i) : rows;
      const displayed = rows.filter(row => requests.includes(row));
      this.setData({ requests, nextCursor: result.nextCursor || '', loaded: true,
        activeRequest: hasActiveRequest(requests) }, () => {
        this.markRead(displayed, generation, token);
      });
      this.scheduleExpiration();
    } catch (error) {
      if (this.isCurrent(generation) && token === this._listToken) this.setData({ listError: message(error) });
    } finally {
      if (this.isCurrent(generation) && token === this._listToken) this.setData({ loading: false });
    }
  },
  async markRead(rows, generation, token) {
    if (!this.isCurrent(generation) || token !== this._listToken || this.data.tab !== 'mine') return;
    const requests = rows.filter(row => row.unreadForUser === true).map(row => ({ requestId: row._id, expectedUpdatedAt: row.updatedAt }));
    if (!requests.length) return;
    const owner = this._account;
    try {
      const result = await this.call('meditationManager', 'markBackfillRead', { requests });
      if (Number.isInteger(result.markedCount) && result.markedCount >= 0) refreshAlerts(owner);
    } catch (_) {}
  },
  loadMoreRequests() { return this.loadRequests(true); },
  async loadAdminRequests(append = false) {
    append = append === true;
    if (!this.isCurrent(this._generation) || !this.data.isAdmin || this.data.tab !== 'review' ||
        (append && (this.data.adminLoading || !this.data.adminCursor))) return;
    const generation = this._generation, token = this._adminToken = (this._adminToken || 0) + 1;
    const status = this.data.adminFilter;
    this.setData({ adminLoading: true, adminError: '' });
    try {
      const result = await this.call('adminManager', 'adminListBackfillRequests', { status, ...(append ? { cursor: this.data.adminCursor } : {}) });
      if (!this.isCurrent(generation) || token !== this._adminToken || this.data.tab !== 'review') return;
      if (!Array.isArray(result.requests)) throw new Error('未能读取待审批申请，请重试');
      const rows = result.requests.map(present);
      const adminRequests = append ? this.data.adminRequests.concat(rows).filter((row, i, all) => all.findIndex(other => other._id === row._id) === i) : rows;
      this.setData({ adminRequests, adminCursor: result.nextCursor || '', adminLoaded: true });
      this.scheduleExpiration();
    } catch (error) {
      if (this.isCurrent(generation) && token === this._adminToken && this.data.tab === 'review') {
        this.setData({ adminError: message(error) });
        if (['FORBIDDEN', 'UNAUTHORIZED', 'ADMIN_REQUIRED'].includes(error.code)) this.setData({ isAdmin: false, adminRequests: [], reviewRequest: null, reviewReply: '', tab: 'mine' });
      }
    } finally {
      if (this.isCurrent(generation) && token === this._adminToken) this.setData({ adminLoading: false });
    }
  },
  async changeFilter(event) {
    const status = event.currentTarget.dataset.status;
    if (!this.isCurrent(this._generation) || !this.data.isAdmin || this.data.reviewing || !['pending', 'approved', 'rejected', 'all'].includes(status)) return;
    this.setData({ adminFilter: status, adminRequests: [], adminCursor: '', adminLoaded: false, reviewRequest: null, reviewReply: '', reviewError: '' });
    this.scheduleExpiration();
    await this.loadAdminRequests();
  },
  loadMoreAdminRequests() { return this.loadAdminRequests(true); },
  selectReview(event) {
    if (!this.isCurrent(this._generation) || !this.data.isAdmin || this.data.reviewing) return;
    const row = this.data.adminRequests.find(item => item._id === event.currentTarget.dataset.id);
    if (row && row.status === 'pending' && !present(row).expired) this.setData({ reviewRequest: present(row), reviewReply: '', reviewError: '' });
  },
  closeReview() { if (!this.data.reviewing) this.setData({ reviewRequest: null, reviewReply: '', reviewError: '' }); },
  onReplyInput(event) { if (!this.data.reviewing) this.setData({ reviewReply: event.detail.value, reviewError: '' }); },
  async reviewRequest(event) {
    if (!this.isCurrent(this._generation) || !this.data.isAdmin || this.data.reviewing || !this.data.reviewRequest) return;
    const generation = this._generation;
    const status = event.currentTarget.dataset.status;
    if (!['approved', 'rejected'].includes(status)) return;
    const row = present(this.data.reviewRequest), reply = this.data.reviewReply.trim();
    if (reply.length > 500 || (status === 'rejected' && !reply)) { this.setData({ reviewError: '拒绝时请填写原因，回复最多 500 字' }); return; }
    if (row.expired) { this.setData({ reviewError: '申请已过补录期限，不能继续审批' }); return; }
    const operation = { account: this._account, requestId: row._id };
    begin(operation);
    this._review = operation;
    this.setData({ reviewing: true, reviewError: '' });
    try {
      await this.online();
      if (!this.isCurrent(generation) || this._review !== operation) throw new Error('页面或登录状态已变化，请重新操作');
      const result = await this.call('adminManager', 'adminReviewBackfillRequest', { requestId: row._id, expectedUpdatedAt: row.updatedAt, status, reply });
      if (!result.request || result.request._id !== row._id || result.request.status !== status) throw new Error('未收到审批完成确认，请刷新申请后重试');
      operation.result = result.request;
      refreshAlerts(operation.account);
    } catch (error) { operation.error = message(error); }
    finally {
      operation.pending = false;
      operation.finish();
      if (this._review === operation && this.isCurrent(generation)) {
        this.applyReview();
        if (operation.result) await this.loadAdminRequests();
      }
    }
  },
  applyReview() {
    const operation = this._review;
    if (!operation || operation.pending || operation.account !== this._account || !this.isCurrent(this._generation)) return;
    if (operation.result) {
      this._review = null;
      this.setData({ reviewing: false, reviewRequest: null, reviewReply: '', reviewError: '' });
      wx.showToast({ title: operation.result.status === 'approved' ? '已批准，已通知申请人' : '已拒绝，已通知申请人', icon: 'none' });
    } else this.setData({ reviewing: false, reviewError: operation.error });
  },
  goHomeRecord(event) {
    const generation = this._generation;
    if (!this.isCurrent(generation) || !this.data.loggedIn || this.data.syncBusy) return;
    const row = this.data.requests.find(item => item._id === event.currentTarget.dataset.id);
    if (!row) return;
    const request = present(row);
    if (!request.canRecord) {
      if (request.expired) {
        this.refreshExpirations();
        wx.showToast({ title: '补录期限已结束，请重新申请', icon: 'none' });
      }
      return;
    }
    const intent = { account: this._account, requestId: row._id, date: row.startDate };
    const failed = () => {
      try {
        const saved = wx.getStorageSync('homeBackfillIntent');
        if (saved && saved.account === intent.account && saved.requestId === intent.requestId && saved.date === intent.date) {
          wx.removeStorageSync('homeBackfillIntent');
        }
      } catch (_) {}
      if (this.isCurrent(generation)) wx.showToast({ title: '暂时无法打开首页，请重试', icon: 'none' });
    };
    try {
      wx.setStorageSync('homeBackfillIntent', intent);
      wx.switchTab({ url: '/pages/index/index', fail: failed });
    } catch (_) { failed(); }
  },
  async openDayRecords(event) {
    if (!this.isCurrent(this._generation) || this.data.syncBusy) return;
    const row = this.data.requests.find(item => item._id === event.currentTarget.dataset.id);
    if (!row || row.status !== 'approved') return;
    this.setData({ ...clearedDayRecords(), selectedRequest: present(row), recordDate: row.startDate });
    this.refreshBijingTask();
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    await this.loadDayRecords();
  },
  closeDayRecords() { if (!this.data.syncBusy) { this._dayToken = (this._dayToken || 0) + 1; this.setData(clearedDayRecords()); } },
  async onRecordDateChange(event) {
    if (!this.isCurrent(this._generation) || this.data.syncBusy || !this.data.selectedRequest) return;
    const date = event.detail.value, row = this.data.selectedRequest;
    if (!dateUtil.isDateLabel(date) || date < row.startDate || date > row.endDate) return;
    this.setData({ recordDate: date, dayRecords: [], dayTotal: 0, dayLoaded: false, canSyncDay: false,
      syncError: '', syncMessage: '' });
    this.refreshBijingTask();
    await this.loadDayRecords();
  },
  async loadDayRecords() {
    if (!this.isCurrent(this._generation) || !this.data.selectedRequest) return;
    const generation = this._generation, token = this._dayToken = (this._dayToken || 0) + 1;
    const date = this.data.recordDate, requestId = this.data.selectedRequest._id;
    this.refreshBijingTask();
    this.setData({ dayLoading: true, dayError: '', dayLoaded: false, canSyncDay: false });
    try {
      const records = await this.call('meditationManager', 'getUserRecords', { date });
      if (!this.isCurrent(generation) || token !== this._dayToken || !this.data.selectedRequest || this.data.selectedRequest._id !== requestId || this.data.recordDate !== date) return;
      if (!Array.isArray(records)) throw new Error('当天记录未读取成功，请重试');
      const dayRecords = records.map(row => ({ ...row, timeText: timeText(row.timestamp), isBackfill: !!row.backfillRequestId }));
      this.setData({ dayRecords, dayTotal: records.reduce((sum, row) => sum + (Number(row.duration) || 0), 0), dayLoaded: true,
        selectedRequest: present(this.data.selectedRequest), canSyncDay: records.some(row => row.backfillRequestId === requestId) ||
          (Array.isArray(this.data.selectedRequest.recordedDates) && this.data.selectedRequest.recordedDates.includes(date)) });
      this.refreshBijingTask();
    } catch (error) {
      if (this.isCurrent(generation) && token === this._dayToken) this.setData({ dayError: message(error) });
    } finally {
      if (this.isCurrent(generation) && token === this._dayToken) this.setData({ dayLoading: false });
    }
  },
  syncApprovedDay() { return this.syncDay(true); },
  async syncDay(approvedOnly = false) {
    if (!this.isCurrent(this._generation) || this.data.syncBusy || !this.data.selectedRequest || !this.data.dayLoaded || this.data.dayLoading) return;
    const generation = this._generation, owner = this._account, row = this.data.selectedRequest, date = this.data.recordDate;
    const task = bijingRecordSync.getDayState(date, owner);
    const forceApproved = approvedOnly === true;
    if (taskIsSyncing(task) || (forceApproved && !this.data.canSyncDay)) return;
    // A deleted record cannot anchor syncRecordedDate; the approved-day endpoint also supports a zero total.
    if (!forceApproved && task && task.canRetry && taskRecordExists(task, this.data.dayRecords)) {
      this.setData({ syncBusy: true, syncError: '', syncMessage: '' });
      try { await bijingRecordSync.retryDate(date); }
      catch (error) {
        if (this.isCurrent(generation)) this.setData({ syncError: `记录已保存到云端，必经同步未完成：${message(error)}` });
      } finally {
        if (this.isCurrent(generation) && this.data.selectedRequest && this.data.selectedRequest._id === row._id && this.data.recordDate === date) {
          this.setData({ syncBusy: false });
          this.refreshBijingTask();
        }
      }
      return;
    }
    if (!this.data.canSyncDay) return;
    const key = `${row._id}:${date}`;
    this.setData({ syncBusy: true, syncError: '', syncMessage: '' });
    try {
      await this.online();
      if (!this.isCurrent(generation) || owner !== account()) throw new Error('页面或登录状态已变化，请重新操作');
      if (taskIsSyncing(bijingRecordSync.getDayState(date, owner))) return;
      const result = await this.call('bijingSync', 'syncBackfillDate', { requestId: row._id, recordDate: date, expectedOpenid: owner });
      if (!this.isCurrent(generation) || !this.data.selectedRequest || this.data.selectedRequest._id !== row._id || this.data.recordDate !== date) return;
      if (result.skipped === true && result.reason === '未绑定') this._manualDaySync.set(key, {
        version: syncVersion(bijingRecordSync.getDayState(date, owner)), recordsVersion: recordsVersion(this.data.dayRecords), status: 'unbound', syncError: '',
        syncMessage: '补录已保存在小程序。绑定必经账号后，可在这里同步当天记录。' });
      else if (result.success === true) this._manualDaySync.set(key, {
        version: syncVersion(bijingRecordSync.getDayState(date, owner)), recordsVersion: recordsVersion(this.data.dayRecords), status: 'synced', syncError: '', syncMessage: '当天记录已同步到必经。' });
      else throw new Error('未收到必经同步确认，请重试同步');
    } catch (error) {
      if (this.isCurrent(generation)) this._manualDaySync.set(key, {
        version: syncVersion(bijingRecordSync.getDayState(date, owner)), recordsVersion: recordsVersion(this.data.dayRecords), status: 'failed', syncMessage: '',
        syncError: `补录已保存在小程序，必经同步未完成：${message(error)}` });
    } finally {
      if (this.isCurrent(generation)) { this.setData({ syncBusy: false }); this.refreshBijingTask(); }
    }
  },
  async onPullDownRefresh() {
    try {
      if (this.data.tab === 'review') await this.loadAdminRequests();
      else { await this.loadRequests(); if (this.data.selectedRequest) await this.loadDayRecords(); }
    } finally { wx.stopPullDownRefresh(); }
  },
  onReachBottom() { return this.data.tab === 'review' ? this.loadMoreAdminRequests() : this.loadMoreRequests(); }
});
