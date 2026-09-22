function getAvatarInitial(nickname) {
  const name = typeof nickname === 'string' ? nickname.trim() : '';
  const first = Array.from(name)[0] || '友';
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

function getAvatarSource(source) {
  if (typeof source !== 'string') return '';
  const path = source.trim();
  // Older profiles persist these shared placeholder images as their avatar.
  return /^\/?images\/(avatar(?:-[1-4])?|userLogin)\.png$/i.test(path) ? '' : path;
}

module.exports = { getAvatarInitial, getAvatarSource };
