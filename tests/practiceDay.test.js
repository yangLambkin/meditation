const test = require('node:test');
const assert = require('node:assert/strict');
const { getPracticeDate, getRecordDisplayDate } = require('../miniprogram/utils/practiceDay.js');

test('practice day changes at Beijing 02:00 across month, year and leap-day boundaries', () => {
  for (const [timestamp, expected] of [
    ['2026-11-04T01:59:59+08:00', '2026-11-03'],
    ['2026-11-04T02:00:00+08:00', '2026-11-04'],
    ['2026-11-01T01:59:59+08:00', '2026-10-31'],
    ['2027-01-01T01:59:59+08:00', '2026-12-31'],
    ['2028-03-01T01:59:59+08:00', '2028-02-29'],
    ['2027-03-01T01:59:59+08:00', '2027-02-28'],
    ['2026-11-03T18:00:00Z', '2026-11-04']
  ]) assert.equal(getPracticeDate(Date.parse(timestamp)), expected, timestamp);
});

test('display dates use the true occurrence time once and leave date-only history on its saved date', () => {
  for (const [record, expected] of [
    [{ recordDate: '2026-11-04', occurredAt: '2026-11-04 01:59:59' }, '2026-11-03'],
    [{ recordDate: '2026-11-04', occurredAt: '2026-11-04 02:00:00' }, '2026-11-04'],
    [{ recordDate: '2026-11-04', occurredAt: '2026-11-04T01:59:59' }, '2026-11-03'],
    [{ recordDate: '2026-11-04', occurredAt: null }, '2026-11-04'],
    [{ recordDate: '2026-11-04' }, '2026-11-04'],
    [{ recordDate: '2026-11-04', occurredAt: 'invalid' }, '2026-11-04'],
    [{ recordDate: '2026-11-04', occurredAt: '2026-11-04 01:59:59', displayDate: '2026-11-03' }, '2026-11-03']
  ]) {
    const original = structuredClone(record);
    assert.equal(getRecordDisplayDate(record), expected);
    assert.deepEqual(record, original);
  }
});
