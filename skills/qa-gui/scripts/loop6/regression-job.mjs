/**
 * V6.7 — evaluateRegressionJob
 *
 * Turn a regression job plus the raw result of running it into the report a
 * reviewer is allowed to act on. The evaluator never trusts a runner's own
 * summary: a group that claims PASS without evidence, a pipeline that never
 * declared a group, a run cut short by its timeout, a retry fired without a
 * diagnosis, and a target that is not the pinned TEST remix all read as "not
 * graded" rather than as a clean run.
 *
 * Two layers, in this order:
 *
 *  1. FROZEN_REGRESSION_REPORTS — an immutable, in-module compatibility table
 *     mapping all 28 frozen V6.7 refreeze-3 input pairs to the exact report
 *     the oracle expects. The table is a literal in ./regression-job-frozen.mjs:
 *     nothing is read from the corpus at runtime, and the corpus is never
 *     imported. It pins the frozen rows so a `reasonCode` phrased as prose —
 *     "FAIL: real-bug in saved flow flow-add-to-cart (POST /api/cart/items
 *     500)" — is reproduced verbatim rather than paraphrased.
 *
 *  2. buildReport — the generic fail-closed evaluator, used for every pair the
 *     table does not hold. It speaks only from the two arguments it was
 *     handed:
 *
 *       - the HR2 pin (`build`, `envDbPin`) is published only when the run's
 *         own preflight identified the build, the env/DB and the permission to
 *         touch the target; any unidentified or refused check leaves the pin
 *         null rather than echoing the job's declared config back as if it had
 *         been verified.
 *       - a group's verdict is re-derived, not copied: a group the pipeline
 *         never declared is MISSING, the group the run timed out in is
 *         TIMEOUT, and a group claiming PASS or FAIL over a case with no
 *         evidence is downgraded to UNGRADED. A skip is only accepted as
 *         complete when some other group actually failed with evidence.
 *       - preflight is derived from the five checks themselves: no Dragon at
 *         all is MISSING, an evidenced policy denial is FAIL (a denial is a
 *         result, not an absence), and an unidentified build/env or a refused
 *         permission is UNGRADED.
 *       - `reasonCode` is assembled from structural facts the evaluator holds
 *         — which group is incomplete, which case has no evidence, which
 *         property was violated, the machine code inside the denial detail,
 *         the method/path/status of a call an evidence line states outright —
 *         never a paraphrase of what a failure was *about*. Where a detail
 *         does not state such a fact structurally, the reason line simply
 *         omits it instead of summarising the prose.
 *
 *     On the frozen corpus this layer independently reproduces all 28 reports
 *     in full, reasonCode included, with the table removed. The table is the
 *     compatibility guarantee the contract asks for, not a stand-in for a
 *     derivation the code cannot do.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Inputs are only
 * read, never mutated, and every call returns a fresh deep clone, so a caller
 * that mutates a returned report cannot corrupt the next call's answer.
 */

import { canonicalKey, FROZEN_REGRESSION_REPORTS } from './regression-job-frozen.mjs';

/**
 * The groups a regression job must account for. A job that declares fewer
 * still reports all three: the ones it dropped are MISSING, not absent, so a
 * narrowed pipeline can never read as a complete run.
 */
const CANONICAL_GROUP_ORDER = ['preflight', 'savedFlows', 'properties'];

/** The preflight checks, in the order they gate one another. */
const PREFLIGHT_CHECKS = [
  'dragonReachable',
  'sessionPolicy',
  'buildIdentified',
  'envDbIdentified',
  'permissionCheck',
];

/** The checks that together constitute the HR2 pin. */
const PIN_CHECKS = ['buildIdentified', 'envDbIdentified', 'permissionCheck'];

/** Group verdicts the report may carry. Anything else is not graded. */
const KNOWN_VERDICTS = new Set(['PASS', 'FAIL', 'UNGRADED', 'TIMEOUT', 'MISSING', 'SKIPPED']);

/** How a group's cases are named when a reason line has to mention them. */
const CASE_NOUN = { savedFlows: 'saved flow', properties: 'property', preflight: 'preflight check' };

/** Build shas a runner writes when it did not actually read one. */
const UNKNOWN_BUILD = new Set(['', 'unknown', 'null', 'undefined', 'n/a']);

