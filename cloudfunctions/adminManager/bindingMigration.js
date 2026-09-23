const crypto = require('crypto');
const COLLECTION = 'bijing_bindings';
const normalizeStudentNumber = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const bindingId = (kind, value) => `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;

const MIGRATION = 'legacy-bindings-v1';
const revision = row => row ? row.revision : 0;
const validRevision = row => Number.isSafeInteger(row.revision) && row.revision > 0 && row.revision < Number.MAX_SAFE_INTEGER;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const changed = () => Object.assign(new Error('Binding changed during migration'), { code: 'MIGRATION_RETRY' });

async function readDocument(database, collection, id) {
  try {
    const response = await database.collection(collection).doc(id).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('Invalid database response');
    const row = response.data;
    if (row !== null && row !== undefined && (typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid database document');
    return row || null;
  } catch (error) {
    if (['DATABASE_DOCUMENT_NOT_EXIST', 'DOCUMENT_NOT_FOUND'].includes(error.code || error.errCode)) return null;
    throw error;
  }
}

function createBindingMigration({ db, now = () => new Date() }) {
  async function queryUsers(filter) {
    const rows = [];
    let cursor = '';
    while (true) {
      const result = await db.collection('users').where({ ...filter,
        ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(100).get();
      if (!result || !Array.isArray(result.data)) throw new Error('Invalid users response');
      rows.push(...result.data);
      if (result.data.length < 100) return rows;
      cursor = result.data[result.data.length - 1]._id;
    }
  }

  async function snapshot(candidate, number) {
    const studentId = bindingId('student', number);
    const accountId = bindingId('account', candidate._openid);
    // Like bind/unbind, read both reservation revisions BEFORE predicate queries.
    // All live binding writers must use these reservations before migration runs.
    const student = await readDocument(db, COLLECTION, studentId);
    const account = await readDocument(db, COLLECTION, accountId);
    const own = await queryUsers({ _openid: candidate._openid });
    const owners = await queryUsers({ bijingBound: true,
      bijingStudentNumber: db.RegExp({ regexp: `^\\s*${escapeRegex(number)}\\s*$`, options: 'i' }) });
    return { studentId, accountId, student, account, own, owners };
  }

  function inspect(candidate, number, state) {
    const user = state.own.find(row => row._id === candidate._id);
    if (!user || user.bijingBound !== true || normalizeStudentNumber(user.bijingStudentNumber) !== number) {
      return { reason: 'BINDING_CHANGED' };
    }
    if (state.own.filter(row => row.bijingBound === true).length !== 1) return { reason: 'DUPLICATE_ACCOUNT' };
    if (state.owners.length !== 1 || state.owners[0]._id !== user._id || state.owners[0]._openid !== user._openid) {
      return { reason: 'DUPLICATE_STUDENT' };
    }
    const version = user.bijingBindingVersion;
    if (version !== undefined && typeof version !== 'string') return { reason: 'INVALID_BINDING_VERSION' };
    for (const [kind, lock] of [['student', state.student], ['account', state.account]]) {
      if (!lock) continue;
      if (!validRevision(lock) || lock.kind !== kind || typeof lock.active !== 'boolean' ||
          typeof lock.bindingVersion !== 'string' || typeof lock.userId !== 'string' || !lock.userId ||
          typeof lock.openid !== 'string' || !/^[A-Za-z0-9_-]+$/.test(lock.openid) || lock.studentNumber !== number) {
        return { reason: 'INVALID_REGISTRY' };
      }
      if (!lock.active) {
        // A different legacy owner's unbind may have left a student tombstone.
        // Never revive this account's own inactive reservation.
        if (kind === 'student' && !version && !state.account && lock.openid !== user._openid) continue;
        return { reason: 'INACTIVE_REGISTRY' };
      }
      if (lock.openid !== user._openid || lock.userId !== user._id || !version || lock.bindingVersion !== version) {
        return { reason: 'REGISTRY_CONFLICT' };
      }
    }
    return { user, alreadyManaged: Boolean(state.student && state.student.active && state.account && state.account.active) };
  }

  async function verifySnapshot(transaction, state) {
    const student = await readDocument(transaction, COLLECTION, state.studentId);
    const account = await readDocument(transaction, COLLECTION, state.accountId);
    if (Boolean(student) !== Boolean(state.student) || Boolean(account) !== Boolean(state.account) ||
        revision(student) !== revision(state.student) || revision(account) !== revision(state.account)) throw changed();
    const rows = new Map();
    for (const before of [...state.own, ...state.owners]) {
      if (rows.has(before._id)) continue;
      const current = await readDocument(transaction, 'users', before._id);
      if (!current || current._openid !== before._openid || current.bijingBound !== before.bijingBound ||
          current.bijingStudentNumber !== before.bijingStudentNumber ||
          current.bijingBindingVersion !== before.bijingBindingVersion) throw changed();
      rows.set(before._id, current);
    }
    return { ...state, student, account,
      own: state.own.map(row => rows.get(row._id)), owners: state.owners.map(row => rows.get(row._id)) };
  }

  async function migrateOne(candidate, dryRun) {
    const number = normalizeStudentNumber(candidate.bijingStudentNumber);
    const item = { userId: candidate._id, studentNumber: number };
    if (typeof candidate._id !== 'string' || !candidate._id || typeof candidate._openid !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(candidate._openid) || !/^BJ[A-Z0-9_-]{1,62}$/.test(number)) {
      return { ...item, status: 'conflict', reason: 'INVALID_PROFILE' };
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await snapshot(candidate, number);
      const plan = inspect(candidate, number, state);
      if (plan.reason) return { ...item, status: 'conflict', reason: plan.reason };
      try {
        return await db.runTransaction(async transaction => {
          const current = await verifySnapshot(transaction, state);
          const checked = inspect(candidate, number, current);
          if (checked.reason) return { ...item, status: 'conflict', reason: checked.reason };
          const before = dryRun ? { user: checked.user, student: current.student, account: current.account } : undefined;
          if (checked.alreadyManaged) return { ...item, status: 'already_managed', ...(dryRun ? { before } : {}) };
          if (dryRun) return { ...item, status: 'would_migrate', before };
          const { user } = checked;
          const bindingVersion = user.bijingBindingVersion || crypto.randomBytes(16).toString('hex');
          // Preserve the original profile, student-number spelling, nickname,
          // boundAt, sync dates, and all personal records. No external API calls.
          if (!user.bijingBindingVersion) {
            await transaction.collection('users').doc(user._id).update({ data: { bijingBindingVersion: bindingVersion } });
          }
          const entry = { studentNumber: number, openid: user._openid, userId: user._id,
            bindingVersion, active: true, migration: MIGRATION, migratedAt: now() };
          for (const [kind, id, prior] of [['student', state.studentId, current.student], ['account', state.accountId, current.account]]) {
            if (prior && prior.active) continue;
            await transaction.collection(COLLECTION).doc(id).set({ data: {
              ...entry, kind, revision: revision(prior) + 1 } });
          }
          return { ...item, status: 'migrated' };
        });
      } catch (error) {
        if (error.code !== 'MIGRATION_RETRY') throw error;
        if (attempt === 3) return { ...item, status: 'conflict', reason: 'BINDING_CHANGED' };
      }
    }
  }

  async function run({ dryRun = true, cursor = '', limit = 20 } = {}) {
    if (typeof dryRun !== 'boolean' || typeof cursor !== 'string' ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid migration options');
    const response = await db.collection('users').where({ bijingBound: true,
      ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(limit + 1).get();
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid users response');
    const candidates = response.data.slice(0, limit);
    const items = [];
    const started = Date.now();
    for (const user of candidates) {
      if (items.length && Date.now() - started >= 20000) break;
      items.push(await migrateOne(user, dryRun));
    }
    return { migration: MIGRATION, dryRun, scanned: items.length,
      migrated: items.filter(item => item.status === 'migrated').length,
      wouldMigrate: items.filter(item => item.status === 'would_migrate').length,
      alreadyManaged: items.filter(item => item.status === 'already_managed').length,
      conflicts: items.filter(item => item.status === 'conflict').length,
      hasMore: response.data.length > items.length,
      nextCursor: items.length ? candidates[items.length - 1]._id : cursor, items };
  }

  return { run };
}

module.exports = { createBindingMigration, MIGRATION };
