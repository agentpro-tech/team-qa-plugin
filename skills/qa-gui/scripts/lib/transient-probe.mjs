// Upgrade R1d: the probe window around a risky action (references/transient-rules.md).
// - classifyAction: when to switch the probe on, by action type and DOM.
// - PROBE_PLAN / sampleRead: what the window records (Dragon R1a sensors before the action, the frame window just
//   before it, geometry samples at fixed marks), −100 ms to +1000 ms, extended in 250 ms steps up to +3 s while the
//   network is busy or an anomaly is still open.
// - keepRanges / selectKeyframes: keep only frames with an anomaly (Dragon drops duplicates), and show the VLM 3–6
//   keyframes plus the clean frame; geometry and timing are measured by machine (transient-rules.mjs).
// - buildTransientProbeReceipt / transientProbeVerdict: the probe receipt (qa-gui/transient-probe/v1) and the gate's
//   grader, which re-runs the rules on the recorded streams and never trusts a stored verdict.
// - runTransientProbe: the driver over Dragon RPCs (HR1: actions and observation go through Dragon).
import { T_DEFAULTS, T_RULES, gradeTransientRules, gradeTrial, isBusy, transientVerdict } from './transient-rules.mjs';
import { conditionsRecordErrors } from './dragon-env.mjs';
import { withClickSpeed } from './fast-click.mjs';

export const TRANSIENT_PROBE_SCHEMA = 'qa-gui/transient-probe/v1';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── when the probe is on ───────────────────────────────────────────────────────────────────────────────────────
const words = (t) => ` ${String(t ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ')} `;
// Whole words in any script (\b only knows ASCII letters, and labels may be Vietnamese).
const anyOf = (list) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${list.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'u');
const LABEL = {
  submit: anyOf(['submit', 'send', 'sign ?in', 'log ?in', 'sign ?up', 'register', 'place order', 'checkout', 'pay', 'confirm', 'continue', 'next', 'apply',
    'g\u1eedi', '\u0111\u0103ng nh\u1eadp', '\u0111\u0103ng k\u00fd', 'thanh to\u00e1n', 'x\u00e1c nh\u1eadn', 'ti\u1ebfp t\u1ee5c']),
  save: anyOf(['save', 'save changes', 'update', 'done', 'publish', 'l\u01b0u', 'c\u1eadp nh\u1eadt', 'xong']),
  delete: anyOf(['delete', 'remove', 'discard', 'trash', 'archive', 'clear all', 'x\u00f3a', 'xo\u00e1', 'g\u1ee1', 'h\u1ee7y b\u1ecf']),
  add: anyOf(['add', 'add item', 'new', 'create', 'insert', 'th\u00eam', 't\u1ea1o']),
  sort: anyOf(['sort', 'order by', 's\u1eafp x\u1ebfp']),
  filter: anyOf(['filter', 'search', 'find', 'apply filters?', 'l\u1ecdc', 't\u00ecm']),
  close: anyOf(['close', 'cancel', 'dismiss', 'done', 'back', '\u0111\u00f3ng', 'h\u1ee7y', '\u00d7', '\u2715']),
  theme: anyOf(['theme', 'dark', 'light', 'mode', 'language', 'lang', 'locale', 'english', 'ti\u1ebfng vi\u1ec7t', 'giao di\u1ec7n', 'ng\u00f4n ng\u1eef']),
  more: anyOf(['load more', 'show more', 'see more', 'xem th\u00eam', 't\u1ea3i th\u00eam']),
  toast: anyOf(['copy', 'copy link', 'copied', 'undo', 'share', 'sao ch\u00e9p', 'ho\u00e0n t\u00e1c']),
};
/**
 * @param action {method: 'click'|'type'|'key'|'drag'|'scroll'|'select', key?, target: {tag, type?, role?, label?, href?,
 *   ariaExpanded?, ariaHaspopup?, ariaControlsDialog?, ariaSelected?, popovertarget?, inForm?, inList?, inDialog?,
 *   sortable?, searchbox?}, page?: {toastRegion?, infiniteScroll?, sameOrigin?}}
 *   (DOM facts the executor reads from Dragon perceive/read before the action)
 * @returns {risky, kinds:[...], reasons:[...]}
 */
