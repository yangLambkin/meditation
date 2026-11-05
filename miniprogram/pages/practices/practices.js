const createPracticePage = require('./practicePage.js');
const page = createPracticePage('home');
const onShow = page.onShow;
const onReady = page.onReady;

function syncTabBar(page) {
  const app = typeof getApp === 'function' ? getApp() : null;
  if (app && typeof app.syncTabBar === 'function') app.syncTabBar(page);
}

page.onShow = function (...args) {
  syncTabBar(this);
  if (onShow) return onShow.apply(this, args);
};

page.onReady = function (...args) {
  syncTabBar(this);
  if (onReady) return onReady.apply(this, args);
};

Page(page);
