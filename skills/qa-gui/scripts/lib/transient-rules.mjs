// Upgrade R1d: the transient-defect rules T1–T8 over the streams a probe window recorded around one action (Dragon R1a
// sensors, the frame index, geometry samples and the network log). Pure and deterministic: the gate re-runs them on the
// recorded streams of a probe receipt and never trusts a stored verdict. references/transient-rules.md documents each
// rule (signal, threshold, warn or block) and the probe receipt.
//
// Every threshold below is a starting point taken from public sources (Layout Instability's 3 px, RAIL's 100 ms, the
// 300 ms flash and occlusion bounds of the R1d proposal, WCAG 2.3.1's three flashes a second, LoAF/GUIWatcher's 100 ms
// frame). None was fitted to eval data; the eval calibrates them on its dev sets (EV2) and pre-registers the result.
import { realSpeed } from './dragon-env.mjs';

export const T_RULES = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
export const T_DEFAULTS = Object.freeze({
  windowBeforeMs: 100, windowAfterMs: 1000, windowMaxMs: 3000, extendStepMs: 250,
  sampleOffsetsMs: Object.freeze([-100, 16, 50, 100, 250, 500, 1000]),
  t1MinShiftPx: 3,
  t2MinOcclusionMs: 300, t2OverlayLeadMs: 150,
  t3MaxFlashMs: 300,
  t4MinSamples: 2,
  t5GraceMs: 100, t5MinOpenMs: 100,
  t6FocusSettleMs: 100, t6ScrollJumpPx: 200, t6ScrollJumpViewport: 0.5, t6MinReversals: 2, t6MinStepPx: 2,
  t7LongFrameMs: 100,
  t8LongAnimationMs: 500, t8MaxFlashesPerSecond: 3, t8ReducedMotionMs: 100,
  confirmRepeats: 3, confirmMinK: 2, sameMarkToleranceMs: 100, sameMarkToleranceRatio: 0.2,
});
// What each rule blocks: FAIL after confirmation (block), or never more than a warning (warn).
export const T_LEVEL = Object.freeze({ T1: 'block', T2: 'block', T3: 'block', T4: 'block', T5: 'block', T6: 'block', T7: 'warn', T8: 'warn-except-flash' });
// Rules that read frames: a window whose frames around the action were dropped (privacy) cannot grade them.
const FRAME_RULES = new Set(['T3', 'T8']);
export const SCHEDULES = Object.freeze(['stable', 'fixed7', 'events', 'all']);

// ── element descriptors (Dragon: tag#id.class1.class2[role=..][data-testid=..], up to 4 levels joined by '>') ──
const lastPart = (d) => String(d ?? '').split('>').pop();
const tagOf = (d) => (/^[a-z][a-z0-9-]*/i.exec(lastPart(d)) || [''])[0].toLowerCase();
const roleOf = (d) => (/\[role=([^\]]+)\]/.exec(lastPart(d)) || [null, ''])[1].toLowerCase();
const namesOf = (d) => lastPart(d).replace(/\[role=[^\]]*\]/g, '').toLowerCase();
const CONTROL_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'radio', 'textbox', 'searchbox', 'slider']);
const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'status', 'alert', 'tooltip', 'menu', 'listbox']);
const OVERLAY_NAMES = /toast|snack|tooltip|popover|notif|banner|overlay|modal|drawer|sheet|flash|dialog|popup/;
const WRONG_STATE_NAMES = /empty|no-?results|no-?data|nothing|error|fail|not-?found|unavailable|offline/;
const BUSY_NAMES = /spinner|loading|loader|progress|skeleton|busy|shimmer|placeholder/;
const LAYOUT_PROPS = new Set(['width', 'height', 'top', 'left', 'right', 'bottom', 'inset', 'margin', 'margin-top', 'margin-bottom', 'margin-left',
  'margin-right', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'border-width', 'font-size', 'line-height',
  'max-height', 'min-height', 'max-width', 'min-width', 'flex-basis', 'grid-template-columns', 'grid-template-rows', 'all']);
export const isControl = (d) => CONTROL_TAGS.has(tagOf(d)) || CONTROL_ROLES.has(roleOf(d));
export const isOverlay = (d) => tagOf(d) === 'dialog' || OVERLAY_ROLES.has(roleOf(d)) || OVERLAY_NAMES.test(namesOf(d).replace(/^[a-z0-9-]+/, ''));
export const isWrongState = (d) => roleOf(d) === 'alert' || WRONG_STATE_NAMES.test(namesOf(d).replace(/^[a-z0-9-]+/, ''));
export const isBusy = (d) => roleOf(d) === 'progressbar' || BUSY_NAMES.test(namesOf(d).replace(/^[a-z0-9-]+/, ''));
const isRoot = (d) => typeof d === 'string' && ['html', 'body'].includes(tagOf(d));
const isBody = (d) => d == null || d === 'document' || isRoot(d);
const within = (child, parent) => typeof child === 'string' && typeof parent === 'string' && child !== parent
  && (child.startsWith(`${parent}>`) || child.includes(`>${lastPart(parent)}>`) || child.startsWith(`${lastPart(parent)}>`));
