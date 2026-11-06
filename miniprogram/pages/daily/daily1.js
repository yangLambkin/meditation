const lunarUtil = require('../../utils/lunar.js');
const checkinManager = require('../../utils/checkin.js');
const dailyCardImage = require('../../utils/dailyCardImage.js');
const badgeManager = require('../../utils/badgeManager.js');
const dateUtil = require('../../utils/dateUtil.js');
const homeCheckin = require('../../utils/homeCheckin.js');
const dailyWisdom = require('../../utils/dailyWisdom.js');
const dailyShareSession = require('../../utils/dailyShareSession.js');
const SHARE_COVER_FALLBACK = '/images/daily-share.png';

function sharedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T12:00:00+08:00`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

function shareQuote(value) {
  if (typeof value !== 'string') return '';
  // Keep the native share path short, including when the quote contains Chinese.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 96 ? `${characters.slice(0, 95).join('')}…` : text;
}

function readSharedQuote(value) {
  if (typeof value !== 'string') return '';
  // Native launch channels can hand over a decoded query or its encoded value.
  // The encoded colon marks which form arrived, so literal "%25"/"%E5" text
  // survives either channel without being decoded a second time.
  if (value.startsWith('q1:')) return shareQuote(value.slice(3));
  if (/^q1%3a/i.test(value)) {
    try { return shareQuote(decodeURIComponent(value).slice(3)); }
    catch (_) { return ''; }
  }
  // Preserve links created before the explicit quote format was introduced.
  try { return shareQuote(decodeURIComponent(value)); }
  catch (_) { return shareQuote(value); }
}

Page({
  data: {
    wisdomQuote: dailyWisdom.DEFAULT_QUOTE,
    displayImage: dailyCardImage.DEFAULT_IMAGE,
    isImageLoading: true,
    imageLoadFailed: false,
    isSharedView: false,
    session: null,
    isSavingImage: false
  },

  onLoad(options = {}) {
    this._isUnloaded = false;
    this._isShareCanvasReady = false;
    this._initialShowPending = true;
    const isSharedView = options.shared === '1' || Object.prototype.hasOwnProperty.call(options, 'card');
    this._sharedDate = isSharedView ? sharedDate(options.date) : '';
    this.setData({ isSharedView });
    if (this.data.isSharedView) {
      this._sharedQuote = readSharedQuote(options.quote);
      this._sharedImageKey = dailyCardImage.normalizeImageKey(options.card);
      this.setData({ session: dailyShareSession.readSession(options) });
      if (this._sharedQuote) this.setData({ wisdomQuote: this._sharedQuote });
    }
    if (typeof wx.showShareMenu === 'function') {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'], fail() {} });
    }
    // 1. 立即同步设置当前日期，避免首屏闪现默认日期 23（日期设置不应依赖异步图片预加载）
    this.setCurrentDateInfo();
    if (!isSharedView) this.captureCardSession(options);

    // 2. 自己的新卡片仅抽取一次，分享入口始终读取原牌面。
    this.preloadRandomImage().catch(error => {
      console.warn('静心卡图片预加载失败，保留原牌等待重试:', error);
      this.fallbackToDefaultImage();
    });

    console.log('开始预加载图片，避免闪烁');
  },

  onReady() {
    this._isShareCanvasReady = true;
    this.prepareShareCover();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this._isPageVisible = true;
    console.log('=== daily1页面onShow函数开始 ===');
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    if (!this.data.isSharedView) {
      this._stopWisdomWatch = dailyWisdom.watchDailyWisdom(({ content }) => {
        this.setData({ wisdomQuote: content });
        this.prepareShareCover();
      });
    }
    
    // 首次 onLoad 已同步刷新日期、用户和统计；返回页面时再刷新。
    if (!this._initialShowPending || (!this._sharedDate && this._displayedBusinessDate !== dateUtil.getBusinessDate())) {
      this.setCurrentDateInfo();
    }
    this._initialShowPending = false;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = this._sharedDate ? null : dateUtil.watchBusinessDate(() => this.setCurrentDateInfo());
    
    console.log('=== daily1页面onShow函数结束 ===');
  },

  /**
   * 设置当前日期信息
   */
  setCurrentDateInfo: function() {
    this._displayedBusinessDate = this._sharedDate || dateUtil.getBusinessDate();
    const [year, month, day] = this._displayedBusinessDate.split('-').map(Number);
    const today = new Date(year, month - 1, day, 12);
    
    // 获取英文月份名称
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
    const englishMonth = monthNames[today.getMonth()];
    
    // 获取星期几
    const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekDay = weekDays[today.getDay()];
    
    // 计算农历日期（简化版，实际应用中可以使用更精确的农历库）
    const lunarDate = lunarUtil.getLunarDate(today);
    
    // 获取用户数据
    if (!this.data.isSharedView) this.getUserData();
    
    // 更新页面显示
    this.setData({
      year: year,
      month: englishMonth,
      day: day,
      weekDay: weekDay,
      lunarDate: lunarDate
    });
    this.prepareShareCover();
    
    console.log(`打卡日期: ${year}.${englishMonth} ${weekDay} ${lunarDate}`);
  },

  /**
   * 格式化时间显示（直接显示分钟数）
   */
  formatTime: function(minutes) {
    return `${minutes}分钟`;
  },

  captureCardSession(options) {
    let session = dailyShareSession.createSession(this.data.userName, options.completedAt, options.minutes);
    if (!session) {
      // Compatibility for older timer entries without an explicit completion.
      // Capture once so a later record or a day rollover cannot replace it.
      try {
        const records = homeCheckin.buildCheckinRecords(checkinManager.getUserCheckinData());
        const record = records.find(item => item.dayDate === this._displayedBusinessDate);
        if (record) session = dailyShareSession.createSession(this.data.userName, record.sortTimestamp, record.duration);
      } catch (_) {}
    }
    this.setData({ session, ...(session ? { totalMinutes: session.minutes } : {}) });
    this.prepareShareCover();
  },

  /**
   * 消费计时完成时预热的图片，直接进入静心卡时也复用相同的下载流程。
   */
  preloadRandomImage: function() {
    if (this._dailyImageEntry) return this._dailyImageEntry.promise;
    const image = this.data.isSharedView
      ? dailyCardImage.takeSharedImage(this._sharedImageKey)
      : dailyCardImage.takeNextImage();
    return this.loadDailyImage(image);
  },

  loadDailyImage(image) {
    this._dailyImageEntry = image;
    const applyImage = path => {
      if (!this._isUnloaded && this._dailyImageEntry === image) {
        this.setData({ displayImage: path, isImageLoading: false,
          imageLoadFailed: path === dailyCardImage.DEFAULT_IMAGE && !!image.key && image.key !== 'local' });
      }
      return path;
    };
    if (image.path) {
      applyImage(image.path);
      return image.promise;
    }
    if (!this._isUnloaded) this.setData({ isImageLoading: true, imageLoadFailed: false });
    return image.promise.then(applyImage);
  },

  retryDailyImage() {
    if (this._isUnloaded || this.data.isImageLoading || !this.data.imageLoadFailed) return;
    const key = this.data.isSharedView ? this._sharedImageKey : this._dailyImageEntry && this._dailyImageEntry.key;
    return this.loadDailyImage(dailyCardImage.takeSharedImage(key));
  },

  getRandomImage: function() {
    return this.preloadRandomImage();
  },

  /**
   * 图片读取失败只影响显示；保留原牌编号，重试和转发都不会换牌。
   */
  fallbackToDefaultImage: function() {
    const key = this.data.isSharedView ? this._sharedImageKey : this._dailyImageEntry && this._dailyImageEntry.key || 'local';
    this._dailyImageEntry = { key, path: dailyCardImage.DEFAULT_IMAGE, promise: Promise.resolve(dailyCardImage.DEFAULT_IMAGE) };
    if (!this._isUnloaded && (!this.data.imageLoadFailed || this.data.isImageLoading || this.data.displayImage !== dailyCardImage.DEFAULT_IMAGE)) {
      this.setData({ displayImage: dailyCardImage.DEFAULT_IMAGE, isImageLoading: false, imageLoadFailed: true });
    }
  },

  /**
   * 获取用户数据（支持新旧格式）
   */
  getUserData: function() {
    // 使用与index页面一致的登录状态检测逻辑
    const userOpenId = wx.getStorageSync('userOpenId');
    const userInfo = wx.getStorageSync('userInfo');
    const userNickname = wx.getStorageSync('userNickname');
    
    const isWechatLoggedIn = userOpenId && userOpenId.startsWith('oz');
    const hasWechatInfo = !!(userInfo || userNickname);
    const isLoggedIn = isWechatLoggedIn || hasWechatInfo;
    
    // 尝试从缓存获取用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    
    console.log('daily1页面用户状态检测 - 微信登录:', isWechatLoggedIn, '有微信信息:', hasWechatInfo, '已登录:', isLoggedIn);
    
    // 支持新旧格式的用户信息
    const hasValidUserInfo = cachedUserInfo && 
                           (cachedUserInfo.nickName || 
                            (cachedUserInfo.isCustomAvatar !== undefined && 
                             cachedUserInfo.profileComplete));
    
    if (hasValidUserInfo) {
      // 使用缓存的用户信息
      const userName = userNickname || cachedUserInfo.nickName || '静心者';
      
      // 头像显示逻辑优化：
      // 1. 已登录用户：优先使用用户头像，否则使用登录图标
      // 2. 未登录用户：使用默认头像
      let userAvatar;
      if (isLoggedIn) {
        userAvatar = cachedUserInfo.avatarUrl || '/images/userLogin.png';
      } else {
        userAvatar = '/images/avatar.png'; // 未登录用户使用默认头像
      }
      
      this.setData({
        userName: userName,
        userAvatar: userAvatar
      });
      
      console.log('获取到用户信息 - 昵称:', userName, '头像:', userAvatar, '登录状态:', isLoggedIn);
    } else {
      // 没有用户信息，根据登录状态使用不同默认值
      const userName = userNickname || (isLoggedIn ? '微信用户' : '静心者');
      
      // 头像显示逻辑优化：
      // 已登录用户显示登录图标，未登录用户显示默认头像
      const userAvatar = isLoggedIn ? '/images/userLogin.png' : '/images/avatar.png';
      
      this.setData({
        userName: userName,
        userAvatar: userAvatar
      });
      
      console.log('未找到用户信息，使用默认值 - 昵称:', userName, '头像:', userAvatar, '登录状态:', isLoggedIn);
      
      // 收坐后保持安静，个人资料可在「我」中自行完善。
    }
    
    // 获取用户打卡统计数据（使用本地缓存优先的架构）
    this.calculateUserStatsFromLocal();
    
    // 获取最高等级勋章
    this.getHighestLevelBadge();
  },

  /**
   * 获取当前用户的最高等级勋章
   */
  getHighestLevelBadge: function() {
    try {
      // 获取所有已解锁的勋章
      const unlockedBadges = badgeManager.getUnlockedBadges();
      
      // 筛选出等级勋章
      const levelBadges = unlockedBadges.filter(badge => badge.category === 'level' && badge.isUnlocked);
      
      if (levelBadges.length === 0) {
        console.log('用户暂未解锁任何等级勋章');
        this.setData({
          highestLevelBadge: null
        });
        return;
      }
      
      // 找出最高等级的勋章（按level序号排序）
      const highestBadge = levelBadges.reduce((max, badge) => {
        // 从level-X中提取数字X
        const currentLevel = parseInt(badge.id.split('-')[1]);
        const maxLevel = max ? parseInt(max.id.split('-')[1]) : -1;
        
        return currentLevel > maxLevel ? badge : max;
      }, null);
      
      console.log('📊 最高等级勋章:', highestBadge);
      
      this.setData({
        highestLevelBadge: highestBadge
      });
      
    } catch (error) {
      console.warn('获取最高等级勋章失败:', error);
      this.setData({
        highestLevelBadge: null
      });
    }
  },

  /**
   * 显示个人信息设置提示
   */
  showProfileHint: function() {
    if (this._profileHintTimer || this._profileHintShown || this._isUnloaded) return;
    // 延迟显示提示，避免影响页面加载
    this._profileHintTimer = setTimeout(() => {
      this._profileHintTimer = null;
      if (!this._isPageVisible || this._isUnloaded) return;
      this._profileHintShown = true;
      wx.showModal({
        title: '完善个人信息',
        content: '设置个性化昵称和头像，享受更好的冥想体验',
        confirmText: '立即设置',
        cancelText: '稍后再说',
        success: (res) => {
          if (res.confirm && this._isPageVisible && !this._isUnloaded) {
            // 跳转到个人信息设置页面
            wx.navigateTo({
              url: '/pages/profile/profile?type=new&from=daily'
            });
          }
        }
      });
    }, 2000);
  },

  /**
   * 计算用户统计数据（本地缓存优先架构）
   */
  calculateUserStatsFromLocal: function() {
    console.log('=== 开始从本地缓存获取用户统计数据 ===');
    
    try {
      // 获取当前日期
      const today = new Date();
      const todayStr = dateUtil.getBusinessDate(today);
      
      // 1. 直接从本地缓存获取今日打卡数据
      const todayCheckinCount = this.getTodayCheckinCountFromLocal(todayStr);
      console.log('本地获取今日打卡次数:', todayCheckinCount);
      
      // 2. 获取本次觉察时长（当天最后一次打卡的时长）
      const currentMinutes = this.data.session ? this.data.session.minutes : this.getCurrentMeditationMinutes(todayStr);
      console.log('本地获取本次觉察时长:', currentMinutes, '分钟');
      
      // 3. 获取用户累计统计信息（从本地）
      const userStats = this.getUserStatsFromLocal();
      console.log('本地获取用户统计信息:', userStats);
      
      // 4. 计算用户等级（基于累计总分钟数）
      const userLevel = this.calculateUserLevel(userStats.totalDuration || 0);
      
      // 设置页面数据
      this.setData({
        totalMinutes: currentMinutes, // 显示本次打卡时长
        totalCount: todayCheckinCount, // 显示今日累计打卡次数
        userLevel: userLevel
      }, () => {
        // 数据设置完成后的回调，验证数据绑定
        console.log('数据设置完成 - 本次打卡时长:', currentMinutes + '分钟');
        console.log('数据设置完成 - 今日打卡次数:', todayCheckinCount);
        console.log('数据设置完成 - 用户等级:', userLevel);
        console.log('页面数据验证:', {
          totalMinutes: this.data.totalMinutes,
          totalCount: this.data.totalCount,
          userLevel: this.data.userLevel
        });
      });
      
    } catch (error) {
      console.error('从本地缓存获取用户统计数据失败:', error);
      // 降级处理：显示0分钟，表示没有打卡记录
      this.setData({
        totalMinutes: 0,
        totalCount: 0,
        userLevel: 'Lv.1 新手上路'
      });
    }
  },

  /**
   * 从本地缓存获取今日打卡次数
   */
  getTodayCheckinCountFromLocal: function(todayStr) {
    const checkinManager = require('../../utils/checkin.js');
    
    // 使用checkinManager的同步版本获取今日打卡次数
    const count = checkinManager.getDailyCheckinCountSync(todayStr);
    return count || 0;
  },

  /**
   * 获取本次觉察时长（当天最后一次打卡的时长）
   */
  getCurrentMeditationMinutes: function(todayStr) {
    const checkinManager = require('../../utils/checkin.js');
    
    try {
      const records = homeCheckin.buildCheckinRecords(checkinManager.getUserCheckinData());
      const lastRecord = records.find(record => record.dayDate === todayStr);
      return lastRecord ? lastRecord.duration : 0;

    } catch (error) {
      console.warn('获取本次觉察时长失败:', error);
      return 0;
    }
  },

  /**
   * 从本地缓存获取用户统计信息
   */
  getUserStatsFromLocal: function() {
    const checkinManager = require('../../utils/checkin.js');
    
    try {
      // 使用checkinManager的本地统计功能
      const stats = checkinManager.getUserStats();
      return stats;
    } catch (error) {
      console.warn('获取本地用户统计失败:', error);
      return {
        totalDays: 0,
        totalCount: 0,
        totalDuration: 0,
        currentStreak: 0,
        longestStreak: 0
      };
    }
  },

  /**
   * 计算用户等级
   */
  calculateUserLevel: function(totalMinutes) {
    if (totalMinutes >= 10080) return 'Lv.10 禅定大师';
    if (totalMinutes >= 5040) return 'Lv.9 静心高手';
    if (totalMinutes >= 2520) return 'Lv.8 修行达人';
    if (totalMinutes >= 1260) return 'Lv.7 精进者';
    if (totalMinutes >= 600) return 'Lv.6 坚持者';
    if (totalMinutes >= 300) return 'Lv.5 探索者';
    if (totalMinutes >= 150) return 'Lv.4 初学者';
    if (totalMinutes >= 60) return 'Lv.3 修行中';
    if (totalMinutes >= 30) return 'Lv.2 入门者';
    return 'Lv.1 新手上路';
  },

  /**
   * 保留原有的云端数据获取函数作为备用（兼容性）
   */
  calculateUserStats: async function() {
    // 直接调用本地版本，保持兼容性
    this.calculateUserStatsFromLocal();
  },


  onHide() {
    this._isPageVisible = false;
    this._initialShowPending = false;
    if (this._profileHintTimer) clearTimeout(this._profileHintTimer);
    this._profileHintTimer = null;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
  },

  // 卸载只清理资源，避免旧卡片抢占微信新分享的目标路由。
  onUnload() {
    this._isUnloaded = true;
    this._isPageVisible = false;
    if (this._profileHintTimer) clearTimeout(this._profileHintTimer);
    this._profileHintTimer = null;
    if (this._stopBusinessDayWatch) this._stopBusinessDayWatch();
    this._stopBusinessDayWatch = null;
    if (this._stopWisdomWatch) this._stopWisdomWatch();
    this._stopWisdomWatch = null;
  },

  // 自定义返回按钮点击事件
  onBack() {
    // 直接跳转到首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  noop() {},

  getShareQuery() {
    const imageKey = this.data.isSharedView ? this._sharedImageKey : this._dailyImageEntry && this._dailyImageEntry.key || 'local';
    const base = `shared=1&date=${encodeURIComponent(this._displayedBusinessDate || dateUtil.getBusinessDate())}` +
      `&card=${encodeURIComponent(dailyCardImage.normalizeImageKey(imageKey))}` +
      dailyShareSession.sessionQuery(this.data.session);
    const characters = Array.from(shareQuote(this.data.wisdomQuote));
    const query = () => `${base}&quote=${encodeURIComponent(`q1:${characters.join('')}`)}`;
    // Stay inside WeChat's launch-path budget even with emoji in both fields.
    while (characters.length && `/pages/daily/daily1?${query()}`.length > 1000) characters.pop();
    return query();
  },

  getShareCoverSnapshot() {
    return {
      quote: shareQuote(this.data.wisdomQuote) || dailyWisdom.DEFAULT_QUOTE,
      date: this._displayedBusinessDate || dateUtil.getBusinessDate(),
      weekDay: this.data.weekDay || '',
      session: this.data.session ? { ...this.data.session } : null
    };
  },

  prepareShareCover(snapshot = this.getShareCoverSnapshot()) {
    if (this._isUnloaded || !this._isShareCanvasReady) return Promise.resolve(SHARE_COVER_FALLBACK);
    const key = JSON.stringify(snapshot);
    if (this._shareCoverKey === key && this._shareCoverPath) return Promise.resolve(this._shareCoverPath);
    if (this._shareCoverTask && this._shareCoverTask.key === key) return this._shareCoverTask.promise;
    // Serialize this dedicated canvas so a late quote/date update cannot mix
    // two drawings, or interfere with the separate full-image save canvas.
    const previous = this._shareCoverTask ? this._shareCoverTask.promise : Promise.resolve();
    const task = { key, promise: null };
    task.promise = previous.then(async () => {
      if (this._isUnloaded) return SHARE_COVER_FALLBACK;
      const { generateDailyShareCover } = require('../../utils/dailyShareCover.js');
      return generateDailyShareCover(this, snapshot);
    }).then(path => {
      if (!this._isUnloaded && key === JSON.stringify(this.getShareCoverSnapshot())) {
        this._shareCoverKey = key;
        this._shareCoverPath = path;
      }
      return path;
    }).catch(error => {
      console.warn('静心卡分享封面准备失败:', error);
      return SHARE_COVER_FALLBACK;
    }).finally(() => {
      if (this._shareCoverTask === task) this._shareCoverTask = null;
    });
    this._shareCoverTask = task;
    return task.promise;
  },

  resolveShareCover(snapshot) {
    // WeChat allows asynchronous share data for three seconds. Always settle
    // before that limit and keep a bundled, correctly sized cover available.
    return new Promise(resolve => {
      let settled = false;
      const finish = imageUrl => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ imageUrl });
      };
      const timer = setTimeout(() => finish(SHARE_COVER_FALLBACK), 2500);
      this.prepareShareCover(snapshot).then(finish, () => finish(SHARE_COVER_FALLBACK));
    });
  },

  onShareAppMessage() {
    const snapshot = this.getShareCoverSnapshot();
    const key = JSON.stringify(snapshot);
    const imageUrl = this._shareCoverKey === key && this._shareCoverPath || SHARE_COVER_FALLBACK;
    const share = {
      title: dailyShareSession.shareTitle(snapshot.session),
      path: `/pages/daily/daily1?${this.getShareQuery()}`,
      imageUrl
    };
    // Keep the direct route and record attached to the asynchronous result too;
    // preparing a cover must not fall back to the app's default entry page.
    return { ...share, promise: this.resolveShareCover(snapshot).then(cover => ({ ...share, ...cover })) };
  },

  onShareTimeline() {
    const snapshot = this.getShareCoverSnapshot();
    const key = JSON.stringify(snapshot);
    return {
      title: dailyShareSession.shareTitle(snapshot.session),
      query: this.getShareQuery(),
      imageUrl: this._shareCoverKey === key && this._shareCoverPath || SHARE_COVER_FALLBACK
    };
  },

  getDailyImageSnapshot() {
    const fields = ['year', 'month', 'day', 'weekDay', 'lunarDate', 'displayImage', 'wisdomQuote',
      'userName', 'userAvatar', 'highestLevelBadge', 'totalCount', 'totalMinutes', 'isSharedView', 'session'];
    const snapshot = {};
    for (const field of fields) snapshot[field] = this.data[field];
    return JSON.parse(JSON.stringify(snapshot));
  },

  async prepareDailyImage() {
    if (this._dailyImageEntry) await this._dailyImageEntry.promise;
    if (this._isUnloaded || this._isPageVisible === false) return '';
    if (this.data.imageLoadFailed) throw new Error('原卡片尚未加载，请重试');
    const snapshot = this.getDailyImageSnapshot();
    const key = JSON.stringify(snapshot);
    if (key === this._savedImageKey && this._savedImagePath) return this._savedImagePath;
    const { generateDailyPoster } = require('../../utils/dailyPoster.js');
    const path = await generateDailyPoster(this, snapshot);
    if (this._isUnloaded || this._isPageVisible === false) return '';
    this._savedImageKey = key;
    this._savedImagePath = path;
    return path;
  },

  previewDailyCard() {
    if (this._isUnloaded || this.data.isImageLoading || this.data.imageLoadFailed) return;
    const path = this.data.displayImage || dailyCardImage.DEFAULT_IMAGE;
    wx.previewImage({ current: path, urls: [path], fail() {} });
  },

  saveDailyImage() {
    if (this._isUnloaded || this._isPageVisible === false) return Promise.resolve(false);
    if (this._saveImagePromise) return this._saveImagePromise;
    this.setData({ isSavingImage: true });
    this._saveImagePromise = (async () => {
      try {
        const path = await this.prepareDailyImage();
        if (!path || this._isUnloaded || this._isPageVisible === false) return false;
        await new Promise((resolve, reject) => {
          const pending = wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject });
          if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
        });
        if (!this._isUnloaded && this._isPageVisible !== false) {
          wx.showToast({ title: '图片已保存到相册', icon: 'success' });
        }
        return true;
      } catch (error) {
        console.warn('静心卡图片保存失败:', error);
        if (this._isUnloaded || this._isPageVisible === false || /cancel/i.test(error && error.errMsg || '')) return false;
        if (/auth|deny|denied|permission/i.test(error && error.errMsg || '')) {
          wx.showModal({
            title: '允许保存到相册',
            content: '请在设置中开启相册权限，返回后再次点击「保存图片」。',
            confirmText: '去设置',
            cancelText: '暂不开启',
            success: result => {
              if (result.confirm && !this._isUnloaded && this._isPageVisible !== false && typeof wx.openSetting === 'function') {
                wx.openSetting({ fail() {} });
              }
            }
          });
        } else {
          // The temporary image may have expired; the next tap draws it again.
          this._savedImageKey = '';
          this._savedImagePath = '';
          wx.showToast({ title: '图片保存失败，请重试', icon: 'none' });
        }
        return false;
      } finally {
        this._saveImagePromise = null;
        if (!this._isUnloaded) this.setData({ isSavingImage: false });
      }
    })();
    return this._saveImagePromise;
  }
});
