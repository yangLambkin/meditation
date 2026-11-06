const test = require('node:test');
const assert = require('node:assert/strict');
const { createPage, persistedQueue } = require('./helpers/practicePage');

const input = (page, value) => page.onFormValue({ detail: { value } });

test('kindness defaults to one and saves the actual number of deeds', async () => {
  const h = createPage();
  h.page.openForm('kindness');
  assert.equal(h.page.data.formValue, '1');
  input(h.page, '12');
  h.page.onFormContent({ detail: { value: '帮助邻里，整理公共空间' } });
  await h.page.saveForm();
  assert.equal(h.calls.enqueue[0].payload.quantity, 12);
  assert.equal(h.calls.enqueue[0].payload.content, '帮助邻里，整理公共空间');
});

test('all quantity limits show an immediate, precise failure and retain editable drafts', async () => {
  for (const [type, maximum, unit] of [['walking', 1440, '分钟'], ['learning', 1440, '分钟'], ['clapping', 1440, '分钟'], ['instant', 1000000, '次'], ['kindness', 100000, '件']]) {
    const h = createPage();
    h.page.openForm(type);
    h.page.onFormContent({ detail: { value: '帮助他人' } });
    h.page.onFormReflection({ detail: { value: '保留感悟' } });
    for (const value of ['0', '-1', '1.5', String(maximum + 1)]) {
      input(h.page, value);
      await h.page.saveForm();
      assert.match(h.page.data.formError, new RegExp(`1 至 ${maximum} ${unit}.*最多 ${maximum}`));
      assert.equal(h.page.data.showForm, true);
      assert.equal(h.page.data.formPending, false);
      assert.equal(h.page.data.formBusy, false);
      assert.equal(h.page.data.formValue, value);
      assert.equal(h.page.data.formReflection, '保留感悟');
      assert.equal(h.calls.toast.at(-1).icon, 'none');
    }
    assert.equal(h.calls.enqueue.length, 0);
    input(h.page, String(maximum));
    await h.page.saveForm();
    assert.equal(h.calls.enqueue.length, 1);
    assert.equal(h.page.data.showForm, false);
  }
});

test('a first definite server validation rejection returns the draft for correction and uses a fresh request', async () => {
  const sent = [];
  const h = createPage({ queueFactory: persistedQueue({
    create: async (type, payload, requestId) => {
      sent.push({ type, payload, requestId });
      if (sent.length === 1) throw Object.assign(new Error('善事件数须为 1 至 100000 的整数'), { code: 'HTTP_400', status: 400 });
      return { id: 'deed-1' };
    }
  }) });
  h.page.openForm('kindness');
  h.page.onFormContent({ detail: { value: '帮助邻里' } });
  input(h.page, '8');
  await h.page.saveForm();
  assert.equal(h.queue.getPending().length, 0);
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formPending, false);
  assert.equal(h.page.data.formBusy, false);
  assert.equal(h.page.data.formValue, '8');
  assert.match(h.page.data.formError, /善事件数/);
  input(h.page, '3');
  await h.page.saveForm();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(sent[1].payload.quantity, 3);
  assert.equal(h.page.data.showForm, false);
});

test('a validation response after an unknown outcome retains the frozen request', async () => {
  const sent = [];
  const h = createPage({ queueFactory: persistedQueue({
    create: async (type, payload, requestId) => {
      sent.push({ payload, requestId });
      if (sent.length === 1) throw Object.assign(new Error('连接中断，结果未知'), { code: 'NETWORK_ERROR', retryable: true });
      throw Object.assign(new Error('请核对数量'), { code: 'HTTP_400', status: 400 });
    }
  }) });
  h.page.openForm('kindness');
  h.page.onFormContent({ detail: { value: '帮助邻里' } });
  input(h.page, '8');
  await h.page.saveForm();
  assert.equal(h.queue.getPending().length, 1);
  assert.equal(h.page.data.formPending, true);
  assert.equal(h.page.data.formBusy, false);
  assert.equal(h.queue.releaseRejected(h.queue.getPending()[0].id), false);
  input(h.page, '3');
  assert.equal(h.page.data.formValue, '8');
  assert.equal(sent[0].requestId, sent[1].requestId);
});
