const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const OPENID = 'owner';
const NOW = Date.parse('2026-09-17T04:00:00Z');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function record(id, date, duration = 10, extra = {}) {
  return { _id: id, _openid: OPENID, date, duration, timestamp: Date.parse(`${date}T04:00:00Z`), ...extra };
}

function createHarness(records, stats = [], options = {}) {
  let now = NOW;
  class Clock extends FixedDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let stored = clone({ meditation_records: records, user_stats: stats, meditation_locks: options.receipts || [],
    users: options.users || [], bijing_bindings: options.bindings || [], bijing_sync_errors: options.syncErrors || [] });
  const queries = [];
  const writes = [];
  let transactionCount = 0;
  const database = {
    command: { set: value => ({ replace: clone(value) }) },
    collection(name) {
      return {
        doc(id) { return { async get() { return { data: clone(stored[name].find(row => row._id === id)) || null }; } }; },
        where(filter) {
          let offset = 0, limit = 20;
          return {
            orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
            async get() {
              queries.push({ name, offset, limit });
              if (options.fail === 'read') throw new Error('query unavailable');
              const rows = stored[name].filter(row => row._openid === filter._openid).sort((a, b) => a._id.localeCompare(b._id));
              return { data: clone(rows.slice(offset, offset + limit)) };
            }
          };
        }
      };
    },
    async runTransaction(callback) {
      transactionCount++;
      const pending = clone(stored);
      const transaction = {
        collection(name) {
          assert.ok(Object.hasOwn(pending, name));
          return {
            where() { throw new Error('Transactions must use doc APIs'); },
            doc(id) {
              return {
                async get() {
                  if (options.fail === 'receipt-read' && id.startsWith('md_')) throw new Error('receipt read unavailable');
                  return { data: clone(pending[name].find(row => row._id === id)) || null };
                },
                async set({ data }) {
                  writes.push({ name, id, action: 'set' });
                  if (name === 'bijing_sync_errors' && options.fail === 'sync-queue') throw new Error('sync queue unavailable');
                  if (options.fail === 'add') throw new Error('stats insert unavailable');
                  if (options.fail === 'receipt-write' && id.startsWith('md_')) throw new Error('receipt write unavailable');
                  if (options.fail === 'tombstone-write' && id.startsWith('mt_')) throw new Error('tombstone write unavailable');
                  const index = pending[name].findIndex(row => row._id === id);
                  if (index < 0) pending[name].push({ _id: id, ...clone(data) });
                  else pending[name][index] = { _id: id, ...clone(data) };
                  return { _id: id };
                },
                async remove() {
                  writes.push({ name, id, action: 'remove' });
                  if (options.fail === 'remove') throw new Error('delete unavailable');
                  if (options.fail === 'remove-zero') return { stats: { removed: 0 } };
                  const index = pending[name].findIndex(row => row._id === id);
                  if (index < 0) return { stats: { removed: 0 } };
                  pending[name].splice(index, 1);
                  return { stats: { removed: 1 } };
                },
                async update({ data }) {
                  writes.push({ name, id, action: 'update' });
                  if (options.fail === 'update') throw new Error('stats unavailable');
                  if (options.fail === 'update-zero') return { stats: { updated: 0 } };
                  const target = pending[name].find(row => row._id === id);
                  if (!target) return { stats: { updated: 0 } };
                  for (const [key, value] of Object.entries(data)) {
                    if (value && Object.hasOwn(value, 'replace')) target[key] = clone(value.replace);
                    // Model database object updates merging nested keys unless command.set is used.
                    else if (key === 'monthlyStats') target[key] = { ...target[key], ...clone(value) };
                    else target[key] = clone(value);
                  }
                  return { stats: { updated: 1 } };
                }
              };
            },
            async add() { throw new Error('Transactions must use doc APIs'); }
          };
        }
      };
      const result = await callback(transaction);
      if (options.fail === 'commit') throw new Error('commit failed');
      stored = pending;
      return result;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, Date: Clock, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === './syncQueue') return require('../cloudfunctions/meditationManager/syncQueue');
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database,
        getWXContext: () => ({ OPENID: options.openid === undefined ? OPENID : options.openid }) };
    }
  });
  return {
    queries, writes,
    get records() { return clone(stored.meditation_records); },
    get stats() { return clone(stored.user_stats); },
    get syncErrors() { return clone(stored.bijing_sync_errors); },
    clearSyncErrors() { stored.bijing_sync_errors = []; },
    setNow(value) { now = Date.parse(value); },
    get receipts() { return clone(stored.meditation_locks.filter(row => row.kind === 'deletion_receipt')); },
    get tombstones() { return clone(stored.meditation_locks.filter(row => row.kind === 'record_tombstone')); },
    get transactionCount() { return transactionCount; },
    async remove(data, extra = {}) {
      return clone(await module.exports.main({ type: 'deleteMeditationRecord', data, ...extra }));
    },
    async edit(data) {
      return clone(await module.exports.main({ type: 'editMeditationRecord', data }));
    },
    async record(data) {
      return clone(await module.exports.main({ type: 'recordMeditation', data }));
    }
  };
}


