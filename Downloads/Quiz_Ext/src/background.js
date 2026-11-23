import { chat, pickModels, MODELS_VERSION, loadExhausted, setExhaustedListener } from './llm.js';
import { handleAssignmentMessage } from './assignment-bg.js';

// Kept short on purpose: prompt tokens count against Groq's per-minute token limit.
// The model still thinks internally (reasoning_effort); the visible reply is just the answer.
const SYSTEM_PROMPT = `Expert at CS, programming and math MCQs. Think carefully: trace code exactly (indentation, integer division, scope/hoisting, event loop order, recursion), check every option, watch for NOT/EXCEPT.
Reply with ONLY these two lines:
FINAL ANSWER: <letter>
CONFIDENCE: <0-100>
For multi-select give comma-separated letters. For fill-in-the-blank questions put the exact answer value instead of a letter.`;

const IMAGE_NOTE = 'The question refers to the image(s) below. Read every node, label, number, edge, arrow and table cell exactly before answering.';

// Used by the backup path: a vision model transcribes, a text model solves.
const DESCRIBE_PROMPT = `Transcribe this image exactly so someone who cannot see it can solve a quiz question about it.
If it is a tree or graph: list every node value, then every edge as "parent -> child (left/right)" in top-to-bottom, left-to-right order, and note the root.
If it is a recursion tree: list every call node with its arguments/return value and its children, including placeholders like ?a.
If it is a table, array, code, or formula: reproduce it exactly as text.
Do not solve anything. Output only the transcription.`;

function formatQuestion(q) {
  if (q.type === 'text') {
    return `${q.text}\n(Fill-in-the-blank: no options. Give the exact value to type in the answer box. If the answer is a number, give only the number with no units or words; give an integer without decimals when the answer is a whole number; otherwise use the precision the question asks for.)`;
  }
  const kind = q.type === 'checkbox' ? '(Select ALL correct options.)' : '(One correct option.)';
  const opts = q.options.map((o) => `${o.letter}) ${o.text || '[see image]'}`).join('\n');
  return `${q.text}\n${kind}\n${opts}`;
}

function parseTextAnswer(text) {
  const m = [...text.matchAll(/FINAL ANSWER\**\s*[:\-]\s*\**\s*(.+)/gi)].pop();
  if (!m) return null;
  let v = m[1].replace(/\*\*/g, '').replace(/^[`"']+|[`"']+$/g, '').trim().replace(/\.$/, '').trim();
  // Numeric cleanup: "6 bits" -> "6", "6.0" -> "6", "1,024" -> "1024".
  const num = v.replace(/,/g, '').match(/^-?\d+(\.\d+)?(?=\s*[a-zA-Z%]*$)/);
  if (num) v = Number(num[0]) % 1 === 0 && !/\.\d*[1-9]/.test(num[0]) ? String(parseInt(num[0], 10)) : num[0];
  return v || null;
}

function parseAnswer(text, q) {
  if (q.type === 'text') return parseTextAnswer(text);
  const valid = new Set(q.options.map((o) => o.letter));
  const matches = [...text.matchAll(/FINAL ANSWER\**\s*[:\-]\s*\**\s*\(?([A-Z]\)?(?:\s*(?:,|and|&)\s*\(?[A-Z]\)?)*)/gi)];
  if (!matches.length) return null;
  const letters = matches[matches.length - 1][1].replace(/\band\b/gi, ',').toUpperCase().match(/[A-Z]/g) || [];
  const uniq = [...new Set(letters)].filter((l) => valid.has(l)).sort();
  if (!uniq.length) return null;
  if (q.type !== 'checkbox' && uniq.length !== 1) return null;
  return uniq.join(',');
}

function parseConfidence(text) {
  const m = [...text.matchAll(/CONFIDENCE\**\s*[:\-]\s*\**\s*(\d{1,3})/gi)].pop();
  return m ? Math.min(100, Number(m[1])) : null;
}

const confidenceLabel = (c) => (c == null ? 'medium' : c >= 90 ? 'high' : c >= 70 ? 'medium' : 'low');

// Remember exhausted daily quotas across service-worker restarts.
setExhaustedListener((map) => chrome.storage.local.set({ exhaustedModels: map }));

async function getSettings() {
  const s = await chrome.storage.local.get(['geminiKey', 'groqKey', 'thinking', 'reviewImages', 'geminiModels', 'groqModels', 'modelsVersion', 'exhaustedModels']);
  loadExhausted(s.exhaustedModels);
  const stale = s.modelsVersion !== MODELS_VERSION;
  if (s.geminiKey && (stale || !s.geminiModels?.length)) {
    s.geminiModels = await pickModels('gemini', s.geminiKey).catch(() => []);
  }
  if (s.groqKey && (stale || !s.groqModels?.length)) {
    s.groqModels = await pickModels('groq', s.groqKey);
  }
  await chrome.storage.local.set({ geminiModels: s.geminiModels || [], groqModels: s.groqModels || [], modelsVersion: MODELS_VERSION });
  return { ...s, thinking: s.thinking || 'medium', reviewImages: s.reviewImages !== false };
}

// Text questions: Groq first (fast, generous limits); Gemini only as a last resort to save its image quota.
function buildSolverChain(s) {
  const chain = [];
  if (s.groqKey && s.groqModels?.length) {
    chain.push({ provider: 'groq', key: s.groqKey, models: [s.groqModels[0]] });
    if (s.groqModels.length > 1) chain.push({ provider: 'groq', key: s.groqKey, models: s.groqModels.slice(1) });
  }
  if (s.geminiKey && s.geminiModels?.length) {
    chain.push({ provider: 'gemini', key: s.geminiKey, models: s.geminiModels });
  }
  return chain;
}

const shortErr = (e) => e.replace(/\s+/g, ' ').slice(0, 200);

// ---------- Images ----------

// Re-encode with Chrome's decoder: some quiz PNGs are slightly malformed (browsers show them, strict
// APIs reject them), and transparent backgrounds can turn black lines invisible. Output: white-backed PNG.
async function normalizeImage(blob) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return blob;
  }
}

