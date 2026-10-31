const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const OWNER = { openid: 'oz-practice-owner', studentNumber: 'B1234', bindingVersion: 'binding-v1' };
const OCCURRED = Date.parse('2026-10-31T00:30:00+08:00');
const UPDATED = Date.parse('2026-10-31T00:31:00+08:00');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ storage = new Map(), records = [], request, cloudCall, failStorage = false } = {}) {
  let owner = clone(OWNER), now = UPDATED + 1000, timerId = 0;
  const timers = new Map(), cache = {}, requests = [], cloudRequests = [], waits = [];
  const config = { baseUrl: 'https://data.bijing.life', practicesEnabled: true, sittingMirrorEnabled: true };
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

test('ordinary create retries a lost response with exactly one identity and original time', async () => {
  const server = new Map();
  const app = harness({ request(options, index) {
    const key = options.header['Idempotency-Key'];
    if (!server.has(key)) server.set(key, clone(options.data));
    if (index === 1) options.fail({ errMsg: 'response lost after commit' });
    else options.success({ statusCode: 200, data: { success: true, data: { id: 'only-one-row' } } });
  } });
  const queue = app.load('practiceQueue.js');
  queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  await app.settle(queue.flush());
  assert.equal(server.size, 1);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[0].header['Idempotency-Key'], app.requests[1].header['Idempotency-Key']);
  assert.equal(app.requests[1].data.occurredAt, payload.occurredAt);
  assert.equal(app.requests[0].timeout, 10000);
  assert.equal(queue.getPending().length, 0);
  assert.deepEqual(app.waits, [1000]);
});

test('one round stops after three attempts with 1 second and 3 second retry gaps; restart resumes', async () => {
  const app = harness({ request(options) { options.fail({ errMsg: 'offline' }); } });
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueuePractice({ type: 'learning', operation: 'create', payload });
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 3);
  assert.deepEqual(app.waits, [1000, 3000]);
  assert.equal(queue.getPending()[0].attempts, 3);
  const reopened = harness({ storage: app.storage });
  await reopened.settle(reopened.load('practiceQueue.js').flush());
  assert.equal(reopened.requests[0].header['Idempotency-Key'], task.requestId);
  assert.equal(reopened.load('practiceQueue.js').getPending().length, 0);
});

test('unknown create followed by delete confirms its ID first and deletes that exact row', async () => {
  const app = harness({ request(options) { options.fail({ errMsg: 'response lost' }); } });
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  await app.settle(queue.flush());
  assert.throws(() => queue.cancel(task.id), { code: 'CANNOT_CANCEL' });
  queue.enqueuePractice({ type: 'walking', operation: 'delete', recordId: `local:${task.id}` });
  const reopened = harness({ storage: app.storage });
  await reopened.settle(reopened.load('practiceQueue.js').flush());
  assert.deepEqual(reopened.requests.map(options => options.method), ['POST', 'DELETE']);
  assert.match(reopened.requests[1].url, /\/data-record-1$/);
});

test('never-sent create can be cancelled without a remote delete', () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  const task = queue.enqueuePractice({ type: 'instant', operation: 'create', payload: { ...payload, count: 1 } });
  const cancellation = queue.enqueuePractice({ type: 'instant', operation: 'delete', recordId: `local:${task.id}` });
  assert.equal(cancellation.status, 'cancelled');
  assert.equal(queue.getPending().length, 0);
  assert.equal(app.requests.length, 0);
});

test('account, binding and feature changes pause old work and preserve it', async () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  app.owner({ ...OWNER, bindingVersion: 'new-version' });
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending().length, 0);
  assert.equal(queue.getPending({ allOwners: true }).length, 1);
  app.owner(OWNER);
  app.config.practicesEnabled = false;
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending().length, 1);
  app.config.practicesEnabled = true;
  await app.settle(queue.flush());
  assert.equal(queue.getPending().length, 0);
});

test('rate limits persist their retry deadline and validation errors stop blind retry', async () => {
  const app = harness({ request(options) { options.success({ statusCode: 429, header: { 'Retry-After': '30' },
    data: { success: false, code: 'RATE_LIMITED', error: '稍后重试' } }); } });
  const queue = app.load('practiceQueue.js');
  queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  await app.settle(queue.flush());
  await app.settle(queue.flush({ manual: true }));
  assert.equal(app.requests.length, 1);
  assert.equal(queue.getPending()[0].lastError.code, 'RATE_LIMITED');
});

test('storage failure prevents an ordinary write and cannot change original cloud save success', async () => {
  const app = harness({ failStorage: true });
  const queue = app.load('practiceQueue.js');
  assert.throws(() => queue.enqueuePractice({ type: 'walking', operation: 'create', payload }), { code: 'STORAGE_FAILED' });
  assert.equal(app.requests.length, 0);
  const saved = await app.load('cloudApi.js').callCloudFunction('meditationManager', { type: 'recordMeditation', data: source() });
  assert.equal(saved.result.success, true);
});

