const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const OWNER = 'oz-historical-owner';
const LOCAL_USER = 'local-historical-owner';
const LOCAL_KEY = `meditation_checkin_${LOCAL_USER}`;
const HISTORICAL_DATE = '2026-10-03';
const DELETION_ID = 'md_' + 'a'.repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

// Run the real upload, local record and Bijing queue modules in one VM. Only the
// WeChat SDK boundary and unrelated badge notifications are simulated.
function harness({ online = true } = {}) {
  const requests = [], timers = new Map(), storageWrites = [];
  const storage = new Map([['userOpenId', OWNER], ['localUserId', LOCAL_USER]]);
  const networkHandlers = new Set();
  let connected = online;
  let now = Date.parse('2026-10-05T04:00:00.000Z'), timerId = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const wx = {
    getStorageSync(key) { return plain(storage.get(key)); },
    setStorageSync(key, value) {
      storageWrites.push({ key, value: plain(value) }); storage.set(key, plain(value));
    },
    onNetworkStatusChange(callback) { networkHandlers.add(callback); },
    getNetworkType({ success }) { success({ networkType: connected ? 'wifi' : 'none' }); },
    cloud: { callFunction(request) { requests.push(request); } }
  };
  const context = vm.createContext({ wx, Date: Clock, console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const loaded = new Map();
  function load(name) {
    if (name === 'badgeManager.js') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
    if (loaded.has(name)) return loaded.get(name).exports;
    assert.ok(['cloudApi.js', 'bijingRecordSync.js', 'uploadNetwork.js', 'checkin.js', 'dateUtil.js'].includes(name), name);
    const filename = path.join(__dirname, '../miniprogram/utils', name);
    const module = { exports: {} }; loaded.set(name, module);
    const factory = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename });
    factory(dependency => {
      assert.match(dependency, /^\.\/[A-Za-z]+\.js$/);
      return load(dependency.slice(2));
    }, module, module.exports);
    return module.exports;
  }
  const api = load('cloudApi.js'), sync = load('bijingRecordSync.js');
  const saveRequests = () => requests.filter(request => request.name === 'meditationManager' && request.data.type === 'recordMeditation');
  const syncRequests = () => requests.filter(request => request.name === 'bijingSync' && ['syncRecordedDate', 'syncDeletedDate'].includes(request.data.type));
  const deleteRequests = () => requests.filter(request => request.name === 'meditationManager' && request.data.type === 'deleteMeditationRecord');
  return { api, sync, requests, timers, storage, storageWrites,
    get manager() { return load('checkin.js'); },
    get saves() { return saveRequests(); }, get syncs() { return syncRequests(); },
    get deletions() { return deleteRequests(); },
    get reads() { return requests.filter(request => request.name === 'meditationManager' && request.data.type === 'getAllRecords'); },
    rows() {
      const saved = storage.get(LOCAL_KEY) || {};
      return Object.values((saved.checkinRecords || saved).dailyRecords || {}).flatMap(day => day.records);
    },
    setConnected(value) {
      connected = value;
      for (const callback of networkHandlers) callback({ isConnected: value, networkType: value ? 'wifi' : 'none' });
    },
    remove() {
      return api.deleteMeditationRecord({ recordId: 'med_first', expectedOpenid: OWNER });
    },
    confirmDeletion(index = 0, changes = {}) {
      deleteRequests()[index].success({ result: { success: true, data: {
        recordId: 'med_first', date: HISTORICAL_DATE, deletionId: DELETION_ID, autoSyncBijing: true, ...changes
      } } });
    },
    upload(localId = 'local-first', options = {}) {
      return api.recordMeditation(30, [], '', Date.parse('2026-10-03T04:00:00.000Z'), localId,
        { source: 'manual', date: HISTORICAL_DATE, expectedOpenid: OWNER, ...options });
    },
    confirm(index = 0, changes = {}) {
      const response = { result: { success: true, data: {
        recordId: 'med_first', date: HISTORICAL_DATE, timestamp: Date.parse('2026-10-03T04:00:00.000Z'),
        duplicate: false, autoSyncBijing: true, ...changes
      } } };
      saveRequests()[index].success(response);
      return response;
    },
    synced(index = 0, duration = 30) {
      syncRequests()[index].success({ result: { success: true, data: {
        date: HISTORICAL_DATE, success: true, duration
      } } });
    },
    failed(index = 0, error = '必经服务暂时不可用') {
      syncRequests()[index].success({ result: { success: false, code: 'BACKFILL_SYNC_FAILED', error } });
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.due; timers.delete(id); timer.callback(); await flush();
      }
      now = end; await flush();
    }
  };
}