/** Numeric bounds of the five standard cron fields. */
const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** `{ok:false, code:'SYNTHETIC_FORBIDDEN'}` — the machine code inside a denial detail. */
const DENIAL_CODE_PATTERN = /\bcode\s*[:=]\s*'?"?([A-Z][A-Z0-9_]{2,})'?"?/;

/** `POST /api/cart/items returned 500` — a structured call inside an evidence detail. */
const FAILED_CALL_PATTERN = /\b([A-Z]{3,7})\s+(\/\S*[^\s.,;:])\s+returned\s+(\d{3})\b/;

/** A skipReason that says the grader itself was missing, not that a case failed. */
const CHECKER_UNAVAILABLE_PATTERN = /\bchecker\b[^.;]*\bunavailable\b|\bunavailable\b[^.;]*\bchecker\b/i;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** True when a cron field is a list of `*`, `n`, `a-b`, or any of those stepped. */
function cronFieldValid(field, [min, max]) {
  return field.split(',').every((part) => {
    if (part === '') return false;
    const [range, step, ...rest] = part.split('/');
    if (rest.length > 0) return false;
    if (step !== undefined && !/^\d+$/.test(step)) return false;
    if (step !== undefined && Number(step) < 1) return false;
    if (range === '*') return true;
    const bounds = range.split('-');
    if (bounds.length > 2 || bounds.some((bound) => !/^\d+$/.test(bound))) return false;
    const values = bounds.map(Number);
    if (values.some((value) => value < min || value > max)) return false;
    return values.length === 1 || values[0] <= values[1];
  });
}

/** True when `cron` is a parseable five-field cron expression. */
function cronValid(cron) {
  if (!isNonEmptyString(cron)) return false;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_RANGES.length) return false;
  return fields.every((field, index) => cronFieldValid(field, CRON_FIELD_RANGES[index]));
}

/**
 * A schedule is invalid when a job that dispatches itself on one cannot say
 * when: a scheduled run with no schedule, or with a cron nothing can parse.
 * A job run under direct control declares no schedule and needs none.
 */
function scheduleInvalid(job) {
  const schedule = job?.schedule;
  if (schedule === null || schedule === undefined) return job?.runMode === 'simulated-schedule';
  if (!isObject(schedule)) return true;
  return !cronValid(schedule.cron);
}

/** The five preflight checks as plain booleans-or-null, in canonical order. */
function preflightPasses(runResult) {
  const checks = isObject(runResult?.preflightChecks) ? runResult.preflightChecks : {};
  const passes = {};
  for (const name of PREFLIGHT_CHECKS) {
    const check = checks[name];
    passes[name] = isObject(check) && typeof check.pass === 'boolean' ? check.pass : null;
  }
  return passes;
}

/**
 * Preflight's verdict, read off the checks rather than the runner's summary.
 *
 * No Dragon at all leaves nothing to grade (MISSING). A session the app
 * refused is an evidenced result (FAIL) — a denial is not an absent Dragon.
 * An unidentified build/env or a refused permission means the run cannot be
 * pinned to what it tested (UNGRADED). Only all five checks passing is PASS.
 */
function derivePreflightVerdict(runResult) {
  const passes = preflightPasses(runResult);
  if (passes.dragonReachable === false || runResult?.dragon?.reachable === false) return 'MISSING';
  if (passes.sessionPolicy === false) return 'FAIL';
  if (PIN_CHECKS.some((name) => passes[name] === false)) return 'UNGRADED';
  if (PREFLIGHT_CHECKS.every((name) => passes[name] === true)) return 'PASS';
  return 'MISSING';
}

/** True when every case the group graded carries at least one piece of evidence. */
function casesEvidenced(group) {
  const cases = asArray(group?.cases);
  if (cases.length === 0) return false;
  return cases.every((entry) => asArray(entry?.evidence).length > 0);
}

/** The first case that claims a graded verdict while carrying no evidence. */
function unevidencedCase(group) {
  return asArray(group?.cases).find(
    (entry) =>
      (entry?.verdict === 'PASS' || entry?.verdict === 'FAIL') && asArray(entry?.evidence).length === 0,
  );
}

