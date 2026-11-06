const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { plain, deferred, failure, createPage, persistedQueue } = require('./helpers/practicePage');

const createHome = options => createPage({ ...options, screen: 'home' });
const settle = () => new Promise(resolve => setImmediate(resolve));
const types = ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'];
const record = (id, type = 'walking', recordDate = '2026-10-31') => ({
  id, type, recordDate, durationMinutes: 2, count: 1, content: '帮助他人',
  occurredAt: `${recordDate} 09:00:00`
});

test('home groups records from 02:00 through the next 02:00 without changing occurrence dates', async () => {
  const records = [
    { ...record(1, 'walking', '2026-11-01'), occurredAt: '2026-11-01 01:59:59' },
    { ...record(2), occurredAt: '2026-10-31 02:00:00' },
    { ...record(3), occurredAt: '2026-10-31 01:59:59' },
    record(4, 'walking', '2026-10-30'),
    { ...record(5, 'walking', '2026-10-29'), occurredAt: '2026-10-29 02:00:00' },
    { ...record(6, 'walking', '2026-10-29'), occurredAt: '2026-10-29 01:59:59' },
    { ...record(7, 'walking', '2026-11-01'), occurredAt: '2026-11-01 02:00:00' },
    { ...record(8), occurredAt: null }
  ];
  const original = plain(records);
  const h = createHome({ now: '2026-11-01T01:59:59+08:00', feed: () => ({ records }) });
  await h.page.refresh();
  assert.equal(h.page.data.today, '2026-11-01', 'form bounds keep the actual Beijing date');
  assert.equal(h.page.data.displayToday, '2026-10-31');
  assert.equal(h.page.data.todayLabel, '10月31日');
  assert.equal(h.page.data.recentStart, '2026-10-29');
  assert.deepEqual(plain(h.page.data.recentGroups.map(group => [group.date, group.records.map(item => item.id)])), [
    ['2026-10-31', [1, 2, 8]], ['2026-10-30', [3, 4]], ['2026-10-29', [5]]
  ]);
  const earlyRecord = h.page.data.recentRecords.find(item => item.id === 1);
  assert.equal(earlyRecord.displayDate, '2026-10-31');
  assert.equal(earlyRecord.recordDate, '2026-11-01');
  assert.equal(earlyRecord.occurredAt, '2026-11-01 01:59:59');
  assert.deepEqual(records, original, 'server records are not rewritten');
  assert.equal(h.calls.enqueue.length, 0);
});

test('midnight keeps the same practice-day cache while form dates advance to the actual date', async () => {
  const response = deferred();
  let reloading = false;
  const h = createHome({ now: '2026-10-31T23:59:59+08:00',
    feed: () => reloading ? response.promise : { records: [record(1)] },
    summary: () => reloading ? response.promise : { totals: [{ type: 'walking', totalValue: 20 }] }
  });
  await h.page.refresh();
  h.advance(2000);
  reloading = true;
  const refreshing = h.page.refresh();
  assert.equal(h.page.data.displayToday, '2026-10-31');
  assert.equal(h.page.data.homeLoaded, true);
  assert.equal(h.page.data.todayLoaded, true);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 20);
  h.page.openForm('walking');
  assert.equal(h.page.data.today, '2026-11-01');
  assert.equal(h.page.data.formDate, '2026-11-01');
  assert.equal(h.page.data.formTime, '00:00');
  assert.equal(h.page.data.displayToday, '2026-10-31', 'opening a form cannot change the statistics day');
  response.resolve({ records: [record(1)], totals: [{ type: 'walking', totalValue: 20 }] });
  await refreshing;
  assert.equal(h.calls.feed.at(-1).endDate, '2026-10-31');
  assert.equal(h.calls.summary.at(-1).endDate, '2026-10-31');
});

test('visible home refreshes at 02:00 and cancels its day watcher when hidden', async () => {
  const h = createHome({ now: '2026-11-01T01:59:59+08:00' });
  h.page.onShow();
  await settle();
  assert.equal(h.page.data.displayToday, '2026-10-31');
  assert.equal(h.timerCount(), 1);
  h.advance(1000);
  h.runDueTimers();
  await settle();
  assert.equal(h.page.data.displayToday, '2026-11-01');
  assert.equal(h.page.data.todayLabel, '11月1日');
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.summary.length, 2);
  assert.equal(h.calls.summary.at(-1).endDate, '2026-11-01');
  h.page.onHide();
  assert.equal(h.timerCount(), 0);
  h.advance(24 * 60 * 60 * 1000);
  h.runDueTimers();
  await settle();
  assert.equal(h.calls.summary.length, 2);
});

function observeData(page) {
  const snapshots = [];
  const setData = page.setData;
  page.setData = function (data) {
    setData.call(this, data);
    snapshots.push(plain(this.data));
  };
  return snapshots;
}

function assertRetainedHome(snapshots, values, recordIds, label) {
  assert.ok(snapshots.length, `${label}: observable updates`);
  for (const data of snapshots) {
    assert.equal(data.todayLoaded, true, `${label}: today's loaded state must remain available`);
    assert.equal(data.homeLoaded, true, `${label}: recent records must remain available`);
    assert.ok(values.includes(data.homeCards.find(item => item.type === 'walking')?.value), `${label}: no transient zero total`);
    assert.equal(data.recentRecords.length, 1, `${label}: no transient empty feed`);
    assert.ok(recordIds.includes(data.recentRecords[0].id), `${label}: only complete feed results`);
    assert.equal(data.recentGroups.flatMap(group => group.records).length, 1, `${label}: no transient empty groups`);
  }
}

