const { createCuePlayer } = require('./cuePlayer');
const { getReminderSettings } = require('./timerReminderSettings');
const { getEndReminder, clearEndReminder } = require('./timerEndReminder');

// An exit cue belongs to the app so returning home cannot destroy its player.
// The durable reminder remains independent of both the page and record saving.
function createTimerExitAudio({
  api, canPlay = () => true, diagnose = () => {},
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout
}) {
  let current = null;

  function report(type, details = {}) {
    try { diagnose(type, details); } catch (_) { /* Audio diagnostics are optional. */ }
  }

  function available() {
    try { return !!canPlay(); } catch (_) { return false; }
  }

  function matches(claim) {
    const pending = getEndReminder(api);
    return !!claim && pending && pending.sessionId === claim.sessionId;
  }

  function release(claim) {
    const cue = claim && claim.cue;
    if (!cue) return;
    claim.position = Math.max(claim.position, cue.position);
    claim.cue = null;
    cue.destroy();
  }

  function stop() {
    const claim = current;
    current = null;
    release(claim);
  }

  function completed(claim) {
    if (current !== claim) return;
    current = null;
    clearEndReminder(api, claim.sessionId);
    release(claim);
  }

  function failed(claim) {
    if (current !== claim) return;
    claim.status = 'failed';
    release(claim);
    report('exit_end_cue_failed', { sessionId: claim.sessionId });
    // Keep the bell pending for the next explicit resume, with one fallback per
    // bounded playback attempt rather than a timer-driven retry loop.
    if (!available()) return;
    try { api.vibrateLong({}); } catch (_) { /* The durable reminder can retry later. */ }
    try {
      api.showToast({ title: '静坐已结束，铃声播放失败，已尝试震动提醒', icon: 'none', duration: 3500 });
    } catch (_) { /* Toast failure cannot discard the reminder. */ }
  }

  function begin(claim) {
    if (current !== claim || !matches(claim)) { stop(); return false; }
    if (!available()) { claim.status = 'deferred'; return true; }
    claim.status = 'playing';
    if (getReminderSettings(api).end === 'vibrate') {
      try {
        api.vibrateLong({
          success: () => completed(claim),
          fail: () => failed(claim)
        });
      } catch (_) { failed(claim); }
      return true;
    }
    const cue = createCuePlayer({
      api,
      canPlay: () => current === claim && matches(claim) && available(),
      diagnose: report,
      setTimeout: schedule,
      clearTimeout: cancel,
      onPlayerChange(player) {
        // cuePlayer preserves trusted progress before releasing a failed native
        // context. Capture it while its request is still available.
        if (!player && claim.cue) claim.position = Math.max(claim.position, claim.cue.position);
      },
      onEnded: ({ failed: didFail }) => didFail ? failed(claim) : completed(claim)
    });
    claim.cue = cue;
    cue.play('/audio/收坐.mp3', { position: claim.position });
    return true;
  }

  function resume() {
    const claim = current;
    if (!claim) return false;
    if (!matches(claim)) { stop(); return false; }
    if (!available()) return true;
    if (claim.status === 'playing') return true;
    if (claim.status === 'paused' && claim.cue) {
      claim.status = 'playing';
      claim.cue.resume();
      return true;
    }
    return begin(claim);
  }

  function play({ sessionId, position = 0 } = {}) {
    const pending = getEndReminder(api);
    if (current && (!pending || pending.sessionId !== current.sessionId)) stop();
    if (!pending || (sessionId && sessionId !== pending.sessionId)) return false;
    if (current && current.sessionId === pending.sessionId) {
      // AppHide may claim the marker before PageHide can hand over the page's
      // trusted bell position. Absorb that late handoff until playback starts.
      // A live/paused cue keeps its own confirmed progress.
      if (!current.cue && (current.status === 'deferred' || current.status === 'failed')
        && Number.isFinite(position)) current.position = Math.max(current.position, position);
      return resume();
    }
    stop();
    current = {
      sessionId: pending.sessionId,
      position: Number.isFinite(position) ? Math.max(0, position) : 0,
      status: 'deferred', cue: null
    };
    return begin(current);
  }

  return {
    play, resume, stop,
    pause() {
      const claim = current;
      if (!claim) return;
      if (!matches(claim)) { stop(); return; }
      if (claim.cue) {
        claim.cue.pause();
        claim.position = Math.max(claim.position, claim.cue.position);
        claim.status = 'paused';
      }
    },
    owns(sessionId) {
      return !!current && current.sessionId === sessionId && !!matches(current);
    }
  };
}

module.exports = { createTimerExitAudio };