test('confirmed deletion syncs through its receipt and accepts zero without delaying the deletion result', async () => {
  const app = harness();
  const deletion = app.remove(); await flush();
  assert.equal(app.syncs.length, 0);
  app.confirmDeletion();
  assert.equal((await deletion).success, true); await flush();
  assert.equal(app.syncs.length, 1);
  assert.deepEqual(plain(app.syncs[0].data), { type: 'syncDeletedDate', deletionId: DELETION_ID, expectedOpenid: OWNER });
  assert.match(app.sync.getDayState(HISTORICAL_DATE).message, /已删除|已更新/);
  app.synced(0, 0); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  app.confirmDeletion(); await flush();
  assert.equal(app.syncs.length, 1, 'repeated SDK callbacks cannot double-count a deletion');
  assert.equal(app.saves.length, 0); assert.equal(app.timers.size, 0);
});

test('failed deletion synchronization preserves deletion success and retries only the day total', async () => {
  const app = harness(); const deletion = app.remove(); await flush(); app.confirmDeletion();
  assert.equal((await deletion).success, true); await flush();
  app.failed(0, '不支持零时长覆盖'); await flush();
  const task = app.sync.getDayState(HISTORICAL_DATE);
  assert.equal(task.status, 'failed'); assert.equal(task.canRetry, true);
  assert.match(task.message, /不支持零时长覆盖/);
  const retry = app.sync.retryDate(HISTORICAL_DATE); await flush();
  assert.deepEqual(plain(app.syncs[1].data), plain(app.syncs[0].data));
  app.synced(1, 0); assert.equal((await retry).status, 'synced');
  assert.equal(app.deletions.length, 1); assert.equal(app.saves.length, 0);
});

test('failed or current-day deletion confirmations never schedule an external correction', async () => {
  for (const result of [
    { success: false, code: 'RECORD_NOT_FOUND' },
    { success: false, code: 'DELETE_FAILED' },
    { success: true, data: { recordId: 'med_first', date: '2026-10-05', deletionId: DELETION_ID } },
    { success: true, data: { recordId: 'med_first', date: HISTORICAL_DATE, autoSyncBijing: true } }
  ]) {
    const app = harness(); const deletion = app.remove(); await flush();
    app.deletions[0].success({ result }); await deletion; await flush();
    assert.equal(app.syncs.length, 0); assert.equal(app.sync.getTasks().length, 0);
  }
});

test('late deletion confirmation stays with its original account until that account returns', async () => {
  const app = harness(); const deletion = app.remove(); await flush();
  app.storage.set('userOpenId', 'oz-other'); app.confirmDeletion();
  assert.equal((await deletion).success, true); await flush();
  assert.equal(app.syncs.length, 0); assert.equal(app.sync.getTasks().length, 0);
  assert.equal(app.sync.getDayState(HISTORICAL_DATE, OWNER).status, 'pending');
  app.storage.set('userOpenId', OWNER);
  const resume = app.sync.resumePending(); await flush();
  assert.equal(app.syncs.length, 1); app.synced(0, 0); await resume;
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
});

test('deleting during an upload sync sends a subsequent correction even after the upload reports success', async () => {
  const app = harness(); const upload = app.upload(); await flush(); app.confirm(); await upload; await flush();
  const deletion = app.remove(); await flush(); app.confirmDeletion(); await deletion; await flush();
  assert.equal(app.syncs.length, 1);
  app.synced(0, 30); await flush();
  assert.equal(app.syncs.length, 2);
  assert.equal(app.syncs[1].data.type, 'syncDeletedDate');
  app.synced(1, 0); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  assert.equal(app.saves.length, 1); assert.equal(app.deletions.length, 1);
});

