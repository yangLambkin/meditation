const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const silentConsole = { log() {}, warn() {}, error() {} };
const clone = value => value === undefined ? value : structuredClone(value);

function load(filename, globals) {
  globals = { ...globals, wx: globals.wx && {
    getNetworkType: ({ success }) => success({ networkType: 'wifi' }), ...globals.wx
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram', filename), 'utf8'), {
    module, exports: module.exports, console: silentConsole, ...globals,
    require(name) {
      if (name === './uploadNetwork.js') return load('utils/uploadNetwork.js', globals);
      return globals.require(name);
    }
  }, { filename });
  return module.exports;
}

function harness({ call, timersEnabled = true } = {}) {
  const requests = [];
  const timers = new Map();
  let now = Date.parse('2026-09-20T12:00:00+08:00');
  let nextTimer = 1;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const clock = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const storage = new Map([['localUserId', 'local-timeout'], ['userOpenId', 'oz-timeout']]);
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    cloud: { callFunction(request) {
      requests.push(request);
      if (call) call(request);
    } }
  };
  const globals = { wx, Date: Clock, ...(timersEnabled ? clock : {}) };
  const api = load('utils/cloudApi.js', globals);
  return {
    api, globals, requests, timers, storage,
    get now() { return now; },
    elapse(milliseconds) { now += milliseconds; },
    async advance(milliseconds) {
      await flush();
      const end = now + milliseconds;
      while (true) {
        const timer = [...timers.entries()].filter(([, value]) => value.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!timer) break;
        now = Math.max(now, timer[1].due);
        timers.delete(timer[0]);
        timer[1].callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

test('an upload request with no callback rejects after three seconds and ignores late callbacks', async () => {
  const app = harness();
  const request = app.api.callCloudFunction('meditationManager', { type: 'recordMeditation' });
  const rejection = assert.rejects(request, error => error.code === 'CLOUD_TIMEOUT' &&
    error.message === '上传超时（3秒），请手动重试');
  assert.equal([...app.timers.values()][0].delay, 3000);
  await app.advance(2999);
  assert.equal(app.timers.size, 1);
  await app.advance(1);
  await rejection;
  assert.equal(app.timers.size, 0);
  app.requests[0].success({ result: { success: true } });
  app.requests[0].fail(new Error('late failure'));
  await assert.rejects(request, error => error.code === 'CLOUD_TIMEOUT');

  const retry = app.api.callCloudFunction('meditationManager', { type: 'recordMeditation' });
  const response = { result: { success: true, data: { recordId: 'retried' } } };
  app.requests[1].success(response);
  assert.strictEqual(await retry, response);
  assert.equal(app.timers.size, 0);
});

for (const [name, type] of [
  ['meditationManager', 'getAllRecords'], ['meditationManager', 'getUserStats'], ['contentSecCheck', 'text']
]) {
  test(`reads and independent text checks retain the five-second timeout (${name}/${type})`, async () => {
    const app = harness();
    const pending = app.api.callCloudFunction(name, { type });
    let settled = false;
    const rejection = assert.rejects(pending, error => error.code === 'CLOUD_TIMEOUT');
    pending.catch(() => { settled = true; });
    assert.equal([...app.timers.values()][0].delay, 5000);
    await app.advance(3000);
    assert.equal(settled, false);
    await app.advance(1999);
    assert.equal(settled, false);
    await app.advance(1);
    await rejection;
    assert.equal(app.timers.size, 0);
  });
}

test('a timely success clears its timer and cannot be replaced by a later failure', async () => {
  const app = harness();
  const pending = app.api.callCloudFunction('meditationManager', { type: 'getAllRecords' });
  const response = { result: { success: true, data: [] } };
  app.requests[0].success(response);
  app.requests[0].fail(new Error('late failure'));
  assert.strictEqual(await pending, response);
  assert.equal(app.timers.size, 0);
});

test('a network failure clears the timer and preserves the original error', async () => {
  const app = harness();
  const pending = app.api.callCloudFunction('meditationManager', { type: 'getUserStats' });
  assert.equal(app.timers.size, 1);
  const error = new Error('request:fail offline');
  app.requests[0].fail(error);
  await assert.rejects(pending, value => value === error);
  assert.equal(app.timers.size, 0);
});

test('a synchronous SDK failure clears its timer', async () => {
  const error = new Error('cloud unavailable');
  const app = harness({ call() { throw error; } });
  await assert.rejects(app.api.callCloudFunction('meditationManager', { type: 'recordMeditation' }), value => value === error);
  assert.equal(app.timers.size, 0);
});

test('a synchronous SDK success clears its timer', async () => {
  const response = { result: { success: true } };
  const app = harness({ call(request) { request.success(response); } });
  assert.strictEqual(await app.api.callCloudFunction('meditationManager', { type: 'recordMeditation' }), response);
  assert.equal(app.timers.size, 0);
});

test('environments without timer globals preserve the callback interface', async () => {
  const app = harness({ timersEnabled: false });
  const response = { result: { success: true } };
  const pending = app.api.callCloudFunction('meditationManager', { type: 'recordMeditation' });
  app.requests[0].success(response);
  assert.strictEqual(await pending, response);
});

for (const [name, type] of [
  ['bijingSync', 'sync'], ['otherFunction', 'getAllRecords'],
  ['meditationManager', 'deleteMeditationRecord'], ['meditationManager', 'getUserRecords'],
  ['contentSecCheck', 'imageSync']
]) {
  test(`unrelated cloud operations keep their original timeout behavior (${name}/${type})`, async () => {
    const app = harness();
    const pending = app.api.callCloudFunction(name, { type });
    assert.equal(app.timers.size, 0, 'unrelated cloud operations have no added deadline');
    const response = { result: { success: true } };
    app.requests[0].success(response);
    assert.strictEqual(await pending, response);
  });
}

test('background upload checks every nonempty text before sending the unchanged experience payload', async () => {
  const app = harness({ call(request) {
    request.success({ result: request.name === 'contentSecCheck'
      ? { success: true, safe: true }
      : { success: true, data: { recordId: 'checked-record' } } });
  } });
  const experience = [{ text: '本机保存的心得', uniqueId: 'first' }, '另一条心得', { text: '  ' }];
  const timestamp = app.now - 1000;
  const result = await app.api.recordMeditation(12, ['平静'], experience, timestamp, 'checked-local');
  assert.equal(result.success, true);
  assert.deepEqual(app.requests.map(request => request.name), ['contentSecCheck', 'contentSecCheck', 'meditationManager']);
  assert.deepEqual(clone(app.requests.slice(0, 2).map(request => request.data)), [
    { type: 'text', content: '本机保存的心得', scene: 2 },
    { type: 'text', content: '另一条心得', scene: 2 }
  ]);
  assert.deepEqual(app.requests[2].data.data.experience, experience);
  assert.equal(app.requests[2].data.data.timestamp, timestamp);
  assert.equal(app.requests[2].data.data.localId, 'checked-local');
  assert.equal(app.timers.size, 0);
});

test('an explicit content rejection stops the background upload without UI prompts', async () => {
  const app = harness({ call(request) { request.success({ result: { success: true, safe: false, status: 'risky' } }); } });
  const result = await app.api.recordMeditation(12, [], '违规心得', app.now - 1000, 'rejected-local');
  assert.equal(result.success, false);
  assert.equal(result.code, 'CONTENT_REJECTED');
  assert.deepEqual(app.requests.map(request => request.name), ['contentSecCheck']);
});

for (const response of [undefined, { success: false, safe: false, status: 'error' }, { success: true }, { success: false, safe: true }]) {
  test(`inconclusive content checks leave the record queued (${JSON.stringify(response)})`, async () => {
    const app = harness({ call(request) { request.success({ result: response }); } });
    const result = await app.api.recordMeditation(12, [], [{ text: '待检测心得' }], app.now - 1000, 'pending-local');
    assert.equal(result.success, false);
    assert.equal(result.code, 'CONTENT_CHECK_UNAVAILABLE');
    assert.deepEqual(app.requests.map(request => request.name), ['contentSecCheck']);
  });
}

test('a content-check timeout keeps the upload pending and ignores late approval', async () => {
  const app = harness();
  const pending = app.api.recordMeditation(12, [], '断网保存的心得', app.now - 1000, 'offline-text');
  await app.advance(3000);
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'CLOUD_TIMEOUT');
  assert.equal(result.error, '上传超时（3秒），请手动重试');
  app.requests[0].success({ result: { success: true, safe: true } });
  await flush();
  assert.deepEqual(app.requests.map(request => request.name), ['contentSecCheck']);
  assert.equal(app.timers.size, 0);
});

test('all text checks and the record write share a single three-second upload budget', async () => {
  const app = harness();
  const experience = [{ text: '第一条心得' }, { text: '第二条心得' }];
  const timestamp = app.now - 1000;
  const pending = app.api.recordMeditation(12, [], experience, timestamp, 'shared-deadline');
  await flush();
  assert.equal([...app.timers.values()][0].delay, 3000);
  app.elapse(1200);
  app.requests[0].success({ result: { success: true, safe: true } });
  await flush();
  assert.equal([...app.timers.values()][0].delay, 1800);
  app.elapse(1300);
  app.requests[1].success({ result: { success: true, safe: true } });
  await flush();
  assert.equal(app.requests[2].name, 'meditationManager');
  assert.equal([...app.timers.values()][0].delay, 500);
  assert.deepEqual(app.requests[2].data.data.experience, experience);
  assert.equal(app.requests[2].data.data.timestamp, timestamp);
  assert.equal(app.requests[2].data.data.localId, 'shared-deadline');
  let finished = false;
  pending.then(() => { finished = true; });
  await app.advance(499);
  assert.equal(finished, false);
  await app.advance(1);
  const result = await pending;
  assert.equal(result.code, 'CLOUD_TIMEOUT');
  assert.equal(result.error, '上传超时（3秒），请手动重试');
  assert.equal(app.timers.size, 0);
});

test('an earlier attempt deadline limits both text review and the subsequent write', async () => {
  const app = harness();
  const pending = app.api.recordMeditation(12, [], '排队的心得', app.now - 1000, 'short-budget',
    { uploadDeadlineAt: app.now + 1800 });
  await flush();
  assert.equal([...app.timers.values()][0].delay, 1800);
  app.elapse(800);
  app.requests[0].success({ result: { success: true, safe: true } });
  await flush();
  assert.equal(app.requests[1].name, 'meditationManager');
  assert.equal([...app.timers.values()][0].delay, 1000);
  await app.advance(1000);
  assert.equal((await pending).code, 'CLOUD_TIMEOUT');
});

test('an explicit later deadline cannot extend a single upload beyond three seconds', async () => {
  const app = harness();
  const pending = app.api.recordMeditation(12, [], [], app.now - 1000, 'capped-budget',
    { uploadDeadlineAt: app.now + 60000 });
  await flush();
  assert.equal([...app.timers.values()][0].delay, 3000);
  await app.advance(3000);
  assert.equal((await pending).code, 'CLOUD_TIMEOUT');
});

test('a new upload attempt receives a fresh three-second budget after a previous timeout', async () => {
  const app = harness();
  const timestamp = app.now - 1000;
  const first = app.api.recordMeditation(12, [], [], timestamp, 'fresh-budget');
  await app.advance(3000);
  assert.equal((await first).code, 'CLOUD_TIMEOUT');
  await app.advance(100);
  const second = app.api.recordMeditation(12, [], [], timestamp, 'fresh-budget');
  await flush();
  assert.equal([...app.timers.values()][0].delay, 3000);
  assert.deepEqual(app.requests[1].data, app.requests[0].data);
  await app.advance(2999);
  app.requests[1].success({ result: { success: true, data: { recordId: 'confirmed-on-second-attempt' } } });
  assert.equal((await second).success, true);
  app.requests[0].success({ result: { success: true, data: { recordId: 'late-first-response' } } });
  assert.equal(app.timers.size, 0);
});

for (const experience of [[], ['未审核心得']]) {
  test(`an expired attempt budget sends no request (${JSON.stringify(experience)})`, async () => {
    const app = harness();
    const result = await app.api.recordMeditation(12, [], experience, app.now - 1000, 'expired-budget',
      { uploadDeadlineAt: app.now });
    assert.equal(result.code, 'CLOUD_TIMEOUT');
    assert.equal(app.requests.length, 0);
    assert.equal(app.timers.size, 0);
  });
}

test('approval arriving at the deadline cannot start a write even before the timer callback runs', async () => {
  const app = harness();
  const pending = app.api.recordMeditation(12, [], '刚超时的心得', app.now - 1000, 'deadline-approval');
  await flush();
  app.elapse(3000);
  app.requests[0].success({ result: { success: true, safe: true } });
  assert.equal((await pending).code, 'CLOUD_TIMEOUT');
  assert.deepEqual(app.requests.map(request => request.name), ['contentSecCheck']);
  assert.equal(app.timers.size, 0);
});

test('a hung upload and independent cloud refresh release locks for an explicit manual retry', async () => {
  const app = harness();
  const dateUtil = load('utils/dateUtil.js', app.globals);
  const manager = load('utils/checkin.js', {
    ...app.globals,
    require(name) {
      if (name === './cloudApi.js') return app.api;
      if (name === './dateUtil.js') return dateUtil;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  manager.asyncCheckBadgeUnlock = () => {};
  const local = manager.recordCheckin(12, [], [], app.now - 1000, 'offline-timeout');
  assert.equal(local.success, true);
  const firstSync = manager.syncWithCloud({ uploadPending: true });
  await app.advance(12300);
  assert.equal(app.requests.length, 4, 'manual upload must finish without adding a cloud refresh wait');
  assert.equal((await firstSync).success, false);

  const stored = app.storage.get('meditation_checkin_local-timeout');
  const record = stored.dailyRecords[local.date].records[0];
  assert.equal(record.syncStatus, 'failed');
  assert.equal(record.localId, 'offline-timeout');
  assert.equal(record.syncErrorCode, 'CLOUD_TIMEOUT');
  const retry = manager.syncWithCloud({ uploadPending: true });
  await flush();
  assert.equal(app.requests.length, 5);
  for (const request of app.requests.slice(1)) {
    assert.deepEqual(request.data, app.requests[0].data, 'retry must use the saved idempotent payload');
  }
  app.requests[4].success({ result: { success: true, data: { recordId: 'saved-after-retry' } } });
  const result = await retry;
  assert.equal(result.success, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.pending, 0);
  const firstRefresh = manager.refreshFromCloud();
  assert.equal(app.requests[5].data.type, 'getAllRecords');
  await app.advance(5000);
  assert.equal(await firstRefresh, false);
  const nextRefresh = manager.refreshFromCloud();
  app.requests[6].success({ result: { success: true, data: [{ ...record, _id: 'saved-after-retry' }] } });
  assert.equal(await nextRefresh, true);
  app.requests[0].success({ result: { success: true, data: { recordId: 'late-first-response' } } });
  app.requests[5].success({ result: { success: true, data: [] } });
  await flush();
  assert.equal(manager.getDailyCheckinRecords(local.date)[0]._id, 'saved-after-retry');
  assert.equal(manager.getUserStats().totalCount, 1);
});
