const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/practices/practices.js');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function createPage({ feed, summary, flush, enabled = true, enqueue, hiddenTypes = [] } = {}) {
  let now = Date.parse('2026-10-31T00:30:37+08:00');
  let owner = { openid: 'oz-owner', studentNumber: '001', bindingVersion: 'v1' };
  const tasks = [], calls = { feed: [], summary: [], enqueue: [], flush: [], toast: [], navigation: [], switchTab: [], modal: [], mirrorResume: 0 };
  const storage = { userOpenId: owner.openid };
  const subscribers = new Set();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const api = {
    feed: async params => { calls.feed.push(plain(params)); return feed ? feed(params) : { records: [], nextCursor: '' }; },
    summary: async params => { calls.summary.push(plain(params)); return summary ? summary(params) : { totals: [], recordCount: 0, practiceDays: 0, daily: [], allTime: { totals: [] } }; }
  };
  const queue = {
    getPending: () => tasks.filter(task => task.owner.studentNumber === owner.studentNumber),
    enqueuePractice: options => {
      calls.enqueue.push(plain(options));
      if (enqueue) return enqueue(options, tasks, owner);
      const task = { ...options, id: `task-${calls.enqueue.length}`, owner: plain(owner), status: 'pending', attempts: 0 };
      tasks.push(task);
      return task;
    },
    flush: async options => { calls.flush.push(options); if (flush) return flush(tasks); tasks.splice(0); return { success: true, pending: 0, sent: 1 }; },
    subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    cancel: id => { const index = tasks.findIndex(task => task.id === id); if (index >= 0) tasks.splice(index, 1); }
  };
  let definition;
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigation.push(value),
    switchTab: value => { calls.navigation.push(value); calls.switchTab.push(value); },
    showModal: value => calls.modal.push(value), showActionSheet: value => { calls.actionSheet = value; },
    stopPullDownRefresh() {}
  };
  const preferencesModule = { exports: {} };
  const preferencesPath = path.join(__dirname, '../miniprogram/utils/practicePreferences.js');
  vm.runInNewContext(fs.readFileSync(preferencesPath, 'utf8'), {
    module: preferencesModule, exports: preferencesModule.exports, wx, console
  }, { filename: preferencesPath });
  const preferences = preferencesModule.exports;
  preferences.saveHiddenTypes(hiddenTypes);
  const modules = { 'practiceApi.js': api, 'practiceQueue.js': queue,
    'practiceEntry.js': { openSettings: () => wx.navigateTo({ url: '/pages/practiceSettings/practiceSettings' }) },
    'practicePreferences.js': preferences,
    'practiceAuth.js': { getOwner: () => owner, authorize: async () => owner },
    'practiceMirror.js': { resume: async () => { calls.mirrorResume++; } },
    'practiceConfig.js': { practicesEnabled: enabled } };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: name => { const module = modules[path.basename(name)]; assert.ok(module, name); return module; },
    Page: value => { definition = value; }, wx, Date: Clock, console
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data); } };
  page.onLoad();
  return { page, calls, tasks, storage, subscribers, queue, preferences,
    changeOwner(value) { owner = value; storage.userOpenId = value && value.openid; },
    advance(milliseconds) { now += milliseconds; } };
}

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
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'kindness' }]);
  assert.deepEqual(h.calls.summary, [{ month: '2026-10', type: 'kindness' }]);
  h.page.openTypePicker();
  h.page.onTypeChange({ detail: { type: 'clapping' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.type, 'clapping');
  assert.equal(h.page.data.typeIndex, 2);
  assert.deepEqual(h.calls.feed.at(-1), { month: '2026-10', type: 'clapping' });
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
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'all' }]);
  assert.deepEqual(h.calls.summary, [{ month: '2026-10', type: 'all' }]);
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
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'all' }]);
  assert.deepEqual(h.calls.summary, [{ month: '2026-10', type: 'all' }]);
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
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'all' }]);
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
  assert.equal(h.page.data.groups.length, 2);
  assert.deepEqual(h.calls.feed, [{ month: '2026-10', type: 'all' }, { month: '2026-10', type: 'all', cursor: 'stable-cursor-1' }]);
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
  assert.deepEqual(h.calls.feed.at(-1), { month: '2026-10', type: 'walking', date: '2026-10-30' });
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

