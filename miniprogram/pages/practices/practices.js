const practiceApi = require('../../utils/practiceApi.js');
const practiceQueue = require('../../utils/practiceQueue.js');
const practiceAuth = require('../../utils/practiceAuth.js');
const practiceConfig = require('../../utils/practiceConfig.js');
const practiceEntry = require('../../utils/practiceEntry.js');
const practicePreferences = require('../../utils/practicePreferences.js');

const TYPES = [
  { type: 'all', name: '全部功课', unit: '' },
  ...practicePreferences.PRACTICES
];
const TYPE_MAP = TYPES.reduce((map, item) => { map[item.type] = item; return map; }, {});
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARE_TITLE = '功课记录 · 觉察日常，记录成长';
const SHARE_IMAGE = '/images/practice-share.png';
const TIMELINE_SHARE_IMAGE = '/images/practice-share-timeline.png';

function nowParts(timestamp = Date.now()) {
  const value = new Date(timestamp + BEIJING_OFFSET).toISOString();
  return { date: value.slice(0, 10), time: value.slice(11, 16), occurredAt: value.slice(0, 19).replace('T', ' ') };
}
function formDateBounds(editing = false, timestamp = Date.now()) {
  return { today: nowParts(timestamp).date, formMinDate: editing ? '' : nowParts(timestamp - DAY_MS).date };
}
function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const end = `${month}-${String(lastDay).padStart(2, '0')}`;
  return end < nowParts().date ? end : nowParts().date;
}
function monthLabel(month) {
  const [year, monthNumber] = month.split('-');
  return `${year}年${Number(monthNumber)}月`;
}
function unpack(value) { return value && value.success !== undefined ? value.data || {} : value || {}; }
function ownerKey() { return JSON.stringify(practiceAuth.getOwner() || null); }
function message(error, fallback) { return error && (error.userMessage || error.message) || fallback; }
function readFailure(error, fallback) {
  const code = error && error.code;
  if (['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'BINDING_INVALID', 'IDENTITY_MISMATCH'].includes(code)) {
    return { title: '请先确认账号绑定', message: '请在「我」中登录并确认学号绑定，再回来查看功课。',
      requiresBinding: true, actionText: '前往「我」' };
  }
  if (['AUTH_UNAVAILABLE', 'API_UNAVAILABLE'].includes(code)) {
    return { title: '功课服务暂未就绪', message: '功课记录服务暂时不可用，请稍后重新加载。',
      requiresBinding: false, actionText: '重新加载' };
  }
  return { title: '暂时无法读取', message: message(error, fallback), requiresBinding: false, actionText: '重新加载' };
}
function quantity(record) {
  return Number(record.type === 'instant' ? record.count : record.type === 'kindness' ? record.quantity || record.deedCount || 1 : record.durationMinutes) || 0;
}
function decorate(record) {
  const meta = TYPE_MAP[record.type] || TYPE_MAP.sitting;
  const source = record.source;
  const mirrored = !!(record.sourceRecordId || source === 'meditation' || source && (source.system === 'meditation' || source.sourceSystem === 'meditation'));
  const occurredAt = typeof record.occurredAt === 'string' ? record.occurredAt.replace('T', ' ') : '';
  return { ...record, key: `${record.type}:${record.id}`, typeName: meta.name, unit: meta.unit,
    quantity: quantity(record), timeLabel: occurredAt ? occurredAt.slice(11, 16) : '未记录时间',
    occurredAt, mirrored, canEdit: record.type !== 'sitting' && record.canEdit !== false,
    canDelete: record.type !== 'sitting' && record.canDelete !== false,
    preview: (record.content || record.reflection || '').slice(0, 100) };
}
function groupsFor(records) {
  const groups = [];
  records.forEach(record => {
    let group = groups[groups.length - 1];
    if (!group || group.date !== record.recordDate) { group = { date: record.recordDate, records: [] }; groups.push(group); }
    group.records.push(record);
  });
  return groups;
}
function metricCards(stats) {
  const byType = stats && (stats.totals || stats.byType || stats.types || stats.totalsByType) || {};
  return TYPES.slice(1).map(meta => {
    const item = Array.isArray(byType) ? byType.find(row => row.type === meta.type) || {} : byType[meta.type] || {};
    const value = typeof item === 'number' ? item : item.totalValue ?? item.quantity ?? item.total ?? (meta.type === 'instant' ? item.count : meta.type === 'kindness' ? item.deedCount ?? item.totalCount : item.durationMinutes ?? item.totalDurationMinutes) ?? 0;
    return { ...meta, unit: meta.type === 'kindness' ? '次' : meta.unit,
      value: Number(value) || 0, records: Number(item.recordCount || item.records || 0) };
  });
}
function quantityLabel(value) {
  return value >= 10000 ? `${Math.round(value / 1000) / 10}万` : String(value);
}
function makeCalendar(month, daily, type, selectedDate) {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const [year, monthNumber] = month.split('-').map(Number);
  const leading = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const rows = [];
  const byDate = {};
  (Array.isArray(daily) ? daily : []).forEach(item => { byDate[item.date || item.recordDate] = item; });
  const today = nowParts().date;
  for (let i = 0; i < Math.ceil((leading + length) / 7) * 7; i++) {
    if (i % 7 === 0) rows.push([]);
    const day = i - leading + 1;
    if (day < 1 || day > length) { rows[rows.length - 1].push({ key: `blank-${i}`, empty: true }); continue; }
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const stats = byDate[date] || {};
    const cards = metricCards(stats);
    const card = cards.find(item => item.type === type);
    const value = type === 'all' ? Number(stats.recordCount) || 0 : card && card.value || 0;
    const recordCount = type === 'all' ? stats.recordCount : card && card.records;
    rows[rows.length - 1].push({ key: date, day, date, value, valueLabel: quantityLabel(value), active: value > 0 || Number(recordCount) > 0,
      selected: selectedDate === date, today: today === date, future: date > today });
  }
  const maxValue = rows.reduce((max, week) => week.reduce((value, day) =>
    day.future ? value : Math.max(value, day.value || 0), max), 0);
  rows.forEach(week => week.forEach(day => {
    if (!day.empty) day.level = !day.future && day.value > 0 ? Math.max(1, Math.ceil(day.value / maxValue * 5)) : 0;
  }));
  return rows;
}
function makeTrend(month, daily, type) {
  if (type === 'all' || !/^\d{4}-\d{2}$/.test(month)) return { trend: [], trendMax: 0, trendWidth: 0 };
  const [year, monthNumber] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDate = {};
  (Array.isArray(daily) ? daily : []).forEach(item => { byDate[item.date || item.recordDate] = item; });
  const trend = Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const stats = byDate[date] || {};
    const card = metricCards(stats).find(item => item.type === type);
    const value = Number(stats.quantity ?? stats.total ?? (card && card.value) ?? 0) || 0;
    return { date, day: index + 1, value, label: quantityLabel(value) };
  });
  const trendMax = Math.max(0, ...trend.map(item => item.value));
  return { trend: trend.map(item => ({ ...item, height: item.value && trendMax ? Math.max(4, Math.round(item.value / trendMax * 130)) : 2 })),
    trendMax, trendWidth: length * 54 };
}
function uniqueId() { return `practice_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`; }

