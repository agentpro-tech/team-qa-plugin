import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = process.env.QA_GATE_UNDER_TEST || join(ROOT, 'scripts', 'qa-gate.mjs');
const VERIFY = process.env.QA_RECEIPT_VERIFY_UNDER_TEST || join(ROOT, 'scripts', 'receipt-verify.mjs');
const PNG = join(ROOT, 'qa-evidence', 'fixture-a', 'round-1', '1280x800', 'after-load.png');
const CONTRACT_SHA = '77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c';
const VISION_RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const CODE_ONLY_IDS = [
  'P3-T01', 'P3-T02', 'P3-T03', 'P3-T04', 'P3-T05', 'P3-T06', 'P3-T07',
  'P3-T08', 'P3-T09', 'P3-T10', 'P3-T11', 'P3-T12', 'P3-T13', 'P3-T14',
  'P3-T15', 'P3-T16', 'P3-T17', 'OP-FIX-RECORDING', 'OP-FIX-SAVE-STATE',
  'OP-FIX-INPUT-CATALOG', 'NG-REPORTING',
];
const MULTI_IDS = ['NG-LANGUAGE-SLOTS'];
const GUI_ONLY_IDS = [
  'OP-FIX-CA-VISIBILITY', 'OP-FIX-ACCESS-DEDUPE', 'OP-RETEST-06914',
  'OP-PRESET-SOURCE', 'NG-SHARED-LISTS', 'NG-EDITOR-WORDING', 'NG-PRODUCTION-WRITE',
];
const GUI_IDS = [...MULTI_IDS, ...GUI_ONLY_IDS];
const ALL_IDS = [...CODE_ONLY_IDS, ...MULTI_IDS, ...GUI_ONLY_IDS];
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function seal(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return { ...clean, integrity: sha(canonicalJson(clean)) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function git(repo, args) {
  const result = run('git', args, { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function requirement(id, lane, riskDimensions = []) {
  return {
    id,
    expectation: `Scrubbed GUI acceptance for ${id}`,
    requirement_owner: 'fixture',
    verification_lane: lane,
    risk_dimensions: riskDimensions,
    acceptance_ids: [`TC-${id}`],
    evidence_contract: {
      allowed_types: lane === 'code' ? ['code'] : ['gui-screenshot', 'gui-recording'],
      atomic: true,
      multi_evidence: riskDimensions.length > 0,
    },
  };
}

function graphRepo(name, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `qa-gui-session3-${name}-`));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'brief'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'qa@example.invalid']);
  git(repo, ['config', 'user.name', 'QA']);
  writeFileSync(join(repo, 'src', 'feature.js'), 'export const releaseTruth = false;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  const risks = options.risks ?? {};
  const requirements = [
    ...CODE_ONLY_IDS.map((id) => requirement(id, 'code', risks[id] ?? [])),
    ...MULTI_IDS.map((id) => requirement(id, 'multi', risks[id] ?? [])),
    ...GUI_ONLY_IDS.map((id) => requirement(id, 'gui', risks[id] ?? [])),
  ];
  const graph = {
    schema: 'requirements.freeze/v2',
    contract_sha256: CONTRACT_SHA,
    repo: realpathSync(repo),
    task_base: base,
    source_revision: options.sourceRevision ?? 'scrubbed-session3-r1',
    gate_policy: { coverage_threshold: 100, required_layers: ['gui'] },
    requirements,
  };
  const graphPath = join(repo, 'brief', 'REQUIREMENTS.json');
  writeJson(graphPath, graph);
  const plan = {
    cases: ALL_IDS.map((id) => ({
      id: `TC-${id}`,
      req_id: id,
      lane: ['gui', 'multi'].includes(requirements.find((item) => item.id === id).verification_lane)
        ? 'lane-gui' : 'lane-code',
      steps: [`Exercise scrubbed behavior for ${id}`],
      expected: `Observe scrubbed outcome for ${id}`,
      data: options.planData?.[id] ?? {},
      priority: 'P1',
      kind: 'static',
    })),
  };
  const planPath = join(repo, 'brief', 'tracked-plan.json');
  writeJson(planPath, plan);
  const lock = {
    schema: 'team-code/brief-lock/v3',
    frozen_at: '2026-08-24T00:00:00.000Z',
    files: {
      'REQUIREMENTS.json': sha(readFileSync(graphPath)),
      'tracked-plan.json': sha(readFileSync(planPath)),
    },
    acceptance_registry_sha256: 'a'.repeat(64),
    task_base: base,
    source_revision: graph.source_revision,
    gate_policy: graph.gate_policy,
    exact_final_sha: null,
  };
  const lockPath = join(repo, 'brief', 'LOCK.json');
  writeJson(lockPath, lock);
  writeFileSync(join(repo, 'src', 'feature.js'), 'export const releaseTruth = true;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'final']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  return { root, repo, base, head, graph, graphPath, lock, lockPath, plan, planPath };
}

function coverage() {
  return [
    'happy', 'boundary', 'empty', 'loading', 'error', 'auth-role',
    'navigation', 'keyboard', 'responsive', 'dark-mode',
  ].map((area) => ({ area, status: 'tick' }));
}

function evidenceMetadata(f, caseId, state, capturedAt = '2026-08-24T01:00:00.000Z') {
  return {
    run_uuid: f.runUuid,
    task_base: f.base,
    commit: f.head,
    case_id: caseId,
    state,
    captured_at: capturedAt,
  };
}

function addManifest(f, path, evidenceType, caseId, state, metadataOverrides = {}) {
  const absolute = join(f.runDir, path);
  const entry = {
    path,
    sha256: sha(readFileSync(absolute)),
    evidence_type: evidenceType,
    metadata: { ...evidenceMetadata(f, caseId, state), ...metadataOverrides },
  };
  f.board.evidenceManifest.push(entry);
  return entry;
}

function addCase(f, requirementId, options = {}) {
  const caseId = `TC-${requirementId}`;
  const state = options.state ?? 'settled';
  const prefix = `evidence/${caseId}`;
  const screenshot = `${prefix}-${state}.png`;
  const raw = `${prefix}-raw.json`;
  const stateReceipt = `${prefix}-${state}.state.json`;
  mkdirSync(join(f.runDir, 'evidence'), { recursive: true });
  copyFileSync(PNG, join(f.runDir, screenshot));
  writeJson(join(f.runDir, raw), options.rawValue ?? { observed: 'scrubbed-ok' });

  const evidenceType = options.evidenceType ?? 'gui-screenshot';
  const evidenceRef = evidenceType.startsWith('gui-') ? screenshot : raw;
  const assertion = {
    requirement_id: requirementId,
    assertion_id: `ASSERT-${requirementId}`,
    verdict: options.assertionVerdict ?? 'PASS',
    evidence_ref: evidenceRef,
    evidence_type: evidenceType,
  };
  const receipt = {
    schema: 'qa-gui/state-receipt/v1',
    caseId,
    state,
    capturedAt: '2026-08-24T01:00:00.000Z',
    url: 'https://fixture.invalid/qa',
    build: 'fixture-build',
    viewport: '1280x800',
    domHash: 'b'.repeat(64),
    dragon: {
      sessionId: 'session-fixture', actionId: `action-${caseId}`,
      browserInstanceId: 'browser-fixture', tabId: 'tab-fixture', innerOk: true,
    },
    screenshot: { path: screenshot, sha256: sha(readFileSync(join(f.runDir, screenshot))) },
    function: { verdict: assertion.verdict, assertions: [assertion] },
    ui: {
      verdict: 'PASS',
      uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: 'raw ui sanity' },
      a11y: { id: 'a11y', verdict: 'PASS', evidence: 'raw a11y' },
      console: { id: 'console', verdict: 'PASS', evidence: 'raw console' },
      network: { id: 'network', verdict: 'PASS', evidence: 'raw network' },
    },
    preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw preflight' },
    auth: {
      required: Boolean(options.authRequired),
      applicationLoginNotReached: Boolean(options.applicationLoginNotReached),
      authenticated_screen_evidence_ref: screenshot,
    },
    network: options.network ?? [],
    network_summary: { failed_requests: options.failedRequests ?? (options.network ?? []).filter((entry) => entry.status >= 400).length },
    readback: options.readback ?? null,
  };
  writeJson(join(f.runDir, stateReceipt), receipt);

  addManifest(f, screenshot, 'gui-screenshot', caseId, state, options.screenshotMetadata ?? {});
  addManifest(f, raw, evidenceType.startsWith('gui-') ? 'code' : evidenceType, caseId, state, options.rawMetadata ?? {});
  addManifest(f, stateReceipt, 'machine-receipt', caseId, state, options.receiptMetadata ?? {});
  const evidence = [screenshot, raw, stateReceipt];
  const sourceId = `SRC-${requirementId}`;
  if (f.board.schemaVersion === 6) {
    f.board.sourceItems.push({
      id: sourceId,
      kind: 'requirement',
      sourceSystem: 'fixture-spec',
      externalKey: requirementId,
      title: `Release Truth fixture source ${requirementId}`,
      origin: 'upstream',
    });
  }
  f.board.cases.push({
    id: caseId,
    title: `Kiểm chứng giao diện ${requirementId}`,
    requirement: requirementId,
    requirements: [requirementId],
    steps: 'Mở trạng thái đã ổn định và thu bằng chứng giao diện.',
    expected: 'Giao diện hiển thị đúng và bằng chứng liên kết chính xác.',
    status: assertion.verdict === 'FAIL' ? 'FAIL' : 'PASS',
    priority: 'P1', assignee: 'qa-agent',
    functionVerdict: assertion.verdict,
    uiVerdict: 'PASS',
    humanSummary: { function: 'Kết quả được tính từ vật chứng.', ui: 'Giao diện được kiểm trực tiếp.' },
    machine: { rule: 'release-truth-v2', selector: 'scripts/qa-gate.mjs' },
    kind: 'static', states: [state], stateReceipts: [{ state, file: stateReceipt }],
    results: [{ round: 1, functionVerdict: assertion.verdict, uiVerdict: 'PASS', recordedAt: '2026-08-24T01:01:00.000Z', evidence }],
    evidence, comments: [], history: [],
    ...(f.board.schemaVersion === 6 ? { sourceRefs: [sourceId] } : {}),
  });

  if (options.includeVision !== false) {
    for (const rule of VISION_RULES) {
      f.board.vision.assertions.push({
        assertion_id: `VISION-${requirementId}-${rule}`,
        case_id: caseId,
        state,
        rule,
        verdict: 'PASS',
        evidence_ref: screenshot,
        evidence_type: 'gui-screenshot',
      });
    }
  }
  if (options.riskAssertions) f.board.vision.assertions.push(...options.riskAssertions.map((item) => ({ case_id: caseId, state, ...item })));
  return { caseId, state, screenshot, raw, stateReceipt, receipt, assertion };
}

function fixture(name, options = {}) {
  const source = graphRepo(name, options);
  const runDir = join(source.root, 'run');
  mkdirSync(runDir, { recursive: true });
  const schemaVersion = options.schemaVersion ?? 5;
  const f = {
    ...source,
    runDir,
    runUuid: randomUUID(),
    board: {
      schemaVersion,
      canonicalVersion: schemaVersion === 6 ? 'qa-board-teamwork/v2' : 'qa-board-teamwork/v1',
      ...(schemaVersion === 6 ? { boardKind: 'team-qa-board', sourceItems: [] } : {}),
      rev: 1,
      boardId: `session3-${name}`,
      title: 'Bảng kiểm chứng giao diện đã làm sạch',
      boardCreated: '2026-08-24T00:30:00.000Z',
      language: 'vi', deepCheck: 'available', app: 'fixture-app', envDb: 'TEST fixture DB',
      viewport: '1280x800', currentRound: 1,
      runUuid: null,
      commit: source.head,
      build: 'fixture-build', env: 'TEST', db: 'fixture-db', role: 'qa-agent', testProfile: 'release-truth-v2',
      vision: { version: 2, assertions: [] },
      cases: [], defects: [],
      rounds: [{ round: 1, startedAt: '2026-08-24T00:30:00.000Z', scope: 'Kiểm chứng sự cố giao diện đã làm sạch' }],
      coverage: coverage(), untested: [], release: { verdict: 'GO', risks: [] }, evidenceManifest: [],
    },
  };
  f.board.runUuid = f.runUuid;
  f.boardPath = join(runDir, 'board.json');
  return f;
}

function writeBoard(f) {
  writeJson(f.boardPath, f.board);
}

function gateArgs(f) {
  return [
    GATE, f.boardPath,
    '--plan', f.planPath,
    '--requirements', f.graphPath,
    '--repo', f.repo,
    '--evidence-root', f.runDir,
  ];
}

function runGate(f) {
  return run(process.execPath, gateArgs(f), { cwd: f.runDir });
}

function receiptPath(f) {
  return join(f.runDir, '.teamcode', 'runs', f.runUuid, 'receipts', 'qa-gui.receipt.json');
}

test('Session 3 contract bundle is byte-identical to the frozen shared contract', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'contracts/release-truth-contract/v2/CONTRACT.json'), 'utf8'));
  assert.equal(manifest.contract_sha256, CONTRACT_SHA);
  for (const [schema, expected] of Object.entries(manifest.schemas)) {
    const file = schema === 'qa-code/receipt/v2' ? 'qa-code.receipt.schema.json'
      : schema === 'qa-gui/receipt/v2' ? 'qa-gui.receipt.schema.json'
        : schema === 'requirements.freeze/v2' ? 'requirements.freeze.schema.json'
          : schema === 'team-code/customer-ready-receipt/v1' ? 'team-code.customer-ready-receipt.schema.json'
            : schema === 'team-code/release-receipt/v2' ? 'team-code.release-receipt.schema.json'
              : 'team-qa.receipt.schema.json';
    assert.equal(sha(readFileSync(join(ROOT, 'contracts/release-truth-contract/v2', file))), expected);
  }
});