export function classifyAction(action) {
  const a = object(action) ? action : {}, t = object(a.target) ? a.target : {}, page = object(a.page) ? a.page : {};
  const kinds = new Set(), reasons = [];
  const add = (kind, why) => { if (!kinds.has(kind)) { kinds.add(kind); reasons.push(`${kind}:${why}`); } };
  const label = words([t.label, t.ariaLabel, t.title, t.value].filter(Boolean).join(' '));
  const tag = String(t.tag ?? '').toLowerCase(), role = String(t.role ?? '').toLowerCase(), type = String(t.type ?? '').toLowerCase();
  const method = String(a.method ?? 'click').toLowerCase();
  const pointer = method === 'click';
  if (method === 'drag') add('drag-drop', 'drag');
  // Round G (G5): the entry probe's action is the navigation that shows a screen.
  if (method === 'goto') add('route-change', 'navigation');
  if (method === 'scroll' && page.infiniteScroll) add('scroll-load', 'scroll on an infinite list');
  if (pointer && LABEL.more.test(label)) add('scroll-load', 'load more');
  if (pointer && (type === 'submit' || (tag === 'button' && !type && t.inForm))) add('submit', 'submit button');
  if (method === 'key' && a.key === 'Enter' && t.inForm && ['input', 'select'].includes(tag)) add('submit', 'Enter in a form field');
  if (pointer && LABEL.submit.test(label)) add('submit', 'label');
  if (pointer && LABEL.save.test(label)) add('save', 'label');
  if (pointer && LABEL.delete.test(label)) { add('delete', 'label'); if (t.inList) add('list-remove', 'delete in a list'); }
  if (pointer && LABEL.add.test(label) && (t.inList || page.list)) add('list-add', 'add to a list');
  if (pointer && (LABEL.sort.test(label) || role === 'columnheader' || t.sortable)) add('list-sort', 'sort');
  if ((pointer && LABEL.filter.test(label)) || (method === 'type' && (t.searchbox || type === 'search' || role === 'searchbox'))
    || (method === 'select' && (t.inToolbar || LABEL.filter.test(label)))) add('list-filter', 'filter');
  if (pointer && (kinds.has('submit') || kinds.has('save') || kinds.has('delete') || LABEL.toast.test(label)) && page.toastRegion) add('toast', 'the page has a toast region');
  if (pointer && LABEL.toast.test(label)) add('toast', 'label');
  if (pointer && tag === 'a' && t.href && !String(t.href).startsWith('#') && page.sameOrigin !== false) add('route-change', 'link');
  if (pointer && role === 'link' && !kinds.has('route-change')) add('route-change', 'link role');
  if (pointer && (t.ariaHaspopup || t.ariaControlsDialog || t.popovertarget)) add('overlay-open', 'opens a popup');
  if (pointer && t.inDialog && LABEL.close.test(label)) add('overlay-close', 'close in a dialog');
  if (method === 'key' && a.key === 'Escape') add('overlay-close', 'Escape');
  if (pointer && (tag === 'summary' || t.ariaExpanded != null || role === 'tab' || t.ariaSelected != null)) add('disclosure', 'accordion or tab');
  if ((pointer || method === 'select') && LABEL.theme.test(label)) add('theme-locale', 'theme or language');
  return { risky: kinds.size > 0, kinds: [...kinds], reasons };
}

// ── what the window records ────────────────────────────────────────────────────────────────────────────────────
// Dragon's default watch list (controls, links, dialogs, alerts, status and live regions, popovers, forms) plus the
// state surfaces the T rules follow: empty/error states, toasts, tooltips, banners, busy indicators.
export const PROBE_WATCH = 'button,a[href],input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=switch],[role=tab],'
  + '[role=menuitem],[role=option],[role=combobox],[role=dialog],[role=alertdialog],[role=alert],[role=status],[aria-live],dialog,[popover],form,'
  + '[role=tooltip],[role=menu],[role=listbox],[role=progressbar],[aria-busy=true],[aria-invalid=true],[class*=empty],[class*=error],'
  + '[class*=no-results],[data-testid*=empty],[data-testid*=error],[class*=toast],[class*=snackbar],[class*=tooltip],[class*=popover],'
  + '[class*=banner],[class*=drawer],[class*=modal],[class*=skeleton],[class*=spinner],[class*=loading]';
export const PROBE_PLAN = Object.freeze({
  windowBeforeMs: T_DEFAULTS.windowBeforeMs, windowAfterMs: T_DEFAULTS.windowAfterMs, windowMaxMs: T_DEFAULTS.windowMaxMs,
  extendStepMs: T_DEFAULTS.extendStepMs, sampleOffsetsMs: T_DEFAULTS.sampleOffsetsMs, sensorLeadMs: 150,
  sensors: Object.freeze({ watch: PROBE_WATCH, maxTargets: 300 }),
  frames: Object.freeze({ maxWidth: 480, quality: 50, everyNthFrame: 1, maxMs: 10000, maxFrames: 600 }),
  stop: Object.freeze({ edges: true, maxKeep: 24 }),
});

