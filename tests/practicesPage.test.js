const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { plain, deferred, failure, createPage, persistedQueue } = require('./helpers/practicePage');
const historyTemplate = () => fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practiceHistory/practiceHistory.wxml'), 'utf8');
const dialogsTemplate = () => fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practiceDialogs.wxml'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '../miniprogram/templates/practiceForm.wxml'), 'utf8');

test('history defaults to the practice month before 02:00 and uses that day for statistics limits', async () => {
  for (const [now, expectedMonth, expectedDay] of [
    ['2026-11-01T01:59:59+08:00', '2026-10', '2026-10-31'],
    ['2027-01-01T01:59:59+08:00', '2026-12', '2026-12-31'],
    ['2028-03-01T01:59:59+08:00', '2028-02', '2028-02-29'],
    ['2026-11-01T02:00:00+08:00', '2026-11', '2026-11-01']
  ]) {
    const h = createPage({ now });
    assert.equal(h.page.data.month, expectedMonth, now);
    assert.equal(h.page.data.monthEnd, expectedDay, now);
    assert.equal(h.page.data.displayToday, expectedDay, now);
    assert.equal(h.page.data.today, now.slice(0, 10), now);
    await h.page.refresh();
    assert.deepEqual(h.calls.feed[0], { dayStartHour: 2, month: expectedMonth, type: 'all' }, now);
    assert.deepEqual(h.calls.summary[0], { dayStartHour: 2, month: expectedMonth, type: 'all' }, now);
    assert.equal(h.page.data.calendar.flat().find(day => day.date === expectedDay).today, true, now);
  }
});

test('history groups by display dates while editing keeps original dates and seconds', async () => {
  const records = [
    { id: 1, type: 'walking', recordDate: '2026-11-01', occurredAt: '2026-11-01 01:15:24', durationMinutes: 12 },
    { id: 2, type: 'walking', recordDate: '2026-10-31', occurredAt: '2026-10-31 01:15:24', durationMinutes: 15 },
    { id: 3, type: 'walking', recordDate: '2026-10-31', occurredAt: null, durationMinutes: 20 }
  ];
  const original = plain(records);
  const h = createPage({ now: '2026-11-01T01:30:00+08:00', feed: () => ({ records }) });
  await h.page.refresh();
  assert.deepEqual(plain(h.page.data.groups.map(group => [group.date, group.records.map(item => item.id)])), [
    ['2026-10-31', [1, 3]], ['2026-10-30', [2]]
  ]);
  h.page.openDetail({ currentTarget: { dataset: { key: 'walking:1' } } });
  h.page.editDetail();
  assert.equal(h.page.data.formDate, '2026-11-01');
  assert.equal(h.page.data.formTime, '01:15');
  h.page.onFormValue({ detail: { value: '18' } });
  await h.page.saveForm();
  assert.deepEqual(h.calls.enqueue[0].payload, { recordDate: '2026-11-01', occurredAt: '2026-11-01 01:15:24', durationMinutes: 18, reflection: '' });
  assert.deepEqual(records, original);
});

test('before 02:00 the actual calendar day remains unavailable as a statistics day', async () => {
  const h = createPage({ now: '2026-11-04T01:59:59+08:00', summary: () => ({ totals: [], daily: [], allTime: { totals: [] } }) });
  await h.page.refresh();
  const day = h.page.data.calendar.flat().find(item => item.date === '2026-11-04');
  assert.equal(day.future, true);
  const count = h.calls.feed.length + h.calls.summary.length;
  h.page.selectDay('2026-11-04');
  h.page.openDayStats({ currentTarget: { dataset: { date: '2026-11-04' } } });
  assert.equal(h.calls.feed.length + h.calls.summary.length, count);
  assert.equal(h.page.data.selectedDate, '');
  h.page.openForm('walking');
  assert.equal(h.page.data.formDate, '2026-11-04');
  assert.equal(h.page.data.today, '2026-11-04');
  assert.equal(h.page.data.displayToday, '2026-11-03');
});

test('records enable native friend and timeline sharing with a bundled cover', () => {
  const h = createPage();
  assert.deepEqual(h.calls.shareMenu, [{ menus: ['shareAppMessage', 'shareTimeline'] }]);
  const friend = plain(h.page.onShareAppMessage());
  assert.equal(friend.path, '/pages/practices/practices?from=share');
  assert.equal(friend.title, '功课记录 · 觉察日常，记录成长');
  assert.equal(friend.imageUrl, '/images/practice-share.png');
  const timeline = plain(h.page.onShareTimeline());
  assert.deepEqual(timeline, {
    title: friend.title, query: 'from=share', imageUrl: '/images/practice-share-timeline.png'
  });
  const cover = fs.readFileSync(path.join(__dirname, '../miniprogram', friend.imageUrl));
  assert.equal(cover.subarray(1, 4).toString(), 'PNG');
  assert.equal(cover.readUInt32BE(16), 500);
  assert.equal(cover.readUInt32BE(20), 400);
  const timelineCover = fs.readFileSync(path.join(__dirname, '../miniprogram', timeline.imageUrl));
  assert.equal(timelineCover.subarray(1, 4).toString(), 'PNG');
  assert.equal(timelineCover.readUInt32BE(16), 400);
  assert.equal(timelineCover.readUInt32BE(20), 400);
});

test('sharing an entry never serializes the sender records, account or current filters', () => {
  const h = createPage();
  h.preferences.saveRecordsVisible(false);
  h.page.setData({ type: 'kindness', month: '2026-09', selectedDate: '2026-09-18', view: 'stats',
    records: [{ id: 'private-record', reflection: 'private-reflection' }],
    detail: { content: 'private-content' }, formReflection: 'private-draft', pendingCount: 7 });
  const before = plain(h.storage);
  const friend = plain(h.page.onShareAppMessage({ from: 'menu' }));
  assert.deepEqual(friend, plain(createPage().page.onShareAppMessage({ from: 'menu' })));
  assert.deepEqual(plain(h.page.onShareTimeline()), plain(createPage().page.onShareTimeline()));
  assert.deepEqual(plain(h.storage), before);
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
  assert.equal(h.calls.enqueue.length, 0);
});

test('a shared entry is temporary and does not change account preferences or other query parameters', () => {
  const h = createPage({ loadOptions: { from: 'share', unrelated: 'preserved' } });
  h.preferences.saveRecordsVisible(false);
  h.page.onHide();
  assert.deepEqual(plain(h.page.options), { unrelated: 'preserved' });
  assert.equal(h.preferences.getRecordsVisible(), false);
  const normal = createPage({ loadOptions: { from: 'other' } });
  normal.page.onHide();
  assert.equal(normal.page.options.from, 'other');
});

test('records still open on clients without showShareMenu and have no in-page share button', () => {
  const h = createPage({ shareMenuAvailable: false });
  assert.deepEqual(h.calls.shareMenu, []);
  assert.equal(h.page.data.month, '2026-10');
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
  assert.doesNotMatch(wxml, /open-type\s*=\s*["']share["']|share-button/);
});

test('feed and summary start without a failure or a legacy error message', () => {
  const { page } = createPage();
  assert.equal(page.data.feedFailure, null);
  assert.equal(page.data.summaryFailure, null);
  assert.equal(page.data.error, '');
  assert.equal(page.data.summaryError, '');
});

test('record filters load only visible practices and reread restored settings when the page returns', async () => {
  const h = createPage({ hiddenTypes: ['sitting', 'walking', 'instant', 'learning'] });
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', 'kindness', 'clapping']);
  h.preferences.saveHiddenTypes(['sitting', 'kindness']);
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', 'walking', 'instant', 'learning', 'clapping']);
  h.preferences.saveHiddenTypes([]);
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', ...h.preferences.PRACTICES.map(item => item.type)]);
  h.page.onHide();
});

test('opening the record filter rereads preferences and preserves a still-visible selected practice by type', () => {
  const h = createPage();
  h.page.setData({ type: 'kindness', typeIndex: 5, selectedDate: '2026-10-30' });
  h.preferences.saveHiddenTypes(['sitting', 'walking', 'instant', 'learning']);
  h.page.openTypePicker();
  assert.equal(h.page.data.showTypePicker, true);
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', 'kindness', 'clapping']);
  assert.equal(h.page.data.type, 'kindness');
  assert.equal(h.page.data.typeIndex, 1);
  assert.equal(h.page.data.selectedDate, '2026-10-30');
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
});

test('record filter indices refer to the displayed options after hidden practices shift their positions', async () => {
  const h = createPage({ hiddenTypes: ['sitting', 'walking', 'instant', 'learning'] });
  h.page.setData({ selectedDate: '2026-10-30' });
  h.page.openTypePicker();
  h.page.onTypeChange({ detail: { value: '1' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.type, 'kindness');
  assert.equal(h.page.data.typeIndex, 1);
  assert.equal(h.page.data.selectedDate, '');
  assert.equal(h.page.data.showTypePicker, false);
  assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, month: '2026-10', type: 'kindness' }]);
  assert.deepEqual(h.calls.summary, [{ dayStartHour: 2, month: '2026-10', type: 'kindness' }]);
  h.page.openTypePicker();
  h.page.onTypeChange({ detail: { type: 'clapping' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.type, 'clapping');
  assert.equal(h.page.data.typeIndex, 2);
  assert.deepEqual(h.calls.feed.at(-1), { dayStartHour: 2, month: '2026-10', type: 'clapping' });
});

test('hiding the active practice resets the record filter to all before the next page refresh', async () => {
  const h = createPage();
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-30', view: 'stats' });
  h.preferences.saveHiddenTypes(['walking']);
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.type, 'all');
  assert.equal(h.page.data.typeIndex, 0);
  assert.equal(h.page.data.selectedDate, '');
  assert.equal(h.page.data.view, 'stats');
  assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, month: '2026-10', type: 'all' }]);
  assert.deepEqual(h.calls.summary, [{ dayStartHour: 2, month: '2026-10', type: 'all' }]);
  h.page.onHide();
});

test('opening a filter after hiding its active practice reloads all records without the old day restriction', async () => {
  const h = createPage();
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-30' });
  h.preferences.saveHiddenTypes(['walking']);
  h.page.openTypePicker();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.showTypePicker, true);
  assert.equal(h.page.data.type, 'all');
  assert.equal(h.page.data.typeIndex, 0);
  assert.equal(h.page.data.selectedDate, '');
  assert.equal(h.page.data.typeOptions.some(item => item.type === 'walking'), false);
  assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, month: '2026-10', type: 'all' }]);
  assert.deepEqual(h.calls.summary, [{ dayStartHour: 2, month: '2026-10', type: 'all' }]);
});

