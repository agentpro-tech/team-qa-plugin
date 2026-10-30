import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V6.2 generates exact cloned properties for the revision-3 frozen corpus', async () => {
  const product = await import('../scripts/loop6/index.mjs');

  assert.equal(
    typeof product.generateProperties,
    'function',
    'scripts/loop6/index.mjs must export generateProperties',
  );

  const corpusUrl = new URL('./loop6/corpus/v6.2-properties.json', import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));

  for (const fixture of [...corpus.hard, ...corpus.ordinary]) {
    const appMapBefore = structuredClone(fixture.appMap);
    const requirementsBefore = structuredClone(fixture.baRequirements);
    const envPinBefore = structuredClone(fixture.envPin);
    const expected = {
      verdict: fixture.expectedVerdict,
      properties: fixture.expectedProperties,
      ungradedReason: fixture.ungradedReason,
    };

    const actual = await product.generateProperties(
      fixture.appMap,
      fixture.baRequirements,
      fixture.envPin,
    );

    assert.deepEqual(actual, expected, `${fixture.id}: exact output`);
    assert.deepEqual(fixture.appMap, appMapBefore, `${fixture.id}: appMap must not mutate`);
    assert.deepEqual(
      fixture.baRequirements,
      requirementsBefore,
      `${fixture.id}: baRequirements must not mutate`,
    );
    assert.deepEqual(fixture.envPin, envPinBefore, `${fixture.id}: envPin must not mutate`);

    if (actual.properties.length > 0) {
      actual.properties[0].sourceRef.appMapNodes.push('test:mutation');
      const repeated = await product.generateProperties(
        fixture.appMap,
        fixture.baRequirements,
        fixture.envPin,
      );
      assert.deepEqual(repeated, expected, `${fixture.id}: returned values must be cloned`);
    }
  }
});
