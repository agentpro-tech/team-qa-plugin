// Upgrade integration: QA GUI's detectors in a Team QA web-lane run. Team QA decides what a case runs
// (lib/detector-dispatch.mjs), puts QA GUI's recipes in the case dispatch, and `web collect` carries what QA GUI rebuilt
// from the executor's stream into the run (lib/detector-collect.mjs): probe files and their cells, kept frames hash for
// hash, the Dragon conditions of each state and the case's env.reset. The width sweep and the overlay check come from the
// run's screen checks (fix round 1, D1: once per screen, their own dispatch), folded into the case by QA GUI. Team QA
// grades nothing. These tests use stand-in QA GUI functions (the real ones: test/claude-host/detectors-e2e.test.mjs).
// Synthetic streams, never a live run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DRAFT_MARKER, buildCaseEvidence, draftIssues, stateScreenshots, streamCalls } from '../../scripts/lib/web-collect.mjs';
import { caseDetectorPlan, caseUxRules, dispatchDetectorSection, qaGuiDetectorTools } from '../../scripts/lib/detector-dispatch.mjs';
import { caseDetectorResults, caseEnvironment, dragonR1a } from '../../scripts/lib/detector-collect.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-detectors-')));
const PNG = join(dir, 'after-save.png');
writeFileSync(PNG, Buffer.from('\x89PNG fixture'));
const FRAMES = join(dir, 'frames', 'fw-a-1');
mkdirSync(FRAMES, { recursive: true });
writeFileSync(join(FRAMES, 'f-00003.jpg'), 'frame three');
const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
let clock = Date.parse('2026-11-04T03:00:00Z');
const use = (id, name, input) => ({ type: 'assistant', timestamp: new Date(clock += 1000).toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, error = false) => ({ type: 'user', timestamp: new Date(clock += 500).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] } });
const T = 'mcp__Dragon_Browser__';
const forced = { v: 1, caseId: 'TC-01', role: 'test', network: null, cpu: null, timezone: null, locale: null, media: null, animation: null,
  requests: [{ id: 'write', urlPattern: '*/api/orders*', action: 'hold', status: null, errorReason: null, matched: 1 }], probes: { sensors: true, frames: false }, verified: true, setAt: 1, expiresAt: 2 };

