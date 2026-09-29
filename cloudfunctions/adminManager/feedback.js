// Keep this module identical in meditationManager and adminManager: cloud functions
// are deployed separately and cannot require files from a sibling deployment.
const crypto = require('crypto');
const COLLECTION = 'feedback';
const STATUSES = ['pending', 'processing', 'resolved'];
const KNOWN_ERRORS = new Set(['AUTH_REQUIRED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'CONFLICT',
  'REQUEST_ID_REUSED', 'CONTENT_REJECTED', 'CONTENT_CHECK_FAILED']);

function feedbackError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorText(error) {
  return typeof error === 'string' ? error : [error && error.code, error && error.errCode,
    error && error.message, error && error.errMsg].filter(value => value !== undefined).join(' ');
}

function isMissingCollection(error) {
  return [error && error.code, error && error.errCode].map(String).includes('-502005') ||
    /\b(?:DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)\b/i.test(errorText(error)) ||
    /\bcollection\b(?:\s+["'`]?[\w.-]+["'`]?)?\s+(?:(?:does|is)\s+)?(?:not exists?|not found)\b|集合\s*(?:["'`]?[\w.-]+["'`]?)?\s*不存在/i.test(errorText(error));
}

function isExistingCollection(error) {
  return /\b(?:DATABASE_COLLECTION_(?:ALREADY_)?EXISTS?|COLLECTION_ALREADY_EXISTS?|TCB_DB_COLLECTION_EXISTS)\b/i.test(errorText(error)) ||
    /\bcollection\b[^\n]*\balready exists?\b|集合[^\n]*已存在/i.test(errorText(error));
}

async function optionalFeedback(database, id) {
  try {
    const result = await database.collection(COLLECTION).doc(id).get();
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid feedback response');
    if (result.data === null || result.data === undefined) return null;
    if (typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid feedback document');
    return result.data;
  } catch (error) {
    if (!isMissingCollection(error) && /\bDATABASE_DOCUMENT_NOT_EXIST\b|\bdocument\b(?!\.)[^\n]*(?:not exist|not found)|文档不存在/i.test(errorText(error))) return null;
    throw error;
  }
}

function requireIdentity(openid) {
  if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)) {
    throw feedbackError('AUTH_REQUIRED', '请先登录后再使用反馈');
  }
}

function textValue(value, maximum, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > maximum || (!optional && !value.trim())) {
    throw feedbackError('INVALID_ARGUMENT', `${label}${optional ? '不能超过' : '须为 1–'}${maximum} 个字符`);
  }
  return value.trim();
}

function isTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFeedbackId(value) {
  return typeof value === 'string' && /^fb_[a-f0-9]{64}$/.test(value);
}

