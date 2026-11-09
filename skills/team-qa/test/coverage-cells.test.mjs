// Upgrade R1b: the Coverage Gate counts cells that have a state receipt. A cell is route x state x action x viewport
// row x environment condition; the denominator is the union of the source registry (cases of tracked plan v2), the
// app map's nodes and untaken branches, the static routes and the state family of a screen with data.
// Fixtures: test/fixtures/coverage-cells/tracked-plan.json (a synthetic Orders app with a list, a form and a modal)
// and app-map.v2.json, a byte-identical copy of QA GUI's contract fixture test/fixtures/r1b-coverage/orders-app-map.v2.json
// (built by `qa-gui.mjs app-map` from its exploration log). Not evidence of a product run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  COVERAGE_CELLS_VERSION, NOT_EXPLORED_CODES, buildCoverageMap, coverageReportErrors,
} from '../scripts/lib/coverage-cells.mjs';
import { planErrors, trackedErrors } from '../scripts/lib/validators.mjs';
import { redCheckerLedger, reportIntegrityErrors } from '../scripts/lib/report-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamqa.mjs');
const TRACKED = JSON.parse(readFileSync(new URL('./fixtures/coverage-cells/tracked-plan.json', import.meta.url), 'utf8'));
const APP_MAP_TEXT = readFileSync(new URL('./fixtures/coverage-cells/app-map.v2.json', import.meta.url), 'utf8');
const APP_MAP = JSON.parse(APP_MAP_TEXT);
const H = (digit) => String(digit).repeat(64);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => structuredClone(value);
const NA_REASON = 'The list reads a local cache that has no server error path; signed out of scope.';
const PLAN_COVERAGE = { version: COVERAGE_CELLS_VERSION, na: [{ route: '/orders', state: 'error', reason: NA_REASON }] };

function stateReceipt({ caseId, state, domHash, cell, ui = 'PASS', viewport = '1280x800' }) {
  return {
    schema: 'qa-gui/state-receipt/v1', caseId, state, capturedAt: '2026-11-04T02:00:00.000Z', url: 'https://test.example/orders',
    build: 'build-r1b', viewport, domHash, function: { verdict: 'PASS', assertions: [] }, ui: { verdict: ui }, ...(cell ? { cell } : {}),
  };
}
const cellOf = (route, action, extra = {}) => ({ version: 'qa-gui/coverage-cell/v1', route, action, viewport: 'desktop-1280', conditions: {}, ...extra });