test('returning under another account uses that account settings without overwriting the previous ones', async () => {
  const h = createPage({ hiddenTypes: ['walking'] });
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  h.preferences.saveHiddenTypes(['kindness', 'clapping']);
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', 'sitting', 'walking', 'instant', 'learning']);
  h.changeOwner({ openid: 'oz-owner', studentNumber: '001', bindingVersion: 'v1' });
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all', 'sitting', 'instant', 'learning', 'kindness', 'clapping']);
  h.page.onHide();
});

test('all-hidden filters retain the all view and preserve hidden history, statistics and pending uploads', async () => {
  const allTypes = ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'];
  const h = createPage({ hiddenTypes: allTypes,
    feed: () => ({ records: [{ id: 7, type: 'walking', recordDate: '2026-10-30', durationMinutes: 15 }] }),
    summary: () => ({ recordCount: 1, practiceDays: 1,
      totals: [{ type: 'walking', totalValue: 15, recordCount: 1 }],
      daily: [{ date: '2026-10-30', recordCount: 1, totals: [{ type: 'walking', totalValue: 15 }] }],
      allTime: { recordCount: 1, totals: [{ type: 'walking', totalValue: 15 }] } }) });
  h.tasks.push({ id: 'hidden-upload', type: 'walking', operation: 'create', attempts: 0,
    owner: { studentNumber: '001' }, payload: { recordDate: '2026-10-30', durationMinutes: 5 } });
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.page.data.typeOptions.map(item => item.type)), ['all']);
  assert.equal(h.page.data.type, 'all');
  assert.equal(h.page.data.records[0].typeName, '走路觉察');
  assert.equal(h.page.data.records[0].quantity, 15);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'walking').value, 15);
  assert.equal(h.page.data.allTimeCards.find(item => item.type === 'walking').value, 15);
  assert.equal(h.page.data.calendar.flat().find(item => item.date === '2026-10-30').value, 1);
  assert.equal(h.page.data.pendingCount, 1);
  assert.equal(h.page.data.pending[0].typeName, '走路觉察');
  assert.equal(h.tasks.length, 1);
  assert.equal(h.calls.enqueue.length, 0);
  assert.equal(h.calls.flush.length, 0);
  assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, month: '2026-10', type: 'all' }]);
  h.page.onHide();
});

test('a record filter selection hidden after opening cannot be applied', () => {
  const h = createPage();
  h.page.openTypePicker();
  h.preferences.saveHiddenTypes(['walking']);
  h.page.onTypeChange({ detail: { type: 'walking' } });
  assert.equal(h.page.data.type, 'all');
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
});

test('a record filter selection from a previous account cannot be applied', () => {
  const h = createPage();
  h.page.openTypePicker();
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  h.page.onTypeChange({ detail: { type: 'walking' } });
  assert.equal(h.page.data.type, 'all');
  assert.equal(h.page.data.showTypePicker, false);
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
});

test('cancelling a record filter and a late selection leave the active filter and its records unchanged', () => {
  const h = createPage();
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-30',
    records: [{ key: 'walking:1', type: 'walking', id: 1 }], view: 'stats' });
  h.page.openTypePicker();
  h.page.closeTypePicker();
  h.page.onTypeChange({ detail: { type: 'kindness' } });
  assert.equal(h.page.data.showTypePicker, false);
  assert.equal(h.page.data.type, 'walking');
  assert.equal(h.page.data.typeIndex, 2);
  assert.equal(h.page.data.selectedDate, '2026-10-30');
  assert.equal(h.page.data.view, 'stats');
  assert.deepEqual(plain(h.page.data.records), [{ key: 'walking:1', type: 'walking', id: 1 }]);
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
});

test('leaving the page closes its record filter and settings open the existing entry settings', () => {
  const h = createPage();
  h.page.openTypePicker();
  h.page.onHide();
  assert.equal(h.page.data.showTypePicker, false);
  h.page.openTypePicker();
  h.page.openPracticeSettings();
  assert.equal(h.page.data.showTypePicker, false);
  assert.deepEqual(plain(h.calls.navigation), [{ url: '/pages/practiceSettings/practiceSettings' }]);
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
});

test('only account and binding failures direct the user to the profile tab', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'BINDING_INVALID', 'IDENTITY_MISMATCH']) {
    const originalMessage = `请核对学号绑定：${code}`;
    const h = createPage({
      feed: () => { throw failure(code, originalMessage); },
      summary: () => { throw failure(code, originalMessage); }
    });
    await h.page.refresh();
    for (const value of [h.page.data.feedFailure, h.page.data.summaryFailure]) {
      assert.ok(value, code);
      assert.equal(value.requiresBinding, true, code);
      assert.equal(value.actionText, '前往「我」', code);
      assert.equal(typeof value.title, 'string', code);
      assert.ok(value.title.length, code);
      assert.equal(typeof value.message, 'string', code);
      assert.ok(value.message.length, code);
    }
    assert.equal(h.page.data.error, originalMessage);
    assert.equal(h.page.data.summaryError, originalMessage);
  }
});

test('service availability errors do not tell an already bound user that their login expired', async () => {
  for (const code of ['AUTH_UNAVAILABLE', 'API_UNAVAILABLE']) {
    const h = createPage({
      feed: () => { throw failure(code, '未登录或登录已过期'); },
      summary: () => { throw failure(code, '未登录或登录已过期'); }
    });
    await h.page.refresh();
    for (const value of [h.page.data.feedFailure, h.page.data.summaryFailure]) {
      assert.ok(value, code);
      assert.equal(value.title, '功课服务暂未就绪', code);
      assert.equal(value.requiresBinding, false, code);
      assert.equal(value.actionText, '重新加载', code);
      assert.equal(typeof value.message, 'string', code);
      assert.ok(value.message.length, code);
      assert.doesNotMatch(value.message, /未登录|登录已过期|重新授权/, code);
    }
    assert.equal(typeof h.page.data.error, 'string');
    assert.equal(typeof h.page.data.summaryError, 'string');
  }
});

test('network and other read failures retain their specific message and offer reload', async () => {
  for (const [code, originalMessage] of [
    ['NETWORK_ERROR', '网络已断开，请连接网络后重试'],
    ['REQUEST_TIMEOUT', '功课请求超时，请稍后重试'],
    ['HTTP_503', '服务维护中，请稍后重试']
  ]) {
    const h = createPage({
      feed: () => { throw failure(code, originalMessage); },
      summary: () => { throw failure(code, originalMessage); }
    });
    await h.page.refresh();
    for (const value of [h.page.data.feedFailure, h.page.data.summaryFailure]) {
      assert.ok(value, code);
      assert.equal(value.title, '暂时无法读取', code);
      assert.equal(value.message, originalMessage, code);
      assert.equal(value.requiresBinding, false, code);
      assert.equal(value.actionText, '重新加载', code);
    }
    assert.equal(h.page.data.error, originalMessage);
    assert.equal(h.page.data.summaryError, originalMessage);
  }
});

test('read failure actions use the selected scope to open binding or reload both reads', async () => {
  for (const scope of ['feed', 'summary']) {
    for (const requiresBinding of [true, false]) {
      const h = createPage();
      h.page.setData({
        feedFailure: { requiresBinding: scope === 'feed' ? requiresBinding : !requiresBinding },
        summaryFailure: { requiresBinding: scope === 'summary' ? requiresBinding : !requiresBinding }
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

test('a failed feed does not hide successful statistics and a failed summary does not discard successful records', async () => {
  let feedFails = true, summaryFails = false;
  const h = createPage({
    feed: () => {
      if (feedFails) throw failure('NETWORK_ERROR', '明细读取失败');
      return { records: [{ id: 1, type: 'walking', recordDate: '2026-10-30', durationMinutes: 12 }] };
    },
    summary: () => {
      if (summaryFails) throw failure('REQUEST_TIMEOUT', '统计请求超时');
      return { totals: [], recordCount: 7, practiceDays: 3, allTime: { totals: [] } };
    }
  });
  await h.page.refresh();
  assert.equal(h.page.data.feedFailure.message, '明细读取失败');
  assert.equal(h.page.data.summaryFailure, null);
  assert.equal(h.page.data.summaryError, '');
  assert.equal(h.page.data.recordCount, 7);
  feedFails = false;
  summaryFails = true;
  await h.page.refresh();
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.error, '');
  assert.equal(h.page.data.records.length, 1);
  assert.equal(h.page.data.records[0].id, 1);
  assert.equal(h.page.data.summaryFailure.message, '统计请求超时');
});

test('a successful individual read clears only its own prior failure', async () => {
  let feedFails = true, summaryFails = true;
  const h = createPage({
    feed: () => { if (feedFails) throw failure('NETWORK_ERROR', '明细网络异常'); return { records: [] }; },
    summary: () => { if (summaryFails) throw failure('REQUEST_TIMEOUT', '统计请求超时'); return { totals: [] }; }
  });
  await h.page.refresh();
  const summaryFailure = plain(h.page.data.summaryFailure);
  feedFails = false;
  await h.page.loadFeed(h.page._generation);
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.error, '');
  assert.deepEqual(plain(h.page.data.summaryFailure), summaryFailure);
  assert.equal(h.page.data.summaryError, '统计请求超时');
  summaryFails = false;
  await h.page.loadSummary(h.page._generation);
  assert.equal(h.page.data.summaryFailure, null);
  assert.equal(h.page.data.summaryError, '');
});

test('refresh clears both prior failures immediately while replacement reads are pending', async () => {
  const feedResponse = deferred(), summaryResponse = deferred();
  let retrying = false;
  const h = createPage({
    feed: () => { if (!retrying) throw failure('NETWORK_ERROR', '旧明细错误'); return feedResponse.promise; },
    summary: () => { if (!retrying) throw failure('REQUEST_TIMEOUT', '旧统计错误'); return summaryResponse.promise; }
  });
  await h.page.refresh();
  assert.ok(h.page.data.feedFailure);
  assert.ok(h.page.data.summaryFailure);
  retrying = true;
  const refreshing = h.page.refresh();
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.summaryFailure, null);
  assert.equal(h.page.data.error, '');
  assert.equal(h.page.data.summaryError, '');
  assert.equal(h.page.data.loading, true);
  assert.equal(h.page.data.summaryLoading, true);
  feedResponse.resolve({ records: [] });
  summaryResponse.resolve({ totals: [] });
  await refreshing;
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.summaryFailure, null);
});

test('an account change clears previous failures even when requests are disabled', () => {
  const h = createPage({ enabled: false });
  h.page.onShow();
  const previousFailure = { title: '暂时无法读取', message: '旧账号的错误', requiresBinding: false, actionText: '重新加载' };
  h.page.setData({ feedFailure: previousFailure, summaryFailure: previousFailure,
    error: previousFailure.message, summaryError: previousFailure.message });
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  h.page.onShow();
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.summaryFailure, null);
  assert.equal(h.page.data.error, '');
  assert.equal(h.page.data.summaryError, '');
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
  h.page.onHide();
});

test('late read failures from a previous owner cannot overwrite the new owner state', async () => {
  const feedResponse = deferred(), summaryResponse = deferred();
  const h = createPage({ feed: () => feedResponse.promise, summary: () => summaryResponse.promise });
  const refreshing = h.page.refresh();
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  feedResponse.reject(failure('AUTH_REQUIRED', '旧账号需要重新绑定'));
  summaryResponse.reject(failure('NETWORK_ERROR', '旧账号统计失败'));
  await refreshing;
  assert.equal(h.page.data.feedFailure, null);
  assert.equal(h.page.data.summaryFailure, null);
  assert.equal(h.page.data.error, '');
  assert.equal(h.page.data.summaryError, '');
});

test('records use a single server feed cursor and whole-range summary instead of combining per-type pages', async () => {
  const h = createPage({
    feed: params => params.cursor ? { records: [
      { id: 2, type: 'instant', recordDate: '2026-10-30', count: 3, occurredAt: '2026-10-30 14:00:00' },
      { id: 3, type: 'kindness', recordDate: '2026-10-30', quantity: 4, content: '扶助邻里', occurredAt: '2026-10-30 12:00:00' }
    ] } : { records: [
      { id: 1, type: 'walking', recordDate: '2026-10-31', durationMinutes: 12, occurredAt: '2026-10-31 00:15:00' },
      { id: 2, type: 'instant', recordDate: '2026-10-30', count: 3, occurredAt: '2026-10-30 14:00:00' }
    ], nextCursor: 'stable-cursor-1' },
    summary: () => ({ recordCount: 55, practiceDays: 20,
      totals: [{ type: 'walking', recordCount: 30, totalValue: 150, unit: '分钟' }, { type: 'kindness', recordCount: 3, totalValue: 7, unit: '件' }],
      daily: [], allTime: { recordCount: 100, practiceDays: 40, totals: [{ type: 'instant', totalValue: 90, recordCount: 12 }] } })
  });
  await h.page.refresh();
  assert.equal(h.page.data.recordCount, 55);
  assert.equal(h.page.data.practiceDays, 20);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'walking').value, 150);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'walking').records, 30);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'kindness').value, 7);
  assert.equal(h.page.data.monthCards.find(item => item.type === 'kindness').records, 3);
  assert.equal(h.page.data.allTimeRecordCount, 100);
  assert.equal(h.page.data.allTimeCards.find(item => item.type === 'instant').value, 90);
  assert.equal(h.page.data.allTimeCards.find(item => item.type === 'instant').records, 12);
  await h.page.loadMore();
  assert.equal(h.page.data.records.length, 3);
  assert.equal(h.page.data.records[2].quantity, 4);
  assert.equal(h.page.data.groups.length, 1);
  assert.equal(h.page.data.groups[0].date, '2026-10-30', 'the 00:15 record belongs to the previous day');
  assert.deepEqual(h.calls.feed, [{ dayStartHour: 2, month: '2026-10', type: 'all' }, { dayStartHour: 2, month: '2026-10', type: 'all', cursor: 'stable-cursor-1' }]);
  assert.equal(h.page.data.recordCount, 55);
});

