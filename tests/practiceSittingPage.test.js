const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, deferred, createPage } = require('./helpers/practicePage');

const tick = () => new Promise(resolve => setImmediate(resolve));
const sourceTimestamp = Date.parse('2026-10-30T01:15:24.567+08:00');
const sourceRecord = {
  _id: 'meditation-source-7', localId: 'local-source-7', date: '2026-10-29', dayDate: '2026-10-29',
  timestamp: sourceTimestamp, duration: 30, isBackfill: false
};
const mirrorRecord = {
  id: 901, type: 'sitting', source: 'meditation', sourceRecordId: sourceRecord._id,
  recordDate: '2026-10-30', occurredAt: '2026-10-30 00:30:00', durationMinutes: 12,
  reflection: '镜像中的旧感悟', canEdit: false, canDelete: false
};
const event = { type: 'longpress', currentTarget: { dataset: { key: 'sitting:901' } } };
function setup(options = {}) {
  return createPage({ sittingSource: sourceRecord, feed: () => ({ records: [mirrorRecord] }), ...options });
}
async function openEditor(h) {
  await h.page.refresh();
  h.page.showRecordActions(event);
  assert.deepEqual(plain(h.calls.actionSheet.itemList), ['编辑功课', '删除记录']);
  h.calls.actionSheet.success({ tapIndex: 0 });
  await tick();
}
async function requestDelete(h) {
  await h.page.refresh();
  h.page.showRecordActions(event);
  h.calls.actionSheet.success({ tapIndex: 1 });
  assert.equal(h.calls.modal.length, 1);
}

test('both record screens edit the original sitting with complete reflection and millisecond precision', async () => {
  for (const screen of ['home', 'history']) {
    const reflection = '从原记录读取的完整感悟\n\n另一段感悟';
    const h = setup({ screen, readReflection: () => reflection });
    await openEditor(h);
    assert.equal(h.page.data.detail, null, screen);
    assert.equal(h.page.data.showForm, true, screen);
    assert.equal(h.page.data.formEditing, true, screen);
    assert.equal(h.page.data.formType, 'sitting', screen);
    assert.equal(h.page.data.formDate, '2026-10-30', screen);
    assert.equal(h.page.data.formTime, '01:15', screen);
    assert.equal(h.page.data.formValue, '30', screen);
    assert.equal(h.page.data.formReflection, reflection, screen);
    assert.deepEqual(h.calls.reflection[0], { date: sourceRecord.date, identity: {
      recordId: sourceRecord._id, localId: sourceRecord.localId, timestamp: sourceTimestamp
    } }, screen);
    h.page.onFormValue({ detail: { value: '45' } });
    await h.page.saveForm();
    assert.equal(h.calls.updateCheckin.length, 1, screen);
    assert.deepEqual(h.calls.updateCheckin[0].updates, { duration: 45, timestamp: sourceTimestamp, reflection }, screen);
    assert.equal(h.calls.updateCheckin[0].identity.recordId, sourceRecord._id, screen);
    assert.equal(h.calls.updateCheckin[0].date, sourceRecord.date, screen);
    assert.ok(h.calls.updateCheckin[0].options.requestId, screen);
    assert.equal(h.calls.enqueue.length, 0, 'sitting never uses ordinary practice writes');
    assert.equal(h.calls.navigation.length, 0, 'editing stays on the current screen');
    assert.equal(h.page.data.showForm, false, screen);
    assert.ok(h.calls.mirrorResume > 0, screen);
    assert.equal(h.calls.flush.length, 0, 'mirror resume owns queue flushing');
    assert.ok(h.calls.feed.length >= 2, 'successful source changes refresh the feed');
  }
});

