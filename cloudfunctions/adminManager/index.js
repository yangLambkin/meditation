const cloud = require('wx-server-sdk');
const { panelForbidden } = require('./maintenanceAuth');
const { canManageControlPanel } = require('./studentAuth');
const { resolveAccessIdentity } = require('./delegation');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  if (!event || !['getAccess', 'getSyncAlert', 'adminSearchUsers', 'adminGetDayRecords', 'adminMigrateBindings'].includes(event.type)) {
    return { success: false, error: '未知的操作类型' };
  }
  const wxContext = cloud.getWXContext() || {};
  const getDatabase = () => cloud.database({ throwOnNotFound: false });
  let isAdmin;
  try {
    if (event.type === 'getAccess') {
      const openid = await resolveAccessIdentity(wxContext, event, getDatabase);
      isAdmin = Boolean(openid && await canManageControlPanel({ OPENID: openid }, process.env, getDatabase));
    } else {
      // Delegations authorize only a central access probe, never direct records or alerts.
      isAdmin = await canManageControlPanel(wxContext, process.env, getDatabase);
    }
  } catch (error) {
    return { success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试' };
  }
  if (event.type === 'getAccess') {
    return { success: true, data: { isAdmin } };
  }
  if (event.type === 'adminMigrateBindings') {
    if (!isAdmin) return panelForbidden();
    try {
      const data = await require('./bindingMigration').createBindingMigration({ db: getDatabase() }).run({
        dryRun: event.dryRun, cursor: event.cursor, limit: event.limit
      });
      return { success: true, data };
    } catch (error) {
      console.error('绑定迁移失败:', error.message);
      return { success: false, code: 'BINDING_MIGRATION_FAILED', error: '绑定迁移未完成，可从原游标重试' };
    }
  }
  if (event.type === 'adminSearchUsers' || event.type === 'adminGetDayRecords') {
    // 查询他人记录必须先检查云端指定的管理员身份，客户端资料不能授予权限。
    if (!isAdmin) return panelForbidden();
    const { handleRecordQuery } = require('./records');
    return handleRecordQuery(event, () => cloud.database({ throwOnNotFound: false }));
  }
  // 鉴权必须先于错误表访问，普通用户只能获得空提醒，不能读取错误明细。
  if (!isAdmin) return { success: true, data: { isAdmin: false, hasErrors: false } };
  try {
    const result = await cloud.database().collection('bijing_sync_errors').limit(1).get();
    return { success: true, data: { isAdmin: true, hasErrors: Array.isArray(result.data) && result.data.length > 0 } };
  } catch (error) {
    return { success: false, error: '同步提醒暂时无法读取，请稍后重试' };
  }
};
