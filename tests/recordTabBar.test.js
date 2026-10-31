const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const componentPath = path.join(__dirname, '../miniprogram/custom-tab-bar/index.js');
const HOME = 'pages/index/index';
const TIMER = 'pages/timer/timer';
const RECORDS = 'pages/practices/practices';
const TEAM = 'pages/team/team';
const ME = 'pages/me/me';
const SETTINGS = 'pages/practiceSettings/practiceSettings';
const TAB_ROUTES = [HOME, TIMER, RECORDS, TEAM, ME];
const FOUR_NAMES = ['首页', '计时', '团队', '我'];
const FIVE_NAMES = ['首页', '计时', '记录', '团队', '我'];
const plain = value => JSON.parse(JSON.stringify(value));
const tap = pagePath => ({ currentTarget: { dataset: { pagePath } } });

function harness({ route = HOME, options = {}, visible = false, alerts = {} } = {}) {
  let definition, account = 'owner-a', readFailure = false, currentPages = [];
  const settings = new Map([[account, visible]]), requests = [], toast = [], alertReads = [], writes = [];
  const pages = new Map(), bars = [], registered = new Set(), registrations = [], unregistrations = [];
  const app = {
    getSyncAlertState(options) { alertReads.push(plain(options)); return alerts; },
    registerTabBar(bar) { registrations.push(bar); registered.add(bar); },
    unregisterTabBar(bar) { unregistrations.push(bar); registered.delete(bar); },
    refreshTabBars() { registered.forEach(bar => bar.refresh()); }
  };
  const wx = {
    switchTab(options) { requests.push(options); },
    showToast(options) { toast.push(plain(options)); }
  };
  vm.runInNewContext(fs.readFileSync(componentPath, 'utf8'), {
    Component(value) { definition = value; },
    require(name) {
      assert.equal(name, '../utils/practicePreferences.js');
      return {
        getRecordsVisible() {
          if (readFailure) throw new Error('storage unavailable');
          return settings.get(account) === true;
        },
        saveRecordsVisible(value) { writes.push(value); settings.set(account, value); }
      };
    },
    getCurrentPages: () => currentPages,
    getApp: () => app,
    wx
  }, { filename: componentPath });

  function pageFor(pageRoute) {
    if (!pages.has(pageRoute)) {
      const page = { route: pageRoute, options: {}, bar: null, exposeBar: true };
      page.getTabBar = () => page.exposeBar ? page.bar : null;
      pages.set(pageRoute, page);
    }
    return pages.get(pageRoute);
  }
  function setRoute(pageRoute, pageOptions) {
    if (!pageRoute) { currentPages = []; return null; }
    const page = pageFor(pageRoute);
    if (arguments.length > 1) page.options = pageOptions;
    currentPages = [page];
    return page;
  }
  function createBar(pageRoute = currentPages.at(-1).route) {
    const page = pageFor(pageRoute);
    const bar = { ...definition.methods, data: structuredClone(definition.data),
      view: structuredClone(definition.data), patches: [], pendingView: [], frames: [], attachedForTest: false,
      setData(value, callback) {
        const patch = plain(value);
        this.patches.push(patch);
        Object.assign(this.data, plain(patch));
        this.pendingView.push({ patch, callback });
      } };
    bar.frames.push(plain(bar.view));
    page.bar = bar;
    bars.push(bar);
    return bar;
  }
  function attach(bar) {
    definition.lifetimes.attached.call(bar);
    bar.attachedForTest = true;
  }
  function show(bar) { definition.pageLifetimes.show.call(bar); }
  function flushView(bar) {
    while (bar.pendingView.length) {
      const { patch, callback } = bar.pendingView.shift();
      Object.assign(bar.view, plain(patch));
      bar.frames.push(plain(bar.view));
      if (callback) callback.call(bar);
    }
  }
  setRoute(route, options);
  const bar = createBar(route);
  return { bar, app, createBar, pageFor, definition, requests, toast, settings, alertReads, writes,
    registered, registrations, unregistrations,
    attach(target = bar) { attach(target); },
    detach(target = bar) {
      definition.lifetimes.detached.call(target);
      target.attachedForTest = false;
    },
    show(target = bar) { show(target); },
    setRoute,
    pushPage(pageRoute, pageOptions = {}) {
      const page = pageFor(pageRoute);
      page.options = pageOptions;
      currentPages = [...currentPages, page];
      return page;
    },
    flushView(target = bar) { flushView(target); },
    flushAll() { bars.forEach(flushView); },
    setVisible(value) { settings.set(account, value); },
    setAccount(value) { account = value; },
    failReads() { readFailure = true; },
    succeed(index = requests.length - 1) {
      const request = requests[index];
      const page = setRoute(request.url.slice(1));
      const target = page.bar || createBar(page.route);
      if (target.attachedForTest) show(target);
      else attach(target);
      request.success(); request.complete();
      return target;
    },
    fail(index = requests.length - 1) {
      const request = requests[index];
      request.fail({ errMsg: 'switchTab:fail' }); request.complete();
    }
  };
}