// Writes the evidence of the four cases into `dir` and returns the latest board records.
// TC-01: a state receipt with its cell. TC-02: declares states ["empty"] and has NO state receipt.
// TC-03: a QA GUI gate receipt whose evidence manifest names the state receipt (no `cell`: the case route and the
// plan's row size place it). TC-04: a receipt with its cell whose UI verdict is FAIL.
function writeEvidence(dir, { emptyReceipt = false, tamper = false, probe = null } = {}) {
  const put = (rel, value) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(dir, rel), text);
    return { rel, text };
  };
  const tc1 = put('evidence/qa-gui/TC-01/many-rows.receipt.json', stateReceipt({ caseId: 'TC-01', state: 'many-rows', domHash: H(1), cell: cellOf('/orders', 'view', { rows: 3 }) }));
  const tc2 = emptyReceipt
    ? put('evidence/qa-gui/TC-02/empty.receipt.json', stateReceipt({ caseId: 'TC-02', state: 'empty', domHash: H(6), cell: cellOf('/orders', 'view', { rows: 0 }) }))
    : put('evidence/qa-gui/TC-02/notes.txt', 'The executor wrote that the empty list looked fine.\n');
  const tc3 = put('evidence/qa-gui/TC-03/ideal.receipt.json', stateReceipt({ caseId: 'TC-03', state: 'ideal', domHash: H(2) }));
  const gate = put('evidence/qa-gui/gate.receipt.json', {
    schema: 'qa-gui/receipt/v2', semantic_verdict: 'PASS',
    evidence_manifest: [{ path: tc3.rel, sha256: sha(tc3.text), evidence_type: 'machine-receipt', metadata: { case_id: 'TC-03', state: 'ideal' } }],
  });
  if (tamper) put(tc3.rel, tc3.text.replace('"PASS"', '"FAIL"'));
  // R1e: an overlay check on TC-04's state, with QA GUI's sealed per-cell result (qa-gui/probe-cells/v1).
  let probes = null;
  if (probe) {
    const overlayProbe = put('evidence/qa-gui/TC-04/ideal.overlays.json', { schema: 'qa-gui/overlay-check/v1', route: '/orders', triggers: [], overlays: [] });
    const at = { route: 'dialog:delete-order', state: 'ideal', viewport: 'desktop-1280', condition: 'default' };
    const cells = put('evidence/qa-gui/TC-04/ideal.cells.json', { schema: 'qa-gui/probe-cells/v1', case: 'TC-04', state: 'ideal', kind: 'overlay-check',
      probe_sha256: sha(overlayProbe.text), cells: [{ ...at, action: 'open:mouse', status: 'PASS' }, { ...at, action: 'close:esc', status: 'FAIL' },
        { ...at, action: 'close:backdrop', status: 'UNGRADED', reason: 'PRECONDITION_ABSENT' }], integrity: H(8) });
    probes = [{ kind: 'overlay-check', path: overlayProbe.rel, sha256: sha(overlayProbe.text), cells: { path: cells.rel, sha256: sha(cells.text) } }];
    if (probe === 'tampered') put(cells.rel, cells.text.replace('"FAIL"', '"PASS"'));
    if (probe === 'missing') probes[0].cells.path = 'evidence/qa-gui/TC-04/none.cells.json';
  }
  const tc4 = put('evidence/qa-gui/TC-04/ideal.receipt.json', { ...stateReceipt({ caseId: 'TC-04', state: 'ideal', domHash: H(3), ui: 'FAIL', cell: cellOf('dialog:delete-order', 'click:Cancel') }), ...(probes ? { probes } : {}) });
  const record = (caseId, verdict, evidence) => ({
    case_id: caseId, lane: 'lane-gui', verdict, evidence, source: 'qa-gui', run_id: 'coverage-cells', ts: '2026-11-04T03:00:00.000Z',
    function_verdict: 'pass', ui_visual_verdict: verdict,
  });
  return [record('TC-01', 'pass', [tc1.rel]), record('TC-02', 'pass', [tc2.rel]), record('TC-03', 'pass', [gate.rel]), record('TC-04', 'fail', [tc4.rel])];
}

function build(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-coverage-cells-'));
  const records = writeEvidence(dir, options);
  return buildCoverageMap({ tracked: options.tracked ?? TRACKED, planCoverage: PLAN_COVERAGE, appMap: options.appMap === undefined ? APP_MAP : options.appMap,
    appMapSha256: sha(APP_MAP_TEXT), records, boardDir: dir });
}

