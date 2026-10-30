#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {verifyProviderExecutionEvidence} from './lib/provider-execution.mjs';
import {verifyTeamQaReviewProof} from './lib/teamqa-review-proof.mjs';
import {verifyGate0SecretAdjudication} from './lib/secret-adjudication.mjs';
import { engineVendor, verifyObjectIntegrity } from './lib/release-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'references', 'verdict.schema.json');
const VERDICTS = ['PASS', 'PASS-STATIC', 'FAIL', 'UNGRADED'];
const MODES = ['tools', 'static'];
const SEVERITIES = ['A', 'B', 'C', 'D'];
const DEFECT_TYPES = [
  'assignment',
  'checking',
  'algorithm',
  'timing',
  'interface',
  'function',
  'build',
  'documentation',
];
const SWEEP_KEYS = ['S1', 'S2', 'S3', 'S4', 'S5'];
const SWEEP_VALUES = ['PASS', 'DEFECT', 'NOT_APPLICABLE'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validEvidence(value) {
  if (!hasText(value)) return false;
  const lines = value.split(/\r?\n/);
  return lines.length <= 3 && lines.every((line) => line.length > 0);
}

function findingLabel(finding, index) {
  return hasText(finding?.id) ? finding.id : `findings[${index}]`;
}

/** V-D (L2): drop D findings without killing the verdict and without changing the input. */
export function ruleVD(verdict) {
  const kept = [];
  const dropped = [];
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (isObject(finding) && finding.severity === 'D') {
      dropped.push({
        id: hasText(finding.id) ? finding.id : `findings[${index}]`,
        severity: 'D',
        why: 'L2 — severity D is the linter\'s job',
      });
    } else {
      kept.push(finding);
    }
  }

  return {
    verdict: isObject(verdict) ? { ...verdict, findings: kept } : verdict,
    dropped,
  };
}

/** V-AB (L6): an A/B finding without an address or evidence kills the whole verdict. */
export function ruleVAB(verdict) {
  const rejected = [];
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (!isObject(finding) || !['A', 'B'].includes(finding.severity)) continue;

    const missing = [];
    if (!hasText(finding.file)) missing.push('file');
    if (!Number.isInteger(finding.line) || finding.line < 1) missing.push('line');
    if (!validEvidence(finding.evidence)) missing.push('evidence');

    if (missing.length > 0) {
      rejected.push({
        rule: 'V-AB',
        finding: findingLabel(finding, index),
        why: `${findingLabel(finding, index)} severity ${finding.severity} missing or invalid ${missing.join(', ')}`,
      });
    }
  }

  return rejected;
}

/** V-SWEEP: only exactly the five keys S1–S5 make a sweep that can be graded. */
export function ruleVSweep(verdict) {
  const sweep = isObject(verdict?.sweep) ? verdict.sweep : {};
  const missing = SWEEP_KEYS.filter((key) => !Object.hasOwn(sweep, key));
  if (missing.length === 0) return [];
  return [{
    rule: 'V-SWEEP',
    missing,
    why: `sweep is missing ${missing.join(', ')}`,
  }];
}

/** V-SWEEP-DEFECT: a sweep item declared DEFECT needs at least one A/B finding. */
export function ruleVSweepDefect(verdict) {
  const sweep = isObject(verdict?.sweep) ? verdict.sweep : {};
  const failed = SWEEP_KEYS.filter((key) => sweep[key] === 'DEFECT');
  if (failed.length === 0) return [];

  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const hasBlockingFinding = findings.some(
    (finding) => isObject(finding) && ['A', 'B'].includes(finding.severity),
  );
  if (hasBlockingFinding) return [];

  return [{
    rule: 'V-SWEEP-DEFECT',
    sweep: failed,
    why: `${failed.join(', ')} declared DEFECT but there is no severity A/B finding`,
  }];
}

/** V-STATIC (L3): static mode has no path to PASS. */
export function ruleVStatic(verdict) {
  if (verdict?.mode !== 'static' || verdict?.verdict !== 'PASS') return [];
  return [{
    rule: 'V-STATIC',
    why: 'static mode has a PASS-STATIC ceiling and may not declare PASS',
  }];
}

