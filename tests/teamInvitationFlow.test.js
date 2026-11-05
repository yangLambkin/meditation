const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const miniRoot = path.join(__dirname, '../miniprogram');
const pageFile = path.join(miniRoot, 'subpackages/team/pages/joinTeam/joinTeam.js');
const invitation = { teamId: 'bijing_12', inviteId: 'a'.repeat(64), inviterId: 'wx-leader' };
const boundProfile = { _openid: 'wx-student', nickName: '同行者', bijingBound: true,
  bijingStudentNumber: 'BJ007', bijingBindingVersion: 'binding-v1' };
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Keep the real identity, gateway, transport, profile-cache and page modules in
// one isolated runtime. Only WeChat's storage/network/navigation are simulated.
function harness({ stored = {}, profile = boundProfile, cloudProfile, previewInvite, postInvite, timers = {} } = {}) {
  const storage = new Map(Object.entries({ userOpenId: 'wx-student', userInfo: { _openid: 'wx-student', nickName: '同行者' }, ...clone(stored) }));
  const calls = { cloud: [], requests: [], navigations: [], switches: [], redirects: [], modals: [], toasts: [] };
  const joined = new Set();
  const postStarted = deferred();
  const team = { id: 12, name: '一起觉察', description: '每日练习', iconUrl: '', practiceType: 'instant',
    practiceStartDate: null, effectivePracticeStartDate: '2026-11-05', dailyGoal: null, dayBoundaryHour: 2,
    unit: '次', leaderMemberId: 1, leaderName: '团长', memberCount: 1, version: 1,
    createdAt: '2026-11-05 10:00:00', updatedAt: '2026-11-05 10:00:00', myRole: null };
  const actorId = request => request.header['X-Expected-Student-Number'] === 'BJ008' ? 9 : 8;
  const isBound = request => !!request.header['X-Expected-Student-Number'];
  const ownTeam = request => ({ ...team, myRole: joined.has(actorId(request)) ? 'member' : null,
    memberCount: 1 + joined.size });
  const publicTeam = request => {
    const result = ownTeam(request);
    delete result.leaderMemberId;
    return result;
  };
  const response = (request, data) => ({ statusCode: 200, data: { success: true,
    data: { ...data, actorMemberId: isBound(request) ? actorId(request) : null } } });
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    hideShareMenu() {}, setNavigationBarTitle() {}, showLoading() {}, hideLoading() {},
    showModal: options => calls.modals.push(clone(options)),
    showToast: options => calls.toasts.push(clone(options)),
    navigateTo(options) { calls.navigations.push(clone(options)); options.success?.(); options.complete?.(); },
    switchTab(options) { calls.switches.push(clone(options)); options.success?.(); options.complete?.(); },
    redirectTo(options) { calls.redirects.push(clone(options)); options.success?.(); options.complete?.(); },
    cloud: { callFunction(options) {
      calls.cloud.push(clone({ name: options.name, data: options.data }));
      const promise = Promise.resolve().then(() => {
        if (options.name === 'meditationManager' && options.data.type === 'getUserProfile') {
          return cloudProfile ? cloudProfile(options) : { result: { success: true, data: clone(profile) } };
        }
        if (options.name === 'teamManager' && options.data.type === 'getUserTeams') {
          return { result: { success: true, data: [] } };
        }
        throw new Error(`Unexpected cloud request: ${options.name}/${options.data.type}`);
      });
      promise.then(value => options.success?.(value), error => options.fail?.(error));
      return promise;
    } },
    request(options) {
      const request = clone({ url: options.url, method: options.method || 'GET', header: options.header, data: options.data });
      calls.requests.push(request);
      Promise.resolve().then(async () => {
        const url = new URL(request.url);
        const suffix = url.pathname.slice('/api/openapi/teams'.length);
        if (!suffix && request.method === 'GET') {
          const teams = url.searchParams.get('scope') === 'mine'
            ? joined.has(actorId(request)) ? [ownTeam(request)] : [] : [publicTeam(request)];
          return response(request, { teams, nextCursor: null });
        }
        if (suffix === '/invites/' + invitation.inviteId && request.method === 'GET') {
          const override = previewInvite ? await previewInvite(request) : undefined;
          if (override) return override;
          return response(request, { team: publicTeam(request), isMember: joined.has(actorId(request)),
            expireTime: new Date(Date.now() + 86400000).toISOString() });
        }
        if (suffix === '/invites/' + invitation.inviteId && request.method === 'POST') {
          postStarted.resolve(request);
          const override = postInvite ? await postInvite(request) : undefined;
          if (override) return override;
          joined.add(actorId(request));
          return response(request, { teamId: 12 });
        }
        if (suffix === '/12' && request.method === 'GET') {
          if (!joined.has(actorId(request))) return { statusCode: 403, data: { success: false, message: '仅团队成员可查看' } };
          return response(request, { team: ownTeam(request), members: [
            { memberId: 1, nickname: '团长', studentNumber: 'BJ001', role: 'creator' },
            { memberId: actorId(request), nickname: '同行者', studentNumber: request.header['X-Expected-Student-Number'], role: 'member' }
          ], isAdmin: false });
        }
        throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
      }).then(options.success, options.fail);
      return { abort() {} };
    }
  };
  let definition;
  const context = vm.createContext({ wx, URL, setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout, queueMicrotask,
    console: { log() {}, warn() {}, error() {} }, Page(value) { definition = value; } });
  const modules = new Map();
  function load(file) {
    const resolved = path.resolve(file);
    if (modules.has(resolved)) return modules.get(resolved).exports;
    const module = { exports: {} };
    modules.set(resolved, module);
    const wrapper = vm.runInContext(`(function(require,module,exports,__filename,__dirname){\n${fs.readFileSync(resolved, 'utf8')}\n})`, context, { filename: resolved });
    wrapper(name => {
      if (!name.startsWith('.')) throw new Error(`Unexpected external module: ${name}`);
      return load(path.resolve(path.dirname(resolved), name));
    }, module, module.exports, resolved, path.dirname(resolved));
    return module.exports;
  }
  load(pageFile);
  const createPage = () => ({ ...definition, data: clone(definition.data), setData(values) { Object.assign(this.data, clone(values)); } });
  const profileCache = load(path.join(miniRoot, 'utils/profileCache.js'));
  const auth = load(path.join(miniRoot, 'utils/practiceAuth.js'));
  function applyBinding(binding = boundProfile) {
    const account = storage.get('userOpenId');
    const patch = { bijingBound: binding.bijingBound, bijingStudentNumber: binding.bijingStudentNumber,
      bijingBindingVersion: binding.bijingBindingVersion };
    profileCache.rememberBijingBinding(patch, account);
    profileCache.updateProfile(patch, account);
    wx.setStorageSync(`bijingStatus_${account}`, { account, updatedAt: Date.now(), binding: patch });
  }
  return { createPage, storage, calls, auth, profileCache, applyBinding, postStarted: postStarted.promise,
    posts: () => calls.requests.filter(request => request.method === 'POST' && request.url.includes('/invites/')) };
}

