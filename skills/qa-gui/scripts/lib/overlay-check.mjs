// R1e — the overlay inventory and check. Contract: references/width-sweep-overlays.md.
//
// On a screen, list the controls that open an overlay (dialog, alertdialog, aria-modal, popover). Each overlay is a
// coverage cell (route = the overlay, actions = each way in and out) checked through trusted GUI input only:
//   O1 opens by mouse        O2 opens by keyboard (Tab to the trigger, Enter)
//   O3 closes by Esc         O4 closes by its backdrop     O5 closes by its close button
//   O6 focus moves in and stays trapped while it is open   O7 focus returns to the trigger after every close
//   O8 the page behind does not scroll                     O9 two stacked overlays: one Esc closes only the top one
// A check whose condition is absent (no backdrop, no close button found, a page too short to scroll, no nested overlay,
// a non-modal overlay for O6 and O8) is UNGRADED with PRECONDITION_ABSENT, never PASS. Only dialog-type triggers count
// (aria-haspopup="dialog", popovertarget, aria-controls naming a dialog or a popover): a menu, listbox, tree or grid
// popup is not an overlay of this check. A trigger Tab did not reach within the press limit (80) is UNGRADED TOOL_LIMIT
// for O2 only (the screen's verdict does not change) unless focus went round the whole page without reaching it (then O2
// FAILs); focus is followed by element identity, not by selector. The driver is QA GUI's Dragon driver (dragonOverlayDriver); tests
// use Playwright behind the same interface: click(selector), clickAt(x, y), press(key), read(body),
// scrollAttempt() -> {attempted, code?}, reload().
import { withClickSpeed } from './fast-click.mjs';

export const OVERLAY_CHECK_SCHEMA = 'qa-gui/overlay-check/v1';
export const OVERLAY_RULES = Object.freeze({
  O1: 'opens by mouse', O2: 'opens by keyboard', O3: 'closes by Esc', O4: 'closes by backdrop', O5: 'closes by its close button',
  O6: 'focus is trapped', O7: 'focus returns to the trigger', O8: 'background scroll is locked', O9: 'stacked overlays close one at a time',
});
const CELL_ACTIONS = { O1: 'open:mouse', O2: 'open:keyboard', O3: 'close:esc', O4: 'close:backdrop', O5: 'close:button' };

