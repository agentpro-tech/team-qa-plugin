import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V6.8 plans deterministic EP/BVA probes for the frozen remediation corpus', async () => {
  const product = await import('../scripts/loop6/index.mjs');

  assert.equal(
    typeof product.planFormProbes,
    'function',
    'scripts/loop6/index.mjs must export planFormProbes',
  );

  const corpusUrl = new URL('./loop6/corpus/v6.8-form-probe.json', import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));

  for (const fixture of [...corpus.hard, ...corpus.ordinary]) {
    const first = await product.planFormProbes(fixture.fields);
    const second = await product.planFormProbes(fixture.fields);

    assert.deepEqual(second, first, `${fixture.id}: output must be deterministic`);
    assert.deepEqual(first?.probes, fixture.expectedProbes, `${fixture.id}: probes`);
    assert.deepEqual(
      first?.untested ?? [],
      fixture.expectedUntested ?? [],
      `${fixture.id}: untested`,
    );
  }
});