function pagination(event) {
  const limit = event.limit === undefined ? 20 : event.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw feedbackError('INVALID_ARGUMENT', '每页数量须为 1–50');
  if (event.cursor === undefined || event.cursor === '') return { limit, cursor: null };
  try {
    if (typeof event.cursor !== 'string' || event.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(event.cursor)) throw new Error('cursor');
    const decoded = Buffer.from(event.cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const cursor = JSON.parse(decoded);
    if (!Array.isArray(cursor) || cursor.length !== 2 || !isTimestamp(cursor[0]) || !isFeedbackId(cursor[1])) throw new Error('cursor');
    return { limit, cursor };
  } catch (_) {
    throw feedbackError('INVALID_ARGUMENT', '分页信息无效，请刷新后重试');
  }
}

function encodeCursor(row) {
  if (!isTimestamp(row.createdAt) || !isFeedbackId(row._id)) throw new Error('Invalid feedback pagination');
  return Buffer.from(JSON.stringify([row.createdAt, row._id])).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function publicFeedback(row, admin) {
  const result = {
    _id: row._id, content: row.content, contact: row.contact || '', status: row.status,
    reply: row.reply || '', unreadForUser: row.unreadForUser === true,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    handledAt: row.handledAt || null, nickname: row.nickname || '匿名用户', studentNumber: row.studentNumber || ''
  };
  if (admin) {
    result.ownerOpenid = row.ownerOpenid;
    result.handledBy = row.handledBy || '';
  }
  return result;
}

async function moderate(cloud, openid, content) {
  if (!content) return;
  try {
    const response = await cloud.openapi.security.msgSecCheck({ content, version: 2, scene: 2, openid });
    const code = response && (response.errCode !== undefined ? response.errCode : response.errcode);
    if (code !== undefined && code !== null && Number(code) !== 0) throw response;
    const suggestion = response && response.result && response.result.suggest;
    if (suggestion === 'pass') return;
    if (suggestion === 'risky' || suggestion === 'review') throw feedbackError('CONTENT_REJECTED', '内容未通过安全检测，请修改后重试');
    throw feedbackError('CONTENT_CHECK_FAILED', '内容安全检测暂不可用，请稍后重试');
  } catch (error) {
    if (error && ['CONTENT_REJECTED', 'CONTENT_CHECK_FAILED'].includes(error.code)) throw error;
    const code = error && (error.errCode !== undefined ? error.errCode : error.errcode);
    if (Number(code) === 87014) throw feedbackError('CONTENT_REJECTED', '内容未通过安全检测，请修改后重试');
    // Never publish on missing permissions, network failures or unknown results.
    throw feedbackError('CONTENT_CHECK_FAILED', '内容安全检测暂不可用，请稍后重试');
  }
}

async function profileSnapshot(db, openid) {
  let cursor = '', first = null, bound = null, versioned = null;
  for (;;) {
    const response = await db.collection('users').where({ _openid: openid,
      ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
      .field({ _id: true, nickName: true, bijingBound: true, bijingStudentNumber: true, bijingBindingVersion: true })
      .orderBy('_id', 'asc').limit(100).get();
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid profile response');
    const rows = response.data;
    if (!first && rows.length) first = rows[0];
    const candidates = rows.filter(row => row.bijingBound === true && typeof row.bijingStudentNumber === 'string' && row.bijingStudentNumber.trim());
    if (!bound && candidates.length) bound = candidates[0];
    versioned = candidates.find(row => typeof row.bijingBindingVersion === 'string' && row.bijingBindingVersion.trim());
    if (versioned || rows.length < 100) break;
    const next = rows[rows.length - 1]._id;
    if (typeof next !== 'string' || next <= cursor) throw new Error('Invalid profile pagination');
    cursor = next;
  }
  const user = versioned || bound || first || {};
  return {
    nickname: typeof user.nickName === 'string' && user.nickName.trim() ? user.nickName.trim() : '匿名用户',
    studentNumber: user.bijingBound === true && typeof user.bijingStudentNumber === 'string' ? user.bijingStudentNumber.trim() : ''
  };
}

function createFeedbackService({ db, cloud }) {
  async function readForSubmit(id) {
    try { return await optionalFeedback(db, id); }
    catch (error) {
      if (!isMissingCollection(error)) throw error;
      try {
        // Empty server-side initialization only. Do not add _openid or relax
        // client rules: feedback is accessed exclusively through these functions.
        await db.createCollection(COLLECTION);
      } catch (creationError) {
        if (!isExistingCollection(creationError)) throw creationError;
      }
      return optionalFeedback(db, id);
    }
  }

  function duplicate(row, openid, content, contact) {
    if (row.ownerOpenid !== openid) throw feedbackError('NOT_FOUND', '反馈不存在');
    if (row.content !== content || (row.contact || '') !== contact) {
      throw feedbackError('REQUEST_ID_REUSED', '本次反馈标识已使用，请刷新后重新提交');
    }
    return { feedback: publicFeedback(row, false) };
  }

  async function submit(openid, event) {
    requireIdentity(openid);
    const content = textValue(event.content, 1000, '反馈内容');
    const contact = textValue(event.contact, 100, '联系方式', true);
    if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(event.requestId)) {
      throw feedbackError('INVALID_ARGUMENT', '反馈提交标识无效，请刷新后重试');
    }
    const id = 'fb_' + crypto.createHash('sha256').update(JSON.stringify([openid, event.requestId])).digest('hex');
    const existing = await readForSubmit(id);
    // Retrying an already committed request also works during moderation outages.
    if (existing) return duplicate(existing, openid, content, contact);
    await moderate(cloud, openid, [content, contact].filter(Boolean).join('\n'));
    const snapshot = await profileSnapshot(db, openid);
    return db.runTransaction(async transaction => {
      const concurrent = await optionalFeedback(transaction, id);
      if (concurrent) return duplicate(concurrent, openid, content, contact);
      const now = new Date().toISOString();
      const row = { ownerOpenid: openid, ...snapshot, content, contact, status: 'pending', reply: '',
        createdAt: now, updatedAt: now, handledAt: null, handledBy: '', unreadForUser: false };
      await transaction.collection(COLLECTION).doc(id).set({ data: row });
      return { feedback: publicFeedback({ ...row, _id: id }, false) };
    });
  }

  async function list(openid, event, admin = false) {
    requireIdentity(openid);
    const { limit, cursor } = pagination(event);
    const status = event.status === undefined ? 'all' : event.status;
    if (admin && !['all', ...STATUSES].includes(status)) throw feedbackError('INVALID_ARGUMENT', '反馈状态无效');
    let filter = admin ? (status === 'all' ? {} : { status }) : { ownerOpenid: openid };
    if (cursor) filter = db.command.and([filter, db.command.or([
      { createdAt: db.command.lt(cursor[0]) },
      { createdAt: cursor[0], _id: db.command.lt(cursor[1]) }
    ])]);
    let response;
    try {
      response = await db.collection(COLLECTION).where(filter).orderBy('createdAt', 'desc')
        .orderBy('_id', 'desc').limit(limit + 1).get();
    } catch (error) {
      // First-use lists are empty; read requests never create a collection.
      if (isMissingCollection(error)) return { feedbacks: [], nextCursor: '' };
      throw error;
    }
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid feedback response');
    const page = response.data.slice(0, limit);
    return { feedbacks: page.map(row => publicFeedback(row, admin)),
      nextCursor: response.data.length > limit ? encodeCursor(page[page.length - 1]) : '' };
  }

  async function alert(openid) {
    requireIdentity(openid);
    let response;
    try {
      response = await db.collection(COLLECTION).where({ ownerOpenid: openid, status: 'resolved', unreadForUser: true })
        .field({ _id: true }).limit(1).get();
    } catch (error) {
      if (isMissingCollection(error)) return { hasUnreadFeedback: false };
      throw error;
    }
    if (!response || !Array.isArray(response.data)) throw new Error('Invalid feedback response');
    return { hasUnreadFeedback: response.data.length > 0 };
  }

  async function markRead(openid, event) {
    requireIdentity(openid);
    if (!Array.isArray(event.feedbacks) || event.feedbacks.length > 50 || event.feedbacks.some(row =>
      !row || !isFeedbackId(row.feedbackId) || !isTimestamp(row.expectedUpdatedAt)) ||
      new Set(event.feedbacks.map(row => row.feedbackId)).size !== event.feedbacks.length) {
      throw feedbackError('INVALID_ARGUMENT', '反馈已读参数无效，请刷新后重试');
    }
    if (!event.feedbacks.length) return { markedCount: 0 };
    try {
      return await db.runTransaction(async transaction => {
        const seen = [];
        for (const item of event.feedbacks) {
          const row = await optionalFeedback(transaction, item.feedbackId);
          if (row && row.ownerOpenid === openid && row.status === 'resolved' && row.unreadForUser === true &&
            row.updatedAt === item.expectedUpdatedAt) seen.push(item.feedbackId);
        }
        // Acknowledgement does not change the content revision. Transactions protect
        // replies committed while this user is reading from being marked as seen.
        for (const id of seen) await transaction.collection(COLLECTION).doc(id).update({ data: { unreadForUser: false } });
        return { markedCount: seen.length };
      });
    } catch (error) {
      if (isMissingCollection(error)) return { markedCount: 0 };
      throw error;
    }
  }

  async function update(openid, event) {
    requireIdentity(openid);
    if (!isFeedbackId(event.feedbackId) || !STATUSES.includes(event.status) || !isTimestamp(event.expectedUpdatedAt)) {
      throw feedbackError('INVALID_ARGUMENT', '反馈处理参数无效，请刷新后重试');
    }
    // An explicit string is required, including an empty string to clear a reply.
    if (typeof event.reply !== 'string') throw feedbackError('INVALID_ARGUMENT', '请填写有效的回复');
    const reply = textValue(event.reply, 1000, '回复', true);
    let before;
    try { before = await optionalFeedback(db, event.feedbackId); }
    catch (error) {
      if (!isMissingCollection(error)) throw error;
    }
    if (!before) throw feedbackError('NOT_FOUND', '反馈不存在或已被移除');
    if (before.updatedAt !== event.expectedUpdatedAt) throw feedbackError('CONFLICT', '反馈已被其他管理员更新，请刷新后重试');
    if (reply !== (before.reply || '')) await moderate(cloud, openid, reply);
    return db.runTransaction(async transaction => {
      const current = await optionalFeedback(transaction, event.feedbackId);
      if (!current) throw feedbackError('NOT_FOUND', '反馈不存在或已被移除');
      if (current.updatedAt !== event.expectedUpdatedAt) throw feedbackError('CONFLICT', '反馈已被其他管理员更新，请刷新后重试');
      if (current.status === event.status && (current.reply || '') === reply) {
        return { feedback: publicFeedback(current, true) };
      }
      // Millisecond-monotonic revisions detect edits even within the same clock tick.
      const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
      const changes = { status: event.status, reply, updatedAt: now,
        handledAt: event.status === 'resolved' ? now : null, handledBy: openid,
        unreadForUser: event.status === 'resolved' };
      await transaction.collection(COLLECTION).doc(event.feedbackId).update({ data: changes });
      return { feedback: publicFeedback({ ...current, ...changes }, true) };
    });
  }
  async function remove(openid, event) {
    requireIdentity(openid);
    if (!isFeedbackId(event.feedbackId) || !isTimestamp(event.expectedUpdatedAt)) {
      throw feedbackError('INVALID_ARGUMENT', '反馈删除参数无效，请刷新后重试');
    }
    return db.runTransaction(async transaction => {
      let current;
      try { current = await optionalFeedback(transaction, event.feedbackId); }
      catch (error) {
        // Only a missing read is idempotent. Write/commit failures must still
        // surface so the administrator can safely retry a lost response.
        if (!isMissingCollection(error)) throw error;
      }
      if (current) {
        if (current.updatedAt !== event.expectedUpdatedAt) {
          throw feedbackError('CONFLICT', '反馈已被其他管理员更新，请刷新后重试');
        }
        await transaction.collection(COLLECTION).doc(event.feedbackId).remove();
      }
      return { feedbackId: event.feedbackId, deleted: true };
    });
  }
  return { submit, list, alert, markRead, update, remove };
}

async function handleFeedback(event, dependencies, admin = false) {
  try {
    const service = createFeedbackService(dependencies);
    const openid = dependencies.openid;
    let data;
    if (!admin && event.type === 'submitFeedback') data = await service.submit(openid, event);
    else if (!admin && event.type === 'getMyFeedback') data = await service.list(openid, event);
    else if (!admin && event.type === 'getFeedbackAlert') data = await service.alert(openid);
    else if (!admin && event.type === 'markFeedbackRead') data = await service.markRead(openid, event);
    else if (admin && event.type === 'adminListFeedback') data = await service.list(openid, event, true);
    else if (admin && event.type === 'adminUpdateFeedback') data = await service.update(openid, event);
    else if (admin && event.type === 'adminDeleteFeedback') data = await service.remove(openid, event);
    else throw feedbackError('INVALID_ARGUMENT', '未知的反馈操作');
    return { success: true, data };
  } catch (error) {
    if (KNOWN_ERRORS.has(error && error.code)) return { success: false, code: error.code, error: error.message };
    return { success: false, code: 'FEEDBACK_UNAVAILABLE', error: '反馈服务暂时不可用，请稍后重试' };
  }
}

module.exports = { handleFeedback };