async function toDataUrl(img) {
  if (img.dataUrl) return img.dataUrl;
  const res = await fetch(img.url);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  const blob = await normalizeImage(await res.blob());
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

function imageParts(q, dataUrls) {
  const parts = [{ type: 'text', text: `${formatQuestion(q)}\n${IMAGE_NOTE}` }];
  q.images.forEach((img, i) => {
    parts.push({ type: 'text', text: img.where === 'option' ? `Image for option ${img.letter}:` : 'Question image:' });
    parts.push({ type: 'image_url', image_url: { url: dataUrls[i] } });
  });
  return parts;
}

function finish(q, r, answer, started, errors, s, via) {
  const selfConf = parseConfidence(r.text);
  let confidence = confidenceLabel(selfConf);
  // Image answers are marked for review (configurable) until they've proven reliable.
  if (s.reviewImages && q.images?.length && confidence === 'high') confidence = 'medium';
  return {
    num: q.num, answer, confidence, selfConf, errors, image: !!q.images?.length, via,
    votes: [{ model: r.model, answer }],
    seconds: ((Date.now() - started) / 1000).toFixed(1),
  };
}

async function solveImageQuestion(q, s, report) {
  const status = (msg) => report({ num: q.num, stage: 'status', msg });
  const errors = [];
  const started = Date.now();

  status('Downloading image…');
  let dataUrls;
  try {
    dataUrls = await Promise.all(q.images.map(toDataUrl));
  } catch (e) {
    return { num: q.num, answer: null, confidence: 'none', image: true, error: e.message, errors: [e.message], votes: [] };
  }

  const viaGemini = async () => {
    status('Gemini is reading the image…');
    const r = await chat({
      provider: 'gemini', key: s.geminiKey, models: s.geminiModels, onStatus: status, reasoning: s.thinking === 'high' ? 'high' : 'low',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: imageParts(q, dataUrls) }],
    });
    const answer = parseAnswer(r.text, q);
    if (!answer) throw new Error(`${r.model}: no parseable FINAL ANSWER`);
    return finish(q, r, answer, started, errors, s, 'gemini');
  };

  // Backup: Qwen (vision, Groq) transcribes each image, then gpt-oss solves from the transcription.
  // Qwen models on Groq accept images; allow only ~1K output tokens/min, so cap transcription length.
  const visionModels = s.groqKey ? (s.groqModels || []).filter((m) => /qwen/i.test(m)) : [];
  const vision = visionModels.length > 0;
  const viaTranscription = async () => {
    const transcripts = [];
    for (const [i, img] of q.images.entries()) {
      status(`Backup: transcribing image ${i + 1}/${q.images.length}…`);
      const d = await chat({
        provider: 'groq', key: s.groqKey, models: visionModels, reasoning: 'default', maxTokens: 900, onStatus: status,
        messages: [{ role: 'user', content: [{ type: 'text', text: DESCRIBE_PROMPT }, { type: 'image_url', image_url: { url: dataUrls[i] } }] }],
      });
      transcripts.push(`${img.where === 'option' ? `Image for option ${img.letter}` : 'Question image'} (transcribed):\n${d.text.trim()}`);
    }
    status('Backup: solving from transcription…');
    const text = `${formatQuestion(q)}\n\n${transcripts.join('\n\n')}`;
    const main = buildSolverChain(s).find((c) => c.provider === 'groq');
    const r = await chat({ ...main, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }], reasoning: s.thinking, onStatus: status });
    const answer = parseAnswer(r.text, q);
    if (!answer) throw new Error(`${r.model}: no parseable FINAL ANSWER`);
    const res = finish(q, r, answer, started, errors, s, 'transcribe');
    if (res.confidence === 'high') res.confidence = 'medium'; // transcription can miss details
    return res;
  };

  const record = (e) => { errors.push(shortErr(e.message)); throw e; };
  const hasGemini = s.geminiKey && s.geminiModels?.length;

  // Gemini first. If it fails, or hasn't answered within 6s (overloaded), start the backup
  // in parallel and take whichever answer arrives first.
  if (hasGemini && vision) {
    const gemini = viaGemini().catch(record);
    const backupAfterDelay = new Promise((resolve, reject) => {
      let started = false;
      const start = () => { if (!started) { started = true; viaTranscription().catch(record).then(resolve, reject); } };
      const timer = setTimeout(start, 6000);
      gemini.catch(() => { clearTimeout(timer); start(); });
      gemini.then(() => clearTimeout(timer), () => {});
    });
    try { return await Promise.any([gemini, backupAfterDelay]); } catch {}
  } else if (hasGemini) {
    try { return await viaGemini(); } catch (e) { errors.push(shortErr(e.message)); }
  } else if (vision) {
    try { return await viaTranscription(); } catch (e) { errors.push(shortErr(e.message)); }
  }

  return {
    num: q.num, answer: null, confidence: 'none', image: true, errors, votes: [],
    error: errors[0] || 'Image questions need a Gemini key (or a Groq account with a Qwen vision model).',
  };
}

