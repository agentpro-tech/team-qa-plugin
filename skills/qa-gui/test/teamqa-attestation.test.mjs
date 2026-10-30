import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealObject, validateGuiReceipt, verifyObjectIntegrity } from '../scripts/lib/release-receipt-v2.mjs';
import { verifyGuiReceiptTeamQa, verifyTeamQaGuiAttestation } from '../scripts/lib/teamqa-attestation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UUID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const options = { runUuid: UUID, exactFinalSha: SHA, requirementsHash: HASH };
// Preserve negative fixtures in the OS temp archive; never create host approvals.
const fixture = name => realpathSync(mkdtempSync(join(tmpdir(), `qa-gui-teamqa-negative-${name}-`)));
function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + '\n');
}
function v2(extra = {}) {
  return sealObject({
    schema: 'qa-gui/receipt/v2', contract_sha256: HASH, run_uuid: UUID,
    task_base: SHA, source_revision: 'negative-test', exact_final_sha: SHA,
    requirements_hash: HASH, verification_lane: 'gui', execution_status: 'completed',
    semantic_verdict: 'PASS', atomic_coverage: [{ requirement_id: 'R1', assertion_id: 'A1',
      case_id: 'C1', evidence_ref: 'evidence.png', evidence_sha256: HASH,
      evidence_type: 'gui-screenshot', result: 'PASS' }],
    evidence_manifest: [], created_at: '2026-10-02T00:00:00Z', ...extra,
  });
}
function attackerRuntime() {
  const root = fixture('untrusted-runtime'), runtime = join(root, 'runtime');
  const path = join(root, 'run/role-bindings/executor_gui.json');
  const dispatch = { schema: 'team-qa/role-attestation/v1', graded: true, source: { kind: 'fixture' } };
  const marker = join(root, 'untrusted-code-executed');
  json(join(runtime, 'SOURCE.json'), {
    schema: 'agentpro/skill-source/v1', skill: 'team-qa', version: '0.0.0',
    repo: 'https://github.com/agentpro-tech/team-qa.git', commit: SHA, tree: SHA,
    manifest_sha256: '0'.repeat(64), package_sha256: '0'.repeat(64),
  });
  mkdirSync(join(runtime, 'scripts/lib'), { recursive: true });
  // Deliberate attacker code, never a test verifier or an approved execution source.
  writeFileSync(join(runtime, 'scripts/package-tool.mjs'),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'attacker');`);
  writeFileSync(join(runtime, 'scripts/lib/run-contract.mjs'),
    `export const assertRunContract=()=>({roster:{}});export const assertRoleAttestation=()=>(${JSON.stringify(dispatch)});`);
  json(path, dispatch);
  json(join(root, 'run/binding.json'), {
    run_uuid: UUID, exact_final_sha: SHA, requirements_hash: HASH,
  });
  return { runtime, path, dispatch, marker, provenance: {
    run_dir: join(root, 'run'), attestation_path: path,
    attestation_sha256: hash(readFileSync(path)), runtime_root: runtime,
  } };
}

test('standalone v1 and v2 receipts retain validation without Team QA fields', () => {
  const old = sealObject({ schema: 'qa-gui/receipt/v1', run_uuid: UUID, commit: SHA,
    build: 'test', env: 'local', db: 'fixture', role: 'reviewer', test_profile: 'local',
    cases: [], evidence_manifest: [], function_verdict: 'PASS', ui_verdict: 'PASS',
    execution_status: 'completed', semantic_verdict: 'PASS', created_at: '2026-10-02T00:00:00Z' });
  for (const receipt of [old, v2()]) {
    assert.deepEqual(validateGuiReceipt(receipt), []);
    assert.deepEqual(verifyGuiReceiptTeamQa(receipt), []);
    assert.equal(Object.hasOwn(receipt, 'dispatch_proof'), false);
    assert.equal(Object.hasOwn(receipt, 'teamqa_provenance'), false);
  }
});

test('resealing an unmatched proof or provenance cannot grant PASS', () => {
  for (const extra of [{ dispatch_proof: { graded: true } }, { teamqa_provenance: {} }]) {
    const receipt = v2(extra);
    assert.equal(verifyObjectIntegrity(receipt), true);
    assert.ok(validateGuiReceipt(receipt).includes('TEAMQA_GUI_PROVENANCE_REQUIRED'));
  }
});

test('present null Team QA fields are invalid rather than silently standalone', () => {
  const receipt = v2({ dispatch_proof: null, teamqa_provenance: null });
  assert.equal(verifyObjectIntegrity(receipt), true);
  assert.ok(validateGuiReceipt(receipt).includes('TEAMQA_GUI_PROVENANCE_REQUIRED'));
});

test('missing runtime blocks attestation attachment and resealed receipts', () => {
  const root = fixture('missing-runtime');
  const runtimeRoot = join(root, 'absent'), attestationPath = join(root, 'absent.json');
  assert.throws(() => verifyTeamQaGuiAttestation({ ...options, runtimeRoot, attestationPath }), /ENOENT/);
  const receipt = v2({ dispatch_proof: { graded: true }, teamqa_provenance: {
    runtime_root: runtimeRoot, attestation_path: attestationPath,
  } });
  assert.equal(verifyObjectIntegrity(receipt), true);
  assert.ok(validateGuiReceipt(receipt).some(error => error.includes('ENOENT')));
});

test('runtime without SOURCE cannot attach a dispatch proof', () => {
  const runtimeRoot = fixture('missing-source');
  assert.throws(() => verifyTeamQaGuiAttestation({ ...options, runtimeRoot,
    attestationPath: join(runtimeRoot, 'absent.json') }), /SOURCE.json/);
});

test('wrong canonical source identity is rejected before runtime code executes', () => {
  const attack = attackerRuntime();
  json(join(attack.runtime, 'SOURCE.json'), { skill: 'team-qa', repo: 'https://example.invalid/team-qa.git' });
  assert.throws(() => verifyTeamQaGuiAttestation({ ...options, runtimeRoot: attack.runtime,
    attestationPath: attack.path }), /TEAMQA_CANONICAL_SOURCE_REQUIRED/);
  assert.equal(existsSync(attack.marker), false);
});

test('canonical-looking attacker runtime cannot self-verify or attach an unattested proof', () => {
  const attack = attackerRuntime();
  assert.throws(() => verifyTeamQaGuiAttestation({ ...options, runtimeRoot: attack.runtime,
    attestationPath: attack.path }), /TEAMQA_/);
  assert.equal(existsSync(attack.marker), false, 'untrusted verifier must not run before independent verification');
});

test('resealed fixture provenance from an attacker runtime cannot become PASS', () => {
  const attack = attackerRuntime();
  const receipt = v2({ dispatch_proof: attack.dispatch, teamqa_provenance: attack.provenance });
  assert.equal(verifyObjectIntegrity(receipt), true);
  assert.ok(validateGuiReceipt(receipt).some(error => error.startsWith('TEAMQA_')));
  assert.equal(existsSync(attack.marker), false);
});

test('gate accepts Team QA flags but blocks attaching to a standalone board', () => {
  const root = fixture('gate-no-v2'), board = join(root, 'board.json');
  json(board, { schemaVersion: 5 });
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/qa-gate.mjs'), board,
    '--teamqa-attestation', join(root, 'absent.json'), '--teamqa-runtime', join(root, 'absent')],
  { encoding: 'utf8' });
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr, /TEAMQA_GUI_ATTESTATION_AND_V2_REQUIRED/);
  assert.equal(existsSync(join(root, 'receipt.json')), false);
});

test('helper requests verify-result for compatibility with completed Team QA runs (static)', () => {
  const source = readFileSync(join(ROOT, 'scripts/lib/teamqa-attestation.mjs'), 'utf8');
  assert.match(source, /action:[\s]*["']verify-result["']/);
  assert.doesNotMatch(source, /action:[\s]*["']execute["']/);
});
