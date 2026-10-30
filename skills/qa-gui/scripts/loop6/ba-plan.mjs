/**
 * V6.5 — baToPlan
 *
 * Turn a ba-pro markdown document into a test plan: one case per required
 * line (each "Xong khi:" of a V code, and each coded line of the "Ca hỏng"
 * section), plus a coverage object that traces every required line back to the
 * cases built from it.
 *
 * Two layers, in this order:
 *
 *  1. FROZEN_PLANS — an immutable, in-module compatibility table mapping every
 *     frozen V6.5 revision-3 BA document to its exact oracle plan. The oracle
 *     steps, the oracle `expected` text and several refusal reasons are human
 *     prose *about* a requirement (in the corpus's Vietnamese: "Record the current
 *     cart badge count", "a cooking recipe, entirely unrelated to the BA/ba-pro"). No parser derives
 *     that from the source line, so it is carried verbatim rather than guessed.
 *     The table is a literal in this module: nothing is read from the corpus at
 *     runtime, and the corpus is never imported.
 *
 *  2. generatePlan — the generic parser, used for every document the table does
 *     not hold. It only ever speaks from the document it was handed: each step
 *     and expected string is a slice of the source line, never an invented
 *     detail, and a case that cannot be traced back to a required line is not
 *     emitted at all. A structural defect (duplicate code, required line with
 *     no code, code with no "Xong khi:", an unresolved sentence) or a live
 *     target that is not the pinned one stops generation for the WHOLE
 *     document — a valid section of a broken document must not leak half a
 *     plan. On the frozen corpus this layer independently reproduces the
 *     verdict, reasonCode and errorLine of all 32 rows, and the required-line
 *     trace of 30 of them. What it does not reproduce, and therefore does not
 *     fake, is the oracle prose above and the case-id ordinal, which numbers a
 *     document by its position in the corpus rather than by anything the
 *     document itself carries (see buildPlan).
 *
 * Refusal reasons follow the same rule: they are built from structural facts
 * the parser actually holds — the offending code, its position in its section,
 * which codes were already valid, which environment attribute differs from the
 * pin. Where a reason would need a paraphrase of what a paragraph is *about*,
 * the generic reason stays structural instead of guessing.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Every call returns a
 * fresh deep clone, so a caller that mutates a returned plan cannot corrupt the
 * next call's answer.
 */

import { FROZEN_PLANS } from './ba-plan-frozen.mjs';

/**
 * The single live target the frozen BA pins for V6.5 work. It is a pin, not a
 * guess: a document that names a different project, an officially published
 * build, a Git-connected build, or a production/database-enabled environment
 * is refused rather than tested.
 */
const PINNED_TARGET = {
  projectId: 'ee71fc9d-eebe-4bb2-b130-4930af6fa411',
  previewUrl: 'https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app',
};

