# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

WeChat Mini Program for meditation check-in ("静坐觉察" / "Meditation Awareness"), built on WeChat Cloud Development (云开发). The app provides meditation timing, daily check-ins, experience notes, rankings, badges, and team (空间) features with invite flow.

- AppID: `wx256002217162c2b4`
- Cloud env: `cloud1-2g2rbxbu2c126d4a` (hard-coded in `miniprogram/app.js`, `miniprogram/config/images.js`, and via `cloud.DYNAMIC_CURRENT_ENV` inside cloud functions)
- Base library: `3.13.2` (declared in `project.private.config.json`); `2.20.1` in `project.config.json`
- Module system: CommonJS (`"type": "commonjs"`)

## Common Commands

### Install dependencies
```bash
npm install
```
NOTE: `node_modules/` at the repo root is empty. The runtime dependency `wx-server-sdk` is installed per cloud function (each cloud function has its own `package.json`). The miniprogram has its own `miniprogram/package.json` depending on `lunar`.

### Test data cleanup (uses WeChat DevTools CLI `cli cloud function invoke`)
```bash
npm run cleanup:stats   # show data counts per collection
npm run cleanup:safe    # delete records within test date range (default 2026-01-01 → today)
npm run cleanup:full    # delete ALL records (irreversible; prompts for "yes")
```
These scripts invoke the `cleanupTestData` cloud function via the WeChat DevTools `cli`. They require WeChat DevTools to be installed, logged in, and the cloud function to be uploaded. Edit `CONFIG.testPeriod` in `scripts/runCleanup.js` to change the safe-cleanup date range.

### Tests
There is no automated test harness. `npm test` is a placeholder that exits with an error. `test_redirect_flow.js` (repo root) and `miniprogram/pages/test/*` are manual/ad-hoc test pages, not a suite.

### Deploying cloud functions
Upload via WeChat DevTools (right-click → "上传并部署：云端安装依赖" on each folder under `cloudfunctions/`). `uploadCloudFunction.sh` is a one-line template that calls the DevTools CLI for `quickstartFunctions` only — it is not a general deploy script.

## Repository Layout

```
miniprogram/                  Mini program source (miniprogramRoot)
  app.js                      Cloud init, cache status, audio options, version checks
  app.json                    Pages + subpackages + tabBar (4 tabs: 首页/计时/团队/我)
  pages/                      Main package pages (see "Pages" below)
  subpackages/team/pages/     Team subpackage (createTeam, teamDetails, joinTeam, testJoinTeam)
  utils/                      Front-end business modules (see "Front-end utils" below)
  config/images.js            Cloud fileID config for daily-poker images
  workers/timer-worker.js     Timer worker (precise background timing)
  audio/风铃声.mp3             Bell sound effect
  images/                     Static icons and placeholder images

cloudfunctions/               Cloud function source (cloudfunctionRoot)
  meditationManager/          Main backend: login, records, stats, rankings, badges, profiles
  teamManager/                Team CRUD, invite, join, member check-in data
  autoCreateCollections/      One-shot bootstrap: creates DB collections with sample schema
  cleanupTestData/            Test data cleanup (stats / safe / full modes)
  getRandomWisdom/            Returns a random row from `wisdom_quotes`
  recordUploadedImages/       Records uploaded cloud-storage images into `images` collection
  quickstartFunctions/        Default boilerplate from the cloud-quickstart template
  */config.json               `meditationManager/config.json` defines a timer trigger `0 0 */6 * * * *` that calls `generateRankingSnapshot`

scripts/                      Node.js helper scripts (run via npm)
  runCleanup.js               CLI wrapper that calls `cli cloud function invoke`
  cleanupTestData.js          Alternate cleanup helper
  create_team_collections.js  Schema definitions for team/invite collections
  README.md                   Detailed cleanup tool docs

create_collections_consistent.js   Schema definitions mirroring API fields (reference doc)
file_index.json               Inventory of background image filenames
project.config.json           WeChat project config (appid, lib version, packNpm settings)
project.private.config.json   Private overrides; enables skylineRenderEnable, lazyCodeLoading
test_redirect_flow.js         Manual test script for profile page redirect flow
```

