// 通过 OpenAPI 读取当前用户绑定学号的统计，Access Token 仅保存在云函数环境变量中。
async function getHeatmap({ openid, getUserDoc, getApiBase, getAccessToken, axios }) {
  if (!openid) return { success: false, error: '请先登录' };
  try {
    const user = await getUserDoc(openid);
    if (!user || !user.bijingBound || !user.bijingStudentNumber) {
      return { success: false, error: '请先绑定必经之路学号' };
    }
    const response = await axios.get(`${getApiBase().replace(/\/$/, '')}/api/openapi/meditation/heatmap`, {
      params: { studentNumber: user.bijingStudentNumber },
      headers: { 'X-Access-Token': getAccessToken() },
      timeout: 10000
    });
    const payload = response.data;
    if (!payload || !payload.success || !payload.data || !Array.isArray(payload.data.records)) {
      return { success: false, error: (payload && payload.message) || '热力图数据暂时不可用，请重试' };
    }
    const records = payload.data.records.filter(record => {
      if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
      const date = new Date(`${record.date}T12:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === record.date &&
        Number.isFinite(Number(record.duration)) && Number(record.duration) >= 0;
    }).map(record => ({ date: record.date, duration: Number(record.duration) }));
    return { success: true, data: {
      studentNumber: user.bijingStudentNumber, nickname: payload.data.nickname || '', records
    } };
  } catch (error) {
    return { success: false, error: '热力图加载失败，请稍后重试' };
  }
}

module.exports = { getHeatmap };
