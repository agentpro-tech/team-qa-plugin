/**
 * QA GUI Loop 8 product surface (annotation board).
 *
 * Only the features that have actually been implemented are exported: an unimplemented feature must
 * read as a miss, never as a guessed answer.
 */
export { attachFindingBboxes, BBOX_REASONS } from './bbox.mjs';
export { renderAnnotations, renderAnnotatedPng } from './annotation-renderer.mjs';
export { validateFindingCaption, CAPTION_VERDICTS } from './caption.mjs';