// The geometry sample (a Dragon `read`, MAIN world, read-only): page horizontal overflow, text clipped without an
// ellipsis, the action target's clickable state, busy indicators, focus and scroll, stamped on the page clock.
// As a function of the target selector (null: the focused element). `hold` says an anomaly is still showing (page
// overflow or clipped text), which keeps a Dragon frames.trial window open.
export const SAMPLE_FN = `(q) => { const t = performance.timeOrigin + performance.now(); const de = document.documentElement, b = document.body;
const vw = innerWidth, vh = innerHeight;
const part = (el) => { let s = String(el.localName || '?'); if (el.id) s += '#' + String(el.id).slice(0, 40);
  const c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : []; for (const x of c) s += '.' + x.slice(0, 30);
  const r = el.getAttribute('role'); if (r) s += '[role=' + r.slice(0, 20) + ']'; const d = el.getAttribute('data-testid') || el.getAttribute('data-test'); if (d) s += '[data-testid=' + d.slice(0, 30) + ']'; return s; };
const sel = (el) => { if (!el || el.nodeType !== 1) return null; const p = []; for (let n = el, i = 0; n && n.nodeType === 1 && i < 4; n = n.parentElement, i++) { p.unshift(part(n)); if (n.id) break; } return p.join('>').slice(0, 160); };
const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
  const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
const hid = (el) => !!el && /hidden|clip/.test(getComputedStyle(el).overflowX);
const overflowX = de.scrollWidth > de.clientWidth + 2 && !hid(de) && !hid(b);
const clipped = []; const all = b ? b.getElementsByTagName('*') : [];
for (let i = 0; i < all.length && i < 1500 && clipped.length < 8; i++) { const el = all[i];
  if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 2) continue;
  let text = false; for (const n of el.childNodes) { if (n.nodeType === 3 && n.nodeValue.trim()) { text = true; break; } } if (!text) continue;
  const cs = getComputedStyle(el); if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis' || !shown(el)) continue;
  clipped.push({ sel: sel(el), sw: el.scrollWidth, cw: el.clientWidth }); }
const tel = q ? document.querySelector(q) : document.activeElement;
const target = !tel || tel === b ? { found: false } : { found: true, sel: sel(tel), disabled: tel.disabled === true || tel.matches(':disabled'),
  ariaDisabled: tel.getAttribute('aria-disabled') === 'true', ariaBusy: !!tel.closest('[aria-busy="true"]'), pointerEvents: getComputedStyle(tel).pointerEvents, inert: !!tel.closest('[inert]') };
let busy = 0; for (const el of document.querySelectorAll('[aria-busy="true"],[role=progressbar],[class*=spinner],[class*=loading],[class*=loader]')) { if (shown(el)) busy++; }
return { t, hold: overflowX || clipped.length > 0, vw, vh, sx: Math.round(scrollX), sy: Math.round(scrollY), sw: de.scrollWidth, cw: de.clientWidth, overflowX, clipped, target, busy, active: sel(document.activeElement) }; }`;
export function sampleRead({ targetSelector = null } = {}) {
  const q = JSON.stringify(typeof targetSelector === 'string' && targetSelector ? targetSelector : null);
  return `(${SAMPLE_FN})(${q})`;
}

// Whether the window must stay open at time `now` (it never closes before +1000 ms nor stays past +3000 ms): the network
// is busy, or an anomaly is still open: an occlusion not over yet, overflow in the latest sample, or the page still
// changing in the last 150 ms (busy indicators excluded).
export function windowDecision({ trial, now, networkBusy = false, options = T_DEFAULTS }) {
  const age = now - trial.markT;
  if (age < options.windowAfterMs) return { close: false, reason: null };
  if (age >= options.windowMaxMs) return { close: true, reason: 'cap' };
  if (networkBusy) return { close: false, reason: 'network-busy' };
  // Only what had happened by `now` (a recorded trial holds later events too).
  trial = { ...trial, events: (trial.events || []).filter((e) => !finite(e?.t) || e.t <= now), samples: (trial.samples || []).filter((x) => finite(x?.t) && x.t <= now) };
  const g = gradeTrial({ ...trial, window: { from: trial.markT - options.windowBeforeMs, to: now } }, { options });
  const openEpisode = Object.values(g).some((r) => r.episodes.some((e) => e.measure?.open === true));
  const last = (trial.samples || []).filter((x) => finite(x?.t) && x.t <= now).at(-1);
  const overflowing = !!last && last.t > trial.markT && (last.overflowX || (last.clipped || []).length > 0);
  const recent = (trial.events || []).some((e) => e && finite(e.t) && e.t >= now - 150 && e.t <= now
    && ['mutation', 'layout-shift', 'resize', 'animation'].includes(e.k) && !isBusy(e.target ?? (e.targets || [])[0]));
  return openEpisode || overflowing || recent ? { close: false, reason: 'anomaly-open' } : { close: true, reason: null };
}

