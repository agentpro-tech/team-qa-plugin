// ux-rules.mjs — UX rule family U1–U10 (R1c): the registry, the settings and the graders that run in Node.
// ============================================================
// The in-page rules run inside the Gate-0 sweeps: U9 in scripts/ui-sanity.js, U4/U5/U6 in scripts/a11y-gate0.js.
// The rules that need more than one settled state, a Dragon read or a vision judgement are graded here from data
// the executor already holds (ux observations from `__uxObserve`, Dragon `env.get`, `sensors.read`,
// `paintSnapshot`, a structured vision output), then folded into the state's sweep with `foldUx`, so every U finding
// lands in the state receipt's UI verdict (`ui.uiSanity` or `ui.a11y`). Pure functions: no browser, no I/O.
// A rule whose condition did not occur returns UNGRADED with a reason, never PASS. The level (block = the finding
// fails the UI verdict, warn = listed only) and the thresholds are settings fixed at pre-registration (EV2);
// the defaults below are conservative and documented in references/ux-rules.md.
import { createHash } from 'node:crypto';

const freeze = (value) => Object.freeze(value);
const rule = (name, judge, source, level, thresholds, basis) => freeze({ name, judge, source, level, thresholds: freeze(thresholds), basis });

export const UX_RULE_IDS = freeze(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10']);
export const UX_RULES = freeze({
  U1: rule('no-feedback-after-action', 'machine', 'observe+sensors', 'warn', { progressMs: 1000 }, 'NN/g response-time limits 0.1 / 1 / 10 s'),
  U2: rule('double-submit-open', 'machine', 'observe+env', 'warn', {}, 'forced hold of the write (envSet request rule)'),
  U3: rule('error-lost-input', 'machine', 'observe+env', 'block', {}, 'forced server error (envSet request rule)'),
  U4: rule('error-not-tied-to-field', 'machine', 'dom', 'warn', { adjacentPx: 24, maxGapPx: 120 }, 'WCAG 3.3.1, 1.3.1'),
  U5: rule('status-not-announced', 'machine', 'dom', 'warn', {}, 'WCAG 4.1.3'),
  U6: rule('focus-obscured', 'machine', 'dom|paint', 'block', { coveredPoints: 5 }, 'WCAG 2.4.11'),
  U7: rule('empty-state-dead-end', 'vision', 'vision', 'warn', { minConfidence: 0.7, requireAction: false }, 'empty state offers a way forward'),
  U8: rule('destructive-unguarded', 'vision', 'vision+observe', 'warn', { minConfidence: 0.7 }, 'destructive action has a confirmation or an undo'),
  U9: rule('occluded-control-partial', 'machine', 'dom|paint', 'warn', { minCovered: 2 }, 'five-point occlusion, closes the A3 centre-only blind spot'),
  U10: rule('diacritics-clipped', 'vision', 'vision+dom', 'warn', { minConfidence: 0.7, inkTolerancePx: 1 }, 'stacked Vietnamese diacritics cut by line-height or overflow'),
});

export const UX_VERDICTS = freeze(['PASS', 'FAIL', 'UNGRADED']);
const LEVELS = new Set(['block', 'warn']);
// Thresholds with a bounded range; every other number only has to be finite and >= 0.
const RANGES = { coveredPoints: [1, 5], minCovered: [1, 5], minConfidence: [0, 1] };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Resolve the UX settings of a run from its pre-registration block ({version:1, levels, thresholds}; every key
 * optional). Unknown rules, levels, threshold names or types throw: a pre-registered setting that cannot be read
 * must stop the run, not fall back silently. `sha256` is the digest of the resolved settings (for the EV2 lock).
 */
export function uxSettings(input = {}) {
  if (!isObject(input)) throw new Error('UX_SETTINGS_OBJECT_REQUIRED');
  for (const key of Object.keys(input)) if (!['version', 'levels', 'thresholds'].includes(key)) throw new Error(`UX_SETTINGS_UNKNOWN_FIELD:${key}`);
  if (input.version !== undefined && input.version !== 1) throw new Error('UX_SETTINGS_VERSION');
  const levels = {}, thresholds = {};
  for (const id of UX_RULE_IDS) { levels[id] = UX_RULES[id].level; thresholds[id] = { ...UX_RULES[id].thresholds }; }
  for (const [id, level] of Object.entries(input.levels ?? {})) {
    if (!UX_RULES[id]) throw new Error(`UX_SETTINGS_UNKNOWN_RULE:${id}`);
    if (!LEVELS.has(level)) throw new Error(`UX_SETTINGS_LEVEL:${id}`);
    levels[id] = level;
  }
  for (const [id, values] of Object.entries(input.thresholds ?? {})) {
    if (!UX_RULES[id]) throw new Error(`UX_SETTINGS_UNKNOWN_RULE:${id}`);
    if (!isObject(values)) throw new Error(`UX_SETTINGS_THRESHOLD:${id}`);
    for (const [key, value] of Object.entries(values)) {
      const fallback = UX_RULES[id].thresholds[key];
      const [low, high] = RANGES[key] ?? [0, Infinity];
      const ok = fallback !== undefined && typeof value === typeof fallback
        && (typeof value !== 'number' || (Number.isFinite(value) && value >= low && value <= high));
      if (!ok) throw new Error(`UX_SETTINGS_THRESHOLD:${id}.${key}`);
      thresholds[id][key] = value;
    }
  }
  const resolved = { version: 1, levels, thresholds };
  return { ...resolved, sha256: createHash('sha256').update(canonical(resolved)).digest('hex') };
}

const DEFAULTS = uxSettings();

/** One rule result: {id, rule, verdict, level, source, reason?, findings[], thresholds, ...measured}. */
export function uxResult(id, verdict, { settings = DEFAULTS, source, reason, findings = [], measured = {} } = {}) {
  if (!UX_RULES[id]) throw new Error(`UX_UNKNOWN_RULE:${id}`);
  if (!UX_VERDICTS.includes(verdict)) throw new Error(`UX_VERDICT_INVALID:${verdict}`);
  const out = {
    id, rule: UX_RULES[id].name, verdict, level: settings.levels[id], source: source ?? UX_RULES[id].source,
    findings: findings.map((finding) => ({ ...finding })), thresholds: { ...settings.thresholds[id] }, ...measured,
  };
  if (reason) out.reason = reason;
  return out;
}

const ungraded = (id, reason, settings, source, measured) => uxResult(id, 'UNGRADED', { settings, source, reason, measured });
const NOT_IN_VIEW = ['display-none', 'visibility-hidden', 'transparent', 'zero-size', 'outside-viewport', 'clipped', 'no-layout-box', 'not-in-snapshot'];

function paintElements(snapshot) {
  if (!isObject(snapshot)) return { reason: 'NO_SNAPSHOT' };
  if (snapshot.ok === false) return { reason: typeof snapshot.code === 'string' && snapshot.code ? snapshot.code : 'PAINT_SNAPSHOT_FAILED' };
  if (!Array.isArray(snapshot.elements)) return { reason: 'NO_SNAPSHOT' };
  return { elements: snapshot.elements };
}
const coverName = (element) => element.points?.find((point) => point.covered && point.by)?.by?.node ?? 'another element';

/**
 * U6 from Dragon `paintSnapshot {selector: <the focused element>}` (paint order, so a transparent overlay covers
 * nothing and a `pointer-events:none` layer still counts). FAIL when at least `coveredPoints` (default all 5)
 * points of the element's visible part are painted over.
 */
export function gradeU6Paint(snapshot, settings = DEFAULTS) {
  const { elements, reason } = paintElements(snapshot);
  if (reason) return ungraded('U6', reason, settings, 'paint');
  const element = elements[0];
  if (!element || element.found === false) return ungraded('U6', 'PAINT_TARGET_NOT_FOUND', settings, 'paint');
  const away = (element.reasons ?? []).filter((item) => NOT_IN_VIEW.includes(item));
  if (away.length || !Array.isArray(element.points) || element.points.length === 0) {
    return ungraded('U6', 'FOCUS_NOT_IN_VIEW', settings, 'paint', { notInView: away });
  }
  const covered = element.points.filter((point) => point.covered).length;
  const measured = { target: element.node ?? element.selector ?? null, coveredPoints: covered, points: element.points.length };
  if (covered >= settings.thresholds.U6.coveredPoints) {
    return uxResult('U6', 'FAIL', {
      settings, source: 'paint', measured,
      findings: [{ sel: measured.target, detail: `focused element hidden: ${covered}/${element.points.length} points painted over by ${coverName(element)}` }],
    });
  }
  return uxResult('U6', 'PASS', { settings, source: 'paint', measured });
}

/**
 * U9 from Dragon `paintSnapshot {selector: <controls>, all: true}`. FAIL for every control in view with at least
 * `minCovered` (default 2) of its five points painted over; UNGRADED when no control was in view.
 */
export function gradeU9Paint(snapshot, settings = DEFAULTS) {
  const { elements, reason } = paintElements(snapshot);
  if (reason) return ungraded('U9', reason, settings, 'paint');
  const findings = [];
  let checked = 0;
  for (const element of elements) {
    if (!element || element.found === false || !Array.isArray(element.points) || element.points.length === 0) continue;
    checked += 1;
    const covered = element.points.filter((point) => point.covered).length;
    if (covered >= settings.thresholds.U9.minCovered) {
      findings.push({ sel: element.node ?? element.selector, detail: `${covered}/${element.points.length} points painted over by ${coverName(element)}` });
    }
  }
  if (checked === 0) return ungraded('U9', 'NO_CONTROLS_IN_VIEW', settings, 'paint');
  return uxResult('U9', findings.length ? 'FAIL' : 'PASS', { settings, source: 'paint', findings, measured: { checked, failed: findings.length } });
}

// ---------- action rules: U1, U2, U3 ----------
const num = (value) => (Number.isFinite(value) ? value : null);
const method = (entry) => String(entry?.method ?? '').toUpperCase();
const observed = (value) => isObject(value) && value.v === 'ux-observe/1';

/** The visible differences between two `__uxObserve` observations (empty list = nothing a user could see). */
export function uxChanges(a, b) {
  if (!observed(a) || !observed(b)) return null;
  const out = [];
  if (a.url !== b.url) out.push('url');
  if (a.digest?.doc !== b.digest?.doc) out.push('content');
  const said = new Set((a.live ?? []).map((x) => `${x.sel}\u0000${x.text}`));
  if ((b.live ?? []).some((x) => !said.has(`${x.sel}\u0000${x.text}`))) out.push('status-message');
  if ((b.dialogs ?? []).some((d) => !(a.dialogs ?? []).includes(d))) out.push('dialog');
  const busyCount = (o) => ['ariaBusy', 'progress', 'spinners'].reduce((n, k) => n + (o.busy?.[k]?.length ?? 0), 0);
  if (busyCount(b) > busyCount(a)) out.push('busy');
  return out;
}

// A sensors.read event a user can see: DOM content or a non-data attribute changed, a watched element was resized,
// changed visibility, or shifted. Focus, scroll, input, timing and animation events are not feedback by themselves.
function visibleEvent(event) {
  if (event.k === 'mutation') {
    return (event.added ?? 0) > 0 || (event.removed ?? 0) > 0 || (event.text ?? 0) > 0
      || (event.attrNames ?? []).some((name) => !/^data-/.test(name));
  }
  return event.k === 'resize' || event.k === 'visibility' || event.k === 'layout-shift';
}
function firstFeedback(events, t0) {
  const sorted = events.filter((e) => isObject(e) && Number.isFinite(e.t) && e.t > t0).sort((a, b) => a.t - b.t);
  return sorted.find(visibleEvent)?.t ?? null;
}
// When the action's write stopped waiting: the env.get `released:*` / `responded:*` / `failed:*` log entry after it.
function pendingEnd(env, t0) {
  const log = Array.isArray(env?.requests) ? env.requests : [];
  const held = log.filter((e) => e.outcome === 'held' && Number.isFinite(e.t) && e.t >= t0 - 50 && MUTATING.has(method(e)));
  if (!held.length) return null;
  const ends = log.filter((e) => /^(released|responded|failed):/.test(String(e.outcome)) && Number.isFinite(e.t) && e.t >= held[0].t
    && e.ruleId === held[0].ruleId);
  return ends.length ? Math.min(...ends.map((e) => e.t)) : null;
}

/**
 * U1 feedback after an action. Input (all times unix-epoch ms, Dragon's one clock):
 *   action {t}                      the trusted action (its Dragon receipt, or the sensors `input` click)
 *   before / during / after         `__uxObserve` observations: settled before; while the write is still pending,
 *                                   at least progressMs after the action; settled after the result
 *   writes [{method,url,status,t}]  the action's requests (Dragon getNetwork)
 *   pendingUntil | env              when the forced hold ended, or the env.get read whose log shows it
 *   sensors                         sensors.read events covering the action (replaces during/after when absent)
 * FAIL NO_PROGRESS_INDICATOR: the write was pending longer than progressMs and nothing visible changed by then.
 * FAIL NO_VISIBLE_CHANGE: a mutating request succeeded and nothing visible changed at all.
 * UNGRADED: no action, no successful write and no wait (NO_WRITE_OR_WAIT), or no evidence for a window it must judge.
 */
export function gradeU1(input = {}, settings = DEFAULTS) {
  const { action, before, during, after, writes = [], sensors, env } = input;
  const events = Array.isArray(sensors) ? sensors : null;
  const t0 = num(action?.t) ?? (events ? num(events.find((e) => e.k === 'input' && e.type === 'click' && e.trusted)?.t) : null);
  if (t0 === null) return ungraded('U1', 'NO_ACTION', settings);
  const progressMs = settings.thresholds.U1.progressMs;
  const ok = writes.filter((w) => MUTATING.has(method(w)) && w.status >= 200 && w.status < 300);
  const until = num(input.pendingUntil) ?? pendingEnd(env, t0);
  const slow = until !== null && until - t0 > progressMs;
  if (!ok.length && !slow) return ungraded('U1', 'NO_WRITE_OR_WAIT', settings);
  const measured = {};
  if (until !== null) measured.pendingMs = Math.round(until - t0);
  const feedbackAt = events ? firstFeedback(events, t0) : undefined;
  if (events) measured.feedbackMs = feedbackAt === null ? null : Math.round(feedbackAt - t0);
  const findings = [];
  if (slow) {
    let shown = null;
    if (observed(before) && observed(during) && during.t - t0 >= progressMs && during.t <= until) {
      measured.duringChanges = uxChanges(before, during);
      shown = measured.duringChanges.length > 0;
    } else if (events) shown = feedbackAt !== null && feedbackAt - t0 <= progressMs;
    if (shown === null) return ungraded('U1', 'NO_DURING_EVIDENCE', settings, undefined, measured);
    if (!shown) findings.push({ sel: null, reason: 'NO_PROGRESS_INDICATOR', detail: `no visible progress within ${progressMs} ms while the request was pending for ${Math.round(until - t0)} ms` });
  }
  if (ok.length) {
    let shown = null;
    if (observed(before) && observed(after)) { measured.afterChanges = uxChanges(before, after); shown = measured.afterChanges.length > 0; }
    else if (events) shown = feedbackAt !== null;
    if (shown === null) { if (!slow) return ungraded('U1', 'NO_AFTER_EVIDENCE', settings, undefined, measured); }
    else if (!shown) findings.push({ sel: null, reason: 'NO_VISIBLE_CHANGE', detail: `${ok.map((w) => `${method(w)} ${w.status}`).join(', ')} succeeded with no visible change` });
  }
  return uxResult('U1', findings.length ? 'FAIL' : 'PASS', { settings, findings, reason: findings[0]?.reason, measured });
}

/**
 * U2 protection against a double click, judged while the action's write is held (envSet request rule `hold`).
 * Input: action {t}; before / during `__uxObserve({trigger})` (during = while held); env = the env.get read taken
 * right after `during`; ruleId = the hold rule's id (optional filter).
 * FAIL DUPLICATE_REQUEST: the rule matched two or more mutating requests after the action (a second click went out).
 * FAIL STILL_ACTIONABLE: the trigger is enabled, not covered, not inert, and neither it nor its form shows a busy
 * state (aria-busy, a spinner or progress element, a changed label). A busy bar elsewhere on the page does not stop a
 * second click and does not count. UNGRADED when no held request is confirmed (NO_PENDING_REQUEST).
 */
export function gradeU2(input = {}, settings = DEFAULTS) {
  const { action, before, during, env, ruleId } = input;
  if (!observed(during) || !isObject(during.trigger)) return ungraded('U2', 'NO_OBSERVATION', settings);
  if (!during.trigger.found) return ungraded('U2', 'TRIGGER_NOT_FOUND', settings);
  if (!isObject(env) || !Array.isArray(env.held)) return ungraded('U2', 'NO_ENV_READ', settings);
  const t0 = num(action?.t) ?? -Infinity;
  const mine = (e) => isObject(e) && (!ruleId || e.ruleId === ruleId) && MUTATING.has(method(e));
  const held = env.held.filter(mine);
  if (!held.length) return ungraded('U2', 'NO_PENDING_REQUEST', settings);
  const sent = (Array.isArray(env.requests) ? env.requests : []).filter((e) => mine(e) && e.outcome === 'held' && (e.t ?? 0) >= t0 - 50);
  const tr = during.trigger;
  const measured = { trigger: tr.sel, held: held.length, sent: Math.max(sent.length, held.length) };
  if (measured.sent >= 2) {
    return uxResult('U2', 'FAIL', { settings, reason: 'DUPLICATE_REQUEST', measured,
      findings: [{ sel: tr.sel, detail: `${measured.sent} ${method(held[0])} requests to ${held[0].url} were sent while the first was pending` }] });
  }
  const blocked = tr.disabled || tr.ariaDisabled || tr.inert || tr.pointerEventsNone || tr.covered || tr.visible === false;
  const relabelled = before?.trigger?.found === true && typeof before.trigger.text === 'string' && before.trigger.text !== tr.text;
  const busy = tr.ariaBusy || tr.spinner || tr.formBusy || relabelled;
  measured.state = blocked ? 'blocked' : busy ? 'busy' : 'open';
  if (!blocked && !busy) {
    return uxResult('U2', 'FAIL', { settings, reason: 'STILL_ACTIONABLE', measured,
      findings: [{ sel: tr.sel, detail: `${tr.sel} stays enabled with no busy state while ${method(held[0])} ${held[0].url} is pending` }] });
  }
  return uxResult('U2', 'PASS', { settings, measured });
}

/**
 * U3 an error keeps the entered data. Input: before = `__uxObserve` after the user filled the form, just before the
 * submit; after = `__uxObserve` once the error shows; env = env.get after the submit (a forced `respond` 4xx/5xx or
 * `fail` rule logs `responded:<status>` / `failed:<reason>`), and/or writes = the network log.
 * FAIL when a field filled before the error is gone or holds a different value after it (hash compare).
 * UNGRADED: no error happened (NO_ERROR), nothing was filled (NO_INPUT). Passwords and files are never compared.
 */
export function gradeU3(input = {}, settings = DEFAULTS) {
  const { before, after, env, writes = [] } = input;
  if (!observed(before) || !observed(after)) return ungraded('U3', 'NO_OBSERVATION', settings);
  const errors = [
    ...(Array.isArray(env?.requests) ? env.requests : []).filter((e) => /^(responded:[45]\d\d|failed:)/.test(String(e.outcome))).map((e) => `${method(e)} ${e.url} ${e.outcome}`),
    ...writes.filter((w) => w.status >= 400 || w.failed === true).map((w) => `${method(w)} ${w.url} ${w.status ?? 'failed'}`),
  ];
  if (!errors.length) return ungraded('U3', 'NO_ERROR', settings);
  const filled = [];
  for (const form of before.forms ?? []) for (const item of form.fields ?? []) if (item.filled) filled.push({ form: form.key, ...item });
  if (!filled.length) return ungraded('U3', 'NO_INPUT', settings, undefined, { errorSeen: errors[0] });
  const findings = [];
  for (const item of filled) {
    const now = (after.forms ?? []).find((form) => form.key === item.form)?.fields?.find((x) => x.key === item.key);
    if (!now) findings.push({ sel: item.sel, detail: `field ${item.key} is gone after the error (${errors[0]})` });
    else if (now.hash !== item.hash) findings.push({ sel: item.sel, detail: `field ${item.key} lost what was typed after the error (${item.len} chars before, ${now.len} after)` });
  }
  return uxResult('U3', findings.length ? 'FAIL' : 'PASS', { settings, findings, measured: { errorSeen: errors[0], compared: filled.length } });
}

function validResult(result) {
  return isObject(result) && UX_RULES[result.id] && UX_VERDICTS.includes(result.verdict) && LEVELS.has(result.level)
    && Array.isArray(result.findings);
}

/**
 * Fold U rule results into the Gate-0 sweep report of the same settled state (the report `__uiSanity` or `__a11yB`
 * returned). A FAIL adds one issue per finding with `sev` = `high` (block) or `warn`; the report's verdict becomes
 * FAIL on any high issue or block-level FAIL, else UNGRADED when a rule listed in `require` (the rules the case
 * forced a state for) is UNGRADED or missing, else it keeps PASS. Returns a new report.
 */
export function foldUx(report, results = [], { require = [] } = {}) {
  if (!isObject(report) || !Array.isArray(report.issues)) throw new Error('UX_FOLD_REPORT_REQUIRED');
  for (const id of require) if (!UX_RULES[id]) throw new Error(`UX_FOLD_UNKNOWN_RULE:${id}`);
  const out = { ...report, issues: report.issues.map((issue) => ({ ...issue })), ux: { v: 'ux-rules/1', ...(report.ux ?? {}), rules: { ...(report.ux?.rules ?? {}) } } };
  for (const result of results) {
    if (!validResult(result)) throw new Error(`UX_FOLD_RESULT_INVALID:${result?.id ?? 'unknown'}`);
    out.ux.rules[result.id] = result;
    if (result.verdict !== 'FAIL') continue;
    const sev = result.level === 'block' ? 'high' : 'warn';
    const findings = result.findings.length ? result.findings : [{ sel: null, detail: result.reason ?? result.rule }];
    for (const finding of findings) out.issues.push({ sev, rule: result.rule, id: result.id, sel: finding.sel ?? null, detail: finding.detail, text: finding.text ?? '' });
  }
  const high = out.issues.filter((issue) => issue.sev === 'high').length;
  out.counts = { high, warn: out.issues.length - high };
  const blockFail = Object.values(out.ux.rules).some((result) => result.verdict === 'FAIL' && result.level === 'block');
  const requiredOpen = require.some((id) => out.ux.rules[id]?.verdict !== 'PASS' && out.ux.rules[id]?.verdict !== 'FAIL');
  if (high > 0 || blockFail || report.verdict === 'FAIL') out.verdict = 'FAIL';
  else if (requiredOpen || report.verdict === 'UNGRADED') out.verdict = 'UNGRADED';
  else out.verdict = 'PASS';
  return out;
}

export const UX_MUTATING_METHODS = MUTATING;
