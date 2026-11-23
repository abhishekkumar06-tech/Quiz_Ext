// Shared batch-run queue for the semester scanner (loaded before content.js / assignment.js / scanner.js).
// Items are processed one at a time in the same tab; state lives in localStorage so it survives navigation.
(() => {
  if (window.__nqsRun) return;
  const KEY = 'nqs-sem-run';

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = (run) => localStorage.setItem(KEY, JSON.stringify(run));

  // Assignment / assessment id = first path segment after "assignment" or "assessment".
  const idOf = (url) => (new URL(url, location.origin).pathname.match(/\/(assignment|assessment)\/([^/]+)/) || [])[2] || null;

  window.__nqsRun = {
    load,
    save,
    idOf,
    clear: () => localStorage.removeItem(KEY),
    current() {
      const run = load();
      return run && !run.stopped && localStorage.getItem('nqs-stop') !== '1' && run.idx < run.items.length ? run.items[run.idx] : null;
    },
    // Is the current batch item the page we're on?
    matchesHere(kind) {
      const item = this.current();
      return !!item && item.kind === kind && item.id === idOf(location.href);
    },
    // Record the outcome of the current item and navigate to the next one (or back to the scan page).
    advance(result) {
      const run = load();
      if (!run || run.stopped || localStorage.getItem('nqs-stop') === '1') return;
      const item = run.items[run.idx];
      if (item) item.result = result;
      run.idx += 1;
      save(run);
      const next = run.items[run.idx];
      setTimeout(() => { location.href = next ? next.url : run.returnUrl; }, 2500);
    },
    stop() {
      const run = load();
      if (run) { run.stopped = true; save(run); }
    },
  };
})();
