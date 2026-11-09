// Upgrade R3: parallel GUI lanes. Each lane has its own test account or tenant, data namespace and Dragon session; the
// validator checks they differ before parallel_ok:true counts, and refuses two lanes on one account. Synthetic plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planErrors } from '../../scripts/lib/validators.mjs';
import { parallelDispatchIssue, parallelLaneErrors } from '../../scripts/lib/parallel-lanes.mjs';
import { readSpeedDecisions } from '../../scripts/lib/cost-ladder.mjs';
import { startCaseDispatch } from '../../scripts/lib/run-contract.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lane = (id, req, extra = {}) => ({ id, scope: [req], parallel_ok: true, vi_sao: 'own account and data', account: `qa-${id}@tenant-${id}`, data_namespace: `ns-${id}`, dragon_session: `qa-${id}`, ...extra });
const plan = (lanes, mode = 'on') => ({
  run_id: 'r3-par', app: 'shop', plan_version: 1, lanes,
  tiers: Object.fromEntries(lanes.flatMap((l) => l.scope.map((r) => [r, 'FULL']))),
  exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 },
  ...(mode ? { speed: { parallel_gui_lanes: mode } } : {}),
});

test('lanes may name their account, data namespace and Dragon session; a plan without them is unchanged', () => {
  assert.deepEqual(planErrors(plan([lane('a', 'REQ-A'), lane('b', 'REQ-B')])), []);
  assert.deepEqual(planErrors(plan([{ id: 'a', scope: ['REQ-A'], parallel_ok: true, vi_sao: 'separate data' }], null)), []);
  assert.ok(planErrors(plan([lane('a', 'REQ-A', { account: '' })], null)).includes('PLAN_TYPE lanes[0].account'));
});

test('with parallel_gui_lanes on, the validator refuses two parallel lanes on one account, one data namespace or one Dragon session', () => {
  assert.deepEqual(parallelLaneErrors(plan([lane('a', 'REQ-A'), lane('b', 'REQ-B')])), []);
  // The account is compared without case or surrounding space: one login is one account.
  const shared = plan([lane('a', 'REQ-A', { account: 'QA-1@Tenant.test' }), lane('b', 'REQ-B', { account: ' qa-1@tenant.test' })]);
  assert.deepEqual(parallelLaneErrors(shared), ['PLAN_PARALLEL_LANE_SHARED_ACCOUNT lanes[0] lanes[1]']);
  assert.ok(planErrors(shared).includes('PLAN_PARALLEL_LANE_SHARED_ACCOUNT lanes[0] lanes[1]'));
  assert.deepEqual(parallelLaneErrors(plan([lane('a', 'REQ-A', { data_namespace: 'shared' }), lane('b', 'REQ-B', { data_namespace: 'shared' })])), ['PLAN_PARALLEL_LANE_SHARED_NAMESPACE lanes[0] lanes[1]']);
  assert.deepEqual(parallelLaneErrors(plan([lane('a', 'REQ-A', { dragon_session: 'qa' }), lane('b', 'REQ-B', { dragon_session: 'qa' })])), ['PLAN_PARALLEL_LANE_SHARED_SESSION lanes[0] lanes[1]']);
  // A parallel lane must name all three.
  const bare = { id: 'b', scope: ['REQ-B'], parallel_ok: true, vi_sao: 'trust me' };
  assert.deepEqual(parallelLaneErrors(plan([lane('a', 'REQ-A'), bare])), ['PLAN_PARALLEL_LANE_IDENTITY lanes[1].account', 'PLAN_PARALLEL_LANE_IDENTITY lanes[1].data_namespace', 'PLAN_PARALLEL_LANE_IDENTITY lanes[1].dragon_session']);
  // A lane that does not run in parallel shares nothing with anyone.
  assert.deepEqual(parallelLaneErrors(plan([lane('a', 'REQ-A'), lane('b', 'REQ-B', { parallel_ok: false, account: 'qa-a@tenant-a' })])), []);
  // shadow reports the same errors but the plan stays valid; off checks nothing new.
  const sharedShadow = plan([lane('a', 'REQ-A', { account: 'same' }), lane('b', 'REQ-B', { account: 'same' })], 'shadow');
  assert.deepEqual(parallelLaneErrors(sharedShadow), ['PLAN_PARALLEL_LANE_SHARED_ACCOUNT lanes[0] lanes[1]']);
  assert.deepEqual(planErrors(sharedShadow), []);
  assert.deepEqual(planErrors(plan([lane('a', 'REQ-A', { account: 'same' }), lane('b', 'REQ-B', { account: 'same' })], 'off')), []);
});

