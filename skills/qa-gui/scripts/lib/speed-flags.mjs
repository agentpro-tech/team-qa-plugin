// Speed flags (upgrade R3). Every speed-up that skips work sits behind one of these named flags; each is `off` unless a
// policy written from the signed plan (Team QA) or by the project owner says `shadow` or `on`. The executor never sets a
// flag. `shadow` runs the full path exactly as `off` and only records what the speed-up would have decided, so an eval
// can compare both ways; `on` lets the speed-up skip the work it names. The list, defaults and what each one skips or
// always keeps: references/speed-flags.md.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const SPEED_POLICY_VERSION = 1;
export const SPEED_FLAGS = Object.freeze(['vision_by_diff', 'cost_ladder', 'parallel_gui_lanes', 'fast_click', 'action_cache']);
export const SPEED_MODES = Object.freeze(['off', 'shadow', 'on']);
export const SPEED_POLICY_SOURCES = Object.freeze(['team-qa/signed-plan', 'qa-gui/owner-policy']);

// The cost ladder: a check is settled at the lowest tier that can settle it, never below the minimum tier the signed
// plan sets for it; a tier can only push work up to a higher tier.
export const TIERS = Object.freeze([0, 1, 2, 3]);
export const TIER_NAMES = Object.freeze({ 0: 'machine', 1: 'cheap-model', 2: 'large-model', 3: 'adjudicator-or-human' });
// The checks of a GUI state the ladder knows, and the tier each one runs at today (with every flag off).
export const LADDER_CHECKS = Object.freeze({ gate0: 0, vision: 2, function: 2, verdict: 2 });

export function speedMode(policy, flag) {
  const mode = object(policy) && object(policy.flags) ? policy.flags[flag] : undefined;
  return SPEED_MODES.includes(mode) ? mode : 'off';
}

export function minTier(policy, check) {
  const tier = object(policy) && object(policy.min_tier) ? policy.min_tier[check] : undefined;
  return TIERS.includes(tier) ? tier : 0;
}

// Shape of a speed policy as QA GUI reads it (a board's `speedPolicy`):
//   { version: 1, source: { kind, sha256 }, flags: { <flag>: off|shadow|on }, min_tier: { <check>: 0..3 },
//     baseline_store: { path, sha256 } }
export function speedPolicyErrors(policy) {
  const errors = [];
  if (!object(policy)) return ['SPEED_POLICY_OBJECT_REQUIRED'];
  for (const key of Object.keys(policy)) if (!['version', 'source', 'flags', 'min_tier', 'baseline_store'].includes(key)) errors.push(`SPEED_POLICY_UNKNOWN_FIELD:${key}`);
  if (policy.version !== SPEED_POLICY_VERSION) errors.push('SPEED_POLICY_VERSION');
  const source = policy.source;
  if (!object(source) || !SPEED_POLICY_SOURCES.includes(source.kind) || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')
    || Object.keys(source).some((key) => !['kind', 'sha256'].includes(key))) errors.push('SPEED_POLICY_SOURCE_REQUIRED');
  if (Object.hasOwn(policy, 'flags')) {
    if (!object(policy.flags)) errors.push('SPEED_POLICY_FLAGS');
    else for (const [flag, mode] of Object.entries(policy.flags)) {
      if (!SPEED_FLAGS.includes(flag)) errors.push(`SPEED_FLAG_UNKNOWN:${flag}`);
      else if (!SPEED_MODES.includes(mode)) errors.push(`SPEED_FLAG_MODE:${flag}`);
    }
  }
  if (Object.hasOwn(policy, 'min_tier')) {
    if (!object(policy.min_tier)) errors.push('SPEED_MIN_TIER');
    else for (const [check, tier] of Object.entries(policy.min_tier)) {
      if (!Object.hasOwn(LADDER_CHECKS, check)) errors.push(`SPEED_MIN_TIER_CHECK_UNKNOWN:${check}`);
      else if (!TIERS.includes(tier)) errors.push(`SPEED_MIN_TIER_VALUE:${check}`);
    }
  }
  if (Object.hasOwn(policy, 'baseline_store')) {
    const store = policy.baseline_store;
    if (!object(store) || typeof store.path !== 'string' || !store.path || !/^[a-f0-9]{64}$/.test(store.sha256 ?? '')
      || Object.keys(store).some((key) => !['path', 'sha256'].includes(key))) errors.push('SPEED_BASELINE_STORE');
  }
  return errors;
}
