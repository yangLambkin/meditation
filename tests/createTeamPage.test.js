const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '../miniprogram/subpackages/team/pages/createTeam/createTeam.js');
const source = fs.readFileSync(pagePath, 'utf8');
const dataIcon = 'https://data.bijing.life/api/public/teams/avatar?key=existing-icon';
const uploadedIcon = 'https://data.bijing.life/api/public/teams/avatar?key=approved-icon';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createPage({ openid = 'openid-user', create, checkText, checkImage, uploadIcon, navigateBackFails = false, now = '2026-09-19T12:00:00+08:00' } = {}) {
  let definition;
  let currentTime = Date.parse(now);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  let currentOpenid = openid;
  let timerId = 0;
  const timers = new Map();
  const calls = { uploads: [], create: [], text: [], image: [], toast: [], navigation: [], actionSheets: [], media: [], updates: [] };
  vm.runInNewContext(source, {
    Page: value => { definition = value; },
    Date: FixedDate,
    require(name) {
      if (name.endsWith('/dateUtil.js')) return require('../miniprogram/utils/dateUtil.js');
      if (name.endsWith('/practicePreferences.js')) return require('../miniprogram/utils/practicePreferences.js');
      if (name.endsWith('/teamGateway.js')) return {
        isDataTeamIcon: value => typeof value === 'string' && value.startsWith('https://data.bijing.life/api/public/teams/avatar?'),
        async uploadTeamIcon(file) { calls.uploads.push(file); return uploadIcon ? uploadIcon(file) : uploadedIcon; }
      };
      if (name.endsWith('/teamManager.js')) return { createTeam: async info => {
        calls.create.push({ ...info });
        return create ? create(info) : { success: true, team: { _id: 'cloud-team', ...info } };
      } };
      if (name.endsWith('/contentSec.js')) return {
        checkText: async (text, scene) => {
          calls.text.push([text, scene]);
          return checkText ? checkText(text, scene) : true;
        },
        checkImage: async (file, options) => {
          calls.image.push({ file, options: { ...options } });
          return checkImage ? checkImage(file, options) : 'cloud://checked-icon';
        }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      getStorageSync: key => key === 'userOpenId' ? currentOpenid : undefined,
      showToast: options => calls.toast.push(options),
      showActionSheet: options => calls.actionSheets.push(options),
      chooseMedia: options => calls.media.push(options),
      navigateBack(options) {
        calls.navigation.push('back');
        if (navigateBackFails) options.fail();
      },
      switchTab: options => calls.navigation.push(options.url)
    }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: { ...structuredClone(definition.data), teamName: '觉察小组', teamDescription: '一起练习', selectedIcon: 1, customIconPath: dataIcon },
    setData(values) { calls.updates.push(values); Object.assign(this.data, values); }
  };
  page.onLoad();
  return {
    page, calls, timers,
    setNow(value) { currentTime = Date.parse(value); },
    setOpenid(value) { currentOpenid = value; },
    runTimers() { for (const [id, callback] of Array.from(timers)) { timers.delete(id); callback(); } }
  };
}

test('creation and icon upload reject guest and local identities before network requests', async () => {
  for (const openid of ['', undefined, 'local_guest', 'test_user']) {
    const { page, calls } = createPage({ openid: openid === undefined ? null : openid });
    await page.createTeam();
    page.chooseImageFromAlbum();
    assert.equal(calls.create.length, 0);
    assert.equal(calls.text.length, 0);
    assert.equal(calls.actionSheets.length, 0);
    assert.match(calls.toast.at(-1).title, /请先登录/);
  }
});

test('validation rejects incomplete forms, oversized values and nonpermanent icons', async () => {
  for (const values of [
    { teamName: '   ' }, { teamName: '名'.repeat(21) }, { teamDescription: '介'.repeat(101) },
    { customIconPath: '' }, { customIconPath: true }, { customIconPath: 'wxfile://tmp_icon' },
    { customIconPath: 'cloud://old-team-icon' }
  ]) {
    const { page, calls } = createPage();
    Object.assign(page.data, values);
    await page.createTeam();
    assert.equal(calls.text.length, 0);
    assert.equal(calls.create.length, 0);
    assert.equal(page.data.isCreating, false);
  }
});

test('submitted fields are the same trimmed snapshot that passed moderation', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ checkText: text => text === '原名称' ? pending.promise : true });
  Object.assign(page.data, { teamName: ' 原名称 ', teamDescription: ' 原介绍 ' });
  const creation = page.createTeam();
  page.onTeamNameInput({ detail: { value: '不应修改' } });
  page.onTeamDescriptionInput({ detail: { value: '不应修改' } });
  assert.equal(page.data.teamName, ' 原名称 ');
  assert.equal(page.data.teamDescription, ' 原介绍 ');
  Object.assign(page.data, { teamName: '未审核的新名称', teamDescription: '未审核的新介绍', customIconPath: 'cloud://changed' });
  pending.resolve(true);
  await creation;
  assert.deepEqual(calls.text, [['原名称', 2], ['原介绍', 2]]);
  assert.deepEqual(calls.create, [{ name: '原名称', description: '原介绍', icon: dataIcon, practiceType: 'sitting', practiceStartDate: null, dailyGoalMinutes: null }]);
});