test('first home reads distinguish pending totals and records from successful empty results', async () => {
  const feed = deferred(), summary = deferred();
  const h = createHome({ feed: () => feed.promise, summary: () => summary.promise });
  assert.equal(h.page.data.todayLoaded, false);
  assert.equal(h.page.data.homeLoaded, false);
  const refreshing = h.page.refresh();
  assert.equal(h.page.data.todayLoading, true);
  assert.equal(h.page.data.homeLoading, true);
  assert.equal(h.page.data.todayLoaded, false);
  assert.equal(h.page.data.homeLoaded, false);
  summary.resolve({ totals: [] });
  await settle();
  assert.equal(h.page.data.todayLoaded, true, 'all-zero totals are a successful result');
  assert.equal(h.page.data.homeLoaded, false, 'the recent feed is still pending');
  assert.ok(h.page.data.homeCards.every(card => card.value === 0));
  feed.resolve({ records: [] });
  await refreshing;
  assert.equal(h.page.data.homeLoaded, true, 'an empty recent feed is a successful result');
  assert.equal(h.page.data.todayLoading, false);
  assert.equal(h.page.data.homeLoading, false);
});

test('same-day refresh and tab return retain loaded totals and records in every rendered update', async () => {
  for (const action of ['refresh', 'onShow']) {
    const feed = deferred(), summary = deferred();
    let reloading = false;
    const h = createHome({
      feed: () => reloading ? feed.promise : { records: [record(1)] },
      summary: () => reloading ? summary.promise : { totals: [{ type: 'walking', totalValue: 20 }] }
    });
    h.page.onShow();
    await settle();
    if (action === 'onShow') h.page.onHide();
    reloading = true;
    const snapshots = observeData(h.page);
    const refreshing = h.page[action]();
    assert.equal(h.calls.feed.length, 2, `${action}: still revalidate the recent feed`);
    assert.equal(h.calls.summary.length, 2, `${action}: still revalidate today's totals`);
    assert.equal(h.page.data.homeLoading, true, action);
    assert.equal(h.page.data.todayLoading, true, action);
    assertRetainedHome(snapshots, [20], [1], `${action}: pending`);
    summary.resolve({ totals: [{ type: 'walking', totalValue: 28 }] });
    await settle();
    assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 28, action);
    assert.equal(h.page.data.recentRecords[0].id, 1, 'the feed remains visible until its replacement completes');
    feed.resolve({ records: [record(2)] });
    await refreshing;
    await settle();
    assertRetainedHome(snapshots, [20, 28], [1, 2], action);
    assert.equal(h.page.data.recentRecords[0].id, 2, action);
    assert.equal(h.page.data.homeLoading, false, action);
    assert.equal(h.page.data.todayLoading, false, action);
    h.page.onHide();
  }
});

test('a refresh retains the complete previous feed until every replacement page arrives', async () => {
  const secondPage = deferred();
  let reloading = false;
  const h = createHome({
    feed: params => !reloading ? { records: [record(1)] } : params.cursor ? secondPage.promise : {
      records: [record(2)], nextCursor: 'replacement-page-2'
    },
    summary: () => ({ totals: [{ type: 'walking', totalValue: 20 }] })
  });
  await h.page.refresh();
  reloading = true;
  const refreshing = h.page.refresh();
  await settle();
  assert.equal(h.page.data.homeLoaded, true);
  assert.equal(h.page.data.homeLoading, true);
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [1]);
  secondPage.resolve({ records: [record(3)] });
  await refreshing;
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [2, 3]);
  assert.equal(h.page.data.homeLoaded, true);
});

test('tab return immediately filters cached all-practice results using the latest visibility preferences', async () => {
  const feed = deferred(), summary = deferred();
  let reloading = false;
  const h = createHome({ hiddenTypes: ['walking'],
    feed: () => reloading ? feed.promise : { records: [record(1), record(2, 'kindness')] },
    summary: () => reloading ? summary.promise : { totals: [
      { type: 'walking', totalValue: 20 }, { type: 'kindness', totalValue: 3 }
    ] }
  });
  h.page.onShow();
  await settle();
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.type)), ['kindness']);
  h.page.onHide();
  h.preferences.saveHiddenTypes(['kindness']);
  reloading = true;
  h.page.onShow();
  assert.equal(h.page.data.homeCards.some(item => item.type === 'kindness'), false);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 20, 'restored cards use previously loaded totals');
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [1], 'restored practices use the complete cached feed');
  assert.equal(h.page.data.todayLoaded, true);
  assert.equal(h.page.data.homeLoaded, true);
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.summary.length, 2);
  feed.resolve({ records: [record(3)] });
  summary.resolve({ totals: [{ type: 'walking', totalValue: 25 }] });
  await settle();
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 25);
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [3]);
  h.page.onHide();
});

