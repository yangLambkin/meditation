const cloud = require('wx-server-sdk');
const { panelForbidden } = require('./maintenanceAuth');
const { canManageControlPanel } = require('./studentAuth');
const { resolveAccessIdentity } = require('./delegation');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function isMissingAlertCollection(error) {
  const text = [error && error.code, error && error.errCode, error && error.message, error && error.errMsg]
    .filter(value => value !== undefined).join(' ');
  return [error && error.code, error && error.errCode].map(String).includes('-502005') ||
    /\b(?:DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)\b/i.test(text) ||
    /\bcollection\b(?:\s+["'`]?[\w.-]+["'`]?)?\s+(?:(?:does|is)\s+)?(?:not exists?|not found)\b|集合\s*(?:["'`]?[\w.-]+["'`]?)?\s*不存在/i.test(text);
}

async function alertExists(read) {
  try {
    const result = await read();
    if (!result || !Array.isArray(result.data)) throw new Error('Invalid alert response');
    return { exists: result.data.length > 0, failed: false };
  } catch (error) {
    // Collections not yet initialized contain no alerts. Other failures remain
    // unknown, so an unavailable source cannot silently clear a known reminder.
    return { exists: false, failed: !isMissingAlertCollection(error) };
  }
}

exports.main = async (event = {}) => {
  if (!event || !['getAccess', 'getSyncAlert', 'adminSearchUsers', 'adminGetDayRecords', 'adminMigrateBindings', 'adminListFeedback', 'adminUpdateFeedback', 'adminDeleteFeedback'].includes(event.type)) {
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
  if (event.type === 'adminListFeedback' || event.type === 'adminUpdateFeedback' || event.type === 'adminDeleteFeedback') {
    if (!isAdmin) return panelForbidden();
    return require('./feedback').handleFeedback(event, { db: getDatabase(), cloud, openid: wxContext.OPENID }, true);
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
  // 鉴权必须先于错误及反馈表访问，普通用户只能获得原有的空提醒响应。
  if (!isAdmin) return { success: true, data: { isAdmin: false, hasErrors: false } };
  try {
    const db = getDatabase();
    const [sync, feedback] = await Promise.all([
      alertExists(() => db.collection('bijing_sync_errors').field({ _id: true }).limit(1).get()),
      alertExists(() => db.collection('feedback').where({ status: db.command.in(['pending', 'processing']) })
        .field({ _id: true }).limit(1).get())
    ]);
    // Either confirmed positive is enough to keep the reminder visible, even
    // when the other source is temporarily unavailable.
    if (!sync.exists && !feedback.exists && (sync.failed || feedback.failed)) throw new Error('Alert source unavailable');
    return { success: true, data: { isAdmin: true, hasErrors: sync.exists, hasFeedback: feedback.exists } };
  } catch (error) {
    return { success: false, error: '管理员提醒暂时无法读取，请稍后重试' };
  }
};
