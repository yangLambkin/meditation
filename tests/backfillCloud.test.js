const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');
const backfill = require('../cloudfunctions/meditationManager/backfill');

const requestId = (owner, value) => 'br_' + crypto.createHash('sha256').update(JSON.stringify([owner, value])).digest('hex');
const lockId = owner => 'bl_' + crypto.createHash('sha256').update(owner).digest('hex');
const row = (index, extra = {}) => ({ _id: requestId('owner', `request-${index}`), kind: 'request', ownerOpenid: 'owner',
  startDate: '2026-09-01', endDate: '2026-09-30', reason: '闭关静坐未使用手机', status: 'pending', reply: '',
  nickname: '静心者', studentNumber: 'BJ1000', createdAt: '2026-10-05T04:00:00.000Z', updatedAt: '2026-10-05T04:00:00.000Z',
  handledAt: null, handledBy: '', unreadForUser: false, expiresAt: '2026-10-07T18:00:00.000Z', ...extra });

function backfillHarness(options = {}) {
  const rows = structuredClone(options.rows || []);
  const users = options.users || [{ _id: 'user-owner', _openid: 'owner', nickName: '静心者', bijingBound: true, bijingStudentNumber: 'BJ1000' }];
  const authorization = createStudentAuthDatabase({ adminOpenid: 'admin', ...options });
  const reads = [], writes = [], moderations = [], creations = [];
  let missing = Boolean(options.backfillMissing);
  let conflicts = 0;
  const matches = (row, filter) => {
    if (filter.and) return filter.and.every(part => matches(row, part));
    if (filter.or) return filter.or.some(part => matches(row, part));
    return Object.entries(filter).every(([key, value]) => value && value.lt !== undefined ? row[key] < value.lt :
      value && value.gt !== undefined ? row[key] > value.gt : row[key] === value);
  };
  const missingError = () => Object.assign(new Error('collection backfill_requests does not exist'), { errCode: -502005 });
  function collection(name, state = rows, inTransaction = false) {
    assert.ok(['backfill_requests', 'users'].includes(name));
    let filter = {}, limit = 20, fields;
    const order = [];
    const check = () => {
      if (name !== 'backfill_requests') return;
      if (options.readError) throw options.readError;
      if (missing) throw missingError();
    };
    return {
      where(value) {
        assert.equal(inTransaction, false, 'backfill transactions must use document operations');
        if (name === 'users' && Object.hasOwn(value, 'bijingBound')) return authorization.db.collection(name).where(value);
        filter = value; return this;
      },
      orderBy(field, direction) { order.push([field, direction]); return this; },
      limit(value) { limit = value; return this; },
      field(value) { fields = value; return this; },
      async get() {
        reads.push({ name, filter: structuredClone(filter), order, limit }); check();
        if (options.invalidReadResponse) return {};
        let selected = (name === 'backfill_requests' ? state : users).filter(row => matches(row, filter));
        selected = selected.slice().sort((a, b) => {
          for (const [field, direction] of order) {
            const result = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
            if (result) return direction === 'desc' ? -result : result;
          }
          return 0;
        }).slice(0, limit);
        return { data: structuredClone(selected.map(row => fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])) : row)) };
      },
      doc(id) {
        return {
          async get() {
            reads.push({ name, id, inTransaction }); check();
            if (options.invalidReadResponse) return {};
            return { data: structuredClone(state.find(row => row._id === id)) };
          },
          async set({ data }) {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            writes.push({ name, id, data: structuredClone(data), operation: 'set' });
            const index = state.findIndex(row => row._id === id);
            if (index !== -1) state.splice(index, 1);
            state.push({ ...structuredClone(data), _id: id });
            return { _id: id };
          },
          async update({ data }) {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            writes.push({ name, id, data: structuredClone(data), operation: 'update' });
            const index = state.findIndex(row => row._id === id);
            assert.notEqual(index, -1);
            state[index] = { ...state[index], ...structuredClone(data) };
            return { stats: { updated: 1 } };
          },
          async remove() {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            writes.push({ name, id, operation: 'remove' });
            const index = state.findIndex(row => row._id === id);
            assert.notEqual(index, -1);
            state.splice(index, 1);
            return { stats: { removed: 1 } };
          }
        };
      }
    };
  }
  const db = {
    command: { gt: value => ({ gt: value }), lt: value => ({ lt: value }), and: value => ({ and: value }), or: value => ({ or: value }) },
    RegExp: authorization.db.RegExp,
    collection(name) { return name === 'bijing_bindings' ? authorization.db.collection(name) : collection(name); },
    async createCollection(name) {
      creations.push(name);
      assert.equal(name, 'backfill_requests');
      if (options.creationError) {
        if (options.createdByOther) missing = false;
        throw options.creationError;
      }
      missing = false;
    },
    async runTransaction(callback) {
      if (options.beforeTransaction) await options.beforeTransaction({ rows });
      return authorization.db.runTransaction(async authTransaction => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const before = JSON.stringify(rows), pending = structuredClone(rows);
          const value = await callback({ collection(name) {
            return name === 'backfill_requests' ? collection(name, pending, true) : authTransaction.collection(name);
          } });
          if (options.beforeBackfillCommit) await options.beforeBackfillCommit({ rows });
          if (before !== JSON.stringify(rows)) { conflicts++; continue; }
          if (options.commitError && JSON.stringify(pending) !== before) throw options.commitError;
          rows.splice(0, rows.length, ...pending);
          return value;
        }
        throw new Error('transaction conflict');
      });
    }
  };
  const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db,
    getWXContext: () => options.context || { OPENID: 'owner' },
    openapi: { security: { async msgSecCheck(payload) {
      moderations.push(structuredClone(payload));
      if (options.moderationError) throw options.moderationError;
      if (options.onModerate) await options.onModerate({ rows });
      return Object.hasOwn(options, 'moderationResult') ? options.moderationResult : { errCode: 0, result: { suggest: 'pass' } };
    } } }
  };
  function load(name) {
    const exports = {};
    vm.runInNewContext(fs.readFileSync(require.resolve(`../cloudfunctions/${name}/index.js`), 'utf8'), {
      exports, console: { log() {}, warn() {}, error() {} }, process: { env: options.environment || { ADMIN_STUDENT_NUMBERS: 'BJ0099' } },
      require(module) {
        if (module === 'wx-server-sdk') return cloud;
        if (module === './backfill') return { ...backfill, handleBackfill(event, dependencies, admin) {
          return backfill.handleBackfill(event, { ...dependencies, now: () => options.now === undefined ? Date.parse('2026-10-05T04:00:00.000Z') : options.now }, admin);
        } };
        return require(`../cloudfunctions/${name}/${module.slice(2)}`);
      }
    });
    return async event => JSON.parse(JSON.stringify(await exports.main(event)));
  }
  const user = load('meditationManager'), admin = load('adminManager');
  return { rows, reads, writes, moderations, creations, authorization,
    get conflicts() { return conflicts; }, user, admin,
    db, cloud,
    submit: event => user({ type: 'submitBackfillRequest', startDate: '2026-09-05', endDate: '2026-10-04',
      reason: ' 闭关静坐未使用手机 ', requestId: 'request-1', ...event }),
    list: event => user({ type: 'getMyBackfillRequests', ...event }),
    alert: event => user({ type: 'getBackfillAlert', ...event }),
    markRead: requests => user({ type: 'markBackfillRead', requests }),
    adminList: event => admin({ type: 'adminListBackfillRequests', status: 'all', ...event }),
    review: event => admin({ type: 'adminReviewBackfillRequest', requestId: requestId('owner', 'request-1'),
      expectedUpdatedAt: '2026-10-05T04:00:00.000Z', status: 'approved', reply: '', ...event }),
    adminAlert: () => admin({ type: 'adminGetBackfillAlert' }) };
}

