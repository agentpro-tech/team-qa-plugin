// R1e — prioritized frontier exploration. Contract: references/width-sweep-overlays.md.
//
// The explorer walks an app through a driver and writes an app map v2 exploration log (loop6 buildAppMapV2): settled
// observations with their candidates, refused attempts, the states it could not reach, and always a stop entry.
//   - Order: a candidate on a cell the plan ties to a requirement first, then one the plan marks high risk, then the
//     intrinsic risk of the action (save/submit/delete before navigation before the rest).
//   - The chooser (an LLM, optional) is asked only at a hard frontier point, a tie at the top score, and sees at most
//     `historyLimit` (20) history steps; an answer outside the options is not taken.
//   - When `plateauWindow` steps find no new coarse state, the explorer reads the CSS rules that never matched once and
//     keeps the states they name (empty, loading, error) as candidates on each screen with data (one where a row count
//     was read); one never reached is left UNREACHABLE.
//   - A destructive action (a destructive word on a control in a dialog, or one the driver marks destructive) needs
//     the approved plan (`approvedDestructive`); otherwise it is left with NEEDS_APPROVAL and never pressed.
// Driver: start() and observe() -> {node, route, url?, domHash, rows?, viewport?, candidates: [{target, label?,
// selector?, blocked?, detail?, haspopup?, destructive?}]}; act(candidate) -> {} or {blocked, detail}; and optionally
// unmatchedCssRules() -> [selector]. QA GUI's driver is Dragon's (dragonExploreDriver); tests use Playwright.
import { actionOf, buildAppMapV2 } from '../loop6/app-map.mjs';
import { NOT_EXPLORED_CODES, coarseStateOf } from './coverage-cell.mjs';
import { withClickSpeed } from './fast-click.mjs';

export const EXPLORATION_POLICY_SCHEMA = 'qa-gui/exploration-policy/v1';
const HIGH = /\b(save|submit|send|delete|remove|confirm|create|pay|apply|upload)\b/i;
const MEDIUM = /\b(new|add|sort|filter|search|open|close|cancel|edit|next|back|more|menu|tab|expand|collapse|toggle|theme|language)\b/i;
const DESTRUCTIVE = /\b(delete|remove|destroy|discard|purge|erase|pay|refund|revoke|archive)\b/i;
const HINTS = [
  [/(^|[^a-z])(is-)?(empty|no-results|zero-state|blank-state)([^a-z]|$)/i, 'empty'],
  [/(^|[^a-z])(is-)?(loading|skeleton|spinner|busy|pending)([^a-z]|$)/i, 'loading'],
  [/(^|[^a-z])(is-|has-)?(error|failed|invalid|danger)([^a-z]|$)/i, 'error'],
];

const surfaceOf = (node, route) => (typeof node === 'string' && node.startsWith('screen:') && typeof route === 'string' ? route
  : typeof node === 'string' && node.startsWith('route:') ? node.slice('route:'.length) : node);
const labelOf = (candidate) => String(candidate.label ?? candidate.target.slice(candidate.target.indexOf(':') + 1));
const sameAction = (entry, action) => entry.action === undefined || entry.action === action;

/** The priority of one candidate: {score, reasons}. `candidate.route` is its surface (the app map route). */
export function scoreCandidate(candidate, policy = {}) {
  const action = actionOf(candidate);
  const reasons = [];
  let score = 0;
  const requirement = (policy.requirementCells ?? []).find((entry) => entry.route === candidate.route && sameAction(entry, action));
  if (requirement) { score += 100; reasons.push(`requirement:${requirement.requirement ?? 'linked'}`); }
  if ((policy.highRisk ?? []).some((entry) => entry.route === candidate.route && sameAction(entry, action))) { score += 50; reasons.push('plan-risk'); }
  const label = labelOf(candidate);
  if (HIGH.test(label)) { score += 30; reasons.push('risk:high'); }
  else if (MEDIUM.test(label) || /^(nav|tab|link):/.test(candidate.target)) { score += 10; reasons.push('risk:medium'); }
  return { score, reasons };
}

