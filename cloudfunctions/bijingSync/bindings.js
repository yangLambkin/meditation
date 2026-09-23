const crypto = require('crypto');

const COLLECTION = 'bijing_bindings';
const normalizeStudentNumber = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const bindingId = (kind, value) => `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;
const failure = (code, error) => Object.assign(new Error(error), { code });
const revision = row => row && Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
const isBound = row => row && row.bijingBound === true && normalizeStudentNumber(row.bijingStudentNumber);
const canonicalProfile = rows => rows.find(isBound) || [...rows].sort((a, b) => a._id.localeCompare(b._id))[0];
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function readDocument(db, collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get();
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid binding response');
    if (result.data !== null && result.data !== undefined && (typeof result.data !== 'object' || Array.isArray(result.data))) {
      throw new Error('Invalid binding document');
    }
    return result.data || null;
  } catch (error) {
    // Missing collections, permission failures and network failures must fail closed.
    if (['DATABASE_DOCUMENT_NOT_EXIST', 'DOCUMENT_NOT_FOUND'].includes(error.errCode || error.code)) return null;
    throw error;
  }
}

function createBindings({ db, checkStudentExists, now = () => new Date() }) {
  async function queryUsers(filter) {
    const rows = [];
    let cursor = '';
    while (true) {
      const result = await db.collection('users')
        .where({ ...filter, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
        .orderBy('_id', 'asc').limit(100).get();
      if (!result || !Array.isArray(result.data)) throw new Error('Invalid users response');
      rows.push(...result.data);
      if (result.data.length < 100) return rows;
      cursor = result.data[result.data.length - 1]._id;
    }
  }

  async function snapshot(openid, number) {
    const studentId = bindingId('student', number);
    const accountId = bindingId('account', openid);
    // Read revisions before querying: the SDK has no transactional predicate query.
    const student = await readDocument(db, COLLECTION, studentId);
    const account = await readDocument(db, COLLECTION, accountId);
    const own = await queryUsers({ _openid: openid });
    const owners = await queryUsers({ bijingBound: true,
      bijingStudentNumber: db.RegExp({ regexp: `^\\s*${escapeRegex(number)}\\s*$`, options: 'i' }) });
    return { studentId, accountId, student, account, own, owners };
  }

  async function inSnapshot(transaction, state) {
    const student = await readDocument(transaction, COLLECTION, state.studentId);
    const account = await readDocument(transaction, COLLECTION, state.accountId);
    if (revision(student) !== revision(state.student) || revision(account) !== revision(state.account) ||
      Boolean(student) !== Boolean(state.student) || Boolean(account) !== Boolean(state.account)) {
      throw failure('BINDING_RETRY', '绑定状态已改变');
    }
    const rows = new Map();
    for (const row of [...state.own, ...state.owners]) {
      if (rows.has(row._id)) continue;
      const current = await readDocument(transaction, 'users', row._id);
      if (!current || current._openid !== row._openid || current.bijingBound !== row.bijingBound ||
          current.bijingStudentNumber !== row.bijingStudentNumber ||
          current.bijingBindingVersion !== row.bijingBindingVersion) {
        throw failure('BINDING_RETRY', '绑定状态已改变');
      }
      rows.set(row._id, current);
    }
    return { student, account, rows };
  }

  function assertCanBind(openid, number, state) {
    if (state.student && state.student.active && state.student.studentNumber !== number ||
        state.account && state.account.active && state.account.openid !== openid) {
      throw failure('BINDING_CONFLICT', '绑定资料不一致，请联系管理员处理');
    }
    if (state.own.some(row => isBound(row) && normalizeStudentNumber(row.bijingStudentNumber) !== number) ||
        state.account && state.account.active && state.account.studentNumber !== number) {
      throw failure('UNBIND_REQUIRED', '请先解绑当前学号，再绑定新学号');
    }
    if (state.own.filter(isBound).length > 1) throw failure('BINDING_CONFLICT', '当前账号存在重复绑定资料，请先解绑后重试');
    if (state.owners.some(row => row._openid !== openid) || state.owners.length > 1 ||
        state.student && state.student.active && state.student.openid !== openid) {
      throw failure('STUDENT_ALREADY_BOUND', '该学号已绑定其他微信账号，请先在原账号解绑');
    }
    const selected = canonicalProfile(state.own);
    if (state.student && state.student.active && state.student.userId !== (selected && selected._id) ||
        state.account && state.account.active && state.account.userId !== (selected && selected._id)) {
      throw failure('BINDING_CONFLICT', '绑定资料不一致，请联系管理员处理');
    }
  }

  async function retry(operation) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await operation(); } catch (error) {
        if (error.code === 'BINDING_RETRY' && attempt < 3) continue;
        if (['UNBIND_REQUIRED', 'BINDING_CONFLICT', 'STUDENT_ALREADY_BOUND', 'BINDING_STALE'].includes(error.code)) {
          return { success: false, code: error.code, error: error.message };
        }
        return { success: false, code: 'BINDING_UNAVAILABLE', error: '绑定状态暂时不可用，请稍后重试' };
      }
    }
  }

  async function bind(openid, studentNumber) {
    if (typeof openid !== 'string' || !openid.trim()) return { success: false, error: '用户未登录' };
    if (typeof studentNumber === 'string') studentNumber = studentNumber.trim();
    if (!studentNumber) return { success: false, error: '学号不能为空' };
    if (typeof studentNumber !== 'string' || !/^BJ/.test(studentNumber)) return { success: false, error: '学号必须以大写 BJ 开头' };
    const number = normalizeStudentNumber(studentNumber);
    let userData;
    return retry(async () => {
      const state = await snapshot(openid, number);
      assertCanBind(openid, number, state);
      if (!userData) {
        try {
          const response = await checkStudentExists(studentNumber);
          if (!response || response.success !== true) return { success: false, error: '学号不存在或校验失败' };
          userData = response.data || {};
        } catch (error) {
          return { success: false, error: error.response && error.response.status === 404 ? '学号不存在' : '校验学号失败，请稍后重试' };
        }
      }
      const token = crypto.randomBytes(16).toString('hex');
      const timestamp = now();
      return db.runTransaction(async transaction => {
        const current = await inSnapshot(transaction, state);
        const own = state.own.map(row => current.rows.get(row._id));
        const owners = state.owners.map(row => current.rows.get(row._id));
        assertCanBind(openid, number, { ...current, own, owners });
        const existing = canonicalProfile(own);
        const userId = existing ? existing._id : bindingId('user', openid);
        if (!existing && await readDocument(transaction, 'users', userId)) throw failure('BINDING_RETRY', '用户资料已改变');
        const sameBinding = isBound(existing) && normalizeStudentNumber(existing.bijingStudentNumber) === number;
        const bindingVersion = sameBinding && existing.bijingBindingVersion || token;
        if (current.student && current.student.active && current.student.bindingVersion !== bindingVersion ||
            current.account && current.account.active && current.account.bindingVersion !== bindingVersion) {
          throw failure('BINDING_CONFLICT', '绑定资料不一致，请联系管理员处理');
        }
        const nickname = userData.nickname && String(userData.nickname).trim() || null;
        const previousNumber = normalizeStudentNumber(existing && (existing.bijingStudentNumber || existing.bijingLastStudentNumber));
        const update = { bijingStudentNumber: studentNumber, bijingBound: true,
          bijingBoundAt: sameBinding && existing.bijingBoundAt || timestamp,
          bijingBindingVersion: bindingVersion,
          bijingSyncedDates: previousNumber && previousNumber !== number ? {} : existing && existing.bijingSyncedDates || {},
          lastUpdateTime: timestamp,
          ...(nickname ? { nickName: nickname } : {}) };
        if (existing) await transaction.collection('users').doc(userId).update({ data: update });
        else await transaction.collection('users').doc(userId).set({ data: { _openid: openid, ...update,
          nickName: nickname || '静心者', avatarUrl: '/images/avatar.png', createTime: timestamp } });
        const entry = { studentNumber: number, openid, userId, bindingVersion, active: true };
        await transaction.collection(COLLECTION).doc(state.studentId).set({ data: {
          ...entry, kind: 'student', revision: revision(current.student) + 1 } });
        await transaction.collection(COLLECTION).doc(state.accountId).set({ data: {
          ...entry, kind: 'account', revision: revision(current.account) + 1 } });
        return { success: true, data: { studentNumber, nickname, nicknameOverridden: !!nickname, bindingVersion } };
      });
    });
  }

  async function unbind(openid, studentNumber, bindingVersion) {
    if (typeof openid !== 'string' || !openid.trim()) return { success: false, error: '用户未登录' };
    const number = normalizeStudentNumber(studentNumber);
    if (!number) return { success: false, code: 'BINDING_STALE', error: '绑定状态已改变，请刷新后重试' };
    return retry(async () => {
      const state = await snapshot(openid, number);
      const matches = state.own.filter(row => isBound(row) && normalizeStudentNumber(row.bijingStudentNumber) === number);
      const versions = [...new Set(matches.map(row => row.bijingBindingVersion).filter(Boolean))];
      // A legacy duplicate without a token may coexist with the current versioned profile.
      // Require that current version, then clear all of this owner's matching legacy copies.
      if (!matches.length || versions.length > 1 || (versions[0] || undefined) !== bindingVersion) {
        throw failure('BINDING_STALE', '绑定状态已改变，请刷新后重试');
      }
      const timestamp = now();
      const historyId = `history_${crypto.randomBytes(16).toString('hex')}`;
      return db.runTransaction(async transaction => {
        const current = await inSnapshot(transaction, state);
        const profiles = matches.map(row => current.rows.get(row._id));
        for (const profile of profiles) {
          if (!isBound(profile) || normalizeStudentNumber(profile.bijingStudentNumber) !== number ||
              profile.bijingBindingVersion && profile.bijingBindingVersion !== bindingVersion) {
            throw failure('BINDING_STALE', '绑定状态已改变，请刷新后重试');
          }
        }
        for (const registry of [current.student, current.account]) {
          if (registry && registry.active && registry.openid === openid &&
              profiles.some(row => row._id === registry.userId && (row.bijingBindingVersion || '') !== registry.bindingVersion)) {
            throw failure('BINDING_STALE', '绑定状态已改变，请刷新后重试');
          }
        }
        // Archive before clearing the current binding; personal records and old sync history remain.
        await transaction.collection(COLLECTION).doc(historyId).set({ data: {
          kind: 'history', openid, studentNumber: number, unboundAt: timestamp,
          profiles: profiles.map(row => ({ userId: row._id, studentNumber: row.bijingStudentNumber,
            bindingVersion: row.bijingBindingVersion || '', boundAt: row.bijingBoundAt || null,
            syncedDates: row.bijingSyncedDates || {} })) } });
        for (const profile of profiles) {
          await transaction.collection('users').doc(profile._id).update({ data: {
            bijingBound: false, bijingStudentNumber: '', bijingBindingVersion: '',
            bijingBoundAt: null, bijingUnboundAt: timestamp, bijingLastStudentNumber: profile.bijingStudentNumber,
            lastUpdateTime: timestamp } });
        }
        const ownsStudent = current.student && current.student.openid === openid &&
          profiles.some(row => row._id === current.student.userId && (row.bijingBindingVersion || '') === current.student.bindingVersion);
        const ownsAccount = current.account && current.account.openid === openid && current.account.studentNumber === number &&
          profiles.some(row => row._id === current.account.userId && (row.bijingBindingVersion || '') === current.account.bindingVersion);
        // A legacy duplicate may unbind itself but may never delete the other account's reservation.
        for (const [id, prior, owned, kind] of [[state.studentId, current.student, ownsStudent, 'student'],
          [state.accountId, current.account, ownsAccount, 'account']]) {
          const { _id, ...fields } = prior || {};
          await transaction.collection(COLLECTION).doc(id).set({ data: {
            ...(prior ? fields : { kind, studentNumber: number, openid, userId: profiles[0]._id, bindingVersion: '' }),
            active: prior ? owned ? false : prior.active : false,
            revision: revision(prior) + 1 } });
        }
        return { success: true, data: { studentNumber: profiles[0].bijingStudentNumber, bound: false } };
      });
    });
  }

  return { bind, unbind };
}

module.exports = { COLLECTION, normalizeStudentNumber, bindingId, createBindings };
