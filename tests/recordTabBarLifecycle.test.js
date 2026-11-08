const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../miniprogram');
const HOME = 'pages/index/index';
const RECORDS = 'pages/practices/practices';
const TEAM = 'pages/team/team';
const ME = 'pages/me/me';
const SETTINGS = 'pages/practiceSettings/practiceSettings';
const ALL_ROUTES = [HOME, RECORDS, TEAM, ME];
const plain = value => JSON.parse(JSON.stringify(value));
const tap = pagePath => ({ currentTarget: { dataset: { pagePath } } });
const hasTabs = patch => Object.hasOwn(patch, 'tabs');

function harness() {
  const storage = new Map([['userOpenId', 'tab-lifecycle-owner']]);
  const pages = new Map();
  const requests = [], firstRenders = [], toast = [], nativeDots = [];
  let stack = [], app, component, settingsDefinition;
  const wx = {
    getStorageSync(key) { return structuredClone(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, structuredClone(value)); },
    switchTab(options) { requests.push(options); },
    showToast(options) { toast.push(plain(options)); },
    showTabBarRedDot(options) { nativeDots.push({ visible: true, index: options.index }); },
    hideTabBarRedDot(options) { nativeDots.push({ visible: false, index: options.index }); }
  };
  const preferencesModule = { exports: {} };
  function load(relativePath, globals) {
    const filename = path.join(ROOT, relativePath);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      wx, console, getCurrentPages: () => stack, getApp: () => app, ...globals
    }, { filename });
  }
  load('utils/practicePreferences.js', { module: preferencesModule, exports: preferencesModule.exports });
  const preferences = preferencesModule.exports;
  load('app.js', {
    App(value) { app = value; },
    require(name) {
      assert.equal(name, './utils/checkin.js');
      return {};
    }
  });
  app.getTimerModule = () => ({ onLaunch() {}, onShow() {}, onHide() {} });
  load('custom-tab-bar/index.js', {
    Component(value) { component = value; },
    require(name) {
      assert.equal(name, '../utils/practicePreferences.js');
      return preferences;
    }
  });
  load('pages/practiceSettings/practiceSettings.js', {
    Page(value) { settingsDefinition = value; },
    require(name) {
      assert.equal(name, '../../utils/practicePreferences.js');
      return preferences;
    }
  });

  function createBar(page) {
    const bar = {
      ...component.methods,
      data: structuredClone(component.data),
      initialData: plain(component.data),
      patches: [],
      calls: { refresh: 0, setMeAlert: 0 },
      setData(patch) {
        this.patches.push(plain(patch));
        Object.assign(this.data, patch);
      }
    };
    for (const name of ['refresh', 'setMeAlert']) {
      const method = bar[name];
      bar[name] = function (...args) {
        this.calls[name]++;
        return method.apply(this, args);
      };
    }
    page.bar = bar;
    return bar;
  }

  function enterTab(route, options = {}) {
    let page = pages.get(route);
    const fresh = !page;
    if (fresh) {
      // These page objects retain their identities while cached pages disappear
      // from getCurrentPages(), as they do during a real tab switch.
      page = { route, options, getTabBar() { return this.bar; } };
      pages.set(route, page);
      createBar(page);
    }
    stack = [page];
    if (fresh) component.lifetimes.attached.call(page.bar);
    const firstRender = { route, tabs: plain(page.bar.data.tabs), selectedPath: page.bar.data.selectedPath };
    firstRenders.push(firstRender);
    // Capture the cached component before show can repair a stale render.
    component.pageLifetimes.show.call(page.bar);
    return firstRender;
  }

  function switchTo(route) {
    const source = stack.at(-1);
    assert.ok(source && source.bar, 'tab gestures originate on the active tab');
    const before = requests.length;
    source.bar.onTabTap(tap(route));
    assert.equal(requests.length, before + 1, `the first tap must navigate to ${route}`);
    const request = requests.at(-1);
    assert.equal(request.url, `/${route}`);
    const firstRender = enterTab(route);
    request.success();
    request.complete();
    return firstRender;
  }

  function openSettings() {
    assert.equal(stack.at(-1).route, ME);
    const settings = {
      ...settingsDefinition,
      route: SETTINGS,
      data: structuredClone(settingsDefinition.data),
      setData(patch) { Object.assign(this.data, patch); }
    };
    stack = [pages.get(ME), settings];
    settings.onShow();
    return settings;
  }

  return {
    app, preferences, pages, requests, firstRenders, toast, nativeDots,
    get stack() { return stack; },
    enterTab, switchTo, openSettings,
    warmTabs() {
      enterTab(HOME);
      for (const route of ALL_ROUTES.slice(1)) switchTo(route);
    },
    closeSettings() { return enterTab(ME); },
    toggle(settings, visible) { settings.onRecordVisibilityChange({ detail: { value: visible } }); },
    clearObservations() {
      for (const { bar } of pages.values()) {
        bar.patches.length = 0;
        bar.calls.refresh = 0;
        bar.calls.setMeAlert = 0;
      }
    },
    detach(route) { component.lifetimes.detached.call(pages.get(route).bar); },
    show(route) { component.pageLifetimes.show.call(pages.get(route).bar); },
    alerts(state) {
      app._syncAlertVisible = true;
      app._syncAlertAccount = storage.get('userOpenId');
      app._syncAlertState = state;
      app.applySyncAlertDot();
    }
  };
}

