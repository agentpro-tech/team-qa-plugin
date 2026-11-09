// Upgrade integration: the R1c, R1d and R1e detectors in a Team QA web-lane run. Contract:
// references/team-qa-detectors.md.
//
// In a Team QA run the GUI executor is a model on the Claude CLI that drives Dragon through its MCP tools and has no
// shell, so QA GUI's Node drivers (runTransientProbe, dragonGeometryReader, dragonOverlayDriver, dragonExploreDriver)
// cannot run there. The executor sends the same Dragon calls by recipe instead (detectorPromptSection renders them into
// the case dispatch), with labelled `read` steps and small page helpers installed once per page, and Team QA's
// `web collect` hands the calls of the executor's attested stream to the functions below. They rebuild each probe
// receipt with the detectors' own engines and graders: sweepWidths over a recorded reader, the observation
// probeOverlay makes, the explorer following the executor's own choices, the trial runTransientProbe builds, and
// gradeU1/U2/U3. A recipe that was not followed (a leg, a width or a read missing) gives an ungradable receipt or none,
// never a PASS, and the gate grades every receipt again from the files.
//
// A call is {method, params, result, ok, called_at?, at?} in stream order: `method` is the Dragon RPC (an R1a MCP tool
// name such as envSet is mapped to env.set), `result` is Dragon's result object, `called_at`/`at` are the stream's ISO
// times of the call and of its result.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAGON_R1A_TOOLS } from './dragon-env.mjs';
import { PROBE_PLAN, PROBE_WATCH, SAMPLE_FN, buildTransientProbeReceipt, carryOver, classifyAction, sampleRead, windowDecision } from './transient-probe.mjs';
import { T_DEFAULTS } from './transient-rules.mjs';
import { GEOMETRY_PROBE_BODY, sweepVerdict, sweepWidths } from './width-sweep.mjs';
import { EMULATION_BODY, VIEWPORT_BODY, paintConfirmation } from './width-sweep-dragon.mjs';
import { OVERLAY_CHECK_SCHEMA, OVERLAY_STATE_BODY, focusCycled, gradeOverlay, overlayVerdict } from './overlay-check.mjs';
import { EXPLORE_OBSERVE_BODY, UNMATCHED_CSS_BODY, explore } from './frontier-explorer.mjs';
import { foldUx, gradeU1, gradeU2, gradeU3, uxResult, uxSettings } from './ux-rules.mjs';
import { withClickSpeed } from './fast-click.mjs';
import { RESPONSIVE_MATRIX } from '../loop7/responsive-matrix.mjs';
import { buildAppMapV2 } from '../loop6/app-map.mjs';
import { routeOf, viewportRow } from './coverage-cell.mjs';

export const STREAM_DETECTORS_VERSION = 'qa-gui/stream-detectors/v1';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };
const duration = (call) => { const a = time(call?.called_at), b = time(call?.at); return a !== null && b !== null && b >= a ? b - a : 0; };

// ── the recorded calls as a flat list of operations ─────────────────────────────────────────────────────────────
const STEP_KINDS = ['read', 'clickSelector', 'clickXY', 'click', 'key', 'type', 'fill', 'hover', 'scroll', 'drag', 'goto', 'viewport',
  'clearViewport', 'wait', 'waitFor', 'dialog', 'select', 'clear', 'chord', 'assert', 'expectNet'];
const CLICKS = ['click', 'clickSelector', 'clickXY'];

// ── Dragon's do loop ({forEach}), expanded as Dragon expands it ────────────────────────────────────────────────────
const LOOP_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function loopSubstitute(node, name, value) {
  if (typeof node === 'string') {
    if (node === `$${name}`) return value;
    const key = new RegExp(`^\\$${escapeRe(name)}\\.([A-Za-z0-9_]+)$`).exec(node);
    if (key && object(value) && Object.hasOwn(value, key[1])) return value[key[1]];
    return node.replace(new RegExp(`\\$${escapeRe(name)}(?:\\.([A-Za-z0-9_]+))?(?![A-Za-z0-9_])`, 'g'), (all, k) => {
      if (k !== undefined) return object(value) && Object.hasOwn(value, k) ? String(value[k]) : all;
      return object(value) ? all : String(value);
    });
  }
  if (Array.isArray(node)) return node.map((x) => loopSubstitute(x, name, value));
  if (object(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, loopSubstitute(v, name, value)]));
  return node;
}
function loopValuesOf(spec) {
  if (!object(spec) || !LOOP_NAME.test(String(spec.name ?? ''))) return null;
  if (Array.isArray(spec.values)) return spec.values;
  if (!Array.isArray(spec.range)) return null;
  const [from, to, step = 1] = spec.range;
  if (![from, to, step].every(Number.isInteger) || step < 1 || to < from || (to - from) / step > 400) return null;
  const out = []; for (let v = from; v <= to; v += step) out.push(v);
  return out;
}
/**
 * The steps of one do as Dragon ran them: every top-level {forEach: {name, values|range}, steps} expanded with `$name`
 * substitution (Dragon helpers.cjs expandLoops). `origin[i]` is null for a step of the request, else {step, n, sub} of the loop it came from; null when
 * a loop cannot be expanded (then nothing of that do counts).
 */
export function expandDoSteps(steps) {
  if (!Array.isArray(steps) || !steps.some((x) => object(x) && Object.hasOwn(x, 'forEach'))) return { steps, origin: null };
  const out = [], origin = [];
  for (const [index, step] of steps.entries()) {
    if (!object(step) || !Object.hasOwn(step, 'forEach')) { out.push(step); origin.push(null); continue; }
    const values = loopValuesOf(step.forEach);
    if (!values || !Array.isArray(step.steps)) return null;
    values.forEach((value, n) => step.steps.forEach((inner, sub) => { out.push(loopSubstitute(inner, step.forEach.name, value)); origin.push({ step: index, n, sub }); }));
  }
  return { steps: out, origin };
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A brief Dragon answer names an expanded step by the first 16 hex digits of the sha-256 of its JSON.
export const ranHash = (step) => createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 16);

/**
 * Every `do`/runFlow step (with its result) and every other call, in stream order. A do with loops is expanded as
 * Dragon expands it (expandDoSteps); an expanded step counts only when Dragon's result names that same step (`ran`) and
 * place (`each`; a brief answer names the step by `ranHash`), so what ran is rebuilt from the request and checked against
 * Dragon's answer (fix round 2, E9).
 */
export function dragonOps(calls) {
  const ops = [];
  (Array.isArray(calls) ? calls : []).forEach((call, ci) => {
    if (!object(call)) return;
    const method = DRAGON_R1A_TOOLS[call.method] ?? call.method;
    const ok = call.ok !== false && call.result?.ok !== false;
    // A frames.trial (one probe trial in one Dragon call) is an op of its own; its action steps stay inside it.
    if ((method === 'do' || method === 'runFlow') && Array.isArray(call.params?.steps)) {
      const results = Array.isArray(call.result?.results) ? call.result.results : [];
      const expanded = expandDoSteps(call.params.steps);
      const steps = expanded ? expanded.steps : call.params.steps;
      steps.forEach((step, si) => {
        if (!object(step)) return;
        const from = expanded?.origin?.[si] ?? null;
        const each = from ? results[si] : null;
        const loopOk = expanded !== null && (from === null ? true : object(each) && (sameJson(each.ran, step) || each.ranHash === ranHash(step)) && object(each.each) && each.each.step === from.step && each.each.n === from.n && each.each.sub === from.sub);
        // A Dragon helper call ({call: name}) runs as a read; its result names the code that ran (helper: {name, sha256}).
        const kind = typeof step.call === 'string' ? 'read' : STEP_KINDS.find((k) => Object.hasOwn(step, k) && step[k] !== undefined && step[k] !== null && step[k] !== false) ?? 'other';
        const res = object(results[si]) ? results[si] : null;
        const failed = res === null || res.ok === false || (kind === 'read' && object(res.value) && Object.hasOwn(res.value, '__read_error')) || !loopOk;
        ops.push({ ci, si, kind, step, res, ok: ok && !failed, call, method, ...(from ? { loop: from } : {}) });
      });
      return;
    }
    ops.push({ ci, si: null, kind: 'rpc', method, params: object(call.params) ? call.params : {}, result: call.result ?? null, ok, call });
  });
  return ops;
}

const valueOf = (op) => {
  let v = op?.res?.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* a plain string value */ } }
  return v;
};
const isRead = (op, as) => op.kind === 'read' && op.ok && op.step.as === as;
const lastRead = (ops, as, from = 0, to = ops.length) => { for (let k = to - 1; k >= from; k -= 1) if (isRead(ops[k], as)) return k; return -1; };
const firstRead = (ops, as, from = 0, to = ops.length) => { for (let k = from; k < to; k += 1) if (isRead(ops[k], as)) return k; return -1; };
const rpcAfter = (ops, method, from, to = ops.length) => { for (let k = from; k < to; k += 1) if (ops[k].kind === 'rpc' && ops[k].method === method) return k; return -1; };
const rpcBefore = (ops, method, from, to) => { for (let k = to - 1; k >= from; k -= 1) if (ops[k].kind === 'rpc' && ops[k].method === method) return k; return -1; };

// The viewport an operation sets: {width, height, dpr, mobile}, 'clear', or undefined when it sets none.
function viewportSet(op) {
  if (!op.ok) return undefined;
  const norm = (v) => (object(v) ? { width: Math.round(Number(v.w ?? v.width)), height: Math.round(Number(v.h ?? v.height)),
    dpr: Number(v.dsf ?? v.dpr ?? v.deviceScaleFactor) || 0, mobile: v.mobile === true } : undefined);
  if (op.kind === 'rpc' && (op.method === 'setViewport' || op.method === 'emulateViewport')) return norm(op.params);
  if (op.kind === 'rpc' && op.method === 'clearViewport') return 'clear';
  if (op.kind === 'viewport') return norm(op.step.viewport);
  if (op.kind === 'clearViewport') return 'clear';
  return undefined;
}
function viewportBefore(ops, index) {
  for (let k = index - 1; k >= 0; k -= 1) { const v = viewportSet(ops[k]); if (v !== undefined) return v; }
  return null;
}

