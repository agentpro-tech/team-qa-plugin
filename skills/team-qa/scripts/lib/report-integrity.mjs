// A green report does not prove by itself what it checked. The reader has only
// a few numbers and must trust that someone behind them looked closely enough. Three questions
// must therefore be answerable from the report itself, not from the memory of whoever
// ran it: which case and which artifact each NO_GO reason is bound to, which RED checkers
// really ran and how many items they inspected, and which child gates contributed to the conclusion.
//
// Without the first answer, a reason is a story that cannot be traced. Without the second,
// a disabled checker looks exactly like a checker that finished and found nothing. Without the
// third, a run with real child gates cannot be told apart from a run where only a script graded
// itself. All three are ways for a wrong report to look like a clean one.
import { CHILD_SKILLS } from './child-verdict.mjs';

export const REPORT_INTEGRITY_FIELDS = Object.freeze(['grounded_issues', 'red_checkers', 'child_gates']);

const ISSUE_FIELDS = ['code', 'checker', 'source', 'case_id', 'evidence', 'detail'];
const CHECKER_FIELDS = ['id', 'contract', 'scope', 'checked', 'issues'];
const GATE_FIELDS = ['gate', 'records', 'graded', 'ungraded', 'bound'];

// The source of an issue is the artifact that can rebuild it: board.jsonl for recorded
// results, tracked-plan.json for a case that should have existed, test-plan.md for the signed exit
// criteria thresholds.
export const ISSUE_SOURCES = Object.freeze(['board', 'tracked_plan', 'test_plan']);

const CHECKER_SCOPES = ['board_record', 'tracked_case', 'requirement', 'run'];

const GRADED_VERDICTS = ['pass', 'fail'];

// The list of checkers that the `report build` path really runs, with the contract that
// each checker holds. A checker that fails closed at input reading (evidence,
// coverage matrix, attempt sequence) never leaves an issue in the report, because
// a violation means no report is produced at all; their `checked` count must still
// be declared, so that a run that inspected 0 items cannot pass itself off as a clean
// run.
const CHECKERS = Object.freeze([
  { id: 'coverage-matrix', contract: 'RED-TQ-COVERAGE-MATRIX-001', scope: 'tracked_case' },
  { id: 'attempt-sequence', contract: 'RED-TQ-TRIES-SEQUENCE-001', scope: 'board_record' },
  { id: 'evidence-contract', contract: 'RED-TQ-EVIDENCE-CONTRACT-001', scope: 'board_record' },
  { id: 'target-identity', contract: 'RED-TQ-TARGET-LOCK-001', scope: 'board_record' },
  { id: 'target-consensus', contract: 'RED-TQ-TARGET-LOCK-001', scope: 'run' },
  { id: 'dual-verdict', contract: 'RED-TQ-DUAL-VERDICT-001', scope: 'board_record' },
  { id: 'child-verdict', contract: 'RED-TQ-VERDICT-BINDING-001', scope: 'board_record' },
  { id: 'failure-separation', contract: 'RED-TQ-FAILURE-SEPARATION-001', scope: 'board_record' },
  { id: 'board-completeness', contract: 'G6', scope: 'tracked_case' },
  { id: 'coverage-exit', contract: 'L3', scope: 'requirement' },
  { id: 'defect-exit', contract: 'L3', scope: 'board_record' },
  { id: 'ungraded-exit', contract: 'L11', scope: 'board_record' },
]);

export const REPORT_CHECKER_IDS = Object.freeze(CHECKERS.map((item) => item.id));

// A checker that runs only for a report that carries its field (R1b: `coverage_cells`, when the tracked plan has the
// coverage block). It is declared exactly when that field is present, so a report in the old shape keeps its ledger.
const FIELD_CHECKERS = Object.freeze([
  { id: 'coverage-cells', contract: 'RED-TQ-COVERAGE-CELLS-001', scope: 'tracked_case', field: 'coverage_cells', option: 'coverageCells' },
]);

function checkersFor(fields) {
  return [...CHECKERS, ...FIELD_CHECKERS.filter((checker) => fields.has(checker.field))];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function evidenceList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isNonEmptyString);
}