test('backfill deployments contain identical portable services', () => {
  assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/backfill'), 'utf8'),
    fs.readFileSync(require.resolve('../cloudfunctions/meditationManager/backfill'), 'utf8'));
});

test('application trusts platform identity and profile, hides lock and private identity, moderates explanation', async () => {
  const app = backfillHarness();
  const result = await app.submit({ ownerOpenid: 'victim', openid: 'victim', status: 'approved', nickname: '伪造',
    studentNumber: 'BJ0099', handledBy: 'admin', ruleVersion: 1, expiresAt: '2100-01-01T00:00:00.000Z' });
  assert.equal(result.success, true);
  const request = result.data.request;
  assert.equal(request._id, requestId('owner', 'request-1'));
  assert.equal(request.nickname, '静心者'); assert.equal(request.studentNumber, 'BJ1000');
  assert.equal(request.reason, '闭关静坐未使用手机'); assert.equal(request.status, 'pending');
  assert.equal(request.ruleVersion, 2); assert.equal(request.expiresAt, null);
  assert.equal(request.expired, false); assert.equal(request.canRecord, false);
  assert.equal(request.unreadForUser, false);
  for (const key of ['ownerOpenid', 'handledBy', '_openid', 'kind']) assert.equal(Object.hasOwn(request, key), false);
  assert.equal(app.rows.length, 2);
  assert.equal(app.rows.find(item => item.kind === 'lock').activeRequestId, request._id);
  assert.equal(app.rows.find(item => item.kind === 'request').ownerOpenid, 'owner');
  assert.deepEqual(app.moderations, [{ content: request.reason, openid: 'owner', version: 2, scene: 2 }]);
  assert.equal((await app.list()).data.requests.length, 1);
  assert.equal((await app.alert()).data.hasUnreadBackfill, false);
});

