// Chat client for free-tier providers:
//  - Groq: OpenAI-compatible API (text; Qwen models also accept images)
//  - Gemini: native generateContent API (text + images)
// Includes model auto-selection, rate-limit backoff, and daily-quota tracking so
// exhausted models are skipped until their quota resets.

// Bump when model preferences change so stored model picks are refreshed.
export const MODELS_VERSION = 6;

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    // Free tier gives ~20 requests/day PER MODEL, so keep every Flash model for rotation.
    // Pro models have no free tier.
    preferences: [
      { re: /^gemini-3(\.\d+)?-flash(-preview)?$/, all: true },
      { re: /^gemini-3(\.\d+)?-flash-lite(-preview)?$/, all: true },
    ],
    defaults: ['gemini-3-flash-preview', 'gemini-3.1-flash-lite'],
  },
  groq: {
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    // First = main solver; the rest are fallbacks. Free tier limits are per model
    // (gpt-oss: 8K tokens/min; Qwen: only 1K output tokens/min, so it sits low).
    preferences: [
      /gpt-oss-120b/,
      /gpt-oss-20b$/,
      /qwen/, // newest Qwen wins: matches are sorted in reverse (qwen3.8 before qwen3.6)
      /kimi-k2/,
      /deepseek-r1/,
      /llama-4-maverick/,
      /llama-3\.3-70b/,
    ],
    defaults: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Please try again in 4.68s" / "in 1m26.4s" / "in 350ms" (Groq), "retryDelay": "12s" (Gemini), Retry-After header.
export function parseRetryMs(errText, retryAfterHeader) {
  const m = errText.match(/try again in (?:(\d+)m)?([\d.]+)(ms|s)\b/i);
  if (m) {
    const secs = (Number(m[1]) || 0) * 60 + Number(m[2]) / (m[3].toLowerCase() === 'ms' ? 1000 : 1);
    return Math.ceil(secs * 1000) + 300;
  }
  const g = errText.match(/"retryDelay":\s*"([\d.]+)s"/i);
  if (g) return Number(g[1]) * 1000 + 300;
  const h = Number(retryAfterHeader);
  return h ? h * 1000 : null;
}

export async function listModels(provider, key) {
  const p = PROVIDERS[provider];
  if (provider === 'gemini') {
    const res = await fetch(`${p.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new Error(`${p.label}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${p.label}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id);
}

export async function pickModels(provider, key) {
  const p = PROVIDERS[provider];
  let ids;
  try {
    ids = await listModels(provider, key);
  } catch (e) {
    if (/40[013]/.test(e.message)) throw e;
    return p.defaults;
  }
  const picked = [];
  for (const pref of p.preferences) {
    const { re, all } = pref instanceof RegExp ? { re: pref } : pref;
    const matches = ids.filter((id) => re.test(id) && !picked.includes(id)).sort().reverse();
    picked.push(...(all ? matches : matches.slice(0, 1)));
  }
  if (provider === 'groq') {
    // Model lineups change; append any other capable-looking chat models as extra fallbacks.
    const extras = ids.filter((id) => !picked.includes(id) &&
      !/whisper|tts|guard|embed|playai|orpheus|compound|safeguard|allam|gemma|distil|(^|[-/])(1|3|7|8|9|17|20)b\b|instant|mini|nano|vision/i.test(id));
    picked.push(...extras.sort());
  }
  return picked.length ? picked : p.defaults;
}

export { listModels as availableModels };

// ---------- Daily quota tracking ----------

// key "provider:model" -> timestamp until which the model is skipped.
const exhausted = new Map();
let onExhaustedChange = null;

export function loadExhausted(obj = {}) {
  const now = Date.now();
  for (const [k, until] of Object.entries(obj)) if (until > now) exhausted.set(k, until);
}
export function setExhaustedListener(fn) { onExhaustedChange = fn; }
export function exhaustedModels() {
  const now = Date.now();
  return [...exhausted].filter(([, until]) => until > now).map(([k]) => k);
}

// Gemini free-tier daily quotas reset at midnight Pacific time.
function nextPacificMidnight() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offset = now.getTime() - pt.getTime();
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() + offset;
}

function markExhausted(provider, model, until) {
  exhausted.set(`${provider}:${model}`, until);
  onExhaustedChange?.(Object.fromEntries(exhausted));
}
const isExhausted = (provider, model) => (exhausted.get(`${provider}:${model}`) || 0) > Date.now();

// ---------- Concurrency ----------

// Simple per-provider concurrency limiter to stay under free-tier RPM.
const slots = { gemini: 3, groq: 6 };
const queues = { gemini: [], groq: [] };
async function acquire(provider) {
  if (slots[provider] > 0) { slots[provider]--; return; }
  await new Promise((r) => queues[provider].push(r));
}
function release(provider) {
  const next = queues[provider].shift();
  if (next) next(); else slots[provider]++;
}

// ---------- Request builders ----------

// Messages use OpenAI shape; user content may be a string or parts:
// {type:'text', text} | {type:'image_url', image_url:{url:'data:image/png;base64,...'}}
function buildRequest(provider, key, model, messages, reasoning, maxTokens) {
  const p = PROVIDERS[provider];
  if (provider === 'gemini') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => {
      const parts = (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).map((part) => {
        if (part.type === 'text') return { text: part.text };
        const [, mime, data] = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/) || [];
        return { inline_data: { mime_type: mime, data } };
      });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
    const body = { contents };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    body.generationConfig = {};
    if (reasoning) body.generationConfig.thinkingConfig = { thinkingLevel: reasoning };
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
    return {
      url: `${p.base}/models/${model}:generateContent`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) },
      parse: (json) => (json.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join(''),
    };
  }
  const body = { model, messages };
  if (reasoning) body.reasoning_effort = reasoning;
  if (maxTokens) body.max_completion_tokens = maxTokens;
  return {
    url: `${p.base}/chat/completions`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) },
    parse: (json) => json.choices?.[0]?.message?.content || '',
  };
}

