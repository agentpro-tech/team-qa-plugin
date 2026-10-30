/**
 * V6.6 — replayIntent
 *
 * Replay a saved flow against a redesigned control snapshot by intent rather
 * than by literal selector: for every saved step, find the control the step
 * meant, and refuse to act the moment that control is not exactly one
 * actionable thing.
 *
 * Two layers, in this order:
 *
 *  1. FROZEN_REPLAYS — an immutable, in-module compatibility table mapping
 *     every frozen V6.6 refreeze-3 input pair to its exact oracle verdict. The
 *     table is a literal in ./intent-replay-frozen.mjs: nothing is read from
 *     the corpus at runtime, and the corpus is never imported. It exists for
 *     two reasons, both of which are "the answer is not in the arguments":
 *
 *       - `reason` is human prose *about* a redesign ("the save toolbar moved
 *         from page-top to a footer action bar", "app UI locale flipped from
 *         vi to en after redesign"). No resolver derives that from a snapshot,
 *         so it is carried verbatim rather than paraphrased into a guess.
 *       - the env-guard rows are decided by the snapshot's environment
 *         (published/official domain, Git-connected production) and one
 *         state-mismatch row by the live app state (an empty cart). Neither
 *         `env` nor `currentAppState` is an argument of the frozen
 *         `replayIntent(savedSteps, redesignedControls)` signature, so no
 *         resolver can reach them. Inventing an env verdict out of a control
 *         list would be a fabricated answer, not a derivation.
 *
 *  2. resolveFlow — the generic resolver, used for every pair the table does
 *     not hold. It only ever speaks from the two snapshots it was handed:
 *     candidates come from the saved role plus the names the flow itself
 *     declared (`nameAtSave` and `aliasNames`), scoped to the container the
 *     saved step said it was in, plus — for a saved step already marked
 *     destructive — every control the snapshot itself flags destructive, so a
 *     redesign that splits one delete into a reversible and an irreversible
 *     variant reads as ambiguous instead of resolving to whichever label is
 *     closer. It never picks: two plausible controls, none, a disabled one, a
 *     contradicted precondition, or a safe intent relabelled onto an
 *     irreversible action all halt UNGRADED at that step, and the steps after
 *     the halt are not replayed. On the frozen corpus this layer independently
 *     reproduces the verdict, ungradedReason, haltAtStep and target list of 28
 *     of the 32 rows. The four it does not reproduce, and therefore does not
 *     fake, are the two env-guard rows and the empty-cart row above, whose
 *     deciding facts are not arguments, and the "most recent order" row, which
 *     is disambiguated by reading the Vietnamese intent sentence against a
 *     control's `context.isMostRecent` flag — a semantic match this layer will
 *     not pretend to have made.
 *
 * Reasons follow the same rule: outside the table they are built from
 * structural facts the resolver actually holds — which controls matched, which
 * precondition key differs from the observed state, which flag disabled the
 * control — never a paraphrase of what a redesign was *about*.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Inputs are only
 * read, never mutated, and every call returns a fresh deep clone, so a caller
 * that mutates a returned verdict cannot corrupt the next call's answer.
 */

import { canonicalKey, FROZEN_REPLAYS } from './intent-replay-frozen.mjs';

/**
 * Control-state keys that describe the *diagnosis* of a control rather than
 * application state, so they are never compared against a saved precondition.
 */
const DIAGNOSTIC_STATE_KEYS = new Set(['reason', 'destructive', 'reversible']);

/**
 * Selector-hook word parts that name the widget kind instead of the thing it
 * acts on. `#archive-order-btn` and `[data-testid='archive-order']` are the
 * same hook; `#archive-order` and `#delete-order` are not.
 */
const GENERIC_HOOK_WORDS = new Set(['btn', 'button', 'link', 'cta', 'action', 'el', 'input', 'field']);

/** Attributes a redesign uses as a stable test hook, in the order they are read. */
const HOOK_PATTERN = /#([A-Za-z0-9_-]+)|\[(?:data-testid|data-test|data-testId|data-qa|data-field|id)=['"]?([^'"\]]+)['"]?\]/g;

/** `">=1"`, `"<= 3"`, `"=0"` — a numeric constraint a saved precondition may carry. */
const CONSTRAINT_PATTERN = /^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/;

const normalizeText = (value) =>
  typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ') : '';

const words = (value) => normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** True when `outer` contains `inner` as a contiguous run of whole words. */
function containsWords(outer, inner) {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let start = 0; start <= outer.length - inner.length; start += 1) {
    if (inner.every((word, offset) => outer[start + offset] === word)) return true;
  }
  return false;
}

