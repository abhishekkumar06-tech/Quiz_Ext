// Newton Quiz Solver: content script.
// Reads quiz questions from the page, sends them to the background solver,
// then selects the answers and marks uncertain ones for review. Never submits.

(() => {
  if (window.__nqsLoaded) return;
  window.__nqsLoaded = true;
  // After the extension is reloaded, a stale panel from the old script may remain; replace it.
  document.getElementById('nqs-host')?.remove();

  const extensionAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LETTERS = 'ABCDEFGHIJ';

  // ---------- Page driver ----------

  // Quizzes can live under /assessment/<id> or /assignment/<id> (older semesters). The attempt page is the one
  // showing a "QUESTION n/m" header; /instructions is the Start Test screen.
  const quizPath = () => /\/course\/[^/]+\/(assessment|assignment)\/[^/]+/.test(location.pathname);
  const isQuizPage = () => quizPath() && !/\/instructions\/?$/.test(location.pathname) &&
    (/\/assessment\/[^/]+\/?$/.test(location.pathname) || !!readHeader());

  function readHeader() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const m = t.textContent.trim().match(/^QUESTION\s*(\d+)\s*\/\s*(\d+)$/i);
      if (m) return { current: +m[1], total: +m[2], node: t.parentElement };
    }
    return null;
  }

  function findButton(re) {
    return [...document.querySelectorAll('button')].find((b) => re.test(b.innerText.trim()) && !b.closest('#nqs-host'));
  }

  const optionLabels = () =>
    [...document.querySelectorAll('label')].filter((l) => l.querySelector('input[data-index]'));

  const STOP_KEY = 'nqs-stop';
  const stopRequested = () => localStorage.getItem(STOP_KEY) === '1';

  async function waitFor(fn, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested()) throw new Error('Stopped by user');
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  }

  const answerBox = () => [...document.querySelectorAll('input[type=text], input[type=number], textarea')]
    .find((i) => i.getBoundingClientRect().width > 0 && !i.closest('#nqs-host') && /answer/i.test(i.placeholder || '') );

  // Fill-in-the-blank questions: a single "Enter your answer here" box instead of options.
  function readTextQuestion(header) {
    const box = answerBox();
    if (!box) return null;
    let scope = box.parentElement;
    while (scope && !scope.contains(header.node)) scope = scope.parentElement;
    if (!scope) return null;
    const text = scope.innerText
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !/^QUESTION\s*\d+\s*\/\s*\d+$/i.test(l) && !/^(Mark for review|Unmark|Clear Selection|Previous|Next|Submit Quiz)$/i.test(l))
      .join('\n').replace(/click to enlarge/gi, '').trim();
    const { images, loading } = collectImages(scope, []);
    const numeric = box.type === 'number' || box.inputMode === 'numeric';
    return { num: header.current, total: header.total, text, options: [], type: 'text', numeric,
      hasImage: images.length > 0, images, imagesLoading: loading };
  }

  function readCurrentQuestion() {
    const header = readHeader();
    const labels = optionLabels();
    if (header && !labels.length) return readTextQuestion(header);
    if (!header || !labels.length) return null;
    const wrap = labels[0].parentElement;

    // Question text = siblings before the options list, excluding the header row.
    const parts = [];
    let sib = wrap.previousElementSibling;
    while (sib && !sib.contains(header.node)) {
      parts.unshift(sib);
      sib = sib.previousElementSibling;
    }
    const text = parts.map((p) => p.innerText.replace(/click to enlarge/gi, '').trim()).filter(Boolean).join('\n');

    const options = labels.map((l, i) => {
      const input = l.querySelector('input[data-index]');
      let t = l.innerText.replace(/\r/g, '');
      // Strip the leading "A" badge line.
      t = t.replace(/^\s*[A-J]\s*\n/, '');
      return { letter: LETTERS[i], index: input.dataset.index, text: t.replace(/\s+$/, '') };
    });

    const scope = wrap.parentElement;
    const { images, loading } = collectImages(scope, labels);
    const hasImage = images.length > 0 || /click to enlarge/i.test(scope.innerText);

    const type = labels[0].querySelector('input').type === 'checkbox' ? 'checkbox' : 'radio';
    return { num: header.current, total: header.total, text, options, type, hasImage, images, imagesLoading: loading };
  }

  // Content images (not icons) in the question body and inside options. The site also keeps hidden
  // copies for its lightbox, so prefer visible images and de-duplicate by URL.
  function collectImages(scope, labels) {
    const all = [...scope.querySelectorAll('img')].filter((img) => img.currentSrc || img.src);
    const loading = all.some((img) => !img.complete);
    const isContent = (img) => img.naturalWidth >= 60 && img.naturalHeight >= 60;
    const visible = (img) => img.getBoundingClientRect().width > 0;
    const pick = (imgs) => {
      const content = imgs.filter(isContent);
      const shown = content.filter(visible);
      const seen = new Set();
      return (shown.length ? shown : content).filter((img) => {
        const url = img.currentSrc || img.src;
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
    };
    const images = [];
    for (const img of pick(all.filter((img) => !img.closest('label')))) {
      images.push({ where: 'question', url: img.currentSrc || img.src });
    }
    labels.forEach((l, i) => {
      for (const img of pick([...l.querySelectorAll('img')])) {
        images.push({ where: 'option', letter: LETTERS[i], url: img.currentSrc || img.src });
      }
    });
    return { images, loading };
  }

  // The site swaps in a loading skeleton and fetches each question after navigation, so only
  // accept a read once two snapshots taken 100ms apart are identical and have real content.
  async function readStableQuestion(n, timeout = 8000) {
    const start = Date.now();
    let prev = null;
    while (Date.now() - start < timeout) {
      const q = readCurrentQuestion();
      const ok = q && q.num === n && q.text && !q.imagesLoading &&
        (q.hasImage || q.options.every((o) => o.text));
      const snap = ok ? JSON.stringify(q) : null;
      if (snap && snap === prev) return q;
      prev = snap;
      await sleep(100);
    }
    return readCurrentQuestion();
  }

  async function goTo(n) {
    for (let guard = 0; guard < 200; guard++) {
      const h = await waitFor(readHeader, 15000); // header is absent while the question loads
      if (!h) throw new Error('Could not find the question header on the page');
      if (h.current === n) {
        await waitFor(() => optionLabels().length > 0 || answerBox());
        await sleep(40); // let React finish rendering the question body
        return;
      }
      const btn = findButton(h.current < n ? /^next$/i : /^previous$/i);
      if (!btn || btn.disabled) throw new Error(`Cannot navigate to question ${n}`);
      btn.click();
      await waitFor(() => readHeader()?.current !== h.current, 5000);
    }
    throw new Error(`Navigation to question ${n} timed out`);
  }

  function markedChoice() {
    const el = document.querySelector('label [data-marked-choice]');
    const v = el?.getAttribute('data-marked-choice');
    return v && v !== 'NaN' ? v : null;
  }

  async function typeAnswer(value) {
    const box = answerBox();
    if (!box) return false;
    const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    box.focus();
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.blur();
    await sleep(400);
    return answerBox()?.value === value;
  }

  async function selectAnswer(q, answer) {
    if (q.type === 'text') return typeAnswer(answer);
    const letters = answer.split(',');
    const labels = optionLabels();
    const targets = letters.map((l) => labels[LETTERS.indexOf(l)]).filter(Boolean);
    if (targets.length !== letters.length) throw new Error(`Option ${answer} not found on Q${q.num}`);

    if (q.type === 'radio') {
      const wantIndex = targets[0].querySelector('input').dataset.index;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (markedChoice() === wantIndex) return true;
        (attempt < 2 ? targets[0] : targets[0].querySelector('input')).click();
        if (await waitFor(() => markedChoice() === wantIndex, 1500)) return true;
      }
      return false;
    }

    // Checkbox: toggle to match the desired set.
    const want = new Set(targets);
    for (const l of labels) {
      const input = l.querySelector('input');
      if (input.checked !== want.has(l)) { l.click(); await sleep(120); }
    }
    return labels.every((l) => l.querySelector('input').checked === want.has(l));
  }

  async function setReviewMark(on) {
    const mark = findButton(/^mark for review$/i);
    const unmark = findButton(/^unmark$/i);
    if (on && mark) { mark.click(); await sleep(150); }
    if (!on && unmark) { unmark.click(); await sleep(150); }
  }

  // ---------- UI ----------

  let host, root, state = { running: false, questions: [], results: {}, log: {} };

  function ensureUI() {
    if (host) {
      host.style.display = isQuizPage() ? '' : 'none';
      root.querySelector('.wrap')?.classList.toggle('idle', !state.running);
      return;
    }
    if (!isQuizPage()) return;
    host = document.createElement('div');
    host.id = 'nqs-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 20px; bottom: 90px; z-index: 2147483647; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; }
        .fab { background: #111; color: #fff; border: 0; border-radius: 999px; padding: 11px 18px; font-weight: 600; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: width .16s ease, height .16s ease, border-radius .16s ease; }
        .fab:disabled { opacity: .6; cursor: default; }
        .wrap.idle:not(:hover):not(:focus-within) .panel { display: none !important; }
        .wrap.idle:not(:hover):not(:focus-within) .fab:not(.stopq) { width: 50px; height: 50px; padding: 0; border-radius: 50%; font-size: 0; display: inline-grid; place-items: center; }
        .wrap.idle:not(:hover):not(:focus-within) .fab:not(.stopq)::before { content: '⚡'; font-size: 23px; }
        .panel { width: 360px; max-height: 60vh; overflow: auto; background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); margin-bottom: 10px; }
        .panel[hidden] { display: none; }
        .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600; position: sticky; top: 0; background: #fff; }
        .head button { border: 0; background: none; cursor: pointer; font-size: 16px; color: #666; }
        .status { padding: 8px 12px; color: #555; border-bottom: 1px solid #f2f2f2; }
        .q { padding: 8px 12px; border-bottom: 1px solid #f4f4f4; }
        .row { display: flex; gap: 8px; align-items: center; }
        .num { font-weight: 600; width: 34px; }
        .ans { font-weight: 700; font-size: 14px; min-width: 28px; }
        .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #eee; color: #444; }
        .high { background: #dcf5e3; color: #146c2e; }
        .medium { background: #fff1cc; color: #8a5a00; }
        .low, .none, .image { background: #fde2e1; color: #a1261f; }
        .sub { color: #777; font-size: 11.5px; margin-top: 2px; word-break: break-word; }
        details summary { cursor: pointer; color: #555; font-size: 11.5px; margin-top: 3px; }
        pre { white-space: pre-wrap; font-size: 11.5px; background: #fafafa; padding: 6px; border-radius: 6px; max-height: 220px; overflow: auto; }
        .go { border: 1px solid #ddd; background: #fff; border-radius: 6px; font-size: 11px; cursor: pointer; margin-left: auto; }
        a { color: #2457d6; cursor: pointer; }
      </style>
      <div class="wrap">
        <div class="panel" hidden>
          <div class="head"><span>Quiz Solver</span><button class="close" title="Hide">×</button></div>
          <div class="status">Ready.</div>
          <div class="list"></div>
        </div>
        <button class="fab stopq" hidden style="background:#fff;color:#111;border:1px solid #ccc;margin-right:6px">Stop</button><button class="fab">⚡ Solve quiz</button>
      </div>`;
    document.documentElement.appendChild(host);
    root.querySelector('.wrap').classList.add('idle');
    root.querySelector('.fab:not(.stopq)').addEventListener('click', () => { localStorage.removeItem(STOP_KEY); run(); });
    root.querySelector('.stopq').addEventListener('click', () => {
      localStorage.setItem(STOP_KEY, '1');
      window.__nqsRun?.stop();
      setStatus('<b>Stopped.</b>');
    });
    root.querySelector('.close').addEventListener('click', () => { root.querySelector('.panel').hidden = true; });
  }

  const $ = (sel) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const setStatus = (msg) => { $('.status').innerHTML = msg; };

  function render() {
    const list = $('.list');
    list.innerHTML = state.questions.map((q) => {
      const r = state.results[q.num];
      const log = state.log[q.num] || [];
      let badge = '<span class="pill">queued</span>';
      let ans = '–';
      if (r) {
        ans = r.answer || '?';
        badge = r.skipped
          ? '<span class="pill low">skipped</span>'
          : `<span class="pill ${r.confidence}">${r.confidence === 'none' ? 'failed' : r.confidence}</span>`;
        if (r.filled === false) badge += ' <span class="pill low">not filled</span>';
      } else if (log.length) badge = '<span class="pill">solving…</span>';
      const meta = r?.votes?.length
        ? `${r.votes[0].model}${r.via === 'transcribe' ? ' (from image transcription)' : ''} · ${r.seconds}s${r.selfConf != null ? ` · model confidence ${r.selfConf}%` : ''}`
        : '';
      const lastMsg = [...log].reverse().find((l) => l.msg)?.msg;
      return `<div class="q">
        <div class="row"><span class="num">Q${q.num}</span>${q.hasImage ? '<span title="Image question">🖼</span>' : ''}<span class="ans">${esc(ans)}</span>${badge}<button class="go" data-n="${q.num}">Go</button></div>
        <div class="sub">${esc(q.text.slice(0, 90))}${q.text.length > 90 ? '…' : ''}</div>
        ${meta ? `<div class="sub">${esc(meta)}</div>` : ''}
        ${r?.error ? `<div class="sub">${esc(r.error)}</div>` : !r && lastMsg ? `<div class="sub">${esc(lastMsg)}</div>` : ''}
        ${r?.errors?.length ? `<details><summary style="color:#a1261f">${r.errors.length} failed call(s)</summary><pre>${esc([...new Set(r.errors)].join('\n\n'))}</pre></details>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.go').forEach((b) => b.addEventListener('click', () => goTo(+b.dataset.n).catch(() => {})));
  }

  // ---------- Main flow ----------

  // Streaming solver connection: send questions one by one as they are read; results arrive whenever ready.
  function openSolver() {
    const port = chrome.runtime.connect({ name: 'solver' });
    const keepAlive = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch {} }, 20000);
    const waiters = [];
    const solver = { error: null, done: false, sent: 0, version: 0 };
    const wake = () => { solver.version++; while (waiters.length) waiters.shift()(); };

    const close = () => { clearInterval(keepAlive); try { port.disconnect(); } catch {} };
    port.onMessage.addListener((msg) => {
      if (msg.type === 'progress') {
        if (msg.num) (state.log[msg.num] ||= []).push(msg);
        if (msg.stage === 'models') state.modelInfo = msg.msg;
        render();
      } else if (msg.type === 'result') {
        state.results[msg.result.num] = msg.result;
        render();
        wake();
      } else if (msg.type === 'done') {
        solver.done = true; close(); wake();
      } else if (msg.type === 'error') {
        solver.error = new Error(msg.msg); close(); wake();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!solver.done && !solver.error) solver.error = new Error('Solver disconnected. Reload the page and try again.');
      clearInterval(keepAlive); wake();
    });

    solver.send = (q) => { solver.sent++; port.postMessage({ type: 'question', question: q }); };
    solver.end = () => { try { port.postMessage({ type: 'end' }); } catch {} };
    // Resolves once anything has arrived since `seenVersion` (no lost wake-ups).
    solver.next = (seenVersion) => new Promise((r) => (solver.version !== seenVersion ? r() : waiters.push(r)));
    return solver;
  }

  async function run() {
    if (state.running) return;
    if (!extensionAlive()) {
      // The extension was reloaded/updated; this script is orphaned. A page reload injects a fresh one.
      location.reload();
      return;
    }
    state = { running: true, questions: [], results: {}, log: {} };
    $('.wrap').classList.remove('idle');
    const fab = $('.fab:not(.stopq)');
    fab.disabled = true;
    $('.stopq').hidden = false;
    $('.panel').hidden = false;
    try {
      const h = readHeader();
      if (!h) throw new Error('No quiz question found. Start the test first.');

      const started = Date.now();
      const solver = openSolver();

      // Phase 1: read questions; each text question is sent to the solver the moment it is read,
      // so answers are being computed while we keep reading.
      for (let n = 1; n <= h.total; n++) {
        let q;
        try {
          await goTo(n);
          q = await readStableQuestion(n);
          if (!q || q.num !== n) throw new Error(`Could not read question ${n}`);
        } catch (e) {
          if (stopRequested() || /no API key|401|403/i.test(e.message)) throw e;
          // An unsupported or malformed question should not prevent the rest of the quiz
          // from being read. Keep a placeholder so the fill phase records it as skipped.
          q = { num: n, total: h.total, text: '', options: [], type: 'unreadable', hasImage: false, images: [] };
          state.questions.push(q);
          state.results[n] = {
            num: n, answer: null, confidence: 'none', skipped: true,
            error: `Skipped Q${n}: ${e.message}`, errors: [], votes: [],
          };
          setStatus(`Could not read Q${n}; skipping it and continuing…`);
          render();
          continue;
        }
        state.questions.push(q);
        if (q.hasImage && !q.images.length) {
          state.results[n] = { num: n, answer: null, confidence: 'none', error: "Image found but couldn't be read from the page", votes: [] };
        } else {
          solver.send(q);
        }
        setStatus(`Reading ${n}/${h.total}… (${Object.keys(state.results).length} solved so far)`);
        render();
      }
      solver.end();

      // Phase 2: click answers as they arrive, always moving to the nearest ready question.
      const toFill = new Set(state.questions.map((q) => q.num));
      const { autoSubmitQuiz } = await chrome.storage.local.get('autoSubmitQuiz');
      const willSubmit = window.__nqsRun?.matchesHere('quiz') || autoSubmitQuiz === true;
      const fillOne = async (q, r) => {
        if (r.skipped) return;
        try {
          await goTo(q.num);
          // Quick identity check (the page is already rendered): same question number and same opening text.
          const onScreen = readCurrentQuestion() || await readStableQuestion(q.num, 3000);
          if (!onScreen || onScreen.num !== q.num || onScreen.text.slice(0, 120) !== q.text.slice(0, 120)) {
            throw new Error(`Q${q.num} on screen doesn't match what was solved; not clicking`);
          }
          if (!r.answer) {
            r.filled = false;
            r.skipped = true;
            if (!willSubmit) await setReviewMark(true);
            return;
          }
          r.filled = await selectAnswer(q, r.answer);
          // Review marks only matter if the user will review before submitting.
          if (!willSubmit) await setReviewMark(!r.filled || r.confidence !== 'high');
        } catch (e) {
          r.filled = false;
          r.error = e.message;
        }
        render();
      };
      while (toFill.size) {
        if (stopRequested()) throw new Error('Stopped by user');
        const seen = solver.version;
        const ready = [...toFill].filter((n) => state.results[n]);
        if (!ready.length) {
          if (solver.error || solver.done) {
            const reason = solver.error?.message || 'Solver returned no answer';
            for (const n of toFill) {
              state.results[n] = {
                num: n, answer: null, confidence: 'none', skipped: true,
                error: `Skipped Q${n}: ${reason}`, errors: [], votes: [],
              };
            }
            render();
            break;
          }
          const waitingImg = [...toFill].some((n) => state.questions[n - 1]?.hasImage);
          setStatus(`Solving… ${Object.keys(state.results).length}/${state.questions.length} done${waitingImg ? ' (image questions take a few seconds longer)' : ''}`);
          await Promise.race([solver.next(seen), new Promise((r) => setTimeout(r, 500))]);
          continue;
        }
        const here = readHeader()?.current || 1;
        ready.sort((a, b) => Math.abs(a - here) - Math.abs(b - here));
        const n = ready[0];
        toFill.delete(n);
        setStatus(`Clicking answer for Q${n}…`);
        await fillOne(state.questions.find((q) => q.num === n), state.results[n]);
      }
      if (!willSubmit) await goTo(1);
      state.seconds = ((Date.now() - started) / 1000).toFixed(1);

      const vals = Object.values(state.results);
      const total = state.questions.length;
      const filled = vals.filter((r) => r.filled).length;
      const high = vals.filter((r) => r.confidence === 'high' && r.filled).length;
      const flagged = total - high;
      const shouldSubmit = willSubmit;
      state.submitted = false;
      if (shouldSubmit && filled === total && total > 0) {
        setStatus('All answers filled. Submitting the quiz…');
        state.submitted = await submitQuiz();
      }
      setStatus(`<b>Done in ${state.seconds}s.</b> Filled ${filled}/${total} questions (${high} high confidence).` +
        (state.submitted ? ' <b>Quiz submitted.</b>'
          : (flagged ? ` <b>${flagged}</b> marked for review, so check those.` : '') +
            `<br><span style="color:#888">${shouldSubmit && filled !== total ? 'Not submitted because some answers are missing.' : 'Not submitted. Review, then press Submit Quiz yourself.'}</span>`));
    } catch (e) {
      const needsKey = /api key|settings|401|403/i.test(e.message);
      setStatus(`<span style="color:#a1261f">${esc(e.message)}</span>` +
        (needsKey ? ' <a class="opt">Open settings</a>' : ''));
      root.querySelector('.opt')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
    } finally {
      state.running = false;
      $('.wrap').classList.add('idle');
      fab.disabled = false;
      $('.stopq').hidden = true;
      render();
      if (window.__nqsRun?.matchesHere('quiz')) {
        const vals = Object.values(state.results);
        const filled = vals.filter((r) => r.filled).length;
        window.__nqsRun.advance({ ok: !!state.submitted, summary: `${filled}/${state.questions.length} answers filled${state.submitted ? ', submitted' : ' (not submitted)'}` });
      }
    }
  }

  // Press "Submit Quiz" and confirm. Returns true once the attempt page is gone or shows a submitted state.
  async function submitQuiz() {
    const btn = findButton(/^submit quiz$/i);
    if (!btn) return false;
    btn.click();
    const confirm = await waitFor(() => [...document.querySelectorAll('button')].find((b) =>
      b !== btn && b.getBoundingClientRect().width > 0 && !b.closest('#nqs-host') &&
      /^(submit|yes|confirm|submit quiz|yes,? submit|end test|finish)\b/i.test(b.innerText.trim())), 5000, 200);
    if (confirm) confirm.click();
    return !!(await waitFor(() => !readHeader() || /submitted|your xp|revise|test date/i.test(document.body.innerText.slice(0, 3000)), 20000, 400));
  }

  // Batch run from the semester scanner: open the test from its instructions page, then solve it.
  let batchHandled = null;
  async function batchStep() {
    const RUN = window.__nqsRun;
    if (!RUN?.matchesHere('quiz') || batchHandled === location.pathname || state.running) return;
    batchHandled = location.pathname;
    await sleep(3000);
    if (isQuizPage() && readHeader()) { ensureUI(); await run(); return; }
    const startBtn = [...document.querySelectorAll('button')].find((b) => /^(start|resume|continue)\s*(test|quiz)?$/i.test(b.innerText.trim()));
    if (startBtn) {
      startBtn.click();
      // Some start screens ask for confirmation.
      await sleep(1500);
      [...document.querySelectorAll('button')].find((b) => /^(yes|confirm|start|ok|proceed)\b/i.test(b.innerText.trim()) && b !== startBtn)?.click();
      batchHandled = null;
      return;
    }
    if (/\bRevise\b|Your XP|Test Date/i.test(document.body.innerText)) { RUN.advance({ ok: true, summary: 'already attempted' }); return; }
    batchHandled = null; // page still loading; try again next tick
  }

  // Next.js navigates client-side, so watch the URL.
  ensureUI();
  let lastPath = location.pathname;
  const timer = setInterval(() => {
    if (!extensionAlive()) {
      // Orphaned by an extension reload: clicking the button will reload the page.
      clearInterval(timer);
      if (host && !state.running) root.querySelector('.fab:not(.stopq)').textContent = '↻ Reload to use solver';
      return;
    }
    if (location.pathname !== lastPath) { lastPath = location.pathname; }
    ensureUI();
    batchStep();
  }, 1000);
})();
