const crypto = require('crypto');

const COLLECTION = 'wisdom_quotes';
const KNOWN_ERRORS = new Set(['INVALID_ARGUMENT', 'NOT_FOUND', 'CONFLICT', 'DUPLICATE_CONTENT', 'REQUEST_ID_REUSED']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const publicQuote = row => ({ _id: row._id, content: row.content === undefined ? null : row.content });

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function errorText(error) {
  return [error && error.code, error && error.errCode, error && error.message, error && error.errMsg].join(' ');
}

function missingCollection(error) {
  return [error && error.code, error && error.errCode].map(String).includes('-502005') ||
    /DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS|collection\b[^\n]*(?:not exist|not found)|集合[^\n]*不存在/i.test(errorText(error));
}

async function optionalQuote(database, id) {
  try {
    const response = await database.collection(COLLECTION).doc(id).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('Invalid quote response');
    if (response.data === undefined || response.data === null) return null;
    if (typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('Invalid quote document');
    return response.data;
  } catch (error) {
    if (!missingCollection(error) && /DATABASE_DOCUMENT_NOT_EXIST|document\b[^\n]*(?:not exist|not found)|文档不存在/i.test(errorText(error))) return null;
    throw error;
  }
}

function contentValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
    fail('INVALID_ARGUMENT', '金句内容须为 1–500 个字符');
  }
  return value.trim();
}

function mutationArguments(event) {
  // Preserve the exact original value, including legacy empty/NULL content.
  // It is compared inside a document transaction, never used as a query operator.
  const expected = event.expectedContent;
  if (!validId(event.quoteId) || !(expected === null || typeof expected === 'string' && expected.length <= 10000 ||
      typeof expected === 'number' && Number.isFinite(expected) || typeof expected === 'boolean')) {
    fail('INVALID_ARGUMENT', '金句信息无效，请刷新后重试');
  }
  return expected;
}

function requireCurrent(row, expected) {
  if (!row) fail('NOT_FOUND', '金句不存在或已被删除');
  if ((row.content === undefined ? null : row.content) !== expected) {
    fail('CONFLICT', '金句已被其他管理员修改，请刷新后重试');
  }
}

function pagination(event) {
  const keyword = event.keyword === undefined ? '' : event.keyword;
  const limit = event.limit === undefined ? 20 : event.limit;
  if (typeof keyword !== 'string' || keyword.trim().length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    fail('INVALID_ARGUMENT', '搜索关键词不能超过 100 个字符，每页数量须为 1–50');
  }
  let after = '';
  if (event.cursor !== undefined && event.cursor !== '') {
    try {
      if (typeof event.cursor !== 'string' || event.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(event.cursor)) throw new Error('cursor');
      const cursor = JSON.parse(Buffer.from(event.cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== keyword.trim() || !validId(cursor[1])) throw new Error('cursor');
      after = cursor[1];
    } catch (_) {
      fail('INVALID_ARGUMENT', '分页信息无效，请重新搜索');
    }
  }
  return { keyword: keyword.trim(), limit, after };
}

function encodeCursor(keyword, id) {
  if (!validId(id)) throw new Error('Invalid quote pagination');
  return Buffer.from(JSON.stringify([keyword, id])).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createWisdomService({ db, openid }) {
  async function list(event) {
    const { keyword, limit, after } = pagination(event);
    const filter = keyword ? { content: db.RegExp({ regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' }) } : {};
    let response, count;
    try {
      [response, count] = await Promise.all([
        db.collection(COLLECTION).where({ ...filter, ...(after ? { _id: db.command.gt(after) } : {}) })
          .field({ _id: true, content: true }).orderBy('_id', 'asc').limit(limit + 1).get(),
        db.collection(COLLECTION).where(filter).count()
      ]);
    } catch (error) {
      if (missingCollection(error)) return { quotes: [], total: 0, nextCursor: '' };
      throw error;
    }
    if (!response || !Array.isArray(response.data) || !count || !Number.isSafeInteger(count.total) || count.total < 0) {
      throw new Error('Invalid quote list response');
    }
    const rows = response.data.slice(0, limit);
    return { quotes: rows.map(publicQuote), total: count.total,
      nextCursor: response.data.length > limit ? encodeCursor(keyword, rows[rows.length - 1]._id) : '' };
  }

  async function rejectDuplicate(content, ownId) {
    const response = await db.collection(COLLECTION).where({ content }).field({ _id: true }).limit(2).get();
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid duplicate response');
    if (response.data.some(row => row._id !== ownId)) fail('DUPLICATE_CONTENT', '已有相同内容的金句');
  }

  function replay(row, contentHash) {
    if (row.adminCreateContentHash !== contentHash) fail('REQUEST_ID_REUSED', '本次提交标识已使用，请重新新增');
    return { quote: publicQuote(row), created: false };
  }

  async function create(event) {
    const content = contentValue(event.content);
    if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(event.requestId)) {
      fail('INVALID_ARGUMENT', '提交标识无效，请重新新增');
    }
    const id = 'wq_admin_' + hash(JSON.stringify([openid, event.requestId]));
    const contentHash = hash(content);
    const existing = await optionalQuote(db, id);
    if (existing) return replay(existing, contentHash);
    await rejectDuplicate(content);
    return db.runTransaction(async transaction => {
      const concurrent = await optionalQuote(transaction, id);
      if (concurrent) return replay(concurrent, contentHash);
      // A deterministic request ID prevents duplicate inserts after double taps
      // or lost responses. No client-provided weight or metadata is accepted.
      const row = { content, weight: 1, adminCreateContentHash: contentHash };
      await transaction.collection(COLLECTION).doc(id).set({ data: row });
      return { quote: publicQuote({ ...row, _id: id }), created: true };
    });
  }

  async function update(event) {
    const expected = mutationArguments(event);
    const content = contentValue(event.content);
    const before = await optionalQuote(db, event.quoteId);
    requireCurrent(before, expected);
    if (before.content !== content) await rejectDuplicate(content, event.quoteId);
    return db.runTransaction(async transaction => {
      const current = await optionalQuote(transaction, event.quoteId);
      requireCurrent(current, expected);
      if (current.content !== content) await transaction.collection(COLLECTION).doc(event.quoteId).update({ data: { content } });
      return { quote: publicQuote({ ...current, content }) };
    });
  }

  async function remove(event) {
    const expected = mutationArguments(event);
    return db.runTransaction(async transaction => {
      const current = await optionalQuote(transaction, event.quoteId);
      // Retrying a deletion whose successful response was lost is harmless.
      if (current) {
        requireCurrent(current, expected);
        await transaction.collection(COLLECTION).doc(event.quoteId).remove();
      }
      return { quoteId: event.quoteId, deleted: true };
    });
  }
  return { list, create, update, remove };
}

async function handleWisdom(event, dependencies) {
  try {
    const service = createWisdomService(dependencies);
    let data;
    if (event.type === 'adminListWisdom') data = await service.list(event);
    else if (event.type === 'adminCreateWisdom') data = await service.create(event);
    else if (event.type === 'adminUpdateWisdom') data = await service.update(event);
    else if (event.type === 'adminDeleteWisdom') data = await service.remove(event);
    else fail('INVALID_ARGUMENT', '未知的金句操作');
    return { success: true, data };
  } catch (error) {
    if (KNOWN_ERRORS.has(error && error.code)) return { success: false, code: error.code, error: error.message };
    return { success: false, code: 'WISDOM_UNAVAILABLE', error: '金句服务暂时不可用，请稍后重试' };
  }
}

module.exports = { handleWisdom };
