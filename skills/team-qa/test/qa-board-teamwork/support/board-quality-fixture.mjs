// Test-only adapter for Team QA CLI wiring. It does not authenticate reviews.
// Production review authenticity is exercised by board-quality's own tests.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const record = (operation, data = {}) => process.env.TEAMQA_TEST_CALL_LOG
  && appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, `${JSON.stringify({ tool: 'board-quality-fixture', operation, ...data })}\n`);

export function verifyBoardReview({ file, receiptPath }) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.fixture !== 'board-quality-cli-contract-test' || receipt.board_sha256 !== hash(readFileSync(file))) {
    throw Object.assign(new Error('BOARD_QUALITY_REVIEW_UNVERIFIED'), { code: 'BOARD_QUALITY_REVIEW_UNVERIFIED' });
  }
  record('verify-review', { file, receiptPath });
  return { fixture: true };
}

export function sealBoardDelivery({ file, reviewPath, artifactPath, renderer, projectionOptions = {} }) {
  verifyBoardReview({ file, receiptPath: reviewPath });
  const sidecar = { fixture: true, file_sha256: hash(readFileSync(file)), artifact_sha256: hash(readFileSync(artifactPath)), renderer,
    reviewPath, review_sha256: hash(readFileSync(reviewPath)), projectionOptions };
  writeFileSync(`${artifactPath}.quality.json`, JSON.stringify(sidecar));
  record('seal', { file, artifactPath, renderer });
  return sidecar;
}

export function verifyBoardDelivery({ file, artifactPath, renderer }) {
  const sidecarPath = `${artifactPath}.quality.json`;
  if (!existsSync(sidecarPath)) throw Object.assign(new Error('BOARD_QUALITY_DELIVERY_MISSING'), { code: 'BOARD_QUALITY_DELIVERY_MISSING' });
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  if (!sidecar.fixture || sidecar.renderer !== renderer || sidecar.file_sha256 !== hash(readFileSync(file))
    || sidecar.artifact_sha256 !== hash(readFileSync(artifactPath)) || sidecar.review_sha256 !== hash(readFileSync(sidecar.reviewPath))) {
    throw Object.assign(new Error('BOARD_QUALITY_DELIVERY_STALE'), { code: 'BOARD_QUALITY_DELIVERY_STALE' });
  }
  verifyBoardReview({ file, receiptPath: sidecar.reviewPath });
  record('verify-delivery', { file, artifactPath, renderer });
  return sidecar;
}