const editInput = (target, changes = {}, requestId = 'edit-one') => ({
  recordId: target._id, localId: target.localId, timestamp: target.timestamp, date: target.date,
  expectedOpenid: OPENID, requestId,
  updates: { timestamp: typeof target.timestamp === 'number' ? target.timestamp : Date.parse(target.timestamp), duration: target.duration, reflection: '新的感悟', ...changes }
});

test('edit updates an owned record in place, preserves identity/emotion and replaces experiences and stats', async () => {
  const target = record('one', '2026-09-17', 10, { localId: 'local-one', idempotencyKey: 'local-one', emotion: ['平静'], experience: ['old-reference'] });
  const foreign = record('foreign', '2026-09-17', 90, { _openid: 'other' });
  const app = createHarness([target, foreign]);
  const result = await app.edit(editInput(target, { duration: 25 }));
  assert.equal(result.success, true);
  assert.match(result.data.editId, /^me_[a-f0-9]{64}$/);
  assert.equal(result.data.previousDate, target.date);
  const saved = app.records.find(row => row._id === target._id);
  assert.equal(saved.localId, target.localId);
  assert.equal(saved.idempotencyKey, target.idempotencyKey);
  assert.deepEqual(saved.emotion, ['平静']);
  assert.deepEqual(saved.experience.map(row => row.text), ['新的感悟']);
  assert.equal(saved.experienceEdited, true);
  assert.deepEqual(app.records.find(row => row._id === 'foreign'), foreign);
  assert.equal(app.stats[0].totalCount, 1);
  assert.equal(app.stats[0].totalDuration, 25);
  assert.equal(app.records.length, 2);
});

test('edit retries have a stable receipt, reject changed payloads, and never downgrade stable IDs to matching timestamps', async () => {
  const target = record('one', '2026-09-17', 10);
  const app = createHarness([target]);
  const input = editInput(target, { reflection: '' });
  const first = await app.edit(input);
  const writes = app.writes.length;
  const repeated = await app.edit(input);
  assert.equal(repeated.success, true);
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.editId, first.data.editId);
  assert.equal(app.writes.length, writes);
  assert.deepEqual(app.records[0].experience, []);
  assert.equal((await app.edit({ ...input, updates: { ...input.updates, duration: 11 } })).code, 'REQUEST_ID_REUSED');
  assert.equal((await app.edit({ ...input, recordId: 'missing', requestId: 'edit-missing' })).code, 'RECORD_NOT_FOUND');
  assert.equal(app.stats[0].totalDuration, 10);
});

