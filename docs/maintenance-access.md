# 第一批运维入口：配置与部署门槛


2026-09-23 管控中心统一使用绑定学号授权：只在 `adminManager` 的环境变量 `ADMIN_STUDENT_NUMBERS` 配置英文逗号分隔的完整学号名单。本次为 `BJ2407159,BJ2302130`。名单为空或非法时拒绝授权；旧 `ADMIN_OPENID`、`ADMIN_OPENIDS` 不再生效，也不回退。

`bijingSync` 的所有 `admin*` 操作和 `teamManager` 的管理操作每次调用 `adminManager.getAccess`，业务函数用 SDK 真实 OpenID 写入仅服务端可读写的一次性凭据（30 秒有效），由中央事务消费后查唯一有效绑定。凭据不返回客户端；直接请求仍使用 SDK 身份，原始身份或 SOURCE 参数不能替代凭据。客户端参数不授予权限，中央故障拒绝操作，不缓存结果。旧维护脚本的 OpenID 授权与定时器规则保持独立。

升级前先创建 `bijing_bindings` 并设置 `{"read":false,"write":false}`，同时将 `users` 设为 `{"read":"doc._openid == auth.openid","write":false}`，保留本人读取、禁止客户端直接写入。必须先完成这一步再部署学号版 `adminManager`，否则中央校验失败，管理员也无法用 `adminInitialize` 创建缺失的绑定集合。完整部署三个必需云函数：`bijingSync`（含 `bindings.js`）、`meditationManager`（优先展示有效绑定资料）、`adminManager`（含 `studentAuth.js`、`delegation.js`）。逐个部署并等待 `Active`；处于 `Updating` 时先等待，避免同时再次上传。`teamManager` 同步更新 `maintenanceAuth.js`，支持平台嵌套调用丢失 OpenID 时的服务端一次性凭据。`adminManager` 的既有执行超时要求为 10 秒、`teamManager` 为 20 秒，内部中央校验调用上限 8 秒；`bijingSync` 的实时平台时限须按当前同步耗时核实，不能把历史 60 秒配置当作本次已验证的值。最后发布带解绑入口的小程序。以后增删管理员只修改 `adminManager` 的学号名单。

换微信账号：原账号在「我 → 必经之路」解绑，再由新账号绑定；已经绑定其他学号的账号也须先解绑。每个学号只能绑定一个微信账号，绑定和解绑使用账号/学号双锁事务。解绑撤销该学号带来的管理权限，静坐历史和同步归档保留在原账号，不迁移到新账号。历史多人重复绑定不获得管理员权限，不自动选定保留者；相关账号自行解绑到唯一有效绑定后可恢复授权，原有唯一绑定无需重新绑定。详细步骤见 [管控中心说明](./2026-09-23-admin-batch-sync.md)；实际部署状态见 [正式环境部署记录](./2026-09-23-production-rollout.md)。

将现有唯一绑定统一纳入新表管理，可使用 `adminManager.adminMigrateBindings`，先预览备份、再分批事务写入、最后复核。此过程不要求用户重新绑定，详见 [一次性绑定迁移](./2026-09-23-binding-migration.md)。

## 身份边界

`cleanupTestData` 的所有请求，以及 `meditationManager` 的 `recomputeUserBadges`、`migrateBusinessDates`，只允许 `cloud.getWXContext().OPENID` 位于服务端环境变量 `MAINTENANCE_ADMIN_OPENIDS` 中的身份。变量是逗号分隔的完整 OPENID，默认空列表。不接受请求中的 OPENID、admin、source 作为身份，也不因为没有 OPENID 就授权。把列表配置给部署环境不会在客户端暴露名单。

`bijingSync` 的 `cronSyncAll` 及未提供 `type` 时的自动调度入口也使用 `MAINTENANCE_ADMIN_OPENIDS`；没有 `type` 只表示尝试调度，不意味着已获授权。这些调度入口还允许经过下面门槛确认的定时来源。管控页的 `adminStartSync`、`adminRetrySyncErrors` 等管理入口则使用绑定学号的中央鉴权，两类授权相互独立。授权拒绝发生在业务数据库查询、写入和外部 API 调用之前；鉴权仅访问所需绑定资料及一次性凭据。

