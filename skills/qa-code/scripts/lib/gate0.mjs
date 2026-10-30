#!/usr/bin/env node
import {writePreserved as writeFileSync} from './write-preserved.mjs';
// Gate 0 P1: normalizes the results of gitleaks, semgrep, osv-scanner and node coverage.
// Zero runtime dependency. TODO(P1-next-ecosystems): add Python/Go runners in a later phase.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  copyFileSync,
  constants,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { readReleaseTruthContext } from './release-truth-v2.mjs';
import {executeTestFiles,validateTestRunners,testExecutionOutcome} from './test-runners.mjs';
import {archiveOwnedPath} from './archive.mjs';
import {verifySecretAdjudication,verifiedSecretStatus} from './secret-adjudication.mjs';

const runStart = process.hrtime.bigint();

function elapsedMsSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// F02 — time budget. `timeouts.layers.<layer>` caps each layer, `timeouts.total` caps the whole run.
// Not set => Infinity, the old behavior is kept. The state is declared early because run() is used before the config is read.
const LAYER_NAMES = [
  'secret', 'sast', 'cve', 'coverage', 'prompt_injection', 'threat_model', 'security_product_path',
];
// The gitleaks config Gate 0 passes with --config: gitleaks' default rules and nothing from the repo under review.
const GITLEAKS_QA_CONFIG = `# qa-code Gate 0: owned by QA, never read from the repository under review.
title = "qa-code gate0"

[extend]
useDefault = true
`;
const layerBudgetMs = new Map();
const layerDurationMs = {
  secret: 0, sast: 0, cve: 0, coverage: 0, prompt_injection: 0, threat_model: 0,
  security_product_path: 0,
};
let totalBudgetMs = Infinity;
let activeLayer = null;

function totalRemainingMs() {
  return totalBudgetMs === Infinity ? Infinity : totalBudgetMs - elapsedMsSince(runStart);
}

// The budget left for a child process = min(budget of the running layer, budget of the whole run).
// Outside a layer's scope (git plumbing while building the diff) no budget applies: that is required infrastructure,
// and cutting it there would only turn an incident into exit 2 without giving any better fail-closed verdict.
function remainingBudgetMs() {
  if (!activeLayer) return Infinity;
  const limit = layerBudgetMs.get(activeLayer.name);
  const layerRemaining = limit === undefined ? Infinity : limit - elapsedMsSince(activeLayer.start);
  return Math.min(layerRemaining, totalRemainingMs());
}

const args = process.argv.slice(2);
const options = { base: '', json: '', cveCmd: '', config: '', requirements: '' };

function dieUsage(message) {
  if (message) console.error(`qa-code: ${message}`);
  process.exit(2);
}

function dieUngraded(message) {
  console.error(`qa-code: UNGRADED — ${message}`);
  process.exit(20);
}

for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (!value) dieUsage(`missing value for ${flag ?? 'flag'}`);
  if (flag === '--repo') options.repo = value;
  else if (flag === '--base') options.base = value;
  else if (flag === '--json') options.json = value;
  else if (flag === '--cve-cmd') options.cveCmd = value;
  else if (flag === '--config') options.config = value;
  else if (flag === '--requirements') options.requirements = value;
  else dieUsage(`invalid flag: ${flag}`);
}

if (!options.repo) dieUsage('missing --repo');
if (!options.base) dieUngraded('missing --base; TASK_BASE is required');

let repo;
try {
  repo = realpathSync(options.repo);
} catch {
  dieUsage(`cannot read --repo: ${options.repo}`);
}

function run(command, commandArgs, extra = {}) {
  const childEnv = { ...process.env, ...(extra.env ?? {}) };
  for (const name of extra.unsetEnv ?? []) delete childEnv[name];
  const budget = remainingBudgetMs();
  // When the budget is fully spent, spawn nothing more: treat it as a timeout so that the layer goes straight to ungraded.
  if (budget <= 0) {
    return { status: null, stdout: '', stderr: '', error: undefined, timedOut: true };
  }
  const result = spawnSync(command, commandArgs, {
    cwd: extra.cwd ?? repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv,
    // SIGKILL because a hung checker may ignore SIGTERM; Node closes stdio on kill, so
    // the parent process exits at once instead of waiting for a grandchild that still holds the pipe.
    ...(budget === Infinity ? {} : { timeout: Math.max(1, Math.ceil(budget)), killSignal: 'SIGKILL' }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function resolveCommandPath(command) {
  const candidates = command.includes('/')
    ? [command]
    : String(process.env.PATH ?? '').split(':').filter(Boolean).map((part) => join(part, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next candidate in PATH
    }
  }
  return '';
}

function commandExists(command) {
  return resolveCommandPath(command) !== '';
}

// F01 — runtime/toolchain receipt. A version is recorded only when a REAL probe succeeds:
// the binary exits 0 and prints a line shaped like a version number. A stub that returns scan JSON for
// `--version` must not be recorded as a fake version.
const VERSION_PROBE_ARGS = [['--version'], ['version']];
const VERSION_PATTERN = /\d+\.\d+/;

function probeVersion(binaryPath, extra = {}) {
  for (const probeArgs of VERSION_PROBE_ARGS) {
    const result = run(binaryPath, probeArgs, extra);
    if (result.error || result.status !== 0) continue;
    for (const stream of [result.stdout, result.stderr]) {
      const line = String(stream ?? '').split('\n').map((item) => item.trim()).find(Boolean);
      if (line && VERSION_PATTERN.test(line)) return line;
    }
  }
  return null;
}

const receiptCache = new Map();

// path keeps exactly the PATH entry that was called (no realpath) so that the receipt matches the binary that actually ran.
// No version could be probed => version null; receipts.required handles it fail-closed.
function checkerReceipt(command, extra = {}) {
  if (!receiptCache.has(command)) {
    const path = resolveCommandPath(command);
    receiptCache.set(command, path ? { path, version: probeVersion(path, extra) } : null);
  }
  return receiptCache.get(command);
}

function git(commandArgs) {
  return run('git', commandArgs, { cwd: repo });
}

const gitCheck = git(['rev-parse', '--is-inside-work-tree']);
if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
  dieUsage('--repo must be a git repo');
}

const headResult = git(['rev-parse', '--verify', 'HEAD^{commit}']);
if (headResult.status !== 0) dieUsage('--repo has no HEAD commit yet');
const commit = headResult.stdout.trim();

let baseCommit;
const baseResult = git(['rev-parse', '--verify', `${options.base}^{commit}`]);
if (baseResult.status === 0) {
  baseCommit = baseResult.stdout.trim();
} else {
  const emptyTree = git(['hash-object', '-t', 'tree', '/dev/null']);
  if (emptyTree.status !== 0 || options.base !== emptyTree.stdout.trim()) {
    dieUngraded(`cannot resolve --base to TASK_BASE: ${options.base}`);
  }
  baseCommit = emptyTree.stdout.trim();
}

let config = {};
let configRepoPath = null;
if (options.config) {
  try {
    // Per the spec the config must be inside the repo; realpath both sides before comparing.
    const configReal = realpathSync(resolve(options.config));
    const repoReal = realpathSync(repo);
    const rel = relative(repoReal, configReal);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      dieUsage('--config must be inside --repo');
    }
    configRepoPath = rel.replaceAll('\\', '/');
    config = JSON.parse(readFileSync(configReal, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') dieUsage(`cannot find --config: ${options.config}`);
    if (error instanceof SyntaxError) dieUsage(`--config is not valid JSON: ${options.config}`);
    if (error?.message?.startsWith('qa-code:')) throw error;
    if (error?.code) dieUsage(`cannot read --config: ${options.config}`);
    throw error;
  }
}

let releaseTruth = null;
if (options.requirements) {
  try {
    releaseTruth = readReleaseTruthContext(options.requirements, {
      repo,
      taskBase: baseCommit,
      lane: 'code',
    });
  } catch (error) {
    if (error?.code === 20) dieUngraded(error.message);
    dieUsage(error.message);
  }
  if (config.task_base !== undefined && config.task_base !== releaseTruth.graph.task_base) {
    dieUsage(`TASK_BASE_MISMATCH:${releaseTruth.graph.task_base}:${config.task_base}`);
  }
  if (config.source_revision !== undefined && config.source_revision !== releaseTruth.graph.source_revision) {
    dieUsage(`SOURCE_REVISION_MISMATCH:${releaseTruth.graph.source_revision}:${config.source_revision}`);
  }
  if (config.verification_lane !== undefined && config.verification_lane !== 'code') {
    dieUsage(`VERIFICATION_LANE_MISMATCH:code:${config.verification_lane}`);
  }
}

let testRunners=config.test_runners;
try {validateTestRunners(testRunners);} catch(error) {dieUsage(error.message);}
const secretAdjudication=config.secret?.adjudication;
if(secretAdjudication!==undefined&&(!secretAdjudication||typeof secretAdjudication!=='object'||Array.isArray(secretAdjudication)||!secretAdjudication.proof||Object.keys(secretAdjudication).some(k=>!['proof','runtime'].includes(k))||typeof secretAdjudication.proof!=='string'||secretAdjudication.runtime!==undefined&&typeof secretAdjudication.runtime!=='string'))dieUsage('secret.adjudication requires an independent completed proof, not a decision/status');
const runnerMatches=(pattern,file)=>globRegex(pattern).test(file);
const runStackTests=(files,extra={})=>executeTestFiles({repo,files,runners:testRunners,run,matches:runnerMatches,...extra});
const frozenThreshold = releaseTruth?.graph.gate_policy.coverage_threshold;
const thresholdValue = config?.coverage?.threshold ?? frozenThreshold ?? 80;
const threshold = Number(thresholdValue);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  dieUsage('coverage.threshold must be a number from 0 to 100');
}
if (frozenThreshold !== undefined && threshold < frozenThreshold) {
  dieUsage(`COVERAGE_THRESHOLD_DOWNGRADE:${frozenThreshold}:${threshold}`);
}
if (testRunners && threshold < 80) dieUsage(`COVERAGE_THRESHOLD_DOWNGRADE:80:${threshold}`);
const coverageTestPatterns = config?.coverage?.testFiles;
if (coverageTestPatterns !== undefined
  && (!Array.isArray(coverageTestPatterns)
    || coverageTestPatterns.length === 0
    || coverageTestPatterns.some((item) => typeof item !== 'string' || !item.trim()))) {
  dieUsage('coverage.testFiles must be a non-empty array of globs');
}

// F03 — opt-in stability gate. `stability.runs` (2–5) repeats exactly the configured Node test suite
// so that one lucky green run is not enough to pass. Not declared => stability off, the old path intact.
// A wrong configuration is a configuration error (exit 2), not a verdict — otherwise the yardstick would be loosened silently.
const STABILITY_RUNS_MIN = 2;
const STABILITY_RUNS_MAX = 5;
const stabilityConfig = config?.stability;
if (stabilityConfig !== undefined
  && (typeof stabilityConfig !== 'object' || stabilityConfig === null || Array.isArray(stabilityConfig))) {
  dieUsage('stability must be an object');
}
let stability = null;
if (stabilityConfig !== undefined) {
  const runs = stabilityConfig.runs;
  if (typeof runs !== 'number' || !Number.isInteger(runs)
    || runs < STABILITY_RUNS_MIN || runs > STABILITY_RUNS_MAX) {
    dieUsage(`stability.runs must be an integer from ${STABILITY_RUNS_MIN} to ${STABILITY_RUNS_MAX}`);
  }
  stability = { runs, status: 'skipped', outcomes: [], notes: [] };
}

// F04 — machine-readable acceptance contract. Each requirement must have a unique ID mapped to two
// classes of evidence: fail-to-pass (tests that prove the new behavior) and pass-to-pass (tests that prove
// no regression). `acceptance` not declared => off, an old config keeps the same output shape.
// A broken contract is a configuration error (exit 2), not a verdict: a missing ID, a duplicate ID, a file that does not
// exist or an empty class all destroy traceability, and grading on would loosen the yardstick silently.
const TRACEABILITY_CLASSES = ['fail_to_pass', 'pass_to_pass'];
const PRESERVATION_MODE = 'preservation';
const acceptanceConfig = config?.acceptance;
if (acceptanceConfig !== undefined
  && (typeof acceptanceConfig !== 'object' || acceptanceConfig === null || Array.isArray(acceptanceConfig))) {
  dieUsage('acceptance must be an object');
}
let acceptance = null;
if (acceptanceConfig !== undefined) {
  const requirements = acceptanceConfig.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0) {
    dieUsage('acceptance.requirements must be a non-empty array of requirements');
  }
  const seenIds = new Map();
  const seenAssertions = new Map();
  const graphById = new Map((releaseTruth?.codeRequirements ?? []).map((item) => [item.id, item]));
  const traced = [];
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const label = `acceptance.requirements[${index}]`;
    if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement)) {
      dieUsage(`${label} must be a requirement object with an id and ${TRACEABILITY_CLASSES.join(', ')}`);
    }
    const rawId = releaseTruth ? requirement.requirement_id : requirement.id;
    if (typeof rawId !== 'string' || !rawId.trim()) {
      dieUsage(`${label}.${releaseTruth ? 'requirement_id' : 'id'} missing: every requirement must declare its ID as a non-empty string`);
    }
    const id = rawId.trim();
    if (seenIds.has(id)) {
      dieUsage(`${label}.id duplicates acceptance.requirements[${seenIds.get(id)}].id: ${id}`);
    }
    seenIds.set(id, index);
    let assertionId = null;
    let caseId = null;
    if (releaseTruth) {
      if (!graphById.has(id)) dieUsage(`REQUIREMENT_NOT_IN_GRAPH:${id}`);
      if (typeof requirement.assertion_id !== 'string' || !requirement.assertion_id.trim()) {
        dieUsage(`${label}.assertion_id missing for requirement ${id}`);
      }
      assertionId = requirement.assertion_id.trim();
      if (seenAssertions.has(assertionId)) {
        dieUsage(`${label}.assertion_id duplicates acceptance.requirements[${seenAssertions.get(assertionId)}].assertion_id: ${assertionId}`);
      }
      seenAssertions.set(assertionId, index);
      const graphRequirement = graphById.get(id);
      const configuredCaseId = typeof requirement.case_id === 'string' ? requirement.case_id.trim() : '';
      if (configuredCaseId) caseId = configuredCaseId;
      else if (graphRequirement.acceptance_ids.length === 1) [caseId] = graphRequirement.acceptance_ids;
      else dieUsage(`${label}.case_id missing for requirement ${id} that has several acceptance_ids`);
      if (!graphRequirement.acceptance_ids.includes(caseId)) {
        dieUsage(`CASE_NOT_IN_REQUIREMENT:${id}:${caseId}`);
      }
    }

    const mode = requirement.mode ?? 'fail_to_pass';
    if (!['fail_to_pass', PRESERVATION_MODE].includes(mode)) {
      dieUsage(`${label}.mode must be fail_to_pass or preservation (requirement ${id})`);
    }
    if (mode === PRESERVATION_MODE) {
      if (!releaseTruth) {
        dieUsage(`${label}.mode=preservation is only valid with requirements.freeze/v2 (requirement ${id})`);
      }
      const graphRequirement = graphById.get(id);
      if (!graphRequirement?.evidence_contract?.allowed_types?.includes('diff-proof')) {
        dieUsage(`PRESERVATION_NOT_ALLOWED:${id}:evidence_contract is missing diff-proof`);
      }
      if (Object.hasOwn(requirement, 'fail_to_pass')) {
        dieUsage(`${label}.fail_to_pass is forbidden when mode=preservation (requirement ${id})`);
      }
    }

    const evidence = mode === PRESERVATION_MODE ? { mode } : {};
    const classes = mode === PRESERVATION_MODE
      ? ['preservation', 'pass_to_pass']
      : TRACEABILITY_CLASSES;
    for (const className of classes) {
      const list = requirement[className];
      if (!Array.isArray(list) || list.length === 0
        || list.some((item) => typeof item !== 'string' || !item.trim())) {
        dieUsage(`${label}.${className} must be a non-empty array of test paths (requirement ${id})`);
      }
      const files = [];
      for (const item of list) {
        const candidate = item.trim().replaceAll('\\', '/').replace(/^\.\//, '');
        const full = resolve(repo, candidate);
        const rel = relative(repo, full);
        if (isAbsolute(candidate) || rel === '' || rel === '..'
          || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          dieUsage(`${label}.${className} must be a relative path inside the repo: ${item}`);
        }
        if (!existsSync(full)) {
          dieUsage(`${label}.${className} points to a file that does not exist: ${item} (requirement ${id})`);
        }
        files.push(rel.replaceAll('\\', '/'));
      }
      evidence[className] = files;
    }
    traced.push({
      id,
      ...(releaseTruth ? { requirement_id: id, assertion_id: assertionId, case_id: caseId } : {}),
      ...evidence,
    });
  }
  acceptance = { requirements: traced };
}
if (releaseTruth && acceptance === null) acceptance = { requirements: [] };

