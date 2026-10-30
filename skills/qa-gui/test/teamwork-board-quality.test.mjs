import assert from 'node:assert/strict';
import { createHash as hash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { BOARD_QUALITY_VERSION, BOARD_REVIEW_CRITERIA, boardReviewFacts, inspectBoardQuality, validateBoardReview, verifyBoardProjection } from '../scripts/teamwork/board-quality.mjs';
import { validateCanonical } from '../scripts/teamwork/canonical.mjs';
import { exportPage } from '../scripts/teamwork/page-exporter.mjs';
import { mapCanonicalRows } from '../scripts/teamwork/notion-sync.mjs';
import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';

const source = JSON.parse(readFileSync(new URL('../scripts/teamwork/example-canonical.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);

function goodBoard() {
  const data = clone(source);
  const defect = data.defects[0];
  defect.title = 'Nhãn tổng tiền bị tràn khỏi thẻ giỏ hàng';
  defect.actual = 'Nhãn tổng tiền tràn khỏi thẻ giỏ hàng 8 px ở khung nhìn 1280 px.';
  defect.expected = 'Nhãn tổng tiền nằm gọn trong thẻ giỏ hàng.';
  defect.repro = 'Mở trang giỏ hàng ở khung nhìn 1280 px rồi quan sát nhãn tổng tiền.';
  defect.handoff = {
    kind: 'fix',
    problem: 'Nhãn tổng tiền tràn khỏi thẻ giỏ hàng 8 px ở khung nhìn 1280 px.',
    request: 'Điều chỉnh bố cục để nhãn nằm trong thẻ mà không che nội dung.',
    expected: 'Nhãn hiển thị đầy đủ bên trong thẻ giỏ hàng ở cùng khung nhìn.',
  };
  defect.findings[0].selector = '#cart-total';
  defect.findings[0].caption = 'Nhãn #cart-total tràn khỏi thẻ 8 px tại khung nhìn này. Giữ nhãn bên trong thẻ để người mua đọc đủ tổng tiền.';
  return data;
}

test('strict board-quality positive control passes without changing canonical verdict rules', () => {
  const data = goodBoard();
  assert.equal(validateCanonical(data).ok, true);
  assert.deepEqual(inspectBoardQuality(data), {
    schema: BOARD_QUALITY_VERSION,
    ruleVersion: BOARD_QUALITY_VERSION,
    verdict: 'PASS',
    errors: [],
    reviewCriteria: BOARD_REVIEW_CRITERIA.map(({ id }) => id),
  });
});

test('legacy canonical remains valid while active delivery quality flags missing handoff and vague actual=expected', () => {
  const data = clone(source);
  const defect = data.defects[0];
  defect.title = 'Kết quả đã ghi nhận, cần bổ sung.';
  defect.repro = 'Xem lại ca kiểm thử.';
  defect.actual = 'Kết quả đã được ghi trong bằng chứng.';
  defect.expected = 'Kết quả đã được ghi trong bằng chứng.';
  assert.equal(validateCanonical(data).ok, true);
  const quality = inspectBoardQuality(data);
  assert.equal(quality.verdict, 'FAIL');
  assert.ok(quality.errors.some(error => error.code === 'HANDOFF_REQUIRED'));
  assert.ok(quality.errors.some(error => error.code === 'VAGUE_OR_PLACEHOLDER'));
  assert.ok(quality.errors.some(error => error.code === 'ACTUAL_MATCHES_EXPECTED'));
});

test('strict quality rejects vague action fronts, contradictory fix classification, and ungrounded captions', () => {
  const vague = goodBoard();
  vague.defects[0].handoff.request = 'Review the case and check the observed result.';
  assert.ok(inspectBoardQuality(vague).errors.some(error => error.code === 'VAGUE_OR_PLACEHOLDER'));

  const contradiction = goodBoard();
  contradiction.defects[0].actual = 'Không tái hiện được nội dung bị tràn.';
  assert.ok(inspectBoardQuality(contradiction).errors.some(error => error.code === 'CLASSIFICATION_CONTRADICTION'));

  const caption = goodBoard();
  caption.defects[0].findings[0].caption = 'Nhãn hiển thị hơi sai. Hãy sửa phần đó.';
  assert.ok(inspectBoardQuality(caption).errors.some(error => error.code === 'CAPTION_NOT_GROUNDED'));
});

test('handoff schema is optional for legacy data but rejects unknown fields and invalid kinds', () => {
  const legacy = clone(source);
  assert.equal(validateCanonical(legacy).ok, true);
  const extra = goodBoard();
  extra.defects[0].handoff.owner = 'guessed-owner';
  assert.equal(validateCanonical(extra).ok, false);
  const kind = goodBoard();
  kind.defects[0].handoff.kind = 'root-cause';
  assert.equal(validateCanonical(kind).ok, false);
});

function goodReview(data) {
  const anchor = (path, quote) => ({ path, quote });
  const criteria = BOARD_REVIEW_CRITERIA.map(({ id }) => ({
    id, verdict: 'PASS', rationale: `Reviewed ${id} against canonical source text.`,
    anchors: [anchor('/defects/0/handoff/request', data.defects[0].handoff.request)],
  }));
  criteria.find(item => item.id === 'classification').anchors = [anchor('/defects/0/handoff/kind', 'fix')];
  criteria.find(item => item.id === 'source_fidelity').anchors = [anchor('/defects/0/handoff/problem', data.defects[0].handoff.problem)];
  criteria.find(item => item.id === 'captions').anchors = [{ path: '/defects/0/findings/0/caption', quote: data.defects[0].findings[0].caption }];
  return {
    schema: 'qa-gui/board-review/v1', ruleVersion: BOARD_QUALITY_VERSION,
    canonicalSha256: 'a'.repeat(64), coveredCaseIds: data.cases.map(item => item.id),
    coveredDefectIds: data.defects.map(item => item.id), criteria, verdict: 'PASS',
  };
}

test('independent review requires exact coverage, every criterion, grounded anchors, and no averaging', () => {
  const data = goodBoard();
  const review = goodReview(data);
  assert.deepEqual(validateBoardReview({ data, review, canonicalSha256: 'a'.repeat(64) }), {
    schema: 'qa-gui/board-review-validation/v1', verdict: 'PASS', errors: [], qualityVerdict: 'PASS',
  });

  const missingCase = clone(review); missingCase.coveredCaseIds.pop();
  assert.notEqual(validateBoardReview({ data, review: missingCase, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');
  const missingCriterion = clone(review); missingCriterion.criteria.pop();
  assert.notEqual(validateBoardReview({ data, review: missingCriterion, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');
  const fakeAnchor = clone(review); fakeAnchor.criteria[0].anchors[0].quote = 'not in canonical';
  assert.ok(validateBoardReview({ data, review: fakeAnchor, canonicalSha256: 'a'.repeat(64) }).errors.some(error => error.code === 'ANCHOR_NOT_GROUNDED'));
  const averaged = clone(review); averaged.criteria[1].verdict = 'FAIL';
  assert.notEqual(validateBoardReview({ data, review: averaged, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');
  const unknown = clone(review); unknown.reviewer = 'unverified';
  assert.ok(validateBoardReview({ data, review: unknown, canonicalSha256: 'a'.repeat(64) }).errors.some(error => error.code === 'UNKNOWN_FIELD'));
  const identifierOnly = clone(review); identifierOnly.criteria[0].anchors = [{ path: '/defects/0/id', quote: data.defects[0].id }];
  assert.ok(validateBoardReview({ data, review: identifierOnly, canonicalSha256: 'a'.repeat(64) }).errors.some(error => error.code === 'ANCHOR_NOT_RELEVANT'));

  const supporting = clone(review);
  supporting.criteria[0].anchors.push({ path: '/defects/0/expected', quote: data.defects[0].expected });
  assert.equal(validateBoardReview({ data, review: supporting, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');

  const ungroundedExtra = clone(review);
  ungroundedExtra.criteria[0].anchors.push({ path: '/defects/0/expected', quote: 'not an exact source quote' });
  assert.ok(validateBoardReview({ data, review: ungroundedExtra, canonicalSha256: 'a'.repeat(64) }).errors.some(error => error.code === 'ANCHOR_NOT_GROUNDED'));

  const explicitFail = clone(review);
  explicitFail.criteria[0].verdict = 'FAIL';
  explicitFail.verdict = 'FAIL';
  assert.equal(validateBoardReview({ data, review: explicitFail, canonicalSha256: 'a'.repeat(64) }).verdict, 'FAIL');
});

test('review facts retain all IDs and source/user prose while excluding histories and raw machine logs', () => {
  const data = goodBoard();
  data.cases[0].history[0] = { who: 'qa', field: 'status', from: 'TODO', to: 'DOING', when: '2026-10-15T00:00:00Z', source: 'agent' };
  data.cases[0].machine.rawLog = 'a'.repeat(100_000);
  const facts = boardReviewFacts(data);
  assert.deepEqual(facts.cases.map(item => item.id), data.cases.map(item => item.id));
  assert.deepEqual(facts.defects.map(item => item.id), data.defects.map(item => item.id));
  assert.ok(facts.defects[0].handoff.request);
  assert.ok(facts.sourceItems.length);
  assert.equal(JSON.stringify(facts).includes('rawLog'), false);
  assert.equal(JSON.stringify(facts).includes('a'.repeat(1000)), false);
  assert.deepEqual(facts, boardReviewFacts(data));
});

test('Page, Notion, and native projections show the handoff before reproduction detail', () => {
  const data = goodBoard();
  const page = exportPage(data, 'b'.repeat(64)).initial_blocks.join('\n\n');
  assert.ok(page.indexOf('**Yêu cầu bàn giao') < page.indexOf('**Các bước tái hiện'));
  assert.ok(page.includes(data.defects[0].handoff.request));
  const notion = mapCanonicalRows(data).find(row => row.entity === 'defect');
  assert.deepEqual(notion.handoff, data.defects[0].handoff);
  const native = renderNativeBoard(data);
  assert.ok(native.indexOf('Developer handoff') < native.indexOf('REPRO'));
  assert.ok(native.includes(data.defects[0].handoff.request));
});

test('source mutation disabling required handoff is killed after the original positive control passes', async () => {
  const baseline = goodBoard();
  assert.equal(inspectBoardQuality(baseline).verdict, 'PASS');
  const incomplete = clone(baseline);
  delete incomplete.defects[0].handoff;
  assert.equal(inspectBoardQuality(incomplete).verdict, 'FAIL');

  let source = readFileSync(new URL('../scripts/teamwork/board-quality.mjs', import.meta.url), 'utf8');
  source = source.replace(
    'if (ACTIVE_DEFECT_STATUSES.has(defect.status) && !defect.handoff) {',
    'if (false && ACTIVE_DEFECT_STATUSES.has(defect.status) && !defect.handoff) {',
  );
  assert.notEqual(source, readFileSync(new URL('../scripts/teamwork/board-quality.mjs', import.meta.url), 'utf8'), 'mutation target must exist');
  const moduleUrl = relative => pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href;
  const captionUrl = moduleUrl('../scripts/loop8/caption.mjs');
  const canonicalUrl = moduleUrl('../scripts/teamwork/canonical.mjs');
  const pageUrl = moduleUrl('../scripts/teamwork/page-exporter.mjs');
  const notionUrl = moduleUrl('../scripts/teamwork/notion-sync.mjs');
  const nativeUrl = moduleUrl('../scripts/teamwork/native-renderer.mjs');
  const docColabUrl = moduleUrl('../scripts/teamwork/doc-colab-renderer.mjs');
  source = source.replace("'../loop8/caption.mjs'", `'${captionUrl}'`).replace("'./canonical.mjs'", `'${canonicalUrl}'`)
    .replaceAll("'./page-exporter.mjs'", `'${pageUrl}'`).replaceAll("'./notion-sync.mjs'", `'${notionUrl}'`)
    .replaceAll("'./native-renderer.mjs'", `'${nativeUrl}'`).replaceAll("'./doc-colab-renderer.mjs'", `'${docColabUrl}'`);
  const mutant = await import(`data:text/javascript,${encodeURIComponent(source)}#mutation-${Date.now()}`);
  assert.equal(mutant.inspectBoardQuality(baseline).verdict, 'PASS');
  assert.equal(mutant.inspectBoardQuality(incomplete).verdict, 'PASS');
  assert.throws(() => assert.equal(mutant.inspectBoardQuality(incomplete).verdict, 'FAIL'), assert.AssertionError);
});

test('projection verifier binds exact canonical bytes to Page, Notion, and native output', () => {
  const data = goodBoard();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-gui-board-projection-'));
  const file = path.join(dir, 'canonical.json');
  const artifactPath = path.join(dir, 'artifact.json');
  writeFileSync(file, JSON.stringify(data));
  writeFileSync(artifactPath, JSON.stringify(exportPage(data, hash('sha256').update(readFileSync(file)).digest('hex'))));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'page' }).verdict, 'PASS');
  writeFileSync(artifactPath, JSON.stringify({ protocol: 'arbitrary', title: data.title }));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'page' }).verdict, 'FAIL');

  writeFileSync(artifactPath, JSON.stringify(mapCanonicalRows(data)));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'notion' }).verdict, 'PASS');
  const tamperedRows = mapCanonicalRows(data);
  tamperedRows.find(row => row.entity === 'defect').handoff.request = 'unrelated request';
  writeFileSync(artifactPath, JSON.stringify(tamperedRows));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'notion' }).verdict, 'FAIL');

  writeFileSync(artifactPath, renderNativeBoard(data));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'native' }).verdict, 'PASS');
  writeFileSync(artifactPath, `${renderNativeBoard(data)}<!-- changed -->`);
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'native' }).verdict, 'FAIL');
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'unknown' }).verdict, 'FAIL');
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'native', projectionOptions: { evidenceMap: {} } }).errors[0].code, 'UNKNOWN_OPTION');
});

