import { basename, dirname, resolve } from 'node:path';
import { constants, accessSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fail,
  parseJson,
  readText,
  rejectUnknownFields,
  requireObject,
} from './core.mjs';
import { resolveTargetLock, targetShapeErrors } from './target-lock.mjs';
import { COVERAGE_FIELDS, coverageShapeErrors, missingCoverageAxes } from './coverage-matrix.mjs';
import { childVerdictShapeErrors } from './child-verdict.mjs';
import { dualVerdictShapeErrors } from './dual-verdict.mjs';
import { ATTEMPT_SEQUENCE_FIELDS, attemptHistoryIssue, attemptShapeErrors } from './attempt-sequence.mjs';
import { FAILURE_CLASS_FIELD, FAILURE_METRIC_FIELDS, failureClassShapeErrors } from './failure-separation.mjs';
import { deployedTargetShapeErrors } from './deployed-target.mjs';
import { REPORT_INTEGRITY_FIELDS, reportIntegrityErrors } from './report-integrity.mjs';
import { caseCellErrors, coverageReportErrors, planCoverageErrors, trackedCoverageErrors } from './coverage-cells.mjs';
import {
  SOURCE_TRACEABILITY_VERSION,
  TRACKED_PLAN_SCHEMA_VERSION,
  sourceRefErrors,
  sourceRegistryErrors,
} from './source-traceability.mjs';
import { planSpeedErrors } from './speed.mjs';
import { LANE_IDENTITY_FIELDS, planParallelErrors } from './parallel-lanes.mjs';

// R1b: the report field of the cell coverage (lib/coverage-cells.mjs).
const COVERAGE_REPORT_FIELDS = Object.freeze(['coverage_cells']);
const PLAN_START = 'TEAMQA_PLAN_START';
const PLAN_END = 'TEAMQA_PLAN_END';
const REPORT_START = 'TEAMQA_REPORT_START';
const REPORT_END = 'TEAMQA_REPORT_END';
const BOARD_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../schemas/board.json', import.meta.url)), 'utf8'));
const BOARD_SCHEMA_V2 = JSON.parse(readFileSync(fileURLToPath(new URL('../../schemas/board-v2.json', import.meta.url)), 'utf8'));
const BOARD_SCHEMA_FIELDS = Object.keys(BOARD_SCHEMA.properties);
const BOARD_SCHEMA_V2_FIELDS = Object.keys(BOARD_SCHEMA_V2.properties);
const BOARD_SCHEMA_VERDICTS = BOARD_SCHEMA.properties.verdict.enum;

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