// F06 — change-driven threat-model gate. The config only declares WHERE the model is; the model's content is
// graded inside the layer, not when the config is read, because only a diff that touches a risk group needs a model —
// a diff without risk must not be blocked unfairly because of a model file nobody has written yet. A wrong shape (not
// an object, an empty path, a path that escapes the repo) is a configuration error (exit 2): with no place to
// read the model from, every later "model present" verdict would loosen the yardstick silently.
const THREAT_MODEL_SECTIONS = ['entry_points', 'trust_boundaries', 'sensitive_assets', 'high_impact_sinks'];
const threatModelConfig = config?.threat_model;
if (threatModelConfig !== undefined
  && (typeof threatModelConfig !== 'object' || threatModelConfig === null || Array.isArray(threatModelConfig))) {
  dieUsage('threat_model must be an object that declares the path to a JSON file in the repo');
}
let threatModelPath = null;
if (threatModelConfig !== undefined) {
  const raw = threatModelConfig.path;
  if (typeof raw !== 'string' || !raw.trim()) {
    dieUsage('threat_model.path must be a relative path string inside the repo');
  }
  const candidate = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const full = resolve(repo, candidate);
  const rel = relative(repo, full);
  if (isAbsolute(candidate) || rel === '' || rel === '..'
    || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    dieUsage(`threat_model.path must be a relative path inside the repo: ${raw}`);
  }
  threatModelPath = rel.replaceAll('\\', '/');
}

// F07 — security product-path acceptance. The F06 threat model only proves the risk was THOUGHT
// about; this layer demands evidence that the risk is BLOCKED on the actual product path. The config only declares the LIST
// of tests; the verdict is decided by a real run. A wrong shape or a pointer to a file that does not exist
// is a configuration error (exit 2), not a verdict: with a list that cannot run, every later "acceptance
// present" would only loosen the yardstick silently.
const securityProductPathConfig = config?.security_product_path;
if (securityProductPathConfig !== undefined
  && (typeof securityProductPathConfig !== 'object' || securityProductPathConfig === null
    || Array.isArray(securityProductPathConfig))) {
  dieUsage('security_product_path must be an object that declares a tests array in the repo');
}
let securityProductPathTests = null;
if (securityProductPathConfig !== undefined) {
  const list = securityProductPathConfig.tests;
  if (!Array.isArray(list) || list.length === 0
    || list.some((item) => typeof item !== 'string' || !item.trim())) {
    dieUsage('security_product_path.tests must be a non-empty array of test paths');
  }
  const files = [];
  for (const item of list) {
    const candidate = item.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const full = resolve(repo, candidate);
    const rel = relative(repo, full);
    if (isAbsolute(candidate) || rel === '' || rel === '..'
      || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      dieUsage(`security_product_path.tests must be a relative path inside the repo: ${item}`);
    }
    if (!existsSync(full)) {
      dieUsage(`security_product_path.tests points to a file that does not exist: ${item}`);
    }
    const normalized = rel.replaceAll('\\', '/');
    if (!files.includes(normalized)) files.push(normalized);
  }
  securityProductPathTests = files;
}

// F08 — reachability-aware CVE. OSV call analysis only says whether a vulnerability IS CALLED or not; it does not
// say the vulnerability is gone. So "not called" and "unknown" always stay in findings as
// evidence, and only the BLOCKING AUTHORITY changes. Default 'any': every finding still blocks as before — lowering the yardstick must be
// an explicitly declared action. A wrong value is a configuration error (exit 2), because if it were swallowed a mistyped
// string would silently fall back to the default and nobody would know which policy is running.
const CVE_BLOCKING_POLICIES = ['any', 'called'];
const cveConfig = config?.cve;
if (cveConfig !== undefined
  && (typeof cveConfig !== 'object' || cveConfig === null || Array.isArray(cveConfig))) {
  dieUsage('cve must be an object');
}
const cveReachabilityConfig = cveConfig?.reachability;
if (cveReachabilityConfig !== undefined
  && (typeof cveReachabilityConfig !== 'object' || cveReachabilityConfig === null
    || Array.isArray(cveReachabilityConfig))) {
  dieUsage('cve.reachability must be an object');
}
const cveBlockingPolicy = cveReachabilityConfig?.blocking ?? 'any';
if (!CVE_BLOCKING_POLICIES.includes(cveBlockingPolicy)) {
  dieUsage(`cve.reachability.blocking must be one of: ${CVE_BLOCKING_POLICIES.join(', ')}`);
}

// F01 — a "required" checker is a checker the config declares in receipts.required. A missing receipt
// or a version that cannot be probed for a required checker => layer UNGRADED, exit 20 (fail-closed).
// Empty by default so that an old config keeps its verdict; a receipt is still always written for every real checker.
const RECEIPT_TOOL_LAYERS = {
  gitleaks: 'secret',
  semgrep: 'sast',
  'osv-scanner': 'cve',
  node: 'coverage',
};
const requiredReceipts = config?.receipts?.required ?? [];
if (!Array.isArray(requiredReceipts)
  || requiredReceipts.some((item) => typeof item !== 'string' || !RECEIPT_TOOL_LAYERS[item])) {
  dieUsage(`receipts.required must be an array of checker names from: ${Object.keys(RECEIPT_TOOL_LAYERS).join(', ')}`);
}

