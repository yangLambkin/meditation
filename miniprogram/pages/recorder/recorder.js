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
    savedRecords: [],
    userOpenId: '',
    duration: '7'
  },

  onLoad(options) {
    // 接收时长参数并显示
    if (options.duration) {
      const durationText = options.duration + "分钟";
      this.setData({
        durationText: durationText,
        duration: options.duration
      });
    }
    
    // 获取用户openId
    this.getUserOpenId();
    
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

  // 删除记录
  deleteRecord: function(e) {
    const index = e.currentTarget.dataset.index;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条记录吗？',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          // 删除记录
          const records = [...this.data.savedRecords];
          records.splice(index, 1);
          
          this.setData({
            savedRecords: records
          });
          
          // 保存到本地存储
          this.saveRecordsToStorage(records);
          
          wx.showToast({
            title: '删除成功',
            icon: 'success',
            duration: 2000
          });
        }
      }
    });
  },

  // 获取用户openId
  getUserOpenId: function() {
    // 使用本地生成的唯一ID作为用户标识
    const localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      const newLocalUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', newLocalUserId);
      this.setData({
        userOpenId: newLocalUserId
      });
    } else {
      this.setData({
        userOpenId: localUserId
      });
    }
  },

  // 打卡完成 - 记录用户打卡次数和评分记录
  completeCheckIn: function() {
    if (!this.data.userOpenId) {
      // 如果没有用户ID，先获取
      this.getUserOpenId();
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
    
    // 获取所有用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    
    // 获取当前用户的打卡记录
    const userRecords = allUserRecords[this.data.userOpenId] || {
      totalCount: 0,
      dailyRecords: {}
    };
    
    // 更新今日打卡次数
    const todayRecord = userRecords.dailyRecords[dateStr] || {
      count: 0,
      lastTimestamp: 0,
      durations: [],
      ratings: []
    };
    
    todayRecord.count += 1;
    todayRecord.lastTimestamp = today.getTime();
    todayRecord.durations.push(this.data.duration || '7');
    
    // 保存评分记录
    if (this.data.selectedRating > 0) {
      todayRecord.ratings.push({
        rating: this.data.selectedRating,
        timestamp: today.getTime()
      });
    }
    
    // 保存文本记录数量
    todayRecord.textRecords = this.data.savedRecords.length;
    
    // 更新用户记录
    userRecords.dailyRecords[dateStr] = todayRecord;
    userRecords.totalCount += 1;
    
    // 更新所有用户记录
    allUserRecords[this.data.userOpenId] = userRecords;
    wx.setStorageSync('meditationUserRecords', allUserRecords);
    
    // 保存评分记录到单独的存储（兼容原有逻辑）
    if (this.data.selectedRating > 0) {
      const records = wx.getStorageSync('meditationRecords') || {};
      records[dateStr] = {
        rating: this.data.selectedRating,
        duration: this.data.durationText || '7分钟',
        timestamp: today.getTime(),
        textRecords: this.data.savedRecords.length,
        userOpenId: this.data.userOpenId
      };
      wx.setStorageSync('meditationRecords', records);
    }
    
    wx.showToast({
      title: `打卡成功！今日第${todayRecord.count}次打卡`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟跳转到daily页面
    setTimeout(() => {
      wx.navigateTo({
        url: '/pages/daily/daily'
      });
    }, 1500);
  },

  // 重写页面返回逻辑
  onUnload() {
    // 页面返回时跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  // 自定义返回按钮点击事件
  onBack() {
    // 直接跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  onShareAppMessage() {
    return {};
  },
});