// What a trial needs from before its own events: the last hello, and the last visibility, size, scroll and focus
// state per target (a repeat without a reload starts with no fresh IntersectionObserver entries). Only the state of the
// trial's own document (Dragon's `doc` id) is carried: a reload starts from nothing.
export function carryOver(events, beforeT, doc = undefined) {
  const last = new Map();
  for (const e of (events || []).filter((x) => x && finite(x.t) && x.t < beforeT && (doc === undefined || x.doc === doc)).sort((a, b) => a.t - b.t)) {
    if (e.k === 'hello') last.set('hello', e);
    else if (['visibility', 'resize'].includes(e.k)) last.set(`${e.k}|${e.target}`, e);
    else if (e.k === 'scroll') last.set(`scroll|${e.target}`, e);
    else if (e.k === 'focus') last.set('focus', e);
  }
  return [...last.values()].sort((a, b) => a.t - b.t);
}

// Frames to keep: around every anomaly the rules found (all rules), else around the first and the last DOM change so
// the VLM still gets frames of the transition. Dragon adds the clean frame at the mark and the last frame (edges).
export function keepRanges(trial, options = T_DEFAULTS) {
  const g = gradeTrial(trial, { options });
  const ranges = [];
  for (const r of Object.values(g)) for (const e of r.episodes) ranges.push({ from: Math.round(e.from - 50), to: Math.round(Math.min(e.to, e.from + 600) + 50) });
  if (!ranges.length) {
    const changes = (trial.events || []).filter((e) => e && ['mutation', 'layout-shift', 'resize', 'animation'].includes(e.k) && e.t > trial.markT && e.t <= (trial.window?.to ?? Infinity)).map((e) => e.t).sort((a, b) => a - b);
    for (const t of [changes[0], changes.at(-1)].filter(finite)) ranges.push({ from: Math.round(t - 16), to: Math.round(t + 120) });
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of ranges) { const last = merged.at(-1); if (last && r.from <= last.to + 16) last.to = Math.max(last.to, r.to); else merged.push({ ...r }); }
  return merged.slice(0, 8);
}

// The VLM sees 3–6 keyframes of one trial plus the clean frame (kept by Dragon at the first mark, before the action).
export function selectKeyframes(trial, options = T_DEFAULTS) {
  const kept = (Array.isArray(trial?.frames?.kept) ? trial.frames.kept : []).filter((f) => f && finite(f.t)).slice().sort((a, b) => a.t - b.t);
  const clean = kept.filter((f) => f.t <= trial.markT).find((f) => f.reason === 'edge') ?? kept.filter((f) => f.t <= trial.markT).at(-1) ?? null;
  const pool = kept.filter((f) => f !== clean && f.t > trial.markT);
  const near = (t) => pool.reduce((best, f) => (!best || Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), null);
  const picks = new Map();
  const episodes = Object.values(gradeTrial(trial, { options })).flatMap((r) => r.episodes).sort((a, b) => a.from - b.from);
  for (const e of episodes) for (const t of [e.from + 16, (e.from + e.to) / 2, e.to + 16]) { const f = near(t); if (f) picks.set(f.seq, f); }
  let frames = [...picks.values()].sort((a, b) => a.t - b.t);
  if (frames.length > 6) frames = Array.from({ length: 6 }, (_, i) => frames[Math.floor(i * frames.length / 6)]);
  const need = Math.min(3, pool.length);
  for (let step = 0; frames.length < need && step < pool.length * 2; step++) {
    const f = pool[Math.floor((step * (pool.length - 1)) / Math.max(1, need - 1)) % pool.length] ?? pool[step % pool.length];
    if (!frames.includes(f)) frames.push(f); else { const other = pool.find((x) => !frames.includes(x)); if (other) frames.push(other); }
  }
  const brief = (f) => f && { seq: f.seq, t: f.t, reason: f.reason ?? null, file: f.file ?? null, sha256: f.sha256 ?? null };
  return { clean: brief(clean), frames: frames.sort((a, b) => a.t - b.t).map(brief) };
}

// Milliseconds the probe added to one action: its RPCs plus the wait past the moment the page settled (last DOM change
// or write response, plus the usual 100 ms quiet).
export function addedMs(trial) {
  const timing = object(trial?.timing) ? trial.timing : {};
  const rpc = ['sensorsStartMs', 'framesStartMs', 'framesStopMs', 'sensorsReadMs', 'samplesMs', 'decisionsMs'].reduce((s, k) => s + (finite(timing[k]) ? timing[k] : 0), 0);
  const activity = (trial.events || []).filter((e) => e && ['mutation', 'layout-shift', 'resize', 'animation'].includes(e.k) && e.t >= trial.markT && e.t <= (trial.window?.to ?? Infinity)).map((e) => e.t);
  const writes = (trial.network || []).filter((r) => finite(r?.t) && r.t >= trial.markT && r.t <= (trial.window?.to ?? Infinity)).map((r) => r.t);
  const settledAt = Math.max(trial.markT, ...activity, ...writes) + 100;
  return Math.round(rpc + Math.max(0, (trial.window?.to ?? settledAt) - settledAt));
}

