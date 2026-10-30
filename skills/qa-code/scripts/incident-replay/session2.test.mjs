import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GATE0,
  QA_RUN,
  RECEIPT_VERIFY,
  ROOT,
  canonicalJson,
  git,
  readJson,
  run,
  seal,
  verdict,
  writeEngine,
  writeJson,
} from './helpers.mjs';
import { createQaReceipt } from '../lib/release-receipt.mjs';

const CONTRACT_SHA = '77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c';
const CODE_IDS = [
  'P3-T01', 'P3-T02', 'P3-T03', 'P3-T04', 'P3-T05', 'P3-T06', 'P3-T07', 'P3-T08',
  'P3-T09', 'P3-T10', 'P3-T11', 'P3-T12', 'P3-T13', 'P3-T14', 'P3-T15', 'P3-T16',
  'P3-T17', 'OP-FIX-RECORDING', 'OP-FIX-SAVE-STATE', 'OP-FIX-INPUT-CATALOG',
  'NG-REPORTING', 'NG-LANGUAGE-SLOTS',
];
const GUI_IDS = [
  'OP-FIX-CA-VISIBILITY', 'OP-FIX-ACCESS-DEDUPE', 'OP-RETEST-06914',
  'OP-PRESET-SOURCE', 'NG-SHARED-LISTS', 'NG-EDITOR-WORDING', 'NG-PRODUCTION-WRITE',
];
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `qa-code-session2-${name}-`));
  roots.push(root);
  return root;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requirement(id, verificationLane) {
  return {
    id,
    expectation: `Scrubbed incident acceptance for ${id}`,
    requirement_owner: 'fixture',
    verification_lane: verificationLane,
    risk_dimensions: [],
    acceptance_ids: [`A-${id}`],
    evidence_contract: {
      allowed_types: ['test-log'],
      atomic: true,
      multi_evidence: false,
    },
  };
}

