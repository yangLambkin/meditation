const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createStudentAuthDatabase } = require('./helpers/studentAuthDatabase');

const ACTIONS = ['adminListWisdom', 'adminCreateWisdom', 'adminUpdateWisdom', 'adminDeleteWisdom'];
const quote = (id, content, extra = {}) => ({ _id: id, content, weight: -75, ...extra });

function harness(options = {}) {
  const rows = structuredClone(options.rows || [quote('legacy_001', '原有金句')]);
  const reads = [], writes = [];
  const authorization = createStudentAuthDatabase(options);
  const missing = () => Object.assign(new Error('collection wisdom_quotes does not exist'), { errCode: -502005 });
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && value.gt !== undefined) return row[key] > value.gt;
    if (value && value.regexp !== undefined) return typeof row[key] === 'string' && new RegExp(value.regexp, value.options).test(row[key]);
    return row[key] === value;
  });
  const checkRead = () => {
    if (options.readError) throw options.readError;
    if (options.missingCollection) throw missing();
  };
  function collection(state, inTransaction = false, pendingWrites = []) {
    let filter = {}, fields, limit = 20, order;
    return {
      where(value) { assert.equal(inTransaction, false, 'platform transactions support document operations only'); filter = value; return this; },
      field(value) { fields = value; return this; },
      limit(value) { limit = value; return this; },
      orderBy(field, direction) { order = [field, direction]; return this; },
      async count() {
        reads.push({ operation: 'count', filter: structuredClone(filter) }); checkRead();
        if (options.invalidCountResponse) return {};
        return { total: state.filter(row => matches(row, filter)).length };
      },
      async get() {
        reads.push({ operation: 'query', filter: structuredClone(filter), fields, limit, order }); checkRead();
        if (options.invalidReadResponse) return {};
        let result = state.filter(row => matches(row, filter));
        if (order) result = result.slice().sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : a[order[0]] > b[order[0]] ? 1 : 0) * (order[1] === 'asc' ? 1 : -1));
        result = result.slice(0, limit).map(row => fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])) : row);
        const response = { data: structuredClone(result) };
        if (options.afterQuery) await options.afterQuery({ rows, filter, reads });
        return response;
      },
      doc(id) {
        return {
          async get() {
            reads.push({ operation: 'doc', id, inTransaction }); checkRead();
            if (options.invalidReadResponse) return {};
            return { data: structuredClone(state.find(row => row._id === id)) };
          },
          async set({ data }) {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            pendingWrites.push({ id, operation: 'set', data: structuredClone(data) });
            const index = state.findIndex(row => row._id === id);
            if (index !== -1) state.splice(index, 1);
            state.push({ ...structuredClone(data), _id: id });
            return { _id: id };
          },
          async update({ data }) {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            const row = state.find(row => row._id === id);
            assert.ok(row);
            pendingWrites.push({ id, operation: 'update', data: structuredClone(data) });
            Object.assign(row, structuredClone(data));
            return { stats: { updated: 1 } };
          },
          async remove() {
            assert.equal(inTransaction, true);
            if (options.writeError) throw options.writeError;
            const index = state.findIndex(row => row._id === id);
            assert.notEqual(index, -1);
            pendingWrites.push({ id, operation: 'remove' });
            state.splice(index, 1);
            return { stats: { removed: 1 } };
          }
        };
      }
    };
  }
  const db = {
    command: { gt: value => ({ gt: value }) }, RegExp: authorization.db.RegExp,
    collection(name) {
      if (name === 'users' || name === 'bijing_bindings') return authorization.db.collection(name);
      assert.equal(name, 'wisdom_quotes');
      return collection(rows);
    },
    async runTransaction(callback) {
      return authorization.db.runTransaction(async authTransaction => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const original = JSON.stringify(rows), pending = structuredClone(rows), pendingWrites = [];
          const result = await callback({ collection(name) {
            if (name === 'users' || name === 'bijing_bindings') return authTransaction.collection(name);
            assert.equal(name, 'wisdom_quotes');
            return collection(pending, true, pendingWrites);
          } });
          if (original !== JSON.stringify(rows)) continue;
          if (pendingWrites.length) {
            if (options.commitError) throw options.commitError;
            rows.splice(0, rows.length, ...pending);
            writes.push(...pendingWrites);
          }
          return result;
        }
        throw new Error('transaction conflict');
      });
    }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/adminManager/index.js'), 'utf8'), {
    exports, process: { env: options.environment || { ADMIN_STUDENT_NUMBERS: 'BJ0099' } },
    require(name) {
      if (['./studentAuth', './delegation', './maintenanceAuth', './wisdom'].includes(name)) return require(`../cloudfunctions/adminManager/${name.slice(2)}`);
      assert.equal(name, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => options.context || { OPENID: 'admin' }, database: () => db };
    }
  });
  const run = async event => JSON.parse(JSON.stringify(await exports.main(event)));
  return { rows, reads, writes, authUsers: authorization.users, run,
    list: event => run({ type: 'adminListWisdom', ...event }),
    create: event => run({ type: 'adminCreateWisdom', content: ' 新增金句 ', requestId: 'request-1', ...event }),
    update: event => run({ type: 'adminUpdateWisdom', quoteId: 'legacy_001', expectedContent: '原有金句', content: ' 修改金句 ', ...event }),
    remove: event => run({ type: 'adminDeleteWisdom', quoteId: 'legacy_001', expectedContent: '原有金句', ...event }) };
}

