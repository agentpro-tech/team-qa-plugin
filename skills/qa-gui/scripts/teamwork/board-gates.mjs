// Gates the teamwork canonical runs on top of its JSON schema.
//
// Schema v5 binds defect evidence to the finding it documents: every finding ships the original
// capture and the annotated capture of that same screen. One without the other proves nothing —
// an annotated shot alone cannot be checked against what the screen really showed, and an original
// alone never points at the defect — so the pair is validated, never half-rendered.
//
// Schema v5 also gates the board's human-facing prose against the language the board declares, so
// a reader is never handed a round written in a language they did not ask for. Machine values —
// rule names, selectors, ids, paths, units — are the same words in every language and are never
// gated; the gate reads only the sentences a human wrote.
//
// Schema v5 finally gates the fields that make a round reproducible at all: a case that has been
// run says what was done and what was expected, and a defect says what happened, what should have
// happened, how to reproduce it, and shows the capture. Those are the parts a reader cannot infer.
//
// Schema v4 boards carry no findings and are untouched: these gates only run from v5 up, and the
// fixEvidence workflow (RETEST, history, retest counters) stays a separate lane in canonical.mjs.

/** Canonical schema versions the teamwork board reads. */
export const CANONICAL_SCHEMA_VERSIONS = Object.freeze([4, 5, 6]);

/** The two captures a finding must ship, in render order. */
export const EVIDENCE_ROLES = Object.freeze(['original', 'annotated']);

/** The prose languages the board can grade. Anything else is reported UNGRADED, never PASS. */
export const GATED_LANGUAGES = Object.freeze(['vi', 'en', 'ko', 'ja']);

const FINDING_EVIDENCE_SCHEMA = 5;
const LANGUAGE_GATE_SCHEMA = 5;
const REQUIRED_FIELD_SCHEMA = 5;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEME = /^https?:\/\//i;
const ANNOTATED_SUFFIX = '.annotated.png';

/** Schema v5 and later bind finding evidence; v4 keeps the fixEvidence-only defect shape. */
export function usesFindingEvidence(data) {
  return Number.isInteger(data?.schemaVersion) && data.schemaVersion >= FINDING_EVIDENCE_SCHEMA;
}

/** Schema v5 and later gate prose language; v4 boards are graded exactly as they were. */
export function usesLanguageGate(data) {
  return Number.isInteger(data?.schemaVersion) && data.schemaVersion >= LANGUAGE_GATE_SCHEMA;
}

/** Schema v5 and later require the reproducible-round fields; v4 boards keep their looser shape. */
export function usesRequiredFields(data) {
  return Number.isInteger(data?.schemaVersion) && data.schemaVersion >= REQUIRED_FIELD_SCHEMA;
}

/** A control character would silently truncate or split the rendered `href`. */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * An evidence path is a round-relative file or an explicit http(s) URL. Any other scheme would be
 * smuggled straight into the board's `href`, so it is rejected at the gate instead of rendered.
 */
export function safeEvidencePath(path) {
  if (typeof path !== 'string') return false;
  const value = path.trim();
  if (value.length === 0 || hasControlCharacter(value)) return false;
  return SCHEME.test(value) ? HTTP_SCHEME.test(value) : true;
}

/**
 * A finding earns the paired capture only once a measurement really measured it: the same positive
 * rectangle V8.1 attaches. A finding that carries a `bboxReason` instead has no box to annotate,
 * so demanding an annotated shot of it would demand a picture of nothing.
 */
export function hasMeasuredBbox(finding) {
  const bbox = finding?.bbox;
  if (!bbox || typeof bbox !== 'object' || Array.isArray(bbox)) return false;
  const rect = [bbox.x, bbox.y, bbox.width, bbox.height].map((value) => Number(value));
  return rect.every((value) => Number.isFinite(value)) && rect[2] > 0 && rect[3] > 0;
}

/**
 * Group a defect's evidence by the finding it documents, in findings order, so the gate and the
 * renderer read exactly the same pairing.
 *
 * @param {{findings?: unknown[], evidence?: unknown[]}} defect
 * @returns {Array<{finding: unknown, items: unknown[], original: unknown, annotated: unknown}>}
 */
