import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
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

export class ReleaseTruthError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

const must = (condition, message, code = 2) => {
  if (!condition) throw new ReleaseTruthError(message, code);
};

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function readContract() {
  const manifest = readJson(join(CONTRACT_DIR, 'CONTRACT.json'), 'CONTRACT');
  const observed = {};
  for (const file of readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.schema.json')).sort()) {
    const raw = readFileSync(join(CONTRACT_DIR, file));
    const schema = JSON.parse(raw);
    observed[schema.title] = sha256(raw);
  }
  must(canonicalJson(observed) === canonicalJson(manifest.schemas), 'CONTRACT_SCHEMA_HASH_MISMATCH', 20);
  must(sha256(canonicalJson(observed)) === manifest.contract_sha256, 'CONTRACT_DIGEST_MISMATCH', 20);
  return manifest;
}

export function readRequirementsFreeze(file) {
  const graph = readJson(file, 'REQUIREMENT_GRAPH');
  if (graph?.schema !== 'requirements.freeze/v2') {
    if (Array.isArray(graph?.requirements)
      && graph.requirements.some((item) => Object.hasOwn(item, 'verdict') || Object.hasOwn(item, 'evidence_refs'))) {
      throw new ReleaseTruthError('FROZEN_RESULT_FORBIDDEN', 20);
    }
    throw new ReleaseTruthError(`REQUIREMENT_GRAPH_SCHEMA:${graph?.schema || 'missing'}`, 20);
  }

  const contract = readContract();
  const graphKeys = ['schema', 'contract_sha256', 'repo', 'task_base', 'source_revision', 'gate_policy', 'requirements'];
  strict(graph, graphKeys, graphKeys, 'requirements.freeze/v2');
  must(graph.contract_sha256 === contract.contract_sha256, 'REQUIREMENT_CONTRACT_SHA', 20);
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

function readBriefLock(file, graphFile, graph) {
  const lock = readJson(file, 'BRIEF_LOCK');
  const keys = [
    'schema', 'frozen_at', 'files', 'acceptance_registry_sha256',
    'task_base', 'source_revision', 'gate_policy', 'exact_final_sha',
  ];
  strict(lock, keys, keys, 'team-code/brief-lock/v3');
  must(lock.schema === 'team-code/brief-lock/v3', `BRIEF_LOCK_SCHEMA:${lock.schema || 'missing'}`, 20);
  must(typeof lock.frozen_at === 'string' && !Number.isNaN(Date.parse(lock.frozen_at)), 'BRIEF_LOCK_TIME', 20);
  must(object(lock.files), 'BRIEF_LOCK_FILES', 20);
  const graphName = basename(graphFile);
  must(SHA256.test(lock.files[graphName] || ''), `BRIEF_LOCK_GRAPH_MISSING:${graphName}`, 20);
  must(lock.files[graphName] === sha256(readFileSync(graphFile)), `BRIEF_LOCK_GRAPH_HASH_MISMATCH:${graphName}`, 20);
  must(SHA256.test(lock.acceptance_registry_sha256), 'BRIEF_LOCK_ACCEPTANCE_HASH', 20);
  must(lock.task_base === graph.task_base, 'BRIEF_LOCK_TASK_BASE_MISMATCH', 20);
  must(lock.source_revision === graph.source_revision, 'BRIEF_LOCK_SOURCE_REVISION_MISMATCH', 20);
  must(canonicalJson(lock.gate_policy) === canonicalJson(graph.gate_policy), 'BRIEF_LOCK_GATE_POLICY_MISMATCH', 20);
  must(lock.exact_final_sha === null || SHA40.test(lock.exact_final_sha), 'BRIEF_LOCK_EXACT_FINAL_SHA', 20);
  return lock;
}

export function requirementsHash(graph) {
  return sha256(canonicalJson(graph));
}

export function readReleaseTruthContext(file, { repo, taskBase, lane = 'code' } = {}) {
  let graphFile;
  try {
    graphFile = realpathSync(resolve(file));
    must(lstatSync(graphFile).isFile(), 'REQUIREMENT_GRAPH_NOT_REGULAR');
  } catch (error) {
    if (error instanceof ReleaseTruthError) throw error;
    throw new ReleaseTruthError(`REQUIREMENT_GRAPH_UNREADABLE:${error.message}`, 20);
  }
  const repoReal = realpathSync(repo);
  const rel = relative(repoReal, graphFile);
  must(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'REQUIREMENT_GRAPH_OUTSIDE_REPO', 20);
  const graph = readRequirementsFreeze(graphFile);
  let graphRepo;
  try { graphRepo = realpathSync(graph.repo); }
  catch { throw new ReleaseTruthError('REQUIREMENT_REPO_UNREADABLE', 20); }
  must(graphRepo === repoReal, 'REQUIREMENT_REPO_MISMATCH', 20);
  must(graph.task_base === taskBase, `TASK_BASE_MISMATCH:${graph.task_base}:${taskBase}`, 20);
  must(lane === 'code', `VERIFICATION_LANE_MISMATCH:code:${lane}`);

  const lockFile = join(dirname(graphFile), 'LOCK.json');
  const lock = readBriefLock(lockFile, graphFile, graph);
  const codeRequirements = graph.requirements.filter((item) => ['code', 'multi'].includes(item.verification_lane));
  must(codeRequirements.length > 0, 'CODE_REQUIREMENTS_EMPTY', 20);
  return {
    contract: readContract(),
    graph,
    graphFile,
    lock,
    lockFile,
    requirementsHash: requirementsHash(graph),
    codeRequirements,
    codeIds: codeRequirements.map((item) => item.id),
  };
}

export const releaseTruthInternals = { CONTRACT_DIR, SHA40, SHA256 };
