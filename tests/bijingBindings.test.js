const assert = require('node:assert/strict');
const test = require('node:test');
const { createBindings, bindingId, normalizeStudentNumber } = require('../cloudfunctions/bijingSync/bindings');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const profile = (openid, extra = {}) => ({ _id: `user-${openid}`, _openid: openid, nickName: '原昵称',
  bijingBound: false, bijingSyncedDates: {}, ...extra });

function harness(initial = {}, options = {}) {
  let stored = clone({ users: [], bijing_bindings: [], meditation_records: [], ...initial });
  const calls = { external: [], writes: [], queries: [], transactions: 0, conflicts: 0 };
  function matches(row, filter) {
    return Object.entries(filter).every(([key, expected]) => expected && expected.op === 'gt' ? row[key] > expected.value :
      expected && expected.op === 'regex' ? typeof row[key] === 'string' && new RegExp(expected.regexp, expected.options).test(row[key]) : row[key] === expected);
  }
  function collection(rows, name, transactional = false, reads = []) {
    if (options.missingCollection && name === 'bijing_bindings') throw Object.assign(new Error('private collection missing'), { code: 'DATABASE_COLLECTION_NOT_EXIST' });
    return {
      where(filter) {
        assert.equal(transactional, false, 'CloudBase transactions cannot perform predicate queries');
        let limit = 20;
        return {
          orderBy() { return this; }, limit(value) { limit = value; return this; },
          async get() {
            calls.queries.push({ name, filter });
            return { data: clone(rows[name].filter(row => matches(row, filter)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit)) };
          }
        };
      },
      doc(id) {
        return {
          async get() {
            reads.push([name, id]);
            if (options.malformedDocument === (transactional ? 'transaction' : 'snapshot')) return {};
            return { data: clone(rows[name].find(row => row._id === id)) || null };
          },
          async update({ data }) {
            assert.equal(transactional, true);
            if (options.fail === `${name}:update`) throw new Error('private write failure');
            const row = rows[name].find(row => row._id === id);
            assert.ok(row);
            Object.assign(row, clone(data));
            calls.writes.push({ name, id, kind: 'update' });
          },
          async set({ data }) {
            assert.equal(transactional, true);
            if (options.fail === `${name}:set`) throw new Error('private write failure');
            assert.equal(Object.hasOwn(data, '_id'), false);
            rows[name] = rows[name].filter(row => row._id !== id);
            rows[name].push({ _id: id, ...clone(data) });
            calls.writes.push({ name, id, kind: 'set' });
          }
        };
      }
    };
  }
  const db = {
    command: { gt: value => ({ op: 'gt', value }) },
    RegExp: value => ({ op: 'regex', ...value }),
    collection: name => collection(stored, name),
    async runTransaction(callback) {
      calls.transactions++;
      for (let attempt = 0; attempt < 10; attempt++) {
        const before = clone(stored), pending = clone(stored), readSet = [];
        const result = await callback({ collection: name => collection(pending, name, true, readSet) });
        const changes = [];
        for (const name of Object.keys(pending)) {
          for (const id of new Set([...before[name], ...pending[name]].map(row => row._id))) {
            const old = before[name].find(row => row._id === id), changed = pending[name].find(row => row._id === id);
            if (JSON.stringify(old) !== JSON.stringify(changed)) changes.push([name, id, changed]);
          }
        }
        if ([...readSet, ...changes].some(([name, id]) => JSON.stringify(before[name].find(row => row._id === id)) !==
          JSON.stringify(stored[name].find(row => row._id === id)))) { calls.conflicts++; continue; }
        if (options.fail === 'commit') throw new Error('private commit failure');
        for (const [name, id, changed] of changes) {
          stored[name] = stored[name].filter(row => row._id !== id);
          if (changed) stored[name].push(changed);
        }
        return result;
      }
      throw new Error('transaction conflict');
    }
  };
  const bindings = createBindings({ db, now: () => new Date('2026-09-23T01:00:00Z'),
    async checkStudentExists(number) {
      calls.external.push(number);
      if (options.apiError) throw options.apiError;
      return options.apiResponse || { success: true, data: { nickname: '必经昵称' } };
    } });
  return { ...bindings, calls, get stored() { return clone(stored); },
    addLegacy(row) { stored.users.push(clone(row)); } };
}

