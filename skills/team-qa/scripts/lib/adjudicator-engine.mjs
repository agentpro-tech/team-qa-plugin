// The adjudicator engine interface (upgrade R2a): team-qa/adjudicator-engine/v1.
//
//   engine.call({ phase, input, attempt, runDir, images }) -> Promise<{ output, session_id?, stdout?, stderr?, exit? }>
//
// One call is one fresh model session that sees nothing but `input`, the exact text written to its stdin (the
// adjudicator instructions and one payload), and the files that text names. `phase` is `checklist` or `judge`;
// `attempt` is the session id Team QA chose; `images` are the absolute paths of the images the payload names (a harness
// that cannot open an image with its Read tool gets them attached). `output` is the text the model answered. The
// adjudicator module builds every input and reads every output; an engine only carries text.
//
// cliEngine binds the interface to the roster's adjudicator seat: the seat's exact CLI (`harness_bin`, hashed in the
// approved roster), model and effort, cwd = `runDir`, a read-only tool set and no MCP server. The adjudicator passes as
// `runDir` a fresh blind workspace holding only the payload's evidence copies, never the run directory (TQ-5).
//   claude: claude -p --safe-mode --model <m> --effort <e> --output-format stream-json --verbose --permission-mode plan
//           --max-turns <n> --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'
//           --tools Read,Glob,Grep --disallowedTools Agent,Task,Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch
//           --session-id <attempt>      (environment: the allowlist of isolatedClaudeEnv, nothing of the root session)
//   codex:  codex exec --skip-git-repo-check --ignore-user-config --json --sandbox read-only --disable multi_agent
//           [--image <a.png,b.png>] -m <m> -c model_reasoning_effort="<e>" - -c approval_policy="never"
// The model's family is fixed by the seat (references/adjudicator-policy.json, checked by the roster validator), so the
// engine itself never picks a model.
import { mkdirSync } from 'node:fs';
import { runStreaming } from './dispatch-detach.mjs';
import { isolatedClaudeEnv } from './roster.mjs';

export const ENGINE_INTERFACE = 'team-qa/adjudicator-engine/v1';
const MAX_BUFFER = 64 * 1024 * 1024;

export function adjudicatorArgs({ seat, attempt, images = [] }) {
  if (seat.harness === 'claude') return ['-p', '--safe-mode', '--model', seat.model, ...seat.reasoning_control.args, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'plan', '--max-turns', String(seat.caps.max_turns), '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Agent,Task,Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch', '--session-id', attempt];
  if (seat.harness === 'codex') return ['exec', '--skip-git-repo-check', '--ignore-user-config', '--json', '--sandbox', 'read-only', '--disable', 'multi_agent',
    ...(images.length ? ['--image', images.join(',')] : []), '-m', seat.model, ...seat.reasoning_control.args, '-', '-c', 'approval_policy="never"'];
  throw Object.assign(new Error(`adjudicator harness ${seat.harness} is not supported`), { code: 'ADJUDICATOR_HARNESS' });
}

// The model's text in a harness stream: Claude stream-json assistant text and the final result, Codex agent messages;
// a stream with no JSON line is taken as plain text.
export function engineOutputText(stdout) {
  const texts = [];
  let json = false;
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); json = true; } catch { continue; }
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) for (const c of e.message.content) { if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text); }
    if (e?.type === 'result' && typeof e.result === 'string') texts.push(e.result);
    if (e?.type === 'item.completed' && ['agent_message', 'assistant_message'].includes(e.item?.type) && typeof e.item.text === 'string') texts.push(e.item.text);
    if (e?.msg?.type === 'agent_message' && typeof e.msg.message === 'string') texts.push(e.msg.message);
  }
  return json ? texts.join('\n') : String(stdout ?? '');
}
function sessionOf(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.session_id === 'string') return e.session_id; if (e?.type === 'thread.started' && typeof e.thread_id === 'string') return e.thread_id; } catch { /* not JSON */ }
  }
  return null;
}

// `attest`, for a runtime roster, checks the stream against the seat (provider, model, effort) with the declared
// provider-execution parser and returns its errors; a fixture roster passes none. `extraEnv` is added after the
// Claude allowlist (tests pass their log path through it).
export function cliEngine(seat, { env = process.env, extraEnv = {}, attest = null } = {}) {
  return {
    interface: ENGINE_INTERFACE, kind: 'cli',
    async call({ input, attempt, runDir, images = [] }) {
      mkdirSync(runDir, { recursive: true });
      const result = await runStreaming(seat.harness_bin, adjudicatorArgs({ seat, attempt, images }), {
        cwd: runDir, input, timeout: seat.caps.timeout_ms, maxBuffer: MAX_BUFFER, env: { ...(seat.harness === 'claude' ? isolatedClaudeEnv(env) : env), ...extraEnv } });
      const out = { output: engineOutputText(result.stdout), session_id: sessionOf(result.stdout), stdout: result.stdout, stderr: result.stderr, exit: result.status };
      if (result.error || result.status !== 0) throw Object.assign(new Error(`harness exit=${result.status} ${result.error?.code ?? ''}`.trim()), { code: 'ENGINE_FAILED', transport: out });
      if (attest) {
        const errors = attest({ stdout: result.stdout, stderr: result.stderr });
        if (errors.length) throw Object.assign(new Error(errors.join(',')), { code: 'ENGINE_UNATTESTED', transport: out });
      }
      return out;
    },
  };
}
