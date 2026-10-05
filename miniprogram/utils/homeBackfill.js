// 获批补录复用首页表单；权限、入账和普通离线记录分别确认。
const cloudApi = require('./cloudApi.js');
const checkinManager = require('./checkin.js');
const contentSec = require('./contentSec.js');
const dates = require('./dateUtil.js');
const homeCheckin = require('./homeCheckin.js');
const bijingRecordSync = require('./bijingRecordSync.js');

const account = () => wx.getStorageSync('userOpenId') || '';
const errorText = error => error && (error.message || error.errMsg) || '暂时无法连接，请稍后重试';
const timeText = value => {
  const time = dates.getRecordTimestamp(value);
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
};
function usable(row) {
  return row && row.status === 'approved' && row.canRecord === true && row.expired !== true &&
    Date.parse(row.expiresAt) > Date.now() && dates.isDateLabel(row.startDate) && dates.isDateLabel(row.endDate) &&
    row.startDate <= row.endDate && row.endDate < dates.getBusinessDate() &&
    row.startDate >= dates.addBusinessDays(row.endDate, -29);
}
async function call(type, data = {}) {
  const response = await cloudApi.callCloudFunction('meditationManager', { type, ...data });
  const result = response && response.result;
  if (!result || result.success !== true) throw new Error(result && result.error || '云端尚未确认，请重试');
  return result.data;
}
const emptyDay = () => ({ backfillDayRecords: [], backfillDayTotal: 0, backfillDayLoaded: false,
  backfillDayLoading: false, backfillDayError: '' });
const data = { homeBackfillGrant: null, checkinBackfillGrant: null, hasBackfillDates: false,
  checkinDateOptions: [], checkinDateOptionIndex: 0, checkinDateAccessHint: '', backfillLoading: false, backfillError: '',
  checkinBackfillError: '', checkinBackfillMessage: '', backfillSyncState: null, ...emptyDay() };

