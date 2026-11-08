# 历史实现来源

基线提交：`85fc7c50a21bf0398303d5ed0d8c122ed2ca3956`（V3.0.7），为 V3.0.8 提交的直接父提交。以版本边界为准。

| 当前文件 | 历史来源 |
| --- | --- |
| `definition.js` | `miniprogram/pages/timer/timer.js`，改为注入 API 和运行时的页面工厂 |
| `view.wxml / view.wxss` | `miniprogram/pages/timer/timer.wxml / timer.wxss` |
| `countdownSession.js` | `miniprogram/utils/countdownSession.js` |
| `screenBrightness.js` | `miniprogram/utils/screenBrightness.js` |
| `audio/起坐.mp3`、`audio/收坐.mp3` | `miniprogram/audio/` 同名文件，字节未变 |

模块化适配包括引用路径、普通页面安全区以及应用生命周期转发。行为新增仅围绕系统中断：中断状态持久化、同一计时恢复、离页正计时交接、音频暂停和恢复，以及相应的事件顺序/重入保护。无多实现切换或新式提醒设置。

资源 SHA-256：

- 起坐：`990157e813e1ac6601770a37e0a583fc524731386411a8787100c3fa27493d0d`
- 收坐：`ef69dc857819f081cf636ff309a4d13edf64f216b8d2da05613d0c6e2d33c289`

原版保留的规则：开始后 5 秒起坐，起坐播放结束才接引导；手动暂停排除暂停时长；不足 1 分钟不记录；普通冷启动在最后检查点结算；完成记录先存本机，心得审核和日签出口共用保存锁；最长静坐 24 小时。
