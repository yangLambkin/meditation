const config = require('./practiceConfig.js');
const auth = require('./practiceAuth.js');
const TIMEOUT_MS = 10000;

function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}
function sameOwner(a, b) {
  return !!(a && b && a.openid === b.openid && a.studentNumber === b.studentNumber &&
    String(a.bindingVersion) === String(b.bindingVersion) && (!a.memberId || !b.memberId || a.memberId === b.memberId));
}
function assertOwner(owner) {
  if (!owner) throw error('AUTH_REQUIRED', '请先绑定本人必经账号');
  if (!sameOwner(owner, auth.getOwner())) throw error('ACCOUNT_CHANGED', '账号或绑定已变化，请切回原账号后重试');
}
function enabled(mirror) { return mirror ? config.sittingMirrorEnabled === true : config.practicesEnabled === true; }
function queryString(params = {}) {
  const parts = Object.keys(params).filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
function retryAfter(header = {}) {
  const value = header['Retry-After'] || header['retry-after'];
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(String(value))) return Math.ceil(Number(value) * 1000);
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
}
function transport(options) {
  return new Promise((resolve, reject) => {
    let settled = false, task;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, error('REQUEST_TIMEOUT', '功课请求超时，已保留待上传内容', { retryable: true }));
      if (task && typeof task.abort === 'function') task.abort();
    }, TIMEOUT_MS);
    try {
      task = wx.request({ ...options, timeout: TIMEOUT_MS,
        success: result => finish(resolve, result),
        fail: reason => finish(reject, error('NETWORK_ERROR', reason && reason.errMsg || '网络异常，请重试', { retryable: true })) });
    } catch (reason) { finish(reject, error('NETWORK_ERROR', reason.message || '网络异常，请重试', { retryable: true })); }
  });
}
async function request(path, { method = 'GET', payload, requestId, owner = auth.getOwner(), mirror = false } = {}) {
  if (!enabled(mirror)) throw error('FEATURE_DISABLED', mirror ? '静坐镜像同步暂未开放，待办已保留' : '功课记录暂未开放，待办已保留');
  assertOwner(owner);
  for (let refresh = 0; refresh < 2; refresh++) {
    const token = await auth.getAccessToken();
    assertOwner(owner);
    const result = await transport({ url: config.baseUrl.replace(/\/$/, '') + path, method,
      ...(payload !== undefined ? { data: payload } : {}),
      header: { 'Content-Type': 'application/json', 'X-Access-Token': token,
        'X-Expected-Student-Number': owner.studentNumber, 'X-Expected-Binding-Version': String(owner.bindingVersion),
        ...(requestId ? { 'Idempotency-Key': requestId } : {}) } });
    assertOwner(owner);
    const status = Number(result.statusCode), body = result.data;
    if (status === 401 && refresh === 0) { auth.clearSession(); continue; }
    if (status >= 200 && status < 300 && body && body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
    if (status >= 200 && status < 300 && (!body || body.success !== false)) {
      throw error('INVALID_RESPONSE', '功课请求未收到完整确认，已保留原请求以便重试', { status, retryable: true });
    }
    const message = body && (typeof body.error === 'string' ? body.error : body.error && body.error.message) ||
      body && body.message || '功课请求未获确认，请重试';
    throw error(body && (body.code || body.error && body.error.code) || (status === 401 ? 'AUTH_REQUIRED' : `HTTP_${status}`), message,
      { status, retryAfterMs: retryAfter(result.header), retryable: status === 408 || status === 425 || status === 429 || status >= 500 || !status });
  }
}
const recordPath = type => `/api/openapi/practices/${encodeURIComponent(type)}/records`;
module.exports = {
  request, sameOwner, assertOwner,
  feed: params => request('/api/openapi/practices/feed' + queryString(params)),
  summary: params => request('/api/openapi/practices/summary' + queryString(params)),
  list: (type, params) => request(recordPath(type) + queryString(params)),
  create: (type, payload, requestId, owner) => request(recordPath(type), { method: 'POST', payload, requestId, owner }),
  update: (type, id, payload, requestId, owner) => request(`${recordPath(type)}/${encodeURIComponent(id)}`, { method: 'PATCH', payload, requestId, owner }),
  remove: (type, id, requestId, owner) => request(`${recordPath(type)}/${encodeURIComponent(id)}`, { method: 'DELETE', requestId, owner }),
  mirror: (sourceId, operation, payload, requestId, owner) => request(`/api/openapi/practices/sitting/sources/meditation/${encodeURIComponent(sourceId)}`,
    { method: operation === 'delete' ? 'DELETE' : 'PUT', payload, requestId, owner, mirror: true })
};
