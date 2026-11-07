# 项目脚本

## 运维请求

| 脚本 | 用途 |
| --- | --- |
| `runCleanup.js` | 统计、按日期范围清理或全量清理请求 |
| `runRecomputeBadges.js` | 指定用户或全部用户的勋章报告、重算请求 |
| `runBijingBindingMigration.js` | 历史学号绑定的预览、备份、分批迁移与复核 |
| `lib/maintenanceRunner.js` | 参数解析及受信任调用适配器 |
| `create_team_collections.js` | 团队集合 schema 参考，非 npm 自动执行步骤 |

先使用 `--help` 查看参数。以下命令只打印本地请求，不调用云端：

```sh
node scripts/runCleanup.js stats --env isolated-test --preview
node scripts/runCleanup.js safe --env isolated-test --scope user --openid example-user --start-date 2026-09-01 --end-date 2026-09-02 --preview
node scripts/runRecomputeBadges.js report --env isolated-test --nickname '示例昵称' --preview
```

`safe/full` 默认生成云端只读预览请求，只有显式 `--apply` 才请求删除；没有默认清理日期。勋章默认 `report`，写入模式为 `apply`，必须指定唯一目标。`--preview` 与云端 `dryRun` 不同：前者完全不发请求。

真正调用需要 `MAINTENANCE_INVOKER` 指向已验证的绝对可执行路径，并具备平台运维身份；项目没有提供生产调用适配器。适配器协议、环境核验和权限见 [运维说明](../docs/maintenance-access.md)。绑定迁移的独立参数、备份目录要求和执行步骤见 [绑定迁移说明](../docs/2026-09-23-binding-migration.md)。

## 图片生成

| 命令 | 产物及依赖 |
| --- | --- |
| `swift scripts/generateTabIcons.swift` | 首页、团队、我导航图标及计时选中图标；需要 macOS Swift |
| `node scripts/renderPracticeRecordIcons.js` | 从 SVG 生成记录导航 PNG；需要 `rsvg-convert` |
| `node scripts/renderPracticeShareCovers.js` | 功课分享封面；需要 `rsvg-convert` |
| `node scripts/renderDailyShareCover.js [预览目录绝对路径]` | 静心卡分享封面及可选预览；需要 `rsvg-convert` |

生成器会覆盖对应的仓库资源。源 SVG 和生成 PNG 各有用途，修改后核对生成结果；额外预览文件存放在 `/Users/ripples/cc/Codex` 等本地目录。