export function parseMarkedJson(text, start, end, prefix) {
  if (occurrences(text, start) !== 1) fail(2, `${prefix}_MARKER`, start);
  if (occurrences(text, end) !== 1) fail(2, `${prefix}_MARKER`, end);
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (endAt <= startAt + start.length) fail(2, `${prefix}_MARKER`, end);
  return parseJson(text.slice(startAt + start.length, endAt).trim(), `${prefix}_JSON_INVALID`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missing(value, fields, prefix, errors) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${prefix}_MISSING_FIELD ${field}`);
  }
}

function unknown(value, allowed, prefix, context, errors) {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(`${prefix}_UNKNOWN_FIELD ${context ? `${context} ` : ''}${key}`);
  }
}

export function planErrors(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['PLAN_TYPE root'];
  const root = ['run_id', 'app', 'plan_version', 'lanes', 'tiers', 'exit_criteria'];
  missing(value, root, 'PLAN', errors);
  // `coverage` (R1b, optional): the N/A cells the owner signs with the plan (lib/coverage-cells.mjs).
  unknown(value, [...root, 'preflight', 'coverage', 'speed'], 'PLAN', '', errors);
  if (Object.hasOwn(value, 'coverage')) errors.push(...planCoverageErrors(value.coverage));
  // Upgrade R3: the optional speed flags (lib/speed.mjs); a plan without them validates exactly as before.
  if (Object.hasOwn(value, 'speed')) errors.push(...planSpeedErrors(value.speed), ...planParallelErrors(value));
  if (Object.hasOwn(value, 'preflight')) {
    const p = value.preflight;
    if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('PLAN_TYPE preflight');
    else {
      unknown(p, ['code', 'gui', 'recording'], 'PLAN', 'preflight', errors);
      if (!['code', 'gui', 'recording'].every(k => typeof p[k] === 'boolean') || (p.recording && !p.gui)) errors.push('PLAN_TYPE preflight.scope');
    }
  }
  if (Object.hasOwn(value, 'run_id') && !isNonEmptyString(value.run_id)) errors.push('PLAN_TYPE run_id');
  if (Object.hasOwn(value, 'app') && !isNonEmptyString(value.app)) errors.push('PLAN_TYPE app');
  if (Object.hasOwn(value, 'plan_version') && (!Number.isInteger(value.plan_version) || value.plan_version < 1)) {
    errors.push('PLAN_TYPE plan_version');
  }

  if (Object.hasOwn(value, 'lanes')) {
    if (!Array.isArray(value.lanes)) errors.push('PLAN_TYPE lanes');
    else {
      const ids = new Set();
      value.lanes.forEach((lane, index) => {
        const where = `lanes[${index}]`;
        if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
          errors.push(`PLAN_TYPE ${where}`);
          return;
        }
        const fields = ['id', 'scope', 'parallel_ok', 'vi_sao'];
        for (const field of fields) if (!Object.hasOwn(lane, field)) errors.push(`PLAN_MISSING_FIELD ${where}.${field}`);
        // Upgrade R3: a lane may name its own test account or tenant, data namespace and Dragon session (lib/parallel-lanes.mjs).
        for (const key of Object.keys(lane)) if (!fields.includes(key) && !LANE_IDENTITY_FIELDS.includes(key)) errors.push(`PLAN_UNKNOWN_FIELD ${where}.${key}`);
        for (const key of LANE_IDENTITY_FIELDS) if (Object.hasOwn(lane, key) && !isNonEmptyString(lane[key])) errors.push(`PLAN_TYPE ${where}.${key}`);
        if (Object.hasOwn(lane, 'id')) {
          if (!isNonEmptyString(lane.id)) errors.push(`PLAN_TYPE ${where}.id`);
          else if (ids.has(lane.id)) errors.push(`PLAN_DUPLICATE ${where}.id`);
          else ids.add(lane.id);
        }
        if (Object.hasOwn(lane, 'scope') && (!Array.isArray(lane.scope) || lane.scope.length === 0
          || lane.scope.some((item) => !isNonEmptyString(item)))) errors.push(`PLAN_TYPE ${where}.scope`);
        if (Object.hasOwn(lane, 'parallel_ok') && typeof lane.parallel_ok !== 'boolean') {
          errors.push(`PLAN_TYPE ${where}.parallel_ok`);
        }
        if (Object.hasOwn(lane, 'vi_sao') && typeof lane.vi_sao !== 'string') errors.push(`PLAN_TYPE ${where}.vi_sao`);
        if (lane.parallel_ok === true && !isNonEmptyString(lane.vi_sao)) errors.push(`PLAN_PARALLEL_REASON ${where}.vi_sao`);
      });
    }
  }

  if (Object.hasOwn(value, 'tiers')) {
    if (!value.tiers || typeof value.tiers !== 'object' || Array.isArray(value.tiers)) errors.push('PLAN_TYPE tiers');
    else {
      for (const [requirement, tier] of Object.entries(value.tiers)) {
        if (!isNonEmptyString(requirement) || !['FULL', 'SMOKE'].includes(tier)) errors.push(`PLAN_TYPE tiers.${requirement}`);
      }
    }
  }

  if (Object.hasOwn(value, 'exit_criteria')) {
    const criteria = value.exit_criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) errors.push('PLAN_TYPE exit_criteria');
    else {
      const fields = ['p0_max', 'p1_max', 'p1_waivers', 'coverage_high_pct', 'coverage_low_pct'];
      for (const field of fields) if (!Object.hasOwn(criteria, field)) errors.push(`PLAN_MISSING_FIELD exit_criteria.${field}`);
      for (const key of Object.keys(criteria)) if (!fields.includes(key)) errors.push(`PLAN_UNKNOWN_FIELD exit_criteria.${key}`);
      for (const field of ['p0_max', 'p1_max']) {
        if (Object.hasOwn(criteria, field) && (!Number.isInteger(criteria[field]) || criteria[field] < 0)) {
          errors.push(`PLAN_TYPE exit_criteria.${field}`);
        }
      }
      if (Object.hasOwn(criteria, 'p1_waivers') && (!Array.isArray(criteria.p1_waivers)
        || criteria.p1_waivers.some((item) => !isNonEmptyString(item)))) errors.push('PLAN_TYPE exit_criteria.p1_waivers');
      for (const field of ['coverage_high_pct', 'coverage_low_pct']) {
        if (Object.hasOwn(criteria, field) && (!Number.isInteger(criteria[field])
          || criteria[field] < 0 || criteria[field] > 100)) errors.push(`PLAN_TYPE exit_criteria.${field}`);
      }
    }
  }

  if (Array.isArray(value.lanes) && value.tiers && typeof value.tiers === 'object' && !Array.isArray(value.tiers)) {
    for (let index = 0; index < value.lanes.length; index += 1) {
      const lane = value.lanes[index];
      if (!lane || !Array.isArray(lane.scope)) continue;
      for (const requirement of lane.scope) {
        if (!Object.hasOwn(value.tiers, requirement)) errors.push(`PLAN_SCOPE_UNKNOWN lanes[${index}].scope ${requirement}`);
      }
    }
  }
  return errors;
}

export function loadPlan(path) {
  const text = readText(path, { label: basename(path) });
  const value = parseMarkedJson(text, PLAN_START, PLAN_END, 'PLAN');
  const errors = planErrors(value);
  return { text, value, errors, path };
}

const CASE_REQUIRED = ['id', 'req_id', 'lane', 'steps', 'expected', 'data', 'priority', 'kind'];
const CASE_REQUIRED_V2 = [...CASE_REQUIRED, 'title', 'sourceRefs'];
const CASE_FIELDS = [...CASE_REQUIRED, ...COVERAGE_FIELDS];
const CASE_FIELDS_V2 = [...CASE_REQUIRED_V2, ...COVERAGE_FIELDS];
const CASE_CELL_FIELDS = ['route', 'actions', 'conditions'];

export function trackedErrors(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['CASE_TYPE root'];
  const versioned = Object.hasOwn(value, 'schemaVersion');
  const sourceVersion = value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION;
  // R1b: a v2 plan may add a versioned `coverage` block; its cases then may name a route, actions and conditions.
  const cells = sourceVersion && Object.hasOwn(value, 'coverage');
  unknown(value, sourceVersion ? ['schemaVersion', 'sourceItems', 'cases', 'coverage'] : ['cases'], 'CASE', '', errors);
  if (cells) errors.push(...trackedCoverageErrors(value.coverage));
  if (versioned && !sourceVersion) errors.push(`CASE_SCHEMA_VERSION ${String(value.schemaVersion)}`);
  if (sourceVersion && !Object.hasOwn(value, 'sourceItems')) errors.push('CASE_FIELD root sourceItems');
  if (sourceVersion) errors.push(...sourceRegistryErrors(value.sourceItems));
  if (!Object.hasOwn(value, 'cases')) return [...errors, 'CASE_FIELD root cases'];
  if (!Array.isArray(value.cases)) return [...errors, 'CASE_TYPE cases'];
  const lock = options.lock ?? null;
  const ids = new Set();
  const fields = sourceVersion ? CASE_REQUIRED_V2 : CASE_REQUIRED;
  const allowedFields = sourceVersion ? [...CASE_FIELDS_V2, ...(cells ? CASE_CELL_FIELDS : [])] : CASE_FIELDS;
  value.cases.forEach((item, index) => {
    const fallbackId = `cases[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`CASE_TYPE ${fallbackId}`);
      return;
    }
    const id = isNonEmptyString(item.id) ? item.id : fallbackId;
    for (const field of fields) if (!Object.hasOwn(item, field)) errors.push(`CASE_FIELD ${id} ${field}`);
    for (const key of Object.keys(item)) if (!allowedFields.includes(key)) errors.push(`CASE_UNKNOWN_FIELD ${id} ${key}`);
    // The three coverage matrix axes: the shape is always checked, while whether they must be declared follows
    // the run's lock, exactly like target identity and dual verdict.
    for (const field of missingCoverageAxes(item, lock)) errors.push(`CASE_FIELD ${id} ${field}`);
    errors.push(...coverageShapeErrors(item, `CASE_TYPE ${id}`, { cells }));
    if (cells) errors.push(...caseCellErrors(item, value.coverage, id));
    for (const field of ['id', 'req_id', 'lane', 'expected', ...(sourceVersion ? ['title'] : [])]) {
      if (Object.hasOwn(item, field) && !isNonEmptyString(item[field])) errors.push(`CASE_TYPE ${id} ${field}`);
    }
    if (isNonEmptyString(item.id)) {
      if (ids.has(item.id)) errors.push(`CASE_DUPLICATE ${item.id}`);
      ids.add(item.id);
    }
    if (Object.hasOwn(item, 'steps') && (!Array.isArray(item.steps) || item.steps.length === 0
      || item.steps.some((step) => !isNonEmptyString(step)))) errors.push(`CASE_TYPE ${id} steps`);
    if (Object.hasOwn(item, 'data') && (!item.data || typeof item.data !== 'object' || Array.isArray(item.data))) {
      errors.push(`CASE_TYPE ${id} data`);
    }
    if (Object.hasOwn(item, 'priority') && !['P0', 'P1', 'P2'].includes(item.priority)) errors.push(`CASE_TYPE ${id} priority`);
    if (Object.hasOwn(item, 'kind') && !['behavioral', 'static'].includes(item.kind)) errors.push(`CASE_TYPE ${id} kind`);
  });
  if (sourceVersion) errors.push(...sourceRefErrors(value.cases, value.sourceItems));
  return errors;
}