test('type calendar shows server daily quantities and a selected day requests the matching feed', async () => {
  const h = createPage({ summary: () => ({ totals: [{ type: 'walking', totalValue: 30 }], recordCount: 2, practiceDays: 1,
    daily: [{ date: '2026-10-30', recordCount: 2, totals: [{ type: 'walking', totalValue: 30 }] }], allTime: { totals: [] } }) });
  h.page.setData({ type: 'walking', typeIndex: 2 });
  await h.page.refresh();
  const day = h.page.data.calendar.flat().find(item => item.date === '2026-10-30');
  assert.equal(day.value, 30);
  assert.equal(day.valueLabel, '30');
  assert.equal(day.active, true);
  assert.equal(h.page.data.trend.length, 31);
  assert.equal(h.page.data.trendMax, 30);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-30').value, 30);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-30').height, 130);
  assert.equal(h.page.data.trend.find(item => item.date === '2026-10-01').value, 0);
  h.page.selectDay(day.date);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.view, 'detail');
  assert.deepEqual(h.calls.feed.at(-1), { dayStartHour: 2, month: '2026-10', type: 'walking', date: '2026-10-30' });
  h.page.onMonthChange({ detail: { value: '2026-11' } });
  assert.equal(h.page.data.month, '2026-10');
});

test('month labels use the selected calendar month and reject future months without requesting data', async () => {
  const h = createPage();
  assert.equal(h.page.data.monthLabel, '2026年10月');
  h.page.onMonthChange({ detail: { value: '2026-09' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.month, '2026-09');
  assert.equal(h.page.data.monthLabel, '2026年9月');
  assert.equal(h.calls.feed.at(-1).month, '2026-09');
  assert.equal(h.calls.summary.at(-1).month, '2026-09');
  const requestCounts = { feed: h.calls.feed.length, summary: h.calls.summary.length };
  h.page.onMonthChange({ detail: { value: '2026-11' } });
  assert.equal(h.page.data.month, '2026-09');
  assert.equal(h.page.data.monthLabel, '2026年9月');
  assert.equal(h.calls.feed.length, requestCounts.feed);
  assert.equal(h.calls.summary.length, requestCounts.summary);
});

test('monthly and cumulative statistics use each practice quantity while the all-practice calendar counts records', async () => {
  const totals = [
    { type: 'sitting', totalValue: 91, recordCount: 3 },
    { type: 'walking', durationMinutes: 42, recordCount: 4 },
    { type: 'instant', count: 17, recordCount: 5 },
    { type: 'learning', totalDurationMinutes: 63, recordCount: 6 },
    { type: 'kindness', deedCount: 8, recordCount: 7 },
    { type: 'clapping', total: 29, recordCount: 8 }
  ];
  const expectations = [
    [0, 'all', 33, '条'], [1, 'sitting', 91, '分钟'], [2, 'walking', 42, '分钟'],
    [3, 'instant', 17, '次'], [4, 'learning', 63, '分钟'], [5, 'kindness', 8, '次'], [6, 'clapping', 29, '分钟']
  ];
  const allTimeTotals = expectations.slice(1).map(([, type, value]) => ({ type, totalValue: value * 10, recordCount: 40 }));
  const h = createPage({ summary: () => ({ recordCount: 33, totals,
    daily: [{ date: '2026-10-30', recordCount: 33, totals }],
    allTime: { recordCount: 240, totals: allTimeTotals } }) });
  for (const [typeIndex, type, expected, unit] of expectations) {
    h.page.setData({ typeIndex, type });
    await h.page.refresh();
    assert.equal(h.page.data.selectedMonthTotal, expected, type);
    assert.equal(h.page.data.selectedMonthUnit, unit, type);
    const day = h.page.data.calendar.flat().find(item => item.date === '2026-10-30');
    assert.equal(day.value, expected, type);
    assert.equal(day.valueLabel, String(expected), type);
    if (type !== 'all') {
      assert.equal(h.page.data.selectedMonthTotal, h.page.data.monthCards.find(item => item.type === type).value, type);
      assert.equal(h.page.data.overviewUnit, unit, type);
      assert.equal(h.page.data.overviewLabel, unit === '次' ? '累计次数' : '累计时间', type);
    }
    for (const [, practiceType, monthValue, practiceUnit] of expectations.slice(1)) {
      const card = h.page.data.allTimeCards.find(item => item.type === practiceType);
      assert.equal(card.monthValue, monthValue, `${type}: ${practiceType} monthly quantity`);
      assert.equal(card.value, monthValue * 10, `${type}: ${practiceType} cumulative quantity`);
      assert.equal(card.unit, practiceUnit, `${type}: ${practiceType} unit`);
      assert.notEqual(card.value, card.records, `${type}: ${practiceType} quantity differs from record count`);
    }
  }
});

test('day statistics request complete all-practice totals independently of list filters and pagination', async () => {
  const h = createPage({ hiddenTypes: ['kindness'],
    feed: () => ({ records: [
      { id: 6, type: 'walking', recordDate: '2026-10-30', durationMinutes: 2 }
    ], nextCursor: 'more-for-the-same-day' }),
    summary: params => params.date ? { recordCount: 19, totals: [
      { type: 'sitting', totalValue: 91, recordCount: 3 },
      { type: 'walking', totalValue: 42, recordCount: 4 },
      { type: 'instant', totalValue: 17, recordCount: 5 },
      { type: 'learning', totalValue: 63, recordCount: 2 },
      { type: 'kindness', totalValue: 8, recordCount: 1 },
      { type: 'clapping', totalValue: 29, recordCount: 4 }
    ] } : { recordCount: 4, totals: [{ type: 'walking', totalValue: 42, recordCount: 4 }], daily: [], allTime: { totals: [] } }
  });
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-30' });
  await h.page.refresh();
  const listBefore = plain({ records: h.page.data.records, groups: h.page.data.groups,
    nextCursor: h.page.data.nextCursor, summary: h.page.data.summary, monthCards: h.page.data.monthCards });
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.deepEqual(h.calls.summary.at(-1), { dayStartHour: 2, month: '2026-10', type: 'all', date: '2026-10-30' });
  assert.equal(h.calls.feed.length, 1);
  assert.equal(h.page.data.dayStatsDate, '2026-10-30');
  assert.equal(h.page.data.dayStatsLoading, false);
  assert.equal(h.page.data.dayStatsRecordCount, 18);
  assert.equal(h.page.data.dayStatsPracticeCount, 5);
  assert.deepEqual(plain(h.page.data.dayStatsCards.map(({ type, value, unit, records }) => ({ type, value, unit, records }))), [
    { type: 'sitting', value: 91, unit: '分钟', records: 3 },
    { type: 'walking', value: 42, unit: '分钟', records: 4 },
    { type: 'instant', value: 17, unit: '次', records: 5 },
    { type: 'learning', value: 63, unit: '分钟', records: 2 },
    { type: 'clapping', value: 29, unit: '分钟', records: 4 }
  ]);
  assert.equal(h.page.data.typeOptions.some(item => item.type === 'kindness'), false);
  assert.deepEqual(plain({ records: h.page.data.records, groups: h.page.data.groups,
    nextCursor: h.page.data.nextCursor, summary: h.page.data.summary, monthCards: h.page.data.monthCards }), listBefore);
  assert.equal(h.page.data.type, 'walking');
  assert.equal(h.page.data.selectedDate, '2026-10-30');
  assert.equal(h.page.data.view, 'detail');
});

test('day statistics omit hidden practices and count only visible completed practices and records', async () => {
  const h = createPage({ hiddenTypes: ['sitting', 'walking', 'kindness'], summary: () => ({ recordCount: 99, totals: [
    { type: 'sitting', totalValue: 30, recordCount: 3 },
    { type: 'walking', totalValue: 0, recordCount: 5 },
    { type: 'instant', totalValue: 7, recordCount: 0 },
    { type: 'learning', totalValue: 0, recordCount: 2 },
    { type: 'kindness', totalValue: 4, recordCount: 4 }
  ] }) });
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.deepEqual(plain(h.page.data.dayStatsCards.map(({ type, value, records }) => ({ type, value, records }))), [
    { type: 'instant', value: 7, records: 0 },
    { type: 'learning', value: 0, records: 2 },
    { type: 'clapping', value: 0, records: 0 }
  ]);
  assert.equal(h.page.data.dayStatsRecordCount, 2);
  assert.equal(h.page.data.dayStatsPracticeCount, 2);
});

test('day statistics reread hidden and restored practices when reopening the same date', async () => {
  const h = createPage({ summary: () => ({ recordCount: 6, totals: [
    { type: 'walking', totalValue: 20, recordCount: 2 },
    { type: 'kindness', totalValue: 4, recordCount: 4 }
  ] }) });
  const event = { currentTarget: { dataset: { date: '2026-10-30' } } };
  await h.page.openDayStats(event);
  assert.equal(h.page.data.dayStatsCards.length, 6);
  assert.equal(h.page.data.dayStatsRecordCount, 6);
  assert.equal(h.page.data.dayStatsPracticeCount, 2);
  h.page.closeDayStats();
  h.preferences.saveHiddenTypes(['walking', 'kindness']);
  await h.page.openDayStats(event);
  assert.deepEqual(plain(h.page.data.dayStatsCards.map(item => item.type)), ['sitting', 'instant', 'learning', 'clapping']);
  assert.equal(h.page.data.dayStatsRecordCount, 0);
  assert.equal(h.page.data.dayStatsPracticeCount, 0);
  h.page.closeDayStats();
  h.preferences.saveHiddenTypes([]);
  await h.page.openDayStats(event);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'walking').value, 20);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'kindness').value, 4);
  assert.equal(h.page.data.dayStatsRecordCount, 6);
  assert.equal(h.page.data.dayStatsPracticeCount, 2);
  assert.equal(h.calls.summary.length, 3);
});