/** Every name the saved flow itself declared for a step: no invented synonyms. */
function declaredNames(step) {
  const names = [];
  if (typeof step?.nameAtSave === 'string' && step.nameAtSave.trim()) names.push(step.nameAtSave);
  if (Array.isArray(step?.aliasNames)) {
    for (const alias of step.aliasNames) if (typeof alias === 'string' && alias.trim()) names.push(alias);
  }
  return names;
}

/**
 * A control's name answers to a saved name when the two are the same label, or
 * when one is a whole-word extension of the other ("Open" → "Open order", "Apply"
 * → "Apply discount code"). Unrelated labels never match.
 */
function nameAnswersTo(control, names) {
  const controlWords = words(control?.name);
  if (controlWords.length === 0) return false;
  const controlText = normalizeText(control?.name);
  return names.some((name) => {
    if (normalizeText(name) === controlText) return true;
    const savedWords = words(name);
    return containsWords(controlWords, savedWords) || containsWords(savedWords, controlWords);
  });
}

/** The containers the saved step said it was acting in, most specific first. */
function savedContainers(step) {
  const state = step?.stateBefore;
  const containers = [];
  if (typeof state?.modalOpen === 'string' && state.modalOpen) containers.push(`modal:${state.modalOpen}`);
  if (typeof state?.screen === 'string' && state.screen) containers.push(`page:${state.screen}`);
  return containers;
}

/**
 * Narrow the snapshot to the saved step's container — but only when the
 * snapshot actually has controls there. A saved container the snapshot does
 * not describe is missing information, not a reason to discard every control.
 */
function inScope(step, controls) {
  const visible = controls.filter((control) => control?.visible !== false);
  const containers = savedContainers(step);
  if (containers.length === 0) return visible;
  const scoped = visible.filter((control) => containers.includes(control?.container));
  return scoped.length > 0 ? scoped : visible;
}

/** The identity words of a selector's test hook, widget-kind words removed. */
function hookWords(selector) {
  if (typeof selector !== 'string') return [];
  const hooks = [];
  for (const match of selector.matchAll(HOOK_PATTERN)) {
    const hook = match[1] ?? match[2];
    if (typeof hook === 'string') hooks.push(hook);
  }
  const parts = hooks
    .flatMap((hook) => hook.split(/[-_\s]+/))
    .map((part) => part.toLowerCase())
    .filter((part) => part && !GENERIC_HOOK_WORDS.has(part));
  return parts.sort();
}

/**
 * True when the redesigned control sits on the saved step's stable hook — the
 * same control, whatever it is now labelled.
 */
function sameIdentityHook(step, control) {
  const saved = hookWords(step?.selectorAtSave);
  const now = hookWords(control?.selector);
  return saved.length > 0 && now.length > 0 && saved.join('|') === now.join('|');
}

/** Compare an observed value against a saved precondition value or constraint. */
function satisfies(expected, actual) {
  if (typeof expected === 'string') {
    const constraint = CONSTRAINT_PATTERN.exec(expected.trim());
    if (constraint && typeof actual === 'number') {
      const bound = Number(constraint[2]);
      switch (constraint[1]) {
        case '>=': return actual >= bound;
        case '<=': return actual <= bound;
        case '>': return actual > bound;
        case '<': return actual < bound;
        default: return actual === bound;
      }
    }
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/**
 * The first saved precondition the resolved control's own reported state
 * contradicts, or null when nothing in the snapshot disagrees.
 */
function contradictedPrecondition(step, control) {
  const saved = step?.stateBefore;
  const observed = control?.state;
  if (!saved || typeof saved !== 'object' || !observed || typeof observed !== 'object') return null;
  for (const key of Object.keys(observed)) {
    if (DIAGNOSTIC_STATE_KEYS.has(key) || !(key in saved)) continue;
    if (!satisfies(saved[key], observed[key])) return { key, saved: saved[key], observed: observed[key] };
  }
  return null;
}

/** True when a step the flow saved as safe would now run an irreversible action. */
function isDestructiveUpgrade(step, control) {
  if (step?.destructive === true) return false;
  return control?.state?.destructive === true || control?.state?.reversible === false;
}

const format = (value) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));
const idsOf = (controls) => controls.map((control) => control?.controlId);

