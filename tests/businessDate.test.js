const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const dates = require('../miniprogram/utils/dateUtil.js');

test('record dates agree across host timezones and retain unknown-time and manual dates', () => {
  const modulePath = path.join(__dirname, '../miniprogram/utils/dateUtil.js');
  const script = `
    const dates = require(${JSON.stringify(modulePath)});
    const records = [
      { timestamp: '2027-01-01T01:59:59.999+08:00' },
      { timestamp: '2027-01-01T02:00:00+08:00' },
      { timestamp: String(Date.parse('2028-03-01T01:00:00+08:00')) },
      { timestamp: new Date('2028-03-01T01:00:00+08:00') },
      { timestamp: '2027-01-01T01:00:00', date: '2027-01-01' },
      { timestamp: '2027-01-01T01:00:00+08:00', date: '2026-12-30', source: 'manual' },
      { timestamp: 9e15, date: '2026-12-30' }
    ];
    process.stdout.write(JSON.stringify(records.map(record => dates.getRecordBusinessDate(record))));
  `;
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['2026-12-31', '2027-01-01', '2028-02-29', '2028-02-29', '2027-01-01', '2026-12-30', '2026-12-30']);
  }
});

test('business date watcher changes exactly at 02:00 and releases its timer on stop', () => {
  let now = Date.parse('2027-01-01T01:59:59.999+08:00');
  let nextId = 0;
  const timers = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/dateUtil.js'), 'utf8'), {
    module, Date: ClockDate,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const changes = [];
  const stop = module.exports.watchBusinessDate((...args) => changes.push(args));
  assert.equal(changes.length, 0);
  let [id, timer] = [...timers][0];
  assert.equal(timer.delay, 1);
  now++;
  timers.delete(id);
  timer.callback();
  assert.deepEqual(changes, [['2027-01-01', '2026-12-31']]);
  [id, timer] = [...timers][0];
  assert.equal(timer.delay, dates.DAY_MS);
  // 被挂起后恢复时按实际日期跳转，不连续发出已过期业务日。
  now += dates.DAY_MS * 3;
  timers.delete(id);
  timer.callback();
  assert.deepEqual(changes[1], ['2027-01-04', '2027-01-01']);
  const pending = [...timers.values()][0];
  stop();
  assert.equal(timers.size, 0);
  pending.callback();
  assert.equal(changes.length, 2);
});
