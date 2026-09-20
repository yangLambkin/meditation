// pages/timer/timer.js
const { createScreenBrightnessController } = require('../../utils/screenBrightness');
const checkinManager = require('../../utils/checkin');
const contentSec = require('../../utils/contentSec');
const DEFAULT_DURATIONS = [7, 10, 15, 20, 30, 60];
const DURATION_STORAGE_KEY = 'timerRecommendedDurations';
const MAX_SESSION_SECONDS = 24 * 60 * 60;

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
    timeOptions: DEFAULT_DURATIONS.map(value => ({ value, text: `${value} 分钟` })),
    editingDurations: false,
    customTimeTitle: '自定义时长',
    customTimeAction: 'select',
    editingDuration: null,
    isValidCustomTime: false,

    // 结束后可直接保存，也可附上一段感受。
    showCompletionDialog: false,
    completionDuration: 0,
    completionText: '',
    isSavingCompletion: false,
    completionNotice: '',

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
    this.sessionId = null;
    this.pendingCompletion = wx.getStorageSync('timerPendingCompletion') || null;
    this.setData({ completionNotice: wx.getStorageSync('timerCompletionNotice') || '' });
    this.loadDurationOptions();

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
    if (this.pendingCompletion) this.showCompletion();
    if (this.data.completionNotice) {
      wx.showToast({ title: this.data.completionNotice, icon: 'none', duration: 2500 });
      this.setData({ completionNotice: '' });
      wx.setStorageSync('timerCompletionNotice', '');
    }
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
      // 微信不区分关闭和切后台：正计时在此刻结束，不累计离线时间。
      if (!this.data.isCountdown && (this.data.isRunning || this.data.isPaused)) {
        this.finishSession(this.calculateElapsedTime(), { silent: true });
        return;
      }
      this.saveTimerState();
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
    if (this.data.isCountdown && expectedElapsed >= this.data.totalTime) {
      this.handleTimerFinished();
    } else if (!this.data.isCountdown && expectedElapsed >= MAX_SESSION_SECONDS) {
      this.finishSession(expectedElapsed);
    }
  },

  // 开始计时器
  startTimer() {
    if (this.data.isRunning || this.pendingCompletion || this.data.isSavingCompletion) return;
    const isResuming = this.data.isPaused;

    // 清理之前的计时器
    this.cleanupTimers();
    
    // 计算开始时间戳
    const now = Date.now();
    
    if (this.data.isPaused && this.data.pauseTimestamp > 0) {
      // 从暂停状态恢复，累计暂停时间
      const pausedDuration = now - this.data.pauseTimestamp;
      this.setData({
        totalPausedTime: this.data.totalPausedTime + pausedDuration,
        pauseTimestamp: 0
      });
    } else {
      // 一次静坐只有一个身份，完成、重试、重启恢复都复用。
      this.sessionId = `timer_${now}_${Math.random().toString(36).slice(2)}`;
      this.setData({
        elapsedTime: 0,
        remainingTime: this.data.totalTime,
        startTimestamp: now,
        totalPausedTime: 0,
        pauseTimestamp: 0
      });
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
    this.updateDisplay();
    this.saveTimerState();
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
    } else if (!this.data.isCountdown && elapsed >= MAX_SESSION_SECONDS) {
      this.finishSession(elapsed);
    } else if (!this.data.isCountdown && elapsed % 5 === 0) {
      // 若系统没有派发退出回调，最多恢复到最后一个前台检查点。
      this.saveTimerState();
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

  // 处理计时完成；以设定的结束时刻入账，不把后台延迟算入静坐。
  handleTimerFinished() {
    if (!this.data.isRunning && !this.data.isPaused) return;
    const endedAt = this.data.startTimestamp + this.data.totalPausedTime + this.data.totalTime * 1000;
    this.finishSession(this.data.totalTime, { endedAt });
  },

  finishSession(elapsedSeconds, { silent = false, endedAt = Date.now() } = {}) {
    if (!this.data.isRunning && !this.data.isPaused) return;
    if (elapsedSeconds >= MAX_SESSION_SECONDS) {
      elapsedSeconds = MAX_SESSION_SECONDS;
      endedAt = Math.min(endedAt, this.data.startTimestamp + this.data.totalPausedTime + MAX_SESSION_SECONDS * 1000);
    }
    const duration = Math.floor(Math.max(0, elapsedSeconds) / 60);
    const sessionId = this.sessionId || `timer_${this.data.startTimestamp}_${Math.random().toString(36).slice(2)}`;
    if (duration >= 1) {
      this.pendingCompletion = { sessionId, duration, endedAt, text: '' };
      wx.setStorageSync('timerPendingCompletion', this.pendingCompletion);
    }
    this.stopTimer({ playEndSound: !silent });
    this.setData({
      elapsedTime: Math.max(0, elapsedSeconds),
      remainingTime: Math.max(0, this.data.totalTime - elapsedSeconds)
    });
    this.updateDisplay();
    if (duration < 1) {
      if (silent) {
        this.setCompletionNotice('正计时已结束，不足1分钟未记录');
      } else {
        wx.showToast({ title: '不足1分钟，本次不会记录', icon: 'none', duration: 2500 });
      }
      return;
    }
    if (silent) {
      // 本地写入同步完成，系统随后挂起小程序也不会延长本次记录。
      const saved = this.saveCompletedSession('');
      this.setCompletionNotice(saved ? `正计时已结束，${duration}分钟已存本机，待上传` : '正计时已结束，请确认保存记录');
    } else {
      this.showCompletion();
    }
  },

  setCompletionNotice(notice) {
    this.setData({ completionNotice: notice });
    wx.setStorageSync('timerCompletionNotice', notice);
  },

  showCompletion() {
    if (!this.pendingCompletion) return;
    this.setData({
      showCompletionDialog: true,
      completionDuration: this.pendingCompletion.duration,
      completionText: this.pendingCompletion.text || ''
    });
  },

  onCompletionInput(e) {
    const text = String(e.detail.value || '').slice(0, 2000);
    this.setData({ completionText: text });
    if (this.pendingCompletion) {
      this.pendingCompletion.text = text;
      wx.setStorageSync('timerPendingCompletion', this.pendingCompletion);
    }
  },

  async confirmCompletion() {
    if (!this.pendingCompletion || this.data.isSavingCompletion) return;
    this.setData({ isSavingCompletion: true });
    const text = this.data.completionText.trim();
    try {
      if (text && !await contentSec.checkText(text, 2)) return;
      if (this.saveCompletedSession(text)) {
        // 此处只确认同步本地写入；云端确认与失败重试由持久上传队列负责。
        wx.showToast({ title: '已存本机，待上传', icon: 'none' });
      }
    } finally {
      if (!this.isUnloaded) this.setData({ isSavingCompletion: false });
    }
  },

  saveCompletedSession(text) {
    const completion = this.pendingCompletion;
    if (!completion) return false;
    const experience = text ? [{
      text,
      timestamp: completion.endedAt,
      emotion: [],
      duration: `${completion.duration}分钟`,
      uniqueId: completion.sessionId
    }] : [];
    try {
      const result = checkinManager.recordCheckin(
        completion.duration, [], experience, completion.endedAt, completion.sessionId
      );
      if (!result || !result.success) throw new Error('本地保存失败');
      wx.setStorageSync('timerPendingCompletion', null);
      this.pendingCompletion = null;
      this.setData({ showCompletionDialog: false, completionText: '' });
      return true;
    } catch (error) {
      console.error('静坐保存失败，保留本次记录以便重试:', error);
      if (this.isPageVisible && !this.isUnloaded) {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
      return false;
    }
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
    this.saveTimerState();
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
    this.sessionId = null;
    this.saveTimerState();
    console.log('⏹️ 计时器已停止');
  },

  // 用户结束时按实际已用分钟保存，暂停时间不计入。
  handleStop() {
    this.finishSession(this.calculateElapsedTime());
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
    const isActive = isRunning || this.data.isPaused;
    
    this.setData({
      showStartButton: !isRunning,
      showPauseButton: isRunning,
      showStopButton: isActive,
      showResetButton: isActive
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

  // 保存运行检查点。停止状态不保留可恢复的时间戳。
  saveTimerState() {
    if (!this.data.isRunning && !this.data.isPaused) {
      wx.setStorageSync('timerState', null);
      return;
    }
    wx.setStorageSync('timerState', {
      isCountdown: this.data.isCountdown,
      sessionId: this.sessionId,
      elapsedTime: this.calculateElapsedTime(),
      totalTime: this.data.totalTime,
      isRunning: this.data.isRunning,
      isPaused: this.data.isPaused,
      startTimestamp: this.data.startTimestamp,
      pauseTimestamp: this.data.pauseTimestamp,
      totalPausedTime: this.data.totalPausedTime,
      saveTime: Date.now()
    });
  },

  restoreTimerState() {
    const state = wx.getStorageSync('timerState');
    if (this.pendingCompletion) {
      wx.setStorageSync('timerState', null);
      return;
    }
    if (!state || (!state.isRunning && !state.isPaused)) return;
    // 旧缓存未保存模式或会话身份，不能据此累加关闭后的时间。
    if (typeof state.isCountdown !== 'boolean' || !state.sessionId) {
      wx.setStorageSync('timerState', null);
      return;
    }
    this.sessionId = state.sessionId;
    this.setData({
      isCountdown: state.isCountdown,
      totalTime: state.totalTime,
      duration: state.totalTime / 60,
      durationText: `${state.totalTime / 60} 分钟`,
      isRunning: state.isRunning,
      isPaused: state.isPaused,
      startTimestamp: state.startTimestamp,
      pauseTimestamp: state.pauseTimestamp,
      totalPausedTime: state.totalPausedTime || 0,
      elapsedTime: state.elapsedTime,
      remainingTime: Math.max(0, state.totalTime - state.elapsedTime)
    });
    if (!state.isCountdown) {
      this.finishSession(state.elapsedTime, { silent: true, endedAt: state.saveTime });
      return;
    }
    if (state.isRunning) {
      this.syncTimerTime();
      if (this.data.isRunning) this.createForegroundTimer();
    }
    this.updateDisplay();
    this.updateButtonStates();
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
    if (!this.data.isCountdown && (this.data.isRunning || this.data.isPaused)) {
      this.finishSession(this.calculateElapsedTime(), { silent: true });
    }
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

  // 模式与时长设置
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

  loadDurationOptions() {
    const stored = wx.getStorageSync(DURATION_STORAGE_KEY);
    const values = Array.isArray(stored)
      ? [...new Set(stored.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 180))]
      : DEFAULT_DURATIONS;
    this.setData({ timeOptions: values.sort((a, b) => a - b).map(value => ({ value, text: `${value} 分钟` })) });
  },

  saveDurationOptions(values) {
    const durations = [...new Set(values)].sort((a, b) => a - b);
    wx.setStorageSync(DURATION_STORAGE_KEY, durations);
    this.setData({ timeOptions: durations.map(value => ({ value, text: `${value} 分钟` })) });
  },

  showTimePicker() { this.setData({ showTimePicker: true, editingDurations: false }); },
  hideTimePicker() { this.setData({ showTimePicker: false }); },
  hideCustomTimePicker() { this.setData({ showCustomTimePicker: false }); },
  toggleDurationEditing() { this.setData({ editingDurations: !this.data.editingDurations }); },

  openCustomTime(action, value = null) {
    this.setData({
      showTimePicker: false,
      showCustomTimePicker: true,
      customTimeAction: action,
      editingDuration: value,
      customTimeTitle: action === 'edit' ? '编辑推荐时长' : action === 'add' ? '添加推荐时长' : '自定义时长',
      customTimeInput: value === null ? '' : String(value),
      isValidCustomTime: value !== null
    });
  },

  addRecommendedDuration() { this.openCustomTime('add'); },
  chooseCustomDuration() { this.openCustomTime('select'); },
  editRecommendedDuration(e) { this.openCustomTime('edit', Number(e.currentTarget.dataset.value)); },
  removeRecommendedDuration(e) {
    const value = Number(e.currentTarget.dataset.value);
    this.saveDurationOptions(this.data.timeOptions.map(item => item.value).filter(item => item !== value));
  },

  onCustomTimeInput(e) {
    const value = e.detail.value;
    const minutes = Number(value);
    this.setData({
      customTimeInput: value,
      isValidCustomTime: /^\d+$/.test(value) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 180
    });
  },

  confirmCustomTime() {
    const minutes = Number(this.data.customTimeInput);
    if (!this.data.isValidCustomTime || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) return;
    const action = this.data.customTimeAction;
    if (action === 'add' || action === 'edit') {
      const values = this.data.timeOptions.map(item => item.value)
        .filter(value => action !== 'edit' || value !== this.data.editingDuration);
      this.saveDurationOptions([...values, minutes]);
      this.setData({ showCustomTimePicker: false, showTimePicker: true, customTimeInput: '' });
      return;
    }
    this.applyDuration(minutes);
  },

  applyDuration(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return;
    this.stopTimer({ playEndSound: false });
    this.setData({
      duration: minutes,
      durationText: `${minutes} 分钟`,
      totalTime: minutes * 60,
      remainingTime: minutes * 60,
      showTimePicker: false,
      showCustomTimePicker: false,
      customTimeInput: ''
    });
    this.updateDisplay();
  },

  selectDuration(e) {
    const value = e.currentTarget.dataset.value;
    if (value === 'custom') return this.chooseCustomDuration();
    if (this.data.editingDurations) return this.editRecommendedDuration(e);
    this.applyDuration(Number(value));
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

  // 开始后留出 5 秒准备时间；暂停时保留剩余等待时间。
  scheduleStartSound(delay = 5000) {
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
