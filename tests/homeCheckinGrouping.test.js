const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  getDateTime, parseDateTime, getCheckinDay, buildCheckinRecords, buildCheckinGroups, buildCheckinMonths,
  isValidDateKey, shiftCheckinDate, shiftCheckinMonth
} = require('../miniprogram/utils/homeCheckin.js');

function recordsFor(timestamps) {
  return buildCheckinRecords({ dailyRecords: {
    '2026-01-01': { records: timestamps.map((timestamp, index) => ({
      _id: `record-${index}`, timestamp, duration: index + 1
    })) }
  } });
}

test('check-in days turn over at Beijing 02:00, including month, year and leap-day boundaries', () => {
  for (const [timestamp, expected] of [
    ['2026-09-19T01:59:59.999+08:00', '2026-09-18'],
    ['2026-09-19T02:00:00+08:00', '2026-09-19'],
    ['2026-10-01T01:59:00+08:00', '2026-09-30'],
    ['2026-01-01T01:59:00+08:00', '2025-12-31'],
    ['2026-01-01T02:00:00+08:00', '2026-01-01'],
    ['2024-03-01T01:59:00+08:00', '2024-02-29']
  ]) {
    assert.equal(getCheckinDay(timestamp), expected, timestamp);
    assert.equal(getCheckinDay(Date.parse(timestamp)), expected, timestamp);
    assert.equal(getCheckinDay(String(Date.parse(timestamp))), expected, timestamp);
  }
});

test('day grouping is independent of the host timezone', () => {
  const modulePath = path.join(__dirname, '../miniprogram/utils/homeCheckin.js');
  const script = `
    const { getCheckinDay, buildCheckinRecords } = require(${JSON.stringify(modulePath)});
    const times = ['2026-09-18T17:59:59.999Z', '2026-09-18T18:00:00Z'];
    process.stdout.write(JSON.stringify({
      days: times.map(getCheckinDay),
      records: buildCheckinRecords({ dailyRecords: {
        '2026-09-19': { records: times.map(timestamp => ({ timestamp })) }
      } }).map(({ dayDate, timeLabel }) => ({ dayDate, timeLabel }))
    }));
  `;
  for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: timezone }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      days: ['2026-09-18', '2026-09-19'],
      records: [
        { dayDate: '2026-09-19', timeLabel: '02:00' },
        { dayDate: '2026-09-18', timeLabel: '次日 01:59' }
      ]
    }, timezone);
  }
});

test('forms retain actual calendar dates and times before the check-in day boundary', () => {
  const timestamp = Date.parse('2026-01-01T01:59:00+08:00');
  assert.deepEqual(getDateTime(timestamp), { date: '2026-01-01', time: '01:59' });
  assert.equal(parseDateTime('2025-12-31', '01:59'), timestamp);
  assert.equal(getCheckinDay(timestamp), '2025-12-31');
  assert.ok(Number.isNaN(parseDateTime('2026-02-30', '01:59')));
});

test('records use timestamps for grouping while retaining stored dates and record identities', () => {
  const timestamp = Date.parse('2026-09-19T01:00:00+08:00');
  const records = buildCheckinRecords({ dailyRecords: {
    '2026-09-19': { records: [
      { _id: 'cloud-id', localId: 'local-id', timestamp, duration: '12', emotion: ['平静'], experience: ['experience-id'] }
    ] }
  } }, [{ _id: 'experience-id', text: '呼吸更自然' }]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: '2026-09-19-cloud-id', _id: 'cloud-id', localId: 'local-id',
    date: '2026-09-19', dayDate: '2026-09-18', time: '01:00', timeLabel: '次日 01:00',
    timestamp, sortTimestamp: timestamp, duration: 12, emotion: ['平静'],
    experienceTexts: ['呼吸更自然'], order: 0
  });
});

test('mixed timestamp formats sort by logical day and instant regardless of stored buckets', () => {
  const numeric = Date.parse('2026-09-18T23:00:00+08:00');
  const numericString = String(Date.parse('2026-09-19T01:30:00+08:00'));
  const records = buildCheckinRecords({ dailyRecords: {
    '2026-09-20': { records: [{ _id: 'late-evening', timestamp: numeric }] },
    '2026-09-19': { records: [{ _id: 'early-morning', timestamp: numericString }] },
    '2026-09-17': { records: [{ _id: 'new-day', timestamp: '2026-09-19T02:00:00+08:00' }] }
  } });
  assert.deepEqual(records.map(record => record._id), ['new-day', 'early-morning', 'late-evening']);
  assert.deepEqual(records.map(record => record.dayDate), ['2026-09-19', '2026-09-18', '2026-09-18']);
  assert.deepEqual(records.map(record => record.timeLabel), ['02:00', '次日 01:30', '23:00']);
  assert.equal(records[1].timestamp, numericString);
  const shuffled = [records[2], records[0], records[1]];
  const { groups } = buildCheckinGroups(shuffled, { now: '2026-09-19T08:00:00+08:00' });
  assert.deepEqual(groups.map(group => group.date), ['2026-09-19', '2026-09-18']);
  assert.deepEqual(groups[1].records.map(record => record._id), ['early-morning', 'late-evening']);
  assert.deepEqual(shuffled.map(record => record._id), ['late-evening', 'new-day', 'early-morning']);
});

