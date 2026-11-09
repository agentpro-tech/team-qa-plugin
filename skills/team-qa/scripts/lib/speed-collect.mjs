// Speed flags in `teamqa web collect` and in the GUI case dispatch (upgrade R3). With every flag off nothing here runs:
// the board, receipts and files are what collect wrote before R3.
//
// - vision_by_diff: for each collected state, QA GUI's tier-0 decision (scripts/lib/vision-by-diff.mjs) against the
//   approved-baseline store the signed plan pins, copied into the run (evidence/qa-gui/speed/). `shadow` keeps the
//   executor's VLM verdicts and logs what inheriting would have given, and which VLM FAIL it would have missed. `on`
//   writes the inherited assertions (with the baseline SHA) for a state the decision lets inherit, unless the executor
//   saw a FAIL there; a state the executor left to the machine (`"vision": "inherit"`) that cannot inherit stays
//   UNGRADED with VISION_TIER2_REQUIRED, and the next dispatch of the case asks the VLM for it.
// - cost_ladder: a ladder record per state for gate0 (tier 0), vision (0, or 0 then 2, or 2), function (2).
// - fast_click: under `on`, a fast click in a case that checks hover or drag-and-drop refuses the collect
//   (FAST_CLICK_ON_HOVER_OR_DRAG_CASE); `shadow` and `on` log the case's clicks.
// Every decision is a line of runs/<id>/decisions.jsonl (lib/cost-ladder.mjs).
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { siblingSkillRoot } from './install-layout.mjs';
import { DECISION_SCHEMA, ladderDecision, readSpeedDecisions } from './cost-ladder.mjs';
import { minTier, pinnedStore, speedMode } from './speed.mjs';

export const SPEED_STORE_DIR = 'evidence/qa-gui/speed';
const RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const HOVER_DRAG_TEXT = /\b(?:hover|hovers|hovering|mouse ?over|drag|drags|dragging|drag-and-drop|drop zone)\b/i;

// QA GUI's speed tools, next to this Team QA (TEAMQA_QA_GUI_ROOT wins); null when that QA GUI has none.
export async function qaGuiSpeedTools(root = siblingSkillRoot('qa-gui')) {
  const files = ['vision-by-diff.mjs', 'baseline-store.mjs', 'fast-click.mjs', 'action-cache.mjs'].map((f) => join(root, 'scripts/lib', f));
  if (!files.every((f) => existsSync(f))) return null;
  const mods = await Promise.all(files.map((f) => import(pathToFileURL(realpathSync(f)).href)));
  return Object.assign({}, ...mods);
}

// A case checks hover or drag-and-drop when its tracked data says so (`data.interaction`) or its text names it.
export function caseChecksHoverOrDrag(plannedCase) {
  const declared = Array.isArray(plannedCase?.data?.interaction) ? plannedCase.data.interaction : [];
  if (declared.some((x) => ['hover', 'drag', 'drag-and-drop'].includes(String(x)))) return true;
  const text = [plannedCase?.title, plannedCase?.expected, ...(Array.isArray(plannedCase?.steps) ? plannedCase.steps : [plannedCase?.steps])].filter(Boolean).join(' ');
  return HOVER_DRAG_TEXT.test(text);
}

// Copies the pinned baseline store (byte for byte, so its SHA-256 stays the signed one) and every PNG it lists into
// the run, once. Returns {rel, dir, store} of the in-run copy.
export function snapshotBaselineStore({ runDir, policy, tools }) {
  const { path, bytes } = pinnedStore(policy, 'baseline_store');
  const store = JSON.parse(bytes.toString('utf8'));
  const problems = tools.storeErrors(store, { dir: dirname(path) });
  if (problems.length) throw Object.assign(new Error(`SPEED_STORE_INVALID ${problems.join(',')}`), { code: 'SPEED_STORE_INVALID' });
  const dir = join(runDir, SPEED_STORE_DIR);
  mkdirSync(join(dir, 'png'), { recursive: true });
  const target = join(dir, 'approved-baselines.json');
  if (!existsSync(target)) copyFileSync(path, target);
  else if (!readFileSync(target).equals(bytes)) throw Object.assign(new Error('SPEED_STORE_DRIFT the run already holds another baseline store'), { code: 'SPEED_STORE_DRIFT' });
  for (const entry of store.entries) {
    const png = join(dir, 'png', `${entry.sha256}.png`);
    if (!existsSync(png)) copyFileSync(join(dirname(path), 'png', `${entry.sha256}.png`), png);
  }
  return { rel: `${SPEED_STORE_DIR}/approved-baselines.json`, dir, store };
}

