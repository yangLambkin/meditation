const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createAdminManagerCaller } = require('./helpers/adminManagerCaller');

const NOW = Date.parse('2026-09-17T04:00:00Z');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const team = (extra = {}) => ({ _id: 'team', name: '一起冥想', creator: 'owner', creatorName: '队长',
  members: ['owner'], memberCount: 1, isActive: true, createdAt: '2026-09-01T00:00:00Z', ...extra });
const invitation = (extra = {}) => ({ _id: 'invite', teamId: 'team', inviterId: 'owner',
  status: 'pending', expireTime: new Date(NOW + 1000).toISOString(), ...extra });

function harness(initial = {}, options = {}) {
  const authorization = createAdminManagerCaller({ ...options,
    centralEnvironment: options.centralEnvironment || { ADMIN_OPENID: 'operator' } });
  let stored = clone({ admin_audit_logs: [], teams: [], team_members: [], invites: [], invite_actions: [], users: [], meditation_records: [], ...initial });
  const reads = [];
  const writes = [];
  let transactions = 0;
  const now = options.now || NOW;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function matches(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some(condition => matches(row, condition));
      if (value && value.inValues) return value.inValues.includes(row[key]);
      if (value && value.regex !== undefined) return new RegExp(value.regex, value.options).test(row[key]);
      if (value && value.bounds) return value.bounds.every(bound => bound.kind === 'gt' ? row[key] > bound.value :
        bound.kind === 'gte' ? row[key] >= bound.value : bound.kind === 'lt' ? row[key] < bound.value : row[key] <= bound.value);
      return Array.isArray(row[key]) ? row[key].includes(value) : row[key] === value;
    });
  }
  const shouldFail = (name, action) => {
    if (options.fail === `${name}:${action}`) throw new Error(`${name} ${action} unavailable`);
  };
  function collection(rows, name, inTransaction, readSet) {
    function query(filter = {}) {
      assert.equal(inTransaction, false, 'CloudBase transactions support document operations only');
      let offset = 0;
      let limit = 20;
      let projection;
      const orders = [];
      return {
        orderBy(field, direction) { orders.push([field, direction]); return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        field(value) { projection = value; return this; },
        async get() {
          shouldFail(name, 'get');
          reads.push({ name, filter: clone(filter), offset, limit, projection: clone(projection), inTransaction });
          const result = rows[name].filter(row => matches(row, filter)).sort((a, b) => {
            for (const [field, direction] of orders) {
              const order = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
              if (order) return direction === 'desc' ? -order : order;
            }
            return 0;
          });
          const data = clone(result.slice(offset, offset + limit).map(row => projection
            ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key])) : row));
          if (options.afterQuery) options.afterQuery({ name, filter: clone(filter), offset, limit, data: clone(data) }, rows);
          return { data };
        },
        async count() {
          shouldFail(name, 'count');
          reads.push({ name, filter: clone(filter), action: 'count' });
          return { total: rows[name].filter(row => matches(row, filter)).length };
        },
        async remove() {
          shouldFail(name, 'remove');
          writes.push({ name, action: 'removeWhere', inTransaction });
          const previous = rows[name].length;
          rows[name] = rows[name].filter(row => !matches(row, filter));
          return { stats: { removed: previous - rows[name].length } };
        }
      };
    }
    return {
      where: query,
      doc(id) {
        return {
          async get() {
            shouldFail(name, 'get');
            reads.push({ name, id, inTransaction });
            if (readSet) readSet.push([name, id]);
            return { data: clone(rows[name].find(row => row._id === id)) };
          },
          async update({ data }) {
            shouldFail(name, 'update');
            writes.push({ name, id, action: 'update', inTransaction });
            const target = rows[name].find(row => row._id === id);
            if (!target) throw new Error('document missing');
            Object.assign(target, clone(data));
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            shouldFail(name, 'set');
            writes.push({ name, id, action: 'set', inTransaction });
            rows[name] = rows[name].filter(row => row._id !== id);
            rows[name].push({ _id: id, ...clone(data) });
            return { _id: id };
          },
          async remove() {
            shouldFail(name, 'remove');
            writes.push({ name, id, action: 'remove', inTransaction });
            const previous = rows[name].length;
            rows[name] = rows[name].filter(row => row._id !== id);
            return { stats: { removed: previous - rows[name].length } };
          }
        };
      },
      async add({ data }) {
        assert.equal(inTransaction, false, 'transaction inserts must use a known document ID');
        shouldFail(name, 'add');
        writes.push({ name, action: 'add', inTransaction });
        const id = data._id || `${name}-${rows[name].length + 1}`;
        if (rows[name].some(row => row._id === id)) throw new Error('duplicate document');
        rows[name].push({ ...clone(data), _id: id });
        return { _id: id };
      }
    };
  }
  const bound = (kind, value) => ({ bounds: [{ kind, value }], and(other) { return { bounds: [...this.bounds, ...other.bounds] }; } });
  const database = {
    command: { lt: value => bound('lt', value), gt: value => bound('gt', value), gte: value => bound('gte', value), lte: value => bound('lte', value), in: values => ({ inValues: values }) },
    serverDate: () => new FixedDate(),
    RegExp: value => ({ regex: value.regexp, options: value.options }),
    collection: name => collection(stored, name, false),
    async runTransaction(callback) {
      transactions++;
      // Model optimistic document conflicts, not predicate locks/full serialization.
      // This tests the transaction boundaries; a deployed CloudBase integration is still separate.
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = clone(stored);
        const pending = clone(before);
        const readSet = [];
        const value = await callback({ collection: name => collection(pending, name, true, readSet) });
        if (options.fail === 'commit') throw new Error('commit unavailable');
        const changes = [];
        for (const name of Object.keys(pending)) {
          const ids = new Set([...before[name], ...pending[name]].map(row => row._id));
          for (const id of ids) {
            const original = before[name].find(row => row._id === id);
            const updated = pending[name].find(row => row._id === id);
            if (JSON.stringify(original) !== JSON.stringify(updated)) changes.push([name, id, updated]);
          }
        }
        const hasConflict = [...readSet, ...changes].some(([name, id]) =>
          JSON.stringify(before[name].find(row => row._id === id)) !== JSON.stringify(stored[name].find(row => row._id === id)));
        if (hasConflict) continue;
        for (const [name, id, updated] of changes) {
          stored[name] = stored[name].filter(row => row._id !== id);
          if (updated) stored[name].push(updated);
        }
        return value;
      }
      throw new Error('transaction conflict');
    }
  };
  function load(openid) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/teamManager/index.js'), 'utf8'), {
      module, exports: module.exports, Date: FixedDate, process: { env: options.env || {} }, console: { log() {}, warn() {}, error() {} },
      require(name) {
        if (name === 'crypto') return crypto;
        if (name === './maintenanceAuth') return require('../cloudfunctions/teamManager/maintenanceAuth');
        assert.equal(name, 'wx-server-sdk');
        const wxContext = { OPENID: openid, ...(options.wxContext || {}) };
        return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => database, getWXContext: () => wxContext,
          callFunction: request => authorization.call(request, wxContext) };
      }
    });
    return module.exports.main;
  }
  return {
    reads, writes, authRequests: authorization.requests,
    get stored() { return clone(stored); },
    get transactions() { return transactions; },
    async call(type, data, openid = 'operator', extra = {}) { return clone(await load(openid)({ type, data, ...extra })); }
  };
}

