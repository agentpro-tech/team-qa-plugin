// Claude Code host route for the board quality review.
// A Codex root spawns a native reviewer subagent. A Claude Code root has no native spawn that pins model and effort per
// call, so it runs `board-quality dispatch`, which launches one isolated `claude -p` reviewer: no tools, no settings,
// no MCP, the locked review packet and facts inline in its single prompt. Proof of the parent is the root transcript's
// own Bash calls (the exact prepare and dispatch commands and their markers); proof of the reviewer is its stream,
// its original transcript (first user message = the locked message) and the observed model and effort.
import { scanOriginalSource } from './original-source.mjs';
import { claudeToolPair } from './host-transcript.mjs';
import { sha256 } from './core.mjs';

export const CLAUDE_REVIEW_MAX_TURNS = 1;
export const CLAUDE_REVIEW_DISALLOWED_TOOLS = 'Agent,Task,Bash,Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch,WebFetch';

const lineSource = (path, index, raw) => ({ path, line: index + 1, sha256: sha256(raw) });

// Argument vector for the reviewer. Mirrors the role dispatch flags, minus every tool.
export function claudeReviewArgv({ model, effort, sessionId }) {
  return ['-p', '--safe-mode', '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'plan', '--max-turns', String(CLAUDE_REVIEW_MAX_TURNS), '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    '--disallowedTools', CLAUDE_REVIEW_DISALLOWED_TOOLS, '--session-id', sessionId];
}

// Bash calls of a Claude root transcript whose stdout contains `marker`, normalized by the host adapter.
// Returns [{ call, result, command, exitCode }] with original line sources.
export function claudeBashResults(hostPath, marker) {
  const calls = new Map(), hits = [];
  scanOriginalSource(hostPath, (raw, index) => {
    if (!raw) return;
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use' && typeof c.id === 'string') calls.set(c.id, { e, raw, index });
      return;
    }
    if (e?.type !== 'user' || !Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_result' || !calls.has(c.tool_use_id)) continue;
      const call = calls.get(c.tool_use_id), pair = claudeToolPair(call.e, e);
      if (pair.error || pair.name !== 'exec_command' || !String(pair.output.output).includes(marker)) continue;
      hits.push({ call: lineSource(hostPath, call.index, call.raw), result: lineSource(hostPath, index, raw),
        command: pair.input.cmd, exitCode: pair.output.exit_code });
    }
  });
  return hits;
}

// Session id and first non-meta user message (text) of an original Claude transcript.
export function claudeFirstUserText(path) {
  let text = null, sessionId = null;
  scanOriginalSource(path, (raw) => {
    if (text !== null || !raw) return;
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    if (!sessionId && typeof e?.sessionId === 'string') sessionId = e.sessionId;
    if (e?.type !== 'user' || e.isMeta === true || e.isSidechain === true || e.toolUseResult !== undefined) return;
    const c = e.message?.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c) && c.length && c.every((p) => p?.type === 'text' && typeof p.text === 'string')) text = c.map((p) => p.text).join('\n');
  });
  return { text, sessionId };
}

// Reviewer checks that need no provider call. `parsed` is the qa-code anthropic stream parse of the dispatch;
// `child` is claudeFirstUserText() of the reviewer's original transcript. Returns error codes (empty = verified).
export function claudeReviewerErrors({ intent, dispatch, parsed, child, childSourcePath }) {
  const errors = [...(parsed?.errors || [])];
  if (parsed?.provider !== 'anthropic') errors.push('REVIEWER_PROVIDER');
  if (!parsed?.session_id || parsed.session_id !== dispatch?.session_id) errors.push('REVIEWER_SESSION');
  if (parsed?.observed?.model !== intent.spawn.model) errors.push('REVIEWER_MODEL');
  if (parsed?.observed?.reasoning !== intent.spawn.reasoning_effort) errors.push('REVIEWER_EFFORT');
  if (!Array.isArray(parsed?.tool_log) || parsed.tool_log.length !== 0) errors.push('REVIEWER_TOOL_USED');
  if (!parsed?.metadata_source?.path || parsed.metadata_source.path !== childSourcePath) errors.push('REVIEWER_TRANSCRIPT');
  if (parsed?.session_id === intent.host.session_id || parsed?.session_id === intent.author.session_id) errors.push('REVIEWER_NOT_INDEPENDENT');
  if (child?.sessionId !== dispatch?.session_id) errors.push('REVIEWER_TRANSCRIPT_SESSION');
  if (typeof child?.text !== 'string' || !child.text.includes(intent.spawn.message.trim())) errors.push('REVIEWER_MESSAGE_NOT_SUPPLIED');
  if (typeof parsed?.verdictText !== 'string' || !parsed.verdictText.trim()) errors.push('REVIEWER_VERDICT_MISSING');
  return [...new Set(errors)];
}

// The two root calls must be in order: prepare result before the dispatch call.
export function claudeSourcesOrdered(prepare, dispatch) {
  return prepare.result.line < dispatch.call.line;
}