// `r1a`: true (a Dragon with R1a), false (an older Dragon: `help` without environmentContract, an R1a tool refused) or
// 'silent' (no R1a call and no help at all). `claim`: the draft's `detectors.unavailable` map (true: transient and ux).
const NO_R1A = { transient: 'DRAGON_R1A_UNAVAILABLE', ux: 'DRAGON_R1A_UNAVAILABLE' };
// `g0ui`: the Gate-0 ui report of the state. `forcedError`: a request rule answered the save 500 (env.get logs it), and
// the page logged it; `unforced500`: another request failed on its own.
const G0_PASS = { v: 'ui-sanity/2.0', verdict: 'PASS', issues: [], counts: { high: 0, warn: 0 } };
const API = 'http://127.0.0.1:5411/api/orders';
function stream({ reset = true, r1a = true, claim = false, g0ui = G0_PASS, forcedError = false, unforced500 = false, unforced503 = false, heldWrite500 = false, ruleReplaced = false } = {}) {
  let n = 0;
  // The respond rule that answered the save 500 is in force when the state is captured (fix round 2, E7: a request is
  // excused only in a state whose conditions hold its rule). `ruleReplaced` (fix round 3, F7): an earlier envSet set the
  // respond rule, the 500 came then, and the hold rule's envSet replaced the list before the state was captured.
  const saveError = { id: 'save-error', urlPattern: '*/api/orders*', method: 'POST', action: forcedError ? 'respond' : 'hold', status: forcedError ? 500 : null };
  const cond = (forcedError && !ruleReplaced) || heldWrite500 ? { ...forced, requests: [...(forced.requests ?? []), saveError] } : forced;
  const S = { sessionId: 'exec-s1', nonce: 'n1', browserInstanceId: 'bi-1' };
  const pair = (name, input, value) => { const id = `toolu_${++n}`; const params = name === 'dragon_rpc' ? { ...input, params: { ...S, ...input.params } } : { ...S, ...input };
    return [use(id, `${T}${name}`, params), result(id, ok(value))]; };
  const refused = (name, input) => { const id = `toolu_${++n}`; return [use(id, `${T}${name}`, { ...S, ...input }), result(id, [{ type: 'text', text: `Error: No such tool available: ${T}${name}` }], true)]; };
  const older = [
    ...(r1a === false ? [...pair('help', {}, { version: '1.5.0', methods: ['do', 'screenshot', 'getConsole', 'getNetwork'] }), ...refused('sensorsStart', { tabId: 7 })] : []),
    ...pair('do', { tabId: 7, steps: [{ clickSelector: '#save', fast: false }] }, { completed: true, results: [{ step: 'clickSelector', ok: true, receipt: { ts: 11 } }] }),
  ];
  const events = [
    ...(r1a !== true ? older : [
    ...(ruleReplaced ? pair('envSet', { tabId: 7, caseId: 'TC-01', requests: [saveError] }, { ok: true, applied: ['requests'], conditions: { ...forced, requests: [saveError] } }) : []),
    ...pair('envSet', { tabId: 7, caseId: 'TC-01', requests: [{ id: 'write', urlPattern: '*/api/orders*', method: 'POST', action: 'hold' }] }, { ok: true, applied: ['requests'], conditions: cond }),
    ...pair('sensorsStart', { tabId: 7 }, { ok: true, startedAt: 1, conditions: cond }),
    ...pair('do', { tabId: 7, steps: [{ read: 'x', as: 't:s-pre' }, { clickSelector: '#save', fast: false }] },
      { completed: true, results: [{ step: 'read', as: 't:s-pre', value: { t: 10 } }, { step: 'clickSelector', ok: true, receipt: { ts: 11, env: { conditions: cond } } }] }),
    ...pair('framesStop', { tabId: 7, keep: 'all' }, { ok: true, windowId: 'fw-a-1', dir: FRAMES, frames: [{ seq: 3, t: 12, file: 'f-00003.jpg', sha256: sha('frame three') }] })]),
    ...pair('screenshot', { tabId: 7, toFile: 'after-save.png' }, { savedTo: PNG, sha256: sha(readFileSync(PNG)), domHash: 'd'.repeat(64), privacyMasked: true,
      dom: { url: 'http://127.0.0.1:5401/orders', viewport: '1280x800' } }),
    // The whole sweep reports: `v` is their version, `verdict` their verdict (the short `{v: "PASS"}` form still reads).
    ...(forcedError ? pair('envGet', { tabId: 7 }, { ok: true, conditions: cond, held: [], requests: [{ t: 19, ruleId: 'save-error', action: 'respond', url: API, method: 'POST', outcome: 'responded:500' }] }) : []),
    // A held write reaches the server when it is released: its real 500 is a real failure (fix round 2, E7).
    ...(heldWrite500 ? pair('envGet', { tabId: 7 }, { ok: true, conditions: cond, held: [], requests: [{ t: 18, ruleId: 'save-error', action: 'hold', url: API, method: 'POST', outcome: 'held' },
      { t: 19, ruleId: 'save-error', action: 'hold', url: API, method: 'POST', outcome: 'released:release' }] }) : []),
    ...pair('do', { tabId: 7, steps: [{ read: 'gate0()', as: 'g0' }] }, { completed: true, results: [{ step: 'read', as: 'g0', value: { ui: g0ui, a11y: { v: 'PASS' } } }] }),
    ...pair('dragon_rpc', { method: 'getConsole', params: { tabId: 7 } }, forcedError ? { count: 1, entries: [{ level: 'error', text: `Failed to load resource: the server responded with a status of 500 (${API})` }] } : { count: 0, entries: [] }),
    ...pair('dragon_rpc', { method: 'getNetwork', params: { tabId: 7 } }, { count: 1, requests: [{ t: 20, method: 'POST', url: API, status: forcedError || heldWrite500 ? 500 : 201, type: 'Fetch' },
      ...(unforced500 ? [{ t: 21, method: 'GET', url: 'http://127.0.0.1:5411/api/stock', status: 500, type: 'Fetch' }] : []),
      ...(unforced503 ? [{ t: 22, method: 'GET', url: `${API}?page=2`, status: 503, type: 'Fetch' }] : [])] }),
    ...(reset && r1a === true ? pair('envReset', { tabId: 7 }, { ok: true, atDefault: true, endedCase: 'TC-01', errors: [], mismatches: [] }) : []),
  ];
  const draft = { case_id: 'TC-01', summary: { function: 'Saved.', ui: 'Clean.' }, states: [{ state: 'after-save', screenshot: 'after-save.png', gate0: 'g0', console: true, network: true,
    assertions: [{ assertion_id: 'TC-01-A1', verdict: 'PASS' }],
    ...(claim ? { detectors: { unavailable: claim === true ? NO_R1A : claim } } : { transient: { action: { method: 'click', target: { tag: 'button', label: 'Save', inForm: true } }, repeatable: false }, ux: ['U1', 'U2'] }),
    screen: true }] };
  events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `${DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n` }] } });
  return { calls: streamCalls(events.map((e) => JSON.stringify(e)).join('\n')), draft };
}