// ── page helpers: sent once per dispatch (Dragon helpers.define), called by name ({call}) ─────────────────────────
// The executor never re-types a helper: it defines QA GUI's own bodies once, and every detector read is a {call}
// whose result carries the sha-256 of the body Dragon ran. A detector read that does not prove QA GUI's body (a raw
// read, another body) is not counted: the detector is UNGRADED with DETECTOR_HELPER_MISMATCH.
const bodyFn = (body) => `() => {${body}}`;
export const SWEEP_DEFAULTS = Object.freeze({ min: 320, max: 1440, step: 20, height: 800 });
const MATRIX = RESPONSIVE_MATRIX.map((r) => ({ id: r.id, w: r.w, h: r.h, dpr: r.dpr, profile: r.profile }));
const SWEEP_FN = `(mode) => {
const geo = ${bodyFn(GEOMETRY_PROBE_BODY)};
const viewport = ${bodyFn(VIEWPORT_BODY)};
const emulation = ${bodyFn(EMULATION_BODY)};
const MIN = ${SWEEP_DEFAULTS.min}, MAX = ${SWEEP_DEFAULTS.max}, STEP = ${SWEEP_DEFAULTS.step}, MATRIX = ${JSON.stringify(MATRIX)};
if (!window.__qaSweep2 || mode === 'found') window.__qaSweep2 = new Map();
const log = window.__qaSweep2;
const idOf = (f) => f.rule + '|' + f.selector;
const sig = (e) => e.layout + '\\u0000' + e.failures.map(idOf).sort().join('\\u0001');
if (mode === 'found') return Object.assign({}, viewport(), { href: location.href });
if (mode === 'viewport') return viewport();
if (mode === 'emu') return emulation();
// The layout signature is long; the answer carries its digest (the sweep only compares layouts for equality).
const digest = (text) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return 'fnv1a:' + h.toString(16).padStart(8, '0') + ':' + text.length; };
if (mode === 'measure') { const v = geo(); const e = { layout: typeof v.layout === 'string' ? v.layout : '', failures: Array.isArray(v.failures) ? v.failures : [] }; log.set(innerWidth, e); return { width: v.width, vw: innerWidth, layout: digest(e.layout), failures: e.failures }; }
if (mode === 'refine') { const coarse = []; for (let w = MIN; w < MAX; w += STEP) coarse.push(w); coarse.push(MAX); const out = [];
  for (let i = 1; i < coarse.length; i++) { const a = log.get(coarse[i - 1]), b = log.get(coarse[i]); if (!a || !b || sig(a) === sig(b)) continue;
    for (let w = coarse[i - 1] + 1; w < coarse[i]; w++) if (!log.has(w)) out.push(w); }
  return out; }
if (mode === 'bands') { const widths = [...log.keys()].filter((w) => w >= MIN && w <= MAX).sort((a, b) => a - b); const ids = [];
  for (const w of widths) for (const f of log.get(w).failures) if (!ids.includes(idOf(f))) ids.push(idOf(f));
  const bands = [];
  for (const id of ids) { let run = null;
    for (const w of widths) { const f = log.get(w).failures.find((x) => idOf(x) === id);
      if (f) { if (!run) run = { id, rule: f.rule, from: w, to: w, target: f.target || null }; else run.to = w; }
      else if (run) { bands.push(run); run = null; } }
    if (run) bands.push(run); }
  const rows = [];
  for (const band of bands) { band.rows = MATRIX.filter((r) => r.w >= band.from && r.w <= band.to).map((r) => r.id);
    for (const id of band.rows) if (!rows.some((r) => r.id === id)) { const r = MATRIX.find((m) => m.id === id); rows.push({ id, width: r.w, height: r.h, deviceScaleFactor: r.dpr, mobile: r.profile === 'mobile' }); } }
  return { bands, rows }; }
return null;
}`;
// The overlay state; 'triggers' adds the screen's trigger list and the page's href, 'log' starts a log of where focus is
// after each Tab (one sample per Tab keyup: the selector and the element's identity), 'keylog' returns it. Fix round 3
// (F5): any other read carries the href too when the page's URL is new to the helper (a fresh document after a goto, a
// client-side redirect), so the read after each goto says where the page was and the answers stay small.
const OVERLAY_FN = `(mode) => {
const state = ${bodyFn(OVERLAY_STATE_BODY)};
if (mode === 'keylog') { const log = window.__qaKeylog; return { started: !!log, samples: log ? log.samples.slice(0, 80) : [] }; }
const s = state();
if (mode === 'log') {
  window.__qaKeylog = { samples: [] };
  if (!window.__qaKeylogOn) { window.__qaKeylogOn = true; window.addEventListener('keyup', (e) => { if (e.key !== 'Tab' || !window.__qaKeylog) return; const v = state(); window.__qaKeylog.samples.push({ active: v.active, id: v.activeId, inside: v.activeInsideTop }); }, true); }
}
if (mode !== 'triggers') delete s.triggers;
if (mode === 'triggers' || window.__qaHref !== location.href) s.href = location.href;
window.__qaHref = location.href;
return s;
}`;
const EXPLORE_FN = `(mode) => (mode === 'css' ? ${bodyFn(UNMATCHED_CSS_BODY)} : ${bodyFn(EXPLORE_OBSERVE_BODY)})()`;
const helperOf = (key, body) => { const digest = createHash('sha256').update(body).digest('hex'); return Object.freeze({ key, name: `qagui.${key}@${digest.slice(0, 12)}`, body, sha256: digest }); };
export const STREAM_HELPERS = Object.freeze({ sweep: helperOf('sweep', SWEEP_FN), overlay: helperOf('overlay', OVERLAY_FN), explore: helperOf('explore', EXPLORE_FN), sample: helperOf('sample', SAMPLE_FN) });
/** A helper call step: {call: <QA GUI's helper name>, args, as}. */
export const helperCall = (key, args = null, as = null) => ({ call: STREAM_HELPERS[key].name, ...(args ? { args } : {}), ...(as ? { as } : {}) });
/** The helpersDefine argument for the given helpers. */
export const helperDefinitions = (keys) => Object.fromEntries(keys.map((key) => [STREAM_HELPERS[key].name, STREAM_HELPERS[key].body]));
// Fix round 2 (E9): the helper bodies ship as a Dragon helper pack (dragon/helper-pack/v1) next to this module; the
// executor names its path and SHA-256 (helpersDefine {pack}) and Dragon reads and verifies it, so no body is typed.
export const HELPER_PACK_SCHEMA = 'dragon/helper-pack/v1';
export const HELPER_PACK_REL = 'scripts/lib/stream-helpers.pack.json';
/** The pack file's exact text (scripts/stream-helper-pack.mjs writes it; a test keeps the shipped file equal to it). */
export const helperPackText = () => `${JSON.stringify({ schema: HELPER_PACK_SCHEMA, version: STREAM_DETECTORS_VERSION, helpers: helperDefinitions(Object.keys(STREAM_HELPERS)) }, null, 2)}\n`;
export const HELPER_PACK_SHA256 = createHash('sha256').update(helperPackText()).digest('hex');
/** {path, sha256} of the pack in a QA GUI install (`root`; default: this module's own install). */
export function helperPack(root = null) {
  const path = root ? join(root, HELPER_PACK_REL) : fileURLToPath(new URL('./stream-helpers.pack.json', import.meta.url));
  return { path, sha256: HELPER_PACK_SHA256 };
}
const proves = (op, key) => op.step?.call === STREAM_HELPERS[key].name && op.res?.helper?.sha256 === STREAM_HELPERS[key].sha256;
// The ops with every labelled read of one detector (label prefix) that does not prove QA GUI's helper turned into a
// failed op; `mismatch` says one was there.
export function provenOps(ops, key, prefix) {
  let mismatch = false;
  const out = ops.map((op) => {
    if (op.kind !== 'read' || typeof op.step?.as !== 'string' || !op.step.as.startsWith(prefix) || proves(op, key)) return op;
    mismatch = true;
    return { ...op, ok: false };
  });
  return { ops: out, mismatch };
}
export const DETECTOR_HELPER_MISMATCH = 'DETECTOR_HELPER_MISMATCH';
// Every measurement after a viewport change waits for the layout to settle (matchMedia and ResizeObserver handlers).
export const SETTLE_MS = 150;
function settledRead(ops, k) {
  for (let i = k - 1; i >= 0; i -= 1) {
    if (viewportSet(ops[i]) !== undefined) return false;
    if (ops[i].ok && ops[i].kind === 'wait' && Number(ops[i].step.wait) >= SETTLE_MS) return true;
  }
  return true;
}

// ── R1e width sweep ─────────────────────────────────────────────────────────────────────────────────────────────
/** The page helper of the sweep (installed by the first read of the recipe, which returns the viewport it found). */
export function sweepInstallBody({ min = SWEEP_DEFAULTS.min, max = SWEEP_DEFAULTS.max, step = SWEEP_DEFAULTS.step } = {}) {
  return `(() => {
const geo = () => {${GEOMETRY_PROBE_BODY}};
const MIN = ${min}, MAX = ${max}, STEP = ${step}, MATRIX = ${JSON.stringify(MATRIX)};
const log = new Map();
const idOf = (f) => f.rule + '|' + f.selector;
const sig = (e) => e.layout + '\\u0000' + e.failures.map(idOf).sort().join('\\u0001');
window.__qaSweep = {
  measure() { const v = geo(); const e = { layout: typeof v.layout === 'string' ? v.layout : '', failures: Array.isArray(v.failures) ? v.failures : [] }; log.set(innerWidth, e); return Object.assign({}, v, { vw: innerWidth }); },
  refine() { const coarse = []; for (let w = MIN; w < MAX; w += STEP) coarse.push(w); coarse.push(MAX); const out = [];
    for (let i = 1; i < coarse.length; i++) { const a = log.get(coarse[i - 1]), b = log.get(coarse[i]); if (!a || !b || sig(a) === sig(b)) continue;
      for (let w = coarse[i - 1] + 1; w < coarse[i]; w++) if (!log.has(w)) out.push(w); }
    return out; },
  bands() { const widths = [...log.keys()].filter((w) => w >= MIN && w <= MAX).sort((a, b) => a - b); const ids = [];
    for (const w of widths) for (const f of log.get(w).failures) if (!ids.includes(idOf(f))) ids.push(idOf(f));
    const bands = [];
    for (const id of ids) { let run = null;
      for (const w of widths) { const f = log.get(w).failures.find((x) => idOf(x) === id);
        if (f) { if (!run) run = { id, rule: f.rule, from: w, to: w, target: f.target || null }; else run.to = w; }
        else if (run) { bands.push(run); run = null; } }
      if (run) bands.push(run); }
    const rows = [];
    for (const band of bands) { band.rows = MATRIX.filter((r) => r.w >= band.from && r.w <= band.to).map((r) => r.id);
      for (const id of band.rows) if (!rows.some((r) => r.id === id)) { const r = MATRIX.find((m) => m.id === id); rows.push({ id, width: r.w, height: r.h, deviceScaleFactor: r.dpr, mobile: r.profile === 'mobile' }); } }
    return { bands, rows }; },
};
${VIEWPORT_BODY}
})()`;
}
export const SWEEP_CALLS = Object.freeze({ measure: '__qaSweep.measure()', refine: '__qaSweep.refine()', bands: '__qaSweep.bands()' });

/**
 * The reader sweepWidths uses over the recorded calls: `w:found` (the install read), `w:<width>` after a viewport of that
 * width (DPR 1, desktop), `paintSnapshot {selector}` and an evidence capture at a band's width, `w:row:<id>:emu` and
 * `w:row:<id>:geo` after the row's own viewport, and `w:restored` after the viewport is put back.
 * captureRef(op) -> what the receipt stores for a capture (Team QA: the in-run copy and its SHA-256).
 */
export function recordedGeometryReader(ops, { captureRef = null } = {}) {
  const measured = (k, width) => { const v = viewportBefore(ops, k); return object(v) && v.width === width && v.dpr === 1 && v.mobile === false && settledRead(ops, k); };
  return {
    found() {
      const k = firstRead(ops, 'w:found');
      const v = k >= 0 ? valueOf(ops[k]) : null;
      return object(v) && Number.isInteger(v.width) && Number.isInteger(v.height) ? { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.touch === true } : null;
    },
    async measure(width) {
      for (let k = ops.length - 1; k >= 0; k -= 1) {
        if (!isRead(ops[k], `w:${width}`) || !measured(k, width)) continue;
        const v = valueOf(ops[k]);
        // Fix round 2 (E8): the measure call's own vw and a failure list, or it is not that width's measure.
        if (object(v) && v.vw === width && Array.isArray(v.failures)) return v;
      }
      throw new Error(`SWEEP_WIDTH_NOT_RECORDED:${width}`);
    },
    async confirm(width, failure) {
      if (failure?.rule === 'W1') return { status: 'CONFIRMED', reason: 'SCROLL_WIDTH' };
      const selector = failure?.target ?? failure?.selector;
      for (let k = ops.length - 1; k >= 0; k -= 1) {
        const op = ops[k];
        if (op.kind !== 'rpc' || op.method !== 'paintSnapshot' || op.params.selector !== selector) continue;
        const v = viewportBefore(ops, k);
        if (object(v) && v.width === width) return paintConfirmation(op.ok ? op.result : { ok: false, code: op.result?.code ?? 'PAINT_SNAPSHOT_FAILED' }, failure);
      }
      throw new Error(`SWEEP_CONFIRM_NOT_RECORDED:${width}`);
    },
    async capture(width) {
      for (let k = ops.length - 1; k >= 0; k -= 1) {
        const op = ops[k];
        if (op.kind !== 'rpc' || !op.ok || !['captureTab', 'screenshot'].includes(op.method) || op.params.evidence !== true) continue;
        const v = viewportBefore(ops, k);
        if (object(v) && v.width === width) return captureRef ? captureRef(op) : { sha256: typeof op.result?.sha256 === 'string' ? op.result.sha256 : null };
      }
      return null;
    },
    async measureRow(row) {
      const emu = lastRead(ops, `w:row:${row.id}:emu`), geo = lastRead(ops, `w:row:${row.id}:geo`);
      if (emu < 0 || geo < 0 || geo < emu) return { verified: false, emulation: null, failures: [] };
      const v = viewportBefore(ops, emu), mobile = row.profile === 'mobile';
      const e = valueOf(ops[emu]), g = valueOf(ops[geo]);
      const set = object(v) && v.width === row.w && v.height === row.h && v.dpr === row.dpr && v.mobile === mobile && settledRead(ops, emu);
      const verified = set && object(e) && object(g) && e.width === row.w && e.dpr === row.dpr && e.touch === mobile;
      return { verified, emulation: object(e) ? e : null, failures: (Array.isArray(g?.failures) ? g.failures : []).map((f) => `${f.rule}|${f.selector}`) };
    },
    async restore(found) {
      const k = lastRead(ops, 'w:restored');
      if (k < 0) return { ok: false, reason: 'NOT_RESTORED' };
      const back = valueOf(ops[k]);
      if (!object(back)) return { ok: false, reason: 'VIEWPORT_READBACK_EMPTY' };
      const ok = found === 'clear' || (object(found) && back.width === found.width && back.height === found.height);
      return ok ? { ok, viewport: back } : { ok, reason: 'VIEWPORT_READBACK_MISMATCH', viewport: back };
    },
  };
}

