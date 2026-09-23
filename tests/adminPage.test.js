const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DATE = '2026-09-22';
const STATUS = { latestDate: DATE, dates: [DATE, '2026-09-21'], timerEnabled: true, apiConfigured: true, batchSize: 20 };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ me = false, api, confirm = true, access = true } = {}) {
  let definition;
  let now = Date.parse('2026-09-23T02:01:00+08:00');
  let nextTimer = 0;
  const timers = new Map();
  const calls = { cloud: [], toast: [], navigate: [], modals: [], alerts: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const cloudApi = { async callCloudFunction(name, data) {
    calls.cloud.push({ name, data });
    const reply = name === 'adminManager' && !me ? (typeof access === 'function' ? await access() : { success: true, data: { isAdmin: access } })
      : api ? await api(name, data) : { success: true, data: data.type === 'adminStatus' ? STATUS : { runs: [] } };
    return { result: reply };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, me ? '../miniprogram/pages/me/me.js' : '../miniprogram/pages/admin/admin.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp() { return { refreshSyncAlert() { calls.alerts.push('refresh'); }, clearSyncAlert() { calls.alerts.push('clear'); } }; },
    require(name) { return name.includes('cloudApi') ? cloudApi : {}; },
    Date: Clock, console,
    wx: {
      showToast(value) { calls.toast.push(value); },
      navigateTo(value) { calls.navigate.push(value); },
      showModal(value) { calls.modals.push(value); value.success({ confirm }); },
      stopPullDownRefresh() {}
    },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  return { page, calls, timers, advance(ms) { now += ms; }, async runTimer() {
    const [id, timer] = timers.entries().next().value || [];
    if (timer) { timers.delete(id); await timer.callback(); }
  } };
}
function success(data) { return { success: true, data }; }
function run(overrides = {}) {
  return { _id: 'run-1', runId: 'run-1', recordDate: DATE, status: 'running', trigger: 'manual',
    startedAt: '2026-09-22T18:00:00.000Z', total: 2, successCount: 0, failedCount: 0, skippedCount: 0, ...overrides };
}

test('seven version taps check the independent identity service and only admit the designated administrator', async () => {
  for (const allowed of [true, false]) {
    const { page, calls } = harness({ me: true, api: () => success({ isAdmin: allowed }) });
    for (let tap = 0; tap < 6; tap++) await page.onVersionTap();
    assert.equal(calls.cloud.length, 0);
    assert.equal(calls.navigate.length, 0);
    await page.onVersionTap();
    assert.equal(calls.cloud.length, 1);
    assert.equal(calls.cloud[0].name, 'adminManager');
    assert.equal(calls.cloud[0].data.type, 'getAccess');
    assert.equal(calls.navigate.length, allowed ? 1 : 0);
    if (!allowed) assert.equal(calls.toast.length, 0, 'ordinary users receive no reaction');
  }
});

test('version tap sequence expires after a pause or hiding and ignores late permission results', async () => {
  const pending = deferred();
  const { page, calls, advance } = harness({ me: true, api: () => pending.promise });
  for (let tap = 0; tap < 6; tap++) await page.onVersionTap();
  advance(2001);
  await page.onVersionTap();
  assert.equal(calls.cloud.length, 0);
  page.onHide();
  page._adminHidden = false;
  for (let tap = 0; tap < 6; tap++) await page.onVersionTap();
  assert.equal(calls.cloud.length, 0);
  const opening = page.onVersionTap();
  await page.onVersionTap();
  assert.equal(calls.cloud.length, 1, 'pending permission checks are deduplicated');
  page.onHide();
  pending.resolve(success({ isAdmin: true }));
  await opening;
  assert.equal(calls.navigate.length, 0);
});

test('opening the admin route directly still authorizes with the server and loads no data on denial', async () => {
  const { page, calls, timers } = harness({ access: false });
  await page.onShow();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.verifying, false);
  assert.match(page.data.entryError, /仅指定管理员/);
  assert.equal(calls.cloud.length, 1);
  assert.equal(timers.size, 0);
  await page.startSync();
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  assert.equal(calls.cloud.length, 1);
  assert.deepEqual(calls.alerts, ['clear'], 'denied access clears the reminder without requesting another check');
});

test('configured health is shown while missing API configuration prevents a manual run', async () => {
  const { page, calls } = harness({ api: (name, data) => success(data.type === 'adminStatus' ? { ...STATUS, apiConfigured: false, timerEnabled: false } : { runs: [] }) });
  await page.onShow();
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.timerEnabled, false);
  await page.startSync();
  assert.match(page.data.syncError, /尚未配置/);
  assert.equal(calls.cloud.some(call => call.data.type === 'adminStartSync'), false);
});

test('one-click sync creates once and serially continues until partial completion is shown with errors and elapsed time', async () => {
  const start = deferred();
  let current;
  let chunks = 0;
  const { page, calls, timers, runTimer } = harness({ api: async (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminStartSync') { await start.promise; current = run(); return success(current); }
    if (data.type === 'adminContinueSync') {
      chunks++;
      current = run({ status: 'partial', successCount: 1, failedCount: 1, finishedAt: '2026-09-22T18:01:01.000Z', durationMs: 61000, error: '有 1 位学员失败' });
      return success(current);
    }
    if (data.type === 'adminSyncDetails') return success({ items: [{ _id: 'item-1', studentNumber: 'BJ001', status: 'failed', error: '学号不存在', attempts: 1, durationMinutes: 20 }] });
    return success({ runs: current ? [current] : [] });
  } });
  await page.onShow();
  const starting = page.startSync();
  await page.startSync();
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminStartSync').length, 1);
  assert.equal(page.data.syncBusy, true);
  assert.equal(timers.size, 0);
  start.resolve();
  await starting;
  assert.equal(page.data.runningRunId, 'run-1');
  assert.equal(timers.size, 1);
  await runTimer();
  assert.equal(chunks, 1);
  assert.equal(page.data.runningRunId, '');
  assert.equal(page.data.runs[0].statusText, '部分失败');
  assert.equal(page.data.runs[0].startedText, '2026-09-23 02:00:00');
  assert.equal(page.data.runs[0].durationText, '1 分 1 秒');
  assert.equal(page.data.runs[0].error, '有 1 位学员失败');
  await runTimer();
  assert.equal(chunks, 1, 'completed partial runs do not loop on continuation');
  await page.selectRun({ currentTarget: { dataset: { id: 'run-1' } } });
  assert.equal(page.data.items[0].error, '学号不存在');
  assert.equal(page.data.items[0].statusText, '失败');
  page.onHide();
  assert.equal(timers.size, 0);
});

test('a failed continue preserves the error and pauses writes until one-click resume', async () => {
  let fail = true;
  const { page, calls, runTimer, timers } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminContinueSync') return fail ? { success: false, error: '必经请求超时' } : success(run({ status: 'success' }));
    return success({ runs: [run()] });
  } });
  await page.onShow();
  await runTimer();
  assert.match(page.data.syncError, /必经请求超时/);
  assert.equal(page.data.syncBusy, false);
  await runTimer();
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminContinueSync').length, 1);
  assert.match(page.data.syncError, /必经请求超时/);
  fail = false;
  await page.startSync();
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminContinueSync').length, 2);
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  assert.equal(timers.size, 0, 'switching tabs cancels sync polling');
});

