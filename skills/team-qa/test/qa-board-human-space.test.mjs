import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectBoardDestination } from '../scripts/lib/board-destination.mjs';
import { selectRetestCases } from '../scripts/lib/retest-scope.mjs';
import { sealBoardDelivery } from './qa-board-teamwork/support/board-quality-fixture.mjs';

const available = { status: 'available', evidence: 'authenticated tool probe succeeded' };
const absent = { status: 'unavailable', evidence: 'tool absent from current runtime' };
test('Space wins; Notion and native are only absence fallbacks', () => {
  assert.equal(selectBoardDestination({ space: available, notion: available }), 'space');
  assert.equal(selectBoardDestination({ space: absent, notion: available }), 'notion');
  assert.equal(selectBoardDestination({ space: absent, notion: absent }), 'doc-colab');
});
test('uncertain availability and ungrounded absence cannot silently select another destination', () => {
  assert.throws(() => selectBoardDestination({ space: { status: 'unknown', evidence: 'timeout' }, notion: available }), /BOARD_DESTINATION_UNKNOWN/);
  assert.throws(() => selectBoardDestination({ space: { status: 'unavailable', evidence: ' ' }, notion: available }), /BOARD_DESTINATION_PROOF_MISSING/);
});
const tracked = { cases: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }] };
const change = { target_version: 'build-new', impact: 'bounded', defect_cases: ['B'], affected_cases: ['A'], smoke_cases: ['C'], rationale: 'Only form save changed; shared entry smoke retained.' };
test('targeted retest retains defect, impact and smoke in original case order without shrinking original plan', () => {
  const result = selectRetestCases(tracked, change);
  assert.equal(result.mode, 'targeted');
  assert.deepEqual(result.caseIds, ['A', 'B', 'C']);
  assert.deepEqual(result.notSelectedCaseIds, ['D']);
  assert.equal(result.result_scope, 'retest-only');
  assert.equal(tracked.cases.length, 4);
});
test('shared changes expand; unknown impact and full-release acceptance select the complete plan', () => {
  assert.equal(selectRetestCases(tracked, { ...change, impact: 'shared' }).mode, 'expanded');
  for (const impact of ['unknown', 'full-release']) {
    const result = selectRetestCases(tracked, { ...change, impact });
    assert.equal(result.mode, 'full');
    assert.deepEqual(result.caseIds, ['A', 'B', 'C', 'D']);
  }
});
test('retest refuses unknown case ids, missing impact/smoke/rationale and duplicate ids', () => {
  assert.throws(() => selectRetestCases(tracked, { ...change, defect_cases: ['X'] }), /RETEST_CASE_UNKNOWN/);
  assert.throws(() => selectRetestCases(tracked, { ...change, smoke_cases: [] }), /RETEST_SMOKE_REQUIRED/);
  assert.throws(() => selectRetestCases(tracked, { ...change, rationale: '' }), /RETEST_INPUT_INVALID/);
  assert.throws(() => selectRetestCases(tracked, { ...change, defect_cases: ['B', 'B'] }), /RETEST_CASE_DUPLICATE/);
  assert.throws(() => selectRetestCases(tracked, { ...change, impact: 'maybe' }), /RETEST_IMPACT_INVALID/);
  assert.throws(() => selectRetestCases(tracked, { ...change, impact: 'shared', affected_cases: [] }), /RETEST_SHARED_IMPACT_REQUIRED/);
});
test('recognized QA artifact cannot open without canonical verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-open-human-'));
  const html = join(dir, 'board.html');
  writeFileSync(html, '<script id="doc-data">window.DOC_DATA = {"qaBoard":{}};</script>');
  const result = spawnSync(process.execPath, [new URL('../scripts/teamqa.mjs', import.meta.url).pathname, 'board', 'open', '--file', html], { encoding: 'utf8', env: { ...process.env, TEAMQA_OPEN_CMD: JSON.stringify([process.execPath, '-e', 'process.exit(0)']) } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOARD_OPEN_CANONICAL_REQUIRED/);
});

test('Space verification refuses incomplete receipts even when the child reports ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-page-receipt-'));
  // Isolate readback from the separately tested review authenticator.
  const root = new URL('../', import.meta.url).pathname;
  const candidate = join(dir, 'candidate');
  cpSync(join(root, 'scripts'), join(candidate, 'scripts'), { recursive: true });
  cpSync(join(root, 'schemas'), join(candidate, 'schemas'), { recursive: true });
  cpSync(join(root, 'test/qa-board-teamwork/support/board-quality-fixture.mjs'), join(candidate, 'scripts/lib/board-quality.mjs'));
  const canonical = join(dir, 'canonical.json');
  const snapshot = join(dir, 'snapshot.json');
  const payload = join(dir, 'payload.json');
  const review = join(dir, 'review.fixture.json');
  const stub = join(dir, 'qa-tool.mjs');
  writeFileSync(canonical, '{}');
  writeFileSync(snapshot, '{}');
  writeFileSync(payload, '{}');
  writeFileSync(review, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: createHash('sha256').update('{}').digest('hex') }));
  sealBoardDelivery({ file: canonical, reviewPath: review, artifactPath: payload, renderer: 'space' });
  writeFileSync(stub, 'console.log(process.argv[2] === "validate" ? "{}" : process.env.TEST_PAGE_RECEIPT);');
  const receipt = { protocol: 'qa-gui/page-readback/v1', operation: 'compare-page', ok: true,
    matchPercent: 100, pageId: 'page_observed', url: 'https://chatgpt.com/space/page_observed',
    mismatches: [], seal: 'a'.repeat(64) };
  const run = (value) => spawnSync(process.execPath,
    [join(candidate, 'scripts/teamqa.mjs'), 'board', 'compare-page', '--file', canonical, '--snapshot', snapshot, '--payload', payload],
    { encoding: 'utf8', env: { ...process.env, TEAMQA_QA_GUI_BOARD_TOOL: stub, TEST_PAGE_RECEIPT: JSON.stringify(value) } });
  const positive = run(receipt);
  assert.equal(positive.status, 0, positive.stderr || positive.stdout);
  for (const change of [{ matchPercent: 0 }, { pageId: '' }, { url: '' }, { seal: '' },
    { mismatches: ['content'] }, { protocol: 'other' }, { operation: 'export-page' }]) {
    const result = run({ ...receipt, ...change });
    assert.notEqual(result.status, 0, JSON.stringify(change));
    assert.match(result.stderr, /BOARD_PAGE_READBACK_UNCONFIRMED/);
  }
});