/** The sweep receipt from the recorded calls of one screen, or null when the executor ran no sweep there. */
export async function widthSweepFromOps(ops, { captureRef = null, min = SWEEP_DEFAULTS.min, max = SWEEP_DEFAULTS.max, step = SWEEP_DEFAULTS.step, helpers = false } = {}) {
  if (!ops.some((op) => op.kind === 'read' && op.step?.as === 'w:found')) return null;
  if (helpers) {
    const proven = provenOps(ops, 'sweep', 'w:');
    if (proven.mismatch) return { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:width-sweep`] };
    ops = proven.ops;
  }
  if (firstRead(ops, 'w:found') < 0) return null;
  try { return { receipt: await sweepWidths({ reader: recordedGeometryReader(ops, { captureRef }), min, max, step }), issues: [] }; }
  catch (error) { return { receipt: null, issues: [String(error?.message ?? error).split('\n')[0]] }; }
}

// ── R1e overlay check ───────────────────────────────────────────────────────────────────────────────────────────
export const OVERLAY_INSTALL_BODY = `(() => { window.__qaOverlay = () => {${OVERLAY_STATE_BODY}}; return window.__qaOverlay(); })()`;
export const OVERLAY_CALL = '__qaOverlay()';
export const OVERLAY_DEFAULTS = Object.freeze({ tabLimit: 12, keyboardLimit: 80, maxTriggers: 3 });

// The observation probeOverlay makes of trigger k, rebuilt from the labelled reads `o:<k>:<slot>`. Every leg must be
// there with the input that leads to it; a leg that is not is an error (all nine checks UNGRADED UNMEASURED).
function overlayObservation(ops, k, trigger, { tabLimit = OVERLAY_DEFAULTS.tabLimit } = {}) {
  const slot = (name) => lastRead(ops, `o:${k}:${name}`);
  const val = (name) => { const i = slot(name); return i >= 0 ? valueOf(ops[i]) : undefined; };
  const between = (a, b, test) => { if (a < 0 || b < 0 || b <= a) return false; for (let i = a + 1; i < b; i += 1) if (test(ops[i])) return true; return false; };
  const fresh = (op) => op.ok && (op.kind === 'goto' || (op.kind === 'rpc' && op.method === 'reloadTab'));
  const clickOn = (selector) => (op) => op.ok && (op.kind === 'clickSelector' ? op.step.clickSelector === selector : op.kind === 'click' && op.step.click?.selector === selector);
  const keyOf = (key) => (op) => op.ok && op.kind === 'key' && op.step.key === key;
  const scrollOp = (op) => op.kind === 'scroll';
  const missing = (leg) => ({ trigger, error: `OVERLAY_LEG_NOT_RECORDED:${leg}` });
  const obs = { trigger };
  const before = val('before');
  if (!object(before) || !Array.isArray(before.open)) return missing('before');
  if (before.open.length) return { ...obs, error: 'OVERLAY_OPEN_BEFORE_TRIGGER' };
  const first = val('first');
  if (!object(first) || !between(slot('before'), slot('first'), clickOn(trigger.selector))) return missing('first');
  const isOpen = first.open.length > 0;
  obs.overlay = isOpen ? first.open.at(-1).selector : null;
  obs.mouse = { opened: isOpen, overlay: obs.overlay, activeInside: first.activeInsideTop, modal: first.modal === true };
  if (isOpen) {
    const inside = [];
    let prev = slot('first');
    for (let i = 1; i <= tabLimit; i += 1) {
      const at = slot(`trap-${i}`);
      if (at < 0 || !between(prev, at, keyOf('Tab'))) break;
      inside.push(valueOf(ops[at])?.activeInsideTop === true);
      prev = at;
    }
    if (!inside.length) return missing('trap');
    obs.trap = { presses: inside.length, inside };
    if (before.scrollable) {
      const from = slot('scroll-from'), to = slot('scroll-to');
      if (from < 0 || to < 0) return missing('scroll');
      const gesture = ops.slice(from + 1, to).find(scrollOp);
      const attempted = Boolean(gesture) && gesture.ok;
      obs.scroll = { scrollable: true, attempted, ...(gesture && !gesture.ok ? { code: String(gesture.res?.code ?? 'SCROLL_FAILED') } : {}), before: valueOf(ops[from]).scrollY, after: valueOf(ops[to]).scrollY };
    } else obs.scroll = { scrollable: false };
    const now = val('now');
    if (!object(now)) return missing('now');
    if (Array.isArray(now.innerTriggers) && now.innerTriggers.length) {
      const two = slot('stacked-two'), esc = slot('stacked-esc');
      if (two < 0 || esc < 0 || !between(slot('now'), two, clickOn(now.innerTriggers[0].selector)) || !between(two, esc, keyOf('Escape'))) return missing('stacked');
      obs.stacked = { available: true, opened: (valueOf(ops[two]).open ?? []).length >= 2, openAfterEsc: (valueOf(ops[esc]).open ?? []).map((entry) => entry.selector) };
    } else obs.stacked = { available: false };
  } else {
    obs.trap = { presses: 0, inside: [] };
    obs.scroll = { scrollable: before.scrollable };
    obs.stacked = { available: false };
  }
  // Each way out from a fresh page: a goto (or reload) and a click on the trigger before the `<way>-open` read.
  const opened = (name) => {
    const at = slot(`${name}-open`);
    if (at < 0) return null;
    let k2 = at - 1;
    while (k2 >= 0 && !fresh(ops[k2])) k2 -= 1;
    return k2 >= 0 && between(k2, at, clickOn(trigger.selector)) ? { at, value: valueOf(ops[at]) } : null;
  };
  const esc = opened('esc');
  if (!esc) return missing('esc');
  if (esc.value.open?.length) {
    const after = slot('esc-after');
    if (after < 0 || !between(esc.at, after, keyOf('Escape'))) return missing('esc');
    obs.esc = { closed: valueOf(ops[after]).open.length === 0, active: valueOf(ops[after]).active };
  } else obs.esc = { closed: false, active: esc.value.active };
  const backdrop = opened('backdrop');
  if (!backdrop) return missing('backdrop');
  if (backdrop.value.open?.length && backdrop.value.backdropPoint) {
    const point = backdrop.value.backdropPoint, after = slot('backdrop-after');
    const clicked = between(backdrop.at, after, (op) => op.ok && op.kind === 'clickXY' && op.step.clickXY?.[0] === point.x && op.step.clickXY?.[1] === point.y);
    if (after < 0 || !clicked) return missing('backdrop');
    obs.backdrop = { available: true, closed: valueOf(ops[after]).open.length === 0, active: valueOf(ops[after]).active };
  } else obs.backdrop = { available: false };
  const button = opened('button');
  if (!button) return missing('button');
  if (button.value.open?.length && button.value.closeButton) {
    const after = slot('button-after');
    if (after < 0 || !between(button.at, after, clickOn(button.value.closeButton))) return missing('button');
    obs.button = { available: true, closed: valueOf(ops[after]).open.length === 0, active: valueOf(ops[after]).active };
  } else obs.button = { available: false };
  // The way in by keyboard: from a fresh page `kbd-0` starts the focus log, then the Tab presses, then `kbd` reads one
  // sample per press (where focus was after it). Then, if the trigger got focus at press n: from a fresh page again,
  // the same n presses (`kbd-reach` shows the trigger focused), Enter, and `kbd-enter`.
  const start = slot('kbd-0'), logAt = slot('kbd');
  if (start < 0 || logAt < 0 || logAt < start) return missing('keyboard');
  let tabs = 0;
  for (let i = start + 1; i < logAt; i += 1) { if (fresh(ops[i])) return missing('keyboard'); if (keyOf('Tab')(ops[i])) tabs += 1; }
  const samples = Array.isArray(valueOf(ops[logAt])?.samples) ? valueOf(ops[logAt]).samples : null;
  if (!samples || !tabs || samples.length > tabs || samples.some((x) => !object(x) || !Number.isInteger(x.id))) return missing('keyboard');
  // Fix round 2 (E5): a Tab press that left no sample (focus inside a frame) hides where focus went: O2 is a tool limit.
  if (samples.length < tabs) { obs.keyboard = { reachedTrigger: false, presses: tabs, cycled: false, lost: tabs - samples.length }; return obs; }
  const { presses, reached, cycled } = keyboardWay(samples, trigger);
  if (reached) {
    const reach = slot('kbd-reach'), enter = slot('kbd-enter');
    let n = 0, freshAt = reach - 1;
    while (freshAt >= 0 && !fresh(ops[freshAt])) { if (keyOf('Tab')(ops[freshAt])) n += 1; freshAt -= 1; }
    if (reach < 0 || enter < 0 || n !== presses || valueOf(ops[reach])?.active !== trigger.selector || !between(reach, enter, keyOf('Enter'))) return missing('keyboard');
    obs.keyboard = { reachedTrigger: true, presses, opened: (valueOf(ops[enter]).open ?? []).length > 0 };
  } else {
    if (tabs < OVERLAY_DEFAULTS.keyboardLimit && !cycled) return missing('keyboard');
    obs.keyboard = { reachedTrigger: false, presses, cycled };
  }
  return obs;
}

/**
 * The way to the trigger in a focus log (one sample per Tab press, each with the focused element's identity): the press
 * that reached it, or whether focus went round the page first (back to the first element it reached, or to the
 * document), by element identity, never by selector.
 */
export function keyboardWay(samples, trigger) {
  let presses = 0, reached = false, cycled = false;
  const seen = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    presses += 1;
    if (sample?.active === trigger?.selector) { reached = true; break; }
    if (focusCycled(seen, sample?.id)) { cycled = true; break; }
    seen.push(sample?.id);
  }
  return { presses, reached, cycled };
}

/**
 * The triggers checked on a screen, in priority order: those the plan names first (in plan order), then the others in
 * the order the page lists them (the explorer's own order); at most `cap`. The rest are listed, not checked.
 */
export function overlayTriggerOrder(triggers, { planned = [], cap = OVERLAY_DEFAULTS.maxTriggers } = {}) {
  const list = (Array.isArray(triggers) ? triggers : []).filter((t) => object(t) && typeof t.selector === 'string');
  const first = planned.map((sel) => list.find((t) => t.selector === sel)).filter(Boolean);
  const ordered = [...first, ...list.filter((t) => !first.includes(t))];
  return { checked: ordered.slice(0, cap), notChecked: ordered.slice(cap) };
}

/** The overlay check receipt (qa-gui/overlay-check/v1) from the recorded calls of one screen, or null when none ran. */
export function overlayCheckFromOps(ops, { route = null, planned = [], helpers = false } = {}) {
  if (!ops.some((op) => op.kind === 'read' && op.step?.as === 'o:triggers')) return null;
  if (helpers) {
    const proven = provenOps(ops, 'overlay', 'o:');
    if (proven.mismatch) return { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:overlay-check`] };
    ops = proven.ops;
  }
  const at = firstRead(ops, 'o:triggers');
  if (at < 0) return null;
  const state = valueOf(ops[at]);
  const all = Array.isArray(state?.triggers) ? state.triggers : [];
  const { checked, notChecked } = overlayTriggerOrder(all, { planned });
  const overlays = checked.map((trigger, k) => {
    const observation = overlayObservation(ops, k, trigger);
    const graded = gradeOverlay(observation);
    return { id: graded.id, trigger, observation, checks: graded.checks, cells: graded.cells };
  });
  return { receipt: { schema: OVERLAY_CHECK_SCHEMA, route, triggers: all, overlays, ...(notChecked.length ? { notChecked: notChecked.map((trigger) => ({ trigger, reason: 'TRIGGER_CAP' })) } : {}) },
    issues: overlays.filter((o) => o.observation.error).map((o) => `${o.observation.error}:${o.id}`) };
}

// ── R1e/R1b frontier exploration ────────────────────────────────────────────────────────────────────────────────
export const EXPLORE_INSTALL_BODY = `(() => { window.__qaExplore = () => {${EXPLORE_OBSERVE_BODY}}; return window.__qaExplore(); })()`;
export const EXPLORE_CALL = `(typeof __qaExplore === 'function' ? __qaExplore() : null)`;
export const EXPLORE_CSS_BODY = UNMATCHED_CSS_BODY;

/**
 * The exploration replayed with QA GUI's explorer, following the executor's own choices: `x:<n>` reads are the
 * settled observations in order (`x:0` after the goto to the start), each click step between two of them is the action
 * the executor took, a goto before a click is a fresh start, `x:css` the unmatched CSS read. The explorer still decides
 * what it records: a click on a candidate it would refuse (destructive without approval) stops it BLOCKED, and an
 * exploration the executor ended early stops BUDGET_EXHAUSTED. Returns {log, map, decisions} or null when none ran.
 */
