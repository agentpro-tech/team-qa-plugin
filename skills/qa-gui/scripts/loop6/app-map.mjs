/**
 * V6.1 — buildAppMap
 *
 * Pure, deterministic, no I/O. Turns a crawl observation log into an app map
 * {nodes, edges, visited, total, denominatorReason?}.
 *
 * Design rules (all derived from the observation log, never from a case id):
 *  - a node exists only when an observation reports a settled `node`; transient
 *    states (skeleton/loading, plain notes) never become nodes;
 *  - node order is first-appearance order, edge order is chronological with
 *    global-nav edges first (a global nav bar is reachable from the root, so its
 *    edges belong to the root, not to whatever screen happened to be open);
 *  - the denominator is only reported when the crawl actually finished; a log
 *    that admits un-crawled territory yields total=null plus a reason.
 */

import {
  ANY, APP_MAP_V2_SCHEMA, DEFAULT_ACTION, DEFAULT_CONDITION, NOT_EXPLORED_CODES, STATE_LABEL, STOP_REASONS,
  coarseStateOf, conditionKey, routeOf, viewportRow,
} from '../lib/coverage-cell.mjs';

const SEPARATORS = /[/-]/;
const SEQUENCE_TOKEN = /^(?:step|page)\d+$/;
/** id tokens that describe structure, not the human name of the surface. */
const STRUCTURAL_TOKENS = new Set(['list', 'nested']);
/** tokens that read as a leading modifier in English ("order-new" -> "New Order"). */
const MODIFIER_TOKENS = new Set(['new', 'edit']);
const UNCRAWLED_HINT = /budget exhausted|not yet clicked|unknown how many/i;

const splitTail = (id) => {
  const at = id.indexOf(':');
  return at < 0 ? { prefix: 'screen', tail: id } : { prefix: id.slice(0, at), tail: id.slice(at + 1) };
};

