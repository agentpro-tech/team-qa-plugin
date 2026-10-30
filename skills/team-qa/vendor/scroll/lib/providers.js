// SCROLL — provider adapters (vendor-neutral model layer for `scroll run`).
// Zero-dep: Node built-ins + global fetch (Node >= 20).
//
// A provider exposes:  { name, model, ready, missing, generate(prompt, opts) }
//   generate(prompt, { model, maxTokens, cwd, system, cachePrefix })
//     -> { text, usage:{ uncachedInputTokens, cachedInputTokens, outputTokens, providerTotalTokens }, durationMs, responseId }
//
// The runtime is what drives the loop; providers only turn a prompt into text+usage.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));

// Tool-strip hook: a reasoning-only agent (toolPolicy 'none') doesn't need the CLI's tool schemas.
// Flags are env-configured (verify the exact flag per CLI version) — empty by default, so this is safe.
function leanFlags(toolPolicy) {
  if (toolPolicy !== 'none') return [];
  const raw = process.env.SCROLL_LEAN_CLI_FLAGS;
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to simple whitespace splitting below.
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

// ── command helpers ──────────────────────────────────────────────────────────
function commandExists(command) {
  if (command.includes('/')) return fs.existsSync(command);
  const r = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim();
}

function runCommand(command, args, { cwd, input = '', timeoutMs = 300000 } = {}) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error([`${command} exited ${child.status}`, child.stderr, child.stdout].filter(Boolean).join('\n').slice(0, 4000));
  }
  return { stdout: child.stdout || '', durationMs };
}

function parseJsonLines(stdout) {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── MOCK (deterministic — proves runtime mechanics without spending tokens) ────
// Caching is simulated: the first time a given cachePrefix is seen it is "uncached";
// subsequent calls with the same prefix bill it as cached (this is what a real
// stable-prefix cache does — the runtime is responsible for ordering it stably).
function makeMockProvider() {
  const seenPrefixes = new Set();
  return {
    name: 'mock', model: 'mock-1', ready: true, missing: null,
    async generate(prompt, { cachePrefix = '', system = '' } = {}) {
      const t0 = Date.now();
      const prefix = cachePrefix || system || '';
      const prefixTok = approxTokens(prefix);
      const bodyTok = approxTokens(prompt) - (cachePrefix && prompt.includes(cachePrefix) ? prefixTok : 0);
      const cached = prefix && seenPrefixes.has(prefix);
      if (prefix) seenPrefixes.add(prefix);
      const text = mockAnswer(prompt);
      return {
        text,
        usage: {
          uncachedInputTokens: cached ? Math.max(1, bodyTok) : approxTokens(prompt),
          cachedInputTokens: cached ? prefixTok : 0,
          outputTokens: approxTokens(text),
          providerTotalTokens: approxTokens(prompt) + approxTokens(text),
        },
        durationMs: Date.now() - t0 + 5,
        responseId: 'mock-' + Math.random().toString(36).slice(2, 10),
      };
    },
  };
}

// A structured answer that satisfies a Verdict/Evidence/Assumptions/Next-actions
// contract, cites whatever [S#] source ids appear in the prompt, and never repeats
// the planted trap phrasing.
function mockAnswer(prompt) {
  // judge mode (deterministic): if asked to grade, return a fixed parseable score (4.5).
  // Lets the eval LLM-judge path be tested with 0 tokens; real grading uses a real provider.
  if (prompt.includes('SCROLL_JUDGE_JSON')) return '{"scores": {"faithfulness": 5, "clarity": 4, "honesty": 4.5}, "average": 4.5}';
  const sources = [...new Set((prompt.match(/\bS\d\b/g) || []))];
  const c = (i) => (sources[i] ? `[${sources[i]}]` : '');
  const objMatch = prompt.match(/objective:\s*(.+)/i);
  const objective = objMatch ? objMatch[1].trim().slice(0, 120) : 'the requested task';
  return [
    '## Verdict',
    `Conditional go — treat as a measured pilot, not a finished product ${c(0)}.`,
    '',
    '## Evidence',
    `- The core problem is drift/fragmentation across runtimes ${c(0)}.`,
    `- The proposed approach is a single source of truth that renders to each runtime ${c(1)}.`,
    '',
    '## Assumptions',
    `- Production-grade runtime claims stay unmeasured until a real runner exists ${c(2)}.`,
    `- Objective addressed: ${objective}.`,
    '',
    '## Next actions',
    '1. Build the minimal runtime and measure on a real multi-step task.',
    '2. Re-run the eval with >=3 repeats through an API provider.',
  ].join('\n');
}

// ── Codex CLI ─────────────────────────────────────────────────────────────────
// v1.6: pure arg builders (unit-testable, no spawn).
export function codexArgs({ model, toolPolicy, sandbox, effort } = {}) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--ephemeral'];
  args.push('--sandbox', sandbox === 'write' ? 'workspace-write' : 'read-only');
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (model) args.push('--model', model);
  args.push(...leanFlags(toolPolicy));
  args.push('-'); // prompt via stdin — long prompts never hit argv limits
  return args;
}
function makeCodexProvider({ model } = {}) {
  return {
    name: 'codex-cli', model: model || process.env.CODEX_MODEL || 'codex-default',
    ready: Boolean(commandExists('codex')), missing: 'codex CLI not on PATH',
    async generate(prompt, { cwd, model: m, toolPolicy, sandbox, effort, timeoutMs } = {}) {
      const args = codexArgs({ model: (process.env.CODEX_MODEL || m) ? (m || this.model) : null, toolPolicy, sandbox, effort });
      const { stdout, durationMs } = runCommand('codex', args, { cwd, input: prompt, timeoutMs: timeoutMs || (sandbox === 'write' ? 900000 : 300000) });
      const events = parseJsonLines(stdout);
      const msg = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text || '');
      const done = [...events].reverse().find((e) => e.type === 'turn.completed');
      const u = done?.usage || {};
      const input = Number(u.input_tokens || 0), cached = Number(u.cached_input_tokens || 0);
      return {
        text: msg.at(-1) || '',
        usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + Number(u.output_tokens || 0) },
        durationMs, responseId: events.find((e) => e.type === 'thread.started')?.thread_id || null,
      };
    },
  };
}

