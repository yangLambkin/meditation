---
name: merge-save-into-checkin
overview: 去掉 recorder 页「保存当前记录」按钮及已保存记录展示/删除逻辑，「打卡完成」一次性写入 experience_records 与 meditation_records。
todos:
  - id: remove-save-button-wxml
    content: recorder.wxml 删除保存按钮与已保存记录展示区
    status: pending
  - id: refactor-complete-checkin
    content: recorder.js 删除旧方法并重构 completeCheckIn 合并体验记录保存
    status: pending
    dependencies:
      - remove-save-button-wxml
  - id: cleanup-wxss
    content: recorder.wxss 清理无引用样式
    status: pending
  - id: verify-recorder
    content: node --check 校验 recorder.js 并确认无残留引用
    status: pending
    dependencies:
      - refactor-complete-checkin
      - cleanup-wxss
---

## 用户需求

1. 去掉 recorder 页「保存当前记录」按钮（点击后提示"保存成功"）。
2. 点击「打卡完成」时一次性同时写入 `experience_records`（体验记录）与 `meditation_records`（打卡记录）。
3. 一并删除 recorder 页原有的「已保存的记录」展示区与删除逻辑，因为点击「打卡完成」后直接跳转到日签页面，用户没有机会再点击删除。

## 产品概述

recorder 是冥想结束后的记录页，包含情绪选择、感受文本输入与打卡完成。原交互分两步：先点「保存当前记录」把感受写入 `experience_records`，再点「打卡完成」写 `meditation_records`。现合并为单步：点「打卡完成」时，若文本框非空则先保存体验记录到 `experience_records`（云端+本地），随后立即完成打卡写 `meditation_records`，两个集合在同一按钮动作中落库；文本框为空则只写打卡记录。原「已保存的记录」列表与删除入口因点击即跳转而永远不可达，整体移除。

## 核心要点

- recorder.wxml 删除「保存当前记录」按钮与「已保存的记录」展示区（含删除按钮），保留文本输入、字数统计与「打卡完成」。
- `completeCheckIn` 内联合并原 `saveCurrentRecord` 的体验记录保存逻辑。
- 文本框非空时构建体验记录、写入 `meditationTextRecords` 本地存储（供历史页兼容读取）、`await saveExperienceRecord` 写 `experience_records`，并以该记录作为 `experience` 传入 `recordCheckin`。
- 文本框为空时只写打卡记录，不创建空体验记录。
- 删除 `saveCurrentRecord`/`loadSavedRecords`/`deleteRecord`/`syncDeleteRecord` 死代码，以及不再被读取的 `experienceRecordIds` 映射。

## 技术栈

- 微信小程序原生（WXML/WXSS/JS，CommonJS；2 空格缩进无分号；日志用 emoji 前缀），云开发云函数通道（`cloudApi` + `meditationManager`）。
- 本次不引入新库/新架构，复用既有 `saveExperienceRecord`、`saveRecordsToStorage`、`checkinManager.recordCheckin`。`cloudfunctions/*`、`utils/checkin.js`、`utils/cloudApi.js` 经核实无需改动。

## 实现方案

### 总体策略

采用"删除独立保存/删除入口 + 在打卡动作内联体验保存"的最小改动策略：移除 `saveCurrentRecord`/`deleteRecord`/`syncDeleteRecord`/`loadSavedRecords` 方法与对应 UI，把体验记录落库逻辑（构建 `newRecord` → 更新 `meditationTextRecords` 本地存储 → `await saveExperienceRecord` 写云端并同步本地缓存）前移到 `completeCheckIn` 开头。

### 关键技术决策

