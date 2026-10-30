/**
 * V7.2 — the canonical responsive matrix.
 *
 * One matrix, written down once. A responsive round that keeps its sizes in the
 * preflight, its sizes in the rubric and its sizes in the report is not running
 * one matrix at all: the three copies drift, and the round then reports a
 * breakpoint it never measured. So every consumer reads these rows, and nobody
 * re-types them.
 *
 * A row is not a size, it is a device: `w`/`h` say how big the viewport is,
 * `profile` and `dpr` say what kind of device is claiming it. A phone at 320
 * measured as a narrow desktop window is a different page — no touch targets,
 * no mobile layout branch, DPR 1 instead of 3 — so the profile travels with the
 * size rather than being inferred from it downstream.
 *
 * The seven rows are chosen, not sampled:
 *
 *   - phone-320 / phone-360: the two phone widths real traffic actually has.
 *   - desktop-767 / 768 / 769: the breakpoint itself, and one pixel either side
 *     of it. A layout that breaks exactly at `bp` is invisible to a matrix that
 *     only measures `bp`.
 *   - desktop-1280: the ordinary desktop the rest of the taste pass measures at.
 *   - phone-landscape: a phone turned sideways — desktop *width* while still
 *     being a touch device at DPR 3, which is where "wide means desktop"
 *     assumptions fail.
 */

/**
 * The frozen canonical rows. Frozen because a consumer that can edit the matrix
 * in place would silently change what every other consumer measures.
 *
 * @type {ReadonlyArray<{id: string, w: number, h: number, profile: 'mobile'|'desktop', dpr: number}>}
 */
export const RESPONSIVE_MATRIX = Object.freeze([
  Object.freeze({ id: 'phone-320', w: 320, h: 740, profile: 'mobile', dpr: 3 }),
  Object.freeze({ id: 'phone-360', w: 360, h: 800, profile: 'mobile', dpr: 3 }),
  Object.freeze({ id: 'desktop-767', w: 767, h: 800, profile: 'desktop', dpr: 1 }),
  Object.freeze({ id: 'desktop-768', w: 768, h: 800, profile: 'desktop', dpr: 1 }),
  Object.freeze({ id: 'desktop-769', w: 769, h: 800, profile: 'desktop', dpr: 1 }),
  Object.freeze({ id: 'desktop-1280', w: 1280, h: 800, profile: 'desktop', dpr: 1 }),
  Object.freeze({ id: 'phone-landscape', w: 800, h: 360, profile: 'mobile', dpr: 3 }),
]);

/**
 * Read the canonical matrix.
 *
 * @returns {ReadonlyArray<{id: string, w: number, h: number, profile: 'mobile'|'desktop', dpr: number}>}
 *   the same frozen rows as {@link RESPONSIVE_MATRIX}
 */
export function responsiveMatrix() {
  return RESPONSIVE_MATRIX;
}

/** `"360x800"` — the size-only shorthand a report row carries. */
const SIZE = /^(\d+)x(\d+)$/;

/**
 * Which device profile a viewport is claiming.
 *
 * A size alone does not say what device is holding it — the matrix above has a
 * phone at 800 wide (landscape) and a desktop at 767 — so a shorthand is
 * resolved against the rows rather than guessed from a breakpoint. A size that
 * is not a matrix row cannot be proven mobile, and fails closed to `null`
 * instead of being assumed one way.
 *
 * This lives beside the rows for the same reason the rows live in one file: a
 * detector that re-derives "is this a phone?" locally is a second matrix in
 * disguise, and it drifts.
 *
 * @param {unknown} viewport a matrix row, or a `"WxH"` shorthand
 * @returns {'mobile'|'desktop'|null} the proven profile, or null when unproven
 */
export function viewportProfile(viewport) {
  if (typeof viewport === 'string') {
    const size = SIZE.exec(viewport);
    if (size === null) return null;
    const [w, h] = [Number(size[1]), Number(size[2])];
    const row = RESPONSIVE_MATRIX.find((entry) => entry.w === w && entry.h === h);
    return row === undefined ? null : row.profile;
  }

  if (viewport === null || typeof viewport !== 'object') return null;
  if (viewport.profile === 'mobile' || viewport.profile === 'desktop') return viewport.profile;

  const row = RESPONSIVE_MATRIX.find((entry) => entry.w === viewport.w && entry.h === viewport.h);
  return row === undefined ? null : row.profile;
}
