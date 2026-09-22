const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INITIAL_TIME = Date.parse('2026-09-20T12:00:00+08:00');
const LOCAL_USER = 'local-today-upload';
const OPENID = 'oz-today-upload';
const STORAGE_KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? value : structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise actual app lifecycle, queue selection, network guard, cloud wrapper,
// reconciliation, and business dates. Only platform boundaries are substituted.
function harness({ now: initialTime = INITIAL_TIME, online = true, failures = 0, holdUploads = false } = {}) {
  let now = initialTime;
  let connected = online;
  let nextTimer = 0;
  let app;
  const timers = new Map();
  const handlers = new Set();
  const heldUploads = [];
  const cloudRows = new Map();
  const calls = { uploads: [], reads: 0, checks: [], uploadSteps: [] };
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', OPENID],
    [STORAGE_KEY, { dailyRecords: {}, monthlyStats: {}, userStats: {} }]
  ]);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const clock = {
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + Number(milliseconds || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  function completeUpload(options) {
    if (failures > 0) {
      failures--;
      options.success({ result: { success: false, code: 'TEMPORARY_FAILURE', error: '稍后重试' } });
      return;
    }
    const row = clone(options.data.data);
    const recordId = `cloud-${row.localId}`;
    cloudRows.set(row.localId, { ...row, _id: recordId, _openid: OPENID });
    options.success({ result: { success: true, data: { recordId } } });
  }
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    getNetworkType({ success }) { success({ networkType: connected ? 'wifi' : 'none' }); },
    onNetworkStatusChange: callback => handlers.add(callback),
    offNetworkStatusChange: callback => handlers.delete(callback),
    cloud: {
      init() {},
      callFunction(options) {
        if (!connected) return options.fail(new Error('Offline'));
        if (options.name === 'contentSecCheck') {
          calls.checks.push({ at: now, data: clone(options.data) });
          const response = { result: { success: true, safe: true } };
          if (!options.success) return Promise.resolve(response);
          calls.uploadSteps.push('check');
          return options.success(response);
        }
        assert.equal(options.name, 'meditationManager');
        if (options.data.type === 'getAllRecords') {
          calls.reads++;
          return options.success({ result: { success: true, data: clone([...cloudRows.values()]) } });
        }
        assert.equal(options.data.type, 'recordMeditation');
        calls.uploadSteps.push('upload');
        calls.uploads.push({ at: now, data: clone(options.data.data) });
        if (holdUploads) heldUploads.push(options);
        else completeUpload(options);
      }
    }
  };
  const root = path.resolve(__dirname, '../miniprogram');
  const modules = new Map();
  const pages = new Map();
  function load(filename) {
    const absolute = path.resolve(root, filename);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
      module, exports: module.exports, wx, Date: Clock, ...clock,
      console: { log() {}, warn() {}, error() {} },
      App: definition => { app = definition; },
      Page: definition => pages.set(absolute, definition),
      require(request) {
        assert.ok(request.startsWith('.'), `Unexpected external dependency: ${request}`);
        const resolved = path.resolve(path.dirname(absolute), request);
        const name = path.basename(resolved, '.js');
        if (name === 'badgeManager') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
        if (name === 'dailyWisdom') return { DEFAULT_QUOTE: '每日金句' };
        if (name === 'dailyCardImage') return { prepareNextImage() {} };
        if (name === 'screenBrightness') return { createScreenBrightnessController() {} };
        return load(path.extname(resolved) ? resolved : `${resolved}.js`);
      }
    }, { filename: absolute });
    return module.exports;
  }
  const manager = load('utils/checkin.js');
  const dateUtil = load('utils/dateUtil.js');
  load('app.js');
  app.setupCacheStatus = () => {};
  app.testCloudEnvironment = () => {};
  app.setAudioOptions = () => {};
  app.onLaunch();
  function rows() {
    const stored = storage.get(STORAGE_KEY);
    return Object.values((stored.checkinRecords || stored).dailyRecords).flatMap(day => day.records);
  }
  return {
    app, manager, dateUtil, calls, storage, cloudRows,
    rows: () => clone(rows()),
    page(name) {
      const filename = `pages/${name}/${name}.js`;
      load(filename);
      const definition = pages.get(path.resolve(root, filename));
      return {
        ...definition,
        data: clone(definition.data),
        setData(values) { Object.assign(this.data, values); }
      };
    },
    seed(localId, timestamp = now - 1000, metadata = {}, overrides = {}) {
      manager.recordToLocal(12, [], [], timestamp, { idempotencyKey: localId, ...metadata });
      Object.assign(rows().find(row => row.localId === localId), overrides);
    },
    record(localId) { return manager.recordCheckinWithSync(12, [], [], now - 1000, localId); },
    setFailures(count) { failures = count; },
    async releaseUploads() {
      holdUploads = false;
      for (const options of heldUploads.splice(0)) completeUpload(options);
      await flush();
    },
    async setConnected(value) {
      connected = value;
      for (const handler of [...handlers]) handler({ isConnected: value, networkType: value ? 'wifi' : 'none' });
      await flush();
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      let callbacks = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++callbacks < 100, 'opening the app must not create an unbounded retry loop');
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

test('opening uploads today automatically and leaves yesterday for explicit manual upload', async () => {
  const h = harness();
  h.seed('today');
  h.seed('yesterday', INITIAL_TIME - 86400000);
  await h.app.onShow();
  assert.deepEqual(h.calls.uploads.map(call => call.data.localId), ['today']);
  assert.equal(h.rows().find(row => row.localId === 'today').syncStatus, 'synced');
  assert.notEqual(h.rows().find(row => row.localId === 'yesterday').syncStatus, 'synced');
  assert.equal(h.manager.getPendingSyncSummary().pending, 1);
  await h.app.onShow();
  assert.equal(h.calls.uploads.length, 1, 'showing the app again cannot duplicate an already confirmed upload');
  assert.equal((await h.manager.syncWithCloud({ uploadPending: true })).uploaded, 1);
  assert.deepEqual(h.calls.uploads.map(call => call.data.localId), ['today', 'yesterday']);
  assert.equal(h.cloudRows.size, 2);
});

test('opening retries a failed first upload with the bounded retry policy and original record identity', async () => {
  const h = harness({ failures: 4 });
  const first = h.record('failed-today');
  await flush();
  await h.advance(300);
  assert.equal((await first).cloudSynced, false);
  assert.equal(h.calls.uploads.length, 4);
  h.setFailures(1);
  const showing = h.app.onShow();
  await flush();
  assert.equal(h.calls.uploads.length, 5);
  await h.advance(100);
  await showing;
  assert.equal(h.calls.uploads.length, 6, 'foreground retry retains the 100 ms retry delay');
  assert.ok(h.calls.uploads.every(call => call.data.localId === 'failed-today'));
  assert.equal(h.cloudRows.size, 1);
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].syncStatus, 'synced');
  await h.app.onShow();
  assert.equal(h.calls.uploads.length, 6);
});

