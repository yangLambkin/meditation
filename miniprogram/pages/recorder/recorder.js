// 引入云存储API
const checkinManager = require('../../utils/checkin.js');
const cloudApi = require('../../utils/cloudApi.js');
const dateUtil = require('../../utils/dateUtil.js');
const contentSec = require('../../utils/contentSec.js');

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
    userOpenId: '',
    duration: '7'
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
    console.log('📱 recorder页面显示');
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

  // 打卡完成 - 记录用户打卡次数，有感受时一并保存体验记录
  async completeCheckIn() {
    if (!this.data.userOpenId) {
      // 如果没有用户ID，先获取
      this.getUserOpenId();
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;

    // 1. 若填写了感受，先保存体验记录，再随打卡一起关联
    const experience = [];
    const experienceText = this.data.currentText.trim();
    if (experienceText) {
      // 🔍 经验笔记发布前内容安全检测（评论场景 scene=2），
      // 命中违规：提示已由 contentSec 弹出「所发布内容含违规信息」，阻止本次提交，要求修改后重试
      const textSafe = await contentSec.checkText(experienceText, 2);
      if (!textSafe) {
        return;
      }

      // 生成本地时间戳（YYYY-MM-DD HH:MM:SS）
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const hours = String(today.getHours()).padStart(2, '0');
      const minutes = String(today.getMinutes()).padStart(2, '0');
      const seconds = String(today.getSeconds()).padStart(2, '0');
      const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

      // 构建体验记录（字段与原有保存逻辑一致）
      const newRecord = {
        text: experienceText,
        timestamp: timestamp,
        emotion: this.getSelectedEmotions(),
        duration: this.data.durationText || '7分钟',
        uniqueId: today.getTime().toString()
      };

      // 写入本地 meditationTextRecords（history 页兼容读取）
      const allRecords = wx.getStorageSync('meditationTextRecords') || [];
      this.saveRecordsToStorage([newRecord, ...allRecords]);

      // 保存体验记录到云端（失败不阻断打卡，降级仅存本地）
      try {
        const saveResult = await this.saveExperienceRecord(newRecord);
        if (saveResult.success && saveResult.data && saveResult.data.recordId) {
          const localRecords = wx.getStorageSync('experienceRecordIds') || {};
          localRecords[newRecord.uniqueId] = saveResult.data.recordId;
          wx.setStorageSync('experienceRecordIds', localRecords);
          console.log('💾 保存体验记录关联ID:', newRecord.uniqueId, '->', saveResult.data.recordId);
        }
      } catch (err) {
        console.warn('⚠️ 体验记录保存异常，继续打卡:', err);
      }

      experience.push(newRecord);
      // 清空输入框
      this.setData({ currentText: '', currentTextLength: 0 });
    }

    // 2. 本地存储记录（使用统一的checkinManager接口）
    try {
      const localResult = checkinManager.recordCheckin(
        parseInt(this.data.duration) || 7, // 时长（分钟）
        this.getSelectedEmotions(),        // 情绪
        experience                        // 体验记录（数组）
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

    // 保存情绪记录到单独的存储（兼容原有逻辑）
    const selectedEmotions = this.getSelectedEmotions();
    if (selectedEmotions.length > 0) {
      const records = wx.getStorageSync('meditationRecords') || {};
      records[dateStr] = {
        emotion: selectedEmotions,
        duration: this.data.durationText || '7分钟',
        timestamp: today.getTime(),
        textRecords: experience.length,
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