每个云函数包包含独立的本地授权模块，不能依赖云端不存在的上级目录。`maintenanceAuth.js` 的源文件为 `shared/maintenanceAuth.js`；修改源文件后必须同步五份部署副本，测试会逐字检查它们一致。该模块的旧维护及定时器规则保持独立；业务函数的管理入口使用上述中央鉴权流程，不读取自身的管控管理员名单。

## 定时器：环境变量与部署步骤

这两个变量只需配置在目标云开发环境的 **`bijingSync` 云函数**上，不写进小程序、请求 JSON 或 `config.json` 的定时表达式。微信官方 [Cloud.getWXContext 文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference-sdk-api/utils/Cloud.getWXContext.html) 明确：原生云函数定时触发器的 `SOURCE` 为 **`wx_trigger`**。2026-09-22 已核对该文档及公开的 wx-server-sdk 4.0.2 实现；当前项目声明的依赖为 `latest`，线上实际版本和运行结果仍需在部署环境确认。

| 云函数环境变量 | 启用原生定时器时填写的值 | 说明 |
| --- | --- | --- |
| `BIJING_TIMER_ENABLED` | `true` | 小写文本，不带引号；只有严格等于此值才启用 |
| `BIJING_TIMER_SOURCE` | `wx_trigger` | 与 SDK 上下文精确匹配，不填 `timer`、触发器名称或测试夹具 `verified-timer-only` |

操作顺序：

