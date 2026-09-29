const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/pages/feedback/feedback.js');
const plain = value => JSON.parse(JSON.stringify(value));
const success = data => ({ result: { success: true, data } });
const list = (feedbacks = [], nextCursor = '') => success({ feedbacks, nextCursor });
const row = (id, extra = {}) => ({ _id: id, content: '希望改进提醒', contact: '', status: 'pending', reply: '',
  createdAt: '2026-09-29T00:30:00.000Z', updatedAt: '2026-09-29T02:10:00.000Z', ...extra });

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createPage({ account = 'oz-user', fetch, submit, markRead, refreshAlert, deferRender = false } = {}) {
  let definition;
  const calls = { fetch: [], submit: [], markRead: [], refreshAlert: 0, refreshAlertOptions: [], renderCallbacks: [],
    toast: [], navigate: [], updates: [], stopRefresh: 0 };
  const wx = {
    getStorageSync: key => key === 'userOpenId' ? account : undefined,
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigate.push(value),
    stopPullDownRefresh() { calls.stopRefresh++; }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page(value) { definition = value; }, wx,
    getApp: () => ({ refreshSyncAlert(options) {
      calls.refreshAlert++; calls.refreshAlertOptions.push(plain(options));
      return refreshAlert && refreshAlert();
    } }),
    require(name) {
      if (name.endsWith('/checkin.js')) return { isUserLoggedIn: () => !!(account && account.startsWith('oz')) };
      if (name.endsWith('/cloudApi.js')) return {
        callCloudFunction(name, data) {
          assert.equal(name, 'meditationManager');
          if (data.type === 'getMyFeedback') {
            calls.fetch.push(plain(data));
            return fetch ? fetch(data, calls.fetch.length) : list();
          }
          if (data.type === 'markFeedbackRead') {
            calls.markRead.push(plain(data));
            return markRead ? markRead(data, calls.markRead.length) : success({ markedCount: data.feedbacks.length });
          }
          assert.equal(data.type, 'submitFeedback');
          calls.submit.push(plain(data));
          return submit ? submit(data, calls.submit.length) : success({ feedback: row('submitted') });
        }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  }, { filename: pagePath });
  const page = {
    ...definition, data: structuredClone(definition.data),
    setData(values, callback) {
      calls.updates.push(plain(values)); Object.assign(this.data, values);
      if (callback) {
        if (deferRender) calls.renderCallbacks.push(callback);
        else callback();
      }
    }
  };
  return { page, calls, setAccount(value) { account = value; },
    render() { for (const callback of calls.renderCallbacks.splice(0)) callback(); } };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

function draft(page, content = '  希望增加提醒  ', contact = '  微信：meditation  ') {
  page.onContentInput({ detail: { value: content } });
  page.onContactInput({ detail: { value: contact } });
}

test('Me feedback entry opens a registered page with an accessible feedback form and administrator reply', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  const me = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/me/me.js'), 'utf8');
  const meWxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/me/me.wxml'), 'utf8');
  const wxml = fs.readFileSync(pagePath.replace(/\.js$/, '.wxml'), 'utf8');
  assert.ok(app.pages.includes('pages/feedback/feedback'));
  assert.match(meWxml, /bindtap="goToFeedbackPage"/);
  assert.match(me, /goToFeedbackPage\s*\([^)]*\)\s*\{\s*wx\.navigateTo\(\{\s*url:\s*['"]\/pages\/feedback\/feedback['"]/);
  assert.match(wxml, /bindinput="onContentInput"/);
  assert.match(wxml, /bindinput="onContactInput"/);
  assert.match(wxml, /bindtap="submitFeedback"/);
  assert.match(wxml, /管理员回复/);
  assert.match(wxml, /\{\{item\.reply\}\}/);
});

test('guest login returns to the existing feedback page so its draft can survive', async () => {
  const { page, calls } = createPage({ account: '' });
  await page.onShow();
  draft(page);
  await page.submitFeedback();
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.navigate.length, 1);
  const loginUrl = new URL(calls.navigate[0].url, 'https://mini.example');
  assert.equal(loginUrl.pathname, '/pages/profile/profile');

  // Exercise the actual profile return routing, which reads fromPage rather than from.
  let profileDefinition;
  const navigation = [];
  const profilePath = path.join(__dirname, '../miniprogram/pages/profile/profile.js');
  vm.runInNewContext(fs.readFileSync(profilePath, 'utf8'), {
    Page(value) { profileDefinition = value; }, require() { return {}; },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback) { callback(); },
    wx: {
      showToast() {}, navigateBack() { navigation.push('back'); },
      switchTab(value) { navigation.push(value.url); }, redirectTo(value) { navigation.push(value.url); }
    }
  }, { filename: profilePath });
  const profile = { ...profileDefinition, data: structuredClone(profileDefinition.data),
    setData(values) { Object.assign(this.data, values); }, initByUserType() {} };
  profile.onLoad(Object.fromEntries(loginUrl.searchParams));
  profile.showSuccessAndNavigate();
  assert.deepEqual(navigation, ['back']);
  assert.equal(page.data.content, '  希望增加提醒  ');
});

test('visitors retain their draft and contact when returning after login', async () => {
  for (const account of ['', 'local_guest', 'test_user']) {
    const { page, calls, setAccount } = createPage({ account });
    await page.onShow();
    draft(page);
    assert.equal(page.data.loggedIn, false);
    assert.equal(calls.fetch.length, 0);
    page.onHide();
    setAccount('oz-user');
    await page.onShow();
    assert.equal(page.data.loggedIn, true);
    assert.equal(page.data.content, '  希望增加提醒  ', `draft retained for ${account || 'empty guest'}`);
    assert.equal(page.data.contact, '  微信：meditation  ');
    assert.equal(page.data.canSubmit, true);
    assert.equal(calls.fetch.length, 1);
  }
});

test('confirmed submission trims fields, clears the draft and refreshes status and administrator reply', async () => {
  const response = row('submitted', { status: 'resolved', reply: '已修复，感谢反馈', contact: '微信：meditation' });
  const { page, calls } = createPage({ fetch: (_, index) => list(index > 1 ? [response] : []) });
  await page.onShow();
  draft(page);
  await page.submitFeedback();
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].content, '希望增加提醒');
  assert.equal(calls.submit[0].contact, '微信：meditation');
  assert.match(calls.submit[0].requestId, /^[A-Za-z0-9_-]{1,100}$/);
  assert.equal(calls.fetch.length, 2);
  assert.equal(page.data.content, '');
  assert.equal(page.data.contact, '');
  assert.equal(page.data.canSubmit, false);
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.submitError, '');
  assert.equal(calls.toast.length, 1);
  assert.equal(page.data.feedbacks[0].statusText, '已处理');
  assert.equal(page.data.feedbacks[0].reply, '已修复，感谢反馈');
  assert.equal(page.data.feedbacks[0].createdText, '2026-09-29 08:30');
  assert.equal(page.data.feedbacks[0].updatedText, '2026-09-29 10:10');
});