const roster = () => ({ teams: [team({ members: ['owner', 'member', 'third'], memberCount: 3 })],
  users: [{ _id: 'user-member', _openid: 'member', nickName: '新团长', privateField: 'hidden' }],
  team_members: [{ _id: 'team_member', teamId: 'team', openid: 'member', nickname: '旧昵称',
    role: 'member', status: 'active', joinedAt: '2026-09-02T00:00:00Z', checkInCount: 9 }] });
const transfer = { teamId: 'team', newLeaderOpenid: 'member', expectedLeaderOpenid: 'owner' };

test('team administration bundles an exact copy of the canonical server authorization helper', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../cloudfunctions/teamManager/maintenanceAuth.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../shared/maintenanceAuth.js'), 'utf8'));
});

test('every admin action rejects anonymous, ordinary and timer callers before all business access', async () => {
  for (const type of ['adminListTeams', 'adminTeamMembers', 'adminTransferLeader', 'adminAuditLogs']) {
    for (const openid of ['', 'owner', 'member', 'operator-extra']) {
      const app = harness(roster(), { wxContext: { SOURCE: 'wx_trigger' },
        env: { BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger' } });
      const result = await app.call(type, { ...transfer, OPENID: 'operator', admin: true }, openid,
        { OPENID: 'operator', openid: 'operator', admin: true, source: 'wx_trigger' });
      assert.equal(result.success, false, `${type}/${openid}`);
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.error, '仅指定的管理员微信账号可执行此操作');
      assert.deepEqual([app.reads, app.writes], [[], []]);
    }
    for (const ADMIN_OPENID of ['', undefined, 'operator,other', 'operator operator', 'operator;other']) {
      const disabled = harness(roster(), { centralEnvironment: { ADMIN_OPENID },
        env: { ADMIN_OPENIDS: 'operator', MAINTENANCE_ADMIN_OPENIDS: 'operator' } });
      assert.equal((await disabled.call(type, transfer)).code, 'FORBIDDEN');
      assert.deepEqual([disabled.reads, disabled.writes], [[], []]);
    }
  }
});

test('the second allowlisted administrator can manage teams and is recorded as the transfer operator', async () => {
  const app = harness(roster(), { centralEnvironment: { ADMIN_OPENIDS: 'first-admin,second-admin' } });
  const list = await app.call('adminListTeams', {}, 'second-admin');
  assert.equal(list.success, true);
  assert.equal(list.data.teams[0]._id, 'team');
  assert.equal((await app.call('adminTeamMembers', { teamId: 'team' }, 'second-admin')).data.members.length, 3);
  assert.equal((await app.call('adminTransferLeader', transfer, 'second-admin', { operator: 'forged' })).success, true);
  assert.equal(app.stored.teams[0].creator, 'member');
  assert.equal(app.stored.admin_audit_logs[0].operator, 'second-admin');
  const audit = await app.call('adminAuditLogs', {}, 'second-admin');
  assert.equal(audit.success, true);
  assert.equal(audit.data.logs[0].operator, 'second-admin');
});

test('all team admin actions reject outsiders and the replaced legacy account under a multi-admin allowlist', async () => {
  for (const type of ['adminListTeams', 'adminTeamMembers', 'adminTransferLeader', 'adminAuditLogs']) {
    for (const openid of ['', 'outsider', 'operator', 'second-admin-extra', 'maintenance']) {
      const app = harness(roster(), { wxContext: { SOURCE: 'wx_trigger' },
        centralEnvironment: { ADMIN_OPENIDS: 'first-admin,second-admin' }, env: {
        ADMIN_OPENIDS: 'operator,outsider,maintenance,second-admin-extra', MAINTENANCE_ADMIN_OPENIDS: 'maintenance',
        BIJING_TIMER_ENABLED: 'true', BIJING_TIMER_SOURCE: 'wx_trigger'
      } });
      const result = await app.call(type, { ...transfer, OPENID: 'second-admin', isAdmin: true }, openid,
        { OPENID: 'second-admin', ADMIN_OPENIDS: 'outsider', isAdmin: true });
      assert.equal(result.code, 'FORBIDDEN', `${type}/${openid}`);
      assert.deepEqual([app.reads, app.writes], [[], []]);
      assert.equal(app.transactions, 0);
    }
  }
});

test('team authorization failures expose no private details and prevent every administrative read or write', async () => {
  for (const type of ['adminListTeams', 'adminTeamMembers', 'adminTransferLeader', 'adminAuditLogs']) {
    for (const options of [
      { authError: new Error('private authorization endpoint failure') },
      { authResponse: { result: { success: true, data: { isAdmin: 'true' } } } },
      { authResponse: { result: { success: false, error: 'private authorization error' } } }
    ]) {
      const app = harness(roster(), { ...options, env: { ADMIN_OPENID: 'operator', ADMIN_OPENIDS: 'operator' } });
      assert.deepEqual(await app.call(type, transfer), {
        success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试'
      });
      assert.deepEqual([app.reads, app.writes], [[], []]);
      assert.equal(app.transactions, 0);
      assert.equal(app.authRequests.length, 1);
    }
  }
});

test('team actions wait for central authorization before touching business data', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = harness(roster(), { beforeAuthorize: () => gate });
  const pending = app.call('adminListTeams', {});
  assert.equal(app.authRequests.length, 1);
  assert.deepEqual([app.reads, app.writes], [[], []]);
  release();
  assert.equal((await pending).success, true);
  assert.ok(app.reads.length > 0);
});

test('central revocation applies to the next team request even when local configuration still lists the administrator', async () => {
  const centralEnvironment = { ADMIN_OPENIDS: 'first-admin,second-admin' };
  const app = harness(roster(), { centralEnvironment, env: { ADMIN_OPENIDS: 'second-admin' } });
  assert.equal((await app.call('adminListTeams', {}, 'second-admin')).success, true);
  const before = app.reads.length;
  centralEnvironment.ADMIN_OPENIDS = 'first-admin';
  assert.equal((await app.call('adminTransferLeader', transfer, 'second-admin')).code, 'FORBIDDEN');
  assert.equal(app.reads.length, before);
  assert.equal(app.writes.length, 0);
  assert.equal(app.authRequests.length, 2);
});

test('lost or substituted nested platform identity cannot authorize a team request', async () => {
  for (const centralContext of [{}, { OPENID: 'first-admin', SOURCE: 'wx_client,scf' }]) {
    const app = harness(roster(), { centralContext,
      centralEnvironment: { ADMIN_OPENIDS: 'first-admin,second-admin' } });
    assert.equal((await app.call('adminTransferLeader', transfer, 'second-admin')).code, 'FORBIDDEN');
    assert.deepEqual([app.reads, app.writes], [[], []]);
  }
});

test('normal team actions remain available without the central authorization service', async () => {
  const app = harness(roster(), { authError: new Error('authorization unavailable') });
  assert.equal((await app.call('getAllTeams', {}, '')).success, true);
  assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { name: '正常改名' } }, 'owner')).success, true);
  assert.deepEqual(app.authRequests, []);
});

