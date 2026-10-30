export {verifyTeamQaGuiAttestation} from './teamqa-attestation.mjs';
export {caseEvidenceSessionIssues} from './claude-stream-route.mjs';
import {verifyGuiReceiptTeamQa} from './teamqa-attestation.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import {
  canonicalJson,
  readContract,
  readGuiReleaseTruthContext,
  sha256,
  WEB_CONTRACT_SHA256,
  webTargetBindingSha256,
} from './release-truth-v2.mjs';

export const GUI_RECEIPT_V1 = 'qa-gui/receipt/v1';
export const GUI_RECEIPT_V2 = 'qa-gui/receipt/v2';
export const GUI_RECEIPT_WEB_V1 = 'qa-gui/receipt/web-v1';
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERDICTS = ['PASS', 'FAIL', 'UNGRADED'];
const STATUSES = ['completed', 'blocked', 'failed'];
const V2_KEYS = [
  'schema', 'contract_sha256', 'run_uuid', 'task_base', 'source_revision',
  'exact_final_sha', 'requirements_hash', 'verification_lane', 'execution_status',
  'semantic_verdict', 'atomic_coverage', 'evidence_manifest', 'created_at', 'integrity',
];
const V1_KEYS = [
  'schema', 'run_uuid', 'commit', 'build', 'env', 'db', 'role', 'test_profile',
  'cases', 'evidence_manifest', 'function_verdict', 'ui_verdict', 'execution_status',
  'semantic_verdict', 'created_at', 'integrity',
];
const COVERAGE_KEYS = [
  'requirement_id', 'assertion_id', 'case_id', 'evidence_ref', 'evidence_sha256',
  'evidence_type', 'result',
];
const EVIDENCE_KEYS = ['path', 'sha256', 'evidence_type', 'metadata'];
const METADATA_KEYS = ['run_uuid', 'task_base', 'commit', 'case_id', 'state', 'captured_at'];
const WEB_METADATA_KEYS = ['run_uuid', 'target_binding_sha256', 'case_id', 'state', 'captured_at'];
const WEB_KEYS = ['schema', 'contract_sha256', 'run_uuid', 'requirements_hash', 'verification_lane', 'target_kind', 'target_binding_sha256', 'target', 'execution_status', 'semantic_verdict', 'atomic_coverage', 'evidence_manifest', 'created_at', 'integrity', 'dispatch_proof', 'teamqa_provenance'];

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sealObject(value) {
  const sealed = structuredClone(value);
  delete sealed.integrity;
  sealed.integrity = sha256(canonicalJson(sealed));
  return sealed;
}

export function verifyObjectIntegrity(value) {
  if (!isObject(value) || !SHA256.test(value.integrity || '')) return false;
  const unsigned = structuredClone(value);
  const expected = unsigned.integrity;
  delete unsigned.integrity;
  return sha256(canonicalJson(unsigned)) === expected;
}

function exactKeys(value, keys, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label}:OBJECT_REQUIRED`);
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}:UNKNOWN_FIELD:${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${label}:MISSING_FIELD:${key}`);
  return true;
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateMetadata(value, label, errors, web = false) {
  if (!exactKeys(value, web ? WEB_METADATA_KEYS : METADATA_KEYS, label, errors)) return;
  if (!UUID.test(value.run_uuid || '')) errors.push(`${label}:RUN_UUID_INVALID`);
  if (web) { if (!SHA256.test(value.target_binding_sha256 || '')) errors.push(`${label}:TARGET_BINDING_SHA_INVALID`); }
  else {
    if (!SHA40.test(value.task_base || '')) errors.push(`${label}:TASK_BASE_INVALID`);
    if (!SHA40.test(value.commit || '')) errors.push(`${label}:COMMIT_INVALID`);
  }
  if (typeof value.case_id !== 'string' || !value.case_id.trim()) errors.push(`${label}:CASE_ID_MISSING`);
  if (typeof value.state !== 'string' || !value.state.trim()) errors.push(`${label}:STATE_MISSING`);
  if (!validDate(value.captured_at)) errors.push(`${label}:CAPTURED_AT_INVALID`);
}

function validateEvidence(value, index, errors, web = false) {
  const label = `evidence_manifest[${index}]`;
  if (!exactKeys(value, EVIDENCE_KEYS, label, errors)) return;
  if (typeof value.path !== 'string' || !value.path) errors.push(`${label}:PATH_MISSING`);
  if (!SHA256.test(value.sha256 || '')) errors.push(`${label}:SHA256_INVALID`);
  if (typeof value.evidence_type !== 'string' || !value.evidence_type.trim()) errors.push(`${label}:EVIDENCE_TYPE_MISSING`);
  validateMetadata(value.metadata, `${label}.metadata`, errors, web);
}