test('Doc-Colab projection requires exact handoff in its verified task projection', () => {
  const data = goodBoard();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-gui-doc-colab-projection-'));
  const root = path.join(dir, 'doc-colab');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const file = path.join(dir, 'canonical.json');
  const artifactPath = path.join(dir, 'board.html');
  const generator = path.join(root, 'scripts', 'make_doc.py');
  writeFileSync(file, JSON.stringify(data));
  const projected = handoff => ({ tasks: [{ entity: 'defect', id: data.defects[0].id, defectSummary: handoff ? { handoff: data.defects[0].handoff } : {} }] });
  const writeGenerator = object => {
    const html = `<html><script id="doc-data">\nwindow.DOC_DATA = ${JSON.stringify(object)};\n</script></html>`;
    writeFileSync(artifactPath, html);
    writeFileSync(generator, 'print("verdict=pass")\n');
  };

  writeGenerator(projected(false));
  assert.ok(verifyBoardProjection({ file, artifactPath, renderer: 'doc-colab', projectionOptions: { docColabRoot: root } }).errors.some(error => error.code === 'DOC_COLAB_HANDOFF_UNSUPPORTED'));
  writeGenerator(projected(true));
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'doc-colab', projectionOptions: { docColabRoot: root } }).verdict, 'PASS');
  const changed = projected(true);
  changed.tasks[0].defectSummary.handoff.request = 'different request';
  writeGenerator(changed);
  assert.equal(verifyBoardProjection({ file, artifactPath, renderer: 'doc-colab', projectionOptions: { docColabRoot: root } }).verdict, 'FAIL');
});

