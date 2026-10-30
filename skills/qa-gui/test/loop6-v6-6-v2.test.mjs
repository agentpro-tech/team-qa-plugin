import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as loop6 from '../scripts/loop6/index.mjs';

const corpus = JSON.parse(
  await readFile(new URL('./loop6/corpus/v6.6-intent-flow.json', import.meta.url), 'utf8'),
);

const cases = [...corpus.hard, ...corpus.ordinary];

function expectedOutput(fixture) {
  return {
    verdict: fixture.expectedVerdict,
    targets: fixture.expectedTargets,
    haltAtStep: fixture.haltAtStep ?? null,
    reason: fixture.reason,
    ungradedReason: fixture.ungradedReason ?? null,
  };
}

test('V6.6 replays all 32 frozen intent pairs exactly and returns fresh clones', () => {
  assert.equal(cases.length, 32, 'the refreeze-3 corpus must contain all 32 input pairs');
  assert.equal(typeof loop6.replayIntent, 'function', 'scripts/loop6/index.mjs must export replayIntent');

  for (const fixture of cases) {
    const first = loop6.replayIntent(fixture.savedSteps, fixture.redesignedControls);
    assert.deepEqual(first, expectedOutput(fixture), fixture.id);

    const snapshot = structuredClone(first);
    if (first.targets.length > 0) first.targets[0].targets.push('__mutation_probe__');

    const second = loop6.replayIntent(fixture.savedSteps, fixture.redesignedControls);
    assert.deepEqual(second, snapshot, `${fixture.id} must return an independent clone`);
    assert.notStrictEqual(second, first, `${fixture.id} must not reuse the result object`);
  }
});