test('binding writes both deterministic reservations and the user atomically', async () => {
  const app = harness({ users: [profile('a')] });
  const result = await app.bind('a', '  BJabc-1  ');
  assert.equal(result.success, true);
  assert.equal(result.data.studentNumber, 'BJabc-1');
  assert.match(result.data.bindingVersion, /^[a-f0-9]{32}$/);
  const user = app.stored.users[0];
  assert.equal(user.nickName, '必经昵称');
  assert.equal(user.bijingBindingVersion, result.data.bindingVersion);
  for (const [kind, value] of [['student', 'BJABC-1'], ['account', 'a']]) {
    const registry = app.stored.bijing_bindings.find(row => row._id === bindingId(kind, value));
    assert.equal(registry.active, true);
    assert.equal(registry.studentNumber, 'BJABC-1');
    assert.equal(registry.openid, 'a');
    assert.equal(registry.userId, user._id);
    assert.equal(registry.bindingVersion, result.data.bindingVersion);
    assert.equal(registry.revision, 1);
  }
});

test('simultaneous accounts claiming case variants of a student number produce only one owner', async () => {
  const app = harness({ users: [profile('a'), profile('b')] });
  const results = await Promise.all([app.bind('a', 'BJabc'), app.bind('b', 'BJABC')]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.find(result => !result.success).code, 'STUDENT_ALREADY_BOUND');
  assert.equal(app.stored.users.filter(row => row.bijingBound).length, 1);
  assert.equal(app.stored.bijing_bindings.filter(row => row.kind === 'student' && row.active).length, 1);
  assert.ok(app.calls.conflicts > 0, 'the harness must exercise a real optimistic conflict');
});

test('simultaneous student numbers on one account cannot bypass unbind-before-switch', async () => {
  const app = harness({ users: [profile('a')] });
  const results = await Promise.all([app.bind('a', 'BJ001'), app.bind('a', 'BJ002')]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.find(result => !result.success).code, 'UNBIND_REQUIRED');
  assert.equal(app.stored.bijing_bindings.filter(row => row.kind === 'student' && row.active).length, 1);
  assert.ok(app.calls.conflicts > 0);
});

test('simultaneous first bindings create one deterministic user document', async () => {
  const app = harness();
  const results = await Promise.all([app.bind('a', 'BJ001'), app.bind('a', 'BJ001')]);
  assert.ok(results.every(result => result.success));
  assert.equal(app.stored.users.length, 1);
  assert.equal(results[0].data.bindingVersion, results[1].data.bindingVersion);
  assert.equal(app.stored.users[0]._id, bindingId('user', 'a'));
});

test('already bound accounts must unbind before switching and no external lookup is made', async () => {
  const app = harness({ users: [profile('a', { bijingBound: true, bijingStudentNumber: ' bj001 ' })] });
  assert.equal((await app.bind('a', 'BJ002')).code, 'UNBIND_REQUIRED');
  assert.deepEqual(app.calls.external, []);
  assert.deepEqual(app.calls.writes, []);
});

test('legacy claims are normalized and duplicates never arbitrarily transfer ownership', async () => {
  for (const users of [
    [profile('a', { bijingBound: true, bijingStudentNumber: ' bj.001 ' })],
    [profile('a', { bijingBound: true, bijingStudentNumber: 'BJ.001' }), profile('b', { bijingBound: true, bijingStudentNumber: ' bj.001 ' })]
  ]) {
    const app = harness({ users });
    assert.equal((await app.bind('c', 'BJ.001')).code, 'STUDENT_ALREADY_BOUND');
    assert.equal(app.calls.writes.length, 0);
    assert.equal(app.calls.external.length, 0);
  }
  const distinct = harness({ users: [profile('a', { bijingBound: true, bijingStudentNumber: 'BJx001' })] });
  assert.equal((await distinct.bind('b', 'BJ.001')).success, true, 'student IDs are matched literally, not as regex patterns');
});

test('a unique legacy owner can adopt reservations without losing its binding date or sync history', async () => {
  const original = profile('a', { bijingBound: true, bijingStudentNumber: ' bj001 ', bijingBoundAt: '2020-01-01', bijingSyncedDates: { '2026-09-20': true } });
  const app = harness({ users: [original] });
  const first = await app.bind('a', 'BJ001');
  const second = await app.bind('a', 'BJ001');
  assert.equal(first.success, true);
  assert.equal(second.data.bindingVersion, first.data.bindingVersion);
  assert.equal(app.stored.users[0].bijingBoundAt, original.bijingBoundAt);
  assert.deepEqual(app.stored.users[0].bijingSyncedDates, original.bijingSyncedDates);
});

