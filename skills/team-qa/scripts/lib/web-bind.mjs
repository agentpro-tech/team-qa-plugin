// Deployed-build (web) binding chain, eval compat 3 part B2: the requirements.freeze/web-v1 graph,
// the web binding plus roles overlay, and graded board records from a QA GUI web receipt. Each command
// writes an artifact the existing verifiers already demand and then runs those verifiers; none relaxes
// them. teamqa.mjs injects its own governance and board-intake helpers so the checks are the same code.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandPath, fail, parseFlags, readJson, readText, requireObject, safeRunId, sha256, sha256File, stableJson, writeConfirmed } from './core.mjs';
import { assertWebBinding, isDeployedTarget, WEB_CONTRACT_SHA256 } from './deployed-target.mjs';
import { readDeployedIdentityObservation } from './tool-preflight.mjs';
import { assertRunContract } from './run-contract.mjs';
import { assertApprovedRoster, verifyProviderInterface } from './roster.mjs';
import { boardRecordErrors, loadBoard, loadPlan, loadTracked } from './validators.mjs';
import { aggregateVerdict } from './dual-verdict.mjs';
import { caseRowsVerdict } from './child-verdict.mjs';
import { attemptHistoryIssue, attemptId, effectiveAttempt } from './attempt-sequence.mjs';
import { stable } from './release-truth.mjs';
import { SOURCE_TRACEABILITY_VERSION, TRACKED_PLAN_SCHEMA_VERSION } from './source-traceability.mjs';

