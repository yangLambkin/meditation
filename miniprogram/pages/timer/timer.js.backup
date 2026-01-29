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
    audioPlayer: null,
    
    // 背景音乐相关
    showMusicPicker: false,      // 是否显示背景音乐选择器
    backgroundMusic: 'default',  // 当前选择的背景音乐，默认值设置为'default'
    musicText: '默认',          // 当前选择的背景音乐文本显示
    musicOptions: [
      { value: 'default', text: '默认' },
      { value: 'none', text: '无音乐' }
    ],
    backgroundMusicPlayer: null, // 背景音乐播放器
    defaultMusicFileID: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/audio/30mins.MP3',
    defaultMusicUrl: '',        // 存储获取到的临时音频链接
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this.updateDisplay();
    this.updateButtonStates();
    
    // 创建音频播放器
    this.createAudioPlayer();
    
    // 详细检查云存储文件状态
    this.checkCloudFileExists();
    
    // 获取云存储音频临时链接
    this.getBackgroundMusicUrl();
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

    // 开始播放背景音乐（仅在选择"默认"时播放）
    this.playBackgroundMusic();

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
      
      // 暂停时暂停背景音乐
      this.pauseBackgroundMusic();
      
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

    // 如果计时器正在运行，停止时播放铃声并停止背景音乐
    if (wasRunning) {
      this.playBellSound();
      this.stopBackgroundMusic();
    } else {
      // 如果计时器不在运行，也停止背景音乐
      this.stopBackgroundMusic();
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
    console.log('📱 计时器页面卸载，清理资源');
    
    // 清理计时器
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      console.log('✅ 计时器已清理');
    }
    
    // 停止背景音乐播放
    this.stopBackgroundMusic();
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
  },

  /**
   * 获取背景音乐临时链接
   */
  getBackgroundMusicUrl: function() {
    // 初始化云开发
    wx.cloud.init({
      env: 'cloud1-2g2rbxbu2c126d4a'
    });
    
    console.log('=== 开始获取背景音乐临时链接 ===');
    console.log('文件路径:', this.data.defaultMusicFileID);
    
    // 获取临时文件URL
    wx.cloud.getTempFileURL({
      fileList: [{
        fileID: this.data.defaultMusicFileID
      }],
      success: urlRes => {
        console.log('✅ 获取背景音乐临时URL成功:', urlRes);
        
        if (urlRes.fileList && urlRes.fileList[0]) {
          const fileInfo = urlRes.fileList[0];
          console.log('文件信息:', {
            fileID: fileInfo.fileID,
            tempFileURL: fileInfo.tempFileURL,
            maxAge: fileInfo.maxAge
          });
          
          if (fileInfo.tempFileURL && fileInfo.tempFileURL.trim() !== '') {
            const tempUrl = fileInfo.tempFileURL;
            console.log('✅ 获取到临时URL:', tempUrl);
            
            // 测试这个URL是否可用
            this.testAudioPlayability(tempUrl);
            
            this.setData({
              defaultMusicUrl: tempUrl
            });
            console.log('✅ 设置背景音乐URL成功');
          } else {
            console.warn('❌ 临时URL为空，可能原因:');
            console.warn('1. 云存储文件不存在');
            console.warn('2. 文件权限设置为私有');
            console.warn('3. 文件路径错误');
            
            // 使用备选方案
            this.useFallbackAudio();
          }
        } else {
          console.warn('❌ 文件列表为空');
          // 使用备选方案
          this.useFallbackAudio();
        }
      },
      fail: err => {
        console.error('❌ 获取背景音乐URL失败:', err);
        console.error('错误详情:', {
          errCode: err.errCode,
          errMsg: err.errMsg
        });
      }
    });
  },

  /**
   * 测试音频URL是否可播放
   */
  testAudioPlayability: function(url) {
    console.log('=== 开始测试音频URL可播放性 ===');
    console.log('测试URL:', url);
    
    const testPlayer = wx.createInnerAudioContext();
    testPlayer.src = url;
    
    testPlayer.onCanplay(() => {
      console.log('✅ 音频可以播放 - onCanplay触发');
    });
    
    testPlayer.onPlay(() => {
      console.log('✅ 音频开始播放 - onPlay触发');
    });
    
    testPlayer.onError((err) => {
      console.error('❌ 音频播放错误:', err);
      console.error('错误代码:', err.errCode);
      console.error('错误信息:', err.errMsg);
    });
    
    testPlayer.onWaiting(() => {
      console.log('⏳ 音频等待缓冲');
    });
    
    testPlayer.onSeeking(() => {
      console.log('🔍 音频正在定位');
    });
    
    testPlayer.onSeeked(() => {
      console.log('✅ 音频定位完成');
    });
    
    // 设置超时自动停止测试
    setTimeout(() => {
      if (testPlayer) {
        testPlayer.stop();
        testPlayer.destroy();
        console.log('⏹️ 测试播放器已停止');
      }
    }, 5000);
    
    // 尝试播放
    console.log('▶️ 开始测试播放...');
    testPlayer.play();
  },

  /**
   * 显示背景音乐选择器
   */
  showMusicPicker: function() {
    this.setData({
      showMusicPicker: true
    });
  },

  /**
   * 隐藏背景音乐选择器
   */
  hideMusicPicker: function() {
    this.setData({
      showMusicPicker: false
    });
  },

  /**
   * 选择背景音乐
   */
  selectMusic: function(e) {
    const selectedMusic = e.currentTarget.dataset.value;
    const musicOption = this.data.musicOptions.find(option => option.value === selectedMusic);
    
    if (musicOption) {
      this.setData({
        backgroundMusic: selectedMusic,
        musicText: musicOption.text,
        showMusicPicker: false
      });
      console.log('选择背景音乐:', selectedMusic, musicOption.text);
    }
  },

  /**
   * 播放背景音乐（开始计时时调用）
   */
  playBackgroundMusic: function() {
    console.log('🔊 播放背景音乐检查:', {
      backgroundMusic: this.data.backgroundMusic,
      hasUrl: !!this.data.defaultMusicUrl,
      musicText: this.data.musicText
    });
    
    // 只有在选择"默认"选项且已经获取到音频链接时才播放
    if (this.data.backgroundMusic === 'default' && this.data.defaultMusicUrl) {
      console.log('✅ 满足播放条件，开始播放背景音乐');
      
      if (!this.backgroundMusicPlayer) {
        console.log('🆕 创建新的背景音乐播放器');
        // 创建背景音乐播放器
        this.backgroundMusicPlayer = wx.createInnerAudioContext();
        this.backgroundMusicPlayer.src = this.data.defaultMusicUrl;
        this.backgroundMusicPlayer.loop = true; // 循环播放
        this.backgroundMusicPlayer.obeyMuteSwitch = false; // 静音模式下也播放
        
        // 监听音频事件
        this.backgroundMusicPlayer.onCanplay(() => {
          console.log('✅ 背景音乐可以播放了');
        });
        
        this.backgroundMusicPlayer.onPlay(() => {
          console.log('🎵 背景音乐开始播放');
        });
        
        this.backgroundMusicPlayer.onPause(() => {
          console.log('⏸️ 背景音乐已暂停');
        });
        
        this.backgroundMusicPlayer.onStop(() => {
          console.log('⏹️ 背景音乐已停止');
        });
        
        this.backgroundMusicPlayer.onEnded(() => {
          console.log('🔚 背景音乐播放结束');
        });
        
        this.backgroundMusicPlayer.onError((err) => {
          console.error('❌ 背景音乐播放错误:', err);
          console.error('错误代码:', err.errCode);
          console.error('错误信息:', err.errMsg);
        });
      }
      
      // 播放音频
      try {
        this.backgroundMusicPlayer.play();
        console.log('▶️ 已调用播放命令');
      } catch (error) {
        console.error('❌ 播放命令执行失败:', error);
      }
      
    } else if (this.data.backgroundMusic === 'none') {
      console.log('🔇 选择无音乐，不播放背景音乐');
    } else {
      console.log('❌ 不满足播放条件:', {
        backgroundMusic: this.data.backgroundMusic,
        hasUrl: !!this.data.defaultMusicUrl
      });
    }
  },

  /**
   * 暂停背景音乐（暂停计时时调用）
   */
  pauseBackgroundMusic: function() {
    console.log('⏸️ 暂停背景音乐');
    if (this.backgroundMusicPlayer) {
      try {
        this.backgroundMusicPlayer.pause();
        console.log('✅ 背景音乐已暂停');
      } catch (error) {
        console.error('❌ 暂停命令执行失败:', error);
      }
    } else {
      console.log('⚠️ 背景音乐播放器不存在');
    }
  },

  /**
   * 停止播放背景音乐（停止计时时调用）
   */
  stopBackgroundMusic: function() {
    console.log('⏹️ 停止背景音乐');
    if (this.backgroundMusicPlayer) {
      try {
        this.backgroundMusicPlayer.stop();
        console.log('✅ 背景音乐已停止');
      } catch (error) {
        console.error('❌ 停止命令执行失败:', error);
      }
    } else {
      console.log('⚠️ 背景音乐播放器不存在');
    }
  },

  /**
   * 使用备选音频方案
   */
  useFallbackAudio: function() {
    console.log('🔄 使用备选音频方案');
    
    // 方案1：尝试使用本地音频文件
    const localAudioPath = '/audio/30mins.MP3';
    console.log('尝试使用本地音频:', localAudioPath);
    
    this.setData({
      defaultMusicUrl: localAudioPath
    });
    
    // 测试备选音频是否可用
    this.testAudioPlayability(localAudioPath);
  },

  /**
   * 检查云存储文件是否存在
   */
  checkCloudFileExists: function() {
    console.log('🔍 检查云存储文件是否存在');
    
    wx.cloud.init({
      env: 'cloud1-2g2rbxbu2c126d4a'
    });
    
    // 尝试获取文件列表
    wx.cloud.getTempFileURL({
      fileList: [{
        fileID: this.data.defaultMusicFileID
      }],
      success: (res) => {
        console.log('云存储文件检查结果:', res);
        
        if (res.fileList && res.fileList[0]) {
          const file = res.fileList[0];
          console.log('文件状态:', {
            fileID: file.fileID,
            hasTempURL: !!file.tempFileURL && file.tempFileURL.trim() !== '',
            maxAge: file.maxAge
          });
          
          if (!file.tempFileURL || file.tempFileURL.trim() === '') {
            console.error('❌ 云存储文件无法访问，建议:');
            console.error('1. 检查文件是否存在: audio/30mins.MP3');
            console.error('2. 检查文件权限是否为"所有用户可读"');
            console.error('3. 检查文件路径是否正确');
          }
        }
      },
      fail: (err) => {
        console.error('❌ 云存储文件检查失败:', err);
      }
    });
  }
});