const { createCuePlayer } = require('./cuePlayer');
const { createVibrationCue } = require('./vibrationCue');
const { getReminderSettings } = require('./timerReminderSettings');
const { queueEndReminder, getEndReminder, clearEndReminder, dismissEndReminder } = require('./timerEndReminder');
const SESSION_AUDIO_KEY = 'timerSessionAudio';
const AUDIO_CHECKPOINT_INTERVAL = 10000;

function validAudioCheckpoint(value) {
  const position = number => Number.isFinite(number) && number >= 0 && number <= 86400;
  return value && value.schemaVersion === 1 && typeof value.sessionId === 'string'
    && value.sessionId.length > 0 && value.sessionId.length <= 256
    && typeof value.isCountdown === 'boolean' && typeof value.isPaused === 'boolean'
    && typeof value.guideWanted === 'boolean' && typeof value.guideCompleted === 'boolean'
    && typeof value.openingReminderCompleted === 'boolean'
    && ['none', 'default'].includes(value.backgroundMusic)
    && (value.startSoundRemaining === null || position(value.startSoundRemaining) && value.startSoundRemaining <= 5000)
    && [null, 'start'].includes(value.currentSessionSound)
    && position(value.guidePosition) && position(value.cuePosition)
    && (value.vibrationRemainingMs == null || Number.isFinite(value.vibrationRemainingMs)
      && value.vibrationRemainingMs >= 0 && value.vibrationRemainingMs <= 3000)
    && Number.isFinite(value.waitAt) && value.waitAt > 0;
}

