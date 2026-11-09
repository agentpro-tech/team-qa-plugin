// Upgrade R3: the speed flags in `web collect` and in the GUI case dispatch prompt. QA GUI's speed tools are stubbed
// here (their own tests are in QA GUI); with TEAMQA_WEB_TEST_QA_GUI_ROOT the last test uses the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applySpeedToCase, caseChecksHoverOrDrag, dispatchSpeedSection, qaGuiSpeedTools, speedPromptSection, tier2States } from '../../scripts/lib/speed-collect.mjs';
import { appendSpeedDecision, readSpeedDecisions } from '../../scripts/lib/cost-ladder.mjs';
import { DRAFT_MARKER, streamCalls, webCollect } from '../../scripts/lib/web-collect.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const policy = (flags, extra = {}) => ({ version: 1, source: { kind: 'team-qa/signed-plan', sha256: 'f'.repeat(64), path: 'test-plan.md' },
  flags: { vision_by_diff: 'off', cost_ladder: 'off', parallel_gui_lanes: 'off', fast_click: 'off', action_cache: 'off', ...flags }, min_tier: {}, ...extra });

// Stub QA GUI speed tools: a state named *-same inherits, any other goes to the VLM.
function stubTools() {
  return {
    routeOf: (url) => new URL(url).pathname,
    storeErrors: () => [],
    visionDiffDecision: ({ key }) => key.state.endsWith('-same')
      ? { decision: 'inherit', tier: 0, reasons: [], baseline: { sha256: 'b'.repeat(64), key, same_build: true }, diff: { percent: 0, max_tile_percent: 0 }, verdicts: Object.fromEntries(RULES.map((r) => [r, 'PASS'])), duration_ms: 3 }
      : { decision: 'vlm', tier: 2, reasons: ['DIFF_OVER_LIMIT'], baseline: { sha256: 'b'.repeat(64), key, same_build: true }, diff: { percent: 3.2, max_tile_percent: 40 }, verdicts: null, duration_ms: 3 },
    inheritedVisionAssertions: ({ decision, caseId, state, evidenceRef }) => RULES.map((rule) => ({ assertion_id: `${caseId}-${state}-${rule}`, case_id: caseId, state, rule, verdict: 'PASS',
      evidence_ref: evidenceRef, evidence_type: 'gui-screenshot', inherited: { schema: 'qa-gui/vision-inherit/v1', baseline_sha256: decision.baseline.sha256, baseline_key: decision.baseline.key, diff_percent: 0, max_tile_percent: 0 } })),
    fastClickPlan: ({ mode, caseChecksHoverOrDrag }) => mode !== 'on' ? { fast: false, reason: 'POLICY_OFF' } : caseChecksHoverOrDrag ? { fast: false, reason: 'CASE_CHECKS_HOVER_OR_DRAG' } : { fast: true, reason: 'POLICY_ON' },
    fastClickSummary: (calls) => ({ clicks: calls.filter((c) => c.method === 'do').length, fast_clicks: calls.filter((c) => c.params?.fast === true).length, hover_or_drag: 0 }),
    fastClickIssues: ({ calls, mode, caseChecksHoverOrDrag }) => mode === 'on' && caseChecksHoverOrDrag && calls.some((c) => c.params?.fast === true) ? ['FAST_CLICK_ON_HOVER_OR_DRAG_CASE:1 fast click(s) in a case that checks hover or drag-and-drop'] : [],
  };
}
const vlm = (caseId, state, verdicts = {}) => RULES.map((rule) => ({ assertion_id: `${caseId}-${state}-${rule}`, case_id: caseId, state, rule, verdict: verdicts[rule] ?? 'PASS', evidence_ref: `evidence/qa-gui/${caseId}/${state}.png`, evidence_type: 'gui-screenshot' }));
function built(states) {
  return {
    caseId: 'TC-01', issues: [],
    files: states.map(({ state }) => ({ data: Buffer.from(`png ${state}`), rel: `evidence/qa-gui/TC-01/${state}.png` })),
    receipts: states.map(({ state }) => ({ rel: `evidence/qa-gui/TC-01/${state}.receipt.json`, value: { state, url: 'https://app.test/orders', viewport: '1280x800', build: 'b-2',
      capturedAt: '2026-11-04T03:00:00.000Z', screenshot: { path: `evidence/qa-gui/TC-01/${state}.png` }, ui: { uiSanity: { verdict: 'PASS' }, a11y: { verdict: 'PASS' } } } })),
    vision: states.flatMap(({ state, verdicts, inherit }) => (inherit ? vlm('TC-01', state, Object.fromEntries(RULES.map((r) => [r, 'UNGRADED']))) : vlm('TC-01', state, verdicts))),
  };
}
const draftOf = (states) => ({ case_id: 'TC-01', states: states.map(({ state, inherit }) => ({ state, ...(inherit ? { vision: 'inherit' } : {}) })) });
const run = (states, flags, extra) => applySpeedToCase({ built: built(states), draft: draftOf(states), calls: new Map(), policy: policy(flags, extra), tools: stubTools(),
  baselines: { store: {}, dir: '/nowhere' }, plannedCase: { id: 'TC-01', title: 'List orders', steps: ['Open the list'] }, readFile: () => Buffer.alloc(0), now: () => '2026-11-04T03:00:00.000Z' });