function noDefectReview(data, empty = false) {
  const review = goodReview(goodBoard());
  review.coveredCaseIds = data.cases.map(item => item.id);
  review.coveredDefectIds = [];
  review.criteria.forEach(item => {
    item.rationale = `Not applicable: no defects or findings exist for ${item.id}; reviewed the remaining canonical scope.`;
    item.anchors = empty
      ? [{ path: '/release/risks/0', quote: data.release.risks[0] }]
      : [{ path: '/cases/0/requirement', quote: data.cases[0].requirement }];
  });
  return review;
}

function emptyDraft() {
  const data = goodBoard();
  for (const key of ['cases', 'defects', 'sourceItems', 'coverage', 'untested', 'evidenceManifest']) data[key] = [];
  return data;
}

const validateReview = (data, review) => validateBoardReview({ data, review, canonicalSha256: 'a'.repeat(64) });

test('empty unexecuted NO-GO draft supports explicit inapplicability without product acceptance', () => {
  const data = emptyDraft();
  const before = clone(data);
  assert.equal(validateCanonical(data).ok, true);
  assert.equal(validateReview(data, noDefectReview(data, true)).verdict, 'PASS');
  assert.equal(data.release.verdict, 'NO-GO');
  assert.deepEqual(boardReviewFacts(data).evidenceManifest, []);
  assert.deepEqual(data, before);
  for (const [language, risk] of [['en', 'QA has not run.'], ['ko', 'QA가 아직 실행되지 않았습니다.'], ['ja', 'QAはまだ実行されていません。']]) {
    const localized = clone(data); localized.language = language; localized.release.risks[0] = risk;
    localized.title = { en: 'QA draft', ko: 'QA 초안', ja: 'QA下書き' }[language];
    localized.rounds[0].scope = { en: 'Initial QA scope', ko: '초기 QA 범위', ja: '初回のQA範囲' }[language];
    assert.equal(validateReview(localized, noDefectReview(localized, true)).verdict, 'PASS');
  }
});

