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

function forbidden() {
  return { success: false, code: 'FORBIDDEN', error: '此操作仅允许已授权的运维身份或已验证的定时任务' };
}

module.exports = { canRunMaintenance, forbidden };
