const { createRuntime } = require('./runtime');

function createTimerModule(options) { return createRuntime(options); }

function createTimerPage() {
  const runtime = getApp().getTimerModule();
  return require('./definition').createPage({ api: runtime.api, app: runtime });
}

module.exports = { createTimerModule, createTimerPage };
