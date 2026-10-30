import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeployedBuildBoard, validateCanonical } from '../scripts/teamwork/canonical.mjs';

// Deployed-build (web-v1) canonical boards, references/release-receipt-web-v1.md: the board declares
// targetBindingSha256 instead of commit and binds evidence metadata to the target hash. Git boards keep the
// unchanged schema. Synthetic boards only.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'scripts', 'teamwork', 'cli.mjs');
const UUID = '11111111-1111-4111-8111-111111111111';
const TARGET = 'ab'.repeat(32);
const AT = '2026-10-28T00:00:01.000Z';

function initBoard(extra) {
  const out = join(mkdtempSync(join(tmpdir(), 'qa-gui-web-board-')), 'board.json');
  const result = spawnSync(process.execPath, [CLI, 'init', '--title', 'ACME Supply', '--board-id', 'acme-web', '--run-uuid', UUID,
    '--at', '2026-10-28T00:00:00.000Z', '--build', 'index-CJjkO35e', '--environment', 'Local', '--out', out, ...extra], { encoding: 'utf8' });
  return { result, data: result.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
}
const webMeta = (over = {}) => ({ run_uuid: UUID, target_binding_sha256: TARGET, case_id: 'C1', state: 'loaded', captured_at: AT, ...over });
const gitMeta = (over = {}) => ({ run_uuid: UUID, task_base: 'a'.repeat(40), commit: 'b'.repeat(40), case_id: 'C1', state: 'loaded', captured_at: AT, ...over });
const entry = (metadata) => ({ path: 'evidence/C1-loaded.png', sha256: 'c'.repeat(64), evidence_type: 'gui-screenshot', metadata });
const messages = (data) => validateCanonical(data).errors.map((error) => `${error.path}: ${error.message}`);
// One executed behavioral case (schema 6 needs a source for it); `extra` adds case fields.
const withCase = (data, extra = {}) => ({ ...data,
  sourceItems: [{ id: 'S1', kind: 'brief', sourceSystem: 'fixture', externalKey: 'R1', title: 'Roles flow', origin: 'upstream' }],
  cases: [{ id: 'C1', title: 'Roles flow', requirement: 'R1', requirements: ['R1'], sourceRefs: ['S1'], steps: '1. Change a role.',
    expected: 'The role is saved.', status: 'FAIL', priority: 'P1', assignee: 'qa-agent', functionVerdict: 'FAIL', uiVerdict: 'PASS',
    humanSummary: { function: 'The role was not saved.', ui: 'The layout looked right.' }, machine: { rule: 'R1', selector: 'main' },
    kind: 'behavioral', states: ['loaded'], stateReceipts: [], results: [], evidence: ['qa-evidence/C1-run.mp4'], comments: [], history: [], ...extra }] });

test('init --target-binding-sha256 writes a deployed-build board that validates without commit', () => {
  const { result, data } = initBoard(['--target-binding-sha256', TARGET]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(data.targetBindingSha256, TARGET);
  assert.equal(Object.hasOwn(data, 'commit'), false);
  assert.equal(isDeployedBuildBoard(data), true);
  assert.deepEqual(messages(data), []);
  assert.deepEqual(messages({ ...data, evidenceManifest: [entry(webMeta())] }), []);
});

test('a deployed-build board rejects commit, Git evidence metadata and a malformed target hash', () => {
  const { data } = initBoard(['--target-binding-sha256', TARGET]);
  const withCommit = validateCanonical({ ...data, commit: 'a'.repeat(40) });
  assert.equal(withCommit.ok, false);
  assert.ok(withCommit.errors.some((error) => error.path === 'commit' && /L22 unknown field commit/.test(error.message) && error.ungraded === true));

  const gitShaped = messages({ ...data, evidenceManifest: [entry(gitMeta())] });
  assert.ok(gitShaped.includes('evidenceManifest[0].metadata.target_binding_sha256: missing required field target_binding_sha256'), gitShaped.join('\n'));
  assert.ok(gitShaped.some((line) => line.startsWith('evidenceManifest[0].metadata.task_base: L22 unknown field task_base')), gitShaped.join('\n'));
  assert.ok(gitShaped.some((line) => line.startsWith('evidenceManifest[0].metadata.commit: L22 unknown field commit')), gitShaped.join('\n'));
  assert.ok(messages({ ...data, evidenceManifest: [entry(webMeta({ target_binding_sha256: 'short' }))] })
    .some((line) => line.startsWith('evidenceManifest[0].metadata.target_binding_sha256: must match')));

  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 42]) {
    assert.equal(validateCanonical({ ...data, targetBindingSha256: bad }).ok, false, String(bad));
  }
});

test('Git boards validate exactly as before', () => {
  const { result, data } = initBoard([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(data.commit, '0'.repeat(40));
  assert.equal(Object.hasOwn(data, 'targetBindingSha256'), false);
  assert.equal(isDeployedBuildBoard(data), false);
  assert.deepEqual(messages(data), []);
  assert.deepEqual(messages({ ...data, evidenceManifest: [entry(gitMeta())] }), []);

  const webShaped = messages({ ...data, evidenceManifest: [entry(webMeta())] });
  assert.ok(webShaped.includes('evidenceManifest[0].metadata.task_base: missing required field task_base'), webShaped.join('\n'));
  assert.ok(webShaped.includes('evidenceManifest[0].metadata.commit: missing required field commit'), webShaped.join('\n'));
  assert.ok(webShaped.some((line) => line.startsWith('evidenceManifest[0].metadata.target_binding_sha256: L22 unknown field target_binding_sha256')), webShaped.join('\n'));
  assert.ok(messages({ ...data, commit: 'not-a-commit' }).some((line) => line.startsWith('commit: must match')));
});

test('init refuses --commit together with --target-binding-sha256', () => {
  const { result } = initBoard(['--target-binding-sha256', TARGET, '--commit', 'a'.repeat(40)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--commit and --target-binding-sha256 are exclusive/);
});

test('a deployed-build board case carries recordingSegments; a Git board case still may not', () => {
  const { data: web } = initBoard(['--target-binding-sha256', TARGET, '--language', 'en']);
  const segment = { file: 'qa-evidence/C1-run.mp4', startMs: 0, endMs: 41250 };
  assert.deepEqual(messages(withCase(web)), []);
  assert.deepEqual(messages(withCase(web, { recordingSegments: [segment, { ...segment, startMs: 41250.5, endMs: 52000 }] })), []);
  for (const [bad, path] of [[{ ...segment, startMs: -1 }, 'startMs'], [{ file: segment.file, startMs: 0 }, 'endMs'],
    [{ ...segment, note: 'x' }, 'note'], [{ ...segment, file: '' }, 'file']]) {
    assert.ok(messages(withCase(web, { recordingSegments: [bad] })).some((line) => line.startsWith(`cases[0].recordingSegments[0].${path}`)), JSON.stringify(bad));
  }
  const { data: git } = initBoard(['--language', 'en']);
  assert.deepEqual(messages(withCase(git)), []);
  assert.ok(messages(withCase(git, { recordingSegments: [segment] }))
    .some((line) => line.startsWith('cases[0].recordingSegments: L22 unknown field recordingSegments')));
});
