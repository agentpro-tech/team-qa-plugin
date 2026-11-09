// Upgrade R3 (speed-ups), part 2: the gate verifies every inherited C10–C16 assertion again (vision by diff) and the C14
// contract accepts a state inspected through its approved baseline. Synthetic boards; never evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodePng } from '../scripts/visual-diff.mjs';
import { approveBaseline, emptyStore, proposeBaseline, writeStore } from '../scripts/lib/baseline-store.mjs';
import { inheritedVisionAssertions, visionDiffDecision } from '../scripts/lib/vision-by-diff.mjs';
import { checkGuiReleaseTruthV2 } from '../scripts/lib/qa-gui-v2.mjs';
import { validateCanonical } from '../scripts/teamwork/canonical.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RUN_UUID = '22222222-2222-4222-8222-222222222222';
const COMMIT = 'c'.repeat(40);
const RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const ALL_PASS = Object.fromEntries(RULES.map((rule) => [rule, 'PASS']));

function page({ rows = 3 } = {}) {
  const width = 320, height = 200, data = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set([...rgb, 255], (y * width + x) * 4); };
  fill(0, 0, width, height, [250, 250, 250]);
  fill(0, 0, width, 24, [30, 30, 40]);
  for (let r = 0; r < rows; r += 1) fill(16, 40 + r * 30, 288, 20, [225, 228, 235]);
  return encodePng({ width, height, data });
}

