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

test('a successful original delete immediately mirrors without a source version or another source read', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined });
  const app = harness({ records: [record], cloudCall(options) {
    if (options.data.type === 'deleteMeditationRecord') {
      options.success({ result: { success: true, data: { recordId: record._id, deletionId: DELETION_ID } } });
      return true;
    }
    if (options.data.type === 'getAllRecords') {
      options.success({ result: { success: false, error: 'source read unavailable after deletion' } });
      return true;
    }
    throw new Error(`unexpected cloud operation: ${options.data.type}`);
  } });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  let clientDatabaseReads = 0;
  app.wx.cloud.database = () => {
    clientDatabaseReads++;
    throw new Error(`document.get:fail cannot find document with _id ${DELETION_ID}, please make sure that the document exists and you have the corresponding access permission`);
  };
  const result = await app.load('cloudApi.js').callCloudFunction('meditationManager', {
    type: 'deleteMeditationRecord', data: { recordId: record._id, localId: record.localId, timestamp: record.timestamp }
  });
  assert.equal(result.result.success, true);
  await app.settle(app.load('practiceQueue.js').flush());
  assert.equal(clientDatabaseReads, 0);
  assert.deepEqual(app.cloudRequests.map(options => options.data.type), ['deleteMeditationRecord']);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'DELETE');
  assert.match(app.requests[0].url, /sources\/meditation\/source-record$/);
  assert.deepEqual(clone(app.requests[0].data), { operationId: app.requests[0].header['Idempotency-Key'] });
  assert.equal(app.load('practiceQueue.js').getPending().length, 0);
});

test('a complete source snapshot confirms a versionless delete without accessing deletion receipts', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined }), app = harness();
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: record._id }, snapshot: record });
  app.wx.cloud.database = () => { throw new Error('deletion mirror must not read a private receipt'); };
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'DELETE');
  assert.deepEqual(clone(app.requests[0].data), { operationId: task.requestId });
  assert.deepEqual(app.cloudRequests.map(options => options.data.type), ['getAllRecords']);
  assert.equal(queue.getPending().length, 0);
});

test('a versionless delete rejected by the old production API recovers manually after its deployment with the original identity', async () => {
  const validationMessage = 'sourceVersion 须为可靠的源更新时间毫秒数字字符串，不能晚于当前时间';
  const record = source({ updatedAt: undefined, createdAt: undefined });
  const app = harness({ request(options) {
    options.success({ statusCode: 400, data: { success: false, message: validationMessage } });
  } });
  let privateReads = 0;
  app.wx.cloud.database = () => { privateReads++; throw new Error('private deletion receipt must not be read'); };
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const task = mirror.beforeCloudMutation('meditationManager', {
    type: 'deleteMeditationRecord', data: { recordId: record._id, localId: record.localId, timestamp: record.timestamp }
  });
  mirror.observeCloudResult(task, { result: { success: true, data: { recordId: record._id } } });
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 1);
  const original = app.requests[0], pending = queue.getPending()[0];
  assert.equal(original.url, `https://data.bijing.life/api/openapi/practices/sitting/sources/meditation/${record._id}`);
  assert.equal(original.method, 'DELETE');
  assert.deepEqual(clone(original.data), { operationId: task.requestId });
  assert.equal(pending.status, 'blocked');
  assert.equal(pending.lastError.code, 'HTTP_400');
  assert.equal(pending.lastError.message, validationMessage);
  assert.equal(pending.sourceId, record._id);
  assert.equal(app.cloudRequests.length, 0);

  const reopened = harness({ storage: app.storage, request(options) {
    options.success({ statusCode: 200, data: { success: true, data: { deleted: true } } });
  } });
  reopened.wx.cloud.database = () => { privateReads++; throw new Error('private deletion receipt must not be read'); };
  const reopenedQueue = reopened.load('practiceQueue.js');
  await reopened.settle(reopened.load('practiceMirror.js').resume());
  assert.equal(reopened.requests.length, 0, 'automatic recovery does not blindly retry validation failures');
  assert.equal(reopenedQueue.getPending()[0].status, 'blocked');
  await reopened.settle(reopenedQueue.flush({ manual: true }));
  assert.equal(reopened.requests.length, 1);
  const retried = reopened.requests[0];
  assert.equal(retried.url, original.url);
  assert.equal(retried.method, original.method);
  assert.equal(retried.header['Idempotency-Key'], task.requestId);
  assert.equal(retried.header['Idempotency-Key'], original.header['Idempotency-Key']);
  assert.deepEqual(clone(retried.data), clone(original.data));
  assert.equal(retried.data.operationId, retried.header['Idempotency-Key']);
  assert.equal(reopened.cloudRequests.length, 0, 'confirmed deletion does not reread cloud records');
  assert.equal(privateReads, 0);
  assert.equal(reopenedQueue.getPending().length, 0);
});

