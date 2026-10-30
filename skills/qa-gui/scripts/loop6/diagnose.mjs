/**
 * V6.4 — diagnoseFailure
 *
 * Pure, deterministic, no I/O. Turns one step's evidence bundle into
 * {label, action, reason, evidence}.
 *
 * Design rules (all read off the bundle itself, never off a case id):
 *  - a step that reported no failure is not a finding: label 'none', no action;
 *  - a bundle that was never captured, was truncated, or that names two causes
 *    and then says it cannot rank them, stays UNGRADED and blocked — guessing a
 *    cause from unusable evidence is worse than admitting it cannot decide;
 *  - retry is a privilege, not a default: only a locator that lost its target
 *    (selector), an under-waited settle window (timing) and a bounded async
 *    catch-up (data) earn it. Every other label blocks or fails, so a real bug
 *    is never retried away and an infrastructure fault is never retried into;
 *  - anything that matches no cause family falls through to UNGRADED/blocked.
 */

/** labels whose action may ever be `retry`; everything else blocks or fails. */
const RETRYABLE_LABELS = new Set(['selector', 'timing', 'data']);

/** the fields an evidence bundle is made of; a value carrying none is not one. */
const BUNDLE_FIELDS = [
  'stepDescription',
  'errorMessage',
  'domSnapshotNote',
  'consoleLogs',
  'networkCalls',
  'retryHistory',
  'timingMs',
  'captureNote',
];

/** the bundle is unusable: nothing was captured, or capture stopped mid-way. */
const EVIDENCE_UNUSABLE =
  /no dom snapshot was captured|no evidence bundle|failed to attach|truncated mid-capture|bundle was truncated|\[log truncated\]|log cuts off/i;

/** the bundle names more than one cause and states it cannot rank them. */
const CAUSE_UNDECIDABLE =
  /does not indicate which|does not disambiguate|does not distinguish|no way to tell|cannot tell which|equal-weight signals|which factor dominates/i;

/** hedging language: the bundle is describing a candidate cause, not a fact. */
const HEDGED = /\bcould (?:still )?\w+|\bplausibly\b|\bpossible\b|\bmight\b|\bmay be\b/i;

/** browser, page or agent-level fault: the run surface itself stopped working. */
const RUNTIME_FAULT =
  /aw, snap|renderer process crashed|tab (?:is )?unresponsive|unresponsive for|extension context (?:was )?invalidated|econnrefused|connection refused|circuit_open|synthetic_forbidden|dispatchmouseevent timed out|actions? (?:on this tab )?time[d]? out|page is blank white|no interactive elements found|re-render loop|maximum update depth exceeded|exceeded the quota|stale service worker|uncaught (?:typeerror|domexception|referenceerror|error)|freezing the main thread/i;

/** the harness recorded an outcome, not an error: the action succeeded. */
const UNEXPECTED_SUCCESS = /^\s*none\b/i;

/** the app misbehaves the same way on every run — waiting cannot fix logic. */
const REPRODUCIBLE_DEFECT =
  /reproducible|deterministic|every run|on every retry|silently drops|hard-caps|not a rendering glitch/i;

