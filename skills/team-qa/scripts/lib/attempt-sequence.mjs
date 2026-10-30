// When a record cannot say which attempt it is, the whole retry chain disappears:
// a case that failed three times and passed on the fourth looks exactly like a case that passed at once, and
// a case cut off by a timeout looks exactly like a case that finished early. The board therefore
// must keep the attempt number, a back link to the previous attempt, the start/end timestamps
// and the time limit of that very attempt.
const ATTEMPT_FIELDS = ['attempt', 'started_at', 'ended_at', 'timeout_ms'];
const GRADED_VERDICTS = ['pass', 'fail'];
const HISTORY_VERDICTS = ['pass', 'fail', 'ungraded', 'blocked'];

// parent_attempt_id is not in the required group because the first attempt has no
// parent: its absence means "this is the first attempt". It is still part of the contract, so
// its shape is still checked, and so is its consistency with the attempt number.
export const ATTEMPT_SEQUENCE_FIELDS = Object.freeze(['attempt_id', ...ATTEMPT_FIELDS, 'parent_attempt_id']);

export function attemptId(record) {
  return typeof record?.attempt_id === 'string' && record.attempt_id.trim()
    ? record.attempt_id
    : `${record?.case_id}#${effectiveAttempt(record)}`;
}

export function effectiveAttempt(record) {
  if (Number.isInteger(record?.attempt) && record.attempt > 0) return record.attempt;
  const hasAnySequenceField = ATTEMPT_SEQUENCE_FIELDS.some((field) => Object.hasOwn(record ?? {}, field));
  return hasAnySequenceField ? null : 1;
}

// Check append-only per-case chains. Existing pre-ID records remain readable via
// the derived ID, but duplicate derived IDs fail closed.
export function attemptHistoryIssue(records) {
  const ids = new Set();
  const byCase = new Map();
  const pending = new Set();
  for (const record of records ?? []) {
    if (record?.verdict === 'pending') {
      if (pending.has(record.case_id) || byCase.has(record.case_id)) return `ATTEMPT_HISTORY_PENDING ${record.case_id}`;
      pending.add(record.case_id);
      continue;
    }
    if (pending.has(record?.case_id)) return `ATTEMPT_HISTORY_PENDING ${record.case_id}`;
    if (!HISTORY_VERDICTS.includes(record?.verdict)) return `ATTEMPT_HISTORY_VERDICT ${record?.case_id ?? ''}`.trim();
    const history = byCase.get(record.case_id) ?? [];
    const expected = history.length + 1;
    const hasAnySequenceField = ATTEMPT_SEQUENCE_FIELDS.some((field) => Object.hasOwn(record ?? {}, field));
    if (hasAnySequenceField && declaredAttemptFields(record).length !== ATTEMPT_FIELDS.length) {
      return `ATTEMPT_HISTORY_INCOMPLETE ${record.case_id}`;
    }
    const id = attemptId(record);
    if (ids.has(id)) return `ATTEMPT_HISTORY_DUPLICATE_ID ${id}`;
    ids.add(id);
    if (!hasAnySequenceField && expected !== 1) return `ATTEMPT_HISTORY_ORDER ${record.case_id}`;
    const actualAttempt = effectiveAttempt(record);
    if (actualAttempt !== expected) return `ATTEMPT_HISTORY_ORDER ${record.case_id}`;
    if (expected === 1 ? Object.hasOwn(record, 'parent_attempt_id') : record.parent_attempt_id !== attemptId(history.at(-1))) {
      return `ATTEMPT_HISTORY_PARENT ${record.case_id}`;
    }
    history.push(record);
    byCase.set(record.case_id, history);
  }
  return null;
}

