// Upgrade integration: which of QA GUI's detectors a Team QA GUI case runs, and the TEAMQA_DETECTORS section of its case
// dispatch. Team QA decides what applies (its risk policy, from the tracked plan); QA GUI owns the detectors, their
// recipes and their grading (QA GUI scripts/lib/stream-detectors.mjs, references/team-qa-detectors.md). With a QA GUI
// that has no stream detectors the section is empty and the case runs as before.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { siblingSkillRoot } from './install-layout.mjs';

export const DETECTOR_EXPORTS = ['STREAM_DETECTORS_VERSION', 'dragonOps', 'transientProbeFromOps', 'widthSweepFromOps', 'overlayCheckFromOps',
  'explorationFromOps', 'uxActionResultsFromOps', 'uxUnavailableResults', 'foldUxInto', 'detectorPromptSection',
  // Fix round 1 (D1): the screen check of each screen, once per run, and its fold into the cases on that screen.
  'screenCheckPromptSection', 'screenCheckFromOps', 'foldScreenChecks', 'STREAM_HELPERS'];
// The U rules a case forces a state for at the environment layer (R1c); U4, U5, U6 and U9 ride every Gate-0 read.
export const UX_FORCED_RULES = Object.freeze(['U1', 'U2', 'U3']);
export const EXPLORE_BUDGET = 12;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// QA GUI's stream detectors next to this Team QA (TEAMQA_QA_GUI_ROOT wins), with the probe, env, cell and app map
// functions web collect needs; null when that QA GUI has none.
export async function qaGuiDetectorTools(root = siblingSkillRoot('qa-gui')) {
  const files = { stream: 'scripts/lib/stream-detectors.mjs', probes: 'scripts/lib/probes.mjs', env: 'scripts/lib/dragon-env.mjs', cell: 'scripts/lib/coverage-cell.mjs', map: 'scripts/loop6/app-map.mjs',
    transient: 'scripts/lib/transient-probe.mjs' };
  if (!Object.values(files).every((rel) => existsSync(join(root, rel)))) return null;
  const load = (rel) => import(pathToFileURL(realpathSync(join(root, rel))).href);
  const [stream, probes, env, cell, map, transient] = await Promise.all(Object.values(files).map(load));
  if (!DETECTOR_EXPORTS.every((name) => name in stream) || typeof probes.probeCells !== 'function' || typeof cell.cellConditionsOf !== 'function') return null;
  return { ...stream, probeCells: probes.probeCells, probeVerdict: probes.probeVerdict, stateEnvIssues: env.stateEnvIssues, caseEnvResetIssues: env.caseEnvResetIssues,
    cellConditionsOf: cell.cellConditionsOf, routeOf: cell.routeOf, buildAppMapV2: map.buildAppMapV2, classifyAction: transient.classifyAction,
    // Fix round 2 (E9): the QA GUI root the lane uses, whose helper pack the executor names by path and hash.
    qaGuiRoot: root };
}

// The U rules a case forces, from its tracked plan entry: `data.ux` names them; a cell condition `request=hold...`
// asks for U1/U2 and `request=respond:4xx|5xx` or `request=fail...` for U3.
export function caseUxRules(plannedCase) {
  const rules = new Set((Array.isArray(plannedCase?.data?.ux) ? plannedCase.data.ux : []).filter((rule) => UX_FORCED_RULES.includes(rule)));
  for (const key of Array.isArray(plannedCase?.conditions) ? plannedCase.conditions : []) {
    for (const part of String(key).split('+')) {
      if (!part.startsWith('request=')) continue;
      const value = part.slice('request='.length);
      if (/(^|,)hold/.test(value)) { rules.add('U1'); rules.add('U2'); }
      if (/(^|,)(respond:[45]\d\d|fail)/.test(value)) rules.add('U3');
    }
  }
  return UX_FORCED_RULES.filter((rule) => rules.has(rule));
}

// Dogfood 05/11 (BA R1c): the plan's own state list asks for forced states too. A case whose main action adds or saves
// data (submit, save, list-add) and whose states name "loading" gets U1/U2 (the write held), and "error" gets U3 (the write
// answered with an error). A write that removes data never gets a forced state from its state list (its held click would
// need a human under the manual destructive policy).
const ADDING_WRITES = ['submit', 'save', 'list-add'];
export function stateUxRules(plannedCase, kinds = []) {
  if (!(Array.isArray(kinds) && kinds.some((k) => ADDING_WRITES.includes(k))) || kinds.some((k) => ['delete', 'list-remove'].includes(k))) return [];
  const states = new Set((Array.isArray(plannedCase?.states) ? plannedCase.states : []).map((s) => String(s).trim().toLowerCase()));
  return [...(states.has('loading') ? ['U1', 'U2'] : []), ...(states.has('error') ? ['U3'] : [])];
}

