// WeChat identifies deliberate closing / navigation to another mini program.
// Calls, alarms, native screens and older clients without a reason must not
// manufacture the end of a sitting. Their elapsed wall time still counts.
function isExplicitTimerExit(options) {
  return !!options && (options.reason === 0 || options.reason === 1);
}

module.exports = { isExplicitTimerExit };