test('a persisted delete with the old private-receipt error recovers after restart with its original request identity', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined }), app = harness();
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: record._id }, snapshot: record });
  queue.annotateSource(task.id, { cloudConfirmed: true, sourceId: record._id, deletionId: DELETION_ID });
  queue.markSourceError(task.id, 'SOURCE_CONFIRMATION_FAILED', `document.get:fail cannot find document with _id ${DELETION_ID}`);
  const reopened = harness({ storage: app.storage });
  reopened.wx.cloud.database = () => { throw new Error('private receipt cannot be read by the client'); };
  await reopened.settle(reopened.load('practiceMirror.js').resume());
  assert.equal(reopened.requests.length, 1);
  assert.equal(reopened.requests[0].method, 'DELETE');
  assert.equal(reopened.requests[0].header['Idempotency-Key'], task.requestId);
  assert.deepEqual(clone(reopened.requests[0].data), { operationId: task.requestId });
  assert.deepEqual(reopened.cloudRequests.map(options => options.data.type), ['getAllRecords']);
  assert.equal(reopened.load('practiceQueue.js').getPending().length, 0);
});

test('a late original delete acknowledgement preserves the version already sent with its idempotency key', async () => {
  let deletion, firstPayload, available = false;
  const record = source({ updatedAt: undefined, createdAt: undefined }), records = [record];
  const app = harness({ records, cloudCall(options) {
    if (options.data.type === 'deleteMeditationRecord') { deletion = options; return true; }
    return false;
  }, request(options) {
    const body = JSON.stringify(options.data);
    if (!firstPayload) firstPayload = body;
    if (!available) options.fail({ errMsg: 'response lost after remote commit' });
    else options.success(body === firstPayload
      ? { statusCode: 200, data: { success: true, data: { deleted: true } } }
      : { statusCode: 409, data: { success: false, code: 'REQUEST_ID_REUSED', error: 'same key different payload' } });
  } });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const original = app.load('cloudApi.js').callCloudFunction('meditationManager', {
    type: 'deleteMeditationRecord', data: { recordId: record._id }
  });
  const task = queue.getPending()[0];
  records[0].updatedAt = UPDATED + 500;
  await app.settle(mirror.acceptCloudSnapshot(records));
  records.splice(0);
  await app.settle(mirror.acceptCloudSnapshot([]));
  assert.equal(app.requests[0].data.sourceVersion, String(UPDATED + 500));
  assert.equal(queue.getPending().length, 1);
  available = true;
  deletion.success({ result: { success: true, data: { recordId: record._id } } });
  await original;
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 4);
  assert.ok(app.requests.every(options => options.header['Idempotency-Key'] === task.requestId));
  assert.ok(app.requests.every(options => JSON.stringify(options.data) === firstPayload));
  assert.equal(queue.getPending().length, 0);
});

test('a repeated delete acknowledgement cannot add a source version after a versionless DELETE was sent', async () => {
  let firstPayload, available = false;
  const app = harness({ request(options) {
    const body = JSON.stringify(options.data);
    if (!firstPayload) firstPayload = body;
    if (!available) options.fail({ errMsg: 'response lost after remote commit' });
    else options.success(body === firstPayload
      ? { statusCode: 200, data: { success: true, data: { deleted: true } } }
      : { statusCode: 409, data: { success: false, code: 'REQUEST_ID_REUSED', error: 'same key different payload' } });
  } });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: 'source-record' },
    snapshot: source({ updatedAt: undefined, createdAt: undefined }) });
  mirror.observeCloudResult(task, { result: { success: true, data: { recordId: 'source-record' } } });
  await app.settle(queue.flush());
  assert.deepEqual(clone(app.requests[0].data), { operationId: task.requestId });
  // A source read already in flight can enrich the stored snapshot after sending.
  queue.annotateSource(task.id, { snapshot: source({ updatedAt: UPDATED + 500 }) });
  const repeated = mirror.beforeCloudMutation('meditationManager', {
    type: 'deleteMeditationRecord', data: { recordId: 'source-record' }
  });
  assert.equal(repeated.id, task.id);
  available = true;
  mirror.observeCloudResult(repeated, { result: { success: true, data: { recordId: 'source-record' } } });
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 4);
  assert.ok(app.requests.every(options => options.header['Idempotency-Key'] === task.requestId));
  assert.ok(app.requests.every(options => JSON.stringify(options.data) === firstPayload));
  assert.equal(queue.getPending().length, 0);
});

