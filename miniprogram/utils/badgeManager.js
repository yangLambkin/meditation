/**
 * 勋章管理器
 * 负责勋章获取条件的检查、本地缓存和云端同步
 */

// 勋章配置信息
const badgeConfig = {
  // 连续打卡7天勋章
  'continuous-7': {
    id: 'continuous-7',
    name: '连续打卡7天',
    description: '连续打卡7天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡7天.png',
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 7
    },
    unlockTime: null,
    isUnlocked: false
  },
  
  // 连续打卡14天勋章
  'continuous-14': {
    id: 'continuous-14', 
    name: '连续打卡14天',
    description: '连续打卡14天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡14天.png',
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 14
    },
    unlockTime: null,
    isUnlocked: false
  },

  // 连续打卡30天勋章
  'continuous-30': {
    id: 'continuous-30', 
    name: '连续打卡30天',
    description: '连续打卡30天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡30天.png',
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 30
    },
    unlockTime: null,
    isUnlocked: false
  },

  // 连续打卡60天勋章
  'continuous-60': {
    id: 'continuous-60', 
    name: '连续打卡60天',
    description: '连续打卡60天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡60天.png',
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 60
    },
    unlockTime: null,
    isUnlocked: false
  },

  // 连续打卡100天勋章
  'continuous-100': {
    id: 'continuous-100', 
    name: '连续打卡100天',
    description: '连续打卡100天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡100天.png',
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 100
    },
    unlockTime: null,
    isUnlocked: false
  },
  
  // 累计打卡365天勋章
  'continuous-365': {
    id: 'continuous-365',
    name: '连续打卡365天',
    description: '累计打卡365天即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/连续打卡365天.png', 
    category: 'continuous',
    condition: {
      type: 'continuous_checkin',
      days: 365
    },
    unlockTime: null,
    isUnlocked: false
  },

  // 单次打卡时长勋章
  'meditation-20': {
    id: 'meditation-20',
    name: '单次觉察20分钟',
    description: '单次觉察20分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/单次20分钟.png',
    category: 'duration',
    condition: {
      type: 'single_duration',
      minutes: 20
    },
    unlockTime: null,
    isUnlocked: false
  },

  // 等级勋章 - 基于累计打卡时长（10个等级）
  'level-1': {
    id: 'level-1',
    name: 'LV1.新手',
    description: '累计觉察10分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV1.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 10
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-2': {
    id: 'level-2',
    name: 'LV2.入门者',
    description: '累计觉察100分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV2.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 100
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-3': {
    id: 'level-3',
    name: 'LV3.修行中',
    description: '累计觉察300分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV3.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 300
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-4': {
    id: 'level-4',
    name: 'LV4.初学者',
    description: '累计觉察600分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV4.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 600
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-5': {
    id: 'level-5',
    name: 'LV5.探索者',
    description: '累计觉察1000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV5.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 1000
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-6': {
    id: 'level-6',
    name: 'LV6.坚持者',
    description: '累计觉察2000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV6.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 2000
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-7': {
    id: 'level-7',
    name: 'LV7.精进者',
    description: '累计觉察4000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV7.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 4000
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-8': {
    id: 'level-8',
    name: 'LV8.修行达人',
    description: '累计觉察8000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV8.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 8000
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-9': {
    id: 'level-9',
    name: 'LV9.静心高手',
    description: '累计觉察15000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV9.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 15000
    },
    unlockTime: null,
    isUnlocked: false
  },

  'level-10': {
    id: 'level-10',
    name: '禅定大师',
    description: '累计觉察30000分钟即可获得',
    imageUrl: 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/badge/LV10.png',
    category: 'level',
    condition: {
      type: 'total_duration',
      minutes: 30000
    },
    unlockTime: null,
    isUnlocked: false
  }
};

// 本地缓存键名（按openid隔离）
const getBadgeStorageKey = () => {
  const openid = wx.getStorageSync('userOpenId');
  return openid ? `userBadges_${openid}` : 'userBadges_guest';
};

class BadgeManager {
  constructor() {
    this.badges = this.loadBadgesFromStorage();
  }

  /**
   * 从本地缓存加载勋章数据
   */
  loadBadgesFromStorage() {
    try {
      const storageKey = getBadgeStorageKey();
      const storedBadges = wx.getStorageSync(storageKey);
      if (storedBadges) {
        // 合并配置和缓存数据
        const mergedBadges = { ...badgeConfig };
        Object.keys(storedBadges).forEach(badgeId => {
          if (mergedBadges[badgeId]) {
            mergedBadges[badgeId] = { ...mergedBadges[badgeId], ...storedBadges[badgeId] };
          }
        });
        console.log(`✅ 从本地缓存加载勋章数据: ${storageKey}`);
        return mergedBadges;
      }
    } catch (error) {
      console.error('加载勋章数据失败:', error);
    }
    return { ...badgeConfig };
  }