for (const operation of ['create', 'update', 'delete']) {
  test(`persisted original ${operation} intent recovers when cloud committed but its response was lost`, async () => {
    const record = source(), records = [record];
    const app = harness({ records, cloudCall(options) {
      if (options.data.type === 'getAllRecords') return false;
      assert.equal(app.load('practiceQueue.js').getPending()[0].status, 'waiting_source', 'intent precedes original cloud request');
      if (operation === 'update') { records[0].experience.push('新增体验'); records[0].updatedAt = UPDATED + 100; }
      if (operation === 'delete') records.splice(0);
      // No success callback: emulate exiting before the original confirmation reaches the client.
      return true;
    } });
    app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { '2026-10-30': { records: [record] } } } });
    const event = operation === 'create' ? { type: 'recordMeditation', data: { duration: 12, timestamp: OCCURRED, localId: 'local-source', experience: ['观察呼吸'] } } :
      operation === 'update' ? { type: 'updateMeditationRecord', recordId: String(OCCURRED), experience: '新增体验' } :
        { type: 'deleteMeditationRecord', data: { recordId: record._id, timestamp: OCCURRED, localId: 'local-source' } };
    const unacknowledged = app.load('cloudApi.js').callCloudFunction('meditationManager', event);
    unacknowledged.catch(() => {});
    assert.equal(app.requests.length, 0, 'no mirror before cloud confirmation');
    const reopened = harness({ storage: app.storage, records });
    await reopened.settle(reopened.load('practiceMirror.js').resume());
    assert.equal(reopened.requests.length, 1);
    assert.match(reopened.requests[0].url, /sources\/meditation\/source-record$/);
    assert.equal(reopened.requests[0].method, operation === 'delete' ? 'DELETE' : 'PUT');
    assert.equal(reopened.load('practiceQueue.js').getPending().length, 0);
    if (operation !== 'delete') {
      assert.equal(reopened.requests[0].data.recordDate, '2026-10-31', 'natural day must differ from original 02:00 business day');
      assert.equal(reopened.requests[0].data.occurredAt, '2026-10-31 00:30:00');
      assert.equal(reopened.requests[0].data.sourceVersion, String(UPDATED + (operation === 'update' ? 100 : 0)));
    }
  });
}

test('failed or incomplete cloud reads never prove deletion', async () => {
  const record = source(), app = harness({ records: [record] });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  app.load('practiceMirror.js').beforeCloudMutation('meditationManager', { type: 'deleteMeditationRecord', data: { recordId: record._id } });
  const reopened = harness({ storage: app.storage, cloudCall(options) {
    options.success({ result: { success: false, error: 'incomplete read' } }); return true;
  } });
  await reopened.settle(reopened.load('practiceMirror.js').resume());
  assert.equal(reopened.requests.length, 0);
  assert.equal(reopened.load('practiceQueue.js').getPending()[0].status, 'waiting_source');
});

test('old rows without a reliable source version remain waiting instead of inventing upload time', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined });
  const app = harness({ records: [record] });
  app.load('practiceMirror.js').beforeCloudMutation('meditationManager', { type: 'recordMeditation', data: {
    duration: record.duration, timestamp: record.timestamp, localId: record.localId } });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 0);
  assert.equal(app.load('practiceQueue.js').getPending()[0].lastError.code, 'SOURCE_VERSION_UNAVAILABLE');
});

test('a newer delete supersedes older queued source snapshots and late PUT cannot follow it locally', async () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  const create = queue.enqueueSourceIntent({ operation: 'create', identity: { recordId: 'source-record' }, snapshot: source() });
  queue.confirmSource(create.id, 'source-record', { ...payload, sourceVersion: String(UPDATED) });
  const deletion = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: 'source-record' }, snapshot: source() });
  queue.confirmSource(deletion.id, 'source-record', { sourceVersion: String(UPDATED) });
  await app.settle(queue.flush());
  assert.deepEqual(app.requests.map(options => options.method), ['DELETE']);
});

test('a read started before a delete intent cannot prove that deletion when its old response arrives late', async () => {
  let oldRead;
  const record = source(), app = harness({ cloudCall(options) {
    if (options.data.type === 'getAllRecords') oldRead = options;
    return true;
  } });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  const api = app.load('cloudApi.js');
  const reading = api.getAllRecords();
  api.callCloudFunction('meditationManager', { type: 'deleteMeditationRecord', data: { recordId: record._id } });
  oldRead.success({ result: { success: true, data: [] } });
  await reading;
  await tick();
  assert.equal(app.requests.length, 0);
  assert.equal(app.load('practiceQueue.js').getPending()[0].status, 'waiting_source');
});

test('an update acknowledgement cannot turn an older snapshot lacking the submitted reflection into a confirmation', async () => {
  const record = source(), app = harness({ records: [record] });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const task = mirror.beforeCloudMutation('meditationManager', { type: 'updateMeditationRecord', recordId: String(OCCURRED), experience: '新体验尚未包含' });
  queue.annotateSource(task.id, { cloudConfirmed: true });
  await app.settle(mirror.acceptCloudSnapshot([record]));
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending()[0].status, 'waiting_source');
});

