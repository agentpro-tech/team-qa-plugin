import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { attemptHistoryIssue, attemptSequenceIssue, effectiveAttempt, latestAttemptByCase } from '../scripts/lib/attempt-sequence.mjs';
import { boardRecordErrors } from '../scripts/lib/validators.mjs';
import { sha256 } from '../scripts/lib/core.mjs';
import { WEB_CONTRACT_SHA256 } from '../scripts/lib/deployed-target.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(root, 'scripts/teamqa.mjs');

const row = (attempt, verdict, parent = undefined, id = undefined) => ({
  case_id: 'C-1', attempt, verdict, ...(id ? { attempt_id: id } : {}),
  ...(parent ? { parent_attempt_id: parent } : {}),
  started_at: `2026-10-15T00:0${attempt}:00.000Z`,
  ended_at: `2026-10-15T00:0${attempt}:01.000Z`, timeout_ms: 10000,
});

test('legacy rows derive unique IDs and a later attempt supersedes ungraded history', () => {
  const records = [row(1, 'ungraded'), row(2, 'pass', 'C-1#1', 'attempt-2')];
  assert.equal(attemptHistoryIssue(records), null);
  const result = latestAttemptByCase(records);
  assert.equal(result.histories.get('C-1').length, 2);
  assert.equal(result.latestByCase.get('C-1'), records[1]);
});

test('legacy first UNGRADED row with no sequence fields infers attempt 1 and can parent a retry', () => {
  const legacy = { case_id: 'C-legacy', verdict: 'ungraded', reason: 'No formal proof' };
  const retry = { ...row(2, 'pass', 'C-legacy#1', 'retry-2'), case_id: 'C-legacy' };
  retry.started_at = '2026-10-15T00:01:00.000Z';
  retry.ended_at = '2026-10-15T00:01:01.000Z';
  retry.timeout_ms = 10000;
  assert.equal(attemptSequenceIssue(legacy, { governed: true }), null);
  assert.equal(effectiveAttempt(legacy), 1);
  assert.equal(attemptHistoryIssue([legacy, retry]), null);
  const selected = latestAttemptByCase([legacy]).latestByCase.get('C-legacy');
  assert.equal(selected.attempt, 1);
  assert.equal(selected.attempt_id, 'C-legacy#1');
});

test('legacy missing sequence cannot replace latest PASS or erase an older PASS', () => {
  const legacy = { case_id: 'C-legacy', verdict: 'ungraded', reason: 'No formal proof' };
  const history = [row(1, 'pass', undefined, 'pass-1'), { ...legacy, case_id: 'C-1' }];
  assert.match(attemptHistoryIssue(history), /ATTEMPT_HISTORY_ORDER/);
  assert.equal(latestAttemptByCase(history).latestByCase.get('C-1'), null);
  assert.match(attemptHistoryIssue([legacy, { ...legacy }]), /ATTEMPT_HISTORY_DUPLICATE_ID/);
});

test('broken newest history invalidates the case instead of selecting an older PASS', () => {
  const records = [row(1, 'pass', undefined, 'attempt-1'), row(2, 'pass', 'wrong-parent', 'attempt-2')];
  assert.match(attemptHistoryIssue(records), /ATTEMPT_HISTORY_PARENT/);
  assert.equal(latestAttemptByCase(records).latestByCase.get('C-1'), null);
});

test('latest invalid attempt never falls back to a prior PASS', () => {
  const records = [row(1, 'pass', undefined, 'attempt-1'), row(2, 'ungraded', 'attempt-1', 'attempt-2')];
  const result = latestAttemptByCase(records, (record) => record.attempt === 2 ? 'EVIDENCE_INVALID' : null);
  assert.equal(result.latestByCase.get('C-1'), null);
});

test('an older ungraded attempt may lack result evidence when a newer attempt validates', () => {
  const records = [row(1, 'ungraded'), row(2, 'pass', 'C-1#1', 'attempt-2')];
  const result = latestAttemptByCase(records, (record) => record.verdict === 'pass' ? null : 'NO_GRADE');
  assert.equal(result.latestByCase.get('C-1'), records[1]);
});

