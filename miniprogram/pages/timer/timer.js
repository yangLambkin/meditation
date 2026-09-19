// pages/timer/timer.js - 使用wx.createBackgroundTimer的稳定方案
const { createScreenBrightnessController } = require('../../utils/screenBrightness');

Page({
  data: {
    // 计时器状态
    isRunning: false,
    isPaused: false,
    isCountdown: true,
    
    // 时间设置
    totalTime: 1800,
    elapsedTime: 0,
    remainingTime: 1800,
    
    // 时长选择
    duration: 30,
    durationText: "30 分钟",
    showTimePicker: false,
    showCustomTimePicker: false,
    customTimeInput: "",
    timeOptions: [
      { value: 7, text: "7 分钟" },
      { value: 10, text: "10 分钟" },
      { value: 15, text: "15 分钟" },
      { value: 20, text: "20 分钟" },
      { value: 30, text: "30 分钟" },
      { value: 60, text: "60 分钟" },
      { value: "custom", text: "自定义" }
    ],
    
    isValidCustomTime: false,
    
    // 计时器控制
    timerInterval: null,
    
    // 进度显示
    progressAngleLeft: 0,
    progressAngleRight: 0,
    displayTime: "30:00",
    
    // 按钮状态
    showStartButton: true,
    showPauseButton: false,
    showStopButton: false,
    showResetButton: false,
    
    // 按钮图标
    startIcon: "/images/icons/start.png",
    pauseIcon: "/images/icons/pause.png",
    stopIcon: "/images/icons/stop.png",
    resetIcon: "/images/icons/resetting.png",
    
    // 音频播放器
    audioPlayer: null,
    
    // 背景音乐相关
    showMusicPicker: false,
    backgroundMusic: 'none',
    musicText: '无音乐',
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
    this.brightnessTimer = null;
    this.screenBrightness = createScreenBrightnessController(wx);
    this.isPageVisible = false;
    this.isUnloaded = false;

    this.updateDisplay();
    this.updateButtonStates();
    this.createAudioPlayer();
    this.checkCloudFileExists();
    this.getBackgroundMusicUrl();
    this.setupAppStateListeners();
    this.restoreTimerState();
  },

  onShow() {
    this.isPageVisible = true;
    this.setKeepScreenOn();
    if (this.data.isRunning) {
      this.syncTimerTime();
      this.startBrightnessControl();
    }
  },

  onHide() {
    this.isPageVisible = false;
    this.restoreScreenSettings();
  },

  // 设置应用状态监听
  setupAppStateListeners() {
    // 应用进入前台（屏幕打开）
    this.appShowHandler = () => {
      if (this.isUnloaded) return;
      console.log('📱 应用进入前台，同步时间');
      if (this.data.isRunning) {
        this.syncTimerTime();
      }
      // 屏幕设置只由计时页 onShow 激活，其他页回前台时不修改。
    };
    
    // 应用进入后台（屏幕关闭）
    this.appHideHandler = () => {
      if (this.isUnloaded) return;
      this.isPageVisible = false;
      this.restoreScreenSettings();
      console.log('📱 应用进入后台，保存状态');
      this.saveTimerState();
      
      // 确保后台音频继续播放
      this.ensureBackgroundAudioPlayback();
    };
    wx.onAppShow(this.appShowHandler);
    wx.onAppHide(this.appHideHandler);
  },

  // 确保后台音频播放
  ensureBackgroundAudioPlayback() {
    // 如果计时器正在运行，确保背景音乐在后台继续播放
    if (this.data.isRunning && this.backgroundMusicPlayer) {
      console.log('🎵 确保后台音频继续播放');
      
      // 重新播放背景音乐（如果被系统暂停）
      setTimeout(() => {
        if (this.backgroundMusicPlayer && this.data.isRunning) {
          this.playBackgroundMusic();
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
    if (this.data.isRunning) return;
    const isResuming = this.data.isPaused;

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

    if (!isResuming) {
      this.stopBackgroundMusic();
      this.stopSessionSound();
      this.scheduleStartSound();
    } else if (this.startSoundRemaining !== null) {
      this.scheduleStartSound(this.startSoundRemaining);
    } else if (this.currentSessionSound === 'start') {
      // 暂停后继续未播完的起坐音频，不从头重播。
      this.audioPlayer.play();
    } else {
      this.playBackgroundMusic();
    }

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
    
    // 检查是否完成（仅倒计时模式：到达设定时长才自动结束）
    if (this.data.isCountdown && elapsed >= this.data.totalTime) {
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
    
    // 播放收坐音频
    this.playSessionSound('end');
    
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
    
    // 同时取消尚未触发的调暗，恢复本次实际修改过的亮度。
    this.stopBrightnessControl();
    
    this.setData({
      isRunning: false,
      isPaused: true,
      pauseTimestamp: Date.now()
    });
    
    // 暂停背景音乐
    this.pauseBackgroundMusic();
    if (this.startSoundTimer !== null) {
      clearTimeout(this.startSoundTimer);
      this.startSoundTimer = null;
      this.startSoundRemaining = Math.max(0,
        this.startSoundRemaining - (Date.now() - this.startSoundScheduledAt));
    }
    if (this.currentSessionSound === 'start' && this.audioPlayer) {
      this.audioPlayer.pause();
    }
    
    this.updateButtonStates();
    console.log('⏸️ 计时器已暂停');
  },

  // 停止计时器
  stopTimer({ playEndSound = true } = {}) {
    const wasActive = this.data.isRunning || this.data.isPaused;
    
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
    this.stopSessionSound();
    
    // 运行中或暂停后结束，均播放收坐音频。
    if (wasActive && playEndSound) {
      this.playSessionSound('end');
    }
    
    this.updateDisplay();
    this.updateButtonStates();
    console.log('⏹️ 计时器已停止');
  },

  // 停止（用户点击「停止」按钮）
  // 两种模式均按实际已用时长处理，满 1 分钟才进入记录页
  handleStop() {
    if (!this.data.isRunning && !this.data.isPaused) return;

    // 按实际已用秒数向下取整为分钟，不计入暂停时间
    const elapsedSeconds = this.calculateElapsedTime();
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);

    // 先清理计时资源（停定时器/音乐/亮度），再提示或跳转
    this.stopTimer();

    if (elapsedMinutes < 1) {
      wx.showToast({
        title: '不足1分钟，本次不会记录',
        icon: 'none',
        duration: 2500
      });
      return;
    }

    console.log('⏹️ 计时停止，实际时长:', elapsedMinutes + '分钟');

    wx.navigateTo({
      url: '/pages/recorder/recorder?duration=' + elapsedMinutes
    });
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
      showResetButton: isRunning || this.data.isPaused || hasStarted
    });
  },

  // 更新显示时间和进度
  updateDisplay() {
    let displaySeconds = this.data.isCountdown ? this.data.remainingTime : this.data.elapsedTime;
    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    const displayTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // 倒计时从完整圆环逐渐缩短；正计时始终保持完整的单色圆环。
    const remainingRatio = this.data.totalTime > 0
      ? Math.min(1, Math.max(0, this.data.remainingTime / this.data.totalTime))
      : 0;
    const progressAngle = this.data.isCountdown ? remainingRatio * 360 : 360;

    this.setData({
      displayTime: displayTime,
      // 每个半圆从 -180°（隐藏）转到 0°（完整显示）。
      progressAngleLeft: Math.max(0, progressAngle - 180) - 180,
      progressAngleRight: Math.min(180, progressAngle) - 180
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
            this.startTimer();

            // 开始计时后才允许调暗；确认弹窗的回调也受页面可见性约束。
            if (estimatedElapsed >= 60) {
              console.log('💡 恢复计时，已超过1分钟，立即降低亮度');
              this.startBrightnessControl(0);
            }
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
    if (!this.isPageVisible || this.isUnloaded) return;
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

  // 设置最低亮度
  setMinBrightness() {
    if (!this.isPageVisible || this.isUnloaded || !this.data.isRunning) return;
    this.screenBrightness.dim();
  },

  // 开始亮度控制（1分钟后降低亮度）
  startBrightnessControl(delay = 60000) {
    if (this.brightnessTimer !== null) {
      clearTimeout(this.brightnessTimer);
      this.brightnessTimer = null;
    }
    if (!this.isPageVisible || this.isUnloaded || !this.data.isRunning) return;

    this.brightnessTimer = setTimeout(() => {
      this.brightnessTimer = null;
      this.setMinBrightness();
    }, delay);
  },

  // 停止亮度控制
  stopBrightnessControl() {
    if (this.brightnessTimer !== null) {
      clearTimeout(this.brightnessTimer);
      this.brightnessTimer = null;
    }
    
    this.screenBrightness.restore();
  },

  // 恢复屏幕设置
  restoreScreenSettings() {
    // 停止亮度控制
    this.stopBrightnessControl();
    
    // 常亮仅限计时页可见期间；重复关闭也允许上次失败后重试。
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
    this.isUnloaded = true;
    this.isPageVisible = false;
    wx.offAppShow(this.appShowHandler);
    wx.offAppHide(this.appHideHandler);
    this.cleanupTimers();
    this.stopBackgroundMusic();
    this.stopSessionSound();
    if (this.audioPlayer) {
      this.audioPlayer.destroy();
      this.audioPlayer = null;
    }
    this.saveTimerState();
    
    // 恢复屏幕设置
    this.restoreScreenSettings();
    
    console.log('📱 页面卸载，资源清理完成');
  },

  // 以下为原有UI控制函数（保持不变）
  toggleMode(e) {
    this.stopTimer({ playEndSound: false });
    this.setData({ isCountdown: e.detail.value });
    this.updateDisplay();
    this.updateButtonStates();
  },

  resetTimer() {
    this.stopTimer({ playEndSound: false });
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
    if (this.data.isRunning || this.data.isPaused) this.stopTimer({ playEndSound: false });
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
      if (this.data.isRunning || this.data.isPaused) this.stopTimer({ playEndSound: false });
    }
  },

  createAudioPlayer() {
    this.currentSessionSound = null;
    this.startSoundTimer = null;
    this.startSoundRemaining = null;
    this.startSoundScheduledAt = 0;
    this.audioPlayer = wx.createInnerAudioContext();
    this.audioPlayer.loop = false;
    this.audioPlayer.obeyMuteSwitch = false;

    this.audioPlayer.onPlay(() => {
      console.log('🔔 打坐提示音开始播放:', this.currentSessionSound);
    });

    this.audioPlayer.onEnded(() => this.handleSessionSoundEnded());
    this.audioPlayer.onError((err) => {
      console.error('❌ 打坐提示音播放失败:', err);
      this.handleSessionSoundEnded();
    });
  },

  // 开始后留出 3 秒准备时间；暂停时保留剩余等待时间。
  scheduleStartSound(delay = 3000) {
    this.startSoundRemaining = delay;
    this.startSoundScheduledAt = Date.now();
    this.startSoundTimer = setTimeout(() => {
      this.startSoundTimer = null;
      this.startSoundRemaining = null;
      if (this.data.isRunning && !this.isUnloaded) {
        this.playSessionSound('start');
      }
    }, delay);
  },

  playSessionSound(type) {
    if (!this.audioPlayer || this.isUnloaded) return;
    this.stopSessionSound();
    this.currentSessionSound = type;
    this.audioPlayer.src = type === 'start' ? '/audio/起坐.mp3' : '/audio/收坐.mp3';
    this.audioPlayer.play();
  },

  stopSessionSound() {
    if (this.startSoundTimer !== null) {
      clearTimeout(this.startSoundTimer);
      this.startSoundTimer = null;
    }
    this.startSoundRemaining = null;
    this.currentSessionSound = null;
    if (this.audioPlayer) this.audioPlayer.stop();
  },

  handleSessionSoundEnded() {
    const wasStartSound = this.currentSessionSound === 'start';
    this.currentSessionSound = null;
    // 起坐播完后才接着播放引导，避免两段音频同时播放。
    if (wasStartSound && this.data.isRunning && !this.isUnloaded) {
      this.playBackgroundMusic();
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
    if (this.startSoundRemaining !== null || this.currentSessionSound === 'start') return;
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