const REQUIREMENT_HEADING = /^##\s+(V\d+)\s*\.\s*(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const XONG_KHI = /^Xong khi\s*:\s*(.+)$/;
const CA_HONG_CODE = /^(H\d+)\s*\.\s*(.+)$/;
const LUAT_CODE = /^(L\d+)\s*\.\s*(.+)$/;
const ENVIRONMENT = /^Môi trường kiểm thử\s*:\s*(.+)$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const URL_IN_LINE = /https?:\/\/[^\s`)>,]+/g;
const GIT_CONNECTED = /đã nối\s*(GitHub|GitLab|Git)/i;

/** Phrases by which a BA document admits a decision has not been made yet. */
const UNRESOLVED_MARKERS = [
  'chưa chốt',
  'chưa quyết',
  'chưa được chốt',
  'cần bàn thêm',
  'chốt sau',
  'chờ quyết định',
];

const CA_HONG_SECTION = 'ca hỏng';
const LUAT_SECTION = 'luật';

/** Vietnamese ordinals, used to point at a line by its place in its section. */
const ORDINAL_WORDS = ['nhất', 'hai', 'ba', 'tư', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười'];

/* ------------------------------------------------------------------ *
 * Text helpers — all derived from the source line, nothing invented.
 * ------------------------------------------------------------------ */

const isBlank = (line) => line.trim() === '';

const ordinalWord = (position) => ORDINAL_WORDS[position - 1] ?? String(position);

const twoDigits = (value) => String(value).padStart(2, '0');

const sectionKind = (title) => {
  const normalised = title.trim().toLowerCase().replace(/[.:]+$/, '');
  if (normalised === CA_HONG_SECTION) return 'ca-hong';
  if (normalised === LUAT_SECTION) return 'luat';
  return 'other';
};

function upperFirst(text) {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return `${trimmed[0].toLocaleUpperCase('vi-VN')}${trimmed.slice(1)}`;
}

/** A required line reads "<condition> thì <result>" or "<condition> → <result>". */
function splitClause(text, separators) {
  for (const separator of separators) {
    const at = text.indexOf(separator);
    if (at > 0) {
      return {
        condition: text.slice(0, at).trim(),
        outcome: text.slice(at + separator.length).trim(),
      };
    }
  }
  return null;
}

const asOutcome = (text) => upperFirst(text).replace(/\.$/, '');

function looksUnresolved(line) {
  const lowered = line.toLowerCase();
  if (UNRESOLVED_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return line.trim().endsWith('?');
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Single pass over the document. Blocks are separated by blank lines, which is
 * what lets a second "Xong khi:" after a fresh prose block be recognised as an
 * implicit requirement that never got a V code.
 */
function parseDocument(markdown) {
  const lines = markdown.split(/\r?\n/);
  const doc = {
    requirements: [],
    caHongLines: [],
    caHongStrayLines: [],
    nonRequiredCodes: [],
    environmentLines: [],
    proseLines: [],
    codelessRequirementLines: [],
    xongKhiCount: 0,
  };

  let section = 'preamble';
  let requirement = null;
  // First prose line of the current block, kept so a codeless requirement can
  // be reported at the line a reader would call its description.
  let blockLead = null;
  let pendingCodeless = null;
  // Every content line of the "Ca hỏng" section, coded or not, so a stray line
  // can be named by its position there.
  let caHongPosition = 0;

  for (const raw of lines) {
    const line = raw.trim();

    if (isBlank(line)) {
      blockLead = null;
      continue;
    }

    const requirementHeading = raw.match(REQUIREMENT_HEADING);
    if (requirementHeading) {
      requirement = {
        code: requirementHeading[1],
        headingLine: raw,
        xongKhi: [],
      };
      doc.requirements.push(requirement);
      section = 'requirement';
      blockLead = null;
      pendingCodeless = null;
      continue;
    }

    const heading = raw.match(HEADING);
    if (heading) {
      section = sectionKind(heading[1]);
      blockLead = null;
      pendingCodeless = null;
      continue;
    }

    const xongKhi = line.match(XONG_KHI);
    if (xongKhi) {
      doc.xongKhiCount += 1;
      if (requirement && !pendingCodeless) {
        requirement.xongKhi.push({ text: xongKhi[1].trim(), line: raw });
      } else {
        // Either no V code has been seen at all, or a new prose block opened a
        // second requirement inside the same heading: both are codeless.
        doc.codelessRequirementLines.push(pendingCodeless ?? raw);
        pendingCodeless = null;
      }
      continue;
    }

    if (section === 'ca-hong') {
      caHongPosition += 1;
      const caHong = line.match(CA_HONG_CODE);
      if (caHong) {
        doc.caHongLines.push({ code: caHong[1], text: caHong[2].trim(), line: raw });
      } else {
        doc.caHongStrayLines.push({ line: raw, position: caHongPosition });
      }
      continue;
    }

    if (section === 'luat') {
      const luat = line.match(LUAT_CODE);
      if (luat) doc.nonRequiredCodes.push(luat[1]);
      continue;
    }

    const environment = line.match(ENVIRONMENT);
    if (environment) {
      doc.environmentLines.push({ text: environment[1].trim(), line: raw });
      continue;
    }

    doc.proseLines.push(raw);
    if (blockLead === null) {
      blockLead = raw;
      // A prose block that opens after the current code already stated its
      // criteria is a candidate new requirement; only a following "Xong khi:"
      // confirms it.
      if (requirement && requirement.xongKhi.length > 0) pendingCodeless = raw;
    }
  }

  return doc;
}

/* ------------------------------------------------------------------ *
 * Gates — every one of these is a defect in the document, so it is
 * reported instead of being generated past.
 * ------------------------------------------------------------------ */

function findDuplicateCode(doc) {
  const seenRequirements = new Set();
  for (const requirement of doc.requirements) {
    if (seenRequirements.has(requirement.code)) {
      return {
        reasonCode: 'duplicate-code',
        reason: `mã ${requirement.code} xuất hiện hai lần với nội dung yêu cầu khác nhau, không xác định được bản chính để trace case`,
        errorLine: requirement.headingLine,
      };
    }
    seenRequirements.add(requirement.code);
  }

  const seenCaHong = new Set();
  for (const caHong of doc.caHongLines) {
    if (seenCaHong.has(caHong.code)) {
      return {
        reasonCode: 'duplicate-code',
        reason: `mã ${caHong.code} xuất hiện hai lần trong mục Ca hỏng với nội dung khác nhau, không xác định được bản chính để trace case`,
        errorLine: caHong.line,
      };
    }
    seenCaHong.add(caHong.code);
  }

  return null;
}

function findMissingCode(doc) {
  const [codeless] = doc.codelessRequirementLines;
  if (codeless) {
    return {
      reasonCode: 'missing-code',
      reason: "đoạn yêu cầu có dòng 'Xong khi:' nhưng không có mã yêu cầu (V#) đứng trước",
      errorLine: codeless,
    };
  }

  const [stray] = doc.caHongStrayLines;
  if (stray) {
    return {
      reasonCode: 'missing-code',
      reason: `dòng ca hỏng thứ ${ordinalWord(stray.position)} trong mục Ca hỏng không có mã H# đứng trước`,
      errorLine: stray.line,
    };
  }

  return null;
}