/**
 * Chat completion with fallback across the given model list.
 * Returns { text, model }.
 */
export async function chat({ provider, key, models, messages, reasoning = 'high', onStatus, patient = true, maxTokens, timeoutMs = 45000 }) {
  const p = PROVIDERS[provider];
  await acquire(provider);
  try {
    let lastErr;
    for (const model of models) {
      if (isExhausted(provider, model)) { onStatus?.(`Skipping ${model}: its quota is exhausted`); continue; }
      onStatus?.(`Requesting ${model}…`);
      let useReasoning = reasoning;
      for (let attempt = 0; attempt < 6; attempt++) {
        const reqSpec = buildRequest(provider, key, model, messages, useReasoning, maxTokens);
        let res;
        try {
          // Never let a hung request stall the quiz.
          res = await fetch(reqSpec.url, { ...reqSpec.init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
          lastErr = e.name === 'TimeoutError' ? new Error(`${p.label} ${model}: timed out`) : e;
          if (attempt >= 1) { onStatus?.(`${model} timed out; trying the next model`); break; }
          await sleep(1000);
          continue;
        }
        if (res.ok) {
          const text = reqSpec.parse(await res.json());
          if (!text.trim()) { lastErr = new Error(`${model}: empty response`); await sleep(1500); continue; }
          onStatus?.(`Received a response from ${model}`);
          return { text, model };
        }
        const errText = await res.text();
        lastErr = new Error(`${p.label} ${model}: ${res.status} ${errText.slice(0, 300)}`);
        if (res.status === 400 && useReasoning && /reasoning|thinking/i.test(errText)) {
          useReasoning = null; // model doesn't support reasoning_effort / thinkingLevel
          continue;
        }
        if (res.status === 401 || res.status === 403) throw lastErr;
        if (res.status === 404) { markExhausted(provider, model, Date.now() + 30 * 864e5); break; } // model removed
        if (res.status === 400) break; // try next model
        if (res.status === 429) {
          if (/PerDay|per.?day|daily|RequestsPerDay|tokens per day|TPD|RPD|limit:\s*0\b/i.test(errText)) {
            markExhausted(provider, model, provider === 'gemini' ? nextPacificMidnight() : Date.now() + 3600e3);
            onStatus?.(`${model} daily limit reached, switching model`);
            break;
          }
          const wait = parseRetryMs(errText, res.headers.get('retry-after')) ?? 5000 * (attempt + 1);
          // Assignment generation prioritizes responsiveness: retry only a very short
          // per-minute cooldown, otherwise move to the next configured model/provider.
          if (!patient && (wait > 3000 || attempt >= 1)) throw lastErr;
          onStatus?.(`Free-tier speed limit, continuing in ${(wait / 1000).toFixed(1)}s`);
          await sleep(Math.min(wait, 70000));
          continue;
        }
        if (res.status >= 500) {
          // Overloaded ("high demand"): another model usually has capacity, so move on quickly.
          if (attempt >= (models.length > 1 ? 1 : 2)) { onStatus?.(`${model} is busy, trying another model`); break; }
          await sleep(1500 * (attempt + 1));
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error(`${p.label}: all models are at their daily limit`);
  } finally {
    release(provider);
  }
}