test('deletion receipt uses its actual ownerOpenid, kind, request identity and server creation time', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined }), app = harness();
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: record._id }, snapshot: record });
  queue.annotateSource(task.id, { sourceId: record._id, deletionId: 'md-confirmed' });
  app.wx.cloud.database = () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: {
    kind: 'deletion_receipt', ownerOpenid: OWNER.openid, recordId: record._id,
    requestIdentity: ['recordId', record._id], createdAt: UPDATED + 500
  } }) }) }) });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'DELETE');
  assert.equal(app.requests[0].data.sourceVersion, String(UPDATED + 500));
});

test('a pending mirror rechecks the source and sends the latest snapshot with a fresh operation identity', async () => {
  const record = source({ updatedAt: UPDATED + 200, experience: ['最新体验'] }), app = harness({ records: [record] });
  const queue = app.load('practiceQueue.js');
  const original = queue.enqueueSourceIntent({ operation: 'create', identity: { recordId: record._id }, snapshot: source() });
  queue.confirmSource(original.id, record._id, { ...payload, sourceVersion: String(UPDATED) });
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'PUT');
  assert.equal(app.requests[0].data.reflection, '最新体验');
  assert.equal(app.requests[0].data.sourceVersion, String(UPDATED + 200));
  assert.notEqual(app.requests[0].header['Idempotency-Key'], original.requestId);
});

test('a server-confirmed ignored old mirror completes, while a same-version content conflict stays visible', async () => {
  const record = source(), app = harness({ records: [record], request(options, index) {
    options.success(index === 1 ? { statusCode: 200, data: { success: true, data: { record: null, deleted: true, ignored: true } } } :
      { statusCode: 409, data: { success: false, code: 'SOURCE_VERSION_CONFLICT', error: '版本冲突' } });
  } });
  const queue = app.load('practiceQueue.js');
  const first = queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: record._id }, snapshot: record });
  queue.confirmSource(first.id, record._id, { ...payload, sourceVersion: String(UPDATED) });
  await app.settle(queue.flush());
  assert.equal(queue.getPending().length, 0);
  const second = queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: record._id }, snapshot: record });
  queue.confirmSource(second.id, record._id, { ...payload, sourceVersion: String(UPDATED) });
  await app.settle(queue.flush());
  assert.equal(queue.getPending().length, 1);
  assert.equal(queue.getPending()[0].lastError.code, 'SOURCE_VERSION_CONFLICT');
});

test('preflight replaces a queued PUT by DELETE when a fresh complete source snapshot confirms absence', async () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  const original = queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: 'source-record' }, snapshot: source() });
  queue.confirmSource(original.id, 'source-record', { ...payload, sourceVersion: String(UPDATED) });
  await app.settle(queue.flush());
  assert.deepEqual(app.requests.map(options => options.method), ['DELETE']);
  assert.equal(queue.getPending().length, 0);
});

test('automatic cloud document IDs are resolved to confirmed experience text and never uploaded as reflection', async () => {
  const reference = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';
  const record = source({ experience: [reference] }), app = harness({ records: [record] });
  app.wx.cloud.database = () => ({ collection: collection => ({ doc: id => ({ get: async () => {
    assert.equal(collection, 'experience_records'); assert.equal(id, reference);
    return { data: { _id: reference, _openid: OWNER.openid, text: '云端体验正文' } };
  } }) }) });
  app.load('practiceMirror.js').beforeCloudMutation('meditationManager', { type: 'recordMeditation', data: {
    duration: record.duration, timestamp: record.timestamp, localId: record.localId, experience: [reference] } });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests[0].data.reflection, '云端体验正文');
  assert.equal(JSON.stringify(app.requests[0].data).includes(reference), false);
});

test('foreign-owner or malformed source snapshots never authorize a deletion', async () => {
  for (const records of [[source({ _openid: 'oz-other-owner' })], [null], [{}]]) {
    const app = harness({ records }), queue = app.load('practiceQueue.js');
    queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: 'source-record' }, snapshot: source() });
    await app.settle(app.load('practiceMirror.js').resume());
    assert.equal(app.requests.length, 0);
    assert.equal(queue.getPending()[0].status, 'waiting_source');
  }
});

test('a confirmed newer source version replaces older blocked PUTs while preserving delete intentions', () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  const old = queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: 'source-record' }, snapshot: source() });
  queue.confirmSource(old.id, 'source-record', { ...payload, sourceVersion: String(UPDATED) });
  const store = app.storage.get('practice_outbox_v1');
  store.tasks[0].status = 'blocked';
  app.storage.set('practice_outbox_v1', store);
  const deletion = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: 'source-record' }, snapshot: source() });
  const newer = queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: 'source-record' }, snapshot: source() });
  queue.confirmSource(newer.id, 'source-record', { ...payload, sourceVersion: String(UPDATED + 100) });
  assert.deepEqual(clone(queue.getPending().map(task => task.id)), [deletion.id, newer.id]);
});
