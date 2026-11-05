# 团队按来源接入 bijing-data

新建团队通过 `teamManager` 云函数调用 bijing-data 的 `/api/openapi/teams`，微信不再新建团队文档。原团队 ID 保持不变，资料、成员、邀请和静坐统计继续走原微信数据库；不迁移历史团队，不双写。

新平台团队对小程序使用 `bijing_<id>`，其他平台成员使用 `bijing_member_<memberId>`，当前操作者映射为当前微信 OPENID。路由由 ID 决定，不采信客户端 `source`。新团队的详情、编辑、解散、成员操作、邀请加入、报表、历史及成员记录全部由 OpenAPI 提供，失败不回退微信写入。

## 功课标签和统计

创建时选择 `sitting` 静坐觉察、`walking` 走路觉察、`instant` 即刻觉察、`learning` 熏习、`kindness` 日行一善或 `clapping` 禅拍，之后不可更改。列表、详情和邀请显示类型标签；目标、统计、提醒和记录按分钟／次／件显示。旧团队默认静坐。

新团队统计读取 data 的个人功课明细，未同步到 data 的微信历史不会自动出现；按北京时间 02:00 切换练习日。为兼容既有页面，云函数的 `dailyGoalMinutes`、`todayMinutes` 等旧字段名保存对应功课的实际数量，另带 `practiceType`、`unit`。成员记录和历史明细使用 data 的不透明游标。

## 身份、重试和编辑

云函数仅信任 `cloud.getWXContext().OPENID`，从唯一的有效云端绑定取得学号，版本化绑定同时核实 `bijing_bindings` 双向登记。请求前后重新检查绑定，忽略客户端传入的学号、操作者和角色。未绑定者可以浏览公共预览，创建、加入及成员数据需绑定本人学号。

团队接口额外要求仅保存在服务端的 `BIJING_TEAM_ACCESS_TOKEN`，避免小程序包中已有的通用功课凭据被用来跳过云函数绑定校验。OpenAPI 不提供平台管理员操作。

创建前按账号、完整表单持久化 `operationKey`，失败重试复用同一个 `Idempotency-Key`，成功后清除。审核通过的云头像由云函数下载后上传 data；data 对规范化图片生成稳定地址，避免头像重传改变幂等载荷。编辑提交页面看到的 `expectedVersion`，交接提交原团长，过期页面由 data 拒绝。

## 发布配置

1. 先发布包含团队 OpenAPI 的 bijing-data 版本（契约见该仓库 `docs/openapi-teams.md`）。在 data 服务环境和微信 `teamManager` 云函数设置相同的 `BIJING_TEAM_ACCESS_TOKEN`，使用至少32字符的随机值，与通用服务令牌不同，不写入小程序配置。
2. 为 `teamManager` 设置 `BIJING_API_BASE` 和 `BIJING_ACCESS_TOKEN`，与 `bijingSync` 对应环境一致；安装依赖并部署完整云函数目录，超时设为60秒。测试基地址 `https://data.bjzl.net.cn`，生产 `https://data.bijing.life`。
3. 发布小程序。将对应 data 域名加入小程序 downloadFile 合法域名（包括头像读取），验证头像、邀请及长名单提醒导出。data 头像存储沿用平台 OSS 配置。
4. 使用已绑定账号验收：旧团队读取与管理、新团队创建／超时重试、六类标签和单位、邀请多人加入、角色调整及交接、解散、月份和游标分页。旧团队和微信个人历史不执行生产迁移。

`npm run test:team` 覆盖来源路由、绑定身份、API 参数与结果适配、稳定创建请求、旧团队回归、功课单位、邀请和分页。实际发布前仍需两端环境配置和微信真机联调。
