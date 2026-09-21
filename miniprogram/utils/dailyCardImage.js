const { getRandomDailyPokerImage, DEFAULT_IMAGE } = require('../config/images.js');

const PRELOAD_TIMEOUT = 5000;
let nextImage = null;

function createImageEntry() {
  const entry = { path: null, promise: null };
  let resolveImage;
  let settled = false;
  const deadline = Date.now() + PRELOAD_TIMEOUT;
  entry.promise = new Promise(resolve => { resolveImage = resolve; });
  const timer = setTimeout(() => finish(DEFAULT_IMAGE), PRELOAD_TIMEOUT);

  function finish(path) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    entry.path = path;
    resolveImage(path);
  }

  function expired() {
    if (!settled && Date.now() >= deadline) finish(DEFAULT_IMAGE);
    return settled;
  }

  // Some SDK versions return a Promise even when callbacks are supplied.
  // Accept either interface, handling every stage only once.
  function request(invoke, onSuccess) {
    if (expired()) return;
    let received = false;
    const fail = () => {
      if (received) return;
      received = true;
      finish(DEFAULT_IMAGE);
    };
    const success = result => {
      if (received || expired()) return;
      received = true;
      try {
        onSuccess(result);
      } catch (_) {
        finish(DEFAULT_IMAGE);
      }
    };
    try {
      const pending = invoke({ success, fail });
      if (pending && typeof pending.then === 'function') {
        pending.then(success, fail).catch(fail);
      }
    } catch (_) {
      fail();
    }
  }

  // Always return the entry before starting SDK work, even with synchronous mocks.
  Promise.resolve().then(() => {
    if (expired()) return;
    const selected = getRandomDailyPokerImage();
    if (!selected || selected.isDefault || !selected.fileID) {
      finish(DEFAULT_IMAGE);
      return;
    }
    request(callbacks => wx.cloud.getTempFileURL({
      fileList: [selected.fileID],
      ...callbacks
    }), result => {
      const file = result && result.fileList && result.fileList[0];
      if (!file || (file.status !== undefined && file.status !== 0) ||
          typeof file.tempFileURL !== 'string' || !file.tempFileURL) {
        finish(DEFAULT_IMAGE);
        return;
      }
      request(callbacks => wx.getImageInfo({ src: file.tempFileURL, ...callbacks }), image => {
        finish(image && typeof image.path === 'string' && image.path ? image.path : DEFAULT_IMAGE);
      });
    });
  }).catch(() => finish(DEFAULT_IMAGE));

  return entry;
}

function prepareNextImage() {
  if (!nextImage) nextImage = createImageEntry();
  return nextImage;
}

function takeNextImage() {
  const entry = prepareNextImage();
  nextImage = null;
  return entry;
}

module.exports = { DEFAULT_IMAGE, prepareNextImage, takeNextImage };
