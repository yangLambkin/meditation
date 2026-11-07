const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil.js');

const timestamp = Date.parse('2026-11-07T01:20:37.123+08:00');
const source = { type: 'sitting', id: 99, source: 'meditation', sourceRecordId: 'cloud-1',
  canEdit: false, canDelete: false };
const original = { _id: 'cloud-1', _openid: 'owner-1', localId: 'local-1', timestamp,
  duration: 20, experience: [{ text: '原感悟' }] };
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ dailyRecords = {}, refresh = async () => true } = {}) {
  const state = { account: 'owner-1', userId: 'local-user-1', dailyRecords, refreshCount: 0 };
  const module = { exports: {} };
  const manager = {
    getUserId: () => state.userId,
    getUserCheckinData: () => ({ dailyRecords: state.dailyRecords }),
    async refreshFromCloud() { state.refreshCount++; return refresh(state); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/practiceSitting.js'), 'utf8'), {
    module,
    require(name) {
      if (name === './checkin.js') return manager;
      if (name === './dateUtil.js') return dateUtil;
      throw new Error(name);
    },
    wx: { getStorageSync: key => key === 'userOpenId' ? state.account : undefined }
  });
  return { helper: module.exports, state };
}

test('source identities use dedicated meditation fields and never the practice record ID', () => {
  const { helper } = harness();
  for (const value of [source, { sourceRecordId: 'cloud-1' },
    { source: { system: 'meditation', sourceRecordId: 'cloud-1' } },
    { source: { sourceSystem: 'meditation', recordId: 'cloud-1' } }]) {
    assert.equal(helper.sourceId(value), 'cloud-1');
  }
  for (const value of [null, { type: 'sitting', id: 'cloud-1', source: 'meditation' },
    { ...source, source: 'manual' }, { ...source, type: 'walking' },
    { ...source, sourceRecordId: 99 }, { ...source, sourceRecordId: '../cloud-1' },
    { ...source, sourceRecordId: ' cloud-1' }, { ...source, sourceRecordId: 'a'.repeat(129) },
    { ...source, source: { system: 'manual' } },
    { ...source, source: { system: 'meditation', recordId: 'cloud-2' } },
    { source: { recordId: 'cloud-1' } }]) {
    assert.equal(helper.sourceId(value), '', JSON.stringify(value));
  }
});

test('cached resolution preserves raw content and stored bucket, while calculating the original business day', async () => {
  const raw = { ...original, date: '2026-11-07' };
  const { helper, state } = harness({ dailyRecords: { '2026-11-05': { records: [raw] } } });
  const found = await helper.resolve(source);
  assert.equal(found.date, '2026-11-05');
  assert.equal(found.dayDate, '2026-11-06');
  assert.equal(found.timestamp, timestamp);
  assert.deepEqual(plain(found.experience), original.experience);
  assert.equal(found.isBackfill, false);
  assert.deepEqual(plain(helper.identity(found)), {
    recordId: original._id, localId: original.localId, timestamp
  });
  assert.equal(state.refreshCount, 0);
  assert.equal(raw.date, '2026-11-07');
});

test('manual business dates and backfill restrictions remain attached to the original record', async () => {
  for (const marker of [{ recordType: 'backfill' }, { backfillRequestId: 'backfill-1' }]) {
    const raw = { ...original, ...marker, source: 'manual', date: '2026-11-04' };
    const { helper } = harness({ dailyRecords: { '2026-11-05': { records: [raw] } } });
    const found = await helper.resolve(source);
    assert.equal(found.date, '2026-11-05');
    assert.equal(found.dayDate, '2026-11-04');
    assert.equal(found.isBackfill, true);
  }
});

test('a missing cached source is recovered by its exact cloud ID across all stored dates', async () => {
  const { helper, state } = harness({
    dailyRecords: { '2026-11-07': { records: [{ ...original, _id: '99' }] } },
    refresh: async state => {
      state.dailyRecords = { '2026-11-06': { records: [original] } };
      return true;
    }
  });
  const found = await helper.resolve(source);
  assert.equal(found._id, 'cloud-1');
  assert.equal(found.date, '2026-11-06');
  assert.equal(state.refreshCount, 1);
});

test('missing or unreadable sources never fall back to practice IDs, timestamps, or durations', async () => {
  for (const refreshed of [true, false]) {
    const { helper, state } = harness({
      dailyRecords: { '2026-11-07': { records: [{ ...original, _id: '99' }] } },
      refresh: async () => refreshed
    });
    await assert.rejects(helper.resolve(source), {
      code: refreshed ? 'SOURCE_NOT_FOUND' : 'SOURCE_READ_UNAVAILABLE'
    });
    assert.equal(state.refreshCount, 1);
  }
  const { helper, state } = harness();
  await assert.rejects(helper.resolve({ type: 'sitting', id: 'cloud-1' }), { code: 'SOURCE_ID_UNAVAILABLE' });
  assert.equal(state.refreshCount, 0);
});

test('duplicate source IDs are rejected without selecting an arbitrary record', async () => {
  const { helper, state } = harness({ dailyRecords: {
    '2026-11-05': { records: [original] }, '2026-11-06': { records: [{ ...original }] }
  } });
  await assert.rejects(helper.resolve(source), { code: 'SOURCE_AMBIGUOUS' });
  assert.equal(state.refreshCount, 0);
});

test('source ownership is checked for both cloud ownership and pending upload ownership', async () => {
  for (const ownership of [{ _openid: 'owner-2' }, { syncOpenid: 'owner-2' }]) {
    const { helper, state } = harness({ dailyRecords: {
      '2026-11-06': { records: [{ ...original, ...ownership }] }
    } });
    await assert.rejects(helper.resolve(source), { code: 'SOURCE_OWNER_MISMATCH' });
    assert.equal(state.refreshCount, 0);
  }
});

test('account changes, local user changes, and stale actions abort source recovery', async () => {
  for (const key of ['account', 'userId']) {
    const { helper } = harness({ refresh: async state => {
      state[key] = 'changed';
      state.dailyRecords = { '2026-11-06': { records: [original] } };
      return true;
    } });
    await assert.rejects(helper.resolve(source), { code: 'ACCOUNT_CHANGED' });
  }
  let current = true;
  const { helper } = harness({ refresh: async state => {
    current = false;
    state.dailyRecords = { '2026-11-06': { records: [original] } };
    return true;
  } });
  await assert.rejects(helper.resolve(source, () => current), { code: 'ACTION_STALE' });
});

test('logged out and already stale actions cannot read or refresh an original record', async () => {
  const { helper, state } = harness();
  await assert.rejects(helper.resolve(source, () => false), { code: 'ACTION_STALE' });
  state.account = '';
  await assert.rejects(helper.resolve(source), { code: 'AUTH_REQUIRED' });
  assert.equal(state.refreshCount, 0);
});
