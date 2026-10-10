// Keep deployment-local copies identical: cloud functions deploy separately.
const COVERAGE_ID = '__source_check_coverage__';
const COVERAGE_FROM_DATE = '2026-09-22';
const DAY_MS = 86400000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const nextDate = date => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const previousDate = date => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

// The last check starts at 10:00 Beijing time; allow it one hour to finish.
function overdueThrough(timestamp) {
  const local = new Date(timestamp + 8 * 3600000);
  const date = local.toISOString().slice(0, 10);
  return local.getUTCHours() >= 11 ? previousDate(date) : previousDate(previousDate(date));
}

async function readCoverage(db) {
  try {
    const response = await db.collection('bijing_sync_days').doc(COVERAGE_ID).get();
    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data') ||
        response.data != null && (typeof response.data !== 'object' || Array.isArray(response.data))) {
      throw new Error('同步核对进度返回异常');
    }
    return response.data || null;
  } catch (error) {
    const code = String(error && (error.code || error.errCode) || '');
    const message = String(error && (error.message || error.errMsg) || '');
    if (code === '-502005' || /^(?:DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND|DATABASE_DOCUMENT_NOT_EXIST|DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS)$/.test(code) ||
        /(?:document|collection).*?(?:not exist|not found)|文档不存在|集合不存在/i.test(message)) return null;
    throw error;
  }
}

async function getCoverageStatus({ db, now = Date.now }) {
  const timestamp = now();
  const state = await readCoverage(db);
  const fromDate = COVERAGE_FROM_DATE;
  const pendingDate = state && state.nextDate || fromDate;
  const today = new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
  if (!validDate(pendingDate) || pendingDate < fromDate || pendingDate > today ||
      state && state.fromDate !== fromDate) throw new Error('同步核对进度异常，请检查后重试');
  const through = overdueThrough(timestamp);
  return {
    fromDate, nextDate: pendingDate, scannedThrough: previousDate(pendingDate),
    overdueThrough: through, hasOverdue: pendingDate <= through,
    dueAt: Date.parse(`${nextDate(pendingDate)}T11:00:00+08:00`), initialized: !!state,
  };
}

module.exports = { COVERAGE_ID, COVERAGE_FROM_DATE, DAY_MS, validDate, nextDate, previousDate, overdueThrough, getCoverageStatus };