test('duplicate submission remains blocked through moderation, creation and success navigation delay', async () => {
  const pending = deferred();
  const started = deferred();
  const { page, calls, runTimers } = createPage({ create: () => { started.resolve(); return pending.promise; } });
  const creation = page.createTeam();
  await page.createTeam();
  await started.promise;
  assert.equal(calls.create.length, 1);
  assert.equal(page.data.isCreating, true);
  await page.createTeam();
  pending.resolve({ success: true, team: { _id: 'team' } });
  await creation;
  assert.equal(page.data.hasCreatedTeam, true);
  await page.createTeam();
  await page.createTeam();
  runTimers();
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.navigation, ['back']);
});

test('moderation rejection and cloud errors preserve form values and allow a corrected retry', async () => {
  for (const options of [
    { checkText: () => false },
    { create: () => ({ success: false, error: '创建失败' }) },
    { create: () => { throw new Error('网络中断'); } }
  ]) {
    const { page, calls, timers } = createPage(options);
    await page.createTeam();
    assert.equal(page.data.hasCreatedTeam, false);
    assert.equal(page.data.isCreating, false);
    assert.equal(page.data.teamName, '觉察小组');
    assert.equal(page.data.teamDescription, '一起练习');
    assert.equal(timers.size, 0);
    const before = calls.text.length;
    await page.createTeam();
    assert.ok(calls.text.length > before);
  }
});

test('account changes or leaving the page during moderation prevent a create request', async () => {
  for (const action of ['account', 'unload']) {
    const pending = deferred();
    const { page, calls, setOpenid } = createPage({ checkText: () => pending.promise });
    const creation = page.createTeam();
    if (action === 'account') setOpenid('another-user');
    else page.onUnload();
    pending.resolve(true);
    await creation;
    assert.equal(calls.create.length, 0);
    if (action === 'account') assert.match(calls.toast.at(-1).title, /登录状态已变化/);
  }
});

test('leaving during a create request does not navigate or update the destroyed page', async () => {
  const pending = deferred();
  const started = deferred();
  const { page, calls, runTimers } = createPage({ create: () => { started.resolve(); return pending.promise; } });
  const creation = page.createTeam();
  await started.promise;
  assert.equal(calls.create.length, 1);
  page.onUnload();
  const updates = calls.updates.length;
  pending.resolve({ success: true, team: { _id: 'team' } });
  await creation;
  runTimers();
  assert.equal(calls.updates.length, updates);
  assert.equal(calls.toast.length, 0);
  assert.equal(calls.navigation.length, 0);
});

