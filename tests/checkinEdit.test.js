const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-17T12:00:37.456+08:00');
const DATE = '2026-09-17';
const KEY = 'meditation_checkin_local-edit';
const clone = value => value === undefined ? value : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function record(extra = {}) {
  return { _id: 'cloud-edit', localId: 'local-record', date: DATE, timestamp: NOW,
    duration: 10, emotion: ['平静'], experience: [{ text: '旧感悟' }], ...extra };
}
const day = records => ({ count: records.length, records, lastCheckin: records.at(-1).timestamp });
function harness(data = {}, options = {}) {
  const storage = new Map(Object.entries({
    localUserId: 'local-edit', userOpenId: options.guest ? '' : 'oz-owner',
    cloud_ranking_cache: { old: true }, [KEY]: clone(data)
  }));
  const calls = { edit: [], backup: [], remove: [], reads: 0 };
  let failSave = false;
  function load(name) {
    const module = { exports: {} };
    const filename = path.join(__dirname, '../miniprogram/utils', name);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, Date: Clock, setTimeout, clearTimeout,
      console: { log() {}, warn() {}, error() {} },
      wx: {
        getStorageSync: key => clone(storage.get(key)),
        setStorageSync(key, value) {
          if (key === KEY && failSave) throw new Error('存储失败');
          storage.set(key, clone(value));
        },
        removeStorageSync: key => storage.delete(key),
        getNetworkType: ({ success }) => success({ networkType: 'wifi' }),
        ...(options.database ? { cloud: { database: options.database } } : {})
      },
      require(dependency) {
        const file = path.basename(dependency);
        if (['dateUtil.js', 'uploadNetwork.js', 'checkinReflection.js'].includes(file)) return load(file);
        if (file === 'badgeManager.js') return { checkBadgeUnlock: () => ({ hasNewUnlock: false }) };
        if (file === 'cloudApi.js') return {
          async editMeditationRecord(input) {
            calls.edit.push(clone(input));
            return options.edit ? options.edit(input) : { success: true, data: {
              recordId: input.recordId || 'confirmed-record', date: input.updates.timestamp === NOW ? DATE
                : new Date(input.updates.timestamp + 6 * 3600000).toISOString().slice(0, 10)
            } };
          },
          async recordMeditation(...args) {
            calls.backup.push(clone(args));
            return options.backup ? options.backup(...args) : { success: true, data: { recordId: 'new-cloud-record' } };
          },
          async deleteMeditationRecord(input) { calls.remove.push(clone(input)); return { success: true }; },
          async getAllRecords() { calls.reads++; return options.read ? options.read() : { success: true, data: [] }; }
        };
        throw new Error(`Unexpected require: ${dependency}`);
      }
    }, { filename });
    return module.exports;
  }
  return { manager: load('checkin.js'), storage, calls, failSave(value) { failSave = value; },
    records() { const stored = storage.get(KEY); return (stored.checkinRecords || stored).dailyRecords; } };
}
const updates = extra => ({ duration: 25, timestamp: NOW, reflection: ' 新感悟 ', ...extra });
const edit = (app, fields = updates(), identity = { recordId: 'cloud-edit', localId: 'local-record' }, date = DATE) =>
  app.manager.updateCheckin(date, identity, fields, { requestId: 'stable-edit-request' });

test('editable reflection reads the raw source and all its references instead of a partial list preview', async () => {
  const ref = `exp_${'a'.repeat(64)}`;
  const reads = [];
  const app = harness({ dailyRecords: { [DATE]: day([record({ experience: [{ text: '已显示' }, ref] })]) },
    experienceRecords: { [ref]: { _id: ref, text: '' } } }, { database: () => ({ collection(name) {
      assert.equal(name, 'experience_records');
      return { doc(id) { reads.push(id); return { get: async () => ({ data: {
        _id: id, _openid: 'oz-owner', text: '尚未缓存的原文'
      } }) }; } };
    } }) });
  const reflection = await app.manager.getEditableCheckinReflection(DATE, { recordId: 'cloud-edit' });
  assert.equal(reflection, '已显示\n\n尚未缓存的原文');
  assert.deepEqual(reads, [ref], 'empty legacy cache placeholders must still be fetched');
  const cached = harness({ dailyRecords: { [DATE]: day([record({ experience: [ref] })]) },
    experienceRecords: { [ref]: { _id: ref, text: '完整缓存原文' } } });
  assert.equal(cached.manager.getEditableCheckinReflection(DATE, { recordId: 'cloud-edit' }), '完整缓存原文');
});