function validateCoverage(value, index, errors) {
  const label = `atomic_coverage[${index}]`;
  if (!exactKeys(value, COVERAGE_KEYS, label, errors)) return;
  for (const key of ['requirement_id', 'assertion_id', 'case_id', 'evidence_ref', 'evidence_type']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) errors.push(`${label}:${key.toUpperCase()}_MISSING`);
  }
  if (!SHA256.test(value.evidence_sha256 || '')) errors.push(`${label}:EVIDENCE_SHA256_INVALID`);
  if (!VERDICTS.includes(value.result)) errors.push(`${label}:RESULT_INVALID`);
}

function validateV2(value) {
  const errors = [];
  if (!exactKeys(value, [...V2_KEYS,...(Object.hasOwn(value,'dispatch_proof')||Object.hasOwn(value,'teamqa_provenance')?['dispatch_proof','teamqa_provenance']:[])], 'receipt', errors)) return errors;
  errors.push(...verifyGuiReceiptTeamQa(value));
  if (value.schema !== GUI_RECEIPT_V2) errors.push(`SCHEMA_MISMATCH:${GUI_RECEIPT_V2}:${value.schema || 'missing'}`);
  if (!SHA256.test(value.contract_sha256 || '')) errors.push('CONTRACT_SHA_INVALID');
  if (!UUID.test(value.run_uuid || '')) errors.push('RUN_UUID_INVALID');
  if (!SHA40.test(value.task_base || '')) errors.push('TASK_BASE_INVALID');
  if (typeof value.source_revision !== 'string' || !value.source_revision.trim()) errors.push('SOURCE_REVISION_MISSING');
  if (!SHA40.test(value.exact_final_sha || '')) errors.push('EXACT_FINAL_SHA_INVALID');
  if (!SHA256.test(value.requirements_hash || '')) errors.push('REQUIREMENTS_HASH_INVALID');
  if (value.verification_lane !== 'gui') errors.push(`VERIFICATION_LANE_MISMATCH:gui:${value.verification_lane || 'missing'}`);
  if (!STATUSES.includes(value.execution_status)) errors.push('EXECUTION_STATUS_INVALID');
  if (!VERDICTS.includes(value.semantic_verdict)) errors.push('SEMANTIC_VERDICT_INVALID');
  if (!Array.isArray(value.atomic_coverage)) errors.push('ATOMIC_COVERAGE_ARRAY_REQUIRED');
  else value.atomic_coverage.forEach((row, index) => validateCoverage(row, index, errors));
  if (!Array.isArray(value.evidence_manifest)) errors.push('EVIDENCE_MANIFEST_ARRAY_REQUIRED');
  else value.evidence_manifest.forEach((entry, index) => validateEvidence(entry, index, errors));
  if (!validDate(value.created_at)) errors.push('CREATED_AT_INVALID');
  if (!SHA256.test(value.integrity || '')) errors.push('INTEGRITY_INVALID');
  if (value.execution_status !== 'completed' && value.semantic_verdict !== 'UNGRADED') errors.push('INCOMPLETE_RECEIPT_MUST_BE_UNGRADED');
  if (value.semantic_verdict === 'PASS'
    && Array.isArray(value.atomic_coverage)
    && value.atomic_coverage.some((row) => row?.result !== 'PASS')) errors.push('PASS_REQUIRES_ALL_ATOMIC_PASS');
  return errors;
}

function validateV1(value) {
  const errors = [];
  if (!exactKeys(value, V1_KEYS, 'receipt', errors)) return errors;
  if (value.schema !== GUI_RECEIPT_V1) errors.push(`SCHEMA_MISMATCH:${GUI_RECEIPT_V1}:${value.schema || 'missing'}`);
  if (!UUID.test(value.run_uuid || '')) errors.push('RUN_UUID_INVALID');
  if (!SHA40.test(value.commit || '')) errors.push('COMMIT_INVALID');
  for (const key of ['build', 'env', 'db', 'role', 'test_profile']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) errors.push(`${key.toUpperCase()}_MISSING`);
  }
  if (!Array.isArray(value.cases)) errors.push('CASES_ARRAY_REQUIRED');
  if (!Array.isArray(value.evidence_manifest)) errors.push('EVIDENCE_MANIFEST_ARRAY_REQUIRED');
  if (!VERDICTS.includes(value.function_verdict)) errors.push('FUNCTION_VERDICT_INVALID');
  if (!VERDICTS.includes(value.ui_verdict)) errors.push('UI_VERDICT_INVALID');
  if (!STATUSES.includes(value.execution_status)) errors.push('EXECUTION_STATUS_INVALID');
  if (!VERDICTS.includes(value.semantic_verdict)) errors.push('SEMANTIC_VERDICT_INVALID');
  if (!validDate(value.created_at)) errors.push('CREATED_AT_INVALID');
  if (!SHA256.test(value.integrity || '')) errors.push('INTEGRITY_INVALID');
  return errors;
}

