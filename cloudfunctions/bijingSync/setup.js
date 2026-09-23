const COLLECTIONS = ['bijing_sync_days', 'bijing_sync_runs', 'bijing_sync_items', 'bijing_sync_errors', 'admin_audit_logs', 'bijing_bindings'];

// Called only through adminInitialize after server-side administrator checks.
// Never insert sample records: these collections contain operational data.
async function initialize(db) {
  const collections = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      collections.push({ name, created: true });
    } catch (error) {
      const message = `${error.errCode || error.code || ''} ${error.errMsg || error.message || ''}`;
      if (!/COLLECTION_EXIST|already exist|已存在/i.test(message)) throw error;
      collections.push({ name, created: false });
    }
  }
  return { collections };
}
module.exports = { initialize, COLLECTIONS };
