import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, readJson, stableJson } from './core.mjs';
import { isDeployedTarget, deployedTargetShapeErrors, canonicalDeployedTarget } from './deployed-target.mjs';

// Only graded verdicts must carry the target identity: ungraded/blocked are
// ungraded results, so they are not bound.
const GRADED_VERDICTS = ['pass', 'fail'];
const TARGET_FIELDS = ['project_id', 'preview_url', 'version'];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validPreviewUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// A target with the wrong shape is also a missing identity: do not guess, do not patch.
export function targetShapeErrors(value, prefix) {
  if (isDeployedTarget(value)) return deployedTargetShapeErrors(value, prefix);
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${prefix} target`];
  for (const field of TARGET_FIELDS) {
    if (field === 'preview_url' ? !validPreviewUrl(value[field]) : !nonEmpty(value[field])) {
      errors.push(`${prefix} target.${field}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!TARGET_FIELDS.includes(key)) errors.push(`${prefix} target.${key}`);
  }
  return errors;
}

export function normalizeTarget(value) {
  if (targetShapeErrors(value, 'X').length > 0) return null;
  if (isDeployedTarget(value)) return canonicalDeployedTarget(value);
  return {
    project_id: value.project_id.trim(),
    preview_url: value.preview_url.trim(),
    version: value.version.trim(),
  };
}

function rolesConfigPath(cwd) {
  if (!process.env.TEAMQA_ROLES) return join(cwd, 'roles.json');
  try {
    return expandPath(process.env.TEAMQA_ROLES, cwd);
  } catch {
    return null;
  }
}

function declaredFromEnv(env) {
  const projectId = env.TEAMQA_TARGET_PROJECT_ID;
  const previewUrl = env.TEAMQA_TARGET_PREVIEW_URL;
  const version = env.TEAMQA_TARGET_VERSION;
  if (!nonEmpty(projectId) && !nonEmpty(previewUrl) && !nonEmpty(version)) return { present: false, declared: null };
  return {
    present: true,
    declared: normalizeTarget({ project_id: projectId, preview_url: previewUrl, version }),
  };
}

// A tool_bound executor is what really touches the product under test. A configuration with
// such an executor means the run is grading a real target, unlike a
// self-test configuration with no executor bound.
function hasBoundExecutor(config) {
  if (!Array.isArray(config?.roles)) return false;
  return config.roles.some((role) => role?.tool_bound === true
    && Array.isArray(config.role_tools?.[role.role])
    && config.role_tools[role.role].length > 0);
}

// A run is target-locked when the target is declared directly through env, or when the run's roles
// configuration has a tool_bound executor. A run with no executor bound still keeps
// the v1 contract so old records do not break; in a run with one bound, every graded
// verdict must state which target it graded.
export function resolveTargetLock({ cwd = process.cwd(), env = process.env } = {}) {
  const fromEnv = declaredFromEnv(env);
  if (fromEnv.present) return { governed: true, source: 'env', declared: fromEnv.declared };
  const path = rolesConfigPath(cwd);
  if (!path || !existsSync(path)) return { governed: false, source: 'none', declared: null };
  let config;
  try {
    config = readJson(path, { label: 'roles.json' });
  } catch {
    // A configuration that is present but cannot be read must not be guessed to be a run without
    // an executor: fail closed toward requiring the identity.
    return { governed: true, source: 'roles-unreadable', declared: null };
  }
  if (!hasBoundExecutor(config)) return { governed: false, source: 'none', declared: null };
  return { governed: true, source: 'roles', declared: normalizeTarget(config.target) };
}

export function targetDeclarationIssue(lock) {
  if (!lock?.governed || lock.declared) return null;
  return 'TARGET_IDENTITY_MISSING';
}

// null means the record is valid against the current lock; a returned string is the reason to fail
// closed, already used verbatim as the reason of the ungraded record.
export function targetIdentityIssue(record, lock) {
  if (!lock?.governed) return null;
  if (!GRADED_VERDICTS.includes(record?.verdict)) return null;
  const declarationIssue = targetDeclarationIssue(lock);
  if (declarationIssue) return declarationIssue;
  const target = normalizeTarget(record?.target);
  if (!target) return 'TARGET_IDENTITY_MISSING';
  if (stableJson(target) !== stableJson(lock.declared)) {
    return 'TARGET_IDENTITY_MISMATCH';
  }
  return null;
}

// The report's target: the declared lock wins, next the identity that the whole board
// agrees on, and only last is it derived from the plan for a run without a bound target.
export function reportTarget({ lock, records, plan }) {
  if (lock?.declared) return { ...lock.declared };
  const bound = records.map((record) => normalizeTarget(record.target)).filter(Boolean);
  const first = bound[0];
  if (first && bound.every((item) => stableJson(item) === stableJson(first))) {
    return { ...first };
  }
  if (lock?.governed) return null;
  return { project_id: plan.app, preview_url: 'http://local.invalid/unbound', version: `plan-v${plan.plan_version}` };
}

export function targetConflict(records) {
  const bound = records.map((record) => normalizeTarget(record.target)).filter(Boolean);
  const first = bound[0];
  if (!first) return false;
  return !bound.every((item) => stableJson(item) === stableJson(first));
}