test('failed background reads retain loaded data while first-load failures stay unloaded', async () => {
  const feed = deferred(), summary = deferred();
  let reloading = false;
  const h = createHome({
    feed: () => reloading ? feed.promise : { records: [record(1)] },
    summary: () => reloading ? summary.promise : { totals: [{ type: 'walking', totalValue: 20 }] }
  });
  await h.page.refresh();
  reloading = true;
  const snapshots = observeData(h.page);
  const refreshing = h.page.refresh();
  feed.reject(failure('NETWORK_ERROR', '最近记录暂时离线'));
  summary.reject(failure('REQUEST_TIMEOUT', '今日统计暂时离线'));
  await refreshing;
  assertRetainedHome(snapshots, [20], [1], 'failed revalidation');
  assert.equal(h.page.data.homeError, '最近记录暂时离线');
  assert.equal(h.page.data.todayError, '今日统计暂时离线');
  assert.equal(h.page.data.homeLoading, false);
  assert.equal(h.page.data.todayLoading, false);
  const first = createHome({
    feed: () => { throw failure('NETWORK_ERROR', '首次明细失败'); },
    summary: () => { throw failure('NETWORK_ERROR', '首次统计失败'); }
  });
  await first.page.refresh();
  assert.equal(first.page.data.homeLoaded, false);
  assert.equal(first.page.data.todayLoaded, false);
  assert.equal(first.page.data.homeError, '首次明细失败');
  assert.equal(first.page.data.todayError, '首次统计失败');
});

test('a new practice day, account or binding invalidates loaded home data before replacement reads finish', async () => {
  for (const change of ['day', 'account', 'binding']) {
    for (const action of ['refresh', 'onShow']) {
      const feed = deferred(), summary = deferred();
      let reloading = false;
      const h = createHome({ now: '2026-11-01T01:59:59+08:00',
        feed: () => reloading ? feed.promise : { records: [record(1)] },
        summary: () => reloading ? summary.promise : { totals: [{ type: 'walking', totalValue: 20 }] }
      });
      h.page.onShow();
      await settle();
      assert.equal(h.page.data.todayLoaded, true);
      assert.equal(h.page.data.homeLoaded, true);
      if (action === 'onShow') h.page.onHide();
      if (change === 'day') h.advance(2000);
      else h.changeOwner({ openid: change === 'account' ? 'oz-other' : 'oz-owner',
        studentNumber: change === 'account' ? '002' : '001', bindingVersion: 'v2' });
      reloading = true;
      const refreshing = h.page[action]();
      const label = `${change}: ${action}`;
      assert.equal(h.page.data.todayLoaded, false, label);
      assert.equal(h.page.data.homeLoaded, false, label);
      assert.ok(h.page.data.homeCards.every(card => card.value === 0), `${label}: old totals cannot be shown`);
      assert.deepEqual(plain(h.page.data.recentRecords), [], `${label}: old records cannot be shown`);
      assert.equal(h.page.data.recentGroups.flatMap(group => group.records).length, 0, label);
      assert.equal(h.page.data.todayLoading, true, label);
      assert.equal(h.page.data.homeLoading, true, label);
      feed.resolve({ records: [record(2, 'walking', h.page.data.displayToday)] });
      summary.resolve({ totals: [{ type: 'walking', totalValue: 4 }] });
      await refreshing;
      await settle();
      assert.equal(h.page.data.todayLoaded, true, label);
      assert.equal(h.page.data.homeLoaded, true, label);
      assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 4, label);
      assert.equal(h.page.data.recentRecords[0].id, 2, label);
      h.page.onHide();
    }
  }
});

test('a confirmed persisted queue upload revalidates the visible home without clearing existing values', async () => {
  const feed = deferred(), summary = deferred();
  let reloading = false;
  const h = createHome({
    feed: () => reloading ? feed.promise : { records: [record(1)] },
    summary: () => reloading ? summary.promise : { totals: [{ type: 'walking', totalValue: 20 }] },
    queueFactory: persistedQueue({ create: async () => ({ id: 2 }) })
  });
  h.page.onShow();
  await settle();
  reloading = true;
  const snapshots = observeData(h.page);
  h.queue.enqueuePractice({ type: 'walking', operation: 'create', payload: {}, requestId: 'home-background-create' });
  const result = await h.queue.flush();
  await settle();
  assert.equal(result.sent, 1);
  assert.equal(h.page.data.pendingCount, 0);
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.summary.length, 2);
  assert.equal(h.page.data.todayLoading, true);
  assert.equal(h.page.data.homeLoading, true);
  assertRetainedHome(snapshots, [20], [1], 'confirmed background upload: pending');
  feed.resolve({ records: [record(2)] });
  summary.resolve({ totals: [{ type: 'walking', totalValue: 28 }] });
  await settle();
  assertRetainedHome(snapshots, [20, 28], [1, 2], 'confirmed background upload');
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 28);
  assert.equal(h.page.data.recentRecords[0].id, 2);
  h.page.onHide();
});