test('editable reflection rejects late results when the account or source changes during a read', async () => {
  const ref = `exp_${'b'.repeat(64)}`;
  for (const change of ['account', 'source']) {
    const response = deferred();
    const original = { dailyRecords: { [DATE]: day([record({ experience: [ref] })]) } };
    const app = harness(original, { database: () => ({ collection: () => ({ doc: () => ({ get: () => response.promise }) }) }) });
    const reading = app.manager.getEditableCheckinReflection(DATE, { recordId: 'cloud-edit' });
    if (change === 'account') app.storage.set('userOpenId', 'oz-other');
    else {
      const stored = app.storage.get(KEY);
      stored.dailyRecords[DATE].records[0].experience = [{ text: '更新后的正文' }];
      app.storage.set(KEY, stored);
    }
    response.resolve({ data: { _openid: 'oz-owner', text: '过期原文' } });
    await assert.rejects(reading, /账号已变化|记录已更新/);
    assert.equal(app.calls.edit.length, 0);
  }
});

test('editing preserves the original identity, emotion and storage envelope while updating statistics', async () => {
  for (const nested of [false, true]) {
    const data = { businessDayVersion: 2, dailyRecords: { [DATE]: day([record(), record({ _id: 'other', localId: 'other', duration: 5 })]) },
      monthlyStats: {}, userStats: { badges: { earned: true } } };
    const app = harness(nested ? { checkinRecords: data, experienceRecords: { note: { text: '保留' } } }
      : { ...data, experienceRecords: { note: { text: '保留' } } });
    assert.equal((await edit(app)).success, true);
    const stored = app.storage.get(KEY);
    const result = stored.checkinRecords || stored;
    const edited = result.dailyRecords[DATE].records.find(item => item._id === 'cloud-edit');
    assert.equal(edited.localId, 'local-record');
    assert.equal(edited.timestamp, NOW);
    assert.deepEqual(edited.emotion, ['平静']);
    assert.deepEqual(edited.experience, [{ text: '新感悟', timestamp: NOW, duration: '25分钟', emotion: ['平静'] }]);
    assert.equal(edited.experienceEdited, true);
    assert.equal(result.dailyRecords[DATE].count, 2);
    assert.equal(result.monthlyStats['2026-09'].totalDuration, 30);
    assert.equal(result.userStats.totalCount, 2);
    assert.equal(result.userStats.totalDuration, 30);
    assert.deepEqual(result.userStats.badges, { earned: true });
    assert.equal(stored.experienceRecords.note.text, '保留');
    assert.equal(app.storage.get('meditation_monthly_stats_local-edit').totalMinutes, 30);
    assert.equal(app.storage.has('cloud_ranking_cache'), false);
    assert.equal(app.calls.edit[0].requestId, 'stable-edit-request');
    assert.equal(app.calls.edit[0].expectedOpenid, 'oz-owner');
    assert.equal(app.calls.remove.length, 0);
  }
});

test('never-uploaded guest records are edited locally and retain their fixed upload identity across months', async () => {
  const original = record({ _id: undefined, syncVersion: 1, syncSourceAttempted: false, syncStatus: 'pending',
    date: '2026-08-31', timestamp: Date.parse('2026-08-31T08:00:00+08:00') });
  const app = harness({ dailyRecords: { '2026-08-31': day([original]) }, monthlyStats: {} }, { guest: true });
  assert.equal((await edit(app, updates(), { localId: original.localId }, '2026-08-31')).success, true);
  assert.equal(app.calls.edit.length, 0);
  assert.equal(app.calls.backup.length, 0);
  assert.equal(app.records()['2026-08-31'], undefined);
  const edited = app.records()[DATE].records[0];
  assert.equal(edited.localId, original.localId);
  assert.equal(edited.syncSourceAttempted, false);
  assert.equal(edited.syncStatus, 'pending');
  assert.equal(app.storage.get(KEY).monthlyStats['2026-08'].totalDuration, 0);
  app.storage.set('userOpenId', 'oz-owner');
  await app.manager.retryPendingBackups();
  assert.equal(app.calls.backup.length, 1);
  assert.equal(app.calls.backup[0][0], 25);
  assert.equal(app.calls.backup[0][2][0].text, '新感悟');
  assert.equal(app.calls.backup[0][4], original.localId);
});