test('legacy records without usable timestamps keep their stored date and unknown-time label', () => {
  const timestamps = [undefined, null, '', 'invalid', 0];
  const records = buildCheckinRecords({ dailyRecords: {
    '2026-09-17': { records: timestamps.map((timestamp, index) => ({ localId: `legacy-${index}`, timestamp })) }
  } });
  assert.equal(records.length, timestamps.length);
  records.forEach(record => {
    assert.equal(record.date, '2026-09-17');
    assert.equal(record.dayDate, '2026-09-17');
    assert.equal(record.time, '时间未记录');
    assert.equal(record.timeLabel, '时间未记录');
    assert.equal(record.sortTimestamp, 0);
  });
  assert.deepEqual(records.map(record => record.localId), ['legacy-4', 'legacy-3', 'legacy-2', 'legacy-1', 'legacy-0']);
});

test('default groups contain the current logical day and preceding two consecutive days', () => {
  const records = recordsFor([
    '2025-12-28T12:00:00+08:00',
    '2025-12-29T12:00:00+08:00',
    '2025-12-30T12:00:00+08:00',
    '2025-12-31T23:00:00+08:00',
    '2026-01-01T01:59:00+08:00',
    '2026-01-01T02:00:00+08:00'
  ]);
  const beforeBoundary = buildCheckinGroups(records, { now: '2026-01-01T01:59:59+08:00' });
  assert.deepEqual(beforeBoundary.groups.map(({ date, count, totalDuration }) => ({ date, count, totalDuration })), [
    { date: '2025-12-31', count: 2, totalDuration: 9 },
    { date: '2025-12-30', count: 1, totalDuration: 3 },
    { date: '2025-12-29', count: 1, totalDuration: 2 }
  ]);
  assert.equal(beforeBoundary.hiddenCount, 2);
  const afterBoundary = buildCheckinGroups(records, { now: '2026-01-01T02:00:00+08:00' });
  assert.deepEqual(afterBoundary.groups.map(group => group.date), ['2026-01-01', '2025-12-31', '2025-12-30']);
  assert.equal(afterBoundary.hiddenCount, 2);
});

test('missing recent dates do not pull older groups into the default view, and all reveals every record', () => {
  const records = recordsFor([
    '2026-09-10T12:00:00+08:00',
    '2026-09-15T12:00:00+08:00',
    '2026-09-19T01:59:00+08:00'
  ]);
  const now = '2026-09-19T12:00:00+08:00';
  const recent = buildCheckinGroups(records, { now });
  assert.deepEqual(recent.groups.map(group => group.date), ['2026-09-18']);
  assert.equal(recent.hiddenCount, 2);
  const all = buildCheckinGroups(records, { now, showAll: true });
  assert.deepEqual(all.groups.map(group => group.date), ['2026-09-18', '2026-09-15', '2026-09-10']);
  assert.equal(all.hiddenCount, 0);
  assert.equal(all.groups.flatMap(group => group.records).length, records.length);
  assert.deepEqual(buildCheckinGroups([], { now }), { groups: [], hiddenCount: 0 });
});

test('complete history groups by the month of each 02:00 day, newest months and days first', () => {
  const records = recordsFor([
    '2025-12-31T22:00:00+08:00',
    '2026-01-01T01:59:59+08:00',
    '2026-01-01T02:00:00+08:00',
    '2026-02-01T01:00:00+08:00',
    '2026-02-01T02:00:00+08:00'
  ]);
  const months = buildCheckinMonths(records.reverse());
  assert.deepEqual(months.map(({ month, label, count, totalDuration }) => ({ month, label, count, totalDuration })), [
    { month: '2026-02', label: '2026年2月', count: 1, totalDuration: 5 },
    { month: '2026-01', label: '2026年1月', count: 2, totalDuration: 7 },
    { month: '2025-12', label: '2025年12月', count: 2, totalDuration: 3 }
  ]);
  assert.deepEqual(months[1].days.map(day => day.date), ['2026-01-31', '2026-01-01']);
  assert.equal(months[1].days[0].records[0].timeLabel, '次日 01:00');
  assert.deepEqual(months[2].days[0].records.map(record => record.duration), [2, 1]);
  assert.equal(months.reduce((count, month) => count + month.count, 0), records.length);
});

test('monthly history supports empty data and legacy records with only a stored date', () => {
  assert.deepEqual(buildCheckinMonths([]), []);
  const months = buildCheckinMonths(buildCheckinRecords({ dailyRecords: {
    '2026-03-15': { records: [{ duration: 12 }] },
    '2025-12-10': { records: [{ duration: 8 }] }
  } }));
  assert.deepEqual(months.map(month => month.month), ['2026-03', '2025-12']);
  assert.equal(months[0].days[0].records[0].timeLabel, '时间未记录');
  assert.equal(months[0].totalDuration, 12);
});