// Stand-ins for QA GUI's functions: what each one returns is what Team QA must carry, unchanged.
function stubDetectors({ probeVerdict = 'PASS', u2 = 'FAIL' } = {}) {
  const seen = { transient: [], fold: [] };
  return {
    seen,
    tools: {
      STREAM_DETECTORS_VERSION: 'qa-gui/stream-detectors/v1',
      dragonOps: (calls) => calls,
      transientProbeFromOps: (ops, options) => {
        if (!ops.some((op) => op.params?.steps?.some?.((s) => s.as === 't:s-pre'))) return null;
        const stop = ops.find((op) => op.method === 'frames.stop');
        const file = options.frameRef(stop.result, stop.result.frames[0]);
        seen.transient.push({ methods: ops.map((op) => op.method), file, action: options.action, repeatable: options.repeatable });
        return { receipt: { schema: 'qa-gui/transient-probe/v1', caseId: options.caseId, state: options.state, file }, issues: [] };
      },
      widthSweepFromOps: async (ops) => (ops.some((op) => op.params?.steps?.some?.((s) => s.as === 'w:found')) ? { receipt: { schema: 'qa-gui/width-sweep/v1', bands: [], rows: [] }, issues: [] } : null),
      overlayCheckFromOps: (ops, { route }) => { seen.overlay.push(route); return ops.some((op) => op.params?.steps?.some?.((s) => s.as === 'o:triggers')) ? { receipt: { schema: 'qa-gui/overlay-check/v1', route, triggers: [], overlays: [] }, issues: [] } : null; },
      explorationFromOps: async () => null,
      // QA GUI's fold of the run's screen checks into a case (contract of stream-detectors.mjs foldScreenChecks).
      foldScreenChecks: ({ caseId, states, screens }) => {
        seen.fold.push({ caseId, states, screens: screens.map((x) => [x.screenId, x.status]) });
        const byState = new Map(states.map((x) => [x.state, { probes: [], issues: [] }])), issues = [], notes = [];
        for (const screen of screens) {
          if (screen.status === 'no-route') { notes.push(`SCREEN_NO_ROUTE:${caseId}`); continue; }
          if (screen.status === 'unavailable') { notes.push(`SCREEN_CHECK_UNAVAILABLE:${screen.screenId}:DRAGON_R1A_UNAVAILABLE`); continue; }
          const at = states.find((x) => new URL(x.url).pathname === screen.route);
          if (!at) continue;
          if (screen.status !== 'checked') { const code = `DETECTOR_NOT_RUN:${caseId}:screens:${screen.screenId}`; issues.push(code); byState.get(at.state).issues.push(code); continue; }
          byState.get(at.state).probes.push({ kind: 'width-sweep', receipt: screen.result.sweep, screenId: screen.screenId }, { kind: 'overlay-check', receipt: screen.result.overlay, screenId: screen.screenId });
        }
        return { states: byState, issues, notes };
      },
      uxUnavailableResults: (rules, reason) => rules.map((id) => ({ id, rule: 'forced', verdict: 'UNGRADED', level: 'warn', findings: [], reason })),
      uxActionResultsFromOps: (ops, { rules }) => rules.map((id) => ({ id, rule: 'double-submit-open', verdict: u2, level: 'warn', findings: u2 === 'FAIL' ? [{ sel: '#save', detail: 'still enabled' }] : [] })),
      foldUxInto: (report, results, { require }) => ({ ...report, verdict: results.some((r) => r.verdict === 'FAIL') ? 'FAIL' : require.some((id) => !results.find((r) => r.id === id)) ? 'UNGRADED' : report.verdict ?? 'PASS', ux: { rules: Object.fromEntries(results.map((r) => [r.id, r])) } }),
      detectorPromptSection: ({ caseId, detectors, fast }) => `recipes for ${caseId} ${JSON.stringify(detectors)} fast=${fast}`,
      probeCells: ({ caseId, state, kind, probeSha256, receipt }) => ({ schema: 'qa-gui/probe-cells/v1', case: caseId, state, kind, probe_sha256: probeSha256, cells: [{ route: receipt.cell?.route ?? '/orders' }], integrity: 'x' }),
      probeVerdict: ({ receipt, read, locate }) => {
        for (const p of receipt.probes) assert.ok(locate(p.path) && sha(read(p.path)) === p.sha256, `the gate reads ${p.path} hash for hash`);
        return { verdict: probeVerdict, issues: probeVerdict === 'FAIL' ? [{ message: 'PROBE:TC-01:after-save:TRANSIENT_T5:FAIL' }] : [] };
      },
      stateEnvIssues: ({ receipt, read, locate }) => {
        if (!receipt.env) return { issues: [], requiresReset: false, reset: null };
        const ref = receipt.env.reset?.evidence_ref;
        const raw = ref && locate(ref) ? JSON.parse(read(ref)) : null;
        return { issues: [], requiresReset: true, reset: raw ? { verified: raw.result?.atDefault === true, code: null } : null };
      },
      caseEnvResetIssues: ({ caseId, states }) => (states.some((s) => s.requiresReset) && !states.some((s) => s.reset?.verified) ? [{ message: `ENV_RESET_MISSING:${caseId}` }] : []),
      cellConditionsOf: (record) => (record?.requests?.length ? { request: record.requests.map((r) => r.action).join(',') } : {}),
      routeOf: (url) => new URL(url).pathname,
      buildAppMapV2: (log) => ({ schema: 'qa-gui/app-map/v2', log }),
    },
  };
}
const binding = { run_uuid: '11111111-1111-4111-8111-111111111111', target_binding_sha256: 'b'.repeat(64), target: { frontend_build: { id: 'index-1' } } };
const planned = { id: 'TC-01', req_id: 'REQ-1', kind: 'behavioral', route: '/orders', actions: ['view'], conditions: ['request=hold'], data: {} };
const coverage = { version: 'team-qa/coverage-cells/v1', rows: [{ id: 'desktop-1280', size: '1280x800', classes: ['desktop'] }] };
const cellTools = { EVIDENCE_POLICY_VERSION: 1, MAX_EVIDENCE_WIDTH: 1280, fitPng: (bytes) => ({ png: bytes, sha256: sha(bytes), fit: { width: 1280 } }), buildRecordingManifest: () => { throw new Error('none'); },
  stateImageIssues: () => [], recordingSegmentIssues: () => [], COVERAGE_CELL_VERSION: 'qa-gui/coverage-cell/v1', stateCellIssues: () => [] };