test('clearing reflection replaces legacy experience IDs and preserves a manual business date and exact seconds', async () => {
  const iso = new Date(NOW).toISOString();
  const app = harness({ dailyRecords: { '2026-09-16': day([record({ source: 'manual', date: '2026-09-16', timestamp: iso,
    experience: ['legacy-id'] })]) }, monthlyStats: {} }, { edit: () => ({ success: true, data: {
    recordId: 'cloud-edit', date: '2026-09-16', experience: []
  } }) });
  assert.equal((await edit(app, updates({ reflection: '' }), undefined, '2026-09-16')).success, true);
  assert.equal(app.calls.edit[0].timestamp, iso);
  assert.equal(app.calls.edit[0].updates.timestamp, NOW);
  assert.deepEqual(app.records()['2026-09-16'].records[0].experience, []);
  assert.equal(app.records()[DATE], undefined);
});

test('failed cloud or storage writes preserve the original record and stable retry identity', async () => {
  let failed = true;
  const data = { dailyRecords: { [DATE]: day([record()]) }, monthlyStats: {} };
  const app = harness(data, { edit: () => failed ? { success: false, code: 'CLOUD_TIMEOUT', error: '上传超时' }
    : { success: true, data: { recordId: 'cloud-edit', date: DATE } } });
  assert.equal((await edit(app)).code, 'CLOUD_TIMEOUT');
  assert.deepEqual(app.storage.get(KEY), data);
  failed = false;
  app.failSave(true);
  assert.equal((await edit(app)).success, false);
  assert.deepEqual(app.storage.get(KEY), data);
  app.failSave(false);
  assert.equal((await edit(app)).success, true);
  assert.deepEqual(app.calls.edit.map(input => input.requestId), Array(3).fill('stable-edit-request'));
});

test('edits wait for in-flight uploads and lock deletion, uploads and stale refreshes', async () => {
  const upload = deferred();
  const editing = deferred();
  const app = harness({}, { backup: () => upload.promise, edit: () => editing.promise });
  const saved = app.manager.recordCheckin(10, ['平静'], [], NOW);
  await tick();
  const pending = edit(app, updates(), { localId: saved.localId });
  assert.equal(app.calls.edit.length, 0);
  assert.equal((await app.manager.deleteCheckin(DATE, { localId: saved.localId })).success, false);
  upload.resolve({ success: true, data: { recordId: 'new-cloud-record' } });
  await tick();
  assert.equal(app.calls.edit[0].recordId, undefined);
  assert.equal(app.calls.edit[0].localId, saved.localId);
  assert.equal(await app.manager.refreshFromCloud(), false);
  assert.equal(app.calls.reads, 0);
  assert.equal((await edit(app, updates(), { localId: saved.localId })).code, 'RECORD_BUSY');
  editing.resolve({ success: true, data: { recordId: 'new-cloud-record', date: DATE } });
  assert.equal((await pending).success, true);
  assert.equal(app.records()[DATE].records[0].duration, 25);
  assert.equal(app.calls.remove.length, 0);
});

test('account changes while awaiting an upload or edit response never write under the next account', async () => {
  for (const phase of ['upload', 'edit']) {
    const response = deferred();
    const app = phase === 'upload' ? harness({}, { backup: () => response.promise })
      : harness({ dailyRecords: { [DATE]: day([record()]) }, monthlyStats: {} }, { edit: () => response.promise });
    const identity = phase === 'upload' ? { localId: app.manager.recordCheckin(10, [], [], NOW).localId } : undefined;
    await tick();
    const pending = edit(app, updates(), identity);
    app.storage.set('userOpenId', 'oz-next');
    response.resolve({ success: true, data: { recordId: phase === 'upload' ? 'new-cloud-record' : 'cloud-edit', date: DATE } });
    assert.equal((await pending).code, 'ACCOUNT_CHANGED');
    assert.equal(app.records()[DATE].records[0].duration, 10);
    if (phase === 'upload') assert.equal(app.calls.edit.length, 0);
  }
});

