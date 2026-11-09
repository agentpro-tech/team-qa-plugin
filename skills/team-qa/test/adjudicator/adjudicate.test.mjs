// Upgrade R2a acceptance: a PASS case missing one step is contested; the input audit proves the executor's verdict
// and narrative are absent from the exact payload sent; a pointer that does not resolve makes the result ABSTAIN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ADJUDICATION_OUTCOMES, adjudicateCase, adjudicatedVerdict, auditInput, deriveOutcome, freezeChecklist, verifyAdjudication,
} from '../../scripts/lib/adjudicator.mjs';
import { fakeEngine, payloadOf } from './fake-engine.mjs';
import { CHILD_NOTE, NARRATIVE, REASON, SEAT, SECRET, failRecord, fixtureRun } from './support.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const read = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));
const caseDir = (f) => join(f.runDir, 'adjudication', f.caseId);
const attemptDir = (f) => join(caseDir(f), 'attempt-1');
async function adjudicate(f, { mode = 'honest', calls = [], evidence = [], ...rest } = {}) {
  const engine = fakeEngine({ mode, calls });
  const result = await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine, attestationPath: f.attestation, boardPath: f.qaBoard,
    evidencePaths: [f.rel.dom, ...evidence], ...rest });
  return { result, calls };
}

test('acceptance 1: a PASS case missing one step is contested; the complete case is confirmed', async () => {
  const missing = fixtureRun({ missingStep: true });
  const { result } = await adjudicate(missing);
  assert.equal(result.outcome, 'CONTEST');
  assert.equal(result.items.find((i) => i.id === 'S2').status, 'INSUFFICIENT');
  assert.ok(result.items.filter((i) => i.id !== 'S2').every((i) => i.status === 'SUPPORTED'));
  assert.ok(result.codes.includes('ITEM_INSUFFICIENT:S2'));
  assert.equal(adjudicatedVerdict(missing.record.verdict, result.outcome), 'ungraded', 'in effect, CONTEST sends the PASS to UNGRADED');
  assert.deepEqual(json(join(attemptDir(missing), 'result.json')), result);

  const complete = fixtureRun();
  const confirmed = (await adjudicate(complete)).result;
  assert.equal(confirmed.outcome, 'CONFIRM');
  assert.deepEqual(confirmed.codes, []);
  assert.equal(adjudicatedVerdict('pass', confirmed.outcome), 'pass');
  assert.equal(verifyAdjudication({ runDir: complete.runDir, caseId: complete.caseId, attempt: 1 }).outcome, 'CONFIRM');
});

test('acceptance 2: the input audit proves the executor verdict and narrative are absent from the exact payload sent', async () => {
  const f = fixtureRun({ notesEvidence: true });
  const { result, calls } = await adjudicate(f, { evidence: [f.rel.notes, f.rel.receipt] });
  const dir = attemptDir(f), input = read(join(dir, 'input.txt')), audit = json(join(dir, 'audit.json'));
  // What the engine received is, byte for byte, what was recorded and hashed.
  const judge = calls.find((c) => c.phase === 'judge');
  assert.equal(judge.input, input);
  assert.equal(result.input_sha256, sha(input));
  assert.deepEqual(payloadOf(input), json(join(dir, 'payload.json')));
  assert.equal(calls.find((c) => c.phase === 'checklist').input, read(join(caseDir(f), 'checklist-input.txt')));
  // The audit ran over that exact input and over every text file it lets the engine read, and found nothing.
  assert.equal(audit.clean, true);
  assert.equal(audit.input_sha256, result.input_sha256);
  assert.ok(audit.checked.fragments >= 3, 'the narrative, the record reason and the child verdict note are all searched for');
  assert.deepEqual(audit.checked.sources.map((s) => s.kind).sort(), ['board-record', 'child-verdict', 'executor-stream']);
  assert.ok(audit.checked.text_files >= 1);
  for (const leak of [NARRATIVE, REASON, CHILD_NOTE, 'TEAMQA_EVIDENCE_DRAFT', '"verdict"', 'TC-01-verdict.json', '.receipt.json', 'Logging in with the test account', SECRET, 'nonce-1234']) {
    assert.equal(input.includes(leak), false, `input must not contain ${leak}`);
  }
  assert.doesNotMatch(input, /"(?:pass|fail|ungraded|PASS|FAIL|UNGRADED)"/);
  const payload = payloadOf(input);
  assert.deepEqual(payload.evidence.map((e) => e.rel).sort(), [f.rel.dom, f.rel.shot, f.rel.video].sort(), 'the state receipt and the executor-written notes are not evidence');
  assert.deepEqual(audit.excluded.map((e) => [e.rel, e.reason]).sort(), [[f.rel.notes, 'EXECUTOR_TEXT'], [f.rel.receipt, 'NOT_RAW_EVIDENCE']].sort());
  assert.equal(payload.case.data.password, '[redacted]');
  assert.ok(payload.action_chain.every((a) => !JSON.stringify(a.params).includes('reason')));
  assert.equal(payload.action_chain.some((a) => a.tool === 'Read'), false, 'only GUI tool actions form the chain');
  // The same audit fails on an input that carries any of them.
  const traces = { fragments: [NARRATIVE], verdict_words: ['pass'], tokens: [] };
  const leaked = auditInput({ inputs: [{ name: 'input', text: input.replace('Order one product', NARRATIVE) }], textFiles: [], traces });
  assert.equal(leaked.clean, false);
  assert.equal(leaked.findings[0].kind, 'EXECUTOR_NARRATIVE');
  const verdictKey = auditInput({ inputs: [{ name: 'input', text: input.replace('"expected":', '"executor_verdict": "pass", "expected":') }], textFiles: [], traces });
  assert.deepEqual(verdictKey.findings.map((x) => x.kind).sort(), ['VERDICT_KEY', 'VERDICT_VALUE']);
});