const fileSha = (path) => sha(readFileSync(path));
const exists = (path) => { try { readFileSync(path); return true; } catch { return false; } };
// The run's screen check of /orders (S1) as web collect-screen left it: checked, its sweep and overlay receipts.
const SCREEN_S1 = { screenId: 'S1', route: '/orders', status: 'checked', result: { schema: 'qa-gui/screen-check/v1', screenId: 'S1', route: '/orders', status: 'checked', verdict: 'PASS', issues: [],
  sweep: { schema: 'qa-gui/width-sweep/v1', bands: [], rows: [] }, overlay: { schema: 'qa-gui/overlay-check/v1', route: '/orders', triggers: [], overlays: [] } } };
async function collect({ stub = stubDetectors(), streamOptions = {}, plannedCase = planned, screens = [SCREEN_S1] } = {}) {
  const { calls, draft } = stream(streamOptions);
  const results = await caseDetectorResults({ draft, calls, shots: stateScreenshots(draft, calls), tools: stub.tools, plannedCase, tracked: { coverage }, exists, fileSha, screens });
  const built = buildCaseEvidence({ draft, calls, binding, plannedCase, boardCase: { id: 'TC-01', kind: 'behavioral', status: 'TODO' }, viewport: '1280x800',
    preflightRaw: { id: 'preflight', verdict: 'PASS', evidence: 'p' }, fileSha, exists, tools: cellTools, coverage, readFile: (p) => readFileSync(p), detectors: { tools: stub.tools, results } });
  return { built, results, stub, receipt: built.receipts[0].value };
}