const parentOf = (d) => String(d).split('>').slice(0, -1).join('>');
const sameNode = (a, b) => typeof a === 'string' && typeof b === 'string' && a && b && (a === b || a.endsWith(`>${b}`) || b.endsWith(`>${a}`) || a.endsWith(b) || b.endsWith(a));
const overlap = (a, b) => !!a && !!b && Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ── one trial ──────────────────────────────────────────────────────────────────────────────────────────────────
// trial = {markT, window:{from,to}, conditions, action:{kinds,x?,y?}, events, samples, network, held?, frames:{index,kept,keep,ok}|null}
export function trialView(trial, o = T_DEFAULTS) {
  const events = (Array.isArray(trial?.events) ? trial.events : []).filter((e) => e && finite(e.t)).slice().sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
  const markT = trial.markT;
  const from = markT - o.windowBeforeMs;
  const to = finite(trial.window?.to) ? trial.window.to : markT + o.windowAfterMs;
  const by = (k) => events.filter((e) => e.k === k);
  const hello = by('hello').filter((e) => e.t <= markT).at(-1) ?? by('hello')[0] ?? null;
  const input = by('input').find((e) => e.t >= markT - 50 && e.t <= markT + 500 && (e.type === 'pointerdown' || e.type === 'keydown' || e.type === 'click'));
  const samples = (Array.isArray(trial.samples) ? trial.samples : []).filter((s) => s && finite(s.t)).slice().sort((a, b) => a.t - b.t);
  return {
    trial, markT, from, to, events, samples, hello,
    vw: trial.viewport?.vw ?? hello?.vw ?? samples[0]?.vw ?? null, vh: trial.viewport?.vh ?? hello?.vh ?? samples[0]?.vh ?? null,
    click: finite(trial.action?.x) ? { x: trial.action.x, y: trial.action.y } : input && finite(input.x) ? { x: input.x, y: input.y } : null,
    kinds: new Set(Array.isArray(trial.action?.kinds) ? trial.action.kinds : []),
    by, inWin: (t) => t >= from && t <= to,
    mutatedAfterMark: by('mutation').some((e) => e.t > markT && e.t <= to),
  };
}

// Per target, the visibility timeline [{t, intersecting, visible, ratio, rect}]. A node removed from the DOM is reported
// under its detached descriptor (`div.x` instead of `ul#list>div.x`): that report closes the attached node's track.
function visibilityTracks(v) {
  const tracks = new Map();
  for (const e of v.by('visibility')) {
    if (typeof e.target !== 'string') continue;
    if (!tracks.has(e.target)) tracks.set(e.target, []);
    tracks.get(e.target).push(e);
  }
  for (const [target, track] of [...tracks]) {
    if (target.includes('>')) continue;
    const attached = [...tracks.keys()].filter((t) => t.endsWith(`>${target}`));
    if (attached.length !== 1) continue;
    for (const e of track) if (!shown(e)) tracks.get(attached[0]).push(e);
    tracks.get(attached[0]).sort((a, b) => a.t - b.t);
  }
  return tracks;
}
const stateAt = (track, t) => { let s = null; for (const e of track) { if (e.t <= t) s = e; else break; } return s; };
const shown = (e) => !!e && e.intersecting === true && (e.ratio ?? 1) > 0;

// Appearances of targets matching `match` after the window opened: [{target, from, to, open, rect}].
function appearances(v, tracks, match) {
  const out = [];
  for (const [target, track] of tracks) {
    if (!match(target)) continue;
    let cur = null;
    for (const e of track) {
      if (shown(e) && !cur) {
        if (e.t < v.from) { cur = { target, from: e.t, pre: true, rect: e.rect }; continue; }
        cur = { target, from: e.t, rect: e.rect };
      } else if (!shown(e) && cur) {
        if (!cur.pre) out.push({ ...cur, to: e.t, open: false });
        cur = null;
      } else if (cur && e.rect) cur.rect = cur.rect ?? e.rect;
    }
    if (cur && !cur.pre) out.push({ ...cur, to: v.to, open: true });
  }
  return out;
}

const episode = (rule, sub, subject, from, to, measure, extra = {}) => ({ rule, sub, subject: String(subject ?? sub), from, to, measure, level: 'fail', observe: 'sampled', minSamples: 1, ...extra });

// T1 layout jump: a layout shift moves a control or the content being read by >= 3 px, outside the part the user just
// expanded. Shifts flagged hadRecentInput count too: content pushed right after a click is the defect to catch.
function t1(v, o) {
  const streams = v.trial.sensors?.streams ?? v.trial.streams;
  const supported = v.hello?.supported?.['layout-shift'] === true || streams?.['layout-shift'] === 'cdp' || v.by('layout-shift').length > 0;
  if (!supported) return { applicable: true, unmeasured: 'LAYOUT_SHIFT_UNSUPPORTED', episodes: [] };
  if (!v.mutatedAfterMark && !v.by('resize').some((e) => e.t > v.markT && e.t <= v.to)) return { applicable: false, episodes: [] };
  const shifts = v.by('layout-shift').filter((e) => v.inWin(e.t));
  const expanded = v.kinds.has('disclosure') || v.kinds.has('list-add') || v.kinds.has('list-remove');
  const episodes = [];
  for (const e of shifts) {
    let best = null;
    for (const s of Array.isArray(e.sources) ? e.sources : []) {
      if (!s?.prev || !s?.cur) continue;
      const d = Math.max(Math.abs(s.cur.x - s.prev.x), Math.abs(s.cur.y - s.prev.y));
      if (d < o.t1MinShiftPx) continue;
      const inView = (r) => !v.vw || (r.x < v.vw && r.x + r.w > 0 && r.y < v.vh && r.y + r.h > 0);
      if (!inView(s.prev) && !inView(s.cur)) continue;
      if (expanded && e.hadRecentInput && v.click && s.prev.y >= v.click.y) continue;
      // Dogfood 05/11: right after a click, controls beside the pressed one slide sideways a few px when its own label
      // changes ("Save" to "Saving..."): the same 4 px, dy 0 shift on a clean form and on a faulty one. A shift the
      // browser marks hadRecentInput counts when it moves something vertically by t1MinShiftPx or more.
      if (e.hadRecentInput && Math.abs(s.cur.y - s.prev.y) < o.t1MinShiftPx) continue;
      if (!best || d > best.d) best = { d, s };
    }
    if (!best) continue;
    // A CDP source names a backendNodeId, which differs on every load: the box it moved from names it across repeats.
    const boxName = (s) => s.node ?? `box:${Math.round(s.prev.x / 8) * 8},${Math.round(s.prev.y / 8) * 8},${Math.round(s.prev.w / 8) * 8}x${Math.round(s.prev.h / 8) * 8}`;
    const subject = boxName(best.s);
    const back = shifts.find((x) => x.t > e.t && (x.sources || []).some((s) => s?.prev && s?.cur && Math.abs(s.cur.y - best.s.prev.y) <= 2 && Math.abs(s.cur.x - best.s.prev.x) <= 2
      && Math.abs(s.prev.y - best.s.cur.y) <= 2));
    episodes.push(episode('T1', 'shift', subject, e.t, back ? back.t : v.to, { px: Math.round(best.d), dy: best.s.cur.y - best.s.prev.y, value: e.value, hadRecentInput: !!e.hadRecentInput }));
  }
  return { applicable: true, episodes };
}

