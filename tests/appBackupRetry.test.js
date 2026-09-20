const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createApp({ retry = async () => ({ success: true, uploaded: 0, pending: 0 }) } = {}) {
  let app;
  const calls = { retries: [], listeners: [], warnings: [], initializations: 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: value => { app = value; },
    require(name) {
      assert.equal(name, './utils/checkin.js');
      return { syncWithCloud: (...args) => { calls.retries.push(args); return retry(...args); } };
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

test('opening the app and recovering network only read cloud records without uploading pending records', async () => {
  const { app, calls } = createApp();
  app.onLaunch();
  app.setupRecordRefresh();
  assert.equal(calls.initializations, 1);
  assert.equal(calls.listeners.length, 1, 'register the network observer only once');
  await app.onShow();
  assert.equal(calls.retries.length, 1);
  calls.listeners[0]({ isConnected: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.retries.length, 1);
  calls.listeners[0]({ isConnected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.retries.length, 2);
  assert.equal(calls.retries[0][0].uploadPending, false, 'opening the app must not upload pending records');
  assert.equal(calls.retries[1][0].uploadPending, false, 'network recovery must not upload pending records');
});

test('opening schedules the check asynchronously even when cloud synchronization remains pending', async () => {
  let finish;
  const remote = new Promise(resolve => { finish = resolve; });
  const { app, calls } = createApp({ retry: () => remote });
  const showing = app.onShow();
  assert.equal(calls.retries.length, 0, 'lifecycle returns before the background check starts');
  await Promise.resolve();
  assert.equal(calls.retries.length, 1);
  let completed = false;
  showing.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, 'cloud request can remain pending after the lifecycle has returned');
  finish({ success: true, uploaded: 1, pending: 0, refreshed: true });
  await showing;
});

test('cloud read failure is handled without breaking foreground lifecycle', async () => {
  const { app, calls } = createApp({ retry: async () => { throw new Error('网络不可用'); } });
  await app.onShow();
  assert.equal(calls.retries.length, 1);
  assert.equal(calls.warnings.length, 1);
});
