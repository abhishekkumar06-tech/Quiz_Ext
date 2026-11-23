// Background side of the coding-assignment solver.
// - Generates / fixes code with the LLMs.
// - Reads and writes the two workspace types by running functions in the page's MAIN world:
//     * Jupyter notebook (iframe on *.edison-jupyter.newtonschool.co) via window.Jupyter
//     * Code playground (Verilog/Python/...) via window.monaco
import { chat } from './llm.js';

const CODE_SYSTEM = `You are an expert solving an auto-graded programming or database assignment (Python, Verilog, SQL, MongoDB, or similar).
Rules:
- Hidden tests run with DIFFERENT inputs/config than any visible defaults. Never hard-code values or expected outputs.
- Keep every required function name, signature, module name and port name exactly as specified.
- Only use libraries and database features the problem allows.
- Follow the MODE section exactly (function-only vs full program). Never import sys.
- Always return the COMPLETE file, never a partial snippet.
- Output ONLY the complete replacement code for the editable region, in a single fenced code block. No explanation.`;

// "### CELL 5 ```python ... ```" blocks -> {5: code}
function extractCells(text) {
  const out = {};
  for (const m of text.matchAll(/CELL\s*(\d+)[^\n]*\n+```[\w+-]*\n([\s\S]*?)```/gi)) out[m[1]] = m[2].replace(/\s+$/, '');
  return Object.keys(out).length ? out : null;
}

