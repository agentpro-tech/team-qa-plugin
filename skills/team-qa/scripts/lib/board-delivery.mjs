// Unattended board delivery (upgrade U5).
// The run mode is chosen when the roster is made (TEAMQA_RUN_MODE=unattended; interactive by default), shown on the
// roster the user approves and fixed for the run. In an unattended run, when the board review is still not PASS after
// the repair rounds board-review-workflow.md allows (three), the root does not stop to ask: it records the blocked
// delivery with `teamqa board deliver-blocked --run <id> --reviews <r1,r2,r3>`. The FAIL/UNGRADED review receipts stay
// as evidence (each one authenticated again here), the board is not delivered or published, the report lists the open
// review points, COMPLETE accepts the record in place of the published board, and the Team QA receipt says
// board_delivery: blocked. GO/NO_GO still comes only from the signed plan's exit criteria; case verdicts do not change.
// An interactive run keeps 1.13.1: the record is refused and the root asks the user.
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fail, readJson, rejectUnknownFields, sha256File, stableJson, writeConfirmed } from './core.mjs';
// A namespace import: package fixtures that swap board-quality.mjs for a CLI test adapter keep linking.
import * as boardQuality from './board-quality.mjs';

export const DELIVERY_SCHEMA = 'team-qa/board-delivery/v1';
export const REVIEW_ROUNDS = 3;
const requireValue = (value, code, detail = '') => { if (!value) fail(3, code, detail, 'ungraded'); };
export const deliveryPath = (runDir) => join(resolve(runDir), 'control', 'board-delivery.json');
const FIELDS = ['schema', 'run_id', 'round', 'roster_hash', 'run_mode', 'status', 'canonical', 'reviews', 'open', 'created_at'];

// The open review points of a receipt: the validation errors, as text, at most 50.
function openPoints(receipt) {
  return (Array.isArray(receipt.validation?.errors) ? receipt.validation.errors : [])
    .map((e) => (typeof e === 'string' ? e : stableJson(e).trim())).slice(0, 50);
}

// The reviews as the record holds them, each authenticated against the canonical revision it reviewed.
// Every review but the last is of a revision the repair rounds replaced: it is authenticated against the board bytes
// kept with it (historical); the last must be of the locked canonical board as it is now (checked by the caller).
function reviewsOf(runDir, paths, verifyReview) {
  return paths.map((p, index) => {
    const path = realpathSync(resolve(runDir, p));
    const receipt = readJson(path);
    const canonical = receipt?.canonical?.path;
    requireValue(typeof canonical === 'string' && existsSync(canonical), 'BOARD_DELIVERY_REVIEW_CANONICAL', p);
    const r = verifyReview({ file: canonical, receiptPath: path, historical: index < paths.length - 1 });
    return { path: relative(resolve(runDir), path), sha256: sha256File(path), verdict: r.verdict, canonical_sha256: r.canonical.sha256, receipt: r };
  });
}

// The record for this run: unattended, before COMPLETE, at least three distinct authenticated reviews of which none is
// PASS, the last one of the locked canonical board.
export function blockedDeliveryRecord({ runDir, roster, phase, boardPath, reviews, createdAt, verifyReview = (o) => boardQuality.verifyBoardReviewEvidence(o) }) {
  requireValue((roster.run_mode ?? 'interactive') === 'unattended', 'BOARD_DELIVERY_INTERACTIVE', 'an interactive run asks the user (1.13.1)');
  requireValue(phase === 'EXECUTE', 'RUN_PHASE_REQUIRED', 'EXECUTE');
  requireValue(Array.isArray(reviews) && reviews.length >= REVIEW_ROUNDS, 'BOARD_DELIVERY_REVIEWS_REQUIRED', `${REVIEW_ROUNDS} review receipts`);
  const checked = reviewsOf(runDir, reviews, verifyReview);
  requireValue(new Set(checked.map((r) => r.sha256)).size === checked.length, 'BOARD_DELIVERY_REVIEWS_REPEATED');
  const passed = checked.filter((r) => r.verdict === 'PASS');
  requireValue(!passed.length, 'BOARD_DELIVERY_REVIEW_PASSED', passed.map((r) => r.path).join(','));
  const board = realpathSync(boardPath), last = checked.at(-1);
  requireValue(last.receipt.canonical.path === board && last.canonical_sha256 === sha256File(board), 'BOARD_DELIVERY_REVIEW_STALE', 'the last review must be of the locked canonical board');
  return { schema: DELIVERY_SCHEMA, run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, run_mode: 'unattended', status: 'blocked',
    canonical: { path: relative(resolve(runDir), board), sha256: sha256File(board) },
    reviews: checked.map(({ receipt, ...row }) => row), open: openPoints(last.receipt), created_at: createdAt };
}

export async function recordBlockedBoardDelivery({ runDir, roster, phase, boardPath, reviews, verifyReview }) {
  requireValue(!existsSync(deliveryPath(runDir)), 'BOARD_DELIVERY_EXISTS', deliveryPath(runDir));
  const record = blockedDeliveryRecord({ runDir, roster, phase, boardPath, reviews, createdAt: new Date().toISOString(), verifyReview });
  await writeConfirmed(deliveryPath(runDir), stableJson(record), 'teamqa.board.delivery', { exclusive: true });
  return record;
}

// The run's blocked delivery, verified again (reviews authenticated, the canonical board unchanged), or null when the
// run has none. `boardPath` is the locked canonical board.
export function verifyBlockedBoardDelivery({ runDir, roster, boardPath, verifyReview }) {
  const path = deliveryPath(runDir);
  if (!existsSync(path)) return null;
  const record = readJson(path);
  rejectUnknownFields(record, FIELDS, 'BOARD_DELIVERY_FIELDS');
  requireValue(record.schema === DELIVERY_SCHEMA && record.status === 'blocked' && record.run_mode === 'unattended'
    && record.run_id === roster.run_id && record.round === roster.round && record.roster_hash === roster.roster_hash, 'BOARD_DELIVERY_BINDING');
  const again = blockedDeliveryRecord({ runDir, roster, phase: 'EXECUTE', boardPath, reviews: (record.reviews ?? []).map((r) => r.path), createdAt: record.created_at, verifyReview });
  requireValue(stableJson(again) === stableJson(record), 'BOARD_DELIVERY_DRIFT');
  return record;
}

// What the report and the receipt say about it.
export function boardDeliverySummary(record) {
  return record ? { status: 'blocked', review_rounds: record.reviews.length, open: record.open } : null;
}
