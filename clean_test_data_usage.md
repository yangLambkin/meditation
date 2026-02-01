# 测试数据清理脚本使用说明

## 脚本功能

此脚本用于清理小程序云数据库中的测试数据，保留重要的基础数据，不影响小程序核心功能。

## 清理范围

### 🗑️ 删除的数据
- **冥想打卡记录** (`meditation_records`)
- **体验记录** (`experience_records`)  
- **排行榜数据** (`rankings`)
- **重置用户统计数据** (`user_stats` - 归零所有统计信息)

### 🔒 保留的数据
- **金句库** (`wisdom_quotes`) - 重要数据不删除
- **云存储图片** - 背景图片等资源
- **用户基础信息** - 用户标识等基础数据

## 使用方法

### 方式一：直接运行脚本
```bash
cd /Users/yang/WeChatProjects/meditation
node clean_test_data.js
```

### 方式二：在其他脚本中调用
```javascript
const { cleanTestData } = require('./clean_test_data.js');

// 执行清理
cleanTestData().then(() => {
  console.log('清理完成');
});
```

### 方式三：在云函数中使用
```javascript
// 创建一个新的云函数来执行清理
const { cleanTestData } = require('./clean_test_data.js');

exports.main = async (event, context) => {
  // 添加权限检查（可选）
  if (event.adminKey !== 'your-secret-key') {
    return { success: false, error: '权限不足' };
  }
  
  await cleanTestData();
  return { success: true, message: '测试数据清理完成' };
};
```

## 安全说明

1. **备份重要数据**: 在运行前请确保重要数据已备份
2. **测试环境优先**: 建议先在测试环境运行
3. **权限控制**: 生产环境建议添加管理员权限检查
4. **日志记录**: 脚本会输出详细的执行日志

## 日志输出示例

```
🚀 开始清理测试数据...

📊 清理冥想打卡记录...
   找到 150 条冥想打卡记录
   已删除 100/150 条记录
   已删除 150/150 条记录
   ✅ 冥想打卡记录清理完成

📝 清理体验记录...
   找到 45 条体验记录
   已删除 45/45 条记录
   ✅ 体验记录清理完成

📈 清理用户统计数据...
   找到 10 条用户统计记录
   ✅ 用户统计数据重置完成

🏆 清理排行榜数据...
   找到 30 条排行榜记录
   已删除 30/30 条记录
   ✅ 排行榜数据清理完成

✅ 测试数据清理完成！

🔒 重要数据保留：
   - 金句库 (wisdom_quotes) 未受影响
   - 云存储图片未受影响
   - 用户基础数据保留
```

## 注意事项

- 脚本会批量删除数据，大数量时可能需要一些时间
- 清理后的数据无法恢复，请谨慎使用
- 建议在维护窗口或低峰期执行
- 可以修改脚本中的 `batchSize` 来调整批量操作大小

## 自定义修改

如果需要调整清理策略，可以修改以下函数：
- `cleanMeditationRecords()` - 冥想记录清理逻辑
- `cleanExperienceRecords()` - 体验记录清理逻辑  
- `cleanUserStats()` - 用户统计重置逻辑
- `cleanRankings()` - 排行榜清理逻辑