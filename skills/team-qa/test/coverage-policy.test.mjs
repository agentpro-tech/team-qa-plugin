// Upgrade R1e (Team QA side): Team QA orchestrates QA GUI's frontier exploration. `teamqa coverage policy` writes the
// exploration policy (qa-gui/exploration-policy/v1): the cells the tracked plan ties to a requirement, the cells of
// high-risk cases, and the destructive actions the signed plan approves. Fixture: test/fixtures/coverage-cells.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { EXPLORATION_POLICY_SCHEMA, explorationPolicy } from '../scripts/lib/coverage-cells.mjs';
import { planErrors } from '../scripts/lib/validators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamqa.mjs');
const TRACKED = JSON.parse(readFileSync(new URL('./fixtures/coverage-cells/tracked-plan.json', import.meta.url), 'utf8'));
const APPROVAL = { route: 'dialog:delete-order', action: 'click:Delete', reason: 'The test tenant is reset after the run; deleting a seeded order is approved.' };
const PLAN = {
  run_id: 'coverage-policy', app: 'orders-fixture', plan_version: 1,
  lanes: [{ id: 'lane-gui', scope: ['REQ-LIST', 'REQ-EMPTY', 'REQ-FORM', 'REQ-DELETE'], parallel_ok: false, vi_sao: '' }],
  tiers: { 'REQ-LIST': 'FULL', 'REQ-EMPTY': 'FULL', 'REQ-FORM': 'FULL', 'REQ-DELETE': 'SMOKE' },
  exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 100 },
  coverage: { version: 'team-qa/coverage-cells/v1', destructive: [APPROVAL] },
};

test('the signed plan may approve destructive actions, each with a reason; N/A cells stay optional', () => {
  assert.deepEqual(planErrors(PLAN), []);
  const without = structuredClone(PLAN);
  delete without.coverage.destructive;
  without.coverage.na = [];
  assert.deepEqual(planErrors(without), []);
  for (const [entry, code] of [
    [{ route: 'dialog:delete-order', action: 'click:Delete' }, 'PLAN_TYPE coverage.destructive[0].reason'],
    [{ route: 'dialog:delete-order', reason: 'x' }, 'PLAN_TYPE coverage.destructive[0].action'],
    [{ ...APPROVAL, state: 'ideal' }, 'PLAN_UNKNOWN_FIELD coverage.destructive[0].state'],
  ]) {
    const plan = structuredClone(PLAN);
    plan.coverage.destructive = [entry];
    assert.ok(planErrors(plan).includes(code), `${code}: ${planErrors(plan).join(', ')}`);
  }
});

test('the policy: requirement cells of every cell case, high-risk cells of FULL-tier or P0/P1 cases, the approved destructive actions', () => {
  const policy = explorationPolicy({ tracked: TRACKED, plan: PLAN, runId: 'coverage-policy' });
  assert.equal(policy.schema, EXPLORATION_POLICY_SCHEMA);
  assert.deepEqual(policy.requirementCells, [
    { route: '/orders', state: 'many-rows', action: 'view', requirement: 'REQ-LIST', case: 'TC-01' },
    { route: '/orders', state: 'empty', action: 'view', requirement: 'REQ-EMPTY', case: 'TC-02' },
    { route: '/orders/new', state: 'ideal', action: 'view', requirement: 'REQ-FORM', case: 'TC-03' },
    { route: 'dialog:delete-order', state: 'ideal', action: 'click:Cancel', requirement: 'REQ-DELETE', case: 'TC-04' },
  ]);
  // TC-04 is SMOKE and P2: not high risk.
  assert.deepEqual(policy.highRisk.map((cell) => cell.case), ['TC-01', 'TC-02', 'TC-03']);
  assert.deepEqual(policy.approvedDestructive, [{ route: 'dialog:delete-order', action: 'click:Delete' }]);
  assert.equal(explorationPolicy({ tracked: TRACKED, plan: { ...PLAN, coverage: undefined }, runId: 'x' }).approvedDestructive.length, 0);
});

test('teamqa coverage policy writes the policy beside the run, and refuses a tracked plan without the coverage block', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-coverage-policy-'));
  const runDir = join(cwd, 'runs', 'coverage-policy');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'test-plan.md'), `# Plan\n\nTEAMQA_PLAN_START\n${JSON.stringify(PLAN, null, 2)}\nTEAMQA_PLAN_END\n`);
  writeFileSync(join(runDir, 'tracked-plan.json'), `${JSON.stringify(TRACKED, null, 2)}\n`);
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  let r = run(['coverage', 'policy', '--run', 'coverage-policy']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /requirement_cells=4 high_risk=3 approved_destructive=1/);
  const written = JSON.parse(readFileSync(join(runDir, 'exploration-policy.json'), 'utf8'));
  assert.deepEqual(written, explorationPolicy({ tracked: TRACKED, plan: PLAN, runId: 'coverage-policy' }));
  const plain = structuredClone(TRACKED);
  delete plain.coverage;
  for (const item of plain.cases) { delete item.route; delete item.actions; item.states = ['ideal']; }
  writeFileSync(join(runDir, 'tracked-plan.json'), `${JSON.stringify(plain, null, 2)}\n`);
  r = run(['coverage', 'policy', '--run', 'coverage-policy', '--out', join(runDir, 'other.json')]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /COVERAGE_CELLS_REQUIRED/);
});

// With a QA GUI checkout (TEAMQA_WEB_TEST_QA_GUI_ROOT): the policy is what QA GUI's explorer reads.
const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
test('QA GUI\'s explorer reads the policy: the same schema, and a requirement cell scores first', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout' }, async () => {
  const explorer = await import(pathToFileURL(join(QA_GUI, 'scripts/lib/frontier-explorer.mjs')).href);
  const policy = explorationPolicy({ tracked: TRACKED, plan: PLAN, runId: 'x' });
  assert.equal(explorer.EXPLORATION_POLICY_SCHEMA, policy.schema);
  assert.ok(explorer.scoreCandidate({ route: 'dialog:delete-order', target: 'button:Cancel' }, policy).reasons.includes('requirement:REQ-DELETE'));
});
