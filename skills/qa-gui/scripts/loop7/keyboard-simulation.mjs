/**
 * V7.5 — evaluateKeyboardSimulation
 *
 * On a phone the software keyboard takes the bottom of the viewport away while
 * the user is typing. That is the moment the form is actually being used, and
 * it is the one layout nobody looks at: the page is measured at full height,
 * looks fine, and then the keyboard covers the field being typed into or the
 * button that ends the task. Two defects live in that moment, and this helper
 * grades both from a readback taken while the visible height was shrunk:
 *
 *   - KEYBOARD_INPUT_OCCLUDED — the focused field is not fully visible. The
 *     user is typing into something they cannot see.
 *   - KEYBOARD_SUBMIT_UNREACHABLE — the submit control cannot be scrolled to or
 *     clicked. The form can be filled in and not finished.
 *
 * Both are reported when they hold, so a round where the keyboard covers the
 * field *and* strands the button reports two findings rather than the first one
 * found. Input before submit: that is the order the user meets them in.
 *
 * The grade is three-state, and the third state is the point. A round where the
 * visible height never shrank did not simulate a keyboard at all — the
 * viewport-shrink signal is missing, or the environment cannot shrink — and its
 * readback says nothing about what the keyboard covers. Reporting PASS there
 * would claim a check that never ran, and reporting FAIL would invent a defect
 * out of a missing measurement. So the whole simulation returns UNGRADED with
 * `keyboard-sim-unavailable`, and nothing else in the round is graded from it.
 *
 * Everything the grade rests on has to have arrived in the shape it claims: a
 * shrink ratio that is a real fraction of the height, and an explicit boolean
 * for each of the two questions. A `null` where `fullyVisible` belongs is not a
 * visible field and not a hidden one — it is a reading that did not come back,
 * and it is UNGRADED rather than guessed in either direction.
 *
 * The `evidence` field is a placeholder, and both halves are null on purpose.
 * This helper is pure: it grades a readback Dragon already collected and
 * performs no browser action, so it has no before/after pair of its own to
 * point at. A null placeholder reads as "evidence not attached yet"; a
 * fabricated one would read as proof.
 */

import { viewportProfile } from './responsive-matrix.mjs';

/** The single code an ungradeable simulation reports; the gap is always the same one. */
const UNAVAILABLE_CODE = 'keyboard-sim-unavailable';

/** The focused field is under the keyboard. */
const INPUT_OCCLUDED = 'KEYBOARD_INPUT_OCCLUDED';

/** The control that ends the task cannot be reached while typing. */
const SUBMIT_UNREACHABLE = 'KEYBOARD_SUBMIT_UNREACHABLE';

/**
 * A shrink that actually happened.
 *
 * The ratio is how much of the visible height is left once the keyboard is up,
 * so 0.6 is a keyboard taking 40% of the phone. A ratio of 1 is the full-height
 * layout again — the keyboard never opened — and anything at or below 0 is not
 * a height at all. Neither is a simulation, so neither is graded.
 */
const shrank = (ratio) => typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1;

/** A target is only gradeable when it names a node and answers its one question. */
const readable = (target, flag) =>
  target !== null &&
  typeof target === 'object' &&
  typeof target.selector === 'string' &&
  target.selector !== '' &&
  typeof target[flag] === 'boolean';

/**
 * Grade a keyboard simulation from the readback taken while the keyboard was up.
 *
 * @param {object} input `{viewport, canShrink, visibleHeightRatio, focused, submit}` —
 *   the viewport being measured, whether the visible height can shrink at all,
 *   how much of it is left, and the two targets read under the shrunk height
 * @returns {{verdict: 'PASS'|'FAIL', findings: Array<{rule: string, selector: string, viewport: unknown, evidence: {before: null, after: null}}>}
 *   |{verdict: 'UNGRADED', code: string, findings: []}} FAIL with one finding
 *   per defect, PASS with none, or UNGRADED when the simulation could not be
 *   run or did not read back — never a verdict inferred from a missing field.
 */
export function evaluateKeyboardSimulation({
  viewport,
  canShrink,
  visibleHeightRatio,
  focused,
  submit,
} = {}) {
  const unavailable = { verdict: 'UNGRADED', code: UNAVAILABLE_CODE, findings: [] };

  // A software keyboard is a phone. On any viewport not proven mobile there is
  // no keyboard to open, so there is no simulation to grade — not a clean one.
  if (viewportProfile(viewport) !== 'mobile') return unavailable;
  if (canShrink !== true || !shrank(visibleHeightRatio)) return unavailable;
  if (!readable(focused, 'fullyVisible') || !readable(submit, 'reachable')) return unavailable;

  const findings = [];
  const report = (rule, selector) =>
    findings.push({ rule, selector, viewport, evidence: { before: null, after: null } });

  if (!focused.fullyVisible) report(INPUT_OCCLUDED, focused.selector);
  if (!submit.reachable) report(SUBMIT_UNREACHABLE, submit.selector);

  return { verdict: findings.length === 0 ? 'PASS' : 'FAIL', findings };
}
