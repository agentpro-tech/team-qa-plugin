import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_DIR = join(ROOT, 'contracts', 'release-truth-contract', 'v2');
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LANES = ['code', 'gui', 'machine', 'multi'];
const REQUIRED_LAYERS = ['code', 'gui', 'machine', 'team-qa'];
const RISK_DIMENSIONS = [
  'invariant-validation',
  'live-projection-cache',
  'user-facing-validation',
  'stable-identity',
  'ordered-setup',
  'surface-parity',
];
export const WEB_CONTRACT_SHA256 = 'c4961eaa1e1915e567d357fc49d4472d75167c51f388e348e6ac11af790d7d5d';

export class ReleaseTruthError extends Error {
  constructor(message, code = 20) {
    super(message);
    this.code = code;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const must = (condition, message, code = 20) => {
  if (!condition) throw new ReleaseTruthError(message, code);
};

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function strict(value, required, allowed, label) {
  must(object(value), `${label}:OBJECT_REQUIRED`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  must(unknown.length === 0, `${label}:UNKNOWN_FIELD:${unknown.join(',')}`);
  for (const key of required) must(Object.hasOwn(value, key), `${label}:MISSING_FIELD:${key}`);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ReleaseTruthError(`${label}_JSON:${error.message}`);
  }
}

function git(repo, args) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new ReleaseTruthError(`GIT_CONTEXT:${result.stderr?.trim() || result.error?.message || args.join(' ')}`);
  }
  return result.stdout.trim();
}