test('all user actions reject missing identity before business access', async () => {
  for (const context of [{}, { OPENID: '' }, { OPENID: ' invalid ' }]) {
    const app = backfillHarness({ context });
    for (const action of [app.submit, app.list, app.alert, () => app.markRead([])]) {
      assert.equal((await action({ openid: 'owner', ownerOpenid: 'owner' })).code, 'AUTH_REQUIRED');
    }
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0); assert.equal(app.moderations.length, 0);
  }
});

test('application enforces real calendar dates, at most 30 inclusive days and bounded explanation', async () => {
  for (const change of [{ startDate: '2026-09-00' }, { startDate: '2026-09-31' }, { startDate: '2026-02-29' },
    { startDate: '2026-9-01' }, { endDate: '2026-10-05' }, { startDate: '2026-10-05' }, { endDate: {} },
    { startDate: null }, { reason: '' }, { reason: 'a'.repeat(501) }, { reason: {} }, { requestId: '' },
    { requestId: '../hack' }, { requestId: 'a'.repeat(101) }]) {
    const app = backfillHarness();
    assert.equal((await app.submit(change)).code, 'INVALID_ARGUMENT', JSON.stringify(change));
    assert.equal(app.rows.length, 0); assert.equal(app.reads.length, 0); assert.equal(app.moderations.length, 0);
  }
  const leap = backfillHarness({ now: Date.parse('2028-03-02T04:00:00.000Z') });
  assert.equal((await leap.submit({ startDate: '2028-02-29', endDate: '2028-02-29' })).success, true);
});

test('business date flips at Beijing 02:00 and requires an ended retreat', async () => {
  const options = { now: Date.parse('2026-10-04T17:59:59.999Z') }, app = backfillHarness(options);
  const dates = { startDate: '2026-10-04', endDate: '2026-10-04' };
  assert.equal((await app.submit(dates)).code, 'INVALID_ARGUMENT');
  options.now = Date.parse('2026-10-04T18:00:00.000Z');
  assert.equal((await app.submit(dates)).success, true);
  assert.equal((await backfillHarness().submit({ startDate: '2026-10-05', endDate: '2026-10-05' })).code, 'INVALID_ARGUMENT');
});

test('new applications include only the previous 30 business dates, including dates older than seven days', async () => {
  for (const dates of [
    { startDate: '2026-09-05', endDate: '2026-10-04' },
    { startDate: '2026-09-05', endDate: '2026-09-05' },
    { startDate: '2026-10-04', endDate: '2026-10-04' }
  ]) assert.equal((await backfillHarness().submit(dates)).success, true, JSON.stringify(dates));
  for (const dates of [
    { startDate: '2026-09-04', endDate: '2026-09-30' },
    { startDate: '2026-09-04', endDate: '2026-09-04' },
    { startDate: '2026-10-05', endDate: '2026-10-05' },
    { startDate: '2026-10-06', endDate: '2026-10-06' }
  ]) {
    const app = backfillHarness();
    assert.equal((await app.submit(dates)).code, 'INVALID_ARGUMENT', JSON.stringify(dates));
    assert.equal(app.writes.length, 0); assert.equal(app.moderations.length, 0);
  }
  const beforeCutover = { now: Date.parse('2026-10-04T17:59:59.999Z') };
  assert.equal((await backfillHarness(beforeCutover).submit({ startDate: '2026-09-04', endDate: '2026-10-03' })).success, true);
  const afterCutover = { now: beforeCutover.now + 1 };
  assert.equal((await backfillHarness(afterCutover).submit({ startDate: '2026-09-04', endDate: '2026-10-03' })).code, 'INVALID_ARGUMENT');
});