// F02 — read the budget from the config. A budget must be a finite positive number of milliseconds; a wrong configuration is a
// configuration error (exit 2), not a verdict — otherwise the "over budget" yardstick would be loosened silently.
function positiveMs(value, label) {
  const number = Number(value);
  if (typeof value === 'boolean' || value === null || value === ''
    || !Number.isFinite(number) || number <= 0) {
    dieUsage(`${label} must be a positive number of milliseconds`);
  }
  return number;
}

const timeoutsConfig = config?.timeouts ?? {};
if (typeof timeoutsConfig !== 'object' || timeoutsConfig === null || Array.isArray(timeoutsConfig)) {
  dieUsage('timeouts must be an object');
}
const rawLayerBudgets = timeoutsConfig.layers;
if (rawLayerBudgets !== undefined) {
  if (typeof rawLayerBudgets !== 'object' || rawLayerBudgets === null || Array.isArray(rawLayerBudgets)) {
    dieUsage(`timeouts.layers must be an object with keys from: ${LAYER_NAMES.join(', ')}`);
  }
  for (const [name, value] of Object.entries(rawLayerBudgets)) {
    if (!LAYER_NAMES.includes(name)) {
      dieUsage(`timeouts.layers has an unknown layer: ${name}; valid: ${LAYER_NAMES.join(', ')}`);
    }
    layerBudgetMs.set(name, positiveMs(value, `timeouts.layers.${name}`));
  }
}
if (timeoutsConfig.total !== undefined) {
  totalBudgetMs = positiveMs(timeoutsConfig.total, 'timeouts.total');
}

function snapshotCommit(ref, testFiles) {
  const destination = mkdtempSync(join(tmpdir(), 'qa-code-acceptance-'));
  const archive = spawnSync('git', ['archive', '--format=tar', ref], {
    cwd: repo,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (archive.status !== 0 || archive.error) {
    archiveOwnedPath(destination);
    throw new Error(`cannot snapshot commit ${ref}`);
  }
  const extracted = spawnSync('tar', ['-xf', '-', '-C', destination], {
    input: archive.stdout,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (extracted.status !== 0 || extracted.error) {
    archiveOwnedPath(destination);
    throw new Error(`cannot extract snapshot ${ref}`);
  }
  // Acceptance tests themselves are the frozen yardstick from final HEAD. Overlay only those
  // files onto the base snapshot so fail-to-pass runs old code against the same assertion.
  for (const file of testFiles) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, file), target);
  }
  const dependencyDir = join(repo, 'node_modules');
  if (existsSync(dependencyDir) && !existsSync(join(destination, 'node_modules'))) {
    symlinkSync(dependencyDir, join(destination, 'node_modules'));
  }
  return destination;
}

function executeRequirementTests(requirements) {
  if (!requirements) return null;
  const allTests = [...new Set(requirements.flatMap((requirement) => [
    ...(requirement.mode === PRESERVATION_MODE ? requirement.preservation : requirement.fail_to_pass),
    ...requirement.pass_to_pass,
  ]))];
  let baseSnapshot = '';
  let headSnapshot = '';
  try {
    baseSnapshot = snapshotCommit(baseCommit, allTests);
    headSnapshot = snapshotCommit(commit, allTests);
    const results = [];
    for (const requirement of requirements) {
      const invoke = (cwd, files) => {
        const childEnv = { ...process.env, QA_CODE_NODE: process.execPath };
        // Gate 0 itself is often launched by a node:test acceptance. Inheriting this private
        // marker makes nested `node --test` silently skip every file and return 0.
        delete childEnv.NODE_TEST_CONTEXT;
        const remaining = totalRemainingMs();
        if (remaining <= 0) {
          return { status: null, signal: null, stdout: '', stderr: '', error: new Error('acceptance exceeded timeouts.total') };
        }
        if(testRunners) return runStackTests(files,{repo:cwd,run:(binary,args,extra={})=>spawnSync(binary,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,env:{...childEnv,...(extra.env??{})},timeout:Math.max(1,Math.ceil(Math.min(300_000,remaining))),killSignal:'SIGKILL'})});
        return spawnSync(process.execPath, ['--test', ...files], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          env: childEnv,
          timeout: Math.max(1, Math.ceil(Math.min(300_000, remaining))),
          killSignal: 'SIGKILL',
        });
      };
      const primaryTests = requirement.mode === PRESERVATION_MODE
        ? requirement.preservation
        : requirement.fail_to_pass;
      const primaryBase = invoke(baseSnapshot, primaryTests);
      const primaryHead = invoke(headSnapshot, primaryTests);
      const passBase = invoke(baseSnapshot, requirement.pass_to_pass);
      const passHead = invoke(headSnapshot, requirement.pass_to_pass);
      const outcomeFor = testExecutionOutcome;
      const statusesFor = (value) => ({
        status: value.status ?? null,
        signal: value.signal ?? null,
        error: value.error?.message ?? null,
        outcome: outcomeFor(value),
        stdout: String(value.stdout ?? '').slice(-2000),
        stderr: String(value.stderr ?? '').slice(-2000),
      });
      const outcomes = {
        primaryBase: outcomeFor(primaryBase),
        primaryHead: outcomeFor(primaryHead),
        passBase: outcomeFor(passBase),
        passHead: outcomeFor(passHead),
      };
      const primaryCovered = requirement.mode === PRESERVATION_MODE
        ? outcomes.primaryBase === 'pass' && outcomes.primaryHead === 'pass'
        : outcomes.primaryBase === 'fail' && outcomes.primaryHead === 'pass';
      const covered = primaryCovered
        && outcomes.passBase === 'pass'
        && outcomes.passHead === 'pass';
      results.push({
        id: requirement.id,
        ...(releaseTruth ? {
          requirement_id: requirement.requirement_id,
          assertion_id: requirement.assertion_id,
          case_id: requirement.case_id,
        } : {}),
        ...(requirement.mode === PRESERVATION_MODE ? { mode: PRESERVATION_MODE } : {}),
        covered,
        ...(requirement.mode === PRESERVATION_MODE
          ? { preservation: { base: statusesFor(primaryBase), head: statusesFor(primaryHead) } }
          : { fail_to_pass: { base: statusesFor(primaryBase), head: statusesFor(primaryHead) } }),
        pass_to_pass: { base: statusesFor(passBase), head: statusesFor(passHead) },
      });
    }
    const ids = results.filter((item) => item.covered).map((item) => item.id);
    const hasUngraded = results.some((item) => [
      ...(item.mode === PRESERVATION_MODE
        ? [item.preservation.base, item.preservation.head]
        : [item.fail_to_pass.base, item.fail_to_pass.head]),
      item.pass_to_pass.base,
      item.pass_to_pass.head,
    ].some((runResult) => runResult.outcome === 'ungraded'));
    const denominator = releaseTruth?.codeIds ?? results.map((item) => item.id);
    const coveredSet = new Set(ids);
    const missingIds = denominator.filter((id) => !coveredSet.has(id));
    return {
      status: missingIds.length === 0 ? 'pass' : (hasUngraded ? 'ungraded' : 'fail'),
      requirements,
      results,
      coverage: { covered: ids.length, total: denominator.length, ids },
      ...(releaseTruth ? { missing_ids: missingIds } : {}),
    };
  } catch (error) {
    return {
      status: 'ungraded',
      requirements,
      results: [],
      coverage: { covered: 0, total: releaseTruth?.codeIds.length ?? requirements.length, ids: [] },
      ...(releaseTruth ? { missing_ids: [...releaseTruth.codeIds] } : {}),
      notes: [error.message],
    };
  } finally {
    if (baseSnapshot) archiveOwnedPath(baseSnapshot);
    if (headSnapshot) archiveOwnedPath(headSnapshot);
  }
}

const diffResult = git([
  '-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff',
  baseCommit, commit, '--',
]);
if (diffResult.status !== 0) dieUsage('cannot read git diff');
const changedResult = git([
  '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-ext-diff',
  baseCommit, commit, '--',
]);
if (changedResult.status !== 0) dieUsage('cannot read the list of changed files');

function normalizeRepoPath(file) {
  if (!file) return '';
  let normalized = String(file).replaceAll('\\', '/');
  const repoPosix = repo.replaceAll('\\', '/');
  if (normalized.startsWith(`${repoPosix}/`)) normalized = normalized.slice(repoPosix.length + 1);
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function rawCoverageRepoPath(scriptUrl) {
  try {
    const absolute = scriptUrl.startsWith('file:') ? fileURLToPath(scriptUrl) : scriptUrl;
    const normalized = normalizeRepoPath(absolute);
    if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return '';
    return normalized;
  } catch {
    return '';
  }
}

function coveredSegments(functions, sourceLength) {
  const segments = [];
  for (const fn of Array.isArray(functions) ? functions : []) {
    const ranges = (fn.ranges ?? []).filter((range) => Number.isInteger(range.startOffset)
      && Number.isInteger(range.endOffset) && range.endOffset > range.startOffset);
    const boundaries = [...new Set(ranges.flatMap((range) => [range.startOffset, range.endOffset]))]
      .sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const start = Math.max(0, boundaries[index]);
      const end = Math.min(sourceLength, boundaries[index + 1]);
      if (end <= start) continue;
      const active = ranges.filter((range) => range.startOffset <= start && range.endOffset >= end)
        .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
      if (active[0]?.count > 0) segments.push([start, end]);
    }
  }
  return segments;
}

function mergeRawV8Coverage(v8Dir, coverageByFile) {
  let supplementedLines = 0;
  for (const entry of readdirSync(v8Dir)) {
    let report;
    try {
      report = JSON.parse(readFileSync(join(v8Dir, entry), 'utf8'));
    } catch {
      continue;
    }
    for (const script of report.result ?? []) {
      const file = rawCoverageRepoPath(String(script.url ?? ''));
      const lineCoverage = coverageByFile.get(file);
      if (!lineCoverage || !existsSync(join(repo, file))) continue;
      let source;
      try {
        source = readFileSync(join(repo, file), 'utf8');
      } catch {
        continue;
      }
      const starts = [0];
      for (let index = 0; index < source.length; index += 1) {
        if (source.charCodeAt(index) === 10) starts.push(index + 1);
      }
      for (const [start, end] of coveredSegments(script.functions, source.length)) {
        let low = 0;
        let high = starts.length;
        while (low + 1 < high) {
          const middle = Math.floor((low + high) / 2);
          if (starts[middle] <= start) low = middle;
          else high = middle;
        }
        for (let lineIndex = low; lineIndex < starts.length && starts[lineIndex] < end; lineIndex += 1) {
          const lineNo = lineIndex + 1;
          if (lineCoverage.has(lineNo) && (lineCoverage.get(lineNo) ?? 0) <= 0) {
            lineCoverage.set(lineNo, 1);
            supplementedLines += 1;
          }
        }
      }
    }
  }
  return supplementedLines;
}

function parseAddedLines(patch) {
  const byFile = new Map();
  let file = '';
  let newLine = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      file = raw === '/dev/null' ? '' : normalizeRepoPath(raw.startsWith('b/') ? raw.slice(2) : raw);
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file || line.startsWith('diff --git ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      byFile.get(file).push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\ No newline')) {
      newLine += 1;
    }
  }
  return byFile;
}