function regularFileInsideRepo(file, repo, label) {
  let real;
  try {
    real = realpathSync(resolve(file));
    const stat = lstatSync(real);
    must(stat.isFile() && !stat.isSymbolicLink(), `${label}_NOT_REGULAR`);
  } catch (error) {
    if (error instanceof ReleaseTruthError) throw error;
    throw new ReleaseTruthError(`${label}_UNREADABLE:${error.message}`);
  }
  const rel = relative(repo, real);
  must(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label}_OUTSIDE_REPO`);
  return real;
}

export function readContract() {
  const manifest = readJson(join(CONTRACT_DIR, 'CONTRACT.json'), 'CONTRACT');
  const observed = {};
  for (const file of readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.schema.json')).sort()) {
    const raw = readFileSync(join(CONTRACT_DIR, file));
    const schema = JSON.parse(raw);
    observed[schema.title] = sha256(raw);
  }
  must(canonicalJson(observed) === canonicalJson(manifest.schemas), 'CONTRACT_SCHEMA_HASH_MISMATCH');
  must(sha256(canonicalJson(observed)) === manifest.contract_sha256, 'CONTRACT_DIGEST_MISMATCH');
  return manifest;
}

export function readRequirementsFreeze(file) {
  const graph = readJson(file, 'REQUIREMENT_GRAPH');
  if (graph?.schema !== 'requirements.freeze/v2') {
    if (Array.isArray(graph?.requirements)
      && graph.requirements.some((item) => Object.hasOwn(item, 'verdict') || Object.hasOwn(item, 'evidence_refs'))) {
      throw new ReleaseTruthError('FROZEN_RESULT_FORBIDDEN');
    }
    throw new ReleaseTruthError(`REQUIREMENT_GRAPH_SCHEMA:${graph?.schema || 'missing'}`);
  }

  const contract = readContract();
  const graphKeys = ['schema', 'contract_sha256', 'repo', 'task_base', 'source_revision', 'gate_policy', 'requirements'];
  strict(graph, graphKeys, graphKeys, 'requirements.freeze/v2');
  must(graph.contract_sha256 === contract.contract_sha256, 'REQUIREMENT_CONTRACT_SHA');
  must(typeof graph.repo === 'string' && graph.repo.trim(), 'REQUIREMENT_REPO');
  must(SHA40.test(graph.task_base), 'REQUIREMENT_TASK_BASE');
  must(typeof graph.source_revision === 'string' && graph.source_revision.trim(), 'REQUIREMENT_SOURCE_REVISION');
  strict(graph.gate_policy, ['coverage_threshold', 'required_layers'], ['coverage_threshold', 'required_layers'], 'gate_policy');
  must(Number.isInteger(graph.gate_policy.coverage_threshold)
    && graph.gate_policy.coverage_threshold >= 0
    && graph.gate_policy.coverage_threshold <= 100, 'GATE_THRESHOLD');
  must(Array.isArray(graph.gate_policy.required_layers)
    && graph.gate_policy.required_layers.length > 0
    && new Set(graph.gate_policy.required_layers).size === graph.gate_policy.required_layers.length
    && graph.gate_policy.required_layers.every((item) => REQUIRED_LAYERS.includes(item)), 'GATE_LAYERS');
  must(Array.isArray(graph.requirements) && graph.requirements.length > 0, 'REQUIREMENTS_EMPTY');

  const ids = new Set();
  for (const requirement of graph.requirements) {
    const required = [
      'id', 'expectation', 'requirement_owner', 'verification_lane',
      'risk_dimensions', 'acceptance_ids', 'evidence_contract',
    ];
    strict(requirement, required, [...required, 'waiver'], `requirement:${requirement?.id || 'unknown'}`);
    must(typeof requirement.id === 'string' && requirement.id.trim() && !ids.has(requirement.id), `REQUIREMENT_ID:${requirement.id || 'missing'}`);
    ids.add(requirement.id);
    must(typeof requirement.expectation === 'string' && requirement.expectation.trim(), `REQUIREMENT_EXPECTATION:${requirement.id}`);
    must(typeof requirement.requirement_owner === 'string' && requirement.requirement_owner.trim(), `REQUIREMENT_OWNER:${requirement.id}`);
    must(LANES.includes(requirement.verification_lane), `REQUIREMENT_LANE:${requirement.id}`);
    must(Array.isArray(requirement.risk_dimensions)
      && new Set(requirement.risk_dimensions).size === requirement.risk_dimensions.length
      && requirement.risk_dimensions.every((item) => RISK_DIMENSIONS.includes(item)), `REQUIREMENT_RISK:${requirement.id}`);
    must(Array.isArray(requirement.acceptance_ids)
      && requirement.acceptance_ids.length > 0
      && new Set(requirement.acceptance_ids).size === requirement.acceptance_ids.length
      && requirement.acceptance_ids.every((item) => typeof item === 'string' && item.trim()), `REQUIREMENT_ACCEPTANCE_IDS:${requirement.id}`);
    strict(
      requirement.evidence_contract,
      ['allowed_types', 'atomic', 'multi_evidence'],
      ['allowed_types', 'atomic', 'multi_evidence'],
      `evidence_contract:${requirement.id}`,
    );
    must(requirement.evidence_contract.atomic === true
      && typeof requirement.evidence_contract.multi_evidence === 'boolean'
      && Array.isArray(requirement.evidence_contract.allowed_types)
      && requirement.evidence_contract.allowed_types.length > 0
      && new Set(requirement.evidence_contract.allowed_types).size === requirement.evidence_contract.allowed_types.length
      && requirement.evidence_contract.allowed_types.every((item) => typeof item === 'string' && item.trim()), `EVIDENCE_CONTRACT:${requirement.id}`);
    if (requirement.waiver !== undefined) {
      strict(requirement.waiver, ['type', 'reason', 'approver'], ['type', 'reason', 'approver'], `waiver:${requirement.id}`);
      must(['not-applicable', 'external-owner'].includes(requirement.waiver.type)
        && typeof requirement.waiver.reason === 'string' && requirement.waiver.reason.trim()
        && typeof requirement.waiver.approver === 'string' && requirement.waiver.approver.trim(), `WAIVER_INVALID:${requirement.id}`);
    }
  }
  return graph;
}

export function readWebRequirementsFreeze(file) {
  const graph = readJson(file, 'REQUIREMENT_GRAPH');
  if (graph?.schema !== 'requirements.freeze/web-v1') throw new ReleaseTruthError(`REQUIREMENT_GRAPH_SCHEMA:${graph?.schema || 'missing'}`);
  const keys = ['schema', 'contract_sha256', 'source_revision', 'target_binding_sha256', 'gate_policy', 'requirements'];
  strict(graph, keys, keys, 'requirements.freeze/web-v1');
  must(graph.contract_sha256 === WEB_CONTRACT_SHA256, 'WEB_REQUIREMENT_CONTRACT_SHA');
  must(typeof graph.source_revision === 'string' && graph.source_revision.trim(), 'REQUIREMENT_SOURCE_REVISION');
  must(SHA256.test(graph.target_binding_sha256), 'WEB_REQUIREMENT_TARGET_HASH_INVALID');
  strict(graph.gate_policy, ['coverage_threshold', 'required_layers'], ['coverage_threshold', 'required_layers'], 'gate_policy');
  must(Number.isInteger(graph.gate_policy.coverage_threshold) && graph.gate_policy.coverage_threshold >= 0 && graph.gate_policy.coverage_threshold <= 100, 'GATE_THRESHOLD');
  must(Array.isArray(graph.gate_policy.required_layers) && graph.gate_policy.required_layers.length === 1 && graph.gate_policy.required_layers[0] === 'gui', 'WEB_GATE_LAYERS');
  must(Array.isArray(graph.requirements) && graph.requirements.length > 0, 'REQUIREMENTS_EMPTY');
  const ids = new Set();
  for (const requirement of graph.requirements) {
    const required = ['id', 'expectation', 'requirement_owner', 'verification_lane', 'risk_dimensions', 'acceptance_ids', 'evidence_contract'];
    strict(requirement, required, [...required, 'waiver'], `requirement:${requirement?.id || 'unknown'}`);
    must(typeof requirement.id === 'string' && requirement.id.trim() && !ids.has(requirement.id), `REQUIREMENT_ID:${requirement.id || 'missing'}`);
    ids.add(requirement.id);
    must(typeof requirement.expectation === 'string' && requirement.expectation.trim(), `REQUIREMENT_EXPECTATION:${requirement.id}`);
    must(typeof requirement.requirement_owner === 'string' && requirement.requirement_owner.trim(), `REQUIREMENT_OWNER:${requirement.id}`);
    must(requirement.verification_lane === 'gui', `WEB_REQUIREMENT_LANE:${requirement.id}`);
    must(Array.isArray(requirement.risk_dimensions) && new Set(requirement.risk_dimensions).size === requirement.risk_dimensions.length && requirement.risk_dimensions.every((item) => RISK_DIMENSIONS.includes(item)), `REQUIREMENT_RISK:${requirement.id}`);
    must(Array.isArray(requirement.acceptance_ids) && requirement.acceptance_ids.length > 0 && new Set(requirement.acceptance_ids).size === requirement.acceptance_ids.length && requirement.acceptance_ids.every((item) => typeof item === 'string' && item.trim()), `REQUIREMENT_ACCEPTANCE_IDS:${requirement.id}`);
    strict(requirement.evidence_contract, ['allowed_types', 'atomic', 'multi_evidence'], ['allowed_types', 'atomic', 'multi_evidence'], `evidence_contract:${requirement.id}`);
    must(requirement.evidence_contract.atomic === true && typeof requirement.evidence_contract.multi_evidence === 'boolean' && Array.isArray(requirement.evidence_contract.allowed_types) && requirement.evidence_contract.allowed_types.length > 0 && new Set(requirement.evidence_contract.allowed_types).size === requirement.evidence_contract.allowed_types.length && requirement.evidence_contract.allowed_types.every((item) => typeof item === 'string' && item.trim()), `EVIDENCE_CONTRACT:${requirement.id}`);
  }
  return graph;
}

function lockEntry(lock, file, label) {
  const candidates = Object.entries(lock.files).filter(([key]) => basename(key) === basename(file));
  must(candidates.length === 1, `BRIEF_LOCK_${label}_MISSING:${basename(file)}`);
  const [key, expected] = candidates[0];
  must(SHA256.test(expected), `BRIEF_LOCK_${label}_HASH:${key}`);
  must(expected === sha256(readFileSync(file)), `BRIEF_LOCK_${label}_HASH_MISMATCH:${key}`);
  return key;
}

function discoverPlanFile(lock, lockDir, graphFile) {
  const candidates = Object.keys(lock.files)
    .filter((key) => basename(key) !== basename(graphFile) && /plan/i.test(basename(key)))
    .map((key) => resolve(lockDir, key));
  must(candidates.length === 1, 'BRIEF_LOCK_TRACKED_PLAN_AMBIGUOUS');
  return candidates[0];
}

function readBriefLock(lockFile, graphFile, graph, requestedPlan, repo) {
  const lock = readJson(lockFile, 'BRIEF_LOCK');
  const keys = [
    'schema', 'frozen_at', 'files', 'acceptance_registry_sha256',
    'task_base', 'source_revision', 'gate_policy', 'exact_final_sha',
  ];
  strict(lock, keys, keys, 'team-code/brief-lock/v3');
  must(lock.schema === 'team-code/brief-lock/v3', `BRIEF_LOCK_SCHEMA:${lock.schema || 'missing'}`);
  must(typeof lock.frozen_at === 'string' && !Number.isNaN(Date.parse(lock.frozen_at)), 'BRIEF_LOCK_TIME');
  must(object(lock.files), 'BRIEF_LOCK_FILES');
  must(Object.values(lock.files).every((value) => SHA256.test(value)), 'BRIEF_LOCK_FILE_HASH');
  lockEntry(lock, graphFile, 'GRAPH');
  must(SHA256.test(lock.acceptance_registry_sha256), 'BRIEF_LOCK_ACCEPTANCE_HASH');
  must(lock.task_base === graph.task_base, 'BRIEF_LOCK_TASK_BASE_MISMATCH');
  must(lock.source_revision === graph.source_revision, 'BRIEF_LOCK_SOURCE_REVISION_MISMATCH');
  must(canonicalJson(lock.gate_policy) === canonicalJson(graph.gate_policy), 'BRIEF_LOCK_GATE_POLICY_MISMATCH');
  must(lock.exact_final_sha === null || SHA40.test(lock.exact_final_sha), 'BRIEF_LOCK_EXACT_FINAL_SHA');

  const candidate = requestedPlan || discoverPlanFile(lock, dirname(lockFile), graphFile);
  const planFile = regularFileInsideRepo(candidate, repo, 'TRACKED_PLAN');
  lockEntry(lock, planFile, 'PLAN');
  return { lock, planFile };
}

function readTrackedPlan(file, graph) {
  const plan = readJson(file, 'TRACKED_PLAN');
  must(object(plan) && Array.isArray(plan.cases) && plan.cases.length > 0, 'TRACKED_PLAN_CASES');
  const graphIds = new Set(graph.requirements.map((item) => item.id));
  const caseIds = new Set();
  const byId = new Map();
  for (const [index, entry] of plan.cases.entries()) {
    must(object(entry), `TRACKED_PLAN_CASE_OBJECT:${index}`);
    must(typeof entry.id === 'string' && entry.id.trim() && !caseIds.has(entry.id), `TRACKED_PLAN_CASE_ID:${entry.id || index}`);
    const requirementId = entry.req_id ?? entry.requirement_id;
    must(typeof requirementId === 'string' && graphIds.has(requirementId), `TRACKED_PLAN_REQUIREMENT:${entry.id}:${requirementId || 'missing'}`);
    caseIds.add(entry.id);
    byId.set(entry.id, { ...entry, requirementId });
  }
  return { plan, byId };
}

export function requirementsHash(graph) {
  return sha256(canonicalJson(graph));
}

export function readGuiReleaseTruthContext(requirementsFile, { plan = null, repo } = {}) {
  let repoReal;
  try { repoReal = realpathSync(repo); }
  catch (error) { throw new ReleaseTruthError(`REPO_UNREADABLE:${error.message}`); }
  const graphFile = regularFileInsideRepo(requirementsFile, repoReal, 'REQUIREMENT_GRAPH');
  const graph = readRequirementsFreeze(graphFile);
  let graphRepo;
  try { graphRepo = realpathSync(graph.repo); }
  catch { throw new ReleaseTruthError('REQUIREMENT_REPO_UNREADABLE'); }
  must(graphRepo === repoReal, 'REQUIREMENT_REPO_MISMATCH');

  const lockFile = join(dirname(graphFile), 'LOCK.json');
  const requestedPlan = plan ? regularFileInsideRepo(plan, repoReal, 'TRACKED_PLAN') : null;
  const { lock, planFile } = readBriefLock(lockFile, graphFile, graph, requestedPlan, repoReal);
  const { plan: trackedPlan, byId: planById } = readTrackedPlan(planFile, graph);
  const exactFinalSha = git(repoReal, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const taskBase = git(repoReal, ['rev-parse', '--verify', `${graph.task_base}^{commit}`]);
  must(taskBase === graph.task_base, 'TASK_BASE_MISMATCH');
  must(git(repoReal, ['merge-base', graph.task_base, exactFinalSha]) === graph.task_base, 'TASK_BASE_NOT_ANCESTOR');
  if (lock.exact_final_sha !== null) must(lock.exact_final_sha === exactFinalSha, 'EXACT_FINAL_SHA_MISMATCH');

  const guiRequirements = graph.requirements.filter((item) => ['gui', 'multi'].includes(item.verification_lane));
  const activeGuiRequirements = guiRequirements.filter((item) => item.waiver === undefined);
  must(guiRequirements.length > 0, 'GUI_REQUIREMENTS_EMPTY');
  for (const requirement of activeGuiRequirements) {
    const mapped = [...planById.values()].filter((entry) => entry.requirementId === requirement.id);
    must(mapped.length > 0, `TRACKED_PLAN_GUI_REQUIREMENT_MISSING:${requirement.id}`);
    must(mapped.some((entry) => requirement.acceptance_ids.includes(entry.id)), `TRACKED_PLAN_ACCEPTANCE_ID_MISMATCH:${requirement.id}`);
  }

  return {
    contract: readContract(),
    graph,
    graphFile,
    lock,
    lockFile,
    trackedPlan,
    planFile,
    planById,
    requirementsHash: requirementsHash(graph),
    repo: repoReal,
    taskBase: graph.task_base,
    sourceRevision: graph.source_revision,
    exactFinalSha,
    guiRequirements,
    activeGuiRequirements,
    guiIds: activeGuiRequirements.map((item) => item.id),
  };
}

export function readGuiWebContext({ bindingPath, requirementsPath, planPath, runDir, verifyWebBinding }) {
  must(typeof verifyWebBinding === 'function', 'WEB_BINDING_VERIFIER_REQUIRED');
  const root = realpathSync(runDir);
  const bindingFile = regularFileInsideRepo(bindingPath, root, 'WEB_BINDING');
  const graphFile = regularFileInsideRepo(requirementsPath, root, 'REQUIREMENT_GRAPH');
  const trackedPlanFile = regularFileInsideRepo(planPath, root, 'TRACKED_PLAN');
  const binding = readJson(bindingFile, 'WEB_BINDING');
  const graph = readWebRequirementsFreeze(graphFile);
  const hash = requirementsHash(graph);
  strict(binding, ['schema', 'run_uuid', 'requirements_hash', 'contract_sha256', 'verification_lane', 'target_kind', 'target_binding_sha256', 'target'], ['schema', 'run_uuid', 'requirements_hash', 'contract_sha256', 'verification_lane', 'target_kind', 'target_binding_sha256', 'target'], 'team-qa/web-binding/v1');
  must(binding.schema === 'team-qa/web-binding/v1', 'WEB_BINDING_SCHEMA');
  must(binding.contract_sha256 === WEB_CONTRACT_SHA256 && binding.requirements_hash === hash, 'WEB_CONTRACT_OR_REQUIREMENTS_MISMATCH');
  must(binding.verification_lane === 'gui' && binding.target_kind === 'deployed-build', 'WEB_GUI_ONLY_REQUIRED');
  must(SHA256.test(binding.target_binding_sha256), 'WEB_TARGET_BINDING_SHA_INVALID');
  must(graph.target_binding_sha256 === binding.target_binding_sha256, 'WEB_GRAPH_TARGET_BINDING_MISMATCH');
  const verified = verifyWebBinding(binding, { target: binding.target, requirementsHash: hash, runDir: root });
  must(verified?.binding === binding && verified.proof?.target_binding_sha256 === binding.target_binding_sha256, 'WEB_BINDING_VERIFICATION_FAILED');
  const { plan: trackedPlan, byId: planById } = readTrackedPlan(trackedPlanFile, graph);
  const guiRequirements = graph.requirements;
  const activeGuiRequirements = guiRequirements.filter((item) => item.waiver === undefined);
  for (const requirement of activeGuiRequirements) {
    const mapped = [...planById.values()].filter((entry) => entry.requirementId === requirement.id);
    must(mapped.length > 0 && mapped.some((entry) => requirement.acceptance_ids.includes(entry.id)), `TRACKED_PLAN_GUI_REQUIREMENT_MISSING:${requirement.id}`);
  }
  return { kind: 'deployed-build', binding, bindingFile, sourceProof: verified.proof, graph, graphFile, trackedPlan,
    planFile: trackedPlanFile, planById, requirementsHash: hash, contractSha256: WEB_CONTRACT_SHA256,
    target: binding.target, targetBindingSha256: binding.target_binding_sha256, guiRequirements, activeGuiRequirements,
    guiIds: activeGuiRequirements.map((item) => item.id) };
}

export function webTargetIdentity(target) {
  const { target_binding_sha256, identity_proof, ...identity } = target;
  return identity;
}

export function webTargetBindingSha256(target) {
  const sort = value => Array.isArray(value) ? value.map(sort) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return sha256(JSON.stringify(sort(webTargetIdentity(target)), null, 2) + '\n');
}

export function webBindingAfterAttestation(binding, { runDir }) {
  must(binding?.target?.kind === 'deployed-build', 'WEB_TARGET_INVALID');
  must(binding.target_binding_sha256 === webTargetBindingSha256(binding.target) && binding.target.target_binding_sha256 === binding.target_binding_sha256, 'WEB_TARGET_HASH_MISMATCH');
  const root = realpathSync(runDir);
  const proofFile = regularFileInsideRepo(resolve(root, binding.target.identity_proof?.path || ''), root, 'WEB_IDENTITY_PROOF');
  const raw = readFileSync(proofFile);
  must(sha256(raw) === binding.target.identity_proof.sha256, 'WEB_IDENTITY_PROOF_HASH_MISMATCH');
  const proof = JSON.parse(raw);
  must(proof.schema === 'team-qa/deployed-identity-proof/v1' && proof.target_binding_sha256 === binding.target_binding_sha256 && canonicalJson(proof.identity) === canonicalJson(webTargetIdentity(binding.target)) && Array.isArray(proof.sources) && proof.sources.length > 0, 'WEB_IDENTITY_PROOF_INVALID');
  return { binding, proof: { target_binding_sha256: binding.target_binding_sha256, proof_path: proofFile, proof_sha256: binding.target.identity_proof.sha256 } };
}

export const releaseTruthInternals = { CONTRACT_DIR, SHA40, SHA256 };