test('date moves obey the 02:00 boundary, backfill grant limits and daily duration limits', async () => {
  for (const extra of [{}, { recordType: 'backfill', backfillRequestId: 'grant' }]) {
    const app = harness({ dailyRecords: { [DATE]: day([record({ _id: undefined,
      syncVersion: 1, syncSourceAttempted: false, ...extra })]) }, monthlyStats: {} }, { guest: true });
    const timestamp = Date.parse('2026-09-17T01:30:00+08:00');
    const result = await edit(app, updates({ timestamp }), { localId: 'local-record' });
    assert.equal(result.success, !extra.recordType);
    if (result.success) assert.equal(app.records()['2026-09-16'].records[0].timestamp, timestamp);
    else assert.equal(app.calls.edit.length, 0);
  }
  const pending = { _id: undefined, syncVersion: 1, syncSourceAttempted: false };
  const tooOld = harness({ dailyRecords: { [DATE]: day([record(pending)]) }, monthlyStats: {} }, { guest: true });
  assert.equal((await edit(tooOld, updates({ timestamp: NOW - 3 * 86400000 }), { localId: 'local-record' })).code, 'DATE_OUT_OF_RANGE');
  assert.equal(tooOld.calls.edit.length, 0);
  const full = harness({ dailyRecords: { [DATE]: day([record(pending), record({ _id: 'large', localId: 'large', duration: 1430 })]) }, monthlyStats: {} }, { guest: true });
  assert.equal((await edit(full, updates(), { localId: 'local-record' })).code, 'DAILY_DURATION_EXCEEDED');
  assert.equal((await edit(full, updates({ duration: 10, reflection: '只改感悟' }), { localId: 'local-record' })).success, true);
});

test('invalid inputs and unconfirmed guest identities cannot silently change records', async () => {
  for (const fields of [updates({ timestamp: undefined }), updates({ timestamp: NOW + 1 }), updates({ duration: 0 }),
    updates({ duration: 1.5 }), updates({ reflection: '字'.repeat(5001) })]) {
    const app = harness({ dailyRecords: { [DATE]: day([record()]) }, monthlyStats: {} });
    assert.equal((await edit(app, fields)).success, false);
    assert.equal(app.calls.edit.length, 0);
    assert.equal(app.records()[DATE].records[0].duration, 10);
  }
  const guest = harness({ dailyRecords: { [DATE]: day([record({ _id: undefined, syncVersion: 1, syncSourceAttempted: true })]) }, monthlyStats: {} }, { guest: true });
  assert.equal((await edit(guest, updates(), { localId: 'local-record' })).code, 'AUTH_REQUIRED');
});

test('authoritative edited cloud reflections replace old cached text, including clearing across rebuilds', () => {
  const app = harness();
  const stored = { dailyRecords: { [DATE]: day([record()]) }, monthlyStats: {} };
  for (const experience of [[], [{ text: '另一台设备修改' }]]) {
    const merged = app.manager.mergeCloudRecordsIntoCache(stored, [record({ experience, experienceEdited: true })]);
    const cached = merged.checkinRecords.dailyRecords[DATE].records[0];
    assert.deepEqual(cached.experience, experience);
    assert.equal(cached.experienceEdited, true);
  }
});

test('a cloud snapshot relocates edited stable identities without retaining the old day or reflection', () => {
  const app = harness();
  const stored = { dailyRecords: { '2026-08-31': day([record({ source: 'manual', date: '2026-08-31' })]) },
    monthlyStats: { '2026-08': { total: 1, totalDuration: 10, days: ['2026-08-31'] } } };
  const remote = record({ source: 'manual', date: DATE, duration: 40, experience: [], experienceEdited: true });
  const merged = app.manager.mergeCloudRecordsIntoCache(stored, [remote]);
  assert.equal(merged.checkinRecords.dailyRecords['2026-08-31'], undefined);
  assert.equal(merged.checkinRecords.dailyRecords[DATE].count, 1);
  assert.deepEqual(merged.checkinRecords.dailyRecords[DATE].records[0].experience, []);
  assert.equal(merged.checkinRecords.userStats.totalCount, 1);
  assert.equal(merged.checkinRecords.monthlyStats['2026-08'].totalDuration, 0);
});

