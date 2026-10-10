const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRecord } = require('../cloudfunctions/bijingSync/verifyRecord');

const studentNumber = 'BJ001';
const recordDate = '2026-10-07';
const durationMinutes = 25;

function row(overrides = {}) {
  return { index: 0, studentNumber, recordDate, exists: true, durationMinutes, ...overrides };
}

function response(record = row()) {
  return { data: { success: true, data: { total: 1, results: [record] } } };
}

function harness(result = response(), overrides = {}) {
  const requests = [];
  return {
    requests,
    verify: options => verifyRecord({
      axios: { async post(...args) {
        requests.push(args);
        if (result instanceof Error) throw result;
        return result;
      } },
      apiBase: 'https://bijing.example', accessToken: 'private-token', studentNumber, recordDate, durationMinutes,
      ...overrides, ...options,
    }),
  };
}

async function rejectsVerification(promise, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'BIJING_VERIFY_FAILED');
    assert.match(error.message, message || /必经数据/);
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
}

test('single-day verification queries the existing endpoint and accepts the exact stored total', async () => {
  const record = row();
  const app = harness(response(record));
  assert.equal(await app.verify({ timeoutMs: 3200 }), record);
  assert.deepEqual(app.requests, [[
    'https://bijing.example/api/openapi/meditation/records/query',
    { records: [{ studentNumber, recordDate }] },
    { headers: { 'X-Access-Token': 'private-token' }, timeout: 3200 },
  ]]);
});

test('a zero expected total accepts an explicit missing record or an existing zero record', async t => {
  for (const exists of [false, true]) {
    await t.test(`exists=${exists}`, async () => {
      const record = row({ exists, durationMinutes: 0 });
      const app = harness(response(record));
      assert.equal(await app.verify({ durationMinutes: 0 }), record);
      assert.equal(app.requests[0][2].timeout, 10000);
    });
  }
});

test('positive totals require a present record with the same number of minutes', async t => {
  for (const record of [row({ durationMinutes: 24 }), row({ durationMinutes: 26 }), row({ exists: false, durationMinutes: 0 })]) {
    await t.test(JSON.stringify(record), async () => {
      await rejectsVerification(harness(response(record)).verify(), /核对失败/);
    });
  }
});

test('clearing a day fails verification while remote minutes remain', async () => {
  await rejectsVerification(harness(response()).verify({ durationMinutes: 0 }), /当日时长为25分钟，期望0分钟/);
});

test('HTTP, timeout and authentication failures produce a safe verification error', async t => {
  for (const fields of [{}, { code: 'ECONNABORTED' }, { response: { status: 401 } }]) {
    await t.test(JSON.stringify(fields), async () => {
      const error = Object.assign(new Error('request private-token failed'), fields);
      const app = harness(error);
      await rejectsVerification(app.verify(), /回查失败/);
      assert.equal(app.requests.length, 1);
    });
  }
});

test('unsuccessful, missing, malformed, duplicate and inconsistent response totals are rejected', async t => {
  const responses = [
    undefined, null, {}, { data: null }, { data: { success: true } },
    { data: { success: false, message: 'private-token', data: response().data.data } },
    { data: { success: 'true', data: response().data.data } },
    { data: { success: true, data: { total: '1', results: [row()] } } },
    { data: { success: true, data: { total: 0, results: [row()] } } },
    { data: { success: true, data: { total: 2, results: [row()] } } },
    { data: { success: true, data: { total: 1, results: null } } },
    { data: { success: true, data: { total: 1, results: {} } } },
    { data: { success: true, data: { total: 1, results: [] } } },
    { data: { success: true, data: { total: 1, results: [row(), row()] } } },
    { data: { success: true, data: { total: 2, results: [row(), row()] } } },
  ];
  for (let index = 0; index < responses.length; index++) {
    await t.test(`invalid response ${index}`, async () => {
      const result = responses[index];
      // Explicit undefined must stay an invalid response rather than use the harness default.
      await rejectsVerification(harness(null, { axios: { post: async () => result } }).verify(), /无效响应/);
    });
  }
});

test('verification requires matching identity, date, index and valid explicit record fields', async t => {
  const records = [
    null, {}, row({ index: undefined }), row({ index: 1 }), row({ index: '0' }),
    row({ studentNumber: 'BJ002' }), row({ studentNumber: 'bj001' }), row({ studentNumber: undefined }),
    row({ recordDate: '2026-10-08' }), row({ recordDate: undefined }),
    row({ exists: undefined }), row({ exists: 1 }), row({ exists: 'true' }), row({ exists: null }),
    row({ durationMinutes: undefined }), row({ durationMinutes: '25' }), row({ durationMinutes: -1 }),
    row({ durationMinutes: 25.5 }), row({ durationMinutes: NaN }), row({ durationMinutes: Infinity }),
    row({ exists: false, durationMinutes: 25 }),
  ];
  for (let index = 0; index < records.length; index++) {
    await t.test(`invalid record ${index}`, async () => {
      await rejectsVerification(harness(response(records[index])).verify(), /不完整或不匹配/);
    });
  }
});

test('invalid expected durations fail before making a remote request', async t => {
  for (const durationMinutes of [-1, 1.5, '25', undefined, NaN, Infinity]) {
    await t.test(String(durationMinutes), async () => {
      const app = harness();
      await rejectsVerification(app.verify({ durationMinutes }), /预期静坐时长无效/);
      assert.equal(app.requests.length, 0);
    });
  }
});
