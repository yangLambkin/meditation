const { isExplicitTimerExit } = require('./interruption');

// The historical controller belongs to the App, not a Page instance. System
// interruptions preserve its identity; deliberately leaving still ends a sit.
function createRuntime({ api, host = {}, recordCheckin, checkinManager }) {
  const saveRecord = recordCheckin || ((...args) =>
    (checkinManager || require('../../utils/checkin')).recordCheckin(...args));
  let launched = false;
  const runtime = {
    api,
    _timerForeground: true,
    _timerHideOptions: null,
    _timerAudioInterrupted: false,
    _countdownSession: null,

    onLaunch() {
      if (launched) return;
      launched = true;
      this._audioBegin = () => {
        this._timerAudioInterrupted = true;
        if (this._countdownSession) this._countdownSession.audioInterruptionBegin();
      };
      this._audioEnd = () => {
        this._timerAudioInterrupted = false;
        if (this._countdownSession) this._countdownSession.audioInterruptionEnd();
      };
      if (typeof api.onAudioInterruptionBegin === 'function') api.onAudioInterruptionBegin(this._audioBegin);
      if (typeof api.onAudioInterruptionEnd === 'function') api.onAudioInterruptionEnd(this._audioEnd);
    },

    onShow() {
      this._timerForeground = true;
      this._timerHideOptions = null;
      this.persistDetachedCountupExit();
      if (this._countdownSession) this._countdownSession.appShow();
    },

    onHide(options = {}) {
      this._timerForeground = false;
      this._timerHideOptions = options;
      if (this._countdownSession) this._countdownSession.appHide(options);
      if (!isExplicitTimerExit(options)) return;
      if (!this._countdownSession) {
        const saved = this.read('timerState');
        if (saved && saved.isCountdown === true && saved.interrupted === true
          && (saved.isRunning || saved.isPaused)) this.getCountdownSession().restore();
      }
      this.finishDetachedCountup(options);
    },

    getCountdownSession() {
      if (!this._countdownSession) {
        const { createCountdownSessionController } = require('./countdownSession');
        this._countdownSession = createCountdownSessionController({ api, recordCheckin: saveRecord });
        if (this._timerAudioInterrupted) this._countdownSession.audioInterruptionBegin();
        if (!this._timerForeground) this._countdownSession.appHide(this._timerHideOptions || {});
      }
      return this._countdownSession;
    },

    read(key) {
      try { return api.getStorageSync(key); }
      catch (_) { return undefined; }
    },

    write(key, value) {
      try { api.setStorageSync(key, value); return true; }
      catch (_) { return false; }
    },

    handOffCountup(state) {
      if (!state || state.isCountdown !== false || !state.sessionId) return;
      this._detachedCountupState = { ...state, interrupted: true };
      if (!this._timerForeground && isExplicitTimerExit(this._timerHideOptions)) this.finishDetachedCountup(this._timerHideOptions);
    },

    getDetachedCountupState() {
      return this._detachedCountupState ? { ...this._detachedCountupState } : null;
    },

    claimCountup(sessionId) {
      if (this._detachedCountupState && this._detachedCountupState.sessionId === sessionId) this._detachedCountupState = null;
    },

    getDetachedCountupExit(sessionId) {
      const exit = this._detachedCountupExit;
      if (!exit || sessionId && exit.sessionId !== sessionId) return null;
      return { ...exit, notice: this.read('timerCompletionNotice') || '',
        state: { ...exit.state, pendingCompletion: exit.saved ? null : exit.completion },
        completion: !exit.saved && exit.completion ? { ...exit.completion } : null };
    },

    markCompletionSaved(sessionId) {
      let exit = this._detachedCountupExit;
      if (!exit || exit.sessionId !== sessionId) {
        const state = this.read('timerState');
        if (!state || state.isCountdown !== false || state.sessionId !== sessionId) return;
        const pending = this.read('timerPendingCompletion');
        const completion = state.pendingCompletion || pending && pending.sessionId === sessionId && pending;
        if (!completion || completion.sessionId !== sessionId) return;
        // Cold recovery can restore the embedded draft without a live handoff.
        // Acknowledge that terminal copy as well as the separate pending key.
        exit = this._detachedCountupExit = { sessionId, state: { ...state,
          status: 'exited', isRunning: false, isPaused: false, interrupted: false },
          completion: { ...completion }, saved: false, notice: '' };
      }
      exit.saved = true;
      exit.state.pendingCompletion = null;
      if (exit.completion) exit.notice = `正计时已结束，${exit.completion.duration}分钟已存本机`;
      this.persistDetachedCountupExit();
    },

    persistDetachedCountupExit() {
      const exit = this._detachedCountupExit;
      if (!exit) return;
      // A failed terminal write must be retried when storage recovers, before a
      // later process mistakes the interrupted checkpoint for an active sit.
      // Never overwrite a newer sitting created after this one was completed.
      // An unreadable key is not an empty key: wait instead of replacing an
      // unknown (possibly newer) session with this older completion.
      try {
        const state = api.getStorageSync('timerState');
        if (!state || state.sessionId === exit.sessionId) {
          this.write('timerState', { ...exit.state, pendingCompletion: exit.saved ? null : exit.completion });
        }
      } catch (_) { /* Retry after storage can be read again. */ }
      try {
        const pending = api.getStorageSync('timerPendingCompletion');
        if (!pending || pending.sessionId === exit.sessionId) {
          this.write('timerPendingCompletion', exit.saved ? null : exit.completion);
        }
      } catch (_) { /* Keep an unknown newer draft intact. */ }
    },

    finishDetachedCountup(options) {
      if (!isExplicitTimerExit(options) || this._timerPage && !this._timerPage.isUnloaded) return;
      const state = this._detachedCountupState || this.read('timerState');
      if (!state || state.isCountdown !== false || state.interrupted !== true
        || !(state.isRunning || state.isPaused) || typeof state.sessionId !== 'string'
        || !Number.isFinite(state.startTimestamp) || state.startTimestamp <= 0
        || !Number.isFinite(state.totalPausedTime) || state.totalPausedTime < 0
        || state.isPaused && !Number.isFinite(state.pauseTimestamp)) return;
      if (this._detachedCountupExit && this._detachedCountupExit.sessionId === state.sessionId) return;
      const storedPending = this.read('timerPendingCompletion');
      if (storedPending && storedPending.sessionId !== state.sessionId) return;
      const at = Date.now();
      const end = state.isPaused ? state.pauseTimestamp : at;
      const seconds = Math.min(86400, Math.max(0, Number(state.elapsedTime) || 0,
        Math.floor((end - state.startTimestamp - state.totalPausedTime) / 1000)));
      const duration = Math.floor(seconds / 60);
      const endedAt = seconds >= 86400 ? Math.min(at, state.startTimestamp + state.totalPausedTime + 86400000) : at;
      const completion = duration >= 1 ? { sessionId: state.sessionId, duration, endedAt, text: '' } : null;
      const terminal = { ...state, status: 'exited', terminalReason: 'app_hide', interrupted: false,
        isRunning: false, isPaused: false, pauseTimestamp: 0, elapsedTime: seconds,
        saveTime: endedAt, pendingCompletion: completion };
      const exit = this._detachedCountupExit = { sessionId: state.sessionId,
        state: terminal, completion, saved: !completion, notice: '' };
      this._detachedCountupState = null;
      this.write('timerState', { ...terminal });
      if (completion) this.write('timerPendingCompletion', { ...completion });
      if (completion) {
        try {
          const result = saveRecord(duration, [], [], endedAt, state.sessionId);
          if (result && result.success) this.markCompletionSaved(state.sessionId);
        } catch (_) { /* Keep the completion draft for the historical retry UI. */ }
      }
      exit.notice = !completion ? '正计时已结束，不足1分钟未记录'
        : exit.saved ? `正计时已结束，${duration}分钟已存本机` : '正计时已结束，请确认保存记录';
      this.write('timerCompletionNotice', exit.notice);
    },

    getCompletionNotice() {
      const notice = this.read('timerCompletionNotice');
      return typeof notice === 'string' && /^(倒计时|正计时)已结束/.test(notice)
        ? { key: 'timerCompletionNotice', notice } : null;
    },

    dispose() {
      if (this._countdownSession) this._countdownSession.dispose();
      if (this._audioBegin && typeof api.offAudioInterruptionBegin === 'function') api.offAudioInterruptionBegin(this._audioBegin);
      if (this._audioEnd && typeof api.offAudioInterruptionEnd === 'function') api.offAudioInterruptionEnd(this._audioEnd);
    }
  };
  for (const method of ['applySyncAlertDot', 'refreshTabBars', 'setAudioOptions']) {
    runtime[method] = (...args) => typeof host[method] === 'function' ? host[method](...args) : undefined;
  }
  return runtime;
}

module.exports = { createRuntime };
