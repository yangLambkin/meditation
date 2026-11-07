# 静坐觉察

微信小程序，提供静坐计时、离线记录与补传、静心卡、功课记录、团队练习、勋章和反馈管理。前端使用微信原生小程序与 CommonJS，后端由微信云函数和 bijing-data OpenAPI 提供。

## 本地开发

```sh
npm ci
npm test
```

使用微信开发者工具打开仓库根目录。小程序入口为 `miniprogram/`；依赖统一由根 `package.json` 管理，依赖变更后执行开发者工具「工具 → 构建 npm」。`miniprogram/miniprogram_npm/` 是小程序运行所需构建产物，根 `node_modules/` 由 `npm ci` 安装。

公共配置在 `project.config.json`，个人工具设置在 `project.private.config.json`。云函数有各自的依赖和部署单元，运行本地测试不会部署云函数或访问生产数据。

专项测试：

```sh
npm run test:timer
npm run test:home-checkin
npm run test:team
npm run test:bijing-sync
npm run test:admin
```

其他测试入口见 `package.json`。界面、音频与后台中断行为仍需微信开发者工具和真机验证。

## 目录

| 路径 | 用途 |
| --- | --- |
| `miniprogram/pages/`、`miniprogram/subpackages/team/` | 页面与团队分包 |
| `miniprogram/components/`、`utils/`、`styles/`、`templates/` | 组件、业务逻辑、样式与模板（均位于 `miniprogram/` 下） |
| `cloudfunctions/` | 独立部署的微信云函数 |
| `shared/` | 云函数共用逻辑的源文件；部署目录保留副本 |
| `tests/` | Node.js 回归测试与夹具 |
| `scripts/` | 运维请求工具与图片生成脚本 |
| `docs/`、`工程文档/` | 当前功能、接口、部署与设计说明 |
| `presentations/` | 产品介绍演示及素材 |

## 文档

- [开发约定与关键边界](CODEBUDDY.md)、[脚本使用](scripts/README.md)
- [功课记录与静坐镜像](docs/2026-10-31-practice-records.md)、[团队 OpenAPI](docs/team-openapi.md)、[团队练习统计](工程文档/团队练习统计-2026-09-19.md)
- [计时中断与恢复](docs/2026-11-04-call-interruptions.md)、[收坐铃声](docs/2026-11-06-timer-first-bell.md)
- [离线补传与自动恢复](docs/2026-10-10-auto-sync-recovery.md)、[补录审批](docs/2026-10-05-backfill.md)、[用户反馈](docs/2026-09-29-feedback.md)
- [管控中心与批量同步](docs/2026-09-23-admin-batch-sync.md)、[运维权限及部署门槛](docs/maintenance-access.md)、[绑定迁移记录](docs/2026-09-23-binding-migration.md)
- [数据模型](工程文档/02-数据模型.md)、[云函数接口索引](工程文档/03-云函数接口契约.md)、[勋章规则](工程文档/10-用户等级与勋章逻辑.md)
- [架构待办](docs/architecture-backlog.md)、[更新说明](docs/release_note.md)

带日期的发布记录描述当时的操作与验证，不能据此判断当前线上部署状态。涉及云端配置和数据操作时，以对应功能的最新说明及实际环境核验为准。