export async function explorationFromOps(ops, { policy = {}, budget = 30, helpers = false } = {}) {
  if (helpers) {
    const proven = provenOps(ops, 'explore', 'x:');
    if (proven.mismatch) return { log: [], map: buildAppMapV2([]), decisions: [], issues: [`${DETECTOR_HELPER_MISMATCH}:explore`] };
    ops = proven.ops;
  }
  // Observation n is the last `x:<n>` read that holds one (a null read means the helper was lost by a navigation and the
  // executor sent the read again with the helper).
  const observed = (n) => { for (let k = ops.length - 1; k >= 0; k -= 1) if (isRead(ops[k], `x:${n}`) && object(valueOf(ops[k]))) return k; return -1; };
  const starts = [];
  for (let n = 0; ; n += 1) { const at = observed(n); if (at < 0) break; starts.push(at); }
  if (!starts.length) return null;
  // The executor's steps: [{fresh, click: selector|null, at}] for every observation after the first.
  const steps = starts.slice(1).map((at, n) => {
    const from = starts[n];
    const between = ops.slice(from + 1, at);
    const click = between.find((op) => op.ok && CLICKS.includes(op.kind));
    const selector = click ? (click.step.clickSelector ?? click.step.click?.selector ?? click.step.click ?? null) : null;
    return { fresh: between.some((op) => op.ok && op.kind === 'goto'), selector: typeof selector === 'string' ? selector : null, at };
  });
  let cursor = 0, index = 0;
  const observation = (at) => { const v = valueOf(ops[at]); if (!object(v)) throw new Error('EXPLORE_OBSERVATION_EMPTY'); return v; };
  const driver = {
    // A fresh start shows the start page again: its observation is x:0 (a re-navigation records no read of its own).
    async start() { if (index === 0) index = 1; return observation(starts[0]); },
    async observe() { return observation(starts[index++]); },
    async act(candidate) {
      const next = steps[cursor];
      if (!next) throw new Error('EXPLORE_REPLAY_ENDED');
      cursor += 1;
      if (next.selector !== candidate.selector) throw new Error(`EXPLORE_REPLAY_DIVERGED:${candidate.selector}!=${next.selector}`);
      return {};
    },
    async unmatchedCssRules() { const at = firstRead(ops, 'x:css'); const v = at >= 0 ? valueOf(ops[at]) : null; return Array.isArray(v) ? v : []; },
  };
  // The executor chooses: its next click names the candidate, among those the explorer has open. A fresh start (goto)
  // followed by clicks on candidates already taken is the way back to an earlier screen: the explorer walks that path
  // itself, so the choice is the first open candidate after it.
  const follow = ({ open }) => {
    const next = steps[cursor];
    if (!next) return { stop: { reason: 'BUDGET_EXHAUSTED', detail: `the executor ended the exploration after ${cursor} actions` } };
    const match = (j) => open.find((entry) => entry.candidate?.selector === steps[j]?.selector);
    let j = cursor;
    if (next.fresh) while (j < steps.length && !match(j) && (j === cursor || !steps[j].fresh)) j += 1;
    const pick = match(j);
    if (!pick) return { stop: { reason: 'BLOCKED', code: 'TOOL_LIMIT', detail: `the executor clicked ${next.selector}, which is not an open candidate (destructive without approval, or not offered)` } };
    return { pick };
  };
  const run = await explore({ driver, policy, budget, follow });
  // A click the explorer never asked for (after it had nothing open, e.g. on a destructive control it keeps blocked)
  // is reported, and the exploration counts as BLOCKED.
  if (cursor < steps.length && run.log.at(-1)?.action === 'stop' && run.log.at(-1).reason !== 'BLOCKED') {
    const stop = run.log.at(-1);
    run.log[run.log.length - 1] = { step: stop.step, action: 'stop', reason: 'BLOCKED', code: 'TOOL_LIMIT',
      detail: `the executor clicked ${steps[cursor].selector}, which the explorer did not have open (destructive without approval, or not offered)` };
    run.map = buildAppMapV2(run.log);
  }
  return run;
}

// ── R1d transient probe ─────────────────────────────────────────────────────────────────────────────────────────
const SAMPLE_OFFSETS = T_DEFAULTS.sampleOffsetsMs.filter((x) => x > 0);
/** The sample helper (installed by the `t:s-pre` read; it does not survive a navigation, so a later sample is lost). */
export function sampleInstallBody({ targetSelector = null } = {}) {
  return `(() => { window.__qaSample = () => ${sampleRead({ targetSelector })}; return window.__qaSample(); })()`;
}
export const SAMPLE_CALL = `(typeof __qaSample === 'function' ? __qaSample() : null)`;
const DECISION_LAG_MS = 100;
const EXTENSIONS = Math.ceil((T_DEFAULTS.windowMaxMs - T_DEFAULTS.windowAfterMs) / T_DEFAULTS.extendStepMs);
/**
 * The `do` steps of one probe trial around `step` (the action): the samples runTransientProbe takes (`t:s-pre`, the
 * action, `t:s16` ... `t:s1000`), then every extension step up to +3 s (`t:sx`). The executor cannot judge whether the
 * window must stay open, so it takes them all; the assembler replays the driver's windowDecision and keeps the samples
 * up to where the driver would have closed the window.
 */
export function transientTrialSteps({ step, targetSelector = null, fast = false }) {
  const steps = [{ read: sampleInstallBody({ targetSelector }), as: 't:s-pre' }, { wait: 100 }, withClickSpeed(step, fast)];
  let last = 0;
  for (const d of SAMPLE_OFFSETS) { steps.push({ wait: d - last }, { read: SAMPLE_CALL, as: `t:s${d}` }); last = d; }
  for (let i = 0; i < EXTENSIONS; i += 1) steps.push({ wait: T_DEFAULTS.extendStepMs }, { read: SAMPLE_CALL, as: 't:sx' });
  return steps;
}
const sampleOf = (op) => { const v = valueOf(op); return object(v) && finite(v.t) ? v : null; };

/**
 * The transient probe receipt (qa-gui/transient-probe/v1) of one action from the recorded calls before the state it
 * leads to: sensors.start, then per trial frames.start, the `do` with the `t:s-pre` read, the action and the samples,
 * `t:sx` extension samples (kept up to where the driver would close the window), sensors.read, frames.stop, getNetwork,
 * env.get.
 * frameRef(stop, frame) -> the in-run path of a kept frame (Team QA copies it hash for hash), or null to keep Dragon's.
 */
export function transientProbeFromOps(ops, { caseId, state, action = null, repeatable = true, plan = null, claimed = undefined, frameRef = null, options = T_DEFAULTS }) {
  if (ops.some((op) => op.kind === 'rpc' && op.method === 'frames.trial')) return transientProbeFromTrials(ops, { caseId, state, action, repeatable, plan, claimed, frameRef, options });
  const anchors = [];
  for (let k = 0; k < ops.length; k += 1) if (isRead(ops[k], 't:s-pre')) anchors.push(k);
  if (!anchors.length) return null;
  const issues = [];
  const startAt = rpcBefore(ops, 'sensors.start', 0, anchors[0]);
  const started = startAt >= 0 && ops[startAt].ok ? ops[startAt].result : null;
  if (!started) issues.push('TRANSIENT_SENSORS_NOT_STARTED');
  const doOf = (k) => ops.filter((op) => op.call === ops[k].call);
  const actionOp = doOf(anchors[0]).find((op) => !['read', 'wait', 'waitFor'].includes(op.kind));
  const act = object(action) ? action : { method: actionOp?.kind === 'key' ? 'key' : 'click', selector: actionOp?.step?.clickSelector ?? null, target: {} };
  const trials = [];
  let history = [];
  const seen = new Set();
  anchors.forEach((anchor, n) => {
    const end = n + 1 < anchors.length ? rpcBefore(ops, 'frames.start', anchors[n], anchors[n + 1]) : ops.length;
    const limit = end >= 0 ? end : anchors[n + 1];
    const framesStartAt = rpcBefore(ops, 'frames.start', n ? anchors[n - 1] : 0, anchor);
    const own = doOf(anchor);
    const samples = ['t:s-pre', ...SAMPLE_OFFSETS.map((d) => `t:s${d}`)].map((as) => own.find((op) => isRead(op, as))).map(sampleOf).filter(Boolean);
    const lastOwn = ops.indexOf(own.at(-1));
    // Events of this trial: every sensors.read after the action (deduplicated by seq).
    const readsAt = []; for (let k = lastOwn + 1; k < limit; k += 1) if (ops[k].kind === 'rpc' && ops[k].method === 'sensors.read' && ops[k].ok) readsAt.push(k);
    const events = [];
    for (const k of readsAt) for (const e of Array.isArray(ops[k].result?.events) ? ops[k].result.events : []) {
      const key = finite(e?.seq) ? e.seq : JSON.stringify(e);
      if (!seen.has(key)) { seen.add(key); events.push(e); }
    }
    const lastSense = readsAt.length ? ops[readsAt.at(-1)].result : null;
    const sPre = sampleOf(own.find((op) => isRead(op, 't:s-pre')));
    const input = events.find((e) => e?.k === 'input' && e.trusted && ['pointerdown', 'keydown'].includes(e.type) && finite(e.t) && (!sPre || e.t >= sPre.t - 50));
    const receiptTs = own.map((op) => op.res?.receipt?.ts).find(finite);
    const markT = input?.t ?? receiptTs ?? (sPre ? sPre.t + 100 : null);
    if (!finite(markT)) { issues.push(`TRANSIENT_MARK_UNKNOWN:trial-${n}`); return; }
    const trial = { markT, events, samples, network: [], frames: null, window: { from: markT - options.windowBeforeMs, to: null, extended: false, reason: null }, action: { kinds: [] } };
    const netAt = rpcAfter(ops, 'getNetwork', lastOwn + 1, limit);
    const requests = netAt >= 0 && Array.isArray(ops[netAt].result?.requests) ? ops[netAt].result.requests : [];
    trial.network = requests.filter((r) => finite(r?.t) && r.t >= markT - options.windowBeforeMs).map((r) => ({ t: r.t, method: r.method, url: r.url, status: r.status ?? null, ...(r.failed ? { failed: true } : {}) }));
    // The window as the driver closes it: from +1000 ms on, one extension step at a time while the network is busy (a
    // request of the action answered later) or an anomaly is still open; samples after that point are not kept.
    const extensions = [];
    for (let k = ops.indexOf(own[0]); k < limit; k += 1) if (isRead(ops[k], 't:sx')) { const x = sampleOf(ops[k]); if (x) extensions.push(x); }
    extensions.sort((a, b) => a.t - b.t);
    const busyAt = (now) => trial.network.some((r) => r.t > now && r.t >= markT);
    // The driver decides when its `do` has returned: never before +1000 ms after the action, and about DECISION_LAG_MS
    // after its last sample (the RPC's way back). The replay decides at the same point.
    const decideAt = (t) => Math.max(t + DECISION_LAG_MS, markT + options.windowAfterMs);
    let now = decideAt(samples.length ? samples.at(-1).t : markT);
    for (const next of extensions) {
      if (next.t <= (samples.at(-1)?.t ?? markT)) continue;
      const decision = windowDecision({ trial: { ...trial, events: [...carryOver(history, Infinity), ...events], samples }, now, networkBusy: busyAt(now), options });
      if (decision.close) break;
      if (decision.reason) { trial.window.extended = true; trial.window.reason = trial.window.reason ?? decision.reason; }
      samples.push(next); now = decideAt(next.t);
    }
    let decisionsMs = 0;
    for (let k = lastOwn + 1; k < limit; k += 1) if (ops[k].kind === 'rpc' && ops[k].method === 'waitForNetworkIdle') decisionsMs += duration(ops[k].call);
    trial.window.to = now;
    const timed = events.filter((e) => finite(e?.t));
    const firstOwn = timed.length ? Math.min(...timed.map((e) => e.t)) : markT;
    const doc = timed.find((e) => e.k === 'input' && e.doc)?.doc ?? timed.filter((e) => e.doc).at(-1)?.doc;
    trial.events = [...carryOver(history, firstOwn, doc ?? null), ...timed];
    history = [...carryOver(history, Infinity), ...timed];
    // A read that still had `more` left events unread: the stream is not whole.
    trial.sensors = { startedAt: started?.startedAt ?? null, streams: started?.streams ?? null, gap: Boolean(lastSense?.gap) || lastSense?.more === true || !readsAt.length, overflow: lastSense?.overflow ?? 0, pageDropped: lastSense?.pageDropped ?? 0 };
    const stopAt = rpcAfter(ops, 'frames.stop', lastOwn + 1, limit);
    const stop = stopAt >= 0 ? ops[stopAt] : null;
    const fw = framesStartAt >= 0 ? ops[framesStartAt].result : null;
    trial.frames = stop?.ok
      ? { ok: true, windowId: stop.result.windowId, dir: null, startedAt: stop.result.startedAt, guardFrom: stop.result.guardFrom, stoppedAt: stop.result.stoppedAt, marks: stop.result.marks,
        counts: stop.result.counts, keep: stop.params.keep ?? null, index: stop.result.index,
        kept: (stop.result.frames || []).map((f) => ({ seq: f.seq, t: f.t, reason: f.reason, file: frameRef ? frameRef(stop.result, f) : (f.file ?? null), sha256: f.sha256 ?? null })) }
      : { ok: false, code: stop?.result?.code ?? (stop ? 'FRAMES_STOP_FAILED' : 'FRAMES_NOT_RECORDED'), startedAt: fw?.startedAt ?? null, keep: stop?.params?.keep ?? null, index: [] };
    const envAt = rpcAfter(ops, 'env.get', lastOwn + 1, limit);
    const env = envAt >= 0 && ops[envAt].ok ? ops[envAt].result : null;
    trial.conditions = env?.conditions ?? null;
    trial.held = Array.isArray(env?.held) ? env.held : [];
    trial.timing = { source: 'stream', sensorsStartMs: n === 0 && startAt >= 0 ? duration(ops[startAt].call) : 0, framesStartMs: framesStartAt >= 0 ? duration(ops[framesStartAt].call) : 0,
      samplesMs: Math.max(0, duration(ops[anchor].call) - SAMPLE_OFFSETS.at(-1) - 100 - EXTENSIONS * T_DEFAULTS.extendStepMs), sensorsReadMs: readsAt.reduce((s, k) => s + duration(ops[k].call), 0),
      framesStopMs: stop ? duration(stop.call) : 0, decisionsMs };
    trial.viewport = (() => { const h = trial.events.filter((e) => e.k === 'hello').at(-1); return h ? { vw: h.vw, vh: h.vh } : null; })();
    trials.push(trial);
  });
  if (!trials.length) return { receipt: null, issues };
  const receipt = buildTransientProbeReceipt({ caseId, state, action: act, classification: classifyAction(act), trials, repeatable: repeatable !== false });
  return { receipt, issues };
}