test('I3/QGe: plan plus GUI/multi graph is the denominator and names the exact missing requirements', () => {
  const f = fixture('i3');
  const covered = GUI_IDS.slice(0, 5);
  for (const id of covered) addCase(f, id);
  writeBoard(f);
  const result = runGate(f);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  for (const id of GUI_IDS.slice(5)) assert.match(result.stderr, new RegExp(`GUI_REQUIREMENT_MISSING.*${id}`));
  for (const id of CODE_ONLY_IDS) assert.doesNotMatch(result.stderr, new RegExp(`GUI_REQUIREMENT_MISSING.*${id}`));
});

test('I5/QGa: 20/20 missing manifest files are listed and no receipt is issued', () => {
  const f = fixture('i5');
  addCase(f, GUI_IDS[0]);
  for (let index = 1; index <= 20; index += 1) {
    f.board.evidenceManifest.push({
      path: `evidence/missing-${String(index).padStart(2, '0')}.bin`,
      sha256: 'c'.repeat(64),
      evidence_type: 'code',
      metadata: evidenceMetadata(f, `TC-${GUI_IDS[0]}`, 'settled'),
    });
  }
  writeBoard(f);
  const result = runGate(f);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  for (let index = 1; index <= 20; index += 1) {
    assert.match(result.stderr, new RegExp(`EVIDENCE_MISSING.*missing-${String(index).padStart(2, '0')}\\.bin`));
  }
  assert.equal(existsSync(receiptPath(f)), false, 'invalid physical evidence must not issue a receipt');
});

