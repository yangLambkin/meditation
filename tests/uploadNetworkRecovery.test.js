const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INITIAL_TIME = Date.parse('2026-09-20T12:00:00+08:00');
const LOCAL_USER = 'local_upload_network_recovery';
const OPENID = 'oz-upload-network-recovery';
const STORAGE_KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? value : structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));

// Keep the real queue, request wrapper, moderation, and date logic together.
// An offline SDK request waits for connectivity instead of immediately failing:
// this catches writes dispatched offline that can reach the cloud on recovery.
function harness({ online = true, firstUploadFails = false, holdModeration = false,
  holdUploads = false, networkProbe = 'success' } = {}) {
  let now = INITIAL_TIME;
  let connected = online;
  let nextTimer = 0;
  const timers = new Map();
  const networkHandlers = new Set();
  const queuedSdkRequests = [];
  const moderationRequests = [];
  const uploadRequests = [];
  const cloudRows = new Map();
  const calls = { uploads: [], moderation: [], reads: 0, network: 0 };
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
  function finishRequest(options) {
    if (options.name === 'contentSecCheck') {
      options.success({ result: { success: true, safe: true } });
      return;
    }
    if (options.data.type === 'getAllRecords') {
      options.success({ result: { success: true, data: clone([...cloudRows.values()]) } });
      return;
    }
    assert.equal(options.data.type, 'recordMeditation');
    if (firstUploadFails) {
      firstUploadFails = false;
      options.success({ result: { success: false, code: 'TEMPORARY_FAILURE', error: '请稍后重试' } });
      return;
    }
    const record = clone(options.data.data);
    const recordId = `cloud-${record.localId}`;
    cloudRows.set(record.localId, { ...record, _id: recordId, _openid: OPENID });
    options.success({ result: { success: true, data: { recordId } } });
  }
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    getNetworkType({ success, fail }) {
      const mode = typeof networkProbe === 'function' ? networkProbe(++calls.network)
        : (calls.network++, networkProbe);
      if (mode === 'fail') fail(new Error('Network probe failed'));
      else if (mode !== 'pending') success({ networkType: connected ? 'wifi' : 'none' });
    },
    onNetworkStatusChange: handler => networkHandlers.add(handler),
    offNetworkStatusChange: handler => networkHandlers.delete(handler),
    cloud: {
      callFunction(options) {
        if (options.name === 'contentSecCheck') {
          calls.moderation.push(clone(options.data));
          if (holdModeration) {
            moderationRequests.push(options);
            return;
          }
        } else if (options.data.type === 'recordMeditation') {
          calls.uploads.push({ at: now, data: clone(options.data.data) });
          if (holdUploads) {
            uploadRequests.push(options);
            return;
          }
        } else {
          assert.equal(options.data.type, 'getAllRecords');
          calls.reads++;
        }
        if (connected) finishRequest(options);
        else queuedSdkRequests.push(options);
      }
    }
  };
  const root = path.resolve(__dirname, '../miniprogram');
  const modules = new Map();
  function load(filename) {
    const absolute = path.resolve(root, filename);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
      module, exports: module.exports, wx, Date: Clock, ...clock,
      console: { log() {}, warn() {}, error() {} },
      require(request) {
        assert.ok(request.startsWith('.'), `Unexpected external dependency: ${request}`);
        const resolved = path.resolve(path.dirname(absolute), request);
        if (path.basename(resolved) === 'badgeManager.js') {
          return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
        }
        return load(path.extname(resolved) ? resolved : `${resolved}.js`);
      }
    }, { filename: absolute });
    return module.exports;
  }
  const manager = load('utils/checkin.js');
  return {
    manager, calls, cloudRows,
    rows() {
      const stored = storage.get(STORAGE_KEY);
      return clone(Object.values((stored.checkinRecords || stored).dailyRecords).flatMap(day => day.records));
    },
    record(id, experience = []) {
      return manager.recordCheckinWithSync(12, [], experience, INITIAL_TIME - 1000, id);
    },
    async setConnected(value) {
      connected = value;
      for (const handler of [...networkHandlers]) {
        handler({ isConnected: value, networkType: value ? 'wifi' : 'none' });
      }
      if (value) for (const request of queuedSdkRequests.splice(0)) finishRequest(request);
      await flush();
    },
    async resolveModeration() {
      holdModeration = false;
      for (const request of moderationRequests.splice(0)) finishRequest(request);
      await flush();
    },
    async resolveUploads() {
      holdUploads = false;
      for (const request of uploadRequests.splice(0)) finishRequest(request);
      await flush();
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      let callbacks = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++callbacks < 100, 'network recovery must not create unbounded retries');
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

test('offline save never dispatches a cloud write and recovery waits for an explicit manual upload', async () => {
  const app = harness({ online: false });
  const saving = app.record('offline-save');
  await flush();
  assert.equal(app.rows().length, 1, 'the record is durable before any network request');
  assert.equal(app.calls.uploads.length, 0, 'do not give the SDK an offline write that it can resend later');
  assert.equal((await saving).cloudSynced, false);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  const original = app.rows()[0];

  await app.setConnected(true);
  await app.manager.syncWithCloud();
  await app.advance(60000);
  assert.equal(app.calls.uploads.length, 0, 'recovery, reads, and elapsed time cannot replace a manual upload');
  assert.equal(app.cloudRows.size, 0);

  const uploaded = await app.manager.syncWithCloud({ uploadPending: true });
  assert.equal(uploaded.uploaded, 1);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  for (const key of ['localId', 'timestamp', 'duration', 'date', 'experience']) {
    assert.deepEqual(app.rows()[0][key], original[key], key);
  }
});

test('disconnecting during a retry delay permanently stops that upload round after recovery', async () => {
  const app = harness({ firstUploadFails: true });
  const saving = app.record('retry-interrupted');
  await flush();
  assert.equal(app.calls.uploads.length, 1, 'an ordinary online cloud error permits a retry');
  await app.advance(50);
  await app.setConnected(false);
  await app.advance(49);
  await app.setConnected(true);
  await app.advance(60000);
  assert.equal(app.calls.uploads.length, 1, 'recovery must not revive a round that observed a disconnection');
  assert.equal((await saving).cloudSynced, false);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.cloudRows.size, 0);
  assert.equal((await app.manager.syncWithCloud({ uploadPending: true })).uploaded, 1);
  assert.equal(app.calls.uploads.length, 2, 'a fresh manual upload round can proceed online');
});

