// The Coverage Gate by cell (upgrade R1b). Contract: references/coverage-cells.md.
//
// A cell is route x state x action x viewport row x environment condition. The denominator is the union of
//   - the source registry: the cells each case of tracked plan v2 declares (route x states x actions x the rows of its
//     viewports x conditions), traced to the sources the case names;
//   - the app map (QA GUI qa-gui/app-map/v2, runs/<run_id>/app-map.json): the states the exploration saw and the
//     branches it did not take (its frontier, each with a NOT_EXPLORED code);
//   - the static routes the tracked plan lists;
//   - the state family (empty, loading, error, one-row, many-rows) of each screen with data it lists.
// A cell is counted only when a state receipt backs it. Team QA reads the receipts QA GUI's gate checked (in a board
// record's evidence, directly or through the evidence manifest of a QA GUI gate receipt, hash for hash); it never
// grades a cell: a cell's verdict is the state receipt's, held to the record's own verdict.
// The vocabulary is QA GUI's (scripts/lib/coverage-cell.mjs there); this file only reads it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, isAbsolute } from 'node:path';
import { groundedIssue } from './report-integrity.mjs';
import { CELL_STATES } from './coverage-matrix.mjs';

export const COVERAGE_CELLS_VERSION = 'team-qa/coverage-cells/v1';
export const COVERAGE_MAP_SCHEMA = 'team-qa/coverage-map/v1';
export const COVERAGE_MAP_FILE = 'coverage-map.json';
export const APP_MAP_FILE = 'app-map.json';
export const APP_MAP_SCHEMA = 'qa-gui/app-map/v2';
const CELL_VERSION = 'qa-gui/coverage-cell/v1';
const STATE_RECEIPT = 'qa-gui/state-receipt/v1';
const GATE_RECEIPTS = ['qa-gui/receipt/v1', 'qa-gui/receipt/v2', 'qa-gui/receipt/web-v1'];
const PROBE_CELLS = 'qa-gui/probe-cells/v1';

export const NOT_EXPLORED_CODES = Object.freeze(['BUDGET', 'AUTH', 'NEEDS_APPROVAL', 'NO_DATA', 'UNREACHABLE', 'HOVER_ONLY', 'OBSCURED', 'TOOL_LIMIT']);
export const STOP_REASONS = Object.freeze(['FRONTIER_EMPTY', 'BUDGET_EXHAUSTED', 'BLOCKED']);
export const DATA_STATE_FAMILY = Object.freeze(['empty', 'loading', 'error', 'one-row', 'many-rows']);
export const CELL_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNGRADED', 'NOT_EXPLORED', 'N/A']);
const CONDITION_KINDS = ['network', 'request', 'cpu', 'timezone', 'locale', 'media'];
const VIEWPORT_CLASSES = ['mobile', 'tablet', 'desktop'];
const ANY = '*';
const DEFAULT_STATE = 'ideal';
const DEFAULT_ACTION = 'view';
const DEFAULT_CONDITION = 'default';

const ROUTE = /^[^\s|][^|]{0,511}$/;
const ACTION = /^[^\s|][^|]{0,255}$/;
const STATE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ROW_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SIZE = /^\d+x\d+$/;
const CONDITION_VALUE = /^[^\s=+|]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const unique = (values) => new Set(values).size === values.length;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const zeroCodes = () => Object.fromEntries(NOT_EXPLORED_CODES.map((code) => [code, 0]));

// `default`, `*`, or sorted `kind=value` pairs joined by `+` (QA GUI's canonical condition key).
export function isConditionKey(value) {
  if (value === DEFAULT_CONDITION || value === ANY) return true;
  if (typeof value !== 'string' || !value) return false;
  const kinds = [];
  for (const part of value.split('+')) {
    const at = part.indexOf('=');
    if (at <= 0) return false;
    const kind = part.slice(0, at);
    if (!CONDITION_KINDS.includes(kind) || !CONDITION_VALUE.test(part.slice(at + 1))) return false;
    if (kinds.length && kinds.at(-1) >= kind) return false;
    kinds.push(kind);
  }
  return true;
}