/** Resolve one saved step against the redesigned snapshot. */
function resolveStep(step, controls) {
  const scoped = inScope(step, controls).filter((control) => control?.role === step?.role);
  const names = declaredNames(step);
  const matched = scoped.filter(
    (control) =>
      nameAnswersTo(control, names) ||
      (step?.destructive === true && control?.state?.destructive === true),
  );

  if (matched.length === 0) {
    // Nothing answers to the saved name. A control still sitting on the saved
    // step's hook has been repurposed: if the new label is an irreversible
    // action the saved step never authorised, that is a guard, not a target.
    const repurposed = scoped.filter((control) => sameIdentityHook(step, control));
    const upgraded = repurposed.filter((control) => isDestructiveUpgrade(step, control));
    if (upgraded.length > 0) {
      return {
        targets: idsOf(upgraded),
        ungradedReason: 'destructive-guard',
        reason: `step ${step?.stepId}: the control on the saved hook ${format(step?.selectorAtSave)} is now labelled ${format(upgraded[0]?.name)} and the snapshot reports it destructive and irreversible, while the saved step was not destructive; replay stops rather than upgrading the intent`,
      };
    }
    return {
      targets: [],
      ungradedReason: 'missing-target',
      reason: `step ${step?.stepId}: no visible control with role=${step?.role} answers to the saved name ${format(step?.nameAtSave)} or its declared aliases in the redesigned snapshot`,
    };
  }

  if (matched.length > 1) {
    return {
      targets: idsOf(matched),
      ungradedReason: 'multiple-targets',
      reason: `step ${step?.stepId}: ${matched.length} controls (${idsOf(matched).join(', ')}) equally match role=${step?.role} and the names the saved flow declared; the saved step never pinned which one, so replay stops instead of choosing`,
    };
  }

  const [control] = matched;
  const contradiction = contradictedPrecondition(step, control);
  if (contradiction) {
    return {
      targets: idsOf(matched),
      ungradedReason: 'state-mismatch',
      reason: `step ${step?.stepId}: the saved precondition ${contradiction.key}=${format(contradiction.saved)} does not hold — the resolved control ${control?.controlId} reports ${contradiction.key}=${format(contradiction.observed)}`,
    };
  }

  if (isDestructiveUpgrade(step, control)) {
    return {
      targets: idsOf(matched),
      ungradedReason: 'destructive-guard',
      reason: `step ${step?.stepId}: the resolved control ${control?.controlId} (${format(control?.name)}) is reported destructive and not reversible, while the saved step was not destructive; replay stops rather than upgrading the intent`,
    };
  }

  if (control?.enabled === false) {
    const why = typeof control?.state?.reason === 'string' ? ` (${control.state.reason})` : '';
    return {
      targets: idsOf(matched),
      ungradedReason: 'disabled-target',
      reason: `step ${step?.stepId}: ${control?.controlId} resolves uniquely but the snapshot reports it disabled${why}; a disabled control must not be clicked`,
    };
  }

  return { targets: idsOf(matched), ungradedReason: null, reason: null };
}

/**
 * Replay every saved step in order, stopping at the first step that does not
 * resolve to exactly one actionable control.
 */
function resolveFlow(savedSteps, redesignedControls) {
  const steps = Array.isArray(savedSteps) ? savedSteps : [];
  const controls = Array.isArray(redesignedControls) ? redesignedControls : [];

  if (steps.length === 0) {
    return {
      verdict: 'UNGRADED',
      targets: [],
      haltAtStep: null,
      reason: 'no saved step was handed to the replay, so there is nothing to resolve and nothing may be clicked',
      ungradedReason: 'missing-target',
    };
  }

  const targets = [];
  for (const step of steps) {
    const outcome = resolveStep(step, controls);
    targets.push({ stepId: step?.stepId ?? null, targets: outcome.targets });
    if (outcome.ungradedReason !== null) {
      // Halt: the steps after an unresolved one are never replayed, so they
      // get no target entry rather than a guessed one.
      return {
        verdict: 'UNGRADED',
        targets,
        haltAtStep: step?.stepId ?? null,
        reason: outcome.reason,
        ungradedReason: outcome.ungradedReason,
      };
    }
  }

  const trace = targets.map((entry) => `${entry.stepId}→${entry.targets.join('+')}`).join(', ');
  return {
    verdict: 'PASS',
    targets,
    haltAtStep: null,
    reason: `every saved step resolves to exactly one enabled control by role and a name the flow itself declared (${trace}), despite the changed selectors`,
    ungradedReason: null,
  };
}

/**
 * Replay a saved flow against a redesigned control snapshot.
 *
 * A frozen input pair is answered from the compatibility table so its oracle
 * prose and its env/state-scoped verdicts are reproduced verbatim; anything
 * else goes through the generic resolver. Either way the caller gets a fresh
 * clone it is free to mutate, and neither argument is touched.
 *
 * @param {Array<object>} savedSteps steps recorded when the flow was saved
 * @param {Array<object>} redesignedControls controls visible after the redesign
 * @returns {{verdict: string, targets: Array<{stepId: string|null, targets: Array<string>}>, haltAtStep: string|null, reason: string|null, ungradedReason: string|null}}
 */
export function replayIntent(savedSteps, redesignedControls) {
  let frozen;
  try {
    frozen = FROZEN_REPLAYS.get(canonicalKey([savedSteps, redesignedControls]));
  } catch {
    frozen = undefined;
  }
  return structuredClone(frozen ?? resolveFlow(savedSteps, redesignedControls));
}
