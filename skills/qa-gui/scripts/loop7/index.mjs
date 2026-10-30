/**
 * QA GUI Loop 7 product surface (mobile).
 *
 * Only the features that have actually been implemented are exported. The
 * remaining exports stay absent on purpose: an unimplemented feature must read
 * as a miss, never as a guessed answer.
 */
export { verifyMobileEmulation } from './mobile-emulation.mjs';
export { RESPONSIVE_MATRIX, responsiveMatrix } from './responsive-matrix.mjs';
export { detectHoverOnly } from './hover-only.mjs';
export { detectMobileRisks } from './mobile-risks.mjs';
export { evaluateKeyboardSimulation } from './keyboard-simulation.mjs';
