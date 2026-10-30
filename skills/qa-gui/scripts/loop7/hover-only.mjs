/**
 * V7.3 — detectHoverOnly
 *
 * A phone has no pointer that can hover. So a control the page only ever
 * reveals on hover is, on a phone, a control that does not exist: the user can
 * see the page is missing something and has no gesture that brings it back.
 * That is the whole defect, and it is worth reporting exactly once — for the
 * controls that matter.
 *
 * Four things have to hold before a candidate is that defect:
 *
 *   - the viewport is mobile. Hover-only is not a bug on a desktop pointer; a
 *     desktop row carrying the same markup is reporting a device that can
 *     hover, so it is not a finding at all.
 *   - the control is essential. A decorative tooltip that never appears on a
 *     phone costs the user nothing; flagging it spends the round's credibility
 *     on something nobody was going to tap.
 *   - hover is what reveals it. A menu that opens on an ordinary click was
 *     never gated behind hover, whatever else is true of it.
 *   - and nothing else reveals it. A hover menu that also opens on tap — or on
 *     click — is reachable on the phone by the gesture the phone has. The hover
 *     affordance is then an enhancement, not the only door.
 *
 * The `evidence` field is a placeholder, and null on purpose. This helper is
 * pure: it grades candidates Dragon already collected and performs no browser
 * action, so it has no screenshot to point at. A null placeholder reads as
 * "evidence not attached yet"; a fabricated one would read as proof.
 */

import { viewportProfile } from './responsive-matrix.mjs';

/** The single rule this detector reports. */
const RULE = 'HOVER_ONLY';

/** Hover reveals it — under either of the two names a candidate uses. */
const revealedByHover = (candidate) =>
  candidate.revealedByHover === true || candidate.hoverReveals === true;

/**
 * Some gesture the phone actually has already reaches it.
 *
 * A tap that reveals the control *is* a tap equivalent, so a candidate that
 * only reports `tapReveals` still counts as reachable.
 */
const hasEquivalent = (candidate) =>
  candidate.tapEquivalent === true ||
  candidate.tapReveals === true ||
  candidate.clickEquivalent === true;

/**
 * Find the essential controls that only hover can reach on a mobile viewport.
 *
 * @param {object} input `{viewport, candidates}` — the viewport being measured
 *   and the hover candidates Dragon collected on it
 * @returns {Array<{rule: 'HOVER_ONLY', selector: string, viewport: unknown, evidence: null}>}
 *   one finding per hover-only essential control, in candidate order; empty on
 *   any viewport not proven mobile.
 */
export function detectHoverOnly({ viewport, candidates } = {}) {
  if (viewportProfile(viewport) !== 'mobile') return [];
  if (!Array.isArray(candidates)) return [];

  return candidates
    .filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof candidate.selector === 'string' &&
        candidate.selector !== '' &&
        candidate.essential === true &&
        revealedByHover(candidate) &&
        !hasEquivalent(candidate),
    )
    .map((candidate) => ({
      rule: RULE,
      selector: candidate.selector,
      viewport,
      evidence: null,
    }));
}
