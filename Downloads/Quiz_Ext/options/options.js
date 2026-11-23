import { pickModels, chat, availableModels, MODELS_VERSION } from '../src/llm.js';

const $ = (id) => document.getElementById(id);
const out = $('out');
const line = (cls, text) => { out.innerHTML += `<div class="${cls}">${text.replace(/</g, '&lt;')}</div>`; };

chrome.storage.local.get(['geminiKey', 'groqKey', 'thinking', 'reviewImages', 'autoSubmitQuiz']).then((s) => {
  $('autoSubmitQuiz').checked = s.autoSubmitQuiz === true;
  $('reviewImages').checked = s.reviewImages !== false;
  $('geminiKey').value = s.geminiKey || '';
  $('groqKey').value = s.groqKey || '';
  $('thinking').value = s.thinking || 'medium';
});

const ping = (provider, key, model) => chat({
  provider, key, models: [model], reasoning: null, patient: false,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});

// Discover models without probing each one: each successful ping consumes quota, and
// probing every daily-limited model during setup can burn requests before solving.
async function discoverAndProbe(provider, key) {
  const models = await pickModels(provider, key);
  if (!models.length) return { models, working: null, limited: false };
  try {
    await ping(provider, key, models[0]);
    return { models, working: models[0], limited: false };
  } catch (e) {
    if (/429/.test(e.message)) return { models, working: null, limited: true, error: e.message };
    throw e;
  }
}

$('save').addEventListener('click', async () => {
  out.innerHTML = '';
  const geminiKey = $('geminiKey').value.trim();
  const groqKey = $('groqKey').value.trim();
  const thinking = $('thinking').value;
  const reviewImages = $('reviewImages').checked;
  await chrome.storage.local.set({ autoSubmitQuiz: $('autoSubmitQuiz').checked });
  await chrome.storage.local.set({ geminiKey, groqKey, thinking, reviewImages, geminiModels: [], groqModels: [], modelsVersion: MODELS_VERSION });
  line('', 'Saved. Testing…');

  if (!geminiKey && !groqKey) line('err', 'Add at least one key (Groq recommended).');
  if (groqKey) {
    try {
      const { models, working, limited } = await discoverAndProbe('groq', groqKey);
      await chrome.storage.local.set({ groqModels: models });
      if (working) line('ok', `✓ Groq works. Solver: ${working}${models.length > 1 ? ` · ${models.length - 1} configured fallbacks` : ''}`);
      else if (limited) line('muted', `Groq model ${models[0]} is rate-limited right now. Models were saved; the solver will try its configured fallbacks when needed.`);
      else line('err', '✗ Groq: no working model found');
      const all = await availableModels('groq', groqKey);
      line('muted', `Available on your account: ${all.join(', ')}`);
    } catch (e) { line('err', `✗ Groq: ${e.message}`); }
  }
  if (geminiKey) {
    // Keep all models for fallback, but probe only one to avoid spending a request per model.
    try {
      const { models, working, limited } = await discoverAndProbe('gemini', geminiKey);
      await chrome.storage.local.set({ geminiModels: models });
      if (working) line('ok', `✓ Gemini works (${working}). Image models in rotation: ${models.join(', ')}`);
      else if (limited) line('muted', `Gemini model ${models[0]} is rate-limited right now. Models were saved; daily quota resets at midnight Pacific time.`);
      else line('err', '✗ Gemini: no usable model found');
    } catch (e) { line('err', `✗ Gemini: ${e.message}`); }
  }
  line('', 'Done.');
});
