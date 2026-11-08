# 计时器模块

唯一实现基于 V3.0.8 之前的提交 `85fc7c50a21bf0398303d5ed0d8c122ed2ca3956`（V3.0.7）。保留历史计时、暂停、重置、固定铃声、引导音频与完成保存流程，只增加系统来电、闹钟中断后延续同一计时的能力。历史来源与资源校验见 [SOURCE.md](SOURCE.md)。

## 文件与接口

| 文件 | 职责与关键接口 |
| --- | --- |
| `index.js` | `createTimerModule({ api, host, recordCheckin })` 创建应用级运行时；`createTimerPage()` 装配唯一页面 |
| `runtime.js` | `onLaunch/onShow/onHide` 接收应用与音频中断事件；`getCountdownSession()` 延迟创建倒计时；保管离页的正计时及待保存结果；`getCompletionNotice()` 提供首页通知 |
| `countdownSession.js` | `start/pause/resume/finish/cancel` 管理倒计时；`appShow/appHide` 与 `audioInterruptionBegin/End` 分别处理应用可见性和音频抢占；`attach` 投影状态；`restore` 恢复检查点；`markCompletionSaved` 清除已保存草稿；`dispose` 清理回调 |
| `definition.js` | 页面工厂 `createPage({ api, app })`；正计时、操作与弹窗、历史播放器及中断恢复 |
| `interruption.js` | `isExplicitTimerExit(options)` 区分主动退出与被动系统中断 |
| `screenBrightness.js` | 原有常亮/亮度恢复逻辑 |
| `view.wxml / view.wxss` | 历史页面结构和样式，适配普通页面安全区 |
| `audio/` | 原版起坐、收坐铃声，随主包可用 |

页面固定为 `/pages/timer/timer`，直接引用模块的页面工厂、模板和样式。没有版本选择、管理员配置、配置云请求或计时器分包。`app.js` 仅转发生命周期。`utils/countdownSession.js` 与 `utils/screenBrightness.js` 是兼容导出。记录、心得审核、日签图片和日签页面继续使用宿主已有服务。

接口约束：`createPage` 的 `app` 参数是计时器运行时，不是原始 `getApp()` 对象。`recordCheckin(duration, emotion, experience, endedAt, sessionId)` 必须同步完成本机保存并返回 `{ success: true }`；云端上传由记录服务异步处理，不能替换成只返回 Promise 的保存函数。`handOffCountup/claimCountup/getDetachedCountupExit/markCompletionSaved` 负责正计时离页交接、领取和保存确认；`persistDetachedCountupExit` 在返回前台时重试终态落盘，读取失败时不写入，也不覆盖另一 `sessionId` 的状态。

## 核心流程

1. 开始时生成一次 `sessionId`，记录起点；5 秒后播放起坐铃声，播完才播放用户选择的引导音频。计时不依赖音频播放成功。
2. 时间按起点、当前时间和累计暂停时间计算，前台定时回调用于更新显示与检查点。手动暂停不会累计时长，继续沿用原身份。
3. `AppHide` 的 `reason: 0/1` 表示主动关闭或跳至另一小程序，沿用旧版结束并保存规则。系统中断、其他原因及缺省原因保留计时。音频中断单独到达时也保存中断标记。
4. 来电、闹钟占用音频时暂停播放器，保留音频位置和计时锚点；恢复前台/音频后校正已用时间。手动暂停仍保持暂停。倒计时在中断期间到时，恢复后进入同一次完成流程，按原截止时间计入记录。
5. 页面或进程被回收时，带 `interrupted` 标记的检查点可继续；普通无标记冷启动仍按旧版最后检查点结束。正计时离页时由运行时接管，避免页面销毁导致同一静坐丢失。
6. 完成后继续使用历史确认弹窗、心得和日签出口。保存调用 `utils/checkin.recordCheckin`，同一 `sessionId` 用于重试去重。先保存本机，再由记录服务后台同步。

## 异常处理与可靠性边界

- 倒计时终态先提交，再进行存储、页面回调与音频操作；重复生命周期通知不会重复结算。存储保留 `timerState`、`timerPendingCompletion`、`timerCompletionNotice`，音频恢复使用 `timerInterruptedAudio`。
- 本地记录保存失败保留草稿，页面允许重试。音频、亮度、常亮失败隔离处理；它们不应结束计时。引导音频沿用云端 URL 与原有备用资源逻辑。
- 系统挂起时不依赖 JavaScript 定时器继续执行；返回后以时间戳校正。系统占用音频或后台挂起期间，无法保证到点即响；恢复后才处理提醒。
- 老版本微信可能不提供中断原因/音频回调；缺省原因按保留计时处理，避免误将来电结束为一次静坐。因此该类设备主动切后台也可能保留计时。
- 系统完全未派发中断回调、应用数据被清除、磁盘持续不可写等情形不能保证跨进程恢复。普通强制终止仍遵循历史检查点规则。

## 设备适配与验证

共用一套微信页面与 InnerAudioContext，未按设备分叉。保留窄屏/安全区布局、SVG 图标、亮度恢复及可选 API 检测。固定铃声和页面均在主包，计时开始无需联网获取版本或下载实现；引导音频仍受网络和系统音频策略影响。

自动化：`npm run test:timer`、`npm test`。历史用例验证原有流程；`timerInterruptionSession.test.js` 验证控制器中断；`timerModule.test.js` 联合真实运行时、控制器和页面验证被动中断、主动退出、暂停、冷恢复、保存失败及铃声顺序。

真机需覆盖 iOS/Android、不同微信基础库、蓝牙/有线耳机及扬声器：在准备 5 秒、起坐铃声、引导播放、静默计时、暂停和接近倒计时结束时触发来电/闹钟，验证时长、声音恢复、关闭/取消和记录去重。模拟器可验证页面与事件逻辑，不能代替系统音频抢占与长时挂起验收。