test('blank and oversized submissions never reach the cloud', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  for (const [content, contact, error] of [['   ', '', /请填写/], ['字'.repeat(1001), '', /1000/], ['反馈', '字'.repeat(101), /100/]]) {
    draft(page, content, contact);
    await page.submitFeedback();
    assert.match(page.data.submitError, error);
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.content, content);
  }
  assert.equal(calls.submit.length, 0);
});

test('double taps and input changes during a submission cannot create a second request or change its content', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ submit: () => pending.promise });
  await page.onShow();
  draft(page);
  const submitting = page.submitFeedback();
  draft(page, '不应变更', '另一个联系方式');
  await page.submitFeedback();
  assert.equal(calls.submit.length, 1);
  assert.equal(page.data.content, '  希望增加提醒  ');
  assert.equal(page.data.contact, '  微信：meditation  ');
  assert.equal(page.data.submitting, true);
  pending.resolve(success({ feedback: row('submitted') }));
  await submitting;
  await page.submitFeedback();
  assert.equal(calls.submit.length, 1);
});

test('network, moderation and missing-confirmation errors preserve input and support retry', async () => {
  for (const failure of [
    () => Promise.reject(new Error('网络断开')),
    () => ({ result: { success: false, code: 'CONTENT_REJECTED', error: '请修改反馈' } }),
    () => success({}), () => ({})
  ]) {
    const { page, calls } = createPage({ submit: (_, count) => count === 1 ? failure() : success({ feedback: row('retry') }) });
    await page.onShow();
    draft(page);
    await page.submitFeedback();
    assert.ok(page.data.submitError);
    assert.equal(page.data.content, '  希望增加提醒  ');
    assert.equal(page.data.contact, '  微信：meditation  ');
    assert.equal(page.data.submitting, false);
    assert.equal(calls.toast.length, 0);
    await page.submitFeedback();
    assert.equal(calls.submit.length, 2);
    assert.equal(calls.submit[0].requestId, calls.submit[1].requestId, 'same request ID makes uncertain retries idempotent');
    assert.equal(page.data.content, '');
    assert.equal(calls.toast.length, 1);
  }
});