test('team admin pagination excludes inactive rows and returns only administrative summary fields', async () => {
  const teams = Array.from({ length: 105 }, (_, index) => team({ _id: `team-${String(index).padStart(3, '0')}`,
    members: ['owner', 'member', 'member'], memberCount: 900, privateField: 'hidden' }));
  const app = harness({ teams: [...teams, team({ _id: 'team-hidden', isActive: false })] });
  const first = (await app.call('adminListTeams', {})).data;
  assert.equal(first.teams.length, 50);
  assert.equal(first.nextCursor, 'team-049');
  assert.deepEqual(first.teams[0], { _id: 'team-000', name: '一起冥想', creator: 'owner', creatorName: '队长', memberCount: 2 });
  const second = (await app.call('adminListTeams', { cursor: first.nextCursor })).data;
  const third = (await app.call('adminListTeams', { cursor: second.nextCursor })).data;
  assert.deepEqual([...first.teams, ...second.teams, ...third.teams].map(row => row._id), teams.map(row => row._id));
  assert.equal(third.nextCursor, null);
  assert.ok(app.reads.every(read => read.limit === 51 && read.offset === 0));
});

test('admin cursors reject query injection and invalid values without database access', async () => {
  for (const type of ['adminListTeams', 'adminAuditLogs']) {
    for (const cursor of [{ $gt: '' }, [], 12, '', ' ', 'x'.repeat(513)]) {
      const app = harness();
      assert.equal((await app.call(type, { cursor })).success, false);
      assert.equal(app.reads.length, 0);
    }
  }
});

