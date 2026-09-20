const dateUtil = require('../../utils/dateUtil.js');
const bijingApi = require('../../utils/bijingApi');
const { buildYearlyHeatmaps } = require('../../utils/heatmap');

Page({
  data: {
    loading: false, errorMessage: '', studentNumber: '', nickname: '',
    heatmaps: [], weekdays: ['一', '二', '三', '四', '五', '六', '日']
  },

  onLoad() { return this.loadHeatmap(); },

  onShow() {
    this.renderHeatmap();
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = dateUtil.watchBusinessDate(() => this.renderHeatmap());
  },

  renderHeatmap() {
    if (!this._heatmapRecords || this._unloaded) return;
    const previous = this.data.heatmaps;
    const heatmaps = buildYearlyHeatmaps(this._heatmapRecords).map(chart => ({
      ...chart, selectedDay: (previous.find(item => item.year === chart.year) || {}).selectedDay || ''
    }));
    this.setData({ heatmaps });
  },

  async loadHeatmap() {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMessage: '' });
    try {
      const result = await bijingApi.getBijingHeatmap();
      if (!result.success || !result.data || !Array.isArray(result.data.records)) {
        throw new Error(result.error || '热力图数据暂时不可用，请重试');
      }
      if (this._unloaded) return;
      this._heatmapRecords = result.data.records;
      this.renderHeatmap();
      this.setData({ studentNumber: result.data.studentNumber, nickname: result.data.nickname });
    } catch (error) {
      if (!this._unloaded) this.setData({ errorMessage: error.message || '热力图加载失败，请重试' });
    } finally {
      if (!this._unloaded) this.setData({ loading: false });
    }
  },

  selectDay(e) {
    const { year, date, duration, empty } = e.currentTarget.dataset;
    if (empty) return;
    const index = this.data.heatmaps.findIndex(chart => chart.year === Number(year));
    if (index < 0) return;
    this.setData({ [`heatmaps[${index}].selectedDay`]: `${date} · ${Number(duration) || 0} 分钟` });
  },

  retry() { return this.loadHeatmap(); },
  async onPullDownRefresh() {
    try { await this.loadHeatmap(); } finally { wx.stopPullDownRefresh(); }
  },
  onHide() {
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
  },
  onUnload() { this.onHide(); this._unloaded = true; }
});