test('a network recovery event only refreshes until opening starts the next automatic round', async () => {
  const h = harness({ online: false });
  h.seed('today-after-offline');
  await h.setConnected(true);
  await h.advance(60000);
  assert.ok(h.calls.reads > 0);
  assert.equal(h.calls.uploads.length, 0, 'connectivity recovery is not an automatic upload trigger');
  await h.app.onShow();
  assert.deepEqual(h.calls.uploads.map(call => call.data.localId), ['today-after-offline']);
});

test('today selection follows the actual Beijing 02:00 business-day boundary and explicit manual dates', async () => {
  const before = harness({ now: Date.parse('2026-09-20T01:59:59+08:00') });
  assert.equal(before.dateUtil.getBusinessDate(), '2026-09-19');
  before.seed('current-business-day', Date.parse('2026-09-19T12:00:00+08:00'));
  before.seed('older-business-day', Date.parse('2026-09-18T12:00:00+08:00'));
  await before.manager.retryTodayBackups();
  assert.deepEqual(before.calls.uploads.map(call => call.data.localId), ['current-business-day']);

  const boundary = Date.parse('2026-09-20T02:00:00+08:00');
  const after = harness({ now: boundary });
  assert.equal(after.dateUtil.getBusinessDate(), '2026-09-20');
  after.seed('before-cutoff', boundary - 1);
  after.seed('at-cutoff', boundary);
  after.seed('manual-yesterday', boundary, { source: 'manual', date: '2026-09-19' });
  await after.manager.retryTodayBackups();
  assert.deepEqual(after.calls.uploads.map(call => call.data.localId), ['at-cutoff']);
});

test('today automatic selection skips foreign accounts, blocked, ignored, legacy, confirmed and actively uploading records', async () => {
  const h = harness({ holdUploads: true });
  h.seed('eligible');
  h.seed('other-account', undefined, {}, { syncOpenid: 'oz-other-account' });
  h.seed('blocked', undefined, {}, { syncBlocked: true, syncErrorCode: 'CONTENT_REJECTED' });
  h.seed('ignored', undefined, {}, { syncIgnored: true });
  h.seed('legacy', undefined, {}, { syncVersion: undefined });
  h.seed('confirmed', undefined, {}, { _id: 'existing-cloud-record', syncStatus: 'synced' });
  const active = h.record('in-flight');
  await flush();
  assert.deepEqual(h.calls.uploads.map(call => call.data.localId), ['in-flight']);
  const retry = h.manager.retryTodayBackups();
  await flush();
  assert.deepEqual(h.calls.uploads.map(call => call.data.localId), ['in-flight', 'eligible']);
  await h.releaseUploads();
  await Promise.all([active, retry]);
  assert.equal(h.calls.uploads.length, 2);
  assert.equal(h.cloudRows.size, 2);
});

