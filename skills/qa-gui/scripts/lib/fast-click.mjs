// Fast-click (upgrade R3): skip Dragon's human-speed click motion (`fast:true` on a click step, on a `do` macro, or on
// trustedClick) only when the speed policy says `fast_click: "on"`, and never in a case that checks hover or
// drag-and-drop: a hover menu or a drag needs the real pointer path and timing. A fast click is still a trusted click
// (HR1 holds); only the eased cursor travel is dropped. `off` and `shadow` change nothing for the executor (shadow only
// counts what would have been fast); the checks below run only under `on`. The Codex native route keeps its own rule
// (references/native-gui-adapter.md: every click explicitly `fast:false`) and is not changed by this flag.
import { speedMode } from './speed-flags.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const CLICK_KEYS = ['click', 'clickSelector', 'clickXY'];
const HOVER_DRAG_KEYS = ['hover', 'drag'];
const HOVER_DRAG_METHODS = ['trustedHover', 'dragDrop'];

const stepsOf = (call) => (call?.method === 'do' || call?.method === 'runFlow') && Array.isArray(call?.params?.steps) ? call.params.steps : [];

// The calls (Dragon `{method, params}`) that hover or drag.
export function hoverOrDragCalls(calls) {
  return (Array.isArray(calls) ? calls : []).filter((call) => HOVER_DRAG_METHODS.includes(call?.method)
    || stepsOf(call).some((step) => object(step) && HOVER_DRAG_KEYS.some((key) => Object.hasOwn(step, key))));
}

export function fastClickSummary(calls) {
  let clicks = 0, fast = 0;
  for (const call of Array.isArray(calls) ? calls : []) {
    if (call?.method === 'trustedClick') { clicks += 1; if (call.params?.fast === true) fast += 1; continue; }
    for (const step of stepsOf(call)) {
      if (!object(step) || !CLICK_KEYS.some((key) => Object.hasOwn(step, key))) continue;
      clicks += 1;
      if (step.fast === true || (call.params?.fast === true && step.fast !== false)) fast += 1;
    }
  }
  return { clicks, fast_clicks: fast, hover_or_drag: hoverOrDragCalls(calls).length };
}

// What the dispatch tells the executor for one case.
export function fastClickPlan({ mode, caseChecksHoverOrDrag }) {
  if (mode !== 'on') return { fast: false, reason: mode === 'shadow' ? 'POLICY_SHADOW' : 'POLICY_OFF' };
  if (caseChecksHoverOrDrag) return { fast: false, reason: 'CASE_CHECKS_HOVER_OR_DRAG' };
  return { fast: true, reason: 'POLICY_ON' };
}

// The check of a case's calls once it ran. Only under `on`: a fast click in a case that checks hover or drag-and-drop
// (declared by the plan, or seen in the calls) is refused.
export function fastClickIssues({ calls, mode, caseChecksHoverOrDrag }) {
  if (mode !== 'on') return [];
  const summary = fastClickSummary(calls);
  if (summary.fast_clicks && (caseChecksHoverOrDrag || summary.hover_or_drag)) {
    return [`FAST_CLICK_ON_HOVER_OR_DRAG_CASE:${summary.fast_clicks} fast click(s) in a case that checks hover or drag-and-drop`];
  }
  return [];
}

// Whether a case may use fast clicks: only under a speed policy with `fast_click: "on"`, and never in a case that checks
// hover or drag-and-drop. Every Dragon driver of QA GUI (overlay check, exploration, transient probe) takes this as its
// `fast` option.
export function fastClickAllowed({ policy, caseChecksHoverOrDrag = false }) {
  return fastClickPlan({ mode: speedMode(policy, 'fast_click'), caseChecksHoverOrDrag }).fast === true;
}

// A `do` step as a driver sends it: a click step always says how fast it is, `fast:false` (human-speed motion) unless
// the fast-click plan allows a fast click (`fast` true). An explicit `fast:false` is kept. Without `fast:false` Dragon's
// own default may collapse the click, and the native route refuses it (NATIVE_GUI_NORMAL_INPUT_REQUIRED).
export function withClickSpeed(step, fast = false) {
  if (!object(step) || !CLICK_KEYS.some((key) => Object.hasOwn(step, key))) return step;
  return { ...step, fast: fast === true && step.fast !== false };
}