test('day statistics apply the latest visibility preferences when the request completes', async () => {
  for (const restored of [false, true]) {
    const response = deferred();
    const h = createPage({ hiddenTypes: restored ? ['walking'] : [], summary: () => response.promise });
    const opening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
    h.preferences.saveHiddenTypes(restored ? [] : ['walking']);
    response.resolve({ recordCount: 3, totals: [{ type: 'walking', totalValue: 30, recordCount: 3 }] });
    await opening;
    assert.equal(h.page.data.dayStatsCards.some(item => item.type === 'walking'), restored);
    assert.equal(h.page.data.dayStatsRecordCount, restored ? 3 : 0);
    assert.equal(h.page.data.dayStatsPracticeCount, restored ? 1 : 0);
  }
});

test('day statistics are empty with zero counts when every practice is hidden', async () => {
  const h = createPage({ hiddenTypes: ['sitting', 'walking', 'instant', 'learning', 'kindness', 'clapping'],
    summary: () => ({ recordCount: 8, totals: [
      { type: 'walking', totalValue: 30, recordCount: 3 },
      { type: 'kindness', totalValue: 5, recordCount: 5 }
    ] }) });
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.equal(h.page.data.dayStatsLoading, false);
  assert.equal(h.page.data.dayStatsError, '');
  assert.deepEqual(plain(h.page.data.dayStatsCards), []);
  assert.equal(h.page.data.dayStatsRecordCount, 0);
  assert.equal(h.page.data.dayStatsPracticeCount, 0);
});

test('day statistics use each account visibility settings without overwriting another account preferences', async () => {
  const originalOwner = { openid: 'oz-owner', studentNumber: '001', bindingVersion: 'v1' };
  const otherOwner = { openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' };
  const h = createPage({ hiddenTypes: ['walking'], summary: () => ({ recordCount: 6, totals: [
    { type: 'walking', totalValue: 20, recordCount: 2 },
    { type: 'kindness', totalValue: 4, recordCount: 4 }
  ] }) });
  const event = { currentTarget: { dataset: { date: '2026-10-30' } } };
  await h.page.openDayStats(event);
  assert.equal(h.page.data.dayStatsCards.some(item => item.type === 'walking'), false);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'kindness').value, 4);
  assert.equal(h.page.data.dayStatsRecordCount, 4);
  h.page.closeDayStats();
  h.changeOwner(otherOwner);
  h.preferences.saveHiddenTypes(['kindness']);
  await h.page.openDayStats(event);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'walking').value, 20);
  assert.equal(h.page.data.dayStatsCards.some(item => item.type === 'kindness'), false);
  assert.equal(h.page.data.dayStatsRecordCount, 2);
  h.page.closeDayStats();
  h.changeOwner(originalOwner);
  await h.page.openDayStats(event);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['walking']);
  assert.equal(h.page.data.dayStatsCards.some(item => item.type === 'walking'), false);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'kindness').value, 4);
  assert.equal(h.page.data.dayStatsRecordCount, 4);
  h.page.closeDayStats();
  h.changeOwner(otherOwner);
  assert.deepEqual(plain(h.preferences.getHiddenTypes()), ['kindness']);
});

test('day statistics zero-fill missing practices and count practices by completed quantity or record count', async () => {
  const h = createPage({ summary: () => ({ recordCount: 1, totals: [
    { type: 'walking', totalValue: 0, recordCount: 1 },
    { type: 'instant', totalValue: 8, recordCount: 0 }
  ] }) });
  assert.equal(h.page.data.groups.length, 0);
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.equal(h.page.data.dayStatsCards.length, 6);
  assert.equal(h.page.data.dayStatsPracticeCount, 2);
  assert.equal(h.page.data.dayStatsRecordCount, 1);
  for (const type of ['sitting', 'learning', 'kindness', 'clapping']) {
    const card = h.page.data.dayStatsCards.find(item => item.type === type);
    assert.equal(card.value, 0, type);
    assert.equal(card.records, 0, type);
  }
  h.page.closeDayStats();
  assert.equal(h.page.data.dayStatsDate, '');
  assert.equal(h.page.data.dayStatsLoading, false);
  assert.deepEqual(plain(h.page.data.dayStatsCards), []);
});

test('day statistics load independently, expose read failures and retry fresh data without reloading the list', async () => {
  const response = deferred();
  let request = 0;
  const h = createPage({ summary: () => {
    request++;
    if (request === 1) return response.promise;
    return { recordCount: 1, totals: [{ type: 'walking', totalValue: request * 10, recordCount: 1 }] };
  } });
  const monthlySummary = { totals: [{ type: 'walking', totalValue: 90 }] };
  h.page.setData({ summary: monthlySummary, summaryError: '原月统计错误', error: '原明细错误' });
  const opening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.equal(h.page.data.dayStatsDate, '2026-10-30');
  assert.equal(h.page.data.dayStatsLoading, true);
  response.reject(failure('NETWORK_ERROR', '当日统计网络异常'));
  await opening;
  assert.equal(h.page.data.dayStatsLoading, false);
  assert.equal(h.page.data.dayStatsError, '当日统计网络异常');
  assert.equal(h.page.data.dayStatsFailure.message, '当日统计网络异常');
  assert.equal(h.page.data.dayStatsFailure.requiresBinding, false);
  await h.page.retryDayStats();
  assert.equal(h.page.data.dayStatsError, '');
  assert.equal(h.page.data.dayStatsFailure, null);
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'walking').value, 20);
  h.page.closeDayStats();
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'walking').value, 30);
  assert.deepEqual(h.calls.summary, Array(3).fill({ dayStartHour: 2, month: '2026-10', type: 'all', date: '2026-10-30' }));
  assert.equal(h.calls.feed.length, 0);
  assert.deepEqual(plain(h.page.data.summary), monthlySummary);
  assert.equal(h.page.data.summaryError, '原月统计错误');
  assert.equal(h.page.data.error, '原明细错误');
});

test('day statistics binding failures offer the existing account entry and service failures remain retryable', async () => {
  for (const [code, requiresBinding] of [['AUTH_REQUIRED', true], ['API_UNAVAILABLE', false]]) {
    const h = createPage({ summary: () => { throw failure(code, '读取失败'); } });
    await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
    assert.equal(h.page.data.dayStatsFailure.requiresBinding, requiresBinding, code);
    await h.page.retryDayStats();
    assert.equal(h.calls.summary.length, requiresBinding ? 1 : 2, code);
    assert.deepEqual(plain(h.calls.switchTab), requiresBinding ? [{ url: '/pages/me/me' }] : [], code);
  }
});

test('day statistics reject invalid, impossible, future or out-of-month dates and disabled entry', async () => {
  const h = createPage({ now: '2026-10-30T23:59:00+08:00' });
  for (const date of ['', undefined, null, 20261030, {}, '2026-10-00', '2026-10-32', '2026-10-31',
    '2026-09-30', '2026-11-01', '2026-10-3', '2026-10-30T00:00:00']) {
    await h.page.openDayStats({ currentTarget: { dataset: { date } } });
    assert.equal(h.page.data.dayStatsDate, '', String(date));
  }
  h.page.setData({ month: '2026-02' });
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2026-02-30' } } });
  h.page.setData({ month: '2025-02' });
  await h.page.openDayStats({ currentTarget: { dataset: { date: '2025-02-29' } } });
  assert.equal(h.calls.summary.length, 0);
  const disabled = createPage({ enabled: false });
  await disabled.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.equal(disabled.calls.summary.length, 0);
  assert.equal(disabled.page.data.dayStatsDate, '');
});

test('late day statistics success or failure cannot overwrite a newer date', async () => {
  for (const lateFailure of [false, true]) {
    const first = deferred(), second = deferred();
    const h = createPage({ summary: params => params.date === '2026-10-29' ? first.promise : second.promise });
    const oldOpening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-29' } } });
    const newOpening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
    second.resolve({ recordCount: 2, totals: [{ type: 'walking', totalValue: 30, recordCount: 2 }] });
    await newOpening;
    const current = plain(h.page.data);
    if (lateFailure) first.reject(failure('AUTH_REQUIRED', '迟到的旧日期错误'));
    else first.resolve({ recordCount: 99, totals: [{ type: 'walking', totalValue: 999, recordCount: 99 }] });
    await oldOpening;
    assert.deepEqual(plain(h.page.data), current, lateFailure ? 'late failure' : 'late success');
    assert.equal(h.page.data.dayStatsDate, '2026-10-30');
  }
});

test('closing and reopening the same day invalidates the previous statistics request', async () => {
  const first = deferred(), second = deferred();
  let request = 0;
  const h = createPage({ summary: () => ++request === 1 ? first.promise : second.promise });
  const oldOpening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  h.page.closeDayStats();
  const newOpening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
  first.resolve({ recordCount: 99, totals: [{ type: 'walking', totalValue: 999 }] });
  await oldOpening;
  assert.equal(h.page.data.dayStatsLoading, true);
  assert.deepEqual(plain(h.page.data.dayStatsCards), []);
  second.resolve({ recordCount: 1, totals: [{ type: 'walking', totalValue: 10, recordCount: 1 }] });
  await newOpening;
  assert.equal(h.page.data.dayStatsCards.find(item => item.type === 'walking').value, 10);
});

