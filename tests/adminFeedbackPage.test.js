const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dateUtil = require('../miniprogram/utils/dateUtil.js');

const success = data => ({ success: true, data });
const input = value => ({ detail: { value } });
const event = dataset => ({ currentTarget: { dataset } });
const feedback = overrides => ({ _id: 'feedback-1', content: '计时页面的建议', contact: 'user@example.com',
  nickname: '静心', studentNumber: 'BJ001', status: 'pending', reply: '',
  createdAt: '2026-09-29T02:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z', handledAt: null, ...overrides });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ api, access = true, confirm = true } = {}) {
  let definition;
  const calls = { cloud: [], toast: [], alerts: [], refresh: [], modal: [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/admin/admin.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp() { return {
      clearAdminSyncAlert() { calls.alerts.push('clear'); },
      refreshSyncAlert(options) { calls.alerts.push(options.force === true ? 'force-refresh' : 'refresh'); }
    }; },
    require(name) {
      if (name.includes('dateUtil')) return dateUtil;
      if (name.includes('cloudApi')) return { async callCloudFunction(name, data) {
        calls.cloud.push({ name, data });
        if (data.type === 'getAccess') return { result: success({ isAdmin: typeof access === 'function' ? access() : access }) };
        let result = api && await api(name, data);
        if (result === undefined) result = success(data.type === 'adminListFeedback' ? { feedbacks: [feedback()], nextCursor: '' }
          : data.type === 'adminUpdateFeedback' ? { feedback: feedback({ status: data.status, reply: data.reply,
            updatedAt: '2026-09-29T03:00:00.000Z', handledAt: '2026-09-29T03:00:00.000Z' }) }
            : data.type === 'adminDeleteFeedback' ? { feedbackId: data.feedbackId, deleted: true }
              : { teams: [], logs: [], runs: [], errors: [] });
        return { result };
      } };
      throw new Error(`Unexpected require: ${name}`);
    },
    wx: { showToast(value) { calls.toast.push(value); }, stopPullDownRefresh() { calls.refresh.push('stopped'); },
      showModal(options) { calls.modal.push(options); if (typeof confirm === 'function') confirm(options); else options.success({ confirm }); } },
    Date, console, setTimeout, clearTimeout
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  page.data.tab = 'feedback';
  return { page, calls };
}
async function open(options) {
  const result = harness(options);
  await result.page.onShow();
  return result;
}
const requests = (calls, type) => calls.cloud.filter(call => call.data.type === type);
function draft(page, reply = '我们会核实这个问题') {
  page.selectFeedback(event({ id: 'feedback-1' }));
  page.onFeedbackStatusChange(input(1));
  page.onFeedbackReplyInput(input(reply));
}
function assertCleared(page) {
  assert.equal(page.data.feedbacks.length, 0);
  assert.equal(page.data.feedbackCursor, '');
  assert.equal(page.data.selectedFeedback, null);
  assert.equal(page.data.feedbackReply, '');
  assert.equal(page.data.feedbackSaveError, '');
  assert.equal(page.data.feedbackError, '');
}

test('feedback independently authorizes, defaults to pending and formats submission dates in Beijing time', async () => {
  const { page, calls } = await open();
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.feedbackFilter, 'pending');
  assert.equal(page.data.feedbacks[0].statusText, '待处理');
  assert.equal(page.data.feedbacks[0].createdText, '2026-09-29 10:00:00');
  assert.equal(page.data.feedbacks[0].contact, 'user@example.com');
  assert.deepEqual(calls.cloud.map(call => call.name), ['adminManager', 'adminManager']);
  assert.equal(calls.cloud[1].data.status, 'pending');
  assert.equal(calls.cloud[1].data.data, undefined, 'adminManager accepts top-level arguments');
  const denied = await open({ access: false });
  assert.equal(denied.page.data.entryAuthorized, false);
  assert.equal(denied.calls.cloud.length, 1);
  assertCleared(denied.page);
});

test('status filters use fresh pagination, append pages without duplicates and stop at the final cursor', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListFeedback'
    ? success({ feedbacks: data.cursor ? [feedback({ status: data.status }), feedback({ _id: 'feedback-2', status: data.status })]
      : [feedback({ status: data.status })], nextCursor: data.cursor ? '' : `cursor-${data.status}` }) : undefined });
  draft(page);
  await page.onFeedbackFilterChange(event({ status: 'processing' }));
  assert.equal(page.data.feedbackFilter, 'processing');
  assert.equal(page.data.selectedFeedback, null);
  assert.equal(page.data.feedbackReply, '');
  assert.equal(requests(calls, 'adminListFeedback').at(-1).data.cursor, undefined);
  await page.loadMoreFeedback();
  assert.equal(requests(calls, 'adminListFeedback').at(-1).data.cursor, 'cursor-processing');
  assert.equal(page.data.feedbacks.length, 2);
  assert.equal(page.data.feedbackCursor, '');
  const count = calls.cloud.length;
  await page.loadMoreFeedback();
  await page.onFeedbackFilterChange(event({ status: 'invalid' }));
  assert.equal(calls.cloud.length, count);
});