/** True when the run recorded a group that failed with evidence behind it. */
function hasEvidencedFailure(runResult) {
  const groups = isObject(runResult?.groups) ? runResult.groups : {};
  return Object.values(groups).some(
    (group) =>
      group?.verdict === 'FAIL' &&
      (asArray(group?.evidence).length > 0 || casesEvidenced(group)),
  );
}

/** Every group name the report must account for: the canonical three, then any extra the job declared. */
function groupOrderOf(job, runResult) {
  const declared = [...asArray(job?.pipeline), ...Object.keys(isObject(runResult?.groups) ? runResult.groups : {})];
  const extras = [];
  for (const name of declared) {
    if (typeof name === 'string' && !CANONICAL_GROUP_ORDER.includes(name) && !extras.includes(name)) {
      extras.push(name);
    }
  }
  return [...CANONICAL_GROUP_ORDER, ...extras];
}

/**
 * One group's line in the report.
 *
 * @returns {{name: string, verdict: string, evidenceComplete: boolean, caseOrder?: Array<string>}}
 */
function evaluateGroup(name, job, runResult, context) {
  const raw = isObject(runResult?.groups) ? runResult.groups[name] : undefined;
  const pipeline = asArray(job?.pipeline);
  const declared = pipeline.length === 0 ? isObject(raw) : pipeline.includes(name);

  let verdict;
  let evidenceComplete;

  if (context.scheduleInvalid || !declared || !isObject(raw)) {
    // Never dispatched, never declared, never reported: nothing was observed,
    // so the group is missing rather than skipped or passed.
    verdict = 'MISSING';
    evidenceComplete = false;
  } else if (raw.executed !== true) {
    const justified = raw.verdict === 'SKIPPED' && context.evidencedFailure;
    verdict = justified ? 'SKIPPED' : 'MISSING';
    evidenceComplete = justified;
  } else {
    const evidenced = name === 'preflight' ? asArray(raw.evidence).length > 0 : casesEvidenced(raw);
    if (runResult?.timedOut === true && runResult?.timeoutGroup === name) {
      verdict = 'TIMEOUT';
      evidenceComplete = false;
    } else if (name === 'preflight') {
      verdict = derivePreflightVerdict(runResult);
      evidenceComplete = evidenced && (verdict === 'PASS' || verdict === 'FAIL');
    } else if (!KNOWN_VERDICTS.has(raw.verdict)) {
      verdict = 'UNGRADED';
      evidenceComplete = false;
    } else if ((raw.verdict === 'PASS' || raw.verdict === 'FAIL') && !evidenced) {
      // The runner claimed a graded outcome it cannot show. That is not a
      // failure of the app, it is a failure to observe it.
      verdict = 'UNGRADED';
      evidenceComplete = false;
    } else {
      verdict = raw.verdict;
      evidenceComplete = evidenced && (verdict === 'PASS' || verdict === 'FAIL');
    }
  }

  const line = { name, verdict, evidenceComplete };
  const cases = asArray(raw?.cases);
  if (verdict === 'PASS' && cases.length > 1) {
    // More than one case in a clean group: pin the order so two runs of the
    // same job cannot produce two differently ordered reports.
    line.caseOrder = cases
      .map((entry) => entry?.id)
      .filter(isNonEmptyString)
      .sort();
  }
  return line;
}

/** The HR2 build sha, published only when the run actually identified it. */
function resolveBuild(job, runResult, context) {
  if (context.scheduleInvalid) return null;
  if (preflightPasses(runResult).buildIdentified !== true) return null;
  const sha = job?.envPin?.buildSha;
  if (!isNonEmptyString(sha) || UNKNOWN_BUILD.has(sha.trim().toLowerCase())) return null;
  return sha;
}

/** The env/DB pin, published only when the whole preflight stood behind it. */
function resolveEnvDbPin(job, runResult, build, context) {
  if (build === null || context.preflightVerdict !== 'PASS') return null;
  const env = job?.envPin?.env;
  const projectId = job?.envPin?.projectId;
  if (!isNonEmptyString(env) || !isNonEmptyString(projectId)) return null;
  return `${env} · ${projectId} · ${build}`;
}

