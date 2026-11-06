const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil.js');

const success = data => ({ success: true, data });
const input = value => ({ detail: { value } });
const event = dataset => ({ currentTarget: { dataset } });
const quote = overrides => ({ _id: 'quote-1', content: '但行好事，莫问前程', ...overrides });
const list = (quotes = [quote()], nextCursor = '', total = quotes.length) => success({ quotes, nextCursor, total });
const json = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ api, access = true, confirm = true, account = 'oz-admin' } = {}) {
  let definition;
  const calls = { cloud: [], toast: [], alerts: [], modal: [], refresh: [], scroll: [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/admin/admin.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp() { return { clearAdminSyncAlert() { calls.alerts.push('clear'); }, refreshSyncAlert() { calls.alerts.push('refresh'); } }; },
    require(name) {
      if (name.includes('dateUtil')) return dateUtil;
      if (name.includes('cloudApi')) return { async callCloudFunction(name, data) {
        calls.cloud.push({ name, data });
        if (data.type === 'getAccess') return { result: success({ isAdmin: typeof access === 'function' ? access() : access }) };
        let result = api && await api(name, data);
        if (result === undefined) {
          if (data.type === 'adminListWisdom') result = list();
          else if (data.type === 'adminCreateWisdom') result = success({ quote: quote({ _id: 'new-quote', content: data.content }), created: true });
          else if (data.type === 'adminUpdateWisdom') result = success({ quote: quote({ _id: data.quoteId, content: data.content }) });
          else if (data.type === 'adminDeleteWisdom') result = success({ quoteId: data.quoteId, deleted: true });
          else result = success({ teams: [], logs: [], runs: [], errors: [] });
        }
        return { result };
      } };
      throw new Error(`Unexpected require: ${name}`);
    },
    wx: {
      getStorageSync(key) { return key === 'userOpenId' ? account : undefined; },
      showToast(value) { calls.toast.push(value); },
      showModal(options) { calls.modal.push(options); if (typeof confirm === 'function') confirm(options); else options.success({ confirm }); },
      stopPullDownRefresh() { calls.refresh.push('stopped'); },
      pageScrollTo(options) { calls.scroll.push(options); }
    },
    Date, console, setTimeout, clearTimeout
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values, callback) {
    Object.assign(this.data, values);
    if (callback) callback();
  } };
  page.data.tab = 'wisdom';
  return { page, calls, setAccount(value) { account = value; } };
}
async function open(options) {
  const result = harness(options);
  await result.page.onShow();
  return result;
}
const requests = (calls, type) => calls.cloud.filter(call => call.data.type === type);
function draft(page, content = '心中有爱，眼里有光', id = 'quote-1') {
  page.editWisdom(event({ id }));
  page.onWisdomContentInput(input(content));
}
function assertCleared(page) {
  assert.equal(page.data.wisdomQuotes.length, 0);
  assert.equal(page.data.wisdomTotal, 0);
  assert.equal(page.data.wisdomCursor, '');
  assert.equal(page.data.wisdomKeyword, '');
  assert.equal(page.data.wisdomSearch, '');
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.selectedWisdom, null);
  assert.equal(page.data.wisdomContent, '');
  assert.equal(page.data.wisdomSaveError, '');
  assert.equal(page.data.wisdomError, '');
}

test('wisdom requires administrator access and opens only its first page with top-level API arguments', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? list([quote(), quote({ _id: 'empty', content: null })], 'next', 21) : undefined });
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.wisdomQuotes.length, 2);
  assert.equal(page.data.wisdomQuotes[1].displayContent, '（正文为空）');
  assert.equal(page.data.wisdomQuotes[1].content, null);
  assert.equal(page.data.wisdomTotal, 21);
  assert.equal(page.data.wisdomCursor, 'next');
  assert.deepEqual(json(calls.cloud), [
    { name: 'adminManager', data: { type: 'getAccess' } },
    { name: 'adminManager', data: { type: 'adminListWisdom', keyword: '', limit: 20 } }
  ]);
  const denied = await open({ access: false });
  denied.page.newWisdom();
  denied.page.editWisdom(event({ id: 'quote-1' }));
  await denied.page.searchWisdom();
  await denied.page.loadMoreWisdom();
  await denied.page.saveWisdom();
  await denied.page.deleteWisdom();
  assert.equal(denied.calls.cloud.length, 1);
  assert.equal(denied.calls.modal.length, 0);
  assertCleared(denied.page);
});