function validateWeb(value) {
  const errors = [];
  if (!exactKeys(value, WEB_KEYS, 'receipt', errors)) return errors;
  errors.push(...verifyGuiReceiptTeamQa(value));
  if (value.schema !== GUI_RECEIPT_WEB_V1) errors.push('WEB_SCHEMA_MISMATCH');
  if (value.contract_sha256 !== WEB_CONTRACT_SHA256) errors.push('WEB_CONTRACT_SHA_MISMATCH');
  if (!UUID.test(value.run_uuid || '')) errors.push('RUN_UUID_INVALID');
  if (!SHA256.test(value.requirements_hash || '')) errors.push('REQUIREMENTS_HASH_INVALID');
  if (value.verification_lane !== 'gui' || value.target_kind !== 'deployed-build') errors.push('WEB_GUI_ONLY_REQUIRED');
  if (!SHA256.test(value.target_binding_sha256 || '')) errors.push('TARGET_BINDING_SHA_INVALID');
  if (!isObject(value.target) || value.target.kind !== 'deployed-build') errors.push('WEB_TARGET_INVALID');
  else {
    exactKeys(value.target, ['project_id', 'preview_url', 'version', 'kind', 'environment', 'backend_origin', 'frontend_build', 'asset_manifest_sha256', 'target_binding_sha256', 'identity_proof'], 'target', errors);
    exactKeys(value.target.frontend_build, ['kind', 'id'], 'target.frontend_build', errors);
    exactKeys(value.target.identity_proof, ['path', 'sha256'], 'target.identity_proof', errors);
    if (value.target.version !== value.target.frontend_build?.id) errors.push('WEB_BUILD_ID_MISMATCH');
    if (!SHA256.test(value.target.asset_manifest_sha256 || '')) errors.push('WEB_ASSET_MANIFEST_SHA_INVALID');
    if (!SHA256.test(value.target.identity_proof?.sha256 || '')) errors.push('WEB_IDENTITY_PROOF_SHA_INVALID');
    if (value.target_binding_sha256 !== value.target.target_binding_sha256 || value.target_binding_sha256 !== webTargetBindingSha256(value.target)) errors.push('WEB_TARGET_HASH_MISMATCH');
  }
  if (!STATUSES.includes(value.execution_status)) errors.push('EXECUTION_STATUS_INVALID');
  if (!VERDICTS.includes(value.semantic_verdict)) errors.push('SEMANTIC_VERDICT_INVALID');
  if (!Array.isArray(value.atomic_coverage)) errors.push('ATOMIC_COVERAGE_ARRAY_REQUIRED');
  else value.atomic_coverage.forEach((row, index) => validateCoverage(row, index, errors));
  if (!Array.isArray(value.evidence_manifest)) errors.push('EVIDENCE_MANIFEST_ARRAY_REQUIRED');
  else value.evidence_manifest.forEach((entry, index) => validateEvidence(entry, index, errors, true));
  if (!validDate(value.created_at)) errors.push('CREATED_AT_INVALID');
  if (!SHA256.test(value.integrity || '')) errors.push('INTEGRITY_INVALID');
  if (value.execution_status !== 'completed' && value.semantic_verdict !== 'UNGRADED') errors.push('INCOMPLETE_RECEIPT_MUST_BE_UNGRADED');
  if (value.semantic_verdict === 'PASS' && value.atomic_coverage?.some((row) => row.result !== 'PASS')) errors.push('PASS_REQUIRES_ALL_ATOMIC_PASS');
  return errors;
}

