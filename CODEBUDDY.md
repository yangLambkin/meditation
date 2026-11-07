# 开发约定

本文件供在本仓库工作的编码助手参考。项目入口、命令与功能文档见 [README](README.md)。

## 工程边界

- 微信原生小程序，CommonJS；沿用各文件的缩进与分号风格，用户文案使用简体中文。
- `project.config.json` 指定 `miniprogram/` 与 `cloudfunctions/`；私有配置会覆盖公共配置，以开发者工具实际设置为准。
- 小程序 npm 依赖统一放在根 `package.json`，目前使用 `lunar-javascript`。依赖变更后重新「构建 npm」；云函数各自管理依赖。
- `cloudfunctions/` 下每个目录独立部署，不能依赖部署目录外文件。`shared/maintenanceAuth.js`、`shared/syncCoverage.js` 与部署副本的一致性由测试检查。
- `npm test` 运行 `tests/*.test.js`。本地测试通过不代表已部署或完成真机、真实云环境验收。

## 主要入口

| 功能 | 入口与模块 |
| --- | --- |
| 静坐记录 | `pages/index/`、`pages/recorder/`、`utils/checkin.js`、`utils/homeCheckin.js` |
| 计时 | `pages/timer/`、`utils/countdownSession.js`、`utils/timerAudio.js`、`utils/cuePlayer.js` |
| 功课 | `pages/practices/`、`pages/practiceHistory/`、`utils/practiceApi.js`、`utils/practiceQueue.js` |
| 团队 | `pages/team/`、`subpackages/team/`、`utils/teamGateway.js`、`utils/dataTeams.js` |
| 静心卡 | `pages/daily/`、`utils/dailyWisdom.js`、`utils/dailyPoster.js`、`config/images.js` |
| 资料与勋章 | `pages/me/`、`pages/profile/`、`pages/badge/`、`utils/profileCache.js`、`utils/badgeManager.js` |
| 补录、反馈、管理 | `pages/backfill/`、`pages/feedback/`、`pages/admin/` |

以上路径均相对于 `miniprogram/`。底部四个入口是首页、记录、团队、我；计时通过页面入口打开。

## 数据与调用约定

- 静坐记录先成功保存本机，再异步上传；持久化失败不得报成功或触发上传。待上传、已忽略和仅本机记录不能当作可删除缓存。
- `localUserId` 是本机存储命名空间，微信 `openid` 是云端身份；登录后仍须保留原记录身份、所属账号和体验正文，避免跨账号回包覆盖。
- 兼容平面与嵌套历史缓存。更新已知字段时保留其他业务字段，异步结果提交前核对当前 revision 和账号。
- 同一次提交/计时会话复用稳定身份。云端确认真实 `recordId` 后才标记已上传；超时不代表云端没有写入。
- `getAllRecords` 的成功结果是完整快照，不能把分页或增量直接替代为旧协议，否则客户端可能误删缓存。
- 静坐业务日按北京时间 02:00 划分，使用 `utils/dateUtil.js`。功课分日由 `utils/practiceDay.js` 与接口约定处理，不能假设所有功课使用同一边界。
- `meditation_records.experience` 新写入使用数组，保留历史字符串/引用兼容。集合字段沿用现有命名，勿批量统一 camelCase/snake_case。
- 冥想云接口优先使用 `utils/cloudApi.js`；团队通过 `teamGateway.js` 按来源路由。功课、data 团队和热力图使用 OpenAPI，不能把所有后端调用视为云函数。
- 操作成功须检查业务结果，不能把 `wx.cloud.callFunction` 的 success 回调当作业务成功。
- 当前自动补传涵盖全部日期的明确待上传记录；旧未确认记录须经预览确认。完整规则见[自动恢复说明](docs/2026-10-10-auto-sync-recovery.md)。

## 计时与资源

- 倒计时会话由 `app.js` 持有，独立于页面生命周期；正计时由 `pages/timer/timer.js` 管理。根据时间戳计算时长，不按定时回调次数累计。
- 明确退出与系统临时中断分别处理；冷启动只结算最后保存的检查点。音频恢复不能改写记录或计时身份。
- 起坐、收坐提示音是 `audio/起坐.mp3`、`audio/收坐.mp3`。播放器失败可有限重建，诊断保存在有容量限制的 `timerDiagnostics` 中。
- 云存储背景图配置在 `config/images.js`；分享封面和图标源文件由 `scripts/` 中的生成器维护，不能仅因没有运行时引用而删除源 SVG。

## 运维

运维脚本默认只读或预览，要求显式目标与环境。`MAINTENANCE_INVOKER` 是经过验证的调用适配器，微信开发者工具的 CLI 登录不等于运维授权。配置、部署顺序和权限边界见 [maintenance-access.md](docs/maintenance-access.md)。未授权的清理、迁移、部署或远端写入不属于本地测试。
