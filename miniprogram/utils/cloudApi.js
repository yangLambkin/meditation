// 打卡同步请求不依赖 SDK 的最终回调解锁；其它云业务保留原有等待行为。
const CLOUD_REQUEST_TIMEOUT_MS = 5000;
const UPLOAD_TIMEOUT_MS = 3000;
const uploadNetwork = require('./uploadNetwork.js');

function cloudTimeoutError(timeoutMs) {
  const error = new Error(`上传超时（${timeoutMs / 1000}秒），请手动重试`);
  error.code = 'CLOUD_TIMEOUT';
  return error;
}

// 云存储API封装
const cloudApi = {
  // 调用云函数
  callCloudFunction: function(functionName, data, options = {}) {
    const isUpload = data && ((functionName === 'meditationManager' && data.type === 'recordMeditation') ||
      (functionName === 'contentSecCheck' && data.type === 'text' && options.isUpload === true));
    const timeoutMs = isUpload ? UPLOAD_TIMEOUT_MS : CLOUD_REQUEST_TIMEOUT_MS;
    const needsTimeout = data && (
      (functionName === 'contentSecCheck' && data.type === 'text') ||
      (functionName === 'meditationManager' && ['recordMeditation', 'getAllRecords', 'getUserStats'].includes(data.type))
    );
    const deadlineAt = needsTimeout ? Math.min(Date.now() + timeoutMs,
      Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity) : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (typeof clearTimeout === 'function') clearTimeout(timeout);
        callback(value);
      };
      if (needsTimeout && deadlineAt <= Date.now()) {
        finish(reject, cloudTimeoutError(timeoutMs));
        return;
      }
      if (needsTimeout && typeof setTimeout === 'function') {
        timeout = setTimeout(() => {
          finish(reject, cloudTimeoutError(timeoutMs));
        }, Math.max(0, deadlineAt - Date.now()));
      }
      try {
        if (isUpload && options.uploadNetworkVersion !== undefined) {
          uploadNetwork.assertUninterrupted(options.uploadNetworkVersion);
        }
        wx.cloud.callFunction({
          name: functionName,
          data: data,
          success: result => needsTimeout && Date.now() >= deadlineAt
            ? finish(reject, cloudTimeoutError(timeoutMs)) : finish(resolve, result),
          fail: error => needsTimeout && Date.now() >= deadlineAt
            ? finish(reject, cloudTimeoutError(timeoutMs)) : finish(reject, error)
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  // 记录冥想打卡
  recordMeditation: async function(duration, emotion, experience = "", timestamp, localId, options = {}) {
    try {
      const uploadNetworkVersion = Number.isSafeInteger(options.uploadNetworkVersion)
        ? options.uploadNetworkVersion : uploadNetwork.capture();
      const now = Date.now();
      // 每次上传尝试的文本检测与写入共用三秒；传入的截止时间只能缩短这次预算。
      const uploadDeadlineAt = Math.min(now + UPLOAD_TIMEOUT_MS,
        Number.isFinite(options.uploadDeadlineAt) ? options.uploadDeadlineAt : Infinity);
      if (uploadDeadlineAt <= now) throw cloudTimeoutError(UPLOAD_TIMEOUT_MS);
      const recordTimestamp = timestamp === undefined ? now : timestamp;
      if (!Number.isSafeInteger(recordTimestamp) || recordTimestamp <= 0 || recordTimestamp > now) {
        return { success: false, error: '打卡时间无效或晚于当前时间' };
      }
      // 处理experience参数格式（确保与云函数接口兼容）
      let experienceToSend = experience;
      if (Array.isArray(experience)) {
        // 云函数期望experience为数组，直接传递
        experienceToSend = experience;
      } else if (typeof experience === 'string') {
        // 如果是字符串，转换为单元素数组
        experienceToSend = experience ? [experience] : [];
      }

      // 离线打卡可以先保存本机；正文必须补审通过后才能上传，检测异常等待手动补传。
      const texts = (Array.isArray(experienceToSend) ? experienceToSend : [experienceToSend])
        .map(item => typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '')
        .filter(text => text.trim());
      for (const content of texts) {
        let check;
        try {
          await uploadNetwork.ensureOnline(uploadNetworkVersion, uploadDeadlineAt);
          const response = await this.callCloudFunction('contentSecCheck', { type: 'text', content, scene: 2 },
            { deadlineAt: uploadDeadlineAt, isUpload: true, uploadNetworkVersion });
          check = response && response.result;
        } catch (error) {
          if (error && ['CLOUD_TIMEOUT', 'UPLOAD_PAUSED'].includes(error.code)) throw error;
          return { success: false, code: 'CONTENT_CHECK_UNAVAILABLE', error: '内容安全检测暂不可用，请手动重试上传' };
        }
        if (check && check.success === true && check.safe === false) {
          return { success: false, code: 'CONTENT_REJECTED', error: '所发布内容含违规信息' };
        }
        if (!check || check.success !== true || check.safe !== true) {
          return { success: false, code: 'CONTENT_CHECK_UNAVAILABLE', error: '内容安全检测暂不可用，请手动重试上传' };
        }
      }
      
      await uploadNetwork.ensureOnline(uploadNetworkVersion, uploadDeadlineAt);
      const result = await this.callCloudFunction('meditationManager', {
        type: 'recordMeditation',
        data: {
          duration: duration,
          emotion: emotion,
          experience: experienceToSend,
          localId: localId || options.idempotencyKey || `record_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          ...(options.source ? { source: options.source } : {}),
          ...(options.date ? { date: options.date } : {}),
          ...(options.expectedOpenid ? { expectedOpenid: options.expectedOpenid } : {}),
          ...(options.recoverLegacy === true ? { recoverLegacy: true } : {}),
          timestamp: recordTimestamp
        }
      }, { deadlineAt: uploadDeadlineAt, uploadNetworkVersion });

      const response = result && result.result;
      if (response && response.success && response.data &&
          typeof response.data.recordId === 'string' && response.data.recordId.trim()) {
        return {
          success: true,
          data: response.data
        };
      } else {
        return {
          success: false,
          code: response && !response.success ? response.code : 'INVALID_RESPONSE',
          error: response && response.error || '云端尚未确认保存，请重试上传'
        };
      }
    } catch (error) {
      console.error('调用云函数失败:', error);
      return {
        success: false,
        code: error && ['CLOUD_TIMEOUT', 'UPLOAD_PAUSED'].includes(error.code) ? error.code : 'NETWORK_ERROR',
        error: error && ['CLOUD_TIMEOUT', 'UPLOAD_PAUSED'].includes(error.code) ? error.message : '网络错误，请手动重试'
      };
    }
  },

  // 删除静坐打卡；保留错误码以区分未备份的本地记录与网络失败。
  deleteMeditationRecord: async function(record) {
    try {
      const response = await this.callCloudFunction('meditationManager', {
        type: 'deleteMeditationRecord',
        data: record
      });
      return response.result || { success: false, error: '删除记录失败，请重试' };
    } catch (error) {
      console.error('删除静坐记录失败:', error);
      return { success: false, error: '网络错误，请重试' };
    }
  },

  // 获取用户某天的打卡记录
  getUserRecords: async function(date) {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getUserRecords',
        date: date
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '获取记录失败'
        };
      }
    } catch (error) {
      console.error('获取用户记录失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 获取用户统计信息
  getUserStats: async function() {
    try {
      // 获取当前用户的微信openid
      const userOpenId = wx.getStorageSync('userOpenId');
      
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getUserStats',
        openid: userOpenId
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '获取统计失败'
        };
      }
    } catch (error) {
      console.error('获取用户统计失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 获取月度统计
  getMonthlyStats: async function(month) {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getMonthlyStats',
        month: month
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '获取月度统计失败'
        };
      }
    } catch (error) {
      console.error('获取月度统计失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 获取所有记录
  getAllRecords: async function() {
    try {
      // 获取当前用户的微信openid
      const userOpenId = wx.getStorageSync('userOpenId');
      
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getAllRecords',
        openid: userOpenId
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '获取所有记录失败'
        };
      }
    } catch (error) {
      console.error('获取所有记录失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 更新打卡记录的体验内容
  updateMeditationRecord: async function(recordId, experience = "") {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'updateMeditationRecord',
        recordId: recordId,
        experience: experience
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '更新记录失败'
        };
      }
    } catch (error) {
      console.error('更新记录失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 保存体验记录（独立于打卡记录）
  saveExperienceRecord: async function(record) {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'saveExperienceRecord',
        record: record
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '保存体验记录失败'
        };
      }
    } catch (error) {
      console.error('保存体验记录失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  },

  // 删除体验记录（独立于打卡记录）
  deleteExperienceRecord: async function(recordId) {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'deleteExperienceRecord',
        recordId: recordId
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '删除体验记录失败'
        };
      }
    } catch (error) {
      console.error('删除体验记录失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
    }
  }
};

module.exports = cloudApi;