export function validateGuiReceipt(value) {
  if (!isObject(value)) return ['RECEIPT_OBJECT_REQUIRED'];
  const errors = value.schema === GUI_RECEIPT_WEB_V1 ? validateWeb(value)
    : value.schema === GUI_RECEIPT_V2 ? validateV2(value)
    : value.schema === GUI_RECEIPT_V1 ? validateV1(value)
      : [`SCHEMA_UNSUPPORTED:${value.schema || 'missing'}`];
  if (!verifyObjectIntegrity(value)) errors.push('INTEGRITY_MISMATCH');
  return [...new Set(errors)];
}

function canonicalRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (isAbsolute(value) || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return posix.normalize(value) === value;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function inspectEvidenceManifest(entries, {
  evidenceRoot,
  runUuid,
  taskBase,
  exactFinalSha,
  validCaseStates = null,
  targetBindingSha256 = null,
} = {}) {
  const errors = [];
  const paths = new Map();
  let root;
  try {
    const requested = resolve(evidenceRoot);
    const requestedStat = lstatSync(requested);
    if (requestedStat.isSymbolicLink()) errors.push('EVIDENCE_ROOT_SYMLINK');
    root = realpathSync(requested);
    if (!lstatSync(root).isDirectory()) errors.push('EVIDENCE_ROOT_NOT_DIRECTORY');
  } catch (error) {
    errors.push(`EVIDENCE_ROOT_UNREADABLE:${error.message}`);
    return { errors, paths, physicalValid: false, root: null };
  }
  if (!Array.isArray(entries)) return { errors: ['EVIDENCE_MANIFEST_ARRAY_REQUIRED'], paths, physicalValid: false, root };

  for (const [index, entry] of entries.entries()) {
    const label = `evidence_manifest[${index}]`;
    const structural = [];
    validateEvidence(entry, index, structural, targetBindingSha256 !== null);
    errors.push(...structural);
    if (!isObject(entry) || typeof entry.path !== 'string') continue;
    const rel = entry.path;
    if (paths.has(rel)) {
      errors.push(`EVIDENCE_DUPLICATE:${rel}`);
      continue;
    }
    if (!canonicalRelativePath(rel)) {
      errors.push(`EVIDENCE_PATH_TRAVERSAL:${rel}`);
      continue;
    }
    const candidate = resolve(root, ...rel.split('/'));
    let real;
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        errors.push(`EVIDENCE_SYMLINK:${rel}`);
        continue;
      }
      if (!stat.isFile()) {
        errors.push(`EVIDENCE_NOT_REGULAR:${rel}`);
        continue;
      }
      real = realpathSync(candidate);
      if (!inside(root, real)) {
        errors.push(`EVIDENCE_ESCAPE:${rel}`);
        continue;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') errors.push(`EVIDENCE_MISSING:${rel}`);
      else errors.push(`EVIDENCE_UNREADABLE:${rel}:${error.message}`);
      continue;
    }
    const observed = createHash('sha256').update(readFileSync(real)).digest('hex');
    if (entry.sha256 !== observed) errors.push(`EVIDENCE_HASH_MISMATCH:${rel}`);
    const metadata = entry.metadata;
    if (isObject(metadata)) {
      if (metadata.run_uuid !== runUuid) errors.push(`EVIDENCE_METADATA_RUN_MISMATCH:${rel}`);
      if (targetBindingSha256 !== null) {
        if (metadata.target_binding_sha256 !== targetBindingSha256) errors.push(`EVIDENCE_METADATA_TARGET_MISMATCH:${rel}`);
      } else {
        if (metadata.task_base !== taskBase) errors.push(`EVIDENCE_METADATA_TASK_BASE_MISMATCH:${rel}`);
        if (metadata.commit !== exactFinalSha) errors.push(`EVIDENCE_METADATA_COMMIT_MISMATCH:${rel}`);
      }
      if (validCaseStates instanceof Set && !validCaseStates.has(`${metadata.case_id}\u0000${metadata.state}`)) {
        errors.push(`EVIDENCE_METADATA_CASE_STATE_MISMATCH:${rel}:${metadata.case_id}:${metadata.state}`);
      }
    }
    paths.set(rel, { entry, absolute: real, observedSha256: observed });
  }
  return { errors: [...new Set(errors)], paths, physicalValid: errors.length === 0, root };
}