// The page-side read of the overlay state. Read-only: hit testing and computed style, no change to the page.
export const OVERLAY_STATE_BODY = `
const css = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
const sel = (el) => {
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
    if (e.id) { parts.unshift('#' + css(e.id)); break; }
    let p = e.tagName.toLowerCase();
    if (e.classList.length) p += '.' + [...e.classList].slice(0, 2).map(css).join('.');
    const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
    if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
    parts.unshift(p);
    if (e.parentElement === document.body) break;
  }
  return parts.join(' > ');
};
const shown = (el) => {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const OVERLAY = 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]';
let open = [...document.querySelectorAll(OVERLAY)].filter(shown);
try { open = [...new Set([...open, ...document.querySelectorAll(':popover-open')])]; } catch (e) {}
open = open.filter((el) => !open.some((other) => other !== el && other.contains(el)));
const z = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const v = parseInt(getComputedStyle(e).zIndex, 10); if (!Number.isNaN(v)) return v; } return 0; };
open.sort((a, b) => z(a) - z(b) || ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1));
const top = open.length ? open[open.length - 1] : null;
const isTrigger = (el) => {
  if (el.matches('[aria-haspopup="dialog"],[popovertarget]')) return true;
  const id = el.getAttribute('aria-controls');
  const target = id && document.getElementById(id);
  return Boolean(target && (target.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]') || target.hasAttribute('popover')));
};
const isModal = (el) => { if (!el) return false; if (el.getAttribute('aria-modal') === 'true') return true; try { return el.matches(':modal'); } catch (e) { return false; } };
const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
const triggersIn = (root) => [...root.querySelectorAll('[aria-haspopup],[popovertarget],[aria-controls]')]
  .filter((el) => isTrigger(el) && shown(el) && (root !== document || !open.some((o) => o.contains(el))))
  .map((el) => ({ selector: sel(el), label: label(el) }));
let closeButton = null;
let backdropPoint = null;
if (top) {
  const closers = [...top.querySelectorAll('button,[role=button],a[href]')].filter(shown)
    .filter((el) => el.hasAttribute('data-close') || /^(close|cancel|dismiss|\\u00d7|\\u2715|x)$/i.test(label(el)));
  closeButton = closers.length ? sel(closers[0]) : null;
  const vw = innerWidth, vh = innerHeight, tr = top.getBoundingClientRect();
  let panel = top;
  if (tr.left <= 0 && tr.top <= 0 && tr.right >= vw && tr.bottom >= vh) {
    const kids = [...top.children].filter(shown);
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    if (kids.length) panel = kids.sort((a, b) => area(b) - area(a))[0];
  }
  const pr = panel.getBoundingClientRect();
  const point = [[8, 8], [vw - 8, 8], [8, vh - 8], [vw - 8, vh - 8]].find(([x, y]) => x < pr.left || x > pr.right || y < pr.top || y > pr.bottom);
  if (point) {
    const hit = document.elementFromPoint(point[0], point[1]);
    if (hit && ((top.contains(hit) && !panel.contains(hit)) || /backdrop|overlay|scrim/i.test(String(hit.className)))) backdropPoint = { x: point[0], y: point[1] };
  }
}
const scroller = document.scrollingElement || document.documentElement;
const active = document.activeElement && document.activeElement !== document.body ? sel(document.activeElement) : 'body';
// The focused element itself (inside open shadow roots), as a number this page load keeps for it: 0 is the document.
let deep = document.activeElement;
while (deep && deep.shadowRoot && deep.shadowRoot.activeElement) deep = deep.shadowRoot.activeElement;
if (!window.__qaFocusIds) { window.__qaFocusIds = new WeakMap(); window.__qaFocusNext = 1; }
const activeId = !deep || deep === document.body || deep === document.documentElement ? 0
  : (window.__qaFocusIds.has(deep) ? window.__qaFocusIds.get(deep) : (window.__qaFocusIds.set(deep, window.__qaFocusNext), window.__qaFocusNext++));
return { open: open.map((o) => ({ selector: sel(o), id: o.id || null })), active, activeId, activeInsideTop: Boolean(top && top.contains(document.activeElement)), modal: isModal(top),
  scrollY: scroller.scrollTop, scrollable: scroller.scrollHeight > scroller.clientHeight + 1, closeButton, backdropPoint,
  innerTriggers: top ? triggersIn(top) : [], triggers: triggersIn(document) };
`;