1. **复用现有封装**：体验记录云端写入直接调用既有 `this.saveExperienceRecord(newRecord)`（内部走 `cloudApi.saveExperienceRecord` 写 `experience_records` 并 `checkinManager.saveExperienceRecordToLocal` 同步本地）；本地文本落地复用 `this.saveRecordsToStorage`（写入 `meditationTextRecords`）。不重复造云调用，符合 DRY。
2. **保留 `meditationTextRecords` 写入**：`history.js` 在统一本地缓存未命中时会回退读取 `meditationTextRecords` 做兼容迁移，因此打卡时仍需向该存储追加本次体验记录（采用与原 `saveCurrentRecord` 一致的"读取全部→前置插入→整体写回"累加方式），避免历史页旧链路断裂。
3. **experience 数组形态不变**：`completeCheckIn` 将本次体验记录对象数组（非空时 `[newRecord]`，为空时 `[]`）传给 `checkinManager.recordCheckin(duration, emotion, experience)`，与现状一致，兼容 history 页展示逻辑；不改变 `meditation_records.experience` 的元素结构，避免回归。
4. **条件保存**：仅当 `currentText.trim()` 非空才构建并保存体验记录；为空则跳过，只走打卡。`saveExperienceRecord` 现有降级逻辑（云端失败仍返回 success 并存本地）保证不阻断打卡。
5. **清理死代码**：删除 `saveCurrentRecord`/`loadSavedRecords`/`deleteRecord`/`syncDeleteRecord` 整体；移除 `completeCheckIn` 中仅用于日志、未参与关联的 `experienceRecordIds` 收集块；`experienceRecordIds` 存储映射在删除 `deleteRecord` 后已无任何读取方，一并停止写入；`data` 中 `savedRecords`、`sessionId` 不再被任何逻辑/wxml 引用，移除以精简状态。统一以「打卡成功！今日第N次打卡」toast 收尾，不再有"保存成功"提示。

### 性能与可靠性

- 每次打卡最多新增 1 次 `experience_records` 云写入 + 原有 1 次 `meditation_records` 云写入，无新增循环或查询，性能零影响。
- 体验记录保存失败被 `saveExperienceRecord` 内部 try/catch 包裹且不影响后续打卡，用户体验稳定。
- 风格一致性：小程序端 2 空格无分号、emoji 前缀日志、简体中文文案，与现有代码对齐。

## 实现注意事项

- 构建 `newRecord` 时字段与原 `saveCurrentRecord` 对齐：`text: currentText.trim()`、`timestamp` 用 `YYYY-MM-DD HH:MM:SS` 本地格式、`emotion: this.getSelectedEmotions()`、`duration: this.data.durationText || '7分钟'`、`uniqueId: Date.now().toString()`。
- 体验记录保存成功与否都不影响后续 `recordCheckin`，因此先 `await saveExperienceRecord` 再 `recordCheckin`，以 `newRecord` 作为 experience 入参。
- `meditationTextRecords` 写回须累加（读取现有数组前置插入），不可整体覆盖。
- 删除按钮后确认 wxml 不再存在 `bindtap="saveCurrentRecord"`、`bindtap="deleteRecord"`；对应 js 方法整段移除。
- `recorder.wxss` 中 `saved-records-*`、`record-*`、`delete-btn`、`delete-icon` 等已无引用的样式顺带清理，避免样式冗余。

## 架构设计

数据流保持原有 two-tier 结构，仅触发点合并：

- 点击「打卡完成」→ `completeCheckIn`：
- (a) 若文本非空：`saveExperienceRecord` → `cloudApi.saveExperienceRecord` → 写 `experience_records`（云端）+ 本地缓存；同时 `saveRecordsToStorage` 写 `meditationTextRecords`。
- (b) `checkinManager.recordCheckin(duration, emotion, [newRecord])` → `asyncBackupToCloud` → `cloudApi.recordMeditation` → 写 `meditation_records`（云端）。
- 两个集合写入均由同一按钮动作触发，无独立保存/删除入口。

## 目录结构与改动文件

```
miniprogram/
├── pages/recorder/recorder.wxml   # [MODIFY] 删除「保存当前记录」按钮（原 L53-55 整段 view）与「已保存的记录」展示区（原 L58-77 含删除按钮）；保留 textarea、字数统计、「打卡完成」按钮
├── pages/recorder/recorder.js     # [MODIFY] data() 删除 savedRecords/sessionId；onShow() 移除对应重置；删除 saveCurrentRecord/loadSavedRecords/deleteRecord/syncDeleteRecord 方法；重构 completeCheckIn：开头内联体验记录保存（非空时构建 newRecord、累加写入 meditationTextRecords、await saveExperienceRecord），移除仅日志用的 experienceRecordIds 收集块，保留后续 recordCheckin、meditationRecords[dateStr] 兼容存储与 toast/跳转；保留 saveRecordsToStorage 与 saveExperienceRecord
└── pages/recorder/recorder.wxss   # [MODIFY] 清理已无引用的 saved-records-*/record-*/delete-btn/delete-icon 样式（功能无关，建议一并清理）
```

（cloudfunctions/*、utils/checkin.js、utils/cloudApi.js 经核实无需改动）