test('the transaction rechecks the recent-date boundary immediately before creating the application', async () => {
  const options = { now: Date.parse('2026-10-04T17:59:59.999Z'), beforeTransaction() { options.now++; } };
  const app = backfillHarness(options);
  const result = await app.submit({ startDate: '2026-09-04', endDate: '2026-10-03' });
  assert.equal(result.code, 'INVALID_ARGUMENT');
  assert.equal(app.rows.length, 0); assert.equal(app.writes.length, 0);
});

test('new pending requests have no expiry, keep their lock and alert, and can be approved after the original month', async () => {
  const options = {}, app = backfillHarness(options);
  const created = (await app.submit()).data.request;
  options.now = Date.parse('2026-11-15T03:12:34.567Z');
  const pending = (await app.list()).data.requests[0];
  assert.equal(pending.ruleVersion, 2); assert.equal(pending.expiresAt, null);
  assert.equal(pending.expired, false); assert.equal(pending.canRecord, false);
  options.moderationError = new Error('offline');
  const retry = await app.submit();
  assert.equal(retry.success, true); assert.equal(retry.data.request._id, created._id);
  assert.equal(app.moderations.length, 1, 'committed retries do not repeat moderation or validate a newer rolling window');
  delete options.moderationError;
  assert.equal((await app.submit({ requestId: 'second', startDate: '2026-11-01', endDate: '2026-11-14' })).code, 'ACTIVE_REQUEST_EXISTS');
  options.context = { OPENID: 'admin' };
  assert.equal((await app.adminAlert()).data.hasPendingBackfill, true);
  const approved = (await app.review()).data.request;
  assert.equal(approved.startDate, created.startDate); assert.equal(approved.endDate, created.endDate);
  assert.equal(approved.handledAt, '2026-11-15T03:12:34.567Z');
  assert.equal(approved.expiresAt, '2026-11-18T03:12:34.567Z');
  assert.equal(approved.expired, false); assert.equal(approved.canRecord, true);
  assert.equal((await app.adminAlert()).data.hasPendingBackfill, false);
  const verify = time => app.db.runTransaction(transaction =>
    backfill.assertBackfillGrant(transaction, 'owner', approved._id, created.startDate, time));
  const deadline = Date.parse(approved.expiresAt);
  assert.equal((await verify(deadline - 1))._id, approved._id);
  await assert.rejects(() => verify(deadline), { code: 'BACKFILL_EXPIRED' });
  options.context = { OPENID: 'owner' }; options.now = deadline;
  const expired = (await app.list()).data.requests[0];
  assert.equal(expired.expired, true); assert.equal(expired.canRecord, false);
  assert.equal((await app.submit({ requestId: 'second', startDate: '2026-11-01', endDate: '2026-11-14' })).success, true);
});

test('approval starts exactly 72 hours at the successful transaction time after slow moderation', async () => {
  const options = {}, app = backfillHarness(options);
  await app.submit(); options.context = { OPENID: 'admin' };
  options.onModerate = () => { options.now = Date.parse('2026-10-06T17:59:59.999Z'); };
  options.beforeTransaction = () => { options.now = Date.parse('2026-10-06T18:00:01.123Z'); };
  const response = await app.review({ reply: '通过', expiresAt: '2099-01-01T00:00:00.000Z', ruleVersion: 1 });
  assert.equal(response.success, true);
  const approved = response.data.request;
  assert.equal(approved.ruleVersion, 2);
  assert.equal(approved.handledAt, '2026-10-06T18:00:01.123Z');
  assert.equal(approved.expiresAt, '2026-10-09T18:00:01.123Z');
  assert.equal(Date.parse(approved.expiresAt) - Date.parse(approved.handledAt), 3 * 86400000);
});