test('tracked plan v2 takes a versioned coverage block and per-case route, actions and conditions; old shapes still validate', () => {
  assert.deepEqual(trackedErrors(clone(TRACKED), { lock: null }), []);
  // The old v2 shape (no coverage block) is unchanged.
  const plain = clone(TRACKED);
  delete plain.coverage;
  for (const item of plain.cases) { delete item.route; delete item.actions; item.states = ['ideal']; }
  assert.deepEqual(trackedErrors(plain, { lock: null }), []);
  const bad = (mutate, code) => {
    const value = clone(TRACKED); mutate(value);
    const errors = trackedErrors(value, { lock: null });
    assert.ok(errors.some((error) => error.startsWith(code)), `${code}: ${errors.join(', ')}`);
  };
  bad((v) => { v.coverage.version = 'team-qa/coverage-cells/v0'; }, 'CASE_COVERAGE_VERSION');
  bad((v) => { v.coverage.extra = true; }, 'CASE_COVERAGE_UNKNOWN_FIELD');
  bad((v) => { v.coverage.rows = []; }, 'CASE_COVERAGE_TYPE rows');
  bad((v) => { v.coverage.rows[0].size = 'wide'; }, 'CASE_COVERAGE_TYPE rows[0].size');
  bad((v) => { v.cases[0].viewports = ['mobile']; }, 'CASE_COVERAGE_ROW TC-01 mobile');
  bad((v) => { v.cases[0].conditions = ['network=slow 3g']; }, 'CASE_TYPE TC-01 conditions');
  bad((v) => { v.cases[0].conditions = ['network=offline+cpu=4x']; }, 'CASE_TYPE TC-01 conditions');
  bad((v) => { v.cases[0].actions = []; }, 'CASE_TYPE TC-01 actions');
  bad((v) => { delete v.cases[3].route; }, 'CASE_FIELD TC-04 route');
  // The cell fields and the row-family states exist only under the coverage block.
  bad((v) => { delete v.coverage; }, 'CASE_UNKNOWN_FIELD TC-01 route');
  bad((v) => { delete v.coverage; for (const item of v.cases) delete item.route; delete v.cases[3].actions; }, 'CASE_TYPE TC-01 states');
  // A tracked plan v1 has no coverage block.
  const legacy = { cases: plain.cases.map(({ title, sourceRefs, ...item }) => item), coverage: clone(TRACKED.coverage) };
  assert.ok(trackedErrors(legacy, { lock: null }).includes('CASE_UNKNOWN_FIELD coverage'));
});

test('the signed plan carries the N/A cells, each with a reason', () => {
  const plan = {
    run_id: 'coverage-cells', app: 'orders', plan_version: 1, lanes: [{ id: 'lane-gui', scope: ['REQ-LIST'], parallel_ok: false, vi_sao: '' }],
    tiers: { 'REQ-LIST': 'FULL' }, exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 },
  };
  assert.deepEqual(planErrors(plan), []);
  assert.deepEqual(planErrors({ ...plan, coverage: clone(PLAN_COVERAGE) }), []);
  for (const [coverage, code] of [
    [{ ...PLAN_COVERAGE, version: 'v0' }, 'PLAN_TYPE coverage.version'],
    [{ ...PLAN_COVERAGE, extra: 1 }, 'PLAN_UNKNOWN_FIELD coverage.extra'],
    [{ version: COVERAGE_CELLS_VERSION, na: [{ route: '/orders', state: 'error' }] }, 'PLAN_TYPE coverage.na[0].reason'],
    [{ version: COVERAGE_CELLS_VERSION, na: [{ route: '/orders', reason: 'x', size: 'big' }] }, 'PLAN_UNKNOWN_FIELD coverage.na[0].size'],
    [{ version: COVERAGE_CELLS_VERSION, na: [{ state: 'error', reason: NA_REASON }] }, 'PLAN_TYPE coverage.na[0].route'],
  ]) assert.ok(planErrors({ ...plan, coverage }).includes(code), `${code}: ${planErrors({ ...plan, coverage }).join(', ')}`);
});

