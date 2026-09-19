const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DAY = 24 * 60 * 60 * 1000;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const success = content => ({ result: { success: true, data: { _id: content, content } } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ time = '2026-09-19T12:00:00+08:00', cloud, storageUnavailable = false } = {}) {
  let now = Date.parse(time);
  let timerId = 0;
  const timers = new Map();
  const storage = new Map();
  const calls = [];
  const writes = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const wx = {
    getStorageSync(key) {
      if (storageUnavailable) throw new Error('storage unavailable');
      return clone(storage.get(key));
    },
    setStorageSync(key, value) {
      if (storageUnavailable) throw new Error('storage unavailable');
      writes.push(clone(value));
      storage.set(key, clone(value));
    },
    cloud: {
      callFunction(options) {
        calls.push(clone(options));
        return cloud ? cloud(calls.length) : Promise.resolve(success(`金句 ${calls.length}`));
      }
    }
  };
  function load(name = 'dailyWisdom.js') {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, wx, Date: ClockDate,
      require: dependency => load(dependency),
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, at: now + delay });
        return id;
      },
      clearTimeout: id => timers.delete(id)
    }, { filename: name });
    return module.exports;
  }
  return {
    api: load(), load, storage, calls, writes, timers,
    setTime(time) { now = typeof time === 'number' ? time : Date.parse(time); },
    async advanceTo(time) {
      this.setTime(time);
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await flush();
    }
  };
}

test('concurrent pages share one request and the first successful daily quote', async () => {
  const response = deferred();
  const h = harness({ cloud: () => response.promise });
  const home = h.api.getDailyWisdom();
  const share = h.api.getDailyWisdom();
  await flush();
  assert.deepEqual(h.calls, [{ name: 'getRandomWisdom' }]);
  response.resolve(success('  同日金句  '));
  const expected = { day: '2026-09-19', content: '同日金句' };
  assert.deepEqual(clone(await home), expected);
  assert.deepEqual(clone(await share), expected);
  assert.deepEqual(clone(await h.api.getDailyWisdom()), expected);
  assert.deepEqual(h.writes, [expected]);
  assert.equal(h.calls.length, 1);
});

test('reopening restores persistent cache through the next calendar day until 04:00', async () => {
  const h = harness();
  const quote = clone(await h.api.getDailyWisdom());
  h.setTime('2026-09-20T03:59:59.999+08:00');
  assert.deepEqual(clone(await h.load().getDailyWisdom()), quote);
  assert.equal(h.calls.length, 1);
});

for (const [boundary, before, after] of [
  ['2026-09-19', '2026-09-18', '2026-09-19'],
  ['2026-10-01', '2026-09-30', '2026-10-01'],
  ['2026-01-01', '2025-12-31', '2026-01-01'],
  ['2024-03-01', '2024-02-29', '2024-03-01']
]) {
  test(`quote changes exactly at Beijing 04:00 on ${boundary}`, async () => {
    const h = harness({ time: `${boundary}T03:59:59.999+08:00` });
    assert.deepEqual(clone(await h.api.getDailyWisdom()), { day: before, content: '金句 1' });
    h.setTime(`${boundary}T04:00:00+08:00`);
    assert.deepEqual(clone(await h.api.getDailyWisdom()), { day: after, content: '金句 2' });
    assert.equal(h.calls.length, 2);
  });
}

test('expired or malformed persisted values do not become the current quote', async () => {
  const h = harness();
  for (const invalid of [
    { day: '2026-09-18', content: '昨天' },
    { day: '2026-09-19', content: '   ' },
    { day: '2026-09-19', content: 7 },
    'broken'
  ]) {
    h.storage.set('dailyWisdom', invalid);
    const result = await h.load().getDailyWisdom();
    assert.equal(result.content, `金句 ${h.calls.length}`);
    assert.equal(result.day, '2026-09-19');
  }
  assert.equal(h.calls.length, 4);
});

test('an old request finishing across 04:00 fetches the new day before returning', async () => {
  const oldResponse = deferred();
  const h = harness({ time: '2026-09-19T03:59:59+08:00', cloud: call =>
    call === 1 ? oldResponse.promise : Promise.resolve(success('新日金句')) });
  const result = h.api.getDailyWisdom();
  await flush();
  h.setTime('2026-09-19T04:00:00+08:00');
  oldResponse.resolve(success('过期金句'));
  assert.deepEqual(clone(await result), { day: '2026-09-19', content: '新日金句' });
  assert.deepEqual(h.writes, [{ day: '2026-09-19', content: '新日金句' }]);
  assert.equal(h.calls.length, 2);
});

test('a late old response cannot overwrite an already completed new-day request', async () => {
  const oldResponse = deferred();
  const h = harness({ time: '2026-09-19T03:59:59+08:00', cloud: call =>
    call === 1 ? oldResponse.promise : Promise.resolve(success('新日金句')) });
  const oldRequest = h.api.getDailyWisdom();
  await flush();
  h.setTime('2026-09-19T04:00:00+08:00');
  const current = clone(await h.api.getDailyWisdom());
  oldResponse.resolve(success('过期金句'));
  assert.deepEqual(clone(await oldRequest), current);
  assert.deepEqual(h.writes, [current]);
  assert.equal(h.calls.length, 2);
});