/** the locator lost its target; the target itself is still on screen. */
const LOCATE_FAILURE = /locate failed|no element matches|strict-mode|matches \d+ elements/i;
const TARGET_STILL_THERE =
  /still (?:visible|present|exists|rendered)|identifiable by|now at position|regenerated|renamed|attribute is now|now has aria-label|moved inside|inside an <iframe|shadow root|visually present|correct target is|same \[data-testid/i;

/** the app had not finished settling when the step read it. */
const SETTLE_PENDING =
  /debounc|animation|transition|lazy|code-split|chunk|microtask|requestanimationframe|backoff|not settled|reflow|finishes loading|arrives ~?\d+|pending-at-read-time|mounts on the next/i;

/** the environment's data, not the app's behaviour, is what differs. */
const DATA_MISMATCH =
  /seed|fixture|materialized view|shared test db|test db|feature flag|flag config|this env|env's config|page size|not migrated|schema was renamed|foreign key|precision|search index|concurrent test run/i;

/** an async data path that is known to converge inside a bounded wait. */
const DATA_CATCHES_UP = /catches up|eventually consistent|bounded wait/i;
/** ...unless the same note says it will not converge inside the test window. */
const NO_CONVERGENCE = /won'?t|will not|never/i;

const text = (value) => (typeof value === 'string' ? value : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const jsonClone = (value) => {
  try {
    const encoded = JSON.stringify(value ?? null);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch {
    return null;
  }
};

const consoleLine = (entry) =>
  typeof entry === 'string' ? entry : `${text(entry?.level)}: ${text(entry?.text)}`;

const isConsoleError = (entry) =>
  typeof entry === 'object' && entry !== null && text(entry.level).toLowerCase() === 'error';

/** Everything the bundle says in prose, in one haystack for phrase matching. */
function narrativeOf(parts) {
  return parts.filter((part) => part.length > 0).join('\n');
}

/**
 * Read the raw bundle into the handful of derived facts the rules need. Nothing
 * here interprets; it only normalises shapes so a malformed bundle cannot throw.
 */
function readEvidence(evidence) {
  const shaped = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence);
  /** a value carrying none of the bundle's own fields is not a bundle at all. */
  const bundle = shaped && BUNDLE_FIELDS.some((field) => field in evidence) ? evidence : null;
  const step = text(bundle?.stepDescription);
  const error = text(bundle?.errorMessage);
  const note = text(bundle?.domSnapshotNote);
  const capture = text(bundle?.captureNote);
  const logs = asArray(bundle?.consoleLogs);
  const calls = asArray(bundle?.networkCalls);
  const timing = bundle?.timingMs && typeof bundle.timingMs === 'object' ? bundle.timingMs : null;
  const retries = bundle?.retryHistory && typeof bundle.retryHistory === 'object' ? bundle.retryHistory : null;
  const consoleText = logs.map(consoleLine).join('\n');

  return {
    present: bundle !== null,
    step,
    error,
    note,
    capture,
    logs,
    calls,
    timing,
    retries,
    consoleErrors: logs.filter(isConsoleError).length,
    consoleText,
    narrative: narrativeOf([error, note, capture, consoleText]),
    /** the harness only omits an error message when the step itself completed. */
    reportedFailure: error.length > 0 || logs.some(isConsoleError) || capture.length > 0,
    underWaited:
      timing !== null &&
      isNumber(timing.waited) &&
      isNumber(timing.requiredSettle) &&
      timing.waited < timing.requiredSettle,
    /** a step already re-run unchanged has spent its retry; do not spend it twice. */
    retriedBlind:
      retries !== null && isNumber(retries.attempts) && retries.attempts >= 2 && retries.sameSelectorEachTime === true,
  };
}

/** Which cause families the bundle shows decisive evidence for, in priority order. */
function familiesOf(read) {
  const families = [];

  if (read.consoleErrors > 0 || RUNTIME_FAULT.test(read.narrative)) {
    families.push({
      label: 'runtime',
      action: 'blocked',
      signal:
        read.consoleErrors > 0
          ? 'page or agent raised an uncaught error at failure time'
          : 'browser, page or agent surface stopped responding',
    });
  }

  if (UNEXPECTED_SUCCESS.test(read.error) || REPRODUCIBLE_DEFECT.test(read.narrative)) {
    families.push({
      label: 'real-bug',
      action: 'fail',
      signal: UNEXPECTED_SUCCESS.test(read.error)
        ? 'the action succeeded where the app should have rejected or guarded it'
        : 'the wrong behaviour is stable and reproduces on every run',
    });
  }

  if (DATA_MISMATCH.test(read.note)) {
    const convergesSoon = DATA_CATCHES_UP.test(read.note) && !NO_CONVERGENCE.test(read.note);
    families.push({
      label: 'data',
      action: convergesSoon ? 'retry' : 'blocked',
      signal: convergesSoon
        ? "this environment's data converges asynchronously within a bounded wait"
        : "this environment's seed, fixture or config differs from what the step expects",
    });
  }

  if (LOCATE_FAILURE.test(read.error) || TARGET_STILL_THERE.test(read.note)) {
    families.push({
      label: 'selector',
      action: 'retry',
      signal: 'the target is still on screen but the recorded locator no longer resolves to it',
    });
  }

  if (read.underWaited || SETTLE_PENDING.test(read.note)) {
    families.push({
      label: 'timing',
      action: 'retry',
      signal: read.underWaited
        ? `the step read at ${read.timing.waited}ms, before the app's ${read.timing.requiredSettle}ms settle window`
        : 'the app had not finished settling when the step read it',
    });
  }

  return families;
}

/** The digest a triage reader needs to check the verdict without the raw bundle. */
function digestOf(read, signals) {
  return {
    step: read.step || null,
    error: read.error || null,
    snapshotNote: read.note || null,
    captureNote: read.capture || null,
    consoleLogCount: read.logs.length,
    consoleErrorCount: read.consoleErrors,
    networkCallCount: read.calls.length,
    timingMs: jsonClone(read.timing),
    retryHistory: jsonClone(read.retries),
    signals,
  };
}

const report = (label, action, reason, read, signals) => ({
  label,
  action,
  reason,
  evidence: digestOf(read, signals),
});

/**
 * Classify one failure bundle.
 *
 * @param {object} evidence step evidence bundle; never mutated.
 * @returns {{label: string, action: string|null, reason: string, evidence: object}}
 */
export function diagnoseFailure(evidence) {
  const read = readEvidence(evidence);

  if (!read.present) {
    return report('UNGRADED', 'blocked', 'no evidence bundle was supplied, so no cause can be established', read, [
      'evidence-absent',
    ]);
  }

  if (!read.reportedFailure) {
    return report(
      'none',
      null,
      'the step reported no error, no console error and no capture problem, so there is nothing to diagnose',
      read,
      ['no-reported-failure'],
    );
  }

  if (EVIDENCE_UNUSABLE.test(read.narrative)) {
    return report(
      'UNGRADED',
      'blocked',
      'the evidence bundle is missing or truncated, so the cause cannot be established from what was captured',
      read,
      ['evidence-unusable'],
    );
  }

  if (CAUSE_UNDECIDABLE.test(read.narrative)) {
    return report(
      'UNGRADED',
      'blocked',
      'the evidence names more than one candidate cause and states that none of them dominates',
      read,
      ['cause-undecidable'],
    );
  }

  const families = familiesOf(read);

  if (families.length > 1 && HEDGED.test(read.narrative)) {
    return report(
      'UNGRADED',
      'blocked',
      `the evidence hedges between competing causes (${families.map((f) => f.label).join(', ')}) with no deciding signal`,
      read,
      ['cause-undecidable', ...families.map((f) => f.label)],
    );
  }

  if (families.length === 0) {
    return report(
      'UNGRADED',
      'blocked',
      'the failure matches no known cause family, so the step is blocked rather than guessed',
      read,
      ['no-matching-cause'],
    );
  }

  const [chosen] = families;
  const signals = [chosen.label, ...families.slice(1).map((family) => `also-seen:${family.label}`)];
  let action = chosen.action;
  let reason = chosen.signal;

  if (action === 'retry' && read.retriedBlind) {
    action = 'blocked';
    reason = `${reason}, but the step has already been re-run unchanged, so another blind retry is not warranted`;
  }

  // Fail-closed guard: retry is only ever reachable from the retryable labels.
  if (action === 'retry' && !RETRYABLE_LABELS.has(chosen.label)) {
    action = 'blocked';
    reason = `${reason}; a ${chosen.label} finding is never retried`;
  }

  return report(chosen.label, action, reason, read, signals);
}