test('acceptance 1: the map of the list, form and modal app lists every cell; blocked cells carry their code; U matches the hand count', () => {
  const { map, summary } = build();
  assert.deepEqual(map.cells.map((cell) => [cell.key, cell.status, cell.reason]), [
    ['/orders|many-rows|view|desktop-1280|*', 'PASS', null],
    ['/orders|empty|view|desktop-1280|*', 'UNGRADED', 'NO_RECEIPT'],
    ['/orders/new|ideal|view|desktop-1280|*', 'PASS', null],
    ['dialog:delete-order|ideal|click:Cancel|desktop-1280|*', 'FAIL', null],
    ['/admin|ideal|view|desktop-1280|*', 'NOT_EXPLORED', 'AUTH'],
    ['/orders|loading|view|desktop-1280|*', 'UNGRADED', 'NO_RECEIPT'],
    ['/orders|error|view|desktop-1280|*', 'N/A', NA_REASON],
    ['/orders|one-row|view|desktop-1280|*', 'NOT_EXPLORED', 'BUDGET'],
    ['dialog:delete-order|ideal|view|desktop-1280|default', 'UNGRADED', 'NO_RECEIPT'],
    ['/orders|many-rows|click:Export|desktop-1280|default', 'NOT_EXPLORED', 'HOVER_ONLY'],
    ['/orders|many-rows|click:Admin|desktop-1280|default', 'NOT_EXPLORED', 'AUTH'],
    ['/orders/new|ideal|click:Save|desktop-1280|default', 'NOT_EXPLORED', 'BUDGET'],
    ['dialog:delete-order|ideal|click:Confirm|desktop-1280|default', 'NOT_EXPLORED', 'NEEDS_APPROVAL'],
  ]);
  // Where each cell came from: the union of the four sources.
  const origins = (key) => map.cells.find((cell) => cell.key === key).origins;
  assert.deepEqual(origins('/orders|many-rows|view|desktop-1280|*'), ['source:SRC-ORDERS-LIST', 'state-family', 'static-route', 'app-map:node', 'receipt']);
  assert.deepEqual(origins('/orders|empty|view|desktop-1280|*'), ['source:SRC-ORDERS-EMPTY', 'state-family', 'static-route', 'app-map:frontier']);
  assert.deepEqual(origins('/admin|ideal|view|desktop-1280|*'), ['static-route']);
  // The empty list was skipped by the explorer for lack of data; the case that claims it still has no receipt.
  assert.deepEqual(map.cells[1].frontier, [{ id: 'f:/orders>state=empty', reason: 'NO_DATA' }]);
  // Every NOT_EXPLORED cell carries one of the eight codes.
  assert.ok(map.cells.filter((cell) => cell.status === 'NOT_EXPLORED').every((cell) => NOT_EXPLORED_CODES.includes(cell.reason)));

  assert.deepEqual(summary.coarse, { rule: 'route|state', cells: 13, covered: 3, PASS: 2, FAIL: 1, UNGRADED: 3, NOT_EXPLORED: 6, NA: 1 });
  // Strict: the many-rows list was seen with two DOMs (H1, H4) and only H1 has a receipt.
  assert.deepEqual(summary.strict, { rule: 'dom-hash', cells: 14, covered: 3, PASS: 2, FAIL: 1, UNGRADED: 4, NOT_EXPLORED: 6, NA: 1 });
  assert.deepEqual(summary.not_explored, { BUDGET: 2, AUTH: 2, NEEDS_APPROVAL: 1, NO_DATA: 0, UNREACHABLE: 0, HOVER_ONLY: 1, OBSCURED: 0, TOOL_LIMIT: 0 });
  assert.deepEqual(summary.frontier, { candidates: 5, by_reason: { BUDGET: 1, AUTH: 1, NEEDS_APPROVAL: 1, NO_DATA: 1, UNREACHABLE: 0, HOVER_ONLY: 1, OBSCURED: 0, TOOL_LIMIT: 0 } });
  assert.deepEqual(summary.stop, { reason: 'BUDGET_EXHAUSTED', code: null, detail: 'the step budget of 8 actions is used' });

  // U by hand from the exploration's seven settled state observations (QA GUI app map `states`):
  // strict keys H0, H1, H2, H1, H3, H1, H4 -> singletons H0, H2, H3, H4 -> f1 = 4, n = 7;
  // coarse keys /orders|loading, /orders|many-rows x4, /orders/new|ideal, dialog:delete-order|ideal -> f1 = 3, n = 7.
  const strictKeys = APP_MAP.states.map((s) => s.strict);
  const singletons = (keys) => [...new Set(keys)].filter((key) => keys.filter((other) => other === key).length === 1).length;
  assert.equal(singletons(strictKeys), 4);
  assert.equal(singletons(APP_MAP.states.map((s) => `${s.route}|${s.state}`)), 3);
  assert.deepEqual(summary.saturation, { strict: { n: 7, f1: 4, distinct: 5, u: 4 / 7 }, coarse: { n: 7, f1: 3, distinct: 4, u: 3 / 7 } });
  // Never one merged percentage.
  assert.doesNotMatch(JSON.stringify(summary), /pct|percent/i);
  assert.deepEqual(coverageReportErrors({ ...summary, map: 'coverage-map.json', map_sha256: H(9) }), []);
});