test('real cloudApi returns a confirmed historical upload immediately while a separate day sync remains pending', async () => {
  const app = harness();
  const upload = app.upload();
  await flush();
  assert.equal(app.saves.length, 1); assert.equal(app.syncs.length, 0);
  app.confirm();
  const confirmed = await upload;
  assert.equal(confirmed.success, true); assert.equal(confirmed.data.recordId, 'med_first');
  await flush();
  assert.equal(app.syncs.length, 1, 'cloud confirmation automatically enters the real sync queue');
  assert.deepEqual(plain(app.syncs[0].data), {
    type: 'syncRecordedDate', recordId: 'med_first', expectedOpenid: OWNER
  });
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'syncing');
  assert.equal([...app.timers.values()].some(timer => timer.delay === 3000), false, 'upload no longer waits on its deadline');
  assert.equal([...app.timers.values()].some(timer => timer.delay === 45000), true, 'the independent sync has its own deadline');
  app.synced(); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  assert.equal(app.saves.length, 1); assert.equal(app.timers.size, 0);
});

test('a failed day sync leaves upload success intact and retryDate only repeats synchronization', async () => {
  const app = harness();
  const upload = app.upload(); await flush(); app.confirm();
  const confirmed = await upload; await flush();
  app.failed(); await flush();
  assert.equal(confirmed.success, true);
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'failed');
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).canRetry, true);
  const retry = app.sync.retryDate(HISTORICAL_DATE); await flush();
  assert.equal(app.saves.length, 1, 'retry must not submit meditationManager again');
  assert.equal(app.syncs.length, 2);
  assert.deepEqual(plain(app.syncs[1].data), plain(app.syncs[0].data));
  app.synced(1); const retried = await retry;
  assert.equal(retried.status, 'synced'); assert.equal(retried.completedRevision, 1);
  assert.equal(app.storageWrites.every(write => write.key === `bijing_record_sync_${OWNER}`), true,
    'the synchronization queue cannot modify the local meditation upload cache');
});

test('today without the server automatic-sync flag returns success without creating a sync task', async () => {
  const app = harness();
  const upload = app.upload('today', { date: '2026-10-05' }); await flush();
  const today = { recordId: 'med_today', date: '2026-10-05', duplicate: false };
  app.saves[0].success({ result: { success: true, data: today } });
  assert.equal((await upload).success, true); await flush();
  assert.equal(app.syncs.length, 0); assert.equal(app.requests.length, 1);
  assert.deepEqual(plain(app.sync.getTasks()), []);
  assert.equal(app.storageWrites.length, 0); assert.equal(app.timers.size, 0);
});

test('a new same-day saved record during synchronization queues a subsequent sync for the new record ID', async () => {
  const app = harness();
  const firstUpload = app.upload(); await flush(); app.confirm();
  assert.equal((await firstUpload).success, true); await flush();
  assert.equal(app.syncs.length, 1);
  const secondUpload = app.upload('local-second'); await flush();
  app.confirm(1, { recordId: 'med_second' });
  assert.equal((await secondUpload).success, true); await flush();
  assert.equal(app.saves.length, 2); assert.equal(app.syncs.length, 1, 'the first in-flight sync owns the date until it settles');
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).revision, 2);
  app.synced(0, 30); await flush();
  assert.equal(app.syncs.length, 2); assert.equal(app.syncs[1].data.recordId, 'med_second');
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'syncing');
  app.synced(1, 60); await flush();
  const task = app.sync.getDayState(HISTORICAL_DATE);
  assert.equal(task.status, 'synced'); assert.equal(task.completedRevision, 2);
  assert.deepEqual(plain(task.recordIds), ['med_first', 'med_second']);
  assert.equal(app.saves.length, 2, 'following up never recreates either meditation');
});

