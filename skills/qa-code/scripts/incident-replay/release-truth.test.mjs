import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE0,
  QA_RUN,
  RECEIPT_VERIFY,
  ROOT,
  VALIDATOR,
  gate0Receipt,
  makeRepo,
  qaArgs,
  readJson,
  run,
  verdict,
  writeEngine,
  writeJson,
} from './helpers.mjs';
import { parseGrokToolLog, sealObject, verifyObjectIntegrity } from '../lib/release-receipt.mjs';

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `qa-code-${name}-`));
  roots.push(root);
  return root;
}

function qaFixture(name, options = {}) {
  const root = fixture(name);
  const source = makeRepo(root, options);
  const gatePath = join(root, 'gate0.json');
  const verdictPath = join(root, 'verdict.json');
  const receiptPath = join(root, 'qa-code.receipt.json');
  const enginePath = join(root, 'engine.mjs');
  const gate = gate0Receipt(source);
  writeJson(gatePath, gate);
  const candidate = verdict({ head: source.head, ...options });
  const engineCmd = writeEngine(enginePath, candidate);
  return { root, ...source, gate, gatePath, verdictPath, receiptPath, enginePath, engineCmd, candidate };
}

test('QC1/QC4: machine receipt is strict, sealed, and bound to gate0 bytes', () => {
  const f = qaFixture('qc1');
  const result = run('bash', qaArgs(f));
  assert.equal(result.status, 0, result.stderr);
  const receipt = readJson(f.receiptPath);
  assert.equal(receipt.schema, 'qa-code/receipt/v1');
  assert.equal(receipt.task_base, f.base);
  assert.equal(receipt.head, f.head);
  assert.equal(receipt.engine_injected, true);
  assert.match(receipt.integrity, /^[0-9a-f]{64}$/);

  let checked = run(process.execPath, [
    RECEIPT_VERIFY, '--receipt', f.receiptPath, '--gate0', f.gatePath,
    '--repo', f.repo, '--base', f.base,
  ]);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);

  const tampered = { ...receipt, created_at: '2026-08-18T00:00:00.000Z' };
  writeJson(f.receiptPath, tampered);
  checked = run(process.execPath, [RECEIPT_VERIFY, '--receipt', f.receiptPath, '--gate0', f.gatePath]);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr + checked.stdout, /integrity/i);

  writeJson(f.receiptPath, { ...receipt, unexpected: true });
  checked = run(process.execPath, [RECEIPT_VERIFY, '--receipt', f.receiptPath]);
  assert.equal(checked.status, 20);
  assert.match(checked.stderr + checked.stdout, /unknown field.*unexpected/i);

  writeJson(f.receiptPath, receipt);
  writeJson(f.gatePath, { ...f.gate, status: 'fail' });
  checked = run(process.execPath, [RECEIPT_VERIFY, '--receipt', f.receiptPath, '--gate0', f.gatePath]);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr + checked.stdout, /gate0_sha256|gate0.*hash/i);

  const inconsistent = sealObject({
    ...receipt,
    mode: 'tools',
    tier: 'STATIC',
    semantic_verdict: 'PASS',
    engine_vendor: 'anthropic',
    tool_log: [],
  });
  writeJson(f.receiptPath, inconsistent);
  checked = run(process.execPath, [RECEIPT_VERIFY, '--receipt', f.receiptPath]);
  assert.equal(checked.status, 20);
  assert.match(checked.stdout + checked.stderr, /tier|engine_vendor|tool_log/i);
});

test('QC2/L26: --base is mandatory and verdict.commit must equal current HEAD', () => {
  const f = qaFixture('qc2');
  const missingBase = qaArgs(f);
  missingBase.splice(missingBase.indexOf('--base'), 2);
  let result = run('bash', missingBase);
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr + result.stdout, /UNGRADED|missing --base/i);

  f.candidate.commit = f.base;
  f.engineCmd = writeEngine(f.enginePath, f.candidate);
  result = run('bash', qaArgs(f));
  assert.equal(result.status, 20, result.stderr);
  assert.equal(readJson(f.receiptPath).semantic_verdict, 'UNGRADED');
});

test('QC3/A02/A20: semantic FAIL exits 1; ten empty outputs exit 20', () => {
  const f = qaFixture('qc3', { verdict: 'FAIL' });
  let result = run('bash', qaArgs(f));
  assert.equal(result.status, 1, result.stderr);
  let receipt = readJson(f.receiptPath);
  assert.equal(receipt.execution_status, 'completed');
  assert.equal(receipt.semantic_verdict, 'FAIL');

  f.engineCmd = writeEngine(f.enginePath, '');
  for (let index = 0; index < 10; index += 1) {
    f.receiptPath = join(f.root, `empty-${index}.receipt.json`);
    f.verdictPath = join(f.root, `empty-${index}.verdict.json`);
    result = run('bash', qaArgs(f));
    assert.equal(result.status, 20, `run ${index}: ${result.stderr}`);
    receipt = readJson(f.receiptPath);
    assert.equal(receipt.semantic_verdict, 'UNGRADED');
  }
});