test('acceptance 2: a case that declares states ["empty"] without a state receipt in the empty state is not counted', () => {
  const { map, summary, issues, ungradedCases } = build();
  assert.deepEqual(summary.case_cells, { cases: 4, declared: 4, with_own_receipt: 3, ungraded_cases: ['TC-02'] });
  assert.deepEqual(ungradedCases, ['TC-02']);
  assert.deepEqual(issues.map((issue) => [issue.checker, issue.code, issue.case_id]), [['coverage-cells', 'COVERAGE_CELL_UNGRADED', 'TC-02']]);
  assert.equal(map.cells.find((cell) => cell.key === '/orders|empty|view|desktop-1280|*').status, 'UNGRADED');
  // With a receipt measured in the empty state, the cell and the case count.
  const fixed = build({ emptyReceipt: true });
  assert.equal(fixed.map.cells.find((cell) => cell.key === '/orders|empty|view|desktop-1280|*').status, 'PASS');
  assert.deepEqual(fixed.ungradedCases, []);
  assert.equal(fixed.summary.coarse.covered, 4);
});

test('a gate receipt whose manifest hash no longer matches the state receipt backs no cell', () => {
  const { map, ungradedCases } = build({ tamper: true });
  const form = map.cells.find((cell) => cell.key === '/orders/new|ideal|view|desktop-1280|*');
  assert.deepEqual([form.status, form.reason], ['UNGRADED', 'NO_RECEIPT']);
  assert.ok(ungradedCases.includes('TC-03'));
});

test('R1e: the overlay cells of QA GUI\'s sealed probe result are counted, hash for hash; an edited or missing file backs nothing', () => {
  const key = (action) => `dialog:delete-order|ideal|${action}|desktop-1280|default`;
  let { map } = build({ probe: 'good' });
  const of = (built, action) => built.cells.find((cell) => cell.key === key(action));
  assert.deepEqual(['open:mouse', 'close:esc', 'close:backdrop'].map((action) => [of(map, action).status, of(map, action).reason, of(map, action).origins]), [
    ['PASS', null, ['probe']], ['FAIL', null, ['probe']], ['UNGRADED', 'PRECONDITION_ABSENT', ['probe']]]);
  // The thirteen cells of acceptance 1 are unchanged.
  assert.equal(map.cells.length, 16);
  // An edited file: its cells are listed, UNGRADED with no receipt.
  ({ map } = build({ probe: 'tampered' }));
  assert.deepEqual(['open:mouse', 'close:esc'].map((action) => [of(map, action).status, of(map, action).reason]), [['UNGRADED', 'NO_RECEIPT'], ['UNGRADED', 'NO_RECEIPT']]);
  assert.ok(map.receipt_problems.includes('TC-04 PROBE_CELLS_HASH_MISMATCH evidence/qa-gui/TC-04/ideal.cells.json'), map.receipt_problems.join(', '));
  // A missing file: nothing to count, and the gap is recorded.
  ({ map } = build({ probe: 'missing' }));
  assert.equal(map.cells.length, 13);
  assert.ok(map.receipt_problems.includes('TC-04 PROBE_CELLS_MISSING evidence/qa-gui/TC-04/none.cells.json'), map.receipt_problems.join(', '));
  // A case that declares an overlay action is backed by its own probe cell.
  const tracked = clone(TRACKED);
  tracked.cases[3].actions = ['click:Cancel', 'close:esc'];
  const declared = build({ probe: 'good', tracked });
  assert.deepEqual(declared.summary.case_cells, { cases: 4, declared: 5, with_own_receipt: 4, ungraded_cases: ['TC-02'] });
  assert.equal(declared.map.cells.find((cell) => cell.key === 'dialog:delete-order|ideal|close:esc|desktop-1280|*').status, 'FAIL');
  const unbacked = build({ probe: 'tampered', tracked });
  assert.deepEqual(unbacked.ungradedCases, ['TC-02', 'TC-04']);
});