test('a retry confirms the same request after refresh already relocated and cloud-confirmed its local identity', async () => {
  const timestamp = Date.parse('2026-09-16T15:30:00+08:00');
  const original = { localId: 'local-record', timestamp: NOW };
  let remote;
  const app = harness({ dailyRecords: { [DATE]: day([record({ _id: undefined, syncVersion: 1, syncSourceAttempted: true })]) }, monthlyStats: {} }, {
    edit: input => {
      if (!remote) {
        remote = record({ date: '2026-09-16', source: 'manual', timestamp, duration: 25, experienceEdited: true,
          experience: [{ text: '新感悟' }] });
        return { success: false, code: 'CLOUD_TIMEOUT' };
      }
      return { success: true, data: { recordId: remote._id, date: remote.date, timestamp, duration: 25,
        previousDate: DATE, experience: remote.experience } };
    },
    read: () => ({ success: true, data: [remote] })
  });
  assert.equal((await edit(app, updates({ timestamp }), original)).code, 'CLOUD_TIMEOUT');
  assert.equal(await app.manager.refreshFromCloud(), true);
  assert.equal(app.records()[DATE], undefined);
  assert.equal((await edit(app, updates({ timestamp }), original)).success, true);
  assert.equal(app.calls.edit[0].recordId, undefined);
  assert.equal(app.calls.edit[1].recordId, undefined);
  assert.deepEqual(app.calls.edit[1], app.calls.edit[0]);
  assert.equal(app.records()['2026-09-16'].count, 1);
  assert.equal(app.storage.get(KEY).checkinRecords.userStats.totalCount, 1);
});

test('confirming a timestamp-only legacy edit collapses a cloud-confirmed copy discovered after timeout', async () => {
  const timestamp = NOW - 86400000;
  const original = record({ _id: undefined, localId: undefined });
  const confirmed = record({ _id: 'confirmed-legacy', localId: undefined, date: '2026-09-16', timestamp, duration: 25 });
  const app = harness({ dailyRecords: { [DATE]: day([original]), '2026-09-16': day([confirmed]) }, monthlyStats: {} }, {
    edit: () => ({ success: true, data: { recordId: confirmed._id, date: confirmed.date, timestamp, duration: 25,
      experience: [{ text: '新感悟' }], updatedAt: NOW } })
  });
  assert.equal((await edit(app, updates({ timestamp }), { timestamp: NOW })).success, true);
  assert.equal(app.records()[DATE], undefined);
  assert.equal(app.records()['2026-09-16'].count, 1);
  assert.equal(app.records()['2026-09-16'].records[0]._id, confirmed._id);
  assert.equal(app.storage.get(KEY).userStats.totalCount, 1);
});

test('an older edit receipt cannot overwrite a newer cached record or its reflection', async () => {
  const newer = record({ duration: 40, experience: [{ text: '较新的感悟' }], updatedAt: NOW });
  const data = { dailyRecords: { [DATE]: day([newer]) }, monthlyStats: {} };
  const app = harness(data, { edit: () => ({ success: true, data: { recordId: 'cloud-edit', date: DATE,
    timestamp: NOW, duration: 25, experience: [{ text: '旧编辑' }], updatedAt: NOW - 1 } }) });
  assert.equal((await edit(app)).code, 'EDIT_SUPERSEDED');
  assert.deepEqual(app.storage.get(KEY), data);
});

test('editing a known detail preserves historical counts whose details are unavailable', async () => {
  const app = harness({ dailyRecords: { [DATE]: { ...day([record()]), count: 3 },
    '2026-08-30': { count: 2 } }, monthlyStats: {} });
  assert.equal((await edit(app)).success, true);
  assert.equal(app.records()[DATE].count, 3);
  assert.equal(app.records()['2026-08-30'].count, 2);
  assert.equal(app.storage.get(KEY).userStats.totalCount, 5);
});

test('a suspended pre-edit snapshot must be reread and cannot restore old values after saving', async () => {
  const stale = deferred();
  let remote = record();
  const app = harness({ dailyRecords: { [DATE]: day([record()]) }, monthlyStats: {} }, {
    read: () => app.calls.reads === 1 ? stale.promise : { success: true, data: [remote] },
    edit: () => {
      remote = record({ duration: 25, experience: [{ text: '新感悟' }], experienceEdited: true });
      return { success: true, data: { recordId: remote._id, date: DATE, duration: remote.duration,
        timestamp: remote.timestamp, experience: remote.experience } };
    }
  });
  const refreshing = app.manager.refreshFromCloud();
  assert.equal((await edit(app)).success, true);
  stale.resolve({ success: true, data: [record()] });
  assert.equal(await refreshing, true);
  assert.equal(app.calls.reads, 2);
  assert.equal(app.records()[DATE].records[0].duration, 25);
  assert.deepEqual(app.records()[DATE].records[0].experience, [{ text: '新感悟' }]);
});