function extractCode(text) {
  const blocks = [...text.matchAll(/```[\w+-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].replace(/\s+$/, '') + '\n';
  return text.trim() ? text.trim() + '\n' : null;
}

function buildPrompt(job) {
  const parts = [];
  parts.push(`## Problem statement\n${job.problem}`);
  if (job.kind === 'jupyter-multi') {
    parts.push(`## Notebook cells (in order). Cells marked EDITABLE contain blanks like ____ or TODOs that you must complete. Read-only cells run as-is and must work with your code.\n${job.context}`);
    parts.push(`## Output format\nReturn the COMPLETE new contents of EVERY editable cell listed below (${job.editableIdx.join(', ')}), each as:\n### CELL <index>\n\`\`\`python\n<full cell code>\n\`\`\`\nFill every blank (no ____ may remain), keep existing comments and structure, follow each cell's instructions, and make the read-only cells after it work. Do not add prints the task doesn't ask for.`);
  } else if (job.kind === 'jupyter') {
    parts.push(`## Notebook (read-only cells are shown for context; you may only replace the EDITABLE cell)\n${job.context}`);
    parts.push(`## Current EDITABLE cell (return its full new contents; keep the function signature and the marker comments)\n\`\`\`python\n${job.editable}\n\`\`\``);
  } else {
    if (job.databaseMode === 'sql') {
      parts.push(`## Database engine: ${job.language}`);
    } else {
      parts.push(`## Language: ${job.language}\n## Starter template (return the full new file, keeping the template's class/function names and signatures)\n\`\`\`\n${job.editable}\n\`\`\``);
    }
    const hdl = /verilog|vhdl|icarus|systemverilog/i.test(job.language || '');
    if (job.databaseMode === 'sql') {
      parts.push(`## MODE: SQL QUERY\nReturn the shortest complete SQL answer that satisfies every explicit requirement. Use the exact table and column names from the problem and the stated database engine; never invent schema. Include multiple statements only when the task explicitly requires them. Add BEGIN/COMMIT/ROLLBACK only when transaction control is explicitly requested. Add a SELECT only when the requested result requires returning or displaying rows; do not add a verification query. Do not add comments, explanations, sample output, or formatting-only statements. Return SQL only.`);
    } else if (job.databaseMode === 'mongodb') {
      parts.push(`## MODE: MONGODB SHELL COMMANDS\nThe editor accepts MongoDB shell commands. MongoDB shell syntax is JavaScript-like, but do not write a general JavaScript program. Return only the MongoDB command(s) the task asks for, such as db.collection.insertOne(...), db.collection.find(...), or db.collection.aggregate([...]). Do not use const/let/var, console.log, JSON.stringify, or wrap commands in a function unless the problem explicitly asks for those. Do not add verification queries or extra operations unless requested. Follow the requested answer shape, collection/field names, and output exactly; do not invent schema.`);
    } else if (hdl) {
      parts.push('## MODE: HARDWARE (Verilog)\nWrite a synthesizable module with EXACTLY the module name and port list from the statement/template. Follow the specified behaviour precisely: reset type and polarity (synchronous vs asynchronous, active-high vs active-low), Moore vs Mealy output timing, overlapping vs non-overlapping detection, bit widths, and when outputs update. No testbench, no $display/$monitor, no input()/stdin. Do not add extra ports.');
    } else if (job.isPython === false) {
      parts.push('## MODE: follow the template\nKeep the template structure; read input and print output only if the statement or template does.');
    } else parts.push(job.functionOnly
      ? '## MODE: FUNCTION-ONLY\nA hidden driver reads the input, calls the template functions, and prints their return values. Implement the functions and RETURN the result in exactly the form the statement describes (e.g. a space-separated string, a list, or a tuple - match what the output example shows). Do NOT call input(), do NOT print, do NOT import sys, and do NOT add a main block or example calls.'
      : '## MODE: FULL PROGRAM\nRead the input from stdin using input() exactly as the Input section describes and print exactly the required output (match the example output format, including decimal places and separators). Never import sys.');
  }
  if (job.history?.length) {
    const history = job.databaseMode ? job.history.slice(-1) : job.history.slice(-3);
    const last = history.map((h, i) =>
      `### Previous attempt ${i + 1} (${h.stage})\n\`\`\`\n${h.code.slice(0, job.databaseMode ? 2500 : 6000)}\n\`\`\`\nResult:\n${h.feedback.slice(0, job.databaseMode ? 1200 : 3000)}`).join('\n\n');
    parts.push(`## Earlier attempts FAILED. Fix the problems below; do not repeat the same mistake.\n${last}`);
  }
  return parts.join('\n\n');
}

async function generateCode(job, settings, onProgress = () => {}) {
  const sqlSystem = `You solve auto-graded SQL tasks. Read the full requirement and database dialect carefully. Produce the minimal correct SQL statements and nothing extra. Preserve required transaction semantics, statement order, exact identifiers, and requested result shape. Never add a transaction wrapper, SELECT, or other statement unless the task asks for it.`;
  const messages = [
    { role: 'system', content: job.databaseMode === 'sql' ? sqlSystem : CODE_SYSTEM },
    { role: 'user', content: buildPrompt(job) },
  ];
  const effort = job.history?.length ? 'high' : 'medium';
  const chain = [];
  if (settings.groqKey && settings.groqModels?.length) {
    // One primary model per provider avoids spending quota walking a long model list.
    chain.push({ provider: 'groq', key: settings.groqKey, models: settings.groqModels.slice(0, 1), reasoning: job.databaseMode && job.history?.length ? 'low' : effort });
  }
  if (settings.geminiKey && settings.geminiModels?.length) {
    chain.push({ provider: 'gemini', key: settings.geminiKey, models: settings.geminiModels.slice(0, 1), reasoning: job.databaseMode && job.history?.length ? 'low' : effort === 'high' ? 'high' : 'low' });
  }
  // Alternate provider families after each graded failure instead of spending two
  // submissions retrying the same model family with only a generic Wrong Answer signal.
  const graded = (job.history || []).filter((h) => /graded submission/.test(h.stage)).length;
  if (graded % 2 === 1 && chain.length > 1) chain.push(chain.shift());
  const errors = [];
  for (const c of chain) {
    try {
      // A slow or rate-limited model should not leave an assignment retry waiting for minutes.
      // Each model gets a bounded request, then the next configured model is tried.
      const providerName = c.provider === 'gemini' ? 'Google Gemini' : 'Groq';
      onProgress(`Attempt ${job.attempt || 1}/5: requesting ${providerName} (${c.models.join(', ')})…`);
      const r = await chat({
        ...c, messages, patient: false, timeoutMs: 15000,
        // SQL can need several expressions/clauses; too small a completion budget can
        // cut a valid-looking response off mid-expression (the grader then says Compilation Error).
        maxTokens: job.databaseMode === 'sql' ? 1800 : job.databaseMode === 'mongodb' ? 1200 : undefined,
        onStatus: (status) => onProgress(`${providerName}: ${status}`),
      });
      onProgress(`Received a response from ${providerName} ${r.model}; checking the generated answer…`);
      if (job.kind === 'jupyter-multi') {
        const cells = extractCells(r.text);
        const missing = job.editableIdx.filter((i) => !cells?.[i]);
        if (cells && !missing.length) return { cells, model: r.model };
        errors.push(`${r.model}: missing cells ${missing.join(', ')}`);
        continue;
      }
      const code = extractCode(r.text);
      if (code) return { code, model: r.model };
      errors.push(`${r.model}: empty code`);
    } catch (e) {
      errors.push(e.message.slice(0, 200));
    }
  }
  throw new Error(errors.length ? `Code generation failed: ${errors.join(' | ')}` : 'No API key configured. Open the extension settings.');
}

// ---------- MAIN-world page functions (must be self-contained) ----------

function pageJupyterRead() {
  const nb = window.Jupyter && window.Jupyter.notebook;
  if (!nb || !nb.get_cells) return null;
  return nb.get_cells().map((c, i) => ({
    i,
    type: c.cell_type,
    text: c.get_text(),
    editable: !(c.metadata && c.metadata.editable === false),
  }));
}

async function pageJupyterWriteRun(code, run) {
  const nb = window.Jupyter && window.Jupyter.notebook;
  if (!nb || !nb.get_cells) return null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = nb.get_cells();
  const editable = all.filter((c) => c.cell_type === 'code' && !(c.metadata && c.metadata.editable === false));
  let target = editable.find((c) => /YOUR CODE HERE/.test(c.get_text())) || editable[0];
  if (!target) return { error: 'No editable code cell found in the notebook' };
  if (code && typeof code === 'object') {
    // Multi-cell (fill-in-the-blanks) notebook: {cellIndex: newText}. Only editable code cells are written.
    for (const [idx, text] of Object.entries(code)) {
      const c = all[Number(idx)];
      if (c && editable.includes(c)) c.set_text(text);
    }
    target = null;
  } else if (code != null) {
    target.set_text(code);
  }

  let timedOut = false;
  if (run) {
    // Fresh kernel so stale definitions from earlier attempts can't hide errors.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        window.Jupyter.notebook.events.one('kernel_ready.Kernel', finish);
        nb.kernel.restart();
      } catch (e) { finish(); }
      setTimeout(finish, 30000);
    });
    await sleep(500);
    nb.clear_all_output();
    nb.execute_all_cells();
    await sleep(1500);
    const start = Date.now();
    for (;;) {
      const running = nb.get_cells().some((c) => c.cell_type === 'code' && c.input_prompt_number === '*');
      if (!running && !nb.kernel_busy) break;
      if (Date.now() - start > 240000) { timedOut = true; break; }
      await sleep(500);
    }
  }
  try { await nb.save_notebook(); } catch (e) { /* the site saves again on submit */ }

  const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  const cells = nb.get_cells().map((c, i) => ({
    i,
    isTarget: c === target,
    head: c.get_text().split('\n')[0].slice(0, 100),
    output: c.cell_type !== 'code' ? '' : ((c.output_area && c.output_area.outputs) || []).map((o) =>
      o.output_type === 'error'
        ? `${o.ename}: ${o.evalue}\n${strip((o.traceback || []).join('\n')).slice(-1500)}`
        : strip(o.text || (o.data && o.data['text/plain']) || '')).join(''),
  }));
  return { cells, timedOut };
}