test('QC4/H22: foreign-repo and stale-head Gate 0 receipts are rejected before engine', () => {
  const f = qaFixture('qc4');
  const other = makeRepo(f.root, { name: 'other' });
  writeJson(f.gatePath, gate0Receipt(other));
  let result = run('bash', qaArgs(f));
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr + result.stdout, /repo|binding/i);

  writeJson(f.gatePath, gate0Receipt({ repo: f.repo, base: f.base, head: f.base }));
  result = run('bash', qaArgs(f));
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr + result.stdout, /HEAD|commit|binding/i);
});

test('QC5/A21: injected engine is permanently stamped in the machine receipt', () => {
  const f = qaFixture('qc5');
  const result = run('bash', qaArgs(f));
  assert.equal(result.status, 0, result.stderr);
  const receipt = readJson(f.receiptPath);
  assert.equal(receipt.engine_injected, true);
  writeJson(f.receiptPath, { ...receipt, engine_injected: false });
  const checked = run(process.execPath, [RECEIPT_VERIFY, '--receipt', f.receiptPath]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout + checked.stderr, /integrity/i);
});

test('QC6: tools PASS without machine-observed tool calls is downgraded to UNGRADED', () => {
  const f = qaFixture('qc6', { mode: 'tools', verdict: 'PASS' });
  const result = run('bash', qaArgs({ ...f, mode: 'tools' }));
  assert.equal(result.status, 20, result.stderr);
  const receipt = readJson(f.receiptPath);
  assert.equal(receipt.semantic_verdict, 'UNGRADED');
  assert.deepEqual(receipt.tool_log, []);

  const updates = [
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'plan', title: 'todo_write', rawInput: {} } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', rawInput: { target_file: '/repo/src/app.js' } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'test', title: 'run_terminal_command', rawInput: { command: 'node --test test/app.test.mjs' } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'test', status: 'completed' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'secret', title: 'run_terminal_command', rawInput: { command: 'example-client --header "Authorization: Bearer fixture-value" https://example.invalid?token=fixture-value --api-key fixture-value' } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'secret', status: 'completed' } } },
  ].map((item) => JSON.stringify(item)).join('\n');
  assert.deepEqual(parseGrokToolLog(updates), [
    { tool: 'read_file', kind: 'read', path: '/repo/src/app.js', status: 'completed' },
    { tool: 'run_terminal_command', kind: 'test', command: 'node --test test/app.test.mjs', status: 'completed' },
    { tool: 'run_terminal_command', kind: 'command', command: 'example-client --header "Authorization: <redacted> <redacted> https://example.invalid?token=<redacted> --api-key <redacted>', status: 'completed' },
  ]);
});

