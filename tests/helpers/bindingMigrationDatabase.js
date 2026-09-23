const assert = require('node:assert/strict');

const clone = value => value === undefined ? undefined : structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// A document-level optimistic database: query reads are deliberately forbidden
// inside transactions, matching the CloudBase transaction API.
function createBindingMigrationDatabase(initial = {}, options = {}) {
  const stored = clone({ users: [], bijing_bindings: [], meditation_records: [], ...initial });
  const calls = { queries: [], reads: [], writes: [], committedWrites: [], transactions: 0, conflicts: 0 };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && value.op === 'gt') return row[key] > value.value;
    if (value && value.op === 'regex') return typeof row[key] === 'string' && new RegExp(value.regexp, value.options).test(row[key]);
    return row[key] === value;
  });

  function collection(state, name, transactional = false, readSet = []) {
    if (options.missingCollection === name) throw Object.assign(new Error('missing collection'), { code: 'DATABASE_COLLECTION_NOT_EXIST' });
    assert.ok(Object.hasOwn(state, name), `Unexpected collection ${name}`);
    return {
      where(filter) {
        assert.equal(transactional, false, 'CloudBase transactions cannot query predicates');
        let maximum = 20;
        let descending = false;
        return {
          orderBy(key, direction) { assert.equal(key, '_id'); descending = direction === 'desc'; return this; },
          limit(value) { maximum = value; return this; },
          async get() {
            const read = { name, filter: clone(filter), limit: maximum };
            calls.queries.push(read);
            const rows = state[name].filter(row => matches(row, filter)).sort((a, b) => a._id.localeCompare(b._id));
            if (descending) rows.reverse();
            const result = { data: clone(rows.slice(0, maximum)) };
            if (options.afterQuery) await options.afterQuery(read, stored);
            return result;
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const read = { name, id, transactional };
            calls.reads.push(read);
            if (transactional) readSet.push([name, id]);
            if (options.failRead === name) throw new Error('read failed');
            const result = { data: clone(state[name].find(row => row._id === id)) || null };
            if (options.afterRead) await options.afterRead(read, stored);
            return result;
          },
          async update({ data }) {
            assert.equal(transactional, true, 'Migration writes must be atomic');
            if (options.failWrite === `${name}:update`) throw new Error('update failed');
            const existing = state[name].find(row => row._id === id);
            assert.ok(existing, `Missing ${name}/${id}`);
            Object.assign(existing, clone(data));
            calls.writes.push({ name, id, action: 'update', data: clone(data) });
          },
          async set({ data }) {
            assert.equal(transactional, true, 'Migration writes must be atomic');
            if (options.failWrite === `${name}:set`) throw new Error('set failed');
            assert.equal(Object.hasOwn(data, '_id'), false);
            const position = state[name].findIndex(row => row._id === id);
            if (position !== -1) state[name].splice(position, 1);
            state[name].push({ _id: id, ...clone(data) });
            calls.writes.push({ name, id, action: 'set', data: clone(data) });
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
      if (options.beforeTransaction) await options.beforeTransaction(stored);
      for (let attempt = 0; attempt < 10; attempt++) {
        const before = clone(stored), pending = clone(stored), readSet = [];
        const result = await callback({ collection: name => collection(pending, name, true, readSet) });
        const changes = [];
        for (const name of Object.keys(stored)) {
          const ids = new Set([...before[name], ...pending[name]].map(row => row._id));
          for (const id of ids) {
            const old = before[name].find(row => row._id === id), current = pending[name].find(row => row._id === id);
            if (!same(old, current)) changes.push([name, id, current]);
          }
        }
        if ([...readSet, ...changes].some(([name, id]) => !same(before[name].find(row => row._id === id), stored[name].find(row => row._id === id)))) {
          calls.conflicts++;
          continue;
        }
        if (options.failCommit) throw new Error('commit failed');
        for (const [name, id, current] of changes) {
          const position = stored[name].findIndex(row => row._id === id);
          if (position !== -1) stored[name].splice(position, 1);
          if (current) stored[name].push(clone(current));
          calls.committedWrites.push({ name, id });
        }
        return result;
      }
      throw new Error('transaction conflict');
    }
  };
  return { db, calls, get stored() { return clone(stored); } };
}

module.exports = { createBindingMigrationDatabase };
