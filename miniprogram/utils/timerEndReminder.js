const STORAGE_KEY = 'timerPendingEndReminder';
const localReminders = new WeakMap();

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function localState(api) {
  let state = localReminders.get(api);
  if (!state) {
    state = { pending: null, dirty: false };
    localReminders.set(api, state);
  }
  return state;
}

function readPending(api, state) {
  if (!state.dirty) {
    try {
      const saved = api.getStorageSync(STORAGE_KEY);
      state.pending = saved && validSessionId(saved.sessionId) ? { sessionId: saved.sessionId } : null;
    } catch (_) { /* Keep the last readable in-memory intent. */ }
  }
  return state.pending;
}

// A pending reminder survives page/app teardown independently of record saving.
// Retry a failed write once per later read, including a failed acknowledgement.
// Mutations use readPending so each operation writes only its latest intent once.
function getEndReminder(api) {
  const state = localState(api);
  if (state.dirty) writeReminder(api, state, state.pending);
  else readPending(api, state);
  return state.pending ? { ...state.pending } : null;
}

function writeReminder(api, state, pending) {
  state.pending = pending;
  state.dirty = true;
  try {
    api.setStorageSync(STORAGE_KEY, pending);
    state.dirty = false;
  } catch (_) { /* Playback can still acknowledge or retry the in-memory intent. */ }
}

// Queue once per pending session. A newer session replaces an older pending cue.
function queueEndReminder(api, sessionId) {
  if (!validSessionId(sessionId)) return getEndReminder(api);
  const state = localState(api);
  const pending = readPending(api, state);
  if (!pending || pending.sessionId !== sessionId || state.dirty) {
    writeReminder(api, state, { sessionId });
  }
  return { sessionId };
}

// A stale audio callback must never clear another session's pending reminder.
function clearEndReminder(api, sessionId) {
  const state = localState(api);
  const pending = readPending(api, state);
  if (!pending || pending.sessionId !== sessionId) return false;
  writeReminder(api, state, null);
  return true;
}

function dismissEndReminder(api) {
  const state = localState(api);
  const pending = readPending(api, state);
  // Explicit dismissal also cancels an unreadable disk intent. Otherwise a
  // failed first read could revive an old bell after the user has left/finished.
  writeReminder(api, state, null);
  return pending ? { ...pending } : null;
}

module.exports = { queueEndReminder, getEndReminder, clearEndReminder, dismissEndReminder };
