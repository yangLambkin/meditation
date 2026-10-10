const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../miniprogram/utils/bijingRecordSync'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const OWNER = 'oz-owner';
const DATE = '2026-10-03';
const saved = (recordId = 'record-1', date = DATE) => ({ recordId, date, autoSyncBijing: true });
const deleted = (recordId = 'record-1', deletionId = `md_${'a'.repeat(64)}`, date = DATE) =>
  ({ recordId, deletionId, date, autoSyncBijing: true });

function harness({ storage = new Map(), account = OWNER, storageFails = false, callThrows = false } = {}) {
  const requests = [], timers = new Map(), writes = [];
  let sequence = 0, now = Date.parse('2026-10-05T04:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Date: Clock,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      getStorageSync(key) {
        if (key === 'userOpenId') return account;
        return storage.has(key) ? structuredClone(storage.get(key)) : '';
      },
      setStorageSync(key, value) {
        writes.push({ key, value: plain(value) });
        if (storageFails) throw new Error('storage unavailable');
        storage.set(key, plain(value));
      },
      cloud: { callFunction(request) {
        assert.equal(request.name, 'bijingSync');
        if (request.data.type === 'syncDeletedDate') {
          assert.match(request.data.deletionId, /^md_[0-9a-f]{64}$/);
          assert.deepEqual(Object.keys(request.data).sort(), ['deletionId', 'expectedOpenid', 'type']);
        } else {
          assert.equal(request.data.type, 'syncRecordedDate');
          assert.ok(request.data.recordId);
          assert.deepEqual(Object.keys(request.data).sort(), ['expectedOpenid', 'recordId', 'type']);
        }
        assert.equal(request.data.expectedOpenid, account);
        if (callThrows) throw new Error('cloud unavailable');
        requests.push(request);
      } }
    }
  });
  const api = module.exports;
  return {
    api, storage, requests, timers, writes,
    account(value) { account = value; },
    now(value) { now = value; },
    confirm(value = saved()) { return api.acceptSavedRecord(value, { account }); },
    confirmDeleted(value = deleted()) { return api.acceptDeletedRecord(value, { account }); },
    result(index, value) { requests[index].success({ result: value }); },
    synced(index = requests.length - 1, date = DATE, duration = 30) {
      requests[index].success({ result: { success: true, data: { date, success: true, duration } } });
    },
    fail(index = requests.length - 1, message = 'network unavailable') { requests[index].fail({ errMsg: message }); },
    timeout() {
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 45000);
      timers.delete(id);
      timer.callback();
    }
  };
}

test('only explicit server-authorized saved records with a captured account are queued', async () => {
  const h = harness();
  for (const value of [null, {}, { ...saved(), autoSyncBijing: false }, { ...saved(), autoSyncBijing: 'true' },
    { ...saved(), recordId: '' }, { ...saved(), date: '2026-02-30' }]) {
    assert.equal(await h.confirm(value), null);
  }
  for (const account of ['', null, 12, {}]) {
    assert.equal(await h.api.acceptSavedRecord(saved(), { account }), null);
  }
  assert.equal(await h.api.acceptSavedRecord(saved()), null);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(plain(h.api.getTasks()), []);
  assert.equal(h.writes.length, 0);
});

test('only explicit server-authorized deletions with a receipt and captured account are queued', async () => {
  const h = harness();
  for (const value of [null, {}, { ...deleted(), autoSyncBijing: false }, { ...deleted(), autoSyncBijing: 'true' },
    { ...deleted(), recordId: '' }, { ...deleted(), date: '2026-02-30' },
    ...['', 'record-1', `md_${'x'.repeat(64)}`, `md_${'a'.repeat(63)}`, ` md_${'a'.repeat(64)}`, null]
      .map(deletionId => ({ ...deleted(), deletionId }))]) {
    assert.equal(await h.confirmDeleted(value), null);
  }
  for (const account of ['', null, 12, {}]) {
    assert.equal(await h.api.acceptDeletedRecord(deleted(), { account }), null);
  }
  assert.equal(await h.api.acceptDeletedRecord(deleted()), null);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(plain(h.api.getTasks()), []);
  assert.equal(h.writes.length, 0);
});

