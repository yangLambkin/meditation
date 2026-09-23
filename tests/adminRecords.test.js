const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');

const ADMIN = 'fixed-admin';
const OWNER = 'record-owner';
const DATE = '2026-09-22';
const PROFILE_FIELDS = { _id: true, _openid: true, nickName: true, bijingBound: true, bijingStudentNumber: true };
const RECORD_FIELDS = { _id: true, date: true, timestamp: true, duration: true, source: true,
  dateSource: true, localId: true, idempotencyKey: true };
const profile = (extra = {}) => ({ _id: 'user-001', _openid: OWNER, nickName: '静心者', ...extra });
const record = (index, extra = {}) => ({ _id: `record-${String(index).padStart(4, '0')}`, _openid: OWNER,
  date: DATE, timestamp: Date.parse(`${DATE}T12:00:00+08:00`) + index * 60000, duration: 10, source: 'timer', ...extra });

function harness(options = {}) {
  const users = options.users || [profile()];
  const records = options.records || [];
  const reads = [];
  const lockReads = [];
  let databaseReads = 0;
  const exports = {};
  const db = {
    command: { gt(value) { return { operator: 'gt', value }; } },
    collection(name) {
      if (name === 'meditation_locks') {
        let filter;
        let fields;
        let limit;
        return {
          where(value) { filter = value; return this; },
          field(value) { fields = value; return this; },
          limit(value) { limit = value; return this; },
          async get() {
            lockReads.push({ filter, fields, limit });
            if (options.onLockRead) options.onLockRead(lockReads.length, { users, records });
            if (options.lockError && (!options.failLockOnRead || options.failLockOnRead === lockReads.length)) throw options.lockError;
            if (options.invalidLockOnRead === lockReads.length) return {};
            return { data: options.missingLockDocument ? [] : [{ _id: filter._id, revision: options.revision || 0 }] };
          }
        };
      }
      assert.ok(['users', 'meditation_records'].includes(name));
      let filter;
      let fields;
      let limit;
      const ordering = [];
      return {
        where(value) { filter = value; return this; },
        field(value) { fields = value; return this; },
        orderBy(field, direction) { ordering.push([field, direction]); return this; },
        limit(value) { limit = value; return this; },
        async get() {
          reads.push({ name, filter, fields, limit, ordering });
          if (options.onRead) options.onRead(reads.length, { users, records });
          if (options.failOnRead === reads.length) throw new Error('private database connection details');
          if (options.invalidOnRead === reads.length) return {};
          let rows = (name === 'users' ? users : records).filter(row => Object.entries(filter).every(([key, value]) =>
            value && value.operator === 'gt' ? row[key] > value.value : row[key] === value));
          rows = rows.slice().sort((a, b) => {
            for (const [key, direction] of ordering) {
              const comparison = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
              if (comparison) return direction === 'desc' ? -comparison : comparison;
            }
            return 0;
          }).slice(0, limit);
          // Enforce the same projection as the database and preserve legacy Date values.
          return { data: rows.map(row => Object.fromEntries(Object.keys(fields).filter(key => Object.hasOwn(row, key))
            .map(key => [key, row[key]]))) };
        }
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: options.environment || { ADMIN_OPENID: ADMIN, MAINTENANCE_ADMIN_OPENIDS: 'maintenance' } },
    require(name) {
      if (name === './maintenanceAuth') return require('../cloudfunctions/adminManager/maintenanceAuth');
      if (name === './records') return require('../cloudfunctions/adminManager/records');
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test',
        getWXContext() { return options.context || { OPENID: ADMIN }; },
        database() { databaseReads++; return db; } };
    }
  });
  return { reads, lockReads, get databaseReads() { return databaseReads; },
    async run(event) { return JSON.parse(JSON.stringify(await exports.main(event))); },
    async search(nickname = '静心者', cursor) { return this.run({ type: 'adminSearchUsers', nickname, cursor }); },
    async day(extra = {}) { return this.run({ type: 'adminGetDayRecords', openid: OWNER, recordDate: DATE, ...extra }); }
  };
}

