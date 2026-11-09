// Upgrade R1b: the app map records the branches it did not take and why it stopped (app map v2), and a state receipt
// may name the coverage cell it backs, which the gate checks. Fixture: test/fixtures/r1b-coverage/orders-crawl.json,
// the exploration log of a synthetic Orders app with a list, a form and a modal. Not evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAppMap } from '../scripts/loop6/app-map.mjs';
import * as loop6 from '../scripts/loop6/index.mjs';
import {
  APP_MAP_V2_SCHEMA, COVERAGE_CELL_VERSION, DATA_STATE_FAMILY, NOT_EXPLORED_CODES, STOP_REASONS,
  coarseStateOf, conditionKey, stateCell, stateCellIssues,
} from '../scripts/lib/coverage-cell.mjs';
import { checkGuiReleaseTruthV2 } from '../scripts/lib/qa-gui-v2.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const CLI = join(ROOT, 'scripts/qa-gui.mjs');
const FIXTURE = join(ROOT, 'test/fixtures/r1b-coverage/orders-crawl.json');
const EXPECTED_MAP = join(ROOT, 'test/fixtures/r1b-coverage/orders-app-map.v2.json');
const LOG = JSON.parse(readFileSync(FIXTURE, 'utf8')).observations;
const H = (digit) => String(digit).repeat(64);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codes = (issues) => issues.map((item) => item.code);

test('the vocabulary: eight NOT_EXPLORED codes, three stop reasons, the five-state family for screens with data', () => {
  assert.deepEqual(NOT_EXPLORED_CODES, ['BUDGET', 'AUTH', 'NEEDS_APPROVAL', 'NO_DATA', 'UNREACHABLE', 'HOVER_ONLY', 'OBSCURED', 'TOOL_LIMIT']);
  assert.deepEqual(STOP_REASONS, ['FRONTIER_EMPTY', 'BUDGET_EXHAUSTED', 'BLOCKED']);
  assert.deepEqual(DATA_STATE_FAMILY, ['empty', 'loading', 'error', 'one-row', 'many-rows']);
  assert.equal(COVERAGE_CELL_VERSION, 'qa-gui/coverage-cell/v1');
  assert.equal(APP_MAP_V2_SCHEMA, 'qa-gui/app-map/v2');
});

test('coarse state by rule and the canonical condition key', () => {
  assert.equal(coarseStateOf({ readyState: 'loading' }), 'loading');
  assert.equal(coarseStateOf({ readyState: 'settled', httpLikeStatus: 500 }), 'error');
  assert.equal(coarseStateOf({ rows: 0 }), 'empty');
  assert.equal(coarseStateOf({ rows: 1 }), 'one-row');
  assert.equal(coarseStateOf({ rows: 7 }), 'many-rows');
  assert.equal(coarseStateOf({ readyState: 'settled' }), 'ideal');
  // a declared label is not a rule: only what was measured decides
  assert.equal(coarseStateOf({ state: 'empty', rows: 3 }), 'many-rows');
  assert.equal(conditionKey(undefined), 'default');
  assert.equal(conditionKey({}), 'default');
  assert.equal(conditionKey({ network: 'offline', cpu: '4x' }), 'cpu=4x+network=offline');
});