test('deleting the last record syncs zero by receipt and deduplicates repeated confirmations', async () => {
  const h = harness();
  const first = h.confirmDeleted(), second = h.confirmDeleted();
  assert.equal(h.requests.length, 0);
  assert.match(h.api.getDayState(DATE).message, /当天记录已更新/);
  await flush();
  const third = h.confirmDeleted();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.requests[0].data), {
    type: 'syncDeletedDate', deletionId: deleted().deletionId, expectedOpenid: OWNER
  });
  assert.doesNotMatch(h.api.getDayState(DATE).message, /记录已保存/);
  h.synced(0, DATE, 0);
  await Promise.all([first, second, third]);
  const last = await h.confirmDeleted();
  assert.equal(last.status, 'synced');
  assert.equal(last.revision, 1);
  assert.equal(last.completedRevision, 1);
  assert.deepEqual(plain(last.recordIds), []);
  assert.deepEqual(plain(last.deletionIds), [deleted().deletionId]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.every(write => write.key === `bijing_record_sync_${OWNER}`), true);
});

test('a deletion during save sync forces another sync and later saves keep the day receipt', async () => {
  const h = harness();
  const first = h.confirm();
  await flush();
  const second = h.confirmDeleted();
  assert.doesNotMatch(h.api.getDayState(DATE).message, /记录已保存/);
  h.synced(0, DATE, 30);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].data.type, 'syncDeletedDate');
  assert.equal(h.api.getDayState(DATE).completedRevision, 1);
  const third = h.confirm(saved('record-2'));
  h.synced(1, DATE, 0);
  await flush();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].data.type, 'syncDeletedDate');
  assert.equal(h.requests[2].data.deletionId, deleted().deletionId);
  h.synced(2, DATE, 50);
  await Promise.all([first, second, third]);
  const task = h.api.getDayState(DATE);
  assert.equal(task.completedRevision, 3);
  assert.equal(task.revision, 3);
  assert.deepEqual(plain(task.recordIds), ['record-1', 'record-2']);
  assert.deepEqual(plain(task.deletionIds), [deleted().deletionId]);
});

test('delayed save acknowledgements cannot replace a deletion receipt with a removed record', async () => {
  const h = harness();
  const removal = h.confirmDeleted();
  await flush();
  h.synced(0, DATE, 0);
  await removal;
  const delayedSave = h.confirm();
  await flush();
  assert.equal(h.requests[1].data.type, 'syncDeletedDate');
  h.synced(1, DATE, 0);
  await delayedSave;
  await h.confirm();
  await h.confirmDeleted();
  assert.equal(h.requests.length, 2);
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
});

test('distinct deletion receipts advance the date revision and sync the latest remaining total', async () => {
  const h = harness();
  const first = h.confirmDeleted();
  await flush();
  const next = deleted('record-2', `md_${'b'.repeat(64)}`);
  const second = h.confirmDeleted(next);
  h.fail(0);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].data.deletionId, next.deletionId);
  h.synced(1, DATE, 20);
  await Promise.all([first, second]);
  const task = h.api.getDayState(DATE);
  assert.equal(task.status, 'synced');
  assert.equal(task.completedRevision, 2);
  assert.deepEqual(plain(task.deletionIds), [deleted().deletionId, next.deletionId]);
});

for (const [response, status] of [
  [{ success: false, error: '必经服务暂不可用' }, 'failed'],
  [{ success: true, data: { date: DATE, skipped: true, reason: '未绑定' } }, 'unbound'],
  [{ success: true, data: { date: DATE, skipped: true, deferred: true, reason: '该日尚未结束' } }, 'deferred']
]) {
  test(`deletion ${status} can retry only external synchronization without recreating the record`, async () => {
    const h = harness();
    const operation = h.confirmDeleted();
    await flush();
    h.result(0, response);
    const task = await operation;
    assert.equal(task.status, status);
    assert.equal(task.canRetry, true);
    assert.match(task.message, /当天记录已更新/);
    assert.doesNotMatch(task.message, /记录已保存/);
    await h.confirmDeleted();
    await h.api.resumePending();
    assert.equal(h.requests.length, 1);
    const retry = h.api.retryDate(DATE);
    await flush();
    assert.deepEqual(plain(h.requests[1].data), plain(h.requests[0].data));
    h.synced(1, DATE, 0);
    assert.equal((await retry).status, 'synced');
    assert.equal(h.api.getDayState(DATE).revision, 1);
    assert.equal(h.writes.every(write => write.key === `bijing_record_sync_${OWNER}`), true);
  });
}

