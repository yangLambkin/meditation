const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function harness(name, options = {}) {
  const reads = [], writes = [], external = [];
  const data = { users: [], meditation_records: [], experience_records: [], user_stats: [], rankings: [], ...options.data };
  const environment = { MAINTENANCE_ADMIN_OPENIDS: 'operator', MAINTENANCE_ENV_ID: 'test-env', MAINTENANCE_DEPLOYMENT_TIER: 'test', ...options.env };
  const wxContext = { OPENID: 'operator', ENV: 'test-env', ...options.wxContext };
  function query(collection, filter = {}) {
    let skip = 0, limit = Infinity;
    const result = {
      where(value) { return query(collection, value); }, orderBy() { return this; },
      skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
      async get() {
        reads.push(collection);
        return { data: data[collection].filter(row => Object.entries(filter).every(([key, value]) =>
          value && value.in ? value.in.includes(row[key]) : row[key] === value)).slice(skip, skip + limit) };
      },
      async count() { reads.push(collection); return { total: data[collection].length }; },
      async update() { writes.push(collection); return { stats: { updated: 1 } }; },
      async add() { writes.push(collection); },
      doc(id) { return { async remove() { writes.push({ collection, id }); } }; },
    };
    return result;
  }
  const database = { collection: query, command: {
    in: value => ({ in: value }), aggregate: {},
    gte: value => ({ and: other => ({ gte: value, ...other }) }), lt: value => ({ lt: value })
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/index.js`), 'utf8'), {
    module, exports: module.exports, process: { env: environment }, console: { log() {}, error() {}, warn() {} },
    require(dependency) {
      if (dependency === 'wx-server-sdk') return { init() {}, database: () => database, getWXContext: () => wxContext };
      if (dependency === 'axios') return { post: async () => { external.push('post'); return { data: {} }; } };
      if (dependency === './maintenanceAuth') return require(`../cloudfunctions/${name}/maintenanceAuth`);
      return require(dependency);
    },
  });
  return { reads, writes, external, run: (event, context = {}) => module.exports.main(event, context) };
}

for (const [name, event] of [
  ['cleanupTestData', { mode: 'full', scope: 'all', dryRun: false, targetEnv: 'test-env' }],
  ['meditationManager', { type: 'recomputeUserBadges', mode: 'apply', scope: 'all' }],
  ['meditationManager', { type: 'migrateBusinessDates', dryRun: false }],
  ['bijingSync', { type: 'cronSyncAll' }],
  ['bijingSync', {}],
]) {
  for (const OPENID of ['ordinary-user', '', undefined]) {
    test(`${name}/${event.type || event.mode || 'implicit cron'} rejects ${String(OPENID)} before business access`, async () => {
      const app = harness(name, { wxContext: { OPENID } });
      const result = await app.run({ ...event, admin: true, source: 'timer', OPENID: 'operator' }, { source: 'timer' });
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.success, false);
      assert.deepEqual([app.reads, app.writes, app.external], [[], [], []]);
    });
  }
}

test('administrator identity is disabled unless explicitly allowlisted in deployment configuration', async () => {
  const app = harness('meditationManager', { env: { MAINTENANCE_ADMIN_OPENIDS: '' } });
  assert.equal((await app.run({ type: 'recomputeUserBadges', mode: 'report', scope: 'all' })).code, 'FORBIDDEN');
  assert.equal(app.reads.length, 0);
});

for (const [event, code] of [
  [{}, 'TARGET_REQUIRED'], [{ mode: 'oops', scope: 'all' }, 'INVALID_MODE'],
  [{ scope: 'everything' }, 'INVALID_TARGET'], [{ openid: ' ' }, 'INVALID_TARGET'],
  [{ nickName: 'missing' }, 'TARGET_NOT_FOUND'],
]) {
  test(`badge recomputation validates target: ${JSON.stringify(event)}`, async () => {
    const app = harness('meditationManager');
    const result = await app.run({ type: 'recomputeUserBadges', ...event });
    assert.equal(result.code, code);
    assert.equal(app.reads.includes('meditation_records'), false);
    assert.equal(app.writes.length, 0);
  });
}

test('duplicate nickname matches never broaden into a multi-user operation', async () => {
  const app = harness('meditationManager', { data: { users: [
    { _openid: 'one', nickName: 'same' }, { _openid: 'two', nickName: 'same' }
  ] } });
  assert.equal((await app.run({ type: 'recomputeUserBadges', nickName: 'same' })).code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(app.reads, ['users']);
  assert.deepEqual(app.writes, []);
});

test('all-user report requires an explicit scope and remains read only', async () => {
  const app = harness('meditationManager');
  assert.equal((await app.run({ type: 'recomputeUserBadges', mode: 'report', scope: 'all' })).success, true);
  assert.deepEqual(app.reads, ['meditation_records']);
  assert.deepEqual(app.writes, []);
});

for (const [event, code] of [
  [{ mode: 'full', scope: 'all', dryRun: false }, 'ENVIRONMENT_MISMATCH'],
  [{ mode: 'full', targetEnv: 'wrong', scope: 'all', dryRun: false }, 'ENVIRONMENT_MISMATCH'],
  [{ mode: 'full', targetEnv: 'test-env', dryRun: false }, 'TARGET_REQUIRED'],
  [{ mode: 'safe', targetEnv: 'test-env', scope: 'all', dryRun: false }, 'INVALID_DATE_RANGE'],
  [{ mode: 'full', targetEnv: 'test-env', scope: 'all', dryRun: 'false' }, 'INVALID_DRY_RUN'],
]) {
  test(`cleanup rejects incomplete destructive request: ${JSON.stringify(event)}`, async () => {
    const app = harness('cleanupTestData');
    assert.equal((await app.run(event)).code, code);
    assert.deepEqual([app.reads, app.writes], [[], []]);
  });
}

test('cleanup defaults to statistics, and full scope defaults to preview', async () => {
  const app = harness('cleanupTestData', { data: { meditation_records: [{ _id: 'record' }] } });
  assert.equal((await app.run({ targetEnv: 'test-env' })).success, true);
  const result = await app.run({ mode: 'full', targetEnv: 'test-env', scope: 'all' });
  assert.equal(result.dryRun, true);
  assert.equal(result.totalMatched, 1);
  assert.equal(result.totalDeleted, 0);
  assert.equal(app.writes.length, 0);
});

test('production cleanup writes require a separate deployment opt-in', async () => {
  const app = harness('cleanupTestData', { env: { MAINTENANCE_DEPLOYMENT_TIER: 'production' } });
  assert.equal((await app.run({ mode: 'full', scope: 'all', targetEnv: 'test-env', dryRun: false })).code, 'PRODUCTION_CLEANUP_DISABLED');
  assert.deepEqual([app.reads, app.writes], [[], []]);
});

test('only an enabled, verified platform timer source may dispatch a cron job without OPENID', async () => {
  const options = { wxContext: { OPENID: undefined, SOURCE: 'verified-timer-only' }, env: {
    BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'verified-timer-only'
  } };
  const app = harness('bijingSync', options);
  assert.equal((await app.run({})).success, true);
  for (const altered of [
    { ...options, wxContext: { OPENID: undefined, SOURCE: 'wx_client' } },
    { ...options, env: { ...options.env, BIJING_TIMER_ENABLED: 'false' } },
    { ...options, wxContext: { OPENID: 'ordinary-user', SOURCE: 'verified-timer-only' } },
    { ...options, env: { BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_client' }, wxContext: { SOURCE: 'wx_client', OPENID: undefined } }
  ]) {
    const denied = harness('bijingSync', altered);
    assert.equal((await denied.run({ type: 'cronSyncAll', source: 'verified-timer-only' })).code, 'FORBIDDEN');
    assert.deepEqual([denied.reads, denied.writes, denied.external], [[], [], []]);
  }
});

test('deployable authorization modules match the single reviewed source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../shared/maintenanceAuth.js'), 'utf8');
  for (const name of ['cleanupTestData', 'meditationManager', 'bijingSync']) {
    assert.equal(fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/maintenanceAuth.js`), 'utf8'), source);
  }
});