test('I6/QGb: a display requirement cannot PASS on db-readback evidence', () => {
  const id = 'NG-LANGUAGE-SLOTS';
  const f = fixture('i6');
  addCase(f, id, { evidenceType: 'db-readback', rawValue: { rows: ['scrubbed'] } });
  writeBoard(f);
  const result = runGate(f);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, new RegExp(`EVIDENCE_TYPE_MISMATCH.*${id}.*db-readback`));
});

test('I11/QGf: applicationLoginNotReached is a hard UNGRADED auth precondition', () => {
  const id = GUI_IDS[0];
  const f = fixture('i11', { planData: { [id]: { auth_required: true } } });
  addCase(f, id, {
    authRequired: true,
    applicationLoginNotReached: true,
    rawValue: { authState: { applicationLoginNotReached: true } },
  });
  for (const otherId of GUI_IDS.filter((item) => item !== id)) addCase(f, otherId);
  writeBoard(f);
  const result = runGate(f);
  assert.equal(result.status, 20, result.stderr + result.stdout);
  assert.match(result.stderr, new RegExp(`AUTH_PRECONDITION_UNMET.*${id}.*applicationLoginNotReached`));
  if (existsSync(receiptPath(f))) {
    const receipt = JSON.parse(readFileSync(receiptPath(f), 'utf8'));
    assert.equal(receipt.semantic_verdict, 'UNGRADED');
  }
});