test('what a case runs: the probe for a behavioral case, the U states its plan forces, exploration for a cell case (screen checks run apart)', () => {
  assert.deepEqual(caseUxRules({ conditions: ['request=hold', 'locale=vi-VN+request=respond:500'] }), ['U1', 'U2', 'U3']);
  assert.deepEqual(caseUxRules({ data: { ux: ['U3', 'U7'] } }), ['U3']);
  assert.deepEqual(caseDetectorPlan({ plannedCase: { kind: 'static' } }), { transient: false, ux: [], explore: null });
  assert.deepEqual(caseDetectorPlan({ plannedCase: planned, tracked: { coverage }, explorationPolicy: { schema: 'p' } }),
    { transient: { trials: 3, kinds: [], reset: false }, ux: ['U1', 'U2'], explore: { policy: { schema: 'p' }, budget: 12 } });
});

test('the case dispatch gets a TEAMQA_DETECTORS section from QA GUI\'s recipes; nothing without them', async () => {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-detector-dispatch-')));
  writeFileSync(join(runDir, 'tracked.json'), JSON.stringify({ cases: [planned] }));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { tracked: { path: 'tracked.json' } } }));
  const text = await dispatchDetectorSection({ runDir, caseId: 'TC-01', tools: stubDetectors().tools });
  assert.match(text, /^TEAMQA_DETECTORS \(QA GUI qa-gui\/stream-detectors\/v1; references\/executor-evidence\.md\)\nrecipes for TC-01 /);
  assert.match(text, /"ux":\["U1","U2"\]/);
  assert.match(text, /fast=false/);
  assert.equal(await dispatchDetectorSection({ runDir, caseId: 'TC-01', tools: null }), '');
  assert.equal(await dispatchDetectorSection({ runDir, caseId: 'TC-99', tools: stubDetectors().tools }), '');
  assert.equal(await qaGuiDetectorTools(runDir), null, 'a QA GUI without stream detectors gives no tools');
});

test('the draft names what ran on a state; a malformed claim is refused', () => {
  const { draft } = stream();
  assert.deepEqual(draftIssues(draft, { caseIds: ['TC-01'] }), []);
  const bad = (state) => draftIssues({ ...draft, states: [{ ...draft.states[0], ...state }] }, { caseIds: ['TC-01'] });
  assert.deepEqual(bad({ ux: ['U2', 'X'] }), ['EVIDENCE_DRAFT_DETECTOR_INVALID:after-save:ux']);
  assert.deepEqual(bad({ screen: 'yes' }), ['EVIDENCE_DRAFT_DETECTOR_INVALID:after-save:screen']);
  assert.deepEqual(bad({ transient: { repeatable: 'no' } }), ['EVIDENCE_DRAFT_DETECTOR_INVALID:after-save:transient']);
  assert.deepEqual(bad({ detectors: { unavailable: { transient: 'no r1a' } } }), ['EVIDENCE_DRAFT_DETECTOR_INVALID:after-save:detectors']);
  assert.deepEqual(bad({ detectors: { unavailable: { transient: 'DRAGON_R1A_UNAVAILABLE' } } }), []);
});

test('the env block: the conditions Dragon recorded when the state was captured, and the case\'s last env.reset', () => {
  const { calls } = stream();
  const ordered = [...calls.values()].sort((a, b) => a.i - b.i);
  const env = caseEnvironment(ordered, new Set([7]));
  const shot = ordered.find((c) => c.method === 'screenshot');
  assert.equal(env.touched, true);
  assert.deepEqual(env.conditionsAt(shot.i), forced);
  assert.equal(env.conditionsAt(0), null);
  assert.equal(env.reset.method, 'envReset');
  assert.equal(caseEnvironment(ordered, new Set([8])).touched, false, 'another tab');
});