test('record queries require a configured server administrator before any database access', async () => {
  const contexts = [{ OPENID: 'ordinary' }, { OPENID: 'maintenance' }, {}, { SOURCE: 'wx_trigger' }];
  for (const context of contexts) {
    const app = harness({ context });
    for (const type of ['adminSearchUsers', 'adminGetDayRecords']) {
      const result = await app.run({ type, nickname: '静心者', openid: OWNER, recordDate: DATE,
        OPENID: ADMIN, ADMIN_OPENID: ADMIN, isAdmin: true, source: 'wx_trigger', studentNumber: 'BJ2407159' });
      assert.equal(result.success, false);
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.data, undefined);
    }
    assert.equal(app.databaseReads, 0);
  }
  for (const environment of [{}, { ADMIN_OPENID: '' }, { ADMIN_OPENID: `${ADMIN},other` }, { MAINTENANCE_ADMIN_OPENIDS: ADMIN }]) {
    const app = harness({ environment });
    assert.equal((await app.search()).code, 'FORBIDDEN');
    assert.equal((await app.day()).code, 'FORBIDDEN');
    assert.equal(app.databaseReads, 0);
  }
});

test('the second allowlisted administrator can search users and read records while outsiders fail before database access', async () => {
  const environment = { ADMIN_OPENIDS: 'first-admin,second-admin', ADMIN_OPENID: ADMIN,
    MAINTENANCE_ADMIN_OPENIDS: 'maintenance' };
  const authorized = harness({ context: { OPENID: 'second-admin' }, environment, records: [record(1)] });
  assert.equal((await authorized.search()).data.users[0].openid, OWNER);
  const day = await authorized.day();
  assert.equal(day.success, true);
  assert.equal(day.data.totalCount, 1);
  assert.equal(day.data.records[0]._id, record(1)._id);
  for (const context of [{ OPENID: 'outsider' }, { OPENID: 'second-admin-extra' }, { OPENID: ADMIN },
    { OPENID: 'maintenance' }, { SOURCE: 'wx_trigger' }]) {
    const denied = harness({ context, environment });
    for (const type of ['adminSearchUsers', 'adminGetDayRecords']) {
      const result = await denied.run({ type, nickname: '静心者', openid: OWNER, recordDate: DATE,
        OPENID: 'second-admin', ADMIN_OPENIDS: 'outsider', isAdmin: true });
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.data, undefined);
    }
    assert.equal(denied.databaseReads, 0);
  }
});

test('invalid nickname, cursor, identity or impossible date is rejected before database access', async () => {
  const app = harness();
  for (const nickname of ['', '   ', '字'.repeat(101), {}, null, 42, { $ne: '' }]) {
    assert.equal((await app.search(nickname)).code, 'INVALID_ARGUMENT');
  }
  for (const cursor of [{ $gt: '' }, 10, ' id ', 'a'.repeat(257)]) {
    assert.equal((await app.search('静心者', cursor)).code, 'INVALID_ARGUMENT');
  }
  for (const openid of ['', ' ', 'other account', {}, null, 'a'.repeat(129)]) {
    assert.equal((await app.day({ openid })).code, 'INVALID_ARGUMENT');
  }
  for (const recordDate of ['', '2026-9-22', '2026-02-29', '2026-09-31', '2026-09-22T00:00:00Z', {}, null]) {
    assert.equal((await app.day({ recordDate })).code, 'INVALID_ARGUMENT');
  }
  assert.equal(app.databaseReads, 0);
});

test('nickname lookup trims input, matches literally and exposes only minimal account identification', async () => {
  const app = harness({ users: [
    profile({ _id: 'a', nickName: '静.心*', bijingBound: true, bijingStudentNumber: 'BJ0001', avatarUrl: 'secret-avatar', password: 'secret' }),
    profile({ _id: 'b', _openid: 'same-name', nickName: '静.心*', bijingBound: false, bijingStudentNumber: 'hidden-old-number' }),
    profile({ _id: 'c', _openid: 'almost', nickName: '静心' }),
    profile({ _id: 'd', _openid: 'partial', nickName: '静.心*师兄' }),
    profile({ _id: 'e', _openid: OWNER, nickName: '静.心*' })
  ] });
  const result = await app.search('  静.心*  ');
  assert.deepEqual(result, { success: true, data: { users: [
    { openid: OWNER, nickname: '静.心*', studentNumber: 'BJ0001' },
    { openid: 'same-name', nickname: '静.心*', studentNumber: '' }
  ], nextCursor: null } });
  assert.deepEqual(app.reads[0].filter, { nickName: '静.心*' });
  assert.deepEqual(app.reads[0].fields, PROFILE_FIELDS);
  assert.deepEqual((await app.search('无人使用此昵称')).data, { users: [], nextCursor: null });
});

