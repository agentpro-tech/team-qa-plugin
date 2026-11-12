// Host transcript adapters for the root orchestrator session.
// Codex rollouts keep their existing verifiers; Claude Code transcripts are read only from
// <Claude config>/projects/<project>/<session-id>.jsonl and only from the original file. The Claude config folder is
// CLAUDE_CONFIG_DIR when it is set, else ~/.claude, compared by its real path (a symlinked ~/.claude works).
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fail, readJson, sha256, visibleCodexAssistantText } from './core.mjs';
import { buzzSessionRoot } from './buzz-host.mjs';

export const CLAUDE_HOST_KIND = 'claude-code';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEADER_LINES = 64;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function realOrNull(path) {
  try { return realpathSync(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
export function claudeConfigDir(env = process.env) { return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'); }
export function claudeProjectsRoot(env = process.env) { return realOrNull(join(claudeConfigDir(env), 'projects')); }
export function codexSessionsRoot() { return realOrNull(join(homedir(), '.codex', 'sessions')); }

function inside(path, root) { return Boolean(root) && path.startsWith(root + sep); }

// Root transcripts only: <projects>/<project-dir>/<session-id>.jsonl.
// Subagent transcripts (<session>/subagents/*.jsonl) are not orchestrator hosts.
export function isClaudeTranscriptPath(path) {
  let real;
  try { real = realpathSync(path); } catch { return false; }
  const root = claudeProjectsRoot();
  if (!inside(real, root)) return false;
  const project = dirname(real);
  return dirname(project) === root && SESSION_ID.test(basename(real, '.jsonl')) && real.endsWith('.jsonl');
}
export function isCodexTranscriptPath(path) {
  try { return inside(realpathSync(path), codexSessionsRoot()); } catch { return false; }
}
export function transcriptHost(path) {
  if (isClaudeTranscriptPath(path)) return 'claude';
  if (isCodexTranscriptPath(path)) return 'codex';
  return null;
}

function headerLines(path) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(64 * 1024), lines = [];
  let pending = Buffer.alloc(0), total = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_HEADER_BYTES) break;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let index;
      while ((index = pending.indexOf(10)) >= 0) {
        lines.push(pending.subarray(0, index).toString('utf8'));
        pending = pending.subarray(index + 1);
        if (lines.length >= MAX_HEADER_LINES) return lines;
      }
    }
    return lines;
  } finally { closeSync(fd); }
}

// Descriptor shape matches the Codex native-host descriptor so existing exact comparisons hold.
export function claudeHostSource(path) {
  if (!isClaudeTranscriptPath(path)) fail(3, 'CLAUDE_HOST_UNTRUSTED', '', 'ungraded');
  const real = realpathSync(path), sessionId = basename(real, '.jsonl'), lines = headerLines(real);
  // An orchestrator is an interactive session: its first typed prompt must be a human line.
  for (const raw of lines) {
    let entry;
    try { entry = JSON.parse(raw); } catch { fail(3, 'CLAUDE_HOST_METADATA_INVALID', '', 'ungraded'); }
    if (entry?.type !== 'user' || entry.isMeta === true || entry.toolUseResult !== undefined) continue;
    if (!Array.isArray(entry.message?.content) && typeof entry.message?.content !== 'string') continue;
    if (Array.isArray(entry.message.content) && entry.message.content.some(c => c?.type === 'tool_result')) continue;
    // A headless session is refused unless it is a Buzz session opened by an approver of the Buzz host grant (1.17.0).
    if (entry.origin?.kind !== 'human' || entry.turnOrigin === 'sdk' || /^sdk/i.test(entry.entrypoint || '')) {
      if (!buzzSessionRoot(lines)) fail(3, 'CLAUDE_HOST_HEADLESS', '', 'ungraded');
    }
    break;
  }
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { fail(3, 'CLAUDE_HOST_METADATA_INVALID', '', 'ungraded'); }
    if (typeof entry?.version !== 'string' || !entry.version || typeof entry.sessionId !== 'string') continue;
    if (entry.sessionId !== sessionId || entry.isSidechain === true) fail(3, 'CLAUDE_HOST_SESSION_MISMATCH', '', 'ungraded');
    return { path: real, line: i + 1, sha256: sha256(lines[i]), session_id: sessionId, agent_path: '/root', version: entry.version };
  }
  fail(3, 'CLAUDE_HOST_METADATA_MISSING', '', 'ungraded');
}
// The Buzz channel and thread a Buzz session belongs to (null for an interactive Claude Code session).
export function claudeBuzzRoot(path) {
  if (!isClaudeTranscriptPath(path)) return null;
  return buzzSessionRoot(headerLines(realpathSync(path)));
}

