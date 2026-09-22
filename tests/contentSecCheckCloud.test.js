const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ response, error, imageResponse = { Suggestion: 'Pass' } } = {}) {
  const calls = { text: [], images: [] };
  const exports = {};
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    getWXContext: () => ({ OPENID: 'trusted-openid' }),
    openapi: { security: { async msgSecCheck(params) {
      calls.text.push(params);
      if (error !== undefined) throw error;
      return response;
    } } },
    getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://test.invalid/image.jpg' }] })
  };
  class ImsClient {
    async ImageModeration(params) {
      calls.images.push(params);
      return imageResponse;
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/contentSecCheck/index.js'), 'utf8'), {
    exports,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === 'tencentcloud-sdk-nodejs-ims') return { ims: { v20201229: { Client: ImsClient } } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { IMS_SECRET_ID: 'test-id', IMS_SECRET_KEY: 'test-key' } },
    console: { log() {}, warn() {}, error() {} }
  });
  return { main: exports.main, calls };
}

for (const suggestion of ['pass', 'risky', 'review']) {
  test(`v2 successful response with ${suggestion} uses its moderation conclusion`, async () => {
    const app = harness({ response: { errCode: 0, errMsg: 'openapi.security.msgSecCheck:ok', result: { suggest: suggestion, label: 100 } } });
    const result = await app.main({ type: 'text', content: '测试正文', scene: 1, openid: 'untrusted-openid' });
    assert.equal(result.success, true);
    assert.equal(result.safe, suggestion === 'pass');
    assert.equal(result.status, suggestion);
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls.text)), [{ content: '测试正文', version: 2, scene: 1, openid: 'trusted-openid' }]);
  });
}

for (const [label, response] of [
  ['unknown conclusion', { errCode: 0, result: { suggest: 'unknown' } }],
  ['missing conclusion', { errCode: 0, result: { label: 100 } }],
  ['missing result', { errCode: 0 }],
  ['null response', null],
  ['undefined response', undefined],
  ['malformed result', { result: 'pass' }],
  ['unexpected success casing', { result: { suggest: 'PASS' } }],
  ['failed API response with pass', { errCode: 40001, result: { suggest: 'pass' } }],
  ['failed lowercase API response with pass', { errcode: 40001, result: { suggest: 'pass' } }]
]) {
  test(`${label} blocks publishing without claiming content is risky`, async () => {
    const result = await harness({ response }).main({ type: 'text', content: '测试正文' });
    assert.equal(result.success, false);
    assert.equal(result.safe, false);
    assert.equal(result.status, 'error');
  });
}

test('empty text remains allowed without a moderation request', async () => {
  const app = harness();
  for (const content of ['', '   ', null, undefined]) {
    const result = await app.main({ type: 'text', content });
    assert.equal(result.success, true);
    assert.equal(result.safe, true);
  }
  assert.equal(app.calls.text.length, 0);
});

test('legacy 87014 errors remain explicit content rejection', async () => {
  for (const error of [{ errCode: 87014 }, { errcode: 87014 }]) {
    const result = await harness({ error }).main({ type: 'text', content: '测试正文' });
    assert.equal(result.success, true);
    assert.equal(result.safe, false);
    assert.equal(result.status, 'risky');
  }
});

test('transport and malformed exceptions are unavailable, not content violations', async () => {
  for (const error of [new Error('quota exceeded'), { errCode: 40001 }, null]) {
    const result = await harness({ error }).main({ type: 'text', content: '测试正文' });
    assert.equal(result.success, false);
    assert.equal(result.safe, false);
    assert.equal(result.status, 'error');
  }
});

test('image aliases retain the synchronous IMS pass/block/review behavior', async () => {
  for (const type of ['image', 'imageSync']) {
    for (const suggestion of ['Pass', 'Block', 'Review']) {
      const app = harness({ imageResponse: { Suggestion: suggestion } });
      const result = await app.main({ type, fileID: 'cloud://image.jpg' });
      assert.equal(result.success, true);
      assert.equal(result.safe, suggestion === 'Pass');
      assert.equal(app.calls.images.length, 1);
      assert.equal(app.calls.text.length, 0);
    }
  }
});