// The steps a probe trial runs as its action (frames.trial `steps`), and its sample (the sample helper, called with the
// action target's selector at the T rules' offsets).
const TRIAL_OFFSETS = SAMPLE_OFFSETS.filter((d) => d <= T_DEFAULTS.windowAfterMs);
export const PROBE_TRIALS = 3;
// The kinds of action that write. Repeating one writes again, so how it may be repeated depends on the plan (below).
export const WRITE_KINDS = Object.freeze(['submit', 'save', 'delete', 'list-add', 'list-remove']);
// The writes that remove data: a trial cannot remove the same record twice.
export const REMOVING_WRITES = Object.freeze(['delete', 'list-remove']);
/**
 * Fix round 2 (E3): how often the probe may repeat an action, decided by QA GUI from the action's kinds
 * (classifyAction) and the plan, never by the executor. Dogfood 05/11 (BA R1d, whose own example probes "Lu\u01b0u" three
 * times): a write that adds or saves (submit, save, list-add) with no reset path in the plan gets its PROBE_TRIALS trials
 * with fresh test values (`fresh: true`: each trial puts the empty form back and fills new values, so each trial adds its
 * own test record and never repeats the case's own write). A write that removes data (delete, list-remove) with no reset
 * path gets no trial at all (N/A, TRANSIENT_WRITE_NO_RESET). Anything else, or a write with a reset path, is repeatable.
 */
export function transientRepeatability({ kinds = [], reset = false } = {}) {
  const writes = (Array.isArray(kinds) ? kinds : []).filter((k) => WRITE_KINDS.includes(k));
  if (writes.length && !reset) {
    if (writes.some((k) => REMOVING_WRITES.includes(k))) return { repeatable: false, trials: 0, writes, reason: 'TRANSIENT_WRITE_NO_RESET' };
    return { repeatable: true, trials: PROBE_TRIALS, writes, reason: null, fresh: true };
  }
  return { repeatable: true, trials: PROBE_TRIALS, writes, reason: null };
}
// Fix round 3 (F4): the code of Dragon's destructive gate refusing a frames.trial under its manual policy.
export const DESTRUCTIVE_REFUSED = 'DESTRUCTIVE_HANDOFF_REQUIRED';
// Fix round 3 (F8): what a trial's action step acts on, and what the state's main action names: {by, value}.
const ACTION_KINDS = ['clickSelector', 'click', 'clickXY', 'key', 'type', 'fill', 'select', 'hover', 'drag', 'scroll', 'chord'];
function trialTarget(params) {
  const step = (Array.isArray(params?.steps) ? params.steps : []).find((s) => object(s) && ACTION_KINDS.some((k) => Object.hasOwn(s, k)));
  if (!step) return null;
  if (typeof step.clickSelector === 'string') return { by: 'selector', value: step.clickSelector.trim() };
  if (object(step.click) && typeof step.click.selector === 'string') return { by: 'selector', value: step.click.selector.trim() };
  if (typeof step.key === 'string') return { by: 'key', value: step.key };
  const kind = ACTION_KINDS.find((k) => Object.hasOwn(step, k));
  return { by: kind, value: JSON.stringify(step[kind]) };
}
function actionTarget(action) {
  if (!action) return null;
  if (String(action.method ?? 'click') === 'key') return typeof action.key === 'string' && action.key ? { by: 'key', value: action.key } : null;
  return typeof action.selector === 'string' && action.selector.trim() ? { by: 'selector', value: action.selector.trim() } : null;
}
const sameTarget = (a, b) => Boolean(a && b && a.by === b.by && a.value === b.value);
export function trialParams({ step, targetSelector = null, fast = false, setup = null }) {
  return {
    ...(Array.isArray(setup) && setup.length ? { setup } : {}),
    steps: [withClickSpeed(step, fast)],
    sample: { call: STREAM_HELPERS.sample.name, args: [targetSelector], at: TRIAL_OFFSETS },
    window: { leadMs: PROBE_PLAN.sensorLeadMs, beforeMs: T_DEFAULTS.windowBeforeMs, afterMs: T_DEFAULTS.windowAfterMs, maxMs: T_DEFAULTS.windowMaxMs, extendStepMs: T_DEFAULTS.extendStepMs },
    sensors: { watch: PROBE_WATCH, maxTargets: PROBE_PLAN.sensors.maxTargets },
    frames: { maxWidth: PROBE_PLAN.frames.maxWidth, quality: PROBE_PLAN.frames.quality, everyNthFrame: 1, maxFrames: PROBE_PLAN.frames.maxFrames },
    keep: 'all', edges: true, maxKeep: PROBE_PLAN.stop.maxKeep, maxEvents: 200,
  };
}

/**
 * The transient probe receipt from Dragon frames.trial calls (R1a: one probe trial in one call, so the window is open
 * across the action by construction). Each trial's events are the trial's own (its answer, then sensorsRead pages from
 * its cursor until `more` is false); its samples are the sample helper's (QA GUI's body, proven by the helper sha-256);
 * its window is the one Dragon kept, closed where QA GUI's own window rule closes it on the same samples.
 * Fix round 2 (E3): every frames.trial is an attempt the receipt keeps (`attempts`): one whose Dragon call failed, that
 * had no setup, whose action step was not ok or whose do did not complete, or that has no trusted-input mark counts as
 * not run, and the gate grades the probe UNGRADED (TRANSIENT_ACTION_NOT_RUN, ...). With `plan` ({kinds, reset}: what
 * Team QA's plan says of the action), QA GUI decides repeatability (transientRepeatability over the plan's and the
 * recorded action's kinds); an executor that says `repeatable: false` of an action QA GUI calls repeatable changes
 * nothing but is reported (TRANSIENT_REPEATS_REQUIRED), and a repeatable action needs its PROBE_TRIALS trials.
 * Fix round 3: a trial that acted on another element than the state's main action (or than the first trial, when the
 * state names none) is not run either (TRANSIENT_ACTION_MISMATCH, F8); when Dragon's destructive gate refused every
 * trial the answer is {receipt: null, issues: [], na: 'DESTRUCTIVE_HANDOFF_REQUIRED'}: the probe is N/A, reported (F4).
 */