test('a moderation response arriving after a disconnect and recovery cannot dispatch the record write', async () => {
  const app = harness({ holdModeration: true });
  const saving = app.record('moderation-interrupted', ['平静的呼吸']);
  await flush();
  assert.equal(app.calls.moderation.length, 1);
  assert.equal(app.calls.uploads.length, 0);
  await app.setConnected(false);
  await app.setConnected(true);
  await app.resolveModeration();
  await app.advance(60000);
  assert.equal(app.calls.uploads.length, 0, 'moderation approval cannot resume an interrupted upload');
  assert.equal((await saving).cloudSynced, false);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.cloudRows.size, 0);
  assert.equal((await app.manager.syncWithCloud({ uploadPending: true })).uploaded, 1);
  assert.equal(app.calls.uploads.length, 1);
});

test('an uninterrupted online first upload still succeeds with real moderation and cloud wrappers', async () => {
  const app = harness();
  const result = await app.record('online-save', ['平静的呼吸']);
  assert.equal(result.cloudSynced, true);
  assert.equal(app.calls.moderation.length, 1);
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  await app.advance(60000);
  assert.equal(app.calls.uploads.length, 1);
});

test('a manual batch keeps an already dispatched successful write but stops before uploading the next record after disconnection', async () => {
  const app = harness({ online: false, holdUploads: true });
  assert.equal((await app.record('batch-first')).cloudSynced, false);
  assert.equal((await app.record('batch-second')).cloudSynced, false);
  await app.setConnected(true);
  const manual = app.manager.syncWithCloud({ uploadPending: true });
  await flush();
  assert.equal(app.calls.uploads.length, 1);
  assert.equal(app.calls.uploads[0].data.localId, 'batch-first');

  await app.setConnected(false);
  await app.setConnected(true);
  await app.resolveUploads();
  const result = await manual;
  assert.equal(result.uploaded, 1, 'a real confirmation for an already dispatched request must be preserved');
  assert.equal(app.calls.uploads.length, 1, 'recovery cannot authorize the next record in the batch');
  assert.equal(app.cloudRows.size, 1);
  const records = app.rows();
  assert.equal(records.find(record => record.localId === 'batch-first').syncStatus, 'synced');
  assert.notEqual(records.find(record => record.localId === 'batch-second').syncStatus, 'synced');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);

  assert.equal((await app.manager.syncWithCloud({ uploadPending: true })).uploaded, 1);
  assert.equal(app.calls.uploads.length, 2);
  assert.equal(app.cloudRows.size, 2);
});

for (const networkProbe of ['fail', 'pending']) {
  test(`a ${networkProbe === 'fail' ? 'failed' : 'hung'} network probe keeps the record local and cannot dispatch cloud requests`, async () => {
    const app = harness({ networkProbe });
    const saving = app.record(`probe-${networkProbe}`, ['平静的呼吸']);
    await flush();
    await app.advance(60000);
    assert.equal((await saving).cloudSynced, false);
    assert.equal(app.calls.network, 1, 'a failed connectivity probe ends the round without automatic retries');
    assert.equal(app.calls.moderation.length, 0);
    assert.equal(app.calls.uploads.length, 0);
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    assert.equal(app.cloudRows.size, 0);
  });
}

test('a hanging cloud-wrapper network probe cannot become a timeout retry after the queue probe succeeds', async () => {
  const app = harness({ networkProbe: attempt => attempt === 1 ? 'success' : 'pending' });
  const saving = app.record('second-probe-hangs');
  await flush();
  assert.equal(app.calls.network, 2, 'both the queue and cloud wrapper probe connectivity');
  await app.advance(3100);
  assert.equal((await saving).cloudSynced, false);
  await app.advance(60000);
  assert.equal(app.calls.network, 2, 'a probe timeout invalidates the round even if the outer timeout settles first');
  assert.equal(app.calls.uploads.length, 0);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
});

test('late moderation approvals after the complete timeout round cannot dispatch record writes', async () => {
  const app = harness({ holdModeration: true });
  const saving = app.record('late-moderation', ['平静的呼吸']);
  await flush();
  await app.advance(12300);
  assert.equal((await saving).cloudSynced, false);
  assert.equal(app.calls.moderation.length, 4, 'only the bounded online retry round runs');
  assert.equal(app.calls.uploads.length, 0);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  await app.resolveModeration();
  await app.advance(60000);
  assert.equal(app.calls.uploads.length, 0, 'late SDK success callbacks cannot continue expired attempts');
  assert.equal(app.cloudRows.size, 0);
  assert.notEqual(app.rows()[0].syncStatus, 'synced');
});