test('successful handling sends the current revision, removes changed statuses from the filter and publishes the reply', async () => {
  const { page, calls } = await open();
  draft(page, '  已在排查，谢谢反馈。  ');
  await page.saveFeedback();
  const request = requests(calls, 'adminUpdateFeedback')[0];
  assert.equal(request.name, 'adminManager');
  assert.deepEqual(JSON.parse(JSON.stringify(request.data)), { type: 'adminUpdateFeedback', feedbackId: 'feedback-1',
    status: 'processing', reply: '已在排查，谢谢反馈。', expectedUpdatedAt: '2026-09-29T02:00:00.000Z' });
  assert.equal(page.data.feedbacks.length, 0);
  assert.equal(page.data.selectedFeedback, null);
  assert.equal(page.data.feedbackSaveBusy, false);
  assert.match(page.data.feedbackMessage, /已保存/);
  assert.equal(calls.toast.length, 1);
  assert.deepEqual(calls.alerts, ['force-refresh']);
});

test('all feedback retains the saved row and uses its new revision for the next edit', async () => {
  const { page, calls } = await open();
  await page.onFeedbackFilterChange(event({ status: 'all' }));
  draft(page);
  await page.saveFeedback();
  assert.equal(page.data.feedbacks[0].statusText, '处理中');
  assert.equal(page.data.feedbacks[0].reply, '我们会核实这个问题');
  assert.equal(page.data.feedbacks[0].handledText, '2026-09-29 11:00:00');
  page.selectFeedback(event({ id: 'feedback-1' }));
  page.onFeedbackStatusChange(input(2));
  await page.saveFeedback();
  assert.equal(requests(calls, 'adminUpdateFeedback').at(-1).data.expectedUpdatedAt, '2026-09-29T03:00:00.000Z');
  assert.equal(page.data.feedbacks[0].statusText, '已处理');
});

test('failed saves and refreshes preserve drafts and errors until a successful explicit reload', async () => {
  let denyRefresh = false;
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback'
    ? { success: false, error: '服务暂不可用' } : denyRefresh && data.type === 'adminListFeedback'
      ? { success: false, error: '读取失败' } : undefined });
  draft(page);
  await page.saveFeedback();
  assert.equal(page.data.feedbackSaveError, '服务暂不可用');
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(page.data.feedbackStatusIndex, 1);
  assert.equal(page.data.selectedFeedback.status, 'pending');
  assert.equal(page.data.feedbackSaveBusy, false);
  assert.equal(calls.toast.length, 0);
  denyRefresh = true;
  await page.onPullDownRefresh();
  assert.equal(page.data.feedbackError, '读取失败');
  assert.equal(page.data.feedbackSaveError, '服务暂不可用');
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(page.data.feedbacks.length, 1);
  assert.deepEqual(calls.refresh, ['stopped']);
  denyRefresh = false;
  await page.loadFeedback(event({}));
  assert.equal(requests(calls, 'adminListFeedback').at(-1).data.cursor, undefined);
  assert.equal(page.data.feedbackSaveError, '');
  assert.equal(page.data.selectedFeedback, null);
});

test('conflicts preserve the draft and require a reload before another save', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback'
    ? { success: false, code: 'CONFLICT', error: '数据已变化' } : undefined });
  draft(page);
  await page.saveFeedback();
  assert.equal(page.data.feedbackConflict, true);
  assert.match(page.data.feedbackSaveError, /重新加载反馈/);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  await page.saveFeedback();
  assert.equal(requests(calls, 'adminUpdateFeedback').length, 1);
  await page.loadFeedback();
  assert.equal(page.data.feedbackConflict, false);
});

