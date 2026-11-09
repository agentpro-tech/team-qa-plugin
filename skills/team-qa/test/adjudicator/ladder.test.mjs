// Integration of R2a with R3: the adjudicator's settlement of a case verdict is a cost ladder decision (tier 3, the
// adjudicator) written through R3's ladderDecision into runs/<id>/decisions.jsonl, in shadow as in enforce mode, so the
// report's Speed section and timing.json count it with every other ladder decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjudicateCase } from '../../scripts/lib/adjudicator.mjs';
import { readSpeedDecisions, speedSummary } from '../../scripts/lib/cost-ladder.mjs';
import { fakeEngine } from './fake-engine.mjs';
import { SEAT, failRecord, fixtureRun } from './support.mjs';

const adjudicate = (f, seat = SEAT) => adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat, engine: fakeEngine({ mode: 'honest' }),
  attestationPath: f.attestation, boardPath: f.qaBoard, evidencePaths: [f.rel.dom] });
const ladderOf = (f) => readSpeedDecisions(f.runDir).filter((d) => d.kind === 'ladder' && d.check === 'verdict');
// D6 (fix round 2): the ladder row is written only when the plan's cost_ladder flag is not off.
function withSpeed(f, speed) {
  const plan = join(f.runDir, 'test-plan.md');
  const text = readFileSync(plan, 'utf8');
  const start = text.indexOf('TEAMQA_PLAN_START') + 'TEAMQA_PLAN_START'.length, end = text.indexOf('TEAMQA_PLAN_END');
  writeFileSync(plan, `${text.slice(0, start)}\n${JSON.stringify({ ...JSON.parse(text.slice(start, end)), speed })}\n${text.slice(end)}`);
  return f;
}

test('D6: with every speed flag off the adjudication writes no ladder row', async () => {
  const f = fixtureRun({ missingStep: true });
  assert.equal((await adjudicate(f)).outcome, 'CONTEST');
  assert.equal(existsSync(join(f.runDir, 'decisions.jsonl')), false);
});

test('a contested PASS is one verdict ladder decision: the executor (tier 2) escalates, the adjudicator (tier 3) settles', async () => {
  const f = withSpeed(fixtureRun({ missingStep: true }), { cost_ladder: 'shadow' });
  const result = await adjudicate(f);
  assert.equal(result.outcome, 'CONTEST');
  const [decision] = ladderOf(f);
  assert.deepEqual({ ...decision, at: null }, {
    schema: 'team-qa/speed-decision/v1', kind: 'ladder', mode: 'shadow', case_id: f.caseId, state: null, check: 'verdict', min_tier: 0, default_tier: 2,
    steps: [{ tier: 2, outcome: 'escalate', verdict: 'pass', reason: 'EXECUTOR_VERDICT' }, { tier: 3, outcome: 'settled', verdict: 'ungraded', reason: 'CONTEST' }],
    settled_tier: 3, errors: [], at: null, latency_ms: result.duration_ms,
  });
  // The Speed section of the report counts it.
  assert.deepEqual(speedSummary(readSpeedDecisions(f.runDir)).ladder.by_settled_tier, { 3: 1 });
});

test('a confirmed case keeps its verdict in the record; enforce mode is recorded as on', async () => {
  const f = withSpeed(fixtureRun({ missingStep: false }), { cost_ladder: 'shadow' });
  assert.equal((await adjudicate(f, { ...SEAT, mode: 'enforce' })).outcome, 'CONFIRM');
  const [decision] = ladderOf(f);
  assert.equal(decision.mode, 'on');
  assert.deepEqual(decision.steps.at(-1), { tier: 3, outcome: 'settled', verdict: 'pass', reason: 'CONFIRM' });
});

test('a plan minimum of tier 3 for the verdict starts the ladder at the adjudicator', async () => {
  const f = fixtureRun({ missingStep: true });
  const plan = join(f.runDir, 'test-plan.md');
  const text = readFileSync(plan, 'utf8');
  const start = text.indexOf('TEAMQA_PLAN_START') + 'TEAMQA_PLAN_START'.length, end = text.indexOf('TEAMQA_PLAN_END');
  const value = JSON.parse(text.slice(start, end));
  writeFileSync(plan, `${text.slice(0, start)}\n${JSON.stringify({ ...value, speed: { cost_ladder: 'shadow', min_tier: { verdict: 3 } } })}\n${text.slice(end)}`);
  await adjudicate(f);
  const [decision] = ladderOf(f);
  assert.deepEqual([decision.min_tier, decision.steps.map((s) => s.tier), decision.settled_tier, decision.errors], [3, [3], 3, []]);
});

test('a case the PASS-only scope skips is not settled by the adjudicator and writes no decision', async () => {
  const f = fixtureRun({ missingStep: true });
  failRecord(f);
  assert.equal((await adjudicate(f)).skipped, true);
  assert.equal(existsSync(join(f.runDir, 'decisions.jsonl')), false);
});
