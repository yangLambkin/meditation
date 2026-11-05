const { getReminderSettings, setReminderMode } = require('../../utils/timerReminderSettings');

const REMINDER_ROWS = [
  { type: 'start', title: '开始提醒', description: '开始静坐 5 秒后提醒' },
  { type: 'end', title: '结束提醒', description: '静坐结束时提醒' }
];
const MODES = ['bell', 'vibrate'];

Page({
  data: {
    reminderOptions: ['铃声', '震动'],
    reminders: REMINDER_ROWS.map(item => ({ ...item, modeIndex: 0 })),
    error: ''
  },

  onShow() {
    this.showSettings(getReminderSettings(wx));
  },

  showSettings(settings) {
    this.setData({
      reminders: REMINDER_ROWS.map(item => ({ ...item, modeIndex: MODES.indexOf(settings[item.type]) })),
      error: ''
    });
  },

  onReminderChange(event) {
    const type = event.currentTarget.dataset.type;
    const mode = MODES[Number(event.detail.value)];
    if (!REMINDER_ROWS.some(item => item.type === type) || !mode) return;
    const previous = this.data.reminders;
    // picker 先响应手势，保存失败时重新下发原值以回滚原生控件。
    this.setData({ reminders: previous.map(item => item.type === type
      ? { ...item, modeIndex: MODES.indexOf(mode) } : item) });
    try {
      this.showSettings(setReminderMode(type, mode, wx));
    } catch (_) {
      this.setData({ reminders: previous.map(item => ({ ...item })), error: '设置未能保存，请重试。' });
      wx.showToast({ title: '设置未能保存，请重试', icon: 'none' });
    }
  }
});