export const WEB_REQUIREMENTS_FILE = 'requirements.web.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GRAPH_KEYS = ['schema', 'contract_sha256', 'source_revision', 'target_binding_sha256', 'gate_policy', 'requirements'];
const REQUIREMENT_KEYS = ['id', 'expectation', 'requirement_owner', 'verification_lane', 'risk_dimensions', 'acceptance_ids', 'evidence_contract'];
const EVIDENCE_KEYS = ['allowed_types', 'atomic', 'multi_evidence'];
// QA GUI release-truth-v2.mjs RISK_DIMENSIONS; the web reader accepts no other value.
const RISK_DIMENSIONS = ['invariant-validation', 'live-projection-cache', 'user-facing-validation', 'stable-identity', 'ordered-setup', 'surface-parity'];
const DIMENSION_VERDICTS = ['pass', 'fail', 'ungraded'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const firstError = (errors, exitCode = 2) => { if (errors.length) { const [code, ...detail] = errors[0].split(' '); fail(exitCode, code, detail.join(' ')); } };

function result(fields) { console.log(JSON.stringify({ verdict: 'pass', ...fields })); }

// TEAMQA_TARGET_* can only declare a Git target (lib/target-lock.mjs); with any of them set a deployed
// run would be locked to the wrong target kind.
function refuseTargetEnv() {
  const names = Object.keys(process.env).filter(name => name.startsWith('TEAMQA_TARGET_')).sort();
  if (names.length) fail(5, 'WEB_TARGET_ENV_SET', names.join(','), 'ungraded');
}

function runDirectory(runId) { return join(process.cwd(), 'runs', safeRunId(runId)); }

function deployedRoster(roster) {
  if (!isDeployedTarget(roster.target)) fail(2, 'WEB_TARGET_REQUIRED', 'roster target is not a deployed build');
  return roster;
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Real path of a file that may not exist yet: the nearest existing ancestor resolved, plus the rest.
// A dangling symlink on the way could later be written through, so it is refused.
function realNearest(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(current), ...rest); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      let link = false;
      try { link = lstatSync(current).isSymbolicLink(); } catch { link = false; }
      if (link) fail(5, 'WEB_ROLES_NOT_FILE', `${path} (dangling symlink)`, 'ungraded');
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

// Same bytes are an idempotent success; any other existing content is never overwritten.
function sameOrAbsent(path, text) {
  if (!existsSync(path)) return false;
  if (!statSync(path).isFile() || !readFileSync(path).equals(Buffer.from(text, 'utf8'))) fail(2, 'WEB_ARTIFACT_EXISTS', path);
  return true;
}
async function writeArtifact(path, text, tool) {
  if (sameOrAbsent(path, text)) return 'unchanged';
  await writeConfirmed(path, text, tool, { exclusive: true });
  return 'confirmed';
}

function lockedDocument(runDir, lock, name, expectedPath = null) {
  const artifact = lock?.artifacts?.[name];
  if (!object(artifact) || typeof artifact.path !== 'string') fail(3, 'WEB_DOCUMENT_UNLOCKED', name);
  const path = resolve(runDir, artifact.path);
  if (!existsSync(path) || sha256File(path) !== artifact.sha256) fail(3, 'WEB_DOCUMENT_STALE', name);
  if (expectedPath && (!existsSync(expectedPath) || realpathSync(path) !== realpathSync(expectedPath))) fail(3, 'WEB_DOCUMENT_PATH', `${name} ${artifact.path}`);
  return path;
}

function governedTracked(path, roster) {
  // The binding makes the run governed, so the coverage axes are enforced as they will be at EXECUTE.
  const tracked = loadTracked(path, { lock: { governed: true, source: 'roles', declared: roster.target } });
  firstError(tracked.errors);
  if (tracked.value.schemaVersion !== TRACKED_PLAN_SCHEMA_VERSION) fail(3, 'TRACKED_SOURCE_SCHEMA_REQUIRED');
  if (tracked.value.cases.length === 0) fail(2, 'WEB_TRACKED_EMPTY');
  for (const item of tracked.value.cases) if (item.lane !== 'gui') fail(2, 'WEB_CASE_LANE_NOT_GUI', `${item.id}:${item.lane}`);
  return tracked.value;
}

// Local equivalent of QA GUI readWebRequirementsFreeze (scripts/lib/release-truth-v2.mjs), same rules
// and the same messages; applied only when no QA GUI root is resolvable.
export function webRequirementsFreezeIssue(graph) {
  const strict = (value, keys, allowed, label) => {
    if (!object(value)) return `${label}:OBJECT_REQUIRED`;
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) return `${label}:UNKNOWN_FIELD:${unknown.join(',')}`;
    const missing = keys.find(key => !Object.hasOwn(value, key));
    return missing ? `${label}:MISSING_FIELD:${missing}` : null;
  };
  if (graph?.schema !== 'requirements.freeze/web-v1') return `REQUIREMENT_GRAPH_SCHEMA:${graph?.schema || 'missing'}`;
  const root = strict(graph, GRAPH_KEYS, GRAPH_KEYS, 'requirements.freeze/web-v1');
  if (root) return root;
  if (graph.contract_sha256 !== WEB_CONTRACT_SHA256) return 'WEB_REQUIREMENT_CONTRACT_SHA';
  if (!nonEmpty(graph.source_revision)) return 'REQUIREMENT_SOURCE_REVISION';
  if (!SHA256_HEX.test(graph.target_binding_sha256)) return 'WEB_REQUIREMENT_TARGET_HASH_INVALID';
  const policy = strict(graph.gate_policy, ['coverage_threshold', 'required_layers'], ['coverage_threshold', 'required_layers'], 'gate_policy');
  if (policy) return policy;
  if (!(Number.isInteger(graph.gate_policy.coverage_threshold) && graph.gate_policy.coverage_threshold >= 0 && graph.gate_policy.coverage_threshold <= 100)) return 'GATE_THRESHOLD';
  if (!(Array.isArray(graph.gate_policy.required_layers) && graph.gate_policy.required_layers.length === 1 && graph.gate_policy.required_layers[0] === 'gui')) return 'WEB_GATE_LAYERS';
  if (!(Array.isArray(graph.requirements) && graph.requirements.length > 0)) return 'REQUIREMENTS_EMPTY';
  const ids = new Set();
  for (const requirement of graph.requirements) {
    const shape = strict(requirement, REQUIREMENT_KEYS, [...REQUIREMENT_KEYS, 'waiver'], `requirement:${requirement?.id || 'unknown'}`);
    if (shape) return shape;
    if (!nonEmpty(requirement.id) || ids.has(requirement.id)) return `REQUIREMENT_ID:${requirement.id || 'missing'}`;
    ids.add(requirement.id);
    if (!nonEmpty(requirement.expectation)) return `REQUIREMENT_EXPECTATION:${requirement.id}`;
    if (!nonEmpty(requirement.requirement_owner)) return `REQUIREMENT_OWNER:${requirement.id}`;
    if (requirement.verification_lane !== 'gui') return `WEB_REQUIREMENT_LANE:${requirement.id}`;
    const risks = requirement.risk_dimensions;
    if (!(Array.isArray(risks) && new Set(risks).size === risks.length && risks.every(item => RISK_DIMENSIONS.includes(item)))) return `REQUIREMENT_RISK:${requirement.id}`;
    const acceptance = requirement.acceptance_ids;
    if (!(Array.isArray(acceptance) && acceptance.length > 0 && new Set(acceptance).size === acceptance.length && acceptance.every(nonEmpty))) return `REQUIREMENT_ACCEPTANCE_IDS:${requirement.id}`;
    const contract = strict(requirement.evidence_contract, EVIDENCE_KEYS, EVIDENCE_KEYS, `evidence_contract:${requirement.id}`);
    if (contract) return contract;
    const types = requirement.evidence_contract.allowed_types;
    if (!(requirement.evidence_contract.atomic === true && typeof requirement.evidence_contract.multi_evidence === 'boolean' && Array.isArray(types)
      && types.length > 0 && new Set(types).size === types.length && types.every(nonEmpty))) return `EVIDENCE_CONTRACT:${requirement.id}`;
  }
  return null;
}

// QA GUI readTrackedPlan + readGuiWebContext coverage rules, plus: every tracked case is an acceptance
// id of its own requirement (QA GUI reports BOARD_ACCEPTANCE_ID_MISMATCH for the rest at gate time).
export function trackedGraphIssue(graph, tracked) {
  const byId = new Map(graph.requirements.map(item => [item.id, item]));
  for (const item of tracked.cases) {
    const requirement = byId.get(item.req_id);
    if (!requirement) return `TRACKED_PLAN_REQUIREMENT:${item.id}:${item.req_id || 'missing'}`;
    if (!requirement.acceptance_ids.includes(item.id)) return `WEB_GRAPH_ACCEPTANCE_ID_MISSING:${item.id}:${item.req_id}`;
  }
  for (const requirement of graph.requirements.filter(item => item.waiver === undefined)) {
    const mapped = tracked.cases.filter(item => item.req_id === requirement.id);
    if (!mapped.length || !mapped.some(item => requirement.acceptance_ids.includes(item.id))) return `TRACKED_PLAN_GUI_REQUIREMENT_MISSING:${requirement.id}`;
  }
  return null;
}

// requirements_hash = sha256 of the compact canonical (sorted-key) JSON, as QA GUI requirementsHash.
export function webRequirementsHash(graph) { return sha256(JSON.stringify(stable(graph))); }

// QA GUI's own reader when a root is resolvable: TEAMQA_QA_GUI_ROOT, else the installed provider interface.
async function qaGuiReader() {
  let root = process.env.TEAMQA_QA_GUI_ROOT;
  if (!root) {
    try { root = verifyProviderInterface({ skill: 'qa-gui' }).root; } catch { return null; }
  }
  const file = join(expandPath(root), 'scripts/lib/release-truth-v2.mjs');
  if (!existsSync(file)) fail(5, 'WEB_QA_GUI_READER_UNAVAILABLE', file, 'ungraded');
  const reader = await import(pathToFileURL(realpathSync(file)).href);
  if (typeof reader.readWebRequirementsFreeze !== 'function' || typeof reader.requirementsHash !== 'function') fail(5, 'WEB_QA_GUI_READER_UNAVAILABLE', file, 'ungraded');
  return { reader, label: `qa-gui:${realpathSync(dirname(dirname(dirname(file))))}` };
}

async function validateGraph(file, graph) {
  const qaGui = await qaGuiReader();
  if (qaGui) {
    try { qaGui.reader.readWebRequirementsFreeze(file); } catch (error) { fail(2, 'WEB_REQUIREMENTS_INVALID', String(error?.message ?? error)); }
    if (qaGui.reader.requirementsHash(graph) !== webRequirementsHash(graph)) fail(2, 'WEB_REQUIREMENTS_HASH_DRIFT');
    return qaGui.label;
  }
  const local = webRequirementsFreezeIssue(graph);
  if (local) fail(2, 'WEB_REQUIREMENTS_INVALID', local);
  return 'local';
}

function parseAllowedTypes(raw) {
  const types = raw.split(',').map(item => item.trim());
  if (!types.length || types.some(item => !item) || new Set(types).size !== types.length) fail(2, 'WEB_ALLOWED_TYPES_INVALID', raw);
  // PASS needs a gui-* evidence type in QA GUI; a contract without one could never grade a case PASS.
  if (!types.some(item => item.startsWith('gui-'))) fail(2, 'WEB_ALLOWED_TYPES_NO_GUI', raw);
  return types;
}

function parseThreshold(raw) {
  if (!/^(?:0|[1-9][0-9]?|100)$/.test(raw)) fail(2, 'WEB_THRESHOLD_INVALID', raw);
  return Number(raw);
}

// One requirement per distinct tracked req_id, in signed plan tier order. Defaults are derived from the
// signed plan, the designer's locked tracked plan, the locked source manifest and the approved roster;
// references/claude-host.md lists each rule.
export function buildWebRequirementsGraph({ plan, tracked, sourceManifest, roster, allowedTypes = null, threshold = null }) {
  const casesByRequirement = new Map();
  for (const item of tracked.cases) {
    if (!Object.hasOwn(plan.tiers, item.req_id)) fail(2, 'WEB_CASE_REQUIREMENT_UNKNOWN', `${item.id}:${item.req_id}`);
    casesByRequirement.set(item.req_id, [...(casesByRequirement.get(item.req_id) ?? []), item]);
  }
  const ids = Object.keys(plan.tiers).filter(id => casesByRequirement.has(id));
  const types = allowedTypes ?? ['gui-screenshot', ...(plan.preflight.recording ? ['gui-recording'] : [])];
  const criterion = { FULL: plan.exit_criteria.coverage_high_pct, SMOKE: plan.exit_criteria.coverage_low_pct };
  return {
    schema: 'requirements.freeze/web-v1',
    contract_sha256: WEB_CONTRACT_SHA256,
    source_revision: sourceManifest.version,
    target_binding_sha256: roster.target.target_binding_sha256,
    gate_policy: { coverage_threshold: threshold ?? Math.max(...ids.map(id => criterion[plan.tiers[id]])), required_layers: ['gui'] },
    requirements: ids.map(id => {
      const cases = casesByRequirement.get(id);
      return {
        id,
        expectation: cases.map(item => `${item.id}: ${item.expected}`).join('\n'),
        requirement_owner: plan.app,
        verification_lane: 'gui',
        risk_dimensions: cases.some(item => item.data?.settling?.required === true) ? ['live-projection-cache'] : [],
        acceptance_ids: cases.map(item => item.id),
        evidence_contract: { allowed_types: [...types], atomic: true, multi_evidence: false },
      };
    }),
  };
}

function sourceManifest(runDir, lock, roster) {
  const manifest = readJson(lockedDocument(runDir, lock, 'source'), { label: 'source manifest' });
  if (!object(manifest) || manifest.schema !== 'team-qa/source-manifest/v1' || manifest.run_id !== roster.run_id || !nonEmpty(manifest.version)) {
    fail(3, 'WEB_SOURCE_REVISION_MISSING', 'locked source manifest version');
  }
  return manifest;
}

async function webRequirements(args) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true }, '--allowed-types': { key: 'allowedTypes' }, '--threshold': { key: 'threshold' },
  });
  refuseTargetEnv();
  const runDir = runDirectory(options.runId);
  const allowedTypes = options.allowedTypes === undefined ? null : parseAllowedTypes(options.allowedTypes);
  const threshold = options.threshold === undefined ? null : parseThreshold(options.threshold);
  const contract = assertRunContract({ runDir, action: 'design' });
  const roster = deployedRoster(contract.roster);
  const plan = loadPlan(lockedDocument(runDir, contract.lock, 'plan', join(runDir, 'test-plan.md')));
  firstError(plan.errors);
  if (plan.value.run_id !== roster.run_id) fail(2, 'RUN_ID_MISMATCH', `plan=${plan.value.run_id}`);
  if (plan.value.preflight?.code !== false || plan.value.preflight?.gui !== true) fail(3, 'WEB_SCOPE_GUI_ONLY');
  const tracked = governedTracked(lockedDocument(runDir, contract.lock, 'tracked', join(runDir, 'tracked-plan.json')), roster);
  const graph = buildWebRequirementsGraph({ plan: plan.value, tracked, sourceManifest: sourceManifest(runDir, contract.lock, roster), roster, allowedTypes, threshold });
  const mapping = trackedGraphIssue(graph, tracked);
  if (mapping) fail(2, 'WEB_GRAPH_TRACKED_MISMATCH', mapping);
  const text = stableJson(graph);
  // Validate the exact bytes before they become the run artifact.
  const scratch = mkdtempSync(join(tmpdir(), 'teamqa-web-requirements-'));
  let validator;
  try {
    writeFileSync(join(scratch, WEB_REQUIREMENTS_FILE), text);
    validator = await validateGraph(join(scratch, WEB_REQUIREMENTS_FILE), JSON.parse(text));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const file = join(runDir, WEB_REQUIREMENTS_FILE);
  const effect = await writeArtifact(file, text, 'teamqa.web.requirements');
  result({
    command: 'web requirements', run: roster.run_id, requirements: file, requirements_hash: webRequirementsHash(graph),
    requirements_count: graph.requirements.length, cases: tracked.cases.length,
    uncovered_requirements: Object.keys(plan.value.tiers).filter(id => !graph.requirements.some(item => item.id === id)),
    validator, effect,
  });
}

