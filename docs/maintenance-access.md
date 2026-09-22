# 第一批运维入口：配置与部署门槛

本次仅修改本地源码并使用隔离测试验证，未部署、未调用远程清理或重算。默认配置下所有运维任务关闭。个人绑定、预览、个人同步和打卡接口保持原身份行为。

## 身份边界

`cleanupTestData` 的所有请求，以及 `meditationManager` 的 `recomputeUserBadges`、`migrateBusinessDates`，只允许 `cloud.getWXContext().OPENID` 位于服务端环境变量 `MAINTENANCE_ADMIN_OPENIDS` 中的身份。变量是逗号分隔的完整 OPENID，默认空列表。不接受请求中的 OPENID、admin、source 作为身份，也不因为没有 OPENID 就授权。把列表配置给部署环境不会在客户端暴露名单。

`bijingSync` 的全员任务也使用相同管理员白名单；没有 `type` 的调用只表示尝试调度，不再意味着已获授权。只有这一全员任务还允许经过下面门槛确认的定时来源。授权拒绝发生在业务数据库查询、写入和外部 API 调用之前。

每个云函数包包含独立的 `maintenanceAuth.js`，源文件为 `shared/maintenanceAuth.js`。修改源文件后必须同步三个部署副本，测试会逐字检查它们一致。保留独立副本是因为云函数分别打包上传，不能依赖云端不存在的上级目录。

## 定时器：环境变量与部署步骤

这两个变量只需配置在目标云开发环境的 **`bijingSync` 云函数**上，不写进小程序、请求 JSON 或 `config.json` 的定时表达式。微信官方 [Cloud.getWXContext 文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference-sdk-api/utils/Cloud.getWXContext.html) 明确：原生云函数定时触发器的 `SOURCE` 为 **`wx_trigger`**。2026-09-22 已核对该文档及公开的 wx-server-sdk 4.0.2 实现；当前项目声明的依赖为 `latest`，线上实际版本和运行结果仍需在部署环境确认。

| 云函数环境变量 | 启用原生定时器时填写的值 | 说明 |
| --- | --- | --- |
| `BIJING_TIMER_ENABLED` | `true` | 小写文本，不带引号；只有严格等于此值才启用 |
| `BIJING_TIMER_SOURCE` | `wx_trigger` | 与 SDK 上下文精确匹配，不填 `timer`、触发器名称或测试夹具 `verified-timer-only` |

操作顺序：

1. 在微信开发者工具打开项目，进入「云开发」，选择**测试环境**。进入「云函数 → bijingSync → 配置／版本与配置 → 环境变量」（控制台版本不同，页签名称可能不同）。检查既有 `BIJING_API_BASE`、`BIJING_ACCESS_TOKEN` 对应测试服务，添加 `BIJING_TIMER_SOURCE=wx_trigger`，先保持 `BIJING_TIMER_ENABLED=false`。
2. 在项目树右键 `cloudfunctions/bijingSync`，选择「上传并部署：云端安装依赖」。确保 `maintenanceAuth.js`、`heatmap.js` 等文件随整个函数目录上传；上传后重新检查环境变量仍在目标环境生效。执行超时不要继续使用 3 秒，**60 秒可作为小规模测试起点**，再按用户数量和实测耗时调大；它限制整轮同步，不能保证任何规模都能完成。
3. 在开发者工具右键该云函数，选择「上传触发器」，部署 `config.json` 中的规则；然后在控制台核对 `dailySyncBijing`，表达式为 `0 0 2 * * * *`，即北京时间每日 **02:00**。已有旧的 04:00 触发器应更新，不能同时留下两个每日任务。上传代码与上传触发器是两个步骤，见 [CloudBase 定时触发器说明](https://docs.cloudbase.net/cloud-function/timer-trigger)；[微信定时触发器文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/triggers.html) 确认时区为 UTC+8，以及定时来源为 `wx_trigger`。
4. 用下面的只读探测方法先确认真实触发器的 `SOURCE=wx_trigger`、`hasOpenid=false`，并检查部署侧调用权限：普通请求不能注入或重写平台上下文。「标准触发器」的名称和表达式正确不代表来源满足鉴权，必须核实实际上下文。恢复正常函数代码后，再把测试环境的 `BIJING_TIMER_ENABLED` 改为 `true` 并保存配置。测试时可临时使用控制台支持的短周期触发器，验证后删除，只保留每日触发器。
5. 让**实际定时触发器**运行一次，确认业务日期为上一业务日、`data.failed=0`，并用测试绑定账号验证外部测试服务收到预期记录。每个同学串行同步，首次失败后最多额外重试 3 次；仍失败则在日志与 `data.failedUsers` 中记录该同学及业务日期，继续下一个同学。任何最终失败都会令顶层 `success:false`，不能当作全员同步成功；`total=0` 也只能证明调度链路通过。根据失败明细手动补同步对应日期，普通客户端伪造 `source/admin` 仍应返回 `FORBIDDEN`。
6. 测试通过后，在生产环境设置同样的两个变量并上传已验证版本，保留生产环境自己的 `BIJING_API_BASE`、`BIJING_ACCESS_TOKEN`。确认生产触发器、变量和下一次真实运行日志。资料 PATCH 接口所需的 `meditationManager` 也应先部署，再发布小程序客户端。

仅使用定时器不需要配置管理员 OPENID 白名单，也不需要设置清理操作的生产开关。`MAINTENANCE_ADMIN_OPENIDS` 只用于另行授权人工运维。要暂停自动同步，将 `BIJING_TIMER_ENABLED` 改为 `false`；个人绑定、预览和个人同步不受此定时开关影响。

同步与重试都在同一次云函数执行里。单次 HTTP 请求超时为 10 秒，某个同学的初次尝试加 3 次重试仅请求等待就可能接近 40 秒，另有数据库读写等耗时。分页和串行处理不会重置平台超时；强制终止时无法保证剩余同学已处理，也没有断点续跑。下一天只同步下一业务日，不自动补前一天遗漏；应保留日志并在个人手动同步允许的日期范围内补报，对更早日期另行处理。对端须保持「同学号同日期幂等覆盖」约定，使重试不累加时长。

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