/** The states the never-matched CSS rules name: [{selector, state}]. */
export function cssStateHints(selectors) {
  const hints = [];
  for (const selector of Array.isArray(selectors) ? selectors : []) {
    if (typeof selector !== 'string') continue;
    const hit = HINTS.find(([pattern]) => pattern.test(selector));
    if (hit) hints.push({ selector, state: hit[1] });
  }
  return hints;
}

/**
 * Explores until nothing explorable is left, the budget is used, or the driver fails. `follow({open, current, step})`
 * (a replay of an exploration someone else drove, e.g. a Team QA executor's recorded calls) picks every action instead
 * of the score: it returns {pick} (an open frontier entry) or {stop}; the decision log records `by: "executor"` and the
 * rule's own choice when it differs.
 */
export async function explore({ driver, policy = {}, chooser = null, budget = 30, historyLimit = 20, plateauWindow = 6, follow = null }) {
  const log = [];
  const decisions = [];
  const history = [];
  const frontier = new Map();
  const paths = new Map();
  const seen = new Set();
  const dataSurfaces = [];
  const hints = [];
  const approved = Array.isArray(policy.approvedDestructive) ? policy.approvedDestructive : [];
  let step = 0;
  let actions = 0;
  let sinceNew = 0;
  let cssRead = false;
  let current = null;
  let stop = null;

  const record = (obs, how) => {
    step += 1;
    const surface = surfaceOf(obs.node, obs.route);
    const candidates = (Array.isArray(obs.candidates) ? obs.candidates : []).filter((c) => c && typeof c.target === 'string' && c.target).map((c) => {
      const action = actionOf(c);
      const destructive = c.destructive === true || (DESTRUCTIVE.test(labelOf(c)) && c.haspopup !== true && String(obs.node).startsWith('dialog:'));
      const ok = approved.some((entry) => entry.route === surface && entry.action === action);
      const blocked = c.blocked ?? (destructive && !ok ? 'NEEDS_APPROVAL' : undefined);
      const detail = c.detail ?? (blocked === 'NEEDS_APPROVAL' ? 'a destructive action needs the approved plan' : undefined);
      return { ...c, ...(blocked ? { blocked } : {}), ...(detail ? { detail } : {}) };
    });
    log.push({ step, ...how, readyState: 'settled', node: obs.node, route: obs.route, domHash: obs.domHash,
      ...(Number.isInteger(obs.rows) ? { rows: obs.rows } : {}), ...(obs.viewport ? { viewport: obs.viewport } : {}), candidates });
    for (const [order, candidate] of candidates.entries()) {
      const key = `${obs.node}\u0000${candidate.target}`;
      if (frontier.has(key)) continue;
      const { score, reasons } = scoreCandidate({ ...candidate, route: surface }, policy);
      frontier.set(key, { key, node: obs.node, surface, target: candidate.target, action: actionOf(candidate), candidate,
        blocked: candidate.blocked ?? null, taken: false, score, reasons, order: frontier.size + order });
    }
    if (Number.isInteger(obs.rows) && !dataSurfaces.includes(surface)) dataSurfaces.push(surface);
    const state = `${surface}|${coarseStateOf(obs)}`;
    if (seen.has(state)) sinceNew += 1; else { seen.add(state); sinceNew = 0; }
    current = obs.node;
  };

  const choose = async (open) => {
    const ranked = [...open].sort((a, b) => b.score - a.score || (b.node === current) - (a.node === current) || a.order - b.order);
    const top = ranked[0];
    let ties = ranked.filter((entry) => entry.score === top.score);
    const local = ties.filter((entry) => entry.node === current);
    if (local.length) ties = local;
    const decision = { step, options: ties.slice(0, 5).map((entry) => entry.target), chosen: ties[0].target, by: 'rule' };
    if (typeof follow === 'function') {
      const answer = await follow({ open, current, step });
      if (answer?.stop) return { stop: answer.stop };
      const pick = answer?.pick;
      if (!pick || !open.includes(pick)) return { stop: { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: 'the replayed choice is not an open candidate' } };
      const followed = { step, options: decision.options, chosen: pick.target, by: 'executor', ...(pick.target !== decision.chosen ? { rule: decision.chosen } : {}) };
      decisions.push(followed);
      log.push({ action: 'decide', ...followed });
      return pick;
    }
    let pick = ties[0];
    if (ties.length >= 2 && typeof chooser === 'function') {
      const options = ties.slice(0, 5).map(({ node, surface, target, action, score }) => ({ node, route: surface, target, action, score }));
      const answer = await chooser({ options, history: history.slice(-historyLimit) });
      const found = ties.slice(0, 5).find((entry) => entry.target === answer);
      if (found) { pick = found; decision.by = 'chooser'; decision.chosen = found.target; }
      else decision.note = 'CHOOSER_ANSWER_NOT_AN_OPTION';
    }
    decisions.push(decision);
    log.push({ step, action: 'decide', options: decision.options, chosen: decision.chosen, by: decision.by, ...(decision.note ? { note: decision.note } : {}) });
    return pick;
  };

  try {
    const first = await driver.start();
    record(first, { action: 'goto', url: first.url ?? first.route });
    paths.set(first.node, []);
    for (;;) {
      const open = [...frontier.values()].filter((entry) => !entry.blocked && !entry.taken);
      if (open.length === 0) { stop = { reason: 'FRONTIER_EMPTY' }; break; }
      if (actions >= budget) { stop = { reason: 'BUDGET_EXHAUSTED', detail: `the budget of ${budget} actions is used` }; break; }
      const pick = await choose(open);
      if (pick.stop) { stop = pick.stop; break; }
      if (pick.node !== current) {
        // Reach the candidate's node again: from the start, along the edges that first led there.
        const start = await driver.start();
        record(start, { action: 'goto', url: start.url ?? start.route });
        for (const target of paths.get(pick.node) ?? []) {
          if (actions >= budget) break;
          const via = [...frontier.values()].find((entry) => entry.node === current && entry.target === target);
          const result = await driver.act(via?.candidate ?? { target });
          actions += 1;
          if (result?.blocked) break;
          record(await driver.observe(), { action: via?.candidate.action ?? 'click', target });
        }
        if (current !== pick.node) {
          if (actions >= budget) continue;
          pick.blocked = 'UNREACHABLE';
          pick.candidate = { ...pick.candidate, blocked: 'UNREACHABLE', detail: 'its screen could not be reached again' };
          continue;
        }
      }
      const result = await driver.act(pick.candidate);
      actions += 1;
      if (result?.blocked) {
        const code = NOT_EXPLORED_CODES.includes(result.blocked) ? result.blocked : 'TOOL_LIMIT';
        pick.blocked = code;
        step += 1;
        log.push({ step, action: pick.candidate.action ?? 'click', target: pick.target, blocked: code, ...(result.detail ? { detail: result.detail } : {}) });
        continue;
      }
      pick.taken = true;
      const from = pick.node;
      const obs = await driver.observe();
      record(obs, { action: pick.candidate.action ?? 'click', target: pick.target });
      if (!paths.has(obs.node)) paths.set(obs.node, [...(paths.get(from) ?? []), pick.target]);
      history.push({ step, from, action: pick.action, to: obs.node });
      if (!cssRead && sinceNew >= plateauWindow && typeof driver.unmatchedCssRules === 'function') {
        cssRead = true;
        const rules = await driver.unmatchedCssRules();
        // The states these rules name belong to the screens with data (where a row count was read).
        const routes = dataSurfaces.length ? dataSurfaces : [surfaceOf(obs.node, obs.route)];
        const found = cssStateHints(rules).flatMap((hint) => routes.map((route) => ({ ...hint, route })));
        hints.push(...found);
        step += 1;
        log.push({ step, action: 'css-hints', rules: (Array.isArray(rules) ? rules : []).slice(0, 50), states: found });
      }
    }
  } catch (error) {
    stop = { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: `the driver failed: ${String(error?.message ?? error).split('\n')[0]}` };
  }
  // A state a never-matched CSS rule names and the exploration never saw is left as a candidate, UNREACHABLE.
  const coarseSeen = new Set(seen);
  for (const hint of hints) {
    if (coarseSeen.has(`${hint.route}|${hint.state}`)) continue;
    coarseSeen.add(`${hint.route}|${hint.state}`);
    step += 1;
    log.push({ step, action: 'skip', route: hint.route, state: hint.state, reason: 'UNREACHABLE', detail: `CSS rule ${hint.selector} never matched` });
  }
  step += 1;
  log.push({ step, action: 'stop', ...stop });
  return { log, map: buildAppMapV2(log), decisions, history, actions };
}