// Returns the final row only when its current evidence/scope validation passes.
// Historical scope must be checked separately by the caller; an older ungraded
// attempt may lack result evidence but must remain in the retry chain.
export function latestAttemptByCase(records, validate = () => null) {
  const issue = attemptHistoryIssue(records);
  const histories = new Map();
  const pendingByCase = new Map();
  for (const record of records ?? []) {
    if (record?.verdict === 'pending') {
      pendingByCase.set(record.case_id, record);
      continue;
    }
    const rows = histories.get(record.case_id) ?? [];
    rows.push(record);
    histories.set(record.case_id, rows);
  }
  const latestByCase = new Map();
  for (const [caseId, rows] of histories) {
    const latest = rows.at(-1);
    const invalid = issue || validate(latest);
    const inferred = !ATTEMPT_SEQUENCE_FIELDS.some((field) => Object.hasOwn(latest ?? {}, field));
    latestByCase.set(caseId, invalid ? null : inferred ? { ...latest, attempt: 1, attempt_id: attemptId(latest) } : latest);
  }
  for (const [caseId, pending] of pendingByCase) {
    if (!histories.has(caseId)) latestByCase.set(caseId, issue ? null : pending);
  }
  return { issue, histories, latestByCase };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

// null means it cannot be read as a timestamp; no other value is guessed.
function timestamp(value) {
  if (!isNonEmptyString(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A field with the wrong shape counts as not declaring that field: attempt 0, a negative
// timeout or an unparsable timestamp does not describe any attempt.
export function attemptShapeErrors(record, prefix) {
  const errors = [];
  const item = record ?? {};
  if (Object.hasOwn(item, 'attempt_id') && !isNonEmptyString(item.attempt_id)) errors.push(`${prefix} attempt_id`);
  if (Object.hasOwn(item, 'attempt') && !isPositiveInteger(item.attempt)) errors.push(`${prefix} attempt`);
  if (Object.hasOwn(item, 'parent_attempt_id') && !isNonEmptyString(item.parent_attempt_id)) {
    errors.push(`${prefix} parent_attempt_id`);
  }
  for (const field of ['started_at', 'ended_at']) {
    if (Object.hasOwn(item, field) && timestamp(item[field]) === null) errors.push(`${prefix} ${field}`);
  }
  if (Object.hasOwn(item, 'timeout_ms') && !isPositiveInteger(item.timeout_ms)) errors.push(`${prefix} timeout_ms`);
  return errors;
}

export function declaredAttemptFields(record) {
  return ATTEMPT_FIELDS.filter((field) => Object.hasOwn(record ?? {}, field));
}

// ms the attempt ran; null means the record did not declare a valid pair of timestamps.
export function attemptDuration(record) {
  const started = timestamp(record?.started_at);
  const ended = timestamp(record?.ended_at);
  if (started === null || ended === null) return null;
  return ended - started;
}

// A timeout is a state of its own, not a graded result: an attempt
// that hit its limit was cut off midway, so what it observed is incomplete. null
// means there is not enough data to conclude.
export function attemptTimedOut(record) {
  const duration = attemptDuration(record);
  if (duration === null || !isPositiveInteger(record?.timeout_ms)) return null;
  return duration >= record.timeout_ms;
}

// null means the record is valid against the attempt-chain contract; a returned string is the reason
// to fail closed, used verbatim as the reason of the ungraded record.
export function attemptSequenceIssue(record, lock) {
  const declared = declaredAttemptFields(record);
  // Declaring half is worse than declaring nothing: a record with attempt but without timeout_ms
  // looks as if the duration of that attempt was fully measured.
  if ((declared.length > 0 || Object.hasOwn(record ?? {}, 'attempt_id')) && declared.length < ATTEMPT_FIELDS.length) return 'ATTEMPT_SEQUENCE_MISSING';
  if (declared.length === 0) {
    // A parent without an attempt number means the chain cannot be rebuilt.
    if (Object.hasOwn(record ?? {}, 'parent_attempt_id')) return 'ATTEMPT_SEQUENCE_MISSING';
    // A run with a locked target is a run grading the real product; there pass/fail must state
    // which attempt it is and how long it ran. A v1 run without an executor
    // keeps the old contract so old records do not break.
    if (!GRADED_VERDICTS.includes(record?.verdict)) return null;
    return lock?.governed ? 'ATTEMPT_SEQUENCE_MISSING' : null;
  }
  if (attemptShapeErrors(record, 'ATTEMPT').length > 0) return 'ATTEMPT_SEQUENCE_MISSING';
  // The first attempt has no parent, and a retry must always point to the attempt before it; missing
  // either direction breaks the chain and tells the retry history wrongly.
  const hasParent = Object.hasOwn(record, 'parent_attempt_id');
  if (record.attempt === 1 && hasParent) return 'ATTEMPT_SEQUENCE_BROKEN';
  if (record.attempt > 1 && !hasParent) return 'ATTEMPT_SEQUENCE_BROKEN';
  if (attemptDuration(record) < 0) return 'ATTEMPT_TIMING_INVALID';
  if (!GRADED_VERDICTS.includes(record.verdict)) return null;
  if (attemptTimedOut(record)) return 'ATTEMPT_TIMEOUT_EXCEEDED';
  return null;
}
