Page({
  data: {
    stars: [
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false }
    ],
    selectedRating: 0,
    isHovering: false,
    currentHoverIndex: -1,
    currentText: '',
    currentTextLength: 0,
    savedRecords: []
  },

  onLoad(options) {
    // 接收时长参数并显示
    if (options.duration) {
      const durationText = options.duration + "分钟";
      this.setData({
        durationText: durationText
      });
    }
    
    // 加载已保存的记录
    this.loadSavedRecords();
  },

  // 选择评分
  selectRating: function(e) {
    const index = e.currentTarget.dataset.index;
    const newStars = this.data.stars.map((star, i) => ({
      ...star,
      active: i <= index,
      hover: false
    }));
    
    this.setData({
      stars: newStars,
      selectedRating: index + 1,
      isHovering: false,
      currentHoverIndex: -1
    });
  },

  // 星星触摸开始（模拟悬停）
  starTouchStart: function(e) {
    const index = e.currentTarget.dataset.index;
    const newStars = this.data.stars.map((star, i) => ({
      ...star,
      hover: i <= index
    }));
    
    this.setData({
      stars: newStars,
      isHovering: true,
      currentHoverIndex: index
    });
  },

  // 星星触摸结束
  starTouchEnd: function(e) {
    if (this.data.isHovering) {
      const newStars = this.data.stars.map(star => ({
        ...star,
        hover: false
      }));
      
      this.setData({
        stars: newStars,
        isHovering: false,
        currentHoverIndex: -1
      });
    }
  },

  // 星星触摸移动（模拟悬停跟随）
  starTouchMove: function(e) {
    if (this.data.isHovering) {
      // 可以在这里添加触摸跟随效果
    }
  },

  // 文本输入处理
  onTextInput: function(e) {
    const text = e.detail.value;
    this.setData({
      currentText: text,
      currentTextLength: text.length
    });
  },

  // 文本获得焦点
  onTextFocus: function() {
    console.log('文本输入框获得焦点');
  },

  // 文本失去焦点
  onTextBlur: function() {
    console.log('文本输入框失去焦点');
  },

  // 保存当前记录
  saveCurrentRecord: function() {
    if (this.data.currentText.trim() === '') {
      wx.showToast({
        title: '请输入内容',
        icon: 'none',
        duration: 2000
      });
      return;
    }

    // 生成时间戳 YYYY-MM-DD HH:MM:SS
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    // 创建新记录
    const newRecord = {
      text: this.data.currentText.trim(),
      timestamp: timestamp,
      rating: this.data.selectedRating,
      duration: this.data.durationText || '7分钟'
    };

    // 添加到记录列表（新记录显示在最前面）
    const updatedRecords = [newRecord, ...this.data.savedRecords];
    
    this.setData({
      savedRecords: updatedRecords,
      currentText: '',
      currentTextLength: 0
    });

    // 保存到本地存储
    this.saveRecordsToStorage(updatedRecords);

    wx.showToast({
      title: '保存成功',
      icon: 'success',
      duration: 2000
    });
  },

  // 加载已保存的记录
  loadSavedRecords: function() {
    try {
      const records = wx.getStorageSync('meditationTextRecords') || [];
      this.setData({
        savedRecords: records
      });
    } catch (error) {
      console.error('加载记录失败:', error);
    }
  },

  // 保存记录到本地存储
  saveRecordsToStorage: function(records) {
    try {
      wx.setStorageSync('meditationTextRecords', records);
    } catch (error) {
      console.error('保存记录失败:', error);
      wx.showToast({
        title: '保存失败',
        icon: 'error',
        duration: 2000
      });
    }
  },

  // 打卡完成 - 跳转到daily页面
  completeCheckIn: function() {
    // 保存评分记录（如果有评分）
    if (this.data.selectedRating > 0) {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
      
      // 获取本地存储的记录
      const records = wx.getStorageSync('meditationRecords') || {};
      records[dateStr] = {
        rating: this.data.selectedRating,
        duration: this.data.durationText || '7分钟',
        timestamp: today.getTime(),
        textRecords: this.data.savedRecords.length // 记录文本记录数量
      };
      
      // 保存到本地存储
      wx.setStorageSync('meditationRecords', records);
    }
    
    // 跳转到daily页面
    wx.navigateTo({
      url: '/pages/daily/daily'
    });
  },

  onShareAppMessage() {
    return {};
  },
});