test('literal keywords reset pagination, discard drafts and clear back to the complete first page', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? list([quote({ content: data.keyword ? `文字${data.keyword}` : quote().content })], 'next-page', 25) : undefined });
  draft(page);
  await page.loadMoreWisdom();
  page.onWisdomKeywordInput(input('  .*[$](佛)\\  '));
  await page.searchWisdom();
  const request = requests(calls, 'adminListWisdom').at(-1).data;
  assert.equal(request.keyword, '.*[$](佛)\\', 'the client must send a literal keyword for the service to escape');
  assert.equal(request.cursor, undefined);
  assert.equal(page.data.wisdomSearch, '.*[$](佛)\\');
  assert.equal(page.data.wisdomQuotes.length, 1);
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.wisdomContent, '');
  await page.clearWisdomSearch();
  assert.equal(requests(calls, 'adminListWisdom').at(-1).data.keyword, '');
  assert.equal(requests(calls, 'adminListWisdom').at(-1).data.cursor, undefined);
  assert.equal(page.data.wisdomKeyword, '');
  assert.equal(page.data.wisdomSearch, '');
});

test('pagination deduplicates overlapping pages, blocks duplicate loads and stops at the last cursor', async () => {
  const pending = deferred();
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? data.cursor ? pending.promise : list([quote()], 'page-2', 2) : undefined });
  const loading = page.loadMoreWisdom();
  await page.loadMoreWisdom();
  assert.equal(requests(calls, 'adminListWisdom').length, 2);
  assert.equal(requests(calls, 'adminListWisdom').at(-1).data.cursor, 'page-2');
  pending.resolve(list([quote(), quote({ _id: 'quote-2' })], '', 2));
  await loading;
  assert.deepEqual(Array.from(page.data.wisdomQuotes, row => row._id), ['quote-1', 'quote-2']);
  assert.equal(page.data.wisdomTotal, 2);
  assert.equal(page.data.wisdomLoading, false);
  await page.loadMoreWisdom();
  assert.equal(requests(calls, 'adminListWisdom').length, 2);
});

test('late search results and failures cannot replace a newer search or its loading state', async () => {
  for (const response of [list([quote({ _id: 'stale', content: '旧查询' })], 'stale-page', 9),
    { success: false, error: '旧查询失败' }, { success: false, code: 'FORBIDDEN', error: '旧查询无权限' }]) {
    const pending = deferred();
    const { page } = await open({ api: (name, data) => data.type === 'adminListWisdom'
      ? data.keyword === '旧查询' ? pending.promise : list([quote({ content: data.keyword || quote().content })]) : undefined });
    page.onWisdomKeywordInput(input('旧查询'));
    const loading = page.searchWisdom();
    page.onWisdomKeywordInput(input('新查询'));
    await page.searchWisdom();
    pending.resolve(response);
    await loading;
    assert.equal(page.data.wisdomSearch, '新查询');
    assert.equal(page.data.wisdomQuotes[0].content, '新查询');
    assert.equal(page.data.wisdomCursor, '');
    assert.equal(page.data.wisdomError, '');
    assert.equal(page.data.wisdomLoading, false);
    assert.equal(page.data.authorized, true);
    assert.equal(page.data.accessError, '');
  }
});

test('a failed new search retains the successful keyword, cursor and rows as one consistent result set', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? data.keyword === '失败查询' ? { success: false, error: '查询暂不可用' }
      : list([quote({ content: `正文${data.keyword}` })], `cursor-${data.keyword}`, 24) : undefined });
  page.onWisdomKeywordInput(input('成功查询'));
  await page.searchWisdom();
  draft(page, '成功查询中的草稿');
  page.onWisdomKeywordInput(input('失败查询'));
  await page.searchWisdom();
  assert.equal(page.data.wisdomKeyword, '失败查询', 'the typed keyword remains available to retry');
  assert.equal(page.data.wisdomSearch, '成功查询', 'the applied keyword still describes the rows on screen');
  assert.equal(page.data.wisdomQuotes[0].content, '正文成功查询');
  assert.equal(page.data.wisdomCursor, 'cursor-成功查询');
  assert.equal(page.data.wisdomTotal, 24);
  assert.equal(page.data.wisdomContent, '成功查询中的草稿');
  assert.equal(page.data.wisdomError, '查询暂不可用');
  await page.loadMoreWisdom();
  const request = requests(calls, 'adminListWisdom').at(-1).data;
  assert.equal(request.keyword, '成功查询');
  assert.equal(request.cursor, 'cursor-成功查询');
});

