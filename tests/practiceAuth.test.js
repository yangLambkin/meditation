const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const values = { userOpenId: 'wechat-a', userInfo: { bijingBound: true, bijingStudentNumber: ' bj001 ', bijingBindingVersion: 'version-a' } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/practiceAuth.js'), 'utf8'), {
    module, exports: module.exports, wx: { getStorageSync: key => values[key] },
    require: () => ({ serviceAccessToken: 'test-credential' }),
  });
  return { values, auth: module.exports };
}

test('temporary direct access uses the current local binding and isolated credential configuration', async () => {
  const { values, auth } = harness();
  const owner = await auth.authorize();
  assert.equal(owner.openid, 'wechat-a');
  assert.equal(owner.studentNumber, 'BJ001');
  assert.equal(owner.bindingVersion, 'version-a');
  assert.equal(await auth.getAccessToken(), 'test-credential');
  values.userInfo.bijingBound = false;
  await assert.rejects(auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
});

test('stale profiles and contradictory bind/unbind caches cannot create a new queue owner', () => {
  const { values, auth } = harness();
  values.userInfo._openid = 'wechat-b';
  assert.equal(auth.getOwner(), null);
  delete values.userInfo._openid;
  values.bijingStatus_wechat_a = undefined;
  values['bijingStatus_wechat-a'] = { account: 'wechat-a', binding: { bijingBound: true, bijingStudentNumber: 'BJ001', bijingBindingVersion: 'version-old' } };
  assert.equal(auth.getOwner(), null);
  values['bijingStatus_wechat-a'].binding.bijingBindingVersion = 'version-a';
  assert.equal(auth.getOwner().bindingVersion, 'version-a');
  values.userInfo.bijingBound = false;
  assert.equal(auth.getOwner(), null);
  values.userInfo.bijingBound = true;
  values['bijingStatus_wechat-a'].binding.bijingBound = false;
  assert.equal(auth.getOwner(), null);
});

test('a missing account or failed storage read pauses authorization', async () => {
  const { values, auth } = harness();
  delete values.userOpenId;
  assert.equal(auth.getOwner(), null);
  await assert.rejects(auth.authorize(), { code: 'AUTH_REQUIRED' });
});