// ── Claude CLI ──────────────────────────────────────────────────────────────
function makeClaudeProvider({ model } = {}) {
  const bin = process.env.CLAUDE_CLI || 'claude';
  return {
    name: 'claude-cli', model: model || process.env.CLAUDE_MODEL || 'claude-default',
    ready: Boolean(commandExists(bin)), missing: `Claude CLI not found (${bin})`,
    async generate(prompt, { cwd, model: m, toolPolicy } = {}) {
      // Runs in an isolated cwd (caller's scratch dir) so repo CLAUDE.md does not leak in.
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'];
      if (process.env.CLAUDE_MODEL || m) args.push('--model', m || this.model);
      args.push(...leanFlags(toolPolicy));
      args.push(prompt);
      const { stdout, durationMs } = runCommand(bin, args, { cwd });
      const j = JSON.parse(stdout);
      const u = j.usage || {};
      const input = Number(u.input_tokens || 0), cc = Number(u.cache_creation_input_tokens || 0), cr = Number(u.cache_read_input_tokens || 0);
      return {
        text: j.result || '',
        usage: { uncachedInputTokens: input + cc, cachedInputTokens: cr, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + cc + cr + Number(u.output_tokens || 0) },
        durationMs: Number(j.duration_ms || durationMs), responseId: j.session_id || null,
      };
    },
  };
}

// ── API providers (fetch) ─────────────────────────────────────────────────────
async function fetchJson(url, opts) {
  const started = Date.now();
  const res = await fetch(url, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json?.error?.message || text.slice(0, 300)); e.status = res.status; throw e; }
  return { json, durationMs: Date.now() - started };
}