function overlayPath(packageRoot) {
  const raw = process.env.TEAMQA_ROLES;
  if (raw === undefined || raw.trim() === '') fail(5, 'WEB_ROLES_REQUIRED', 'set TEAMQA_ROLES to an absolute overlay path outside the Team QA package', 'ungraded');
  if (!isAbsolute(raw) && !raw.startsWith('~/')) fail(5, 'WEB_ROLES_RELATIVE', raw, 'ungraded');
  const path = expandPath(raw);
  const pkg = realpathSync(packageRoot), real = realNearest(path);
  // An in-place edit of the packaged roles.json breaks package-tool.mjs verify-runtime.
  if (real === pkg || inside(real, pkg)) fail(5, 'WEB_ROLES_INSIDE_PACKAGE', path, 'ungraded');
  if (existsSync(path) && !statSync(path).isFile()) fail(5, 'WEB_ROLES_NOT_FILE', path, 'ungraded');
  return path;
}

// The packaged roles.json plus "target". Relative mirror adapter paths resolve against the directory of
// the roles file (SKILL.md), so they are anchored to the package to keep the same adapters.
export function webRolesOverlay(packageRoot, target) {
  const packaged = readJson(join(packageRoot, 'roles.json'), { label: 'roles.json', invalidCode: 'ROLES_JSON_INVALID' });
  requireObject(packaged, 'ROLES_TYPE', 'root');
  const anchored = part => typeof part === 'string' && !isAbsolute(part) && !part.startsWith('~') && !/^[a-z][a-z0-9+.-]*:/i.test(part)
    && (part.startsWith('./') || part.startsWith('../') || part.includes('/')) ? resolve(packageRoot, part) : part;
  const { target: _packagedTarget, ...config } = structuredClone(packaged);
  for (const adapter of Object.values(object(config.mirror) ? config.mirror : {})) {
    if (!object(adapter)) continue;
    for (const field of ['probe', 'publish', 'readback']) if (Array.isArray(adapter[field])) adapter[field] = adapter[field].map(anchored);
  }
  return { ...config, target };
}

