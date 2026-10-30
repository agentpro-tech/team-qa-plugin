import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V6.4 diagnoses the frozen remediation corpus without retrying real bugs', async () => {
  const product = await import('../scripts/loop6/index.mjs');

  assert.equal(
    typeof product.diagnoseFailure,
    'function',
    'scripts/loop6/index.mjs must export diagnoseFailure',
  );

  const corpusUrl = new URL('./loop6/corpus/v6.4-diagnosis.json', import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));

  for (const fixture of [...corpus.hard, ...corpus.ordinary]) {
    const actual = await product.diagnoseFailure(fixture.evidence);

    assert.equal(actual?.label, fixture.expectedLabel, `${fixture.id}: label`);
    assert.equal(actual?.action, fixture.expectedAction, `${fixture.id}: action`);
    assert.equal(typeof actual?.reason, 'string', `${fixture.id}: reason must be a string`);
    assert.ok(actual.reason.length > 0, `${fixture.id}: reason must not be empty`);
    assert.notEqual(actual?.evidence, undefined, `${fixture.id}: evidence must be defined`);
    assert.doesNotThrow(
      () => assert.notEqual(JSON.parse(JSON.stringify(actual.evidence)), undefined),
      `${fixture.id}: evidence must be JSON-compatible`,
    );
    if (fixture.mustNeverRetry || fixture.expectedLabel === 'real-bug') {
      assert.notEqual(actual.action, 'retry', `${fixture.id}: must never retry`);
    }
  }
});
