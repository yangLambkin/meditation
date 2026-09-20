const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let state = { meditation_records: clone(options.records || []), user_stats: [] };
  if (!options.missingLockCollection) state.meditation_locks = [];
  let queue = Promise.resolve();
  const calls = { creates: [], writes: 0, transactions: 0, lockReads: 0 };
  function assertCollection(name, data) {
    if (!data[name]) throw options.missingError || { errCode: -502005, errMsg: 'document.get:fail database collection not exists' };
  }
  function collection(name, data, inTransaction) {
    function query(filter = {}) {
      let offset = 0, limit = Infinity;
      return {
        where(value) { return query(value); }, orderBy() { return this; },
        skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
        async get() {
          assertCollection(name, data);
          return { data: clone(data[name].filter(row => Object.entries(filter).every(([key, value]) => row[key] === value))
            .sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + limit)) };
        }
      };
    }
    return { ...query(), doc(id) { return {
      async get() {
        if (name === 'meditation_locks') {
          calls.lockReads++;
          if (options.readError) throw options.readError;
          if (inTransaction && options.alwaysStaleSnapshot) return { data: { _id: id, revision: 999 } };
        }
        assertCollection(name, data);
        const row = data[name].find(row => row._id === id);
        if (!row && options.documentError) throw options.documentError;
        return { data: clone(row) || null };
      },
      async set({ data: record }) {
        assert.ok(inTransaction, 'Records, statistics and revision must be written in a transaction');
        assertCollection(name, data);
        if (name === 'user_stats' && options.failStats) throw { errCode: -502003, errMsg: 'statistics permission denied' };
        calls.writes++;
        const index = data[name].findIndex(row => row._id === id);
        if (index < 0) data[name].push({ ...clone(record), _id: id });
        else data[name][index] = { ...clone(record), _id: id };
        return { _id: id };
      },
      async update({ data: patch }) {
        assert.ok(inTransaction);
        const row = data[name].find(row => row._id === id);
        if (!row) throw new Error('document not found');
        Object.entries(patch).forEach(([key, value]) => row[key] = clone(value && value.$set !== undefined ? value.$set : value));
        calls.writes++;
        return { stats: { updated: 1 } };
      }
    }; } };
  }
  const database = {
    command: { set: value => ({ $set: value }) },
    collection: name => collection(name, state, false),
    async createCollection(name) {
      calls.creates.push(name);
      assert.equal(name, 'meditation_locks', 'Self-healing may only create the auxiliary lock collection');
      if (options.createError) throw options.createError;
      if (!options.keepMissingAfterCreate) state[name] = [];
      // Simulates another cloud-function instance winning the create race.
      if (options.alreadyExistsError) throw options.alreadyExistsError;
      return { errMsg: 'createCollection:ok' };
    },
    runTransaction(callback) {
      calls.transactions++;
      const current = queue.then(async () => {
        const pending = clone(state);
        const result = await callback({ collection: name => collection(name, pending, true) });
        state = pending;
        return result;
      });
      queue = current.catch(() => {});
      return current;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/meditationManager/index.js'), 'utf8'), {
    module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => database, getWXContext: () => ({ OPENID: options.openid === undefined ? 'owner' : options.openid }) };
    }
  });
  return {
    calls, get state() { return clone(state); },
    async record(data = {}) { return clone(await module.exports.main({ type: 'recordMeditation', data: { duration: 10, localId: 'one-session', ...data } })); },
    async preview() { return clone(await module.exports.main({ type: 'migrateBusinessDates' })); }
  };
}

test('a missing auxiliary collection is created before atomically saving one record and its statistics', async () => {
  const missingErrors = [
    { errCode: -502005 },
    { code: '-502005' },
    { code: 'DATABASE_COLLECTION_NOT_EXIST' },
    { errCode: 'TCB_DB_COLLECTION_NOT_EXISTS' },
    { errMsg: 'document.get:fail DATABASE_COLLECTION_NOT_EXIST' },
    { message: 'document.get:fail database collection not exists' },
    { message: 'collection meditation_locks does not exist' },
    { errMsg: '集合 meditation_locks 不存在' }
  ];
  for (const missingError of missingErrors) {
    const app = harness({ missingLockCollection: true, missingError });
    const result = await app.record();
    assert.equal(result.success, true, JSON.stringify(missingError));
    assert.deepEqual(app.calls.creates, ['meditation_locks']);
    assert.equal(app.state.meditation_records.length, 1);
    assert.equal(app.state.user_stats[0].totalCount, 1);
    assert.equal(app.state.user_stats[0].totalDuration, 10);
    assert.equal(app.state.meditation_locks[0].revision, 1);
    assert.equal((await app.record()).data.duplicate, true);
    assert.equal(app.state.user_stats[0].totalCount, 1);
  }
});

test('concurrent first uploads initialize once, deduplicate repeated sessions and preserve distinct totals', async () => {
  const app = harness({ missingLockCollection: true });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => app.record({ localId: `session-${index % 2}` })));
  assert.ok(results.every(result => result.success));
  assert.deepEqual(app.calls.creates, ['meditation_locks']);
  assert.equal(app.state.meditation_records.length, 2);
  assert.equal(app.state.user_stats[0].totalCount, 2);
  assert.equal(app.state.user_stats[0].totalDuration, 20);
  assert.equal(app.state.meditation_locks[0].revision, 2);
});