test('duplicate saves, edits, filter changes and refreshes are locked while a save is pending', async () => {
  const pending = deferred();
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback' ? pending.promise : undefined });
  draft(page);
  const saving = page.saveFeedback();
  await page.saveFeedback();
  await page.deleteFeedback();
  await page.onFeedbackFilterChange(event({ status: 'all' }));
  await page.loadFeedback();
  page.onFeedbackStatusChange(input(2));
  page.onFeedbackReplyInput(input('不能覆盖保存中的回复'));
  page.selectFeedback(event({ id: 'feedback-1' }));
  assert.equal(requests(calls, 'adminUpdateFeedback').length, 1);
  assert.equal(calls.modal.length, 0);
  assert.equal(requests(calls, 'adminListFeedback').length, 1);
  assert.equal(page.data.feedbackStatusIndex, 1);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(page.data.feedbackFilter, 'pending');
  pending.resolve(success({ feedback: feedback({ status: 'processing', reply: '我们会核实这个问题' }) }));
  await saving;
  assert.equal(page.data.feedbackSaveBusy, false);
});

test('oversized replies never reach the backend and invalid update responses retain the draft', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback' ? success({}) : undefined });
  draft(page, '字'.repeat(1001));
  await page.saveFeedback();
  assert.equal(requests(calls, 'adminUpdateFeedback').length, 0);
  assert.match(page.data.feedbackSaveError, /1000/);
  page.onFeedbackReplyInput(input('回复草稿'));
  await page.saveFeedback();
  assert.match(page.data.feedbackSaveError, /刷新确认/);
  assert.equal(page.data.feedbackReply, '回复草稿');
  assert.equal(calls.toast.length, 0);
});

test('late filter results cannot replace the latest filter', async () => {
  const pending = deferred();
  const { page } = await open({ api: (name, data) => data.type === 'adminListFeedback'
    ? data.status === 'processing' ? pending.promise : success({ feedbacks: [feedback({ status: data.status })] }) : undefined });
  const earlier = page.onFeedbackFilterChange(event({ status: 'processing' }));
  await page.onFeedbackFilterChange(event({ status: 'resolved' }));
  pending.resolve(success({ feedbacks: [feedback({ _id: 'stale', status: 'processing' })], nextCursor: 'stale-cursor' }));
  await earlier;
  assert.equal(page.data.feedbackFilter, 'resolved');
  assert.equal(page.data.feedbacks[0]._id, 'feedback-1');
  assert.equal(page.data.feedbacks[0].status, 'resolved');
  assert.equal(page.data.feedbackCursor, '');
  assert.equal(page.data.feedbackLoading, false);
});

test('hide, unload and tab changes clear private feedback and discard late page results', async () => {
  for (const leave of ['onHide', 'onUnload', 'tab']) {
    const pending = deferred();
    const { page } = await open({ api: (name, data) => data.type === 'adminListFeedback'
      ? data.cursor ? pending.promise : success({ feedbacks: [feedback()], nextCursor: 'next' }) : undefined });
    draft(page);
    const loading = page.loadMoreFeedback();
    if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
    else page[leave]();
    assertCleared(page);
    pending.resolve(success({ feedbacks: [feedback({ _id: 'late' })], nextCursor: 'late' }));
    await loading;
    assertCleared(page);
  }
});

test('a save completing after leaving or reentering cannot restore private drafts or toast', async () => {
  for (const reenter of [false, true]) {
    const pending = deferred();
    const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback' ? pending.promise : undefined });
    draft(page);
    const saving = page.saveFeedback();
    page.onHide();
    assertCleared(page);
    if (reenter) {
      await page.onShow();
      draft(page, '新草稿');
      await page.saveFeedback();
      assert.equal(requests(calls, 'adminUpdateFeedback').length, 1);
    }
    pending.resolve(success({ feedback: feedback({ status: 'resolved', reply: '旧回复' }) }));
    await saving;
    assert.equal(calls.toast.length, 0);
    assert.equal(page.data.feedbackSaveBusy, false);
    if (reenter) assert.equal(page.data.feedbacks[0].status, 'pending');
    else assertCleared(page);
  }
});

