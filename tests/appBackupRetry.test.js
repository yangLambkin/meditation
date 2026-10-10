const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({
  read = async () => ({ success: true, uploaded: 0, pending: 0 }),
  retryAutomatic = async () => ({ success: true, uploaded: 0, pending: 0 })
} = {}) {
  let app;
  const calls = { reads: [], automaticUploads: [], listeners: [], warnings: [], initializations: 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: value => { app = value; },
    require(name) {
      assert.equal(name, './utils/checkin.js');
      return {
        syncWithCloud: (...args) => { calls.reads.push(args); return read(...args); },
        retryAutomaticBackups: (...args) => { calls.automaticUploads.push(args); return retryAutomatic(...args); }
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

test('opening the app reads cloud records and independently retries all dates of pending backups', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.setupRecordRefresh();
  assert.equal(calls.initializations, 1);
  assert.equal(calls.listeners.length, 1, 'register the network observer only once');
  await app.onShow();
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.automaticUploads.length, 1, 'use the automatic upload entry point on foreground');
  assert.equal(calls.reads[0][0].uploadPending, false, 'the cloud refresh cannot drain historical pending records');
  await app.onShow();
  assert.equal(calls.automaticUploads.length, 2, 'returning to the app starts another automatic check');
  assert.equal(calls.reads.length, 2);
});

test('network recovery independently refreshes and starts a fresh automatic upload', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  await app.onShow();
  calls.listeners[0]({ isConnected: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.automaticUploads.length, 1);
  calls.listeners[0]({ isConnected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.reads[1][0].uploadPending, false, 'the independent read request stays read-only');
  assert.equal(calls.automaticUploads.length, 2, 'connectivity recovery starts a fresh upload round');
});

test('opening starts pending uploads asynchronously without waiting for a pending cloud read', async () => {
  let finish;
  const remote = new Promise(resolve => { finish = resolve; });
  const { app, calls } = createApp({ read: () => remote });
  const showing = app.onShow();
  assert.equal(calls.reads.length, 0, 'lifecycle returns before the background check starts');
  assert.equal(calls.automaticUploads.length, 0);
  await Promise.resolve();
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.automaticUploads.length, 1, 'a slow read must not delay pending uploads');
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
  assert.equal(calls.automaticUploads.length, 1, 'read failure must not prevent the independent upload check');
  assert.equal(calls.warnings.length, 1);
});

test('pending upload rejection is handled without breaking foreground lifecycle or cloud reads', async () => {
  const { app, calls } = createApp({ retryAutomatic: async () => { throw new Error('上传失败'); } });
  await app.onShow();
  assert.equal(calls.automaticUploads.length, 1);
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0][0], /本机记录自动上传失败/);
});

test('synchronous pending upload failures remain contained in the foreground lifecycle promise', async () => {
  const { app, calls } = createApp({ retryAutomatic: () => { throw new Error('本地记录读取失败'); } });
  await app.onShow();
  assert.equal(calls.automaticUploads.length, 1);
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.warnings.length, 1);
});
