const { createCuePlayer } = require('./cuePlayer');
const { getReminderSettings } = require('./timerReminderSettings');
const { queueEndReminder, getEndReminder, clearEndReminder } = require('./timerEndReminder');

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
    this.audioPlayer = null;
    this.backgroundMusicPlayer = null;
    this.cuePlayer = createCuePlayer({
      api: wx,
      canPlay: () => this.canPlayTimerAudio(),
      onPlayerChange: player => { this.audioPlayer = player; },
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
      const oldReminder = getEndReminder(wx);
      if (oldReminder) clearEndReminder(wx, oldReminder.sessionId);
      this.endReminderFailed = false;
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
      this.scheduleStartSound();
    } else if (this.startSoundRemaining !== null) {
      this.scheduleStartSound(this.startSoundRemaining);
    } else if (this.currentSessionSound === 'start') {
      if (this.canPlayTimerAudio()) this.cuePlayer.resume();
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
    if (this.currentSessionSound === 'start') this.cuePlayer.pause();
  },

  canPlayTimerAudio() {
    return !this.isUnloaded && !this.isAppHidden
      && this.timerApp._timerForeground !== false && !this.timerApp._timerAudioInterrupted;
  },

  // 只跨同进程页面重建保留音频；冷启动不续播起坐或引导。
  saveSessionAudio() {
    this.timerApp._timerSessionAudio = null;
    if (!this.sessionId || (!this.data.isRunning && !this.data.isPaused)) return;
    if (!this.isAppHidden && !this.timerApp._timerAudioInterrupted && !this.audioSuspended) return;
    const position = (player, fallback = 0) => Math.max(0,
      Number.isFinite(player && player.currentTime) ? player.currentTime : 0,
      Number.isFinite(player && player.startTime) ? player.startTime : 0, fallback);
    let startSoundRemaining = this.startSoundRemaining;
    if (startSoundRemaining !== null && this.startSoundTimer !== null) {
      startSoundRemaining = Math.max(0, startSoundRemaining - (Date.now() - this.startSoundScheduledAt));
    }
    this.timerApp._timerSessionAudio = {
      sessionId: this.sessionId, isCountdown: this.data.isCountdown,
      backgroundMusic: this.data.backgroundMusic, guideUrl: this.data.defaultMusicUrl,
      guidePosition: position(this.backgroundMusicPlayer, this.guideResumePosition || 0),
      guideWanted: !!(this.guidePlaybackWanted || this.resumeGuideAfterInterruption),
      startSoundRemaining, currentSessionSound: this.currentSessionSound,
      // 故障重建间隙可能没有 native 对象，恢复位置由铃声控制器持有。
      cuePosition: this.cuePlayer.position,
      waitAt: this.audioSuspended ? this.audioInterruptedAt : Date.now()
    };
  },

  restoreSessionAudio() {
    const saved = this.timerApp._timerSessionAudio;
    // 领取一次，结束、取消或另一会话都不能复活旧音频。
    this.timerApp._timerSessionAudio = null;
    if (!saved || saved.sessionId !== this.sessionId || saved.isCountdown !== this.data.isCountdown
      || (!this.data.isRunning && !this.data.isPaused) || this.pendingCompletion) return;
    this.setData({ backgroundMusic: saved.backgroundMusic,
      musicText: saved.backgroundMusic === 'default' ? '引导音频' : '无音乐',
      ...(saved.guideUrl ? { defaultMusicUrl: saved.guideUrl } : {}) });
    this.guideResumePosition = saved.guidePosition;
    this.resumeGuideAfterInterruption = saved.guideWanted;
    this.startSoundRemaining = saved.startSoundRemaining;
    this.audioInterruptedAt = saved.waitAt;
    this.audioSuspended = true;
    if (saved.currentSessionSound === 'start') {
      this.currentSessionSound = 'start';
      this.cuePlayer.prepare('/audio/起坐.mp3', { position: saved.cuePosition });
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
    if (this.currentSessionSound) this.cuePlayer.pause();
    this.pauseBackgroundMusic({ interrupted: true });
  },

  resumeInterruptedAudio({ allowEndRetry = false } = {}) {
    if (allowEndRetry) this.endReminderFailed = false;
    if (!this.isPageVisible || !this.canPlayTimerAudio()) return;
    const pendingEnd = getEndReminder(wx);
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
          this.cuePlayer.resume();
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
      this.cuePlayer.resume();
    } else if (this.data.isRunning) {
      if (this.startSoundRemaining !== null) {
        const delay = Math.max(0, this.startSoundRemaining - (Date.now() - this.audioInterruptedAt));
        this.scheduleStartSound(delay);
      } else if (this.currentSessionSound === 'start') {
        this.cuePlayer.resume();
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
      return;
    }
    this.startSoundTimer = setTimeout(() => {
      this.startSoundTimer = null;
      this.startSoundRemaining = null;
      if (this.data.isRunning && !this.isUnloaded) {
        this.safeTimerEffect('start_cue', () => this.playSessionSound('start'));
      }
    }, delay);
  },

  playSessionSound(type) {
    if (this.isUnloaded) return;
    let endReminder = null;
    if (type === 'end') {
      endReminder = getEndReminder(wx);
      if (!endReminder) {
        const sessionId = this.sessionId || this.pendingCompletion && this.pendingCompletion.sessionId;
        if (sessionId && sessionId === this.lastEndReminderSessionId) return;
        if (sessionId) endReminder = queueEndReminder(wx, sessionId);
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
      return;
    }
    this.deferredEndSound = false;
    this.currentSessionSound = type;
    if (getReminderSettings(wx)[type] === 'vibrate') {
      this.safeTimerEffect('vibrate_cue', () => wx.vibrateLong({
        fail: error => this.countdownSession.diagnose('vibration_failed', {
          cue: type, message: String(error && error.errMsg || '').slice(0, 160)
        })
      }));
      // 震动没有音频结束事件；立即释放提醒状态，让引导继续且恢复时不补播铃声。
      this.handleSessionSoundEnded();
      return;
    }
    this.cuePlayer.play(type === 'start' ? '/audio/起坐.mp3' : '/audio/收坐.mp3');
  },

  stopSessionSound() {
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

  handleSessionSoundEnded({ failed = false } = {}) {
    const wasStartSound = this.currentSessionSound === 'start';
    const wasEndSound = this.currentSessionSound === 'end';
    const endSessionId = this.endReminderSessionId;
    this.currentSessionSound = null;
    this.endReminderSessionId = null;
    if (wasEndSound) {
      if (failed) {
        this.endReminderFailed = true;
        this.deferredEndSound = true;
        if (this.isPageVisible && this.canPlayTimerAudio()) {
          this.safeTimerEffect('end_fallback_vibration', () => wx.vibrateLong({}));
          this.safeTimerEffect('end_fallback_notice', () => wx.showToast({
            title: '静坐已结束，铃声播放失败，已尝试震动提醒', icon: 'none', duration: 3500
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
      this.setData({
        backgroundMusic: value,
        musicText: option.text,
        showMusicPicker: false
      });
    }
  },

  playBackgroundMusic() {
    if (!this.canPlayTimerAudio()) {
      if (this.data.isRunning && this.data.backgroundMusic === 'default' && this.data.defaultMusicUrl) {
        this.audioSuspended = true;
        this.resumeGuideAfterInterruption = true;
      }
      return;
    }
    if (this.startSoundRemaining !== null || this.currentSessionSound === 'start') return;
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
        console.log('🎵 已请求播放引导音频');
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
    try { player.stop(); player.startTime = 0; }
    catch (error) {
      this.destroyBackgroundMusicPlayer();
      this.countdownSession.diagnose('guide_stop_error');
    }
  },

  destroyBackgroundMusicPlayer() {
    const player = this.backgroundMusicPlayer;
    this.backgroundMusicPlayer = null;
    if (!player) return;
    try { player.destroy(); }
    catch (error) { this.countdownSession.diagnose('guide_destroy_error'); }
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

};

module.exports = { timerAudioMethods };