test('an unconfirmed deletion whose source still exists remains waiting instead of deleting its mirror', async () => {
  const record = source({ updatedAt: undefined, createdAt: undefined }), app = harness({ records: [record] });
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: record._id }, snapshot: record });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending()[0].id, task.id);
  assert.equal(queue.getPending()[0].status, 'waiting_source');
});

test('failed original deletes and successful acknowledgements for another source never authorize a mirror delete', async () => {
  const outcomes = [
    { success: false, code: 'DELETE_FAILED', error: 'delete unavailable' },
    { success: true, data: { recordId: 'another-source' } },
    { success: true, data: {} }
  ];
  for (const outcome of outcomes) {
    const record = source({ updatedAt: undefined, createdAt: undefined });
    const app = harness({ records: [record], cloudCall(options) {
      if (options.data.type === 'deleteMeditationRecord') {
        options.success({ result: outcome });
        return true;
      }
      if (options.data.type === 'getAllRecords') {
        options.success({ result: { success: false, error: 'source confirmation unavailable' } });
        return true;
      }
      throw new Error(`unexpected cloud operation: ${options.data.type}`);
    } });
    await app.load('cloudApi.js').callCloudFunction('meditationManager', {
      type: 'deleteMeditationRecord', data: { recordId: record._id }
    });
    await app.settle(app.load('practiceMirror.js').resume());
    assert.equal(app.requests.length, 0, JSON.stringify(outcome));
    const pending = app.load('practiceQueue.js').getPending()[0];
    assert.equal(pending.sourceId, record._id, JSON.stringify(outcome));
    assert.equal(pending.status, 'waiting_source', JSON.stringify(outcome));
  }
});

test('unknown delete outcomes require a complete valid source snapshot before sending a mirror delete', async () => {
  const snapshots = [
    { success: false, error: 'read unavailable' },
    { success: true, data: null },
    { success: true, data: 'incomplete response' },
    { success: true, data: [{}] },
    { success: true, data: [null] },
    { success: true, data: [source({ _openid: 'foreign-owner' })] }
  ];
  for (const snapshot of snapshots) {
    const app = harness({ cloudCall(options) {
      if (options.data.type !== 'getAllRecords') throw new Error(`unexpected cloud operation: ${options.data.type}`);
      options.success({ result: snapshot });
      return true;
    } });
    const queue = app.load('practiceQueue.js');
    const task = queue.enqueueSourceIntent({ operation: 'delete', identity: { recordId: 'source-record' },
      snapshot: source({ updatedAt: undefined, createdAt: undefined }) });
    await app.settle(app.load('practiceMirror.js').resume());
    assert.equal(app.requests.length, 0, JSON.stringify(snapshot));
    assert.equal(queue.getPending()[0].id, task.id);
    assert.equal(queue.getPending()[0].status, 'waiting_source', JSON.stringify(snapshot));
  }
});

test('a complete snapshot cannot delete a mirror before its cloud source ID is known', async () => {
  const app = harness(), queue = app.load('practiceQueue.js');
  queue.enqueueSourceIntent({ operation: 'delete', identity: { localId: 'not-yet-backed-up' }, snapshot: {} });
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending()[0].status, 'waiting_source');
});

