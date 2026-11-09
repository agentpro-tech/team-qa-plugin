// Fix round 2 of the integrated upgrade, Team QA side: each finding of the second review reproduced first.
//   TQ2-3  the risk policy uses QA GUI's real classifier with a neutral context (needs a QA GUI checkout)
//   TQ2-m  the adjudicator refuses a screen check's attestation for a case; two states naming the probe each get their own trials
//   D7     a case of a parallel lane proves the Dragon session and account it really used
//   E9     timing counts each screen check against the cases on its screen, next to case_p50, and gives the run's wall time
// The end-to-end scenarios are in detectors-e2e.test.mjs; E7 is in web-collect-detectors.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { caseDetectorPlan, plannedActionKinds, qaGuiDetectorTools, riskyMainAction } from '../../scripts/lib/detector-dispatch.mjs';
import { caseDetectorResults } from '../../scripts/lib/detector-collect.mjs';
import { parallelLaneUseIssues } from '../../scripts/lib/parallel-lanes.mjs';
import { runTiming } from '../../scripts/lib/timing.mjs';
import { adjudicateCase } from '../../scripts/lib/adjudicator.mjs';

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
const SKIP = QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `teamqa-r2-${name}-`)));
const behavioral = (...steps) => ({ kind: 'behavioral', steps });

test('TQ2-3: with QA GUI\'s real classifier, reading and opening a page are not risky; save, delete, submit, a modal open and a sort are', { skip: SKIP }, async () => {
  const tools = await qaGuiDetectorTools(QA_GUI);
  const classify = tools.classifyAction;
  for (const steps of [['Read the heading'], ['Open the about page'], ['Go to the orders page', 'Read the total'], ['Navigate to settings']]) {
    assert.equal(riskyMainAction(behavioral(...steps), classify), false, steps.join(' / '));
  }
  for (const steps of [["Click 'Save'"], ["Click 'Delete'"], ["Click 'Submit'"], ['Open the edit dialog'], ["Click 'Sort by date'"]]) {
    assert.equal(riskyMainAction(behavioral(...steps), classify), true, steps.join(' / '));
  }
  // QA GUI decides how often: a write with no reset path in the plan gets no trial (N/A); a sort or a write with a reset gets 3.
  const plan = (c) => caseDetectorPlan({ plannedCase: c, classify, repeatability: tools.transientRepeatability });
  // Dogfood 05/11: a save with no reset path gets 3 fresh-value trials; a delete with none still gets no trial (N/A).
  assert.deepEqual(plan(behavioral("Click 'Save'")).transient, { trials: 3, kinds: ['save'], reset: false, fresh: true });
  assert.deepEqual([plan(behavioral("Click 'Delete'")).transient, plan(behavioral("Click 'Delete'")).transientNa], [false, 'TRANSIENT_WRITE_NO_RESET']);
  assert.deepEqual(plan({ ...behavioral("Click 'Save'"), data: { reset: ['Delete the saved row'] } }).transient, { trials: 3, kinds: ['save'], reset: true });
  assert.deepEqual(plan(behavioral("Click 'Sort by date'")).transient, { trials: 3, kinds: ['list-sort'], reset: false });
  assert.deepEqual(plannedActionKinds(behavioral('Open the orders page', "Click 'Delete'"), classify), ['delete']);
});

test('TQ2 minor: two states that name the probe are each credited only with the trials labelled for them', async () => {
  const seen = [];
  const tools = {
    dragonOps: (calls) => calls.map((c) => ({ kind: 'rpc', method: c.method, params: c.params, result: c.result, ok: c.ok, call: c })),
    transientProbeFromOps: (ops, { state }) => { seen.push([state, ops.filter((op) => op.method === 'frames.trial').map((op) => op.params.correlationId ?? 'none')]); return null; },
    uxActionResultsFromOps: () => [], uxUnavailableResults: () => [], explorationFromOps: async () => null, classifyAction: () => ({ risky: false, kinds: [] }),
  };
  const call = (i, method, params, result = { ok: true }) => ({ i, method, params: { tabId: 7, ...params }, json: { ok: true, result }, called_at: null, at: null });
  const calls = new Map([
    call(1, 'screenshot', { toFile: 'a.png' }, { ok: true, dom: { url: 'https://t/x' } }), call(2, 'screenshot', { toFile: 'b.png' }, { ok: true, dom: { url: 'https://t/x' } }),
    call(3, 'framesTrial', { correlationId: 'transient:a' }), call(4, 'framesTrial', { correlationId: 'transient:b' }), call(5, 'framesTrial', { correlationId: 'transient:a' }),
  ].map((c) => [c.i, c]));
  const draft = { case_id: 'TC', states: [{ state: 'a', transient: { action: {} } }, { state: 'b', transient: { action: {} } }] };
  const shots = new Map(draft.states.map((s, k) => [s, { call: calls.get(k + 1) }]));
  await caseDetectorResults({ draft, calls, shots, tools, plannedCase: { kind: 'static' }, exists: () => false, fileSha: () => null });
  assert.deepEqual(seen, [['a', ['transient:a', 'transient:a']], ['b', ['transient:b']]]);
});

