import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { validateFindingCaption } from '../loop8/caption.mjs';
import { validateCanonical } from './canonical.mjs';
import { exportPage, comparePage } from './page-exporter.mjs';
import { mapCanonicalRows, compareNotionRows } from './notion-sync.mjs';
import { notionMcpProjection } from './notion-mcp.mjs';
import { renderNativeBoard } from './native-renderer.mjs';
import { verifyDocColabBoard } from './doc-colab-renderer.mjs';

export const BOARD_QUALITY_VERSION = 'qa-gui/board-quality/v1';
export const BOARD_REVIEW_SCHEMA = 'qa-gui/board-review/v1';
export const BOARD_REVIEW_CRITERIA = Object.freeze([
  Object.freeze({ id: 'actionability', label: 'The requested action and expected outcome are clear.' }),
  Object.freeze({ id: 'source_fidelity', label: 'The handoff stays within the evidence and linked source.' }),
  Object.freeze({ id: 'classification', label: 'Confirmed defects, investigation, clarification, and input needs are distinguished.' }),
  Object.freeze({ id: 'presentation', label: 'The action front is easy to find before technical detail.' }),
  Object.freeze({ id: 'captions', label: 'Structured finding captions are grounded in their measured evidence.' }),
]);

/** Compact deterministic reviewer input; source identities and all case/defect ids stay explicit. */
export function boardReviewFacts(data) {
  const sources = Array.isArray(data?.sourceItems) ? data.sourceItems.map(source => ({
    id: source.id, sourceSystem: source.sourceSystem, externalKey: source.externalKey,
    title: source.title, kind: source.kind, origin: source.origin, ...(source.url ? { url: source.url } : {}),
    ...(source.qaDerivedReason ? { qaDerivedReason: source.qaDerivedReason } : {}),
  })) : [];
  return {
    schema: 'qa-gui/board-review-facts/v1',
    board: { id: data?.boardId, title: data?.title, language: data?.language, app: data?.app, envDb: data?.envDb, viewport: data?.viewport, build: data?.build, role: data?.role, testProfile: data?.testProfile, deepCheck: data?.deepCheck, boardCreated: data?.boardCreated, currentRound: data?.currentRound, revision: data?.rev },
    sourceItems: sources,
    rounds: (Array.isArray(data?.rounds) ? data.rounds : []).map(({ round, scope }) => ({ round, scope })),
    release: data?.release ? { verdict: data.release.verdict, risks: [...(data.release.risks || [])] } : null,
    coverage: (Array.isArray(data?.coverage) ? data.coverage : []).map(item => ({
      ...(typeof item?.area === 'string' ? { area: item.area } : {}),
      ...(typeof item?.status === 'string' ? { status: item.status } : {}),
      ...(typeof item?.description === 'string' ? { description: item.description } : {}),
      ...(typeof item?.requirement === 'string' ? { requirement: item.requirement } : {}),
    })),
    untested: (Array.isArray(data?.untested) ? data.untested : []).map(item => typeof item === 'string' ? item : ({
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
      ...(typeof item?.area === 'string' ? { area: item.area } : {}),
      ...(typeof item?.reason === 'string' ? { reason: item.reason } : {}),
      ...(typeof item?.description === 'string' ? { description: item.description } : {}),
      ...(Array.isArray(item?.sourceRefs) ? { sourceRefs: [...item.sourceRefs] } : {}),
    })),
    evidenceManifest: (Array.isArray(data?.evidenceManifest) ? data.evidenceManifest : []).map(({ path, evidence_type }) => ({ path, ...(evidence_type ? { evidence_type } : {}) })),
    cases: (Array.isArray(data?.cases) ? data.cases : []).map(item => ({
      id: item.id, title: item.title, requirement: item.requirement,
      ...(item.requirements ? { requirements: [...item.requirements] } : {}),
      ...(item.sourceRefs ? { sourceRefs: [...item.sourceRefs] } : {}),
      ...(item.steps ? { steps: item.steps } : {}), ...(item.expected ? { expected: item.expected } : {}),
      status: item.status, functionVerdict: item.functionVerdict, uiVerdict: item.uiVerdict,
      humanSummary: item.humanSummary,
      ...(item.work ? { work: { state: item.work.state, nextAction: item.work.nextAction, remainingChecks: [...item.work.remainingChecks], ...(item.work.blocker ? { blocker: { ...item.work.blocker } } : {}), ...(item.work.evidence ? { evidence: item.work.evidence.map(({ path, sha256 }) => ({ path, sha256 })) } : {}), ...(item.work.attemptRef ? { attemptRef: item.work.attemptRef } : {}) } } : {}),
      ...(item.evidence?.length ? { evidence: [...item.evidence] } : {}),
      ...(item.stateReceipts?.length ? { stateReceipts: item.stateReceipts.map(({ state, file }) => ({ state, file })) } : {}),
      ...(item.results?.length ? { results: item.results.map(result => ({ round: result.round, functionVerdict: result.functionVerdict, uiVerdict: result.uiVerdict, recordedAt: result.recordedAt, evidence: [...(result.evidence || [])] })) } : {}),
      ...(item.comments?.length ? { comments: item.comments.map(({ author, text }) => ({ author, text })) } : {}),
    })),
    defects: (Array.isArray(data?.defects) ? data.defects : []).map(item => ({
      id: item.id, title: item.title, caseId: item.caseId, status: item.status, priority: item.priority,
      assignee: item.assignee, createdBy: item.createdBy, actual: item.actual, expected: item.expected,
      repro: item.repro, ...(item.handoff ? { handoff: item.handoff } : {}),
      ...(item.rejectionReason ? { rejectionReason: item.rejectionReason } : {}),
      ...(item.findings?.length ? { findings: item.findings.map(({ id, rule, severity, selector, caption, bbox, bboxReason }) => ({ id, rule, severity, ...(selector ? { selector } : {}), caption, ...(bbox ? { bbox } : {}), ...(bboxReason ? { bboxReason } : {}) })) } : {}),
      ...(item.evidence?.length ? { evidence: item.evidence.map(({ id, path, role, findingId }) => ({ id, path, role, findingId })) } : {}),
      ...(item.fixEvidence?.length ? { fixEvidence: item.fixEvidence.map(({ id, path, type }) => ({ id, path, type })) } : {}),
      ...(item.comments?.length ? { comments: item.comments.map(({ author, text }) => ({ author, text })) } : {}),
    })),
    reviewCriteria: BOARD_REVIEW_CRITERIA.map(({ id, label }) => ({ id, label })),
  };
}

