const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { timerHarness, START_AUDIO, END_AUDIO, GUIDE_AUDIO } = require('./helpers/timerRuntimeHarness');

for (const countdown of [true, false]) {
  const mode = countdown ? 'countdown' : 'count-up';
  for (const interruption of ['appHide', 'audioOnly']) {
    test(`${mode} preserves identity and elapsed wall time through ${interruption}`, () => {
      const h = timerHarness();
      const page = h.mount({ countdown });
      page.startTimer();
      const id = page.sessionId;
      h.advance(20000);
      if (interruption === 'appHide') h.hide(); else h.audioBegin();
      h.advance(90000, { suspended: true });
      assert.equal(h.records.length, 0);
      if (interruption === 'appHide') h.show(); else h.audioEnd();
      assert.equal(page.sessionId, id);
      assert.equal(page.data.isRunning, true);
      assert.equal(page.data.elapsedTime, 110);
      assert.equal(page.pendingCompletion, null);
      page.resetTimer();
      assert.equal(h.records.length, 0);
    });
  }
  test(`${mode} remains manually paused across interruption and excludes pause time`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(20000); page.pauseTimer();
    h.audioBegin(); h.hide(); h.advance(90000, { suspended: true }); h.audioEnd(); h.show();
    assert.equal(page.data.isPaused, true);
    assert.equal(page.data.elapsedTime, 20);
    page.startTimer(); h.advance(10000);
    assert.equal(page.data.elapsedTime, 30);
    assert.equal(page.data.totalPausedTime, 90000);
  });
  test(`${mode} survives interrupted page disposal and process recreation with the same session`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown, guide: true });
    page.startTimer(); h.advance(10000); h.hide(); page.onUnload();
    h.advance(60000, { suspended: true });
    const cold = timerHarness({ stored: h.snapshot(), now: h.now });
    const restored = cold.mount();
    assert.equal(restored.data.isCountdown, countdown);
    assert.equal(restored.sessionId, page.sessionId);
    assert.equal(restored.data.isRunning, true);
    assert.equal(restored.data.elapsedTime, 70);
    assert.equal(cold.records.length, 0);
    assert.equal(restored.data.backgroundMusic, 'default');
  });
  test(`${mode} still settles an ordinary unmarked cold checkpoint at the last saved time`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(70000);
    const state = h.storage.get('timerState');
    const cold = timerHarness({ stored: h.snapshot(), now: h.now + 300000 });
    const restored = cold.mount();
    assert.equal(restored.data.isRunning, false);
    assert.equal(cold.records.length, 1);
    assert.equal(cold.records[0][0], 1);
    assert.equal(cold.records[0][3], state.saveTime);
    assert.equal(cold.records[0][4], page.sessionId);
  });
}

test('countdown crossing its deadline during a call emits one end bell and one saved record', async () => {
  const h = timerHarness();
  const page = h.mount();
  page.applyDuration(1); page.startTimer(); h.advance(10000);
  const startedAt = page.data.startTimestamp;
  h.audioBegin(); h.hide(); h.advance(90000, { suspended: true }); h.show();
  assert.equal(page.data.isRunning, false);
  assert.equal(h.played(END_AUDIO).length, 0, 'system still owns audio');
  h.audioEnd(); h.show(); h.audioEnd();
  assert.equal(h.played(END_AUDIO).length, 1);
  assert.equal(page.pendingCompletion.endedAt, startedAt + 60000);
  await page.confirmCompletion(); await page.confirmCompletion();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 1);
  assert.equal(h.records[0][4], page.sessionId);
});

test('detached count-up explicit close records once at the close boundary', () => {
  const h = timerHarness();
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(20000); h.hide(); page.onUnload();
  h.advance(110000, { suspended: true }); h.hide({ reason: 0 });
  const endedAt = h.now;
  h.advance(300000, { suspended: true }); h.hide({ reason: 0 }); h.show(); h.mount();
  assert.equal(h.records.length, 1);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.records[0][0], 2);
  assert.equal(h.records[0][3], endedAt);
  assert.equal(h.records[0][4], page.sessionId);
  assert.equal(h.page.data.isRunning, false);
});

test('detached count-up local save failure preserves a retryable draft with its original identity', async () => {
  let writable = false;
  const h = timerHarness({ save: () => ({ success: writable }) });
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(70000); h.hide(); page.onUnload();
  h.hide({ reason: 1 });
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, page.sessionId);
  assert.equal(h.records.length, 0);
  h.show(); const restored = h.mount();
  assert.equal(restored.data.showCompletionDialog, true);
  assert.equal(restored.data.isRunning, false);
  writable = true;
  await restored.confirmCompletion();
  h.hide({ reason: 0 });
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][4], page.sessionId);
  assert.equal(h.storage.get('timerPendingCompletion'), null);
});

