const START_TIMEOUT_MS = 2500;
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

  function discard() {
    const previous = player;
    player = null;
    capturePosition = null;
    if (previous) changed();
    unbind();
    if (!previous) return;
    for (const method of ['stop', 'destroy']) {
      try { previous[method](); }
      catch (error) { report('cue_cleanup_error', { method, message: String(error && error.message || error).slice(0, 160) }); }
    }
  }

  function complete(current, failed = false) {
    if (request !== current) return;
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
      context.loop = false;
      context.obeyMuteSwitch = false;
      context.volume = 1;
      if (!resumeExisting) {
        context.src = current.src;
        context.startTime = current.position;
      }
      const supportsProgress = typeof context.onTimeUpdate === 'function';
      let announcedPlay = false;
      let progressed = false;
      const startingPosition = current.position;
      const initialNativeTime = context.currentTime;
      observeProgress = () => {
        if (!valid() || !announcedPlay) return false;
        const seconds = context.currentTime;
        // stop/src 后 native 时间可能仍属于上一段；Play 本身也不证明已走时。
        // 只采纳本次成功配置、开始播放后观察到的时间变化，绝不读取旧 startTime。
        if (Number.isFinite(seconds) && seconds > startingPosition && seconds !== initialNativeTime) {
          progressed = true;
          current.position = Math.max(current.position, seconds);
        }
        return progressed;
      };
      capturePosition = observeProgress;
      const events = {
        Play: () => {
          if (!valid()) return;
          announcedPlay = true;
          // 老客户端只提供 Play；有进度事件时还需确认解码器确实开始走时。
          if (!supportsProgress && watchdog !== null) { cancel(watchdog); watchdog = null; }
        },
        Ended: () => { if (valid()) complete(current); },
        Error: error => fail('cue_error', error)
      };
      if (supportsProgress) {
        events.TimeUpdate = () => {
          if (!observeProgress()) return;
          if (watchdog !== null) { cancel(watchdog); watchdog = null; }
        };
      }
      bindings = { player: context, events };
      for (const [event, callback] of Object.entries(events)) context[`on${event}`](callback);
      if (!valid()) return;
      watchdog = schedule(() => {
        watchdog = null;
        if (!valid()) return;
        if (observeProgress()) return;
        fail('cue_start_timeout');
      }, START_TIMEOUT_MS);
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
    if (player) {
      try { player.stop(); }
      catch (error) { report('cue_stop_error'); discard(); }
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
    prepare(src, { position: startPosition = 0 } = {}) {
      stop();
      const current = { src, position: Math.max(0, Number(startPosition) || 0), retries: 0, status: 'paused' };
      request = current;
      try {
        const context = ensurePlayer();
        context.src = current.src;
        context.startTime = current.position;
      } catch (error) {
        report('cue_prepare_error');
        discard();
      }
    },
    play(src, { position: startPosition = 0 } = {}) {
      stop();
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
    pause() {
      if (capturePosition) capturePosition();
      generation += 1;
      clearTimers();
      unbind();
      if (request) {
        request.status = 'paused';
      }
      capturePosition = null;
      if (player) {
        try { player.pause(); }
        catch (error) { report('cue_pause_error'); discard(); }
      }
    },
    stop,
    destroy() { stop(); discard(); }
  };
}

module.exports = { createCuePlayer };