// A run with a locked tracked plan and the dispatch state of a GUI case that is running now.
function runWith(lanes, mode) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-par-')));
  const runDir = join(project, 'runs', 'r3-par');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'test-plan.md'), `TEAMQA_PLAN_START\n${JSON.stringify(plan(lanes, mode))}\nTEAMQA_PLAN_END\n`);
  const tracked = { schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'brief', sourceSystem: 'brief', externalKey: 'K-1', title: 'One', origin: 'upstream' }],
    cases: lanes.flatMap((l, i) => [`TC-${i + 1}`, `TC-${i + 1}b`].map((id) => ({ id, req_id: l.scope[0], lane: 'gui', steps: ['Open the page'], expected: 'Shown', data: {},
      priority: 'P1', kind: 'static', title: id, sourceRefs: ['SRC-1'], taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] }))) };
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify(tracked));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'test-plan.md', sha256: sha(readFileSync(join(runDir, 'test-plan.md'))) },
    tracked: { path: 'tracked-plan.json', sha256: sha(readFileSync(join(runDir, 'tracked-plan.json'))) } } }));
  const running = join(runDir, 'dispatch', 'executor_gui', 'running-attempt-1');
  mkdirSync(running, { recursive: true });
  writeFileSync(join(running, 'state.json'), JSON.stringify({ attempt: 'running-attempt-1', role: 'executor_gui', case_id: 'TC-1', status: 'running', pid: process.pid }));
  const done = join(runDir, 'dispatch', 'executor_gui', 'done-attempt-0');
  mkdirSync(done, { recursive: true });
  writeFileSync(join(done, 'state.json'), JSON.stringify({ attempt: 'done-attempt-0', role: 'executor_gui', case_id: 'TC-2', status: 'done', pid: process.pid }));
  return runDir;
}

test('dispatch: under on, a GUI case starts beside a running one only on another valid parallel lane', async () => {
  const runDir = runWith([lane('a', 'REQ-A'), lane('b', 'REQ-B')], 'on');
  assert.equal(await parallelDispatchIssue({ runDir, caseId: 'TC-2', attempt: 'new-attempt' }), null);
  // The same lane as the running case: one lane runs one case at a time.
  assert.match(await parallelDispatchIssue({ runDir, caseId: 'TC-1b', attempt: 'new-attempt' }), /^DISPATCH_PARALLEL_LANES_REFUSED same lane a/);
  // Two lanes on one account: refused.
  const shared = runWith([lane('a', 'REQ-A', { account: 'one@tenant' }), lane('b', 'REQ-B', { account: 'one@tenant' })], 'on');
  assert.match(await parallelDispatchIssue({ runDir: shared, caseId: 'TC-2', attempt: 'new-attempt' }), /^DISPATCH_PARALLEL_LANES_REFUSED PLAN_PARALLEL_LANE_SHARED_ACCOUNT/);
  // A lane that is not parallel_ok never starts beside another one.
  const serial = runWith([lane('a', 'REQ-A'), lane('b', 'REQ-B', { parallel_ok: false })], 'on');
  assert.match(await parallelDispatchIssue({ runDir: serial, caseId: 'TC-2', attempt: 'new-attempt' }), /^DISPATCH_PARALLEL_LANES_REFUSED lane b is not parallel_ok/);
  const decisions = readSpeedDecisions(shared);
  assert.equal(decisions.at(-1).kind, 'parallel_lanes');
  assert.equal(decisions.at(-1).allowed, false);
});

test('dispatch: off changes nothing; shadow records what on would refuse and lets the dispatch start', async () => {
  const off = runWith([lane('a', 'REQ-A', { account: 'one' }), lane('b', 'REQ-B', { account: 'one' })], 'off');
  assert.equal(await parallelDispatchIssue({ runDir: off, caseId: 'TC-2', attempt: 'new-attempt' }), null);
  assert.deepEqual(readSpeedDecisions(off), []);
  const shadow = runWith([lane('a', 'REQ-A', { account: 'one' }), lane('b', 'REQ-B', { account: 'one' })], 'shadow');
  assert.equal(await parallelDispatchIssue({ runDir: shadow, caseId: 'TC-2', attempt: 'new-attempt' }), null);
  const [d] = readSpeedDecisions(shadow);
  assert.deepEqual([d.kind, d.mode, d.allowed, d.errors[0].split(' ')[0]], ['parallel_lanes', 'shadow', false, 'PLAN_PARALLEL_LANE_SHARED_ACCOUNT']);
});

test('dispatch: the case dispatch start itself refuses two lanes on one account under on, before any worker runs', async () => {
  const shared = runWith([lane('a', 'REQ-A', { account: 'one@tenant' }), lane('b', 'REQ-B', { account: 'one@tenant' })], 'on');
  await assert.rejects(() => startCaseDispatch({ runDir: shared, role: 'executor_gui', caseId: 'TC-2', attempt: 'attempt-par-1' }),
    (error) => error.code === 'DISPATCH_PARALLEL_LANES_REFUSED' && /PLAN_PARALLEL_LANE_SHARED_ACCOUNT/.test(error.message));
  assert.equal((() => { try { return readFileSync(join(shared, 'dispatch/executor_gui/case-dispatches.jsonl'), 'utf8'); } catch { return ''; } })(), '', 'no attempt was recorded');
  const valid = runWith([lane('a', 'REQ-A'), lane('b', 'REQ-B')], 'on');
  assert.equal((await startCaseDispatch({ runDir: valid, role: 'executor_gui', caseId: 'TC-2', attempt: 'attempt-par-2' })).used, 1);
});