test('a deletion received after account switching stays isolated and resumes with the original owner', async () => {
  const h = harness(), events = [];
  h.api.subscribe(event => events.push(plain(event)));
  const savedOperation = h.confirm();
  await flush();
  h.account('oz-other');
  const beforeDeletion = events.length;
  const removal = h.api.acceptDeletedRecord(deleted(), { account: OWNER });
  h.synced(0);
  await Promise.all([savedOperation, removal]);
  await h.api.resumePending();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.api.getTasks()), []);
  assert.equal(h.api.getDayState(DATE, OWNER).status, 'pending');
  assert.equal(events.length, beforeDeletion);
  assert.equal(await h.api.retryDate(DATE), null);
  h.account(OWNER);
  const resumed = h.api.resumePending();
  await flush();
  assert.equal(h.requests[1].data.type, 'syncDeletedDate');
  h.synced(1, DATE, 0);
  await resumed;
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
});

test('restart retains deletion-only revisions, interrupted work and completed-receipt deduplication', async () => {
  const storage = new Map();
  const original = harness({ storage });
  const pending = original.confirmDeleted();
  await flush();
  const restored = harness({ storage, account: 'oz-other' });
  await restored.api.resumePending();
  assert.equal(restored.requests.length, 0);
  restored.account(OWNER);
  const restoredTask = restored.api.getDayState(DATE);
  assert.equal(restoredTask.status, 'pending');
  assert.equal(restoredTask.revision, 1);
  assert.deepEqual(plain(restoredTask.recordIds), []);
  assert.deepEqual(plain(restoredTask.deletionIds), [deleted().deletionId]);
  const resumed = restored.api.resumePending();
  await flush();
  assert.equal(restored.requests[0].data.type, 'syncDeletedDate');
  restored.synced(0, DATE, 0);
  await resumed;
  const completed = harness({ storage });
  await completed.confirmDeleted();
  await completed.api.resumePending();
  assert.equal(completed.requests.length, 0);
  assert.equal(completed.api.getDayState(DATE).completedRevision, 1);
  original.fail();
  await pending;
});

test('legacy saved-only queue entries retain their exact syncRecordedDate request', async () => {
  const storage = new Map([[`bijing_record_sync_${OWNER}`, { version: 1, tasks: {
    [DATE]: { date: DATE, recordId: 'legacy-record', recordIds: ['legacy-record'],
      revision: 1, completedRevision: 0, status: 'pending' }
  } }]]);
  const h = harness({ storage });
  const operation = h.api.resumePending();
  await flush();
  assert.deepEqual(plain(h.requests[0].data), {
    type: 'syncRecordedDate', recordId: 'legacy-record', expectedOpenid: OWNER
  });
  assert.deepEqual(plain(h.api.getDayState(DATE).deletionIds), []);
  h.synced();
  await operation;
  const removal = h.confirmDeleted(deleted('legacy-record'));
  await flush();
  assert.equal(h.requests[1].data.type, 'syncDeletedDate');
  h.synced(1, DATE, 0);
  await removal;
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
});