  /**
   * 保存勋章数据到本地缓存
   */
  saveBadgesToStorage() {
    try {
      // 只保存解锁状态和时间
      const badgesToSave = {};
      Object.keys(this.badges).forEach(badgeId => {
        badgesToSave[badgeId] = {
          isUnlocked: this.badges[badgeId].isUnlocked,
          unlockTime: this.badges[badgeId].unlockTime
        };
      });
      const storageKey = getBadgeStorageKey();
      wx.setStorageSync(storageKey, badgesToSave);
      console.log(`✅ 勋章数据保存到本地缓存: ${storageKey}`);
    } catch (error) {
      console.error('保存勋章数据失败:', error);
    }
  }

  /**
   * 登录/换绑时迁移本地勋章缓存（修复风险③）
   * 未登录（local_xxx）期间解锁的勋章原本存于 userBadges_${localId}，
   * 登录后 userOpenId 切换为微信 openid，缓存 key 随之改变，导致勋章（尤其 single_duration 类，
   * 因登录时 lastDuration 为 0 无法重新满足条件）丢失。
   * 本方法将旧 key 中已解锁的勋章合并到新 openid 缓存，并保留原始 unlockTime。
   * @param {string} fromOpenid 迁移前的 userOpenId（可能为 local_xxx 或空）
   * @param {string} toOpenid   迁移后的 userOpenId（真实 openid）
   */
  migrateBadges(fromOpenid, toOpenid) {
    try {
      if (!toOpenid || fromOpenid === toOpenid) return;

      const fromKey = fromOpenid ? `userBadges_${fromOpenid}` : 'userBadges_guest';
      const toKey = `userBadges_${toOpenid}`;
      const fromBadges = wx.getStorageSync(fromKey);
      if (!fromBadges || Object.keys(fromBadges).length === 0) return;

      const toBadges = wx.getStorageSync(toKey) || {};
      let changed = false;

      Object.keys(fromBadges).forEach(badgeId => {
        const fb = fromBadges[badgeId];
        if (fb && fb.isUnlocked && (!toBadges[badgeId] || !toBadges[badgeId].isUnlocked)) {
          toBadges[badgeId] = { isUnlocked: true, unlockTime: fb.unlockTime };
          changed = true;
        }
      });

      if (changed) {
        wx.setStorageSync(toKey, toBadges);
        console.log(`✅ 勋章缓存已迁移: ${fromKey} → ${toKey}`);
        // 重新加载内存中的勋章状态，使其指向新 openid 缓存
        this.badges = this.loadBadgesFromStorage();
        // 新 openid 为真实用户，触发一次云端同步，补齐迁移来的勋章
        this.syncBadgesToCloud();
      }
    } catch (e) {
      console.warn('⚠️ 勋章缓存迁移失败（不影响登录）:', e.message);
    }
  }

  /**
   * 检查用户是否满足勋章获取条件
   * @param {Object} userStats - 用户统计数据
   */
  checkBadgeUnlock(userStats) {
    const { currentStreak = 0, totalCheckinDays = 0, lastDuration = 0, totalDuration = 0 } = userStats;
    let hasNewUnlock = false;

    Object.keys(this.badges).forEach(badgeId => {
      const badge = this.badges[badgeId];
      
      // 如果已经解锁，跳过检查
      if (badge.isUnlocked) return;

      // 根据勋章类型检查条件
      switch (badge.condition.type) {
        case 'continuous_checkin':
          if (currentStreak >= badge.condition.days) {
            this.unlockBadge(badgeId);
            hasNewUnlock = true;
            console.log(`🎉 解锁勋章: ${badge.name}`);
          }
          break;
          
        case 'total_checkin':
          // ⚠️ 累计打卡天数类勋章：必须以云端/本地的 totalDays 作为判定源。
          // 调用方必须传入 totalCheckinDays: stats.totalDays（不要传错字段），否则该分支永远取 0（历史 bug）。
          if (totalCheckinDays >= badge.condition.days) {
            this.unlockBadge(badgeId);
            hasNewUnlock = true;
            console.log(`🎉 解锁勋章: ${badge.name}`);
          }
          break;
          
        case 'single_duration':
          // 检查最后一次打卡时长是否达到要求
          if (lastDuration >= badge.condition.minutes) {
            this.unlockBadge(badgeId);
            hasNewUnlock = true;
            console.log(`🎉 解锁勋章: ${badge.name}`);
          }
          break;
          
        case 'total_duration':
          // 检查累计打卡时长是否达到要求（等级勋章）
          if (totalDuration >= badge.condition.minutes) {
            this.unlockBadge(badgeId);
            hasNewUnlock = true;
            console.log(`🎉 解锁等级勋章: ${badge.name}`);
          }
          break;
      }
    });

    if (hasNewUnlock) {
      this.saveBadgesToStorage();
      this.syncBadgesToCloud();
    }

    return hasNewUnlock;
  }