test('failed sitting saves preserve fields and retry the same payload with the same request identity', async () => {
  let attempts = 0;
  const h = setup({ updateCheckin: () => ++attempts === 1
    ? { success: false, error: '云端尚未确认修改，请重试' } : { success: true } });
  await openEditor(h);
  h.page.onFormValue({ detail: { value: '41' } });
  h.page.onFormReflection({ detail: { value: '保存我的感悟' } });
  await h.page.saveForm();
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formValue, '41');
  assert.equal(h.page.data.formReflection, '保存我的感悟');
  assert.match(h.page.data.formError, /尚未确认/);
  assert.equal(h.page.data.formBusy, false);
  await h.page.saveForm();
  assert.equal(h.calls.updateCheckin.length, 2);
  assert.deepEqual(h.calls.updateCheckin[0], h.calls.updateCheckin[1]);
  assert.equal(h.page.data.showForm, false);
});

test('sitting detail actions use the same local editor and source deletion flow', async () => {
  const h = setup();
  await h.page.refresh();
  h.page.openDetail(event);
  await h.page.editDetail();
  assert.equal(h.page.data.showForm, true);
  assert.equal(h.page.data.formReflection, '原记录完整感悟');
  h.page.closeForm();
  h.page.openDetail(event);
  h.page.deleteDetail();
  assert.equal(h.calls.modal.length, 1);
  assert.match(h.calls.modal[0].content, /原静坐记录.*删除/);
  await h.calls.modal[0].success({ confirm: true });
  assert.equal(h.calls.deleteCheckin[0].identity.recordId, sourceRecord._id);
  assert.equal(h.calls.navigation.length, 0);
  assert.equal(h.page.data.detail, null);
});

test('rapid repeated sitting save taps send one source update', async () => {
  const write = deferred();
  const h = setup({ updateCheckin: () => write.promise });
  await openEditor(h);
  const first = h.page.saveForm();
  await tick();
  await h.page.saveForm();
  assert.equal(h.calls.updateCheckin.length, 1);
  assert.equal(h.page.data.formBusy, true);
  write.resolve({ success: true });
  await first;
  await h.page.saveForm();
  assert.equal(h.calls.updateCheckin.length, 1);
  assert.equal(h.page.data.showForm, false);
});

test('editing only duration retains a backfill record manually assigned business date', async () => {
  const h = setup({ sittingSource: { ...sourceRecord, date: '2026-10-20', dayDate: '2026-10-20', isBackfill: true } });
  await openEditor(h);
  h.page.onFormValue({ detail: { value: '39' } });
  await h.page.saveForm();
  assert.equal(h.calls.updateCheckin.length, 1);
  assert.equal(h.calls.updateCheckin[0].date, '2026-10-20');
  assert.equal(h.calls.updateCheckin[0].updates.timestamp, sourceTimestamp);
});

test('changing a failed sitting draft creates a new idempotency key', async () => {
  const h = setup({ updateCheckin: () => ({ success: false, error: '保存失败' }) });
  await openEditor(h);
  await h.page.saveForm();
  h.page.onFormReflection({ detail: { value: '修改后的感悟' } });
  await h.page.saveForm();
  assert.equal(h.calls.updateCheckin.length, 2);
  assert.notEqual(h.calls.updateCheckin[0].options.requestId, h.calls.updateCheckin[1].options.requestId);
  assert.equal(h.calls.updateCheckin[1].updates.reflection, '修改后的感悟');
  assert.equal(h.calls.enqueue.length, 0);
});

