import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { caseAttestationIssue, caseDispatchBudget, sequenceCaseAttestation, startCaseDispatch } from '../../scripts/lib/run-contract.mjs';
import { caseRowsVerdict } from '../../scripts/lib/child-verdict.mjs';

// Upgrade U2: case-scoped GUI dispatch on the Claude CLI route. A run directory with only what these functions read:
// the document lock, the locked tracked plan and the role bindings (synthetic fixtures, never evidence of a live run).
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => `${JSON.stringify(value, null, 2)}\n`;
const CASES = ['TC-01', 'TC-02'].map(id => ({ id, req_id: 'REQ-1', lane: 'gui', steps: ['Open the page'], expected: 'Shown', data: {}, priority: 'P1',
  kind: 'static', title: id, sourceRefs: ['SRC-1'], taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] }));
function run() {
  const runDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-case-dispatch-'))), 'runs', 'r1');
  mkdirSync(join(runDir, 'role-bindings'), { recursive: true });
  writeFileSync(join(runDir, 'tracked-plan.json'), text({ schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'brief', sourceSystem: 'brief', externalKey: 'K-1', title: 'One', origin: 'upstream' }], cases: CASES }));
  writeFileSync(join(runDir, 'docs-lock.json'), text({ schema: 'team-qa/docs-lock/v1', run_id: 'r1', round: 1, roster_hash: 'a'.repeat(64),
    artifacts: { tracked: { path: 'tracked-plan.json', sha256: hash(readFileSync(join(runDir, 'tracked-plan.json'))) } } }));
  return runDir;
}
const attestation = (session, caseId) => ({ schema: 'team-qa/role-attestation/v1', run_id: 'r1', round: 1, roster_hash: 'a'.repeat(64), role: 'executor_gui',
  agent_id: `claude:${session}`, session_id: session, source: { kind: 'claude-stream', path: 'x', sha256: 'b'.repeat(64) }, graded: true, dispatch_case_id: caseId });
const code = fn => { try { fn(); return null; } catch (error) { return error.code; } };
const codeAsync = async fn => { try { await fn(); return null; } catch (error) { return error.code; } };