// The exploration read QA GUI's driver runs on each settled state: the node (an open dialog, else the route), the
// route, a structural hash of the DOM, the row count of the first list and the visible controls of the top layer.
export const EXPLORE_OBSERVE_BODY = `
const css = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
const sel = (el) => {
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
    if (e.id) { parts.unshift('#' + css(e.id)); break; }
    let p = e.tagName.toLowerCase();
    const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
    if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
    parts.unshift(p);
    if (e.parentElement === document.body) break;
  }
  return parts.join(' > ');
};
const shown = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const dialogs = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')].filter(shown);
const top = dialogs.length ? dialogs[dialogs.length - 1] : null;
const route = location.hash && location.hash.startsWith('#/') ? location.hash.replace(/[?].*$/, '') : location.pathname;
const node = top ? 'dialog:' + (top.id || 'overlay') : 'route:' + route;
const root = top || document.body;
let h1 = 0x811c9dc5, h2 = 0x01000193;
const text = root.innerHTML.replace(/\\s+/g, ' ');
for (let i = 0; i < text.length; i += 1) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
const domHash = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
const list = root.querySelector('ul, ol, tbody');
const candidates = [...root.querySelectorAll('button, a[href], [role=button], [role=tab], summary')].filter((el) => shown(el) && !el.disabled).slice(0, 60).map((el) => {
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  const kind = el.tagName === 'A' ? 'link' : el.getAttribute('role') === 'tab' ? 'tab' : 'button';
  return { target: kind + ':' + label, label, selector: sel(el), haspopup: el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false' };
});
return { node, route, url: location.href, domHash, ...(list ? { rows: list.children.length } : {}), candidates };
`;