test('closing, refreshing or hiding the page clears day statistics and ignores late request results', async () => {
  for (const action of ['closeDayStats', 'refresh', 'onHide', 'onUnload']) {
    for (const lateFailure of [false, true]) {
      const response = deferred();
      const h = createPage({ summary: params => params.date ? response.promise : { totals: [], daily: [], allTime: { totals: [] } } });
      const opening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
      await h.page[action]();
      assert.equal(h.page.data.dayStatsDate, '', action);
      assert.equal(h.page.data.dayStatsLoading, false, action);
      const closed = plain(h.page.data);
      if (lateFailure) response.reject(failure('NETWORK_ERROR', '迟到的统计错误'));
      else response.resolve({ recordCount: 99, totals: [{ type: 'walking', totalValue: 999 }] });
      await opening;
      assert.deepEqual(plain(h.page.data), closed, `${action}: ${lateFailure ? 'late failure' : 'late success'}`);
    }
  }
});

test('day statistics from a previous account or page generation cannot update the current state', async () => {
  for (const change of ['owner', 'generation']) {
    for (const lateFailure of [false, true]) {
      const response = deferred();
      const h = createPage({ summary: () => response.promise });
      const opening = h.page.openDayStats({ currentTarget: { dataset: { date: '2026-10-30' } } });
      if (change === 'owner') h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
      else h.page._generation = (h.page._generation || 0) + 1;
      const current = plain(h.page.data);
      if (lateFailure) response.reject(failure('AUTH_REQUIRED', '旧账号统计错误'));
      else response.resolve({ recordCount: 99, totals: [{ type: 'walking', totalValue: 999 }] });
      await opening;
      assert.deepEqual(plain(h.page.data), current, `${change}: ${lateFailure ? 'late failure' : 'late success'}`);
    }
  }
});

test('the all-practice calendar displays daily record counts without combining incompatible practice units', async () => {
  const h = createPage({ summary: () => ({ recordCount: 7, totals: [], daily: [
    { date: '2026-10-28', recordCount: 3, quantity: 500, total: 600,
      totals: [{ type: 'walking', totalValue: 30 }, { type: 'instant', totalValue: 70 }] },
    { date: '2026-10-29', recordCount: 4, totals: [{ type: 'kindness', totalValue: 25 }] },
    { date: '2026-10-30', recordCount: 0, quantity: 500, totals: [{ type: 'walking', totalValue: 99 }] }
  ], allTime: { totals: [] } }) });
  await h.page.refresh();
  for (const [date, expected] of [['2026-10-28', 3], ['2026-10-29', 4], ['2026-10-30', 0], ['2026-10-27', 0]]) {
    const day = h.page.data.calendar.flat().find(item => item.date === date);
    assert.equal(day.value, expected, date);
    assert.equal(day.valueLabel, String(expected), date);
    assert.equal(day.active, expected > 0, date);
  }
});

test('a practice calendar uses only its own aggregate values and record counts to mark active days', async () => {
  const h = createPage({ summary: () => ({ recordCount: 12, totals: [], daily: [
    { date: '2026-10-25', recordCount: 4, quantity: 300, total: 400,
      totals: [{ type: 'walking', totalValue: 12, recordCount: 1 }, { type: 'instant', totalValue: 80, recordCount: 3 }] },
    { date: '2026-10-26', recordCount: 5, quantity: 300,
      totals: [{ type: 'instant', totalValue: 80, recordCount: 5 }] },
    { date: '2026-10-27', recordCount: 1,
      totals: [{ type: 'walking', totalValue: 0, recordCount: 1 }] },
    { date: '2026-10-28', recordCount: 2,
      totals: [{ type: 'walking', totalValue: 0, recordCount: 0 }, { type: 'kindness', totalValue: 2, recordCount: 2 }] }
  ], allTime: { totals: [] } }) });
  h.page.setData({ type: 'walking', typeIndex: 2 });
  await h.page.refresh();
  for (const [date, value, active] of [
    ['2026-10-25', 12, true], ['2026-10-26', 0, false],
    ['2026-10-27', 0, true], ['2026-10-28', 0, false], ['2026-10-29', 0, false]
  ]) {
    const day = h.page.data.calendar.flat().find(item => item.date === date);
    assert.equal(day.value, value, date);
    assert.equal(day.valueLabel, String(value), date);
    assert.equal(day.active, active, date);
  }
});

test('clearing the selected day reloads the full month feed for the current practice', async () => {
  const h = createPage({ feed: params => ({ records: params.date ? [] : [
    { id: 6, type: 'walking', recordDate: '2026-10-02', durationMinutes: 12 }
  ] }) });
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-30', view: 'detail' });
  await h.page.refresh();
  assert.deepEqual(h.calls.feed.at(-1), { dayStartHour: 2, month: '2026-10', type: 'walking', date: '2026-10-30' });
  const previousReads = h.calls.feed.length;
  h.page.clearDate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.selectedDate, '');
  assert.equal(h.page.data.view, 'detail');
  assert.equal(h.calls.feed.length, previousReads + 1);
  assert.deepEqual(h.calls.feed.at(-1), { dayStartHour: 2, month: '2026-10', type: 'walking' });
  assert.equal(h.page.data.records[0].recordDate, '2026-10-02');
});

test('calendar quantity labels retain small values and compact large daily totals', async () => {
  const h = createPage({ summary: () => ({ recordCount: 4, totals: [], daily: [
    { date: '2026-10-27', totals: [{ type: 'walking', totalValue: 12.5 }] },
    { date: '2026-10-28', totals: [{ type: 'walking', totalValue: 9999 }] },
    { date: '2026-10-29', totals: [{ type: 'walking', totalValue: 10000 }] },
    { date: '2026-10-30', totals: [{ type: 'walking', totalValue: 12345 }] }
  ], allTime: { totals: [] } }) });
  h.page.setData({ type: 'walking', typeIndex: 2 });
  await h.page.refresh();
  for (const [date, expected] of [
    ['2026-10-26', '0'], ['2026-10-27', '12.5'], ['2026-10-28', '9999'],
    ['2026-10-29', '1万'], ['2026-10-30', '1.2万'], ['2026-10-31', '0']
  ]) {
    assert.equal(h.page.data.calendar.flat().find(item => item.date === date).valueLabel, expected, date);
  }
});

test('statistics show monthly and cumulative quantities below the calendar and label calendar records as entries', () => {
  const page = historyTemplate();
  assert.doesNotMatch(page, /更多统计|showMoreStats|toggleMoreStats|more-stats-toggle|calendar-marker|calendar-title|calendar-total/);
  assert.match(page, /每日完成量趋势/);
  assert.match(page, /已上传功课累计/);
  assert.match(page, /calendar-day[\s\S]*?day\.day[\s\S]*?day\.valueLabel/);
  const amount = page.match(/<text\b[^>]*class="calendar-amount"[^>]*>[\s\S]*?<\/text>/);
  assert.ok(amount, 'calendar quantity is rendered below each date');
  assert.match(amount[0], /day\.valueLabel/);
  assert.match(amount[0], /\+/);
  assert.match(amount[0], /!day\.future/);
  assert.match(amount[0], /day\.value\s*>\s*0/);
  assert.match(amount[0], /type === 'all' \? '条' : ''/);
  assert.doesNotMatch(amount[0], /selectedMonthUnit|分钟|次|件|—/);
  assert.doesNotMatch(page, /practice-overview-card|本月记录件数|记录件数|item\.records/);
  assert.match(page, /wx:if="{{type !== 'all'}}" class="month-overview"/);
  const cumulative = page.slice(page.indexOf('已上传功课累计'));
  assert.match(cumulative, /class="metric-value">{{item\.value}}/);
  assert.match(cumulative, /class="metric-unit">{{item\.unit}}/);
  assert.match(cumulative, /wx:if="{{type === 'all'}}" class="metric-month">本月 {{item\.monthValue}} {{item\.unit}}/);
  assert.match(page, /本月最高 {{trendMax}} {{overviewUnit}}/);
  assert.match(page, /aria-label="{{[^"\n]*day\.value\s*\+\s*selectedMonthUnit/);
  assert.match(page, /day\.level/);
  assert.match(page, /周一[\s\S]*?周二[\s\S]*?周三[\s\S]*?周四[\s\S]*?周五[\s\S]*?周六[\s\S]*?周日/);
  assert.match(page, />少<[\s\S]*?>多</);
});

test('future dates and empty calendar cells preserve the active filter and do not request data', async () => {
  const h = createPage({ summary: () => ({ totals: [], daily: [
    { date: '2026-10-14', totals: [{ type: 'walking', totalValue: 10 }] },
    { date: '2026-10-15', totals: [{ type: 'walking', totalValue: 20 }] },
    { date: '2026-10-16', totals: [{ type: 'walking', totalValue: 1000 }] }
  ], allTime: { totals: [] } }) });
  h.advance(-16 * 24 * 60 * 60 * 1000);
  h.page.setData({ type: 'walking', typeIndex: 2, selectedDate: '2026-10-14', view: 'stats' });
  await h.page.refresh();
  const future = h.page.data.calendar.flat().find(item => item.date === '2026-10-16');
  const blank = h.page.data.calendar.flat().find(item => item.empty);
  assert.equal(future.future, true);
  assert.equal(future.level, 0);
  assert.equal(h.page.data.calendar.flat().find(item => item.date === '2026-10-14').level, 3);
  assert.equal(h.page.data.calendar.flat().find(item => item.date === '2026-10-15').level, 5);
  assert.equal(h.page.data.calendar.flat().find(item => item.date === '2026-10-13').level, 0);
  assert.ok(blank);
  const before = { selectedDate: h.page.data.selectedDate, view: h.page.data.view,
    feed: h.calls.feed.length, summary: h.calls.summary.length };
  for (const action of [
    () => h.page.selectCalendarDay({ currentTarget: { dataset: { date: future.date } } }),
    () => h.page.selectCalendarDay({ currentTarget: { dataset: { date: blank.date } } }),
    () => h.page.onDateChange({ detail: { value: '2026-10-16' } })
  ]) {
    action();
    assert.equal(h.page.data.selectedDate, before.selectedDate);
    assert.equal(h.page.data.view, before.view);
    assert.equal(h.calls.feed.length, before.feed);
    assert.equal(h.calls.summary.length, before.summary);
  }
});