test('editing a failed submission uses a new request ID instead of reusing an incompatible request', async () => {
  const { page, calls } = createPage({ submit: () => Promise.reject(new Error('offline')) });
  await page.onShow();
  draft(page);
  await page.submitFeedback();
  draft(page, '更正后的反馈', '新的联系方式');
  await page.submitFeedback();
  assert.notEqual(calls.submit[0].requestId, calls.submit[1].requestId);
  assert.equal(calls.submit[1].content, '更正后的反馈');
  assert.equal(calls.submit[1].contact, '新的联系方式');
});

test('submission completion while hidden waits for onShow before clearing input or showing success', async () => {
  for (const succeeded of [true, false]) {
    const pending = deferred();
    const { page, calls } = createPage({ submit: () => pending.promise });
    await page.onShow();
    draft(page);
    const submitting = page.submitFeedback();
    page.onHide();
    const updates = calls.updates.length;
    if (succeeded) pending.resolve(success({ feedback: row('submitted') }));
    else pending.reject(new Error('连接中断'));
    await submitting;
    assert.equal(calls.updates.length, updates);
    assert.equal(calls.toast.length, 0);
    assert.equal(page.data.content, '  希望增加提醒  ');
    await page.onShow();
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.content, succeeded ? '' : '  希望增加提醒  ');
    assert.equal(calls.toast.length, succeeded ? 1 : 0);
    if (!succeeded) assert.match(page.data.submitError, /连接中断/);
  }
});

test('returning while submission is pending keeps its lock and applies the eventual completion once', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ submit: () => pending.promise });
  await page.onShow();
  draft(page);
  const submitting = page.submitFeedback();
  page.onHide();
  await page.onShow();
  await page.submitFeedback();
  assert.equal(calls.submit.length, 1);
  assert.equal(page.data.submitting, true);
  pending.resolve(success({ feedback: row('submitted') }));
  await submitting;
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.content, '');
  assert.equal(calls.toast.length, 1);
  assert.equal(calls.fetch.length, 3);
});

test('unloaded feedback pages ignore late list and submit completions', async () => {
  const listPending = deferred(), submitPending = deferred();
  const { page, calls } = createPage({ fetch: () => listPending.promise, submit: () => submitPending.promise });
  const showing = page.onShow();
  draft(page);
  const submitting = page.submitFeedback();
  page.onUnload();
  const updates = calls.updates.length;
  listPending.resolve(list([row('private')]));
  submitPending.resolve(success({ feedback: row('submitted') }));
  await Promise.all([showing, submitting]);
  assert.equal(calls.updates.length, updates);
  assert.equal(page.data.feedbacks.length, 0);
  assert.equal(calls.toast.length, 0);
});

test('a re-shown page ignores an older list response and displays the fresh result', async () => {
  const pending = deferred();
  const { page } = createPage({ fetch: (_, count) => count === 1 ? pending.promise : list([row('fresh')]) });
  const firstShow = page.onShow();
  page.onHide();
  await page.onShow();
  pending.resolve(list([row('stale')], 'old-cursor'));
  await firstShow;
  assert.deepEqual(plain(page.data.feedbacks).map(item => item._id), ['fresh']);
  assert.equal(page.data.nextCursor, '');
  assert.equal(page.data.loading, false);
});

test('account changes clear private draft and history and ignore both late responses from the old account', async () => {
  const listPending = deferred(), submitPending = deferred();
  const { page, calls, setAccount } = createPage({
    fetch: (_, count) => count === 2 ? listPending.promise : list([row(count === 1 ? 'old-account' : 'new-account')]),
    submit: () => submitPending.promise
  });
  await page.onShow();
  draft(page);
  const refresh = page.loadFeedback();
  const submitting = page.submitFeedback();
  page.onHide();
  assert.equal(page.data.feedbacks.length, 0);
  setAccount('oz-other');
  await page.onShow();
  assert.equal(page.data.content, '');
  assert.equal(page.data.contact, '');
  assert.equal(page.data.submitting, false);
  draft(page, '新账号草稿', '');
  listPending.resolve(list([row('late-private')], 'private-cursor'));
  submitPending.resolve(success({ feedback: row('old-submit') }));
  await Promise.all([refresh, submitting]);
  assert.deepEqual(plain(page.data.feedbacks).map(item => item._id), ['new-account']);
  assert.equal(page.data.content, '新账号草稿');
  assert.equal(page.data.submitError, '');
  assert.equal(calls.toast.length, 0);
});

