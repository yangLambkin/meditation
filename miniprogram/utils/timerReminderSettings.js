const STORAGE_KEY = 'timerReminderSettings';

function normalizeSettings(settings) {
  return {
    start: settings && settings.start === 'vibrate' ? 'vibrate' : 'bell',
    end: settings && settings.end === 'vibrate' ? 'vibrate' : 'bell'
  };
}

function getReminderSettings(api = wx) {
  try {
    return normalizeSettings(api.getStorageSync(STORAGE_KEY));
  } catch (_) {
    return normalizeSettings();
  }
}

function setReminderMode(type, mode, api = wx) {
  if (!['start', 'end'].includes(type) || !['bell', 'vibrate'].includes(mode)) {
    throw new Error('无效的静坐提醒设置');
  }
  // 保存时读取失败须停止，避免覆盖另一项已保存的提醒方式。
  const settings = normalizeSettings(api.getStorageSync(STORAGE_KEY));
  settings[type] = mode;
  api.setStorageSync(STORAGE_KEY, settings);
  return settings;
}

module.exports = { STORAGE_KEY, getReminderSettings, setReminderMode };
