import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { claudeBashResults, claudeFirstUserText, claudeReviewerErrors, claudeReviewArgv, claudeSourcesOrdered,
  CLAUDE_REVIEW_DISALLOWED_TOOLS } from '../../scripts/lib/board-review-claude.mjs';

// Synthetic Claude Code transcripts for the Claude-host board review route; never evidence of a live run.
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-claude-board-')));
const ROOT_SID = '320de890-ddd4-5759-ac80-46d91944fd3d';
const REVIEWER_SID = '9b2f4c1e-7a3d-4e5f-8a1b-2c3d4e5f6a7b';
const hash = s => createHash('sha256').update(s).digest('hex');
const base = (extra = {}) => ({ isSidechain: false, userType: 'external', cwd: '/repo', sessionId: ROOT_SID, version: '2.1.311', timestamp: '2026-10-27T13:00:00.000Z', ...extra });
const bashCall = (id, command) => base({ type: 'assistant', uuid: `c-${id}`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const bashResult = (id, stdout, extra = {}) => base({ type: 'user', uuid: `r-${id}`, sourceToolAssistantUUID: `c-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: stdout, is_error: false }] },
  toolUseResult: { stdout, stderr: '', interrupted: false }, ...extra });
function write(name, entries) {
  const path = join(DIR, name);
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}
const INTENT = 'a'.repeat(64);
const PREPARE = "'/usr/bin/env' 'TEAMQA_QA_GUI_ROOT=/g' '/node' '/tq/scripts/board-quality.mjs' 'prepare' '--file' '/run/qa-board.json'";
const DISPATCH = "'/node' '/tq/scripts/board-quality.mjs' 'dispatch' '--intent' '/run/review/intent.json'";
const MESSAGE = 'TEAMQA_BOARD_REVIEW board=b revision=0 sha256=' + 'c'.repeat(64) + '\nReview the locked board...\n<review-protocol>\nfacts\n</review-protocol>\n';

test('root Bash calls are found by marker with their exact command, exit status and original line', () => {
  const path = write('root.jsonl', [
    base({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Run QA' } }),
    bashCall('p1', PREPARE), bashResult('p1', `TEAMQA_NATIVE_PREPARED sha256=${INTENT}\n{}`),
    bashCall('x1', 'echo TEAMQA_NATIVE_PREPARED'), bashResult('x1', 'unrelated'),
    { ...bashCall('s1', DISPATCH), isSidechain: true }, bashResult('s1', `TEAMQA_BOARD_REVIEW_DISPATCHED intent=${INTENT} session=${REVIEWER_SID}`),
    bashCall('d1', DISPATCH), bashResult('d1', `TEAMQA_BOARD_REVIEW_DISPATCHED intent=${INTENT} session=${REVIEWER_SID} child=/x`),
  ]);
  const prepare = claudeBashResults(path, `TEAMQA_NATIVE_PREPARED sha256=${INTENT}`);
  assert.equal(prepare.length, 1);
  assert.equal(prepare[0].command, PREPARE);
  assert.equal(prepare[0].exitCode, 0);
  assert.equal(prepare[0].result.line, 3);
  const dispatch = claudeBashResults(path, `TEAMQA_BOARD_REVIEW_DISPATCHED intent=${INTENT} session=${REVIEWER_SID}`);
  assert.equal(dispatch.length, 1, 'sidechain calls never count');
  assert.equal(dispatch[0].command, DISPATCH);
  assert.equal(claudeSourcesOrdered(prepare[0], dispatch[0]), true);
  assert.equal(claudeSourcesOrdered(dispatch[0], prepare[0]), false);
});

test('reviewer argv runs one tool-less turn with no settings or MCP', () => {
  const argv = claudeReviewArgv({ model: 'claude-sonnet-5-5', effort: 'medium', sessionId: REVIEWER_SID });
  const at = flag => argv[argv.indexOf(flag) + 1];
  assert.equal(at('--tools'), '');
  assert.equal(at('--max-turns'), '1');
  assert.equal(at('--setting-sources'), '');
  assert.equal(at('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(at('--session-id'), REVIEWER_SID);
  assert.equal(at('--permission-mode'), 'plan');
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'WebFetch']) assert.ok(CLAUDE_REVIEW_DISALLOWED_TOOLS.split(',').includes(tool));
  assert.ok(argv.includes('--strict-mcp-config'));
});

test('reviewer proof requires the locked message, observed model and effort, no tools and an independent session', () => {
  const childPath = write(`${REVIEWER_SID}.jsonl`, [
    { type: 'user', sessionId: REVIEWER_SID, isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', sessionId: REVIEWER_SID, message: { role: 'user', content: MESSAGE.trim() } },
    { type: 'assistant', sessionId: REVIEWER_SID, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"verdict":"PASS"}' }] } },
  ]);
  const child = claudeFirstUserText(childPath);
  assert.equal(child.sessionId, REVIEWER_SID);
  assert.equal(child.text, MESSAGE.trim());
  const intent = { spawn: { model: 'claude-sonnet-5-5', reasoning_effort: 'medium', message: MESSAGE },
    host: { session_id: ROOT_SID }, author: { session_id: ROOT_SID } };
  const dispatch = { session_id: REVIEWER_SID };
  const parsed = { provider: 'anthropic', errors: [], session_id: REVIEWER_SID, observed: { model: 'claude-sonnet-5-5', reasoning: 'medium' },
    tool_log: [], metadata_source: { kind: 'claude-transcript', path: childPath }, verdictText: '{"verdict":"PASS"}' };
  const ok = { intent, dispatch, parsed, child, childSourcePath: childPath };
  assert.deepEqual(claudeReviewerErrors(ok), []);
  const bad = (patch, code) => assert.ok(claudeReviewerErrors({ ...ok, ...patch(ok) }).includes(code), code);
  bad(o => ({ parsed: { ...o.parsed, tool_log: [{ tool: 'Read', path: '/etc/hosts', status: 'completed' }] } }), 'REVIEWER_TOOL_USED');
  bad(o => ({ parsed: { ...o.parsed, observed: { model: 'claude-opus-5-5', reasoning: 'medium' } } }), 'REVIEWER_MODEL');
  bad(o => ({ parsed: { ...o.parsed, observed: { model: 'claude-sonnet-5-5', reasoning: 'high' } } }), 'REVIEWER_EFFORT');
  bad(o => ({ parsed: { ...o.parsed, session_id: ROOT_SID }, dispatch: { session_id: ROOT_SID }, child: { ...o.child, sessionId: ROOT_SID } }), 'REVIEWER_NOT_INDEPENDENT');
  bad(o => ({ dispatch: { session_id: '11111111-2222-4333-8444-555555555555' } }), 'REVIEWER_SESSION');
  bad(o => ({ child: { ...o.child, text: 'a different prompt' } }), 'REVIEWER_MESSAGE_NOT_SUPPLIED');
  bad(o => ({ childSourcePath: join(DIR, 'other.jsonl') }), 'REVIEWER_TRANSCRIPT');
  bad(o => ({ parsed: { ...o.parsed, errors: ['MISSING_TERMINAL'] } }), 'MISSING_TERMINAL');
  bad(o => ({ parsed: { ...o.parsed, verdictText: ' ' } }), 'REVIEWER_VERDICT_MISSING');
  assert.equal(hash(MESSAGE).length, 64);
});