test('success navigation pauses when hidden, resumes on show, and is canceled on unload', async () => {
  const { page, calls, timers, runTimers } = createPage();
  await page.createTeam();
  assert.equal(timers.size, 1);
  page.onHide();
  runTimers();
  assert.equal(calls.navigation.length, 0);
  page.onShow();
  assert.equal(timers.size, 1);
  page.onUnload();
  runTimers();
  assert.equal(calls.navigation.length, 0);
});

test('opening creation as a root page returns to the team tab when navigateBack is unavailable', async () => {
  const { page, calls, runTimers } = createPage({ navigateBackFails: true });
  await page.createTeam();
  runTimers();
  assert.deepEqual(calls.navigation, ['back', '/pages/team/team']);
});

test('avatar moderation blocks concurrent selection and submission and reuses its approved file', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ checkImage: () => pending.promise });
  page.chooseImageFromAlbum();
  page.chooseImageFromAlbum();
  assert.equal(calls.actionSheets.length, 1);
  calls.actionSheets[0].success({ tapIndex: 1 });
  const upload = calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new' }] });
  await page.createTeam();
  assert.equal(calls.create.length, 0);
  assert.equal(page.data.isChoosingIcon, true);
  pending.resolve('cloud://approved-icon');
  await upload;
  assert.equal(page.data.isChoosingIcon, false);
  assert.equal(page.data.customIconPath, uploadedIcon);
  assert.deepEqual(calls.uploads, ['cloud://approved-icon']);
  assert.equal(page.data.teamIcons[0].path, 'wxfile://tmp_new');
  await page.createTeam();
  assert.equal(calls.create[0].icon, uploadedIcon);
  assert.equal(calls.image[0].options.returnFileID, true);
});

test('cancelled or rejected avatar selection keeps the previous approved icon and releases its lock', async () => {
  for (const checkImage of [() => false, () => true, () => { throw new Error('上传失败'); }]) {
    const { page, calls } = createPage({ checkImage });
    page.chooseImageFromAlbum();
    calls.actionSheets[0].success({ tapIndex: 0 });
    await calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new' }] });
    assert.equal(page.data.customIconPath, dataIcon);
    assert.equal(page.data.isChoosingIcon, false);
  }
  const { page, calls } = createPage();
  page.chooseImageFromAlbum();
  calls.actionSheets[0].fail({ errMsg: 'showActionSheet:fail cancel' });
  assert.equal(page.data.isChoosingIcon, false);
  page.chooseImageFromAlbum();
  calls.actionSheets[1].success({ tapIndex: 1 });
  calls.media[0].fail({ errMsg: 'chooseMedia:fail cancel' });
  assert.equal(page.data.isChoosingIcon, false);
  assert.equal(calls.toast.length, 0);
});

test('failed data avatar uploads preserve the last icon and do not turn cloud audit files into team data', async () => {
  for (const uploadIcon of [() => { throw new Error('团队服务暂时无法连接'); }, () => 'cloud://unexpected-icon']) {
    const { page, calls } = createPage({ uploadIcon });
    page.chooseImageFromAlbum();
    calls.actionSheets[0].success({ tapIndex: 1 });
    await calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new' }] });
    assert.equal(page.data.customIconPath, dataIcon);
    assert.equal(page.data.isChoosingIcon, false);
    assert.deepEqual(calls.uploads, ['cloud://checked-icon']);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.toast.at(-1).icon, 'none');
  }
});

test('an avatar approved for an old account is never uploaded or installed for its replacement', async () => {
  const approved = deferred();
  const { page, calls, setOpenid } = createPage({ checkImage: () => approved.promise });
  page.chooseImageFromAlbum();
  calls.actionSheets[0].success({ tapIndex: 1 });
  const pending = calls.media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_new' }] });
  setOpenid('replacement');
  approved.resolve('cloud://old-account-icon');
  await pending;
  assert.equal(calls.uploads.length, 0);
  assert.equal(page.data.customIconPath, dataIcon);
  assert.equal(page.data.isChoosingIcon, false);
});