test('overlapping onShow calls share the active upload and never send the same record twice', async () => {
  const h = harness({ holdUploads: true });
  h.seed('overlapping-today');
  const first = h.app.onShow();
  const second = h.app.onShow();
  const third = h.app.onShow();
  await flush();
  assert.equal(h.calls.uploads.length, 1);
  await h.releaseUploads();
  await Promise.all([first, second, third]);
  assert.equal(h.cloudRows.size, 1);
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].syncStatus, 'synced');
});

for (const entry of ['manual check-in', 'count-up timer', 'countdown timer']) {
  for (const recovery of ['automatic today upload', 'manual historical upload']) {
    test(`${entry} uses the same reviewed payload and retry policy for ${recovery}`, async () => {
      const h = harness({ failures: 4 });
      const text = '坐了十二分钟，呼吸逐渐平稳。';
      const page = h.page(entry === 'manual check-in' ? 'index' : 'timer');
      if (entry === 'manual check-in') {
        page.openCheckinModal();
        page.onCheckinDurationInput({ detail: { value: '12' } });
        page.onCheckinExperienceInput({ detail: { value: text } });
        await page.submitCheckin();
      } else {
        // Start at the completion draft; audio, brightness and ticking are unrelated
        // to the save/upload path shared by both actual timer modes.
        page.data.isCountdown = entry === 'countdown timer';
        page.pendingCompletion = {
          sessionId: `session-${entry}`, duration: 12, endedAt: INITIAL_TIME - 1234, text
        };
        page.onCompletionInput({ detail: { value: text } });
        await page.confirmCompletion();
      }
      await flush();
      assert.equal(h.rows().length, 1, 'the page saves one local record before cloud success');
      assert.equal(h.rows()[0].syncStatus, 'uploading');
      await h.advance(300);
      assert.equal(h.rows()[0].syncStatus, 'failed');
      assert.equal(h.cloudRows.size, 0);
      assert.deepEqual(h.calls.uploads.map(call => call.at - INITIAL_TIME), [0, 100, 200, 300]);
      const original = h.calls.uploads[0].data;
      assert.equal(original.duration, 12);
      assert.equal(original.source, entry === 'manual check-in' ? 'manual' : 'timer');
      assert.equal(original.date, '2026-09-20');
      assert.equal(original.timestamp, entry === 'manual check-in' ? INITIAL_TIME : INITIAL_TIME - 1234);
      assert.equal(original.localId, h.rows()[0].localId);
      assert.equal(original.experience[0].text, text);

      h.setFailures(1);
      let retry;
      if (recovery === 'automatic today upload') {
        retry = h.app.onShow();
      } else {
        await h.advance(86400000);
        await h.app.onShow();
        assert.equal(h.calls.uploads.length, 4, 'opening must leave the now historical record for manual upload');
        const home = h.page('index');
        home.openCheckinUploadPreview();
        assert.equal(home.data.checkinUploadCount, 1);
        assert.equal(h.calls.uploads.length, 4, 'preview does not authorize an upload');
        retry = home.retryCheckinUploads();
      }
      await flush();
      assert.equal(h.calls.uploads.length, 5);
      await h.advance(99);
      assert.equal(h.calls.uploads.length, 5, 'recovery also waits the full 100 ms before retrying');
      await h.advance(1);
      await retry;

      assert.equal(h.calls.uploads.length, 6);
      for (const call of h.calls.uploads) {
        assert.deepEqual(call.data, original, 'every attempt retains the original complete payload and identity');
      }
      assert.equal(h.calls.checks.length, 7, 'one page precheck plus a fresh text check for every upload attempt');
      assert.ok(h.calls.checks.every(call => call.data.type === 'text' && call.data.content === text && call.data.scene === 2));
      assert.deepEqual(h.calls.uploadSteps, Array(6).fill(['check', 'upload']).flat());
      assert.equal(h.rows().length, 1);
      assert.equal(h.rows()[0].syncStatus, 'synced');
      assert.equal(h.rows()[0]._id, `cloud-${original.localId}`);
      assert.equal(h.cloudRows.size, 1);
      assert.deepEqual(h.cloudRows.get(original.localId), { ...original, _id: `cloud-${original.localId}`, _openid: OPENID });
      await h.app.onShow();
      const home = h.page('index');
      home.openCheckinUploadPreview();
      await home.retryCheckinUploads();
      assert.equal(h.calls.uploads.length, 6, 'confirmed records cannot be reuploaded by either entry');
    });
  }
}