test('search rejects overlong keywords without a request and reload errors preserve the current draft and rows', async () => {
  let failList = false;
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom' && failList
    ? { success: false, error: '读取失败' } : undefined });
  page.onWisdomKeywordInput(input('字'.repeat(101)));
  await page.searchWisdom();
  assert.equal(requests(calls, 'adminListWisdom').length, 1);
  assert.match(page.data.wisdomError, /100/);
  draft(page);
  page.setData({ wisdomSaveError: '上次保存失败' });
  failList = true;
  await page.onPullDownRefresh();
  assert.equal(page.data.wisdomError, '读取失败');
  assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
  assert.equal(page.data.wisdomSaveError, '上次保存失败');
  assert.equal(page.data.wisdomQuotes.length, 1);
  assert.deepEqual(calls.refresh, ['stopped']);
  failList = false;
  await page.loadWisdom(event({}));
  assert.equal(requests(calls, 'adminListWisdom').at(-1).data.cursor, undefined);
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.wisdomSaveError, '');
  assert.equal(page.data.wisdomError, '');
});

test('creating trims the draft, uses a request id and reloads the complete first page for a valid cursor', async () => {
  let created = false;
  const { page, calls } = await open({ api: (name, data) => {
    if (data.type === 'adminCreateWisdom') { created = true; return success({ quote: quote({ _id: 'created-id', content: data.content }), created: true }); }
    if (data.type === 'adminListWisdom') return list(created ? [quote(), quote({ _id: 'created-id', content: '新金句' })] : [quote()], 'first-page', created ? 22 : 21);
  } });
  page.onWisdomKeywordInput(input('前程'));
  await page.searchWisdom();
  page.newWisdom();
  page.onWisdomContentInput(input('  新金句  '));
  await page.saveWisdom();
  const request = requests(calls, 'adminCreateWisdom')[0];
  assert.equal(request.name, 'adminManager');
  assert.equal(request.data.content, '新金句');
  assert.match(request.data.requestId, /^[A-Za-z0-9_-]{1,100}$/);
  assert.equal(request.data.quoteId, undefined);
  assert.equal(page.data.wisdomKeyword, '');
  assert.equal(page.data.wisdomSearch, '');
  assert.equal(requests(calls, 'adminListWisdom').at(-1).data.cursor, undefined);
  assert.equal(page.data.wisdomTotal, 22);
  assert.equal(page.data.wisdomQuotes.length, 2);
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.wisdomContent, '');
  assert.equal(page.data.wisdomSaveBusy, false);
  assert.match(page.data.wisdomMessage, /已新增/);
  assert.equal(calls.toast[0].title, '金句已新增');
});

test('lost create responses preserve the draft and reuse the same request id on retry', async () => {
  let attempt = 0;
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminCreateWisdom'
    ? ++attempt === 1 ? Promise.reject(new Error('网络中断'))
      : success({ quote: quote({ _id: 'created-id', content: data.content }), created: false }) : undefined });
  page.newWisdom();
  page.onWisdomContentInput(input(' 重试正文 '));
  await page.saveWisdom();
  assert.equal(page.data.wisdomContent, ' 重试正文 ');
  assert.equal(page.data.wisdomEditorOpen, true);
  assert.equal(page.data.wisdomSaveError, '网络中断');
  assert.equal(page.data.wisdomSaveBusy, false);
  assert.equal(calls.toast.length, 0);
  await page.saveWisdom();
  const creates = requests(calls, 'adminCreateWisdom');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].data.requestId, creates[1].data.requestId);
  assert.equal(creates[1].data.content, '重试正文');
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(calls.toast.length, 1);
});

test('editing a failed create generates a new request id and canceling drops its draft', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminCreateWisdom'
    ? { success: false, error: '暂不可用' } : undefined });
  page.newWisdom();
  page.onWisdomContentInput(input('第一次正文'));
  await page.saveWisdom();
  page.onWisdomContentInput(input('修改后的正文'));
  await page.saveWisdom();
  const creates = requests(calls, 'adminCreateWisdom');
  assert.notEqual(creates[0].data.requestId, creates[1].data.requestId);
  assert.equal(page.data.wisdomContent, '修改后的正文');
  page.cancelWisdomEdit();
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.wisdomContent, '');
  assert.equal(page.data.wisdomSaveError, '');
  await page.saveWisdom();
  assert.equal(requests(calls, 'adminCreateWisdom').length, 2);
});

