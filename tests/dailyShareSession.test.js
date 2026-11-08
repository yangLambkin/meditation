const assert = require('node:assert/strict');
const test = require('node:test');
const { createSession, readSession, sessionQuery, shareTitle } = require('../miniprogram/utils/dailyShareSession.js');

const ENDED_AT = Date.parse('2026-11-07T01:00:00+08:00');
const queryOptions = query => Object.fromEntries(new URLSearchParams(query));

test('completion uses the actual Beijing calendar date and end time before the business-day boundary', () => {
  const session = createSession('秋水', ENDED_AT, 17);
  assert.deepEqual(session, {
    name: '秋水', minutes: 17, endedAt: ENDED_AT, dateLabel: '2026.11.07', timeLabel: '01:00'
  });
  assert.equal(shareTitle(session), '秋水 · 静坐17分钟');
  assert.equal(createSession('秋水', Date.parse('2026-11-06T23:59:59+08:00'), 1).dateLabel, '2026.11.06');
  assert.equal(createSession('秋水', Date.parse('2026-11-07T00:00:00+08:00'), 1).dateLabel, '2026.11.07');
});

test('names normalize whitespace and truncate long Unicode text without splitting surrogate pairs', () => {
  const session = createSession(`  秋水\n\t${'🌱'.repeat(25)}\u0000尾  `, ENDED_AT, 10);
  assert.equal(session.name, `秋水 ${'🌱'.repeat(17)}`);
  assert.equal(Array.from(session.name).length, 20);
  assert.equal(session.name.includes('\ufffd'), false);
  assert.equal(createSession('\n\t\u0000 ', ENDED_AT, 10).name, '静心者');
  assert.equal(createSession({ nickName: '不读取对象资料' }, ENDED_AT, 10).name, '静心者');
});

for (const nativeDecodesQuery of [false, true]) {
  test(`literal percent escapes and delimiters survive ${nativeDecodesQuery ? 'decoded' : 'encoded'} native query and repeated forwarding`, () => {
    let session = createSession('秋水%25%E5🌱&=+?', ENDED_AT, 17);
    const original = { ...session };
    for (let hop = 0; hop < 4; hop++) {
      const query = sessionQuery(session);
      const options = nativeDecodesQuery
        ? queryOptions(query)
        : Object.fromEntries(query.slice(1).split('&').map(part => {
          const delimiter = part.indexOf('=');
          return [part.slice(0, delimiter), part.slice(delimiter + 1)];
        }));
      session = readSession(options);
      assert.deepEqual(session, original);
    }
  });
}

test('a shared session only exports its public name, completion timestamp and duration', () => {
  const session = {
    ...createSession('秋水', ENDED_AT, 17),
    userOpenId: 'private-openid', userId: 'private-user-id', account: 'private-account',
    avatar: 'https://private.example/avatar.png', reflection: 'private-reflection', totalCount: 99,
    totalMinutes: 999, profile: { secret: true }
  };
  const options = queryOptions(sessionQuery(session));
  assert.deepEqual(Object.keys(options).sort(), ['at', 'minutes', 'name']);
  assert.deepEqual(options, { name: 'n1:秋水', at: String(ENDED_AT), minutes: '17' });
  const received = readSession({ ...options, userOpenId: session.userOpenId, profile: session.profile });
  assert.deepEqual(received, createSession('秋水', ENDED_AT, 17));
  assert.ok(!sessionQuery(session).includes('private'));
  assert.ok(!shareTitle(session).includes('private'));
});

test('invalid completion timestamps cannot fabricate a dated session', () => {
  for (const endedAt of [undefined, null, false, true, {}, [], '', 'invalid', '2026-11-07',
    0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 253402272000000]) {
    assert.equal(createSession('秋水', endedAt, 17), null, String(endedAt));
    assert.equal(readSession({ name: 'n1:秋水', at: endedAt, minutes: '17' }), null, String(endedAt));
  }
});

test('invalid or missing minutes omit all session details instead of guessing a duration', () => {
  for (const minutes of [undefined, null, false, true, {}, [], '', 'invalid', 0, -1, 0.5, 1.5, 1441, NaN, Infinity]) {
    const session = readSession({ name: 'n1:秋水', at: String(ENDED_AT), minutes });
    assert.equal(session, null, String(minutes));
    assert.equal(sessionQuery(session), '');
    assert.equal(shareTitle(session), '送你一张静心卡');
  }
  assert.equal(readSession({}), null);
  assert.equal(createSession('秋水', String(ENDED_AT), '1').minutes, 1);
  assert.equal(createSession('秋水', ENDED_AT, 1440).minutes, 1440);
});

test('unversioned or malformed names never supply misleading profile data', () => {
  for (const name of [undefined, null, {}, '秋水', 'n1%3A%invalid']) {
    const session = readSession({ name, at: String(ENDED_AT), minutes: '17' });
    assert.equal(session.name, '静心者');
    assert.equal(session.endedAt, ENDED_AT);
    assert.equal(session.minutes, 17);
  }
});