test('interrupted count-up retains an in-memory handoff if checkpoint storage is temporarily unavailable', () => {
  let fail = false;
  const h = timerHarness({ failWrite: key => fail && key === 'timerState' });
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(10000); fail = true;
  h.hide(); page.onUnload(); h.advance(60000, { suspended: true });
  fail = false; h.show(); const restored = h.mount();
  assert.equal(restored.sessionId, page.sessionId);
  assert.equal(restored.data.elapsedTime, 70);
  assert.equal(restored.data.isRunning, true);
});

test('cold interrupted session can be explicitly closed from home without opening the timer page', () => {
  for (const countdown of [true, false]) {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(10000); h.hide(); page.onUnload();
    const cold = timerHarness({ stored: h.snapshot(), now: h.now + 120000 });
    cold.hide({ reason: 0 }); cold.hide({ reason: 0 });
    assert.equal(cold.records.length, 1);
    assert.equal(cold.records[0][0], 2);
    assert.equal(cold.records[0][4], page.sessionId);
  }
});

test('historical five-second delay and start bell before guide remain unchanged', () => {
  const h = timerHarness();
  const page = h.mount({ guide: true });
  page.startTimer(); h.advance(4999);
  assert.equal(h.calls.length, 0);
  h.advance(1);
  assert.equal(h.played(START_AUDIO).length, 1);
  assert.equal(h.played(GUIDE_AUDIO).length, 0);
  page.audioPlayer.emit('Ended');
  assert.equal(h.played(GUIDE_AUDIO).length, 1);
});

test('single page route loads the module directly and historical bell bytes are preserved', () => {
  const root = path.resolve(__dirname, '../miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/timer/timer'));
  assert.ok(!app.pages.some(page => page.includes('timerSettings')));
  assert.ok(!app.subPackages.some(pkg => pkg.root.includes('timer')));
  assert.match(fs.readFileSync(path.join(root, 'pages/timer/timer.js'), 'utf8'), /Page\(createTimerPage\(\)\)/);
  assert.ok(!fs.existsSync(path.join(root, 'modules/timer/implementations')));
  for (const [name, expected] of [
    ['起坐.mp3', '990157e813e1ac6601770a37e0a583fc524731386411a8787100c3fa27493d0d'],
    ['收坐.mp3', 'ef69dc857819f081cf636ff309a4d13edf64f216b8d2da05613d0c6e2d33c289']
  ]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'modules/timer/audio', name))).digest('hex'), expected);
});

for (const countdown of [true, false]) {
  test(`${countdown ? 'countdown' : 'count-up'} clears a recovered interruption marker before a later ordinary cold start`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(10000); h.hide(); h.advance(60000, { suspended: true }); h.show();
    h.advance(10000);
    const state = h.storage.get('timerState');
    assert.ok(!state.interrupted);
    const cold = timerHarness({ stored: h.snapshot(), now: h.now + 100000 });
    assert.equal(cold.mount().data.isRunning, false);
    assert.equal(cold.records[0][0], 1);
    assert.equal(cold.records[0][3], state.saveTime);
  });

  test(`${countdown ? 'countdown' : 'count-up'} accepts manual pause during an audio-only interruption`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(10000); h.audioBegin(); h.advance(5000); page.pauseTimer();
    assert.equal(page.data.isPaused, true);
    h.advance(90000, { suspended: true }); h.audioEnd();
    assert.equal(page.data.isPaused, true);
    page.startTimer(); h.advance(10000);
    assert.equal(page.data.elapsedTime, 25);
  });
}

test('count-up recovers embedded terminal draft after the separate completion write fails', () => {
  let failing = false;
  const h = timerHarness({ failWrite: key => failing && key === 'timerPendingCompletion', save: () => ({ success: false }) });
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(70000); h.hide(); page.onUnload();
  failing = true; h.hide({ reason: 0 });
  assert.equal(h.storage.get('timerState').pendingCompletion.sessionId, page.sessionId);
  const cold = timerHarness({ stored: h.snapshot(), now: h.now + 100000 });
  const restored = cold.mount();
  assert.equal(restored.pendingCompletion.sessionId, page.sessionId);
  assert.equal(restored.data.showCompletionDialog, true);
  assert.equal(restored.data.isRunning, false);
});

test('successful detached save retries terminal persistence when storage recovers before the next cold start', () => {
  let failing = false;
  const h = timerHarness({ failWrite: key => failing && ['timerState', 'timerPendingCompletion'].includes(key) });
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(70000); h.hide(); page.onUnload();
  failing = true; h.hide({ reason: 0 });
  assert.equal(h.records.length, 1);
  assert.equal(h.storage.get('timerState').isRunning, true);
  failing = false; h.show();
  const cold = timerHarness({ stored: h.snapshot(), now: h.now + 100000 });
  assert.equal(cold.mount().data.isRunning, false);
  assert.equal(cold.records.length, 0);
  assert.equal(cold.page.pendingCompletion, null);
});

