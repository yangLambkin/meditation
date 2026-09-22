第一批技术方案：修复数据丢失、授权和错误判定

状态：本地代码修复与回归测试已完成，真实云环境联调和部署待完成。2026-09-22 运行完整 `npm test`，1161 项全部通过，`git diff --check` 通过；未部署云函数，未执行远程清理、重算或历史数据迁移。部署前须按 [运维入口配置与部署门槛](maintenance-access.md) 验证平台身份、定时来源、调用权限及环境配置。本文其余内容保留实施方案与验收要求；第二、三批仍待实施。

本批目标是先消除已确认的正确性问题，并保持现有存储和接口兼容。第二批再统一领域模型与状态入口，第三批再做云端历史迁移、增量同步和性能优化。

**本批交付与边界。** 交付本地存储修复、运维入口授权、审核结果解析、资料更新与提交状态修复，以及对应回归测试。保持现有平面/嵌套缓存均可读写；不执行全库迁移、清理、历史重报或勋章批量纠正。已经丢失且云端也不存在的体验正文无法由程序自动恢复。

| 修复范围 | 主要文件与函数 | 完成后的行为 |
| --- | --- | --- |
| 本地体验丢失 | `miniprogram/utils/checkin.js`：`getUserCheckinData`、`saveUserCheckinData` | 新增打卡不会覆盖体验、扩展字段或原记录身份 |
| 运维访问边界 | `cleanupTestData`、`meditationManager`、`bijingSync` 的入口 | 普通用户、未知身份和伪造事件字段不能触发管理任务 |
| 运维目标错误 | `recomputeUserBadges`、清理入口、相关 scripts | 空目标、重名和非法参数不会退化成全库写入 |
| 文本审核 | `cloudfunctions/contentSecCheck/index.js` | 只有明确的 `pass` 可以通过 |
| 资料覆盖 | `me.js`、`profile.js`、云端 `updateUserProfile` | 修改头像不会回写旧昵称，缺省字段不覆盖现有值 |
| 保存假成功、遮罩卡死 | `profile.saveUserInfo/saveToCloud`、`me.syncUserInfoToCloud` | 传输成功与业务成功分开；所有退出路径结束 loading |

**步骤 1：建立失败用例和兼容基线。** 在改代码前加入审查中已复现的失败用例，保留现有测试，不按当前缺陷修改断言。记录实际部署的 SDK/运行时、云环境、定时触发器来源与调用权限；这些线上事实目前没有核查，实施时必须先确认。

需要准备的本地夹具包括：平面缓存、嵌套缓存、仅体验数据、旧记录仅引用体验 ID、带未知扩展字段、含未上传/上传中/已忽略记录，以及存储写入失败。云端夹具包括普通 OPENID、空身份、可信服务身份、不存在和重名昵称、审核 v2 的完整响应。

必须保留当前约定：新记录先落本机；每次上传最多 3 秒、首次加 3 次重试、重试间隔 100ms；启动或返回前台只自动补传当天明确待上传记录；历史及旧记录经用户预览确认；网络恢复本身不自启上传；必经同步不顺带补传本机记录；手动补录和业务日期规则保持不变。

**步骤 2：修复存储覆盖，暂不迁移格式。** 保持 `getUserCheckinData()` 的调用契约，修改实际生效的保存函数，在写入前读取最新完整对象：

```js
// 示意：需按现有错误处理、revision 和通知约定实现。
const current = readRaw(userId);
const next = isNested(current)
  ? { ...current, checkinRecords: mergeKnownCheckinFields(current.checkinRecords, data) }
  : mergeKnownCheckinFields(current, data);
writeRaw(userId, next);
bumpRevision(userId);
```

`mergeKnownCheckinFields` 只更新调用者负责的打卡字段；`dailyRecords` 等明确提供的字段允许替换，空对象表示主动清空，字段缺失表示保留。嵌套对象的 `experienceRecords` 与外层元数据必须保留，平面结构中的体验及扩展字段也必须保留。读取到落盘之间不插入 `await`；异步恢复仍使用现有 revision 检查，不能把这段代码当成通用的跨异步并发控制。

