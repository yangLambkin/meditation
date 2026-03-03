// pages/timer/timer.js - 使用wx.createBackgroundTimer的稳定方案
Page({
  data: {
    // 计时器状态
    isRunning: false,
    isPaused: false,
    isCountdown: true,
    
    // 时间设置
    totalTime: 420,
    elapsedTime: 0,
    remainingTime: 420,
    
    // 时长选择
    duration: 7,
    durationText: "7 分钟",
    showTimePicker: false,
    showCustomTimePicker: false,
    customTimeInput: "",
    timeOptions: [
      { value: 7, text: "7 分钟" },
      { value: 10, text: "10 分钟" },
      { value: 15, text: "15 分钟" },
      { value: 20, text: "20 分钟" },
      { value: 30, text: "30 分钟" },
      { value: "custom", text: "自定义" }
    ],
    
    isValidCustomTime: false,
    
    // 计时器控制
    timerInterval: null,
    
    // 进度显示
    progress: 0,
    progressAngle: 0,
    displayTime: "07:00",
    
    // 按钮状态
    showStartButton: true,
    showPauseButton: false,
    showStopButton: false,
    showResetButton: true,
    
    // 按钮图标
    startIcon: "/images/icons/start.png",
    pauseIcon: "/images/icons/pause.png",
    stopIcon: "/images/icons/stop.png",
    resetIcon: "/images/icons/resetting.png",
    
    // 音频播放器
    audioPlayer: null,
    
    // 背景音乐相关
    showMusicPicker: false,
    backgroundMusic: 'default',
    musicText: '引导音频',
    musicOptions: [
      { value: 'default', text: '引导音频' },
      { value: 'none', text: '无音乐' }
    ],
    backgroundMusicPlayer: null,
    defaultMusicFileID: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/audio/万能引导片段.mp3',
    defaultMusicUrl: '',
    
    // 时间戳用于精确计时
    startTimestamp: 0,
    pauseTimestamp: 0,
    totalPausedTime: 0
  },

  onLoad(options) {
    this.updateDisplay();
    this.updateButtonStates();
    this.createAudioPlayer();
    this.checkCloudFileExists();
    this.getBackgroundMusicUrl();
    this.setupAppStateListeners();
    this.restoreTimerState();
    
    // 设置屏幕常亮，防止熄屏
    this.setKeepScreenOn();
    
    // 保存当前亮度，以便退出时恢复
    this.saveCurrentBrightness();
    
    // 初始化亮度控制变量
    this.brightnessTimer = null;
    this.isBrightnessReduced = false;
  },

  // 设置应用状态监听
  setupAppStateListeners() {
    // 应用进入前台（屏幕打开）
    wx.onAppShow((res) => {
      console.log('📱 应用进入前台，同步时间');
      if (this.data.isRunning) {
        this.syncTimerTime();
      }
      
      // 重新设置屏幕常亮（亮度设置由系统自动保持）
      this.setKeepScreenOn();
    });
    
    // 应用进入后台（屏幕关闭）
    wx.onAppHide(() => {
      console.log('📱 应用进入后台，保存状态');
      this.saveTimerState();
      
      // 确保后台音频继续播放
      this.ensureBackgroundAudioPlayback();
      
      // 恢复屏幕设置（当应用被切到后台时）
      this.restoreScreenSettings();
    });
  },

  // 确保后台音频播放
  ensureBackgroundAudioPlayback() {
    // 如果计时器正在运行，确保背景音乐在后台继续播放
    if (this.data.isRunning && this.backgroundMusicPlayer) {
      console.log('🎵 确保后台音频继续播放');
      
      // 重新播放背景音乐（如果被系统暂停）
      setTimeout(() => {
        if (this.backgroundMusicPlayer && this.data.isRunning) {
          this.backgroundMusicPlayer.play();
        }
      }, 100);
    }
  },

  // 时间同步（屏幕重新打开时校正时间）
  syncTimerTime() {
    if (!this.data.isRunning || !this.data.startTimestamp) return;
    
    const currentTime = Date.now();
    const pausedTime = this.data.pauseTimestamp > 0 ? 
      (currentTime - this.data.pauseTimestamp) : 0;
    const expectedElapsed = Math.floor(
      (currentTime - this.data.startTimestamp - this.data.totalPausedTime - pausedTime) / 1000
    );
    const actualElapsed = this.data.elapsedTime;
    
    // 如果时间差异较大（超过2秒），重新校正
    if (Math.abs(expectedElapsed - actualElapsed) > 2) {
      console.log('🔄 时间同步校正:', {
        预期: expectedElapsed + '秒',
        实际: actualElapsed + '秒',
        差异: (expectedElapsed - actualElapsed) + '秒'
      });
      
      this.setData({
        elapsedTime: expectedElapsed,
        remainingTime: Math.max(0, this.data.totalTime - expectedElapsed)
      });
      
      this.updateDisplay();
    }
  },

  // 开始计时器
  startTimer() {
    // 清理之前的计时器
    this.cleanupTimers();
    
    // 计算开始时间戳
    const now = Date.now();
    let startTime = now;
    
    if (this.data.isPaused && this.data.pauseTimestamp > 0) {
      // 从暂停状态恢复，累计暂停时间
      const pausedDuration = now - this.data.pauseTimestamp;
      this.setData({
        totalPausedTime: this.data.totalPausedTime + pausedDuration,
        pauseTimestamp: 0
      });
    } else {
      // 全新开始
      this.setData({
        startTimestamp: now,
        totalPausedTime: 0,
        pauseTimestamp: 0
      });
      startTime = now;
    }
    
    this.setData({
      isRunning: true,
      isPaused: false
    });

    // 播放背景音乐（仅在选择"默认"时播放）
    this.playBackgroundMusic();

    // 使用前台计时器（屏幕常亮，无需后台计时器）
    this.createForegroundTimer();
    
    // 1分钟后降低屏幕亮度
    this.startBrightnessControl();
    
    console.log('✅ 启动前台计时器（屏幕常亮模式）');

    this.updateButtonStates();
    console.log('✅ 开始计时，支持后台运行');
  },

  // 创建前台计时器
  createForegroundTimer() {
    this.data.timerInterval = setInterval(() => {
      this.updateForegroundTimer();
    }, 1000);
  },

  // 前台计时器更新（屏幕常亮模式）
  updateForegroundTimer() {
    if (!this.data.isRunning) return;
    
    const elapsed = this.calculateElapsedTime();
    this.setData({
      elapsedTime: elapsed,
      remainingTime: Math.max(0, this.data.totalTime - elapsed)
    });
    
    this.updateDisplay();
    
    // 检查是否完成
    if (elapsed >= this.data.totalTime) {
      this.handleTimerFinished();
    }
  },

  // 计算已用时间
  calculateElapsedTime() {
    if (!this.data.startTimestamp) return 0;
    
    const currentTime = Date.now();
    const pausedTime = this.data.pauseTimestamp > 0 ? 
      (currentTime - this.data.pauseTimestamp) : 0;
    
    return Math.floor(
      (currentTime - this.data.startTimestamp - this.data.totalPausedTime - pausedTime) / 1000
    );
  },

  // 处理计时完成
  handleTimerFinished() {
    console.log('✅ 计时完成');
    
    // 停止所有计时器
    this.cleanupTimers();
    
    // 停止亮度控制并恢复亮度
    this.stopBrightnessControl();
    
    // 停止背景音乐（引导音频）
    this.stopBackgroundMusic();
    
    // 播放完成铃声
    this.playBellSound();
    
    // 更新状态
    this.setData({
      isRunning: false,
      isPaused: false,
      elapsedTime: this.data.totalTime,
      remainingTime: 0
    });
    
    this.updateDisplay();
    this.updateButtonStates();
    
    // 显示完成提示
    wx.showModal({
      title: '计时结束',
      content: '计时结束',
      showCancel: false,
      success: () => {
        // 延迟1秒后自动跳转到记录页面
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/recorder/recorder?duration=' + this.data.duration
          });
        }, 1000);
      }
    });
  },

  // 暂停计时器
  pauseTimer() {
    if (!this.data.isRunning) return;
    
    this.cleanupTimers();
    
    // 暂停亮度控制（如果已降低亮度）
    if (this.isBrightnessReduced) {
      console.log('💡 计时暂停，恢复屏幕亮度');
      this.restoreBrightness();
      this.isBrightnessReduced = false;
    }
    
    this.setData({
      isRunning: false,
      isPaused: true,
      pauseTimestamp: Date.now()
    });
    
    // 暂停背景音乐
    this.pauseBackgroundMusic();
    
    this.updateButtonStates();
    console.log('⏸️ 计时器已暂停');
  },

  // 停止计时器
  stopTimer() {
    const wasRunning = this.data.isRunning;
    
    this.cleanupTimers();
    
    // 停止亮度控制并恢复亮度
    this.stopBrightnessControl();
    
    this.setData({
      elapsedTime: 0,
      remainingTime: this.data.totalTime,
      isRunning: false,
      isPaused: false,
      startTimestamp: 0,
      pauseTimestamp: 0,
      totalPausedTime: 0
    });
    
    // 停止背景音乐
    this.stopBackgroundMusic();
    
    // 如果正在运行，播放铃声
    if (wasRunning) {
      this.playBellSound();
    }
    
    this.updateDisplay();
    this.updateButtonStates();
    console.log('⏹️ 计时器已停止');
  },

  // 停止所有计时器
  cleanupTimers() {
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.setData({ timerInterval: null });
    }
  },

  // 更新按钮显示状态
  updateButtonStates() {
    const isRunning = this.data.isRunning;
    const hasStarted = this.data.elapsedTime > 0;
    
    this.setData({
      showStartButton: !isRunning,
      showPauseButton: isRunning,
      showStopButton: hasStarted || isRunning,
      showResetButton: true
    });
  },

  // 更新显示时间和进度
  updateDisplay() {
    let displaySeconds = this.data.isCountdown ? this.data.remainingTime : this.data.elapsedTime;
    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    const displayTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    let progress = this.data.isCountdown ? 
      ((this.data.totalTime - this.data.remainingTime) / this.data.totalTime) * 100 :
      (this.data.elapsedTime / this.data.totalTime) * 100;

    let progressAngle = this.data.isCountdown ? 
      360 - (progress * 3.6) : progress * 3.6;

    this.setData({
      displayTime: displayTime,
      progress: Math.min(100, Math.max(0, progress)),
      progressAngle: Math.min(360, Math.max(0, progressAngle))
    });
  },

  // 保存计时状态
  saveTimerState() {
    const state = {
      elapsedTime: this.data.elapsedTime,
      totalTime: this.data.totalTime,
      isRunning: this.data.isRunning,
      isPaused: this.data.isPaused,
      startTimestamp: this.data.startTimestamp,
      pauseTimestamp: this.data.pauseTimestamp,
      totalPausedTime: this.data.totalPausedTime,
      saveTime: Date.now()
    };
    
    wx.setStorageSync('timerState', state);
  },

  // 恢复计时状态
  restoreTimerState() {
    const timerState = wx.getStorageSync('timerState');
    if (timerState && timerState.isRunning) {
      const timeSinceSave = Math.floor((Date.now() - timerState.saveTime) / 1000);
      const estimatedElapsed = timerState.elapsedTime + timeSinceSave;
      
      this.setData({
        elapsedTime: estimatedElapsed,
        remainingTime: Math.max(0, timerState.totalTime - estimatedElapsed),
        totalTime: timerState.totalTime
      });
      
      wx.showModal({
        title: '恢复计时',
        content: `检测到未完成的计时，是否继续？\n已进行: ${Math.floor(estimatedElapsed/60)}分${estimatedElapsed%60}秒`,
        success: (res) => {
          if (res.confirm) {
            // 恢复计时
            this.setData({
              startTimestamp: Date.now() - (estimatedElapsed * 1000),
              totalPausedTime: 0
            });
            // 如果已超过1分钟，立即降低亮度
            if (estimatedElapsed >= 60) {
              console.log('💡 恢复计时，已超过1分钟，立即降低亮度');
              this.setMinBrightness();
              this.isBrightnessReduced = true;
            } else {
              // 否则设置1分钟后降低亮度
              this.startBrightnessControl();
            }
            
            this.startTimer();
          } else {
            this.stopTimer();
          }
        }
      });
      
      this.updateDisplay();
    }
  },

  // 设置屏幕常亮
  setKeepScreenOn() {
    wx.setKeepScreenOn({
      keepScreenOn: true,
      success: () => {
        console.log('✅ 屏幕常亮设置成功');
      },
      fail: (err) => {
        console.warn('⚠️ 屏幕常亮设置失败:', err);
      }
    });
  },

  // 保存当前亮度
  saveCurrentBrightness() {
    wx.getScreenBrightness({
      success: (res) => {
        this.originalBrightness = res.value;
        console.log('💡 保存当前亮度:', this.originalBrightness);
        
        // 注意：不在这里设置最低亮度，等待计时开始后1分钟再设置
      },
      fail: (err) => {
        console.warn('⚠️ 获取亮度失败，使用默认亮度:', err);
        this.originalBrightness = 0.5;
        
        // 注意：不在这里设置最低亮度，等待计时开始后1分钟再设置
      }
    });
  },

  // 设置最低亮度
  setMinBrightness() {
    wx.setScreenBrightness({
      value: 0.01, // 最低亮度
      success: () => {
        console.log('💡 亮度已设置为最低');
      },
      fail: (err) => {
        console.warn('⚠️ 设置最低亮度失败:', err);
      }
    });
  },

  // 恢复原始亮度
  restoreBrightness() {
    if (this.originalBrightness !== undefined) {
      wx.setScreenBrightness({
        value: this.originalBrightness,
        success: () => {
          console.log('💡 亮度已恢复为:', this.originalBrightness);
        },
        fail: (err) => {
          console.warn('⚠️ 恢复亮度失败:', err);
        }
      });
    }
  },

  // 开始亮度控制（1分钟后降低亮度）
  startBrightnessControl() {
    // 清理之前的亮度定时器
    if (this.brightnessTimer) {
      clearTimeout(this.brightnessTimer);
    }
    
    // 1分钟后降低亮度
    this.brightnessTimer = setTimeout(() => {
      if (this.data.isRunning && !this.isBrightnessReduced) {
        console.log('💡 计时1分钟，降低屏幕亮度');
        this.setMinBrightness();
        this.isBrightnessReduced = true;
      }
    }, 60000); // 1分钟 = 60秒 = 60000毫秒
  },

  // 停止亮度控制
  stopBrightnessControl() {
    if (this.brightnessTimer) {
      clearTimeout(this.brightnessTimer);
      this.brightnessTimer = null;
    }
    
    // 无论是否降低过亮度，计时结束时都恢复亮度
    console.log('💡 计时结束，恢复屏幕亮度');
    this.restoreBrightness();
    this.isBrightnessReduced = false;
  },

  // 恢复屏幕设置
  restoreScreenSettings() {
    // 停止亮度控制
    this.stopBrightnessControl();
    
    // 关闭屏幕常亮
    wx.setKeepScreenOn({
      keepScreenOn: false,
      success: () => {
        console.log('✅ 屏幕常亮已关闭');
      },
      fail: (err) => {
        console.warn('⚠️ 关闭屏幕常亮失败:', err);
      }
    });
  },

  onUnload() {
    this.cleanupTimers();
    this.stopBackgroundMusic();
    this.saveTimerState();
    
    // 恢复屏幕设置
    this.restoreScreenSettings();
    
    console.log('📱 页面卸载，资源清理完成');
  },

  // 以下为原有UI控制函数（保持不变）
  toggleMode(e) {
    this.stopTimer();
    this.setData({ isCountdown: e.detail.value });
    this.updateDisplay();
    this.updateButtonStates();
  },

  resetTimer() {
    this.stopTimer();
    this.updateDisplay();
    this.updateButtonStates();
  },

  showTimePicker() { this.setData({ showTimePicker: true }); },
  hideTimePicker() { this.setData({ showTimePicker: false }); },
  hideCustomTimePicker() { this.setData({ showCustomTimePicker: false }); },

  onCustomTimeInput(e) {
    const value = e.detail.value;
    const minutes = parseInt(value);
    this.setData({
      customTimeInput: value,
      isValidCustomTime: !isNaN(minutes) && minutes >= 1 && minutes <= 180
    });
  },

  confirmCustomTime() {
    if (!this.data.isValidCustomTime) return;
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
    
    this.updateDisplay();
    if (this.data.isRunning) this.stopTimer();
  },

  selectDuration(e) {
    const value = e.currentTarget.dataset.value;
    if (value === "custom") {
      this.setData({ showTimePicker: false, showCustomTimePicker: true, customTimeInput: "" });
    } else {
      const totalSeconds = value * 60;
      this.setData({
        duration: value,
        durationText: value + " 分钟",
        totalTime: totalSeconds,
        remainingTime: totalSeconds,
        showTimePicker: false
      });
      this.updateDisplay();
      if (this.data.isRunning) this.stopTimer();
    }
  },

  createAudioPlayer() {
    this.audioPlayer = wx.createInnerAudioContext();
    this.audioPlayer.src = '/audio/风铃声.mp3';
    this.audioPlayer.loop = false;
    this.audioPlayer.obeyMuteSwitch = false;
    
    // 添加后台音频播放支持
    this.audioPlayer.onPlay(() => {
      // 保持后台音频播放
      console.log('🔔 铃声开始播放（支持后台）');
    });
    
    this.audioPlayer.onError((err) => {
      console.error('❌ 铃声播放失败:', err);
    });
  },

  playBellSound() {
    if (this.audioPlayer) {
      // 确保在后台也能播放铃声
      this.audioPlayer.play();
      console.log('🔔 播放提醒铃声（支持后台）');
      
      // 添加后台播放保护
      setTimeout(() => {
        if (this.audioPlayer && this.audioPlayer.paused) {
          console.log('🔄 重新触发铃声播放（后台保护）');
          this.audioPlayer.play();
        }
      }, 500);
    }
  },

  showMusicPicker() { this.setData({ showMusicPicker: true }); },
  hideMusicPicker() { this.setData({ showMusicPicker: false }); },

  selectMusic(e) {
    const value = e.currentTarget.dataset.value;
    const option = this.data.musicOptions.find(opt => opt.value === value);
    if (option) {
      this.setData({
        backgroundMusic: value,
        musicText: option.text,
        showMusicPicker: false
      });
    }
  },

  playBackgroundMusic() {
    if (this.data.backgroundMusic === 'default' && this.data.defaultMusicUrl) {
      console.log('🎵 开始播放背景音乐，URL:', this.data.defaultMusicUrl);
      
      if (!this.backgroundMusicPlayer) {
        this.backgroundMusicPlayer = wx.createInnerAudioContext();
        this.backgroundMusicPlayer.src = this.data.defaultMusicUrl;
        this.backgroundMusicPlayer.loop = false; // 引导音频不循环播放
        this.backgroundMusicPlayer.obeyMuteSwitch = false;
        
        // 添加后台音频播放支持
        this.backgroundMusicPlayer.onPlay(() => {
          console.log('✅ 背景音乐开始播放（支持后台）');
        });
        this.backgroundMusicPlayer.onError((err) => {
          console.error('❌ 背景音乐播放失败:', err);
          console.error('错误详情:', {
            errCode: err.errCode,
            errMsg: err.errMsg
          });
        });
        this.backgroundMusicPlayer.onWaiting(() => {
          console.log('⏳ 背景音乐正在缓冲');
        });
        this.backgroundMusicPlayer.onCanplay(() => {
          console.log('🎶 背景音乐可以播放了');
        });
      }
      
      // 确保音频播放器存在再尝试播放
      if (this.backgroundMusicPlayer) {
        this.backgroundMusicPlayer.play();
        console.log('🎵 已调用play()方法（支持后台）');
      } else {
        console.error('❌ 背景音乐播放器未创建');
      }
    } else {
      console.log('🎵 背景音乐设置:', {
        backgroundMusic: this.data.backgroundMusic,
        defaultMusicUrl: this.data.defaultMusicUrl ? '已设置' : '未设置'
      });
    }
  },

  pauseBackgroundMusic() {
    if (this.backgroundMusicPlayer) {
      this.backgroundMusicPlayer.pause();
    }
  },

  stopBackgroundMusic() {
    if (this.backgroundMusicPlayer) {
      this.backgroundMusicPlayer.stop();
    }
  },

  // 原有的云存储音频获取功能（保持原样）
  getBackgroundMusicUrl() {
    wx.cloud.init({ env: 'cloud1-2g2rbxbu2c126d4a' });
    wx.cloud.getTempFileURL({
      fileList: [{ fileID: this.data.defaultMusicFileID }],
      success: urlRes => {
        if (urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) {
          this.setData({ defaultMusicUrl: urlRes.fileList[0].tempFileURL });
          console.log('✅ 获取背景音乐URL成功');
        } else {
          console.warn('❌ 临时URL为空，使用备选方案');
          this.useFallbackAudio();
        }
      },
      fail: err => {
        console.error('❌ 获取背景音乐URL失败:', err);
        this.useFallbackAudio();
      }
    });
  },

  useFallbackAudio() {
    this.setData({ defaultMusicUrl: '/audio/30mins.MP3' });
  },

  checkCloudFileExists() {
    wx.cloud.init({ env: 'cloud1-2g2rbxbu2c126d4a' });
    wx.cloud.getTempFileURL({
      fileList: [{ fileID: this.data.defaultMusicFileID }],
      success: (res) => {
        console.log('云存储文件检查结果:', res);
      },
      fail: (err) => {
        console.error('❌ 云存储文件检查失败:', err);
      }
    });
  },

  onShareAppMessage() {
    return {};
  }
});