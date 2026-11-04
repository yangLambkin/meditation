const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../../miniprogram/pages/practices/practicePage.js');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function createPage({ feed, summary, flush, enabled = true, enqueue, hiddenTypes = [], queueFactory,
  screen = 'history', loadOptions = {}, shareMenuAvailable = true, now: initialNow = '2026-10-31T12:30:37+08:00' } = {}) {
  let now = Date.parse(initialNow);
  let owner = { openid: 'oz-owner', studentNumber: '001', bindingVersion: 'v1' };
  const tasks = [], calls = { feed: [], summary: [], enqueue: [], flush: [], toast: [], navigation: [], switchTab: [], modal: [], shareMenu: [], mirrorResume: 0 };
  const storage = { userOpenId: owner.openid };
  const subscribers = new Set();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const timers = new Map();
  let nextTimer = 0;
  const setTimer = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const api = {
    feed: async params => { calls.feed.push(plain(params)); return feed ? feed(params) : { records: [], nextCursor: '' }; },
    summary: async params => { calls.summary.push(plain(params)); return summary ? summary(params) : { totals: [], recordCount: 0, practiceDays: 0, daily: [], allTime: { totals: [] } }; }
  };
  let queue = {
    getPending: () => tasks.filter(task => task.owner.studentNumber === owner.studentNumber),
    enqueuePractice: options => {
      calls.enqueue.push(plain(options));
      if (enqueue) return enqueue(options, tasks, owner);
      const task = { ...options, id: `task-${calls.enqueue.length}`, owner: plain(owner), status: 'pending', attempts: 0 };
      tasks.push(task);
      return task;
    },
    flush: async options => { calls.flush.push(options); if (flush) return flush(tasks); tasks.splice(0); return { success: true, pending: 0, sent: 1 }; },
    subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    cancel: id => { const index = tasks.findIndex(task => task.id === id); if (index >= 0) tasks.splice(index, 1); }
  };
  let definition;
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showToast: value => calls.toast.push(value),
    navigateTo: value => calls.navigation.push(value),
    switchTab: value => { calls.navigation.push(value); calls.switchTab.push(value); },
    showModal: value => calls.modal.push(value), showActionSheet: value => { calls.actionSheet = value; },
    stopPullDownRefresh() {}
  };
  if (shareMenuAvailable) wx.showShareMenu = value => calls.shareMenu.push(plain(value));
  const preferencesModule = { exports: {} };
  const preferencesPath = path.join(__dirname, '../../miniprogram/utils/practicePreferences.js');
  vm.runInNewContext(fs.readFileSync(preferencesPath, 'utf8'), {
    module: preferencesModule, exports: preferencesModule.exports, wx, console
  }, { filename: preferencesPath });
  const preferences = preferencesModule.exports;
  preferences.saveHiddenTypes(hiddenTypes);
  const modules = { 'practiceApi.js': api, 'practiceQueue.js': queue,
    'practiceEntry.js': { openSettings: () => wx.navigateTo({ url: '/pages/practiceSettings/practiceSettings' }) },
    'practicePreferences.js': preferences,
    'practiceAuth.js': { getOwner: () => owner, authorize: async () => owner },
    'practiceMirror.js': { resume: async () => { calls.mirrorResume++; } },
    'practiceConfig.js': { practicesEnabled: enabled } };
  function loadDateModule(name) {
    if (modules[name]) return modules[name];
    assert.ok(['practiceDay.js', 'dateUtil.js'].includes(name), name);
    const dateModule = { exports: {} };
    const dateModulePath = path.join(__dirname, '../../miniprogram/utils', name);
    vm.runInNewContext(fs.readFileSync(dateModulePath, 'utf8'), {
      module: dateModule, exports: dateModule.exports, Date: Clock,
      setTimeout: setTimer, clearTimeout: clearTimer,
      require: dependency => loadDateModule(path.basename(dependency))
    }, { filename: dateModulePath });
    modules[name] = dateModule.exports;
    return dateModule.exports;
  }
  loadDateModule('practiceDay.js');
  if (queueFactory) {
    queue = queueFactory({ wx, api, auth: modules['practiceAuth.js'], config: modules['practiceConfig.js'], Clock });
    modules['practiceQueue.js'] = queue;
  }
  const pageModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    module: pageModule, exports: pageModule.exports,
    require: name => { const module = modules[path.basename(name)]; assert.ok(module, name); return module; },
    Page: value => { definition = value; }, wx, Date: Clock, console,
    setTimeout: setTimer, clearTimeout: clearTimer
  }, { filename: pagePath });
  definition = pageModule.exports(screen);
  const page = { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data); } };
  page.onLoad(loadOptions);
  return { page, calls, tasks, storage, subscribers, queue, preferences,
    changeOwner(value) { owner = value; storage.userOpenId = value && value.openid; },
    advance(milliseconds) { now += milliseconds; },
    runDueTimers() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
    },
    timerCount: () => timers.size };
}

function persistedQueue(writes = {}) {
  return ({ wx, api, auth, config, Clock }) => {
    const modules = { 'practiceAuth.js': auth,
      'practiceConfig.js': { ...config, sittingMirrorEnabled: true },
      'practiceMirror.js': { prepareForSend: async () => null } };
    function load(name) {
      if (modules[name]) return modules[name];
      const module = { exports: {} };
      const filename = path.join(__dirname, '../../miniprogram/utils', name);
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, wx, Date: Clock, console, setTimeout, clearTimeout,
        require: dependency => load(path.basename(dependency))
      }, { filename });
      modules[name] = module.exports;
      return module.exports;
    }
    const queueApi = load('practiceApi.js');
    Object.assign(queueApi, api, writes);
    api.sameOwner = queueApi.sameOwner;
    return load('practiceQueue.js');
  };
}

module.exports = { plain, deferred, failure, createPage, persistedQueue };
