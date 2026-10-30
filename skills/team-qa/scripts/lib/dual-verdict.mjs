// qa-gui grades two separate dimensions: Function is whether the behavior works correctly, and
// UI+Visual is whether the interface is correct. Merging the two into one verdict loses
// the hard-gate criterion: a fail in one dimension is hidden by a pass in the other. The board therefore
// keeps the two fields separate, and the aggregate is a consequence derived from them, not
// a choice of whoever writes the record. Never overwrite these two fields.
const DIMENSIONS = ['function_verdict', 'ui_visual_verdict'];
const DIMENSION_VERDICTS = ['pass', 'fail', 'ungraded'];
const GRADED_VERDICTS = ['pass', 'fail'];

// A wrong shape also means that dimension is absent: do not guess a missing value, do not
// patch it to pass.
export function dualVerdictShapeErrors(record, prefix) {
  const errors = [];
  for (const field of DIMENSIONS) {
    if (!Object.hasOwn(record, field)) continue;
    if (!DIMENSION_VERDICTS.includes(record[field])) errors.push(`${prefix} ${field}`);
  }
  return errors;
}

export function declaredDimensions(record) {
  return DIMENSIONS.filter((field) => Object.hasOwn(record ?? {}, field));
}

// null means the record has not declared both dimensions, so no aggregate can be derived yet.
// One failed dimension fails the whole case; the case passes only when both dimensions pass;
// anything else is ungraded.
export function aggregateVerdict(record) {
  const values = DIMENSIONS.map((field) => record?.[field]);
  if (values.some((value) => !DIMENSION_VERDICTS.includes(value))) return null;
  if (values.includes('fail')) return 'fail';
  if (values.every((value) => value === 'pass')) return 'pass';
  return 'ungraded';
}

// null means the record is valid against the two-dimension contract; a returned string is the reason
// to fail closed, used verbatim as the reason of the ungraded record.
export function dualVerdictIssue(record, lock) {
  const declared = declaredDimensions(record);
  // Declaring half is worse than declaring nothing: it gives the impression that both dimensions were graded.
  if (declared.length > 0 && declared.length < DIMENSIONS.length) return 'DUAL_VERDICT_MISSING';
  // Only graded verdicts are bound, exactly like target identity: ungraded and
  // blocked are ungraded results, so they keep their original reason.
  if (!GRADED_VERDICTS.includes(record?.verdict)) return null;
  if (declared.length === 0) {
    // A run with a locked target is grading the real product; there pass/fail must
    // state which dimension passed/failed. A v1 run without an executor still keeps
    // the old contract so old records do not break.
    return lock?.governed ? 'DUAL_VERDICT_MISSING' : null;
  }
  const aggregate = aggregateVerdict(record);
  if (!aggregate) return 'DUAL_VERDICT_MISSING';
  if (record.verdict !== aggregate) return 'DUAL_VERDICT_CONFLICT';
  return null;
}
