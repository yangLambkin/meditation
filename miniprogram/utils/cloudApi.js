// 云存储API封装
const cloudApi = {
  // 调用云函数
  callCloudFunction: function(functionName, data) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: functionName,
        data: data,
        success: resolve,
        fail: reject
      });
    });
  },

  // 记录冥想打卡
  recordMeditation: async function(duration, rating, experience = "") {
    try {
      // 处理experience参数格式（确保与云函数接口兼容）
      let experienceToSend = experience;
      if (Array.isArray(experience)) {
        // 云函数期望experience为数组，直接传递
        experienceToSend = experience;
      } else if (typeof experience === 'string') {
        // 如果是字符串，转换为单元素数组
        experienceToSend = experience ? [experience] : [];
      }
      
      const result = await this.callCloudFunction('meditationManager', {
        type: 'recordMeditation',
        data: {
          duration: duration,
          rating: rating,
          experience: experienceToSend
        }
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '打卡失败'
        };
      }
    } catch (error) {
      console.error('调用云函数失败:', error);
      return {
        success: false,
        error: '网络错误，请重试'
      };
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
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getUserStats'
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

  // 获取排行榜
  getRankings: async function(period = 'total') {
    try {
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getRankings',
        period: period
      });

      if (result.result.success) {
        return {
          success: true,
          data: result.result.data
        };
      } else {
        return {
          success: false,
          error: result.result.error || '获取排行榜失败'
        };
      }
    } catch (error) {
      console.error('获取排行榜失败:', error);
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
      const result = await this.callCloudFunction('meditationManager', {
        type: 'getAllRecords'
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