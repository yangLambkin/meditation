const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const DEFAULT_IMAGE = '/images/p1.png';
const flush = () => new Promise(resolve => setImmediate(resolve));
const cloudImage = index => ({ fileList: [{ status: 0, tempFileURL: `https://images.example/${index}.png` }] });

function harness({ cloud, download, pick } = {}) {
  let now = 1000;
  let nextTimer = 0;
  let selections = 0;
  const timers = new Map();
  const cloudCalls = [];
  const downloads = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dailyCardImage.js'), 'utf8'), {
    module,
    Date: { now: () => now },
    require(name) {
      assert.equal(name, '../config/images.js');
      return {
        DEFAULT_IMAGE,
        getRandomDailyPokerImage() {
          selections++;
          return pick ? pick() : { fileID: `cloud://image-${selections}.png`, isDefault: false };
        }
      };
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    wx: {
      cloud: { getTempFileURL(options) {
        cloudCalls.push(options);
        return cloud && cloud(options);
      } },
      getImageInfo(options) {
        downloads.push(options);
        return download && download(options);
      }
    }
  }, { filename: 'dailyCardImage.js' });
  return {
    api: module.exports, timers, cloudCalls, downloads,
    get selections() { return selections; },
    elapse(milliseconds) { now += milliseconds; },
    async advance(milliseconds) {
      now += milliseconds;
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

test('preparing reuses the same entry and downloads the selected image only once', async () => {
  const h = harness();
  const first = h.api.prepareNextImage();
  assert.equal(first.path, null);
  assert.strictEqual(h.api.prepareNextImage(), first);
  await flush();
  assert.equal(h.selections, 1);
  assert.deepEqual(Array.from(h.cloudCalls[0].fileList), ['cloud://image-1.png']);
  h.cloudCalls[0].success(cloudImage(1));
  h.cloudCalls[0].success(cloudImage(1));
  assert.equal(first.path, null, 'the remote URL alone is not a downloaded image');
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].src, 'https://images.example/1.png');
  h.downloads[0].success({ path: 'wxfile://tmp/image-1.png' });
  assert.equal(await first.promise, 'wxfile://tmp/image-1.png');
  assert.equal(first.path, 'wxfile://tmp/image-1.png');
  assert.equal(h.timers.size, 0);
  assert.strictEqual(h.api.prepareNextImage(), first);
  assert.equal(h.selections, 1);
});

test('a warmed image is available synchronously when consumed', async () => {
  const h = harness({
    cloud: () => Promise.resolve(cloudImage(1)),
    download: () => Promise.resolve({ path: 'wxfile://tmp/warm.png' })
  });
  const prefetched = h.api.prepareNextImage();
  await prefetched.promise;
  const consumed = h.api.takeNextImage();
  assert.strictEqual(consumed, prefetched);
  assert.equal(consumed.path, 'wxfile://tmp/warm.png');
  assert.equal(h.selections, 1);
});

test('consuming clears only the cache and lets an older entry finish independently', async () => {
  const h = harness();
  const first = h.api.takeNextImage();
  const second = h.api.prepareNextImage();
  assert.notStrictEqual(first, second);
  await flush();
  assert.equal(h.selections, 2);
  h.cloudCalls[1].success(cloudImage(2));
  h.downloads[0].success({ path: 'wxfile://tmp/second.png' });
  h.cloudCalls[0].success(cloudImage(1));
  h.downloads[1].success({ path: 'wxfile://tmp/first.png' });
  assert.equal(await first.promise, 'wxfile://tmp/first.png');
  assert.equal(await second.promise, 'wxfile://tmp/second.png');
  assert.strictEqual(h.api.takeNextImage(), second);
  const third = h.api.takeNextImage();
  await flush();
  assert.equal(h.selections, 3);
  h.cloudCalls[2].fail(new Error('offline'));
  assert.equal(await third.promise, DEFAULT_IMAGE);
});

test('SDKs returning promises and callbacks together still download once', async () => {
  const h = harness({
    cloud(options) {
      options.success(cloudImage(1));
      return Promise.resolve(cloudImage(1));
    },
    download(options) {
      options.success({ path: 'wxfile://tmp/once.png' });
      return Promise.reject(new Error('late duplicate failure'));
    }
  });
  const image = h.api.prepareNextImage();
  assert.equal(image.path, null);
  assert.equal(await image.promise, 'wxfile://tmp/once.png');
  await flush();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.timers.size, 0);
});