const tokensOf = (tail) => tail.replace(/^#/, '').replace(/^\//, '').split(SEPARATORS).filter(Boolean);

const splitDigits = (token) => token.split(/(?<=[a-zA-Z])(?=\d)/);

const capitalize = (word) => (/^[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word);

const titleCase = (tokens) => tokens.flatMap(splitDigits).map(capitalize).join(' ');

const singular = (word) => (word.length > 1 && word.endsWith('s') ? word.slice(0, -1) : word);

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const isTemplatedRoute = (node) => node.prefix === 'route' && node.tokens.some((token) => token.startsWith(':'));

const queryOf = (route) => {
  const at = typeof route === 'string' ? route.indexOf('?') : -1;
  return at < 0 ? '' : route.slice(at + 1);
};

/** Human name for a screen/dialog id: drop structural tokens, front the modifier. */
function nameTokens(tokens) {
  const kept = tokens.filter((token) => !STRUCTURAL_TOKENS.has(token));
  const lead = kept.findIndex((token) => MODIFIER_TOKENS.has(token));
  if (lead > 0) return [kept[lead], ...kept.slice(0, lead), ...kept.slice(lead + 1)];
  return kept;
}

function labelFor(node, sharedPrefix) {
  const { prefix, tail, tokens } = node;
  if (node.type === 'error') return `${node.status} ${titleCase(nameTokens(tokens))}`;
  if (prefix === 'tab' || (prefix === 'route' && tail.startsWith('#'))) {
    // path-style ids keep their hierarchy in the label: "Orders > Active".
    return tokens.map((token) => titleCase([token])).join(' > ');
  }
  if (prefix === 'route') {
    if (isTemplatedRoute(node)) return `${capitalize(singular(tokens[0]))} Detail (templated)`;
    const queries = [...new Set(node.observations.map((obs) => queryOf(obs.resultRoute ?? obs.url)))].filter(Boolean);
    const keys = [...new Set(queries.flatMap((q) => q.split('&').map((pair) => pair.split('=')[0])))];
    const submitted = node.observations.some((obs) => obs.action === 'submit');
    const base = titleCase(tokens) + (submitted ? ' Results' : '');
    return queries.length > 1 ? `${base} (templated by ${keys.join(', ')})` : base;
  }
  // screen / dialog: hyphen ids. A flow prefix shared by every node is context,
  // not a name — except for numbered wizard steps, which need it to stay readable.
  const stripped = sharedPrefix && tokens.length > 1 && !SEQUENCE_TOKEN.test(tokens[1])
    ? tokens.slice(1)
    : tokens;
  return titleCase(nameTokens(stripped));
}

function slugFor(node, sharedPrefix) {
  if (isTemplatedRoute(node)) return slugify(node.label);
  const tokens = sharedPrefix && node.tokens.length > 1 ? node.tokens.slice(1) : node.tokens;
  return node.prefix === 'dialog' ? `dialog-${tokens.join('-')}` : tokens.join('-');
}

function triggerFor(obs) {
  const { action, target } = obs;
  if (action === 'goto') return `goto:${obs.url}`;
  if (action === 'navBack') return 'nav:back';
  if (typeof target !== 'string' || target.length === 0) return String(action ?? '');
  if (action === 'submit') {
    const [kind, name] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    return kind === 'form' ? `submit:${name}-form` : `submit:${target}`;
  }
  if (target.includes(':text=')) {
    const at = target.indexOf(':text=');
    return `click:${target.slice(0, at)} (label '${target.slice(at + ':text='.length)}')`;
  }
  const at = target.indexOf(':');
  if (at < 0) return `click:${target}`;
  const kind = target.slice(0, at);
  const name = target.slice(at + 1);
  // In a hash-routed app the nav/tab widget is itself a route link, so the
  // trigger is the plain label rather than a widget-qualified name.
  if (obs.resultHash !== undefined) return `click:${name}`;
  if (kind === 'nav') return `click:nav-${name.toLowerCase()}`;
  if (kind === 'tab') return `click:${name}-tab`;
  if (kind === 'breadcrumb') return `click:breadcrumb-${name.toLowerCase()}`;
  if (kind === 'row') return `click:${name.replace(/[-_]\d+$/, '')}-row`;
  return `click:${name}`;
}

/** R1e: the cell action of a candidate affordance, in the trigger form of the app map's edges (`click:Save`). */
export function actionOf(candidate) {
  return triggerFor({ action: candidate?.action ?? 'click', target: candidate?.target });
}

export function buildAppMap(observations) {
  const log = Array.isArray(observations) ? observations.filter((obs) => obs && typeof obs === 'object') : [];

  const nodes = new Map();
  const transitions = [];
  let root = null;
  let current = null;
  let pending = null;

  for (const obs of log) {
    const id = obs.node;
    if (typeof id !== 'string' || id.length === 0) {
      // transient state or bare note: remember the gesture, do not create a node
      if (typeof obs.target === 'string') pending = obs;
      continue;
    }

    if (!nodes.has(id)) {
      const { prefix, tail } = splitTail(id);
      const status = typeof obs.httpLikeStatus === 'number' ? obs.httpLikeStatus : null;
      nodes.set(id, {
        id,
        prefix,
        tail,
        tokens: tokensOf(tail),
        type: status !== null && status >= 400 ? 'error' : prefix,
        status,
        observations: [],
      });
    }
    nodes.get(id).observations.push(obs);

    if (root === null) root = id;
    const driver = typeof obs.target === 'string' ? obs : (pending ?? obs);
    pending = null;

    const viaGlobalNav = typeof driver.target === 'string' && driver.target.startsWith('nav:');
    const from = viaGlobalNav ? root : current;
    current = id;

    if (from === null || from === id) continue;
    // Browser history is not an app affordance; only a hash-router back button
    // (which is a real in-app route change) becomes an edge.
    if (driver.action === 'navBack' && driver.resultHash === undefined) continue;

    const edge = { from, to: id, trigger: triggerFor(driver), viaGlobalNav };
    if (typeof driver.redirectedTo === 'string') {
      edge.redirect = { from: driver.url, to: driver.redirectedTo };
    }
    transitions.push(edge);
  }

  const list = [...nodes.values()];
  // A flow prefix ("signup-step1", "onboarding-welcome") only counts when every
  // node in the map is a named surface carrying it. A templated route pattern is
  // a URL shape, not a name, so its segments never stand in for a flow prefix.
  const sharedPrefix = list.length > 1
    && list.every((node) => !isTemplatedRoute(node)
      && node.tokens.length > 1
      && node.tokens[0] === list[0].tokens[0]);

  for (const node of list) node.label = labelFor(node, sharedPrefix);
  const slugs = new Map(list.map((node) => [node.id, slugFor(node, sharedPrefix)]));

  const seen = new Set();
  const built = [];
  for (const edge of transitions) {
    const id = `e:${slugs.get(edge.from)}->${slugs.get(edge.to)}${edge.redirect ? '-redirect' : ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = { id, from: edge.from, to: edge.to, trigger: edge.trigger };
    if (edge.redirect) {
      row.redirect = true;
      row.redirectFrom = edge.redirect.from;
      row.redirectTo = edge.redirect.to;
    }
    built.push({ row, viaGlobalNav: edge.viaGlobalNav });
  }

  const uncrawled = log.find((obs) => typeof obs.detail === 'string' && UNCRAWLED_HINT.test(obs.detail));
  const graph = {
    nodes: list.map((node) => ({ id: node.id, type: node.type, label: node.label })),
    edges: [
      ...built.filter((edge) => edge.viaGlobalNav).map((edge) => edge.row),
      ...built.filter((edge) => !edge.viaGlobalNav).map((edge) => edge.row),
    ],
    visited: list.length,
    total: uncrawled ? null : list.length,
  };
  if (uncrawled) {
    const discovered = uncrawled.detail.trim().split(/\s+/)[0];
    graph.denominatorReason = `crawl-timeout: ${discovered} discovered but not crawled before budget exhausted`;
  }
  return graph;
}

/**
 * R1b — app map v2: the v1 graph plus what the exploration did NOT do and why it stopped.
 *
 * Pure, deterministic, no I/O. `buildAppMap` above stays exactly as the frozen V6.1 corpus wants it; v2 reads the
 * same log plus optional fields that v1 ignores (references/coverage-cells.md):
 *   - on a settled observation: `domHash` (the strict state key), `rows` (a read row count), `viewport` (a responsive
 *     matrix row id or its `WxH`), `conditions` (environment conditions forced for it), `route`, and `candidates`
 *     ([{target, action?, blocked?, leadsTo?, detail?}], the affordances seen in that state);
 *   - a nodeless observation with `blocked: <code>`: an attempt on `target` that was refused (not an edge);
 *   - `{action: "skip", route, state, reason, viewport?, conditions?, detail?}`: a state the explorer did not reach;
 *   - `{action: "stop", reason, code?, detail?}`: why the exploration ended.
 * Output: {schema, nodes (v1 + route), edges (v1), visited, total, denominatorReason?, states, frontier, stop,
 * saturation: {strict, coarse}, issues}. A frontier entry is a cell the exploration saw and did not run; each carries
 * one NOT_EXPLORED code. Saturation is Good-Turing's unseen mass Û = f1/n over the settled state observations, once
 * per state grouping: strict by DOM hash, coarse by the rule `route|coarse state`.
 */
const LOADING_STATE = /^(loading|skeleton|busy)$/i;

function surfaceOf(id, obs) {
  const { prefix, tail } = splitTail(id);
  if (prefix === 'route') return tail || id;
  // A dialog, drawer, popover or tab is its own surface; only a screen takes the URL it was seen at.
  if (prefix !== 'screen') return id;
  const raw = obs.route ?? obs.resultRoute ?? (obs.action === 'goto' ? obs.url : undefined) ?? obs.resultHash;
  return routeOf(raw) ?? id;
}

function rowOf(value, issues) {
  if (value === undefined || value === null) return ANY;
  const row = viewportRow(value);
  if (row) return row.id;
  issues.add('VIEWPORT_NOT_A_ROW');
  return ANY;
}

function conditionOf(value, issues) {
  if (value === undefined || value === null) return DEFAULT_CONDITION;
  if (typeof value !== 'object' || Array.isArray(value)) { issues.add('CONDITIONS_INVALID'); return DEFAULT_CONDITION; }
  return conditionKey(value);
}

function saturationOf(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const n = keys.length;
  const f1 = [...counts.values()].filter((count) => count === 1).length;
  return { n, f1, distinct: counts.size, u: n === 0 ? null : f1 / n };
}

const SEP = '\u0000';

export function buildAppMapV2(observations) {
  const log = Array.isArray(observations) ? observations.filter((obs) => obs && typeof obs === 'object') : [];
  const graph = buildAppMap(log);
  const issues = new Set();
  const routes = new Map();
  const states = [];
  const candidates = new Map();
  const refused = new Map();
  const taken = new Set();
  const skips = [];
  let declaredStop = null;
  let root = null;
  let current = null;
  let pending = null;

  log.forEach((obs, index) => {
    const step = Number.isInteger(obs.step) ? obs.step : index + 1;
    if (obs.action === 'stop') { declaredStop = { ...obs, step }; return; }
    if (obs.action === 'skip') { skips.push({ ...obs, step }); return; }
    const id = obs.node;
    if (typeof id !== 'string' || id.length === 0) {
      if (typeof obs.target === 'string' && obs.blocked !== undefined && current !== null) {
        refused.set(`${current}${SEP}${obs.target}`, { code: obs.blocked, detail: obs.detail });
      } else if (typeof obs.target === 'string') pending = obs;
      // A transient state seen on a known route (a loading skeleton) is a state observation, never a node.
      const route = routeOf(obs.route ?? obs.resultRoute);
      if (route && typeof obs.readyState === 'string' && LOADING_STATE.test(obs.readyState)) {
        states.push({ step, node: null, route, state: 'loading', strict: typeof obs.domHash === 'string' ? obs.domHash : null,
          viewport: rowOf(obs.viewport, issues), condition: conditionOf(obs.conditions, issues) });
      }
      return;
    }
    if (root === null) root = id;
    const driver = typeof obs.target === 'string' ? obs : (pending ?? obs);
    pending = null;
    const from = typeof driver.target === 'string' && driver.target.startsWith('nav:') ? root : current;
    if (from !== null && typeof driver.target === 'string') taken.add(`${from}${SEP}${driver.target}`);
    current = id;
    if (!routes.has(id)) routes.set(id, surfaceOf(id, obs));
    const seen = {
      step, node: id, route: routes.get(id), state: coarseStateOf(obs), strict: typeof obs.domHash === 'string' ? obs.domHash : null,
      viewport: rowOf(obs.viewport, issues), condition: conditionOf(obs.conditions, issues),
    };
    states.push(seen);
    for (const candidate of Array.isArray(obs.candidates) ? obs.candidates : []) {
      if (!candidate || typeof candidate.target !== 'string' || !candidate.target) { issues.add('CANDIDATE_INVALID'); continue; }
      const key = `${id}${SEP}${candidate.target}`;
      if (!candidates.has(key)) candidates.set(key, { candidate, seen });
    }
  });

  const frontier = [];
  for (const [key, { candidate, seen }] of candidates) {
    if (taken.has(key)) continue;
    const block = candidate.blocked !== undefined ? { code: candidate.blocked, detail: candidate.detail } : refused.get(key);
    let reason = null;
    if (block) {
      if (NOT_EXPLORED_CODES.includes(block.code)) reason = block.code;
      else issues.add('BLOCKED_CODE_INVALID');
    }
    const leadsTo = routeOf(candidate.leadsTo);
    const detail = block?.detail ?? candidate.detail;
    frontier.push({
      id: `f:${seen.node}>${candidate.target}`, kind: 'action', from: seen.node, route: seen.route, state: seen.state, strict: seen.strict,
      action: triggerFor({ action: candidate.action ?? 'click', target: candidate.target }), target: candidate.target,
      viewport: seen.viewport, condition: seen.condition, reason,
      ...(leadsTo ? { leadsTo } : {}), ...(typeof detail === 'string' && detail ? { detail } : {}),
    });
  }
  for (const skip of skips) {
    const route = routeOf(skip.route);
    if (!route || typeof skip.state !== 'string' || !STATE_LABEL.test(skip.state)) { issues.add('SKIP_INVALID'); continue; }
    const valid = NOT_EXPLORED_CODES.includes(skip.reason);
    if (!valid) issues.add('SKIP_REASON_INVALID');
    frontier.push({
      id: `f:${route}>state=${skip.state}`, kind: 'state', from: null, route, state: skip.state, strict: null, action: DEFAULT_ACTION, target: null,
      viewport: skip.viewport === undefined ? ANY : rowOf(skip.viewport, issues),
      condition: skip.conditions === undefined ? ANY : conditionOf(skip.conditions, issues),
      reason: valid ? skip.reason : null, ...(typeof skip.detail === 'string' && skip.detail ? { detail: skip.detail } : {}),
    });
  }

  // The stop reason: as declared when it holds, else what the log implies. FRONTIER_EMPTY while an explorable
  // candidate is left is not true, so it is corrected and reported.
  const open = frontier.filter((entry) => entry.kind === 'action' && entry.reason === null).length;
  let stop = null;
  if (declaredStop) {
    if (!STOP_REASONS.includes(declaredStop.reason)) issues.add('STOP_REASON_INVALID');
    else {
      let code = null;
      if (declaredStop.reason === 'BLOCKED') {
        if (NOT_EXPLORED_CODES.includes(declaredStop.code)) code = declaredStop.code;
        else { issues.add('STOP_CODE_MISSING'); code = 'TOOL_LIMIT'; }
      }
      stop = { reason: declaredStop.reason, code, detail: typeof declaredStop.detail === 'string' ? declaredStop.detail : null, step: declaredStop.step };
    }
  }
  if (!stop && typeof graph.denominatorReason === 'string') stop = { reason: 'BUDGET_EXHAUSTED', code: null, detail: graph.denominatorReason, step: null };
  if (!stop) stop = open > 0 ? { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: 'STOP_UNDECLARED: the log ends with candidates left and names no stop reason', step: null }
    : { reason: 'FRONTIER_EMPTY', code: null, detail: null, step: null };
  if (stop.reason === 'FRONTIER_EMPTY' && open > 0) {
    issues.add('STOP_FRONTIER_NOT_EMPTY');
    stop = { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: `declared FRONTIER_EMPTY with ${open} explorable candidate(s) left`, step: stop.step };
  }
  const implied = stop.reason === 'BUDGET_EXHAUSTED' ? 'BUDGET' : stop.reason === 'BLOCKED' ? stop.code : 'UNREACHABLE';
  for (const entry of frontier) if (entry.reason === null) entry.reason = implied;

  const finished = stop.reason === 'FRONTIER_EMPTY';
  return {
    schema: APP_MAP_V2_SCHEMA,
    nodes: graph.nodes.map((node) => ({ ...node, route: routes.get(node.id) ?? node.id })),
    edges: graph.edges,
    visited: graph.visited,
    total: finished ? graph.total : null,
    ...(finished && graph.denominatorReason === undefined ? {} : {
      denominatorReason: graph.denominatorReason ?? `stop ${stop.reason}: ${frontier.length} candidate(s) left in the frontier`,
    }),
    states,
    frontier,
    stop,
    saturation: {
      strict: saturationOf(states.filter((entry) => entry.strict !== null).map((entry) => entry.strict)),
      coarse: saturationOf(states.map((entry) => `${entry.route}|${entry.state}`)),
    },
    issues: [...issues].sort(),
  };
}

export default { buildAppMap, buildAppMapV2 };