test('I13/QGc: risk dimensions require requirement-specific visual assertions and exposed UUID is FAIL', () => {
  const identityId = 'NG-LANGUAGE-SLOTS';
  const orderedId = 'OP-FIX-CA-VISIBILITY';
  let f = fixture('i13-missing', {
    risks: { [identityId]: ['stable-identity'], [orderedId]: ['ordered-setup'] },
  });
  addCase(f, identityId);
  addCase(f, orderedId);
  for (const otherId of GUI_IDS.filter((item) => ![identityId, orderedId].includes(item))) addCase(f, otherId);
  writeBoard(f);
  let result = runGate(f);
  assert.equal(result.status, 20, result.stderr + result.stdout);
  assert.match(result.stderr, new RegExp(`RISK_ASSERTION_MISSING.*${identityId}.*hidden-ui-identity`));
  assert.match(result.stderr, new RegExp(`RISK_ASSERTION_MISSING.*${orderedId}.*same-session-mutation-read`));
  assert.match(result.stderr, new RegExp(`RISK_ASSERTION_MISSING.*${orderedId}.*fresh-load`));

  f = fixture('i13-uuid', { risks: { [identityId]: ['stable-identity'] } });
  const state = 'settled';
  const screenshot = `evidence/TC-${identityId}-${state}.png`;
  addCase(f, identityId, {
    riskAssertions: [{
      assertion_id: 'RISK-HIDDEN-ID', requirement_id: identityId,
      risk_dimension: 'stable-identity', scenario: 'hidden-ui-identity', verdict: 'PASS',
      evidence_ref: screenshot, evidence_type: 'gui-screenshot',
      observed_internal_identifiers: ['123e4567-e89b-12d3-a456-426614174000'],
    }],
  });
  for (const otherId of GUI_IDS.filter((item) => item !== identityId)) addCase(f, otherId);
  writeBoard(f);
  result = runGate(f);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /INTERNAL_ID_EXPOSED.*123e4567-e89b-12d3-a456-426614174000/);
});