test('revoked access clears feedback and blocks subsequent actions', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback'
    ? { success: false, code: 'FORBIDDEN', error: '权限已撤销' } : undefined });
  draft(page);
  await page.saveFeedback();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.accessError, '权限已撤销');
  assertCleared(page);
  assert.deepEqual(calls.alerts, ['clear']);
  const count = calls.cloud.length;
  await page.saveFeedback();
  await page.loadFeedback();
  await page.onFeedbackFilterChange(event({ status: 'all' }));
  page.onFeedbackReplyInput(input('private'));
  assert.equal(calls.cloud.length, count);
  assertCleared(page);
});

test('a stale forbidden save cannot revoke a newly opened tab', async () => {
  const pending = deferred();
  const { page } = await open({ api: (name, data) => data.type === 'adminUpdateFeedback' ? pending.promise : undefined });
  draft(page);
  const saving = page.saveFeedback();
  await page.onTabChange(event({ tab: 'team' }));
  pending.resolve({ success: false, code: 'FORBIDDEN', error: '旧请求无权限' });
  await saving;
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.tab, 'team');
  assert.equal(page.data.accessError, '');
  assertCleared(page);
});

test('the feedback tab remains recoverable when its cloud function needs deployment', async () => {
  const { page } = await open({ api: () => ({ success: false, error: '未知的操作类型' }) });
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, false);
  assert.match(page.data.accessError, /部署 adminManager/);
  assertCleared(page);
});

test('canceling deletion preserves the row, draft and earlier error without calling the backend', async () => {
  const { page, calls } = await open({ confirm: false });
  draft(page);
  page.setData({ feedbackSaveError: '上次操作失败' });
  await page.deleteFeedback();
  assert.equal(calls.modal.length, 1);
  assert.match(calls.modal[0].content, /无法恢复/);
  assert.match(calls.modal[0].content, /用户也将无法查看/);
  assert.equal(requests(calls, 'adminDeleteFeedback').length, 0);
  assert.equal(page.data.feedbacks.length, 1);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(page.data.feedbackSaveError, '上次操作失败');
  assert.equal(page.data.feedbackDeleteBusy, false);
  assert.equal(calls.toast.length, 0);
  assert.equal(calls.alerts.length, 0);
});

test('confirmed deletion removes only its row, retains the cursor and refreshes all remaining alerts', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminListFeedback'
    ? success({ feedbacks: [feedback(), feedback({ _id: 'feedback-2' })], nextCursor: 'next-page' }) : undefined });
  draft(page);
  await page.deleteFeedback();
  assert.deepEqual(JSON.parse(JSON.stringify(requests(calls, 'adminDeleteFeedback')[0])), { name: 'adminManager', data: {
    type: 'adminDeleteFeedback', feedbackId: 'feedback-1', expectedUpdatedAt: '2026-09-29T02:00:00.000Z'
  } });
  assert.deepEqual(Array.from(page.data.feedbacks, row => row._id), ['feedback-2']);
  assert.equal(page.data.feedbackCursor, 'next-page');
  assert.equal(page.data.selectedFeedback, null);
  assert.equal(page.data.feedbackReply, '');
  assert.equal(page.data.feedbackDeleteBusy, false);
  assert.match(page.data.feedbackMessage, /已删除/);
  assert.equal(calls.toast[0].title, '反馈已删除');
  assert.deepEqual(calls.alerts, ['force-refresh']);
  assert.equal(requests(calls, 'adminListFeedback').length, 1);
});

