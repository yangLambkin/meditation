const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('legacy collection initialization never seeds operational records or creates a false admin alert', async () => {
  const created = [], inserted = [];
  const db = {
    async createCollection(name) { created.push(name); },
    collection(name) {
      return {
        limit() { return this; },
        async get() { throw { errCode: 'DATABASE_COLLECTION_NOT_EXIST', errMsg: 'DATABASE_COLLECTION_NOT_EXIST' }; },
        async add() { inserted.push(name); return { _id: 'sample' }; },
        doc() { return { async remove() {} }; },
      };
    },
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/autoCreateCollections/index.js'), 'utf8'), {
    exports, console: { log() {}, error() {} }, setTimeout: callback => callback(),
    require: name => {
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, database: () => db };
    },
  });
  const result = await exports.main({});
  assert.equal(result.successCount, result.total);
  for (const name of ['bijing_sync_days', 'bijing_sync_runs', 'bijing_sync_items', 'bijing_sync_errors', 'admin_audit_logs']) {
    assert.ok(created.includes(name));
    assert.equal(inserted.includes(name), false, `${name} must contain only real operational data`);
  }
});