test('cases-only boards review remaining substantive case text with exact case coverage', () => {
  const data = goodBoard(); data.defects = [];
  const review = noDefectReview(data);
  assert.equal(validateCanonical(data).ok, true);
  assert.equal(validateReview(data, review).verdict, 'PASS');
  const missing = clone(review); missing.coveredCaseIds.pop();
  assert.ok(validateReview(data, missing).errors.some(error => error.code === 'INCOMPLETE_COVERAGE'));
  for (const field of ['id', 'status']) {
    const statusOnly = clone(review);
    statusOnly.criteria.forEach(item => item.anchors = [{ path: `/cases/0/${field}`, quote: data.cases[0][field] }]);
    assert.ok(validateReview(data, statusOnly).errors.some(error => error.code === 'ANCHOR_NOT_RELEVANT'));
  }
  const releaseOnly = noDefectReview(data, true);
  assert.ok(validateReview(data, releaseOnly).errors.some(error => error.code === 'ANCHOR_NOT_RELEVANT'));
});

test('absence fallback rejects execution, acceptance claims, missing rationale and unrelated risk prose', () => {
  const data = emptyDraft();
  for (const mutate of [
    board => board.release.verdict = 'GO',
    board => board.evidenceManifest = [{ path: 'executed.png', sha256: 'b'.repeat(64) }],
    board => board.coverage = [{ area: 'checkout', status: 'PASS' }],
    board => board.sourceItems = clone(source.sourceItems),
    board => board.release.risks[0] = 'The release is ready.',
  ]) {
    const changed = clone(data); mutate(changed);
    assert.notEqual(validateReview(changed, noDefectReview(changed, true)).verdict, 'PASS');
  }
  const missingRationale = noDefectReview(data, true);
  missingRationale.criteria[0].rationale = 'Reviewed canonical text.';
  assert.ok(validateReview(data, missingRationale).errors.some(error => error.code === 'ANCHOR_NOT_RELEVANT'));
  const wrongQuote = noDefectReview(data, true); wrongQuote.criteria[0].anchors[0].quote = 'QA has run.';
  assert.ok(validateReview(data, wrongQuote).errors.some(error => error.code === 'ANCHOR_NOT_GROUNDED'));
  const wrongHash = noDefectReview(data, true); wrongHash.canonicalSha256 = 'b'.repeat(64);
  assert.ok(validateReview(data, wrongHash).errors.some(error => error.code === 'CANONICAL_HASH_MISMATCH'));
  const missingCriterion = noDefectReview(data, true); missingCriterion.criteria.pop();
  assert.ok(validateReview(data, missingCriterion).errors.some(error => error.code === 'MISSING_CRITERION'));
  const fakeCoverage = noDefectReview(data, true); fakeCoverage.coveredCaseIds = ['synthetic-case'];
  assert.ok(validateReview(data, fakeCoverage).errors.some(error => error.code === 'INCOMPLETE_COVERAGE'));
});