// T2 transient occlusion: a toast, tooltip or overlay that appeared after the action covers a control for >= 300 ms.
// IntersectionObserver v2 says the control stopped being visible while it intersects the viewport, and the overlay's
// box overlaps the control's box (an opacity change of the control alone is not occlusion).
function t2(v, o) {
  if (v.hello && v.hello.v2 === false) return { applicable: true, unmeasured: 'VISIBILITY_V2_UNSUPPORTED', episodes: [] };
  const tracks = visibilityTracks(v);
  const overlays = appearances(v, tracks, isOverlay);
  if (!overlays.length) return { applicable: false, episodes: [] };
  const episodes = [];
  for (const [target, track] of tracks) {
    if (!isControl(target) || isOverlay(target)) continue;
    for (const ov of overlays) {
      if (within(target, ov.target) || sameNode(target, ov.target)) continue;
      const onset = track.find((e, i) => i > 0 && e.t >= ov.from - o.t2OverlayLeadMs && e.t <= ov.to && e.intersecting && e.visible === false
        && track.slice(0, i).reverse().find((p) => p.intersecting)?.visible === true);
      if (!onset) continue;
      const ovRect = stateAt(tracks.get(ov.target) ?? [], onset.t)?.rect ?? ov.rect;
      if (!overlap(onset.rect, ovRect)) continue;
      const end = track.find((e) => e.t > onset.t && (e.visible === true || !e.intersecting));
      const until = end ? end.t : v.to;
      const ms = until - onset.t;
      if (ms < o.t2MinOcclusionMs) continue;
      episodes.push(episode('T2', 'occlusion', `${target}|${ov.target}`, onset.t, until, { ms: Math.round(ms), open: !end, overlapPx: Math.round(overlap(onset.rect, ovRect)) },
        { minSpanMs: o.t2MinOcclusionMs, minSamples: 2 }));
      break;
    }
  }
  return { applicable: true, episodes };
}

// T3 wrong-state flash: an empty or error state (or a wrong theme) is shown for less than 300 ms and goes away.
function t3(v, o, frames) {
  if (!v.mutatedAfterMark) return { applicable: false, episodes: [] };
  const tracks = visibilityTracks(v);
  const episodes = [];
  const mutations = v.by('mutation');
  // Appearances from IntersectionObserver, and from ResizeObserver, which reports a watched node in the frame it is
  // added (IntersectionObserver v2 reports at most every 100 ms, so a short flash can come and go between two reports).
  const shownBy = new Map(appearances(v, tracks, (d) => isWrongState(d) && !isBusy(d)).map((a) => [a.target, a]));
  for (const e of v.by('resize')) {
    if (!isWrongState(e.target) || isBusy(e.target) || !(e.w > 0 && e.h > 0) || e.t < v.from) continue;
    const prior = shownBy.get(e.target);
    if (prior && prior.from <= e.t) continue;
    const before = v.by('resize').filter((x) => x.target === e.target && x.t < e.t).at(-1);
    if (before && before.w > 0 && before.h > 0 && before.t < v.from) continue;
    const gone = v.by('resize').find((x) => x.target === e.target && x.t > e.t && !(x.w > 0 && x.h > 0));
    shownBy.set(e.target, { target: e.target, from: e.t, to: gone ? gone.t : v.to, open: !gone });
  }
  for (const a of shownBy.values()) {
    // Removed from the DOM: IntersectionObserver may stay silent, so a removal under its parent ends it too.
    const parent = parentOf(a.target);
    const removal = mutations.find((m) => m.t > a.from && m.removed > 0 && (m.targets || []).some((t) => sameNode(t, parent)));
    const end = Math.min(a.open ? Infinity : a.to, removal ? removal.t : Infinity);
    if (!finite(end)) continue;
    const ms = end - a.from;
    if (ms >= o.t3MaxFlashMs) continue;
    episodes.push(episode('T3', 'state-flash', a.target, a.from, end, { ms: Math.round(ms) }));
  }
  // A theme flip-flop on the root that the screen shows: the frame after it is the exact image before it.
  const root = mutations.filter((m) => v.inWin(m.t) && (m.targets || []).some(isRoot)
    && (m.attrNames || []).some((n) => /^(class|style|data-theme|data-color-mode|data-mode|data-bs-theme|color-scheme)$/.test(n)));
  for (let i = 0; i + 1 < root.length; i++) {
    const a = root[i], b = root[i + 1];
    if (b.t - a.t >= o.t3MaxFlashMs) continue;
    if (!frames) { episodes.push({ ...episode('T3', 'theme-flash', 'root', a.t, b.t, { ms: Math.round(b.t - a.t), unconfirmed: true }), level: 'none' }); continue; }
    const before = onScreen(frames, a.t), during = frames.filter((f) => f.t >= a.t && f.t <= b.t + 50), after = onScreen(frames, b.t + 120);
    if (before && after && before.hash === after.hash && during.some((f) => f.hash !== before.hash)) {
      episodes.push(episode('T3', 'theme-flash', 'root', a.t, b.t, { ms: Math.round(b.t - a.t) }, { observe: 'frames' }));
      i++;
    }
  }
  return { applicable: true, episodes: episodes.filter((e) => e.level !== 'none') };
}