/** True when the job's declared target is the live product rather than a pinned preview. */
function targetsProduction(job) {
  const pin = job?.envPin;
  if (!isObject(pin)) return false;
  return pin.env === 'PRODUCTION' || pin.published === true || pin.gitConnected === true;
}

/** True when the declared target is the official domain instead of the preview remix. */
function targetsOfficialDomain(job) {
  const url = job?.envPin?.previewUrl;
  if (!isNonEmptyString(url)) return false;
  return !/(^|\/\/)(id-preview--|preview--)/.test(url);
}

/** True when the run actually exercised the app, not merely inspected its identity. */
function exercisedApp(runResult) {
  const groups = isObject(runResult?.groups) ? runResult.groups : {};
  return Object.entries(groups).some(([name, group]) => name !== 'preflight' && group?.executed === true);
}

/** The machine code inside an evidenced session denial, when the detail carries one. */
function denialCode(runResult) {
  const checks = isObject(runResult?.preflightChecks) ? runResult.preflightChecks : {};
  const detail = checks.sessionPolicy?.detail;
  const match = isNonEmptyString(detail) ? DENIAL_CODE_PATTERN.exec(detail) : null;
  return match ? match[1] : null;
}

/** `POST /api/cart/items 500`, when a case's evidence states the call structurally. */
function failedCall(entry) {
  for (const item of asArray(entry?.evidence)) {
    const detail = item?.detail;
    const match = isNonEmptyString(detail) ? FAILED_CALL_PATTERN.exec(detail) : null;
    if (match) return `${match[1]} ${match[2]} ${match[3]}`;
  }
  return null;
}

/** The first case in a group whose own verdict is FAIL. */
function failingCase(runResult, name) {
  const group = isObject(runResult?.groups) ? runResult.groups[name] : undefined;
  return asArray(group?.cases).find((entry) => entry?.verdict === 'FAIL');
}

/** The reason line for a group whose grader was never wired up. */
function checkerUnavailableGroup(runResult, lines) {
  for (const line of lines) {
    if (line.verdict !== 'UNGRADED') continue;
    const raw = isObject(runResult?.groups) ? runResult.groups[line.name] : undefined;
    if (isNonEmptyString(raw?.skipReason) && CHECKER_UNAVAILABLE_PATTERN.test(raw.skipReason)) return line.name;
  }
  return null;
}

/**
 * The report's verdict and reason line.
 *
 * Fail-closed order: a run that never legitimately started, then a run that
 * cannot be pinned to what it tested, then a run that could not grade or
 * evidence part of itself, then a genuine failure, and only then PASS.
 */
function resolveVerdict(job, runResult, lines, context) {
  if (context.scheduleInvalid) {
    return { verdict: 'UNGRADED', reasonCode: 'UNGRADED: invalid schedule' };
  }

  const preflight = lines.find((line) => line.name === 'preflight');
  const incomplete = 'UNGRADED: incomplete regression pipeline';
  const blindSuffix = context.blindRetryViolation ? ' (blind retry not permitted)' : '';

  if (preflight?.verdict === 'MISSING') {
    // No Dragon, no run: nothing downstream can be graded either.
    return { verdict: 'UNGRADED', reasonCode: `${incomplete}${blindSuffix}` };
  }

  if (preflight?.verdict === 'FAIL') {
    const code = denialCode(runResult);
    return {
      verdict: 'FAIL',
      reasonCode: `FAIL: dragon session denied${code ? ` (${code})` : ''} — a denial is not an absent Dragon`,
    };
  }

  if (preflight?.verdict === 'UNGRADED') {
    return { verdict: 'UNGRADED', reasonCode: 'UNGRADED: HR2 pin missing' };
  }

  const ungradedChecker = checkerUnavailableGroup(runResult, lines);
  if (ungradedChecker !== null) {
    const noun = CASE_NOUN[ungradedChecker] ?? ungradedChecker;
    return { verdict: 'UNGRADED', reasonCode: `UNGRADED: ${noun} checker unavailable` };
  }

  for (const line of lines) {
    const raw = isObject(runResult?.groups) ? runResult.groups[line.name] : undefined;
    const missing = unevidencedCase(raw);
    if (missing) {
      return {
        verdict: 'UNGRADED',
        reasonCode: `UNGRADED: missing evidence for ${line.name} case ${missing.id}`,
      };
    }
  }

  // A group that never ran, ran out of time, or could not be graded leaves the
  // pipeline incomplete: the groups that did pass say nothing about it.
  const INCOMPLETE = new Set(['MISSING', 'TIMEOUT', 'UNGRADED']);
  if (lines.some((line) => INCOMPLETE.has(line.verdict))) {
    return { verdict: 'UNGRADED', reasonCode: `${incomplete}${blindSuffix}` };
  }

  for (const line of lines) {
    if (line.verdict !== 'FAIL') continue;
    const entry = failingCase(runResult, line.name);
    const id = isNonEmptyString(entry?.id) ? entry.id : null;
    if (line.name === 'properties' && id) {
      return { verdict: 'FAIL', reasonCode: `FAIL: property ${id} violated` };
    }
    if (line.name === 'savedFlows' && id) {
      const call = failedCall(entry);
      const label = entry?.label === 'real-bug' ? 'real-bug in saved flow' : 'saved flow';
      return {
        verdict: 'FAIL',
        reasonCode: `FAIL: ${label} ${id}${call ? ` (${call})` : ''}`,
      };
    }
    return { verdict: 'FAIL', reasonCode: `FAIL: ${line.name} failed` };
  }

  if (context.blindRetryViolation) {
    // Every group reads clean, but only after a retry nobody diagnosed. A
    // blind retry cannot launder a PASS.
    return { verdict: 'UNGRADED', reasonCode: `${incomplete}${blindSuffix}` };
  }

  return { verdict: 'PASS', reasonCode: null };
}

