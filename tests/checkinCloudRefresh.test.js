const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeCheckin = require('../miniprogram/utils/homeCheckin');

const USER_ID = 'local-refresh';
const STORAGE_KEY = `meditation_checkin_${USER_ID}`;
const NOW = Date.parse('2026-09-17T12:00:00+08:00');
const EVENING = Date.parse('2026-09-16T20:39:00+08:00');
const MORNING = Date.parse('2026-09-17T03:39:00+08:00');
const clone = value => value === undefined ? undefined : structuredClone(value);
const saved = (id, timestamp, duration = 7, extra = {}) => ({
  _id: id, timestamp, duration, date: homeCheckin.getDateTime(timestamp).date,
  emotion: [], experience: [], ...extra
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function localCache(records, nested = false) {
  const data = { dailyRecords: {}, monthlyStats: {}, userStats: {} };
  records.forEach(record => {
    const date = record.date || homeCheckin.getDateTime(record.timestamp).date;
    const day = data.dailyRecords[date] || (data.dailyRecords[date] = { count: 0, records: [], lastCheckin: 0 });
    day.records.push(clone(record));
    day.count++;
    day.lastCheckin = Math.max(day.lastCheckin, record.timestamp);
  });
  return nested ? { checkinRecords: data, experienceRecords: {} } : { ...data, experienceRecords: {} };
}

function harness({ local = [], cloud = [], nested = false, read, stats, remove, backup } = {}) {
  const storage = new Map([
    ['localUserId', USER_ID], ['userOpenId', 'oz-refresh'],
    ['cacheStatus', 'initialized'], ['needsRecovery', false],
    [STORAGE_KEY, localCache(local, nested)]
  ]);
  const calls = { reads: 0, writes: 0, stats: 0, backups: 0, removes: 0 };
  const api = {
    async getAllRecords() {
      const index = calls.reads++;
      return read ? read(index) : { success: true, data: clone(cloud) };
    },
    async getUserStats() {
      const index = calls.stats++;
      return stats ? stats(index) : { success: true, data: {} };
    },
    async deleteMeditationRecord(identity) {
      calls.removes++;
      return remove ? remove(identity) : { success: true };
    },
    async recordMeditation(...args) {
      calls.backups++;
      return backup ? backup(...args) : { success: true, data: { recordId: 'new-cloud-id' } };
    }
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  function load(name, globals = {}) {
    globals = { ...globals, wx: globals.wx && {
      getNetworkType: ({ success }) => success({ networkType: 'wifi' }), ...globals.wx
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils', name), 'utf8'), {
      module, exports: module.exports, Date: FixedDate,
      console: { log() {}, warn() {}, error() {} }, ...globals,
      require(name) {
        if (name === './uploadNetwork.js') return load('uploadNetwork.js', globals);
        return globals.require(name);
      }
    }, { filename: name });
    return module.exports;
  }
  const dateUtil = load('dateUtil.js');
  const manager = load('checkin.js', {
    wx: {
      getStorageSync: key => clone(storage.get(key)),
      setStorageSync(key, value) {
        if (key === STORAGE_KEY) calls.writes++;
        storage.set(key, clone(value));
      },
      removeStorageSync: key => storage.delete(key)
    },
    setTimeout() {},
    require(name) {
      if (name === './dateUtil.js') return dateUtil;
      if (name === './cloudApi.js') return api;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return {
    manager, storage, calls,
    data() { const value = storage.get(STORAGE_KEY); return value.checkinRecords || value; },
    records() { return Object.values(this.data().dailyRecords).flatMap(day => day.records); },
    ids() { return this.records().map(record => record._id).filter(Boolean).sort(); }
  };
}

for (const nested of [false, true]) {
  test(`active refresh fills September 16 20:39 despite an existing ${nested ? 'nested' : 'flat'} September 17 cache`, async () => {
    const evening = saved('evening', EVENING);
    const morning = saved('morning', MORNING, 13);
    const app = harness({ local: [morning], cloud: [morning, evening], nested });
    if (nested) {
      assert.equal(await app.manager.checkAndRecoverFromCloud(), false);
      assert.equal(app.calls.reads, 0, 'the old cache check alone misses a partial cache');
    }
    assert.equal(await app.manager.refreshFromCloud(), true);
    assert.equal(app.calls.reads, 1);
    assert.deepEqual(homeCheckin.buildCheckinRecords(app.data()).map(({ date, time, duration }) => ({ date, time, duration })), [
      { date: '2026-09-17', time: '03:39', duration: 13 },
      { date: '2026-09-16', time: '20:39', duration: 7 }
    ]);
    assert.equal(app.data().monthlyStats['2026-09'].total, 2);
    assert.equal(app.data().monthlyStats['2026-09'].totalDuration, 20);
    assert.equal(app.manager.getCurrentMonthMinutes(), 20);
  });
}

test('repeated refresh and duplicate cloud rows preserve offline records and local experience text', async () => {
  const online = saved('online', MORNING, 13, { experience: [{ _id: 'note', text: '本地更新的体验' }] });
  const offline = saved(undefined, EVENING, 7, { localId: 'offline', experience: ['offline-note'] });
  const cloudOnline = { ...online, experience: [{ _id: 'note', text: '旧云端体验' }] };
  const app = harness({ local: [online, offline], cloud: [cloudOnline, cloudOnline], nested: true });
  app.storage.get(STORAGE_KEY).experienceRecords = { 'offline-note': { text: '尚未上传的体验' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await app.manager.refreshFromCloud(), true);
    assert.equal(app.records().length, 2);
    assert.equal(app.records().find(record => record._id === 'online').experience[0].text, '本地更新的体验');
    assert.equal(app.storage.get(STORAGE_KEY).experienceRecords['offline-note'].text, '尚未上传的体验');
  }
});

test('an existing record with empty local experience receives its cloud experience', async () => {
  const local = saved('same-record', EVENING);
  const remote = { ...local, experience: [{ _id: 'cloud-note', text: '另一设备补写的体验' }] };
  const app = harness({ local: [local], cloud: [remote] });
  await app.manager.refreshFromCloud();
  assert.deepEqual(app.records()[0].experience, remote.experience);
});

test('local pending and newly received cloud experiences are combined without duplication across refreshes', async () => {
  const localNotes = [{ uniqueId: 'pending-note', text: '本地待上传' }, { text: '没有ID的共同体验' }, '本地文字'];
  const cloudNotes = [
    { _id: 'cloud-note', text: '云端新体验' },
    { uniqueId: 'pending-note', text: '较旧版本' },
    { text: '没有ID的共同体验' },
    '本地文字'
  ];
  const local = saved('same-record', EVENING, 7, { experience: localNotes });
  const app = harness({ local: [local], cloud: [{ ...local, experience: cloudNotes }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.manager.refreshFromCloud();
    const notes = app.records()[0].experience;
    assert.equal(notes.length, 4);
    assert.ok(notes.some(note => note && note._id === 'cloud-note' && note.text === '云端新体验'));
    assert.ok(notes.some(note => note && note.uniqueId === 'pending-note' && note.text === '本地待上传'));
    assert.equal(notes.filter(note => note && note.text === '没有ID的共同体验').length, 1);
    assert.equal(notes.filter(note => note === '本地文字').length, 1);
  }
});

test('legacy experience IDs upgrade to cloud objects while existing local object text remains authoritative', async () => {
  const local = saved('same-record', EVENING, 7, { experience: [
    'legacy-note', 'legacy-unique-id', { _id: 'edited-note', text: '本地最新文字' }
  ] });
  const remote = { ...local, experience: [
    { _id: 'legacy-note', text: '通过ID找回的体验' },
    { uniqueId: 'legacy-unique-id', text: '通过uniqueId找回的体验' },
    { _id: 'edited-note', text: '云端旧文字' }
  ] };
  const app = harness({ local: [local], cloud: [remote] });
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.manager.refreshFromCloud();
    const notes = app.records()[0].experience;
    assert.equal(notes.length, 3);
    assert.ok(notes.every(note => note && typeof note === 'object'));
    assert.equal(notes.find(note => note._id === 'legacy-note').text, '通过ID找回的体验');
    assert.equal(notes.find(note => note.uniqueId === 'legacy-unique-id').text, '通过uniqueId找回的体验');
    assert.equal(notes.find(note => note._id === 'edited-note').text, '本地最新文字');
  }
});

test('distinct cloud and local identities at the same timestamp and duration remain distinct', async () => {
  const first = saved('first', EVENING, 7, { localId: 'first-local' });
  const second = saved('second', EVENING, 7, { localId: 'second-local' });
  const offline = saved(undefined, EVENING, 7, { localId: 'offline-local' });
  const app = harness({ local: [first, offline], cloud: [first, second] });
  await app.manager.refreshFromCloud();
  await app.manager.refreshFromCloud();
  assert.equal(app.records().length, 3);
  assert.deepEqual(app.ids(), ['first', 'second']);
  assert.ok(app.records().some(record => record.localId === 'offline-local' && !record._id));
});

test('legacy records match equal timestamp/duration cloud records one-to-one and acquire stable identities', async () => {
  const legacy = saved(undefined, EVENING);
  const first = saved('first', EVENING);
  const second = saved('second', EVENING);
  const third = saved('third', EVENING);
  const app = harness({ local: [legacy, { ...legacy, timestamp: String(EVENING) }], cloud: [first, second, third] });
  await app.manager.refreshFromCloud();
  assert.equal(app.records().length, 3);
  assert.deepEqual(app.ids(), ['first', 'second', 'third']);
  await app.manager.refreshFromCloud();
  assert.equal(app.records().length, 3);
});

test('localId matches an uploaded record and refresh corrects a stale natural date from its timestamp', async () => {
  const local = saved(undefined, EVENING, 7, { localId: 'same-local', date: '2026-09-17' });
  const remote = saved('uploaded', EVENING, 7, { localId: 'same-local' });
  const app = harness({ local: [local], cloud: [remote] });
  await app.manager.refreshFromCloud();
  assert.deepEqual(app.ids(), ['uploaded']);
  assert.equal(app.records()[0].localId, 'same-local');
  assert.deepEqual(Object.keys(app.data().dailyRecords), ['2026-09-16']);
});

test('cloud values replace stale timestamp, duration and emotion for an already synced record', async () => {
  const local = saved('same-record', EVENING, 7, {
    emotion: ['旧情绪'], experience: [{ _id: 'note', text: '本地待上传的体验' }]
  });
  const remote = saved('same-record', MORNING, 30, {
    emotion: ['平静'], experience: [{ _id: 'note', text: '云端旧体验' }]
  });
  const app = harness({ local: [local], cloud: [remote] });

  assert.equal(await app.manager.refreshFromCloud(), true);
  const record = app.records()[0];
  assert.equal(record.timestamp, MORNING);
  assert.equal(record.duration, 30);
  assert.deepEqual(record.emotion, ['平静']);
  assert.equal(record.experience[0].text, '本地待上传的体验');
  assert.deepEqual(Object.keys(app.data().dailyRecords), ['2026-09-17']);
  assert.equal(app.data().monthlyStats['2026-09'].total, 1);
  assert.equal(app.manager.getCurrentMonthMinutes(), 30);
});

test('repeated refresh removes synced records absent from the cloud and preserves offline records', async () => {
  const retained = saved('retained', MORNING, 13);
  const deleted = saved('deleted-remotely', EVENING, 7);
  const offline = saved(undefined, EVENING, 5, { localId: 'offline-local' });
  const app = harness({ local: [retained, deleted, offline], cloud: [retained], nested: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await app.manager.refreshFromCloud(), true);
    assert.deepEqual(app.ids(), ['retained']);
    assert.equal(app.records().length, 2);
    assert.ok(app.records().some(record => record.localId === 'offline-local' && !record._id));
    assert.equal(app.data().monthlyStats['2026-09'].total, 2);
    assert.equal(app.data().monthlyStats['2026-09'].totalDuration, 18);
    assert.equal(app.manager.getCurrentMonthMinutes(), 18);
  }
});

test('an empty cloud snapshot clears synced records and resets existing monthly totals and minute cache', async () => {
  const app = harness({ local: [saved('evening', EVENING, 7), saved('morning', MORNING, 13)], cloud: [] });
  app.data().monthlyStats['2026-09'] = {
    total: 2, count: 2, totalDuration: 20, days: ['2026-09-17', '2026-09-16']
  };
  app.manager.updateMonthlyCache(20);
  assert.equal(app.manager.getCurrentMonthMinutes(), 20);

  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.deepEqual(app.records(), []);
  assert.deepEqual(Object.keys(app.data().dailyRecords), []);
  assert.equal(app.data().monthlyStats['2026-09'].total, 0);
  assert.equal(app.data().monthlyStats['2026-09'].count, 0);
  assert.equal(app.data().monthlyStats['2026-09'].totalDuration, 0);
  assert.deepEqual(app.data().monthlyStats['2026-09'].days, []);
  assert.equal(app.manager.getCurrentMonthMinutes(), 0);
});

test('a cloud timestamp correction across months recalculates both old and new monthly statistics', async () => {
  const august = Date.parse('2026-08-31T20:39:00+08:00');
  const app = harness({ local: [saved('corrected', august, 7)], cloud: [saved('corrected', EVENING, 30)] });
  app.data().monthlyStats['2026-08'] = { total: 1, count: 1, totalDuration: 7, days: ['2026-08-31'] };

  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.deepEqual(Object.keys(app.data().dailyRecords), ['2026-09-16']);
  assert.equal(app.data().monthlyStats['2026-08'].total, 0);
  assert.equal(app.data().monthlyStats['2026-08'].count, 0);
  assert.equal(app.data().monthlyStats['2026-08'].totalDuration, 0);
  assert.deepEqual(app.data().monthlyStats['2026-08'].days, []);
  assert.equal(app.data().monthlyStats['2026-09'].total, 1);
  assert.equal(app.data().monthlyStats['2026-09'].count, 1);
  assert.equal(app.data().monthlyStats['2026-09'].totalDuration, 30);
  assert.deepEqual(app.data().monthlyStats['2026-09'].days, ['2026-09-16']);
  assert.equal(app.manager.getCurrentMonthMinutes(), 30);
});

test('a legacy cloud record without a timestamp does not inherit an obsolete cached time', async () => {
  const app = harness({
    local: [saved('legacy', MORNING, 7)],
    cloud: [{ _id: 'legacy', date: '2026-09-16', duration: 12 }]
  });
  assert.equal(await app.manager.refreshFromCloud(), true);
  const [record] = homeCheckin.buildCheckinRecords(app.data());
  assert.equal(record.date, '2026-09-16');
  assert.equal(record.time, '时间未记录');
  assert.equal(record.duration, 12);
});

test('invalid cloud durations use the manual-sync zero fallback consistently on every refresh', async () => {
  const cloud = [saved('valid', EVENING, 12), saved('legacy-string', MORNING, '7')];
  const app = harness({ cloud });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await app.manager.refreshFromCloud(), true);
    assert.equal(app.records().find(record => record._id === 'legacy-string').duration, 0);
    assert.equal(app.data().monthlyStats['2026-09'].totalDuration, 12);
    assert.equal(app.manager.getCurrentMonthMinutes(), 12);
  }
});

for (const method of ['safeRecoverFromCloud', 'recoverUserDataFromCloud']) {
  test(`${method} also reconciles stale records and refreshes the unexpired minute cache`, async () => {
    const app = harness({
      local: [saved('corrected', MORNING, 7), saved('deleted', EVENING, 13)],
      cloud: [saved('corrected', MORNING, 30)]
    });
    app.manager.updateMonthlyCache(20);
    assert.equal(app.manager.getCurrentMonthMinutes(), 20);
    assert.equal(await app.manager[method](USER_ID), true);
    assert.deepEqual(app.ids(), ['corrected']);
    assert.equal(app.records()[0].duration, 30);
    assert.equal(app.data().monthlyStats['2026-09'].total, 1);
    assert.equal(app.manager.getCurrentMonthMinutes(), 30);
  });
}

test('concurrent refreshes share one cloud read and a completed request allows another refresh', async () => {
  const response = deferred();
  const app = harness({ read: index => index === 0 ? response.promise : { success: true, data: [] } });
  const first = app.manager.refreshFromCloud();
  const second = app.manager.refreshFromCloud();
  assert.strictEqual(first, second);
  assert.equal(app.calls.reads, 1);
  response.resolve({ success: true, data: [saved('evening', EVENING)] });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.equal(app.calls.reads, 2);
  assert.deepEqual(app.ids(), []);
});

for (const failure of ['response', 'exception', 'malformed']) {
  test(`${failure} failure preserves local data and releases the refresh lock for retry`, async () => {
    const morning = saved('morning', MORNING, 13);
    const app = harness({ local: [morning], read(index) {
      if (index) return { success: true, data: [morning, saved('evening', EVENING)] };
      if (failure === 'exception') throw new Error('offline');
      return failure === 'response' ? { success: false, error: 'offline' } : { success: true, data: null };
    } });
    const before = clone(app.storage.get(STORAGE_KEY));
    assert.equal(await app.manager.refreshFromCloud(), false);
    assert.deepEqual(app.storage.get(STORAGE_KEY), before);
    assert.equal(app.calls.writes, 0);
    assert.equal(await app.manager.refreshFromCloud(), true);
    assert.deepEqual(app.ids(), ['evening', 'morning']);
  });
}

test('a logged-out user does not query or modify cloud-backed cache', async () => {
  const app = harness({ local: [saved('morning', MORNING)] });
  app.storage.set('userOpenId', 'local-only');
  assert.equal(await app.manager.refreshFromCloud(), false);
  assert.equal(app.calls.reads, 0);
  assert.equal(app.calls.writes, 0);
});

for (const change of ['openid', 'localId', 'logout']) {
  test(`a pending response cannot write after ${change} changes`, async () => {
    const response = deferred();
    const app = harness({ local: [saved('morning', MORNING)], read: () => response.promise });
    const before = clone(app.storage.get(STORAGE_KEY));
    const refresh = app.manager.refreshFromCloud();
    if (change === 'openid') app.storage.set('userOpenId', 'oz-different-user');
    if (change === 'localId') app.storage.set('localUserId', 'local-different-user');
    if (change === 'logout') app.storage.delete('userOpenId');
    response.resolve({ success: true, data: [saved('evening', EVENING)] });
    assert.equal(await refresh, false);
    assert.equal(app.calls.writes, 0);
    assert.deepEqual(app.storage.get(STORAGE_KEY), before);
  });
}

test('a local check-in and its cloud identity arriving during refresh survive the bounded retry', async () => {
  const firstRead = deferred();
  const uploaded = deferred();
  const morning = saved('morning', MORNING, 13);
  const app = harness({ local: [morning],
    read: index => index === 0 ? firstRead.promise : { success: true, data: [morning, saved('evening', EVENING)] },
    backup: () => uploaded.promise
  });
  const refresh = app.manager.refreshFromCloud();
  const added = app.manager.recordCheckin(5, [], [{ text: '新体验' }], NOW - 60000);
  uploaded.resolve({ success: true, data: { recordId: 'just-uploaded' } });
  await app.manager.asyncBackupToCloud(5, [], [{ text: '新体验' }], NOW - 60000, added.localId);
  firstRead.resolve({ success: true, data: [morning] });
  assert.equal(await refresh, true);
  assert.equal(app.calls.reads, 2);
  assert.deepEqual(app.ids(), ['evening', 'just-uploaded', 'morning']);
  assert.ok(app.records().some(record => record.localId === added.localId && record.experience[0].text === '新体验'));
});

test('a deletion completed during a refresh is not restored by the stale response', async () => {
  const response = deferred();
  const evening = saved('evening', EVENING, 7, { localId: 'evening-local' });
  const app = harness({ local: [evening], read: index => index === 0 ? response.promise : { success: true, data: [] } });
  const refresh = app.manager.refreshFromCloud();
  assert.equal((await app.manager.deleteCheckin('2026-09-16', { recordId: evening._id, localId: evening.localId })).success, true);
  response.resolve({ success: true, data: [evening] });
  assert.equal(await refresh, true);
  assert.equal(app.calls.reads, 2);
  assert.deepEqual(app.records(), []);
});

test('refresh does not replace record identities while deletion remains in flight', async () => {
  const response = deferred();
  const removed = deferred();
  const evening = saved('evening', EVENING, 7, { localId: 'evening-local' });
  const app = harness({ local: [evening], read: () => response.promise, remove: () => removed.promise });
  const refresh = app.manager.refreshFromCloud();
  const deletion = app.manager.deleteCheckin('2026-09-16', { localId: evening.localId });
  response.resolve({ success: true, data: [evening] });
  assert.equal(await refresh, false);
  assert.equal(app.records()[0].localId, evening.localId);
  assert.equal(app.calls.writes, 0);
  removed.resolve({ success: true });
  assert.equal((await deletion).success, true);
  assert.deepEqual(app.records(), []);
});

for (const method of ['safeRecoverFromCloud', 'recoverUserDataFromCloud']) {
  for (const firstCompletion of ['refresh', 'recovery']) {
    test(`${method} and refresh preserve offline records when ${firstCompletion} commits first`, async () => {
      const statsResponse = deferred();
      const statsStarted = deferred();
      const refreshResponse = deferred();
      const evening = saved('evening', EVENING);
      const offline = saved(undefined, MORNING, 13, { localId: 'offline-local', experience: ['offline-note'] });
      const app = harness({ local: [offline], nested: true,
        read: index => index === 1 ? refreshResponse.promise : { success: true, data: [evening] },
        stats() { statsStarted.resolve(); return statsResponse.promise; }
      });
      app.storage.get(STORAGE_KEY).experienceRecords = { 'offline-note': { text: '离线体验' } };
      const recovery = app.manager[method](USER_ID);
      await statsStarted.promise;
      const refresh = app.manager.refreshFromCloud();
      if (firstCompletion === 'refresh') {
        refreshResponse.resolve({ success: true, data: [evening] });
        assert.equal(await refresh, true);
        statsResponse.resolve({ success: true, data: {} });
        assert.equal(await recovery, false);
      } else {
        statsResponse.resolve({ success: true, data: {} });
        assert.equal(await recovery, true);
        refreshResponse.resolve({ success: true, data: [evening] });
        assert.equal(await refresh, true);
      }
      assert.equal(app.records().length, 2);
      assert.deepEqual(app.ids(), ['evening']);
      assert.ok(app.records().some(record => record.localId === 'offline-local'));
      assert.equal(app.storage.get(STORAGE_KEY).experienceRecords['offline-note'].text, '离线体验');
    });
  }
}