const ACTIVE_DEFECT_STATUSES = new Set(['TODO', 'DOING', 'FAIL', 'BLOCKED', 'ASSIGNED', 'FIXING', 'REOPENED']);
const PLACEHOLDER = /(?:\b(?:todo|tbd|tbc|placeholder|replace with|fill in|n\/a)\b|thay bằng|chưa ghi nhận|điền vào|cần bổ sung)/i;
const GENERIC = /^(?:review the case and check the observed result\.?|the observed result is recorded in the evidence\.?|observed result requires follow-up\.?|issue requires follow-up\.?|check the issue\.?|review and fix\.?|fix the issue\.?|investigate the issue\.?|cần kiểm tra thêm\.?|xem lại ca kiểm thử\.?|kết quả đã được ghi trong bằng chứng\.?)$/i;
const UNCERTAIN = /(?:\b(?:not confirmed|unknown whether|cannot reproduce|could not reproduce|not reproduced|as designed|unverified)\b|chưa xác nhận|chưa rõ|không tái hiện|chưa tái hiện)/i;
const sha256Pattern = /^[a-f0-9]{64}$/i;

const addError = (errors, code, path, message) => errors.push({ code, path, message });
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const normalized = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();

function jsonPointerValue(root, pointer) {
  if (typeof pointer !== 'string' || (!pointer.startsWith('/') && pointer !== '')) return { ok: false };
  let value = root;
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value == null || (typeof value !== 'object' && typeof value !== 'string') || !Object.hasOwn(value, key)) return { ok: false };
    value = value[key];
  }
  return { ok: true, value };
}