// ── the probe receipt ──────────────────────────────────────────────────────────────────────────────────────────
const TRIAL_KEYS = ['index', 'markT', 'conditions', 'action', 'window', 'sensors', 'viewport', 'events', 'samples', 'network', 'held', 'frames', 'timing', 'streams'];
// repeatable: false when the action may not be repeated (no approved plan for repeats); see gradeTransientRules.
export function buildTransientProbeReceipt({ caseId, state, action, classification = classifyAction(action), trials, vision, schedule = 'events', repeatable = true }) {
  const list = (Array.isArray(trials) ? trials : []).map((t, index) => {
    const out = { index };
    for (const key of TRIAL_KEYS) if (key !== 'index' && t[key] !== undefined) out[key] = t[key];
    out.action = { ...(out.action ?? {}), kinds: classification.kinds };
    return out;
  });
  const rules = gradeTransientRules(list, { schedule, repeatable: repeatable !== false });
  const withAnomaly = list.find((t) => Object.values(gradeTrial(t)).some((r) => r.episodes.length)) ?? list[0];
  const keyframes = withAnomaly ? { trial: withAnomaly.index, ...selectKeyframes(withAnomaly) } : { trial: null, clean: null, frames: [] };
  const added = list.map(addedMs);
  const sorted = added.slice().sort((a, b) => a - b);
  return {
    schema: TRANSIENT_PROBE_SCHEMA, caseId, state,
    action: { label: action?.target?.label ?? null, method: action?.method ?? null, selector: action?.selector ?? null, kinds: classification.kinds, reasons: classification.reasons,
      repeatable: repeatable !== false },
    plan: { windowBeforeMs: PROBE_PLAN.windowBeforeMs, windowAfterMs: PROBE_PLAN.windowAfterMs, windowMaxMs: PROBE_PLAN.windowMaxMs,
      extendStepMs: PROBE_PLAN.extendStepMs, sampleOffsetsMs: [...PROBE_PLAN.sampleOffsetsMs], schedule },
    trials: list, keyframes,
    overhead: { addedMs: added, meanMs: added.length ? Math.round(added.reduce((s, x) => s + x, 0) / added.length) : null, medianMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null },
    rules, verdict: transientVerdict(rules),
    ...(vision ? { vision } : {}),
  };
}

// The frame window did not cover the action: it stopped before mark + windowAfterMs (20 ms tolerance, as the window
// span check), or no buffered frame is from before the action (the screen at the mark is unknown).
export function framesEarly(trial, options = T_DEFAULTS) {
  const f = trial?.frames;
  if (!object(f) || f.ok === false) return false;
  if (!finite(f.stoppedAt) || f.stoppedAt < trial.markT + options.windowAfterMs - 20) return true;
  const index = Array.isArray(f.index) ? f.index : [];
  return !index.some((x) => finite(x?.t) && x.t <= trial.markT);
}

/**
 * The gate's grader (R1e probe registry signature): re-run the rules on the receipt's recorded streams.
 * @returns {verdict: 'PASS'|'FAIL'|'UNGRADED', issues: [code], warnings: [code], rules}
 */
