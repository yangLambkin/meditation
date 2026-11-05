const { isExplicitTimerExit } = require('./timerInterruption');
const { queueEndReminder } = require('./timerEndReminder');

const SCHEMA_VERSION = 2;
const MAX_SECONDS = 24 * 60 * 60;
const MAX_DIAGNOSTICS = 200;
const ACTIVE = new Set(['running', 'paused']);
const TERMINAL = new Set(['completed', 'exited', 'cancelled']);

function validCompletion(value) {
  return value && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && value.sessionId.length <= 256 && Number.isInteger(value.duration)
    && value.duration >= 1 && value.duration <= 1440
    && Number.isFinite(value.endedAt) && value.endedAt > 0;
}

function validState(value) {
  if (!value || value.isCountdown !== true) return false;
  if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) return false;
  if (!Number.isInteger(value.totalTime) || value.totalTime < 1 || value.totalTime > MAX_SECONDS) return false;
  if (!Number.isFinite(value.startTimestamp) || value.startTimestamp <= 0
    || !Number.isFinite(value.saveTime) || value.saveTime < value.startTimestamp) return false;
  if (!Number.isFinite(value.elapsedTime) || value.elapsedTime < 0 || value.elapsedTime > value.totalTime) return false;
  if (value.totalPausedTime !== undefined
    && (!Number.isFinite(value.totalPausedTime) || value.totalPausedTime < 0)) return false;
  if (typeof value.isRunning !== 'boolean' || typeof value.isPaused !== 'boolean') return false;
  if (value.isRunning === true && value.isPaused === true) return false;
  if (value.isPaused && (!Number.isFinite(value.pauseTimestamp) || value.pauseTimestamp < value.startTimestamp
    || value.pauseTimestamp > value.saveTime)) return false;
  const effectiveEnd = value.isPaused ? value.pauseTimestamp : value.saveTime;
  if (value.elapsedTime > Math.max(0, Math.floor((effectiveEnd - value.startTimestamp - (value.totalPausedTime || 0)) / 1000))) return false;
  if (value.schemaVersion === SCHEMA_VERSION) {
    if (typeof value.runtimeId !== 'string' || !value.runtimeId) return false;
    if (!ACTIVE.has(value.status) && !TERMINAL.has(value.status)) return false;
    if ((value.status === 'running') !== (value.isRunning === true)
      || (value.status === 'paused') !== (value.isPaused === true)) return false;
  }
  return true;
}

