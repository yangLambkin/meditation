// app.js
const checkinManager = require('./utils/checkin.js');

App({
  onLaunch: function () {
    this._timerForeground = true;
    this._timerHideOptions = null;
    this._timerAudioInterrupted = false;
    this.setupTimerAudioInterruption();
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    
    // 初始化云开发
    wx.cloud.init({
      // 明确指定环境ID
      env: 'cloud1-2g2rbxbu2c126d4a',
      traceUser: true
    });
    
    console.log('云开发初始化完成');
    this.setupRecordRefresh();
    this.resumePracticeRecords();
    
    // 设置缓存状态标记
    this.setupCacheStatus();
    
    // 测试云环境连接
    this.testCloudEnvironment();
    
    // 设置音频选项，解决iOS静音模式下无声音问题
    this.setAudioOptions();
    
    // 注意：数据库集合只需在项目部署时创建一次
    // 如需创建数据库集合，请手动调用 autoCreateCollections 云函数
    // this.autoCreateCollections();
  },

  onShow() {
    this._timerForeground = true;
    this._timerHideOptions = null;
    this.flushPersistedTimerExit();
    // 先同步恢复计时与截止状态；缓存页面渲染失败不能冻结核心计时。
    if (this._countdownSession) this._countdownSession.appShow();
    this.flushDetachedCountupExit();
    try { this.refreshTabBars(); }
    catch (error) { console.warn('底部导航刷新失败:', error && error.message); }
    // 结束提醒只由可见的计时页播放；首页保留待提醒状态而不接续声音。
    if (!wx.cloud) return;
    this.resumePracticeRecords();
    this.startSyncAlertRefresh();
    // 接续已入账历史记录的必经任务，独立运行，不阻塞云端记录的读取/上传。
    if (typeof checkinManager.resumeHistoricalBijingSync === 'function') {
      Promise.resolve().then(() => checkinManager.resumeHistoricalBijingSync()).catch(error => {
        console.warn('历史记录必经同步待重试:', error && error.message);
      });
    }
    // 打开/返回小程序补传当前账号所有日期的待上传记录，同时读取云端。
    const refresh = this.refreshRecordBackups();
    const upload = this.resumeRecordBackups();
    return Promise.all([refresh, upload]);
  },

  onHide(options = {}) {
    this._timerForeground = false;
    this._timerHideOptions = options || {};
    if (this._timerExitAudio) this._timerExitAudio.stop();
    // 明确用户退出按实际用时结算；原生页、来电和未知原因保留会话。
    if (this._countdownSession) this._countdownSession.appHide(this._timerHideOptions);
    this.finishDetachedCountup(this._timerHideOptions);
    if (this._timerHideOptions.reason === 0 || this._timerHideOptions.reason === 1) {
      this.finishPersistedTimerOnExit();
      const { dismissEndReminder } = require('./utils/timerEndReminder');
      dismissEndReminder(wx);
    }
    this._syncAlertVisible = false;
    this.clearSyncAlert();
  },

  setupTimerAudioInterruption() {
    if (this._timerAudioInterruptionReady) return;
    this._timerAudioInterruptionReady = true;
    // 音频占用和静坐会话相互独立；中断结束后才允许计时页恢复声音。
    if (typeof wx.onAudioInterruptionBegin === 'function') {
      wx.onAudioInterruptionBegin(() => {
        this._timerAudioInterrupted = true;
        if (this._timerExitAudio) this._timerExitAudio.pause();
      });
    }
    if (typeof wx.onAudioInterruptionEnd === 'function') {
      wx.onAudioInterruptionEnd(() => {
        this._timerAudioInterrupted = false;
      });
    }
  },

  getCountdownSession() {
    if (!this._countdownSession) {
      this.flushPersistedTimerExit();
      // 只在使用倒计时时加载；控制器由 App 持有，不随计时页重建。
      const { createCountdownSessionController } = require('./utils/countdownSession');
      this._countdownSession = createCountdownSessionController({
        api: wx,
        getRecoveryState: () => {
          const exit = this.getPersistedTimerExit();
          return exit && exit.state.isCountdown ? exit.state : null;
        },
        isCompletionRecorded: sessionId => this.hasRecordedTimerCompletion(sessionId),
        recordCheckin: (...args) => checkinManager.recordCheckin(...args)
      });
      if (this._timerForeground === false) this._countdownSession.appHide(this._timerHideOptions || {});
    }
    return this._countdownSession;
  },

  // 入账账本是完成确认的最终依据；只读核对，不创建身份或触发上传/迁移。
  hasRecordedTimerCompletion(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return false;
    try {
      const userId = wx.getStorageSync('localUserId');
      if (typeof userId !== 'string' || !userId) return false;
      const stored = checkinManager.getUserCheckinDataByUserId(userId);
      const records = stored && (stored.checkinRecords || stored);
      return Object.values(records && records.dailyRecords || {}).some(day =>
        day && Array.isArray(day.records) && day.records.some(record => record
          && (record.localId === sessionId || record.idempotencyKey === sessionId)));
    } catch (error) {
      console.warn('静坐入账确认暂不可读，保留恢复草稿:', error && error.message);
      return false;
    }
  },

  getTimerExitAudio() {
    if (!this._timerExitAudio) {
      const { createTimerExitAudio } = require('./utils/timerExitAudio');
      this._timerExitAudio = createTimerExitAudio({
        api: wx,
        canPlay: () => this._timerForeground !== false && !this._timerAudioInterrupted,
        diagnose: (type, details) => {
          if (this._countdownSession) this._countdownSession.diagnose(type, details);
        }
      });
    }
    return this._timerExitAudio;
  },

  // 冷启动只打开首页时没有计时页或控制器，但明确退出仍须结束上个进程的会话。
  // 普通启动和被动后台不加载计时控制器，也不改写这个检查点。
  finishPersistedTimerOnExit() {
    if (this._countdownSession || this._detachedCountupSessionId || this._detachedCountupExit
      || this._timerPage && !this._timerPage.isUnloaded || this._persistedTimerExit) return;
    let state;
    let pending;
    try {
      state = wx.getStorageSync('timerState');
      pending = wx.getStorageSync('timerPendingCompletion');
    } catch (error) {
      console.warn('冷启动退出检查点读取失败，保留原状态:', error && error.message);
      return;
    }
    // 已完成草稿和终态先于任何旧活动快照；不重新结算或覆盖它们。
    if (pending || !state || state.pendingCompletion || (!state.isRunning && !state.isPaused)) return;
    const limit = state.isCountdown === true ? state.totalTime : 24 * 60 * 60;
    const totalPausedTime = state.totalPausedTime === undefined ? 0 : state.totalPausedTime;
    const effectiveEnd = state.isPaused ? state.pauseTimestamp : state.saveTime;
    if (typeof state.isCountdown !== 'boolean' || typeof state.sessionId !== 'string'
      || !state.sessionId || state.sessionId.length > 256
      || typeof state.isRunning !== 'boolean' || typeof state.isPaused !== 'boolean'
      || state.isRunning === state.isPaused
      || state.status !== undefined && state.status !== (state.isRunning ? 'running' : 'paused')
      || state.isCountdown && state.schemaVersion !== undefined && state.schemaVersion !== 2
      || state.isCountdown && state.schemaVersion === 2 && (typeof state.runtimeId !== 'string' || !state.runtimeId)
      || !Number.isInteger(state.totalTime) || state.totalTime < 1 || state.totalTime > 86400
      || !Number.isFinite(state.startTimestamp) || state.startTimestamp <= 0
      || !Number.isFinite(state.saveTime) || state.saveTime < state.startTimestamp
      || !Number.isFinite(totalPausedTime) || totalPausedTime < 0
      || !Number.isFinite(state.elapsedTime) || state.elapsedTime < 0 || state.elapsedTime > limit
      || !Number.isFinite(effectiveEnd) || effectiveEnd < state.startTimestamp || effectiveEnd > state.saveTime
      || state.elapsedTime > Math.max(0, Math.floor((effectiveEnd - state.startTimestamp - totalPausedTime) / 1000))) return;
    const exitAt = Date.now();
    const adjustment = Math.min(0, exitAt - state.saveTime);
    const startedAt = state.startTimestamp + adjustment;
    const finalSeconds = Math.min(limit, Math.max(state.elapsedTime, Math.floor(
      ((state.isPaused ? state.pauseTimestamp + adjustment : exitAt) - startedAt - totalPausedTime) / 1000)));
    const endedAt = finalSeconds >= limit ? Math.min(exitAt, startedAt + totalPausedTime + limit * 1000) : exitAt;
    const duration = Math.floor(finalSeconds / 60);
    const completion = duration >= 1 ? { sessionId: state.sessionId, duration, endedAt, text: '' } : null;
    // 终态含草稿副本；即使单独草稿写失败，也不能在下一进程重新累计或补响旧铃。
    const terminal = { ...state, startTimestamp: startedAt, pauseTimestamp: 0, totalPausedTime,
      status: 'exited', terminalReason: 'app_hide', isRunning: false, isPaused: false,
      elapsedTime: finalSeconds, remainingTime: Math.max(0, state.totalTime - finalSeconds),
      saveTime: exitAt, pendingCompletion: completion };
    this._persistedTimerExit = terminal;
    const write = (key, value) => {
      try { wx.setStorageSync(key, value); }
      catch (error) { console.warn('冷启动退出状态待重试:', key, error && error.message); }
    };
    write('timerState', { ...terminal });
    if (completion) write('timerPendingCompletion', { ...completion });
    let saved = !completion;
    if (completion) {
      try {
        const result = checkinManager.recordCheckin(duration, [], [], endedAt, state.sessionId);
        saved = !!(result && result.success);
      } catch (error) { console.warn('冷启动退出保存失败，保留完成草稿:', error && error.message); }
    }
    if (saved) {
      const savedIds = this._timerSavedCompletionIds || (this._timerSavedCompletionIds = new Set());
      savedIds.add(state.sessionId);
      if (savedIds.size > 200) savedIds.delete(savedIds.values().next().value);
      terminal.pendingCompletion = null;
      try {
        const current = wx.getStorageSync('timerState');
        if (current && current.sessionId === state.sessionId) write('timerState', { ...terminal });
      } catch (error) { console.warn('冷启动退出终态清理待重试:', error && error.message); }
      try {
        const draft = wx.getStorageSync('timerPendingCompletion');
        if (draft && draft.sessionId === state.sessionId) write('timerPendingCompletion', null);
      } catch (error) { console.warn('冷启动退出草稿清理待重试:', error && error.message); }
    }
    const name = state.isCountdown ? '倒计时' : '正计时';
    this._persistedTimerExitNotice = !completion ? `${name}已结束，不足1分钟未记录`
      : saved ? `${name}已结束，${duration}分钟已存本机` : `${name}已结束，请确认保存记录`;
    write('timerCompletionNotice', this._persistedTimerExitNotice);
  },

  getPersistedTimerExit() {
    const state = this._persistedTimerExit;
    if (!state) return null;
    if (this._timerSavedCompletionIds && this._timerSavedCompletionIds.has(state.sessionId)
      || state.pendingCompletion && this.hasRecordedTimerCompletion(state.sessionId)) {
      state.pendingCompletion = null;
      const name = state.isCountdown ? '倒计时' : '正计时';
      this._persistedTimerExitNotice = state.elapsedTime >= 60
        ? `${name}已结束，${Math.floor(state.elapsedTime / 60)}分钟已存本机` : `${name}已结束，不足1分钟未记录`;
    } else if (state.pendingCompletion) {
      try {
        const pending = wx.getStorageSync('timerPendingCompletion');
        if (pending && pending.sessionId === state.sessionId && pending.duration === state.pendingCompletion.duration
          && pending.endedAt === state.pendingCompletion.endedAt) {
          state.pendingCompletion = { ...state.pendingCompletion, text: String(pending.text || '').slice(0, 2000) };
        }
      } catch (_) { /* The confirmed in-memory completion survives an unreadable draft. */ }
    }
    return { sessionId: state.sessionId, state: { ...state }, saved: !state.pendingCompletion,
      completion: state.pendingCompletion ? { ...state.pendingCompletion } : null,
      notice: this._persistedTimerExitNoticeConsumed ? '' : this._persistedTimerExitNotice || '' };
  },

  // 只补写原退出的终态和草稿，不重试入账；任何更新的会话/草稿或读取失败都保持原样。
  flushPersistedTimerExit() {
    const exit = this.getPersistedTimerExit();
    if (!exit) return;
    try {
      const state = wx.getStorageSync('timerState');
      const pending = wx.getStorageSync('timerPendingCompletion');
      if (state && state.sessionId !== exit.sessionId || pending && pending.sessionId !== exit.sessionId) return;
      wx.setStorageSync('timerState', exit.state);
      if (exit.completion && !pending) wx.setStorageSync('timerPendingCompletion', exit.completion);
      else if (exit.saved && pending) wx.setStorageSync('timerPendingCompletion', null);
    } catch (error) { console.warn('冷启动退出终态待补写:', error && error.message); }
  },

  playTimerExitReminder(options = {}) {
    this.getTimerExitAudio().play(options);
  },

  // 正计时页因中断卸载后，由 App 接管明确退出，直到新页面接回会话。
  finishDetachedCountup(options) {
    const sessionId = this._detachedCountupSessionId;
    if (!sessionId) return;
    const { isExplicitTimerExit } = require('./utils/timerInterruption');
    if (!isExplicitTimerExit(options)) return;
    if (this._detachedCountupExit && this._detachedCountupExit.sessionId === sessionId) {
      this._detachedCountupSessionId = null;
      this.flushDetachedCountupExit();
      return;
    }
    // 页面交接的检查点比可能写失败的磁盘快照更新，优先核对并使用。
    const handed = this._detachedCountupState;
    let state = handed && handed.sessionId === sessionId && handed.runtimeId === this._timerRuntimeId ? handed : null;
    let readFailed = false;
    if (!state) {
      try { state = wx.getStorageSync('timerState'); }
      catch (error) {
        readFailed = true;
        console.warn('正计时退出检查点读取失败:', error && error.message);
      }
    }
    if (!state || state.sessionId !== sessionId || state.runtimeId !== this._timerRuntimeId
      || state.isCountdown !== false || state.interrupted !== true || (!state.isRunning && !state.isPaused)) {
      if (!readFailed) this._detachedCountupSessionId = null;
      return;
    }
    const exitAt = Date.now();
    const adjustment = Number.isFinite(state.saveTime) ? Math.min(0, exitAt - state.saveTime) : 0;
    const startedAt = state.startTimestamp + adjustment;
    const effectiveEnd = state.isPaused ? state.pauseTimestamp + adjustment : exitAt;
    const elapsed = Math.max(0, Number(state.elapsedTime) || 0,
      Math.floor((effectiveEnd - startedAt - state.totalPausedTime) / 1000));
    const duration = Math.floor(Math.min(elapsed, 24 * 60 * 60) / 60);
    const endedAt = elapsed >= 24 * 60 * 60
      ? Math.min(exitAt, startedAt + state.totalPausedTime + 24 * 60 * 60 * 1000) : exitAt;
    const completion = duration >= 1 ? { sessionId, duration, endedAt, text: '' } : null;
    // 先提交内存终态再写盘/入账；清理失败不能让旧检查点或重入回调复活会话。
    const terminal = { ...state, startTimestamp: startedAt, pauseTimestamp: 0,
      status: 'exited', terminalReason: 'app_hide', isRunning: false, isPaused: false,
      elapsedTime: Math.min(elapsed, 86400), saveTime: exitAt, pendingCompletion: completion };
    const exit = this._detachedCountupExit = { sessionId, completion, state: terminal, saved: !completion, notice: '' };
    this._detachedCountupSessionId = null;
    this._detachedCountupState = null;
    if (this._timerSessionAudio && this._timerSessionAudio.sessionId === sessionId) this._timerSessionAudio = null;
    const write = (key, value) => {
      try { wx.setStorageSync(key, value); }
      catch (error) { console.warn('正计时退出状态待重试:', key, error && error.message); }
    };
    const persistDraft = value => {
      try {
        const pending = wx.getStorageSync('timerPendingCompletion');
        if (value ? !pending || pending.sessionId === sessionId : pending && pending.sessionId === sessionId) {
          write('timerPendingCompletion', value);
        }
      } catch (error) { console.warn('正计时退出草稿身份待核对:', error && error.message); }
    };
    // 草稿和终态分别保留恢复依据；单项写失败不能清掉另一份唯一备份。
    try {
      const stored = wx.getStorageSync('timerState');
      if (!stored || stored.sessionId === sessionId) write('timerState', { ...terminal });
    } catch (error) { console.warn('正计时退出检查点身份待核对:', error && error.message); }
    if (completion) persistDraft({ ...completion });
    if (completion) {
      try {
        const savedIds = this._timerSavedCompletionIds || (this._timerSavedCompletionIds = new Set());
        const result = savedIds.has(sessionId) ? { success: true }
          : checkinManager.recordCheckin(duration, [], [], endedAt, sessionId);
        if (result && result.success) {
          exit.saved = true;
          savedIds.add(sessionId);
          if (savedIds.size > 200) savedIds.delete(savedIds.values().next().value);
          persistDraft(null);
        }
      } catch (error) {
        console.warn('正计时退出保存失败，保留完成草稿:', error && error.message);
      }
    }
    this.flushDetachedCountupExit();
    exit.notice = !completion ? '正计时已结束，不足1分钟未记录'
      : exit.saved ? `正计时已结束，${duration}分钟已存本机` : '正计时已结束，请确认保存记录';
    write('timerCompletionNotice', exit.notice);
  },

  getDetachedCountupExit(sessionId) {
    const exit = this._detachedCountupExit || this.getPersistedTimerExit();
    if (!exit || (sessionId && exit.sessionId !== sessionId)) return null;
    if (this._timerSavedCompletionIds && this._timerSavedCompletionIds.has(exit.sessionId)
      || !exit.saved && exit.completion && this.hasRecordedTimerCompletion(exit.sessionId)) {
      exit.saved = true;
      if (exit.completion) exit.notice = `正计时已结束，${exit.completion.duration}分钟已存本机`;
    } else if (exit.completion && !exit.saved) {
      try {
        const pending = wx.getStorageSync('timerPendingCompletion');
        if (pending && pending.sessionId === exit.sessionId && pending.duration === exit.completion.duration
          && pending.endedAt === exit.completion.endedAt) {
          exit.completion = { ...exit.completion, text: String(pending.text || '').slice(0, 2000) };
        }
      } catch (_) { /* Keep the confirmed in-memory draft until storage recovers. */ }
    }
    return { ...exit, notice: exit.noticeConsumed ? '' : exit.notice,
      state: exit.state ? { ...exit.state, pendingCompletion: exit.saved ? null : { ...exit.completion } } : undefined,
      completion: exit.completion ? { ...exit.completion } : null };
  },

  consumeDetachedCountupExitNotice(sessionId) {
    const exit = this._detachedCountupExit;
    if (exit && exit.sessionId === sessionId) exit.noticeConsumed = true;
    if (this._persistedTimerExit && this._persistedTimerExit.sessionId === sessionId) {
      this._persistedTimerExitNoticeConsumed = true;
    }
  },

  // 只重试草稿/检查点清理，不重试入账，也不覆盖新会话或另一份草稿。
  flushDetachedCountupExit() {
    const current = this._detachedCountupExit;
    if (!current) return;
    const exit = this.getDetachedCountupExit(current.sessionId);
    let durable = exit.saved;
    let draftCleared = false;
    try {
      const pending = wx.getStorageSync('timerPendingCompletion');
      if (exit.saved) {
        if (pending && pending.sessionId === exit.sessionId) wx.setStorageSync('timerPendingCompletion', null);
        draftCleared = true;
      } else if (exit.completion && !pending) {
        wx.setStorageSync('timerPendingCompletion', exit.completion);
        durable = true;
      } else if (exit.completion && pending.sessionId === exit.sessionId
        && pending.duration === exit.completion.duration && pending.endedAt === exit.completion.endedAt) {
        // 已存在的草稿可能刚写入感受；补写终态不能回滚用户的新文本。
        durable = true;
      }
    } catch (error) { console.warn('正计时退出草稿待重试:', error && error.message); }
    try {
      const state = wx.getStorageSync('timerState');
      if (!state || state.sessionId === exit.sessionId) {
        // 清理失败时保留已保存确认，让冷启动识别旧独立草稿已经入账。
        wx.setStorageSync('timerState', durable && (!exit.saved || draftCleared) ? null : exit.state);
      }
    } catch (error) { console.warn('正计时退出检查点清理待重试:', error && error.message); }
  },

  syncAlertIdentity() {
    try { return typeof wx.getStorageSync === 'function' ? wx.getStorageSync('userOpenId') || '' : ''; }
    catch (error) { return ''; }
  },
  setSyncAlertDot(visible) {
    this.forEachTabBar(bar => {
      if (typeof bar.setMeAlert === 'function') bar.setMeAlert(visible);
    });
    const action = visible ? wx.showTabBarRedDot : wx.hideTabBarRedDot;
    if (typeof action === 'function') action.call(wx, { index: 3, fail() {} });
  },
  registerTabBar(bar) {
    if (!this._tabBars) this._tabBars = new Set();
    this._tabBars.add(bar);
  },
  unregisterTabBar(bar) {
    if (this._tabBars) this._tabBars.delete(bar);
  },
  forEachTabBar(callback) {
    // Cached tab pages can be absent from the navigation stack. Update their
    // own bars now so the next switch cannot reveal an older three/four layout.
    const bars = new Set(this._tabBars || []);
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    pages.forEach(page => {
      const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null;
      if (bar) bars.add(bar);
    });
    bars.forEach(bar => callback(bar));
  },
  refreshTabBars() {
    this.forEachTabBar(bar => {
      if (typeof bar.refresh === 'function') bar.refresh();
    });
  },
  syncTabBar(page) {
    const bar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
    if (bar && typeof bar.refresh === 'function') bar.refresh(page);
  },
  getSyncAlertState({ includeBackfill = false } = {}) {
    const state = this._syncAlertState || {};
    const current = this._syncAlertVisible && this._syncAlertAccount === this.syncAlertIdentity();
    const result = { admin: !!(current && state.admin), user: !!(current && state.user) };
    // 保留旧调用方的默认返回值；订阅和红点合并使用完整的四个提醒来源。
    if (includeBackfill) {
      result.backfillUser = !!(current && state.backfillUser);
      result.backfillAdmin = !!(current && state.backfillAdmin);
    }
    return result;
  },
  watchSyncAlerts(listener) {
    if (!this._syncAlertListeners) this._syncAlertListeners = new Set();
    this._syncAlertListeners.add(listener);
    listener(this.getSyncAlertState({ includeBackfill: true }));
    return () => this._syncAlertListeners.delete(listener);
  },
  applySyncAlertDot() {
    const state = this.getSyncAlertState({ includeBackfill: true });
    this.setSyncAlertDot(state.admin || state.user || state.backfillUser || state.backfillAdmin);
    if (this._syncAlertListeners) this._syncAlertListeners.forEach(listener => {
      try { listener({ ...state }); }
      catch (error) { console.warn('更新提醒入口失败:', error); }
    });
  },
  clearAdminSyncAlert() {
    this._adminAlertGeneration = (this._adminAlertGeneration || 0) + 1;
    if (this._syncAlertState) {
      this._syncAlertState.admin = false;
      this._syncAlertState.backfillAdmin = false;
    }
    this.applySyncAlertDot();
  },
  clearSyncAlert({ preserveState = false } = {}) {
    const state = preserveState && this._syncAlertAccount === this.syncAlertIdentity() ? this._syncAlertState : null;
    this._syncAlertGeneration = (this._syncAlertGeneration || 0) + 1;
    this._syncAlertRequest = null;
    if (this._syncAlertCancel) this._syncAlertCancel();
    this._syncAlertCancel = null;
    this._syncAlertState = state || { admin: false, user: false, backfillUser: false, backfillAdmin: false };
    this.applySyncAlertDot();
  },
  startSyncAlertRefresh() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function' || typeof wx.showTabBarRedDot !== 'function') return;
    // 同一次前台期间只自动读取一轮，重复生命周期通知复用当前结果。
    if (this._syncAlertVisible) return this._syncAlertRequest || Promise.resolve();
    this._syncAlertVisible = true;
    this.clearSyncAlert();
    return this.refreshSyncAlert();
  },
  // 管理员待办、反馈结果、补录审批与补录结果独立核对，共用“我”的红点。
  // 仅打开/返回小程序时自动刷新；页面切换使用缓存，不轮询或自动重试。
  // 账号/权限变化、处理/删除/已读成功后可主动刷新，核对剩余提醒。
  refreshSyncAlert({ force = false } = {}) {
    if (!this._syncAlertVisible || !wx.cloud || typeof wx.cloud.callFunction !== 'function') return Promise.resolve();
    const identity = this.syncAlertIdentity();
    if (force || identity !== this._syncAlertAccount) this.clearSyncAlert({ preserveState: identity === this._syncAlertAccount });
    if (this._syncAlertRequest) return this._syncAlertRequest;
    this._syncAlertAccount = identity;
    const generation = this._syncAlertGeneration;
    const adminGeneration = this._adminAlertGeneration;
    const cancellations = [];
    const current = () => this._syncAlertVisible && generation === this._syncAlertGeneration && identity === this.syncAlertIdentity();
    const read = (source, name, type, hasAlert) => {
      let deadline;
      const adminSource = source === 'admin' || source === 'backfillAdmin';
      const valid = () => current() && (!adminSource || adminGeneration === this._adminAlertGeneration);
      return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(deadline); reject(new Error('提醒已暂停')); };
        cancellations.push(cancel);
        deadline = setTimeout(() => reject(new Error('提醒请求超时')), 10000);
        wx.cloud.callFunction({ name, data: { type }, success: resolve, fail: reject });
      }).then(response => {
        if (!valid()) return;
        const result = response && response.result;
        if (source === 'backfillAdmin' && result && result.code === 'FORBIDDEN') {
          this._syncAlertState.backfillAdmin = false;
          this.applySyncAlertDot();
          return;
        }
        if (!result || result.success !== true || !result.data) throw new Error('提醒读取失败');
        this._syncAlertState[source] = hasAlert(result.data);
        this.applySyncAlertDot();
      }).catch(() => {
        if (!valid()) return;
        // 读取失败不能确认已无未读；保留同一账号上次已确认的提醒。
        this.applySyncAlertDot();
      }).finally(() => clearTimeout(deadline));
    };
    this._syncAlertCancel = () => cancellations.forEach(cancel => cancel());
    const request = Promise.all([
      read('admin', 'adminManager', 'getSyncAlert', data => {
        if (typeof data.isAdmin !== 'boolean') throw new Error('管理员提醒数据无效');
        return data.isAdmin && (data.hasErrors === true || data.hasFeedback === true);
      }),
      read('user', 'meditationManager', 'getFeedbackAlert', data => {
        if (typeof data.hasUnreadFeedback !== 'boolean') throw new Error('反馈提醒数据无效');
        return data.hasUnreadFeedback;
      }),
      read('backfillUser', 'meditationManager', 'getBackfillAlert', data => {
        if (typeof data.hasUnreadBackfill !== 'boolean') throw new Error('补录结果提醒数据无效');
        return data.hasUnreadBackfill;
      }),
      read('backfillAdmin', 'adminManager', 'adminGetBackfillAlert', data => {
        if (data.isAdmin === false) return false;
        if (typeof data.hasPendingBackfill !== 'boolean') throw new Error('补录审批提醒数据无效');
        return data.hasPendingBackfill;
      })
    ]).finally(() => {
      if (generation !== this._syncAlertGeneration) return;
      this._syncAlertRequest = null;
      this._syncAlertCancel = null;
      if (!this._syncAlertVisible) return;
      if (identity !== this.syncAlertIdentity()) {
        this.applySyncAlertDot();
      }
    });
    this._syncAlertRequest = request;
    return request;
  },

  setupRecordRefresh() {
    if (this._networkStatusHandler) return;
    this._networkStatusHandler = ({ isConnected }) => {
      if (isConnected) {
        this.refreshRecordBackups();
        this.resumeRecordBackups();
        this.resumePracticeRecords();
      }
    };
    wx.onNetworkStatusChange(this._networkStatusHandler);
  },

  resumeRecordBackups() {
    return Promise.resolve().then(() => checkinManager.retryAutomaticBackups()).catch(error => {
      console.warn('本机记录自动上传失败，保留本机记录:', error);
    });
  },

  resumePracticeRecords() {
    // 新 OpenAPI 分支独立续传，不阻塞静坐原记录、统计及旧必经同步。
    return Promise.resolve().then(() => require('./utils/practiceMirror.js').resume()).catch(error => {
      console.warn('功课记录待上传，已保留本机任务:', error && error.message);
    });
  },

  refreshRecordBackups() {
    // 云端读取和本机补传独立运行，不弹全局加载框。
    return Promise.resolve().then(() => checkinManager.syncWithCloud({ uploadPending: false })).catch(error => {
      console.warn('读取云端静坐记录失败，保留本机记录:', error);
    });
  },
  
  // 测试云环境连接
  testCloudEnvironment: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      console.log('🔍 开始测试云环境连接...');
      
      // 测试云存储连接（使用实际存在的文件路径）
      wx.cloud.getTempFileURL({
        fileList: ['cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/bg_image/bg1.jpeg'],
        success: (res) => {
          if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
            console.log('✅ 云存储连接成功，可以正常访问背景图片');
          } else {
            console.warn('⚠️ 云存储文件不存在，将使用本地图片');
          }
        },
        fail: (err) => {
          console.warn('⚠️ 云存储连接失败，将使用本地图片:', err);
        }
      });
      
    }, 500); // 延迟500毫秒执行
  },
  
  // 设置缓存状态标记
  setupCacheStatus: function() {
    try {
      console.log('🔍 设置缓存状态标记...');
      
      // 检查是否首次启动或缓存已清除
      const cacheStatus = wx.getStorageSync('cacheStatus');
      if (!cacheStatus) {
        console.log('✅ 设置初始缓存状态标记');
        wx.setStorageSync('cacheStatus', 'initialized');
        wx.setStorageSync('needsRecovery', true);
      } else {
        console.log('✅ 缓存状态标记已存在:', cacheStatus);
      }
      
      // 检查应用版本，版本变更时可能需要数据恢复
      const CURRENT_VERSION = '1.0.0';
      const storedVersion = wx.getStorageSync('appVersion');
      
      if (storedVersion !== CURRENT_VERSION) {
        console.log('🔄 检测到版本变更，设置恢复标记');
        wx.setStorageSync('appVersion', CURRENT_VERSION);
        wx.setStorageSync('needsRecovery', true);
      }
      
    } catch (error) {
      console.warn('⚠️ 设置缓存状态标记失败:', error);
    }
  },
  
  // 设置音频选项
  setAudioOptions: function() {
    try {
      wx.setInnerAudioOption({
        obeyMuteSwitch: false,  // 不遵循静音开关，iOS静音模式下也能播放声音
        success: () => {
          console.log('✅ 音频选项设置成功，iOS静音模式可播放声音');
        },
        fail: (err) => {
          console.warn('⚠️ 音频选项设置失败:', err);
        }
      });
    } catch (error) {
      console.warn('⚠️ 设置音频选项时出错:', error);
    }
  },

  // 自动创建数据库集合
  autoCreateCollections: function() {
    // 延迟执行，确保云开发初始化完成
    setTimeout(() => {
      wx.cloud.callFunction({
        name: 'autoCreateCollections',
        success: res => {
          console.log('数据库集合自动创建结果:', res.result);
          if (res.result.success) {
            console.log('✅ 数据库集合创建成功');
            // 可以在这里添加成功后的回调逻辑
          } else {
            console.warn('⚠️ 数据库集合创建部分成功:', res.result.message);
          }
        },
        fail: err => {
          console.warn('⚠️ 数据库集合创建失败（可能是云函数未上传）:', err);
          // 忽略初始化错误，不影响小程序正常使用
        }
      });
    }, 1000); // 延迟1秒执行
  }
});
