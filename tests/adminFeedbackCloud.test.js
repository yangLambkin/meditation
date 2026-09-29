const assert = require('node:assert/strict');
const test = require('node:test');
const { feedbackHarness, feedbackId, feedbackRow } = require('./feedbackCloud.test');

function adminHarness(options = {}) {
  const app = feedbackHarness({ context: { OPENID: 'admin' }, rows: [feedbackRow(1)], ...options });
  return { ...app, list: event => app.admin({ type: 'adminListFeedback', status: 'all', ...event }),
    update: event => app.admin({ type: 'adminUpdateFeedback', feedbackId: feedbackId('owner', 'request-1'),
      status: 'processing', reply: ' 已收到，我们正在处理 ', expectedUpdatedAt: '2026-09-29T01:00:00.000Z', ...event }),
    remove: event => app.admin({ type: 'adminDeleteFeedback', feedbackId: feedbackId('owner', 'request-1'),
      expectedUpdatedAt: '2026-09-29T01:00:00.000Z', ...event }) };
}

test('all feedback admin operations require central bound-student authorization before feedback access', async () => {
  for (const context of [{ OPENID: 'owner' }, { OPENID: 'maintenance' }, {}, { SOURCE: 'wx_trigger' }]) {
    const app = adminHarness({ context });
    for (const action of [app.list, app.update, app.remove]) {
      const result = await action({ OPENID: 'admin', openid: 'admin', isAdmin: true, studentNumber: 'BJ0099',
        ADMIN_STUDENT_NUMBERS: 'BJ0099', accessDelegation: { openid: 'admin' } });
      assert.equal(result.code, 'FORBIDDEN'); assert.equal(result.data, undefined);
    }
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0); assert.equal(app.moderations.length, 0);
  }
  for (const environment of [{}, { ADMIN_OPENID: 'admin' }, { MAINTENANCE_ADMIN_OPENIDS: 'admin' }, { ADMIN_STUDENT_NUMBERS: 'BJ0099,' }]) {
    const app = adminHarness({ environment });
    for (const action of [app.list, app.update, app.remove]) assert.equal((await action()).code, 'FORBIDDEN');
    assert.equal(app.reads.length, 0);
  }
});

test('administrator authorization failures fail closed and do not touch feedback', async () => {
  const app = adminHarness({ authDatabaseError: new Error('database unavailable') });
  assert.equal((await app.list()).code, 'ADMIN_AUTH_UNAVAILABLE');
  assert.equal((await app.update()).code, 'ADMIN_AUTH_UNAVAILABLE');
  assert.equal((await app.remove()).code, 'ADMIN_AUTH_UNAVAILABLE');
  assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
});

test('admin list exposes required owner metadata while filtering and paginating all owners', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => feedbackRow(index, {
    ownerOpenid: index % 2 ? 'owner' : 'another-owner', status: index < 4 ? 'pending' : 'resolved',
    handledBy: 'other-admin', privateData: 'not-for-response'
  }));
  const app = adminHarness({ rows });
  const first = await app.list({ status: 'pending', limit: 2 });
  const second = await app.list({ status: 'pending', limit: 2, cursor: first.data.nextCursor });
  const combined = [...first.data.feedbacks, ...second.data.feedbacks];
  assert.equal(first.success, true); assert.equal(second.data.nextCursor, '');
  assert.deepEqual(combined.map(row => row._id), rows.filter(row => row.status === 'pending').map(row => row._id).sort().reverse());
  assert.equal(new Set(combined.map(row => row.ownerOpenid)).size, 2);
  assert.ok(combined.every(row => row.handledBy === 'other-admin' && !Object.hasOwn(row, 'privateData')));
  assert.equal((await app.list()).data.feedbacks.length, 6);
  assert.equal((await app.list({ status: 'processing' })).data.feedbacks.length, 0);
});