export function pairFindingEvidence(defect) {
  const evidence = Array.isArray(defect?.evidence) ? defect.evidence : [];
  const findings = Array.isArray(defect?.findings) ? defect.findings : [];
  return findings.map((finding) => {
    const items = evidence.filter((item) => item?.findingId === finding?.id);
    return {
      finding,
      items,
      original: items.find((item) => item?.role === 'original') ?? null,
      annotated: items.find((item) => item?.role === 'annotated') ?? null,
    };
  });
}

/**
 * V8.4: every measured schema-v5 finding owns exactly one original and one annotated image, and
 * the two are distinct files.
 *
 * @param {unknown} data canonical board
 * @returns {Array<{path: string, message: string}>} empty for schema-v4 boards
 */
export function findingEvidenceErrors(data) {
  if (!usesFindingEvidence(data)) return [];
  const errors = [];
  const defects = Array.isArray(data?.defects) ? data.defects : [];

  defects.forEach((defect, index) => {
    const id = defect?.id || 'defect';
    const at = `defects[${index}]`;
    // `findings` is optional — a defect may be reported without a measured finding — but a
    // schema-v5 defect always carries the QA evidence a reader checks it against.
    const findings = Array.isArray(defect?.findings) ? defect.findings : [];
    const evidence = Array.isArray(defect?.evidence) ? defect.evidence : null;
    if (evidence === null || evidence.length === 0) {
      errors.push({ path: `${at}.evidence`, message: `${id} schema-v5 requires at least one QA evidence entry` });
      return;
    }

    const known = new Set();
    for (const finding of findings) {
      if (typeof finding?.id !== 'string') continue;
      if (known.has(finding.id)) errors.push({ path: `${at}.findings`, message: `${id} repeats finding id ${finding.id}` });
      known.add(finding.id);
    }

    evidence.forEach((item, itemIndex) => {
      const where = `${at}.evidence[${itemIndex}]`;
      const name = item?.id || `#${itemIndex}`;
      if (!known.has(item?.findingId)) {
        errors.push({ path: `${where}.findingId`, message: `${id} evidence ${name} points at unknown finding ${item?.findingId ?? '<missing>'}` });
      }
      if (!safeEvidencePath(item?.path)) {
        errors.push({ path: `${where}.path`, message: `${id} evidence ${name} must use a round-relative file or an http(s) URL` });
      } else if (item?.role === 'annotated' && !String(item.path).trim().toLowerCase().endsWith(ANNOTATED_SUFFIX)) {
        errors.push({ path: `${where}.path`, message: `${id} annotated evidence ${name} must be a ${ANNOTATED_SUFFIX} render, not ${String(item.path).trim()}` });
      }
    });

    for (const { finding, items, original, annotated } of pairFindingEvidence(defect)) {
      const label = `${id} finding ${finding?.id || '<missing>'}`;
      for (const role of EVIDENCE_ROLES) {
        const matches = items.filter((item) => item?.role === role);
        // Only a measured box can be annotated; an unmeasured finding is allowed to ship neither.
        if (matches.length === 0 && hasMeasuredBbox(finding)) errors.push({ path: `${at}.evidence`, message: `${label} is missing its ${role} evidence` });
        else if (matches.length > 1) errors.push({ path: `${at}.evidence`, message: `${label} carries ${matches.length} ${role} images; exactly one is allowed` });
      }
      if (original && annotated && original.path === annotated.path) {
        errors.push({ path: `${at}.evidence`, message: `${label} points both roles at ${original.path}; the annotated capture is its own file` });
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------------------------
// V8.5 — prose language gate
// ---------------------------------------------------------------------------------------------

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/g;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾝ]/g;
const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN_LETTER = '[A-Za-z\\u00c0-\\u024f\\u1e00-\\u1eff]';
const LATIN_WORD = new RegExp(`${LATIN_LETTER}+`, 'g');
const ANY_LETTER = new RegExp(`${LATIN_LETTER}|[\\u3040-\\u9fff\\uac00-\\ud7a3\\uf900-\\ufaff]`);
/** The letters Vietnamese orthography adds to plain Latin. Their density is the vi signal. */
const VIETNAMESE_LETTER = /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;

/** Punctuation a sentence wraps a token in. Trimmed before a token is judged machine or prose. */
const EDGE_PUNCTUATION = /^[\s"'“”‘’(\[{«»¿¡]+|[\s"'“”‘’)\]}»,.;:!?…。、，；：！？]+$/g;
/** Characters that only ever appear inside an identifier, selector, path, or expression. */
const IDENTIFIER_CHARACTER = /[._/\\#=<>[\]{}|$@~*+^]/;
/** Measurement words that stay untranslated in every language the board grades. */
const MACHINE_UNITS = new Set(['px', 'em', 'rem', 'ms', 'pt', 'dp', 'vh', 'vw', 'dpr', 'css', 'html', 'json', 'url', 'dom', 'api']);
/** Tag names that are markup, not words a QA engineer would write in a sentence. */
const MACHINE_TAGS = new Set(['div', 'span', 'ul', 'ol', 'li', 'td', 'tr', 'th', 'img', 'nav', 'svg', 'iframe', 'br', 'hr', 'tbody', 'thead', 'textarea', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Below this many words a field is a name or a fragment, not prose the gate can weigh. */
const MIN_GRADED_WORDS = 2;
/** Vietnamese prose carries its diacritics on most syllables; foreign prose carries none. */
const VIETNAMESE_MIN_RATIO = 0.5;
/** A trace of Vietnamese orthography is a loanword; this much of it is Vietnamese prose. */
const FOREIGN_MIN_RATIO = 0.25;
const EXCERPT_LIMIT = 160;

/**
 * A machine value reads the same in every language, so it is lifted out before the prose is
 * weighed: rule names, selectors, paths, ids, numbers, and units.
 */
function isMachineToken(token) {
  if (token.length === 0 || !ANY_LETTER.test(token)) return true;
  if (IDENTIFIER_CHARACTER.test(token)) return true;
  if (/\d/.test(token)) return true;
  if (/^[A-Z][A-Z0-9-]*$/.test(token)) return true;
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(token)) return true;
  const plain = token.toLowerCase();
  return MACHINE_UNITS.has(plain) || MACHINE_TAGS.has(plain);
}

/** The human half of a field: the same string with its machine tokens removed. */
function proseOf(text) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => !isMachineToken(token))
    .join(' ');
}

function countMatches(value, pattern) {
  return (value.match(pattern) || []).length;
}

/**
 * Weigh one field against the language the board declares.
 *
 * The signals are orthographic, not lexical: Hangul, kana, and Han are counted directly, and Latin
 * prose is separated by the density of Vietnamese diacritics. A single borrowed word never moves a
 * field, but a clause written in another language does.
 *
 * @returns {string|null} why the field misses the declared language, or `null` when it matches
 */
function proseMismatch(text, language) {
  const prose = proseOf(text);
  const words = prose.match(LATIN_WORD) || [];
  const hangul = countMatches(prose, HANGUL);
  const kana = countMatches(prose, KANA);
  const han = countMatches(prose, HAN);
  // Nothing but machine values: V8.5 exempts them, so there is no prose to grade.
  if (words.length === 0 && hangul + kana + han === 0) return null;
  const vietnamese = words.filter((word) => VIETNAMESE_LETTER.test(word)).length;
  const vietnameseRatio = words.length === 0 ? 0 : vietnamese / words.length;

  if (language === 'vi') {
    if (hangul + kana + han > 0) return 'it carries Korean, Japanese, or Han script';
    if (words.length >= MIN_GRADED_WORDS && vietnameseRatio < VIETNAMESE_MIN_RATIO) {
      return 'its words carry no Vietnamese orthography';
    }
    return null;
  }
  if (language === 'en') {
    if (hangul + kana + han > 0) return 'it carries Korean, Japanese, or Han script';
    if (vietnameseRatio >= FOREIGN_MIN_RATIO) return 'it reads as Vietnamese prose';
    return null;
  }

  const native = language === 'ko' ? hangul : kana + han;
  const other = language === 'ko' ? kana : hangul;
  const script = language === 'ko' ? 'Hangul' : 'Japanese';
  if (other > 0) return `it carries ${language === 'ko' ? 'Japanese' : 'Korean'} script`;
  if (vietnameseRatio >= FOREIGN_MIN_RATIO) return 'it reads as Vietnamese prose';
  if (native === 0) return `it carries no ${script}`;
  // A sentence in the declared language may quote a foreign word; it may not be one.
  if (native < words.length) return `it is dominated by words outside ${script}`;
  return null;
}

function proseField(fields, path, owner, value) {
  if (typeof value === 'string' && value.trim().length > 0) fields.push({ path, owner, value });
}

/** Every field on the board a human reads as a sentence, in board order. */
function proseFields(data) {
  const fields = [];
  proseField(fields, 'title', 'board', data?.title);

  const cases = Array.isArray(data?.cases) ? data.cases : [];
  cases.forEach((entry, index) => {
    const at = `cases[${index}]`;
    const owner = entry?.id || at;
    proseField(fields, `${at}.title`, owner, entry?.title);
    proseField(fields, `${at}.steps`, owner, entry?.steps);
    proseField(fields, `${at}.expected`, owner, entry?.expected);
    proseField(fields, `${at}.humanSummary.function`, owner, entry?.humanSummary?.function);
    proseField(fields, `${at}.humanSummary.ui`, owner, entry?.humanSummary?.ui);
    const comments = Array.isArray(entry?.comments) ? entry.comments : [];
    comments.forEach((comment, commentIndex) => proseField(fields, `${at}.comments[${commentIndex}].text`, owner, comment?.text));
  });

  const defects = Array.isArray(data?.defects) ? data.defects : [];
  defects.forEach((entry, index) => {
    const at = `defects[${index}]`;
    const owner = entry?.id || at;
    proseField(fields, `${at}.title`, owner, entry?.title);
    proseField(fields, `${at}.repro`, owner, entry?.repro);
    proseField(fields, `${at}.expected`, owner, entry?.expected);
    proseField(fields, `${at}.actual`, owner, entry?.actual);
    const findings = Array.isArray(entry?.findings) ? entry.findings : [];
    findings.forEach((finding, findingIndex) => {
      proseField(fields, `${at}.findings[${findingIndex}].caption`, `${owner} finding ${finding?.id || findingIndex}`, finding?.caption);
    });
    const comments = Array.isArray(entry?.comments) ? entry.comments : [];
    comments.forEach((comment, commentIndex) => proseField(fields, `${at}.comments[${commentIndex}].text`, owner, comment?.text));
  });

  const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
  rounds.forEach((round, index) => proseField(fields, `rounds[${index}].scope`, `round ${round?.round ?? index}`, round?.scope));

  const risks = Array.isArray(data?.release?.risks) ? data.release.risks : [];
  risks.forEach((risk, index) => proseField(fields, `release.risks[${index}]`, 'release', risk));

  return fields;
}

function excerpt(value) {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT - 1)}…` : text;
}

/**
 * V8.5: human-facing prose on a schema-v5 board is written in the language the board declares.
 *
 * A board declaring a language outside {@link GATED_LANGUAGES} cannot be graded at all, so it
 * reports one `ungraded` entry and {@link boardVerdict} answers `UNGRADED` rather than guessing.
 *
 * @param {unknown} data canonical board
 * @returns {Array<{path: string, message: string, ungraded?: boolean}>} empty for schema-v4 boards
 */
export function proseLanguageErrors(data) {
  if (!usesLanguageGate(data)) return [];
  const language = data?.language;
  if (typeof language !== 'string' || !GATED_LANGUAGES.includes(language)) {
    return [{
      path: 'language',
      message: `language-unsupported: prose in ${typeof language === 'string' ? language : '<missing>'} is outside the gated set ${GATED_LANGUAGES.join(', ')}`,
      ungraded: true,
    }];
  }

  const errors = [];
  for (const { path, owner, value } of proseFields(data)) {
    const reason = proseMismatch(value, language);
    if (reason) errors.push({ path, message: `${owner} must write ${path.split('.').at(-1)} in ${language} but ${reason}: "${excerpt(value)}"` });
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// V8.6 — required round fields
// ---------------------------------------------------------------------------------------------

/**
 * The two fields that make a case readable by someone who did not run it: what was done, and what
 * should have happened. A `TODO` case has not been run yet, so it is a plan, not a claim.
 */
const CASE_REQUIRED_FIELDS = Object.freeze([
  { key: 'steps', label: 'the steps it ran' },
  { key: 'expected', label: 'the result it expected' },
]);

/**
 * Three of a defect's four parts. The fourth — at least one QA evidence entry — is already gated
 * for every schema-v5 defect by {@link findingEvidenceErrors}, at the same `defects[n].evidence`
 * path and naming the same defect, so it is not re-reported here.
 */
const DEFECT_REQUIRED_FIELDS = Object.freeze([
  { key: 'actual', label: 'what actually happened' },
  { key: 'expected', label: 'what should have happened' },
  { key: 'repro', label: 'how to reproduce it' },
]);

/** A field of whitespace says nothing a missing field does not; both are absent prose. */
function isBlankProse(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * V8.6: a schema-v5 round carries the prose a reader needs. Every case past `TODO` records its
 * steps and its expected result, and every defect records what happened, what should have
 * happened, and how to reproduce it.
 *
 * Each error names the exact field path and the owning case or defect id, in board order, so two
 * runs over the same board report the same list.
 *
 * @param {unknown} data canonical board
 * @returns {Array<{path: string, message: string}>} empty for schema-v4 boards
 */
export function requiredFieldErrors(data) {
  if (!usesRequiredFields(data)) return [];
  const errors = [];

  const cases = Array.isArray(data?.cases) ? data.cases : [];
  cases.forEach((entry, index) => {
    // A case still in TODO is a plan nobody has executed; V8.6 grades it once it leaves TODO.
    if (entry?.status === 'TODO') return;
    const id = entry?.id || `cases[${index}]`;
    for (const { key, label } of CASE_REQUIRED_FIELDS) {
      if (isBlankProse(entry?.[key])) {
        errors.push({
          path: `cases[${index}].${key}`,
          message: `${id} is ${entry?.status || 'past TODO'} but does not write ${label}; schema-v5 requires a non-blank ${key}`,
        });
      }
    }
  });

  const defects = Array.isArray(data?.defects) ? data.defects : [];
  defects.forEach((entry, index) => {
    const id = entry?.id || `defects[${index}]`;
    for (const { key, label } of DEFECT_REQUIRED_FIELDS) {
      if (isBlankProse(entry?.[key])) {
        errors.push({
          path: `defects[${index}].${key}`,
          message: `${id} does not write ${label}; schema-v5 requires a non-blank ${key}`,
        });
      }
    }
  });

  return errors;
}

/**
 * Grade one validation run for the board scoreboards. A gate that cannot answer must say so
 * rather than pass: only an empty error list is `PASS`, and a run whose every error is an
 * `ungraded` notice is `UNGRADED` — the gate declined to judge, it did not find the board sound.
 */
export function boardVerdict(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'PASS';
  return errors.every((error) => error?.ungraded === true) ? 'UNGRADED' : 'FAIL';
}

// ---------------------------------------------------------------------------------------------
// Vision baseline approval
// ---------------------------------------------------------------------------------------------

/**
 * A first run may store proposed baselines only while the board declares this exact outlook. A
 * proposed baseline is never compared; approval is a separate source-review event by the project
 * owner, and no fixed person is built in.
 */
export const BASELINE_PENDING = 'baseline pending owner approval';
/** When set, an approved baseline's `approvedBy` must equal this value exactly. */
export const BASELINE_APPROVER_ENV = 'QA_GUI_BASELINE_APPROVER';
const BASELINE_APPROVER_MAX_LENGTH = 120;

/** True when the board's outlook or untested list declares the exact pending-approval value. */
export function declaresBaselinePending(data) {
  const values = [...(Array.isArray(data?.outlook) ? data.outlook : []), ...(Array.isArray(data?.untested) ? data.untested : [])];
  return values.some((value) => value === BASELINE_PENDING || (value && typeof value === 'object' && Object.values(value).includes(BASELINE_PENDING)));
}

/**
 * `null` when `approvedBy` names an acceptable approver, otherwise the reason it does not. An
 * approver is a non-empty, already-trimmed string of at most 120 characters; when
 * QA_GUI_BASELINE_APPROVER is set, it must also equal that value exactly.
 */
export function baselineApproverError(approvedBy, env = globalThis.process?.env ?? {}) {
  if (typeof approvedBy !== 'string' || approvedBy === '' || approvedBy !== approvedBy.trim()
    || approvedBy.length > BASELINE_APPROVER_MAX_LENGTH) return 'approvedBy must name the approving owner';
  const required = env?.[BASELINE_APPROVER_ENV];
  if (required !== undefined && approvedBy !== required) return `approvedBy must be ${required}`;
  return null;
}
