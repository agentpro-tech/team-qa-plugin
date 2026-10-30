import assert from 'node:assert/strict';
import test from 'node:test';

test('V6.1 exposes the frozen-corpus app-map builder', async () => {
  let product;

  try {
    product = await import('../scripts/loop6/app-map.mjs');
  } catch (error) {
    assert.fail(`V6.1 product module is missing: ${error.message}`);
  }

  assert.equal(
    typeof product.buildAppMap,
    'function',
    'scripts/loop6/app-map.mjs must export buildAppMap',
  );
});
