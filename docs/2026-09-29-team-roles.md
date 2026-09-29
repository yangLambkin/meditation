# 团队副团长与团长交接

团长在团队详情的成员列表长按其他成员，可设置或取消副团长、交接团长、移除成员。每个团队最多 7 位副团长，副团长仍计入团队原有的 50 人上限。

| 操作 | 团长 | 副团长 | 普通成员 |
| --- | --- | --- | --- |
| 查看团队及成员练习记录 | 可 | 可 | 可 |
| 生成提醒长图、邀请成员 | 可 | 可 | 不可 |
| 编辑团队、练习规则 | 可 | 不可 | 不可 |
| 任免副团长、移除成员、解散团队 | 可 | 不可 | 不可 |
| 交接团长身份 | 可 | 不可 | 不可 |

交接对象可以是普通成员或副团长。交接后原团长保留为普通成员；新团长如原为副团长，会释放副团长名额。团长不能直接退出团队，须先交接或解散。退出或被移除的副团长会释放名额。

## 数据及接口

`teams.creator` 表示当前团长，`creatorName` 为其昵称；`deputyLeaders` 是去重的副团长 OpenID 数组，仅包含当前成员并排除团长。旧团队缺少该字段时按空数组处理，无需批量迁移。`team_members.role` 使用 `creator`、`deputy`、`member`。权限以团队文档为准，角色关系在事务中同步。

新增 `teamManager` 云函数操作，参数放在 `data` 中，调用者身份仅取微信 SDK 上下文：

- `setTeamDeputy`：`{ teamId, memberOpenid, isDeputy }`，`isDeputy` 必须为布尔值，仅团长可调用。事务内检查成员及 7 人上限，重复设置不重复占位。
- `transferTeamLeader`：`{ teamId, newLeaderOpenid, expectedLeaderOpenid }`，仅当前团长可调用，旧页面携带的团长与当前值不一致时拒绝执行。团长信息、原团长和新团长的成员角色、副团长名额一起提交。

两接口返回 `{ success, data: { teamId, creator, creatorName, members, memberCount, deputyLeaders } }`，其中 `members` 是 OpenID 数组。客户端确认成功后同步个人及已加入团队缓存，并使公共团队缓存失效；失败不预先修改权限。

团队资料、练习报表及历史明细中的成员返回 `isCreator`、`isDeputy`、`role`。`getTeamPracticeReport` 另含 `creator` 和 `deputyLeaders`，提醒生成前重新取报表并校验最新身份。公开预览只展示角色，不暴露副团长 OpenID 数组。

`generateInvite`、`recordInviteAction` 允许当前团长和副团长。加入时再次验证邀请签发人仍有邀请权限；交接后原团长、已撤销身份或已离队副团长此前发出的邀请不能再用于加入。现有 7 天有效期保持不变。后台管理员交接也同步副团长名额与成员角色，保留现有审计事务。

## 发布与验证

先部署 `cloudfunctions/teamManager`，再发布小程序。使用现有集合与索引，不需要新增集合；团队及成员关系的写入仍通过云函数。

本地验证：`npm run test:team`、`node --test tests/adminTeams.test.js`。在微信开发者工具或真机核对长按菜单、团长和副团长分享、提醒长图、交接确认及交接后入口变化。本次代码修改不代表云端已经发布。