/** Runs every check of one overlay trigger; returns the raw observation (what the page read back after each input). */
export async function probeOverlay({ driver, trigger, tabLimit = 12, keyboardLimit = 80 }) {
  const state = () => driver.read(OVERLAY_STATE_BODY);
  const opened = async () => { await driver.reload(); await driver.click(trigger.selector); return state(); };
  const obs = { trigger };
  await driver.reload();
  const before = await state();
  if (before.open.length) return { ...obs, error: 'OVERLAY_OPEN_BEFORE_TRIGGER' };
  await driver.click(trigger.selector);
  const first = await state();
  const isOpen = first.open.length > 0;
  obs.overlay = isOpen ? first.open.at(-1).selector : null;
  obs.mouse = { opened: isOpen, overlay: obs.overlay, activeInside: first.activeInsideTop, modal: first.modal === true };
  if (isOpen) {
    const inside = [];
    for (let i = 0; i < tabLimit; i += 1) { await driver.press('Tab'); inside.push((await state()).activeInsideTop); }
    obs.trap = { presses: tabLimit, inside };
    if (before.scrollable) {
      const from = (await state()).scrollY;
      const attempt = await driver.scrollAttempt();
      obs.scroll = { scrollable: true, attempted: attempt?.attempted !== false, ...(attempt?.code ? { code: attempt.code } : {}), before: from, after: (await state()).scrollY };
    } else obs.scroll = { scrollable: false };
    const now = await state();
    if (now.innerTriggers.length) {
      await driver.click(now.innerTriggers[0].selector);
      const two = (await state()).open.length >= 2;
      await driver.press('Escape');
      obs.stacked = { available: true, opened: two, openAfterEsc: (await state()).open.map((entry) => entry.selector) };
    } else obs.stacked = { available: false };
  } else {
    obs.trap = { presses: 0, inside: [] };
    obs.scroll = { scrollable: before.scrollable };
    obs.stacked = { available: false };
  }
  // Each way out from a fresh page: Esc, the backdrop, the close button.
  let s = await opened();
  if (s.open.length) { await driver.press('Escape'); const after = await state(); obs.esc = { closed: after.open.length === 0, active: after.active }; }
  else obs.esc = { closed: false, active: s.active };
  s = await opened();
  if (s.open.length && s.backdropPoint) { await driver.clickAt(s.backdropPoint.x, s.backdropPoint.y); const after = await state(); obs.backdrop = { available: true, closed: after.open.length === 0, active: after.active }; }
  else obs.backdrop = { available: false };
  s = await opened();
  if (s.open.length && s.closeButton) { await driver.click(s.closeButton); const after = await state(); obs.button = { available: true, closed: after.open.length === 0, active: after.active }; }
  else obs.button = { available: false };
  // The way in by keyboard: Tab from the top of a fresh page to the trigger, then Enter.
  await driver.reload();
  let presses = 0;
  let reached = false;
  const seen = [];
  let cycled = false;
  while (presses < keyboardLimit && !reached && !cycled) {
    await driver.press('Tab'); presses += 1;
    const now = await state();
    reached = now.active === trigger.selector;
    cycled = !reached && focusCycled(seen, now.activeId);
    seen.push(now.activeId);
  }
  if (reached) { await driver.press('Enter'); obs.keyboard = { reachedTrigger: true, presses, opened: (await state()).open.length > 0 }; }
  else obs.keyboard = { reachedTrigger: false, presses, cycled };
  await driver.reload();
  return obs;
}

// Focus went round the whole page: the first control it reached has it again after a different control had it. `seen`
// and `active` are element identities (activeId: one number per element of the page load, 0 the document), never
// selector strings: two controls in one shadow host, or repeated cards, share a selector (fix round 2). Fix round 3
// (F2): one element can take several Tab stops in a row (the fields of a date input, a closed shadow host), so the
// first element again right after itself is no cycle, and neither is the document alone.
export function focusCycled(seen, active) {
  if (!seen.length || !Number.isInteger(active) || active === 0) return false;
  const at = seen.findIndex((id) => id !== 0);
  if (at < 0 || active !== seen[at]) return false;
  return seen.slice(at + 1).some((id) => id !== 0 && id !== active);
}

const slug = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'overlay';
const check = (rule, status, reason = null, detail = null) => ({ rule, status, reason, detail });
const absent = (rule, detail) => check(rule, 'UNGRADED', 'PRECONDITION_ABSENT', detail);