test('app map v2 of the list, form and modal app: every frontier branch with its code, the stop reason and the state observations', () => {
  const map = loop6.buildAppMapV2(LOG);
  assert.equal(map.schema, 'qa-gui/app-map/v2');
  assert.deepEqual(map.issues, []);

  // The v1 graph is unchanged; v2 only adds each node's route (surface).
  const v1 = buildAppMap(LOG);
  assert.deepEqual(map.nodes.map(({ route, ...node }) => node), v1.nodes);
  assert.deepEqual(map.edges, v1.edges);
  assert.deepEqual(map.nodes.map((node) => [node.id, node.route]), [
    ['screen:orders-list', '/orders'], ['screen:order-new', '/orders/new'], ['dialog:delete-order', 'dialog:delete-order'],
  ]);
  // A crawl that stopped on its budget does not know its denominator.
  assert.equal(map.total, null);
  assert.match(map.denominatorReason, /BUDGET_EXHAUSTED/);

  assert.deepEqual(map.states.map((s) => [s.step, s.route, s.state, s.strict, s.viewport, s.condition]), [
    [1, '/orders', 'loading', H(0), 'desktop-1280', 'default'],
    [2, '/orders', 'many-rows', H(1), 'desktop-1280', 'default'],
    [3, '/orders/new', 'ideal', H(2), 'desktop-1280', 'default'],
    [4, '/orders', 'many-rows', H(1), 'desktop-1280', 'default'],
    [5, 'dialog:delete-order', 'ideal', H(3), 'desktop-1280', 'default'],
    [7, '/orders', 'many-rows', H(1), 'desktop-1280', 'default'],
    [8, '/orders', 'many-rows', H(4), 'desktop-1280', 'default'],
  ]);

  // Taken candidates (New Order, Delete, Sort, both Cancels) are edges, not frontier; each branch left has its code.
  assert.deepEqual(map.frontier.map((f) => [f.kind, f.route, f.state, f.action, f.viewport, f.condition, f.reason, f.leadsTo ?? null]), [
    ['action', '/orders', 'many-rows', 'click:Export', 'desktop-1280', 'default', 'HOVER_ONLY', null],
    ['action', '/orders', 'many-rows', 'click:Admin', 'desktop-1280', 'default', 'AUTH', '/admin'],
    ['action', '/orders/new', 'ideal', 'click:Save', 'desktop-1280', 'default', 'BUDGET', null],
    ['action', 'dialog:delete-order', 'ideal', 'click:Confirm', 'desktop-1280', 'default', 'NEEDS_APPROVAL', null],
    ['state', '/orders', 'empty', 'view', '*', '*', 'NO_DATA', null],
  ]);
  assert.ok(map.frontier.every((f) => NOT_EXPLORED_CODES.includes(f.reason)));
  assert.deepEqual(map.stop, { reason: 'BUDGET_EXHAUSTED', code: null, detail: 'the step budget of 8 actions is used', step: 10 });

  // Saturation by hand. Strict (DOM hash): H0 x1, H1 x3, H2 x1, H3 x1, H4 x1 -> n = 7, f1 = 4 singletons.
  // Coarse (route|state rule): /orders|loading x1, /orders|many-rows x4, /orders/new|ideal x1,
  // dialog:delete-order|ideal x1 -> n = 7, f1 = 3.
  assert.deepEqual(map.saturation.strict, { n: 7, f1: 4, distinct: 5, u: 4 / 7 });
  assert.deepEqual(map.saturation.coarse, { n: 7, f1: 3, distinct: 4, u: 3 / 7 });
});

test('the shared contract fixture equals what app map v2 builds (Team QA reads the same file)', () => {
  assert.deepEqual(loop6.buildAppMapV2(LOG), JSON.parse(readFileSync(EXPECTED_MAP, 'utf8')));
});

test('stop reason: declared, derived from the v1 hint, FRONTIER_EMPTY only when nothing explorable is left', () => {
  const base = LOG.filter((obs) => obs.action !== 'stop' && obs.action !== 'skip');
  // no stop entry, open candidates left: the log does not say why it ended
  let map = loop6.buildAppMapV2(base);
  assert.deepEqual([map.stop.reason, map.stop.code], ['BLOCKED', 'TOOL_LIMIT']);
  assert.equal(map.frontier.find((f) => f.action === 'click:Save').reason, 'TOOL_LIMIT');
  // the v1 log's budget hint
  map = loop6.buildAppMapV2([...base, { step: 9, detail: '3 discovered but budget exhausted' }]);
  assert.equal(map.stop.reason, 'BUDGET_EXHAUSTED');
  // FRONTIER_EMPTY while an explorable candidate is left is corrected and reported
  map = loop6.buildAppMapV2([...base, { step: 9, action: 'stop', reason: 'FRONTIER_EMPTY' }]);
  assert.equal(map.stop.reason, 'BLOCKED');
  assert.ok(map.issues.includes('STOP_FRONTIER_NOT_EMPTY'));
  // a crawl whose candidates were all taken or blocked: FRONTIER_EMPTY, and the total is known again
  const done = base.map((obs) => obs.node === 'screen:order-new' ? { ...obs, candidates: [{ target: 'button:Cancel' }] } : obs);
  map = loop6.buildAppMapV2(done);
  assert.equal(map.stop.reason, 'FRONTIER_EMPTY');
  assert.equal(map.total, 3);
  // BLOCKED carries the code of what blocked it
  map = loop6.buildAppMapV2([...base, { step: 9, action: 'stop', reason: 'BLOCKED', code: 'AUTH', detail: 'session expired' }]);
  assert.deepEqual([map.stop.reason, map.stop.code], ['BLOCKED', 'AUTH']);
  assert.equal(map.frontier.find((f) => f.action === 'click:Save').reason, 'AUTH');
  // unknown codes are reported, never passed through
  map = loop6.buildAppMapV2([...base, { step: 9, action: 'skip', route: '/orders', state: 'error', reason: 'LAZY' }, { step: 10, action: 'stop', reason: 'DONE' }]);
  assert.ok(map.issues.includes('SKIP_REASON_INVALID'));
  assert.ok(map.issues.includes('STOP_REASON_INVALID'));
  assert.ok(map.frontier.every((f) => NOT_EXPLORED_CODES.includes(f.reason)));
});

