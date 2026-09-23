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

// The control-panel allowlist is configured only on the server.
// An explicit ADMIN_OPENIDS replaces the legacy single-account ADMIN_OPENID.
// Never treat the maintenance allowlist or a platform timer as panel access.
function canManageControlPanel(wxContext = {}, environment = {}) {
  const hasAllowlist = environment.ADMIN_OPENIDS !== undefined;
  const configured = hasAllowlist ? environment.ADMIN_OPENIDS : environment.ADMIN_OPENID;
  if (typeof configured !== 'string') return false;
  const admins = (hasAllowlist ? configured.split(',') : [configured]).map(value => value.trim());
  // Invalid or empty entries reject the whole configuration; do not revive a removed legacy admin.
  if (!admins.every(value => /^[A-Za-z0-9_-]+$/.test(value))) return false;
  const openid = typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  return Boolean(openid && admins.includes(openid));
}

// Business functions consult adminManager on every request. Their local admin
// environment variables never grant access or provide an outage fallback.
async function authorizeControlPanel(cloud, wxContext = {}) {
  const openid = wxContext && typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(openid)) return panelForbidden();
  const unavailable = () => ({
    success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试'
  });
  try {
    const response = await cloud.callFunction({
      name: 'adminManager',
      // This is only an identity consistency check. adminManager still obtains
      // the authenticated identity independently from its own platform context.
      data: { type: 'getAccess', expectedOpenid: openid },
      config: { env: cloud.DYNAMIC_CURRENT_ENV },
      timeout: 2000
    });
    const result = response && response.result;
    if (!result || result.success !== true || !result.data || typeof result.data.isAdmin !== 'boolean') {
      return unavailable();
    }
    return result.data.isAdmin ? { success: true } : panelForbidden();
  } catch (error) {
    return unavailable();
  }
}

function forbidden() {
  return { success: false, code: 'FORBIDDEN', error: '此操作仅允许已授权的运维身份或已验证的定时任务' };
}

function panelForbidden() {
  return { success: false, code: 'FORBIDDEN', error: '仅指定的管理员微信账号可执行此操作' };
}

module.exports = { canRunMaintenance, canManageControlPanel, authorizeControlPanel, forbidden, panelForbidden };