// Pre-bind overlay: the packaged roles.json with anchored adapter paths and no target. It lets TEAMQA_ROLES name the
// overlay for the whole session (eval compat 3); `web bind` replaces exactly these bytes with the bound overlay.
export function webRolesBaseText(packageRoot) {
  const { target: _target, ...base } = webRolesOverlay(packageRoot, null);
  return stableJson(base);
}
async function webOverlay(args, helpers) {
  parseFlags(args, {});
  refuseTargetEnv();
  const rolesFile = overlayPath(helpers.packageRoot);
  const baseText = webRolesBaseText(helpers.packageRoot);
  if (existsSync(rolesFile) && !readFileSync(rolesFile).equals(Buffer.from(baseText, 'utf8'))) {
    // Already bound by `web bind`: the same base plus a deployed target.
    let bound = false;
    try { const { target, ...rest } = JSON.parse(readFileSync(rolesFile, 'utf8')); bound = isDeployedTarget(target) && stableJson(rest) === baseText; } catch { bound = false; }
    if (!bound) fail(2, 'WEB_ARTIFACT_EXISTS', rolesFile);
    return result({ command: 'web overlay', roles_overlay: rolesFile, roles_overlay_sha256: sha256File(rolesFile), effect: 'bound' });
  }
  const effect = await writeArtifact(rolesFile, baseText, 'teamqa.web.roles-base');
  result({ command: 'web overlay', roles_overlay: rolesFile, roles_overlay_sha256: sha256File(rolesFile), effect });
}