for (const [name, failure] of [
  ['rejection', () => Promise.reject(new Error('offline'))],
  ['synchronous SDK error', () => { throw new Error('SDK not ready'); }],
  ['unsuccessful result', () => ({ result: { success: false } })],
  ['missing data', () => ({ result: { success: true, data: null } })],
  ['empty content', () => success('  ')],
  ['cloud error fallback', () => ({ result: { ...success('云函数备用').result, error: 'database failed' } })],
  ['default record', () => ({ result: { success: true, data: { _id: 'default', content: '云函数备用' } } })]
]) {
  test(`${name} uses the common fallback and allows a later retry`, async () => {
    const h = harness({ cloud: call => call === 1 ? failure() : success('恢复后的金句') });
    assert.deepEqual(clone(await h.api.getDailyWisdom()), {
      day: '2026-09-19', content: h.api.DEFAULT_QUOTE
    });
    assert.equal(h.storage.size, 0);
    assert.equal((await h.api.getDailyWisdom()).content, '恢复后的金句');
    assert.equal(h.calls.length, 2);
    assert.equal(h.storage.size, 1);
  });
}

test('unavailable persistent storage still keeps the quote stable in this session', async () => {
  const h = harness({ storageUnavailable: true });
  const first = clone(await h.api.getDailyWisdom());
  assert.deepEqual(clone(await h.api.getDailyWisdom()), first);
  assert.equal(h.calls.length, 1);
  h.setTime('2026-09-20T04:00:00+08:00');
  assert.equal((await h.api.getDailyWisdom()).content, '金句 2');
});

test('watchers load immediately, refresh exactly at 04:00 and schedule the next boundary', async () => {
  const h = harness({ time: '2026-01-01T03:59:59.999+08:00' });
  const changes = [];
  const stop = h.api.watchDailyWisdom(quote => changes.push(clone(quote)));
  await flush();
  const boundary = Date.parse('2026-01-01T04:00:00+08:00');
  assert.deepEqual([...h.timers.values()].map(timer => timer.at), [boundary]);
  assert.deepEqual(changes, [{ day: '2025-12-31', content: '金句 1' }]);
  await h.advanceTo(boundary);
  assert.deepEqual(changes[1], { day: '2026-01-01', content: '金句 2' });
  assert.deepEqual([...h.timers.values()].map(timer => timer.at), [boundary + DAY]);
  stop();
  assert.equal(h.timers.size, 0);
  await h.advanceTo(boundary + DAY);
  assert.equal(changes.length, 2);
  assert.equal(h.calls.length, 2);
});

test('a watcher starting from persistent cache still schedules and performs the daily refresh', async () => {
  const h = harness({ time: '2026-09-20T03:59:59.999+08:00' });
  h.storage.set('dailyWisdom', { day: '2026-09-19', content: '缓存金句' });
  const changes = [];
  const stop = h.api.watchDailyWisdom(quote => changes.push(clone(quote)));
  await flush();
  assert.deepEqual(changes, [{ day: '2026-09-19', content: '缓存金句' }]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 1);
  await h.advanceTo('2026-09-20T04:00:00+08:00');
  assert.deepEqual(changes[1], { day: '2026-09-20', content: '金句 1' });
  assert.equal(h.calls.length, 1);
  stop();
});

test('a delayed boundary timer refreshes the actual current day after suspension', async () => {
  const h = harness();
  const changes = [];
  const stop = h.api.watchDailyWisdom(quote => changes.push(clone(quote)));
  await flush();
  await h.advanceTo('2026-09-23T12:00:00+08:00');
  assert.equal(changes[1].day, '2026-09-23');
  assert.deepEqual([...h.timers.values()].map(timer => timer.at), [Date.parse('2026-09-24T04:00:00+08:00')]);
  stop();
});

test('switching pages during a pending request shares it and never calls the stopped watcher', async () => {
  const response = deferred();
  const h = harness({ cloud: () => response.promise });
  const homeChanges = [], shareChanges = [];
  const stopHome = h.api.watchDailyWisdom(quote => homeChanges.push(clone(quote)));
  await flush();
  stopHome();
  const stopShare = h.api.watchDailyWisdom(quote => shareChanges.push(clone(quote)));
  response.resolve(success('两页共用'));
  await flush();
  assert.deepEqual(homeChanges, []);
  assert.deepEqual(shareChanges, [{ day: '2026-09-19', content: '两页共用' }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 1);
  stopShare();
  assert.equal(h.timers.size, 0);
});

test('watcher requests crossing 04:00 publish only the current response once', async () => {
  const oldResponse = deferred(), newResponse = deferred();
  const h = harness({ time: '2026-09-19T03:59:59+08:00', cloud: call =>
    call === 1 ? oldResponse.promise : newResponse.promise });
  const changes = [];
  const stop = h.api.watchDailyWisdom(quote => changes.push(clone(quote)));
  await flush();
  await h.advanceTo('2026-09-19T04:00:00+08:00');
  assert.equal(h.calls.length, 2);
  newResponse.resolve(success('新日金句'));
  await flush();
  oldResponse.resolve(success('过期金句'));
  await flush();
  assert.deepEqual(changes, [{ day: '2026-09-19', content: '新日金句' }]);
  stop();
});

test('stopping during the boundary refresh clears its next timer and suppresses its result', async () => {
  const response = deferred();
  const h = harness({ cloud: call => call === 1 ? success('今天') : response.promise });
  const changes = [];
  const stop = h.api.watchDailyWisdom(quote => changes.push(clone(quote)));
  await flush();
  await h.advanceTo('2026-09-20T04:00:00+08:00');
  stop();
  stop();
  response.resolve(success('明天'));
  await flush();
  assert.equal(changes.length, 1);
  assert.equal(h.timers.size, 0);
});