function assertLayout(bar, visible, route) {
  assert.deepEqual(plain(bar.data.tabs.map(tab => tab.pagePath)),
    ALL_ROUTES.filter(item => visible || item !== RECORDS), route);
  assert.equal(bar.data.recordsVisible, visible, route);
  assert.equal(bar.data.selectedPath, route === RECORDS && !visible ? '' : route, route);
}

function assertFirstRender(render, visible) {
  assert.deepEqual(render.tabs.map(tab => tab.pagePath),
    ALL_ROUTES.filter(route => visible || route !== RECORDS), `first render of ${render.route}`);
  assert.equal(render.selectedPath, render.route);
}

test('every tab page synchronizes its own component before show and ready business work', () => {
  for (const route of ALL_ROUTES) {
    let definition;
    const stopAfterSync = new Error('tab synchronized');
    const received = [];
    const app = { syncTabBar(page) { received.push(page); throw stopAfterSync; } };
    const filename = path.join(ROOT, `${route}.js`);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      Page(value) { definition = value; },
      getApp: () => app,
      require(name) {
        if (name === './practicePage.js') return () => ({ onShow() {} });
        return { PRACTICES: [], DEFAULT_QUOTE: '', methods: {}, data: {}, timerAudioMethods: {} };
      }
    }, { filename });
    const page = { route };
    for (const lifecycle of ['onShow', 'onReady']) {
      assert.equal(typeof definition[lifecycle], 'function', `${route}: ${lifecycle}`);
      assert.throws(() => definition[lifecycle].call(page), error => error === stopAfterSync,
        `${route}: ${lifecycle} must synchronize before touching page data or starting requests`);
      assert.equal(received.at(-1), page, `${route}: ${lifecycle} passes the exact owning Page`);
    }
  }
});

test('records tab lifecycle wrappers preserve factory arguments, receivers and results', () => {
  const calls = [];
  const showResult = Promise.resolve('records loaded');
  const readyResult = { ready: true };
  let definition;
  const original = {
    onShow(...args) { calls.push({ lifecycle: 'show', receiver: this, args }); return showResult; },
    onReady(...args) { calls.push({ lifecycle: 'ready', receiver: this, args }); return readyResult; }
  };
  const filename = path.join(ROOT, `${RECORDS}.js`);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    getApp: () => ({ syncTabBar(page) { calls.push({ lifecycle: 'sync', receiver: page }); } }),
    require(name) {
      assert.equal(name, './practicePage.js');
      return screen => { assert.equal(screen, 'home'); return original; };
    }
  }, { filename });
  const page = { route: RECORDS }, argument = { from: 'test' };
  assert.equal(definition.onShow.call(page, argument, 2), showResult);
  assert.equal(definition.onReady.call(page, argument), readyResult);
  assert.deepEqual(calls.map(call => call.lifecycle), ['sync', 'show', 'sync', 'ready']);
  assert.ok(calls.every(call => call.receiver === page));
  assert.deepEqual(Array.from(calls[1].args), [argument, 2]);
  assert.deepEqual(Array.from(calls[3].args), [argument]);
});

test('settings immediately updates every cached bar before the first and later tab gestures in either direction', () => {
  const h = harness();
  h.warmTabs();
  let settings = h.openSettings();
  assert.deepEqual(h.stack.map(page => page.route), [ME, SETTINGS]);
  assert.equal(h.pages.size, 4, 'three cached tab pages are absent from the settings stack');

  for (const visible of [false, true]) {
    h.clearObservations();
    const requestsBeforeToggle = h.requests.length;
    h.toggle(settings, visible);
    assert.equal(settings.data.recordsVisible, visible);
    assert.equal(h.preferences.getRecordsVisible(), visible);
    assert.equal(h.requests.length, requestsBeforeToggle, 'a cached records page must not redirect the active settings page');
    for (const [route, { bar }] of h.pages) {
      assertLayout(bar, visible, route);
      assert.equal(bar.patches.filter(hasTabs).length, 1, `one layout update for ${route}`);
    }
    assertFirstRender(h.closeSettings(), visible);

    const available = ALL_ROUTES.filter(route => visible || route !== RECORDS);
    for (let visit = 0; visit < 2; visit++) {
      for (const route of available) {
        assertFirstRender(h.switchTo(route), visible);
        for (const [ownerRoute, { bar }] of h.pages) assertLayout(bar, visible, ownerRoute);
      }
    }
    for (const [route, { bar }] of h.pages) {
      assert.equal(bar.patches.filter(hasTabs).length, 1, `navigation must not replace the layout again for ${route}`);
    }
    if (!visible) {
      settings = h.openSettings();
    }
  }
  assert.deepEqual(h.toast, []);
});

