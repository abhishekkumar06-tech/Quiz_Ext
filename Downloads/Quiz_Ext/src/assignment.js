// Newton Quiz Solver: coding-assignment agent (content script, top frame of my.newtonschool.co).
//
// Assignment page  (/course/<c>/assignment/<a>): "Solve assignment" queues its questions.
// Question page    (/playground/newton-box/<id> = Jupyter, /playground/code/<id> = Monaco editor):
//   generate code -> write it -> run locally -> fix errors -> Submit -> read results -> fix -> resubmit
//   until all tests pass, the attempt cap is hit, or the user pauses/stops. Then return for the next question.
//
// Hard rule: never runs on contests.

(() => {
  if (window.__nqsAsgLoaded) return;
  window.__nqsAsgLoaded = true;

  const MAX_SUBMITS = 5;       // graded submissions per question
  const JOB_KEY = 'nqs-asg-job';
  const LAST_ASG_KEY = 'nqs-last-assignment';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // Quizzes can also live under /assignment/…: a Start Test screen or a "QUESTION n/m" attempt page.
  const isQuizLike = () => [...document.querySelectorAll('button')].some((b) => /^start test$/i.test(b.innerText.trim())) ||
    /\bQUESTION\s*\d+\s*\/\s*\d+/.test(document.body.innerText.slice(0, 3000));

  const page = () => {
    const p = location.pathname;
    if (/\/course\/[^/]+\/assignment\/[^/]+\/instructions\/?$/.test(p)) return 'assignment-instructions';
    if (/\/course\/[^/]+\/assignment\/[^/]+(\/[^/]+)?\/?$/.test(p) && !isQuizLike()) return 'assignment';
    if (/\/playground\/newton-box\//.test(p)) return 'jupyter';
    // Newton uses several playground routes for language-specific editors (including SQL
    // and database tasks). Keep Jupyter distinct and let the editor inspection identify the rest.
    if (/\/playground\//.test(p)) return 'code';
    return null;
  };

  const loadJob = () => { try { return JSON.parse(sessionStorage.getItem(JOB_KEY)); } catch { return null; } };
  const saveJob = (job) => sessionStorage.setItem(JOB_KEY, JSON.stringify(job));
  const clearJob = () => sessionStorage.removeItem(JOB_KEY);
  const samePageUrl = (a, b) => {
    if (!a || !b) return false;
    try {
      const left = new URL(a, location.origin), right = new URL(b, location.origin);
      return left.origin === right.origin && left.pathname === right.pathname;
    } catch { return false; }
  };

  async function rpc(op, data = {}) {
    if (!alive()) throw new Error('Extension was reloaded. Refresh the page.');
    const r = await abortable(chrome.runtime.sendMessage({ type: 'asg', op, ...data }));
    if (!r?.ok) throw new Error(r?.error || 'Extension error');
    return r.result;
  }

  // Stop is stored in localStorage so it also halts a batch that is mid-navigation or reloading.
  const STOP_KEY = 'nqs-stop';
  const stopRequested = () => state.stop || localStorage.getItem(STOP_KEY) === '1';
  const clearStop = () => { state.stop = false; localStorage.removeItem(STOP_KEY); };

  async function waitFor(fn, timeout = 10000, every = 250) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested()) throw new Error('Stopped by user');
      if (state.paused) { await sleep(300); continue; }
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  // Resolve p, but reject as soon as Stop is pressed (so long API calls don't keep the run alive).
  function abortable(p) {
    let iv;
    const stopped = new Promise((_, reject) => {
      iv = setInterval(() => { if (stopRequested()) reject(new Error('Stopped by user')); }, 250);
    });
    return Promise.race([p, stopped]).finally(() => clearInterval(iv));
  }

  const visible = (el) => el && el.getBoundingClientRect().width > 0;
  const findButton = (re) => [...document.querySelectorAll('button')]
    .find((b) => visible(b) && re.test(b.innerText.trim()) && !b.closest('#nqs-asg-host, #nqs-host'));

  // ---------- Contest guard ----------

  // Contests share the assignment URL format, so decide from page content.
  function contestReason() {
    const head = document.body.innerText.slice(0, 2000);
    if (/contest/i.test(document.title)) return 'page title mentions a contest';
    if (/\bcontest\b/i.test(head)) return 'page mentions a contest';
    if (/\b(time left|ends in|remaining time|test ends)\b/i.test(head)) return 'page has a contest-style timer';
    if (page() !== 'assignment') {
      const last = (() => { try { return JSON.parse(sessionStorage.getItem(LAST_ASG_KEY)); } catch { return null; } })();
      if (last?.contest) return 'opened from a contest';
    }
    return null;
  }

  // ---------- UI ----------

  let host, root;
  const state = { running: false, paused: false, stop: false, log: [] };

  function ensureUI() {
    const kind = page();
    if (!kind) { if (host) host.style.display = 'none'; return; }
    if (!host) {
      host = document.createElement('div');
      host.id = 'nqs-asg-host';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .wrap { position: fixed; right: 20px; bottom: 24px; z-index: 2147483647; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
          .panel { width: 380px; max-height: 55vh; overflow: auto; background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
          .panel[hidden] { display: none; }
          .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600; position: sticky; top: 0; background: #fff; }
          .head button { border: 0; background: none; cursor: pointer; font-size: 16px; color: #666; }
          .status { padding: 8px 12px; border-bottom: 1px solid #f2f2f2; color: #333; }
          .quota-popup { margin: 10px 12px 0; padding: 10px 12px; border: 1px solid #e6ad45; border-radius: 8px; background: #fff6df; color: #5c3b00; box-shadow: 0 3px 12px rgba(120,75,0,.12); }
          .quota-popup[hidden] { display: none; }
          .quota-popup strong { display: block; margin-bottom: 3px; }
          .quota-popup .quota-close { float: right; margin: -2px -4px 0 8px; border: 0; background: transparent; color: #5c3b00; font-size: 18px; cursor: pointer; }
          .log { padding: 6px 12px 10px; font-size: 12px; color: #555; }
          .log div { padding: 2px 0; border-bottom: 1px dashed #f0f0f0; white-space: pre-wrap; word-break: break-word; }
          .ok { color: #146c2e; } .bad { color: #a1261f; } .warn { color: #8a5a00; }
          .row { display: flex; gap: 8px; align-items: center; }
          button.main { background: #111; color: #fff; border: 0; border-radius: 999px; padding: 11px 18px; font-weight: 600; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
          button.main:disabled { opacity: .5; cursor: default; }
          button.sec { background: #fff; color: #111; border: 1px solid #ccc; border-radius: 999px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
          label.opt { background: #fff; border: 1px solid #ddd; border-radius: 999px; padding: 6px 10px; font-size: 12px; display: flex; gap: 6px; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
          details summary { cursor: pointer; }
          pre { white-space: pre-wrap; font-size: 11px; background: #fafafa; padding: 6px; border-radius: 6px; max-height: 180px; overflow: auto; }
        </style>
        <div class="wrap">
          <div class="panel" hidden>
            <div class="head"><span>Assignment Solver</span><button class="close" title="Hide">×</button></div>
            <div class="quota-popup" hidden role="alert"><button class="quota-close" title="Dismiss">×</button><strong>Daily AI quota reached</strong><span class="quota-message"></span></div>
            <div class="status">Ready.</div>
            <div class="log"></div>
          </div>
          <label class="opt" hidden><input type="checkbox" class="resolve"> Include already-solved questions</label>
          <div class="row">
            <button class="sec pause" hidden>Pause</button>
            <button class="sec stop" hidden>Stop</button>
            <button class="main go">⚡ Solve</button>
          </div>
        </div>`;
      document.documentElement.appendChild(host);
      root.querySelector('.close').onclick = () => { root.querySelector('.panel').hidden = true; };
      root.querySelector('.quota-close').onclick = () => { root.querySelector('.quota-popup').hidden = true; };
      root.querySelector('.go').onclick = onMainClick;
      root.querySelector('.pause').onclick = () => {
        state.paused = !state.paused;
        root.querySelector('.pause').textContent = state.paused ? 'Resume' : 'Pause';
        setStatus(state.paused ? 'Paused. Press Resume to continue.' : 'Resuming…');
      };
      root.querySelector('.stop').onclick = () => {
        state.stop = true; state.paused = false;
        localStorage.setItem(STOP_KEY, '1');
        clearJob();
        window.__nqsRun?.stop();
        setStatus('<b>Stopped.</b> Nothing else will be written or submitted.');
      };
    }
    host.style.display = '';
    const go = root.querySelector('.go');
    root.querySelector('.opt').hidden = kind !== 'assignment' || state.running;
    root.querySelector('.pause').hidden = !state.running;
    root.querySelector('.stop').hidden = !state.running;
    if (!state.running) go.textContent = kind === 'assignment'
      ? '⚡ Solve assignment'
      : kind === 'assignment-instructions' ? '⚡ Open assignment questions' : '⚡ Solve this question';
    go.disabled = state.running;
  }

  const $ = (s) => root.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function setStatus(html) { $('.panel').hidden = false; $('.status').innerHTML = html; }
  function showQuotaPopup() {
    const popup = $('.quota-popup');
    $('.quota-popup strong').textContent = 'Daily AI quota reached';
    $('.quota-message').textContent = 'All configured Groq and Google Gemini models have reached their daily quota. The solver is paused on this question; this quota failure did not use a submission attempt. Resume after quota resets or update your API keys.';
    popup.hidden = false;
    $('.panel').hidden = false;
  }
  function showProviderPausePopup() {
    const popup = $('.quota-popup');
    $('.quota-popup strong').textContent = 'AI provider temporarily unavailable';
    $('.quota-message').textContent = 'A model provider is rate-limited or temporarily unavailable. The solver paused here to avoid repeating requests and using more quota. Resume after the provider recovers.';
    popup.hidden = false;
    $('.panel').hidden = false;
  }
  function log(text, cls = '', detail = '') {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${esc(text)}` +
      (detail ? `<details><summary>details</summary><pre>${esc(detail)}</pre></details>` : '');
    $('.log').prepend(d);
    $('.panel').hidden = false;
  }

  async function checkpoint() {
    while (state.paused && !stopRequested()) await sleep(300);
    if (stopRequested()) throw new Error('Stopped by user');
    if (!alive()) throw new Error('Extension was reloaded. Refresh the page.');
  }

  // ---------- Assignment page ----------

  // Question-card buttons seen so far: "View Submission" (solved), "Complete Now" (unsolved).
  const OPEN_BTN = /submission|solve|start|attempt|continue|open|complete|resume|retry|practice|begin/i;

  // Question types the solver leaves for the user.
  const SKIP_RE = /\bbash\b|shell script|think[\s-]*a?loud|think[\s-]*out[\s-]*loud|\bcontest\b|\baws\b|amazon web services|\bec2\b|\bs3 bucket/i;

  function readQuestionCards() {
    const labels = [...document.querySelectorAll('span,div,p')].filter((e) =>
      /^Q\d+\.?$/.test((e.innerText || '').trim()) && ![...e.children].some((c) => /^Q\d+/.test(c.innerText || '')));
    return labels.map((lab) => {
      let card = lab;
      for (let i = 0; i < 10 && card; i++) {
        if ([...card.querySelectorAll('button')].some((b) => OPEN_BTN.test(b.innerText.trim()))) break;
        card = card.parentElement;
      }
      if (!card) return null;
      const btn = [...card.querySelectorAll('button')].find((b) => OPEN_BTN.test(b.innerText.trim()));
      const text = card.innerText;
      const score = text.match(/(\d+)\s*\/\s*(\d+)\s*earned/);
      return {
        n: Number(lab.innerText.match(/\d+/)[0]),
        title: text.split('\n').map((s) => s.trim()).filter(Boolean)[1] || '',
        solved: /view submission/i.test(btn?.innerText || '') || (score && score[1] === score[2]),
        skip: SKIP_RE.test(text.slice(0, 600)),
        statement: text.slice(0, 8000),
        btn,
      };
    }).filter(Boolean);
  }

  async function startAssignment() {
    const reason = contestReason();
    sessionStorage.setItem(LAST_ASG_KEY, JSON.stringify({ url: location.href, contest: !!reason }));
    if (reason) {
      if (window.__nqsRun?.matchesHere('assignment')) window.__nqsRun.advance({ ok: false, summary: `blocked: ${reason}` });
      setStatus(`<span class="bad">Blocked: ${esc(reason)}. The solver never runs on contests.</span>`);
      return;
    }
    const cards = await waitFor(() => { const c = readQuestionCards(); return c.length ? c : null; }, 10000);
    if (!cards) {
      if (window.__nqsRun?.matchesHere('assignment')) window.__nqsRun.advance({ ok: false, summary: 'no questions found' });
      setStatus('<span class="bad">No questions found on this page.</span>');
      return;
    }
    const includeSolved = !window.__nqsRun?.matchesHere('assignment') && $('.resolve').checked;
    const skipped = cards.filter((c) => c.skip && (includeSolved || !c.solved));
    if (skipped.length) log(`Skipping ${skipped.map((c) => `Q${c.n}`).join(', ')} (bash / think-aloud)`, 'warn');
    const queue = cards.filter((c) => !c.skip && (includeSolved || !c.solved)).map((c) => c.n);
    if (!queue.length) {
      if (window.__nqsRun?.matchesHere('assignment')) window.__nqsRun.advance({ ok: true, summary: 'nothing left to solve' });
      setStatus(`All ${cards.length} questions are already solved. Tick <b>Include already-solved questions</b> to re-solve them.`);
      return;
    }
    const job = {
      assignmentUrl: location.href, queue, current: null, results: {},
      batch: window.__nqsRun?.matchesHere('assignment') ? window.__nqsRun.idOf(location.href) : null,
      statements: Object.fromEntries(cards.map((c) => [c.n, c.statement])),
      titles: Object.fromEntries(cards.map((c) => [c.n, c.title])),
    };
    saveJob(job);
    log(`Queued ${queue.length} question(s): ${queue.map((n) => `Q${n}`).join(', ')}`);
    await continueJob();
  }

  async function continueJob() {
    const job = loadJob();
    if (!job) return;
    const next = job.queue.find((n) => !job.results[n]);
    if (!next) {
      clearJob();
      const lines = Object.entries(job.results).map(([n, r]) => `Q${n}: ${r.ok ? '✅ passed' : '❌ ' + r.summary}`).join('<br>');
      setStatus(`<b>Assignment run finished.</b><br>${lines}`);
      if (job.batch && window.__nqsRun?.current()?.id === job.batch) {
        const rs = Object.values(job.results);
        const passed = rs.filter((r) => r.ok).length;
        window.__nqsRun.advance({ ok: passed === rs.length, summary: `${passed}/${rs.length} questions accepted` });
        setStatus(`<b>Assignment run finished.</b><br>${lines}<br>Moving to the next batch item…`);
      }
      return;
    }
    const cards = await waitFor(() => { const c = readQuestionCards(); return c.length ? c : null; }, 15000);
    const card = cards?.find((c) => c.n === next);
    if (!card?.btn) { job.results[next] = { ok: false, summary: 'could not open question' }; saveJob(job); return continueJob(); }
    job.current = next;
    saveJob(job);
    setStatus(`Opening Q${next}: ${esc(card.title)}…`);
    // Most question cards use window.open(), which leaves this assignment tab in place.
    // Keep the batch state in this tab by capturing the URL in the page's MAIN world first.
    try {
      const url = await rpc('assignment.questionUrl', { question: next });
      if (url) {
        job.currentUrl = url;
        saveJob(job);
        location.href = url;
        return;
      }
    } catch { /* fall back to the site's normal click behavior */ }
    card.btn.click();
  }

  // ---------- Question page: shared ----------

  async function readFullProblem(fallback = '') {
    let text = readProblemPanel();
    if (!text) {
      const q = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && visible(e) &&
        (e.innerText || '').trim() === 'Q' && e.getBoundingClientRect().left < 70);
      (q?.closest('button,div') || q)?.click();
      await sleep(800);
      text = readProblemPanel();
    }
    return text.length >= (fallback || '').length ? text : fallback;
  }

  function readProblemPanel() {
    const candidates = [...document.querySelectorAll('div')].filter((d) =>
      visible(d) && /^QUESTION\s*\n/.test(d.innerText || '') && d.innerText.length > 150);
    const panel = candidates.sort((a, b) => a.innerText.length - b.innerText.length)[0];
    return panel ? panel.innerText.replace(/^QUESTION\s*\n/, '').slice(0, 12000) : '';
  }

  function feedbackFromCells(cells) {
    const problems = [];
    const outputs = [];
    for (const c of cells) {
      const out = (c.output || '').trim();
      if (!out) continue;
      outputs.push(`[cell ${c.i}${c.isTarget ? ' (your code)' : ''}] ${c.head}\n${out.slice(0, 800)}`);
      if (/DIAG:|Traceback|\b\w+Error\b|\bException\b/.test(out)) problems.push(`[cell ${c.i}${c.isTarget ? ' (your code)' : ''}] ${c.head}\n${out.slice(0, 1500)}`);
    }
    return { problems, outputs: outputs.join('\n\n') };
  }

  // Newton limits concurrent playground sessions. Close the other (older) sessions so this one can load.
  async function handlePlaygroundLimit() {
    if (!/too many open playgrounds/i.test(document.body.innerText)) return false;
    // Wait out any termination already in progress before clicking again.
    if (/Terminating/i.test(document.body.innerText)) {
      await waitFor(() => !/Terminating/i.test(document.body.innerText), 30000, 500);
    }
    if (/too many open playgrounds/i.test(document.body.innerText)) {
      const others = [...document.querySelectorAll('button')].filter((b) => visible(b) && /^terminate this session$/i.test(b.innerText.trim()));
      log(`"Too many open playgrounds": closing ${others.length || 'all'} other session(s)`, 'warn');
      for (const b of others) { b.click(); await sleep(2500); }
      if (/too many open playgrounds/i.test(document.body.innerText) && !/Terminating/i.test(document.body.innerText)) {
        findButton(/^terminate all sessions$/i)?.click();
      }
      await waitFor(() => !/too many open playgrounds|Terminating/i.test(document.body.innerText), 45000, 500);
    }
    // The playground often stays on "Loading…" after sessions are closed; a reload picks up the freed slot.
    // Job state lives in sessionStorage, so the solver resumes this question after the reload.
    const loaded = await waitFor(() => !/Loading, Please wait|Playground might take some time/i.test(document.body.innerText), 25000, 1000);
    if (!loaded) {
      log('Playground still loading after closing sessions; reloading the page', 'warn');
      await sleep(500);
      location.reload();
      await sleep(60000); // page is going away
    }
    return true;
  }

  // ---------- Jupyter (newton-box) ----------

  async function jupyterReady() {
    for (let i = 0; i < 90; i++) {
      await checkpoint();
      await handlePlaygroundLimit();
      const restart = findButton(/^restart this session$/i);
      if (restart) { log('Session was disrupted; restarting it'); restart.click(); await sleep(8000); }
      try {
        const cells = await rpc('jupyter.read');
        if (cells?.length) return cells;
      } catch { /* frame not ready */ }
      await sleep(2000);
    }
    throw new Error('Jupyter notebook did not load');
  }

  function notebookPanelText() {
    const panel = [...document.querySelectorAll('div')].filter((d) => visible(d) && /^ALL SUBMISSIONS/.test(d.innerText || ''))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    return panel ? { panel, text: panel.innerText } : null;
  }

  function readNotebookResults() {
    const p = notebookPanelText();
    if (!p) return null;
    const lines = p.text.split('\n').map((x) => x.trim()).filter(Boolean);
    const summary = lines.find((l) => /submission|passed|failed/i.test(l) && !/^ALL SUBMISSIONS$/i.test(l)) || lines[1] || '';
    const tests = [];
    const names = [...p.panel.querySelectorAll('div')].filter((d) => d.childElementCount === 0 && /^test_\w+/.test(d.innerText.trim()));
    for (const nameEl of names) {
      let row = nameEl;
      for (let i = 0; i < 4 && row && !row.querySelector('svg'); i++) row = row.parentElement;
      tests.push({ name: nameEl.innerText.trim(), pass: !!row?.querySelector('path[fill="#009965"]') });
    }
    return { text: p.text, summary, tests };
  }

  // Grading can finish while the results panel is closed or never switches to "Last submission",
  // so watch several signals and cap the wait instead of hanging forever.
  async function submitNotebook() {
    const btn = findButton(/^submit solution$/i);
    if (!btn) throw new Error('Submit Solution button not found');
    btn.click();
    log('Submitted; waiting for the grader…');
    const t0 = Date.now();
    let sawChecking = false;
    let res = null;
    while (Date.now() - t0 < 120000) {
      await sleep(700);
      const body = document.body.innerText;
      const r = readNotebookResults();
      if (/Checking Submission|Running test cases/i.test((r?.text || '') + body.slice(-3000))) { sawChecking = true; continue; }
      if (/Latest Submission is Successful|all tasks passed/i.test(body)) {
        res = r; if (r?.tests.length || Date.now() - t0 > 5000) break;
      }
      if (/Latest Submission (is )?(Failed|Unsuccessful)|some tasks failed|tasks? failed/i.test(body)) { res = r; break; }
      if (sawChecking && r && /Last submission/i.test(r.text) && r.tests.length) { res = r; break; }
      // Panel closed? Open it once grading has had time to run.
      if (!r && Date.now() - t0 > 8000) {
        const icon = [...document.querySelectorAll('svg')].find((svg) => { const b = svg.closest('button,div'); const rr = b?.getBoundingClientRect(); return rr && rr.left < 60 && rr.top > 120 && rr.top < 200; });
        icon?.closest('button,div')?.click();
      }
    }
    await sleep(800);
    res = readNotebookResults() || res;
    const body = document.body.innerText;
    const passed = res ? res.tests.filter((t) => t.pass).length : 0;
    const total = res ? res.tests.length : 0;
    const ok = /all tasks passed|Latest Submission is Successful/i.test((res?.summary || '') + body) || (total > 0 && passed === total);
    if (!res && !ok) {
      log('Grader result not visible after 2 minutes; moving on', 'warn');
      return { ok: false, summary: 'result not visible (check this question manually)', failing: [], unknown: true };
    }
    const failing = res ? res.tests.filter((t) => !t.pass).map((t) => t.name) : [];
    return { ok, summary: `${res?.summary || 'submitted'}${total ? ` (${passed}/${total} tests passed)` : ''}`, failing };
  }

  async function solveJupyter(problemFallback) {
    setStatus('Waiting for the Jupyter notebook…');
    const cells = await jupyterReady();
    const editableCode = cells.filter((c) => c.type === 'code' && c.editable);
    const marker = editableCode.find((c) => /YOUR CODE HERE/.test(c.text));
    if (!editableCode.length) throw new Error('No editable code cell in this notebook');
    const problem = (await readFullProblem(problemFallback)) || cells.filter((c) => c.type === 'markdown').map((c) => c.text).join('\n');
    // Fill-in-the-blanks notebooks spread the task over several editable cells instead of one "YOUR CODE HERE" cell.
    const multi = !marker && editableCode.length > 1;
    const target = marker || editableCode[0];
    const editableIdx = editableCode.map((c) => c.i);
    const context = multi
      ? cells.map((c) => `--- cell ${c.i} (${c.type}${c.type === 'code' ? (c.editable ? ', EDITABLE' : ', read-only') : ''}) ---\n${c.text}`).join('\n').slice(0, 16000)
      : cells.filter((c) => c !== target).map((c) => `--- cell ${c.i} (${c.type}${c.editable ? '' : ', read-only'}) ---\n${c.text}`).join('\n').slice(0, 14000);
    const original = target.text;
    if (multi) log(`Fill-in-the-blanks notebook: completing ${editableIdx.length} editable cells (${editableIdx.join(', ')})`);

    const history = [];
    for (let submit = 1; submit <= MAX_SUBMITS; submit++) {
      let code = null;
      try {
        await checkpoint();
        // 1) Write code (regenerate if blanks are left in a fill-in-the-blanks notebook).
        let payload = null;
        for (let gen_try = 0; gen_try < 3 && !payload; gen_try++) {
          setStatus(`Attempt ${submit}/${MAX_SUBMITS}: writing code…`);
          const gen = await rpc('generate', { job: { kind: multi ? 'jupyter-multi' : 'jupyter', problem, context, editable: original, editableIdx, history } });
          if (multi) {
            const left = Object.entries(gen.cells).filter(([, t]) => /_{2,}|\(\s*_\s*,\s*_\s*\)/.test(t)).map(([i]) => i);
            code = Object.entries(gen.cells).map(([i, t]) => `### CELL ${i}\n${t}`).join('\n\n');
            log(`${gen.model} filled ${Object.keys(gen.cells).length} cells`, left.length ? 'warn' : '', code);
            if (left.length) { history.push({ stage: 'blanks left', code, feedback: `Blanks (____) are still present in cells ${left.join(', ')}. Replace every blank with real code.` }); continue; }
            payload = gen.cells;
          } else {
            code = gen.code;
            log(`${gen.model} wrote ${code.split('\n').length} lines`, '', code);
            payload = code;
          }
        }
        if (!payload) throw new Error('Could not produce code without blanks');
        const w = await rpc('jupyter.writeRun', { code: payload, run: false });
        if (!w || w.error) throw new Error(w?.error || 'Could not write to the notebook');

        // 2) Submit straight away.
        await checkpoint();
        setStatus(`Attempt ${submit}/${MAX_SUBMITS}: submitted, grading…`);
        const res = await submitNotebook();
        if (res.ok) { log(`Accepted: ${res.summary}`, 'ok'); return { ok: true, summary: res.summary, submits: submit }; }
        log(`Not accepted: ${res.summary}`, 'bad', res.failing?.length ? `Failing: ${res.failing.join(', ')}` : '');

        // 3) Only now run the notebook locally, to get concrete errors/outputs for the fix.
        await checkpoint();
        setStatus(`Attempt ${submit}/${MAX_SUBMITS}: running the notebook to find the problem…`);
        const run = await rpc('jupyter.writeRun', { code: null, run: true });
        const fb = run?.cells ? feedbackFromCells(run.cells) : { problems: [], outputs: '' };
        if (run?.timedOut) fb.problems.push('Notebook run timed out after 4 minutes (infinite loop or very slow code?)');
        if (fb.problems.length) log(`Local run found ${fb.problems.length} problem(s)`, 'warn', fb.problems.join('\n\n'));
        history.push({
          stage: `graded submission ${submit}`, code,
          feedback: `${res.summary}\nFailing hidden tests: ${(res.failing || []).join(', ') || 'unknown'}\n` +
            (fb.problems.length ? `Errors when running the notebook:\n${fb.problems.join('\n\n')}` : `Notebook ran without errors. Test-cell outputs:\n${fb.outputs}`),
        });
      } catch (e) {
        if (/Stopped by user|Extension was reloaded|No API key/i.test(e.message)) throw e;
        log(`Attempt ${submit} failed: ${e.message}; retrying`, 'warn');
        history.push({ stage: `attempt ${submit} error`, code: code || '', feedback: e.message });
        await sleep(1500);
      }
    }
    return { ok: false, summary: `not accepted after ${MAX_SUBMITS} attempts` };
  }

  // ---------- Code playground (Monaco: Verilog, Python, Java, …) ----------

  // Some playgrounds show a bare language label ("MongoDB") while others include a version.
  const LANG_RE = /^[A-Za-z][A-Za-z0-9+# ]*(?:\s*\([^)]*\))?$/;

  // The language dropdown trigger sits above the code editor and contains a chevron icon.
  function languageTrigger() {
    return [...document.querySelectorAll('button, div, span')].find((e) =>
      visible(e) && e.querySelector('svg') && LANG_RE.test((e.innerText || '').trim()) &&
      e.getBoundingClientRect().top < 200 && e.innerText.trim().length < 40);
  }

  // Newton lets many questions be solved in several languages; always prefer Python when offered.
  async function ensurePython(preferPython = true) {
    const trigger = languageTrigger();
    if (!trigger) return null;
    const current = trigger.innerText.trim();
    if (!preferPython) return current;
    if (/^python/i.test(current)) return current;
    trigger.click();
    await sleep(600);
    const top = trigger.getBoundingClientRect().top;
    const options = [...document.querySelectorAll('*')].filter((e) =>
      e.childElementCount === 0 && visible(e) && LANG_RE.test((e.innerText || '').trim()) && e.getBoundingClientRect().top > top + 5);
    const py = options.find((o) => /^python/i.test(o.innerText.trim()));
    if (!py) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      trigger.click(); // close the menu again
      await sleep(300);
      return current;
    }
    py.click();
    await sleep(800);
    // Some sites confirm that switching language resets the code.
    findButton(/^(yes|confirm|change|continue|ok|switch)\b/i)?.click();
    await waitFor(() => /^python/i.test(languageTrigger()?.innerText.trim() || ''), 8000, 250);
    await sleep(1200); // let the Python template load
    log(`Switched language: ${current} → ${languageTrigger()?.innerText.trim() || 'Python'}`);
    return languageTrigger()?.innerText.trim() || 'Python';
  }

  // Editor panel tabs (INPUT / OUTPUT / ERROR / TEST BENCH). Match the exact uppercase label and take the
  // right-most one: the problem statement has "Input"/"Output" headings and the submissions panel has
  // "INPUT"/"OUTPUT" labels, both further left.
  function clickTab(name) {
    const el = [...document.querySelectorAll('*')]
      .filter((e) => e.childElementCount === 0 && visible(e) && e.innerText?.trim() === name)
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
    el?.click();
    return !!el;
  }

  // First sample input/output pair from the problem statement. Handles both
  //   "Sample Input:- … Sample Output:- …"  and  "Example / Input … / Output: …".
  function sampleIO(problem) {
    // Stop before the site's own "Generate Expected Output" widget text.
    const clean = problem.split(/\n\s*(?:Generated Expected Output|Insert Input|Generate Expected Output)\b/)[0];
    // Only look inside the Example/Sample section, so the "Input format" description isn't mistaken for data.
    const start = clean.search(/(^|\n)\s*(?:Sample|Example)s?\b/i);
    const scope = start >= 0 ? clean.slice(start) : clean;
    const m = scope.match(/(?:Sample\s*|Example\s*)?Input\s*\d*\s*[:\-]*\s*\n([\s\S]*?)\n\s*(?:Sample\s*|Example\s*)?Output\s*\d*\s*[:\-]*\s*\n([\s\S]*?)(?=\n\s*(?:Explanation|Sample\s*Input|Example|Constraints|Note)\b|$)/i);
    if (!m) return null;
    const input = m[1].trim();
    const output = m[2].trim();
    return input && output ? { input, output } : null;
  }

  // Errors that only mean "the program wanted stdin and got none", not a bug in the code.
  const NO_INPUT_ERROR = /EOFError|EOF when reading|NoSuchElementException|end of file|Unexpected end of input/i;

  const sameOutput = (a, b) => a.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n') ===
    b.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

  const readLower = async (tab) => { clickTab(tab); await sleep(350); return ((await rpc('monaco.read'))?.lower || '').trim(); };

  async function runCodeLocally(sample) {
    const run = findButton(/^run$/i);
    if (!run) return null;
    // Snapshot the panels first: they keep the previous run's text, which must not be mistaken for a new error.
    const errBefore = await readLower('ERROR');
    if (clickTab('INPUT')) {
      await sleep(300);
      await rpc('monaco.write', { code: sample?.input || '', target: 'lower' });
    }
    run.click();
    await waitFor(() => !findButton(/^run$/i), 5000, 100);   // label disappears while running
    await waitFor(() => findButton(/^run$/i), 120000, 300);   // back when done
    await sleep(800);
    let out = await readLower('OUTPUT');
    for (let i = 0; i < 20 && /Running Code/i.test(out); i++) { await sleep(500); out = await readLower('OUTPUT'); }
    const err = await readLower('ERROR');
    clickTab('OUTPUT');

    // A matching sample output is the strongest signal: the code works, whatever else the panels say.
    if (sample?.output && out && sameOutput(out, sample.output)) return { error: '', output: out, mismatch: '', matched: true };

    let error = /Running Code/i.test(err) ? '' : err;
    if (error && error === errBefore && out) error = '';                         // stale text from an earlier run
    if (error && out && !/Traceback|Error\b|Exception|error:/i.test(error)) error = ''; // warnings only
    if (error && !sample?.input && NO_INPUT_ERROR.test(error)) {
      log('Run needed input but no sample was found in the statement; ignoring the EOF error', 'warn');
      error = '';
    }
    let mismatch = '';
    if (!error && sample?.output && out && !/Running Code/i.test(out)) {
      mismatch = `Sample input:\n${sample.input}\nExpected output:\n${sample.output}\nYour output:\n${out.slice(0, 1500)}`;
    }
    return { error, output: out, mismatch };
  }

  // Restore the starter template (top-right reset icon of the editor + "Yes, Reset Code"), so leftovers from
  // earlier attempts don't get treated as the template.
  async function resetEditor() {
    const edRect = await (async () => {
      const el = [...document.querySelectorAll('.monaco-editor')].filter(visible).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      return el?.getBoundingClientRect();
    })();
    if (!edRect) return false;
    const icons = [...document.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return visible(b) && b.querySelector('svg') && !b.innerText.trim() && r.width < 60 &&
        r.top > edRect.top - 70 && r.top < edRect.top && r.left > edRect.left + edRect.width * 0.6;
    }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    for (const icon of icons) {
      icon.click();
      const yes = await waitFor(() => findButton(/^yes,?\s*reset/i), 2500, 150);
      if (yes) { yes.click(); await sleep(1500); return true; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    return false;
  }

  function codePanel() {
    const panel = [...document.querySelectorAll('div')].filter((d) => visible(d) && /^ALL SUBMISSIONS/.test(d.innerText || '') && /Last Submission/i.test(d.innerText))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!panel) return null;
    const t = panel.innerText.replace(/\n+/g, ' | ');
    const m = t.match(/(\d+|-)\s*\/\s*(\d+)\s*\|\s*Test Cases Pass\w*\s*\|\s*([^|]+)/i) || t.match(/(\d+|-)\s*\/\s*(\d+)\s*\|[^|]*\|\s*([^|]+)/);
    return m ? { passed: m[1] === '-' ? null : Number(m[1]), total: Number(m[2]), status: m[3].trim(), text: t } : { text: t };
  }

  function openCodeSubmissions() {
    if (codePanel()) return true;
    const named = [...document.querySelectorAll('button,[role="button"],[title],[aria-label]')].find((el) =>
      visible(el) && /submission/i.test(`${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`));
    if (named) { named.click(); return true; }

    // The playground keeps Question and All Submissions behind icons in its left rail.
    // On database routes the question panel is initially selected, so grading results
    // remain invisible unless the submissions icon is opened after Submit.
    const icons = [...document.querySelectorAll('svg')].map((svg) => {
      const el = svg.closest('button,[role="button"]') || svg.closest('div');
      const rect = el?.getBoundingClientRect();
      return { el, rect };
    }).filter(({ el, rect }) => visible(el) && rect.left < 100 && rect.top > 80 && rect.top < window.innerHeight * 0.65)
      .sort((a, b) => a.rect.top - b.rect.top);
    if (!icons.length) return false;
    icons[0].el.click();
    return true;
  }

  async function submitCode() {
    const before = codePanel()?.text || '';
    const btn = findButton(/^submit$/i);
    if (!btn) throw new Error('Submit button not found');
    btn.click();
    log('Submitted; waiting for the grader…');
    await sleep(500);
    if (!codePanel()) {
      openCodeSubmissions();
      await sleep(500);
    }
    await waitFor(() => { const p = codePanel(); return p && (p.passed == null || /queue|running|compil|pending|process/i.test(p.status || '') || p.text !== before); }, 15000, 200);
    const final = await waitFor(() => {
      const p = codePanel();
      return p && p.passed != null && !/queue|running|compil|pending|process/i.test(p.status || '') ? p : null;
    }, 180000, 400);
    if (!final) throw new Error('Timed out waiting for the submission result');
    // Close the "Congratulations" dialog if it appeared.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const ok = final.total > 0 && final.passed === final.total;
    return { ok, summary: `${final.passed}/${final.total} test cases passed · ${final.status}` };
  }

  async function solveCode(problemFallback) {
    setStatus('Reading the editor…');
    let info = null;
    for (let i = 0; i < 30 && !info; i++) {
      await handlePlaygroundLimit();
      try { info = await rpc('monaco.read'); } catch { /* not ready */ }
      if (!info) await sleep(1000);
    }
    if (!info) throw new Error('Code editor not found');
    const initialLabel = languageTrigger()?.innerText.trim() || '';
    const dbQuestion = /\/playground\/database\//i.test(location.pathname) ||
      /\b(sql|mysql|mariadb|postgres(?:ql)?|mongodb|mongo(?:db)? shell|aggregation pipeline)\b/i
        .test(`${initialLabel} ${info.language} ${problemFallback}`);
    // Switching to Python is useful for ordinary algorithm challenges, but breaks SQL and
    // MongoDB tasks by replacing their query editor and starter content.
    const label = await ensurePython(!dbQuestion);
    info = (await rpc('monaco.read')) || info;
    if (/bash|shell|\bsh\b|zsh/i.test(`${label || ''} ${info.language}`)) {
      log(`Skipping: ${label || info.language} question`, 'warn');
      return { ok: false, skipped: true, summary: `skipped (${label || info.language} question)` };
    }
    // The database editor's reset control is not the code-playground starter reset and can
    // replace its query model. Database solutions are complete replacements, so leave it alone.
    if (!dbQuestion && await resetEditor()) {
      log('Reset the editor to the starter template');
      info = (await rpc('monaco.read')) || info;
    }
    const problem = await readFullProblem(problemFallback);
    const language = label && label.toLowerCase().startsWith(info.language.toLowerCase().slice(0, 4)) ? label : (label || info.language);
    const databaseMode = /\b(mysql|mariadb|sql|postgres(?:ql)?)\b/i.test(`${language} ${info.language} ${problem}`)
      ? 'sql'
      : /\b(mongodb|mongo(?:db)? shell|aggregation pipeline)\b/i.test(`${language} ${info.language} ${problem}`)
        ? 'mongodb'
        : /\/playground\/database\//i.test(location.pathname) ? 'mongodb' : null;
    const original = info.code;
    // Function-only questions: the template defines functions/classes and a hidden driver reads input and prints.
    const isPython = /python/i.test(language);
    const functionOnly = isPython && /\b(def|class)\s+\w+/.test(original) && !/input\s*\(|sys\.stdin|readline|__name__/.test(original);
    const requiredNames = [...original.matchAll(/\b(?:def|class)\s+(\w+)/g)].map((m) => m[1]);
    log(databaseMode ? `${databaseMode === 'sql' ? 'SQL' : 'MongoDB'} question` : !isPython ? `${language} question` : functionOnly ? 'Function-only question: implementing the template functions (no input/print)' : 'Full-program question: reading stdin and printing output');
    const answerLabel = databaseMode === 'mongodb' ? 'MongoDB query' : databaseMode === 'sql' ? 'SQL query' : `${language} code`;
    const sample = sampleIO(problem);
    const history = [];
    let infrastructureFailures = 0;

    for (let submit = 1; submit <= MAX_SUBMITS; submit++) {
      let code = null;
      let submissionStarted = false;
      try {
        await checkpoint();
        // 1) Write complete code (regenerate if the template's functions/classes are missing).
        for (let gen_try = 0; gen_try < 3; gen_try++) {
          setStatus(`Attempt ${submit}/${MAX_SUBMITS}: generating ${esc(answerLabel)}…`);
          const gen = await rpc('generate', { job: { kind: 'code', problem, language, databaseMode, editable: original, history, functionOnly, isPython, attempt: submit } });
          let c = gen.code.replace(/\r\n?/g, '\n');
          if (!/\bsys\./.test(c)) c = c.replace(/^\s*import sys\s*\n/gm, '');
          const missing = requiredNames.filter((n) => !new RegExp(`\\b(def|class)\\s+${n}\\b`).test(c));
          const tooShort = !databaseMode && c.trim().split('\n').length < 3;
          const sqlPlaceholders = databaseMode === 'sql' &&
            /\b(?:table_name|old_column_name|new_column_name|your_table|your_column|old_column|new_column)\b|<\s*(?:table|column)\b/i.test(c);
          if (missing.length || tooShort || sqlPlaceholders) {
            const reason = sqlPlaceholders ? 'generic placeholder names remain' : `missing ${missing.join(', ') || 'required code'}`;
            log(`Generated answer is incomplete (${reason}); regenerating`, 'warn', c);
            history.push({
              stage: sqlPlaceholders ? 'SQL placeholders remain' : 'incomplete code', code: c,
              feedback: sqlPlaceholders
                ? `Replace generic SQL placeholders with the exact names from the problem. Do not return table_name, old_column_name, or new_column_name.`
                : `Your code was incomplete. Return the full file including: ${requiredNames.join(', ')}. A short SQL or MongoDB answer may be complete; do not add filler lines.`,
            });
            continue;
          }
          code = c;
          log(`${gen.model} generated ${code.split('\n').length} lines of ${answerLabel}`, '', code);
          break;
        }
        if (!code) throw new Error('Could not generate complete code');
        setStatus(`Attempt ${submit}/${MAX_SUBMITS}: replacing the editor contents…`);
        if (submit > 1) log(`Replacing the previous answer with attempt ${submit}`);
        const w = await rpc('monaco.write', { code });
        if (!w?.ok) throw new Error(`Could not write into the editor (${w?.reason || 'unknown'})`);

        // 2) Submit straight away (local runs of input-based questions were causing false errors).
        await checkpoint();
        setStatus(`Attempt ${submit}/${MAX_SUBMITS}: submitting ${esc(answerLabel)}…`);
        submissionStarted = true;
        const res = await submitCode();
        if (res.ok) { log(`Accepted: ${res.summary}`, 'ok'); return { ok: true, summary: res.summary, submits: submit }; }
        log(`Not accepted: ${res.summary}`, 'bad');

        // 3) Wrong answer: check the sample input/output with a local run to find out why.
        let diagnosis = '';
        // Database playgrounds do not use the generic stdin/stdout runner. Treating a
        // SQL/MongoDB sample as program input can start the unrelated Run flow and leave
        // the retry loop waiting on an output panel that will never contain grader data.
        if (!databaseMode && sample) {
          await checkpoint();
          setStatus(`Attempt ${submit}/${MAX_SUBMITS}: running the sample input to find the problem…`);
          const run = await runCodeLocally(sample);
          if (run?.error) diagnosis = `Running the sample input produced this error:\n${run.error}`;
          else if (run?.mismatch) diagnosis = `Sample output is wrong:\n${run.mismatch}`;
          else if (run?.matched) diagnosis = 'The sample input gives the correct output, so the bug is in an edge case or a requirement the sample does not cover.';
          if (diagnosis) log('Diagnosis from the sample run', 'warn', diagnosis);
        }
        history.push({
          stage: `graded submission ${submit}`, code,
          feedback: databaseMode === 'sql'
            ? `${res.summary}. The grader provided no test details. This exact SQL failed: independently re-check the requested operations, transaction boundaries and order, dialect, identifiers, and expected result shape. Return the shortest corrected SQL; do not repeat it with only formatting changes or add unrequested statements.`
            : `${res.summary}. Hidden test inputs are not shown.\n${diagnosis}\nRe-read the ENTIRE problem statement (every requirement, input/output format, reset/enable priority, edge cases) and fix the solution.`,
        });
      } catch (e) {
        if (/Stopped by user|Extension was reloaded|No API key/i.test(e.message)) throw e;
        // API/quota/editor failures happen before a grader attempt. Do not burn the
        // five submission slots or silently advance the assignment on these errors.
        if (!submissionStarted) {
          if (/daily limit|all models are at their daily limit|quota exceeded/i.test(e.message)) {
            const summary = 'Paused on this question because all configured AI models are at their daily quota limit.';
            showQuotaPopup();
            log(summary, 'bad');
            return { ok: false, halted: true, summary };
          }
          if (/\b429\b|rate.?limit|timed out|\b503\b|overloaded/i.test(e.message)) {
            const summary = 'Paused on this question because the model providers are rate-limited or temporarily unavailable.';
            showProviderPausePopup();
            log(summary, 'warn', e.message);
            return { ok: false, halted: true, summary };
          }
          infrastructureFailures++;
          if (infrastructureFailures < 3) {
            log(`Could not generate or write an answer (${infrastructureFailures}/3); retrying without using a submission attempt: ${e.message}`, 'warn');
            submit--;
            await sleep(1500);
            continue;
          }
          const summary = `Paused on this question after repeated generation/editor errors: ${e.message}`;
          log(summary, 'bad');
          return { ok: false, halted: true, summary };
        }
        log(`Attempt ${submit} failed: ${e.message}; retrying`, 'warn');
        history.push({ stage: `attempt ${submit} error`, code: code || '', feedback: e.message });
        await sleep(1500);
      }
    }
    return { ok: false, summary: `not accepted after ${MAX_SUBMITS} attempts` };
  }

  // ---------- Orchestration ----------

  async function solveCurrentQuestion() {
    const reason = contestReason();
    if (reason) throw new Error(`Blocked: ${reason}. The solver never runs on contests.`);
    const job = loadJob();
    const fallback = job?.current ? job.statements?.[job.current] : '';
    const kind = page();
    if (kind === 'jupyter') return solveJupyter(fallback);
    if (kind === 'code') return solveCode(fallback);
    throw new Error('Unsupported question page');
  }

  async function runQuestion({ queueNavigation = false } = {}) {
    if (stopRequested()) return;
    state.running = true; state.paused = false;
    ensureUI();
    let result;
    try {
      result = await solveCurrentQuestion();
      setStatus(result.ok
        ? `<span class="ok"><b>Accepted</b> · ${esc(result.summary)} · ${result.submits} submission(s)</span>`
        : `<span class="bad"><b>Not solved:</b> ${esc(result.summary)}</span>`);
    } catch (e) {
      result = { ok: false, summary: e.message };
      setStatus(`<span class="bad">${esc(e.message)}</span>`);
      log(e.message, 'bad');
    } finally {
      state.running = false;
      ensureUI();
    }
    if (result.halted) return; // Keep the assignment queue on this question for a later resume.
    // Setup problems (missing keys, extension reloaded) would fail every question the same way: stop the run.
    if (/no API key|Open the extension settings|Extension was reloaded/i.test(result.summary || '')) {
      clearJob();
      setStatus(`<span class="bad">${esc(result.summary)}</span><br>Open the extension settings, add your Groq key, click <b>Save &amp; test keys</b>, then start again.`);
      return;
    }
    if (stopRequested()) { clearJob(); return; }
    const job = loadJob();
    if (queueNavigation && job?.current && samePageUrl(job.currentUrl, location.href)) {
      job.results[job.current] = result;
      job.current = null;
      job.currentUrl = null;
      saveJob(job);
      log('Returning to the assignment for the next question…');
      await sleep(2500);
      location.href = job.assignmentUrl;
    }
  }

  async function onMainClick() {
    if (state.running) return;
    if (!alive()) { location.reload(); return; }
    clearStop(); // a new manual start overrides an earlier Stop
    const kind = page();
    if (kind === 'assignment-instructions') {
      setStatus('Click <b>Start Test</b> on the assignment page to open its questions. The solver will be available on the question view.');
      return;
    }
    if (kind === 'assignment') {
      state.running = true; ensureUI();
      try { await startAssignment(); } finally { state.running = false; ensureUI(); }
    } else {
      const job = loadJob();
      // A leftover queue must never redirect a manually opened question to an old assignment.
      // Keep it only when this is the exact question the queue opened and paused on.
      if (!job?.current || !samePageUrl(job.currentUrl, location.href)) clearJob();
      // A direct click should never navigate away from the question tab. Queue navigation
      // is handled only by the automatic resume path below.
      await runQuestion();
    }
  }

  // The service worker reports provider/model activity while a generation request is
  // still running, so the status stays useful during slow responses and rate limits.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'asg-progress' || !state.running || !root) return;
    const text = String(msg.text || 'Working…');
    setStatus(esc(text));
    log(text, /limit|quota|timed out|switching/i.test(text) ? 'warn' : '');
  });

  // Resume an in-progress assignment job after navigation (SPA or full reload).
  let handledPath = null;
  async function onRoute() {
    ensureUI();
    const kind = page();
    if (location.pathname === handledPath || state.running) return;
    handledPath = location.pathname;
    const job = loadJob();
    if (kind === 'assignment') {
      const reason = contestReason();
      sessionStorage.setItem(LAST_ASG_KEY, JSON.stringify({ url: location.href, contest: !!reason }));
      const sameAssignment = job && window.__nqsRun && window.__nqsRun.idOf(job.assignmentUrl) === window.__nqsRun.idOf(location.href);
      if (sameAssignment) {
        state.running = true; ensureUI();
        await sleep(2500);
        try { await continueJob(); } finally { state.running = false; ensureUI(); }
      } else if (!job && window.__nqsRun?.matchesHere('assignment')) {
        log('Batch: starting this assignment');
        state.running = true; ensureUI();
        await sleep(3000);
        try { await startAssignment(); } finally { state.running = false; ensureUI(); }
      }
    } else if ((kind === 'jupyter' || kind === 'code') && job?.current && samePageUrl(job.currentUrl, location.href)) {
      await sleep(3000);
      await runQuestion({ queueNavigation: true });
    } else if ((kind === 'jupyter' || kind === 'code') && job?.current) {
      // Stale queue state can otherwise send this tab back to an unrelated assignment.
      clearJob();
    }
  }

  // Some assignments open on a "Start Test" instructions screen before their question list. The page guard
  // treats that screen as quiz-like, so during a batch run click Start here when the current item is this assignment.
  let startClickedAt = 0;
  function batchStartScreen() {
    const RUN = window.__nqsRun;
    if (!RUN?.matchesHere('assignment') || Date.now() - startClickedAt < 8000) return;
    const start = [...document.querySelectorAll('button')].find((b) => visible(b) && /^(start|resume|continue)\s*(test|assignment)?$/i.test(b.innerText.trim()));
    if (!start) return;
    startClickedAt = Date.now();
    start.click();
    setTimeout(() => {
      [...document.querySelectorAll('button')].find((b) => visible(b) && b !== start && /^(yes|confirm|start|ok|proceed)\b/i.test(b.innerText.trim()))?.click();
    }, 1500);
  }

  onRoute();
  setInterval(() => { if (alive()) { batchStartScreen(); onRoute(); } }, 1000);
})();