test('TQ2 minor: the adjudicator refuses a screen check\'s attestation for a case', async () => {
  const runDir = tmp('adj');
  const stream = join(runDir, 'dispatch/executor_gui/screen-S1/stdout.jsonl');
  mkdirSync(join(runDir, 'dispatch/executor_gui/screen-S1'), { recursive: true });
  writeFileSync(stream, '{}\n');
  const attestation = join(runDir, 'screen.json');
  writeFileSync(attestation, JSON.stringify({ role: 'executor_gui', dispatch_screen_id: 'S1', source: { kind: 'claude-stream', path: stream, sha256: sha(readFileSync(stream)) } }));
  writeFileSync(join(runDir, 'board.jsonl'), `${JSON.stringify({ case_id: 'TC-1', verdict: 'pass', attempt: 1 })}\n`);
  await assert.rejects(adjudicateCase({ runDir, caseId: 'TC-1', seat: { provider: 'x', model: 'y' }, engine: { run: async () => ({}) }, attestationPath: attestation, boardPath: join(runDir, 'qa-board.json'), evidencePaths: [] }),
    (error) => /ADJUDICATE_ATTESTATION_SCREEN|ADJUDICATE_/.test(String(error.code ?? error.message)));
});

// A run whose plan turns parallel_gui_lanes on for two lanes, each with its own account and Dragon session.
function laneRun(mode = 'on') {
  const project = tmp('lanes'), runDir = join(project, 'runs', 'lanes');
  mkdirSync(runDir, { recursive: true });
  const lane = (id, req) => ({ id, scope: [req], parallel_ok: true, vi_sao: 'own data', account: `qa-${id}@tenant.test`, data_namespace: `ns-${id}`, dragon_session: `qa-${id}` });
  const plan = { run_id: 'lanes', app: 'shop', plan_version: 1, lanes: [lane('a', 'REQ-A'), lane('b', 'REQ-B')], tiers: { 'REQ-A': 'FULL', 'REQ-B': 'FULL' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 }, speed: { parallel_gui_lanes: mode } };
  writeFileSync(join(runDir, 'test-plan.md'), `TEAMQA_PLAN_START\n${JSON.stringify(plan)}\nTEAMQA_PLAN_END\n`);
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify({ cases: [{ id: 'TC-1', req_id: 'REQ-A', lane: 'gui' }] }));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'test-plan.md', sha256: sha(readFileSync(join(runDir, 'test-plan.md'))) }, tracked: { path: 'tracked-plan.json' } } }));
  return runDir;
}
test('D7: under parallel_gui_lanes on, a case proves its lane\'s Dragon session and account; shadow only records', async () => {
  const calls = (sessionId, typed) => [{ method: 'do', params: { sessionId, tabId: 7, steps: [{ fill: '#email', text: typed }] } }, { method: 'screenshot', params: { sessionId, tabId: 7 } }];
  assert.deepEqual(await parallelLaneUseIssues({ runDir: laneRun(), caseId: 'TC-1', calls: calls('qa-a-7f2', 'QA-A@tenant.test') }), []);
  assert.deepEqual(await parallelLaneUseIssues({ runDir: laneRun(), caseId: 'TC-1', calls: calls('qa-b-1', 'qa-b@tenant.test') }),
    ['PARALLEL_LANE_SESSION_MISMATCH:TC-1:qa-b-1', 'PARALLEL_LANE_ACCOUNT_UNPROVEN:TC-1:a']);
  const shadow = laneRun('shadow');
  assert.deepEqual(await parallelLaneUseIssues({ runDir: shadow, caseId: 'TC-1', calls: calls('qa-b-1', 'x') }), []);
  assert.match(readFileSync(join(shadow, 'decisions.jsonl'), 'utf8'), /"kind":"parallel_lanes","check":"use".*"allowed":false/);
  assert.deepEqual(await parallelLaneUseIssues({ runDir: laneRun('off'), caseId: 'TC-1', calls: calls('other', 'x') }), []);
});

test('E9: timing counts each screen check against the cases on its screen, next to case_p50, and gives the run\'s wall time', () => {
  const runDir = tmp('timing');
  const tracked = { cases: [{ id: 'TC-1', lane: 'gui', route: '/orders' }, { id: 'TC-2', lane: 'gui', route: '/orders' }, { id: 'TC-3', lane: 'gui', route: '/wizard' }] };
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify(tracked));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { tracked: { path: 'tracked-plan.json' } } }));
  const state = (attempt, extra) => { mkdirSync(join(runDir, 'dispatch', 'executor_gui', attempt), { recursive: true }); writeFileSync(join(runDir, 'dispatch', 'executor_gui', attempt, 'state.json'), JSON.stringify({ attempt, role: 'executor_gui', status: 'done', ...extra })); };
  state('s1', { case_id: null, screen_id: 'S1', started_at: '2026-11-05T01:00:00.000Z', ended_at: '2026-11-05T01:05:00.000Z' });
  state('c1', { case_id: 'TC-1', started_at: '2026-11-05T01:05:00.000Z', ended_at: '2026-11-05T01:07:00.000Z' });
  state('c2', { case_id: 'TC-2', started_at: '2026-11-05T01:07:00.000Z', ended_at: '2026-11-05T01:10:00.000Z' });
  state('c3', { case_id: 'TC-3', started_at: '2026-11-05T01:10:00.000Z', ended_at: '2026-11-05T01:14:00.000Z' });
  const t = runTiming({ runDir, runId: 'r' });
  assert.deepEqual(t.summary.screen_checks_ms, { S1: 300000 });
  assert.equal(t.summary.case_p50_ms, 180000);
  // TC-1 2+5, TC-2 3+5, TC-3 4 (its screen S2 has no check): P50 7 min.
  assert.equal(t.summary.case_with_screens_p50_ms, 420000);
  assert.equal(t.summary.run_wall_ms, 14 * 60000);
});
