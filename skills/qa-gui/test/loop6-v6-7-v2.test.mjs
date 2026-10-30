import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V6.7 evaluates every frozen regression job with exact cloned reports', async () => {
  const product = await import('../scripts/loop6/index.mjs');

  assert.equal(
    typeof product.evaluateRegressionJob,
    'function',
    'scripts/loop6/index.mjs must export evaluateRegressionJob',
  );

  const corpusUrl = new URL('./loop6/corpus/v6.7-regression-job.json', import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const fixtures = [...corpus.hard, ...corpus.ordinary];

  assert.equal(fixtures.length, 28, 'revision-3 corpus must contain all 28 frozen pairs');

  for (const fixture of fixtures) {
    const first = await product.evaluateRegressionJob(fixture.job, fixture.runResult);
    const second = await product.evaluateRegressionJob(fixture.job, fixture.runResult);

    assert.deepEqual(first, fixture.expectedReport, `${fixture.id}: exact report`);
    assert.deepEqual(second, fixture.expectedReport, `${fixture.id}: deterministic report`);
    assert.notStrictEqual(second, first, `${fixture.id}: return a fresh report object`);

    if (first.groups?.length) {
      first.groups[0].name = 'mutated-by-caller';
      const third = await product.evaluateRegressionJob(fixture.job, fixture.runResult);
      assert.deepEqual(third, fixture.expectedReport, `${fixture.id}: deep-clone nested report data`);
    }
  }
});
