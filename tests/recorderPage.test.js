const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pagePath = path.join(__dirname, '../miniprogram/pages/recorder/recorder.js');

function createPage({ recordCheckin = () => ({ success: true }), checkText = async () => true, options = {} } = {}) {
  let definition;
  let now = Date.parse('2026-09-20T09:00:00+08:00');
  const calls = { records: [], blockingRecords: [], texts: [], toasts: [], navigations: [] };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Date: Clock,
    Page: value => { definition = value; },
    wx: { showToast: value => calls.toasts.push(value), switchTab: value => calls.navigations.push(value) },
    require(request) {
      if (request === '../../utils/checkin.js') return {
        recordCheckin: (...args) => { calls.records.push(args); return recordCheckin(...args); },
        recordCheckinWithSync: (...args) => { calls.blockingRecords.push(args); return new Promise(() => {}); }
      };
      assert.equal(request, '../../utils/contentSec.js');
      return { checkText: (...args) => { calls.texts.push(args); return checkText(...args); } };
    }
  }, { filename: pagePath });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  page.onLoad(options);
  return { page, calls, advance: milliseconds => { now += milliseconds; } };
}

function setText(page, value) { page.onTextInput({ detail: { value } }); }

test('recorder completes local saving immediately and keeps local-only saves from being recorded twice', async () => {
  const { page, calls } = createPage();
  const saving = page.completeCheckIn();
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.completed, true);
  assert.equal(calls.blockingRecords.length, 0);
  assert.equal(calls.toasts.at(-1).title, '已存本机，待上传');
  assert.equal(calls.navigations.length, 1);
  await page.completeCheckIn();
  assert.equal(calls.records.length, 1);
  await saving;
  assert.equal(page.data.completed, true);
  assert.equal(page.data.submitting, false);
  assert.equal(calls.toasts.at(-1).title, '已存本机，待上传');
  assert.equal(calls.toasts.at(-1).icon, 'none');
  assert.equal(calls.navigations.length, 1);
  await page.completeCheckIn();
  assert.equal(calls.records.length, 1);
});

test('recorder never claims a cloud upload from the local save response', async () => {
  const { page, calls } = createPage({ recordCheckin: () => ({ success: true, cloudSynced: true }) });
  await page.completeCheckIn();
  assert.equal(calls.toasts.at(-1).title, '已存本机，待上传');
  assert.equal(calls.toasts.at(-1).icon, 'none');
});

test('recorder saves blank or whitespace-only reflection without requiring emotions', async () => {
  for (const value of ['', '  \n  ']) {
    const { page, calls } = createPage({ options: { duration: '30', sessionId: 'known-session' } });
    setText(page, value);
    await page.completeCheckIn();
    assert.equal(calls.records.length, 1);
    const [duration, emotions, experiences, timestamp, options] = calls.records[0];
    assert.equal(duration, 30);
    assert.equal(emotions.length, 0);
    assert.equal(experiences.length, 0);
    assert.equal(timestamp, Date.parse('2026-09-20T09:00:00+08:00'));
    assert.equal(options.idempotencyKey, 'known-session');
    assert.equal(calls.texts.length, 0);
    assert.equal(page.data.completed, true);
    assert.equal(page.data.submitting, false);
    assert.equal(calls.navigations[0].url, '/pages/index/index');
  }
});

test('recorder stores approved text together with its only check-in record', async () => {
  const { page, calls } = createPage();
  setText(page, '  呼吸平稳  ');
  await page.completeCheckIn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.texts)), [['呼吸平稳', 2, { allowOffline: true, timeoutMs: 1500 }]]);
  assert.equal(calls.records.length, 1);
  const [duration, emotions, experiences, timestamp, options] = calls.records[0];
  assert.equal(duration, 7);
  assert.equal(emotions.length, 0);
  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].text, '呼吸平稳');
  assert.equal(experiences[0].emotion.length, 0);
  assert.equal(experiences[0].timestamp, timestamp);
  assert.equal(experiences[0].uniqueId, options.idempotencyKey);
});

test('recorder prevents repeated submits while moderation is pending and after success', async () => {
  let resolve;
  const { page, calls } = createPage({ checkText: () => new Promise(done => { resolve = done; }) });
  setText(page, '静坐一次');
  const first = page.completeCheckIn();
  assert.equal(page.data.submitting, true);
  await page.completeCheckIn();
  assert.equal(calls.texts.length, 1);
  assert.equal(calls.records.length, 0);
  resolve(true);
  await first;
  await page.completeCheckIn();
  assert.equal(calls.records.length, 1);
  assert.equal(calls.navigations.length, 1);
  assert.equal(page.data.completed, true);
});

test('recorder retries failed writes with the same idempotency key and timestamp', async () => {
  for (const firstFailure of [() => { throw new Error('存储空间不足'); }, () => ({ success: false, error: '保存失败' })]) {
    let attempt = 0;
    const { page, calls, advance } = createPage({ recordCheckin: () => ++attempt === 1 ? firstFailure() : { success: true } });
    setText(page, '保存失败后保留这段感受');
    await page.completeCheckIn();
    assert.equal(page.data.completed, false);
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.currentText, '保存失败后保留这段感受');
    assert.equal(calls.navigations.length, 0);
    assert.equal(calls.toasts.at(-1).icon, 'none');
    advance(90000);
    await page.completeCheckIn();
    assert.equal(calls.records.length, 2);
    assert.equal(calls.records[0][3], calls.records[1][3]);
    assert.equal(calls.records[0][4].idempotencyKey, calls.records[1][4].idempotencyKey);
    assert.equal(calls.records[0][2][0].uniqueId, calls.records[1][2][0].uniqueId);
    assert.equal(calls.navigations.length, 1);
    assert.equal(page.data.completed, true);
  }
});

test('recorder preserves rejected reflections and releases the lock for editing', async () => {
  const { page, calls } = createPage({ checkText: async () => false });
  setText(page, '待修改');
  await page.completeCheckIn();
  assert.equal(calls.records.length, 0);
  assert.equal(page.data.currentText, '待修改');
  assert.equal(page.data.completed, false);
  assert.equal(page.data.submitting, false);
  setText(page, '');
  await page.completeCheckIn();
  assert.equal(calls.records.length, 1);
});

test('recorder moderation exceptions keep the draft and permit retry', async () => {
  const { page, calls } = createPage({ checkText: () => { throw new Error('暂时无法审核'); } });
  setText(page, '待保存');
  await page.completeCheckIn();
  assert.equal(page.data.currentText, '待保存');
  assert.equal(page.data.submitting, false);
  assert.equal(calls.records.length, 0);
  assert.equal(calls.toasts.at(-1).title, '暂时无法审核');
});

test('recorder validates the supplied duration and creates different ids for separate sessions', () => {
  for (const duration of ['0', '-1', '1.5', '1441', 'bad']) {
    assert.equal(createPage({ options: { duration } }).page.data.duration, 7);
  }
  for (const duration of ['1', '1440']) {
    assert.equal(createPage({ options: { duration } }).page.data.duration, Number(duration));
  }
  assert.notEqual(createPage().page._submissionId, createPage().page._submissionId);
});
