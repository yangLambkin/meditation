const cloud = require('wx-server-sdk');

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 业务日期与前端一致：北京时间每日 02:00 换日。
function getBusinessDate(date) {
  const d = new Date(date === undefined ? Date.now() : date);
  const utc8 = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRecordBusinessDate(record) {
  const validDate = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
    Number.isFinite(Date.parse(`${record.date}T00:00:00Z`)) && new Date(`${record.date}T00:00:00Z`).toISOString().slice(0, 10) === record.date;
  if ((record.source === 'manual' || record.dateSource === 'manual') && validDate) return record.date;
  const value = record.timestamp;
  let timestamp = NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) timestamp = Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) timestamp = Date.parse(value);
  else if (value && typeof value.getTime === 'function') timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
    ? getBusinessDate(timestamp) : validDate ? record.date : '';
}

async function readAllRecords(collectionName, filter = {}) {
  const records = [];
  const limit = 100;
  while (true) {
    const page = await db.collection(collectionName).where(filter).orderBy('_id', 'asc')
      .skip(records.length).limit(limit).get();
    records.push(...page.data);
    if (page.data.length < limit) return records;
  }
}

/**
 * 一键删除测试数据云函数
 * 支持完整清理和安全清理两种模式
 */

// 完整清理模式 - 删除所有数据
async function cleanupTestData() {
  console.log('🚀 开始执行完整测试数据清理...');
  
  try {
    const collections = [
      'meditation_records',     // 冥想打卡记录
      'experience_records',     // 体验记录
      'user_stats',             // 用户统计
      'rankings'                // 排行榜数据
    ];
    
    let totalDeleted = 0;
    
    for (const collectionName of collections) {
      console.log(`📊 正在清理集合: ${collectionName}...`);
      
      try {
        const result = await db.collection(collectionName).get();
        const records = result.data;
        
        if (records.length === 0) {
          console.log(`   - 集合 ${collectionName} 为空，跳过清理`);
          continue;
        }
        
        console.log(`   - 找到 ${records.length} 条记录`);
        
        // 批量删除
        const deletePromises = records.map(record => 
          db.collection(collectionName).doc(record._id).remove()
        );
        
        const batchSize = 10;
        for (let i = 0; i < deletePromises.length; i += batchSize) {
          const batch = deletePromises.slice(i, i + batchSize);
          await Promise.all(batch);
          console.log(`   - 已删除 ${Math.min(i + batchSize, deletePromises.length)}/${deletePromises.length} 条记录`);
        }
        
        totalDeleted += records.length;
        console.log(`   ✅ 集合 ${collectionName} 清理完成`);
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`   ❌ 清理集合 ${collectionName} 时出错:`, error.message);
      }
    }
    
    console.log('🎉 完整清理完成！');
    
    return {
      success: true,
      totalDeleted: totalDeleted,
      message: `完整清理完成，删除 ${totalDeleted} 条测试数据`
    };
    
  } catch (error) {
    console.error('❌ 完整清理失败:', error);
    return {
      success: false,
      error: error.message,
      message: '完整清理失败'
    };
  }
}

// 安全清理模式 - 按日期范围删除
async function safeCleanupTestData() {
  console.log('🛡️  安全清理模式启动...');
  
  try {
    // 定义测试期间（包括今天的数据）
    const today = new Date();
    const testPeriod = {
      startDate: '2026-01-01',  // 测试开始日期
      endDate: getBusinessDate(today)  // 当前静坐业务日（北京时间 02:00 换日）
    };
    
    let totalDeleted = 0;
    
    console.log(`📅 清理日期范围: ${testPeriod.startDate} 至 ${testPeriod.endDate}`);
    
    // 清理冥想打卡记录
    console.log('\n📊 正在按日期范围清理 meditation_records...');
    // 清理也按原始时间重归属，避免尚未迁移的 00:00–02:00 记录错删或漏删。
    const meditationRecords = { data: (await readAllRecords('meditation_records')).filter(record => {
      const date = getRecordBusinessDate(record);
      return date >= testPeriod.startDate && date <= testPeriod.endDate;
    }) };
    
    if (meditationRecords.data.length > 0) {
      console.log(`   - 找到 ${meditationRecords.data.length} 条测试期间的打卡记录`);
      
      const deletePromises = meditationRecords.data.map(record => 
        db.collection('meditation_records').doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      totalDeleted += meditationRecords.data.length;
      console.log(`   ✅ 删除 ${meditationRecords.data.length} 条打卡记录`);
    } else {
      console.log('   - 未找到测试期间的打卡记录');
    }
    
    // 清理体验记录
    console.log('\n📊 正在按时间范围清理 experience_records...');
    const startTimestamp = Date.parse(`${testPeriod.startDate}T02:00:00+08:00`);
    const endTimestamp = Date.parse(`${testPeriod.endDate}T02:00:00+08:00`) + 86400000;
    
    const experienceRecords = { data: await readAllRecords('experience_records', {
      timestamp: db.command.gte(startTimestamp).and(db.command.lt(endTimestamp))
    }) };
    
    if (experienceRecords.data.length > 0) {
      console.log(`   - 找到 ${experienceRecords.data.length} 条测试期间的体验记录`);
      
      const deletePromises = experienceRecords.data.map(record => 
        db.collection('experience_records').doc(record._id).remove()
      );
      
      await Promise.all(deletePromises);
      totalDeleted += experienceRecords.data.length;
      console.log(`   ✅ 删除 ${experienceRecords.data.length} 条体验记录`);
    } else {
      console.log('   - 未找到测试期间的体验记录');
    }
    
    console.log('\n📊 跳过清理 user_stats 和 rankings...');
    console.log('   - 这些数据将在下次使用时自动重建');
    
    console.log('\n🎉 安全清理完成！');
    
    return {
      success: true,
      totalDeleted: totalDeleted,
      testPeriod: testPeriod,
      message: `安全清理完成，删除 ${totalDeleted} 条测试数据`
    };
    
  } catch (error) {
    console.error('❌ 安全清理失败:', error);
    return {
      success: false,
      error: error.message,
      message: '安全清理失败'
    };
  }
}

// 查看数据统计
async function showDataStatistics() {
  console.log('📊 当前数据统计...');
  
  try {
    const collections = [
      'meditation_records',
      'experience_records', 
      'user_stats',
      'rankings'
    ];
    
    const stats = {};
    
    for (const collectionName of collections) {
      try {
        const result = await db.collection(collectionName).count();
        stats[collectionName] = result.total;
        console.log(`   - ${collectionName}: ${result.total} 条记录`);
      } catch (error) {
        console.log(`   - ${collectionName}: 无法访问`);
        stats[collectionName] = 'N/A';
      }
    }
    
    return {
      success: true,
      statistics: stats,
      message: '数据统计获取完成'
    };
    
  } catch (error) {
    console.error('❌ 获取数据统计失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 云函数入口
exports.main = async (event, context) => {
  const { mode = 'safe' } = event;
  
  console.log(`🔧 执行清理模式: ${mode}`);
  
  switch (mode) {
    case 'full':
      return await cleanupTestData();
    case 'safe':
      return await safeCleanupTestData();
    case 'stats':
      return await showDataStatistics();
    default:
      return {
        success: false,
        error: '未知的清理模式',
        message: '请使用 full、safe 或 stats 模式'
      };
  }
};
