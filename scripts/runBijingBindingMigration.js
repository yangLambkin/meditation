#!/usr/bin/env node
// Uses an already logged-in WeChat DevTools automator session. Never supplies
// an OpenID or token: adminManager authorizes the real platform identity.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const environment = option('--env');
  const output = option('--output');
  if (!environment || !output) throw new Error('Usage: --env ENV_ID --output NEW_PRIVATE_DIRECTORY [--apply]');
  const directory = path.resolve(output);
  fs.mkdirSync(directory, { mode: 0o700 });
  const write = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  const automator = require(process.env.MINIPROGRAM_AUTOMATOR_MODULE || 'miniprogram-automator');
  const app = await automator.connect({ wsEndpoint: process.env.MINIPROGRAM_AUTOMATOR_ENDPOINT || 'ws://127.0.0.1:9420' });
  const summary = { environment, startedAt: new Date().toISOString(), apply: args.includes('--apply'), phases: {} };
  try {
    async function invoke(data) {
      return app.evaluate(async (env, event) => {
        const response = await wx.cloud.callFunction({ name: 'adminManager', config: { env }, data: event });
        return response.result;
      }, environment, data);
    }
    const access = await invoke({ type: 'getAccess' });
    if (!access || access.success !== true || !access.data || access.data.isAdmin !== true) throw new Error('Current WeChat session is not an administrator');
    async function phase(name, dryRun) {
      const pages = [], items = [];
      let cursor = '';
      const totals = { scanned: 0, migrated: 0, wouldMigrate: 0, alreadyManaged: 0, conflicts: 0 };
      while (true) {
        const response = await invoke({ type: 'adminMigrateBindings', dryRun, cursor, limit: 1 });
        if (!response || response.success !== true || !response.data) {
          write(`${name}-error.json`, { cursor, response });
          throw new Error(`${name} failed; preserved reports allow an idempotent restart`);
        }
        const data = response.data;
        assert.equal(data.dryRun, dryRun);
        assert.ok(Array.isArray(data.items));
        pages.push(data);
        items.push(...data.items);
        for (const key of Object.keys(totals)) totals[key] += data[key];
        // Persist each response before advancing. Preview contains full user and
        // reservation snapshots and completes before any migration writes.
        write(`${name}.json`, { environment, pages });
        console.log(JSON.stringify({ phase: name, pages: pages.length, ...totals }));
        if (!data.hasMore) break;
        assert.ok(data.nextCursor && data.nextCursor !== cursor, 'Migration cursor did not advance');
        cursor = data.nextCursor;
      }
      summary.phases[name] = totals;
      write('summary.json', summary);
      return items;
    }
    const before = await phase('preview', true);
    if (summary.apply) {
      await phase('apply', false);
      const after = await phase('verify', true);
      const afterById = new Map(after.map(item => [item.userId, item]));
      const differences = [];
      for (const item of before) {
        if (!item.before) continue;
        const current = afterById.get(item.userId);
        if (!current || current.status !== 'already_managed') {
          differences.push({ userId: item.userId, reason: 'NOT_MANAGED_AFTER_MIGRATION' });
          continue;
        }
        const withoutVersion = user => Object.fromEntries(Object.entries(user).filter(([key]) => key !== 'bijingBindingVersion'));
        try { assert.deepEqual(withoutVersion(current.before.user), withoutVersion(item.before.user)); }
        catch (error) { differences.push({ userId: item.userId, reason: 'PROFILE_FIELDS_CHANGED' }); }
        if (item.before.user.bijingBindingVersion && current.before.user.bijingBindingVersion !== item.before.user.bijingBindingVersion) {
          differences.push({ userId: item.userId, reason: 'EXISTING_VERSION_CHANGED' });
        }
      }
      summary.verification = { checkedProfiles: before.filter(item => item.before).length, differences };
      const finalAccess = await invoke({ type: 'getAccess' });
      summary.administratorStillAuthorized = Boolean(finalAccess && finalAccess.success && finalAccess.data && finalAccess.data.isAdmin);
      summary.completed = differences.length === 0 && summary.phases.verify.wouldMigrate === 0 &&
        summary.phases.verify.conflicts === 0 && summary.administratorStillAuthorized;
    }
    summary.finishedAt = new Date().toISOString();
    write('summary.json', summary);
    console.log(JSON.stringify({ ...summary, output: directory }));
    if (summary.apply && !summary.completed) process.exitCode = 2;
  } finally { await app.disconnect(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