function makeOpenAIProvider({ model } = {}) {
  return {
    name: 'openai', model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    ready: Boolean(process.env.OPENAI_API_KEY), missing: 'OPENAI_API_KEY not set',
    async generate(prompt, { maxTokens = 800, model: m } = {}) {
      const { json, durationMs } = await fetchJson('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: m || this.model, input: prompt, max_output_tokens: maxTokens, store: false }),
      });
      const u = json.usage || {}; const cached = Number(u.input_tokens_details?.cached_tokens || 0); const input = Number(u.input_tokens || 0);
      const text = json.output_text || (json.output || []).flatMap((i) => i.content || []).map((p) => p.text || '').join('\n').trim();
      return { text, usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: Number(u.total_tokens || 0) }, durationMs, responseId: json.id };
    },
  };
}

function makeAnthropicProvider({ model } = {}) {
  return {
    name: 'anthropic', model: model || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    ready: Boolean(process.env.ANTHROPIC_API_KEY), missing: 'ANTHROPIC_API_KEY not set',
    async generate(prompt, { maxTokens = 800, model: m, cachePrefix = '' } = {}) {
      // Stable prefix is marked cacheable so step 2+ bills cache_read (the token lever).
      const system = cachePrefix
        ? [{ type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } }]
        : undefined;
      const userText = cachePrefix && prompt.startsWith(cachePrefix) ? prompt.slice(cachePrefix.length) : prompt;
      const { json, durationMs } = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: m || this.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: userText || prompt }] }),
      });
      const u = json.usage || {}; const cr = Number(u.cache_read_input_tokens || 0); const cc = Number(u.cache_creation_input_tokens || 0); const input = Number(u.input_tokens || 0);
      return { text: (json.content || []).map((p) => p.text || '').join('\n').trim(), usage: { uncachedInputTokens: input + cc, cachedInputTokens: cr, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + cc + cr + Number(u.output_tokens || 0) }, durationMs, responseId: json.id };
    },
  };
}

function makeGeminiProvider({ model } = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return {
    name: 'gemini', model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    ready: Boolean(key), missing: 'GEMINI_API_KEY/GOOGLE_API_KEY not set',
    async generate(prompt, { maxTokens = 800, model: m } = {}) {
      const mp = (m || this.model).startsWith('models/') ? (m || this.model) : `models/${m || this.model}`;
      const { json, durationMs } = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/${mp}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
      });
      const u = json.usageMetadata || {}; const cached = Number(u.cachedContentTokenCount || 0); const input = Number(u.promptTokenCount || 0);
      return { text: (json.candidates || []).flatMap((c) => c.content?.parts || []).map((p) => p.text || '').join('\n').trim(), usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.candidatesTokenCount || 0), providerTotalTokens: Number(u.totalTokenCount || 0) }, durationMs, responseId: null };
    },
  };
}

