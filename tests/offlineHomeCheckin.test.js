const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INITIAL_TIME = Date.parse('2026-09-20T12:00:37.123+08:00');
const LOCAL_USER = 'local-offline-home';
const OPENID = 'oz-offline-home';
const STORAGE_KEY = `meditation_checkin_${LOCAL_USER}`;
const clone = value => value === undefined ? value : structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));

// Only network boundaries are mocked: the page, local record store, queue,
// reconciliation, and optional text check all execute their production code.
function createApp({ online = false, uploadPending = false, moderationPending = false } = {}) {
  let now = INITIAL_TIME;
  let connected = online;
  let nextTimer = 0;
  let definition;
  const timers = new Map();
  const cloudRows = new Map();
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', OPENID],
    [STORAGE_KEY, { dailyRecords: {}, monthlyStats: {}, userStats: {} }]
  ]);
  const calls = { uploads: [], reads: 0, moderation: [], network: 0, toasts: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const clock = {
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + Number(milliseconds || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    getNetworkType({ success }) {
      calls.network++;
      success({ networkType: connected ? 'wifi' : 'none' });
    },
    showToast: value => calls.toasts.push(clone(value)),
    cloud: {
      callFunction(options) {
        calls.moderation.push(clone(options));
        assert.equal(options.name, 'contentSecCheck');
        if (moderationPending) return new Promise(() => {});
        return connected ? Promise.resolve({ result: { success: true, safe: true } })
          : Promise.reject(new Error('Network unavailable'));
      }
    }
  };
  const api = {
    async recordMeditation(...args) {
      calls.uploads.push(clone(args));
      if (uploadPending) return new Promise(() => {});
      if (!connected) throw Object.assign(new Error('Network unavailable'), { code: 'NETWORK_ERROR' });
      const [duration, emotion, experience, timestamp, localId, options] = args;
      if (!cloudRows.has(localId)) cloudRows.set(localId, {
        _id: `cloud-${localId}`, _openid: OPENID, localId, duration, emotion,
        experience, timestamp, date: options.date, source: options.source
      });
      return { success: true, data: { recordId: `cloud-${localId}` } };
    },
    async getAllRecords() {
      calls.reads++;
      return connected ? { success: true, data: clone([...cloudRows.values()]) }
        : { success: false, code: 'NETWORK_ERROR' };
    }
  };
  const dependencies = new Map([
    ['cloudApi.js', api],
    ['badgeManager.js', { checkBadgeUnlock: () => ({ hasNewUnlock: false }) }],
    ['dailyWisdom.js', { DEFAULT_QUOTE: '' }]
  ]);
  function load(file) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8'), {
      module, exports: module.exports, wx, Date: Clock, ...clock,
      console: { log() {}, warn() {}, error() {} },
      Page: value => { definition = value; },
      require(request) {
        const name = path.basename(request);
        if (!dependencies.has(name)) {
          assert.ok(['checkin.js', 'dateUtil.js', 'homeCheckin.js', 'contentSec.js'].includes(name), request);
          dependencies.set(name, load(`utils/${name}`));
        }
        return dependencies.get(name);
      }
    }, { filename: file });
    return module.exports;
  }
  load('pages/index/index.js');
  const page = {
    ...definition, data: clone(definition.data),
    setData(value) { Object.assign(this.data, value); }
  };
  page.setData({ currentYear: 2026, currentMonth: 9, userOpenId: OPENID });
  page.openCheckinModal();
  return {
    page, calls, timers, cloudRows, manager: dependencies.get('checkin.js'),
    get now() { return now; },
    setConnected(value) { connected = value; },
    rows() {
      const stored = storage.get(STORAGE_KEY);
      return clone(Object.values((stored.checkinRecords || stored).dailyRecords).flatMap(day => day.records));
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      let count = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, value]) => value.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++count < 100, 'retry timers must not spin');
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

async function saveWithoutAdvancingClock(app, text) {
  app.page.onCheckinExperienceInput({ detail: { value: text } });
  let completed = false;
  const saving = app.page.submitCheckin().then(() => { completed = true; });
  await flush();
  assert.equal(completed, true, 'local save must settle without running a network timeout');
  await saving;
  assert.equal(app.now, INITIAL_TIME);
  assert.equal(app.page.data.checkinSubmitting, false);
  assert.equal(app.page.data.showCheckinModal, false);
  assert.equal(app.calls.toasts.at(-1).title, '已存本机，待上传');
  assert.equal(app.rows().length, 1);
  assert.equal(app.page.data.checkinTotal, 1, 'the actual page refresh reads the locally saved record');
}

for (const text of ['', '  离线时也能记下平静的呼吸  ']) {
  test(`offline home saves ${text ? 'a reflection' : 'an empty reflection'} immediately and retains a durable upload queue`, async () => {
    const app = createApp();
    await saveWithoutAdvancingClock(app, text);
    assert.equal(app.calls.moderation.length, 0, 'known offline state skips the remote text check');
    assert.equal(app.calls.network, text ? 1 : 0);
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    assert.equal(app.rows()[0].syncStatus, 'failed');
    assert.equal(app.rows()[0].timestamp, INITIAL_TIME);
    assert.equal(app.rows()[0].duration, 7);
    assert.equal(app.rows()[0].experience.length, text ? 1 : 0);
    if (text) assert.equal(app.rows()[0].experience[0].text, text.trim());
    assert.equal(app.cloudRows.size, 0);
    await app.page.submitCheckin();
    assert.equal(app.rows().length, 1, 'rapid repeat taps cannot duplicate the pending record');
  });
}

