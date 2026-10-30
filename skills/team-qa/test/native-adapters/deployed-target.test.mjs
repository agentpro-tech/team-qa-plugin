import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import {
  assertDeployedIdentityProof, assertWebBinding, canonicalDeployedTarget,
  deployedTargetBindingSha256, deployedTargetShapeErrors, WEB_CONTRACT_SHA256,
} from '../../scripts/lib/deployed-target.mjs';

const runDir = fileURLToPath(new URL('../fixtures/deployed-target/', import.meta.url));
const proofBytes = readFileSync(join(runDir, 'proof.json'));
const proof = JSON.parse(proofBytes.toString('utf8'));
const target = { ...proof.identity, target_binding_sha256: proof.target_binding_sha256,
  identity_proof: { path: 'proof.json', sha256: sha256(proofBytes) } };
const binding = { schema:'team-qa/web-binding/v1', run_uuid:'123e4567-e89b-42d3-a456-426614174000',
  requirements_hash:'d'.repeat(64), contract_sha256:WEB_CONTRACT_SHA256,
  verification_lane:'gui', target_kind:'deployed-build', target_binding_sha256:target.target_binding_sha256, target };

test('deployed target has deterministic build identity and exact fields', () => {
  assert.equal(deployedTargetBindingSha256(target), target.target_binding_sha256);
  assert.deepEqual(deployedTargetShapeErrors(target), []);
  assert.ok(deployedTargetShapeErrors({ ...target, version:'other' }).length);
  assert.ok(deployedTargetShapeErrors({ ...target, product_git_sha:'e'.repeat(40) }).length);
  assert.deepEqual(canonicalDeployedTarget({ ...target, frontend_build:{ id:'build-123', kind:'next-build-id' } }), target);
});

test('proof requires authenticated original source observation', () => {
  assert.throws(() => assertDeployedIdentityProof(target,{runDir}), /DEPLOYED_PROOF_VERIFIER_REQUIRED/);
  assert.throws(() => assertDeployedIdentityProof(target,{runDir,verifyOriginalSource:()=>({version:'wrong'})}), /DEPLOYED_PROOF_OBSERVATION_MISSING/);
  assert.throws(() => assertDeployedIdentityProof(target,{runDir,verifyOriginalSource:()=>({...proof.identity,version:'wrong'})}), /DEPLOYED_PROOF_OBSERVATION_MISMATCH/);
  assert.equal(assertDeployedIdentityProof(target,{runDir,verifyOriginalSource:()=>proof.identity}).target_binding_sha256,target.target_binding_sha256);
});

test('web binding rejects synthetic Git fields and target drift', () => {
  assert.equal(assertWebBinding(binding,{runDir,verifyOriginalSource:()=>proof.identity}).binding,binding);
  assert.throws(() => assertWebBinding({ ...binding, exact_final_sha:'e'.repeat(40) },{requireProof:false}), /WEB_BINDING_FIELDS/);
  assert.throws(() => assertWebBinding({ ...binding, target_binding_sha256:'f'.repeat(64) },{requireProof:false}), /WEB_BINDING_TARGET/);
  assert.throws(() => assertWebBinding(binding,{target:{...target,backend_origin:'https://other.example'},requireProof:false}), /WEB_BINDING_TARGET_MISMATCH/);
});