async function readGraphFile(file, runDir) {
  if (!existsSync(file)) fail(2, 'INPUT_MISSING', file);
  if (!inside(realpathSync(file), realpathSync(runDir))) fail(2, 'WEB_REQUIREMENTS_OUTSIDE_RUN', file);
  const graph = readJson(file, { label: basename(file), invalidCode: 'WEB_REQUIREMENTS_JSON_INVALID' });
  const validator = await validateGraph(file, graph);
  return { graph, hash: webRequirementsHash(graph), validator };
}

async function webBind(args, helpers) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true }, '--requirements': { key: 'requirements', required: true }, '--run-uuid': { key: 'runUuid' },
  });
  refuseTargetEnv();
  const rolesFile = overlayPath(helpers.packageRoot);
  const runDir = runDirectory(options.runId);
  if (options.runUuid !== undefined && !UUID.test(options.runUuid)) fail(2, 'WEB_RUN_UUID_INVALID', options.runUuid);
  const contract = assertRunContract({ runDir, action: 'design' });
  const roster = deployedRoster(contract.roster);
  const { graph, hash, validator } = await readGraphFile(resolve(process.cwd(), options.requirements), runDir);
  if (graph.target_binding_sha256 !== roster.target.target_binding_sha256) fail(2, 'WEB_GRAPH_TARGET_BINDING_MISMATCH');
  const mapping = trackedGraphIssue(graph, governedTracked(join(runDir, 'tracked-plan.json'), roster));
  if (mapping) fail(2, 'WEB_GRAPH_TRACKED_MISMATCH', mapping);
  const bindingFile = join(runDir, 'binding.json');
  let previous = null;
  if (existsSync(bindingFile)) { try { previous = JSON.parse(readFileSync(bindingFile, 'utf8')); } catch { previous = null; } }
  const runUuid = options.runUuid ?? (UUID.test(previous?.run_uuid ?? '') ? previous.run_uuid : randomUUID());
  // Canonical key order (lib/deployed-target.mjs); target is roster.json's object unchanged.
  const binding = {
    schema: 'team-qa/web-binding/v1', run_uuid: runUuid, requirements_hash: hash, contract_sha256: WEB_CONTRACT_SHA256,
    verification_lane: 'gui', target_kind: 'deployed-build', target_binding_sha256: roster.target.target_binding_sha256, target: roster.target,
  };
  try { assertWebBinding(binding, { target: roster.target, requirementsHash: hash, requireProof: false }); }
  catch (error) { fail(2, 'WEB_BINDING_INVALID', String(error?.message ?? error)); }
  try {
    assertWebBinding(binding, { target: roster.target, requirementsHash: hash, runDir, requireProof: true,
      verifyOriginalSource: ref => readDeployedIdentityObservation(ref, { roster, runDir }) });
  } catch (error) { fail(3, 'WEB_IDENTITY_PROOF_INVALID', String(error?.code ?? error?.message ?? error), 'ungraded'); }
  const bindingText = stableJson(binding);
  const overlayText = stableJson(webRolesOverlay(helpers.packageRoot, roster.target));
  sameOrAbsent(bindingFile, bindingText);
  // The pre-bind overlay written by `web overlay` is the only other content the overlay may be replaced from.
  const fromBase = existsSync(rolesFile) && statSync(rolesFile).isFile() && readFileSync(rolesFile).equals(Buffer.from(webRolesBaseText(helpers.packageRoot), 'utf8'));
  if (!fromBase) sameOrAbsent(rolesFile, overlayText);
  const effect = { binding: await writeArtifact(bindingFile, bindingText, 'teamqa.web.bind'),
    roles: fromBase ? (await writeConfirmed(rolesFile, overlayText, 'teamqa.web.roles-overlay'), 'confirmed') : await writeArtifact(rolesFile, overlayText, 'teamqa.web.roles-overlay') };
  // The lane's own governance gate over the written binding and $TEAMQA_ROLES (teamqa.mjs).
  const governance = helpers.assertGovernedRelease(runDir);
  if (!governance.official) fail(5, 'UNGOVERNED', 'binding run_uuid', 'ungraded');
  result({
    command: 'web bind', run: roster.run_id, binding: bindingFile, binding_sha256: sha256File(bindingFile), run_uuid: runUuid,
    requirements_hash: hash, target_binding_sha256: binding.target_binding_sha256, roles_overlay: rolesFile,
    roles_overlay_sha256: sha256File(rolesFile), validator, effect,
  });
}

