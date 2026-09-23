const COLLECTION = 'bijing_bindings';
const MAX_AGE_MS = 30000;
const validOpenid = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

async function readProof(reference) {
  try {
    const result = await reference.get();
    if (!result || !has(result, 'data')) throw new Error('Invalid delegation response');
    if (result.data === undefined || result.data === null) return null;
    if (typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid delegation document');
    return result.data;
  } catch (error) {
    if (/DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND|document.*(?:not exist|not found)|文档不存在/i.test(
      `${error.code || error.errCode || ''} ${error.message || error.errMsg || ''}`)) return null;
    throw error;
  }
}

// Called only for getAccess. A raw expectedOpenid or SOURCE never supplies an
// identity. A server-written proof is audience-bound, short-lived and consumed
// transactionally; clients cannot read or write its collection.
async function resolveAccessIdentity(wxContext, event, getDatabase) {
  const sdkOpenid = typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  if (!has(event, 'delegationId')) {
    if (!validOpenid(sdkOpenid)) return null;
    if (has(event, 'expectedOpenid') && event.expectedOpenid !== sdkOpenid) return null;
    return sdkOpenid;
  }

  const { delegationId, expectedOpenid } = event;
  if (typeof delegationId !== 'string' || !/^auth_[a-f0-9]{64}$/.test(delegationId) || !validOpenid(expectedOpenid)) return null;
  // If the platform did preserve an identity, the delegation cannot substitute it.
  const sdkIdentityMissing = wxContext.OPENID === undefined || wxContext.OPENID === null || wxContext.OPENID === '';
  if (!sdkIdentityMissing && (!validOpenid(sdkOpenid) || sdkOpenid !== expectedOpenid)) return null;

  return getDatabase().runTransaction(async transaction => {
    const reference = transaction.collection(COLLECTION).doc(delegationId);
    const proof = await readProof(reference);
    const now = Date.now();
    if (!proof || proof._id !== delegationId || proof.kind !== 'admin-delegation' || proof.audience !== 'adminManager' ||
        proof.openid !== expectedOpenid || !Number.isSafeInteger(proof.createdAt) || proof.createdAt <= 0 ||
        !Number.isSafeInteger(proof.expiresAt) || proof.createdAt > now || proof.expiresAt <= now ||
        proof.expiresAt <= proof.createdAt || proof.expiresAt - proof.createdAt > MAX_AGE_MS) return null;
    await reference.remove();
    return proof.openid;
  });
}

module.exports = { resolveAccessIdentity };
