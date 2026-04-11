/**
 * 空间管理器
 * 负责空间创建、本地缓存和云端同步
 */

// 空间配置
const teamConfig = {
  maxMembers: 50, // 最大成员数
  maxTeamsPerUser: 1 // 每个用户最多创建1个空间
};

// 获取本地存储键名（按openid隔离）
const getTeamStorageKey = () => {
  const openid = wx.getStorageSync('userOpenId');
  return openid ? `userTeams_${openid}` : 'userTeams_guest';
};

// 获取加入空间的存储键名
const getJoinedTeamsKey = () => {
  const openid = wx.getStorageSync('userOpenId');
  return openid ? `joinedTeams_${openid}` : 'joinedTeams_guest';
};

class TeamManager {
  constructor() {
    this.teams = this.loadTeamsFromStorage();
  }

  /**
   * 从本地缓存加载空间数据
   */
  loadTeamsFromStorage() {
    try {
      const storageKey = getTeamStorageKey();
      const storedTeams = wx.getStorageSync(storageKey);
      if (storedTeams) {
        console.log(`✅ 从本地缓存加载空间数据: ${storageKey}`);
        return storedTeams;
      }
    } catch (error) {
      console.error('加载空间数据失败:', error);
    }
    return [];
  }

  /**
   * 保存空间数据到本地缓存
   */
  saveTeamsToStorage() {
    try {
      const storageKey = getTeamStorageKey();
      wx.setStorageSync(storageKey, this.teams);
      console.log(`✅ 空间数据保存到本地缓存: ${storageKey}`);
    } catch (error) {
      console.error('保存空间数据失败:', error);
    }
  }