test('vision_by_diff shadow: the VLM verdicts stay; the log says what inheriting would give and which VLM FAIL it would miss', () => {
  const states = [{ state: 'list-same' }, { state: 'detail-same', verdicts: { C12: 'FAIL' } }, { state: 'edit-changed' }];
  const r = run(states, { vision_by_diff: 'shadow' });
  assert.deepEqual(r.built.vision, built(states).vision, 'nothing on the board changes in shadow');
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.decisions.map((d) => [d.state, d.decision, d.applied, d.agree, d.missed_rules]), [
    ['list-same', 'inherit', false, true, []], ['detail-same', 'inherit', false, false, ['C12']], ['edit-changed', 'vlm', false, null, []]]);
  assert.ok(r.decisions.every((d) => d.kind === 'vision_by_diff' && d.mode === 'shadow' && d.baseline_sha256 === 'b'.repeat(64)));
});

test('vision_by_diff on: an inheritable state carries the baseline; a FAIL the VLM saw is kept; a state left to the machine that cannot inherit goes to tier 2', () => {
  const states = [{ state: 'list-same', inherit: true }, { state: 'detail-same', verdicts: { C11: 'FAIL' } }, { state: 'edit-changed', inherit: true }, { state: 'view-changed' }];
  const r = run(states, { vision_by_diff: 'on' });
  const byState = (state) => r.built.vision.filter((v) => v.state === state);
  assert.ok(byState('list-same').every((v) => v.verdict === 'PASS' && v.inherited.baseline_sha256 === 'b'.repeat(64)));
  assert.equal(byState('detail-same').find((v) => v.rule === 'C11').verdict, 'FAIL');
  assert.ok(byState('detail-same').every((v) => !v.inherited), 'a FAIL the VLM saw is never overwritten by a baseline');
  assert.ok(byState('edit-changed').every((v) => v.verdict === 'UNGRADED' && !v.inherited));
  assert.ok(byState('view-changed').every((v) => v.verdict === 'PASS' && !v.inherited), 'the executor judged it; nothing to do');
  assert.deepEqual(r.issues, ['VISION_TIER2_REQUIRED:TC-01:edit-changed:DIFF_OVER_LIMIT']);
  assert.deepEqual(r.decisions.map((d) => [d.state, d.applied, d.vlm_skipped, d.escalated]), [
    ['list-same', true, true, false], ['detail-same', false, false, false], ['edit-changed', false, false, true], ['view-changed', false, false, false]]);
});