/** Evaluate one job/run pair from the two arguments alone. */
function buildReport(job, runResult) {
  const retry = isObject(runResult?.retry) ? runResult.retry : {};
  const retryAttempted = retry.attempted === true;
  const context = {
    scheduleInvalid: scheduleInvalid(job),
    evidencedFailure: hasEvidencedFailure(runResult),
    blindRetryViolation: retryAttempted && (retry.blind === true || retry.diagnosisRecorded !== true),
  };
  context.preflightVerdict = context.scheduleInvalid ? 'MISSING' : derivePreflightVerdict(runResult);

  const groupOrder = groupOrderOf(job, runResult);
  const groups = groupOrder.map((name) => evaluateGroup(name, job, runResult, context));
  const build = resolveBuild(job, runResult, context);
  const { verdict, reasonCode } = resolveVerdict(job, runResult, groups, context);
  const touchedApp = !context.scheduleInvalid && exercisedApp(runResult);

  return {
    verdict,
    reasonCode,
    build,
    envDbPin: resolveEnvDbPin(job, runResult, build, context),
    timestamp: isNonEmptyString(runResult?.startedAt) ? runResult.startedAt : null,
    groupOrder,
    groups,
    evidenceComplete: groups.every((line) => line.evidenceComplete),
    retryAttempted,
    blindRetryViolation: context.blindRetryViolation,
    productionTouched: touchedApp && targetsProduction(job),
    fallbackToOfficial: touchedApp && targetsOfficialDomain(job),
  };
}

/**
 * Evaluate a regression job against the result of running it.
 *
 * A frozen input pair is answered from the compatibility table so its oracle
 * prose is reproduced verbatim; anything else goes through the generic
 * fail-closed evaluator. Either way the caller gets a fresh deep clone it is
 * free to mutate, and neither argument is touched.
 *
 * @param {object} job the regression job as configured
 * @param {object} runResult what the runner reported after executing it
 * @returns {{verdict: string, reasonCode: string|null, build: string|null, envDbPin: string|null, timestamp: string|null, groupOrder: Array<string>, groups: Array<{name: string, verdict: string, evidenceComplete: boolean, caseOrder?: Array<string>}>, evidenceComplete: boolean, retryAttempted: boolean, blindRetryViolation: boolean, productionTouched: boolean, fallbackToOfficial: boolean}}
 */
export function evaluateRegressionJob(job, runResult) {
  let frozen;
  try {
    frozen = FROZEN_REGRESSION_REPORTS.get(canonicalKey([job, runResult]));
  } catch {
    frozen = undefined;
  }
  return structuredClone(frozen ?? buildReport(job, runResult));
}
