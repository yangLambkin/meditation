const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT_IMAGE = '/images/p1.png';

function createPage({ readyPath = null, profileHint = false } = {}) {
  let definition;
  let businessDate = '2026-09-21';
  let updateBusinessDate;
  let resolveImage;
  let nextTimer = 0;
  const timers = new Map();
  const calls = { user: 0, image: 0, modals: [], updates: [] };
  const imagePromise = readyPath
    ? Promise.resolve(readyPath)
    : new Promise(resolve => { resolveImage = resolve; });
  const modules = {
    'lunar.js': { getLunarDate: () => '农历' },
    'checkin.js': {},
    'badgeManager.js': {},
    'homeCheckin.js': {},
    'dailyWisdom.js': { DEFAULT_QUOTE: '静心', watchDailyWisdom: () => () => {} },
    'dailyCardImage.js': {
      DEFAULT_IMAGE,
      takeNextImage() {
        calls.image++;
        return { path: readyPath, promise: imagePromise };
      }
    },
    'dateUtil.js': {
      getBusinessDate: () => businessDate,
      watchBusinessDate(callback) {
        updateBusinessDate = callback;
        return () => { updateBusinessDate = null; };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/daily/daily1.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(request) {
      const name = path.basename(request);
      assert.ok(Object.hasOwn(modules, name), request);
      return modules[name];
    },
    console: { log() {}, warn() {}, error() {} },
    wx: { showModal: value => calls.modals.push(value), switchTab() {} },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) {
      calls.updates.push(values);
      Object.assign(this.data, values);
    },
    getUserData() {
      calls.user++;
      if (profileHint) this.showProfileHint();
    }
  };
  return {
    page, calls, timers, resolveImage,
    setBusinessDate(day) { businessDate = day; },
    rollBusinessDate(day) { businessDate = day; updateBusinessDate(); },
    runTimers() {
      for (const [id, callback] of [...timers]) {
        if (timers.delete(id)) callback();
      }
    }
  };
}

test('daily card uses the prepared local image synchronously on first load', () => {
  const { page, calls } = createPage({ readyPath: 'wxfile://daily-card.png' });
  page.onLoad({});
  assert.equal(page.data.displayImage, 'wxfile://daily-card.png');
  assert.equal(page.data.day, 21);
  assert.equal(calls.image, 1);
  page.onShow();
  assert.equal(calls.image, 1, 'show must not select or request another image');
  assert.equal(calls.user, 1, 'first show reuses user and statistics initialized on load');
});

test('daily card keeps its local fallback until an in-flight prepared image is downloaded', async () => {
  const { page, calls, resolveImage } = createPage();
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.displayImage, DEFAULT_IMAGE);
  assert.equal(page.data.day, 21, 'the date is available without waiting for the image');
  resolveImage('wxfile://downloaded.png');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.displayImage, 'wxfile://downloaded.png');
  assert.equal(calls.image, 1);
  page.fallbackToDefaultImage();
  assert.equal(page.data.displayImage, DEFAULT_IMAGE, 'a missing temporary image falls back locally');
  const updates = calls.updates.length;
  page.fallbackToDefaultImage();
  assert.equal(calls.updates.length, updates, 'a fallback image error cannot trigger a setData loop');
});

test('a late image response cannot update an unloaded daily card', async () => {
  const { page, calls, resolveImage } = createPage();
  page.onLoad({});
  page.onUnload();
  const updates = calls.updates.length;
  resolveImage('wxfile://too-late.png');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.updates.length, updates);
  assert.equal(page.data.displayImage, DEFAULT_IMAGE);
});

test('daily card refreshes once on return and once at the business-day boundary', () => {
  const { page, calls, rollBusinessDate } = createPage();
  page.onLoad({});
  page.onShow();
  assert.equal(calls.user, 1);
  page.onHide();
  page.onShow();
  assert.equal(calls.user, 2);
  rollBusinessDate('2026-09-22');
  assert.equal(calls.user, 3);
  assert.equal(page.data.day, 22);
});

test('the first show still refreshes when the business date changes after load', () => {
  const { page, calls, setBusinessDate } = createPage();
  page.onLoad({});
  setBusinessDate('2026-09-22');
  page.onShow();
  assert.equal(page.data.day, 22);
  assert.equal(calls.user, 2);
});

test('profile reminders are deduplicated, cancelled when hidden and shown once after return', () => {
  const { page, calls, timers, runTimers } = createPage({ profileHint: true });
  page.onLoad({});
  page.onShow();
  page.getUserData();
  assert.equal(timers.size, 1);
  page.onHide();
  runTimers();
  assert.equal(calls.modals.length, 0);
  assert.equal(timers.size, 0);
  page.onShow();
  runTimers();
  assert.equal(calls.modals.length, 1);
  page.onHide();
  page.onShow();
  runTimers();
  assert.equal(calls.modals.length, 1);
  page.onUnload();
  assert.equal(timers.size, 0);
});