test('a late successful delete after switching accounts preserves the original owner and sends only after switching back', async () => {
  let deletion;
  const record = source({ updatedAt: undefined, createdAt: undefined });
  const app = harness({ cloudCall(options) {
    if (options.data.type === 'deleteMeditationRecord') {
      deletion = options;
      return true;
    }
    if (options.data.type === 'getAllRecords') {
      options.success({ result: { success: false, error: 'source read unavailable' } });
      return true;
    }
    throw new Error(`unexpected cloud operation: ${options.data.type}`);
  } });
  const saving = app.load('cloudApi.js').callCloudFunction('meditationManager', {
    type: 'deleteMeditationRecord', data: { recordId: record._id }
  });
  const queue = app.load('practiceQueue.js'), original = queue.getPending()[0];
  app.owner({ openid: 'other-wechat', studentNumber: 'OTHER', bindingVersion: 'other-binding' });
  deletion.success({ result: { success: true, data: { recordId: record._id } } });
  await saving;
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 0);
  const preserved = queue.getPending({ allOwners: true })[0];
  assert.equal(preserved.owner.openid, OWNER.openid);
  assert.equal(preserved.sourceId, record._id);
  assert.equal(preserved.requestId, original.requestId);
  app.owner(OWNER);
  await app.settle(app.load('practiceMirror.js').resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'DELETE');
  assert.equal(app.requests[0].header['Idempotency-Key'], original.requestId);
  assert.equal(app.requests[0].header['X-Expected-Student-Number'], OWNER.studentNumber);
  assert.equal(queue.getPending().length, 0);
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

test('an undeployed HTML route pauses once and resumes automatically after deployment with the same identity', async () => {
  let deployed = false;
  const app = harness({ request(options) {
    options.success(deployed ? { statusCode: 200, data: { success: true, data: { id: 'deployed-record' } } } :
      { statusCode: 404, data: '<html>Not Found</html>' });
  } });
  const queue = app.load('practiceQueue.js');
  const task = queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 1);
  assert.equal(queue.getPending()[0].status, 'paused');
  assert.equal(queue.getPending()[0].lastError.code, 'API_UNAVAILABLE');
  deployed = true;
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].header['Idempotency-Key'], task.requestId);
  assert.equal(queue.getPending().length, 0);
});

test('a real OpenAPI record-not-found response stays blocked instead of being treated as deployment recovery', async () => {
  const app = harness({ request(options) {
    options.success({ statusCode: 404, data: { success: false, message: '记录不存在' } });
  } });
  const queue = app.load('practiceQueue.js');
  queue.enqueuePractice({ type: 'walking', operation: 'delete', recordId: 'gone-record' });
  await app.settle(queue.flush());
  await app.settle(queue.flush());
  assert.equal(app.requests.length, 1);
  assert.equal(queue.getPending()[0].status, 'blocked');
  assert.equal(queue.getPending()[0].lastError.code, 'HTTP_404');
});

test('repeating an unconfirmed delete reuses its persisted identity and sends only one deletion after recovery', async () => {
  const app = harness({ request(options) { options.fail({ errMsg: 'response lost' }); } });
  const queue = app.load('practiceQueue.js');
  const first = queue.enqueuePractice({ type: 'walking', operation: 'delete', recordId: 'same-record', requestId: 'delete-one' });
  await app.settle(queue.flush());
  const repeated = queue.enqueuePractice({ type: 'walking', operation: 'delete', recordId: 'same-record', requestId: 'delete-two' });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.requestId, first.requestId);
  assert.equal(queue.getPending().length, 1);
  const reopened = harness({ storage: app.storage });
  await reopened.settle(reopened.load('practiceQueue.js').flush());
  assert.equal(reopened.requests.length, 1);
  assert.equal(reopened.requests[0].method, 'DELETE');
  assert.equal(reopened.requests[0].header['Idempotency-Key'], 'delete-one');
  assert.equal(reopened.load('practiceQueue.js').getPending().length, 0);
});

test('an unresolved old source mutation does not block a later verified full snapshot of the same source', async () => {
  const record = source({ experience: ['已确认的新体验'], updatedAt: UPDATED + 200 });
  const app = harness({ records: [record] });
  app.storage.set('meditation_checkin_practice-local', { checkinRecords: { dailyRecords: { x: { records: [record] } } } });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const earlier = mirror.beforeCloudMutation('meditationManager', { type: 'updateMeditationRecord', recordId: String(OCCURRED), experience: '未确认的旧体验' });
  mirror.beforeCloudMutation('meditationManager', { type: 'updateMeditationRecord', recordId: String(OCCURRED), experience: '已确认的新体验' });
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].data.reflection, '已确认的新体验');
  assert.equal(queue.getPending().length, 1);
  assert.equal(queue.getPending()[0].id, earlier.id);
  assert.equal(queue.getPending()[0].status, 'waiting_source');
});

