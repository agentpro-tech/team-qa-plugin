// Speed flags (upgrade R3). Every speed-up that skips work is a named flag in the `speed` block of the signed plan
// (`test-plan.md`, TEAMQA_PLAN block), `off` unless the plan says `shadow` or `on`. Team QA reads the flags from the
// plan file the user signed (its SHA-256 is the policy's source) and passes them on: to the GUI executor's dispatch
// prompt, to `web collect`, and to QA GUI as the board's `speedPolicy`. The executor never sets a flag. `shadow` runs
// the full path exactly as `off` and records what the speed-up would have decided (runs/<id>/decisions.jsonl).
// Names, defaults, where each is set, what it skips and what always still runs: references/speed-flags.md.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SPEED_FLAGS = Object.freeze(['vision_by_diff', 'cost_ladder', 'parallel_gui_lanes', 'fast_click', 'action_cache']);
export const SPEED_MODES = Object.freeze(['off', 'shadow', 'on']);
export const TIERS = Object.freeze([0, 1, 2, 3]);
export const TIER_NAMES = Object.freeze({ 0: 'machine', 1: 'cheap-model', 2: 'large-model', 3: 'adjudicator-or-human' });
// The checks of a GUI case the cost ladder knows, and the tier each one runs at today (every flag off).
export const LADDER_CHECKS = Object.freeze({ gate0: 0, vision: 2, function: 2, verdict: 2 });
export const SPEED_POLICY_SOURCE = 'team-qa/signed-plan';
const STORE_FIELDS = ['baseline_store', 'action_cache_store'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const FLAG_DOCS = Object.freeze({
  vision_by_diff: {
    skips: 'the VLM pass (C10-C16) of a state with an approved baseline, a diff of at most 0.5% after the approved mask with no concentrated change, and clean DOM sweeps; the state inherits the baseline verdicts with its SHA-256',
    always: 'the screenshot, Gate-0 sweeps, function assertions, the baseline diff, and QA GUI gate recomputation of every inherited assertion; any other state gets its VLM pass',
  },
  cost_ladder: {
    skips: 'settling a check at a tier above the lowest conclusive tier the plan allows (min_tier); records every tier decision in decisions.jsonl',
    always: 'every check at or above its minimum tier; a tier only pushes work up; a cheap model never makes a PASS',
  },
  parallel_gui_lanes: {
    skips: 'running GUI lanes one after another: lanes with parallel_ok:true may run at the same time',
    always: 'each lane has its own test account or tenant, data namespace and Dragon session, checked before parallel_ok counts; two lanes on one account are refused',
  },
  fast_click: {
    skips: 'Dragon human-speed cursor travel on clicks (fast:true)',
    always: 'trusted clicks through Dragon; never in a case that checks hover or drag-and-drop',
  },
  action_cache: {
    skips: 'working out again the action path to a state that a passed run already reached with the same fingerprint',
    always: 'every sweep and assertion; a waitFor guard per cached action; no verdict is ever cached; entries expire after 14 days',
  },
});

function storeErrors(store, field) {
  if (!object(store) || Object.keys(store).some((key) => !['path', 'sha256'].includes(key))) return [`PLAN_SPEED_STORE ${field}`];
  const path = store.path;
  if (typeof path !== 'string' || !path.trim() || isAbsolute(path) || path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(store.sha256 ?? '')) return [`PLAN_SPEED_STORE ${field}`];
  return [];
}

// Errors of the plan's `speed` block (an empty list when it is absent or valid).
export function planSpeedErrors(speed) {
  if (speed === undefined) return [];
  if (!object(speed)) return ['PLAN_TYPE speed'];
  const errors = [];
  for (const key of Object.keys(speed)) {
    if (SPEED_FLAGS.includes(key)) { if (!SPEED_MODES.includes(speed[key])) errors.push(`PLAN_SPEED_MODE speed.${key}`); }
    else if (key === 'min_tier') {
      if (!object(speed.min_tier)) errors.push('PLAN_SPEED_MIN_TIER speed.min_tier');
      else for (const [check, tier] of Object.entries(speed.min_tier)) {
        if (!Object.hasOwn(LADDER_CHECKS, check) || !TIERS.includes(tier)) errors.push(`PLAN_SPEED_MIN_TIER speed.min_tier.${check}`);
      }
    } else if (STORE_FIELDS.includes(key)) errors.push(...storeErrors(speed[key], `speed.${key}`));
    else errors.push(`PLAN_SPEED_UNKNOWN_FIELD speed.${key}`);
  }
  if (['shadow', 'on'].includes(speed.vision_by_diff) && !Object.hasOwn(speed, 'baseline_store')) errors.push('PLAN_SPEED_STORE_REQUIRED speed.baseline_store');
  if (['shadow', 'on'].includes(speed.action_cache) && !Object.hasOwn(speed, 'action_cache_store')) errors.push('PLAN_SPEED_STORE_REQUIRED speed.action_cache_store');
  return errors;
}

// The normalized speed settings of a plan value: every flag named (off by default), min_tier and the pinned stores.
export function speedOf(planValue) {
  const speed = object(planValue?.speed) ? planValue.speed : {};
  return {
    flags: Object.fromEntries(SPEED_FLAGS.map((flag) => [flag, SPEED_MODES.includes(speed[flag]) ? speed[flag] : 'off'])),
    min_tier: object(speed.min_tier) ? { ...speed.min_tier } : {},
    ...(object(speed.baseline_store) ? { baseline_store: { ...speed.baseline_store } } : {}),
    ...(object(speed.action_cache_store) ? { action_cache_store: { ...speed.action_cache_store } } : {}),
  };
}
export const speedMode = (policy, flag) => policy?.flags?.[flag] ?? 'off';
export const minTier = (policy, check) => (TIERS.includes(policy?.min_tier?.[check]) ? policy.min_tier[check] : 0);
export const allOff = (policy) => SPEED_FLAGS.every((flag) => speedMode(policy, flag) === 'off');

// The signed plan file of a run: the document lock's `plan` when the run has one, else runs/<id>/test-plan.md.
export function signedPlanFile(runDir) {
  const lockFile = join(runDir, 'docs-lock.json');
  if (existsSync(lockFile)) {
    try {
      const ref = JSON.parse(readFileSync(lockFile, 'utf8')).artifacts?.plan;
      if (typeof ref?.path === 'string') return resolve(runDir, ref.path);
    } catch {}
  }
  return join(runDir, 'test-plan.md');
}

// The speed policy of a run, read from its signed plan. `project` is the folder that holds runs/ (store paths are
// relative to it).
export function runSpeedPolicy(runDir) {
  const file = signedPlanFile(resolve(runDir));
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  const start = text.indexOf('TEAMQA_PLAN_START'), end = text.indexOf('TEAMQA_PLAN_END');
  let value = {};
  if (start >= 0 && end > start) { try { value = JSON.parse(text.slice(start + 'TEAMQA_PLAN_START'.length, end)); } catch { value = {}; } }
  const errors = planSpeedErrors(value.speed);
  if (errors.length) throw Object.assign(new Error(`PLAN_SPEED_INVALID ${errors.join(' ')}`), { code: 'PLAN_SPEED_INVALID' });
  return { version: 1, source: { kind: SPEED_POLICY_SOURCE, sha256: sha256(bytes), path: relative(resolve(runDir), file) }, ...speedOf(value),
    project: dirname(dirname(resolve(runDir))) };
}

// A pinned store of the policy, read and checked against the signed hash. Returns {path, bytes} or throws.
export function pinnedStore(policy, field) {
  const pin = policy?.[field];
  if (!pin) throw Object.assign(new Error(`SPEED_STORE_NOT_PINNED ${field}`), { code: 'SPEED_STORE_NOT_PINNED' });
  const path = resolve(policy.project, pin.path);
  let bytes;
  try { bytes = readFileSync(path); } catch { throw Object.assign(new Error(`SPEED_STORE_MISSING ${pin.path}`), { code: 'SPEED_STORE_MISSING' }); }
  if (sha256(bytes) !== pin.sha256) throw Object.assign(new Error(`SPEED_STORE_DRIFT ${pin.path}: not the store the signed plan pins`), { code: 'SPEED_STORE_DRIFT' });
  return { path, bytes };
}

// QA GUI's board `speedPolicy` (its references/speed-flags.md), or null when every flag is off: a board then carries
// no speed policy and QA GUI grades it exactly as before R3. `storePath` is the in-run copy of the baseline store.
export function boardSpeedPolicy(policy, { storePath = null } = {}) {
  if (!policy || allOff(policy)) return null;
  return {
    version: 1, source: { kind: SPEED_POLICY_SOURCE, sha256: policy.source.sha256 }, flags: { ...policy.flags },
    ...(Object.keys(policy.min_tier ?? {}).length ? { min_tier: { ...policy.min_tier } } : {}),
    ...(storePath && policy.baseline_store ? { baseline_store: { path: storePath, sha256: policy.baseline_store.sha256 } } : {}),
  };
}

// `teamqa speed show --run <id>`.
export function speedShow(runDir) {
  const policy = runSpeedPolicy(runDir);
  const { project, ...shown } = policy;
  return { ...shown, all_off: allOff(policy),
    skips: Object.fromEntries(SPEED_FLAGS.map((flag) => [flag, FLAG_DOCS[flag].skips])),
    always_runs: Object.fromEntries(SPEED_FLAGS.map((flag) => [flag, FLAG_DOCS[flag].always])) };
}
