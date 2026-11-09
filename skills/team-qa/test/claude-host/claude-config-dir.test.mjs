import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeHostSource, claudeProjectsRoot, isClaudeTranscriptPath } from '../../scripts/lib/host-transcript.mjs';
import { orchestratorSessionId, verifyUserMessageSource } from '../../scripts/lib/roster.mjs';
import { readNativeHookMetadata } from '../../scripts/hooks/qa-lifecycle.mjs';

// M5: ~/.claude/projects was hard-coded. With CLAUDE_CONFIG_DIR, or with ~/.claude a symlink, the roster could not be
// approved and the check that a worker runs in a session other than the root's was silently off. Synthetic
// transcripts only.
const SID = '6b2d8f3c-4e5a-4b7c-9d0e-1f2a3b4c5d6e';
const hash = value => createHash('sha256').update(value).digest('hex');
function transcript(configDir) {
  const dir = join(configDir, 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  const base = { isSidechain: false, userType: 'external', cwd: '/repo', sessionId: SID, version: '2.1.308', timestamp: new Date().toISOString() };
  const lines = [{ type: 'queue-operation', operation: 'enqueue', sessionId: SID, timestamp: base.timestamp },
    { ...base, type: 'user', uuid: 'u-1', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'Approve' }] } }].map(e => JSON.stringify(e));
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return { path, event: { text: 'Approve', source: { path, line: 2, sha256: hash(lines[1]) } } };
}
function approvedRun(path) {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-config-run-')));
  mkdirSync(join(runDir, 'control', 'approvals'), { recursive: true });
  writeFileSync(join(runDir, 'control', 'approvals', 'roster.json'), JSON.stringify({ event: { source: { path, line: 2 } } }));
  return runDir;
}

test('Claude Code transcripts are read from CLAUDE_CONFIG_DIR when it is set', () => {
  process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-config-home-')));
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-claude-config-')));
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const { path, event } = transcript(config);
    assert.equal(claudeProjectsRoot(), join(config, 'projects'));
    assert.equal(isClaudeTranscriptPath(path), true);
    assert.equal(claudeHostSource(path).session_id, SID);
    assert.equal(verifyUserMessageSource(event).e, event);
    assert.equal(orchestratorSessionId(approvedRun(path)), SID, 'the root session is known, so a worker in the same session is refused');
    assert.deepEqual(readNativeHookMetadata(path), { sessionId: SID, host: 'claude' });
    // ~/.claude is not trusted while CLAUDE_CONFIG_DIR names another folder.
    const other = transcript(join(process.env.HOME, '.claude'));
    assert.equal(isClaudeTranscriptPath(other.path), false);
    assert.throws(() => verifyUserMessageSource(other.event), error => error.code === 'HUMAN_EVENT_SOURCE_UNTRUSTED');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('a symlinked ~/.claude is followed to its real folder', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-config-home-'))), real = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-claude-real-')));
  symlinkSync(real, join(home, '.claude'));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  const { path, event } = transcript(join(home, '.claude'));
  assert.equal(isClaudeTranscriptPath(path), true);
  assert.equal(verifyUserMessageSource(event).e, event, 'the approval line is trusted through the symlink');
  assert.equal(orchestratorSessionId(approvedRun(path)), SID);
  // Inside ~/.claude only a root transcript is a trusted source.
  const saved = join(home, '.claude', 'projects', '-repo', SID, 'tool-results');
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, 'b1.txt'), 'x\n' + JSON.parse(JSON.stringify('{}')) + '\n');
  assert.throws(() => verifyUserMessageSource({ text: 'Approve', source: { path: join(saved, 'b1.txt'), line: 2, sha256: hash('{}') } }), error => error.code === 'HUMAN_EVENT_SOURCE_UNTRUSTED');
});
