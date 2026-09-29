const cloudApi = require('../../utils/cloudApi.js');
const checkinManager = require('../../utils/checkin.js');

const STATUS_LABELS = { pending: '待处理', processing: '处理中', resolved: '已处理' };
function timeText(value) {
  const time = new Date(value && value.$date !== undefined ? value.$date : value).getTime();
  return value && Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
}
function presentFeedback(row) {
  return { ...row, statusText: STATUS_LABELS[row.status] || '待处理',
    createdText: timeText(row.createdAt), updatedText: timeText(row.updatedAt) };
}
function errorText(error) { return error && (error.message || error.errMsg) || '暂时无法连接，请稍后重试'; }

Page({
  data: {
    loggedIn: false, content: '', contact: '', canSubmit: false, submitting: false, submitError: '',
    feedbacks: [], nextCursor: '', loading: false, loaded: false, listError: ''
  },

  async onShow() {
    const account = wx.getStorageSync('userOpenId') || '';
    if (this._account !== undefined && this._account !== account) {
      // Keep a visitor's draft when returning from login; never carry another account's draft.
      if (this._wasLoggedIn) this.setData({ content: '', contact: '', canSubmit: false });
      this._submission = null;
    }
    this._account = account;
    this._wasLoggedIn = checkinManager.isUserLoggedIn();
    this._visible = true;
    this._generation = (this._generation || 0) + 1;
    this.setData({ loggedIn: this._wasLoggedIn, feedbacks: [], nextCursor: '',
      loading: false, loaded: false, listError: '', submitError: '', submitting: !!(this._submission && this._submission.pending) });
    this.applySubmissionResult();
    if (this.data.loggedIn) await this.loadFeedback();
  },

  onHide() { this.stopPage(); },
  onUnload() { this.stopPage(); },
  stopPage() {
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.setData({ feedbacks: [], nextCursor: '', loading: false, loaded: false, listError: '' });
  },
  isCurrent(generation) {
    return this._visible && generation === this._generation && this._account === (wx.getStorageSync('userOpenId') || '');
  },
  login() { wx.navigateTo({ url: `/pages/profile/profile?fromPage=${encodeURIComponent('/pages/feedback/feedback')}` }); },
  onContentInput(event) {
    if (this.data.submitting) return;
    const content = event.detail.value;
    this.setData({ content, canSubmit: !!content.trim() && content.trim().length <= 1000, submitError: '' });
  },
  onContactInput(event) {
    if (!this.data.submitting) this.setData({ contact: event.detail.value, submitError: '' });
  },

  async callFeedback(type, data = {}) {
    const response = await cloudApi.callCloudFunction('meditationManager', { type, ...data });
    const result = response && response.result;
    if (!result || result.success !== true) {
      const error = new Error(result && result.error || '服务未返回有效结果，请重试');
      error.code = result && result.code;
      throw error;
    }
    return result.data || {};
  },

  async submitFeedback() {
    if (!this.isCurrent(this._generation) || this.data.submitting) return;
    if (!checkinManager.isUserLoggedIn()) { this.login(); return; }
    const content = this.data.content.trim();
    const contact = this.data.contact.trim();
    if (!content || content.length > 1000 || contact.length > 100) {
      this.setData({ submitError: !content ? '请填写反馈内容' : content.length > 1000 ? '反馈内容不能超过 1000 字' : '联系方式不能超过 100 字' });
      return;
    }
    const previous = this._submission;
    // Retry an uncertain request with the same ID, so a lost response cannot create duplicates.
    const operation = previous && previous.account === this._account && previous.content === content && previous.contact === contact
      ? previous : { account: this._account, content, contact,
        requestId: `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 12)}` };
    operation.pending = true;
    operation.result = null;
    operation.error = '';
    this._submission = operation;
    this.setData({ submitting: true, submitError: '' });
    try {
      const result = await this.callFeedback('submitFeedback', { content, contact, requestId: operation.requestId });
      if (!result.feedback || !result.feedback._id) throw new Error('未收到提交确认，请重试');
      operation.result = result.feedback;
    } catch (error) {
      operation.error = errorText(error);
    } finally {
      operation.pending = false;
      if (this._submission === operation && this.isCurrent(this._generation)) {
        this.applySubmissionResult();
        if (operation.result) await this.loadFeedback();
      }
    }
  },

  applySubmissionResult() {
    const operation = this._submission;
    if (!operation || operation.pending || operation.account !== this._account || !this.isCurrent(this._generation)) return;
    if (operation.result) {
      this.setData({ submitting: false, submitError: '', content: '', contact: '', canSubmit: false });
      this._submission = null;
      wx.showToast({ title: '反馈已提交', icon: 'success' });
    } else this.setData({ submitting: false, submitError: operation.error || '' });
  },

  async loadFeedback(append = false) {
    append = append === true;
    if (!this.isCurrent(this._generation) || !this.data.loggedIn || (append && (this.data.loading || !this.data.nextCursor))) return;
    const generation = this._generation;
    const request = this._listRequest = (this._listRequest || 0) + 1;
    this.setData({ loading: true, listError: '' });
    try {
      const result = await this.callFeedback('getMyFeedback', append ? { cursor: this.data.nextCursor } : {});
      if (!this.isCurrent(generation) || request !== this._listRequest) return;
      if (!Array.isArray(result.feedbacks)) throw new Error('未能读取反馈记录，请重试');
      const rows = result.feedbacks.map(presentFeedback);
      const feedbacks = append ? this.data.feedbacks.concat(rows).filter((row, i, all) => all.findIndex(other => other._id === row._id) === i) : rows;
      // Pagination can include a duplicate whose newer version was not displayed.
      const displayedRows = rows.filter(row => feedbacks.includes(row));
      this.setData({ feedbacks, nextCursor: result.nextCursor || '', loaded: true }, () => {
        this.markDisplayedFeedbackRead(displayedRows, generation, request);
      });
    } catch (error) {
      if (this.isCurrent(generation) && request === this._listRequest) this.setData({ listError: errorText(error) });
    } finally {
      if (this.isCurrent(generation) && request === this._listRequest) this.setData({ loading: false });
    }
  },
  async markDisplayedFeedbackRead(rows, generation, request) {
    if (!this.isCurrent(generation) || request !== this._listRequest || !this.data.loggedIn) return;
    const feedbacks = rows.filter(row => row.unreadForUser === true).map(row => ({
      feedbackId: row._id, expectedUpdatedAt: row.updatedAt
    }));
    if (!feedbacks.length) return;
    try {
      const result = await this.callFeedback('markFeedbackRead', { feedbacks });
      if (!this.isCurrent(generation) || request !== this._listRequest) return;
      if (!Number.isInteger(result.markedCount) || result.markedCount < 0) return;
      const app = getApp();
      if (app && typeof app.refreshSyncAlert === 'function') await app.refreshSyncAlert({ force: true });
    } catch (error) {
      // Keep the reminder on failure; the next successful list load can retry.
    }
  },
  loadMoreFeedback() { return this.loadFeedback(true); },
  async onPullDownRefresh() {
    try { await this.loadFeedback(); } finally { wx.stopPullDownRefresh(); }
  },
  onReachBottom() { return this.loadMoreFeedback(); }
});