// An issue counts as grounded only when it says everything: which checker found it, which artifact
// can rebuild it, which case is responsible (null when the issue belongs to the whole run)
// and which evidence was read. `detail` keeps the v1 reason verbatim so that the old contract
// keeps its meaning: a grounded issue is an attached origin, not a replacement.
export function groundedIssue({ checker, code, caseId = null, evidence = [], detail = null, source = 'board' }) {
  return {
    code,
    checker,
    source,
    case_id: isNonEmptyString(caseId) ? caseId : null,
    evidence: evidenceList(evidence),
    detail: detail ?? (isNonEmptyString(caseId) ? `${code} ${caseId}` : code),
  };
}

export function issueReasons(issues) {
  return (issues ?? []).map((issue) => issue.detail);
}

// `checked` is the number of items that checker inspected in this run. Undeclared means 0, and
// 0 is a real declaration, not a temporary patch value: a checker that inspected no items
// must not be read as having vouched for anything.
export function redCheckerLedger(issues, checked = {}, options = {}) {
  const found = issues ?? [];
  const fields = new Set(FIELD_CHECKERS.filter((checker) => options[checker.option] === true).map((checker) => checker.field));
  return checkersFor(fields).map((checker) => ({
    id: checker.id,
    contract: checker.contract,
    scope: checker.scope,
    checked: isCount(checked[checker.id]) ? checked[checker.id] : 0,
    issues: found.filter((issue) => issue.checker === checker.id).length,
  }));
}

// Which child gate a record belongs to: the record's writing source comes first, while a record
// written by a script counts by the child conclusion it carries. A record tied to no child gate
// must not be assigned to a gate at random.
function gateOf(record) {
  if (CHILD_SKILLS.includes(record?.source)) return record.source;
  const skill = record?.child_verdict?.skill;
  return CHILD_SKILLS.includes(skill) ? skill : null;
}

// Every declared child gate has a row, including a gate that ran no rows: a run
// to which no child gate contributed must be visible at once, instead of vanishing
// from the report together with the question "who really graded this".
export function childGateLedger(records) {
  const board = records ?? [];
  return CHILD_SKILLS.map((gate) => {
    const own = board.filter((record) => gateOf(record) === gate);
    return {
      gate,
      records: own.length,
      graded: own.filter((record) => GRADED_VERDICTS.includes(record.verdict)).length,
      ungraded: own.filter((record) => record.verdict === 'ungraded').length,
      bound: own.filter((record) => record.child_verdict?.skill === gate).length,
    };
  });
}

function shapeErrors(item, fields, code, context) {
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [`${code} ${context}`];
  for (const field of fields) if (!Object.hasOwn(item, field)) errors.push(`${code} ${context}.${field}`);
  for (const key of Object.keys(item)) if (!fields.includes(key)) errors.push(`${code} ${context}.${key}`);
  return errors;
}

function issueErrors(issue, index, known = REPORT_CHECKER_IDS) {
  const context = `grounded_issues[${index}]`;
  const errors = shapeErrors(issue, ISSUE_FIELDS, 'REPORT_INTEGRITY_TYPE', context);
  if (errors.length > 0) return errors;
  for (const field of ['code', 'checker', 'detail']) {
    if (!isNonEmptyString(issue[field])) errors.push(`REPORT_INTEGRITY_TYPE ${context}.${field}`);
  }
  if (!ISSUE_SOURCES.includes(issue.source)) errors.push(`REPORT_INTEGRITY_TYPE ${context}.source`);
  if (!(issue.case_id === null || isNonEmptyString(issue.case_id))) {
    errors.push(`REPORT_INTEGRITY_TYPE ${context}.case_id`);
  }
  if (!Array.isArray(issue.evidence) || issue.evidence.some((item) => !isNonEmptyString(item))) {
    errors.push(`REPORT_INTEGRITY_TYPE ${context}.evidence`);
  }
  if (errors.length === 0 && !known.includes(issue.checker)) {
    errors.push(`REPORT_CHECKER_UNKNOWN ${issue.checker}`);
  }
  return errors;
}

