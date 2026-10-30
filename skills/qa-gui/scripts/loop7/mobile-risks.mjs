/**
 * V7.4 — detectMobileRisks
 *
 * Seven defects that only exist on a phone, graded from a readback Dragon
 * already collected. Each one is frozen as a rule, and each rule is written so
 * that the thing separating a real finding from its look-alike is stated
 * rather than inferred:
 *
 *   - R1 a text field under 16px. iOS zooms the page in when the user focuses
 *     a field smaller than that, and the zoom does not come back out. Exactly
 *     16 is fine; the boundary is the rule, not a rounding.
 *   - R2 `100vh` where the bottom of the block matters. On a phone `vh` is the
 *     tall viewport, so the browser chrome sits over the last strip of the
 *     block — which is the submit button, or nothing at all if that strip was
 *     decorative. `svh`/`dvh` is the fix, so a block that has one is fine.
 *   - R3 a fixed bar that covers content permanently. A bar the user can
 *     scroll past is an annoyance; a bar that is still there at every scroll
 *     offset has taken the content away.
 *   - R4 two controls closer than 8px. Fingers are not cursors and the wrong
 *     one gets hit — but a paragraph with two links in it is prose, not a
 *     control cluster, and spacing it out would be the defect.
 *   - R5 a fixed bottom bar with no `safe-area-inset-bottom`. The home
 *     indicator sits on top of it, so the bar is partly untappable.
 *   - R6 no viewport meta, or one pinned to a fixed width. The phone then
 *     renders a desktop page scaled down and every other measurement in the
 *     round was taken of the wrong layout.
 *   - R7 body copy under 12px. A caption can be small — that is what a caption
 *     is — but a paragraph at 11px is not readable at arm's length.
 *
 * Two report dialects reach this helper: some rows name a field `fontSizePx`
 * and classify by `kind`, others say `fontSize` and `role`. They describe the
 * same measurement, so both are read. What is *not* inferred is a missing
 * mitigation: a fallback, a scroll recovery or a safe-area inset only clears a
 * finding when the report says it is there. Silence is not proof of a fix.
 *
 * Findings come back rule-major — R1 before R2, and element order inside a
 * rule — so the same input yields the same report every time, whatever order
 * the elements arrived in.
 *
 * The `evidence` field is a placeholder, and null on purpose. This helper is
 * pure: it grades a readback and performs no browser action, so it has no
 * screenshot to point at. A null placeholder reads as "evidence not attached
 * yet"; a fabricated one would read as proof.
 */

import { viewportProfile } from './responsive-matrix.mjs';

/** Below this, iOS zooms on focus and never zooms back out. */
const MIN_FIELD_FONT_PX = 16;

/** Below this, a paragraph is not readable at arm's length. */
const MIN_BODY_FONT_PX = 12;

/** Closer than this, a finger hits the neighbouring control. */
const MIN_CONTROL_GAP_PX = 8;

/** Where a viewport-meta defect is reported when the tag itself was read. */
const META_SELECTOR = 'meta[name="viewport"]';

/** Where it is reported when only the head content came back — or nothing. */
const HEAD_SELECTOR = 'head';

/** `width=device-width`, in a comma- or semicolon-separated content string. */
const DEVICE_WIDTH = /(^|[;,\s])width\s*=\s*device-width\s*($|[;,])/i;

/** `width=980` — a layout pinned to a width the phone does not have. */
const FIXED_WIDTH = /(^|[;,\s])width\s*=\s*\d/i;

/** What an element calls itself, under either dialect's field name. */
const kindOf = (element) =>
  typeof element.kind === 'string' ? element.kind : typeof element.role === 'string' ? element.role : '';

/** The first field that actually carries a number, or undefined. */
const measure = (...values) => values.find((value) => typeof value === 'number' && Number.isFinite(value));

/** A mitigation counts only when the report says it is present. */
const proven = (...values) => values.some((value) => value === true);

/** Fixed to the viewport — by `kind`, or by an explicit CSS position. */
const isFixed = (element) => kindOf(element) === 'fixed-bar' || element.position === 'fixed';

/** Fixed to the bottom edge specifically, which is where the inset matters. */
const isFixedBottom = (element) =>
  kindOf(element) === 'fixed-bottom' || (element.position === 'fixed' && element.edge === 'bottom');

/** Prose, not a control cluster: two links in a sentence are meant to be close. */
const isInlineText = (element) => proven(element.inlineTextLink, element.inlineTextLinks);

/** A caption is allowed to be small; a paragraph is not. */
const isShortText = (element) => kindOf(element) === 'caption' || proven(element.shortCaption);

