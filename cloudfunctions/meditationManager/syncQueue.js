const crypto = require('crypto');

const ERRORS = 'bijing_sync_errors';
const normalizeStudentNumber = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const errorId = (studentNumber, date) => `${date}_${crypto.createHash('sha256').update(normalizeStudentNumber(studentNumber)).digest('hex').slice(0, 40)}`;
const accountId = openid => `account_${crypto.createHash('sha256').update(openid).digest('hex')}`;
const fail = (code, message) => Object.assign(new Error(message), { code });
const isBound = row => row && row.bijingBound === true && Boolean(normalizeStudentNumber(row.bijingStudentNumber));
const bindingFields = row => row && [row._openid, row.bijingBound, row.bijingStudentNumber, row.bijingBindingVersion];
const registryFields = row => row && [row.revision, row.active, row.openid, row.userId, row.studentNumber, row.bindingVersion];

// 绑定事务也会更新账号注册表。先读它再查询资料，事务内复核可识别查询期间的首次绑定。
async function readBindingSnapshot({ db, openid, readRows, readDocument }) {
  const id = accountId(openid);
  const account = await readDocument(db, 'bijing_bindings', id);
  const profiles = await readRows(db, 'users', openid);
  return { accountId: id, account, profiles };
}

async function currentBinding({ transaction, snapshot, openid, readDocument }) {
  if (!snapshot) throw fail('STALE_SNAPSHOT', '业务日已切换，重新读取同步绑定');
  const account = await readDocument(transaction, 'bijing_bindings', snapshot.accountId);
  if (JSON.stringify(registryFields(account)) !== JSON.stringify(registryFields(snapshot.account))) {
    throw fail('STALE_SNAPSHOT', '绑定状态已变更，重新读取');
  }
  const profiles = [];
  for (const profile of snapshot.profiles) {
    const current = await readDocument(transaction, 'users', profile._id);
    if (!current || current._openid !== openid ||
        JSON.stringify(bindingFields(current)) !== JSON.stringify(bindingFields(profile))) {
      throw fail('STALE_SNAPSHOT', '绑定状态已变更，重新读取');
    }
    if (isBound(current)) profiles.push(current);
  }
  if (!profiles.length && !(account && account.active)) return null;
  const profile = profiles[0];
  const number = normalizeStudentNumber(profile && profile.bijingStudentNumber);
  if (profiles.length !== 1 || !/^[A-Z0-9_-]{1,64}$/.test(number) ||
      account && (!account.active || account.openid !== openid || account.userId !== profile._id ||
        account.studentNumber !== number || (account.bindingVersion || '') !== (profile.bijingBindingVersion || ''))) {
    throw fail('BIJING_SYNC_BINDING_CONFLICT', '必经绑定资料不一致，请重新绑定后重试；记录变更尚未提交');
  }
  return profile;
}

// 与 bijingSync.getDayRecords 使用相同的稳定顺序、身份去重、日期归属及数值规则。
function dayDuration(records, date, getRecordBusinessDate) {
  const identities = new Set();
  let duration = 0;
  for (const record of [...records].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const keys = [record.localId, record.idempotencyKey].filter(Boolean);
    const duplicate = keys.some(key => identities.has(key));
    keys.forEach(key => identities.add(key));
    if (duplicate || getRecordBusinessDate(record) !== date) continue;
    if (typeof record.duration === 'number' && Number.isFinite(record.duration)) duration += record.duration;
  }
  return Math.round(duration);
}

// 待办与记录、统计共同提交。微信退出或保存回包丢失不会丢失历史日修复意图。
async function queueChangedDate({ transaction, snapshot, openid, recordDate, today, records,
  getRecordBusinessDate, readDocument, timestamp }) {
  if (!recordDate || recordDate >= today) return false;
  const profile = await currentBinding({ transaction, snapshot, openid, readDocument });
  if (!profile) return false;
  const studentNumber = normalizeStudentNumber(profile.bijingStudentNumber);
  const id = errorId(studentNumber, recordDate);
  const previous = await readDocument(transaction, ERRORS, id);
  let sameOwner = true;
  let previousBindingFailure;
  if (previous && (previous.userId !== profile._id || previous.openid !== openid)) {
    const priorUser = typeof previous.userId === 'string' && previous.userId
      ? await readDocument(transaction, 'users', previous.userId) : null;
    // 解绑保留旧错误。只有原资料已不再占用该学号时，新绑定才能接管同一学号/日期的待办。
    if (priorUser && isBound(priorUser) && normalizeStudentNumber(priorUser.bijingStudentNumber) === studentNumber) {
      throw fail('BIJING_SYNC_BINDING_CONFLICT', '必经同步待办归属冲突，请联系管理员核对；记录变更尚未提交');
    }
    sameOwner = false;
    previousBindingFailure = Object.fromEntries(['userId', 'openid', 'bindingStudentNumber', 'queueVersion',
      'reason', 'error', 'expectedDurationMinutes', 'actualDurationMinutes', 'exists', 'retryCount', 'createdAt', 'updatedAt']
      .filter(key => previous[key] !== undefined).map(key => [key, previous[key]]));
  }
  if (previous && normalizeStudentNumber(previous.studentNumber) !== studentNumber) {
    throw fail('BIJING_SYNC_BINDING_CONFLICT', '必经同步待办学号异常，请联系管理员核对；记录变更尚未提交');
  }
  const ownedPrevious = sameOwner ? previous : null;
  const { _id, ...prior } = ownedPrevious || {};
  await transaction.collection(ERRORS).doc(id).set({ data: {
    ...prior, studentNumber, recordDate, userId: profile._id, openid,
    bindingStudentNumber: profile.bijingStudentNumber, nickname: profile.nickName || '',
    expectedDurationMinutes: dayDuration(records, recordDate, getRecordBusinessDate),
    // This is an owned record mutation, including deleting the last record.
    zeroEligible: true,
    actualDurationMinutes: ownedPrevious && ownedPrevious.actualDurationMinutes !== undefined ? ownedPrevious.actualDurationMinutes : null,
    exists: ownedPrevious && ownedPrevious.exists !== undefined ? ownedPrevious.exists : null,
    reason: ownedPrevious && ownedPrevious.reason || 'sync_pending',
    error: ownedPrevious && ownedPrevious.error || '记录变更待同步必经',
    retryCount: ownedPrevious && ownedPrevious.retryCount || 0,
    createdAt: ownedPrevious && ownedPrevious.createdAt || timestamp, updatedAt: timestamp,
    queueVersion: crypto.randomBytes(16).toString('hex'),
    ...(previousBindingFailure ? { previousBindingFailure } : {})
  } });
  return true;
}

module.exports = { errorId, readBindingSnapshot, queueChangedDate };