const methods = {
  isHomeBackfillCurrent(owner, generation) {
    return this._homeBackfillVisible && owner === account() && owner === this._homeBackfillAccount &&
      generation === this._homeBackfillGeneration;
  },
  initHomeBackfill() {
    const owner = account();
    if (this._homeBackfillAccount !== owner) {
      const previous = this._homeBackfillAccount;
      this._homeBackfillAccount = owner;
      this._homeBackfillGrants = [];
      this._homeBackfillSave = null;
      this._homeBackfillRequest = null;
      this._homeBackfillGeneration = (this._homeBackfillGeneration || 0) + 1;
      this.setData({ ...data, ...(previous !== undefined ? { showCheckinModal: false, checkinSubmitting: false,
        checkinDuration: '', checkinExperience: '' } : {}) });
    }
    this._homeBackfillVisible = true;
    this.restoreBackfillDraft();
    if (this._homeBackfillRequest) return this._homeBackfillRequest;
    const generation = this._homeBackfillGeneration;
    if (!owner || !owner.startsWith('oz')) {
      this._homeBackfillGrants = [];
      this.refreshBackfillSelection();
      return Promise.resolve();
    }
    this.setData({ backfillLoading: true, backfillError: '' });
    const request = (async () => {
      try {
        let cursor = '', grant;
        const seen = new Set();
        do {
          const result = await call('getMyBackfillRequests', cursor ? { cursor } : {});
          if (!this.isHomeBackfillCurrent(owner, generation)) return;
          if (!result || !Array.isArray(result.requests)) throw new Error('未能读取补录权限，请重试');
          grant = result.requests.find(usable);
          cursor = result.nextCursor || '';
          if (cursor && seen.has(cursor)) throw new Error('补录权限读取不完整，请重试');
          seen.add(cursor);
        } while (!grant && cursor);
        if (grant) grant = { ...grant, expiresText: timeText(grant.expiresAt) };
        this._homeBackfillGrants = grant ? [grant] : [];
        this.refreshBackfillSelection();
        const intent = wx.getStorageSync('homeBackfillIntent');
        if (intent) {
          wx.removeStorageSync('homeBackfillIntent');
          if (intent.account === owner) {
            if (grant && grant._id === intent.requestId && intent.date >= grant.startDate && intent.date <= grant.endDate) {
              this.openApprovedBackfill({ currentTarget: { dataset: { date: intent.date } } });
            } else wx.showToast({ title: '补录权限已变化，请查看申请结果', icon: 'none' });
          }
        }
      } catch (error) {
        if (!this.isHomeBackfillCurrent(owner, generation)) return;
        this._homeBackfillGrants = [];
        this.setData({ backfillError: '补录权限暂未读取，请重试；普通记录仍可使用。' });
        this.refreshBackfillSelection();
      } finally {
        if (this.isHomeBackfillCurrent(owner, generation)) this.setData({ backfillLoading: false });
        if (this._homeBackfillRequest === request) this._homeBackfillRequest = null;
      }
    })();
    this._homeBackfillRequest = request;
    return request;
  },
  stopHomeBackfill() {
    this._homeBackfillVisible = false;
    this._homeBackfillGeneration = (this._homeBackfillGeneration || 0) + 1;
    this._homeBackfillDayToken = (this._homeBackfillDayToken || 0) + 1;
    this._homeBackfillRequest = null;
    this._homeBackfillGrants = [];
    this._homeBackfillDayKey = '';
    this.setData({ homeBackfillGrant: null, checkinBackfillGrant: null, hasBackfillDates: false,
      checkinDateOptions: [], checkinDateAccessHint: '', backfillLoading: false, backfillSyncState: null, ...emptyDay() });
  },
  refreshBackfillSelection() {
    const owner = account();
    const grants = owner === this._homeBackfillAccount ? (this._homeBackfillGrants || []).filter(usable) : [];
    const today = dates.getBusinessDate(), allowed = new Set([today, dates.addBusinessDays(today, -1), dates.addBusinessDays(today, -2)]);
    for (const row of grants) {
      for (let date = row.startDate; date <= row.endDate; date = dates.addBusinessDays(date, 1)) allowed.add(date);
    }
    const find = date => grants.find(row => date >= row.startDate && date <= row.endDate);
    const options = [...allowed].sort().reverse().map(date => ({ date, label: `${date}${find(date) ? ' · 闭关补录' : ''}` }));
    const grant = find(this.data.checkinDate) || null;
    this.setData({ homeBackfillGrant: grants[0] || null, hasBackfillDates: grants.length > 0,
      checkinDateOptions: options, checkinDateOptionIndex: Math.max(0, options.findIndex(row => row.date === this.data.checkinDate)),
      checkinBackfillGrant: grant });
    this.refreshCheckinDateAccessHint();
    const key = grant && this.data.showCheckinModal ? `${owner}:${grant._id}:${this.data.checkinDate}` : '';
    if (key !== this._homeBackfillDayKey) {
      this._homeBackfillDayKey = key;
      this._homeBackfillDayToken = (this._homeBackfillDayToken || 0) + 1;
      this.setData(emptyDay());
      if (key) this.loadBackfillDayRecords();
    }
    this.refreshBackfillSyncState();
  },
  refreshCheckinDateAccessHint() {
    let hint = '';
    if (this.data.showCheckinModal && this.data.checkinDate &&
        !this.data.checkinDateOptions.some(option => option.date === this.data.checkinDate)) {
      const retry = this.matchingBackfillRetry({ duration: Number(this.data.checkinDuration),
        timestamp: homeCheckin.parseDateTime(this.data.checkinDate, this.data.checkinTime),
        text: this.data.checkinExperience.trim() });
      if (retry) hint = '原提交尚未确认，请保持内容不变后重试核对；新增补录需有效权限。';
      else if (this.data.backfillError) hint = '所选日期暂不在当前可录范围。请重试读取补录权限，或重新选择最近三天的日期；已填写内容已保留。';
      else hint = '所选日期不在当前可录范围。请查看申请状态，或重新选择最近三天或有效获批日期；已填写内容已保留。';
    }
    this.setData({ checkinDateAccessHint: hint });
  },
  openApprovedBackfill(event) {
    const grant = this.data.homeBackfillGrant;
    if (!usable(grant) || this.data.checkinSubmitting) return;
    this.openCheckinModal();
    // 未确认的保存优先恢复原草稿，避免离开后以新标识重复入账。
    if (this._homeBackfillSave && !this._homeBackfillSave.applied) return;
    const date = event && event.currentTarget && event.currentTarget.dataset.date || grant.startDate;
    this.onCheckinDateChange({ detail: { value: date } });
  },
  onAllowedCheckinDateChange(event) {
    const option = this.data.checkinDateOptions[Number(event.detail.value)];
    if (option && !this.data.checkinSubmitting) this.onCheckinDateChange({ detail: { value: option.date } });
  },
  async loadBackfillDayRecords() {
    const owner = this._homeBackfillAccount, generation = this._homeBackfillGeneration;
    const grant = this.data.checkinBackfillGrant, date = this.data.checkinDate;
    if (!grant || !this.isHomeBackfillCurrent(owner, generation)) return;
    const token = this._homeBackfillDayToken = (this._homeBackfillDayToken || 0) + 1;
    this.setData({ backfillDayLoading: true, backfillDayLoaded: false, backfillDayError: '' });
    try {
      const records = await call('getUserRecords', { date });
      if (!this.isHomeBackfillCurrent(owner, generation) || token !== this._homeBackfillDayToken) return;
      if (!Array.isArray(records)) throw new Error('当天记录未读取成功，请重试');
      this.setData({ backfillDayRecords: records.map(row => ({ ...row, timeText: timeText(row.timestamp) })),
        backfillDayTotal: records.reduce((total, row) => total + (Number(row.duration) || 0), 0), backfillDayLoaded: true });
    } catch (error) {
      if (this.isHomeBackfillCurrent(owner, generation) && token === this._homeBackfillDayToken) this.setData({ backfillDayError: errorText(error) });
    } finally {
      if (this.isHomeBackfillCurrent(owner, generation) && token === this._homeBackfillDayToken) this.setData({ backfillDayLoading: false });
    }
  },
  restoreBackfillDraft() {
    const operation = this._homeBackfillSave;
    if (!operation || operation.account !== account() || operation.applied) return;
    this._checkinDateEdited = true;
    this._checkinTimeEdited = true;
    this.setData({ checkinDate: operation.date, checkinTime: operation.time,
      checkinDuration: String(operation.duration), checkinExperience: operation.text,
      checkinSubmitting: operation.pending, checkinBackfillError: operation.error || '' });
    if (operation.result) this.applyHomeBackfillSave(operation);
  },
  matchingBackfillRetry({ duration, timestamp, text }) {
    const op = this._homeBackfillSave;
    const grant = this.data.checkinBackfillGrant;
    return op && !op.applied && op.sent && op.account === account() && op.date === this.data.checkinDate &&
      (!grant || grant._id === op.requestId) && op.duration === duration && op.timestamp === timestamp && op.text === text ? op : null;
  },
  async submitApprovedBackfill({ duration, timestamp, text }) {
    const owner = this._homeBackfillAccount, generation = this._homeBackfillGeneration;
    if (!owner || !this.isHomeBackfillCurrent(owner, generation)) return;
    const previous = this.matchingBackfillRetry({ duration, timestamp, text });
    const grant = this.data.checkinBackfillGrant;
    const date = this.data.checkinDate;
    let error = '';
    if (!previous && !usable(grant)) error = '补录权限已过期或尚未批准，请查看申请结果';
    else if (!previous && (date < grant.startDate || date > grant.endDate)) error = '请选择获批范围内的日期';
    else if (!previous && (!this.data.backfillDayLoaded || this.data.backfillDayLoading)) error = '请先读取当天已有记录，再保存补录';
    else if (!previous && this.data.backfillDayTotal + duration > 1440) error = '当天累计静坐时长不能超过 24 小时';
    if (error) { this.setData({ checkinBackfillError: error }); return; }
    const operation = previous || { account: owner, date, time: this.data.checkinTime, duration, timestamp, text,
      requestId: grant._id, key: `backfill_${Date.now()}_${Math.random().toString(36).slice(2, 12)}` };
    this._homeBackfillSave = operation;
    this._checkinDateEdited = true;
    this._checkinTimeEdited = true;
    operation.pending = true;
    operation.error = '';
    this.setData({ checkinSubmitting: true, checkinBackfillError: '', checkinBackfillMessage: '' });
    try {
      if (duration >= 360 && !previous) {
        const confirmed = await new Promise(resolve => wx.showModal({ title: '本次静坐确认',
          content: `本次填写了 ${duration} 分钟。请确认这是一段连续静坐的时长，不是一天多次静坐的合计。`,
          confirmText: '确认单次', cancelText: '返回修改', success: result => resolve(result.confirm === true), fail: () => resolve(false) }));
        if (!confirmed) return;
      }
      await new Promise((resolve, reject) => wx.getNetworkType({
        success: result => result && result.networkType && !['none', 'unknown'].includes(result.networkType)
          ? resolve() : reject(new Error('请联网后再补录，补录需云端确认')),
        fail: () => reject(new Error('无法确认网络状态，请联网后重试')) }));
      if (!this.isHomeBackfillCurrent(owner, generation)) return;
      if (text && !await contentSec.checkText(text, 2)) return;
      if (!this.isHomeBackfillCurrent(owner, generation)) return;
      operation.sent = true;
      const selected = homeCheckin.getDateTime(timestamp);
      const result = await call('recordMeditation', { data: { source: 'manual', backfillRequestId: operation.requestId,
        date, duration, timestamp, idempotencyKey: operation.key, expectedOpenid: owner,
        experience: text ? [{ text, uniqueId: operation.key, timestamp: `${selected.date} ${selected.time}:00`,
          duration: `${duration}分钟`, emotion: [] }] : [] } });
      if (!result || typeof result.recordId !== 'string' || !result.recordId) throw new Error('未收到保存确认，请保持内容不变后重试');
      operation.result = result;
    } catch (error) { operation.error = errorText(error); }
    finally {
      operation.pending = false;
      // 保存请求的结果归属于原操作；页面重新显示后也能接收，不写入其他账号。
      if (this._homeBackfillVisible && owner === account() && this._homeBackfillSave === operation) {
        this.setData({ checkinSubmitting: false, checkinBackfillError: operation.error });
        if (operation.result) await this.applyHomeBackfillSave(operation);
      }
    }
  },
  async applyHomeBackfillSave(operation) {
    if (operation.applied || !operation.result || operation.account !== account() || !this._homeBackfillVisible) return;
    operation.applied = true;
    this._lastCheckinSubmittedAt = Date.now();
    this.setData({ checkinSubmitting: false, checkinDuration: '', checkinExperience: '', checkinBackfillError: '',
      checkinBackfillMessage: '补录已保存到云端，可继续填写下一次静坐。' });
    this.refreshCheckinDateAccessHint();
    wx.showToast({ title: '补录已保存', icon: 'success' });
    const owner = operation.account, generation = this._homeBackfillGeneration, formVersion = this._backfillFormVersion;
    const sameForm = () => this.isHomeBackfillCurrent(owner, generation) && this._homeBackfillSave === operation &&
      this.data.checkinDate === operation.date && this._backfillFormVersion === formVersion;
    // cloudApi 在云端确认时启动独立必经同步；统计与外部同步失败均不撤销已入账结果。
    this.refreshBackfillSyncState();
    this.loadBackfillDayRecords();
    try {
      const refreshed = await checkinManager.refreshFromCloud();
      if (!this.isHomeBackfillCurrent(owner, generation)) return;
      if (refreshed) {
        this.refreshCalendarData();
        if (typeof checkinManager.asyncCheckBadgeUnlock === 'function') await checkinManager.asyncCheckBadgeUnlock(operation.duration);
      } else if (sameForm()) {
        this.setData({ checkinBackfillMessage: '补录已保存到云端，个人统计暂未刷新，请稍后刷新，无需重复补录。' });
      }
    } catch (_) {
      if (sameForm()) {
        this.setData({ checkinBackfillMessage: '补录已保存到云端，个人统计暂未刷新，请稍后刷新，无需重复补录。' });
      }
    }
  },
  refreshBackfillSyncState() {
    const owner = this._homeBackfillAccount;
    this.setData({ backfillSyncState: owner && owner === account() && this.data.showCheckinModal
      ? bijingRecordSync.getDayState(this.data.checkinDate, owner) : null });
  },
  async retryBackfillSync() {
    if (!this.data.backfillSyncState || !this.data.backfillSyncState.canRetry || this.data.checkinSubmitting ||
        !this.isHomeBackfillCurrent(this._homeBackfillAccount, this._homeBackfillGeneration)) return;
    await bijingRecordSync.retryDate(this.data.checkinDate);
    if (this._homeBackfillVisible) this.refreshBackfillSyncState();
  }
};

module.exports = { data, methods };