const pngOf = (built, rel, readFile) => {
  const file = built.files.find((f) => f.rel === rel);
  if (!file) return null;
  return file.data ?? readFile(file.from);
};

// States the decision log already sent to the VLM for this case (an `on` state that could not inherit).
export function tier2States(runDir, caseId) {
  return new Set(readSpeedDecisions(runDir).filter((d) => d.kind === 'vision_by_diff' && d.case_id === caseId && d.escalated === true).map((d) => d.state));
}

// Applies the speed flags to one built case (web-collect buildCaseEvidence output). Returns {built, decisions, issues,
// refuse}: `refuse` is a code that stops the collect before anything is written.
export function applySpeedToCase({ built, draft, calls, policy, tools, baselines = null, plannedCase, readFile, now = () => new Date().toISOString() }) {
  const decisions = [], issues = [];
  const vMode = speedMode(policy, 'vision_by_diff'), lMode = speedMode(policy, 'cost_ladder'), fMode = speedMode(policy, 'fast_click');
  const caseId = built.caseId;
  let vision = built.vision;
  for (const { value: receipt } of built.receipts) {
    const state = receipt.state;
    const own = vision.filter((v) => v.state === state);
    const draftState = draft.states.find((s) => s.state === state);
    const leftToMachine = draftState?.vision === 'inherit';
    let decision = null;
    if (vMode !== 'off' && baselines) {
      const png = pngOf(built, receipt.screenshot.path, readFile);
      const key = { route: tools.routeOf(receipt.url), state, viewport: receipt.viewport, build: receipt.build };
      decision = png ? tools.visionDiffDecision({ png, key, store: baselines.store, storeDir: baselines.dir, sweep: receipt.ui, capturedAt: receipt.capturedAt, minTier: minTier(policy, 'vision') })
        : { decision: 'vlm', reasons: ['SCREENSHOT_NOT_COLLECTED'], baseline: null, diff: null, tier: 2 };
      const vlm = Object.fromEntries(own.map((v) => [v.rule, v.verdict]));
      const sawFail = RULES.some((rule) => vlm[rule] === 'FAIL');
      // What inheriting would miss: a rule the VLM failed that the baseline would have passed.
      const missed = decision.decision === 'inherit' ? RULES.filter((rule) => vlm[rule] === 'FAIL') : [];
      let applied = false, escalated = false;
      if (vMode === 'on') {
        if (decision.decision === 'inherit' && !sawFail && minTier(policy, 'vision') === 0) {
          const inherited = tools.inheritedVisionAssertions({ decision, caseId, state, evidenceRef: receipt.screenshot.path });
          vision = [...vision.filter((v) => v.state !== state), ...inherited];
          applied = true;
        } else if (decision.decision !== 'inherit' && leftToMachine) {
          issues.push(`VISION_TIER2_REQUIRED:${caseId}:${state}:${decision.reasons.join(',')}`);
          escalated = true;
        }
      }
      decisions.push({ schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: vMode, case_id: caseId, state, at: now(), decision: decision.decision,
        reasons: decision.reasons, baseline_sha256: decision.baseline?.sha256 ?? null, same_build: decision.baseline?.same_build ?? null,
        diff_percent: decision.diff?.percent ?? null, max_tile_percent: decision.diff?.max_tile_percent ?? null, latency_ms: decision.duration_ms ?? null,
        vlm_verdicts: vlm, vlm_skipped: leftToMachine && applied, applied, escalated, agree: decision.decision === 'inherit' ? missed.length === 0 : null, missed_rules: missed });
    }
    if (lMode !== 'off') {
      // What actually settled each check of this state. A plan minimum the run did not reach shows as the record's error.
      const vision0 = decision && minTier(policy, 'vision') === 0;
      const inheritedHere = decisions.at(-1)?.kind === 'vision_by_diff' && decisions.at(-1).applied === true;
      const visionSteps = !vision0 ? [{ tier: 2, outcome: 'settled' }]
        : inheritedHere ? [{ tier: 0, outcome: 'settled', reason: 'BASELINE_MATCH' }]
          : [{ tier: 0, outcome: 'escalate', reason: decision.decision === 'inherit' ? (vMode === 'on' ? 'VLM_SAW_FAIL' : 'SHADOW') : decision.reasons.join(',') }, { tier: 2, outcome: 'settled' }];
      for (const [check, steps] of [['gate0', [{ tier: 0, outcome: 'settled' }]], ['vision', visionSteps], ['function', [{ tier: 2, outcome: 'settled' }]]]) {
        const record = ladderDecision({ check, minTier: minTier(policy, check), mode: lMode, steps, caseId, state, at: now() });
        decisions.push(record);
        if (record.errors.length) issues.push(`${record.errors[0].split(':')[0]}:${caseId}:${state}:${check}:${record.errors[0]}`);
      }
    }
  }
  let refuse = null;
  if (fMode !== 'off') {
    const dragon = [...calls.values()].filter((c) => typeof c.method === 'string').map((c) => ({ method: c.method, params: c.params ?? {} }));
    const checks = caseChecksHoverOrDrag(plannedCase);
    const found = tools.fastClickIssues({ calls: dragon, mode: fMode, caseChecksHoverOrDrag: checks });
    decisions.push({ schema: DECISION_SCHEMA, kind: 'fast_click', mode: fMode, case_id: caseId, at: now(), plan: tools.fastClickPlan({ mode: fMode, caseChecksHoverOrDrag: checks }),
      would_be_fast: !checks, summary: tools.fastClickSummary(dragon), issues: found });
    if (found.length) refuse = found[0];
  }
  return { built: vision === built.vision ? built : { ...built, vision }, decisions, issues, refuse };
}