export function loadTracked(path, options = {}) {
  const text = readText(path, { label: basename(path) });
  const value = parseJson(text, 'CASE_JSON_INVALID');
  const lock = options.lock ?? resolveTargetLock({ cwd: process.cwd() });
  return { text, value, errors: trackedErrors(value, { lock }), path };
}

const BOARD_FIELDS = [
  'case_id', 'lane', 'verdict', 'evidence', 'source', 'run_id', 'ts', 'reason', 'target', 'child_verdict',
  'function_verdict', 'ui_visual_verdict', FAILURE_CLASS_FIELD, ...ATTEMPT_SEQUENCE_FIELDS,
  'task_base', 'source_revision', 'verification_lane', 'contract_sha256', 'exact_final_sha', 'target_kind', 'target_binding_sha256',
];
const BOARD_SOURCE_FIELDS = ['traceabilityVersion', 'sourceRefs'];

export function boardRecordErrors(record, line) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [`BOARD_TYPE line=${line}`];
  const id = isNonEmptyString(record.case_id) ? record.case_id : `line=${line}`;
  for (const field of ['case_id', 'lane', 'verdict', 'evidence', 'source', 'run_id', 'ts']) {
    if (!Object.hasOwn(record, field)) errors.push(`BOARD_FIELD ${id} ${field}`);
  }
  const traceabilityV2 = record.traceabilityVersion === SOURCE_TRACEABILITY_VERSION;
  const traceabilityDeclared = Object.hasOwn(record, 'traceabilityVersion') || Object.hasOwn(record, 'sourceRefs');
  const allowedFields = traceabilityV2 ? [...BOARD_FIELDS, ...BOARD_SOURCE_FIELDS] : BOARD_FIELDS;
  const schemaFields = traceabilityV2 ? BOARD_SCHEMA_V2_FIELDS : BOARD_SCHEMA_FIELDS;
  for (const key of Object.keys(record)) if (!allowedFields.includes(key) || !schemaFields.includes(key)) errors.push(`BOARD_UNKNOWN_FIELD ${id} ${key}`);
  if (traceabilityDeclared && !traceabilityV2) errors.push(`BOARD_TRACEABILITY_VERSION ${id}`);
  if (traceabilityV2) {
    if (!Object.hasOwn(record, 'sourceRefs')) errors.push(`BOARD_FIELD ${id} sourceRefs`);
    else if (!Array.isArray(record.sourceRefs) || record.sourceRefs.length === 0
      || record.sourceRefs.some((sourceRef) => !isNonEmptyString(sourceRef))) errors.push(`BOARD_TYPE ${id} sourceRefs`);
    else if (new Set(record.sourceRefs).size !== record.sourceRefs.length) errors.push(`BOARD_SOURCE_REF_DUPLICATE ${id}`);
  }
  for (const field of ['case_id', 'lane', 'run_id', 'ts']) {
    if (Object.hasOwn(record, field) && !isNonEmptyString(record[field])) errors.push(`BOARD_TYPE ${id} ${field}`);
  }
  if (Object.hasOwn(record, 'task_base') && !/^[a-f0-9]{40}$/.test(record.task_base)) errors.push(`BOARD_TYPE ${id} task_base`);
  if (Object.hasOwn(record, 'source_revision') && !isNonEmptyString(record.source_revision)) errors.push(`BOARD_TYPE ${id} source_revision`);
  if (Object.hasOwn(record, 'verification_lane') && !['code', 'gui', 'machine', 'multi'].includes(record.verification_lane)) errors.push(`BOARD_TYPE ${id} verification_lane`);
  if (Object.hasOwn(record, 'contract_sha256') && !/^[a-f0-9]{64}$/.test(record.contract_sha256)) errors.push(`BOARD_TYPE ${id} contract_sha256`);
  if (Object.hasOwn(record, 'exact_final_sha') && !/^[a-f0-9]{40}$/.test(record.exact_final_sha)) errors.push(`BOARD_TYPE ${id} exact_final_sha`);
  if (Object.hasOwn(record, 'verdict') && !BOARD_SCHEMA_VERDICTS.includes(record.verdict)) {
    errors.push(`BOARD_TYPE ${id} verdict`);
  }
  if (Object.hasOwn(record, 'source') && !['qa-gui', 'qa-code', 'script'].includes(record.source)) {
    errors.push(`BOARD_TYPE ${id} source`);
  }
  if (Object.hasOwn(record, 'ts') && Number.isNaN(Date.parse(record.ts))) errors.push(`BOARD_TYPE ${id} ts`);
  if (Object.hasOwn(record, 'evidence') && (!Array.isArray(record.evidence)
    || record.evidence.some((item) => !isNonEmptyString(item)))) errors.push(`BOARD_TYPE ${id} evidence`);
  if (Object.hasOwn(record, 'reason') && !isNonEmptyString(record.reason)) errors.push(`BOARD_TYPE ${id} reason`);
  if (Object.hasOwn(record, 'target')) errors.push(...(record.target?.kind === 'deployed-build'
    ? deployedTargetShapeErrors(record.target, `BOARD_TYPE ${id}`)
    : targetShapeErrors(record.target, `BOARD_TYPE ${id}`)));
  if (Object.hasOwn(record, 'target_kind') && record.target_kind !== 'deployed-build') errors.push(`BOARD_TYPE ${id} target_kind`);
  if (Object.hasOwn(record, 'target_binding_sha256') && !/^[a-f0-9]{64}$/.test(record.target_binding_sha256)) errors.push(`BOARD_TYPE ${id} target_binding_sha256`);
  if (Object.hasOwn(record, 'child_verdict')) {
    errors.push(...childVerdictShapeErrors(record.child_verdict, `BOARD_TYPE ${id}`));
  }
  errors.push(...dualVerdictShapeErrors(record, `BOARD_TYPE ${id}`));
  errors.push(...failureClassShapeErrors(record, `BOARD_TYPE ${id}`));
  errors.push(...attemptShapeErrors(record, `BOARD_TYPE ${id}`));
  if (['ungraded', 'blocked'].includes(record.verdict) && !isNonEmptyString(record.reason)) {
    errors.push(`BOARD_FIELD ${id} reason`);
  }
  return errors;
}