/**
 * The six element-scoped rules, in report order.
 *
 * Each predicate reads a single element and answers one question only, so a
 * row that trips two rules is reported twice — once per defect — rather than
 * collapsed into whichever rule happened to run first.
 */
const ELEMENT_RULES = [
  {
    rule: 'R1',
    hit: (element) => {
      const kind = kindOf(element);
      if (kind !== 'input' && kind !== 'textarea') return false;
      const font = measure(element.fontSizePx, element.fontSize);
      return font !== undefined && font < MIN_FIELD_FONT_PX;
    },
  },
  {
    rule: 'R2',
    hit: (element) => {
      const height = element.heightUnit ?? element.height;
      return (
        height === '100vh' &&
        proven(element.bottomCritical) &&
        !proven(element.hasDynamicViewportFallback, element.hasDynamicViewportUnits)
      );
    },
  },
  {
    rule: 'R3',
    hit: (element) =>
      isFixed(element) &&
      proven(element.permanentlyOccludes) &&
      !proven(element.scrollRecovers, element.scrollCanRecover),
  },
  {
    rule: 'R4',
    hit: (element) => {
      const gap = measure(element.gapToNextPx, element.adjacentControlGap);
      return gap !== undefined && gap < MIN_CONTROL_GAP_PX && !isInlineText(element);
    },
  },
  {
    rule: 'R5',
    hit: (element) =>
      isFixedBottom(element) &&
      !proven(element.usesSafeAreaInsetBottom, element.hasSafeAreaInsetBottom),
  },
  {
    rule: 'R7',
    hit: (element) => {
      if (kindOf(element) !== 'body-text') return false;
      const font = measure(element.fontSizePx, element.fontSize);
      return font !== undefined && font < MIN_BODY_FONT_PX && !isShortText(element);
    },
  },
];

/**
 * Read whatever the report says about the viewport meta tag.
 *
 * Two dialects again: a content string (or null, when there was no tag), and a
 * structured `{present, fixedWidth}` reading of the tag itself. They differ in
 * what can be pointed at — a structured reading found a node, a bare string is
 * all that came back from the head — so the selector follows the dialect
 * rather than being invented.
 *
 * @param {unknown} viewportMeta the content string, or a structured reading
 * @returns {{selector: string, sound: boolean}} where to report, and whether
 *   the tag lets the phone lay the page out at its own width
 */
function readViewportMeta(viewportMeta) {
  if (typeof viewportMeta === 'string') {
    return {
      selector: HEAD_SELECTOR,
      sound: DEVICE_WIDTH.test(viewportMeta) && !FIXED_WIDTH.test(viewportMeta),
    };
  }

  if (viewportMeta === null || typeof viewportMeta !== 'object') {
    return { selector: HEAD_SELECTOR, sound: false };
  }

  if (viewportMeta.present === false || viewportMeta.fixedWidth === true) {
    return { selector: META_SELECTOR, sound: false };
  }
  if (typeof viewportMeta.content === 'string') {
    return {
      selector: META_SELECTOR,
      sound: DEVICE_WIDTH.test(viewportMeta.content) && !FIXED_WIDTH.test(viewportMeta.content),
    };
  }
  return { selector: META_SELECTOR, sound: viewportMeta.present === true };
}

/**
 * Grade a mobile readback against the seven frozen rules.
 *
 * @param {object} input `{viewport, viewportMeta, elements}` — the viewport
 *   being measured, what the head says about it, and the elements Dragon read
 *   on it
 * @returns {Array<{rule: string, selector: string, viewport: unknown, evidence: null}>}
 *   one finding per defect, rule-major then element order; empty on any
 *   viewport not proven mobile, because none of these are defects elsewhere.
 */
export function detectMobileRisks({ viewport, viewportMeta, elements } = {}) {
  if (viewportProfile(viewport) !== 'mobile') return [];

  const rows = (Array.isArray(elements) ? elements : []).filter(
    (element) =>
      element !== null &&
      typeof element === 'object' &&
      typeof element.selector === 'string' &&
      element.selector !== '',
  );

  const findings = [];
  const report = (rule, selector) => findings.push({ rule, selector, viewport, evidence: null });

  for (const { rule, hit } of ELEMENT_RULES) {
    for (const element of rows) {
      if (hit(element)) report(rule, element.selector);
    }
  }

  const meta = readViewportMeta(viewportMeta);
  if (!meta.sound) report('R6', meta.selector);

  // Rule-major, element order preserved inside a rule: the rule ids are single
  // digits, so an ordinary stable sort on them is the whole ordering.
  findings.sort((a, b) => a.rule.localeCompare(b.rule));
  return findings;
}
