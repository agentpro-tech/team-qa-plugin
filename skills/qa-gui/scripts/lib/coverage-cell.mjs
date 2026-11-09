// Coverage cells (upgrade R1b). Pure, no I/O. Contract: references/coverage-cells.md.
//
// A cell is route x state x action x viewport row x environment condition. QA GUI owns two pieces of it:
//   - the vocabulary and rules every reader uses (the NOT_EXPLORED codes, the stop reasons, the state family of a
//     screen with data, the coarse state rule and the canonical condition key), and
//   - the optional `cell` a state receipt carries (qa-gui/coverage-cell/v1), which the gate checks so that only a
//     well-formed, machine-consistent cell reaches a coverage count.
// Team QA builds the coverage map (the denominator and the counts) from these; it never grades a cell itself.
import { RESPONSIVE_MATRIX } from '../loop7/responsive-matrix.mjs';

export const COVERAGE_CELL_VERSION = 'qa-gui/coverage-cell/v1';
export const APP_MAP_V2_SCHEMA = 'qa-gui/app-map/v2';

// Why a cell was not run. One code per cell; a cell without a code of its own takes the one its stop reason implies.
export const NOT_EXPLORED_CODES = Object.freeze([
  'BUDGET', // the step or time budget ran out before the cell was reached
  'AUTH', // it needs a sign-in or a role the run does not have
  'NEEDS_APPROVAL', // a destructive action the signed plan does not approve
  'NO_DATA', // it needs data the test environment does not hold and the environment layer cannot force
  'UNREACHABLE', // no path to it was found
  'HOVER_ONLY', // only a hover reaches it
  'OBSCURED', // another element covers the control
  'TOOL_LIMIT', // the tool cannot perform the action (or the log does not say why it stopped)
]);
// Why an exploration ended.
export const STOP_REASONS = Object.freeze(['FRONTIER_EMPTY', 'BUDGET_EXHAUSTED', 'BLOCKED']);
// The states a screen with data must be seen in.
export const DATA_STATE_FAMILY = Object.freeze(['empty', 'loading', 'error', 'one-row', 'many-rows']);
// The states whose label a row count decides.
export const ROW_STATES = Object.freeze(['empty', 'one-row', 'many-rows']);
// Conditions are forced only at the environment layer (HR1): network, request hold/fail by URL pattern, CPU,
// timezone, locale, media. A fake clock or an injected state is not a condition.
export const CONDITION_KINDS = Object.freeze(['network', 'request', 'cpu', 'timezone', 'locale', 'media']);
export const DEFAULT_STATE = 'ideal';
export const DEFAULT_ACTION = 'view';
export const DEFAULT_CONDITION = 'default';
// An axis of a cell the source does not fix (a skipped state with no viewport, a planned cell under any condition).
export const ANY = '*';