test('hiding an in-flight continuation prevents late UI writes and schedules no follow-up chunk', async () => {
  const pending = deferred();
  const { page, timers } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminContinueSync') return pending.promise;
    return success({ runs: [run()] });
  } });
  await page.onShow();
  const syncing = page.startSync();
  page.onHide();
  const hidden = JSON.stringify(page.data);
  pending.resolve(success(run({ status: 'success' })));
  await syncing;
  assert.equal(JSON.stringify(page.data), hidden);
  assert.equal(timers.size, 0);
  await page.onShow();
  assert.equal(page.data.syncBusy, false, 'returning to the page clears a completed background request lock');
});

test('an interrupted run resumes its existing cursor instead of creating a new run', async () => {
  let current = run({ status: 'interrupted', interruptions: 1, lastInterruption: '上次执行超时，已恢复', lastInterruptionAt: '2026-09-22T18:00:30.000Z' });
  const { page, calls } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminContinueSync') { current = { ...current, status: 'success', durationMs: 60000 }; return success(current); }
    return success({ runs: [current] });
  } });
  await page.onShow();
  assert.equal(page.data.runningRunId, 'run-1');
  assert.equal(page.data.runs[0].interruptionText, '2026-09-23 02:00:30');
  assert.equal(page.data.runs[0].lastInterruption, '上次执行超时，已恢复');
  await page.startSync();
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminStartSync').length, 0);
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminContinueSync').length, 1);
  assert.equal(page.data.runningRunId, '');
});