test('cost_ladder: a record per check and state; tier 0 settles an inherited state, otherwise tier 0 pushes it up to tier 2', () => {
  const r = run([{ state: 'list-same', inherit: true }, { state: 'edit-changed' }], { vision_by_diff: 'on', cost_ladder: 'on' });
  const ladder = r.decisions.filter((d) => d.kind === 'ladder');
  assert.deepEqual(ladder.map((d) => [d.state, d.check, d.settled_tier, d.steps.map((s) => `${s.tier}:${s.outcome}`).join('>')]), [
    ['list-same', 'gate0', 0, '0:settled'], ['list-same', 'vision', 0, '0:settled'], ['list-same', 'function', 2, '2:settled'],
    ['edit-changed', 'gate0', 0, '0:settled'], ['edit-changed', 'vision', 2, '0:escalate>2:settled'], ['edit-changed', 'function', 2, '2:settled']]);
  // The plan raised the vision minimum to 2: vision by diff may not settle it, and the ladder starts at 2.
  const raised = run([{ state: 'list-same', inherit: true }], { vision_by_diff: 'on', cost_ladder: 'on' }, { min_tier: { vision: 2 } });
  assert.deepEqual(raised.decisions.filter((d) => d.kind === 'ladder' && d.check === 'vision').map((d) => [d.settled_tier, d.errors]), [[2, []]]);
  // A minimum the run did not reach (function at tier 3, the adjudicator) is reported, never hidden.
  const unmet = run([{ state: 'view-changed' }], { cost_ladder: 'on' }, { min_tier: { function: 3 } });
  assert.deepEqual(unmet.issues, ['LADDER_BELOW_MIN_TIER:TC-01:view-changed:function:LADDER_BELOW_MIN_TIER:2<3']);
});

test('fast_click: on refuses a fast click in a case that checks hover or drag; shadow only logs; the case text decides too', () => {
  assert.equal(caseChecksHoverOrDrag({ title: 'Hover menu shows the actions' }), true);
  assert.equal(caseChecksHoverOrDrag({ title: 'Reorder rows', steps: ['Drag row 2 above row 1'] }), true);
  assert.equal(caseChecksHoverOrDrag({ title: 'Save an order', data: { interaction: ['hover'] } }), true);
  assert.equal(caseChecksHoverOrDrag({ title: 'Save an order', steps: ['Click Save'] }), false);
  const calls = streamCalls([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'do', params: { steps: [{ click: 'Save' }], fast: true } } }] } }].map((e) => JSON.stringify(e)).join('\n'));
  const go = (flags, plannedCase) => applySpeedToCase({ built: built([]), draft: draftOf([]), calls, policy: policy(flags), tools: stubTools(), plannedCase, readFile: () => null });
  assert.match(go({ fast_click: 'on' }, { title: 'Hover menu' }).refuse, /^FAST_CLICK_ON_HOVER_OR_DRAG_CASE/);
  assert.equal(go({ fast_click: 'on' }, { title: 'Save an order' }).refuse, null);
  const shadow = go({ fast_click: 'shadow' }, { title: 'Hover menu' });
  assert.equal(shadow.refuse, null);
  assert.deepEqual([shadow.decisions[0].kind, shadow.decisions[0].mode, shadow.decisions[0].summary.fast_clicks], ['fast_click', 'shadow', 1]);
  assert.deepEqual(go({}, { title: 'Hover menu' }).decisions, [], 'off logs nothing');
});

test('the dispatch prompt gets a TEAMQA_SPEED section only for flags that are on', () => {
  assert.equal(speedPromptSection({ policy: policy({}), plannedCase: { title: 'x' } }), '');
  assert.equal(speedPromptSection({ policy: policy({ fast_click: 'shadow', vision_by_diff: 'shadow' }), plannedCase: { title: 'x' } }), '', 'shadow does not change what the executor does');
  assert.match(speedPromptSection({ policy: policy({ fast_click: 'on' }), plannedCase: { title: 'Save' } }), /fast:true/);
  assert.match(speedPromptSection({ policy: policy({ fast_click: 'on' }), plannedCase: { title: 'Hover menu' } }), /keep human-speed input: every click step `fast:false`/);
  const lane = { id: 'lane-b', parallel_ok: true, account: 'qa-b@tenant-b', data_namespace: 'ns-b', dragon_session: 'qa-b' };
  assert.match(speedPromptSection({ policy: policy({ parallel_gui_lanes: 'on' }), plannedCase: { title: 'x' }, lane }), /starts with `qa-b-`.*qa-b@tenant-b.*ns-b/);
  assert.match(speedPromptSection({ policy: policy({ vision_by_diff: 'on' }), plannedCase: { title: 'x' }, tier2: new Set(['edit-changed']) }), /"vision": "inherit"[\s\S]*for them yourself: edit-changed/);
});