test('a data invitation restores an existing cloud binding before accepting through the actual gateway', async () => {
  const h = harness();
  const page = h.createPage();
  assert.equal(h.auth.getOwner(), null);
  await page.onLoad(invitation);
  await page.joinTeam();
  assert.equal(h.calls.cloud.filter(call => call.name === 'meditationManager' && call.data.type === 'getUserProfile').length, 1);
  assert.equal(h.auth.getOwner().studentNumber, 'BJ007');
  assert.equal(h.auth.getOwner().bindingVersion, 'binding-v1');
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].header['X-Expected-Student-Number'], 'BJ007');
  assert.equal(h.posts()[0].header['X-Expected-Binding-Version'], 'binding-v1');
  assert.equal(page.data.isMember, true);
  assert.equal(h.calls.switches.length, 0);
  assert.equal(h.calls.redirects.length, 1);
});

test('an unbound student is told about binding and the original invitation resumes only after binding is available', async () => {
  const post = deferred();
  const h = harness({ profile: { _openid: 'wx-student', bijingBound: false }, postInvite: () => post.promise });
  const original = h.createPage();
  await original.onLoad(invitation);
  await original.joinTeam();
  assert.equal(h.posts().length, 0);
  assert.equal(h.calls.switches.length, 0);
  assert.equal(h.calls.navigations.length, 0);
  assert.equal(h.calls.redirects.length, 0);
  assert.match(h.calls.modals.at(-1).content, /绑定.*学号|学号.*绑定/);
  const pending = h.storage.get('pendingTeamInvitation');
  assert.equal(pending.teamId, invitation.teamId);
  assert.equal(pending.inviteId, invitation.inviteId);
  assert.equal(pending.inviterId, invitation.inviterId);
  h.applyBinding();
  const returned = h.createPage();
  const loading = returned.onLoad(invitation);
  await h.postStarted;
  assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
  assert.equal(returned.data.isMember, false);
  post.resolve();
  await loading;
  assert.equal(returned.data.isMember, true);
  assert.equal(h.storage.has('pendingTeamInvitation'), false);
  assert.equal(h.calls.redirects.length, 1);
});

