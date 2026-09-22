# 第一批运维入口：配置与部署门槛

本次仅修改本地源码并使用隔离测试验证，未部署、未调用远程清理或重算。默认配置下所有运维任务关闭。个人绑定、预览、个人同步和打卡接口保持原身份行为。

## 身份边界

`cleanupTestData` 的所有请求，以及 `meditationManager` 的 `recomputeUserBadges`、`migrateBusinessDates`，只允许 `cloud.getWXContext().OPENID` 位于服务端环境变量 `MAINTENANCE_ADMIN_OPENIDS` 中的身份。变量是逗号分隔的完整 OPENID，默认空列表。不接受请求中的 OPENID、admin、source 作为身份，也不因为没有 OPENID 就授权。把列表配置给部署环境不会在客户端暴露名单。

`bijingSync` 的全员任务也使用相同管理员白名单；没有 `type` 的调用只表示尝试调度，不再意味着已获授权。只有这一全员任务还允许经过下面门槛确认的定时来源。授权拒绝发生在业务数据库查询、写入和外部 API 调用之前。

每个云函数包包含独立的 `maintenanceAuth.js`，源文件为 `shared/maintenanceAuth.js`。修改源文件后必须同步三个部署副本，测试会逐字检查它们一致。保留独立副本是因为云函数分别打包上传，不能依赖云端不存在的上级目录。

## 定时器：不能直接覆盖部署后假定运行正常

代码没有假定 `context.source === 'timer'`，也没有假定一个特定的真实 `SOURCE` 值。已检查公开的 wx-server-sdk 4.0.2 实现：`getWXContext()` 从平台进程上下文读取 `OPENID`，并以平台 `TCB_SOURCE` 提供 `SOURCE`。这仅确认 SDK 取值来源，**尚未确认项目线上 SDK 版本或真实触发器发送的值**。本地夹具中的 `verified-timer-only` 是测试值，不能照抄到部署配置。

部署前必须在隔离测试环境完成：

1. 记录实际部署 SDK、运行时及 `dailySyncBijing` 定时器配置；观察真实定时器调用的 SDK `SOURCE`，同时验证小程序、开发者工具、HTTP、云函数间调用的来源，确认该值只代表受保护的定时执行。
2. 检查部署侧调用 ACL。请求字段不得注入或重写平台上下文。不要记录完整事件、令牌或用户资料；诊断仅需来源种类、是否存在身份等最小信息。
3. 仅在来源具有上述可靠区分度后配置 `BIJING_TIMER_SOURCE` 为实际观察值，并设置 `BIJING_TIMER_ENABLED=true`。普通客户端、开发者工具、HTTP、其他云函数以及未知来源值已在代码中显式拒绝作为定时来源。
4. 验证真实定时器仍同步已绑定用户的上一业务日，并验证普通用户伪造 `source/admin`、空身份和其他来源均在业务读取前返回 `FORBIDDEN`。
5. 再部署生产版本。当前 `config.json` 中保留原定时计划；如果直接部署而未完成配置，调用将被拒绝并停止全员同步，不能将它判定为发布完成。

如果真实调度没有可可靠辨别的 SDK 来源，或与其他可调用入口共享同一来源，**不要启用该开关**。必须先采用独立且由平台 ACL 保护的调度执行入口并完成真实调用验证，才能恢复自动同步。本次没有构造未知平台身份，也没有加入可重放的自定义凭据协议。

## 清理的独立参数与生产开关

清理入口要求请求 `targetEnv`、平台 `WXContext.ENV`、服务端 `MAINTENANCE_ENV_ID` 完全一致，缺少任一项即失败。默认 `mode: 'stats'`，只读统计；`safe/full` 默认 `dryRun:true`。

写入还必须同时满足：