test('a recovery trigger during an older source read performs a new round for newly persisted intentions', async () => {
  let firstRead;
  const initial = source(), latest = source({ _id: 'new-source', localId: 'new-local', timestamp: OCCURRED + 1 });
  const app = harness({ records: [initial, latest], cloudCall(options) {
    if (options.data.type === 'getAllRecords' && !firstRead) { firstRead = options; return true; }
    return false;
  } });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  mirror.beforeCloudMutation('meditationManager', { type: 'recordMeditation', data: initial });
  const recovering = mirror.resume();
  await tick();
  assert.ok(firstRead);
  mirror.beforeCloudMutation('meditationManager', { type: 'recordMeditation', data: latest });
  const secondTrigger = mirror.resume();
  firstRead.success({ result: { success: true, data: [initial] } });
  await app.settle(recovering);
  await secondTrigger;
  assert.deepEqual(app.requests.map(options => options.url.split('/').pop()).sort(), ['new-source', 'source-record']);
  assert.equal(queue.getPending().length, 0);
});

test('temporary service-token rejection pauses without asking the locally bound user to log into data', async () => {
  const app = harness({ request(options) {
    options.success({ statusCode: 401, data: { success: false, message: '未登录或登录已过期' } });
  } });
  const queue = app.load('practiceQueue.js');
  queue.enqueuePractice({ type: 'walking', operation: 'create', payload });
  await app.settle(queue.flush());
  const task = queue.getPending()[0];
  assert.equal(task.status, 'paused');
  assert.equal(task.lastError.code, 'AUTH_UNAVAILABLE');
  assert.match(task.lastError.message, /功课服务暂时无法连接/);
  assert.doesNotMatch(task.lastError.message, /登录|授权/);
});

test('a late cloud save acknowledgement after the original timeout still recovers its mirror independently', async () => {
  let upload;
  const record = source(), app = harness({ records: [record], cloudCall(options) {
    if (options.data.type === 'recordMeditation') { upload = options; return true; }
    return false;
  } });
  const api = app.load('cloudApi.js'), mirror = app.load('practiceMirror.js');
  await assert.rejects(app.settle(api.callCloudFunction('meditationManager', { type: 'recordMeditation', data: record })), { code: 'CLOUD_TIMEOUT' });
  assert.equal(app.requests.length, 0);
  upload.success({ result: { success: true, data: { recordId: record._id } } });
  await tick();
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.load('practiceQueue.js').getPending().length, 0);
});

test('a cloud acknowledgement after switching account keeps the original mirror owner until that account returns', async () => {
  let upload;
  const record = source(), app = harness({ records: [record], cloudCall(options) {
    if (options.data.type === 'recordMeditation') { upload = options; return true; }
    return false;
  } });
  const api = app.load('cloudApi.js'), mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  const saving = api.callCloudFunction('meditationManager', { type: 'recordMeditation', data: record });
  app.owner({ openid: 'other-wechat', studentNumber: 'OTHER', bindingVersion: 'other-binding' });
  upload.success({ result: { success: true, data: { recordId: record._id } } });
  await saving;
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending({ allOwners: true })[0].owner.openid, OWNER.openid);
  app.owner(OWNER);
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].header['X-Expected-Student-Number'], OWNER.studentNumber);
  assert.equal(queue.getPending().length, 0);
});

test('hung source reflection reads release recovery and ignore late results so a later retry can complete', async () => {
  const reference = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';
  const record = source({ experience: [reference] }), app = harness({ records: [record] });
  const unresolved = [];
  let available = false;
  app.wx.cloud.database = () => ({ collection: () => ({ doc: () => ({ get: () => available
    ? Promise.resolve({ data: { _openid: OWNER.openid, text: '恢复后的云端体验' } })
    : new Promise(resolve => unresolved.push(resolve)) }) }) });
  const mirror = app.load('practiceMirror.js'), queue = app.load('practiceQueue.js');
  mirror.beforeCloudMutation('meditationManager', { type: 'recordMeditation', data: record });
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 0);
  assert.equal(queue.getPending()[0].lastError.code, 'SOURCE_READ_TIMEOUT');
  unresolved.forEach(resolve => resolve({ data: { _openid: OWNER.openid, text: '迟到的旧正文' } }));
  await tick();
  assert.equal(app.requests.length, 0);
  available = true;
  await app.settle(mirror.resume());
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].data.reflection, '恢复后的云端体验');
  assert.equal(queue.getPending().length, 0);
});