test('I14/QGg: v2 verifier rejects task base, source revision and lane mismatches', () => {
  const f = fixture('i14');
  const receiptFile = join(f.runDir, 'wrong-bindings.receipt.json');
  writeJson(receiptFile, seal({
    schema: 'qa-gui/receipt/v2', contract_sha256: CONTRACT_SHA, run_uuid: f.runUuid,
    task_base: f.head, source_revision: 'foreign-revision', exact_final_sha: f.head,
    requirements_hash: sha(canonicalJson(f.graph)), verification_lane: 'code',
    execution_status: 'completed', semantic_verdict: 'UNGRADED', atomic_coverage: [],
    evidence_manifest: [], created_at: '2026-08-24T01:00:00.000Z',
  }));
  const result = run(process.execPath, [
    VERIFY, '--receipt', receiptFile, '--repo', f.repo,
    '--requirements', f.graphPath, '--evidence-root', f.runDir,
  ], { cwd: f.runDir });
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /TASK_BASE_MISMATCH/);
  assert.match(result.stderr + result.stdout, /SOURCE_REVISION_MISMATCH/);
  assert.match(result.stderr + result.stdout, /VERIFICATION_LANE_MISMATCH/);
});

test('QGh: release-truth v2 never passes a board whose cases are all TODO, and GO with a TODO case is UNGRADED', () => {
  const f = fixture('qgh-todo', { schemaVersion: 6 });
  for (const id of GUI_IDS) addCase(f, id);
  for (const entry of f.board.cases) entry.status = 'TODO';
  writeBoard(f);
  let result = runGate(f);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /UNGRADED CASES_NOT_EXECUTED/);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
  assert.equal(existsSync(receiptPath(f)), false);

  const g = fixture('qgh-go-todo', { schemaVersion: 6 });
  for (const id of GUI_IDS) addCase(g, id);
  g.board.cases.push({ ...structuredClone(g.board.cases[0]), id: 'TC-TODO', status: 'TODO' });
  writeBoard(g);
  result = runGate(g);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /UNGRADED RELEASE_GO_WITH_TODO_CASES:TC-TODO/);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
});