test('confirmation queues a separate nonblocking 45-second sync and exposes a saved-record status', async () => {
  const h = harness();
  const operation = h.confirm();
  assert.equal(h.requests.length, 0, 'no network call is made on the acknowledgement stack');
  assert.equal(h.api.getDayState(DATE).status, 'pending');
  await flush();
  assert.equal(h.requests.length, 1);
  const task = h.api.getDayState(DATE);
  assert.equal(task.status, 'syncing');
  assert.equal(task.canRetry, false);
  assert.match(task.message, /记录已保存/);
  assert.equal([...h.timers.values()][0].delay, 45000);
  h.synced();
  const complete = await operation;
  assert.equal(complete.status, 'synced');
  assert.equal(complete.completedRevision, 1);
  assert.equal(complete.canRetry, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.writes.every(write => write.key === `bijing_record_sync_${OWNER}`), true,
    'external sync never writes the meditation upload cache');
});

test('repeated acknowledgements before, during and after success reuse one record and request', async () => {
  const h = harness();
  const first = h.confirm(), second = h.confirm();
  await flush();
  const third = h.confirm();
  assert.equal(h.requests.length, 1);
  h.synced();
  await Promise.all([first, second, third]);
  const last = await h.confirm();
  assert.equal(last.revision, 1);
  assert.deepEqual(plain(last.recordIds), ['record-1']);
  assert.equal(last.status, 'synced');
  assert.equal(h.requests.length, 1);
});

test('same-day records received before dispatch use the latest record and one combined version', async () => {
  const h = harness();
  const first = h.confirm(saved('record-1')), second = h.confirm(saved('record-2'));
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].data.recordId, 'record-2');
  h.synced();
  await Promise.all([first, second]);
  const task = h.api.getDayState(DATE);
  assert.equal(task.revision, 2);
  assert.equal(task.completedRevision, 2);
  assert.equal(task.recordId, 'record-2');
  assert.deepEqual(plain(task.recordIds), ['record-1', 'record-2']);
});

test('a new same-day record during the request forces a subsequent sync with its stable id', async () => {
  const h = harness();
  const first = h.confirm();
  await flush();
  const second = h.confirm(saved('record-2'));
  assert.equal(h.requests.length, 1);
  h.synced(0, DATE, 30);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].data.recordId, 'record-2');
  assert.equal(h.api.getDayState(DATE).completedRevision, 1);
  assert.equal(h.api.getDayState(DATE).status, 'syncing');
  h.synced(1, DATE, 60);
  await Promise.all([first, second]);
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
  assert.equal(h.api.getDayState(DATE).status, 'synced');
});

test('a failed request still processes a newer same-day confirmation once', async () => {
  const h = harness();
  const first = h.confirm();
  await flush();
  const second = h.confirm(saved('record-2'));
  h.fail();
  await flush();
  assert.equal(h.requests.length, 2);
  h.synced(1, DATE, 60);
  await Promise.all([first, second]);
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
});

test('a confirmation in the final observer callback is never lost to task completion', async () => {
  const h = harness();
  let followup;
  const stop = h.api.subscribe(() => {
    const state = h.api.getDayState(DATE);
    if (state.status === 'synced' && state.revision === 1) followup = h.confirm(saved('record-2'));
  });
  const first = h.confirm();
  await flush();
  h.synced();
  await flush();
  assert.equal(h.requests.length, 2);
  h.synced(1, DATE, 60);
  await Promise.all([first, followup]);
  stop();
  assert.equal(h.api.getDayState(DATE).completedRevision, 2);
});

test('failure is separate from cloud recording and retries use only the confirmed record id', async () => {
  const h = harness();
  const pending = h.confirm();
  await flush();
  h.result(0, { success: false, code: 'SYNC_FAILED', error: '必经服务暂不可用' });
  const failed = await pending;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.canRetry, true);
  assert.match(failed.message, /记录已保存.*必经服务暂不可用/);
  await h.confirm();
  await h.api.resumePending();
  assert.equal(h.requests.length, 1, 'duplicate acknowledgement and foreground do not loop failed requests');
  const retry = h.api.retryDate(DATE), duplicateRetry = h.api.retryDate(DATE);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].data.recordId, 'record-1');
  h.synced();
  await Promise.all([retry, duplicateRetry]);
  assert.equal(h.api.getDayState(DATE).revision, 1);
  assert.equal(h.api.getDayState(DATE).status, 'synced');
  assert.equal(await h.api.retryDate('2026-10-02'), null);
});

