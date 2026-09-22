const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ network = 'wifi', detect, request } = {}) {
  const calls = { network: 0, cloud: [], toasts: [] };
  const timers = new Map();
  let nextTimer = 1;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/contentSec.js'), 'utf8'), {
    module, console: { error() {} },
    setTimeout(callback, ms) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      getNetworkType(options) {
        calls.network++;
        if (detect) return detect(options);
        options.success({ networkType: network });
      },
      cloud: { callFunction(options) {
        calls.cloud.push(options);
        return request ? request(options) : Promise.resolve({ result: { success: true, safe: true } });
      } },
      showToast(options) { calls.toasts.push(options); }
    }
  });
  return {
    contentSec: module.exports, calls, timers,
    timeout() {
      const active = [...timers.values()];
      timers.clear();
      active.forEach(timer => timer.callback());
    },
    check(text = '静坐体验', opts = {}) {
      return module.exports.checkText(text, 2, { allowOffline: true, timeoutMs: 1500, ...opts });
    }
  };
}

test('known offline text can be saved locally without any content request or loading UI', async () => {
  const app = harness({ network: 'none', request: () => { throw new Error('must not call'); } });
  assert.equal(await app.check(), true);
  assert.equal(app.calls.network, 1);
  assert.equal(app.calls.cloud.length, 0);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.calls.toasts, []);
});

test('one 1500ms deadline also bounds a network probe that never returns', async () => {
  let probe;
  const app = harness({ detect: options => { probe = options; } });
  let finished = false;
  const checking = app.check().then(result => { finished = true; return result; });
  await flush();
  assert.equal(finished, false);
  assert.equal([...app.timers.values()][0].ms, 1500);
  app.timeout();
  assert.equal(await checking, true);
  probe.success({ networkType: 'wifi' });
  await flush();
  assert.equal(app.calls.cloud.length, 0, 'a late probe cannot restart a completed check');
});

test('a hanging content request permits local persistence after the deadline and ignores a late rejection', async () => {
  let complete;
  const app = harness({ request: () => new Promise(resolve => { complete = resolve; }) });
  const checking = app.check();
  await flush();
  assert.equal(app.calls.cloud.length, 1);
  app.timeout();
  assert.equal(await checking, true);
  complete({ result: { success: true, safe: false, status: 'risky' } });
  await flush();
  assert.deepEqual(app.calls.toasts, [], 'the expired foreground check must not display a late error');
});

test('explicit online content rejection still blocks local submission and clears the deadline', async () => {
  const app = harness({ request: async () => ({ result: { success: true, safe: false, status: 'risky' } }) });
  assert.equal(await app.check(), false);
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.toasts[0].title, '所发布内容含违规信息');
  assert.equal(app.calls.cloud[0].data.content, '静坐体验');
});

test('network probe failure still checks available service; unavailable service permits only local saving', async () => {
  for (const request of [
    () => Promise.reject(new Error('offline')),
    () => { throw new Error('cloud not ready'); },
    async () => ({ result: { success: false, safe: false, status: 'error' } }),
    async () => undefined
  ]) {
    const app = harness({ detect: options => options.fail({ errMsg: 'unavailable' }), request });
    assert.equal(await app.check(), true);
    assert.equal(app.calls.cloud.length, 1);
    assert.equal(app.timers.size, 0);
    assert.deepEqual(app.calls.toasts, []);
  }
});

test('empty reflections skip both network detection and moderation', async () => {
  const app = harness();
  assert.equal(await app.check('   '), true);
  assert.equal(app.calls.network, 0);
  assert.equal(app.calls.cloud.length, 0);
  assert.equal(app.timers.size, 0);
});

test('offline allowance is opt-in and leaves other publishing entry points unchanged', async () => {
  const app = harness({ network: 'none', request: async () => ({ result: { success: true, safe: false } }) });
  assert.equal(await app.contentSec.checkText('团队名称', 2), false);
  assert.equal(app.calls.network, 0);
  assert.equal(app.calls.cloud.length, 1);
  assert.equal(app.calls.toasts[0].title, '所发布内容含违规信息');
});

test('ordinary publishing blocks moderation errors without reporting content violations', async () => {
  for (const request of [
    () => Promise.reject(new Error('offline')),
    () => { throw new Error('cloud not ready'); },
    async () => ({ result: { success: false, safe: false, status: 'error' } }),
    async () => ({ result: { success: true } }),
    async () => ({ result: { success: 'true', safe: 'true' } }),
    async () => ({ result: { success: false, safe: true } }),
    async () => undefined
  ]) {
    const app = harness({ request });
    assert.equal(await app.contentSec.checkText('团队名称', 2), false);
    assert.equal(app.calls.toasts.length, 1);
    assert.equal(app.calls.toasts[0].title, '内容安全检测暂不可用，请稍后重试');
  }
});

test('ordinary publishing accepts only explicit successful moderation', async () => {
  const app = harness({ request: async () => ({ result: { success: true, safe: true, status: 'pass' } }) });
  assert.equal(await app.contentSec.checkText('团队名称', 2), true);
  assert.equal(app.calls.toasts.length, 0);
});
