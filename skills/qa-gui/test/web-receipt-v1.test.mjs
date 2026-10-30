import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuiWebContext, readWebRequirementsFreeze, requirementsHash, webBindingAfterAttestation, webTargetBindingSha256, WEB_CONTRACT_SHA256 } from '../scripts/lib/release-truth-v2.mjs';
import { inspectEvidenceManifest, sealObject, validateGuiReceipt } from '../scripts/lib/release-receipt-v2.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const runUuid = '11111111-1111-4111-8111-111111111111';
function fixture() {
  // Synthetic verified-callback seam only; not a product or original-source PASS.
  const runDir = mkdtempSync(join(tmpdir(), 'qa-gui-web-v1-archive-'));
  const target = { project_id: 'project-1', preview_url: 'https://test.example/cart', version: 'build-1',
    kind: 'deployed-build', environment: 'Test', backend_origin: 'https://api.test.example',
    frontend_build: { kind: 'nextjs-build-id', id: 'build-1' }, asset_manifest_sha256: 'b'.repeat(64),
    target_binding_sha256: '', identity_proof: { path: 'proof.json', sha256: '' } };
  target.target_binding_sha256 = webTargetBindingSha256(target);
  const identity = { project_id: target.project_id, preview_url: target.preview_url, version: target.version,
    kind: target.kind, environment: target.environment, backend_origin: target.backend_origin,
    frontend_build: target.frontend_build, asset_manifest_sha256: target.asset_manifest_sha256 };
  const proof = { schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: target.target_binding_sha256,
    identity, sources: [{ path: 'original-host-ref', call_sha256: 'c'.repeat(64), result_sha256: 'd'.repeat(64),
      call_line: 1, result_line: 2, host: 'codex' }] };
  const proofRaw = JSON.stringify(proof) + '\n';
  target.identity_proof.sha256 = sha(proofRaw);
  const graph = { schema: 'requirements.freeze/web-v1', contract_sha256: WEB_CONTRACT_SHA256,
    source_revision: 'document-version-1', target_binding_sha256: target.target_binding_sha256,
    gate_policy: { coverage_threshold: 100, required_layers: ['gui'] },
    requirements: [{ id: 'R1', expectation: 'Observe UI', requirement_owner: 'fixture',
      verification_lane: 'gui', risk_dimensions: [], acceptance_ids: ['C1'],
      evidence_contract: { allowed_types: ['gui-screenshot'], atomic: true, multi_evidence: false } }] };
  const binding = { schema: 'team-qa/web-binding/v1', run_uuid: runUuid, requirements_hash: requirementsHash(graph),
    contract_sha256: WEB_CONTRACT_SHA256, verification_lane: 'gui', target_kind: 'deployed-build',
    target_binding_sha256: target.target_binding_sha256, target };
  const files = { bindingPath: join(runDir, 'binding.json'), requirementsPath: join(runDir, 'REQUIREMENTS.json'),
    planPath: join(runDir, 'plan.json'), runDir };
  writeFileSync(join(runDir, 'proof.json'), proofRaw);
  writeFileSync(files.bindingPath, JSON.stringify(binding) + '\n');
  writeFileSync(files.requirementsPath, JSON.stringify(graph) + '\n');
  writeFileSync(files.planPath, JSON.stringify({ cases: [{ id: 'C1', req_id: 'R1' }] }) + '\n');
  return { ...files, binding, target, graph };
}

test('web freeze requires deployed target binding without product Git fields', () => {
  const f = fixture();
  assert.equal(readWebRequirementsFreeze(f.requirementsPath).target_binding_sha256, f.target.target_binding_sha256);
  for (const [field, value] of [['repo', '/nonexistent/product-repo'], ['task_base', 'a'.repeat(40)], ['exact_final_sha', 'a'.repeat(40)]]) {
    const graph = { ...f.graph, [field]: value };
    writeFileSync(f.requirementsPath, JSON.stringify(graph) + '\n');
    assert.throws(() => readWebRequirementsFreeze(f.requirementsPath), new RegExp('UNKNOWN_FIELD:' + field));
  }
});

test('web freeze requires GUI-only layers and lanes', () => {
  const f = fixture();
  const codeLayer = structuredClone(f.graph);
  codeLayer.gate_policy.required_layers = ['gui', 'code'];
  writeFileSync(f.requirementsPath, JSON.stringify(codeLayer) + '\n');
  assert.throws(() => readWebRequirementsFreeze(f.requirementsPath), /WEB_GATE_LAYERS/);
  const codeLane = structuredClone(f.graph);
  codeLane.requirements[0].verification_lane = 'code';
  writeFileSync(f.requirementsPath, JSON.stringify(codeLane) + '\n');
  assert.throws(() => readWebRequirementsFreeze(f.requirementsPath), /WEB_REQUIREMENT_LANE:R1/);
});

