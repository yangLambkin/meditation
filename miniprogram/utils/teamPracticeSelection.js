const { PRACTICES } = require('./practicePreferences.js');

const maxGoal = type => type === 'instant' ? 1000000 : type === 'kindness' ? 100000 : 1440;

// Form drafts retain their raw values even when rules are disabled or a choice is deselected.
function practiceDraft(value) {
  const config = PRACTICES.find(item => item.type === value.practiceType);
  if (!config) throw new Error('请选择有效的功课类型');
  const start = value.practiceStartDate || '';
  const goal = value.dailyGoalMinutes == null ? '' : String(value.dailyGoalMinutes);
  return { ...config, practiceType: config.type, practiceStartDate: start, dailyGoalMinutes: goal,
    rulesEnabled: typeof value.rulesEnabled === 'boolean' ? value.rulesEnabled : Boolean(start || goal !== ''),
    maxGoal: maxGoal(config.type), presets: ['instant', 'kindness'].includes(config.type) ? [1, 3, 10] : [20, 30, 60] };
}

function selectionOptions(drafts, lockedTypes = []) {
  return PRACTICES.map(item => ({ ...item, selected: drafts.some(draft => draft.practiceType === item.type), locked: lockedTypes.includes(item.type) }));
}

function practiceCards(drafts, defaultStart = '创建日起') {
  return drafts.map(value => {
    const draft = practiceDraft(value);
    const goal = draft.rulesEnabled ? draft.dailyGoalMinutes : '';
    const validGoal = /^\d+$/.test(goal) && Number.isSafeInteger(Number(goal)) && Number(goal) >= 1 && Number(goal) <= draft.maxGoal;
    const goalLabel = goal === '' ? '不设每日目标' : validGoal ? `每日 ${goal} ${draft.unit}` : '目标待完善';
    const startLabel = draft.rulesEnabled && draft.practiceStartDate ? `${draft.practiceStartDate} 起` : defaultStart;
    return { ...draft, summary: `${goalLabel} · ${startLabel}` };
  });
}

function stablePracticeOrder(drafts, ranks, keepFirst = true) {
  for (const draft of drafts) {
    if (!Object.prototype.hasOwnProperty.call(ranks, draft.practiceType)) ranks[draft.practiceType] = Object.keys(ranks).length;
  }
  const sorted = (keepFirst ? drafts.slice(1) : drafts.slice()).sort((a, b) => ranks[a.practiceType] - ranks[b.practiceType]);
  return keepFirst ? [drafts[0], ...sorted] : sorted;
}

module.exports = { practiceDraft, selectionOptions, practiceCards, stablePracticeOrder };
