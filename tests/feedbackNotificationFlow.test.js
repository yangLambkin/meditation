const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { feedbackHarness } = require('./feedbackCloud.test');

// The real feedback entrypoints and the real administrator alert entrypoint
// share one mutable fake collection throughout each notification workflow.
function workflowHarness() {
  const context = { OPENID: 'owner' };
  const backend = feedbackHarness({ context });
  const authorization = backend.authorization.db;
  const db = {
    ...authorization,
    command: { in: values => ({ in: values }) },
    collection(name) {
      if (!['feedback', 'bijing_sync_errors'].includes(name)) return authorization.collection(name);
      let limit = 20, filter = {};
      return {
        where(value) { filter = value; return this; },
        field(value) { assert.deepEqual(JSON.parse(JSON.stringify(value)), { _id: true }); return this; },
        limit(value) { limit = value; return this; },
        async get() {
          const rows = name === 'feedback' ? backend.rows.filter(row => filter.status.in.includes(row.status)) : [];
          return { data: structuredClone(rows.slice(0, limit)) };
        }
      };
    }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: { ADMIN_STUDENT_NUMBERS: 'BJ0099' } },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => context, database: () => db };
      return require(`../cloudfunctions/adminManager/${name.slice(2)}`);
    }
  });
  return {
    ...backend,
    async as(openid, event) {
      context.OPENID = openid;
      if (event.type === 'getSyncAlert') return JSON.parse(JSON.stringify(await exports.main(event)));
      return event.type.startsWith('admin') ? backend.admin(event) : backend.user(event);
    }
  };
}

function feedbackPage(backend) {
  let definition;
  const renderCallbacks = [], refreshes = [];
  const application = {
    async refreshSyncAlert(options) {
      refreshes.push(JSON.parse(JSON.stringify(options)));
      application.hasUnread = (await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback;
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/feedback/feedback.js'), 'utf8'), {
    Page(value) { definition = value; }, getApp: () => application,
    wx: { getStorageSync: () => 'owner' },
    require(name) {
      if (name.endsWith('/checkin.js')) return { isUserLoggedIn: () => true };
      if (name.endsWith('/cloudApi.js')) return {
        async callCloudFunction(functionName, event) {
          assert.equal(functionName, 'meditationManager');
          return { result: await backend.as('owner', event) };
        }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return {
    page: { ...definition, data: structuredClone(definition.data), setData(value, callback) {
      Object.assign(this.data, value);
      if (callback) renderCallbacks.push(callback);
    } }, application, refreshes,
    async render() {
      renderCallbacks.splice(0).forEach(callback => callback());
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

const submit = (backend, requestId) => backend.as('owner', {
  type: 'submitFeedback', requestId, content: '希望优化提醒', contact: ''
});
const handle = (backend, feedback, status, reply) => backend.as('admin', {
  type: 'adminUpdateFeedback', feedbackId: feedback._id,
  expectedUpdatedAt: feedback.updatedAt, status, reply
});

test('submission, administrator handling, result notification and rendered acknowledgement form a complete workflow', async () => {
  const backend = workflowHarness();
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, false);
  const submitted = await submit(backend, 'full-workflow');
  assert.equal(submitted.success, true);
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, true);
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, false);

  const processing = await handle(backend, submitted.data.feedback, 'processing', '正在排查');
  assert.equal(processing.success, true);
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, true);
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, false);

  const resolved = await handle(backend, processing.data.feedback, 'resolved', '已经处理完成');
  assert.equal(resolved.success, true);
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, false);
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, true);
  assert.equal((await backend.as('other-user', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, false);

  const view = feedbackPage(backend);
  await view.page.onShow();
  assert.equal(view.page.data.feedbacks[0].reply, '已经处理完成');
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, true,
    'loading the list alone must not consume the result notification');
  assert.equal(backend.rows[0].unreadForUser, true);
  await view.render();
  assert.equal(backend.rows[0].unreadForUser, false);
  assert.equal(view.application.hasUnread, false);
  assert.deepEqual(view.refreshes, [{ force: true }]);
});

test('a reply revised after the list loads remains unread until that new version is rendered', async () => {
  const backend = workflowHarness();
  const submitted = await submit(backend, 'revision-workflow');
  const resolved = await handle(backend, submitted.data.feedback, 'resolved', '第一次处理结果');
  const view = feedbackPage(backend);
  await view.page.onShow();
  const revised = await handle(backend, resolved.data.feedback, 'resolved', '补充后的处理结果');
  assert.equal(revised.success, true);
  await view.render();
  assert.equal(view.page.data.feedbacks[0].reply, '第一次处理结果');
  assert.equal(backend.rows[0].unreadForUser, true);
  assert.equal(view.application.hasUnread, true, 'the old rendered version cannot clear the new reply');

  await view.page.loadFeedback();
  assert.equal(view.page.data.feedbacks[0].reply, '补充后的处理结果');
  await view.render();
  assert.equal(backend.rows[0].unreadForUser, false);
  assert.equal(view.application.hasUnread, false);
});

test('administrator deletion removes only the selected feedback and its corresponding reminder', async () => {
  const backend = workflowHarness();
  const pending = (await submit(backend, 'delete-pending')).data.feedback;
  const submission = (await submit(backend, 'delete-unread')).data.feedback;
  const resolved = (await handle(backend, submission, 'resolved', '已处理')).data.feedback;
  const remove = feedback => backend.as('admin', { type: 'adminDeleteFeedback',
    feedbackId: feedback._id, expectedUpdatedAt: feedback.updatedAt });

  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, true);
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, true);
  assert.equal((await remove(resolved)).success, true);
  assert.equal((await backend.as('owner', { type: 'getFeedbackAlert' })).data.hasUnreadFeedback, false);
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, true,
    'another pending feedback still needs administrator attention');
  for (const [openid, type] of [['owner', 'getMyFeedback'], ['admin', 'adminListFeedback']]) {
    const list = await backend.as(openid, { type, status: 'all' });
    assert.deepEqual(list.data.feedbacks.map(row => row._id), [pending._id]);
  }

  assert.equal((await remove(pending)).success, true);
  assert.equal((await backend.as('admin', { type: 'getSyncAlert' })).data.hasFeedback, false);
  assert.equal((await backend.as('owner', { type: 'getMyFeedback' })).data.feedbacks.length, 0);
  assert.equal((await remove(pending)).success, true, 'a lost deletion response can be retried safely');
});

test('a user acknowledgement after administrator deletion does not recreate feedback or its reminder', async () => {
  const backend = workflowHarness();
  const submission = (await submit(backend, 'delete-before-render')).data.feedback;
  const resolved = (await handle(backend, submission, 'resolved', '处理结果')).data.feedback;
  const view = feedbackPage(backend);
  await view.page.onShow();
  assert.equal(view.page.data.feedbacks.length, 1);
  const deleted = await backend.as('admin', { type: 'adminDeleteFeedback',
    feedbackId: resolved._id, expectedUpdatedAt: resolved.updatedAt });
  assert.equal(deleted.success, true);
  await view.render();
  assert.equal(view.application.hasUnread, false);
  assert.equal(backend.rows.length, 0);
  await view.page.loadFeedback();
  assert.equal(view.page.data.feedbacks.length, 0);
});