// 计时页的音频和提醒副作用集中在这里；不修改计时、完成草稿或记录入账状态。
const timerAudioMethods = {
  initializeSessionAudio() {
    this.currentSessionSound = null;
    this.startSoundTimer = null;
    this.startSoundRemaining = null;
    this.startSoundScheduledAt = 0;
    this.audioSuspended = false;
    this.deferredEndSound = false;
    this.endReminderSessionId = null;
    this.endReminderFailed = false;
    this.lastEndReminderSessionId = null;
    this.vibrationCue = null;
    this.restoredVibrationRemaining = null;
    this.audioPlayer = null;
    this.backgroundMusicPlayer = null;
    this.openingReminderCompleted = true;
    this.guideCompleted = false;
    this.lastAudioCheckpointAt = 0;
    this.audioRestorePending = true;
    this.cuePlayer = createCuePlayer({
      api: wx,
      canPlay: () => this.canPlayTimerAudio(),
      onPlayerChange: player => {
        this.audioPlayer = player;
        if (player && typeof player.onTimeUpdate === 'function') player.onTimeUpdate(() => {
          if (this.audioPlayer === player && this.currentSessionSound === 'start') this.checkpointSessionAudioProgress();
        });
      },
      onEnded: result => { if (!this.isUnloaded) this.handleSessionSoundEnded(result); },
      diagnose: (type, details) => this.countdownSession.diagnose(type,
        { ...details, cue: this.currentSessionSound })
    });
    this.safeTimerEffect('create_cue', () => this.createAudioPlayer());
  },

  startSessionAudio({ resume = false } = {}) {
    this.deferredEndSound = false;
    this.audioSuspended = false;
    if (!resume) {
      // A newly started sitting must never inherit a deferred read of old audio.
      this.audioRestorePending = false;
      if (this.timerApp._timerExitAudio) this.timerApp._timerExitAudio.stop();
      dismissEndReminder(wx);
      this.endReminderFailed = false;
      this.guideUnavailableNotified = false;
      // 新一轮由用户主动开始，可以重新请求音频；不能用自动回前台清除来电占用。
      if (this.isPageVisible && !this.isAppHidden && this.timerApp._timerForeground !== false) {
        if (this.timerApp._timerAudioInterrupted) {
          this.timerApp._timerAudioInterrupted = false;
          this.countdownSession.diagnose('audio_interruption_reset', { reason: 'new_session' });
        }
        if (typeof this.timerApp.setAudioOptions === 'function') {
          this.safeTimerEffect('audio_options', () => this.timerApp.setAudioOptions());
        }
      }
      this.stopBackgroundMusic();
      this.stopSessionSound();
      this.openingReminderCompleted = false;
      this.guideCompleted = false;
      if (getReminderSettings(wx).end === 'bell') {
        this.safeTimerEffect('preload_end_cue', () => this.cuePlayer.preload('/audio/收坐.mp3'));
      }
      this.scheduleStartSound();
    } else if (this.startSoundRemaining !== null) {
      this.scheduleStartSound(this.startSoundRemaining);
    } else if (this.currentSessionSound === 'start') {
      if (this.canPlayTimerAudio()) this.resumeSessionCue();
      else this.suspendSessionAudio();
    } else {
      this.playBackgroundMusic();
    }
  },

  pauseSessionAudio() {
    this.pauseBackgroundMusic();
    if (this.startSoundTimer !== null) {
      clearTimeout(this.startSoundTimer);
      this.startSoundTimer = null;
      this.startSoundRemaining = Math.max(0,
        this.startSoundRemaining - (Date.now() - this.startSoundScheduledAt));
    } else if (this.audioSuspended && this.startSoundRemaining !== null) {
      // 系统中断不暂停静坐，准备时间只在手动暂停后冻结。
      this.startSoundRemaining = Math.max(0,
        this.startSoundRemaining - (Date.now() - this.audioInterruptedAt));
    }
    if (this.currentSessionSound === 'start') this.pauseSessionCue();
    this.saveSessionAudio();
  },

  canPlayTimerAudio() {
    return !this.isUnloaded && !this.isLeavingTimer && this.isPageVisible && !this.isAppHidden
      && this.timerApp._timerForeground !== false && !this.timerApp._timerAudioInterrupted;
  },

  // 用户主动完成或查看日签时停止本次提醒；系统中断仍保留待提醒状态。
  dismissSessionEndReminder() {
    const pending = dismissEndReminder(wx);
    if (pending) this.lastEndReminderSessionId = pending.sessionId;
    else if (this.endReminderSessionId) this.lastEndReminderSessionId = this.endReminderSessionId;
    this.stopSessionSound();
    if (this.timerApp._timerExitAudio) this.timerApp._timerExitAudio.stop();
  },

  // 音频进度独立于计时检查点，跨页面和进程恢复时都必须匹配原会话。
  saveSessionAudio() {
    if (this.audioRestorePending || !this.sessionId || (!this.data.isRunning && !this.data.isPaused)) return;
    const at = Date.now();
    const position = (player, fallback = 0) => Math.max(0,
      Number.isFinite(player && player.currentTime) ? player.currentTime : 0,
      Number.isFinite(player && player.startTime) ? player.startTime : 0, fallback);
    let startSoundRemaining = this.startSoundRemaining;
    if (startSoundRemaining !== null && this.startSoundTimer !== null) {
      startSoundRemaining = Math.max(0, startSoundRemaining - Math.max(0, at - this.startSoundScheduledAt));
    } else if (startSoundRemaining !== null && this.audioSuspended && !this.data.isPaused) {
      startSoundRemaining = Math.max(0, startSoundRemaining - Math.max(0, at - this.audioInterruptedAt));
    }
    const checkpoint = {
      schemaVersion: 1,
      sessionId: this.sessionId, isCountdown: this.data.isCountdown,
      isPaused: !!this.data.isPaused,
      backgroundMusic: this.data.backgroundMusic, guideUrl: this.data.defaultMusicUrl,
      guidePosition: position(this.backgroundMusicPlayer, this.guideResumePosition || 0),
      guideWanted: !!(this.guidePlaybackWanted || this.resumeGuideAfterInterruption),
      guideCompleted: !!this.guideCompleted,
      openingReminderCompleted: !!this.openingReminderCompleted,
      startSoundRemaining, currentSessionSound: this.currentSessionSound === 'start' ? 'start' : null,
      // 故障重建间隙可能没有 native 对象，恢复位置由铃声控制器持有。
      cuePosition: this.cuePlayer.position,
      vibrationRemainingMs: this.vibrationCue
        ? this.vibrationCue.player.remainingMs : this.restoredVibrationRemaining,
      waitAt: at
    };
    this.timerApp._timerSessionAudio = checkpoint;
    this.lastAudioCheckpointAt = at;
    this.safeTimerEffect('save_audio_checkpoint', () => wx.setStorageSync(SESSION_AUDIO_KEY, checkpoint));
  },

  checkpointSessionAudioProgress() {
    if (this.isUnloaded || Date.now() - this.lastAudioCheckpointAt < AUDIO_CHECKPOINT_INTERVAL) return;
    this.saveSessionAudio();
  },

  clearSessionAudioRecovery(sessionId = this.sessionId) {
    if (!sessionId) return;
    if (sessionId === this.sessionId) this.audioRestorePending = false;
    if (this.timerApp._timerSessionAudio && this.timerApp._timerSessionAudio.sessionId === sessionId) {
      this.timerApp._timerSessionAudio = null;
    }
    this.safeTimerEffect('clear_audio_checkpoint', () => {
      const saved = wx.getStorageSync(SESSION_AUDIO_KEY);
      if (saved && saved.sessionId === sessionId) wx.setStorageSync(SESSION_AUDIO_KEY, null);
    });
  },

  restoreSessionAudio() {
    if (!this.audioRestorePending) return;
    // A transient timer-state read can leave the page without its session until
    // onShow. Keep the audio checkpoint untouched until that identity is known.
    if (!this.sessionId || (!this.data.isRunning && !this.data.isPaused)) {
      if (this.pendingCompletion || this.sessionId) this.audioRestorePending = false;
      return;
    }
    const memory = this.timerApp._timerSessionAudio;
    let saved = validAudioCheckpoint(memory) && memory.sessionId === this.sessionId ? memory : null;
    if (!saved) {
      let readSucceeded = false;
      saved = this.safeTimerEffect('read_audio_checkpoint', () => {
        const value = wx.getStorageSync(SESSION_AUDIO_KEY);
        readSucceeded = true;
        return value;
      });
      if (!readSucceeded) return;
    }
    this.audioRestorePending = false;
    // 领取一次，结束、取消或另一会话都不能复活旧音频。
    this.timerApp._timerSessionAudio = null;
    if (!validAudioCheckpoint(saved) || saved.sessionId !== this.sessionId || saved.isCountdown !== this.data.isCountdown
      || (!this.data.isRunning && !this.data.isPaused) || this.pendingCompletion) return;
    this.setData({ backgroundMusic: saved.backgroundMusic,
      musicText: saved.backgroundMusic === 'default' ? '引导音频' : '无音乐',
      ...(typeof saved.guideUrl === 'string' && saved.guideUrl
        ? { defaultMusicUrl: this.refreshedGuideUrl || saved.guideUrl } : {}) });
    this.guideResumePosition = saved.guidePosition;
    this.guideCompleted = saved.guideCompleted === true;
    this.openingReminderCompleted = saved.openingReminderCompleted === true;
    this.resumeGuideAfterInterruption = !!saved.guideWanted && !this.guideCompleted;
    this.startSoundRemaining = saved.startSoundRemaining;
    if (!this.openingReminderCompleted && this.startSoundRemaining === null && saved.currentSessionSound !== 'start') {
      // A failed or interrupted opening remains owed; a completed opening is never replayed.
      this.startSoundRemaining = 0;
    }
    this.audioInterruptedAt = saved.waitAt;
    this.audioSuspended = true;
    if (saved.currentSessionSound === 'start') {
      this.currentSessionSound = 'start';
      if (Number.isFinite(saved.vibrationRemainingMs)) {
        this.restoredVibrationRemaining = saved.vibrationRemainingMs;
      } else {
        this.cuePlayer.prepare('/audio/起坐.mp3', { position: saved.cuePosition });
      }
    }
  },

  suspendSessionAudio() {
    if (this.audioSuspended) return;
    this.audioSuspended = true;
    this.audioInterruptedAt = Date.now();
    // 系统在 Begin 回调前可能已暂停播放器，恢复意图不能读取 native.paused。
    this.resumeGuideAfterInterruption = !!this.guidePlaybackWanted;
    if (this.startSoundTimer !== null) {
      clearTimeout(this.startSoundTimer);
      this.startSoundTimer = null;
      this.startSoundRemaining = Math.max(0,
        this.startSoundRemaining - (Date.now() - this.startSoundScheduledAt));
    }
    if (this.currentSessionSound) this.pauseSessionCue();
    this.pauseBackgroundMusic({ interrupted: true });
    this.saveSessionAudio();
  },

  resumeInterruptedAudio({ allowEndRetry = false } = {}) {
    if (this.audioRestorePending) this.restoreSessionAudio();
    if (allowEndRetry) this.endReminderFailed = false;
    if (!this.isPageVisible || !this.canPlayTimerAudio()) return;
    const pendingEnd = getEndReminder(wx);
    if (pendingEnd && this.timerApp._timerExitAudio && this.timerApp._timerExitAudio.owns(pendingEnd.sessionId)) {
      this.deferredEndSound = false;
      this.lastEndReminderSessionId = pendingEnd.sessionId;
      return;
    }
    const countdown = pendingEnd && this.data.isCountdown
      && typeof this.countdownSession.getSnapshot === 'function'
      ? this.countdownSession.getSnapshot() : null;
    const ended = !this.data.isRunning && !this.data.isPaused
      || countdown && countdown.sessionId === pendingEnd.sessionId
        && (countdown.status === 'completed' || countdown.status === 'exited');
    if (pendingEnd && ended) {
      if (this.currentSessionSound === 'end' && this.endReminderSessionId === pendingEnd.sessionId) {
        if (this.audioSuspended) {
          this.audioSuspended = false;
          this.resumeSessionCue();
        }
      } else if (!this.endReminderFailed) {
        this.playSessionSound('end');
      }
      return;
    }
    if (!pendingEnd && this.deferredEndSound && !this.endReminderFailed) {
      this.deferredEndSound = false;
      this.playSessionSound('end');
      return;
    }
    if (!this.audioSuspended) return;
    this.audioSuspended = false;
    // 手动暂停的会话不能被系统中断结束事件恢复。
    if (this.data.isPaused) return;
    if (this.currentSessionSound === 'end') {
      this.resumeSessionCue();
    } else if (this.data.isRunning) {
      if (this.startSoundRemaining !== null) {
        const delay = Math.max(0, this.startSoundRemaining - Math.max(0, Date.now() - this.audioInterruptedAt));
        this.scheduleStartSound(delay);
      } else if (this.currentSessionSound === 'start') {
        this.resumeSessionCue();
      } else if (this.resumeGuideAfterInterruption) {
        this.playBackgroundMusic();
      }
    }
    this.resumeGuideAfterInterruption = false;
  },

  createAudioPlayer() {
    if (!this.isUnloaded) this.cuePlayer.ensurePlayer();
  },

  destroyAudioPlayer() {
    // 原生 stop/destroy 即使抛错，也必须取消恢复任务并释放故障对象。
    this.stopSessionSound();
    this.cuePlayer.destroy();
  },

  // 开始后留出 5 秒准备时间；暂停时保留剩余等待时间。
  scheduleStartSound(delay = 5000) {
    this.startSoundRemaining = delay;
    this.startSoundScheduledAt = Date.now();
    if (!this.canPlayTimerAudio()) {
      this.audioSuspended = true;
      this.audioInterruptedAt = Date.now();
      this.saveSessionAudio();
      return;
    }
    this.startSoundTimer = setTimeout(() => {
      this.startSoundTimer = null;
      this.startSoundRemaining = null;
      if (this.data.isRunning && !this.isUnloaded) {
        this.safeTimerEffect('start_cue', () => this.playSessionSound('start'));
      }
    }, delay);
    this.saveSessionAudio();
  },

  playSessionSound(type) {
    if (this.isUnloaded) return;
    let endReminder = null;
    if (type === 'end') {
      this.clearSessionAudioRecovery();
      endReminder = getEndReminder(wx);
      if (!endReminder) {
        const sessionId = this.sessionId || this.pendingCompletion && this.pendingCompletion.sessionId;
        if (sessionId && sessionId === this.lastEndReminderSessionId) return;
        if (sessionId) endReminder = queueEndReminder(wx, sessionId);
      }
      if (endReminder && this.timerApp._timerExitAudio
        && this.timerApp._timerExitAudio.owns(endReminder.sessionId)) {
        this.deferredEndSound = false;
        this.lastEndReminderSessionId = endReminder.sessionId;
        return;
      }
      // Repeated onShow/state events must not restart a playing or deferred cue.
      if (this.currentSessionSound === 'end' && endReminder
        && this.endReminderSessionId === endReminder.sessionId) return;
      if (this.endReminderFailed) return;
    }
    this.stopSessionSound();
    if (type === 'end') this.endReminderSessionId = endReminder && endReminder.sessionId;
    if (!this.canPlayTimerAudio() || (type === 'end' && !this.isPageVisible)) {
      if (type === 'end') this.deferredEndSound = true;
      else {
        this.startSoundRemaining = 0;
        this.audioSuspended = true;
        this.audioInterruptedAt = Date.now();
        this.saveSessionAudio();
      }
      return;
    }
    this.deferredEndSound = false;
    this.currentSessionSound = type;
    if (type === 'start') this.saveSessionAudio();
    if (getReminderSettings(wx)[type] === 'vibrate') {
      this.playSessionVibration(type);
      return;
    }
    this.cuePlayer.play(type === 'start' ? '/audio/起坐.mp3' : '/audio/收坐.mp3');
  },

  playSessionVibration(type, remainingMs = 3000) {
    const claim = { type, sessionId: this.endReminderSessionId, player: null };
    this.vibrationCue = claim;
    claim.player = createVibrationCue({
      api: wx,
      canPlay: () => this.canPlayTimerAudio(),
      now: () => Date.now(), setTimeout, clearTimeout,
      onEnded: ({ failed, error }) => {
        // 旧会话的异步回调不能完成或撤销后来一轮的提醒。
        if (this.vibrationCue !== claim || this.isUnloaded
          || this.currentSessionSound !== claim.type
          || this.endReminderSessionId !== claim.sessionId) return;
        this.vibrationCue = null;
        if (failed) this.safeTimerEffect('vibration_diagnostic', () => this.countdownSession.diagnose('vibration_failed', {
          cue: type, message: String(error && (error.errMsg || error.message) || '').slice(0, 160)
        }));
        this.handleSessionSoundEnded({ failed, vibration: true });
      }
    });
    claim.player.play({ remainingMs });
    // Persist the selected vibration before the process can disappear without
    // an interruption callback; otherwise a cold restore could mistake it for a bell.
    if (type === 'start') this.saveSessionAudio();
  },

  pauseSessionCue() {
    if (this.vibrationCue) this.vibrationCue.player.pause();
    else this.cuePlayer.pause();
  },

  resumeSessionCue() {
    if (this.restoredVibrationRemaining !== null) {
      const remainingMs = this.restoredVibrationRemaining;
      this.restoredVibrationRemaining = null;
      this.playSessionVibration('start', remainingMs);
    } else if (this.vibrationCue) this.vibrationCue.player.resume();
    else this.cuePlayer.resume();
  },

  stopSessionSound() {
    if (this.vibrationCue) this.vibrationCue.player.stop();
    this.vibrationCue = null;
    this.restoredVibrationRemaining = null;
    this.deferredEndSound = false;
    if (this.startSoundTimer !== null) {
      clearTimeout(this.startSoundTimer);
      this.startSoundTimer = null;
    }
    this.startSoundRemaining = null;
    this.currentSessionSound = null;
    this.endReminderSessionId = null;
    this.audioSuspended = false;
    this.resumeGuideAfterInterruption = false;
    this.cuePlayer.stop();
  },

  handleSessionSoundEnded({ failed = false, vibration = false } = {}) {
    const wasStartSound = this.currentSessionSound === 'start';
    const wasEndSound = this.currentSessionSound === 'end';
    const endSessionId = this.endReminderSessionId;
    this.currentSessionSound = null;
    this.endReminderSessionId = null;
    if (wasStartSound) {
      this.openingReminderCompleted = !failed;
      this.saveSessionAudio();
    }
    if (wasEndSound) {
      if (failed) {
        this.endReminderFailed = true;
        this.deferredEndSound = true;
        if (this.isPageVisible && this.canPlayTimerAudio()) {
          if (!vibration) this.safeTimerEffect('end_fallback_vibration', () => wx.vibrateLong({}));
          this.safeTimerEffect('end_fallback_notice', () => wx.showToast({
            title: vibration ? '静坐已结束，震动提醒失败，可返回计时页重试'
              : '静坐已结束，铃声播放失败，已尝试震动提醒', icon: 'none', duration: 3500
          }));
        }
      } else {
        if (endSessionId) clearEndReminder(wx, endSessionId);
        this.lastEndReminderSessionId = endSessionId;
        this.endReminderFailed = false;
        this.deferredEndSound = false;
      }
    }
    // 起坐播完后才接着播放引导，避免两段音频同时播放。
    if (wasStartSound && this.data.isRunning && !this.isUnloaded) {
      if (!this.canPlayTimerAudio()) {
        this.audioSuspended = true;
        this.resumeGuideAfterInterruption = true;
        this.saveSessionAudio();
        return;
      }
      this.safeTimerEffect('start_guide', () => this.playBackgroundMusic());
    }
  },

  showMusicPicker() { this.setData({ showMusicPicker: true }); },
  hideMusicPicker() { this.setData({ showMusicPicker: false }); },

  selectMusic(e) {
    const value = e.currentTarget.dataset.value;
    const option = this.data.musicOptions.find(opt => opt.value === value);
    if (option) {
      const previous = this.data.backgroundMusic;
      this.setData({
        backgroundMusic: value,
        musicText: option.text,
        showMusicPicker: false
      });
      if (value === 'none') {
        // Keep the confirmed position, but revoke both live and deferred intent.
        this.resumeGuideAfterInterruption = false;
        this.safeTimerEffect('pause_selected_guide', () => this.pauseBackgroundMusic());
      } else {
        // Choosing the guide explicitly can replay a completed recording;
        // foreground recovery and manual resume alone must not replay it.
        if (this.guideCompleted) {
          this.safeTimerEffect('restart_selected_guide', () => this.stopBackgroundMusic());
          this.guideCompleted = false;
        }
        if (this.data.isRunning && (previous !== value || !this.guidePlaybackWanted || !this.backgroundMusicPlayer)) {
          this.safeTimerEffect('play_selected_guide', () => this.playBackgroundMusic());
        }
      }
      this.saveSessionAudio();
    }
  },

  playBackgroundMusic() {
    if (!this.data.isRunning || this.guideCompleted || this.data.backgroundMusic !== 'default') return;
    if (this.startSoundRemaining !== null || this.currentSessionSound === 'start') return;
    // Keep the selected guide owed even while its cloud URL is still loading.
    this.guidePlaybackWanted = true;
    if (!this.canPlayTimerAudio()) {
      this.audioSuspended = true;
      this.resumeGuideAfterInterruption = true;
      return;
    }
    if (this.data.backgroundMusic === 'default' && this.data.defaultMusicUrl) {
      console.log('🎵 开始播放背景音乐，URL:', this.data.defaultMusicUrl);

      if (!this.backgroundMusicPlayer) {
        const player = wx.createInnerAudioContext();
        this.backgroundMusicPlayer = player;
        this.backgroundMusicPlayer.src = this.data.defaultMusicUrl;
        this.backgroundMusicPlayer.startTime = this.guideResumePosition || 0;
        this.guideResumePosition = 0;
        this.backgroundMusicPlayer.loop = false; // 引导音频不循环播放
        this.backgroundMusicPlayer.obeyMuteSwitch = false;

        // 引导仅在应用前台、系统音频可用时播放。
        this.backgroundMusicPlayer.onPlay(() => {
          console.log('✅ 引导音频开始播放');
        });
        this.backgroundMusicPlayer.onEnded(() => {
          if (this.backgroundMusicPlayer !== player || this.isUnloaded) return;
          this.guidePlaybackWanted = false;
          this.resumeGuideAfterInterruption = false;
          this.guideCompleted = true;
          this.saveSessionAudio();
        });
        if (typeof player.onTimeUpdate === 'function') player.onTimeUpdate(() => {
          if (this.backgroundMusicPlayer === player) this.checkpointSessionAudioProgress();
        });
        this.backgroundMusicPlayer.onError((err) => {
          if (this.backgroundMusicPlayer !== player || this.isUnloaded) return;
          this.guideResumePosition = Math.max(0, player.currentTime || 0, player.startTime || 0);
          this.destroyBackgroundMusicPlayer();
          this.countdownSession.diagnose('guide_error', { code: err.errCode });
          console.error('❌ 背景音乐播放失败:', err);
          console.error('错误详情:', {
            errCode: err.errCode,
            errMsg: err.errMsg
          });
          // A refreshed cloud URL may arrive while the restored old decoder is
          // still loading. Retry only when that source has actually changed.
          if (this.data.defaultMusicUrl !== player.src) this.resumeGuideAfterUrlRefresh();
          else this.notifyGuideUnavailable();
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
        this.guidePlaybackWanted = true;
        this.backgroundMusicPlayer.play();
        this.saveSessionAudio();
        console.log('🎵 已请求播放引导音频');
      } else {
        console.error('❌ 背景音乐播放器未创建');
      }
    } else {
      this.saveSessionAudio();
      if (this.guideLoadFailed) this.notifyGuideUnavailable();
      console.log('🎵 背景音乐设置:', {
        backgroundMusic: this.data.backgroundMusic,
        defaultMusicUrl: this.data.defaultMusicUrl ? '已设置' : '未设置'
      });
    }
  },

  pauseBackgroundMusic({ interrupted = false } = {}) {
    if (!interrupted) this.guidePlaybackWanted = false;
    const player = this.backgroundMusicPlayer;
    if (!player) return;
    try { player.pause(); }
    catch (error) {
      this.guideResumePosition = Math.max(0, player.currentTime || 0, player.startTime || 0);
      this.destroyBackgroundMusicPlayer();
      this.countdownSession.diagnose('guide_pause_error');
    }
  },

  stopBackgroundMusic() {
    this.guidePlaybackWanted = false;
    this.guideResumePosition = 0;
    const player = this.backgroundMusicPlayer;
    if (!player) return;
    // Retire identity before native stop/destroy can deliver queued events.
    // A new sitting must never reuse listeners belonging to an older guide.
    this.backgroundMusicPlayer = null;
    try { player.stop(); player.startTime = 0; }
    catch (error) {
      this.countdownSession.diagnose('guide_stop_error');
    }
    try { player.destroy(); }
    catch (error) { this.countdownSession.diagnose('guide_destroy_error'); }
  },

  destroyBackgroundMusicPlayer() {
    const player = this.backgroundMusicPlayer;
    this.backgroundMusicPlayer = null;
    if (!player) return;
    try { player.destroy(); }
    catch (error) { this.countdownSession.diagnose('guide_destroy_error'); }
  },

  resumeGuideAfterUrlRefresh() {
    if (this.isUnloaded || !this.data.isRunning || this.backgroundMusicPlayer
      || this.startSoundRemaining !== null || this.currentSessionSound === 'start' || this.guideCompleted
      || (!this.guidePlaybackWanted && !this.resumeGuideAfterInterruption)) return;
    this.safeTimerEffect('resume_refreshed_guide', () => this.playBackgroundMusic());
  },

  // 云存储引导按需接续；迟到的响应不能更新已卸载的页面。
  getBackgroundMusicUrl() {
    this.guideLoadFailed = false;
    wx.cloud.init({ env: 'cloud1-2g2rbxbu2c126d4a' });
    wx.cloud.getTempFileURL({
      fileList: [{ fileID: this.data.defaultMusicFileID }],
      success: urlRes => {
        if (this.isUnloaded) return;
        if (urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) {
          this.guideLoadFailed = false;
          this.refreshedGuideUrl = urlRes.fileList[0].tempFileURL;
          this.setData({ defaultMusicUrl: urlRes.fileList[0].tempFileURL });
          this.resumeGuideAfterUrlRefresh();
          console.log('✅ 获取背景音乐URL成功');
        } else {
          console.warn('❌ 临时URL为空，保留已有引导地址');
          this.useFallbackAudio();
        }
      },
      fail: err => {
        if (this.isUnloaded) return;
        console.error('❌ 获取背景音乐URL失败:', err);
        this.useFallbackAudio();
      }
    });
  },

  useFallbackAudio() {
    // No guide is bundled with the mini-program. Keep a known URL if present,
    // and leave timing/bells available when the network cannot supply one.
    this.guideLoadFailed = true;
    this.resumeGuideAfterUrlRefresh();
  },

  notifyGuideUnavailable() {
    if (this.guideUnavailableNotified || !this.data.isRunning || this.data.backgroundMusic !== 'default'
      || !this.canPlayTimerAudio()) return;
    this.guideUnavailableNotified = true;
    this.safeTimerEffect('guide_unavailable_notice', () => wx.showToast({
      title: '引导音频暂不可用，计时继续', icon: 'none', duration: 3000
    }));
  },

};

module.exports = { timerAudioMethods };