test('logout removes feedback history and account draft, and does not fetch private feedback again', async () => {
  const { page, calls, setAccount } = createPage({ fetch: () => list([row('private')]) });
  await page.onShow();
  draft(page);
  page.onHide();
  setAccount('');
  await page.onShow();
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.feedbacks.length, 0);
  assert.equal(page.data.content, '');
  assert.equal(page.data.contact, '');
  assert.equal(calls.fetch.length, 1);
});

test('pagination failure preserves rows and cursor, and retry appends unique rows exactly once', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ fetch: (_, count) => {
    if (count === 1) return list([row('first')], 'next-page');
    if (count === 2) throw new Error('下一页加载失败');
    return pending.promise;
  } });
  await page.onShow();
  await page.onReachBottom();
  assert.deepEqual(plain(page.data.feedbacks).map(item => item._id), ['first']);
  assert.equal(page.data.nextCursor, 'next-page');
  assert.match(page.data.listError, /下一页加载失败/);
  assert.equal(page.data.loading, false);
  const retry = page.loadMoreFeedback();
  await page.onReachBottom();
  assert.equal(calls.fetch.length, 3);
  assert.equal(calls.fetch[1].cursor, 'next-page');
  assert.equal(calls.fetch[2].cursor, 'next-page');
  pending.resolve(list([row('first'), row('second')], ''));
  await retry;
  assert.deepEqual(plain(page.data.feedbacks).map(item => item._id), ['first', 'second']);
  assert.equal(page.data.listError, '');
  assert.equal(page.data.loading, false);
  await page.onReachBottom();
  assert.equal(calls.fetch.length, 3);
});

test('latest refresh wins over pending pagination and pull-to-refresh always stops its indicator', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ fetch: (_, count) => {
    if (count === 1) return list([row('first')], 'next-page');
    if (count === 2) return pending.promise;
    if (count === 3) return list([row('refreshed')]);
    return { result: { success: false, error: '刷新失败' } };
  } });
  await page.onShow();
  const more = page.loadMoreFeedback();
  await page.onPullDownRefresh();
  pending.resolve(list([row('stale-page')], 'stale-cursor'));
  await more;
  assert.deepEqual(plain(page.data.feedbacks).map(item => item._id), ['refreshed']);
  assert.equal(page.data.nextCursor, '');
  assert.equal(calls.stopRefresh, 1);
  await page.onPullDownRefresh();
  assert.equal(calls.stopRefresh, 2);
  assert.equal(page.data.loading, false);
  assert.match(page.data.listError, /刷新失败/);
});

test('displaying unread feedback marks only its loaded version after rendering and refreshes the Me reminder', async () => {
  const unread = row('unread', { status: 'resolved', reply: '处理完成', unreadForUser: true });
  const { page, calls, render } = createPage({ deferRender: true, fetch: () => list([
    unread, row('read', { unreadForUser: false }), row('legacy'), row('invalid-flag', { unreadForUser: 'true' })
  ], 'unloaded-page') });
  await page.onShow();
  assert.equal(page.data.feedbacks[0].reply, '处理完成');
  assert.equal(page.data.loading, false);
  assert.equal(calls.markRead.length, 0, 'render completion is required before marking as read');
  render();
  await flushAsync();
  assert.deepEqual(calls.markRead, [{ type: 'markFeedbackRead', feedbacks: [
    { feedbackId: 'unread', expectedUpdatedAt: unread.updatedAt }
  ] }]);
  assert.equal(calls.refreshAlert, 1);
  assert.deepEqual(calls.refreshAlertOptions, [{ force: true }]);
  assert.equal(calls.fetch.length, 1, 'unloaded pages are neither fetched nor marked');
});

test('no feedback is marked when a render becomes hidden, unloaded, or belongs to another account', async () => {
  for (const change of ['hide', 'unload', 'account']) {
    const { page, calls, render, setAccount } = createPage({ deferRender: true,
      fetch: () => list([row('unread', { unreadForUser: true })]) });
    await page.onShow();
    if (change === 'hide') page.onHide();
    if (change === 'unload') page.onUnload();
    if (change === 'account') setAccount('oz-other');
    render();
    await flushAsync();
    assert.equal(calls.markRead.length, 0, change);
    assert.equal(calls.refreshAlert, 0, change);
  }
});

test('superseded list render callbacks cannot mark feedback from the earlier response', async () => {
  const { page, calls, render } = createPage({ deferRender: true,
    fetch: (_, count) => list([row(count === 1 ? 'old' : 'current', { unreadForUser: true })]) });
  await page.onShow();
  await page.loadFeedback();
  render();
  await flushAsync();
  assert.deepEqual(calls.markRead.map(call => call.feedbacks.map(item => item.feedbackId)), [['current']]);
  assert.equal(calls.refreshAlert, 1);
});