export function verifyClaudeHost(source) {
  const actual = claudeHostSource(source?.path);
  if (JSON.stringify(actual) !== JSON.stringify(source)) fail(3, 'CLAUDE_HOST_DRIFT', '', 'ungraded');
  return actual;
}

// Visible assistant chat text only: no thinking, tool calls, tool output or subagent sidechains.
export function visibleClaudeAssistantText(entry) {
  const m = entry?.message;
  if (entry?.type !== 'assistant' || entry.isSidechain === true || entry.isApiErrorMessage === true || m?.role !== 'assistant') return null;
  const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
    ? m.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  return text || null;
}
export function visibleAssistantText(entry) {
  return entry?.type === 'response_item' ? visibleCodexAssistantText(entry) : visibleClaudeAssistantText(entry);
}

// A typed human message. Meta/system injections, hook text, slash-command echoes and tool
// results are rejected; host-added <system-reminder> blocks are removed before comparison.
export function claudeHumanText(entry) {
  const m = entry?.message;
  if (entry?.type !== 'user' || entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true
    || entry.toolUseResult !== undefined || m?.role !== 'user') return null;
  if (entry.userType !== undefined && entry.userType !== 'external') return null;
  // Claude Code marks typed prompts with origin.kind=human; headless `claude -p` prompts carry no
  // origin and turnOrigin=sdk. A missing marker fails closed.
  if (entry.origin?.kind !== 'human' || entry.turnOrigin !== undefined && entry.turnOrigin !== 'human') return null;
  if (typeof entry.entrypoint === 'string' && /^sdk/i.test(entry.entrypoint)) return null;
  let text;
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content) && m.content.length && m.content.every(c => c?.type === 'text' && typeof c.text === 'string')) text = m.content.map(c => c.text).join('\n');
  else return null;
  text = text.replace(SYSTEM_REMINDER, '').trim();
  if (!text || /^<(?:command-|local-command-|bash-|user-prompt-submit-hook)/.test(text)) return null;
  return text;
}

// Reads only the tail of a live transcript; Claude may append while the Stop hook runs.
export function lastClaudeAssistantText(path, tailBytes = 2 * 1024 * 1024) {
  try {
    if (!isClaudeTranscriptPath(path)) return undefined;
    const fd = openSync(realpathSync(path), 'r');
    let text;
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - tailBytes), buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally { closeSync(fd); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try { const visible = visibleClaudeAssistantText(JSON.parse(lines[i])); if (visible) return visible; } catch { /* partial or non-chat line */ }
    }
  } catch { /* unreadable transcript: no message */ }
  return undefined;
}

function toolResultText(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.map(c => c?.type === 'text' && typeof c.text === 'string' ? { type: 'text', text: c.text } : { type: c?.type || 'unknown' });
  return [];
}
function exitCode(result) {
  if (result.is_error !== true && result.interrupted !== true) return 0;
  const text = toolResultText(result.content).map(c => c.text || '').join('\n');
  const match = /^Exit code (\d+)/m.exec(text);
  return match ? Number(match[1]) || 1 : 1;
}