// Team QA's risk policy for the R1d probe: a behavioral case whose main action (below) is a risky action of the BA R1d list
// (QA GUI's classifier on the labels the steps quote: submit, save, delete, a toast, adding, removing, sorting or
// filtering a list, a tab, a theme or language switch, loading more), or a modal opening, drag-and-drop or scroll the
// steps name. `data.transient: true|false` in the plan decides it outright. Fix round 2 (E3): the classifier gets a
// neutral context (a plain button, no form, list, dialog or toast region), and setting-up navigation ("open the orders
// page", "go to", "navigate") is not risky.
const RISKY_WORDS = /\b(modal|dialog|pop-?up|drawer|drag|drop|scroll|swipe|reorder|accordion|expand|collapse|toggle|switch|upload)\b/i;
// Fix round 3 (F1): the probe looks at the case's main action only. It is the plan's `data.main_action` (a label, or
// {label, inForm?, inList?, inDialog?}) when the plan has one, else the last quoted control of the steps, else the last
// step. Sign-in steps, setting-up navigation (an "open"/"go to" step with no quoted control and no risky word) and
// checks ("verify ...") never decide it. Risk comes from that action in a neutral context; repeatability from it in its
// own context, read from its step ("in the modal", "on the first row", an upload): a control in a form, a modal or a
// drawer submits what it holds. Dispatch and collect both call caseDetectorPlan, so they decide the same.
const SIGN_IN = /(?:^|[^\p{L}\p{N}])(?:log ?in|log ?on|sign ?in|sign-in|authenticate|\u0111\u0103ng nh\u1eadp)(?=$|[^\p{L}\p{N}])/iu;
const NAVIGATION = /^\s*(?:open|go(?: back)? to|navigate(?: to)?|visit|browse to|load|reload|refresh|return to)\b/i;
const CHECK = /^\s*(?:verify|expect|assert|ensure|observe|make sure|check that|see that|confirm that|wait for|wait until)\b/i;
const QUOTED = /(?:^|[^\p{L}\p{N}])['"\u201c\u2018]([^'"\u201d\u2019]{1,80})['"\u201d\u2019](?=$|[^\p{L}\p{N}])/gu;
const WHERE = (places) => new RegExp(`\\b(?:in|inside|within|on|from|of)\\s+(?:(?:the|a|an|this|that|each|every)\\s+)?(?:[\\p{L}-]+\\s+)?(?:${places})\\b`, 'iu');
const IN_FORM = WHERE('form|modal|dialog|drawer|pop-?up|sheet|wizard'), IN_LIST = WHERE('list|table|row|grid|cards?|items?'), IN_DIALOG = WHERE('modal|dialog|drawer|pop-?up|sheet');
const contextOf = (step) => ({ inForm: IN_FORM.test(step) || /\bupload/i.test(step), inList: IN_LIST.test(step), inDialog: IN_DIALOG.test(step) });
/** The case's main action: {label, step, source: 'plan'|'quoted'|'step', context: {inForm, inList, inDialog}}, or null. */
export function mainActionOf(plannedCase) {
  const field = plannedCase?.data?.main_action;
  if (typeof field === 'string' && field.trim()) return { label: field.trim(), step: field.trim(), source: 'plan', context: contextOf(field) };
  if (object(field) && typeof field.label === 'string' && field.label.trim()) {
    return { label: field.label.trim(), step: field.label.trim(), source: 'plan', context: { inForm: field.inForm === true, inList: field.inList === true, inDialog: field.inDialog === true } };
  }
  const steps = (Array.isArray(plannedCase?.steps) ? plannedCase.steps : [plannedCase?.steps]).map((x) => String(x ?? '').normalize('NFC').trim()).filter(Boolean);
  const quotes = (step) => [...step.matchAll(QUOTED)].map((m) => m[1].trim()).filter(Boolean);
  const acting = steps.filter((step) => !SIGN_IN.test(step) && !CHECK.test(step) && !(NAVIGATION.test(step) && !quotes(step).length && !RISKY_WORDS.test(step)));
  const quoted = acting.filter((step) => quotes(step).length).at(-1);
  if (quoted) return { label: quotes(quoted).at(-1), step: quoted, source: 'quoted', context: contextOf(quoted) };
  const last = acting.at(-1);
  return last ? { label: last, step: last, source: 'step', context: contextOf(last) } : null;
}
const kindsOf = (c) => (Array.isArray(c?.kinds) ? c.kinds : c?.risky ? ['risky'] : []);
/** The action kinds QA GUI's classifier gives the case's main action in its own context (what repeatability uses). */
export function plannedActionKinds(plannedCase, classify) {
  const main = mainActionOf(plannedCase);
  if (typeof classify !== 'function' || !main) return [];
  const { inForm, inList, inDialog } = main.context;
  return [...new Set(kindsOf(classify({ method: 'click', target: { tag: 'button', label: main.label, ...(inForm ? { inForm } : {}), ...(inList ? { inList } : {}), ...(inDialog ? { inDialog } : {}) }, page: inList ? { list: true } : {} })))];
}
export function riskyMainAction(plannedCase, classify = null) {
  if (plannedCase?.data?.transient === false) return false;
  if (plannedCase?.data?.transient === true) return true;
  if (plannedCase?.kind !== 'behavioral') return false;
  if (typeof classify !== 'function') return true;
  const main = mainActionOf(plannedCase);
  if (!main) return false;
  return RISKY_WORDS.test(main.step) || kindsOf(classify({ method: 'click', target: { tag: 'button', label: main.label }, page: {} })).length > 0;
}
// The plan's reset path for the main action (data.reset: steps, or a sentence saying how to put the data back).
const resetOf = (plannedCase) => { const r = plannedCase?.data?.reset; return Array.isArray(r) ? r.length > 0 : typeof r === 'string' ? r.trim().length > 0 : r === true; };