test('collect carries the probes, their cells, the kept frames, the env block and the reset into the run; Team QA grades nothing', async () => {
  const { built, receipt, stub } = await collect();
  // The transient probe saw only the calls before this state's screenshot; the screen check of /orders went to the
  // state on that route.
  assert.deepEqual(stub.seen.transient[0].methods.slice(0, 3), ['env.set', 'sensors.start', 'do']);
  assert.deepEqual([stub.seen.transient[0].action.target.label, stub.seen.transient[0].repeatable], ['Save', false]);
  assert.deepEqual(stub.seen.fold, [{ caseId: 'TC-01', states: [{ state: 'after-save', url: 'http://127.0.0.1:5401/orders' }], screens: [['S1', 'checked']] }]);
  assert.deepEqual(receipt.probes.map((p) => [p.kind, p.path, Boolean(p.cells)]), [
    ['transient', 'evidence/qa-gui/TC-01/after-save.transient.json', false],
    ['width-sweep', 'evidence/qa-gui/TC-01/after-save.width-sweep.json', true],
    ['overlay-check', 'evidence/qa-gui/TC-01/after-save.overlay-check.json', true]]);
  for (const p of receipt.probes) {
    const file = built.files.find((f) => f.rel === p.path);
    assert.equal(sha(file.data), p.sha256);
    assert.equal(built.manifest.find((m) => m.path === p.path).sha256, p.sha256);
    if (p.cells) assert.equal(JSON.parse(built.files.find((f) => f.rel === p.cells.path).data).probe_sha256, p.sha256);
  }
  // The kept frame, copied hash for hash and named by its copy in the probe.
  const frame = built.files.find((f) => f.rel === 'evidence/qa-gui/TC-01/frames/fw-a-1/f-00003.jpg');
  assert.equal(frame.from, join(FRAMES, 'f-00003.jpg'));
  assert.equal(built.manifest.find((m) => m.path === frame.rel).sha256, sha('frame three'));
  assert.equal(JSON.parse(built.files.find((f) => f.rel.endsWith('.transient.json')).data).file, frame.rel);
  // The Dragon conditions of the state, in its env block and its cell; the reset raw result on the last state.
  assert.deepEqual(receipt.env.conditions, forced);
  assert.deepEqual(receipt.cell.conditions, { request: 'hold' });
  assert.equal(receipt.env.reset.evidence_ref, 'evidence/qa-gui/TC-01/env-reset.json');
  assert.deepEqual(JSON.parse(built.files.find((f) => f.rel === receipt.env.reset.evidence_ref).data).result.atDefault, true);
  // U2 folded into ui-sanity; QA GUI's probe verdict joins the UI verdict.
  assert.equal(receipt.ui.uiSanity.verdict, 'FAIL');
  assert.equal(JSON.parse(receipt.ui.uiSanity.evidence).ux.rules.U2.verdict, 'FAIL');
  assert.deepEqual(Object.keys(JSON.parse(receipt.ui.uiSanity.evidence).ux.rules), ['U1', 'U2']);
  assert.deepEqual([receipt.ui.verdict, built.caseEntry.uiVerdict, built.caseEntry.functionVerdict], ['FAIL', 'FAIL', 'PASS']);
  // A clean twin: every detector ran and found nothing.
  const clean = await collect({ stub: stubDetectors({ u2: 'PASS' }) });
  assert.deepEqual([clean.receipt.ui.verdict, clean.built.caseEntry.status], ['PASS', 'PASS']);
  // The exploration the plan asks of a cell case did not run: reported, and it changes no verdict.
  assert.deepEqual(clean.built.issues, ['DETECTOR_NOT_RUN:TC-01:explore']);
});

test('a detector the case needed that did not run or a missing reset keep the case from PASS', async () => {
  const noScreens = await collect({ stub: stubDetectors({ u2: 'PASS' }), screens: [{ screenId: 'S1', route: '/orders', status: 'missing' }] });
  assert.ok(noScreens.built.issues.includes('DETECTOR_NOT_RUN:TC-01:screens:S1'), noScreens.built.issues.join(','));
  assert.equal(noScreens.built.caseEntry.uiVerdict, 'UNGRADED');
  const noReset = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { reset: false } });
  assert.ok(noReset.built.issues.includes('ENV_RESET_MISSING:TC-01'), noReset.built.issues.join(','));
  assert.equal(Object.hasOwn(noReset.receipt.env, 'reset'), false);
  assert.deepEqual([noReset.built.caseEntry.functionVerdict, noReset.built.caseEntry.uiVerdict], ['UNGRADED', 'UNGRADED']);
});

