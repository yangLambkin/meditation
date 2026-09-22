// 一轮上传只在网络连续可用时有效；恢复网络不会恢复已中断的上传授权。
let disconnectVersion = 0;
let listening = false;

function pausedError() {
  const error = new Error('网络不可用或上传已中断，记录已存本机，请手动上传');
  error.code = 'UPLOAD_PAUSED';
  return error;
}

function capture() {
  if (!listening && typeof wx.onNetworkStatusChange === 'function') {
    wx.onNetworkStatusChange(({ isConnected, networkType }) => {
      if (isConnected === false || networkType === 'none') disconnectVersion++;
    });
    listening = true;
  }
  return disconnectVersion;
}

function assertUninterrupted(version) {
  if (version !== disconnectVersion) throw pausedError();
}

// 探测与写入共用本次尝试的期限。探测失败也留待手动处理，不能盲发 SDK 请求。
function ensureOnline(version, deadlineAt) {
  assertUninterrupted(version);
  if (typeof wx.getNetworkType !== 'function') {
    disconnectVersion++;
    return Promise.reject(pausedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    function finish(error) {
      if (settled) return;
      settled = true;
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      if (error) {
        // 外层三秒期限可能先结算成超时；版本也必须失效，避免随后再次自动重试。
        if (version === disconnectVersion) disconnectVersion++;
        reject(error);
      }
      else resolve();
    }
    if (deadlineAt <= Date.now()) {
      finish(pausedError());
      return;
    }
    if (typeof setTimeout === 'function') {
      timer = setTimeout(() => finish(pausedError()), Math.max(0, deadlineAt - Date.now()));
    }
    try {
      wx.getNetworkType({
        success: result => {
          if (settled) return;
          if (!result || !result.networkType || ['none', 'unknown'].includes(result.networkType)) {
            finish(pausedError());
            return;
          }
          try {
            assertUninterrupted(version);
            finish(Date.now() >= deadlineAt ? pausedError() : null);
          } catch (error) {
            finish(error);
          }
        },
        fail: () => finish(pausedError())
      });
    } catch (error) {
      finish(pausedError());
    }
  });
}

module.exports = { capture, assertUninterrupted, ensureOnline };
