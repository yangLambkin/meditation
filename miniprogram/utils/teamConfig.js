// 团队与功课使用同一 data 环境及已授权的过渡 OpenAPI 服务凭据。
const practices = require('./practiceConfig.js');
module.exports = { enabled: true, baseUrl: practices.baseUrl, serviceAccessToken: practices.serviceAccessToken };