test('a Dragon without R1a: the forced U rules say UNGRADED with the reason, the probe and the screen check are reported, and the case is graded as before', async () => {
  const uxRules = (receipt) => JSON.parse(receipt.ui.uiSanity.evidence).ux?.rules ?? {};
  for (const claim of [true, false]) {
    // Said in the draft, or only shown by the stream (`help` without environmentContract, an R1a tool refused).
    const older = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { r1a: false, claim }, screens: [{ screenId: 'S1', route: '/orders', status: 'unavailable' }] });
    const at = claim ? 'TC-01:after-save' : 'TC-01';
    assert.deepEqual(older.built.issues.filter((code) => code.startsWith('DETECTOR_')),
      // E6 (fix round 2): without R1a the exploration is skipped and reported as unavailable.
      [`DETECTOR_UNAVAILABLE:${at}:transient:DRAGON_R1A_UNAVAILABLE`, `DETECTOR_UNAVAILABLE:${at}:ux:DRAGON_R1A_UNAVAILABLE`, 'DETECTOR_UNAVAILABLE:TC-01:explore:DRAGON_R1A_UNAVAILABLE'], `claim=${claim}`);
    assert.deepEqual(Object.entries(uxRules(older.receipt)).map(([id, r]) => [id, r.verdict, r.reason]),
      [['U1', 'UNGRADED', 'DRAGON_R1A_UNAVAILABLE'], ['U2', 'UNGRADED', 'DRAGON_R1A_UNAVAILABLE']]);
    assert.equal(Object.hasOwn(older.receipt, 'probes'), false, 'the screen check could not run either: reported only');
    assert.ok(older.built.issues.includes('SCREEN_CHECK_UNAVAILABLE:S1:DRAGON_R1A_UNAVAILABLE'), older.built.issues.join(','));
    assert.equal(Object.hasOwn(older.receipt, 'env'), false, 'nothing touched the environment');
    assert.deepEqual([older.receipt.ui.uiSanity.verdict, older.built.caseEntry.uiVerdict, older.built.caseEntry.status], ['PASS', 'PASS', 'PASS']);
  }
  // A claim the stream contradicts, one nothing in the stream backs, or one for a detector that needs no R1a is not
  // honoured: the detectors it would skip count as not run.
  const refusedWhy = (built) => built.issues.filter((code) => code.startsWith('DETECTOR_UNAVAILABLE_REFUSED'));
  const contradicted = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { claim: true } });
  assert.deepEqual(refusedWhy(contradicted.built), ['DETECTOR_UNAVAILABLE_REFUSED:TC-01:after-save:transient:R1A_RECORDED', 'DETECTOR_UNAVAILABLE_REFUSED:TC-01:after-save:ux:R1A_RECORDED']);
  assert.ok(contradicted.built.issues.includes('DETECTOR_NOT_RUN:TC-01:U1'), contradicted.built.issues.join(','));
  assert.equal(contradicted.built.caseEntry.uiVerdict, 'UNGRADED');
  const unbacked = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { r1a: 'silent', claim: true } });
  assert.deepEqual(refusedWhy(unbacked.built), ['DETECTOR_UNAVAILABLE_REFUSED:TC-01:after-save:transient:NOT_SHOWN', 'DETECTOR_UNAVAILABLE_REFUSED:TC-01:after-save:ux:NOT_SHOWN']);
  assert.ok(['transient', 'U1', 'U2'].every((d) => unbacked.built.issues.includes(`DETECTOR_NOT_RUN:TC-01:${d}`)), unbacked.built.issues.join(','));
  assert.equal(unbacked.built.caseEntry.uiVerdict, 'UNGRADED');
  const screens = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { r1a: false, claim: { ...NO_R1A, screens: 'DRAGON_R1A_UNAVAILABLE' } }, screens: [{ screenId: 'S1', route: '/orders', status: 'missing' }] });
  assert.deepEqual(refusedWhy(screens.built), ['DETECTOR_UNAVAILABLE_REFUSED:TC-01:after-save:screens:NEEDS_NO_R1A']);
  assert.ok(screens.built.issues.includes('DETECTOR_NOT_RUN:TC-01:screens:S1'));
  assert.equal(screens.built.caseEntry.uiVerdict, 'UNGRADED');
});

test('TQ-3: U results that pass never lift an UNGRADED Gate-0 report (one with an issue list and no verdict) to PASS', async () => {
  const ungraded = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { g0ui: { v: 'UNGRADED', issues: [] } } });
  assert.equal(JSON.parse(ungraded.receipt.ui.uiSanity.evidence).ux.rules.U2.verdict, 'PASS');
  assert.equal(ungraded.receipt.ui.uiSanity.verdict, 'UNGRADED');
  assert.notEqual(ungraded.built.caseEntry.uiVerdict, 'PASS');
  const graded = await collect({ stub: stubDetectors({ u2: 'PASS' }) });
  assert.equal(graded.receipt.ui.uiSanity.verdict, 'PASS', 'a PASS report with passing U results stays PASS');
});