test('nickname pagination returns every same-name account without an implicit database row limit', async () => {
  const users = Array.from({ length: 123 }, (_, index) => profile({
    _id: `user-${String(index).padStart(4, '0')}`, _openid: `owner-${index}`
  }));
  const app = harness({ users: users.slice().reverse() });
  const found = [];
  let cursor;
  do {
    const result = await app.search('静心者', cursor);
    assert.equal(result.success, true);
    found.push(...result.data.users);
    cursor = result.data.nextCursor;
  } while (cursor);
  assert.deepEqual(found.map(user => user.openid), users.map(user => user._openid));
  assert.deepEqual(app.reads.map(query => query.limit), [50, 50, 50]);
  assert.deepEqual(app.reads.slice(1).map(query => query.filter._id.value), ['user-0049', 'user-0099']);
  assert.ok(app.reads.every(query => query.ordering[0][0] === '_id'));
});

test('nickname search skips empty legacy pages and resumes before any unreturned candidates', async () => {
  const invalid = Array.from({ length: 100 }, (_, index) => profile({
    _id: `a-${String(index).padStart(4, '0')}`, _openid: index % 2 ? undefined : 'invalid id'
  }));
  const repeated = Array.from({ length: 65 }, (_, index) => profile({
    _id: `b-${String(index).padStart(4, '0')}`, _openid: 'repeated-owner'
  }));
  const distinct = Array.from({ length: 70 }, (_, index) => profile({
    _id: `c-${String(index).padStart(4, '0')}`, _openid: `distinct-owner-${index}`
  }));
  const app = harness({ users: [...invalid, ...repeated, ...distinct] });
  const first = await app.search();
  assert.equal(first.data.users.length, 50);
  assert.equal(first.data.nextCursor, 'c-0048');
  assert.equal(first.data.users[0].openid, 'repeated-owner');
  assert.equal(first.data.users.at(-1).openid, 'distinct-owner-48');
  const second = await app.search('静心者', first.data.nextCursor);
  assert.equal(second.data.nextCursor, null);
  assert.deepEqual(second.data.users.map(user => user.openid), distinct.slice(49).map(user => user._openid));
  const combined = [...first.data.users, ...second.data.users].map(user => user.openid);
  assert.equal(new Set(combined).size, 71);
});

test('nickname search scans all duplicate or invalid documents before returning an exhausted page', async () => {
  const documents = Array.from({ length: 100 }, (_, index) => profile({ _id: `user-${String(index).padStart(4, '0')}` }));
  assert.deepEqual((await harness({ users: documents }).search()).data, {
    users: [{ openid: OWNER, nickname: '静心者', studentNumber: '' }], nextCursor: null
  });
  assert.deepEqual((await harness({ users: documents.map(user => ({ ...user, _openid: '' })) }).search()).data,
    { users: [], nextCursor: null });
});

test('record dates use Beijing 02:00 boundaries and preserve manual dates and legacy timestamp forms', async () => {
  const app = harness({ records: [
    record(1, { date: '2026-09-23', timestamp: Date.parse('2026-09-23T01:59:59.999+08:00') }),
    record(2, { date: DATE, timestamp: Date.parse('2026-09-23T02:00:00+08:00') }),
    record(3, { date: DATE, timestamp: Date.parse('2026-09-22T01:59:59.999+08:00') }),
    record(4, { date: '2026-09-21', timestamp: Date.parse('2026-09-22T02:00:00+08:00') }),
    record(5, { timestamp: '2026-09-22T03:00:00+08:00' }),
    record(6, { timestamp: String(Date.parse('2026-09-22T04:00:00+08:00')) }),
    record(7, { timestamp: new Date('2026-09-22T05:00:00+08:00') }),
    record(8, { timestamp: Date.parse('2026-09-25T12:00:00+08:00'), source: 'manual' }),
    record(9, { timestamp: Date.parse('2026-09-21T12:00:00+08:00'), dateSource: 'manual' }),
    record(10, { date: '2026-09-21', timestamp: Date.parse('2026-09-22T12:00:00+08:00'), source: 'manual' }),
    record(11, { timestamp: '2026-09-23T00:00:00', source: undefined }),
    record(12, { timestamp: undefined }),
    record(13, { timestamp: 0 }),
    record(14, { date: 'invalid', timestamp: undefined }),
    record(15, { _openid: 'foreign-owner' })
  ] });
  const result = await app.day();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.records.map(row => row._id), [8, 1, 7, 6, 5, 4, 9, 11, 12, 13].map(index => record(index)._id));
  assert.equal(result.data.totalCount, 10);
  assert.equal(result.data.totalDuration, 100);
  assert.ok(result.data.records.every(row => row.date === DATE));
  assert.equal(result.data.records.find(row => row._id === record(9)._id).source, 'manual');
  assert.equal(result.data.records.find(row => row._id === record(11)._id).source, 'unknown');
  assert.equal(result.data.records.find(row => row._id === record(11)._id).timestamp, null);
});