// Claude Code 2.1.311 moves a large MCP result to a side file and leaves a <persisted-output> preview in the
// message, while the same transcript line keeps the original content blocks in toolUseResult (as a Bash result
// keeps its stdout there). The original blocks are read from that line, whose hash binds them like the message.
export function isPersistedPreview(content) {
  return toolResultText(content).some(c => typeof c.text === 'string' && c.text.trimStart().startsWith('<persisted-output>'));
}
function mcpResultContent(out, resultEvent) {
  if (!isPersistedPreview(out.content)) return toolResultText(out.content);
  const original = resultEvent.toolUseResult;
  if (!Array.isArray(original) || original.length === 0 || original.some(c => c?.type !== 'text' || typeof c.text !== 'string')) return null;
  if (isPersistedPreview(original)) return null;
  return original.map(c => ({ type: 'text', text: c.text }));
}

// Normalizes one original Claude Code tool call/result pair into the shape the existing
// preflight checks consume. Only a single literal tool_use per line is accepted.
export function claudeToolPair(callEvent, resultEvent) {
  const call = callEvent?.message, result = resultEvent?.message;
  if (callEvent?.type !== 'assistant' || callEvent.isSidechain === true || call?.role !== 'assistant'
    || !Array.isArray(call.content) || call.content.length !== 1 || call.content[0]?.type !== 'tool_use') return { error: 'CALL_RESULT' };
  if (resultEvent?.type !== 'user' || resultEvent.isSidechain === true || result?.role !== 'user'
    || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'tool_result') return { error: 'CALL_RESULT' };
  const use = call.content[0], out = result.content[0];
  if (typeof use.id !== 'string' || !use.id || out.tool_use_id !== use.id || typeof use.name !== 'string') return { error: 'CALL_RESULT' };
  if (resultEvent.sourceToolAssistantUUID !== undefined && resultEvent.sourceToolAssistantUUID !== callEvent.uuid) return { error: 'CALL_RESULT' };
  // Claude Code 2.1.311 omits is_error on successful MCP tool results (Bash results keep it): absent on an
  // MCP result means success; any other non-boolean value stays invalid.
  if (typeof out.is_error !== 'boolean' && !(out.is_error === undefined && use.name.startsWith('mcp__'))) return { error: 'CALL_RESULT' };
  const input = use.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'ADAPTER_UNSUPPORTED' };
  if (use.name === 'Bash') {
    const r = resultEvent.toolUseResult;
    if (typeof input.command !== 'string' || input.run_in_background === true
      || !r || typeof r.stdout !== 'string' || typeof r.stderr !== 'string' || r.interrupted === true || r.backgroundTaskId !== undefined) return { error: 'ADAPTER_UNSUPPORTED' };
    return { name: 'exec_command', input: { cmd: input.command }, output: { exit_code: exitCode({ ...out, interrupted: r.interrupted }), output: r.stdout, stderr: r.stderr },
      call_timestamp: callEvent.timestamp, output_timestamp: resultEvent.timestamp };
  }
  if (!/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(use.name)) return { error: 'ADAPTER_UNSUPPORTED' };
  const content = mcpResultContent(out, resultEvent);
  if (!content) return { error: 'ADAPTER_UNSUPPORTED' };
  return { name: use.name, input, output: { content, isError: out.is_error === true },
    call_timestamp: callEvent.timestamp, output_timestamp: resultEvent.timestamp };
}

// The Claude root orchestrator is the interactive session whose typed human line approved the
// roster. Codex rosters bind their root through the seat native_host instead.
export function orchestratorSessionId(runDir) {
  const path = join(runDir, 'control', 'approvals', 'roster.json');
  if (!existsSync(path)) return null;
  const source = readJson(path).event?.source?.path;
  if (typeof source !== 'string' || !isClaudeTranscriptPath(source)) return null;
  return claudeHostSource(source).session_id;
}