test('duplicate legacy attempt numbers fail closed', () => {
  assert.match(attemptHistoryIssue([row(1, 'pass'), row(1, 'ungraded')]), /ATTEMPT_HISTORY_DUPLICATE_ID/);
});

test('a partial attempt ID cannot make a graded row look complete', () => {
  assert.equal(attemptSequenceIssue({ verdict: 'pass', attempt_id: 'only-id' }, { governed: false }), 'ATTEMPT_SEQUENCE_MISSING');
});

test('duplicate or stale pending placeholders fail closed', () => {
  assert.match(attemptHistoryIssue([{ case_id: 'C-1', verdict: 'pending' }, { case_id: 'C-1', verdict: 'pending' }]), /ATTEMPT_HISTORY_PENDING/);
  assert.match(attemptHistoryIssue([{ case_id: 'C-1', verdict: 'pending' }, row(1, 'pass')]), /ATTEMPT_HISTORY_PENDING/);
});

test('pending seed rows remain visible when no attempt exists', () => {
  const pending = { case_id: 'C-1', verdict: 'pending' };
  assert.equal(latestAttemptByCase([pending]).latestByCase.get('C-1'), pending);
});

test('board record validator accepts deployed build identity with no synthetic Git SHA', () => {
  const proofPath = path.join(root, 'test/fixtures/deployed-target/proof.json');
  const bytes = readFileSync(proofPath);
  const proof = JSON.parse(bytes.toString('utf8'));
  const target = { ...proof.identity, target_binding_sha256: proof.target_binding_sha256, identity_proof: { path: 'proof.json', sha256: sha256(bytes) } };
  const record = { case_id: 'WEB-1', lane: 'gui', verdict: 'ungraded', reason: 'awaiting formal proof', evidence: [], source: 'script', run_id: 'web-run', ts: '2026-10-15T00:00:00.000Z', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded', attempt: 1, started_at: '2026-10-15T00:00:00.000Z', ended_at: '2026-10-15T00:00:01.000Z', timeout_ms: 10000, target, target_kind: 'deployed-build', target_binding_sha256: target.target_binding_sha256, contract_sha256: WEB_CONTRACT_SHA256 };
  assert.deepEqual(boardRecordErrors(record, 1), []);
});

test('board intake appends a verified retry after an ungraded attempt and preserves both rows', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'teamqa-attempt-intake-'));
  try {
    mkdirSync(path.join(cwd, 'runs/case-history'), { recursive: true });
    const runDir = path.join(cwd, 'runs/case-history');
    const trackedPath = path.join(runDir, 'tracked-plan.json');
    const boardPath = path.join(runDir, 'board.jsonl');
    const evidencePath = path.join(runDir, 'evidence/retry.txt');
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(trackedPath, JSON.stringify({ cases: ['C-1', 'C-2'].map((id) => ({ id, req_id: 'REQ-1', lane: 'code', steps: ['exercise'], expected: 'result', data: {}, priority: 'P1', kind: 'behavioral' })) }));
    const first = { case_id: 'C-1', lane: 'code', verdict: 'ungraded', reason: 'FIRST_ATTEMPT_BLOCKED', evidence: [], source: 'script', run_id: 'case-history', ts: '2026-10-15T00:00:00.000Z', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded', attempt: 1, started_at: '2026-10-15T00:00:00.000Z', ended_at: '2026-10-15T00:00:01.000Z', timeout_ms: 10000 };
    writeFileSync(boardPath, `${JSON.stringify(first)}\n`);
    writeFileSync(evidencePath, 'fresh retry proof\n');
    const retry = { ...first, verdict: 'pass', reason: undefined, evidence: ['evidence/retry.txt'], function_verdict: 'pass', ui_visual_verdict: 'pass', attempt_id: 'retry-2', attempt: 2, parent_attempt_id: 'C-1#1', started_at: '2026-10-15T00:01:00.000Z', ended_at: '2026-10-15T00:01:01.000Z' };
    const recordPath = path.join(runDir, 'record.json');
    writeFileSync(recordPath, JSON.stringify(retry));
    const result = spawnSync(process.execPath, [cli, 'board', 'add', '--file', boardPath, '--record', recordPath], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const records = readFileSync(boardPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[0].verdict, 'ungraded');
    assert.equal(records[1].verdict, 'pass');
    assert.equal(latestAttemptByCase(records).latestByCase.get('C-1').attempt_id, 'retry-2');
    const blocked = { ...first, case_id: 'C-2', reason: 'FIRST_ATTEMPT_BLOCKED' };
    writeFileSync(recordPath, JSON.stringify(blocked));
    const firstBlocked = spawnSync(process.execPath, [cli, 'board', 'add', '--file', boardPath, '--record', recordPath], { cwd, encoding: 'utf8' });
    assert.equal(firstBlocked.status, 1);
    let previousId = 'C-2#1';
    for (const attempt of [2, 3]) {
      const next = { ...blocked, attempt_id: `C-2-retry-${attempt}`, attempt, parent_attempt_id: previousId, started_at: `2026-10-15T00:0${attempt}:00.000Z`, ended_at: `2026-10-15T00:0${attempt}:01.000Z` };
      writeFileSync(recordPath, JSON.stringify(next));
      const accepted = spawnSync(process.execPath, [cli, 'board', 'add', '--file', boardPath, '--record', recordPath], { cwd, encoding: 'utf8' });
      assert.equal(accepted.status, 1, accepted.stderr);
      previousId = next.attempt_id;
    }
    const fourth = { ...blocked, verdict: 'pass', reason: undefined, evidence: ['evidence/retry.txt'], function_verdict: 'pass', ui_visual_verdict: 'pass', attempt_id: 'C-2-retry-4', attempt: 4, parent_attempt_id: previousId, started_at: '2026-10-15T00:04:00.000Z', ended_at: '2026-10-15T00:04:01.000Z' };
    writeFileSync(recordPath, JSON.stringify(fourth));
    const rejected = spawnSync(process.execPath, [cli, 'board', 'add', '--file', boardPath, '--record', recordPath], { cwd, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /ATTEMPT_LIMIT_EXCEEDED/);
    assert.equal(readFileSync(boardPath, 'utf8').trim().split('\n').length, 5);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('board intake upgrades a legacy ungraded first row to attempt 2 with derived parent', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'teamqa-legacy-attempt-'));
  try {
    mkdirSync(path.join(cwd, 'runs/legacy-history'), { recursive: true });
    const runDir = path.join(cwd, 'runs/legacy-history');
    const trackedPath = path.join(runDir, 'tracked-plan.json');
    const boardPath = path.join(runDir, 'board.jsonl');
    const evidencePath = path.join(runDir, 'evidence/retry.txt');
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(trackedPath, JSON.stringify({ cases: [{ id: 'C-legacy', req_id: 'REQ-1', lane: 'code', steps: ['exercise'], expected: 'result', data: {}, priority: 'P1', kind: 'behavioral' }] }));
    const first = { case_id: 'C-legacy', lane: 'code', verdict: 'ungraded', reason: 'FIRST_ATTEMPT_BLOCKED', evidence: [], source: 'script', run_id: 'legacy-history', ts: '2026-10-15T00:00:00.000Z', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded' };
    writeFileSync(boardPath, `${JSON.stringify(first)}\n`);
    writeFileSync(evidencePath, 'fresh retry proof\n');
    const retry = { ...first, verdict: 'pass', reason: undefined, evidence: ['evidence/retry.txt'], function_verdict: 'pass', ui_visual_verdict: 'pass', attempt_id: 'legacy-retry-2', attempt: 2, parent_attempt_id: 'C-legacy#1', started_at: '2026-10-15T00:01:00.000Z', ended_at: '2026-10-15T00:01:01.000Z', timeout_ms: 10000 };
    const recordPath = path.join(runDir, 'record.json');
    writeFileSync(recordPath, JSON.stringify(retry));
    const result = spawnSync(process.execPath, [cli, 'board', 'add', '--file', boardPath, '--record', recordPath], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const records = readFileSync(boardPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[0].attempt, undefined);
    assert.equal(records[1].attempt, 2);
    assert.equal(records[1].parent_attempt_id, 'C-legacy#1');
    assert.equal(latestAttemptByCase(records).latestByCase.get('C-legacy').attempt_id, 'legacy-retry-2');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