test('year boundary and leap day are attributed using the same business-day rule', async () => {
  const app = harness({ records: [
    record(1, { date: '2027-01-01', timestamp: '2027-01-01T01:00:00+08:00' }),
    record(2, { date: '2024-03-01', timestamp: '2024-03-01T01:00:00+08:00' })
  ] });
  assert.equal((await app.day({ recordDate: '2026-12-31' })).data.records[0]._id, record(1)._id);
  assert.equal((await app.day({ recordDate: '2024-02-29' })).data.records[0]._id, record(2)._id);
});

test('day details return all pages and deduplicate local identities across page and date boundaries', async () => {
  const records = Array.from({ length: 235 }, (_, index) => record(index));
  records[0].localId = 'session-a';
  records[100].idempotencyKey = 'session-a';
  records[100].localId = 'session-b';
  records[200].idempotencyKey = 'session-b';
  records[1].localId = 'manual-session';
  records[1].source = 'manual';
  records[1].date = '2026-09-21';
  records[101].idempotencyKey = 'manual-session';
  const app = harness({ records: records.slice().reverse() });
  const result = await app.day();
  assert.equal(result.success, true);
  assert.equal(result.data.totalCount, 231);
  assert.equal(result.data.totalDuration, 2310);
  assert.equal(new Set(result.data.records.map(row => row._id)).size, 231);
  assert.ok([1, 100, 101, 200].every(index => !result.data.records.some(row => row._id === record(index)._id)));
  const pages = app.reads.filter(query => query.name === 'meditation_records');
  assert.deepEqual(pages.map(query => query.limit), [100, 100, 100]);
  assert.deepEqual(pages.map(query => query.filter._id && query.filter._id.value), [undefined, 'record-0099', 'record-0199']);
  assert.ok(pages.every(query => query.filter._openid === OWNER));
});

test('stable record snapshots check the canonical lock revision before and after every page set', async () => {
  const app = harness({ records: Array.from({ length: 201 }, (_, index) => record(index)), revision: 12 });
  const result = await app.day();
  assert.equal(result.success, true);
  assert.equal(result.data.totalCount, 201);
  const lockId = 'lock_' + crypto.createHash('sha256').update(JSON.stringify([OWNER, 'records'])).digest('hex');
  assert.deepEqual(app.lockReads, Array.from({ length: 2 }, () => ({
    filter: { _id: lockId }, fields: { _id: true, revision: true }, limit: 1
  })));
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 3);
});

test('a deletion and insertion during pagination discard the mixed snapshot and reread all records', async () => {
  const records = Array.from({ length: 201 }, (_, index) => record(index));
  const options = { records, revision: 7, onRead(index, data) {
    if (index !== 3) return;
    data.records.splice(0, 1);
    data.records.push(record(250));
    options.revision++;
  } };
  const app = harness(options);
  const result = await app.day();
  assert.equal(result.success, true);
  assert.equal(result.data.totalCount, 201);
  assert.equal(result.data.totalDuration, 2010);
  assert.ok(!result.data.records.some(row => row._id === record(0)._id));
  assert.ok(result.data.records.some(row => row._id === record(250)._id));
  assert.ok(result.data.records.some(row => row._id === record(100)._id));
  assert.ok(result.data.records.some(row => row._id === record(200)._id));
  assert.equal(new Set(result.data.records.map(row => row._id)).size, result.data.totalCount);
  assert.equal(app.lockReads.length, 4);
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 6);
});