  /**
   * 创建新空间
   */
  async createTeam(teamInfo) {
    try {
      // 1. 重新加载本地缓存，确保数据最新
      this.teams = this.loadTeamsFromStorage();
      
      // 2. 本地验证
      if (this.teams.length >= teamConfig.maxTeamsPerUser) {
        throw new Error(`每个用户最多只能创建${teamConfig.maxTeamsPerUser}个空间`);
      }

      // 3. 处理空间头像：如果使用临时路径，需要上传到云存储
      let teamIconUrl = teamInfo.icon;
      if (teamIconUrl && (teamIconUrl.startsWith('wxfile://tmp_') || teamIconUrl.startsWith('http://tmp/'))) {
        console.log('🔄 检测到临时头像路径，开始上传到云存储...', teamIconUrl);
        teamIconUrl = await this.uploadTeamIconToCloud(teamIconUrl);
        console.log('✅ 头像上传完成，新URL:', teamIconUrl);
      }

      // 4. 生成空间信息
      const newTeam = {
        _id: this.generateTeamId(),
        name: teamInfo.name,
        description: teamInfo.description || '',
        icon: teamIconUrl || '/images/icons/team.png',
        creator: wx.getStorageSync('userOpenId'),
        creatorName: wx.getStorageSync('userNickname') || '匿名用户',
        members: [],
        memberCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isActive: true
      };

      // 3. 立即保存到本地缓存
      this.teams.push(newTeam);
      this.saveTeamsToStorage();

      console.log('✅ 空间创建成功（本地）:', newTeam.name);

      // 4. 异步同步到云端（不阻塞本地创建）
      this.syncTeamToCloud(newTeam).catch(error => {
        console.error('云端同步失败，但本地创建成功:', error);
      });

      return { success: true, team: newTeam };
    } catch (error) {
      console.error('❌ 创建空间失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 生成空间ID
   */
  generateTeamId() {
    return 'team_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 同步空间数据到云端
   */
  async syncTeamToCloud(team) {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) {
        console.warn('无法同步空间数据：缺少openid');
        return;
      }

      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'createTeam',
          data: team,
          openid: openid
        }
      });

      if (result.result && result.result.success) {
        console.log('✅ 空间数据同步到云端成功');
        
        // 更新本地空间的云端ID
        const cloudTeamId = result.result.data.teamId;
        const teamIndex = this.teams.findIndex(t => t._id === team._id);
        if (teamIndex !== -1) {
          this.teams[teamIndex].cloudId = cloudTeamId;
          this.saveTeamsToStorage();
        }
      } else {
        console.error('空间数据同步到云端失败:', result.result);
      }
    } catch (error) {
      console.error('空间数据同步到云端失败:', error);
    }
  }

  /**
   * 获取用户创建的空间列表
   */
  getMyTeams() {
    const openid = wx.getStorageSync('userOpenId');
    if (!openid) {
      return [];
    }
    
    return this.teams.filter(team => team.creator === openid && team.isActive);
  }

  /**
   * 获取用户加入的空间列表（包含用户自己创建的空间）
   */
  getJoinedTeams() {
    const openid = wx.getStorageSync('userOpenId');
    if (!openid) {
      return [];
    }
    
    return this.teams.filter(team => 
      team.members.includes(openid) && team.isActive
    );
  }

  /**
   * 获取空间总数
   */
  getTeamCount() {
    return this.teams.filter(team => team.isActive).length;
  }

  /**
   * 从云端加载空间数据（改进版：清理本地缓存中已不存在的空间）
   */
  async loadTeamsFromCloud() {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return;

      console.log('🚀 强制从云端加载最新空间数据，完全覆盖本地缓存...');

      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'getUserTeams',
          openid: openid
        }
      });

      if (result.result && result.result.success) {
        const cloudTeams = result.result.data;
        let hasUpdate = false;

        // 记录清理前的空间数量
        const originalTeamCount = this.teams.length;

        // 1. 检查本地缓存中哪些空间在云端已不存在（被解散）
        const cloudTeamIds = cloudTeams.map(team => team._id);
        
        // 清理本地缓存中已不存在的空间（基于cloudId匹配）
        const teamsBeforeCleanup = [...this.teams];
        this.teams = this.teams.filter(team => {
          // 如果空间有cloudId且云端不存在，则删除
          if (team.cloudId && !cloudTeamIds.includes(team.cloudId)) {
            console.log(`🗑️ 清理无效空间: ${team.name} (cloudId: ${team.cloudId})`);
            return false;
          }
          return true;
        });

        // 如果清理了空间，标记需要更新
        if (teamsBeforeCleanup.length !== this.teams.length) {
          hasUpdate = true;
        }

        // 2. 合并云端数据
        cloudTeams.forEach(cloudTeam => {
          const existingTeam = this.teams.find(t => t.cloudId === cloudTeam._id);
          if (!existingTeam) {
            // 添加新空间，确保createdAt字段存在
            const newTeam = {
              ...cloudTeam,
              cloudId: cloudTeam._id
            };
            // 确保createdAt字段存在
            if (!newTeam.createdAt) {
              newTeam.createdAt = new Date().toISOString();
            }
            // 确保头像URL使用云端的版本，避免临时路径问题
            if (cloudTeam.icon && !cloudTeam.icon.startsWith('cloud://')) {
              // 如果云端头像不是云存储路径，检查本地是否有云存储路径
              const localTeam = this.teams.find(t => t._id === cloudTeam._id);
              if (localTeam && localTeam.icon && localTeam.icon.startsWith('cloud://')) {
                newTeam.icon = localTeam.icon;
              }
            }
            this.teams.push(newTeam);
            hasUpdate = true;
          } else {
            // 更新现有空间信息，但保留本地的createdAt字段
            const localCreatedAt = existingTeam.createdAt;
            const localIcon = existingTeam.icon;
            
            // 复制云端数据，但不覆盖createdAt和头像
            Object.keys(cloudTeam).forEach(key => {
              if (key !== 'createdAt' && key !== 'icon') {
                existingTeam[key] = cloudTeam[key];
              }
            });
            
            // 头像处理：优先使用云存储路径，如果本地有云存储路径就使用本地的
            if (localIcon && localIcon.startsWith('cloud://')) {
              // 保持本地云存储路径
              existingTeam.icon = localIcon;
            } else if (cloudTeam.icon && cloudTeam.icon.startsWith('cloud://')) {
              // 使用云端的云存储路径
              existingTeam.icon = cloudTeam.icon;
            } else {
              // 使用本地的路径
              existingTeam.icon = cloudTeam.icon;
            }
            
            // 如果本地没有createdAt，使用云端的createdAt
            if (!localCreatedAt && cloudTeam.createdAt) {
              existingTeam.createdAt = cloudTeam.createdAt;
            }
            // 如果都没有，使用当前时间
            if (!existingTeam.createdAt) {
              existingTeam.createdAt = new Date().toISOString();
            }
            hasUpdate = true;
          }
        });

        if (hasUpdate) {
          this.saveTeamsToStorage();
          console.log('✅ 从云端加载空间数据成功', {
            清理前空间数: originalTeamCount,
            清理后空间数: this.teams.length,
            清理的无效空间数: originalTeamCount - this.teams.length
          });
          
          // 3. 同时清理已加入空间的缓存
          this.cleanupJoinedTeamsFromCloud(cloudTeams);
        }
      } else {
        console.warn('⚠️ 云端返回数据格式异常:', result.result);
      }
    } catch (error) {
      console.error('从云端加载空间数据失败:', error);
    }
  }

  /**
   * 清理已加入空间缓存中已不存在的空间
   */
  cleanupJoinedTeamsFromCloud(cloudTeams) {
    try {
      const cloudTeamIds = cloudTeams.map(team => team._id);
      const joinedTeams = this.loadJoinedTeamsFromStorage();
      
      // 过滤掉云端已不存在的空间（基于cloudId匹配）
      const validJoinedTeams = joinedTeams.filter(team => {
        // 如果空间有cloudId且云端不存在，则删除
        if (team.cloudId && !cloudTeamIds.includes(team.cloudId)) {
          console.log(`🗑️ 清理无效的已加入空间: ${team.name} (cloudId: ${team.cloudId})`);
          return false;
        }
        return true;
      });
      
      if (validJoinedTeams.length !== joinedTeams.length) {
        this.saveJoinedTeamsToStorage(validJoinedTeams);
        console.log(`✅ 已清理已加入空间缓存中的无效空间: ${joinedTeams.length - validJoinedTeams.length}个`);
      }
    } catch (error) {
      console.error('清理已加入空间缓存失败:', error);
    }
  }

  /**
   * 删除空间
   */
  async deleteTeam(teamId) {
    try {
      const teamIndex = this.teams.findIndex(team => team._id === teamId);
      if (teamIndex === -1) {
        throw new Error('空间不存在');
      }

      // 标记为删除状态
      this.teams[teamIndex].isActive = false;
      this.saveTeamsToStorage();

      // 异步同步到云端
      await this.syncDeleteTeamToCloud(teamId);

      return { success: true };
    } catch (error) {
      console.error('删除空间失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 同步删除空间到云端
   */
  async syncDeleteTeamToCloud(teamId) {
    try {
      const openid = wx.getStorageSync('userOpenId');
      if (!openid) return;

      const team = this.teams.find(t => t._id === teamId);
      if (!team || !team.cloudId) return;

      const result = await wx.cloud.callFunction({
        name: 'teamManager',
        data: {
          type: 'deleteTeam',
          data: {
            teamId: team.cloudId
          },
          openid: openid
        }
      });

      if (result.result && result.result.success) {
        console.log('✅ 空间删除同步到云端成功');
      }
    } catch (error) {
      console.error('空间删除同步到云端失败:', error);
    }
  }

  /**
   * 从本地缓存加载已加入的空间
   */
  loadJoinedTeamsFromStorage() {
    try {
      const storageKey = getJoinedTeamsKey();
      const joinedTeams = wx.getStorageSync(storageKey);
      if (joinedTeams) {
        console.log(`✅ 从本地缓存加载已加入空间: ${storageKey}`);
        return joinedTeams;
      }
    } catch (error) {
      console.error('加载已加入空间失败:', error);
    }
    return [];
  }

  /**
   * 保存已加入空间到本地缓存
   */
  saveJoinedTeamsToStorage(teams) {
    try {
      const storageKey = getJoinedTeamsKey();
      wx.setStorageSync(storageKey, teams);
      console.log(`✅ 已加入空间保存到本地缓存: ${storageKey}`);
    } catch (error) {
      console.error('保存已加入空间失败:', error);
    }
  }

  /**
   * 添加已加入空间
   */
  addJoinedTeam(teamInfo) {
    try {
      const joinedTeams = this.loadJoinedTeamsFromStorage();
      
      // 检查是否已加入
      if (joinedTeams.some(team => team._id === teamInfo._id)) {
        console.log('⚠️ 用户已是空间成员');
        return;
      }

      // 添加空间信息
      const joinedTeam = {
        ...teamInfo,
        joinedAt: new Date().toISOString()
      };
      
      joinedTeams.push(joinedTeam);
      this.saveJoinedTeamsToStorage(joinedTeams);
      
      console.log('✅ 已加入空间添加到本地缓存');
    } catch (error) {
      console.error('添加已加入空间失败:', error);
    }
  }

  /**
   * 检查是否已加入空间
   */
  checkIsMember(teamId) {
    try {
      const joinedTeams = this.loadJoinedTeamsFromStorage();
      return joinedTeams.some(team => team._id === teamId);
    } catch (error) {
      console.error('检查成员状态失败:', error);
      return false;
    }
  }

  /**
   * 获取用户加入的所有空间
   */
  getUserJoinedTeams() {
    return this.loadJoinedTeamsFromStorage();
  }

  /**
   * 移除已加入的空间
   */
  removeJoinedTeam(teamId) {
    try {
      const joinedTeams = this.loadJoinedTeamsFromStorage();
      const filteredTeams = joinedTeams.filter(team => team._id !== teamId);
      
      if (filteredTeams.length !== joinedTeams.length) {
        this.saveJoinedTeamsToStorage(filteredTeams);
        console.log('✅ 已从加入列表中移除空间');
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('移除已加入空间失败:', error);
      return false;
    }
  }

  /**
   * 清理本地空间缓存
   */
  clearLocalTeamCache() {
    try {
      const storageKey = getTeamStorageKey();
      wx.removeStorageSync(storageKey);
      this.teams = [];
      console.log('✅ 本地空间缓存已清理');
      return true;
    } catch (error) {
      console.error('清理本地空间缓存失败:', error);
      return false;
    }
  }

  /**
   * 上传空间头像到云存储
   */
  async uploadTeamIconToCloud(tempFilePath) {
    return new Promise((resolve, reject) => {
      if (!tempFilePath || !tempFilePath.startsWith('http://tmp/')) {
        resolve(tempFilePath); // 如果不是临时路径，直接返回原路径
        return;
      }

      // 生成云存储路径
      const cloudPath = `team-icons/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
      
      console.log('开始上传头像到云存储:', { tempFilePath, cloudPath });
      
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: tempFilePath,
        success: (res) => {
          console.log('头像上传成功:', res);
          resolve(res.fileID); // 返回云存储文件ID
        },
        fail: (err) => {
          console.error('头像上传失败:', err);
          // 上传失败时返回默认头像
          resolve('/images/icons/team.png');
        }
      });
    });
  }
}

// 导出单例实例
const teamManager = new TeamManager();
module.exports = teamManager;