export function createGuiReceiptV2({ context, data, semanticVerdict, atomicCoverage, createdAt = new Date().toISOString() }) {
  const receipt = sealObject({
    schema: GUI_RECEIPT_V2,
    contract_sha256: context.contract.contract_sha256,
    run_uuid: data.runUuid,
    task_base: context.taskBase,
    source_revision: context.sourceRevision,
    exact_final_sha: context.exactFinalSha,
    requirements_hash: context.requirementsHash,
    verification_lane: 'gui',
    execution_status: 'completed',
    semantic_verdict: semanticVerdict,
    atomic_coverage: atomicCoverage,
    evidence_manifest: data.evidenceManifest,
    created_at: createdAt,
  });
  const errors = validateGuiReceipt(receipt);
  if (errors.length > 0) throw new Error(`QA_GUI_RECEIPT_INVALID:${errors.join(',')}`);
  return receipt;
}

export function verifyGuiReceiptBindings(receipt, { repo, requirements, evidenceRoot } = {}) {
  const errors = validateGuiReceipt(receipt);
  if (receipt?.schema !== GUI_RECEIPT_V2) return [...new Set(errors)];
  let contract;
  try { contract = readContract(); }
  catch (error) { errors.push(error.message); }
  if (contract && receipt.contract_sha256 !== contract.contract_sha256) errors.push('CONTRACT_SHA_MISMATCH');

  let context;
  try { context = readGuiReleaseTruthContext(requirements, { repo }); }
  catch (error) { errors.push(error.message); }
  if (context) {
    if (receipt.task_base !== context.taskBase) errors.push(`TASK_BASE_MISMATCH:${context.taskBase}:${receipt.task_base}`);
    if (receipt.source_revision !== context.sourceRevision) errors.push(`SOURCE_REVISION_MISMATCH:${context.sourceRevision}:${receipt.source_revision}`);
    if (receipt.verification_lane !== 'gui') errors.push(`VERIFICATION_LANE_MISMATCH:gui:${receipt.verification_lane}`);
    if (receipt.requirements_hash !== context.requirementsHash) errors.push('REQUIREMENTS_HASH_MISMATCH');
    if (receipt.exact_final_sha !== context.exactFinalSha) errors.push('RECEIPT_STALE');

    const inspected = inspectEvidenceManifest(receipt.evidence_manifest, {
      evidenceRoot,
      runUuid: receipt.run_uuid,
      taskBase: receipt.task_base,
      exactFinalSha: receipt.exact_final_sha,
    });
    errors.push(...inspected.errors);
    const required = new Map(context.activeGuiRequirements.map((item) => [item.id, item]));
    const covered = new Set();
    const assertionIds = new Set();
    for (const row of receipt.atomic_coverage ?? []) {
      if (assertionIds.has(row.assertion_id)) errors.push(`ATOMIC_ASSERTION_DUPLICATE:${row.assertion_id}`);
      assertionIds.add(row.assertion_id);
      const requirement = required.get(row.requirement_id);
      if (!requirement) {
        errors.push(`ATOMIC_REQUIREMENT_OUTSIDE_GUI_LANE:${row.requirement_id}`);
        continue;
      }
      const planCase = context.planById.get(row.case_id);
      if (!planCase) errors.push(`ATOMIC_CASE_NOT_IN_PLAN:${row.case_id}`);
      else if (planCase.requirementId !== row.requirement_id) {
        errors.push(`ATOMIC_CASE_REQUIREMENT_MISMATCH:${row.case_id}:${planCase.requirementId}:${row.requirement_id}`);
      }
      if (!requirement.acceptance_ids.includes(row.case_id)) {
        errors.push(`ATOMIC_CASE_NOT_IN_REQUIREMENT:${row.requirement_id}:${row.case_id}`);
      }
      covered.add(row.requirement_id);
      const evidence = inspected.paths.get(row.evidence_ref);
      if (!evidence) errors.push(`ATOMIC_EVIDENCE_MISSING:${row.evidence_ref}`);
      else {
        if (row.evidence_sha256 !== evidence.entry.sha256) errors.push(`ATOMIC_EVIDENCE_HASH_MISMATCH:${row.evidence_ref}`);
        if (row.evidence_type !== evidence.entry.evidence_type) errors.push(`ATOMIC_EVIDENCE_TYPE_MISMATCH:${row.evidence_ref}`);
        if (row.case_id !== evidence.entry.metadata?.case_id) {
          errors.push(`ATOMIC_EVIDENCE_CASE_MISMATCH:${row.evidence_ref}:${row.case_id}:${evidence.entry.metadata?.case_id || 'missing'}`);
        }
      }
      if (!requirement.evidence_contract.allowed_types.includes(row.evidence_type)
        || (row.result === 'PASS' && !row.evidence_type.startsWith('gui-'))) {
        errors.push(`EVIDENCE_TYPE_MISMATCH:${row.requirement_id}:${row.evidence_type}`);
      }
    }
    const missing = [...required.keys()].filter((id) => !covered.has(id));
    if (missing.length > 0) errors.push(`ATOMIC_COVERAGE_MISSING:${missing.join(',')}`);
  }
  return [...new Set(errors)];
}