// The environment a trial ran in is the default one: no request rule, nothing forced on network, CPU, time zone,
// locale, media or animation.
function atDefault(c) {
  return object(c) && (!Array.isArray(c.requests) || c.requests.length === 0) && ['network', 'cpu', 'timezone', 'locale', 'media', 'animation'].every((key) => c[key] === null || c[key] === undefined);
}
export function transientProbeVerdict(receipt, options = T_DEFAULTS) {
  const issues = [], warnings = [];
  const bad = (code) => issues.push(code);
  if (receipt?.schema !== TRANSIENT_PROBE_SCHEMA || !Array.isArray(receipt.trials) || !receipt.trials.length || !object(receipt.action)
    || (receipt.action.repeatable !== undefined && typeof receipt.action.repeatable !== 'boolean')) {
    return { verdict: 'UNGRADED', issues: ['TRANSIENT_PROBE_INVALID'], warnings, rules: null };
  }
  for (const [i, t] of receipt.trials.entries()) {
    const at = `trial-${i}`;
    if (!object(t) || !finite(t.markT) || !Array.isArray(t.events) || !object(t.window) || !finite(t.window.to)) { bad(`TRANSIENT_TRIAL_INVALID:${at}`); continue; }
    const span = t.window.to - t.markT;
    if (span < options.windowAfterMs - 20) bad(`TRANSIENT_WINDOW_SHORT:${at}:${Math.round(span)}ms`);
    if (span > options.windowMaxMs + options.extendStepMs + 100) bad(`TRANSIENT_WINDOW_LONG:${at}:${Math.round(span)}ms`);
    if (span > options.windowAfterMs + options.extendStepMs && !['network-busy', 'anomaly-open'].includes(t.window.reason)) bad(`TRANSIENT_EXTENSION_UNEXPLAINED:${at}`);
    if (!finite(t.sensors?.startedAt) || t.sensors.startedAt > t.markT - options.windowBeforeMs) bad(`TRANSIENT_SENSORS_LATE:${at}`);
    if (t.sensors?.gap === true || (t.sensors?.overflow ?? 0) > 0 || (t.sensors?.pageDropped ?? 0) > 0) bad(`TRANSIENT_SENSORS_GAP:${at}`);
    const guard = finite(t.frames?.guardFrom) ? t.frames.guardFrom : t.frames?.startedAt;
    if (t.frames && t.frames.ok !== false && finite(guard) && guard > t.markT - options.windowBeforeMs) bad(`TRANSIENT_FRAMES_LATE:${at}`);
    // The window must have been open across [mark - before, mark + after]: closed after +after, and a frame on screen
    // at the action. A window that ended before the action (its max-ms passed first) saw nothing and proves nothing.
    if (t.frames && t.frames.ok !== false && framesEarly(t, options)) bad(`TRANSIENT_FRAMES_EARLY:${at}`);
    if (t.conditions != null && conditionsRecordErrors(t.conditions).length) bad(`TRANSIENT_CONDITIONS_INVALID:${at}`);
    if (t.conditions?.role === 'evidence') bad(`TRANSIENT_EVIDENCE_TAB:${at}`);
  }
  // Fix round 2 (E3): a probe made from Dragon frames.trial calls keeps every attempt. A trial that did not run its
  // action (or its setup, or has no trusted-input mark) is counted, never dropped; a repeatable action needs all its
  // trials; every trial ran at the default environment (after the case's envReset: no request rule, no forced network).
  if (receipt.attempts !== undefined) {
    if (!Array.isArray(receipt.attempts) || receipt.attempts.some((a) => !object(a) || typeof a.ok !== 'boolean')) bad('TRANSIENT_ATTEMPTS_INVALID');
    else {
      for (const a of receipt.attempts.filter((x) => !x.ok)) bad(`TRANSIENT_ATTEMPT_NOT_RUN:trial-${a.n}:${String(a.code ?? 'UNKNOWN')}`);
      const ran = receipt.attempts.filter((x) => x.ok).length;
      if (ran !== receipt.trials.length) bad('TRANSIENT_ATTEMPTS_INVALID');
      if (receipt.action.repeatable !== false && receipt.trials.length < options.confirmRepeats) bad(`TRANSIENT_REPEATS_REQUIRED:${receipt.trials.length}/${options.confirmRepeats}`);
      if (receipt.action.repeatable !== false && receipt.action.claimed === false) bad('TRANSIENT_REPEATS_REQUIRED:claimed-not-repeatable');
    }
    for (const [i, t] of receipt.trials.entries()) if (!atDefault(t?.conditions)) bad(`TRANSIENT_CONDITIONS_NOT_DEFAULT:trial-${i}`);
  }
  const k = receipt.keyframes;
  if (object(k) && k.trial != null) {
    const trial = receipt.trials[k.trial];
    const kept = new Map((trial?.frames?.kept ?? []).map((f) => [f.seq, f]));
    const frames = Array.isArray(k.frames) ? k.frames : [];
    if (frames.length > 6 || frames.some((f) => !kept.has(f?.seq) || f.t <= trial.markT) || (k.clean && (!kept.has(k.clean.seq) || k.clean.t > trial.markT))) bad('TRANSIENT_KEYFRAMES_INVALID');
  }
  if (issues.length) return { verdict: 'UNGRADED', issues, warnings, rules: null };
  const rules = gradeTransientRules(receipt.trials.map((t) => ({ ...t, action: { ...(t.action ?? {}), kinds: receipt.action.kinds } })), { options, repeatable: receipt.action.repeatable !== false });
  for (const r of Object.values(rules)) {
    const tag = `${r.rule}:${r.episode?.sub ?? r.reason}:${r.k}/${r.n}${r.mark != null ? `@${r.mark}ms` : ''}`;
    if (r.verdict === 'FAIL') issues.push(`TRANSIENT_${tag}`);
    else if (r.verdict === 'UNGRADED' && r.reason !== 'CONDITION_ABSENT') issues.push(`TRANSIENT_${r.rule}_${r.reason}:${r.k}/${r.n}`);
    else if (r.verdict === 'WARN') warnings.push(`TRANSIENT_${tag}:${r.reason}`);
  }
  let verdict = transientVerdict(rules);
  if (object(receipt.vision)) {
    const vis = receipt.vision;
    if (!['PASS', 'FAIL', 'UNGRADED'].includes(vis.verdict) || !['C10', 'C16'].includes(vis.rule)) { issues.push('TRANSIENT_VISION_INVALID'); if (verdict !== 'FAIL') verdict = 'UNGRADED'; }
    else if (vis.verdict === 'FAIL') { issues.push(`TRANSIENT_VISION_${vis.rule}_FAIL`); verdict = 'FAIL'; }
    else if (vis.verdict === 'UNGRADED' && verdict !== 'FAIL') { issues.push(`TRANSIENT_VISION_UNGRADED`); verdict = 'UNGRADED'; }
  }
  return { verdict, issues: verdict === 'PASS' ? [] : verdict === 'FAIL' ? issues.filter((c) => /_FAIL$|^TRANSIENT_T\d:/.test(c) || c.includes('VISION')) : issues, warnings, rules };
}

