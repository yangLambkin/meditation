const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');

const feedbackId = (owner, requestId) => 'fb_' + crypto.createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
const feedbackRow = (index, extra = {}) => ({ _id: feedbackId('owner', `request-${index}`), ownerOpenid: 'owner',
  content: `反馈 ${index}`, contact: '', status: 'pending', reply: '', nickname: '静心者', studentNumber: 'BJ1000',
  createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', handledAt: null, handledBy: '', ...extra });

// Reused by adminFeedbackCloud.test.js so both entrypoints run against the same
// transaction and query behavior. Importing the helper does not register tests.
function feedbackHarness(options = {}) {
  const rows = structuredClone(options.rows || []);
  const users = options.users || [{ _id: 'user-owner', _openid: 'owner', nickName: '静心者', bijingBound: true, bijingStudentNumber: 'BJ1000' }];
  const authorization = createStudentAuthDatabase({ adminOpenid: 'admin', ...options });
  const reads = [], writes = [], moderations = [], creations = [];
  let missing = Boolean(options.feedbackMissing);
  let conflicts = 0;
  const matches = (row, filter) => {
    if (filter.and) return filter.and.every(part => matches(row, part));
    if (filter.or) return filter.or.some(part => matches(row, part));
    return Object.entries(filter).every(([key, value]) => value && value.lt !== undefined ? row[key] < value.lt :
      value && value.gt !== undefined ? row[key] > value.gt : row[key] === value);
  };
  const missingError = () => Object.assign(new Error('collection feedback does not exist'), { errCode: -502005 });
  function collection(name, state = rows, inTransaction = false) {
    assert.ok(['feedback', 'users'].includes(name));
    let filter = {}, limit = 20, fields;
    const order = [];
    const check = () => {
      if (name !== 'feedback') return;
      if (options.readError) throw options.readError;
      if (missing) throw missingError();
    };
    return {
      where(value) {
        assert.equal(inTransaction, false, 'feedback transactions must use document operations');
        if (name === 'users' && Object.hasOwn(value, 'bijingBound')) return authorization.db.collection(name).where(value);
        filter = value; return this;
      },
      orderBy(field, direction) { order.push([field, direction]); return this; },
      limit(value) { limit = value; return this; },
      field(value) { fields = value; return this; },
      async get() {
        reads.push({ name, filter: structuredClone(filter), order, limit }); check();
        if (options.invalidReadResponse) return {};
        let selected = (name === 'feedback' ? state : users).filter(row => matches(row, filter));
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
      assert.equal(name, 'feedback');
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
            return name === 'feedback' ? collection(name, pending, true) : authTransaction.collection(name);
          } });
          if (options.beforeFeedbackCommit) await options.beforeFeedbackCommit({ rows });
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
      require(module) { return module === 'wx-server-sdk' ? cloud : require(`../cloudfunctions/${name}/${module.slice(2)}`); }
    });
    return async event => JSON.parse(JSON.stringify(await exports.main(event)));
  }
  const user = load('meditationManager'), admin = load('adminManager');
  return { rows, reads, writes, moderations, creations, authorization,
    get conflicts() { return conflicts; }, user, admin,
    submit: event => user({ type: 'submitFeedback', content: ' 希望增加提醒 ', contact: ' 微信号123 ', requestId: 'request-1', ...event }),
    list: event => user({ type: 'getMyFeedback', ...event }),
    alert: event => user({ type: 'getFeedbackAlert', ...event }),
    markRead: feedbacks => user({ type: 'markFeedbackRead', feedbacks }) };
}

module.exports = { feedbackHarness, feedbackId, feedbackRow };