// Today's cards must come from complete server totals, even while the recent feed is paging.
test('home requests today totals independently of the latest three practice days and fills all six cards', async () => {
  const secondPage = deferred();
  const h = createHome({
    feed: params => params.cursor ? secondPage.promise : {
      records: [record(1)], nextCursor: 'recent-page-2'
    },
    summary: () => ({ recordCount: 27, totals: [
      { type: 'walking', totalValue: 125, recordCount: 20 },
      { type: 'instant', totalValue: 7, recordCount: 3 },
      { type: 'kindness', totalValue: 4, recordCount: 4 }
    ] })
  });
  const refreshing = h.page.refresh();
  await settle();
  assert.deepEqual(h.calls.summary, [{ dayStartHour: 2, startDate: '2026-10-31', endDate: '2026-10-31', type: 'all' }]);
  assert.deepEqual(h.calls.feed, [
    { dayStartHour: 2, startDate: '2026-10-29', endDate: '2026-10-31', type: 'all', limit: 100 },
    { dayStartHour: 2, startDate: '2026-10-29', endDate: '2026-10-31', type: 'all', limit: 100, cursor: 'recent-page-2' }
  ]);
  assert.deepEqual(plain(h.page.data.homeCards.map(item => item.type)), types);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 125);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').records, 20);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'instant').value, 7);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'kindness').value, 4);
  for (const type of ['sitting', 'learning', 'clapping']) {
    assert.equal(h.page.data.homeCards.find(item => item.type === type).value, 0, type);
  }
  assert.equal(h.page.data.todayLoading, false);
  assert.equal(h.page.data.homeLoading, true);
  secondPage.resolve({ records: [record(2, 'walking', '2026-10-30')], nextCursor: '' });
  await refreshing;
  assert.equal(h.page.data.recentRecords.length, 2);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 125);
  assert.equal(h.page.data.homeLoading, false);
});

test('home filters cards and recent records without allowing hidden first-page entries to hide later visible records', async () => {
  const h = createHome({ hiddenTypes: ['walking', 'sitting', 'instant', 'learning'],
    feed: params => params.cursor ? {
      records: [record(3, 'kindness'), record(3, 'kindness'), record(4, 'clapping')]
    } : { records: [record(1), record(2, 'sitting')], nextCursor: 'visible-records-later' },
    summary: () => ({ totals: [{ type: 'walking', totalValue: 300 }, { type: 'kindness', totalValue: 5 }] })
  });
  await h.page.refresh();
  assert.deepEqual(plain(h.page.data.homeCards.map(item => [item.type, item.value])), [['kindness', 5], ['clapping', 0]]);
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.key)), ['kindness:3', 'clapping:4']);
  assert.deepEqual(plain(h.page.data.records), plain(h.page.data.recentRecords));
  assert.deepEqual(plain(h.page.data.recentGroups.map(item => item.date)), ['2026-10-31']);
  assert.equal(h.page.data.recentGroups[0].records.length, 2);
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.summary.length, 1);
});

test('a selected subset and all six practices show the latest three days while excluding hidden or out-of-window records', async () => {
  const records = [record(1, 'kindness'), record(2, 'kindness', '2026-10-30'), record(3, 'kindness', '2026-10-29'),
    record(4, 'kindness', '2026-10-28'), record(5, 'kindness', '2026-11-01'), record(6, 'walking', '2026-10-30')];
  const subset = createHome({ hiddenTypes: ['walking'], feed: () => ({ records }) });
  await subset.page.refresh();
  assert.equal(subset.page.data.homeRecentDays, 3);
  assert.equal(subset.page.data.recentStart, '2026-10-29');
  assert.deepEqual(subset.calls.feed, [{ dayStartHour: 2, startDate: '2026-10-29', endDate: '2026-10-31', type: 'all', limit: 100 }]);
  assert.deepEqual(plain(subset.page.data.recentRecords.map(item => item.id)), [1, 2, 3]);
  assert.deepEqual(plain(subset.page.data.recentGroups.map(item => item.date)), ['2026-10-31', '2026-10-30', '2026-10-29']);
  const all = createHome({ feed: () => ({ records }) });
  await all.page.refresh();
  assert.equal(all.page.data.homeRecentDays, 3);
  assert.equal(all.page.data.recentStart, '2026-10-29');
  assert.deepEqual(plain(all.page.data.recentRecords.map(item => item.id)), [1, 2, 3, 6]);
  assert.deepEqual(plain(all.page.data.recentGroups.map(item => item.date)), ['2026-10-31', '2026-10-30', '2026-10-29']);
});

test('home rereads the latest visibility preferences on return without deleting hidden records or uploads', async () => {
  const h = createHome({ feed: () => ({ records: [record(1), record(2, 'kindness')] }),
    summary: () => ({ totals: [{ type: 'walking', totalValue: 20 }, { type: 'kindness', totalValue: 3 }] }) });
  h.tasks.push({ id: 'pending-walking', type: 'walking', operation: 'create', attempts: 0,
    owner: { studentNumber: '001' }, payload: { recordDate: '2026-10-31', durationMinutes: 5 } });
  h.page.onShow();
  await settle();
  assert.equal(h.page.data.homeCards.length, 6);
  h.page.onHide();
  h.preferences.saveHiddenTypes(types.filter(type => type !== 'kindness'));
  h.page.onShow();
  await settle();
  assert.deepEqual(plain(h.page.data.homeCards.map(item => item.type)), ['kindness']);
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.type)), ['kindness']);
  assert.equal(h.page.data.pendingCount, 1);
  assert.equal(h.tasks[0].id, 'pending-walking');
  assert.equal(h.calls.enqueue.length, 0);
  assert.equal(h.calls.flush.length, 0);
  h.page.onHide();
  h.preferences.saveHiddenTypes([]);
  h.page.onShow();
  await settle();
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 20);
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.type)), ['walking', 'kindness']);
  h.page.onHide();
});