// ── the driver over Dragon ─────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const readValue = (result, as) => {
  const step = Array.isArray(result?.results) ? result.results.find((e) => e?.step === 'read' && e?.as === as) : null;
  let value = step ? step.value : result?.reads?.[as];
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return object(value) && finite(value.t) ? value : null;
};
async function readAll(rpc, base, since) {
  const events = []; let cursor = since, last = null;
  for (let i = 0; i < 20; i++) {
    const r = await rpc('sensors.read', { ...base, since: cursor, max: 2000 });
    if (!r || r.ok === false) return { ok: false, code: r?.code ?? 'SENSORS_READ_FAILED', events, cursor, last: r };
    events.push(...(r.events || [])); cursor = r.cursor; last = r;
    if (!r.more) break;
  }
  return { ok: true, events, cursor, gap: !!last?.gap, overflow: last?.overflow ?? 0, pageDropped: last?.pageDropped ?? 0 };
}

/**
 * Run the probe around `step` (one Dragon `do` step: {clickSelector}, {key}, {drag}, ...) `repeats` times at real speed.
 * rpc(method, params) -> the Dragon result. restore(i) puts the page back before repeat i (an approved plan decides
 * how; a write action repeated without approval is not repeated: its finding stays UNGRADED REPEATS_REQUIRED).
 * The caller ends the case with env.reset, as for every case.
 */