test('without an app map the stop reason says so, U has no sample, and the plan cells still count', () => {
  const { map, summary } = build({ appMap: null });
  assert.deepEqual(summary.stop, { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: 'APP_MAP_ABSENT' });
  assert.deepEqual(summary.saturation.strict, { n: 0, f1: 0, distinct: 0, u: null });
  assert.equal(summary.frontier.candidates, 0);
  assert.deepEqual(summary.app_map, { present: false });
  assert.equal(map.cells.find((cell) => cell.key === '/admin|ideal|view|desktop-1280|*').reason, 'TOOL_LIMIT');
});

test('red checker ledger declares coverage-cells only for a report that carries coverage_cells', () => {
  const plain = redCheckerLedger([], {});
  assert.ok(!plain.some((entry) => entry.id === 'coverage-cells'));
  const versioned = redCheckerLedger([], { 'coverage-cells': 4 }, { coverageCells: true });
  assert.deepEqual(versioned.find((entry) => entry.id === 'coverage-cells'), { id: 'coverage-cells', contract: 'RED-TQ-COVERAGE-CELLS-001', scope: 'tracked_case', checked: 4, issues: 0 });
  const base = { reasons: [], grounded_issues: [], child_gates: [{ gate: 'qa-gui', records: 0, graded: 0, ungraded: 0, bound: 0 }, { gate: 'qa-code', records: 0, graded: 0, ungraded: 0, bound: 0 }] };
  assert.deepEqual(reportIntegrityErrors({ ...base, red_checkers: plain }), []);
  assert.ok(reportIntegrityErrors({ ...base, red_checkers: versioned }).includes('REPORT_CHECKER_UNKNOWN coverage-cells'));
  assert.deepEqual(reportIntegrityErrors({ ...base, red_checkers: versioned, coverage_cells: {} }), []);
  assert.ok(reportIntegrityErrors({ ...base, red_checkers: plain, coverage_cells: {} }).includes('REPORT_CHECKER_UNDECLARED coverage-cells'));
});