for (const [data, status] of [
  [{ skipped: true, reason: '未绑定' }, 'unbound'],
  [{ skipped: true, deferred: true, reason: '该日尚未结束，将在次日同步' }, 'deferred']
]) {
  test(`${status} remains visible without an automatic retry loop and can be explicitly retried`, async () => {
    const h = harness();
    const pending = h.confirm();
    await flush();
    h.result(0, { success: true, data: { date: DATE, ...data } });
    const task = await pending;
    assert.equal(task.status, status);
    assert.equal(task.canRetry, true);
    assert.equal(task.completedRevision, 0);
    await h.api.resumePending();
    await h.confirm();
    assert.equal(h.requests.length, 1);
    const retry = h.api.retryDate(DATE);
    await flush();
    h.synced();
    assert.equal((await retry).status, 'synced');
  });
}

test('a malformed or wrong-date external response cannot claim success', async () => {
  for (const result of [null, { success: true }, { success: true, data: { date: '2026-10-02', success: true, duration: 30 } },
    { success: true, data: { date: DATE, success: true, duration: '30' } },
    { success: true, data: { skipped: true, reason: 'unknown' } }]) {
    const h = harness();
    const pending = h.confirm();
    await flush();
    h.result(0, result);
    assert.equal((await pending).status, 'failed');
  }
});

test('timeout releases the request and late success cannot overwrite the retry result', async () => {
  const h = harness();
  const pending = h.confirm();
  await flush();
  h.timeout();
  assert.equal((await pending).status, 'failed');
  assert.equal(h.timers.size, 0);
  const retry = h.api.retryDate(DATE);
  await flush();
  h.synced(0);
  await flush();
  assert.equal(h.api.getDayState(DATE).status, 'syncing');
  h.synced(1);
  assert.equal((await retry).status, 'synced');
  assert.equal(h.timers.size, 0);
});

test('success beyond the deadline is still a timeout if its timer callback has not run', async () => {
  const h = harness();
  const pending = h.confirm();
  await flush();
  h.now(Date.parse('2026-10-05T04:00:45Z'));
  h.synced();
  assert.equal((await pending).status, 'failed');
  assert.equal(h.timers.size, 0);
});

test('account switching preserves the old result but prevents old followups or new-account notifications', async () => {
  const h = harness(), events = [];
  h.api.subscribe(event => events.push(plain(event)));
  const first = h.confirm();
  await flush();
  const second = h.confirm(saved('record-2'));
  const beforeSwitch = events.length;
  h.account('oz-other');
  const lateConfirmation = h.api.acceptSavedRecord(saved('record-3'), { account: OWNER });
  h.synced(0);
  await Promise.all([first, second, lateConfirmation]);
  assert.equal(events.length, beforeSwitch);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.api.getTasks()), []);
  assert.equal(h.api.getDayState(DATE, OWNER).status, 'pending');
  assert.equal(h.api.getDayState(DATE, OWNER).completedRevision, 1);
  assert.equal(await h.api.retryDate(DATE), null);
  await h.api.resumePending();
  assert.equal(h.requests.length, 1);
  h.account(OWNER);
  const resumed = h.api.resumePending();
  await flush();
  assert.equal(h.requests[1].data.recordId, 'record-3');
  h.synced(1, DATE, 90);
  await resumed;
  assert.equal(h.api.getDayState(DATE).status, 'synced');
  assert.equal(h.api.getDayState(DATE).completedRevision, 3);
  assert.ok(events.slice(beforeSwitch).every(event => event.account === OWNER));
});