test('member administration displays authoritative roster and minimal profiles with creator fallback', async () => {
  const initial = roster();
  initial.teams[0].members = ['member', 'member', 'third'];
  initial.team_members.push({ _id: 'team-former', teamId: 'team', openid: 'former' });
  const app = harness(initial);
  assert.deepEqual((await app.call('adminTeamMembers', { teamId: 'team' })).data, {
    teamId: 'team', members: [
      { openid: 'owner', nickname: '队长', isCreator: true },
      { openid: 'member', nickname: '新团长', isCreator: false },
      { openid: 'third', nickname: '匿名用户', isCreator: false }
    ]
  });
  assert.equal(JSON.stringify(app.reads).includes('meditation_records'), false);
  const invalid = harness({ teams: [team({ isActive: false })] });
  assert.equal((await invalid.call('adminTeamMembers', { teamId: 'team' })).success, false);
  assert.equal(invalid.reads.some(read => read.name === 'users'), false);
});

test('leader transfer atomically normalizes roster, updates both roles and retains relation metadata', async () => {
  const initial = roster();
  initial.teams[0].members = ['member', 'member', 'third'];
  initial.teams[0].memberCount = 99;
  const app = harness(initial);
  const result = await app.call('adminTransferLeader', { ...transfer, creatorName: 'forged', operator: 'forged' });
  assert.equal(result.success, true);
  assert.equal(result.data.creator, 'member');
  assert.equal(result.data.creatorName, '新团长');
  assert.equal(result.data.memberCount, 3);
  assert.deepEqual(app.stored.teams[0].members, ['owner', 'member', 'third']);
  assert.equal(app.stored.teams[0].creator, 'member');
  assert.equal(app.stored.teams[0].memberCount, 3);
  const oldLeader = app.stored.team_members.find(row => row.openid === 'owner');
  const newLeader = app.stored.team_members.find(row => row.openid === 'member');
  assert.equal(oldLeader.role, 'member');
  assert.equal(newLeader.role, 'creator');
  assert.equal(newLeader.nickname, '新团长');
  assert.equal(newLeader.joinedAt, initial.team_members[0].joinedAt);
  assert.equal(newLeader.checkInCount, 9);
  assert.deepEqual(app.stored.admin_audit_logs[0], { _id: result.data.auditId, action: 'transfer_team_leader',
    teamId: 'team', teamName: '一起冥想', operator: 'operator', previousLeader: { openid: 'owner', nickname: '队长' },
    newLeader: { openid: 'member', nickname: '新团长' }, createdAt: new Date(NOW).toISOString() });
  assert.ok(app.writes.every(write => write.inTransaction));
});