function parseIso(raw, flag) {
  if (!Number.isFinite(Date.parse(raw))) fail(2, 'WEB_RECORD_TIME_INVALID', flag);
  return raw;
}

async function receiptEvidence(runDir, receiptFile, caseId) {
  const text = readText(receiptFile, { label: basename(receiptFile) });
  let claim;
  try { claim = JSON.parse(text); } catch { fail(2, 'CHILD_VERDICT_ARTIFACT_INVALID', receiptFile); }
  if (!object(claim) || claim.schema !== 'qa-gui/receipt/web-v1') fail(2, 'CHILD_RECEIPT_SCHEMA', receiptFile);
  if (!DIMENSION_VERDICTS.includes(String(claim.semantic_verdict ?? '').toLowerCase())) fail(2, 'WEB_RECEIPT_VERDICT_INVALID', String(claim.semantic_verdict ?? ''));
  // A case-scoped receipt (qa-gate --case; upgrade U2) carries the verdict of its own case, read from that case's
  // atomic rows; a receipt scoped to another case is refused. An unscoped receipt keeps the board's semantic verdict.
  const scope = claim.teamqa_provenance?.case_id;
  if (scope !== undefined && scope !== caseId) fail(2, 'CHILD_RECEIPT_CASE_SCOPE', `${scope} != ${caseId}`);
  const verdict = scope === undefined ? String(claim.semantic_verdict).toLowerCase()
    : caseRowsVerdict(Array.isArray(claim.atomic_coverage) ? claim.atomic_coverage.filter((row) => row?.case_id === caseId) : []);
  // qa-gate rewrites .teamcode/runs/<run_uuid>/receipts/qa-gui.receipt.json on every run, so the record
  // points at an immutable content-addressed copy inside the run directory.
  const sha = sha256(Buffer.from(text, 'utf8'));
  const artifact = `evidence/qa-gui/${sha}.receipt.json`;
  const copy = join(runDir, artifact);
  if (existsSync(copy)) { if (sha256File(copy) !== sha) fail(2, 'WEB_ARTIFACT_EXISTS', copy); }
  else {
    await writeConfirmed(copy, text, 'teamqa.web.record.evidence', { exclusive: true });
    if (sha256File(copy) !== sha) fail(1, 'EFFECT_UNCONFIRMED', artifact);
  }
  return { artifact, sha, verdict };
}