test('practice confirmation saves once through rapid taps and late events, and a new form can save again', async () => {
  for (const type of ['walking', 'instant', 'learning', 'kindness', 'clapping']) {
    const upload = deferred();
    const h = createPage({ flush: async tasks => { await upload.promise; tasks.splice(0); } });
    const fill = () => type === 'kindness'
      ? h.page.onFormContent({ detail: { value: '帮助他人' } })
      : h.page.onFormValue({ detail: { value: '7' } });
    h.page.openForm(type);
    fill();
    const saving = h.page.saveForm();
    for (let tap = 0; tap < 5; tap++) await h.page.saveForm();
    assert.equal(h.calls.enqueue.length, 1, type);
    assert.equal(h.calls.flush.length, 1, type);
    assert.equal(h.page.data.formBusy, true, type);
    h.page.closeForm();
    assert.equal(h.page.data.showForm, true, type);
    upload.resolve();
    await saving;
    assert.equal(h.page.data.showForm, false, type);
    assert.equal(h.page.data.formBusy, false, type);
    assert.equal(h.calls.toast.length, 1, type);
    h.advance(2000);
    await h.page.saveForm();
    assert.equal(h.calls.flush.length, 1, `${type}: closed form must ignore delayed taps`);
    assert.equal(h.calls.toast.length, 1, type);
    h.page.openForm(type);
    fill();
    await h.page.saveForm();
    assert.equal(h.calls.enqueue.length, 2, type);
    assert.notEqual(h.calls.enqueue[0].requestId, h.calls.enqueue[1].requestId, type);
  }
});

test('cancelled practice forms cannot enqueue a record through a delayed confirmation', async () => {
  const h = createPage();
  h.page.openForm('walking');
  h.page.onFormValue({ detail: { value: '7' } });
  h.page.closeForm();
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 0);
  assert.equal(h.calls.flush.length, 0);
});

test('all five manual practices default to today and accept the earliest of the latest 14 Beijing calendar days', async () => {
  for (const type of ['walking', 'instant', 'learning', 'kindness', 'clapping']) {
    const h = createPage();
    h.page.openForm(type);
    assert.equal(h.page.data.formDate, '2026-10-31', type);
    assert.equal(h.page.data.formMinDate, '2026-10-18', type);
    assert.equal(h.page.data.today, '2026-10-31', type);
    h.page.onFormDate({ detail: { value: '2026-10-18' } });
    h.page.onFormTime({ detail: { value: '23:59' } });
    h.page.onFormReflection({ detail: { value: '两周内补录功课' } });
    if (type === 'kindness') h.page.onFormContent({ detail: { value: '帮助他人' } });
    else h.page.onFormValue({ detail: { value: '7' } });
    await h.page.saveForm();
    assert.equal(h.calls.enqueue.length, 1, type);
    assert.equal(h.calls.enqueue[0].operation, 'create', type);
    assert.deepEqual(h.calls.enqueue[0].payload, {
      recordDate: '2026-10-18', occurredAt: '2026-10-18 23:59:00', reflection: '两周内补录功课',
      ...(type === 'kindness' ? { content: '帮助他人' } : type === 'instant' ? { count: 7 } : { durationMinutes: 7 })
    }, type);
    assert.equal(h.page.data.showForm, false, type);
  }
  const wxml = dialogsTemplate();
  const datePicker = wxml.match(/<picker\b[^>]*bindchange="onFormDate"[^>]*>/);
  assert.ok(datePicker, 'the occurrence date has a picker');
  assert.match(datePicker[0], /start="{{formMinDate}}"/);
  assert.match(datePicker[0], /end="{{today}}"/);
});

test('all five manual practices reject one day outside the 14-day window and future dates before enqueueing', async () => {
  for (const type of ['walking', 'instant', 'learning', 'kindness', 'clapping']) {
    const h = createPage();
    h.page.openForm(type);
    if (type === 'kindness') h.page.onFormContent({ detail: { value: '帮助他人' } });
    else h.page.onFormValue({ detail: { value: '7' } });
    h.page.onFormDate({ detail: { value: '2026-10-17' } });
    await h.page.saveForm();
    assert.match(h.page.data.formError, /最近14天.*含今天/, type);
    h.page.onFormDate({ detail: { value: '2026-11-01' } });
    await h.page.saveForm();
    assert.match(h.page.data.formError, /北京时间/, type);
    assert.equal(h.calls.enqueue.length, 0, type);
    assert.equal(h.calls.flush.length, 0, type);
    assert.equal(h.page.data.showForm, true, type);
  }
});

test('the 14-day window follows Beijing calendar boundaries across months, years and leap days', async () => {
  for (const [today, earliest, expired] of [
    ['2026-11-01', '2026-10-19', '2026-10-18'],
    ['2027-01-01', '2026-12-19', '2026-12-18'],
    ['2028-03-01', '2028-02-17', '2028-02-16'],
    ['2027-03-01', '2027-02-16', '2027-02-15'],
    ['2028-03-13', '2028-02-29', '2028-02-28']
  ]) {
    const h = createPage({ now: `${today}T00:00:07+08:00` });
    h.page.openForm('walking');
    assert.equal(h.page.data.formDate, today, today);
    assert.equal(h.page.data.formMinDate, earliest, today);
    assert.equal(h.page.data.today, today, today);
    h.page.onFormValue({ detail: { value: '7' } });
    h.page.onFormDate({ detail: { value: expired } });
    h.page.onFormTime({ detail: { value: '23:59' } });
    await h.page.saveForm();
    assert.match(h.page.data.formError, /最近14天.*含今天/, today);
    assert.equal(h.calls.enqueue.length, 0, today);
    h.page.onFormDate({ detail: { value: earliest } });
    await h.page.saveForm();
    assert.equal(h.calls.enqueue.length, 1, today);
    assert.equal(h.calls.enqueue[0].payload.occurredAt, `${earliest} 23:59:00`, today);
  }
});

test('unqueued drafts expire at the next Beijing midnight while keeping every field for correction', async () => {
  for (const type of ['walking', 'instant', 'learning', 'kindness', 'clapping']) {
    const h = createPage({ now: '2026-10-31T23:59:37+08:00' });
    h.page.openForm(type);
    if (type === 'kindness') h.page.onFormContent({ detail: { value: '帮助他人' } });
    else h.page.onFormValue({ detail: { value: '7' } });
    h.page.onFormReflection({ detail: { value: '保留草稿感悟' } });
    h.page.onFormDate({ detail: { value: '2026-10-18' } });
    h.page.onFormTime({ detail: { value: '12:45' } });
    h.advance(24 * 1000);
    await h.page.saveForm();
    assert.match(h.page.data.formError, /最近14天.*含今天/, type);
    assert.equal(h.page.data.formMinDate, '2026-10-19', type);
    assert.equal(h.page.data.today, '2026-11-01', type);
    assert.equal(h.page.data.formDate, '2026-10-18', type);
    assert.equal(h.page.data.formTime, '12:45', type);
    assert.equal(h.page.data.formValue, type === 'kindness' ? '' : '7', type);
    assert.equal(h.page.data.formContent, type === 'kindness' ? '帮助他人' : '', type);
    assert.equal(h.page.data.formReflection, '保留草稿感悟', type);
    assert.equal(h.page.data.showForm, true, type);
    assert.equal(h.page.data.formPending, false, type);
    assert.equal(h.page.data.formBusy, false, type);
    assert.equal(h.calls.enqueue.length, 0, type);
    assert.equal(h.calls.flush.length, 0, type);
    h.page.onFormDate({ detail: { value: '2026-10-19' } });
    await h.page.saveForm();
    assert.equal(h.calls.enqueue[0].payload.occurredAt, '2026-10-19 12:45:00', type);
    assert.equal(h.calls.enqueue[0].payload.reflection, '保留草稿感悟', type);
  }
});

test('a failed local enqueue releases confirmation and retries with the original request identity', async () => {
  let attempts = 0;
  const h = createPage({ enqueue: (options, tasks, owner) => {
    if (++attempts === 1) throw failure('STORAGE_FAILED', '本机存储暂不可用');
    const task = { ...options, id: 'retry-task', owner: plain(owner), status: 'pending', attempts: 0 };
    tasks.push(task);
    return task;
  } });
  h.page.openForm('walking');
  h.page.onFormValue({ detail: { value: '7' } });
  await h.page.saveForm();
  assert.equal(h.page.data.formBusy, false);
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formError, '本机存储暂不可用');
  assert.equal(h.calls.flush.length, 0);
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 2);
  assert.equal(h.calls.enqueue[0].requestId, h.calls.enqueue[1].requestId);
  assert.equal(h.page.data.showForm, false);
});

test('queued practice keeps its Beijing date, original seconds and identity when retried after the 14-day window', async () => {
  let attempts = 0;
  const uploads = [];
  const h = createPage({ now: '2026-10-31T00:30:37+08:00', flush: tasks => {
    uploads.push(plain(tasks[0]));
    if (++attempts === 1) { tasks[0].lastError = { message: '网络中断' }; return { success: false }; }
    tasks.splice(0); return { success: true };
  } });
  h.page.openForm('walking');
  assert.equal(h.page.data.formDate, '2026-10-31');
  assert.equal(h.page.data.formTime, '00:30');
  h.page.onFormValue({ detail: { value: '15' } });
  h.page.onFormReflection({ detail: { value: '看见念头' } });
  h.advance(24 * 60 * 60 * 1000);
  await h.page.saveForm();
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formPending, true);
  assert.equal(h.page.data.formReflection, '看见念头');
  assert.equal(h.page.data.formError, '网络中断');
  assert.equal(h.calls.enqueue[0].payload.recordDate, '2026-10-31');
  assert.equal(h.calls.enqueue[0].payload.occurredAt, '2026-10-31 00:30:37');
  h.advance(14 * 24 * 60 * 60 * 1000);
  h.page.onFormDate({ detail: { value: '2026-11-15' } });
  h.page.onFormTime({ detail: { value: '12:00' } });
  h.page.onFormValue({ detail: { value: '20' } });
  assert.equal(h.page.data.formDate, '2026-10-31');
  assert.equal(h.page.data.formTime, '00:30');
  assert.equal(h.page.data.formValue, '15');
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.flush.length, 2);
  for (const key of ['id', 'requestId', 'owner', 'payload']) {
    assert.deepEqual(uploads[1][key], uploads[0][key], key);
  }
  assert.equal(h.page.data.showForm, false);
});