test('a stale reload after creating cannot unlock a later save or show the earlier success inside its editor', async () => {
  const oldReload = deferred();
  const nextCreate = deferred();
  let creates = 0;
  const { page, calls } = await open({ api: (name, data) => {
    if (data.type === 'adminCreateWisdom') {
      creates++;
      return creates === 1 ? success({ quote: quote({ _id: 'created-1', content: data.content }), created: true }) : nextCreate.promise;
    }
    if (data.type === 'adminListWisdom' && creates === 1 && data.keyword === '') return oldReload.promise;
    if (data.type === 'adminListWisdom' && data.keyword === '新的查询') return list([quote({ content: '新的查询结果' })]);
  } });
  page.newWisdom();
  page.onWisdomContentInput(input('第一次新增'));
  const firstSave = page.saveWisdom();
  for (let turn = 0; turn < 20 && requests(calls, 'adminListWisdom').length < 2; turn++) await Promise.resolve();
  assert.equal(requests(calls, 'adminListWisdom').length, 2, 'the first create has started its automatic reload');
  assert.equal(page.data.wisdomLoading, true);
  page.onWisdomKeywordInput(input('新的查询'));
  await page.searchWisdom();
  assert.equal(page.data.wisdomSearch, '新的查询');
  page.newWisdom();
  page.onWisdomContentInput(input('第二次新增'));
  const secondSave = page.saveWisdom();
  assert.equal(page._wisdomSaveBusy, true);
  assert.equal(page.data.wisdomSaveBusy, true);
  assert.equal(requests(calls, 'adminCreateWisdom').length, 2);
  oldReload.resolve(list([quote({ _id: 'old-list', content: '过期列表' })], 'old-cursor', 19));
  await firstSave;
  assert.equal(page._wisdomSaveBusy, true, 'the old save owns no lock for the new mutation');
  assert.equal(page.data.wisdomSaveBusy, true);
  assert.equal(page.data.wisdomEditorOpen, true);
  assert.equal(page.data.wisdomContent, '第二次新增');
  assert.equal(page.data.wisdomMessage, '');
  assert.equal(page.data.wisdomSearch, '新的查询');
  assert.equal(page.data.wisdomQuotes[0].content, '新的查询结果');
  await page.saveWisdom();
  await page.deleteWisdom();
  assert.equal(requests(calls, 'adminCreateWisdom').length, 2);
  assert.equal(calls.modal.length, 0);
  nextCreate.resolve({ success: false, error: '第二次保存失败' });
  await secondSave;
  assert.equal(page.data.wisdomSaveBusy, false);
  assert.equal(page.data.wisdomContent, '第二次新增');
  assert.equal(page.data.wisdomSaveError, '第二次保存失败');
});

test('updates send the original content revision, retain pagination and remove rows that no longer match the keyword', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? list([quote()], 'next-page', 31) : undefined });
  page.onWisdomKeywordInput(input('前程'));
  await page.searchWisdom();
  draft(page, '  但行好事，前程可期  ');
  await page.saveWisdom();
  assert.deepEqual(json(requests(calls, 'adminUpdateWisdom')[0]), { name: 'adminManager', data: {
    type: 'adminUpdateWisdom', quoteId: 'quote-1', expectedContent: quote().content, content: '但行好事，前程可期'
  } });
  assert.equal(page.data.wisdomQuotes[0].content, '但行好事，前程可期');
  assert.equal(page.data.wisdomQuotes[0].displayContent, '但行好事，前程可期');
  assert.equal(page.data.wisdomTotal, 31);
  assert.equal(page.data.wisdomCursor, 'next-page');
  draft(page, '静心即是修心');
  await page.saveWisdom();
  assert.equal(requests(calls, 'adminUpdateWisdom').at(-1).data.expectedContent, '但行好事，前程可期');
  assert.equal(page.data.wisdomQuotes.length, 0);
  assert.equal(page.data.wisdomTotal, 30);
  assert.equal(page.data.wisdomSearch, '前程');
  assert.equal(page.data.wisdomCursor, 'next-page');
});

