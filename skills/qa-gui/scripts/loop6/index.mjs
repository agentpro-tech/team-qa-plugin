/**
 * QA GUI Loop 6 product surface (see test/loop6/checker/CONTRACT.md).
 *
 * Only the features that have actually been implemented are exported. The
 * remaining exports stay absent on purpose: an unimplemented feature must read
 * as a miss, never as a guessed answer. `buildAppMapV2` (R1b) is an addition the
 * frozen checker does not read: it adds the frontier, the stop reason and the
 * state observations to the same log (references/coverage-cells.md).
 */
export { buildAppMap, buildAppMapV2 } from './app-map.mjs';
export { baToPlan } from './ba-plan.mjs';
export { diagnoseFailure } from './diagnose.mjs';
export { evaluateRegressionJob } from './regression-job.mjs';
export { planFormProbes } from './form-probes.mjs';
export { recallMemory } from './memory.mjs';
export { replayIntent } from './intent-replay.mjs';
export { generateProperties } from './properties.mjs';