test('all-hidden home stays empty while the separate history keeps the original complete records and totals', async () => {
  const options = { hiddenTypes: types, feed: () => ({ records: [record(1)] }),
    summary: () => ({ totals: [{ type: 'walking', totalValue: 75 }], allTime: { totals: [{ type: 'walking', totalValue: 750 }] } }) };
  const home = createHome(options), history = createPage(options);
  await Promise.all([home.page.refresh(), history.page.refresh()]);
  assert.deepEqual(plain(home.page.data.homeCards), []);
  assert.deepEqual(plain(home.page.data.recentRecords), []);
  assert.equal(history.page.data.records[0].id, 1);
  assert.equal(history.page.data.monthCards.find(item => item.type === 'walking').value, 75);
  assert.equal(history.page.data.allTimeCards.find(item => item.type === 'walking').value, 750);
});

test('home uses Beijing dates across month, year and leap-day boundaries', async () => {
  for (const [now, startDate, endDate, todayLabel] of [
    ['2026-10-31T18:00:00Z', '2026-10-30', '2026-11-01', '11月1日'],
    ['2026-12-31T18:00:00Z', '2026-12-30', '2027-01-01', '1月1日'],
    ['2028-02-29T18:00:00Z', '2028-02-28', '2028-03-01', '3月1日'],
    ['2027-02-28T15:59:59Z', '2027-02-26', '2027-02-28', '2月28日']
  ]) {
    const h = createHome({ now });
    assert.equal(h.page.data.todayLabel, todayLabel, `onLoad: ${now}`);
    await h.page.refresh();
    assert.equal(h.page.data.todayLabel, todayLabel, `refresh: ${now}`);
    assert.equal(h.page.data.displayToday, endDate, now);
    assert.equal(h.page.data.recentStart, startDate, now);
    assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, startDate, endDate, type: 'all', limit: 100 }], now);
    assert.deepEqual(h.calls.summary, [{ dayStartHour: 2, startDate: endDate, endDate, type: 'all' }], now);
  }
});

test('refreshing or returning after 02:00 moves the home window to the new practice day', async () => {
  for (const action of ['refresh', 'onShow']) {
    const h = createHome({ now: '2027-01-01T01:59:59+08:00' });
    assert.equal(h.page.data.todayLabel, '12月31日', `onLoad: ${action}`);
    await h.page.refresh();
    assert.equal(h.page.data.todayLabel, '12月31日', `before 02:00: ${action}`);
    h.advance(2000);
    await h.page[action]();
    await settle();
    assert.equal(h.page.data.today, '2027-01-01', action);
    assert.equal(h.page.data.todayLabel, '1月1日', action);
    assert.equal(h.page.data.recentStart, '2026-12-30', action);
    assert.deepEqual(h.calls.feed.at(-1), { dayStartHour: 2, startDate: '2026-12-30', endDate: '2027-01-01', type: 'all', limit: 100 }, action);
    assert.deepEqual(h.calls.summary.at(-1), { dayStartHour: 2, startDate: '2027-01-01', endDate: '2027-01-01', type: 'all' }, action);
    h.page.onHide();
  }
});

test('late home success and failure cannot update a hidden page or a newer refresh or account', async () => {
  for (const invalidation of ['onHide', 'onUnload', 'refresh', 'owner']) {
    for (const lateFailure of [false, true]) {
      const feed = deferred(), summary = deferred();
      let feedCount = 0, summaryCount = 0;
      const h = createHome({
        feed: () => ++feedCount === 1 ? feed.promise : { records: [record(2, 'kindness')] },
        summary: () => ++summaryCount === 1 ? summary.promise : { totals: [{ type: 'kindness', totalValue: 2 }] }
      });
      const oldRefresh = h.page.refresh();
      if (invalidation === 'owner') h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
      else await h.page[invalidation]();
      const current = plain(h.page.data);
      if (lateFailure) {
        feed.reject(failure('AUTH_REQUIRED', '旧账号的明细错误'));
        summary.reject(failure('NETWORK_ERROR', '旧账号的统计错误'));
      } else {
        feed.resolve({ records: [record(99)] });
        summary.resolve({ totals: [{ type: 'walking', totalValue: 999 }] });
      }
      await oldRefresh;
      assert.deepEqual(plain(h.page.data), current, `${invalidation}: ${lateFailure ? 'failure' : 'success'}`);
    }
  }
});

test('a home feed failure keeps successful daily totals and a daily summary failure keeps recent records', async () => {
  let feedFails = true, summaryFails = false;
  const h = createHome({
    feed: () => { if (feedFails) throw failure('NETWORK_ERROR', '最近记录读取失败'); return { records: [record(1)] }; },
    summary: () => { if (summaryFails) throw failure('REQUEST_TIMEOUT', '今日统计读取失败'); return { totals: [{ type: 'walking', totalValue: 50 }] }; }
  });
  await h.page.refresh();
  assert.equal(h.page.data.homeFailure.message, '最近记录读取失败');
  assert.equal(h.page.data.homeError, '最近记录读取失败');
  assert.equal(h.page.data.todayFailure, null);
  assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 50);
  feedFails = false;
  summaryFails = true;
  await h.page.refresh();
  assert.equal(h.page.data.homeFailure, null);
  assert.equal(h.page.data.homeError, '');
  assert.equal(h.page.data.recentRecords[0].id, 1);
  assert.equal(h.page.data.todayFailure.message, '今日统计读取失败');
  assert.equal(h.page.data.todayError, '今日统计读取失败');
  assert.equal(h.page.data.homeLoading, false);
  assert.equal(h.page.data.todayLoading, false);
});