/**
 * What one GUI case runs (Team QA's choice; QA GUI grades): the transient probe around its main action when that is
 * risky (as often as QA GUI's transientRepeatability allows: a write that adds or saves with no reset path gets fresh-value
 * trials, a removing write with none gets no trial, N/A), the U-rule states it forces (data.ux, a cell condition, or the
 * plan's "loading" / "error" state of such a write),
 * the U-rule states it forces, and the frontier exploration when the tracked plan has a coverage block and the case is
 * a cell case. The width sweep and the overlay check run once per screen, in their own dispatch (screens).
 */
export function caseDetectorPlan({ plannedCase, tracked = null, explorationPolicy = null, classify = null, repeatability = null, screens = null }) {
  const cellCase = object(tracked?.coverage) && typeof plannedCase?.route === 'string' && plannedCase.route.length > 0;
  const risky = riskyMainAction(plannedCase, classify);
  const kinds = plannedActionKinds(plannedCase, classify), reset = resetOf(plannedCase);
  const decided = risky && typeof repeatability === 'function' ? repeatability({ kinds, reset }) : null;
  // Dogfood 05/11: a write that adds or saves with no reset path is probed with fresh test values (QA GUI decides).
  const fresh = decided?.fresh === true;
  const ux = new Set([...caseUxRules(plannedCase), ...(risky ? stateUxRules(plannedCase, kinds) : [])]);
  // Round G (G5): a case on a screen (routed or reached from its entry link) probes that screen's entry too.
  const screen = Array.isArray(screens?.screens) ? screens.screens.find((x) => Array.isArray(x.cases) && x.cases.includes(plannedCase?.id)) ?? null : null;
  return {
    ...(screen ? { entry: { screenId: screen.id, url: screen.entry ? null : screen.url ?? null } } : {}),
    transient: risky && (!decided || decided.trials > 0) ? { trials: decided?.trials ?? 3, kinds, reset, ...(fresh ? { fresh } : {}) } : false,
    ...(decided && decided.trials === 0 ? { transientNa: decided.reason } : {}),
    ...(fresh ? { fresh } : {}),
    ux: UX_FORCED_RULES.filter((rule) => ux.has(rule)),
    explore: cellCase ? { policy: explorationPolicy ?? {}, budget: EXPLORE_BUDGET } : null,
  };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
// The run's exploration policy: the file `teamqa coverage policy` wrote, else the one computed from the plans.
export async function runExplorationPolicy({ runDir, tracked }) {
  const { EXPLORATION_POLICY_FILE, explorationPolicy } = await import('./coverage-cells.mjs');
  const file = join(runDir, EXPLORATION_POLICY_FILE);
  let plan = {};
  try {
    const { signedPlanFile } = await import('./speed.mjs');
    const text = readFileSync(signedPlanFile(runDir), 'utf8');
    plan = JSON.parse(text.slice(text.indexOf('TEAMQA_PLAN_START') + 'TEAMQA_PLAN_START'.length, text.indexOf('TEAMQA_PLAN_END')));
  } catch { plan = {}; }
  const computed = explorationPolicy({ tracked, plan, runId: runDir.split(/[\\/]/).at(-1) });
  // The file `teamqa coverage policy` wrote is honoured only when it is the policy the signed plan gives: a file in the
  // run folder never widens what the plan approves (approvedDestructive) nor changes what it ranks.
  if (existsSync(file)) {
    let stored = null;
    try { stored = readJson(file); } catch { stored = null; }
    if (stored && JSON.stringify(stored) === JSON.stringify(computed)) return stored;
  }
  return computed;
}

// The TEAMQA_DETECTORS section of one GUI case dispatch ('' without QA GUI stream detectors or a locked tracked plan).
export async function dispatchDetectorSection({ runDir, caseId, tools = undefined }) {
  const detectors = tools === undefined ? await qaGuiDetectorTools() : tools;
  if (!detectors) return '';
  let tracked, plannedCase;
  try {
    const lock = readJson(join(runDir, 'docs-lock.json'));
    tracked = readJson(join(runDir, lock.artifacts.tracked.path));
    plannedCase = tracked.cases.find((c) => c.id === caseId);
  } catch { return ''; }
  if (!plannedCase) return '';
  let fast = false;
  try {
    const { runSpeedPolicy, speedMode } = await import('./speed.mjs');
    const { caseChecksHoverOrDrag } = await import('./speed-collect.mjs');
    fast = speedMode(runSpeedPolicy(runDir), 'fast_click') === 'on' && !caseChecksHoverOrDrag(plannedCase);
  } catch { fast = false; }
  const { runScreenPlan, screenUrl } = await import('./screen-checks.mjs');
  let screens = null;
  try { screens = runScreenPlan(runDir); } catch { screens = null; }
  const plan = caseDetectorPlan({ plannedCase, tracked, explorationPolicy: object(tracked.coverage) ? await runExplorationPolicy({ runDir, tracked }) : null, classify: detectors.classifyAction,
    repeatability: detectors.transientRepeatability, screens: typeof detectors.entryProbeFromOps === 'function' ? screens : null });
  // G5: an entry screen's URL is where its check measured it (once collected), never the entry link.
  if (plan.entry) plan.entry.url = screenUrl(runDir, screens.screens.find((x) => x.id === plan.entry.screenId));
  if (!plan.transient && !plan.ux.length && !plan.explore && !plan.entry) return '';
  const pack = typeof detectors.helperPack === 'function' ? { pack: detectors.helperPack(detectors.qaGuiRoot ?? null) } : {};
  return `TEAMQA_DETECTORS (QA GUI ${detectors.STREAM_DETECTORS_VERSION}; references/executor-evidence.md)\n${detectors.detectorPromptSection({ caseId, detectors: plan, fast, ...pack })}\n\n`;
}

// The TEAMQA_SCREEN_CHECK section of one screen check dispatch (roster.mjs dispatch --screen-id).
export async function dispatchScreenSection({ runDir, screenId, tools = undefined }) {
  const detectors = tools === undefined ? await qaGuiDetectorTools() : tools;
  if (!detectors?.screenCheckPromptSection) return null;
  const { runScreenPlan } = await import('./screen-checks.mjs');
  const screen = runScreenPlan(runDir).screens.find((s) => s.id === screenId);
  if (!screen || !screen.url) return null;
  // Round G (G4): a screen reached from its case's entry link: the case's steps up to its first write, its account.
  const entry = screen.entry ? { url: screen.entry, steps: screen.steps ?? [], account: screen.account ?? null, caseId: screen.cases?.[0] ?? null } : null;
  let fast = false;
  try { const { runSpeedPolicy, speedMode } = await import('./speed.mjs'); fast = speedMode(runSpeedPolicy(runDir), 'fast_click') === 'on'; } catch { fast = false; }
  // Fix round 2 (E2): the screen check signs in as the screen's role, the way a GUI case of that role does.
  const signIn = screen.role ? `with the account the run's input files give for the role ${JSON.stringify(screen.role)} (the roles or accounts file; read it, never print a secret), the same sign-in a GUI case of that role does before its first step` : null;
  const pack = typeof detectors.helperPack === 'function' ? { pack: detectors.helperPack(detectors.qaGuiRoot ?? null) } : {};
  return `TEAMQA_SCREEN_CHECK screen=${screenId} (QA GUI ${detectors.STREAM_DETECTORS_VERSION})\n${detectors.screenCheckPromptSection({ screenId, url: screen.url, route: screen.route, role: screen.role, signIn, planned: screen.planned, fast, ...pack, ...(entry ? { entry } : {}) })}\n\n`;
}