test('wisdom operations require the existing central bound-student administrator gate before quote access', async () => {
  for (const context of [{ OPENID: 'ordinary' }, { OPENID: 'maintenance' }, {}, { SOURCE: 'wx_trigger' }]) {
    const app = harness({ context });
    for (const type of ACTIONS) {
      assert.equal((await app.run({ type, OPENID: 'admin', openid: 'admin', isAdmin: true,
        studentNumber: 'BJ0099', accessDelegation: { openid: 'admin' } })).code, 'FORBIDDEN');
    }
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
  for (const environment of [{}, { ADMIN_OPENID: 'admin' }, { MAINTENANCE_ADMIN_OPENIDS: 'admin' }, { ADMIN_STUDENT_NUMBERS: 'BJ0099,' }]) {
    const app = harness({ environment });
    for (const type of ACTIONS) assert.equal((await app.run({ type })).code, 'FORBIDDEN');
    assert.equal(app.reads.length, 0);
  }
});

test('authorization outages fail closed and unbinding revokes all quote access immediately', async () => {
  const failed = harness({ authDatabaseError: new Error('private connection') });
  for (const type of ACTIONS) assert.equal((await failed.run({ type })).code, 'ADMIN_AUTH_UNAVAILABLE');
  assert.equal(failed.reads.length, 0);
  const app = harness();
  assert.equal((await app.list()).success, true);
  app.authUsers.find(row => row._openid === 'admin').bijingBound = false;
  const reads = app.reads.length;
  for (const type of ACTIONS) assert.equal((await app.run({ type })).code, 'FORBIDDEN');
  assert.equal(app.reads.length, reads);
});

test('literal substring search, stable keyset pagination and counts cover more than the platform default page', async () => {
  const rows = Array.from({ length: 61 }, (_, i) => quote(`wq_${String(i).padStart(3, '0')}`, `静.*心 ${i}`, { privateMetadata: 'hidden' }));
  rows.push(quote('z_other', '静心'));
  const app = harness({ rows });
  const combined = []; let cursor = '';
  do {
    const result = await app.list({ keyword: ' 静.*心 ', limit: 20, cursor });
    assert.equal(result.success, true); assert.equal(result.data.total, 61);
    assert.ok(result.data.quotes.every(row => Object.keys(row).sort().join() === '_id,content'));
    combined.push(...result.data.quotes); cursor = result.data.nextCursor;
  } while (cursor);
  assert.deepEqual(combined.map(row => row._id), rows.slice(0, 61).map(row => row._id));
  assert.equal((await app.list()).data.total, 62);
});

test('legacy empty and NULL contents remain visible and repairable without exposing other fields', async () => {
  for (const content of ['', 'NULL', null, 42, false]) {
    const app = harness({ rows: [quote('b8ca528e697b7ff9006c303034e4bb27', content, { weight: 9, metadata: { keep: true } })] });
    const row = (await app.list()).data.quotes[0];
    assert.equal(row.content, content);
    const result = await app.update({ quoteId: row._id, expectedContent: content });
    assert.equal(result.success, true); assert.equal(app.rows[0].weight, 9); assert.deepEqual(app.rows[0].metadata, { keep: true });
  }
});

test('invalid list arguments and cursor reuse under another keyword fail before quote reads', async () => {
  for (const event of [{ keyword: {} }, { keyword: '字'.repeat(101) }, { limit: 0 }, { limit: 51 }, { limit: '20' },
    { cursor: {} }, { cursor: 'bad-cursor' }, { cursor: 'a'.repeat(1025) }]) {
    const app = harness();
    assert.equal((await app.list(event)).code, 'INVALID_ARGUMENT'); assert.equal(app.reads.length, 0);
  }
  const app = harness({ rows: [quote('a', '甲'), quote('b', '甲')] });
  const first = await app.list({ keyword: '甲', limit: 1 });
  const reads = app.reads.length;
  assert.equal((await app.list({ keyword: '乙', cursor: first.data.nextCursor })).code, 'INVALID_ARGUMENT');
  assert.equal(app.reads.length, reads);
});

test('create trims text, owns metadata and is idempotent across lost responses and concurrent double taps', async () => {
  const app = harness();
  const results = await Promise.all([app.create({ weight: 100, _id: 'spoofed' }), app.create()]);
  assert.ok(results.every(result => result.success));
  assert.equal(results.filter(result => result.data.created).length, 1);
  assert.equal(app.rows.length, 2); assert.equal(app.writes.length, 1);
  const created = app.rows.find(row => row.content === '新增金句');
  assert.match(created._id, /^wq_admin_[a-f0-9]{64}$/); assert.equal(created.weight, 1);
  assert.equal((await app.create()).data.created, false);
  assert.equal((await app.create({ content: '不同内容' })).code, 'REQUEST_ID_REUSED');
  assert.equal(app.rows.length, 2);
});

test('create retries preserve an intervening edit, and creating the original text again uses a fresh request', async () => {
  const app = harness();
  const row = (await app.create()).data.quote;
  assert.equal((await app.update({ quoteId: row._id, expectedContent: row.content, content: '后来修改的金句' })).success, true);
  const retry = await app.create();
  assert.equal(retry.data.quote.content, '后来修改的金句'); assert.equal(retry.data.created, false);
  assert.equal((await app.create({ requestId: 'request-2' })).success, true);
  assert.equal(app.rows.filter(item => item.content === '新增金句').length, 1);
});

test('duplicate content is rejected for creation and editing, including legacy existing IDs', async () => {
  const app = harness({ rows: [quote('legacy_001', '原有金句'), quote('wq_012345', '已存在的金句')] });
  assert.equal((await app.create({ content: ' 已存在的金句 ' })).code, 'DUPLICATE_CONTENT');
  assert.equal((await app.update({ content: '已存在的金句' })).code, 'DUPLICATE_CONTENT');
  assert.equal(app.writes.length, 0);
  assert.equal((await app.update({ content: ' 原有金句 ' })).success, true);
  assert.equal(app.writes.length, 0, 'unchanged saves do not write');
});

test('edits touch only content and use exact untrimmed old content for optimistic concurrency', async () => {
  const original = quote('wq_legacy', '  旧金句  ', { weight: -107, createdAt: 'old', custom: { keep: 1 } });
  const app = harness({ rows: [original] });
  assert.equal((await app.update({ quoteId: original._id, expectedContent: '旧金句' })).code, 'CONFLICT');
  const result = await app.update({ quoteId: original._id, expectedContent: original.content, weight: 999, custom: null });
  assert.deepEqual(result, { success: true, data: { quote: { _id: original._id, content: '修改金句' } } });
  assert.deepEqual(app.rows[0], { ...original, content: '修改金句' });
  assert.deepEqual(app.writes[0].data, { content: '修改金句' });
});

test('two competing edits with the same content revision allow only one committed write', async () => {
  const app = harness();
  const results = await Promise.all([app.update({ content: '管理员甲的修改' }), app.update({ content: '管理员乙的修改' })]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
  assert.equal(app.writes.length, 1);
});

test('transaction rechecks content after a competing edit during duplicate lookup', async () => {
  const app = harness({ afterQuery({ rows }) { rows[0].content = '另一位管理员刚保存的内容'; } });
  const result = await app.update();
  assert.equal(result.code, 'CONFLICT'); assert.equal(app.rows[0].content, '另一位管理员刚保存的内容');
  assert.equal(app.writes.length, 0);
});

test('deletion checks exact content, preserves other quotes and safely repeats missing-document deletion', async () => {
  const app = harness({ rows: [quote('legacy_001', '原有金句'), quote('wq_new', '保留金句')] });
  assert.equal((await app.remove({ expectedContent: '过期版本' })).code, 'CONFLICT');
  const result = await app.remove();
  assert.deepEqual(result, { success: true, data: { quoteId: 'legacy_001', deleted: true } });
  assert.deepEqual(await app.remove(), result);
  assert.deepEqual(app.rows, [quote('wq_new', '保留金句')]); assert.equal(app.writes.length, 1);
});

test('invalid IDs, text, request tokens and revisions cannot access or change quote data', async () => {
  const invalidText = ['', ' ', null, {}, 1, '字'.repeat(501)];
  for (const content of invalidText) {
    const app = harness();
    assert.equal((await app.create({ content })).code, 'INVALID_ARGUMENT');
    assert.equal((await app.update({ content })).code, 'INVALID_ARGUMENT');
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
  for (const requestId of ['', {}, '../id', 'x'.repeat(101)]) {
    const app = harness(); assert.equal((await app.create({ requestId })).code, 'INVALID_ARGUMENT'); assert.equal(app.reads.length, 0);
  }
  for (const event of [{ quoteId: '../id' }, { quoteId: { $ne: '' } }, { quoteId: '' },
    { expectedContent: undefined }, { expectedContent: { $ne: '' } }, { expectedContent: 'x'.repeat(10001) }]) {
    const app = harness();
    assert.equal((await app.update(event)).code, 'INVALID_ARGUMENT');
    assert.equal((await app.remove(event)).code, 'INVALID_ARGUMENT');
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('missing documents never become phantom updates and missing collections are not created by reads', async () => {
  const absent = harness({ rows: [] });
  assert.equal((await absent.update()).code, 'NOT_FOUND'); assert.equal(absent.writes.length, 0);
  const missing = harness({ missingCollection: true });
  assert.deepEqual((await missing.list()).data, { quotes: [], total: 0, nextCursor: '' });
  assert.equal((await missing.create()).code, 'WISDOM_UNAVAILABLE'); assert.equal(missing.writes.length, 0);
});

test('read, write and commit failures never claim success or expose internal details', async () => {
  for (const options of [{ readError: new Error('private connection string') }, { invalidReadResponse: true },
    { writeError: new Error('private write failure') }, { commitError: new Error('private commit failure') }]) {
    const app = harness(options), original = structuredClone(app.rows);
    const result = await app.update();
    assert.equal(result.code, 'WISDOM_UNAVAILABLE'); assert.equal(result.data, undefined);
    assert.equal(result.error.includes('private'), false); assert.deepEqual(app.rows, original);
  }
  assert.equal((await harness({ invalidCountResponse: true }).list()).code, 'WISDOM_UNAVAILABLE');
});
