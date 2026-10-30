import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableJson } from './core.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const FIELDS = ['project_id', 'preview_url', 'version', 'kind', 'environment', 'backend_origin', 'frontend_build', 'asset_manifest_sha256', 'target_binding_sha256', 'identity_proof'];
const IDENTITY_FIELDS = FIELDS.filter(field => !['target_binding_sha256', 'identity_proof'].includes(field));
const PROOF_FIELDS = ['schema', 'target_binding_sha256', 'identity', 'sources'];
const REF_FIELDS = ['path', 'call_sha256', 'result_sha256', 'call_line', 'result_line', 'host', 'helper', 'request', 'native', 'tab_source', 'network_source'];
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function httpUrl(value) {
  if (!nonEmpty(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
export function isDeployedTarget(target) { return target?.kind === 'deployed-build'; }
export function deployedTargetIdentity(target) {
  if (!object(target)) return null;
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, field === 'frontend_build' && object(target[field])
    ? { kind: target.frontend_build.kind, id: target.frontend_build.id } : target[field]]));
}
export function canonicalDeployedJson(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return stableJson(sorted(value));
}
export function deployedTargetBindingSha256(target) { return sha256(canonicalDeployedJson(deployedTargetIdentity(target))); }
export function canonicalDeployedTarget(target) {
  return { ...deployedTargetIdentity(target), target_binding_sha256: target.target_binding_sha256,
    identity_proof: { path: target.identity_proof.path, sha256: target.identity_proof.sha256 } };
}
export function deployedTargetShapeErrors(target, prefix = 'TARGET') {
  const errors = [];
  if (!object(target)) return [prefix + ' target'];
  for (const field of FIELDS) if (!Object.hasOwn(target, field)) errors.push(prefix + ' target.' + field);
  for (const field of Object.keys(target)) if (!FIELDS.includes(field)) errors.push(prefix + ' target.' + field);
  for (const field of ['project_id', 'version', 'environment']) if (!nonEmpty(target[field])) errors.push(prefix + ' target.' + field);
  if (target.kind !== 'deployed-build') errors.push(prefix + ' target.kind');
  if (!['Local','Test','Staging','Production'].includes(target.environment)) errors.push(prefix + ' target.environment');
  if (!httpUrl(target.preview_url)) errors.push(prefix + ' target.preview_url');
  if (!httpUrl(target.backend_origin)) errors.push(prefix + ' target.backend_origin');
  if (!object(target.frontend_build) || Object.keys(target.frontend_build).some(key => !['kind', 'id'].includes(key)) || !nonEmpty(target.frontend_build.kind) || !nonEmpty(target.frontend_build.id)) errors.push(prefix + ' target.frontend_build');
  if (target.version !== target.frontend_build?.id) errors.push(prefix + ' target.version_build_mismatch');
  if (!HEX64.test(target.asset_manifest_sha256 || '')) errors.push(prefix + ' target.asset_manifest_sha256');
  if (!HEX64.test(target.target_binding_sha256 || '') || target.target_binding_sha256 !== deployedTargetBindingSha256(target)) errors.push(prefix + ' target.target_binding_sha256');
  if (!object(target.identity_proof) || Object.keys(target.identity_proof).some(key => !['path', 'sha256'].includes(key)) || !nonEmpty(target.identity_proof.path) || !HEX64.test(target.identity_proof.sha256 || '')) errors.push(prefix + ' target.identity_proof');
  return errors;
}
export function assertDeployedIdentityProof(target, { runDir, verifyOriginalSource } = {}) {
  const errors = deployedTargetShapeErrors(target);
  if (errors.length) throw new Error('DEPLOYED_TARGET_INVALID:' + errors.join(','));
  if (!nonEmpty(runDir) || typeof verifyOriginalSource !== 'function') throw new Error('DEPLOYED_PROOF_VERIFIER_REQUIRED');
  const base = realpathSync(runDir);
  const path = realpathSync(resolve(base, target.identity_proof.path));
  if (!path.startsWith(base + sep)) throw new Error('DEPLOYED_PROOF_OUTSIDE_RUN');
  const raw = readFileSync(path);
  if (sha256(raw) !== target.identity_proof.sha256) throw new Error('DEPLOYED_PROOF_HASH');
  const proof = JSON.parse(raw.toString('utf8'));
  if (!object(proof) || Object.keys(proof).some(key => !PROOF_FIELDS.includes(key)) || PROOF_FIELDS.some(key => !Object.hasOwn(proof, key)) || proof.schema !== 'team-qa/deployed-identity-proof/v1' || proof.target_binding_sha256 !== target.target_binding_sha256 || canonicalDeployedJson(proof.identity) !== canonicalDeployedJson(deployedTargetIdentity(target)) || !Array.isArray(proof.sources) || proof.sources.length === 0) throw new Error('DEPLOYED_PROOF_INVALID');
  const observed = {};
  for (const ref of proof.sources) {
    if (!object(ref) || Object.keys(ref).some(key => !REF_FIELDS.includes(key)) || !['path', 'call_sha256', 'result_sha256', 'call_line', 'result_line', 'host'].every(key => Object.hasOwn(ref, key))) throw new Error('DEPLOYED_PROOF_SOURCE_SHAPE');
    const result = verifyOriginalSource(ref);
    if (!object(result) || Object.keys(result).some(key => !IDENTITY_FIELDS.includes(key))) throw new Error('DEPLOYED_PROOF_SOURCE_UNVERIFIED');
    for (const [key, value] of Object.entries(result)) {
      if (Object.hasOwn(observed, key) && canonicalDeployedJson(observed[key]) !== canonicalDeployedJson(value)) throw new Error('DEPLOYED_PROOF_SOURCE_CONFLICT');
      observed[key] = value;
    }
  }
  for (const field of ['preview_url','backend_origin','frontend_build','asset_manifest_sha256']) {
    if (!Object.hasOwn(observed, field)) throw new Error('DEPLOYED_PROOF_OBSERVATION_MISSING:' + field);
  }
  for (const [field, value] of Object.entries(observed)) {
    if (canonicalDeployedJson(value) !== canonicalDeployedJson(proof.identity[field])) throw new Error('DEPLOYED_PROOF_OBSERVATION_MISMATCH:' + field);
  }
  return { target_binding_sha256: target.target_binding_sha256, proof_path: path, proof_sha256: target.identity_proof.sha256 };
}