// ---- CLI: report build / verify on an ungoverned run, as the source-traceability test drives it ----
function run(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
}
function planText(runId, coverage) {
  const plan = {
    run_id: runId, app: 'orders-fixture', plan_version: 1,
    lanes: [{ id: 'lane-gui', scope: ['REQ-LIST', 'REQ-EMPTY', 'REQ-FORM', 'REQ-DELETE'], parallel_ok: false, vi_sao: '' }],
    tiers: { 'REQ-LIST': 'FULL', 'REQ-EMPTY': 'FULL', 'REQ-FORM': 'FULL', 'REQ-DELETE': 'SMOKE' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 100 },
    ...(coverage ? { coverage } : {}),
  };
  return `# Coverage cells plan\n\nTEAMQA_PLAN_START\n${JSON.stringify(plan, null, 2)}\nTEAMQA_PLAN_END\n`;
}
function parsed(path) {
  const text = readFileSync(path, 'utf8');
  return { text, value: JSON.parse(text.match(/TEAMQA_REPORT_START\s*([\s\S]*?)\s*TEAMQA_REPORT_END/)[1]) };
}
function cliRun({ cells = true, emptyReceipt = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-coverage-cli-'));
  const runId = 'coverage-cells';
  const runDir = join(cwd, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const tracked = clone(TRACKED);
  if (!cells) {
    delete tracked.coverage;
    for (const item of tracked.cases) { delete item.route; delete item.actions; item.states = ['ideal']; }
  }
  const paths = { plan: join(runDir, 'test-plan.md'), tracked: join(runDir, 'tracked-plan.json'), board: join(runDir, 'board.jsonl'), rtm: join(runDir, 'rtm.md'), report: join(runDir, 'summary-report.md') };
  writeFileSync(paths.plan, planText(runId, cells ? PLAN_COVERAGE : null));
  writeFileSync(paths.tracked, `${JSON.stringify(tracked, null, 2)}\n`);
  if (cells) writeFileSync(join(runDir, 'app-map.json'), APP_MAP_TEXT);
  let r = run(cwd, ['gate', 'approve', '--run', runId, '--plan', paths.plan, '--signed-by', 'owner', '--ts', '2026-11-04T01:00:00.000Z']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(run(cwd, ['rtm', 'build', '--plan', paths.plan, '--tracked', paths.tracked, '--out', paths.rtm]).status, 0);
  r = run(cwd, ['board', 'seed', '--run', runId, '--tracked', paths.tracked, '--file', paths.board]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const seeded = readFileSync(paths.board, 'utf8').trim().split('\n').map(JSON.parse);
  const results = new Map(writeEvidence(runDir, { emptyReceipt }).map((record) => [record.case_id, record]));
  const records = seeded.map((record) => ({ ...record, ...results.get(record.case_id), sourceRefs: record.sourceRefs, traceabilityVersion: record.traceabilityVersion }));
  writeFileSync(paths.board, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  r = run(cwd, ['board', 'verify', '--file', paths.board, '--tracked', paths.tracked]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = run(cwd, ['rtm', 'fill', '--rtm', paths.rtm, '--board', paths.board, '--out', paths.rtm]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return { cwd, runId, runDir, paths, built: run(cwd, ['report', 'build', '--run', runId]) };
}

test('report build: the Coverage Gate counts cells with a receipt, writes the map, and report verify rebuilds it', () => {
  const { cwd, runId, runDir, paths, built } = cliRun();
  assert.equal(built.status, 1, built.stderr || built.stdout);
  const line = built.stdout + built.stderr;
  assert.match(line, /COVERAGE_CELL_UNGRADED TC-02 1\/1 declared cell\(s\) without a state receipt/);
  // TC-02 does not cover REQ-EMPTY, so FULL coverage is 2 of 3 requirements.
  assert.match(line, /coverage_high_pct 67 < 100/);
  assert.match(line, /cells_covered=3 cells=13 frontier=5 stop=BUDGET_EXHAUSTED/);
  const report = parsed(paths.report);
  assert.equal(report.value.decision, 'NO_GO');
  assert.deepEqual(report.value.reasons, ['COVERAGE_CELL_UNGRADED TC-02 1/1 declared cell(s) without a state receipt', 'coverage_high_pct 67 < 100']);
  const summary = report.value.coverage_cells;
  assert.equal(summary.version, COVERAGE_CELLS_VERSION);
  assert.equal(summary.map, 'coverage-map.json');
  const mapText = readFileSync(join(runDir, 'coverage-map.json'), 'utf8');
  assert.equal(summary.map_sha256, sha(mapText));
  assert.equal(JSON.parse(mapText).cells.length, 13);
  assert.deepEqual(summary.app_map, { present: true, schema: 'qa-gui/app-map/v2', sha256: sha(APP_MAP_TEXT), skipped: 0 });
  assert.deepEqual(report.value.red_checkers.find((entry) => entry.id === 'coverage-cells'), { id: 'coverage-cells', contract: 'RED-TQ-COVERAGE-CELLS-001', scope: 'tracked_case', checked: 4, issues: 1 });
  assert.match(report.text, /## Coverage cells/);
  assert.match(report.text, /\| Strict \(DOM hash\) \| 14 \| 3 \| 5 \| 7 \| 4 \| 0\.5714 \|/);
  assert.match(report.text, /\| Coarse \(route · state rule\) \| 13 \| 3 \| 4 \| 7 \| 3 \| 0\.4286 \|/);
  assert.match(report.text, /Stop reason: BUDGET_EXHAUSTED/);

  let verified = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  // A hand-edited count, or an edited map, is caught.
  writeFileSync(paths.report, report.text.replace('"covered": 3,', '"covered": 4,'));
  verified = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(verified.status, 2, verified.stdout);
  assert.match(verified.stderr, /REPORT_MISMATCH coverage_cells/);
  writeFileSync(paths.report, report.text);
  writeFileSync(join(runDir, 'coverage-map.json'), mapText.replace('"NOT_EXPLORED"', '"PASS"'));
  verified = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(verified.status, 2, verified.stdout);
  assert.match(verified.stderr, /COVERAGE_MAP_MISMATCH/);
});

test('report build: with the empty-state receipt the run is GO; a plan in the old shape keeps the old report', () => {
  const fixed = cliRun({ emptyReceipt: true });
  assert.equal(fixed.built.status, 0, fixed.built.stderr || fixed.built.stdout);
  assert.equal(parsed(fixed.paths.report).value.decision, 'GO');
  assert.equal(parsed(fixed.paths.report).value.coverage_cells.coarse.covered, 4);

  const old = cliRun({ cells: false });
  assert.equal(old.built.status, 0, old.built.stderr || old.built.stdout);
  const report = parsed(old.paths.report).value;
  assert.equal(report.decision, 'GO');
  assert.equal(Object.hasOwn(report, 'coverage_cells'), false);
  assert.ok(!report.red_checkers.some((entry) => entry.id === 'coverage-cells'));
  assert.doesNotMatch(parsed(old.paths.report).text, /## Coverage cells/);
  const verified = run(old.cwd, ['report', 'verify', '--run', old.runId]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
});

// With a QA GUI checkout (TEAMQA_WEB_TEST_QA_GUI_ROOT): the cells file QA GUI's own grader seals is what Team QA counts.
const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
test('R1e: QA GUI\'s sealed probe cells are counted as QA GUI graded them', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout' }, async () => {
  const { probeCells } = await import(pathToFileURL(join(QA_GUI, 'scripts/lib/probes.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-probe-cells-real-'));
  const records = writeEvidence(dir);
  const observation = { trigger: { selector: '#delete-trigger', label: 'Delete order' }, overlay: '#delete-order',
    mouse: { opened: true, overlay: '#delete-order', activeInside: true }, trap: { presses: 1, inside: [true] }, scroll: { scrollable: false },
    stacked: { available: false }, esc: { closed: false, active: '#x' }, keyboard: { reachedTrigger: true, presses: 2, opened: true },
    backdrop: { available: false }, button: { available: true, closed: true, active: 'body' } };
  const probeText = JSON.stringify({ schema: 'qa-gui/overlay-check/v1', route: '/orders', triggers: [], overlays: [{ id: 'dialog:delete-order', observation }] });
  writeFileSync(join(dir, 'evidence/qa-gui/TC-04/ideal.overlays.json'), probeText);
  const receiptPath = join(dir, 'evidence/qa-gui/TC-04/ideal.receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const sealed = probeCells({ receipt, caseId: 'TC-04', state: 'ideal', kind: 'overlay-check', probe: JSON.parse(probeText), probeSha256: sha(probeText) });
  const cellsText = `${JSON.stringify(sealed, null, 2)}\n`;
  writeFileSync(join(dir, 'evidence/qa-gui/TC-04/ideal.cells.json'), cellsText);
  receipt.probes = [{ kind: 'overlay-check', path: 'evidence/qa-gui/TC-04/ideal.overlays.json', sha256: sha(probeText), cells: { path: 'evidence/qa-gui/TC-04/ideal.cells.json', sha256: sha(cellsText) } }];
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const { map } = buildCoverageMap({ tracked: TRACKED, planCoverage: PLAN_COVERAGE, appMap: APP_MAP, appMapSha256: sha(APP_MAP_TEXT), records, boardDir: dir });
  const status = (action) => map.cells.find((cell) => cell.key === `dialog:delete-order|ideal|${action}|desktop-1280|default`)?.status;
  assert.deepEqual(['open:mouse', 'open:keyboard', 'close:esc', 'close:button'].map(status), ['PASS', 'PASS', 'FAIL', 'PASS']);
});