// A run directory with a signed-plan file, a locked tracked plan, a baseline store, a stream and a board.
function runFixture(speed) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-collect-')));
  const runDir = join(project, 'runs', 'r1');
  mkdirSync(join(runDir, 'board'), { recursive: true });
  mkdirSync(join(project, 'baselines', 'png'), { recursive: true });
  const store = { schema: 'qa-gui/approved-baselines/v1', entries: [{ sha256: 'b'.repeat(64) }] };
  writeFileSync(join(project, 'baselines', 'approved-baselines.json'), JSON.stringify(store));
  writeFileSync(join(project, 'baselines', 'png', `${'b'.repeat(64)}.png`), 'baseline png');
  const storePin = { path: 'baselines/approved-baselines.json', sha256: sha(readFileSync(join(project, 'baselines', 'approved-baselines.json'))) };
  const planValue = { run_id: 'r1', app: 'shop', plan_version: 1, lanes: [{ id: 'gui', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }], tiers: { 'REQ-1': 'FULL' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 }, ...(speed ? { speed: { ...speed, ...(speed.vision_by_diff ? { baseline_store: storePin } : {}) } } : {}) };
  writeFileSync(join(runDir, 'test-plan.md'), `TEAMQA_PLAN_START\n${JSON.stringify(planValue)}\nTEAMQA_PLAN_END\n`);
  const PNG = join(project, 'shot.png'); writeFileSync(PNG, 'state png');
  const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
  const S = { sessionId: 'exec-s1', nonce: 'n1', browserInstanceId: 'bi-1' };
  const ev = [
    { type: 'assistant', timestamp: '2026-11-04T03:00:01Z', message: { content: [{ type: 'tool_use', id: 'u1', name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'session.create', params: { sessionId: 'exec-s1' } } }] } },
    { type: 'user', timestamp: '2026-11-04T03:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: ok({ ...S }) }] } },
    { type: 'assistant', timestamp: '2026-11-04T03:00:03Z', message: { content: [{ type: 'tool_use', id: 'u2', name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'screenshot', params: { ...S, tabId: 7, toFile: 'list-same.png' } } }] } },
    { type: 'user', timestamp: '2026-11-04T03:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: ok({ savedTo: PNG, sha256: sha(readFileSync(PNG)), domHash: 'd'.repeat(64), privacyMasked: true, dom: { url: 'https://app.test/orders', viewport: '1280x800' } }) }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: `${DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify({ case_id: 'TC-01', summary: { function: 'f', ui: 'u' }, lifecycle: {},
      states: [{ state: 'list-same', screenshot: 'list-same.png', assertions: [{ assertion_id: 'TC-01-A1', verdict: 'PASS' }], vision: 'inherit' }] })}\n\`\`\`\n` }] } },
  ];
  const stream = ev.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(runDir, 'stream.jsonl'), stream);
  const binding = { run_uuid: '11111111-1111-4111-8111-111111111111', target_binding_sha256: 'b'.repeat(64), target: { frontend_build: { id: 'b-2' } } };
  writeFileSync(join(runDir, 'binding.json'), JSON.stringify(binding));
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify({ cases: [{ id: 'TC-01', req_id: 'REQ-1', title: 'List orders', steps: ['Open the list'] }] }));
  const boardFile = join(runDir, 'board', 'qa-board.json');
  writeFileSync(boardFile, JSON.stringify({ runUuid: binding.run_uuid, viewport: '1280x800', cases: [{ id: 'TC-01', status: 'TODO' }] }));
  const deps = {
    parseFlags: (args) => ({ run: args[1], attestation: args[3], board: args[5] }), readJson: (p) => JSON.parse(readFileSync(p, 'utf8')),
    writeConfirmed: async (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); }, stableJson: (v) => JSON.stringify(v),
    fail: (exit, code, detail) => { throw Object.assign(new Error(`${code} ${detail}`), { code, detail }); },
    assertRoleAttestation: () => ({ source: { kind: 'claude-stream', path: 'stream.jsonl', sha256: sha(Buffer.from(stream, 'utf8')) }, dispatch_case_id: 'TC-01', roster_hash: 'r' }),
    runDirectory: () => runDir, safeRunId: (v) => v, detectorTools: null,
    evidenceTools: { EVIDENCE_POLICY_VERSION: 1, MAX_EVIDENCE_WIDTH: 1280, fitPng: (bytes) => ({ png: bytes, sha256: sha(bytes), fit: {} }), buildRecordingManifest: () => null,
      stateImageIssues: () => [], recordingSegmentIssues: () => [] },
    speedTools: stubTools(),
  };
  return { runDir, boardFile, deps, collect: () => webCollect(['--run', 'r1', '--attestation', join(runDir, 'a.json'), '--board', boardFile], deps) };
}