test('practice rules start unset while the date limit rolls over at Beijing 02:00', () => {
  for (const [now, expected] of [
    ['2026-09-19T01:59:59.999+08:00', '2026-09-18'],
    ['2026-09-19T02:00:00+08:00', '2026-09-19'],
    ['2026-09-19T23:59:59+08:00', '2026-09-19'],
    ['2026-10-01T01:59:59+08:00', '2026-09-30'],
    ['2026-10-01T02:00:00+08:00', '2026-10-01'],
    ['2024-03-01T01:59:59+08:00', '2024-02-29'],
    ['2026-03-01T01:59:59+08:00', '2026-02-28'],
    ['2027-01-01T01:59:59+08:00', '2026-12-31'],
    ['2027-01-01T02:00:00+08:00', '2027-01-01'],
    ['2026-09-18T17:59:59.999Z', '2026-09-18'],
    ['2026-09-18T18:00:00Z', '2026-09-19'],
    ['2026-09-18T11:00:00-07:00', '2026-09-19']
  ]) {
    const { page } = createPage({ now });
    assert.equal(page.data.practiceRulesEnabled, false, now);
    assert.equal(page.data.practiceStartDate, '', now);
    assert.equal(page.data.maxPracticeStartDate, expected, now);
    assert.equal(page.data.dailyGoalMinutes, '', now);
  }
});

test('optional practice rules can be omitted independently without introducing default values', async () => {
  for (const [date, goal, expectedDate, expectedGoal] of [
    ['', '', null, null],
    [null, undefined, null, null],
    ['  ', '  ', null, null],
    ['2026-09-01', '', '2026-09-01', null],
    ['', '30', null, 30]
  ]) {
    const { page, calls } = createPage();
    page.onPracticeRulesChange({ detail: { value: true } });
    Object.assign(page.data, { practiceStartDate: date, dailyGoalMinutes: goal });
    await page.createTeam();
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].practiceStartDate, expectedDate);
    assert.equal(calls.create[0].dailyGoalMinutes, expectedGoal);
  }
});

test('chosen dates and goals can be cleared independently before submission', async () => {
  const { page, calls } = createPage();
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '60' } } });
  page.clearPracticeStartDate();
  assert.equal(page.data.practiceStartDate, '');
  assert.equal(page.data.dailyGoalMinutes, 60);
  page.onPracticeStartDateChange({ detail: { value: '2026-09-02' } });
  page.clearDailyGoal();
  assert.equal(page.data.practiceStartDate, '2026-09-02');
  assert.equal(page.data.dailyGoalMinutes, '');
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '30' } } });
  page.onDailyGoalInput({ detail: { value: '' } });
  page.clearPracticeStartDate();
  await page.createTeam();
  assert.equal(calls.create[0].practiceStartDate, null);
  assert.equal(calls.create[0].dailyGoalMinutes, null);
});

test('valid historical dates and integer daily goals are persisted as top-level team fields', async () => {
  for (const [date, goal] of [['2024-02-29', '30'], ['2026-09-18', 1], ['2026-09-19', '1440']]) {
    const { page, calls } = createPage();
    page.onPracticeRulesChange({ detail: { value: true } });
    page.onPracticeStartDateChange({ detail: { value: date } });
    page.onDailyGoalInput({ detail: { value: goal } });
    await page.createTeam();
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].practiceStartDate, date);
    assert.equal(calls.create[0].dailyGoalMinutes, Number(goal));
    assert.equal(typeof calls.create[0].dailyGoalMinutes, 'number');
  }
});

test('impossible, malformed and future practice dates never reach moderation or creation', async () => {
  for (const date of [true, false, 20260919, '2026-02-29', '2026-09-31', '2026-13-01', '2026-9-01', '2026-09-20', '0000-01-01']) {
    const { page, calls } = createPage();
    page.onPracticeRulesChange({ detail: { value: true } });
    const before = page.data.practiceStartDate;
    page.onPracticeStartDateChange({ detail: { value: date } });
    assert.equal(page.data.practiceStartDate, before, String(date));
    page.data.practiceStartDate = date;
    await page.createTeam();
    assert.equal(calls.text.length, 0, String(date));
    assert.equal(calls.create.length, 0, String(date));
    assert.equal(page.data.isCreating, false);
    assert.match(calls.toast.at(-1).title, /有效日期/);
  }
  const { page, calls } = createPage({ now: '2026-09-19T01:59:59+08:00' });
  page.onPracticeRulesChange({ detail: { value: true } });
  page.data.practiceStartDate = '2026-09-19';
  await page.createTeam();
  assert.equal(calls.create.length, 0, 'the current calendar date has not become a practice day before 02:00');
});