for (const [name, cloud] of [
  ['callback failure', options => options.fail(new Error('offline'))],
  ['promise rejection', () => Promise.reject(new Error('offline'))],
  ['synchronous exception', () => { throw new Error('SDK unavailable'); }],
  ['invalid response', options => options.success({ fileList: [] })],
  ['missing URL', options => options.success({ fileList: [{ status: 0 }] })],
  ['failed file', options => options.success({ fileList: [{ status: -1, tempFileURL: 'https://invalid' }] })]
]) {
  test(`URL ${name} resolves to the local fallback without downloading`, async () => {
    const h = harness({ cloud });
    const image = h.api.prepareNextImage();
    assert.equal(await image.promise, DEFAULT_IMAGE);
    assert.equal(image.path, DEFAULT_IMAGE);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const [name, download] of [
  ['callback failure', options => options.fail(new Error('download failed'))],
  ['promise rejection', () => Promise.reject(new Error('download failed'))],
  ['synchronous exception', () => { throw new Error('getImageInfo unavailable'); }],
  ['missing local path', options => options.success({ width: 100 })]
]) {
  test(`download ${name} resolves to the local fallback`, async () => {
    const h = harness({ cloud: () => Promise.resolve(cloudImage(1)), download });
    const image = h.api.prepareNextImage();
    assert.equal(await image.promise, DEFAULT_IMAGE);
    assert.equal(image.path, DEFAULT_IMAGE);
    assert.equal(h.downloads.length, 1);
    assert.equal(h.timers.size, 0);
  });
}

for (const [name, pick] of [
  ['configured default', () => ({ fileID: DEFAULT_IMAGE, isDefault: true })],
  ['selection error', () => { throw new Error('configuration unavailable'); }]
]) {
  test(`${name} uses the bundled image`, async () => {
    const h = harness({ pick });
    assert.equal(await h.api.prepareNextImage().promise, DEFAULT_IMAGE);
    assert.equal(h.cloudCalls.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('a URL timeout resolves within five seconds and ignores a late URL or rejection', async () => {
  let rejectRequest;
  const h = harness({ cloud: () => new Promise((_, reject) => { rejectRequest = reject; }) });
  const image = h.api.prepareNextImage();
  await flush();
  await h.advance(4999);
  assert.equal(image.path, null);
  await h.advance(1);
  assert.equal(await image.promise, DEFAULT_IMAGE);
  h.cloudCalls[0].success(cloudImage(1));
  rejectRequest(new Error('late failure'));
  await flush();
  assert.equal(h.downloads.length, 0);
  assert.equal(image.path, DEFAULT_IMAGE);
  assert.equal(h.timers.size, 0);
  assert.strictEqual(h.api.prepareNextImage(), image, 'a fallback remains reusable until consumed');
});

test('URL lookup and download share a five-second deadline; late paths cannot replace the fallback', async () => {
  const h = harness();
  const image = h.api.prepareNextImage();
  await flush();
  await h.advance(4000);
  h.cloudCalls[0].success(cloudImage(1));
  await h.advance(999);
  assert.equal(image.path, null);
  await h.advance(1);
  assert.equal(await image.promise, DEFAULT_IMAGE);
  h.downloads[0].success({ path: 'wxfile://tmp/too-late.png' });
  h.downloads[0].fail(new Error('late download failure'));
  assert.equal(image.path, DEFAULT_IMAGE);
});

test('a late URL cannot start a download even if a suspended timeout has not run', async () => {
  const h = harness();
  const image = h.api.prepareNextImage();
  await flush();
  h.elapse(5000);
  h.cloudCalls[0].success(cloudImage(1));
  assert.equal(await image.promise, DEFAULT_IMAGE);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.timers.size, 0);
});

test('a late downloaded path cannot win while its timeout callback is suspended', async () => {
  const h = harness();
  const image = h.api.prepareNextImage();
  await flush();
  h.cloudCalls[0].success(cloudImage(1));
  h.elapse(5000);
  h.downloads[0].success({ path: 'wxfile://tmp/too-late.png' });
  assert.equal(await image.promise, DEFAULT_IMAGE);
  assert.equal(h.timers.size, 0);
});