首次写入失败不得改变内存快照、推进 revision、通知成功或触发上传；已有记录的 localId、云端 ID、时间戳和同步标记不得重建。去除本次涉及的重复方法定义时，以对象中最后生效的实现为基准，不能恢复早期被覆盖的迁移逻辑。其余重复实现放到第二批集中清理。

**步骤 3：建立运维授权入口。** 对 `cleanupTestData`、`recomputeUserBadges`、`migrateBusinessDates`、`cronSyncAll` 统一实行默认拒绝。授权必须基于平台提供、测试环境验证过的服务调用身份或运维身份，并配合部署侧调用权限；不得信任 `event.admin`、`event.source`，也不得把“没有 OPENID”视为管理员身份。

优先将清理、重算、全员同步放入独立受保护函数；普通客户端原有管理 action 返回 `FORBIDDEN`。如平台无法为共用函数可靠区分调度身份，则必须拆分后才能恢复定时任务。个人绑定、预览和个人同步保留原入口。删除当前“无 OPENID 且无 type 就是定时器”的推断。

实施顺序是先部署并验证受保护调度目标，再切换定时触发器，最后关闭旧管理入口，避免正常每日同步中断。源码中的 OpenAPI 权限声明不等于函数调用 ACL，不能用它证明入口已受保护。拒绝请求必须在任何业务数据库查询或外部调用之前结束。

**步骤 4：收紧运维命令参数。** 清理不再缺省执行 `safe` 删除；缺省只读或返回参数错误。所有写入要求明确模式、服务端校验的目标环境、目标范围以及 `dryRun:false`。生产清理默认关闭；是否启用由受保护的部署配置决定。

勋章重算仅接受 `report/apply`。显式单用户优先使用 OPENID；昵称查询为零返回 `TARGET_NOT_FOUND`，重名返回 `AMBIGUOUS_TARGET`；无目标返回 `TARGET_REQUIRED`，全库必须明确 `scope:'all'` 且通过同一授权检查。建议预览返回目标清单摘要，执行时核对，防止预览与执行目标漂移。

同步修改 `scripts/runCleanup.js`、`scripts/runRecomputeBadges.js` 与说明文档，消除缺省全库语义。脚本通过 `execFile`/参数数组调用 CLI，避免拼接 shell 命令。本文不提供可直接执行生产删除的命令；实现与测试均使用隔离数据。

**步骤 5：修复审核响应协议。** 保存 `msgSecCheck({version:2})` 的响应，按下表转换成现有 `success/safe` 协议，避免迫使客户端同步升级：

| 响应 | 返回 | 页面行为 |
| --- | --- | --- |
| `result.suggest === 'pass'` | `success:true, safe:true` | 继续当前提交 |
| `risky` 或 `review` | `success:true, safe:false`，附状态 | 停止提交，保留草稿 |
| 未知值、缺少结论、格式异常 | `success:false, safe:false` | 提示检测暂不可用，可重试 |
| 旧违规异常码 87014 | `success:true, safe:false` | 保留兼容 |
| 网络、权限、配额等异常 | `success:false, safe:false` | 不误报“内容违规”，不继续发布 |

空文本仍可直接通过。审核响应契约测试覆盖 SDK 正常返回违规结论的分支，不能只模拟抛异常。此修复本身不代表所有内容写入入口的服务端审核边界已经完成审计。

**步骤 6：先让云端支持字段更新，再改客户端资料提交。** 当前 `updateUserProfile` 对未提交的昵称和头像会填默认值，因此只改客户端为 PATCH 会引入新的覆盖问题。云端先区分创建与更新：已有用户仅更新允许列表中确实提供的字段，默认值只用于创建；空字符串、null、未提供字段分别验证，不用 `value || default` 统一处理。身份使用 WXContext，不接受客户端指定用户。

保留旧版完整 `userInfo` 提交的兼容性。新客户端头像修改只提交头像相关字段，昵称修改只提交昵称；服务端返回保存后的允许展示的完整资料。资料修改不应顺带累计登录次数，登录统计留在登录处理器。