if (require.main === module) {
  test('feedback deployments contain identical portable service and text moderation permissions', () => {
    assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/feedback'), 'utf8'),
      fs.readFileSync(require.resolve('../cloudfunctions/meditationManager/feedback'), 'utf8'));
    for (const name of ['meditationManager', 'adminManager']) {
      assert.ok(require(`../cloudfunctions/${name}/config.json`).permissions.openapi.includes('security.msgSecCheck'));
    }
  });

  test('submit uses platform identity, trusted profile, server timestamps and private response projection', async () => {
    const app = feedbackHarness();
    const result = await app.submit({ openid: 'victim', ownerOpenid: 'victim', nickname: '伪造', studentNumber: 'BJ0099',
      status: 'resolved', reply: '伪造回复', handledBy: 'admin', createdAt: '1900' });
    assert.equal(result.success, true);
    const row = result.data.feedback;
    assert.equal(row._id, feedbackId('owner', 'request-1'));
    assert.equal(row.content, '希望增加提醒'); assert.equal(row.contact, '微信号123');
    assert.equal(row.nickname, '静心者'); assert.equal(row.studentNumber, 'BJ1000');
    assert.equal(row.status, 'pending'); assert.equal(row.reply, ''); assert.equal(row.handledAt, null);
    assert.equal(row.unreadForUser, false); assert.equal(app.rows[0].unreadForUser, false);
    assert.equal(new Date(row.createdAt).toISOString(), row.createdAt);
    for (const key of ['ownerOpenid', '_openid', 'handledBy', 'requestId']) assert.equal(Object.hasOwn(row, key), false);
    assert.equal(app.rows[0].ownerOpenid, 'owner'); assert.equal(app.rows[0]._openid, undefined);
    assert.deepEqual(app.moderations, [{ content: '希望增加提醒\n微信号123', openid: 'owner', version: 2, scene: 2 }]);
  });

  test('all user actions reject missing trusted identity before database or moderation', async () => {
    for (const context of [{}, { OPENID: '' }, { OPENID: ' invalid ' }]) {
      const app = feedbackHarness({ context });
      assert.equal((await app.submit({ openid: 'owner', _openid: 'owner' })).code, 'AUTH_REQUIRED');
      assert.equal((await app.list({ openid: 'owner' })).code, 'AUTH_REQUIRED');
      assert.equal((await app.alert({ ownerOpenid: 'owner' })).code, 'AUTH_REQUIRED');
      assert.equal((await app.markRead([])).code, 'AUTH_REQUIRED');
      assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0); assert.equal(app.moderations.length, 0);
    }
  });

  test('invalid feedback text, contact and submission IDs fail before any database access', async () => {
    for (const event of [{ content: '' }, { content: ' \n ' }, { content: 'a'.repeat(1001) }, { content: {} },
      { contact: null }, { contact: 'x'.repeat(101) }, { requestId: '' }, { requestId: '../foo' },
      { requestId: 'x'.repeat(101) }, { requestId: { $ne: '' } }]) {
      const app = feedbackHarness();
      assert.equal((await app.submit(event)).code, 'INVALID_ARGUMENT', JSON.stringify(event));
      assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
    }
  });

  test('repeated and concurrent requests are idempotent and changed bodies cannot replace feedback', async () => {
    const options = {};
    const app = feedbackHarness(options);
    const results = await Promise.all([app.submit(), app.submit(), app.submit()]);
    assert.ok(results.every(row => row.success)); assert.equal(app.rows.length, 1); assert.ok(app.conflicts > 0);
    assert.ok(results.every(row => row.data.feedback._id === results[0].data.feedback._id));
    options.moderationError = new Error('offline');
    assert.equal((await app.submit()).success, true);
    assert.equal((await app.submit({ content: '不同反馈' })).code, 'REQUEST_ID_REUSED');
    assert.equal(app.rows[0].content, '希望增加提醒');
    options.moderationError = null; options.context = { OPENID: 'another-owner' };
    assert.equal((await app.submit()).success, true); assert.equal(app.rows.length, 2);
  });

  test('moderation rejects risky/review/87014 and fails closed on missing conclusions or service errors', async () => {
    for (const [options, code] of [
      [{ moderationResult: { errCode: 0, result: { suggest: 'risky' } } }, 'CONTENT_REJECTED'],
      [{ moderationResult: { result: { suggest: 'review' } } }, 'CONTENT_REJECTED'],
      [{ moderationError: { errcode: 87014 } }, 'CONTENT_REJECTED'],
      [{ moderationResult: { errCode: 87014 } }, 'CONTENT_REJECTED'],
      [{ moderationResult: { errCode: 0 } }, 'CONTENT_CHECK_FAILED'],
      [{ moderationResult: null }, 'CONTENT_CHECK_FAILED'],
      [{ moderationError: new Error('permission unavailable') }, 'CONTENT_CHECK_FAILED'],
      [{ moderationResult: { errCode: 500, result: { suggest: 'pass' } } }, 'CONTENT_CHECK_FAILED']
    ]) {
      const app = feedbackHarness(options);
      assert.equal((await app.submit()).code, code); assert.equal(app.rows.length, 0); assert.equal(app.writes.length, 0);
    }
  });

  test('first use initializes only an explicitly missing feedback collection and never seeds rows', async () => {
    const app = feedbackHarness({ feedbackMissing: true });
    assert.deepEqual((await app.list()).data, { feedbacks: [], nextCursor: '' });
    assert.equal(app.creations.length, 0);
    assert.equal((await app.submit()).success, true);
    assert.deepEqual(app.creations, ['feedback']); assert.equal(app.rows.length, 1);
    const race = feedbackHarness({ feedbackMissing: true, createdByOther: true,
      creationError: new Error('collection feedback already exists') });
    assert.equal((await race.submit()).success, true);
    const failed = feedbackHarness({ feedbackMissing: true, creationError: new Error('permission denied') });
    assert.equal((await failed.submit()).code, 'FEEDBACK_UNAVAILABLE'); assert.equal(failed.rows.length, 0);
  });

  test('network, permissions and malformed responses cannot masquerade as missing collections or empty feedback', async () => {
    for (const options of [{ readError: Object.assign(new Error('request failed'), { errCode: -502001 }) },
      { readError: new Error('permission denied') }, { invalidReadResponse: true }]) {
      const app = feedbackHarness(options);
      for (const result of [await app.submit(), await app.list()]) {
        assert.equal(result.code, 'FEEDBACK_UNAVAILABLE'); assert.equal(result.data, undefined);
      }
      assert.equal(app.creations.length, 0); assert.equal(app.rows.length, 0);
    }
  });

  test('own feedback pagination isolates accounts and remains stable with equal times and newly inserted rows', async () => {
    const own = Array.from({ length: 5 }, (_, i) => feedbackRow(i, { handledBy: 'private-admin', privateField: 'secret' }));
    const app = feedbackHarness({ rows: [...own, feedbackRow('other', { ownerOpenid: 'victim' })] });
    const expected = own.map(row => row._id).sort().reverse();
    const first = await app.list({ limit: 2, ownerOpenid: 'victim', status: 'resolved' });
    assert.equal(first.success, true); assert.equal(first.data.feedbacks.length, 2); assert.ok(first.data.nextCursor);
    app.rows.push(feedbackRow('new', { createdAt: '2026-09-29T02:00:00.000Z' }));
    const second = await app.list({ limit: 2, cursor: first.data.nextCursor });
    const last = await app.list({ limit: 2, cursor: second.data.nextCursor });
    const combined = [first, second, last].flatMap(page => page.data.feedbacks);
    assert.deepEqual(combined.map(row => row._id), expected); assert.equal(last.data.nextCursor, '');
    assert.ok(combined.every(row => !Object.hasOwn(row, 'handledBy') && !Object.hasOwn(row, 'ownerOpenid') && !Object.hasOwn(row, 'privateField')));
  });

  test('invalid pagination and operator objects are rejected before reads', async () => {
    for (const event of [{ cursor: {} }, { cursor: null }, { cursor: '../x' }, { cursor: 'e30' },
      { limit: 0 }, { limit: 51 }, { limit: '20' }, { limit: 1.5 }]) {
      const app = feedbackHarness();
      assert.equal((await app.list(event)).code, 'INVALID_ARGUMENT'); assert.equal(app.reads.length, 0);
    }
  });

  test('profile snapshots scan legacy duplicates and prefer the current bound profile', async () => {
    const users = Array.from({ length: 102 }, (_, i) => ({ _id: `user-${String(i).padStart(4, '0')}`, _openid: 'owner', nickName: '旧昵称' }));
    users.push({ _id: 'user-9999', _openid: 'owner', nickName: '当前昵称', bijingBound: true,
      bijingStudentNumber: 'BJ1234', bijingBindingVersion: 'active' });
    const app = feedbackHarness({ users });
    const result = await app.submit();
    assert.equal(result.data.feedback.nickname, '当前昵称'); assert.equal(result.data.feedback.studentNumber, 'BJ1234');
    assert.equal(app.reads.filter(row => row.name === 'users').length, 2);
    const noProfile = await feedbackHarness({ users: [] }).submit({ contact: undefined });
    assert.equal(noProfile.data.feedback.nickname, '匿名用户'); assert.equal(noProfile.data.feedback.studentNumber, '');
  });

  test('failed transaction commits never report success or persist the request', async () => {
    const app = feedbackHarness({ commitError: new Error('transaction failed') });
    const result = await app.submit();
    assert.equal(result.code, 'FEEDBACK_UNAVAILABLE'); assert.equal(app.rows.length, 0);
  });

  test('feedback alerts use the authenticated owner and find unread results beyond the first page', async () => {
    const app = feedbackHarness({ rows: [
      ...Array.from({ length: 55 }, (_, index) => feedbackRow(index)),
      feedbackRow('unread', { status: 'resolved', unreadForUser: true, createdAt: '2026-09-28T01:00:00.000Z' }),
      feedbackRow('other', { ownerOpenid: 'victim', status: 'resolved', unreadForUser: true })
    ] });
    assert.ok((await app.list()).data.feedbacks.every(row => row.unreadForUser === false));
    assert.deepEqual(await app.alert({ ownerOpenid: 'victim', openid: 'victim' }),
      { success: true, data: { hasUnreadFeedback: true } });
    const query = app.reads.at(-1);
    assert.deepEqual(query.filter, { ownerOpenid: 'owner', status: 'resolved', unreadForUser: true });
    assert.equal(query.limit, 1); assert.equal(app.writes.length, 0);
    app.rows.find(row => row._id === feedbackId('owner', 'request-unread')).unreadForUser = false;
    assert.equal((await app.alert()).data.hasUnreadFeedback, false);
    app.rows[0].unreadForUser = true;
    assert.equal((await app.alert()).data.hasUnreadFeedback, false, 'unfinished feedback is not a result notification');
  });

  test('listing preserves unread state; acknowledgements affect only displayed owned revisions', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => feedbackRow(index, { status: 'resolved', unreadForUser: true }));
    const foreign = feedbackRow('foreign', { ownerOpenid: 'victim', status: 'resolved', unreadForUser: true });
    const app = feedbackHarness({ rows: [...rows, foreign] });
    const first = await app.list({ limit: 2 });
    assert.ok(first.data.feedbacks.every(row => row.unreadForUser));
    assert.ok(app.rows.every(row => row.unreadForUser)); assert.equal(app.writes.length, 0);
    const seen = first.data.feedbacks.map(row => ({ feedbackId: row._id, expectedUpdatedAt: row.updatedAt }));
    const result = await app.markRead([...seen, { feedbackId: foreign._id, expectedUpdatedAt: foreign.updatedAt },
      { feedbackId: feedbackId('owner', 'missing'), expectedUpdatedAt: rows[0].updatedAt }]);
    assert.deepEqual(result, { success: true, data: { markedCount: 2 } });
    assert.equal((await app.alert()).data.hasUnreadFeedback, true);
    assert.equal(app.rows.filter(row => row.unreadForUser).length, 4);
    assert.equal(app.rows.find(row => row._id === foreign._id).unreadForUser, true);
    assert.equal((await app.markRead(seen)).data.markedCount, 0, 'acknowledgements are idempotent');
    assert.ok(app.rows.every(row => row.updatedAt === rows[0].updatedAt), 'viewing does not change a content revision');
    let cursor = first.data.nextCursor;
    while (cursor) {
      const page = (await app.list({ limit: 2, cursor })).data;
      await app.markRead(page.feedbacks.map(row => ({ feedbackId: row._id, expectedUpdatedAt: row.updatedAt })));
      cursor = page.nextCursor;
    }
    assert.equal((await app.alert()).data.hasUnreadFeedback, false);
  });

  test('legacy feedback without unread state is read and first-use checks never create collections', async () => {
    const legacy = feedbackHarness({ rows: [feedbackRow(1, { status: 'resolved' })] });
    assert.equal((await legacy.list()).data.feedbacks[0].unreadForUser, false);
    assert.equal((await legacy.alert()).data.hasUnreadFeedback, false);
    const seen = [{ feedbackId: feedbackRow(1)._id, expectedUpdatedAt: feedbackRow(1).updatedAt }];
    assert.equal((await legacy.markRead(seen)).data.markedCount, 0);
    const missing = feedbackHarness({ feedbackMissing: true });
    assert.deepEqual((await missing.alert()).data, { hasUnreadFeedback: false });
    assert.deepEqual((await missing.markRead(seen)).data, { markedCount: 0 });
    assert.equal(missing.creations.length, 0); assert.equal(missing.writes.length, 0);
  });

  test('acknowledgements validate every ID and revision and cap the batch before any reads', async () => {
    const valid = { feedbackId: feedbackRow(1)._id, expectedUpdatedAt: feedbackRow(1).updatedAt };
    for (const feedbacks of [undefined, null, {}, [null], [{}], [{ ...valid, feedbackId: '../victim' }],
      [{ ...valid, feedbackId: { $ne: '' } }], [{ ...valid, expectedUpdatedAt: '2026-09-29' }],
      [{ ...valid, expectedUpdatedAt: null }], [valid, valid],
      Array.from({ length: 51 }, (_, index) => ({ ...valid, feedbackId: feedbackRow(index)._id }))]) {
      const app = feedbackHarness();
      assert.equal((await app.markRead(feedbacks)).code, 'INVALID_ARGUMENT');
      assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
    }
    const app = feedbackHarness({ rows: Array.from({ length: 50 }, (_, index) => feedbackRow(index, { status: 'resolved', unreadForUser: true })) });
    assert.equal((await app.markRead([])).data.markedCount, 0);
    assert.equal((await app.markRead(app.rows.map(row => ({ feedbackId: row._id, expectedUpdatedAt: row.updatedAt })))).data.markedCount, 50);
  });

  test('a reply changed after display remains unread and concurrent acknowledgements are idempotent', async () => {
    const row = feedbackRow(1, { status: 'resolved', unreadForUser: true });
    const seen = [{ feedbackId: row._id, expectedUpdatedAt: row.updatedAt }];
    const changed = feedbackHarness({ rows: [row], beforeTransaction({ rows }) {
      rows[0].updatedAt = '2026-09-29T03:00:00.000Z'; rows[0].reply = '管理员更新了回复';
    } });
    assert.equal((await changed.markRead(seen)).data.markedCount, 0);
    assert.equal(changed.rows[0].unreadForUser, true); assert.equal(changed.writes.length, 0);
    let competingReply = false;
    const racing = feedbackHarness({ rows: [row], beforeFeedbackCommit({ rows }) {
      if (competingReply) return;
      competingReply = true;
      rows[0].updatedAt = '2026-09-29T04:00:00.000Z'; rows[0].reply = '读取后、提交前更新的回复';
    } });
    assert.equal((await racing.markRead(seen)).data.markedCount, 0);
    assert.equal(racing.rows[0].unreadForUser, true); assert.equal(racing.conflicts, 1);
    const concurrent = feedbackHarness({ rows: [row] });
    const results = await Promise.all([concurrent.markRead(seen), concurrent.markRead(seen)]);
    assert.ok(results.every(result => result.success));
    assert.equal(results.reduce((total, result) => total + result.data.markedCount, 0), 1);
    assert.equal(concurrent.rows[0].unreadForUser, false); assert.ok(concurrent.conflicts > 0);
  });

  test('unread queries and acknowledgements fail closed on read, write and commit failures', async () => {
    for (const options of [{ readError: new Error('private error') }, { invalidReadResponse: true }]) {
      const app = feedbackHarness(options);
      assert.equal((await app.alert()).code, 'FEEDBACK_UNAVAILABLE');
      assert.equal((await app.markRead([{ feedbackId: feedbackRow(1)._id, expectedUpdatedAt: feedbackRow(1).updatedAt }])).code, 'FEEDBACK_UNAVAILABLE');
    }
    for (const options of [{ writeError: new Error('private write error') }, { commitError: new Error('private commit error') }]) {
      const row = feedbackRow(1, { status: 'resolved', unreadForUser: true });
      const app = feedbackHarness({ ...options, rows: [row] });
      const result = await app.markRead([{ feedbackId: row._id, expectedUpdatedAt: row.updatedAt }]);
      assert.equal(result.code, 'FEEDBACK_UNAVAILABLE'); assert.equal(result.data, undefined);
      assert.equal(result.error.includes('private'), false); assert.equal(app.rows[0].unreadForUser, true);
    }
  });
}