test('duplicate SDK save callbacks and duplicate cloud confirmations do not cause duplicate day syncs', async () => {
  const app = harness();
  const upload = app.upload(); await flush();
  const response = app.confirm();
  app.saves[0].success(response);
  assert.equal((await upload).success, true); await flush();
  assert.equal(app.syncs.length, 1);
  app.saves[0].success(response); await flush();
  assert.equal(app.syncs.length, 1);
  app.synced(); await flush();
  app.saves[0].success(response); await flush();
  assert.equal(app.syncs.length, 1);
  const repeatedUpload = app.upload(); await flush();
  app.confirm(1, { duplicate: true });
  assert.equal((await repeatedUpload).data.duplicate, true); await flush();
  assert.equal(app.syncs.length, 1); assert.equal(app.sync.getDayState(HISTORICAL_DATE).revision, 1);
  assert.deepEqual(plain(app.sync.getDayState(HISTORICAL_DATE).recordIds), ['med_first']);
  assert.equal(app.timers.size, 0);
});

test('a late successful save confirmation still schedules history sync after the upload timeout without resaving', async () => {
  const app = harness();
  const upload = app.upload(); await flush();
  await app.advance(3000);
  const timedOut = await upload;
  assert.equal(timedOut.success, false); assert.equal(timedOut.code, 'CLOUD_TIMEOUT');
  app.confirm(); await flush();
  assert.equal(app.saves.length, 1); assert.equal(app.syncs.length, 1);
  assert.equal(app.syncs[0].data.recordId, 'med_first');
  app.synced(); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  assert.equal(app.saves.length, 1); assert.equal(app.timers.size, 0);
});

test('an offline historical record enters Bijing sync after its automatic upload is confirmed', async () => {
  const app = harness({ online: false });
  const timestamp = Date.parse('2026-10-03T04:00:00.000Z');
  const local = await app.manager.recordCheckinWithSync(30, [], '', timestamp, 'offline-history');
  assert.equal(local.cloudSynced, false);
  assert.equal(app.rows()[0].syncErrorCode, 'UPLOAD_PAUSED');
  assert.equal(app.saves.length, 0); assert.equal(app.syncs.length, 0);
  app.setConnected(true);
  const upload = app.manager.retryAutomaticBackups();
  await flush();
  assert.equal(app.saves.length, 1); assert.equal(app.syncs.length, 0);
  assert.equal(app.saves[0].data.data.localId, local.localId);
  assert.equal(app.saves[0].data.data.timestamp, timestamp);
  app.confirm();
  const confirmed = await upload; await flush();
  assert.equal(confirmed.uploaded, 1); assert.equal(confirmed.pending, 0);
  assert.equal(app.rows()[0]._id, 'med_first'); assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.syncs.length, 1);
  assert.deepEqual(plain(app.syncs[0].data), {
    type: 'syncRecordedDate', recordId: 'med_first', expectedOpenid: OWNER
  });
  app.failed(); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'failed');
  assert.equal(app.rows()[0].syncStatus, 'synced', 'Bijing failure must not undo the confirmed local upload');
  const retry = app.sync.retryDate(HISTORICAL_DATE); await flush();
  app.synced(1); await retry;
  assert.equal(app.saves.length, 1, 'a Bijing retry must not upload the offline record again');
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
});

test('an offline current-day upload waits for the daily server schedule after cloud confirmation', async () => {
  const app = harness({ online: false });
  const local = await app.manager.recordCheckinWithSync(30, [], '', Date.parse('2026-10-05T03:00:00.000Z'), 'offline-today');
  assert.equal(local.cloudSynced, false); assert.equal(app.saves.length, 0);
  app.setConnected(true);
  const upload = app.manager.retryTodayBackups(); await flush();
  assert.equal(app.saves.length, 1);
  app.confirm(0, { recordId: 'med_today', date: '2026-10-05', autoSyncBijing: false });
  assert.equal((await upload).uploaded, 1); await flush();
  assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.syncs.length, 0); assert.deepEqual(plain(app.sync.getTasks()), []);
});