test('a save acknowledgement after account switching persists only the original owner intent and resumes after return', async () => {
  for (const otherAccount of ['oz-other', '']) {
    const storage = new Map();
    const h = harness({ storage, account: otherAccount }), events = [];
    h.api.subscribe(event => events.push(plain(event)));
    const late = await h.api.acceptSavedRecord(saved(), { account: OWNER });
    assert.equal(late.status, 'pending');
    assert.equal(late.revision, 1);
    await h.api.acceptSavedRecord(saved(), { account: OWNER });
    await h.api.resumePending();
    assert.equal(h.requests.length, 0);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(events, []);
    assert.deepEqual(plain(h.api.getTasks()), []);
    assert.equal(h.api.getDayState(DATE, OWNER).revision, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].key, `bijing_record_sync_${OWNER}`);
    assert.equal(storage.get(`bijing_record_sync_${OWNER}`).tasks[DATE].status, 'pending');

    const restored = harness({ storage, account: otherAccount });
    await restored.api.resumePending();
    assert.equal(restored.requests.length, 0, 'restart under a different account cannot dispatch the original owner task');
    restored.account(OWNER);
    const resumed = restored.api.resumePending();
    await flush();
    assert.equal(restored.requests.length, 1);
    assert.equal(restored.requests[0].data.expectedOpenid, OWNER);
    assert.equal(restored.requests[0].data.recordId, 'record-1');
    restored.synced();
    await resumed;
    assert.equal(restored.api.getDayState(DATE).status, 'synced');
    assert.equal(restored.api.getDayState(DATE).completedRevision, 1);
  }
});

test('switching accounts before background dispatch leaves a resumable task without sending under the wrong owner', async () => {
  const h = harness();
  const pending = h.confirm();
  h.account('oz-other');
  await pending;
  assert.equal(h.requests.length, 0);
  assert.equal(h.api.getDayState(DATE, OWNER).status, 'pending');
  h.account(OWNER);
  const resumed = h.api.resumePending();
  await flush();
  h.synced();
  await resumed;
});

test('restarting restores interrupted syncing and queued tasks but not failed or unbound tasks', async () => {
  const storage = new Map();
  const original = harness({ storage });
  const pending = original.confirm();
  await flush();
  const snapshot = storage.get(`bijing_record_sync_${OWNER}`);
  const initial = snapshot.tasks[DATE];
  for (const [date, status] of [['2026-10-02', 'queued'], ['2026-10-01', 'failed'], ['2026-09-30', 'unbound'], ['2026-09-29', 'deferred']]) {
    snapshot.tasks[date] = { ...initial, date, recordId: date, recordIds: [date], status };
  }
  storage.set(`bijing_record_sync_${OWNER}`, snapshot);
  const restored = harness({ storage });
  assert.equal(restored.api.getDayState(DATE).status, 'pending');
  const resumed = restored.api.resumePending();
  await flush();
  assert.equal(restored.requests.length, 1);
  restored.synced(0);
  await flush();
  assert.equal(restored.requests.length, 2);
  restored.synced(1, '2026-10-02');
  await resumed;
  assert.deepEqual(plain(restored.api.getTasks().map(task => task.status)), ['synced', 'synced', 'failed', 'unbound', 'deferred']);
  assert.deepEqual(plain(restored.api.getTasks().map(task => task.date)), [DATE, '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29']);
  original.fail();
  await pending;
});

test('storage failure and synchronous cloud errors cannot throw into the record acknowledgement', async () => {
  const h = harness({ storageFails: true });
  let pending;
  assert.doesNotThrow(() => { pending = h.confirm(); });
  await flush();
  h.synced();
  assert.equal((await pending).status, 'synced');
  assert.equal(h.api.getDayState(DATE).status, 'synced');
  const broken = harness({ callThrows: true });
  assert.equal((await broken.confirm()).status, 'failed');
  assert.equal(broken.timers.size, 0);
});

test('subscriber removal does not cancel work and snapshots cannot mutate internal tasks', async () => {
  const h = harness(), events = [];
  h.api.subscribe(() => { throw new Error('destroyed page'); });
  const stop = h.api.subscribe(event => events.push(plain(event)));
  const pending = h.confirm();
  await flush();
  const count = events.length;
  stop();
  const snapshot = h.api.getDayState(DATE);
  snapshot.recordIds.push('tampered');
  snapshot.recordId = 'tampered';
  h.synced();
  await pending;
  assert.equal(events.length, count);
  assert.equal(h.api.getDayState(DATE).recordId, 'record-1');
  assert.deepEqual(plain(h.api.getDayState(DATE).recordIds), ['record-1']);
});