test('a failed resumed join preserves the pending invitation for retry', async () => {
  let failing = true;
  const h = harness({ profile: { _openid: 'wx-student', bijingBound: false }, postInvite: () => failing
    ? { statusCode: 503, data: { success: false, message: '暂时不可用' } } : undefined });
  const original = h.createPage();
  await original.onLoad(invitation);
  await original.joinTeam();
  h.applyBinding();
  const returned = h.createPage();
  await returned.onLoad(invitation);
  assert.equal(returned.data.isMember, false);
  assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
  assert.equal(h.calls.redirects.length, 0);
  failing = false;
  await returned.joinTeam();
  assert.equal(returned.data.isMember, true);
  assert.equal(h.storage.has('pendingTeamInvitation'), false);
});

test('cloud binding recovery failure retains the invitation and does not send an acceptance', async () => {
  const h = harness({ cloudProfile: () => { throw new Error('云端暂时不可用'); } });
  const page = h.createPage();
  await page.onLoad(invitation);
  await page.joinTeam();
  assert.equal(h.posts().length, 0);
  assert.equal(page.data.isMember, false);
  assert.equal(h.calls.redirects.length, 0);
  assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
});

test('a binding-recovery timeout unlocks retry and ignores the original cloud reply when it arrives late', async () => {
  const late = deferred(), started = deferred();
  const deadlines = new Set();
  let attempt = 0;
  const h = harness({
    cloudProfile() {
      if (++attempt === 1) { started.resolve(); return late.promise; }
      return { result: { success: true, data: boundProfile } };
    },
    timers: {
      setTimeout(callback, milliseconds, ...args) {
        if (milliseconds !== 10000) return setTimeout(callback, milliseconds, ...args);
        const deadline = { callback };
        deadlines.add(deadline);
        return deadline;
      },
      clearTimeout(timer) {
        if (!deadlines.delete(timer)) clearTimeout(timer);
      }
    }
  });
  const page = h.createPage();
  await page.onLoad(invitation);
  const joining = page.joinTeam();
  await started.promise;
  assert.equal(page.data.isCheckingBinding, true);
  assert.equal(deadlines.size, 1);
  for (const deadline of deadlines) deadline.callback();
  await joining;
  assert.equal(page.data.isCheckingBinding, false);
  assert.equal(page.data.isJoining, false);
  assert.equal(h.posts().length, 0);
  assert.equal(h.auth.getOwner(), null);
  assert.match(h.calls.modals.at(-1).content, /超时/);
  assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
  late.resolve({ result: { success: true, data: boundProfile } });
  // Let the actual callback-style cloud wrapper consume the abandoned reply.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.auth.getOwner(), null);
  assert.equal(h.storage.has('bijingStatus_wx-student'), false);
  assert.equal(h.posts().length, 0);
  assert.equal(page.data.isMember, false);
  await page.joinTeam();
  assert.equal(attempt, 2);
  assert.equal(h.posts().length, 1);
  assert.equal(page.data.isMember, true);
  assert.equal(h.storage.has('pendingTeamInvitation'), false);
  assert.equal(deadlines.size, 0);
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`a binding-recovery reply after ${lifecycle} cannot save ownership or continue joining`, async () => {
    const recovery = deferred(), started = deferred();
    const h = harness({ cloudProfile: () => { started.resolve(); return recovery.promise; } });
    const page = h.createPage();
    await page.onLoad(invitation);
    const joining = page.joinTeam();
    await started.promise;
    page[lifecycle]();
    recovery.resolve({ result: { success: true, data: boundProfile } });
    await joining;
    assert.equal(h.auth.getOwner(), null);
    assert.equal(h.storage.has('bijingStatus_wx-student'), false);
    assert.equal(h.storage.get('userInfo').bijingBound, undefined);
    assert.equal(h.posts().length, 0);
    assert.equal(page.data.isMember, false);
    assert.equal(h.calls.modals.length, 0);
    assert.equal(h.calls.redirects.length, 0);
    assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
  });
}