test('QGg: a schema-6 gate-issued v2 receipt verifies, then becomes stale after repository HEAD moves', () => {
  const f = fixture('qgg-valid', { schemaVersion: 6 });
  for (const id of GUI_IDS) addCase(f, id);
  writeBoard(f);
  let result = runGate(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receiptFile = receiptPath(f);
  assert.equal(existsSync(receiptFile), true);
  result = run(process.execPath, [
    VERIFY, '--receipt', receiptFile, '--repo', f.repo,
    '--requirements', f.graphPath, '--evidence-root', f.runDir,
  ], { cwd: f.runDir });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  writeFileSync(join(f.repo, 'src', 'after-receipt.js'), 'export const laterHead = true;\n');
  git(f.repo, ['add', '.']);
  git(f.repo, ['commit', '-qm', 'later head']);
  result = run(process.execPath, [
    VERIFY, '--receipt', receiptFile, '--repo', f.repo,
    '--requirements', f.graphPath, '--evidence-root', f.runDir,
  ], { cwd: f.runDir });
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /RECEIPT_STALE/);
});

test('Release A A2: receipt rows bind requirement, tracked case and state evidence', () => {
  const f = fixture('release-a-case-binding', { schemaVersion: 6 });
  for (const id of GUI_IDS) addCase(f, id);
  writeBoard(f);
  let result = runGate(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const receiptFile = receiptPath(f);
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  assert.deepEqual(
    receipt.atomic_coverage.map((row) => row.case_id),
    GUI_IDS.map((id) => `TC-${id}`),
  );
  for (const row of receipt.atomic_coverage) {
    const evidence = receipt.evidence_manifest.find((entry) => entry.path === row.evidence_ref);
    assert.equal(evidence?.metadata?.case_id, row.case_id);
    assert.equal(typeof evidence?.metadata?.state, 'string');
    assert.notEqual(evidence.metadata.state, '');
  }

  const foreignRows = structuredClone(receipt.atomic_coverage);
  foreignRows[0].case_id = 'TC-FOREIGN-CASE';
  writeJson(receiptFile, seal({ ...receipt, atomic_coverage: foreignRows }));
  result = run(process.execPath, [
    VERIFY, '--receipt', receiptFile, '--repo', f.repo,
    '--requirements', f.graphPath, '--evidence-root', f.runDir,
  ], { cwd: f.runDir });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /ATOMIC_CASE_NOT_IN_PLAN:TC-FOREIGN-CASE/);

  const crossCaseRows = structuredClone(receipt.atomic_coverage);
  crossCaseRows[0].case_id = `TC-${GUI_IDS[1]}`;
  writeJson(receiptFile, seal({ ...receipt, atomic_coverage: crossCaseRows }));
  result = run(process.execPath, [
    VERIFY, '--receipt', receiptFile, '--repo', f.repo,
    '--requirements', f.graphPath, '--evidence-root', f.runDir,
  ], { cwd: f.runDir });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /ATOMIC_CASE_REQUIREMENT_MISMATCH|ATOMIC_EVIDENCE_CASE_MISMATCH/);
});

