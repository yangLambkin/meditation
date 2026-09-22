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
function createApp({ online = false, uploadPending = false, uploadDelay = 0, moderationPending = false } = {}) {
  let now = INITIAL_TIME;
  let connected = online;
  let nextTimer = 0;
  let definition;
  const timers = new Map();
  const networkHandlers = new Set();
  const cloudRows = new Map();
  const storage = new Map([
    ['localUserId', LOCAL_USER], ['userOpenId', OPENID],
    [STORAGE_KEY, { dailyRecords: {}, monthlyStats: {}, userStats: {} }]
  ]);
  const calls = { uploads: [], uploadStorageSnapshots: [], reads: 0, moderation: [], network: 0, toasts: [] };
  function savedRows() {
    const stored = storage.get(STORAGE_KEY);
    return clone(Object.values((stored.checkinRecords || stored).dailyRecords).flatMap(day => day.records));
  }
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
    onNetworkStatusChange: handler => networkHandlers.add(handler),
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
      calls.uploadStorageSnapshots.push(savedRows());
      if (uploadPending) return new Promise(() => {});
      if (uploadDelay) await new Promise(resolve => clock.setTimeout(resolve, uploadDelay));
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
          assert.ok(['checkin.js', 'dateUtil.js', 'homeCheckin.js', 'contentSec.js', 'uploadNetwork.js'].includes(name), request);
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
  const states = [];
  const observe = () => {
    page.refreshCheckinRecords();
    states.push({ pending: page.data.pendingCheckinCount,
      statuses: page._allCheckinRecords.map(record => record.syncStatus) });
  };
  dependencies.get('checkin.js').subscribeSyncState(observe);
  return {
    states,
    page, calls, timers, cloudRows, manager: dependencies.get('checkin.js'),
    get now() { return now; },
    get online() { return connected; },
    setConnected(value) {
      connected = value;
      for (const handler of networkHandlers) handler({ isConnected: value, networkType: value ? 'wifi' : 'none' });
    },
    rows: savedRows,
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
  assert.equal(app.calls.toasts.length, 1, 'saving locally shows one success toast');
  assert.equal(app.calls.toasts[0].title, '已保存');
  assert.equal(app.calls.toasts[0].icon, 'success');
  assert.equal(app.rows().length, 1);
  assert.equal(app.page.data.checkinTotal, 1, 'the actual page refresh reads the locally saved record');
  assert.equal(app.calls.uploads.length, app.online ? 1 : 0);
  if (app.online) {
    assert.equal(app.calls.uploadStorageSnapshots[0][0].localId, app.calls.uploads[0][4],
      'the local record must be durably saved before the cloud upload starts');
  }
}

function openAnotherForm(app) {
  app.page.openCheckinModal();
  app.page.onCheckinDateChange({ detail: { value: '2026-09-19' } });
  app.page.onCheckinTimeChange({ detail: { value: '06:30' } });
  app.page.onCheckinDurationInput({ detail: { value: '21' } });
  app.page.onCheckinExperienceInput({ detail: { value: '下一次静坐的感受' } });
  return app.page._checkinSubmissionId;
}

function assertAnotherFormUnchanged(app, submissionId) {
  assert.equal(app.page.data.showCheckinModal, true, 'the old upload must not close a newly opened form');
  assert.equal(app.page.data.checkinSubmitting, false);
  assert.equal(app.page.data.checkinDate, '2026-09-19');
  assert.equal(app.page.data.checkinTime, '06:30');
  assert.equal(app.page.data.checkinDuration, '21');
  assert.equal(app.page.data.checkinExperience, '下一次静坐的感受');
  assert.equal(app.page._checkinSubmissionId, submissionId);
  assert.equal(app.calls.toasts.length, 1, 'background upload completion must not show another toast');
  assert.equal(app.calls.toasts[0].title, '已保存');
}

for (const text of ['', '  离线时也能记下平静的呼吸  ']) {
  test(`offline home saves ${text ? 'a reflection' : 'an empty reflection'} immediately and retains a durable upload queue`, async () => {
    const app = createApp();
    await saveWithoutAdvancingClock(app, text);
    assert.equal(app.calls.moderation.length, 0, 'known offline state skips the remote text check');
    assert.equal(app.calls.network, text ? 2 : 1);
    assert.equal(app.rows()[0].syncStatus, 'failed');
    assert.equal(app.rows()[0].syncErrorCode, 'UPLOAD_PAUSED');
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    await app.advance(300);
    assert.equal(app.calls.uploads.length, 0, 'offline records never reach the cloud upload API');
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
  test(`home completes locally ${text ? 'with approved text' : 'without text'} while a hung upload later becomes pending`, async () => {
    const app = createApp({ online: true, uploadPending: true });
    await saveWithoutAdvancingClock(app, text);
    assert.equal(app.calls.moderation.length, text ? 1 : 0);
    assert.equal(app.rows()[0].syncStatus, 'uploading');
    assert.equal(app.manager.getPendingSyncSummary().pending, 0);
    assert.equal(app.page.data.pendingCheckinCount, 0);
    assert.equal(app.page._allCheckinRecords[0].syncStatusText, '正在上传');
    await app.page.submitCheckin();
    assert.equal(app.calls.uploads.length, 1);
    assert.equal(app.rows().length, 1, 'a repeat tap cannot duplicate the locally completed check-in');
    const nextSubmissionId = openAnotherForm(app);
    await app.advance(2999);
    assertAnotherFormUnchanged(app, nextSubmissionId);
    assert.ok(app.states.every(state => state.pending === 0));
    await app.advance(1);
    assert.equal(app.rows()[0].syncStatus, 'uploading', 'one attempt timing out keeps the upload active');
    assert.equal(app.calls.uploads.length, 1);
    await app.advance(99);
    assert.equal(app.calls.uploads.length, 1, 'a timed-out attempt waits 100ms before retrying');
    await app.advance(1);
    assert.equal(app.calls.uploads.length, 2);
    await app.advance(9199);
    assert.equal(app.calls.uploads.length, 4);
    assert.equal(app.rows()[0].syncStatus, 'uploading');
    assert.ok(app.states.every(state => state.pending === 0));
    assertAnotherFormUnchanged(app, nextSubmissionId);
    await app.advance(1);
    assertAnotherFormUnchanged(app, nextSubmissionId);
    assert.equal(app.rows()[0].syncStatus, 'failed');
    assert.equal(app.manager.getPendingSyncSummary().pending, 1);
    assert.equal(app.page.data.pendingCheckinCount, 1);
    assert.equal(app.rows()[0].syncErrorCode, 'CLOUD_TIMEOUT');
    assert.equal(app.page._allCheckinRecords[0].syncStatusText, '上传失败，已存本机，请手动上传');
    assert.equal(app.cloudRows.size, 0);
  });
}

for (const uploadDelay of [0, 2999]) {
  test(`local completion is independent of an online upload confirmed after ${uploadDelay} ms`, async () => {
    const app = createApp({ online: true, uploadDelay });
    await saveWithoutAdvancingClock(app, '');
    if (uploadDelay) {
      assert.equal(app.rows()[0].syncStatus, 'uploading');
      assert.equal(app.cloudRows.size, 0, 'the form has completed before the cloud confirms the upload');
      const nextSubmissionId = openAnotherForm(app);
      await app.advance(uploadDelay);
      assertAnotherFormUnchanged(app, nextSubmissionId);
    }
    assert.equal(app.calls.toasts.length, 1);
    assert.equal(app.calls.toasts[0].title, '已保存');
    assert.equal(app.calls.toasts[0].icon, 'success');
    assert.ok(app.states.length > 0);
    assert.ok(app.states.every(state => state.pending === 0));
    assert.ok(app.states.every(state => !state.statuses.includes('pending') && !state.statuses.includes('failed')));
    assert.equal(app.rows()[0].syncStatus, 'synced');
    assert.equal(app.cloudRows.size, 1);
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
  assert.equal(app.page.data.showCheckinModal, false);
  assert.equal(app.calls.toasts.length, 1);
  assert.equal(app.calls.toasts[0].title, '已保存');
  assert.equal(app.calls.toasts[0].icon, 'success');
  assert.equal(app.rows()[0].timestamp, INITIAL_TIME, 'moderation does not change the captured check-in instant');
  assert.equal(app.rows()[0].experience[0].text, '弱网下的体验');
  assert.equal(app.calls.uploadStorageSnapshots[0][0].localId, app.calls.uploads[0][4],
    'the reflection must be saved locally before its upload begins');
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
  await app.advance(12299);
  assert.equal(app.calls.toasts.length, 1);
  assert.equal(app.calls.uploads.length, 4);
  assert.equal(app.rows()[0].syncStatus, 'uploading');
  await app.advance(1);
  assert.equal(app.page.data.checkinSubmitting, false);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.calls.toasts.length, 1, 'the background timeout only updates the record status');
  assert.equal(app.calls.toasts[0].title, '已保存');
});

test('restored network only reads until a home retry uploads once with the original date, time, duration and reflection', async () => {
  const app = createApp();
  app.page.onCheckinDateChange({ detail: { value: '2026-09-19' } });
  app.page.onCheckinTimeChange({ detail: { value: '06:32' } });
  app.page.onCheckinDurationInput({ detail: { value: '35' } });
  await saveWithoutAdvancingClock(app, '  静坐后更能觉察呼吸。  ');
  await app.advance(300);
  const before = app.rows()[0];
  assert.equal(before.date, '2026-09-19');
  assert.equal(before.timestamp, Date.parse('2026-09-19T06:32:00+08:00'));
  assert.equal(before.duration, 35);
  assert.equal(before.experience[0].text, '静坐后更能觉察呼吸。');
  app.setConnected(true);
  const result = await app.manager.syncWithCloud({ force: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.uploaded || 0, 0);
  assert.equal(app.calls.uploads.length, 0, 'network recovery and refresh must not retry offline records');
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  assert.equal(app.cloudRows.size, 0);
  await app.page.refreshCheckinsFromCloud({ force: true });
  await app.advance(4 * 24 * 60 * 60 * 1000);
  app.page.refreshCheckinRecords();
  assert.equal(app.page.data.checkinRecords.length, 0, 'older dates can leave the recent home list');
  assert.equal(app.page.data.pendingCheckinCount, 1, 'older dates still appear in the upload reminder');
  assert.equal(app.calls.uploads.length, 0, 'waiting and refreshing cannot replace a manual retry');
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.uploads.length, 0, 'confirmation without opening a preview cannot upload');
  app.page.openCheckinUploadPreview();
  assert.equal(app.page.data.showCheckinUploadPreview, true);
  assert.equal(app.page.data.checkinUploadCount, 1);
  assert.equal(app.page.data.checkinUploadGroups.length, 1);
  const group = app.page.data.checkinUploadGroups[0];
  assert.equal(group.date, before.date);
  const preview = group.records[0];
  assert.equal(preview.localId, before.localId);
  assert.equal(preview.dayDate, before.date);
  assert.equal(preview.timestamp, before.timestamp);
  assert.equal(preview.timeLabel, '06:32');
  assert.equal(preview.duration, before.duration);
  assert.deepEqual(clone(preview.experienceTexts), ['静坐后更能觉察呼吸。']);
  assert.equal(app.calls.uploads.length, 0, 'opening the preview only displays saved records');
  app.page.closeCheckinUploadPreview();
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.uploads.length, 0, 'cancelling the preview cannot upload records');
  assert.equal(app.rows()[0].syncStatus, 'failed');
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  assert.equal(app.calls.toasts.at(-1).title, '上传成功');
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  await app.manager.syncWithCloud({ force: true });
  app.page.refreshCalendarData();
  const after = app.rows()[0];
  assert.equal(app.rows().length, 1);
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.calls.uploads.length, 1, 'the offline record uploads once after a successful manual retry');
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

test('a hung initial upload and each manual round stop after four three-second attempts without later retries', async () => {
  const app = createApp({ online: true, uploadPending: true });
  const saving = app.page.submitCheckin();
  await flush();
  await app.advance(12300);
  await saving;
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.calls.uploads.length, 4);
  await app.advance(60 * 60 * 1000);
  assert.equal(app.calls.uploads.length, 4);

  let complete = false;
  app.page.openCheckinUploadPreview();
  const manual = app.page.retryCheckinUploads().then(() => { complete = true; });
  await flush();
  assert.equal(app.calls.uploads.length, 5);
  await app.advance(12299);
  assert.equal(app.calls.uploads.length, 8);
  assert.equal(app.rows()[0].syncStatus, 'uploading');
  assert.equal(complete, false);
  assert.equal(app.page.data.checkinRetrying, true);
  assert.equal(app.page.data.showCheckinUploadPreview, true, 'the upload list remains visible during the request');
  await app.advance(1);
  await manual;
  assert.equal(app.page.data.checkinRetrying, false);
  assert.equal(app.page.data.showCheckinUploadPreview, false);
  assert.equal(app.rows()[0].syncStatus, 'failed');
  assert.equal(app.page.data.pendingCheckinCount, 1);
  assert.equal(app.rows().length, 1);
  await app.advance(24 * 60 * 60 * 1000);
  await app.page.refreshCheckinsFromCloud();
  assert.equal(app.calls.uploads.length, 8, 'exhausted manual rounds also remain manual-only');
  assert.equal(app.rows().length, 1);
});

test('saving a new check-in uploads only that new record and leaves previous failures for a manual retry', async () => {
  const app = createApp();
  await saveWithoutAdvancingClock(app, '');
  await app.advance(300);
  const originalId = app.rows()[0].localId;
  app.setConnected(true);
  await app.advance(1000);
  app.page.openCheckinModal();
  await app.page.submitCheckin();
  await flush();
  assert.equal(app.rows().length, 2);
  assert.equal(app.calls.uploads.length, 1);
  assert.notEqual(app.calls.uploads[0][4], originalId);
  assert.equal(app.rows().find(record => record.localId === originalId).syncStatus, 'failed');
  assert.equal(app.cloudRows.size, 1);
  assert.equal(app.manager.getPendingSyncSummary().pending, 1);
  app.page.openCheckinUploadPreview();
  await app.page.retryCheckinUploads();
  assert.equal(app.calls.uploads.length, 2);
  assert.equal(app.calls.uploads[1][4], originalId);
  assert.equal(app.cloudRows.size, 2);
  assert.equal(app.manager.getPendingSyncSummary().pending, 0);
});