/** V-GATE0 (L4): only PASS-STATIC needs evidence of a green Gate 0 on the same commit. */
export function ruleVGate0(verdict, gate0, gate0ReadError = null) {
  try {verifyGate0SecretAdjudication(gate0);} catch(error) {return {verdictOut:'UNGRADED',downgraded:[{rule:'V-GATE0',why:error.message}]};}
  if (verdict?.verdict !== 'PASS-STATIC') {
    return { verdictOut: verdict?.verdict, downgraded: [] };
  }

  let why = null;
  if (gate0ReadError) {
    why = `cannot read gate0.json: ${gate0ReadError}`;
  } else if (!isObject(gate0)) {
    why = 'no gate0.json to prove Gate 0 is green';
  } else if (gate0.schema !== 'qa-code/gate0/v1') {
    why = `gate0.schema=${String(gate0.schema)} is not qa-code/gate0/v1`;
  } else if (gate0.status !== 'pass') {
    why = `gate0.status=${String(gate0.status)} is not green`;
  } else if (gate0.commit !== verdict.commit) {
    why = `gate0.commit=${String(gate0.commit)} differs from verdict.commit=${String(verdict.commit)}`;
  } else if (!verifyObjectIntegrity(gate0)) {
    why = 'gate0.integrity does not match the content';
  }

  if (!why) return { verdictOut: verdict.verdict, downgraded: [] };
  return {
    verdictOut: 'UNGRADED',
    downgraded: [{ rule: 'V-GATE0', why }],
  };
}

function gateRiskTriggers(gate0) {
  if (!isObject(gate0?.layers)) return [];
  const values = [];
  for (const name of ['threat_model', 'security_product_path']) {
    const triggers = gate0.layers[name]?.triggers;
    if (Array.isArray(triggers)) values.push(...triggers.filter(hasText));
  }
  return [...new Set(values)].sort();
}