test('an executor narrative that reaches the payload stops the call: ABSTAIN, and the engine never judges', async () => {
  const f = fixtureRun({ narrativeInAction: true });
  const { result, calls } = await adjudicate(f);
  assert.equal(result.outcome, 'ABSTAIN');
  assert.deepEqual(result.codes, ['INPUT_AUDIT_FAILED']);
  assert.deepEqual(calls.map((c) => c.phase), ['checklist']);
  const audit = json(join(attemptDir(f), 'audit.json'));
  assert.equal(audit.clean, false);
  assert.equal(audit.findings[0].kind, 'EXECUTOR_NARRATIVE');
  assert.equal(JSON.stringify(audit).includes(NARRATIVE), false, 'the audit names a hash of what leaked, not the text');
  assert.equal(adjudicatedVerdict('pass', result.outcome), 'pass', 'ABSTAIN keeps the verdict');
});

test('acceptance 3: a pointer that does not resolve to real evidence makes the result ABSTAIN', async () => {
  for (const [mode, code] of [['bad-pointer', /^POINTER_UNRESOLVED:S1:0:IMAGE_REGION_OUTSIDE$/], ['ghost-evidence', /^POINTER_UNRESOLVED:S1:0:EVIDENCE_UNKNOWN$/], ['ghost-action', /^POINTER_UNRESOLVED:S1:0:ACTION_UNKNOWN$/]]) {
    const f = fixtureRun();
    const { result } = await adjudicate(f, { mode });
    assert.equal(result.outcome, 'ABSTAIN', mode);
    assert.ok(result.codes.some((c) => code.test(c)), `${mode}: ${result.codes}`);
    assert.equal(result.model_overall, 'CONFIRM', 'the model said CONFIRM; the validator turned it into ABSTAIN');
  }
  const f = fixtureRun();
  await adjudicate(f);
  // Evidence changed after the judgment: the pointer no longer resolves to the evidence the engine saw.
  writeFileSync(join(f.runDir, f.rel.shot), 'not the screenshot');
  const later = verifyAdjudication({ runDir: f.runDir, caseId: f.caseId, attempt: 1 });
  assert.equal(later.outcome, 'ABSTAIN');
  assert.ok(later.codes.some((c) => /^POINTER_UNRESOLVED:.*EVIDENCE_CHANGED$/.test(c)), later.codes.join(','));
});

test('the validator turns broken answers into ABSTAIN, never into a verdict of its own', async () => {
  for (const [mode, code] of [['inconsistent', 'OVERALL_INCONSISTENT'], ['garbage', 'ENGINE_OUTPUT_INVALID'], ['abstain', 'MODEL_ABSTAINED']]) {
    const { result } = await adjudicate(fixtureRun(), { mode });
    assert.equal(result.outcome, 'ABSTAIN', mode);
    assert.ok(result.codes.includes(code), `${mode}: ${result.codes}`);
  }
  const failing = { interface: 'team-qa/adjudicator-engine/v1', calls: [], async call({ phase }) { if (phase === 'judge') throw new Error('engine down'); return { output: '' }; } };
  const g = fixtureRun();
  const result = await adjudicateCase({ runDir: g.runDir, caseId: 'TC-01', seat: SEAT, engine: failing, attestationPath: g.attestation });
  assert.ok(result.codes.includes('ENGINE_FAILED'), result.codes.join(','));
  assert.equal(result.outcome, 'ABSTAIN');
});

