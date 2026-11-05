const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const OWNER = { openid: 'oz-practice-owner', studentNumber: 'B1234', bindingVersion: 'binding-v1' };
const OCCURRED = Date.parse('2026-10-31T00:30:00+08:00');
const UPDATED = Date.parse('2026-10-31T00:31:00+08:00');
const DELETION_ID = `md_${'a'.repeat(64)}`;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ storage = new Map(), records = [], request, cloudCall, failStorage = false } = {}) {
  let owner = clone(OWNER), now = UPDATED + 1000, timerId = 0;
  const timers = new Map(), cache = {}, requests = [], cloudRequests = [], waits = [];
  const config = { baseUrl: 'https://data.bijing.life', practicesEnabled: true, sittingMirrorEnabled: true, serviceAccessToken: 'test-only-token' };
  const auth = { getOwner: () => clone(owner), getAccessToken: async () => 'test-only-token', clearSession() {} };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  storage.set('localUserId', 'practice-local');
  storage.set('userOpenId', OWNER.openid);
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) { if (failStorage) throw new Error('storage full'); storage.set(key, clone(value)); },
    showToast() {},
    getNetworkType({ success }) { success({ networkType: 'wifi' }); },
    request(options) {
      requests.push(options);
      if (request) request(options, requests.length);
      else options.success({ statusCode: 200, data: { success: true, data: { id: 'data-record-1' } } });
      return { abort() {} };
    },
    cloud: { callFunction(options) {
      cloudRequests.push(options);
      if (cloudCall && cloudCall(options) === true) return;
      if (options.data.type === 'getAllRecords') options.success({ result: { success: true, data: clone(records) } });
      else options.success({ result: { success: true, data: { recordId: 'source-record' } } });
    } }
  };
  function load(name) {
    if (cache[name]) return cache[name].exports;
    if (name === 'practiceConfig.js') return config;
    if (name === 'practiceAuth.js') return auth;
    if (name === 'bijingRecordSync.js') return { acceptSavedRecord() {}, acceptDeletedRecord() {} };
    const module = { exports: {} };
    cache[name] = module;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, wx, Date: Clock, console: { log() {}, warn() {}, error() {} },
      setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { due: now + ms, callback, ms }); return id; },
      clearTimeout(id) { timers.delete(id); }, require: name => load(name.replace(/^\.\//, ''))
    }, { filename: name });
    return module.exports;
  }
  return { load, storage, records, requests, cloudRequests, config, wx, waits,
    owner(value) { owner = clone(value); }, failStorage(value) { failStorage = value; },
    async settle(promise) {
      let done = false, result, error;
      promise.then(value => { done = true; result = value; }, value => { done = true; error = value; });
      for (let i = 0; i < 50 && !done; i++) {
        await tick();
        if (done) break;
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (next) { timers.delete(next[0]); now = next[1].due; waits.push(next[1].ms); next[1].callback(); }
      }
      if (!done) throw new Error('promise did not settle');
      if (error) throw error;
      return result;
    }
  };
}
const payload = { occurredAt: '2026-10-31 00:30:00', recordDate: '2026-10-31', durationMinutes: 12, reflection: '观察呼吸' };
const source = extra => ({ _id: 'source-record', _openid: OWNER.openid, localId: 'local-source', timestamp: OCCURRED,
  duration: 12, experience: ['观察呼吸'], createdAt: UPDATED, updatedAt: UPDATED, ...extra });
const localSource = extra => ({ localId: 'local-source', timestamp: OCCURRED, duration: 12, experience: [],
  syncVersion: 1, syncStatus: 'pending', syncSourceAttempted: false, syncOpenid: OWNER.openid, ...extra });
function storeLocalSource(app, record) {
  app.storage.set('meditation_checkin_practice-local', { dailyRecords: { '2026-10-30': { records: [record] } } });
}



test('edit mirror waits for the expected full source snapshot, then updates time duration and complete reflection', async () => {
  const records = [source({ experience: [{ text: '旧感悟' }], experienceEdited: false })];
  const app = harness({ records });
  storeLocalSource(app, records[0]);
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const updates = { timestamp: OCCURRED - 3600000, duration: 20, reflection: '新感悟' };
  const intent = mirror.beforeCloudMutation('meditationManager', { type: 'editMeditationRecord', data: {
    recordId: 'source-record', timestamp: OCCURRED, updates
  } });
  assert.equal(intent.operation, 'update');
  await app.settle(mirror.acceptCloudSnapshot(records));
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending()[0].status, 'waiting_source');
  records[0] = source({ timestamp: updates.timestamp, duration: updates.duration, updatedAt: UPDATED + 500,
    experience: [{ text: updates.reflection }], experienceEdited: true });
  await app.settle(mirror.acceptCloudSnapshot(records));
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'PUT');
  assert.equal(app.requests[0].data.recordDate, '2026-10-30');
  assert.equal(app.requests[0].data.occurredAt, '2026-10-30 23:30:00');
  assert.equal(app.requests[0].data.durationMinutes, 20);
  assert.equal(app.requests[0].data.reflection, '新感悟');
  assert.equal(queue.getPending().length, 0);
});

test('edit mirror accepts intentional clearing rather than restoring the old reflection', async () => {
  const records = [source({ experience: [], experienceEdited: true, updatedAt: UPDATED + 100 })];
  const app = harness({ records });
  const mirror = app.load('practiceMirror.js');
  mirror.beforeCloudMutation('meditationManager', { type: 'editMeditationRecord', data: {
    recordId: 'source-record', timestamp: OCCURRED,
    updates: { timestamp: OCCURRED, duration: 12, reflection: '' }
  } });
  await app.settle(mirror.acceptCloudSnapshot(records));
  assert.equal(app.requests[0].data.reflection, '');
});

test('late edit success after the 5-second timeout still independently synchronizes the verified mirror', async () => {
  let edit;
  const records = [source({ experience: [] })];
  const app = harness({ records, cloudCall(options) {
    if (options.data.type === 'editMeditationRecord') { edit = options; return true; }
    return false;
  } });
  const api = app.load('cloudApi.js');
  const pending = api.editMeditationRecord({ recordId: 'source-record', expectedOpenid: OWNER.openid,
    requestId: 'edit-one', updates: { timestamp: OCCURRED, duration: 20, reflection: '' } });
  const timedOut = await app.settle(pending);
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.code, 'CLOUD_TIMEOUT');
  assert.equal(app.requests.length, 0);
  records[0] = source({ duration: 20, experience: [], experienceEdited: true, updatedAt: UPDATED + 500 });
  edit.success({ result: { success: true, data: { recordId: 'source-record', editId: 'me_' + 'a'.repeat(64) } } });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].data.durationMinutes, 20);
  assert.equal(app.load('practiceQueue.js').getPending().length, 0);
});

test('unsafe or unconfirmed reflection checks never submit the edit operation', async () => {
  for (const check of [{ success: true, safe: false }, { success: false }, {}]) {
    const app = harness({ cloudCall(options) {
      if (options.name === 'contentSecCheck') { options.success({ result: check }); return true; }
      return false;
    } });
    const result = await app.load('cloudApi.js').editMeditationRecord({ recordId: 'source-record', requestId: 'edit-one',
      updates: { timestamp: OCCURRED, duration: 20, reflection: '需要检测的感悟' } });
    assert.equal(result.success, false);
    assert.equal(app.cloudRequests.filter(request => request.data.type === 'editMeditationRecord').length, 0);
  }
});