test('legacy approval keeps its original deadline while malformed new approved deadlines fail closed', async () => {
  const options = { rows: [row(1)], context: { OPENID: 'admin' }, now: Date.parse('2026-10-07T17:59:59.999Z') };
  const legacy = backfillHarness(options);
  const approved = (await legacy.review()).data.request;
  assert.equal(approved.ruleVersion, 1); assert.equal(approved.canRecord, true);
  assert.equal(approved.expiresAt, '2026-10-07T18:00:00.000Z');
  options.now++;
  assert.equal((await legacy.adminList()).data.requests[0].expired, true);
  for (const expiresAt of [null, undefined, '', 'bad-date']) {
    const app = backfillHarness({ rows: [row(1, { ruleVersion: 2, status: 'approved', expiresAt })] });
    const listed = (await app.list()).data.requests[0];
    assert.equal(listed.expired, true); assert.equal(listed.canRecord, false);
    await assert.rejects(() => app.db.runTransaction(transaction =>
      backfill.assertBackfillGrant(transaction, 'owner', listed._id, '2026-09-01', Date.parse('2026-10-05T04:00:00.000Z'))),
    { code: 'BACKFILL_EXPIRED' });
  }
});

test('legacy expiry and committed retries retain the old deadline without extending or reviving it', async () => {
  const legacy = row(1), original = { startDate: legacy.startDate, endDate: legacy.endDate };
  const options = { now: Date.parse('2026-10-07T17:59:59.999Z'), rows: [legacy,
    { _id: lockId('owner'), kind: 'lock', ownerOpenid: 'owner', activeRequestId: legacy._id }] };
  const app = backfillHarness(options);
  const saved = await app.submit(original);
  assert.equal(saved.success, true); assert.equal(saved.data.request.expired, false);
  assert.equal(saved.data.request.ruleVersion, 1);
  assert.equal(saved.data.request.expiresAt, '2026-10-07T18:00:00.000Z');
  options.now++; options.moderationError = new Error('offline');
  const retry = await app.submit(original);
  assert.equal(retry.success, true); assert.equal(retry.data.request.expired, true);
  assert.equal(app.moderations.length, 0);
  assert.equal((await app.submit({ ...original, reason: 'different' })).code, 'REQUEST_ID_REUSED');
  assert.equal(app.rows.length, 2);
});

test('same request retries are idempotent while different simultaneous requests share an exclusive user lock', async () => {
  const app = backfillHarness();
  const duplicate = await Promise.all([app.submit(), app.submit(), app.submit()]);
  assert.ok(duplicate.every(item => item.success)); assert.equal(app.rows.length, 2); assert.ok(app.conflicts > 0);
  const other = await app.submit({ requestId: 'new-request' });
  assert.equal(other.code, 'ACTIVE_REQUEST_EXISTS');
  const concurrent = backfillHarness();
  const results = await Promise.all(['first', 'second', 'third'].map(requestId => concurrent.submit({ requestId })));
  assert.equal(results.filter(item => item.success).length, 1);
  assert.equal(results.filter(item => item.code === 'ACTIVE_REQUEST_EXISTS').length, 2);
  assert.equal(concurrent.rows.length, 2);
});

test('moderation failure is closed; the recent date window is rechecked after slow moderation', async () => {
  for (const [options, expected] of [
    [{ moderationResult: { result: { suggest: 'risky' } } }, 'CONTENT_REJECTED'],
    [{ moderationResult: { result: { suggest: 'review' } } }, 'CONTENT_REJECTED'],
    [{ moderationError: { errcode: 87014 } }, 'CONTENT_REJECTED'],
    [{ moderationResult: null }, 'CONTENT_CHECK_FAILED'],
    [{ moderationResult: { errCode: 0 } }, 'CONTENT_CHECK_FAILED'],
    [{ moderationError: new Error('network') }, 'CONTENT_CHECK_FAILED']
  ]) {
    const app = backfillHarness(options);
    assert.equal((await app.submit()).code, expected); assert.equal(app.rows.length, 0);
  }
  const options = { now: Date.parse('2026-10-04T17:59:59.999Z'), onModerate() { options.now++; } };
  const late = backfillHarness(options);
  assert.equal((await late.submit({ startDate: '2026-09-04', endDate: '2026-10-03' })).code, 'INVALID_ARGUMENT');
  assert.equal(late.rows.length, 0);
});

