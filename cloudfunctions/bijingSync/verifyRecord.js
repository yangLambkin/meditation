function verificationError(message) {
  const error = new Error(message);
  error.code = 'BIJING_VERIFY_FAILED';
  return error;
}

async function verifyRecord({ axios, apiBase, accessToken, studentNumber, recordDate, durationMinutes, timeoutMs = 10000 }) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 0) {
    throw verificationError('必经数据核对失败：预期静坐时长无效');
  }

  let response;
  try {
    response = await axios.post(`${apiBase}/api/openapi/meditation/records/query`, {
      records: [{ studentNumber, recordDate }],
    }, {
      headers: { 'X-Access-Token': accessToken },
      timeout: timeoutMs,
    });
  } catch (_) {
    // Axios errors can contain request headers, so never expose the raw error.
    throw verificationError('必经数据回查失败，请稍后重试');
  }

  const payload = response && response.data;
  const data = payload && payload.data;
  if (!payload || payload.success !== true || !data || data.total !== 1 ||
      !Array.isArray(data.results) || data.results.length !== 1) {
    throw verificationError('必经数据回查返回无效响应，请稍后重试');
  }

  const record = data.results[0];
  if (!record || record.index !== 0 || record.studentNumber !== studentNumber || record.recordDate !== recordDate ||
      typeof record.exists !== 'boolean' || !Number.isInteger(record.durationMinutes) || record.durationMinutes < 0 ||
      (!record.exists && record.durationMinutes !== 0)) {
    throw verificationError('必经数据回查返回不完整或不匹配的记录，请稍后重试');
  }

  if (record.durationMinutes !== durationMinutes || (durationMinutes > 0 && !record.exists)) {
    throw verificationError(record.exists
      ? `必经数据核对失败：当日时长为${record.durationMinutes}分钟，期望${durationMinutes}分钟`
      : '必经数据核对失败：尚未查到当日静坐记录');
  }
  return record;
}

module.exports = { verifyRecord };
