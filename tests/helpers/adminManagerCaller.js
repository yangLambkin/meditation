const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../../cloudfunctions/adminManager/index.js'), 'utf8');

// This models preserved or explicitly altered platform context, not proven cloud behavior.
// Always run the real adminManager entrypoint so business-function configuration cannot authorize it.
function createAdminManagerCaller(options) {
  const requests = [];
  return {
    requests,
    async call(request, wxContext) {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (options.beforeAuthorize) await options.beforeAuthorize();
      if (options.authError) throw options.authError;
      if (Object.hasOwn(options, 'authResponse')) return options.authResponse;
      const exports = {};
      const centralContext = options.centralContext || { ...wxContext,
        SOURCE: `${wxContext.SOURCE || 'wx_client'},scf` };
      vm.runInNewContext(source, {
        exports, process: { env: options.centralEnvironment },
        require(name) {
          if (name === './maintenanceAuth') return require('../../cloudfunctions/adminManager/maintenanceAuth');
          assert.equal(name, 'wx-server-sdk');
          return { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => centralContext,
            database() { throw new Error('the authorization probe must not read business data'); } };
        }
      });
      assert.equal(request.name, 'adminManager');
      return { result: await exports.main(request.data) };
    }
  };
}

module.exports = { createAdminManagerCaller };