test('legacy empty and scalar content remains an exact expected revision when repaired or deleted', async () => {
  for (const content of [null, '', 0, false]) {
    const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom' ? list([quote({ content })]) : undefined });
    draft(page, '补全正文');
    await page.saveWisdom();
    assert.equal(requests(calls, 'adminUpdateWisdom')[0].data.expectedContent, content);
    await page.loadWisdom();
    draft(page, '未保存草稿');
    await page.deleteWisdom();
    assert.equal(requests(calls, 'adminDeleteWisdom')[0].data.expectedContent, content);
    assert.equal(page.data.wisdomQuotes.length, 0);
  }
});

test('blank and oversized drafts never reach the service; exactly 500 characters are accepted', async () => {
  const { page, calls } = await open();
  page.newWisdom();
  for (const content of ['', '  \n  ', '字'.repeat(501)]) {
    page.onWisdomContentInput(input(content));
    await page.saveWisdom();
    assert.match(page.data.wisdomSaveError, /500/);
  }
  assert.equal(requests(calls, 'adminCreateWisdom').length, 0);
  page.onWisdomContentInput(input('字'.repeat(500)));
  await page.saveWisdom();
  assert.equal(requests(calls, 'adminCreateWisdom').length, 1);
  assert.equal(requests(calls, 'adminCreateWisdom')[0].data.content.length, 500);
});

test('failed updates preserve the draft, selected revision and current rows for an explicit retry', async () => {
  let failUpdate = true;
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateWisdom' && failUpdate
    ? { success: false, error: '保存失败' } : undefined });
  draft(page);
  await page.saveWisdom();
  assert.equal(page.data.wisdomSaveError, '保存失败');
  assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
  assert.equal(page.data.selectedWisdom.content, quote().content);
  assert.equal(page.data.wisdomQuotes[0].content, quote().content);
  assert.equal(page.data.wisdomSaveBusy, false);
  assert.equal(calls.toast.length, 0);
  failUpdate = false;
  await page.saveWisdom();
  assert.equal(requests(calls, 'adminUpdateWisdom').length, 2);
  assert.equal(page.data.wisdomQuotes[0].content, '心中有爱，眼里有光');
  assert.equal(page.data.selectedWisdom, null);
});

test('conflicting saves and deletions retain drafts and require successful reload before another mutation', async () => {
  for (const type of ['adminUpdateWisdom', 'adminDeleteWisdom']) {
    for (const code of ['CONFLICT', 'NOT_FOUND']) {
      const { page, calls } = await open({ api: (name, data) => data.type === type
        ? { success: false, code, error: '数据已变化' } : undefined });
      draft(page);
      await page[type === 'adminUpdateWisdom' ? 'saveWisdom' : 'deleteWisdom']();
      assert.equal(page.data.wisdomConflict, true);
      assert.match(page.data.wisdomSaveError, /重新加载金句/);
      assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
      await page.saveWisdom();
      await page.deleteWisdom();
      assert.equal(requests(calls, type).length, 1);
      await page.loadWisdom();
      assert.equal(page.data.wisdomConflict, false);
      assert.equal(page.data.selectedWisdom, null);
      assert.equal(page.data.wisdomSaveError, '');
    }
  }
});

test('saving locks duplicate clicks, search, refresh and editor changes until the mutation completes', async () => {
  const pending = deferred();
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateWisdom' ? pending.promise : undefined });
  draft(page);
  const saving = page.saveWisdom();
  await page.saveWisdom();
  await page.deleteWisdom();
  await page.searchWisdom();
  await page.clearWisdomSearch();
  await page.loadWisdom();
  await page.loadMoreWisdom();
  page.onWisdomContentInput(input('不能覆盖保存中草稿'));
  page.onWisdomKeywordInput(input('新查询'));
  page.newWisdom();
  page.cancelWisdomEdit();
  page.editWisdom(event({ id: 'quote-1' }));
  assert.equal(requests(calls, 'adminUpdateWisdom').length, 1);
  assert.equal(requests(calls, 'adminListWisdom').length, 1);
  assert.equal(calls.modal.length, 0);
  assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
  assert.equal(page.data.wisdomKeyword, '');
  assert.equal(page.data.wisdomSaveBusy, true);
  pending.resolve(success({ quote: quote({ content: '心中有爱，眼里有光' }) }));
  await saving;
  assert.equal(page.data.wisdomSaveBusy, false);
});

