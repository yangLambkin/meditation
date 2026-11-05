Page({
  goToTimerSettings() {
    wx.navigateTo({ url: '/pages/timerSettings/timerSettings' });
  },

  goToPracticeSettings() {
    wx.navigateTo({ url: '/pages/practiceSettings/practiceSettings' });
  }
});