test('QC7/H19: risky auth diff cannot claim NOT_APPLICABLE without a file explanation', () => {
  const root = fixture('qc7');
  const source = makeRepo(root, { risky: true });
  const gatePath = join(root, 'gate0.json');
  const verdictPath = join(root, 'verdict.json');
  const out = join(root, 'validation.json');
  writeJson(gatePath, gate0Receipt(source));
  writeJson(verdictPath, verdict({
    head: source.head,
    sweep: { S1: 'PASS', S2: 'NOT_APPLICABLE', S3: 'PASS', S4: 'PASS', S5: 'PASS' },
  }));
  const result = run(process.execPath, [
    VALIDATOR, '--verdict', verdictPath, '--gate0', gatePath,
    '--repo', source.repo, '--base', source.base, '--task-base', source.base, '--json', out,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(out, 'utf8'), /S2|sweep.*auth/i);

  const explained = verdict({
    head: source.head,
    sweep: { S1: 'PASS', S2: 'NOT_APPLICABLE', S3: 'PASS', S4: 'PASS', S5: 'PASS' },
  });
  explained.sweep_explanations = { S2: 'src/auth.js only introduces a role helper covered by review' };
  writeJson(verdictPath, explained);
  const accepted = run(process.execPath, [
    VALIDATOR, '--verdict', verdictPath, '--gate0', gatePath,
    '--repo', source.repo, '--base', source.base, '--task-base', source.base, '--json', out,
  ]);
  assert.equal(accepted.status, 0, readFileSync(out, 'utf8'));

  const contentRoot = fixture('qc7-content-risk');
  const contentSource = makeRepo(contentRoot, { extraChangedFile: 'docs/note.md' });
  const contentGate = join(contentRoot, 'gate0.json');
  const contentVerdict = join(contentRoot, 'verdict.json');
  const contentOut = join(contentRoot, 'validation.json');
  writeJson(contentGate, gate0Receipt({
    ...contentSource,
    overrides: {
      layers: {
        threat_model: {
          status: 'pass',
          triggers: ['permission'],
          trigger_files: [{ group: 'permission', file: 'src/app.js' }],
        },
      },
    },
  }));
  const unrelated = verdict({
    head: contentSource.head,
    verdict: 'PASS',
    mode: 'tools',
    sweep: { S1: 'PASS', S2: 'NOT_APPLICABLE', S3: 'PASS', S4: 'PASS', S5: 'PASS' },
  });
  unrelated.sweep_explanations = { S2: 'docs/note.md is documentation only' };
  writeJson(contentVerdict, unrelated);
  const unrelatedResult = run(process.execPath, [
    VALIDATOR, '--verdict', contentVerdict, '--gate0', contentGate,
    '--repo', contentSource.repo, '--base', contentSource.base,
    '--task-base', contentSource.base, '--json', contentOut,
  ]);
  assert.equal(unrelatedResult.status, 1);
  assert.match(readFileSync(contentOut, 'utf8'), /src\/app\.js|V-SWEEP-DIFF/);
});

test('QC8/HR3: prompt requires raw-source independence and same-vendor QA is UNGRADED', () => {
  const prompt = readFileSync(join(ROOT, 'references', 'qa-prompt.md'), 'utf8');
  assert.match(prompt, /raw source/i);
  assert.match(prompt, /build.report|build report.*claim|claim.*build report/i);
  assert.match(prompt, /previous-round PASS|verdict.*untrusted/i);

  const f = qaFixture('qc8', { coderVendor: 'xai', engine: 'grok-4.5' });
  const result = run('bash', qaArgs(f));
  assert.equal(result.status, 20, result.stderr);
  assert.equal(readJson(f.receiptPath).semantic_verdict, 'UNGRADED');
  assert.match(readFileSync(f.verdictPath, 'utf8'), /vendor|HR3/i);

  writeJson(f.verdictPath, f.candidate);
  const direct = run(process.execPath, [
    VALIDATOR, '--verdict', f.verdictPath, '--gate0', f.gatePath,
    '--repo', f.repo, '--base', f.base, '--task-base', f.base, '--json', join(f.root, 'hr3.json'),
  ]);
  assert.equal(direct.status, 20);
  assert.equal(readJson(join(f.root, 'hr3.json')).verdict_out, 'UNGRADED');

  const missing = qaFixture('qc8-missing-vendor', { omitCoderVendorSpec: true });
  writeJson(missing.verdictPath, missing.candidate);
  const missingOut = join(missing.root, 'missing-vendor.json');
  const missingResult = run(process.execPath, [
    VALIDATOR, '--verdict', missing.verdictPath, '--gate0', missing.gatePath,
    '--repo', missing.repo, '--base', missing.base, '--task-base', missing.base, '--json', missingOut,
  ]);
  assert.equal(missingResult.status, 20);
  assert.equal(readJson(missingOut).verdict_out, 'UNGRADED');
  assert.match(readFileSync(missingOut, 'utf8'), /vendor|HR3/i);
});

test('L25: malformed engine JSON is retried exactly once without an opt-in flag', () => {
  const f = qaFixture('l25');
  const state = join(f.root, 'attempt');
  const valid = JSON.stringify(f.candidate);
  f.engineCmd = writeEngine(f.enginePath, `
import { existsSync, writeFileSync } from 'node:fs';
const state = ${JSON.stringify(state)};
if (!existsSync(state)) { writeFileSync(state, '1'); process.stdout.write('{bad'); }
else process.stdout.write(${JSON.stringify(valid)});
`);
  const result = run('bash', qaArgs(f));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(f.receiptPath).semantic_verdict, 'PASS-STATIC');

  const oldFlag = [...qaArgs(f), '--retry-once'];
  const rejected = run('bash', oldFlag);
  assert.equal(rejected.status, 2);
});