// One completed static case with one state. `inherit` writes the seven vision assertions from the tier-0 decision;
// otherwise they are VLM verdicts as today. `mutate` edits the pieces before they are written.
function fixture({ inherit = true, policy = true, actual = page(), mutate = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-gate-')));
  const write = (rel, bytes) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), bytes); return rel; };
  const key = { route: '/orders', state: 'orders-list', viewport: '320x200', build: 'build-2' };
  const storeDir = join(dir, 'speed');
  let { store } = proposeBaseline({ store: emptyStore(), dir: storeDir, key, png: page(), vision: ALL_PASS, now: '2026-11-01T01:00:00.000Z' });
  ({ store } = approveBaseline({ store, key, sha256: sha(page()), by: 'Project Owner', now: '2026-11-01T02:00:00.000Z', env: {} }));
  // What an honest writer would claim for the unchanged screen, before any mutation below.
  const clean = { uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: '{}' }, a11y: { id: 'a11y', verdict: 'PASS', evidence: '{}' } };
  const claimed = visionDiffDecision({ png: page(), key, store: structuredClone(store), storeDir, sweep: clean, capturedAt: '2026-11-04T03:00:00.000Z' });
  mutate.store?.(store);
  const storeSha = writeStore(join(storeDir, 'approved-baselines.json'), store);
  const shot = write('evidence/TC-01/orders-list.png', actual);
  const raw = write('evidence/TC-01/raw.json', '{"rows":3}\n');
  const receipt = {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'orders-list', capturedAt: '2026-11-04T03:00:00.000Z',
    url: 'https://app.test/orders', build: 'build-2', viewport: '320x200', domHash: 'd'.repeat(64),
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: { path: shot, sha256: sha(actual) },
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', assertion_id: 'TC-01-A1', verdict: 'PASS', evidence_ref: shot, evidence_type: 'gui-screenshot' }] },
    ui: { verdict: 'PASS', uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: JSON.stringify({ v: 'PASS', c: { high: 0, warn: 0 } }) },
      a11y: { id: 'a11y', verdict: 'PASS', evidence: JSON.stringify({ v: 'PASS' }) },
      console: { id: 'console', verdict: 'PASS', evidence: 'raw' }, network: { id: 'network', verdict: 'PASS', evidence: 'raw' } },
    preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw' }, network: [], network_summary: { failed_requests: 0 },
    readback: { value: { rows: 3 }, evidence_ref: raw },
  };
  mutate.receipt?.(receipt);
  const rec = write('evidence/TC-01/orders-list.receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
  const decision = visionDiffDecision({ png: actual, key, store, storeDir, sweep: receipt.ui, capturedAt: receipt.capturedAt });
  const vision = inherit ? inheritedVisionAssertions({ decision: claimed, caseId: 'TC-01', state: 'orders-list', evidenceRef: shot })
    : RULES.map((rule) => ({ assertion_id: `TC-01-orders-list-${rule}`, case_id: 'TC-01', state: 'orders-list', rule, verdict: 'PASS', evidence_ref: shot, evidence_type: 'gui-screenshot' }));
  mutate.vision?.(vision);
  const types = { [shot]: 'gui-screenshot', [raw]: 'machine-receipt', [rec]: 'machine-receipt' };
  const evidence = [shot, raw, rec];
  const speedPolicy = { version: 1, source: { kind: 'team-qa/signed-plan', sha256: 'a'.repeat(64) }, flags: { vision_by_diff: 'on' },
    baseline_store: { path: 'speed/approved-baselines.json', sha256: storeSha } };
  mutate.policy?.(speedPolicy);
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r3', title: 'R3 vision by diff fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r3-fixture', envDb: 'TEST / fixture',
    viewport: '320x200', runUuid: RUN_UUID, commit: COMMIT, build: 'build-2', env: 'TEST', db: 'fixture', role: 'qa-agent', testProfile: 'r3',
    ...(policy ? { speedPolicy } : {}),
    evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))), evidence_type: types[path],
      metadata: { run_uuid: RUN_UUID, task_base: COMMIT, commit: COMMIT, case_id: 'TC-01', state: 'orders-list', captured_at: '2026-11-04T03:00:00.000Z' } })),
    vision: { version: 2, assertions: vision },
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'List orders', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'List orders', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open the orders list.',
      expected: 'Three orders are listed.', status: 'PASS', priority: 'P2', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Listed.', ui: 'Clean.' }, machine: { rule: 'r3', selector: '#orders' }, kind: 'static', states: ['orders-list'],
      stateReceipts: [{ state: 'orders-list', file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T03:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R3 fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  mutate.board?.(data);
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { dir, file, data, decision };
}
const requirement = { id: 'REQ-1', acceptance_ids: ['TC-01'], risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot'] } };
const context = { kind: 'git', exactFinalSha: COMMIT, taskBase: COMMIT, activeGuiRequirements: [requirement], guiIds: ['REQ-1'],
  planById: new Map([['TC-01', { requirementId: 'REQ-1', data: {} }]]) };
const gate = (f) => checkGuiReleaseTruthV2({ data: f.data, boardPath: f.file, evidenceRoot: f.dir, context });
const visionIssues = (r) => r.issues.filter((i) => /^(VISION_|SPEED_|L22 vision)/.test(i.message));

test('canonical board: `inherited` and `speedPolicy` exist only on a board that declares a speed policy', () => {
  const on = fixture();
  assert.deepEqual(validateCanonical(on.data).errors, []);
  const off = fixture({ policy: false });
  assert.ok(validateCanonical(off.data).errors.some((e) => /vision\.assertions\[0\]/.test(e.path)), 'inherited without a policy is an unknown field');
  const plain = fixture({ policy: false, inherit: false });
  assert.deepEqual(validateCanonical(plain.data).errors, []);
});

test('gate: an inherited state (approved baseline, diff within limits, clean DOM sweep, flag on) passes with its baseline SHA', () => {
  const f = fixture();
  assert.equal(f.decision.decision, 'inherit');
  const r = gate(f);
  assert.deepEqual(visionIssues(r), []);
  assert.deepEqual(r.atomicCoverage.map((row) => row.result), ['PASS']);
  assert.ok(f.data.vision.assertions.every((a) => a.inherited.baseline_sha256 === f.decision.baseline.sha256));
});

test('gate: an inherited assertion the gate cannot recompute is UNGRADED and the case cannot PASS', () => {
  for (const [name, options, code] of [
    ['flag in shadow', { mutate: { policy: (p) => { p.flags.vision_by_diff = 'shadow'; } } }, 'VISION_INHERIT_FLAG_OFF'],
    ['minimum tier raised', { mutate: { policy: (p) => { p.min_tier = { vision: 2 }; } } }, 'VISION_INHERIT_INVALID'],
    ['store changed after the policy pinned it', { mutate: { policy: (p) => { p.baseline_store.sha256 = 'e'.repeat(64); } } }, 'VISION_INHERIT_STORE_DRIFT'],
    ['store outside the evidence root', { mutate: { policy: (p) => { p.baseline_store.path = '../elsewhere.json'; } } }, 'VISION_INHERIT_STORE_DRIFT'],
    ['the screen changed (diff over 0.5%)', { actual: page({ rows: 4 }) }, 'VISION_INHERIT_INVALID'],
    ['DOM sweep not clean', { mutate: { receipt: (r) => { r.ui.uiSanity.evidence = JSON.stringify({ v: 'PASS', c: { high: 0, warn: 3 } }); } } }, 'VISION_INHERIT_INVALID'],
    ['only some rules inherited', { mutate: { vision: (v) => { delete v[3].inherited; } } }, 'VISION_INHERIT_PARTIAL'],
    ['another baseline SHA claimed', { mutate: { vision: (v) => { v[0].inherited.baseline_sha256 = 'b'.repeat(64); } } }, 'VISION_INHERIT_MISMATCH'],
    ['a diff number that is not the recomputed one', { mutate: { vision: (v) => { v[1].inherited.diff_percent = 0.25; } } }, 'VISION_INHERIT_MISMATCH'],
    ['a verdict that is not the baseline\'s', { mutate: { vision: (v) => { v[2].verdict = 'FAIL'; } } }, 'VISION_INHERIT_MISMATCH'],
    ['a baseline only proposed', { mutate: { store: (s) => { s.entries[0].status = 'proposed'; s.entries[0].approved_by = ''; s.entries[0].approved_at = ''; } } }, 'VISION_INHERIT_INVALID'],
    ['the route of another page', { mutate: { receipt: (r) => { r.url = 'https://app.test/customers'; } } }, 'VISION_INHERIT_INVALID'],
  ]) {
    const r = gate(fixture(options));
    const issues = visionIssues(r);
    assert.ok(issues.some((i) => i.ungraded && i.message.startsWith(`${code}:TC-01:orders-list`)), `${name}: ${JSON.stringify(issues)}`);
    assert.deepEqual(r.atomicCoverage.map((row) => row.result), ['UNGRADED'], `${name}: the case's rows cannot stay PASS`);
  }
});

test('gate: the approver rule of the environment applies to the baseline an assertion inherits from', () => {
  const before = process.env.QA_GUI_BASELINE_APPROVER;
  process.env.QA_GUI_BASELINE_APPROVER = 'Release Owner';
  try {
    const r = gate(fixture());
    assert.ok(visionIssues(r).some((i) => i.message.startsWith('VISION_INHERIT_APPROVER:TC-01:orders-list')));
  } finally {
    if (before === undefined) delete process.env.QA_GUI_BASELINE_APPROVER; else process.env.QA_GUI_BASELINE_APPROVER = before;
  }
});

test('gate: with no speed policy, VLM vision assertions grade exactly as before', () => {
  const r = gate(fixture({ policy: false, inherit: false }));
  assert.deepEqual(visionIssues(r), []);
  assert.deepEqual(r.atomicCoverage.map((row) => row.result), ['PASS']);
  // A board with a policy but no inherited assertion is graded the same way; so is one whose policy has every flag off.
  const withPolicy = gate(fixture({ inherit: false }));
  assert.deepEqual(visionIssues(withPolicy), []);
  const allOff = gate(fixture({ inherit: false, mutate: { policy: (p) => { p.flags = { vision_by_diff: 'off', cost_ladder: 'off', parallel_gui_lanes: 'off', fast_click: 'off', action_cache: 'off' }; } } }));
  assert.deepEqual(allOff.issues.map((i) => i.message), r.issues.map((i) => i.message));
  assert.deepEqual(allOff.atomicCoverage.map((row) => row.result), r.atomicCoverage.map((row) => row.result));
  // An invalid speed policy is refused.
  const bad = gate(fixture({ inherit: false, mutate: { policy: (p) => { p.flags.turbo = 'on'; } } }));
  assert.ok(bad.issues.some((i) => i.ungraded && i.message.startsWith('SPEED_POLICY_INVALID')));
});