test('repeated settings and foreground notifications preserve each owner highlight without resending tabs', () => {
  const h = harness();
  h.warmTabs();
  const settings = h.openSettings();
  h.toggle(settings, false);
  h.clearObservations();
  for (let notification = 0; notification < 3; notification++) {
    h.app.refreshTabBars();
    h.app.onShow();
    h.show(ME);
    h.toggle(settings, false);
  }
  for (const [route, { bar }] of h.pages) {
    assertLayout(bar, false, route);
    assert.deepEqual(bar.patches, [], `unchanged notifications must not render again for ${route}`);
  }

  h.clearObservations();
  h.app.refreshTabBars();
  for (const [route, { bar }] of h.pages) {
    assert.equal(bar.calls.refresh, 1, `the registered and stack-accessible ${route} bar must be deduplicated`);
  }
});

test('an instance created after a settings change sends the correct first nonempty layout', () => {
  const h = harness();
  h.enterTab(ME);
  for (const [visible, newRoute] of [[false, HOME], [true, TEAM]]) {
    const settings = h.openSettings();
    h.toggle(settings, visible);
    h.closeSettings();
    assertFirstRender(h.switchTo(newRoute), visible);
    const { bar } = h.pages.get(newRoute);
    assert.deepEqual(bar.initialData.tabs, [], 'unattached instances must not expose a default tab layout');
    const firstLayout = bar.patches.find(patch => patch.tabs && patch.tabs.length);
    assert.ok(firstLayout, 'attached sends a renderable layout');
    assert.deepEqual(firstLayout.tabs.map(tab => tab.pagePath),
      ALL_ROUTES.filter(route => visible || route !== RECORDS));
    assert.equal(bar.patches.filter(hasTabs).length, 1);
    assertLayout(bar, visible, newRoute);
    h.switchTo(ME);
  }
});

test('page lifecycle synchronization confirms the destination even while the source remains in the stack', () => {
  const h = harness();
  h.enterTab(TEAM);
  const team = h.pages.get(TEAM);
  h.enterTab(HOME);
  team.bar._page = null;
  team.bar._pageProvisional = false;
  team.bar.data.selectedPath = '';
  // Page.onShow and Page.onReady pass their own instance rather than consulting
  // a navigation stack that may still contain the previous tab.
  h.app.syncTabBar(team);
  assertLayout(team.bar, true, TEAM);
  assert.equal(h.stack.at(-1).route, HOME);
  assertLayout(h.pages.get(HOME).bar, true, HOME);
  h.app.refreshTabBars();
  assertLayout(team.bar, true, TEAM);

  h.app.syncTabBar(null);
  h.app.syncTabBar({ route: TEAM });
  h.app.syncTabBar({ route: TEAM, getTabBar: () => null });
  assert.deepEqual(h.requests, [], 'missing components are left for later lifecycle synchronization');
});

test('detaching a cached bar removes it from later preference and reminder broadcasts', () => {
  const h = harness();
  h.warmTabs();
  const team = h.pages.get(TEAM).bar;
  h.detach(TEAM);
  h.clearObservations();
  const settings = h.openSettings();
  h.toggle(settings, false);
  h.alerts({ user: true });
  h.app.refreshTabBars();
  h.show(TEAM); // An already queued lifecycle callback must also stay inert.
  assert.deepEqual(team.patches, []);
  assert.equal(team.calls.refresh, 1, 'only the explicitly queued show reaches the detached instance');
  assert.equal(team.calls.setMeAlert, 0);
  assertLayout(team, true, TEAM);
  assert.equal(team.data.hasMeAlert, false);
  for (const [route, { bar }] of h.pages) {
    if (route === TEAM) continue;
    assertLayout(bar, false, route);
    assert.equal(bar.data.hasMeAlert, true);
  }
});

test('all reminder sources update background bars once per broadcast without rewriting their layouts', () => {
  const h = harness();
  h.warmTabs();
  const settings = h.openSettings();
  h.toggle(settings, false);
  for (const source of ['admin', 'user', 'backfillUser', 'backfillAdmin']) {
    h.alerts({});
    h.clearObservations();
    h.alerts({ [source]: true });
    for (const [route, { bar }] of h.pages) {
      assert.equal(bar.data.hasMeAlert, true, `${source}: ${route}`);
      assert.equal(bar.calls.setMeAlert, 1, `one ${source} broadcast to ${route}`);
      assert.deepEqual(bar.patches, [{ hasMeAlert: true }]);
      assertLayout(bar, false, route);
    }
    h.clearObservations();
    h.app.applySyncAlertDot();
    h.app.refreshTabBars();
    for (const [route, { bar }] of h.pages) {
      assert.deepEqual(bar.patches, [], `the same ${source} state must not render ${route} again`);
      assert.equal(bar.calls.setMeAlert, 1);
    }
  }
  assert.equal(h.nativeDots.at(-1).visible, true);
  assert.equal(h.nativeDots.at(-1).index, 3, 'native reminder follows Me after removing the timer tab');
});