test('a home refresh immediately clears old errors while replacement reads are pending', async () => {
  const feed = deferred(), summary = deferred();
  let retrying = false;
  const h = createHome({
    feed: () => { if (!retrying) throw failure('NETWORK_ERROR', '旧明细错误'); return feed.promise; },
    summary: () => { if (!retrying) throw failure('NETWORK_ERROR', '旧统计错误'); return summary.promise; }
  });
  await h.page.refresh();
  retrying = true;
  const refreshing = h.page.refresh();
  assert.equal(h.page.data.homeError, '');
  assert.equal(h.page.data.todayError, '');
  assert.equal(h.page.data.homeFailure, null);
  assert.equal(h.page.data.todayFailure, null);
  assert.equal(h.page.data.homeLoading, true);
  assert.equal(h.page.data.todayLoading, true);
  feed.resolve({ records: [] });
  summary.resolve({ totals: [] });
  await refreshing;
});

test('each visible home card directly opens its practice entry, including the existing sitting entry', () => {
  for (const type of types) {
    const h = createHome();
    h.page.openPracticeCard({ currentTarget: { dataset: { type } } });
    if (type === 'sitting') {
      assert.equal(h.storage.practiceSittingEntry, true);
      assert.deepEqual(plain(h.calls.switchTab), [{ url: '/pages/index/index' }]);
    } else {
      assert.equal(h.page.data.showForm, true, type);
      assert.equal(h.page.data.formType, type);
      assert.equal(h.page.data.formDate, '2026-10-31', type);
    }
    assert.equal(h.calls.feed.length, 0);
    assert.equal(h.calls.summary.length, 0);
  }
});

test('a hidden, stale or unknown home card cannot open a new entry', () => {
  const h = createHome();
  h.preferences.saveHiddenTypes(['walking', 'sitting']);
  for (const type of ['walking', 'sitting', 'all', 'invalid', undefined]) {
    h.page.openPracticeCard({ currentTarget: { dataset: { type } } });
    assert.equal(h.page.data.showForm, false, String(type));
  }
  assert.equal(h.calls.navigation.length, 0);
  assert.equal(h.storage.practiceSittingEntry, undefined);
});

test('history navigation supports detail and statistics views', () => {
  const h = createHome();
  for (const view of ['detail', 'stats']) h.page.openRecords({ currentTarget: { dataset: { view } } });
  assert.deepEqual(plain(h.calls.navigation), [
    { url: '/pages/practiceHistory/practiceHistory?view=detail' },
    { url: '/pages/practiceHistory/practiceHistory?view=stats' }
  ]);
  assert.equal(createPage({ loadOptions: { view: 'stats' } }).page.data.view, 'stats');
  assert.equal(createPage({ loadOptions: { view: 'detail' } }).page.data.view, 'detail');
  assert.equal(createPage({ loadOptions: { view: 'invalid' } }).page.data.view, 'detail');
});

test('home template shows interactive daily cards, a three-day records heading and a combined history link', () => {
  const home = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/practiceHistory/practiceHistory'));
  assert.match(home, /homeCards/);
  assert.match(home, /bindtap="openPracticeCard"/);
  assert.match(home, /recentGroups/);
  assert.match(home, /<text class="home-section-title">最近三天记录<\/text>/);
  assert.doesNotMatch(home, /今天的记录/);
  assert.match(home, /data-view="detail"[^>]*bindtap="openRecords"|bindtap="openRecords"[^>]*data-view="detail"/);
  assert.match(home, /明细与统计/);
  assert.match(home, /<include\s+src="[^"]*practiceDialogs\.wxml"\s*\/>/);
  assert.doesNotMatch(home, /bindchange="onMonthChange"|class="calendar|每日完成量趋势|已上传功课累计/);
});


test('actual home and history entry files register their intended screen with the shared controller', () => {
  for (const [relative, screen] of [
    ['practices/practices.js', 'home'], ['practiceHistory/practiceHistory.js', 'history']
  ]) {
    const filename = path.join(__dirname, '../miniprogram/pages', relative);
    const screens = [], registrations = [];
    const definition = { data: { screen } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: name => {
        assert.equal(path.resolve(path.dirname(filename), name),
          path.join(__dirname, '../miniprogram/pages/practices/practicePage.js'));
        return selected => { screens.push(selected); return definition; };
      },
      Page: value => registrations.push(value)
    }, { filename });
    assert.deepEqual(screens, [screen]);
    assert.deepEqual(registrations, [definition]);
  }
});

test('home applies visibility changes made while its feed and totals are in flight', async () => {
  for (const restored of [false, true]) {
    const feed = deferred(), summary = deferred();
    const h = createHome({ hiddenTypes: restored ? ['walking'] : [],
      feed: () => feed.promise, summary: () => summary.promise });
    const refreshing = h.page.refresh();
    h.preferences.saveHiddenTypes(restored ? [] : ['walking']);
    feed.resolve({ records: [record(1)] });
    summary.resolve({ totals: [{ type: 'walking', totalValue: 30 }] });
    await refreshing;
    await settle();
    assert.equal(h.page.data.homeCards.some(item => item.type === 'walking'), restored);
    assert.equal(h.page.data.recentRecords.some(item => item.type === 'walking'), restored);
    assert.equal(h.calls.feed.length, 2);
    assert.equal(h.calls.summary.length, 2);
    assert.equal(h.page.data.homeRecentDays, 3);
    assert.equal(h.calls.feed.at(-1).startDate, '2026-10-29');
  }
});