function textFields(data, defect, index, errors) {
  const fields = [
    ['title', defect.title], ['actual', defect.actual], ['expected', defect.expected], ['repro', defect.repro],
    ['handoff.problem', defect.handoff?.problem], ['handoff.request', defect.handoff?.request], ['handoff.expected', defect.handoff?.expected],
  ];
  for (const [field, value] of fields) {
    if (!nonblank(value)) continue; // Structural diagnostics are returned by validateCanonical.
    if (PLACEHOLDER.test(value) || GENERIC.test(value.trim())) {
      addError(errors, 'VAGUE_OR_PLACEHOLDER', `/defects/${index}/${field.replaceAll('.', '/')}`, `${defect.id || 'defect'} ${field} is generic or contains a placeholder`);
    }
  }
  if (normalized(defect.actual) && normalized(defect.actual) === normalized(defect.expected)) {
    addError(errors, 'ACTUAL_MATCHES_EXPECTED', `/defects/${index}/actual`, `${defect.id || 'defect'} actual and expected describe the same result`);
  }
  const handoff = defect.handoff;
  if (handoff?.kind === 'fix' && [defect.title, defect.actual, handoff.problem, handoff.request].some(value => UNCERTAIN.test(String(value || '')))) {
    addError(errors, 'CLASSIFICATION_CONTRADICTION', `/defects/${index}/handoff/kind`, 'fix is inconsistent with text that says the behavior is unconfirmed or not reproducible');
  }
  for (const [findingIndex, finding] of (Array.isArray(defect.findings) ? defect.findings : []).entries()) {
    const captionVerdict = validateFindingCaption({ finding, caption: finding?.caption, language: data.language });
    if (captionVerdict !== 'PASS') {
      addError(errors, captionVerdict === 'UNGRADED' ? 'CAPTION_UNGRADED' : 'CAPTION_NOT_GROUNDED', `/defects/${index}/findings/${findingIndex}/caption`, `${defect.id || 'defect'} finding ${finding?.id || findingIndex} caption verdict is ${captionVerdict}`);
    }
  }
}

/** Strict delivery-quality check. It is intentionally separate from legacy canonical validation. */
export function inspectBoardQuality(data) {
  const errors = [];
  const canonical = validateCanonical(data);
  if (!canonical.ok) {
    for (const entry of canonical.errors) addError(errors, 'CANONICAL_INVALID', `/${String(entry.path || '').replaceAll('.', '/')}`, entry.message);
    return { schema: BOARD_QUALITY_VERSION, ruleVersion: BOARD_QUALITY_VERSION, verdict: 'UNGRADED', errors, reviewCriteria: BOARD_REVIEW_CRITERIA.map(({ id }) => id) };
  }
  for (const [index, defect] of data.defects.entries()) {
    if (ACTIVE_DEFECT_STATUSES.has(defect.status) && !defect.handoff) {
      addError(errors, 'HANDOFF_REQUIRED', `/defects/${index}/handoff`, `${defect.id} needs a concise action handoff before delivery`);
    }
    textFields(data, defect, index, errors);
  }
  return {
    schema: BOARD_QUALITY_VERSION,
    ruleVersion: BOARD_QUALITY_VERSION,
    verdict: errors.length ? 'FAIL' : 'PASS',
    errors,
    reviewCriteria: BOARD_REVIEW_CRITERIA.map(({ id }) => id),
  };
}

function exactIdCoverage(actual, expected, path, errors) {
  if (!Array.isArray(actual) || actual.some(id => typeof id !== 'string') || new Set(actual).size !== actual.length) {
    addError(errors, 'INVALID_COVERAGE', path, 'coverage must be a unique array of canonical ids');
    return false;
  }
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    addError(errors, 'INCOMPLETE_COVERAGE', path, 'coverage must list every canonical id exactly once in canonical order');
    return false;
  }
  return true;
}

function exactKeys(value, keys, path, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'INVALID_SHAPE', path, 'expected an object');
    return false;
  }
  let ok = true;
  for (const key of keys) if (!Object.hasOwn(value, key)) { addError(errors, 'MISSING_FIELD', `${path}/${key}`, `missing ${key}`); ok = false; }
  for (const key of Object.keys(value)) if (!keys.includes(key)) { addError(errors, 'UNKNOWN_FIELD', `${path}/${key}`, `unknown field ${key}`); ok = false; }
  return ok;
}

const NOT_APPLICABLE = /^(?:not applicable|không áp dụng)\s*:/i;
const NOT_RUN_RISKS = new Set([
  'QA chưa được chạy.', 'QA has not run.',
  'QA가 아직 실행되지 않았습니다.', 'QAはまだ実行されていません。',
]);