test('the selected month total uses record count for all types and the matching metric and unit for each practice', async () => {
  const totals = [
    { type: 'sitting', totalValue: 91, recordCount: 3 },
    { type: 'walking', durationMinutes: 42, recordCount: 4 },
    { type: 'instant', count: 17, recordCount: 5 },
    { type: 'learning', totalDurationMinutes: 63, recordCount: 6 },
    { type: 'kindness', deedCount: 8, recordCount: 7 },
    { type: 'clapping', total: 29, recordCount: 8 }
  ];
  const h = createPage({ summary: () => ({ recordCount: 33, totals,
    daily: [{ date: '2026-10-30', recordCount: 33, totals }], allTime: { totals: [] } }) });
  for (const [typeIndex, type, expected, unit] of [
    [0, 'all', 33, '件'], [1, 'sitting', 91, '分钟'], [2, 'walking', 42, '分钟'],
    [3, 'instant', 17, '次'], [4, 'learning', 63, '分钟'], [5, 'kindness', 8, '件'], [6, 'clapping', 29, '分钟']
  ]) {
    h.page.setData({ typeIndex, type });
    await h.page.refresh();
    assert.equal(h.page.data.selectedMonthTotal, expected, type);
    assert.equal(h.page.data.selectedMonthUnit, unit, type);
    const day = h.page.data.calendar.flat().find(item => item.date === '2026-10-30');
    assert.equal(day.value, expected, type);
    assert.equal(day.valueLabel, String(expected), type);
    if (type !== 'all') {
      assert.equal(h.page.data.selectedMonthTotal, h.page.data.monthCards.find(item => item.type === type).value, type);
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
  assert.deepEqual(h.calls.feed.at(-1), { month: '2026-10', type: 'walking', date: '2026-10-30' });
  const previousReads = h.calls.feed.length;
  h.page.clearDate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.selectedDate, '');
  assert.equal(h.page.data.view, 'detail');
  assert.equal(h.calls.feed.length, previousReads + 1);
  assert.deepEqual(h.calls.feed.at(-1), { month: '2026-10', type: 'walking' });
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

test('statistics show record counts for all practices and keep completion quantities for individual practices', () => {
  const page = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
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
  assert.match(amount[0], /type === 'all' \? '件' : ''/);
  assert.doesNotMatch(amount[0], /selectedMonthUnit|分钟|次|条|—/);
  const monthOverview = page.slice(page.indexOf('class="stats-card practice-overview-card"'), page.indexOf('class="month-overview"'));
  assert.match(monthOverview, /本月记录件数/);
  assert.match(monthOverview, /item\.records/);
  assert.doesNotMatch(monthOverview, /item\.value|item\.unit/);
  assert.match(page, /type === 'all' \? item\.records : item\.value/);
  assert.match(page, /type === 'all' \? '件' : item\.unit/);
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

test('new practice keeps first-open Beijing date, original seconds and one identity across failed retries', async () => {
  let attempts = 0;
  const h = createPage({ flush: tasks => { if (++attempts === 1) { tasks[0].lastError = { message: '网络中断' }; return { success: false }; } tasks.splice(0); return { success: true }; } });
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
  h.page.onFormValue({ detail: { value: '20' } });
  assert.equal(h.page.data.formValue, '15');
  await h.page.saveForm();
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.flush.length, 2);
  assert.equal(h.page.data.showForm, false);
});

test('manual quantity and future or impossible Beijing times never enter the queue', async () => {
  const h = createPage();
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
  const page = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/practices/practices.wxml'), 'utf8');
  assert.match(page, /对已登录成员可见/);
  assert.match(page, /静坐历史尚未全部导入/);
  assert.match(page, /原记录仅有日期/);
});