test('the checklist is generated from the requirement and frozen before any evidence is shown', async () => {
  const f = fixtureRun(), calls = [];
  const checklist = await freezeChecklist({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine({ calls }) });
  assert.deepEqual(checklist.items.map((i) => [i.id, i.origin, i.refs]), [
    ['S1', 'case-step', ['step:1']], ['S2', 'case-step', ['step:2']], ['S3', 'case-step', ['step:3']], ['E1', 'case-expected', ['expected']], ['R1', 'requirement', ['requirement']]]);
  const sent = read(join(caseDir(f), 'checklist-input.txt'));
  assert.equal(calls[0].input, sent);
  const request = payloadOf(sent);
  assert.deepEqual(Object.keys(request).sort(), ['baseline_items', 'case', 'case_id', 'requirement', 'run_id', 'schema']);
  for (const shown of ['.png', '.html', '.mp4', 'dispatch/', 'board.jsonl']) assert.equal(sent.includes(shown), false, shown);
  for (const key of ['"action_chain"', '"evidence"', '"baseline"']) assert.equal(JSON.stringify(request).includes(key), false, key);
  await assert.rejects(freezeChecklist({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine() }), /ADJUDICATOR_CHECKLIST_FROZEN/);
  const { result } = await adjudicate(f, { calls: [] });
  const payload = json(join(attemptDir(f), 'payload.json'));
  assert.equal(payload.checklist.sha256, sha(read(join(caseDir(f), 'checklist.json'))));
  assert.equal(result.checklist_sha256, payload.checklist.sha256);
  assert.ok(Date.parse(checklist.frozen_at) <= Date.parse(payload.built_at));
  // A checklist edited after the judgment no longer matches what the engine was given.
  const edited = json(join(caseDir(f), 'checklist.json'));
  edited.items.pop();
  writeFileSync(join(caseDir(f), 'checklist.json'), JSON.stringify(edited));
  const verified = verifyAdjudication({ runDir: f.runDir, caseId: f.caseId, attempt: 1 });
  assert.equal(verified.outcome, 'ABSTAIN');
  assert.ok(verified.codes.includes('CHECKLIST_DRIFT'));
});

test('a checklist engine that fails still freezes the case items, and says so', async () => {
  const f = fixtureRun();
  const checklist = await freezeChecklist({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine({ checklistMode: 'garbage' }) });
  assert.deepEqual(checklist.items.map((i) => i.id), ['S1', 'S2', 'S3', 'E1']);
  assert.equal(checklist.requirement_items, 'ENGINE_OUTPUT_INVALID');
});

test('PASS-only scope: a case that is not PASS is skipped before any engine call or file; scope all judges it', async () => {
  const f = fixtureRun({ missingStep: true });
  failRecord(f);
  const calls = [];
  const skipped = await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine({ calls }), attestationPath: f.attestation, boardPath: f.qaBoard });
  assert.deepEqual(skipped, { skipped: true, reason: 'verdict_not_pass', scope: 'pass_only', case_id: 'TC-01', executor_attempt: 1, executor_verdict: 'fail' });
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(f.runDir, 'adjudication')), false);
  assert.equal(existsSync(join(f.runDir, 'dispatch', 'adjudicator')), false);
  const unscoped = { ...SEAT };
  delete unscoped.scope;
  assert.equal((await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: unscoped, engine: fakeEngine({ calls }), attestationPath: f.attestation })).reason, 'verdict_not_pass', 'the policy default is PASS-only');
  const judged = await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: { ...SEAT, scope: 'all' }, engine: fakeEngine({ calls }), attestationPath: f.attestation, boardPath: f.qaBoard });
  assert.equal(judged.outcome, 'CONTEST');
  assert.equal(adjudicatedVerdict('fail', judged.outcome), 'fail', 'a FAIL stays FAIL');
});

test('the effect only keeps or lowers a PASS: CONTEST makes it UNGRADED, nothing becomes PASS or FAIL', () => {
  for (const verdict of ['pass', 'fail', 'ungraded', 'blocked', 'pending']) {
    for (const outcome of ADJUDICATION_OUTCOMES) {
      const after = adjudicatedVerdict(verdict, outcome);
      if (verdict === 'pass' && outcome === 'CONTEST') assert.equal(after, 'ungraded');
      else assert.equal(after, verdict, `${verdict} + ${outcome}`);
    }
    assert.equal(adjudicatedVerdict(verdict, 'SOMETHING'), verdict);
  }
  assert.equal(deriveOutcome([{ status: 'SUPPORTED' }, { status: 'SUPPORTED' }]), 'CONFIRM');
  assert.equal(deriveOutcome([{ status: 'SUPPORTED' }, { status: 'CONTRADICTED' }]), 'CONTEST');
  assert.equal(deriveOutcome([{ status: 'INSUFFICIENT' }]), 'CONTEST');
});

test('an attempt is adjudicated once, and a tampered result is not believed', async () => {
  const f = fixtureRun();
  await adjudicate(f);
  await assert.rejects(adjudicate(f), /ADJUDICATION_EXISTS/);
  const path = join(attemptDir(f), 'result.json'), result = json(path);
  writeFileSync(path, JSON.stringify({ ...result, outcome: 'CONTEST' }));
  const verified = verifyAdjudication({ runDir: f.runDir, caseId: f.caseId, attempt: 1 });
  assert.equal(verified.outcome, 'ABSTAIN');
  assert.ok(verified.codes.includes('RESULT_DRIFT'));
  assert.equal(existsSync(join(attemptDir(f), 'output.txt')), true);
});
