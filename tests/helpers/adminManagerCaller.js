const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createStudentAuthDatabase } = require('./studentAuthDatabase');

const source = fs.readFileSync(require.resolve('../../cloudfunctions/adminManager/index.js'), 'utf8');

// The deployed platform omits nested OPENID; model that by default and prove server delegation.
// Always run the real adminManager entrypoint so business-function configuration cannot authorize it.
function createAdminManagerCaller(options) {
  const requests = [];
  const authorization = createStudentAuthDatabase(options);
  return {
    requests, authUsers: authorization.users, authReads: authorization.reads, delegationDb: authorization.db,
    authLocks: authorization.locks, authWrites: authorization.writes,
    async call(request, wxContext) {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (options.beforeAuthorize) await options.beforeAuthorize();
      if (options.authError) throw options.authError;
      if (Object.hasOwn(options, 'authResponse')) return options.authResponse;
      const exports = {};
      const centralContext = options.centralContext || { SOURCE: `${wxContext.SOURCE || 'wx_client'},scf` };
      vm.runInNewContext(source, {
        exports, process: { env: options.centralEnvironment },
        require(name) {
          if (name === './delegation') return require('../../cloudfunctions/adminManager/delegation');
          if (name === './studentAuth') return require('../../cloudfunctions/adminManager/studentAuth');
          if (name === './maintenanceAuth') return require('../../cloudfunctions/adminManager/maintenanceAuth');
          assert.equal(name, 'wx-server-sdk');
          return { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => centralContext,
            database() { return authorization.db; } };
        }
      });
      assert.equal(request.name, 'adminManager');
      return { result: await exports.main(request.data) };
    }
  };
}

module.exports = { createAdminManagerCaller };