第一批通过一个小型缓存更新帮助函数同步现有 `userInfo`、`userNickname` 以及存在的 `userLoginData.userInfo`，避免各页面各写一份。绑定成功后统一使用服务端返回的新昵称；修改头像以后不能复活旧昵称。第二批将这些键收敛为唯一 ProfileRepository，第一批不引入完整 Store。

对编辑入口统一读取已有资料，兼容 `custom/edit/wechat/local` 的现有传参；“新建/编辑模式”与“资料来源”分开判断。用户只修改昵称时不得提交默认占位头像覆盖已有头像。旧客户端携带的陈旧完整资料仍可能覆盖新资料，第二批通过版本约束进一步处理。

**步骤 7：修复整个提交状态机。** `callFunction.success` 只代表传输完成，必须检查 `res.result.success === true`。缺少 result、业务拒绝和网络错误都返回统一失败，不调用成功提示。

需要整体整理 `profile.saveUserInfo`：当前外层 catch 会把云端保存失败当作登录失败，再次保存，并在 finally 显示成功；仅在 `saveToCloud` 增加 reject 不足以修复。拆分审核、登录、资料保存三个阶段，登录成功后保存失败不能退回另一个本地身份，也不能隐式重复调用保存。最外层 finally 只清除 loading，不执行成功跳转。

成功保存后才确认云端成功。保留本地模式时明确提示“已保存到本机，云端尚未同步”，保留草稿或可重试状态。头像更新的页面展示可以乐观更新，但失败必须显示未同步，不能在日志里无条件报成功。

**步骤 8：完成测试、联调与发布。** 建议拆成四个可独立 review 的 PR：存储修复；授权和运维参数；审核协议；资料接口与页面状态。各 PR 先跑专项，再跑完整 `npm test`，记录实际结果；本文不会把上次 1057 项通过当作修复后的验收结果。

| 验收场景 | 必须满足的结果 |
| --- | --- |
| 嵌套缓存新增、删除、刷新、重启 | 体验正文、引用和扩展字段保持；记录身份不变 |
| 本机写入失败 | 不宣称保存成功，不启动该记录的云端上传 |
| 普通用户/空身份/伪造事件调用管理 action | 无业务读写、无外部调用，返回拒绝 |
| 昵称不存在、重名、缺目标、非法模式 | 无全库操作；错误码明确 |
| 可信真实定时器 | 可处理正常任务，普通个人操作不受影响 |
| 审核 pass/risky/review/未知/异常 | 严格按上表转换，无错误放行 |
| 绑定新昵称后修改头像 | 本机、页面、云端昵称一致 |
| 昵称或头像单字段更新、旧客户端完整提交 | 未提供字段保持，旧请求仍可用 |
| 审核拒绝、登录失败、业务失败、传输失败 | loading 结束；不重复提交、不误报云端成功 |
| 编辑已有资料 | 初始化原昵称和头像，只保存实际修改 |

建议新增或扩展 `checkinStorageCompatibility.test.js`、`maintenanceAuthorization.test.js`、`contentSecCheckCloud.test.js`、`profileSubmission.test.js`、`profilePatchCloud.test.js`。保留并运行 `todayUploadPolicy`、`legacyCheckinUpload`、`checkinUploadQueue`、`uploadNetworkRecovery`、`checkinRecoveryDelete`、`recordIdempotencyCloud` 等现有测试。测试环境还需验证真实 SDK 审核响应、调用身份和旧客户端兼容性。

**发布与回滚。** 先部署向后兼容的服务端字段更新及审核修复，按步骤 3 切换受保护调度，再发布客户端。体验版验证旧缓存和离线场景之后扩大范围。本批不改变持久化 schema，因此没有数据格式回滚步骤；但客户端不能回退到仍会覆盖体验的旧实现，回退版本必须携带存储修复。权限与审核问题不能通过重新开放旧行为解决，应暂停受影响的管理任务或发布修复版本。

进入第二批的门槛：以上确定性用例通过、真实调度与个人接口联调通过、发布可追溯，且没有新增数据丢失。后续见 [第二批方案](2026-09-22-plan-02-state-and-domain.md) 和 [第三批方案](2026-09-22-plan-03-migration-and-performance.md)。