test('canceling deletion preserves the row and unsaved draft without a backend request', async () => {
  const { page, calls } = await open({ confirm: false });
  draft(page, '未保存的草稿');
  page.setData({ wisdomSaveError: '上次失败' });
  await page.deleteWisdom();
  assert.equal(calls.modal.length, 1);
  assert.match(calls.modal[0].content, /无法恢复/);
  assert.match(calls.modal[0].content, /但行好事/);
  assert.equal(requests(calls, 'adminDeleteWisdom').length, 0);
  assert.equal(page.data.wisdomQuotes.length, 1);
  assert.equal(page.data.wisdomContent, '未保存的草稿');
  assert.equal(page.data.wisdomSaveError, '上次失败');
  assert.equal(page.data.wisdomDeleteBusy, false);
  assert.equal(calls.toast.length, 0);
});

test('confirmed deletion removes only the selected revision and retains the remaining cursor', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom'
    ? list([quote(), quote({ _id: 'quote-2', content: '另一句' })], 'next-page', 24) : undefined });
  draft(page);
  await page.deleteWisdom();
  assert.deepEqual(json(requests(calls, 'adminDeleteWisdom')[0]), { name: 'adminManager', data: {
    type: 'adminDeleteWisdom', quoteId: 'quote-1', expectedContent: quote().content
  } });
  assert.deepEqual(Array.from(page.data.wisdomQuotes, row => row._id), ['quote-2']);
  assert.equal(page.data.wisdomTotal, 23);
  assert.equal(page.data.wisdomCursor, 'next-page');
  assert.equal(page.data.selectedWisdom, null);
  assert.equal(page.data.wisdomContent, '');
  assert.equal(page.data.wisdomDeleteBusy, false);
  assert.match(page.data.wisdomMessage, /已删除/);
  assert.equal(calls.toast[0].title, '金句已删除');
  assert.equal(requests(calls, 'adminListWisdom').length, 1);
});

test('deletion locks all mutations during confirmation and the pending backend request', async () => {
  const pending = deferred();
  const { page, calls } = await open({ confirm() {}, api: (name, data) => data.type === 'adminDeleteWisdom' ? pending.promise : undefined });
  draft(page);
  const deleting = page.deleteWisdom();
  for (const stage of ['confirmation', 'request']) {
    await page.deleteWisdom();
    await page.saveWisdom();
    await page.searchWisdom();
    await page.clearWisdomSearch();
    await page.loadWisdom();
    page.onWisdomKeywordInput(input('不能查询'));
    page.onWisdomContentInput(input('不能改草稿'));
    page.newWisdom();
    page.cancelWisdomEdit();
    assert.equal(calls.modal.length, 1);
    assert.equal(requests(calls, 'adminUpdateWisdom').length, 0);
    assert.equal(requests(calls, 'adminCreateWisdom').length, 0);
    assert.equal(requests(calls, 'adminListWisdom').length, 1);
    assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
    assert.equal(page.data.wisdomKeyword, '');
    assert.equal(page.data.wisdomDeleteBusy, true);
    if (stage === 'confirmation') calls.modal[0].success({ confirm: true });
  }
  assert.equal(requests(calls, 'adminDeleteWisdom').length, 1);
  pending.resolve(success({ quoteId: 'quote-1', deleted: true }));
  await deleting;
  assert.equal(page.data.wisdomDeleteBusy, false);
});

test('leaving the page, switching accounts or changing selection during confirmation cannot delete a stale row', async () => {
  for (const leave of ['onHide', 'onUnload', 'tab', 'reenter', 'account', 'selection']) {
    const { page, calls, setAccount } = await open({ confirm() {} });
    draft(page);
    const deleting = page.deleteWisdom();
    if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
    else if (leave === 'reenter') { page.onHide(); await page.onShow(); }
    else if (leave === 'account') setAccount('oz-other');
    else if (leave === 'selection') page.setData({ selectedWisdom: quote({ _id: 'quote-2' }) });
    else page[leave]();
    calls.modal[0].success({ confirm: true });
    await deleting;
    assert.equal(requests(calls, 'adminDeleteWisdom').length, 0, leave);
    assert.equal(calls.toast.length, 0, leave);
    assert.equal(page.data.wisdomDeleteBusy, false);
    if (!['reenter', 'account', 'selection'].includes(leave)) assertCleared(page);
  }
});

