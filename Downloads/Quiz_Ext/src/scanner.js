// Semester scanner (content script on a semester's /course/<hash>/details page).
// Walks every subject in the subject dropdown, reads its Assignments and Quiz tabs, lists the pending
// items, and runs the selected ones one after another (assignment solver / quiz solver).
// Only assignment and quiz content is read; contests are never scanned.

(() => {
  if (window.__nqsScanLoaded) return;
  window.__nqsScanLoaded = true;

  const RUN = window.__nqsRun;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const visible = (el) => el && el.getBoundingClientRect().width > 0;
  const SCAN_KEY = 'nqs-sem-scan';
  const semHash = () => (location.pathname.match(/\/course\/([^/]+)\//) || [])[1];
  const isDetails = () => /\/course\/[^/]+\/(details|all_assignments|all_assessments)\/?$/.test(location.pathname);
  const loadScan = () => { try { return JSON.parse(sessionStorage.getItem(SCAN_KEY)); } catch { return null; } };
  const saveScan = (st) => sessionStorage.setItem(SCAN_KEY, JSON.stringify(st));
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const SKIP_RE = /\bbash\b|shell script|think[\s-]*a?loud|think[\s-]*out[\s-]*loud|\bcontest\b/i;
  // AWS / cloud-console labs can't be solved in the browser editor: leave them out of the scan entirely.
  const AWS_RE = /\baws\b|amazon web services|\bec2\b|cloudformation/i;
  const PREFS_KEY = 'nqs-scan-types';
  const loadTypes = () => { try { return { quiz: true, assignment: true, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { quiz: true, assignment: true }; } };

  async function rpc(op, data = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'asg', op, ...data });
    if (!r?.ok) throw new Error(r?.error || 'Extension error');
    return r.result;
  }

  // ---------- Page helpers ----------

  // ---------- UI ----------

  let host, root;
  let found = [];

  function ensureUI() {
    if (!isDetails()) { if (host) host.style.display = 'none'; return; }
    if (host) { host.style.display = ''; return; }
    host = document.createElement('div');
    host.id = 'nqs-scan-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 20px; bottom: 24px; z-index: 2147483647; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
        .panel { width: 420px; max-height: 60vh; overflow: auto; background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
        .panel[hidden] { display: none; }
        .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600; position: sticky; top: 0; background: #fff; }
        .head button { border: 0; background: none; cursor: pointer; font-size: 16px; color: #666; }
        .status { padding: 8px 12px; border-bottom: 1px solid #f2f2f2; }
        .list { padding: 4px 12px 10px; }
        .subj { font-weight: 600; margin: 10px 0 4px; }
        label.item { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; border-bottom: 1px dashed #f0f0f0; }
        .tag { font-size: 11px; padding: 0 6px; border-radius: 999px; background: #eef; color: #335; white-space: nowrap; }
        .tag.quiz { background: #fff1cc; color: #8a5a00; }
        .tag.skip { background: #eee; color: #777; }
        .muted { color: #777; font-size: 12px; }
        .ok { color: #146c2e; } .bad { color: #a1261f; }
        .row { display: flex; gap: 8px; }
        button.main { background: #111; color: #fff; border: 0; border-radius: 999px; padding: 11px 18px; font-weight: 600; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
        button.main:disabled { opacity: .5; cursor: default; }
        button.sec { background: #fff; border: 1px solid #ccc; border-radius: 999px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
        .types { display: flex; gap: 8px; background: #fff; border: 1px solid #ddd; border-radius: 999px; padding: 6px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
        .toggle { display: flex; gap: 6px; align-items: center; font-weight: 600; cursor: pointer; }
        .toggle input { appearance: none; width: 30px; height: 17px; border-radius: 999px; background: #ccc; position: relative; cursor: pointer; margin: 0; }
        .toggle input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: left .15s; }
        .toggle input:checked { background: #146c2e; }
        .toggle input:checked::after { left: 15px; }
        label.subj { display: flex; gap: 8px; align-items: center; font-weight: 600; margin: 12px 0 4px; }
      </style>
      <div class="wrap">
        <div class="panel" hidden>
          <div class="head"><span>Semester Scanner</span><button class="close">×</button></div>
          <div class="status"></div>
          <div class="list"></div>
        </div>
        <div class="types">
          <label class="toggle"><input type="checkbox" class="t-assignment"> Assignments</label>
          <label class="toggle"><input type="checkbox" class="t-quiz"> Quizzes</label>
        </div>
        <div class="row">
          <button class="sec solve" hidden>▶ Solve selected</button>
          <button class="main scan">🔎 Scan semester</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    root.querySelector('.close').onclick = () => { root.querySelector('.panel').hidden = true; };
    root.querySelector('.scan').onclick = scan;
    const types = loadTypes();
    for (const k of ['assignment', 'quiz']) {
      const box = root.querySelector(`.t-${k}`);
      box.checked = types[k];
      box.onchange = () => {
        const t = loadTypes(); t[k] = box.checked;
        localStorage.setItem(PREFS_KEY, JSON.stringify(t));
        renderList(); // hide/show already-scanned items of that type
      };
    }
    root.querySelector('.solve').onclick = solveSelected;
    showLastRun();
  }

  const $ = (s) => root.querySelector(s);
  const setStatus = (html) => { $('.panel').hidden = false; $('.status').innerHTML = html; };

  function renderList() {
    const types = loadTypes();
    const bySubject = {};
    found.forEach((it, i) => { if (types[it.kind]) (bySubject[it.subject || 'Other'] ||= []).push([it, i]); });
    $('.list').innerHTML = Object.entries(bySubject).map(([subj, rows], si) => `
      <label class="subj"><input type="checkbox" data-subj="${si}" ${rows.some(([it]) => !it.skip) ? 'checked' : 'disabled'}> ${esc(subj)}
        <span class="muted">(${rows.filter(([it]) => !it.skip).length})</span></label>
      ${rows.map(([it, i]) => `
        <label class="item">
          <input type="checkbox" data-i="${i}" data-s="${si}" ${it.skip ? 'disabled' : 'checked'}>
          <span><span class="tag ${it.skip ? 'skip' : it.kind}">${it.skip ? 'skipped' : it.kind}</span>
          ${esc(it.title)}${it.kind === 'assignment' ? ` <span class="muted">(${it.pending} unsolved)</span>` : ''}</span>
        </label>`).join('')}`).join('') || '<div class="muted">Nothing pending.</div>';
    // Subject checkbox toggles all of that subject's items; item changes update the subject box.
    root.querySelectorAll('input[data-subj]').forEach((sb) => {
      sb.onchange = () => root.querySelectorAll(`input[data-s="${sb.dataset.subj}"]:not(:disabled)`).forEach((c) => { c.checked = sb.checked; });
    });
    root.querySelectorAll('input[data-s]').forEach((c) => {
      c.onchange = () => {
        const items = [...root.querySelectorAll(`input[data-s="${c.dataset.s}"]:not(:disabled)`)];
        const sb = root.querySelector(`input[data-subj="${c.dataset.s}"]`);
        sb.checked = items.some((x) => x.checked);
        sb.indeterminate = sb.checked && !items.every((x) => x.checked);
      };
    });
    $('.solve').hidden = !Object.values(bySubject).flat().some(([it]) => !it.skip);
  }

  // ---------- Scan ----------
  // Uses the semester-wide lists (all subjects at once):
  //   /course/<sem>/all_assignments?tab=course&attempt_statuses=1,2  (Not Attempted + Attempted)
  //   /course/<sem>/all_assessments?tab=course                        (status read per row)
  // Each is a full page load, so progress is kept in sessionStorage.

  function scan() {
    if (!alive()) { location.reload(); return; }
    const sem = semHash();
    if (!sem) { setStatus('<span class="bad">Open a semester page first.</span>'); return; }
    const types = loadTypes();
    if (!types.assignment && !types.quiz) { setStatus('<span class="bad">Turn on Assignments and/or Quizzes first.</span>'); return; }
    localStorage.removeItem('nqs-stop');
    const first = types.assignment ? 'assignments' : 'quizzes';
    saveScan({ phase: first, sem, found: [], types, returnUrl: `${location.origin}/course/${sem}/details?tab=course` });
    location.href = first === 'assignments'
      ? `${location.origin}/course/${sem}/all_assignments?tab=course&attempt_statuses=1,2`
      : `${location.origin}/course/${sem}/all_assessments?tab=course`;
  }

  async function continueScan() {
    const st = loadScan();
    if (!st) return;
    const onAsg = /\/all_assignments\/?$/.test(location.pathname);
    const onQuiz = /\/all_assessments\/?$/.test(location.pathname);
    found = st.found;
    if (st.phase === 'done') {
      sessionStorage.removeItem(SCAN_KEY);
      renderList();
      const a = found.filter((f) => f.kind === 'assignment' && !f.skip).length;
      const q = found.filter((f) => f.kind === 'quiz').length;
      setStatus(`<b>Scan complete.</b> ${a} assignment(s) with unsolved questions, ${q} pending quiz(zes). ` + ' Tick or untick whole subjects or single items.' +
        'Untick anything you want to leave, then press <b>Solve selected</b>.' +
        '<br><span class="muted">Bash, think-aloud and contest questions are skipped; AWS labs are left out. Quizzes are submitted after every question is answered.</span>');
      return;
    }
    const want = st.phase === 'assignments' ? onAsg : onQuiz;
    if (!want) return;
    $('.scan').disabled = true;
    setStatus(`Scanning all ${st.phase === 'assignments' ? 'assignments' : 'quizzes'}…`);
    await sleep(5000); // let the list render
    try {
      const items = await rpc('scan.collect', { kind: st.phase === 'assignments' ? 'Assignments' : 'Quiz' });
      for (const it of items) {
        if (AWS_RE.test(`${it.subject} ${it.title} ${(it.pendingTitles || []).join(' ')}`) &&
          (it.kind !== 'assignment' || (it.pendingTitles || []).every((t) => AWS_RE.test(`${it.subject} ${it.title} ${t}`)))) continue;
        it.id = RUN.idOf(it.url);
        it.skip = it.kind === 'assignment' && (SKIP_RE.test(it.title) || (it.pendingTitles?.length && it.pendingTitles.every((t) => SKIP_RE.test(t))));
        if (!st.found.some((f) => f.id === it.id)) st.found.push(it);
      }
    } catch (e) {
      setStatus(`<span class="bad">${esc(e.message)}</span>`);
      sessionStorage.removeItem(SCAN_KEY);
      $('.scan').disabled = false;
      return;
    }
    if (st.phase === 'assignments' && st.types?.quiz !== false) {
      st.phase = 'quizzes';
      saveScan(st);
      location.href = `${location.origin}/course/${st.sem}/all_assessments?tab=course`;
    } else {
      st.phase = 'done';
      saveScan(st);
      location.href = st.returnUrl;
    }
  }

  function solveSelected() {
    const picked = [...root.querySelectorAll('input[data-i]:checked')].map((c) => found[Number(c.dataset.i)]);
    if (!picked.length) return;
    // Assignments first (they submit and are graded), then quizzes.
    picked.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'assignment' ? -1 : 1));
    localStorage.removeItem('nqs-stop');
    RUN.save({ items: picked, idx: 0, returnUrl: `${location.origin}/course/${semHash()}/details?tab=course`, startedAt: Date.now() });
    setStatus(`Starting batch of ${picked.length} item(s)…`);
    location.href = picked[0].url;
  }

  function showLastRun() {
    const run = RUN.load();
    if (!run || run.idx < run.items.length && !run.stopped) return;
    const lines = run.items.map((it) => {
      const r = it.result;
      const mark = !r ? '–' : r.ok ? '✅' : '❌';
      return `${mark} <span class="tag ${it.kind}">${it.kind}</span> ${esc(it.title)}${r?.summary ? ` <span class="muted">${esc(r.summary)}</span>` : ''}`;
    }).join('<br>');
    setStatus(`<b>Batch ${run.stopped ? 'stopped' : 'finished'}.</b><br>${lines}`);
    RUN.clear();
  }

  ensureUI();
  continueScan();
  setInterval(() => { if (alive()) ensureUI(); }, 1000);
})();