// schedule (for measuring the observation schedules, references/transient-rules.md): 'events' (the probe: sensors,
// samples, frames kept around anomalies), 'all' (every frame kept), 'fixed7' (no sensors; frames kept at the sample marks).
// repeatable: false when the plan does not approve repeating the action (a write, say): it runs once, and the receipt
// built from it says so (a single sighting is then a warning, UNCONFIRMED_SINGLE).
export async function runTransientProbe({ rpc, binding = {}, tabId, step, targetSelector = null, action, repeats = 3, restore = null, now = Date.now, options = T_DEFAULTS, schedule = 'events', repeatable = true, fast = false }) {
  if (repeatable === false) repeats = 1;
  // A click carries fast:false unless the R3 fast-click plan allows a fast click for this case (fastClickAllowed).
  step = withClickSpeed(step, fast);
  const base = { ...binding, tabId };
  const read = sampleRead({ targetSelector });
  const classification = classifyAction(action);
  const trials = [];
  const sensing = schedule !== 'fixed7';
  let t0 = now();
  const started = sensing ? await rpc('sensors.start', { ...base, watch: PROBE_PLAN.sensors.watch, maxTargets: PROBE_PLAN.sensors.maxTargets }) : { ok: true, startedAt: null, cursor: 0 };
  if (!started || started.ok === false) throw new Error(`TRANSIENT_SENSORS_START_FAILED:${started?.code ?? 'unknown'}`);
  const sensorsStartMs = now() - t0;
  const read0 = sensing ? (cur) => readAll(rpc, base, cur) : async (cur) => ({ ok: true, events: [], cursor: cur, gap: false, overflow: 0, pageDropped: 0 });
  // From the start of this sensor session: its first batch (hello, initial sizes and visibility) arrives during sensors.start.
  let cursor = 0;
  let history = [];
  for (let i = 0; i < repeats; i++) {
    if (i > 0 && restore) await restore(i);
    const timing = { sensorsStartMs: i === 0 ? sensorsStartMs : 0 };
    await sleep(PROBE_PLAN.sensorLeadMs);
    const trialStart = now();
    t0 = trialStart;
    const fw = await rpc('frames.start', { ...base, ...PROBE_PLAN.frames });
    timing.framesStartMs = now() - t0;
    const steps = [{ read, as: 's-pre' }, { wait: 100 }, step];
    let last = 0;
    for (const d of options.sampleOffsetsMs.filter((x) => x > 0)) { steps.push({ wait: d - last }, { read, as: `s${d}` }); last = d; }
    const actedAt = now();
    const done = await rpc('do', { ...base, steps });
    const samples = ['s-pre', ...options.sampleOffsetsMs.filter((x) => x > 0).map((d) => `s${d}`)].map((as) => readValue(done, as)).filter(Boolean);
    timing.samplesMs = Math.max(0, (now() - actedAt) - options.sampleOffsetsMs.at(-1) - 100);
    let sensed = await read0(cursor);
    const input = sensed.events.find((e) => e.k === 'input' && e.trusted && ['pointerdown', 'keydown'].includes(e.type) && e.t >= actedAt - 50);
    const receiptTs = (done?.results || []).map((r) => r?.receipt?.ts).find(finite);
    const markT = input?.t ?? receiptTs ?? actedAt;
    const trial = { markT, events: sensed.events, samples, network: [], frames: null, window: { from: markT - options.windowBeforeMs, to: now(), extended: false, reason: null }, action: { kinds: classification.kinds } };
    let decisionsMs = 0;
    for (;;) {
      const t1 = now();
      const idle = await rpc('waitForNetworkIdle', { ...base, idleMs: 100, timeoutMs: 120 });
      const decision = windowDecision({ trial: { ...trial, events: [...carryOver(history, Infinity), ...sensed.events], samples }, now: now(), networkBusy: idle?.timedOut === true || idle?.ok === false, options });
      decisionsMs += now() - t1;
      if (decision.close) break;
      if (decision.reason) { trial.window.extended = true; trial.window.reason = trial.window.reason ?? decision.reason; }
      const more = await rpc('do', { ...base, steps: [{ wait: options.extendStepMs }, { read, as: 'sx' }] });
      const s = readValue(more, 'sx'); if (s) samples.push(s);
      sensed = { ...sensed, ...(await read0(cursor)) };
    }
    trial.window.to = now();
    t0 = now();
    sensed = await read0(cursor);
    timing.sensorsReadMs = now() - t0;
    cursor = sensed.cursor;
    const own = sensed.events.filter((e) => finite(e?.t));
    const firstOwn = own.length ? Math.min(...own.map((e) => e.t)) : markT;
    const doc = own.find((e) => e.k === 'input' && e.doc)?.doc ?? own.filter((e) => e.doc).at(-1)?.doc;
    trial.events = [...carryOver(history, firstOwn, doc ?? null), ...own];
    history = [...carryOver(history, Infinity), ...own];
    trial.sensors = { startedAt: started.startedAt, streams: started.streams ?? null, gap: sensed.gap || sensed.ok === false, overflow: sensed.overflow, pageDropped: sensed.pageDropped };
    const keep = schedule === 'all' ? 'all' : schedule === 'fixed7' ? samples.map((x) => ({ from: Math.round(x.t - 16), to: Math.round(x.t + 16) }))
      : keepRanges(trial, options);
    t0 = now();
    const stopped = await rpc('frames.stop', { ...base, keep, ...PROBE_PLAN.stop });
    timing.framesStopMs = now() - t0;
    trial.frames = stopped && stopped.ok !== false
      ? { ok: true, windowId: stopped.windowId, dir: stopped.dir ?? null, startedAt: stopped.startedAt, guardFrom: stopped.guardFrom, stoppedAt: stopped.stoppedAt, marks: stopped.marks, counts: stopped.counts,
        keep, index: stopped.index, kept: (stopped.frames || []).map((f) => ({ seq: f.seq, t: f.t, reason: f.reason, file: f.file ?? null, sha256: f.sha256 ?? null })) }
      : { ok: false, code: stopped?.code ?? 'FRAMES_STOP_FAILED', startedAt: fw?.startedAt ?? null, keep, index: [] };
    const net = await rpc('getNetwork', { ...base, types: ['XHR', 'Fetch'] });
    trial.network = (net?.requests || []).filter((r) => finite(r?.t) && r.t >= markT - options.windowBeforeMs).map((r) => ({ t: r.t, method: r.method, url: r.url, status: r.status ?? null, ...(r.failed ? { failed: true } : {}) }));
    const env = await rpc('env.get', { ...base, readback: false });
    trial.conditions = env?.conditions ?? null;
    trial.held = Array.isArray(env?.held) ? env.held : [];
    timing.decisionsMs = decisionsMs;
    timing.wallMs = now() - trialStart;
    trial.timing = timing;
    trial.viewport = (() => { const h = trial.events.filter((e) => e.k === 'hello').at(-1); return h ? { vw: h.vw, vh: h.vh } : null; })();
    trials.push(trial);
  }
  if (sensing) await rpc('sensors.stop', base);
  return { classification, trials, repeatable: repeatable !== false };
}

export { T_RULES };