// ---------- Text ----------

// One API call per question. Fallback models are tried only if the call errors or gives no answer.
async function solveTextQuestion(q, s, report) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: formatQuestion(q) },
  ];
  const status = (msg) => report({ num: q.num, stage: 'status', msg });
  const chain = buildSolverChain(s);
  const errors = [];
  const started = Date.now();

  for (const [i, j] of chain.entries()) {
    try {
      const r = await chat({ ...j, messages, reasoning: s.thinking, onStatus: status, patient: i === chain.length - 1 });
      const answer = parseAnswer(r.text, q);
      if (!answer) { errors.push(`${r.model}: no parseable FINAL ANSWER`); continue; }
      return finish(q, r, answer, started, errors, s, j.provider);
    } catch (e) {
      errors.push(shortErr(e.message));
      report({ num: q.num, stage: 'vote-error', msg: shortErr(e.message) });
    }
  }
  return { num: q.num, answer: null, confidence: 'none', error: errors[0] || 'No solver available', errors, votes: [] };
}

const solveQuestion = (q, s, report) => (q.images?.length ? solveImageQuestion(q, s, report) : solveTextQuestion(q, s, report));

// Streaming protocol: the page sends each question as soon as it reads it, so solving
// starts immediately and runs in parallel with reading the rest of the quiz.
//   page → bg: {type:'question', question} (repeated), {type:'end'}
//   bg → page: {type:'progress'|'result'|'done'|'error'}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'solver') return;
  const send = (m) => { try { port.postMessage(m); } catch {} };
  const report = (data) => send({ type: 'progress', ...data });
  let settings = null;
  const pending = [];

  const ready = (async () => {
    const s = await getSettings();
    if (!s.geminiKey && !s.groqKey) throw new Error('No API key set. Open the extension settings first.');
    const chain = buildSolverChain(s);
    const imageInfo = s.geminiModels?.length ? `images: ${s.geminiModels.length} Gemini models` : 'images: no Gemini key';
    report({ stage: 'models', msg: `Text: ${chain[0]?.models[0]} · ${imageInfo}` });
    settings = s;
    return s;
  })();
  ready.catch((e) => send({ type: 'error', msg: e.message }));

  port.onMessage.addListener((msg) => {
    if (msg.type === 'question') {
      const q = msg.question;
      report({ num: q.num, stage: 'start' });
      pending.push((async () => {
        const s = settings || await ready;
        const res = await solveQuestion(q, s, report);
        send({ type: 'result', result: res });
      })().catch((e) => send({ type: 'result', result: { num: q.num, answer: null, confidence: 'none', error: e.message, votes: [] } })));
    } else if (msg.type === 'end') {
      Promise.allSettled(pending).then(() => send({ type: 'done' }));
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (msg?.type === 'asg') {
    handleAssignmentMessage(msg, sender, getSettings)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
