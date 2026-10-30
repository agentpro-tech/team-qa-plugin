import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { blockedDeliveryRecord, boardDeliverySummary, deliveryPath, recordBlockedBoardDelivery, verifyBlockedBoardDelivery, REVIEW_ROUNDS } from '../../scripts/lib/board-delivery.mjs';
import { rosterRunMode, runModeOf } from '../../scripts/lib/roster.mjs';
import { rosterChat } from '../../scripts/lib/chat-presentation.mjs';

// Upgrade U5: an unattended run whose board review stays FAIL records the blocked delivery instead of asking. The review
// receipts here are synthetic; their authentication (board-quality verifyBoardReviewEvidence) has its own suites, so the
// verifier is injected: it returns the receipt as written, as an authenticated receipt would be.
const SCROLL = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');
const NEEDS_SCROLL = !existsSync(join(SCROLL, 'lib', 'effects.js')) && 'SCROLL runtime unavailable (set TEAMQA_SCROLL_ROOT)';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const verifyReview = ({ file, receiptPath }) => { const r = JSON.parse(readFileSync(receiptPath, 'utf8')); assert.equal(r.canonical.path, realpathSync(file)); return r; };
const ROSTER = { run_id: 'hub-r1', round: 1, roster_hash: 'a'.repeat(64), run_mode: 'unattended' };
function fixture() {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-delivery-')));
  mkdirSync(join(runDir, 'reviews'), { recursive: true });
  const board = (n) => { const p = join(runDir, `qa-board.r${n}.json`); writeFileSync(p, JSON.stringify({ revision: n })); return p; };
  const review = (n, canonical, verdict = 'FAIL', errors = [`TC-0${n}: image caption does not match the step`]) => {
    const p = join(runDir, 'reviews', `r${n}.json`);
    writeFileSync(p, JSON.stringify({ schema: 'team-qa/board-quality-review/v1', canonical: { path: realpathSync(canonical), sha256: sha(canonical) }, verdict, validation: { verdict, errors } }));
    return p;
  };
  const boards = [1, 2, 3].map(board);
  return { runDir, boards, reviews: boards.map((b, i) => review(i + 1, b)), review };
}

test('run mode: unattended is written into the roster, shown before approval and fixed; interactive keeps 1.13.1 bytes', () => {
  assert.equal(runModeOf(undefined), 'interactive'); assert.equal(runModeOf(''), 'interactive'); assert.equal(runModeOf('unattended'), 'unattended');
  assert.throws(() => runModeOf('auto'), (e) => e.code === 'ROSTER_RUN_MODE');
  assert.equal(rosterRunMode({}), 'interactive'); assert.equal(rosterRunMode(ROSTER), 'unattended');
  const roster = { run_id: 'hub-r1', round: 1, scope: 'HUB', target: { project_id: 'hub', preview_url: 'http://127.0.0.1:5401/intro', version: 'v' }, roles: [] };
  assert.doesNotMatch(rosterChat(roster, 'b'.repeat(64)), /Run mode/);
  assert.match(rosterChat({ ...roster, run_mode: 'unattended' }, 'b'.repeat(64)), /Run mode: unattended/);
});