const sampleOverflows = (s) => [...(s.overflowX ? ['page-overflow-x'] : []), ...(Array.isArray(s.clipped) ? s.clipped.map((c) => `clipped:${c.sel ?? c}`) : [])];
// T4 overflow during a transition: horizontal overflow or clipped text in at least 2 consecutive samples between the
// stable state before the action and the one after it (absent from both).
function t4(v, o) {
  const pre = v.samples.filter((s) => s.t < v.markT);
  const post = v.samples.filter((s) => s.t > v.markT && s.t <= v.to);
  if (post.length < o.t4MinSamples) return { applicable: true, unmeasured: 'SAMPLES_MISSING', episodes: [] };
  if (!v.mutatedAfterMark) return { applicable: false, episodes: [] };
  const final = post.at(-1);
  const before = new Set(pre.flatMap(sampleOverflows));
  const after = new Set(sampleOverflows(final));
  const subjects = new Set(post.flatMap(sampleOverflows));
  const episodes = [];
  for (const subject of subjects) {
    if (before.has(subject) || after.has(subject)) continue;
    let run = [];
    const flush = (next) => {
      if (run.length >= o.t4MinSamples) episodes.push(episode('T4', 'overflow', subject, run[0].t, next ? next.t : run.at(-1).t, { samples: run.length }, { minSamples: o.t4MinSamples }));
      run = [];
    };
    for (const s of post) { if (sampleOverflows(s).includes(subject)) run.push(s); else flush(s); }
    flush(null);
  }
  return { applicable: true, episodes };
}

// T5 double-click window: the submit control is still clickable and shows nothing busy while its request is pending,
// 100 ms (RAIL) after the click.
function t5(v, o) {
  const writes = (Array.isArray(v.trial.network) ? v.trial.network : []).filter((r) => r && MUTATING.has(String(r.method).toUpperCase()) && finite(r.t) && r.t > v.markT && r.t <= v.markT + 30000);
  const held = (Array.isArray(v.trial.held) ? v.trial.held : []).filter((h) => MUTATING.has(String(h?.method).toUpperCase()));
  const submitLike = ['submit', 'save', 'delete'].some((k) => v.kinds.has(k));
  if (!submitLike || (!writes.length && !held.length)) return { applicable: false, episodes: [] };
  const pendingUntil = held.length ? Infinity : Math.max(...writes.map((r) => r.t));
  const watched = v.samples.filter((s) => s.t > v.markT + o.t5GraceMs && s.t < pendingUntil && s.t <= v.to);
  if (!watched.length || watched.some((s) => !s.target)) return { applicable: true, unmeasured: 'TARGET_UNSAMPLED', episodes: [] };
  const open = (s) => s.target.found !== false && !s.target.disabled && !s.target.ariaDisabled && !s.target.ariaBusy && s.target.pointerEvents !== 'none' && !s.target.inert && !(s.busy > 0);
  const first = watched.find(open);
  if (!first) return { applicable: true, episodes: [] };
  const closed = watched.find((s) => s.t > first.t && !open(s));
  const until = Math.min(closed ? closed.t : Infinity, pendingUntil, v.to);
  // Dogfood 05/11: Dragon records a response when CDP reports it, tens of ms after the page has it, so a control that
  // re-enables on the response looks open for that lag. A window shorter than t5MinOpenMs is not a double-click window.
  if (until - first.t < o.t5MinOpenMs) return { applicable: true, episodes: [] };
  return { applicable: true, episodes: [episode('T5', 'double-click', v.trial.action?.selector ?? 'submit', first.t, until,
    { openMs: Math.round(until - first.t), pendingMs: finite(pendingUntil) ? Math.round(pendingUntil - v.markT) : null })] };
}