test('the qa-gui CLI writes app map v2 from an exploration log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-r1b-cli-'));
  const out = join(dir, 'app-map.json');
  const r = spawnSync(process.execPath, [CLI, 'app-map', '--log', FIXTURE, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const line = JSON.parse(r.stdout.trim());
  assert.deepEqual([line.ok, line.command, line.frontier, line.stop], [true, 'app-map', 5, 'BUDGET_EXHAUSTED']);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(readFileSync(EXPECTED_MAP, 'utf8')));
  const bad = spawnSync(process.execPath, [CLI, 'app-map', '--log', FIXTURE], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

function cellReceipt(cell) {
  return { schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'empty', viewport: '1280x800', domHash: H(5), ...(cell === undefined ? {} : { cell }) };
}
const goodCell = () => ({ version: 'qa-gui/coverage-cell/v1', route: '/orders', action: 'view', viewport: 'desktop-1280', conditions: {}, rows: 0 });

test('state receipt cell: a good cell, then each malformed or contradicted cell is refused with its code', () => {
  assert.deepEqual(stateCellIssues(cellReceipt(undefined)), []);
  assert.deepEqual(stateCellIssues(cellReceipt(goodCell())), []);
  assert.deepEqual(stateCell(cellReceipt(goodCell())), { route: '/orders', state: 'empty', action: 'view', viewport: 'desktop-1280', condition: 'default', strict: H(5) });
  for (const [name, change, code] of [
    ['wrong version', (c) => { c.version = 'v0'; }, 'CELL_VERSION'],
    ['unknown field', (c) => { c.extra = 1; }, 'CELL_UNKNOWN_FIELD'],
    ['missing route', (c) => { delete c.route; }, 'CELL_MISSING_FIELD'],
    ['not a matrix row', (c) => { c.viewport = 'desktop-1440'; }, 'CELL_VIEWPORT_ROW'],
    ['row of another size', (c) => { c.viewport = 'phone-360'; }, 'CELL_VIEWPORT_MISMATCH'],
    ['condition kind', (c) => { c.conditions = { clock: 'fake' }; }, 'CELL_CONDITION_KIND'],
    ['condition value', (c) => { c.conditions = { network: 'slow 3g' }; }, 'CELL_CONDITION_VALUE'],
    ['empty with rows', (c) => { c.rows = 3; }, 'CELL_STATE_ROWS_MISMATCH'],
    ['row state not measured', (c) => { delete c.rows; }, 'CELL_ROWS_UNMEASURED'],
    ['bad state label', (c) => { c.state = 'empty state'; }, 'CELL_STATE'],
  ]) {
    const cell = goodCell(); change(cell);
    assert.ok(codes(stateCellIssues(cellReceipt(cell))).includes(code), `${name}: ${JSON.stringify(stateCellIssues(cellReceipt(cell)))}`);
  }
  // a forced environment condition is part of the cell, backed by the conditions Dragon recorded for the state (env)
  const offline = { ...goodCell(), state: 'error', conditions: { network: 'offline' } };
  delete offline.rows;
  const env = { conditions: { v: 1, caseId: null, role: 'test', network: { offline: true, latencyMs: 0, downloadKbps: null, uploadKbps: null, urlPattern: null },
    cpu: null, timezone: null, locale: null, media: null, animation: null, requests: [], probes: { sensors: false, frames: false }, verified: true, setAt: 1, expiresAt: 2 } };
  assert.deepEqual(stateCellIssues({ ...cellReceipt(offline), env }), []);
  assert.equal(stateCell({ ...cellReceipt(offline), env }).condition, 'network=offline');
  // without that record the condition is not a forced state (integration: CELL_CONDITIONS_UNBACKED)
  assert.deepEqual(codes(stateCellIssues(cellReceipt(offline))), ['CELL_CONDITIONS_UNBACKED']);
});

// A Git board (schema 6, default gate mode) with one static case and one state receipt, as the R1f gate tests build it.
function board({ cell } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1b-gate-')));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = (rel, bytes) => { writeFileSync(join(dir, rel), bytes); return rel; };
  const png = readFileSync(join(ROOT, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png'));
  const shot = write('evidence/TC-01-empty.png', png);
  const raw = write('evidence/TC-01-raw.json', '{"observed":"no orders"}\n');
  const ok = (id) => ({ id, verdict: 'PASS', evidence: 'raw' });
  const receipt = {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'empty', capturedAt: '2026-11-04T02:00:00.000Z',
    url: 'https://test.example/orders', build: 'build-r1b', viewport: '1280x800', domHash: H(5),
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: { path: shot, sha256: sha(png) },
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', verdict: 'PASS', evidence_ref: raw }] },
    ui: { verdict: 'PASS', uiSanity: ok('ui-sanity'), a11y: ok('a11y'), console: ok('console'), network: ok('network') },
    preflight: ok('preflight'),
    ...(cell === undefined ? {} : { cell }),
  };
  const rec = write('evidence/TC-01-empty.state.json', `${JSON.stringify(receipt, null, 2)}\n`);
  const evidence = [shot, raw, rec];
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r1b', title: 'R1b cell fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r1b-fixture', envDb: 'TEST / fixture',
    viewport: '1280x800', runUuid: '22222222-2222-4222-8222-222222222222', commit: 'c'.repeat(40), build: 'build-r1b', env: 'TEST', db: 'fixture',
    role: 'qa-agent', testProfile: 'r1b', evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))) })),
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Empty order list', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'Empty order list', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open the list with no orders.',
      expected: 'The empty state shows.', status: 'PASS', priority: 'P2', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Empty.', ui: 'Clean.' }, machine: { rule: 'r1b', selector: '#orders' }, kind: 'static', states: ['empty'],
      stateReceipts: [{ state: 'empty', file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T02:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R1b fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { dir, file, data, rec };
}
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });

