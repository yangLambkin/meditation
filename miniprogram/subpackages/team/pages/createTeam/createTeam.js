const { getBusinessDate } = require('../../../../utils/dateUtil.js');
// pages/createTeam/createTeam.js
const teamManager = require('../../../../utils/teamManager.js');
const { uploadTeamIcon, isDataTeamIcon } = require('../../../../utils/teamGateway.js');
const contentSec = require('../../../../utils/contentSec.js');
const { PRACTICES } = require('../../../../utils/practicePreferences.js');

// 练习日按北京时间 02:00 切换，与全应用业务日期保持一致。
function currentPracticeDay() {
  return getBusinessDate(Date.now());
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function optionalRuleValue(value) {
  return value == null || (typeof value === 'string' && !value.trim()) ? null : value;
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 团队头像列表 - 只保留上传选项
    teamIcons: [
      { id: 1, path: '/subpackages/team/images/icons/upload.svg', selected: false, type: 'upload' },
    ],
    // 当前选中的团队头像
    selectedIcon: null,
    // 团队名称
    teamName: '',
    // 团队介绍
    teamDescription: '',
    practiceTypes: PRACTICES,
    practiceType: 'sitting',
    practiceTypeIndex: 0,
    additionalPractices: [],
    additionalPracticeOptions: PRACTICES.filter(item => item.type !== 'sitting'),
    practiceUnit: '分钟',
    maxDailyGoal: 1440,
    // 团队练习规则
    practiceRulesEnabled: false,
    practiceStartDate: '',
    maxPracticeStartDate: '',
    dailyGoalMinutes: '',
    dailyGoalPresets: [20, 30, 60],
    // 团队名称字符数
    nameCharCount: 0,
    // 团队介绍字符数
    descCharCount: 0,
    // 创建状态
    isCreating: false,
    isChoosingIcon: false,
    hasCreatedTeam: false,
    // 用户信息
    userNickname: '匿名用户',
    hasUserInfo: false,
    // 成功弹窗相关
    showSuccessModal: false,
    teamNameForModal: '',
    teamDescriptionForModal: '',
    teamIconForModal: '',
    customIconPath: ''
  },

  /**
   * 选择团队头像
   */
  selectTeamIcon() {
    this.chooseImageFromAlbum();
  },

  getLoggedInOpenId() {
    const openid = wx.getStorageSync('userOpenId');
    return typeof openid === 'string' && openid.trim() && !/^(local|test)[_-]/.test(openid)
      ? openid : '';
  },

  /**
   * 从相册选择图片（使用微信官方API）
   */
  chooseImageFromAlbum() {
    if (this.data.isCreating || this.data.isChoosingIcon || this.data.hasCreatedTeam) return;
    const openid = this.getLoggedInOpenId();
    if (!openid) {
      wx.showToast({ title: '请先登录后再创建团队', icon: 'none' });
      return;
    }

    this.setData({ isChoosingIcon: true });
    const isCurrent = () => !this._unloaded && this.getLoggedInOpenId() === openid;
    const finish = () => {
      if (!this._unloaded) this.setData({ isChoosingIcon: false });
    };
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        if (!isCurrent()) { finish(); return; }
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: res.tapIndex === 0 ? ['camera'] : ['album'],
          camera: 'back',
          success: async (res) => {
            try {
              const tempFilePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
              if (!tempFilePath || !isCurrent()) return;
              // 内容审核复用现有服务；审核通过的同一份图片直传 data 保存。
              const iconFileID = await contentSec.checkImage(tempFilePath, {
                scene: 1,
                bizType: 'avatar',
                returnFileID: true,
                cloudPrefix: 'team_icons'
              });
              if (!iconFileID || !isCurrent()) return;
              if (typeof iconFileID !== 'string' || !iconFileID.startsWith('cloud://')) {
                throw new Error('图片上传失败，请重新选择');
              }
              const iconUrl = await uploadTeamIcon(iconFileID);
              if (!isCurrent()) return;
              if (!isDataTeamIcon(iconUrl)) throw new Error('图片上传失败，请重新选择');
              this.setData({
                teamIcons: this.data.teamIcons.map(icon => ({ ...icon, path: tempFilePath, selected: true })),
                selectedIcon: 1,
                customIconPath: iconUrl
              });
              wx.showToast({ title: '图片选择成功', icon: 'success' });
            } catch (error) {
              if (isCurrent()) {
                wx.showToast({ title: error.message || '图片选择失败，请重试', icon: 'none' });
              }
            } finally {
              finish();
            }
          },
          fail: (error) => {
            if (isCurrent() && !/cancel/i.test(error.errMsg || '')) {
              wx.showToast({ title: '选择图片失败', icon: 'none' });
            }
            finish();
          }
        });
      },
      fail: finish
    });
  },

  /**
   * 输入团队名称
   */
  onTeamNameInput: function(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    const value = e.detail.value;
    this.setData({
      teamName: value,
      nameCharCount: value.length
    });
  },

  /**
   * 输入团队介绍
   */
  onTeamDescriptionInput: function(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    const value = e.detail.value;
    this.setData({
      teamDescription: value,
      descCharCount: value.length
    });
  },

  onPracticeRulesChange(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ practiceRulesEnabled: e.detail.value === true });
  },

  onPracticeTypeChange(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || !PRACTICES[index]) return;
    const practice = PRACTICES[index];
    if (practice.type === this.data.practiceType) return;
    const isCount = practice.type === 'instant' || practice.type === 'kindness';
    this.setData({ practiceType: practice.type, practiceTypeIndex: index, practiceUnit: practice.unit,
      additionalPractices: this.data.additionalPractices.filter(item => item.practiceType !== practice.type),
      additionalPracticeOptions: PRACTICES.filter(item => item.type !== practice.type).map(item => ({ ...item, selected: this.data.additionalPractices.some(row => row.practiceType === item.type) })),
      maxDailyGoal: practice.type === 'instant' ? 1000000 : practice.type === 'kindness' ? 100000 : 1440,
      dailyGoalMinutes: '', dailyGoalPresets: isCount ? [1, 3, 10] : [20, 30, 60] });
  },

  toggleAdditionalPractice(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    const type = e.currentTarget.dataset.type;
    const config = PRACTICES.find(item => item.type === type);
    if (!config || type === this.data.practiceType) return;
    const rows = this.data.additionalPractices;
    const next = rows.some(item => item.practiceType === type) ? rows.filter(item => item.practiceType !== type)
      : [...rows, { practiceType: type, name: config.name, unit: config.unit, practiceStartDate: '', dailyGoalMinutes: '',
        maxGoal: type === 'instant' ? 1000000 : type === 'kindness' ? 100000 : 1440 }];
    this.setData({ additionalPractices: next, additionalPracticeOptions: PRACTICES.filter(item => item.type !== this.data.practiceType)
      .map(item => ({ ...item, selected: next.some(row => row.practiceType === item.type) })) });
  },

  changeAdditionalRule(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    const { type, field } = e.currentTarget.dataset;
    if (!['practiceStartDate', 'dailyGoalMinutes'].includes(field)) return;
    this.setData({ additionalPractices: this.data.additionalPractices.map(item => item.practiceType === type
      ? { ...item, [field]: e.detail.value } : item) });
  },

  clearAdditionalStartDate(e) {
    this.changeAdditionalRule({ currentTarget: { dataset: { type: e.currentTarget.dataset.type, field: 'practiceStartDate' } }, detail: { value: '' } });
  },

  onPracticeStartDateChange(e) {
    if (!this.data.practiceRulesEnabled || this.data.isCreating || this.data.hasCreatedTeam) return;
    const value = e.detail.value;
    const today = currentPracticeDay();
    this.setData({ maxPracticeStartDate: today });
    if (!isCalendarDate(value) || value > today) {
      wx.showToast({ title: '请选择不晚于当前练习日的有效日期', icon: 'none' });
      return;
    }
    this.setData({ practiceStartDate: value });
  },

  onDailyGoalInput(e) {
    if (!this.data.practiceRulesEnabled || this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ dailyGoalMinutes: e.detail.value });
  },

  clearPracticeStartDate() {
    if (!this.data.practiceRulesEnabled || this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ practiceStartDate: '' });
  },

  clearDailyGoal() {
    if (!this.data.practiceRulesEnabled || this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ dailyGoalMinutes: '' });
  },

  selectDailyGoal(e) {
    if (!this.data.practiceRulesEnabled || this.data.isCreating || this.data.hasCreatedTeam) return;
    const minutes = Number(e.currentTarget.dataset.minutes);
    if (this.data.dailyGoalPresets.includes(minutes)) this.setData({ dailyGoalMinutes: minutes });
  },

  /**
   * 创建团队
   */
  async createTeam() {
    if (this.data.isCreating || this._unloaded) return;
    if (this.data.hasCreatedTeam) {
      this.returnToTeamList();
      return;
    }
    const openid = this.getLoggedInOpenId();
    if (!openid) {
      wx.showToast({ title: '请先登录后再创建团队', icon: 'none' });
      return;
    }
    if (this.data.isChoosingIcon) {
      wx.showToast({ title: '请等待团队图标检测完成', icon: 'none' });
      return;
    }

    // 固定本次发布内容，审核与最终提交必须使用同一份数据。
    const practiceStartDate = this.data.practiceRulesEnabled ? optionalRuleValue(this.data.practiceStartDate) : null;
    const rawGoal = this.data.practiceRulesEnabled ? optionalRuleValue(this.data.dailyGoalMinutes) : null;
    const teamInfo = {
      name: this.data.teamName.trim(),
      description: this.data.teamDescription.trim(),
      icon: this.data.customIconPath,
      practiceType: this.data.practiceType,
      practiceStartDate,
      dailyGoalMinutes: rawGoal === null ? null : Number(rawGoal)
    };
    if (!PRACTICES.some(practice => practice.type === teamInfo.practiceType)) {
      wx.showToast({ title: '请选择有效的功课类型', icon: 'none' });
      return;
    }
    if (!isDataTeamIcon(teamInfo.icon)) {
      wx.showToast({ title: '请选择团队图标', icon: 'none' });
      return;
    }
    if (!teamInfo.name) {
      wx.showToast({ title: '请输入团队名称', icon: 'none' });
      return;
    }
    if (teamInfo.name.length > 20) {
      wx.showToast({ title: '团队名称不能超过20个字符', icon: 'none' });
      return;
    }
    if (teamInfo.description.length > 100) {
      wx.showToast({ title: '团队介绍不能超过100个字符', icon: 'none' });
      return;
    }

    const today = currentPracticeDay();
    this.setData({ maxPracticeStartDate: today });
    if (teamInfo.practiceStartDate !== null &&
        (!isCalendarDate(teamInfo.practiceStartDate) || teamInfo.practiceStartDate > today)) {
      wx.showToast({ title: '请选择不晚于当前练习日的有效日期', icon: 'none' });
      return;
    }
    const maxGoal = teamInfo.practiceType === 'instant' ? 1000000 : teamInfo.practiceType === 'kindness' ? 100000 : 1440;
    if (rawGoal !== null &&
        ((typeof rawGoal !== 'number' && (typeof rawGoal !== 'string' || !/^\d+$/.test(rawGoal.trim()))) ||
        !Number.isInteger(teamInfo.dailyGoalMinutes) || teamInfo.dailyGoalMinutes < 1 || teamInfo.dailyGoalMinutes > maxGoal)) {
      wx.showToast({ title: `每日目标须为1至${maxGoal}的整数`, icon: 'none' });
      return;
    }

    if (this.data.additionalPractices.length) {
      const practices = [{ practiceType: teamInfo.practiceType, practiceStartDate: teamInfo.practiceStartDate, dailyGoalMinutes: teamInfo.dailyGoalMinutes }];
      for (const item of this.data.additionalPractices) {
        const start = optionalRuleValue(item.practiceStartDate);
        const goal = optionalRuleValue(item.dailyGoalMinutes);
        const max = item.practiceType === 'instant' ? 1000000 : item.practiceType === 'kindness' ? 100000 : 1440;
        if (!PRACTICES.some(config => config.type === item.practiceType) || practices.some(row => row.practiceType === item.practiceType) ||
            start !== null && (!isCalendarDate(start) || start > today) ||
            goal !== null && (!/^\d+$/.test(String(goal)) || !Number.isSafeInteger(Number(goal)) || Number(goal) < 1 || Number(goal) > max)) {
          wx.showToast({ title: '请检查各项功课的起始日期和每日目标', icon: 'none' });
          return;
        }
        practices.push({ practiceType: item.practiceType, practiceStartDate: start, dailyGoalMinutes: goal === null ? null : Number(goal) });
      }
      teamInfo.practices = practices;
    }
    this.setData({ isCreating: true });
    try {
      if (!await contentSec.checkText(teamInfo.name, 2)) return;
      if (!await contentSec.checkText(teamInfo.description, 2)) return;
      if (this._unloaded) return;
      if (this.getLoggedInOpenId() !== openid) {
        throw new Error('登录状态已变化，请重新提交');
      }

      const result = await teamManager.createTeam(teamInfo);
      if (this._unloaded) return;
      if (!result || !result.success) {
        throw new Error(result && result.error || '创建团队失败');
      }
      // 成功后保持不可重复创建，即使返回列表失败也不重复发送创建请求。
      this.setData({ hasCreatedTeam: true });
      wx.showToast({ title: '团队创建成功！', icon: 'success', duration: 2000 });
      this.scheduleReturnToTeamList();
    } catch (error) {
      if (!this._unloaded) {
        wx.showToast({ title: error.message || '创建团队失败', icon: 'none', duration: 2000 });
      }
    } finally {
      if (!this._unloaded) this.setData({ isCreating: false });
    }
  },

  clearReturnTimer() {
    if (this._returnTimer) clearTimeout(this._returnTimer);
    this._returnTimer = null;
  },

  scheduleReturnToTeamList() {
    this.clearReturnTimer();
    if (this._unloaded || this._visible === false) return;
    this._returnTimer = setTimeout(() => this.returnToTeamList(), 2000);
  },

  returnToTeamList() {
    this.clearReturnTimer();
    if (this._unloaded || this._visible === false || this._returning) return;
    this._returning = true;
    wx.navigateBack({
      fail: () => {
        if (this._unloaded || this._visible === false) {
          this._returning = false;
          return;
        }
        wx.switchTab({
          url: '/pages/team/team',
          fail: () => { this._returning = false; }
        });
      }
    });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this._unloaded = false;
    this._visible = true;
    const today = currentPracticeDay();
    this.setData({ practiceRulesEnabled: false, practiceStartDate: '', maxPracticeStartDate: today, dailyGoalMinutes: '',
      practiceType: 'sitting', practiceTypeIndex: 0, additionalPractices: [], additionalPracticeOptions: PRACTICES.filter(item => item.type !== 'sitting'), practiceUnit: '分钟', maxDailyGoal: 1440, dailyGoalPresets: [20, 30, 60] });
    console.log('=== createTeam页面加载 ===');
    
    // 获取用户信息
    this.getUserInfo();
    
    // 检查团队图标路径
    if (this.data.teamIcons.length > 0) {
      console.log('团队图标数量:', this.data.teamIcons.length);
      console.log('第一个图标路径:', this.data.teamIcons[0].path);
    }
  },

  /**
   * 获取用户信息
   */
  getUserInfo() {
    try {
      // 尝试从缓存获取用户信息
      const userInfo = wx.getStorageSync('userInfo');
      const userNickname = wx.getStorageSync('userNickname');
      
      if (userInfo || userNickname) {
        const nickname = userNickname || (userInfo && userInfo.nickName) || '匿名用户';
        this.setData({
          userNickname: nickname,
          hasUserInfo: true
        });
        console.log('✅ 获取到用户信息:', nickname);
      } else {
        console.log('❌ 未获取到用户信息，使用默认值');
      }
    } catch (error) {
      console.error('获取用户信息失败:', error);
    }
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this._visible = true;
    this.setData({ maxPracticeStartDate: currentPracticeDay() });
    if (this.data.hasCreatedTeam) this.scheduleReturnToTeamList();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {
    this._visible = false;
    this.clearReturnTimer();
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    this._unloaded = true;
    this.clearReturnTimer();
  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  },

})