test('cloud recovery of an offline historical upload enters the real Bijing queue once without resaving', async () => {
  const app = harness({ online: false });
  await app.manager.recordCheckinWithSync(30, [], '', Date.parse('2026-10-03T04:00:00.000Z'), 'recovered-history');
  const local = plain(app.rows()[0]);
  app.setConnected(true);
  const remote = { ...local, _id: 'med_recovered', _openid: OWNER };
  const refresh = app.manager.refreshFromCloud(); await flush();
  app.reads[0].success({ result: { success: true, data: [remote] } });
  assert.equal(await refresh, true); await flush();
  assert.equal(app.rows()[0]._id, remote._id); assert.equal(app.rows()[0].syncStatus, 'synced');
  assert.equal(app.saves.length, 0); assert.equal(app.syncs.length, 1);
  assert.equal(app.syncs[0].data.recordId, remote._id);
  app.synced(); await flush();
  const reread = app.manager.refreshFromCloud(); await flush();
  app.reads[1].success({ result: { success: true, data: [remote] } });
  assert.equal(await reread, true); await flush();
  assert.equal(app.syncs.length, 1, 'ordinary cloud rereads must not resync all historical records');
  assert.equal(app.saves.length, 0);
});

test('late offline-upload confirmation still syncs Bijing after all local upload attempts timed out', async () => {
  const app = harness({ online: false });
  const local = await app.manager.recordCheckinWithSync(30, [], '', Date.parse('2026-10-03T04:00:00.000Z'), 'late-offline');
  app.setConnected(true);
  const upload = app.manager.syncWithCloud({ uploadPending: true, localIds: [local.localId] });
  await flush(); await app.advance(12300);
  assert.equal((await upload).uploaded, 0);
  assert.equal(app.saves.length, 4); assert.equal(app.syncs.length, 0);
  assert.equal(new Set(app.saves.map(request => request.data.data.localId)).size, 1);
  app.confirm(); await flush();
  assert.equal(app.syncs.length, 1);
  app.synced(); await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  assert.equal(app.saves.length, 4, 'late acknowledgement must not start another local upload round');
  app.confirm(1, { duplicate: true }); await flush();
  assert.equal(app.syncs.length, 1, 'late duplicate attempts reuse the confirmed Bijing task');
});

test('a persisted backfill blocked only by expiry automatically replays its original grant and starts recorded-date sync', async () => {
  const app = harness({ online: false });
  const timestamp = Date.parse(`${HISTORICAL_DATE}T12:00:00+08:00`);
  app.manager.recordToLocal(30, [], [], timestamp, { source: 'timer', idempotencyKey: 'approved-offline-session' });
  Object.assign(app.rows()[0], { source: 'manual', backfillRequestId: 'br_' + 'a'.repeat(64),
    recordType: 'backfill', syncStatus: 'failed', syncBlocked: true, syncErrorCode: 'BACKFILL_EXPIRED' });
  await app.advance(5 * 86400000);
  app.setConnected(true);
  const retry = app.manager.retryAutomaticBackups();
  await flush();
  assert.equal(app.saves.length, 1);
  const payload = app.saves[0].data.data;
  assert.equal(payload.localId, 'approved-offline-session');
  assert.equal(payload.backfillRequestId, 'br_' + 'a'.repeat(64));
  assert.equal(payload.source, 'manual');
  assert.equal(payload.date, HISTORICAL_DATE);
  assert.equal(payload.timestamp, timestamp);
  assert.equal(payload.offlineReplay, true);
  app.confirm();
  assert.equal((await retry).uploaded, 1);
  await flush();
  assert.equal(app.syncs.length, 1);
  assert.equal(app.syncs[0].data.type, 'syncRecordedDate');
  app.synced();
  await flush();
  assert.equal(app.sync.getDayState(HISTORICAL_DATE).status, 'synced');
  assert.equal(app.rows()[0].backfillRequestId, payload.backfillRequestId);
  assert.equal(app.rows()[0].syncBlocked, undefined);
});
