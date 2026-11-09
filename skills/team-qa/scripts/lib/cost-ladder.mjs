// The cost ladder and the speed decision log (upgrade R3).
//
// Tiers: 0 machine, 1 cheap decision model, 2 large VLM/LLM, 3 adjudicator and human. A check is settled at the lowest
// tier that is conclusive for it, never below the minimum tier the signed plan sets for it (`speed.min_tier`), and a
// tier can only push work up to a higher tier. The cheap model (tier 1) never settles a check: it may only escalate, so
// it can never make a PASS. With `cost_ladder` off every check runs at the tier it runs at today (LADDER_CHECKS).
//
// Every speed decision (a ladder settlement, a vision by diff decision, a fast-click plan and check, a parallel lane
// check, an action cache lookup), in `shadow` as in `on`, is one JSON line of runs/<id>/decisions.jsonl
// (`team-qa/speed-decision/v1`). R0's timing receipt (lib/timing.mjs) reads it into timing.json and the report.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendConfirmed } from './core.mjs';
import { LADDER_CHECKS, TIERS } from './speed.mjs';

export const DECISION_SCHEMA = 'team-qa/speed-decision/v1';
export const DECISION_KINDS = Object.freeze(['ladder', 'vision_by_diff', 'fast_click', 'parallel_lanes', 'action_cache']);
export const decisionsPath = (runDir) => join(runDir, 'decisions.jsonl');

// One ladder decision. `steps` are the tiers tried in order: {tier, outcome: 'escalate'|'settled', verdict?, reason?}.
export function ladderDecision({ check, minTier = 0, mode = 'on', steps, caseId = null, state = null, at = new Date().toISOString(), latencyMs = null }) {
  const errors = [];
  if (!Object.hasOwn(LADDER_CHECKS, check)) errors.push(`LADDER_CHECK_UNKNOWN:${check}`);
  const list = Array.isArray(steps) ? steps : [];
  for (const step of list) if (!TIERS.includes(step?.tier)) errors.push(`LADDER_TIER_UNKNOWN:${step?.tier}`);
  if (!errors.length) {
    for (const step of list) if (step.tier < minTier) { errors.push(`LADDER_BELOW_MIN_TIER:${step.tier}<${minTier}`); break; }
    for (let i = 1; i < list.length; i += 1) if (list[i].tier <= list[i - 1].tier) { errors.push(`LADDER_NOT_UPWARD:${list[i - 1].tier}->${list[i].tier}`); break; }
    if (list.some((step) => step.tier === 1 && step.outcome === 'settled')) errors.push('LADDER_CHEAP_MODEL_SETTLES');
    else if (list.at(-1)?.outcome !== 'settled' || list.slice(0, -1).some((step) => step.outcome !== 'escalate')) errors.push('LADDER_NOT_SETTLED');
  }
  return {
    schema: DECISION_SCHEMA, kind: 'ladder', mode, case_id: caseId, state, check, min_tier: minTier,
    default_tier: LADDER_CHECKS[check] ?? null, steps: list.map((s) => ({ tier: s.tier, outcome: s.outcome, ...(s.verdict ? { verdict: s.verdict } : {}), ...(s.reason ? { reason: s.reason } : {}) })),
    settled_tier: errors.length ? null : list.at(-1).tier, errors, at, latency_ms: latencyMs,
  };
}

function decisionShapeErrors(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['object'];
  const errors = [];
  if (d.schema !== DECISION_SCHEMA) errors.push('schema');
  if (!DECISION_KINDS.includes(d.kind)) errors.push('kind');
  if (!['on', 'shadow'].includes(d.mode)) errors.push('mode');
  return errors;
}

export async function appendSpeedDecision(runDir, decision) {
  const errors = decisionShapeErrors(decision);
  if (errors.length) throw Object.assign(new Error(`SPEED_DECISION_INVALID ${errors.join(',')}`), { code: 'SPEED_DECISION_INVALID' });
  return appendConfirmed(decisionsPath(runDir), `${JSON.stringify(decision)}\n`, 'teamqa.speed.decision');
}

export function readSpeedDecisions(runDir) {
  const path = decisionsPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).flatMap((line) => {
    try { const d = JSON.parse(line); return decisionShapeErrors(d).length ? [] : [d]; } catch { return []; }
  });
}

// Counts for timing.json and the report's Speed section.
export function speedSummary(decisions) {
  const by = (list, key) => list.reduce((acc, d) => { const k = String(d[key]); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const ladder = decisions.filter((d) => d.kind === 'ladder');
  const vision = decisions.filter((d) => d.kind === 'vision_by_diff');
  const fast = decisions.filter((d) => d.kind === 'fast_click');
  const cache = decisions.filter((d) => d.kind === 'action_cache');
  const lanes = decisions.filter((d) => d.kind === 'parallel_lanes');
  return {
    by_kind: by(decisions, 'kind'),
    ladder: { decisions: ladder.length, by_settled_tier: by(ladder.filter((d) => d.settled_tier !== null), 'settled_tier'), refused: ladder.filter((d) => d.errors?.length).length },
    vision_by_diff: { states: vision.length, inherit: vision.filter((d) => d.decision === 'inherit').length, vlm: vision.filter((d) => d.decision === 'vlm').length,
      shadow_missed: vision.filter((d) => d.mode === 'shadow' && (d.missed_rules ?? []).length).length, by_mode: by(vision, 'mode') },
    ...(fast.length ? { fast_click: { cases: fast.length, fast_clicks: fast.reduce((n, d) => n + (d.summary?.fast_clicks ?? 0), 0),
      eligible_clicks: fast.reduce((n, d) => n + (d.plan?.fast || d.would_be_fast ? d.summary?.clicks ?? 0 : 0), 0), refused: fast.filter((d) => d.issues?.length).length } } : {}),
    ...(cache.length ? { action_cache: { lookups: cache.length, by_reason: by(cache, 'reason') } } : {}),
    ...(lanes.length ? { parallel_lanes: { checks: lanes.length, refused: lanes.filter((d) => d.errors?.length).length } } : {}),
  };
}

export function speedMarkdown(speed) {
  if (!speed?.decisions?.length) return '';
  const s = speed.summary;
  const rows = [
    `| vision_by_diff | ${s.vision_by_diff.states} states: inherit ${s.vision_by_diff.inherit}, VLM ${s.vision_by_diff.vlm}; shadow states where inheriting would have missed a VLM FAIL: ${s.vision_by_diff.shadow_missed} |`,
    `| cost_ladder | ${s.ladder.decisions} decisions; settled by tier ${JSON.stringify(s.ladder.by_settled_tier)}; refused ${s.ladder.refused} |`,
    ...(s.fast_click ? [`| fast_click | ${s.fast_click.cases} cases, ${s.fast_click.fast_clicks} fast clicks, ${s.fast_click.eligible_clicks} eligible clicks, refused ${s.fast_click.refused} |`] : []),
    ...(s.action_cache ? [`| action_cache | ${s.action_cache.lookups} lookups ${JSON.stringify(s.action_cache.by_reason)} |`] : []),
    ...(s.parallel_lanes ? [`| parallel_gui_lanes | ${s.parallel_lanes.checks} checks, refused ${s.parallel_lanes.refused} |`] : []),
  ];
  return ['', '## Speed', '', 'Speed flag decisions of this run (runs/<id>/decisions.jsonl; references/speed-flags.md).', '',
    '| Flag | Decisions |', '|---|---|', ...rows, ''].join('\n');
}
