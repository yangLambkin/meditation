// 引入云存储API
const checkinManager = require('../../utils/checkin.js');
const cloudApi = require('../../utils/cloudApi.js');

Page({
  data: {
    stars: [
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false },
      { active: false, hover: false }
    ],
    selectedRating: 0,
    isHovering: false,
    currentHoverIndex: -1,
    currentText: '',
    currentTextLength: 0,
    savedRecords: [],
    userOpenId: '',
    duration: '7',
    sessionId: '' // 本次会话的唯一标识
  },

  onLoad(options) {
    // 接收时长参数并显示
    if (options.duration) {
      const durationText = options.duration + "分钟";
      this.setData({
        durationText: durationText,
        duration: options.duration
      });
    }
    
    // 获取用户openId
    this.getUserOpenId();
  },
  
  onShow() {
    // 页面显示时，初始化记录显示，清空之前会话的记录
    console.log('📱 recorder页面显示，初始化记录显示...');
    const sessionId = Date.now().toString();
    this.setData({
      savedRecords: [],
      sessionId: sessionId
    });
    console.log('🎯 本次会话ID:', sessionId);
  },

  // 选择评分
  selectRating: function(e) {
    const index = e.currentTarget.dataset.index;
    const newStars = this.data.stars.map((star, i) => ({
      ...star,
      active: i <= index,
      hover: false
    }));
    
    this.setData({
      stars: newStars,
      selectedRating: index + 1,
      isHovering: false,
      currentHoverIndex: -1
    });
  },

  // 星星触摸开始（模拟悬停）
  starTouchStart: function(e) {
    const index = e.currentTarget.dataset.index;
    const newStars = this.data.stars.map((star, i) => ({
      ...star,
      hover: i <= index
    }));
    
    this.setData({
      stars: newStars,
      isHovering: true,
      currentHoverIndex: index
    });
  },

  // 星星触摸结束
  starTouchEnd: function(e) {
    if (this.data.isHovering) {
      const newStars = this.data.stars.map(star => ({
        ...star,
        hover: false
      }));
      
      this.setData({
        stars: newStars,
        isHovering: false,
        currentHoverIndex: -1
      });
    }
  },

  // 星星触摸移动（模拟悬停跟随）
  starTouchMove: function(e) {
    if (this.data.isHovering) {
      // 可以在这里添加触摸跟随效果
    }
  },

  // 文本输入处理
  onTextInput: function(e) {
    const text = e.detail.value;
    this.setData({
      currentText: text,
      currentTextLength: text.length
    });
  },

  // 文本获得焦点
  onTextFocus: function() {
    console.log('文本输入框获得焦点');
  },

  // 文本失去焦点
  onTextBlur: function() {
    console.log('文本输入框失去焦点');
  },

  // 保存当前记录
  async saveCurrentRecord() {
    // 允许用户不填写体验内容也能保存打卡记录，无需二次确认
    const experienceText = this.data.currentText.trim();

    // 生成时间戳（使用兼容格式：YYYY-MM-DDTHH:MM:SS）
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19); // YYYY-MM-DD HH:MM:SS

    // 创建新记录（包含唯一时间戳和会话标识）
    const nowTime = now.getTime();
    const newRecord = {
      text: experienceText,
      timestamp: timestamp,
      rating: this.data.selectedRating,
      duration: this.data.durationText || '7分钟',
      // 添加唯一标识用于后续删除
      uniqueId: nowTime.toString(),
      // 标记本次会话，确保打卡时只关联本次会话的记录
      sessionId: this.data.sessionId
    };

    // 只添加当前记录到显示列表（不加载历史记录）
    const updatedSavedRecords = [newRecord, ...this.data.savedRecords];
    
    console.log('🔄 更新页面显示:', {
      currentRecordsCount: updatedSavedRecords.length,
      records: updatedSavedRecords.map(r => ({ text: r.text, timestamp: r.timestamp }))
    });
    
    this.setData({
      savedRecords: updatedSavedRecords,
      currentText: '',
      currentTextLength: 0
    });

    // 保存记录到云端和本地关联ID存储（用于打卡时关联）
    const allRecords = wx.getStorageSync('meditationTextRecords') || [];
    const updatedAllRecords = [newRecord, ...allRecords];
    this.saveRecordsToStorage(updatedAllRecords);
    
    // 调试：验证保存后是否能正确加载
    console.log('💾 保存记录后验证:', {
      savedCount: updatedAllRecords.length,
      newRecord: newRecord,
      currentRecordsCount: updatedSavedRecords.length
    });

    try {
      // 只保存体验记录到本地和云端（不关联打卡记录）
      const saveResult = await this.saveExperienceRecord(newRecord);
      
      if (saveResult.success) {
        console.log('✅ 体验记录保存成功:', saveResult);
        console.log('🔍 检查saveResult数据结构:', {
          hasData: !!saveResult.data,
          dataKeys: saveResult.data ? Object.keys(saveResult.data) : '无data',
          hasRecordId: saveResult.data ? !!saveResult.data.recordId : false,
          recordId: saveResult.data ? saveResult.data.recordId : '无'
        });
        
        // 保存体验记录的云端ID到本地，用于后续打卡时关联
        if (saveResult.data && saveResult.data.recordId) {
          const localRecords = wx.getStorageSync('experienceRecordIds') || {};
          localRecords[newRecord.uniqueId] = saveResult.data.recordId;
          wx.setStorageSync('experienceRecordIds', localRecords);
          console.log('💾 保存体验记录关联ID:', newRecord.uniqueId, '->', saveResult.data.recordId);
        } else {
          console.warn('⚠️ 体验记录保存成功，但缺少recordId，无法建立关联');
        }
        
        wx.showToast({
          title: '保存成功',
          icon: 'success',
          duration: 2000
        });
      } else {
        console.warn('⚠️ 体验记录保存失败:', saveResult.error);
        wx.showToast({
          title: '保存失败',
          icon: 'error',
          duration: 2000
        });
      }
      
      // 无论成功或失败，都检查当前本地存储的状态
      const currentLocalRecords = wx.getStorageSync('experienceRecordIds') || {};
      console.log('📊 当前本地存储的体验记录ID映射状态:', {
        totalMappings: Object.keys(currentLocalRecords).length,
        mappings: currentLocalRecords
      });
    } catch (error) {
      console.error('❌ 保存过程出错:', error);
      wx.showToast({
        title: '保存异常',
        icon: 'error',
        duration: 2000
      });
    }
  },

  // 加载已保存的记录（仅显示当天记录）
  loadSavedRecords: function() {
    try {
      const allRecords = wx.getStorageSync('meditationTextRecords') || [];
      
      // 获取当天日期（YYYY-MM-DD格式）
      const today = new Date();
      const todayDate = today.toISOString().split('T')[0];
      
      console.log('🔍 加载记录调试:', {
        totalRecords: allRecords.length,
        todayDate: todayDate,
        allRecords: allRecords.map(r => ({ 
          timestamp: r.timestamp, 
          date: r.timestamp.split(' ')[0] 
        }))
      });
      
      // 过滤出当天的记录
      const todayRecords = allRecords.filter(record => {
        // 从时间戳中提取日期部分
        const recordDate = record.timestamp.split(' ')[0];
        const isToday = recordDate === todayDate;
        console.log(`记录过滤: ${record.timestamp} -> ${recordDate} === ${todayDate} ? ${isToday}`);
        return isToday;
      });
      
      this.setData({
        savedRecords: todayRecords
      });
      
      console.log(`✅ 加载当天(${todayDate})记录: ${todayRecords.length}条`);
      
    } catch (error) {
      console.error('❌ 加载记录失败:', error);
    }
  },

  // 保存记录到本地存储
  saveRecordsToStorage: function(records) {
    try {
      wx.setStorageSync('meditationTextRecords', records);
      console.log('💾 本地存储保存成功，记录数:', records.length);
    } catch (error) {
      console.error('❌ 保存记录失败:', error);
      wx.showToast({
        title: '保存失败',
        icon: 'error',
        duration: 2000
      });
    }
  },

  // 删除记录（同步云存储和本地存储，无需确认）
  async deleteRecord(e) {
    const index = e.currentTarget.dataset.index;
    const record = this.data.savedRecords[index];
    
    try {
      // 删除本地显示记录
      const records = [...this.data.savedRecords];
      const deletedRecord = records.splice(index, 1)[0];
      
      this.setData({
        savedRecords: records
      });
      
      // 同步删除云存储和本地存储的记录
      const deleteResult = await this.syncDeleteRecord(deletedRecord);
      
      if (deleteResult.success) {
        wx.showToast({
          title: '删除成功',
          icon: 'success',
          duration: 2000
        });
      } else {
        wx.showToast({
          title: '删除失败',
          icon: 'error',
          duration: 2000
        });
      }
    } catch (error) {
      console.error('删除记录过程中出错:', error);
      wx.showToast({
        title: '删除异常',
        icon: 'error',
        duration: 2000
      });
    }
  },

  // 同步删除云存储和本地存储的记录
  async syncDeleteRecord(record) {
    console.log('开始同步删除记录:', record);
    
    // 获取日期
    const dateStr = record.timestamp.split(' ')[0];
    
    // 使用uniqueId或时间戳作为唯一标识
    const recordId = record.uniqueId || new Date(record.timestamp).getTime().toString();
    
    try {
      // 调用checkinManager的体验记录删除功能
      const result = await checkinManager.deleteExperienceRecord(recordId, dateStr);
      
      if (result.success) {
        // 删除成功后，完整清理所有相关的本地存储数据
        
        // 1. 清理体验记录文本
        const allRecords = wx.getStorageSync('meditationTextRecords') || [];
        const updatedAllRecords = allRecords.filter(r => {
          const rId = r.uniqueId || new Date(r.timestamp).getTime().toString();
          return rId !== recordId;
        });
        this.saveRecordsToStorage(updatedAllRecords);
        
        // 2. 清理体验记录ID映射
        const experienceRecordIds = wx.getStorageSync('experienceRecordIds') || {};
        if (experienceRecordIds[record.uniqueId]) {
          delete experienceRecordIds[record.uniqueId];
          wx.setStorageSync('experienceRecordIds', experienceRecordIds);
          console.log(`🗑️ 清理体验记录ID映射: ${record.uniqueId}`);
        }
        
        // 3. 清理用户记录中的关联信息
        const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
        if (allUserRecords[this.data.userOpenId]) {
          const userRecords = allUserRecords[this.data.userOpenId];
          if (userRecords.dailyRecords && userRecords.dailyRecords[dateStr]) {
            // 更新文本记录数量
            const todayRecord = userRecords.dailyRecords[dateStr];
            if (todayRecord.textRecords && todayRecord.textRecords > 0) {
              todayRecord.textRecords = Math.max(0, todayRecord.textRecords - 1);
              allUserRecords[this.data.userOpenId] = userRecords;
              wx.setStorageSync('meditationUserRecords', allUserRecords);
              console.log(`📊 更新用户记录文本数量: ${todayRecord.textRecords}`);
            }
          }
        }
        
        console.log('✅ 同步删除成功，所有本地存储数据已清理');
        return {
          success: true,
          message: '删除成功'
        };
      } else {
        console.error('❌ 删除失败:', result.error);
        return {
          success: false,
          error: result.error
        };
      }
    } catch (error) {
      console.error('❌ 删除过程中出错:', error);
      return {
        success: false,
        error: '删除过程异常'
      };
    }
  },

  // 保存体验记录到云端（不记录打卡）
  async saveExperienceRecord(record) {
    console.log('开始保存体验记录到云端:', record);
    
    try {
      // 调用云函数保存体验记录
      const result = await cloudApi.saveExperienceRecord(record);
      
      if (result.success) {
        console.log('✅ 体验记录云端保存成功:', result);
        return {
          success: true,
          message: '体验记录保存成功',
          data: result.data
        };
      } else {
        console.warn('⚠️ 体验记录云端保存失败，仅保存到本地:', result.error);
        // 云存储失败，仍然返回成功，因为本地已保存
        return {
          success: true,
          message: '体验记录本地保存成功'
        };
      }
      
    } catch (error) {
      console.error('保存体验记录失败:', error);
      // 异常情况下，仍然返回成功，因为本地已保存
      return {
        success: true,
        message: '体验记录本地保存成功'
      };
    }
  },

  // 获取用户openId
  getUserOpenId: function() {
    // 先尝试获取微信openid，如果失败则使用本地ID
    try {
      // 检查用户是否已登录
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo && userInfo.openid) {
        this.setData({
          userOpenId: userInfo.openid
        });
        return;
      }
    } catch (error) {
      console.log('获取用户信息失败:', error);
    }
    
    // 降级到本地生成的唯一ID作为用户标识
    const localUserId = wx.getStorageSync('localUserId');
    if (!localUserId) {
      const newLocalUserId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      wx.setStorageSync('localUserId', newLocalUserId);
      this.setData({
        userOpenId: newLocalUserId
      });
    } else {
      this.setData({
        userOpenId: localUserId
      });
    }
  },

  // 打卡完成 - 记录用户打卡次数和评分记录
  async completeCheckIn() {
    if (!this.data.userOpenId) {
      // 如果没有用户ID，先获取
      this.getUserOpenId();
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
    
    try {
      // 1. 记录云存储打卡（仅在用户点击打卡按钮时调用）
      const duration = parseInt(this.data.duration) || 7;
      const rating = this.data.selectedRating || 0;
      
      // 获取已保存的体验记录ID（如果有的话）
      let experienceRecordIds = [];
      if (this.data.savedRecords.length > 0) {
        const localRecords = wx.getStorageSync('experienceRecordIds') || {};
        console.log('🔍 检查本地存储的体验记录ID映射:', localRecords);
        console.log('🔍 当前保存的体验记录:', this.data.savedRecords.map(r => ({ uniqueId: r.uniqueId, text: r.text })));
        
        this.data.savedRecords.forEach(record => {
          const experienceId = localRecords[record.uniqueId];
          if (experienceId) {
            experienceRecordIds.push(experienceId);
            console.log(`✅ 找到体验记录关联: ${record.uniqueId} -> ${experienceId}`);
          } else {
            console.log(`❌ 未找到体验记录ID映射: ${record.uniqueId}`);
            console.log(`   本地存储中是否存在该映射: ${localRecords.hasOwnProperty(record.uniqueId)}`);
          }
        });
        console.log('📝 关联体验记录ID列表:', experienceRecordIds);
      }
      
      console.log('📡 开始云存储打卡:', { duration, rating, experienceRecordIds });
      
      // experience字段现在存储体验记录ID数组，而不是单个ID
      const cloudResult = await cloudApi.recordMeditation(duration, rating, experienceRecordIds);
      
      console.log('📡 云存储返回结果:', cloudResult);
      
      if (cloudResult.success) {
        console.log('✅ 云存储打卡记录成功，记录ID:', cloudResult.data.recordId);
      } else {
        console.error('❌ 云存储打卡失败:', cloudResult.error);
        // 如果云存储失败，显示错误提示但继续本地存储
        wx.showToast({
          title: '云存储失败，已保存到本地',
          icon: 'none',
          duration: 2000
        });
      }
    } catch (error) {
      console.error('❌ 打卡过程出错:', error);
      wx.showToast({
        title: '打卡异常',
        icon: 'error',
        duration: 2000
      });
    }
    
    // 2. 本地存储记录（兼容原有逻辑）
    // 获取所有用户的打卡记录
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    
    // 获取当前用户的打卡记录
    const userRecords = allUserRecords[this.data.userOpenId] || {
      totalCount: 0,
      dailyRecords: {}
    };
    
    // 更新今日打卡次数
    const todayRecord = userRecords.dailyRecords[dateStr] || {
      count: 0,
      lastTimestamp: 0,
      durations: [],
      ratings: []
    };
    
    todayRecord.count += 1;
    todayRecord.lastTimestamp = today.getTime();
    todayRecord.durations.push(this.data.duration || '7');
    
    // 保存评分记录
    if (this.data.selectedRating > 0) {
      todayRecord.ratings.push({
        rating: this.data.selectedRating,
        timestamp: today.getTime()
      });
    }
    
    // 保存文本记录数量
    todayRecord.textRecords = this.data.savedRecords.length;
    
    // 更新用户记录
    userRecords.dailyRecords[dateStr] = todayRecord;
    userRecords.totalCount += 1;
    
    // 更新所有用户记录
    allUserRecords[this.data.userOpenId] = userRecords;
    wx.setStorageSync('meditationUserRecords', allUserRecords);
    
    // 保存评分记录到单独的存储（兼容原有逻辑）
    if (this.data.selectedRating > 0) {
      const records = wx.getStorageSync('meditationRecords') || {};
      records[dateStr] = {
        rating: this.data.selectedRating,
        duration: this.data.durationText || '7分钟',
        timestamp: today.getTime(),
        textRecords: this.data.savedRecords.length,
        userOpenId: this.data.userOpenId
      };
      wx.setStorageSync('meditationRecords', records);
    }
    
    wx.showToast({
      title: `打卡成功！今日第${todayRecord.count}次打卡`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟跳转到daily页面
    setTimeout(() => {
      wx.navigateTo({
        url: '/pages/daily/daily'
      });
    }, 1500);
  },

  // 重写页面返回逻辑
  onUnload() {
    // 页面返回时跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  // 自定义返回按钮点击事件
  onBack() {
    // 直接跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  onShareAppMessage() {
    return {};
  },
});