test('a case-scoped start is recorded before any worker, at most three per case and cases × 3 per run', async () => {
  const runDir = run();
  assert.deepEqual(caseDispatchBudget({ runDir, role: 'executor_gui', caseId: 'TC-01' }), { caseId: 'TC-01', used: 0, left: 3, run_used: 0, run_limit: 6 });
  for (let n = 1; n <= 3; n++) assert.equal((await startCaseDispatch({ runDir, role: 'executor_gui', caseId: 'TC-01', attempt: `attempt-tc01-${n}` })).used, n);
  assert.equal(await codeAsync(() => startCaseDispatch({ runDir, role: 'executor_gui', caseId: 'TC-01', attempt: 'attempt-tc01-4' })), 'DISPATCH_CASE_ATTEMPTS_EXHAUSTED');
  assert.equal(caseDispatchBudget({ runDir, role: 'executor_gui', caseId: 'TC-02' }).left, 3);
  const ledger = readFileSync(join(runDir, 'dispatch/executor_gui/case-dispatches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(ledger.map(row => [row.case_id, row.attempt]), [1, 2, 3].map(n => ['TC-01', `attempt-tc01-${n}`]));
  assert.equal(code(() => caseDispatchBudget({ runDir, role: 'executor_gui', caseId: 'TC-09' })), 'DISPATCH_CASE_NOT_IN_PLAN');
  assert.equal(code(() => caseDispatchBudget({ runDir, role: 'executor_gui', caseId: '../TC-01' })), 'DISPATCH_CASE_INVALID');
  assert.equal(code(() => caseDispatchBudget({ runDir, role: 'designer', caseId: 'TC-01' })), 'DISPATCH_CASE_ROLE');
  // A legacy primary binding without a case counts against every case.
  const other = run();
  writeFileSync(join(other, 'role-bindings/executor_gui.json'), text({ ...attestation('s-legacy', 'TC-01'), dispatch_case_id: undefined }));
  assert.equal(caseDispatchBudget({ runDir: other, role: 'executor_gui', caseId: 'TC-02' }).used, 1);
});

test('the first bound case dispatch stays v1 at the primary path; later ones are v2 attempts chained to the one before', () => {
  const runDir = run();
  const first = sequenceCaseAttestation({ runDir, attestation: attestation('11111111-aaaa', 'TC-01') });
  assert.equal(first.schema, 'team-qa/role-attestation/v1');
  assert.equal(caseAttestationIssue(runDir, first), null);
  writeFileSync(join(runDir, 'role-bindings/executor_gui.json'), text(first));
  const second = sequenceCaseAttestation({ runDir, attestation: attestation('22222222-bbbb', 'TC-02') });
  assert.deepEqual([second.schema, second.dispatch_attempt_seq, second.dispatch_attempt_id], ['team-qa/role-attestation/v2', 2, '22222222-bbbb']);
  assert.equal(second.dispatch_chain_sha256, hash(`${hash(readFileSync(join(runDir, 'role-bindings/executor_gui.json')))}\n22222222-bbbb\nTC-02`));
  assert.equal(caseAttestationIssue(runDir, second), null);
  mkdirSync(join(runDir, 'role-bindings/executor_gui'));
  writeFileSync(join(runDir, 'role-bindings/executor_gui/attempt-2.json'), text(second));
  const third = sequenceCaseAttestation({ runDir, attestation: attestation('33333333-cccc', 'TC-02') });
  assert.equal(third.dispatch_attempt_seq, 3);
  assert.equal(caseAttestationIssue(runDir, third), null);
  // Any drift breaks the binding: a rewritten predecessor, another case, another session, an unknown case or route.
  assert.equal(caseAttestationIssue(runDir, { ...third, dispatch_case_id: 'TC-01' }), 'ROLE_DISPATCH_CHAIN');
  assert.equal(caseAttestationIssue(runDir, { ...third, dispatch_attempt_id: '44444444-dddd' }), 'ROLE_DISPATCH_ATTEMPT_BINDING');
  assert.equal(caseAttestationIssue(runDir, { ...first, dispatch_case_id: 'TC-09' }), 'ROLE_DISPATCH_CASE_NOT_IN_PLAN');
  assert.equal(caseAttestationIssue(runDir, { ...first, source: { ...first.source, kind: 'codex-stream' } }), 'ROLE_DISPATCH_CASE_BINDING');
  assert.equal(caseAttestationIssue(runDir, { ...first, role: 'designer' }), 'ROLE_DISPATCH_CASE_BINDING');
  writeFileSync(join(runDir, 'role-bindings/executor_gui/attempt-2.json'), text({ ...second, agent_id: 'claude:changed' }));
  assert.equal(caseAttestationIssue(runDir, third), 'ROLE_DISPATCH_CHAIN');
  // An attestation without a case is not case-scoped: unchanged behaviour.
  assert.equal(caseAttestationIssue(runDir, { ...first, dispatch_case_id: undefined, source: { kind: 'codex-native' } }), 'ROLE_DISPATCH_CASE_BINDING');
  const { dispatch_case_id: _drop, ...plain } = first;
  assert.equal(caseAttestationIssue(runDir, plain), null);
});

test('a case verdict from its own atomic rows: pass only when every row passes', () => {
  assert.equal(caseRowsVerdict([{ result: 'PASS' }, { result: 'PASS' }]), 'pass');
  assert.equal(caseRowsVerdict([{ result: 'PASS' }, { result: 'FAIL' }]), 'fail');
  assert.equal(caseRowsVerdict([{ result: 'PASS' }, { result: 'UNGRADED' }]), 'ungraded');
  assert.equal(caseRowsVerdict([{ result: 'UNGRADED' }, { result: 'FAIL' }]), 'fail');
  assert.equal(caseRowsVerdict([]), 'ungraded');
  assert.equal(caseRowsVerdict(null), 'ungraded');
});

test('executor inputs: regular files under --inputs, listed before anything runs; symlinks and oversize sets refused (U3)', async () => {
  const { listDispatchInputs } = await import('../../scripts/lib/roster.mjs');
  const { symlinkSync } = await import('node:fs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-inputs-')));
  mkdirSync(join(base, 'kit', 'data'), { recursive: true });
  writeFileSync(join(base, 'kit', 'brief.md'), '# Brief\n');
  writeFileSync(join(base, 'kit', 'data', 'rows.csv'), 'a,b\n1,2\n');
  assert.deepEqual(listDispatchInputs(join(base, 'kit')).map(f => f.rel), ['brief.md', 'data/rows.csv']);
  assert.equal(code(() => listDispatchInputs(join(base, 'missing'))), 'DISPATCH_INPUTS_NOT_DIRECTORY');
  symlinkSync(join(base, 'kit', 'brief.md'), join(base, 'kit', 'link.md'));
  assert.equal(code(() => listDispatchInputs(join(base, 'kit'))), 'DISPATCH_INPUT_SYMLINK');
  mkdirSync(join(base, 'many'));
  for (let n = 0; n < 201; n++) writeFileSync(join(base, 'many', `f${String(n).padStart(3, '0')}.txt`), 'x');
  assert.equal(code(() => listDispatchInputs(join(base, 'many'))), 'DISPATCH_INPUTS_TOO_LARGE');
});

