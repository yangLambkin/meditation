const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(notice) {
  let definition;
  let modalFailure = false;
  const storage = new Map([['timerCompletionNotice', notice]]);
  const modals = [];
  const filename = path.join(__dirname, '../miniprogram/pages/index/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    require() { return { DEFAULT_QUOTE: '', methods: {}, data: {},
      watchDailyWisdom: () => () => {}, getCheckinDay: () => '2026-11-05',
      watchBusinessDate: () => () => {} }; },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      showModal(options) {
        if (modalFailure) throw new Error('modal unavailable');
        modals.push(options);
      }
    },
    console: { log() {} }, setInterval() { return 1; }, clearInterval() {}
  }, { filename });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); } };
  for (const name of ['refreshRecordVisibility', 'initHomeBackfill', 'watchBijingRecordSync',
    'refreshCheckinDefaults', 'refreshCheckinRecords', 'checkUserInfoStatus',
    'generateCalendar', 'refreshCheckinsFromCloud']) page[name] = () => {};
  return { page, storage, modals,
    failModal(value) { modalFailure = value; },
    confirm() {
      const modal = modals.at(-1);
      modal.success({ confirm: true });
      modal.complete();
    }
  };
}

test('home shows the saved minute count or sub-minute result once after an early timer exit', () => {
  for (const notice of ['倒计时已结束，2分钟已存本机', '正计时已结束，1分钟已存本机',
    '倒计时已结束，不足1分钟未记录', '正计时已结束，请确认保存记录']) {
    const h = harness(notice);
    h.page.onShow();
    assert.equal(h.modals.length, 1);
    assert.equal(h.modals[0].title, '静坐已结束');
    assert.equal(h.modals[0].content, notice);
    assert.equal(h.modals[0].showCancel, false);
    h.page.onShow();
    assert.equal(h.modals.length, 1, 'returning while a modal is open cannot duplicate it');
    h.confirm();
    assert.equal(h.storage.get('timerCompletionNotice'), '');
    h.page.onShow();
    assert.equal(h.modals.length, 1, 'a consumed result cannot appear on another home visit');
  }
});

test('home leaves interruption and continuation notices for the timer page', () => {
  for (const notice of [undefined, '', '上次计时中断，已保留剩余时间，点击继续']) {
    const h = harness(notice);
    h.page.onShow();
    assert.equal(h.modals.length, 0);
    assert.equal(h.storage.get('timerCompletionNotice'), notice);
  }
});

test('a failed modal retains the result for the next home visit', () => {
  const notice = '倒计时已结束，3分钟已存本机';
  const h = harness(notice);
  h.failModal(true);
  assert.doesNotThrow(() => h.page.onShow());
  assert.equal(h.storage.get('timerCompletionNotice'), notice);
  h.failModal(false);
  h.page.onShow();
  assert.equal(h.modals.length, 1);
  h.modals[0].complete();
  h.page.onShow();
  assert.equal(h.modals.length, 2, 'an unsuccessful asynchronous display also remains retryable');
  h.confirm();
  assert.equal(h.storage.get('timerCompletionNotice'), '');
});

test('confirming an older result preserves a newer sitting result', () => {
  const h = harness('倒计时已结束，2分钟已存本机');
  h.page.onShow();
  const newer = '正计时已结束，1分钟已存本机';
  h.storage.set('timerCompletionNotice', newer);
  h.confirm();
  assert.equal(h.storage.get('timerCompletionNotice'), newer);
  h.page.onShow();
  assert.equal(h.modals.length, 2);
  assert.equal(h.modals[1].content, newer);
});
