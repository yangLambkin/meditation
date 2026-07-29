// pages/history/history.js
const checkinManager = require('../../utils/checkin.js');
const lunarUtil = require('../../utils/lunar.js');
const dateUtil = require('../../utils/dateUtil.js');

Page({
  data: {
    selectedDate: '', // 选择的日期
    recordList: [],   // 打卡记录列表
    recordCount: 0,   // 打卡次数
    totalDuration: 0, // 合计时长（分钟）
    year: '',         // 年
    month: '',        // 月
    day: '',          // 日
    lunarDate: ''     // 农历日期
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // 从URL参数获取日期
    const date = options.date || '';
    
    if (date) {
      // 解析日期参数，分别设置年、月、日
      const [year, month, day] = date.split('-');
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      
      // 计算农历日期
      const solarDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      const lunarDate = lunarUtil.getLunarDate(solarDate);
      
      // 格式化日期显示：YYYY-MM-DD → YYYY年MM月DD日
      const formattedDate = this.formatDateForDisplay(date);
      this.setData({
        selectedDate: formattedDate,
        year: year,
        month: monthNames[parseInt(month) - 1],
        day: day,
        lunarDate: lunarDate
      });
      
      // 加载该日期的打卡记录
      this.loadHistoryRecords(date);
    } else {
      // 如果没有日期参数，默认显示今天
      const today = dateUtil.getBusinessDate();
      const [year, month, day] = today.split('-');
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      const solarDate = new Date();
      const lunarDate = lunarUtil.getLunarDate(solarDate);
      const formattedToday = this.formatDateForDisplay(today);
      this.setData({
        selectedDate: formattedToday,
        year: year,
        month: monthNames[parseInt(month) - 1],
        day: day,
        lunarDate: lunarDate
      });
      this.loadHistoryRecords(today);
    }
  },

  /**
   * 加载历史记录数据（支持云存储）
   */
  async loadHistoryRecords(dateStr) {
    try {
      // 获取该日期的打卡次数（异步）
      const checkinCount = await checkinManager.getDailyCheckinCount(dateStr);
      
      // 获取该日期的详细打卡记录（异步）
      const dailyRecords = await checkinManager.getDailyCheckinRecords(dateStr);
      
      if (checkinCount === 0) {
        console.warn('该日期暂无打卡记录');
        this.setData({
          recordList: [],
          recordCount: 0,
          totalDuration: 0
        });
        return;
      }

      // 格式化记录数据
      let formattedRecords = [];
      let totalDuration = 0;
      
      if (dailyRecords && dailyRecords.length > 0) {
        // 获取所有关联的体验记录
        const experienceRecords = [];
        console.log('🔍 分析每日记录中的experience字段:');
        dailyRecords.forEach((record, index) => {
          console.log(`  记录${index}: timestamp=${record.timestamp}, experience=`, record.experience, '类型:', typeof record.experience);
          
          if (record.experience && Array.isArray(record.experience)) {
            // 检查数组元素类型
            const firstElement = record.experience[0];
            console.log(`    -> 第一个元素类型:`, typeof firstElement, '内容:', firstElement);
            
            if (typeof firstElement === 'string') {
              // 如果是字符串ID数组
              const validIds = record.experience.filter(id => id && id.length > 0);
              console.log(`    -> 字符串ID数量: ${validIds.length}`, validIds);
              experienceRecords.push(...validIds.map(id => ({ type: 'id', value: id })));
            } else if (typeof firstElement === 'object' && firstElement !== null) {
              // 如果是对象数组（直接包含体验内容）
              console.log(`    -> 对象数组数量: ${record.experience.length}`, record.experience);
              experienceRecords.push(...record.experience.map(exp => ({ type: 'object', value: exp })));
            }
          } else if (record.experience && typeof record.experience === 'string') {
            // 兼容旧数据：单个ID的情况
            console.log(`    -> 字符串ID: ${record.experience}`);
            experienceRecords.push({ type: 'id', value: record.experience });
          } else {
            console.log(`    -> 无体验记录字段或字段为空`);
          }
        });
        console.log(`📝 总计收集到 ${experienceRecords.length} 个体验记录`);
        
        let experienceRecordsMap = new Map();
        
        if (experienceRecords.length > 0) {
          console.log(`开始处理 ${experienceRecords.length} 个体验记录`);
          
          // 分别处理不同类型
          const idRecords = experienceRecords.filter(r => r.type === 'id');
          const objectRecords = experienceRecords.filter(r => r.type === 'object');
          
          console.log(`  - 字符串ID类型: ${idRecords.length} 个`);
          console.log(`  - 对象类型: ${objectRecords.length} 个`);
          
          // 处理字符串ID类型：从本地缓存获取
          if (idRecords.length > 0) {
            const uniqueIds = [...new Set(idRecords.map(r => r.value))];
            console.log(`  开始查询字符串ID体验记录，共 ${uniqueIds.length} 个唯一ID:`, uniqueIds);
            
            const cachedRecords = this.getExperienceRecordsFromLocal(uniqueIds);
            console.log(`  本地缓存查询完成，共 ${cachedRecords.length} 条有效记录`);
            
            cachedRecords.forEach(exp => {
              const key = exp._id || exp.timestamp;
              console.log(`    缓存记录: key=${key}, text=${exp.text ? exp.text.substring(0, 20) + '...' : '空'}`);
              experienceRecordsMap.set(key, exp);
            });
          }
          
          // 处理对象类型：直接使用对象内容
          if (objectRecords.length > 0) {
            objectRecords.forEach((recordObj, index) => {
              const exp = recordObj.value;
              const key = exp._id || exp.timestamp || `obj_${index}`;
              console.log(`    对象记录: key=${key}, text=${exp.text ? exp.text.substring(0, 20) + '...' : '空'}`);
              experienceRecordsMap.set(key, exp);
            });
          }
          
          console.log(`体验记录映射构建完成，共 ${experienceRecordsMap.size} 条记录`);
        } else {
          console.log('⚠️ 没有找到任何体验记录');
        }
        
        formattedRecords = dailyRecords.map((record, index) => {
          // 格式化完整时间: YYYY-MM-DD HH:MM:SS
          const time = new Date(record.timestamp);
          const timeStr = `${time.getFullYear()}-${(time.getMonth() + 1).toString().padStart(2, '0')}-${time.getDate().toString().padStart(2, '0')} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
          
          // 创建星星数据
          const stars = Array.from({ length: 5 }, (_, i) => ({
            active: i < (record.rating || 0)
          }));
          
          // 处理体验记录 - 支持多种数据格式
          let experienceTexts = [];
          let hasExperience = false;
          
          if (record.experience) {
            if (Array.isArray(record.experience)) {
              // 检查数组元素类型
              if (record.experience.length > 0) {
                const firstElement = record.experience[0];
                
                if (typeof firstElement === 'string') {
                  // 字符串ID数组：通过映射查找
                  record.experience.forEach(expId => {
                    if (expId && experienceRecordsMap.has(expId)) {
                      const expRecord = experienceRecordsMap.get(expId);
                      if (expRecord.text) {
                        experienceTexts.push(expRecord.text);
                        hasExperience = true;
                      }
                    }
                  });
                } else if (typeof firstElement === 'object' && firstElement !== null) {
                  // 对象数组：直接提取文本内容
                  record.experience.forEach(expObj => {
                    if (expObj && expObj.text) {
                      experienceTexts.push(expObj.text);
                      hasExperience = true;
                    }
                  });
                }
              }
            } else if (typeof record.experience === 'string') {
              // 兼容旧数据：单个ID的情况
              if (experienceRecordsMap.has(record.experience)) {
                const expRecord = experienceRecordsMap.get(record.experience);
                if (expRecord.text) {
                  experienceTexts.push(expRecord.text);
                  hasExperience = true;
                }
              }
            }
          }
          
          // 如果没有体验记录，添加默认提示
          if (experienceTexts.length === 0) {
            experienceTexts = ["未记录体验"];
          }
          
          return {
            time: timeStr,
            duration: record.duration || 0,
            rating: record.rating || 0,
            stars: stars,
            experienceTexts: experienceTexts,
            hasExperience: hasExperience
          };
        });
        
        // 计算合计时长
        totalDuration = formattedRecords.reduce((total, record) => {
          return total + (record.duration || 0);
        }, 0);
      } else {
        // 如果有打卡次数但没有详细记录，设置默认值
        totalDuration = 0; // 如果没有详细记录，时长设为0
      }

      this.setData({
        recordList: formattedRecords,
        recordCount: checkinCount, // 使用打卡次数作为记录数
        totalDuration: totalDuration
      });

      console.log(`加载 ${dateStr} 的打卡记录成功，打卡次数: ${checkinCount}, 合计时长: ${totalDuration}分钟`);
      
    } catch (error) {
      console.error('加载历史记录失败:', error);
      this.setData({
        recordList: [],
        recordCount: 0,
        totalDuration: 0
      });
    }
  },

  /**
   * 格式化日期显示
   */
  formatDateForDisplay(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${year}年${month}月${day}日`;
  },

  /**
   * 返回上一页
   */
  goBack() {
    wx.navigateBack();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 页面显示时重新加载数据，确保数据最新
    if (this.data.year && this.data.day) {
      // 重新构建数据库需要的日期格式：YYYY-MM-DD
      const monthNum = this.getMonthNumber(this.data.month);
      const dateStr = `${this.data.year}-${monthNum.toString().padStart(2, '0')}-${this.data.day.padStart(2, '0')}`;
      console.log('onShow重新加载数据，日期:', dateStr);
      this.loadHistoryRecords(dateStr);
    }
  },

  /**
   * 根据月份名称获取月份数字
   */
  getMonthNumber(monthName) {
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
    const index = monthNames.indexOf(monthName);
    return index !== -1 ? index + 1 : new Date().getMonth() + 1;
  },

  /**
   * 从本地缓存获取体验记录（使用统一的checkin.js接口）
   */
  getExperienceRecordsFromLocal(uniqueIds) {
    try {
      // 使用checkin.js的统一接口获取体验记录
      const result = checkinManager.getExperienceRecordsFromLocal(uniqueIds);
      console.log(`✅ 从统一本地缓存获取体验记录: 请求${uniqueIds.length}个，找到${result.length}个`);
      
      // 如果没找到，说明数据可能不在统一的存储结构中
      if (result.length === 0 && uniqueIds.length > 0) {
        console.warn('⚠️ 统一存储中未找到对应体验记录，可能还在旧存储中');
        
        // 尝试从旧存储meditationTextRecords中获取（兼容性处理）
        const meditationTextRecords = wx.getStorageSync('meditationTextRecords') || [];
        console.log('📄 尝试从meditationTextRecords获取体验记录:', meditationTextRecords.length, '条');
        
        // 构建映射：uniqueId -> 体验记录
        const experienceRecordsMap = new Map();
        meditationTextRecords.forEach(record => {
          if (record.uniqueId) {
            experienceRecordsMap.set(record.uniqueId, {
              _id: record.uniqueId, // 使用uniqueId作为ID
              timestamp: record.uniqueId, // 时间戳
              text: record.text || '', // 体验文本
              rating: record.rating || 0, // 评分
              duration: record.duration || '0分钟' // 时长
            });
          }
        });
        
        // 根据请求的uniqueIds查找对应的体验记录
        const oldResult = [];
        uniqueIds.forEach(id => {
          if (experienceRecordsMap.has(id)) {
            oldResult.push(experienceRecordsMap.get(id));
          }
        });
        
        console.log(`✅ 从meditationTextRecords获取体验记录: 找到${oldResult.length}个`);
        
        if (oldResult.length > 0) {
          // 如果从旧存储找到记录，将其迁移到统一存储中
          console.log('🔄 将旧存储记录迁移到统一存储中');
          oldResult.forEach(record => {
            checkinManager.saveExperienceRecordToLocal(record._id, record);
          });
          return oldResult;
        }
      }
      
      return result;
    } catch (error) {
      console.error('从本地获取体验记录失败:', error);
      return [];
    }
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {
    return {
      title: `${this.data.selectedDate} 的静坐打卡记录`,
      path: `/pages/history/history?date=${this.data.selectedDate}`
    };
  }
});