test('admin update trims and moderates replies, records trusted handler and supports status transitions', async () => {
  const app = adminHarness();
  const result = await app.update({ handledBy: 'spoofed-handler', ownerOpenid: 'spoofed-owner', content: 'spoofed-content' });
  assert.equal(result.success, true);
  const processing = result.data.feedback;
  assert.equal(processing.status, 'processing'); assert.equal(processing.reply, '已收到，我们正在处理');
  assert.equal(processing.unreadForUser, false);
  assert.equal(processing.handledBy, 'admin'); assert.equal(processing.handledAt, null); assert.equal(processing.ownerOpenid, 'owner');
  assert.equal(processing.content, '反馈 1'); assert.ok(processing.updatedAt > '2026-09-29T01:00:00.000Z');
  assert.deepEqual(app.moderations, [{ content: '已收到，我们正在处理', openid: 'admin', version: 2, scene: 2 }]);
  const resolved = await app.update({ status: 'resolved', reply: processing.reply, expectedUpdatedAt: processing.updatedAt });
  assert.equal(resolved.data.feedback.handledAt, resolved.data.feedback.updatedAt);
  assert.equal(resolved.data.feedback.unreadForUser, true);
  assert.ok(resolved.data.feedback.updatedAt > processing.updatedAt);
  const reopened = await app.update({ status: 'pending', reply: '', expectedUpdatedAt: resolved.data.feedback.updatedAt });
  assert.equal(reopened.data.feedback.status, 'pending'); assert.equal(reopened.data.feedback.reply, '');
  assert.equal(reopened.data.feedback.handledAt, null);
  assert.equal(reopened.data.feedback.unreadForUser, false);
  assert.equal(app.moderations.length, 1, 'status changes retaining an approved reply do not depend on moderation availability');
});

test('saving an unchanged result preserves read state and revision while changed replies notify again', async () => {
  const app = adminHarness({ rows: [feedbackRow(1, { status: 'resolved', reply: '问题已修复', unreadForUser: false })] });
  const unchanged = await app.update({ status: 'resolved', reply: ' 问题已修复 ' });
  assert.equal(unchanged.success, true); assert.equal(unchanged.data.feedback.unreadForUser, false);
  assert.equal(unchanged.data.feedback.updatedAt, '2026-09-29T01:00:00.000Z');
  assert.equal(app.writes.length, 0); assert.equal(app.moderations.length, 0);
  const revised = await app.update({ status: 'resolved', reply: '已在最新版本修复' });
  assert.equal(revised.success, true); assert.equal(revised.data.feedback.unreadForUser, true);
  const writes = app.writes.length;
  const repeat = await app.update({ status: 'resolved', reply: revised.data.feedback.reply, expectedUpdatedAt: revised.data.feedback.updatedAt });
  assert.equal(repeat.data.feedback.unreadForUser, true); assert.equal(app.writes.length, writes);
  const reopened = await app.update({ status: 'processing', reply: revised.data.feedback.reply, expectedUpdatedAt: revised.data.feedback.updatedAt });
  assert.equal(reopened.data.feedback.unreadForUser, false);
  const resolvedAgain = await app.update({ status: 'resolved', reply: reopened.data.feedback.reply, expectedUpdatedAt: reopened.data.feedback.updatedAt });
  assert.equal(resolvedAgain.data.feedback.unreadForUser, true);
});

test('a user acknowledgement racing a new admin reply cannot hide the new result', async () => {
  const row = feedbackRow(1, { status: 'resolved', reply: '原回复', unreadForUser: true });
  const options = { rows: [row], context: { OPENID: 'owner' } };
  const app = feedbackHarness(options);
  const acknowledgement = app.markRead([{ feedbackId: row._id, expectedUpdatedAt: row.updatedAt }]);
  options.context = { OPENID: 'admin' };
  const update = app.admin({ type: 'adminUpdateFeedback', feedbackId: row._id, status: 'resolved',
    reply: '新回复', expectedUpdatedAt: row.updatedAt });
  const results = await Promise.all([acknowledgement, update]);
  assert.ok(results.every(result => result.success));
  assert.equal(app.rows[0].reply, '新回复'); assert.equal(app.rows[0].unreadForUser, true);
});

test('stale expectedUpdatedAt rejects before moderation and cannot overwrite newer processing', async () => {
  const app = adminHarness();
  assert.equal((await app.update()).success, true);
  const saved = structuredClone(app.rows[0]);
  const stale = await app.update({ status: 'resolved', reply: '覆盖新回复' });
  assert.equal(stale.code, 'CONFLICT'); assert.deepEqual(app.rows[0], saved); assert.equal(app.moderations.length, 1);
});