export function createGuiReceiptWeb({ context, data, semanticVerdict, atomicCoverage, teamqa, createdAt = new Date().toISOString() }) {
  if (!teamqa?.dispatch_proof || !teamqa?.teamqa_provenance) throw new Error('TEAMQA_GUI_PROVENANCE_REQUIRED');
  const receipt = sealObject({
    schema: GUI_RECEIPT_WEB_V1,
    contract_sha256: context.contractSha256,
    run_uuid: data.runUuid,
    requirements_hash: context.requirementsHash,
    verification_lane: 'gui',
    target_kind: 'deployed-build',
    target_binding_sha256: context.targetBindingSha256,
    target: context.target,
    execution_status: 'completed',
    semantic_verdict: semanticVerdict,
    atomic_coverage: atomicCoverage,
    evidence_manifest: data.evidenceManifest,
    created_at: createdAt,
    ...teamqa,
  });
  const errors = validateGuiReceipt(receipt);
  if (errors.length) throw new Error('QA_GUI_WEB_RECEIPT_INVALID:' + errors.join(','));
  return receipt;
}

export function verifyGuiWebReceiptBindings(receipt, { context, evidenceRoot } = {}) {
  const errors = validateGuiReceipt(receipt);
  if (receipt?.schema !== GUI_RECEIPT_WEB_V1) return [...new Set(errors)];
  if (!context || context.kind !== 'deployed-build' || context.sourceProof?.target_binding_sha256 !== context.targetBindingSha256) return [...new Set([...errors, 'VERIFIED_WEB_CONTEXT_REQUIRED'])];
  if (receipt.contract_sha256 !== WEB_CONTRACT_SHA256 || receipt.contract_sha256 !== context.contractSha256) errors.push('WEB_CONTRACT_SHA_MISMATCH');
  if (receipt.run_uuid !== context.binding.run_uuid) errors.push('RUN_UUID_MISMATCH');
  if (receipt.requirements_hash !== context.requirementsHash) errors.push('REQUIREMENTS_HASH_MISMATCH');
  if (receipt.target_binding_sha256 !== context.targetBindingSha256) errors.push('TARGET_BINDING_SHA_MISMATCH');
  if (canonicalJson(receipt.target) !== canonicalJson(context.target)) errors.push('WEB_TARGET_MISMATCH');
  const inspected = inspectEvidenceManifest(receipt.evidence_manifest, {
    evidenceRoot, runUuid: receipt.run_uuid, targetBindingSha256: context.targetBindingSha256,
  });
  errors.push(...inspected.errors);
  const required = new Map(context.activeGuiRequirements.map((item) => [item.id, item]));
  const covered = new Set();
  const assertions = new Set();
  for (const row of receipt.atomic_coverage ?? []) {
    if (assertions.has(row.assertion_id)) errors.push('ATOMIC_ASSERTION_DUPLICATE:' + row.assertion_id);
    assertions.add(row.assertion_id);
    const requirement = required.get(row.requirement_id);
    if (!requirement) { errors.push('ATOMIC_REQUIREMENT_OUTSIDE_GUI_LANE:' + row.requirement_id); continue; }
    const planCase = context.planById.get(row.case_id);
    if (!planCase || planCase.requirementId !== row.requirement_id || !requirement.acceptance_ids.includes(row.case_id)) errors.push('ATOMIC_CASE_NOT_BOUND:' + row.case_id);
    covered.add(row.requirement_id);
    const evidence = inspected.paths.get(row.evidence_ref);
    if (!evidence || evidence.entry.sha256 !== row.evidence_sha256 || evidence.entry.evidence_type !== row.evidence_type || evidence.entry.metadata?.case_id !== row.case_id) errors.push('ATOMIC_EVIDENCE_MISMATCH:' + row.evidence_ref);
    if (!requirement.evidence_contract.allowed_types.includes(row.evidence_type) || (row.result === 'PASS' && !row.evidence_type.startsWith('gui-'))) errors.push('EVIDENCE_TYPE_MISMATCH:' + row.requirement_id);
  }
  const missing = [...required.keys()].filter((id) => !covered.has(id));
  if (missing.length) errors.push('ATOMIC_COVERAGE_MISSING:' + missing.join(','));
  return [...new Set(errors)];
}
