// pages/createTeam/createTeam.js
const teamManager = require('../../../../utils/teamManager.js');
const contentSec = require('../../../../utils/contentSec.js');

// 北京时间减去凌晨 4 点分界，等价于 UTC 时间加 4 小时。
function currentPracticeDay() {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
      { id: 1, path: '/subpackages/team/images/icons/upload.png', selected: false, type: 'upload' },
    ],
    // 当前选中的团队头像
    selectedIcon: null,
    // 团队名称
    teamName: '',
    // 团队介绍
    teamDescription: '',
    // 团队练习规则
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
    if (!this.getLoggedInOpenId()) {
      wx.showToast({ title: '请先登录后再创建团队', icon: 'none' });
      return;
    }

    this.setData({ isChoosingIcon: true });
    const finish = () => {
      if (!this._unloaded) this.setData({ isChoosingIcon: false });
    };
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        if (this._unloaded) return;
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: res.tapIndex === 0 ? ['camera'] : ['album'],
          camera: 'back',
          success: async (res) => {
            try {
              const tempFilePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
              if (!tempFilePath || this._unloaded) return;
              // 保存审核通过的同一份云文件，避免重复上传或使用会失效的临时路径。
              const iconFileID = await contentSec.checkImage(tempFilePath, {
                scene: 1,
                bizType: 'avatar',
                returnFileID: true,
                cloudPrefix: 'team_icons'
              });
              if (!iconFileID || this._unloaded) return;
              if (typeof iconFileID !== 'string' || !iconFileID.startsWith('cloud://')) {
                throw new Error('图片上传失败，请重新选择');
              }
              this.setData({
                teamIcons: this.data.teamIcons.map(icon => ({ ...icon, path: tempFilePath, selected: true })),
                selectedIcon: 1,
                customIconPath: iconFileID
              });
              wx.showToast({ title: '图片选择成功', icon: 'success' });
            } catch (error) {
              if (!this._unloaded) {
                wx.showToast({ title: error.message || '图片选择失败，请重试', icon: 'none' });
              }
            } finally {
              finish();
            }
          },
          fail: (error) => {
            if (!this._unloaded && !/cancel/i.test(error.errMsg || '')) {
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

  onPracticeStartDateChange(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
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
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ dailyGoalMinutes: e.detail.value });
  },

  clearPracticeStartDate() {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ practiceStartDate: '' });
  },

  clearDailyGoal() {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
    this.setData({ dailyGoalMinutes: '' });
  },

  selectDailyGoal(e) {
    if (this.data.isCreating || this.data.hasCreatedTeam) return;
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
    const practiceStartDate = optionalRuleValue(this.data.practiceStartDate);
    const rawGoal = optionalRuleValue(this.data.dailyGoalMinutes);
    const teamInfo = {
      name: this.data.teamName.trim(),
      description: this.data.teamDescription.trim(),
      icon: this.data.customIconPath,
      practiceStartDate,
      dailyGoalMinutes: rawGoal === null ? null : Number(rawGoal)
    };
    if (typeof teamInfo.icon !== 'string' || !teamInfo.icon.startsWith('cloud://')) {
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
    if (rawGoal !== null &&
        ((typeof rawGoal !== 'number' && (typeof rawGoal !== 'string' || !/^\d+$/.test(rawGoal.trim()))) ||
        !Number.isInteger(teamInfo.dailyGoalMinutes) || teamInfo.dailyGoalMinutes < 1 || teamInfo.dailyGoalMinutes > 1440)) {
      wx.showToast({ title: '期望分钟须为1至1440的整数', icon: 'none' });
      return;
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
    this.setData({ practiceStartDate: '', maxPracticeStartDate: today, dailyGoalMinutes: '' });
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