const names = bar => plain(bar.data.tabs.map(item => item.text));
const viewNames = bar => plain(bar.view.tabs.map(item => item.text));

function attachAllTabs(h) {
  const tabs = new Map([[HOME, h.bar]]);
  h.attach();
  for (const route of TAB_ROUTES.slice(1)) {
    h.setRoute(route);
    const bar = h.createBar(route); tabs.set(route, bar); h.attach(bar);
  }
  return tabs;
}

test('the first populated frame uses saved visibility, selected route and reminder together', () => {
  for (const visible of [false, true]) {
    const h = harness({ route: ME, visible, alerts: { backfillAdmin: true } });
    assert.deepEqual(names(h.bar), []);
    h.attach();
    assert.deepEqual(names(h.bar), visible ? FIVE_NAMES : FOUR_NAMES);
    assert.equal(h.bar.data.recordsVisible, visible);
    assert.equal(h.bar.data.selectedPath, ME);
    assert.equal(h.bar.data.hasMeAlert, true);
    assert.equal(h.bar.patches.length, 1, 'initial state crosses to the view in one update');
    assert.deepEqual(viewNames(h.bar), [], 'setData updates logic before the view renders');
    h.flushView();
    assert.equal(h.bar.frames.length, 2);
    assert.deepEqual(viewNames(h.bar), visible ? FIVE_NAMES : FOUR_NAMES);
    assert.equal(h.bar.view.selectedPath, ME);
    assert.equal(h.bar.view.hasMeAlert, true);
    assert.equal(h.requests.length, 0);
  }
});

test('each cached tab keeps its own route when settings are refreshed above it', () => {
  const h = harness({ visible: true }), tabs = attachAllTabs(h);
  h.pushPage(SETTINGS);
  h.setVisible(false); h.app.refreshTabBars();
  for (const [route, bar] of tabs) {
    assert.deepEqual(names(bar), FOUR_NAMES);
    assert.equal(bar.data.selectedPath, route === RECORDS ? '' : route);
  }
  assert.equal(h.requests.length, 0, 'a background records tab cannot dismiss settings');
  h.setVisible(true); h.app.refreshTabBars();
  for (const [route, bar] of tabs) {
    assert.deepEqual(names(bar), FIVE_NAMES);
    assert.equal(bar.data.selectedPath, route);
  }
});

test('attached bars register once and detached bars stop receiving global refreshes', () => {
  const h = harness({ visible: true }); h.attach();
  assert.deepEqual(h.registrations, [h.bar]);
  assert.equal(h.registered.has(h.bar), true);
  h.detach();
  assert.deepEqual(h.unregistrations, [h.bar]);
  assert.equal(h.registered.has(h.bar), false);
  h.setVisible(false); h.app.refreshTabBars();
  assert.deepEqual(names(h.bar), FIVE_NAMES);
});

