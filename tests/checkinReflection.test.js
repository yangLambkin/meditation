const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { resolveCheckinReflection } = require('../miniprogram/utils/checkinReflection');

const OWNER = 'oz-owner';
const REF = `exp_${'a'.repeat(64)}`;
const SECOND = `exp_${'b'.repeat(64)}`;
function apiWith(read) {
  const calls = [];
  return { calls, cloud: { database: () => ({ collection(name) {
    assert.equal(name, 'experience_records');
    return {
      doc(id) { calls.push({ id }); return { get: () => read({ id }) }; },
      where(query) { calls.push({ query }); return { limit(size) {
        assert.equal(size, 2);
        return { get: () => read({ query }) };
      } }; }
    };
  } }) } };
}

test('inline and fully cached legacy reflections need no cloud read and retain every paragraph', () => {
  const api = apiWith(() => assert.fail('cached and inline content must not request the cloud'));
  const cached = { first: { _id: REF, text: '缓存原文' }, second: { timestamp: 1793812537123, text: '另一段' } };
  assert.equal(resolveCheckinReflection([{ text: '内联' }, REF, '1793812537123', '旧版文字'], cached, OWNER, api),
    '内联\n\n缓存原文\n\n另一段\n\n旧版文字');
  assert.equal(resolveCheckinReflection([], {}, '', api), '');
  assert.equal(api.calls.length, 0);
});

test('a fresh device resolves all document and timestamp references in their original order', async () => {
  const api = apiWith(({ id, query }) => Promise.resolve({ data: id
    ? { _id: id, _openid: OWNER, text: '云端正文' }
    : [{ _id: 'timestamp-body', _openid: OWNER, timestamp: query.timestamp, text: '时间戳正文' }] }));
  assert.equal(await resolveCheckinReflection([REF, '1793812537123', REF], {}, OWNER, api),
    '云端正文\n\n时间戳正文\n\n云端正文');
  assert.equal(api.calls.length, 2, 'repeated references share one request');
});

test('partly cached content is not returned until every missing paragraph has been read', async () => {
  const cached = { [REF]: { _id: REF, text: '本机正文' } };
  const api = apiWith(() => Promise.resolve({ data: { _id: SECOND, _openid: OWNER, text: '远端正文' } }));
  assert.equal(await resolveCheckinReflection([REF, { text: '内联' }, SECOND], cached, OWNER, api),
    '本机正文\n\n内联\n\n远端正文');
  assert.deepEqual(api.calls, [{ id: SECOND }]);
});

test('missing, foreign, malformed, ambiguous and failed references reject the entire edit read', async () => {
  for (const result of [null, { _openid: 'oz-other', text: '其它账号' }, { _openid: OWNER },
    [{ _openid: OWNER, text: '一' }, { _openid: OWNER, text: '二' }]]) {
    const api = apiWith(() => Promise.resolve({ data: result }));
    await assert.rejects(async () => resolveCheckinReflection([{ text: '已显示的段落' }, REF], {}, OWNER, api), /完整读取/);
    await assert.rejects(async () => resolveCheckinReflection([REF], {}, OWNER, api), /完整读取/);
  }
  const failed = apiWith(() => Promise.reject(new Error('network unavailable')));
  await assert.rejects(resolveCheckinReflection([REF], {}, OWNER, failed), /完整读取/);
  assert.throws(() => resolveCheckinReflection([REF], { [REF]: { _openid: 'oz-other', text: '不应使用' } }, OWNER, failed), /完整读取/);
  assert.throws(() => resolveCheckinReflection([REF], {}, '', {}), /完整读取/);
});

test('a stalled cloud read times out and cannot later yield partial or editable content', async () => {
  let expire;
  let complete;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/checkinReflection.js'), 'utf8'), {
    module, setTimeout(callback, milliseconds) { assert.equal(milliseconds, 5000); expire = callback; return 1; },
    clearTimeout() {}
  });
  const api = apiWith(() => new Promise(resolve => { complete = resolve; }));
  const reading = module.exports.resolveCheckinReflection([{ text: '已缓存' }, REF], {}, OWNER, api);
  await Promise.resolve();
  const rejected = assert.rejects(reading, /完整读取/);
  expire();
  await rejected;
  complete({ data: { _openid: OWNER, text: '迟到正文' } });
});