const addedByFile = parseAddedLines(diffResult.stdout);
const changedFiles = changedResult.stdout.split('\0').filter(Boolean).map(normalizeRepoPath);
const diffHasChanges = changedFiles.length > 0;

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
function isTestFile(file) {
  const parts = file.split('/');
  const name = parts.at(-1) ?? '';
  const teamCodeAcceptance = parts[0] === '.teamcode' && parts.includes('acceptance');
  return teamCodeAcceptance
    || parts.some((part) => ['test', 'tests', '__tests__', 'e2e'].includes(part))
    || /\.(?:test|spec|e2e)\.[^.]+$/i.test(name);
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) && !isTestFile(file);
}

function executableLines(file) {
  const full = join(repo, file);
  if (!existsSync(full)) return new Set();
  const source = readFileSync(full, 'utf8');
  let coverageSource = source;
  if (/\.tsx?$/i.test(file) && typeof nodeModule.stripTypeScriptTypes === 'function') {
    try {
      // Node's strip mode replaces erased TypeScript syntax with whitespace while preserving
      // line positions. Coverage therefore measures only code that can exist at runtime.
      coverageSource = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' });
    } catch {
      // Fail closed on unsupported syntax/runtime: keep the original conservative classifier.
      coverageSource = source;
    }
  }
  const lines = coverageSource.split(/\r?\n/);
  const executable = new Set();
  let inBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    let rest = lines[index];
    let code = '';
    while (rest.length > 0) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end < 0) {
          rest = '';
        } else {
          rest = rest.slice(end + 2);
          inBlock = false;
        }
        continue;
      }
      const block = rest.indexOf('/*');
      const slash = rest.indexOf('//');
      if (slash >= 0 && (block < 0 || slash < block)) {
        code += rest.slice(0, slash);
        rest = '';
      } else if (block >= 0) {
        code += rest.slice(0, block);
        rest = rest.slice(block + 2);
        inBlock = true;
      } else {
        code += rest;
        rest = '';
      }
    }
    if (code.trim()) executable.add(index + 1);
  }
  return executable;
}

const addedSource = new Map();
for (const [file, additions] of addedByFile) {
  if (!isSourceFile(file)) continue;
  const executable = executableLines(file);
  const lines = additions.filter((item) => item.text.trim() && executable.has(item.line));
  if (lines.length) addedSource.set(file, lines);
}

const docsOnlyExtensions = new Set(['.md', '.markdown', '.txt', '.rst']);
const nonBlankAdditions = [...addedByFile.entries()]
  .filter(([, additions]) => additions.some((item) => item.text.trim()));
const secretCandidates = nonBlankAdditions.length > 0;
const additionsAreDocsOnly = nonBlankAdditions.length > 0
  && nonBlankAdditions.every(([file]) => docsOnlyExtensions.has(extname(file).toLowerCase()));

const trackedFilesResult = git(['ls-files', '-z']);
const trackedFiles = trackedFilesResult.status === 0
  ? trackedFilesResult.stdout.split('\0').filter(Boolean).map(normalizeRepoPath)
  : [];
const hasSource = trackedFiles.some(isSourceFile);
const hasNodeManifest = existsSync(join(repo, 'package.json'));
const hasLockfile = existsSync(join(repo, 'package-lock.json'));
let hasDeclaredNodeDependencies = false;
if (hasNodeManifest) {
  try {
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    hasDeclaredNodeDependencies = [
      'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
    ].some((field) => Object.keys(manifest?.[field] ?? {}).length > 0);
  } catch {
    // A broken manifest will be downgraded by coverage/test or by the scanner itself; do not infer that there are dependencies.
  }
}

function globRegex(pattern) {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

const coverageTestFiles = coverageTestPatterns
  ? trackedFiles.filter((file) => coverageTestPatterns.some((pattern) => globRegex(pattern).test(file)))
  : [];
const dependencyChanged = changedFiles.some((file) => {
  const name = basename(file).toLowerCase();
  return name === 'package.json' || name === 'package-lock.json'
    || name === 'npm-shrinkwrap.json' || name === 'yarn.lock'
    || name === 'pnpm-lock.yaml';
});

function skipped(tool, extra = {}) {
  const supplied = Array.isArray(extra.notes) ? extra.notes.filter((item) => typeof item === 'string' && item.trim()) : [];
  return {
    status: 'skipped',
    tool,
    findings: [],
    ...extra,
    notes: supplied.length > 0 ? supplied : [`NOT_TRIGGERED_OR_NOT_CONFIGURED:${tool}`],
  };
}

function ungraded(tool, note, extra = {}) {
  return { status: 'ungraded', tool, findings: [], notes: [note], ...extra };
}

const layers = {
  secret: skipped('gitleaks'),
  sast: skipped('semgrep', { excluded: [], notes: [] }),
  cve: skipped('osv-scanner'),
  coverage: skipped('node-test', {
    patch_pct: 100,
    threshold,
    repo_pct: null,
    baseline_pct: null,
  }),
  prompt_injection: skipped('qa-code-injection'),
  // F06: skipped by default — the layer only has a say when the diff touches a risk group.
  threat_model: skipped('qa-code-threat-model', { triggers: [], notes: [] }),
  // F07: same trigger condition as F06 — a diff without risk owes no evidence.
  security_product_path: skipped('qa-code-product-path', { triggers: [], notes: [] }),
};

// F02 — open/close a layer's scope: stamp the clock to record duration_ms and so that run() knows
// which layer is running and applies its budget. When the run has used up timeouts.total, a layer that has not run must be
// ungraded and must not be treated as pass/skip.
function withLayer(name, tool, body, extra = {}) {
  const start = process.hrtime.bigint();
  activeLayer = { name, start };
  try {
    if (totalRemainingMs() <= 0) {
      layers[name] = ungraded(tool, `skipped because the run exceeded the timeouts.total budget ${totalBudgetMs}ms`, extra);
      return;
    }
    body();
  } finally {
    layerDurationMs[name] += elapsedMsSince(start);
    activeLayer = null;
  }
}

function budgetNote(tool) {
  const name = activeLayer?.name;
  const limit = name === undefined ? undefined : layerBudgetMs.get(name);
  return limit === undefined
    ? `${tool} blocked by timeout: exceeded the timeouts.total budget ${totalBudgetMs}ms`
    : `${tool} blocked by timeout: exceeded the timeouts.layers.${name} budget ${limit}ms`;
}

// F05 — the Markdown/config surface meant for agents is UNTRUSTED input: a coding agent reads it as
// real instructions. Only files that agents actually load are in scan scope; ordinary product config
// (qa-code.json, package.json…) is not an instruction surface and is not blocked unfairly.
const AGENT_SURFACE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.mdc']);
const AGENT_SURFACE_NAMES = new Set([
  'agents.md', 'claude.md', 'skill.md', 'copilot-instructions.md',
  '.cursorrules', '.windsurfrules', '.clinerules', '.aiderrules', '.goosehints',
]);
const AGENT_SURFACE_DIRS = ['.agents/', 'agents/', '.claude/', '.cursor/', '.github/agents/'];
const AGENT_CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.toml', '.json']);

function isAgentSurface(file) {
  const lower = file.toLowerCase();
  if (AGENT_SURFACE_EXTENSIONS.has(extname(lower))) return true;
  if (AGENT_SURFACE_NAMES.has(basename(lower))) return true;
  // Config inside an agent-instruction folder is also loaded by agents like a prompt.
  return AGENT_CONFIG_EXTENSIONS.has(extname(lower))
    && AGENT_SURFACE_DIRS.some((dir) => lower.startsWith(dir) || lower.includes(`/${dir}`));
}

// Invisible/control characters (bidi override, zero-width, tag character…) let someone hide instructions that
// a reviewer does not see in the diff, so they are blocked even when the visible part is harmless.
function isHiddenChar(code) {
  return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
    || code === 0x00ad || code === 0x061c || code === 0x180e
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2064) || (code >= 0x206a && code <= 0x206f)
    || code === 0xfeff || (code >= 0xe0000 && code <= 0xe007f);
}

function hiddenCodePoints(text) {
  const codes = new Set();
  for (const char of text) {
    const code = char.codePointAt(0);
    if (isHiddenChar(code)) codes.add(code);
  }
  return [...codes].sort((a, b) => a - b)
    .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
}

// Instruction hijack: an imperative sentence telling the agent to drop its current instructions. It deliberately requires the full
// action + scope + instruction-noun phrase, so security documentation that only mentions the terms
// ("prompt injection", "instruction hijack") stays green.
const HIJACK_PATTERN = /\b(?:ignore|disregard|forget|override|bypass)\b[^.;\n]{0,60}?\b(?:all\s+|any\s+)?(?:previous|prior|preceding|earlier|above|foregoing|system|original)\b[^.;\n]{0,40}?\b(?:instruction|instructions|prompt|prompts|rule|rules|directive|directives|guideline|guidelines)\b/i;

// Secret exfiltration: requires ALL of an action + a secret asset + an out-of-band receiving target. The word
// "secret" or "exfiltration" alone in documentation is not enough to turn red.
const EXFIL_ACTION = /\b(?:exfiltrat\w*|leak|leaks|leaking|send|post|upload|transmit|forward|reveal|disclose|dump|email|curl|wget)\b/i;
const EXFIL_ASSET = /\b(?:secret|secrets|credential|credentials|password|passwords|api[ _-]?keys?|access[ _-]?tokens?|private[ _-]?keys?|ssh[ _-]?keys?|\.env|env(?:ironment)?[ _-]?(?:variables?|vars?|secrets?))\b/i;
const EXFIL_TARGET = /https?:\/\/|\b(?:attacker|adversary|third[ -]part(?:y|ies)|external\s+(?:server|endpoint|service|host|url)|remote\s+(?:server|endpoint|host)|webhook|pastebin)\b/i;

const INJECTION_RULES = [
  {
    id: 'prompt-injection/instruction-hijack',
    detail: 'an added line tells the agent to ignore its current instructions',
    match: (text) => HIJACK_PATTERN.test(text),
  },
  {
    id: 'prompt-injection/secret-exfiltration',
    detail: 'an added line asks to send secrets to an out-of-band target',
    match: (text) => EXFIL_ACTION.test(text) && EXFIL_ASSET.test(text) && EXFIL_TARGET.test(text),
  },
];

// The diff is base → working tree (NOT base → HEAD) because agents read the files that are on disk:
// an uncommitted payload still drives the next run. Returning null = the scan scope cannot be built
// => the layer is ungraded, never inferred as pass.
const UNTRACKED_MAX_BYTES = 1024 * 1024;

// The base → working tree scope shared by F05 and F06: those two layers grade what is on disk,
// not what was committed. Read once because git plumbing is not cheap and both layers must see the same
// current state. Returning null = the scope cannot be built => the calling layer must be ungraded, never infer pass.
let worktreeScopeCache;
function worktreeScope() {
  if (worktreeScopeCache !== undefined) return worktreeScopeCache;
  const diff = git([
    '-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff',
    baseCommit, '--',
  ]);
  const names = git([
    '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-ext-diff', baseCommit, '--',
  ]);
  // Untracked files do not appear in the diff but are still on disk; all their lines are new.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff.status !== 0 || names.status !== 0 || untracked.status !== 0) {
    worktreeScopeCache = null;
    return null;
  }
  const untrackedFiles = untracked.stdout.split('\0').filter(Boolean).map(normalizeRepoPath);
  worktreeScopeCache = {
    tracked: parseAddedLines(diff.stdout),
    untracked: untrackedFiles,
    // Includes deleted files: removing an auth file is also a change that touches the risk surface.
    files: [...new Set([
      ...names.stdout.split('\0').filter(Boolean).map(normalizeRepoPath),
      ...untrackedFiles,
    ])],
  };
  return worktreeScopeCache;
}