test('authorized explicit cron keeps its all-bound-users dispatch', async () => {
  const app = harness('bijingSync');
  assert.equal((await app.run({ type: 'cronSyncAll' })).success, true);
  assert.deepEqual(app.reads, ['users']);
});

test('full cleanup reads every page before deletion and reports the matched count', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ _id: `record-${index}` }));
  const app = harness('cleanupTestData', { data: { meditation_records: rows } });
  const result = await app.run({ mode: 'full', scope: 'all', targetEnv: 'test-env', dryRun: false });
  assert.equal(result.success, true);
  assert.equal(result.totalMatched, 205);
  assert.equal(result.totalDeleted, 205);
  assert.equal(app.reads.filter(name => name === 'meditation_records').length, 3);
  assert.equal(app.writes.length, 205);
});

test('safe user cleanup only selects that user and validates calendar dates before reads', async () => {
  const app = harness('cleanupTestData', { data: { meditation_records: [
    { _id: 'own', _openid: 'owner', date: '2026-02-01' },
    { _id: 'other', _openid: 'other-user', date: '2026-02-01' },
    { _id: 'prior', _openid: 'owner', date: '2026-01-31' }
  ] } });
  const request = { mode: 'safe', scope: 'user', openid: 'owner', targetEnv: 'test-env', startDate: '2026-02-01', endDate: '2026-02-01', dryRun: false };
  assert.equal((await app.run({ ...request, endDate: '2026-02-30' })).code, 'INVALID_DATE_RANGE');
  assert.equal(app.reads.length, 0);
  const result = await app.run(request);
  assert.equal(result.success, true);
  assert.equal(result.totalDeleted, 1);
  assert.deepEqual(app.writes, [{ collection: 'meditation_records', id: 'own' }]);
});

for (const request of [
  { type: 'recomputeUserBadges', mode: 'apply', scope: 'all' },
  { type: 'migrateBusinessDates', dryRun: false, scope: 'all' },
]) {
  test(`${request.type} writes require a matching request, platform and deployment environment`, async () => {
    for (const options of [
      { event: request },
      { event: { ...request, targetEnv: 'other' } },
      { event: { ...request, targetEnv: 'test-env' }, env: { MAINTENANCE_ENV_ID: '' } },
      { event: { ...request, targetEnv: 'test-env' }, wxContext: { ENV: 'other' } },
    ]) {
      const app = harness('meditationManager', options);
      assert.equal((await app.run(options.event)).code, 'ENVIRONMENT_MISMATCH');
      assert.deepEqual([app.reads, app.writes], [[], []]);
    }
    const allowed = harness('meditationManager');
    assert.equal((await allowed.run({ ...request, targetEnv: 'test-env' })).success, true);
    assert.deepEqual(allowed.writes, []);
  });
}

test('migration writes require explicit all scope while authorized preview stays read only', async () => {
  const app = harness('meditationManager');
  assert.equal((await app.run({ type: 'migrateBusinessDates', targetEnv: 'test-env', dryRun: false })).code, 'TARGET_REQUIRED');
  assert.equal((await app.run({ type: 'migrateBusinessDates', dryRun: 'false' })).code, 'INVALID_DRY_RUN');
  assert.equal(app.reads.length, 0);
  assert.equal((await app.run({ type: 'migrateBusinessDates' })).success, true);
  assert.deepEqual(app.writes, []);
});