function absenceAnchorIsRelevant(data, criterion, anchor, resolvedValue) {
  if (!NOT_APPLICABLE.test(String(criterion?.rationale || '').trim())) return false;
  if (!Array.isArray(data?.defects) || data.defects.length !== 0) return false;
  if (data.cases?.length > 0) {
    // With no defects, handoff criteria explain absence using substantive case context.
    return ['actionability', 'classification', 'presentation'].includes(criterion.id)
      && /^\/cases\/\d+\/(?:requirement|expected)$/.test(anchor.path);
  }
  // A draft review can acknowledge absence; it cannot manufacture execution or release acceptance.
  const emptyDraft = ['cases', 'sourceItems', 'evidenceManifest', 'coverage', 'untested']
    .every(key => Array.isArray(data?.[key]) && data[key].length === 0)
    && data.release?.verdict === 'NO-GO';
  return emptyDraft && /^\/release\/risks\/\d+$/.test(anchor.path)
    && NOT_RUN_RISKS.has(resolvedValue) && anchor.quote === resolvedValue;
}

/** Validate review shape and grounding only. Caller owns reviewer identity/authentication. */
export function validateBoardReview({ data, review, canonicalSha256 } = {}) {
  const errors = [];
  if (!sha256Pattern.test(String(canonicalSha256 || ''))) addError(errors, 'INVALID_CANONICAL_HASH', '/canonicalSha256', 'canonicalSha256 must be a 64-character SHA-256 hex digest');
  const keys = ['schema', 'ruleVersion', 'canonicalSha256', 'coveredCaseIds', 'coveredDefectIds', 'criteria', 'verdict'];
  exactKeys(review, keys, '', errors);
  if (review?.schema !== BOARD_REVIEW_SCHEMA) addError(errors, 'SCHEMA_MISMATCH', '/schema', `expected ${BOARD_REVIEW_SCHEMA}`);
  if (review?.ruleVersion !== BOARD_QUALITY_VERSION) addError(errors, 'RULE_VERSION_MISMATCH', '/ruleVersion', `expected ${BOARD_QUALITY_VERSION}`);
  if (review?.canonicalSha256 !== canonicalSha256) addError(errors, 'CANONICAL_HASH_MISMATCH', '/canonicalSha256', 'review does not bind to this canonical SHA-256');
  if (!['PASS', 'FAIL', 'UNGRADED'].includes(review?.verdict)) addError(errors, 'INVALID_VERDICT', '/verdict', 'verdict must be PASS, FAIL, or UNGRADED');

  const cases = Array.isArray(data?.cases) ? data.cases.map(item => item?.id).filter(id => typeof id === 'string') : [];
  const defects = Array.isArray(data?.defects) ? data.defects.map(item => item?.id).filter(id => typeof id === 'string') : [];
  exactIdCoverage(review?.coveredCaseIds, cases, '/coveredCaseIds', errors);
  exactIdCoverage(review?.coveredDefectIds, defects, '/coveredDefectIds', errors);

  const criterionIds = BOARD_REVIEW_CRITERIA.map(({ id }) => id);
  if (!Array.isArray(review?.criteria)) {
    addError(errors, 'INVALID_CRITERIA', '/criteria', 'criteria must be an array');
  } else {
    const seen = new Set();
    for (const [index, criterion] of review.criteria.entries()) {
      const at = `/criteria/${index}`;
      exactKeys(criterion, ['id', 'verdict', 'rationale', 'anchors'], at, errors);
      if (!criterionIds.includes(criterion?.id)) addError(errors, 'UNKNOWN_CRITERION', `${at}/id`, `unknown criterion ${String(criterion?.id)}`);
      if (seen.has(criterion?.id)) addError(errors, 'DUPLICATE_CRITERION', `${at}/id`, `criterion ${criterion?.id} appears more than once`);
      seen.add(criterion?.id);
      let relevantGroundedAnchor = false;
      if (!['PASS', 'FAIL', 'UNGRADED'].includes(criterion?.verdict)) addError(errors, 'INVALID_CRITERION_VERDICT', `${at}/verdict`, 'criterion verdict must be PASS, FAIL, or UNGRADED');
      if (!nonblank(criterion?.rationale)) addError(errors, 'RATIONALE_REQUIRED', `${at}/rationale`, 'rationale must be nonempty');
      if (!Array.isArray(criterion?.anchors) || criterion.anchors.length === 0) {
        addError(errors, 'ANCHOR_REQUIRED', `${at}/anchors`, 'each criterion requires at least one grounded anchor');
      } else {
        for (const [anchorIndex, anchor] of criterion.anchors.entries()) {
          const anchorPath = `${at}/anchors/${anchorIndex}`;
          exactKeys(anchor, ['path', 'quote'], anchorPath, errors);
          const resolved = jsonPointerValue(data, anchor?.path);
          const grounded = resolved.ok && typeof resolved.value === 'string' && nonblank(anchor?.quote) && resolved.value.includes(anchor.quote);
          if (!grounded) {
            addError(errors, 'ANCHOR_NOT_GROUNDED', anchorPath, 'anchor quote must be an exact substring at a valid canonical JSON pointer');
          }
          const allowedAnchor = {
            actionability: /^\/defects\/\d+\/handoff\/(?:request|expected)$/,
            source_fidelity: /^(?:\/sourceItems\/\d+\/(?:title|externalKey|url)|\/cases\/\d+\/(?:requirement|expected|sourceRefs(?:\/\d+)?|evidence(?:\/\d+)?))$|^\/defects\/\d+\/(?:handoff\/(?:problem|expected)|evidence(?:\/\d+)?\/path)$/,
            classification: /^\/defects\/\d+\/(?:handoff\/kind|title|actual|repro)$/,
            presentation: /^\/defects\/\d+\/handoff\/(?:problem|request|expected)$/,
            captions: /^(?:\/defects\/\d+\/findings\/\d+\/(?:caption|selector|bbox(?:Reason)?)|\/cases\/\d+\/(?:requirement|expected))$/,
          }[criterion?.id];
          if (grounded && (allowedAnchor?.test(String(anchor?.path || ''))
            || absenceAnchorIsRelevant(data, criterion, anchor, resolved.value))) relevantGroundedAnchor = true;
        }
      }
      if (criterionIds.includes(criterion?.id) && Array.isArray(criterion?.anchors) && criterion.anchors.length > 0 && !relevantGroundedAnchor) {
        addError(errors, 'ANCHOR_NOT_RELEVANT', `${at}/anchors`, `criterion ${criterion.id} requires at least one relevant grounded canonical source anchor`);
      }
    }
    for (const id of criterionIds) if (!seen.has(id)) addError(errors, 'MISSING_CRITERION', '/criteria', `missing criterion ${id}`);
  }

  const quality = inspectBoardQuality(data);
  const criterionVerdicts = Array.isArray(review?.criteria) ? review.criteria.map(item => item?.verdict) : [];
  const derived = errors.length ? 'UNGRADED'
    : quality.verdict === 'FAIL' || criterionVerdicts.includes('FAIL') ? 'FAIL'
      : quality.verdict !== 'PASS' || criterionVerdicts.includes('UNGRADED') ? 'UNGRADED' : 'PASS';
  if (review?.verdict !== derived) addError(errors, 'VERDICT_MISMATCH', '/verdict', `review verdict must be ${derived} for the supplied quality and criteria`);
  return { schema: 'qa-gui/board-review-validation/v1', verdict: errors.length ? 'UNGRADED' : derived, errors, qualityVerdict: quality.verdict };
}