test('disabled home does not request data or open an entry and all-hidden home needs no reads', async () => {
  const disabled = createHome({ enabled: false });
  await disabled.page.refresh();
  for (const type of types) disabled.page.openPracticeCard({ currentTarget: { dataset: { type } } });
  assert.equal(disabled.calls.feed.length, 0);
  assert.equal(disabled.calls.summary.length, 0);
  assert.equal(disabled.calls.navigation.length, 0);
  assert.equal(disabled.page.data.showForm, false);
  const hidden = createHome({ hiddenTypes: types });
  await hidden.page.refresh();
  assert.equal(hidden.calls.feed.length, 0);
  assert.equal(hidden.calls.summary.length, 0);
  assert.equal(hidden.page.data.homeLoading, false);
  assert.equal(hidden.page.data.todayLoading, false);
});

test('home cards rendered under a previous account or binding cannot open a new record', () => {
  for (const owner of [
    { openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' },
    { openid: 'oz-owner', studentNumber: '001', bindingVersion: 'changed-binding' }
  ]) {
    const h = createHome();
    h.changeOwner(owner);
    for (const type of ['walking', 'sitting']) h.page.openPracticeCard({ currentTarget: { dataset: { type } } });
    assert.equal(h.page.data.showForm, false);
    assert.equal(h.calls.navigation.length, 0);
    assert.equal(h.storage.practiceSittingEntry, undefined);
  }
});

test('home failure actions use their own read scope to open binding or reload current data', async () => {
  for (const scope of ['home', 'today']) {
    for (const requiresBinding of [true, false]) {
      const h = createHome();
      h.page.setData({
        homeFailure: { requiresBinding: scope === 'home' ? requiresBinding : !requiresBinding },
        todayFailure: { requiresBinding: scope === 'today' ? requiresBinding : !requiresBinding }
      });
      await h.page.handleReadFailure({ currentTarget: { dataset: { scope } } });
      if (requiresBinding) {
        assert.deepEqual(plain(h.calls.switchTab), [{ url: '/pages/me/me' }], scope);
        assert.equal(h.calls.feed.length, 0, scope);
        assert.equal(h.calls.summary.length, 0, scope);
      } else {
        assert.equal(h.calls.navigation.length, 0, scope);
        assert.equal(h.calls.feed.length, 1, scope);
        assert.equal(h.calls.summary.length, 1, scope);
      }
    }
  }
});

test('hiding a practice during a three-day read refreshes visible records without narrowing the date window', async () => {
  const feed = deferred();
  let requests = 0;
  const h = createHome({ feed: () => ++requests === 1 ? feed.promise : { records: [record(3, 'kindness'),
    record(4, 'kindness', '2026-10-30'), record(5, 'kindness', '2026-10-29'),
    record(6, 'walking', '2026-10-30'), record(7, 'kindness', '2026-10-28')] } });
  const refreshing = h.page.refresh();
  h.preferences.saveHiddenTypes(['walking']);
  feed.resolve({ records: [record(1, 'kindness'), record(2, 'kindness', '2026-10-30')] });
  await refreshing;
  await settle();
  assert.equal(h.page.data.homeRecentDays, 3);
  assert.equal(h.page.data.recentStart, '2026-10-29');
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.feed.at(-1).startDate, '2026-10-29');
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [3, 4, 5]);
  assert.deepEqual(plain(h.page.data.recentGroups.map(item => item.date)), ['2026-10-31', '2026-10-30', '2026-10-29']);
});

test('crossing 02:00 in a practice picker replaces in-flight reads and rejects the previous day results', async () => {
  for (const action of ['openTypePicker', 'onTypeChange']) {
    const oldFeed = deferred(), oldSummary = deferred(), newFeed = deferred(), newSummary = deferred();
    let reloading = false;
    const h = createHome({ now: '2026-11-01T01:59:59+08:00',
      feed: params => !reloading ? { records: [record(1)] }
        : params.endDate === '2026-10-31' ? oldFeed.promise : newFeed.promise,
      summary: params => !reloading ? { totals: [{ type: 'walking', totalValue: 20 }] }
        : params.endDate === '2026-10-31' ? oldSummary.promise : newSummary.promise
    });
    h.page.onShow();
    await settle();
    if (action === 'onTypeChange') h.page.openTypePicker();
    reloading = true;
    const oldRefreshing = h.page.refresh();
    h.advance(2000);
    const snapshots = observeData(h.page);
    h.page[action]({ detail: { type: 'all' } });
    const pending = plain(h.page.data);
    oldFeed.resolve({ records: [record(99)] });
    oldSummary.resolve({ totals: [{ type: 'walking', totalValue: 999 }] });
    await oldRefreshing;
    await settle();
    const afterOldResults = plain(h.page.data);
    newFeed.resolve({ records: [record(2, 'walking', '2026-11-01')] });
    newSummary.resolve({ totals: [{ type: 'walking', totalValue: 4 }] });
    await settle();
    assert.equal(pending.displayToday, '2026-11-01', action);
    assert.equal(pending.todayLoaded, false, action);
    assert.equal(pending.homeLoaded, false, action);
    assert.equal(h.calls.feed.filter(params => params.endDate === '2026-11-01').length, 1, `${action}: starts a new-day feed`);
    assert.equal(h.calls.summary.filter(params => params.endDate === '2026-11-01').length, 1, `${action}: starts new-day totals`);
    assert.equal(afterOldResults.todayLoaded, false, `${action}: old totals cannot mark today loaded`);
    assert.equal(afterOldResults.homeLoaded, false, `${action}: old feed cannot mark the new window loaded`);
    assert.ok(snapshots.every(data => !data.homeCards.some(card => card.value === 999)), `${action}: previous-day totals never render`);
    assert.ok(snapshots.every(data => !data.recentRecords.some(item => item.id === 99)), `${action}: stale records never render`);
    assert.equal(h.page.data.todayLoaded, true, action);
    assert.equal(h.page.data.homeLoaded, true, action);
    assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 4, action);
    assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [2], action);
    h.page.onHide();
  }
});