function scannerStubs(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const gitleaks = join(bin, 'gitleaks');
  writeFileSync(gitleaks, `#!/bin/sh
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "version" ]; then echo "gitleaks 9.9.9"; exit 0; fi
while [ "$#" -gt 0 ]; do if [ "$1" = "--report-path" ]; then report="$2"; shift 2; else shift; fi; done
printf '[]' > "$report"
`);
  chmodSync(gitleaks, 0o755);
  const semgrep = join(bin, 'semgrep');
  writeFileSync(semgrep, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "semgrep 1.99.0"; exit 0; fi
printf '{"results":[]}'
`);
  chmodSync(semgrep, 0o755);
  return bin;
}

function makeGraphRepo(name, {
  mapCount = CODE_IDS.length,
  graphThreshold = 0,
  configThreshold = graphThreshold,
  umbrella = false,
  contractSha = CONTRACT_SHA,
} = {}) {
  const root = fixture(name);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(repo, 'brief'), { recursive: true });
  run('git', ['init', '-q'], { cwd: repo });
  run('git', ['config', 'user.email', 'qa@example.invalid'], { cwd: repo });
  run('git', ['config', 'user.name', 'QA'], { cwd: repo });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'src', 'feature.mjs'), 'export const enabled = false;\n');
  writeFileSync(
    join(repo, 'test', 'regression.test.mjs'),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { enabled } from '../src/feature.mjs'; test('type stays boolean', () => assert.equal(typeof enabled, 'boolean'));\n",
  );
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-qm', 'base'], { cwd: repo });
  const base = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(repo, 'src', 'feature.mjs'), 'export const enabled = true;\n');
  const mappings = [];
  for (const [index, id] of CODE_IDS.slice(0, mapCount).entries()) {
    const file = `test/assertion-${String(index + 1).padStart(2, '0')}.test.mjs`;
    writeFileSync(
      join(repo, file),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { enabled } from '../src/feature.mjs'; test('feature enabled', () => assert.equal(enabled, true));\n",
    );
    mappings.push({
      requirement_id: id,
      assertion_id: `ASSERT-${String(index + 1).padStart(2, '0')}`,
      fail_to_pass: [file],
      pass_to_pass: ['test/regression.test.mjs'],
    });
  }
  if (umbrella) {
    mappings.splice(0, mappings.length, {
      requirement_id: 'OP-PHASE3-DEFECTS',
      assertion_id: 'ASSERT-UMBRELLA',
      fail_to_pass: ['test/assertion-01.test.mjs'],
      pass_to_pass: ['test/regression.test.mjs'],
    });
  }
  const graph = {
    schema: 'requirements.freeze/v2',
    contract_sha256: contractSha,
    repo: realpathSync(repo),
    task_base: base,
    source_revision: 'incident-phase3-scrubbed-r1',
    gate_policy: { coverage_threshold: graphThreshold, required_layers: ['code'] },
    requirements: [
      ...CODE_IDS.map((id, index) => requirement(id, index % 5 === 0 ? 'multi' : 'code')),
      ...GUI_IDS.map((id) => requirement(id, 'gui')),
    ],
  };
  const graphPath = join(repo, 'brief', 'REQUIREMENTS.json');
  writeJson(graphPath, graph);
  const lock = {
    schema: 'team-code/brief-lock/v3',
    frozen_at: '2026-08-24T00:00:00.000Z',
    files: { 'REQUIREMENTS.json': sha(readFileSync(graphPath)) },
    acceptance_registry_sha256: 'a'.repeat(64),
    task_base: base,
    source_revision: graph.source_revision,
    gate_policy: graph.gate_policy,
    exact_final_sha: null,
  };
  const lockPath = join(repo, 'brief', 'LOCK.json');
  writeJson(lockPath, lock);
  const config = {
    coverage: { threshold: configThreshold, testFiles: ['test/regression.test.mjs'] },
    acceptance: { requirements: mappings },
  };
  const configPath = join(repo, 'qa-code.config.json');
  writeJson(configPath, config);
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-qm', 'final'], { cwd: repo });
  const head = git(repo, ['rev-parse', 'HEAD']);
  return {
    root,
    repo,
    base,
    head,
    bin: scannerStubs(root),
    graph,
    graphPath,
    lockPath,
    config,
    configPath,
    output: join(root, 'gate0.json'),
  };
}

function gateArgs(f, base = f.base) {
  return [
    GATE0,
    '--repo', f.repo,
    '--base', base,
    '--config', f.configPath,
    '--requirements', f.graphPath,
    '--cve-cmd', "printf '{\"results\":[]}'",
    '--json', f.output,
  ];
}

function gateEnv(f) {
  return {
    ...process.env,
    QA_CODE_NODE: process.execPath,
    PATH: `${f.bin}:/usr/bin:/bin`,
    HOME: f.root,
  };
}

function graphGate(f, overrides = {}) {
  return seal({
    schema: 'qa-code/gate0/v1',
    status: 'pass',
    repo: realpathSync(f.repo),
    base: f.base,
    base_requested: f.base,
    commit: f.head,
    run_uuid: randomUUID(),
    created_at: '2026-08-24T00:00:00.000Z',
    contract_sha256: CONTRACT_SHA,
    requirements_hash: sha(canonicalJson(f.graph)),
    source_revision: f.graph.source_revision,
    verification_lane: 'code',
    requirements: {
      path: realpathSync(f.graphPath),
      sha256: sha(canonicalJson(f.graph)),
      code_ids: CODE_IDS,
    },
    acceptance: {
      status: 'pass',
      results: CODE_IDS.map((id, index) => ({
        requirement_id: id,
        assertion_id: `ASSERT-${String(index + 1).padStart(2, '0')}`,
        case_id: `A-${id}`,
        covered: true,
        fail_to_pass: { base: { outcome: 'fail' }, head: { outcome: 'pass' } },
        pass_to_pass: { base: { outcome: 'pass' }, head: { outcome: 'pass' } },
      })),
      coverage: { covered: CODE_IDS.length, total: CODE_IDS.length, ids: CODE_IDS },
      missing_ids: [],
    },
    requirement_coverage: { covered: CODE_IDS.length, total: CODE_IDS.length, ids: CODE_IDS },
    layers: {},
    ...overrides,
  });
}

function v2Receipt(f, gate, gatePath, overrides = {}) {
  const gateHash = sha(readFileSync(gatePath));
  return seal({
    schema: 'qa-code/receipt/v2',
    contract_sha256: CONTRACT_SHA,
    run_uuid: gate.run_uuid,
    repo: realpathSync(f.repo),
    task_base: f.base,
    source_revision: f.graph.source_revision,
    head: f.head,
    requirements_hash: sha(canonicalJson(f.graph)),
    verification_lane: 'code',
    execution_status: 'completed',
    semantic_verdict: 'PASS',
    tier: 'FULL',
    tampering: false,
    skipped_layers: [],
    atomic_coverage: CODE_IDS.map((id, index) => ({
      requirement_id: id,
      assertion_id: `ASSERT-${String(index + 1).padStart(2, '0')}`,
      case_id: `A-${id}`,
      test_or_check: `test/assertion-${String(index + 1).padStart(2, '0')}.test.mjs`,
      evidence_ref: gatePath,
      evidence_sha256: gateHash,
      result: 'PASS',
    })),
    created_at: '2026-08-24T00:00:00.000Z',
    ...overrides,
  });
}

test('Session 2 contract bundle is byte-identical to the frozen Team-code contract', () => {
  const manifest = readJson(join(ROOT, 'contracts', 'release-truth-contract', 'v2', 'CONTRACT.json'));
  assert.equal(manifest.contract_sha256, CONTRACT_SHA);
  for (const [schema, expected] of Object.entries(manifest.schemas)) {
    const file = schema === 'qa-code/receipt/v2' ? 'qa-code.receipt.schema.json'
      : schema === 'qa-gui/receipt/v2' ? 'qa-gui.receipt.schema.json'
        : schema === 'requirements.freeze/v2' ? 'requirements.freeze.schema.json'
          : schema === 'team-code/customer-ready-receipt/v1' ? 'team-code.customer-ready-receipt.schema.json'
            : schema === 'team-code/release-receipt/v2' ? 'team-code.release-receipt.schema.json'
              : 'team-qa.receipt.schema.json';
    assert.equal(sha(readFileSync(join(ROOT, 'contracts', 'release-truth-contract', 'v2', file))), expected);
  }
});

test('I2/QCa: graph denominator is 22 code-lane requirements and umbrella IDs are rejected', () => {
  const f = makeGraphRepo('i2-partial', { mapCount: 9 });
  let result = run('bash', gateArgs(f), { env: gateEnv(f) });
  assert.equal(result.status, 1, result.stderr);
  const gate = readJson(f.output);
  assert.deepEqual(gate.requirement_coverage, {
    covered: 9,
    total: 22,
    ids: CODE_IDS.slice(0, 9),
  });
  assert.deepEqual(gate.acceptance.missing_ids, CODE_IDS.slice(9));

  const umbrella = makeGraphRepo('i2-umbrella', { mapCount: 1, umbrella: true });
  result = run('bash', gateArgs(umbrella), { env: gateEnv(umbrella) });
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /REQUIREMENT_NOT_IN_GRAPH.*OP-PHASE3-DEFECTS/);
});

test('I8/QCb: a caller cannot lower the frozen threshold', () => {
  const f = makeGraphRepo('i8-threshold', {
    mapCount: 1,
    graphThreshold: 80,
    configThreshold: 0,
  });
  const result = run('bash', gateArgs(f), { env: gateEnv(f) });
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /COVERAGE_THRESHOLD_DOWNGRADE.*80.*0/);
});

test('I14/QCb: exact HEAD does not excuse a later base, wrong source revision, or wrong lane', () => {
  const f = makeGraphRepo('i14-bindings', { mapCount: 1 });
  let result = run('bash', gateArgs(f, f.head), { env: gateEnv(f) });
  assert.equal(result.status, 20);
  assert.match(result.stderr + result.stdout, /TASK_BASE_MISMATCH/);

  writeJson(f.configPath, { ...f.config, source_revision: 'foreign-revision' });
  result = run('bash', gateArgs(f), { env: gateEnv(f) });
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /SOURCE_REVISION_MISMATCH/);

  writeJson(f.configPath, {
    ...f.config,
    source_revision: f.graph.source_revision,
    verification_lane: 'gui',
  });
  result = run('bash', gateArgs(f), { env: gateEnv(f) });
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /VERIFICATION_LANE_MISMATCH/);
});

test('I7/I18/QCc-QCe: v2 verifier catches stale HEAD and covered IDs without atomic evidence', () => {
  const f = makeGraphRepo('i7-i18', { mapCount: CODE_IDS.length });
  const gate = graphGate(f);
  const gatePath = join(f.root, 'bound-gate0.json');
  const receiptPath = join(f.root, 'qa-code.receipt.json');
  writeJson(gatePath, gate);

  writeJson(receiptPath, v2Receipt(f, gate, gatePath, { atomic_coverage: [] }));
  let result = run(process.execPath, [
    RECEIPT_VERIFY,
    '--receipt', receiptPath,
    '--gate0', gatePath,
    '--repo', f.repo,
    '--base', f.base,
  ]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /ATOMIC_COVERAGE_MISSING|atomic_coverage/);

  const staleGate = seal({ ...gate, commit: f.base });
  writeJson(gatePath, staleGate);
  writeJson(receiptPath, v2Receipt(f, staleGate, gatePath, { head: f.base }));
  result = run(process.execPath, [
    RECEIPT_VERIFY,
    '--receipt', receiptPath,
    '--gate0', gatePath,
    '--repo', f.repo,
    '--base', f.base,
  ]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /RECEIPT_STALE/);
});

test('QCe: a valid v1 receipt remains legacy-readable but advertises missing v2 capability', () => {
  const root = fixture('qce-v1');
  const receiptPath = join(root, 'legacy.receipt.json');
  writeJson(receiptPath, seal({
    schema: 'qa-code/receipt/v1',
    run_uuid: randomUUID(),
    repo: root,
    task_base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    diff_sha256: 'c'.repeat(64),
    gate0_sha256: 'd'.repeat(64),
    execution_status: 'completed',
    semantic_verdict: 'PASS-STATIC',
    mode: 'static',
    tier: 'STATIC',
    engine: 'grok-4.5',
    engine_vendor: 'xai',
    engine_injected: true,
    tool_log: [],
    requirement_coverage: { covered: 1, total: 1, ids: ['LEGACY-1'] },
    created_at: '2026-08-24T00:00:00.000Z',
  }));
  const result = run(process.execPath, [RECEIPT_VERIFY, '--receipt', receiptPath]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /CAPABILITY_MISSING:release-truth-v2/);
});

test('QCd: tampering and an unlocked skipped layer can only emit UNGRADED v2 receipts', () => {
  const f = makeGraphRepo('qcd', { mapCount: CODE_IDS.length });
  const gatePath = join(f.root, 'gate-pass.json');
  const verdictPath = join(f.root, 'verdict.json');
  const receiptPath = join(f.root, 'receipt.json');
  const enginePath = join(f.root, 'tamper-engine.mjs');
  const gate = graphGate(f);
  writeJson(gatePath, gate);
  const candidate = verdict({ head: f.head });
  const engineCmd = writeEngine(enginePath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(f.repo, 'src', 'tampered.js'))}, 'export const tampered = true;\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(candidate))});
`);
  let result = run('bash', [
    QA_RUN,
    '--repo', f.repo,
    '--mode', 'static',
    '--gate0', gatePath,
    '--base', f.base,
    '--json', verdictPath,
    '--receipt', receiptPath,
    '--engine-cmd', engineCmd,
    '--engine', 'grok-4.5',
  ]);
  assert.equal(result.status, 20, result.stderr);
  let receipt = readJson(receiptPath);
  assert.equal(receipt.schema, 'qa-code/receipt/v2');
  assert.equal(receipt.tampering, true);
  assert.equal(receipt.semantic_verdict, 'UNGRADED');

  rmSync(join(f.repo, 'src', 'tampered.js'), { force: true });
  writeJson(gatePath, gate);
  const cleanEngine = writeEngine(enginePath, candidate);
  result = run('bash', [
    QA_RUN,
    '--repo', f.repo,
    '--mode', 'static',
    '--gate0', gatePath,
    '--base', f.base,
    '--json', verdictPath,
    '--receipt', receiptPath,
    '--engine-cmd', cleanEngine,
    '--engine', 'grok-4.5',
  ]);
  assert.equal(result.status, 20, result.stderr);
  receipt = readJson(receiptPath);
  assert.equal(receipt.tampering, true);
  assert.equal(receipt.semantic_verdict, 'UNGRADED');

  const skippedGate = graphGate(f, {
    layers: { prompt_injection: { status: 'skipped', tool: 'qa-code-injection', findings: [], notes: [] } },
  });
  writeJson(gatePath, skippedGate);
  result = run('bash', [
    QA_RUN,
    '--repo', f.repo,
    '--mode', 'static',
    '--gate0', gatePath,
    '--base', f.base,
    '--json', verdictPath,
    '--receipt', receiptPath,
    '--engine-cmd', cleanEngine,
    '--engine', 'grok-4.5',
  ]);
  assert.equal(result.status, 20, result.stderr);
  receipt = readJson(receiptPath);
  assert.equal(receipt.schema, 'qa-code/receipt/v2');
  assert.equal(receipt.semantic_verdict, 'UNGRADED');
  assert.match(receipt.skipped_layers[0].reason, /UNLOCKED_SKIP_REASON/);
});