test('unbind requires the current identity, student number and version and leaves personal history intact', async () => {
  const records = [{ _id: 'record', _openid: 'a', duration: 20 }];
  const app = harness({ users: [profile('a', { bijingSyncedDates: { '2026-09-20': true } })], meditation_records: records });
  const first = await app.bind('a', 'BJ001');
  for (const args of [['b', 'BJ001', first.data.bindingVersion], ['a', 'BJ002', first.data.bindingVersion],
    ['a', 'BJ001', 'old-version'], ['a', 'BJ001', undefined]]) {
    assert.equal((await app.unbind(...args)).code, 'BINDING_STALE');
  }
  const result = await app.unbind('a', ' bj001 ', first.data.bindingVersion);
  assert.equal(result.success, true);
  assert.equal(app.stored.users[0].bijingBound, false);
  assert.equal(app.stored.users[0].bijingStudentNumber, '');
  assert.deepEqual(app.stored.users[0].bijingSyncedDates, { '2026-09-20': true });
  assert.deepEqual(app.stored.meditation_records, records);
  const archived = app.stored.bijing_bindings.find(row => row.kind === 'history');
  assert.deepEqual(archived.profiles[0].syncedDates, { '2026-09-20': true });
  assert.ok(app.stored.bijing_bindings.filter(row => row.kind !== 'history').every(row => row.active === false && row.revision === 2));
});

test('unbinding permits another account to bind and an old unbind request cannot remove a new binding', async () => {
  const app = harness({ users: [profile('a'), profile('b')] });
  const original = await app.bind('a', 'BJ001');
  assert.equal((await app.unbind('a', 'BJ001', original.data.bindingVersion)).success, true);
  assert.equal((await app.bind('b', 'BJ001')).success, true);
  const rebound = await app.bind('a', 'BJ002');
  assert.equal(rebound.success, true);
  assert.equal((await app.unbind('a', 'BJ001', original.data.bindingVersion)).code, 'BINDING_STALE');
  assert.equal((await app.unbind('a', 'BJ002', original.data.bindingVersion)).code, 'BINDING_STALE');
  assert.equal(app.stored.users.find(row => row._openid === 'a').bijingBound, true);
});

test('a stale unbind cannot remove a later binding of the same student number', async () => {
  const app = harness({ users: [profile('a')] });
  const first = await app.bind('a', 'BJ001');
  assert.equal((await app.unbind('a', 'BJ001', first.data.bindingVersion)).success, true);
  const rebound = await app.bind('a', 'BJ001');
  assert.equal(rebound.success, true);
  assert.notEqual(rebound.data.bindingVersion, first.data.bindingVersion);
  assert.equal((await app.unbind('a', 'BJ001', first.data.bindingVersion)).code, 'BINDING_STALE');
  assert.equal(app.stored.users[0].bijingBindingVersion, rebound.data.bindingVersion);
  assert.equal(app.stored.users[0].bijingBound, true);
});

test('simultaneous unbind retries release and archive a binding only once', async () => {
  const app = harness({ users: [profile('a')] });
  const result = await app.bind('a', 'BJ001');
  const results = await Promise.all([app.unbind('a', 'BJ001', result.data.bindingVersion),
    app.unbind('a', 'BJ001', result.data.bindingVersion)]);
  assert.equal(results.filter(row => row.success).length, 1);
  assert.equal(results.find(row => !row.success).code, 'BINDING_STALE');
  assert.equal(app.stored.bijing_bindings.filter(row => row.kind === 'history').length, 1);
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'student').revision, 2);
  assert.ok(app.calls.conflicts > 0);
});

test('binding a different student after unbind resets only the current sync view, retaining the archived history', async () => {
  const app = harness({ users: [profile('a', { bijingBound: true, bijingStudentNumber: 'BJ001', bijingSyncedDates: { old: true } })] });
  assert.equal((await app.unbind('a', 'BJ001')).success, true);
  assert.equal((await app.bind('a', 'BJ002')).success, true);
  assert.deepEqual(app.stored.users[0].bijingSyncedDates, {});
  assert.deepEqual(app.stored.bijing_bindings.find(row => row.kind === 'history').profiles[0].syncedDates, { old: true });
});

test('a legacy duplicate can unbind itself without releasing another account reservation', async () => {
  const app = harness({ users: [profile('a')] });
  await app.bind('a', 'BJ001');
  app.addLegacy(profile('b', { bijingBound: true, bijingStudentNumber: ' bj001 ' }));
  const before = app.stored.bijing_bindings.find(row => row.kind === 'student');
  assert.equal((await app.unbind('b', 'BJ001')).success, true);
  const after = app.stored.bijing_bindings.find(row => row.kind === 'student');
  assert.equal(after.openid, 'a');assert.equal(after.active, true);
  assert.equal(after.bindingVersion, before.bindingVersion);assert.equal(after.revision, before.revision + 1);
  assert.equal(app.stored.users.find(row => row._openid === 'a').bijingBound, true);
  assert.equal((await app.bind('b', 'BJ001')).code, 'STUDENT_ALREADY_BOUND');
});