// The speed section of a GUI case dispatch prompt, from the signed plan. Empty when every flag the executor sees is off.
export function speedPromptSection({ policy, plannedCase, lane = null, tier2 = new Set(), cacheHit = null }) {
  const lines = [];
  const fast = speedMode(policy, 'fast_click') === 'on', vision = speedMode(policy, 'vision_by_diff') === 'on';
  if (fast) {
    lines.push(caseChecksHoverOrDrag(plannedCase)
      ? '- fast_click: this case checks hover or drag-and-drop, so keep human-speed input: every click step `fast:false`.'
      : '- fast_click: you may set `fast:true` on click steps (Dragon trusted click without the human-speed cursor travel). Do not hover or drag in this case; if the case needs hover or drag-and-drop, use `fast:false` on every click.');
  }
  if (vision) {
    lines.push('- vision_by_diff: for a state you capture, after its screenshot and Gate-0 sweep, you may write `"vision": "inherit"` in the draft instead of the seven C10–C16 verdicts and skip opening that PNG. Team QA then compares the screenshot with the approved baseline; if it cannot inherit, the state stays UNGRADED and the case is dispatched again for a VLM pass. Judge any state you have already looked at as usual, and always report a FAIL you see.');
    if (tier2.size) lines.push(`- vision_by_diff: the last attempt could not inherit these states, so give all seven C10–C16 verdicts for them yourself: ${[...tier2].sort().join(', ')}.`);
  }
  if (lane && speedMode(policy, 'parallel_gui_lanes') === 'on' && lane.parallel_ok === true) {
    lines.push(`- parallel_gui_lanes: this case runs on lane ${lane.id}. Create your Dragon session with a sessionId that starts with \`${lane.dragon_session}-\`, use only the test account of this lane (${lane.account}) and only data in the namespace ${lane.data_namespace}.`);
  }
  if (cacheHit && speedMode(policy, 'action_cache') === 'on') {
    lines.push(`- action_cache: a passed run reached this case's first state from the start page with these trusted steps (stored ${cacheHit.stored_at}). You may replay them in one Dragon \`do\` call right after the identity reads, then capture and check every state for real (screenshot, Gate-0, console, network, assertions). If a step fails, continue the normal way.\n  \`${JSON.stringify(cacheHit.steps)}\``);
  }
  return lines.length ? `TEAMQA_SPEED (from the signed plan; references/speed-flags.md)\n${lines.join('\n')}\n\n` : '';
}