test('gate: a receipt without a cell keeps today\'s output; a good cell is counted as a cell with a receipt', () => {
  const plain = gate(board().file);
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.doesNotMatch(plain.stdout, /Cells with receipt/);
  const withCell = gate(board({ cell: goodCell() }).file);
  assert.equal(withCell.status, 0, withCell.stderr + withCell.stdout);
  assert.match(withCell.stdout, /QA gate: PASS/);
  assert.match(withCell.stdout, /Cells with receipt: 1 \(PASS 1 · FAIL 0 · UNGRADED 0\)/);
});

test('gate: a receipt that claims the empty state while it measured rows is not a receipt in the empty state', () => {
  const r = gate(board({ cell: { ...goodCell(), rows: 3 } }).file);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /UNGRADED A05 case TC-01 state "empty" receipt: cell CELL_STATE_ROWS_MISMATCH/);
  assert.doesNotMatch(r.stdout, /QA gate: PASS/);
  assert.match(r.stdout, /Cells with receipt: 0 \(PASS 0 · FAIL 0 · UNGRADED 1\)/);
});

test('release-truth v2 and web: the cell is an allowed receipt field and is checked the same way', () => {
  const v2 = (cell) => {
    const fixture = board({ cell });
    fixture.data.evidenceManifest = fixture.data.evidenceManifest.map((entry) => ({ ...entry,
      evidence_type: entry.path.endsWith('.png') ? 'gui-screenshot' : 'machine-receipt',
      metadata: { run_uuid: fixture.data.runUuid, task_base: fixture.data.commit, commit: fixture.data.commit, case_id: 'TC-01', state: 'empty', captured_at: '2026-11-04T02:00:00.000Z' } }));
    const receiptPath = join(fixture.dir, fixture.rec);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.function.assertions = [{ requirement_id: 'REQ-1', assertion_id: 'TC-01-A1', verdict: 'PASS', evidence_ref: receipt.screenshot.path, evidence_type: 'gui-screenshot' }];
    writeFileSync(receiptPath, JSON.stringify(receipt));
    fixture.data.evidenceManifest.find((e) => e.path === fixture.rec).sha256 = sha(readFileSync(receiptPath));
    writeFileSync(fixture.file, JSON.stringify(fixture.data));
    const requirement = { id: 'REQ-1', acceptance_ids: ['TC-01'], risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot'] } };
    const context = { kind: 'git', exactFinalSha: fixture.data.commit, taskBase: fixture.data.commit, activeGuiRequirements: [requirement], guiIds: ['REQ-1'],
      planById: new Map([['TC-01', { requirementId: 'REQ-1', data: {} }]]) };
    return checkGuiReleaseTruthV2({ data: fixture.data, boardPath: fixture.file, evidenceRoot: fixture.dir, context });
  };
  const good = v2(goodCell());
  assert.deepEqual(good.issues.filter((i) => /cell|L22/i.test(i.message)), []);
  assert.deepEqual(good.computed.cells.map((c) => [c.case_id, c.route, c.state, c.viewport, c.verdict]), [['TC-01', '/orders', 'empty', 'desktop-1280', 'PASS']]);
  const bad = v2({ ...goodCell(), viewport: 'phone-320' });
  assert.ok(bad.issues.some((i) => i.ungraded && i.message.startsWith('state-receipt:TC-01:empty:CELL_VIEWPORT_MISMATCH:')), JSON.stringify(bad.issues));
  assert.deepEqual(bad.computed.cells.map((c) => c.verdict), ['UNGRADED']);
});