test('TQ-4: a request the environment forced, and its console line, do not FAIL the state; any other failure still does', async () => {
  const forcedRun = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { forcedError: true } });
  assert.deepEqual(forcedRun.results.forcedRequests, [{ ruleId: 'save-error', method: 'POST', url: API, status: 500, failed: false, t: 19 }]);
  assert.deepEqual([forcedRun.receipt.ui.network.verdict, forcedRun.receipt.ui.console.verdict], ['PASS', 'PASS']);
  assert.deepEqual(forcedRun.receipt.network.map((x) => [x.status, x.forced === true]), [[500, true]]);
  assert.equal(forcedRun.receipt.network_summary.failed_requests, 0);
  const other = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { forcedError: true, unforced500: true } });
  assert.equal(other.receipt.ui.network.verdict, 'FAIL', 'a request no rule forced still fails the state');
  const plain = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { unforced500: true } });
  assert.equal(plain.receipt.ui.network.verdict, 'FAIL');
});

test('E7 (TQ2-2): only what the rule really answered is excused, by method, path and status: an unforced 503 on the same path and a held write\'s real 500 still fail', async () => {
  const next = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { forcedError: true, unforced503: true } });
  assert.deepEqual(next.receipt.network.map((x) => [x.method, x.status, x.forced === true]), [['POST', 500, true], ['GET', 503, false]]);
  assert.equal(next.receipt.ui.network.verdict, 'FAIL', 'the 503 no rule forced still fails the state');
  assert.equal(next.receipt.network_summary.failed_requests, 1);
  const held = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { heldWrite500: true } });
  assert.deepEqual(held.results.forcedRequests, [], 'held and released writes are real calls');
  assert.equal(held.receipt.ui.network.verdict, 'FAIL');
});

test('F7 (R3-7): a forced request is excused by the rule in force when it was made, even after a later envSet replaced the rules; an unforced 503 still fails', async () => {
  const later = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { forcedError: true, ruleReplaced: true, unforced503: true } });
  assert.deepEqual(later.receipt.env.conditions.requests.map((x) => x.id), ['write'], 'the respond rule is no longer in force at the screenshot');
  assert.deepEqual(later.receipt.network.map((x) => [x.method, x.status, x.forced === true]), [['POST', 500, true], ['GET', 503, false]]);
  assert.equal(later.receipt.network_summary.failed_requests, 1);
  const clean = await collect({ stub: stubDetectors({ u2: 'PASS' }), streamOptions: { forcedError: true, ruleReplaced: true } });
  assert.equal(clean.receipt.ui.network.verdict, 'PASS', 'the earlier forced 500 does not fail the later state');
  assert.equal(clean.receipt.ui.console.verdict, 'PASS');
});

test('minor: an R1a call that fails as "tab not found" does not show R1a missing', () => {
  const call = (i, method, text, error = true) => ({ i, method, params: { tabId: 7 }, text, json: null, error });
  assert.deepEqual(dragonR1a([call(1, 'sensorsStart', 'Error: tab not found: 7')]), { available: false, missing: false, unavailable: false });
  assert.equal(dragonR1a([call(1, 'sensorsStart', 'Error: No such tool available: mcp__Dragon_Browser__sensorsStart')]).unavailable, true);
});

test('without QA GUI stream detectors, or on a case that touched nothing, the receipt is the one of before', async () => {
  const { calls, draft } = stream();
  const plain = buildCaseEvidence({ draft, calls, binding, plannedCase: planned, boardCase: { id: 'TC-01', kind: 'behavioral', status: 'TODO' }, viewport: '1280x800',
    preflightRaw: { id: 'preflight', verdict: 'PASS', evidence: 'p' }, fileSha, exists, tools: cellTools, coverage, readFile: (p) => readFileSync(p) });
  const r = plain.receipts[0].value;
  assert.deepEqual([Object.hasOwn(r, 'probes'), Object.hasOwn(r, 'env'), r.cell.conditions, r.ui.verdict], [false, false, {}, 'PASS']);
  assert.equal(await caseDetectorResults({ draft, calls, shots: stateScreenshots(draft, calls), tools: null }), null);
});