test('Release A A1: producer and verifier bind every atomic row to a canonical case', () => {
  const f = makeGraphRepo('release-a-case-binding', { mapCount: CODE_IDS.length });
  const rawGate = graphGate(f);
  const gate = seal({
    ...rawGate,
    acceptance: {
      ...rawGate.acceptance,
      requirements: CODE_IDS.map((id, index) => ({
        id,
        requirement_id: id,
        assertion_id: `ASSERT-${String(index + 1).padStart(2, '0')}`,
        case_id: `A-${id}`,
        fail_to_pass: [`test/assertion-${String(index + 1).padStart(2, '0')}.test.mjs`],
        pass_to_pass: ['test/regression.test.mjs'],
      })),
      results: rawGate.acceptance.results.map((row) => ({
        ...row,
        case_id: `A-${row.requirement_id}`,
      })),
    },
  });
  const gatePath = join(f.root, 'release-a-gate0.json');
  const receiptPath = join(f.root, 'release-a-qa-code.receipt.json');
  writeJson(gatePath, gate);

  const produced = createQaReceipt({
    gate0: gate,
    gate0Path: gatePath,
    repo: f.repo,
    taskBase: f.base,
    head: f.head,
    executionStatus: 'completed',
    semanticVerdict: 'PASS',
    mode: 'tools',
    engine: 'fixture-engine',
    engineInjected: true,
    toolLog: [],
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  assert.deepEqual(
    produced.atomic_coverage.map((row) => row.case_id),
    CODE_IDS.map((id) => `A-${id}`),
  );
  writeJson(receiptPath, produced);
  let result = run(process.execPath, [
    RECEIPT_VERIFY,
    '--receipt', receiptPath,
    '--gate0', gatePath,
    '--repo', f.repo,
    '--base', f.base,
  ]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const mutatedRows = structuredClone(produced.atomic_coverage);
  mutatedRows[0].case_id = 'A-FOREIGN-CASE';
  writeJson(receiptPath, seal({ ...produced, atomic_coverage: mutatedRows }));
  result = run(process.execPath, [
    RECEIPT_VERIFY,
    '--receipt', receiptPath,
    '--gate0', gatePath,
    '--repo', f.repo,
    '--base', f.base,
  ]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /ATOMIC_CASE_NOT_IN_REQUIREMENT:P3-T01:A-FOREIGN-CASE/);
});
