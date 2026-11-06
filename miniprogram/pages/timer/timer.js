// pages/timer/timer.js
const { createScreenBrightnessController } = require('../../utils/screenBrightness');
const checkinManager = require('../../utils/checkin');
const contentSec = require('../../utils/contentSec');
const dailyCardImage = require('../../utils/dailyCardImage');
const { isExplicitTimerExit } = require('../../utils/timerInterruption');
const { timerAudioMethods } = require('../../utils/timerAudio');
const { queueEndReminder } = require('../../utils/timerEndReminder');
const DEFAULT_DURATIONS = [7, 10, 15, 20, 30, 60];
const DURATION_STORAGE_KEY = 'timerRecommendedDurations';
const MAX_SESSION_SECONDS = 24 * 60 * 60;

Page({
  ...timerAudioMethods,
  data: {
    // 计时器状态
    isRunning: false,
    isPaused: false,
    isCountdown: true,
    
    // 时间设置
    totalTime: DEFAULT_DURATIONS[0] * 60,
    elapsedTime: 0,
    remainingTime: DEFAULT_DURATIONS[0] * 60,
    
    // 时长选择
    duration: DEFAULT_DURATIONS[0],
    durationText: `${DEFAULT_DURATIONS[0]} 分钟`,
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
    isCompletionSaved: false,
    completionAction: '',
    completionDailyFailed: false,
    completionNotice: '',

    // 进度显示
    progressAngleLeft: 0,
    progressAngleRight: 0,
    isProgressAnimating: false,
    displayTime: `${String(DEFAULT_DURATIONS[0]).padStart(2, '0')}:00`,
    
    // 按钮状态
    showStartButton: true,
    showPauseButton: false,
    showStopButton: false,
    showResetButton: false,
    
    // 使用矢量图标，避免高清屏放大小尺寸位图后模糊。
    startIcon: "/images/icons/timer-start.svg",
    pauseIcon: "/images/icons/timer-pause.svg",
    stopIcon: "/images/icons/timer-stop.svg",
    resetIcon: "/images/icons/timer-reset.svg",
    
    // 背景音乐相关
    showMusicPicker: false,
    backgroundMusic: 'none',
    musicText: '无音乐',
    musicOptions: [
      { value: 'default', text: '引导音频' },
      { value: 'none', text: '无音乐' }
    ],
    defaultMusicFileID: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/audio/万能引导片段.mp3',
    defaultMusicUrl: '',
    
    // 时间戳用于精确计时
    startTimestamp: 0,
    pauseTimestamp: 0,
    totalPausedTime: 0
  },

  onLoad(options) {
    this.brightnessTimer = null;
    this.timerInterval = null;
    this.screenBrightness = createScreenBrightnessController(wx);
    this.isPageVisible = false;
    this.isUnloaded = false;
    this.isOpeningDaily = false;
    this.didOpenDaily = false;
    this._dailyCompletion = null;
    this._countupTerminal = null;
    this._countupObservedAt = Date.now();
    this.sessionId = null;
    this.timerApp = getApp();
    this.timerApp._timerPage = this;
    if (!this.timerApp._timerRuntimeId) {
      this.timerApp._timerRuntimeId = `timer_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    this.isAppHidden = this.timerApp._timerForeground === false;
    this.countdownSession = this.timerApp.getCountdownSession();
    this.pendingCompletion = null;
    this.readPendingCompletion();
    this.safeTimerEffect('read_completion_notice', () => this.setData({
      completionNotice: wx.getStorageSync('timerCompletionNotice') || ''
    }));
    this.loadDurationOptions();

    this.updateDisplay();
    this.updateButtonStates();
    this.initializeSessionAudio();
    this.safeTimerEffect('load_guide', () => this.getBackgroundMusicUrl());
    this.setupAppStateListeners();
    this.timerApp._detachedCountupSessionId = null;
    this.timerApp._detachedCountupState = null;
    this.detachCountdown = this.countdownSession.attach((state, event) => this.onCountdownState(state, event));
    this.restoreTimerState();
    this.safeTimerEffect('restore_audio', () => this.restoreSessionAudio());
  },

  // 主动离页结算；来电等被动中断保留同一会话。
  onCountdownState(state, event = {}) {
    if (this.isUnloaded) return;
    if (event.type === 'restore' || event.type === 'exit' || event.automatic) {
      // 冷恢复可能在 attach 内才生成通知；以存储为准，已展示的通知不再重复。
      this.safeTimerEffect('restore_notice', () => this.setData({
        completionNotice: wx.getStorageSync('timerCompletionNotice') || ''
      }));
    }
    if (!state.sessionId) return;
    if (event.automatic) this._automaticExitSessionId = state.sessionId;
    // 已结束的旧倒计时不能覆盖后续正计时尚未确认的感受草稿。
    if (this.pendingCompletion && this.pendingCompletion.sessionId !== state.sessionId) return;
    if (state.status === 'cancelled' && event.type === 'restore') return;
    if ((state.status === 'completed' || state.status === 'exited') && !state.pendingCompletion
      && this.pendingCompletion && this.pendingCompletion.sessionId === state.sessionId) {
      // attach 的恢复可能刚确认该草稿已入账，不能保留 onLoad 先读到的旧副本。
      this.pendingCompletion = null;
      if (this.data.showCompletionDialog) this.safeTimerEffect('render_saved_completion', () => this.setData({ isCompletionSaved: true }));
    }
    // 新页面保留推荐时长；已结算且无草稿的旧会话仅用于防止重复入账。
    // 同一页面仍需接收终态，修正退出时可能未能渲染的运行/暂停状态。
    if (event.type === 'restore' && (state.status === 'completed' || state.status === 'exited')
      && !state.pendingCompletion && this.sessionId !== state.sessionId) return;
    if (!state.isRunning && !state.isPaused && this.sessionId !== state.sessionId
      && event.type !== 'restore' && event.type !== 'complete' && event.type !== 'exit') return;
    if (this.sessionId && this.sessionId !== state.sessionId && !this.data.isCountdown) return;
    this.sessionId = state.sessionId;
    const manual = state.status === 'completed' && state.terminalReason === 'manual';
    this.pendingCompletion = state.pendingCompletion || null;
    this.safeTimerEffect('render_countdown', () => {
      const animateProgress = event.type === 'tick' && this.data.isRunning
        && state.remainingTime < this.data.remainingTime;
      this.setData({
        isCountdown: true,
        totalTime: state.totalTime,
        duration: state.totalTime / 60,
        durationText: `${state.totalTime / 60} 分钟`,
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        startTimestamp: state.startTimestamp,
        pauseTimestamp: state.pauseTimestamp,
        totalPausedTime: state.totalPausedTime,
        elapsedTime: manual ? 0 : state.elapsedTime,
        remainingTime: manual ? state.totalTime : state.remainingTime
      });
      this.updateDisplay({ animateProgress });
      this.updateButtonStates();
    });
    if (event.type === 'complete' || event.type === 'exit') {
      this.safeTimerEffect('clear_audio_recovery', () => this.clearSessionAudioRecovery());
      this.safeTimerEffect('stop_brightness', () => this.stopBrightnessControl());
      this.safeTimerEffect('stop_guide', () => this.stopBackgroundMusic());
      this.safeTimerEffect('stop_cue', () => this.stopSessionSound());
      if (event.type === 'complete' && !event.automatic && !this.isLeavingTimer) {
        this.safeTimerEffect('end_cue', () => this.playSessionSound('end'));
        if (this.pendingCompletion) this.safeTimerEffect('show_completion', () => this.showCompletion());
        else wx.showToast({ title: '不足1分钟，本次不会记录', icon: 'none', duration: 2500 });
      }
    }
  },

  safeTimerEffect(type, action) {
    try { return action(); }
    catch (error) {
      if (this.countdownSession) this.countdownSession.diagnose(`${type}_error`, { message: String(error && error.message || error).slice(0, 160) });
      console.warn('计时附属操作失败，保留会话状态:', type);
    }
  },

  readPendingCompletion() {
    try {
      const completion = wx.getStorageSync('timerPendingCompletion');
      if (completion) this.pendingCompletion = completion;
      this._completionReadPending = false;
    } catch (error) {
      this._completionReadPending = true;
      this.countdownSession.diagnose('completion_read_error', { message: String(error && error.message || error) });
    }
  },

  retryTimerRecovery() {
    const countdown = this.countdownSession && this.countdownSession.restore();
    if (this._completionReadPending) this.readPendingCompletion();
    if (this._timerStateReadPending) this.restoreTimerState();
    if (countdown && (countdown.isRunning || countdown.isPaused
      || (this.data.isCountdown && countdown.sessionId && countdown.sessionId === this.sessionId))) {
      this.safeTimerEffect('restore_countdown', () => this.onCountdownState(countdown, { type: 'restore' }));
    }
  },

  isTimerRecoveryPending() {
    return !!(this._completionReadPending || this._timerStateReadPending
      || this.countdownSession && this.countdownSession.getSnapshot().restorePending);
  },

  onShow() {
    this.isPageVisible = true;
    // 路由动画期间保留完成弹窗，回到计时页时再清理，避免先闪回计时界面。
    if (this.didOpenDaily) this.safeTimerEffect('close_completion', () => this.closeCompletionDialog());
    this.retryTimerRecovery();
    this.safeTimerEffect('keep_screen_on', () => this.setKeepScreenOn());
    if (this.pendingCompletion) this.safeTimerEffect('show_completion', () => this.showCompletion());
    if (this.data.completionNotice) {
      this.safeTimerEffect('show_completion_notice', () => wx.showToast({
        title: this.data.completionNotice, icon: 'none', duration: 2500
      }));
      if (typeof this.timerApp.consumeDetachedCountupExitNotice === 'function') {
        this.timerApp.consumeDetachedCountupExitNotice(this.detachedExitNoticeSessionId);
      }
      this.data.completionNotice = '';
      this.safeTimerEffect('render_completion_notice', () => this.setData({ completionNotice: '' }));
      this.safeTimerEffect('clear_completion_notice', () => wx.setStorageSync('timerCompletionNotice', ''));
    }
    if (this.data.isRunning) {
      this.safeTimerEffect('sync_timer', () => this.syncTimerTime());
      this.safeTimerEffect('start_brightness', () => this.startBrightnessControl());
    }
    this.safeTimerEffect('resume_audio', () => this.resumeInterruptedAudio({ allowEndRetry: true }));
  },

  onHide() {
    this.isPageVisible = false;
    if (!this.isAppHidden && this.timerApp._timerForeground !== false) {
      if (this.isOpeningDaily || this.didOpenDaily) {
        this.safeTimerEffect('dismiss_end_reminder', () => this.dismissSessionEndReminder());
        this.safeTimerEffect('hide_guide', () => this.stopBackgroundMusic());
      } else {
        // PageHide 可能先于系统中断的 AppHide；保留提醒，等计时页可见再继续。
        this.safeTimerEffect('hide_audio', () => this.suspendSessionAudio());
      }
    }
    this.safeTimerEffect('page_hide_screen', () => this.restoreScreenSettings());
    this.countdownSession.diagnose('page_hide');
  },

  // 设置应用状态监听
  setupAppStateListeners() {
    // 应用进入前台（屏幕打开）
    this.appShowHandler = () => {
      if (this.isUnloaded) return;
      const wasHidden = this.isAppHidden;
      this.isAppHidden = false;
      console.log('📱 应用进入前台，同步时间');
      if (this.data.isRunning) {
        this.syncTimerTime();
        if (wasHidden && !this.data.isCountdown && this.data.isRunning) {
          this.createForegroundTimer();
          this.saveTimerState();
        }
      }
      // 屏幕设置只由计时页 onShow 激活，其他页回前台时不修改。
      this.safeTimerEffect('resume_audio', () => this.resumeInterruptedAudio());
    };
    
    // 应用进入后台（屏幕关闭）
    this.appHideHandler = (options) => {
      if (this.isUnloaded) return;
      this.isPageVisible = false;
      const exiting = isExplicitTimerExit(options);
      const wasHidden = this.isAppHidden;
      this.isAppHidden = true;
      if (exiting) {
        this.finishSession(this.calculateElapsedTime(), { reason: 'app_hide' });
        this.savePendingCompletionOnExit();
      } else if (!this.data.isCountdown && (this.data.isRunning || this.data.isPaused)) {
        if (!wasHidden) {
          this.safeTimerEffect('save_interrupted_state', () => this.saveTimerState({ interrupted: true }));
          this.cleanupTimers();
        }
      }
      this.safeTimerEffect('exit_screen', () => this.restoreScreenSettings());
      if (exiting) {
        this.safeTimerEffect('dismiss_end_reminder', () => this.dismissSessionEndReminder());
        this.safeTimerEffect('exit_cue', () => this.destroyAudioPlayer());
        this.safeTimerEffect('exit_guide', () => this.stopBackgroundMusic());
      } else {
        this.safeTimerEffect('interrupt_audio', () => this.suspendSessionAudio());
      }
    };
    this.audioInterruptionBeginHandler = () => {
      if (this.isUnloaded) return;
      this.timerApp._timerAudioInterrupted = true;
      this.countdownSession.diagnose('audio_interruption_begin');
      this.safeTimerEffect('interrupt_audio', () => this.suspendSessionAudio());
    };
    this.audioInterruptionEndHandler = () => {
      if (this.isUnloaded) return;
      this.timerApp._timerAudioInterrupted = false;
      this.countdownSession.diagnose('audio_interruption_end');
      this.safeTimerEffect('resume_audio', () => this.resumeInterruptedAudio());
    };
    wx.onAppShow(this.appShowHandler);
    wx.onAppHide(this.appHideHandler);
    if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(this.audioInterruptionBeginHandler);
    if (wx.onAudioInterruptionEnd) wx.onAudioInterruptionEnd(this.audioInterruptionEndHandler);
  },

  // 前台刷新和回到页面共用墙钟计算，不再维护第二套校正公式。
  syncTimerTime() {
    this.updateForegroundTimer({ sync: true });
  },

  // 开始计时器
  startTimer() {
    if (this.isTimerRecoveryPending()) {
      this.retryTimerRecovery();
      if (this.isTimerRecoveryPending()) {
        this.safeTimerEffect('show_recovery_notice', () => wx.showToast({ title: '上次静坐尚未恢复，请稍后重试', icon: 'none' }));
        return;
      }
      if (this.pendingCompletion) this.safeTimerEffect('show_completion', () => this.showCompletion());
    }
    if (this.data.isRunning || this.pendingCompletion || this.data.isSavingCompletion || this.data.isCompletionSaved) return;
    const isResuming = this.data.isPaused;
    if (!isResuming && !this.data.isCountdown) {
      const ready = this.safeTimerEffect('prepare_countup', () => {
        const pending = wx.getStorageSync('timerPendingCompletion');
        if (!pending) return true;
        const saved = this.timerApp._timerSavedCompletionIds;
        if (saved && saved.has(pending.sessionId)) {
          wx.setStorageSync('timerPendingCompletion', null);
          return true;
        }
        this.pendingCompletion = pending;
        this.showCompletion();
        return false;
      });
      if (!ready) return;
    }
    if (!isResuming) this._dailyCompletion = null;

    // 清理之前的计时器
    this.cleanupTimers();
    
    // 计算开始时间戳
    const now = Date.now();
    if (!this.data.isCountdown && isResuming) this.reconcileCountupClock(now);
    
    if (this.data.isCountdown) {
      const sessionId = isResuming ? this.sessionId : `timer_${now}_${Math.random().toString(36).slice(2)}`;
      if (isResuming) this.countdownSession.resume();
      else this.countdownSession.start({ sessionId, totalTime: this.data.totalTime, startTimestamp: now });
      const state = this.countdownSession.getSnapshot();
      this.onCountdownState(state, { type: 'restore' });
      // 暂停后可能已经真实退出；以控制器结果为准，不能由页面先置为运行中。
      if (!state.isRunning || state.sessionId !== sessionId) return;
    } else if (this.data.isPaused && this.data.pauseTimestamp > 0) {
      // 从暂停状态恢复，累计暂停时间
      const pausedDuration = Math.max(0, now - this.data.pauseTimestamp);
      this.setData({
        ...(now < this.data.pauseTimestamp ? {
          startTimestamp: now - this.data.totalPausedTime - this.data.elapsedTime * 1000
        } : {}),
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
    
    if (!this.data.isCountdown) {
      this._countupObservedAt = now;
      this._countupTerminal = null;
      this.setData({ isRunning: true, isPaused: false });
      this.createForegroundTimer();
    }
    this.safeTimerEffect('keep_screen_on', () => this.setKeepScreenOn());
    this.safeTimerEffect('start_audio', () => this.startSessionAudio({ resume: isResuming }));
    // 屏幕和音频失败不会中止已经创建的会话。
    this.safeTimerEffect('start_brightness', () => this.startBrightnessControl());
    
    console.log('✅ 启动前台计时器（屏幕常亮模式）');

    this.updateButtonStates();
    this.updateDisplay();
    this.saveTimerState();
  },

  // 创建前台计时器
  createForegroundTimer() {
    this.cleanupTimers();
    this.timerInterval = setInterval(() => {
      this.updateForegroundTimer();
    }, 1000);
  },

  // 前台计时器更新（屏幕常亮模式）
  updateForegroundTimer({ sync = false } = {}) {
    if (this.data.isCountdown) { this.countdownSession.tick(); return; }
    if (!this.data.isRunning || (!sync && this.isAppHidden)) return;
    
    const elapsed = this.calculateElapsedTime();
    this.setData({
      elapsedTime: elapsed,
      remainingTime: Math.max(0, this.data.totalTime - elapsed)
    });
    
    this.updateDisplay();
    
    if (elapsed >= MAX_SESSION_SECONDS) {
      this.finishSession(elapsed, { reason: 'limit' });
    } else if (!sync && elapsed % 5 === 0) {
      // 保存原时间基准；即使系统未派发退出回调，重开仍按同一次静坐继续累计。
      this.saveTimerState();
    }
  },

  // 计算已用时间
  reconcileCountupClock(at = Date.now()) {
    const previous = this._countupObservedAt;
    this._countupObservedAt = at;
    if (this.data.isCountdown || (!this.data.isRunning && !this.data.isPaused)
      || !Number.isFinite(previous) || at >= previous) return;
    const adjustment = at - previous;
    const anchors = { startTimestamp: this.data.startTimestamp + adjustment,
      pauseTimestamp: this.data.isPaused ? this.data.pauseTimestamp + adjustment : 0 };
    // 时间回拨只移动墙钟基准，不能扣除已经确认的静坐时长或写出无效检查点。
    Object.assign(this.data, anchors);
    this.safeTimerEffect('render_countup_clock', () => this.setData(anchors));
    this.countdownSession.diagnose('countup_clock_rollback', { adjustmentMs: adjustment });
  },

  calculateElapsedTime() {
    if (this.data.isCountdown) {
      const state = this.countdownSession.getSnapshot();
      if (state.sessionId === this.sessionId) return state.elapsedTime;
    }
    if (!this.data.startTimestamp) return 0;
    
    const currentTime = Date.now();
    this.reconcileCountupClock(currentTime);
    const pausedTime = this.data.pauseTimestamp > 0 ? 
      (currentTime - this.data.pauseTimestamp) : 0;
    
    return Math.max(0, this.data.elapsedTime, Math.floor(
      (currentTime - this.data.startTimestamp - this.data.totalPausedTime - pausedTime) / 1000
    ));
  },

  // 处理计时完成；以设定的结束时刻入账，不把后台延迟算入静坐。
  handleTimerFinished() {
    if (this.data.isCountdown) { this.countdownSession.finish('deadline'); return; }
    if (!this.data.isRunning && !this.data.isPaused) return;
    const elapsed = this.calculateElapsedTime();
    if (elapsed >= MAX_SESSION_SECONDS) this.finishSession(elapsed, { reason: 'limit' });
  },

  finishSession(elapsedSeconds, { endedAt = Date.now(), resetDisplay = false, reason = 'unknown' } = {}) {
    if (this.data.isCountdown) { this.countdownSession.finish(reason); return; }
    if (!this.data.isRunning && !this.data.isPaused) return;
    const automatic = reason === 'app_hide' || reason === 'page_unload';
    if (!automatic && reason !== 'manual' && (reason !== 'limit' || elapsedSeconds < MAX_SESSION_SECONDS)) {
      this.countdownSession.diagnose('premature_finish_rejected', { reason, elapsedTime: elapsedSeconds });
      return;
    }
    const sessionLimit = MAX_SESSION_SECONDS;
    if (elapsedSeconds >= sessionLimit) {
      elapsedSeconds = sessionLimit;
      endedAt = Math.min(endedAt, this.data.startTimestamp + this.data.totalPausedTime + sessionLimit * 1000);
    }
    const duration = Math.floor(Math.max(0, elapsedSeconds) / 60);
    const sessionId = this.sessionId || `timer_${this.data.startTimestamp}_${Math.random().toString(36).slice(2)}`;
    if (automatic) this._automaticExitSessionId = sessionId;
    if (duration >= 1) {
      this.pendingCompletion = { sessionId, duration, endedAt, text: '' };
      this.safeTimerEffect('save_completion_draft', () => wx.setStorageSync('timerPendingCompletion', this.pendingCompletion));
    }
    this._countupTerminal = {
      isCountdown: false, sessionId, status: automatic ? 'exited' : 'completed', terminalReason: reason,
      isRunning: false, isPaused: false, totalTime: this.data.totalTime,
      startTimestamp: this.data.startTimestamp, totalPausedTime: this.data.totalPausedTime,
      pauseTimestamp: 0, elapsedTime: Math.max(0, elapsedSeconds),
      remainingTime: Math.max(0, this.data.totalTime - elapsedSeconds),
      saveTime: endedAt, runtimeId: this.timerApp._timerRuntimeId,
      pendingCompletion: this.pendingCompletion ? { ...this.pendingCompletion } : null
    };
    if (!automatic) queueEndReminder(wx, sessionId);
    this.stopTimer({ playEndSound: !automatic });
    // 手动结束保留 stopTimer 的初始显示，本次实际时长已存入完成记录。
    if (!resetDisplay) {
      const completedTime = {
        elapsedTime: Math.max(0, elapsedSeconds),
        remainingTime: Math.max(0, this.data.totalTime - elapsedSeconds)
      };
      Object.assign(this.data, completedTime);
      this.safeTimerEffect('render_completed_time', () => this.setData(completedTime));
      this.safeTimerEffect('render_completed_display', () => this.updateDisplay());
    }
    if (duration < 1) {
      if (automatic) this.setCompletionNotice('正计时已结束，不足1分钟未记录');
      else wx.showToast({ title: '不足1分钟，本次不会记录', icon: 'none', duration: 2500 });
      return;
    }
    if (automatic) {
      const saved = this.saveCompletedSession('');
      this.setCompletionNotice(saved ? `正计时已结束，${duration}分钟已存本机` : '正计时已结束，请确认保存记录');
    } else this.showCompletion();
  },

  setCompletionNotice(notice) {
    this.safeTimerEffect('save_completion_notice', () => wx.setStorageSync('timerCompletionNotice', notice));
    if (!this.isUnloaded) this.safeTimerEffect('render_completion_notice', () => this.setData({ completionNotice: notice }));
  },

  showCompletion() {
    if (!this.pendingCompletion) return;
    this.setData({
      showCompletionDialog: true,
      completionDuration: this.pendingCompletion.duration,
      completionText: this.pendingCompletion.text || ''
    });
    // 用户填写感受时就下载下一张日签，确认及跳转都不等待图片网络请求。
    dailyCardImage.prepareNextImage();
  },

  onCompletionInput(e) {
    const text = String(e.detail.value || '').slice(0, 2000);
    this.setData({ completionText: text });
    if (this.pendingCompletion) {
      this.pendingCompletion.text = text;
      if (this.countdownSession) this.countdownSession.updateCompletionText(this.pendingCompletion.sessionId, text);
      this.safeTimerEffect('save_completion_text', () => wx.setStorageSync('timerPendingCompletion', this.pendingCompletion));
      if (this._countupTerminal && this._countupTerminal.sessionId === this.pendingCompletion.sessionId) {
        this._countupTerminal.pendingCompletion = { ...this.pendingCompletion };
        this.safeTimerEffect('save_completion_text_backup', () => {
          const stored = wx.getStorageSync('timerState');
          if (!stored || stored.sessionId === this._countupTerminal.sessionId) {
            wx.setStorageSync('timerState', { ...this._countupTerminal });
          }
        });
      }
    }
  },

  confirmCompletion() {
    return this.submitCompletion({ openDaily: false });
  },

  confirmCompletionAndViewDaily() {
    return this.submitCompletion({ openDaily: true });
  },

  async submitCompletion({ openDaily = false } = {}) {
    if ((!this.pendingCompletion && !this.data.isCompletionSaved) || this.data.isSavingCompletion) return;
    // 两个出口共用保存锁，先点的操作决定去向，重试日签不会重复保存记录。
    this.setData({ isSavingCompletion: true, completionAction: openDaily ? 'daily' : 'stay' });
    try {
      if (!this.data.isCompletionSaved) {
        const text = this.data.completionText.trim();
        if (text && !await contentSec.checkText(text, 2, { allowOffline: true, timeoutMs: 1500 })) return;
        if (!this.saveCompletedSession(text) || this.isUnloaded) return;
        this.setData({ isCompletionSaved: true });
      }
      if (openDaily) {
        // 后台完成保存后保留两个出口，回到前台也由同学主动选择是否看日签。
        if (!this.isUnloaded && this.isPageVisible) this.openCompletionDaily();
      } else {
        this.safeTimerEffect('dismiss_end_reminder', () => this.dismissSessionEndReminder());
        this.closeCompletionDialog();
      }
    } finally {
      if (!this.isUnloaded && !this.isOpeningDaily) {
        this.setData({ isSavingCompletion: false, completionAction: '' });
      }
    }
  },

  closeCompletionDialog() {
    this.isOpeningDaily = false;
    this.didOpenDaily = false;
    this._dailyCompletion = null;
    if (this.isPageVisible && !this.isUnloaded) {
      this.safeTimerEffect('hide_completion_keyboard', () => wx.hideKeyboard({ fail() {} }));
    }
    this.setData({
      showCompletionDialog: false,
      completionDuration: 0,
      completionText: '',
      isSavingCompletion: false,
      isCompletionSaved: false,
      completionAction: '',
      completionDailyFailed: false
    });
  },

  openCompletionDaily() {
    this.isOpeningDaily = true;
    this.setData({ completionDailyFailed: false });
    const onFailure = () => {
      this.isOpeningDaily = false;
      if (this.isUnloaded) return;
      this.setData({ isSavingCompletion: false, completionAction: '', completionDailyFailed: true });
      if (this.isPageVisible) {
        wx.showToast({ title: '记录已保存，静心卡打开失败，请重试', icon: 'none' });
      }
    };
    try {
      wx.hideKeyboard({ fail() {} });
      const completion = this._dailyCompletion;
      const query = completion
        ? `?completedAt=${encodeURIComponent(completion.endedAt)}&minutes=${encodeURIComponent(completion.duration)}`
        : '';
      wx.navigateTo({
        url: `/pages/daily/daily1${query}`,
        success: () => { this.didOpenDaily = true; },
        fail: onFailure
      });
    } catch (error) {
      onFailure();
    }
  },

  saveCompletedSession(text) {
    const completion = this.pendingCompletion;
    if (!completion) return false;
    const savedSessions = this.timerApp._timerSavedCompletionIds || (this.timerApp._timerSavedCompletionIds = new Set());
    const experience = text ? [{
      text,
      timestamp: completion.endedAt,
      emotion: [],
      duration: `${completion.duration}分钟`,
      uniqueId: completion.sessionId
    }] : [];
    let result;
    try {
      // 同步保存本机并启动后台上传，计时完成界面不等待或展示上传结果。
      result = savedSessions.has(completion.sessionId) ? { success: true } : checkinManager.recordCheckin(
        completion.duration, [], experience, completion.endedAt, completion.sessionId
      );
      if (!result || !result.success) throw new Error('本地保存失败');
    } catch (error) {
      console.error('静坐保存失败，保留本次记录以便重试:', error);
      if (this.isPageVisible && !this.isUnloaded) {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
      return false;
    }
    // 入账已完成；草稿清理是可重试的后续操作，不能误报保存失败或重新入账。
    savedSessions.add(completion.sessionId);
    if (savedSessions.size > 200) savedSessions.delete(savedSessions.values().next().value);
    this.safeTimerEffect('acknowledge_completion', () => this.countdownSession.markCompletionSaved(completion.sessionId));
    this.safeTimerEffect('acknowledge_countup', () => {
      const checkpoint = wx.getStorageSync('timerState');
      const terminal = this._countupTerminal || checkpoint;
      if (terminal && terminal.isCountdown === false && terminal.sessionId === completion.sessionId
        && !terminal.isRunning && !terminal.isPaused
        && (!checkpoint || checkpoint.sessionId === completion.sessionId)) {
        this._countupTerminal = { ...terminal, pendingCompletion: null };
        wx.setStorageSync('timerState', { ...this._countupTerminal });
      }
    });
    const cleared = this.safeTimerEffect('clear_completion_draft', () => {
      const stored = wx.getStorageSync('timerPendingCompletion');
      if (stored && stored.sessionId === completion.sessionId) wx.setStorageSync('timerPendingCompletion', null);
      return true;
    });
    if (cleared) {
      this.safeTimerEffect('clear_saved_countup', () => {
        const checkpoint = wx.getStorageSync('timerState');
        if (checkpoint && checkpoint.isCountdown === false && checkpoint.sessionId === completion.sessionId
          && !checkpoint.isRunning && !checkpoint.isPaused) wx.setStorageSync('timerState', null);
      });
      this._countupTerminal = null;
    }
    // Freeze this saved sitting for opening/retrying its card, even after midnight.
    this._dailyCompletion = { endedAt: completion.endedAt, duration: completion.duration };
    this.pendingCompletion = null;
    return result;
  },

  // 暂停计时器
  pauseTimer() {
    if (!this.data.isRunning) return;
    
    this.cleanupTimers();
    
    if (this.data.isCountdown && !this.countdownSession.pause().isPaused) return;
    if (!this.data.isCountdown) {
      const elapsedTime = this.calculateElapsedTime();
      if (elapsedTime >= MAX_SESSION_SECONDS) {
        this.finishSession(elapsedTime, { reason: 'limit' });
        return;
      }
      this.setData({ elapsedTime, remainingTime: Math.max(0, this.data.totalTime - elapsedTime) });
    }
    // 同时取消尚未触发的调暗，恢复本次实际修改过的亮度。
    this.safeTimerEffect('pause_brightness', () => this.stopBrightnessControl());
    
    this.setData({
      isRunning: false,
      isPaused: true,
      pauseTimestamp: Date.now()
    });
    
    this.safeTimerEffect('pause_audio', () => this.pauseSessionAudio());
    
    this.updateButtonStates();
    this.updateDisplay();
    this.saveTimerState();
    console.log('⏸️ 计时器已暂停');
  },

  // 停止计时器
  stopTimer({ playEndSound = true, reason = 'cancel' } = {}) {
    const wasActive = this.data.isRunning || this.data.isPaused;
    if (this.data.isCountdown) this.countdownSession.cancel(reason);
    this.cleanupTimers();
    
    // 停止亮度控制并恢复亮度
    this.safeTimerEffect('stop_brightness', () => this.stopBrightnessControl());
    
    const stoppedState = {
      elapsedTime: 0,
      remainingTime: this.data.totalTime,
      isRunning: false,
      isPaused: false,
      startTimestamp: 0,
      pauseTimestamp: 0,
      totalPausedTime: 0
    };
    // 逻辑终态先提交；原生渲染失败不能阻止退出时保存记录。
    Object.assign(this.data, stoppedState);
    this.safeTimerEffect('render_stopped_state', () => this.setData(stoppedState));
    
    // 停止背景音乐
    this.safeTimerEffect('stop_guide', () => this.stopBackgroundMusic());
    this.safeTimerEffect('stop_cue', () => this.stopSessionSound());
    this.safeTimerEffect('clear_audio_recovery', () => this.clearSessionAudioRecovery());
    
    // 运行中或暂停后结束，均播放收坐音频。
    if (wasActive && playEndSound) {
      this.safeTimerEffect('end_cue', () => this.playSessionSound('end'));
    }
    
    this.safeTimerEffect('render_stopped_display', () => this.updateDisplay());
    this.safeTimerEffect('render_stopped_buttons', () => this.updateButtonStates());
    this.sessionId = null;
    this.safeTimerEffect('save_stopped_state', () => this.saveTimerState());
    console.log('⏹️ 计时器已停止');
  },

  // 用户结束时按实际已用分钟保存，暂停时间不计入。
  handleStop() {
    this.finishSession(this.calculateElapsedTime(), { resetDisplay: true, reason: 'manual' });
  },

  // 停止所有计时器
  cleanupTimers() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
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
  updateDisplay({ animateProgress = false } = {}) {
    const isActive = this.data.isRunning || this.data.isPaused;
    // 待开始时倒计时显示当前设定时长，正计时显示零；实际用时保留供记录使用。
    const displaySeconds = isActive
      ? (this.data.isCountdown ? this.data.remainingTime : this.data.elapsedTime)
      : (this.data.isCountdown ? this.data.totalTime : 0);
    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    const displayTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // 仅运行或暂停中的倒计时显示剩余进度；结束后恢复默认满环。
    // 实际用时仍保留在会话和完成记录中，不随圆环重置。
    const remainingRatio = this.data.totalTime > 0
      ? Math.min(1, Math.max(0, this.data.remainingTime / this.data.totalTime))
      : 0;
    const progressAngle = this.data.isCountdown && isActive ? remainingRatio * 360 : 360;

    this.setData({
      displayTime: displayTime,
      // 开始、恢复和重置直接定位，只有计时递减时启用过渡。
      isProgressAnimating: animateProgress && this.data.isCountdown && this.data.isRunning,
      // 每个半圆从 -180°（隐藏）转到 0°（完整显示）。
      progressAngleLeft: Math.max(0, progressAngle - 180) - 180,
      progressAngleRight: Math.min(180, progressAngle) - 180
    });
  },

  // 保存运行检查点。停止状态不保留可恢复的时间戳。
  saveTimerState({ interrupted = false } = {}) {
    if (this.isTimerRecoveryPending()) return;
    if (this.data.isCountdown) return;
    if (!this.data.isRunning && !this.data.isPaused) {
      this.timerApp._timerCountupCheckpoint = null;
      const terminal = this._countupTerminal;
      // 独立草稿可能写失败；停止时保留终态副本，不能删掉唯一可恢复记录。
      wx.setStorageSync('timerState', terminal && this.pendingCompletion
        && terminal.sessionId === this.pendingCompletion.sessionId
        ? { ...terminal, pendingCompletion: { ...this.pendingCompletion } }
        : terminal && terminal.pendingCompletion === null ? { ...terminal } : null);
      return;
    }
    const state = {
      isCountdown: this.data.isCountdown,
      sessionId: this.sessionId,
      elapsedTime: this.calculateElapsedTime(),
      totalTime: this.data.totalTime,
      isRunning: this.data.isRunning,
      isPaused: this.data.isPaused,
      startTimestamp: this.data.startTimestamp,
      pauseTimestamp: this.data.pauseTimestamp,
      totalPausedTime: this.data.totalPausedTime,
      runtimeId: this.timerApp._timerRuntimeId,
      interrupted,
      saveTime: Date.now()
    };
    this.timerApp._timerCountupCheckpoint = state;
    wx.setStorageSync('timerState', state);
  },

  clearRestoredCountupCompletion(sessionId, state) {
    const savedSessions = this.timerApp._timerSavedCompletionIds || (this.timerApp._timerSavedCompletionIds = new Set());
    savedSessions.add(sessionId);
    if (savedSessions.size > 200) savedSessions.delete(savedSessions.values().next().value);
    this.pendingCompletion = null;
    this.safeTimerEffect('acknowledge_restored_countup', () => this.countdownSession.markCompletionSaved(sessionId));
    if (state && state.sessionId === sessionId) {
      this._countupTerminal = { ...state, status: 'completed', isRunning: false, isPaused: false, pendingCompletion: null };
      this.safeTimerEffect('save_recorded_countup', () => wx.setStorageSync('timerState', { ...this._countupTerminal }));
    }
    const cleared = this.safeTimerEffect('clear_saved_completion', () => {
      const stored = wx.getStorageSync('timerPendingCompletion');
      if (stored && stored.sessionId === sessionId) wx.setStorageSync('timerPendingCompletion', null);
      return true;
    });
    if (cleared) {
      this.safeTimerEffect('clear_saved_terminal', () => {
        const stored = wx.getStorageSync('timerState');
        if (stored && stored.sessionId === sessionId) wx.setStorageSync('timerState', null);
      });
      this._countupTerminal = null;
    }
  },

  restoreTimerState() {
    if (this._completionReadPending) { this._timerStateReadPending = true; return; }
    let stored;
    try {
      stored = wx.getStorageSync('timerState');
      this._timerStateReadPending = false;
    } catch (error) {
      this._timerStateReadPending = true;
      this.countdownSession.diagnose('read_timer_state_error', { message: String(error && error.message || error) });
      return;
    }
    const checkpoint = this.timerApp._timerCountupCheckpoint;
    // 被动中断的写盘失败不能把同一进程的活动会话误当作冷启动。
    // 仅接回本运行时、同身份的检查点，不覆盖后来出现的其他模式或会话。
    const state = checkpoint && checkpoint.isCountdown === false && checkpoint.interrupted === true
      && checkpoint.runtimeId === this.timerApp._timerRuntimeId && (checkpoint.isRunning || checkpoint.isPaused)
      && (!stored || stored.isCountdown === false && stored.sessionId === checkpoint.sessionId
        && (!stored.runtimeId || stored.runtimeId === checkpoint.runtimeId))
      ? checkpoint : stored;
    const exited = typeof this.timerApp.getDetachedCountupExit === 'function'
      ? this.timerApp.getDetachedCountupExit() : null;
    if (exited && (!state || state.sessionId === exited.sessionId)
      && (!this.pendingCompletion || this.pendingCompletion.sessionId === exited.sessionId)) {
      // 退出时存储清理失败也不能复活旧会话；本机已入账和待保存草稿分开恢复。
      this.pendingCompletion = !exited.saved && exited.completion ? { ...exited.completion } : null;
      if (exited.saved) this.countdownSession.markCompletionSaved(exited.sessionId);
      this.detachedExitNoticeSessionId = exited.sessionId;
      this.setData({ completionNotice: exited.notice || '' });
      return;
    }
    if (state && state.isCountdown === true) return;
    const embedded = state && state.pendingCompletion;
    const validCompletion = value => value && typeof value.sessionId === 'string'
      && value.sessionId.length > 0 && value.sessionId.length <= 256
      && Number.isInteger(value.duration) && value.duration >= 1 && value.duration <= 1440
      && Number.isFinite(value.endedAt) && value.endedAt > 0;
    const validEmbedded = state && state.isCountdown === false
      && state.isRunning === false && state.isPaused === false
      && ['completed', 'exited'].includes(state.status)
      && validCompletion(embedded) && embedded.sessionId === state.sessionId;
    const completion = validCompletion(this.pendingCompletion) ? this.pendingCompletion
      : validEmbedded ? embedded : null;
    const recorded = completion && typeof this.timerApp.hasRecordedTimerCompletion === 'function'
      && this.safeTimerEffect('check_recorded_countup', () => this.timerApp.hasRecordedTimerCompletion(completion.sessionId)) === true;
    if (recorded || state && state.isCountdown === false && !state.isRunning && !state.isPaused
      && ['completed', 'exited'].includes(state.status) && state.pendingCompletion === null
      && this.pendingCompletion && this.pendingCompletion.sessionId === state.sessionId) {
      // 终态确认写失败时，账本里的原会话身份仍可证明已入账；读取异常不作此推断。
      const sessionId = recorded ? completion.sessionId : state.sessionId;
      this.clearRestoredCountupCompletion(sessionId, state);
      if (!state || state.sessionId === sessionId) return;
    }
    if (!this.pendingCompletion && validEmbedded) {
      // 冷启动在首页退出时也可能写草稿失败；终态备份不能被恢复成运行中。
      this.pendingCompletion = { ...embedded, text: String(embedded.text || '').slice(0, 2000) };
      this._countupTerminal = { ...state };
      const persisted = this.safeTimerEffect('restore_completion_draft', () => {
        wx.setStorageSync('timerPendingCompletion', this.pendingCompletion);
        return true;
      });
      // 先确认独立草稿写入，才允许删除终态中的唯一备份。
      if (persisted) this.safeTimerEffect('clear_terminal_checkpoint', () => wx.setStorageSync('timerState', null));
      return;
    }
    if (this.pendingCompletion) {
      wx.setStorageSync('timerState', null);
      return;
    }
    if (!state || (!state.isRunning && !state.isPaused)) return;
    // 只有完整可信的会话才可跨进程累计，不能用损坏缓存生成长记录。
    const totalPausedTime = state.totalPausedTime === undefined ? 0 : state.totalPausedTime;
    const effectiveEnd = state.isPaused ? state.pauseTimestamp : state.saveTime;
    if (state.isCountdown !== false || typeof state.sessionId !== 'string' || !state.sessionId
      || state.sessionId.length > 256 || typeof state.isRunning !== 'boolean' || typeof state.isPaused !== 'boolean'
      || state.isRunning === state.isPaused
      || !Number.isInteger(state.totalTime) || state.totalTime < 1 || state.totalTime > MAX_SESSION_SECONDS
      || !Number.isFinite(state.startTimestamp) || state.startTimestamp <= 0
      || !Number.isFinite(state.saveTime) || state.saveTime < state.startTimestamp
      || !Number.isFinite(totalPausedTime) || totalPausedTime < 0
      || !Number.isFinite(state.elapsedTime) || state.elapsedTime < 0 || state.elapsedTime > MAX_SESSION_SECONDS
      || !Number.isFinite(effectiveEnd) || effectiveEnd < state.startTimestamp || effectiveEnd > state.saveTime
      || state.elapsedTime > Math.max(0, Math.floor((effectiveEnd - state.startTimestamp - totalPausedTime) / 1000))) {
      this.countdownSession.diagnose('invalid_countup_checkpoint');
      wx.setStorageSync('timerState', null);
      return;
    }
    // 设备时间回拨时移动两个锚点，保留已经确认的进度和手动暂停状态。
    const clockAdjustment = Math.min(0, Date.now() - state.saveTime);
    this._countupObservedAt = Date.now();
    this.sessionId = state.sessionId;
    this.setData({
      isCountdown: state.isCountdown,
      totalTime: state.totalTime,
      duration: state.totalTime / 60,
      durationText: `${state.totalTime / 60} 分钟`,
      isRunning: state.isRunning,
      isPaused: state.isPaused,
      startTimestamp: state.startTimestamp + clockAdjustment,
      pauseTimestamp: state.isPaused ? state.pauseTimestamp + clockAdjustment : 0,
      totalPausedTime,
      elapsedTime: state.elapsedTime,
      remainingTime: Math.max(0, state.totalTime - state.elapsedTime)
    });
    // 来电、闹钟、挂起和进程回收都不构成停止；只有原本手动暂停才继续暂停。
    const elapsedTime = Math.min(MAX_SESSION_SECONDS, Math.max(state.elapsedTime, this.calculateElapsedTime()));
    if (elapsedTime >= MAX_SESSION_SECONDS) {
      this.finishSession(elapsedTime, { reason: 'limit' });
      return;
    }
    this.setData({
      elapsedTime,
      remainingTime: Math.max(0, state.totalTime - elapsedTime)
    });
    if (this.data.isRunning && !this.isAppHidden) this.createForegroundTimer();
    this.saveTimerState({ interrupted: this.isAppHidden });
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
        this.countdownSession.diagnose('keep_screen_failed', { message: err.errMsg });
        console.warn('⚠️ 屏幕常亮设置失败:', err);
      }
    });
  },

  // 设置最低亮度
  setMinBrightness() {
    if (!this.isPageVisible || this.isUnloaded || !this.data.isRunning) return;
    this.safeTimerEffect('dim_screen', () => this.screenBrightness.dim());
  },

  // 开始亮度控制（10 秒后降低亮度）
  startBrightnessControl(delay = 10000) {
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

  savePendingCompletionOnExit() {
    const completion = this.pendingCompletion;
    if (!completion || completion.sessionId === this._automaticExitSessionId
      || this.data.isSavingCompletion || this._savingExitCompletion) return;
    const text = String(completion.text || '').trim();
    const save = () => {
      if (!this.pendingCompletion || this.pendingCompletion.sessionId !== completion.sessionId
        || !this.saveCompletedSession(text)) return;
      // 同一页面可能只进入后台；保留弹窗的两个出口，并与已入账状态同步。
      if (!this.isUnloaded && this.data.showCompletionDialog) {
        this.data.isCompletionSaved = true;
        this.safeTimerEffect('render_exit_completion', () => this.setData({ isCompletionSaved: true }));
      }
    };
    if (!text) { save(); return; }
    // 已填写的感受仍走原安全检测；页面退出不丢草稿，也不跳过检测。
    const account = wx.getStorageSync('userOpenId') || '';
    this._savingExitCompletion = true;
    Promise.resolve().then(() => contentSec.checkText(text, 2, { allowOffline: true, timeoutMs: 1500 })).then(allowed => {
      const current = wx.getStorageSync('timerPendingCompletion');
      if (allowed && (wx.getStorageSync('userOpenId') || '') === account
        && current && current.sessionId === completion.sessionId && String(current.text || '').trim() === text
        && this.pendingCompletion && this.pendingCompletion.sessionId === completion.sessionId) {
        save();
      }
    }).catch(error => {
      this.countdownSession.diagnose('exit_completion_error', { message: String(error && error.message || error).slice(0, 160) });
    }).finally(() => { this._savingExitCompletion = false; });
  },

  onUnload() {
    if (this.isUnloaded) return;
    this.isLeavingTimer = true;
    const activeSession = this.data.isRunning || this.data.isPaused;
    const passiveHide = !isExplicitTimerExit(this.timerApp._timerHideOptions)
      && (this.isAppHidden || this.timerApp._timerForeground === false || this.timerApp._timerAudioInterrupted);
    const interruptedSession = passiveHide && activeSession;
    const interruptedCountUp = interruptedSession && !this.data.isCountdown;
    if (interruptedCountUp) {
      if (!this.isAppHidden) this.safeTimerEffect('save_interrupted_state', () => this.saveTimerState({ interrupted: true }));
      this.timerApp._detachedCountupSessionId = this.sessionId;
      this.timerApp._detachedCountupState = this.timerApp._timerCountupCheckpoint;
    }
    if (!interruptedSession && activeSession) {
      this.finishSession(this.calculateElapsedTime(), { reason: 'page_unload' });
    }
    if (!interruptedSession) this.safeTimerEffect('exit_completion', () => this.savePendingCompletionOnExit());
    this.safeTimerEffect('suspend_audio', () => this.suspendSessionAudio());
    this.safeTimerEffect('save_audio', () => this.saveSessionAudio());
    if (interruptedCountUp && this.timerApp._timerForeground === false
      && typeof this.timerApp.finishDetachedCountup === 'function') {
      this.timerApp.finishDetachedCountup(this.timerApp._timerHideOptions);
    }
    if (this.detachCountdown) this.detachCountdown();
    this.countdownSession.diagnose('page_unload');
    this.isUnloaded = true;
    this.isPageVisible = false;
    if (this.timerApp._timerPage === this) this.timerApp._timerPage = null;
    wx.offAppShow(this.appShowHandler);
    wx.offAppHide(this.appHideHandler);
    if (wx.offAudioInterruptionBegin) wx.offAudioInterruptionBegin(this.audioInterruptionBeginHandler);
    if (wx.offAudioInterruptionEnd) wx.offAudioInterruptionEnd(this.audioInterruptionEndHandler);
    this.cleanupTimers();
    this.safeTimerEffect('unload_guide', () => this.stopBackgroundMusic());
    this.safeTimerEffect('destroy_guide', () => this.destroyBackgroundMusicPlayer());
    this.safeTimerEffect('unload_cue', () => this.destroyAudioPlayer());
    if (!interruptedCountUp) this.safeTimerEffect('save_unloaded_state', () => this.saveTimerState());
    this.safeTimerEffect('unload_screen', () => this.restoreScreenSettings());
    if (!passiveHide) this.safeTimerEffect('dismiss_end_reminder', () => this.dismissSessionEndReminder());
    
    console.log('📱 页面卸载，资源清理完成');
  },

  // 模式与时长设置
  toggleMode(e) {
    if (this.isTimerRecoveryPending()) return;
    this.stopTimer({ playEndSound: false, reason: 'mode_change' });
    this.setData({ isCountdown: e.detail.value });
    this.updateDisplay();
    this.updateButtonStates();
  },

  resetTimer() {
    if (this.isTimerRecoveryPending()) return;
    this.stopTimer({ playEndSound: false, reason: 'reset' });
    this.updateDisplay();
    this.updateButtonStates();
  },

  loadDurationOptions() {
    const stored = this.safeTimerEffect('read_duration_options', () => wx.getStorageSync(DURATION_STORAGE_KEY));
    const values = Array.isArray(stored)
      ? [...new Set(stored.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 180))]
      : DEFAULT_DURATIONS;
    const minutes = values[0] || DEFAULT_DURATIONS[0];
    this.setData({
      timeOptions: values.map(value => ({ value, text: `${value} 分钟` })),
      duration: minutes,
      durationText: `${minutes} 分钟`,
      totalTime: minutes * 60,
      remainingTime: minutes * 60
    });
  },

  saveDurationOptions(values) {
    const durations = [...new Set(values)];
    const removedSelection = this.data.timeOptions.some(item => item.value === this.data.duration)
      && !durations.includes(this.data.duration);
    wx.setStorageSync(DURATION_STORAGE_KEY, durations);
    this.setData({ timeOptions: durations.map(value => ({ value, text: `${value} 分钟` })) });
    if (removedSelection && !this.data.isRunning && !this.data.isPaused
      && !this.data.elapsedTime && !this.pendingCompletion) {
      const minutes = durations[0] || DEFAULT_DURATIONS[0];
      this.setData({
        duration: minutes,
        durationText: `${minutes} 分钟`,
        totalTime: minutes * 60,
        remainingTime: minutes * 60
      });
      this.updateDisplay();
    }
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

  moveRecommendedDuration(e) {
    if (!this.data.editingDurations) return;
    const value = Number(e.currentTarget.dataset.value);
    const offset = Number(e.currentTarget.dataset.offset);
    if (offset !== -1 && offset !== 1) return;
    const values = this.data.timeOptions.map(item => item.value);
    const index = values.indexOf(value);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= values.length) return;
    [values[index], values[nextIndex]] = [values[nextIndex], values[index]];
    this.saveDurationOptions(values);
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
      const values = this.data.timeOptions.map(item => item.value);
      const nextValues = action === 'edit'
        ? values.filter(value => value === this.data.editingDuration || value !== minutes)
          .map(value => value === this.data.editingDuration ? minutes : value)
        : [...values, minutes];
      this.saveDurationOptions(nextValues);
      this.setData({ showCustomTimePicker: false, showTimePicker: true, customTimeInput: '' });
      return;
    }
    this.applyDuration(minutes);
  },

  applyDuration(minutes) {
    if (this.isTimerRecoveryPending()) return;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return;
    this.stopTimer({ playEndSound: false, reason: 'duration_change' });
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

  onShareAppMessage() {
    return {};
  }
});
