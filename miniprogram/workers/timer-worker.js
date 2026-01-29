// workers/timer-worker.js - 简化版本，只处理核心计时功能
let timerInterval = null;
let startTime = 0;
let totalElapsed = 0;
let selectedDuration = 0;
let isRunning = false;

// 处理主线程消息
worker.onMessage((message) => {
  const { type, data } = message;
  
  switch (type) {
    case 'START_TIMER':
      startTimer(data.duration);
      break;
      
    case 'PAUSE_TIMER':
      pauseTimer();
      break;
      
    case 'STOP_TIMER':
      stopTimer();
      break;
      
    case 'RESUME_TIMER':
      resumeTimer();
      break;
      
    case 'GET_STATUS':
      sendStatus();
      break;
      
    case 'SYNC_TIME':
      syncTime(data.currentTime);
      break;
  }
});

// 开始计时器
function startTimer(duration) {
  if (isRunning) return;
  
  selectedDuration = duration;
  startTime = Date.now();
  totalElapsed = 0;
  isRunning = true;
  
  console.log('⏱️ Worker开始计时:', duration, '秒');
  
  // 开始精确计时循环
  timerInterval = setInterval(() => {
    const currentTime = Date.now();
    const currentElapsed = Math.floor((currentTime - startTime) / 1000);
    const totalSeconds = totalElapsed + currentElapsed;
    const remaining = selectedDuration ? Math.max(0, selectedDuration - totalSeconds) : null;
    
    console.log('⏱️ Worker计时中:', totalSeconds, '秒, 剩余:', remaining, '秒');
    
    // 使用精确的时间戳发送更新
    worker.postMessage({
      type: 'TIMER_UPDATE',
      data: {
        elapsed: totalSeconds,
        remaining: remaining,
        isRunning: true,
        isFinished: remaining !== null && remaining <= 0,
        currentTime: currentTime,
        selectedDuration: selectedDuration
      }
    });
    
    // 检查是否完成
    if (remaining !== null && remaining <= 0) {
      console.log('✅ Worker计时完成');
      stopTimer();
      worker.postMessage({
        type: 'TIMER_FINISHED',
        data: { 
          elapsed: totalSeconds,
          selectedDuration: selectedDuration
        }
      });
    }
  }, 1000);
}

// 暂停计时器
function pauseTimer() {
  if (!isRunning) return;
  
  isRunning = false;
  totalElapsed += Math.floor((Date.now() - startTime) / 1000);
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  worker.postMessage({
    type: 'TIMER_PAUSED',
    data: { 
      elapsed: totalElapsed,
      selectedDuration: selectedDuration
    }
  });
  
  console.log('⏸️ Worker计时器已暂停');
}

// 恢复计时器
function resumeTimer() {
  if (isRunning) return;
  
  startTime = Date.now();
  isRunning = true;
  
  timerInterval = setInterval(() => {
    const currentTime = Date.now();
    const currentElapsed = Math.floor((currentTime - startTime) / 1000);
    const totalSeconds = totalElapsed + currentElapsed;
    const remaining = selectedDuration ? Math.max(0, selectedDuration - totalSeconds) : null;
    
    worker.postMessage({
      type: 'TIMER_UPDATE',
      data: {
        elapsed: totalSeconds,
        remaining: remaining,
        isRunning: true,
        currentTime: currentTime,
        selectedDuration: selectedDuration
      }
    });
    
    if (remaining !== null && remaining <= 0) {
      stopTimer();
      worker.postMessage({
        type: 'TIMER_FINISHED',
        data: { elapsed: totalSeconds }
      });
    }
  }, 1000);
  
  console.log('▶️ Worker计时器已恢复');
}

// 确保Worker对象可用
try {
  if (typeof worker !== 'undefined') {
    console.log('✅ Worker环境可用');
  } else {
    console.error('❌ Worker环境不可用');
  }
} catch (error) {
  console.error('❌ Worker环境检查失败:', error);
}

// 停止计时器
function stopTimer() {
  isRunning = false;
  startTime = 0;
  totalElapsed = 0;
  selectedDuration = 0;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  worker.postMessage({
    type: 'TIMER_STOPPED',
    data: { elapsed: 0 }
  });
  
  console.log('⏹️ Worker计时器已停止');
}

// 时间同步（用于屏幕重新打开时校正时间）
function syncTime(clientTime) {
  if (isRunning) {
    const serverTime = Date.now();
    const timeDiff = serverTime - clientTime;
    
    // 如果时间差异较大，重新计算已用时间
    if (Math.abs(timeDiff) > 2000) {
      const correctedElapsed = Math.floor((serverTime - startTime) / 1000);
      totalElapsed = correctedElapsed;
      
      worker.postMessage({
        type: 'TIME_SYNCED',
        data: {
          elapsed: totalElapsed,
          timeDiff: timeDiff
        }
      });
    }
  }
}

// 发送当前状态
function sendStatus() {
  const currentElapsed = isRunning ? 
    Math.floor((Date.now() - startTime) / 1000) : 0;
  
  worker.postMessage({
    type: 'TIMER_STATUS',
    data: {
      isRunning: isRunning,
      elapsed: totalElapsed + currentElapsed,
      selectedDuration: selectedDuration,
      currentTime: Date.now()
    }
  });
}

// Worker被销毁时的清理
worker.onProcessKilled(() => {
  console.log('⚠️ Worker进程被杀死，保存状态');
  if (timerInterval) clearInterval(timerInterval);
  
  // 保存状态以便恢复
  worker.postMessage({
    type: 'WORKER_KILLED',
    data: {
      elapsed: totalElapsed,
      selectedDuration: selectedDuration,
      isRunning: isRunning,
      startTime: startTime,
      saveTime: Date.now()
    }
  });
});