test('date navigation validates real calendar days and crosses leap days and years', () => {
  for (const invalid of ['', null, undefined, '2026-2-01', '2026-02-29', '2026-02-30', '0000-01-01', '2026-13-01']) {
    assert.equal(isValidDateKey(invalid), false);
    assert.equal(shiftCheckinDate(invalid, 1), '');
  }
  assert.equal(isValidDateKey('2024-02-29'), true);
  assert.equal(shiftCheckinDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftCheckinDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftCheckinDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftCheckinDate('2025-12-31', 1), '2026-01-01');
  assert.equal(shiftCheckinDate('2026-09-18', 0), '2026-09-18');
  assert.equal(shiftCheckinDate('2026-09-18', 0.5), '');
  assert.equal(shiftCheckinDate('9999-12-31', 1), '');
  assert.equal(shiftCheckinDate('0001-01-01', -1), '');
});

test('month navigation supports year boundaries and rejects invalid picker values', () => {
  assert.equal(shiftCheckinMonth('2026-01', -1), '2025-12');
  assert.equal(shiftCheckinMonth('2025-12', 1), '2026-01');
  assert.equal(shiftCheckinMonth('2024-02', 1), '2024-03');
  assert.equal(shiftCheckinMonth('2026-09', 0), '2026-09');
  for (const invalid of ['', null, undefined, '2026-2', '2026-13', '2026-09-18']) {
    assert.equal(shiftCheckinMonth(invalid, 1), '');
  }
  assert.equal(shiftCheckinMonth('2026-09', 0.5), '');
  assert.equal(shiftCheckinMonth('9999-12', 1), '');
});

test('explicit manual business dates survive upload-time differences', () => {
  const records = buildCheckinRecords({ dailyRecords: {
    '2026-09-19': { records: [{ localId: 'manual-once', source: 'manual', date: '2026-09-18',
      timestamp: Date.parse('2026-09-19T09:00:00+08:00'), duration: 20 }] }
  } });
  assert.equal(records[0].dayDate, '2026-09-18');
  assert.equal(records[0].date, '2026-09-19', 'deletion retains the original bucket');
});

test('failed cloud backups remain visible without changing local record identity', () => {
  const records = buildCheckinRecords({ dailyRecords: {
    '2026-09-19': { records: [{ localId: 'offline', timestamp: Date.parse('2026-09-19T09:00:00+08:00'),
      duration: 20, syncError: '只能记录最近三天（含今天）的静坐' }] }
  } });
  assert.equal(records[0].syncError, '只能记录最近三天（含今天）的静坐');
  assert.equal(records[0].localId, 'offline');
});

test('the same list distinguishes cloud records, new uploads and legacy unconfirmed records without mutating them', () => {
  const source = [
    { localId: 'legacy-local' },
    { localId: 'pending', syncVersion: 1, syncStatus: 'pending' },
    { localId: 'failed', syncVersion: 1, syncStatus: 'failed', syncError: '网络断开' },
    { localId: 'uploading', syncVersion: 1, syncStatus: 'uploading' },
    { localId: 'saved', _id: 'cloud-id', syncVersion: 1, syncStatus: 'synced' },
    { localId: 'expired', syncVersion: 1, syncStatus: 'failed', syncErrorCode: 'DATE_OUT_OF_RANGE', syncBlocked: true },
    { localId: 'invalid', syncVersion: 1, syncStatus: 'failed', syncErrorCode: 'INVALID_RECORD', syncBlocked: true }
  ];
  const before = JSON.stringify(source);
  const records = buildCheckinRecords({ dailyRecords: { '2026-09-19': { records: source } } });
  const byId = Object.fromEntries(records.map(record => [record.localId, record]));
  assert.equal(byId['legacy-local'].syncStatus, 'unconfirmed');
  assert.equal(byId['legacy-local'].syncStatusText, '本机记录，未确认上传');
  assert.equal(byId.saved.syncStatus, undefined);
  assert.equal(byId.pending.syncStatusText, '已存本机，待上传');
  assert.equal(byId.failed.syncStatusText, '已存本机，待上传');
  assert.equal(byId.failed.syncStatus, 'failed');
  assert.equal(byId.uploading.syncStatusText, '正在上传');
  assert.equal(byId.expired.syncStatus, 'blocked');
  assert.equal(byId.expired.syncStatusText, '已存本机，已超出补录期限，无法上传');
  assert.match(byId.invalid.syncStatusText, /无法上传/);
  assert.equal(JSON.stringify(source), before);
});

test('record formatting only filters explicit ownership when the caller supplies the current account', () => {
  const source = { dailyRecords: { '2026-09-19': { records: [
    { localId: 'a', syncOpenid: 'account-a', syncVersion: 1 },
    { localId: 'b', _id: 'cloud-b', syncOpenid: 'account-b' },
    { localId: 'legacy' }
  ] } } };
  const before = JSON.stringify(source);
  assert.equal(buildCheckinRecords(source).length, 3, 'old callers keep their existing behavior');
  assert.deepEqual(buildCheckinRecords(source, [], { openid: 'account-b' }).map(record => record.localId), ['legacy', 'b']);
  assert.equal(JSON.stringify(source), before);
});