test('continuously changing records return RETRY_REQUIRED after three discarded snapshots', async () => {
  const options = { records: [record(1)], revision: 1, onRead(index) {
    if (index > 1) options.revision++;
  } };
  const app = harness(options);
  const result = await app.day();
  assert.deepEqual(result, { success: false, code: 'RETRY_REQUIRED', error: '记录正在更新，请稍后重新查询' });
  assert.equal(app.lockReads.length, 6);
  assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 3);
});

test('legacy missing lock documents or collections remain readable without creating or writing data', async () => {
  for (const options of [
    { missingLockDocument: true },
    { lockError: { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' } },
    { lockError: { errCode: -502005, errMsg: 'database collection not exists' } },
    { lockError: { errCode: 'DATABASE_COLLECTION_NOT_EXIST' } }
  ]) {
    const app = harness({ ...options, records: [record(1)] });
    const result = await app.day();
    assert.equal(result.success, true);
    assert.equal(result.data.totalCount, 1);
    assert.equal(result.data.totalDuration, 10);
    assert.equal(app.lockReads.length, 2);
    assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, 1);
  }
});

test('lock permission, network and malformed-response failures never accept an unverified snapshot', async () => {
  for (const failLockOnRead of [1, 2]) {
    for (const lockError of [
      { errCode: -502003, errMsg: 'private database permission denied' },
      { errCode: -1, errMsg: 'private connection unavailable' },
      new Error('private database failure')
    ]) {
      const app = harness({ records: [record(1)], failLockOnRead, lockError });
      const result = await app.day();
      assert.deepEqual(result, { success: false, code: 'QUERY_FAILED', error: '记录查询暂时不可用，请稍后重试' });
      assert.equal(app.lockReads.length, failLockOnRead);
      assert.equal(app.reads.filter(read => read.name === 'meditation_records').length, failLockOnRead - 1);
    }
    const invalid = await harness({ records: [record(1)], invalidLockOnRead: failLockOnRead }).day();
    assert.equal(invalid.code, 'QUERY_FAILED');
    assert.equal(invalid.data, undefined);
  }
});

test('unknown users fail explicitly and existing users with no records receive a complete empty result', async () => {
  const missing = harness({ users: [] });
  assert.equal((await missing.day()).code, 'USER_NOT_FOUND');
  assert.equal(missing.reads.length, 1);
  assert.deepEqual(await harness().day(), { success: true, data: {
    user: { openid: OWNER, nickname: '静心者', studentNumber: '' }, recordDate: DATE,
    records: [], totalCount: 0, totalDuration: 0
  } });
});

test('day queries project and return only approved fields, with safe normalized durations and sources', async () => {
  const app = harness({ users: [profile({ bijingBound: false, bijingStudentNumber: 'old-secret', accessToken: 'secret' })], records: [
    record(1, { duration: '12.5', experience: 'private journal', emotion: ['private'], localId: 'private-local-id' }),
    record(2, { duration: -1, source: 'private-source' }),
    record(3, { duration: Infinity }),
    record(4, { duration: 'invalid' }),
    record(5, { duration: {} })
  ] });
  const result = await app.day();
  assert.equal(result.data.totalDuration, 12.5);
  assert.equal(result.data.totalCount, 5);
  assert.equal(result.data.user.studentNumber, '');
  assert.deepEqual(app.reads[0].fields, PROFILE_FIELDS);
  assert.deepEqual(app.reads[1].fields, RECORD_FIELDS);
  for (const row of result.data.records) assert.deepEqual(Object.keys(row).sort(), ['_id', 'date', 'duration', 'source', 'timestamp']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('database failures on user lookup or any records page return no partial result or sensitive details', async () => {
  const records = Array.from({ length: 210 }, (_, index) => record(index));
  for (const failOnRead of [1, 2, 3, 4]) {
    const app = harness({ records, failOnRead });
    const result = await app.day();
    assert.deepEqual(result, { success: false, code: 'QUERY_FAILED', error: '记录查询暂时不可用，请稍后重试' });
  }
  assert.equal((await harness({ failOnRead: 1 }).search()).code, 'QUERY_FAILED');
  assert.equal((await harness({ invalidOnRead: 1 }).search()).code, 'QUERY_FAILED');
  assert.equal((await harness({ invalidOnRead: 2 }).day()).code, 'QUERY_FAILED');
});
