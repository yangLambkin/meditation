# 现有必经绑定迁移

`adminManager.adminMigrateBindings` 将 `users` 中现有且唯一的有效绑定纳入 `bijing_bindings`，用户不需要解绑或重新绑定。入口只接受微信 SDK 的真实管理员身份；管理员名单仍来自 `ADMIN_STUDENT_NUMBERS`。

## 数据行为

- 只补 `users.bijingBindingVersion` 和缺失的 `student`、`account` 双向登记。已有版本号保持不变。
- 保留原学号写法、昵称、绑定时间、同步日期、更新时间及其他用户资料，不调用外部必经 API，不修改静坐记录。
- 每人使用独立事务，和现行绑定/解绑共用两条登记的 revision 校验。失败可从原游标重试；完整重复执行不会再次写入已迁移记录。
- 重复账号、重复学号、非法资料、登记冲突仅报告，不自动选择归属，也不清除原绑定。
- 预览是默认行为。`dryRun: false` 才写入。预览返回完整相关用户/登记快照，供受限本地备份与迁移后比对；不要提交这些快照到 Git。

## 执行前提

1. 所有线上绑定、解绑入口已经使用 `bijingSync/bindings.js` 的双向登记事务。
2. `bijing_bindings` 已创建，客户端禁止读写；`users` 禁止客户端直接写入。
3. 部署 `adminManager/bindingMigration.js` 和支持 `adminMigrateBindings` 的入口。先上传模块，等待函数 Active 后再更新入口。
4. 使用已经登录且绑定管理员学号的微信开发者工具会话。

单次接口默认最多 20 人，处理约 20 秒后返回已完成的游标。此次执行时 `adminManager` 的时限为 3 秒，执行脚本固定使用每次 1 人；时限仍为 3 秒时不要直接以默认 20 人运行。大量迁移应先在云开发控制台调整时限，再按实际性能设置批量。

## 执行方式

脚本连接现有官方 `miniprogram-automator` 会话，不重新启动项目。`MINIPROGRAM_AUTOMATOR_MODULE` 可指定已安装模块的绝对路径，默认加载 `miniprogram-automator`；`MINIPROGRAM_AUTOMATOR_ENDPOINT` 默认 `ws://127.0.0.1:9420`。

```sh
# 只读预览；output 必须为一个尚不存在的私人目录。
node scripts/runBijingBindingMigration.js \
  --env cloud1-2g2rbxbu2c126d4a --output /private/tmp/bijing-binding-preview

# 先完整备份/预览，再写入，最后重新扫描比对并复核管理员权限。
node scripts/runBijingBindingMigration.js \
  --env cloud1-2g2rbxbu2c126d4a --output /private/tmp/bijing-binding-migration --apply
```

输出目录权限为 `0700`，文件为 `0600`，包含 `preview.json`、`apply.json`、`verify.json` 与 `summary.json`。只有全部绑定纳入管理、无冲突、既有资料比对一致且管理员仍获授权时，`summary.completed` 才为 `true`。中途失败保留已收集报告，可以使用新的输出目录重新运行。

## 验证

测试覆盖资料保留、管理员权限延续、无需重绑即可解绑、默认只读、权限拒绝、重复扫描零写、并发绑定/解绑、事务回滚、冲突登记以及超过 100 人的游标分页。

线上执行结果以本文件后续记录和受限备份中的报告为准，代码部署本身不代表已经迁移。

## 正式环境执行结果

2026-09-23 北京时间 22:36:05 至 22:37:30，在 `cloud1-2g2rbxbu2c126d4a` 已完成迁移：

| 阶段 | 结果 |
| --- | --- |
| 预检与备份 | 19 个已绑定用户，19 份完整相关快照，0 冲突 |
| 事务迁移 | 19 人成功，新增 38 条有效双向登记 |
| 重新扫描 | 19 人均为 `already_managed`，待迁移 0、冲突 0 |
| 用户资料比对 | 19 人除新增绑定版本号外，全部原有字段一致 |
| 登记校验 | 38 条记录的 ID、类型、归属、学号、版本号、有效状态及 revision 均符合要求 |
| 管理员权限 | 实际会话再次调用 `getAccess`，仍为 `isAdmin: true` |

用户无需重新绑定；迁移代码没有访问或修改静坐记录，也没有调用外部必经接口。完整本地测试通过 1,472 项。

备份目录：`/Users/ripples/Documents/meditation-backups/bijing-bindings-20260923-2235`。`summary.json` 的 `completed` 为 `true`，`verification.differences` 为空。该目录不在 Git 仓库内。

本次云端只在当时的 `adminManager` 代码上增量加入迁移模块与直接管理员入口；没有夹带工作区另一个任务的跨函数 delegation 修复。后续完整部署 `adminManager` 时须保留本地已合并的迁移模块及入口。