// ── Grok CLI (Grok Build) — v1.6 ─────────────────────────────────────────────
// Read-first profile by default (QA role): may read files and run git/curl/test
// commands, but cannot write or push. sandbox:'write' switches to acceptEdits.
export function grokArgs({ model, effort, sandbox, maxTurns } = {}) {
  const args = ['--no-auto-update', '--output-format', 'json', '--max-turns', String(maxTurns || 30), '--sandbox', 'workspace'];
  if (effort) args.push('--effort', String(effort));
  if (model) args.push('-m', model);
  if (sandbox === 'write') {
    args.push('--permission-mode', 'acceptEdits');
  } else {
    args.push('--permission-mode', 'dontAsk');
    // Under dontAsk every tool call must be DECIDED by a rule. A call matching
    // neither allow nor deny stays undecided, so the CLI tries to prompt; headless
    // has no TTY and the ENTIRE run dies with stopReason "Cancelled" -- not just
    // that one call. A prefix-scoped allow-list therefore cancels a run the moment
    // the model reaches for any command nobody enumerated (ls, cat, sed, `cd x && npm t`).
    //
    // Deny is graceful by contrast: the model is told no and keeps working. So the
    // allow rule must be broad enough to leave nothing undecided, and the boundary is
    // carried by the deny list plus the workspace sandbox (the real enforcement).
    //
    // Precedence is deny-wins regardless of specificity: `--deny Bash` overrides
    // `--allow "Bash(echo *)"`, so a catch-all deny is not a usable backstop either.
    // Verified live: unscoped allow + this deny list => normal commands run, rm and
    // Write/Edit are refused, run completes with EndTurn.
    for (const a of ['Read', 'Grep', 'Glob', 'Bash']) args.push('--allow', a);
    for (const d of ['Write', 'Edit', 'Bash(rm *)', 'Bash(git push*)', 'Bash(sudo *)']) args.push('--deny', d);
  }
  return args;
}
function makeGrokProvider({ model } = {}) {
  const bin = process.env.GROK_CLI || 'grok';
  return {
    name: 'grok-cli', model: model || process.env.GROK_MODEL || 'grok-4.5', // grok-4.5 = flagship, accepts --effort (verified live 07/09/2026). grok-build REMOVED from CLI; composer-fast REJECTS --effort. If 'unknown model id' → run 'grok models' + set GROK_MODEL
    ready: Boolean(commandExists(bin)), missing: `grok CLI not found (${bin})`,
    async generate(prompt, { cwd, model: m, effort, sandbox, maxTurns, timeoutMs } = {}) {
      const args = [...grokArgs({ model: m || this.model, effort, sandbox, maxTurns }), '-p', prompt]; // always pin model — default model rejects reasoning effort
      const { stdout, durationMs } = runCommand(bin, args, { cwd, timeoutMs: timeoutMs || 900000 });
      // Output shape is version-dependent — parse defensively: whole-JSON → last JSON line → raw text.
      let j = null;
      try { j = JSON.parse(stdout); } catch { j = parseJsonLines(stdout).at(-1) || null; }
      const cand = j && (j.result ?? j.text ?? j.response ?? j.output ?? j.final ?? (typeof j.message === 'string' ? j.message : null));
      const text = typeof cand === 'string' && cand ? cand : stdout.trim();
      const u = (j && j.usage) || {};
      const input = Number(u.input_tokens || u.prompt_tokens || 0), cached = Number(u.cached_input_tokens || u.cache_read_input_tokens || 0), out = Number(u.output_tokens || u.completion_tokens || 0);
      return {
        text,
        usage: (input || out)
          ? { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: out, providerTotalTokens: input + out }
          : { uncachedInputTokens: approxTokens(prompt), cachedInputTokens: 0, outputTokens: approxTokens(text), providerTotalTokens: approxTokens(prompt) + approxTokens(text) },
        durationMs, responseId: (j && (j.sessionId || j.session_id || j.id)) || null, // verified shape 07/2026: {text, stopReason, sessionId}
      };
    },
  };
}

const FACTORIES = {
  mock: makeMockProvider, codex: makeCodexProvider, claude: makeClaudeProvider,
  openai: makeOpenAIProvider, anthropic: makeAnthropicProvider, gemini: makeGeminiProvider,
  grok: makeGrokProvider,
};

// Pick a provider by name, or 'auto' = first ready real provider (API before CLI),
// never silently falling back to mock (mock must be requested explicitly).
export function pickProvider(name = 'auto', opts = {}) {
  if (name && name !== 'auto') {
    const f = FACTORIES[name];
    if (!f) throw new Error(`unknown provider "${name}" (have: ${Object.keys(FACTORIES).join(', ')})`);
    return f(opts);
  }
  const order = ['openai', 'anthropic', 'gemini', 'codex', 'claude'];
  for (const n of order) { const p = FACTORIES[n](opts); if (p.ready) return p; }
  const codex = FACTORIES.codex(opts);
  return codex; // not ready → caller surfaces .missing
}

export { approxTokens };
