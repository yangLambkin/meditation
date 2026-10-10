const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { COVERAGE_ID, COVERAGE_FROM_DATE, getCoverageStatus } = require('../shared/syncCoverage');

function read(state, time, error) {
  return getCoverageStatus({ now: () => Date.parse(time), db: { collection(name) {
    assert.equal(name, 'bijing_sync_days');
    return { doc(id) {
      assert.equal(id, COVERAGE_ID);
      return { async get() { if (error) throw error; return { data: state }; } };
    } };
  } } });
}

test('coverage alert survives a wholly absent scheduler without a run or error row', async () => {
  const before = await read(null, '2026-09-23T10:59:59.999+08:00');
  assert.equal(before.hasOverdue, false);
  const due = await read(null, '2026-09-23T11:00:00+08:00');
  assert.equal(due.hasOverdue, true);
  assert.equal(due.nextDate, '2026-09-22');
  assert.equal(due.dueAt, Date.parse('2026-09-23T11:00:00+08:00'));
  assert.equal(due.initialized, false);
  const later = await read(null, '2027-01-03T01:00:00+08:00');
  assert.equal(later.nextDate, '2026-09-22');
  assert.equal(later.hasOverdue, true);
  assert.equal(later.overdueThrough, '2027-01-01');
});

test('coverage boundary follows Beijing 11:00 and a recovered prefix clears its alert', async () => {
  const state = { fromDate: COVERAGE_FROM_DATE, nextDate: '2026-10-09' };
  assert.equal((await read(state, '2026-10-10T10:59:59.999+08:00')).hasOverdue, false);
  assert.equal((await read(state, '2026-10-10T11:00:00+08:00')).hasOverdue, true);
  state.nextDate = '2026-10-10';
  const recovered = await read(state, '2026-10-10T11:00:00+08:00');
  assert.equal(recovered.hasOverdue, false);
  assert.equal(recovered.scannedThrough, '2026-10-09');
  assert.equal((await read(state, '2026-10-11T01:59:59+08:00')).hasOverdue, false);
  assert.equal((await read(state, '2026-10-11T11:00:00+08:00')).hasOverdue, true);
});

test('missing collection is overdue work, while permission, network and corrupt progress never look healthy', async () => {
  const time = '2026-10-10T12:00:00+08:00';
  assert.equal((await read(null, time, { code: 'DATABASE_COLLECTION_NOT_EXIST' })).hasOverdue, true);
  for (const error of [new Error('network failure'), { errCode: -502001, message: 'permission denied' }]) {
    await assert.rejects(read(null, time, error));
  }
  for (const state of [
    { fromDate: COVERAGE_FROM_DATE, nextDate: '2099-01-01' },
    { fromDate: COVERAGE_FROM_DATE, nextDate: '2026-02-30' },
    { fromDate: '2026-10-10', nextDate: '2026-10-10' },
  ]) await assert.rejects(read(state, time), /进度异常/);
});

test('both separately deployed cloud functions share the same coverage deadline contract', () => {
  const canonical = fs.readFileSync(require.resolve('../shared/syncCoverage'), 'utf8');
  for (const name of ['adminManager', 'bijingSync']) {
    assert.equal(fs.readFileSync(require.resolve(`../cloudfunctions/${name}/syncCoverage`), 'utf8'), canonical);
  }
});
