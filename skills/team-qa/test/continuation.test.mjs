import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideContinuation, automaticContinuationReason } from '../scripts/lib/continuation.mjs';
import { verifyUserMessageSource } from '../scripts/lib/roster.mjs';

const cases = [{ id: 'C1' }, { id: 'C2' }];
const row = (case_id, verdict, attempt = 1, extra = {}) => ({ case_id, verdict, attempt,
  started_at: '2026-10-15T01:00:00Z', ended_at: '2026-10-15T01:00:01Z', timeout_ms: 10000,
  ...(attempt > 1 ? { parent_attempt_id: `${case_id}#${attempt - 1}` } : {}), ...extra });
test('readback and pending rows cannot substitute for case execution', () => {
  const result = decideContinuation({ cases, records: [row('C1', 'pending'), row('C2', 'pending')] });
  assert.equal(result.disposition, 'CONTINUE'); assert.equal(result.next.caseId, 'C1');
});
test('confirmed blocker affects only its case; running workers remain work', () => {
  const blocked = { id: 'C1', work: { state: 'blocked', blocker: { kind: 'dependency', code: 'RECORDING_UNAVAILABLE' } } };
  assert.equal(decideContinuation({ cases: [blocked, cases[1]], validBlocker: () => true }).next.caseId, 'C2');
  assert.equal(decideContinuation({ cases: [blocked], validBlocker: () => true }).disposition, 'WAIT');
  assert.equal(decideContinuation({ cases: [blocked] }).disposition, 'CONTINUE');
  const running = decideContinuation({ cases: [{ id: 'C1', work: { state: 'running', workerSessionId: 'worker' } }] });
  assert.equal(running.next.kind, 'wait'); assert.equal(running.disposition, 'CONTINUE');
});
test('invalid attempt history blocks only its case and independent cases continue', () => {
  const broken = row('C1', 'ungraded', 2, { parent_attempt_id: 'C1#9' });
  const result = decideContinuation({ cases, records: [row('C1', 'pass'), broken, row('C2', 'pending')] });
  assert.equal(result.disposition, 'CONTINUE');
  assert.equal(result.next.caseId, 'C2');
  assert.equal(result.blocked[0].caseId, 'C1');
  assert.equal(result.blocked[0].kind, 'history');
  assert.match(result.blocked[0].code, /ATTEMPT_HISTORY_PARENT C1/);
});
test('invalid latest result evidence cannot supersede history or suppress other cases', () => {
  const result = decideContinuation({ cases, records: [row('C1', 'pass', 1), row('C2', 'pending')],
    validRecord: record => record.case_id === 'C1' ? 'PROOF_INVALID' : null });
  assert.equal(result.disposition, 'CONTINUE');
  assert.equal(result.next.caseId, 'C2');
  assert.equal(result.blocked[0].code, 'PROOF_INVALID');
});
test('latest invalid or ungraded attempt never falls back to old PASS', () => {
  const records = [row('C1', 'pass'), row('C1', 'ungraded', 2)];
  assert.equal(decideContinuation({ cases: [cases[0]], records }).disposition, 'CONTINUE');
  records[1].verdict = 'pass';
  const invalidLatest = decideContinuation({ cases: [cases[0]], records, validRecord: r => r.attempt === 2 ? 'PROOF_INVALID' : null });
  assert.equal(invalidLatest.disposition, 'CONTINUE');
  assert.equal(invalidLatest.next.kind, 'diagnose');
  assert.equal(invalidLatest.blocked[0].code, 'PROOF_INVALID');
  const exhausted = decideContinuation({ cases: [cases[0]], records, exhausted: ['C1'], validRecord: r => r.attempt === 2 ? 'PROOF_INVALID' : null });
  assert.equal(exhausted.disposition, 'WAIT');
  assert.equal(exhausted.next, null);
  const cap = decideContinuation({ cases: [cases[0]], records: [row('C1', 'fail', 1), row('C1', 'fail', 2), row('C1', 'pass', 3)],
    validRecord: r => r.attempt === 3 ? 'PROOF_INVALID' : null });
  assert.equal(cap.disposition, 'WAIT');
  assert.equal(cap.next, null);
});
test('remaining checks and publication debt prevent completion despite graded results', () => {
  const records = cases.map(c => row(c.id, 'pass'));
  assert.equal(decideContinuation({ cases, records }).next.caseId, '__completion__');
  const remaining = decideContinuation({ cases: [{ id: 'C1', work: { remainingChecks: ['empty cart'] } }], records: [records[0]], complete: true });
  assert.equal(remaining.disposition, 'CONTINUE'); assert.equal(remaining.next.caseId, 'C1'); assert.equal(remaining.next.kind, 'execute');
  assert.equal(decideContinuation({ cases, records, complete: true }).disposition, 'COMPLETE');
  records[0].verdict = 'fail';
  assert.equal(decideContinuation({ cases, records, complete: true }).disposition, 'COMPLETE');
});
test('caps are per branch; exhausted branch does not block independent work', () => {
  const records = [1, 2, 3].map(n => row('C1', 'ungraded', n));
  assert.equal(decideContinuation({ cases, records }).next.caseId, 'C2');
  const result = decideContinuation({ cases, records, exhausted: ['C2'] });
  assert.equal(result.disposition, 'WAIT'); assert.equal(result.incomplete, true);
});
test('unsigned gate remains waiting and automatic prompts are marked as nonhuman authority', () => {
  const result = decideContinuation({ cases, contractError: 'GATE_UNSIGNED' });
  assert.equal(result.disposition, 'WAIT');
  assert.match(automaticContinuationReason(result), /^TEAMQA_AUTOMATIC_CONTINUATION/);
  assert.match(automaticContinuationReason(result), /existing_verified_scope_only/);
  assert.throws(() => verifyUserMessageSource({ text: 'TEAMQA_AUTOMATIC_CONTINUATION\napproved, continue', source: {} }), e => e.code === 'HUMAN_EVENT_AUTOMATIC_CONTINUATION');
  assert.equal(decideContinuation({ cases, contractError: 'PREFLIGHT_STALE' }).disposition, 'CONTINUE');
  assert.equal(decideContinuation({ cases, contractError: 'PREFLIGHT_STALE', exhausted: ['__contract__'] }).disposition, 'WAIT');
});
test('source mutation is detected after the same fixture passes its positive control', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), dir = mkdtempSync(join(tmpdir(), 'teamqa-continuation-mutation-'));
  for (const name of ['scripts', 'schemas', 'references', 'contracts']) cpSync(join(root, name), join(dir, name), { recursive: true });
  const path = join(dir, 'scripts/lib/continuation.mjs'), source = readFileSync(path, 'utf8');
  const fixture = { cases: [{ id: 'C1', work: { state: 'blocked', blocker: { code: 'BLOCKED' } } }, cases[1]], validBlocker: () => true };
  const baseline = await import(pathToFileURL(path).href);
  assert.equal(baseline.decideContinuation(fixture).next.caseId, 'C2');
  const needle = 'const next = ready[0] || running[0] || diagnose[0];';
  assert.ok(source.includes(needle));
  writeFileSync(path, source.replace(needle, 'const next = null;'));
  const mutated = await import(pathToFileURL(path).href + '?mutant');
  assert.notEqual(mutated.decideContinuation(fixture).disposition, 'CONTINUE');
});