// The CSS rules of the page that match no element right now (read-only; cross-origin sheets are skipped).
export const UNMATCHED_CSS_BODY = `
const out = [];
for (const sheet of [...document.styleSheets]) {
  let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
  for (const rule of [...rules]) {
    if (!rule.selectorText) continue;
    try { if (!document.querySelector(rule.selectorText)) out.push(rule.selectorText); } catch (e) {}
    if (out.length >= 200) return out;
  }
}
return out;
`;

function readValue(result, as) {
  const step = Array.isArray(result?.results) ? result.results.find((entry) => entry?.step === 'read' && entry?.as === as) : null;
  let value = step?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return value;
}

// The explorer's driver over Dragon: a `goto` step to the start URL (it waits for the load), the observe read, and a
// trusted clickSelector per action, with `fast:false` unless `fast` (the R3 fast-click plan, fastClickAllowed) is true.
export function dragonExploreDriver({ rpc, binding = {}, tabId, url, fast = false }) {
  const read = async (body) => readValue(await rpc('do', { ...binding, tabId, steps: [{ read: body, as: 'v' }] }), 'v');
  return {
    async start() {
      await rpc('do', { ...binding, tabId, steps: [{ goto: url }] });
      return read(EXPLORE_OBSERVE_BODY);
    },
    observe: () => read(EXPLORE_OBSERVE_BODY),
    async act(candidate) {
      if (typeof candidate?.selector !== 'string') return { blocked: 'TOOL_LIMIT', detail: 'the candidate has no selector' };
      const result = await rpc('do', { ...binding, tabId, steps: [withClickSpeed({ clickSelector: candidate.selector }, fast), { wait: 150 }] });
      return result?.completed === false ? { blocked: 'OBSCURED', detail: String(result?.error ?? 'the click did not complete') } : {};
    },
    unmatchedCssRules: () => read(UNMATCHED_CSS_BODY),
  };
}