// The code editor is the TOPMOST visible, editable Monaco editor; the lower panel editor
// (INPUT / OUTPUT / ERROR, depending on the selected tab) sits below it. Size is not reliable:
// after a reset the lower panel can be larger than the code editor.
function pageMonacoRead() {
  const m = window.monaco;
  if (!m) return null;
  const rect = (e) => e.getContainerDomNode().getBoundingClientRect();
  const eds = m.editor.getEditors().filter((e) => e.getModel() && rect(e).width > 0 && rect(e).height > 40);
  const main = eds.filter((e) => !e.getOption(m.editor.EditorOption.readOnly)).sort((a, b) => rect(a).top - rect(b).top)[0];
  if (!main) return null;
  const lower = eds.filter((e) => e !== main && rect(e).top > rect(main).top).sort((a, b) => rect(a).top - rect(b).top)[0];
  return { code: main.getValue(), language: main.getModel().getLanguageId(), lower: lower ? lower.getValue() : '' };
}

function pageMonacoWrite(code, target) {
  const m = window.monaco;
  if (!m) return { ok: false, reason: 'editor not loaded' };
  const rect = (e) => e.getContainerDomNode().getBoundingClientRect();
  const eds = m.editor.getEditors().filter((e) => e.getModel() && rect(e).width > 0 && rect(e).height > 40);
  const main = eds.filter((e) => !e.getOption(m.editor.EditorOption.readOnly)).sort((a, b) => rect(a).top - rect(b).top)[0];
  const ed = target === 'lower'
    ? eds.filter((e) => e !== main && main && !e.getOption(m.editor.EditorOption.readOnly) && rect(e).top > rect(main).top)
      .sort((a, b) => rect(a).top - rect(b).top)[0]
    : main;
  if (!ed) return { ok: false, reason: `no ${target === 'lower' ? 'input' : 'code'} editor found` };
  const norm = (s) => String(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  // executeEdits fires the normal change events, so the site's own state picks up the new text.
  ed.executeEdits('newton-solver', [{ range: ed.getModel().getFullModelRange(), text: code, forceMoveMarkers: true }]);
  ed.pushUndoStop();
  if (norm(ed.getValue()) === norm(code)) return { ok: true };
  ed.getModel().setValue(code);
  if (norm(ed.getValue()) === norm(code)) return { ok: true, via: 'setValue' };
  return { ok: false, reason: `editor holds ${ed.getValue().length} chars, expected ${code.length}` };
}


// Semester scanner: collect pending items from the current subject's Assignments or Quiz tab.
// Runs in MAIN world so it can intercept the site's window.open() calls to learn each item's URL.
async function pageCollect(kind) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasScore = (d) => /\d+\s*\/\s*\d+/.test(d.innerText || '');
  // The portal uses React's delegated event handlers, so clickable rows do not have a DOM
  // `onclick` property. Older scanner builds consequently saw zero rows. Start at each status
  // icon and walk up to the first compact, score-bearing table row instead. This avoids both
  // generated class names and inherited cursor styles (which make deeply nested children look
  // clickable too).
  const statusImages = () => [...document.querySelectorAll('img')].filter((img) => {
    const src = img.getAttribute('src') || '';
    return /^status$/i.test(img.getAttribute('alt') || '') ||
      /questionStatus|verified|status[-_]?icon|\/tick\.svg/i.test(src);
  });
  const itemRows = () => {
    const rows = statusImages().map((img) => {
      let row = img.parentElement;
      while (row) {
        const text = row.innerText || '';
        if (row.tagName === 'DIV' && row.children.length >= 3 && text.length < 2000 && hasScore(row)) return row;
        row = row.parentElement;
      }
      return null;
    }).filter(Boolean);
    return [...new Set(rows)];
  };
  const quizRows = () => itemRows().filter((row) => {
    const lead = row.querySelector('p');
    const status = row.querySelector('img[alt="status"], img[src*="status" i]');
    return !!lead && !!status;
  });
  // Pending quiz = no green tick and 0 XP earned (not attempted, or started but never submitted).
  const quizPending = (row) => {
    const src = row.querySelector('img[alt="status"], img[src*="status" i]')?.getAttribute('src') || '';
    const green = /a9b7146bd5574b0cb3966bbb00b96033|verified/i.test(src) || !!row.querySelector('path[fill="#009965"]');
    const m = row.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    return !green && m && Number(m[1]) === 0;
  };
  // Quiz rows call a helper that captured window.open when the React bundle initialized, so
  // replacing window.open later cannot observe their destination. The row component already
  // carries the assessment and subject hashes; read those props in MAIN world and build the same
  // /instructions URL its click handler uses. Keep click interception as a fallback for old pages.
  const quizMeta = (row) => {
    const fiberKey = Object.getOwnPropertyNames(row).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let i = 0; fiber && i < 8; i++, fiber = fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        const a = props?.assessment;
        if (a?.hash && a.course?.hash) {
          return {
            hash: a.hash,
            courseHash: a.course.hash,
            subject: a.course.short_display_name || a.course.title,
            title: a.title,
          };
        }
      }
    }
    return null;
  };
  // The page header shows "41/45 Solved": the number of pending items is known up front.
  const solvedMatch = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)\s*Solved/i);
  // The current portal briefly (and sometimes permanently) renders 0/0 even while rows exist.
  // Treat that as unknown so infinite-scroll discovery still runs.
  const expectedPending = solvedMatch && Number(solvedMatch[2]) > 0
    ? Number(solvedMatch[2]) - Number(solvedMatch[1])
    : null;
  const scrollerOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
    }
    return document.scrollingElement;
  };
  // Infinite scroll: keep scrolling the list's container until everything needed is loaded.
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 4; i++) {
    const rows = kind === 'Quiz' ? quizRows() : itemRows();
    if (kind === 'Quiz' && expectedPending != null && rows.filter(quizPending).length >= expectedPending) break;
    if (kind === 'Quiz' && expectedPending === 0) break;
    const sc = scrollerOf(rows[rows.length - 1] || document.body);
    sc.scrollTop = sc.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1000);
    const n = (kind === 'Quiz' ? quizRows() : itemRows()).length;
    stable = n === last ? stable + 1 : 0;
    last = n;
  }

  const opened = [];
  const origOpen = window.open;
  window.open = (u) => { opened.push(String(u)); return null; };
  const urlFor = async (el) => {
    const before = opened.length;
    el.click();
    await sleep(350);
    return opened.length > before ? new URL(opened[opened.length - 1], location.origin).href : null;
  };
  const items = [];
  try {
    if (kind === 'Assignments') {
      // Each assignment is now a card: metadata containing "Release - …", followed by one or
      // more clickable question rows.  Find the smallest ancestor joining those two pieces.
      const releases = [...document.querySelectorAll('*')].filter((e) => /^Release\s*-/.test((e.innerText || '').trim()) &&
        ![...e.children].some((c) => /^Release\s*-/.test((c.innerText || '').trim())));
      const allRows = itemRows();
      for (const release of releases) {
        let card = release.parentElement;
        while (card && !allRows.some((row) => card.contains(row))) card = card.parentElement;
        if (!card) continue;

        const header = release.parentElement;
        const subject = header.querySelector('p')?.innerText.trim() || 'Other';
        // The assignment name is the non-date span beside the release metadata.  It still opens
        // the assignment in a new tab, although the portal no longer styles it with cursor:pointer.
        const titleEl = [...header.querySelectorAll('span')].find((sp) => {
          const text = sp.innerText.trim();
          return sp !== release && text.length > 2 && !/^(Release|Deadline)\s*-/i.test(text);
        });
        if (!titleEl) continue;
        const qRows = allRows.filter((row) => card.contains(row) && row.querySelector('img'));
        // Status icon "file-verified-status-icon" = Completed. Everything else (not attempted / attempted) is unsolved.
        const unsolved = qRows.filter((r) =>
          ![...r.querySelectorAll('img')].some((img) => /verified|file-verified-status-icon/i.test(img.getAttribute('src') || '')) &&
          !r.querySelector('path[fill="#009965"]'));
        if (!unsolved.length) continue;
        const url = await urlFor(titleEl);
        if (url) {
          items.push({
            kind: 'assignment', subject, title: titleEl.innerText.trim(), url,
            pending: unsolved.length, total: qRows.length,
            pendingTitles: unsolved.map((r) => r.innerText.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''),
          });
        }
      }
    } else {
      const rows = quizRows();
      let found = 0;
      for (const row of rows) {
        if (expectedPending != null && found >= expectedPending) break;
        const lines = row.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
        // Completed quizzes show the green tick. A grey tick with XP > 0 is a submitted attempt (counts as solved).
        // Pending = no green tick and 0 XP earned: not attempted, or started but never submitted.
        if (!quizPending(row)) continue;
        const meta = quizMeta(row);
        const url = meta
          ? `${location.origin}/course/${meta.courseHash}/assessment/${meta.hash}/instructions`
          : await urlFor(row);
        if (url) {
          items.push({ kind: 'quiz', subject: meta?.subject || lines[0], title: meta?.title || lines[1] || lines[0], url });
          found++;
        }
      }
    }
  } finally {
    window.open = origOpen;
  }
  return items;
}

