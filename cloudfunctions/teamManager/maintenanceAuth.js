// Canonical source; deployment-local copies are checked by maintenanceAuthorization.test.js.
// SDK identity is delegated only through an unguessable, server-only database proof.
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

function boundProofOperation(operation, timeout) {
  let timer;
  return Promise.race([
    operation,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Delegation database operation timed out')), timeout);
    })
  ]).finally(() => clearTimeout(timer));
}

// Business functions consult adminManager on every request. Their local admin
// environment variables never grant access or provide an outage fallback.
async function authorizeControlPanel(cloud, wxContext = {}) {
  const openid = wxContext && typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(openid)) return panelForbidden();
  const unavailable = () => ({
    success: false, code: 'ADMIN_AUTH_UNAVAILABLE', error: '管理员权限校验暂时不可用，请稍后重试'
  });
  let proof;
  try {
    // Nested CloudBase calls can omit the original OPENID. Only server SDK code
    // can create this proof: bijing_bindings denies all client reads and writes.
    const delegationId = `auth_${require('crypto').randomBytes(32).toString('hex')}`;
    const createdAt = Date.now();
    proof = cloud.database({ throwOnNotFound: false }).collection('bijing_bindings').doc(delegationId);
    await boundProofOperation(proof.set({ data: {
      kind: 'admin-delegation', openid, createdAt, expiresAt: createdAt + 30000, audience: 'adminManager'
    } }), 2000);
    const response = await cloud.callFunction({
      name: 'adminManager',
      // The expected identity only restricts the consumed proof; it cannot grant access.
      data: { type: 'getAccess', expectedOpenid: openid, delegationId },
      config: { env: cloud.DYNAMIC_CURRENT_ENV },
      timeout: 8000
    });
    const result = response && response.result;
    if (!result || result.success !== true || !result.data || typeof result.data.isAdmin !== 'boolean') {
      return unavailable();
    }
    return result.data.isAdmin ? { success: true } : panelForbidden();
  } catch (error) {
    return unavailable();
  } finally {
    // Normally consumed by adminManager. Also clean up failed or timed-out calls;
    // deletion failure never exposes the proof or changes an authorization result.
    if (proof) {
      try { await boundProofOperation(proof.remove(), 1000); } catch (error) { /* expires after 30 seconds */ }
    }
  }
}

function forbidden() {
  return { success: false, code: 'FORBIDDEN', error: '此操作仅允许已授权的运维身份或已验证的定时任务' };
}

function panelForbidden() {
  return { success: false, code: 'FORBIDDEN', error: '仅绑定指定管理员学号的账号可执行此操作' };
}

module.exports = { canRunMaintenance, authorizeControlPanel, forbidden, panelForbidden };