/** Owns a countdown independently of any Page instance. No UI API is called here. */
function createCountdownSessionController({
  api, recordCheckin, now = () => Date.now(),
  setInterval: scheduleInterval = setInterval,
  clearInterval: cancelInterval = clearInterval
}) {
  const runtimeId = `countdown_${now()}_${Math.random().toString(36).slice(2)}`;
  const listeners = new Set();
  const recentFaults = new Map();
  let foreground = true;
  let foregroundEpoch = 1;
  let revision = 0;
  let state = null;
  let pendingCompletion = null;
  let completionNotice = '';
  let restored = false;
  let disposed = false;
  let recoveryEnabled = read('timerRecoveryEnabled') !== false;
  let recoveryAttempts = 0;
  let recoveryExhausted = false;
  let ticker = null;
  let watchdog = null;
  let lastTickAt = 0;
  let lastCheckpointAt = 0;
  function read(key) {
    try { return api.getStorageSync(key); }
    catch (_) { return undefined; }
  }

  function diagnose(type, details = {}) {
    if (String(type).endsWith('_error')) {
      const signature = `${type}|${state && state.sessionId || ''}|${details.event || ''}|${details.message || ''}`;
      const previous = recentFaults.get(signature);
      if (previous !== undefined && now() - previous >= 0 && now() - previous < 30000) return;
      recentFaults.set(signature, now());
      if (recentFaults.size > MAX_DIAGNOSTICS) recentFaults.delete(recentFaults.keys().next().value);
    }
    const technical = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (typeof value === 'string') technical[key] = value.slice(0, 500);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) technical[key] = value;
    }
    const existing = read('timerDiagnostics');
    const entries = Array.isArray(existing) ? existing.slice(-(MAX_DIAGNOSTICS - 1)) : [];
    entries.push({ type, at: now(), runtimeId, foregroundEpoch, revision,
      sessionId: state && state.sessionId || null, status: state && state.status || 'idle', ...technical });
    try { api.setStorageSync('timerDiagnostics', entries); } catch (_) { /* Storage failure must not stop timing. */ }
  }

  function write(key, value) {
    try { api.setStorageSync(key, value); return true; }
    catch (error) {
      diagnose('storage_error', { key, message: error && error.message || String(error) });
      return false;
    }
  }

  function active() { return !!(state && ACTIVE.has(state.status)); }
  function running() { return !!(state && state.status === 'running'); }

  function elapsed(at = now()) {
    if (!state) return 0;
    if (!running()) return state.elapsedTime;
    return Math.min(state.totalTime, Math.max(state.elapsedTime,
      Math.floor((at - state.startTimestamp - state.totalPausedTime) / 1000), 0));
  }

  function getSnapshot() {
    const seconds = elapsed();
    return {
      isCountdown: true, isRunning: running(), isPaused: !!(state && state.status === 'paused'),
      sessionId: state && state.sessionId || null, totalTime: state && state.totalTime || 0,
      startTimestamp: state && state.startTimestamp || 0,
      pauseTimestamp: state && state.pauseTimestamp || 0,
      totalPausedTime: state && state.totalPausedTime || 0,
      elapsedTime: seconds, remainingTime: Math.max(0, (state && state.totalTime || 0) - seconds),
      status: state && state.status || 'idle', terminalReason: state && state.terminalReason || null,
      runtimeId, foregroundEpoch, revision, foreground, recoveryEnabled,
      interrupted: !foreground && active(),
      pendingCompletion: pendingCompletion ? { ...pendingCompletion } : null, completionNotice
    };
  }

  function persist() {
    if (!state) return;
    const current = read('timerState');
    if (!active() && current && current.isCountdown === false) return;
    const snapshot = getSnapshot();
    write('timerState', { ...snapshot, schemaVersion: SCHEMA_VERSION, saveTime: now() });
    lastCheckpointAt = now();
  }

  function notifyOne(listener, event) {
    try { listener(getSnapshot(), { ...event,
      ...(event.completion ? { completion: { ...event.completion } } : {}) }); }
    catch (error) { diagnose('listener_error', { event: event.type, message: error && error.message || String(error) }); }
  }

  function emit(event) {
    const emittedRevision = revision;
    for (const listener of [...listeners]) {
      if (emittedRevision !== revision) break;
      notifyOne(listener, event);
    }
  }

  function clearTimer(handle) {
    try { cancelInterval(handle); }
    catch (error) { diagnose('timer_cleanup_error', { message: error && error.message || String(error) }); }
  }

  function clearTimers() {
    if (ticker !== null) clearTimer(ticker);
    if (watchdog !== null) clearTimer(watchdog);
    ticker = null;
    watchdog = null;
  }

  function invokeSafely(callback, source) {
    try { callback(); }
    catch (error) { diagnose('controller_error', { source, message: error && error.message || String(error) }); }
  }

  function installTicker() {
    if (ticker !== null) clearTimer(ticker);
    const token = revision;
    const epoch = foregroundEpoch;
    try {
      ticker = scheduleInterval(() => {
        if (token !== revision || epoch !== foregroundEpoch || !foreground || disposed || !running()) return;
        invokeSafely(() => {
          advance('tick');
          recoveryAttempts = 0;
          recoveryExhausted = false;
        }, 'tick');
      }, 1000);
    } catch (error) {
      ticker = null;
      diagnose('ticker_install_error', { message: error && error.message || String(error) });
    }
  }

  function ensureTimers() {
    if (disposed || !foreground || !running()) return;
    if (ticker === null) installTicker();
    if (recoveryEnabled && watchdog === null) {
      const token = revision;
      const epoch = foregroundEpoch;
      try {
        watchdog = scheduleInterval(() => {
          if (token !== revision || epoch !== foregroundEpoch || !foreground || disposed || !running()) return;
          invokeSafely(() => {
            if (now() - lastTickAt < 5000) return;
            if (recoveryAttempts >= 3) {
              if (!recoveryExhausted) {
                recoveryExhausted = true;
                diagnose('recovery_exhausted', { attempts: recoveryAttempts });
              }
              // Keep the logical deadline progressing on the existing watchdog without
              // continually retrying a broken native timer installation.
              advance('tick');
              return;
            }
            recoveryAttempts += 1;
            diagnose('ticker_recovered', { stalledForMs: now() - lastTickAt });
            installTicker();
            advance('recover');
          }, 'watchdog');
        }, 5000);
      } catch (error) { diagnose('watchdog_install_error', { message: error && error.message || String(error) }); }
    }
  }

  function notice(text) {
    completionNotice = text;
    write('timerCompletionNotice', text);
  }

  function terminate(reason, { seconds = elapsed(), endedAt = now(), cancelled = false, automatic = false } = {}) {
    if (!active()) return null;
    const targetEnd = state.startTimestamp + state.totalPausedTime + state.totalTime * 1000;
    const finalSeconds = Math.min(state.totalTime, Math.max(0, Math.floor(seconds)));
    if (finalSeconds >= state.totalTime) endedAt = Math.min(endedAt, targetEnd);
    const duration = Math.floor(finalSeconds / 60);
    const completion = !cancelled && duration >= 1
      ? { sessionId: state.sessionId, duration, endedAt, text: '' } : null;

    // Commit terminal intent before storage, callbacks, or cleanup can fail or re-enter.
    revision += 1;
    state.status = cancelled ? 'cancelled' : 'completed';
    state.terminalReason = reason;
    state.elapsedTime = finalSeconds;
    pendingCompletion = completion;
    if (!cancelled) {
      // Persist the cue independently of a page or completion draft. Even a
      // sub-minute sit must announce its end after navigation or reconstruction.
      try { queueEndReminder(api, state.sessionId); }
      catch (error) { diagnose('end_reminder_error', { message: error && error.message || String(error) }); }
    }
    persist(); // Includes a recovery copy of the draft before separate-key writes.
    if (completion) write('timerPendingCompletion', completion);
    clearTimers();
    diagnose(cancelled ? 'cancel' : 'finish', { reason, elapsedTime: finalSeconds, totalTime: state.totalTime });
    let autoSaved = false;
    if (automatic) {
      if (completion) {
        try {
          // Exit callbacks can be the last work before suspension. The local
          // record write is synchronous; upload continues through the normal queue.
          const result = recordCheckin(completion.duration, [], [], completion.endedAt, completion.sessionId);
          if (!result || !result.success) throw new Error('Local record save failed');
          markCompletionSaved(completion.sessionId);
          autoSaved = true;
        } catch (error) {
          diagnose('record_save_error', { message: error && error.message || String(error) });
        }
      }
      notice(!completion ? '倒计时已结束，不足1分钟未记录'
        : autoSaved ? `倒计时已结束，${duration}分钟已存本机` : '倒计时已结束，请确认保存记录');
      persist();
    }
    emit({ type: cancelled ? 'exit' : 'complete', reason, cancelled, completion, automatic, autoSaved });
    return completion ? { ...completion } : null;
  }

  function advance(eventType) {
    if (!foreground || !running() || disposed) return getSnapshot();
    const at = now();
    state.elapsedTime = elapsed(at);
    lastTickAt = at;
    if (state.elapsedTime >= state.totalTime) {
      terminate('timeout', { seconds: state.totalTime,
        endedAt: state.startTimestamp + state.totalPausedTime + state.totalTime * 1000 });
      return getSnapshot();
    }
    if (at - lastCheckpointAt >= 5000) persist();
    emit({ type: eventType });
    return getSnapshot();
  }

  function restore() {
    if (restored || disposed) return getSnapshot();
    restored = true;
    const saved = read('timerState');
    const pending = read('timerPendingCompletion');
    completionNotice = read('timerCompletionNotice') || '';
    if (validCompletion(pending)) {
      pendingCompletion = { ...pending };
      if (saved && saved.isCountdown === true) write('timerState', null);
      diagnose('restore_pending');
      return getSnapshot();
    }
    if (!saved || saved.isCountdown !== true) return getSnapshot();
    if (!validState(saved)) {
      diagnose('invalid_checkpoint');
      write('timerState', null);
      return getSnapshot();
    }
    state = { sessionId: saved.sessionId, totalTime: saved.totalTime,
      startTimestamp: saved.startTimestamp, pauseTimestamp: saved.pauseTimestamp || 0,
      totalPausedTime: saved.totalPausedTime || 0, elapsedTime: saved.elapsedTime,
      status: saved.status || (saved.isPaused ? 'paused' : saved.isRunning ? 'running' : 'cancelled'),
      terminalReason: saved.terminalReason || null };
    if (TERMINAL.has(state.status)) {
      if (validCompletion(saved.pendingCompletion) && saved.pendingCompletion.sessionId === state.sessionId) {
        pendingCompletion = { ...saved.pendingCompletion };
        write('timerPendingCompletion', pendingCompletion);
      }
      return getSnapshot();
    }
    diagnose('cold_start_checkpoint', { elapsedTime: saved.elapsedTime, savedRuntimeId: saved.runtimeId || 'legacy' });
    if (saved.elapsedTime >= saved.totalTime) {
      terminate('deadline', { seconds: saved.totalTime, endedAt: saved.saveTime });
      return getSnapshot();
    }
    // A killed runtime cannot prove how much time passed outside it. Preserve
    // confirmed progress and require an explicit resume instead of ending early
    // or counting offline time toward the configured duration.
    state.status = 'paused';
    state.pauseTimestamp = saved.isPaused ? saved.pauseTimestamp : saved.saveTime;
    state.pauseTimestamp = Math.min(state.pauseTimestamp, now());
    state.startTimestamp = state.pauseTimestamp - state.totalPausedTime - state.elapsedTime * 1000;
    state.terminalReason = null;
    persist();
    notice('上次计时中断，已保留剩余时间，点击继续');
    return getSnapshot();
  }

  function attach(listener) {
    if (typeof listener !== 'function') throw new TypeError('Countdown listener must be a function');
    restore();
    if (disposed) return () => {};
    listeners.add(listener);
    notifyOne(listener, { type: 'restore', reason: 'attach', completion: pendingCompletion });
    return () => listeners.delete(listener);
  }

  function start({ sessionId, totalTime, startTimestamp = now() } = {}) {
    restore();
    const externalPending = read('timerPendingCompletion');
    if (validCompletion(externalPending)) pendingCompletion = { ...externalPending };
    if (disposed || !foreground || active() || pendingCompletion) return false;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256
      || !Number.isInteger(totalTime) || totalTime < 1 || totalTime > MAX_SECONDS
      || !Number.isFinite(startTimestamp) || startTimestamp <= 0) return false;
    if (state && state.sessionId === sessionId && TERMINAL.has(state.status)) return false;
    revision += 1;
    state = { sessionId, totalTime, startTimestamp, pauseTimestamp: 0, totalPausedTime: 0,
      elapsedTime: 0, status: 'running', terminalReason: null };
    completionNotice = '';
    write('timerCompletionNotice', '');
    lastTickAt = now();
    recoveryAttempts = 0;
    recoveryExhausted = false;
    persist();
    ensureTimers();
    diagnose('start', { totalTime });
    emit({ type: 'restore', reason: 'start' });
    return true;
  }

  function pause() {
    if (!running() || !foreground || disposed) return getSnapshot();
    state.elapsedTime = elapsed();
    if (state.elapsedTime >= state.totalTime) {
      terminate('timeout', { seconds: state.totalTime });
      return getSnapshot();
    }
    revision += 1;
    state.status = 'paused';
    state.pauseTimestamp = now();
    clearTimers();
    persist();
    diagnose('pause');
    emit({ type: 'restore', reason: 'pause' });
    return getSnapshot();
  }

  function resume() {
    if (!state || state.status !== 'paused' || !foreground || disposed) return getSnapshot();
    revision += 1;
    const resumedAt = now();
    if (resumedAt < state.pauseTimestamp) {
      state.startTimestamp = resumedAt - state.totalPausedTime - state.elapsedTime * 1000;
    } else {
      state.totalPausedTime += resumedAt - state.pauseTimestamp;
    }
    state.pauseTimestamp = 0;
    state.status = 'running';
    lastTickAt = now();
    persist();
    ensureTimers();
    diagnose('resume');
    emit({ type: 'restore', reason: 'resume' });
    return getSnapshot();
  }

  function appShow() {
    if (disposed) return getSnapshot();
    if (!foreground) {
      foreground = true;
      foregroundEpoch += 1;
      diagnose('app_show');
      // The native ticker may have been suspended throughout a call. Reconcile
      // the original deadline before installing a fresh foreground ticker.
      advance('restore');
      ensureTimers();
    }
    return getSnapshot();
  }

  function appHide(options = {}) {
    if (disposed) return null;
    const wasForeground = foreground;
    if (foreground) {
      foreground = false;
      diagnose('app_hide', { reason: options && options.reason,
        explicitExit: isExplicitTimerExit(options) });
    }
    // A later explicit exit still ends a sit after a call or native screen has
    // already backgrounded the app. Only repeated interruption callbacks are inert.
    if (isExplicitTimerExit(options)) return terminate('app_hide', { automatic: true });
    if (!wasForeground) return null;
    // System interruptions retain the recovery boundary because background
    // timers and later lifecycle callbacks may not run.
    if (active()) {
      state.elapsedTime = elapsed();
      persist();
    }
    clearTimers();
    return null;
  }

  function markCompletionSaved(sessionId) {
    if (!pendingCompletion || pendingCompletion.sessionId !== sessionId) return false;
    pendingCompletion = null;
    const stored = read('timerPendingCompletion');
    if (stored && stored.sessionId === sessionId) write('timerPendingCompletion', null);
    if (state && state.sessionId === sessionId) persist();
    return true;
  }

  function updateCompletionText(sessionId, text) {
    if (!pendingCompletion || pendingCompletion.sessionId !== sessionId) return false;
    pendingCompletion = { ...pendingCompletion, text: String(text || '').slice(0, 2000) };
    write('timerPendingCompletion', pendingCompletion);
    if (state && state.sessionId === sessionId) persist();
    return true;
  }

  function finish(reason = 'unknown') {
    if (disposed || !active()) return null;
    if (reason === 'page_unload' || reason === 'app_hide') return terminate(reason, { automatic: true });
    if (reason === 'manual') return terminate(reason);
    if ((reason === 'deadline' || reason === 'timeout') && elapsed() >= state.totalTime) {
      return terminate(reason, { seconds: state.totalTime,
        endedAt: state.startTimestamp + state.totalPausedTime + state.totalTime * 1000 });
    }
    diagnose('premature_finish_rejected', { reason: String(reason), elapsedTime: elapsed(), totalTime: state.totalTime });
    ensureTimers();
    return null;
  }

  const environment = {};
  for (const method of ['getDeviceInfo', 'getAppBaseInfo', 'getAccountInfoSync']) {
    if (typeof api[method] !== 'function') continue;
    try {
      const info = api[method]() || {};
      if (method === 'getDeviceInfo') {
        Object.assign(environment, { brand: info.brand, model: info.model, system: info.system, platform: info.platform });
      } else if (method === 'getAppBaseInfo') {
        Object.assign(environment, { wechatVersion: info.version, SDKVersion: info.SDKVersion });
      } else {
        const miniProgram = info.miniProgram || {};
        Object.assign(environment, { appId: miniProgram.appId, appVersion: miniProgram.version, envVersion: miniProgram.envVersion });
      }
    } catch (_) { /* Older runtimes may omit these optional diagnostics. */ }
  }
  diagnose('controller_init', environment);

  return {
    attach, getSnapshot, restore, start, pause, resume, appShow, appHide, diagnose, markCompletionSaved, updateCompletionText, finish,
    cancel(reason = 'cancel') { terminate(reason, { cancelled: true }); return getSnapshot(); },
    tick: () => advance('tick'),
    setRecoveryEnabled(enabled) {
      recoveryEnabled = !!enabled;
      write('timerRecoveryEnabled', recoveryEnabled);
      if (!recoveryEnabled && watchdog !== null) { clearTimer(watchdog); watchdog = null; }
      if (recoveryEnabled) { recoveryAttempts = 0; recoveryExhausted = false; ensureTimers(); }
      diagnose('recovery_setting', { enabled: recoveryEnabled });
      return getSnapshot();
    },
    dispose() { disposed = true; revision += 1; clearTimers(); listeners.clear(); }
  };
}

module.exports = { createCountdownSessionController };