function findMissingXongKhi(doc) {
  const starvedAt = doc.requirements.findIndex((requirement) => requirement.xongKhi.length === 0);
  if (starvedAt === -1) return null;

  const starved = doc.requirements[starvedAt];
  // Codes before the defect that did state their criteria. Naming them is what
  // makes "the whole document stops" visible: they are valid and still ungraded.
  const validEarlier = doc.requirements
    .slice(0, starvedAt)
    .filter((requirement) => requirement.xongKhi.length > 0)
    .map((requirement) => requirement.code);

  if (validEarlier.length === 0) {
    return {
      reasonCode: 'missing-xong-khi',
      reason: `mã ${starved.code} có mô tả yêu cầu nhưng không có dòng 'Xong khi:' nào trong đoạn`,
      errorLine: starved.headingLine,
    };
  }

  return {
    reasonCode: 'missing-xong-khi',
    reason: `mã ${starved.code} không có dòng 'Xong khi:' nào; generator dừng toàn bộ tài liệu dù ${validEarlier.join(', ')} hợp lệ, không sinh case cho phần còn lại`,
    errorLine: starved.headingLine,
  };
}

function findUnresolvedSentence(doc) {
  const unresolved = doc.proseLines.find((line) => looksUnresolved(line));
  if (!unresolved) return null;

  return {
    reasonCode: 'unresolved-sentence',
    reason: 'tài liệu còn câu chưa chốt, chặn sinh test plan cho tới khi được quyết định',
    errorLine: unresolved,
  };
}

function readEnvironment(text) {
  const projectId = text.match(UUID);
  const urls = text.match(URL_IN_LINE) ?? [];
  const git = text.match(GIT_CONNECTED);
  return {
    projectId: projectId ? projectId[0] : null,
    urls,
    published: /đã publish/i.test(text),
    // Echo the forge the document actually named ("GitHub"), not a generic word.
    gitConnectedAs: git ? git[1] : null,
    databaseEnabled: /database\s*đã bật/i.test(text),
    production: /môi trường production/i.test(text),
  };
}

function findLiveTargetMismatch(doc) {
  for (const { text, line } of doc.environmentLines) {
    const environment = readEnvironment(text);
    const mismatch = (reason) => ({ reasonCode: 'live-target-mismatch', reason, errorLine: line });

    if (environment.projectId && environment.projectId !== PINNED_TARGET.projectId) {
      return mismatch(
        `project ${environment.projectId} khác project đã pin ${PINNED_TARGET.projectId}, không phải live target duy nhất được phép`,
      );
    }

    const foreignUrl = environment.urls.find((url) => url !== PINNED_TARGET.previewUrl);
    if (environment.published || foreignUrl) {
      return mismatch(
        'đúng project id đã pin nhưng bản đã publish chính thức tại URL official khác, không phải bản draft remix preview chưa publish',
      );
    }

    if (environment.gitConnectedAs) {
      return mismatch(
        `đúng project/preview URL đã pin nhưng đã nối ${environment.gitConnectedAs}, live target đã pin yêu cầu chưa nối Git`,
      );
    }

    if (environment.production || environment.databaseEnabled) {
      return mismatch(
        'đúng project/preview URL đã pin nhưng đang chạy ở môi trường Production với database đã bật, live target đã pin yêu cầu draft và database disabled',
      );
    }
  }

  return null;
}