test('web collect: every flag off writes no speed policy and no decision log; on copies the pinned store into the run and logs each decision', async () => {
  const off = runFixture(null);
  const doneOff = await off.collect();
  assert.equal(Object.hasOwn(doneOff, 'speed'), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(off.boardFile, 'utf8')), 'speedPolicy'), false);
  assert.equal(existsSync(join(off.runDir, 'decisions.jsonl')), false);
  const on = runFixture({ vision_by_diff: 'on', cost_ladder: 'on' });
  const done = await on.collect();
  assert.deepEqual(done.speed.flags.vision_by_diff, 'on');
  const board = JSON.parse(readFileSync(on.boardFile, 'utf8'));
  assert.deepEqual(board.speedPolicy.baseline_store.path, 'evidence/qa-gui/speed/approved-baselines.json');
  assert.equal(sha(readFileSync(join(on.runDir, board.speedPolicy.baseline_store.path))), board.speedPolicy.baseline_store.sha256, 'the in-run copy is the store the signed plan pins');
  assert.ok(existsSync(join(on.runDir, 'evidence/qa-gui/speed/png', `${'b'.repeat(64)}.png`)));
  assert.ok(board.vision.assertions.every((a) => a.inherited?.baseline_sha256 === 'b'.repeat(64)));
  const kinds = readSpeedDecisions(on.runDir).map((d) => d.kind);
  assert.deepEqual(kinds, ['vision_by_diff', 'ladder', 'ladder', 'ladder']);
  // A store that is not the one the signed plan pins stops the collect.
  const drift = runFixture({ vision_by_diff: 'on' });
  writeFileSync(join(dirname(dirname(drift.runDir)), 'baselines', 'approved-baselines.json'), '{"schema":"qa-gui/approved-baselines/v1","entries":[]}');
  await assert.rejects(drift.collect(), (e) => e.code === 'SPEED_STORE_DRIFT');
});

test('dispatch section: read from the run, with the states the last attempt sent to the VLM', async () => {
  const { runDir } = runFixture({ vision_by_diff: 'on' });
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'test-plan.md', sha256: sha(readFileSync(join(runDir, 'test-plan.md'))) }, tracked: { path: 'tracked-plan.json', sha256: 'x' } } }));
  assert.match(await dispatchSpeedSection({ runDir, caseId: 'TC-01' }), /^TEAMQA_SPEED/);
  await appendSpeedDecision(runDir, { schema: 'team-qa/speed-decision/v1', kind: 'vision_by_diff', mode: 'on', case_id: 'TC-01', state: 'edit-changed', decision: 'vlm', escalated: true });
  assert.deepEqual([...tier2States(runDir, 'TC-01')], ['edit-changed']);
  assert.match(await dispatchSpeedSection({ runDir, caseId: 'TC-01' }), /for them yourself: edit-changed/);
  const off = runFixture(null);
  assert.equal(await dispatchSpeedSection({ runDir: off.runDir, caseId: 'TC-01' }), '');
});

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
test('the real QA GUI speed tools load and have what collect calls', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout with the R3 speed tools' }, async () => {
  const tools = await qaGuiSpeedTools(QA_GUI);
  for (const name of Object.keys(stubTools())) assert.equal(typeof tools[name], 'function', name);
});