function conditionKey(conditions) {
  if (!isObject(conditions)) return DEFAULT_CONDITION;
  const entries = Object.entries(conditions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? DEFAULT_CONDITION : entries.map(([kind, value]) => `${kind}=${value}`).join('+');
}

function routeList(value) {
  return Array.isArray(value) && value.every((route) => typeof route === 'string' && ROUTE.test(route)) && unique(value);
}

// ---- tracked plan v2: the coverage block and a case's cell fields ----

// The tracked plan's `coverage` block: {version, rows: [{id, size, classes}], staticRoutes?, dataScreens?}.
export function trackedCoverageErrors(block) {
  if (!isObject(block)) return ['CASE_COVERAGE_TYPE coverage'];
  const errors = [];
  for (const key of Object.keys(block)) if (!['version', 'rows', 'staticRoutes', 'dataScreens'].includes(key)) errors.push(`CASE_COVERAGE_UNKNOWN_FIELD ${key}`);
  if (block.version !== COVERAGE_CELLS_VERSION) errors.push(`CASE_COVERAGE_VERSION ${String(block.version)}`);
  if (!Array.isArray(block.rows) || block.rows.length === 0) errors.push('CASE_COVERAGE_TYPE rows');
  else {
    const ids = new Set();
    block.rows.forEach((row, index) => {
      const where = `rows[${index}]`;
      if (!isObject(row)) { errors.push(`CASE_COVERAGE_TYPE ${where}`); return; }
      for (const key of Object.keys(row)) if (!['id', 'size', 'classes'].includes(key)) errors.push(`CASE_COVERAGE_UNKNOWN_FIELD ${where}.${key}`);
      if (!(typeof row.id === 'string' && ROW_ID.test(row.id))) errors.push(`CASE_COVERAGE_TYPE ${where}.id`);
      else if (ids.has(row.id)) errors.push(`CASE_COVERAGE_DUPLICATE ${where}.id`);
      else ids.add(row.id);
      if (!(typeof row.size === 'string' && SIZE.test(row.size))) errors.push(`CASE_COVERAGE_TYPE ${where}.size`);
      if (!Array.isArray(row.classes) || row.classes.length === 0 || !unique(row.classes)
        || row.classes.some((item) => !VIEWPORT_CLASSES.includes(item))) errors.push(`CASE_COVERAGE_TYPE ${where}.classes`);
    });
  }
  for (const field of ['staticRoutes', 'dataScreens']) {
    if (Object.hasOwn(block, field) && !routeList(block[field])) errors.push(`CASE_COVERAGE_TYPE ${field}`);
  }
  return errors;
}

// A case's cell fields under the coverage block: `route` makes it a cell case; `actions` and `conditions` are optional.
export function caseCellErrors(item, block, id) {
  const errors = [];
  const hasRoute = Object.hasOwn(item, 'route');
  if (hasRoute && !(typeof item.route === 'string' && ROUTE.test(item.route))) errors.push(`CASE_TYPE ${id} route`);
  if (!hasRoute && (Object.hasOwn(item, 'actions') || Object.hasOwn(item, 'conditions'))) errors.push(`CASE_FIELD ${id} route`);
  if (Object.hasOwn(item, 'actions') && !(Array.isArray(item.actions) && item.actions.length > 0 && unique(item.actions)
    && item.actions.every((action) => typeof action === 'string' && ACTION.test(action)))) errors.push(`CASE_TYPE ${id} actions`);
  if (Object.hasOwn(item, 'conditions') && !(Array.isArray(item.conditions) && item.conditions.length > 0 && unique(item.conditions)
    && item.conditions.every(isConditionKey))) errors.push(`CASE_TYPE ${id} conditions`);
  if (hasRoute) {
    for (const field of ['states', 'viewports']) if (!Object.hasOwn(item, field)) errors.push(`CASE_FIELD ${id} ${field}`);
    const rows = Array.isArray(block?.rows) ? block.rows.filter(isObject) : [];
    for (const viewport of Array.isArray(item.viewports) ? item.viewports : []) {
      if (!rows.some((row) => Array.isArray(row.classes) && row.classes.includes(viewport))) errors.push(`CASE_COVERAGE_ROW ${id} ${viewport}`);
    }
  }
  return errors;
}

// ---- the signed test plan: the N/A cells ----

// `coverage: {version, na?: [{route, state?, action?, viewport?, condition?, reason}], destructive?: [{route, action,
// reason}]}`: an N/A cell and an approved destructive action (R1e) each need a reason, and the plan that holds them is
// the one the owner signs.
export function planCoverageErrors(block) {
  if (!isObject(block)) return ['PLAN_TYPE coverage'];
  const errors = [];
  for (const key of Object.keys(block)) if (!['version', 'na', 'destructive'].includes(key)) errors.push(`PLAN_UNKNOWN_FIELD coverage.${key}`);
  if (block.version !== COVERAGE_CELLS_VERSION) errors.push('PLAN_TYPE coverage.version');
  if (Object.hasOwn(block, 'destructive')) {
    if (!Array.isArray(block.destructive)) errors.push('PLAN_TYPE coverage.destructive');
    else block.destructive.forEach((entry, index) => {
      const where = `coverage.destructive[${index}]`;
      if (!isObject(entry)) { errors.push(`PLAN_TYPE ${where}`); return; }
      for (const key of Object.keys(entry)) if (!['route', 'action', 'reason'].includes(key)) errors.push(`PLAN_UNKNOWN_FIELD ${where}.${key}`);
      if (!(typeof entry.route === 'string' && ROUTE.test(entry.route))) errors.push(`PLAN_TYPE ${where}.route`);
      if (!(typeof entry.action === 'string' && ACTION.test(entry.action))) errors.push(`PLAN_TYPE ${where}.action`);
      if (!nonBlank(entry.reason)) errors.push(`PLAN_TYPE ${where}.reason`);
    });
  }
  if (!Object.hasOwn(block, 'na')) return errors;
  if (!Array.isArray(block.na)) { errors.push('PLAN_TYPE coverage.na'); return errors; }
  block.na.forEach((entry, index) => {
    const where = `coverage.na[${index}]`;
    if (!isObject(entry)) { errors.push(`PLAN_TYPE ${where}`); return; }
    for (const key of Object.keys(entry)) if (!['route', 'state', 'action', 'viewport', 'condition', 'reason'].includes(key)) errors.push(`PLAN_UNKNOWN_FIELD ${where}.${key}`);
    if (!(typeof entry.route === 'string' && ROUTE.test(entry.route))) errors.push(`PLAN_TYPE ${where}.route`);
    if (Object.hasOwn(entry, 'state') && !(typeof entry.state === 'string' && STATE_LABEL.test(entry.state))) errors.push(`PLAN_TYPE ${where}.state`);
    if (Object.hasOwn(entry, 'action') && !(typeof entry.action === 'string' && ACTION.test(entry.action))) errors.push(`PLAN_TYPE ${where}.action`);
    if (Object.hasOwn(entry, 'viewport') && !(typeof entry.viewport === 'string' && ROW_ID.test(entry.viewport))) errors.push(`PLAN_TYPE ${where}.viewport`);
    if (Object.hasOwn(entry, 'condition') && !(isConditionKey(entry.condition) && entry.condition !== ANY)) errors.push(`PLAN_TYPE ${where}.condition`);
    if (!nonBlank(entry.reason)) errors.push(`PLAN_TYPE ${where}.reason`);
  });
  return errors;
}

// ---- the state receipts behind a board record ----

function insideDir(dir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const absolute = resolve(dir, rel);
  const back = relative(dir, absolute);
  return back && !back.startsWith('..') && !isAbsolute(back) ? absolute : null;
}

function readJson(path, read) {
  try { return { text: read(path, 'utf8') }; } catch { return null; }
}

// The QA GUI state receipts a record carries for its own case: listed in its evidence, or named by the evidence
// manifest of a QA GUI gate receipt in its evidence (and then only with the SHA-256 that manifest recorded).
export function recordStateReceipts(record, boardDir, read = readFileSync) {
  const found = new Map();
  const problems = [];
  const consider = (rel, text) => {
    let json; try { json = JSON.parse(text); } catch { return null; }
    if (json?.schema === STATE_RECEIPT && json.caseId === record.case_id && !found.has(rel)) found.set(rel, json);
    return json;
  };
  for (const rel of Array.isArray(record?.evidence) ? record.evidence : []) {
    const path = insideDir(boardDir, rel);
    const file = path && readJson(path, read);
    if (!file) continue;
    const json = consider(rel, file.text);
    if (!GATE_RECEIPTS.includes(json?.schema) || !Array.isArray(json.evidence_manifest)) continue;
    for (const entry of json.evidence_manifest) {
      if (!isObject(entry) || typeof entry.path !== 'string' || !entry.path.endsWith('.json')) continue;
      if (entry.evidence_type !== undefined && entry.evidence_type !== 'machine-receipt') continue;
      if (entry.metadata?.case_id !== undefined && entry.metadata.case_id !== record.case_id) continue;
      const target = insideDir(boardDir, entry.path);
      const named = target && readJson(target, read);
      if (!named) continue;
      if (!SHA256.test(String(entry.sha256 ?? '').toLowerCase()) || sha256(named.text) !== String(entry.sha256).toLowerCase()) {
        problems.push(`RECEIPT_HASH_MISMATCH ${entry.path}`);
        continue;
      }
      consider(entry.path, named.text);
    }
  }
  return { receipts: [...found].map(([path, receipt]) => ({ path, receipt })), problems };
}

// The cell a state receipt backs. With a `cell` (qa-gui/coverage-cell/v1) its own coordinates; without one, the case's
// route, the receipt's state, `view`, the plan row of the receipt's measured size and the default condition.
function receiptCell(receipt, item, rowBySize) {
  if (Object.hasOwn(receipt, 'cell') && !(isObject(receipt.cell) && receipt.cell.version === CELL_VERSION)) return null;
  const cell = isObject(receipt.cell) ? receipt.cell : null;
  const route = cell ? cell.route : item?.route;
  if (typeof route !== 'string' || !route) return null;
  return {
    route,
    state: cell && typeof cell.state === 'string' ? cell.state : receipt.state,
    action: cell ? cell.action : DEFAULT_ACTION,
    viewport: cell ? cell.viewport : rowBySize.get(receipt.viewport) ?? 'unknown',
    condition: cell ? conditionKey(cell.conditions) : DEFAULT_CONDITION,
    strict: typeof receipt.domHash === 'string' ? receipt.domHash : null,
  };
}

// R1e: the sealed per-cell result QA GUI's gate enforces for a probe a state receipt names
// (`probes[].cells: {path, sha256}`, qa-gui/probe-cells/v1). Read hash for hash: the probe file and the cells file must
// both match the state receipt's references, and the cells file must name that probe, case and state. A file that does
// not is listed UNGRADED with no receipt; a missing one backs nothing. Team QA never grades these cells.
function probeCellsOf(probe, record, receipt, boardDir, read) {
  const ref = probe?.cells;
  const path = insideDir(boardDir, ref?.path);
  const file = path && readJson(path, read);
  if (!file) return { cells: [], trusted: false, path: ref?.path ?? null, problem: `PROBE_CELLS_MISSING ${String(ref?.path)}` };
  let value = null;
  try { value = JSON.parse(file.text); } catch {}
  const cells = Array.isArray(value?.cells) ? value.cells.filter((cell) => isObject(cell) && typeof cell.route === 'string' && typeof cell.state === 'string'
    && typeof cell.action === 'string' && typeof cell.viewport === 'string' && typeof cell.condition === 'string') : [];
  const probePath = insideDir(boardDir, probe?.path);
  const probeFile = probePath && readJson(probePath, read);
  if (sha256(file.text) !== String(ref.sha256 ?? '').toLowerCase()) return { cells, trusted: false, path: ref.path, problem: `PROBE_CELLS_HASH_MISMATCH ${ref.path}` };
  if (!probeFile || sha256(probeFile.text) !== String(probe.sha256 ?? '').toLowerCase()) return { cells, trusted: false, path: ref.path, problem: `PROBE_HASH_MISMATCH ${String(probe?.path)}` };
  if (value?.schema !== PROBE_CELLS || value.case !== record.case_id || value.state !== receipt.state || value.probe_sha256 !== probe.sha256) {
    return { cells, trusted: false, path: ref.path, problem: `PROBE_CELLS_MISMATCH ${ref.path}` };
  }
  return { cells, trusted: true, path: ref.path, problem: null };
}

function receiptVerdict(receipt) {
  const parts = [receipt?.function?.verdict, receipt?.ui?.verdict];
  if (parts.includes('FAIL')) return 'FAIL';
  return parts.every((part) => part === 'PASS') ? 'PASS' : 'UNGRADED';
}

// ---- the app map ----

function readAppMap(appMap) {
  if (appMap === null || appMap === undefined) return { present: false, valid: false, states: [], frontier: [], stop: null, skipped: 0 };
  const valid = isObject(appMap) && appMap.schema === APP_MAP_SCHEMA && Array.isArray(appMap.states) && Array.isArray(appMap.frontier)
    && isObject(appMap.stop) && STOP_REASONS.includes(appMap.stop.reason);
  if (!valid) return { present: true, valid: false, states: [], frontier: [], stop: null, skipped: 0 };
  let skipped = 0;
  const axes = (entry) => typeof entry?.route === 'string' && ROUTE.test(entry.route) && typeof entry.state === 'string'
    && typeof entry.viewport === 'string' && typeof entry.condition === 'string';
  const states = appMap.states.filter((entry) => (axes(entry) ? true : (skipped += 1, false)));
  const frontier = appMap.frontier.filter((entry) => (axes(entry) && typeof entry.action === 'string' && NOT_EXPLORED_CODES.includes(entry.reason)
    ? true : (skipped += 1, false)));
  const code = NOT_EXPLORED_CODES.includes(appMap.stop.code) ? appMap.stop.code : null;
  return {
    present: true, valid: true, states, frontier, skipped,
    stop: { reason: appMap.stop.reason, code, detail: typeof appMap.stop.detail === 'string' ? appMap.stop.detail : null },
  };
}

function saturationOf(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const n = keys.length;
  const f1 = [...counts.values()].filter((count) => count === 1).length;
  return { n, f1, distinct: counts.size, u: n === 0 ? null : f1 / n };
}

// ---- the coverage map ----

const keyOf = ({ route, state, action, viewport, condition }) => [route, state, action, viewport, condition].join('|');
const wild = (a, b) => a === ANY || b === ANY || a === b;
const sameCell = (a, b) => a.route === b.route && a.state === b.state && a.action === b.action && wild(a.viewport, b.viewport) && wild(a.condition, b.condition);
// A receipt is concrete; only the cell side may be "any".
const backs = (cell, rc) => cell.route === rc.route && cell.state === rc.state && cell.action === rc.action
  && (cell.viewport === ANY || cell.viewport === rc.viewport) && (cell.condition === ANY || cell.condition === rc.condition);

function tally(statuses) {
  const counts = { PASS: 0, FAIL: 0, UNGRADED: 0, NOT_EXPLORED: 0, NA: 0 };
  for (const status of statuses) counts[status === 'N/A' ? 'NA' : status] += 1;
  return counts;
}

/**
 * Builds the coverage map of one run.
 * @returns {{map: object, summary: object, issues: object[], ungradedCases: string[], cellCases: number}}
 *   `summary` is the report's `coverage_cells` without `map`/`map_sha256` (the caller adds them from the written map);
 *   `issues` are grounded issues of the `coverage-cells` checker: one per case whose record is graded while a cell it
 *   declares has no graded state receipt of its own; those cases are listed in `ungradedCases` and do not count.
 */
export function buildCoverageMap({ tracked, planCoverage = null, appMap = null, appMapSha256 = null, records = [], boardDir, read = readFileSync }) {
  const block = tracked.coverage;
  const rows = block.rows;
  const rowIds = rows.map((row) => row.id);
  const rowBySize = new Map();
  for (const row of rows) if (!rowBySize.has(row.size)) rowBySize.set(row.size, row.id);
  const staticRoutes = Array.isArray(block.staticRoutes) ? block.staticRoutes : [];
  const dataScreens = Array.isArray(block.dataScreens) ? block.dataScreens : [];
  const cells = [];
  const place = (axes, origins) => {
    let hits = cells.filter((cell) => sameCell(cell, axes));
    if (hits.length === 0) {
      const cell = { key: keyOf(axes), ...axes, status: null, reason: null, origins: [], cases: [], receipts: [], strict: [], frontier: [], observed: false };
      cells.push(cell);
      hits = [cell];
    }
    for (const cell of hits) for (const origin of origins) if (!cell.origins.includes(origin)) cell.origins.push(origin);
    return hits;
  };
  const addStrict = (cell, key) => { if (key && !cell.strict.includes(key)) cell.strict.push(key); };

  // 1. The source registry: what each case declares, traced to its sources.
  const declared = new Map();
  const cellCases = tracked.cases.filter((item) => typeof item.route === 'string');
  for (const item of cellCases) {
    const caseRows = rowIds.filter((id) => rows.find((row) => row.id === id).classes.some((cls) => item.viewports.includes(cls)));
    const own = [];
    for (const state of item.states) for (const action of item.actions ?? [DEFAULT_ACTION]) for (const viewport of caseRows) {
      for (const condition of item.conditions ?? [ANY]) {
        const axes = { route: item.route, state, action, viewport, condition };
        own.push(axes);
        for (const cell of place(axes, item.sourceRefs.map((ref) => `source:${ref}`))) if (!cell.cases.includes(item.id)) cell.cases.push(item.id);
      }
    }
    declared.set(item.id, own);
  }
  // 2. Static routes, 3. the state family of each screen with data.
  for (const route of staticRoutes) {
    if (dataScreens.includes(route)) continue;
    for (const viewport of rowIds) place({ route, state: DEFAULT_STATE, action: DEFAULT_ACTION, viewport, condition: ANY }, ['static-route']);
  }
  for (const route of dataScreens) {
    for (const state of DATA_STATE_FAMILY) for (const viewport of rowIds) {
      place({ route, state, action: DEFAULT_ACTION, viewport, condition: ANY }, ['state-family', ...(staticRoutes.includes(route) ? ['static-route'] : [])]);
    }
  }
  // 4. The app map: the states the exploration saw, then the branches it left, each with its code.
  const explored = readAppMap(appMap);
  for (const seen of explored.states) {
    for (const cell of place({ route: seen.route, state: seen.state, action: DEFAULT_ACTION, viewport: seen.viewport, condition: seen.condition }, ['app-map:node'])) {
      cell.observed = true;
      addStrict(cell, seen.strict);
    }
  }
  const leadsTo = new Map();
  for (const entry of explored.frontier) {
    for (const cell of place({ route: entry.route, state: entry.state, action: entry.action, viewport: entry.viewport, condition: entry.condition }, ['app-map:frontier'])) {
      cell.frontier.push({ id: String(entry.id ?? ''), reason: entry.reason });
      addStrict(cell, entry.strict);
    }
    if (typeof entry.leadsTo === 'string' && !leadsTo.has(entry.leadsTo)) leadsTo.set(entry.leadsTo, entry.reason);
  }
  // 5. The receipts: a record's own state receipts, held to the record's verdict.
  const byCase = new Map(tracked.cases.map((item) => [item.id, item]));
  const recordByCase = new Map(records.map((record) => [record.case_id, record]));
  const ownReceipts = new Map();
  const receiptProblems = [];
  for (const record of records) {
    if (record?.source !== 'qa-gui') continue;
    const graded = ['pass', 'fail'].includes(record.verdict);
    const { receipts, problems } = recordStateReceipts(record, boardDir, read);
    receiptProblems.push(...problems.map((problem) => `${record.case_id} ${problem}`));
    for (const { path, receipt } of receipts) {
      const rc = receiptCell(receipt, byCase.get(record.case_id), rowBySize);
      if (!rc) continue;
      const verdict = graded ? receiptVerdict(receipt) : 'UNGRADED';
      let hits = cells.filter((cell) => backs(cell, rc));
      if (hits.length === 0) hits = place({ route: rc.route, state: rc.state, action: rc.action, viewport: rc.viewport, condition: rc.condition }, []);
      for (const cell of hits) {
        if (!cell.origins.includes('receipt')) cell.origins.push('receipt');
        cell.receipts.push({ case_id: record.case_id, path, verdict, strict: rc.strict });
        addStrict(cell, rc.strict);
      }
      if (!ownReceipts.has(record.case_id)) ownReceipts.set(record.case_id, []);
      ownReceipts.get(record.case_id).push({ rc, verdict });
      // R1e: the cells of the probes this state receipt names, as QA GUI's sealed result gives them.
      for (const probe of Array.isArray(receipt.probes) ? receipt.probes : []) {
        if (!isObject(probe) || probe.cells === undefined) continue;
        const found = probeCellsOf(probe, record, receipt, boardDir, read);
        if (found.problem) receiptProblems.push(`${record.case_id} ${found.problem}`);
        for (const cell of found.cells) {
          const pc = { route: cell.route, state: cell.state, action: cell.action, viewport: cell.viewport, condition: cell.condition, strict: null };
          const status = !found.trusted || !graded ? 'UNGRADED' : ['PASS', 'FAIL'].includes(cell.status) ? cell.status : 'UNGRADED';
          const reason = !found.trusted ? 'NO_RECEIPT' : !graded ? 'RECORD_UNGRADED' : status === 'UNGRADED' ? (typeof cell.reason === 'string' ? cell.reason : 'RECEIPT_UNGRADED') : null;
          let into = cells.filter((entry) => backs(entry, pc));
          if (into.length === 0) into = place(pc, []);
          for (const entry of into) {
            if (!entry.origins.includes('probe')) entry.origins.push('probe');
            entry.receipts.push({ case_id: record.case_id, path: found.path, verdict: status, strict: null, kind: 'probe', ...(reason ? { reason } : {}) });
          }
          ownReceipts.get(record.case_id).push({ rc: pc, verdict: status });
        }
      }
    }
  }

  // Status of each cell: a receipt > N/A signed in the plan > run without a receipt > not run, with its code.
  const stop = explored.valid ? explored.stop
    : { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: explored.present ? 'APP_MAP_INVALID' : 'APP_MAP_ABSENT' };
  const implied = stop.reason === 'BUDGET_EXHAUSTED' ? 'BUDGET' : stop.reason === 'BLOCKED' ? (stop.code ?? 'TOOL_LIMIT') : 'UNREACHABLE';
  const na = Array.isArray(planCoverage?.na) ? planCoverage.na : [];
  // (planCoverage.destructive is for the explorer's policy, explorationPolicy below.)
  const naFor = (cell) => na.find((entry) => entry.route === cell.route
    && ['state', 'action', 'viewport', 'condition'].every((axis) => entry[axis] === undefined || entry[axis] === cell[axis]));
  for (const cell of cells) {
    const graded = cell.receipts.map((entry) => entry.verdict).filter((verdict) => verdict === 'PASS' || verdict === 'FAIL');
    const signed = naFor(cell);
    if (cell.receipts.length) {
      cell.status = graded.includes('FAIL') ? 'FAIL' : graded.includes('PASS') ? 'PASS' : 'UNGRADED';
      cell.reason = cell.status === 'UNGRADED' ? (cell.receipts.find((entry) => typeof entry.reason === 'string')?.reason ?? 'RECEIPT_UNGRADED') : null;
    } else if (signed) {
      cell.status = 'N/A';
      cell.reason = signed.reason;
    } else if (cell.observed || cell.cases.some((id) => recordByCase.has(id))) {
      cell.status = 'UNGRADED';
      cell.reason = 'NO_RECEIPT';
    } else {
      cell.status = 'NOT_EXPLORED';
      cell.reason = cell.frontier[0]?.reason ?? leadsTo.get(cell.route) ?? implied;
    }
  }
  // Strict grouping: each cell splits into the distinct DOM states seen for it (one when none was seen); a split is
  // covered only by a graded receipt with that DOM hash.
  const strictCells = [];
  for (const cell of cells) {
    if (cell.strict.length === 0) { strictCells.push({ key: cell.key, strict: null, status: cell.status }); continue; }
    for (const key of cell.strict) {
      const verdicts = cell.receipts.filter((entry) => entry.strict === key).map((entry) => entry.verdict);
      const status = verdicts.includes('FAIL') ? 'FAIL' : verdicts.includes('PASS') ? 'PASS'
        : ['N/A', 'NOT_EXPLORED'].includes(cell.status) ? cell.status : 'UNGRADED';
      strictCells.push({ key: cell.key, strict: key, status });
    }
  }

  // The case axis check: a graded case whose declared cell has no graded receipt of its own is not counted.
  const issues = [];
  const ungradedCases = [];
  let declaredCount = 0;
  let withOwn = 0;
  for (const item of cellCases) {
    const own = ownReceipts.get(item.id) ?? [];
    const cellsOfCase = declared.get(item.id) ?? [];
    const backed = cellsOfCase.filter((axes) => own.some((entry) => ['PASS', 'FAIL'].includes(entry.verdict) && backs(axes, entry.rc)));
    declaredCount += cellsOfCase.length;
    withOwn += backed.length;
    const record = recordByCase.get(item.id);
    if (record && ['pass', 'fail'].includes(record.verdict) && backed.length < cellsOfCase.length) {
      ungradedCases.push(item.id);
      issues.push(groundedIssue({
        checker: 'coverage-cells', code: 'COVERAGE_CELL_UNGRADED', caseId: item.id, evidence: record.evidence, source: 'board',
        detail: `COVERAGE_CELL_UNGRADED ${item.id} ${cellsOfCase.length - backed.length}/${cellsOfCase.length} declared cell(s) without a state receipt`,
      }));
    }
  }

  const coarse = tally(cells.map((cell) => cell.status));
  const strict = tally(strictCells.map((cell) => cell.status));
  const notExplored = zeroCodes();
  for (const cell of cells) if (cell.status === 'NOT_EXPLORED') notExplored[cell.reason] += 1;
  const byReason = zeroCodes();
  for (const entry of explored.frontier) byReason[entry.reason] += 1;
  const summary = {
    version: COVERAGE_CELLS_VERSION,
    app_map: explored.present ? { present: true, schema: explored.valid ? APP_MAP_SCHEMA : null, sha256: appMapSha256, skipped: explored.skipped } : { present: false },
    coarse: { rule: 'route|state', cells: cells.length, covered: coarse.PASS + coarse.FAIL, ...coarse },
    strict: { rule: 'dom-hash', cells: strictCells.length, covered: strict.PASS + strict.FAIL, ...strict },
    not_explored: notExplored,
    saturation: {
      strict: saturationOf(explored.states.filter((entry) => typeof entry.strict === 'string').map((entry) => entry.strict)),
      coarse: saturationOf(explored.states.map((entry) => `${entry.route}|${entry.state}`)),
    },
    frontier: { candidates: explored.frontier.length, by_reason: byReason },
    stop,
    case_cells: { cases: cellCases.length, declared: declaredCount, with_own_receipt: withOwn, ungraded_cases: ungradedCases },
  };
  const map = {
    schema: COVERAGE_MAP_SCHEMA, version: COVERAGE_CELLS_VERSION,
    cells: cells.map(({ key, route, state, action, viewport, condition, status, reason, origins, cases, receipts, strict: keys, frontier, observed }) => ({
      key, route, state, action, viewport, condition, status, reason, origins, cases, receipts, strict: keys, frontier, observed,
    })),
    strict_cells: strictCells,
    receipt_problems: receiptProblems,
    summary,
  };
  return { map, summary, issues, ungradedCases, cellCases: cellCases.length };
}

// ---- R1e: the exploration policy Team QA hands QA GUI's frontier explorer ----

export const EXPLORATION_POLICY_SCHEMA = 'qa-gui/exploration-policy/v1';
export const EXPLORATION_POLICY_FILE = 'exploration-policy.json';

/**
 * The policy of one run (QA GUI scripts/lib/frontier-explorer.mjs reads it): every cell a cell case declares, tied to
 * its requirement; the cells of the cases that are high risk (FULL tier, or priority P0/P1); and the destructive
 * actions the signed plan approves. Team QA chooses the order; QA GUI explores and grades.
 */
export function explorationPolicy({ tracked, plan, runId }) {
  const cellCases = tracked.cases.filter((item) => typeof item.route === 'string');
  const requirementCells = [];
  const highRisk = [];
  for (const item of cellCases) {
    const risky = plan?.tiers?.[item.req_id] === 'FULL' || ['P0', 'P1'].includes(item.priority);
    for (const state of item.states ?? []) for (const action of item.actions ?? [DEFAULT_ACTION]) {
      requirementCells.push({ route: item.route, state, action, requirement: item.req_id, case: item.id });
      if (risky) highRisk.push({ route: item.route, state, action, case: item.id });
    }
  }
  const approved = Array.isArray(plan?.coverage?.destructive) ? plan.coverage.destructive : [];
  return {
    schema: EXPLORATION_POLICY_SCHEMA, run_id: runId,
    requirementCells, highRisk,
    approvedDestructive: approved.map((entry) => ({ route: entry.route, action: entry.action })),
  };
}

// The coverage map as written beside the report; its SHA-256 is what the report binds.
export function coverageMapText(map) {
  return `${JSON.stringify(map, null, 2)}\n`;
}

// ---- the report block ----

const GROUPING_FIELDS = ['rule', 'cells', 'covered', 'PASS', 'FAIL', 'UNGRADED', 'NOT_EXPLORED', 'NA'];

function exactFields(value, fields, path, errors) {
  if (!isObject(value)) { errors.push(`REPORT_COVERAGE_TYPE ${path}`); return false; }
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`REPORT_COVERAGE_UNKNOWN_FIELD ${path}.${key}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) errors.push(`REPORT_COVERAGE_TYPE ${path}.${key}`);
  return true;
}

function codeCounts(value, path, errors) {
  if (exactFields(value, NOT_EXPLORED_CODES, path, errors)) for (const code of NOT_EXPLORED_CODES) if (!isCount(value[code])) errors.push(`REPORT_COVERAGE_TYPE ${path}.${code}`);
}

// The shape of a report's `coverage_cells`. The numbers themselves are checked by `report verify`, which rebuilds them.
export function coverageReportErrors(value) {
  const errors = [];
  const fields = ['version', 'map', 'map_sha256', 'app_map', 'coarse', 'strict', 'not_explored', 'saturation', 'frontier', 'stop', 'case_cells'];
  if (!exactFields(value, fields, 'coverage_cells', errors)) return errors;
  if (value.version !== COVERAGE_CELLS_VERSION) errors.push('REPORT_COVERAGE_TYPE coverage_cells.version');
  if (value.map !== COVERAGE_MAP_FILE) errors.push('REPORT_COVERAGE_TYPE coverage_cells.map');
  if (!SHA256.test(String(value.map_sha256))) errors.push('REPORT_COVERAGE_TYPE coverage_cells.map_sha256');
  if (isObject(value.app_map) && value.app_map.present === false) exactFields(value.app_map, ['present'], 'coverage_cells.app_map', errors);
  else exactFields(value.app_map, ['present', 'schema', 'sha256', 'skipped'], 'coverage_cells.app_map', errors);
  for (const grouping of ['coarse', 'strict']) {
    const path = `coverage_cells.${grouping}`;
    if (exactFields(value[grouping], GROUPING_FIELDS, path, errors)) {
      if (typeof value[grouping].rule !== 'string') errors.push(`REPORT_COVERAGE_TYPE ${path}.rule`);
      for (const field of GROUPING_FIELDS.slice(1)) if (!isCount(value[grouping][field])) errors.push(`REPORT_COVERAGE_TYPE ${path}.${field}`);
    }
  }
  codeCounts(value.not_explored, 'coverage_cells.not_explored', errors);
  if (exactFields(value.saturation, ['strict', 'coarse'], 'coverage_cells.saturation', errors)) {
    for (const grouping of ['strict', 'coarse']) {
      const path = `coverage_cells.saturation.${grouping}`;
      const entry = value.saturation[grouping];
      if (exactFields(entry, ['n', 'f1', 'distinct', 'u'], path, errors)) {
        for (const field of ['n', 'f1', 'distinct']) if (!isCount(entry[field])) errors.push(`REPORT_COVERAGE_TYPE ${path}.${field}`);
        if (!(entry.u === null || (typeof entry.u === 'number' && entry.u >= 0 && entry.u <= 1))) errors.push(`REPORT_COVERAGE_TYPE ${path}.u`);
      }
    }
  }
  if (exactFields(value.frontier, ['candidates', 'by_reason'], 'coverage_cells.frontier', errors)) {
    if (!isCount(value.frontier.candidates)) errors.push('REPORT_COVERAGE_TYPE coverage_cells.frontier.candidates');
    codeCounts(value.frontier.by_reason, 'coverage_cells.frontier.by_reason', errors);
  }
  if (exactFields(value.stop, ['reason', 'code', 'detail'], 'coverage_cells.stop', errors)) {
    if (!STOP_REASONS.includes(value.stop.reason)) errors.push('REPORT_COVERAGE_TYPE coverage_cells.stop.reason');
    if (!(value.stop.code === null || NOT_EXPLORED_CODES.includes(value.stop.code))) errors.push('REPORT_COVERAGE_TYPE coverage_cells.stop.code');
    if (!(value.stop.detail === null || typeof value.stop.detail === 'string')) errors.push('REPORT_COVERAGE_TYPE coverage_cells.stop.detail');
  }
  if (exactFields(value.case_cells, ['cases', 'declared', 'with_own_receipt', 'ungraded_cases'], 'coverage_cells.case_cells', errors)) {
    for (const field of ['cases', 'declared', 'with_own_receipt']) if (!isCount(value.case_cells[field])) errors.push(`REPORT_COVERAGE_TYPE coverage_cells.case_cells.${field}`);
    if (!Array.isArray(value.case_cells.ungraded_cases) || value.case_cells.ungraded_cases.some((id) => !nonBlank(id))) errors.push('REPORT_COVERAGE_TYPE coverage_cells.case_cells.ungraded_cases');
  }
  return errors;
}

// The report's "Coverage cells" section. Each count stands alone: the two groupings, the frontier, U and the stop
// reason are never merged into one percentage.
export function coverageMarkdown(summary, map) {
  const u = (value) => (value === null ? 'n/a' : value.toFixed(4));
  const codes = (counts) => NOT_EXPLORED_CODES.filter((code) => counts[code] > 0).map((code) => `${code} ${counts[code]}`).join(', ') || 'none';
  const row = (label, grouping, saturation) => `| ${label} | ${grouping.cells} | ${grouping.covered} | ${saturation.distinct} | ${saturation.n} | ${saturation.f1} | ${u(saturation.u)} |`;
  const md = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const shown = map.cells.slice(0, 100);
  return [
    '## Coverage cells',
    '',
    `A cell is route × state × action × viewport row × environment condition; it counts only with a state receipt. Map: \`${COVERAGE_MAP_FILE}\`.`,
    '',
    `Cells (coarse): ${summary.coarse.cells} · PASS ${summary.coarse.PASS} · FAIL ${summary.coarse.FAIL} · UNGRADED ${summary.coarse.UNGRADED} · NOT_EXPLORED ${summary.coarse.NOT_EXPLORED} · N/A ${summary.coarse.NA}`,
    '',
    '| Grouping | Cells | Covered (PASS+FAIL) | States seen | n | f1 | Û = f1/n |',
    '|---|---|---|---|---|---|---|',
    row('Strict (DOM hash)', summary.strict, summary.saturation.strict),
    row('Coarse (route · state rule)', summary.coarse, summary.saturation.coarse),
    '',
    `Frontier: ${summary.frontier.candidates} candidate(s) left (${codes(summary.frontier.by_reason)}).`,
    `Stop reason: ${summary.stop.reason}${summary.stop.code ? ` (${summary.stop.code})` : ''}${summary.stop.detail ? ` — ${md(summary.stop.detail)}` : ''}.`,
    `NOT_EXPLORED by code: ${codes(summary.not_explored)}.`,
    summary.case_cells.ungraded_cases.length
      ? `Cases whose declared cells have no state receipt, not counted toward coverage: ${summary.case_cells.ungraded_cases.join(', ')}.`
      : 'Every graded case has a state receipt for each cell it declares.',
    '',
    '| Route | State | Action | Viewport | Condition | Status | Reason |',
    '|---|---|---|---|---|---|---|',
    ...shown.map((cell) => `| ${md(cell.route)} | ${md(cell.state)} | ${md(cell.action)} | ${md(cell.viewport)} | ${md(cell.condition)} | ${cell.status} | ${md(cell.reason ?? '—')} |`),
    ...(map.cells.length > shown.length ? ['', `${map.cells.length - shown.length} more cell(s) in \`${COVERAGE_MAP_FILE}\`.`] : []),
    '',
  ].join('\n');
}