test('deletion locks duplicate clicks, saves, edits, filters and loads during confirmation and the request', async () => {
  const pending = deferred();
  const { page, calls } = await open({ confirm() {}, api: (name, data) => data.type === 'adminDeleteFeedback' ? pending.promise : undefined });
  draft(page);
  const deleting = page.deleteFeedback();
  for (const stage of ['confirmation', 'request']) {
    await page.deleteFeedback();
    await page.saveFeedback();
    await page.onFeedbackFilterChange(event({ status: 'all' }));
    await page.loadFeedback();
    await page.onPullDownRefresh();
    page.onFeedbackStatusChange(input(2));
    page.onFeedbackReplyInput(input('不能覆盖删除中的草稿'));
    page.selectFeedback(event({ id: 'feedback-1' }));
    assert.equal(calls.modal.length, 1);
    assert.equal(requests(calls, 'adminUpdateFeedback').length, 0);
    assert.equal(requests(calls, 'adminListFeedback').length, 1);
    assert.equal(page.data.feedbackStatusIndex, 1);
    assert.equal(page.data.feedbackReply, '我们会核实这个问题');
    assert.equal(page.data.feedbackFilter, 'pending');
    assert.equal(page.data.selectedFeedback._id, 'feedback-1');
    assert.equal(page.data.feedbackDeleteBusy, true);
    assert.equal(page.data.feedbackSaveBusy, false);
    if (stage === 'confirmation') calls.modal[0].success({ confirm: true });
  }
  assert.equal(requests(calls, 'adminDeleteFeedback').length, 1);
  pending.resolve(success({ feedbackId: 'feedback-1', deleted: true }));
  await deleting;
  assert.equal(page.data.feedbackDeleteBusy, false);
});

test('a feedback reload blocks deletion and draft changes until the loaded rows are applied', async () => {
  const pending = deferred();
  let loading = false;
  const { page, calls } = await open({ api: (name, data) => loading && data.type === 'adminListFeedback' ? pending.promise : undefined });
  draft(page);
  loading = true;
  const refresh = page.loadFeedback();
  await page.deleteFeedback();
  page.onFeedbackReplyInput(input('加载中不能编辑'));
  page.onFeedbackStatusChange(input(2));
  assert.equal(calls.modal.length, 0);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(page.data.feedbackStatusIndex, 1);
  pending.resolve(success({ feedbacks: [feedback()] }));
  await refresh;
});

test('failed and malformed deletions retain the draft and can be retried', async () => {
  for (const response of [{ success: false, error: '删除失败' }, success({}),
    success({ feedbackId: 'feedback-2', deleted: true }), success({ feedbackId: 'feedback-1', deleted: false })]) {
    let retry = false;
    const { page, calls } = await open({ api: (name, data) => data.type === 'adminDeleteFeedback' && !retry ? response : undefined });
    draft(page);
    await page.deleteFeedback();
    assert.ok(page.data.feedbackSaveError);
    assert.equal(page.data.feedbacks.length, 1);
    assert.equal(page.data.selectedFeedback._id, 'feedback-1');
    assert.equal(page.data.feedbackReply, '我们会核实这个问题');
    assert.equal(page.data.feedbackStatusIndex, 1);
    assert.equal(page.data.feedbackDeleteBusy, false);
    assert.equal(page.data.feedbackConflict, false);
    assert.equal(calls.toast.length, 0);
    assert.equal(calls.alerts.length, 0);
    retry = true;
    await page.deleteFeedback();
    assert.equal(requests(calls, 'adminDeleteFeedback').length, 2);
    assert.equal(page.data.feedbacks.length, 0);
  }
});

test('a failed confirmation dialog releases the mutation lock and preserves the draft', async () => {
  const { page, calls } = await open({ confirm(options) { options.fail({ errMsg: '确认弹窗失败' }); } });
  draft(page);
  await page.deleteFeedback();
  assert.equal(page.data.feedbackSaveError, '确认弹窗失败');
  assert.equal(page.data.feedbackDeleteBusy, false);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  assert.equal(requests(calls, 'adminDeleteFeedback').length, 0);
  await page.saveFeedback();
  assert.equal(requests(calls, 'adminUpdateFeedback').length, 1);
});

test('conflicting deletions require a reload before deleting or saving again', async () => {
  const { page, calls } = await open({ api: (name, data) => data.type === 'adminDeleteFeedback'
    ? { success: false, code: 'CONFLICT', error: '数据已变化' } : undefined });
  draft(page);
  await page.deleteFeedback();
  assert.equal(page.data.feedbackConflict, true);
  assert.match(page.data.feedbackSaveError, /重新加载反馈/);
  assert.equal(page.data.feedbackReply, '我们会核实这个问题');
  await page.deleteFeedback();
  await page.saveFeedback();
  assert.equal(calls.modal.length, 1);
  assert.equal(requests(calls, 'adminDeleteFeedback').length, 1);
  assert.equal(requests(calls, 'adminUpdateFeedback').length, 0);
  await page.loadFeedback();
  assert.equal(page.data.feedbackConflict, false);
  assert.equal(page.data.selectedFeedback, null);
});