test('multiple legacy documents belonging to the same owner can all be unbound without affecting others', async () => {
  const app = harness({ users: [profile('a', { bijingBound: true, bijingStudentNumber: 'BJ001' }),
    profile('a', { _id: 'duplicate', bijingBound: true, bijingStudentNumber: ' bj001 ' }),
    profile('b', { bijingBound: true, bijingStudentNumber: 'BJ001' })] });
  assert.equal((await app.unbind('a', 'BJ001')).success, true);
  assert.ok(app.stored.users.filter(row => row._openid === 'a').every(row => !row.bijingBound));
  assert.equal(app.stored.users.find(row => row._openid === 'b').bijingBound, true);
});

test('legacy duplicate profiles can bind again after unbind with only one deterministic profile activated', async () => {
  const app = harness({ users: [profile('a', { _id: 'z', bijingBound: true, bijingStudentNumber: 'BJ001', bijingSyncedDates: { old: true } }),
    profile('a', { _id: 'a', bijingBound: true, bijingStudentNumber: ' bj001 ', bijingSyncedDates: { older: true } })] });
  assert.equal((await app.bind('a', 'BJ001')).code, 'BINDING_CONFLICT');
  assert.equal((await app.unbind('a', 'BJ001')).success, true);
  assert.equal((await app.bind('a', 'BJ002')).success, true);
  assert.deepEqual(app.stored.users.filter(row => row.bijingBound).map(row => row._id), ['a']);
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'account').userId, 'a');
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'history').profiles.length, 2);
});

test('a current binding token can remove same-owner legacy duplicates without weakening stale-token checks', async () => {
  const app = harness({ users: [profile('a')] });
  const current = await app.bind('a', 'BJ001');
  app.addLegacy(profile('a', { _id: 'legacy-duplicate', bijingBound: true, bijingStudentNumber: ' bj001 ' }));
  assert.equal((await app.unbind('a', 'BJ001')).code, 'BINDING_STALE');
  assert.equal((await app.unbind('a', 'BJ001', 'old-version')).code, 'BINDING_STALE');
  assert.equal((await app.unbind('a', 'BJ001', current.data.bindingVersion)).success, true);
  assert.ok(app.stored.users.every(row => !row.bijingBound));
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'history').profiles.length, 2);
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'student').active, false);
  assert.equal((await app.bind('a', 'BJ002')).success, true);
});

test('one active profile is retained when an earlier unbound legacy duplicate exists', async () => {
  const app = harness({ users: [profile('a', { _id: 'a-unbound' }),
    profile('a', { _id: 'z-active', bijingBound: true, bijingStudentNumber: 'BJ001' })] });
  assert.equal((await app.bind('a', 'BJ001')).success, true);
  assert.deepEqual(app.stored.users.filter(row => row.bijingBound).map(row => row._id), ['z-active']);
  assert.equal(app.stored.bijing_bindings.find(row => row.kind === 'student').userId, 'z-active');
});

test('malformed document reads cannot masquerade as missing reservations', async () => {
  for (const malformedDocument of ['snapshot', 'transaction']) {
    const app = harness({ users: [profile('a')] }, { malformedDocument });
    const before = app.stored;
    assert.equal((await app.bind('a', 'BJ001')).code, 'BINDING_UNAVAILABLE');
    assert.deepEqual(app.stored, before);
    assert.deepEqual(app.calls.writes, []);
  }
});

test('database failures roll back user, reservations and archive together and reveal no infrastructure details', async () => {
  for (const fail of ['users:update', 'bijing_bindings:set', 'commit']) {
    const initial = { users: [profile('a', { bijingBound: true, bijingStudentNumber: 'BJ001' })] };
    const app = harness(initial, { fail });
    const before = app.stored;
    assert.equal((await app.unbind('a', 'BJ001')).code, 'BINDING_UNAVAILABLE');
    assert.deepEqual(app.stored, before);
  }
  for (const options of [{ fail: 'users:update' }, { fail: 'bijing_bindings:set' }, { fail: 'commit' }, { missingCollection: true }]) {
    const app = harness({ users: [profile('a')] }, options);
    const before = app.stored;
    assert.deepEqual(await app.bind('a', 'BJ001'), { success: false, code: 'BINDING_UNAVAILABLE', error: '绑定状态暂时不可用，请稍后重试' });
    assert.deepEqual(app.stored, before);
  }
});

test('external nonexistence never creates a reservation or changes a profile', async () => {
  for (const options of [{ apiResponse: { success: false } }, { apiError: { response: { status: 404 } } },
    { apiError: new Error('private upstream secret') }]) {
    const app = harness({ users: [profile('a')] }, options);
    const result = await app.bind('a', 'BJ001');
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.deepEqual(app.calls.writes, []);
  }
});

test('normalization and both registry namespaces produce deterministic noncolliding IDs', () => {
  assert.equal(normalizeStudentNumber(' bjabc '), 'BJABC');
  assert.notEqual(bindingId('student', 'a'), bindingId('account', 'a'));
});
