const crypto = require('crypto');

const BINDINGS = 'bijing_bindings';
const normalize = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const bindingId = (kind, value) => `${kind}_${crypto.createHash('sha256').update(value).digest('hex')}`;
const validRevision = lock => lock && Number.isSafeInteger(lock.revision) && lock.revision > 0;

function adminStudentNumbers(environment = {}) {
  const value = environment.ADMIN_STUDENT_NUMBERS;
  if (typeof value !== 'string') return [];
  const numbers = value.split(',').map(normalize);
  return numbers.every(number => /^BJ[A-Z0-9_-]{1,62}$/.test(number)) ? [...new Set(numbers)] : [];
}

async function optional(database, collection, id) {
  try {
    const result = await database.collection(collection).doc(id).get();
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid binding response');
    if (result.data === null || result.data === undefined) return null;
    if (typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid binding document');
    return result.data;
  } catch (error) {
    if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
    throw error;
  }
}

function ownsBinding(lock, kind, user, studentNumber) {
  return validRevision(lock) && lock.kind === kind && lock.active === true && lock.openid === user._openid &&
    lock.userId === user._id && lock.studentNumber === studentNumber &&
    typeof lock.bindingVersion === 'string' && Boolean(lock.bindingVersion) &&
    lock.bindingVersion === user.bijingBindingVersion;
}

function otherLegacyTombstone(lock, openid, studentNumber) {
  return validRevision(lock) && lock.kind === 'student' && lock.active === false &&
    lock.studentNumber === studentNumber && typeof lock.openid === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(lock.openid) && lock.openid !== openid &&
    typeof lock.userId === 'string' && Boolean(lock.userId) && typeof lock.bindingVersion === 'string';
}

// Authorize only the currently bound account. Request/profile parameters never
// supply identity. The two registry revisions coordinate with binding.js writes.
async function canManageControlPanel(wxContext, environment, getDatabase) {
  const openid = wxContext && typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  const admins = adminStudentNumbers(environment);
  if (!/^[A-Za-z0-9_-]+$/.test(openid) || !admins.length) return false;
  const db = getDatabase();
  const own = await db.collection('users').where({ _openid: openid, bijingBound: true }).limit(2).get();
  if (!own || !Array.isArray(own.data)) throw new Error('Invalid profile response');
  if (own.data.length !== 1) return false;
  const candidate = own.data[0];
  const number = normalize(candidate.bijingStudentNumber);
  if (typeof candidate._id !== 'string' || !candidate._id || !admins.includes(number)) return false;

  const studentId = bindingId('student', number);
  const accountId = bindingId('account', openid);
  const before = await optional(db, BINDINGS, studentId);
  if (before && !validRevision(before)) return false;
  // Lock revision is read BEFORE searching legacy users. Transactions cannot
  // query collections; the revision catches inserts/removals after this query.
  const matches = await db.collection('users').where({ bijingBound: true,
    bijingStudentNumber: db.RegExp({ regexp: `^\\s*${number}\\s*$`, options: 'i' }) }).limit(2).get();
  if (!matches || !Array.isArray(matches.data)) throw new Error('Invalid binding response');
  if (matches.data.length !== 1 || matches.data[0]._id !== candidate._id || matches.data[0]._openid !== openid) return false;

  return db.runTransaction(async transaction => {
    const student = await optional(transaction, BINDINGS, studentId);
    if (Boolean(before) !== Boolean(student) || student && !validRevision(student) ||
        (before && before.revision) !== (student && student.revision)) return false;
    const user = await optional(transaction, 'users', candidate._id);
    if (!user || user._id !== candidate._id || user._openid !== openid || user.bijingBound !== true ||
        normalize(user.bijingStudentNumber) !== number) return false;
    const account = await optional(transaction, BINDINGS, accountId);
    // Existing unique bindings keep working without a forced migration. Once
    // managed by the new writer, both active ownership records must agree.
    // Removing one legacy duplicate leaves a revision tombstone for that other
    // account. The remaining unique legacy account may still authorize.
    const legacyVersion = user.bijingBindingVersion === undefined || user.bijingBindingVersion === '';
    if (!account && legacyVersion && (!student || otherLegacyTombstone(student, openid, number))) return true;
    return Boolean(ownsBinding(student, 'student', user, number) && ownsBinding(account, 'account', user, number));
  });
}

module.exports = { canManageControlPanel, adminStudentNumbers };
