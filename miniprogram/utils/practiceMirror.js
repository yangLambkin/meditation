// 独立观察原静坐操作。仅云端完整快照/删除回执能确认来源，不改变原请求结果。
const config = require('./practiceConfig.js');
const auth = require('./practiceAuth.js');
const queue = require('./practiceQueue.js');
const api = require('./practiceApi.js');
let recovering = null;
let recoveryRequested = false;
let processing = Promise.resolve();

function readSource(read) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('来源读取超时，已保留待核对，请稍后重试'),
      { code: 'SOURCE_READ_TIMEOUT', retryable: true })), 5000);
    Promise.resolve().then(read).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function time(value) {
  if (value && typeof value === 'object') {
    if (typeof value.getTime === 'function') value = value.getTime();
    else if (value.$date !== undefined) value = value.$date;
  }
  const parsed = typeof value === 'number' ? value : /^\d+$/.test(value || '') ? Number(value) : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
}
function sourceVersion(record) {
  // 只用来源保存的变更时间；实际发生时间不能冒充修改版本。
  const value = time(record && (record.updatedAt || record.updated_at || record.createdAt || record.created_at));
  return Number.isFinite(value) ? String(value) : '';
}
function validSnapshot(records, owner) {
  return Array.isArray(records) && records.every(record => record && typeof record._id === 'string' && record._id &&
    (!record._openid || record._openid === owner.openid));
}
function visibleWarning(error) {
  console.warn('原静坐继续保存，功课镜像待核对:', error && error.message);
  if (typeof wx.showToast === 'function') wx.showToast({ title: '静坐继续保存，功课同步待核对', icon: 'none', duration: 3000 });
}
function localData() {
  const userId = wx.getStorageSync('localUserId');
  return wx.getStorageSync(`meditation_checkin_${userId}`) || {};
}
function localSnapshot(identity) {
  const stored = localData(), data = stored.checkinRecords || stored;
  const records = Object.values(data.dailyRecords || {}).flatMap(day => day.records || []);
  return records.find(record => identity.recordId ? record._id === identity.recordId :
    identity.localId ? record.localId === identity.localId : time(record.timestamp) === time(identity.timestamp)) || {};
}
function sameIdentity(task, identity) {
  return identity.recordId ? task.identity.recordId === identity.recordId || task.sourceId === identity.recordId :
    identity.localId ? task.identity.localId === identity.localId : time(task.identity.timestamp) === time(identity.timestamp);
}
function beforeCloudMutation(functionName, event) {
  if (config.sittingMirrorEnabled !== true || functionName !== 'meditationManager' || !event) return null;
  if (!['recordMeditation', 'updateMeditationRecord', 'deleteMeditationRecord', 'deleteExperienceRecord'].includes(event.type)) return null;
  try {
    const owner = auth.getOwner();
    if (!owner) return null;
    if (event.type === 'deleteExperienceRecord') {
      // 独立体验删除不更新静坐 updatedAt；先登记受影响来源，待可靠变更证据核对。
      const stored = localData(), data = stored.checkinRecords || stored;
      const exp = (stored.experienceRecords || {})[event.recordId];
      const reference = exp && exp._id;
      const affected = Object.values(data.dailyRecords || {}).flatMap(day => day.records || []).filter(record =>
        (record.experience || []).some(item => String(item && item._id || item) === String(reference || event.recordId)));
      return affected.map(record => queue.enqueueSourceIntent({ operation: 'update', owner,
        identity: { recordId: record._id, localId: record.localId, timestamp: record.timestamp },
        snapshot: { ...record, deletedExperience: reference || event.recordId, requiresDeletionVersion: true } }));
    }
    const operation = event.type === 'recordMeditation' ? 'create' : event.type === 'deleteMeditationRecord' ? 'delete' : 'update';
    const data = event.data || {};
    const identity = event.type === 'updateMeditationRecord' ? { timestamp: event.recordId } :
      { ...(data.recordId ? { recordId: data.recordId } : {}), ...(data.localId ? { localId: data.localId } : {}), timestamp: data.timestamp };
    const snapshot = event.type === 'recordMeditation' ? data : { ...localSnapshot(identity),
      ...(operation === 'update' ? { expectedExperience: event.experience } : {}) };
    if (!identity.recordId && snapshot._id) identity.recordId = snapshot._id;
    if (!identity.localId && snapshot.localId) identity.localId = snapshot.localId;
    // 云上传重试沿用首次登记意图。真实的新体验更新具有不同的期望内容。
    const existing = queue.getPending().find(task => task.kind === 'mirror' && task.operation === operation &&
      sameIdentity(task, identity) && JSON.stringify(task.snapshot.expectedExperience) === JSON.stringify(snapshot.expectedExperience));
    if (existing) return existing;
    return queue.enqueueSourceIntent({ operation, identity, snapshot, owner });
  } catch (error) { visibleWarning(error); return null; }
}
function isReference(value) {
  return typeof value === 'string' && (/^exp_[a-f0-9]{64}$/.test(value) || /^\d{13}$/.test(value) || /^[a-z0-9_-]{24,64}$/i.test(value));
}
async function reflection(record, owner) {
  const values = Array.isArray(record.experience) ? record.experience : record.experience ? [record.experience] : [];
  const texts = [];
  const stored = localData();
  const local = Object.values(stored.experienceRecords || {});
  for (const item of values) {
    if (item && typeof item === 'object' && typeof item.text === 'string') { texts.push(item.text); continue; }
    if (typeof item !== 'string') throw Object.assign(new Error('静坐体验内容格式无法确认'), { code: 'SOURCE_REFLECTION_UNRESOLVED' });
    const cached = local.find(value => value._id === item || String(value.uniqueId) === item || String(value.timestamp) === item);
    if (!isReference(item) && !cached) { texts.push(item); continue; }
    // 引用必须读取云端正文，不能把引用 ID 或可能过期的缓存当成正文。
    if (!wx.cloud || typeof wx.cloud.database !== 'function') throw Object.assign(new Error('体验正文尚未从云端确认'), { code: 'SOURCE_REFLECTION_UNRESOLVED' });
    const db = wx.cloud.database();
    const response = await readSource(() => cached && cached._id || !/^\d{13}$/.test(item)
      ? db.collection('experience_records').doc(cached && cached._id || item).get()
      : db.collection('experience_records').where({ _openid: owner.openid, timestamp: Number(item) }).get());
    const value = Array.isArray(response.data) ? response.data.length === 1 && response.data[0] : response.data;
    if (!value || value._openid !== owner.openid || typeof value.text !== 'string') throw Object.assign(new Error('体验正文或归属尚未确认'), { code: 'SOURCE_REFLECTION_UNRESOLVED' });
    texts.push(value.text);
  }
  return texts.join('\n\n');
}
function matches(task, record) {
  if (record._openid && record._openid !== task.owner.openid) return false;
  const identity = task.identity;
  if (task.sourceId || identity.recordId) return record._id === (task.sourceId || identity.recordId);
  if (identity.localId) return record.localId === identity.localId || record.idempotencyKey === identity.localId;
  return task.operation === 'update' && time(record.timestamp) === time(identity.timestamp);
}
function verifiesCreate(task, record) {
  return time(record.timestamp) === time(task.snapshot.timestamp) && Number(record.duration) === Number(task.snapshot.duration) &&
    (task.cloudConfirmed && task.sourceId === record._id ||
      record.localId === task.identity.localId || record.idempotencyKey === task.identity.localId);
}
function verifiesUpdate(task, record) {
  const expected = task.snapshot.expectedExperience;
  return !expected || (Array.isArray(record.experience) ? record.experience : [record.experience]).includes(expected);
}
async function recordPayload(record, owner) {
  const version = sourceVersion(record), occurred = time(record.timestamp), duration = Number(record.duration);
  if (!version) throw Object.assign(new Error('原记录缺少可靠更新时间，保留待核对'), { code: 'SOURCE_VERSION_UNAVAILABLE' });
  if (!Number.isFinite(occurred) || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw Object.assign(new Error('原记录时间或时长无法确认'), { code: 'SOURCE_SNAPSHOT_INVALID' });
  const natural = new Date(occurred + 8 * 3600000).toISOString();
  const body = await reflection(record, owner);
  return { sourceVersion: version, recordDate: natural.slice(0, 10),
    occurredAt: natural.slice(0, 19).replace('T', ' '), durationMinutes: duration, reflection: body };
}
async function prepareForSend(task) {
  if (task.operation === 'delete') return null;
  api.assertOwner(task.owner);
  const response = await require('./cloudApi.js').getAllRecords();
  api.assertOwner(task.owner);
  if (!response.success || !validSnapshot(response.data, task.owner)) throw Object.assign(new Error('发送镜像前未能完整核对来源及账号，已保留待办'), { code: 'SOURCE_READ_UNAVAILABLE', retryable: true });
  const candidates = response.data.filter(record => record._id === task.sourceId && (!record._openid || record._openid === task.owner.openid));
  if (candidates.length > 1) throw Object.assign(new Error('来源记录身份不唯一'), { code: 'SOURCE_AMBIGUOUS' });
  const record = candidates[0];
  if (!record) {
    const deletion = queue.enqueueSourceIntent({ operation: 'delete', owner: task.owner,
      identity: { ...task.identity, recordId: task.sourceId }, snapshot: task.snapshot });
    queue.confirmSource(deletion.id, task.sourceId, { sourceVersion: task.payload.sourceVersion });
    return deletion;
  }
  const latest = await recordPayload(record, task.owner);
  api.assertOwner(task.owner);
  if (Number(latest.sourceVersion) < Number(task.payload.sourceVersion)) throw Object.assign(new Error('来源读取版本较旧，等待重新核对'), { code: 'SOURCE_SNAPSHOT_STALE', retryable: true });
  if (latest.sourceVersion === task.payload.sourceVersion) {
    if (Object.keys(latest).some(key => latest[key] !== task.payload[key])) throw Object.assign(new Error('来源同一版本内容不同，保留待核对'), { code: 'SOURCE_VERSION_CONFLICT' });
    return null;
  }
  const replacement = queue.enqueueSourceIntent({ operation: 'update', owner: task.owner,
    identity: { recordId: record._id, localId: record.localId, timestamp: record.timestamp }, snapshot: record });
  queue.confirmSource(replacement.id, record._id, latest);
  return replacement;
}
async function deletionVersion(task) {
  const fromSnapshot = sourceVersion(task.snapshot);
  if (fromSnapshot) return fromSnapshot;
  if (task.deletionId && wx.cloud && typeof wx.cloud.database === 'function') {
    const response = await readSource(() => wx.cloud.database().collection('meditation_locks').doc(task.deletionId).get());
    const receipt = response && response.data;
    const identity = receipt && receipt.requestIdentity;
    const requestMatches = Array.isArray(identity) && (identity[0] === 'recordId' && identity[1] === task.sourceId ||
      identity[0] === 'localId' && identity[1] === task.identity.localId ||
      identity[0] === 'timestamp' && identity[1] === task.snapshot.date && time(identity[2]) === time(task.identity.timestamp));
    if (receipt && receipt.kind === 'deletion_receipt' && receipt.ownerOpenid === task.owner.openid &&
        receipt.recordId === task.sourceId && requestMatches) return sourceVersion(receipt);
  }
  return '';
}
function captureRecoveryBarrier(owner = auth.getOwner()) {
  if (!owner || config.sittingMirrorEnabled !== true) return [];
  return queue.getPending().filter(task => task.kind === 'mirror' && task.status === 'waiting_source' && api.sameOwner(task.owner, owner))
    .map(task => task.id);
}
async function applySnapshot(records, owner, eligibleTaskIds) {
  if (!api.sameOwner(owner, auth.getOwner()) || !validSnapshot(records, owner)) return;
  const tasks = queue.getPending().filter(task => task.kind === 'mirror' && task.status === 'waiting_source' && eligibleTaskIds.includes(task.id));
  for (const task of tasks) {
    if (!api.sameOwner(task.owner, owner)) continue;
    try {
      const candidates = records.filter(record => matches(task, record));
      if (candidates.length > 1) throw Object.assign(new Error('来源记录身份不唯一，等待核对'), { code: 'SOURCE_AMBIGUOUS' });
      const record = candidates[0];
      if (task.operation === 'delete') {
        if (record) { queue.annotateSource(task.id, { snapshot: { ...task.snapshot, ...record } }); continue; }
        const sourceId = task.sourceId || task.identity.recordId;
        const version = await deletionVersion(task);
        if (!sourceId || !version) throw Object.assign(new Error('删除已登记，等待可靠来源 ID 和版本确认'), { code: 'SOURCE_VERSION_UNAVAILABLE' });
        queue.confirmSource(task.id, sourceId, { sourceVersion: version });
        continue;
      }
      if (!record) continue;
      if (task.operation === 'create' && !verifiesCreate(task, record) || task.operation === 'update' && !verifiesUpdate(task, record)) continue;
      if (task.snapshot.requiresDeletionVersion) throw Object.assign(new Error('原独立体验删除未提供静坐变更版本，需核对后同步'), { code: 'SOURCE_VERSION_UNAVAILABLE' });
      const payload = await recordPayload(record, owner);
      if (!api.sameOwner(owner, auth.getOwner())) return;
      queue.confirmSource(task.id, record._id, payload);
    } catch (error) {
      try { queue.markSourceError(task.id, error.code || 'SOURCE_CONFIRMATION_FAILED', error.message || '来源待确认'); }
      catch (storageError) { visibleWarning(storageError); }
    }
  }
  return queue.flush();
}
function acceptCloudSnapshot(records, owner = auth.getOwner(), eligibleTaskIds = captureRecoveryBarrier(owner)) {
  if (config.sittingMirrorEnabled !== true || !owner) return Promise.resolve();
  // 同一来源按确认顺序处理；读取失败/不完整时调用方不能进入此入口。
  processing = processing.catch(() => {}).then(() => applySnapshot(records, owner, eligibleTaskIds));
  return processing;
}
function observeCloudResult(intent, response) {
  if (!intent) return;
  const result = response && response.result;
  if (!result || result.success !== true) return;
  const intents = Array.isArray(intent) ? intent : [intent];
  try {
    intents.forEach(task => queue.annotateSource(task.id, { cloudConfirmed: true,
      ...(result.data && result.data.recordId && task.operation !== 'update' ? { sourceId: result.data.recordId } : {}),
      ...(result.data && result.data.deletionId ? { deletionId: result.data.deletionId } : {}) }));
    Promise.resolve().then(() => resume()).catch(error => console.warn('原静坐已保存，功课镜像待恢复:', error && error.message));
  } catch (error) { visibleWarning(error); }
}
function resume() {
  // 前一轮读取期间原静坐又完成了一次写入，需要再读一次；旧读取的
  // barrier 不包含新意图，不能把这次恢复触发静默丢掉。
  recoveryRequested = true;
  if (recovering) return recovering;
  recovering = Promise.resolve().then(async () => {
    let result;
    do {
      recoveryRequested = false;
      const owner = auth.getOwner();
      if (config.sittingMirrorEnabled === true && owner &&
          queue.getPending().some(task => task.kind === 'mirror' && task.status === 'waiting_source')) {
        const barrier = captureRecoveryBarrier(owner);
        const response = await require('./cloudApi.js').getAllRecords();
        if (response.success && Array.isArray(response.data) && api.sameOwner(owner, auth.getOwner())) await acceptCloudSnapshot(response.data, owner, barrier);
      }
      result = await queue.flush();
    } while (recoveryRequested);
    return result;
  }).finally(() => { recovering = null; });
  return recovering;
}
module.exports = { beforeCloudMutation, observeCloudResult, acceptCloudSnapshot, captureRecoveryBarrier, prepareForSend, resume, sourceVersion };