// The checks teamqa.mjs boardAdd applies to a record, in its order, without writing the board or ledger.
function boardAddDryRun({ record, boardPath, records, planned, tracked, helpers }) {
  const contract = assertRunContract({ runDir: dirname(boardPath), action: 'intake', record });
  if (boardPath !== join(contract.runDir, 'board.jsonl')) fail(2, 'RUN_BOARD_PATH_MISMATCH');
  if (record.run_id !== contract.roster.run_id) fail(2, 'RUN_ID_MISMATCH', record.run_id);
  firstError(boardRecordErrors(record, 1));
  if (planned.lane !== record.lane) fail(2, 'BOARD_LANE_MISMATCH', record.case_id);
  helpers.assertPlannedSourceRefs(record, planned, tracked);
  const governance = helpers.assertGovernedRelease(dirname(boardPath));
  const issues = helpers.recordIssues(record, boardPath, governance.lock, governance.official ? governance.binding : null, planned.req_id);
  // board add would rewrite the verdict to ungraded with the first issue as reason.
  if (issues.length) fail(2, issues[0], issues.slice(1).join(' '));
  helpers.assertRecordBinding(record, governance.binding);
  for (const existing of records) {
    helpers.assertRecordBinding(existing, governance.binding);
    if (existing.case_id === record.case_id) helpers.assertPlannedSourceRefs(existing, planned, tracked);
  }
  const pendingIndex = records.findIndex(item => item.case_id === record.case_id && item.verdict === 'pending');
  const history = records.filter(item => item.case_id === record.case_id && item.verdict !== 'pending');
  const next = history.length || pendingIndex < 0 ? [...records, record] : records.map((item, index) => index === pendingIndex ? record : item);
  const issue = attemptHistoryIssue(next);
  if (issue) fail(2, issue.split(' ')[0], issue.slice(issue.indexOf(' ') + 1));
}