test('read acknowledgement runs independently of list loading and failure can retry on the next load', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ fetch: () => list([row('unread', { unreadForUser: true })]),
    markRead: (_, count) => count === 1 ? pending.promise : success({ markedCount: 1 }) });
  await page.onShow();
  assert.equal(calls.markRead.length, 1);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.feedbacks.length, 1);
  pending.reject(new Error('已读请求断网'));
  await flushAsync();
  assert.equal(calls.refreshAlert, 0);
  assert.equal(page.data.listError, '');
  assert.equal(page.data.feedbacks[0].unreadForUser, true);
  await page.loadFeedback();
  await flushAsync();
  assert.equal(calls.markRead.length, 2);
  assert.equal(calls.refreshAlert, 1);
  assert.equal(page.data.listError, '');
});

test('late read acknowledgements from hidden pages, old accounts and superseded requests do not refresh reminders', async () => {
  for (const change of ['hide', 'unload', 'account', 'refresh']) {
    const pending = deferred();
    const { page, calls, setAccount } = createPage({
      fetch: (_, count) => list(count === 1 ? [row('unread', { unreadForUser: true })] : []),
      markRead: () => pending.promise
    });
    await page.onShow();
    assert.equal(calls.markRead.length, 1);
    if (change === 'hide') page.onHide();
    if (change === 'unload') page.onUnload();
    if (change === 'account') setAccount('oz-other');
    if (change === 'refresh') await page.loadFeedback();
    const updates = calls.updates.length;
    pending.resolve(success({ markedCount: 1 }));
    await flushAsync();
    assert.equal(calls.refreshAlert, 0, change);
    assert.equal(calls.updates.length, updates, change);
  }
});

test('pagination marks newly displayed rows without acknowledging duplicate versions that were not rendered', async () => {
  const { page, calls } = createPage({ fetch: (_, count) => count === 1
    ? list([row('first', { unreadForUser: true })], 'next-page')
    : list([row('first', { reply: '新回复', unreadForUser: true, updatedAt: '2026-09-29T03:00:00.000Z' }),
      row('second', { unreadForUser: true })]) });
  await page.onShow();
  await page.loadMoreFeedback();
  await flushAsync();
  assert.deepEqual(calls.markRead.map(call => call.feedbacks.map(item => item.feedbackId)), [['first'], ['second']]);
  assert.equal(page.data.feedbacks[0].reply, '', 'the overlapping newer version was not displayed');
});

test('failed or malformed list responses never acknowledge feedback', async () => {
  for (const response of [() => Promise.reject(new Error('连接失败')), () => success({ feedbacks: null })]) {
    const { page, calls } = createPage({ fetch: response });
    await page.onShow();
    await flushAsync();
    assert.equal(calls.markRead.length, 0);
    assert.equal(calls.refreshAlert, 0);
    assert.ok(page.data.listError);
  }
});

test('failed or malformed acknowledgements retain the reminder and do not fail the list', async () => {
  for (const result of [
    { result: { success: false, error: '服务暂时不可用' } }, success({}), success({ markedCount: -1 })
  ]) {
    const { page, calls } = createPage({ fetch: () => list([row('unread', { unreadForUser: true })]),
      markRead: () => result });
    await page.onShow();
    await flushAsync();
    assert.equal(calls.refreshAlert, 0);
    assert.equal(page.data.feedbacks.length, 1);
    assert.equal(page.data.listError, '');
  }
});

test('a concurrent newer reply rejected by version matching still causes an authoritative reminder refresh', async () => {
  const { page, calls } = createPage({ fetch: () => list([row('unread', { unreadForUser: true })]),
    markRead: () => success({ markedCount: 0 }) });
  await page.onShow();
  await flushAsync();
  assert.equal(calls.refreshAlert, 1);
  assert.equal(page.data.feedbacks[0].unreadForUser, true, 'do not optimistically clear a concurrent reply');
  assert.equal(page.data.listError, '');
});

test('reminder refresh failures never turn a successfully displayed list into an error', async () => {
  const { page, calls } = createPage({ fetch: () => list([row('unread', { unreadForUser: true })]),
    refreshAlert: () => Promise.reject(new Error('红点刷新失败')) });
  await page.onShow();
  await flushAsync();
  assert.equal(calls.refreshAlert, 1);
  assert.equal(page.data.feedbacks.length, 1);
  assert.equal(page.data.listError, '');
});