/** High-risk runtime behavior cannot be closed by source-only review. */
export function ruleVHighRiskStatic(verdict, gate0) {
  const triggers = gateRiskTriggers(gate0);
  if (verdict?.verdict !== 'PASS-STATIC' || triggers.length === 0) return [];
  return [{
    rule: 'V-HIGH-RISK-STATIC',
    triggers,
    why: `the diff touches ${triggers.join(', ')} so it needs tool/runtime acceptance; PASS-STATIC has no authority to close the task`,
  }];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Runtime receipt proves deployed DB/ACL/RLS state and configurable legacy-code absence. */
function ruleVRuntimeContract(verdict, gate0, receipt, readError = null) {
  if (verdict?.verdict !== 'PASS') return [];
  const triggers = gateRiskTriggers(gate0);
  const relevant = triggers.filter((item) => ['auth', 'permission', 'migration'].includes(item));
  if (relevant.length === 0) return [];
  const reject = (why) => [{ rule: 'V-RUNTIME-CONTRACT', triggers: relevant, why }];
  if (readError) return reject(`cannot read runtime receipt: ${readError}`);
  if (!isObject(receipt) || receipt.schema !== 'qa-code/runtime-receipt/v1') return reject('missing qa-code/runtime-receipt/v1 for a high-risk PASS');
  if (receipt.commit !== gate0?.commit || receipt.task_base !== gate0?.base) return reject('runtime receipt does not bind gate0.commit and gate0.base');
  if (!hasText(receipt.environment) || !hasText(receipt.target) || !hasText(receipt.capturedAt) || Number.isNaN(Date.parse(receipt.capturedAt))) return reject('runtime receipt is missing a valid environment, target or capturedAt');
  const checks = receipt.checks;
  if (!isObject(checks)) return reject('runtime receipt is missing checks');
  const required = new Set();
  if (relevant.includes('auth') || relevant.includes('permission')) {
    required.add('legacy_identifier_audit'); required.add('permission_readback'); required.add('rls_readback');
  }
  if (relevant.includes('migration')) { required.add('migration_readback'); required.add('rls_readback'); }
  for (const name of required) {
    const check = checks[name];
    if (!isObject(check) || !hasText(check.source)) return reject(`${name} is missing its evidence object/source`);
    if (name === 'legacy_identifier_audit') {
      if (!Array.isArray(check.forbidden) || check.forbidden.length === 0 || check.forbidden.some((item) => !hasText(item))) return reject('legacy_identifier_audit.forbidden must be a non-empty configured list');
      if (!Array.isArray(check.matches) || check.matches.length > 0) return reject('legacy_identifier_audit still has old identifiers or is missing matches[]');
    } else if (!Object.hasOwn(check, 'expected') || !Object.hasOwn(check, 'actual') || canonicalJson(check.expected) !== canonicalJson(check.actual)) {
      return reject(`${name} expected/actual do not match`);
    }
  }
  return [];
}

function runGit(repo, args) {
  return spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function repoRelativePath(repo, candidate) {
  if (!hasText(candidate) || isAbsolute(candidate) || candidate.includes('\0')) return null;
  const rel = relative(repo, resolve(repo, candidate));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function resolvedCommit(repo, value) {
  const result = runGit(repo, ['rev-parse', '--verify', `${value}^{commit}`]);
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

/** The reviewer, Gate 0, and task intake must all use the same immutable cumulative base. */
function ruleVTaskBase(verdict, gate0, grounding) {
  if (!grounding?.repo || !grounding?.base || !grounding?.taskBase) {
    return [{ rule: 'V-TASK-BASE', why: 'every verdict needs --repo, --base and an immutable --task-base' }];
  }
  let repo;
  try { repo = realpathSync(grounding.repo); }
  catch (error) { return [{ rule: 'V-TASK-BASE', why: `cannot read the repo task baseline: ${error.message}` }]; }
  const reviewBase = resolvedCommit(repo, grounding.base);
  const taskBase = resolvedCommit(repo, grounding.taskBase);
  const gateBase = hasText(gate0?.base) ? resolvedCommit(repo, gate0.base) : null;
  const commit = resolvedCommit(repo, verdict?.commit);
  const head = resolvedCommit(repo, 'HEAD');
  if (!reviewBase || !taskBase || !gateBase || !commit) return [{ rule: 'V-TASK-BASE', why: 'review base, task base, gate0.base or verdict.commit does not resolve to a commit' }];
  if (reviewBase !== taskBase || gateBase !== taskBase) return [{
    rule: 'V-TASK-BASE',
    why: `baseline mismatch: review=${reviewBase} task=${taskBase} gate0=${gateBase}`,
  }];
  if (commit !== head) return [{
    rule: 'V-FINAL-HEAD',
    why: `verdict.commit=${commit} does not equal HEAD=${head}`,
  }];
  let repoReal;
  try { repoReal = realpathSync(repo); }
  catch { repoReal = repo; }
  if (gate0?.repo !== repoReal || gate0?.commit !== head || !verifyObjectIntegrity(gate0)) return [{
    rule: 'V-GATE0-BINDING',
    why: 'gate0 does not bind the repo, TASK_BASE, HEAD or integrity',
  }];
  const ancestry = runGit(repo, ['merge-base', '--is-ancestor', taskBase, commit]);
  if (ancestry.status !== 0 || ancestry.error) return [{ rule: 'V-TASK-BASE', why: 'the task baseline is not an ancestor of verdict.commit' }];
  return [];
}

const SWEEP_RISK = [
  { key: 'S1', pattern: /input|query|sql|migration|migrate|command|path/i },
  { key: 'S2', pattern: /auth|login|session|permission|role|rbac|policy|admin/i },
  { key: 'S3', pattern: /secret|credential|api[_-]?key|token|private[_-]?key|\.env/i },
  { key: 'S4', pattern: /error|exception|stack|trace/i },
  { key: 'S5', pattern: /password|token|payment|billing|money|card|wallet/i },
];

function changedFiles(repo, base, head) {
  const result = runGit(repo, ['diff', '--name-only', '--diff-filter=ACMRT', base, head, '--']);
  if (result.status !== 0 || result.error) return null;
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

const TRIGGER_SWEEPS = {
  auth: ['S2', 'S3', 'S5'],
  payment: ['S5'],
  permission: ['S2'],
  migration: ['S1'],
  secret: ['S3', 'S5'],
};

function ruleVSweepDiff(verdict, gate0, grounding) {
  if (!grounding?.repo || !grounding?.base) return [];
  let repo;
  try { repo = realpathSync(grounding.repo); }
  catch { return [{ rule: 'V-SWEEP-DIFF', why: 'cannot read the repo to check the sweep' }]; }
  const base = resolvedCommit(repo, grounding.base);
  const head = resolvedCommit(repo, verdict?.commit);
  if (!base || !head) return [{ rule: 'V-SWEEP-DIFF', why: 'cannot resolve base/head to check the sweep' }];
  const files = changedFiles(repo, base, head);
  if (!files) return [{ rule: 'V-SWEEP-DIFF', why: 'cannot read the diff to check the sweep' }];
  const explanations = isObject(verdict?.sweep_explanations) ? verdict.sweep_explanations : {};
  const gateTriggers = [...new Set([
    ...(Array.isArray(gate0?.layers?.threat_model?.triggers) ? gate0.layers.threat_model.triggers : []),
    ...(Array.isArray(gate0?.layers?.security_product_path?.triggers) ? gate0.layers.security_product_path.triggers : []),
  ])];
  const gateTriggerFiles = [
    ...(Array.isArray(gate0?.layers?.threat_model?.trigger_files) ? gate0.layers.threat_model.trigger_files : []),
    ...(Array.isArray(gate0?.layers?.security_product_path?.trigger_files) ? gate0.layers.security_product_path.trigger_files : []),
  ].filter((item) => isObject(item) && hasText(item.group) && hasText(item.file));
  const rejected = [];
  for (const { key, pattern } of SWEEP_RISK) {
    const triggerGroups = gateTriggers.filter((group) => TRIGGER_SWEEPS[group]?.includes(key));
    const evidenceFiles = [...new Set([
      ...files.filter((file) => pattern.test(file)),
      ...gateTriggerFiles
        .filter((item) => TRIGGER_SWEEPS[item.group]?.includes(key))
        .map((item) => item.file),
    ])];
    const riskApplies = evidenceFiles.length > 0 || triggerGroups.length > 0;
    if (!riskApplies || verdict?.sweep?.[key] !== 'NOT_APPLICABLE') continue;
    const explanation = explanations[key];
    if (!hasText(explanation) || evidenceFiles.length === 0
      || !evidenceFiles.some((file) => explanation.includes(file))) {
      rejected.push({
        rule: 'V-SWEEP-DIFF',
        sweep: key,
        files: evidenceFiles,
        triggers: triggerGroups,
        why: `${key} declared NOT_APPLICABLE but the risky diff in ${evidenceFiles.join(', ')} has no sweep_explanations.${key} pointing to a file`,
      });
    }
  }
  return rejected;
}

function ruleVProvider(verdict) {
  if(!['PASS','PASS-STATIC'].includes(verdict?.verdict))return [];
  const vendor=engineVendor(verdict.engine);
  if(!['openai','anthropic'].includes(vendor))return [];
  const execution=verdict.harness?.provider_execution;
  if(!execution)return [{rule:'V-PROVIDER',why:'provider runtime provenance required'}];
  const {errors}=verifyProviderExecutionEvidence(execution,{mode:verdict.mode});
  if(execution.provider!==vendor || execution.sent?.model!==verdict.engine)errors.push('PROVIDER_VERDICT_MODEL_MISMATCH');
  return errors.map(why=>({rule:'V-PROVIDER',why}));
}

function coderVendorFromSpec(repo) {
  const jsonPath = resolve(repo, '.teamcode', 'spec.json');
  if (existsSync(jsonPath)) {
    try {
      const spec = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const value = spec?.roles?.coder?.vendor ?? spec?.coder_vendor;
      if (hasText(value)) return String(value).trim().toLowerCase();
      return 'unknown';
    } catch { return 'unknown'; }
  }
  const markdownPath = resolve(repo, '.teamcode', 'spec.md');
  if (!existsSync(markdownPath)) return 'unknown';
  try {
    const text = readFileSync(markdownPath, 'utf8');
    const match = /(?:^|\n)\s*(?:coder_vendor|coder[ |_-]+vendor)\s*[:|=]\s*`?([a-z0-9._-]+)/i.exec(text);
    return match ? match[1].toLowerCase() : 'unknown';
  } catch { return 'unknown'; }
}

function ruleVIndependentVendor(verdict, grounding) {
  if (!grounding?.repo || !['PASS', 'PASS-STATIC'].includes(verdict?.verdict)) return [];
  let repo;
  try { repo = realpathSync(grounding.repo); }
  catch { return [{ rule: 'V-HR3', why: 'cannot read the repo to check vendor independence' }]; }
  const coderVendor = coderVendorFromSpec(repo);
  const qaVendor = engineVendor(verdict.engine);
  if ((coderVendor === 'unknown' && !grounding.teamqaProof) || qaVendor === 'unknown') return [{
    rule: 'V-HR3',
    why: `cannot determine the vendor of coder=${coderVendor} or QA=${qaVendor}`,
  }];
  if (grounding.teamqaProof && (coderVendor===qaVendor || coderVendor==='unknown')) {
    try {
      const execution=verdict.harness?.provider_execution;
      if(!execution?.attestation_path)throw new Error('TEAMQA_POST_ATTESTATION_REQUIRED');
      const attestation=JSON.parse(readFileSync(execution.attestation_path,'utf8'));
      verifyTeamQaReviewProof({proofPath:grounding.teamqaProof,runtimePath:grounding.teamqaRuntime,repo,base:resolvedCommit(repo,grounding.base),head:resolvedCommit(repo,verdict.commit),provider:qaVendor,model:verdict.engine,reasoning:execution.sent.reasoning,stage:'post',attestation});
      return [];
    } catch(error) {return [{rule:'V-HR3',why:error.message}];}
  }
  if (coderVendor === qaVendor) return [{
    rule: 'V-HR3',
    why: `QA and coder share vendor ${qaVendor}; HR3 requires an independent reviewer`,
  }];
  return [];
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function addedLineRanges(repo, base, commit, file) {
  const result = runGit(repo, [
    'diff', '--unified=0', '--no-ext-diff', '--no-renames', base, commit, '--', file,
  ]);
  if (result.status !== 0 || result.error) return null;
  const ranges = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function anchorRejection(finding, index, why) {
  return { rule: 'V-ANCHOR', finding: findingLabel(finding, index), why };
}

function ruleVAnchor(verdict, grounding) {
  if (!grounding) return [];
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const blocking = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => isObject(finding) && ['A', 'B'].includes(finding.severity));
  if (blocking.length === 0) return [];

  let repo;
  try {
    repo = realpathSync(grounding.repo);
  } catch (error) {
    return blocking.map(({ finding, index }) => anchorRejection(
      finding,
      index,
      `cannot read the grounding repo: ${error.message}`,
    ));
  }

  const insideWorkTree = runGit(repo, ['rev-parse', '--is-inside-work-tree']);
  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== 'true') {
    return blocking.map(({ finding, index }) => anchorRejection(
      finding,
      index,
      'the grounding repo is not a Git worktree',
    ));
  }

  const base = resolvedCommit(repo, grounding.base);
  const commit = resolvedCommit(repo, verdict.commit);
  if (!base || !commit) {
    return blocking.map(({ finding, index }) => anchorRejection(
      finding,
      index,
      `base or verdict.commit does not exist in the repo`,
    ));
  }
  const ancestry = runGit(repo, ['merge-base', '--is-ancestor', base, commit]);
  if (ancestry.status !== 0 || ancestry.error) {
    return blocking.map(({ finding, index }) => anchorRejection(
      finding,
      index,
      'base is not an ancestor of verdict.commit',
    ));
  }

  const fileCache = new Map();
  const rangesCache = new Map();
  const rejected = [];
  for (const { finding, index } of blocking) {
    const file = repoRelativePath(repo, finding.file);
    if (!file) {
      rejected.push(anchorRejection(finding, index, 'the file anchor must be a relative path inside the repo'));
      continue;
    }

    if (!fileCache.has(file)) {
      const shown = runGit(repo, ['show', '--no-textconv', `${commit}:${file}`]);
      fileCache.set(file, shown.status === 0 && !shown.error ? shown.stdout : null);
    }
    const content = fileCache.get(file);
    if (content === null) {
      rejected.push(anchorRejection(finding, index, `${file} does not exist at verdict.commit`));
      continue;
    }
    if (finding.line > lineCount(content)) {
      rejected.push(anchorRejection(finding, index, `${file}:${finding.line} is beyond the line count at verdict.commit`));
      continue;
    }
    if (finding.pre_existing === true) continue;

    if (!rangesCache.has(file)) rangesCache.set(file, addedLineRanges(repo, base, commit, file));
    const ranges = rangesCache.get(file);
    if (ranges === null) {
      rejected.push(anchorRejection(finding, index, `cannot build the grounding diff for ${file}`));
      continue;
    }
    if (!ranges.some(({ start, end }) => finding.line >= start && finding.line <= end)) {
      rejected.push(anchorRejection(
        finding,
        index,
        `${file}:${finding.line} is not a line added since base; declare pre_existing=true if this is intended`,
      ));
    }
  }
  return rejected;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Minimal JSON Schema checker, zero dependency, covering the schema keywords verdict v1 uses. */
export function validateSchema(schema, data, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) validateSchema(candidate, data, path, errors);
  }

  if (schema.if) {
    const conditionErrors = [];
    validateSchema(schema.if, data, path, conditionErrors);
    if (conditionErrors.length === 0 && schema.then) {
      validateSchema(schema.then, data, path, errors);
    } else if (conditionErrors.length > 0 && schema.else) {
      validateSchema(schema.else, data, path, errors);
    }
  }

  if (Object.hasOwn(schema, 'const') && data !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errors.push(`${path}: value ${JSON.stringify(data)} is invalid`);
  }

  if (schema.type) {
    const actual = typeOf(data);
    const typeMatches = schema.type === 'number'
      ? actual === 'number' || actual === 'integer'
      : actual === schema.type;
    if (!typeMatches) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return errors;
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }
  if (typeof data === 'number' && schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${path}: less than minimum ${schema.minimum}`);
  }

  if (isObject(data)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(data, key)) errors.push(`${path}: missing required field ${key}`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(data, key)) {
        validateSchema(childSchema, data[key], `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, errors));
  }

  return errors;
}

/*
 * Check the shape before running the rules. Three exceptions are deferred on purpose:
 * - severity D, for V-D to drop;
 * - file/line/evidence of A/B, for V-AB to return exit 1;
 * - a sweep missing S1–S5, for V-SWEEP to return exit 1.
 */
function validateBaseFormat(verdict) {
  const errors = [];
  if (!isObject(verdict)) return ['$: verdict must be an object'];

  if (verdict.schema !== 'qa-code/verdict/v1') errors.push('$.schema: wrong or missing schema');
  if (!VERDICTS.includes(verdict.verdict)) errors.push('$.verdict: wrong or missing verdict grade');
  if (!MODES.includes(verdict.mode)) errors.push('$.mode: wrong or missing mode');
  if (!hasText(verdict.engine)) errors.push('$.engine: must be a non-empty string');
  if (typeof verdict.commit !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(verdict.commit)) {
    errors.push('$.commit: must be a SHA of 7–40 hex characters');
  }
  if (!Array.isArray(verdict.findings)) errors.push('$.findings: required array');

  if (Array.isArray(verdict.findings)) {
    verdict.findings.forEach((finding, index) => {
      const path = `$.findings[${index}]`;
      if (!isObject(finding)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (!hasText(finding.id)) errors.push(`${path}.id: must be a non-empty string`);
      if (!SEVERITIES.includes(finding.severity)) errors.push(`${path}.severity: not one of A/B/C/D`);
      if (!DEFECT_TYPES.includes(finding.defect_type)) errors.push(`${path}.defect_type: not one of the 8 ODC types`);
      if (Object.hasOwn(finding, 'pre_existing') && typeof finding.pre_existing !== 'boolean') {
        errors.push(`${path}.pre_existing: must be a boolean`);
      }

      if (finding.severity === 'C') {
        if (Object.hasOwn(finding, 'file') && !hasText(finding.file)) errors.push(`${path}.file: must be a non-empty string`);
        if (Object.hasOwn(finding, 'line') && (!Number.isInteger(finding.line) || finding.line < 1)) errors.push(`${path}.line: must be an integer >= 1`);
        if (Object.hasOwn(finding, 'evidence') && !validEvidence(finding.evidence)) errors.push(`${path}.evidence: must have 1–3 lines`);
      }
    });
  }

  for (const field of ['concerns', 'proposed_tests']) {
    if (!Object.hasOwn(verdict, field)) continue;
    if (!Array.isArray(verdict[field])) {
      errors.push(`$.${field}: must be an array`);
      continue;
    }
    verdict[field].forEach((value, index) => {
      if (typeof value !== 'string') errors.push(`$.${field}[${index}]: must be a string`);
    });
  }

  if (Object.hasOwn(verdict, 'sweep') && !isObject(verdict.sweep)) {
    errors.push('$.sweep: must be an object');
  } else if (isObject(verdict.sweep)) {
    for (const key of SWEEP_KEYS) {
      if (Object.hasOwn(verdict.sweep, key) && !SWEEP_VALUES.includes(verdict.sweep[key])) {
        errors.push(`$.sweep.${key}: invalid value`);
      }
    }
  }
  if (Object.hasOwn(verdict, 'sweep_explanations')) {
    if (!isObject(verdict.sweep_explanations)) {
      errors.push('$.sweep_explanations: must be an object');
    } else {
      for (const [key, value] of Object.entries(verdict.sweep_explanations)) {
        if (!SWEEP_KEYS.includes(key) || !hasText(value)) errors.push(`$.sweep_explanations.${key}: invalid key/value`);
      }
    }
  }

  return errors;
}

function validationResult({ ok, verdictIn = null, verdictOut = null, downgraded = [], rejected = [], dropped = [] }) {
  return {
    schema: 'qa-code/validation/v1',
    ok,
    verdict_in: verdictIn,
    verdict_out: verdictOut,
    downgraded,
    rejected,
    dropped,
  };
}

function formatFailure(why, verdict = null, dropped = []) {
  const verdictIn = VERDICTS.includes(verdict?.verdict) ? verdict.verdict : null;
  return validationResult({
    ok: false,
    verdictIn,
    verdictOut: verdictIn,
    rejected: [{ rule: 'V-FORMAT', why }],
    dropped,
  });
}

function readJson(path, label) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: `${label}: ${error.message}` };
  }
}

function parseArgs(argv) {
  const options = { verdict: null, gate0: null, runtimeReceipt: null, json: null, repo: null, base: null, taskBase: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--verdict', '--gate0', '--runtime-receipt', '--json', '--repo', '--base', '--task-base','--teamqa-proof','--teamqa-runtime'].includes(flag)) {
      throw new Error(`invalid flag: ${flag}`);
    }
    const key = flag === '--teamqa-proof' ? 'teamqaProof' : flag === '--teamqa-runtime' ? 'teamqaRuntime' : flag === '--task-base' ? 'taskBase' : flag === '--runtime-receipt' ? 'runtimeReceipt' : flag.slice(2);
    if (seen.has(key)) throw new Error(`repeated flag: ${flag}`);
    if (index + 1 >= argv.length) throw new Error(`missing value for ${flag}`);
    seen.add(key);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options.verdict) throw new Error('missing --verdict <file>');
  if (Boolean(options.repo) !== Boolean(options.base)) {
    throw new Error('--repo and --base must be given together');
  }
  if (options.taskBase && !options.repo) throw new Error('--task-base needs --repo and --base');
  return options;
}

function emit(result, outputPath) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, text, 'utf8');
  else process.stdout.write(text);
}

function validateVerdictInternal(verdict, gate0 = null, gate0ReadError = null, grounding = null, runtimeReceipt = null, runtimeReadError = null) {
  const baseErrors = validateBaseFormat(verdict);
  if (baseErrors.length > 0) {
    return { exitCode: 20, result: formatFailure(baseErrors.join('; '), verdict) };
  }

  const { verdict: withoutD, dropped } = ruleVD(verdict);
  const independentVendor = ruleVIndependentVendor(withoutD, grounding);
  const rejected = [
    ...ruleVProvider(withoutD),
    ...ruleVAB(withoutD),
    ...ruleVSweep(withoutD),
    ...ruleVSweepDefect(withoutD),
    ...ruleVStatic(withoutD),
    ...ruleVHighRiskStatic(withoutD, gate0),
    ...ruleVTaskBase(withoutD, gate0, grounding),
    ...ruleVSweepDiff(withoutD, gate0, grounding),
    ...ruleVRuntimeContract(withoutD, gate0, runtimeReceipt, runtimeReadError),
    ...ruleVAnchor(withoutD, grounding),
  ];
  if (rejected.length > 0) {
    return {
      exitCode: 1,
      result: validationResult({
        ok: false,
        verdictIn: withoutD.verdict,
        verdictOut: withoutD.verdict,
        rejected,
        dropped,
      }),
    };
  }

  let schema;
  try {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (error) {
    return { exitCode: 20, result: formatFailure(`cannot read schema: ${error.message}`, withoutD, dropped) };
  }
  const schemaErrors = validateSchema(schema, withoutD);
  if (schemaErrors.length > 0) {
    return { exitCode: 20, result: formatFailure(schemaErrors.join('; '), withoutD, dropped) };
  }

  if (independentVendor.length > 0) {
    return {
      exitCode: 20,
      result: validationResult({
        ok: true,
        verdictIn: withoutD.verdict,
        verdictOut: 'UNGRADED',
        downgraded: independentVendor,
        dropped,
      }),
    };
  }

  const gateResult = ruleVGate0(withoutD, gate0, gate0ReadError);
  return {
    exitCode: gateResult.verdictOut === 'UNGRADED'
      ? 20
      : gateResult.verdictOut === 'FAIL'
        ? 1
        : 0,
    result: validationResult({
      ok: true,
      verdictIn: withoutD.verdict,
      verdictOut: gateResult.verdictOut,
      downgraded: gateResult.downgraded,
      dropped,
    }),
  };
}

export function validateVerdict(verdict, gate0 = null, gate0ReadError = null) {
  return validateVerdictInternal(verdict, gate0, gate0ReadError, null);
}

export function isDirectExecution(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(argv1);
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Usage: node scripts/verdict-validate.mjs --verdict <file> [--gate0 <file>] [--runtime-receipt <file>] [--repo <git>] [--base <sha>] [--task-base <sha>] [--json <out>]\n${error.message}\n`);
    return 2;
  }

  const verdictRead = readJson(options.verdict, 'verdict');
  if (verdictRead.error) {
    try {
      emit(formatFailure(verdictRead.error), options.json);
    } catch (error) {
      process.stderr.write(`cannot write the result: ${error.message}\n`);
    }
    return 20;
  }

  const gate0Read = options.gate0
    ? readJson(options.gate0, 'gate0')
    : { value: null, error: null };
  const runtimeRead = options.runtimeReceipt
    ? readJson(options.runtimeReceipt, 'runtime receipt')
    : { value: null, error: null };
  const grounding = options.repo ? { repo: options.repo, base: options.base, taskBase: options.taskBase,teamqaProof:options.teamqaProof,teamqaRuntime:options.teamqaRuntime } : null;
  const { exitCode, result } = validateVerdictInternal(
    verdictRead.value,
    gate0Read.value,
    gate0Read.error,
    grounding,
    runtimeRead.value,
    runtimeRead.error,
  );
  try {
    emit(result, options.json);
  } catch (error) {
    process.stderr.write(`cannot write the result: ${error.message}\n`);
    return 2;
  }
  return exitCode;
}

if (isDirectExecution()) {
  process.exitCode = main();
}
