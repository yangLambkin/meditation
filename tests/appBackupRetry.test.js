const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({
  read = async () => ({ success: true, uploaded: 0, pending: 0 }),
  retryToday = async () => ({ success: true, uploaded: 0, pending: 0 })
} = {}) {
  let app;
  const calls = { reads: [], todayUploads: [], listeners: [], warnings: [], initializations: 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: value => { app = value; },
    require(name) {
      assert.equal(name, './utils/checkin.js');
      return {
        syncWithCloud: (...args) => { calls.reads.push(args); return read(...args); },
        retryTodayBackups: (...args) => { calls.todayUploads.push(args); return retryToday(...args); }
      };
    },
    wx: {
      cloud: { init() { calls.initializations++; } },
      onNetworkStatusChange(callback) { calls.listeners.push(callback); }
    },
    console: { log() {}, error() {}, warn: (...args) => calls.warnings.push(args) }
  });
  app.setupCacheStatus = () => {};
  app.testCloudEnvironment = () => {};
  app.setAudioOptions = () => {};
  return { app, calls };
}

test('opening the app reads cloud records and independently retries only today backups', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.setupRecordRefresh();
  assert.equal(calls.initializations, 1);
  assert.equal(calls.listeners.length, 1, 'register the network observer only once');
  await app.onShow();
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.todayUploads.length, 1, 'use the date-scoped upload entry point on foreground');
  assert.equal(calls.reads[0][0].uploadPending, false, 'the cloud refresh cannot drain historical pending records');
  await app.onShow();
  assert.equal(calls.todayUploads.length, 2, 'returning to the app starts another date-scoped check');
  assert.equal(calls.reads.length, 2);
});

test('network recovery refreshes cloud records without starting another today upload', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  await app.onShow();
  calls.listeners[0]({ isConnected: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.todayUploads.length, 1);
  calls.listeners[0]({ isConnected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.reads[1][0].uploadPending, false, 'network recovery must not upload pending records');
  assert.equal(calls.todayUploads.length, 1, 'connectivity alone does not authorize a new upload round');
});

test('opening starts today uploads asynchronously without waiting for a pending cloud read', async () => {
  let finish;
  const remote = new Promise(resolve => { finish = resolve; });
  const { app, calls } = createApp({ read: () => remote });
  const showing = app.onShow();
  assert.equal(calls.reads.length, 0, 'lifecycle returns before the background check starts');
  assert.equal(calls.todayUploads.length, 0);
  await Promise.resolve();
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.todayUploads.length, 1, 'a slow read must not delay today uploads');
  let completed = false;
  showing.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, 'cloud request can remain pending after the lifecycle has returned');
  finish({ success: true, uploaded: 1, pending: 0, refreshed: true });
  await showing;
});

test('cloud read failure is handled without breaking foreground lifecycle', async () => {
  const { app, calls } = createApp({ read: async () => { throw new Error('网络不可用'); } });
  await app.onShow();
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.todayUploads.length, 1, 'read failure must not prevent the independent upload check');
  assert.equal(calls.warnings.length, 1);
});

test('today upload rejection is handled without breaking foreground lifecycle or cloud reads', async () => {
  const { app, calls } = createApp({ retryToday: async () => { throw new Error('上传失败'); } });
  await app.onShow();
  assert.equal(calls.todayUploads.length, 1);
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0][0], /当天记录自动上传失败/);
});

test('synchronous today upload failures remain contained in the foreground lifecycle promise', async () => {
  const { app, calls } = createApp({ retryToday: () => { throw new Error('本地记录读取失败'); } });
  await app.onShow();
  assert.equal(calls.todayUploads.length, 1);
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.warnings.length, 1);
});
