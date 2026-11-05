const READ_TIMEOUT_MS = 5000;

function unresolved() {
  return new Error('原感悟尚未完整读取，请联网后重新打开记录，避免覆盖原内容');
}

function isReference(value) {
  return /^exp_[a-f0-9]{64}$/.test(value) || /^\d{13}$/.test(value) || /^[a-z0-9_-]{24,64}$/i.test(value);
}

// 读取完整原文后才允许编辑；任何引用失败都不能把部分正文当作完整感悟。
// 内联正文和本机完整缓存同步返回，不为普通记录增加网络请求。
function resolveCheckinReflection(experience, cached = {}, openid = '', api = wx) {
  const values = Array.isArray(experience) ? experience : experience ? [experience] : [];
  const reads = new Map();
  const owned = value => (!value._openid || value._openid === openid)
    && (!value.syncOpenid || value.syncOpenid === openid);
  const texts = values.map(value => {
    if (value && typeof value === 'object') {
      if (!owned(value) || typeof value.text !== 'string') throw unresolved();
      return value.text;
    }
    if (typeof value !== 'string') throw unresolved();
    if (!value) return '';
    const matches = Object.entries(cached).filter(([key, item]) => item &&
      [key, item._id, item.uniqueId, item.timestamp].some(id => id !== undefined && String(id) === value));
    if (matches.some(([, item]) => !owned(item))) throw unresolved();
    // 旧缓存会把尚未下载的正文标准化成空串，空缓存不能证明原感悟为空。
    const bodies = matches.map(([, item]) => item.text).filter(text => typeof text === 'string' && text.trim());
    if (new Set(bodies).size > 1) throw unresolved();
    if (bodies.length) return bodies[0];
    if (!isReference(value) && !matches.length) return value;
    if (!openid || !api.cloud || typeof api.cloud.database !== 'function') throw unresolved();
    if (!reads.has(value)) {
      const ids = [...new Set(matches.map(([, item]) => item._id).filter(id => typeof id === 'string' && id))];
      if (ids.length > 1) throw unresolved();
      reads.set(value, async () => {
        const collection = api.cloud.database().collection('experience_records');
        const response = !ids.length && /^\d{13}$/.test(value)
          ? await collection.where({ _openid: openid, timestamp: Number(value) }).limit(2).get()
          : await collection.doc(ids[0] || value).get();
        const record = Array.isArray(response && response.data)
          ? response.data.length === 1 && response.data[0] : response && response.data;
        if (!record || record._openid !== openid || typeof record.text !== 'string') throw unresolved();
        return record.text;
      });
    }
    return { reference: value };
  });
  const join = parts => parts.filter(Boolean).join('\n\n');
  if (!reads.size) return join(texts);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(unresolved()), READ_TIMEOUT_MS);
    const pending = new Map([...reads].map(([key, read]) => [key, Promise.resolve().then(read)]));
    Promise.all(texts.map(text => typeof text === 'string' ? text : pending.get(text.reference))).then(parts => {
      clearTimeout(timer);
      resolve(join(parts));
    }, () => {
      clearTimeout(timer);
      reject(unresolved());
    });
  });
}

module.exports = { resolveCheckinReflection };