test('hiding records updates cached bars before the first switch and never shows five again', () => {
  const h = harness({ visible: true }), tabs = attachAllTabs(h);
  h.flushAll();
  h.pushPage(SETTINGS);
  h.setVisible(false); h.app.refreshTabBars(); h.flushAll();
  const frameStarts = new Map([...tabs.values()].map(bar => [bar, bar.frames.length - 1]));
  h.setRoute(ME); h.show(tabs.get(ME));
  let current = tabs.get(ME);
  for (const route of [HOME, TIMER, TEAM, ME]) {
    const source = current, sourceRoute = source.data.selectedPath;
    source.onTabTap(tap(route));
    assert.equal(h.requests.at(-1).url, `/${route}`);
    current = h.succeed(); h.flushAll();
    assert.equal(source.data.selectedPath, sourceRoute, 'callbacks do not rebind the old bar');
    assert.equal(current.data.selectedPath, route);
    assert.deepEqual(viewNames(current), FOUR_NAMES, 'the first click already has four tabs');
  }
  for (const bar of tabs.values()) {
    const frames = bar.frames.slice(frameStarts.get(bar));
    assert.ok(frames.length);
    assert.ok(frames.every(frame => frame.tabs.length === 4), 'no stale records entry returns');
  }
  assert.equal(h.requests.length, 4);
});

test('a new instance reads changed preferences after the same definition was already used', () => {
  const h = harness({ visible: true }); h.attach(); h.flushView();
  h.setVisible(false); h.app.refreshTabBars();
  h.setRoute(TIMER);
  const timer = h.createBar(TIMER); h.attach(timer); h.flushView(timer);
  assert.deepEqual(timer.frames.map(frame => frame.tabs.length), [0, 4]);
  assert.equal(timer.view.selectedPath, TIMER);
  h.setVisible(true); h.app.refreshTabBars(); h.flushAll();
  assert.deepEqual(viewNames(h.bar), FIVE_NAMES);
  assert.deepEqual(viewNames(timer), FIVE_NAMES);
});

test('repeated refreshes and taps do not resend unchanged tab arrays or selection', () => {
  const alerts = {}, h = harness({ alerts }); h.attach(); h.flushView();
  const initialCount = h.bar.patches.length;
  h.show(); h.bar.refresh(); h.app.refreshTabBars();
  h.bar.onTabTap(tap(HOME)); h.bar.onTabTap(tap('pages/profile/profile'));
  assert.equal(h.bar.patches.length, initialCount);
  alerts.user = true; h.bar.refresh();
  assert.deepEqual(h.bar.patches.at(-1), { hasMeAlert: true });
  h.setVisible(true); h.bar.refresh();
  assert.equal(h.bar.patches.filter(patch => Object.hasOwn(patch, 'tabs')).length, 2);
  assert.equal(Object.hasOwn(h.bar.patches.at(-1), 'selectedPath'), false);
});

test('a bar binds to its own page below settings instead of adopting the top route', () => {
  const h = harness({ route: ME });
  h.pushPage(SETTINGS); h.attach();
  assert.equal(h.bar.data.selectedPath, ME);
  h.setRoute(HOME); h.bar.refresh(); h.show();
  assert.equal(h.bar.data.selectedPath, ME);
  assert.equal(h.requests.length, 0);
});

test('a top tab can be captured before getTabBar becomes available', () => {
  const h = harness({ route: TIMER });
  h.pageFor(TIMER).exposeBar = false; h.attach();
  assert.equal(h.bar.data.selectedPath, TIMER);
  h.pageFor(TIMER).exposeBar = true;
  h.pushPage(SETTINGS); h.bar.refresh();
  assert.equal(h.bar.data.selectedPath, TIMER);
});

test('a destination attached before the stack changes never selects a ready source page', () => {
  const h = harness({ visible: true }); h.attach(); h.flushView();
  const timer = h.createBar(TIMER);
  h.attach(timer); h.flushView(timer);
  assert.equal(timer.data.selectedPath, '', 'the source already belongs to a different bar');
  assert.ok(timer.frames.every(frame => frame.selectedPath !== HOME));
  h.setRoute(TIMER); h.show(timer); h.flushView(timer);
  assert.equal(timer.data.selectedPath, TIMER);
  assert.equal(timer.view.selectedPath, TIMER);
  assert.equal(h.bar.data.selectedPath, HOME);
  assert.ok(timer.frames.every(frame => frame.selectedPath !== HOME));
  assert.equal(h.requests.length, 0);
});