// T6 lost focus, lost scroll position, size oscillation.
function t6(v, o) {
  const episodes = [];
  let applicable = false;
  // Focus: after an overlay closes (or the focused node leaves the DOM) focus must not fall to the body.
  const tracks = visibilityTracks(v);
  const focus = v.by('focus');
  const closes = [
    ...[...tracks].filter(([d]) => isOverlay(d)).flatMap(([, track]) => track.filter((e, i) => i > 0 && v.inWin(e.t) && !shown(e) && shown(track[i - 1])).map((e) => e.t)),
    ...focus.filter((e) => v.inWin(e.t) && e.type === 'lost').map((e) => e.t),
    // The focused node removed: Chrome reports a focusout to the body, at the moment nodes leave the DOM (later than the
    // click itself, so a click on a non-focusable spot is not one).
    ...focus.filter((e) => v.inWin(e.t) && e.type === 'out' && isBody(e.active) && e.t > v.markT + 50
      && v.by('mutation').some((m) => m.removed > 0 && Math.abs(m.t - e.t) <= 30)).map((e) => e.t),
  ].sort((a, b) => a - b);
  if (closes.length) {
    applicable = true;
    const start = closes[0] - 50;
    const after = focus.filter((e) => e.t >= start && e.t <= v.to && ['in', 'out', 'lost'].includes(e.type));
    for (const e of after) {
      if (e.type === 'in' || !isBody(e.active)) continue;
      const back = focus.find((x) => x.t > e.t && x.type === 'in');
      const until = back ? back.t : v.to;
      if (until - e.t >= o.t6FocusSettleMs) { episodes.push(episode('T6', 'focus-lost', e.target ?? 'focus', e.t, until, { ms: Math.round(until - e.t) })); break; }
    }
  }
  // Scroll: the page jumps up after the list updates (not after a navigation or a key that scrolls).
  const scrolls = v.by('scroll').filter((e) => e.target === 'document');
  const preY = scrolls.filter((e) => e.t < v.markT).at(-1)?.y ?? v.samples.filter((s) => s.t < v.markT).at(-1)?.sy ?? null;
  if (finite(preY) && preY >= o.t6ScrollJumpPx && v.mutatedAfterMark && !v.kinds.has('route-change')) {
    applicable = true;
    const keyed = v.by('input').some((e) => e.type === 'keydown' && v.inWin(e.t) && /^(Home|PageUp|ArrowUp|End|PageDown|ArrowDown| )$/.test(e.key ?? ''));
    const drop = Math.max(o.t6ScrollJumpPx, (v.vh ?? 0) * o.t6ScrollJumpViewport);
    const jump = keyed ? null : scrolls.find((e) => e.t > v.markT && e.t <= v.to && preY - e.y >= drop);
    if (jump) episodes.push(episode('T6', 'scroll-lost', 'document', jump.t, v.to, { fromY: preY, toY: jump.y }));
  }
  // Size: an element grows and shrinks back and forth (at least two reversals of at least 2 px).
  const sizes = new Map();
  for (const e of v.by('resize')) {
    if (typeof e.target !== 'string' || isRoot(e.target)) continue;
    if (!sizes.has(e.target)) sizes.set(e.target, []);
    sizes.get(e.target).push(e);
  }
  for (const [target, list] of sizes) {
    const inWin = list.filter((e) => e.t > v.markT && e.t <= v.to);
    if (!inWin.length) continue;
    applicable = true;
    const base = list.filter((e) => e.t <= v.markT).at(-1);
    for (const dim of ['h', 'w']) {
      const values = [...(base ? [base] : []), ...inWin];
      let dir = 0, reversals = 0, first = null, last = null;
      for (let i = 1; i < values.length; i++) {
        const d = values[i][dim] - values[i - 1][dim];
        if (Math.abs(d) < o.t6MinStepPx) continue;
        const s = Math.sign(d);
        first = first ?? values[i].t; last = values[i].t;
        if (dir && s !== dir) reversals++;
        dir = s;
      }
      if (reversals >= o.t6MinReversals) { episodes.push(episode('T6', 'size-oscillation', target, first, last, { reversals, dim }, { minSamples: 3 })); break; }
    }
  }
  return { applicable, episodes };
}

// Motion intervals: CSS/Web animations and scroll gestures inside the window.
function motions(v) {
  const out = [];
  const anims = v.by('animation');
  for (const a of anims.filter((e) => e.phase === 'created' || e.phase === 'started')) {
    const start = finite(a.tStart) ? a.tStart : a.t;
    const ended = anims.find((e) => e.t > a.t && ['ended', 'canceled'].includes(e.phase) && e.name === a.name && (e.target === a.target || e.backendNodeId === a.backendNodeId));
    const end = ended ? ended.t : finite(a.duration) ? start + a.duration * (finite(a.iterations) ? a.iterations : 1) + (a.delay ?? 0) : v.to;
    if (end >= v.from && start <= v.to) out.push({ from: start, to: end, kind: 'animation', a });
  }
  const scrolls = v.by('scroll').filter((e) => v.inWin(e.t));
  for (const s of scrolls) {
    const last = out.at(-1);
    if (last?.kind === 'scroll' && s.t - last.to <= 100) last.to = s.t + 16; else out.push({ from: s.t - 16, to: s.t + 16, kind: 'scroll' });
  }
  return out;
}

// T7 jank: a long animation frame (>= 100 ms) while something animates or scrolls. Always a warning.
function t7(v, o) {
  const m = motions(v);
  if (!m.length) return { applicable: false, episodes: [] };
  const episodes = [];
  for (const f of v.by('loaf').filter((e) => v.inWin(e.t) && e.duration >= o.t7LongFrameMs)) {
    if (m.some((x) => f.t <= x.to && f.t + f.duration >= x.from)) episodes.push(episode('T7', 'long-frame', 'frame', f.t, f.t + f.duration, { ms: Math.round(f.duration), blockingMs: Math.round(f.blockingDuration ?? 0) }, { level: 'warn', observe: 'continuous' }));
  }
  return { applicable: true, episodes };
}

// The frames the screen showed, deduplicated in time order ({t, hash}), from the frame index.
function frameSeries(trial) {
  const index = Array.isArray(trial?.frames?.index) ? trial.frames.index : null;
  if (!index || trial.frames.ok === false) return null;
  const out = [];
  for (const f of index.slice().sort((a, b) => a.t - b.t)) { if (!out.length || out.at(-1).hash !== f.hash) out.push({ t: f.t, hash: f.hash }); }
  return out;
}
function onScreen(frames, t) { let pick = null; for (const f of frames) { if (f.t <= t) pick = f; else break; } return pick; }

