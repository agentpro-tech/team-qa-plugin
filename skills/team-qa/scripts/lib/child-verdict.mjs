import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256, stableJson } from './core.mjs';
import { isDeployedTarget, assertWebBinding, canonicalDeployedTarget, deployedTargetShapeErrors, WEB_CONTRACT_SHA256 } from './deployed-target.mjs';
import { CONTRACT_SHA256, integrityFor } from './release-truth.mjs';

// A PASS on the board is the conclusion of a child gate, not of whoever wrote the record.
// So a PASS record must point to a verdict artifact produced by the child skill, with
// a hash that locks the exact content of that artifact, and that content must carry the verdict itself.
// An evidence file that only says "PASS" cannot replace this binding.
const CHILD_FIELDS = ['skill', 'verdict', 'artifact', 'sha256'];
export const CHILD_SKILLS = ['qa-gui', 'qa-code'];
const CHILD_VERDICTS = ['pass', 'fail', 'ungraded'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function digest(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// A wrong shape also means there is no binding: do not guess a missing field, do not
// patch the hash.
export function childVerdictShapeErrors(value, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${prefix} child_verdict`];
  const errors = [];
  if (!CHILD_SKILLS.includes(value.skill)) errors.push(`${prefix} child_verdict.skill`);
  if (!CHILD_VERDICTS.includes(value.verdict)) errors.push(`${prefix} child_verdict.verdict`);
  if (!nonEmpty(value.artifact)) errors.push(`${prefix} child_verdict.artifact`);
  if (!SHA256_HEX.test(digest(value.sha256))) errors.push(`${prefix} child_verdict.sha256`);
  for (const key of Object.keys(value)) {
    if (!CHILD_FIELDS.includes(key)) errors.push(`${prefix} child_verdict.${key}`);
  }
  return errors;
}

// The artifact must be machine-readable JSON that declares its own verdict. If it cannot be read or
// declares none, there is no child conclusion yet.
function artifactClaim(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!nonEmpty(parsed.schema)) return null;
  return parsed;
}

// Verdict of one case from its atomic rows in a QA GUI receipt: pass when every row is PASS, fail when any is FAIL,
// otherwise (no rows, or a row UNGRADED) ungraded.
export function caseRowsVerdict(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'ungraded';
  if (rows.some((row) => row?.result === 'FAIL')) return 'fail';
  return rows.every((row) => row?.result === 'PASS') ? 'pass' : 'ungraded';
}

// null means the PASS record has a valid bound child verdict; a returned string
// is the reason to fail closed, used verbatim as the reason of the ungraded record.
export function childVerdictIssue(record, boardPath, lock, binding = null, expectedRequirementId = null) {
  if (!lock?.governed) return null;
  if (!['pass', 'fail'].includes(record?.verdict)) return null;
  const bound = record.child_verdict;
  if (!bound || childVerdictShapeErrors(bound, 'X').length > 0) return 'CHILD_VERDICT_MISSING';
  if (bound.verdict !== record.verdict) return 'CHILD_VERDICT_CONFLICT';
  if (record.source !== bound.skill) return 'CHILD_VERDICT_SKILL_MISMATCH';
  const base = dirname(boardPath);
  const artifact = resolve(base, bound.artifact);
  const declared = Array.isArray(record.evidence)
    ? record.evidence.filter(nonEmpty).map((item) => resolve(base, item))
    : [];
  // The artifact must be inside the record's own evidence: the child conclusion and the
  // case's evidence must not be two disjoint sets.
  if (!declared.includes(artifact)) return 'CHILD_VERDICT_NOT_EVIDENCE';
  let raw;
  try {
    raw = readFileSync(artifact);
  } catch {
    return 'CHILD_VERDICT_UNREADABLE';
  }
  if (sha256(raw) !== digest(bound.sha256)) return 'CHILD_VERDICT_HASH';
  const claim = artifactClaim(raw);
  if (!claim) return 'CHILD_VERDICT_ARTIFACT_INVALID';
  if (binding) {
    if (binding.schema === 'team-qa/web-binding/v1') {
      try { assertWebBinding(binding, { target: record.target, requireProof: false }); }
      catch { return 'CHILD_WEB_BINDING_INVALID'; }
      if (!isDeployedTarget(record.target) || bound.skill !== 'qa-gui') return 'CHILD_WEB_GUI_ONLY';
      if (claim.schema !== 'qa-gui/receipt/web-v1') return 'CHILD_RECEIPT_SCHEMA';
      if (claim.contract_sha256 !== WEB_CONTRACT_SHA256 || claim.contract_sha256 !== binding.contract_sha256) return 'CHILD_RECEIPT_CONTRACT';
      if (integrityFor(claim) !== claim.integrity) return 'CHILD_RECEIPT_INTEGRITY';
      if (claim.run_uuid !== binding.run_uuid || claim.requirements_hash !== binding.requirements_hash) return 'CHILD_RECEIPT_SOURCE_BINDING';
      if (claim.verification_lane !== 'gui' || claim.target_kind !== 'deployed-build' || claim.target_binding_sha256 !== binding.target_binding_sha256 || deployedTargetShapeErrors(claim.target).length || stableJson(canonicalDeployedTarget(claim.target)) !== stableJson(canonicalDeployedTarget(binding.target))) return 'CHILD_WEB_TARGET_MISMATCH';
      if (['task_base','source_revision','exact_final_sha','head','commit'].some(key => Object.hasOwn(claim,key))) return 'CHILD_WEB_GIT_FIELD';
      // A case-scoped receipt (qa-gate --case, attested by that case's own GUI dispatch; upgrade U2) grades its case
      // from the case's own atomic rows, so another case's FAIL on the same board does not block this one.
      const scope = claim.teamqa_provenance?.case_id;
      if (scope !== undefined && scope !== record.case_id) return 'CHILD_RECEIPT_CASE_SCOPE';
      const rows = Array.isArray(claim.atomic_coverage) ? claim.atomic_coverage.filter(row => row?.case_id === record.case_id) : [];
      const expectedClaim = scope === undefined ? String(claim.semantic_verdict || '').toLowerCase() : caseRowsVerdict(rows);
      if (claim.execution_status !== 'completed' || expectedClaim !== bound.verdict) return 'CHILD_VERDICT_ARTIFACT_MISMATCH';
      if (!rows.length) return 'CHILD_RECEIPT_CASE_MISSING';
      if (expectedRequirementId && !rows.some(row => row?.requirement_id === expectedRequirementId)) return 'CHILD_RECEIPT_REQUIREMENT_MISMATCH';
      const expected = bound.verdict.toUpperCase();
      if (bound.verdict === 'pass' ? rows.some(row => row?.result !== expected) : !rows.some(row => row?.result === expected)) return 'CHILD_RECEIPT_CASE_VERDICT';
      return null;
    }
    const expectedSchema = bound.skill === 'qa-gui' ? 'qa-gui/receipt/v2' : 'qa-code/receipt/v2';
    if (claim.schema !== expectedSchema) return 'CHILD_RECEIPT_SCHEMA';
    if (claim.contract_sha256 !== CONTRACT_SHA256 || claim.contract_sha256 !== binding.contract_sha256) {
      return 'CHILD_RECEIPT_CONTRACT';
    }
    if (integrityFor(claim) !== claim.integrity) return 'CHILD_RECEIPT_INTEGRITY';
    if (claim.run_uuid !== (binding.run_uuid || record.run_id)) return 'CHILD_RECEIPT_RUN_UUID';
    if (claim.task_base !== binding.task_base || claim.source_revision !== binding.source_revision) {
      return 'CHILD_RECEIPT_SOURCE_BINDING';
    }
    const exactFinalSha = bound.skill === 'qa-gui' ? claim.exact_final_sha : claim.head;
    if (exactFinalSha !== binding.exact_final_sha) return 'CHILD_RECEIPT_EXACT_SHA';
    if (claim.requirements_hash !== binding.requirements_hash) return 'CHILD_RECEIPT_REQUIREMENTS_HASH';
    if (claim.verification_lane !== (bound.skill === 'qa-gui' ? 'gui' : 'code')) return 'CHILD_RECEIPT_LANE';
    if (claim.execution_status !== 'completed') return 'CHILD_RECEIPT_EXECUTION_STATUS';
    const semantic = String(claim.semantic_verdict || '').toLowerCase();
    if (semantic !== bound.verdict) return 'CHILD_VERDICT_ARTIFACT_MISMATCH';
    const caseRows = Array.isArray(claim.atomic_coverage)
      ? claim.atomic_coverage.filter((row) => row?.case_id === record.case_id)
      : [];
    if (caseRows.length === 0) return 'CHILD_RECEIPT_CASE_MISSING';
    if (expectedRequirementId && !caseRows.some((row) => row?.requirement_id === expectedRequirementId)) {
      return 'CHILD_RECEIPT_REQUIREMENT_MISMATCH';
    }
    const expectedResult = bound.verdict.toUpperCase();
    if (bound.verdict === 'pass' && caseRows.some((row) => row?.result !== expectedResult)) {
      return 'CHILD_RECEIPT_CASE_VERDICT';
    }
    if (bound.verdict === 'fail' && !caseRows.some((row) => row?.result === expectedResult)) {
      return 'CHILD_RECEIPT_CASE_VERDICT';
    }
    return null;
  }
  const verdict = nonEmpty(claim.verdict) ? claim.verdict.trim().toLowerCase() : null;
  if (verdict !== bound.verdict) return verdict ? 'CHILD_VERDICT_ARTIFACT_MISMATCH' : 'CHILD_VERDICT_ARTIFACT_INVALID';
  if (!claim.schema.startsWith(`${bound.skill}/`)) return 'CHILD_VERDICT_ARTIFACT_SKILL';
  return null;
}