test('destination show corrects provisional ownership while both page APIs are still unavailable', () => {
  const h = harness({ visible: true });
  h.pageFor(HOME).exposeBar = false; h.attach();
  const timer = h.createBar(TIMER);
  h.pageFor(TIMER).exposeBar = false;
  h.attach(timer);
  assert.equal(timer.data.selectedPath, HOME, 'early attach can only capture the old stack provisionally');
  h.setRoute(TIMER); h.show(timer); h.flushView(timer);
  assert.equal(timer.data.selectedPath, TIMER, 'show rechecks its own newly visible page');
  assert.equal(timer.view.selectedPath, TIMER);
  assert.equal(h.bar.data.selectedPath, HOME);
  h.pageFor(TIMER).exposeBar = true; timer.refresh();
  h.setRoute(HOME); timer.refresh();
  assert.equal(timer.data.selectedPath, TIMER, 'later background refreshes preserve verified ownership');
  assert.equal(h.requests.length, 0);
});

test('account changes reload visibility and an active hidden records page returns home once', () => {
  const h = harness({ visible: true, route: RECORDS }); h.attach();
  assert.equal(h.bar.data.selectedPath, RECORDS);
  h.setAccount('owner-b'); h.show(); h.bar.refresh();
  assert.deepEqual(names(h.bar), FOUR_NAMES);
  assert.equal(h.bar.data.selectedPath, '');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `/${HOME}`);
  const home = h.succeed();
  assert.equal(home.data.selectedPath, HOME);
  assert.equal(h.bar.data.selectedPath, '', 'the cached records bar keeps its hidden selection');
  h.setAccount('owner-a'); h.app.refreshTabBars();
  assert.deepEqual(names(h.bar), FIVE_NAMES);
  assert.equal(h.bar.data.selectedPath, RECORDS);
  assert.equal(home.data.selectedPath, HOME);
  assert.equal(h.requests.length, 1);
});

test('disabling the active records page redirects without selecting an absent tab', () => {
  const h = harness({ visible: true, route: RECORDS }); h.attach();
  h.setVisible(false); h.bar.refresh();
  assert.equal(h.bar.data.selectedPath, '');
  assert.equal(h.requests.length, 1);
  h.fail();
  assert.equal(h.bar.data.selectedPath, '');
  assert.equal(h.requests.length, 1);
  h.show();
  assert.equal(h.requests.length, 2, 'showing the page may retry a failed redirect');
});

test('background records bars never navigate during settings or another tab refresh', () => {
  const h = harness({ visible: true, route: RECORDS }); h.attach();
  h.pushPage(SETTINGS); h.setVisible(false); h.app.refreshTabBars();
  assert.equal(h.requests.length, 0);
  h.setRoute(HOME);
  const home = h.createBar(HOME); h.attach(home); h.app.refreshTabBars();
  h.bar.onTabTap(tap(HOME)); h.bar.onTabTap(tap(TIMER));
  assert.equal(h.requests.length, 0, 'a delayed background gesture cannot navigate');
  assert.equal(home.data.selectedPath, HOME);
  assert.equal(h.bar.data.selectedPath, '');
  h.setRoute(RECORDS); h.show();
  assert.equal(h.requests.length, 1, 'only showing the hidden records page redirects');
});

test('a shared records entry stays open without restoring its hidden tab or saving preferences', () => {
  const options = { from: 'share' }, h = harness({ route: RECORDS, options });
  h.attach(); h.show(); h.bar.refresh();
  assert.deepEqual(names(h.bar), FOUR_NAMES);
  assert.equal(h.bar.data.recordsVisible, false);
  assert.equal(h.bar.data.selectedPath, '');
  assert.equal(h.settings.get('owner-a'), false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.requests.length, 0);
  h.bar.onTabTap(tap(HOME));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `/${HOME}`);
  const home = h.succeed();
  assert.equal(home.data.selectedPath, HOME);
  assert.equal(h.bar.data.selectedPath, '');
  delete options.from; // The record page clears this marker in onHide.
  h.setRoute(RECORDS); h.show();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, `/${HOME}`);
  assert.deepEqual(h.writes, []);
});

test('only the exact share query on the current records page bypasses the hidden-route redirect', () => {
  for (const options of [undefined, null, {}, { from: 'Share' }, { from: true }, { from: 'timeline' }, { share: true }]) {
    const h = harness({ route: RECORDS, options }); h.attach();
    assert.equal(h.requests.length, 1, JSON.stringify(options));
    assert.equal(h.requests[0].url, `/${HOME}`);
    assert.deepEqual(h.writes, []);
  }
  const h = harness({ options: { from: 'share' } }); h.attach();
  h.bar.onTabTap(tap(RECORDS));
  assert.equal(h.requests.length, 0, 'a share marker on another page cannot expose records');
  h.setRoute(RECORDS);
  const records = h.createBar(RECORDS); h.attach(records);
  assert.equal(h.requests.length, 1, 'another page cannot reuse an earlier share marker');
});

