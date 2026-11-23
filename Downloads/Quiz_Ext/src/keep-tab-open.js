// Newton opens playground questions in script-created tabs. Some page flows may call
// window.close() after an action, which would close that question tab. Run in MAIN world
// before the site scripts so the question stays open while the user works.
(() => {
  const preventClose = () => {};
  try {
    Object.defineProperty(window, 'close', {
      configurable: true,
      writable: false,
      value: preventClose,
    });
  } catch {
    try { window.close = preventClose; } catch { /* browser may expose a non-writable method */ }
  }
})();