test('concurrent admin updates with the same revision allow only one committed edit', async () => {
  const app = adminHarness();
  const results = await Promise.all([app.update({ reply: '第一位管理员处理' }), app.update({ reply: '第二位管理员处理' })]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
  assert.equal(app.rows[0].reply, results.find(result => result.success).data.feedback.reply);
});

test('transaction rechecks revision after slow moderation and preserves competing edits', async () => {
  const app = adminHarness({ onModerate({ rows }) {
    rows[0].updatedAt = '2026-09-29T03:00:00.000Z'; rows[0].reply = '并发保存的回复'; rows[0].status = 'resolved';
  } });
  const result = await app.update();
  assert.equal(result.code, 'CONFLICT'); assert.equal(app.rows[0].reply, '并发保存的回复'); assert.equal(app.writes.length, 0);
});

test('updatedAt advances even when the prior revision is ahead of the server clock', async () => {
  const timestamp = '2099-09-29T01:00:00.000Z';
  const app = adminHarness({ rows: [feedbackRow(1, { updatedAt: timestamp })] });
  const result = await app.update({ expectedUpdatedAt: timestamp });
  assert.equal(result.data.feedback.updatedAt, '2099-09-29T01:00:00.001Z');
});

test('invalid status, document IDs, replies and revision strings cannot perform business reads or writes', async () => {
  for (const event of [{ feedbackId: '' }, { feedbackId: { $ne: '' } }, { feedbackId: '../victim' },
    { status: 'deleted' }, { status: {} }, { reply: undefined }, { reply: {} }, { reply: 'x'.repeat(1001) },
    { expectedUpdatedAt: '2026-09-29' }, { expectedUpdatedAt: null }, { expectedUpdatedAt: 'invalid' }]) {
    const app = adminHarness();
    assert.equal((await app.update(event)).code, 'INVALID_ARGUMENT', JSON.stringify(event));
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
  const invalidList = adminHarness();
  assert.equal((await invalidList.list({ status: 'unknown' })).code, 'INVALID_ARGUMENT');
  assert.equal((await invalidList.list({ cursor: {} })).code, 'INVALID_ARGUMENT');
  assert.equal(invalidList.reads.length, 0);
});

test('missing feedback and first-use lists do not create collections or phantom updates', async () => {
  for (const options of [{ rows: [] }, { feedbackMissing: true }]) {
    const app = adminHarness(options);
    assert.deepEqual((await app.list()).data, { feedbacks: [], nextCursor: '' });
    assert.equal((await app.update()).code, 'NOT_FOUND'); assert.equal(app.writes.length, 0); assert.equal(app.creations.length, 0);
  }
});

test('unsafe or unchecked replies never change feedback', async () => {
  for (const [options, code] of [
    [{ moderationResult: { result: { suggest: 'review' } } }, 'CONTENT_REJECTED'],
    [{ moderationError: { errCode: 87014 } }, 'CONTENT_REJECTED'],
    [{ moderationResult: { errCode: 0 } }, 'CONTENT_CHECK_FAILED'],
    [{ moderationError: new Error('temporary unavailable') }, 'CONTENT_CHECK_FAILED']
  ]) {
    const app = adminHarness(options);
    const original = structuredClone(app.rows[0]);
    assert.equal((await app.update()).code, code); assert.deepEqual(app.rows[0], original); assert.equal(app.writes.length, 0);
  }
});

test('failed reads and writes return a retryable error without success or private exception details', async () => {
  for (const options of [{ readError: new Error('private connection string') },
    { writeError: new Error('private write error') }, { commitError: new Error('private transaction error') }]) {
    const app = adminHarness(options);
    const original = structuredClone(app.rows[0]);
    const result = await app.update();
    assert.equal(result.code, 'FEEDBACK_UNAVAILABLE'); assert.equal(result.data, undefined);
    assert.equal(result.error.includes('private'), false); assert.deepEqual(app.rows[0], original);
  }
});

test('admin deletion removes any feedback status through a version-checked transaction', async () => {
  for (const status of ['pending', 'processing', 'resolved']) {
    const target = feedbackRow(1, { status, unreadForUser: status === 'resolved' });
    const survivor = feedbackRow(2, { ownerOpenid: 'another-owner' });
    const app = adminHarness({ rows: [target, survivor] });
    assert.deepEqual(await app.remove(), { success: true, data: { feedbackId: target._id, deleted: true } });
    assert.deepEqual(app.rows, [survivor]);
    assert.deepEqual(app.reads, [{ name: 'feedback', id: target._id, inTransaction: true }]);
    assert.deepEqual(app.writes, [{ name: 'feedback', id: target._id, operation: 'remove' }]);
    assert.equal(app.moderations.length, 0); assert.equal(app.creations.length, 0);
    assert.ok((await app.list()).data.feedbacks.every(row => row._id !== target._id));
  }
});

test('deleted feedback disappears from the owner list and unread reminder', async () => {
  const target = feedbackRow(1, { status: 'resolved', unreadForUser: true });
  const options = { rows: [target], context: { OPENID: 'owner' } };
  const app = feedbackHarness(options);
  assert.equal((await app.alert()).data.hasUnreadFeedback, true);
  options.context = { OPENID: 'admin' };
  assert.equal((await app.admin({ type: 'adminDeleteFeedback', feedbackId: target._id,
    expectedUpdatedAt: target.updatedAt })).success, true);
  options.context = { OPENID: 'owner' };
  assert.deepEqual((await app.list()).data, { feedbacks: [], nextCursor: '' });
  assert.deepEqual((await app.alert()).data, { hasUnreadFeedback: false });
  assert.deepEqual((await app.markRead([{ feedbackId: target._id, expectedUpdatedAt: target.updatedAt }])).data,
    { markedCount: 0 });
});

test('deletion is unavailable from meditationManager for users and administrators', async () => {
  for (const context of [{ OPENID: 'owner' }, { OPENID: 'admin' }, { OPENID: 'maintenance' }]) {
    const app = adminHarness({ context });
    const original = structuredClone(app.rows);
    const result = await app.user({ type: 'adminDeleteFeedback', feedbackId: original[0]._id,
      expectedUpdatedAt: original[0].updatedAt, isAdmin: true, openid: 'admin' });
    assert.equal(result.success, false); assert.equal(result.data, undefined);
    assert.deepEqual(app.rows, original); assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('deletion validates the ID and expected revision before feedback access', async () => {
  for (const event of [{ feedbackId: undefined }, { feedbackId: '' }, { feedbackId: '../victim' },
    { feedbackId: { $ne: '' } }, { expectedUpdatedAt: undefined }, { expectedUpdatedAt: null },
    { expectedUpdatedAt: '2026-09-29' }, { expectedUpdatedAt: '2026-02-30T01:00:00.000Z' },
    { expectedUpdatedAt: { $ne: '' } }]) {
    const app = adminHarness();
    assert.equal((await app.remove(event)).code, 'INVALID_ARGUMENT', JSON.stringify(event));
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0); assert.equal(app.creations.length, 0);
  }
});

test('lost deletion responses, concurrent deletion and missing collections are idempotent', async () => {
  const target = feedbackRow(1);
  const expected = { success: true, data: { feedbackId: target._id, deleted: true } };
  const app = adminHarness();
  const results = await Promise.all([app.remove(), app.remove()]);
  assert.deepEqual(results, [expected, expected]);
  assert.equal(app.rows.length, 0);
  const writes = app.writes.length;
  assert.deepEqual(await app.remove(), expected);
  assert.equal(app.writes.length, writes);
  for (const options of [{ rows: [] }, { feedbackMissing: true },
    { rows: [], readError: new Error('DATABASE_DOCUMENT_NOT_EXIST') }]) {
    const missing = adminHarness(options);
    assert.deepEqual(await missing.remove(), expected);
    assert.equal(missing.writes.length, 0); assert.equal(missing.creations.length, 0);
  }
});

test('stale deletion revisions preserve changes made before the transaction starts', async () => {
  for (const options of [
    { rows: [feedbackRow(1, { updatedAt: '2026-09-29T03:00:00.000Z', reply: '较新回复' })] },
    { beforeTransaction({ rows }) {
      rows[0].updatedAt = '2026-09-29T03:00:00.000Z'; rows[0].reply = '较新回复';
    } }
  ]) {
    const app = adminHarness(options);
    assert.equal((await app.remove()).code, 'CONFLICT');
    assert.equal(app.rows.length, 1); assert.equal(app.rows[0].reply, '较新回复');
    assert.equal(app.writes.length, 0);
  }
});

test('deletion transaction retries preserve replies committed after the version check', async () => {
  let competingReply = false;
  const app = feedbackHarness({ rows: [feedbackRow(1)], context: { OPENID: 'admin' },
    beforeFeedbackCommit({ rows }) {
      if (competingReply) return;
      competingReply = true;
      rows[0].updatedAt = '2026-09-29T04:00:00.000Z'; rows[0].reply = '并发处理的回复'; rows[0].status = 'resolved';
    }
  });
  const result = await app.admin({ type: 'adminDeleteFeedback', feedbackId: feedbackRow(1)._id,
    expectedUpdatedAt: feedbackRow(1).updatedAt });
  assert.equal(result.code, 'CONFLICT'); assert.equal(app.conflicts, 1);
  assert.equal(app.rows.length, 1); assert.equal(app.rows[0].reply, '并发处理的回复');
  assert.equal(app.rows[0].status, 'resolved');
});

test('deletion read, write and commit failures never report success or expose exceptions', async () => {
  const missingCollection = Object.assign(new Error('private collection failure'), { errCode: -502005 });
  for (const options of [{ readError: new Error('private connection string') }, { invalidReadResponse: true },
    { writeError: new Error('private write error') }, { commitError: new Error('private transaction error') },
    { writeError: missingCollection }, { commitError: missingCollection }]) {
    const app = adminHarness(options);
    const original = structuredClone(app.rows);
    const result = await app.remove();
    assert.equal(result.code, 'FEEDBACK_UNAVAILABLE'); assert.equal(result.data, undefined);
    assert.equal(result.error.includes('private'), false); assert.deepEqual(app.rows, original);
    assert.equal(app.creations.length, 0);
  }
});
