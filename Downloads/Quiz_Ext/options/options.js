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

// Test candidate models in order and keep the ones that answer. We need two for cross-checking.
async function testModels(provider, key, want) {
  const candidates = await pickModels(provider, key);
  const working = [];
  for (const m of candidates) {
    if (working.length >= want) { working.push(m); continue; } // untested fallbacks keep their order
    try { await ping(provider, key, m); working.push(m); }
    catch (e) { line('muted', `  – ${m} unavailable: ${e.message.slice(0, 120)}`); }
  }
  return working;
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
      const models = await testModels('groq', groqKey, 1);
      await chrome.storage.local.set({ groqModels: models });
      if (models.length) line('ok', `✓ Groq works. Solver: ${models[0]}${models[1] ? ` · fallback: ${models.slice(1, 3).join(', ')}` : ''}`);
      else line('err', '✗ Groq: no working model found');
      const all = await availableModels('groq', groqKey);
      line('muted', `Available on your account: ${all.join(', ')}`);
    } catch (e) { line('err', `✗ Groq: ${e.message}`); }
  }
  if (geminiKey) {
    // Keep every Flash model for rotation (each has its own daily quota). Only verify the key works;
    // a model at today's limit is still kept because its quota resets tomorrow.
    try {
      const models = await pickModels('gemini', geminiKey);
      let working = null;
      let limited = 0;
      for (const m of models) {
        try { await ping('gemini', geminiKey, m); working = m; break; }
        catch (e) {
          if (/429/.test(e.message)) { limited++; continue; }
          if (/40[13]/.test(e.message)) throw e;
        }
      }
      await chrome.storage.local.set({ geminiModels: models });
      if (working) line('ok', `✓ Gemini works (${working}). Image models in rotation: ${models.join(', ')}`);
      else if (limited) line('err', `Gemini key is valid, but all ${models.length} models are at today's free limit. They reset at midnight Pacific time.`);
      else line('err', '✗ Gemini: no usable model found');
    } catch (e) { line('err', `✗ Gemini: ${e.message}`); }
  }
  line('', 'Done.');
});