test('default history spans dates while picker filters the chosen date and rejects invalid indexes', async () => {
  const { page, calls } = harness();
  await page.onShow();
  assert.equal(calls.cloud.at(-1).data.recordDate, undefined);
  await page.onDateChange({ detail: { value: '1' } });
  assert.equal(calls.cloud.at(-1).data.recordDate, '2026-09-21');
  assert.equal(page.data.showAllRuns, false);
  await page.onDateChange({ detail: { value: '999' } });
  assert.equal(page.data.recordDate, '2026-09-21');
  page.onUnload();
});

test('out-of-order sync detail responses cannot overwrite another selected run', async () => {
  const pending = deferred();
  const { page } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminSyncDetails') return data.runId === 'run-1' ? pending.promise : success({ items: [{ _id: 'new-item', status: 'success' }] });
    return success({ runs: [run({ status: 'success' }), run({ _id: 'run-2', status: 'success' })] });
  } });
  await page.onShow();
  const first = page.selectRun({ currentTarget: { dataset: { id: 'run-1' } } });
  await page.selectRun({ currentTarget: { dataset: { id: 'run-2' } } });
  pending.resolve(success({ items: [{ _id: 'old-item', status: 'failed' }] }));
  await first;
  assert.equal(page.data.items[0]._id, 'new-item');
  assert.equal(page.data.itemsLoading, false);
});

test('team transfer requires confirmation and sends the observed leader for concurrency protection', async () => {
  for (const confirm of [false, true]) {
    let leader = 'old';
    const { page, calls } = harness({ confirm, api: (name, request) => {
      if (request.type === 'adminStatus') return success(STATUS);
      if (request.type === 'adminListTeams') return success({ teams: [{ _id: 'team-1', name: '静心队', creator: leader, creatorName: leader === 'old' ? '旧团长' : '新团长', memberCount: 2 }] });
      if (request.type === 'adminTeamMembers') return success({ teamId: 'team-1', members: [{ openid: 'old', nickname: '旧团长', isCreator: leader === 'old' }, { openid: 'new', nickname: '新团长', isCreator: leader === 'new' }] });
      if (request.type === 'adminTransferLeader') { leader = 'new'; return success({ creator: leader }); }
      return success({ runs: [] });
    } });
    await page.onShow();
    await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
    await page.onTeamChange({ detail: { value: '0' } });
    assert.equal(page.data.candidates.length, 1);
    page.onCandidateChange({ detail: { value: '0' } });
    await page.transferLeader();
    assert.equal(calls.modals.length, 1);
    const writes = calls.cloud.filter(call => call.data.type === 'adminTransferLeader');
    assert.equal(writes.length, confirm ? 1 : 0);
    if (confirm) {
      assert.equal(writes[0].data.data.expectedLeaderOpenid, 'old');
      assert.equal(writes[0].data.data.newLeaderOpenid, 'new');
      assert.equal(page.data.selectedTeam.creator, 'new');
      assert.equal(page.data.selectedCandidate, null);
    }
    assert.equal(page.data.transferBusy, false);
  }
});

test('revoked access on any admin operation clears loaded private data and stops polling', async () => {
  let deny = false;
  const { page, calls, timers } = harness({ api: (name, request) => deny ? { success: false, code: 'FORBIDDEN', error: '权限已撤销' }
    : success(request.type === 'adminStatus' ? STATUS : { runs: [run({ status: 'success' })] }) });
  await page.onShow();
  assert.equal(page.data.runs.length, 1);
  deny = true;
  await page.loadRuns();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.runs.length, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.alerts, ['clear']);
});