## Architecture

### Two-tier: Mini program (front) + Cloud functions (back)
- Front end calls back end exclusively through `wx.cloud.callFunction`. The wrapper `miniprogram/utils/cloudApi.js` centralizes every call to the `meditationManager` cloud function and normalizes the `{success, data, error}` envelope.
- `meditationManager/index.js` is a single-dispatch cloud function: `event.type` selects a handler (`recordMeditation`, `getUserStats`, `getRankings`, `updateUserBadges`, etc.). Adding a new backend operation = add a `case` + handler function in this file.
- `teamManager/index.js` follows the same dispatch pattern for team operations (`createTeam`, `joinTeamWithInvite`, `generateInvite`, `getMemberWeekCheckin`, ...).
- Cloud functions read the env from `cloud.DYNAMIC_CURRENT_ENV`, so the same code works across environments without hard-coding.

### Local-first user identity
The app uses a "local-first" identity model — see `miniprogram/utils/checkin.js` and `pages/index/index.js`:
1. On first launch a `local_<timestamp>_<random>` id is generated and stored in `localUserId` and `userOpenId` storage keys.
2. After WeChat login, the real `openid` (prefixed `oz...`) replaces `userOpenId`. The mapping between `openid` and the old `localUserId` is persisted in the `user_mappings` collection by `meditationManager.createUserMapping` / `migrateLocalData`.
3. All per-user local cache is keyed by `meditation_checkin_<userId>` (where `userId` is the local id), so data survives login migration.

When adding features that need user identity, call `checkinManager.getUserId()` (returns local id) and read `wx.getStorageSync('userOpenId')` (returns openid after login). Do NOT assume the user is logged in.

### Cache recovery flow
`app.js#onLaunch` calls `setupCacheStatus()` which sets `cacheStatus='initialized'` and `needsRecovery=true` on first launch or version change. `checkinManager.strictCacheCheck()` then reads these flags plus `checkCriticalDataExists()` / `hasActualUserData()` to decide whether to rebuild local state from the cloud. `appVersion` is currently hard-coded to `1.0.0` — bump it when a data-migration-on-upgrade is needed.

### Data model
Collections (defined in `cloudfunctions/autoCreateCollections/index.js` and `create_collections_consistent.js`):
- `users` — profile (nickName, avatarUrl, isCustomAvatar, dataSource: 'wechat'|'custom', migrationStatus)
- `meditation_records` — one row per check-in (`_openid`, `date` YYYY-MM-DD, `timestamp` ms, `duration` min, `rating`, `experience` array of exp record ids)
- `experience_records` — standalone notes (`text`, `timestamp` ms, `created_at`, `updated_at`). Detached from `meditation_records` since 2026; the link is by id array only.
- `user_stats` — aggregate counters (totalDays, totalCount, totalDuration, dailyTotalDuration, monthlyTotalDuration, longestCheckInDays, currentStreak, longestStreak, lastCheckinDate, lastCheckinDuration, lastCheckin, monthlyStats{YYYY-MM:{days,count,totalDuration}}, badges)
- `rankings` — legacy daily/monthly/total ranking rows (still written by `updateRankings` but `getRankings` now reads live from `user_stats` ordered by `dailyTotalDuration` desc, limit 100)
- `ranking_snapshots` — generated by `generateRankingSnapshot` (timer trigger every 6 hours)
- `user_mappings` — `openid` ↔ `local_user_id`
- `teams`, `team_members`, `invites`, `invite_actions` — team/invite domain (see `scripts/create_team_collections.js` for canonical schema; `teamManager/index.js` is the source of truth for runtime field names)
- `wisdom_quotes` — daily wisdom content read by `getRandomWisdom`
- `images` — catalog of uploaded cloud-storage images (written by `recordUploadedImages`)

Field names use a mix of `camelCase` (front-end / `user_stats` / `meditation_records`) and `snake_case` (`experience_records`, `user_mappings`, `team_members`). Match the existing style of the collection you are editing — do not normalize.