test('a specified daily goal rejects malformed values, fractions and values outside 1 to 1440 minutes', async () => {
  for (const goal of [true, false, '20.0', '2e1', '+20', 'abc', 0, -1, 1.5, 1441, Infinity]) {
    const { page, calls } = createPage();
    page.onPracticeRulesChange({ detail: { value: true } });
    page.onDailyGoalInput({ detail: { value: goal } });
    await page.createTeam();
    assert.equal(calls.text.length, 0, String(goal));
    assert.equal(calls.create.length, 0, String(goal));
    assert.equal(page.data.isCreating, false);
    assert.match(calls.toast.at(-1).title, /1至1440的整数/);
  }
});

test('quick goals and practice dates cannot change a pending or completed creation snapshot', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ checkText: () => pending.promise });
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '60' } } });
  assert.equal(page.data.dailyGoalMinutes, 60);
  const creation = page.createTeam();
  page.onPracticeStartDateChange({ detail: { value: '2026-09-10' } });
  page.onDailyGoalInput({ detail: { value: '90' } });
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '30' } } });
  page.clearPracticeStartDate();
  page.clearDailyGoal();
  assert.equal(page.data.practiceStartDate, '2026-09-01');
  assert.equal(page.data.dailyGoalMinutes, 60);
  // An external update must not replace the values accepted at submit time either.
  Object.assign(page.data, { practiceStartDate: '2026-09-18', dailyGoalMinutes: 10 });
  pending.resolve(true);
  await creation;
  assert.equal(calls.create[0].practiceStartDate, '2026-09-01');
  assert.equal(calls.create[0].dailyGoalMinutes, 60);
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '20' } } });
  page.clearPracticeStartDate();
  page.clearDailyGoal();
  assert.equal(page.data.practiceStartDate, '2026-09-18');
  assert.equal(page.data.dailyGoalMinutes, 10);
});

test('returning after the 02:00 cutoff refreshes the date limit and preserves the chosen rules', async () => {
  const { page, calls, setNow } = createPage({ now: '2026-09-19T01:59:59+08:00' });
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '30' } } });
  page.onHide();
  setNow('2026-09-19T02:00:00+08:00');
  page.onShow();
  assert.equal(page.data.maxPracticeStartDate, '2026-09-19');
  assert.equal(page.data.practiceStartDate, '2026-09-01');
  assert.equal(page.data.dailyGoalMinutes, 30);
  page.onPracticeStartDateChange({ detail: { value: '2026-09-19' } });
  await page.createTeam();
  assert.equal(calls.create[0].practiceStartDate, '2026-09-19');
});

test('creation failure preserves custom practice rules and a fresh page can create another team', async () => {
  const failed = createPage({ create: () => ({ success: false, error: '网络中断' }) });
  failed.page.onPracticeRulesChange({ detail: { value: true } });
  failed.page.onPracticeStartDateChange({ detail: { value: '2026-09-02' } });
  failed.page.onDailyGoalInput({ detail: { value: '45' } });
  await failed.page.createTeam();
  assert.equal(failed.page.data.practiceStartDate, '2026-09-02');
  assert.equal(failed.page.data.dailyGoalMinutes, '45');
  assert.equal(failed.page.data.hasCreatedTeam, false);
  for (const name of ['第一个团队', '第二个团队']) {
    const { page, calls } = createPage();
    page.onTeamNameInput({ detail: { value: name } });
    await page.createTeam();
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].name, name);
    assert.equal(calls.create[0].dailyGoalMinutes, null);
  }
});