test('transfer validates active roster, expected leader and no-op before profiles and writes', async () => {
  for (const data of [
    { ...transfer, newLeaderOpenid: 'outsider' }, { ...transfer, newLeaderOpenid: 'owner' },
    { ...transfer, expectedLeaderOpenid: 'former' }, { ...transfer, expectedLeaderOpenid: undefined },
    { ...transfer, newLeaderOpenid: { $ne: '' } }, { ...transfer, teamId: 'missing' }
  ]) {
    const app = harness(roster());
    assert.equal((await app.call('adminTransferLeader', data)).success, false);
    assert.equal(app.writes.length, 0);
    assert.equal(app.reads.some(read => read.name === 'users'), false);
  }
});

test('leader transfer falls back to an existing member nickname without a profile', async () => {
  const initial = roster();
  initial.users = [];
  const app = harness(initial);
  assert.equal((await app.call('adminTransferLeader', transfer)).data.creatorName, '旧昵称');
});

test('concurrent transfers using a stale leader cannot overwrite the winning transfer', async () => {
  const app = harness(roster());
  const results = await Promise.all([
    app.call('adminTransferLeader', transfer),
    app.call('adminTransferLeader', { ...transfer, newLeaderOpenid: 'third' })
  ]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.match(results.find(result => !result.success).error, /团长已变更/);
  assert.equal(app.stored.admin_audit_logs.length, 1);
  assert.equal(app.stored.teams[0].creator, app.stored.admin_audit_logs[0].newLeader.openid);
  assert.equal(app.stored.teams[0].memberCount, 3);
});

test('removed target and changed leader are rechecked inside the transaction after profile lookup', async () => {
  for (const change of ['leave', 'transfer']) {
    const app = harness(roster(), { afterQuery({ name }, rows) {
      if (name !== 'users') return;
      if (change === 'leave') rows.teams[0].members = ['owner', 'third'];
      else rows.teams[0].creator = 'third';
    } });
    assert.equal((await app.call('adminTransferLeader', transfer)).success, false);
    assert.equal(app.writes.length, 0);
    assert.equal(app.stored.admin_audit_logs.length, 0);
  }
});

test('relation, audit or commit failures roll back leader, roster and roles together', async () => {
  for (const fail of ['team_members:set', 'admin_audit_logs:set', 'commit']) {
    const initial = roster();
    const app = harness(initial, { fail });
    assert.equal((await app.call('adminTransferLeader', transfer)).success, false);
    assert.deepEqual(app.stored.teams, initial.teams);
    assert.deepEqual(app.stored.team_members, initial.team_members);
    assert.equal(app.stored.admin_audit_logs.length, 0);
  }
});

test('new leader gains normal team control while the old leader remains a regular member', async () => {
  const app = harness(roster());
  assert.equal((await app.call('adminTransferLeader', transfer)).success, true);
  assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { description: 'new' } }, 'owner')).success, false);
  assert.equal((await app.call('updateTeam', { teamId: 'team', teamData: { description: 'new' } }, 'member')).success, true);
  assert.equal((await app.call('leaveTeam', { teamId: 'team' }, 'member')).success, false);
  assert.equal((await app.call('leaveTeam', { teamId: 'team' }, 'owner')).success, true);
  assert.deepEqual(app.stored.teams[0].members, ['member', 'third']);
  assert.equal(app.stored.teams[0].memberCount, 2);
});

test('audit list paginates newest first and omits unrelated stored fields', async () => {
  const logs = Array.from({ length: 51 }, (_, index) => ({ _id: `audit_${String(NOW + index)}_abc`,
    action: 'transfer_team_leader', teamId: 'team', teamName: '一起冥想', operator: 'operator',
    previousLeader: { openid: 'owner', nickname: '队长' }, newLeader: { openid: 'member', nickname: '成员' },
    createdAt: new Date(NOW + index).toISOString(), privateField: 'hidden' }));
  const app = harness({ admin_audit_logs: logs });
  const first = (await app.call('adminAuditLogs', {})).data;
  assert.equal(first.logs.length, 50);
  assert.equal(first.logs[0]._id, logs[50]._id);
  assert.equal(first.nextCursor, logs[1]._id);
  const second = (await app.call('adminAuditLogs', { cursor: first.nextCursor })).data;
  assert.deepEqual(second.logs.map(log => log._id), [logs[0]._id]);
  assert.equal(second.nextCursor, null);
  assert.equal(JSON.stringify(first).includes('hidden'), false);
});
