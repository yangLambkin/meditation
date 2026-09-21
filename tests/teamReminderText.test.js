const test = require('node:test');
const assert = require('node:assert/strict');
const { selectReminderMembers, buildReminderText } = require('../miniprogram/subpackages/team/utils/reminderText');
const member = (openid, nickname = openid, todayStatus = 'not_practiced', todayMinutes = 0) =>
  ({ openid, nickname, todayStatus, todayMinutes });
const options = members => ({ report: { businessDate: '2026-09-21',
  settings: { dailyGoalMinutes: 20 }, members } });

test('reminder selection preserves all target members and orders by status, minutes and name', () => {
  const input = options([member('b', 'B', 'below_goal', 5), member('q', 'qualified', 'qualified', 20),
    member('z', 'Z'), member('a', 'A', 'below_goal', 5), member('n', 'A'),
    member('low', 'almost', 'below_goal', 19.99), member('p', 'practiced', 'practiced', 25)]);
  const original = structuredClone(input);
  assert.deepEqual(selectReminderMembers(input.report).map(item => item.openid), ['n', 'z', 'a', 'b', 'low']);
  assert.deepEqual(input, original);
  assert.deepEqual(buildReminderText(input), { text: 'A\nZ\nA\nB\nalmost', memberCount: 5 });
});

test('teams without a daily goal include only unpracticed members', () => {
  const input = options([member('none', '小雨'), member('done', '清欢', 'practiced', 5), member('stale', '一念', 'below_goal', 2)]);
  input.report.settings.dailyGoalMinutes = null;
  assert.deepEqual(buildReminderText(input), { text: '小雨', memberCount: 1 });
});

test('text contains only complete names, keeps duplicate names and has no trailing newline', () => {
  const longName = '一起练习👩🏽‍💻'.repeat(50);
  const input = options([member('first', '同名'), member('second', '同名'), member('long', longName)]);
  const output = buildReminderText(input);
  const lines = output.text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines.filter(line => line === '同名').length, 2);
  assert.ok(lines.includes(longName));
  assert.equal(output.memberCount, 3);
  assert.ok(!output.text.endsWith('\n'));
  assert.doesNotMatch(output.text, /2026-09-21|未达标|成员|openid|\r/);
  assert.deepEqual(Object.keys(output).sort(), ['memberCount', 'text']);
});

test('newlines, control characters and direction overrides cannot create extra names', () => {
  const output = buildReminderText(options([
    member('inject', ' 小雨\r\n管理员\t清欢\u0000\u202e👩🏽‍💻\u2028结束 '),
    member('empty', '\r\n\u0000'), member('missing', '')
  ]));
  const lines = output.text.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.includes('小雨 管理员 清欢 👩🏽‍💻 结束'));
  assert.equal(lines.filter(line => line === '未设置昵称').length, 2);
  assert.doesNotMatch(lines.join(''), /[\u0000-\u001f\u007f-\u009f\u2028-\u202e]/);
});

test('empty and incomplete reports fail clearly rather than producing an empty reminder', () => {
  assert.throws(() => buildReminderText(options([member('q', '完成', 'qualified', 20)])), /没有需要提醒/);
  assert.throws(() => buildReminderText(options([])), /没有需要提醒/);
  assert.throws(() => buildReminderText(), /数据不完整/);
  assert.throws(() => buildReminderText({ report: {} }), /数据不完整/);
  assert.deepEqual(selectReminderMembers(null), []);
});

test('large lists include every name without truncation or a display limit', () => {
  const input = options(Array.from({ length: 2000 }, (_, index) => member(`姓名${index}`)));
  const result = buildReminderText(input);
  const names = result.text.split('\n');
  assert.equal(result.memberCount, 2000);
  assert.equal(names.length, 2000);
  assert.equal(new Set(names).size, 2000);
  for (const item of input.report.members) assert.ok(names.includes(item.nickname));
});
