const assert = require('node:assert/strict');
const test = require('node:test');
const cleanup = require('../scripts/runCleanup');
const badges = require('../scripts/runRecomputeBadges');

// No test invokes a remote executable or cloud function.
test('cleanup arguments default to preview and require environment and explicit destructive scope', () => {
  assert.throws(() => cleanup.buildRequest([]), /--env/);
  assert.throws(() => cleanup.buildRequest(['full', '--env', 'isolated']), /--scope/);
  assert.throws(() => cleanup.buildRequest(['safe', '--env', 'isolated', '--scope', 'all']), /日期|date/);
  const request = cleanup.buildRequest(['safe', '--env', 'isolated', '--scope', 'user', '--openid', 'owner', '--start-date', '2026-01-01', '--end-date', '2026-01-02']);
  assert.equal(request.dryRun, true);
  assert.equal(request.openid, 'owner');
  assert.equal(request.targetEnv, 'isolated');
  assert.equal(cleanup.buildRequest(['full', '--env', 'isolated', '--scope', 'all', '--apply']).dryRun, false);
});

test('badge CLI never infers all users or guesses an openid from a nickname', () => {
  assert.throws(() => badges.buildRequest(['report', '--env', 'isolated']), /目标|target/);
  assert.throws(() => badges.buildRequest(['oops', '--env', 'isolated', '--all']), /report.*apply/);
  assert.throws(() => badges.buildRequest(['apply', '--env', 'isolated', '--all', '--openid', 'owner']), /目标|target/);
  assert.equal(badges.buildRequest(['report', '--env', 'isolated', '--all']).scope, 'all');
  const value = "O'Brien $(touch /tmp/never) `id`";
  assert.equal(badges.buildRequest(['report', '--env', 'isolated', '--nickname', value]).nickName, value);
});

test('invocation uses an explicit executable, argument arrays and stdin without shell interpolation', () => {
  const { invokeMaintenance } = require('../scripts/lib/maintenanceRunner');
  const calls = [];
  const event = { type: 'recomputeUserBadges', nickName: "O'Brien $(touch /tmp/never)", mode: 'report' };
  const result = invokeMaintenance('meditationManager', 'isolated', event, {
    environment: { MAINTENANCE_INVOKER: '/trusted/adapter' },
    execute(file, args, options) {
      calls.push({ file, args, options });
      return JSON.stringify({ result: { success: true, data: { changedUsers: 0 } } });
    }
  });
  assert.equal(result.success, true);
  assert.equal(calls[0].file, '/trusted/adapter');
  assert.deepEqual(calls[0].args, ['--function', 'meditationManager', '--env', 'isolated']);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(JSON.parse(calls[0].options.input), event);
  assert.equal(calls[0].args.includes(event.nickName), false);
});

test('missing adapter, invalid response and business refusal are failures and cannot look successful', () => {
  const { invokeMaintenance } = require('../scripts/lib/maintenanceRunner');
  assert.throws(() => invokeMaintenance('cleanupTestData', 'isolated', {}, { environment: {} }), /MAINTENANCE_INVOKER/);
  for (const reply of ['not-json', '{}', '{"success":false,"code":"FORBIDDEN"}']) {
    assert.throws(() => invokeMaintenance('cleanupTestData', 'isolated', {}, {
      environment: { MAINTENANCE_INVOKER: '/trusted/adapter' }, execute: () => reply
    }));
  }
  assert.throws(() => invokeMaintenance('cleanupTestData', 'isolated', {}, {
    environment: { MAINTENANCE_INVOKER: '/trusted/adapter' }, execute() { throw new Error('secret-command-output'); }
  }), error => !error.message.includes('secret-command-output'));
});