// What `web collect` needs for the run's flags, or null when every flag is off (collect then runs as before R3).
export async function speedForCollect({ runDir, speedTools = undefined }) {
  const { allOff, runSpeedPolicy, signedPlanFile } = await import('./speed.mjs');
  // No plan file to read flags from: nothing is on (the run contract checks the plan itself).
  if (!existsSync(signedPlanFile(runDir))) return null;
  const policy = runSpeedPolicy(runDir);
  if (allOff(policy)) return null;
  const needsTools = ['vision_by_diff', 'fast_click'].some((flag) => speedMode(policy, flag) !== 'off');
  const tools = speedTools === undefined ? (needsTools ? await qaGuiSpeedTools() : null) : speedTools;
  if (needsTools && !tools) throw Object.assign(new Error(`SPEED_QA_GUI_TOOLS_UNAVAILABLE ${join(siblingSkillRoot('qa-gui'), 'scripts/lib/vision-by-diff.mjs')} is missing: install the QA GUI that has the R3 speed tools next to Team QA, or set TEAMQA_QA_GUI_ROOT`), { code: 'SPEED_QA_GUI_TOOLS_UNAVAILABLE' });
  const baselines = speedMode(policy, 'vision_by_diff') !== 'off' ? snapshotBaselineStore({ runDir, policy, tools }) : null;
  return { policy, tools, baselines };
}

// The TEAMQA_SPEED section of one GUI case dispatch, from the run's signed plan ('' when nothing applies).
export async function dispatchSpeedSection({ runDir, caseId, speedTools = undefined }) {
  const { allOff, runSpeedPolicy } = await import('./speed.mjs');
  let policy;
  try { policy = runSpeedPolicy(runDir); } catch { return ''; }
  if (allOff(policy)) return '';
  let plannedCase = null, lane = null;
  try {
    const lock = JSON.parse(readFileSync(join(runDir, 'docs-lock.json'), 'utf8'));
    plannedCase = JSON.parse(readFileSync(join(runDir, lock.artifacts.tracked.path), 'utf8')).cases.find((c) => c.id === caseId) ?? null;
    const text = readFileSync(join(runDir, policy.source.path), 'utf8');
    const plan = JSON.parse(text.slice(text.indexOf('TEAMQA_PLAN_START') + 'TEAMQA_PLAN_START'.length, text.indexOf('TEAMQA_PLAN_END')));
    lane = (plan.lanes ?? []).find((l) => Array.isArray(l?.scope) && l.scope.includes(plannedCase?.req_id)) ?? null;
  } catch { /* no locked tracked plan yet: no case-specific lines */ }
  let cacheHit = null;
  if (speedMode(policy, 'action_cache') !== 'off') {
    const tools = speedTools === undefined ? await qaGuiSpeedTools() : speedTools;
    if (tools) { try { cacheHit = await (await import('./speed-cache.mjs')).cacheLookup({ runDir, caseId, tools }); } catch { cacheHit = null; } }
  }
  return speedPromptSection({ policy, plannedCase, lane, tier2: tier2States(runDir, caseId), cacheHit });
}