// T8 animation lint: long animation, a layout property, an endless loop, motion under reduced motion (warnings); a flash
// more than 3 times a second (WCAG 2.3.1) is a FAIL: the screen returns to the image before at that rate, and an
// animation or attribute toggle on the page runs at that rate.
function t8(v, o, frames) {
  const anims = v.by('animation').filter((e) => (e.phase === 'created' || e.phase === 'started') && e.t >= v.from - 50 && e.t <= v.to);
  const toggled = new Map();
  for (const m of v.by('mutation').filter((x) => v.inWin(x.t) && x.attrs > 0)) for (const t of m.targets || []) if (!isBusy(t)) toggled.set(t, [...(toggled.get(t) ?? []), m.t]);
  const fastToggle = [...toggled.values()].some((ts) => ts.some((t0) => ts.filter((t) => t >= t0 && t < t0 + 1000).length > 2 * o.t8MaxFlashesPerSecond));
  if (!anims.length && !fastToggle) return { applicable: false, episodes: [] };
  const episodes = [];
  const warn = (sub, a, measure) => episodes.push(episode('T8', sub, `${a.target ?? a.backendNodeId ?? 'animation'}|${a.name ?? ''}`, finite(a.tStart) ? a.tStart : a.t, v.to, measure, { level: 'warn', observe: 'continuous' }));
  const seen = new Set();
  const reduce = v.trial.conditions?.media?.reducedMotion === 'reduce';
  for (const a of anims) {
    const key = `${a.target}|${a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isBusy(a.target)) continue;
    if (finite(a.duration) && a.duration > o.t8LongAnimationMs) warn('long', a, { ms: Math.round(a.duration) });
    if (a.type === 'CSSTransition' && LAYOUT_PROPS.has(String(a.name).toLowerCase())) warn('layout-property', a, { property: a.name });
    if (a.phase === 'created' && a.type === 'CSSAnimation' && a.iterations == null && finite(a.duration)) warn('infinite', a, { ms: Math.round(a.duration) });
    if (reduce && finite(a.duration) && a.duration > o.t8ReducedMotionMs) warn('reduced-motion', a, { ms: Math.round(a.duration) });
  }
  // Flash: the screen goes back to the image two frames before, more than 3 times within one second.
  const fast = anims.filter((a) => !isBusy(a.target) && finite(a.duration) && a.duration > 0 && a.duration < 1000 / o.t8MaxFlashesPerSecond && (a.iterations == null || a.iterations > o.t8MaxFlashesPerSecond));
  if (!frames && (fast.length || fastToggle)) return { applicable: true, unmeasured: 'FRAMES_MISSING', episodes };
  if (fast.length || fastToggle) {
    const returns = [];
    for (let i = 2; i < frames.length; i++) if (frames[i].hash === frames[i - 2].hash && v.inWin(frames[i].t)) returns.push(frames[i].t);
    let best = null;
    for (const t0 of returns) {
      const n = returns.filter((t) => t >= t0 && t < t0 + 1000).length;
      if (n > o.t8MaxFlashesPerSecond && (!best || n > best.n)) best = { t0, n };
    }
    if (best) episodes.push(episode('T8', 'flash', 'screen', best.t0, best.t0 + 1000, { flashesPerSecond: best.n }, { observe: 'frames' }));
    else for (const a of fast) warn('flash-suspect', a, { ms: Math.round(a.duration) });
  }
  return { applicable: true, episodes };
}

const DETECT = { T1: t1, T2: t2, T3: t3, T4: t4, T5: t5, T6: t6, T7: t7, T8: t8 };

// Frames around the action dropped (C2 privacy) or the window refused (C2_MASK_FAILED): the frame rules cannot grade
// this trial (curator decision 5). A trial without a frame window at all is not a gap: the frame-only signals are then
// unmeasured where they occur (T8 flash), or unconfirmed (T3 theme flash).
export function framesGapAroundMark(trial, o = T_DEFAULTS) {
  const f = trial?.frames;
  if (!f) return null;
  if (f.ok === false || !Array.isArray(f.index)) return 'PRIVACY_GAP';
  // Frames over maxKeep are spread out by Dragon (counts.truncated), not dropped for privacy: only a privacy drop counts.
  if ((f.counts?.privacyUnverified ?? 0) + (f.counts?.privacyDropped ?? 0) === 0) return null;
  const lo = trial.markT - o.windowBeforeMs, hi = trial.markT + o.windowAfterMs;
  const keep = f.keep === 'all' ? [{ from: -Infinity, to: Infinity }] : Array.isArray(f.keep) ? f.keep : [];
  const inKeep = (t) => keep.some((r) => t >= r.from && t <= r.to);
  if (!keep.length || f.index.some((x) => x.t >= lo && x.t <= hi && !x.dup && !x.kept && inKeep(x.t))) return 'PRIVACY_GAP';
  return null;
}

// Which episodes a schedule would have seen (references/transient-rules.md "Observation schedules").
function observed(ep, v, schedule) {
  if (schedule === 'events' || schedule === 'all') return true;
  if (schedule === 'stable') return ep.rule === 'T2' && ep.to >= v.to;
  // fixed7: point observations at the sample marks only (geometry read + the frame on screen); no sensor stream.
  if (ep.observe !== 'sampled') return false;
  const marks = v.samples.length ? v.samples.map((s) => s.t) : T_DEFAULTS.sampleOffsetsMs.map((d) => v.markT + d);
  const hits = marks.filter((t) => t >= ep.from && t <= ep.to);
  if (hits.length < (ep.minSamples ?? 1)) return false;
  return !ep.minSpanMs || (hits.at(-1) - hits[0]) >= ep.minSpanMs;
}

// Run every rule on one trial.
export function gradeTrial(trial, { schedule = 'events', options = T_DEFAULTS } = {}) {
  const v = trialView(trial, options);
  const frames = schedule === 'fixed7' || schedule === 'stable' ? null : frameSeries(trial);
  const gap = framesGapAroundMark(trial, options);
  const out = {};
  for (const rule of T_RULES) {
    const r = DETECT[rule](v, options, frames);
    const episodes = r.episodes.filter((ep) => observed(ep, v, schedule));
    out[rule] = { applicable: r.applicable, unmeasured: r.unmeasured ?? null, gap: FRAME_RULES.has(rule) && gap ? gap : null, episodes };
    if (schedule === 'fixed7' && (rule === 'T7' || rule === 'T8')) out[rule] = { applicable: false, unmeasured: null, gap: null, episodes: [] };
    if (schedule === 'stable' && rule !== 'T2') out[rule] = { applicable: false, unmeasured: null, gap: null, episodes: [] };
  }
  return out;
}

const keyOf = (ep) => `${ep.sub}|${ep.subject}`;
// k of n: the anomaly appears again at the same mark (offset from the action within max(100 ms, 20 %)).
function confirm(perTrial, o) {
  let best = { k: 0, offsetMs: null, key: null, episode: null };
  for (const [i, eps] of perTrial.entries()) {
    for (const ep of eps) {
      const anchor = ep.from - ep.markT, tol = Math.max(o.sameMarkToleranceMs, Math.abs(anchor) * o.sameMarkToleranceRatio);
      let k = 0;
      for (const [j, other] of perTrial.entries()) if (i === j ? true : other.some((x) => keyOf(x) === keyOf(ep) && Math.abs((x.from - x.markT) - anchor) <= tol)) k++;
      if (k > best.k) best = { k, offsetMs: Math.round(anchor), key: keyOf(ep), episode: ep };
    }
  }
  return best;
}

/**
 * Grade the rules over the repeats of one action. Trials at real speed (no CPU throttle, no animation rate) decide;
 * slowed trials only show where to look. Per rule: FAIL (confirmed k >= 2 of n >= 3), WARN (a warning rule, or seen
 * once in n >= 3), PASS (the condition occurred and nothing was found), or UNGRADED with a reason: CONDITION_ABSENT (the
 * condition never occurred: not a PASS), REPEATS_REQUIRED, PRIVACY_GAP, FRAMES_MISSING, or what was unmeasured.
 * repeatable: false when the action may not be repeated (no approved plan for repeats, e.g. a write): an anomaly seen
 * in fewer than 3 real-speed trials is then a WARN with UNCONFIRMED_SINGLE (k/n as seen), not REPEATS_REQUIRED.
 */
export function gradeTransientRules(trials, { schedule = 'events', options = T_DEFAULTS, repeatable = true } = {}) {
  const list = Array.isArray(trials) ? trials : [];
  const graded = list.map((t) => ({ t, real: realSpeed(t?.conditions), g: gradeTrial(t, { schedule, options }) }));
  const rules = {};
  for (const rule of T_RULES) {
    const rows = graded.map(({ t, real, g }) => ({ real, ...g[rule], episodes: g[rule].episodes.map((e) => ({ ...e, markT: t.markT })) }));
    const usable = rows.filter((r) => r.real && r.applicable && !r.unmeasured && !r.gap);
    const n = usable.length;
    const blocking = (e) => e.level === 'fail';
    const c = confirm(usable.map((r) => r.episodes.filter(blocking)), options);
    const warns = usable.flatMap((r) => r.episodes.filter((e) => e.level === 'warn'));
    const slowed = rows.filter((r) => !r.real && r.applicable && !r.unmeasured && !r.gap);
    const slowedK = slowed.filter((r) => r.episodes.length).length;
    const base = { rule, level: T_LEVEL[rule], n, k: c.k, slowed: { k: slowedK, n: slowed.length } };
    const sample = (ep) => ep && { sub: ep.sub, subject: ep.subject, offsetMs: Math.round(ep.from - ep.markT), durationMs: Math.round(ep.to - ep.from), measure: ep.measure };
    if (c.k > 0) {
      const canFail = T_LEVEL[rule] === 'block' || (rule === 'T8' && c.episode?.sub === 'flash');
      if (!canFail) rules[rule] = { ...base, verdict: 'WARN', reason: 'WARNING_ONLY', mark: c.offsetMs, episode: sample(c.episode) };
      else if (n >= options.confirmRepeats && c.k >= options.confirmMinK) rules[rule] = { ...base, verdict: 'FAIL', reason: 'CONFIRMED', mark: c.offsetMs, episode: sample(c.episode) };
      else if (n < options.confirmRepeats && repeatable === false) rules[rule] = { ...base, verdict: 'WARN', reason: 'UNCONFIRMED_SINGLE', mark: c.offsetMs, episode: sample(c.episode) };
      else if (n < options.confirmRepeats) rules[rule] = { ...base, verdict: 'UNGRADED', reason: 'REPEATS_REQUIRED', mark: c.offsetMs, episode: sample(c.episode) };
      else rules[rule] = { ...base, verdict: 'WARN', reason: 'TRANSIENT_UNCONFIRMED', mark: c.offsetMs, episode: sample(c.episode) };
      continue;
    }
    const gaps = rows.filter((r) => r.real && r.applicable && r.gap);
    const unmeasured = rows.filter((r) => r.real && r.applicable && r.unmeasured);
    if (gaps.length) rules[rule] = { ...base, verdict: 'UNGRADED', reason: gaps[0].gap };
    else if (warns.length) rules[rule] = { ...base, verdict: 'WARN', reason: 'WARNING_ONLY', k: new Set(warns.map((e) => e.markT)).size, episode: sample(warns[0]) };
    else if (slowedK) rules[rule] = n >= options.confirmRepeats ? { ...base, verdict: 'WARN', reason: 'SLOWED_ONLY' }
      : repeatable === false ? { ...base, verdict: 'WARN', reason: 'UNCONFIRMED_SINGLE' } : { ...base, verdict: 'UNGRADED', reason: 'REPEATS_REQUIRED' };
    else if (n > 0) rules[rule] = { ...base, verdict: 'PASS', reason: null };
    else if (unmeasured.length) rules[rule] = { ...base, verdict: 'UNGRADED', reason: unmeasured[0].unmeasured };
    else rules[rule] = { ...base, verdict: 'UNGRADED', reason: list.length ? 'CONDITION_ABSENT' : 'NO_TRIALS' };
  }
  return rules;
}

// The probe's contribution to the state's UI verdict: FAIL on a confirmed finding; UNGRADED when a rule whose condition
// occurred could not be graded; PASS otherwise. An absent condition does not change it; warnings never do.
export function transientVerdict(rules) {
  const all = Object.values(rules ?? {});
  if (all.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (all.some((r) => r.verdict === 'UNGRADED' && r.reason !== 'CONDITION_ABSENT')) return 'UNGRADED';
  return 'PASS';
}

// ── observation schedules (R1d acceptance: compare the four, pick the Pareto one on dev data) ───────────────────────
// Frames each schedule keeps for one trial: stable 0 (the settled screenshot only, as today), fixed7 the frames on screen
// at the sample marks, events those plus the frames around sensor events (Dragon's kept frames), all every distinct frame.
export function scheduleFrames(trial) {
  const index = Array.isArray(trial?.frames?.index) ? trial.frames.index.slice().sort((a, b) => a.t - b.t) : [];
  const lo = trial.markT - T_DEFAULTS.windowBeforeMs, hi = trial.window?.to ?? trial.markT + T_DEFAULTS.windowAfterMs;
  const inWin = index.filter((f) => f.t >= lo && f.t <= hi);
  const at = (t) => { let pick = null; for (const f of index) { if (f.t <= t) pick = f; else break; } return pick; };
  const marks = (Array.isArray(trial.samples) && trial.samples.length ? trial.samples.map((s) => s.t) : T_DEFAULTS.sampleOffsetsMs.map((d) => trial.markT + d));
  const fixed = new Set(marks.map(at).filter(Boolean).map((f) => f.hash));
  const kept = new Set((trial.frames?.kept ?? []).map((f) => index.find((x) => x.seq === f.seq)?.hash ?? `seq:${f.seq}`));
  return { stable: 0, fixed7: fixed.size, events: new Set([...fixed, ...kept]).size, all: new Set(inWin.map((f) => f.hash)).size, kept: kept.size };
}

/**
 * The comparison table: per schedule, the dynamic defects caught (a defect counts when its own rule reaches FAIL, or
 * WARN for a warning rule), the frames per action, and the false alarms on clean screens (any FAIL or WARN). The
 * milliseconds each schedule adds come from measurements on a clean screen (overheadSummary).
 * @param defects [{rule, trials}]  @param cleans [{trials}]
 */
export function scheduleMetrics({ defects = [], cleans = [], options = T_DEFAULTS } = {}) {
  const out = {};
  for (const schedule of SCHEDULES) {
    let caught = 0, frames = 0, actions = 0, falseAlarms = 0;
    for (const d of defects) {
      const r = gradeTransientRules(d.trials, { schedule, options })[d.rule];
      if (r.verdict === 'FAIL' || (r.verdict === 'WARN' && T_LEVEL[d.rule] !== 'block' && r.reason === 'WARNING_ONLY')) caught++;
    }
    for (const c of cleans) {
      const rules = gradeTransientRules(c.trials, { schedule, options });
      falseAlarms += Object.values(rules).filter((r) => r.verdict === 'FAIL' || r.verdict === 'WARN').length;
    }
    for (const t of [...defects, ...cleans].flatMap((x) => x.trials)) { frames += scheduleFrames(t)[schedule]; actions++; }
    out[schedule] = { caught, defects: defects.length, framesPerAction: actions ? Math.round((frames / actions) * 10) / 10 : 0, falseAlarms, cleanScreens: cleans.length };
  }
  out.caughtAdditionally = Object.fromEntries(SCHEDULES.map((s) => [s, out[s].caught - out.stable.caught]));
  return out;
}

// Milliseconds a schedule adds to one action on a clean screen: the probe's wall time per action (sensors.start shared
// by the repeats of one action) minus the same action settled without a probe. Median of the repeats.
export function overheadSummary({ baselineMs, schedules }) {
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const base = median(baselineMs);
  const out = { baselineMs: base };
  for (const [name, trials] of Object.entries(schedules ?? {})) {
    const shared = trials.reduce((sum, t) => sum + (t.sensorsStartMs ?? 0), 0) / Math.max(1, trials.length);
    const wall = median(trials.map((t) => t.wallMs + shared));
    out[name] = { wallMs: Math.round(wall), addedMs: Math.round(wall - base), windowMs: median(trials.map((t) => t.windowMs)), keptFrames: median(trials.map((t) => t.keptFrames)) };
  }
  out.stable = { wallMs: base, addedMs: 0, windowMs: 0, keptFrames: 0 };
  return out;
}