test('web context rejects a graph bound to a different target hash', () => {
  const f = fixture();
  const graph = { ...f.graph, target_binding_sha256: '0'.repeat(64) };
  const binding = { ...f.binding, requirements_hash: requirementsHash(graph) };
  writeFileSync(f.requirementsPath, JSON.stringify(graph) + '\n');
  writeFileSync(f.bindingPath, JSON.stringify(binding) + '\n');
  assert.throws(() => readGuiWebContext({ ...f, verifyWebBinding: webBindingAfterAttestation }), /WEB_GRAPH_TARGET_BINDING_MISMATCH/);
});

test('web context binds verified target without reading product Git', () => {
  const f = fixture();
  const context = readGuiWebContext({ ...f, verifyWebBinding: webBindingAfterAttestation });
  assert.equal(context.kind, 'deployed-build');
  assert.deepEqual(context.guiIds, ['R1']);
  assert.equal(context.targetBindingSha256, f.target.target_binding_sha256);
  assert.equal(context.sourceProof.proof_sha256, f.target.identity_proof.sha256);
});

test('web context rejects an unverified binding callback', () => {
  const f = fixture();
  assert.throws(() => readGuiWebContext(f), /WEB_BINDING_VERIFIER_REQUIRED/);
  assert.throws(() => readGuiWebContext({ ...f, verifyWebBinding: () => ({ binding: f.binding }) }), /WEB_BINDING_VERIFICATION_FAILED/);
});

test('web context rejects target drift and forged build IDs', () => {
  const f = fixture();
  const changed = structuredClone(f.binding);
  changed.target.frontend_build.id = 'forged';
  writeFileSync(join(f.runDir, 'changed-binding.json'), JSON.stringify(changed) + '\n');
  assert.throws(() => readGuiWebContext({ ...f, bindingPath: join(f.runDir, 'changed-binding.json'),
    verifyWebBinding: webBindingAfterAttestation }), /WEB_TARGET_HASH_MISMATCH/);
});

test('web evidence metadata binds target hash and rejects stale bytes', () => {
  const f = fixture();
  mkdirSync(join(f.runDir, 'evidence'));
  writeFileSync(join(f.runDir, 'evidence', 'shot.png'), 'fixture-bytes');
  const entry = { path: 'evidence/shot.png', sha256: sha('fixture-bytes'), evidence_type: 'gui-screenshot',
    metadata: { run_uuid: runUuid, target_binding_sha256: f.target.target_binding_sha256,
      case_id: 'C1', state: 'loaded', captured_at: '2026-10-08T00:00:00Z' } };
  assert.deepEqual(inspectEvidenceManifest([entry], { evidenceRoot: f.runDir, runUuid,
    targetBindingSha256: f.target.target_binding_sha256 }).errors, []);
  entry.metadata.target_binding_sha256 = '0'.repeat(64);
  assert.ok(inspectEvidenceManifest([entry], { evidenceRoot: f.runDir, runUuid,
    targetBindingSha256: f.target.target_binding_sha256 }).errors.some(error => error.startsWith('EVIDENCE_METADATA_TARGET_MISMATCH')));
});

function unsignedWebReceipt(f) {
  return { schema: 'qa-gui/receipt/web-v1', contract_sha256: WEB_CONTRACT_SHA256,
    run_uuid: runUuid, requirements_hash: f.binding.requirements_hash, verification_lane: 'gui',
    target_kind: 'deployed-build', target_binding_sha256: f.target.target_binding_sha256, target: f.target,
    execution_status: 'completed', semantic_verdict: 'UNGRADED', atomic_coverage: [], evidence_manifest: [],
    created_at: '2026-10-08T00:00:00Z', dispatch_proof: {}, teamqa_provenance: {} };
}

test('web receipt rejects a Git-only field', () => {
  const f = fixture();
  const receipt = sealObject({ ...unsignedWebReceipt(f), exact_final_sha: 'a'.repeat(40) });
  assert.ok(validateGuiReceipt(receipt).includes('receipt:UNKNOWN_FIELD:exact_final_sha'));
});

test('clean web receipt rejects absent Team QA provenance', () => {
  const f = fixture();
  const receipt = sealObject(unsignedWebReceipt(f));
  const errors = validateGuiReceipt(receipt);
  assert.ok(errors.some(error => error.startsWith('TEAMQA_GUI_PROVENANCE_INVALID:')), errors.join(','));
});
