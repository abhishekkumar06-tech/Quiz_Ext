# Newton Quiz Solver (Chrome extension)

A one-click AI agent for Newton School practice quizzes. It reads every question on the page,
sends each one to an LLM the moment it is read, then selects the answers as they arrive and
marks anything uncertain for review. **It never submits.**

## How it works

1. **Read + stream.** The content script walks through the quiz with Next. Each question is read
   once the page has finished loading it (two identical snapshots), and sent to the solver
   **immediately**, so answers are computed while the rest of the quiz is still being read.
2. **Solve.** One API call per question to `openai/gpt-oss-120b` on Groq (high reasoning). The model
   also reports its own confidence. Fallback models (`gpt-oss-20b`, …) are used only if a call fails.
   Groq's free tier allows 8K tokens/min per model; rate-limit responses are parsed and retried after
   the exact wait Groq asks for.
3. **Images.** Question and option images are downloaded, re-encoded by Chrome (fixes slightly
   malformed PNGs, puts transparent diagrams on white), and sent to **Gemini Flash**, rotating
   through every Flash model because the free tier allows ~20 requests/day per model. Exhausted
   models are remembered until the quota resets (midnight Pacific). If Gemini fails or is slow
   (>6s), a backup starts in parallel: **Qwen on Groq transcribes the image to text**, then
   gpt-oss-120b solves; the first answer wins.
4. **Fill.** As answers arrive it jumps to the nearest ready question, re-checks that the question on
   screen matches the one solved, selects the option, verifies it via `data-marked-choice`, and marks
   anything below 90% model confidence for review. Image answers are marked for review too
   (toggle in settings).

## Setup

1. Get keys (both free, no card):
   - Groq (recommended main solver, generous free tier): https://console.groq.com/keys
   - Gemini (for image questions): https://aistudio.google.com/apikey
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the extension's toolbar icon to open Settings, paste your keys, then click **Save & test keys**.
4. Start a quiz on my.newtonschool.co and click **⚡ Solve quiz** (bottom-right).

## Files

- `manifest.json`: MV3 manifest
- `src/content.js`: page driver (read/navigate/select/mark) + floating panel UI
- `src/background.js`: streaming solver (one call per question, confidence, fallbacks)
- `src/llm.js`: OpenAI-compatible client for Gemini/Groq, model auto-pick, rate limits
- `options/`: settings page

## Limitations (v0.2)

- Image answers depend on free-tier vision models, which can be slow or over capacity at busy times.
- No code execution; code-output questions rely on careful step-by-step tracing.
- Single model, single call: a confidently wrong answer is not flagged.
