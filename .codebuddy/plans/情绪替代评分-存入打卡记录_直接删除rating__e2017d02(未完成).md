---
name: 情绪替代评分-存入打卡记录（直接删除rating）
overview: 将 recorder 页的情绪选择结果（字符串数组）存入 meditation_records.emotion，直接删除 rating 逻辑与字段（用户数据少，无需兼容旧 rating 数据，不做迁移）。改动覆盖前端链路改名、云函数字段改名、history 页五星星逻辑替换、以及 schema 定义更新。
todos:
  - id: rename-frontend-chain
    content: recorder.js/checkin.js/cloudApi.js 将 rating 参数与字段统一改为 emotion
    status: pending
  - id: update-meditationManager
    content: meditationManager.recordMeditation 写入 emotion 并删除 rating
    status: pending
  - id: update-history-ui
    content: history.js 去除五星逻辑改输出 emotions，history.wxml 展示情绪标签
    status: pending
  - id: update-schema
    content: autoCreateCollections 与 create_collections_consistent 改为 emotion，删除 experience_records 死 rating
    status: pending
  - id: lint-verify
    content: 对所有改动文件做 node --check 语法校验
    status: pending
    dependencies:
      - rename-frontend-chain
      - update-meditationManager
      - update-history-ui
      - update-schema
---

## 用户需求

将 recorder 页的「情绪选择」结果（字符串数组）以 `emotion` 字段存入每次打卡记录 `meditation_records`，彻底移除 rating 逻辑。

## 产品概述

recorder 页已用情绪选择滑块替代原 5 星评分，`getSelectedEmotions()` 返回字符串数组（选了子情绪则为子情绪名数组，否则为 `[主情绪名]`）。当前情绪数据借道 `rating` 通道写入（recorder → checkin → cloudApi → meditationManager → `meditation_records.rating`），导致字段名与真实语义、schema 注释均不一致。本次将通道字段统一改名为 `emotion`，并清理所有 rating 残留与死字段。

## 核心要点

- 数据模型：`meditation_records` 新增 `emotion`（string[]，如 `['平静','感恩']` 或 `['不悲不喜']`），删除 `rating`。
- 全链路改名：recorder.js → checkin.js → cloudApi.js → meditationManager 全部 `rating` 语义改为 `emotion`。
- history 页移除已失效的 5 星计算逻辑（wxml 实际未渲染星标），改为展示 `emotion` 情绪标签。
- schema 约定更新：`autoCreateCollections` 与 `create_collections_consistent` 的样例/字段定义改为 `emotion`；删除 `experience_records` 从未被写入的死字段 `rating`。
- 用户已明确：数据量小，无旧 rating 数据需保留，**不做兼容读取、不做存量迁移**，直接删除。

## 技术栈

- 微信小程序（CommonJS，2 空格无分号）+ 云开发云函数（`meditationManager` 单 dispatch 模式）。
- 数据库：云开发文档型 DB，schemaless，无强制 schema；"改数据库"= 更新样例/约定生成器，无需数据迁移（用户已确认）。

## 实现方案

### 总体策略

全链路将 `rating` 语义替换为 `emotion`（类型 `string[]`），采用「直接改名、彻底清除」路径。因用户确认无历史 rating 数据需保留，不做 `emotion || rating` 兼容读取，也不部署迁移云函数，最大化简化改动、避免引入过渡态复杂度。

### 关键技术决策

1. **前端链路重命名**：`recorder.js` → `checkin.js`（recordCheckin / recordToLocal / asyncBackupToCloud / formatCloudRecord / rebuildLocalCacheFromCloudRecords / 同步循环）→ `cloudApi.recordMeditation` 统一将参数名与字段名 `rating` 改为 `emotion`。所有取值直接用 `emotion`，不回退 `rating`。
2. **云函数直写 `emotion`**：`meditationManager.recordMeditation` 改为 `emotion: data.emotion || []`，删除 `rating` 写入（已核实云函数无读取 rating 逻辑）。
3. **history 去星逻辑**：`history.js` 中 L170-172 的 5 星计算（`i < (record.rating||0)`）因 rating 已为数组而失效且 wxml 未渲染，直接删除，改为输出 `emotions: record.emotion || []`；L322 本地体验记录映射的 `rating` 一并改为 `emotion` 保持一致。
4. **history.wxml 情绪标签**：在打卡明细项（`wx:for="{{recordList}}"` 内）新增 `wx:for="{{item.emotions}}"` 展示情绪标签，替换原星标位（原星标从未渲染）。
5. **删除死字段**：`create_collections_consistent.js` 中 `experience_records.fields.rating` 运行时从未被 `saveExperienceRecord` 写入，予以删除；`meditation_records` 字段 `rating` 改为 `emotion`。

### 性能与可靠性

- 改动均为字段/变量改名与一处 UI 文案调整，无新增查询或循环，性能零影响。
- 删除 5 星计算后减少一次 `Array.from({length:5})` 映射，逻辑更清晰。
- 后端/前端同步改名，发布后新打卡记录统一为 `emotion`，无双写窗口问题（无需兼容旧客户端，因无历史 rating 数据）。

## 实现注意事项

- 保持现有代码风格：2 空格缩进、小程序端无分号、云函数端有分号。
- `checkin.js` 多处 `rating` 为函数形参与本地对象字段，需同步改名避免引用错位（重点核对 L682/L701/L743/L771/L783/L435/L641/L1074）。
- `recorder.js` 的 `meditationRecords[dateStr]` 本地缓存 key 内容（`rating`→`emotion`）与 `newRecord.rating`（单条体验记录）一并改名；L601 冗余 `rating` 变量直接删除。
- `cloudApi.recordMeditation` 签名与 payload 同步改 `emotion`，确保与 `meditationManager` 入参对应。

## 架构设计

本次为字段语义统一重构，不引入新模块/新架构。数据流保持原 two-tier 结构：recorder（前端）→ checkin（本地优先）→ cloudApi → meditationManager（云函数）→ meditation_records。仅字段名 `rating`→`emotion` 贯穿全链。

## 目录结构与改动文件

```
miniprogram/
├── pages/recorder/recorder.js     # [MODIFY] newRecord.rating→emotion、删除冗余 rating 变量、传参 recordCheckin、meditationRecords[dateStr].rating→emotion
├── pages/history/history.js        # [MODIFY] 删除 5 星计算，输出 emotions 数组；本地体验记录映射 rating→emotion
├── pages/history/history.wxml      # [MODIFY] 打卡明细项新增情绪标签渲染（wx:for emotions）
├── utils/checkin.js                # [MODIFY] recordCheckin/recordToLocal/asyncBackupToCloud 参数与 newRecord.rating→emotion；formatCloudRecord、rebuildLocalCacheFromCloudRecords、同步循环读取 rating→emotion
└── utils/cloudApi.js               # [MODIFY] recordMeditation(duration, emotion, experience) 及 payload

cloudfunctions/
└── meditationManager/index.js      # [MODIFY] recordMeditation 写入 emotion（删除 rating 写入）

create_collections_consistent.js    # [MODIFY] meditation_records 字段 rating→emotion；删除 experience_records.fields.rating

cloudfunctions/autoCreateCollections/index.js  # [MODIFY] meditation_records.sampleData rating:4 → emotion:['不悲不喜']
```