test('substantive defect boards cannot opt out through absence rationale or release/status anchors', () => {
  const data = goodBoard();
  for (const anchor of [
    { path: '/release/risks/0', quote: data.release.risks[0] },
    { path: '/defects/0/status', quote: data.defects[0].status },
    { path: '/cases/0/requirement', quote: data.cases[0].requirement },
  ]) {
    const review = goodReview(data);
    review.criteria[0].rationale = 'Not applicable: no work needs review.';
    review.criteria[0].anchors = [anchor];
    assert.ok(validateReview(data, review).errors.some(error => error.code === 'ANCHOR_NOT_RELEVANT'));
  }
});


test('source mutations removing applicability or broadening it to defect boards are killed', async () => {
  const original = readFileSync(new URL('../scripts/teamwork/board-quality.mjs', import.meta.url), 'utf8');
  const loadMutant = async (before, after) => {
    let mutated = original.replace(before, after);
    assert.notEqual(mutated, original, 'mutation target must exist');
    for (const relative of ['../loop8/caption.mjs', './canonical.mjs', './page-exporter.mjs', './notion-sync.mjs', './native-renderer.mjs', './doc-colab-renderer.mjs']) {
      const absolute = pathToFileURL(fileURLToPath(new URL(`../scripts/teamwork/${relative}`, import.meta.url))).href;
      mutated = mutated.replaceAll(`'${relative}'`, `'${absolute}'`);
    }
    return import(`data:text/javascript,${encodeURIComponent(mutated)}#applicability-${encodeURIComponent(before)}`);
  };
  const draft = emptyDraft();
  const draftReview = noDefectReview(draft, true);
  assert.equal(validateReview(draft, draftReview).verdict, 'PASS');
  const disabled = await loadMutant('|| absenceAnchorIsRelevant(data, criterion, anchor, resolved.value)', '|| false');
  assert.notEqual(disabled.validateBoardReview({ data: draft, review: draftReview, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');

  const defectBoard = goodBoard();
  const badReview = goodReview(defectBoard);
  badReview.criteria[0].rationale = 'Not applicable: no defects.';
  badReview.criteria[0].anchors = [{ path: '/cases/0/requirement', quote: defectBoard.cases[0].requirement }];
  assert.notEqual(validateReview(defectBoard, badReview).verdict, 'PASS');
  const broadened = await loadMutant('if (!Array.isArray(data?.defects) || data.defects.length !== 0) return false;', 'if (false) return false;');
  assert.equal(broadened.validateBoardReview({ data: defectBoard, review: badReview, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS');
  assert.throws(() => assert.notEqual(broadened.validateBoardReview({ data: defectBoard, review: badReview, canonicalSha256: 'a'.repeat(64) }).verdict, 'PASS'), assert.AssertionError);
});
