const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { plain, deferred, failure, createPage } = require('./helpers/practicePage');

const createHome = options => createPage({ ...options, screen: 'home' });
const settle = () => new Promise(resolve => setImmediate(resolve));
const types = ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'];
const record = (id, type = 'walking', recordDate = '2026-10-31') => ({
  id, type, recordDate, durationMinutes: 2, count: 1, content: '帮助他人',
  occurredAt: `${recordDate} 09:00:00`
});

// Today's cards must come from complete server totals, even while the recent feed is paging.
test('home requests today totals independently of the latest three calendar days and fills all six cards', async () => {
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
  assert.deepEqual(h.calls.summary, [{ startDate: '2026-10-31', endDate: '2026-10-31', type: 'all' }]);
  assert.deepEqual(h.calls.feed, [
    { startDate: '2026-10-29', endDate: '2026-10-31', type: 'all', limit: 100 },
    { startDate: '2026-10-29', endDate: '2026-10-31', type: 'all', limit: 100, cursor: 'recent-page-2' }
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

test('a selected subset keeps the homepage focused on today while all six practices show three days', async () => {
  const records = [record(1, 'kindness'), record(2, 'kindness', '2026-10-30'), record(3, 'kindness', '2026-10-29')];
  const subset = createHome({ hiddenTypes: ['walking'], feed: () => ({ records }) });
  await subset.page.refresh();
  assert.equal(subset.page.data.homeRecentDays, 1);
  assert.equal(subset.page.data.recentStart, '2026-10-31');
  assert.deepEqual(subset.calls.feed, [{ startDate: '2026-10-31', endDate: '2026-10-31', type: 'all', limit: 100 }]);
  assert.deepEqual(plain(subset.page.data.recentRecords.map(item => item.id)), [1]);
  assert.deepEqual(plain(subset.page.data.recentGroups.map(item => item.date)), ['2026-10-31']);
  const all = createHome({ feed: () => ({ records }) });
  await all.page.refresh();
  assert.equal(all.page.data.homeRecentDays, 3);
  assert.equal(all.page.data.recentStart, '2026-10-29');
  assert.deepEqual(plain(all.page.data.recentRecords.map(item => item.id)), [1, 2, 3]);
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
  for (const [now, startDate, endDate] of [
    ['2026-10-31T16:00:00Z', '2026-10-30', '2026-11-01'],
    ['2026-12-31T16:00:00Z', '2026-12-30', '2027-01-01'],
    ['2028-02-29T16:00:00Z', '2028-02-28', '2028-03-01'],
    ['2027-02-28T15:59:59Z', '2027-02-26', '2027-02-28']
  ]) {
    const h = createHome({ now });
    await h.page.refresh();
    assert.equal(h.page.data.today, endDate, now);
    assert.equal(h.page.data.recentStart, startDate, now);
    assert.deepEqual(h.calls.feed, [{ startDate, endDate, type: 'all', limit: 100 }], now);
    assert.deepEqual(h.calls.summary, [{ startDate: endDate, endDate, type: 'all' }], now);
  }
});

test('refreshing or returning after midnight moves the home window to the new Beijing day', async () => {
  for (const action of ['refresh', 'onShow']) {
    const h = createHome({ now: '2026-12-31T23:59:59+08:00' });
    await h.page.refresh();
    h.advance(2000);
    await h.page[action]();
    await settle();
    assert.equal(h.page.data.today, '2027-01-01', action);
    assert.equal(h.page.data.recentStart, '2026-12-30', action);
    assert.deepEqual(h.calls.feed.at(-1), { startDate: '2026-12-30', endDate: '2027-01-01', type: 'all', limit: 100 }, action);
    assert.deepEqual(h.calls.summary.at(-1), { startDate: '2027-01-01', endDate: '2027-01-01', type: 'all' }, action);
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

test('home template focuses on today with interactive cards and a combined history link', () => {
  const home = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/practiceHistory/practiceHistory'));
  assert.match(home, /homeCards/);
  assert.match(home, /bindtap="openPracticeCard"/);
  assert.match(home, /recentGroups/);
  assert.match(home, /data-view="detail"[^>]*bindtap="openRecords"|bindtap="openRecords"[^>]*data-view="detail"/);
  assert.match(home, /查看全部/);
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
    assert.equal(h.calls.feed.at(-1).startDate, restored ? '2026-10-29' : '2026-10-31');
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

test('hiding a practice during a three-day read also narrows the returned recent detail to today', async () => {
  const feed = deferred();
  let requests = 0;
  const h = createHome({ feed: () => ++requests === 1 ? feed.promise : { records: [record(3, 'kindness')] } });
  const refreshing = h.page.refresh();
  h.preferences.saveHiddenTypes(['walking']);
  feed.resolve({ records: [record(1, 'kindness'), record(2, 'kindness', '2026-10-30')] });
  await refreshing;
  await settle();
  assert.equal(h.page.data.homeRecentDays, 1);
  assert.equal(h.page.data.recentStart, '2026-10-31');
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.feed.at(-1).startDate, '2026-10-31');
  assert.deepEqual(plain(h.page.data.recentRecords.map(item => item.id)), [3]);
  assert.deepEqual(plain(h.page.data.recentGroups.map(item => item.date)), ['2026-10-31']);
});
