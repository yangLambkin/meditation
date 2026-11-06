const DURATION_MS = 3000;
const PULSE_MS = 400;
const CALLBACK_TIMEOUT_MS = 2500;

// WeChat only exposes a fixed 400 ms long vibration. Overlap the final pulse
// when necessary so the whole reminder lasts three seconds without a gap.
function createVibrationCue({
  api, canPlay = () => true, onEnded = () => {}, now = Date.now,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout
}) {
  let state = 'idle';
  let remaining = 0;
  let startedAt = 0;
  let timer = null;
  let generation = 0;
  const pending = new Set();

  function available() {
    try { return !!canPlay(); } catch (_) { return false; }
  }

  function remainingMs() {
    return state === 'playing'
      ? Math.max(0, remaining - Math.max(0, now() - startedAt)) : remaining;
  }

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function clearPending() {
    for (const pulse of pending) cancel(pulse.timer);
    pending.clear();
  }

  function stop() {
    clearTimer();
    clearPending();
    state = 'idle';
    remaining = 0;
    generation += 1;
  }

  function finish(result) {
    stop();
    onEnded(result);
  }

  function pause() {
    if (state !== 'playing') return;
    remaining = remainingMs();
    // 末次请求尚未确认时不能用零剩余时间恢复成成功；重新交付该短脉冲。
    if (remaining <= 0 && pending.size) remaining = PULSE_MS;
    state = 'paused';
    clearTimer();
    clearPending();
    generation += 1;
  }

  function finishIfConfirmed() {
    if (remainingMs() <= 0 && pending.size === 0) {
      finish({ failed: false });
      return true;
    }
    return false;
  }

  function pulse() {
    if (state !== 'playing') return;
    if (!available()) { pause(); return; }
    if (remainingMs() <= 0) { finishIfConfirmed(); return; }
    const pulseGeneration = generation;
    const current = { timer: null };
    pending.add(current);
    const active = () => state === 'playing' && generation === pulseGeneration;
    const settle = (failed, error) => {
      if (!active() || !pending.has(current)) return;
      pending.delete(current);
      cancel(current.timer);
      if (failed) finish({ failed: true, error });
      else finishIfConfirmed();
    };
    current.timer = schedule(() => settle(true, { errMsg: 'vibrateLong:timeout' }), CALLBACK_TIMEOUT_MS);
    try {
      api.vibrateLong({ success: () => settle(false), fail: error => settle(true, error) });
    } catch (error) { settle(true, error); }
    if (!active()) return;
    const left = remainingMs();
    if (left <= 0) { finishIfConfirmed(); return; }
    const isFinalPulse = left <= PULSE_MS;
    const delay = isFinalPulse ? left : Math.min(PULSE_MS, left - PULSE_MS);
    timer = schedule(() => {
      if (state !== 'playing' || generation !== pulseGeneration) return;
      timer = null;
      if (!available()) { pause(); return; }
      if (isFinalPulse || remainingMs() <= 0) finishIfConfirmed();
      else pulse();
    }, delay);
  }

  function resume() {
    if (state !== 'paused' || !available()) return;
    state = 'playing';
    startedAt = now();
    pulse();
  }

  return {
    play({ remainingMs: duration = DURATION_MS } = {}) {
      stop();
      remaining = Number.isFinite(duration) ? Math.max(0, duration) : DURATION_MS;
      state = 'paused';
      resume();
    },
    pause, resume, stop,
    get remainingMs() { return remainingMs(); }
  };
}

module.exports = { createVibrationCue };