// Assignment question cards open their playground in a new tab. Capture that destination
// before the batch runner chooses whether to navigate this tab to it.
async function pageQuestionUrl(questionNumber) {
  const label = [...document.querySelectorAll('span,div,p')].find((e) =>
    new RegExp(`^Q${questionNumber}\\.?$`).test((e.innerText || '').trim()) &&
    ![...e.children].some((c) => new RegExp(`^Q${questionNumber}`).test(c.innerText || '')));
  if (!label) return null;
  let card = label;
  let button = null;
  for (let i = 0; i < 10 && card && !button; i++, card = card.parentElement) {
    button = [...card.querySelectorAll('button')].find((b) => /submission|solve|start|attempt|continue|open|complete|resume|retry|practice|begin/i.test(b.innerText.trim()));
  }
  if (!button) return null;

  const opened = [];
  const originalOpen = window.open;
  try {
    window.open = (url) => { opened.push(String(url)); return null; };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    window.open = originalOpen;
  }
  const url = opened.at(-1);
  if (!url) return null;
  try { return new URL(url, location.origin).href; } catch { return null; }
}

async function runInPage(tabId, func, args = [], allFrames = false) {
  const results = await chrome.scripting.executeScript({
    target: allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
    world: 'MAIN',
    func,
    args,
  });
  const hit = results.find((r) => r.result != null);
  return hit ? hit.result : null;
}

// ---------- Message handler ----------

export async function handleAssignmentMessage(msg, sender, getSettings) {
  const tabId = sender.tab?.id;
  switch (msg.op) {
    case 'generate':
      return generateCode(msg.job, await getSettings(), (text) => {
        if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'asg-progress', text }).catch(() => {});
      });
    case 'jupyter.read':
      return runInPage(tabId, pageJupyterRead, [], true);
    case 'jupyter.writeRun':
      return runInPage(tabId, pageJupyterWriteRun, [msg.code ?? null, !!msg.run], true);
    case 'scan.collect':
      return runInPage(tabId, pageCollect, [msg.kind]);
    case 'assignment.questionUrl':
      return runInPage(tabId, pageQuestionUrl, [msg.question]);
    case 'monaco.read':
      return runInPage(tabId, pageMonacoRead);
    case 'monaco.write':
      return runInPage(tabId, pageMonacoWrite, [msg.code, msg.target || 'main']);
    default:
      throw new Error(`Unknown op ${msg.op}`);
  }
}

export const _test = { extractCode, buildPrompt };
