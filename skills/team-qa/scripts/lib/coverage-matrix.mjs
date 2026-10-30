// Counting enough cases does not prove full coverage. A tracked plan of only functional
// cases in the ideal state on desktop still reaches a high coverage percentage
// while a whole test type, the empty/error states and the mobile screen
// are never touched. The coverage matrix therefore needs three axes declared
// explicitly on every case; an axis that is not declared makes that gap invisible.
const TAXONOMY = [
  'functional', 'boundary', 'negative', 'state', 'regression', 'visual', 'accessibility', 'performance', 'security',
];
const STATES = ['empty', 'loading', 'partial', 'ideal', 'error'];
const VIEWPORTS = ['mobile', 'tablet', 'desktop'];

const AXES = [
  ['taxonomy', TAXONOMY],
  ['states', STATES],
  ['viewports', VIEWPORTS],
];

export const COVERAGE_AXES = Object.freeze({
  taxonomy: Object.freeze([...TAXONOMY]),
  states: Object.freeze([...STATES]),
  viewports: Object.freeze([...VIEWPORTS]),
});

export const COVERAGE_FIELDS = AXES.map(([field]) => field);

// An axis with the wrong shape counts as not declaring that axis: an empty array, a value outside
// the vocabulary or a repeated value cannot say how far the case covers. Do not guess,
// do not fill in a default value.
function axisIsValid(value, allowed) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.some((item) => !allowed.includes(item))) return false;
  return new Set(value).size === value.length;
}

export function declaredCoverageAxes(item) {
  return COVERAGE_FIELDS.filter((field) => Object.hasOwn(item ?? {}, field));
}

// Returns a list of errors of the form `${prefix} <field>`; empty means the case is valid against
// the current coverage matrix contract.
export function coverageShapeErrors(item, prefix) {
  const errors = [];
  for (const [field, allowed] of AXES) {
    if (!Object.hasOwn(item ?? {}, field)) continue;
    if (!axisIsValid(item[field], allowed)) errors.push(`${prefix} ${field}`);
  }
  return errors;
}

// The axes still missing that the case must declare. Declaring half is worse than declaring nothing:
// a case with a taxonomy but no viewports looks as if all three axes were considered.
// A run with a locked target is grading the real product, so there all three axes are
// required; a v1 run without an executor keeps the old contract so old plans do not break.
export function missingCoverageAxes(item, lock) {
  const declared = declaredCoverageAxes(item);
  const enforced = lock?.governed === true || (declared.length > 0 && declared.length < COVERAGE_FIELDS.length);
  if (!enforced) return [];
  return COVERAGE_FIELDS.filter((field) => !declared.includes(field));
}
