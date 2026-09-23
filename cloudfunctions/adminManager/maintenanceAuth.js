// Canonical source; deployment-local copies are checked by maintenanceAuthorization.test.js.
// Only WXContext returned by the SDK and server deployment configuration may authorize work.
function canRunMaintenance(wxContext = {}, environment = {}, allowTimer = false) {
  const openid = typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  const admins = String(environment.MAINTENANCE_ADMIN_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (openid) return admins.includes(openid);
  if (!allowTimer || environment.BIJING_TIMER_ENABLED !== 'true') return false;
  const expectedSource = environment.BIJING_TIMER_SOURCE;
  // Refuse broad client/service sources even if they were accidentally configured as timers.
  if (typeof expectedSource !== 'string' || !expectedSource.trim() ||
      ['wx_client', 'wx_devtools', 'wx_http', 'wx_cloudfunction', 'wx_unknown', 'unknown'].includes(expectedSource)) return false;
  // SOURCE is SDK/platform context, never event.source or an absence of OPENID.
  // Enable only after a real trigger and all other callable paths have been checked in staging.
  return wxContext.SOURCE === expectedSource;
}

// The control panel has exactly one owner, configured only on the server.
// Never treat the maintenance allowlist or a platform timer as panel access.
function canManageControlPanel(wxContext = {}, environment = {}) {
  const configured = typeof environment.ADMIN_OPENID === 'string' ? environment.ADMIN_OPENID.trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(configured)) return false;
  const openid = typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  return Boolean(openid && openid === configured);
}

function forbidden() {
  return { success: false, code: 'FORBIDDEN', error: '此操作仅允许已授权的运维身份或已验证的定时任务' };
}

function panelForbidden() {
  return { success: false, code: 'FORBIDDEN', error: '仅指定的管理员微信账号可执行此操作' };
}

module.exports = { canRunMaintenance, canManageControlPanel, forbidden, panelForbidden };