test('first use initializes only genuinely missing collection; unavailable reads cannot silently clear alerts', async () => {
  const app = backfillHarness({ backfillMissing: true });
  assert.deepEqual((await app.list()).data, { requests: [], nextCursor: '' });
  assert.deepEqual((await app.alert()).data, { hasUnreadBackfill: false });
  assert.equal(app.creations.length, 0);
  assert.equal((await app.submit()).success, true);
  assert.deepEqual(app.creations, ['backfill_requests']);
  for (const options of [{ readError: new Error('permission denied') }, { invalidReadResponse: true },
    { readError: Object.assign(new Error('network failed'), { errCode: -502001 }) }]) {
    const failing = backfillHarness(options);
    assert.equal((await failing.list()).code, 'BACKFILL_UNAVAILABLE');
    assert.equal((await failing.alert()).code, 'BACKFILL_UNAVAILABLE');
    assert.equal((await failing.submit()).code, 'BACKFILL_UNAVAILABLE');
    assert.equal(failing.creations.length, 0); assert.equal(failing.writes.length, 0);
  }
  const race = backfillHarness({ backfillMissing: true, createdByOther: true,
    creationError: new Error('collection backfill_requests already exists') });
  assert.equal((await race.submit()).success, true);
});

test('user and administrator pagination excludes locks, isolates ownership and preserves ties', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => row(index, { status: index < 4 ? 'pending' : 'approved',
    ownerOpenid: index < 5 ? 'owner' : 'someone', handledBy: 'admin', secret: 'hidden' }));
  rows.push({ _id: lockId('owner'), kind: 'lock', ownerOpenid: 'owner', activeRequestId: rows[0]._id });
  const options = { rows }, app = backfillHarness(options);
  let cursor = '', own = [];
  do {
    const response = await app.list({ limit: 2, cursor });
    assert.equal(response.success, true);
    own.push(...response.data.requests); cursor = response.data.nextCursor;
  } while (cursor);
  assert.deepEqual(own.map(item => item._id), rows.slice(0, 5).map(item => item._id).sort().reverse());
  assert.ok(own.every(item => !Object.hasOwn(item, 'ownerOpenid') && !Object.hasOwn(item, 'secret')));
  options.context = { OPENID: 'admin' };
  const approved = await app.adminList({ status: 'approved', limit: 2 });
  const next = await app.adminList({ status: 'approved', limit: 2, cursor: approved.data.nextCursor });
  assert.equal([...approved.data.requests, ...next.data.requests].length, 3);
  assert.ok(approved.data.requests.every(item => item.handledBy === 'admin' && item.ownerOpenid));
  assert.equal((await app.adminList({ status: 'resolved' })).code, 'INVALID_ARGUMENT');
  for (const event of [{ limit: 0 }, { limit: 51 }, { cursor: '?' }, { cursor: Buffer.from('["x","y"]').toString('base64') }]) {
    assert.equal((await app.list(event)).code, 'INVALID_ARGUMENT');
  }
});

test('recorded-date receipts expose only unique real dates inside the approved range', async () => {
  const app = backfillHarness({ rows: [row(1, { status: 'approved', recordedDates: [
    '2026-09-12', '2026-09-01', '2026-09-12', '2026-08-31', '2026-09-31', '2026-10-01', null, { date: '2026-09-02' }
  ] })] });
  const result = await app.list();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.requests[0].recordedDates, ['2026-09-01', '2026-09-12']);
});

