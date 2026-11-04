// Only an explicit user exit or navigation to another mini program ends a sit.
// Native screens, calls, and older runtimes without a reason preserve it.
function isExplicitTimerExit(options) {
  return !!options && (options.reason === 0 || options.reason === 1);
}

module.exports = { isExplicitTimerExit };