test('manual quantity and future or impossible Beijing times never enter the queue', async () => {
  const h = createPage({ now: '2026-10-31T00:30:37+08:00' });
  for (const type of ['walking', 'learning', 'clapping', 'instant']) {
    h.page.openForm(type);
    for (const value of ['0', '-1', '1.5', '01', type === 'instant' ? '1000001' : '1441']) {
      h.page.onFormValue({ detail: { value } });
      await h.page.saveForm();
      assert.ok(h.page.data.formError);
    }
  }
  h.page.openForm('walking');
  h.page.onFormValue({ detail: { value: '1' } });
  h.page.onFormTime({ detail: { value: '00:31' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /北京时间/);
  h.page.onFormDate({ detail: { value: '2026-02-30' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /北京时间/);
  assert.equal(h.calls.enqueue.length, 0);
});

test('editing kindness preserves its original deed quantity by excluding quantity from PATCH payload', async () => {
  const h = createPage();
  h.page.openForm('kindness', { id: 7, type: 'kindness', recordDate: '2026-10-30', occurredAt: '2026-10-30 20:15:24', quantity: 5, content: '原善行', reflection: '' });
  assert.equal(h.page.data.formValue, '5');
  h.page.onFormContent({ detail: { value: '更新善行内容' } });
  await h.page.saveForm();
  const submitted = h.calls.enqueue[0];
  assert.equal(submitted.operation, 'update');
  assert.equal(submitted.recordId, 7);
  assert.deepEqual(submitted.payload, { recordDate: '2026-10-30', occurredAt: '2026-10-30 20:15:24', reflection: '', content: '更新善行内容' });
});

test('editing older history has no lower date bound and preserves the original occurrence time', async () => {
  const h = createPage();
  h.page.openForm('walking', { id: 4, type: 'walking', recordDate: '2025-01-15',
    occurredAt: '2025-01-15 13:45:24', durationMinutes: 15 });
  assert.equal(h.page.data.formMinDate, '');
  h.page.onFormValue({ detail: { value: '20' } });
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].operation, 'update');
  assert.equal(h.calls.enqueue[0].recordId, 4);
  assert.deepEqual(h.calls.enqueue[0].payload, { recordDate: '2025-01-15',
    occurredAt: '2025-01-15 13:45:24', durationMinutes: 20, reflection: '' });
  h.page.openForm('walking');
  assert.equal(h.page.data.formMinDate, '2026-10-18');
});

test('date-only history does not invent a time and requires the user to select the real clock time', async () => {
  const h = createPage();
  h.page.openForm('walking', { id: 4, type: 'walking', recordDate: '2026-10-30', durationMinutes: 15 });
  assert.equal(h.page.data.formTime, '');
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 0);
  assert.match(h.page.data.formError, /真实发生时间/);
  h.page.onFormTime({ detail: { value: '13:45' } });
  await h.page.saveForm();
  assert.equal(h.calls.enqueue[0].payload.occurredAt, '2026-10-30 13:45:00');
});

test('record actions ignore taps and touch events on both practice screens', async () => {
  for (const screen of ['home', 'history']) {
    const h = createPage({ screen });
    h.page.setData({ records: [{ key: 'walking:7', id: 7, type: 'walking', canEdit: true, canDelete: true }] });
    h.page.showRecordActions();
    for (const type of ['tap', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'longtap', undefined]) {
      h.page.showRecordActions({ type, currentTarget: { dataset: { key: 'walking:7' } } });
    }
    assert.equal(h.calls.actionSheet, undefined, screen);
    assert.equal(h.page.data.detail, null, screen);
    assert.equal(h.page.data.showForm, false, screen);
    assert.equal(h.calls.modal.length, 0, screen);
    assert.equal(h.calls.enqueue.length, 0, screen);
  }
});

test('both record screens shorten reflection previews without losing the full detail text', async () => {
  const cases = [
    { reflection: '', expected: '' },
    { reflection: '  留意呼吸\n觉察脚步  ', expected: '留意呼吸 觉察脚步' },
    { reflection: '觉'.repeat(30), expected: '觉'.repeat(30) },
    { reflection: '觉'.repeat(31), expected: '觉'.repeat(30) + '…' },
    { reflection: '觉'.repeat(29) + '🌱继续练习', expected: '觉'.repeat(29) + '🌱…' },
    { reflection: '完整感悟', content: '善事内容', expected: '完整感悟' },
    { reflection: '  ', content: '善'.repeat(31), expected: '善'.repeat(30) + '…' }
  ];
  for (const screen of ['home', 'history']) {
    for (const { reflection, content, expected } of cases) {
      const record = { id: 7, type: content ? 'kindness' : 'walking', recordDate: '2026-10-30',
        durationMinutes: 18, reflection, ...(content ? { content } : {}) };
      const h = createPage({ screen, feed: () => ({ records: [record] }) });
      await h.page.refresh();
      assert.equal(h.page.data.records[0].preview, expected, screen);
      h.page.openDetail({ type: 'tap', currentTarget: { dataset: { key: `${record.type}:7` } } });
      assert.equal(h.page.data.detail.reflection, reflection, screen);
      assert.equal(h.page.data.detail.content, content, screen);
      assert.equal(h.calls.actionSheet, undefined, screen);
      assert.equal(h.page.data.showForm, false, screen);
    }
  }
});

test('long pressing a record can cancel its menu or open the populated editor without opening details', async () => {
  const record = { id: 7, type: 'walking', recordDate: '2026-10-30',
    occurredAt: '2026-10-30 13:45:24', durationMinutes: 18, reflection: '觉察脚步' };
  const h = createPage({ feed: () => ({ records: [record] }) });
  await h.page.refresh();
  const event = { type: 'longpress', currentTarget: { dataset: { key: 'walking:7' } } };
  h.page.showRecordActions(event);
  const cancelled = h.calls.actionSheet;
  assert.deepEqual(plain(cancelled.itemList), ['编辑功课', '删除记录']);
  assert.equal(h.page.data.detail, null);
  cancelled.complete({ errMsg: 'showActionSheet:fail cancel' });
  cancelled.success({ tapIndex: 0 });
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.calls.modal.length, 0);
  assert.equal(h.calls.enqueue.length, 0);

  h.page.showRecordActions(event);
  h.calls.actionSheet.success({ tapIndex: 0 });
  assert.equal(h.page.data.detail, null);
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formEditing, true);
  assert.equal(h.page.data.formRecordId, 7);
  assert.equal(h.page.data.formValue, '18');
  assert.equal(h.page.data.formReflection, '觉察脚步');
  assert.equal(h.page.data.formTime, '13:45');
  assert.equal(h.calls.enqueue.length, 0);
});

test('long press deletion skips details and only queues the selected record after confirmation', async () => {
  const h = createPage({ feed: () => ({ records: [{ id: 8, type: 'kindness',
    recordDate: '2026-10-30', occurredAt: '2026-10-30 12:00:00', content: '帮助他人', quantity: 2 }] }) });
  await h.page.refresh();
  const event = { type: 'longpress', currentTarget: { dataset: { key: 'kindness:8' } } };
  h.page.showRecordActions(event);
  h.calls.actionSheet.success({ tapIndex: 1 });
  assert.equal(h.page.data.detail, null);
  assert.equal(h.calls.modal.length, 1);
  assert.match(h.calls.modal[0].content, /做善事/);
  assert.equal(h.calls.enqueue.length, 0);
  h.calls.modal[0].success({ confirm: false });
  assert.equal(h.calls.enqueue.length, 0);

  h.page.showRecordActions(event);
  h.calls.actionSheet.success({ tapIndex: 1 });
  h.calls.modal[1].success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].operation, 'delete');
  assert.equal(h.calls.enqueue[0].type, 'kindness');
  assert.equal(h.calls.enqueue[0].recordId, 8);
  assert.equal(h.calls.flush[0].manual, true);
  assert.equal(h.page.data.deleting, false);
});

test('long press menus respect each available permission and read only records open details', async () => {
  for (const [canEdit, canDelete, expected] of [
    [true, false, ['编辑功课']], [false, true, ['删除记录']], [false, false, null]
  ]) {
    const h = createPage({ feed: () => ({ records: [{ id: 9, type: 'walking',
      recordDate: '2026-10-30', durationMinutes: 10, canEdit, canDelete }] }) });
    await h.page.refresh();
    h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'walking:9' } } });
    if (expected) {
      assert.deepEqual(plain(h.calls.actionSheet.itemList), expected);
      h.calls.actionSheet.success({ tapIndex: 0 });
      assert.equal(h.page.data.showForm, canEdit);
      assert.equal(h.calls.modal.length, canDelete ? 1 : 0);
      assert.equal(h.page.data.detail, null);
    } else {
      assert.equal(h.calls.actionSheet, undefined);
      assert.equal(h.page.data.detail.id, 9);
      assert.equal(h.page.data.showForm, false);
      assert.equal(h.calls.modal.length, 0);
    }
    assert.equal(h.calls.enqueue.length, 0);
  }
});

test('long press callbacks cannot edit or delete after the account or binding changes', async () => {
  for (const tapIndex of [0, 1]) {
    const h = createPage({ feed: () => ({ records: [{ id: 10, type: 'walking',
      recordDate: '2026-10-30', durationMinutes: 10 }] }) });
    await h.page.refresh();
    h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'walking:10' } } });
    h.changeOwner({ openid: 'oz-new', studentNumber: '002', bindingVersion: 'v2' });
    h.calls.actionSheet.success({ tapIndex });
    assert.equal(h.page.data.showForm, false);
    assert.equal(h.page.data.detail, null);
    assert.equal(h.calls.modal.length, 0);
    assert.equal(h.calls.enqueue.length, 0);
  }
});

test('long press callbacks stop when the record disappears, loses permission or the page hides', async () => {
  for (const invalidation of ['removed', 'permission', 'hidden']) {
    for (const tapIndex of [0, 1]) {
      const h = createPage({ feed: () => ({ records: [{ id: 11, type: 'walking',
        recordDate: '2026-10-30', durationMinutes: 10 }] }) });
      await h.page.refresh();
      h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'walking:11' } } });
      if (invalidation === 'removed') h.page.setData({ records: [] });
      else if (invalidation === 'permission') {
        h.page.setData({ records: h.page.data.records.map(record => ({ ...record, canEdit: false, canDelete: false })) });
      } else h.page.onHide();
      h.calls.actionSheet.success({ tapIndex });
      assert.equal(h.page.data.showForm, false, `${invalidation}: ${tapIndex}`);
      assert.equal(h.page.data.detail, null, `${invalidation}: ${tapIndex}`);
      assert.equal(h.calls.modal.length, 0, `${invalidation}: ${tapIndex}`);
      assert.equal(h.calls.enqueue.length, 0, `${invalidation}: ${tapIndex}`);
    }
  }
});

test('opening another record menu invalidates an earlier menu callback', async () => {
  const h = createPage({ feed: () => ({ records: [
    { id: 12, type: 'walking', recordDate: '2026-10-30', durationMinutes: 10 },
    { id: 13, type: 'walking', recordDate: '2026-10-30', durationMinutes: 20 }
  ] }) });
  await h.page.refresh();
  h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'walking:12' } } });
  const previousMenu = h.calls.actionSheet;
  h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'walking:13' } } });
  const currentMenu = h.calls.actionSheet;
  assert.notEqual(currentMenu, previousMenu);
  previousMenu.success({ tapIndex: 0 });
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.calls.modal.length, 0);
  currentMenu.success({ tapIndex: 0 });
  assert.equal(h.page.data.formRecordId, 13);
  assert.equal(h.page.data.formValue, '20');
});