  /**
   * 解锁勋章
   */
  async unlockBadge(badgeId) {
    if (this.badges[badgeId]) {
      this.badges[badgeId].isUnlocked = true;
      this.badges[badgeId].unlockTime = new Date().toISOString();
      
      // 单个勋章解锁后立即尝试同步到云端
      try {
        await this.syncBadgesToCloud();
        console.log(`✅ 勋章解锁并同步到云端: ${this.badges[badgeId].name}`);
      } catch (error) {
        console.warn(`勋章解锁成功，但云端同步失败，将在下次批量同步时重试: ${error.message}`);
      }
    }
  }

  /**
   * 同步勋章数据到云端
   */
  async syncBadgesToCloud() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        console.warn('无法同步勋章数据：缺少openid');
        return;
      }

      const badgesToSync = {};
      Object.keys(this.badges).forEach(badgeId => {
        const badge = this.badges[badgeId];
        if (badge.isUnlocked) {
          badgesToSync[badgeId] = {
            name: badge.name,
            unlockTime: badge.unlockTime
          };
        }
      });

      const result = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'updateUserBadges',
          badges: badgesToSync,
          openid: openid
        }
      });
      
      if (result.result && result.result.success) {
        console.log('✅ 勋章数据同步到云端成功');
      } else {
        console.error('勋章数据同步到云端失败:', result.result);
      }
    } catch (error) {
      console.error('勋章数据同步到云端失败:', error);
    }
  }

  /**
   * 从云端加载勋章数据
   */
  async loadBadgesFromCloud() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return;

      const result = await wx.cloud.callFunction({
        name: 'meditationManager',
        data: {
          type: 'getUserBadges',
          openid: openid
        }
      });

      if (result.result && result.result.success) {
        const cloudBadges = result.result.data;
        let hasUpdate = false;

        // 合并云端数据
        Object.keys(cloudBadges).forEach(badgeId => {
          if (this.badges[badgeId] && cloudBadges[badgeId].isUnlocked) {
            if (!this.badges[badgeId].isUnlocked) {
              this.badges[badgeId].isUnlocked = true;
              this.badges[badgeId].unlockTime = cloudBadges[badgeId].unlockTime;
              hasUpdate = true;
            }
          }
        });

        if (hasUpdate) {
          this.saveBadgesToStorage();
          console.log('从云端加载勋章数据成功');
        }
      }
    } catch (error) {
      console.error('从云端加载勋章数据失败:', error);
    }
  }

  /**
   * 获取已解锁的勋章列表
   */
  getUnlockedBadges() {
    return Object.values(this.badges).filter(badge => badge.isUnlocked);
  }

  /**
   * 获取所有勋章列表
   */
  getAllBadges() {
    return Object.values(this.badges);
  }

  /**
   * 获取已解锁勋章数量
   */
  getUnlockedCount() {
    return this.getUnlockedBadges().length;
  }

  /**
   * 按分类获取勋章
   * @param {string} category - 分类名称
   */
  getBadgesByCategory(category) {
    return Object.values(this.badges).filter(badge => badge.category === category);
  }

  /**
   * 获取分类信息
   */
  getBadgeCategories() {
    const categories = [
      {
        id: 'level',
        name: '等级勋章',
        description: '基于累计打卡时长的等级勋章'
      },
      {
        id: 'continuous',
        name: '连续打卡',
        description: '基于连续打卡天数的勋章'
      },
      {
        id: 'duration',
        name: '单次时长',
        description: '基于单次打卡时长的勋章'
      }
    ];

    // 为每个分类添加勋章统计信息
    return categories.map(category => {
      const badges = this.getBadgesByCategory(category.id);
      const unlockedBadges = badges.filter(badge => badge.isUnlocked);
      
      return {
        ...category,
        badges: unlockedBadges,
        totalCount: badges.length,
        unlockedCount: unlockedBadges.length
      };
    });
  }

  /**
   * 获取按分类分组的勋章数据
   */
  getBadgesGroupedByCategory() {
    return this.getBadgeCategories();
  }
}

// 导出单例实例
const badgeManager = new BadgeManager();
module.exports = badgeManager;