test('all administrator actions authenticate centrally before accessing application data', async () => {
  for (const context of [{}, { OPENID: 'owner' }, { OPENID: 'maintenance' }, { SOURCE: 'wx_trigger' }]) {
    const app = backfillHarness({ context, rows: [row(1)] });
    const spoof = { OPENID: 'admin', openid: 'admin', ownerOpenid: 'admin', isAdmin: true,
      studentNumber: 'BJ0099', accessDelegation: { openid: 'admin' } };
    assert.equal((await app.adminList(spoof)).code, 'FORBIDDEN');
    assert.equal((await app.review(spoof)).code, 'FORBIDDEN');
    assert.deepEqual((await app.adminAlert()).data, { hasPendingBackfill: false });
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
  const broken = backfillHarness({ context: { OPENID: 'admin' }, authDatabaseError: new Error('offline') });
  for (const action of [broken.adminList, broken.review, broken.adminAlert]) {
    assert.equal((await action()).code, 'ADMIN_AUTH_UNAVAILABLE');
  }
  assert.equal(broken.reads.length, 0);
});

test('approval clears administrator pending alert and publishes an unread, trusted approval result', async () => {
  const options = {}, app = backfillHarness(options);
  await app.submit(); options.context = { OPENID: 'admin' };
  assert.equal((await app.adminAlert()).data.hasPendingBackfill, true);
  const review = await app.review({ reply: ' 准予补录 ', handledBy: 'forged', expiresAt: '2100' });
  assert.equal(review.success, true);
  const request = review.data.request;
  assert.equal(request.reply, '准予补录'); assert.equal(request.handledBy, 'admin');
  assert.equal(request.handledAt, '2026-10-05T04:00:00.000Z'); assert.ok(request.updatedAt > request.createdAt);
  assert.equal(request.expiresAt, '2026-10-08T04:00:00.000Z');
  assert.equal(Date.parse(request.expiresAt) - Date.parse(request.handledAt), 3 * 86400000);
  assert.equal(request.canRecord, true); assert.equal(request.unreadForUser, true);
  assert.equal((await app.adminAlert()).data.hasPendingBackfill, false);
  options.context = { OPENID: 'owner' };
  assert.equal((await app.alert()).data.hasUnreadBackfill, true);
  assert.equal((await app.submit({ requestId: 'second' })).code, 'ACTIVE_REQUEST_EXISTS');
});

test('rejection needs a moderated explanation, releases the lock and cannot be overwritten', async () => {
  const options = {}, app = backfillHarness(options);
  await app.submit(); options.context = { OPENID: 'admin' };
  for (const reply of ['', ' ', undefined, 'a'.repeat(501)]) {
    assert.equal((await app.review({ status: 'rejected', reply })).code, 'INVALID_ARGUMENT');
  }
  const rejected = await app.review({ status: 'rejected', reply: ' 请核实闭关时间 ' });
  assert.equal(rejected.success, true); assert.equal(rejected.data.request.status, 'rejected');
  assert.equal(rejected.data.request.canRecord, false); assert.equal(rejected.data.request.unreadForUser, true);
  assert.equal(rejected.data.request.expiresAt, null); assert.equal(rejected.data.request.expired, false);
  assert.equal(app.rows.find(item => item.kind === 'lock').activeRequestId, '');
  assert.equal((await app.review({ expectedUpdatedAt: rejected.data.request.updatedAt })).code, 'CONFLICT');
  options.context = { OPENID: 'owner' };
  assert.equal((await app.submit({ requestId: 'second' })).success, true);
  assert.equal(app.rows.filter(item => item.kind === 'request').length, 2);
});

test('concurrent approval and rejection allow exactly one decision; failures roll back the decision and lock', async () => {
  const options = {}, app = backfillHarness(options);
  await app.submit(); options.context = { OPENID: 'admin' };
  const results = await Promise.all([app.review(), app.review({ status: 'rejected', reply: '请核对' })]);
  assert.equal(results.filter(item => item.success).length, 1);
  assert.equal(results.filter(item => item.code === 'CONFLICT').length, 1);
  const failedOptions = {}, failed = backfillHarness(failedOptions);
  await failed.submit(); failedOptions.context = { OPENID: 'admin' }; failedOptions.commitError = new Error('commit failed');
  assert.equal((await failed.review()).code, 'BACKFILL_UNAVAILABLE');
  assert.equal(failed.rows.find(item => item.kind === 'request').status, 'pending');
  assert.equal(failed.rows.find(item => item.kind === 'lock').activeRequestId, requestId('owner', 'request-1'));
});

test('stale approval is rejected before moderation and slow moderation rechecks both version and deadline', async () => {
  const stale = backfillHarness({ context: { OPENID: 'admin' }, rows: [row(1, { updatedAt: '2026-10-05T05:00:00.000Z' })] });
  assert.equal((await stale.review({ reply: 'approved' })).code, 'CONFLICT'); assert.equal(stale.moderations.length, 0);
  const options = { context: { OPENID: 'admin' }, rows: [row(1)], onModerate({ rows }) {
    rows[0].status = 'rejected'; rows[0].updatedAt = '2026-10-05T05:00:00.000Z';
  } };
  const race = backfillHarness(options);
  assert.equal((await race.review({ reply: 'approved' })).code, 'CONFLICT');
  assert.equal(race.rows[0].status, 'rejected');
  const lateOptions = { context: { OPENID: 'admin' }, rows: [row(1)], now: Date.parse('2026-10-07T17:59:59.999Z'),
    onModerate() { lateOptions.now++; } };
  const late = backfillHarness(lateOptions);
  assert.equal((await late.review({ reply: 'approved' })).code, 'BACKFILL_EXPIRED');
  assert.equal(late.rows[0].status, 'pending');
});

test('expired legacy pending requests no longer alert or block a new request and cannot be approved', async () => {
  const legacy = row(1);
  const options = { rows: [legacy,
    { _id: lockId('owner'), kind: 'lock', ownerOpenid: 'owner', activeRequestId: legacy._id }],
    now: Date.parse('2026-10-07T18:00:00.000Z'), context: { OPENID: 'admin' } }, app = backfillHarness(options);
  assert.equal((await app.adminAlert()).data.hasPendingBackfill, false);
  const listed = await app.adminList({ status: 'pending' });
  assert.equal(listed.data.requests[0].expired, true); assert.equal(listed.data.requests[0].canRecord, false);
  assert.equal((await app.review()).code, 'BACKFILL_EXPIRED');
  options.context = { OPENID: 'owner' };
  assert.equal((await app.submit({ requestId: 'new', startDate: '2026-10-01', endDate: '2026-10-07' })).success, true);
  assert.equal(app.rows.filter(item => item.kind === 'request').length, 2);
});

test('read acknowledgements require the displayed owner and revision and preserve unseen decisions', async () => {
  const options = {}, app = backfillHarness(options);
  const created = (await app.submit()).data.request;
  options.context = { OPENID: 'admin' };
  const approved = (await app.review()).data.request;
  options.context = { OPENID: 'owner' };
  assert.equal((await app.markRead([{ requestId: created._id, expectedUpdatedAt: created.updatedAt }])).data.markedCount, 0);
  assert.equal((await app.alert()).data.hasUnreadBackfill, true);
  options.context = { OPENID: 'another' };
  assert.equal((await app.markRead([{ requestId: approved._id, expectedUpdatedAt: approved.updatedAt }])).data.markedCount, 0);
  options.context = { OPENID: 'owner' };
  const seen = await app.markRead([{ requestId: approved._id, expectedUpdatedAt: approved.updatedAt }]);
  assert.equal(seen.data.markedCount, 1); assert.equal((await app.alert()).data.hasUnreadBackfill, false);
  assert.equal(app.rows.find(item => item.kind === 'request').updatedAt, approved.updatedAt);
  for (const requests of [undefined, [{ requestId: lockId('owner'), expectedUpdatedAt: approved.updatedAt }],
    [{ requestId: approved._id, expectedUpdatedAt: 'old' }], Array(2).fill({ requestId: approved._id, expectedUpdatedAt: approved.updatedAt })]) {
    assert.equal((await app.markRead(requests)).code, 'INVALID_ARGUMENT');
  }
});

test('grant verification is transactional, owner-specific, date-bound and expires at the exact cutoff', async () => {
  const app = backfillHarness({ rows: [row(1, { status: 'approved' })] });
  const id = requestId('owner', 'request-1'), before = Date.parse('2026-10-07T17:59:59.999Z');
  const check = (owner, grant, date, now = before) => app.db.runTransaction(transaction =>
    backfill.assertBackfillGrant(transaction, owner, grant, date, now));
  assert.equal((await check('owner', id, '2026-09-01'))._id, id);
  assert.equal((await check('owner', id, '2026-09-30'))._id, id);
  for (const [owner, grant, date, code, time] of [
    ['other', id, '2026-09-01', 'BACKFILL_INVALID_GRANT'],
    ['owner', requestId('owner', 'absent'), '2026-09-01', 'BACKFILL_INVALID_GRANT'],
    ['owner', 'forged', '2026-09-01', 'BACKFILL_INVALID_GRANT'],
    ['owner', id, '2026-08-31', 'BACKFILL_DATE_OUT_OF_RANGE'],
    ['owner', id, '2026-10-01', 'BACKFILL_DATE_OUT_OF_RANGE'],
    ['owner', id, '2026-09-31', 'BACKFILL_DATE_OUT_OF_RANGE'],
    ['owner', id, '2026-09-30', 'BACKFILL_EXPIRED', before + 1]
  ]) await assert.rejects(() => check(owner, grant, date, time), { code });
  app.rows[0].status = 'pending';
  await assert.rejects(() => check('owner', id, '2026-09-01'), { code: 'BACKFILL_INVALID_GRANT' });
  assert.ok(app.reads.every(read => read.inTransaction === true));
});