async function webRecord(args, helpers) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true }, '--case': { key: 'caseId', required: true }, '--receipt': { key: 'receipt', required: true },
    '--function': { key: 'functionVerdict', required: true }, '--ui': { key: 'uiVerdict', required: true },
    '--started-at': { key: 'startedAt', required: true }, '--ended-at': { key: 'endedAt', required: true },
    '--timeout-ms': { key: 'timeoutMs', required: true }, '--out': { key: 'out', required: true },
  });
  refuseTargetEnv();
  const runDir = runDirectory(options.runId), boardPath = join(runDir, 'board.jsonl');
  for (const [flag, value] of [['--function', options.functionVerdict], ['--ui', options.uiVerdict]]) if (!DIMENSION_VERDICTS.includes(value)) fail(2, 'WEB_RECORD_VERDICT_INVALID', `${flag}=${value}`);
  const startedAt = parseIso(options.startedAt, '--started-at'), endedAt = parseIso(options.endedAt, '--ended-at');
  if (!/^[1-9][0-9]*$/.test(options.timeoutMs) || !Number.isSafeInteger(Number(options.timeoutMs))) fail(2, 'WEB_RECORD_TIMEOUT_INVALID', options.timeoutMs);
  const roster = deployedRoster(assertApprovedRoster({ runDir }));
  const bindingFile = join(runDir, 'binding.json');
  if (!existsSync(bindingFile)) fail(3, 'BINDING_MISSING', bindingFile);
  const binding = readJson(bindingFile, { label: 'binding.json' });
  try { assertWebBinding(binding, { target: roster.target, requireProof: false }); }
  catch (error) { fail(2, 'WEB_BINDING_INVALID', String(error?.message ?? error)); }
  const tracked = governedTracked(join(runDir, 'tracked-plan.json'), roster);
  const planned = tracked.cases.find(item => item.id === options.caseId);
  if (!planned) fail(2, 'BOARD_CASE_UNKNOWN', options.caseId);
  let records = [];
  if (existsSync(boardPath)) { const board = loadBoard(boardPath); firstError(board.errors); records = board.records; }
  // Attempt chain exactly as board add accepts it: a retry follows an ungraded/blocked attempt, at most three.
  const history = records.filter(item => item.case_id === planned.id && item.verdict !== 'pending');
  let attempt = 1, parent = null;
  if (history.length) {
    const previous = history.at(-1);
    if (!['ungraded', 'blocked'].includes(previous.verdict)) fail(2, 'BOARD_RETRY_NOT_ALLOWED', planned.id);
    const previousAttempt = effectiveAttempt(previous);
    if (!Number.isInteger(previousAttempt)) fail(2, 'ATTEMPT_HISTORY_INCOMPLETE', planned.id);
    if (previousAttempt >= 3) fail(2, 'ATTEMPT_LIMIT_EXCEEDED', planned.id);
    attempt = previousAttempt + 1;
    parent = attemptId(previous);
  }
  const child = await receiptEvidence(runDir, resolve(process.cwd(), options.receipt), planned.id);
  const verdict = aggregateVerdict({ function_verdict: options.functionVerdict, ui_visual_verdict: options.uiVerdict });
  const record = {
    case_id: planned.id, lane: planned.lane, verdict, evidence: [child.artifact], source: 'qa-gui', run_id: roster.run_id, ts: endedAt,
    ...(verdict === 'ungraded' ? { reason: child.verdict === 'ungraded' ? 'QA_GUI_UNGRADED' : 'CASE_DIMENSION_UNGRADED' } : {}),
    function_verdict: options.functionVerdict, ui_visual_verdict: options.uiVerdict,
    attempt_id: `${planned.id}#${attempt}`, attempt, ...(parent ? { parent_attempt_id: parent } : {}),
    started_at: startedAt, ended_at: endedAt, timeout_ms: Number(options.timeoutMs),
    traceabilityVersion: SOURCE_TRACEABILITY_VERSION, sourceRefs: structuredClone(planned.sourceRefs),
    target_kind: 'deployed-build', target_binding_sha256: binding.target_binding_sha256, verification_lane: 'gui', contract_sha256: binding.contract_sha256,
    target: roster.target,
    child_verdict: { skill: 'qa-gui', verdict: child.verdict, artifact: child.artifact, sha256: child.sha },
  };
  boardAddDryRun({ record, boardPath, records, planned, tracked, helpers });
  const out = resolve(process.cwd(), options.out);
  const effect = await writeArtifact(out, stableJson(record), 'teamqa.web.record');
  result({
    command: 'web record', run: roster.run_id, case: planned.id, record: out, case_verdict: verdict, child_verdict: child.verdict,
    attempt, attempt_id: record.attempt_id, evidence: record.evidence, board: boardPath, effect,
  });
}

export async function webCommand(action, args, helpers) {
  if (action === 'requirements') return webRequirements(args, helpers);
  if (action === 'bind') return webBind(args, helpers);
  if (action === 'record') return webRecord(args, helpers);
  if (action === 'overlay') return webOverlay(args, helpers);
  if (action === 'collect') {
    // Executor evidence drafts to state receipts and board cases, from the attested stream only (upgrade U3).
    const { webCollect } = await import('./web-collect.mjs');
    const { assertRoleAttestation, lockRunDocuments } = await import('./run-contract.mjs');
    refuseTargetEnv();
    return result({ command: 'web collect', ...(await webCollect(args, { parseFlags, readJson, writeConfirmed, stableJson, fail, assertRoleAttestation, lockRunDocuments, runDirectory, safeRunId })) });
  }
  if (action === 'collect-screen') {
    // Fix round 1 (D1): one screen check dispatch's stream to runs/<id>/screens/<screenId>/ (QA GUI grades it).
    const { webCollectScreen } = await import('./screen-checks.mjs');
    const { assertRoleAttestation } = await import('./run-contract.mjs');
    refuseTargetEnv();
    return result({ command: 'web collect-screen', ...(await webCollectScreen(args, { parseFlags, fail, assertRoleAttestation, runDirectory, safeRunId, writeConfirmed })) });
  }
  if (action === 'screens') {
    // Fix round 1 (D1): the screens of the locked plan, the screen check each needs, and which are collected.
    const { lockedScreens } = await import('./run-contract.mjs');
    const { SCREENS_DIR } = await import('./screen-checks.mjs');
    const o = parseFlags(args, { '--run': { key: 'run', required: true } });
    const runDir = runDirectory(safeRunId(o.run));
    const screens = lockedScreens(runDir).map((s) => ({ id: s.id, route: s.route, role: s.role, cases: s.cases,
      collected: existsSync(join(runDir, SCREENS_DIR, s.id, 'result.json')) }));
    return result({ command: 'web screens', run_id: o.run, screens });
  }
  fail(2, 'COMMAND_UNKNOWN', `web ${action}`);
}