test('edit rejects foreign, unauthenticated, switched-account, ambiguous and malformed requests without writes', async () => {
  const target = record('one', '2026-09-17');
  const app = createHarness([target, { ...target, _id: 'two' }, record('foreign', '2026-09-17', 90, { _openid: 'other' })]);
  assert.equal((await app.edit(editInput({ ...target, _id: 'foreign' }))).code, 'RECORD_NOT_FOUND');
  assert.equal((await app.edit({ ...editInput(target), expectedOpenid: 'other' })).code, 'ACCOUNT_CHANGED');
  assert.equal((await app.edit({ ...editInput(target), recordId: undefined })).code, 'AMBIGUOUS_RECORD');
  for (const updates of [{ duration: 1.5 }, { duration: 0 }, { duration: 1441 }, { timestamp: NOW + 1 }, { reflection: 'a'.repeat(5001) }]) {
    assert.equal((await app.edit(editInput(target, updates))).code, 'INVALID_RECORD');
  }
  assert.equal((await app.edit({ ...editInput(target), requestId: '' })).code, 'INVALID_REQUEST_ID');
  assert.equal(app.writes.length, 0);
  const loggedOut = createHarness([target], [], { openid: '' });
  assert.equal((await loggedOut.edit(editInput(target))).code, 'AUTH_REQUIRED');
});

test('manual historical dates stay authoritative without a time change, while changed times respect 02:00 and authorized dates', async () => {
  const target = record('one', '2026-08-30', 10, { source: 'manual', timestamp: Date.parse('2026-09-01T04:00:00.123Z') });
  const app = createHarness([target]);
  assert.equal((await app.edit(editInput(target))).data.date, '2026-08-30');
  assert.equal(app.records[0].timestamp, target.timestamp);
  assert.equal((await app.edit(editInput(target, { timestamp: Date.parse('2026-08-30T16:30:00Z') }, 'edit-old-day'))).data.date, '2026-08-30');
  const denied = await app.edit(editInput(target, { timestamp: Date.parse('2026-09-01T04:00:00Z') }, 'edit-other-history'));
  assert.equal(denied.code, 'DATE_OUT_OF_RANGE');
  const changed = await app.edit(editInput(target, { timestamp: Date.parse('2026-09-16T17:30:00Z') }, 'edit-yesterday'));
  assert.equal(changed.success, true);
  assert.equal(changed.data.date, '2026-09-16');
  assert.equal(app.stats[0].monthlyStats['2026-08'], undefined);
  assert.equal(app.stats[0].monthlyStats['2026-09'].totalDuration, 10);
});

test('backfill edits cannot move to another date or increase a day beyond 24 hours; note-only edits retain legacy excess', async () => {
  const target = record('one', '2026-08-30', 30, { source: 'manual', backfillRequestId: 'br_grant', recordType: 'backfill' });
  const app = createHarness([target, record('two', '2026-08-30', 1410)]);
  assert.equal((await app.edit(editInput(target, { timestamp: Date.parse('2026-09-17T04:00:00Z') }))).code, 'DATE_OUT_OF_RANGE');
  assert.equal((await app.edit(editInput(target, { duration: 31 }))).code, 'DAILY_DURATION_EXCEEDED');
  const excess = createHarness([target, record('two', '2026-08-30', 1440)]);
  assert.equal((await excess.edit(editInput(target))).success, true);
});

test('cross-day editing atomically queues both historical day totals including zero, and repeated edits refresh the same day queue', async () => {
  const target = record('one', '2026-09-15', 30);
  const user = { _id: 'profile', _openid: OPENID, bijingBound: true, bijingStudentNumber: 'B1234' };
  const app = createHarness([target], [], { users: [user] });
  const input = editInput(target, { timestamp: Date.parse('2026-09-16T17:00:00Z'), duration: 40 });
  const first = await app.edit(input);
  assert.equal(first.success, true);
  assert.equal(first.data.previousDate, '2026-09-15');
  assert.equal(first.data.date, '2026-09-16');
  const days = Object.fromEntries(app.syncErrors.map(row => [row.recordDate, row.expectedDurationMinutes]));
  assert.deepEqual(days, { '2026-09-15': 0, '2026-09-16': 40 });
  for (const queued of app.syncErrors) {
    assert.equal(queued.zeroEligible, true, 'the existing scheduled repair can clear the original empty day');
    assert.equal(queued.openid, OPENID);
    assert.equal(queued.userId, user._id);
    assert.equal(queued.studentNumber, user.bijingStudentNumber);
    assert.match(queued.queueVersion, /^[a-f0-9]{32}$/);
  }
  const queued = app.syncErrors;
  const writes = app.writes.length;
  const replay = await app.edit(input);
  assert.equal(replay.success, true);
  assert.equal(replay.data.duplicate, true);
  assert.deepEqual(app.syncErrors, queued, 'a repeated confirmation cannot replace the durable repair version');
  assert.equal(app.writes.length, writes);
  const second = await app.edit(editInput(target, { timestamp: Date.parse('2026-09-16T17:00:00Z'), duration: 50 }, 'edit-two'));
  assert.equal(second.success, true);
  assert.notEqual(second.data.editId, first.data.editId);
  assert.equal(app.syncErrors.find(row => row.recordDate === '2026-09-16').expectedDurationMinutes, 50);
  assert.notEqual(app.syncErrors.find(row => row.recordDate === '2026-09-16').queueVersion,
    queued.find(row => row.recordDate === '2026-09-16').queueVersion);
});