test('leaving or changing the selected row while confirmation is open never sends a late deletion', async () => {
  for (const leave of ['onHide', 'onUnload', 'tab', 'reenter', 'selection']) {
    const { page, calls } = await open({ confirm() {} });
    draft(page);
    const deleting = page.deleteFeedback();
    if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
    else if (leave === 'selection') page.setData({ selectedFeedback: feedback({ _id: 'feedback-2' }) });
    else if (leave === 'reenter') { page.onHide(); await page.onShow(); }
    else page[leave]();
    calls.modal[0].success({ confirm: true });
    await deleting;
    assert.equal(requests(calls, 'adminDeleteFeedback').length, 0);
    assert.equal(calls.toast.length, 0);
    assert.equal(page.data.feedbackDeleteBusy, false);
    if (!['reenter', 'selection'].includes(leave)) assertCleared(page);
  }
});

test('late deletion responses cannot restore private rows, clear newer feedback or display a toast', async () => {
  for (const leave of ['onHide', 'onUnload', 'tab', 'reenter', 'selection']) {
    const pending = deferred();
    const { page, calls } = await open({ api: (name, data) => data.type === 'adminDeleteFeedback' ? pending.promise : undefined });
    draft(page);
    const deleting = page.deleteFeedback();
    await Promise.resolve();
    assert.equal(requests(calls, 'adminDeleteFeedback').length, 1);
    if (leave === 'tab') await page.onTabChange(event({ tab: 'team' }));
    else if (leave === 'selection') page.setData({ selectedFeedback: feedback({ _id: 'feedback-2' }) });
    else if (leave === 'reenter') {
      page.onHide();
      await page.onShow();
      await page.deleteFeedback();
      assert.equal(requests(calls, 'adminDeleteFeedback').length, 1);
    } else page[leave]();
    pending.resolve(success({ feedbackId: 'feedback-1', deleted: true }));
    await deleting;
    assert.equal(calls.toast.length, 0);
    assert.equal(calls.alerts.length, 0);
    assert.equal(page.data.feedbackDeleteBusy, false);
    if (['reenter', 'selection'].includes(leave)) assert.equal(page.data.feedbacks.length, 1);
    else assertCleared(page);
  }
});

test('revoked access before confirmation or in the delete response clears private data and prevents further mutations', async () => {
  for (const revokeBeforeConfirmation of [true, false]) {
    const { page, calls } = await open({ confirm: revokeBeforeConfirmation ? () => {} : true,
      api: (name, data) => ['adminDeleteFeedback', 'permissionCheck'].includes(data.type)
        ? { success: false, code: 'FORBIDDEN', error: '权限已撤销' } : undefined });
    draft(page);
    const deleting = page.deleteFeedback();
    if (revokeBeforeConfirmation) {
      await assert.rejects(page.callAdmin('adminManager', 'permissionCheck'), /权限已撤销/);
      calls.modal[0].success({ confirm: true });
    }
    await deleting;
    assert.equal(requests(calls, 'adminDeleteFeedback').length, revokeBeforeConfirmation ? 0 : 1);
    assert.equal(page.data.authorized, false);
    assert.equal(page.data.accessError, '权限已撤销');
    assert.equal(page.data.feedbackDeleteBusy, false);
    assertCleared(page);
    assert.deepEqual(calls.alerts, ['clear']);
    await page.deleteFeedback();
    await page.saveFeedback();
    assert.equal(calls.modal.length, 1);
    assert.equal(calls.toast.length, 0);
  }
  const denied = await open({ access: false });
  await denied.page.deleteFeedback();
  assert.equal(denied.calls.modal.length, 0);
});

test('a stale forbidden deletion cannot revoke a newly opened tab', async () => {
  const pending = deferred();
  const { page } = await open({ api: (name, data) => data.type === 'adminDeleteFeedback' ? pending.promise : undefined });
  draft(page);
  const deleting = page.deleteFeedback();
  await Promise.resolve();
  await page.onTabChange(event({ tab: 'team' }));
  pending.resolve({ success: false, code: 'FORBIDDEN', error: '旧请求无权限' });
  await deleting;
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.tab, 'team');
  assert.equal(page.data.accessError, '');
  assertCleared(page);
});
