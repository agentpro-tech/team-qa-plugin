// Upgrade R2a: the report's shadow fields. Next to the real verdicts the report computes what they would be if the
// adjudicator were on; only an approved roster whose seat says enforce applies it, and then only as PASS -> UNGRADED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { adjudicateCase, adjudicationMarkdown, adjudicationOverlay, adjudicationReportField, boardChangePacket } from '../../scripts/lib/adjudicator.mjs';
import { runTiming } from '../../scripts/lib/timing.mjs';
import { fakeEngine } from './fake-engine.mjs';
import { SEAT, SECRET, failRecord, fixtureRun, root } from './support.mjs';

const cli = join(root, 'scripts/teamqa.mjs');
const run = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const reportOf = (path) => JSON.parse(/TEAMQA_REPORT_START\s*([\s\S]*?)\s*TEAMQA_REPORT_END/.exec(readFileSync(path, 'utf8'))[1]);
const adjudicate = (f, mode = 'honest') => adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine({ mode }), attestationPath: f.attestation, boardPath: f.qaBoard });
const board = (f) => readFileSync(join(f.runDir, 'board.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function reportableRun({ missingStep = true } = {}) {
  const f = fixtureRun({ missingStep, reportable: true });
  for (const args of [['gate', 'approve', '--run', f.runId, '--plan', join(f.runDir, 'test-plan.md'), '--signed-by', 'owner', '--ts', '2026-11-04T01:00:00.000Z'],
    ['rtm', 'build', '--plan', join(f.runDir, 'test-plan.md'), '--tracked', join(f.runDir, 'tracked-plan.json'), '--out', join(f.runDir, 'rtm.md')],
    ['rtm', 'fill', '--rtm', join(f.runDir, 'rtm.md'), '--board', join(f.runDir, 'board.jsonl'), '--out', join(f.runDir, 'rtm.md')]]) {
    const r = run(f.base, args);
    assert.equal(r.status, 0, `${args.slice(0, 2).join(' ')}: ${r.stderr || r.stdout}`);
  }
  return f;
}

test('shadow: the report puts the verdicts the adjudicator would give next to the real ones and changes none', async () => {
  const f = reportableRun();
  const before = run(f.base, ['report', 'build', '--run', f.runId]);
  assert.equal(before.status, 0, before.stderr || before.stdout);
  const plain = reportOf(join(f.runDir, 'summary-report.md'));
  assert.equal(Object.hasOwn(plain, 'adjudication'), false, 'a run without adjudication keeps its report');
  assert.doesNotMatch(readFileSync(join(f.runDir, 'summary-report.md'), 'utf8'), /Adjudicator/);

  assert.equal((await adjudicate(f)).outcome, 'CONTEST');
  const built = run(f.base, ['report', 'build', '--run', f.runId]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const text = readFileSync(join(f.runDir, 'summary-report.md'), 'utf8'), report = reportOf(join(f.runDir, 'summary-report.md'));
  assert.equal(report.decision, 'GO', 'shadow changes no verdict and no decision');
  assert.deepEqual(report.metrics, plain.metrics);
  const a = report.adjudication;
  assert.equal(a.schema, 'team-qa/adjudication-report/v1');
  assert.equal(a.mode, 'shadow');
  assert.deepEqual(a.cases.map((c) => [c.case_id, c.executor_attempt, c.executor_verdict, c.outcome, c.if_enabled_verdict, c.applied]), [['TC-01', 1, 'pass', 'CONTEST', 'ungraded', false]]);
  assert.deepEqual(a.cases[0].codes, ['ITEM_INSUFFICIENT:S2']);
  assert.deepEqual(a.cases[0].items, { SUPPORTED: 4, CONTRADICTED: 0, INSUFFICIENT: 1 });
  assert.equal(a.scope, 'pass_only');
  assert.deepEqual(a.counts, { executed: 1, adjudicated: 1, confirm: 0, contest: 1, abstain: 0, not_adjudicated: { verdict_not_pass: 0, missing: 0 } });
  assert.deepEqual(a.not_adjudicated, { verdict_not_pass: [], missing: [] });
  assert.deepEqual(a.actual, { pass: 1, fail: 0, ungraded: 0, decision: 'GO' });
  assert.deepEqual(a.if_enabled, { pass: 0, fail: 0, ungraded: 1, lowered: ['TC-01'], decision: 'NO_GO' });
  assert.match(text, /## Adjudicator \(shadow\)/);
  assert.match(text, /\| TC-01 \| PASS \| CONTEST \| UNGRADED \| ITEM_INSUFFICIENT:S2 \|/);
  assert.match(text, /If it had been on: PASS 1 → 0, UNGRADED 0 → 1, decision GO → NO_GO\./);
  assert.match(text, /Not adjudicated: 0 not PASS \(scope pass_only\), 0 without a result\./);
  const verified = run(f.base, ['report', 'verify', '--run', f.runId]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(text.includes(SECRET), false);
  // The ledger and the RTM keep the executor's verdict.
  assert.equal(board(f)[0].verdict, 'pass');
  // An adjudication edited after the fact is not believed by the report.
  const path = join(f.runDir, 'adjudication/TC-01/attempt-1/result.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), outcome: 'CONFIRM', codes: [] }));
  const mismatch = run(f.base, ['report', 'verify', '--run', f.runId]);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /REPORT_MISMATCH adjudication/);
});

test('enforce: only the approved seat switches it on, and a contested PASS becomes UNGRADED, nothing else', async () => {
  const f = fixtureRun({ missingStep: true });
  await adjudicate(f);
  const records = board(f), seat = { ...SEAT, mode: 'enforce' };
  const failed = [{ ...records[0], case_id: 'TC-09', verdict: 'fail' }];
  const shadow = adjudicationOverlay({ runDir: f.runDir, board: records, roster: { adjudicator: SEAT } });
  assert.equal(shadow.mode, 'shadow');
  assert.deepEqual(shadow.board, records, 'shadow returns the board unchanged');
  const enforced = adjudicationOverlay({ runDir: f.runDir, board: [...records, ...failed], roster: { adjudicator: seat } });
  assert.equal(enforced.mode, 'enforce');
  assert.equal(enforced.board[0].verdict, 'ungraded');
  assert.equal(enforced.board[0].reason, 'ADJUDICATOR_CONTEST');
  assert.equal(enforced.board[1].verdict, 'fail');
  assert.deepEqual(enforced.rows.map((r) => [r.case_id, r.applied]), [['TC-01', true]]);
  const field = adjudicationReportField(enforced, { decision: 'NO_GO', metrics: { pass: 0, fail: 1, ungraded: 1 } }).adjudication;
  assert.deepEqual(field.if_enabled, { pass: 0, fail: 1, ungraded: 1, lowered: ['TC-01'], decision: 'NO_GO' });
  assert.match(adjudicationMarkdown(field).join('\n'), /## Adjudicator \(enforced\)/);
  // Without an approved seat a run is never enforced, whatever its result files say.
  assert.equal(adjudicationOverlay({ runDir: f.runDir, board: records, roster: null }).mode, 'shadow');
  // A board packet for QA GUI's `board apply` sets a contested PASS case to BLOCKED (UNGRADED) with a comment.
  const packet = boardChangePacket({ overlay: enforced, board: JSON.parse(readFileSync(f.qaBoard, 'utf8')) });
  assert.deepEqual(packet.edits, [{ entity: 'case', id: 'TC-01', field: 'status', from: 'PASS', to: 'BLOCKED' }]);
  assert.equal(packet.protocol, 'doc-colab/v1');
  assert.equal(packet.baseRev, 4);
  assert.match(packet.comments[0].text, /^Adjudicator CONTEST: ITEM_INSUFFICIENT:S2\./);
  assert.equal(boardChangePacket({ overlay: shadow, board: JSON.parse(readFileSync(f.qaBoard, 'utf8')) }), null, 'shadow changes nothing on the board');
});

test('the mode comes from the approved roster bytes only: an edited roster is read as shadow', async () => {
  const f = fixtureRun({ missingStep: true });
  await adjudicate(f);
  const rosterPath = join(f.runDir, 'roster.json'), approval = join(f.runDir, 'control/approvals/roster.json');
  writeFileSync(rosterPath, JSON.stringify({ schema: 'team-qa/roster/v1', adjudicator: { ...SEAT, mode: 'enforce' } }));
  mkdirSync(join(f.runDir, 'control/approvals'), { recursive: true });
  writeFileSync(approval, JSON.stringify({ schema: 'team-qa/roster-approval/v1', roster_hash: createHash('sha256').update(readFileSync(rosterPath)).digest('hex') }));
  assert.equal(adjudicationOverlay({ runDir: f.runDir, board: board(f) }).mode, 'enforce');
  writeFileSync(rosterPath, JSON.stringify({ schema: 'team-qa/roster/v1', adjudicator: { ...SEAT, mode: 'enforce', model: 'other' } }));
  const edited = adjudicationOverlay({ runDir: f.runDir, board: board(f) });
  assert.equal(edited.mode, 'shadow');
  assert.equal(edited.seat, null);
  assert.equal(edited.board[0].verdict, 'pass');
});

test('the report counts cases skipped by the PASS-only scope as not_adjudicated: verdict_not_pass', async () => {
  const f = fixtureRun();
  const failed = failRecord(f);
  const passed = { ...f.record, case_id: 'TC-02' };
  const pending = { ...f.record, case_id: 'TC-03', verdict: 'pending' };
  const shadow = adjudicationOverlay({ runDir: f.runDir, board: [failed, passed, pending], roster: { adjudicator: SEAT } });
  const field = adjudicationReportField(shadow, { decision: 'NO_GO', metrics: { pass: 1, fail: 1, ungraded: 0 } }).adjudication;
  assert.equal(field.scope, 'pass_only');
  assert.deepEqual(field.counts.not_adjudicated, { verdict_not_pass: 1, missing: 1 });
  assert.deepEqual(field.not_adjudicated, { verdict_not_pass: ['TC-01'], missing: ['TC-02'] });
  assert.match(adjudicationMarkdown(field).join('\n'), /Not adjudicated: 1 not PASS \(scope pass_only\), 1 without a result \(TC-02\)\./);
  const all = adjudicationReportField(adjudicationOverlay({ runDir: f.runDir, board: [failed, passed], roster: { adjudicator: { ...SEAT, scope: 'all' } } }), { decision: 'NO_GO', metrics: { pass: 1, fail: 1, ungraded: 0 } }).adjudication;
  assert.deepEqual(all.not_adjudicated, { verdict_not_pass: [], missing: ['TC-01', 'TC-02'] }, 'with scope all a FAIL without a result is missing, not skipped');
});

test('an adjudication of an earlier attempt has no effect on a case that ran again', async () => {
  const f = fixtureRun({ missingStep: true });
  await adjudicate(f);
  const rerun = { ...board(f)[0], attempt: 2, attempt_id: 'TC-01#2', parent_attempt_id: 'TC-01#1' };
  const overlay = adjudicationOverlay({ runDir: f.runDir, board: [rerun], roster: { adjudicator: { ...SEAT, mode: 'enforce' } } });
  assert.deepEqual(overlay.rows.map((r) => [r.outcome, r.codes, r.if_enabled_verdict, r.applied]), [['ABSTAIN', ['ADJUDICATION_STALE'], 'pass', false]]);
  assert.equal(overlay.board[0].verdict, 'pass');
});

test('the decision log and time receipts carry the adjudicator, apart from the executor case time', async () => {
  const f = fixtureRun({ missingStep: true });
  const before = runTiming({ runDir: f.runDir, runId: f.runId });
  assert.equal(Object.hasOwn(before.decisions, 'adjudicator'), false);
  const result = await adjudicate(f);
  const timing = runTiming({ runDir: f.runDir, runId: f.runId });
  assert.deepEqual(timing.decisions.adjudicator.map((d) => [d.point, d.case_id, d.executor_attempt, d.chosen, d.options]), [['adjudicate', 'TC-01', 1, 'CONTEST', ['CONFIRM', 'CONTEST', 'ABSTAIN']]]);
  assert.equal(timing.decisions.adjudicator[0].input_sha256, result.input_sha256);
  assert.ok(Number.isInteger(timing.decisions.adjudicator[0].latency_ms));
  assert.equal(timing.summary.attempts_by_role.adjudicator.count, 2);
  assert.equal(Object.hasOwn(timing.summary.cases, 'TC-01'), false, 'adjudicator attempts are not executor case time');
  assert.equal(existsSync(join(f.runDir, 'dispatch/adjudicator')), true);
});
