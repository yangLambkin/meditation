Page({
  data: {
    src: '',
    errorMessage: ''
  },

  onLoad(options) {
    let studentNumber = '';
    try {
      studentNumber = decodeURIComponent(options.studentNumber || '').trim();
    } catch (error) {
      // 无效的页面参数不应生成错误的学号链接。
    }
    if (!studentNumber) {
      this.setData({ errorMessage: '请返回“我”页面，先绑定学号再查看热力图。' });
      return;
    }
    this.setData({
      src: `https://data.bijing.life/public/heatmap?studentNumber=${encodeURIComponent(studentNumber)}`
    });
  },

  onWebViewError() {
    this.setData({ errorMessage: '热力图暂时无法打开，请重试或复制链接到浏览器查看。' });
  },

  retry() {
    this.setData({ errorMessage: '' });
  },

  copyLink() {
    if (!this.data.src) return;
    wx.setClipboardData({
      data: this.data.src,
      success: () => wx.showToast({ title: '链接已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  }
});
