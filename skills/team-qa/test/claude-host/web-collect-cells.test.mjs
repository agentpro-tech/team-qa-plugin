// Upgrade R1b follow-up: `web collect` writes the coverage cell (qa-gui/coverage-cell/v1) into the state receipts it
// makes for a cell case (a tracked plan v2 case with `route` under the coverage block): route, state, action, viewport
// row and conditions (`{}` until the Dragon environment conditions of R1a land), plus the row count a read step measured.
// Synthetic stream-json fixtures, never evidence of a live run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DRAFT_MARKER, buildCaseEvidence, draftIssues, qaGuiEvidenceTools, streamCalls } from '../../scripts/lib/web-collect.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-web-collect-cells-')));
const PNG = join(dir, 'orders-many.png');
writeFileSync(PNG, Buffer.from('\x89PNG fixture'));
const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
let clock = Date.parse('2026-11-04T03:00:00Z');
const use = (id, name, input) => ({ type: 'assistant', timestamp: new Date(clock += 1000).toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', timestamp: new Date(clock += 500).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const RPC = 'mcp__Dragon_Browser__dragon_rpc';
const S = { sessionId: 'exec-s1', nonce: 'n1', browserInstanceId: 'bi-1' };
const state = { state: 'many-rows', screenshot: 'orders-many.png', gate0: 'g0', rows: 'rows', console: true, network: true,
  assertions: [{ assertion_id: 'TC-01-A1', verdict: 'PASS' }] };
const draft = { case_id: 'TC-01', summary: { function: 'The list shows the orders.', ui: 'Clean.' }, states: [state] };
const events = [
  use('toolu_sess', RPC, { method: 'session.create', params: { sessionId: 'exec-s1' } }), result('toolu_sess', ok({ ...S })),
  use('toolu_tab', RPC, { method: 'openTab', params: { ...S, url: 'http://127.0.0.1:5401/orders' } }), result('toolu_tab', ok({ tabId: 7, sessionId: 'exec-s1' })),
  use('toolu_shot', 'mcp__Dragon_Browser__screenshot', { tabId: 7, toFile: 'orders-many.png' }),
  result('toolu_shot', ok({ savedTo: PNG, sha256: sha(readFileSync(PNG)), domHash: 'd'.repeat(64), privacyMasked: true,
    dom: { url: 'http://127.0.0.1:5401/orders?page=1', viewport: '1280x800' }, evidence: { ref: 'observation:abc', ts: clock } })),
  use('toolu_g0', 'mcp__Dragon_Browser__do', { tabId: 7, steps: [{ read: { js: 'gate0()', as: 'g0' } }, { read: { js: 'rows()', as: 'rows' } }] }),
  result('toolu_g0', ok({ completed: true, results: [
    { step: 'read', as: 'g0', value: JSON.stringify({ ui: { v: 'PASS' }, a11y: { v: 'PASS' } }) },
    { step: 'read', as: 'rows', value: '3' }] })),
  use('toolu_con', RPC, { method: 'getConsole', params: { ...S, tabId: 7 } }), result('toolu_con', ok({ count: 0, entries: [] })),
  use('toolu_net', RPC, { method: 'getNetwork', params: { ...S, tabId: 7 } }),
  result('toolu_net', ok({ count: 1, requests: [{ t: clock, method: 'GET', url: 'http://127.0.0.1:5411/rest/v1/orders', status: 200, type: 'Fetch' }] })),
  { type: 'assistant', message: { content: [{ type: 'text', text: `Done.\n\n${DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`\n` }] } },
];
const stream = events.map((e) => JSON.stringify(e)).join('\n');
const binding = { run_uuid: '11111111-1111-4111-8111-111111111111', target_binding_sha256: 'b'.repeat(64), target: { frontend_build: { id: 'index-1' } } };
const coverage = { version: 'team-qa/coverage-cells/v1', rows: [{ id: 'desktop-1280', size: '1280x800', classes: ['desktop'] }], dataScreens: ['/orders'] };
const cellCase = { id: 'TC-01', req_id: 'REQ-LIST', route: '/orders', states: ['many-rows'], viewports: ['desktop'] };
const preflightRaw = { id: 'preflight', verdict: 'PASS', evidence: 'team-qa preflight.json sha256=…' };
const fileSha = (path) => sha(readFileSync(path));
const exists = (path) => { try { readFileSync(path); return true; } catch { return false; } };

// QA GUI's evidence tools with its cell checks (scripts/lib/coverage-cell.mjs); `cellProblems` stands in for its verdict.
function stubTools({ cell = true, cellProblems = [] } = {}) {
  const seen = [];
  const tools = {
    EVIDENCE_POLICY_VERSION: 1, MAX_EVIDENCE_WIDTH: 1280,
    fitPng: (bytes) => ({ png: bytes, sha256: sha(bytes), fit: { fromSha256: sha(bytes), fromWidth: 1280, fromHeight: 800, width: 1280, height: 800 } }),
    buildRecordingManifest: () => { throw new Error('no recording in this fixture'); },
    stateImageIssues: () => [],
    recordingSegmentIssues: () => [],
    ...(cell ? { COVERAGE_CELL_VERSION: 'qa-gui/coverage-cell/v1', stateCellIssues: (receipt) => { seen.push(receipt.cell); return cellProblems; } } : {}),
  };
  return { tools, seen };
}
const build = ({ d = draft, plannedCase = cellCase, cov = coverage, tools = stubTools().tools } = {}) => buildCaseEvidence({ draft: d, calls: streamCalls(stream), binding,
  plannedCase, boardCase: { id: 'TC-01', kind: 'static', status: 'TODO' }, viewport: '1280x800', preflightRaw, fileSha, exists, tools, coverage: cov,
  readFile: (path) => readFileSync(path) });

test('a cell case: the receipt names its cell from the plan route, the state, the action, the plan row of its size and the measured rows', () => {
  const { tools, seen } = stubTools();
  const built = build({ tools });
  assert.deepEqual(built.issues, []);
  const [{ value: r }] = built.receipts;
  assert.deepEqual(r.cell, { version: 'qa-gui/coverage-cell/v1', route: '/orders', state: 'many-rows', action: 'view', viewport: 'desktop-1280', conditions: {}, rows: 3 });
  // QA GUI's own cell checks ran on the receipt, as its gate will.
  assert.deepEqual(seen, [r.cell]);
  assert.deepEqual([built.caseEntry.functionVerdict, built.caseEntry.uiVerdict], ['PASS', 'PASS']);
});

test('the action is the planned one the draft names; an action the case does not plan is reported', () => {
  const planned = { ...cellCase, route: 'dialog:delete-order', states: ['ideal'], actions: ['click:Cancel'] };
  const d = { ...draft, states: [{ ...state, state: 'ideal', action: 'click:Cancel', rows: undefined }] };
  let built = build({ d, plannedCase: planned });
  assert.deepEqual(built.issues, []);
  assert.deepEqual(built.receipts[0].value.cell, { version: 'qa-gui/coverage-cell/v1', route: 'dialog:delete-order', state: 'ideal', action: 'click:Cancel', viewport: 'desktop-1280', conditions: {} });
  built = build({ d: { ...d, states: [{ ...d.states[0], action: 'click:Confirm' }] }, plannedCase: planned });
  assert.deepEqual(built.issues, ['CELL_ACTION_NOT_PLANNED:TC-01:ideal:click:Confirm']);
  assert.equal(built.receipts[0].value.cell.action, 'click:Confirm');
});

test('a row-family state without a measured row count, and a cell QA GUI refuses, keep the state from PASS', () => {
  // No read step named: the cell is written without rows and the reason is reported.
  let built = build({ d: { ...draft, states: [{ ...state, rows: undefined }] } });
  assert.ok(built.issues.includes('CELL_ROWS_UNAVAILABLE:TC-01:many-rows:the draft names no read step of the row count (rows)'), built.issues.join(', '));
  assert.equal(Object.hasOwn(built.receipts[0].value.cell, 'rows'), false);
  // A label with no read step of that name in the state's window.
  built = build({ d: { ...draft, states: [{ ...state, rows: 'count' }] } });
  assert.ok(built.issues.some((issue) => issue.startsWith('CELL_ROWS_UNAVAILABLE:TC-01:many-rows:no do/runFlow with a read step as "count"')), built.issues.join(', '));
  // What QA GUI's cell checks refuse makes the state UNGRADED with QA GUI's code.
  const { tools } = stubTools({ cellProblems: [{ code: 'CELL_STATE_ROWS_MISMATCH', detail: 'many-rows:rows=0' }] });
  built = build({ tools });
  assert.deepEqual(built.issues, ['CELL_STATE_ROWS_MISMATCH:TC-01:many-rows:many-rows:rows=0']);
  assert.deepEqual([built.caseEntry.functionVerdict, built.caseEntry.uiVerdict], ['UNGRADED', 'UNGRADED']);
});

test('no cell for a case without a route, for a size the plan has no row for, or with a QA GUI that cannot check one', () => {
  // A case outside the cell model keeps the receipt of before R1b.
  let built = build({ plannedCase: { id: 'TC-01', req_id: 'REQ-LIST' }, cov: null });
  assert.deepEqual(built.issues, []);
  assert.equal(Object.hasOwn(built.receipts[0].value, 'cell'), false);
  // The plan has no row of the measured size.
  built = build({ cov: { ...coverage, rows: [{ id: 'phone-360', size: '360x800', classes: ['desktop'] }] } });
  assert.deepEqual(built.issues, ['CELL_VIEWPORT_ROW_UNKNOWN:TC-01:many-rows:1280x800']);
  assert.equal(Object.hasOwn(built.receipts[0].value, 'cell'), false);
  // A QA GUI before R1b would refuse the unknown field, so no cell is written and the gap is reported.
  built = build({ tools: stubTools({ cell: false }).tools });
  assert.deepEqual(built.issues, ['CELL_UNSUPPORTED_BY_QA_GUI:TC-01']);
  assert.equal(Object.hasOwn(built.receipts[0].value, 'cell'), false);
});

test('the draft\'s action and rows are checked for shape', () => {
  const ids = { caseIds: ['TC-01'] };
  assert.deepEqual(draftIssues(draft, ids), []);
  assert.deepEqual(draftIssues({ ...draft, states: [{ ...state, action: ' click' }] }, ids), ['EVIDENCE_DRAFT_ACTION_INVALID:many-rows']);
  assert.deepEqual(draftIssues({ ...draft, states: [{ ...state, action: 'a|b' }] }, ids), ['EVIDENCE_DRAFT_ACTION_INVALID:many-rows']);
  assert.deepEqual(draftIssues({ ...draft, states: [{ ...state, rows: 3 }] }, ids), ['EVIDENCE_DRAFT_ROWS_INVALID:many-rows']);
});

test('QA GUI\'s evidence tools carry its cell checks when its coverage-cell module is present', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-qa-gui-cells-')));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, 'scripts/lib/evidence-quality.mjs'), ['EVIDENCE_POLICY_VERSION', 'MAX_EVIDENCE_WIDTH', 'fitPng', 'buildRecordingManifest', 'stateImageIssues', 'recordingSegmentIssues']
    .map((name) => `export const ${name} = ${JSON.stringify(name)};`).join('\n'));
  let tools = await qaGuiEvidenceTools(root);
  assert.equal(tools.stateCellIssues, undefined);
  writeFileSync(join(root, 'scripts/lib/coverage-cell.mjs'), 'export const COVERAGE_CELL_VERSION = "qa-gui/coverage-cell/v1";\nexport const stateCellIssues = () => [];\n');
  tools = await qaGuiEvidenceTools(root);
  assert.equal(tools.COVERAGE_CELL_VERSION, 'qa-gui/coverage-cell/v1');
  assert.equal(typeof tools.stateCellIssues, 'function');
  assert.equal(tools.fitPng, 'fitPng');
});

// With a real QA GUI checkout (TEAMQA_WEB_TEST_QA_GUI_ROOT): QA GUI's own cell checks accept the cell collect writes.
const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
test('QA GUI accepts the cell web collect writes, and refuses one whose rows contradict its state', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout' }, async () => {
  const tools = await qaGuiEvidenceTools(QA_GUI);
  assert.equal(typeof tools.stateCellIssues, 'function');
  const built = buildCaseEvidence({ draft, calls: streamCalls(stream), binding, plannedCase: cellCase, boardCase: { id: 'TC-01', kind: 'static', status: 'TODO' },
    viewport: '1280x800', preflightRaw, fileSha, exists, tools: { ...tools, fitPng: stubTools().tools.fitPng, stateImageIssues: () => [] }, coverage, readFile: (path) => readFileSync(path) });
  assert.deepEqual(built.issues, []);
  const receipt = built.receipts[0].value;
  assert.deepEqual(tools.stateCellIssues(receipt), []);
  assert.ok(tools.stateCellIssues({ ...receipt, cell: { ...receipt.cell, rows: 0 } }).some((problem) => problem.code === 'CELL_STATE_ROWS_MISMATCH'));
});