### Rankings
Real-time ranking is computed on read in `getRankings`: query `user_stats` ordered by `dailyTotalDuration` desc, limit 100. The `rankings` collection is still written on every check-in for backward compatibility but is not read. Ranking snapshots (top 1000 by `dailyTotalDuration`) are materialized into `ranking_snapshots` every 6 hours by the timer trigger in `cloudfunctions/meditationManager/config.json`.

### Timer
`pages/timer/timer.js` is the meditation timer page. It uses `wx.createBackgroundTimer` for foreground timing and a worker (`miniprogram/workers/timer-worker.js`) for precise second-by-second updates. On `wx.onAppShow` it calls `syncTimerTime()` to correct drift using wall-clock timestamps (`startTimestamp`, `pauseTimestamp`, `totalPausedTime`). The page also controls screen brightness (`saveCurrentBrightness` / `setKeepScreenOn`) and plays a guided audio file from cloud storage (`defaultMusicFileID`).

### Background images
`config/images.js` lists the daily-poker image set (`m1.png`–`m13.png`, `t1.png`–`t4.png`, ...) under `cloud://.../bg_image/`, with a 12-hour local cache and a 6-hour image-list cache. `file_index.json` at the repo root tracks which numbered backgrounds have been uploaded.

### Badges
`utils/badgeManager.js` defines badge configs (continuous-7/14/30/60/100/365, total-50/500/5000-minutes, etc.) with cloud-storage image URLs. Unlocks are evaluated locally and synced via `meditationManager.updateUserBadges` / `getUserBadges`, which store the `badges` object inside `user_stats`.

### Team subpackage
`subpackages/team/` is a WeChat subpackage declared in `app.json` (root `subpackages/team`, name `team`). It contains `createTeam`, `teamDetails`, `joinTeam`, `testJoinTeam`. The invite flow passes `teamId`, `teamName`, `teamIcon`, `inviterName`, `inviteId` via query string; unauthenticated users are redirected to `pages/profile/profile` with `fromPage` / `fromParams` so the profile page can return them to the original flow after login (see `test_redirect_flow.js` for the manual test of this redirect).

## Conventions

- 2-space indent, no semicolons in mini program code; semicolons in cloud function code. Match the file you are editing.
- All `wx.cloud.callFunction` calls go through `miniprogram/utils/cloudApi.js`. Add a new method there rather than calling `wx.cloud.callFunction` directly from a page.
- Cloud function handlers return `{ success: boolean, data?: ..., error?: string }`. Keep this shape.
- Logging uses emoji prefixes (🔍 🚀 ✅ ⚠️ ❌ 📊) throughout the codebase — follow this style when adding logs.
- User-facing strings are Simplified Chinese. Default nickname is `觉察者` for unauthenticated users and `静心者` when creating a new profile.
- Cloud storage fileIDs are long (`cloud://cloud1-2g2rbxbu2c126d4a.636c-cloud1-2g2rbxbu2c126d4a-1394807223/...`). Reuse `CLOUD_PREFIX` from `miniprogram/config/images.js` instead of inlining them.
- The `meditation_records.experience` field is an **array** of experience record ids (not a string). `updateMeditationRecord` handles back-compat for legacy single-string values; new code should always write arrays.
- `dailyTotalDuration` resets on new day; `monthlyTotalDuration` accumulates across the month. Both live in `user_stats` and are incremented with `db.command.inc(duration)`.

## Pitfalls

- `project.private.config.json` overrides `project.config.json` (e.g. `libVersion` is `3.13.2` vs `2.20.1`). The private file wins inside WeChat DevTools.
- `autoCreateCollections` only needs to run once per environment. It is **not** called from `app.js` by default — the call is commented out. Trigger it manually if collections are missing.
- `packNpmManually: true` with `packNpmRelationList` pointing at `./package.json` → `./miniprogram`. npm packages used by the mini program must be installed at the repo root and will be built into `miniprogram/`.