export function loadBoard(path) {
  const text = readText(path, { label: basename(path) });
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) fail(2, 'BOARD_EMPTY', basename(path));
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(2, 'BOARD_JSON_INVALID', `line=${index + 1}`);
    }
  });
  const errors = records.flatMap((record, index) => boardRecordErrors(record, index + 1));
  const historyIssue = attemptHistoryIssue(records);
  if (historyIssue) errors.push(historyIssue);
  return { text, records, errors, path };
}

// Declaring a path that opens is not yet evidence: a 0-byte artifact or
// one with only whitespace proves nothing. A graded verdict that relies on
// such an empty artifact must be downgraded to ungraded instead of being accepted as PASS.
function evidenceContentIssue(raw) {
  if (raw.length === 0) return 'BOARD_EVIDENCE_EMPTY_ARTIFACT';
  if (raw.toString('utf8').trim().length === 0) return 'BOARD_EVIDENCE_EMPTY_ARTIFACT';
  return null;
}

export function evidenceIssue(record, boardPath) {
  const graded = record.verdict === 'pass' || record.verdict === 'fail';
  if (graded && record.evidence.length === 0) {
    return 'BOARD_EVIDENCE_EMPTY';
  }
  for (const evidence of record.evidence) {
    const path = resolve(dirname(boardPath), evidence);
    let raw;
    try {
      accessSync(path, constants.R_OK);
      raw = readFileSync(path);
    } catch {
      return 'BOARD_EVIDENCE_UNREADABLE';
    }
    // An ungraded verdict has no content binding: ungraded/blocked may
    // attach an unfinished artifact to explain why it could not be graded.
    if (graded) {
      const issue = evidenceContentIssue(raw);
      if (issue) return issue;
    }
  }
  return null;
}