function checkerErrors(entry, index, known = REPORT_CHECKER_IDS) {
  const context = `red_checkers[${index}]`;
  const errors = shapeErrors(entry, CHECKER_FIELDS, 'REPORT_INTEGRITY_TYPE', context);
  if (errors.length > 0) return errors;
  for (const field of ['id', 'contract']) {
    if (!isNonEmptyString(entry[field])) errors.push(`REPORT_INTEGRITY_TYPE ${context}.${field}`);
  }
  if (!CHECKER_SCOPES.includes(entry.scope)) errors.push(`REPORT_INTEGRITY_TYPE ${context}.scope`);
  for (const field of ['checked', 'issues']) {
    if (!isCount(entry[field])) errors.push(`REPORT_INTEGRITY_TYPE ${context}.${field}`);
  }
  if (errors.length === 0 && !known.includes(entry.id)) {
    errors.push(`REPORT_CHECKER_UNKNOWN ${entry.id}`);
  }
  return errors;
}

function gateErrors(entry, index) {
  const context = `child_gates[${index}]`;
  const errors = shapeErrors(entry, GATE_FIELDS, 'REPORT_INTEGRITY_TYPE', context);
  if (errors.length > 0) return errors;
  if (!isNonEmptyString(entry.gate)) errors.push(`REPORT_INTEGRITY_TYPE ${context}.gate`);
  for (const field of ['records', 'graded', 'ungraded', 'bound']) {
    if (!isCount(entry[field])) errors.push(`REPORT_INTEGRITY_TYPE ${context}.${field}`);
  }
  if (errors.length === 0 && !CHILD_SKILLS.includes(entry.gate)) {
    errors.push(`REPORT_CHILD_GATE_UNKNOWN ${entry.gate}`);
  }
  return errors;
}

// A report read from a file may have been edited by hand, so these three arrays are checked like any other
// input: a wrong shape, a missing checker declaration, or a reason that lost its origin is
// red. In particular, reasons and grounded issues must match line by line in the exact order:
// adding a reason without an origin, or dropping the origin of an existing reason, loses
// traceability; it is not a presentation difference.
export function reportIntegrityErrors(value) {
  const errors = [];
  for (const field of REPORT_INTEGRITY_FIELDS) {
    if (!Object.hasOwn(value, field)) errors.push(`REPORT_INTEGRITY_MISSING ${field}`);
    else if (!Array.isArray(value[field])) errors.push(`REPORT_INTEGRITY_TYPE ${field}`);
  }
  if (errors.length > 0) return errors;

  const known = checkersFor(new Set(FIELD_CHECKERS.map((checker) => checker.field).filter((field) => Object.hasOwn(value, field)))).map((checker) => checker.id);
  value.grounded_issues.forEach((issue, index) => errors.push(...issueErrors(issue, index, known)));
  value.red_checkers.forEach((entry, index) => errors.push(...checkerErrors(entry, index, known)));
  value.child_gates.forEach((entry, index) => errors.push(...gateErrors(entry, index)));
  if (errors.length > 0) return errors;

  const declared = new Set(value.red_checkers.map((entry) => entry.id));
  for (const id of known) if (!declared.has(id)) errors.push(`REPORT_CHECKER_UNDECLARED ${id}`);
  const gates = new Set(value.child_gates.map((entry) => entry.gate));
  for (const gate of CHILD_SKILLS) if (!gates.has(gate)) errors.push(`REPORT_CHILD_GATE_UNDECLARED ${gate}`);

  const reasons = Array.isArray(value.reasons) ? value.reasons : [];
  for (let index = 0; index < Math.max(reasons.length, value.grounded_issues.length); index += 1) {
    const reason = reasons[index];
    const issue = value.grounded_issues[index];
    if (!issue) errors.push(`REPORT_UNGROUNDED_REASON ${reason}`);
    else if (issue.detail !== reason) errors.push(`REPORT_UNGROUNDED_REASON ${reason ?? issue.detail}`);
  }
  for (const entry of value.red_checkers) {
    const counted = value.grounded_issues.filter((issue) => issue.checker === entry.id).length;
    if (entry.issues !== counted) errors.push(`REPORT_CHECKER_COUNT ${entry.id}`);
  }
  return errors;
}