test('team transfer failure preserves the original leader and displays the conflict', async () => {
  const { page, calls } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminListTeams') return success({ teams: [{ _id: 't1', creator: 'old', name: '队伍', creatorName: '旧团长' }] });
    if (data.type === 'adminTeamMembers') return success({ members: [{ openid: 'new', nickname: '新团长' }] });
    if (data.type === 'adminTransferLeader') return { success: false, error: '团长已发生变化，请刷新' };
    return success({ runs: [] });
  } });
  await page.onShow();
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  await page.onTeamChange({ detail: { value: 0 } });
  page.onCandidateChange({ detail: { value: 0 } });
  await page.transferLeader();
  assert.equal(page.data.selectedTeam.creator, 'old');
  assert.match(page.data.teamsError, /团长已发生变化/);
  assert.equal(page.data.transferBusy, false);
  assert.equal(calls.toast.length, 0);
});

test('audit history paginates with the returned cursor and formats server timestamps in Beijing time', async () => {
  const { page, calls } = harness({ api: (name, data) => {
    if (data.type === 'adminStatus') return success(STATUS);
    if (data.type === 'adminAuditLogs') return success({ logs: [{ _id: data.data.cursor ? 'second' : 'first', createdAt: '2026-09-22T18:01:00.000Z' }], nextCursor: data.data.cursor ? null : 'cursor-1' });
    return success({ runs: [] });
  } });
  await page.onShow();
  await page.onTabChange({ currentTarget: { dataset: { tab: 'audit' } } });
  assert.equal(page.data.logs[0].createdText, '2026-09-23 02:01:00');
  await page.loadMoreLogs();
  assert.equal(calls.cloud.at(-1).data.data.cursor, 'cursor-1');
  assert.equal(page.data.logs.length, 2);
  assert.equal(page.data.logsCursor, '');
});

test('an older bijingSync only disables its own tab while the shell, team management and audit remain available', async () => {
  const { page, calls } = harness({ api: (name, data) => {
    if (name === 'bijingSync') return { success: false, error: '未知操作: adminStatus' };
    if (data.type === 'adminListTeams') return success({ teams: [{ _id: 'team-1', name: '静心队' }] });
    return success({ logs: [{ _id: 'audit-1', teamName: '静心队' }] });
  } });
  await page.onShow();
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.accessError, '管控服务尚未更新，请先部署 bijingSync 云函数');
  await page.startSync();
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.teams[0]._id, 'team-1');
  assert.equal(page.data.accessError, '');
  await page.startSync();
  assert.equal(calls.cloud.filter(call => call.name === 'bijingSync').length, 1, 'team access cannot authorize a sync write');
  await page.onTabChange({ currentTarget: { dataset: { tab: 'audit' } } });
  assert.equal(page.data.logs[0]._id, 'audit-1');
  assert.equal(page.data.teams.length, 0, 'switching tabs clears the previous sensitive data');
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminListTeams').length, 2, 'returning to a tab rechecks its protected endpoint');
});

test('known legacy team errors identify the missing deployment and other server errors are preserved', async () => {
  for (const [message, expected] of [['未知的操作类型', '管控服务尚未更新，请先部署 teamManager 云函数'], ['数据库暂不可用', '数据库暂不可用']]) {
    const { page } = harness({ api: (name, data) => name === 'teamManager' ? { success: false, error: message }
      : success(data.type === 'adminStatus' ? STATUS : { runs: [] }) });
    await page.onShow();
    await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
    assert.equal(page.data.entryAuthorized, true);
    assert.equal(page.data.authorized, false);
    assert.equal(page.data.accessError, expected);
    await page.onTabChange({ currentTarget: { dataset: { tab: 'sync' } } });
    assert.equal(page.data.authorized, true);
  }
});

test('late failures from an inactive tab cannot revoke access or replace the current tab data', async () => {
  const pending = deferred();
  const { page } = harness({ api: (name) => name === 'bijingSync' ? pending.promise : success({ teams: [{ _id: 'current-team' }] }) });
  const opening = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.verifying, true);
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  pending.resolve({ success: false, code: 'FORBIDDEN', error: '旧请求无权限' });
  await opening;
  assert.equal(page.data.tab, 'team');
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.accessError, '');
  assert.equal(page.data.teams[0]._id, 'current-team');
});

