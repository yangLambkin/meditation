// pages/timer/timer.js
Page({
  data: {
    // 计时器状态
    isRunning: false,
    isPaused: false,        // 是否处于暂停状态
    isCountdown: true,      // true=倒计时, false=正计时
    
    // 时间设置
    totalTime: 420,         // 总时长（秒）7分钟=420秒
    elapsedTime: 0,         // 已过时间（秒）
    remainingTime: 420,     // 剩余时间（秒）7分钟=420秒
    
    // 时长选择相关字段
    duration: 7,            // 当前选择时长（分钟）
    durationText: "7 分钟", // 显示文本
    showTimePicker: false,  // 是否显示时间选择器
    showCustomTimePicker: false, // 是否显示自定义时长弹窗
    customTimeInput: "",    // 自定义时长输入
    timeOptions: [
      { value: 7, text: "7 分钟" },
      { value: 10, text: "10 分钟" },
      { value: 15, text: "15 分钟" },
      { value: 20, text: "20 分钟" },
      { value: 30, text: "30 分钟" },
      { value: "custom", text: "自定义" }
    ],
    
    // 自定义时长相关字段
    isValidCustomTime: false,  // 自定义时长是否有效
    
    // 计时器控制
    timerInterval: null,
    
    // 进度显示
    progress: 0,
    progressAngle: 0,        // 径向进度条角度（0-360度）
    displayTime: "07:00",
    
    // 按钮状态管理
    showStartButton: true,     // 显示开始按钮
    showPauseButton: false,    // 显示暂停按钮  
    showStopButton: false,     // 显示停止按钮
    showResetButton: true,     // 显示重置按钮
    
    // 按钮图标路径
    startIcon: "/images/icons/start.png",
    pauseIcon: "/images/icons/pause.png",
    stopIcon: "/images/icons/stop.png",
    resetIcon: "/images/icons/resetting.png",
    
    // 音频对象
    audioPlayer: null,
    
    // 音频播放器
    audioContext: null,
    audioPlayer: null
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this.updateDisplay();
    this.updateButtonStates();
    
    // 创建音频播放器
    this.createAudioPlayer();
  },

  /**
   * 更新按钮显示状态
   */
  updateButtonStates() {
    const isRunning = this.data.isRunning;
    const hasStarted = this.data.elapsedTime > 0;
    
    this.setData({
      // 开始按钮：未运行时显示
      showStartButton: !isRunning,
      // 暂停按钮：运行时显示
      showPauseButton: isRunning,
      // 停止按钮：已经开始计时时显示，或者计时正在运行中
      showStopButton: hasStarted || isRunning,
      // 重置按钮：始终显示
      showResetButton: true
    });
  },

  /**
   * 开始/继续计时器
   */
  startTimer() {
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
    }

    this.setData({
      isRunning: true,
      isPaused: false
    });

    const timerInterval = setInterval(() => {
      this.updateTimer();
    }, 1000);

    this.setData({
      timerInterval: timerInterval
    });

    this.updateButtonStates();
  },

  /**
   * 暂停计时器
   */
  pauseTimer() {
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.setData({
        isRunning: false,
        isPaused: true,
        timerInterval: null
      });
      this.updateButtonStates();
    }
  },

  /**
   * 完全停止计时器
   */
  stopTimer() {
    // 只有在计时器运行时停止才播放铃声
    const wasRunning = this.data.isRunning;
    
    this.setData({
      elapsedTime: 0,
      remainingTime: this.data.totalTime,
      isRunning: false,
      isPaused: false
    });

    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.setData({
        timerInterval: null
      });
    }

    // 如果计时器正在运行，停止时播放铃声
    if (wasRunning) {
      this.playBellSound();
    }

    this.updateDisplay();
    this.updateButtonStates();
  },

  /**
   * 更新计时器状态
   */
  updateTimer() {
    if (this.data.isCountdown) {
      // 倒计时模式
      if (this.data.remainingTime > 0) {
        this.setData({
          remainingTime: this.data.remainingTime - 1,
          elapsedTime: this.data.elapsedTime + 1
        });
      } else {
        // 倒计时结束
        this.stopTimer();
        
        // 播放提醒铃声
        this.playBellSound();
        
        wx.showToast({
          title: '计时结束',
          icon: 'success',
          duration: 2000
        });
        
        // 延迟2秒后自动跳转到记录页面
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/recorder/recorder?duration=' + this.data.duration
          });
        }, 2000);
      }
    } else {
      // 正计时模式
      this.setData({
        elapsedTime: this.data.elapsedTime + 1,
        remainingTime: Math.max(0, this.data.totalTime - this.data.elapsedTime - 1)
      });
      
      // 检查正计时是否完成
      if (this.data.elapsedTime >= this.data.totalTime) {
        // 正计时结束
        this.stopTimer();
        
        // 播放提醒铃声
        this.playBellSound();
        
        wx.showToast({
          title: '计时完成',
          icon: 'success',
          duration: 2000
        });
        
        // 延迟2秒后自动跳转到记录页面
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/recorder/recorder?duration=' + this.data.duration
          });
        }, 2000);
      }
    }

    this.updateDisplay();
  },

  /**
   * 更新显示时间和进度
   */
  updateDisplay() {
    // 计算显示时间
    let displaySeconds;
    if (this.data.isCountdown) {
      displaySeconds = this.data.remainingTime;
    } else {
      displaySeconds = this.data.elapsedTime;
    }

    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    const displayTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // 计算进度百分比
    let progress;
    if (this.data.isCountdown) {
      progress = ((this.data.totalTime - this.data.remainingTime) / this.data.totalTime) * 100;
    } else {
      progress = (this.data.elapsedTime / this.data.totalTime) * 100;
    }

    // 计算径向进度条角度
    let progressAngle;
    
    if (this.data.isCountdown) {
      // 倒计时模式：从完全填充到完全消失
      // 进度从360°（完全填充）减少到0°（完全消失）
      progressAngle = 360 - (progress * 3.6);
    } else {
      // 正计时模式：从未填充到完全填充
      // 进度从0°（未填充）增加到360°（完全填充）
      progressAngle = progress * 3.6;
    }

    this.setData({
      displayTime: displayTime,
      progress: Math.min(100, Math.max(0, progress)),
      progressAngle: Math.min(360, Math.max(0, progressAngle))
    });
  },

  /**
   * 切换正计时/倒计时模式
   */
  toggleMode(e) {
    const isCountdown = e.detail.value;
    
    // 停止计时器
    this.stopTimer();
    
    this.setData({
      isCountdown: isCountdown
    });
    
    this.updateDisplay();
    this.updateButtonStates();
  },

  /**
   * 重置计时器
   */
  resetTimer() {
    this.setData({
      elapsedTime: 0,
      remainingTime: this.data.totalTime,
      isRunning: false,
      isPaused: false
    });

    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.setData({
        timerInterval: null
      });
    }

    this.updateDisplay();
    this.updateButtonStates();
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    // 清理计时器
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
    }
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {
    return {};
  },

  /**
   * 显示时间选择器
   */
  showTimePicker: function() {
    this.setData({
      showTimePicker: true
    });
  },

  /**
   * 隐藏时间选择器
   */
  hideTimePicker: function() {
    this.setData({
      showTimePicker: false
    });
  },

  /**
   * 隐藏自定义时长弹窗
   */
  hideCustomTimePicker: function() {
    this.setData({
      showCustomTimePicker: false
    });
  },

  /**
   * 自定义时长输入处理
   */
  onCustomTimeInput: function(e) {
    const value = e.detail.value;
    const isValid = this.validateCustomTime(value);
    
    this.setData({
      customTimeInput: value,
      isValidCustomTime: isValid
    });
  },

  /**
   * 验证自定义时长
   */
  validateCustomTime: function(time) {
    if (!time || time.trim() === '') {
      return false;
    }
    
    const minutes = parseInt(time);
    return !isNaN(minutes) && minutes >= 1 && minutes <= 180;
  },

  /**
   * 确认自定义时长
   */
  confirmCustomTime: function() {
    if (!this.data.isValidCustomTime) {
      return;
    }
    
    const minutes = parseInt(this.data.customTimeInput);
    const totalSeconds = minutes * 60;
    
    this.setData({
      duration: minutes,
      durationText: minutes + " 分钟",
      totalTime: totalSeconds,
      remainingTime: totalSeconds,
      showCustomTimePicker: false,
      customTimeInput: ""
    });
    
    // 更新显示
    this.updateDisplay();
    
    // 如果正在计时，需要重置
    if (this.data.isRunning) {
      this.stopTimer();
    }
  },

  /**
   * 选择时长
   */
  selectDuration: function(e) {
    const selectedDuration = e.currentTarget.dataset.value;
    
    if (selectedDuration === "custom") {
      // 显示自定义时长弹窗
      this.setData({
        showTimePicker: false,
        showCustomTimePicker: true,
        customTimeInput: ""
      });
    } else {
      // 选择预设时长
      const totalSeconds = selectedDuration * 60;
      
      this.setData({
        duration: selectedDuration,
        durationText: selectedDuration + " 分钟",
        totalTime: totalSeconds,
        remainingTime: totalSeconds,
        showTimePicker: false
      });
      
      // 更新显示
      this.updateDisplay();
      
      // 如果正在计时，需要重置
      if (this.data.isRunning) {
        this.stopTimer();
      }
    }
  },

  /**
   * 创建音频播放器
   */
  createAudioPlayer: function() {
    this.audioPlayer = wx.createInnerAudioContext();
    this.audioPlayer.src = '/audio/belling.mp3';
    this.audioPlayer.loop = false; // 不循环播放
    this.audioPlayer.obeyMuteSwitch = false; // 静音模式下也播放
    
    // 音频加载完成回调
    this.audioPlayer.onCanplay(() => {
      console.log('音频加载完成');
    });
    
    // 音频播放错误回调
    this.audioPlayer.onError((err) => {
      console.error('音频播放错误:', err);
    });
  },

  /**
   * 播放提醒铃声
   */
  playBellSound: function() {
    if (this.audioPlayer) {
      this.audioPlayer.play();
      console.log('播放提醒铃声');
    }
  }
});