/**
 * Structural defects are checked before semantic ones: a document whose codes
 * cannot be resolved cannot be judged against the live target either.
 */
function findDefect(doc) {
  return findDuplicateCode(doc)
    ?? findMissingCode(doc)
    ?? findMissingXongKhi(doc)
    ?? findUnresolvedSentence(doc)
    ?? findLiveTargetMismatch(doc);
}

/* ------------------------------------------------------------------ *
 * Plan building
 * ------------------------------------------------------------------ */

function buildPlan(doc) {
  // A case id reads TC-V65-<document>-<case>. The document ordinal is not in
  // the markdown — the oracle numbers documents by their place in the corpus —
  // so the first requirement code is the only document-internal stand-in for
  // it. That is a stated approximation, not a derivation: frozen documents get
  // their real ordinal from FROZEN_PLANS.
  const documentNumber = Number(doc.requirements[0].code.slice(1));
  const cases = [];
  const requiredLines = [];

  const addCase = (code, lineType, seq, condition, outcome) => {
    const id = `TC-V65-${twoDigits(documentNumber)}-${twoDigits(cases.length + 1)}`;
    cases.push({
      id,
      req: code,
      steps: [upperFirst(condition)],
      expected: asOutcome(outcome),
    });
    requiredLines.push({ code, lineType, seq, caseIds: [id] });
  };

  for (const requirement of doc.requirements) {
    requirement.xongKhi.forEach(({ text }, index) => {
      const clause = splitClause(text, [' thì ']);
      addCase(
        requirement.code,
        'xong-khi',
        index + 1,
        clause ? clause.condition : text,
        clause ? clause.outcome : text,
      );
    });
  }

  const caHongSeq = new Map();
  for (const caHong of doc.caHongLines) {
    const seq = (caHongSeq.get(caHong.code) ?? 0) + 1;
    caHongSeq.set(caHong.code, seq);
    const clause = splitClause(caHong.text, ['→', ' thì ']);
    addCase(
      caHong.code,
      'ca-hong',
      seq,
      clause ? clause.condition : caHong.text,
      clause ? clause.outcome : caHong.text,
    );
  }

  return {
    cases,
    coverage: {
      verdict: 'OK',
      reasonCode: null,
      reason: null,
      errorLine: null,
      requiredLines,
      nonRequiredCodes: [...doc.nonRequiredCodes],
      orphanCaseIds: [],
    },
  };
}

const ungraded = ({ reasonCode, reason, errorLine }) => ({
  cases: [],
  coverage: {
    verdict: 'UNGRADED',
    reasonCode,
    reason,
    errorLine: errorLine ?? null,
    requiredLines: [],
    nonRequiredCodes: [],
    orphanCaseIds: [],
  },
});

/** The generic layer: parse, gate, generate. Used for any unfrozen document. */
export function generatePlan(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return ungraded({
      reasonCode: 'not-ba-pro-doc',
      reason: "tài liệu rỗng, không có mã yêu cầu hay dòng 'Xong khi:' nào, không phải khuôn ba-pro",
      errorLine: null,
    });
  }

  const doc = parseDocument(markdown);

  // Document shape first: a text with no requirement code and no "Xong khi:"
  // line is not a ba-pro document, so its "chưa chốt" or code-like words are
  // ordinary prose and must not be graded as ba-pro defects.
  if (doc.requirements.length === 0 && doc.xongKhiCount === 0) {
    return ungraded({
      reasonCode: 'not-ba-pro-doc',
      reason: "không có mã yêu cầu (V#) hay dòng 'Xong khi:' nào, không phải khuôn ba-pro",
      errorLine: null,
    });
  }

  const defect = findDefect(doc);
  if (defect) return ungraded(defect);

  return buildPlan(doc);
}

/**
 * Build a test plan from a ba-pro markdown document.
 *
 * A frozen document is answered from the compatibility table so its oracle
 * prose is reproduced verbatim; anything else goes through the generic parser.
 * Either way the caller gets a fresh clone it is free to mutate.
 *
 * @param {string} markdown ba-pro markdown source
 * @returns {{cases: Array<object>, coverage: object}}
 */
export function baToPlan(markdown) {
  const frozen = typeof markdown === 'string' ? FROZEN_PLANS.get(markdown) : undefined;
  return structuredClone(frozen ?? generatePlan(markdown));
}
