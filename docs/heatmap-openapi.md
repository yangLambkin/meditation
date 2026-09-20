# 热力图改用 data OpenAPI

## 接口清单

当前查看热力图的调用链：

`bijingHeatmap 页面 → bijingApi.getBijingHeatmap() → bijingSync({ type: 'getHeatmap' }) → data OpenAPI`

点击「查看热力图」、下拉刷新或失败重试时，每次加载只调用下面一个 data 接口；年度图表和点击方格的时长展示均在小程序本地处理。

| 用途 | 改造前 | 改造后 |
| --- | --- | --- |
| 读取绑定学号的全部每日静坐时长和昵称 | `GET /api/qqb/meditation/record/public/heatmap?studentNumber=...`，无 Token | `GET /api/openapi/meditation/heatmap?studentNumber=...`，使用 `X-Access-Token` |

关联流程原本已使用 OpenAPI，本次不改变：

- 校验/绑定学号：`GET /api/openapi/users/{studentNumber}`。
- 同步静坐时长：`POST /api/openapi/meditation/records`。

## 调用约定

- 基地址取云函数环境变量 `BIJING_API_BASE`；测试为 `https://data.bjzl.net.cn`，生产为 `https://data.bijing.life`。
- `X-Access-Token` 取云函数环境变量 `BIJING_ACCESS_TOKEN`，复用现有绑定/同步鉴权配置。
- 查询参数 `studentNumber` 仅从当前微信 `OPENID` 对应的云端绑定记录读取，忽略客户端传入的学号和 Token。
- 超时为 10 秒；未登录、未绑定或未配置 Token 时不发起 data 请求。调用失败不降级到公开接口。
- data OpenAPI 与原公开接口共用同一查询，返回结构和按日汇总口径不变。

成功响应：

```json
{
  "success": true,
  "data": {
    "studentNumber": "BJ123456",
    "nickname": "静心者",
    "records": [{ "date": "2026-09-19", "duration": 30 }]
  }
}
```

data 端的参数错误、鉴权失败、用户不存在和查询异常分别返回 HTTP 400、401、404、500。云函数继续统一返回小程序使用的 `{ success, data, error }`，过滤无效日期/时长及多余字段，异常详情不传给小程序。

## 发布顺序与验证

1. 先发布 `bijing-data` 新增的 `/api/openapi/meditation/heatmap` 路由；原先 data 端没有此 OpenAPI 查询接口。
2. 再上传并部署 `bijingSync` 云函数，包含 `index.js` 与 `heatmap.js`，保留各环境的 `BIJING_API_BASE` / `BIJING_ACCESS_TOKEN` 配置。
3. 使用已绑定账号查看热力图，核对昵称、各年天数/分钟数、空年度和下拉刷新。此调用改造无需调整原生热力图页面。

本地回归命令：

```sh
node --test tests/heatmap.test.js tests/bijingSync.test.js tests/bijingCheckinIntegration.test.js
```

覆盖 OpenAPI 路径与请求头、服务端绑定身份、云函数入口的凭证传递、未登录/未绑定/缺失 Token、鉴权失败无公开接口回退，以及图表与同步链路回归。