test('failed statistics or sync queue writes roll back record, receipts and statistics together', async () => {
  const target = record('one', '2026-09-16', 30);
  const stats = { _id: 'stats', _openid: OPENID, totalDuration: 30 };
  for (const fail of ['update', 'commit', 'sync-queue']) {
    const app = createHarness([target], [stats], { fail, users: [{ _id: 'profile', _openid: OPENID, bijingBound: true, bijingStudentNumber: 'B1234' }] });
    assert.equal((await app.edit(editInput(target, { duration: 40 }))).success, false);
    assert.deepEqual(app.records, [target]);
    assert.deepEqual(app.stats, [stats]);
    assert.deepEqual(app.syncErrors, []);
  }
});

test('stable record IDs cannot edit one physical row of a duplicate local identity group', async () => {
  const target = record('one', '2026-09-17', 30, { localId: 'same-source', experience: [{ text: '旧感悟' }] });
  const duplicate = record('two', '2026-09-16', 40, { idempotencyKey: 'same-source', experience: [{ text: '另一份旧感悟' }] });
  const app = createHarness([target, duplicate]);
  assert.equal((await app.edit(editInput(target, { reflection: '' }))).code, 'AMBIGUOUS_RECORD');
  assert.deepEqual(app.records, [target, duplicate]);
  assert.equal(app.writes.length, 0);
});

test('replaying an old edit cannot resurrect deleted records or overwrite a newer edit', async () => {
  const target = record('one', '2026-09-17', 30);
  const app = createHarness([target]);
  const original = editInput(target, { reflection: '首次修改' });
  assert.equal((await app.edit(original)).success, true);
  assert.equal((await app.edit(editInput(target, { reflection: '后来修改' }, 'edit-two'))).success, true);
  assert.equal((await app.edit(original)).code, 'EDIT_SUPERSEDED');
  assert.equal(app.records[0].experience[0].text, '后来修改');
  assert.equal((await app.remove({ recordId: target._id })).success, true);
  assert.equal((await app.edit(original)).code, 'RECORD_DELETED');
  assert.equal(app.records.length, 0);
});

test('a lost local-ID edit response can replay after cloud-ID discovery and cross-day movement', async () => {
  const target = record('one', '2026-09-15', 30, { localId: 'local-one' });
  const other = record('two', '2026-09-17', 30, { localId: 'local-two' });
  const app = createHarness([target, other]);
  const original = { ...editInput(target, { timestamp: Date.parse('2026-09-16T17:00:00Z') }), recordId: undefined };
  const saved = await app.edit(original);
  assert.equal(saved.success, true);
  assert.equal(saved.data.date, '2026-09-16');
  const upgraded = await app.edit({ ...original, recordId: target._id });
  assert.equal(upgraded.success, true);
  assert.equal(upgraded.data.duplicate, true);
  assert.equal(upgraded.data.editId, saved.data.editId);
  assert.equal((await app.edit({ ...original, recordId: other._id })).code, 'REQUEST_ID_REUSED');
  assert.equal((await app.edit({ ...original, localId: other.localId })).code, 'REQUEST_ID_REUSED');
  assert.equal(app.records.filter(row => row._id === target._id).length, 1);
});