test('failed and malformed deletion responses retain rows and drafts and release the lock for retry', async () => {
  for (const response of [{ success: false, error: '删除失败' }, success({}),
    success({ quoteId: 'other', deleted: true }), success({ quoteId: 'quote-1', deleted: false })]) {
    let retry = false;
    const { page, calls } = await open({ api: (name, data) => data.type === 'adminDeleteWisdom' && !retry ? response : undefined });
    draft(page);
    await page.deleteWisdom();
    assert.ok(page.data.wisdomSaveError);
    assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
    assert.equal(page.data.wisdomQuotes.length, 1);
    assert.equal(page.data.wisdomDeleteBusy, false);
    assert.equal(calls.toast.length, 0);
    retry = true;
    await page.deleteWisdom();
    assert.equal(requests(calls, 'adminDeleteWisdom').length, 2);
    assert.equal(page.data.wisdomQuotes.length, 0);
  }
});

test('a failed confirmation dialog preserves the draft and releases the lock', async () => {
  const { page, calls } = await open({ confirm(options) { options.fail({ errMsg: '弹窗失败' }); } });
  draft(page);
  await page.deleteWisdom();
  assert.equal(page.data.wisdomSaveError, '弹窗失败');
  assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
  assert.equal(page.data.wisdomDeleteBusy, false);
  assert.equal(requests(calls, 'adminDeleteWisdom').length, 0);
  await page.saveWisdom();
  assert.equal(requests(calls, 'adminUpdateWisdom').length, 1);
});

test('malformed successful saves never discard the draft or claim that a mutation succeeded', async () => {
  for (const creating of [false, true]) {
    const malformed = [{}, { quote: null }, { quote: quote({ _id: '' }) },
      { quote: quote({ _id: 123, content: '新正文' }) }, { quote: quote({ content: '不匹配的正文' }) }];
    if (!creating) malformed.push({ quote: quote({ _id: 'wrong-row', content: '新正文' }) });
    for (const data of malformed) {
      const { page, calls } = await open({ api: (name, request) => request.type === (creating ? 'adminCreateWisdom' : 'adminUpdateWisdom') ? success(data) : undefined });
      if (creating) page.newWisdom();
      else page.editWisdom(event({ id: 'quote-1' }));
      page.onWisdomContentInput(input('新正文'));
      await page.saveWisdom();
      assert.match(page.data.wisdomSaveError, /刷新确认/);
      assert.equal(page.data.wisdomContent, '新正文');
      assert.equal(page.data.wisdomEditorOpen, true);
      assert.equal(page.data.wisdomQuotes[0].content, quote().content);
      assert.equal(calls.toast.length, 0);
      assert.equal(page.data.wisdomSaveBusy, false);
    }
  }
});

test('malformed lists never replace loaded rows or clear an unsaved editor', async () => {
  for (const data of [{}, { quotes: null, total: 0, nextCursor: '' },
    { quotes: [quote()], total: -1, nextCursor: '' }, { quotes: [quote()], total: '1', nextCursor: '' },
    { quotes: [quote()], total: 1 }, { quotes: [quote({ _id: '' })], total: 1, nextCursor: '' }]) {
    let malformed = false;
    const { page } = await open({ api: (name, request) => request.type === 'adminListWisdom' && malformed ? success(data) : undefined });
    draft(page);
    malformed = true;
    await page.loadWisdom();
    assert.match(page.data.wisdomError, /返回异常/);
    assert.equal(page.data.wisdomQuotes.length, 1);
    assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
    assert.equal(page.data.wisdomEditorOpen, true);
    assert.equal(page.data.wisdomLoading, false);
  }
  const { page } = await open({ api: (name, data) => data.type === 'adminListWisdom' ? success({}) : undefined });
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, false);
  assert.match(page.data.accessError, /返回异常/);
  assertCleared(page);
});

test('reload locks editor changes and deletion until the newest rows arrive', async () => {
  const pending = deferred();
  let waiting = false;
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListWisdom' && waiting ? pending.promise : undefined });
  draft(page);
  waiting = true;
  const loading = page.loadWisdom();
  page.newWisdom();
  page.editWisdom(event({ id: 'quote-1' }));
  page.cancelWisdomEdit();
  page.onWisdomContentInput(input('加载中改动'));
  await page.saveWisdom();
  await page.deleteWisdom();
  assert.equal(page.data.wisdomContent, '心中有爱，眼里有光');
  assert.equal(calls.modal.length, 0);
  assert.equal(requests(calls, 'adminUpdateWisdom').length, 0);
  pending.resolve(list([quote({ content: '最新正文' })]));
  await loading;
  assert.equal(page.data.wisdomEditorOpen, false);
  assert.equal(page.data.wisdomQuotes[0].content, '最新正文');
});