- 显式 `dryRun:false`，字符串 `"false"` 无效。
- `full` 必须显式 `scope:'all'`；`safe` 接受 `scope:'all'` 或 `scope:'user'` 加非空 `openid`。不推断范围。
- `safe` 明确指定真实且顺序正确的 `startDate/endDate`，使用北京时间每日 02:00 的业务日边界；不再默认清理从 2026 年至今的全部记录。
- 服务端 `MAINTENANCE_DEPLOYMENT_TIER` 明确为 `test` 或 `production`；生产默认拒绝写入，仅受保护的部署配置 `CLEANUP_ALLOW_PRODUCTION=true` 可以另行打开。

预览返回 `totalMatched` 和各集合数量，`totalDeleted` 为 0。完整清理分页读完选择集后分批删除，避免旧实现只删除首页或一次开启全部删除请求。任一批发生失败返回明确的部分失败结果，不再吞掉错误宣称完成。预览与执行没有快照锁；执行前需要重新确认数据范围，变更频繁时暂停相关写入。`safe` 保留旧约定，不在本批重建统计或排行榜。

## 重算目标

模式只允许 `report/apply`，默认只读 `report`。单用户优先使用明确的 `openid`，昵称为零匹配返回 `TARGET_NOT_FOUND`，多匹配返回 `AMBIGUOUS_TARGET`，不继续读全库。无目标返回 `TARGET_REQUIRED`；全部用户必须显式 `scope:'all'`，不能与单用户参数混用。`recomputeUserBadges` 的 `apply` 和 `migrateBusinessDates` 的 `dryRun:false` 同样要求请求 `targetEnv`、平台 `ENV` 和部署 `MAINTENANCE_ENV_ID` 一致。迁移写入还必须显式 `scope:'all'`，且 `dryRun` 只接受布尔值；授权的只读迁移预览保留兼容。本批不运行迁移或更改其迁移算法。

## 本地脚本与调用适配器

本机微信开发者工具 `cli cloud functions --help` 仅列出 list/info/deploy/inc-deploy/download，原脚本拼出的 `cloud function invoke` 不属于其受支持命令。因此没有继续假装它可以执行。

脚本现在支持本地 `--preview`，且未知或缺少参数明确失败。例如下列命令**只打印请求，不访问远端**：

```sh
node scripts/runCleanup.js safe --env isolated-test --scope user --openid example-user --start-date 2026-09-01 --end-date 2026-09-02 --preview
node scripts/runRecomputeBadges.js report --env isolated-test --nickname '示例昵称' --preview
```

真正调用需要设置 `MAINTENANCE_INVOKER` 为已验证的调用适配器**绝对可执行路径**。本次没有提供或配置可访问生产环境的适配器。其契约为：

- 参数数组：`--function <函数名> --env <环境ID>`；没有 shell 插值。
- 标准输入：JSON 请求；标准输出：JSON 业务结果，或 `{result: <JSON业务结果>}`。
- 必须将请求发往指定环境，并保留平台认证且位于白名单中的 OPENID；CLI 登录、空 OPENID、请求字段或适配器路径本身都不构成授权。
- 凭据由受保护的调用渠道管理，不放在请求 JSON、命令行参数或日志。脚本不打印完整命令，也不透传子进程的失败输出。
- 无适配器、非 JSON、`success !== true`、超时或传输错误均失败退出；超时结果视为未知，先检查调用结果，不能自动重试破坏性操作。

`--preview` 表示本地请求预览；不加该参数时，`safe/full` 仍默认调用云端只读预览；只有另加 `--apply` 才生成删除请求。重算的 `apply` 是写入模式。旧的缺目标遍历全库、昵称启发式识别 OPENID、shell 字符串拼接和无条件“调用成功”语义已移除。

## 验证范围

隔离测试覆盖权限拒绝无业务访问、运维白名单、已启用的可信定时夹具、非法目标/重名/空目标、目标环境、生产开关、清理分页与业务日期、只读默认值，以及脚本参数数组/标准输入和业务失败处理。真实 SDK/触发器来源、调用 ACL、适配器、真实定时执行和部署环境配置仍需部署前验证，不能用这些本地测试替代。
