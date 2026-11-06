const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, deferred, createPage } = require('./helpers/practicePage');

const event = period => ({ currentTarget: { dataset: { period } } });
const summary = {
  recordCount: 4, practiceDays: 2,
  totals: [{ type: 'walking', totalValue: 120, recordCount: 2 }, { type: 'kindness', totalValue: 12, recordCount: 2 }],
  daily: [
    { date: '2026-01-01', recordCount: 1, totals: [{ type: 'walking', totalValue: 30, recordCount: 1 }] },
    { date: '2026-10-30', recordCount: 3, totals: [{ type: 'walking', totalValue: 90, recordCount: 1 }, { type: 'kindness', totalValue: 12, recordCount: 2 }] }
  ],
  allTime: { recordCount: 20, practiceDays: 11, totals: [{ type: 'walking', totalValue: 600, recordCount: 8 }, { type: 'kindness', totalValue: 70, recordCount: 12 }] }
};

test('monthly totals distinguish record count, practice days and each practice quantity', async () => {
  const h = createPage({ summary: () => summary });
  await h.page.refresh();
  assert.equal(h.page.data.periodLabel, '2026年10月');
  assert.equal(h.page.data.periodRecordCount, 4);
  assert.equal(h.page.data.periodPracticeDays, 2);
  assert.equal(h.page.data.periodCards.find(card => card.type === 'walking').value, 120);
  assert.deepEqual(plain(h.page.data.periodCards.find(card => card.type === 'kindness')), {
    type: 'kindness', name: '日行一善', unit: '件', value: 12, records: 2
  });
});

test('annual statistics request one bounded full-year range and show every month', async () => {
  const h = createPage({ summary: () => summary });
  await h.page.changeStatsPeriod(event('year'));
  assert.deepEqual(h.calls.summary.at(-1), { startDate: '2026-01-01', endDate: '2026-10-31', type: 'all', dayStartHour: 2 });
  assert.equal(h.page.data.periodLabel, '2026年');
  assert.equal(h.page.data.periodRecordCount, 4);
  assert.equal(h.page.data.yearMonths.length, 12);
  assert.equal(h.page.data.yearMonths[0].value, 1);
  assert.equal(h.page.data.yearMonths[9].value, 3);
  assert.equal(h.page.data.yearMonths[9].percent, 100);
  assert.equal(h.page.data.yearMonths[1].value, 0);
  assert.equal(h.page.data.yearMonths[10].future, true);
  assert.deepEqual(plain(h.page.data.calendar), []);
  await h.page.onYearChange({ detail: { value: '2024' } });
  assert.deepEqual(h.calls.summary.at(-1), { startDate: '2024-01-01', endDate: '2024-12-31', type: 'all', dayStartHour: 2 });
  assert.equal(h.page.data.periodLabel, '2024年');
});

test('annual monthly bars use selected practice quantities and drill into month statistics', async () => {
  const h = createPage({ summary: () => summary });
  h.page.setData({ type: 'kindness', typeIndex: 5 });
  await h.page.changeStatsPeriod(event('year'));
  assert.equal(h.page.data.periodCards.length, 1);
  assert.equal(h.page.data.selectedMonthUnit, '件');
  assert.equal(h.page.data.yearMonths[0].value, 0);
  assert.equal(h.page.data.yearMonths[9].value, 12);
  await h.page.selectYearMonth({ currentTarget: { dataset: { month: '2026-01' } } });
  assert.equal(h.page.data.statsPeriod, 'month');
  assert.equal(h.page.data.month, '2026-01');
  assert.deepEqual(h.calls.summary.at(-1), { month: '2026-01', type: 'kindness', dayStartHour: 2 });
  assert.equal(h.page.data.calendar.length > 0, true);
});

test('cumulative statistics use independent allTime totals without fetching all historical daily rows', async () => {
  const h = createPage({ summary: () => summary });
  await h.page.changeStatsPeriod(event('allTime'));
  assert.deepEqual(h.calls.summary.at(-1), { month: '2026-10', type: 'all', dayStartHour: 2 });
  assert.equal(h.page.data.periodLabel, '全部已上传记录');
  assert.equal(h.page.data.periodRecordCount, 20);
  assert.equal(h.page.data.periodPracticeDays, 11);
  assert.equal(h.page.data.periodCards.find(card => card.type === 'kindness').value, 70);
  assert.deepEqual(plain(h.page.data.calendar), []);
  assert.deepEqual(plain(h.page.data.yearMonths), []);
});

test('changing statistical range invalidates a slow older response', async () => {
  const old = deferred();
  const h = createPage({ summary: params => params.startDate ? summary : old.promise });
  const first = h.page.refresh();
  await h.page.changeStatsPeriod(event('year'));
  assert.equal(h.page.data.periodLabel, '2026年');
  old.resolve({ recordCount: 999, totals: [] });
  await first;
  assert.equal(h.page.data.periodLabel, '2026年');
  assert.equal(h.page.data.periodRecordCount, 4);
  assert.equal(h.page.data.summaryLoading, false);
});

test('future years and months are ignored, including the date before the 02:00 new-year boundary', async () => {
  const h = createPage({ now: '2027-01-01T01:59:59+08:00', summary: () => summary });
  assert.equal(h.page.data.year, '2026');
  await h.page.changeStatsPeriod(event('year'));
  assert.deepEqual(h.calls.summary.at(-1), { startDate: '2026-01-01', endDate: '2026-12-31', type: 'all', dayStartHour: 2 });
  const count = h.calls.summary.length;
  await h.page.onYearChange({ detail: { value: '2027' } });
  await h.page.selectYearMonth({ currentTarget: { dataset: { month: '2027-01' } } });
  await h.page.selectYearMonth({ currentTarget: { dataset: { month: '2026-99' } } });
  assert.equal(h.calls.summary.length, count);
});

test('02:00 new-year rollover follows the current year and leaves an explicitly historical year unchanged', async () => {
  for (const historical of [false, true]) {
    const h = createPage({ now: '2027-01-01T01:59:59+08:00' });
    h.page.setData({ statsPeriod: 'year', ...(historical ? { year: '2024' } : {}) });
    h.page.onShow();
    await new Promise(resolve => setImmediate(resolve));
    h.advance(1000);
    h.runDueTimers();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.page.data.year, historical ? '2024' : '2027');
    assert.equal(h.calls.summary.at(-1).startDate, historical ? '2024-01-01' : '2027-01-01');
    assert.equal(h.calls.summary.at(-1).endDate, historical ? '2024-12-31' : '2027-01-01');
    h.page.onHide();
  }
});
