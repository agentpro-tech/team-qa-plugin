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

export default { buildAppMap };