test('sitting validation rejects invalid duration and rejected reflection without mutating source', async () => {
  const h = setup({ checkText: () => false });
  await openEditor(h);
  h.page.onFormValue({ detail: { value: '1441' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /1440/);
  assert.equal(h.calls.contentCheck.length, 0);
  h.page.onFormValue({ detail: { value: '30' } });
  await h.page.saveForm();
  assert.match(h.page.data.formError, /感悟|检查/);
  assert.equal(h.calls.contentCheck.length, 1);
  assert.deepEqual(h.calls.contentCheck[0], ['原记录完整感悟', 2, { allowOffline: true, timeoutMs: 1500 }]);
  assert.equal(h.calls.updateCheckin.length, 0);
  assert.equal(h.page.data.showForm, true);
});

test('sitting time edits retain the 02:00 business-day rules for old and recent records', async () => {
  for (const [date, time, allowed] of [
    ['2026-10-29', '23:00', true], // Same original business day.
    ['2026-10-30', '12:00', true], // Yesterday.
    ['2026-10-31', '12:00', true], // Today.
    ['2026-10-28', '12:00', false] // An unrelated old business day.
  ]) {
    const h = setup();
    await openEditor(h);
    h.page.onFormDate({ detail: { value: date } });
    h.page.onFormTime({ detail: { value: time } });
    await h.page.saveForm();
    assert.equal(h.calls.updateCheckin.length, allowed ? 1 : 0, `${date} ${time}`);
    if (allowed) assert.equal(h.calls.updateCheckin[0].updates.timestamp, Date.parse(`${date}T${time}:00+08:00`));
    else assert.match(h.page.data.formError, /原归属日期|今天|昨天/);
  }
});

test('backfill sitting can change time only within its original business day', async () => {
  for (const [date, time, allowed] of [
    ['2026-10-30', '01:45', true],
    ['2026-10-30', '02:00', false],
    ['2026-10-31', '12:00', false]
  ]) {
    const h = setup({ sittingSource: { ...sourceRecord, isBackfill: true } });
    await openEditor(h);
    h.page.onFormDate({ detail: { value: date } });
    h.page.onFormTime({ detail: { value: time } });
    await h.page.saveForm();
    assert.equal(h.calls.updateCheckin.length, allowed ? 1 : 0, `${date} ${time}`);
    if (!allowed) assert.match(h.page.data.formError, /补录记录|原归属日期/);
  }
});

test('missing original source or unreadable original reflection cannot open a destructive empty editor', async () => {
  for (const options of [
    { resolveSitting: () => { throw new Error('找不到原静坐记录'); } },
    { readReflection: () => { throw new Error('原感悟读取失败'); } },
    { readReflection: async () => { throw new Error('原感悟读取失败'); } }
  ]) {
    const h = setup(options);
    await openEditor(h);
    assert.equal(h.page.data.showForm, false);
    assert.equal(h.page.data.formBusy, false);
    assert.equal(h.calls.updateCheckin.length, 0);
    assert.equal(h.calls.enqueue.length, 0);
    assert.match(h.calls.toast.at(-1).title, /原静坐记录|原感悟/);
  }
});

test('delayed original record and reflection reads are ignored after account change or hiding', async () => {
  for (const stage of ['source', 'reflection']) {
    for (const change of ['account', 'binding', 'hide']) {
      const read = deferred();
      const h = setup(stage === 'source' ? { resolveSitting: () => read.promise } : { readReflection: () => read.promise });
      await openEditor(h);
      assert.equal(h.page.data.showForm, false);
      if (change === 'hide') h.page.onHide();
      else h.changeOwner({ openid: change === 'account' ? 'another-owner' : 'oz-owner',
        studentNumber: '001', bindingVersion: change === 'binding' ? 'v2' : 'v1' });
      read.resolve(stage === 'source' ? sourceRecord : '延迟返回的感悟');
      await tick();
      assert.equal(h.page.data.showForm, false, `${stage} ${change}`);
      assert.equal(h.calls.updateCheckin.length, 0);
      assert.equal(h.calls.deleteCheckin.length, 0);
    }
  }
});

test('account changes during sitting content validation stop the source update', async () => {
  const check = deferred();
  const h = setup({ checkText: () => check.promise });
  await openEditor(h);
  const save = h.page.saveForm();
  await tick();
  h.changeOwner({ openid: 'new-owner', studentNumber: '002', bindingVersion: 'v2' });
  check.resolve(true);
  await save;
  assert.equal(h.calls.updateCheckin.length, 0);
  assert.equal(h.calls.enqueue.length, 0);
});

test('sitting deletion waits for confirmation and deletes the source identity without navigation', async () => {
  const h = setup();
  await requestDelete(h);
  assert.equal(h.calls.deleteCheckin.length, 0);
  assert.equal(h.calls.sourceResolve.length, 0);
  h.calls.modal[0].success({ confirm: false });
  await tick();
  assert.equal(h.calls.deleteCheckin.length, 0);
  h.page.showRecordActions(event);
  h.calls.actionSheet.success({ tapIndex: 1 });
  h.calls.modal[1].success({ confirm: true });
  await tick();
  assert.deepEqual(h.calls.deleteCheckin, [{ date: sourceRecord.date, identity: {
    recordId: sourceRecord._id, localId: sourceRecord.localId, timestamp: sourceTimestamp
  } }]);
  assert.equal(h.calls.enqueue.length, 0);
  assert.equal(h.calls.navigation.length, 0);
  assert.equal(h.page.data.deleting, false);
  assert.ok(h.calls.mirrorResume > 0);
  assert.equal(h.calls.flush.length, 0, 'mirror resume owns queue flushing');
  assert.ok(h.calls.feed.length >= 2);
});

test('failed sitting deletion leaves the displayed record and exposes the source error', async () => {
  const h = setup({ deleteCheckin: () => ({ success: false, error: '原记录删除失败，请重试' }) });
  await requestDelete(h);
  h.calls.modal[0].success({ confirm: true });
  await tick();
  assert.equal(h.calls.deleteCheckin.length, 1);
  assert.equal(h.page.data.records[0].id, mirrorRecord.id);
  assert.equal(h.page.data.deleting, false);
  assert.match(h.calls.toast.at(-1).title, /删除失败/);
  assert.equal(h.calls.enqueue.length, 0);
});

test('changed account or hidden page cancels a delayed sitting deletion confirmation', async () => {
  for (const change of ['account', 'binding', 'hide']) {
    const h = setup();
    await requestDelete(h);
    if (change === 'hide') h.page.onHide();
    else h.changeOwner({ openid: change === 'account' ? 'new-owner' : 'oz-owner',
      studentNumber: '001', bindingVersion: change === 'binding' ? 'v2' : 'v1' });
    h.calls.modal[0].success({ confirm: true });
    await tick();
    assert.equal(h.calls.deleteCheckin.length, 0, change);
    assert.equal(h.calls.sourceResolve.length, 0, change);
  }
});

test('sitting deletion stops if the source cannot be resolved or the account changes while resolving', async () => {
  for (const change of ['missing', 'account', 'hide']) {
    const read = deferred();
    const h = setup({ resolveSitting: () => read.promise });
    await requestDelete(h);
    h.calls.modal[0].success({ confirm: true });
    await tick();
    if (change === 'missing') read.reject(new Error('找不到原静坐记录'));
    else {
      if (change === 'hide') h.page.onHide();
      else h.changeOwner({ openid: 'new-owner', studentNumber: '002', bindingVersion: 'v2' });
      read.resolve(sourceRecord);
    }
    await tick();
    assert.equal(h.calls.deleteCheckin.length, 0, change);
    assert.equal(h.calls.enqueue.length, 0, change);
  }
});

test('successful sitting mutations remain successful when mirror sync temporarily fails', async () => {
  for (const action of ['edit', 'delete']) {
    const h = setup({ mirrorResume: () => { throw new Error('镜像网络异常'); } });
    if (action === 'edit') {
      await openEditor(h);
      await h.page.saveForm();
      assert.equal(h.calls.updateCheckin.length, 1);
      assert.equal(h.page.data.showForm, false);
    } else {
      await requestDelete(h);
      h.calls.modal[0].success({ confirm: true });
      await tick();
      assert.equal(h.calls.deleteCheckin.length, 1);
    }
    assert.equal(h.calls.enqueue.length, 0);
    assert.ok(h.calls.feed.length >= 2, action);
    assert.ok(h.calls.toast.some(toast => /已更新|已删除|待同步|待上传/.test(toast.title)), action);
  }
});

test('confirmed sitting edits and deletions release the UI while mirror synchronization is pending', async () => {
  for (const action of ['edit', 'delete']) {
    const mirror = deferred();
    const h = setup({ mirrorResume: () => mirror.promise });
    let operation;
    if (action === 'edit') {
      await openEditor(h);
      operation = h.page.saveForm();
    } else {
      await requestDelete(h);
      operation = h.calls.modal[0].success({ confirm: true });
    }
    await tick();
    assert.equal(h.calls.mirrorResume, 1, action);
    assert.equal(action === 'edit' ? h.calls.updateCheckin.length : h.calls.deleteCheckin.length, 1, action);
    assert.equal(h.page.data.formBusy, false, action);
    assert.equal(h.page.data.deleting, false, action);
    assert.equal(h.page.data.showForm, false, action);
    assert.equal(h.page.data.detail, null, action);
    h.page.openForm('walking');
    assert.equal(h.page.data.showForm, true, 'another form opens while the mirror is pending');
    assert.equal(h.page.data.formType, 'walking');
    mirror.resolve();
    await operation;
    assert.equal(h.calls.flush.length, 0, action);
    assert.equal(h.page.data.showForm, true, 'late mirror completion preserves the new form');
  }
});

test('an older deletion mirror completion cannot release a newer source deletion busy state', async () => {
  const firstMirror = deferred(), secondDeletion = deferred();
  const secondSource = { ...sourceRecord, _id: 'meditation-source-8', localId: 'local-source-8' };
  const secondMirror = { ...mirrorRecord, id: 902, sourceRecordId: secondSource._id };
  let resumeCount = 0;
  const h = setup({
    feed: () => ({ records: [mirrorRecord, secondMirror] }),
    resolveSitting: record => record.sourceRecordId === secondSource._id ? secondSource : sourceRecord,
    deleteCheckin: (date, identity) => identity.recordId === secondSource._id ? secondDeletion.promise : { success: true },
    mirrorResume: () => ++resumeCount === 1 ? firstMirror.promise : undefined
  });
  await requestDelete(h);
  const first = h.calls.modal[0].success({ confirm: true });
  await tick();
  assert.equal(h.page.data.deleting, false);
  h.page.showRecordActions({ type: 'longpress', currentTarget: { dataset: { key: 'sitting:902' } } });
  h.calls.actionSheet.success({ tapIndex: 1 });
  const second = h.calls.modal[1].success({ confirm: true });
  await tick();
  assert.deepEqual(h.calls.deleteCheckin.map(call => call.identity.recordId), [sourceRecord._id, secondSource._id]);
  assert.equal(h.page.data.deleting, true);
  firstMirror.resolve();
  await first;
  assert.equal(h.page.data.deleting, true, 'the older operation cannot clear the active deletion lock');
  secondDeletion.resolve({ success: true });
  await second;
  assert.equal(h.page.data.deleting, false);
  assert.equal(h.calls.flush.length, 0);
});

test('unlinked sitting records remain read only instead of sending unsupported ordinary writes', async () => {
  for (const source of ['manual', 'meditation']) {
    const h = setup({ feed: () => ({ records: [{ ...mirrorRecord, source, sourceRecordId: null,
      canEdit: true, canDelete: true }] }) });
    await h.page.refresh();
    const record = h.page.data.records[0];
    assert.equal(record.canEdit, false, source);
    assert.equal(record.canDelete, false, source);
    h.page.showRecordActions(event);
    assert.equal(h.calls.actionSheet, undefined);
    h.page.editDetail();
    h.page.deleteDetail();
    await tick();
    assert.equal(h.page.data.showForm, false);
    assert.equal(h.calls.modal.length, 0);
    assert.equal(h.calls.sourceResolve.length, 0);
    assert.equal(h.calls.enqueue.length, 0);
  }
});
