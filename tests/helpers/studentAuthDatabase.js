const assert = require('node:assert/strict');

function adminBindings(defaultAdmin = 'admin') {
  return [[defaultAdmin, 'BJ0099'], ['first-admin', 'BJ0001'], ['second-admin', 'BJ0002']]
    .map(([openid, studentNumber]) => ({ _id: `auth-${openid}`, _openid: openid,
      bijingBound: true, bijingStudentNumber: studentNumber }));
}

// Mutable authorization rows are separate from business data. Transactions model
// optimistic document conflicts, including simultaneous consumption of a proof.
function createStudentAuthDatabase(options = {}) {
  const users = options.authUsers || adminBindings(options.adminOpenid);
  const locks = options.authLocks || [];
  const stored = { users, bijing_bindings: locks };
  const reads = [], writes = [];
  let conflicts = 0;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) =>
    value && value.regexp !== undefined ? new RegExp(value.regexp, value.options).test(row[key] || '') : row[key] === value);
  const finishRead = async (read, data) => {
    if (options.authDatabaseError) throw options.authDatabaseError;
    const result = { data: clone(data) };
    if (options.authAfterRead) await options.authAfterRead(read, { users, locks, reads });
    return options.authReadResult ? options.authReadResult(read, result, reads.length) : result;
  };
  function collection(state, name, inTransaction = false, readSet = []) {
    assert.ok(['users', 'bijing_bindings'].includes(name), `unexpected authorization collection ${name}`);
    const rows = state[name];
    return {
      where(filter) {
        assert.equal(inTransaction, false, 'authorization transactions use document operations only');
        let limit = 20;
        let projection;
        return {
          limit(value) { limit = value; return this; },
          field(value) { projection = value; return this; },
          async get() {
            const read = { name, filter: clone(filter), limit };
            reads.push(read);
            let result = rows.filter(row => matches(row, filter)).slice(0, limit);
            if (projection) result = result.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => projection[key])));
            return finishRead(read, result);
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const read = { name, id, inTransaction };
            reads.push(read);
            if (inTransaction) readSet.push([name, id]);
            return finishRead(read, rows.find(row => row._id === id));
          },
          async set({ data }) {
            writes.push({ name, id, data: clone(data), action: 'set', inTransaction });
            if (options.authWriteError) throw options.authWriteError;
            const index = rows.findIndex(row => row._id === id);
            if (index !== -1) rows.splice(index, 1);
            rows.push({ ...clone(data), _id: id });
            return { _id: id };
          },
          async remove() {
            writes.push({ name, id, action: 'remove', inTransaction });
            if (options.authRemoveError) throw options.authRemoveError;
            const index = rows.findIndex(row => row._id === id);
            if (index !== -1) rows.splice(index, 1);
            return { stats: { removed: index === -1 ? 0 : 1 } };
          }
        };
      }
    };
  }
  const db = {
    RegExp: value => ({ ...value }),
    collection: name => collection(stored, name),
    async runTransaction(callback) {
      if (options.authBeforeTransaction) await options.authBeforeTransaction({ users, locks, reads });
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = clone(stored), pending = clone(stored), readSet = [];
        const value = await callback({ collection: name => collection(pending, name, true, readSet) });
        const changes = [];
        for (const name of Object.keys(stored)) {
          for (const id of new Set([...before[name], ...pending[name]].map(row => row._id))) {
            const original = before[name].find(row => row._id === id), updated = pending[name].find(row => row._id === id);
            if (JSON.stringify(original) !== JSON.stringify(updated)) changes.push([name, id, updated]);
          }
        }
        if ([...readSet, ...changes].some(([name, id]) =>
          JSON.stringify(before[name].find(row => row._id === id)) !== JSON.stringify(stored[name].find(row => row._id === id)))) {
          conflicts++;
          continue;
        }
        if (options.authCommitError) throw options.authCommitError;
        for (const [name, id, updated] of changes) {
          const index = stored[name].findIndex(row => row._id === id);
          if (index !== -1) stored[name].splice(index, 1);
          if (updated) stored[name].push(updated);
        }
        return value;
      }
      throw new Error('authorization transaction conflict');
    }
  };
  return { db, reads, writes, users, locks, get conflicts() { return conflicts; } };
}

module.exports = { adminBindings, createStudentAuthDatabase };
