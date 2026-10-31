const preferences = require('./practicePreferences.js');

function openSettings() {
  wx.navigateTo({ url: '/pages/practiceSettings/practiceSettings' });
}

function handlePickerFailure(error) {
  const reason = error && (error.errMsg || error.message) || '';
  if (/\bcancel\b/i.test(reason)) return;
  console.warn('打开功课选择菜单失败:', error);
  wx.showToast({ title: '功课列表打开失败，请重试', icon: 'none' });
}

function choosePractice(onChoose) {
  let account;
  try { account = preferences.currentAccountKey(); }
  catch (_) { wx.showToast({ title: '暂时无法读取功课入口，请稍后重试', icon: 'none' }); return; }
  const choices = preferences.getVisiblePractices();
  const stillCurrent = () => {
    try {
      if (preferences.currentAccountKey() === account) return true;
    } catch (_) {}
    wx.showToast({ title: '账号已变化，请重新选择功课', icon: 'none' });
    return false;
  };
  if (!choices.length) {
    wx.showModal({ title: '功课入口已全部隐藏', content: '可以在「功课入口设置」中重新开启需要的功课。',
      confirmText: '去设置', success: result => { if (result.confirm && stillCurrent()) openSettings(); } });
    return;
  }
  try {
    wx.showActionSheet({ itemList: choices.map(item => item.name), success: result => {
      if (!stillCurrent()) return;
      const choice = choices[result.tapIndex];
      if (choice && preferences.getVisiblePractices().some(item => item.type === choice.type)) onChoose(choice.type);
    }, fail: handlePickerFailure });
  } catch (error) {
    handlePickerFailure(error);
  }
}

module.exports = { choosePractice, openSettings };