1. 在微信开发者工具打开项目，进入「云开发」，选择**测试环境**。进入「云函数 → bijingSync → 配置／版本与配置 → 环境变量」（控制台版本不同，页签名称可能不同）。检查既有 `BIJING_API_BASE`、`BIJING_ACCESS_TOKEN` 对应测试服务，添加 `BIJING_TIMER_SOURCE=wx_trigger`，先保持 `BIJING_TIMER_ENABLED=false`。
2. 在部署前确认 `bijing_sync_errors` 和其他同步集合已存在，客户端规则为 `{"read":false,"write":false}`，并补齐[批量同步部署说明](2026-09-23-admin-batch-sync.md#数据与部署顺序)中的索引。历史记录变更与待办同事务提交，错误集合缺失会使该记录事务失败，不能留到代码升级后再补集合。
3. 本次完整部署 `meditationManager`（含新增 `syncQueue.js`）与 `bijingSync`（含新增 `syncFailures.js`、`pendingRepairs.js` 及更新的入口、`batchJobs.js`、`dailySchedule.js`，保留其他依赖）。逐个等待 `Active`。核实两个函数的实时执行时限，按测试环境完整记录事务、上传、核对及积压修复耗时配置。`meditationManager` 增加绑定资料/注册表读取与队列事务，需要实测历史保存、删除耗时；前端仍采用 3 秒上传确认，迟到回包与重放通过原幂等及服务端待办处理，不能把历史平台 3 秒配置当作当前实测。同步租约可按需续租，整次调用不要求短于 120 秒；平台执行时限仍独立生效。已完成中央鉴权升级的环境，本次不要求重新部署 `adminManager`、`teamManager` 或修改其名单。
4. 云端只保留两条原生触发器：`dailySyncBijing = 0 0 2 * * * *`（每日 02:00 上传），`checkBijingSync = 0 0 3-10 * * * *`（03:00–10:00 每小时整点核对与修复）。删除旧 `resumeBijingBatches`、仅 05:00 核对以及其他重复规则。上传代码与更新触发器是不同步骤，必须读取云端实际清单确认。
5. 用下面的只读探测方法确认真实触发器的 `SOURCE=wx_trigger`、`hasOpenid=false`，并检查调用权限：普通请求不能注入或重写平台上下文。恢复正常函数代码后再启用 `BIJING_TIMER_ENABLED=true`。若测试时添加临时短周期触发器，验收后删除，只保留上述两条正式规则。
6. 观察真实定时上传及核对，检查 `bijing_sync_runs`、逐人待办和必经实际分钟数。02:00 的 `uploaded` 只表示上传阶段结束；顶层 `success:true` 只表示调度请求执行成功。核验上传响应丢失、回查故障、删除后零总量、同日新变更与旧确认并发，以及最后整点失败后的次日恢复。故障不能因跨日或达到累计重试次数被永久放弃。
7. 测试通过后在生产环境部署已验证版本，保留生产自己的必经地址与令牌，核实触发器、开关、执行时限和下一次真实运行日志。本次尚未部署、未更新触发器或修改云端时限；历史上线记录不能代替实时核验。

仅使用定时器不需要配置管理员 OPENID 白名单，也不需要设置清理操作的生产开关。`MAINTENANCE_ADMIN_OPENIDS` 只用于另行授权人工运维。要暂停自动同步，将 `BIJING_TIMER_ENABLED` 改为 `false`；个人绑定、预览和个人同步不受此定时开关影响。

全员上传和正数修复每个 HTTP 请求最多 100 条，核对修复按每组最多 20 行保存 checkpoint；慢源读取/同步标记达到 5 秒软预算后提前保存进度，单条清零逐人保存游标。`pendingRepairs.js` 在允许的整点继续历史错误、尚未完成的运行，以及仍为该日期最新全量运行且未被源核对接管的 `uploaded` 任务，历史日期和最新目标日共用持久化轮转游标。已知逐人失败进入 `bijing_sync_errors`，尚未枚举出用户的任务级故障由 `bijing_sync_runs` 恢复。01:00 等非允许时段不新建周期，也不增加额外 cron；最后整点未完成的工作保留到下一允许整点，包括次日继续。具体流程以[执行机制](2026-09-23-admin-batch-sync.md#执行机制)为准。

历史记录新增、离线补传及删除的待办由 `meditationManager/syncQueue.js` 与记录、统计同事务提交；个人同步由 `syncFailures.js` 在外部请求前登记待办。实际回查与当前源总量一致后，按 `queueVersion` 及归属比较再清除，旧确认不能清掉新变更。批量清错前还会再次读取当前源总量；即使较新的待办已被其他请求清除，迟到旧批请求也不能据此确认成功，仍可登记 `source_changed` 重新核对。正数走批量接口；带有 `zeroEligible: true` 或已确认本人源记录、变更、同步依据且当前归属匹配的日期归零时，复用既有单条 `records` 的数值零清除能力，并回查确认。`zeroEligible` 必须来自本人真实源或变更，单纯绑定冲突或源读取失败的错误不能授权清零。本次不要求修改 `bijing-data`，但须核实目标环境已支持清零与查询。

`bijing_sync_errors` 同时保存待同步变更和已知失败；源读取或远端查询失败不能伪造“远端缺失”。修复时重新读取源总量与绑定，核对恢复才清除。每次打开或从后台返回小程序仅调用一次 `adminManager.getSyncAlert` 获取底部“我”图标红点状态，前台停留、页面切换和刷新不额外查询。普通用户不能读取错误表；同步待办与待处理/处理中的反馈均清空后，下一次检查关闭红点，详见[反馈说明](2026-09-29-feedback.md)。

### 只读确认调用来源

在**隔离测试环境的临时诊断版本**中，可把下面代码放在 `bijingSync/index.js` 的 `exports.main` 内，紧接 `const wxContext = cloud.getWXContext();` 后面。此版本会立即返回，不执行任何业务查询或外部同步，且不记录 OPENID、令牌或完整请求。诊断期间该测试函数的个人接口也会暂停，不能部署到正常服务的生产函数。

```js
console.info('[bijing-timer-probe]', {
  source: wxContext.SOURCE || null,
  hasOpenid: Boolean(wxContext.OPENID),
  env: wxContext.ENV || null
});
return { success: false, code: 'TIMER_SOURCE_PROBE_ONLY' };
```

等待真实定时触发器执行，读取函数日志；再分别用开发者工具、小程序、已启用的 HTTP 和云函数间调用对比来源。诊断完成后**移除这段代码并重新部署正常版本**，再启用开关。控制台「测试」按钮或请求中填写 `{ "source": "wx_trigger" }` 都不会变成真实定时来源，返回 `FORBIDDEN` 不能据此判定定时器失效。

官方文档还说明来源会随调用链传递，例如 `wx_client,scf`；当前授权采用精确匹配，因此经另一个云函数转发的调用与原生直接定时触发不同。如果实际来源为空、`wx_unknown`、通用 `scf` 或不能与普通入口可靠区分，不应为了绕过拒绝随意修改 `BIJING_TIMER_SOURCE`。应先核对 SDK、触发器入口和平台配置，必要时拆分由平台权限保护的独立调度入口。

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