test('I19/QGa-QGb: traversal, symlink escape and forged metadata commit are rejected', () => {
  const id = GUI_IDS[0];
  const f = fixture('i19');
  addCase(f, id, { screenshotMetadata: { commit: f.base } });
  const outside = join(f.root, 'outside.json');
  writeJson(outside, { scrubbed: true });
  const linkRel = 'evidence/escape-link.json';
  symlinkSync(outside, join(f.runDir, linkRel));
  f.board.evidenceManifest.push({
    path: linkRel,
    sha256: sha(readFileSync(outside)),
    evidence_type: 'code',
    metadata: evidenceMetadata(f, `TC-${id}`, 'settled'),
  });
  f.board.evidenceManifest.push({
    path: '../outside.json',
    sha256: sha(readFileSync(outside)),
    evidence_type: 'code',
    metadata: evidenceMetadata(f, `TC-${id}`, 'settled'),
  });
  writeBoard(f);
  const result = runGate(f);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /EVIDENCE_PATH_TRAVERSAL.*\.\.\/outside\.json/);
  assert.match(result.stderr, /EVIDENCE_SYMLINK.*escape-link\.json/);
  assert.match(result.stderr, /EVIDENCE_METADATA_COMMIT_MISMATCH/);
});

test('I20/QGd: synchronous cases need no 120s dwell; polling risks catch repeated GET failures', () => {
  const syncId = GUI_IDS[0];
  let f = fixture('i20-sync');
  addCase(f, syncId);
  for (const id of GUI_IDS.slice(1)) addCase(f, id);
  writeBoard(f);
  let result = runGate(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const pollingId = GUI_IDS[0];
  f = fixture('i20-polling', {
    risks: { [pollingId]: ['live-projection-cache'] },
    planData: { [pollingId]: { settling: { required: true, kind: 'background-polling', window_ms: 120000 } } },
  });
  addCase(f, pollingId, {
    network: [
      { method: 'GET', url: 'https://fixture.invalid/api/poll', status: 401, ts: '2026-08-24T01:00:00.000Z' },
      { method: 'GET', url: 'https://fixture.invalid/api/poll', status: 401, ts: '2026-08-24T01:01:00.000Z' },
      { method: 'GET', url: 'https://fixture.invalid/api/poll', status: 401, ts: '2026-08-24T01:02:00.000Z' },
    ],
    failedRequests: 0,
  });
  for (const id of GUI_IDS.slice(1)) addCase(f, id);
  writeBoard(f);
  result = runGate(f);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /DWELL_REPEATED_REQUEST_FAILURE.*GET.*401/);
  assert.match(result.stderr, /NETWORK_SUMMARY_MISMATCH.*failed_requests.*0.*3/);
});

test('QGg: v1 receipt stays legacy-readable and reports missing v2 capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-gui-session3-v1-'));
  roots.push(root);
  const receiptFile = join(root, 'legacy.receipt.json');
  writeJson(receiptFile, seal({
    schema: 'qa-gui/receipt/v1', run_uuid: randomUUID(), commit: 'a'.repeat(40),
    build: 'legacy-build', env: 'TEST', db: 'fixture-db', role: 'qa-agent', test_profile: 'legacy',
    cases: [], evidence_manifest: [], function_verdict: 'PASS', ui_verdict: 'PASS',
    execution_status: 'completed', semantic_verdict: 'PASS', created_at: '2026-08-24T01:00:00.000Z',
  }));
  const result = run(process.execPath, [VERIFY, '--receipt', receiptFile]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /CAPABILITY_MISSING:release-truth-v2/);
});
