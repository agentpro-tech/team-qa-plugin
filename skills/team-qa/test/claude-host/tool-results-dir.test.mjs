// Eval compat 10: the Claude GUI executor may Read the tool results Claude Code itself saved for it (results above the
// MCP output limit). Synthetic paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeToolResultsDir, dispatchArgs, dragonOutputRoot } from '../../scripts/lib/roster.mjs';

const seat = harness => ({ harness, model: 'm', reasoning_control: harness === 'claude' ? { args: ['--effort', 'medium'] } : { args: ['-c', 'model_reasoning_effort="medium"'] }, caps: { max_turns: 20 }, mcp_config: { path: '/locked/dragon.json' } });
const route = { data: { mcpServers: { Dragon_Browser: { command: '/usr/bin/node', args: ['/dragon/mcp-server.mjs'] } } }, names: ['Dragon_Browser'] };

test('the saved tool results of a session live under its own project directory', () => {
  assert.equal(claudeToolResultsDir({ runDir: '/Users/x/evals/qa.v2/ws/runs/hub-p8', attempt: 'b6267', env: { CLAUDE_CONFIG_DIR: '/cfg/.claude' } }),
    '/cfg/.claude/projects/-Users-x-evals-qa-v2-ws-runs-hub-p8/b6267/tool-results');
  assert.equal(claudeToolResultsDir({ runDir: '/r', attempt: 'a', env: {} }), join(homedir(), '.claude', 'projects', '-r', 'a', 'tool-results'));
});

test('only the routed Claude GUI seat gets its tool-results directory as one more --add-dir', () => {
  const dir = '/cfg/.claude/projects/-r/a1/tool-results';
  const args = dispatchArgs({ seat: seat('claude'), role: 'executor_gui', route, attempt: 'a1', toolResultsDir: dir });
  const at = args.indexOf(dragonOutputRoot());
  assert.deepEqual(args.slice(at - 1, at + 3), ['--add-dir', dragonOutputRoot(), '--add-dir', dir]);
  assert.equal(args.filter(arg => arg === '--add-dir').length, 2);
  assert.ok(!dispatchArgs({ seat: seat('claude'), role: 'executor_gui', route, attempt: 'a1' }).includes(dir), 'no directory, no extra flag');
  assert.ok(!dispatchArgs({ seat: seat('claude'), role: 'analyst', route: null, attempt: 'a2', toolResultsDir: dir }).includes('--add-dir'));
  assert.ok(!dispatchArgs({ seat: seat('codex'), role: 'executor_gui', route, attempt: 'a3', toolResultsDir: dir }).includes(dir));
});