function worktreeAdditions(accept) {
  const scope = worktreeScope();
  if (!scope) return null;
  const byFile = new Map();
  for (const [file, additions] of scope.tracked) {
    if (accept(file) && additions.length) byFile.set(file, additions);
  }
  for (const file of scope.untracked) {
    if (!accept(file) || byFile.has(file)) continue;
    let content;
    try {
      content = readFileSync(join(repo, file), 'utf8');
    } catch {
      continue;
    }
    if (content.length > UNTRACKED_MAX_BYTES) continue;
    const lines = content.split('\n').map((text, index) => ({ line: index + 1, text }));
    if (lines.length) byFile.set(file, lines);
  }
  return byFile;
}

// F06 — detect changes that touch a risk group. Matching runs on a string with camelCase split and separators
// normalized, so "authorizePayment" or "api_key" expose their words, while "format.mjs" does not hit
// "auth" because matching is by word boundary, not substring.
function normalizeTriggerText(text) {
  return ` ${String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

// Keywords are deliberately kept narrow: only words that on their own already signal a risk surface. Words that source code uses
// with other meanings ("scope" of a variable, "schema" of JSON, "token" of a parser) are excluded so that a diff without
// risk is not blocked unfairly — that is also half of the F06 yardstick.
const RISK_TRIGGERS = [
  {
    group: 'auth',
    pattern: /\b(?:auth|authn|authz|authenticat\w*|authoriz\w*|login|logout|signin|signup|session|sessions|oauth|oidc|saml|sso|jwt|mfa|otp|password\w*|passwd|credential\w*|bearer)\b/,
  },
  {
    group: 'payment',
    pattern: /\b(?:payment\w*|billing|invoice\w*|checkout|charge\w*|refund\w*|subscription\w*|payout\w*|stripe|paypal|braintree|wallet)\b/,
  },
  {
    group: 'permission',
    pattern: /\b(?:permission\w*|acl|rbac|abac|role|roles|grant\w*|privilege\w*|entitlement\w*|admin|administrator|superuser|iam)\b/,
  },
  {
    group: 'migration',
    pattern: /\b(?:migration\w*|migrate\w*|alembic|flyway|liquibase|alter table|drop table|create table|drop column|db schema|database schema)\b/,
  },
  {
    group: 'secret',
    pattern: /\b(?:secret\w*|api keys?|access tokens?|refresh tokens?|auth tokens?|private keys?|ssh keys?|passphrase|keystore|keyring|vault|dotenv)\b/,
  },
];

// Content is graded only on code/config files: documentation that mentions "role" or "secret" is prose, not
// a permission change. The documentation surface is covered by the prompt_injection layer, and real secrets by gitleaks.
const RISK_CONTENT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.java', '.kt', '.cs',
  '.php', '.rs', '.swift', '.scala', '.sql', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml',
  '.json', '.tf', '.env', '.ini', '.conf', '.gradle', '.ex', '.exs',
]);

// Triggers can be very many on a large diff; findings are cut at this threshold and the cut part is DECLARED
// in notes, never cut silently.
const TRIGGER_FINDING_MAX = 50;

// Two of the gate's own files are outside the trigger scope: the qa-code config names a layer with the very word
// "secret", and a threat model by definition lists sensitive assets. Grading them as product surface
// would be shooting ourselves in the foot — changing the yardstick is not changing the product's risk.
function isTriggerScope(file) {
  return file !== configRepoPath && file !== threatModelPath;
}

function isRiskContentFile(file) {
  return isTriggerScope(file) && RISK_CONTENT_EXTENSIONS.has(extname(file.toLowerCase()));
}

// Returning null = the scope cannot be built => the layer is ungraded. An empty array = the diff really has no risk.
function riskTriggerHits() {
  const scope = worktreeScope();
  if (!scope) return null;
  const hits = [];
  for (const file of scope.files) {
    if (!isTriggerScope(file)) continue;
    const normalized = normalizeTriggerText(file);
    for (const trigger of RISK_TRIGGERS) {
      const match = normalized.match(trigger.pattern);
      if (match) hits.push({ file, group: trigger.group, evidence: 'path', keyword: match[0].trim() });
    }
  }
  const additions = worktreeAdditions(isRiskContentFile);
  if (!additions) return null;
  for (const [file, lines] of additions) {
    for (const item of lines) {
      const normalized = normalizeTriggerText(item.text);
      for (const trigger of RISK_TRIGGERS) {
        const match = normalized.match(trigger.pattern);
        if (match) {
          hits.push({
            file, line: item.line, group: trigger.group, evidence: 'added_line', keyword: match[0].trim(),
          });
        }
      }
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
    || a.group.localeCompare(b.group));
  return hits;
}

function riskTriggerFiles(hits) {
  const unique = new Map();
  for (const hit of hits) {
    unique.set(`${hit.group}\0${hit.file}`, { group: hit.group, file: hit.file });
  }
  return [...unique.values()].sort((a, b) => a.group.localeCompare(b.group) || a.file.localeCompare(b.file));
}

// A valid model = a JSON object with all four sections, each a non-empty array of nameable entries.
// An empty array or an anonymous entry is not a threat model, only an empty frame to slip past the gate.
function isNamedEntry(item) {
  if (typeof item === 'string') return item.trim().length > 0;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const name = item.name ?? item.id ?? item.title;
  return typeof name === 'string' && name.trim().length > 0;
}

function readThreatModel() {
  if (!threatModelPath) {
    return {
      notes: ['the config does not declare threat_model.path, so there is no threat model JSON to check'],
      model: null,
    };
  }
  let raw;
  try {
    raw = readFileSync(join(repo, threatModelPath), 'utf8');
  } catch {
    return { notes: [`cannot read the threat model JSON at ${threatModelPath}`], model: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { notes: [`threat model is not valid JSON: ${threatModelPath}`], model: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { notes: [`threat model must be a JSON object: ${threatModelPath}`], model: null };
  }
  const notes = [];
  const counts = {};
  for (const section of THREAT_MODEL_SECTIONS) {
    const value = parsed[section];
    if (!Array.isArray(value) || value.length === 0) {
      notes.push(`threat model ${threatModelPath} is missing section ${section}: it must be a non-empty array`);
      continue;
    }
    const anonymous = value.filter((item) => !isNamedEntry(item)).length;
    if (anonymous) {
      notes.push(`threat model ${threatModelPath} has ${anonymous} unnamed entries in ${section}`);
      continue;
    }
    counts[section] = value.length;
  }
  return { notes, model: notes.length ? null : { path: threatModelPath, ...counts } };
}

// V5/N2: tempDir is created unconditionally, outside the repo and the target HOME, and always cleaned up in finally.
// V5/N7: the coverage baseline is anchored in ~/.qa-code/<repo-hash>/, no .qa-code appears in the repo.
const repoHash = createHash('sha256').update(repo).digest('hex').slice(0, 12);
const baselineDir = join(process.env.HOME || tmpdir(), '.qa-code', repoHash);
const baselinePath = join(baselineDir, 'coverage-baseline.json');

let tempDir = '';
let scratchArchive=null;
const nativeRunnerEvidence={};
try {
  tempDir = mkdtempSync(join(tmpdir(), 'qa-code-gate0-'));

  // T1 — keep only findings that sit exactly on lines added in the diff.
  if (secretCandidates) withLayer('secret', 'gitleaks', () => {
    if (!commandExists('gitleaks')) {
      layers.secret = ungraded('gitleaks', 'missing binary gitleaks');
    } else {
      const reportPath = join(tempDir, 'gitleaks.json');
      // The scanner config is QA's own, never the repo's: without --config gitleaks loads <source>/.gitleaks.toml, so
      // the diff under review could allowlist its own secret, or ship a malformed file that makes gitleaks exit 1
      // without a report. The QA config only extends gitleaks' default rules.
      const configPath = join(tempDir, 'gitleaks.toml');
      writeFileSync(configPath, GITLEAKS_QA_CONFIG);
      // F02 — probe the version BEFORE running the scan: if the scan uses up the budget the receipt still
      // records the real version, which avoids turning a timeout into "version could not be probed".
      const receipt = checkerReceipt('gitleaks');
      const result = run('gitleaks', [
        'detect', '--no-git', '--source', repo, '--config', configPath, '--report-format', 'json',
        '--report-path', reportPath, '--exit-code', '1', '--no-banner',
      ]);
      if (result.timedOut) {
        layers.secret = ungraded('gitleaks', budgetNote('gitleaks'));
      } else if (result.error || (result.status !== 0 && result.status !== 1)) {
        layers.secret = ungraded('gitleaks', 'gitleaks crashed or returned invalid output');
      } else if (!existsSync(reportPath)) {
        // gitleaks writes the report whenever --report-path is given; none means it stopped early (a fatal error also
        // exits 1), which is not evidence of a clean scan.
        layers.secret = ungraded('gitleaks', `gitleaks exited ${result.status} without writing its JSON report`);
      } else {
        let raw = [];
        try {
          raw = JSON.parse(readFileSync(reportPath, 'utf8') || '[]');
          if (!Array.isArray(raw)) throw new Error('report is not an array');
        } catch {
          layers.secret = ungraded('gitleaks', 'cannot read JSON from gitleaks');
        }
        // --exit-code 1 means "leaks found", but a partial scan error exits 1 too; with an empty report that is
        // a scanner failure, not a pass.
        if (layers.secret.status !== 'ungraded' && result.status === 1 && raw.length === 0) {
          layers.secret = ungraded('gitleaks', 'gitleaks exited 1 but its report has no finding: a scanner error, not a clean scan');
        }
        if (layers.secret.status !== 'ungraded') {
          const findings = raw
            .map((finding) => ({
              file: normalizeRepoPath(finding.File ?? finding.file),
              line: Number(finding.StartLine ?? finding.line),
              rule: finding.RuleID ?? finding.rule ?? 'unknown',
              detail: finding.Description ?? finding.detail ?? 'secret on an added line',
            }))
            .filter((finding) => Number.isInteger(finding.line)
              && (addedByFile.get(finding.file) ?? []).some((item) => item.line === finding.line))
            .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
          const noScannableProject = additionsAreDocsOnly && !hasSource && !hasNodeManifest && !hasLockfile;
          layers.secret = findings.length
            ? { status: 'fail', tool: 'gitleaks', findings }
            : noScannableProject
              ? skipped('gitleaks')
              : { status: 'pass', tool: 'gitleaks', findings: [] };
        }
      }
      if (existsSync(reportPath)) {
        const reportHash=createHash('sha256').update(readFileSync(reportPath)).digest('hex');
        chmodSync(reportPath,0o600);
        const archived=archiveOwnedPath(reportPath);
        layers.secret.raw_scanner={status:result.status===1?'fail':'pass',report:{path:archived,sha256:reportHash}};
        if(secretAdjudication&&layers.secret.status==='fail'){
          try {
            layers.secret.adjudication=verifySecretAdjudication({repo,base:baseCommit,head:commit,reportPath:archived,reportSha256:reportHash,proofPath:resolve(repo,secretAdjudication.proof),runtimePath:secretAdjudication.runtime?resolve(repo,secretAdjudication.runtime):undefined});
            if(layers.secret.adjudication.status==='pass')layers.secret.effective_status='pass';
          }catch(error){layers.secret.adjudication={status:'fail',reason:error.message};}
        }
      }
      layers.secret.receipt = receipt;
    }
  });

  // T2 — run exactly two rulesets, block on ERROR; exclude only by exact rule id.
  if (hasSource) withLayer('sast', 'semgrep', () => {
    const excluded = Array.isArray(config?.sast?.exclude)
      ? config.sast.exclude
        .filter((item) => item && typeof item.rule === 'string')
        .map((item) => ({ rule: item.rule, why: String(item.why ?? '') }))
      : [];
    const excludedRules = new Set(excluded.map((item) => item.rule));
    if (!commandExists('semgrep')) {
      layers.sast = ungraded('semgrep', 'missing binary semgrep', { excluded, notes: [] });
    } else {
      const receipt = checkerReceipt('semgrep');
      const result = run('semgrep', [
        '--config', 'p/default', '--config', 'p/owasp-top-ten',
        '--json', '--quiet', '--metrics', 'off', '.',
      ], {
        // By default Semgrep writes logs/settings/cache into the user's folders. Gate 0
        // anchors every side effect in a tempDir inside --repo and cleans it up in finally.
        env: {
          SEMGREP_LOG_FILE: join(tempDir, 'semgrep.log'),
          SEMGREP_SETTINGS_FILE: join(tempDir, 'semgrep-settings.yml'),
          SEMGREP_VERSION_CACHE_PATH: join(tempDir, 'semgrep-version'),
          XDG_CACHE_HOME: tempDir,
          XDG_CONFIG_HOME: tempDir,
        },
      });
      // V5/N1: Semgrep exits 1 when there is a blocking finding; parse the JSON whether the exit is 0 or 1.
      if (result.timedOut) {
        layers.sast = ungraded('semgrep', budgetNote('semgrep'), { excluded });
      } else if (result.error || (result.status !== 0 && result.status !== 1)) {
        layers.sast = ungraded('semgrep', 'semgrep crashed or returned invalid output', { excluded, notes: [] });
      } else {
        try {
          const raw = JSON.parse(result.stdout || '{}');
          if (!Array.isArray(raw.results)) throw new Error('results is not an array');
          const normalized = raw.results.map((finding) => ({
            file: normalizeRepoPath(finding.path),
            line: Number(finding.start?.line),
            rule: String(finding.check_id ?? 'unknown'),
            severity: String(finding.extra?.severity ?? '').toUpperCase(),
            detail: String(finding.extra?.message ?? ''),
          }));
          const active = normalized.filter((finding) => !excludedRules.has(finding.rule)
            && (!diffHasChanges
              || (addedByFile.get(finding.file) ?? []).some((item) => item.line === finding.line)));
          const findings = active
            .filter((finding) => finding.severity === 'ERROR' && finding.file && Number.isInteger(finding.line))
            .map(({ severity: _severity, ...finding }) => finding)
            .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
          const notes = active
            .filter((finding) => finding.severity !== 'ERROR')
            .map((finding) => `${finding.severity || 'UNKNOWN'} ${finding.rule} ${finding.file}:${finding.line}`)
            .sort();
          layers.sast = {
            status: findings.length ? 'fail' : 'pass',
            tool: 'semgrep',
            findings,
            excluded,
            notes,
          };
        } catch {
          layers.sast = ungraded('semgrep', 'cannot read JSON from semgrep', { excluded, notes: [] });
        }
      }
      layers.sast.receipt = receipt;
    }
  }, { excluded: [] });

  // F08 — OSV v2 emits call analysis per group, either keyed by the exact vulnerability ID or flat for the whole
  // group. Only a boolean is evidence: no matching group, no key, or a wrong type all return
  // 'unknown' — never infer "not called" from a blank, because that loosens the yardstick silently.
  function osvCalled(packageResult, vulnerabilityId) {
    for (const group of packageResult?.groups ?? []) {
      const ids = Array.isArray(group?.ids) ? group.ids.map((id) => String(id)) : [];
      if (!ids.includes(vulnerabilityId)) continue;
      const analysis = group.experimental_analysis;
      if (typeof analysis !== 'object' || analysis === null) continue;
      const scoped = analysis[vulnerabilityId];
      const entry = typeof scoped === 'object' && scoped !== null ? scoped : analysis;
      if (typeof entry.called === 'boolean') return entry.called;
    }
    return 'unknown';
  }

  function osvScannerArgs(receipt) {
    const match = String(receipt?.version ?? '').match(/\b(\d+)\.\d+(?:\.\d+)?\b/);
    const major = match ? Number(match[1]) : 1;
    if (major < 2) return ['--format', 'json', repo];
    // OSV v2 moved to the `scan source` subcommand. `--all-vulns` keeps uncalled findings too;
    // `--all-packages` makes package evidence present even when there is no vulnerability.
    return [
      'scan', 'source', '--format', 'json', '--all-packages', '--all-vulns',
      '--allow-no-lockfiles', '-r', repo,
    ];
  }

  // T3 — P1 only supports Node manifests; HIGH/CRITICAL must also have a fixed version.
  const cveReceiptRequired = requiredReceipts.includes('osv-scanner');
  if ((hasNodeManifest || hasLockfile)
    && (!diffHasChanges || dependencyChanged || cveReceiptRequired)) withLayer('cve', 'osv-scanner', () => {
    let result;
    let usedOsvBinary = false;
    let osvReceipt = null;
    const cveEnv = {
      HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
    };
    if (options.cveCmd) {
      // The repo is a positional parameter, never joined/escaped into a command string; a path with spaces stays intact.
      result = run('bash', ['-c', `${options.cveCmd} "$@"`, 'qa-code-cve', repo], { env: cveEnv });
    } else if (!commandExists('osv-scanner')) {
      layers.cve = ungraded('osv-scanner', 'missing binary osv-scanner');
    } else {
      // osv-scanner uses a local cache/DB; anchor HOME/XDG in a temp folder inside
      // --repo so that no side effect appears in the user's folders.
      osvReceipt = checkerReceipt('osv-scanner', { env: cveEnv });
      result = run('osv-scanner', osvScannerArgs(osvReceipt), { env: cveEnv });
      usedOsvBinary = true;
    }
    if (result) {
      if (result.timedOut) {
        layers.cve = ungraded('osv-scanner', budgetNote('osv-scanner/cve-cmd'));
      } else if (result.error) {
        layers.cve = ungraded('osv-scanner', 'osv-scanner/cve-cmd crashed or returned invalid output');
      } else if (result.status !== 0 && result.status !== 1) {
        // 0 = no vulnerability, 1 = vulnerabilities found; anything else (127 query/network error, 128 no package
        // source, a crashed --cve-cmd wrapper) is not a scan result, even when some JSON reached stdout.
        layers.cve = ungraded('osv-scanner', `osv-scanner/cve-cmd exited ${String(result.status)}: not a scan result`);
      } else {
        try {
          const raw = JSON.parse(result.stdout || '{}');
          const scanResults = raw.results === null ? [] : raw.results;
          if (!Array.isArray(scanResults)) throw new Error('results is not an array');
          if (scanResults.length === 0 && (hasLockfile || hasDeclaredNodeDependencies)) {
            throw new Error('the scanner returned no package source for a project with dependencies');
          }
          const findings = [];
          for (const scanResult of scanResults) {
            const sourceFile = normalizeRepoPath(scanResult.source?.path) || 'package-lock.json';
            for (const packageResult of scanResult.packages ?? []) {
              const packageName = packageResult.package?.name ?? 'unknown';
              for (const vulnerability of packageResult.vulnerabilities ?? []) {
                const fixedVersions = [];
                for (const affected of vulnerability.affected ?? []) {
                  for (const range of affected.ranges ?? []) {
                    for (const event of range.events ?? []) {
                      if (event.fixed) fixedVersions.push(String(event.fixed));
                    }
                  }
                }
                const dbSeverity = String(vulnerability.database_specific?.severity ?? '').toUpperCase();
                const numeric = Number(packageResult.groups?.[0]?.max_severity);
                const severity = ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'].includes(dbSeverity)
                  ? (dbSeverity === 'MODERATE' ? 'MEDIUM' : dbSeverity)
                  : (numeric >= 9 ? 'CRITICAL' : numeric >= 7 ? 'HIGH' : numeric >= 4 ? 'MEDIUM' : 'LOW');
                if (['HIGH', 'CRITICAL'].includes(severity) && fixedVersions.length) {
                  const vulnerabilityId = String(vulnerability.id ?? 'unknown');
                  const called = osvCalled(packageResult, vulnerabilityId);
                  findings.push({
                    file: sourceFile,
                    package: packageName,
                    id: vulnerabilityId,
                    severity,
                    fixed: fixedVersions[0],
                    // Reachability evidence comes with EVERY finding, even when the policy does not use it,
                    // so that the reader of the verdict sees the basis of the blocking authority instead of having to trust it.
                    called,
                    blocking: cveBlockingPolicy === 'called' ? called === true : true,
                  });
                }
              }
            }
          }
          findings.sort((a, b) => a.file.localeCompare(b.file)
            || a.package.localeCompare(b.package) || a.id.localeCompare(b.id));
          // A finding without blocking authority still stays in findings as evidence; only the verdict reads blocking.
          // With the default 'any' every finding is blocking, so this condition matches the old behavior exactly.
          const blocking = findings.some((finding) => finding.blocking);
          layers.cve = { status: blocking ? 'fail' : 'pass', tool: 'osv-scanner', findings };
        } catch {
          layers.cve = ungraded('osv-scanner', 'cannot read JSON from osv-scanner/cve-cmd');
        }
      }
    }
    // --cve-cmd is an arbitrary shell command, not a known binary => no fake receipt is issued.
    if (usedOsvBinary) layers.cve.receipt = osvReceipt;
  });

  // F03 — the outcome of one test run. Only exit 0 is pass; a timeout or a failure to spawn is
  // ungraded, not fail, to keep the line between "red test" and "cannot be graded".
  function testRunStatus(result) {
    if (!result || result.timedOut || result.error) return 'ungraded';
    return result.status === 0 ? 'pass' : 'fail';
  }

  // Run 1 is the coverage run itself: the same configured test suite on the same pinned runtime, so
  // count it instead of spawning a duplicate run. The other runs rerun exactly that suite,
  // without the coverage reporter, and still within the coverage layer budget of F02.
  function recordStabilityRuns(firstResult, firstDurationMs) {
    if (!firstResult) {
      stability.notes.push('cannot run the configured test suite, so no run could be repeated');
      return;
    }
    stability.outcomes.push({
      run: 1,
      status: testRunStatus(firstResult),
      duration_ms: Math.max(0, Math.round(firstDurationMs)),
    });
    for (let index = 2; index <= stability.runs; index += 1) {
      const start = process.hrtime.bigint();
      const repeat = testRunners ? runStackTests(coverageTestFiles) : run(process.execPath, ['--test', ...coverageTestFiles], {
        unsetEnv: ['NODE_TEST_CONTEXT'],
      });
      stability.outcomes.push({
        run: index,
        status: testRunStatus(repeat),
        duration_ms: Math.max(0, Math.round(elapsedMsSince(start))),
      });
    }
  }

  // T4 — a source file absent from lcov still gets 0% coverage for its added lines.
  if ((hasNodeManifest || testRunners) && hasSource) withLayer('coverage', 'node-test', () => {
      const lcovPath = join(tempDir, 'coverage.lcov');
      const v8CoverageDir = join(tempDir, 'v8-coverage');
      mkdirSync(v8CoverageDir);
      // V6/M2: coverage runs with the runtime that RUNS the helper (process.execPath = the node pinned through
      // QA_CODE_NODE/.node-path), it does NOT search for `node` in PATH — the installed PATH (LaunchAgent) may
      // not contain Node, and the PATH node may differ from the runtime declared in node.path.
      const coverageArgs = [
        '--test', '--experimental-test-coverage', '--test-reporter=lcov',
        `--test-reporter-destination=${lcovPath}`,
        ...coverageTestFiles,
      ];
      const noConfiguredTests = coverageTestPatterns && coverageTestFiles.length === 0;
      const coverageRunStart = process.hrtime.bigint();
      const result = noConfiguredTests ? null : testRunners ? runStackTests(coverageTestFiles,{coverageDir:join(tempDir,'native-coverage')}) : run(process.execPath, coverageArgs, {
        env: { NODE_V8_COVERAGE: v8CoverageDir },
        // Gate 0 is often called by acceptance from node:test. Do not let the child runner
        // inherit the parent runner's worker marker, otherwise Node looks for an IPC that does not exist.
        unsetEnv: ['NODE_TEST_CONTEXT'],
      });
      if (testRunners && result?.status===0 && !result.error) writeFileSync(lcovPath,result.reports.map(p=>readFileSync(p,'utf8')).join('\n'));
      if(testRunners) nativeRunnerEvidence.coverage={records:result?.records??[],exit_status:result?.status??null,first_error:result?.error?.message??null,stderr:result?.stderr??'',stdout:result?.stdout??''};
      if (stability) recordStabilityRuns(result, elapsedMsSince(coverageRunStart));
      if (result?.timedOut) {
        layers.coverage = ungraded('node-test', budgetNote('node-test'), {
          patch_pct: 0, threshold, repo_pct: null, baseline_pct: null,
        });
      } else if (!result || result.error || result.status !== 0 || !existsSync(lcovPath)) {
        layers.coverage = ungraded('node-test', noConfiguredTests
          ? 'coverage.testFiles matches no test file'
          : testRunners ? 'declared native test runner failed; inspect runner records' : 'node test/coverage crashed or the tests failed', {
          patch_pct: 0, threshold, repo_pct: null, baseline_pct: null,
        });
      } else {
        const coverageByFile = new Map();
        let current = null;
        for (const line of readFileSync(lcovPath, 'utf8').split(/\r?\n/)) {
          if (line.startsWith('SF:')) {
            current = normalizeRepoPath(line.slice(3));
            if (!coverageByFile.has(current)) coverageByFile.set(current, new Map());
          } else if (line.startsWith('DA:') && current) {
            const [lineNo, hits] = line.slice(3).split(',').map(Number);
            if (Number.isInteger(lineNo) && Number.isFinite(hits)) {
              coverageByFile.get(current).set(lineNo, hits+(coverageByFile.get(current).get(lineNo)??0));
            }
          }
        }
        const dynamicVmLines = mergeRawV8Coverage(v8CoverageDir, coverageByFile);
        let totalFound = 0;
        let totalHit = 0;
        for (const [file, lines] of coverageByFile) {
          if (!isSourceFile(file)) continue;
          totalFound += lines.size;
          totalHit += [...lines.values()].filter((hits) => hits > 0).length;
        }

        let addedTotal = 0;
        let addedHit = 0;
        const findings = [];
        for (const [file, additions] of addedSource) {
          const fileCoverage = coverageByFile.get(file) ?? new Map();
          const uncovered = [];
          for (const item of additions) {
            addedTotal += 1;
            if ((fileCoverage.get(item.line) ?? 0) > 0) addedHit += 1;
            else uncovered.push(item.line);
          }
          if (uncovered.length) {
            findings.push({ file, line: uncovered[0], uncovered_added_lines: uncovered });
          }
        }
        findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        const patchPct = addedTotal === 0 ? 100 : Number(((addedHit / addedTotal) * 100).toFixed(1));
        const repoPct = totalFound === 0 ? 0 : Number(((totalHit / totalFound) * 100).toFixed(1));
        let baselinePct = null;
        if (existsSync(baselinePath)) {
          try {
            const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
            const candidate = baseline.repo_pct ?? baseline.coverage_pct ?? baseline.total;
            if (Number.isFinite(Number(candidate))) baselinePct = Number(candidate);
          } catch {
            layers.coverage = ungraded('node-test', 'the coverage baseline is not valid JSON', {
              patch_pct: patchPct, threshold, repo_pct: repoPct, baseline_pct: null,
            });
          }
        }
        if (layers.coverage.status !== 'ungraded') {
          const patchFailed = patchPct < threshold;
          const repoDropped = baselinePct !== null && repoPct < baselinePct;
          layers.coverage = {
            status: patchFailed || repoDropped ? 'fail' : 'pass',
            tool: 'node-test',
            patch_pct: patchPct,
            threshold,
            repo_pct: repoPct,
            baseline_pct: baselinePct,
            dynamic_vm_lines: dynamicVmLines,
            findings: patchFailed ? findings : [],
          };
          if (repoDropped) {
            layers.coverage.findings.push({
              file: '.qa-code/coverage-baseline.json',
              line: 1,
              detail: `repo coverage dropped from ${baselinePct}% to ${repoPct}%`,
            });
          }
        }
      }
      // The checker of the coverage layer is the pinned Node runtime itself (process.execPath).
      if (result) layers.coverage.receipt = pinnedNode();
  }, { patch_pct: 0, threshold, repo_pct: null, baseline_pct: null });
  if(testRunners && layers.coverage.status!=='skipped') layers.coverage.tool='native-test-runners';

  // T5/F05 — scan the instruction surface meant for agents for prompt injection. Only grade lines added since
  // base: dangerous content that existed only before base is pre-existing debt, not a finding of this diff.
  withLayer('prompt_injection', 'qa-code-injection', () => {
    const surface = worktreeAdditions(isAgentSurface);
    if (!surface) {
      layers.prompt_injection = ungraded('qa-code-injection',
        'cannot build the diff scope of the Markdown/config surface meant for agents');
      return;
    }
    // No added line on the agent surface => keep skipped, do not emit an empty pass.
    if (surface.size === 0) return;
    const findings = [];
    for (const [file, additions] of surface) {
      for (const item of additions) {
        // A BOM at the start of a file is valid encoding, not a character that hides instructions.
        const text = item.line === 1 ? item.text.replace(/^\uFEFF/, '') : item.text;
        const hidden = hiddenCodePoints(text);
        if (hidden.length) {
          findings.push({
            file,
            line: item.line,
            rule: 'prompt-injection/hidden-unicode',
            detail: `hidden/control characters on an added line: ${hidden.join(', ')}`,
          });
        }
        for (const rule of INJECTION_RULES) {
          if (rule.match(text)) {
            findings.push({ file, line: item.line, rule: rule.id, detail: rule.detail });
          }
        }
      }
    }
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line
      || a.rule.localeCompare(b.rule));
    layers.prompt_injection = {
      status: findings.length ? 'fail' : 'pass',
      tool: 'qa-code-injection',
      findings,
      // The checker is the pinned Node runtime itself: the scan runs in-process, zero dependency.
      receipt: pinnedNode(),
    };
  });

  // T5/F06 — change-driven threat-model gate. A diff that touches auth/payment/permission/migration/secret
  // must point to a threat model JSON that humans can check (entry points, trust boundaries, sensitive
  // assets, high-impact sinks). A missing or broken model is fail-closed: without a model there is no
  // basis to say the risk was considered. A diff that touches no group stays skipped.
  withLayer('threat_model', 'qa-code-threat-model', () => {
    const hits = riskTriggerHits();
    if (!hits) {
      layers.threat_model = ungraded('qa-code-threat-model',
        'cannot build the diff scope to detect risk groups', { triggers: [] });
      return;
    }
    if (hits.length === 0) return;
    const groups = [...new Set(hits.map((hit) => hit.group))].sort();
    const { notes, model } = readThreatModel();
    const findings = notes.length
      ? hits.slice(0, TRIGGER_FINDING_MAX).map((hit) => ({
        file: hit.file,
        ...(hit.line === undefined ? {} : { line: hit.line }),
        rule: `threat-model/uncovered-${hit.group}`,
        detail: `the change touches group ${hit.group} through ${hit.evidence === 'path' ? 'path' : 'added line'} "${hit.keyword}" but there is no valid threat model yet`,
      }))
      : [];
    if (notes.length && hits.length > TRIGGER_FINDING_MAX) {
      notes.push(`${hits.length - TRIGGER_FINDING_MAX} more triggers not listed in findings`);
    }
    layers.threat_model = {
      status: notes.length ? 'fail' : 'pass',
      tool: 'qa-code-threat-model',
      findings,
      triggers: groups,
      trigger_files: riskTriggerFiles(hits),
      notes,
      ...(model ? { model } : {}),
      // The checker is the pinned Node runtime itself: the gate runs in-process, zero dependency.
      receipt: pinnedNode(),
    };
  });

  // T5/F07 — security product-path acceptance. Uses exactly the F06 risk triggers (auth,
  // payment, permission, migration, secret): whatever group the diff touches must have at least one
  // acceptance test that runs on the PRODUCT PATH and proves that risk is blocked. It differs from F06 in that this layer
  // grades a RUN, not documentation: the test must run with the pinned Node runtime
  // (process.execPath, no PATH search) and leave the command + exit status as evidence.
  // No declared test, or a declared test that cannot run (timeout, cannot spawn), is UNGRADED
  // fail-closed — an acceptance that has not run is not evidence, and inferring it as pass is exactly
  // how the yardstick loosens itself. A diff without risk stays skipped so that it is not blocked unfairly.
  withLayer('security_product_path', 'qa-code-product-path', () => {
    const hits = riskTriggerHits();
    if (!hits) {
      layers.security_product_path = ungraded('qa-code-product-path',
        'cannot build the diff scope to detect risk groups', { triggers: [] });
      return;
    }
    if (hits.length === 0) return;
    const triggers = [...new Set(hits.map((hit) => hit.group))].sort();
    if (!securityProductPathTests) {
      layers.security_product_path = ungraded('qa-code-product-path',
        `the diff touches risk groups ${triggers.join(', ')} but the config does not declare security_product_path.tests, so there is no acceptance to run`,
        { triggers, trigger_files: riskTriggerFiles(hits) });
      return;
    }
    // Run only the declared list: a test that sits in the repo but is not configured was
    // chosen as evidence by nobody, so it may not run to claim credit.
    const testArgs = ['--test', ...securityProductPathTests];
    let command = [process.execPath, ...testArgs].join(' ');
    const result = testRunners ? runStackTests(securityProductPathTests) : run(process.execPath, testArgs, {
      // Gate 0 is often called by acceptance from node:test; the child runner must not inherit the parent
      // runner's worker marker, otherwise it looks for an IPC that does not exist.
      unsetEnv: ['NODE_TEST_CONTEXT'],
    });
    if(testRunners) { nativeRunnerEvidence.security_product_path=result.records??[]; command=JSON.stringify((result.records??[]).map(r=>({argv:r.argv}))); }
    const evidence = {
      ...(testRunners?{runner_records:result.records??[],first_error:result.error?.message??null,stderr:result.stderr,stdout:result.stdout}:{}),
      triggers,
      trigger_files: riskTriggerFiles(hits),
      tests: securityProductPathTests,
      command,
      exit_status: result.status ?? null,
    };
    if (result.timedOut) {
      layers.security_product_path = ungraded('qa-code-product-path',
        budgetNote('qa-code-product-path'), evidence);
      return;
    }
    if (result.error || result.status === null) {
      layers.security_product_path = ungraded('qa-code-product-path',
        'cannot run the declared security product-path acceptance with the pinned Node runtime', evidence);
      return;
    }
    layers.security_product_path = {
      status: result.status === 0 ? 'pass' : 'fail',
      tool: 'qa-code-product-path',
      findings: result.status === 0 ? [] : securityProductPathTests.map((file) => ({
        file,
        rule: 'security-product-path/failed',
        detail: `security product-path acceptance is red (exit ${result.status}) while the diff touches groups ${triggers.join(', ')}`,
      })),
      ...evidence,
      notes: [],
      // The checker is the pinned Node runtime itself, which ran the acceptance suite above.
      receipt: pinnedNode(),
    };
  });
} finally {
  if (tempDir) {
    scratchArchive=archiveOwnedPath(tempDir);
    for(const record of nativeRunnerEvidence.coverage?.records??[])for(const key of ['execution_report','coverage_report']){
      const saved=record[key];if(saved?.path?.startsWith(tempDir+sep))saved.path=join(scratchArchive,relative(tempDir,saved.path));
    }
  }
}

// QC9 — the requirement graph is executable proof, not a path inventory. The same frozen
// fail-to-pass test must fail on TASK_BASE and pass on HEAD; pass-to-pass must stay green on both.
const acceptanceRun = executeRequirementTests(acceptance?.requirements ?? null);

// F01 — fail-closed: a required checker with a missing receipt or a version that cannot be probed turns
// the layer UNGRADED (exit 20). Never record pass based on a checker whose version cannot be determined.
for (const tool of requiredReceipts) {
  const layerName = RECEIPT_TOOL_LAYERS[tool];
  const layer = layers[layerName];
  if (layer.receipt?.version) continue;
  layers[layerName] = {
    ...layer,
    status: 'ungraded',
    notes: [
      ...(layer.notes ?? []),
      layer.receipt
        ? `cannot probe the version of required checker ${tool}`
        : `missing receipt for required checker ${tool}`,
    ],
  };
}

// F03 — grade the outcome series. A missing run or a run that cannot be graded => ungraded; any red run
// (interleaved or all red) => fail. Never pass on one lucky green run.
if (stability) {
  const outcomeStatuses = stability.outcomes.map((item) => item.status);
  if (outcomeStatuses.length < stability.runs) {
    if (outcomeStatuses.length === 0 && layers.coverage.status === 'skipped') {
      stability.status = 'skipped';
      stability.notes.push('there is no Node test suite to repeat');
    } else {
      stability.status = 'ungraded';
      stability.notes.push(`only ${outcomeStatuses.length}/${stability.runs} runs were recorded`);
    }
  } else if (outcomeStatuses.includes('ungraded')) {
    stability.status = 'ungraded';
    stability.notes.push(`some runs cannot be graded: ${outcomeStatuses.join(', ')}`);
  } else if (outcomeStatuses.includes('fail')) {
    stability.status = 'fail';
    stability.notes.push(outcomeStatuses.includes('pass')
      ? `inconsistent results over ${stability.runs} runs: ${outcomeStatuses.join(', ')}`
      : `the test suite is red in all ${stability.runs} runs`);
  } else {
    stability.status = 'pass';
  }
}

// The baseline is only updated when the four layers are green. Failing to write the baseline is
// UNGRADED (H1); never emit PASS JSON and then crash at the final write step.
// V5/N7: the baseline lives in ~/.qa-code/<repo-hash>/, the target repo keeps its Git state.
// F03: when the test series is unstable, the measured repo_pct is not trustworthy either => no baseline is written.
let secretStatus=layers.secret.status;
try {secretStatus=verifiedSecretStatus({repo,base:baseCommit,commit,layers});}
catch(error){secretStatus='fail';layers.secret.adjudication={status:'fail',reason:error.message};delete layers.secret.effective_status;}
const layerStatuses=()=>Object.entries(layers).map(([name,layer])=>name==='secret'?secretStatus:layer.status);
const preBaselineStatuses = [
  ...layerStatuses(),
  ...(stability ? [stability.status] : []),
  ...(acceptanceRun ? [acceptanceRun.status] : []),
];
if (!preBaselineStatuses.includes('fail')
  && !preBaselineStatuses.includes('ungraded')
  && !preBaselineStatuses.every((item) => item === 'skipped')
  && layers.coverage.status === 'pass'
  && layers.coverage.repo_pct !== null) {
  try {
    if (!existsSync(baselineDir)) mkdirSync(baselineDir, { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify({
      schema: 'qa-code/coverage-baseline/v1',
      repo_pct: layers.coverage.repo_pct,
    }, null, 2)}\n`);
  } catch {
    layers.coverage = {
      ...layers.coverage,
      status: 'ungraded',
      notes: ['cannot update the coverage baseline'],
    };
  }
}