export const WEB_CONTRACT_SHA256 = 'c4961eaa1e1915e567d357fc49d4472d75167c51f388e348e6ac11af790d7d5d';
export function assertWebBinding(binding, { target, requirementsHash, runDir, verifyOriginalSource, requireProof = true } = {}) {
  const contractPath = fileURLToPath(new URL('../../contracts/deployed-build/v1/CONTRACT.json', import.meta.url));
  if (sha256(readFileSync(contractPath)) !== WEB_CONTRACT_SHA256) throw new Error('WEB_CONTRACT_DRIFT');
  const keys = ['schema', 'run_uuid', 'requirements_hash', 'contract_sha256', 'verification_lane', 'target_kind', 'target_binding_sha256', 'target'];
  if (!object(binding) || Object.keys(binding).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(binding, key))) throw new Error('WEB_BINDING_FIELDS');
  if (binding.schema !== 'team-qa/web-binding/v1' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.run_uuid || '') || !HEX64.test(binding.requirements_hash || '') || binding.contract_sha256 !== WEB_CONTRACT_SHA256 || binding.verification_lane !== 'gui' || binding.target_kind !== 'deployed-build') throw new Error('WEB_BINDING_INVALID');
  if (deployedTargetShapeErrors(binding.target).length || binding.target_binding_sha256 !== binding.target.target_binding_sha256) throw new Error('WEB_BINDING_TARGET');
  if (target && (deployedTargetShapeErrors(target).length || canonicalDeployedJson(canonicalDeployedTarget(binding.target)) !== canonicalDeployedJson(canonicalDeployedTarget(target)))) throw new Error('WEB_BINDING_TARGET_MISMATCH');
  if (requirementsHash && binding.requirements_hash !== requirementsHash) throw new Error('WEB_BINDING_REQUIREMENTS_HASH');
  if (requireProof) return { binding, proof: assertDeployedIdentityProof(binding.target, { runDir, verifyOriginalSource }) };
  return { binding, proof: null };
}