for (const text of ['', '上传一直没有返回']) {
  test(`home saves ${text ? 'approved text' : 'without text'} while the upload promise never settles`, async () => {
    const app = createApp({ online: true, uploadPending: true });
    await saveWithoutAdvancingClock(app, text);
    assert.equal(app.calls.uploads.length, 1);
    assert.equal(app.calls.moderation.length, text ? 1 : 0);
    assert.equal(app.rows()[0].syncStatus, 'pending');
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    assert.equal(app.cloudRows.size, 0);
  });
}

test('home text check waits at most 1.5 seconds before saving even when both cloud requests hang', async () => {
  const app = createApp({ online: true, uploadPending: true, moderationPending: true });
  app.page.onCheckinExperienceInput({ detail: { value: '弱网下的体验' } });
  let completed = false;
  const saving = app.page.submitCheckin().then(() => { completed = true; });
  await flush();
  await app.advance(1499);
  assert.equal(completed, false);
  assert.equal(app.page.data.checkinSubmitting, true);
  assert.equal(app.rows().length, 0);
  await app.advance(1);
  assert.equal(completed, true);
  await saving;
  assert.equal(app.page.data.checkinSubmitting, false);
  assert.equal(app.rows()[0].timestamp, INITIAL_TIME, 'moderation does not change the captured check-in instant');
  assert.equal(app.rows()[0].experience[0].text, '弱网下的体验');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.calls.toasts.at(-1).title, '已存本机，待上传');
});

test('restored network only reads until a home retry uploads once with the original date, time, duration and reflection', async () => {
  const app = createApp();
  app.page.onCheckinDateChange({ detail: { value: '2026-09-19' } });
  app.page.onCheckinTimeChange({ detail: { value: '06:32' } });
  app.page.onCheckinDurationInput({ detail: { value: '35' } });
  await saveWithoutAdvancingClock(app, '  静坐后更能觉察呼吸。  ');
  const before = app.rows()[0];
  assert.equal(before.date, '2026-09-19');
  assert.equal(before.timestamp, Date.parse('2026-09-19T06:32:00+08:00'));
  assert.equal(before.duration, 35);
  assert.equal(before.experience[0].text, '静坐后更能觉察呼吸。');
  app.setConnected(true);
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.uploaded || 0, 0);
  assert.equal(app.calls.uploads.length, 1, 'network recovery and refresh must not retry failed uploads');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.cloudRows.size, 0);
  await app.page.refreshCheckinsFromCloud({ force: true });
  await app.advance(24 * 60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 1, 'waiting and refreshing cannot replace a manual retry');
  await app.page.retryCheckinUploads();
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.calls.toasts.at(-1).title, '上传成功');
  await app.page.retryCheckinUploads();
  await app.manager.syncWithCloud({ force: true });
  app.page.refreshCalendarData();
  const after = app.rows()[0];
  assert.equal(app.rows().length, 1);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, 2, 'one offline failure followed by one successful retry');
  assert.equal(after.localId, before.localId);
  assert.equal(after.date, before.date);
  assert.equal(after.timestamp, before.timestamp);
  assert.equal(after.duration, before.duration);
  assert.deepEqual(after.experience, before.experience);
  assert.equal(after.syncStatus, 'synced');
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  assert.equal(app.manager.getUserStats().totalCount, 1);
  assert.equal(app.page.data.checkinTotal, 1);
  assert.equal(app.page.data.pendingCheckinCount, 0);
  const cloud = [...app.cloudRows.values()][0];
  for (const key of ['localId', 'date', 'timestamp', 'duration', 'experience']) {
    assert.deepEqual(clone(cloud[key]), before[key], key);
  }
});

test('a hung initial upload and every manual retry each stop within five seconds and never retry on their own', async () => {
  const app = createApp({ online: true, uploadPending: true });
  await saveWithoutAdvancingClock(app, '');
  await app.advance(5000);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.calls.uploads.length, 1);
  await app.advance(60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 1);

  let complete = false;
  const manual = app.page.retryCheckinUploads().then(() => { complete = true; });
  await flush();
  assert.equal(app.calls.uploads.length, 2);
  await app.advance(4999);
  assert.equal(complete, false);
  assert.equal(app.page.data.checkinRetrying, true);
  await app.advance(1);
  await manual;
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.page.data.pendingCheckinCount, 1);
  assert.equal(app.rows().length, 1);
  await app.advance(24 * 60 * 60 * 1000);
  await app.page.refreshCheckinsFromCloud();
  assert.equal(app.calls.uploads.length, 2, 'failed manual retries also remain manual-only');
  assert.equal(app.rows().length, 1);
});

test('saving a new check-in uploads only that new record and leaves previous failures for a manual retry', async () => {
  const app = createApp();
  await saveWithoutAdvancingClock(app, '');
  const originalId = app.rows()[0].localId;
  app.setConnected(true);
  await app.advance(1000);
  app.page.openCheckinModal();
  await app.page.submitCheckin();
  await flush();
  assert.equal(app.rows().length, 2);
  assert.equal(app.calls.uploads.length, 2);
  assert.notEqual(app.calls.uploads[1][4], originalId);
  assert.equal(app.rows().find(record => record.localId === originalId).syncStatus, 'failed');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.uploads.length, 3);
  assert.equal(app.calls.uploads[2][4], originalId);
  assert.equal(app.cloudRows.size, 2);
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
});
