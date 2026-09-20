const checkinManager = require('../../utils/checkin.js');
const contentSec = require('../../utils/contentSec.js');

Page({
  data: {
    duration: 7,
    currentText: '',
    currentTextLength: 0,
    submitting: false,
    completed: false
  },

  onLoad(options = {}) {
    const duration = Number(options.duration || 7);
    this._timestamp = Date.now();
    this._submissionId = options.sessionId || `recorder_${this._timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    this.setData({ duration: Number.isInteger(duration) && duration >= 1 && duration <= 1440 ? duration : 7 });
  },

  onTextInput(e) {
    this.setData({ currentText: e.detail.value, currentTextLength: e.detail.value.length });
  },

  async completeCheckIn() {
    if (this.data.submitting || this.data.completed) return;
    this.setData({ submitting: true });
    try {
      const text = this.data.currentText.trim();
      if (text && !(await contentSec.checkText(text, 2, { allowOffline: true, timeoutMs: 1500 }))) return;
      const experience = text ? [{
        text, uniqueId: this._submissionId, timestamp: this._timestamp,
        duration: `${this.data.duration}分钟`, emotion: []
      }] : [];
      const result = await checkinManager.recordCheckinWithSync(this.data.duration, [], experience, this._timestamp, {
        idempotencyKey: this._submissionId, source: 'manual'
      });
      if (!result || !result.success) throw new Error((result && result.error) || '保存失败，请重试');
      this.setData({ completed: true });
      wx.showToast({
        title: result.cloudSynced ? '上传成功' : '已存本机，请手动上传',
        icon: result.cloudSynced ? 'success' : 'none'
      });
      wx.switchTab({ url: '/pages/index/index' });
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() { return {}; }
});