test('a collection concurrently created by another instance is reread and used safely', async () => {
  for (const alreadyExistsError of [
    { errCode: 'DATABASE_COLLECTION_EXIST' },
    { code: 'DATABASE_COLLECTION_ALREADY_EXISTS' },
    { errCode: -502001, errMsg: 'createCollection:fail collection already exists' },
    { message: 'Table meditation_locks already exists' }
  ]) {
    const app = harness({ missingLockCollection: true, alreadyExistsError });
    assert.equal((await app.record()).success, true);
    assert.equal(app.state.meditation_records.length, 1);
    assert.equal(app.state.user_stats[0].totalCount, 1);
    assert.ok(app.calls.lockReads >= 3, 'The lock is reread after creation and within the transaction');
  }
});

test('creation permission or transient errors return an explicit failure and can be retried later', async () => {
  for (const createError of [
    { errCode: -502003, errMsg: 'createCollection:fail database permission denied' },
    { code: 'ECONNRESET', message: 'network unavailable' },
    { errCode: -502001, errMsg: 'createCollection:fail unknown database request failure' }
  ]) {
    const options = { missingLockCollection: true, createError };
    const app = harness(options);
    const result = await app.record();
    assert.equal(result.success, false);
    assert.equal(result.code, 'LOCK_COLLECTION_UNAVAILABLE');
    assert.match(result.error, /无法初始化记录锁集合/);
    assert.equal(app.calls.transactions, 0);
    assert.equal(app.calls.writes, 0);
    assert.equal(app.state.meditation_records.length, 0);
    delete options.createError;
    assert.equal((await app.record()).success, true, 'A failed initialization cannot poison the warm instance');
  }
});

test('read permission, network and generic failures are not treated as a missing collection', async () => {
  for (const readError of [
    { errCode: -502003, errMsg: 'document.get:fail database permission denied' },
    { code: 'ECONNRESET', message: 'network unavailable' },
    { errCode: -502001, errMsg: 'document.get:fail database request failed' },
    { message: 'resource not found' },
    { errMsg: 'document.get:fail database does not exist' },
    { errMsg: 'document.get:fail resource not found' }
  ]) {
    const app = harness({ readError });
    const result = await app.record();
    assert.equal(result.success, false);
    assert.ok(result.error, 'SDK errMsg must be returned to the client even without Error.message');
    assert.deepEqual(app.calls.creates, []);
    assert.equal(app.calls.writes, 0);
  }
});

test('missing documents are normal first writes and do not cause collection creation', async () => {
  for (const documentError of [
    { code: 'DATABASE_DOCUMENT_NOT_EXIST' },
    { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' },
    { errMsg: 'document.get:fail document with _id lock_test does not exist' },
    { message: 'document.get:fail collection meditation_locks document lock_test not found' }
  ]) {
    const app = harness({ documentError });
    assert.equal((await app.record()).success, true, JSON.stringify(documentError));
    assert.deepEqual(app.calls.creates, []);
    assert.equal(app.state.meditation_records.length, 1);
  }
});

test('a collection still missing after creation does not permit a record write', async () => {
  const app = harness({ missingLockCollection: true, keepMissingAfterCreate: true });
  assert.equal((await app.record()).success, false);
  assert.equal(app.calls.transactions, 0);
  assert.equal(app.calls.writes, 0);
});

test('statistics failure after self-healing still rolls back the complete record transaction', async () => {
  const app = harness({ missingLockCollection: true, failStats: true });
  const result = await app.record();
  assert.equal(result.success, false);
  assert.equal(result.code, -502003);
  assert.equal(result.error, 'statistics permission denied');
  assert.equal(app.state.meditation_records.length, 0);
  assert.equal(app.state.user_stats.length, 0);
  assert.deepEqual(app.state.meditation_locks, []);
});

test('continually stale snapshots stop after bounded retries without writing an incorrect total', async () => {
  const app = harness({ missingLockCollection: true, alwaysStaleSnapshot: true });
  const result = await app.record();
  assert.equal(result.success, false);
  assert.equal(result.code, 'RETRY_REQUIRED');
  assert.equal(app.calls.transactions, 12);
  assert.equal(app.calls.writes, 0);
  assert.deepEqual(app.calls.creates, ['meditation_locks']);
  assert.equal(app.state.meditation_records.length, 0);
  assert.equal(app.state.user_stats.length, 0);
});

test('maintenance dry run remains read-only when the lock collection is missing', async () => {
  const app = harness({ openid: '', missingLockCollection: true, records: [
    { _id: 'old', _openid: 'owner', date: '2026-09-19', timestamp: Date.parse('2026-09-20T01:00:00+08:00'), duration: 10 }
  ] });
  const before = app.state;
  const result = await app.preview();
  assert.equal(result.success, true);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.users.length, 1);
  assert.deepEqual(app.state, before);
  assert.deepEqual(app.calls.creates, []);
  assert.equal(app.calls.lockReads, 0);
  assert.equal(app.calls.transactions, 0);
  assert.equal(app.calls.writes, 0);
});

test('an upload belonging to another account is rejected before any database operation', async () => {
  const app = harness({ missingLockCollection: true });
  for (const expectedOpenid of ['previous-owner', '', null, 42]) {
    const result = await app.record({ expectedOpenid });
    assert.equal(result.success, false);
    assert.equal(result.code, 'ACCOUNT_CHANGED');
    assert.equal(app.calls.lockReads, 0);
    assert.deepEqual(app.calls.creates, []);
    assert.equal(app.calls.writes, 0);
  }
  assert.equal((await app.record({ expectedOpenid: 'owner' })).success, true);
  assert.equal((await app.record({ localId: 'legacy-client' })).success, true);
  assert.equal(app.state.meditation_records.length, 2);
});