test('returning under an unapproved identity immediately clears data and never loads a protected tab', async () => {
  let allowed = true;
  const { page, calls } = harness({ access: () => success({ isAdmin: allowed }), api: (name, data) => success(data.type === 'adminStatus' ? STATUS : { runs: [run({ status: 'success' })] }) });
  await page.onShow();
  assert.equal(page.data.runs.length, 1);
  page.onHide();
  assert.equal(page.data.runs.length, 0);
  allowed = false;
  const callsBefore = calls.cloud.length;
  await page.onShow();
  assert.equal(page.data.entryAuthorized, false);
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.runs.length, 0);
  assert.equal(calls.cloud.length, callsBefore + 1);
  assert.equal(calls.cloud.at(-1).name, 'adminManager');
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  await page.startSync();
  await page.transferLeader();
  assert.equal(calls.cloud.length, callsBefore + 1);
});

test('a protected tab rejection hides its data but keeps the verified administrator shell available', async () => {
  const { page, calls } = harness({ api: (name, data) => name === 'teamManager'
    ? { success: false, code: 'FORBIDDEN', error: '仅指定管理员可操作' }
    : success(data.type === 'adminStatus' ? STATUS : { runs: [] }) });
  await page.onShow();
  await page.onTabChange({ currentTarget: { dataset: { tab: 'team' } } });
  assert.equal(page.data.entryAuthorized, true);
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.teams.length, 0);
  const count = calls.cloud.length;
  await page.transferLeader();
  assert.equal(calls.cloud.length, count);
  await page.onTabChange({ currentTarget: { dataset: { tab: 'sync' } } });
  assert.equal(page.data.authorized, true);
});

test('sync errors paginate only for administrators and render the final remote comparison', async () => {
  const { page, calls } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors') return success({ errors: [{ _id: request.cursor ? 'error-2' : 'error-1',
      studentNumber: 'BJ001', recordDate: DATE, expectedDurationMinutes: 20, actualDurationMinutes: 0,
      reason: 'missing', updatedAt: '2026-09-22T18:01:00.000Z' }], nextCursor: request.cursor ? null : 'error-cursor' });
    return success({ runs: [] });
  } });
  await page.onShow();
  assert.equal(page.data.syncErrors[0].reasonText, '必经侧缺少记录');
  assert.equal(page.data.syncErrors[0].actualText, '未查到');
  assert.equal(page.data.syncErrors[0].updatedText, '2026-09-23 02:01:00');
  await page.loadMoreSyncErrors();
  assert.equal(calls.cloud.at(-1).data.cursor, 'error-cursor');
  assert.equal(page.data.syncErrors.length, 2);
  assert.equal(page.data.syncErrorsCursor, '');
  await page.onPullDownRefresh();
  assert.deepEqual(calls.alerts, [], 'showing and refreshing the page never request an alert check');
  page.onHide();
  assert.equal(page.data.syncErrors.length, 0);
  const count = calls.cloud.length;
  await page.loadSyncErrors();
  await page.retrySyncErrors();
  assert.equal(calls.cloud.length, count);
});

test('error retry continues its returned run even for another date without refreshing alerts after verification', async () => {
  let current;
  let recovered = false;
  const { page, calls, runTimer } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors') return success({ errors: recovered ? [] : [{ _id: 'error-1', studentNumber: 'BJ001', recordDate: '2026-09-21' }] });
    if (request.type === 'adminRetrySyncErrors') { current = run({ _id: 'retry-1', runId: 'retry-1', recordDate: '2026-09-21', phase: 'retry' }); return success(current); }
    if (request.type === 'adminContinueSync') {
      assert.equal(request.runId, 'retry-1');
      recovered = true;
      current = { ...current, phase: 'reverify', status: 'success' };
      return success(current);
    }
    return success({ runs: current ? [current] : [] });
  } });
  await page.onShow();
  await page.retrySyncErrors();
  assert.equal(page.data.runningRunId, 'retry-1');
  assert.equal(page.data.runningRecordDate, '2026-09-21');
  assert.equal(page.data.runs[0].phaseText, '重试缺失记录');
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminRetrySyncErrors').length, 1);
  await runTimer();
  assert.equal(page.data.runningRunId, '');
  assert.equal(page.data.runs[0].phaseText, '复核修复结果');
  assert.equal(page.data.runs[0].statusText, '核对完成');
  assert.equal(page.data.syncErrors.length, 0);
  assert.match(page.data.syncMessage, /核对完成/);
  assert.deepEqual(calls.alerts, []);
});

