// 引入云存储API
const checkinManager = require('../../utils/checkin.js');
const cloudApi = require('../../utils/cloudApi.js');
const dateUtil = require('../../utils/dateUtil.js');

Page({
  data: {
    // 情绪选择器数据
    currentEmotion: '不悲不喜',
    sliderPosition: 325,
    currentSubEmotions: [
      { name: '满足', selected: false },
      { name: '平静', selected: false },
      { name: '感恩', selected: false },
      { name: '中立', selected: false },
      { name: '无感', selected: false },
    ],
    emotionMap: [
      { name: '非常不愉快', sub: ['愤怒','害怕','不堪重负', '绝望', '崩溃', '痛苦','厌恶','有压力','精疲力尽'], position: 0 },
      { name: '不愉快', sub: ['烦躁', '挫败', '沮丧', '失望','嫉妒','忧虑','内疚','羞愧','伤心'], position: 85 },
      { name: '有点不愉快', sub: ['焦虑', '不安', '担忧', '紧张','孤独','冷漠'], position: 160 },
      { name: '不悲不喜', sub: ['满足', '平静', '感恩','中立', '无感'], position: 325},
      { name: '有点愉快', sub: ['平静', '满足', '放松', '舒适'], position: 410 },
      { name: '愉快', sub: ['愉悦', '开心', '感恩', '欣慰'], position: 490 },
      { name: '非常愉快', sub: ['喜悦', '幸福', '激动', '狂喜'], position: 600 }
    ],
    isSliding: false,
    startTouchX: 0, // 记录触摸开始位置
    startSliderPosition: 325, // 记录触摸开始时的滑块位置
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

  // 情绪选择器滑动条触摸开始
  handleSliderStart: function(e) {
    const touch = e.touches[0];
    
    // 获取轨道元素的位置，更精确
    const query = wx.createSelectorQuery();
    query.select('.section_3').boundingClientRect();
    query.exec((res) => {
      if (res && res[0]) {
        const trackRect = res[0];
        
        // 获取屏幕宽度，计算rpx与px的换算关系
        const screenWidth = wx.getSystemInfoSync().screenWidth;
        const rpxRatio = 750 / screenWidth; // 750rpx = 屏幕宽度px
        
        console.log('🔍 单位换算信息:', {
          screenWidth: screenWidth,
          rpxRatio: rpxRatio,
          trackWidthPx: trackRect.width,
          trackWidthRpx: trackRect.width * rpxRatio
        });
        
        // 计算轨道的实际rpx宽度
        const trackWidthRpx = trackRect.width * rpxRatio;
        
        this.setData({
          isSliding: true,
          trackLeft: trackRect.left, // px单位
          trackWidth: trackRect.width, // px单位
          trackWidthRpx: trackWidthRpx, // 轨道实际rpx宽度
          rpxRatio: rpxRatio // rpx与px的换算比例
        });
      }
    });
  },

  // 情绪选择器滑动条触摸移动
  handleSliderMove: function(e) {
    if (!this.data.isSliding || !this.data.trackLeft) return;
    
    const touch = e.touches[0];
    // 使用记录的轨道位置计算相对位置（px单位）
    const relativeXPx = touch.clientX - this.data.trackLeft;
    
    // 转换为rpx单位
    const relativeXRpx = relativeXPx * this.data.rpxRatio;
    
    // 使用轨道的实际rpx宽度进行限制（考虑滑块thumb的宽度）
    const trackWidthRpx = this.data.trackWidthRpx || 358;
    const thumbWidthRpx = 50; // 滑块thumb的宽度
    const maxSliderPosition = trackWidthRpx - thumbWidthRpx; // 确保滑块thumb不超出轨道
    const clampedPosition = Math.max(0, Math.min(relativeXRpx, maxSliderPosition));
    
    console.log('🔍 滑动位置计算:', {
      touchX: touch.clientX,
      relativeXPx: relativeXPx,
      relativeXRpx: relativeXRpx,
      sliderPosition: clampedPosition,
      maxPosition: trackWidthRpx
    });
    

    
    // 更新滑块位置和情绪
    this.setData({
      sliderPosition: clampedPosition
    });
    
    this.updateEmotion(clampedPosition);
  },

  // 情绪选择器滑动条触摸结束
  handleSliderEnd: function(e) {
    this.setData({
      isSliding: false
    });
  },

  // 更新情绪显示
  updateEmotion: function(position) {
    const emotionMap = this.data.emotionMap;
    let currentEmotion = emotionMap[3]; // 默认中间位置
    
    // 找到最近的预设位置（增加吸附范围，提高滑动体验）
    for (let i = 0; i < emotionMap.length; i++) {
      if (Math.abs(position - emotionMap[i].position) < 60) {
        currentEmotion = emotionMap[i];
        break;
      }
    }
    
    // 更新子情绪列表
    const subEmotions = currentEmotion.sub.map(name => ({
      name: name,
      selected: false
    }));
    
    this.setData({
      currentEmotion: currentEmotion.name,
      currentSubEmotions: subEmotions
    });
  },

  // 切换子情绪选择
  toggleSubEmotion: function(e) {
    const index = e.currentTarget.dataset.index;
    const subEmotions = this.data.currentSubEmotions.map((item, i) => ({
      ...item,
      selected: i === index ? !item.selected : item.selected
    }));
    
    this.setData({
      currentSubEmotions: subEmotions
    });
  },

  // 获取选中的情绪数组
  getSelectedEmotions: function() {
    const selectedSubEmotions = this.data.currentSubEmotions
      .filter(item => item.selected)
      .map(item => item.name);
    
    // 如果没有选择子情绪，返回主情绪
    if (selectedSubEmotions.length === 0) {
      return [this.data.currentEmotion];
    }
    
    return selectedSubEmotions;
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

    // 生成时间戳（使用本地时间格式：YYYY-MM-DD HH:MM:SS）
    const now = new Date();
    // 获取本地时间字符串，格式化为YYYY-MM-DD HH:MM:SS
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    // 创建新记录（包含唯一时间戳和会话标识）
    const nowTime = now.getTime();
    const newRecord = {
      text: experienceText,
      timestamp: timestamp,
      rating: this.getSelectedEmotions(),
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
      const todayDate = dateUtil.getBusinessDate(today);
      
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
      
      // 无论云端是否成功，都保存到本地缓存
      if (result.success) {
        // 成功保存到云端，同时保存到本地缓存
        checkinManager.saveExperienceRecordToLocal(record.uniqueId, {
          _id: result.data.recordId, // 云端返回的ID
          text: record.text || ''
        });
        
        console.log('✅ 体验记录云端保存成功，并已同步到本地:', result);
        return {
          success: true,
          message: '体验记录保存成功',
          data: result.data
        };
      } else {
        console.warn('⚠️ 体验记录云端保存失败，仅保存到本地:', result.error);
        // 云存储失败，仅保存到本地缓存
        checkinManager.saveExperienceRecordToLocal(record.uniqueId, {
          text: record.text || ''
        });
        
        return {
          success: true,
          message: '体验记录本地保存成功'
        };
      }
      
    } catch (error) {
      console.error('保存体验记录失败:', error);
      // 异常情况下，仅保存到本地缓存
      checkinManager.saveExperienceRecordToLocal(record.uniqueId, {
        text: record.text || ''
      });
      
      return {
        success: true,
        message: '体验记录本地保存成功'
      };
    }
  },

  // 获取用户openId
  getUserOpenId: function() {
    // 先尝试获取微信openid
    try {
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo && userInfo.openid) {
        const openid = userInfo.openid;
        this.setData({
          userOpenId: openid
        });
        
        // 如果是已登录用户，检查本地是否有未迁移的数据
        this.checkLocalDataMigration(openid);
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
  
  /**
   * 检查本地数据迁移
   */
  checkLocalDataMigration: function(openid) {
    const localUserId = wx.getStorageSync('localUserId');
    
    if (!localUserId) {
      return;
    }
    
    // 检查本地是否有未迁移的数据
    const allUserRecords = wx.getStorageSync('meditationUserRecords') || {};
    const localRecords = allUserRecords[localUserId];
    
    if (localRecords && localRecords.dailyRecords && !localRecords.migrated) {
      console.log(`检测到未迁移的本地数据: ${Object.keys(localRecords.dailyRecords).length}天`);
      
      // 可以在适当时候提示用户进行数据迁移
      // 例如在用户完成打卡后或特定时机
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
      const rating = this.getSelectedEmotions();
      
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
      
      console.log('✅ 跳过冗余的云端保存，避免重复保存体验记录');
    } catch (error) {
      console.error('❌ 打卡过程出错:', error);
      wx.showToast({
        title: '打卡异常',
        icon: 'error',
        duration: 2000
      });
    }
    
    // 2. 本地存储记录（使用统一的checkinManager接口）
    try {
      // 使用checkinManager来记录本地打卡
      const localResult = checkinManager.recordCheckin(
        parseInt(this.data.duration) || 7, // 时长（分钟）
        this.getSelectedEmotions(),        // 情绪评分
        this.data.savedRecords             // 体验记录
      );
      
      console.log('✅ 本地打卡记录成功:', localResult);
    } catch (error) {
      console.error('❌ 本地打卡记录失败:', error);
      // 即使本地记录失败，也不影响用户体验
      wx.showToast({
        title: '本地记录异常，云端已保存',
        icon: 'none',
        duration: 1500
      });
    }
    
    // 保存评分记录到单独的存储（兼容原有逻辑）
    const selectedEmotions = this.getSelectedEmotions();
    if (selectedEmotions.length > 0) {
      const records = wx.getStorageSync('meditationRecords') || {};
      records[dateStr] = {
        rating: selectedEmotions,
        duration: this.data.durationText || '7分钟',
        timestamp: today.getTime(),
        textRecords: this.data.savedRecords.length,
        userOpenId: this.data.userOpenId
      };
      wx.setStorageSync('meditationRecords', records);
    }
    
    // 获取今日打卡次数用于显示
    const todayStr = dateUtil.getBusinessDate(today);
    const todayCheckinCount = checkinManager.getDailyCheckinCountSync(todayStr);
    
    wx.showToast({
      title: `打卡成功！今日第${todayCheckinCount}次打卡`,
      icon: 'success',
      duration: 2000
    });
    
    // 延迟跳转到daily1页面
    setTimeout(() => {
      wx.navigateTo({
        url: '/pages/daily/daily1'
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