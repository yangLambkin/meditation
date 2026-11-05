const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOME_PATH = path.join(__dirname, '../miniprogram/pages/index/index.js');
const TIMER_ROUTE = '/pages/timer/timer';

function createHome() {
  let definition;
  const calls = { navigation: [], toast: [], identity: 0 };
  const identity = new Promise(() => {});
  vm.runInNewContext(fs.readFileSync(HOME_PATH, 'utf8'), {
    Page(value) { definition = value; },
    require() { return { DEFAULT_QUOTE: '', methods: {}, data: {} }; },
    wx: {
      navigateTo(options) { calls.navigation.push(options); },
      switchTab() { assert.fail('timer is a regular page and cannot be opened with switchTab'); },
      showToast(options) { calls.toast.push(JSON.parse(JSON.stringify(options))); }
    }
  }, { filename: HOME_PATH });
  const page = {
    ...definition,
    getUserOpenId() { calls.identity++; return identity; }
  };
  return { page, calls };
}

test('home opens the timer as a regular page while identity refresh is still pending', () => {
  const h = createHome();
  h.page.startMeditation();
  assert.equal(h.calls.identity, 1);
  assert.equal(h.calls.navigation.length, 1);
  assert.equal(h.calls.navigation[0].url, TIMER_ROUTE);
  h.calls.navigation[0].complete();
  assert.deepEqual(h.calls.toast, []);

  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes(TIMER_ROUTE.slice(1)));
  assert.ok(!app.tabBar.list.some(tab => tab.pagePath === TIMER_ROUTE.slice(1)));
});

test('repeated start taps produce one timer page until navigation completes', () => {
  const h = createHome();
  h.page.startMeditation();
  h.page.startMeditation();
  h.page.startMeditation();
  assert.equal(h.calls.navigation.length, 1);
  assert.equal(h.calls.identity, 1);
  h.calls.navigation[0].complete();
  h.page.startMeditation();
  assert.equal(h.calls.navigation.length, 2, 'returning home can open the timer again');
});

test('failed timer navigation explains the failure and allows a retry', () => {
  const h = createHome();
  h.page.startMeditation();
  h.calls.navigation[0].fail({ errMsg: 'navigateTo:fail' });
  h.calls.navigation[0].complete();
  assert.deepEqual(h.calls.toast, [{ title: '计时页打开失败，请重试', icon: 'none' }]);
  h.page.startMeditation();
  assert.equal(h.calls.navigation.length, 2);
  assert.equal(h.calls.navigation[1].url, TIMER_ROUTE);
});
