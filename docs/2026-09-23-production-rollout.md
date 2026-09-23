# 2026-09-23 正式环境部署记录

## 已完成并验证

- 用户明确指定 BJ2407159（瑞璞，微信号 `dingyd_ripples`）为唯一管理员，并授权开启微信开发者工具本机服务端口。
- 使用当前小程序真实微信会话调用 `meditationManager.getUserProfile`，核对学号、昵称和服务端返回的 OpenID；未以学号查询结果直接授权。
- 在 `cloud1-2g2rbxbu2c126d4a` 的 `adminManager`、`teamManager`、`bijingSync` 配置相同的单值 `ADMIN_OPENID`。保留既有同步地址、访问令牌及定时器来源配置。
- 三个云函数均已通过微信官方 CLI 部署；实际会话调用 `adminManager.getAccess` 返回 `isAdmin: true`，`teamManager.adminListTeams` 成功返回 3 个团队。
- `bijingSync` 云端执行时限已从 3 秒改为 60 秒，CLI 再次查询确认生效。
- 用户明确同意正式环境发布，并知悉发布分支同时包含 JWT 有效期 30 天与龙珠榜匿名访问改动。
- 必经正式库已执行 `openapi_meditation_sync_migration.sql`，新增 `openapi_meditation_sync_batches`；未修改既有业务表。
- `data.bijing.life` 已部署 `fdf9688`。生产容器路由清单同时包含原单条接口、`records/batch`、`records/query`；正式环境认证查询返回 BJ2407159 在 2026-09-22 的已落库记录为 7 分钟。批量空请求和原单条空请求均正常返回参数校验 400。
- 调用 `bijingSync.adminInitialize`，成功创建 `bijing_sync_days`、`bijing_sync_runs`、`bijing_sync_items`、`bijing_sync_errors`、`admin_audit_logs` 五个集合。
- 实际云端调用 `adminManager.getAccess`、同步提醒、团队列表、操作记录、同步运行列表及错误列表均成功；当时三个日志/错误列表为空。
- 部署前本仓库完整测试通过：1,301 项。另有其他任务同时编辑管控页面和 `adminManager` 的昵称日期查询功能，该任务的后续改动不属于本记录已部署版本的承诺。

## 尚未完成，不能视为定时任务验收通过

1. 在云数据库控制台核验并设置上述五个集合为仅服务端可读写：`{"read":false,"write":false}`；不能以云函数读取成功代替客户端权限检查。
2. 建立/核验批量同步文档列出的复合索引。
3. 上传并核验原生触发器 `dailySyncBijing = 0 0 2 * * * *` 与 `resumeBijingBatches = 0 */5 * * * * *`。代码上传不会自动保证触发器已更新。
4. 执行一轮真实同步及查询复核，检查执行时间、逐项结果、错误表和必经接收审计；观察至少一次真实原生定时器执行。当前仅验证了接口只读查询，尚未由此次验收触发批量业务写入。
5. 小程序正式版前端尚未提交审核/发布；开发工具已能进入管控页面。

当前阻碍：macOS 窗口控制多次返回 `noWindowsAvailable` 或 ScreenCaptureKit 错误，暂时无法可靠操作云开发控制台。已请用户手动打开控制台并保持前台后继续；用户已授权的正式环境发布和管理员配置不需要再次确认。

后续操作说明见 [批量同步与管控中心](./2026-09-23-admin-batch-sync.md)。不要把此记录中的“已部署”理解为上述待办已完成。

## 后续更新：多管理员权限模块

- 新增 `ADMIN_OPENIDS` 完整管理员名单，英文逗号分隔；显式名单覆盖原单值 `ADMIN_OPENID`，未设置名单时仍兼容原配置。空或格式无效的名单拒绝授权，不回退旧值。
- 在 `cloud1-2g2rbxbu2c126d4a` 使用微信官方 CLI `cloud functions inc-deploy`，依次更新 `adminManager`、`teamManager`、`bijingSync` 的 `maintenanceAuth.js`。每个函数仅上传该文件，均返回成功；部署后查询三个函数均为 `Active`。
- 未修改云端管理员环境变量，未新增实际管理员。新增账号仍需提供并核对本人微信会话 OpenID，再给三个函数配置同一份完整名单；本次没有进行新增真实账号的线上访问验收。
- 本地 `npm test` 通过 1,352 项，覆盖第二位管理员访问、名单覆盖与撤权、非法配置拒绝、未授权调用隔离及真实操作者审计。原有维护与定时器授权规则保持不变。

## 后续更新：管理员名单集中到 adminManager

- 管理员名单现在只读取 `adminManager` 的 `ADMIN_OPENIDS`（未设置时兼容该函数的单值 `ADMIN_OPENID`）。`teamManager`、`bijingSync` 每次管理请求都通过服务端 `cloud.callFunction` 向 `adminManager.getAccess` 校验，原业务函数中的管理员变量不再授权或作为兜底。
- 两端身份来自各自 SDK 上下文，`expectedOpenid` 仅用于核对身份一致；不缓存授权结果。中央鉴权异常返回可重试的 `ADMIN_AUTH_UNAVAILABLE`，且不进入业务操作。旧维护和定时器规则不变。
- 已依次通过微信官方 CLI 完整部署 `adminManager`、`teamManager`、`bijingSync`，云端安装依赖；部署命令均返回成功。本次未新增实际管理员或修改云端名单。
- 本地 `npm test` 通过 1,372 项，包括真实入口 VM 串联、第二位管理员、撤权、身份丢失或不一致、伪造参数、本地旧名单失效、故障拒绝及非管理业务隔离。
- **真实微信会话的函数间调用仍待验收**：窗口控制出现 `noWindowsAvailable`、屏幕捕获失败，官方自动化会话连接也中断，未能完成调用。请在管控页确认团队列表和同步状态正常加载；本地串联测试和云函数 `Active` 状态不能替代平台身份传递验证。
- 首次代码升级已完成；之后增删管理员仅修改 `adminManager` 的环境变量，保存并等待配置更新完成，无需在其他函数同步名单。