function acceptanceRepo(root, failMode = 'real') {
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  let result = run('git', ['init', '-q'], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  run('git', ['config', 'user.email', 'qa@example.invalid'], { cwd: repo });
  run('git', ['config', 'user.name', 'QA'], { cwd: repo });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'src', 'feature.mjs'), 'export const enabled = false;\n');
  writeFileSync(join(repo, 'test', 'regression.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { enabled } from '../src/feature.mjs'; test('type stays boolean', () => assert.equal(typeof enabled, 'boolean'));\n");
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-qm', 'base'], { cwd: repo });
  const base = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  writeFileSync(join(repo, 'src', 'feature.mjs'), 'export const enabled = true;\n');
  const featureTest = failMode === 'empty'
    ? "import test from 'node:test'; test('empty assertion', () => {});\n"
    : failMode === 'infra'
      ? "import './missing-helper.mjs';\n"
      : "import test from 'node:test'; import assert from 'node:assert/strict'; import { enabled } from '../src/feature.mjs'; test('feature enabled', () => assert.equal(enabled, true));\n";
  writeFileSync(join(repo, 'test', 'feature.test.mjs'), featureTest);
  const config = {
    coverage: { threshold: 0, testFiles: ['test/regression.test.mjs'] },
    acceptance: { requirements: [{
      id: 'REQ-QC9',
      fail_to_pass: ['test/feature.test.mjs'],
      pass_to_pass: ['test/regression.test.mjs'],
    }] },
  };
  writeJson(join(repo, 'qa-code.config.json'), config);
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-qm', 'final'], { cwd: repo });

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
  return { repo, base, bin, config: join(repo, 'qa-code.config.json'), output: join(root, 'gate0.json') };
}

test('QC9/V4: fail-to-pass runs red on TASK_BASE and green on HEAD; empty/infra failures are rejected', () => {
  let root = fixture('qc9-good');
  let f = acceptanceRepo(root);
  let result = run('bash', [
    GATE0, '--repo', f.repo, '--base', f.base, '--config', f.config,
    '--cve-cmd', "printf '{\"results\":[]}'", '--json', f.output,
  ], { env: { ...process.env, QA_CODE_NODE: process.execPath, PATH: `${f.bin}:/usr/bin:/bin`, HOME: root } });
  let gate = readJson(f.output);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify({ status: gate.status, acceptance: gate.acceptance, layers: gate.layers }, null, 2)}`);
  assert.equal(gate.acceptance.status, 'pass');
  assert.equal(verifyObjectIntegrity(gate), true);
  assert.match(gate.run_uuid, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(gate.requirement_coverage, { covered: 1, total: 1, ids: ['REQ-QC9'] });
  assert.notEqual(gate.acceptance.results[0].fail_to_pass.base.status, 0);
  assert.equal(gate.acceptance.results[0].fail_to_pass.head.status, 0);

  root = fixture('qc9-empty');
  f = acceptanceRepo(root, 'empty');
  result = run('bash', [
    GATE0, '--repo', f.repo, '--base', f.base, '--config', f.config,
    '--cve-cmd', "printf '{\"results\":[]}'", '--json', f.output,
  ], { env: { ...process.env, QA_CODE_NODE: process.execPath, PATH: `${f.bin}:/usr/bin:/bin`, HOME: root } });
  assert.equal(result.status, 1, result.stderr);
  gate = readJson(f.output);
  assert.equal(gate.acceptance.status, 'fail');
  assert.deepEqual(gate.requirement_coverage, { covered: 0, total: 1, ids: [] });

  root = fixture('qc9-infra');
  f = acceptanceRepo(root, 'infra');
  result = run('bash', [
    GATE0, '--repo', f.repo, '--base', f.base, '--config', f.config,
    '--cve-cmd', "printf '{\"results\":[]}'", '--json', f.output,
  ], { env: { ...process.env, QA_CODE_NODE: process.execPath, PATH: `${f.bin}:/usr/bin:/bin`, HOME: root } });
  assert.equal(result.status, 20, result.stderr);
  gate = readJson(f.output);
  assert.equal(gate.acceptance.status, 'ungraded');
  assert.equal(gate.acceptance.results[0].fail_to_pass.base.outcome, 'ungraded');
});

test('QC10/L15: release gate invokes the shipped incident-replay suite and redproof checker', () => {
  const build = readFileSync(join(ROOT, 'scripts', 'build-package.sh'), 'utf8');
  assert.match(build, /incident-replay\/release-truth\.test\.mjs/);
  assert.match(build, /incident-replay\/wire-check\.mjs/);
  const packageFiles = JSON.parse(readFileSync(join(ROOT, 'package-files.json'), 'utf8'));
  assert.ok(packageFiles.include.includes('scripts'));
  assert.match(build, /INCIDENT_REPLAY_PASS/);

  const root = fixture('qc10-wire');
  const broken = join(root, 'build-package.sh');
  writeFileSync(broken, build.replace('scripts/incident-replay/release-truth.test.mjs', 'scripts/incident-replay/removed.test.mjs'));
  const checked = run(process.execPath, [join(ROOT, 'scripts', 'incident-replay', 'wire-check.mjs'), '--build', broken]);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /WIRE_FAIL|release-truth\.test\.mjs/);
});
