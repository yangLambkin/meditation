const crypto = require('crypto');

const COLLECTION = 'bijing_sync_errors';
const normalize = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const errorId = (studentNumber, date) => `${date}_${crypto.createHash('sha256').update(normalize(studentNumber)).digest('hex').slice(0, 40)}`;

async function optional(database, collection, id) {
  try { return (await database.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|文档不存在/i.test(`${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
    throw error;
  }
}

// Individual requests share the durable repair table with scheduled batches.
// A new record mutation replaces queueVersion in the recording transaction;
// late acknowledgements must never remove that newer work.
function createSyncFailures({ db, now = Date.now }) {
  async function begin(user, recordDate, duration, reason = 'sync_pending') {
    const id = errorId(user.bijingStudentNumber, recordDate);
    return db.runTransaction(async tx => {
      const currentUser = await optional(tx, 'users', user._id);
      if (!currentUser || !currentUser.bijingBound || currentUser._openid !== user._openid ||
          currentUser.bijingStudentNumber !== user.bijingStudentNumber) {
        throw new Error('学号绑定已变化，请重新同步');
      }
      const previous = await optional(tx, COLLECTION, id);
      const changedOwner = previous && (previous.userId !== user._id || previous.openid !== user._openid);
      if (changedOwner && previous.userId) {
        const former = await optional(tx, 'users', previous.userId);
        if (former && former.bijingBound && normalize(former.bijingStudentNumber) === normalize(user.bijingStudentNumber)) {
          throw new Error('该学号仍有其他账号绑定，请管理员核查');
        }
      }
      const timestamp = now();
      const queueVersion = !changedOwner && previous && previous.queueVersion || crypto.randomBytes(16).toString('hex');
      const ownedPrevious = changedOwner ? null : previous;
      const { _id, ...stored } = ownedPrevious || {};
      await tx.collection(COLLECTION).doc(id).set({ data: {
        ...stored, studentNumber: normalize(user.bijingStudentNumber), bindingStudentNumber: user.bijingStudentNumber,
        recordDate, userId: user._id, openid: user._openid, nickname: user.nickName || '',
        expectedDurationMinutes: duration, actualDurationMinutes: ownedPrevious && ownedPrevious.actualDurationMinutes !== undefined ? ownedPrevious.actualDurationMinutes : null,
        zeroEligible: reason !== 'source_read_failed' || !!(ownedPrevious && ownedPrevious.zeroEligible),
        exists: ownedPrevious && ownedPrevious.exists !== undefined ? ownedPrevious.exists : null, reason: ownedPrevious && ownedPrevious.reason || reason,
        error: ownedPrevious && ownedPrevious.error || '等待核对必经同步结果', queueVersion,
        ...(changedOwner ? { previousBindingFailure: {
          userId: previous.userId || '', openid: previous.openid || '',
          reason: previous.reason || '', error: previous.error || '', updatedAt: previous.updatedAt || 0,
        } } : {}),
        retryCount: ownedPrevious && ownedPrevious.retryCount || 0,
        createdAt: ownedPrevious && ownedPrevious.createdAt || timestamp, updatedAt: timestamp,
      } });
      return { id, queueVersion, userId: user._id, openid: user._openid,
        studentNumber: normalize(user.bijingStudentNumber), bindingStudentNumber: user.bijingStudentNumber,
        recordDate, duration, zeroEligible: reason !== 'source_read_failed' || !!(ownedPrevious && ownedPrevious.zeroEligible) };
    });
  }

  async function restoreMissing(tx, attempt, error) {
    const owner = await optional(tx, 'users', attempt.userId);
    if (!owner || !owner.bijingBound || owner._openid !== attempt.openid ||
        owner.bijingStudentNumber !== attempt.bindingStudentNumber) return false;
    const timestamp = now();
    await tx.collection(COLLECTION).doc(attempt.id).set({ data: {
      studentNumber: attempt.studentNumber, bindingStudentNumber: attempt.bindingStudentNumber,
      recordDate: attempt.recordDate, userId: attempt.userId, openid: attempt.openid, nickname: owner.nickName || '',
      expectedDurationMinutes: attempt.duration, zeroEligible: attempt.zeroEligible,
      actualDurationMinutes: null, exists: null,
      reason: error ? attempt.zeroEligible ? 'sync_failed' : 'source_read_failed' : 'sync_pending',
      error: error ? typeof error === 'string' ? error : error.message || '必经同步未完成，等待定时修复' : '等待核对必经同步结果',
      queueVersion: crypto.randomBytes(16).toString('hex'), retryCount: error ? 1 : 0, createdAt: timestamp, updatedAt: timestamp,
    } });
    return true;
  }

  async function retain(attempt) {
    if (!attempt) return false;
    return db.runTransaction(async tx => {
      // A late unverified upload may overwrite the remote value after a newer
      // worker cleared the row. Preserve every existing intent; only restore
      // absent work so the next worker re-reads the source and remote values.
      if (await optional(tx, COLLECTION, attempt.id)) return false;
      return restoreMissing(tx, attempt);
    });
  }

  async function finish(attempt, error) {
    if (!attempt) return false;
    return db.runTransaction(async tx => {
      const current = await optional(tx, COLLECTION, attempt.id);
      if (!current) {
        if (!error) return false;
        // Another worker may have verified and removed this row while our HTTP
        // request was in flight. Its subsequent failure is still uncertain work.
        return restoreMissing(tx, attempt, error);
      }
      if (current.queueVersion !== attempt.queueVersion ||
          current.userId !== attempt.userId || current.openid !== attempt.openid) return false;
      if (!error) {
        await tx.collection(COLLECTION).doc(attempt.id).remove();
      } else {
        await tx.collection(COLLECTION).doc(attempt.id).update({ data: {
          error: typeof error === 'string' ? error : error.message || '必经同步未完成，等待定时修复',
          reason: current.reason === 'source_read_failed' ? current.reason : 'sync_failed',
          retryCount: (current.retryCount || 0) + 1, updatedAt: now(),
        } });
      }
      return true;
    });
  }
  return { begin, retain, fail: (attempt, error) => finish(attempt, error || '必经同步未完成'), confirm: attempt => finish(attempt) };
}

module.exports = { createSyncFailures, errorId };