test('hide, unload and tab changes clear drafts and ignore late list responses', async () => {
  for (const leave of ['onHide', 'onUnload', 'tab']) {
    const pending = deferred();
    const { page } = await open({ api: (name, data) => data.type === 'adminListWisdom'
      ? data.cursor ? pending.promise : list([quote()], 'next', 2) : undefined });
    draft(page);
    const loading = page.loadMoreWisdom();
    if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
    else page[leave]();
    assertCleared(page);
    pending.resolve(list([quote({ _id: 'late' })], 'late', 3));
    await loading;
    assertCleared(page);
  }
});

test('late mutation responses never overwrite a reopened page, a new tab or another account', async () => {
  for (const method of ['saveWisdom', 'deleteWisdom']) {
    for (const leave of ['onHide', 'onUnload', 'tab', 'reenter', 'account']) {
      const type = method === 'saveWisdom' ? 'adminUpdateWisdom' : 'adminDeleteWisdom';
      const pending = deferred();
      const { page, calls, setAccount } = await open({ api: (name, data) => data.type === type ? pending.promise : undefined });
      draft(page);
      const mutation = page[method]();
      await Promise.resolve();
      assert.equal(requests(calls, type).length, 1);
      if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
      else if (leave === 'reenter') { page.onHide(); await page.onShow(); }
      else if (leave === 'account') setAccount('oz-other');
      else page[leave]();
      pending.resolve(success(method === 'saveWisdom'
        ? { quote: quote({ content: '心中有爱，眼里有光' }) }
        : { quoteId: 'quote-1', deleted: true }));
      await mutation;
      assert.equal(calls.toast.length, 0, `${method}/${leave}`);
      assert.equal(page.data.wisdomSaveBusy, false);
      assert.equal(page.data.wisdomDeleteBusy, false);
      if (leave === 'reenter' || leave === 'account') assert.equal(page.data.wisdomQuotes[0].content, quote().content);
      else assertCleared(page);
    }
  }
});

test('revoked access clears private wisdom state and prevents all later operations', async () => {
  for (const type of ['adminUpdateWisdom', 'adminDeleteWisdom']) {
    const { page, calls } = await open({ api: (name, data) => data.type === type
      ? { success: false, code: 'FORBIDDEN', error: '权限已撤销' } : undefined });
    draft(page);
    await page[type === 'adminUpdateWisdom' ? 'saveWisdom' : 'deleteWisdom']();
    assert.equal(page.data.authorized, false);
    assert.equal(page.data.accessError, '权限已撤销');
    assertCleared(page);
    const count = calls.cloud.length;
    page.newWisdom();
    page.onWisdomContentInput(input('不能提交'));
    await page.saveWisdom();
    await page.deleteWisdom();
    await page.loadWisdom();
    await page.searchWisdom();
    assert.equal(calls.cloud.length, count);
    assert.deepEqual(calls.alerts, ['clear']);
  }
});

test('stale forbidden responses cannot revoke a newly activated tab', async () => {
  for (const type of ['adminUpdateWisdom', 'adminDeleteWisdom', 'adminListWisdom']) {
    const pending = deferred();
    let waitList = false;
    const { page, calls } = await open({ api: (name, data) => data.type === type && (type !== 'adminListWisdom' || waitList) ? pending.promise : undefined });
    draft(page);
    waitList = true;
    const waiting = type === 'adminListWisdom' ? page.loadWisdom() : page[type === 'adminUpdateWisdom' ? 'saveWisdom' : 'deleteWisdom']();
    await Promise.resolve();
    await page.onTabChange(event({ tab: 'team' }));
    pending.resolve({ success: false, code: 'FORBIDDEN', error: '旧请求无权限' });
    await waiting;
    assert.equal(page.data.tab, 'team');
    assert.equal(page.data.authorized, true);
    assert.equal(page.data.accessError, '');
    assertCleared(page);
    assert.equal(calls.alerts.length, 0);
  }
});

test('an outdated cloud function produces a recoverable deployment error on the wisdom tab', async () => {
  const { page } = await open({ api: () => ({ success: false, error: '未知的操作类型' }) });
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, false);
  assert.match(page.data.accessError, /部署 adminManager/);
  assertCleared(page);
});