export function transientProbeFromTrials(ops, { caseId, state, action = null, repeatable = true, plan = null, claimed = undefined, frameRef = null, options = T_DEFAULTS, navigation = false }) {
  const at = [];
  for (let k = 0; k < ops.length; k += 1) if (ops[k].kind === 'rpc' && ops[k].method === 'frames.trial') at.push(k);
  if (!at.length) return null;
  // Fix round 3 (F4): Dragon's destructive gate (manual policy) refused every trial before any input: the probe could
  // not run here at all, so it is N/A (reported by the caller), not a probe that failed to run.
  if (at.every((k) => !ops[k].ok && ops[k].result?.code === DESTRUCTIVE_REFUSED)) return { receipt: null, issues: [], na: DESTRUCTIVE_REFUSED };
  // Fix round 3 (F8): every trial acts on the state's main action (its selector or key), or, when the state names
  // none, on the first trial's target; its sample watches that element too.
  const claimedTarget = actionTarget(object(action) ? action : null);
  const firstTarget = at.map((k) => trialTarget(ops[k].params)).find(Boolean) ?? null;
  const reference = claimedTarget ?? firstTarget;
  const issues = [], trials = [], attempts = [];
  for (const [n, k] of at.entries()) {
    const op = ops[k], r = op.result;
    const notRun = (code) => { attempts.push({ n, ok: false, code }); issues.push(`${code}:trial-${n}`); };
    if (!op.ok || !object(r)) { notRun(`TRANSIENT_TRIAL_FAILED:${String(r?.code ?? 'FAILED')}`); continue; }
    if (op.params?.sample?.call !== STREAM_HELPERS.sample.name || r.sample?.helper?.sha256 !== STREAM_HELPERS.sample.sha256) return { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:transient`] };
    const target = trialTarget(op.params), watched = Array.isArray(op.params?.sample?.args) ? op.params.sample.args[0] : null;
    if (reference && (!sameTarget(target, reference) || (reference.by === 'selector' && typeof watched === 'string' && watched.trim() !== reference.value))) { notRun('TRANSIENT_ACTION_MISMATCH'); continue; }
    if (!Array.isArray(op.params?.setup) || !op.params.setup.length || (object(r.setup) && (r.setup.completed === false || (Array.isArray(r.setup.results) && r.setup.results.some((x) => x?.ok === false))))) { notRun('TRANSIENT_SETUP_MISSING'); continue; }
    const actionResults = Array.isArray(r.do?.results) ? r.do.results : null;
    if (!object(r.do) || r.do.completed === false || !actionResults || !actionResults.length || actionResults.some((x) => !object(x) || x.ok === false)) { notRun('TRANSIENT_ACTION_NOT_RUN'); continue; }
    // Round G (G5): a navigation (goto) has no trusted input to mark; its mark is the time Dragon ran it (markT).
    const navigated = navigation && (op.params?.steps ?? []).some((x) => object(x) && typeof x.goto === 'string');
    if (!navigated && (!object(r.mark) || !finite(r.mark.t))) { notRun('TRANSIENT_ACTION_NOT_RUN:no-trusted-mark'); continue; }
    const markT = r.markT;
    if (!finite(markT)) { notRun('TRANSIENT_MARK_UNKNOWN'); continue; }
    attempts.push({ n, ok: true, code: null });
    // Events: the trial's own, then the pages read from its cursor.
    const next = at[n + 1] ?? ops.length;
    const events = Array.isArray(r.sensors?.events) ? r.sensors.events.slice() : [];
    let more = r.sensors?.more === true, cursor = r.sensors?.cursor, readsMs = 0, last = r.sensors ?? {};
    for (let i = k + 1; i < next && more; i += 1) {
      const page = ops[i];
      if (page.kind !== 'rpc' || page.method !== 'sensors.read' || !page.ok || Number(page.params?.since) !== Number(cursor)) continue;
      events.push(...(Array.isArray(page.result?.events) ? page.result.events : []));
      more = page.result?.more === true; cursor = page.result?.cursor; last = page.result ?? {}; readsMs += duration(page.call);
    }
    const sampled = (Array.isArray(r.samples) ? r.samples : []).map((x) => ({ at: x?.at, v: object(x?.value) && finite(x.value.t) ? x.value : null })).filter((x) => x.v);
    const samples = sampled.filter((x) => x.at !== 'x').map((x) => x.v);
    const extensions = sampled.filter((x) => x.at === 'x').map((x) => x.v).sort((a, b) => a.t - b.t);
    const trial = { markT, events, samples, network: [], frames: null, window: { from: markT - options.windowBeforeMs, to: null, extended: false, reason: null }, action: { kinds: [] } };
    trial.network = (Array.isArray(r.network) ? r.network : []).filter((q) => finite(q?.t) && q.t >= markT - options.windowBeforeMs)
      .map((q) => ({ t: q.t, method: q.method, url: q.url, status: q.status ?? null, ...(q.failed ? { failed: true } : {}) }));
    const busyAt = (now) => trial.network.some((q) => q.t > now && q.t >= markT);
    const decideAt = (t) => Math.max(t + DECISION_LAG_MS, markT + options.windowAfterMs);
    let now = decideAt(samples.length ? samples.at(-1).t : markT);
    for (const x of extensions) {
      if (x.t <= (samples.at(-1)?.t ?? markT)) continue;
      const decision = windowDecision({ trial: { ...trial, samples }, now, networkBusy: busyAt(now), options });
      if (decision.close) break;
      if (decision.reason) { trial.window.extended = true; trial.window.reason = trial.window.reason ?? decision.reason; }
      samples.push(x); now = decideAt(x.t);
    }
    // Dragon closed the window itself; the rules never see past that.
    trial.window.to = finite(r.window?.to) ? Math.min(now, r.window.to) : now;
    if (!trial.window.reason && trial.window.to - markT > options.windowAfterMs + options.extendStepMs) trial.window.reason = r.window?.reasons?.includes('network') ? 'network-busy' : 'anomaly-open';
    trial.events = events.filter((e) => finite(e?.t));
    trial.sensors = { startedAt: r.sensors?.startedAt ?? null, streams: r.sensors?.streams ?? null, gap: Boolean(last.gap) || more, overflow: last.overflow ?? 0, pageDropped: last.pageDropped ?? 0 };
    const stop = r.frames;
    trial.frames = object(stop) && stop.ok !== false
      ? { ok: true, windowId: stop.windowId, dir: null, startedAt: stop.startedAt, guardFrom: stop.guardFrom, stoppedAt: stop.stoppedAt, marks: stop.marks, counts: stop.counts, keep: op.params?.keep ?? 'all', index: stop.index,
        kept: (stop.frames || []).map((f) => ({ seq: f.seq, t: f.t, reason: f.reason, file: frameRef ? frameRef(stop, f) : (f.file ?? null), sha256: f.sha256 ?? null })) }
      : { ok: false, code: stop?.code ?? 'FRAMES_STOP_FAILED', startedAt: stop?.startedAt ?? null, keep: op.params?.keep ?? 'all', index: [] };
    trial.conditions = r.conditions ?? null;
    trial.held = [];
    const t = object(r.timing) ? r.timing : {};
    trial.timing = { source: 'frames.trial', sensorsStartMs: finite(t.sensorsStartMs) ? t.sensorsStartMs : 0, framesStartMs: finite(t.framesStartMs) ? t.framesStartMs : 0,
      samplesMs: 0, sensorsReadMs: readsMs, framesStopMs: finite(t.framesStopMs) ? t.framesStopMs : 0, decisionsMs: 0 };
    trial.viewport = (() => { const h = trial.events.filter((e) => e.k === 'hello').at(-1); return h ? { vw: h.vw, vh: h.vh } : null; })();
    trials.push(trial);
  }
  const first = ops[at[0]].params?.steps?.[0] ?? {};
  const act = object(action) ? action : typeof first.goto === 'string' ? { method: 'goto', selector: null, url: first.goto, target: {} }
    : { method: first.key ? 'key' : 'click', selector: first.clickSelector ?? null, target: {} };
  const classification = classifyAction(act);
  let decided = repeatable !== false;
  if (object(plan)) {
    const decision = transientRepeatability({ kinds: [...new Set([...(Array.isArray(plan.kinds) ? plan.kinds : []), ...classification.kinds])], reset: Boolean(plan.reset) });
    decided = decision.repeatable;
    if (claimed === false && decision.repeatable) issues.push('TRANSIENT_REPEATS_REQUIRED:the executor said not repeatable');
    if (!decision.repeatable) issues.push(`${decision.reason}:trials-run-${at.length}`);
  }
  if (!trials.length) return { receipt: null, issues };
  const receipt = buildTransientProbeReceipt({ caseId, state, action: act, classification, trials, repeatable: decided });
  // The executor's own word on repeating is kept (and graded by the gate against QA GUI's decision), never followed.
  return { receipt: { ...receipt, action: { ...receipt.action, ...(typeof claimed === 'boolean' ? { claimed } : {}) }, attempts }, issues };
}

// ── Round G (G5): the probe of a screen's entry ─────────────────────────────────────────────────────────────────
// One planted fault of the 05/11 dogfood was a layout shift while a screen loads; the probe around the case's main
// action never measured the screen's entry. Every GUI case with a screen gets one more probe, `entry`: the navigation
// that shows the screen (read-only, so repeatable), PROBE_TRIALS frames.trial calls labelled `entry:<screenId>`, each
// trial's setup on a blank page and its step the goto of the screen's URL, graded by the same T rules.
export const ENTRY_PROBE = 'entry';
export const ENTRY_LABEL = /^entry(?::|$)/;
export const isEntryTrial = (op) => op?.kind === 'rpc' && op.method === 'frames.trial' && ENTRY_LABEL.test(String(op.params?.correlationId ?? ''));
/** The frames.trial params of one entry trial: a blank page, then the goto of the screen's URL, sampling `target`. */
export function entryTrialParams({ url, target = 'body' }) {
  return trialParams({ step: { goto: url }, targetSelector: target, setup: [{ goto: 'about:blank' }] });
}
/**
 * The entry probe receipt (qa-gui/transient-probe/v1, folded as probe kind `entry`) from the case's entry trials only;
 * every other frames.trial (the main action's probe) is left out. Null when the stream has none.
 */
export function entryProbeFromOps(ops, { caseId, state, url = null, frameRef = null, options = T_DEFAULTS } = {}) {
  const own = (Array.isArray(ops) ? ops : []).filter((op) => !(op?.kind === 'rpc' && op.method === 'frames.trial') || isEntryTrial(op));
  if (!own.some(isEntryTrial)) return null;
  return transientProbeFromTrials(own, { caseId, state, action: { method: 'goto', selector: null, url, target: {} }, repeatable: true, plan: null, frameRef, options, navigation: true });
}
function entryPart({ entry }) {
  const label = `entry:${entry.screenId ?? 'screen'}`;
  const params = entryTrialParams({ url: entry.url ?? '<the screen URL>', target: entry.target ?? 'body' });
  return `E (entry probe, R1d), after the main action's probe and the case's envReset: ${PROBE_TRIALS} times framesTrial ${json({ tabId: '<tab>', correlationId: label, ...params })}${entry.url ? '' : ' with "<the screen URL>" the href where this case\'s screen is (location.href there; never an entry link that resets data)'}. Only reads and a goto: nothing is clicked. When a trial's sensors.more is true, one sensorsRead {"tabId":"<tab>","since":<its sensors.cursor>,"max":200}.`;
}

// ── R1c U1, U2, U3 from labelled __uxObserve reads ──────────────────────────────────────────────────────────────
export const UX_ACTION_RULES = Object.freeze(['U1', 'U2', 'U3']);
/**
 * The U1/U2/U3 results of one state from its recorded calls: `u:hold:before|during|after` around a write held by an
 * envSet request rule (U1, U2), `u:error:before|after` around a forced error (U3), the env.get read after each, and the
 * state's network log (`writes`). A rule the executor did not set up has no reads and is UNGRADED by its grader.
 */
export function uxActionResultsFromOps(ops, { rules = [], writes = [], settings = uxSettings() } = {}) {
  const val = (as) => { const k = lastRead(ops, as); return k >= 0 ? valueOf(ops[k]) : null; };
  const envAfter = (as) => { const k = lastRead(ops, as); const e = k >= 0 ? rpcAfter(ops, 'env.get', k) : -1; return e >= 0 && ops[e].ok ? ops[e].result : null; };
  const lastEnv = () => { const e = rpcBefore(ops, 'env.get', 0, ops.length); return e >= 0 && ops[e].ok ? ops[e].result : null; };
  const actionT = (as) => {
    const k = lastRead(ops, as);
    if (k < 0) return null;
    const same = ops.filter((op) => op.call === ops[k].call && op.si > ops[k].si && CLICKS.concat(['key']).includes(op.kind));
    const t = same.map((op) => op.res?.receipt?.ts).find(finite);
    return finite(t) ? { t } : null;
  };
  const out = [];
  for (const rule of rules) {
    if (rule === 'U1') out.push(gradeU1({ action: actionT('u:hold:before'), before: val('u:hold:before'), during: val('u:hold:during'), after: val('u:hold:after'), writes, env: lastEnv() }, settings));
    else if (rule === 'U2') out.push(gradeU2({ action: actionT('u:hold:before'), before: val('u:hold:before'), during: val('u:hold:during'), env: envAfter('u:hold:during') }, settings));
    else if (rule === 'U3') out.push(gradeU3({ before: val('u:error:before'), after: val('u:error:after'), env: envAfter('u:error:after'), writes }, settings));
  }
  return out;
}
// The reasons a forced U rule may be left unmeasured: only a Dragon without R1a (no envSet to force the state).
export const UX_UNAVAILABLE_REASONS = Object.freeze(['DRAGON_R1A_UNAVAILABLE']);
/**
 * The U1/U2/U3 results of rules the case's plan forces but that Dragon cannot force: each UNGRADED with the reason.
 * Folded without `require` they say so in the state's ui-sanity report and leave its verdict as before.
 */
export function uxUnavailableResults(rules, reason, settings = uxSettings()) {
  if (!UX_UNAVAILABLE_REASONS.includes(reason)) throw new Error(`UX_UNAVAILABLE_REASON:${reason}`);
  return rules.map((id) => {
    if (!UX_ACTION_RULES.includes(id)) throw new Error(`UX_UNAVAILABLE_RULE:${id}`);
    return uxResult(id, 'UNGRADED', { settings, reason });
  });
}
/** foldUx over a Gate-0 report, or over an empty one with the report's verdict when the read holds no issue list. */
export function foldUxInto(report, results, { require = [] } = {}) {
  const base = object(report) && Array.isArray(report.issues) ? report
    : { verdict: ['PASS', 'FAIL', 'UNGRADED'].includes(report?.verdict ?? report?.v) ? (report.verdict ?? report.v) : 'UNGRADED', issues: [] };
  return foldUx(base, results, { require });
}

// ── what the executor is told ───────────────────────────────────────────────────────────────────────────────────
const json = (value) => JSON.stringify(value);
// Dogfood 05/11: help is about 190 KB and the host shows only a preview of the file it saves; Dragon 1.7.0 begins its
// answer with an "r1a" summary, so the preview alone decides. The Grep is only for a result with no preview.
const R1A_RULE = 'Call help once before any R1a tool (env*, sensors*, frames*, helpersDefine, paintSnapshot). If the preview of its saved result begins {"r1a": R1a is here ("packs" and "loops" pick the paths below); anything else: no R1a, so call no R1a tool (an unknown one voids the dispatch). No preview: Grep the file for "environmentContract".';
const RUN_ALL = 'Run every step of this section before you print the draft: a detector this case needs and you did not run makes the case UNGRADED.';
// Fix round 2 (E9): the helpers are defined from QA GUI's helper pack by path and hash; the model never types a body.
// Fix round 3 (F9): which path is taken is read once from help: a Dragon whose contract has no "packs" (or that refuses
// the pack: a path outside its pack roots) gets the same bodies inline, still proven by hash; one with no "loops" gets
// every loop written out.
const PATHS_RULE = (loops) => `No "r1a" summary (an older R1a build): Grep the file once for "packs"${loops ? ' and once for "loops"' : ''}.`;
const helperLine = (keys, pack = helperPack()) => `If "r1a" has "packs": true: helpersDefine ${json({ pack: { path: pack.path, sha256: pack.sha256 } })} once (it defines ${keys.map((k) => STREAM_HELPERS[k].name).join(', ')}). If not, or it refuses the pack (HELPER_PACK_FORBIDDEN or any error), send the bodies inline once: Read that file and send helpersDefine {"helpers": {<name>: <body>}} with its "helpers" entries of those names, each body copied exactly (Dragon hashes what it runs). Every read below is a {"call": <helper name>, "args": [...], "as": <label>} step of these helpers, never a read step of your own: Team QA counts only reads whose result names QA GUI's helper.`;
const LOOP_NOTE = 'A {"forEach": {"name": "<n>", "values": [...] | "range": [from, to, step]}, "steps": [...]} step is a loop Dragon expands: "$<n>" (or "$<n>.<key>") in its steps becomes each value. If "r1a" has "loops": true, send loops as written. If not, or a do answers that a forEach step is unknown or invalid, write each loop out instead (its steps once per value, "$<n>" replaced), in that do and every later one.';

/**
 * The detector steps of one case dispatch (Team QA's TEAMQA_DETECTORS section). `detectors` lists what applies to
 * this case: transient (its main action is risky), ux (forced U-rule states), explore ({policy, budget} when the
 * tracked plan has a coverage block). The width sweep and the overlay check run once per screen, in their own
 * dispatch (screenCheckPromptSection). `fast` is the case's fast-click plan.
 */
export function detectorPromptSection({ caseId, detectors = {}, fast = false, pack = helperPack() }) {
  const click = (selector) => json(withClickSpeed({ clickSelector: selector }, fast));
  const parts = [];
  const transient = detectors.transient ? (object(detectors.transient) ? detectors.transient : { trials: PROBE_TRIALS }) : null;
  const entry = object(detectors.entry) ? detectors.entry : null;
  const keys = [...(transient || entry ? ['sample'] : []), ...(object(detectors.explore) ? ['explore'] : [])];
  // Fix round 2 (E6): any R1a tool (helpersDefine included) is behind the help check.
  const r1a = Boolean(transient || (Array.isArray(detectors.ux) && detectors.ux.length) || keys.length);
  const skipped = [...(transient ? ['"transient": "DRAGON_R1A_UNAVAILABLE"'] : []), ...(Array.isArray(detectors.ux) && detectors.ux.length ? ['"ux": "DRAGON_R1A_UNAVAILABLE"'] : []),
    ...(entry ? ['"entry": "DRAGON_R1A_UNAVAILABLE"'] : [])];
  parts.push(`Detectors (QA GUI ${STREAM_DETECTORS_VERSION}): Dragon calls only, on the tab of this case; labels in \`as\` are exact. Click steps carry ${json({ fast })}.${r1a ? ` ${R1A_RULE} Then skip every step of this section${object(detectors.explore) ? ' (the exploration too: it is reported, not held against the case)' : ''}${skipped.length ? ` and write \`"detectors": {"unavailable": {${skipped.join(', ')}}}\` in the state` : ''}; the rest of the case runs as before.${keys.length ? ` ${PATHS_RULE(false)}` : ''} With R1a: ${RUN_ALL}` : ''}`);
  if (keys.length) parts.push(`Helpers, once, before their first use, only on a Dragon with R1a: ${helperLine(keys, pack)}`);
  if (transient) {
    parts.push([
      `T (transient probe, R1d) around the case's main action, which is risky (QA GUI decides how often it may be repeated: ${transient.trials} trials). The recording of the main action stays the evidence; the probe repeats the action AFTER stopRecording and AFTER the case's envReset (a frame window cannot open while a recording runs; a trial runs at the default environment).`,
      `For each of the ${transient.trials} trials: framesTrial ${json({ tabId: '<tab>', correlationId: 'transient:<state>', ...trialParams({ step: { clickSelector: '<css of the action target>' }, targetSelector: '<css of the action target>', fast, setup: ['<steps>'] }) })} with the action step replaced by the real one (a {"key":...} step for a key action), "<state>" the state the action led to, and "setup" the steps that put the page back exactly as it was before the action${transient.reset ? ' (the plan\'s reset steps first)' : ''}${transient.fresh ? ' (this action adds or saves data and the plan gives no reset path: each trial\'s setup opens the empty form again and fills it with fresh test values, the case\'s own values with "-T1", "-T2" or "-T3" appended, or the closest value the field\'s own rule accepts, so each trial adds its own test record; never the case\'s own values again)' : ''}, in every trial, the first too. One call per trial: never framesStart/framesStop for this. Every trial acts on the main action's own target (the selector or key the state names below; its sample on that selector). When its sensors.more is true, sensorsRead {"tabId":"<tab>","since":<its sensors.cursor>,"max":200} again with each cursor until more is false. When Dragon refuses a trial with DESTRUCTIVE_HANDOFF_REQUIRED (its manual destructive policy), do not retry it or change its steps: stop the probe there (it is N/A, reported).`,
      'On the state the main action led to, name it: `"transient": {"action": {"method": "click", "selector": "<css>", "target": {"tag": "button", "label": "<text>", "type": "<type>", "inForm": true}}}`.',
      ...(Array.isArray(detectors.ux) && detectors.ux.length ? [] : ['After the last trial: envReset {"tabId":"<tab>"} once and check that it answers atDefault:true (a probed case whose reset is not verified cannot PASS).']),
    ].join('\n'));
  }
  if (Array.isArray(detectors.ux) && detectors.ux.length) {
    parts.push([
      `U (forced UX states, R1c) for ${detectors.ux.join(', ')}: force the state at the environment layer only, never in the page. Inline QA GUI scripts/ui-sanity.js in the first read so \`__uxObserve\` exists. Name the rules in the state: \`"ux": ["U1","U2"]\`.`,
      `- U1/U2 (a write held), on the state after the write${detectors.fresh ? ' (the form filled again with fresh test values, as the probe trials fill it: this write has no reset path in the plan)' : ''}: envSet {"tabId":"<tab>","caseId":"${caseId}","requests":[{"id":"write","urlPattern":"*/<endpoint>*","method":"POST","action":"hold"}]}; one do: read __uxObserve({trigger:"<css>"}) as "u:hold:before", the trusted click ${click('<css>')}, {"wait":1200}, read __uxObserve({trigger:"<css>"}) as "u:hold:during"; envGet {"tabId":"<tab>"}; envRelease {"tabId":"<tab>","ruleId":"write"}; waitFor the result; read __uxObserve() as "u:hold:after"; envGet {"tabId":"<tab>"}; then take that state's screenshot.`,
      `- U3 (a forced error), on the error state: envSet {"tabId":"<tab>","caseId":"${caseId}","requests":[{"id":"save-error","urlPattern":"*/<endpoint>*","method":"POST","action":"respond","status":500,"times":1}]}; fill the form with trusted input; read __uxObserve() as "u:error:before"; submit; waitFor the error; read __uxObserve() as "u:error:after"; envGet {"tabId":"<tab>"}.`,
      '- U4, U5, U6, U9 ride Gate-0: call `__uiSanity(\'<state>\', {ux:{}})` and `__a11yB({minTarget:24, ux:{}})` and return both whole, `{ui: <the __uiSanity report>, a11y: <the __a11yB report>}`, in the g0 read. U6: move focus with the do step {"key":"Tab"}.',
      `End of case: envReset {"tabId":"<tab>"} after the last state (also when the case ends early) and check that it answers atDefault:true; a case whose reset is not verified cannot PASS. Pass "caseId":"${caseId}" in every envSet.`,
    ].join('\n'));
  }
  if (entry) parts.push(entryPart({ entry }));
  if (object(detectors.explore)) {
    const budget = Number.isInteger(detectors.explore.budget) ? detectors.explore.budget : 12;
    const observe = (as) => json(helperCall('explore', null, as));
    parts.push([
      `Exploration (R1e frontier, the tracked plan has a coverage block), once, after the last state of the case: do {"brief":true,"steps":[{"goto":"<start url>"},${observe('x:0')}]}. Then up to ${budget} times: pick one candidate of the latest observation that is not marked blocked, preferring a requirement cell or a high-risk cell of this policy, then save/submit/delete/confirm, then navigation, sort, filter, open/close; never a destructive one the policy does not approve; send do {"brief":true,"steps":[${click('<candidate selector>')}, {"wait":150}, ${observe('x:<n>')}]} (n = 1, 2, ...). To reach a candidate of an earlier screen, start the next step with {"goto":"<start url>"} and the clicks that led there. Stop when nothing is left. Finally do {"brief":true,"steps":[${json(helperCall('explore', ['css'], 'x:css'))}]}. Name it in that state with \`"explore": true\`.`,
      `Policy: ${json(detectors.explore.policy ?? {})}`,
    ].join('\n'));
  }
  return parts.join('\n\n');
}

// ── the screen check (once per screen per run, its own dispatch) ──────────────────────────────────────────────────
export const SCREEN_DRAFT_MARKER = 'TEAMQA_SCREEN_DRAFT v1';
export const SCREEN_CHECK_SCHEMA = 'qa-gui/screen-check/v1';
// The coarse sweep goes in two dos, split at this width (the first holds MIN .. SPLIT - STEP).
const SWEEP_SPLIT = SWEEP_DEFAULTS.min + Math.ceil((SWEEP_DEFAULTS.max - SWEEP_DEFAULTS.min) / SWEEP_DEFAULTS.step / 2) * SWEEP_DEFAULTS.step;
const coarseWidths = () => { const out = []; for (let w = SWEEP_DEFAULTS.min; w < SWEEP_DEFAULTS.max; w += SWEEP_DEFAULTS.step) out.push(w); out.push(SWEEP_DEFAULTS.max); return out; };
/** The `do` steps that measure the sweep at `widths` (each: the viewport, the settle wait, the measure call). */
export function sweepWidthSteps(widths, height = SWEEP_DEFAULTS.height) {
  return widths.flatMap((w) => [{ viewport: { width: w, height, deviceScaleFactor: 1, mobile: false } }, { wait: SETTLE_MS }, helperCall('sweep', ['measure'], `w:${w}`)]);
}

/**
 * The recipe of one screen check dispatch: the width sweep and the overlay check of one screen (route, url), signed in
 * as the screen's role (`role`, with the run's sign-in steps for it, `signIn`). Fix round 2 (E9): the helpers come from
 * QA GUI's helper pack (path and hash), and the long legs are Dragon loops ({forEach}), so the model types no body and
 * no do of more than a few steps. Fix round 2 (E5): each way out is clicked from the open it is checked against: a do
 * ends at the `-open` read whose backdrop point or close button the next do clicks.
 */
export function screenCheckPromptSection({ screenId, url, route, role = null, signIn = null, planned = [], fast = false, pack = helperPack(), entry = null }) {
  const S = (as, args = null) => json(helperCall('overlay', args, as));
  // Round G (G4): a screen with no route is reached from its case's entry link by the case's own steps up to its first
  // write; every later goto goes to where that landed (w:found's href), never to the entry link again.
  const entered = object(entry) && typeof entry.url === 'string';
  const click = (sel) => json(withClickSpeed({ clickSelector: sel }, fast));
  const loop = (name, over, steps) => json({ forEach: { name, ...over }, steps });
  const widths = (over) => loop('w', over, [{ viewport: { width: `$w`, height: SWEEP_DEFAULTS.height, deviceScaleFactor: 1, mobile: false } }, { wait: SETTLE_MS }, helperCall('sweep', ['measure'], 'w:$w')]);
  const tabs = (count) => loop('i', { range: [1, count] }, [{ key: 'Tab' }]);
  const go = entered ? '{"goto":"<w:found.href>"}' : json({ goto: url });
  const signedIn = entered
    ? `Reach the screen from the entry link ${json(entry.url)}: open it once (it may reset the app's data and sign out; never open it again), then follow these steps of ${entry.caseId ? `case ${entry.caseId}` : 'its case'} up to its first write: ${json((Array.isArray(entry.steps) ? entry.steps : []).slice(0, 12))}. Follow only sign-in and navigation; never click a control that saves, deletes or submits (the sign-in button excepted). ${entry.account ? `Sign in with the account ${json(entry.account)} of the run's accounts file (read it, never print a secret). ` : signIn ? `Sign in ${signIn}. ` : ''}Stop on the screen the steps name. Below, "<w:found.href>" is the href w:found returns there.`
    : role
    ? `Sign in as the role ${json(role)} before anything else, exactly as a case of that role signs in${signIn ? `: ${signIn}` : ' (the run\'s sign-in steps for that role)'}; every goto below must then show the screen itself. If it lands elsewhere (a sign-in page, another page), still run the steps: the reads record where the page was and Team QA grades it.`
    : 'No role: run the steps as the run\'s default session. If a goto lands elsewhere (a sign-in page, another page), still run the steps: the reads record where the page was.';
  return [
    `Screen check ${screenId} (QA GUI ${STREAM_DETECTORS_VERSION}): the width sweep and the overlay check of the screen ${entered ? `a case reaches from ${url}` : `${route} at ${url}`}, once for the whole run. Dragon calls only, on your own tab, every do with "brief":true and "timeout":120000. Labels in \`as\` are exact: Team QA rebuilds both checks from them. ${LOOP_NOTE}`,
    `0. ${R1A_RULE} Then print the draft below with "unavailable": "DRAGON_R1A_UNAVAILABLE" and stop. ${PATHS_RULE(true)}`,
    `1. ${helperLine(['sweep', 'overlay'], pack)}`,
    `2. ${signedIn}`,
    `3. Width sweep, in two dos (each answer stays small enough to show inline): do {"brief":true,"timeout":120000,"steps":[${entered ? '' : `${go},`}${json(helperCall('sweep', ['found'], 'w:found'))},${widths({ range: [SWEEP_DEFAULTS.min, SWEEP_SPLIT - SWEEP_DEFAULTS.step, SWEEP_DEFAULTS.step] })}]}; do brief [${widths({ range: [SWEEP_SPLIT, SWEEP_DEFAULTS.max, SWEEP_DEFAULTS.step] })}, ${json(helperCall('sweep', ['refine'], 'w:refine'))}].`,
    `4. If w:refine returned widths: do brief [${widths({ values: ['<those widths, at most 30 per do>'] })}] for each 30 of them. Then do brief [${json(helperCall('sweep', ['bands'], 'w:bands'))}].`,
    `5. For each band of w:bands: do brief [{"viewport":{"width":<from>,"height":${SWEEP_DEFAULTS.height},"deviceScaleFactor":1,"mobile":false}},{"wait":${SETTLE_MS}}]; if it has a target, paintSnapshot {"tabId":"<tab>","selector":<target>}; screenshot {"tabId":"<tab>","evidence":true,"toFile":"${screenId}-sweep-<from>.jpg"}.`,
    `6. do brief [${loop('r', { values: ['<w:bands.rows as returned>'] }, [{ viewport: { width: '$r.width', height: '$r.height', deviceScaleFactor: '$r.deviceScaleFactor', mobile: '$r.mobile' } }, { wait: SETTLE_MS }, helperCall('sweep', ['emu'], 'w:row:$r.id:emu'), helperCall('sweep', ['measure'], 'w:row:$r.id:geo')])}, {"viewport":{"width":<w:found.width>,"height":<w:found.height>,"deviceScaleFactor":<w:found.dpr>,"mobile":<w:found.touch>}}, {"wait":${SETTLE_MS}}, ${json(helperCall('sweep', ['viewport'], 'w:restored'))}, ${go}, ${S('o:triggers', ['triggers'])}].`,
    `7. Overlay check. The triggers in order: ${planned.length ? `${json(planned)} first (those of them o:triggers lists), then ` : ''}the others in the order o:triggers lists them; check the first ${OVERLAY_DEFAULTS.maxTriggers}, k = 0, 1, 2, S its selector; the rest are listed, not checked. For each, with every read a call of the overlay helper (args omitted unless given), four dos; "and stop there" means the do ends with that read, because the next do uses what it shows:`
      + ` (a) [${go}, ${S('o:k:kbd-0', ['log'])}, ${tabs(OVERLAY_DEFAULTS.keyboardLimit)}] (a long answer you need nothing from);`
      + ` (b) [${S('o:k:kbd', ['keylog'])}, ${go}, ${S('o:k:before')}, ${click('S')}, {"wait":300}, ${S('o:k:first')}, ${loop('n', { range: [1, OVERLAY_DEFAULTS.tabLimit] }, [{ key: 'Tab' }, helperCall('overlay', null, 'o:k:trap-$n')])}, ${S('o:k:scroll-from')}, {"scroll":{"delta":400}}, ${S('o:k:scroll-to')}, ${S('o:k:now')}] and stop there;`
      + ` (c) [if o:k:now has innerTriggers: click the first, {"wait":300}, ${S('o:k:stacked-two')}, {"key":"Escape"}, ${S('o:k:stacked-esc')}; then ${go}, click S, {"wait":300}, ${S('o:k:esc-open')}, {"key":"Escape"}, ${S('o:k:esc-after')}, ${go}, click S, {"wait":300}, ${S('o:k:backdrop-open')}] and stop there;`
      + ` (d) [if o:k:backdrop-open has a backdropPoint {x,y}: ${json(withClickSpeed({ clickXY: ['<x>', '<y>'] }, fast))}, {"wait":300}, ${S('o:k:backdrop-after')}; then ${go}, click S, {"wait":300}, ${S('o:k:button-open')}] and stop there.`
      + ` Then send as the first steps of the next trigger's (a) do (or of a last do [..., ${go}]): if o:k:button-open has a closeButton C: click C, {"wait":300}, ${S('o:k:button-after')}; and if some sample of o:k:kbd has active equal to S (the first such, n = its position from 1): ${go}, ${loop('i', { range: [1, '<n>'] }, [{ key: 'Tab' }])}, ${S('o:k:kbd-reach')}, {"key":"Enter"}, {"wait":300}, ${S('o:k:kbd-enter')}.`,
    `8. Print one line \`${SCREEN_DRAFT_MARKER}\` then a json block {"screen_id": ${json(screenId)}, "url": ${json(url)}} (with "unavailable": "DRAGON_R1A_UNAVAILABLE" when step 0 found no R1a). Nothing else is graded from your text.`,
  ].join('\n');
}

const triOf = (verdicts) => (verdicts.includes('FAIL') ? 'FAIL' : verdicts.length && verdicts.every((v) => v === 'PASS') ? 'PASS' : 'UNGRADED');

/**
 * Fix round 2 (E1, E2): the key a route or a URL is compared by. The hash and a trailing slash are dropped; the query is
 * kept only when the planned route has one (`query`). An absolute URL keeps its origin, so a redirect to another site
 * never matches a path. Null for a value that is no URL. Fix round 3 (F3): a hash route (`#/...`, the rule of
 * routeOf) is kept, with its own trailing slash dropped and its own query kept only with `query`; any other hash is an
 * anchor and is dropped.
 */
export function screenRouteKey(value, { query = false, origin = false } = {}) {
  if (typeof value !== 'string' || !value) return null;
  let u;
  try { u = new URL(value, 'http://route.invalid'); } catch { return null; }
  let hash = '';
  if (u.hash.startsWith('#/')) {
    const q = u.hash.indexOf('?');
    const route = (q >= 0 ? u.hash.slice(0, q) : u.hash).replace(/\/+$/, '');
    hash = route === '#' ? '' : `${route}${query && q >= 0 ? u.hash.slice(q) : ''}`;
  }
  const path = (u.pathname.replace(/\/+$/, '') || '/') + (query ? u.search : '') + hash;
  return origin && u.origin !== 'http://route.invalid' ? `${u.origin}${path}` : path;
}
const routeHasQuery = (route) => typeof route === 'string' && route.includes('?');
/** Whether a page at `href` is the screen `route` (at `url`), by screenRouteKey on both sides. */
export function onScreenRoute(href, { route, url = null }) {
  const query = routeHasQuery(route);
  if (screenRouteKey(href, { query }) !== screenRouteKey(route, { query })) return false;
  if (typeof url === 'string' && /^https?:/i.test(url) && /^https?:/i.test(String(href))) return new URL(href).origin === new URL(url).origin;
  return true;
}

/**
 * One screen check from the recorded calls of its dispatch: the sweep and overlay receipts (QA GUI's own helpers
 * proven), their verdicts by QA GUI's graders, and the issues. `qa-gui/screen-check/v1`. E2: the sweep's first read
 * (w:found) and the overlay inventory (o:triggers) say where the page was; a page that is not the screen's route (a
 * redirect to sign-in, another page) is UNGRADED SCREEN_ROUTE_MISMATCH, and its measurements are no finding of the screen.
 */
// Round G (G4): a page still at the entry link, or on a sign-in page, did not reach the screen its case names.
const SIGN_IN_PATH = /(?:^|[/#?=_.-])(?:log-?in|sign-?in|signin|auth(?:enticate)?|dang-?nhap)(?:$|[/#?=_.-])/i;
export function entryReached(href, entryUrl) {
  if (typeof href !== 'string' || !href) return false;
  if (screenRouteKey(href, { query: true, origin: true }) === screenRouteKey(entryUrl, { query: true, origin: true })) return false;
  let u; try { u = new URL(href, 'http://route.invalid'); } catch { return false; }
  return !SIGN_IN_PATH.test(`${u.pathname}${u.hash}`);
}

export async function screenCheckFromOps(ops, { screenId, route, url = null, planned = [], captureRef = null, entry = null } = {}) {
  const issues = [];
  const entered = route === null && object(entry) && typeof entry.url === 'string';
  if (entered) {
    // The screen is where the case's steps landed (w:found's href); every later read is checked against it.
    const found = provenOps(ops, 'sweep', 'w:').ops, k = firstRead(found, 'w:found'), v = k >= 0 ? valueOf(found[k]) : null;
    const href = object(v) && typeof v.href === 'string' ? v.href : null;
    if (href && entryReached(href, entry.url)) {
      const measuredRoute = screenRouteKey(href, { query: true });
      const result = await screenCheckFromOps(ops, { screenId, route: measuredRoute, url: href, planned, captureRef });
      return { ...result, route: null, entry: entry.url, measuredRoute, url: href };
    }
    const where = href ? screenRouteKey(href, { query: true }) : 'unknown';
    return { schema: SCREEN_CHECK_SCHEMA, screenId, route: null, entry: entry.url, url, status: 'checked', measured: { sweep: href, overlay: null }, measuredRoute: null, sweep: null, overlay: null,
      verdict: 'UNGRADED', issues: [`SCREEN_ENTRY_NOT_REACHED:${where}`] };
  }
  const sweep = await widthSweepFromOps(ops, { captureRef, helpers: true });
  if (!sweep) issues.push('SWEEP_NOT_RECORDED');
  for (const code of sweep?.issues ?? []) issues.push(code);
  const overlay = overlayCheckFromOps(ops, { route, planned, helpers: true });
  if (!overlay) issues.push('OVERLAY_CHECK_NOT_RECORDED');
  for (const code of overlay?.issues ?? []) issues.push(code);
  // Where each check measured: the href its first proven read returned.
  const proven = { sweep: provenOps(ops, 'sweep', 'w:').ops, overlay: provenOps(ops, 'overlay', 'o:').ops };
  const hrefOf = (list, as) => { const k = firstRead(list, as); const v = k >= 0 ? valueOf(list[k]) : null; return object(v) && typeof v.href === 'string' ? v.href : null; };
  const measured = { sweep: sweep?.receipt ? hrefOf(proven.sweep, 'w:found') : null, overlay: overlay?.receipt ? hrefOf(proven.overlay, 'o:triggers') : null };
  const wrong = new Map();
  const query = routeHasQuery(route);
  for (const [check, href] of Object.entries(measured)) {
    if ((check === 'sweep' && !sweep?.receipt) || (check === 'overlay' && !overlay?.receipt)) continue;
    if (href === null) wrong.set(check, `SCREEN_ROUTE_UNKNOWN:${check}`);
    else if (!onScreenRoute(href, { route, url })) wrong.set(check, `SCREEN_ROUTE_MISMATCH:${check}:${screenRouteKey(href, { query })}`);
  }
  // Fix round 3 (F5): the page is read after every goto of the screen check, not only the first: the first proven read
  // of the sweep or overlay helper after a goto says where that goto landed (a late sign-in redirect, a session that ran
  // out); a goto that landed elsewhere drops the check whose read it was.
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].kind !== 'goto') continue;
    let r = k + 1;
    while (r < ops.length && !(ops[r].kind === 'read' && /^[wo]:/.test(String(ops[r].step?.as ?? ''))) && ops[r].kind !== 'goto') r += 1;
    if (r >= ops.length || ops[r].kind === 'goto') continue;
    const check = ops[r].step.as.startsWith('w:') ? 'sweep' : 'overlay';
    const read = proven[check][r];
    const v = read?.ok ? valueOf(read) : null;
    if (wrong.has(check) || !object(v) || typeof v.href !== 'string') continue;
    if (!onScreenRoute(v.href, { route, url })) wrong.set(check, `SCREEN_ROUTE_MISMATCH:${check}:${screenRouteKey(v.href, { query })}`);
  }
  issues.push(...wrong.values());
  // Fix round 3 (F5): only the check that measured another page is dropped; the other one is graded as usual.
  const graded = [];
  if (sweep?.receipt && !wrong.has('sweep')) { const g = sweepVerdict(sweep.receipt); graded.push(g.verdict); issues.push(...g.issues.filter((c) => !issues.includes(c))); }
  if (overlay?.receipt && !wrong.has('overlay')) { const g = overlayVerdict(overlay.receipt); graded.push(g.verdict); issues.push(...g.issues.filter((c) => !issues.includes(c))); }
  const complete = Boolean(sweep?.receipt && overlay?.receipt) && !wrong.size;
  const verdict = graded.includes('FAIL') ? 'FAIL' : complete ? triOf(graded) : 'UNGRADED';
  return { schema: SCREEN_CHECK_SCHEMA, screenId, route, url, status: 'checked', measured, sweep: sweep?.receipt ?? null, overlay: overlay?.receipt ?? null, verdict, issues };
}

// The receipt of one detector kind across the attested attempts of a screen check: a FAIL in any attempt stands (its
// receipt is the one folded); otherwise the latest attempt that has one. An attempt whose check of that kind measured
// another page gives none of that kind (fix round 3, F5: the other kind of the same attempt still counts).
function attemptReceipt(attempts, field, verdictOf) {
  const elsewhere = new RegExp(`^SCREEN_ROUTE_(MISMATCH|UNKNOWN):${field}(:|$)`);
  const usable = attempts.filter((r) => object(r?.[field]) && !(Array.isArray(r.issues) && r.issues.some((c) => elsewhere.test(c))));
  const failed = usable.find((r) => verdictOf(r[field]).verdict === 'FAIL');
  return (failed ?? usable.at(-1))?.[field] ?? null;
}

/**
 * The screen checks of a case, folded into its collect. `states` are [{state, url}] in order; `screens` are the
 * screens the plan puts this case on: {screenId, route, status: 'checked' (with `attempts`, the screenCheckFromOps
 * values of every attested attempt, oldest first, or one `result`) | 'unavailable' (a Dragon without R1a) | 'missing'
 * (no attested check) | 'no-route'}. Fix round 2 (E1): a screen is matched to the case's first state on its route by
 * screenRouteKey on both sides, else to the case's first captured state (the plan put the case there); a check that
 * was planned and has no attested result is a detector not run, visited or not; the sweep and the overlay check each
 * fold the attempt that FAILed, else the latest; a check that could not be graded (or measured another page) makes the
 * case's UI UNGRADED (SCREEN_CHECK_UNGRADED:<screenId>). A screen without a route is N/A (SCREEN_NO_ROUTE); on a Dragon
 * without R1a it is reported only.
 */
export function foldScreenChecks({ caseId, states = [], screens = [] }) {
  const byState = new Map(states.map((s) => [s.state, { probes: [], issues: [], notes: [] }]));
  const issues = [], notes = [];
  for (const screen of screens) {
    if (screen.status === 'no-route') { notes.push(`SCREEN_NO_ROUTE:${caseId}`); continue; }
    if (screen.status === 'unavailable') { notes.push(`SCREEN_CHECK_UNAVAILABLE:${screen.screenId}:DRAGON_R1A_UNAVAILABLE`); continue; }
    // Round G (G4): a screen with no route belongs to its own case(s) by case id: its first state on the route the
    // check measured, else its first captured state.
    const attemptsOf = (Array.isArray(screen.attempts) ? screen.attempts : object(screen.result) ? [screen.result] : []).filter(object);
    const entryRoute = screen.route === null || screen.route === undefined ? attemptsOf.map((r) => r.measuredRoute).filter((x) => typeof x === 'string').at(-1) ?? null : null;
    const route = entryRoute ?? screen.route;
    const query = routeHasQuery(route);
    const onRoute = (s) => route !== null && route !== undefined && screenRouteKey(s.url ?? '', { query }) === screenRouteKey(route, { query });
    const at = states.find(onRoute) ?? states[0] ?? null;
    const into = at ? byState.get(at.state) : null;
    const flag = (code) => { issues.push(code); if (into) into.issues.push(code); };
    const attempts = (Array.isArray(screen.attempts) ? screen.attempts : object(screen.result) ? [screen.result] : []).filter(object);
    if (screen.status !== 'checked' || !attempts.length) { flag(`DETECTOR_NOT_RUN:${caseId}:screens:${screen.screenId}`); continue; }
    if (!at) { flag(`SCREEN_CHECK_UNGRADED:${screen.screenId}`); continue; }
    const sweep = attemptReceipt(attempts, 'sweep', sweepVerdict), overlay = attemptReceipt(attempts, 'overlay', overlayVerdict);
    if (sweep) into.probes.push({ kind: 'width-sweep', receipt: sweep, screenId: screen.screenId });
    if (overlay) into.probes.push({ kind: 'overlay-check', receipt: overlay, screenId: screen.screenId });
    if (screen.route !== null && screen.route !== undefined && at.state !== states.find(onRoute)?.state) notes.push(`SCREEN_FOLDED_INTO_FIRST_STATE:${caseId}:${screen.screenId}:${at.state}`);
    // UNGRADED when a kind has no usable receipt, or the attempt it came from could not grade it for tool reasons.
    const latest = attempts.at(-1);
    const ungraded = !sweep || !overlay || (sweep === latest.sweep && overlay === latest.overlay && latest.verdict === 'UNGRADED' && Array.isArray(latest.issues) && latest.issues.length);
    if (ungraded) flag(`SCREEN_CHECK_UNGRADED:${screen.screenId}`);
    if (Array.isArray(latest.issues) && latest.issues.some((c) => String(c).startsWith('SCREEN_ENTRY_NOT_REACHED'))) flag(`SCREEN_ENTRY_NOT_REACHED:${screen.screenId}`);
  }
  return { states: byState, issues, notes };
}