test('practice rules are disabled by default and create a team without any configuration', async () => {
  const { page, calls } = createPage();
  assert.equal(page.data.practiceRulesEnabled, false);
  await page.createTeam();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].practiceStartDate, null);
  assert.equal(calls.create[0].dailyGoalMinutes, null);
});

test('disabling rules preserves drafts for reopening and skips validation of hidden values', async () => {
  const { page, calls } = createPage();
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.onDailyGoalInput({ detail: { value: '45' } });
  page.onPracticeRulesChange({ detail: { value: false } });
  assert.equal(page.data.practiceRulesEnabled, false);
  page.onPracticeRulesChange({ detail: { value: true } });
  assert.equal(page.data.practiceStartDate, '2026-09-01');
  assert.equal(page.data.dailyGoalMinutes, '45');
  page.onDailyGoalInput({ detail: { value: '1441' } });
  page.data.practiceStartDate = '2026-02-29';
  page.onPracticeRulesChange({ detail: { value: false } });
  await page.createTeam();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].practiceStartDate, null);
  assert.equal(calls.create[0].dailyGoalMinutes, null);
  assert.equal(page.data.practiceStartDate, '2026-02-29');
  assert.equal(page.data.dailyGoalMinutes, '1441');
  assert.equal(calls.toast.some(({ title }) => /有效日期|1至1440/.test(title)), false);
});

test('hidden rule fields ignore input, preset and clear events', () => {
  const { page, calls } = createPage();
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.onDailyGoalInput({ detail: { value: '45' } });
  page.onPracticeRulesChange({ detail: { value: false } });
  const updates = calls.updates.length;
  page.onPracticeStartDateChange({ detail: { value: '2026-09-02' } });
  page.onDailyGoalInput({ detail: { value: '90' } });
  page.selectDailyGoal({ currentTarget: { dataset: { minutes: '60' } } });
  page.clearPracticeStartDate();
  page.clearDailyGoal();
  assert.equal(page.data.practiceStartDate, '2026-09-01');
  assert.equal(page.data.dailyGoalMinutes, '45');
  assert.equal(calls.updates.length, updates);
});

test('rule toggling cannot change a pending or completed creation', async () => {
  for (const enabled of [false, true]) {
    const pending = deferred();
    const started = deferred();
    const { page, calls } = createPage({
      checkText: () => pending.promise,
      create: () => { started.resolve(); return { success: true }; }
    });
    page.onPracticeRulesChange({ detail: { value: true } });
    page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
    page.onDailyGoalInput({ detail: { value: '45' } });
    page.onPracticeRulesChange({ detail: { value: enabled } });
    const creation = page.createTeam();
    assert.equal(page.data.isCreating, true);
    page.onPracticeRulesChange({ detail: { value: !enabled } });
    assert.equal(page.data.practiceRulesEnabled, enabled);
    pending.resolve(true);
    await started.promise;
    await creation;
    assert.equal(calls.create[0].practiceStartDate, enabled ? '2026-09-01' : null);
    assert.equal(calls.create[0].dailyGoalMinutes, enabled ? 45 : null);
    assert.equal(page.data.hasCreatedTeam, true);
    page.onPracticeRulesChange({ detail: { value: !enabled } });
    assert.equal(page.data.practiceRulesEnabled, enabled);
  }
});

test('loading the page resets the practice rules toggle and drafts', () => {
  const { page } = createPage();
  page.onPracticeRulesChange({ detail: { value: true } });
  page.onPracticeStartDateChange({ detail: { value: '2026-09-01' } });
  page.onDailyGoalInput({ detail: { value: '45' } });
  page.onLoad();
  assert.equal(page.data.practiceRulesEnabled, false);
  assert.equal(page.data.practiceStartDate, '');
  assert.equal(page.data.dailyGoalMinutes, '');
});

