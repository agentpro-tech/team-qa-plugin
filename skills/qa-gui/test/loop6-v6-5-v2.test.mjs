import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V6.5 converts every revision-3 frozen BA document to an exact cloned plan', async () => {
  const product = await import('../scripts/loop6/index.mjs');

  assert.equal(
    typeof product.baToPlan,
    'function',
    'scripts/loop6/index.mjs must export baToPlan',
  );

  const corpusUrl = new URL('./loop6/corpus/v6.5-ba-plan.json', import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const fixtures = [...corpus.hard, ...corpus.ordinary];

  assert.equal(fixtures.length, 32, 'the frozen revision-3 corpus must contain 32 rows');

  for (const fixture of fixtures) {
    const expected = {
      cases: fixture.expectedCases,
      coverage: fixture.expectedCoverage,
    };

    const actual = await product.baToPlan(fixture.markdown);
    assert.deepEqual(actual, expected, `${fixture.id}: exact cases and coverage`);

    if (actual.cases.length > 0) {
      actual.cases[0].steps.push('test:mutation');
    } else {
      actual.coverage.reason = 'test:mutation';
    }

    const repeated = await product.baToPlan(fixture.markdown);
    assert.deepEqual(repeated, expected, `${fixture.id}: returned plan must be cloned`);
  }
});