// F02 — duration receipt: every layer always has a finite, non-negative duration_ms, even a
// skipped layer (0ms) or a layer cut by a timeout. No layer may lack a measurement.
for (const name of LAYER_NAMES) {
  layers[name] = { ...layers[name], duration_ms: Math.max(0, Math.round(layerDurationMs[name])) };
}

// F03: stability is not a machine layer, but its verdict is fail-closed like a layer's.
const statuses = [
  ...layerStatuses(),
  ...(stability ? [stability.status] : []),
  ...(acceptanceRun ? [acceptanceRun.status] : []),
];
let status;
let exitCode;
if (statuses.includes('fail')) {
  status = 'fail';
  exitCode = 1;
} else if (statuses.includes('ungraded') || statuses.every((item) => item === 'skipped')) {
  status = 'ungraded';
  exitCode = 20;
} else {
  status = 'pass';
  exitCode = 0;
}

const failedLayers = [
  ...Object.entries(layers).filter(([name, layer]) => (name==='secret'?secretStatus:layer.status) === 'fail').map(([name]) => name),
  ...(stability?.status === 'fail' ? ['stability'] : []),
  ...(acceptanceRun?.status === 'fail' ? ['acceptance'] : []),
];
const ungradedLayers = [
  ...Object.entries(layers).filter(([, layer]) => layer.status === 'ungraded').map(([name]) => name),
  ...(stability?.status === 'ungraded' ? ['stability'] : []),
  ...(acceptanceRun?.status === 'ungraded' ? ['acceptance'] : []),
];
const summary = status === 'pass'
  ? `Gate 0 green: every layer that could run met its requirements.${layers.secret.effective_status==='pass'?' The Gitleaks scanner FAIL is kept; the exact reviewed adjudication is verified.':''}`
  : status === 'fail'
    ? `Gate 0 red in ${failedLayers.join(', ')}.${ungradedLayers.length
      ? ` Not graded yet (ungraded) in ${ungradedLayers.join(', ')}.`
      : ''}`
    : ungradedLayers.length
      ? `Gate 0 could not grade ${ungradedLayers.join(', ')}; handled fail-closed.`
      : 'Gate 0 could not grade because no layer had data to run.';

