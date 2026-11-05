const preferences = require('../utils/practicePreferences.js');

const HOME_PATH = 'pages/index/index';
const RECORDS_PATH = 'pages/practices/practices';
const TABS = [
  { pagePath: HOME_PATH, text: '首页', iconPath: '/images/icons/home.png', selectedIconPath: '/images/icons/home-active.png' },
  { pagePath: RECORDS_PATH, text: '记录', iconPath: '/images/icons/practice-records.png', selectedIconPath: '/images/icons/practice-records-active.png' },
  { pagePath: 'pages/team/team', text: '团队', iconPath: '/images/icons/team.png', selectedIconPath: '/images/icons/team-active.png' },
  { pagePath: 'pages/me/me', text: '我', iconPath: '/images/icons/me.png', selectedIconPath: '/images/icons/me-active.png' }
];

function recordsVisible() {
  try { return preferences.getRecordsVisible() === true; }
  catch (_) { return false; }
}

function currentPage() {
  if (typeof getCurrentPages !== 'function') return null;
  const pages = getCurrentPages();
  return pages && pages[pages.length - 1];
}

function currentRoute(page) {
  return page && typeof page.route === 'string' ? page.route.replace(/^\/+/, '') : '';
}

function appInstance() {
  return typeof getApp === 'function' ? getApp() : null;
}

Component({
  data: {
    // Each tab owns a separate instance. Its first rendered list must already
    // match the saved preference, including instances created after a toggle.
    tabs: [],
    selectedPath: '',
    recordsVisible: false,
    hasMeAlert: false
  },

  lifetimes: {
    attached() {
      this._detached = false;
      const app = appInstance();
      if (app && typeof app.registerTabBar === 'function') app.registerTabBar(this);
      this.refresh();
    },
    ready() {
      // Page APIs can become available after attached and the first page show.
      this.refresh();
    },
    detached() {
      this._detached = true;
      const app = appInstance();
      if (app && typeof app.unregisterTabBar === 'function') app.unregisterTabBar(this);
      this._page = null;
      this._pageProvisional = false;
    }
  },

  pageLifetimes: {
    show() {
      // A newly attached target can precede its page's navigation-stack update.
      if (this._pageProvisional) this._page = null;
      this.refresh();
    }
  },

  methods: {
    hostPage() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const owner = pages.find(page => TABS.some(item => item.pagePath === currentRoute(page)) &&
        typeof page.getTabBar === 'function' && page.getTabBar() === this);
      if (owner) {
        this._page = owner;
        this._pageProvisional = false;
      }
      // getTabBar may not be ready during attached. Keep a provisional host
      // until page show or the real component identity can confirm it.
      if (!this._page) {
        const page = currentPage();
        const bar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
        if ((!bar || bar === this) && TABS.some(item => item.pagePath === currentRoute(page))) {
          this._page = page;
          this._pageProvisional = true;
        }
      }
      return this._page;
    },

    refresh(host) {
      if (this._detached) return;
      // Page onShow/onReady knows its own component even before the navigation
      // stack catches up. Confirm that identity instead of guessing its route.
      if (TABS.some(item => item.pagePath === currentRoute(host)) &&
          typeof host.getTabBar === 'function' && host.getTabBar() === this) {
        this._page = host;
        this._pageProvisional = false;
      }
      const visible = recordsVisible();
      const changedTabs = !this.data.tabs.length || visible !== this.data.recordsVisible;
      const tabs = changedTabs ? TABS.filter(item => visible || item.pagePath !== RECORDS_PATH) : this.data.tabs;
      const page = this.hostPage();
      const route = currentRoute(page);
      const sharedRecords = route === RECORDS_PATH && page.options && page.options.from === 'share';
      const selectedPath = tabs.some(item => item.pagePath === route) ? route : '';
      const updates = {};
      if (changedTabs) Object.assign(updates, { tabs, recordsVisible: visible });
      if (selectedPath !== this.data.selectedPath) updates.selectedPath = selectedPath;

      const app = appInstance();
      const alerts = app && typeof app.getSyncAlertState === 'function'
        ? app.getSyncAlertState({ includeBackfill: true }) : null;
      const hasMeAlert = !!(alerts && (alerts.admin || alerts.user || alerts.backfillUser || alerts.backfillAdmin));
      if (hasMeAlert !== this.data.hasMeAlert) updates.hasMeAlert = hasMeAlert;
      if (Object.keys(updates).length) this.setData(updates);

      // A shared entry may open this page without changing the saved tab preference.
      // The page clears its share marker when hidden so cached visits still redirect.
      if (!visible && page === currentPage() && route === RECORDS_PATH && !sharedRecords) this.navigateToTab(HOME_PATH, true);
    },

    setMeAlert(visible) {
      const hasMeAlert = visible === true;
      if (hasMeAlert !== this.data.hasMeAlert) this.setData({ hasMeAlert });
    },

    onTabTap(event) {
      // Recheck the stored preference before trusting a tap on an older render.
      this.refresh();
      if (this._detached || this._switching || this._redirecting || this.hostPage() !== currentPage()) return;
      const pagePath = event && event.currentTarget && event.currentTarget.dataset.pagePath;
      if (!this.data.tabs.some(item => item.pagePath === pagePath) || pagePath === currentRoute(currentPage())) return;
      this.navigateToTab(pagePath);
    },

    navigateToTab(pagePath, redirect = false) {
      const lock = redirect ? '_redirecting' : '_switching';
      if (this[lock]) return;
      this[lock] = true;
      try {
        wx.switchTab({
          url: `/${pagePath}`,
          success: () => {
            this.refresh();
            // Destination attached/show may have run against the old stack.
            // Repair its selection now without rebinding this cached source.
            const page = currentPage();
            if (currentRoute(page) !== pagePath) return;
            const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null;
            if (bar && typeof bar.refresh === 'function') bar.refresh(page);
          },
          fail: () => {
            wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
            this.refresh();
          },
          complete: () => { this[lock] = false; }
        });
      } catch (_) {
        this[lock] = false;
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      }
    }
  }
});
