// caption.mjs — V8.3 grounded caption gate.
//
// A caption is the sentence a reader trusts when they cannot re-measure the page themselves, so it
// only earns a PASS when it repeats something the finding actually measured: the exact selector, or
// a number that really appears in the finding's bbox, detail or DPR. A rounded figure, a shortened
// selector or an invented measurement reads as evidence while proving nothing, and the gate treats
// all three as a miss instead of smoothing them over.
//
// The gate grades grounding and shape only. It deliberately does NOT classify which language the
// caption was written in — that is Wave 2 scope, and guessing it here would turn an unbuilt feature
// into a silent answer.

/** Verdicts this gate can return.  The vocabulary is frozen by the Wave 1 contract. */
export const CAPTION_VERDICTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNGRADED: 'UNGRADED',
});

/** A caption carries evidence, consequence and a fix — under one sentence or over three, it stops
 * being a caption and starts being either a label or a paragraph. */
const MIN_SENTENCES = 1;
const MAX_SENTENCES = 3;

/** Sentence terminators, Latin and CJK.  `．` `。` `！` `？` `…` are full stops wherever they land;
 * `.` `!` `?` only close a sentence at end of text or before whitespace, so `3.1`, `.menu` and
 * `object-fit: cover` are not mistaken for boundaries. */
const TERMINATOR_RUN = /[.!?．。！？…]+/gu;
const HARD_TERMINATOR = /[．。！？…]/u;

/** Numeric tokens as a reader would read them: an optional sign, digits, an optional decimal part.
 * Thousands separators are not accepted — `1,000` is two tokens, not one, and the gate would rather
 * miss a grouping style than invent a measurement. */
const NUMERIC_TOKEN = /-?\d+(?:\.\d+)?/g;

/** Characters that continue a selector.  Used to keep `.dialog` from matching inside `.dialog-save`:
 * a prefix of a selector names a different element. */
const SELECTOR_CONTINUATION = /[\w-]/u;

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The selector a finding points at.  Gate-0 issues name it `sel` and normalized findings name it
 * `selector`; both are the same claim about the page, so both are honoured.
 */
function selectorOf(finding) {
  for (const candidate of [finding?.selector, finding?.sel]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Count sentences in a caption.
 *
 * A run of terminators closes at most one sentence (`...` or `?!` is one ending), and a run that
 * closes nothing — a leading `.` on a selector, a decimal point — is skipped rather than counted.
 */
function countSentences(text) {
  TERMINATOR_RUN.lastIndex = 0;
  let sentences = 0;
  let cursor = 0;
  let match;

  while ((match = TERMINATOR_RUN.exec(text)) !== null) {
    const run = match[0];
    const end = match.index + run.length;
    const rest = text.slice(end);
    // A Latin `.`/`!`/`?` glued to the next character is inside a token, not between sentences.
    if (!HARD_TERMINATOR.test(run) && rest && !/^\s/u.test(rest)) continue;
    if (text.slice(cursor, match.index).trim()) sentences += 1;
    cursor = end;
  }

  // Text after the last terminator (or a caption that never terminates) is still a sentence.
  if (text.slice(cursor).trim()) sentences += 1;
  return sentences;
}

function numbersInText(text, into) {
  if (typeof text !== 'string') return;
  NUMERIC_TOKEN.lastIndex = 0;
  let match;
  while ((match = NUMERIC_TOKEN.exec(text)) !== null) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) into.add(value);
  }
}

function numberInto(value, into) {
  const numeric = Number(value);
  if (typeof value === 'number' && Number.isFinite(numeric)) into.add(numeric);
}

/**
 * Numbers a caption is allowed to cite.  The evidence surface is exactly the one the Wave 1
 * contract freezes — the finding's bbox, its `detail` text and its DPR — so a number pulled from
 * anywhere else (or from nowhere at all) stays ungrounded.
 *
 * Values are compared as measured, never rounded: `171` is not the same claim as `170.9609375`.
 */
function groundedNumbers(finding) {
  const numbers = new Set();

  if (isPlainRecord(finding.bbox)) {
    for (const key of ['x', 'y', 'width', 'height', 'dpr']) numberInto(finding.bbox[key], numbers);
  }
  numberInto(finding.dpr, numbers);
  numbersInText(finding.detail, numbers);

  return numbers;
}

/**
 * Does the caption quote the selector verbatim, as a whole selector?
 *
 * Exact on purpose: `.dialog` inside a finding about `.dialog-save` points the reader at a
 * different element, which is worse than pointing at none.
 */
function quotesSelector(caption, selector) {
  if (!selector) return false;
  let from = caption.indexOf(selector);
  while (from !== -1) {
    const before = caption[from - 1];
    const after = caption[from + selector.length];
    const truncated =
      (before !== undefined && SELECTOR_CONTINUATION.test(before)) ||
      (after !== undefined && SELECTOR_CONTINUATION.test(after));
    if (!truncated) return true;
    from = caption.indexOf(selector, from + 1);
  }
  return false;
}

function citesGroundedNumber(caption, numbers) {
  if (numbers.size === 0) return false;
  const cited = new Set();
  numbersInText(caption, cited);
  for (const value of cited) {
    if (numbers.has(value)) return true;
  }
  return false;
}

/**
 * Grade one finding caption.
 *
 * `PASS`   — the caption is 1–3 sentences and repeats measured evidence from the finding.
 * `FAIL`   — the caption is empty, the wrong shape, or grounded in nothing the finding measured.
 * `UNGRADED` — the input itself is unreadable (no caption string, no finding record). This is the
 *              gate declining to answer, not a pass.
 *
 * `language` is accepted so callers can tag the board's language, and is deliberately not graded:
 * detecting or enforcing it is the Wave 2 classifier's job, not this gate's.
 *
 * Pure and deterministic: nothing is mutated and the same input always returns the same verdict.
 *
 * @param {{finding?: unknown, caption?: unknown, language?: unknown}} input
 * @returns {'PASS'|'FAIL'|'UNGRADED'}
 */
export function validateFindingCaption(input = {}) {
  const { finding, caption } = input ?? {};

  // Nothing to read, or nothing to check it against — the gate cannot form a verdict either way.
  if (typeof caption !== 'string') return CAPTION_VERDICTS.UNGRADED;
  if (!isPlainRecord(finding)) return CAPTION_VERDICTS.UNGRADED;

  const text = caption.trim();
  if (!text) return CAPTION_VERDICTS.FAIL;

  const sentences = countSentences(text);
  if (sentences < MIN_SENTENCES || sentences > MAX_SENTENCES) return CAPTION_VERDICTS.FAIL;

  const grounded =
    quotesSelector(text, selectorOf(finding)) || citesGroundedNumber(text, groundedNumbers(finding));

  return grounded ? CAPTION_VERDICTS.PASS : CAPTION_VERDICTS.FAIL;
}
