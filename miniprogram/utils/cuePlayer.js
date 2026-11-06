const START_TIMEOUT_MS = 2500;
const LOAD_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 150;

// 提示音与静坐计时分开：播放器失效只重建音频，不改变会话或完成记录。
function createCuePlayer({
  api, canPlay = () => true, onEnded = () => {}, onPlayerChange = () => {}, diagnose = () => {},
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout
}) {
  let player = null;
  let request = null;
  let generation = 0;
  let bindings = null;
  let watchdog = null;
  let retryTimer = null;
  let capturePosition = null;
  let configured = false;
  let ready = false;
  let preloaded = null;

  function report(type, detail = {}) {
    try { diagnose(type, detail); } catch (_) { /* Diagnostics must not stop playback. */ }
  }

  function allowed() {
    try { return !!canPlay(); } catch (_) { return false; }
  }

  function changed() {
    try { onPlayerChange(player); } catch (_) { /* Notification cannot prevent native cleanup. */ }
  }

  function ensurePlayer() {
    if (!player) {
      player = api.createInnerAudioContext();
      changed();
    }
    return player;
  }

  function clearTimers() {
    if (watchdog !== null) cancel(watchdog);
    if (retryTimer !== null) cancel(retryTimer);
    watchdog = retryTimer = null;
  }

  function unbind() {
    if (!bindings) return;
    const previous = bindings;
    bindings = null;
    for (const [event, callback] of Object.entries(previous.events)) {
      const off = previous.player[`off${event}`];
      if (typeof off === 'function') {
        try { off.call(previous.player, callback); } catch (_) { /* Generation also guards queued callbacks. */ }
      }
    }
  }

  function dispose(context) {
    for (const method of ['stop', 'destroy']) {
      try { context[method](); }
      catch (error) { report('cue_cleanup_error', { method, message: String(error && error.message || error).slice(0, 160) }); }
    }
  }

  function unbindPreload(entry) {
    for (const [event, callback] of Object.entries(entry.events)) {
      try {
        if (typeof entry.player[`off${event}`] === 'function') entry.player[`off${event}`](callback);
      } catch (_) { /* The ownership check also guards late preload callbacks. */ }
    }
  }

  function clearPreload() {
    const entry = preloaded;
    preloaded = null;
    if (!entry) return;
    unbindPreload(entry);
    dispose(entry.player);
  }

  function configure(context) {
    context.autoplay = false;
    context.loop = false;
    context.obeyMuteSwitch = false;
    context.volume = 1;
  }

  // 收坐在开始静坐时加载；独立实例不打断起坐，也不会发出任何声音。
  function preload(src) {
    if (preloaded && preloaded.src === src) return;
    clearPreload();
    let entry;
    try {
      entry = { src, player: api.createInnerAudioContext(), ready: false, events: {} };
      preloaded = entry;
      configure(entry.player);
      entry.events.Error = error => {
        if (preloaded !== entry) return;
        report('cue_preload_error', { src, code: error && error.errCode });
        clearPreload();
      };
      if (typeof entry.player.onCanplay === 'function') {
        entry.events.Canplay = () => { if (preloaded === entry) entry.ready = true; };
      }
      for (const [event, callback] of Object.entries(entry.events)) entry.player[`on${event}`](callback);
      entry.player.startTime = 0;
      entry.player.src = src;
    } catch (error) {
      report('cue_preload_error', { src });
      clearPreload();
    }
  }

  function takePreload(src) {
    if (!preloaded || preloaded.src !== src) return;
    const entry = preloaded;
    preloaded = null;
    unbindPreload(entry);
    discard();
    player = entry.player;
    configured = true;
    ready = entry.ready;
    changed();
  }

  function discard() {
    const previous = player;
    player = null;
    configured = ready = false;
    capturePosition = null;
    if (previous) changed();
    unbind();
    if (!previous) return;
    dispose(previous);
  }

  function complete(current, failed = false) {
    if (request !== current) return;
    report('cue_completed', { src: current.src, failed, position: current.position, retries: current.retries });
    generation += 1;
    clearTimers();
    unbind();
    request = null;
    capturePosition = null;
    if (failed) discard();
    onEnded({ src: current.src, failed });
  }

  function attempt(current, resumeExisting = false) {
    if (request !== current) return;
    if (!allowed()) { current.status = 'paused'; return; }
    const token = ++generation;
    current.status = 'playing';
    let context = player;
    let observeProgress = () => false;
    capturePosition = null;
    const valid = () => request === current && generation === token && player === context;
    const fail = (reason, error) => {
      if (!valid()) return;
      observeProgress();
      report(reason, { code: error && error.errCode, src: current.src, retry: current.retries });
      generation += 1;
      clearTimers();
      discard();
      if (!allowed()) { current.status = 'paused'; return; }
      if (current.retries >= 1) { complete(current, true); return; }
      current.retries += 1;
      current.status = 'retrying';
      const retryToken = generation;
      retryTimer = schedule(() => {
        retryTimer = null;
        if (request === current && generation === retryToken) attempt(current);
      }, RETRY_DELAY_MS);
    };

    try {
      context = player;
      if (!context) {
        context = ensurePlayer();
        resumeExisting = false;
      }
      unbind();
      configure(context);
      const supportsProgress = typeof context.onTimeUpdate === 'function';
      const supportsReady = typeof context.onCanplay === 'function';
      let announcedPlay = false;
      let progressed = false;
      let progressRevision = 0;
      let checkedProgressRevision = 0;
      let initialNativeTime = context.currentTime;
      observeProgress = () => {
        if (!valid() || !announcedPlay) return false;
        let seconds;
        try { seconds = context.currentTime; }
        catch (_) { return false; }
        // stop/src 后 native 时间可能仍属于上一段；Play 本身也不证明已走时。
        // 只采纳本次成功配置、开始播放后观察到的时间变化，绝不读取旧 startTime。
        if (Number.isFinite(seconds) && seconds > current.position && seconds !== initialNativeTime) {
          if (!progressed) report('cue_progress', { src: current.src, retry: current.retries });
          progressed = true;
          current.position = seconds;
          progressRevision += 1;
          return true;
        }
        return false;
      };
      capturePosition = observeProgress;
      const markReady = () => {
        if (!valid() || ready) return;
        ready = true;
        if (watchdog !== null) cancel(watchdog);
        watchdog = schedule(checkProgress, START_TIMEOUT_MS);
      };
      const events = {
        Play: () => {
          if (!valid()) return;
          announcedPlay = true;
          // Play 也可能在解码/缓冲之前到达；支持 Canplay 时仍等就绪或真实进度。
          if (!supportsReady) markReady();
        },
        Ended: () => {
          if (!valid()) return;
          // 冷启动/原生异常的 Ended 不能把从未启动的提醒确认成已播放。
          if (!announcedPlay) { fail('cue_ended_before_play'); return; }
          observeProgress();
          // 支持进度的客户端必须至少播放过一部分；位置保留跨暂停/重建的可信进度。
          if (supportsProgress && current.position <= 0) { fail('cue_ended_without_progress'); return; }
          complete(current);
        },
        Error: error => fail('cue_error', error)
      };
      if (supportsReady) events.Canplay = markReady;
      // Some native decoders stop/pause without Error (e.g. after switching
      // from the opening cue or guidance). Our own stop/pause unbind first,
      // so a notification reaching this request is an unexpected interruption.
      for (const event of ['Stop', 'Pause']) {
        if (typeof context[`on${event}`] === 'function') {
          events[event] = () => fail(`cue_unexpected_${event.toLowerCase()}`);
        }
      }
      if (supportsProgress) {
        events.TimeUpdate = () => { if (observeProgress()) markReady(); };
      }
      const checkProgress = () => {
        watchdog = null;
        if (!valid()) return;
        if (!allowed()) { pause(); return; }
        observeProgress();
        if (progressRevision !== checkedProgressRevision) {
          checkedProgressRevision = progressRevision;
          watchdog = schedule(checkProgress, START_TIMEOUT_MS);
          return;
        }
        // 老客户端可能只报告 Play，currentTime 也不更新；不能据此判定卡住。
        // 一旦观察到可信时间推进，之后同样持续检查，直到自然结束或暂停。
        if (!supportsProgress && announcedPlay && !progressed) return;
        fail(!ready && supportsReady ? 'cue_load_timeout'
          : progressed ? 'cue_stall_timeout' : 'cue_start_timeout');
      };
      bindings = { player: context, events };
      for (const [event, callback] of Object.entries(events)) context[`on${event}`](callback);
      if (!valid()) return;
      watchdog = schedule(checkProgress, !ready && supportsReady ? LOAD_TIMEOUT_MS : START_TIMEOUT_MS);
      if (!resumeExisting) {
        context.startTime = current.position;
        // 预加载实例直接播放，不重新赋 src 触发第二次冷加载。
        if (!configured) {
          configured = true;
          context.src = current.src;
          if (!valid()) return;
        }
        initialNativeTime = context.currentTime;
      }
      context.play();
    } catch (error) {
      // 创建播放器也可能抛错，此时 context 和 player 均为空，仍使用同一恢复上限。
      fail('cue_play_error', error);
    }
  }

  function stop() {
    generation += 1;
    clearTimers();
    unbind();
    request = null;
    capturePosition = null;
    if (player && configured) {
      try { player.stop(); }
      catch (error) { report('cue_stop_error'); discard(); }
    }
  }

  function pause() {
    if (capturePosition) capturePosition();
    generation += 1;
    clearTimers();
    unbind();
    if (request) request.status = 'paused';
    capturePosition = null;
    if (player) {
      try { player.pause(); }
      catch (error) { report('cue_pause_error'); discard(); }
    }
  }

  return {
    get player() { return player; },
    get position() {
      // 交接页面时原生实例可能正在重建，只保留本请求已确认的播放位置。
      if (capturePosition) {
        try { capturePosition(); }
        catch (_) { /* Keep the last confirmed position if native state is unavailable. */ }
      }
      return request ? request.position : 0;
    },
    ensurePlayer,
    preload,
    prepare(src, { position: startPosition = 0 } = {}) {
      stop();
      if (configured) discard();
      takePreload(src);
      const current = { src, position: Math.max(0, Number(startPosition) || 0), retries: 0, status: 'paused' };
      request = current;
      try {
        const context = ensurePlayer();
        context.startTime = current.position;
        if (!configured) { configured = true; context.src = current.src; }
      } catch (error) {
        report('cue_prepare_error');
        discard();
      }
    },
    play(src, { position: startPosition = 0 } = {}) {
      stop();
      // 每段新提示音都有独立 native 身份，上一段迟到的事件不能命中新监听。
      // 只有同一提示音的暂停/继续才复用实例。
      if (configured) discard();
      takePreload(src);
      report('cue_requested', { src, preloaded: configured, ready });
      const current = { src, position: Math.max(0, Number(startPosition) || 0), retries: 0, status: 'paused' };
      request = current;
      attempt(current);
    },
    resume() {
      if (!request || request.status === 'playing' || request.status === 'retrying') return;
      const current = request;
      current.retries = 0;
      attempt(current, !!player);
    },
    pause,
    stop,
    destroy() { stop(); discard(); clearPreload(); }
  };
}

module.exports = { createCuePlayer };