// V6: declare the pinned runtime. process.execPath is the node exec'd from QA_CODE_NODE, so
// path takes exactly the QA_CODE_NODE string the wrapper pinned — no realpath, matching the path at install time.
function pinnedNode() {
  return { path: process.env.QA_CODE_NODE || process.execPath, version: process.version };
}

// F01 — environment receipt: platform/arch/pinned Node + path/version of every real checker that
// ran, to tell code defects apart from toolchain drift between two runs on the same commit.
const runtime = {
  platform: process.platform,
  arch: process.arch,
  node: pinnedNode(),
  checkers: Object.entries(layers)
    .filter(([, layer]) => layer.receipt)
    .map(([layerName, layer]) => ({ layer: layerName, tool: layer.tool, ...layer.receipt })),
};

const totalDurationMs = Math.max(0, Math.round(elapsedMsSince(runStart)));
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const output = {
  schema: 'qa-code/gate0/v1',
  run_uuid: randomUUID(),
  status,
  repo,
  commit,
  // Freeze the effective cumulative task baseline. Keep the human-supplied ref separately so
  // later validation cannot silently reinterpret a moving ref such as HEAD~1.
  base: baseCommit,
  base_requested: options.base,
  ...(releaseTruth ? {
    contract_sha256: releaseTruth.contract.contract_sha256,
    requirements_hash: releaseTruth.requirementsHash,
    source_revision: releaseTruth.graph.source_revision,
    verification_lane: 'code',
    requirements: {
      path: releaseTruth.graphFile,
      sha256: releaseTruth.requirementsHash,
      code_ids: [...releaseTruth.codeIds],
    },
  } : {}),
  node: pinnedNode(),
  runtime,
  timeouts: {
    layers: Object.fromEntries(LAYER_NAMES
      .filter((name) => layerBudgetMs.has(name))
      .map((name) => [name, layerBudgetMs.get(name)])),
    total: totalBudgetMs === Infinity ? null : totalBudgetMs,
  },
  // Opt-in: when the config does not declare stability, the output keeps its old shape.
  ...(stability ? { stability } : {}),
  // QC9 — retain both the frozen graph and four execution outcomes per requirement.
  ...(acceptanceRun ? {
    acceptance: acceptanceRun,
    requirement_coverage: acceptanceRun.coverage,
  } : {}),
  ...(testRunners?{native_test_runners:{scratch_archive:scratchArchive,records:nativeRunnerEvidence}}:{}),
  layers,
  duration_ms: totalDurationMs,
  total_duration_ms: totalDurationMs,
  created_at: new Date().toISOString(),
  summary,
};

output.integrity = createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(output)))).digest('hex');

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.json) {
  const outPath = resolve(options.json);
  if (!existsSync(dirname(outPath))) dieUsage(`the parent folder of --json does not exist: ${dirname(outPath)}`);
  writeFileSync(outPath, serialized);
} else {
  process.stdout.write(serialized);
}

process.exit(exitCode);