const CELL_FIELDS = ['version', 'route', 'state', 'action', 'viewport', 'conditions', 'rows'];
const CELL_REQUIRED = ['version', 'route', 'action', 'viewport', 'conditions'];
export const STATE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ROUTE = /^[^\s|][^|]{0,511}$/;
const ACTION = /^[^\s|][^|]{0,255}$/;
const CONDITION_VALUE = /^[^\s=+|]{1,128}$/;
const SIZE = /^(\d+)x(\d+)$/;
const LOADING = /^(loading|skeleton|busy)$/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The canonical key of a set of environment conditions: `default` when nothing was forced, else sorted `kind=value` joined by `+`. */
export function conditionKey(conditions) {
  if (!isObject(conditions)) return DEFAULT_CONDITION;
  const entries = Object.entries(conditions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? DEFAULT_CONDITION : entries.map(([kind, value]) => `${kind}=${value}`).join('+');
}

// Dragon's network presets (R1a env.set network), named back from the numbers its record keeps.
const NETWORK_PRESETS = [['slow-3g', 2000, 400, 400], ['fast-3g', 563, 1440, 675], ['slow-4g', 165, 8100, 1350]];
const clip = (text) => String(text).replace(/[\s=+|]/g, '_').slice(0, 128);
/**
 * The cell conditions of a Dragon R1a conditions record (`receipt.env.conditions`, the closed record of
 * docs/r1a-environment-and-sensors.md): `{network, request, cpu, timezone, locale, media}` with string values, nothing
 * for a dimension at its default. Sensors, frames and an evidence-only animation rate are not conditions.
 */
export function cellConditionsOf(record) {
  if (!isObject(record)) return {};
  const out = {};
  const n = record.network;
  if (isObject(n)) {
    const preset = NETWORK_PRESETS.find(([, latency, down, up]) => n.latencyMs === latency && n.downloadKbps === down && n.uploadKbps === up);
    out.network = n.offline === true ? 'offline' : preset ? preset[0] : clip(`latency${n.latencyMs}-down${n.downloadKbps ?? 'any'}-up${n.uploadKbps ?? 'any'}`);
  }
  if (Array.isArray(record.requests) && record.requests.length) {
    out.request = clip(record.requests.map((rule) => [rule.action, rule.status ?? rule.errorReason].filter((part) => part !== null && part !== undefined).join(':')).join(','));
  }
  if (isObject(record.cpu) && Number.isFinite(record.cpu.rate) && record.cpu.rate > 1) out.cpu = String(record.cpu.rate);
  if (typeof record.timezone === 'string' && record.timezone) out.timezone = clip(record.timezone);
  if (typeof record.locale === 'string' && record.locale) out.locale = clip(record.locale);
  if (isObject(record.media)) {
    const parts = Object.entries(record.media).filter(([, value]) => typeof value === 'string' && value).map(([key, value]) => `${key}:${value}`);
    if (parts.length) out.media = clip(parts.join(','));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The row-family label of a measured row count. */
export function rowsState(rows) {
  return rows === 0 ? 'empty' : rows === 1 ? 'one-row' : 'many-rows';
}

/**
 * The coarse state of an observation, by rule from what was measured, never from a declared label:
 * loading (readyState loading/skeleton/busy) > error (HTTP-like status >= 400 or error flag) > the row family when a
 * row count was read > `ideal`.
 */
export function coarseStateOf(observation) {
  const obs = isObject(observation) ? observation : {};
  if (typeof obs.readyState === 'string' && LOADING.test(obs.readyState)) return 'loading';
  if ((Number.isInteger(obs.httpLikeStatus) && obs.httpLikeStatus >= 400) || obs.error === true) return 'error';
  if (Number.isInteger(obs.rows) && obs.rows >= 0) return rowsState(obs.rows);
  return DEFAULT_STATE;
}

/** The matrix row of a row id or a `WxH` size, or null. */
export function viewportRow(value) {
  if (typeof value !== 'string') return null;
  const byId = RESPONSIVE_MATRIX.find((row) => row.id === value);
  if (byId) return byId;
  const size = SIZE.exec(value);
  return size ? RESPONSIVE_MATRIX.find((row) => row.w === Number(size[1]) && row.h === Number(size[2])) ?? null : null;
}

/** The route (surface) part of a URL or path: no origin, no query; `/` when empty. */
export function routeOf(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/\?[^#]*/, '');
  return path || '/';
}

const issue = (code, detail = null) => ({ code, ...(detail === null ? {} : { detail }) });

/**
 * The problems of a state receipt's optional `cell`. An absent cell has none (receipts before R1b stay valid).
 * Each problem is {code, detail?}; the gate reports every one as UNGRADED, since a cell that is malformed or that the
 * receipt's own measurements contradict cannot back a coverage count.
 */
export function stateCellIssues(receipt) {
  if (!isObject(receipt) || !Object.hasOwn(receipt, 'cell')) return [];
  const cell = receipt.cell;
  if (!isObject(cell)) return [issue('CELL_TYPE')];
  const problems = [];
  for (const key of Object.keys(cell)) if (!CELL_FIELDS.includes(key)) problems.push(issue('CELL_UNKNOWN_FIELD', key));
  for (const key of CELL_REQUIRED) if (!Object.hasOwn(cell, key)) problems.push(issue('CELL_MISSING_FIELD', key));
  if (Object.hasOwn(cell, 'version') && cell.version !== COVERAGE_CELL_VERSION) problems.push(issue('CELL_VERSION', String(cell.version)));
  if (Object.hasOwn(cell, 'route') && !(typeof cell.route === 'string' && ROUTE.test(cell.route))) problems.push(issue('CELL_ROUTE'));
  if (Object.hasOwn(cell, 'state') && !(typeof cell.state === 'string' && STATE_LABEL.test(cell.state))) problems.push(issue('CELL_STATE'));
  if (Object.hasOwn(cell, 'action') && !(typeof cell.action === 'string' && ACTION.test(cell.action))) problems.push(issue('CELL_ACTION'));
  if (Object.hasOwn(cell, 'viewport')) {
    const row = RESPONSIVE_MATRIX.find((entry) => entry.id === cell.viewport);
    if (!row) problems.push(issue('CELL_VIEWPORT_ROW', String(cell.viewport)));
    else {
      // The row must be the size the receipt measured: a desktop-1280 cell is not backed by a 360 px capture.
      const size = SIZE.exec(typeof receipt.viewport === 'string' ? receipt.viewport : '');
      if (size && (Number(size[1]) !== row.w || Number(size[2]) !== row.h)) problems.push(issue('CELL_VIEWPORT_MISMATCH', `${row.id}!=${receipt.viewport}`));
    }
  }
  if (Object.hasOwn(cell, 'conditions')) {
    if (!isObject(cell.conditions)) problems.push(issue('CELL_CONDITIONS'));
    else {
      for (const [kind, value] of Object.entries(cell.conditions)) {
        if (!CONDITION_KINDS.includes(kind)) problems.push(issue('CELL_CONDITION_KIND', kind));
        else if (!(typeof value === 'string' && CONDITION_VALUE.test(value))) problems.push(issue('CELL_CONDITION_VALUE', kind));
      }
    }
  }
  // The conditions are the ones Dragon recorded for the state (its `env` block): a forced state is only what Dragon forced.
  if (isObject(cell.conditions) && !problems.some((p) => p.code.startsWith('CELL_CONDITION'))) {
    if (isObject(receipt.env) && Object.hasOwn(receipt.env, 'conditions')) {
      const recorded = conditionKey(cellConditionsOf(receipt.env.conditions));
      if (conditionKey(cell.conditions) !== recorded) problems.push(issue('CELL_CONDITIONS_MISMATCH', `${conditionKey(cell.conditions)}!=${recorded}`));
    } else if (Object.keys(cell.conditions).length) problems.push(issue('CELL_CONDITIONS_UNBACKED', conditionKey(cell.conditions)));
  }
  if (Object.hasOwn(cell, 'rows') && !(Number.isInteger(cell.rows) && cell.rows >= 0)) problems.push(issue('CELL_ROWS'));
  // A row-family state is decided by the row count the executor read, not by the label it wrote.
  const state = Object.hasOwn(cell, 'state') ? cell.state : receipt.state;
  if (ROW_STATES.includes(state)) {
    if (!Object.hasOwn(cell, 'rows')) problems.push(issue('CELL_ROWS_UNMEASURED', state));
    else if (Number.isInteger(cell.rows) && cell.rows >= 0 && rowsState(cell.rows) !== state) problems.push(issue('CELL_STATE_ROWS_MISMATCH', `${state}:rows=${cell.rows}`));
  }
  return problems;
}

/** The normalized cell of a state receipt that carries a valid `cell`, else null. `strict` is the receipt's DOM hash. */
export function stateCell(receipt) {
  if (!isObject(receipt) || !isObject(receipt.cell) || stateCellIssues(receipt).length > 0) return null;
  const { cell } = receipt;
  return {
    route: cell.route,
    state: Object.hasOwn(cell, 'state') ? cell.state : receipt.state,
    action: cell.action,
    viewport: cell.viewport,
    condition: conditionKey(cell.conditions),
    strict: typeof receipt.domHash === 'string' ? receipt.domHash : null,
  };
}

/** One summary of the cells a gate run read: {cells, PASS, FAIL, UNGRADED}; counted only when some receipt has a cell. */
export function cellTally(cells) {
  const tally = { cells: 0, PASS: 0, FAIL: 0, UNGRADED: 0 };
  for (const cell of Array.isArray(cells) ? cells : []) {
    tally.cells += 1;
    tally[['PASS', 'FAIL'].includes(cell?.verdict) ? cell.verdict : 'UNGRADED'] += 1;
  }
  return tally;
}

/** The gate's summary line, or null when no receipt declared a cell (so older boards print what they always printed). */
export function cellSummaryLine(cells) {
  const tally = cellTally(cells);
  if (tally.cells === 0) return null;
  return `Cells with receipt: ${tally.PASS + tally.FAIL} (PASS ${tally.PASS} · FAIL ${tally.FAIL} · UNGRADED ${tally.UNGRADED})`;
}
