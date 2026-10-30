import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Each Claude-host guard must be load-bearing: removing it turns the suite red.
const root = fileURLToPath(new URL('../../', import.meta.url));
const test = 'test/claude-host/claude-host.test.mjs';
const cases = [
  { id: 'meta-human', file: 'scripts/lib/host-transcript.mjs', from: "entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true", to: "entry.isSidechain === true || entry.isCompactSummary === true", failed: 'only typed human lines count' },
  { id: 'origin-human', file: 'scripts/lib/host-transcript.mjs', from: "if (entry.origin?.kind !== 'human' || entry.turnOrigin !== undefined", to: "if (entry.turnOrigin !== undefined", failed: 'only typed human lines count' },
  { id: 'turn-origin', file: 'scripts/lib/host-transcript.mjs', from: " || entry.turnOrigin !== undefined && entry.turnOrigin !== 'human') return null;", to: ") return null;", failed: 'only typed human lines count' },
  { id: 'host-headless', file: 'scripts/lib/host-transcript.mjs', from: "fail(3, 'CLAUDE_HOST_HEADLESS', '', 'ungraded');", to: '{}', failed: 'Claude root transcript yields' },
  { id: 'approval-root-transcript', file: 'scripts/lib/roster.mjs', from: "requireValue(isClaudeTranscriptPath(path),'HUMAN_EVENT_SOURCE_UNTRUSTED');", to: '{}', failed: 'roster approval from a Claude transcript' },
  { id: 'preflight-orchestrator', file: 'scripts/lib/tool-preflight.mjs', from: "must(root && ref.host.session_id === root, 'HOST_NOT_ORCHESTRATOR');", to: '{}', failed: 'preflight reads original Claude tool pairs' },
  { id: 'stop-repeat-guard', file: 'scripts/hooks/qa-lifecycle.mjs', from: "decision.disposition === 'WAIT' && !repeated && ", to: "decision.disposition === 'WAIT' && ", failed: 'lifecycle hook binds only' },
  { id: 'external-user', file: 'scripts/lib/host-transcript.mjs', from: "if (entry.userType !== undefined && entry.userType !== 'external') return null;", to: '', failed: 'only typed human lines count' },
  { id: 'headless-human', file: 'scripts/lib/host-transcript.mjs', from: "if (typeof entry.entrypoint === 'string' && /^sdk/i.test(entry.entrypoint)) return null;", to: '', failed: 'only typed human lines count' },
  { id: 'sidechain-chat', file: 'scripts/lib/host-transcript.mjs', from: "if (entry?.type !== 'assistant' || entry.isSidechain === true || ", to: "if (entry?.type !== 'assistant' || ", failed: 'visible assistant text excludes' },
  { id: 'tool-pair-source', file: 'scripts/lib/host-transcript.mjs', from: "if (resultEvent.sourceToolAssistantUUID !== undefined && resultEvent.sourceToolAssistantUUID !== callEvent.uuid) return { error: 'CALL_RESULT' };", to: '', failed: 'tool pairs normalize' },
  { id: 'mcp-is-error-scope', file: 'scripts/lib/host-transcript.mjs', from: "!(out.is_error === undefined && use.name.startsWith('mcp__'))", to: '!(out.is_error === undefined)', failed: 'tool pairs normalize' },
  { id: 'mcp-is-error-boolean', file: 'scripts/lib/host-transcript.mjs', from: 'isError: out.is_error === true },', to: 'isError: out.is_error },', failed: 'tool pairs normalize' },
  { id: 'background-shell', file: 'scripts/lib/host-transcript.mjs', from: "input.run_in_background === true\n      || ", to: '', failed: 'tool pairs normalize' },
  { id: 'host-session', file: 'scripts/lib/host-transcript.mjs', from: "if (entry.sessionId !== sessionId || entry.isSidechain === true) fail(3, 'CLAUDE_HOST_SESSION_MISMATCH', '', 'ungraded');", to: '', failed: 'Claude root transcript yields' },
  { id: 'root-depth', file: 'scripts/lib/host-transcript.mjs', from: 'return dirname(project) === root && ', to: 'return ', failed: 'Claude root transcript yields' },
  { id: 'approval-claude-branch', file: 'scripts/lib/roster.mjs', from: "if(isClaudeTranscriptPath(path))requireValue(claudeHumanText(entry)===e.text.trim(),'HUMAN_EVENT_NOT_USER');\n  else{", to: '{', failed: 'roster approval from a Claude transcript' },
  { id: 'preflight-host', file: 'scripts/lib/tool-preflight.mjs', from: "try { verifyClaudeHost(ref.host); } catch { fail(3, 'PREFLIGHT_HOST_DRIFT', '', 'ungraded'); }", to: '', failed: 'preflight reads original Claude tool pairs' },
  { id: 'preflight-marker', file: 'scripts/lib/tool-preflight.mjs', from: '?.includes(binding))bound=true;', to: '!==undefined)bound=true;', failed: 'preflight reads original Claude tool pairs' },
  { id: 'stop-last-message', file: 'scripts/hooks/qa-lifecycle.mjs', from: "input.last_assistant_message ?? (claudeStop ? lastClaudeAssistantText(input.transcript_path) : undefined)", to: 'input.last_assistant_message', failed: 'lifecycle hook binds only' },
  { id: 'worker-env', file: 'scripts/lib/roster.mjs', from: 'const CLAUDE_WORKER_ENV=/^(?:PATH|', to: 'const CLAUDE_WORKER_ENV=/|^(?:PATH|', failed: 'Claude workers drop parent-session' },
];
for (const item of cases) {
  const copy = mkdtempSync(join(tmpdir(), `tq-claude-mutant-${item.id}-`));
  for (const name of ['scripts', 'references', 'agents', 'SKILL.md', 'contracts', 'schemas', 'test/claude-host']) {
    mkdirSync(join(copy, name, '..'), { recursive: true });
    cpSync(join(root, name), join(copy, name), { recursive: true });
  }
  const path = join(copy, item.file), before = readFileSync(path, 'utf8');
  assert.ok(before.includes(item.from), `mutation missing: ${item.id}`);
  const control = spawnSync(process.execPath, ['--test', join(copy, test)], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(control.status, 0, `positive control failed: ${item.id}\n${control.stdout}${control.stderr}`);
  writeFileSync(path, before.replace(item.from, item.to));
  const result = spawnSync(process.execPath, ['--test', join(copy, test)], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, `surviving mutation: ${item.id}\n${result.stdout}${result.stderr}`);
  assert.ok(result.stdout.includes(item.failed), `${item.id}: expected failure in "${item.failed}"\n${result.stdout}`);
  console.log(`MUTATION_KILLED ${item.id} retained=${copy}`);
}