test('sync error access revocation clears sensitive errors and the reminder without allowing retry', async () => {
  let deny = false;
  const { page, calls, timers } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors') return deny ? { success: false, code: 'FORBIDDEN', error: '权限已撤销' }
      : success({ errors: [{ _id: 'private-error', studentNumber: 'BJ001' }] });
    return success({ runs: [] });
  } });
  await page.onShow();
  assert.equal(page.data.syncErrors.length, 1);
  deny = true;
  await page.loadSyncErrors();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.syncErrors.length, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.alerts, ['clear']);
  const count = calls.cloud.length;
  await page.retrySyncErrors();
  assert.equal(calls.cloud.length, count);
});

test('late sync error pages cannot repopulate private data after leaving the management page', async () => {
  const pending = deferred();
  const { page } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors' && request.cursor) return pending.promise;
    if (request.type === 'adminListSyncErrors') return success({ errors: [{ _id: 'first' }], nextCursor: 'next' });
    return success({ runs: [] });
  } });
  await page.onShow();
  const loading = page.loadMoreSyncErrors();
  page.onHide();
  pending.resolve(success({ errors: [{ _id: 'late' }] }));
  await loading;
  assert.equal(page.data.syncErrors.length, 0);
});

test('errors recovered by another worker before retry starts need no run or additional alert check', async () => {
  let recovered = false;
  const { page, calls } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors') return success({ errors: recovered ? [] : [{ _id: 'first' }] });
    if (request.type === 'adminRetrySyncErrors') { recovered = true; return success(null); }
    return success({ runs: [] });
  } });
  await page.onShow();
  await page.retrySyncErrors();
  assert.equal(page.data.syncErrors.length, 0);
  assert.equal(page.data.syncError, '');
  assert.match(page.data.syncMessage, /已恢复/);
  assert.equal(page.data.runningRunId, '');
  assert.equal(calls.cloud.some(call => call.data.type === 'adminContinueSync'), false);
  assert.deepEqual(calls.alerts, []);
});

test('returning to management resumes an older error-repair date from recent runs', async () => {
  const { page, calls, runTimer } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminListSyncErrors') return success({ errors: [{ _id: 'old-error' }] });
    if (request.type === 'adminContinueSync') return success(run({ status: 'success', recordDate: '2025-01-01', phase: 'reverify' }));
    return success({ runs: [run({ recordDate: '2025-01-01', mode: 'errors', phase: 'verify', trigger: 'manual-errors' })] });
  } });
  await page.onShow();
  assert.equal(page.data.runningRecordDate, '2025-01-01');
  assert.equal(page.data.runs[0].triggerText, '手动修复');
  await runTimer();
  assert.equal(calls.cloud.filter(call => call.data.type === 'adminContinueSync').length, 1);
});

test('sync details preserve upload diagnostics while labeling unverified records as pending', async () => {
  const { page } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    if (request.type === 'adminSyncDetails') return success({ items: [
      { _id: 'pending', status: 'pending', uploadError: '上传请求超时，等待核对' },
      { _id: 'verified', status: 'success', markError: '本地状态保存失败' }
    ] });
    return success({ runs: [run()] });
  } });
  await page.onShow();
  await page.selectRun({ currentTarget: { dataset: { id: 'run-1' } } });
  assert.equal(page.data.items[0].statusText, '待核对');
  assert.equal(page.data.items[0].uploadError, '上传请求超时，等待核对');
  assert.equal(page.data.items[1].markError, '本地状态保存失败');
});

test('legacy successful uploads never claim remote verification in history', async () => {
  const { page } = harness({ api: (name, request) => {
    if (request.type === 'adminStatus') return success(STATUS);
    return success({ runs: [
      run({ _id: 'legacy', status: 'success', phase: 'upload', successCount: 5 }),
      run({ _id: 'older-service', status: 'success', successCount: 3 }),
      run({ _id: 'verified', status: 'success', phase: 'retry', successCount: 5 })
    ] });
  } });
  await page.onShow();
  for (const item of page.data.runs.slice(0, 2)) {
    assert.equal(item.statusText, '历史完成 · 未核对');
    assert.equal(item.verifiedCountLabel, '历史上报成功');
  }
  assert.equal(page.data.runs[2].statusText, '核对完成');
  assert.equal(page.data.runs[2].verifiedCountLabel, '核对通过');
});
