// bbox.mjs — V8.1 selector-backed bbox attachment.
//
// A finding only earns a bbox when a measurement actually measured its selector on the page.
// Everything else is reported as a reason, never as a guessed rectangle: an unlocatable element,
// a finding that has no element at all and a rectangle the browser could not express are three
// different misses, and each one stays visible to the reader instead of being smoothed over.

const BBOX_UNIT = 'css-px';

/** Reasons a finding carries no bbox.  The vocabulary is frozen by the Wave 1 contract. */
export const BBOX_REASONS = Object.freeze({
  ELEMENT_NOT_FOUND: 'element-not-found',
  NON_ELEMENT_FINDING: 'non-element-finding',
  INVALID_RECT: 'invalid-rect',
});

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The selector a finding points at.  Gate-0 issues name it `sel` and normalized findings name it
 * `selector`; both are the same claim about the page, so both are honoured.
 */
function selectorOf(finding) {
  for (const candidate of [finding?.selector, finding?.sel]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

/**
 * A device pixel ratio is only usable when it is a finite positive scale.  A bbox without a real
 * scale cannot be drawn or compared later, so callers get `invalid-rect` rather than a default of 1.
 */
function normalizeDpr(value) {
  const dpr = Number(value);
  return Number.isFinite(dpr) && dpr > 0 ? dpr : null;
}

/**
 * Copy the measured CSS rectangle verbatim — no rounding, no snapping to device pixels.
 * A fractional layout position is the real position; rounding it here would move the box.
 */
function normalizeRect(rect) {
  if (!isPlainRecord(rect)) return null;
  const x = Number(rect.x ?? rect.left);
  const y = Number(rect.y ?? rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  // A zero or negative box is not a smaller box, it is an unusable measurement.
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/**
 * First measurement whose selector matches exactly.  Matching is exact on purpose: a partial or
 * normalized match would attach one element's geometry to a different element.
 */
function measurementFor(measurements, selector) {
  for (const measurement of measurements) {
    if (isPlainRecord(measurement) && measurement.selector === selector) return measurement;
  }
  return null;
}

/**
 * Attach measured bboxes to findings.
 *
 * Pure and deterministic: the input payload is never mutated, input order and every existing
 * finding field are preserved, and two runs over the same payload are deep-equal.
 *
 * @param {{findings?: unknown[], measurements?: unknown[], dpr?: unknown}} payload
 * @returns {unknown[]} findings, each with exactly one of `bbox` or `bboxReason`
 */
export function attachFindingBboxes(payload = {}) {
  const findings = Array.isArray(payload?.findings) ? payload.findings : [];
  const measurements = Array.isArray(payload?.measurements) ? payload.measurements : [];
  const payloadDpr = normalizeDpr(payload?.dpr);

  return findings.map((finding) => {
    // Anything that is not a finding record is passed through untouched rather than decorated
    // with a verdict we cannot justify.
    if (!isPlainRecord(finding)) return finding;

    // A bbox or reason left over from an earlier pass is dropped, so a stale rectangle can never
    // survive next to a fresh miss.
    const { bbox: _staleBbox, bboxReason: _staleReason, ...rest } = finding;

    const selector = selectorOf(finding);
    if (!selector) return { ...rest, bboxReason: BBOX_REASONS.NON_ELEMENT_FINDING };

    const measurement = measurementFor(measurements, selector);
    if (!measurement) return { ...rest, bboxReason: BBOX_REASONS.ELEMENT_NOT_FOUND };

    const rect = normalizeRect(measurement.rect);
    const dpr = normalizeDpr(measurement.dpr) ?? payloadDpr;
    if (!rect || dpr === null) return { ...rest, bboxReason: BBOX_REASONS.INVALID_RECT };

    return { ...rest, bbox: { ...rect, dpr, unit: BBOX_UNIT } };
  });
}
