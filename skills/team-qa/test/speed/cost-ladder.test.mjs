// Upgrade R3: the cost ladder. Tier 0 machine, 1 cheap decision model, 2 large VLM/LLM, 3 adjudicator and human. A
// check is settled at the lowest conclusive tier the signed plan allows; a tier only pushes work up; every decision is
// a line of R0's decision log (runs/<id>/decisions.jsonl) and appears in timing.json. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DECISION_SCHEMA, appendSpeedDecision, ladderDecision, readSpeedDecisions, speedSummary } from '../../scripts/lib/cost-ladder.mjs';
import { runTiming, timingMarkdown } from '../../scripts/lib/timing.mjs';

test('a check settles at the lowest conclusive tier at or above its minimum; each tier only pushes work up', () => {
  const inherit = ladderDecision({ check: 'vision', minTier: 0, mode: 'on', steps: [{ tier: 0, outcome: 'settled', reason: 'BASELINE_MATCH' }] });
  assert.equal(inherit.schema, DECISION_SCHEMA);
  assert.deepEqual([inherit.kind, inherit.settled_tier, inherit.default_tier, inherit.errors], ['ladder', 0, 2, []]);
  const escalated = ladderDecision({ check: 'vision', minTier: 0, mode: 'on', steps: [{ tier: 0, outcome: 'escalate', reason: 'DIFF_OVER_LIMIT' }, { tier: 2, outcome: 'settled' }] });
  assert.deepEqual([escalated.settled_tier, escalated.errors], [2, []]);
  // Nothing goes below the plan's minimum tier.
  assert.deepEqual(ladderDecision({ check: 'vision', minTier: 2, mode: 'on', steps: [{ tier: 0, outcome: 'settled' }] }).errors, ['LADDER_BELOW_MIN_TIER:0<2']);
  // A tier never sends work down.
  assert.deepEqual(ladderDecision({ check: 'verdict', minTier: 0, mode: 'on', steps: [{ tier: 3, outcome: 'escalate' }, { tier: 2, outcome: 'settled' }] }).errors, ['LADDER_NOT_UPWARD:3->2']);
  // The cheap decision model may only push work up: it never settles a check, so it never makes a PASS.
  assert.deepEqual(ladderDecision({ check: 'function', minTier: 0, mode: 'on', steps: [{ tier: 1, outcome: 'settled', verdict: 'PASS' }] }).errors, ['LADDER_CHEAP_MODEL_SETTLES']);
  assert.deepEqual(ladderDecision({ check: 'function', minTier: 0, mode: 'on', steps: [{ tier: 1, outcome: 'escalate', reason: 'UNSURE' }, { tier: 2, outcome: 'settled' }] }).errors, []);
  // Exactly one settlement, the last step; an unknown check or tier is refused.
  assert.deepEqual(ladderDecision({ check: 'vision', minTier: 0, mode: 'on', steps: [{ tier: 0, outcome: 'escalate' }] }).errors, ['LADDER_NOT_SETTLED']);
  assert.deepEqual(ladderDecision({ check: 'dark', minTier: 0, mode: 'on', steps: [{ tier: 2, outcome: 'settled' }] }).errors, ['LADDER_CHECK_UNKNOWN:dark']);
  assert.deepEqual(ladderDecision({ check: 'vision', minTier: 0, mode: 'on', steps: [{ tier: 4, outcome: 'settled' }] }).errors, ['LADDER_TIER_UNKNOWN:4']);
});

function run() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-ladder-')));
  const runDir = join(project, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

test('decisions are appended to decisions.jsonl and read back in order', async () => {
  const runDir = run();
  assert.deepEqual(readSpeedDecisions(runDir), []);
  const a = ladderDecision({ check: 'vision', minTier: 0, mode: 'on', caseId: 'TC-01', state: 's1', steps: [{ tier: 0, outcome: 'settled' }] });
  const b = { schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: 'shadow', case_id: 'TC-01', state: 's2', decision: 'vlm', reasons: ['DIFF_OVER_LIMIT'], agree: true, missed_rules: [] };
  await appendSpeedDecision(runDir, a);
  await appendSpeedDecision(runDir, b);
  const back = readSpeedDecisions(runDir);
  assert.deepEqual(back.map((d) => [d.kind, d.case_id, d.state]), [['ladder', 'TC-01', 's1'], ['vision_by_diff', 'TC-01', 's2']]);
  await assert.rejects(() => appendSpeedDecision(runDir, { kind: 'ladder' }), /SPEED_DECISION_INVALID/);
  const summary = speedSummary(back);
  assert.deepEqual(summary.ladder.by_settled_tier, { 0: 1 });
  assert.deepEqual(summary.vision_by_diff, { states: 1, inherit: 0, vlm: 1, shadow_missed: 0, by_mode: { shadow: 1 } });
});

test('timing.json carries the speed decisions only when the run has some; the report names them', async () => {
  const empty = run();
  const before = runTiming({ runDir: empty, runId: 'r1' });
  assert.equal(Object.hasOwn(before, 'speed'), false, 'a run with every flag off has no speed section');
  assert.doesNotMatch(timingMarkdown(before), /## Speed/);
  const runDir = run();
  await appendSpeedDecision(runDir, ladderDecision({ check: 'vision', minTier: 0, mode: 'on', caseId: 'TC-01', state: 's1', steps: [{ tier: 0, outcome: 'settled' }] }));
  await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: 'on', case_id: 'TC-01', state: 's1', decision: 'inherit', reasons: [], agree: null, missed_rules: [] });
  const t = runTiming({ runDir, runId: 'r1' });
  assert.equal(t.speed.decisions.length, 2);
  assert.equal(t.speed.summary.vision_by_diff.inherit, 1);
  assert.match(timingMarkdown(t), /## Speed[\s\S]*vision_by_diff[\s\S]*inherit 1/);
});
