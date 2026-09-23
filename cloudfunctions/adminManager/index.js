const cloud = require('wx-server-sdk');
const { canManageControlPanel, panelForbidden } = require('./maintenanceAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  if (!event || !['getAccess', 'getSyncAlert', 'adminSearchUsers', 'adminGetDayRecords'].includes(event.type)) {
    return { success: false, error: '未知的操作类型' };
  }
  const isAdmin = canManageControlPanel(cloud.getWXContext(), process.env);
  if (event.type === 'getAccess') return { success: true, data: { isAdmin } };
  if (event.type === 'adminSearchUsers' || event.type === 'adminGetDayRecords') {
    // 查询他人记录必须先检查云端指定的管理员身份，客户端资料不能授予权限。
    if (!isAdmin) return panelForbidden();
    const { handleRecordQuery } = require('./records');
    return handleRecordQuery(event, () => cloud.database());
  }
  // 鉴权必须先于数据库访问，普通用户只能获得空提醒，不能读取错误明细。
  if (!isAdmin) return { success: true, data: { isAdmin: false, hasErrors: false } };
  try {
    const result = await cloud.database().collection('bijing_sync_errors').limit(1).get();
    return { success: true, data: { isAdmin: true, hasErrors: Array.isArray(result.data) && result.data.length > 0 } };
  } catch (error) {
    return { success: false, error: '同步提醒暂时无法读取，请稍后重试' };
  }
};
