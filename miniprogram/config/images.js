/**
 * 图片配置文件
 * 集中管理所有图片资源
 */

// 云存储环境配置
const CLOUD_ENV = 'cloud1-2g2rbxbu2c126d4a';
const CLOUD_PREFIX = 'cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223';

/**
 * 日签扑克图片配置
 * 这里配置您已上传到云存储的图片文件ID
 */
const DAILY_POKER_CONFIG = {
  // 图片分类名称
  category: 'daily_poker',
  
  // 图片文件路径前缀
  pathPrefix: `${CLOUD_PREFIX}/bg_image/`,
  
  // 预定义的图片文件列表
  // 只需要配置文件名，系统会自动构建完整文件ID
  images: [
    'm1.png',
    'm2.png', 
    'm3.png',
    'm4.png',
    'm5.png',
    'm6.png',
    'm7.png',
    'm8.png',
    'm9.png',
    'm10.png',
    'm11.png',
    'm12.png',
    'm13.png',
    'p1.png',
    'p2.png', 
    'p3.png',
    'p4.png',
    'p5.png',
    'p6.png',
    'p7.png',
    'p8.png',
    'p9.png',
    'p10.png',
    'p11.png',
    'p12.png',
    'p13.png'
    // 可以继续添加更多图片...
  ],
  
  // 默认图片（当随机图片获取失败时使用）
  defaultImage: '/images/p1.png',
  
  // 图片描述信息（可选）
  descriptions: {
    'm1.png': '冥想日签扑克图片1',
    'm2.png': '冥想日签扑克图片2',
    'm3.png': '冥想日签扑克图片3',
    'm4.png': '冥想日签扑克图片4',
    'm5.png': '冥想日签扑克图片5'
  }
};

/**
 * 构建完整的云存储文件ID
 * @param {string} filename - 文件名
 * @returns {string} 完整的文件ID
 */
const buildFileID = (filename) => {
  return `${CLOUD_PREFIX}/bg_image/${filename}`;
};

/**
 * 获取日签扑克图片列表
 * @returns {Array} 完整的文件ID数组
 */
const getDailyPokerImages = () => {
  return DAILY_POKER_CONFIG.images.map(filename => buildFileID(filename));
};

/**
 * 获取随机图片
 * @returns {Object} 随机图片信息
 */
const getRandomDailyPokerImage = () => {
  const images = getDailyPokerImages();
  if (images.length === 0) {
    return {
      fileID: DAILY_POKER_CONFIG.defaultImage,
      filename: 'default.png',
      isDefault: true
    };
  }
  
  const randomIndex = Math.floor(Math.random() * images.length);
  const fileID = images[randomIndex];
  const filename = DAILY_POKER_CONFIG.images[randomIndex];
  
  return {
    fileID: fileID,
    filename: filename,
    description: DAILY_POKER_CONFIG.descriptions[filename] || '冥想日签扑克图片',
    isDefault: false
  };
};

/**
 * 获取图片配置信息
 * @param {string} filename - 文件名
 * @returns {Object} 图片配置信息
 */
const getImageInfo = (filename) => {
  const fileID = buildFileID(filename);
  return {
    fileID: fileID,
    filename: filename,
    description: DAILY_POKER_CONFIG.descriptions[filename] || '冥想日签扑克图片',
    category: DAILY_POKER_CONFIG.category
  };
};

module.exports = {
  // 配置信息
  DAILY_POKER_CONFIG,
  
  // 工具函数
  buildFileID,
  getDailyPokerImages,
  getRandomDailyPokerImage,
  getImageInfo,
  
  // 常量
  DEFAULT_IMAGE: DAILY_POKER_CONFIG.defaultImage
};