test('meditation mirrors are read only and their original history uses the existing 02:00 business day', async () => {
  const h = createPage({ feed: () => ({ records: [{ id: 1, type: 'sitting', source: 'meditation', sourceRecordId: 'source-1', recordDate: '2026-10-31', occurredAt: '2026-10-31 00:30:00', durationMinutes: 20, canEdit: true, canDelete: true }] }) });
  await h.page.refresh();
  h.page.openDetail({ currentTarget: { dataset: { key: 'sitting:1' } } });
  assert.equal(h.page.data.detail.mirrored, true);
  assert.equal(h.page.data.detail.canEdit, false);
  assert.equal(h.page.data.detail.canDelete, false);
  h.page.editDetail(); h.page.deleteDetail();
  assert.equal(h.page.data.showForm, false);
  assert.equal(h.calls.modal.length, 0);
  h.page.closeDetail();
  h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'sitting:1' } } });
  assert.equal(h.calls.actionSheet, undefined);
  assert.equal(h.page.data.detail.id, 1);
  h.page.openOriginalRecord();
  assert.equal(h.calls.navigation[0].url, '/pages/history/history?date=2026-10-30');
});

test('late reads and delayed delete confirmations cannot apply another binding data', async () => {
  const response = deferred();
  const h = createPage({ feed: () => response.promise });
  const pending = h.page.refresh();
  h.changeOwner({ openid: 'oz-other', studentNumber: '002', bindingVersion: 'v2' });
  response.resolve({ records: [{ id: 99, type: 'instant', count: 2, recordDate: '2026-10-30' }] });
  await pending;
  assert.equal(h.page.data.records.length, 0);
  h.page.setData({ records: [{ key: 'walking:1', id: 1, type: 'walking', canDelete: true }] });
  h.page.openDetail({ currentTarget: { dataset: { key: 'walking:1' } } });
  h.page.deleteDetail();
  h.changeOwner({ openid: 'oz-third', studentNumber: '003', bindingVersion: 'v3' });
  h.calls.modal[0].success({ confirm: true });
  assert.equal(h.calls.enqueue.length, 0);
  assert.match(h.calls.toast.at(-1).title, /已变化/);
});

test('account switches during upload cannot announce success or clear another account form', async () => {
  const upload = deferred();
  const h = createPage({ flush: () => upload.promise });
  h.page.openForm('instant');
  h.page.onFormValue({ detail: { value: '1' } });
  const save = h.page.saveForm();
  await new Promise(resolve => setImmediate(resolve));
  h.changeOwner({ openid: 'oz-new', studentNumber: '004', bindingVersion: 'v4' });
  upload.resolve({ success: true });
  await save;
  assert.equal(h.calls.toast.length, 0);
  assert.equal(h.tasks.length, 1);
});

test('confirmed background creates, updates and deletes refresh records and statistics while another task waits', async () => {
  for (const operation of ['create', 'update', 'delete']) {
    const record = { id: 7, type: 'walking', recordDate: '2026-10-30', durationMinutes: 12 };
    let records = operation === 'create' ? [] : [record];
    const started = deferred(), complete = deferred();
    const method = operation === 'delete' ? 'remove' : operation;
    const h = createPage({
      feed: () => ({ records }),
      summary: () => ({ totals: [{ type: 'walking', recordCount: records.length,
        totalValue: records.reduce((total, item) => total + item.durationMinutes, 0) }], recordCount: records.length }),
      queueFactory: persistedQueue({ [method]: async () => {
        started.resolve();
        await complete.promise;
        records = operation === 'delete' ? [] : [{ ...record, durationMinutes: 18 }];
        return { id: record.id };
      } })
    });
    const waiting = h.queue.enqueueSourceIntent({ operation: 'update', identity: { recordId: 'waiting-source' }, snapshot: {} });
    h.queue.enqueuePractice({ type: 'walking', operation, ...(operation === 'create' ? {} : { recordId: record.id }),
      payload: {}, requestId: `background-${operation}` });
    h.page.onShow();
    await new Promise(resolve => setImmediate(resolve));
    const upload = h.queue.flush();
    await started.promise;
    h.queue.annotateSource(waiting.id, { sourceCheckedAt: 123 });
    assert.equal(h.calls.feed.length, 1, `${operation}: sending and annotation writes do not reload`);
    assert.equal(h.calls.summary.length, 1, operation);
    complete.resolve();
    const result = await upload;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.sent, 1, operation);
    assert.equal(h.page.data.pendingCount, 1, operation);
    assert.equal(h.calls.feed.length, 2, operation);
    assert.equal(h.calls.summary.length, 2, operation);
    assert.deepEqual(plain(h.page.data.records.map(item => item.durationMinutes)), operation === 'delete' ? [] : [18], operation);
    assert.equal(h.page.data.recordCount, operation === 'delete' ? 0 : 1, operation);
    assert.equal(h.page.data.monthCards.find(item => item.type === 'walking').value, operation === 'delete' ? 0 : 18, operation);
    h.page.onHide();
  }
});

test('queue cancellations and failed background batches update pending state without reloading reads', async () => {
  const h = createPage({ queueFactory: persistedQueue({ create: async () => { throw failure('INVALID_INPUT', '无法保存'); } }) });
  const cancelled = h.queue.enqueuePractice({ type: 'walking', operation: 'create', payload: {}, requestId: 'cancelled' });
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  h.queue.cancel(cancelled.id);
  assert.equal(h.page.data.pendingCount, 0);
  assert.equal(h.calls.feed.length, 1, 'cancel-only notification must not reload');
  h.queue.enqueuePractice({ type: 'walking', operation: 'create', payload: {}, requestId: 'rejected' });
  const result = await h.queue.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.sent, 0);
  assert.equal(h.page.data.pendingCount, 1);
  assert.match(h.page.data.pending[0].stateText, /无法保存/);
  assert.equal(h.calls.feed.length, 1);
  assert.equal(h.calls.summary.length, 1);
  h.page.onHide();
});

test('one successful background batch reloads once even when several operations complete', async () => {
  let confirmed = 0;
  const h = createPage({ queueFactory: persistedQueue({ create: async () => ({ id: ++confirmed }) }) });
  for (const requestId of ['batch-one', 'batch-two']) {
    h.queue.enqueuePractice({ type: 'walking', operation: 'create', payload: {}, requestId });
  }
  h.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  const result = await h.queue.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.sent, 2);
  assert.equal(h.page.data.pendingCount, 0);
  assert.equal(h.calls.feed.length, 2);
  assert.equal(h.calls.summary.length, 2);
  h.page.onHide();
});

test('background completion cannot refresh a hidden page or another account or binding', async () => {
  for (const change of ['hide', 'openid', 'bindingVersion']) {
    const started = deferred(), complete = deferred();
    const h = createPage({ queueFactory: persistedQueue({ create: async () => {
      started.resolve(); await complete.promise; return { id: 1 };
    } }) });
    h.queue.enqueuePractice({ type: 'walking', operation: 'create', payload: {}, requestId: 'old-owner' });
    h.page.onShow();
    await new Promise(resolve => setImmediate(resolve));
    const upload = h.queue.flush();
    await started.promise;
    if (change === 'hide') h.page.onHide();
    else h.changeOwner({ openid: change === 'openid' ? 'oz-other' : 'oz-owner', studentNumber: '001',
      bindingVersion: change === 'bindingVersion' ? 'v2' : 'v1' });
    complete.resolve();
    const result = await upload;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.sent, 1, change);
    assert.equal(h.calls.feed.length, 1, change);
    assert.equal(h.calls.summary.length, 1, change);
    h.page.onHide();
  }
});

test('feature disabled performs no requests and the page lifecycle replaces queue subscriptions', async () => {
  const h = createPage({ enabled: false });
  h.page.onShow(); h.page.onShow();
  assert.equal(h.calls.feed.length, 0);
  assert.equal(h.calls.summary.length, 0);
  assert.equal(h.subscribers.size, 1);
  h.page.onHide();
  assert.equal(h.subscribers.size, 0);
  h.page.openForm('walking');
  assert.equal(h.page.data.showForm, false);
});

test('an unconfirmed sent create exposes deletion through a dependent operation instead of erasing local state', async () => {
  const h = createPage({ flush: () => ({ success: false, pending: 2 }) });
  h.tasks.push({ id: 'unknown-create', kind: 'practice', owner: { studentNumber: '001' }, type: 'walking',
    operation: 'create', attempts: 1, status: 'pending', payload: { recordDate: '2026-10-30' } });
  h.page.refreshPending();
  assert.equal(h.page.data.pending[0].canCancel, false);
  assert.equal(h.page.data.pending[0].canDeletePending, true);
  h.page.deletePending({ currentTarget: { dataset: { id: 'unknown-create' } } });
  assert.match(h.calls.modal[0].content, /先确认原记录/);
  h.calls.modal[0].success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].recordId, 'local:unknown-create');
  assert.equal(h.calls.enqueue[0].operation, 'delete');
  assert.equal(h.tasks.length, 2);
  const original = h.page.data.pending.find(item => item.id === 'unknown-create');
  assert.equal(original.deletionQueued, true);
  assert.equal(original.canDeletePending, false);
  h.page.deletePending({ currentTarget: { dataset: { id: 'unknown-create' } } });
  assert.equal(h.calls.modal.length, 1);
});

test('retry also rechecks original cloud confirmation and shows specific source errors', async () => {
  const h = createPage({ flush: () => ({ success: false, pending: 1 }) });
  h.tasks.push({ id: 'source-intent', kind: 'mirror', type: 'sitting', operation: 'update', status: 'waiting_source',
    owner: { studentNumber: '001' }, lastError: { message: '原记录缺少可靠更新时间，保留待核对' }, payload: {} });
  h.page.refreshPending();
  assert.match(h.page.data.pending[0].stateText, /可靠更新时间/);
  assert.equal(h.page.data.pending[0].canDeletePending, false);
  await h.page.retryPending();
  assert.equal(h.calls.mirrorResume, 1);
  assert.equal(h.calls.flush[0].manual, true);
});

test('five tab navigation retains existing sitting entry and the profile reminder targets tab 4', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.deepEqual(app.tabBar.list.map(item => item.text), ['首页', '计时', '记录', '团队', '我']);
  assert.equal(app.tabBar.list[2].pagePath, 'pages/practices/practices');
  const home = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.match(home, /bindtap="startMeditation"[\s\S]*?开始静坐/);
  assert.match(home, /bindtap="openPracticePicker"[\s\S]*?记录功课/);
  assert.match(home, /每日金句/);
  assert.match(home, /最近三天静坐/);
  const page = historyTemplate() + dialogsTemplate();
  assert.match(page, /对已登录成员可见/);
  assert.match(page, /静坐历史尚未全部导入/);
  assert.match(page, /原记录仅有日期/);
});
