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
  const response = await require('./cloudApi.js').getAllRecords({ observePracticeSnapshot: false });
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
function deletionPayload(task) {
  // DELETE 按稳定源 ID 写永久删除标记，不依赖版本排序。
  // 有原云版本时继续携带；缺少时省略，不能读取仅云函数可访问的锁集合。
  const version = sourceVersion(task.snapshot);
  return version ? { sourceVersion: version } : {};
}
function confirmDeletion(task, sourceId) {
  const current = queue.getPending({ allOwners: true }).find(item => item.id === task.id && api.sameOwner(item.owner, task.owner));
  if (!current) return;
  const expectedId = current.sourceId || current.identity.recordId;
  if (expectedId && expectedId !== sourceId) throw Object.assign(new Error('原静坐删除返回的记录标识尚未确认，已保留待核对'),
    { code: 'SOURCE_ID_UNCONFIRMED' });
  // 完整快照可能先于原删除回包确认了任务。首次确认后固定请求内容，
  // 晚到回包不能用旧快照改变同一请求身份的版本，造成服务端幂等冲突。
  if (current.status === 'waiting_source') return queue.confirmSource(current.id, sourceId, deletionPayload(current));
}
function captureRecoveryBarrier(owner = auth.getOwner()) {
  if (!owner || config.sittingMirrorEnabled !== true) return [];
  return queue.getPending().filter(task => task.kind === 'mirror' && task.status === 'waiting_source' && api.sameOwner(task.owner, owner))
    .map(task => task.id);
}
async function applySnapshot(records, owner, eligibleTaskIds) {
  if (!api.sameOwner(owner, auth.getOwner()) || !validSnapshot(records, owner)) return;
  const tasks = queue.getPending().filter(task => task.kind === 'mirror' && task.status === 'waiting_source' && eligibleTaskIds.includes(task.id));
  const confirmedIds = [];
  for (const task of tasks) {
    if (!api.sameOwner(task.owner, owner)) continue;
    try {
      const candidates = records.filter(record => matches(task, record));
      if (candidates.length > 1) throw Object.assign(new Error('来源记录身份不唯一，等待核对'), { code: 'SOURCE_AMBIGUOUS' });
      const record = candidates[0];
      if (task.operation === 'delete') {
        if (record) {
          queue.annotateSource(task.id, { sourceId: record._id, identity: { ...task.identity, recordId: record._id },
            snapshot: { ...task.snapshot, ...record } });
          continue;
        }
        const sourceId = task.sourceId || task.identity.recordId;
        if (!sourceId) {
          // 恢复已删除本机记录留下的待办；完整来源读取与队列中的未决写入
          // 一并核对，只有从未产生云端来源的本机删除才无需发送镜像。
          if (queue.discardLocalSourceDeletion(task.id, owner)) continue;
          throw Object.assign(new Error('删除已登记，等待原静坐记录标识确认'), { code: 'SOURCE_ID_UNAVAILABLE' });
        }
        if (confirmDeletion(task, sourceId)) confirmedIds.push(task.id);
        continue;
      }
      if (!record) continue;
      if (task.operation === 'create' && !verifiesCreate(task, record) || task.operation === 'update' && !verifiesUpdate(task, record)) continue;
      if (task.snapshot.requiresDeletionVersion) throw Object.assign(new Error('原独立体验删除未提供静坐变更版本，需核对后同步'), { code: 'SOURCE_VERSION_UNAVAILABLE' });
      const payload = await recordPayload(record, owner);
      if (!api.sameOwner(owner, auth.getOwner())) return;
      const confirmed = queue.confirmSource(task.id, record._id, payload);
      if (confirmed && confirmed.status === 'pending') confirmedIds.push(task.id);
    } catch (error) {
      try { queue.markSourceError(task.id, error.code || 'SOURCE_CONFIRMATION_FAILED', error.message || '来源待确认'); }
      catch (storageError) { visibleWarning(storageError); }
    }
  }
  // 发送前复核来源也会经过云端读取回调；没有新确认的来源时，不能再
  // 启动一轮发送，否则失败任务会通过自己的复核读取不断触发重试。
  if (confirmedIds.length) {
    const result = await queue.flush();
    // 已运行的发送轮次可能尚未包含刚确认的新记录；只补发这些未尝试
    // 的来源，不重新发送同轮已失败的旧任务。
    const unsentIds = queue.getPending().filter(task => confirmedIds.includes(task.id) &&
      task.status === 'pending' && task.attempts === 0).map(task => task.id);
    if (unsentIds.length) {
      const followup = await queue.flush({ taskIds: unsentIds, onlyUnattempted: true });
      return { ...followup, sent: result.sent + followup.sent };
    }
    return result;
  }
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
  const intents = Array.isArray(intent) ? intent : [intent];
  if (result && result.success === false && result.code === 'RECORD_NOT_FOUND') {
    try {
      intents.filter(task => task.operation === 'delete')
        .forEach(task => queue.discardLocalSourceDeletion(task.id, task.owner));
    } catch (error) { visibleWarning(error); }
    return;
  }
  if (!result || result.success !== true) return;
  try {
    intents.forEach(task => {
      const recordId = result.data && result.data.recordId;
      if (task.operation === 'delete') {
        const expectedId = task.sourceId || task.identity.recordId;
        if (typeof recordId !== 'string' || !recordId.trim() || expectedId && expectedId !== recordId) {
          queue.markSourceError(task.id, 'SOURCE_ID_UNCONFIRMED', '原静坐删除返回的记录标识尚未确认，已保留待核对');
          return;
        }
        // 原删除成功已足够确认该稳定源 ID，直接走 OpenAPI，不再读取删除凭据。
        confirmDeletion(task, recordId);
        queue.annotateSource(task.id, { cloudConfirmed: true });
        return;
      }
      queue.annotateSource(task.id, { cloudConfirmed: true,
        ...(recordId && task.operation !== 'update' ? { sourceId: recordId } : {}) });
    });
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
      let snapshotResult;
      if (config.sittingMirrorEnabled === true && owner &&
          queue.getPending().some(task => task.kind === 'mirror' && task.status === 'waiting_source')) {
        const barrier = captureRecoveryBarrier(owner);
        const response = await require('./cloudApi.js').getAllRecords({ observePracticeSnapshot: false });
        if (response.success && Array.isArray(response.data) && api.sameOwner(owner, auth.getOwner())) {
          snapshotResult = await acceptCloudSnapshot(response.data, owner, barrier);
        }
      }
      // 新确认的来源已在 applySnapshot 中发送，不重复执行同一轮失败任务。
      result = snapshotResult === undefined ? await queue.flush() : snapshotResult;
    } while (recoveryRequested);
    return result;
  }).finally(() => { recovering = null; });
  return recovering;
}
module.exports = { beforeCloudMutation, observeCloudResult, acceptCloudSnapshot, captureRecoveryBarrier, prepareForSend, resume, sourceVersion };
