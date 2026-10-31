const preferences = require('../../utils/practicePreferences.js');

Page({
  data: { entries: [], visibleCount: 6, hiddenCount: 0, error: '' },

  onShow() { this.loadPreferences(); },

  loadPreferences() {
    try {
      this._account = preferences.currentAccountKey();
      this.showPreferences(preferences.getHiddenTypes());
    } catch (_) {
      this._account = null;
      this.setData({ entries: [], error: '暂时无法读取设置，请稍后重试。' });
    }
  },

  showPreferences(hiddenTypes) {
    const entries = preferences.PRACTICES.map(item => ({ ...item, visible: !hiddenTypes.includes(item.type) }));
    this.setData({ entries, visibleCount: entries.filter(item => item.visible).length,
      hiddenCount: hiddenTypes.length, error: '' });
  },

  onEntryChange(event) {
    const type = event.currentTarget.dataset.type;
    if (!this.data.entries.some(item => item.type === type)) return;
    const previousEntries = this.data.entries;
    const entries = previousEntries.map(item => item.type === type ? { ...item, visible: !!event.detail.value } : item);
    const hidden = entries.filter(item => !item.visible).map(item => item.type);
    this.setData({ entries });
    this.savePreferences(hidden, previousEntries);
  },

  savePreferences(hiddenTypes, previousEntries = this.data.entries) {
    try {
      if (!this._account || this._account !== preferences.currentAccountKey()) {
        this.loadPreferences();
        wx.showToast({ title: '账号已变化，请重新设置', icon: 'none' });
        return false;
      }
      this.showPreferences(preferences.saveHiddenTypes(hiddenTypes));
      return true;
    } catch (_) {
      // switch 已先响应手势；重新下发原值，确保保存失败时不显示为已生效。
      this.setData({ entries: previousEntries.map(item => ({ ...item })), error: '设置未能保存，请重试。' });
      wx.showToast({ title: '设置未能保存', icon: 'none' });
      return false;
    }
  },

  restoreAll() {
    if (this.savePreferences([])) wx.showToast({ title: '已显示全部功课', icon: 'success' });
  }
});