/** Verify that a saved delivery artifact is the canonical projection for its declared renderer. */
export function verifyBoardProjection({ file, artifactPath, renderer, projectionOptions = {} } = {}) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, path: '', message });
  const allowedOptions = renderer === 'page' ? ['evidenceMap']
    : renderer === 'notion' ? ['notionSourceMap']
      : renderer === 'notion-mcp' ? ['version', 'runId']
        : renderer === 'doc-colab' ? ['docColabRoot'] : [];
  if (!['page', 'notion', 'notion-mcp', 'native', 'doc-colab'].includes(renderer)) fail('UNKNOWN_RENDERER', `unsupported renderer ${String(renderer)}`);
  if (!projectionOptions || typeof projectionOptions !== 'object' || Array.isArray(projectionOptions)) {
    fail('INVALID_OPTIONS', 'projectionOptions must be an object');
  } else {
    for (const key of Object.keys(projectionOptions)) if (!allowedOptions.includes(key)) fail('UNKNOWN_OPTION', `${key} is not allowed for renderer ${renderer}`);
  }
  let canonicalBytes;
  let artifactBytes;
  let data;
  try {
    if (typeof file !== 'string' || !file || typeof artifactPath !== 'string' || !artifactPath) throw new Error('file and artifactPath are required');
    canonicalBytes = readFileSync(file);
    data = JSON.parse(canonicalBytes.toString('utf8'));
    artifactBytes = readFileSync(artifactPath);
  } catch (error) {
    fail('INPUT_UNREADABLE', error.message);
  }
  const canonicalSha256 = canonicalBytes ? createHash('sha256').update(canonicalBytes).digest('hex') : null;
  const artifactSha256 = artifactBytes ? createHash('sha256').update(artifactBytes).digest('hex') : null;
  if (data) {
    const validation = validateCanonical(data);
    if (!validation.ok) fail('CANONICAL_INVALID', validation.errors.map(entry => `${entry.path}: ${entry.message}`).join('; '));
  }
  if (errors.length === 0) {
    try {
      const artifactText = artifactBytes.toString('utf8');
      if (renderer === 'page') {
        const expected = exportPage(data, canonicalSha256, projectionOptions.evidenceMap || {});
        const actual = JSON.parse(artifactText);
        const snapshot = actual?.structuredContent?.content?.blocks || actual?.content?.blocks;
        if (snapshot) {
          const comparison = comparePage(expected, actual);
          if (!comparison.ok) fail('PROJECTION_MISMATCH', `Page readback mismatch: ${comparison.mismatches.join(', ')}`);
        } else if (!isDeepStrictEqual(actual, expected)) fail('PROJECTION_MISMATCH', 'Page export JSON differs from canonical projection');
      } else if (renderer === 'notion') {
        const actual = JSON.parse(artifactText);
        const rows = Array.isArray(actual) ? actual : actual?.rows;
        if (!Array.isArray(rows)) throw new Error('Notion artifact must be an array of rows or an object with rows');
        const options = { notionSourcePages: projectionOptions.notionSourceMap || {} };
        const expected = mapCanonicalRows(data, options);
        const comparison = compareNotionRows(data, rows, options);
        if (comparison.matchPercent !== 100 || !isDeepStrictEqual(rows, expected)) fail('PROJECTION_MISMATCH', `Notion projection differs from canonical data: ${comparison.mismatches.map(item => `${item.externalId}.${item.field}`).join(', ') || 'extra or reordered rows/fields'}`);
      } else if (renderer === 'notion-mcp') {
        // The exact projection Team QA turns into Notion MCP calls; the board sha is the canonical file's own.
        const expected = notionMcpProjection(data, { version: projectionOptions.version, runId: projectionOptions.runId, boardSha256: canonicalSha256 });
        if (!isDeepStrictEqual(JSON.parse(artifactText), expected)) fail('PROJECTION_MISMATCH', 'Notion MCP projection differs from canonical data');
      } else if (renderer === 'native') {
        if (artifactText !== renderNativeBoard(data)) fail('PROJECTION_MISMATCH', 'native HTML differs from canonical renderer output');
      } else if (renderer === 'doc-colab') {
        const verification = verifyDocColabBoard({ input: file, output: artifactPath, docColabRoot: projectionOptions.docColabRoot });
        if (!verification.ok) fail('DOC_COLAB_UNVERIFIED', 'Doc-Colab integrity verification did not pass');
        if (data.defects.some(defect => defect.handoff)) {
          const match = artifactText.match(/window\.DOC_DATA\s*=\s*(\{[\s\S]*?\});\s*\n<\/script>/);
          const projected = match ? JSON.parse(match[1]) : null;
          const missing = data.defects.filter(defect => defect.handoff).filter(defect => {
            const task = projected?.tasks?.find(entry => entry.entity === 'defect' && entry.id === defect.id);
            return !isDeepStrictEqual(task?.defectSummary?.handoff, defect.handoff);
          });
          if (missing.length) fail('DOC_COLAB_HANDOFF_UNSUPPORTED', `verified Doc-Colab projection lacks exact defectSummary.handoff for ${missing.map(item => item.id).join(', ')}`);
        }
      }
    } catch (error) {
      fail('PROJECTION_ERROR', error.message);
    }
  }
  return { verdict: errors.length ? 'FAIL' : 'PASS', errors, renderer, canonical: { sha256: canonicalSha256 }, artifact: { sha256: artifactSha256 } };
}