test('a shared records entry remains accessible when preferences cannot be read', () => {
  const options = { from: 'share' }, h = harness({ route: RECORDS, options, visible: true });
  h.failReads(); h.attach(); h.show();
  assert.deepEqual(names(h.bar), FOUR_NAMES);
  assert.equal(h.bar.data.recordsVisible, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.settings.get('owner-a'), true);
  assert.deepEqual(h.writes, []);
  delete options.from; h.show();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `/${HOME}`);
});

test('stale records taps are rejected after a setting or account change', () => {
  for (const change of ['setting', 'account']) {
    const h = harness({ visible: true }); h.attach();
    if (change === 'setting') h.setVisible(false);
    else h.setAccount('owner-b');
    h.bar.onTabTap(tap(RECORDS));
    assert.equal(h.requests.length, 0);
    assert.deepEqual(names(h.bar), FOUR_NAMES);
    assert.equal(h.bar.data.selectedPath, HOME);
  }
});

test('navigation failure preserves selection and success does not rebind the old bar', () => {
  const h = harness({ visible: true }); h.attach();
  h.bar.onTabTap(tap(RECORDS));
  assert.equal(h.requests[0].url, `/${RECORDS}`);
  assert.equal(h.bar.data.selectedPath, HOME);
  h.bar.onTabTap(tap(ME));
  assert.equal(h.requests.length, 1, 'repeated taps cannot start concurrent switches');
  h.fail();
  assert.equal(h.bar.data.selectedPath, HOME);
  assert.deepEqual(h.toast, [{ title: '页面打开失败，请重试', icon: 'none' }]);
  h.bar.onTabTap(tap(ME));
  const me = h.succeed(); h.flushAll();
  assert.equal(me.data.selectedPath, ME);
  assert.equal(h.bar.data.selectedPath, HOME);
  assert.equal(h.bar.data.tabs.length, 5);
  h.bar.onTabTap(tap(TIMER));
  assert.equal(h.requests.length, 2, 'late taps from the previous page are ignored');
});

test('tapping the current route or an invalid target does not navigate', () => {
  const h = harness(); h.attach();
  for (const target of [HOME, 'pages/profile/profile', '', undefined]) h.bar.onTabTap(tap(target));
  h.bar.onTabTap(null);
  assert.equal(h.requests.length, 0);
});

test('all four reminders appear on Me and explicit updates clear or restore the dot', () => {
  for (const source of ['admin', 'user', 'backfillUser', 'backfillAdmin']) {
    const alerts = { [source]: true }, h = harness({ alerts }); h.attach();
    assert.equal(h.bar.data.hasMeAlert, true, source);
    h.bar.setMeAlert(false);
    assert.equal(h.bar.data.hasMeAlert, false);
    h.show();
    assert.equal(h.bar.data.hasMeAlert, true);
    alerts[source] = false; h.bar.refresh();
    assert.equal(h.bar.data.hasMeAlert, false);
    h.bar.setMeAlert(true);
    assert.equal(h.bar.data.hasMeAlert, true);
  }
});

test('unreadable preferences safely omit records', () => {
  const h = harness({ visible: true }); h.attach();
  h.failReads(); h.bar.refresh();
  assert.deepEqual(names(h.bar), FOUR_NAMES);
});

test('markup preserves route keys, original icons, overlay layer and safe area padding', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxss'), 'utf8');
  assert.match(wxml, /wx:key="pagePath"/);
  assert.match(wxml, /data-page-path="\{\{item.pagePath\}\}"/);
  assert.match(wxml, /item.pagePath === 'pages\/me\/me' && hasMeAlert/);
  assert.match(wxss, /height: 50px/);
  assert.match(wxss, /env\(safe-area-inset-bottom\)/);
  assert.match(wxss, /z-index: 90/);
  const h = harness({ visible: true }); h.attach();
  const configured = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8')).tabBar.list;
  assert.deepEqual(plain(h.bar.data.tabs), configured);
});