// M2: parallel dispatches (separate processes) appended to the case ledger without a lock: lines were lost (33 of 200
// kept) and the per-case limit was under-counted.
function runWithCases(count) {
  const runDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-case-ledger-'))), 'runs', 'r1');
  mkdirSync(join(runDir, 'role-bindings'), { recursive: true });
  const cases = Array.from({ length: count }, (_, n) => ({ ...CASES[0], id: `TC-${String(n + 1).padStart(3, '0')}`, title: `case ${n + 1}` }));
  writeFileSync(join(runDir, 'tracked-plan.json'), text({ schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'brief', sourceSystem: 'brief', externalKey: 'K-1', title: 'One', origin: 'upstream' }], cases }));
  writeFileSync(join(runDir, 'docs-lock.json'), text({ schema: 'team-qa/docs-lock/v1', run_id: 'r1', round: 1, roster_hash: 'a'.repeat(64),
    artifacts: { tracked: { path: 'tracked-plan.json', sha256: hash(readFileSync(join(runDir, 'tracked-plan.json'))) } } }));
  return { runDir, cases };
}
async function parallelStarts(runDir, starts) {
  const { spawn } = await import('node:child_process');
  const module = new URL('../../scripts/lib/run-contract.mjs', import.meta.url).href;
  const script = `const { startCaseDispatch } = await import(${JSON.stringify(module)});
try { await startCaseDispatch({ runDir: process.argv[1], role: 'executor_gui', caseId: process.argv[2], attempt: process.argv[3] }); console.log('STARTED'); }
catch (error) { console.log('REFUSED ' + (error.code || error.message)); }`;
  return Promise.all(starts.map(([caseId, attempt]) => new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, runDir, caseId, attempt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => done(out.trim()));
  })));
}
test('200 parallel case dispatches keep 200 ledger lines, and parallel starts of one case stop at three', { timeout: 240000 }, async () => {
  const { runDir, cases } = runWithCases(100);
  const starts = Array.from({ length: 200 }, (_, n) => [cases[n % 100].id, `attempt-parallel-${String(n).padStart(3, '0')}`]);
  const outcomes = await parallelStarts(runDir, starts);
  assert.equal(outcomes.filter((o) => o === 'STARTED').length, 200, outcomes.filter((o) => o !== 'STARTED').slice(0, 3).join('\n'));
  const ledger = readFileSync(join(runDir, 'dispatch/executor_gui/case-dispatches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.length, 200);
  assert.equal(new Set(ledger.map((row) => row.attempt)).size, 200);
  const same = runWithCases(2);
  const raced = await parallelStarts(same.runDir, Array.from({ length: 8 }, (_, n) => ['TC-001', `attempt-same-case-${n}`]));
  assert.equal(raced.filter((o) => o === 'STARTED').length, 3, raced.join('\n'));
  assert.ok(raced.filter((o) => o !== 'STARTED').every((o) => o === 'REFUSED DISPATCH_CASE_ATTEMPTS_EXHAUSTED'), raced.join('\n'));
  assert.equal(caseDispatchBudget({ runDir: same.runDir, role: 'executor_gui', caseId: 'TC-001' }).used, 3);
});
