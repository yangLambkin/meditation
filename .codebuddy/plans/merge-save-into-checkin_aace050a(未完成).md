---
name: merge-save-into-checkin
overview: 去掉 recorder 页「保存当前记录」按钮，将体验记录保存合并进「打卡完成」流程：点击打卡完成时同时写入 experience_records 与 meditation_records 并保持关联。
todos:
  - id: remove-save-button
    content: 从 recorder.wxml 删除「保存当前记录」按钮，保留文本输入与「打卡完成」
    status: pending
  - id: merge-save-into-checkin
    content: 删除 recorder.js 的 saveCurrentRecord，并在 completeCheckIn 内联体验记录保存到 experience_records
    status: pending
    dependencies:
      - remove-save-button
  - id: verify-recorder
    content: node --check 语法校验 recorder.js，确认无 saveCurrentRecord 残留引用
    status: pending
    dependencies:
      - merge-save-into-checkin
---

## 用户需求

去掉 recorder 页的「保存当前记录」按钮（点击后提示"保存成功"），改为用户只需点一次「打卡完成」，即可在同一流程中同时写入 `experience_records`（体验记录）与 `meditation_records`（打卡记录）。

## 产品概述

recorder 是冥想结束后的记录页，包含情绪选择、感受文本输入与打卡完成。原交互分两步：先点「保存当前记录」把感受写入 `experience_records`，再点「打卡完成」写 `meditation_records`。现合并为单步：点「打卡完成」时，若文本框非空，先保存体验记录到 `experience_records`（云端+本地），随后立即完成打卡写 `meditation_records`，两个集合在同一按钮动作中落库。

## 核心要点

- 删除 recorder.wxml 中「保存当前记录」按钮，仅保留文本输入与「打卡完成」按钮。
- `completeCheckIn` 内部合并原 `saveCurrentRecord` 的体验记录保存逻辑：文本框非空时构建记录、更新本地展示与存储、调用 `saveExperienceRecord` 写 `experience_records` 并建立 `uniqueId→recordId` 关联。
- 文本框为空时只写 `meditation_records`，不创建空体验记录。
- 沿用现有 `checkinManager.recordCheckin` / `cloudApi.saveExperienceRecord` 通道，不改动云函数与 checkin.js。
- 删除原 `saveCurrentRecord` 方法及其"保存成功/保存失败"提示，统一以打卡成功 toast 收尾。

## 技术栈

- 微信小程序原生（WXML/WXSS/JS，CommonJS，2 空格缩进无分号，日志用 emoji 前缀），云开发云函数通道（cloudApi + meditationManager）。
- 本次不涉及新库/新架构，复用既有 `saveExperienceRecord`、`saveRecordsToStorage`、`checkinManager.recordCheckin`。

## 实现方案

### 总体策略

采用"删除独立保存入口 + 在打卡动作内联体验保存"的最小改动策略：移除 `saveCurrentRecord` 方法与按钮，把其体验记录落库逻辑（构建 newRecord → 更新 savedRecords + meditationTextRecords → `await saveExperienceRecord` 写云端并建立 `experienceRecordIds` 映射）前移到 `completeCheckIn` 开头。

### 关键技术决策

1. **复用现有封装**：体验记录云端写入直接调用既有 `this.saveExperienceRecord(newRecord)`（L484，内部走 `cloudApi.saveExperienceRecord` 写 `experience_records` 并 `checkinManager.saveExperienceRecordToLocal` 同步本地）；本地文本落地复用 `this.saveRecordsToStorage`。不重复造云调用，DRY。
2. **保持 experience 数组形态不变**：`completeCheckIn` 仍把 `this.data.savedRecords` 作为 experience 传给 `checkinManager.recordCheckin`（与现状一致），以兼容 history 页展示逻辑；本次不改动 `meditation_records.experience` 的元素结构（是否携带云端 `_id` 为既有设计，超出本次范围，避免回归）。
3. **条件保存**：仅当 `currentText.trim()` 非空才构建并保存体验记录；为空则跳过，只走打卡。`saveExperienceRecord` 现有降级逻辑（云端失败仍返回 success 并存本地）保证不阻断打卡。
4. **清理死代码**：删除 `saveCurrentRecord` 整体（L213-318）；移除 `completeCheckIn` 中仅用于日志、未参与关联的 `experienceRecordIds` 收集块（L598-630）；统一以「打卡成功！今日第N次打卡」toast 收尾，不再有"保存成功"提示。
5. **保留删除能力**：`deleteRecord` / `syncDeleteRecord` 逻辑不变（基于 savedRecords 与 `experienceRecordIds` 映射，删除时清理云/本地数据），保证已展示记录可删。

### 性能与可靠性

- 每次打卡最多新增 1 次 `experience_records` 云写入 + 原有 1 次 `meditation_records` 云写入，无新增循环或查询，性能零影响。
- 体验记录保存失败被 try/catch 包裹且不影响后续打卡，用户体验稳定。
- 风格一致性：小程序端 2 空格无分号、emoji 前缀日志、简体中文文案，与现有代码对齐。

## 实现注意事项

- 构建 newRecord 时 `emotion` 取 `this.getSelectedEmotions()`、`duration` 取 `this.data.durationText || '7分钟'`、`uniqueId` 取 `Date.now()`、`sessionId` 取 `this.data.sessionId`、`timestamp` 用 `YYYY-MM-DD HH:MM:SS` 本地格式（与原 `saveCurrentRecord` 一致）。
- 保存成功后必须更新 `savedRecords`（setData 前置清空 currentText）与 `meditationTextRecords` 本地存储，再 `await saveExperienceRecord`，确保 `recordCheckin` 能拿到最新 savedRecords。
- 删除按钮后检查 wxml 不再存在 `bindtap="saveCurrentRecord"`；`saveCurrentRecord` 方法体整段移除。

## 架构设计

数据流保持原有 two-tier 结构，仅触发点合并：

- 点击「打卡完成」→ `completeCheckIn`：
- (a) 若文本非空：`saveExperienceRecord` → `cloudApi.saveExperienceRecord` → 写 `experience_records`（云端）+ 本地缓存与 `experienceRecordIds` 映射。
- (b) `checkinManager.recordCheckin(duration, emotion, savedRecords)` → `asyncBackupToCloud` → `cloudApi.recordMeditation` → 写 `meditation_records`（云端）。
- 两个集合写入均由同一按钮动作触发，无独立保存入口。

## 目录结构与改动文件

```
miniprogram/
├── pages/recorder/recorder.wxml   # [MODIFY] 删除「保存当前记录」按钮（L53-55 整段 view），保留 textarea 与「打卡完成」按钮；已保存记录展示区保留
└── pages/recorder/recorder.js     # [MODIFY] 删除 saveCurrentRecord 方法（L212-318）；重构 completeCheckIn（L588-682）：开头内联体验记录保存（非空时构建 newRecord、更新 savedRecords/meditationTextRecords、await saveExperienceRecord 并建立 experienceRecordIds 映射），移除仅日志用的 experienceRecordIds 收集块，保留后续 recordCheckin、兼容存储与 toast/跳转
```

（cloudfunctions/*、utils/checkin.js、utils/cloudApi.js 经核实无需改动）