export function parseReport(path) {
  const text = readText(path, { label: basename(path) });
  const value = parseMarkedJson(text, REPORT_START, REPORT_END, 'REPORT');
  requireObject(value, 'REPORT_TYPE', 'root');
  const sourceVersion = value.reportSchemaVersion === 2;
  if (Object.hasOwn(value, 'reportSchemaVersion') && !sourceVersion) fail(2, 'REPORT_SCHEMA_VERSION', String(value.reportSchemaVersion));
  const reportFields = [
    ...(sourceVersion ? ['reportSchemaVersion', 'traceabilityVersion', 'sourceTraceability'] : []), ...COVERAGE_REPORT_FIELDS,
    'run_id', 'task_base', 'source_revision', 'verification_lane', 'contract_sha256', 'exact_final_sha',
    'target', 'decision', 'metrics', 'reasons', 'waived_p1', ...REPORT_INTEGRITY_FIELDS, 'board_delivery', 'board_conformance',
    // R2a: the adjudicator's results next to the real verdicts (shadow) or as applied (enforce).
    'adjudication',
  ];
  rejectUnknownFields(value, reportFields, 'REPORT_UNKNOWN_FIELD');
  if (Object.hasOwn(value, 'adjudication') && value.adjudication?.schema !== 'team-qa/adjudication-report/v1') fail(2, 'REPORT_ADJUDICATION_SCHEMA', String(value.adjudication?.schema ?? ''));
  if (sourceVersion) {
    if (value.traceabilityVersion !== SOURCE_TRACEABILITY_VERSION) fail(2, 'REPORT_TRACEABILITY_VERSION', String(value.traceabilityVersion ?? ''));
    requireObject(value.sourceTraceability, 'REPORT_TRACEABILITY_TYPE', 'sourceTraceability');
    rejectUnknownFields(value.sourceTraceability, ['sourceItems', 'rows'], 'REPORT_TRACEABILITY_UNKNOWN_FIELD', 'sourceTraceability');
    const registryErrors = sourceRegistryErrors(value.sourceTraceability.sourceItems, 'sourceTraceability.sourceItems');
    if (registryErrors.length > 0) {
      const [code, ...detail] = registryErrors[0].split(' ');
      fail(2, code, detail.join(' '));
    }
    if (!Array.isArray(value.sourceTraceability.rows)) fail(2, 'REPORT_TRACEABILITY_TYPE', 'rows');
    const sources = new Map(value.sourceTraceability.sourceItems.map((item) => [item.id, item]));
    const rowFields = ['sourceRef', 'sourceSystem', 'externalKey', 'sourceTitle', 'caseId', 'requirement', 'priority', 'verdict', 'evidence'];
    const edges = new Set();
    value.sourceTraceability.rows.forEach((row, index) => {
      const where = `sourceTraceability.rows[${index}]`;
      requireObject(row, 'REPORT_TRACEABILITY_TYPE', where);
      rejectUnknownFields(row, rowFields, 'REPORT_TRACEABILITY_UNKNOWN_FIELD', where);
      for (const field of rowFields) if (!Object.hasOwn(row, field)) fail(2, 'REPORT_TRACEABILITY_FIELD', `${where}.${field}`);
      const source = sources.get(row.sourceRef);
      if (!source) fail(2, 'REPORT_SOURCE_REF_UNKNOWN', `${where}:${String(row.sourceRef ?? '')}`);
      if (row.sourceSystem !== source.sourceSystem || row.externalKey !== source.externalKey || row.sourceTitle !== source.title) {
        fail(2, 'REPORT_SOURCE_METADATA_MISMATCH', where);
      }
      if (!(row.caseId === null || isNonEmptyString(row.caseId))) fail(2, 'REPORT_TRACEABILITY_TYPE', `${where}.caseId`);
      if (!(row.requirement === null || isNonEmptyString(row.requirement))) fail(2, 'REPORT_TRACEABILITY_TYPE', `${where}.requirement`);
      if (!(row.priority === null || ['P0', 'P1', 'P2'].includes(row.priority))) fail(2, 'REPORT_TRACEABILITY_TYPE', `${where}.priority`);
      if (!['PENDING', 'PASS', 'FAIL', 'UNGRADED', 'BLOCKED', 'UNUSED'].includes(row.verdict)) fail(2, 'REPORT_TRACEABILITY_TYPE', `${where}.verdict`);
      if (!Array.isArray(row.evidence) || row.evidence.some((item) => !isNonEmptyString(item))) fail(2, 'REPORT_TRACEABILITY_TYPE', `${where}.evidence`);
      if (row.caseId !== null) {
        const edge = `${row.sourceRef}\u0000${row.caseId}`;
        if (edges.has(edge)) fail(2, 'REPORT_SOURCE_EDGE_DUPLICATE', `${row.sourceRef}:${row.caseId}`);
        edges.add(edge);
      }
    });
  }
  if (!value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) fail(2, 'REPORT_TYPE', 'metrics');
  const metricFields = ['coverage_high_pct', 'coverage_low_pct', 'defects', 'pass', 'fail', 'ungraded', ...FAILURE_METRIC_FIELDS];
  rejectUnknownFields(value.metrics, metricFields, 'REPORT_UNKNOWN_FIELD', 'metrics');
  if (value.metrics.defects) rejectUnknownFields(value.metrics.defects, ['p0', 'p1', 'p2'], 'REPORT_UNKNOWN_FIELD', 'metrics.defects');
  // R1b: the cell coverage block of a run whose tracked plan has the coverage block (lib/coverage-cells.mjs).
  if (Object.hasOwn(value, 'coverage_cells')) {
    const coverageErrors = coverageReportErrors(value.coverage_cells);
    if (coverageErrors.length > 0) {
      const [code, ...detail] = coverageErrors[0].split(' ');
      fail(2, code, detail.join(' '));
    }
  }
  // A report read back must still have its traceability intact: every reason has an origin,
  // every checker declares how much it inspected, every child gate is present.
  const integrity = reportIntegrityErrors(value);
  if (integrity.length > 0) {
    const [code, ...detail] = integrity[0].split(' ');
    fail(2, code, detail.join(' '));
  }
  return { text, value, path };
}

export const markers = { PLAN_START, PLAN_END, REPORT_START, REPORT_END };