test('a blocked delivery needs an unattended run in EXECUTE and three authenticated reviews, none PASS, the last of the locked board', () => {
  const f = fixture(), board = f.boards[2];
  const record = blockedDeliveryRecord({ runDir: f.runDir, roster: ROSTER, phase: 'EXECUTE', boardPath: board, reviews: f.reviews, createdAt: '2026-10-29T05:00:00.000Z', verifyReview });
  assert.deepEqual(Object.keys(record), ['schema', 'run_id', 'round', 'roster_hash', 'run_mode', 'status', 'canonical', 'reviews', 'open', 'created_at']);
  assert.deepEqual([record.status, record.run_mode, record.reviews.length, record.canonical.path], ['blocked', 'unattended', REVIEW_ROUNDS, 'qa-board.r3.json']);
  assert.deepEqual(record.reviews.map((r) => [r.path, r.verdict]), [['reviews/r1.json', 'FAIL'], ['reviews/r2.json', 'FAIL'], ['reviews/r3.json', 'FAIL']]);
  assert.deepEqual(record.open, ['TC-03: image caption does not match the step']);
  assert.deepEqual(boardDeliverySummary(record), { status: 'blocked', review_rounds: 3, open: record.open });
  assert.equal(boardDeliverySummary(null), null);
  const refused = (o, code) => assert.throws(() => blockedDeliveryRecord({ runDir: f.runDir, roster: ROSTER, phase: 'EXECUTE', boardPath: board, reviews: f.reviews, createdAt: 'x', verifyReview, ...o }), (e) => e.code === code, code);
  refused({ roster: { ...ROSTER, run_mode: undefined } }, 'BOARD_DELIVERY_INTERACTIVE');
  refused({ phase: 'COMPLETE' }, 'RUN_PHASE_REQUIRED');
  refused({ reviews: f.reviews.slice(1) }, 'BOARD_DELIVERY_REVIEWS_REQUIRED');
  refused({ reviews: [f.reviews[0], f.reviews[0], f.reviews[2]] }, 'BOARD_DELIVERY_REVIEWS_REPEATED');
  refused({ reviews: [f.reviews[0], f.reviews[1], f.review(4, board, 'PASS', [])] }, 'BOARD_DELIVERY_REVIEW_PASSED');
  refused({ boardPath: f.boards[1] }, 'BOARD_DELIVERY_REVIEW_STALE');
  // UNGRADED reviews are evidence too.
  assert.equal(blockedDeliveryRecord({ runDir: f.runDir, roster: ROSTER, phase: 'EXECUTE', boardPath: board, createdAt: 'x', verifyReview,
    reviews: [f.reviews[0], f.reviews[1], f.review(5, board, 'UNGRADED', ['missing facts'])] }).open[0], 'missing facts');
});

test('the record is written once and verified again: changed bytes, a changed board or another run are refused', { skip: NEEDS_SCROLL }, async () => {
  const f = fixture(), board = f.boards[2];
  const record = await recordBlockedBoardDelivery({ runDir: f.runDir, roster: ROSTER, phase: 'EXECUTE', boardPath: board, reviews: f.reviews, verifyReview });
  assert.deepEqual(verifyBlockedBoardDelivery({ runDir: f.runDir, roster: ROSTER, boardPath: board, verifyReview }), record);
  await assert.rejects(recordBlockedBoardDelivery({ runDir: f.runDir, roster: ROSTER, phase: 'EXECUTE', boardPath: board, reviews: f.reviews, verifyReview }), (e) => e.code === 'BOARD_DELIVERY_EXISTS');
  assert.throws(() => verifyBlockedBoardDelivery({ runDir: f.runDir, roster: { ...ROSTER, roster_hash: 'c'.repeat(64) }, boardPath: board, verifyReview }), (e) => e.code === 'BOARD_DELIVERY_BINDING');
  const original = readFileSync(deliveryPath(f.runDir), 'utf8');
  writeFileSync(deliveryPath(f.runDir), original.replace('image caption does not match the step', 'no open points left'));
  assert.throws(() => verifyBlockedBoardDelivery({ runDir: f.runDir, roster: ROSTER, boardPath: board, verifyReview }), (e) => e.code === 'BOARD_DELIVERY_DRIFT');
  writeFileSync(deliveryPath(f.runDir), original);
  writeFileSync(board, JSON.stringify({ revision: 4 }));
  assert.throws(() => verifyBlockedBoardDelivery({ runDir: f.runDir, roster: ROSTER, boardPath: board, verifyReview }), (e) => ['BOARD_DELIVERY_REVIEW_STALE', 'BOARD_DELIVERY_DRIFT'].includes(e.code));
  assert.equal(verifyBlockedBoardDelivery({ runDir: realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-delivery-none-'))), roster: ROSTER, boardPath: board, verifyReview }), null);
});