test('team practice type selects the tag and matching goal units for all six practices', async () => {
  const types = [['sitting', '分钟', 1440], ['walking', '分钟', 1440], ['instant', '次', 1000000],
    ['learning', '分钟', 1440], ['kindness', '件', 100000], ['clapping', '分钟', 1440]];
  for (const [index, [type, unit, maximum]] of types.entries()) {
    const { page, calls } = createPage();
    page.onPracticeTypeChange({ detail: { value: String(index) } });
    assert.equal(page.data.practiceType, type);
    assert.equal(page.data.practiceUnit, unit);
    assert.equal(page.data.maxDailyGoal, maximum);
    page.onPracticeRulesChange({ detail: { value: true } });
    page.onDailyGoalInput({ detail: { value: String(maximum) } });
    await page.createTeam();
    assert.equal(calls.create[0].practiceType, type);
    assert.equal(calls.create[0].dailyGoalMinutes, maximum);
  }
});

test('switching practice types clears targets from the old unit and ignores invalid type choices', () => {
  const { page } = createPage();
  page.data.dailyGoalMinutes = 20;
  page.onPracticeTypeChange({ detail: { value: '2' } });
  assert.equal(page.data.dailyGoalMinutes, '');
  assert.deepEqual(Array.from(page.data.dailyGoalPresets), [1, 3, 10]);
  for (const value of ['-1', '1.5', '100', 'bad']) page.onPracticeTypeChange({ detail: { value } });
  assert.equal(page.data.practiceType, 'instant');
});

test('practice type is fixed in the moderated snapshot and cannot change after creation', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ checkText: () => pending.promise });
  page.onPracticeTypeChange({ detail: { value: '4' } });
  const request = page.createTeam();
  page.onPracticeTypeChange({ detail: { value: '1' } });
  assert.equal(page.data.practiceType, 'kindness');
  pending.resolve(true);
  await request;
  assert.equal(calls.create[0].practiceType, 'kindness');
  page.onPracticeTypeChange({ detail: { value: '1' } });
  assert.equal(page.data.practiceType, 'kindness');
});

test('each practice rejects invalid target ranges and unknown types before submission', async () => {
  for (const [index, value] of [[2, '1000001'], [4, '100001'], [1, '1441']]) {
    const { page, calls } = createPage();
    page.onPracticeTypeChange({ detail: { value: index } });
    page.onPracticeRulesChange({ detail: { value: true } });
    page.data.dailyGoalMinutes = value;
    await page.createTeam();
    assert.equal(calls.create.length, 0);
    assert.equal(calls.text.length, 0);
  }
  const { page, calls } = createPage();
  page.data.practiceType = 'invalid';
  await page.createTeam();
  assert.equal(calls.create.length, 0);
});

test('creation combines independent homework goals and rejects invalid secondary rules before moderation', async () => {
  const { page, calls } = createPage();
  page.toggleAdditionalPractice({ currentTarget: { dataset: { type: 'kindness' } } });
  page.changeAdditionalRule({ currentTarget: { dataset: { type: 'kindness', field: 'dailyGoalMinutes' } }, detail: { value: '3' } });
  page.toggleAdditionalPractice({ currentTarget: { dataset: { type: 'walking' } } });
  page.changeAdditionalRule({ currentTarget: { dataset: { type: 'walking', field: 'practiceStartDate' } }, detail: { value: '2026-09-01' } });
  await page.createTeam();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.create[0].practices)), [
    { practiceType: 'sitting', practiceStartDate: null, dailyGoalMinutes: null },
    { practiceType: 'kindness', practiceStartDate: null, dailyGoalMinutes: 3 },
    { practiceType: 'walking', practiceStartDate: '2026-09-01', dailyGoalMinutes: null }
  ]);
  const invalid = createPage();
  invalid.page.toggleAdditionalPractice({ currentTarget: { dataset: { type: 'walking' } } });
  invalid.page.changeAdditionalRule({ currentTarget: { dataset: { type: 'walking', field: 'dailyGoalMinutes' } }, detail: { value: '1441' } });
  await invalid.page.createTeam();
  assert.equal(invalid.calls.create.length, 0);
  assert.equal(invalid.calls.text.length, 0);
});
