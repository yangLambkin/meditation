// 图片存储和配置管理系统
const imageConfig = {
  // 背景图片列表
  backgrounds: [
    { id: 'bg1', path: '/images/bg1.jpeg' },
    { id: 'bg2', path: '/images/bg2.jpeg' },
    { id: 'bg3', path: '/images/bg3.jpeg' },
    { id: 'bg4', path: '/images/bg4.jpeg' },
    { id: 'bg5', path: '/images/bg5.jpeg' }
  ],
  
  // 获取随机背景图片
  getRandomBackground: function() {
    const randomIndex = Math.floor(Math.random() * this.backgrounds.length);
    return this.backgrounds[randomIndex];
  },
  
  // 根据ID获取特定背景图片
  getBackgroundById: function(id) {
    return this.backgrounds.find(bg => bg.id === id) || this.backgrounds[0];
  },
  
  // 添加新的背景图片
  addBackground: function(id, path) {
    if (!this.backgrounds.find(bg => bg.id === id)) {
      this.backgrounds.push({ id, path });
      return true;
    }
    return false;
  },
  
  // 移除背景图片
  removeBackground: function(id) {
    const index = this.backgrounds.findIndex(bg => bg.id === id);
    if (index !== -1) {
      this.backgrounds.splice(index, 1);
      return true;
    }
    return false;
  },
  
  // 获取所有背景图片列表
  getAllBackgrounds: function() {
    return this.backgrounds;
  }
};

module.exports = imageConfig;