/** Grades one observation into the nine checks and the overlay's cells. Pure. */
export function gradeOverlay(obs) {
  const id = `dialog:${typeof obs?.overlay === 'string' && obs.overlay.startsWith('#') ? obs.overlay.slice(1) : slug(obs?.trigger?.label)}`;
  if (!obs || obs.error || !obs.mouse) {
    const checks = Object.keys(OVERLAY_RULES).map((rule) => check(rule, 'UNGRADED', 'UNMEASURED', obs?.error ?? 'no observation'));
    return { id, checks, cells: cellsOf(id, checks) };
  }
  const checks = [];
  checks.push(check('O1', obs.mouse.opened ? 'PASS' : 'FAIL', null, obs.mouse.opened ? null : 'a click on the trigger opened no overlay'));
  if (!obs.keyboard?.reachedTrigger) {
    checks.push(obs.keyboard?.cycled === true
      ? check('O2', 'FAIL', 'TRIGGER_NOT_REACHABLE', `Tab went round the page in ${obs.keyboard.presses} presses and never reached the trigger`)
      : check('O2', 'UNGRADED', 'TOOL_LIMIT', obs.keyboard?.lost ? `${obs.keyboard.lost} of the Tab presses left no sample (focus in a frame): the way to the trigger is unknown`
        : `Tab did not reach the trigger in ${obs.keyboard?.presses ?? 0} presses (the press limit)`));
  }
  else checks.push(check('O2', obs.keyboard.opened ? 'PASS' : 'FAIL', null, obs.keyboard.opened ? null : 'Enter on the trigger opened no overlay'));
  if (!obs.mouse.opened) {
    for (const rule of ['O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9']) checks.push(absent(rule, 'the overlay never opened'));
    return { id, checks, cells: cellsOf(id, checks) };
  }
  checks.push(check('O3', obs.esc?.closed ? 'PASS' : 'FAIL', null, obs.esc?.closed ? null : 'Esc left the overlay open'));
  checks.push(!obs.backdrop?.available ? absent('O4', 'no backdrop outside the panel') : check('O4', obs.backdrop.closed ? 'PASS' : 'FAIL', null, obs.backdrop.closed ? null : 'a click on the backdrop left it open'));
  checks.push(!obs.button?.available ? absent('O5', 'no close button found') : check('O5', obs.button.closed ? 'PASS' : 'FAIL', null, obs.button.closed ? null : 'its close button left it open'));
  const inside = Array.isArray(obs.trap?.inside) ? obs.trap.inside : [];
  // Focus trap (O6) and scroll lock (O8) are what a modal overlay owes; a non-modal dialog or a popover does neither.
  const modal = obs.mouse.modal !== false;
  if (!modal) checks.push(absent('O6', 'not a modal overlay'));
  else if (!inside.length) checks.push(check('O6', 'UNGRADED', 'UNMEASURED', 'no Tab press was read'));
  else checks.push(check('O6', obs.mouse.activeInside && inside.every(Boolean) ? 'PASS' : 'FAIL', null,
    !obs.mouse.activeInside ? 'focus did not move into the overlay' : inside.every(Boolean) ? null : `focus left the overlay on Tab ${inside.indexOf(false) + 1}`));
  const closes = [['Esc', obs.esc], ['close button', obs.button], ['backdrop', obs.backdrop]].filter(([, entry]) => entry?.closed);
  if (!closes.length) checks.push(absent('O7', 'no way of closing it worked'));
  else {
    const lost = closes.filter(([, entry]) => entry.active !== obs.trigger.selector);
    checks.push(check('O7', lost.length ? 'FAIL' : 'PASS', null, lost.length ? lost.map(([how, entry]) => `after ${how} focus is on ${entry.active}`).join('; ') : null));
  }
  if (!modal) checks.push(absent('O8', 'not a modal overlay'));
  else if (!obs.scroll?.scrollable) checks.push(absent('O8', 'the page behind is too short to scroll'));
  else if (obs.scroll.attempted === false) checks.push(check('O8', 'UNGRADED', 'UNMEASURED', `no scroll gesture was dispatched${obs.scroll.code ? ` (${obs.scroll.code})` : ''}`));
  else checks.push(check('O8', obs.scroll.after === obs.scroll.before ? 'PASS' : 'FAIL', null, obs.scroll.after === obs.scroll.before ? null : `the page behind scrolled ${obs.scroll.before} -> ${obs.scroll.after}`));
  if (!obs.stacked?.available) checks.push(absent('O9', 'no overlay opens from inside this one'));
  else {
    const kept = Array.isArray(obs.stacked.openAfterEsc) ? obs.stacked.openAfterEsc : [];
    const ok = obs.stacked.opened && kept.length === 1 && kept[0] === obs.overlay;
    checks.push(check('O9', ok ? 'PASS' : 'FAIL', null, ok ? null : `after one Esc the open overlays are [${kept.join(', ')}]`));
  }
  return { id, checks, cells: cellsOf(id, checks) };
}

// The cells of a trigger the check did not open (past the per-screen cap): listed as NOT_CHECKED (BUDGET), never graded.
export function notCheckedCells(trigger) {
  const id = `dialog:${slug(trigger?.label)}`;
  return Object.values(CELL_ACTIONS).map((action) => ({ route: id, state: 'ideal', action, status: 'NOT_CHECKED', reason: 'BUDGET' }));
}

