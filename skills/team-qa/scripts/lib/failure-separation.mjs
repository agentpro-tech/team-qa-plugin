// A single merged "fail" cell cannot say who has to fix it. A wrong product is a product
// defect, a wrong test runner is a harness failure, a wrong infrastructure is an environment
// failure; mixing the three sources into one number does two equal harms: it blames
// the product because a runner hung, and it hides a real defect behind the excuse "probably the environment".
// The report therefore counts the three sources separately, and every failure must state which
// source it belongs to instead of leaving the reader to guess.
const FAILURE_CLASSES = ['product', 'harness', 'environment'];

export const FAILURE_CLASS_FIELD = 'failure_class';

export const FAILURE_METRIC_FIELDS = Object.freeze([
  'product_defects', 'harness_failures', 'environment_failures',
]);

const METRIC_BY_CLASS = {
  product: 'product_defects',
  harness: 'harness_failures',
  environment: 'environment_failures',
};

const REASON_BY_CLASS = {
  harness: 'HARNESS_FAILURE',
  environment: 'ENVIRONMENT_FAILURE',
};

// A wrong shape also means the failure source is not declared: a string outside the vocabulary
// separates nothing, and it must not be guessed which source it meant.
export function failureClassShapeErrors(record, prefix) {
  const item = record ?? {};
  if (!Object.hasOwn(item, FAILURE_CLASS_FIELD)) return [];
  if (FAILURE_CLASSES.includes(item[FAILURE_CLASS_FIELD])) return [];
  return [`${prefix} ${FAILURE_CLASS_FIELD}`];
}

// null means this record is not a failure that needs a source. A pass result
// has no failure source; ungraded/blocked counts only when it declares itself harness or
// environment, because that is exactly why it could not be graded.
//
// A fail without a declared source defaults to product: fail-closed in the right direction, because
// assigning harness/environment to a fail nobody has investigated is the fastest way
// to make a real defect vanish from the report.
export function failureClassOf(record) {
  const item = record ?? {};
  if (item.verdict === 'pass') return null;
  if (FAILURE_CLASSES.includes(item[FAILURE_CLASS_FIELD])) return item[FAILURE_CLASS_FIELD];
  return item.verdict === 'fail' ? 'product' : null;
}

export function isProductFailure(record) {
  return failureClassOf(record) === 'product';
}

export function separateFailures(records) {
  const metrics = { product_defects: 0, harness_failures: 0, environment_failures: 0 };
  for (const record of records ?? []) {
    const failureClass = failureClassOf(record);
    if (failureClass) metrics[METRIC_BY_CLASS[failureClass]] += 1;
  }
  return metrics;
}

// null means the record carries no failure outside the product. A broken harness or environment
// means that case was not really checked on the product, so it must not
// silently drop out of the GO gate just because it is no longer counted as a product defect.
export function failureSeparationIssue(record) {
  return REASON_BY_CLASS[failureClassOf(record)] ?? null;
}
