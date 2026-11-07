const START_TIMEOUT_MS = 2500;
const LOAD_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 150;
const READY_REPLAY_DELAY_MS = 150;

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
  let readyReplayTimer = null;
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
    if (readyReplayTimer !== null) cancel(readyReplayTimer);
    watchdog = retryTimer = readyReplayTimer = null;
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
    const replaySuppressed = failed && current.started && !current.replayAfterStart;
    report('cue_completed', { src: current.src, failed, position: current.position,
      duration: current.duration, retries: current.retries, replaySuppressed });
    generation += 1;
    clearTimers();
    unbind();
    request = null;
    capturePosition = null;
    if (failed) discard();
    onEnded({ src: current.src, failed, ...(replaySuppressed ? { replaySuppressed: true } : {}) });
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
      report(reason, { code: error && error.errCode, src: current.src, retry: current.retries,
        position: current.position, duration: current.duration });
      generation += 1;
      clearTimers();
      discard();
      // 起坐已收到 Play 后，进度停报或原生异常都不能让钟击自动从头再响。
      // 保留失败结果，不把 Play 当成实际出声的证明。
      if (current.started && !current.replayAfterStart) { complete(current, true); return; }
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
      let playRequested = false;
      let readyReplayUsed = false;
      let progressed = false;
      let progressRevision = 0;
      let checkedProgressRevision = 0;
      let initialNativeTime = context.currentTime;
      const observeDuration = () => {
        if (!valid() || !configured) return;
        try {
          const seconds = context.duration;
          // 只读已配置为本请求音源的时长，缓存后不受 Ended 前归零影响。
          if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) {
            current.duration = Math.max(current.duration || 0, seconds);
          }
        } catch (_) { /* Keep the last known duration if native state is unavailable. */ }
      };
      observeProgress = () => {
        if (!valid()) return false;
        observeDuration();
        if (!announcedPlay) return false;
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
      const armWatchdog = () => {
        if (watchdog !== null) cancel(watchdog);
        watchdog = schedule(checkProgress, announcedPlay && !current.replayAfterStart
          ? current.playbackTimeoutMs
          : !ready && supportsReady ? LOAD_TIMEOUT_MS : START_TIMEOUT_MS);
      };
      const markReady = () => {
        if (!valid()) return;
        observeDuration();
        if (ready) return;
        ready = true;
        armWatchdog();
      };
      const events = {
        Play: () => {
          if (!valid() || announcedPlay) return;
          announcedPlay = true;
          if (readyReplayTimer !== null) cancel(readyReplayTimer);
          readyReplayTimer = null;
          current.started = true;
          // Play 也可能在解码/缓冲之前到达；支持 Canplay 时仍等就绪或真实进度。
          if (!supportsReady) markReady();
          // 部分手机有进度 API 却不持续回报；起坐等待自然结束或整段时长上限。
          // Canplay 若稍后到达可重新计预算，重复 Play/Canplay 不会无限延长。
          if (!current.replayAfterStart) armWatchdog();
        },
        Ended: () => {
          if (!valid()) return;
          // 冷启动/原生异常的 Ended 不能把从未启动的提醒确认成已播放。
          if (!announcedPlay) { fail('cue_ended_before_play'); return; }
          observeProgress();
          // 支持进度的客户端必须至少播放过一部分；位置保留跨暂停/重建的可信进度。
          if (supportsProgress && current.position <= 0) { fail('cue_ended_without_progress'); return; }
          // 少量正进度也可能来自异常提前结束；只有接近资源末尾才确认已播完。
          // 没有进度能力且从未观察到时间的旧客户端仍保留 Play/Ended 兼容。
          if (current.duration && (supportsProgress || current.position > 0)
            && current.position < current.duration - Math.min(1, current.duration * 0.1)) {
            fail('cue_ended_early'); return;
          }
          complete(current);
        },
        Error: error => fail('cue_error', error)
      };
      if (supportsReady) events.Canplay = () => {
        markReady();
        if (!valid() || !playRequested || announcedPlay || readyReplayUsed
          || current.started && !current.replayAfterStart) return;
        readyReplayUsed = true;
        // 部分冷解码器会丢弃就绪前的 play。给迟到的 Play 留出时间后，
        // 只补发一次，不重新设置 src/startTime，也不延长原有故障检测期限。
        readyReplayTimer = schedule(() => {
          readyReplayTimer = null;
          if (!valid() || announcedPlay) return;
          if (!allowed()) { pause(); return; }
          try {
            const seconds = context.currentTime;
            if (Number.isFinite(seconds) && seconds > current.position && seconds !== initialNativeTime) return;
            report('cue_ready_replay', { src: current.src, retry: current.retries });
            context.play();
          } catch (error) { fail('cue_play_error', error); }
        }, READY_REPLAY_DELAY_MS);
      };
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
        if (announcedPlay && !current.replayAfterStart) {
          fail('cue_completion_timeout');
          return;
        }
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
      armWatchdog();
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
      observeDuration();
      playRequested = true;
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

  function createRequest(src, { position = 0, replayAfterStart = true, playbackTimeoutMs = 15000 } = {}) {
    const startPosition = Math.max(0, Number(position) || 0);
    return { src, position: startPosition, duration: null, retries: 0, status: 'paused',
      replayAfterStart, playbackTimeoutMs, started: startPosition > 0 };
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
    prepare(src, options) {
      stop();
      if (configured) discard();
      takePreload(src);
      const current = createRequest(src, options);
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
    play(src, options) {
      stop();
      // 每段新提示音都有独立 native 身份，上一段迟到的事件不能命中新监听。
      // 只有同一提示音的暂停/继续才复用实例。
      if (configured) discard();
      takePreload(src);
      report('cue_requested', { src, preloaded: configured, ready });
      const current = createRequest(src, options);
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
