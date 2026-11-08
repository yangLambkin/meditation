const DIM_BRIGHTNESS = 0.01;

// 只归还本次实际修改过的亮度，串行处理读取、调暗和恢复，避免退出时相互覆盖。
function createScreenBrightnessController(api) {
  let platform;
  try {
    const device = typeof api.getDeviceInfo === 'function'
      ? api.getDeviceInfo()
      : api.getSystemInfoSync();
    platform = device.platform;
  } catch (error) {
    console.warn('⚠️ 获取亮度控制平台失败:', error);
  }

  let wantsDim = false;
  let revision = 0;
  let busy = false;
  let changed = false;
  let originalBrightness;

  function sync() {
    if (busy) return;

    if (wantsDim) {
      if (changed) return;
      busy = true;
      const requestRevision = revision;
      api.getScreenBrightness({
        success: ({ value }) => {
          // 读取期间可能已暂停、切页或退出；旧回调不能再调暗屏幕。
          if (!wantsDim || requestRevision !== revision) {
            busy = false;
            sync();
            return;
          }
          if (!Number.isFinite(value) || value < 0 || value > 1) {
            busy = false;
            return;
          }
          // 已经足够暗时无需修改，也就无需在退出时恢复。
          if (platform !== 'android' && value <= DIM_BRIGHTNESS) {
            busy = false;
            return;
          }

          originalBrightness = value;
          api.setScreenBrightness({
            value: DIM_BRIGHTNESS,
            success: () => {
              changed = true;
              busy = false;
              // 调暗请求发出后才离开页面，也只在成功后恢复一次。
              if (!wantsDim) sync();
            },
            fail: (error) => {
              originalBrightness = undefined;
              busy = false;
              console.warn('⚠️ 设置最低亮度失败:', error);
              if (requestRevision !== revision) sync();
            }
          });
        },
        fail: (error) => {
          busy = false;
          // 无法确认原亮度时不调暗，更不能用默认值覆盖用户设置。
          console.warn('⚠️ 获取亮度失败，跳过自动调暗:', error);
          if (requestRevision !== revision) sync();
        }
      });
      return;
    }

    if (!changed) return;
    busy = true;
    api.setScreenBrightness({
      // Android 的读取值可能不是实时自动亮度；-1 交还系统控制。
      value: platform === 'android' ? -1 : originalBrightness,
      success: () => {
        changed = false;
        originalBrightness = undefined;
        busy = false;
        if (wantsDim) sync();
      },
      fail: (error) => {
        busy = false;
        // 保留所有权，下一次停止/离开时仍可以重试恢复。
        console.warn('⚠️ 恢复亮度失败:', error);
      }
    });
  }

  return {
    dim() {
      if (!wantsDim) revision += 1;
      wantsDim = true;
      sync();
    },
    restore() {
      if (wantsDim) revision += 1;
      wantsDim = false;
      sync();
    }
  };
}

module.exports = { createScreenBrightnessController };
