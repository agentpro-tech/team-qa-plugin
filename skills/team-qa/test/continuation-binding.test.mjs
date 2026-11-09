import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveRoster, selectRoster } from '../scripts/lib/roster.mjs';
import { sha256File } from '../scripts/lib/core.mjs';
import { handleQaHook } from '../scripts/hooks/qa-lifecycle.mjs';
import { continuationCommand } from '../scripts/continuation.mjs';
import { sessionBinding } from '../scripts/hooks/plugin-gate.mjs';

// N8: a session whose run binding drifted (a new round, the run deleted, another Team QA runtime) had every Bash and MCP
// call refused, no way to unregister and a refused re-registration. Synthetic runs and transcripts only.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-binding-home-')));
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SID = '5a1c7e2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function claudeTranscript() {
  const dir = join(HOME, '.claude', 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  const base = { isSidechain: false, userType: 'external', cwd: '/work', sessionId: SID, version: '2.1.308', timestamp: new Date().toISOString() };
  const lines = [{ type: 'queue-operation', operation: 'enqueue', sessionId: SID, timestamp: base.timestamp },
    { ...base, type: 'user', uuid: 'u-1', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'Approve' }] } }].map(e => JSON.stringify(e));
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return { path: realpathSync(path), line: 2, sha256: hash(lines[1]) };
}

async function approvedRun(workspace, round) {
  const request = JSON.parse(readFileSync(join(ROOT, 'test/roster-dynamic/request-default.json'), 'utf8'));
  request.run_id = 'binding-fixture'; request.round = round;
  const catalogPath = join(ROOT, 'test/roster-dynamic/catalog-openai-v1.json');
  const runDir = join(workspace, 'runs', request.run_id);
  mkdirSync(runDir, { recursive: true });
  const approval = join(runDir, 'control', 'approvals', 'roster.json');
  if (existsSync(approval)) renameSync(approval, join(runDir, 'control', 'approvals', `roster.round-${round - 1}.json`));
  const rosterPath = join(runDir, 'roster.json');
  json(rosterPath, selectRoster({ catalog: JSON.parse(readFileSync(catalogPath, 'utf8')), request, catalogPath }));
  await approveRoster({ runDir, file: rosterPath, userEvent: { schema: 'team-qa/roster-user-event/v1', id: `approval-${round}`, actor: 'user', text: 'Approve',
    run_id: request.run_id, round, roster_hash: sha256File(rosterPath), source: claudeTranscript() } });
  return runDir;
}

async function captured(fn) {
  const lines = [], log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.log = log; }
  return JSON.parse(lines.join('\n'));
}

test('a drifted binding refuses only Dragon and board writes; other calls go ahead with a warning', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-binding-ws-'))), registry = join(workspace, 'registry');
  const runDir = await approvedRun(workspace, 1);
  process.chdir(workspace);
  await captured(() => continuationCommand('register', ['--run', 'binding-fixture', '--session', SID, '--registry', registry], { plugin: null }));
  const call = (tool_name, tool_input) => handleQaHook({ hook_event_name: 'PreToolUse', session_id: SID, tool_name, tool_use_id: `t-${tool_name}`, tool_input }, { registryDir: registry });
  assert.deepEqual(await call('Bash', { command: 'ls' }), {}, 'a valid binding lets Bash through');
  const events = () => existsSync(join(runDir, 'hook-events')) ? readdirSync(join(runDir, 'hook-events')).sort() : [];
  const before = events();
  // The run moves to a new round: its roster changes under the binding.
  await approvedRun(workspace, 2);
  const bash = await call('Bash', { command: 'git status' });
  assert.equal(bash.hookSpecificOutput, undefined, 'Bash is not refused');
  assert.match(bash.systemMessage, /CONTINUATION_SCOPE_DRIFT/);
  assert.match(bash.systemMessage, /continuation unregister --session/);
  assert.deepEqual((await call('mcp__Claude_Docs__read', { id: 'x' })).hookSpecificOutput, undefined, 'a read-only MCP call is not refused');
  for (const [tool, input] of [['mcp__Dragon_Browser__dragon_rpc', { method: 'session.list', params: {} }], ['mcp__notion__notion-create-pages', { pages: [] }],
    ['Bash', { command: 'node ~/.agents/skills/qa-gui/scripts/qa_do.mjs --method read' }]]) {
    const output = await call(tool, input);
    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny', tool);
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, 'CONTINUATION_SCOPE_DRIFT', tool);
  }
  const stop = await handleQaHook({ hook_event_name: 'Stop', session_id: SID, last_assistant_message: 'Done.' }, { registryDir: registry });
  assert.equal(stop.decision, undefined);
  assert.match(stop.systemMessage, /CONTINUATION_SCOPE_DRIFT/);
  assert.deepEqual(events(), before, 'a drifted binding records nothing in the run');
});

test('register again binds the new round and archives the drifted binding; unregister archives a binding, never deletes it', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-binding-ws-'))), registry = join(workspace, 'registry');
  await approvedRun(workspace, 1);
  process.chdir(workspace);
  const register = () => captured(() => continuationCommand('register', ['--run', 'binding-fixture', '--session', SID, '--registry', registry], { plugin: null }));
  const first = await register();
  assert.equal(first.record.round, 1);
  await assert.rejects(register(), error => error.code === 'CONTINUATION_ALREADY_REGISTERED', 'a binding that still matches its run is not replaced');
  await approvedRun(workspace, 2);
  const second = await register();
  assert.equal(second.record.round, 2);
  assert.equal(second.replaced.drift, 'CONTINUATION_SCOPE_DRIFT');
  const archived = readdirSync(join(registry, 'archive'));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(readFileSync(join(registry, 'archive', archived[0]), 'utf8')).round, 1, 'the round-1 binding is kept in the archive');
  assert.deepEqual(await handleQaHook({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } }, { registryDir: registry }), {});

  const bytes = readFileSync(join(registry, `${SID}.json`), 'utf8');
  const removed = await captured(() => continuationCommand('unregister', ['--session', SID, '--registry', registry], { plugin: null }));
  assert.equal(existsSync(join(registry, `${SID}.json`)), false);
  assert.equal(readFileSync(removed.archived, 'utf8'), bytes, 'the binding is moved to the archive unchanged');
  assert.ok(removed.archived.startsWith(join(registry, 'archive') + '/'));
  assert.equal(sessionBinding({ session_id: SID }, registry), 'none', 'the plugin hook sees no binding');
  assert.deepEqual(await handleQaHook({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'mcp__Dragon_Browser__dragon_rpc', tool_use_id: 'd1', tool_input: {} }, { registryDir: registry }), {});
  await assert.rejects(continuationCommand('unregister', ['--session', SID, '--registry', registry], { plugin: null }), error => error.code === 'CONTINUATION_NOT_REGISTERED');
  await assert.rejects(continuationCommand('unregister', ['--session', '../x', '--registry', registry], { plugin: null }), error => error.code === 'CONTINUATION_SESSION_INVALID');
  await assert.rejects(continuationCommand('unregister', ['--session', SID, '--registry', '/elsewhere'], { plugin: { id: 'team-qa@agentpro' }, registryDir: registry }), error => error.code === 'PLUGIN_REGISTRY_FIXED');
});