test('a practice picker opened after 02:00 starts new-day reads even when no request is in flight', async () => {
  for (const action of ['openTypePicker', 'onTypeChange']) {
    const feed = deferred(), summary = deferred();
    let reloading = false;
    const h = createHome({ now: '2026-11-01T01:59:59+08:00',
      feed: () => reloading ? feed.promise : { records: [record(1)] },
      summary: () => reloading ? summary.promise : { totals: [{ type: 'walking', totalValue: 20 }] }
    });
    h.page.onShow();
    await settle();
    if (action === 'onTypeChange') h.page.openTypePicker();
    h.advance(2000);
    reloading = true;
    h.page[action]({ detail: { type: 'all' } });
    const pending = plain(h.page.data);
    feed.resolve({ records: [record(2, 'walking', '2026-11-01')] });
    summary.resolve({ totals: [{ type: 'walking', totalValue: 4 }] });
    await settle();
    assert.equal(pending.displayToday, '2026-11-01', action);
    assert.equal(pending.todayLoaded, false, action);
    assert.equal(pending.homeLoaded, false, action);
    assert.equal(pending.todayLoading, true, action);
    assert.equal(pending.homeLoading, true, action);
    assert.equal(h.calls.feed.length, 2, action);
    assert.equal(h.calls.feed.at(-1).endDate, '2026-11-01', action);
    assert.equal(h.calls.summary.length, 2, action);
    assert.equal(h.calls.summary.at(-1).endDate, '2026-11-01', action);
    assert.equal(h.page.data.todayLoaded, true, `${action}: new totals complete instead of staying unloaded`);
    assert.equal(h.page.data.homeLoaded, true, `${action}: new feed completes instead of staying unloaded`);
    assert.equal(h.page.data.homeCards.find(item => item.type === 'walking').value, 4, action);
    assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [2], action);
    h.page.onHide();
  }
});

test('authorization failures invalidate previously loaded home data', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'BINDING_INVALID', 'IDENTITY_MISMATCH']) {
    let denied = false;
    const h = createHome({
      feed: () => { if (denied) throw failure(code, '账号权限失效'); return { records: [record(1)] }; },
      summary: () => { if (denied) throw failure(code, '账号权限失效'); return { totals: [{ type: 'walking', totalValue: 20 }] }; }
    });
    await h.page.refresh();
    assert.equal(h.page.data.homeLoaded, true, code);
    assert.equal(h.page.data.todayLoaded, true, code);
    denied = true;
    await h.page.refresh();
    assert.equal(h.page.data.homeLoaded, false, code);
    assert.equal(h.page.data.todayLoaded, false, code);
    assert.deepEqual(plain(h.page.data.recentRecords), [], code);
    assert.equal(h.page.data.recentGroups.flatMap(group => group.records).length, 0, code);
    assert.ok(h.page.data.homeCards.every(card => card.value === 0), code);
    assert.equal(h.page.data.homeFailure.requiresBinding, true, code);
    assert.equal(h.page.data.todayFailure.requiresBinding, true, code);
    assert.equal(h.page.data.homeLoading, false, code);
    assert.equal(h.page.data.todayLoading, false, code);
  }
});

test('an unreadable current account cannot reuse confirmed home data or start unscoped reads', async () => {
  const h = createHome({
    feed: () => ({ records: [record(1)] }),
    summary: () => ({ totals: [{ type: 'walking', totalValue: 20 }] })
  });
  await h.page.refresh();
  assert.equal(h.page.data.homeLoaded, true);
  assert.equal(h.page.data.todayLoaded, true);
  h.storage.userOpenId = { invalid: 'account-storage-value' };
  await h.page.refresh();
  assert.equal(h.calls.feed.length, 1);
  assert.equal(h.calls.summary.length, 1);
  assert.equal(h.page.data.homeLoaded, false);
  assert.equal(h.page.data.todayLoaded, false);
  assert.deepEqual(plain(h.page.data.recentRecords), []);
  assert.ok(h.page.data.homeCards.every(card => card.value === 0));
  assert.match(h.page.data.homeError, /账号信息无法读取/);
  assert.match(h.page.data.todayError, /账号信息无法读取/);
  assert.equal(h.page.data.homeLoading, false);
  assert.equal(h.page.data.todayLoading, false);
});