test('terminal persistence retry cannot overwrite a newer draft when storage reads fail', () => {
  const h = timerHarness();
  const first = h.mount({ countdown: false });
  first.startTimer(); h.advance(70000); h.hide(); first.onUnload(); h.hide({ reason: 0 }); h.show();
  const next = h.mount();
  next.toggleMode({ detail: { value: true } }); next.applyDuration(1); next.startTimer(); h.advance(60000);
  const pendingId = next.pendingCompletion.sessionId;
  const before = h.snapshot();
  const read = h.api.getStorageSync;
  h.api.getStorageSync = key => {
    if (['timerState', 'timerPendingCompletion'].includes(key)) throw Error('read unavailable');
    return read(key);
  };
  h.runtime.onShow();
  h.api.getStorageSync = read;
  assert.deepEqual(h.storage.get('timerState'), before.timerState);
  assert.equal(h.storage.get('timerPendingCompletion').sessionId, pendingId);
  const cold = timerHarness({ stored: h.snapshot(), now: h.now + 10000 });
  assert.equal(cold.mount().pendingCompletion.sessionId, pendingId);
});

test('detached completion notice is consumed once across page recreation', () => {
  const h = timerHarness();
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(70000); h.hide(); page.onUnload(); h.hide({ reason: 0 }); h.show();
  h.mount().onUnload(); h.mount();
  assert.equal(h.toasts.filter(title => title === '正计时已结束，1分钟已存本机').length, 1);
});

test('saving an embedded cold-recovered count-up draft acknowledges both durable copies', async () => {
  let failing = false;
  const h = timerHarness({ failWrite: key => failing && key === 'timerPendingCompletion', save: () => ({ success: false }) });
  const page = h.mount({ countdown: false });
  page.startTimer(); h.advance(70000); h.hide(); page.onUnload();
  failing = true; h.hide({ reason: 0 });
  const cold = timerHarness({ stored: h.snapshot(), now: h.now + 10000,
    failWrite: key => failing && key === 'timerPendingCompletion' });
  const restored = cold.mount();
  assert.equal(cold.storage.get('timerState').pendingCompletion.sessionId, page.sessionId);
  assert.equal(restored.pendingCompletion.sessionId, page.sessionId);
  failing = false;
  await restored.confirmCompletion();
  assert.equal(cold.records.length, 1);
  assert.equal(cold.storage.get('timerState').pendingCompletion, null);
  const next = timerHarness({ stored: cold.snapshot(), now: cold.now + 10000 });
  assert.equal(next.mount().pendingCompletion, null);
  assert.equal(next.page.data.isRunning, false);
  assert.equal(next.records.length, 0);
});

test('cold return after an interrupted countdown deadline plays the end bell without replaying the start bell', () => {
  const h = timerHarness();
  const page = h.mount({ guide: true });
  page.applyDuration(1); page.startTimer(); h.advance(10000); h.hide(); page.onUnload();
  const cold = timerHarness({ stored: h.snapshot(), now: h.now + 90000 });
  const restored = cold.mount();
  assert.equal(restored.data.isRunning, false);
  assert.equal(restored.pendingCompletion.sessionId, page.sessionId);
  assert.equal(restored.pendingCompletion.duration, 1);
  assert.equal(cold.played(END_AUDIO).length, 1);
  assert.equal(cold.played(START_AUDIO).length, 0);
  cold.show();
  assert.equal(cold.played(END_AUDIO).length, 1);
});

for (const countdown of [true, false]) {
  test(`${countdown ? 'countdown' : 'count-up'} explicit close after a call ends the still-mounted session once`, () => {
    const h = timerHarness();
    const page = h.mount({ countdown });
    page.startTimer();
    const sessionId = page.sessionId;
    h.advance(10000); h.hide(); h.advance(60000, { suspended: true });
    h.hide({ reason: 0 }); h.hide({ reason: 0 }); h.show();
    assert.equal(page.data.isRunning, false);
    assert.equal(page.data.isPaused, false);
    assert.equal(h.records.length, 1);
    assert.equal(h.attempts.length, 1);
    assert.equal(h.records[0][0], 1);
    assert.equal(h.records[0][4], sessionId);
  });
}

test('a timer started while an existing audio interruption is active persists a recoverable checkpoint', () => {
  for (const countdown of [true, false]) {
    const h = timerHarness();
    h.audioBegin();
    const page = h.mount({ countdown });
    page.startTimer(); h.advance(10000);
    assert.equal(h.storage.get('timerState').interrupted, true);
    const cold = timerHarness({ stored: h.snapshot(), now: h.now + 60000 });
    const restored = cold.mount();
    assert.equal(restored.data.isRunning, true);
    assert.equal(restored.sessionId, page.sessionId);
    assert.equal(restored.data.elapsedTime, 70);
    h.audioEnd();
    assert.ok(!h.storage.get('timerState').interrupted);
  }
});