function cellsOf(id, checks) {
  return checks.filter((entry) => CELL_ACTIONS[entry.rule]).map((entry) => ({ route: id, state: 'ideal', action: CELL_ACTIONS[entry.rule], rule: entry.rule, status: entry.status }));
}

/** The inventory and every overlay check of one screen: the `qa-gui/overlay-check/v1` receipt. */
export async function checkOverlays({ driver, route, tabLimit, keyboardLimit }) {
  await driver.reload();
  const { triggers } = await driver.read(OVERLAY_STATE_BODY);
  const overlays = [];
  for (const trigger of triggers) {
    const observation = await probeOverlay({ driver, trigger, tabLimit, keyboardLimit });
    const graded = gradeOverlay(observation);
    overlays.push({ id: graded.id, trigger, observation, checks: graded.checks, cells: graded.cells });
  }
  return { schema: OVERLAY_CHECK_SCHEMA, route: route ?? null, triggers, overlays };
}

/**
 * The gate's reading of an overlay check: every overlay regraded from its observation (stored statuses are not
 * trusted). FAIL when a check fails; UNGRADED when a check could not be measured; a check whose condition is absent is
 * reported by the grader but does not change the verdict.
 */
export function overlayVerdict(receipt) {
  if (receipt?.schema !== OVERLAY_CHECK_SCHEMA || !Array.isArray(receipt.overlays)) return { verdict: 'UNGRADED', issues: ['OVERLAY_RECEIPT_INVALID'] };
  const issues = [];
  let verdict = 'PASS';
  for (const overlay of receipt.overlays) {
    const graded = gradeOverlay(overlay?.observation);
    for (const entry of graded.checks) {
      if (entry.status === 'FAIL') { issues.push(`OVERLAY_${entry.rule}_FAIL:${graded.id}`); verdict = 'FAIL'; }
      else if (entry.status === 'UNGRADED' && entry.reason === 'UNMEASURED') { issues.push(`OVERLAY_${entry.rule}_${entry.reason}:${graded.id}`); if (verdict !== 'FAIL') verdict = 'UNGRADED'; }
      // Fix round 2 (E5): a tool limit (the press limit, samples lost to a frame) leaves that one cell UNGRADED; it is
      // reported and never makes the whole screen UNGRADED.
      else if (entry.status === 'UNGRADED' && entry.reason === 'TOOL_LIMIT') issues.push(`OVERLAY_${entry.rule}_${entry.reason}:${graded.id}`);
    }
  }
  return { verdict, issues };
}

function readValue(result, as) {
  const step = Array.isArray(result?.results) ? result.results.find((entry) => entry?.step === 'read' && entry?.as === as) : null;
  let value = step?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return value;
}

// The overlay driver over Dragon: trusted input in `do` steps (clickSelector, clickXY, key, and the trusted wheel step
// `scroll {delta}`), reads as `read` steps. A fresh page is a `goto` step to `url` (it waits for the load), or, without a
// url, reloadTab + waitForState. Click steps carry `fast:false` unless `fast` (the R3 fast-click plan for the case,
// fastClickAllowed) is true.
export function dragonOverlayDriver({ rpc, binding = {}, tabId, url = null, timeoutMs = 10_000, fast = false }) {
  const step = (one) => rpc('do', { ...binding, tabId, steps: [withClickSpeed(one, fast)] });
  return {
    click: (selector) => step({ clickSelector: selector }),
    clickAt: (x, y) => step({ clickXY: [x, y] }),
    press: (key) => step({ key }),
    async read(body) { return readValue(await step({ read: body, as: 'v' }), 'v'); },
    async scrollAttempt() {
      const result = await step({ scroll: { delta: 400 } });
      const done = Array.isArray(result?.results) ? result.results.find((entry) => entry?.step === 'scroll') : null;
      return done?.ok === false || result?.ok === false ? { attempted: false, code: String(done?.code ?? result?.code ?? 'SCROLL_FAILED') } : { attempted: true };
    },
    async reload() {
      if (url) { await step({ goto: url }); return; }
      await rpc('reloadTab', { ...binding, tabId });
      await rpc('waitForState', { ...binding, tabId, state: 'complete', timeoutMs });
    },
  };
}
