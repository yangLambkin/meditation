const assert = require('node:assert/strict');
const test = require('node:test');
const { createSyncFailures, errorId } = require('../cloudfunctions/bijingSync/syncFailures');

const date = '2026-10-01';
const user = { _id: 'new-user', _openid: 'new-owner', bijingBound: true, bijingStudentNumber: 'BJ001' };
const id = errorId(user.bijingStudentNumber, date);
const clone = value => JSON.parse(JSON.stringify(value));
function harness(rows = {}) {
  let state = { users: { [user._id]: clone(user), ...rows.users }, bijing_sync_errors: { ...rows.errors } };
  const database = target => ({ collection: name => ({ doc: key => ({
    async get() { return { data: target[name][key] ? clone(target[name][key]) : null }; },
    async set({ data }) { target[name][key] = { _id: key, ...clone(data) }; },
    async update({ data }) { Object.assign(target[name][key], clone(data)); },
    async remove() { delete target[name][key]; },
  }) }) });
  const db = { async runTransaction(callback) {
    const pending = clone(state);
    const result = await callback(database(pending));
    state = pending;
    return result;
  } };
  return { queue: createSyncFailures({ db, now: () => 1000 }), get state() { return state; } };
}

test('request failure preserves the observed remote value and mutation version for scheduled repair', async () => {
  const app = harness({ errors: { [id]: { userId: user._id, openid: user._openid, queueVersion: 'record-change',
    actualDurationMinutes: 10, exists: true, reason: 'duration_mismatch', retryCount: 2 } } });
  const attempt = await app.queue.begin(user, date, 30);
  await app.queue.fail(attempt, 'network unavailable');
  assert.equal(app.state.bijing_sync_errors[id].queueVersion, 'record-change');
  assert.equal(app.state.bijing_sync_errors[id].actualDurationMinutes, 10);
  assert.equal(app.state.bijing_sync_errors[id].expectedDurationMinutes, 30);
  assert.equal(app.state.bijing_sync_errors[id].retryCount, 3);
});

test('old success and old failure cannot overwrite a new recording transaction intent', async () => {
  const app = harness();
  const attempt = await app.queue.begin(user, date, 20);
  Object.assign(app.state.bijing_sync_errors[id], { queueVersion: 'later-change', expectedDurationMinutes: 30, error: 'new pending' });
  assert.equal(await app.queue.confirm(attempt), false);
  assert.equal(await app.queue.fail(attempt, 'old request failed'), false);
  assert.equal(app.state.bijing_sync_errors[id].expectedDurationMinutes, 30);
  assert.equal(app.state.bijing_sync_errors[id].error, 'new pending');
});

test('an in-flight failure recreates repair work if another worker already removed the old row', async () => {
  const app = harness();
  const attempt = await app.queue.begin(user, date, 20);
  assert.equal(await app.queue.confirm(attempt), true);
  assert.equal(await app.queue.fail(attempt, 'late transport failure'), true);
  const row = app.state.bijing_sync_errors[id];
  assert.notEqual(row.queueVersion, attempt.queueVersion);
  assert.equal(row.reason, 'sync_failed');
  assert.equal(row.actualDurationMinutes, null);
  assert.equal(row.exists, null);
});

test('a late unverified success restores pending work without classifying the upload as a failure', async () => {
  const app = harness();
  const attempt = await app.queue.begin(user, date, 20);
  await app.queue.confirm(attempt);
  assert.equal(await app.queue.retain(attempt), true);
  const row = app.state.bijing_sync_errors[id];
  assert.notEqual(row.queueVersion, attempt.queueVersion);
  assert.equal(row.reason, 'sync_pending');
  assert.equal(row.error, '等待核对必经同步结果');
  assert.equal(row.retryCount, 0);
  assert.equal(row.expectedDurationMinutes, 20);
  assert.equal(row.actualDurationMinutes, null);
  assert.equal(row.exists, null);
  assert.equal(row.zeroEligible, true);
  assert.equal(await app.queue.retain(attempt), false);
  assert.deepEqual(app.state.bijing_sync_errors[id], row, 'Repeated upload callbacks cannot refresh the restored version or retry counter');
});

test('retaining a success never overwrites a newer or foreign repair intent', async () => {
  for (const foreign of [false, true]) {
    const app = harness();
    const attempt = await app.queue.begin(user, date, 20);
    Object.assign(app.state.bijing_sync_errors[id], { queueVersion: 'new-work', expectedDurationMinutes: 35,
      actualDurationMinutes: 10, retryCount: 4, error: 'new diagnosis',
      ...(foreign ? { userId: 'another-user', openid: 'another-owner' } : {}) });
    const current = clone(app.state.bijing_sync_errors[id]);
    assert.equal(await app.queue.retain(attempt), false);
    assert.deepEqual(app.state.bijing_sync_errors[id], current);
  }
});

test('a success from an inactive or changed binding cannot restore an absent repair row', async () => {
  for (const change of [{ bijingBound: false }, { bijingStudentNumber: 'BJOTHER' }, { _openid: 'different-owner' }]) {
    const app = harness();
    const attempt = await app.queue.begin(user, date, 20);
    await app.queue.confirm(attempt);
    Object.assign(app.state.users[user._id], change);
    assert.equal(await app.queue.retain(attempt), false);
    assert.equal(app.state.bijing_sync_errors[id], undefined);
  }
});

test('an unknown source total cannot authorize deleting remote data', async () => {
  const app = harness();
  const attempt = await app.queue.begin(user, date, 0, 'source_read_failed');
  await app.queue.fail(attempt, 'source unavailable');
  assert.equal(app.state.bijing_sync_errors[id].zeroEligible, false);
  assert.equal(app.state.bijing_sync_errors[id].reason, 'source_read_failed');
  await app.queue.confirm(attempt);
  await app.queue.fail(attempt, 'late source failure');
  assert.equal(app.state.bijing_sync_errors[id].zeroEligible, false);
  assert.equal(app.state.bijing_sync_errors[id].reason, 'source_read_failed');
});

test('a valid new binding takes over an unbound former owner error without losing the old diagnostic', async () => {
  const old = { userId: 'old-user', openid: 'old-owner', queueVersion: 'old-version', reason: 'upload_failed', error: 'old failure' };
  const app = harness({ users: { 'old-user': { _id: 'old-user', bijingBound: false } }, errors: { [id]: old } });
  const attempt = await app.queue.begin(user, date, 30);
  const row = app.state.bijing_sync_errors[id];
  assert.equal(row.openid, user._openid);
  assert.notEqual(row.queueVersion, 'old-version');
  assert.equal(row.previousBindingFailure.error, 'old failure');
  assert.equal(await app.queue.confirm({ id, ...old }), false);
  assert.equal(await app.queue.confirm(attempt), true);
  assert.equal(app.state.bijing_sync_errors[id], undefined);
});

test('conflicting active bindings keep the previous repair record intact', async () => {
  const old = { userId: 'old-user', openid: 'old-owner', queueVersion: 'old-version' };
  const app = harness({ users: { 'old-user': { _id: 'old-user', bijingBound: true, bijingStudentNumber: 'bj001' } }, errors: { [id]: old } });
  await assert.rejects(app.queue.begin(user, date, 30), /其他账号绑定/);
  assert.deepEqual(app.state.bijing_sync_errors[id], old);
});