Page({
  data: {
    typeOptions: [TYPES[0]], typeIndex: 0, type: 'all', showTypePicker: false, month: '', monthLabel: '', monthEnd: '', today: '', selectedDate: '', view: 'detail',
    records: [], groups: [], nextCursor: '', loading: false, loadingMore: false, loaded: false, error: '', feedFailure: null,
    summary: null, summaryError: '', summaryFailure: null, summaryLoading: false, monthCards: [], allTimeCards: [], calendar: [], trend: [], trendMax: 0, trendWidth: 0,
    recordCount: 0, practiceDays: 0, selectedMonthTotal: 0, selectedMonthUnit: '条',
    overviewTotal: 0, overviewUnit: '', overviewLabel: '',
    allTimeRecordCount: 0, allTimePracticeDays: 0,
    pending: [], pendingCount: 0, retrying: false, showPending: false, pendingActionId: '',
    showForm: false, formType: 'walking', formTypeName: '走路觉察', formDate: '', formMinDate: '', formTime: '',
    formValue: '', formContent: '', formReflection: '', formUnit: '分钟', formRecordId: '',
    formEditing: false, formBusy: false, formPending: false, formError: '', formMaxReflection: 5000,
    detail: null, deleting: false, enabled: true
  },

  onLoad(options = {}) {
    this.options = options;
    const now = nowParts();
    const month = now.date.slice(0, 7);
    this.setData({ month, monthLabel: monthLabel(month), monthEnd: now.date, ...formDateBounds(),
      enabled: practiceConfig.practicesEnabled === true });
    this.refreshTypeOptions();
    if (typeof wx.showShareMenu === 'function') {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    }
  },
  onShow() {
    this._visible = true;
    const currentOwner = ownerKey();
    if (this._owner && this._owner !== currentOwner) {
      this._generation = (this._generation || 0) + 1;
      this.setData({ showForm: false, detail: null, records: [], groups: [], summary: null,
        error: '', summaryError: '', feedFailure: null, summaryFailure: null });
    }
    this._owner = currentOwner;
    this.refreshTypeOptions();
    this.setData({ ...formDateBounds(this.data.formEditing), monthEnd: monthEnd(this.data.month) });
    if (this._unsubscribe) this._unsubscribe();
    if (typeof practiceQueue.subscribe === 'function') this._unsubscribe = practiceQueue.subscribe(event => {
      if (!this._visible) return;
      this.refreshPending();
      if (event && event.type === 'flush' && event.sent > 0 &&
          practiceApi.sameOwner(event.owner, practiceAuth.getOwner())) this.refresh();
    });
    this.refreshPending();
    this.refresh();
    if (typeof wx.getStorageSync === 'function') {
      const requested = wx.getStorageSync('practiceRecordEntry');
      if (requested && TYPE_MAP[requested] && requested !== 'all' && requested !== 'sitting') {
        wx.removeStorageSync('practiceRecordEntry');
        this.openForm(requested);
      }
    }
  },
  onHide() {
    this._visible = false;
    // A shared entry may temporarily open a hidden tab; cached visits use the saved preference again.
    if (this.options && this.options.from === 'share') delete this.options.from;
    this.closeTypePicker();
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  },
  onUnload() { this.onHide(); this._generation = (this._generation || 0) + 1; },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { if (this.data.view === 'detail') this.loadMore(); },
  onShareAppMessage() {
    return { title: SHARE_TITLE, path: '/pages/practices/practices?from=share', imageUrl: SHARE_IMAGE };
  },
  onShareTimeline() {
    return { title: SHARE_TITLE, query: 'from=share', imageUrl: TIMELINE_SHARE_IMAGE };
  },

  async refresh() {
    if (!this.data.enabled) return;
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, error: '', summaryError: '', feedFailure: null, summaryFailure: null,
      records: [], groups: [], nextCursor: '', loaded: false });
    this.refreshPending();
    await Promise.all([this.loadFeed(generation), this.loadSummary(generation)]);
  },
  async loadFeed(generation, cursor) {
    const account = ownerKey();
    try {
      const result = unpack(await practiceApi.feed({ month: this.data.month, type: this.data.type,
        ...(this.data.selectedDate ? { date: this.data.selectedDate } : {}), ...(cursor ? { cursor } : {}) }));
      if (generation !== this._generation || account !== ownerKey()) return;
      const newRecords = (result.records || []).map(decorate);
      const merged = cursor ? this.data.records.concat(newRecords) : newRecords;
      const seen = new Set();
      const records = merged.filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true; });
      this.setData({ records, groups: groupsFor(records), nextCursor: result.nextCursor || '', error: '', feedFailure: null, loaded: true });
    } catch (error) {
      if (generation === this._generation && account === ownerKey()) this.setData({
        error: message(error, '暂时无法读取功课记录，请重试'), feedFailure: readFailure(error, '功课记录暂时无法读取，请稍后重试。'), loaded: true });
    } finally {
      if (generation === this._generation && account === ownerKey()) this.setData({ loading: false, loadingMore: false });
    }
  },
  async loadSummary(generation) {
    const account = ownerKey();
    this.setData({ summaryLoading: true });
    try {
      const summary = unpack(await practiceApi.summary({ month: this.data.month, type: this.data.type }));
      if (generation !== this._generation || account !== ownerKey()) return;
      const month = Array.isArray(summary.totals) ? summary : summary.totals || summary.month || {};
      const allTime = summary.allTime || summary.cumulative || {};
      const monthCards = metricCards(month);
      const allTimeCards = metricCards(allTime).map(card => ({ ...card,
        monthValue: monthCards.find(item => item.type === card.type).value }));
      const selectedCard = monthCards.find(item => item.type === this.data.type);
      const recordCount = Number(month.recordCount || month.records || 0);
      const overviewUnit = selectedCard && selectedCard.unit || '';
      this.setData({ summary, monthCards, allTimeCards,
        recordCount, practiceDays: Number(month.practiceDays || month.days || 0),
        overviewTotal: selectedCard && selectedCard.value || 0,
        overviewUnit, overviewLabel: overviewUnit === '次' ? '累计次数' : overviewUnit === '分钟' ? '累计时间' : '',
        selectedMonthTotal: this.data.type === 'all' ? recordCount : selectedCard && selectedCard.value || 0,
        selectedMonthUnit: this.data.type === 'all' ? '条' : overviewUnit,
        allTimeRecordCount: Number(allTime.recordCount || allTime.records || 0), allTimePracticeDays: Number(allTime.practiceDays || allTime.days || 0),
        calendar: makeCalendar(this.data.month, summary.daily, this.data.type, this.data.selectedDate),
        ...makeTrend(this.data.month, summary.daily, this.data.type), summaryError: '', summaryFailure: null });
    } catch (error) {
      if (generation === this._generation && account === ownerKey()) this.setData({
        summaryError: message(error, '统计暂时无法读取，请重试'), summaryFailure: readFailure(error, '功课统计暂时无法读取，请稍后重试。') });
    } finally {
      if (generation === this._generation && account === ownerKey()) this.setData({ summaryLoading: false });
    }
  },
  loadMore() {
    if (!this.data.nextCursor || this.data.loading || this.data.loadingMore || this.data.error) return;
    this.setData({ loadingMore: true });
    return this.loadFeed(this._generation, this.data.nextCursor);
  },
  refreshTypeOptions() {
    const typeOptions = [TYPES[0], ...practicePreferences.getVisiblePractices()];
    const selectedIndex = typeOptions.findIndex(item => item.type === this.data.type);
    const changed = selectedIndex < 0;
    this.setData({ typeOptions, typeIndex: changed ? 0 : selectedIndex,
      ...(changed ? { type: 'all', selectedDate: '' } : {}) });
    return changed;
  },
  openTypePicker() {
    if (!this.data.enabled || this.data.showTypePicker) return;
    try { this._typePickerAccount = practicePreferences.currentAccountKey(); }
    catch (_) { wx.showToast({ title: '暂时无法读取功课入口，请稍后重试', icon: 'none' }); return; }
    this._typePickerOwner = ownerKey();
    if (this.refreshTypeOptions()) this.refresh();
    this.setData({ showTypePicker: true });
  },
  closeTypePicker() {
    this._typePickerAccount = null;
    this._typePickerOwner = null;
    this.setData({ showTypePicker: false });
  },
  openPracticeSettings() {
    this.closeTypePicker();
    practiceEntry.openSettings();
  },
  onTypeChange(event) {
    if (!this.data.showTypePicker) return;
    let currentAccount;
    try { currentAccount = practicePreferences.currentAccountKey(); } catch (_) {}
    if (!currentAccount || this._typePickerAccount !== currentAccount || this._typePickerOwner !== ownerKey()) {
      this.closeTypePicker();
      wx.showToast({ title: '账号已变化，请重新选择功课', icon: 'none' });
      return;
    }
    const detail = event.detail || {};
    const index = Number(detail.value);
    const choice = typeof detail.type === 'string'
      ? this.data.typeOptions.find(item => item.type === detail.type)
      : detail.value !== undefined && detail.value !== '' && Number.isInteger(index) && this.data.typeOptions[index];
    if (!choice) return;
    const filterChanged = this.refreshTypeOptions();
    const typeIndex = this.data.typeOptions.findIndex(item => item.type === choice.type);
    if (typeIndex < 0) {
      if (filterChanged) this.refresh();
      wx.showToast({ title: '功课入口已更新，请重新选择', icon: 'none' });
      return;
    }
    this.closeTypePicker();
    if (this.data.type === choice.type && !filterChanged) return;
    this.setData({ typeIndex, type: choice.type, selectedDate: '' });
    this.refresh();
  },
  onMonthChange(event) {
    const month = event.detail.value.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > nowParts().date.slice(0, 7)) return;
    this.setData({ month, monthLabel: monthLabel(month), monthEnd: monthEnd(month), selectedDate: '' });
    this.refresh();
  },
  onDateChange(event) { this.selectDay(event.detail.value); },
  selectCalendarDay(event) { this.selectDay(event.currentTarget.dataset.date); },
  selectDay(date) {
    if (!date || !date.startsWith(`${this.data.month}-`) || date > nowParts().date) return;
    this.setData({ selectedDate: date, view: 'detail' });
    this.refresh();
  },
  clearDate() { this.setData({ selectedDate: '' }); this.refresh(); },
  changeView(event) { this.setData({ view: event.currentTarget.dataset.view }); },
  openOriginalHistory() { wx.navigateTo({ url: '/pages/checkinHistory/checkinHistory' }); },
  openOriginalRecord() {
    const record = this.data.detail;
    let date = record && record.recordDate;
    if (record && record.occurredAt) {
      const timestamp = Date.parse(`${record.occurredAt.replace(' ', 'T')}+08:00`);
      if (Number.isFinite(timestamp)) date = nowParts(timestamp - 2 * 60 * 60 * 1000).date;
    }
    wx.navigateTo({ url: date ? `/pages/history/history?date=${encodeURIComponent(date)}` : '/pages/checkinHistory/checkinHistory' });
  },
  openBinding() { wx.switchTab({ url: '/pages/me/me' }); },
  handleReadFailure(event) {
    const failure = event.currentTarget.dataset.scope === 'summary' ? this.data.summaryFailure : this.data.feedFailure;
    return failure && failure.requiresBinding ? this.openBinding() : this.refresh();
  },
  refreshPending() {
    try {
      const tasks = practiceQueue.getPending();
      const pending = tasks.map(task => {
        const deletionQueued = task.operation === 'create' && tasks.some(item => item.operation === 'delete' &&
          (item.dependsOn === task.id || item.recordId === `local:${task.id}`));
        return { ...task, deletionQueued,
          typeName: (TYPE_MAP[task.type] || TYPE_MAP.sitting).name,
          dateLabel: task.payload && (task.payload.recordDate || task.payload.occurredAt && task.payload.occurredAt.slice(0, 10)) || '',
          stateText: deletionQueued ? '已登记删除，将先确认原记录再删除' : task.lastError && (task.lastError.message || task.lastError) || (task.status === 'waiting_source' ? '等待原静坐云端确认' : '待上传'),
          canCancel: task.operation === 'create' && !task.attempts && task.type !== 'sitting' && !deletionQueued,
          canDeletePending: task.kind !== 'mirror' && task.type !== 'sitting' && task.operation === 'create' && !!task.attempts && !deletionQueued };
      });
      this.setData({ pending, pendingCount: pending.length });
    } catch (error) { this.setData({ error: message(error, '待上传记录读取失败，请核对本机存储'),
      feedFailure: readFailure(error, '待上传记录读取失败，请核对本机存储') }); }
  },
  togglePending() { this.setData({ showPending: !this.data.showPending }); },
  async retryPending() {
    if (this.data.retrying) return;
    this.setData({ retrying: true });
    try {
      await require('../../utils/practiceMirror.js').resume();
      await practiceQueue.flush({ manual: true }); this.refreshPending(); await this.refresh();
    }
    catch (error) { wx.showToast({ title: message(error, '上传尚未完成，记录已保留在本机'), icon: 'none' }); }
    finally { this.setData({ retrying: false }); }
  },
  async cancelPending(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '取消待上传记录', content: '取消后这条尚未发送的功课将从本机移除。', confirmText: '取消记录',
      success: result => {
        if (!result.confirm) return;
        try { practiceQueue.cancel(id); this.refreshPending(); }
        catch (error) { wx.showToast({ title: message(error, '记录已发送，请待上传确认后删除'), icon: 'none' }); }
      } });
  },
  deletePending(event) {
    const id = event.currentTarget.dataset.id;
    const task = this.data.pending.find(item => item.id === id);
    if (!task || !task.canDeletePending || this.data.pendingActionId) return;
    const owner = ownerKey();
    wx.showModal({ title: '删除待上传记录', content: '这条记录可能已上传。系统会先确认原记录，再删除同一条记录；网络未恢复时，删除任务会保留在本机。',
      confirmText: '登记删除', confirmColor: '#b45f4e', success: result => { if (result.confirm) this.requestPendingDeletion(id, owner); } });
  },
  async requestPendingDeletion(id, owner) {
    if (this.data.pendingActionId || owner !== ownerKey()) return;
    const task = practiceQueue.getPending().find(item => item.id === id);
    if (!task || task.kind === 'mirror' || task.type === 'sitting' || task.operation !== 'create') return;
    if (practiceQueue.getPending().some(item => item.operation === 'delete' && (item.dependsOn === id || item.recordId === `local:${id}`))) return;
    this.setData({ pendingActionId: id });
    try {
      await practiceQueue.enqueuePractice({ type: task.type, operation: 'delete', recordId: `local:${id}`, payload: {}, requestId: uniqueId() });
      this.refreshPending();
      await practiceQueue.flush({ manual: true });
      if (owner === ownerKey()) await this.refresh();
    } catch (error) { if (owner === ownerKey()) wx.showToast({ title: message(error, '删除登记尚未完成，请重试'), icon: 'none' }); }
    finally { this.setData({ pendingActionId: '' }); this.refreshPending(); }
  },
  choosePractice() {
    practiceEntry.choosePractice(type => {
      if (type === 'sitting') return this.openSittingForm();
      this.openForm(type);
    });
  },
  openSittingForm() {
    wx.setStorageSync('practiceSittingEntry', true);
    wx.switchTab({ url: '/pages/index/index' });
  },
  openForm(type, record) {
    if (!TYPE_MAP[type] || type === 'all' || type === 'sitting' || this.data.formBusy) return;
    if (!this.data.enabled) { wx.showToast({ title: '功课录入暂未启用', icon: 'none' }); return; }
    const timestamp = Date.now();
    const now = nowParts(timestamp);
    this._formOwner = ownerKey();
    this._formRequestId = uniqueId();
    this._formTaskId = null;
    this._formOccurredAt = record ? record.occurredAt || null : now.occurredAt;
    this._formTimeEdited = false;
    this.setData({ showForm: true, detail: null, formType: type, formTypeName: TYPE_MAP[type].name,
      formUnit: TYPE_MAP[type].unit, formDate: record ? record.recordDate : now.date,
      formTime: record && record.occurredAt ? record.occurredAt.slice(11, 16) : record ? '' : now.time,
      formValue: record ? String(quantity(record)) : '', formContent: record && record.content || '',
      formReflection: record && record.reflection || '', formRecordId: record && record.id || '',
      formEditing: !!record, formPending: false, formError: '', formMaxReflection: type === 'kindness' ? 1000 : 5000,
      ...formDateBounds(!!record, timestamp) });
  },
  closeForm() { if (!this.data.formBusy) this.setData({ showForm: false }); },
  noop() {},
  refreshFormDates() { this.setData(formDateBounds(this.data.formEditing)); },
  onFormDate(event) {
    if (this.data.formBusy || this.data.formPending) return;
    this._formTimeEdited = true;
    this.setData({ formDate: event.detail.value, formError: '', ...formDateBounds(this.data.formEditing) });
  },
  onFormTime(event) {
    if (this.data.formBusy || this.data.formPending) return;
    this._formTimeEdited = true;
    this.setData({ formTime: event.detail.value, formError: '' });
  },
  onFormValue(event) { if (!this.data.formBusy && !this.data.formPending) this.setData({ formValue: event.detail.value, formError: '' }); },
  onFormContent(event) { if (!this.data.formBusy && !this.data.formPending) this.setData({ formContent: event.detail.value, formError: '' }); },
  onFormReflection(event) { if (!this.data.formBusy && !this.data.formPending) this.setData({ formReflection: event.detail.value, formError: '' }); },
  formPayload() {
    const { formType: type, formDate: recordDate, formTime: time } = this.data;
    const now = Date.now();
    const bounds = formDateBounds(this.data.formEditing, now);
    this.setData(bounds);
    const timestamp = Date.parse(`${recordDate}T${time}:00+08:00`);
    // 历史仅日期记录必须由用户补充真实时间，不能替换成打开表单的时间。
    if (this.data.formEditing && !this._formOccurredAt && !this._formTimeEdited) {
      throw new Error('原记录仅有日期，请选择真实发生时间后保存');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate) || recordDate > bounds.today ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isFinite(timestamp) || timestamp > now || nowParts(timestamp).date !== recordDate) {
      throw new Error('请选择有效且不晚于当前的北京时间');
    }
    if (!this.data.formEditing && recordDate < bounds.formMinDate) {
      throw new Error('只能记录今天和昨天的功课，请重新选择发生日期');
    }
    const occurredAt = !this._formTimeEdited && this._formOccurredAt || `${recordDate} ${time}:00`;
    const reflection = this.data.formReflection.trim();
    if (reflection.length > this.data.formMaxReflection) throw new Error(`感悟不能超过 ${this.data.formMaxReflection} 字`);
    const payload = { recordDate, ...(occurredAt ? { occurredAt } : {}), reflection };
    if (type === 'kindness') {
      const content = this.data.formContent.trim();
      if (!content || content.length > 1000) throw new Error('请填写 1 至 1000 字的善事内容');
      payload.content = content;
    } else {
      const value = this.data.formValue.trim();
      const maximum = type === 'instant' ? 1000000 : 1440;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
        throw new Error(`请输入 1 至 ${maximum} ${type === 'instant' ? '次' : '分钟'}的整数`);
      }
      payload[type === 'instant' ? 'count' : 'durationMinutes'] = Number(value);
    }
    return payload;
  },
  async saveForm() {
    if (!this.data.showForm || this.data.formBusy) return;
    if (this._formOwner !== ownerKey()) {
      this.setData({ formError: '账号或学号绑定已变化，请关闭后重新录入' });
      return;
    }
    let payload;
    // 已入队内容已冻结；跨日重试继续上传原任务，不能重新按新建日期范围校验。
    try { if (!this._formTaskId) payload = this.formPayload(); }
    catch (error) { this.setData({ formError: message(error, '请核对填写内容') }); return; }
    this.setData({ formBusy: true, formError: '' });
    const formRequestId = this._formRequestId;
    const formOwner = this._formOwner;
    const currentForm = () => this._formRequestId === formRequestId && ownerKey() === formOwner;
    try {
      if (!this._formTaskId) {
        const task = await practiceQueue.enqueuePractice({ type: this.data.formType,
          operation: this.data.formEditing ? 'update' : 'create', recordId: this.data.formRecordId || undefined,
          payload, requestId: this._formRequestId });
        if (!currentForm()) return;
        this._formTaskId = task.id;
        this.setData({ formPending: true });
      }
      await practiceQueue.flush({ manual: true });
      if (!currentForm()) return;
      const task = practiceQueue.getPending().find(item => item.id === this._formTaskId);
      if (task) {
        this.setData({ formPending: true, formError: task.lastError && (task.lastError.message || task.lastError) || '已保留在本机，尚未上传。重试会继续提交同一条记录。' });
        return;
      }
      this.setData({ showForm: false, formPending: false });
      wx.showToast({ title: this.data.formEditing ? '已更新' : '已记录', icon: 'success' });
      await this.refresh();
    } catch (error) { if (currentForm()) this.setData({ formError: message(error, '暂未上传，填写内容已保留，请重试') }); }
    finally { if (this._formRequestId === formRequestId) this.setData({ formBusy: false }); this.refreshPending(); }
  },
  openDetail(event) {
    const record = this.data.records.find(item => item.key === event.currentTarget.dataset.key);
    if (record) { this._detailOwner = ownerKey(); this.setData({ detail: record }); }
  },
  closeDetail() { if (!this.data.deleting) this.setData({ detail: null }); },
  editDetail() {
    if (this._detailOwner !== ownerKey()) { wx.showToast({ title: '账号或学号已变化，请重新打开记录', icon: 'none' }); return; }
    const record = this.data.detail;
    if (record && record.canEdit) this.openForm(record.type, record);
  },
  deleteDetail() {
    const record = this.data.detail;
    if (!record || !record.canDelete || this.data.deleting) return;
    const owner = this._detailOwner;
    wx.showModal({ title: '删除这条功课？', content: record.type === 'kindness' ? '删除后也会更新「做善事」，该操作不可恢复。' : '删除后无法恢复，请确认。',
      confirmText: '删除', confirmColor: '#b45f4e', success: result => { if (result.confirm) this.confirmDelete(record, owner); } });
  },
  async confirmDelete(record, owner = this._detailOwner) {
    if (this.data.deleting) return;
    if (owner !== ownerKey()) { wx.showToast({ title: '账号或学号已变化，请重新打开记录', icon: 'none' }); return; }
    this.setData({ deleting: true });
    try {
      const task = await practiceQueue.enqueuePractice({ type: record.type, operation: 'delete', recordId: record.id, payload: {}, requestId: uniqueId() });
      await practiceQueue.flush({ manual: true });
      if (owner !== ownerKey()) return;
      const pending = practiceQueue.getPending().some(item => item.id === task.id);
      this.setData({ detail: null });
      wx.showToast({ title: pending ? '删除待上传，已保留本机' : '已删除', icon: pending ? 'none' : 'success' });
      await this.refresh();
    } catch (error) { wx.showToast({ title: message(error, '删除尚未完成，请重试'), icon: 'none' }); }
    finally { this.setData({ deleting: false }); this.refreshPending(); }
  }
});