test('a resumed bound invitation waits for the page to be visible before automatically accepting', async () => {
  const preview = deferred(), started = deferred();
  let previews = 0;
  const h = harness({ stored: { userInfo: boundProfile,
    pendingTeamInvitation: { ...invitation, account: 'wx-student', expiresAt: Date.now() + 600000 } },
    previewInvite() {
      if (++previews === 1) { started.resolve(); return preview.promise; }
    }
  });
  const page = h.createPage();
  const loading = page.onLoad(invitation);
  await started.promise;
  await page.onShow();
  page.onHide();
  preview.resolve();
  await loading;
  assert.equal(h.posts().length, 0);
  assert.equal(page.data.isMember, false);
  assert.equal(h.storage.get('pendingTeamInvitation').inviteId, invitation.inviteId);
  await page.onShow();
  assert.equal(h.posts().length, 1);
  assert.equal(page.data.isMember, true);
  assert.equal(h.storage.has('pendingTeamInvitation'), false);
  assert.equal(h.calls.redirects.length, 1);
});

test('an initially unbound student can retry the same invitation page after binding the account', async () => {
  const h = harness({ profile: { _openid: 'wx-student', bijingBound: false } });
  const page = h.createPage();
  await page.onLoad(invitation);
  await page.joinTeam();
  assert.equal(h.posts().length, 0);
  h.applyBinding();
  // Returning to a retained page refreshes its viewer before the next tap.
  await page.onShow();
  if (!page.data.isMember) await page.joinTeam();
  assert.equal(page.data.isMember, true);
  assert.equal(h.posts().length, 1);
  assert.equal(h.storage.has('pendingTeamInvitation'), false);
});

for (const change of ['account', 'binding']) {
  test(`cloud binding recovery cannot restore stale ownership after a ${change} change`, async () => {
    const recovery = deferred(), started = deferred();
    const h = harness({ cloudProfile: () => { started.resolve(); return recovery.promise; } });
    const page = h.createPage();
    await page.onLoad(invitation);
    const joining = page.joinTeam();
    await started.promise;
    if (change === 'account') {
      h.storage.set('userOpenId', 'wx-other');
      h.storage.set('userInfo', { _openid: 'wx-other', bijingBound: false });
    } else {
      h.applyBinding({ ...boundProfile, bijingStudentNumber: 'BJ008', bijingBindingVersion: 'binding-v2' });
    }
    const other = { teamId: 'bijing_99', inviteId: 'b'.repeat(64), inviterId: 'another-leader', expiresAt: Date.now() + 600000 };
    h.storage.set('pendingTeamInvitation', other);
    recovery.resolve({ result: { success: true, data: boundProfile } });
    await joining;
    assert.equal(h.posts().length, 0);
    assert.equal(page.data.isMember, false);
    assert.equal(h.calls.redirects.length, 0);
    assert.deepEqual(h.storage.get('pendingTeamInvitation'), other);
    if (change === 'account') assert.equal(h.auth.getOwner(), null);
    else assert.equal(h.auth.getOwner().studentNumber, 'BJ008');
  });
}

for (const change of ['account', 'binding']) {
  test(`a successful HTTP reply cannot apply membership or clear another invitation after a ${change} change`, async () => {
    const post = deferred();
    const h = harness({ stored: { userInfo: boundProfile }, postInvite: () => post.promise });
    const page = h.createPage();
    await page.onLoad(invitation);
    const joining = page.joinTeam();
    await h.postStarted;
    if (change === 'account') {
      h.storage.set('userOpenId', 'wx-other');
      h.storage.set('userInfo', { _openid: 'wx-other', bijingBound: true, bijingStudentNumber: 'BJ008', bijingBindingVersion: 'binding-v2' });
    } else {
      h.applyBinding({ ...boundProfile, bijingStudentNumber: 'BJ008', bijingBindingVersion: 'binding-v2' });
    }
    const other = { teamId: 'bijing_99', inviteId: 'b'.repeat(64), inviterId: 'another-leader', expiresAt: Date.now() + 600000 };
    h.storage.set('pendingTeamInvitation', other);
    post.resolve();
    await joining;
    assert.equal(page.data.isMember, false);
    assert.equal(h.calls.redirects.length, 0);
    assert.deepEqual(h.storage.get('pendingTeamInvitation'), other);
    assert.equal(h.posts().length, 1);
  });
}

test('finishing one invitation preserves a different invitation accepted while its request was in flight', async () => {
  const post = deferred();
  const h = harness({ stored: { userInfo: boundProfile }, postInvite: () => post.promise });
  const page = h.createPage();
  await page.onLoad(invitation);
  const joining = page.joinTeam();
  await h.postStarted;
  const other = { teamId: 'bijing_99', inviteId: 'b'.repeat(64), inviterId: 'another-leader', expiresAt: Date.now() + 600000 };
  h.storage.set('pendingTeamInvitation', other);
  post.resolve();
  await joining;
  assert.equal(page.data.isMember, true);
  assert.deepEqual(h.storage.get('pendingTeamInvitation'), other);
});
